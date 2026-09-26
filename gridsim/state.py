"""In-memory fleet plus the ERCOT refresh loop."""

from __future__ import annotations

import json
import threading

from gridsim import config
from gridsim.db import (
    connect,
    insert_dispatch,
    insert_grid,
    insert_raw,
    insert_rollup,
    insert_tick,
    upsert_sites,
)
from gridsim.sync import pull_order, push_tick
from gridsim.ercot.client import fetch_dashboards, fetch_official
from gridsim.ercot.normalize import (
    constraints_from_rows,
    edges_from_constraints,
    grid_from_dashboards,
    prices_from_rows,
)
from gridsim.fleet.simulate import (
    DEMO_FAULTS,
    build_sites,
    load_anchors,
    metro_summary,
    station_summary,
    tick_sites,
)
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


def persist_sample(sites: list[dict], size: int) -> set[str]:
    """The instrumented cohort: the demo faults plus an even spread of the rest."""
    chosen = {site["id"] for site in sites if site["id"] in DEMO_FAULTS}
    room = size - len(chosen)
    if room > 0 and len(sites) > room:
        step = len(sites) / room
        chosen.update(sites[int(index * step)]["id"] for index in range(room))
    elif room > 0:
        chosen.update(site["id"] for site in sites)
    return chosen


def rollup(sites: list[dict], stamp: str) -> dict:
    counts = {"push": 0, "pull": 0, "hold": 0}
    alarms = warnings = 0
    discharge = charge = load = stored = capacity = 0.0
    for site in sites:
        counts[site.get("state", "hold")] = counts.get(site.get("state", "hold"), 0) + 1
        base = (site.get("metrics") or {}).get("base") or {}
        care = (site.get("metrics") or {}).get("maintenance") or {}
        if care.get("alarm"):
            alarms += 1
        if care.get("warning"):
            warnings += 1
        discharge += base.get("discharge_kw") or 0.0
        charge += base.get("charge_kw") or 0.0
        load += ((site.get("metrics") or {}).get("panel") or {}).get("load_kw") or 0.0
        stored += base.get("soc_kwh") or 0.0
        capacity += base.get("capacity_kwh") or 0.0
    return {
        "ts": stamp,
        "units": len(sites),
        "pushing": counts["push"],
        "pulling": counts["pull"],
        "holding": counts["hold"],
        "alarms": alarms,
        "warnings": warnings,
        "discharge_kw": round(discharge, 2),
        "charge_kw": round(charge, 2),
        "load_kw": round(load, 2),
        "stored_kwh": round(stored, 2),
        "capacity_kwh": round(capacity, 2),
        "mean_soc_pct": round(100.0 * stored / capacity, 2) if capacity else 0.0,
    }


def _newer(remote: dict, pending: dict | None) -> bool:
    if pending is None:
        return True
    return (remote.get("ts") or "") >= (pending.get("ts") or "")


def _snapshot(grid: dict, fleet: dict, applied: dict, frequency_hz: float) -> dict:
    """One row per tick. This is the object a controller reads."""
    return {
        "ts": fleet["ts"],
        "demand_mw": grid.get("demand_mw"),
        "demand_percentile": grid.get("demand_percentile"),
        "storage_gen_mw": grid.get("storage_gen_mw"),
        "frequency_hz": frequency_hz,
        "signal": applied["signal"],
        "intensity": applied["intensity"],
        "source": applied["source"],
        "zones_json": json.dumps(applied.get("zones") or {}, sort_keys=True),
        "pushing": fleet["pushing"],
        "pulling": fleet["pulling"],
        "holding": fleet["holding"],
        "discharge_kw": fleet["discharge_kw"],
        "charge_kw": fleet["charge_kw"],
        "load_kw": fleet["load_kw"],
        "mean_soc_pct": fleet["mean_soc_pct"],
        "stored_kwh": fleet["stored_kwh"],
        "alarms": fleet["alarms"],
    }


