# Voicebot Testing Starter

A local starter for the voicebot testing webapp:
- React + Vite frontend
- FastAPI backend
- PostgreSQL via Docker Compose
- Bundled Asterisk PBX (SIP/WebRTC over WebSocket) for the browser softphone
- Mock appointment-booking scenario that works without a PBX or AI API
- **AI test runs** where an OpenRouter model simulates the caller
- Scenario definitions as YAML files with declarative assertions

> **New here?** Follow the step-by-step [SETUP.md](SETUP.md) guide — it covers
> installation, verification, the UI tour, listening/monitoring, reports and
> troubleshooting.

## Important scope

The appointment scenario has two test modes:

- **mock** — fully deterministic, no PBX or AI API required.
- **ai** — an LLM (OpenRouter) plays the caller, a deterministic bot asks the
  questions, LLM NLU extraction fills the slots, and the scenario's assertions
  are evaluated on the final state.

This starter still does **not** implement the ARI ExternalMedia/RTP audio
bridge, so live call audio is never connected to the AI. The SIP softphone
registers and places real calls through the bundled Asterisk, but the media
path stops in the dialplan (6000/7000/7001). See the roadmap below.

## Requirements

- Docker Engine and Docker Compose plugin
- (optional) an OpenRouter API key for AI test runs — https://openrouter.ai/keys
- Or, for non-container development: Python 3.11+ and Node.js 20+

## Quick start (works on any machine)

```bash
docker compose up -d --build
docker compose ps
```

That one command starts PostgreSQL, the API, the frontend and Asterisk.
No `.env` file is required to boot — every setting has a working default.
`.env` is only needed to add your OpenRouter key (and to change passwords).

Open:
- Frontend: http://localhost:5173
- API docs: http://localhost:8000/docs
- Health: http://localhost:8000/api/health

Then try, in order:

1. **Test Runs** → **Run mock test** — validates the deterministic
   workflow and shows conversation, assertions and booking data.
2. **Softphone** (optional) — pre-filled for the bundled
   Asterisk (`ws://localhost:8080/ws`, extension `1001`). Click **Register**,
   then **Call bot** and dial `7000` (greeting), `6000` (echo) or `7001`
   (future ARI app). Watch the call in the **Live Monitor** and listen to the
   recording afterwards.
3. **AI test** (optional) — add your OpenRouter key as described below, then
   click **Run AI test** — progress streams live into the page and the
   **Live Monitor**.
4. **Reports** — open a printable HTML report (print → Save as PDF) or
   download JSON/CSV.

Stop the stack:

```bash
docker compose down
```

To remove the local database volume as well (destructive):

```bash
docker compose down -v
```

## Configure OpenRouter (AI test runs)

1. Copy the environment file and paste your key:

   ```bash
   cp .env.example .env
   # edit .env:
   OPENROUTER_API_KEY=sk-or-v1-...
   OPENROUTER_MODEL=openai/gpt-4o-mini
   ```

2. Recreate the API container:

   ```bash
   docker compose up -d api
   ```

3. `GET /api/health` now reports `"mode": "mock+ai"` and
   `"ai": {"configured": true, "model": "..."}`. The key itself is never
   exposed through the API. `.env` is git-ignored — keep the key there, not in
   code or compose.yaml.

If the key is missing or invalid the API stays usable: mock runs work, AI runs
return `503` (not configured) or are recorded with status `error`.

### What an AI run does

1. OpenRouter generates a hidden caller persona that requests the scenario's
   mock slot (name, reason, speaking style are invented each run).
2. The deterministic bot greets the caller and asks for each missing required
   field, re-asking at most twice.
3. Every caller utterance goes through LLM NLU extraction into structured
   slots (`customer_name`, `appointment_date`, `appointment_time`, `reason`,
   `intent`).
4. Availability + booking use the same mock store as the REST API.
5. The scenario's assertion rules are evaluated and the run (persona
   expectations, transcript, extracted slots, assertions) is stored in history.

No SIP call or audio is involved — this tests dialogue/NLU logic, not media.

## Bundled Asterisk

The `asterisk` service (image `andrius/asterisk:23`) is configured for local
testing; config lives in `asterisk/conf/` and is rendered at container start
by `asterisk/entrypoint.sh`.

| What | Value |
| --- | --- |
| SIP over plain WebSocket | `ws://localhost:8080/ws` (zero-config default) |
| SIP over TLS WebSocket | `wss://localhost:8089/ws` |
| Test extensions | `1001` / `voicebot-1001`, `1002` / `voicebot-1002` |
| Destination `6000` | echo test (verifies the audio path end to end) |
| Destination `7000` | answers, plays a greeting, hangs up (mock voicebot) |
| Destination `7001` | `Stasis(voicebot)` — reserved for the future ARI media worker |
| RTP range | `10000-10100/udp` |
| ARI | enabled, user `voicebot`, password `change-this-ari-password` |

Notes:

