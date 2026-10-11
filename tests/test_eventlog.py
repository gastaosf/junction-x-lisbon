from __future__ import annotations

import base64
import json
import re
import threading
from pathlib import Path

from astrolabio.eventlog import SCHEMA_VERSION, EventLog, export_panorama, validate_export
from astrolabio.penalties import PenaltyLedger

ENVELOPE_KEYS = [
    "schema_version",
    "seq",
    "ts",
    "t_rel_s",
    "run_id",
    "panorama_id",
    "actor",
    "type",
    "penalty_state",
    "data",
]


def make_log(tmp_path: Path, ledger: PenaltyLedger | None = None) -> EventLog:
    state = ledger.state if ledger else None
    return EventLog("run1", "pano1", tmp_path / "run1" / "pano1.events.jsonl", penalty_state=state)


def entries(multiplier: float = 1.0, origin: str = "agent") -> list[dict]:
    return [
        {"rank": r, "lat": 38.722252, "lng": -9.139337, "multiplier": multiplier, "origin": origin}
        for r in range(1, 11)
    ]


def write_run(tmp_path: Path) -> EventLog:
    ledger = PenaltyLedger()
    log = make_log(tmp_path, ledger)
    log.emit("harness", "run_start", {"filename": "pano1.jpg", "label": "Urban"})
    ledger.add_mcq()
    log.emit("agent", "mcq_asked", {"question": "Which street?", "options": ["A", "B"]})
    log.emit("harness", "final_submission", {"entries": entries(0.95), "allocator": {"plan": "10x1"}})
    log.emit("harness", "run_end", {"tokens": {"input_tokens": 10}, "cost_usd": 0.5, "wall_time_s": 3.2, "turns": 4})
    return log


def export(tmp_path: Path, log: EventLog, **kwargs) -> dict:
    return export_panorama(
        log.path,
        tmp_path / "out" / "pano1.json",
        team="albatross",
        panorama={"panorama_id": "pano1", "label": "Urban"},
        config={"model": "m"},
        **kwargs,
    )


def test_envelope_fields_and_order(tmp_path):
    env = make_log(tmp_path).emit("agent", "candidates_update", {"k": 1})
    assert list(env) == ENVELOPE_KEYS
    assert env["schema_version"] == SCHEMA_VERSION == "1.0"
    assert env["seq"] == 1
    assert (env["run_id"], env["panorama_id"], env["actor"], env["type"]) == ("run1", "pano1", "agent", "candidates_update")
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", env["ts"])
    assert env["t_rel_s"] >= 0
    assert env["penalty_state"] == {"cues": 0, "mcqs": 0, "human_geocodes": 0, "multiplier": 1.0}
    assert env["data"] == {"k": 1}


def test_seq_is_monotonic_and_file_is_readable_mid_run(tmp_path):
    log = make_log(tmp_path)
    for i in range(1, 6):
        log.emit("tool", "tool_call", {"i": i})
        # flushed per event: an independent reader sees every event so far, each a complete JSON line
        lines = log.path.read_text(encoding="utf-8").splitlines()
        assert [json.loads(line)["seq"] for line in lines] == list(range(1, i + 1))
    assert [e["seq"] for e in log.events()] == [1, 2, 3, 4, 5]
    assert [e["t_rel_s"] for e in log.events()] == sorted(e["t_rel_s"] for e in log.events())


