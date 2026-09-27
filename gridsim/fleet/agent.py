"""Two in-tick managers. Each writes unit_actions; the next tick applies them.

The maintenance manager answers an alarming chart. The fleet manager posts
the price call on a home set to dispatch. An open code response outranks
that call. The remote model in docs/llm.md stays outside the tick.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from gridsim.fleet.actions import OPEN, market_rate, new_action, service_due, service_wait_minutes
from gridsim.llm import decide_maintenance, site_evidence
from gridsim.timeutil import iso
from gridsim.fleet.charts import CHARTS, mean_sigma, subgroup_size
from gridsim.fleet.simulate import HOUR_MEAN_KW, panel_kw

# A manual trigger places the subgroup mean this many chart-sigmas past the center,
# which is outside the ±3 σ/√n limits of a completed bucket.
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
    # +4 subgroup-sigmas sits outside the ±3 σ/√n limits of a completed bucket.
    width = mean_sigma(width, subgroup_size(chart_id))
    return expected + ARM_Z * width


def typical_kw(load_scale: float, hour_kw: list[float] | None = None) -> float:
    """This owner's average hour. `hour_kw` already includes load_scale."""
    if hour_kw:
        return sum(float(value) for value in hour_kw) / len(hour_kw)
    return (sum(HOUR_MEAN_KW) / len(HOUR_MEAN_KW)) * load_scale


def expected_kw(site: dict, hour: int, usage_rows: list[dict]) -> tuple[float, str]:
    """This hour's expected kilowatts, and whether it came from closed usage or the owner's day."""
    samples = [
        float(row["load_kwh"])
        for row in usage_rows
        if row.get("hour") == hour and row.get("load_kwh") is not None
    ]
    if samples:
        return sum(samples) / len(samples), "usage"
    return panel_kw(site, hour), "profile"


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
                f"expected {expected:.2f} kW ≥ {HEAVY:.2f}× owner average {typical:.2f} kW",
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
            f"expected {expected:.2f} kW ≤ owner average {typical:.2f} kW",
            f"owner average {typical:.2f} kW",
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
            f"expected {expected:.2f} kW is below {HEAVY:.2f}× owner average {typical:.2f} kW",
            f"{HEAVY:.2f}×",
        ))
    day = shape.get("shape") if shape else None
    if day in ("trough", "ramp") and not quiet:
        fired.append(_clause(
            f"expected {expected:.2f} kW is above owner average {typical:.2f} kW, so a {day} does not pull",
            f"owner average {typical:.2f} kW",
        ))
    elif day in (None, "mid"):
        fired.append(_clause("day is mid, not a peak, trough, or ramp", "peak, trough, or ramp"))
    return "hold", fired


def choose_unit_signal(rate: float, expected: float, typical: float, shape: dict | None = None) -> str:
    """Push into a high price, a heavy hour, or the peak of the day. Pull in a trough or ahead of a ramp."""
    signal, _because = price_call(rate, expected, typical, shape)
    return signal


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


# Simulated maintenance. Minutes are assumptions, not a crew schedule.
# 15 seconds keeps reset flows visible in a short demo.
# A field ticket waits a normal draw around 2 hours (see service_wait_minutes).
RESET_MIN = 0.25
# A reset is a short outage. `clears` means that reboot is assumed to fix it.
# Otherwise the same ticket escalates and the agent writes the visit.
RESOLUTION = {
    "disco_meter_delta": {"reset_min": RESET_MIN, "clears": True},
    "disco_voltage": {"reset_min": RESET_MIN, "clears": True},
    "soc_tracking": {"reset_min": RESET_MIN, "clears": False},
    "dispatch_response": {"reset_min": RESET_MIN, "clears": False},
    "base_temp": {"reset_min": None, "clears": False},
}


def _ticket_wait(site_id: str, chart_id: str, now: datetime) -> int:
    return service_wait_minutes(f"{site_id}:{chart_id}:{iso(now)}")


def _open_ticket(actions: list[dict], site_id: str, chart_id: str) -> dict | None:
    for action in actions:
        if action.get("site_id") != site_id or action.get("kind") != "scheduled_service":
            continue
        if action.get("status") not in OPEN:
            continue
        if (action.get("payload") or {}).get("chart_id") == chart_id:
            return action
    return None


