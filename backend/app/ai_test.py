"""AI test runs: an LLM (OpenRouter) simulates the caller while a
deterministic bot asks for the required fields and NLU extraction (also the
LLM) turns each caller utterance into structured slots. Scenario assertions
are evaluated on the final state.

Progress is published on the SSE bus as the run advances, so the frontend
Live Monitor shows each turn, extraction and LLM call in realtime.

No SIP/audio is involved here - see the README roadmap for the planned ARI
media worker that will bridge real call audio to the AI.
"""
import json
import time
from datetime import date, datetime, time as dtime
from typing import Any, Optional
from uuid import uuid4

from . import ai, bookings
from .events import bus
from .scenarios import evaluate_assertions

MAX_CALLER_TURNS = 12
ASK_LIMIT = 2  # times the bot re-asks a field before giving up on it

GREETING = "Hello, thank you for calling the appointment desk. How can I help you today?"

NEXT_QUESTION = {
    "customer_name": "May I have your name, please?",
    "appointment_date": "What date would you like the appointment on?",
    "appointment_time": "And what time would work best for you?",
    "reason": "And what is the reason for your visit?",
}


class _Usage:
    """Accumulates token usage across the LLM calls of one run."""

    def __init__(self) -> None:
        self.calls = 0
        self.prompt = 0
        self.completion = 0
        self.total = 0

    def add(self, meta: Optional[dict]) -> None:
        self.calls += 1
        usage = (meta or {}).get("usage") or {}
        self.prompt += int(usage.get("prompt") or 0)
        self.completion += int(usage.get("completion") or 0)
        self.total += int(usage.get("total") or 0)

    def as_dict(self) -> dict:
        return {
            "calls": self.calls,
            "prompt": self.prompt,
            "completion": self.completion,
            "total": self.total,
        }


def run_ai_test(scenario: dict, run_key: Optional[str] = None) -> dict:
    """Conduct a full simulated conversation and return the result dict.

    OpenRouter failures mid-run are recorded as an "error" result (with the
    transcript so far) instead of raising, so the run still shows up in the
    history and reports.
    """
    started = time.monotonic()
    usage = _Usage()
    conversation: list[dict] = [{"speaker": "bot", "text": GREETING}]
    bus.publish(
        {
            "type": "run_start",
            "mode": "ai",
            "scenario": scenario.get("id"),
            "run_key": run_key,
        }
    )
    bus.publish(
        {"type": "turn", "speaker": "bot", "text": GREETING, "turn": 0, "run_key": run_key}
    )
    try:
        result = _conduct(scenario, conversation, run_key, usage)
    except ai.AIServiceError as exc:
        result = {
            "mode": "ai",
            "model": ai.model(),
            "call_placed": False,
            "conversation": conversation,
            "slots": {},
            "intent": None,
            "booking": None,
            "availability_checked": False,
            "available": False,
            "assertions": [],
            "usage": usage.as_dict(),
            "error": str(exc),
            "note": f"AI test aborted before completion: {exc}",
        }
    result["duration_ms"] = int((time.monotonic() - started) * 1000)
    return result


