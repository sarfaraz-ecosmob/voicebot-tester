import { useEffect, useState } from "react";
import { API, Health, apiGet } from "../api";
import { Card, Dot } from "../components/ui";

const ENV_ROWS: { name: string; where: string; purpose: string }[] = [
  { name: "OPENROUTER_API_KEY", where: ".env", purpose: "Enables AI test runs. Leave empty for mock-only mode." },
  { name: "OPENROUTER_MODEL", where: ".env", purpose: "Model id (default openai/gpt-4o-mini)." },
  { name: "OPENROUTER_SITE_URL / OPENROUTER_APP_NAME", where: ".env", purpose: "Optional OpenRouter attribution headers." },
  { name: "ASTERISK_EXTERNAL_MEDIA_ADDRESS", where: ".env", purpose: "SDP address for RTP (LAN softphones)." },
  { name: "ASTERISK_ARI_USER / ASTERISK_ARI_PASSWORD", where: ".env", purpose: "ARI credentials used by the status proxy." },
  { name: "ASTERISK_WS_URL", where: ".env", purpose: "Asterisk WebSocket URL for remote connections" },
  { name: "POSTGRES_PASSWORD / DATABASE_URL", where: ".env", purpose: "Database credentials for the api." },
  { name: "VITE_API_BASE_URL", where: ".env", purpose: "API origin the frontend calls (browser-side)." },
];

const API_ROWS: { method: string; path: string; purpose: string }[] = [
  { method: "GET", path: "/api/health", purpose: "Status incl. AI configuration" },
  { method: "GET", path: "/api/scenarios", purpose: "Scenarios loaded from YAML" },
  { method: "POST", path: "/api/test-runs", purpose: "Run a test ({mode, scenario_id, run_key})" },
  { method: "GET", path: "/api/test-runs", purpose: "Recent runs" },
  { method: "GET", path: "/api/events", purpose: "SSE stream of run/LLM events" },
  { method: "GET", path: "/api/reports/summary", purpose: "Aggregate statistics" },
  { method: "GET", path: "/api/reports/{id}", purpose: "Report: html | json | csv" },
  { method: "GET", path: "/api/recordings", purpose: "Call recordings (MixMonitor)" },
  { method: "GET", path: "/api/asterisk/status", purpose: "ARI proxy: channels + version" },
  { method: "GET", path: "/api/asterisk/ari-config", purpose: "Retrieve ARI config from localStorage" },
];

export default function Settings() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    void apiGet<Health>("/api/health").then(setHealth).catch(() => setHealth(null));
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Runtime configuration reference — changes are made in .env on disk.</p>
        </div>
      </div>

      <Card title="System" subtitle="Live values reported by the API">
        <div className="kv-grid">
          <div className="kv"><span className="k">API status</span><span className="v"><Dot tone={health ? "good" : "off"} /> {health ? `${health.status} · ${health.mode}` : "unreachable"}</span></div>
          <div className="kv"><span className="k">API version</span><span className="v mono">{health?.version ?? "-"}</span></div>
          <div className="kv"><span className="k">AI configured</span><span className="v">{health?.ai.configured ? "yes" : "no"}</span></div>
          <div className="kv"><span className="k">AI model</span><span className="v mono">{health?.ai.model ?? "-"}</span></div>
          <div className="kv"><span className="k">API base (browser)</span><span className="v mono">{API}</span></div>
          <div className="kv"><span className="k">Interactive docs</span><span className="v"><a href={`${API}/docs`} target="_blank" rel="noreferrer">{API}/docs</a></span></div>
        </div>
      </Card>

      <Card title="Environment variables" subtitle="Defined in .env (git-ignored); applied via compose">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Variable</th><th>Where</th><th>Purpose</th></tr></thead>
            <tbody>
              {ENV_ROWS.map((row) => (
                <tr key={row.name}>
                  <td className="mono">{row.name}</td>
                  <td><span className="tag">{row.where}</span></td>
                  <td className="muted">{row.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="API reference" subtitle="Also available interactively at /docs">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
            <tbody>
              {API_ROWS.map((row) => (
                <tr key={row.path}>
                  <td><span className="tag">{row.method}</span></td>
                  <td className="mono">{row.path}</td>
                  <td className="muted">{row.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
