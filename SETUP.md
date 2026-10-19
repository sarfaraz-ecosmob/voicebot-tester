# Voicebot Testing — Setup & Configuration Guide

Step-by-step instructions from a fresh machine to a fully working installation,
including verification steps so you know each stage succeeded.

## What you get

| Service | URL / endpoint | Purpose |
| --- | --- | --- |
| Frontend | http://localhost:5173 | Web UI (Dashboard, Test Runs, Reports, Live Monitor, Softphone) |
| API | http://localhost:8000 | FastAPI backend, docs at http://localhost:8000/docs |
| Asterisk | ws://localhost:8080/ws | Local PBX for the browser softphone (WSS on :8089) |
| PostgreSQL | localhost:5432 (not published) | Test-run history |

```
browser ──HTTP──▶ frontend(5173) ──HTTP/SSE──▶ api(8000) ──▶ postgres
   │                                          │  ▲
   │ SIP/WebRTC (ws)                          │  └── recordings volume
   └──────────────────────────────────▶ asterisk(8080/8089/RTP)
                                              │
                                     OpenRouter API (AI runs)
```

## Prerequisites

- Docker Engine + Docker Compose plugin (Docker Desktop is fine on Mac/Windows)
- (Optional) an OpenRouter API key — https://openrouter.ai/keys
- No Python/Node required for the containerized setup

---

## Step 1 — Configure the environment file (optional)

Everything boots with safe defaults; `.env` is only needed to enable AI runs
and change credentials.

```bash
cp .env.example .env
```

Minimum to enable AI test runs — paste your key:

```
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=openai/gpt-4o-mini
```

`.env` is git-ignored. Never commit keys.

## Step 2 — Start everything

```bash
docker compose up -d --build
```

First run downloads images and builds the API + frontend (a few minutes).
Then check the status:

```bash
docker compose ps
```

Expected — all Up, `postgres` and `asterisk` become `(healthy)` within ~30s:

```
SERVICE    STATUS
api        Up ...
asterisk   Up ... (healthy)
frontend   Up ...
postgres   Up ... (healthy)
```

If `asterisk` restarts repeatedly, see Troubleshooting below.

## Step 3 — Verify the installation

```bash
curl http://localhost:8000/api/health
```

Expected:

```json
{"status":"ok","mode":"mock","version":"0.3.0","ai":{"configured":false,"model":null}}
```

- `"mode":"mock"` = no AI key yet; `"mock+ai"` = key configured.
- Scenarios: `curl http://localhost:8000/api/scenarios`
- Asterisk: `docker compose exec asterisk asterisk -rx "pjsip show endpoints"`
  should list extensions `1001` and `1002`.

## Step 4 — Run your first test

1. Open http://localhost:5173 — the **Dashboard** shows system health and stats.
2. Go to **Test Runs** → **Run mock test**. Result appears in seconds with the
   conversation, assertions and booking data.
3. (With a key) **Run AI test** — watch the run stream live, then inspect the
   extracted slots vs the persona's expected values.

## Step 5 — Enable AI runs with OpenRouter (optional)

1. Put the key in `.env` (Step 1) and recreate the API container:

   ```bash
   docker compose up -d api
   ```

2. Re-check: `curl http://localhost:8000/api/health` → `"mode":"mock+ai"`.
3. The sidebar shows **AI caller ready via OpenRouter (openai/gpt-4o-mini)**.

How an AI run works: OpenRouter generates a hidden caller persona → a
deterministic bot asks for each missing field → LLM NLU extraction fills the
slots → the mock store checks availability and books → scenario assertions
are evaluated. Token usage and duration are stored per run.

## Step 6 — Softphone (SIP over WebSocket)

1. Open the **Softphone** page — fields are pre-filled for the bundled Asterisk.
2. Click **Register** → status shows `Registered`.
3. Dial a destination via **Call bot**:

| Destination | What happens |
| --- | --- |
| `6000` | Echo test — you hear yourself (proves the audio path) |
| `7000` | Mock voicebot — answers, plays a greeting chime, hangs up; **recorded** |
| `7001` | Stasis(voicebot) — reserved for the future ARI media worker |

Allow microphone access when prompted (required on localhost/HTTPS).

## Step 7 — Listen & monitor in realtime

Open the **Live Monitor** page:

- **Backend activity** — the SSE event stream (`/api/events`): every run start,
  persona, bot/caller turn, NLU extraction, LLM call (model, latency, tokens),
  booking step and assertion verdict, as it happens.
- **Speak the conversation aloud** — opt-in TTS narration of AI runs using the
  browser's speech synthesis.
