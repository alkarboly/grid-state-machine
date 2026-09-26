"""Sim agent. Each tick it reads the chart contract and writes unit_actions.

The remote model in docs/llm.md stays outside the tick. This agent is the
in-process stand-in: actor `sim`, the same kinds, applied on the next tick.
"""

from __future__ import annotations

from datetime import datetime

from gridsim.fleet.actions import OPEN, market_rate, new_action
from gridsim.fleet.charts import CHARTS
from gridsim.fleet.simulate import HOUR_MEAN_KW

# A manual trigger places the residual this many sigma past the center,
# which is outside the ±3 sigma limits.
ARM_Z = 4.0

# Dollars per MWh on the simulated curve (18 + 90 × demand percentile).
HIGH_RATE = 70.0
LOW_RATE = 40.0
HEAVY = 1.25
# Same demand bands as the fleet ladder. A ramp is the forecast sitting 8% above now.
PEAK_RANK = 0.75
TROUGH_RANK = 0.35
RAMP = 1.08


def forced_measurement(site: dict, chart_id: str, measured: float, expected: float, sigma: float | None) -> float:
    """When this chart is armed, report a point past the limits."""
    if chart_id not in (site.get("armed") or ()):
        return measured
    width = sigma
    if not width:
        spec = next(item for item in CHARTS if item["chart_id"] == chart_id)
        width = spec["sigma"] or 1.0
    return expected + ARM_Z * width


def typical_kw(load_scale: float) -> float:
    return (sum(HOUR_MEAN_KW) / len(HOUR_MEAN_KW)) * load_scale


def expected_kw(site: dict, hour: int, usage_rows: list[dict]) -> tuple[float, str]:
    """This hour's expected kilowatts, and whether it came from closed usage or the profile."""
    scale = float(site.get("load_scale") or 1.0)
    samples = [
        float(row["load_kwh"])
        for row in usage_rows
        if row.get("hour") == hour and row.get("load_kwh") is not None
    ]
    if samples:
        return sum(samples) / len(samples), "usage"
    return HOUR_MEAN_KW[hour] * scale, "profile"


def day_shape(points: list[dict] | None) -> dict | None:
    """Where the newest actual sits on the 24h demand trace the overlay draws."""
    actuals = [
        float(point["demand_mw"])
        for point in points or []
        if point.get("kind") == "actual" and point.get("demand_mw") is not None
    ]
    if not actuals:
        return None
    current = actuals[-1]
    rank = sum(value <= current for value in actuals) / len(actuals)
    forecast = [
        float(point["demand_mw"])
        for point in points or []
        if point.get("kind") == "forecast" and point.get("demand_mw") is not None
    ]
    forward = sum(forecast) / len(forecast) if forecast else current
    if rank >= PEAK_RANK:
        shape = "peak"
    elif rank <= TROUGH_RANK:
        shape = "trough"
    elif forward >= current * RAMP:
        shape = "ramp"
    else:
        shape = "mid"
    return {"demand_mw": round(current, 1), "rank": round(rank, 4), "shape": shape}


def _clause(line: str, threshold: str) -> dict:
    return {"line": line, "threshold": threshold}


def price_call(rate: float, expected: float, typical: float, shape: dict | None = None) -> tuple[str, list[dict]]:
    """The call, and each clause that fired. `threshold` is the limit to highlight."""
    quiet = expected <= typical
    peak = bool(shape and shape.get("shape") == "peak")
    trough = bool(shape and shape.get("shape") == "trough")
    ramp = bool(shape and shape.get("shape") == "ramp")
    rank = float(shape["rank"]) if shape and shape.get("rank") is not None else None
    heavy = expected >= typical * HEAVY
    fired: list[dict] = []
    if rate >= HIGH_RATE or heavy or peak:
        signal = "push"
        if rate >= HIGH_RATE:
            fired.append(_clause(
                f"price {rate:.0f} $/MWh ≥ {HIGH_RATE:.0f} $/MWh",
                f"{HIGH_RATE:.0f} $/MWh",
            ))
        if heavy:
            fired.append(_clause(
                f"expected {expected:.2f} kW ≥ {HEAVY:.2f}× typical {typical:.2f} kW",
                f"{HEAVY:.2f}×",
            ))
        if peak:
            place = f"rank {rank:.2f} " if rank is not None else ""
            fired.append(_clause(f"day peak, {place}≥ {PEAK_RANK:.2f}", f"{PEAK_RANK:.2f}"))
        return signal, fired
    if quiet and (rate <= LOW_RATE or trough or ramp):
        signal = "pull"
        if rate <= LOW_RATE:
            fired.append(_clause(
                f"price {rate:.0f} $/MWh ≤ {LOW_RATE:.0f} $/MWh",
                f"{LOW_RATE:.0f} $/MWh",
            ))
        fired.append(_clause(
            f"expected {expected:.2f} kW ≤ typical {typical:.2f} kW",
            f"typical {typical:.2f} kW",
        ))
        if trough:
            place = f"rank {rank:.2f} " if rank is not None else ""
            fired.append(_clause(f"day trough, {place}≤ {TROUGH_RANK:.2f}", f"{TROUGH_RANK:.2f}"))
        if ramp:
            fired.append(_clause(f"forecast mean ≥ {RAMP:.2f}× now", f"{RAMP:.2f}×"))
        return signal, fired
    fired.append(_clause(
        f"price {rate:.0f} $/MWh is between {LOW_RATE:.0f} and {HIGH_RATE:.0f} $/MWh",
        f"{LOW_RATE:.0f} and {HIGH_RATE:.0f}",
    ))
    if not heavy:
        fired.append(_clause(
            f"expected {expected:.2f} kW is below {HEAVY:.2f}× typical {typical:.2f} kW",
            f"{HEAVY:.2f}×",
        ))
    day = shape.get("shape") if shape else None
    if day in ("trough", "ramp") and not quiet:
        fired.append(_clause(
            f"expected {expected:.2f} kW is above typical {typical:.2f} kW, so a {day} does not pull",
            f"typical {typical:.2f} kW",
        ))
    elif day in (None, "mid"):
        fired.append(_clause("day is mid, not a peak, trough, or ramp", "peak, trough, or ramp"))
    return "hold", fired