class Fleet:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._conn = None
        self.anchors = load_anchors()
        self.sites = build_sites(self.anchors)
        self.metros = metro_summary(self.anchors, self.sites)
        self.stations = station_summary(self.sites)
        self.persist = persist_sample(self.sites, config.PERSIST_SAMPLE)
        self.fleet = rollup([], iso(now_central()))
        self.grid = _neutral_grid()
        self._pending: dict | None = None
        self.applied = {"signal": "hold", "intensity": 0.0, "source": "rules", "zones": {}}
        self.snapshot: dict | None = None
        self.supabase = "disabled"
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

    def set_order(self, signal: str, intensity: float | None) -> None:
        """The call applied on the next tick. `auto` hands the decision back to the ladder."""
        with self._lock:
            if signal == "auto":
                self._pending = None
                return
            self._pending = {
                "signal": signal,
                "intensity": intensity,
                "source": "external",
                "ts": iso(now_central()),
            }

    def dispatch_view(self) -> dict:
        with self._lock:
            return {
                "applied": self.applied,
                "pending": self._pending,
                "snapshot": self.snapshot,
                "supabase": self.supabase,
            }

    def tick(self) -> None:
        remote, remote_error = pull_order()
        now = now_central()
        note: dict = {}
        row = None
        with self._lock:
            if remote is not None and _newer(remote, self._pending):
                self._pending = None if remote["signal"] == "auto" else remote
            order = None if self._pending is None else dict(self._pending)
            elapsed = (now - self._last_tick).total_seconds()
            elapsed = min(max(elapsed, 0.0), 30.0)
            dt_hours = elapsed * config.SIM_TIME_SCALE / 3600.0
            sites, logs, observations, points = tick_sites(
                self.sites,
                self.grid,
                now,
                dt_hours,
                persist=self.persist,
                order=order,
                note=note,
            )
            self.sites = sites
            self.fleet = rollup(sites, iso(now))
            self.applied = {
                "signal": note["signal"],
                "intensity": note["intensity"],
                "source": note["source"],
                "zones": note["zones"],
            }
            row = _snapshot(self.grid, self.fleet, self.applied, note["frequency_hz"])
            self.snapshot = row
            self._last_tick = now
        publish_error = None
        if self._conn and row:
            if logs:
                insert_tick(self._conn, logs, observations, points)
            insert_rollup(self._conn, self.fleet)
            insert_dispatch(self._conn, row)
        if row:
            publish_error = push_tick(row)
        with self._lock:
            if not config.supabase_configured():
                self.supabase = "disabled"
            elif remote_error or publish_error:
                self.supabase = "error"
            else:
                self.supabase = "live"

    def scene(self) -> dict:
        """Map payload. One row per battery, small enough to poll at fleet scale."""
        with self._lock:
            sites = []
            for site in self.sites:
                metrics = site.get("metrics") or {}
                base = metrics.get("base") or {}
                care = metrics.get("maintenance") or {}
                flagged = care.get("alarming") or []
                row = {
                    "id": site["id"],
                    "metro": site["metro"],
                    "station": site.get("station", ""),
                    "lat": site["lat"],
                    "lon": site["lon"],
                    "state": site.get("state", "hold"),
                    "soc_pct": base.get("soc_pct"),
                    "alarm": bool(flagged),
                }
                if flagged:
                    charts = {chart["chart_id"]: chart for chart in site.get("charts") or []}
                    row["families"] = sorted(
                        {charts[chart_id]["family"] for chart_id in flagged if chart_id in charts}
                    )
                    row["flagged"] = flagged
                sites.append(row)
            return {
                "grid": {key: value for key, value in self.grid.items() if key != "prices"},
                "prices": self.grid.get("prices") or [],
                "constraints": self.constraints,
                "edges": self.edges,
                "metros": self.metros,
                "stations": self.stations,
                "fleet": self.fleet,
                "dispatch": {
                    "signal": self.applied["signal"],
                    "intensity": self.applied["intensity"],
                    "source": self.applied["source"],
                },
                "sites": sites,
                "ercot": self.status,
            }

    def site_detail(self, site_id: str) -> dict | None:
        """Everything behind one battery, including the chart history."""
        with self._lock:
            site = next((item for item in self.sites if item["id"] == site_id), None)
            if site is None:
                return None
            history = site.get("chart_history") or {}
            charts = []
            for chart in site.get("charts") or []:
                point = dict(chart)
                point["series"] = list(history.get(chart["chart_id"]) or [])
                charts.append(point)
            return {
                "id": site["id"],
                "city": site["city"],
                "metro": site["metro"],
                "load_zone": site["load_zone"],
                "station": site.get("station", ""),
                "station_name": site.get("station_name", ""),
                "lat": site["lat"],
                "lon": site["lon"],
                "state": site.get("state", "hold"),
                "alarm": site.get("alarm", False),
                "load_scale": site.get("load_scale"),
                "temp_center_c": site.get("temp_center_c"),
                "voltage_center_v": site.get("voltage_center_v"),
                "eta": site.get("eta"),
                "instrumented": site["id"] in self.persist,
                "metrics": site.get("metrics") or {},
                "charts": charts,
            }


fleet = Fleet()
