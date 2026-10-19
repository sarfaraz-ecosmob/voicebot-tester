import { useEffect, useRef, useState } from "react";
import { API, AsteriskStatus, Recording, apiGet, fmtBytes, fmtDate } from "../api";
import { AppEvent, useEventEffect, useEventLog, useSseState } from "../useEvents";
import { Card, Dot, EmptyState, Icons } from "../components/ui";

type ActiveRun = {
  key: string;
  turns: { speaker: string; text: string }[];
  slots: Record<string, string> | null;
  status?: string;
};

function logLine(event: AppEvent): { tag: string; text: string } | null {
  switch (event.type) {
    case "hello":
      return { tag: "sys", text: "event stream connected" };
    case "run_start":
      return { tag: "run", text: `run started — ${event.mode}${event.scenario ? ` · ${event.scenario}` : ""}` };
    case "persona":
      return { tag: "ai", text: `persona ready — style "${event.style}"` };
    case "llm":
      return {
        tag: event.status === "error" ? "err" : "ai",
        text: `llm ${event.purpose} · ${event.model} · ${event.ms} ms${
          event.tokens?.total ? ` · ${event.tokens.total} tok` : ""
        }${event.status === "error" ? ` · ${event.detail}` : ""}`,
      };
    case "turn":
      return { tag: "turn", text: `${event.speaker}: ${String(event.text).slice(0, 90)}` };
    case "slots":
      return { tag: "nlu", text: `nlu → ${JSON.stringify(event.slots)}` };
    case "step":
      return {
        tag: "step",
        text:
          event.name === "availability"
            ? `availability — ${event.available ? "slot free" : "slot taken"}`
            : `booking — ${event.status}`,
      };
    case "assertions":
      return { tag: "check", text: `assertions — ${event.passed ? "all passed" : "failures"} (${event.count})` };
    case "run_end":
      return { tag: "run", text: `run #${event.id} ${event.status} · ${event.duration_ms} ms` };
    default:
      return null;
  }
}

function speak(text: string, speaker: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.pitch = speaker === "bot" ? 1.0 : 1.18;
  window.speechSynthesis.speak(utterance);
}

