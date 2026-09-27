"""OpenAI summarizes an escalated service ticket. LLM_URL is a separate optional writer.

decide_maintenance writes two sentences from GET /api/site/{id}: the readings
and how the chart procedure resolves them. The state machine still closes the
ticket. A missing OPENAI_API_KEY keeps the chart sentence.

LLM_URL is optional and outside the tick. It POSTs at most once per
LLM_EVERY_S. Shapes are docs/llm.md. The fleet and maintenance managers still
write rows when that URL is unset.
"""

from __future__ import annotations

import json
import os
import urllib.request

from gridsim import config

_TIMEOUT = 8.0


def _chat(system: str, user: str) -> str | None:
    """One chat completion. None if the key is unset or the call fails."""
    if not config.OPENAI_API_KEY:
        return None
    body = {
        "model": config.OPENAI_MODEL,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
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


def decide_maintenance(pull: dict) -> dict | None:
    """Ask OPENAI_MODEL to summarize this pull. None keeps the chart sentence."""
    raw = _chat(
        (
            "You summarize one home-battery maintenance ticket. "
            "Use only the JSON you are given. evidence.action is the procedure for this chart. "
            'Reply with JSON {"result":"done","action":"..."}. '
            "action is two sentences: what the readings show, and how that procedure resolves it. "
            "Do not invent readings."
        ),
        json.dumps(pull),
    )
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    action = str(parsed.get("action") or "").strip()
    if not action:
        return None
    return {"result": "done", "action": action, "model": config.OPENAI_MODEL}


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
