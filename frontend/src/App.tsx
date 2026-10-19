import { useEffect, useState } from "react";
import { Health, apiGet } from "./api";
import { useSseState } from "./useEvents";
import { Dot, Icons } from "./components/ui";
import Dashboard from "./pages/Dashboard";
import TestRuns from "./pages/TestRuns";
import Reports from "./pages/Reports";
import LiveMonitor from "./pages/LiveMonitor";
import Softphone from "./pages/Softphone";
import Scenarios from "./pages/Scenarios";
import Settings from "./pages/Settings";

const NAV = [
  { id: "dashboard", label: "Dashboard", icon: Icons.dashboard },
  { id: "runs", label: "Test Runs", icon: Icons.runs },
  { id: "reports", label: "Reports", icon: Icons.reports },
  { id: "monitor", label: "Live Monitor", icon: Icons.monitor },
  { id: "softphone", label: "Softphone", icon: Icons.phone },
  { id: "scenarios", label: "Scenarios", icon: Icons.scenarios },
  { id: "settings", label: "Settings", icon: Icons.settings },
] as const;

type SectionId = (typeof NAV)[number]["id"];

export default function App() {
  const [section, setSection] = useState<SectionId>("dashboard");
  const [health, setHealth] = useState<Health | null>(null);
  const sse = useSseState();

  useEffect(() => {
    const load = () => void apiGet<Health>("/api/health").then(setHealth).catch(() => setHealth(null));
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  const healthText = health ? `${health.status} (${health.mode} mode)` : "unreachable";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">{Icons.mic}</div>
          <div>
            <div className="brand-name">Voicebot Testing</div>
            <div className="brand-sub">QA workbench</div>
          </div>
        </div>

        <nav className="nav">
          <p className="nav-label">Menu</p>
          {NAV.map((item) => (
            <button
              key={item.id}
              data-nav={item.id}
              className={`nav-item ${section === item.id ? "active" : ""}`}
              onClick={() => setSection(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="side-foot">
          <div className="side-line">
            <Dot tone={health ? "good" : "bad"} /> API: {healthText}
          </div>
          <div className="side-line side-ai">
            <Dot tone={health?.ai.configured ? "good" : "warn"} />
            {health?.ai.configured ? (
              <>
                AI caller ready via OpenRouter (<span className="mono">{health.ai.model}</span>)
              </>
            ) : (
              "AI caller off: set OPENROUTER_API_KEY in .env, then docker compose up -d api."
            )}
          </div>
          <div className="side-line">
            <Dot tone={sse === "connected" ? "good" : sse === "connecting" ? "warn" : "off"} />
            Live events: {sse}
          </div>
        </div>
      </aside>

      <main className="main">
        {section === "dashboard" && <Dashboard go={(s) => setSection(s as SectionId)} />}
        {section === "runs" && <TestRuns />}
        {section === "reports" && <Reports />}
        {section === "monitor" && <LiveMonitor />}
        {section === "softphone" && <Softphone go={(s) => setSection(s as SectionId)} />}
        {section === "scenarios" && <Scenarios />}
        {section === "settings" && <Settings />}
      </main>
    </div>
  );
}