def test_seq_is_unique_under_concurrent_emitters(tmp_path):
    log = make_log(tmp_path)
    threads = [threading.Thread(target=lambda: [log.emit("tool", "t", {}) for _ in range(25)]) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [e["seq"] for e in log.events()] == list(range(1, 201))


def test_reopened_log_appends_and_continues_seq(tmp_path):
    make_log(tmp_path).emit("harness", "run_start", {})
    again = make_log(tmp_path)
    assert again.emit("harness", "resumed", {})["seq"] == 2
    assert [e["type"] for e in again.events()] == ["run_start", "resumed"]


def test_penalty_state_reflects_ledger_at_emit_time(tmp_path):
    ledger = PenaltyLedger()
    log = make_log(tmp_path, ledger)
    log.emit("harness", "a", {})
    ledger.add_mcq()
    log.emit("harness", "b", {})
    ledger.add_cue()
    ledger.add_human_geocode()
    log.emit("harness", "c", {})
    states = [e["penalty_state"] for e in log.events()]
    assert states[0] == {"cues": 0, "mcqs": 0, "human_geocodes": 0, "multiplier": 1.0}
    assert states[1] == {"cues": 0, "mcqs": 1, "human_geocodes": 0, "multiplier": 0.95}
    assert states[2]["cues"] == states[2]["human_geocodes"] == 1
    assert abs(states[2]["multiplier"] - 0.95 * 0.8 * 0.5) < 1e-12


def test_emit_never_raises_on_unserialisable_data(tmp_path):
    log = make_log(tmp_path)
    loop: dict = {}
    loop["self"] = loop
    payloads = [
        {"path": Path("a/b.jpg"), "raw": b"\xff\xd8" * 50, "obj": object(), "tags": {"b", "a"}},
        {"nan": float("nan")},
        loop,
    ]
    for payload in payloads:
        env = log.emit("tool", "tool_result", payload)
        json.dumps(env, allow_nan=False)
    events = log.events()
    assert len(events) == 3
    assert events[0]["data"]["path"] == "a/b.jpg"
    assert events[0]["data"]["raw"] == "<100 bytes>"
    assert events[0]["data"]["tags"] == ["a", "b"]
    assert events[1]["data"]["nan"] is None


def test_listeners_receive_envelopes_and_cannot_break_emit(tmp_path):
    log = make_log(tmp_path)
    seen: list[dict] = []

    def broken(_: dict) -> None:
        raise RuntimeError("subscriber died")

    log.add_listener(broken)
    log.add_listener(seen.append)
    env = log.emit("agent", "x", {"a": 1})
    assert seen == [env]


def test_torn_last_line_is_skipped(tmp_path):
    log = make_log(tmp_path)
    log.emit("harness", "a", {})
    with log.path.open("a", encoding="utf-8") as fh:
        fh.write('{"seq": 2, "type": "b"')
    assert [e["type"] for e in log.events()] == ["a"]


def test_export_shape_and_validation(tmp_path):
    log = write_run(tmp_path)
    doc = export(tmp_path, log)
    assert list(doc) == ["schema_version", "team", "panorama", "config", "events", "final", "totals"]
    assert doc["team"] == "albatross"
    assert doc["events"] == log.events()
    assert doc["final"]["locations"] == entries(0.95)
    assert doc["final"]["penalty_state"] == {"cues": 0, "mcqs": 1, "human_geocodes": 0, "multiplier": 0.95}
    assert doc["totals"]["turns"] == 4
    assert validate_export(doc) == []
    assert json.loads((tmp_path / "out" / "pano1.json").read_text(encoding="utf-8")) == doc


def test_export_uses_the_last_final_submission(tmp_path):
    ledger = PenaltyLedger()
    log = make_log(tmp_path, ledger)
    log.emit("harness", "final_submission", {"entries": entries(1.0)})
    ledger.add_human_geocode()
    log.emit("human", "human_geocode", {"lat": 38.722252, "lng": -9.139337, "place_label": "Baixa"})
    log.emit("human", "final_submission", {"entries": entries(0.5, "human_geocode")})
    doc = export(tmp_path, log)
    assert {e["origin"] for e in doc["final"]["locations"]} == {"human_geocode"}
    assert doc["final"]["penalty_state"]["multiplier"] == 0.5
    assert doc["totals"] == {}
    assert validate_export(doc) == []


def test_export_embeds_referenced_images_once(tmp_path):
    log = make_log(tmp_path)
    image_dir = tmp_path / "run1" / "pano1" / "images"
    image_dir.mkdir(parents=True)
    (image_dir / "abc.jpg").write_bytes(b"jpegbytes")
    ref = {"sha256": "abc", "path": str(image_dir / "abc.jpg"), "yaw": 0, "pitch": 0, "fov": 90}
    relative = {"sha256": "abc", "path": "pano1/images/abc.jpg"}
    log.emit("harness", "model_request", {"messages": [{"content": [ref, relative]}]})
    log.emit("tool", "tool_result", {"output": {"image": {"sha256": "gone", "path": "missing.jpg"}}})
    log.emit("harness", "final_submission", {"entries": entries()})
    assert "images" not in export(tmp_path, log)
    doc = export(tmp_path, log, embed_images=True)
    assert list(doc["images"]) == ["abc"]
    assert doc["images"]["abc"]["media_type"] == "image/jpeg"
    assert base64.b64decode(doc["images"]["abc"]["base64"]) == b"jpegbytes"
    assert validate_export(doc) == []


def test_validate_export_reports_each_problem(tmp_path):
    doc = export(tmp_path, write_run(tmp_path))

    def problems(mutate) -> str:
        broken = json.loads(json.dumps(doc))
        mutate(broken)
        found = validate_export(broken)
        assert found
        return " | ".join(found)

    assert "9 entries" in problems(lambda d: d["final"]["locations"].pop())
    assert "6 decimals" in problems(lambda d: d["final"]["locations"][0].update(lat=38.1234567))
    assert "out of range" in problems(lambda d: d["final"]["locations"][0].update(lat=91.0))
    assert "out of range" in problems(lambda d: d["final"]["locations"][0].update(lng=-181.0))
    assert "multiplier missing" in problems(lambda d: d["final"]["locations"][3].pop("multiplier"))
    assert "rank" in problems(lambda d: d["final"]["locations"][1].update(rank=1))
    assert "origin" in problems(lambda d: d["final"]["locations"][1].update(origin="operator"))
    assert "penalty_state" in problems(lambda d: d["final"].pop("penalty_state"))
    assert "from the counts" in problems(lambda d: d["final"]["penalty_state"].update(multiplier=1.0))
    assert "missing top-level key: team" in problems(lambda d: d.pop("team"))
    assert "strictly increasing" in problems(lambda d: d["events"][1].update(seq=1))
    assert "final_submission" in problems(lambda d: d["events"].pop(2))
    # A penalty in the final state that no event in the log accounts for, and the reverse.
    assert "0 mcq_asked event" in problems(lambda d: d["events"].pop(1))
    assert "1 human_cue event" in problems(lambda d: d["events"].insert(1, {**d["events"][1], "type": "human_cue"}))


def test_validate_export_rejects_an_export_without_an_answer(tmp_path):
    log = make_log(tmp_path)
    log.emit("harness", "run_start", {})
    found = validate_export(export(tmp_path, log))
    assert any("0 entries" in p for p in found)
    assert any("final_submission" in p for p in found)


def provisional(multiplier: float = 1.0) -> list[dict]:
    return entries(multiplier)


def test_export_recovers_the_provisional_list_when_the_run_died_before_finalising(tmp_path):
    """kill -9, SIGTERM or a power cut: no final_submission, but SPEC 6.5 put a list in the log."""
    ledger = PenaltyLedger()
    log = make_log(tmp_path, ledger)
    log.emit("harness", "run_start", {"filename": "pano1.jpg", "label": "Urban"})
    log.emit("agent", "candidates_update", {"hypotheses": [], "provisional": provisional(1.0)})
    ledger.add_cue()  # charged after that provisional list was written
    log.emit("human", "human_cue", {"text": "look left"})
    log.emit("agent", "tool_call", {"tool": "view_crop"})

    doc = export(tmp_path, log)

    locations = doc["final"]["locations"]
    assert len(locations) == 10 and [e["rank"] for e in locations] == list(range(1, 11))
    assert {(e["lat"], e["lng"]) for e in locations} == {(38.722252, -9.139337)}
    assert {e["multiplier"] for e in locations} == {0.8}  # re-stamped, not the stale 1.0
    assert doc["final"]["penalty_state"] == {"cues": 1, "mcqs": 0, "human_geocodes": 0, "multiplier": 0.8}
    assert doc["totals"]["stop_reason"] == "recovered_from_provisional"
    assert doc["totals"]["recovered_from_provisional"] is True
    # Usable, but the operator must still see that this answer was recovered.
    assert validate_export(doc) == ["events: no final_submission event"]


def test_export_without_any_candidates_still_reports_zero_locations(tmp_path):
    log = make_log(tmp_path)
    log.emit("harness", "run_start", {"filename": "pano1.jpg", "label": "Urban"})
    doc = export(tmp_path, log)
    assert doc["final"]["locations"] == [] and doc["totals"] == {}
    assert "final.locations has 0 entries, expected 10" in validate_export(doc)


def test_final_submission_wins_over_recovery(tmp_path):
    log = make_log(tmp_path)
    log.emit("agent", "candidates_update", {"hypotheses": [], "provisional": provisional(1.0)})
    moved = [{**e, "lat": 41.14961} for e in entries(1.0)]
    log.emit("harness", "final_submission", {"entries": moved})
    doc = export(tmp_path, log)
    assert {e["lat"] for e in doc["final"]["locations"]} == {41.14961}
    assert "recovered_from_provisional" not in doc["totals"]
