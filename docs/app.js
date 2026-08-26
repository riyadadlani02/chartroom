/* CHARTROOM console. Renders three tubes off the gap engine.
 *
 * The engine runs here, in the browser, in both modes. Offline it needs
 * nothing but this folder — which is why the demo can live on a static host.
 * When the Python proxy is up, the same engine calls the real Corti API
 * through it.
 */

import { GapEngine, liveSource, offlineSource } from "./engine.js";
import { RULEPACK } from "./rulepack.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let script = null, engine = null, source = null;
let turns = [], board = { codes: [], gaps: [], facts: [], atRisk: 0, captured: 0 };
let selected = null;   // code whose evidence is lit in the transcript
let heroId = null;     // gap held in the centre tube
let log = [], speed = 2, sound = false, started = null, ac = null;
let runId = 0, ticking = false, dirty = false, mic = null;

/* ── boot ───────────────────────────────────────────────────────────── */
const boot = $("#boot");
const dismiss = () => {
  if (!boot || boot.classList.contains("gone")) return;
  sound = true;                       // the click is the gesture browsers require
  boot.classList.add("gone");
  setTimeout(() => boot.remove(), 320);
};
boot.addEventListener("click", dismiss);
boot.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && dismiss());
setTimeout(() => { const l = $("#bootline"); if (l) l.textContent = "Signal locked · click to begin"; }, 1500);

/* ── sound ──────────────────────────────────────────────────────────── */
function tone(freq, ms, type, at = 0, gain = 0.05) {
  if (!sound) return;
  // No audio device, a locked context, a private window: a blip that cannot
  // play must never take the analysis loop down with it.
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, ac.currentTime + at);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + at + ms / 1000);
    o.connect(g).connect(ac.destination);
    o.start(ac.currentTime + at); o.stop(ac.currentTime + at + ms / 1000);
  } catch {
    sound = false;
  }
}
const alarm = () => { tone(233, 110, "square"); tone(175, 150, "square", 0.13); };
const chime = () => { tone(523, 90, "sine"); tone(784, 200, "sine", 0.09, 0.04); };

/* ── the loop ───────────────────────────────────────────────────────── */
const transcript = () => turns.map((t) => t.text).join(" ");

async function addTurn(speaker, text, t = null) {
  const prev = transcript();
  turns.push({ speaker, text, t, at: prev.length + (prev ? 1 : 0) });
  drawTurns(true);
  await tick();
}

/** Coalesce: one analysis in flight, one queued behind it. */
async function tick() {
  if (ticking) { dirty = true; return; }
  ticking = true;
  try {
    do {
      dirty = false;
      const { state, events } = await engine.tick(transcript());
      board = state;
      events.forEach(event);
      draw();
    } while (dirty);
  } finally {
    ticking = false;
  }
}

function event(e) {
  if (e.type === "gap_opened") {
    const g = e.gap;
    alarm();
    const tube = $("#gapTube");
    tube.classList.remove("slip"); void tube.offsetWidth; tube.classList.add("slip");
    note(`<b>GAP ${g.code} ${g.gapType} ${g.label} ${money(g.dollars)}</b> ${esc(g.ask)}`);
  } else {
    chime();
    note(`<i>CLOSED ${e.code} ${e.label} — documented in the room</i>`);
    document.querySelectorAll(`.code[data-code="${e.code}"]`).forEach((n) => {
      n.classList.remove("flip"); void n.offsetWidth; n.classList.add("flip");
    });
  }
}

async function reset() {
  runId++;
  if (mic) { if (mic.state !== "inactive") mic.stop(); mic = null; }
  turns = []; log = []; selected = heroId = started = null;
  board = { codes: [], gaps: [], facts: [], atRisk: 0, captured: 0 };
  engine = new GapEngine(source);
  $("#onair").dataset.on = "0";
  drawTurns(); draw();
}

async function roll() {
  await reset();
  const run = ++runId;
  started = Date.now();
  $("#onair").dataset.on = "1";
  let clock = 0;
  for (const turn of script.turns) {
    await sleep(Math.max(0, ((turn.t - clock) / speed) * 1000));
    clock = turn.t;
    if (run !== runId) return;
    await addTurn(turn.speaker, turn.text, turn.t);
  }
  $("#onair").dataset.on = "0";
  note("Consultation ended. Anything still red left the room undocumented.");
}

