"""Voicebot test scenarios loaded from YAML files.

The `scenarios/` directory is the source of truth (set SCENARIOS_DIR to point
at it; compose.yaml mounts it at /app/scenarios). A built-in fallback keeps
the API working when no scenario files are found.
"""
import copy
import os
from typing import Any, Optional

import yaml

FALLBACK_SCENARIO: dict[str, Any] = {
    "id": "appointment-booking",
    "name": "Appointment booking",
    "description": "Mock conversation that collects appointment details and validates a test slot.",
    "version": 1,
    "timezone": "Asia/Kolkata",
    "required_fields": ["customer_name", "appointment_date", "appointment_time", "reason"],
    "mock_slot": {"date": "2026-10-23", "time": "11:00", "available": True},
    "assertions": [
        "intent equals book_appointment",
        "all_required_fields_present",
        "availability_checked",
        "booking_status equals confirmed",
    ],
}


def _candidates() -> list[str]:
    here = os.path.dirname(os.path.abspath(__file__))  # backend/app (or /app/app)
    candidates: list[str] = []
    for path in (
        os.getenv("SCENARIOS_DIR"),
        os.path.abspath(os.path.join(here, "..", "..", "scenarios")),  # repo root
        "/app/scenarios",  # Docker mount
    ):
        if path and path not in candidates:
            candidates.append(path)
    return candidates


def scenarios_dir() -> Optional[str]:
    for candidate in _candidates():
        if os.path.isdir(candidate):
            return candidate
    return None


def _normalize(filename: str, data: dict) -> dict:
    stem = os.path.splitext(filename)[0]
    slot = data.get("mock_slot") or {}
    return {
        "id": str(data.get("id") or stem),
        "name": str(data.get("name") or stem),
        "description": str(data.get("description") or ""),
        "version": data.get("version"),
        "timezone": str(data.get("timezone") or ""),
        "required_fields": [str(f) for f in (data.get("required_fields") or [])],
        "mock_slot": {
            "date": slot.get("date"),
            "time": slot.get("time"),
            "available": bool(slot.get("available", True)),
        },
        "assertions": [str(a) for a in (data.get("assertions") or [])],
    }


def load_scenarios() -> list[dict]:
    directory = scenarios_dir()
    if not directory:
        return [copy.deepcopy(FALLBACK_SCENARIO)]
    loaded: list[dict] = []
    for filename in sorted(os.listdir(directory)):
        if not filename.endswith((".yaml", ".yml")):
            continue
        path = os.path.join(directory, filename)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = yaml.safe_load(handle)
        except (OSError, yaml.YAMLError):
            continue
        if isinstance(data, dict):
            loaded.append(_normalize(filename, data))
    return loaded or [copy.deepcopy(FALLBACK_SCENARIO)]


def get_scenario(scenario_id: str) -> Optional[dict]:
    for scenario in load_scenarios():
        if scenario["id"] == scenario_id:
            return scenario
    return None


def evaluate_assertions(rules: list[str], context: dict[str, Any]) -> list[dict]:
    """Evaluate a scenario's assertion rules against a run context.

    Supported rule forms:
      - "intent equals book_appointment" -> str(context["intent"]) == "book_appointment"
      - "availability_checked"           -> bool(context["availability_checked"])
    """
    results: list[dict] = []
    for rule in rules:
        rule = str(rule).strip()
        if not rule:
            continue
        if " equals " in rule:
            name, expected = [part.strip() for part in rule.split(" equals ", 1)]
            actual = context.get(name)
            passed = actual is not None and str(actual) == expected
        else:
            name, expected = rule, True
            actual = context.get(rule)
            passed = bool(actual)
        results.append(
            {"name": name, "expected": expected, "actual": actual, "passed": passed}
        )
    return results
