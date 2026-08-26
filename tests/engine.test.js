/* Replays the demo consultation through the engine and asserts the arc.
 * This is the demo, as a test. If the 90-second story stops working, it fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GapEngine, evaluate, leaves, offlineSource, V } from "../docs/engine.js";
import { RULEPACK } from "../docs/rulepack.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const SCRIPT = read("../web/demo/consultation.json");
const FIXTURES = read("../web/demo/fixtures.json");

/** Feed turns in cumulatively, capturing the board after each one. */
async function replay() {
  const engine = new GapEngine(offlineSource(FIXTURES));
  const frames = [];
  let transcript = "";
  for (const turn of SCRIPT.turns) {
    transcript = `${transcript} ${turn.text}`.trim();
    const { state, events } = await engine.tick(transcript);
    frames.push({ text: turn.text, transcript, state, events });
  }
  return frames;
}

const find = (frames, needle) => {
  const i = frames.findIndex((f) => f.text.toLowerCase().includes(needle.toLowerCase()));
  assert.notEqual(i, -1, `no turn containing ${needle}`);
  return [i, frames[i]];
};

test("every requirement id a code references resolves", () => {
  const known = new Set(Object.keys(RULEPACK.requirements));
  for (const code of RULEPACK.codes) {
    for (const req of [...leaves(code.requires), ...(code.trigger ? [code.trigger] : [])]) {
      assert.ok(known.has(req), `${code.code} references unknown requirement ${req}`);
    }
  }
});

test("requires-tree", () => {
  const v = { a: V(true), b: V(false), c: V(false) };
  assert.deepEqual(evaluate({ all_of: ["a"] }, v), [true, []]);
  assert.deepEqual(evaluate({ all_of: ["a", "b"] }, v), [false, ["b"]]);
  assert.deepEqual(evaluate({ any_of: ["b", "a"] }, v), [true, []]);
  // 2-of-3 with one met asks for exactly one more, not both.
  const [ok, missing] = evaluate({ n_of: { n: 2, of: ["a", "b", "c"] } }, v);
  assert.equal(ok, false);
  assert.equal(missing.length, 1);
});

test("any_of prefers the first route, not the shortest", () => {
  const none = { b: V(false), c: V(false), d: V(false) };
  const tree = { any_of: [{ all_of: ["b", "c"] }, "d"] };
  assert.deepEqual(evaluate(tree, none), [false, ["b", "c"]]);
  // ...unless the later route is actually further along.
  assert.deepEqual(evaluate(tree, { ...none, d: V(true) }), [true, []]);
});

test("neuropathy linkage gap opens, then closes in the room", async () => {
  const frames = await replay();

  const [iSymptom, fSymptom] = find(frames, "tingling at night");
  const gap = fSymptom.state.gaps.find((g) => g.code === "E11.40");
  assert.equal(gap.gapType, "LINKAGE");
  assert.equal(gap.dollars, 1970);
  assert.equal(gap.requirement, "neuropathy_linked");
  assert.equal(gap.ask, "Attribute the neuropathy to the diabetes, in those words.");
  assert.match(gap.closes, /diabetic peripheral neuropathy/);

  const [iLink, fLink] = find(frames, "is diabetic peripheral neuropathy");
  assert.ok(iLink > iSymptom);
  assert.equal(fLink.state.codes.find((c) => c.code === "E11.40").status, "defended");
  assert.equal(fLink.state.gaps.filter((g) => g.code === "E11.40").length, 0);
  assert.deepEqual(
    fLink.events.find((e) => e.type === "gap_closed" && e.code === "E11.40"),
    { type: "gap_closed", gapId: "E11.40:neuropathy_linked", code: "E11.40", label: "Causal link to diabetes" }
  );
});

test("the E/M code starts at risk and earns its way green", async () => {
  const frames = await replay();
  const opening = frames[0].state.gaps.filter((g) => g.code === "99214").map((g) => g.requirement);
  assert.deepEqual(opening, ["mdm_problems", "mdm_data"], "should route through MDM, not bill by time");

  const [, f] = find(frames, "read through the letter from the eye clinic");
  const code = f.state.codes.find((c) => c.code === "99214");
  assert.equal(code.status, "defended");
  assert.equal(code.downgrade.code, "99213");
});

test("gaps still open at the end are the ones nobody closed", async () => {
  const final = (await replay()).at(-1).state;
  assert.deepEqual(new Set(final.gaps.map((g) => g.code)), new Set(["E11.22", "99406"]));
  assert.deepEqual(
    new Set(final.gaps.filter((g) => g.code === "E11.22").map((g) => g.requirement)),
    new Set(["ckd_linked", "ckd_staged"])
  );
  assert.equal(final.atRisk, 706);
  assert.equal(final.captured, 2007);
});

test("every gap is answerable out loud", async () => {
  for (const frame of await replay()) {
    for (const gap of frame.state.gaps) {
      assert.ok(gap.ask.trim(), gap.id);
      assert.ok(gap.closes.trim(), gap.id);
      assert.ok(gap.basis.trim(), gap.id);
      assert.ok(["high", "med", "low"].includes(gap.severity));
    }
  }
});

test("evidence spans actually point at the transcript", async () => {
  let checked = 0;
  for (const { transcript, state } of await replay()) {
    for (const code of state.codes) {
      for (const ev of code.evidence) {
        assert.ok(ev.start >= 0 && ev.end <= transcript.length, `${code.code} ${JSON.stringify(ev)}`);
        assert.equal(transcript.slice(ev.start, ev.end), ev.text, code.code);
        checked++;
      }
    }
  }
  assert.ok(checked > 10, "expected the board to carry real evidence spans");
});

test("codes Corti predicted stay on the board", async () => {
  const final = (await replay()).at(-1).state;
  const ungoverned = new Set(final.codes.filter((c) => c.status === "predicted").map((c) => c.code));
  assert.ok(ungoverned.has("E11.9"), "the weak code Corti predicts must stay visible");
  assert.ok(ungoverned.has("N18.9"));
});
