# CHARTROOM

**A coding desk that sits in the room, not three weeks downstream.**

### ▶ [Open the console](https://riyadadlani02.github.io/chartroom/)

Claim denials from thin documentation get caught by a coder weeks after the
visit, when nobody remembers what happened. By then the only options are an
appeal, a downgrade, or writing it off. CHARTROOM moves that check to the one
moment it can still be fixed for free: while the patient is still sitting there.

It listens to the consultation, predicts the codes the visit is heading toward,
and asks the question that actually matters — **does what was said in this room
contain the evidence to defend that code?** When the answer is no, it puts one
sentence on screen. The clinician says it. The code turns green.

Built on the [Corti API](https://docs.corti.ai/) for
[Hack for Health](https://luma.com/corti-CPH-2026).

---

## The insight

A predicted code is not defensible because a phrase appeared in the transcript.
It is defensible because **the documentation elements that rule requires are
present**. Those are two different questions, and only the second one survives an
audit.

So CHARTROOM does not check for keywords. Every code carries a `requires` tree of
documentation elements, each one gets judged against the running transcript, and
an unmet element becomes a gap. A gap is not a warning — it is a sentence short
enough to say out loud without breaking the consultation.

Five gap types, because not every miss is the same miss:

| Type | What happened | Example |
| --- | --- | --- |
| `SUPPORT` | A predicted code is missing a required element and will downgrade | 99214 with only one MDM element |
| `LINKAGE` | Two facts are both documented, but the causal relationship between them is not | neuropathy + diabetes, never called *diabetic* neuropathy |
| `STAGING` | The code needs a stage, grade or severity that nobody stated | CKD documented, stage never given |
| `UNCAPTURED` | A service was performed and nothing will be billed for it | cessation counselling delivered, never timed |
| `COHERENCE` | The code set contradicts the note — no money, but it is what an audit pulls on | note describes insulin, no `Z79.4` |

## The 90-second demo

[Open the console](https://riyadadlani02.github.io/chartroom/), click through the
tune-in, press **Roll consultation**. It replays a real-shaped diabetes review
at 2×.

1. **0:16** — `99214` opens **at risk**. Two of three MDM elements are missing.
   Watch it earn its way green as the clinician states the problem status and
   names what she reviewed. `+$37`.
2. **0:45** — the patient says her feet have been tingling. The centre tube rolls
   and the big one fires: **`LINKAGE · E11.40 · $1,970`**. The neuropathy is
   documented. The diabetes is documented. Nobody has said they are the same
   problem, so the visit codes as `E11.9` and the risk adjustment is lost.
3. **1:09** — the clinician says *"this is diabetic peripheral neuropathy."*
   The gap closes live, the chip flips green, and **$1,970 moves from AT RISK to
   CAPTURED** while the patient is still in the chair.
4. **1:22** — an eGFR of 44 opens `E11.22` for a missing stage. **Press
   *Clinician says it →*** to fire the closing line yourself and watch it resolve.
5. **End of visit** — `$706` still on the table: a CKD stage nobody gave, and
   cessation counselling that was delivered but never timed.

Click any code on the board to light its **evidence spans** in the transcript.
That is Corti's audit trail, used as designed: every green code points at the
exact words that defend it.

## The four APIs, each doing a job

| API | Used for |
| --- | --- |
| **Speech to text** (`/streams` WS) | Live diarised transcript, biased toward the terms the coding rules hang on (`server/corti.py:KEYTERMS`) |
| **Fact extraction** | Structured clinical state — the board's right-hand column |
| **Coding** (`/tools/coding/`) | Predicted ICD-10/CPT **with `evidences[]` character offsets**. Those offsets are the evidence chain; the console renders them directly |
| **Corti Models** | The requirement judge. One batched call per tick asks, per requirement, *is this documented* and *quote the span*. Narrow question, verbatim answer |

Model offsets are never trusted — the judge returns a quote, and CHARTROOM
anchors it against the transcript itself. A quote that cannot be found in the
transcript is discarded rather than displayed.

## Running it

**The engine runs in the browser.** `web/` is the entire console — rulepack,
engine, renderer, demo data — so the demo needs no server, no build step and no
credentials. Any static host will do:

```bash
cd web && python3 -m http.server 8000
```

**The server exists for one reason:** a Corti client secret cannot live in a
browser. Start it and the same engine calls the real API through a four-route
proxy, and a **Use microphone** button appears in the rail that streams live
audio to Corti over WebSocket.

```bash
cp .env.example .env          # fill in, then: set -a; source .env; set +a
uv run uvicorn server.main:app --port 8000
```

`CORTI_CLIENT_ID` / `CORTI_CLIENT_SECRET` / `CORTI_TENANT` switch on real coding,
facts and streaming. `CHARTROOM_LLM_BASE` points the judge at any
OpenAI-compatible endpoint; it defaults to Corti Models, whose path is not in
Corti's public docs index and so is a default rather than a certainty. With no
judge reachable, requirements fall back to the cue lists in the rulepack — good
enough to demo, not good enough to ship.

## The rulepack

One narrow workflow, done end to end: **adult type 2 diabetes follow-up, primary
care, established patient**. 5 codes, 13 documentation requirements, in
[`web/rulepack.js`](web/rulepack.js). Adding a code is adding an entry:

```js
{
  "code": "E11.22",
  "system": "icd10cm-outpatient",
  "display": "Type 2 diabetes mellitus with diabetic chronic kidney disease",
  "gap_type": "STAGING",
  "watch": true,             // hunt for it even when Corti has not predicted it
  "trigger": "ckd_present",  // ...once this requirement is met
  "value_usd": 690,
  "basis": "Stage 3b+ CKD risk-adjusts (≈0.069 RAF); unstaged CKD does not.",
  "requires": { "all_of": ["ckd_present", "ckd_linked", "ckd_staged"] }
}
```

`requires` supports `all_of`, `any_of` and `n_of` — the last one because real E/M
rules are *two of three*, not all of three. Branch order in `any_of` is clinical
preference, not a cost function: a fresh visit routes through MDM rather than
being told to bill by time just because that is one requirement instead of two.

Every dollar figure carries its arithmetic in `basis`, on screen, so a coder can
argue with it. CPT values are 2024 Medicare national non-facility averages;
ICD-10 values are RAF deltas priced at a $10,000 annual benchmark. Swap them for
your own fee schedule.

## Tests

```bash
node --test
```

The demo, asserted: the suite replays the whole consultation through the engine
and checks that the linkage gap opens on the right turn and closes on the right
turn, that the money lands on `$706` at risk and `$2,007` captured, and that
every evidence span still points at the exact characters it claims to. If the
90-second story stops working, the tests fail and Pages does not deploy.

## Layout

```
web/            the console — this folder alone is the deployed site
  rulepack.js     codes, requirements, dollars, and the arithmetic behind them
  engine.js       the gap engine; runs in the browser in both modes
  app.js          three-tube renderer and the replay loop
  demo/           the scripted consultation and recorded Corti output
server/         the credentialed proxy for the live path — optional
```

## What this is not

- **Not a coding authority.** The rulepack encodes a handful of rules for one
  workflow. A production version needs a real, maintained rule source.
- **Not autonomous.** It never edits a note and never submits a code. It asks a
  question; a clinician answers it out loud or ignores it.
- **Not validated.** The dollar figures are defensible arithmetic on public
  benchmarks, not a measured result.
