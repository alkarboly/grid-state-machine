"""Dispatch signal. See docs/simulation.md for the order of rules."""

from __future__ import annotations


def choose_signal(
    demand_percentile: float,
    storage_gen_mw: float | None,
    lmp: float | None,
    lmp_mean: float | None,
) -> str:
    if lmp is not None and lmp_mean is not None:
        if lmp >= max(40.0, lmp_mean * 1.1):
            return "push"
        if lmp <= min(25.0, lmp_mean * 0.9):
            return "pull"
    if demand_percentile >= 0.75:
        return "push"
    if demand_percentile <= 0.35:
        return "pull"
    storage = storage_gen_mw or 0.0
    if storage >= 200:
        return "push"
    if storage <= -200:
        return "pull"
    return "hold"


def intensity(signal: str, demand_percentile: float) -> float:
    if signal == "push":
        return min(1.0, max(0.35, 0.4 + (demand_percentile - 0.75) * 2))
    if signal == "pull":
        return min(1.0, max(0.35, 0.4 + (0.35 - demand_percentile) * 2))
    return 0.0


def resolve_order(order: dict | None, demand_percentile: float) -> tuple[str, float, str] | None:
    """A fleet-wide call from outside the ladder.

    None means each home still follows the ladder, including its own load-zone
    price. `auto` is the same as no order. Hold carries intensity 0.
    """
    if not order:
        return None
    signal = order.get("signal")
    if signal in (None, "", "auto", "rules"):
        return None
    if signal not in ("push", "pull", "hold"):
        return None
    if signal == "hold":
        level = 0.0
    elif order.get("intensity") is None:
        level = intensity(signal, demand_percentile)
    else:
        level = min(1.0, max(0.0, float(order["intensity"])))
    return signal, level, "external"
