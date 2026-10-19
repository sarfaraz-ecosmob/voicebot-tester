import { useCallback, useEffect, useState } from "react";
import { Run, Summary, apiGet, fmtDate, fmtDuration, reportUrl } from "../api";
import { Card, EmptyState, Icons, Pill, Spinner, Stat } from "../components/ui";

export default function Reports() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        apiGet<Summary>("/api/reports/summary"),
        apiGet<Run[]>("/api/test-runs"),
      ]);
      setSummary(s);
      setRuns(r);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load reports");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const passRate =
    summary?.pass_rate !== null && summary?.pass_rate !== undefined
      ? `${Math.round(summary.pass_rate * 100)}%`
      : "-";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="muted">
            Generated per-run reports — open the printable HTML (use your browser's print dialog to save as PDF),
            or download JSON / CSV.
          </p>
        </div>
        <button className="btn ghost" onClick={() => void load()}>{Icons.refresh} Refresh</button>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="stats-grid">
        <Stat label="Runs" value={loading ? <Spinner /> : summary?.total ?? 0} icon={Icons.reports} />
        <Stat
          label="Passed"
          value={loading ? <Spinner /> : summary?.by_status?.passed ?? 0}
          hint={`${summary?.by_status?.failed ?? 0} failed · ${summary?.by_status?.error ?? 0} error`}
          icon={Icons.check}
        />
        <Stat label="Pass rate" value={loading ? <Spinner /> : passRate} icon={Icons.monitor} />
        <Stat
          label="AI tokens"
          value={loading ? <Spinner /> : summary?.tokens.total ?? 0}
          hint={`${summary?.tokens.prompt ?? 0} in / ${summary?.tokens.completion ?? 0} out`}
          icon={Icons.spark}
        />
      </div>

      <Card title="All test runs" subtitle="Newest first">
        {runs.length === 0 ? (
          <EmptyState icon={Icons.reports} title="No reports yet" text="Run a test to generate the first report." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th><th>Scenario</th><th>Mode</th><th>Status</th><th>Duration</th>
                  <th>Tokens</th><th>Recording</th><th>Created</th><th>Report</th>
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
                    <td>{run.result?.usage?.total ?? "-"}</td>
                    <td>
                      {run.result?.recording?.has_recordings ? (
                        <div className="recording-col">
                          <a className="btn tiny ghost" href={"/api/recordings/" + run.result.recording.latest_name}>{Icons.download}</a>
                        </div>
                      ) : (
                        <span className="muted small">None</span>
                      )}
                    </td>
                    <td className="muted">{fmtDate(run.created_at)}</td>
                    <td className="row-actions">
                      <a className="btn tiny ghost" href={reportUrl(run.id, "html")} target="_blank" rel="noreferrer">
                        View
                      </a>
                      <a className="btn tiny ghost" href={reportUrl(run.id, "json", true)}>JSON</a>
                      <a className="btn tiny ghost" href={reportUrl(run.id, "csv", true)}>CSV</a>
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
