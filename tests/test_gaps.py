"""Replays the demo consultation through the engine and asserts the arc.

This is the demo, as a test. If the 90-second story stops working, this fails.
"""
import asyncio
import json
from pathlib import Path

from server.corti import Corti
from server.gaps import GapEngine, evaluate, load_rulepack, Verdict, _leaves

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = json.loads((ROOT / "demo" / "consultation.json").read_text())


def run(coro):
    return asyncio.run(coro)


async def _replay():
    """Feed turns in cumulatively, capturing the board after each one."""
    corti = Corti()
    assert not corti.live, "test must run offline, against fixtures"
    engine = GapEngine(corti)
    frames = []
    text = ""
    for turn in SCRIPT["turns"]:
        text = (text + " " + turn["text"]).strip()
        state, events = await engine.tick(text)
        frames.append({"text": turn["text"], "transcript": text, "state": state, "events": events})
    await corti.aclose()
    return frames


def _find(frames, needle):
    for i, f in enumerate(frames):
        if needle.lower() in f["text"].lower():
            return i, f
    raise AssertionError(f"no turn containing {needle!r}")


def test_rulepack_requirement_ids_all_resolve():
    rules = load_rulepack()
    known = set(rules["requirements"])
    for code in rules["codes"]:
        for req in _leaves(code["requires"]) + ([code["trigger"]] if code.get("trigger") else []):
            assert req in known, f"{code['code']} references unknown requirement {req!r}"


def test_requires_tree():
    v = {"a": Verdict(True), "b": Verdict(False), "c": Verdict(False)}
    assert evaluate({"all_of": ["a"]}, v) == (True, [])
    assert evaluate({"all_of": ["a", "b"]}, v) == (False, ["b"])
    assert evaluate({"any_of": ["b", "a"]}, v) == (True, [])
    # 2-of-3 with one met asks for exactly one more, not both.
    ok, missing = evaluate({"n_of": {"n": 2, "of": ["a", "b", "c"]}}, v)
    assert ok is False and len(missing) == 1


def test_any_of_prefers_the_first_route_not_the_shortest():
    """Branch order is clinical preference, not a cost function."""
    none = {"b": Verdict(False), "c": Verdict(False), "d": Verdict(False)}
    tree = {"any_of": [{"all_of": ["b", "c"]}, "d"]}
    assert evaluate(tree, none) == (False, ["b", "c"])
    # ...unless the later route is actually further along.
    started = dict(none, d=Verdict(True))
    assert evaluate(tree, started) == (True, [])


def test_neuropathy_linkage_gap_opens_then_closes_in_the_room():
    frames = run(_replay())

    i_symptom, f_symptom = _find(frames, "tingling at night")
    gap = next(g for g in f_symptom["state"].gaps if g["code"] == "E11.40")
    assert gap["gapType"] == "LINKAGE"
    assert gap["dollars"] == 1970
    assert gap["requirement"] == "neuropathy_linked"
    assert gap["ask"] == "Attribute the neuropathy to the diabetes, in those words."
    assert "diabetic peripheral neuropathy" in gap["closes"]

    i_link, f_link = _find(frames, "is diabetic peripheral neuropathy")
    assert i_link > i_symptom
    code = next(c for c in f_link["state"].codes if c["code"] == "E11.40")
    assert code["status"] == "defended"
    assert not [g for g in f_link["state"].gaps if g["code"] == "E11.40"]
    assert {
        "type": "gap_closed",
        "gapId": "E11.40:neuropathy_linked",
        "code": "E11.40",
        "label": "Causal link to diabetes",
    } in f_link["events"]


def test_em_code_starts_at_risk_and_earns_its_way_green():
    frames = run(_replay())
    opening = [g["requirement"] for g in frames[0]["state"].gaps if g["code"] == "99214"]
    assert opening == ["mdm_problems", "mdm_data"], "should route through MDM, not bill by time"
    _, f = _find(frames, "read through the letter from the eye clinic")
    code = next(c for c in f["state"].codes if c["code"] == "99214")
    assert code["status"] == "defended"
    assert code["downgrade"]["code"] == "99213"


def test_gaps_still_open_at_the_end_are_the_ones_nobody_closed():
    final = run(_replay())[-1]["state"]
    open_by_code = {g["code"] for g in final.gaps}
    assert open_by_code == {"E11.22", "99406"}
    assert {g["requirement"] for g in final.gaps if g["code"] == "E11.22"} == {
        "ckd_linked",
        "ckd_staged",
    }
    assert final.at_risk == 706.0
    assert final.captured == 2007.0


def test_every_gap_is_answerable_out_loud():
    for frame in run(_replay()):
        for gap in frame["state"].gaps:
            assert gap["ask"].strip() and gap["closes"].strip(), gap["id"]
            assert gap["severity"] in {"high", "med", "low"}
            assert gap["basis"].strip(), gap["id"]


def test_evidence_spans_actually_point_at_the_transcript():
    """The audit chain has to survive contact with the transcript."""
    checked = 0
    for frame in run(_replay()):
        transcript = frame["transcript"]
        for code in frame["state"].codes:
            for ev in code["evidence"]:
                start, end = ev.get("start", -1), ev.get("end", -1)
                assert start >= 0 and end <= len(transcript), (code["code"], ev)
                assert transcript[start:end] == ev["text"], (code["code"], ev)
                checked += 1
    assert checked > 10, "expected the board to carry real evidence spans"


def test_corti_predicted_codes_stay_on_the_board():
    final = run(_replay())[-1]["state"]
    ungoverned = {c["code"] for c in final.codes if c["status"] == "predicted"}
    assert "E11.9" in ungoverned, "the weak code Corti predicts must stay visible"
    assert "N18.9" in ungoverned