def choose_unit_signal(rate: float, expected: float, typical: float, shape: dict | None = None) -> str:
    """Push into a high price, a heavy hour, or the peak of the day. Pull in a trough or ahead of a ramp."""
    signal, _because = price_call(rate, expected, typical, shape)
    return signal


def _open_code(actions: list[dict], site_id: str, chart_id: str, kind: str) -> bool:
    for action in actions:
        if action.get("site_id") != site_id or action.get("kind") != kind:
            continue
        if action.get("status") not in OPEN:
            continue
        if (action.get("payload") or {}).get("chart_id") == chart_id:
            return True
    return False


def _code_busy(actions: list[dict], site_id: str) -> bool:
    for action in actions:
        if action.get("site_id") != site_id or action.get("status") not in OPEN:
            continue
        if (action.get("payload") or {}).get("chart_id"):
            return True
    return False


def _price_signals(actions: list[dict], site_id: str) -> set[str]:
    found = set()
    for action in actions:
        if action.get("site_id") != site_id or action.get("kind") != "set_signal":
            continue
        if action.get("status") not in OPEN:
            continue
        payload = action.get("payload") or {}
        if payload.get("reason") == "price" and payload.get("signal"):
            found.add(payload["signal"])
    return found


def _price_note(because: list[dict], expected: float, source: str, shape: dict | None) -> str:
    note = "; ".join(item["line"] for item in because)
    note += f". Expected {expected:.2f} kW from {source}"
    shape_name = shape.get("shape") if shape else None
    if shape_name not in (None, "mid") and shape_name not in note:
        note += f", day {shape_name}"
    return note


def audit(
    sites: list[dict],
    actions: list[dict],
    grid: dict,
    usage_by_site: dict[str, list[dict]],
    now: datetime,
) -> list[dict]:
    """Pending rows for alarming codes, then a price signal on units set to dispatch."""
    rate, _basis = market_rate(grid)
    created: list[dict] = []
    pending = list(actions)
    for site in sites:
        charts = {chart["chart_id"]: chart for chart in site.get("charts") or []}
        for spec in CHARTS:
            chart = charts.get(spec["chart_id"])
            if not chart or not chart.get("alarm"):
                continue
            for step in spec["steps"]:
                kind = step["kind"]
                if _open_code(pending, site["id"], spec["chart_id"], kind):
                    continue
                payload = {"chart_id": spec["chart_id"]}
                if kind == "set_signal":
                    payload["signal"] = step["signal"]
                    payload["intensity"] = step.get("intensity", 0)
                zed = chart.get("z")
                limit = "±3σ"
                if zed is None:
                    because = [_clause(f"alarm beyond {limit}", limit)]
                    lead = f"Alarm beyond {limit}."
                else:
                    because = [_clause(f"z {zed} beyond {limit}", limit)]
                    lead = f"Alarm beyond {limit} (z {zed})."
                payload["because"] = because
                row = new_action(
                    site["id"],
                    kind,
                    now,
                    note=f"{lead} {spec['action']}",
                    payload=payload,
                    actor="sim",
                )
                created.append(row)
                pending.append(row)
        if _code_busy(pending, site["id"]) or not site.get("agent_dispatch"):
            site.pop("agent_call", None)
            continue
        expected, source = expected_kw(site, now.hour, usage_by_site.get(site["id"]) or [])
        shape = day_shape(grid.get("day"))
        typical = typical_kw(float(site.get("load_scale") or 1.0))
        signal, because = price_call(rate, expected, typical, shape)
        site["agent_call"] = {
            "signal": signal,
            "rate": rate,
            "expected_kw": round(expected, 2),
            "source": source,
            "day": shape["shape"] if shape else None,
            "because": because,
        }
        open_signals = _price_signals(pending, site["id"])
        if signal in open_signals:
            continue
        if signal == "hold" and not open_signals:
            continue
        level = 0.0 if signal == "hold" else 1.0
        row = new_action(
            site["id"],
            "set_signal",
            now,
            note=_price_note(because, expected, source, shape),
            payload={"signal": signal, "intensity": level, "reason": "price", "because": because},
            actor="sim",
        )
        created.append(row)
        pending.append(row)
    return created