def _gathered(site: dict, chart: dict) -> dict:
    metrics = site.get("metrics") or {}
    base = metrics.get("base") or {}
    panel = metrics.get("panel") or {}
    return {
        "z": chart.get("z"),
        "measured": chart.get("measured"),
        "expected": chart.get("expected"),
        "soc_pct": base.get("soc_pct"),
        "temp_c": base.get("temp_c"),
        "load_kw": panel.get("load_kw"),
    }


def _estimate_label(minutes: float | None) -> str:
    if minutes is None:
        return ""
    if minutes < 1:
        return f"{round(minutes * 60)}s"
    if minutes < 60:
        if float(minutes).is_integer():
            return f"{int(minutes)}m"
        return f"{minutes:g}m"
    hours = float(minutes) / 60.0
    if abs(hours - round(hours)) < 1e-9:
        return f"{int(round(hours))}h"
    return f"{hours:.1f}h"


def _agent_note(site: dict, chart_id: str, gathered: dict, reset_min: float | None) -> str:
    return _ticket_note(site, chart_id, gathered, reset_min)


def _ticket_note(site: dict, chart_id: str, gathered: dict, reset_min: float | None) -> str:
    bits = [f"{site['id']} {chart_id}"]
    if gathered.get("z") is not None:
        bits.append(f"z {gathered['z']}")
    if gathered.get("measured") is not None:
        bits.append(f"measured {gathered['measured']}")
    if gathered.get("soc_pct") is not None:
        bits.append(f"soc {gathered['soc_pct']}%")
    if gathered.get("temp_c") is not None:
        bits.append(f"temp {gathered['temp_c']} °C")
    if gathered.get("load_kw") is not None:
        bits.append(f"load {gathered['load_kw']} kW")
    if reset_min:
        bits.append(f"reset {_estimate_label(reset_min)} did not clear")
    else:
        bits.append("reset skipped")
    return ". ".join(bits) + "."


def _return_online(
    site_id: str,
    now: datetime,
    actor: str,
    service_id: str,
    note: str = "Back online after system reset",
) -> dict:
    return {
        "id": uuid.uuid4().hex,
        "ts": iso(now),
        "site_id": site_id,
        "kind": "return_online",
        "status": "done",
        "starts_at": iso(now),
        "ends_at": iso(now),
        "note": note,
        "payload": {"service_id": service_id},
        "actor": actor,
    }


def maintenance_manager(sites: list[dict], actions: list[dict], now: datetime) -> list[dict]:
    """One ticket per alarming code. Reset first when that fault allows it.

    A warning posts nothing. Frequency posts nothing. A failed reset escalates
    the same row: the agent writes the visit from the readings on the home.
    """
    created: list[dict] = []
    pending = list(actions)
    for site in sites:
        charts = {chart["chart_id"]: chart for chart in site.get("charts") or []}
        for spec in CHARTS:
            policy = RESOLUTION.get(spec["chart_id"])
            chart = charts.get(spec["chart_id"])
            if not policy or not chart or not chart.get("alarm"):
                continue
            ticket = _open_ticket(pending, site["id"], spec["chart_id"])
            if ticket is None:
                created.append(_open_case(site, spec, chart, policy, now, pending))
                continue
            payload = ticket.setdefault("payload", {})
            if payload.get("stage") != "reset":
                continue
            end = datetime.fromisoformat(ticket["ends_at"])
            if now < end:
                continue
            if policy["clears"]:
                _clear_reset(site, ticket, now, created)
            else:
                _escalate(site, ticket, chart, spec, policy, now)
    return created


def _open_case(site, spec, chart, policy, now, pending) -> dict:
    gathered = _gathered(site, chart)
    because = [_clause(f"z {chart.get('z')} beyond ±3σ", "±3σ")]
    if policy["reset_min"]:
        payload = {
            "chart_id": spec["chart_id"],
            "stage": "reset",
            "estimate_min": policy["reset_min"],
            "because": because,
            "gathered": gathered,
            "escalation": [_step("reset", policy["reset_min"], "trying", "maintenance", now)],
        }
        row = new_action(
            site["id"],
            "scheduled_service",
            now,
            note=f"System reset for {spec['chart_id']}. Estimate {_estimate_label(policy['reset_min'])}.",
            payload=payload,
            actor="maintenance",
            ends_at=now + timedelta(minutes=policy["reset_min"]),
        )
    else:
        wait = _ticket_wait(site["id"], spec["chart_id"], now)
        payload = _ticket_payload(spec, gathered, because, None, now, wait)
        row = new_action(
            site["id"],
            "scheduled_service",
            now,
            note=_agent_note(site, spec["chart_id"], gathered, None),
            payload=payload,
            actor="llm",
            ends_at=now + timedelta(minutes=wait),
        )
    site["offline"] = True
    pending.append(row)
    return row