- **Recordings** — SIP calls to 6000/7000/7001 are recorded by Asterisk
  (MixMonitor). Play them inline, download them, or use **Listen live** to
  stream the file while the call is still running.
- **Asterisk card** — live channel list polled from ARI every 4 seconds.

## Step 8 — Reports

- **Reports** page: aggregate stats (pass rate, tokens, durations) plus every
  run with three actions:
  - **View** — a self-contained printable HTML report (use the browser's
    print dialog → *Save as PDF* for a PDF version)
  - **JSON** — full structured run data
  - **CSV** — conversation transcript (turn, speaker, text)
- Direct API access: `http://localhost:8000/api/reports/1?format=html|json|csv`
  (add `&download=true` to force a download).

---

## Configuration reference

### Environment variables (.env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | *(empty)* | Enables AI runs |
| `OPENROUTER_MODEL` | `openai/gpt-4o-mini` | Model used for persona/caller/NLU |
| `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME` | *(empty)* | OpenRouter attribution |
| `ASTERISK_EXTERNAL_MEDIA_ADDRESS` | `127.0.0.1` | SDP address for RTP; set host LAN IP for remote softphones |
| `ASTERISK_ARI_USER` / `ASTERISK_ARI_PASSWORD` | `voicebot` / `change-this-ari-password` | ARI credentials for the status proxy |
| `POSTGRES_DB/USER/PASSWORD` | `voicebot` | Database (change beyond local dev) |
| `DATABASE_URL` | compose default | API database URL |
| `VITE_API_BASE_URL` | `http://localhost:8000` | API origin used by the browser |

### Ports (all bound to 127.0.0.1)

| Port | Service |
| --- | --- |
| 5173 | Frontend |
| 8000 | API (+ `/docs`, `/api/events` SSE) |
| 8080 | Asterisk HTTP + ws:// WebSocket SIP |
| 8089 | Asterisk HTTPS + wss:// WebSocket SIP |
| 5060 udp/tcp | SIP (for external softphones on your LAN) |
| 10000-10100 udp | RTP media |

### Repository layout

```
compose.yaml            all four services
.env / .env.example     local configuration (key lives in .env only)
backend/app/            FastAPI: main, ai (OpenRouter), ai_test engine,
                        events (SSE bus), scenarios (YAML loader), bookings
frontend/src/           React UI: App (sidebar shell), pages/*, useEvents (SSE)
asterisk/conf/          pjsip, http, rtp, extensions (dialplan), ari configs
asterisk/entrypoint.sh  renders configs + TLS cert at container start
scenarios/*.yaml        test scenarios + assertions (hot-mounted)
```

## Day-2 operations

```bash
docker compose logs -f api          # API logs
docker compose logs -f asterisk     # PBX logs
docker compose up -d api            # apply .env changes to the API
docker compose restart asterisk     # re-render Asterisk configs
docker compose down                 # stop (keeps data)
docker compose down -v              # stop and wipe all data (destructive)
```

**After editing frontend or backend source code**, the containers copy code at
build time — recreate them: `docker compose up -d --build api frontend`.
Scenario YAML changes apply instantly (mounted live).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `asterisk` restart-loops | config error in `asterisk/conf/` | `docker compose logs asterisk` for the failing file/option |
| `Run AI test` returns 503 | key missing | set `OPENROUTER_API_KEY` in `.env`, `docker compose up -d api` |
| AI run recorded as `error` | bad key / no credits / provider outage | check the error text in the result and `docker compose logs api` |
| SIP registration fails | wrong credentials/URL | use `ws://localhost:8080/ws`, ext `1001` / `voicebot-1001`; check `pjsip show endpoints` |
| Call connects, no audio | RTP blocked or wrong media address | keep ports 10000-10100 open; set `ASTERISK_EXTERNAL_MEDIA_ADDRESS` for non-local clients |
| `wss://` rejected by browser | self-signed certificate not trusted | use `ws://localhost:8080/ws` locally, or import the cert / use mkcert |
| No recordings listed | volume not attached (old container) | `docker compose up -d asterisk` (restart does NOT apply config changes) |
| Frontend shows old UI after code change | code is baked into the image | `docker compose up -d --build frontend` |
| SSE shows "disconnected" | API down or proxy buffering | `docker compose ps`; check API logs |

## Security before production

See the "Security before production" section in [README.md](README.md#security-before-production).
Highlights: change every sample password, keep ports bound to localhost, never
expose ARI, add authentication, and store API keys in a secret manager.
