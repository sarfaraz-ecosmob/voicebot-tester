"""Minimal OpenRouter chat-completions client (OpenAI-compatible API).

Configuration comes from the environment (see .env / compose.yaml):
  OPENROUTER_API_KEY   - required for AI test runs; empty keeps mock mode
  OPENROUTER_MODEL     - model id, defaults to openai/gpt-4o-mini
  OPENROUTER_SITE_URL  - optional HTTP-Referer attribution header
  OPENROUTER_APP_NAME  - optional X-Title attribution header

Every call publishes an `llm` event on the SSE bus (model, latency, token
usage) so the Live Monitor shows backend activity in realtime.
"""
import json
import os
import re
import time
from typing import Any, Optional

import httpx

from .events import bus

DEFAULT_MODEL = "openai/gpt-4o-mini"
CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"

_client: Optional[httpx.Client] = None


class AIServiceError(RuntimeError):
    """Raised when the OpenRouter request or its response is unusable."""


def api_key() -> str:
    return os.getenv("OPENROUTER_API_KEY", "").strip()


def model() -> str:
    return os.getenv("OPENROUTER_MODEL", "").strip() or DEFAULT_MODEL


def is_configured() -> bool:
    return bool(api_key())


def status() -> dict[str, Any]:
    return {"configured": is_configured(), "model": model() if is_configured() else None}


def _http() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0))
    return _client


def _usage_of(data: Any) -> dict[str, int]:
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(usage, dict):
        return {}
    return {
        "prompt": int(usage.get("prompt_tokens") or 0),
        "completion": int(usage.get("completion_tokens") or 0),
        "total": int(usage.get("total_tokens") or 0),
    }


def chat(
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.8,
    max_tokens: int = 400,
    purpose: str = "chat",
    run_key: Optional[str] = None,
) -> tuple[str, dict[str, Any]]:
    """Run one chat completion.

    Returns (content, meta) where meta carries latency and token usage, and
    publishes an `llm` event for the Live Monitor.
    """
    if not is_configured():
        raise AIServiceError("OPENROUTER_API_KEY is not configured")

    payload = {
        "model": model(),
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {
        "Authorization": f"Bearer {api_key()}",
        "Content-Type": "application/json",
        "X-Title": os.getenv("OPENROUTER_APP_NAME", "Voicebot Testing").strip()
        or "Voicebot Testing",
    }
    referer = os.getenv("OPENROUTER_SITE_URL", "").strip()
    if referer:
        headers["HTTP-Referer"] = referer

    def emit(status: str, meta: dict[str, Any], detail: str = "") -> None:
        bus.publish(
            {
                "type": "llm",
                "purpose": purpose,
                "model": model(),
                "status": status,
                "detail": detail,
                "run_key": run_key,
                **meta,
            }
        )

    last_error: Optional[Exception] = None
    for attempt in range(2):
        started = time.monotonic()
        try:
            response = _http().post(CHAT_URL, json=payload, headers=headers)
            ms = int((time.monotonic() - started) * 1000)
            if response.status_code in (429, 500, 502, 503, 504):
                last_error = AIServiceError(
                    f"OpenRouter returned {response.status_code}: {response.text[:300]}"
                )
                if attempt == 0:
                    time.sleep(1.5)
                    continue
                raise last_error
            if response.status_code >= 400:
                emit("error", {"ms": ms}, f"HTTP {response.status_code}")
                raise AIServiceError(
                    f"OpenRouter returned {response.status_code}: {response.text[:300]}"
                )
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            if not isinstance(content, str) or not content.strip():
                emit("error", {"ms": ms}, "empty completion")
                raise AIServiceError("OpenRouter returned an empty completion")
            usage = _usage_of(data)
            emit("ok", {"ms": ms, "tokens": usage})
            return content.strip(), {"ms": ms, "usage": usage}
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as exc:
            last_error = exc
            if attempt == 0:
                time.sleep(1.5)
                continue
            break
    emit("error", {}, str(last_error))
    raise AIServiceError(f"OpenRouter request failed: {last_error}")


def parse_json_object(text: str) -> dict[str, Any]:
    """Best-effort extraction of the first JSON object from a model response."""
    candidate = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", candidate, re.DOTALL)
    if fenced:
        candidate = fenced.group(1)
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end <= start:
        raise AIServiceError(f"Model did not return JSON: {text[:200]}")
    try:
        parsed = json.loads(candidate[start : end + 1])
    except json.JSONDecodeError as exc:
        raise AIServiceError(f"Model returned invalid JSON: {text[:200]}") from exc
    if not isinstance(parsed, dict):
        raise AIServiceError(f"Model returned JSON that is not an object: {text[:200]}")
    return parsed
