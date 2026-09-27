"""Turn ERCOT payloads into the grid snapshot, constraints, and prices."""

from __future__ import annotations

from datetime import timedelta

from gridsim.fleet.actions import simulated_rate
from gridsim.timeutil import iso, parse_ercot_ts

# The overlay and the fleet manager share this window: trailing actuals, then the
# short forecast. The dashboard's forecast array runs for days; we keep six hours.
HISTORY = timedelta(hours=24)
FORECAST = timedelta(hours=6)


def _key(name: str) -> str:
    return "".join(ch for ch in name.lower() if ch.isalnum())


def _row(raw: dict) -> dict:
    return {_key(str(key)): value for key, value in raw.items()}


def _num(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def latest_fuel_row(payload: dict) -> tuple[str, dict]:
    best_at = None
    best_row = {}
    best_stamp = ""
    for day in payload.get("data", {}).values():
        if not isinstance(day, dict):
            continue
        for stamp, row in day.items():
            parsed = parse_ercot_ts(stamp)
            if best_at is None or parsed > best_at:
                best_at = parsed
                best_row = row
                best_stamp = stamp
    return best_stamp, best_row


def _gen(row: dict, fuel: str) -> float | None:
    cell = row.get(fuel)
    if isinstance(cell, dict):
        return _num(cell.get("gen"))
    return _num(cell)


def grid_from_dashboards(supply: dict, fuel: dict) -> dict:
    rows = supply.get("data") or []
    actuals = [row for row in rows if int(row.get("forecast", 1)) == 0]
    pool = actuals or list(rows)
    if not pool:
        raise ValueError("supply-demand payload has no rows")

    current = max(pool, key=lambda row: parse_ercot_ts(row["timestamp"]))
    demand = float(current["demand"])
    demands = [float(row["demand"]) for row in pool]
    percentile = sum(value <= demand for value in demands) / len(demands)

    forecast_mw = None
    current_at = parse_ercot_ts(current["timestamp"])
    upcoming = []
    for row in supply.get("forecast") or []:
        if "forecastedDemand" not in row or "timestamp" not in row:
            continue
        if parse_ercot_ts(row["timestamp"]) > current_at:
            upcoming.append(row)
    if upcoming:
        nxt = min(upcoming, key=lambda row: parse_ercot_ts(row["timestamp"]))
        forecast_mw = float(nxt["forecastedDemand"])

    _stamp, fuels = latest_fuel_row(fuel)
    return {
        "as_of": iso(current_at),
        "demand_mw": demand,
        "capacity_mw": _num(current.get("capacity")),
        "available_mw": _num(current.get("available")),
        "forecast_demand_mw": forecast_mw,
        "demand_percentile": percentile,
        "storage_gen_mw": _gen(fuels, "Power Storage"),
        "wind_mw": _gen(fuels, "Wind"),
        "solar_mw": _gen(fuels, "Solar"),
        "gas_mw": _gen(fuels, "Natural Gas"),
        "source": "ercot-dashboard",
    }


def constraints_from_rows(rows: list[dict]) -> list[dict]:
    parsed = []
    for raw in rows:
        row = _row(raw)
        stamp = row.get("scedtimestamp") or row.get("scedtime")
        if not stamp:
            continue
        parsed.append(
            {
                "sced_ts": _text(stamp),
                "constraint_name": _text(row.get("constraintname")),
                "contingency_name": _text(row.get("contingencyname")),
                "shadow_price": _num(row.get("shadowprice")),
                "max_shadow_price": _num(row.get("maxshadowprice")),
                "limit_mw": _num(row.get("limit")),
                "value_mw": _num(row.get("value")),
                "violated_mw": _num(row.get("violatedmw")),
                "from_station": _text(row.get("fromstation")).upper(),
                "to_station": _text(row.get("tostation")).upper(),
                "from_kv": _num(row.get("fromstationkv")),
                "to_kv": _num(row.get("tostationkv")),
            }
        )
    if not parsed:
        return []
    latest = max(item["sced_ts"] for item in parsed)
    return [item for item in parsed if item["sced_ts"] == latest]


def prices_from_rows(rows: list[dict], location_field: str) -> list[dict]:
    parsed = []
    field = _key(location_field)
    for raw in rows:
        row = _row(raw)
        stamp = row.get("scedtimestamp") or row.get("scedtime")
        location = _text(row.get(field) or row.get("location"))
        lmp = _num(row.get("lmp"))
        if not stamp or not location or lmp is None:
            continue
        parsed.append(
            {
                "sced_ts": _text(stamp),
                "location": location,
                "location_type": location_field,
                "lmp": lmp,
            }
        )
    if not parsed:
        return []
    latest = max(item["sced_ts"] for item in parsed)
    dedup = {}
    for item in parsed:
        if item["sced_ts"] == latest:
            dedup[item["location"]] = item
    return list(dedup.values())


def edges_from_constraints(constraints: list[dict], geo_by_station: dict) -> list[dict]:
    edges = []
    seen = set()
    for item in constraints:
        start = item.get("from_station") or ""
        end = item.get("to_station") or ""
        if not start or not end or start not in geo_by_station or end not in geo_by_station:
            continue
        key = tuple(sorted((start, end)))
        if key in seen:
            continue
        seen.add(key)
        left = geo_by_station[start]
        right = geo_by_station[end]
        edges.append(
            {
                "from_station": start,
                "to_station": end,
                "from_lat": left["lat"],
                "from_lon": left["lon"],
                "to_lat": right["lat"],
                "to_lon": right["lon"],
                "shadow_price": item.get("shadow_price"),
                "constraint_name": item.get("constraint_name"),
            }
        )
    return edges


def _quarter(moment):
    return moment.replace(minute=(moment.minute // 15) * 15, second=0, microsecond=0)


def _demand_rows(supply: dict) -> tuple[list[tuple], list[tuple]]:
    """Actuals and the forward forecast from one supply-demand payload."""
    actuals = []
    forecast = {}
    for row in supply.get("data") or []:
        if "demand" not in row or "timestamp" not in row:
            continue
        try:
            moment = parse_ercot_ts(row["timestamp"])
            demand = float(row["demand"])
        except (TypeError, ValueError):
            continue
        if int(row.get("forecast", 1)) == 0:
            actuals.append((moment, demand))
        else:
            forecast[moment] = demand
    for row in supply.get("forecast") or []:
        if "forecastedDemand" not in row or "timestamp" not in row:
            continue
        try:
            moment = parse_ercot_ts(row["timestamp"])
            demand = float(row["forecastedDemand"])
        except (TypeError, ValueError):
            continue
        forecast[moment] = demand
    return actuals, list(forecast.items())


def day_points(supply: dict, previous: list[dict] | None = None, extra: list[dict] | None = None) -> list[dict]:
    """Trailing 24 hours of demand plus the next 6 hours of forecast.

    Actuals are bucketed to 15 minutes. The newest sample in a bucket wins.
    `extra` payloads are older copies of the same feed, so a cold start still
    has the day those responses already published. Forecast comes from `supply`.
    Points are `{ts, demand_mw, kind}` with `kind` of `actual` or `forecast`.
    """
    actuals = []
    for source in extra or []:
        found, _forecast = _demand_rows(source)
        actuals.extend(found)
    live, forecast = _demand_rows(supply)
    actuals.extend(live)
    kept: dict = {}
    for point in previous or []:
        if point.get("kind") != "actual" or not point.get("ts") or point.get("demand_mw") is None:
            continue
        try:
            moment = parse_ercot_ts(point["ts"])
        except (TypeError, ValueError):
            continue
        kept[_quarter(moment)] = (moment, float(point["demand_mw"]))
    for moment, demand in actuals:
        bucket = _quarter(moment)
        current = kept.get(bucket)
        if current is None or moment >= current[0]:
            kept[bucket] = (moment, demand)
    if not kept:
        return []
    latest = max(item[0] for item in kept.values())
    start = latest - HISTORY
    end = latest + FORECAST
    rows = [
        {"ts": iso(moment), "demand_mw": round(demand, 1), "kind": "actual"}
        for moment, demand in kept.values()
        if start <= moment <= latest
    ]
    forward_kept: dict = {}
    for moment, demand in forecast:
        if moment <= latest or moment > end:
            continue
        bucket = _quarter(moment)
        current = forward_kept.get(bucket)
        if current is None or moment >= current[0]:
            forward_kept[bucket] = (moment, demand)
    forward = [
        {"ts": iso(moment), "demand_mw": round(demand, 1), "kind": "forecast"}
        for moment, demand in sorted(forward_kept.values(), key=lambda item: item[0])
    ]
    rows.sort(key=lambda point: point["ts"])
    return rows + forward


def price_day(points: list[dict], live_rate: tuple[float, str] | None = None) -> list[dict]:
    """Attach the simulated demand curve. The newest actual uses the live market rate."""
    pool = [float(point["demand_mw"]) for point in points if point.get("kind") == "actual"]
    priced = []
    last_actual = None
    for point in points:
        if pool:
            share = sum(value <= float(point["demand_mw"]) for value in pool) / len(pool)
        else:
            share = 0.5
        row = {
            "ts": point["ts"],
            "demand_mw": point["demand_mw"],
            "kind": point["kind"],
            "rate_usd_mwh": simulated_rate(share),
            "rate_basis": "simulated",
        }
        priced.append(row)
        if row["kind"] == "actual":
            last_actual = row
    if live_rate and last_actual is not None:
        last_actual["rate_usd_mwh"] = live_rate[0]
        last_actual["rate_basis"] = live_rate[1]
    return priced


def pin_demand(grid: dict, day: list[dict], pin: str) -> tuple[dict, list[dict], str | None]:
    """Use one actual on today's curve as the live demand. The series is unchanged.

    `peak` is the highest actual in the window. `live` is the newest actual.
    The returned timestamp is where the 24h card draws now.
    """
    actuals = [
        point
        for point in day
        if point.get("kind") == "actual" and point.get("demand_mw") is not None
    ]
    mode = "peak" if pin == "peak" else "live"
    if not actuals:
        out = dict(grid)
        out["demand_pin"] = mode
        return out, list(day), None
    ordered = sorted(actuals, key=lambda point: point.get("ts") or "")
    if mode != "peak":
        out = dict(grid)
        out["demand_pin"] = "live"
        return out, list(day), ordered[-1].get("ts")
    chosen = max(actuals, key=lambda point: (float(point["demand_mw"]), point.get("ts") or ""))
    demand = float(chosen["demand_mw"])
    pool = [float(point["demand_mw"]) for point in actuals]
    percentile = sum(value <= demand for value in pool) / len(pool)
    out = dict(grid)
    out["demand_mw"] = demand
    out["demand_percentile"] = round(percentile, 4)
    out["demand_pin"] = "peak"
    if chosen.get("ts"):
        out["as_of"] = chosen["ts"]
    return out, list(day), chosen.get("ts")
