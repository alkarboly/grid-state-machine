"""In-memory fleet plus the ERCOT refresh loop."""

from __future__ import annotations

import json
import threading

from gridsim import config
from gridsim.db import connect, insert_grid, insert_raw, insert_tick, upsert_sites
from gridsim.ercot.client import fetch_dashboards, fetch_official
from gridsim.ercot.normalize import (
    constraints_from_rows,
    edges_from_constraints,
    grid_from_dashboards,
    prices_from_rows,
)
from gridsim.fleet.simulate import build_sites, tick_sites
from gridsim.timeutil import iso, now_central


def _neutral_grid() -> dict:
    return {
        "as_of": None,
        "demand_mw": None,
        "capacity_mw": None,
        "available_mw": None,
        "forecast_demand_mw": None,
        "demand_percentile": 0.5,
        "storage_gen_mw": 0.0,
        "wind_mw": None,
        "solar_mw": None,
        "gas_mw": None,
        "source": "unavailable",
        "prices": [],
    }


def load_station_geo() -> dict:
    payload = json.loads((config.DATA / "station_geo.json").read_text(encoding="utf-8"))
    return {item["station"].upper(): item for item in payload}


class Fleet:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._conn = None
        self.sites = build_sites()
        self.grid = _neutral_grid()
        self.constraints: list[dict] = []
        self.edges: list[dict] = []
        self.status = {
            "dashboard": "unavailable",
            "dashboard_error": None,
            "official_api": "disabled" if not config.official_api_configured() else "pending",
            "official_error": None,
            "bus_lmp_rows": 0,
            "fetched_at": None,
        }
        self._last_tick = now_central()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._conn = connect()
        upsert_sites(self._conn, self.sites)
        self.tick()
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="gridsim-tick", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.refresh()
                self.tick()
            except Exception as exc:  # keep the map up if a fetch fails
                with self._lock:
                    self.status["official_error"] = str(exc)
            self._stop.wait(config.TICK_SECONDS)

    def refresh(self) -> None:
        fetched_at = iso(now_central())
        dashboard = self.status["dashboard"]
        official = self.status["official_api"]
        dashboard_error = None
        official_error = None
        bus_lmp_rows = self.status.get("bus_lmp_rows", 0)
        grid = None
        constraints: list[dict] = []
        prices: list[dict] = []

        try:
            raw = fetch_dashboards()
            if self._conn:
                insert_raw(self._conn, "supply-demand", fetched_at, raw["supply_demand"])
                insert_raw(self._conn, "fuel-mix", fetched_at, raw["fuel_mix"])
            grid = grid_from_dashboards(raw["supply_demand"], raw["fuel_mix"])
            dashboard = "live"
        except Exception as exc:
            dashboard = "cached" if self.grid.get("source") == "ercot-dashboard" else "unavailable"
            dashboard_error = str(exc)

        if config.official_api_configured():
            try:
                official_raw = fetch_official()
                if self._conn:
                    insert_raw(self._conn, "np6-86-cd", fetched_at, official_raw["constraints"])
                    insert_raw(self._conn, "np6-788-cd", fetched_at, official_raw["settlement_lmps"])
                    insert_raw(self._conn, "np6-787-cd", fetched_at, official_raw["bus_lmps"])
                constraints = constraints_from_rows(official_raw["constraints"])
                settlement = prices_from_rows(official_raw["settlement_lmps"], "settlementPoint")
                prices = [
                    item
                    for item in settlement
                    if item["location"].startswith(("LZ_", "HB_"))
                ]
                bus_lmp_rows = len(prices_from_rows(official_raw["bus_lmps"], "electricalBus"))
                official = "live"
            except Exception as exc:
                official = "error"
                official_error = str(exc)
        else:
            official = "disabled"

        stored_grid = None
        with self._lock:
            if grid is not None:
                grid["prices"] = prices
                self.grid = grid
                stored_grid = {key: value for key, value in grid.items() if key != "prices"}
            elif prices:
                self.grid["prices"] = prices
            if constraints:
                self.constraints = constraints
            self.edges = edges_from_constraints(self.constraints, load_station_geo())
            self.status = {
                "dashboard": dashboard,
                "dashboard_error": dashboard_error,
                "official_api": official,
                "official_error": official_error,
                "bus_lmp_rows": bus_lmp_rows,
                "fetched_at": fetched_at,
            }
        if self._conn and stored_grid:
            insert_grid(self._conn, stored_grid)

    def tick(self) -> None:
        now = now_central()
        with self._lock:
            elapsed = (now - self._last_tick).total_seconds()
            elapsed = min(max(elapsed, 0.0), 30.0)
            dt_hours = elapsed * config.SIM_TIME_SCALE / 3600.0
            sites, logs, observations, points = tick_sites(self.sites, self.grid, now, dt_hours)
            self.sites = sites
            self._last_tick = now
        if self._conn and logs:
            insert_tick(self._conn, logs, observations, points)

    def scene(self) -> dict:
        with self._lock:
            sites = []
            for site in self.sites:
                metrics = site.get("metrics") or {}
                base = metrics.get("base") or {}
                panel = metrics.get("panel") or {}
                sites.append(
                    {
                        "id": site["id"],
                        "city": site["city"],
                        "label": site.get("label", "n"),
                        "load_zone": site["load_zone"],
                        "lat": site["lat"],
                        "lon": site["lon"],
                        "signal": site.get("signal", "hold"),
                        "alarm": site.get("alarm", False),
                        "soc_pct": base.get("soc_pct"),
                        "charge_kw": base.get("charge_kw"),
                        "discharge_kw": base.get("discharge_kw"),
                        "load_kw": panel.get("load_kw"),
                        "load_scale": site.get("load_scale"),
                        "temp_center_c": site.get("temp_center_c"),
                        "eta": site.get("eta"),
                        "metrics": metrics,
                        "charts": site.get("charts") or [],
                    }
                )
            return {
                "grid": {key: value for key, value in self.grid.items() if key != "prices"},
                "prices": self.grid.get("prices") or [],
                "constraints": self.constraints,
                "edges": self.edges,
                "sites": sites,
                "ercot": self.status,
            }


fleet = Fleet()
