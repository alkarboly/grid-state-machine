"""Optional call out to a model that writes unit actions.

The tick does not wait on this unless LLM_URL is set, and even then it runs
at most once per LLM_EVERY_S. The request and response shapes are docs/llm.md.
A missing URL means the remote model is skipped. The fleet and maintenance managers still write rows.
"""

from __future__ import annotations

import json
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
