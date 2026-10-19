import csv
import html
import io
import json
import os
import re
from datetime import date, datetime, time, timezone
from pathlib import Path
from time import monotonic, sleep
from typing import Literal, Optional
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import ai, ai_test, bookings
from .db import Base, engine, get_db
from .events import bus
from .models import TestRun
from .scenarios import evaluate_assertions, get_scenario, load_scenarios

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Voicebot Testing API", version="0.3.0")

origins = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[x.strip() for x in origins],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

DEFAULT_SCENARIO_ID = "appointment-booking"


class AvailabilityRequest(BaseModel):
    appointment_date: date
    appointment_time: time


class BookingRequest(BaseModel):
    customer_name: str = Field(min_length=2, max_length=120)
    appointment_date: date
    appointment_time: time
    reason: str = Field(min_length=2, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=120)


class TestRunRequest(BaseModel):
    mode: Literal["mock", "ai"] = "mock"
    scenario_id: str = DEFAULT_SCENARIO_ID
    # Client-generated id used to correlate SSE progress events with this run.
    run_key: Optional[str] = Field(default=None, max_length=64)


def _default_scenario() -> dict:
    return get_scenario(DEFAULT_SCENARIO_ID) or {
        "id": DEFAULT_SCENARIO_ID,
        "name": "Appointment booking",
        "required_fields": ["customer_name", "appointment_date", "appointment_time", "reason"],
        "mock_slot": {"date": "2026-10-23", "time": "11:00", "available": True},
        "assertions": [],
        "timezone": "Asia/Kolkata",
    }


def _status_of(result: dict) -> str:
    if result.get("error"):
        return "error"
    assertions = result.get("assertions") or []
    if assertions and all(a.get("passed") for a in assertions):
        return "passed"
    return "failed"


# --- Health / scenarios / realtime events -------------------------------------

@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "mode": "mock+ai" if ai.is_configured() else "mock",
        "version": "0.3.0",
        "ai": ai.status(),
    }


@app.get("/api/scenarios")
def scenarios():
    return load_scenarios()


