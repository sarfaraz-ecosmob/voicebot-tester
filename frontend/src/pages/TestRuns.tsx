import { useEffect, useState } from "react";
import {
  API,
  Health,
  Run,
  Scenario,
  apiGet,
  fmtDate,
  fmtDuration,
  newRunKey,
  reportUrl,
} from "../api";
import { AppEvent, useEventEffect } from "../useEvents";
import { Card, Icons, Pill, Spinner } from "../components/ui";

type BusyMode = "mock" | "ai" | null;

type Progress = {
  runKey: string;
  mode: "mock" | "ai";
  turns: { speaker: string; text: string }[];
  notes: string[];
  slots: Record<string, string> | null;
};

function noteLine(event: AppEvent): string | null {
  switch (event.type) {
    case "run_start":
      return `Run started (${event.mode})`;
    case "persona":
      return `Persona ready — style "${event.style}"`;
    case "llm":
      return `LLM ${event.purpose} · ${event.model} · ${event.ms} ms${
        event.tokens?.total ? ` · ${event.tokens.total} tok` : ""
      }${event.status === "error" ? ` · ERROR: ${event.detail}` : ""}`;
    case "step":
      return event.name === "availability"
        ? `Availability check — ${event.available ? "slot free" : "slot taken"}`
        : `Booking — ${event.status}`;
    case "assertions":
      return `Assertions — ${event.passed ? "all passed" : "failures present"} (${event.count})`;
    default:
      return null;
  }
}