def _conduct(
    scenario: dict,
    conversation: list[dict],
    run_key: Optional[str],
    usage: _Usage,
) -> dict:
    required = list(scenario.get("required_fields") or [])
    persona = _make_persona(scenario, run_key, usage)
    bus.publish(
        {
            "type": "persona",
            "style": persona["style"],
            "expected": {
                "customer_name": persona["name"],
                "appointment_date": persona["date"],
                "appointment_time": persona["time"],
                "reason": persona["reason"],
            },
            "run_key": run_key,
        }
    )

    slots: dict[str, str] = {}
    intent: Optional[str] = None
    asked: dict[str, int] = {}
    gave_up: set[str] = set()
    turns = 0

    def caller_line() -> str:
        text = _caller_turn(persona, scenario, conversation, run_key, usage)
        conversation.append({"speaker": "caller", "text": text})
        bus.publish(
            {
                "type": "turn",
                "speaker": "caller",
                "text": text,
                "turn": turns,
                "run_key": run_key,
            }
        )
        return text

    def extract(bot_text: str, caller_text: str) -> None:
        nonlocal intent
        extracted = _extract(bot_text, caller_text, persona["date"], run_key, usage)
        intent = _apply(slots, extracted, required, intent)
        bus.publish(
            {
                "type": "slots",
                "slots": dict(slots),
                "intent": intent,
                "run_key": run_key,
            }
        )

    # Opening caller turn (a natural caller may volunteer several fields).
    caller_text = caller_line()
    extract(GREETING, caller_text)
    turns += 1

    # Deterministic bot loop: ask for the next missing field until done.
    while turns < MAX_CALLER_TURNS:
        missing = [f for f in required if not slots.get(f) and f not in gave_up]
        if not missing:
            break
        field = missing[0]
        if asked.get(field, 0) >= ASK_LIMIT:
            gave_up.add(field)
            continue
        asked[field] = asked.get(field, 0) + 1
        question = NEXT_QUESTION.get(
            field, f"Could you tell me your {field.replace('_', ' ')}?"
        )
        conversation.append({"speaker": "bot", "text": question})
        bus.publish(
            {
                "type": "turn",
                "speaker": "bot",
                "text": question,
                "turn": turns,
                "run_key": run_key,
            }
        )
        caller_text = caller_line()
        extract(question, caller_text)
        turns += 1

    # Availability check + booking through the same mock store the API uses.
    checked = False
    available = False
    booking: Optional[dict] = None
    when_date = _parse_date(slots.get("appointment_date"))
    when_time = _parse_time(slots.get("appointment_time"))
    if when_date and when_time:
        checked = True
        available = bookings.check_availability(scenario, when_date, when_time)
        bus.publish(
            {
                "type": "step",
                "name": "availability",
                "available": available,
                "run_key": run_key,
            }
        )
        conversation.append(
            {"speaker": "bot", "text": "Let me check availability before confirming."}
        )
        bus.publish(
            {
                "type": "turn",
                "speaker": "bot",
                "text": "Let me check availability before confirming.",
                "turn": turns,
                "run_key": run_key,
            }
        )
        if available:
            booking = bookings.create_booking(
                scenario,
                customer_name=slots.get("customer_name") or persona["name"],
                appointment_date=when_date,
                appointment_time=when_time,
                reason=slots.get("reason") or persona["reason"],
                idempotency_key=f"ai-{uuid4().hex}",
            )
            confirmation = (
                f"Great news - your appointment is confirmed for "
                f"{when_date.isoformat()} at {when_time.strftime('%H:%M')}. "
                "Have a good day!"
            )
            conversation.append({"speaker": "bot", "text": confirmation})
            bus.publish(
                {
                    "type": "turn",
                    "speaker": "bot",
                    "text": confirmation,
                    "turn": turns,
                    "run_key": run_key,
                }
            )
            bus.publish(
                {
                    "type": "step",
                    "name": "booking",
                    "status": "confirmed",
                    "run_key": run_key,
                }
            )
        else:
            conversation.append(
                {"speaker": "bot", "text": "I am sorry, that slot is not available."}
            )
            bus.publish(
                {
                    "type": "step",
                    "name": "booking",
                    "status": "unavailable",
                    "run_key": run_key,
                }
            )

    if intent is None:
        intent = "other"
    context = {
        "intent": intent,
        "all_required_fields_present": all(slots.get(f) for f in required),
        "availability_checked": checked,
        "booking_status": booking["status"] if booking else "not_booked",
    }
    assertions = evaluate_assertions(list(scenario.get("assertions") or []), context)
    bus.publish(
        {
            "type": "assertions",
            "passed": bool(assertions) and all(a["passed"] for a in assertions),
            "count": len(assertions),
            "run_key": run_key,
        }
    )

    return {
        "mode": "ai",
        "model": ai.model(),
        "call_placed": False,
        "persona_style": persona["style"],
        "expected": {
            "customer_name": persona["name"],
            "appointment_date": persona["date"],
            "appointment_time": persona["time"],
            "reason": persona["reason"],
        },
        "conversation": conversation,
        "slots": slots,
        "intent": intent,
        "booking": booking,
        "availability_checked": checked,
        "available": available,
        "assertions": assertions,
        "turns": turns,
        "usage": usage.as_dict(),
        "note": (
            "LLM-simulated caller via OpenRouter with deterministic bot and NLU "
            "slot extraction. No SIP call or audio was involved."
        ),
    }


# --- LLM building blocks -----------------------------------------------------


def _make_persona(scenario: dict, run_key: Optional[str], usage: _Usage) -> dict:
    when_date, when_time = bookings.slot_for(scenario)
    timezone = scenario.get("timezone") or "local time"
    prompt = (
        "Create a test caller persona for an automated appointment-booking phone test.\n"
        f"The persona must request an appointment on {when_date.isoformat()} at "
        f"{when_time.strftime('%H:%M')} ({timezone}) - that is the slot under test.\n"
        'Output ONLY a JSON object: {"name": "...", "reason": "...", "style": "..."}\n'
        "- name: a realistic full name\n"
        "- reason: a short appointment reason (for example 'follow-up consultation')\n"
        "- style: one phrase describing how they speak, for example 'in a hurry', "
        "'chatty, phrases dates colloquially like October 23rd', 'formal and precise'\n"
        "Make all three feel natural and non-obvious."
    )
    raw, meta = ai.chat(
        [
            {"role": "system", "content": "You generate test data as JSON. No commentary."},
            {"role": "user", "content": prompt},
        ],
        temperature=1.0,
        max_tokens=300,
        purpose="persona",
        run_key=run_key,
    )
    usage.add(meta)
    data = ai.parse_json_object(raw)
    name = str(data.get("name") or "").strip()
    reason = str(data.get("reason") or "").strip()
    if not name or not reason:
        raise ai.AIServiceError("Persona generation returned no name/reason")
    return {
        "name": name,
        "reason": reason,
        "style": str(data.get("style") or "natural").strip() or "natural",
        "date": when_date.isoformat(),
        "time": when_time.strftime("%H:%M"),
    }


