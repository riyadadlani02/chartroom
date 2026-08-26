/* Records the demo straight out of headless Chrome over the DevTools protocol.
 *
 * No Puppeteer, no Playwright: Node 22+ ships a WebSocket client, and CDP is
 * just JSON over a socket. Writes frames/ plus a cues.json of the wall-clock
 * offset of every narration beat, which tools/narrate.sh then lines up against.
 *
 *   node tools/record.mjs http://127.0.0.1:8078/ out/
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:8078/";
const OUT = process.argv[3] || "out";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1600, H = 900, PORT = 9333;
const FRAME_MS = 80;                       // ~12fps is plenty for a UI demo

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── CDP ─────────────────────────────────────────────────────────────── */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        for (const h of this.handlers) h(m);
      }
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.handlers.push(fn); }
}

/* ── run ─────────────────────────────────────────────────────────────── */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "frames"), { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--window-size=${W},${H}`,
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--mute-audio",
  "--no-first-run",
  "--user-data-dir=/tmp/chartroom-record-profile",
], { stdio: "ignore" });

let version;
for (let i = 0; i < 40 && !version; i++) {
  await sleep(250);
  version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
}
if (!version) throw new Error("Chrome never opened a debugging port");

const cdp = await CDP.open(version.webSocketDebuggerUrl);
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
const call = (m, p) => cdp.send(m, p, sessionId);

await call("Page.enable");
await call("Runtime.enable");

const evaluate = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + expression);
  return r.result?.value;
};

await call("Page.navigate", { url: URL_ });
await new Promise((res) => cdp.on((m) => m.method === "Page.loadEventFired" && res()));
await evaluate("document.fonts.ready.then(() => 1)");
await sleep(1200);                          // let the boot meter fill

/* frames */
const frames = [];
let last = 0;
cdp.on((m) => {
  if (m.method !== "Page.screencastFrame") return;
  cdp.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, sessionId);
  const now = Date.now();
  if (now - last < FRAME_MS) return;
  last = now;
  const name = `f${String(frames.length).padStart(5, "0")}.jpg`;
  writeFileSync(join(OUT, "frames", name), Buffer.from(m.params.data, "base64"));
  frames.push({ name, t: now });
});

const cues = {};
const t0 = Date.now();
const cue = (name) => { cues[name] = (Date.now() - t0) / 1000; };

await call("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: W, maxHeight: H });

/* ── the beats ───────────────────────────────────────────────────────── */
cue("intro");                                        // boot card holds
await sleep(6500);
await evaluate("document.getElementById('boot').click(); 1");
cue("standby");
await sleep(7000);

await evaluate("document.querySelector('#roll').click(); 1");
cue("roll");
await sleep(14000);
cue("board");                                        // codes appearing, 99214 earns green
await sleep(8000);

// The consultation reaches the tingling turn at t=45, which at 2x is 22.5s in.
await sleep(1500);
cue("gap");
await sleep(11000);
cue("closing");
await sleep(2000);
cue("closed");                                       // t=69 -> 34.5s
await sleep(7000);
cue("ckd");                                          // t=82 -> 41s
await sleep(14000);
cue("uncaptured");                                   // t=123 -> 61.5s
await sleep(9000);
cue("ended");                                        // t=136 -> 68s
await sleep(4000);

// Evidence chain: light E11.40's spans in the transcript.
await evaluate(`document.querySelector('.code[data-code="E11.40"]').click(); 1`);
cue("evidence");
await sleep(9000);

// Close a gap by hand.
await evaluate("document.querySelector('#sayIt').click(); 1");
cue("sayit");
await sleep(8000);

await evaluate(`
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;z-index:99;display:grid;place-items:center;text-align:center;background:rgba(6,4,2,.93);animation:fadein .6s ease-out';
  d.innerHTML = \`<div>
    <div style="font-family:VT323,monospace;font-size:74px;color:#f0b429;letter-spacing:.1em;text-shadow:0 0 26px rgba(240,180,41,.5)">CHARTROOM</div>
    <div style="font-size:15px;letter-spacing:.22em;text-transform:uppercase;color:#93805f;margin-top:6px">The coding desk, live in the room</div>
    <div style="margin-top:34px;font-size:19px;color:#f6e7c8;line-height:1.7">
      Built on the Corti API<br><span style="color:#93805f;font-size:14px">speech to text &nbsp;·&nbsp; fact extraction &nbsp;·&nbsp; coding &nbsp;·&nbsp; models</span>
    </div>
    <div style="margin-top:34px;font-family:ui-monospace,monospace;font-size:17px;color:#4ee39a">riyadadlani02.github.io/chartroom</div>
  </div>\`;
  document.head.insertAdjacentHTML('beforeend','<style>@keyframes fadein{from{opacity:0}}</style>');
  document.body.appendChild(d); 1`);
cue("outro");
await sleep(7000);

await call("Page.stopScreencast");
await sleep(400);

/* ── manifest ────────────────────────────────────────────────────────── */
const list = frames.map((f, i) => {
  const dur = ((frames[i + 1]?.t ?? f.t + FRAME_MS) - f.t) / 1000;
  return `file 'frames/${f.name}'\nduration ${dur.toFixed(4)}`;
}).join("\n");
writeFileSync(join(OUT, "frames.txt"), `${list}\nfile 'frames/${frames.at(-1).name}'\n`);
writeFileSync(join(OUT, "cues.json"), JSON.stringify(cues, null, 2));

console.log(`${frames.length} frames over ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(cues, null, 2));
chrome.kill();
process.exit(0);