- A self-signed certificate for `wss://` is generated on first start and kept
  in the `asterisk-certs` volume. Browsers will not trust it automatically —
  `ws://` is the intended local default; import the cert or use mkcert if you
  need trusted WSS.
- All published ports bind to `127.0.0.1`. To test from a phone on your LAN,
  widen the port binds in compose.yaml and set
  `ASTERISK_EXTERNAL_MEDIA_ADDRESS=<your-host-LAN-IP>` in `.env`.
- Sanity check: `docker compose exec asterisk asterisk -rx "pjsip show endpoints"`.
- ARI is for the local media worker only — never expose it publicly.

## Test scenarios (YAML)

Scenarios in `scenarios/*.yaml` are loaded at runtime (mounted into the API
container at `/app/scenarios`; `SCENARIOS_DIR` overrides the location).

```yaml
name: Appointment booking
description: ...
version: 1
timezone: Asia/Kolkata
required_fields: [customer_name, appointment_date, appointment_time, reason]
mock_slot: {date: "2026-10-23", time: "11:00", available: true}
assertions:
  - intent equals book_appointment
  - all_required_fields_present
  - availability_checked
  - booking_status equals confirmed
```

Supported assertion forms: `field equals value` and bare truthy keys
(`availability_checked`). Both test modes evaluate the same rules, so adding a
YAML file is enough to define a new appointment variant.

## Useful API endpoints

- `GET /api/health` — includes `ai.configured` / `ai.model`
- `GET /api/scenarios` — scenario list from YAML
- `POST /api/test-runs` — body `{"mode": "mock" | "ai", "scenario_id": "appointment-booking", "run_key": "<client-uuid>"}`
  (empty body = mock, for backwards compatibility; `run_key` correlates SSE events)
- `GET /api/test-runs` — list recent runs
- `GET /api/test-runs/{run_id}` — details and assertions
- `GET /api/events` — Server-Sent Events: run lifecycle, turns, LLM calls
- `GET /api/reports/summary` — aggregate stats (pass rate, tokens, durations)
- `GET /api/reports/{run_id}?format=html|json|csv&download=` — generated report
- `GET /api/recordings` — call recordings (`?download=true`, `/live` streams while the call runs)
- `GET /api/asterisk/status` — ARI proxy: version + active channels
- `POST /api/appointments/check-availability`
- `POST /api/appointments/book`

## Run without Docker

Backend:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Frontend in a second terminal:

```bash
cd frontend
npm install
npm run dev -- --host 127.0.0.1
```

Without Docker, the backend uses SQLite by default and reads `scenarios/` from
the repository root. To use PostgreSQL, set `DATABASE_URL` in your shell.
OpenRouter variables work the same way (`export OPENROUTER_API_KEY=...`).

## Optional external PBX setup

The SIP panel is not tied to the bundled Asterisk — point it at any PBX:
- WSS URL, for example `wss://pbx.example.test:8089/ws`
- SIP domain, extension, password, destination

Requirements on that PBX: HTTPS/WSS with a browser-trusted certificate,
PJSIP/WebRTC endpoint, dial plan for your destination, firewall and RTP path.

## UI smoke test (optional)

`frontend/cdp-ui-test.mjs` drives the real UI in headless Chrome: runs both test
tools, registers the softphone to the bundled Asterisk, places and ends a call.
Start Chrome with `--remote-debugging-port=9222` (plus fake media flags) and run
`node frontend/cdp-ui-test.mjs` from `frontend/`.

## Roadmap — missing features that are still required

Analysis of what this starter intentionally does not do yet, most important
first:

1. **ARI media worker (call audio ↔ AI)** — the largest gap. Needs a worker
   that answers Stasis app `voicebot`, bridges the channel's RTP
   (ExternalMedia or a media pipeline), and runs ASR → OpenRouter → TTS. The
   Asterisk side is ready (`ari.conf`, dialplan `7001`); an STT/TTS provider
   decision is also required.
2. **Softphone audio to the AI** — the browser SIP panel places real calls but
   its audio never reaches the AI worker (same as #1).
3. **More scenarios** — negative flows (cancellation, unavailable slot),
   multilingual callers, adversarial callers; currently one happy-path YAML.
4. **Authentication** — the API is unauthenticated, single-user local only.
5. **Reporting/CI** — runs are capped at the last 50; no JSON/JUnit export or
   scheduler for regression runs.
6. **Observability & cost** — per-run token usage/cost from OpenRouter is not
   recorded; no call recording/consent tooling.
7. **Production hardening** — see below.

Done in this pass: bundled Asterisk in compose, OpenRouter adapter (`.env`),
AI caller-simulation test runs, scenario YAML loading, health status for AI.

## Security before production

- Replace all sample credentials (Postgres, ARI, SIP test extensions) and configure HTTPS.
- Do not expose Asterisk ARI or the API publicly.
- Use per-user SIP credentials and restricted dial permissions.
- Add real authentication/authorization before multi-user use.
- Store AI API keys in a secret manager, not in frontend variables.
- Add recording consent, data retention, log redaction, backups, and load testing.
