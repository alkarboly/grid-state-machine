"""Turn ERCOT payloads into the grid snapshot, constraints, and prices."""

from __future__ import annotations

from gridsim.timeutil import iso, parse_ercot_ts


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
