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