/* ── transcript tube ────────────────────────────────────────────────── */
function drawTurns(follow) {
  const spans = selected ? selected.evidence || [] : [];
  $("#turns").innerHTML = turns.map((t) => {
    const local = spans
      .map((e) => [e.start - t.at, e.end - t.at])
      .filter(([s, e]) => e > 0 && s < t.text.length)
      .sort((a, b) => a[0] - b[0]);
    let html = "", cursor = 0;
    for (const [s, e] of local) {
      const a = Math.max(s, cursor), b = Math.min(e, t.text.length);
      if (b <= a) continue;
      html += esc(t.text.slice(cursor, a)) + "<mark>" + esc(t.text.slice(a, b)) + "</mark>";
      cursor = b;
    }
    html += esc(t.text.slice(cursor));
    const stamp = t.t == null ? "··:··"
      : `${String(Math.floor(t.t / 60)).padStart(2, "0")}:${String(Math.floor(t.t % 60)).padStart(2, "0")}`;
    return `<div class="turn${follow && t === turns.at(-1) ? " fresh" : ""}" data-who="${t.speaker}">
      <span class="tc">${stamp}</span><span class="who">${t.speaker === "patient" ? "PT" : "DR"}</span>
      <span class="said">${html}</span></div>`;
  }).join("");
  $("#turnCount").textContent = `${turns.length} turn${turns.length === 1 ? "" : "s"}`;
  const body = $("#turns").parentElement;
  const target = selected && $("#turns mark");
  if (target) {
    const r = target.getBoundingClientRect(), b = body.getBoundingClientRect();
    body.scrollTop += r.top - b.top - body.clientHeight / 2;
  } else if (follow) body.scrollTop = body.scrollHeight;
}

/* ── gap tube ───────────────────────────────────────────────────────── */
function drawGap() {
  const gaps = board.gaps;
  $("#gapCount").textContent = gaps.length ? `${gaps.length} open` : "nothing open";
  if (!gaps.length) {
    $("#gapBody").innerHTML = started
      ? `<div class="allclear"><div><div class="big">ALL CLEAR</div><p>Every code on the board defends itself</p></div></div>`
      : `<div class="allclear idle"><div><div class="big">STANDING BY</div><p>Roll the consultation to put the desk on air</p></div></div>`;
    return;
  }
  const hero = gaps.find((g) => g.id === heroId) || gaps[0];
  heroId = hero.id;
  const rest = gaps.filter((g) => g.id !== hero.id);
  $("#gapBody").innerHTML = `<div class="gapwrap">
    <div class="gap-meta">
      <span class="gap-type">${hero.gapType}</span>
      <span class="gap-code">${hero.code} · ${esc(hero.display)}</span>
      <span class="gap-money">${hero.dollars ? money(hero.dollars) : "AUDIT"}</span>
    </div>
    <div class="ask"><div>${esc(hero.ask)}<br><q>${esc(hero.closes)}</q></div></div>
    <div class="gap-foot">
      <button class="say" id="sayIt">Clinician says it &rarr;</button>
      <span class="gap-basis">${esc(hero.basis)}</span>
    </div>
    ${rest.length ? `<div class="queue"><span>Also open</span>${rest.map((g) =>
      `<button data-gap="${g.id}">${g.code} ${esc(g.label)}${g.dollars ? " · " + money(g.dollars) : ""}</button>`).join("")}</div>` : ""}
  </div>`;
  $("#sayIt").onclick = () => { started = started || Date.now(); addTurn("clinician", hero.closes); };
  $("#gapBody").querySelectorAll("[data-gap]").forEach((b) =>
    (b.onclick = () => { heroId = b.dataset.gap; drawGap(); }));
}

/* ── code board ─────────────────────────────────────────────────────── */
const LABEL = { defended: "defended", at_risk: "at risk", predicted: "corti" };

