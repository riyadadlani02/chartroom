/* The gap engine.
 *
 * A predicted code is not defensible because a phrase appeared. It is
 * defensible because the documentation elements that rule requires are present.
 * This module judges each requirement against the running transcript and turns
 * every unmet one into a sentence a clinician can say while the patient is
 * still in the room.
 *
 * It runs in the browser in both modes. Offline it reads recorded Corti output
 * from demo/fixtures.json and falls back to the rulepack's cue lists. Live, the
 * Python proxy holds the credentials and forwards to the real Corti API.
 */

import { RULEPACK } from "./rulepack.js";

const REQS = RULEPACK.requirements;

export const V = (met = false, quote = "", start = -1, end = -1) => ({ met, quote, start, end });

/** What this code is worth over the code you fall back to without it. */
export const codeDelta = (code) =>
  Number(code.value_usd || 0) - Number(code.downgrade?.value_usd || 0);

export function leaves(node) {
  if (typeof node === "string") return [node];
  if (node.all_of) return node.all_of.flatMap(leaves);
  if (node.any_of) return node.any_of.flatMap(leaves);
  if (node.n_of) return node.n_of.of.flatMap(leaves);
  return [];
}

/** Walk a requires-tree. Returns [satisfied, cheapest path to satisfying it]. */
export function evaluate(node, verdicts) {
  if (typeof node === "string") {
    const met = !!verdicts[node]?.met;
    return [met, met ? [] : [node]];
  }
  if (node.all_of) {
    const missing = node.all_of.flatMap((c) => evaluate(c, verdicts)[1]);
    return [missing.length === 0, missing];
  }
  if (node.any_of) {
    const branches = node.any_of.map((c) => evaluate(c, verdicts));
    if (branches.some(([ok]) => ok)) return [true, []];
    // Branch order is preference: stay on the first route unless a later one is
    // genuinely further along. Otherwise a fresh visit gets told to bill by
    // time — the shortest path, and the wrong advice.
    const met = node.any_of.map((c) => leaves(c).filter((l) => verdicts[l]?.met).length);
    let best = 0;
    for (let i = 1; i < met.length; i++) if (met[i] > met[best]) best = i;
    return [false, branches[best][1]];
  }
  if (node.n_of) {
    const results = node.n_of.of.map((c) => evaluate(c, verdicts));
    const need = node.n_of.n - results.filter(([ok]) => ok).length;
    if (need <= 0) return [true, []];
    const unmet = results.filter(([ok]) => !ok).flatMap(([, miss]) => miss);
    return [false, unmet.slice(0, need)];
  }
  throw new Error(`unknown requires node: ${JSON.stringify(node)}`);
}

const severity = (dollars, gapType) =>
  dollars >= 500 ? "high" : dollars > 0 || gapType === "SUPPORT" ? "med" : "low";

/** Re-point a recorded or model-supplied quote at the current transcript. */
export function anchor(quote, transcript) {
  if (!quote) return null;
  const i = transcript.toLowerCase().indexOf(quote.toLowerCase().slice(0, 120));
  if (i < 0) return null;
  return { contextIndex: 0, text: transcript.slice(i, i + quote.length), start: i, end: i + quote.length };
}

export class GapEngine {
  constructor(source) {
    this.source = source;
    this.cache = new Map();
    this.open = new Map();
  }

  cueVerdict(reqId, transcript) {
    const low = transcript.toLowerCase();
    for (const cue of REQS[reqId].cues || []) {
      const i = low.indexOf(cue.toLowerCase());
      if (i >= 0) return V(true, transcript.slice(i, i + cue.length), i, i + cue.length);
    }
    return V(false);
  }

  /** One batched call per tick, cached on (requirement, transcript length). */
  async judge(reqIds, transcript) {
    const out = {};
    const todo = [];
    for (const r of reqIds) {
      const hit = this.cache.get(`${r}@${transcript.length}`);
      if (hit) out[r] = hit;
      else todo.push(r);
    }
    if (!todo.length) return out;

    let parsed = {};
    if (this.source.judge) {
      const asked = todo.map((r) => ({ id: r, requirement: REQS[r].question }));
      parsed = (await this.source.judge(asked, transcript)) || {};
    }
    for (const r of todo) {
      const item = parsed[r];
      let v;
      if (item && typeof item === "object") {
        // Never trust the model for offsets; anchor its quote ourselves.
        const span = item.met ? anchor(String(item.quote || ""), transcript) : null;
        v = V(!!item.met, span?.text || "", span?.start ?? -1, span?.end ?? -1);
      } else {
        v = this.cueVerdict(r, transcript);
      }
      this.cache.set(`${r}@${transcript.length}`, v);
      out[r] = v;
    }
    return out;
  }

