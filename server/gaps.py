"""The gap engine.

A predicted code is not defensible because a phrase appeared. It is defensible
because the documentation elements that rule requires are present. This module
holds the rulepack, judges each requirement against the running transcript, and
turns every unmet requirement into one sentence a clinician can say out loud
while the patient is still in the room.
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

RULEPACK = Path(__file__).resolve().parent / "rulepack.yaml"

JUDGE_SYSTEM = (
    "You are a clinical documentation integrity auditor. You are given a "
    "consultation transcript and a list of documentation requirements. For each "
    "requirement decide whether the transcript satisfies it. Be strict: a "
    "requirement is met only if the transcript itself contains the element, not "
    "if it is merely implied or clinically obvious. Answer with a JSON object "
    'of the form {"<id>": {"met": true|false, "quote": "<verbatim span from the '
    'transcript, or empty string>"}}. The quote must be copied character for '
    "character from the transcript. Output JSON only."
)


@dataclass
class Verdict:
    met: bool
    quote: str = ""
    start: int = -1
    end: int = -1


@dataclass
class EngineState:
    codes: list[dict] = field(default_factory=list)
    gaps: list[dict] = field(default_factory=list)
    facts: list[dict] = field(default_factory=list)
    at_risk: float = 0.0
    captured: float = 0.0
    live: bool = False


def load_rulepack(path: Path = RULEPACK) -> dict:
    return yaml.safe_load(path.read_text())


def code_delta(code: dict) -> float:
    """What this code is worth over the code you fall back to without it."""
    return float(code.get("value_usd", 0)) - float(
        code.get("downgrade", {}).get("value_usd", 0)
    )


def evaluate(node, verdicts: dict[str, Verdict]) -> tuple[bool, list[str]]:
    """Walk a requires-tree. Returns (satisfied, cheapest path to satisfying it)."""
    if isinstance(node, str):
        met = verdicts.get(node, Verdict(False)).met
        return met, [] if met else [node]
    if "all_of" in node:
        missing: list[str] = []
        for child in node["all_of"]:
            ok, miss = evaluate(child, verdicts)
            if not ok:
                missing.extend(miss)
        return not missing, missing
    if "any_of" in node:
        branches = [evaluate(child, verdicts) for child in node["any_of"]]
        if any(ok for ok, _ in branches):
            return True, []
        # Branch order is preference: stay on the first route unless a later one
        # is genuinely further along. Otherwise a fresh visit gets told to bill
        # by time — the shortest path, and the wrong advice.
        met = [
            sum(1 for leaf in _leaves(child) if verdicts.get(leaf, Verdict(False)).met)
            for child in node["any_of"]
        ]
        best = max(range(len(branches)), key=met.__getitem__)
        return False, branches[best][1]
    if "n_of" in node:
        spec = node["n_of"]
        results = [evaluate(child, verdicts) for child in spec["of"]]
        met = sum(1 for ok, _ in results if ok)
        need = spec["n"] - met
        if need <= 0:
            return True, []
        unmet = [m for ok, miss in results if not ok for m in miss]
        return False, unmet[:need]
    raise ValueError(f"unknown requires node: {node!r}")


class GapEngine:
    def __init__(self, corti, rulepack: dict | None = None) -> None:
        self.corti = corti
        self.rules = rulepack or load_rulepack()
        self.reqs = self.rules["requirements"]
        self.state = EngineState(live=corti.live)
        self._judge_cache: dict[tuple[str, int], Verdict] = {}
        self._open_gaps: dict[str, dict] = {}
        self._judge_ok = True

    # --- judging ----------------------------------------------------------
    def _cue_verdict(self, req_id: str, transcript: str) -> Verdict:
        low = transcript.lower()
        for cue in self.reqs[req_id].get("cues", []):
            i = low.find(cue.lower())
            if i >= 0:
                return Verdict(True, transcript[i : i + len(cue)], i, i + len(cue))
        return Verdict(False)

    async def judge(self, req_ids: list[str], transcript: str) -> dict[str, Verdict]:
        """One batched call per tick. Cached on (requirement, transcript length)."""
        key_len = len(transcript)
        out: dict[str, Verdict] = {}
        todo = []
        for r in req_ids:
            hit = self._judge_cache.get((r, key_len))
            if hit is not None:
                out[r] = hit
            else:
                todo.append(r)
        if not todo:
            return out

        raw = ""
        if self._judge_ok:
            asked = [{"id": r, "requirement": self.reqs[r]["question"].strip()} for r in todo]
            try:
                raw = await self.corti.chat(
                    [
                        {"role": "system", "content": JUDGE_SYSTEM},
                        {
                            "role": "user",
                            "content": f"TRANSCRIPT:\n{transcript}\n\nREQUIREMENTS:\n"
                            + json.dumps(asked, indent=1),
                        },
                    ],
                    schema_hint="object",
                )
            except Exception:
                # One bad judge call must not take the console down mid-consultation.
                self._judge_ok = False
                raw = ""

        parsed = _loads(raw)
        for r in todo:
            item = parsed.get(r)
            if isinstance(item, dict):
                v = Verdict(bool(item.get("met")), str(item.get("quote", "")))
                # Never trust the model for offsets; anchor the quote ourselves.
                if v.quote:
                    i = transcript.lower().find(v.quote.lower()[:120])
                    if i >= 0:
                        v.start, v.end = i, i + len(v.quote)
                        v.quote = transcript[v.start : v.end]
                    else:
                        v.quote = ""
            else:
                v = self._cue_verdict(r, transcript)
            self._judge_cache[(r, key_len)] = v
            out[r] = v
        return out

    # --- the tick ---------------------------------------------------------
    async def tick(self, transcript: str) -> tuple[EngineState, list[dict]]:
        systems = self.rules["systems"]
        coding, facts = await asyncio.gather(
            self.corti.predict_codes(transcript, systems),
            self.corti.extract_facts(transcript),
        )
        predicted = {c["code"]: c for c in coding.get("codes", [])}

        # Requirements we need answered: triggers for watched codes, plus the
        # full requirement set of every code actually in play.
        needed = {c["trigger"] for c in self.rules["codes"] if c.get("trigger")}
        needed |= {
            r
            for c in self.rules["codes"]
            if c["code"] in predicted
            for r in _leaves(c["requires"])
        }
        verdicts = await self.judge(sorted(needed), transcript)

        in_play = []
        for rule in self.rules["codes"]:
            trigger = rule.get("trigger")
            triggered = trigger is None or verdicts.get(trigger, Verdict(False)).met
            if rule["code"] in predicted or (rule.get("watch") and triggered):
                in_play.append(rule)

        second = {r for c in in_play for r in _leaves(c["requires"])} - set(verdicts)
        if second:
            verdicts |= await self.judge(sorted(second), transcript)

        codes, gaps, at_risk, captured = [], [], 0.0, 0.0
        for rule in in_play:
            ok, missing = evaluate(rule["requires"], verdicts)
            delta = code_delta(rule)
            pred = predicted.get(rule["code"], {})
            evidence = pred.get("evidences", []) or [
                {"text": v.quote, "start": v.start, "end": v.end}
                for r in _leaves(rule["requires"])
                if (v := verdicts.get(r)) and v.met and v.quote
            ]
            codes.append(
                {
                    "code": rule["code"],
                    "system": rule["system"],
                    "display": rule.get("display", pred.get("display", "")),
                    "status": "defended" if ok else "at_risk",
                    "predicted": rule["code"] in predicted,
                    "gapType": rule["gap_type"],
                    "dollars": delta,
                    "basis": rule.get("basis", ""),
                    "downgrade": rule.get("downgrade"),
                    "evidence": evidence,
                    "met": [
                        {"id": r, "label": self.reqs[r]["label"], "quote": v.quote}
                        for r in _leaves(rule["requires"])
                        if (v := verdicts.get(r)) and v.met
                    ],
                }
            )
            if ok:
                captured += delta
                continue
            at_risk += delta
            for req_id in missing:
                req = self.reqs[req_id]
                gaps.append(
                    {
                        "id": f"{rule['code']}:{req_id}",
                        "code": rule["code"],
                        "system": rule["system"],
                        "display": rule.get("display", ""),
                        "gapType": rule["gap_type"],
                        "requirement": req_id,
                        "label": req["label"],
                        "ask": req["ask"],
                        "closes": req.get("closes", ""),
                        "dollars": delta,
                        "basis": rule.get("basis", ""),
                        "severity": _severity(delta, rule["gap_type"]),
                    }
                )

        governed = {r["code"] for r in in_play}
        for code, pred in predicted.items():
            if code in governed:
                continue
            codes.append(
                {
                    "code": code,
                    "system": pred.get("system", ""),
                    "display": pred.get("display", ""),
                    "status": "predicted",
                    "predicted": True,
                    "gapType": "",
                    "dollars": 0,
                    "basis": "Predicted by Corti. No rulepack requirement governs it.",
                    "downgrade": None,
                    "evidence": pred.get("evidences", []),
                    "met": [],
                }
            )

        gaps.sort(key=lambda g: -g["dollars"])
        now = {g["id"]: g for g in gaps}
        events = [{"type": "gap_opened", "gap": g} for g in gaps if g["id"] not in self._open_gaps]
        events += [
            {"type": "gap_closed", "gapId": gid, "code": was["code"], "label": was["label"]}
            for gid, was in self._open_gaps.items()
            if gid not in now
        ]
        self._open_gaps = now

        self.state = EngineState(
            codes=codes,
            gaps=gaps,
            facts=facts.get("facts", []),
            at_risk=round(at_risk, 2),
            captured=round(captured, 2),
            live=self.corti.live,
        )
        return self.state, events


def _severity(dollars: float, gap_type: str) -> str:
    if dollars >= 500:
        return "high"
    if dollars > 0 or gap_type == "SUPPORT":
        return "med"
    return "low"


def _leaves(node) -> list[str]:
    if isinstance(node, str):
        return [node]
    if "all_of" in node:
        return [x for c in node["all_of"] for x in _leaves(c)]
    if "any_of" in node:
        return [x for c in node["any_of"] for x in _leaves(c)]
    if "n_of" in node:
        return [x for c in node["n_of"]["of"] for x in _leaves(c)]
    return []


def _loads(raw: str) -> dict:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.S)
        try:
            return json.loads(m.group(0)) if m else {}
        except json.JSONDecodeError:
            return {}
