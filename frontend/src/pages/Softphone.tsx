import { useState } from "react";
import { Inviter, Registerer, UserAgent } from "sip.js";
import { Card, Icons } from "../components/ui";

type SipConfig = {
  ws: string;
  domain: string;
  astUrl: string;
  astUser: string;
  astPassword: string;
  extension: string;
  password: string;
  destination: string;
  mediaAddress: string;
  destinationLabel: string;
};

export default function Softphone({ go }: { go: (s: string) => void }) {
  const [sipStatus, setSipStatus] = useState("Not configured");
  const [sipConfig, setSipConfig] = useState<SipConfig>({
    ws: "ws://localhost:8080/ws",
  domain: "localhost",
  astUrl: "http://localhost:8080/ari",
  astUser: "voicebot",
  astPassword: "voicebot-1001",
  extension: "1001",
  password: "voicebot-1001",
  destination: "7000",
  mediaAddress: "127.0.0.1",
  destinationLabel: "7000",
});
  const [ua, setUa] = useState<UserAgent | null>(null);
  const [registerer, setRegisterer] = useState<Registerer | null>(null);
  const [session, setSession] = useState<Inviter | null>(null);

  function updateSip(field: keyof SipConfig, value: string) {
    setSipConfig((prev) => ({ ...prev, [field]: value }));
  }

  async function connectSip() {
    try {
      setSipStatus("Connecting...");
      const uri = UserAgent.makeURI(`sip:${sipConfig.extension}@${sipConfig.domain}`);
      if (!uri) throw new Error("Invalid SIP URI");
      const agent = new UserAgent({
        uri,
        authorizationUsername: sipConfig.extension,
        authorizationPassword: sipConfig.password,
        transportOptions: { server: sipConfig.ws },
        delegate: {
          onConnect: () => setSipStatus("WebSocket connected"),
          onDisconnect: () => setSipStatus("Disconnected"),
        },
      });
      const reg = new Registerer(agent);
      await agent.start();
      await reg.register();
      setUa(agent);
      setRegisterer(reg);
      setSipStatus("Registered");
    } catch (e) {
      setSipStatus(`Registration failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  async function callBot() {
    if (!ua) {
      setSipStatus("Register first");
      return;
    }
    try {
      const target = UserAgent.makeURI(`sip:${sipConfig.destination}@${sipConfig.domain}`);
      if (!target) throw new Error("Invalid destination URI");
      const inviter = new Inviter(ua, target);
      inviter.stateChange.addListener((state) => {
        setSipStatus(`Call state: ${state}`);
        if (state === "Terminated") setSession(null);
      });
      setSession(inviter);
      await inviter.invite();
    } catch (e) {
      setSipStatus(`Call failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  async function hangup() {
    if (!session) return;
    try {
      if (session.state === "Established") await session.bye();
      else if (session.state === "Initial") await session.cancel();
      else await session.dispose();
    } catch {
      /* call may already have ended */
    }
    setSession(null);
  }

  async function disconnectSip() {
    try {
      if (session) await hangup();
      await registerer?.unregister();
      await ua?.stop();
    } finally {
      setRegisterer(null);
      setUa(null);
      setSipStatus("Disconnected");
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Softphone</h1>
          <p className="muted">Browser SIP/WebRTC client for the bundled Asterisk.</p>
        </div>
      </div>

      <div className="softphone-grid">
        <Card
          title="Registration"
          subtitle="Pre-filled for the bundled Asterisk — click Register, then call a destination"
        >
          <label className="field">
            WebSocket URL
            <input value={sipConfig.ws} onChange={(e) => updateSip("ws", e.target.value)} />
          </label>
          <label className="field">
            SIP domain
            <input value={sipConfig.domain} onChange={(e) => updateSip("domain", e.target.value)} />
          </label>
          <div className="two">
            <label className="field">
              Extension
              <input value={sipConfig.extension} onChange={(e) => updateSip("extension", e.target.value)} />
            </label>
            <label className="field">
              Password
              <input
                type="password"
                autoComplete="new-password"
                value={sipConfig.password}
                onChange={(e) => updateSip("password", e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            Destination extension
            <input value={sipConfig.destination} onChange={(e) => updateSip("destination", e.target.value)} />
          </label>
          <label className="field">
            ARI URL
            <input value={sipConfig.astUrl} onChange={(e) => updateSip("astUrl", e.target.value)} />
          </label>
          <label className="field">
            ARI User
            <input value={sipConfig.astUser} onChange={(e) => updateSip("astUser", e.target.value)} />
          </label>
          <label className="field">
            ARI Password
            <input
              type="password"
              autoComplete="new-password"
              value={sipConfig.astPassword}
              onChange={(e) => updateSip("astPassword", e.target.value)}
            />
          </label>
          <label className="field">
            Media address
            <input value={sipConfig.mediaAddress} onChange={(e) => updateSip("mediaAddress", e.target.value)} />
          </label>
          <div className="actions">
            <button className="btn primary" onClick={connectSip}>Register</button>
            <button className="btn ghost" onClick={callBot} disabled={!ua || !!session}>Call bot</button>
            <button className="btn danger" onClick={hangup} disabled={!session}>Hang up</button>
            <button className="btn ghost" onClick={disconnectSip}>Disconnect</button>
          </div>
          <p className="sip-status">{sipStatus}</p>
          <p className="muted small">
            Uses ws://localhost:8080 out of the box (works from http://localhost). For wss://:8089 the container
            generates a self-signed certificate that your browser must trust. Use a dedicated test extension, never
            administrator credentials. Microphone access requires a secure context such as localhost or HTTPS.
          </p>
          <p className="muted small">
            Asterisk ARI: <span className="mono">{astUrl}</span> | User: {astUser}
          </p>
          <p className="muted small">
            External media address: <span className="moni">{mediaAddress}</span>
          </p>
        </Card>

        <Card title="Destinations" subtitle="Dialplan of the bundled Asterisk">
          <div className="dest-list">
            <div className="dest">
              <span className="mono dest-num">6000</span>
              <div>
                <strong>Echo test</strong>
                <p className="muted small">Hear yourself back — proves the full audio path.</p>
              </div>
            </div>
            <div className="dest">
              <span className="mono dest-num">7000</span>
              <div>
                <strong>Mock voicebot</strong>
                <p className="muted small">Answers, plays the greeting chime, hangs up. Recorded.</p>
              </div>
            </div>
            <div className="dest">
              <span className="mono dest-num">7001</span>
              <div>
                <strong>Future ARI app</strong>
                <p className="muted small">Stasis(voicebot) — reserved for the media worker.</p>
              </div>
            </div>
          </div>
          <p className="muted small">
            Calls are recorded by Asterisk — open the <button className="link" onClick={() => go("monitor")}>Live
            Monitor</button> to listen while a call is running.
          </p>
        </Card>
      </div>
    </>
  );
}