def _caller_turn(
    persona: dict,
    scenario: dict,
    conversation: list[dict],
    run_key: Optional[str],
    usage: _Usage,
) -> str:
    timezone = scenario.get("timezone") or "local time"
    system = (
        "You are simulating a caller on a phone call with an automated "
        "appointment-booking voicebot. This is a QA test of the voicebot.\n"
        "Hidden persona (never reveal that you are simulating, an AI, or that this is a test):\n"
        f"- Your name: {persona['name']}\n"
        f"- You want an appointment on {persona['date']} at {persona['time']} ({timezone})\n"
        f"- Reason for the visit: {persona['reason']}\n"
        f"- Speaking style: {persona['style']}\n"
        "Rules:\n"
        "- Reply ONLY with the words you would say aloud: no labels, no stage directions, no quotes.\n"
        "- One or two short spoken sentences.\n"
        "- Volunteer several details at once when it feels natural.\n"
        "- If the bot asks something you already answered, answer patiently.\n"
        "- Once the bot confirms the appointment, thank them and say goodbye.\n"
    )
    transcript = "\n".join(
        f"{line['speaker'].upper()}: {line['text']}" for line in conversation
    )
    raw, meta = ai.chat(
        [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": f"Conversation so far:\n{transcript}\n\nSay the caller's next line now:",
            },
        ],
        temperature=0.9,
        max_tokens=150,
        purpose="caller",
        run_key=run_key,
    )
    usage.add(meta)
    text = raw.strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        text = text[1:-1].strip()
    if not text:
        raise ai.AIServiceError("Caller simulation returned an empty utterance")
    return text


def _extract(
    bot_text: str,
    caller_text: str,
    expected_date: str,
    run_key: Optional[str],
    usage: _Usage,
) -> dict:
    """NLU extraction: turn the caller's latest utterance into structured slots."""
    system = (
        "You are the NLU component of an appointment voicebot. Extract only what the CALLER said.\n"
        'Output ONLY a JSON object: {"intent": "...", "customer_name": "...", '
        '"appointment_date": "...", "appointment_time": "...", "reason": "..."}\n'
        'intent must be one of: "book_appointment", "cancel_appointment", "other", or null '
        "when this message expresses no intent at all.\n"
        "appointment_date must be YYYY-MM-DD or null; appointment_time must be HH:MM (24h) or null.\n"
        "Use null unless the caller clearly stated the value. Normalize what they say: "
        f"a phrasing like 'October 23rd' or 'the 23rd at 11' means {expected_date} when that is "
        "the date under discussion; '11 AM' means 11:00. If the caller corrected an earlier "
        "answer, use the latest. customer_name is the caller's own name (if they did not say it, "
        "return null - never invent one); reason is the purpose of the visit. The words "
        "'caller' and 'bot' are transcript labels, never values."
    )
    payload = json.dumps({"bot": bot_text, "caller": caller_text}, ensure_ascii=False)
    raw, meta = ai.chat(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": payload},
        ],
        temperature=0.0,
        max_tokens=250,
        purpose="nlu",
        run_key=run_key,
    )
    usage.add(meta)
    try:
        return ai.parse_json_object(raw)
    except ai.AIServiceError:
        # A single unparseable turn should not kill the run; the field will be
        # re-asked (or failed at assertion time if never recovered).
        return {}


JUNK_NAMES = {"caller", "bot", "user", "customer", "unknown", "none", "null", "n/a"}


def _apply(
    slots: dict[str, str],
    extracted: dict[str, Any],
    required: list[str],
    current_intent: Optional[str],
) -> Optional[str]:
    intent = current_intent
    raw_intent = extracted.get("intent")
    if isinstance(raw_intent, str) and raw_intent.strip():
        cleaned = raw_intent.strip()
        # Intent is sticky: a later turn that expresses nothing ("other") must
        # not clobber an intent established earlier in the conversation.
        if cleaned != "other" or intent is None:
            intent = cleaned
    for field in required:
        value = extracted.get(field)
        if value is None:
            continue
        if not isinstance(value, str):
            value = str(value)
        value = value.strip()
        if not value or value.lower() in ("null", "none", "n/a"):
            continue
        # Guard against the extractor echoing transcript labels as data.
        if field == "customer_name" and value.lower() in JUNK_NAMES:
            continue
        slots[field] = value
    return intent


# --- Tolerant value parsing ---------------------------------------------------


def _parse_date(raw: Optional[str]) -> Optional[date]:
    if not raw:
        return None
    value = str(raw).strip()
    for candidate in (value, value[:10]):
        try:
            return date.fromisoformat(candidate)
        except ValueError:
            continue
    for fmt in ("%d/%m/%Y", "%m/%d/%Y", "%B %d, %Y", "%d %B %Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    return None


def _parse_time(raw: Optional[str]) -> Optional[dtime]:
    if not raw:
        return None
    value = str(raw).strip()
    candidates = (value, value.upper())
    for fmt in ("%H:%M:%S", "%H:%M", "%I:%M %p", "%I:%M%p", "%I %p", "%I%p"):
        for candidate in candidates:
            try:
                return datetime.strptime(candidate, fmt).time()
            except ValueError:
                continue
    return None