  async tick(transcript) {
    const [coding, facts] = await Promise.all([
      this.source.predictCodes(transcript, RULEPACK.systems),
      this.source.extractFacts(transcript),
    ]);
    const predicted = Object.fromEntries((coding.codes || []).map((c) => [c.code, c]));

    // Triggers for watched codes, plus the full set of anything Corti predicted.
    const needed = new Set(RULEPACK.codes.filter((c) => c.trigger).map((c) => c.trigger));
    for (const c of RULEPACK.codes) {
      if (predicted[c.code]) for (const r of leaves(c.requires)) needed.add(r);
    }
    const verdicts = await this.judge([...needed].sort(), transcript);

    const inPlay = RULEPACK.codes.filter(
      (rule) =>
        predicted[rule.code] || (rule.watch && (!rule.trigger || verdicts[rule.trigger]?.met))
    );
    const second = new Set();
    for (const c of inPlay) for (const r of leaves(c.requires)) if (!(r in verdicts)) second.add(r);
    if (second.size) Object.assign(verdicts, await this.judge([...second].sort(), transcript));

    const codes = [];
    const gaps = [];
    let atRisk = 0;
    let captured = 0;

    for (const rule of inPlay) {
      const [ok, missing] = evaluate(rule.requires, verdicts);
      const delta = codeDelta(rule);
      const pred = predicted[rule.code] || {};
      const own = leaves(rule.requires);
      const evidence = (pred.evidences || []).length
        ? pred.evidences
        : own
            .map((r) => verdicts[r])
            .filter((v) => v?.met && v.quote)
            .map((v) => ({ text: v.quote, start: v.start, end: v.end }));

      codes.push({
        code: rule.code,
        system: rule.system,
        display: rule.display || pred.display || "",
        status: ok ? "defended" : "at_risk",
        predicted: rule.code in predicted,
        gapType: rule.gap_type,
        dollars: delta,
        basis: rule.basis || "",
        downgrade: rule.downgrade || null,
        evidence,
        met: own
          .filter((r) => verdicts[r]?.met)
          .map((r) => ({ id: r, label: REQS[r].label, quote: verdicts[r].quote })),
      });

      if (ok) {
        captured += delta;
        continue;
      }
      atRisk += delta;
      for (const reqId of missing) {
        const req = REQS[reqId];
        gaps.push({
          id: `${rule.code}:${reqId}`,
          code: rule.code,
          system: rule.system,
          display: rule.display || "",
          gapType: rule.gap_type,
          requirement: reqId,
          label: req.label,
          ask: req.ask,
          closes: req.closes || "",
          dollars: delta,
          basis: rule.basis || "",
          severity: severity(delta, rule.gap_type),
        });
      }
    }

    // Codes Corti predicted that the rulepack has no opinion on still belong on
    // the board: that is what the coder would submit today.
    const governed = new Set(inPlay.map((r) => r.code));
    for (const [code, pred] of Object.entries(predicted)) {
      if (governed.has(code)) continue;
      codes.push({
        code,
        system: pred.system || "",
        display: pred.display || "",
        status: "predicted",
        predicted: true,
        gapType: "",
        dollars: 0,
        basis: "Predicted by Corti. No rulepack requirement governs it.",
        downgrade: null,
        evidence: pred.evidences || [],
        met: [],
      });
    }

    gaps.sort((a, b) => b.dollars - a.dollars);
    const now = new Map(gaps.map((g) => [g.id, g]));
    const events = gaps
      .filter((g) => !this.open.has(g.id))
      .map((gap) => ({ type: "gap_opened", gap }));
    for (const [id, was] of this.open) {
      if (!now.has(id)) events.push({ type: "gap_closed", gapId: id, code: was.code, label: was.label });
    }
    this.open = now;

    return {
      state: {
        codes,
        gaps,
        facts: facts.facts || [],
        atRisk: Math.round(atRisk * 100) / 100,
        captured: Math.round(captured * 100) / 100,
      },
      events,
    };
  }
}

/* ── sources ─────────────────────────────────────────────────────────────
 * Offline replays recorded Corti output. Live goes through the Python proxy,
 * which holds the credentials the browser must never see.
 */

export function offlineSource(fixtures) {
  return {
    live: false,
    async predictCodes(text) {
      const low = text.toLowerCase();
      const codes = [];
      for (const c of fixtures.codes) {
        if (c.afterCue && !low.includes(c.afterCue.toLowerCase())) continue;
        const { afterCue, evidences = [], ...rest } = c;
        codes.push({
          ...rest,
          evidences: evidences.map((e) => anchor(e.text, text)).filter(Boolean),
        });
      }
      return { codes, candidates: [], usageInfo: { creditsConsumed: 0 } };
    },
    async extractFacts(text) {
      const low = text.toLowerCase();
      return { facts: fixtures.facts.filter((f) => low.includes(f.text.toLowerCase().slice(0, 40))) };
    },
    judge: null, // no judge configured — the engine falls back to cue lists
  };
}

export function liveSource(base = ".") {
  const post = async (path, body) => {
    const r = await fetch(`${base}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  };
  let judgeOk = true;
  return {
    live: true,
    predictCodes: (text, systems) => post("coding", { text, systems }),
    extractFacts: (text) => post("facts", { text }),
    async judge(asked, transcript) {
      if (!judgeOk) return null;
      try {
        return await post("judge", { asked, transcript });
      } catch {
        // One bad judge call must not take the console down mid-consultation.
        judgeOk = false;
        return null;
      }
    },
  };
}
