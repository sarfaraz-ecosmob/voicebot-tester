"""Deterministic mock appointment store shared by the API and AI test runs."""
from datetime import date, time

# Fixed deterministic fixture used when no scenario provides a mock slot.
DEFAULT_SLOT = (date(2026, 10, 23), time(11, 0))

BOOKINGS: dict[str, dict] = {}


def slot_for(scenario: dict | None) -> tuple[date, time]:
    if scenario:
        slot = scenario.get("mock_slot") or {}
        try:
            return (
                date.fromisoformat(str(slot["date"])),
                time.fromisoformat(str(slot["time"])),
            )
        except (KeyError, TypeError, ValueError):
            pass
    return DEFAULT_SLOT


def check_availability(scenario: dict | None, when_date: date, when_time: time) -> bool:
    if scenario and not (scenario.get("mock_slot") or {}).get("available", True):
        return False
    return (when_date, when_time) == slot_for(scenario)


def create_booking(
    scenario: dict | None,
    *,
    customer_name: str,
    appointment_date: date,
    appointment_time: time,
    reason: str,
    idempotency_key: str,
) -> dict:
    """Create a mock booking (idempotent). Raises ValueError if unavailable."""
    if idempotency_key in BOOKINGS:
        return BOOKINGS[idempotency_key]
    if not check_availability(scenario, appointment_date, appointment_time):
        raise ValueError("Requested mock slot is unavailable")
    result = {
        "booking_id": f"MOCK-{len(BOOKINGS) + 1:05d}",
        "status": "confirmed",
        "customer_name": customer_name,
        "appointment_date": appointment_date.isoformat(),
        "appointment_time": appointment_time.strftime("%H:%M"),
        "reason": reason,
        "mock": True,
    }
    BOOKINGS[idempotency_key] = result
    return result
