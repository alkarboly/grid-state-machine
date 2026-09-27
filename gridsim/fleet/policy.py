"""Dispatch signal. See docs/simulation.md for the order of rules."""

from __future__ import annotations

# The ladder in simulation.md, in the same order.
LMP_PUSH_FLOOR = 40.0
LMP_PUSH_RATIO = 1.1
LMP_PULL_CAP = 25.0
LMP_PULL_RATIO = 0.9
DEMAND_PUSH = 0.75
DEMAND_PULL = 0.35
DEMAND_MID = 0.50
STORAGE_PUSH = 200.0
STORAGE_PULL = -200.0


def explain_signal(
    demand_percentile: float,
    storage_gen_mw: float | None,
    lmp: float | None,
    lmp_mean: float | None,
    demand_only: bool = False,
) -> tuple[str, list[dict]]:
    """The call, and the clause that fired. `threshold` is the limit to highlight.

    `demand_only` is reverse demand: skip prices, then take the opposite of the
    live call so a storage-driven discharge becomes a charging window.
    """
    if not demand_only and lmp is not None and lmp_mean is not None:
        push_at = max(LMP_PUSH_FLOOR, lmp_mean * LMP_PUSH_RATIO)
        if lmp >= push_at:
            limit = f"{push_at:.0f} $/MWh"
            line = (
                f"load-zone price {lmp:.0f} $/MWh ≥ {limit}"
                f" (greater of {LMP_PUSH_FLOOR:.0f} and {LMP_PUSH_RATIO:.1f}× the mean {lmp_mean:.0f})"
            )
            return "push", [{"line": line, "threshold": limit}]
        pull_at = min(LMP_PULL_CAP, lmp_mean * LMP_PULL_RATIO)
        if lmp <= pull_at:
            limit = f"{pull_at:.0f} $/MWh"
            line = (
                f"load-zone price {lmp:.0f} $/MWh ≤ {limit}"
                f" (lesser of {LMP_PULL_CAP:.0f} and {LMP_PULL_RATIO:.1f}× the mean {lmp_mean:.0f})"
            )
            return "pull", [{"line": line, "threshold": limit}]
    if demand_only:
        original = round(1.0 - float(demand_percentile), 4)
        live_signal, _live = explain_signal(original, storage_gen_mw, None, None)
        if live_signal == "push":
            return "pull", [{
                "line": f"reversed demand percentile {demand_percentile:.2f} opens a charging window",
                "threshold": "charging window",
            }]
        if live_signal == "pull":
            return "push", [{
                "line": f"reversed demand percentile {demand_percentile:.2f} matches inverted peak demand",
                "threshold": "inverted peak",
            }]
        if demand_percentile <= DEMAND_MID:
            return "pull", [{
                "line": f"reversed demand percentile {demand_percentile:.2f} ≤ {DEMAND_MID:.2f}",
                "threshold": f"{DEMAND_MID:.2f}",
            }]
        return "push", [{
            "line": f"reversed demand percentile {demand_percentile:.2f} > {DEMAND_MID:.2f}",
            "threshold": f"{DEMAND_MID:.2f}",
        }]
    if demand_percentile >= DEMAND_PUSH:
        return "push", [{
            "line": f"demand percentile {demand_percentile:.2f} ≥ {DEMAND_PUSH:.2f}",
            "threshold": f"{DEMAND_PUSH:.2f}",
        }]
    if demand_percentile <= DEMAND_PULL:
        return "pull", [{
            "line": f"demand percentile {demand_percentile:.2f} ≤ {DEMAND_PULL:.2f}",
            "threshold": f"{DEMAND_PULL:.2f}",
        }]
    storage = storage_gen_mw or 0.0
    if storage >= STORAGE_PUSH:
        return "push", [{
            "line": f"storage {storage:.0f} MW ≥ {STORAGE_PUSH:.0f} MW",
            "threshold": f"{STORAGE_PUSH:.0f} MW",
        }]
    if storage <= STORAGE_PULL:
        return "pull", [{
            "line": f"storage {storage:.0f} MW ≤ {STORAGE_PULL:.0f} MW",
            "threshold": f"{STORAGE_PULL:.0f} MW",
        }]
    return "hold", [{
        "line": (
            f"demand percentile {demand_percentile:.2f} is between {DEMAND_PULL:.2f} and {DEMAND_PUSH:.2f},"
            f" and storage {storage:.0f} MW is inside ±{STORAGE_PUSH:.0f} MW"
        ),
        "threshold": f"{DEMAND_PULL:.2f} and {DEMAND_PUSH:.2f}",
    }]


def choose_signal(
    demand_percentile: float,
    storage_gen_mw: float | None,
    lmp: float | None,
    lmp_mean: float | None,
    demand_only: bool = False,
) -> str:
    signal, _because = explain_signal(
        demand_percentile, storage_gen_mw, lmp, lmp_mean, demand_only=demand_only
    )
    return signal


def intensity(signal: str, demand_percentile: float) -> float:
    if signal == "push":
        return min(1.0, max(0.35, 0.4 + (demand_percentile - 0.75) * 2))
    if signal == "pull":
        return min(1.0, max(0.35, 0.4 + (0.35 - demand_percentile) * 2))
    return 0.0


def soc_queue(members: list[tuple[str, float]], signal: str) -> dict[str, float]:
    """Place in a service-area queue. 0 answers first.

    `members` is `(site_id, stored_kwh)`. Push ranks fullest first. Pull ranks
    emptiest first. Ties break on site id. Intensity still gates how many
    answer: a mild call takes the front of this queue.
    """
    if signal not in ("push", "pull") or not members:
        return {}
    reverse = signal == "push"
    ordered = sorted(members, key=lambda row: (row[1], row[0]), reverse=reverse)
    size = len(ordered)
    return {site_id: rank / size for rank, (site_id, _stored) in enumerate(ordered)}


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