function drawCodes() {
  $("#codeCount").textContent = `${board.codes.length} code${board.codes.length === 1 ? "" : "s"}`;
  $("#codes").innerHTML = board.codes.map((c) => {
    const open = selected && selected.code === c.code;
    return `<button class="code" data-code="${c.code}" data-status="${c.status}" aria-expanded="${!!open}"
      aria-label="${c.code}, ${LABEL[c.status]}${c.dollars ? ", " + money(c.dollars) : ""}. ${esc(c.display)}">
      <span class="main">
        <span class="hdr"><span class="id">${c.code}</span><span class="sys">${c.system === "cpt" ? "CPT" : "ICD-10"}</span></span>
        <span class="disp">${esc(c.display)}</span>
        ${open ? detail(c) : ""}</span>
      <span class="st">${LABEL[c.status]}${c.dollars ? `<span class="amt">${money(c.dollars)}</span>` : ""}</span>
    </button>`;
  }).join("") || `<p class="empty">Nothing on the board yet. Corti predicts codes as the consultation gives it something to predict from.</p>`;
  $("#codes").querySelectorAll(".code").forEach((n) => (n.onclick = () => {
    selected = selected && selected.code === n.dataset.code ? null
      : board.codes.find((c) => c.code === n.dataset.code);
    drawCodes(); drawTurns(false);
  }));
}

function detail(c) {
  const met = c.met.map((m) => `<li>${esc(m.label)}</li>`).join("");
  const missing = board.gaps.filter((g) => g.code === c.code)
    .map((g) => `<li class="no">${esc(g.label)} — missing</li>`).join("");
  const down = c.downgrade && c.status === "at_risk"
    ? `<li class="no">Falls back to ${c.downgrade.code} — ${esc(c.downgrade.display)}</li>` : "";
  const n = c.evidence.length;
  return `<ul class="detail">${met}${missing}${down}
    <li style="color:var(--ink-dim)">${n} evidence span${n === 1 ? "" : "s"} lit in the transcript</li></ul>`;
}

function drawFacts() {
  $("#facts").innerHTML = board.facts.map((f) =>
    `<li><span class="g">${esc(f.group || "fact")}</span><span class="v">${esc(f.value || f.text || "")}</span></li>`).join("");
}

/* ── money ──────────────────────────────────────────────────────────── */
function tween(el, to) {
  const from = Number(el.dataset.v || 0);
  if (from === to) return;
  el.dataset.v = to;
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 500);
    el.textContent = money(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ── ticker ─────────────────────────────────────────────────────────── */
const clock = () => {
  if (!started) return "00:00";
  const s = Math.floor((Date.now() - started) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
function note(html) {
  log.unshift(`${clock()} ${html}`);
  $("#ticker").innerHTML = log.slice(0, 8).join(" &nbsp;·&nbsp; ") + " &nbsp;·&nbsp; ";
}
setInterval(() => ($("#clock").textContent = clock()), 1000);

function draw() {
  drawGap(); drawCodes(); drawFacts();
  tween($("#atRisk"), board.atRisk);
  tween($("#captured"), board.captured);
}

/* ── transport ──────────────────────────────────────────────────────── */
$("#roll").onclick = roll;
$("#reset").onclick = reset;
$("#speed").onclick = () => {
  speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
  $("#speed").textContent = `${speed}×`;
  $("#speed").setAttribute("aria-pressed", String(speed !== 1));
};

/** Live microphone. Needs the proxy, which holds the Corti credentials. */
$("#mic").onclick = async () => {
  await reset();
  started = Date.now();
  $("#onair").dataset.on = "1";
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/stream`);
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.type !== "transcript") return;
    for (const seg of m.data || []) {
      if (seg.final) addTurn(seg.speakerId === 0 ? "clinician" : "patient", seg.transcript, seg.time?.start);
    }
  };
  ws.onerror = () => note("Live stream failed. Check the server log.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  ws.onopen = () => {
    mic = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    mic.ondataavailable = (e) => e.data.size && ws.readyState === 1 && e.data.arrayBuffer().then((b) => ws.send(b));
    mic.start(400);
  };
};

/* ── start ──────────────────────────────────────────────────────────── */
(async () => {
  const [consultation, fixtures, session] = await Promise.all([
    fetch("./demo/consultation.json").then((r) => r.json()),
    fetch("./demo/fixtures.json").then((r) => r.json()),
    fetch("./api/session.json").then((r) => r.json()).catch(() => null),
  ]);
  script = consultation;
  source = session?.live ? liveSource() : offlineSource(fixtures);
  engine = new GapEngine(source);
  $("#workflow").textContent = RULEPACK.workflow;
  $("#mode").textContent = session?.live ? "corti live" : "recorded";
  if (!session?.live) $("#mic").remove();
  for (const b of document.querySelectorAll(".transport button")) b.disabled = false;
  note(`${RULEPACK.codes.length} codes · ${Object.keys(RULEPACK.requirements).length} documentation requirements · ${session?.live ? "live Corti API" : "recorded Corti output"}`);
  draw();
})();
