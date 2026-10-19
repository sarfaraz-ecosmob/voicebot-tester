// End-to-end UI test: drives the real frontend in headless Chrome.
// Usage: node cdp-ui-test.mjs  (Chrome must run with --remote-debugging-port=9222
// and the stack must be up).
const DEBUG = "http://localhost:9222";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTarget(url) {
  const res = await fetch(`${DEBUG}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return res.json();
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function waitFor(fn, what, timeoutMs = 30000, stepMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* keep polling */
    }
    await sleep(stepMs);
  }
  throw new Error(`Timeout waiting for: ${what}`);
}

const bodyText = (c) => c.evaluate("document.body.innerText");
const clickButton = (c, label) =>
  c.evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
       if (!b) return false; b.click(); return true; })()`
  );
const clickNav = (c, id) =>
  c.evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find(x => x.dataset.nav === ${JSON.stringify(id)});
       if (!b) return false; b.click(); return true; })()`
  );

const results = [];
const record = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? " — " + info : ""}`);
};

const target = await newTarget("http://localhost:5173");
const c = await connect(target.webSocketDebuggerUrl);
await c.send("Page.enable");
// Desktop viewport: the sidebar footer (status lines) is hidden in the
// mobile layout (<=980px), and headless Chrome defaults to 800x600.
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(800);

// 1. Dashboard shell loads: sidebar + API/AI status in the side footer.
const health = await waitFor(
  async () => {
    const t = await bodyText(c);
    return t.includes("API: ok") ? t : null;
  },
  "API status in sidebar",
  60000  // vite dev server may cold-compile on first load after a rebuild
);
record("sidebar + API health", health.includes("ok (mock+ai mode)"), health.match(/API: [^\n]*/)?.[0]);
record("AI status visible", health.includes("AI caller ready via OpenRouter"), "sidebar footer");

// 2. Test Runs: mock run through the UI.
if (!(await clickNav(c, "runs"))) throw new Error("nav Test Runs not found");
await waitFor(async () => (await bodyText(c)).includes("Run mock test"), "Test Runs page");
await clickButton(c, "Run mock test");
const mockPill = await waitFor(
  async () => c.evaluate("document.querySelector('.result .pill')?.textContent ?? null"),
  "mock run result pill",
  20000
);
record("UI mock test passes", String(mockPill).toLowerCase() === "passed", `pill=${mockPill}`);

// 3. AI run through the UI (real OpenRouter).
if (!(await clickButton(c, "Run AI test"))) throw new Error("Run AI test button not found");
const aiStart = Date.now();
// NOTE: h3 headings are uppercased by CSS, and innerText reflects
// text-transform — compare textContent instead.
await waitFor(
  async () =>
    c.evaluate(`(() => {
      const hasSlots = [...document.querySelectorAll('.result h3')].some(h => h.textContent.trim() === 'Extracted slots');
      const busy = [...document.querySelectorAll('button')].some(b => b.textContent.includes('Running AI test'));
      return hasSlots && !busy;
    })()`),
  "AI run result",
  120000
);
const aiSeconds = ((Date.now() - aiStart) / 1000).toFixed(1);
const aiPill = await c.evaluate("document.querySelector('.result .pill')?.textContent ?? null");
record("UI AI test passes", String(aiPill).toLowerCase() === "passed", `${aiSeconds}s, pill=${aiPill}`);
const aiRich = await c.evaluate(`(() => {
  const heads = [...document.querySelectorAll('.result h3')].map(h => h.textContent.trim());
  return heads.includes('Extracted slots') && heads.includes('Assertions') &&
    [...document.querySelectorAll('.result .tag')].some(t => t.textContent.includes('tokens'));
})()`);
record("AI result shows slots + assertions + usage", aiRich === true, "");

// 4. Live Monitor: SSE connected.
if (!(await clickNav(c, "monitor"))) throw new Error("nav Live Monitor not found");
await waitFor(async () => (await bodyText(c)).includes("events: "), "Live Monitor page");
const monitorText = await waitFor(
  async () => {
    const t = await bodyText(c);
    return t.includes("events: connected") ? t : null;
  },
  "SSE connected pill",
  15000
);
record("Live Monitor SSE connected", monitorText.includes("events: connected"), "sidebar + monitor");

// 5. Softphone: register, call 7000, hang up (creates a MixMonitor recording).
if (!(await clickNav(c, "softphone"))) throw new Error("nav Softphone not found");
await waitFor(async () => (await bodyText(c)).includes("Register"), "Softphone page");
if (!(await clickButton(c, "Register"))) throw new Error("Register button not found");
const regText = await waitFor(
  async () => {
    const t = await bodyText(c);
    return t.includes("Registered") || t.includes("Registration failed") ? t : null;
  },
  "SIP registration outcome",
  20000
);
record("SIP registration", regText.includes("Registered"), (regText.match(/Registration failed[^\n]*/) || ["Registered"])[0]);

let called = false;
if (regText.includes("Registered")) {
  await clickButton(c, "Call bot");
  const callText = await waitFor(
    async () => {
      const t = await bodyText(c);
      return /Call state: (Established|Terminated|Failed)/.test(t) ? t : null;
    },
    "call state",
    25000
  );
  const state = callText.match(/Call state: (\w+)/)?.[1] ?? "?";
  record("SIP call reaches Established", state === "Established", `state=${state}`);
  called = state === "Established";
  if (state === "Established") await sleep(3500);
  await clickButton(c, "Hang up");
  await waitFor(async () => (await bodyText(c)).includes("Terminated"), "hangup", 15000).catch(() => null);
  record("SIP hang up", true, "Terminated");
}

// 6. Recording appears in the Live Monitor (MixMonitor -> shared volume -> API).
if (called) {
  await sleep(3000);
  if (!(await clickNav(c, "monitor"))) throw new Error("nav Live Monitor not found");
  // Wait specifically for the file name; "No recordings yet" must NOT count
  // (the monitor polls the API every 4s, so the list starts empty).
  const recText = await waitFor(
    async () => {
      const t = await bodyText(c);
      return t.includes(".wav") ? t : null;
    },
    "recordings list",
    25000
  ).catch(() => null);
  record("call recording listed", !!recText, recText ? "wav present" : "no recording found in 25s");
}

// 7. Reports page: table + actions.
if (!(await clickNav(c, "reports"))) throw new Error("nav Reports not found");
await waitFor(async () => (await bodyText(c)).includes("All test runs"), "Reports page");
const reportRows = await waitFor(
  async () => {
    const n = await c.evaluate("document.querySelectorAll('.table-wrap tbody tr').length");
    return n >= 3 ? n : null;
  },
  "reports table rows",
  15000
);
record("Reports table lists runs", reportRows >= 3, `${reportRows} rows`);

// 8. Dashboard history table.
if (!(await clickNav(c, "dashboard"))) throw new Error("nav Dashboard not found");
await waitFor(async () => (await bodyText(c)).includes("Recent test runs"), "Dashboard");
const runRows = await waitFor(
  async () => {
    const n = await c.evaluate("document.querySelectorAll('.history tbody tr').length");
    return n >= 3 ? n : null;
  },
  "history rows",
  15000
);
record("dashboard history lists runs", runRows >= 3, `${runRows} rows`);

c.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
