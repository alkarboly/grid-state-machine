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
