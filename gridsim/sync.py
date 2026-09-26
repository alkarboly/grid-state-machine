"""The real-time dispatch bus.

Supabase is optional. When it is configured, each tick inserts one
`dispatch_ticks` row and reads the newest `dispatch_orders` row. The browser
never sees the service-role key. A failed call does not stop the tick.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from gridsim import config

_TIMEOUT = 2.5


def _headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_ROLE_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _request(method: str, url: str, body: dict | None = None, extra: dict | None = None):
    headers = _headers()
    if extra:
        headers.update(extra)
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:180]
        raise RuntimeError(f"supabase {exc.code}: {detail}") from None
    return json.loads(raw) if raw else None


def pull_order() -> tuple[dict | None, str | None]:
    """Newest command, or (None, None) when Supabase is not configured."""
    if not config.supabase_configured():
        return None, None
    url = (
        f"{config.SUPABASE_URL}/rest/v1/dispatch_orders"
        "?select=ts,signal,intensity&order=ts.desc&limit=1"
    )
    try:
        rows = _request("GET", url)
    except Exception as exc:
        return None, str(exc)
    if not rows:
        return None, None
    row = rows[0]
    signal = row.get("signal")
    if signal not in ("push", "pull", "hold", "auto"):
        return None, "dispatch order has an unknown signal"
    intensity = row.get("intensity")
    try:
        parsed = None if intensity is None else float(intensity)
    except (TypeError, ValueError):
        return None, "dispatch order intensity is not a number"
    return {
        "signal": signal,
        "intensity": parsed,
        "source": "external",
        "ts": row.get("ts") or "",
    }, None


def push_tick(row: dict) -> str | None:
    """Insert the tick the controller reads. None means success or not configured."""
    if not config.supabase_configured():
        return None
    url = f"{config.SUPABASE_URL}/rest/v1/dispatch_ticks"
    try:
        _request("POST", url, row, {"Prefer": "resolution=merge-duplicates"})
    except Exception as exc:
        return str(exc)
    return None


def _upsert(table: str, rows: dict | list, on_conflict: str) -> None:
    url = f"{config.SUPABASE_URL}/rest/v1/{table}?on_conflict={on_conflict}"
    _request("POST", url, rows, {"Prefer": "resolution=merge-duplicates"})


def pull_addons() -> tuple[dict[str, list[str]] | None, str | None]:
    """Installed add-ons, or (None, None) when Supabase is not configured."""
    if not config.supabase_configured():
        return None, None
    url = f"{config.SUPABASE_URL}/rest/v1/site_addons?select=site_id,addon_id"
    try:
        rows = _request("GET", url) or []
    except Exception as exc:
        return None, str(exc)
    found: dict[str, list[str]] = {}
    for row in rows:
        found.setdefault(row["site_id"], []).append(row["addon_id"])
    return found, None


def pull_actions() -> tuple[list[dict], str | None]:
    """Open actions written by a controller. Empty when Supabase is not configured."""
    if not config.supabase_configured():
        return [], None
    url = (
        f"{config.SUPABASE_URL}/rest/v1/unit_actions"
        "?select=id,ts,site_id,kind,status,starts_at,ends_at,note,payload,actor"
        "&status=in.(pending,active)&order=ts.asc&limit=200"
    )
    try:
        rows = _request("GET", url) or []
    except Exception as exc:
        return [], str(exc)
    for row in rows:
        if not isinstance(row.get("payload"), dict):
            row["payload"] = {}
    return rows, None


def push_market(row: dict) -> str | None:
    if not config.supabase_configured():
        return None
    try:
        _upsert("market_ticks", row, "ts")
    except Exception as exc:
        return str(exc)
    return None


def push_latest(rows: list[dict]) -> str | None:
    if not config.supabase_configured() or not rows:
        return None
    body = [
        {
            "site_id": row["site_id"],
            "ts": row["ts"],
            "soc_kwh": row["soc_kwh"],
            "soc_pct": row["soc_pct"],
            "availability": row["availability"],
            "signal": row["signal"],
            "charge_kw": row["charge_kw"],
            "discharge_kw": row["discharge_kw"],
            "load_kw": row["load_kw"],
            "temp_c": row["temp_c"],
            "addons_json": row["addons"],
        }
        for row in rows
    ]
    try:
        _upsert("unit_latest", body, "site_id")
    except Exception as exc:
        return str(exc)
    return None


def push_usage(rows: list[dict]) -> str | None:
    if not config.supabase_configured() or not rows:
        return None
    try:
        _upsert("usage_hours", rows, "ts,site_id")
    except Exception as exc:
        return str(exc)
    return None


def push_actions(rows: list[dict]) -> str | None:
    if not config.supabase_configured() or not rows:
        return None
    body = [
        {
            "id": row["id"],
            "ts": row["ts"],
            "site_id": row["site_id"],
            "kind": row["kind"],
            "status": row["status"],
            "starts_at": row.get("starts_at"),
            "ends_at": row.get("ends_at"),
            "note": row.get("note") or "",
            "payload": row.get("payload") or {},
            "actor": row.get("actor") or "llm",
        }
        for row in rows
    ]
    try:
        _upsert("unit_actions", body, "id")
    except Exception as exc:
        return str(exc)
    return None


def push_addons(site_id: str, addon_ids: list[str], installed_at: str) -> str | None:
    """Replace the disco's add-on list for one site."""
    if not config.supabase_configured():
        return None
    try:
        _request("DELETE", f"{config.SUPABASE_URL}/rest/v1/site_addons?site_id=eq.{site_id}")
        if addon_ids:
            _request(
                "POST",
                f"{config.SUPABASE_URL}/rest/v1/site_addons",
                [{"site_id": site_id, "addon_id": addon_id, "installed_at": installed_at} for addon_id in addon_ids],
                {"Prefer": "return=minimal"},
            )
    except Exception as exc:
        return str(exc)
    return None
