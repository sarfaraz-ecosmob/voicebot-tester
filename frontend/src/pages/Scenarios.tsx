import { useEffect, useState } from "react";
import { Scenario, apiGet } from "../api";
import { Card, EmptyState, Icons, Spinner } from "../components/ui";

export default function Scenarios() {
  const [scenarios, setScenarios] = useState<Scenario[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setScenarios(await apiGet<Scenario[]>("/api/scenarios"));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unable to load scenarios");
      }
    })();
  }, []);

  if (error) return <div className="banner error">{error}</div>;
  if (!scenarios)
    return (
      <div className="page-head">
        <div>
          <h1>Scenarios</h1>
          <p className="muted"><Spinner /> Loading…</p>
        </div>
      </div>
    );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Scenarios</h1>
          <p className="muted">
            Loaded at runtime from <span className="mono">scenarios/*.yaml</span> — edit a file to change a test.
          </p>
        </div>
      </div>

      {scenarios.length === 0 ? (
        <Card>
          <EmptyState icon={Icons.scenarios} title="No scenarios found" text="Add a YAML file to the scenarios/ directory." />
        </Card>
      ) : (
        <div className="scenario-grid">
          {scenarios.map((scenario) => (
            <Card key={scenario.id} title={scenario.name} subtitle={scenario.description || undefined}>
              <p className="muted small">
                <span className="tag">{scenario.id}</span>
                {scenario.timezone && <> · timezone {scenario.timezone}</>}
                {scenario.version !== undefined && <> · v{scenario.version}</>}
              </p>
              <h3>Required fields</h3>
              <div className="chips">
                {scenario.required_fields.map((field) => (
                  <span className="chip" key={field}>{field}</span>
                ))}
              </div>
              <h3>Mock slot</h3>
              <p className="mono small">
                {scenario.mock_slot?.date} {scenario.mock_slot?.time} ·{" "}
                {scenario.mock_slot?.available ? "available" : "unavailable"}
              </p>
              <h3>Assertions</h3>
              <ul className="assertion-list">
                {scenario.assertions.map((rule) => (
                  <li key={rule}><span className="mono small">{rule}</span></li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
