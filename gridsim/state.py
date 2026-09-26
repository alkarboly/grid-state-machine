"""In-memory fleet plus the ERCOT refresh loop."""

from __future__ import annotations

import json
import threading
from datetime import timedelta

from gridsim import config
from gridsim.db import (
    connect,
    insert_dispatch,
    insert_grid,
    insert_market,
    insert_raw,
    recent_supply,
    insert_rollup,
    insert_tick,
    insert_usage,
    load_actions,
    load_addon_map,
    replace_addons,
    upsert_actions,
    upsert_latest,
    upsert_sites,
)
from gridsim.fleet.actions import (
    CASE_ACTORS,
    OPEN,
    apply_actions,
    catalog_rows,
    market_rate,
    merge_actions,
    new_action,
)
from gridsim.llm import propose
from gridsim.sync import (
    pull_actions,
    pull_addons,
    pull_order,
    push_actions,
    push_addons,
    push_latest,
    push_market,
    push_tick,
    push_usage,
)
from gridsim.ercot.client import fetch_dashboards, fetch_official
from gridsim.ercot.normalize import (
    constraints_from_rows,
    day_points,
    edges_from_constraints,
    grid_from_dashboards,
    price_day,
    prices_from_rows,
)
from gridsim.fleet.agent import audit, day_shape, record_toggle
from gridsim.fleet.charts import CHARTS, series_seconds, trace_values
from gridsim.fleet.simulate import (
    build_sites,
    load_anchors,
    metro_summary,
    machine_snapshot,
    seed_history,
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
    """An even spread of homes that write a full row every tick."""
    if size <= 0 or not sites:
        return set()
    if len(sites) <= size:
        return {site["id"] for site in sites}
    step = len(sites) / size
    return {sites[int(index * step)]["id"] for index in range(size)}


def _addon_kw(metrics: dict, addon_id: str) -> float:
    disco = metrics.get("disco") or {}
    return sum(item.get("kw") or 0.0 for item in disco.get("addons") or [] if item.get("addon_id") == addon_id)


def rollup(sites: list[dict], stamp: str) -> dict:
    """Sum every unit. Counts add to the fleet. Power adds to the grid interchange."""
    counts = {"push": 0, "pull": 0, "hold": 0}
    alarms = warnings = offline = 0
    discharge = charge = load = stored = capacity = 0.0
    grid_in = grid_out = solar = ev = solar_charge = 0.0
    for site in sites:
        counts[site.get("state", "hold")] = counts.get(site.get("state", "hold"), 0) + 1
        metrics = site.get("metrics") or {}
        base = metrics.get("base") or {}
        care = metrics.get("maintenance") or {}
        grid = metrics.get("grid") or {}
        if care.get("alarm"):
            alarms += 1
        if care.get("warning"):
            warnings += 1
        if base.get("availability") == "offline":
            offline += 1
        discharge += base.get("discharge_kw") or 0.0
        charge += base.get("charge_kw") or 0.0
        solar_charge += base.get("solar_charge_kw") or 0.0
        load += (metrics.get("panel") or {}).get("load_kw") or 0.0
        stored += base.get("soc_kwh") or 0.0
        capacity += base.get("capacity_kwh") or 0.0
        grid_in += grid.get("in_kw") or 0.0
        grid_out += grid.get("out_kw") or 0.0
        solar += _addon_kw(metrics, "solar")
        ev += _addon_kw(metrics, "ev_charger")
    return {
        "ts": stamp,
        "units": len(sites),
        "pushing": counts["push"],
        "pulling": counts["pull"],
        "holding": counts["hold"],
        "offline": offline,
        "alarms": alarms,
        "warnings": warnings,
        "discharge_kw": round(discharge, 2),
        "charge_kw": round(charge, 2),
        "solar_charge_kw": round(solar_charge, 2),
        "load_kw": round(load, 2),
        "solar_kw": round(solar, 2),
        "ev_kw": round(ev, 2),
        "grid_in_kw": round(grid_in, 2),
        "grid_out_kw": round(grid_out, 2),
        "stored_kwh": round(stored, 2),
        "capacity_kwh": round(capacity, 2),
        "mean_soc_pct": round(100.0 * stored / capacity, 2) if capacity else 0.0,
    }


def _newer(remote: dict, pending: dict | None) -> bool:
    if pending is None:
        return True
    return (remote.get("ts") or "") >= (pending.get("ts") or "")


def _market(grid: dict, fleet: dict, applied: dict, frequency_hz: float, sites: list[dict]) -> dict:
    rate, basis = market_rate(grid)
    return {
        "ts": fleet["ts"],
        "demand_mw": grid.get("demand_mw"),
        "demand_percentile": grid.get("demand_percentile"),
        "storage_gen_mw": grid.get("storage_gen_mw"),
        "rate_usd_mwh": rate,
        "rate_basis": basis,
        "frequency_hz": frequency_hz,
        "signal": applied["signal"],
        "intensity": applied["intensity"],
        "source": applied["source"],
        "mean_soc_pct": fleet["mean_soc_pct"],
        "offline": sum(1 for site in sites if site.get("offline")),
        "units": fleet["units"],
    }


def _latest(site: dict, ts: str) -> dict:
    metrics = site.get("metrics") or {}
    base = metrics.get("base") or {}
    panel = metrics.get("panel") or {}
    disco = metrics.get("disco") or {}
    return {
        "site_id": site["id"],
        "ts": ts,
        "soc_kwh": base.get("soc_kwh") or 0.0,
        "soc_pct": base.get("soc_pct") or 0.0,
        "availability": base.get("availability") or "online",
        "signal": site.get("signal") or "hold",
        "charge_kw": base.get("charge_kw") or 0.0,
        "discharge_kw": base.get("discharge_kw") or 0.0,
        "load_kw": panel.get("load_kw") or 0.0,
        "temp_c": base.get("temp_c") or 0.0,
        "addons": disco.get("addons") or [],
    }


def _action_stamp(action: dict) -> tuple:
    """What a stored ticket must rewrite when the maintenance state machine moves."""
    payload = action.get("payload") or {}
    if not isinstance(payload, dict):
        payload = {}
    steps = payload.get("escalation") or []
    return (
        action.get("status"),
        action.get("ends_at"),
        action.get("note") or "",
        action.get("actor"),
        payload.get("stage"),
        tuple((item.get("stage"), item.get("result")) for item in steps if isinstance(item, dict)),
    )


def _maintenance_row(action: dict) -> bool:
    if action.get("kind") in ("scheduled_service", "return_online"):
        return True
    payload = action.get("payload") or {}
    return isinstance(payload, dict) and bool(payload.get("chart_id"))


def _scene_actions(actions: list[dict]) -> list[dict]:
    """Recent rows for the side panel. Service tickets stay visible beside newer calls."""
    rows = [row for row in actions if row.get("actor") in CASE_ACTORS]
    care = [row for row in rows if _maintenance_row(row)]
    care_ids = {row.get("id") for row in care}
    rest = [row for row in rows if row.get("id") not in care_ids]
    care.sort(key=lambda row: row.get("ts") or "", reverse=True)
    rest.sort(key=lambda row: row.get("ts") or "", reverse=True)
    return (care[:24] + rest[:16])[:40]


def _site_actions(actions: list[dict], site_id: str) -> list[dict]:
    """Ticket history for one home, plus its other recent actions."""
    rows = [row for row in actions if row.get("site_id") == site_id]
    tickets = [row for row in rows if _maintenance_row(row)]
    ticket_ids = {row.get("id") for row in tickets}
    others = [row for row in rows if row.get("id") not in ticket_ids]
    return tickets[-12:] + others[-12:]


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
        self.applied = {"signal": "hold", "intensity": 0.0, "source": "rules", "zones": {}, "because": []}
        self.calls: list[dict] = []
        self.snapshot: dict | None = None
        self.market: dict | None = None
        self.actions: list[dict] = []
        self.usage: dict[str, list[dict]] = {}
        self._llm_at = None
        self.llm = "disabled"
        self.supabase = "disabled"
        self.constraints: list[dict] = []
        self.edges: list[dict] = []
        self.day: list[dict] = []
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
        self.actions = load_actions(self._conn)
        installed = load_addon_map(self._conn)
        for site in self.sites:
            if site["id"] in installed:
                site["addons"] = installed[site["id"]]
        seed_history(self.sites, now_central())
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
        supply = None

        try:
            raw = fetch_dashboards()
            supply = raw["supply_demand"]
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

        extra = []
        if self._conn and supply is not None:
            moment = now_central()
            midnight = moment.replace(hour=0, minute=0, second=0, microsecond=0)
            extra = recent_supply(self._conn, [iso(moment - timedelta(minutes=30)), iso(midnight)])
        stored_grid = None
        with self._lock:
            if grid is not None:
                grid["prices"] = prices
                if supply is not None:
                    self.day = price_day(day_points(supply, self.day, extra), market_rate(grid))
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

    def add_action(self, site_id: str, kind: str, note: str, payload: dict | None, actor: str) -> dict:
        now = now_central()
        with self._lock:
            if not any(site["id"] == site_id for site in self.sites):
                raise KeyError(site_id)
            action = new_action(site_id, kind, now, note=note, payload=payload, actor=actor)
            self.actions.append(action)
        return action

    def arm(
        self,
        site_id: str,
        chart_id: str | None,
        armed: bool | None,
        dispatch: bool | None,
        grid: bool | None = None,
    ) -> dict:
        """Arm a chart, turn on price dispatch, or open and close the service contactor."""
        known = [spec["chart_id"] for spec in CHARTS]
        dirty: list[dict] = []
        with self._lock:
            site = next((item for item in self.sites if item["id"] == site_id), None)
            if site is None:
                raise KeyError(site_id)
            if chart_id is not None:
                if armed is None:
                    raise ValueError("armed is required with chart_id")
                if chart_id != "all" and chart_id not in known:
                    raise ValueError("unknown chart_id")
                before = [item for item in (site.get("armed") or []) if item in known]
                if chart_id == "all":
                    site["armed"] = list(known) if armed else []
                elif armed and chart_id not in before:
                    site["armed"] = [*before, chart_id]
                elif not armed:
                    site["armed"] = [item for item in before if item != chart_id]
                else:
                    site["armed"] = before
                after = list(site.get("armed") or [])
                changed = [code for code in known if (code in after) != (code in before)]
                now = now_central()
                for code in changed:
                    for row in record_toggle(site, self.actions, code, code in after, now):
                        if not any(item.get("id") == row.get("id") for item in self.actions):
                            self.actions.append(row)
                        dirty.append(row)
                if dirty and self._conn:
                    upsert_actions(self._conn, dirty)
            if dispatch is not None:
                site["agent_dispatch"] = bool(dispatch)
            if grid is not None:
                site["grid_off"] = not grid
            view = {
                "site_id": site_id,
                "armed": list(site.get("armed") or []),
                "dispatch": bool(site.get("agent_dispatch")),
                "grid": "off" if site.get("grid_off") else "on",
            }
        if dirty:
            push_actions(dirty)
        return view

    def agent_view(self) -> dict:
        with self._lock:
            rows = []
            for site in self.sites:
                armed = list(site.get("armed") or [])
                dispatch = bool(site.get("agent_dispatch"))
                grid_off = bool(site.get("grid_off"))
                if armed or dispatch or grid_off:
                    rows.append({
                        "site_id": site["id"],
                        "armed": armed,
                        "dispatch": dispatch,
                        "grid": "off" if grid_off else "on",
                    })
            return {"sites": rows}

    def tick(self) -> None:
        remote, remote_error = pull_order()
        remote_actions, action_error = pull_actions()
        remote_addons, addon_error = pull_addons()
        with self._lock:
            due = self._llm_due()
            context = self._llm_context() if due else None
        llm_rows, llm_error = propose(context) if context else ([], None)
        now = now_central()
        note: dict = {}
        row = None
        market = None
        latest: list[dict] = []
        usage_rows: list[dict] = []
        dirty_actions: list[dict] = []
        addon_sites: list[dict] = []
        with self._lock:
            if due:
                self._llm_at = now
            if remote is not None and _newer(remote, self._pending):
                self._pending = None if remote["signal"] == "auto" else remote
            order = None if self._pending is None else dict(self._pending)
            self.actions = merge_actions(self.actions, remote_actions)
            for item in llm_rows:
                if not isinstance(item, dict):
                    continue
                try:
                    self.actions.append(
                        new_action(
                            str(item.get("site_id") or ""),
                            str(item.get("kind") or ""),
                            now,
                            note=str(item.get("note") or ""),
                            payload=item.get("payload") if isinstance(item.get("payload"), dict) else {},
                            actor="llm",
                        )
                    )
                except (ValueError, TypeError):
                    continue
            if remote_addons is not None:
                for site in self.sites:
                    site["addons"] = list(remote_addons.get(site["id"], []))
            before_addons = {site["id"]: tuple(site.get("addons") or []) for site in self.sites}
            before_stamp = {action["id"]: _action_stamp(action) for action in self.actions}
            created = apply_actions(self.sites, self.actions, now)
            self.actions.extend(created)
            self._trim_actions()
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
                "because": note.get("because") or [],
            }
            self._remember_call(now)
            row = _snapshot(self.grid, self.fleet, self.applied, note["frequency_hz"])
            self.snapshot = row
            self._last_tick = now
            self._keep_usage(note.get("usage") or [])
            grid = dict(self.grid)
            grid["day"] = self.day
            fresh = audit(self.sites, self.actions, grid, self.usage, now)
            if fresh:
                self.actions.extend(fresh)
                self._trim_actions()
            market = _market(self.grid, self.fleet, self.applied, note["frequency_hz"], sites)
            self.market = market
            publish = self._publish_sites()
            latest = [_latest(site, iso(now)) for site in publish]
            publish_ids = {site["id"] for site in publish}
            usage_rows = [item for item in note.get("usage") or [] if item["site_id"] in publish_ids]
            dirty_actions = [
                action for action in self.actions if before_stamp.get(action["id"]) != _action_stamp(action)
            ]
            addon_sites = [
                site for site in sites if tuple(site.get("addons") or []) != before_addons.get(site["id"], ())
            ]
        publish_error = None
        if self._conn and row and market:
            if logs:
                insert_tick(self._conn, logs, observations, points)
            insert_rollup(self._conn, self.fleet)
            insert_dispatch(self._conn, row)
            insert_market(self._conn, market)
            upsert_latest(self._conn, latest)
            insert_usage(self._conn, usage_rows)
            upsert_actions(self._conn, dirty_actions)
            for site in addon_sites:
                replace_addons(self._conn, site["id"], list(site.get("addons") or []), iso(now))
        if row and market:
            errors = [
                push_tick(row),
                push_market(market),
                push_latest(latest),
                push_usage(usage_rows),
                push_actions(dirty_actions),
            ]
            for site in addon_sites:
                errors.append(push_addons(site["id"], list(site.get("addons") or []), iso(now)))
            publish_error = next((item for item in errors if item), None)
        with self._lock:
            if not config.supabase_configured():
                self.supabase = "disabled"
            elif remote_error or action_error or addon_error or publish_error:
                self.supabase = "error"
            else:
                self.supabase = "live"
            if not config.LLM_URL:
                self.llm = "disabled"
            elif llm_error:
                self.llm = "error"
            elif due:
                self.llm = "live"

    def _llm_due(self) -> bool:
        if not config.LLM_URL or self.market is None:
            return False
        if self._llm_at is None:
            return True
        return (now_central() - self._llm_at).total_seconds() >= config.LLM_EVERY_S

    def _llm_context(self) -> dict:
        units = [_latest(site, self.fleet.get("ts") or "") for site in self._publish_sites()[:24]]
        wanted = {row["site_id"] for row in units}
        usage = []
        for site_id in wanted:
            usage.extend(self.usage.get(site_id, [])[-6:])
        return {"market": self.market, "units": units, "usage": usage, "day": list(self.day)}

    def _publish_sites(self) -> list[dict]:
        """Instrumented homes, plus any home an action or add-on has touched."""
        touched = {action["site_id"] for action in self.actions}
        ranked = []
        for site in self.sites:
            if site["id"] in self.persist or site.get("offline") or site.get("addons") or site["id"] in touched:
                ranked.append((0 if site.get("offline") else 1, site["id"], site))
        ranked.sort(key=lambda item: (item[0], item[1]))
        return [site for _, _, site in ranked[:80]]

    def _keep_usage(self, rows: list[dict]) -> None:
        for row in rows:
            bucket = self.usage.setdefault(row["site_id"], [])
            bucket.append(row)
            del bucket[:-48]

    def _trim_actions(self) -> None:
        open_rows = [action for action in self.actions if action.get("status") in OPEN]
        closed = [action for action in self.actions if action.get("status") not in OPEN]
        self.actions = closed[-160:] + open_rows

    def _remember_call(self, now) -> None:
        """Keep a fleet decision when the call or the clause that fired changes."""
        because = self.applied.get("because") or []
        signature = (self.applied.get("signal"), self.applied.get("source"), tuple(item.get("line") for item in because))
        if self.calls and self.calls[-1].get("signature") == signature:
            return
        self.calls.append(
            {
                "ts": iso(now),
                "who": self.applied.get("source") or "rules",
                "signal": self.applied.get("signal") or "hold",
                "because": because,
                "signature": signature,
            }
        )
        del self.calls[:-24]

    def scene(self) -> dict:
        """Map payload. One row per battery, small enough to poll at fleet scale."""
        with self._lock:
            sites = []
            for site in self.sites:
                metrics = site.get("metrics") or {}
                base = metrics.get("base") or {}
                care = metrics.get("maintenance") or {}
                grid = metrics.get("grid") or {}
                flagged = care.get("alarming") or []
                row = {
                    "id": site["id"],
                    "metro": site["metro"],
                    "station": site.get("station", ""),
                    "lat": site["lat"],
                    "lon": site["lon"],
                    "state": site.get("state", "hold"),
                    "signal": site.get("signal", grid.get("signal", "hold")),
                    "source": grid.get("source", "rules"),
                    "soc_pct": base.get("soc_pct"),
                    "alarm": bool(flagged),
                    "offline": bool(site.get("offline")),
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
                    "because": self.applied.get("because") or [],
                },
                "calls": [
                    {key: value for key, value in row.items() if key != "signature"}
                    for row in reversed(self.calls[-12:])
                ],
                "market": self.market,
                "actions": _scene_actions(self.actions),
                "addons": catalog_rows(),
                "codes": [
                    {
                        "chart_id": spec["chart_id"],
                        "family": spec["family"],
                        "title": spec["title"],
                        "action": spec["action"],
                    }
                    for spec in CHARTS
                ],
                "sites": sites,
                "ercot": self.status,
                "day": list(self.day),
                "shape": day_shape(self.day),
                "tick_seconds": config.TICK_SECONDS,
            }

    def site_detail(self, site_id: str) -> dict | None:
        """Everything behind one battery, including the chart history."""
        with self._lock:
            site = next((item for item in self.sites if item["id"] == site_id), None)
            if site is None:
                return None
            traces = site.get("chart_trace") or {}
            charts = []
            for chart in site.get("charts") or []:
                point = dict(chart)
                point["series"] = trace_values(traces.get(chart["chart_id"]))
                point["series_seconds"] = series_seconds(chart["chart_id"])
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
                "usage": list(self.usage.get(site_id, [])[-24:]),
                "state_log": [dict(row) for row in reversed(site.get("state_log") or [])],
                "snapshot": machine_snapshot(site),
                "actions": _site_actions(self.actions, site_id),
                "armed": list(site.get("armed") or []),
                "dispatch": bool(site.get("agent_dispatch")),
                "agent_call": site.get("agent_call"),
            }


fleet = Fleet()
