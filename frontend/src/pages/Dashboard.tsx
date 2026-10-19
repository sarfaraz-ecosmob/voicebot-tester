import { useCallback, useEffect, useState } from "react";
import {
  AsteriskStatus,
  Health,
  Run,
  Summary,
  apiGet,
  fmtDate,
  fmtDuration,
  reportUrl,
} from "../api";
import { Card, Dot, EmptyState, Icons, Pill, Spinner, Stat } from "../components/ui";

export default function Dashboard({ go }: { go: (s: string) => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [asterisk, setAsterisk] = useState<AsteriskStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, r, h, a] = await Promise.all([
        apiGet<Summary>("/api/reports/summary"),
        apiGet<Run[]>("/api/test-runs"),
        apiGet<Health>("/api/health"),
        apiGet<AsteriskStatus>("/api/asterisk/status"),
      ]);
      setSummary(s);
      setRuns(r.slice(0, 8));
      setHealth(h);
      setAsterisk(a);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [load]);

  const passRate =
    summary?.pass_rate !== null && summary?.pass_rate !== undefined
      ? `${Math.round(summary.pass_rate * 100)}%`
      : "-";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">System health, test statistics and recent activity.</p>
        </div>
        <button className="btn ghost" onClick={() => void load()}>
          {Icons.refresh} Refresh
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="stats-grid">
        <Stat label="Total runs" value={loading ? <Spinner /> : summary?.total ?? 0} hint="stored in history" icon={Icons.runs} />
        <Stat label="Pass rate" value={loading ? <Spinner /> : passRate} hint="assertions-based" icon={Icons.check} />
        <Stat label="Avg duration" value={loading ? <Spinner /> : fmtDuration(summary?.avg_duration_ms)} hint="per AI/mock run" icon={Icons.clock} />
        <Stat
          label="AI tokens"
          value={loading ? <Spinner /> : summary?.tokens.total ?? 0}
          hint={`${summary?.tokens.calls ?? 0} OpenRouter calls`}
          icon={Icons.spark}
        />
      </div>

      <div className="sys-grid">
        <Card title="API">
          <p className="sys-line"><Dot tone={health ? "good" : "off"} /> {health ? `ok · v${health.version} · ${health.mode} mode` : "unreachable"}</p>
        </Card>
        <Card title="AI (OpenRouter)">
          <p className="sys-line">
            <Dot tone={health?.ai.configured ? "good" : "warn"} />
            {health?.ai.configured ? `configured · ${health.ai.model}` : "not configured — set OPENROUTER_API_KEY"}
          </p>
        </Card>
        <Card title="Asterisk">
          <p className="sys-line">
            <Dot tone={asterisk?.connected ? "good" : "off"} />
            {asterisk?.connected
              ? `online · ${asterisk.version || "23.x"} · ${asterisk.channels?.length ?? 0} active channel(s)`
              : "unreachable"}
          </p>
        </Card>
      </div>

      <Card
        className="history"
        title="Recent test runs"
        subtitle="Latest runs across mock and AI modes"
        actions={
          <>
            <button className="btn ghost" onClick={() => go("reports")}>{Icons.reports} All reports</button>
            <button className="btn primary" onClick={() => go("runs")}>{Icons.runs} New test</button>
          </>
        }
      >
        {runs.length === 0 ? (
          <EmptyState icon={Icons.runs} title="No runs yet" text="Run your first mock or AI test from Test Runs." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th><th>Scenario</th><th>Mode</th><th>Status</th><th>Duration</th><th>Created</th><th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="mono">#{run.id}</td>
                    <td>{run.scenario_name}</td>
                    <td><span className="tag">{run.result?.mode || "mock"}</span></td>
                    <td><Pill status={run.status} /></td>
                    <td>{fmtDuration(run.result?.duration_ms)}</td>
                    <td className="muted">{fmtDate(run.created_at)}</td>
                    <td className="row-actions">
                      <a className="btn tiny ghost" href={reportUrl(run.id, "html")} target="_blank" rel="noreferrer">
                        Report
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
