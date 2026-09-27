"""Optional call out to a model that writes unit actions.

The tick does not wait on this unless LLM_URL is set, and even then it runs
at most once per LLM_EVERY_S. The request and response shapes are docs/llm.md.
A missing URL means the remote model is skipped. The fleet and maintenance managers still write rows.

An escalated maintenance ticket is separate. The model pulls GET /api/site/{id}
on this API server and closes that ticket from the chart contract.
"""

from __future__ import annotations

import json
import os
import urllib.request

from gridsim import config

_TIMEOUT = 8.0


def write_ticket(context: dict) -> str | None:
    """Ask the configured OpenAI model for the ticket note. None if the key is unset or the call fails."""
    if not config.OPENAI_API_KEY:
        return None
    body = {
        "model": config.OPENAI_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Write one short maintenance ticket for a home battery. "
                    "Use only the JSON you are given. Name the home, the chart, "
                    "the readings, and why the reset did not clear it. Two sentences."
                ),
            },
            {"role": "user", "content": json.dumps(context)},
        ],
    }
    request = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.OPENAI_API_KEY}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
        text = payload["choices"][0]["message"]["content"]
    except Exception:
        return None
    note = str(text).strip()
    return note or None


_EVIDENCE = ("chart_id", "z", "measured", "expected", "soc_pct", "temp_c", "load_kw", "action")


def api_origin() -> str:
    """This process. Render sets PORT. Locally the map listens on 8000."""
    explicit = os.environ.get("GRIDSIM_ORIGIN")
    if explicit:
        return explicit.rstrip("/")
    port = os.environ.get("PORT", "8000")
    return f"http://127.0.0.1:{port}"


def site_evidence(detail: dict, chart_id: str) -> dict | None:
    """The maintenance contract: one chart plus the readings on GET /api/site/{id}."""
    chart = next(
        (item for item in (detail.get("charts") or []) if item.get("chart_id") == chart_id),
        None,
    )
    if not isinstance(chart, dict):
        return None
    metrics = detail.get("metrics") or {}
    base = metrics.get("base") or {}
    panel = metrics.get("panel") or {}
    evidence = {
        "chart_id": chart_id,
        "z": chart.get("z"),
        "measured": chart.get("measured"),
        "expected": chart.get("expected"),
        "soc_pct": base.get("soc_pct"),
        "temp_c": base.get("temp_c"),
        "load_kw": panel.get("load_kw"),
        "action": chart.get("action") or "",
    }
    return {key: evidence[key] for key in _EVIDENCE}


def pull_site(site_id: str) -> dict | None:
    """GET /api/site/{id} on this API server. None when the pull fails."""
    url = f"{api_origin()}/api/site/{site_id}"
    request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            body = json.loads(response.read().decode("utf-8") or "{}")
    except Exception:
        return None
    if not isinstance(body, dict) or body.get("id") != site_id:
        return None
    return body


def propose(context: dict) -> tuple[list[dict], str | None]:
    if not config.LLM_URL:
        return [], None
    payload = json.dumps(context).encode("utf-8")
    request = urllib.request.Request(
        config.LLM_URL,
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            body = json.loads(response.read().decode("utf-8") or "{}")
    except Exception as exc:
        return [], str(exc)
    actions = body.get("actions") if isinstance(body, dict) else None
    if not isinstance(actions, list):
        return [], "llm response has no actions list"
    return actions, None
