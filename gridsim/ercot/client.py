"""ERCOT dashboard JSON and the official public-reports API."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request

from gridsim import config
from gridsim.timeutil import now_central

_TOKEN = {"value": "", "expires_at": 0.0}


def _get_json(url: str, headers: dict | None = None, timeout: int = 20) -> dict:
    request = urllib.request.Request(url, headers=headers or {"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_dashboards() -> dict:
    return {
        "supply_demand": _get_json(config.SUPPLY_DEMAND_URL, timeout=12),
        "fuel_mix": _get_json(config.FUEL_MIX_URL, timeout=12),
    }


def _id_token() -> str:
    now = time.time()
    if _TOKEN["value"] and now < _TOKEN["expires_at"] - 60:
        return _TOKEN["value"]
    form = urllib.parse.urlencode(
        {
            "grant_type": "password",
            "username": config.ERCOT_USERNAME,
            "password": config.ERCOT_PASSWORD,
            "response_type": "id_token",
            "scope": f"openid {config.TOKEN_CLIENT_ID} offline_access",
            "client_id": config.TOKEN_CLIENT_ID,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        config.TOKEN_URL,
        data=form,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"ERCOT token failed ({exc.code}): {detail}") from exc
    token = payload.get("id_token")
    if not token:
        raise RuntimeError("ERCOT token response had no id_token")
    _TOKEN["value"] = token
    _TOKEN["expires_at"] = now + 3600
    return token


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_id_token()}",
        "Ocp-Apim-Subscription-Key": config.ERCOT_SUBSCRIPTION_KEY,
        "Accept": "application/json",
    }


def _sced_stamp(moment) -> str:
    """ERCOT rejects an offset. The clock is already Central."""
    return moment.strftime("%Y-%m-%dT%H:%M:%S")


def _window(hours: float) -> dict:
    end = now_central()
    start = end.timestamp() - hours * 3600
    from datetime import datetime

    from gridsim.timeutil import CENTRAL

    start_at = datetime.fromtimestamp(start, CENTRAL)
    return {
        "SCEDTimestampFrom": _sced_stamp(start_at),
        "SCEDTimestampTo": _sced_stamp(end),
    }


def _rows_from_page(payload: dict) -> list[dict]:
    fields = [field["name"] for field in payload.get("fields") or []]
    data = payload.get("data") or []
    if data and isinstance(data[0], dict):
        return data
    if not fields:
        return []
    return [dict(zip(fields, row)) for row in data]


def fetch_report(path: str, extra: dict, max_pages: int) -> list[dict]:
    rows: list[dict] = []
    page = 1
    total = 1
    while page <= total and page <= max_pages:
        params = {"size": 1000, "page": page, **extra}
        url = config.PUBLIC_API + path + "?" + urllib.parse.urlencode(params)
        try:
            payload = _get_json(url, headers=_headers(), timeout=30)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"{path} failed ({exc.code}): {detail}") from exc
        rows.extend(_rows_from_page(payload))
        total = int((payload.get("_meta") or {}).get("totalPages") or 1)
        page += 1
    return rows


def fetch_official() -> dict:
    """Constraints, settlement LMPs, and one page of bus LMPs."""
    return {
        "constraints": fetch_report(
            "/np6-86-cd/shdw_prices_bnd_trns_const",
            _window(3),
            max_pages=2,
        ),
        "settlement_lmps": fetch_report(
            "/np6-788-cd/lmp_node_zone_hub",
            _window(1),
            max_pages=2,
        ),
        "bus_lmps": fetch_report(
            "/np6-787-cd/lmp_electrical_bus",
            _window(0.5),
            max_pages=1,
        ),
    }