export default function LiveMonitor() {
  const events = useEventLog(160);
  const sseState = useSseState();
  const [tts, setTts] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [asterisk, setAsterisk] = useState<AsteriskStatus | null>(null);
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [liveName, setLiveName] = useState<string | null>(null);

  const ttsRef = useRef(tts);
  ttsRef.current = tts;
  const activeRef = useRef<ActiveRun | null>(null);
  activeRef.current = activeRun;

  useEventEffect((event) => {
    if (event.type === "run_start") {
      setActiveRun({ key: event.run_key ?? "", turns: [], slots: null });
      return;
    }
    if (event.type === "turn") {
      if (ttsRef.current) speak(String(event.text), String(event.speaker));
      const key = event.run_key ?? "";
      if (!activeRef.current || (key && key === activeRef.current.key)) {
        setActiveRun((prev) =>
          prev ? { ...prev, turns: [...prev.turns, { speaker: String(event.speaker), text: String(event.text) }] } : prev,
        );
      }
      return;
    }
    if (event.type === "slots" && activeRef.current && event.run_key === activeRef.current.key) {
      setActiveRun((prev) => (prev ? { ...prev, slots: (event.slots as Record<string, string>) ?? null } : prev));
      return;
    }
    if (event.type === "run_end" && activeRef.current && event.run_key === activeRef.current.key) {
      setActiveRun((prev) => (prev ? { ...prev, status: String(event.status) } : prev));
    }
  });

  // Poll Asterisk state + recordings while this page is open.
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const [a, r] = await Promise.all([
          apiGet<AsteriskStatus>("/api/asterisk/status"),
          apiGet<{ available: boolean; recordings: Recording[] }>("/api/recordings"),
        ]);
        if (!mounted) return;
        setAsterisk(a);
        setRecordings(r.available ? r.recordings : []);
      } catch {
        /* transient */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events, autoScroll]);

  function stopNarration() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setTts(false);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Live Monitor</h1>
          <p className="muted">Backend activity in realtime — every turn, extraction and LLM call as it happens.</p>
        </div>
        <div className="page-head-side">
          <span className={`sse-pill ${sseState === "connected" ? "on" : ""}`}>
            <Dot tone={sseState === "connected" ? "good" : sseState === "connecting" ? "warn" : "off"} />
            events: {sseState}
          </span>
        </div>
      </div>

      <div className="monitor-grid">
        <Card
          className="monitor-log-card"
          title="Backend activity"
          subtitle="SSE /api/events"
          actions={
            <>
              <label className="switch">
                <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
                auto-scroll
              </label>
            </>
          }
        >
          <div className="logs" ref={logRef}>
            {events.length === 0 && <p className="muted small">Waiting for events — start a test run…</p>}
            {events.map((event, i) => {
              const line = logLine(event);
              if (!line) return null;
              return (
                <div className={`log-line ${line.tag}`} key={i}>
                  <span className="log-time">
                    {new Date(event.ts * 1000).toLocaleTimeString()}
                  </span>
                  <span className="log-tag">{line.tag}</span>
                  <span className="log-text">{line.text}</span>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="monitor-side">
          <Card title="Live conversation" subtitle={activeRun?.status ? `run status: ${activeRun.status}` : "latest run"}>
            {!activeRun && <EmptyState icon={Icons.wave} title="Idle" text="Start a mock or AI test to watch it live." />}
            {activeRun && (
              <div className="chat compact">
                {activeRun.turns.length === 0 && <p className="muted small">Greeting…</p>}
                {activeRun.turns.map((line, i) => (
                  <div className={`bubble ${line.speaker}`} key={i}>
                    <span>{line.speaker}</span>
                    <p>{line.text}</p>
                  </div>
                ))}
                {activeRun.slots && <div className="slots-chip mono">{JSON.stringify(activeRun.slots)}</div>}
              </div>
            )}
          </Card>

          <Card title="Listen" subtitle="Narrate runs with TTS · play call recordings">
            <div className="listen-row">
              <label className="switch">
                <input type="checkbox" checked={tts} onChange={(e) => (e.target.checked ? setTts(true) : stopNarration())} />
                {Icons.volume} speak the conversation aloud
              </label>
              <p className="muted small">
                Uses your browser's speech synthesis to read every bot/caller line as the AI test runs.
              </p>
            </div>
            <div className="listen-row">
              <p className="muted small">
                SIP calls to 6000/7000 are recorded by Asterisk (MixMonitor). Place a call from the Softphone page,
                then listen here — "Listen live" streams the file while the call is still running.
              </p>
              {!recordings || recordings.length === 0 ? (
                <p className="muted small">No recordings yet.</p>
              ) : (
                recordings.map((rec) => (
                  <div className="recording" key={rec.name}>
                    <div className="recording-meta">
                      <span className="mono small">{rec.name}</span>
                      <span className="muted small">
                        {fmtBytes(rec.size_bytes)} · {fmtDate(rec.created_at)}
                      </span>
                    </div>
                    <audio
                      controls
                      className="audio"
                      src={`${API}/api/recordings/${rec.name}${liveName === rec.name ? "/live" : ""}`}
                    />
                    <div className="row-actions">
                      <button
                        className="btn tiny ghost"
                        onClick={() => setLiveName(liveName === rec.name ? null : rec.name)}
                      >
                        {liveName === rec.name ? "Stop live" : "Listen live"}
                      </button>
                      <a className="btn tiny ghost" href={`${API}/api/recordings/${rec.name}?download=true`}>
                        {Icons.download}
                      </a>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card title="Asterisk" subtitle="ARI channels, polled every 4s">
            <p className="sys-line">
              <Dot tone={asterisk?.connected ? "good" : "off"} />
              {asterisk?.connected
                ? `online · ${asterisk.version || "23.x"}`
                : `unreachable${asterisk?.error ? ` — ${asterisk.error}` : ""}`}
            </p>
            {(asterisk?.channels?.length ?? 0) === 0 ? (
              <p className="muted small">No active channels.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Channel</th><th>State</th></tr>
                  </thead>
                  <tbody>
                    {asterisk?.channels?.map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.name}</td>
                        <td><span className="tag">{c.state}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