def _step(stage: str, estimate_min, result: str, actor: str, now: datetime) -> dict:
    return {
        "stage": stage,
        "estimate_min": estimate_min,
        "result": result,
        "actor": actor,
        "ts": iso(now),
    }


def _append_step(ticket: dict, stage: str, estimate_min, result: str, actor: str, now: datetime) -> None:
    """Add one escalation step. Earlier steps stay on the ticket."""
    payload = ticket.setdefault("payload", {})
    steps = payload.get("escalation")
    if not isinstance(steps, list):
        steps = []
        payload["escalation"] = steps
    steps.append(_step(stage, estimate_min, result, actor, now))


def _ticket_payload(spec, gathered, because, reset_min, now: datetime, wait: int) -> dict:
    result = "reset skipped" if not reset_min else f"reset {_estimate_label(reset_min)} did not clear"
    steps = []
    if reset_min:
        steps.append(_step("reset", reset_min, "did not clear", "maintenance", now))
    steps.append(_step("ticket", wait, result, "llm", now))
    return {
        "chart_id": spec["chart_id"],
        "stage": "ticket",
        "estimate_min": wait,
        "because": because,
        "gathered": gathered,
        "escalation": steps,
    }


def _clear_reset(site, ticket, now, created) -> None:
    chart_id = ticket["payload"]["chart_id"]
    site["armed"] = [item for item in (site.get("armed") or []) if item != chart_id]
    site["offline"] = False
    ticket["status"] = "done"
    ticket["note"] = f"System reset cleared {chart_id}."
    steps = ticket["payload"].get("escalation") or []
    if not steps or steps[-1].get("result") != "cleared":
        _append_step(
            ticket,
            "reset",
            ticket["payload"].get("estimate_min"),
            "cleared",
            ticket.get("actor") or "maintenance",
            now,
        )
    created.append(_return_online(site["id"], now, ticket.get("actor") or "maintenance", ticket["id"]))


def _escalate(site, ticket, chart, spec, policy, now) -> None:
    reset_min = policy["reset_min"]
    gathered = _gathered(site, chart)
    wait = _ticket_wait(site["id"], spec["chart_id"], now)
    payload = ticket.setdefault("payload", {})
    payload["chart_id"] = spec["chart_id"]
    payload["stage"] = "ticket"
    payload["estimate_min"] = wait
    payload["gathered"] = gathered
    payload["because"] = payload.get("because") or []
    if reset_min:
        _append_step(ticket, "reset", reset_min, "did not clear", "maintenance", now)
    result = "reset skipped" if not reset_min else f"reset {_estimate_label(reset_min)} did not clear"
    _append_step(ticket, "ticket", wait, result, "llm", now)
    ticket["actor"] = "llm"
    ticket["status"] = "active"
    ticket["ends_at"] = iso(now + timedelta(minutes=wait))
    ticket["note"] = _agent_note(site, spec["chart_id"], gathered, reset_min)
    site["offline"] = True


def open_model_tickets(actions: list[dict], now: datetime | None = None) -> list[dict]:
    """Escalated visits whose service window has ended, waiting on a summary.

    The visit stays active through ends_at. The pull runs on a later tick.
    """
    stamp = iso(now) if now is not None else ""
    found = []
    for action in actions:
        if action.get("kind") != "scheduled_service" or action.get("actor") != "llm":
            continue
        if action.get("status") not in OPEN:
            continue
        payload = action.get("payload") or {}
        if not isinstance(payload, dict):
            continue
        if payload.get("stage") != "ticket" or payload.get("decision") or not payload.get("chart_id"):
            continue
        if now is not None and not service_due(action.get("ends_at"), now):
            continue
        steps = payload.get("escalation") or []
        opened = steps[-1].get("ts") if steps and isinstance(steps[-1], dict) else ""
        if stamp and opened == stamp:
            continue
        found.append(action)
    return found


