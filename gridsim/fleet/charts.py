"""Individuals control charts. Field names match docs/control-charts.md."""

from __future__ import annotations

LIMIT_SIGMA = 3.0
WARN_SIGMA = 2.0
# Tick residuals kept for the run rules. The drawn series is the 30-hour trace.
HISTORY = 24
CHART_HOURS = 30
CHART_STEP_SECONDS = 60
CHART_POINTS = CHART_HOURS * 3600 // CHART_STEP_SECONDS


def series_seconds(chart_id: str) -> int:
    """How long one drawn point covers. Temperature is the hour mean. The others are one minute."""
    if chart_id == "base_temp":
        return 3600
    return CHART_STEP_SECONDS


def trace_values(samples) -> list:
    """The live series. A missed bucket is null."""
    if not samples:
        return []
    return [None if value != value else round(float(value), 4) for value in samples]

CHARTS = (
    {
        "chart_id": "disco_meter_delta",
        "component": "meter",
        "family": "measurement",
        "title": "Meter agreement",
        "unit": "kW",
        "sigma": 0.20,
        "action": "Compare the disco to the billing meter. If they still disagree, post scheduled_service.",
        "steps": ({"kind": "scheduled_service"},),
    },
    {
        "chart_id": "base_temp",
        "component": "base",
        "family": "thermal",
        "title": "Cabinet temperature",
        "unit": "°C",
        "sigma": None,
        "action": "Post set_signal hold so the pack stops working, then scheduled_service for cooling or a stuck sensor.",
        "steps": (
            {"kind": "set_signal", "signal": "hold", "intensity": 0},
            {"kind": "scheduled_service"},
        ),
    },
    {
        "chart_id": "disco_voltage",
        "component": "disco",
        "family": "electrical",
        "title": "Service voltage",
        "unit": "V",
        "sigma": None,
        "action": "Post scheduled_service and check the connection at the disconnect.",
        "steps": ({"kind": "scheduled_service"},),
    },
    {
        "chart_id": "frequency",
        "component": "disco",
        "family": "electrical",
        "title": "Frequency",
        "unit": "Hz",
        "sigma": 0.025,
        "action": "Leave the cabinet. Frequency is the grid, not this battery.",
        "steps": (),
    },
    {
        "chart_id": "soc_tracking",
        "component": "base",
        "family": "energy",
        "title": "State-of-charge tracking",
        "unit": "kWh",
        "sigma": 0.45,
        "action": "Post scheduled_service. The reported charge has left the coulomb count.",
        "steps": ({"kind": "scheduled_service"},),
    },
    {
        "chart_id": "dispatch_response",
        "component": "base",
        "family": "response",
        "title": "Dispatch response",
        "unit": "kW",
        "sigma": 0.40,
        "action": "Post set_signal hold, then scheduled_service. The battery is not doing what it was told.",
        "steps": (
            {"kind": "set_signal", "signal": "hold", "intensity": 0},
            {"kind": "scheduled_service"},
        ),
    },
)


def evaluate(spec: dict, measured: float, expected: float, sigma: float, history: list[float]) -> dict:
    """Chart the residual measured - expected. Limits are ±3 sigma around 0.

    `alarm` and `warning` are severity; `in_control` and `rules` are the statistics.
    They differ on purpose: a run rule fires on about 1.6% of healthy charts, which
    is noise on one battery and hundreds of false alarms across a fleet.
    """
    value = measured - expected
    sigma = sigma if sigma else spec["sigma"]
    z = value / sigma if sigma else 0.0
    rules: list[str] = []
    if abs(z) >= LIMIT_SIGMA:
        rules.append("beyond_3sigma")

    run = list(history)[-6:] + [value]
    if len(run) >= 7 and (all(point > 0 for point in run) or all(point < 0 for point in run)):
        rules.append("seven_same_side")

    recent = list(history)[-2:] + [value]
    if len(recent) >= 3 and sigma:
        above = sum(1 for point in recent if point / sigma >= WARN_SIGMA)
        below = sum(1 for point in recent if point / sigma <= -WARN_SIGMA)
        if above >= 2 or below >= 2:
            rules.append("two_of_three_2sigma")

    return {
        "chart_id": spec["chart_id"],
        "component": spec["component"],
        "family": spec["family"],
        "title": spec["title"],
        "unit": spec["unit"],
        "action": spec["action"],
        "measured": round(measured, 4),
        "expected": round(expected, 4),
        "value": round(value, 4),
        "sigma": round(sigma, 4),
        "ucl": round(LIMIT_SIGMA * sigma, 4),
        "lcl": round(-LIMIT_SIGMA * sigma, 4),
        "z": round(z, 3),
        "rules": rules,
        "in_control": not rules,
        # Only a point outside the limits raises an alarm. The run rules are
        # advisory, because across a fleet of charts they fire on their own.
        "alarm": "beyond_3sigma" in rules,
        "warning": bool(rules) if rules else abs(z) >= WARN_SIGMA,
    }
