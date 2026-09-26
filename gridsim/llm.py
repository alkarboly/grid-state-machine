"""Optional call out to a model that writes unit actions.

The tick does not wait on this unless LLM_URL is set, and even then it runs
at most once per LLM_EVERY_S. The request and response shapes are docs/llm.md.
A missing URL means actions arrive only as rows in Supabase or POST /api/actions.
"""

from __future__ import annotations

import json
import urllib.request

from gridsim import config

_TIMEOUT = 8.0


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