def close_model_ticket(site: dict, ticket: dict, detail: dict, now: datetime) -> dict | None:
    """Close one visit from a GET /api/site/{id} body.

    When OPENAI_API_KEY is set, OPENAI_MODEL summarizes the ticket into
    decision.action. A missing key or a failed call keeps the chart sentence.
    The close itself is this function: done, disarm, return_online.
    """
    if detail.get("id") != site.get("id") or detail.get("id") != ticket.get("site_id"):
        return None
    payload = ticket.setdefault("payload", {})
    chart_id = payload.get("chart_id")
    if not chart_id or payload.get("decision"):
        return None
    evidence = site_evidence(detail, chart_id)
    if not evidence or not evidence.get("action"):
        return None
    payload["pull"] = {
        "method": "GET",
        "path": f"/api/site/{site['id']}",
        "evidence": evidence,
    }
    payload["evidence"] = evidence
    payload["gathered"] = {
        key: evidence.get(key)
        for key in ("z", "measured", "expected", "soc_pct", "temp_c", "load_kw")
    }
    written = decide_maintenance(payload["pull"])
    payload["decision"] = written or {"result": "done", "action": evidence["action"]}
    _append_step(ticket, "ticket", payload.get("estimate_min"), "done", "llm", now)
    ticket["status"] = "done"
    ticket["actor"] = "llm"
    ticket["note"] = payload["decision"]["action"]
    site["armed"] = [item for item in (site.get("armed") or []) if item != chart_id]
    site["offline"] = False
    return _return_online(
        site["id"],
        now,
        "llm",
        ticket["id"],
        note="Back online after the ticket summary",
    )


def record_toggle(site: dict, actions: list[dict], chart_id: str, armed: bool, now: datetime) -> list[dict]:
    """Update this chart's ticket when a simulation toggle is triggered or cleared.

    A trigger opens the ticket when none is open, and records that step first.
    A clear closes the open ticket. Either way the earlier escalation steps stay.
    Frequency has no ticket. Returns the rows that need storing.
    """
    policy = RESOLUTION.get(chart_id)
    if not policy:
        return []
    ticket = _open_ticket(actions, site["id"], chart_id)
    if armed:
        if ticket is not None:
            payload = ticket.setdefault("payload", {})
            estimate = payload.get("estimate_min") or 0
            _append_step(ticket, payload.get("stage") or "reset", estimate, "triggered", "api", now)
            end = datetime.fromisoformat(ticket["ends_at"]) if ticket.get("ends_at") else now
            if estimate and end <= now:
                ticket["ends_at"] = iso(now + timedelta(minutes=float(estimate)))
                ticket["status"] = "active"
            return [ticket]
        spec = next(item for item in CHARTS if item["chart_id"] == chart_id)
        chart = next(
            (item for item in (site.get("charts") or []) if item.get("chart_id") == chart_id),
            {"chart_id": chart_id, "z": None},
        )
        row = _open_case(site, spec, chart, policy, now, actions)
        row["payload"]["escalation"].insert(0, _step(
            row["payload"]["stage"],
            row["payload"].get("estimate_min"),
            "triggered",
            "api",
            now,
        ))
        return [row]
    if ticket is None:
        return []
    payload = ticket.setdefault("payload", {})
    chart_name = payload.get("chart_id") or chart_id
    _append_step(ticket, payload.get("stage") or "reset", payload.get("estimate_min"), "cleared", "api", now)
    ticket["status"] = "done"
    ticket["note"] = f"Trigger cleared {chart_name}."
    online = _return_online(
        site["id"],
        now,
        ticket.get("actor") or "maintenance",
        ticket["id"],
        note="Back online after the trigger was cleared",
    )
    actions.append(online)
    return [ticket, online]


def fleet_manager(
    sites: list[dict],
    actions: list[dict],
    grid: dict,
    usage_by_site: dict[str, list[dict]],
    now: datetime,
) -> list[dict]:
    """A price signal on homes set to dispatch, unless a code response is already open."""
    rate, _basis = market_rate(grid)
    created: list[dict] = []
    pending = list(actions)
    for site in sites:
        if _code_busy(pending, site["id"]) or not site.get("agent_dispatch"):
            site.pop("agent_call", None)
            continue
        expected, source = expected_kw(site, now.hour, usage_by_site.get(site["id"]) or [])
        shape = day_shape(grid.get("day"))
        typical = typical_kw(float(site.get("load_scale") or 1.0), site.get("hour_kw"))
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
            actor="fleet",
        )
        created.append(row)
        pending.append(row)
    return created


def audit(
    sites: list[dict],
    actions: list[dict],
    grid: dict,
    usage_by_site: dict[str, list[dict]],
    now: datetime,
) -> list[dict]:
    """Maintenance manager first, then the fleet manager on homes it left clear."""
    created = maintenance_manager(sites, actions, now)
    created.extend(fleet_manager(sites, list(actions) + created, grid, usage_by_site, now))
    return created
