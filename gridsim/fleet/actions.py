"""Unit actions and modular add-ons.

An outside model does not rewrite a battery in place. It inserts a row in
`unit_actions`. The next tick applies that row. See docs/llm.md.
"""

from __future__ import annotations

import math
import random
import uuid
from datetime import datetime, timedelta

from gridsim.timeutil import iso

KINDS = ("scheduled_service", "set_signal", "install_addon", "remove_addon", "return_online")
OPEN = ("pending", "active")

# Rated kilowatts are assumptions. The disco is the component that meters them.
ADDON_CATALOG = {
    "solar": {
        "addon_id": "solar",
        "name": "Solar",
        "role": "source",
        "tracked_by": "disco",
        "rated_kw": 5.0,
    },
    "ev_charger": {
        "addon_id": "ev_charger",
        "name": "Car charger",
        "role": "load",
        "tracked_by": "disco",
        "rated_kw": 7.2,
    },
}


def catalog_rows() -> list[dict]:
    return [
        {
            "addon_id": spec["addon_id"],
            "name": spec["name"],
            "role": spec["role"],
            "rated_kw": spec["rated_kw"],
        }
        for spec in ADDON_CATALOG.values()
    ]


def solar_factor(hour: int) -> float:
    """Daylight fraction. Zero at night, about 0.9 near noon. An assumption."""
    if hour < 7 or hour > 19:
        return 0.0
    return math.sin(math.pi * (hour - 7) / 12.0) * 0.9


def ev_factor(hour: int) -> float:
    """Evening charge. Zero outside 17:00–21:00. An assumption, not a vehicle."""
    if 17 <= hour <= 21:
        return 0.85
    return 0.0


def addon_power(addon_ids: list[str], hour: int) -> list[dict]:
    """What the disco is metering right now, in catalog order."""
    rows = []
    for addon_id in addon_ids:
        spec = ADDON_CATALOG.get(addon_id)
        if spec is None:
            continue
        factor = solar_factor(hour) if addon_id == "solar" else ev_factor(hour)
        rows.append(
            {
                "addon_id": addon_id,
                "role": spec["role"],
                "kw": round(spec["rated_kw"] * factor, 3),
            }
        )
    return rows


def simulated_rate(percentile: float) -> float:
    """The demand curve used when no settlement price is present. 18 + 90 × percentile."""
    return round(18.0 + 90.0 * float(percentile), 2)


def market_rate(grid: dict) -> tuple[float, str]:
    """The rate a controller reads. A real LMP when one exists, otherwise a curve of demand."""
    prices = []
    for item in grid.get("prices") or []:
        point = str(item.get("settlement_point") or item.get("location") or "")
        if item.get("lmp") is None:
            continue
        if point.startswith("LZ_") or point.startswith("HB_"):
            prices.append(float(item["lmp"]))
    if prices:
        return round(sum(prices) / len(prices), 2), "ercot"
    percentile = float(grid.get("demand_percentile") or 0.5)
    return simulated_rate(percentile), "simulated"


def new_action(
    site_id: str,
    kind: str,
    now: datetime,
    note: str = "",
    payload: dict | None = None,
    actor: str = "llm",
    starts_at: datetime | None = None,
    ends_at: datetime | None = None,
) -> dict:
    if kind not in ("scheduled_service", "set_signal", "install_addon", "remove_addon"):
        raise ValueError("kind must be scheduled_service, set_signal, install_addon, or remove_addon")
    body = dict(payload or {})
    if kind == "set_signal" and body.get("signal") not in ("push", "pull", "hold"):
        raise ValueError("set_signal needs payload.signal of push, pull, or hold")
    if kind in ("install_addon", "remove_addon") and body.get("addon_id") not in ADDON_CATALOG:
        raise ValueError("addon_id must be solar or ev_charger")
    if kind == "set_signal" and body.get("intensity") is not None:
        level = float(body["intensity"])
        if not 0.0 <= level <= 1.0:
            raise ValueError("intensity must be from 0 to 1")
        body["intensity"] = level
    action_id = uuid.uuid4().hex
    start = starts_at or now
    end = ends_at
    if kind == "scheduled_service" and end is None:
        hours = 1.0 + random.Random(action_id).random()
        end = start + timedelta(hours=hours)
    if kind == "set_signal" and end is None:
        end = start + timedelta(hours=1)
    return {
        "id": action_id,
        "ts": iso(now),
        "site_id": site_id,
        "kind": kind,
        "status": "pending",
        "starts_at": iso(start),
        "ends_at": iso(end) if end else None,
        "note": note or "",
        "payload": body,
        "actor": actor,
    }


def _at(value: str | None, fallback: datetime) -> datetime:
    if not value:
        return fallback
    return datetime.fromisoformat(value)


def _rank(status: str) -> int:
    return {"pending": 0, "active": 1, "done": 2, "cancelled": 2}.get(status, 0)


def merge_actions(local: list[dict], remote: list[dict]) -> list[dict]:
    """Keep the further-along status when the same id arrives from Supabase."""
    by_id = {row["id"]: dict(row) for row in local}
    for row in remote:
        current = by_id.get(row["id"])
        if current is None or _rank(row.get("status", "")) >= _rank(current.get("status", "")):
            by_id[row["id"]] = dict(row)
    return sorted(by_id.values(), key=lambda row: row.get("ts") or "")


def apply_actions(sites: list[dict], actions: list[dict], now: datetime) -> list[dict]:
    """Mark each open action and stamp the homes it currently affects.

    Returns rows created by the tick, such as coming back online after service.
    """
    by_id = {site["id"]: site for site in sites}
    for site in sites:
        site.pop("offline", None)
        site.pop("signal_override", None)
        site.setdefault("addons", [])

    created: list[dict] = []
    for action in actions:
        if action.get("status") not in OPEN:
            continue
        site = by_id.get(action.get("site_id"))
        if site is None:
            action["status"] = "cancelled"
            action["note"] = action.get("note") or "unknown site"
            continue
        kind = action.get("kind")
        start = _at(action.get("starts_at"), now)
        end = _at(action.get("ends_at"), now)
        payload = action.get("payload") or {}
        if isinstance(payload, str):
            payload = {}

        if kind == "install_addon":
            addon_id = payload.get("addon_id")
            if addon_id in ADDON_CATALOG and addon_id not in site["addons"]:
                site["addons"] = [*site["addons"], addon_id]
            action["status"] = "done"
            continue
        if kind == "remove_addon":
            addon_id = payload.get("addon_id")
            site["addons"] = [item for item in site["addons"] if item != addon_id]
            action["status"] = "done"
            continue
        if now < start:
            action["status"] = "pending"
            continue
        if kind == "scheduled_service":
            if now >= end:
                action["status"] = "done"
                created.append(
                    {
                        "id": uuid.uuid4().hex,
                        "ts": iso(now),
                        "site_id": site["id"],
                        "kind": "return_online",
                        "status": "done",
                        "starts_at": iso(now),
                        "ends_at": iso(now),
                        "note": "Back online after scheduled service",
                        "payload": {"service_id": action["id"]},
                        "actor": "sim",
                    }
                )
            else:
                action["status"] = "active"
                site["offline"] = True
            continue
        if kind == "set_signal":
            if now >= end:
                action["status"] = "done"
            else:
                action["status"] = "active"
                signal = payload.get("signal")
                if signal in ("push", "pull", "hold"):
                    level = 0.0 if signal == "hold" else float(payload.get("intensity") or 1.0)
                    site["signal_override"] = (signal, max(0.0, min(1.0, level)))
    return created
