# CHARTROOM

**A coding desk that sits in the room, not three weeks downstream.**

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

```bash
uv sync
uv run uvicorn server.main:app --port 8000
```

Open <http://localhost:8000>, click through the tune-in, press **Roll
consultation**. It replays a real-shaped diabetes review at 2×.

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
anchors it against the transcript itself (`server/gaps.py`). A quote that cannot
be found is discarded rather than displayed.

## Running against the real API

Offline is the default: `demo/fixtures.json` holds recorded Corti output and the
console runs with no credentials, on a plane. Set these and every call goes live:

```bash
cp .env.example .env   # then fill in, and: set -a; source .env; set +a
```

`CORTI_CLIENT_ID` / `CORTI_CLIENT_SECRET` / `CORTI_TENANT` switch on the real
coding, facts and document endpoints. A **Use microphone** button appears in the
rail, which creates an interaction and streams live audio to Corti over
WebSocket. `CHARTROOM_LLM_BASE` points the judge at any OpenAI-compatible
endpoint; it defaults to Corti Models. With no judge configured, requirements
fall back to the cue lists in the rulepack — good enough to demo, not good enough
to ship.

## The rulepack

One narrow workflow, done end to end: **adult type 2 diabetes follow-up, primary
care, established patient**. 5 codes, 13 documentation requirements, in
`server/rulepack.yaml`. Adding a code is adding YAML:

```yaml
- code: "E11.22"
  system: icd10cm-outpatient
  display: "Type 2 diabetes mellitus with diabetic chronic kidney disease"
  gap_type: STAGING
  watch: true              # hunt for it even when Corti has not predicted it
  trigger: ckd_present     # ...once this requirement is met
  value_usd: 690
  basis: "Stage 3b+ CKD risk-adjusts (≈0.069 RAF); unstaged CKD does not."
  requires:
    all_of: [ckd_present, ckd_linked, ckd_staged]
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
uv run pytest -q
```

The demo, asserted: the suite replays the whole consultation through the engine
and checks that the linkage gap opens on the right turn and closes on the right
turn, that the money lands on `$706` at risk and `$2,007` captured, and that
every evidence span still points at the exact characters it claims to. If the
90-second story stops working, the tests fail.

## What this is not

- **Not a coding authority.** The rulepack encodes a handful of rules for one
  workflow. A production version needs a real, maintained rule source.
- **Not autonomous.** It never edits a note and never submits a code. It asks a
  question; a clinician answers it out loud or ignores it.
- **Not validated.** The dollar figures are defensible arithmetic on public
  benchmarks, not a measured result.