@app.get("/api/events")
def events():
    """Server-Sent Events stream: run lifecycle, turns, LLM calls, bookings."""
    return StreamingResponse(
        bus.sse_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- Test runs -----------------------------------------------------------------

@app.get("/api/test-runs")
def list_runs(db: Session = Depends(get_db)):
    rows = db.query(TestRun).order_by(TestRun.id.desc()).limit(50).all()
    return [
        {
            "id": r.id,
            "scenario_name": r.scenario_name,
            "status": r.status,
            "result": json.loads(r.result_json),
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@app.get("/api/test-runs/{run_id}")
def get_run(run_id: int, db: Session = Depends(get_db)):
    row = db.get(TestRun, run_id)
    if not row:
        raise HTTPException(status_code=404, detail="Test run not found")
    return {
        "id": row.id,
        "scenario_name": row.scenario_name,
        "status": row.status,
        "result": json.loads(row.result_json),
        "created_at": row.created_at.isoformat(),
    }


@app.post("/api/appointments/check-availability")
def check_availability(request: AvailabilityRequest):
    scenario = get_scenario(DEFAULT_SCENARIO_ID)
    available = bookings.check_availability(
        scenario, request.appointment_date, request.appointment_time
    )
    return {
        "available": available,
        "slot": {
            "date": request.appointment_date.isoformat(),
            "time": request.appointment_time.strftime("%H:%M"),
        },
    }


@app.post("/api/appointments/book")
def book_appointment(request: BookingRequest):
    scenario = get_scenario(DEFAULT_SCENARIO_ID)
    try:
        return bookings.create_booking(
            scenario,
            customer_name=request.customer_name,
            appointment_date=request.appointment_date,
            appointment_time=request.appointment_time,
            reason=request.reason,
            idempotency_key=request.idempotency_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.post("/api/test-runs")
def run_test(payload: Optional[TestRunRequest] = None, db: Session = Depends(get_db)):
    payload = payload or TestRunRequest()
    scenario = get_scenario(payload.scenario_id)
    if not scenario:
        raise HTTPException(
            status_code=404, detail=f"Scenario '{payload.scenario_id}' not found"
        )

    started = monotonic()
    if payload.mode == "ai":
        if not ai.is_configured():
            raise HTTPException(
                status_code=503,
                detail=(
                    "AI mode is not configured. Set OPENROUTER_API_KEY in .env "
                    "and restart the api container (docker compose up -d api)."
                ),
            )
        result = ai_test.run_ai_test(scenario, run_key=payload.run_key)
    else:
        bus.publish(
            {
                "type": "run_start",
                "mode": "mock",
                "scenario": scenario.get("id"),
                "run_key": payload.run_key,
            }
        )
        result = _run_mock(scenario, run_key=payload.run_key)
    result.setdefault("duration_ms", int((monotonic() - started) * 1000))

    status = _status_of(result)
    row = TestRun(
        scenario_name=scenario["name"], status=status, result_json=json.dumps(result)
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    bus.publish(
        {
            "type": "run_end",
            "mode": result.get("mode"),
            "status": status,
            "id": row.id,
            "duration_ms": result.get("duration_ms"),
            "run_key": payload.run_key,
        }
    )
    return {
        "id": row.id,
        "status": row.status,
        "result": result,
        "created_at": row.created_at.isoformat(),
    }


def _run_mock(scenario: dict, run_key: Optional[str] = None) -> dict:
    # Deterministic fixture: validates the workflow; it does not place a call.
    slot_date, slot_time = bookings.slot_for(scenario)
    requested = {
        "customer_name": "Alex Tester",
        "appointment_date": slot_date.isoformat(),
        "appointment_time": slot_time.strftime("%H:%M"),
        "reason": "consultation",
    }
    conversation = [
        {"speaker": "bot", "text": "Hello, welcome to the appointment desk. How can I help you today?"},
        {"speaker": "caller", "text": "I want to book an appointment."},
        {"speaker": "bot", "text": "Which date and time would you prefer?"},
        {"speaker": "caller", "text": "Friday, October 23 at 11 AM. My name is Alex Tester and the reason is a consultation."},
        {"speaker": "bot", "text": "Let me check availability before confirming."},
    ]
    for index, line in enumerate(conversation):
        bus.publish(
            {
                "type": "turn",
                "speaker": line["speaker"],
                "text": line["text"],
                "turn": index,
                "run_key": run_key,
            }
        )

    checked = True
    available = bookings.check_availability(scenario, slot_date, slot_time)
    bus.publish(
        {"type": "step", "name": "availability", "available": available, "run_key": run_key}
    )
    booking = None
    if available:
        booking = bookings.create_booking(
            scenario,
            customer_name=requested["customer_name"],
            appointment_date=slot_date,
            appointment_time=slot_time,
            reason=requested["reason"],
            idempotency_key=f"mock-{uuid4().hex}",
        )
    bus.publish(
        {
            "type": "step",
            "name": "booking",
            "status": booking["status"] if booking else "unavailable",
            "run_key": run_key,
        }
    )

    required = list(scenario.get("required_fields") or requested)
    context = {
        "intent": "book_appointment",
        "all_required_fields_present": all(requested.get(f) for f in required),
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

    recording_info = _latest_recording_info({})
    return {
        "mode": "mock",
        "call_placed": False,
        "conversation": conversation,
        "intent": "book_appointment",
        "booking": booking,
        "availability_checked": checked,
        "available": available,
        "assertions": assertions,
        "note": "Mock workflow only: no SIP call or real AI provider was used.",
        "recording": recording_info,
    }


# --- Helper: latest recording info for a run ---

def _latest_recording_info(run_result: dict) -> dict:
    """Check the recordings directory and return info about the latest recording, if any."""
    directory = _recordings_dir()
    if not directory:
        return {"has_recordings": False, "count": 0, "latest_name": None}
    import glob as glob_mod
    entries = glob_mod.glob(str(directory / "*.wav"))
    if not entries:
        return {"has_recordings": False, "count": 0, "latest_name": None}
    # Pick the most recently created file
    latest = max(entries, key=lambda p: os.path.getctime(p))
    name = os.path.basename(latest)
    try:
        size = os.path.getsize(latest)
    except OSError:
        size = 0
    return {"has_recordings": True, "count": 1, "latest_name": name, "size_bytes": size}


# --- Reports -------------------------------------------------------------------

@app.get("/api/reports/summary")
def reports_summary(db: Session = Depends(get_db)):
    rows = db.query(TestRun).order_by(TestRun.id.desc()).limit(500).all()
    by_status: dict[str, int] = {}
    by_mode: dict[str, int] = {}
    tokens = {"calls": 0, "prompt": 0, "completion": 0, "total": 0}
    durations: list[int] = []
    for row in rows:
        by_status[row.status] = by_status.get(row.status, 0) + 1
        try:
            result = json.loads(row.result_json)
        except json.JSONDecodeError:
            result = {}
        mode = str(result.get("mode") or "mock")
        by_mode[mode] = by_mode.get(mode, 0) + 1
        usage = result.get("usage") or {}
        for key in tokens:
            tokens[key] += int(usage.get(key) or 0)
        duration = result.get("duration_ms")
        if isinstance(duration, int) and duration > 0:
            durations.append(duration)
    total = len(rows)
    passed = by_status.get("passed", 0)
    return {
        "total": total,
        "by_status": by_status,
        "by_mode": by_mode,
        "pass_rate": round(passed / total, 3) if total else None,
        "tokens": tokens,
        "avg_duration_ms": int(sum(durations) / len(durations)) if durations else None,
        "latest_id": rows[0].id if rows else None,
    }


@app.get("/api/reports/{run_id}")
def report(
    run_id: int,
    format: Literal["html", "json", "csv"] = "html",
    download: bool = False,
    db: Session = Depends(get_db),
):
    """Generate a report for one run: printable HTML, JSON or CSV transcript."""
    row = db.get(TestRun, run_id)
    if not row:
        raise HTTPException(status_code=404, detail="Test run not found")
    try:
        result = json.loads(row.result_json)
    except json.JSONDecodeError:
        result = {}
    disposition = "attachment" if download else "inline"

    if format == "json":
        payload = {
            "id": row.id,
            "scenario": row.scenario_name,
            "status": row.status,
            "created_at": row.created_at.isoformat(),
            "result": result,
        }
        return JSONResponse(
            payload,
            headers={
                "Content-Disposition": f'{disposition}; filename="report-run-{row.id}.json"'
            },
        )

    if format == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["turn", "speaker", "text"])
        for index, line in enumerate(result.get("conversation") or [], start=1):
            writer.writerow([index, line.get("speaker", ""), line.get("text", "")])
        return Response(
            buffer.getvalue(),
            media_type="text/csv",
            headers={
                "Content-Disposition": f'{disposition}; filename="report-run-{row.id}.csv"'
            },
        )

    document = HTMLResponse(_report_html(row, result))
    document.headers["Content-Disposition"] = (
        f'{disposition}; filename="report-run-{row.id}.html"'
    )
    return document


_REPORT_CSS = """
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
         color: #172033; background: #f4f6fa; margin: 0; padding: 32px; }
  .sheet { max-width: 860px; margin: 0 auto; background: white; border: 1px solid #e3e8f0;
           border-radius: 14px; padding: 36px; box-shadow: 0 8px 30px rgba(24,41,74,.08); }
  h1 { font-size: 26px; margin: 0; letter-spacing: -.5px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 1px; color: #68738a;
       margin: 30px 0 12px; border-bottom: 1px solid #edf0f5; padding-bottom: 8px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .eyebrow { color: #4b63c3; font-size: 11px; font-weight: 800; letter-spacing: 1.5px; margin: 0 0 6px; }
  .badge { border-radius: 999px; padding: 6px 12px; font-size: 12px; font-weight: 800;
           text-transform: uppercase; }
  .badge.pass { background: #dff7e9; color: #12643d; }
  .badge.fail { background: #ffe2e5; color: #8f1e2b; }
  .badge.error { background: #fff1d6; color: #8a5a00; }
  .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 22px; }
  .meta .k { font-size: 10px; text-transform: uppercase; letter-spacing: .8px; color: #8792a8; font-weight: 700; }
  .meta .v { font-size: 14px; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #68738a;
       padding: 8px 10px; border-bottom: 1px solid #e8ebf2; }
  td { padding: 9px 10px; border-bottom: 1px solid #f0f3f8; vertical-align: top; }
  td.sp { width: 90px; font-size: 11px; font-weight: 800; text-transform: uppercase; color: #5b6dc1; }
  td.sp.caller { color: #8a5a00; }
  .result-badge { font-size: 11px; font-weight: 800; }
  .result-badge.ok { color: #16804e; }
  .result-badge.bad { color: #a83243; }
  pre { background: #111a2b; color: #d9e4ff; padding: 14px; border-radius: 9px;
        overflow: auto; font-size: 12px; }
  .note { color: #798398; font-size: 12px; margin-top: 26px; line-height: 1.5; }
  .error-box { background: #fff6df; color: #765414; border-radius: 8px; padding: 10px 12px;
               font-size: 13px; }
  @media print { body { background: white; padding: 0; } .sheet { border: 0; box-shadow: none; } }
"""


def _report_html(row: "TestRun", result: dict) -> str:
    esc = html.escape
    status = row.status
    usage = result.get("usage") or {}
    meta_items = [
        ("Run", f"#{row.id}"),
        ("Scenario", row.scenario_name),
        ("Mode", str(result.get("mode") or "mock")),
        ("Model", str(result.get("model") or "-")),
        ("Created", row.created_at.strftime("%Y-%m-%d %H:%M UTC")),
        ("Duration", f"{result['duration_ms'] / 1000:.1f}s" if isinstance(result.get("duration_ms"), int) else "-"),
        ("Turns", str(result.get("turns") if result.get("turns") is not None else len(result.get("conversation") or []))),
        ("Tokens", str(usage.get("total")) if usage.get("total") else "-"),
    ]
    meta_html = "\n".join(
        f"<div><div class='k'>{esc(key)}</div><div class='v'>{esc(value)}</div></div>"
        for key, value in meta_items
    )

    conversation_rows = "\n".join(
        f"<tr><td class='sp {esc(str(line.get('speaker')))}'>{esc(str(line.get('speaker')))}</td>"
        f"<td>{esc(str(line.get('text')))}</td></tr>"
        for line in (result.get("conversation") or [])
    ) or "<tr><td colspan='2'>No conversation recorded.</td></tr>"

    assertion_rows = "\n".join(
        f"<tr><td>{esc(str(a.get('name')))}</td>"
        f"<td>{esc(str(a.get('expected')))}</td><td>{esc(str(a.get('actual')))}</td>"
        f"<td class='result-badge {'ok' if a.get('passed') else 'bad'}'>"
        f"{'PASS' if a.get('passed') else 'FAIL'}</td></tr>"
        for a in (result.get("assertions") or [])
    ) or "<tr><td colspan='4'>No assertions ran.</td></tr>"

    extra_sections = ""
    if result.get("slots"):
        extra_sections += f"<h2>Extracted slots</h2><pre>{esc(json.dumps(result['slots'], indent=2))}</pre>"
    if result.get("expected"):
        extra_sections += f"<h2>Expected (persona)</h2><pre>{esc(json.dumps(result['expected'], indent=2))}</pre>"
    if result.get("booking"):
        extra_sections += f"<h2>Booking</h2><pre>{esc(json.dumps(result['booking'], indent=2))}</pre>"

    error_html = ""
    if result.get("error"):
        error_html = f"<h2>Error</h2><div class='error-box'>{esc(str(result['error']))}</div>"

    note = str(result.get("note") or "")

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Voicebot Test Report - Run #{row.id}</title>
<style>{_REPORT_CSS}</style>
</head>
<body>
<div class="sheet">
  <div class="top">
    <div>
      <p class="eyebrow">VOICEBOT TESTING REPORT</p>
      <h1>Run #{row.id} - {esc(row.scenario_name)}</h1>
    </div>
    <span class="badge {esc(status)}">{esc(status)}</span>
  </div>
  <div class="meta">{meta_html}</div>
  {error_html}
  <h2>Conversation</h2>
  <table><thead><tr><th>Speaker</th><th>Utterance</th></tr></thead><tbody>{conversation_rows}</tbody></table>
  <h2>Assertions</h2>
  <table><thead><tr><th>Assertion</th><th>Expected</th><th>Actual</th><th>Result</th></tr></thead><tbody>{assertion_rows}</tbody></table>
  {extra_sections}
  <p class="note">{esc(note)}<br/>
  Generated by Voicebot Testing on {esc(datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC'))}.
  Use your browser's print dialog to save this report as PDF.</p>
</div>
</body>
</html>"""


# --- Call recordings (Asterisk MixMonitor) -------------------------------------

_RECORDING_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.wav$")


def _recordings_dir() -> Optional[Path]:
    candidate = Path(os.getenv("RECORDINGS_DIR", "/recordings"))
    return candidate if candidate.is_dir() else None


def _recording_path(name: str) -> Optional[Path]:
    directory = _recordings_dir()
    if not directory or not _RECORDING_NAME.match(name):
        return None
    path = directory / name
    return path if path.is_file() else None


@app.get("/api/recordings")
def list_recordings():
    directory = _recordings_dir()
    if not directory:
        return {"available": False, "recordings": []}
    entries = []
    for path in directory.glob("*.wav"):
        try:
            stat = path.stat()
        except OSError:
            continue  # unreadable (e.g. permission race mid-write)
        entries.append((stat.st_mtime, stat.st_size, path.name))
    entries.sort(reverse=True)
    recordings = [
        {
            "name": name,
            "size_bytes": size,
            "created_at": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
        }
        for mtime, size, name in entries[:50]
    ]
    return {"available": True, "recordings": recordings}


@app.get("/api/recordings/{name}")
def get_recording(name: str, download: bool = False):
    path = _recording_path(name)
    if not path:
        raise HTTPException(status_code=404, detail="Recording not found")
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=name,
        content_disposition_type="attachment" if download else "inline",
    )


@app.get("/api/recordings/{name}/live")
def stream_recording(name: str):
    """Stream a recording while the call is still running (growing file)."""
    path = _recording_path(name)
    if not path:
        raise HTTPException(status_code=404, detail="Recording not found")

    def generate():
        stable = 0
        last_size = -1
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(65536)
                if chunk:
                    stable = 0
                    yield chunk
                    continue
                size = path.stat().st_size if path.exists() else 0
                if size == last_size:
                    stable += 1
                else:
                    last_size = size
                    stable = 0
                if stable >= 8:  # ~4s without growth: the call has ended
                    break
                sleep(0.5)

    return StreamingResponse(generate(), media_type="audio/wav")


# --- Asterisk realtime status (ARI proxy) ---------------------------------------

@app.get("/api/asterisk/status")
def asterisk_status():
    base = os.getenv("ASTERISK_ARI_URL", "http://asterisk:8080/ari").rstrip("/")
    user = os.getenv("ASTERISK_ARI_USER", "voicebot")
    password = os.getenv("ASTERISK_ARI_PASSWORD", "change-this-ari-password")
    auth = (user, password)
    try:
        channels_response = httpx.get(f"{base}/channels", auth=auth, timeout=5.0)
        if channels_response.status_code >= 400:
            return {
                "connected": False,
                "error": f"ARI returned {channels_response.status_code}",
            }
        channels = [
            {
                "id": c.get("id"),
                "name": c.get("name"),
                "state": c.get("state"),
                "created_at": c.get("creationtime"),
            }
            for c in channels_response.json()
        ]
        version = None
        try:
            info = httpx.get(f"{base}/asterisk/info", auth=auth, timeout=5.0)
            if info.status_code < 400:
                version = info.json().get("build", {}).get("version")
        except (httpx.HTTPError, ValueError, KeyError):
            pass
        return {"connected": True, "version": version, "channels": channels}
    except httpx.HTTPError as exc:
        return {"connected": False, "error": str(exc)}