export default function TestRuns() {
  const [busy, setBusy] = useState<BusyMode>(null);
  const [current, setCurrent] = useState<Run | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [h, scenarios] = await Promise.all([
          apiGet<Health>("/api/health"),
          apiGet<Scenario[]>("/api/scenarios"),
        ]);
        setHealth(h);
        setScenario(scenarios.find((s) => s.id === "appointment-booking") ?? scenarios[0] ?? null);
        setScenarios(scenarios);
        setScenarioId(scenarios[0]?.id ?? null);
      } catch {
        /* dashboard shows API errors */
      }
    })();
  }, []);

  // Live progress: events are correlated to this run via run_key.
  useEventEffect((event) => {
    if (!event.run_key) return;
    setProgress((prev) => {
      if (!prev || prev.runKey !== event.run_key) return prev;
      if (event.type === "turn") {
        return {
          ...prev,
          turns: [...prev.turns, { speaker: String(event.speaker), text: String(event.text) }],
        };
      }
      if (event.type === "slots") {
        return { ...prev, slots: (event.slots as Record<string, string>) ?? prev.slots };
      }
      const note = noteLine(event);
      return note ? { ...prev, notes: [...prev.notes.slice(-40), note] } : prev;
    });
  });

  async function runTest(mode: Exclude<BusyMode, null>) {
    const runKey = newRunKey();
    setBusy(mode);
    setCurrent(null);
    setProgress({ runKey, mode, turns: [], notes: [], slots: null });
    try {
      const response = await fetch(`${API}/api/test-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, scenario_id: scenarioId, run_key: runKey }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Test failed");
      setCurrent(data);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Unable to run test");
    } finally {
      setProgress(null);
      setBusy(null);
    }
  }

  const aiReady = !!health?.ai.configured;
  const result = current?.result;
  const usage = result?.usage;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Test Runs</h1>
          <p className="muted">
            {scenario
              ? `${scenario.name} — collects ${scenario.required_fields.join(", ")} and validates the mock slot.`
              : "Deterministic mock runs and LLM-simulated caller runs."}
          </p>
          <select
          className="select-card" 
          value={scenarioId ?? "appointment-booking"}
          onChange={(e) => setScenarioId(e.target.value)}
          >
            <option disabled>{scenarioId ?? "Select a scenario..."}</option>
            {scenarios.map((sc) => (
              <option key={sc.id} value={sc.id}>
                {sc.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mode-grid">
        <Card title="Mock test" subtitle="Deterministic — no PBX or AI key required. Validates the workflow fixture.">
          <button className="btn primary" onClick={() => runTest("mock")} disabled={busy !== null}>
            {busy === "mock" ? <><Spinner /> Running...</> : <>{Icons.runs} Run mock test</>}
          </button>
        </Card>
        <Card
          title="AI test"
          subtitle="An OpenRouter model simulates the caller; NLU extraction fills slots; assertions are evaluated."
        >
          <p className="muted small">
            {aiReady ? (
              <>AI caller ready via OpenRouter (<span className="mono">{health?.ai.model}</span>).</>
            ) : (
              "AI caller off: set OPENROUTER_API_KEY in .env, then docker compose up -d api."
            )}
          </p>
          <button className="btn primary" onClick={() => runTest("ai")} disabled={busy !== null || !aiReady}>
            {busy === "ai" ? <><Spinner /> Running AI test...</> : <>{Icons.spark} Run AI test</>}
          </button>
        </Card>
      </div>

      {progress && (
        <Card className="live-card" title="Live progress" subtitle="Streaming from the backend over SSE">
          <div className="live-grid">
            <div className="chat">
              {progress.turns.length === 0 && <p className="muted small">Waiting for the first turn…</p>}
              {progress.turns.map((line, i) => (
                <div className={`bubble ${line.speaker}`} key={i}>
                  <span>{line.speaker}</span>
                  <p>{line.text}</p>
                </div>
              ))}
            </div>
            <div className="notes mono">
              {progress.notes.length === 0 && <p className="muted small">Backend steps will appear here…</p>}
              {progress.notes.map((note, i) => (
                <div className="note-line" key={i}>{note}</div>
              ))}
              {progress.slots && (
                <div className="note-line slots-line">slots → {JSON.stringify(progress.slots)}</div>
              )}
            </div>
          </div>
        </Card>
      )}

      {current && result && (
        <div className="result card">
          <div className="resultTop">
            <strong>
              Run #{current.id} <span className="muted small">· {fmtDate(current.created_at)}</span>
            </strong>
            <div className="result-badges">
              {result.model && <span className="tag">{result.model}</span>}
              {result.duration_ms !== undefined && <span className="tag">{fmtDuration(result.duration_ms)}</span>}
              {usage?.total ? <span className="tag">{usage.total} tokens</span> : null}
              <Pill status={current.status} />
            </div>
          </div>
          <p>{result.note}</p>
          {result.error && <p className="banner error">Error: {result.error}</p>}

          <h3>Conversation</h3>
          <div>
            {result.conversation?.map((line: any, i: number) => (
              <div className="utterance" key={i}>
                <span>{line.speaker}</span>
                <p>{line.text}</p>
              </div>
            ))}
          </div>

          <h3>Assertions</h3>
          <div>
            {result.assertions?.length ? (
              result.assertions.map((a: any) => (
                <div className="assertion" key={a.name}>
                  <span>{a.passed ? "PASS" : "FAIL"}</span> {a.name}
                  {a.expected !== true && (
                    <em className="muted small"> — expected {String(a.expected)}, got {String(a.actual)}</em>
                  )}
                </div>
              ))
            ) : (
              <p className="muted small">No assertions ran.</p>
            )}
          </div>

          {result.mode === "ai" && (
            <>
              <h3>Extracted slots</h3>
              <pre>{JSON.stringify(result.slots, null, 2)}</pre>
              <h3>Expected (persona)</h3>
              <pre>{JSON.stringify(result.expected, null, 2)}</pre>
            </>
          )}

          <h3>Booking</h3>
          <pre>{JSON.stringify(result.booking, null, 2)}</pre>

          <div className="actions">
            <a className="btn ghost" href={reportUrl(current.id, "html")} target="_blank" rel="noreferrer">
              {Icons.reports} View report
            </a>
            <a className="btn ghost" href={reportUrl(current.id, "json", true)}>{Icons.download} JSON</a>
            <a className="btn ghost" href={reportUrl(current.id, "csv", true)}>{Icons.download} CSV</a>
          </div>
        </div>
      )}

      {!current && !progress && (
        <Card>
          <p className="muted">
            No run selected yet. Start a mock test for a fast deterministic check, or an AI test to exercise the
            OpenRouter caller simulation. Live progress streams into this page while a run is active.
          </p>
        </Card>
      )}
    </>
  );
}
