"""The console's state layer: the log fold behind every tile, the pure security helpers, the
console store, background jobs, the event hub and the idempotency store."""

from __future__ import annotations

import asyncio
import json
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

from astrolabio.config import Settings
from astrolabio.eventlog import EventLog
from astrolabio.runner import recover_run
from astrolabio.schema import Hypothesis, Label, PanoramaTask
from astrolabio.scoring import penalty_multiplier
from astrolabio.session import PanoramaSession
from server import runstate
from server.hub import CLOSED, EventHub, IdempotencyStore, fingerprint
from server.jobs import JobManager
from server.runstate import (
    INTERRUPTED_TEXT,
    LogFold,
    activity_text,
    console_digest,
    digest_events,
    fold_file,
    ledger_text,
    plan_text,
    read_events,
    run_totals,
    sort_tiles,
    stop_text,
)
from server.security import confine, redact, safe_id, safe_sha, safe_tag, truth_allowed
from server.store import LAUNCH_FIELDS, ConsoleStore, SettingsError, validate_launch_settings

REAL_LOG = Path(__file__).resolve().parent.parent / "runs/20261010T174153Z/eval_1331ae8dad3b.events.jsonl"
SHA_A, SHA_B, SHA_C = "a" * 64, "b" * 64, "c" * 64
CHAPEL = "roundabout by the white chapel"
MILL = "old mill on the river bend"
HYPOTHESES = [
    {"lat": 38.7, "lng": -9.14, "probability": 0.6, "radius_m": 20.0, "label": CHAPEL, "evidence": "tiles"},
    {"lat": 41.15, "lng": -8.61, "probability": 0.3, "radius_m": 20.0, "label": MILL, "evidence": "granite"},
]
BUDGET = {"effort": "xhigh", "soft_deadline_s": 900.0, "hard_deadline_s": 1200.0, "max_turns": 45, "max_spend_usd": 15.0}
FLAGS = {"allow_web": True, "hedge": False, "allow_duplicates": True, "penalty_scope": "whole_list", "max_mcq": 3}
ALLOCATOR = {"hedge": False, "allow_duplicates": True, "plan": "10x1", "rho": 0.5}
KEY = "k" * 20


def entries(lat: float, lng: float, multiplier: float = 1.0, origin: str = "agent") -> list[dict[str, Any]]:
    return [{"rank": r, "lat": lat, "lng": lng, "multiplier": multiplier, "origin": origin} for r in range(1, 11)]


class LogWriter:
    """Writes envelopes the way EventLog does, with a clock the test controls."""

    def __init__(self, path: Path, panorama_id: str = "p1") -> None:
        self.path, self.panorama_id = path, panorama_id
        self.seq = 0
        self.t = 0.0
        self.clock = datetime(2026, 10, 10, 10, 0, 0, tzinfo=timezone.utc)
        self.envelopes: list[dict[str, Any]] = []

    def emit(self, type_: str, data: dict[str, Any] | None = None, *, actor: str = "harness", dt: float = 1.0) -> dict[str, Any]:
        self.seq += 1
        self.t = round(self.t + dt, 3)
        self.clock += timedelta(seconds=dt)
        envelope = {
            "schema_version": "1.0",
            "seq": self.seq,
            "ts": self.clock.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "t_rel_s": self.t,
            "run_id": "run1",
            "panorama_id": self.panorama_id,
            "actor": actor,
            "type": type_,
            # deliberately wrong: the fold must count penalties from the events, never read this
            "penalty_state": {"cues": 0, "mcqs": 0, "human_geocodes": 0, "multiplier": 1.0},
            "data": data or {},
        }
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(envelope) + "\n")
        self.envelopes.append(envelope)
        return envelope

    def restart_clock(self) -> None:
        self.t = 0.0  # as RunManager does when a panorama leaves the queue

    def run_start(self, *, special: bool = True, no_human: bool = False, label: str = "Urban") -> dict[str, Any]:
        self.restart_clock()
        return self.emit(
            "run_start",
            {
                "panorama": {"panorama_id": self.panorama_id, "filename": "pano.jpg", "sha256": SHA_C, "width": 6080, "height": 3040},
                "label": label,
                "capture_timestamp": "20240601120000",
                "special": special,
                "model": "gpt-6.1-sol",
                "effort": "xhigh",
                "budget": BUDGET,
                "system_prompt": "x" * 2000,
                "flags": {**FLAGS, "no_human": no_human},
            },
            dt=0.0,
        )

    def turn(self, turn: int, content: list[dict[str, Any]], cost: float) -> None:
        self.emit("model_request", {"turn": turn, "message_count": 2 * turn - 1, "image_count": 2, "image_payload_chars": 1000, "messages": []})
        self.emit("model_response", {"turn": turn, "stop_reason": "tool_use", "content": content, "cost_usd": cost, "latency_ms": 900}, actor="agent")

    def crop(self, use_id: str, yaw: float, *, sha: str | None) -> tuple[int, int]:
        """A view_crop call and its result (an error when `sha` is None); returns both seqs."""
        call = self.emit("tool_call", {"tool": "view_crop", "tool_use_id": use_id, "input": {"yaw": yaw, "pitch": 5, "fov": 30}}, actor="agent")
        if sha is None:
            outcome = {"is_error": True, "duration_ms": 2, "output": "view_crop: rendering failed", "log": {}}
        else:
            image = {"sha256": sha, "path": f"images/{sha}.jpg", "yaw": yaw % 360, "pitch": 5.0, "fov": 30.0}
            log = {"image": image, "width": 1024, "height": 768, "adjusted": []}
            outcome = {"is_error": False, "duration_ms": 150, "output": "View centred", "log": log}
        result = self.emit("tool_result", {"tool": "view_crop", "tool_use_id": use_id, **outcome}, actor="tool")
        return call["seq"], result["seq"]

    def candidates(self, multiplier: float = 1.0) -> dict[str, Any]:
        return self.emit(
            "candidates_update",
            {"hypotheses": HYPOTHESES, "provisional": entries(38.7, -9.14, multiplier), "allocator": ALLOCATOR},
            actor="agent",
        )

    def final(self, origin: str = "agent", reason: str = "submit_locations", multiplier: float = 1.0, **extra: Any) -> dict[str, Any]:
        point = (38.7, -9.14) if origin == "agent" else (39.6, -8.4) if origin == "harness_fallback" else (38.71, -9.15)
        data = {
            "entries": entries(*point, multiplier, origin),
            "allocator": {"hedge": False, "allow_duplicates": True, "plan": "10x1", "rho": None},
            "origin": origin,
            "reason": reason,
            "reasoning_summary": None,
            "hypotheses": [],
            "special": True,
            **extra,
        }
        return self.emit("final_submission", data, actor="human" if origin == "human_geocode" else "harness")

    def run_end(self, stop_reason: str, turns: int = 0) -> dict[str, Any]:
        return self.emit("run_end", {"stop_reason": stop_reason, "turns": turns, "cost_usd": 0.0, "wall_time_s": self.t})


def assisted_log(path: Path) -> tuple[LogWriter, dict[str, int]]:
    """One assisted Special One from start to a submitted answer, with every channel used."""
    log, marks = LogWriter(path), {}
    log.run_start()
    marks["start"] = log.seq
    log.turn(1, [{"type": "thinking", "thinking": "Azulejo tiles and calçada."}, {"type": "text", "text": "Looks Portuguese."}], 0.10)
    marks["crop1_call"], marks["crop1_result"] = log.crop("c1", 135, sha=SHA_A)
    marks["crop2_call"], marks["crop2_result"] = log.crop("c2", 400, sha=None)
    marks["crop3_call"], marks["crop3_result"] = log.crop("c3", 400, sha=SHA_B)
    log.emit("tool_call", {"tool": "update_candidates", "tool_use_id": "u1", "input": {"hypotheses": HYPOTHESES}}, actor="agent")
    marks["candidates"] = log.candidates()["seq"]
    marks["cue"] = log.emit("human_cue", {"text": "The poles are concrete.", "char_count": 23}, actor="human")["seq"]
    log.emit("model_request", {"turn": 2, "message_count": 3, "image_count": 4, "image_payload_chars": 2000, "messages": []})
    marks["delivered"] = log.emit("human_cue_delivered", {"text": "The poles are concrete.", "char_count": 23, "turn": 2})["seq"]
    search = {"type": "server_tool_use", "name": "web_search", "input": {"type": "search", "query": "white chapel roundabout"}}
    log.emit(
        "model_response",
        {"turn": 2, "stop_reason": "tool_use", "cost_usd": 0.25, "latency_ms": 1200, "content": [search]},
        actor="agent",
    )
    marks["web"] = log.seq
    log.emit("tool_call", {"tool": "ask_multiple_choice", "tool_use_id": "m1", "input": {}}, actor="agent")
    question = {
        "id": "p1-mcq-1",
        "question": "Which place?",
        "options": [f"The {CHAPEL.upper()}", f"the {MILL}", "neither"],
        "why_it_matters": "They are 300 km apart.",
    }
    marks["asked"] = log.emit("mcq_asked", {**question, "asked_at": "2026-10-10T10:00:20.000Z"}, actor="agent")["seq"]
    click = {"selected_index": 1, "selected_option": f"the {MILL}", "wait_s": 12.5}
    marks["answered"] = log.emit("mcq_answered", {**question, **click}, actor="human", dt=12.5)["seq"]
    log.emit("mcq_asked", {**question, "id": "p1-mcq-2"}, actor="agent")
    silence = {"id": "p1-mcq-2", "selected_index": None, "selected_option": None, "wait_s": 90.0}
    marks["timeout"] = log.emit("mcq_answered", {**question, **silence}, dt=90.0)["seq"]
    log.emit("tool_call", {"tool": "search_places", "tool_use_id": "s1", "input": {"query": "Capela Branca"}}, actor="agent")
    found = {"is_error": False, "duration_ms": 800, "output": "1 result(s)", "log": {}}
    log.emit("tool_result", {"tool": "search_places", "tool_use_id": "s1", **found}, actor="tool")
    for attempt in (1, 2, 3):
        log.emit("api_retry", {"message": "Connection error.", "attempt": attempt, "delay_s": 2.0}, dt=5.0)
    marks["retries"] = log.seq
    log.turn(3, [{"type": "text", "text": "Committing."}], 0.05)
    marks["turn3"] = log.seq
    log.emit("tool_call", {"tool": "submit_locations", "tool_use_id": "f1", "input": {}}, actor="agent")
    marks["final"] = log.final(multiplier=0.722, reasoning_summary="The chapel roundabout matches.", hypotheses=HYPOTHESES)["seq"]
    marks["end"] = log.run_end("submitted", 3)["seq"]
    return log, marks


# ---------------------------------------------------------------------------------------------
# LogFold


def test_fold_of_an_assisted_run_gives_the_whole_tile(tmp_path: Path) -> None:
    path = tmp_path / "p1.events.jsonl"
    _, marks = assisted_log(path)
    tile = fold_file(path).tile(run_id="run1")
    json.dumps(tile, allow_nan=False)  # JSON-safe

    assert (tile["run_id"], tile["panorama_id"], tile["filename"], tile["label"]) == ("run1", "p1", "pano.jpg", "Urban")
    assert tile["special"] is True and tile["timestamp"] == "20240601120000"
    assert (tile["status"], tile["active"], tile["live"]) == ("done", False, False)
    assert tile["image"] == {"width": 6080, "height": 3040, "sha256": SHA_C}
    assert (tile["model"], tile["effort"], tile["budget"]) == ("gpt-6.1-sol", "xhigh", BUDGET)

    # penalties are counted from the events; every envelope's penalty_state says 1.0
    assert tile["penalty"] == {"cues": 1, "mcqs": 2, "human_geocodes": 0, "multiplier": penalty_multiplier(1, 2, 0)}
    assert [(row["kind"], row["before"], row["after"]) for row in tile["ledger"]] == [
        ("cue", 1.0, 0.8),
        ("mcq", 0.8, 0.76),
        ("mcq", 0.76, 0.722),
    ]
    assert tile["ledger"][0]["seq"] == marks["cue"]
    assert tile["ledger_text"] == "x0.722 = 0.8 cue x 0.95 MCQ x 0.95 MCQ"
    assert tile["multiplier_after"] == {"cue": penalty_multiplier(2, 2, 0), "geocode": penalty_multiplier(1, 2, 1)}
    assert (tile["mcqs_left"], tile["max_mcq"]) == (1, 3)

    assert tile["cues"] == [
        {"seq": marks["cue"], "t_rel_s": tile["cues"][0]["t_rel_s"], "char_count": 23, "state": "delivered",
         "delivered_t_rel_s": tile["cues"][0]["delivered_t_rel_s"], "delivered_seq": marks["delivered"], "delivered_turn": 2}
    ]
    assert tile["cues"][0]["delivered_t_rel_s"] > tile["cues"][0]["t_rel_s"]

    # every successful view_crop, numbered when asked for; the failed one keeps its number unused
    assert [(c["n"], c["seq_call"], c["seq_result"], c["sha256"]) for c in tile["crops"]] == [
        (1, marks["crop1_call"], marks["crop1_result"], SHA_A),
        (3, marks["crop3_call"], marks["crop3_result"], SHA_B),
    ]
    assert tile["crops"][1] | {"t_rel_s": 0} == {
        "n": 3, "seq_call": marks["crop3_call"], "seq_result": marks["crop3_result"], "t_rel_s": 0,
        "yaw": 40, "pitch": 5.0, "fov": 30.0, "width": 1024, "height": 768, "sha256": SHA_B,
    }  # yaw as rendered (wrapped), not as asked

    assert tile["pending_mcq"] is None
    assert tile["last_mcq"]["id"] == "p1-mcq-2" and tile["last_mcq"]["outcome"] == "timeout"
    assert tile["last_mcq"]["selected_index"] is None and tile["last_mcq"]["wait_s"] == 90.0

    assert tile["hypotheses"] == HYPOTHESES
    assert tile["final"] == entries(38.7, -9.14, 0.722) and tile["provisional"] == tile["final"]
    assert tile["chosen"] == {"lat": 38.7, "lng": -9.14}
    assert (tile["origin"], tile["stop_reason"], tile["stop_text"]) == ("agent", "submitted", "the agent submitted its answer")
    assert tile["allocator"] == {"hedge": False, "allow_duplicates": True, "plan": "10x1", "rho": None}
    assert tile["plan_text"] == "hedge off: best point repeated"

    # two places 300 km apart
    assert tile["clusters"] == 2 and tile["top_gap_m"] > 250_000 and tile["multimodal"] is True
    assert tile["gate_reason"].startswith("multi-modal")
    assert [(p["probability"], p["members"]) for p in tile["cluster_points"]] == [(0.6, 1), (0.3, 1)]

    # the agent's own belief: 60% on the chosen point, x3 for the Special One, x0.722
    expected = tile["expected_score"]
    assert expected["max"] == pytest.approx(3 * 16050.5, abs=1)
    assert expected["value"] == pytest.approx(0.6 * 0.722 * expected["max"], rel=0.01)
    assert expected["share"] == pytest.approx(expected["value"] / expected["max"], abs=1e-3)

    assert (tile["turns"], tile["segment"], tile["segment_turns"]) == (3, 1, 3)
    assert tile["spend_usd"] == pytest.approx(0.40)
    assert tile["last_seq"] == marks["end"] and tile["last_event_ts"].endswith("Z")
    assert tile["first_candidates_t_rel_s"] is not None
    assert tile["elapsed_s"] == pytest.approx(tile["last_event_t_rel_s"] - 1.0)  # frozen at the final_submission
    assert tile["api_trouble"] is False  # the turn that followed the retries cleared it
    assert tile["activity"]["text"] == "Submitting its answer" and tile["activity"]["tool"] == "submit_locations"
    assert tile["last_reasoning"] == {"text": "The chapel roundabout matches.", "seq": marks["final"], "t_rel_s": tile["last_reasoning"]["t_rel_s"]}

    # a record on disk: no control is live, whatever the log says
    assert tile["human_enabled"] is True and tile["geocode_enabled"] is False
    assert tile["human_window"] is None and tile["retryable"] is False
    assert tile["named_places"] == [CHAPEL, MILL]
    assert (tile["fallback_acknowledged"], tile["export_problems"]) == (False, None)
    assert not any("truth" in key or "distance" in key for key in tile)


def test_replay_at_a_seq_shows_the_state_of_that_moment(tmp_path: Path) -> None:
    path = tmp_path / "p1.events.jsonl"
    _, marks = assisted_log(path)

    before = fold_file(path, upto_seq=marks["candidates"] - 1).tile(run_id="run1", replay=True)
    assert before["status"] == "running" and before["hypotheses"] == [] and before["provisional"] == []
    assert before["expected_score"] is None and before["chosen"] is None and before["clusters"] == 0
    assert before["plan_text"] == "no answer yet" and before["stop_text"] == ""
    assert before["first_candidates_t_rel_s"] is None and before["turns"] == 1
    assert before["activity"]["text"] == "Updating its hypotheses"
    assert before["last_reasoning"]["text"] == "Looks Portuguese."

    queued = fold_file(path, upto_seq=marks["cue"]).tile(run_id="run1", replay=True)
    assert queued["cues"][0]["state"] == "queued"
    assert queued["penalty"]["multiplier"] == 0.8
    # the list would be submitted with the multiplier of that moment (R9)
    assert {e["multiplier"] for e in queued["provisional"]} == {0.8}
    assert queued["human_window"] == {"cue_closes_at_s": 1170.0, "mcq_closes_at_s": 1050.0}

    asking = fold_file(path, upto_seq=marks["asked"]).tile(run_id="run1", replay=True)
    assert asking["status"] == "awaiting_mcq" and asking["active"] is False
    assert asking["pending_mcq"]["id"] == "p1-mcq-1" and asking["pending_mcq"]["timeout_s"] == 90.0
    assert asking["pending_mcq"]["option_places"] == [
        {"index": 0, "label": CHAPEL, "lat": 38.7, "lng": -9.14},
        {"index": 1, "label": MILL, "lat": 41.15, "lng": -8.61},
        None,
    ]
    assert asking["activity"]["text"] == "Asking the operator a question"
    assert asking["last_seq"] == marks["asked"]

    answered = fold_file(path, upto_seq=marks["answered"]).tile(run_id="run1", replay=True)
    assert answered["status"] == "running" and answered["pending_mcq"] is None
    assert answered["last_mcq"] | {"t_rel_s": 0} == {
        "id": "p1-mcq-1", "seq": marks["answered"], "question": "Which place?",
        "options": [f"The {CHAPEL.upper()}", f"the {MILL}", "neither"],
        "outcome": "answered", "selected_index": 1, "wait_s": 12.5, "t_rel_s": 0,
    }

    web = fold_file(path, upto_seq=marks["web"]).tile(run_id="run1", replay=True)
    assert web["activity"] | {"t_rel_s": 0} == {
        "text": "Searching the web for white chapel roundabout", "tool": "web_search", "seq": marks["web"], "t_rel_s": 0,
    }

    failing = fold_file(path, upto_seq=marks["retries"]).tile(run_id="run1", replay=True)
    assert failing["api_trouble"] is True and failing["api_trouble_text"] == "3 API retries in 60 s: Connection error."
    assert fold_file(path, upto_seq=marks["retries"] - 1).tile(run_id="run1", replay=True)["api_trouble"] is False
    assert fold_file(path, upto_seq=marks["turn3"]).tile(run_id="run1", replay=True)["api_trouble"] is False


def test_a_log_that_stops_short_is_an_interrupted_tile_with_nothing_clickable(tmp_path: Path) -> None:
    path = tmp_path / "p1.events.jsonl"
    _, marks = assisted_log(path)
    tile = fold_file(path, upto_seq=marks["asked"]).tile(run_id="run1")  # killed while a question was open

    assert (tile["status"], tile["active"], tile["live"]) == ("interrupted", False, False)
    assert tile["pending_mcq"] is None and tile["human_window"] is None
    assert tile["geocode_enabled"] is False and tile["retryable"] is False
    assert tile["stop_text"] == INTERRUPTED_TEXT and tile["final"] is None
    assert tile["elapsed_s"] == tile["last_event_t_rel_s"]
    # the penalty stays and so does the best-so-far list a rebuild would recover
    assert tile["penalty"]["mcqs"] == 1 and len(tile["provisional"]) == 10
    assert tile["cues"][0]["state"] == "delivered"

    # a cue no session can deliver any more is not "queued"
    lost = fold_file(path, upto_seq=marks["cue"]).tile(run_id="run1")
    assert lost["status"] == "interrupted" and lost["cues"][0]["state"] == "undelivered"

    # a panorama that never wrote a log is known from run.json alone
    never = LogFold({"panorama_id": "p9", "path": "/sets/a/pano_9.jpg", "label": "non-Urban", "timestamp": None, "special": False})
    tile = never.tile(run_id="run1", budget=BUDGET)
    assert (tile["panorama_id"], tile["filename"], tile["label"], tile["status"]) == ("p9", "pano_9.jpg", "non-Urban", "interrupted")
    assert tile["budget"] == BUDGET and tile["activity"] is None and tile["last_seq"] == 0


def test_retry_starts_a_new_segment_and_keeps_what_was_charged(tmp_path: Path) -> None:
    path = tmp_path / "p1.events.jsonl"
    log = LogWriter(path)
    log.run_start()
    log.turn(1, [{"type": "text", "text": "Looking."}], 0.10)
    log.emit("human_cue", {"text": "Concrete poles.", "char_count": 15}, actor="human")
    log.emit("api_error", {"message": "401 key=sk-abcdefgh12345678 rejected", "status_code": 401}, dt=200.0)
    log.emit("human_cue_undelivered", {"text": "Concrete poles.", "reason": "api_error"})
    log.final("harness_fallback", "api_error", 0.8)
    first_end = log.run_end("api_error", 1)["seq"]

    failed = fold_file(path)
    tile = failed.tile(run_id="run1")
    assert (tile["origin"], tile["stop_reason"]) == ("harness_fallback", "api_error")
    assert tile["stop_text"] == "the model API failed: no hypothesis, fallback point used"
    assert tile["plan_text"].startswith("no hypothesis")
    assert tile["api_trouble"] is True and "sk-abcdefgh" not in tile["api_trouble_text"]
    assert tile["cues"][0]["state"] == "undelivered" and tile["expected_score"] is None
    assert tile["retryable"] is False  # nothing on disk can be retried: only a live session can

    retry = log.emit("retry", {"previous_stop_reason": "api_error"})["seq"]
    log.emit("run_resumed", {"previous_events": retry})
    reopened = fold_file(path).tile(run_id="run1", replay=True)
    assert (reopened["status"], reopened["final"], reopened["origin"], reopened["stop_reason"]) == ("pending", None, None, None)
    assert reopened["penalty"]["cues"] == 1 and reopened["turns"] == 1  # carried over

    log.run_start()
    log.turn(1, [{"type": "text", "text": "Second attempt."}], 0.30)
    update = log.candidates(0.8)
    log.final(multiplier=0.8, hypotheses=HYPOTHESES)
    log.run_end("submitted", 1)

    tile = fold_file(path).tile(run_id="run1")
    assert (tile["status"], tile["origin"], tile["stop_reason"]) == ("done", "agent", "submitted")
    assert (tile["segment"], tile["turns"], tile["segment_turns"]) == (2, 2, 1)
    assert tile["spend_usd"] == pytest.approx(0.40)  # money spent before the retry is not forgotten
    assert tile["penalty"] == {"cues": 1, "mcqs": 0, "human_geocodes": 0, "multiplier": 0.8}
    assert len(tile["ledger"]) == 1 and tile["api_trouble"] is False
    # times are those of the conversation that produced the answer
    assert tile["first_candidates_t_rel_s"] == update["t_rel_s"] < 10
    assert tile["elapsed_s"] < 10 and tile["last_seq"] > first_end

    # the fold is incremental: applying a repeat or an older event changes nothing
    fold = fold_file(path)
    assert fold.apply(log.envelopes[3]) is False and fold.apply(log.envelopes[-1]) is False
    assert fold.tile(run_id="run1") == tile


def test_geocode_after_the_run_is_the_answer_of_record(tmp_path: Path) -> None:
    path = tmp_path / "p1.events.jsonl"
    log = LogWriter(path)
    log.run_start()
    log.turn(1, [], 0.1)
    log.candidates()
    log.emit("mcq_asked", {"id": "p1-mcq-1", "question": "Which?", "options": ["a", "b"], "why_it_matters": ""}, actor="agent")
    log.emit("human_geocode", {"lat": 38.71, "lng": -9.15, "place_label": CHAPEL}, actor="human")
    log.final("human_geocode", "human_geocode", 0.475)
    # the question is released by the finalisation, not answered and not timed out
    log.emit("mcq_answered", {"id": "p1-mcq-1", "question": "Which?", "options": ["a", "b"], "selected_index": None, "wait_s": 3.0})
    log.run_end("finalized_externally", 1)

    tile = fold_file(path).tile(run_id="run1")
    assert (tile["status"], tile["origin"]) == ("done", "human_geocode")
    assert tile["stop_text"] == "human geocode: the operator's point is the answer"
    assert tile["plan_text"].startswith("human geocode")
    assert tile["chosen"] == {"lat": 38.71, "lng": -9.15}
    assert tile["penalty"]["multiplier"] == 0.475 and [row["kind"] for row in tile["ledger"]] == ["mcq", "geocode"]
    assert tile["last_mcq"]["outcome"] == "released" and tile["last_mcq"]["wait_s"] == 3.0
    assert tile["pending_mcq"] is None


def test_recovery_turns_an_interrupted_tile_into_a_done_one(tmp_path: Path) -> None:
    settings = Settings(runs_dir=tmp_path / "runs")
    run_dir = tmp_path / "runs" / "run1"
    run_dir.mkdir(parents=True)
    path = run_dir / "p1.events.jsonl"
    log = LogWriter(path)
    start = log.run_start()
    start["data"]["panorama"]["path"] = str(tmp_path / "pano.jpg")
    path.write_text(json.dumps(start) + "\n", encoding="utf-8")
    log.turn(1, [], 0.2)
    log.candidates()
    log.emit("human_cue", {"text": "Concrete poles.", "char_count": 15}, actor="human", dt=40.0)
    assert fold_file(path).tile(run_id="run1")["status"] == "interrupted"

    assert recover_run(run_dir, settings=settings) == ["p1"]
    tile = fold_file(path).tile(run_id="run1")
    assert (tile["status"], tile["origin"], tile["stop_reason"]) == ("done", "agent", "recovered_from_provisional")
    assert tile["stop_text"] == "recovered after a crash from the last provisional list"
    # what the dead run had charged and spent is still there, and so is how long it had run
    assert tile["penalty"] == {"cues": 1, "mcqs": 0, "human_geocodes": 0, "multiplier": 0.8}
    assert {e["multiplier"] for e in tile["final"]} == {0.8} and tile["cues"][0]["state"] == "undelivered"
    assert tile["spend_usd"] == pytest.approx(0.2) and tile["elapsed_s"] == log.t


def test_wording_helpers() -> None:
    assert ledger_text([], 1.0) == "x1.0 (no penalties)"
    assert ledger_text([{"kind": "cue"}, {"kind": "mcq"}], 0.76) == "x0.76 = 0.8 cue x 0.95 MCQ"
    assert ledger_text([{"kind": "geocode"}], 0.5) == "x0.5 = 0.5 geocode"

    assert stop_text("hard_deadline", "agent") == "hard deadline: best-so-far list used"
    assert stop_text("finalized_externally", "agent", "operator_stop") == "run stopped by the operator: best-so-far list used"
    assert stop_text(None, "agent", "global_watchdog").startswith("global watchdog")
    assert stop_text("not_started", "harness_fallback") == "never started before the run ended: no hypothesis, fallback point used"
    assert stop_text("recovered_from_provisional", "agent") == "recovered after a crash from the last provisional list"
    assert stop_text("recovered_no_hypotheses", "harness_fallback") == "recovered after a crash with no hypothesis: fallback point used"
    assert stop_text("submitted", "human_geocode").startswith("human geocode")  # pinned after the run
    assert stop_text("something_new", "agent") == "something new: best-so-far list used"
    assert stop_text(None, None) == ""

    assert plan_text(None) == "no answer yet"
    assert plan_text({"hedge": False, "plan": "10x1", "rho": 0.9}) == "hedge off: best point repeated"
    assert plan_text({"hedge": True, "plan": "8x1+2x2", "rho": 0.71}).startswith("hedge on: 8 x best point, 2 x second place")
    assert plan_text({"hedge": True, "plan": "6x1+4x2", "rho": 0.93}).startswith("hedge on: 6 x best point, 4 x second place")
    assert "too weak" in plan_text({"hedge": True, "plan": "10x1", "rho": 0.4})
    assert "no second place" in plan_text({"hedge": True, "plan": "10x1", "rho": None})
    assert plan_text({"hedge": False, "plan": "distinct", "rho": None}).startswith("duplicates off")

    assert activity_text(None) == "Looking at the panorama"
    assert activity_text("view_crop", {"yaw": 494.6, "pitch": 0, "fov": 20}) == "Zooming in at yaw 135"
    assert activity_text("search_places", {"query": "Capela  Branca"}) == "Searching place names for Capela Branca"
    ql = '[out:json][timeout:25];(nwr["amenity"="place_of_worship"](38.6,-9.3,38.8,-9.0););out center 50;'
    assert activity_text("overpass_query", {"ql": ql}) == "Searching OpenStreetMap for amenity=place_of_worship"
    assert activity_text("overpass_query", {"ql": "", "description": "a church beside a roundabout"}).endswith("a church beside a roundabout")
    assert activity_text("streetview_lookup", {}) == "Comparing street-level imagery"
    assert activity_text("satellite_tile", {}) == "Checking satellite imagery"
    assert activity_text("sun_position", {}) == "Checking the sun's position"
    assert activity_text("web_search", {"type": "open_page", "url": "https://example.org"}) == "Reading a web page"
    assert len(activity_text("search_places", {"query": "x" * 500})) <= 120


def test_tiles_sort_special_then_urban_and_totals_add_up() -> None:
    def tile(pid: str, label: str, special: bool, status: str, spend: float, multiplier: float, score: float | None) -> dict[str, Any]:
        return {
            "panorama_id": pid, "label": label, "special": special, "status": status, "spend_usd": spend,
            "budget": {"max_spend_usd": 15.0 if special else 8.0},
            "penalty": {"cues": int(multiplier < 1), "mcqs": 0, "human_geocodes": 0, "multiplier": multiplier},
            "expected_score": None if score is None else {"value": score, "max": 16050.5, "share": 0.5},
        }

    tiles = [
        tile("d", "non-Urban", False, "running", 0.5, 1.0, None),
        tile("b", "Urban", False, "done", 1.0, 0.8, 9000.0),
        tile("c", "Urban", True, "done", 2.0, 1.0, 30000.0),
        tile("a", "non-Urban", False, "pending", 0.0, 1.0, None),
    ]
    assert [t["panorama_id"] for t in sort_tiles(tiles)] == ["c", "b", "a", "d"]
    totals = run_totals(tiles)
    assert totals == {
        "done": 2, "total": 4, "spend_usd": 3.5, "spend_cap_usd": 39.0, "expected_score": 39000.0,
        "expected_score_max": pytest.approx(6 * 16050.5, abs=1), "lowest_multiplier": 0.8,
        "penalties": {"cues": 1, "mcqs": 0, "human_geocodes": 0},
    }
    assert run_totals([])["lowest_multiplier"] == 1.0
    # a tile that never started has no budget of its own: the run's settings supply the cap
    assert run_totals([{"special": True, "status": "interrupted"}], Settings())["spend_cap_usd"] == 15.0


async def test_live_session_overlays_what_only_it_knows(tmp_path: Path) -> None:
    settings = Settings(runs_dir=tmp_path / "runs", mcq_timeout_s=5.0)
    task = PanoramaTask(panorama_id="p1", path=tmp_path / "pano_1.jpg", label=Label.URBAN, special=True)
    session = PanoramaSession(task, settings, "run1")
    hub = EventHub()
    fold = hub.attach("run1", "p1", session.log)

    tile = fold.tile(run_id="run1", live_session=session)
    assert (tile["status"], tile["active"], tile["live"], tile["elapsed_s"]) == ("pending", False, True, 0.0)
    assert tile["filename"] == "pano_1.jpg" and tile["budget"] == settings.special.model_dump(mode="json")
    assert tile["human_window"] == {"cue_closes_at_s": 1170.0, "mcq_closes_at_s": 1200.0 - 5.0 - 60.0}
    assert tile["geocode_enabled"] is False and tile["mcq_allowed"] is True

    session.status = "running"
    session.update_candidates([Hypothesis(**h) for h in HYPOTHESES])
    session.submit_cue("The poles are concrete with a square section.", confirmed=True)
    tile = fold.tile(run_id="run1", live_session=session)
    assert (tile["status"], tile["active"]) == ("running", True)
    assert tile["named_places"] == [CHAPEL, MILL] and tile["geocode_enabled"] is True
    assert tile["cues"][0]["state"] == "queued"  # a live session can still deliver it
    assert tile["penalty"]["multiplier"] == 0.8 and {e["multiplier"] for e in tile["provisional"]} == {0.8}
    assert tile["provisional"] == [e.model_dump() for e in session.provisional]
    assert tile["elapsed_s"] > 0

    session.set_mcq_allowed(False)
    assert fold.tile(run_id="run1", live_session=session)["mcq_allowed"] is False

    session.finalize(reason="operator_finalize")
    tile = fold.tile(run_id="run1", live_session=session, acks=["fallback"], export_problem="final.locations has 9 entries")
    assert (tile["status"], tile["active"], tile["origin"]) == ("done", False, "agent")
    assert tile["stop_text"] == "finalised by the operator: best-so-far list used"
    assert tile["cues"][0]["state"] == "undelivered" and tile["retryable"] is False
    assert tile["geocode_enabled"] is True  # the last-resort geocode stays open after final
    assert (tile["fallback_acknowledged"], tile["export_problems"]) == (True, "final.locations has 9 entries")
    frozen = tile["elapsed_s"]
    assert fold.tile(run_id="run1", live_session=session)["elapsed_s"] == frozen
    json.dumps(tile, allow_nan=False)


async def test_live_pending_question_and_retryable_ending(tmp_path: Path) -> None:
    settings = Settings(runs_dir=tmp_path / "runs", mcq_timeout_s=5.0)
    task = PanoramaTask(panorama_id="p1", path=tmp_path / "pano.jpg", label=Label.URBAN)
    session = PanoramaSession(task, settings, "run1")
    hub = EventHub()
    fold = hub.attach("run1", "p1", session.log)
    session.status = "running"
    session.update_candidates([Hypothesis(**h) for h in HYPOTHESES])

    asking = asyncio.create_task(session.ask_mcq("Which place?", [f"the {CHAPEL}", "somewhere else"], "far apart"))
    await asyncio.sleep(0.01)
    tile = fold.tile(run_id="run1", live_session=session)
    assert (tile["status"], tile["active"]) == ("awaiting_mcq", True)
    assert tile["pending_mcq"]["id"] == "p1-mcq-1" and 0 < tile["pending_mcq"]["remaining_s"] <= 5.0
    assert tile["pending_mcq"]["option_places"][0]["index"] == 0 and tile["pending_mcq"]["option_places"][1] is None
    assert (tile["mcqs_left"], tile["penalty"]["mcqs"]) == (2, 1)

    session.answer_mcq("p1-mcq-1", 0)
    await asking
    tile = fold.tile(run_id="run1", live_session=session)
    assert tile["status"] == "running" and tile["pending_mcq"] is None
    assert tile["last_mcq"]["outcome"] == "answered" and tile["last_mcq"]["selected_index"] == 0

    # an ending without an agent answer is retryable while its session is alive
    fresh = PanoramaSession(PanoramaTask(panorama_id="p2", path=tmp_path / "pano.jpg", label=Label.URBAN), settings, "run1")
    fold2 = hub.attach("run1", "p2", fresh.log)
    fresh.finalize(reason="api_error")
    fresh.log.emit("harness", "run_end", {"stop_reason": "api_error", "turns": 0})
    tile = fold2.tile(run_id="run1", live_session=fresh)
    assert (tile["origin"], tile["retryable"], tile["elapsed_s"]) == ("harness_fallback", True, 0.0)
    assert fold2.tile(run_id="run1")["retryable"] is False


def test_fold_of_the_real_log_matches_its_run_end() -> None:
    if not REAL_LOG.exists():
        pytest.skip("no real run on this machine")
    events = read_events(REAL_LOG)
    end = next(e for e in reversed(events) if e["type"] == "run_end")["data"]
    tile = fold_file(REAL_LOG).tile(run_id="20261010T174153Z")
    json.dumps(tile, allow_nan=False)
    assert tile["status"] == "done" and tile["stop_reason"] == end["stop_reason"] and tile["origin"] == end["final_origin"]
    assert tile["turns"] == end["turns"] and tile["spend_usd"] == pytest.approx(end["cost_usd"], abs=1e-3)
    assert len(tile["final"]) == 10 and tile["last_seq"] == events[-1]["seq"]
    crops = [e for e in events if e["type"] == "tool_result" and e["data"]["tool"] == "view_crop" and not e["data"]["is_error"]]
    assert [c["seq_result"] for c in tile["crops"]] == [e["seq"] for e in crops]
    assert all(c["seq_call"] < c["seq_result"] and c["width"] and c["height"] for c in tile["crops"])
    digests = digest_events(events)
    assert [d["seq"] for d in digests] == [e["seq"] for e in events]
    assert all(isinstance(line["truncated"], bool) for d in digests for line in d["lines"])
    assert len(digest_events(events, after=100)) == len(events) - 100


# ---------------------------------------------------------------------------------------------
# digests


def test_digest_shapes(tmp_path: Path) -> None:
    path = tmp_path / "p1.events.jsonl"
    log, marks = assisted_log(path)
    digests = {d["seq"]: d for d in digest_events(log.envelopes)}
    keys = {"seq", "ts", "t_rel_s", "actor", "type", "multiplier", "turn", "category", "lines", "images", "tool", "is_error", "duration_ms", "crop_n"}
    assert all(set(d) == keys for d in digests.values())
    assert all(set(line) == {"kind", "text", "truncated"} for d in digests.values() for line in d["lines"])
    assert {d["category"] for d in digests.values()} == {"reasoning", "tools", "images", "human", "harness", "errors"}

    call, result = digests[marks["crop1_call"]], digests[marks["crop1_result"]]
    assert (call["type"], call["tool"], call["category"], call["crop_n"], call["turn"]) == ("tool_call", "view_crop", "tools", 1, 1)
    assert (result["category"], result["crop_n"], result["duration_ms"], result["is_error"]) == ("images", 1, 150, False)
    assert result["images"] == [{"sha256": SHA_A, "yaw": 135, "pitch": 5.0, "fov": 30.0, "width": 1024, "height": 768, "crop_n": 1}]
    assert result["lines"][0]["text"].startswith("view_crop (150 ms): ")

    failed = digests[marks["crop2_result"]]
    assert (failed["category"], failed["is_error"], failed["crop_n"], failed["images"]) == ("errors", True, 2, [])
    assert failed["lines"][0]["kind"] == "error"

    response = digests[marks["start"] + 2]
    assert (response["type"], response["category"], response["turn"], response["duration_ms"]) == ("model_response", "reasoning", 1, 900)
    assert [line["kind"] for line in response["lines"]] == ["thinking", "text"]

    assert digests[marks["cue"]]["lines"] == [{"kind": "human", "text": "Cue: The poles are concrete.", "truncated": False}]
    assert digests[marks["cue"]]["category"] == "human"
    assert "delivered to the agent at turn 2" in digests[marks["delivered"]]["lines"][0]["text"]
    assert digests[marks["asked"]]["lines"][0]["text"].startswith("MCQ: Which place? [")
    assert digests[marks["answered"]]["lines"][0]["text"] == f"MCQ answer: option 2: the {MILL}"
    assert digests[marks["timeout"]]["lines"][0]["text"] == "MCQ answer: no answer sent"
    assert digests[marks["retries"]]["category"] == "errors" and digests[marks["retries"]]["turn"] == 2
    assert digests[marks["retries"]]["lines"][0]["text"] == "API retry 3 in 2.0 s: Connection error."
    assert digests[marks["final"]]["lines"][0]["text"] == "FINAL origin=agent reason=submit_locations"
    assert digests[marks["end"]]["lines"][0]["text"].startswith("end: submitted, 3 turns")
    assert digests[marks["start"]]["lines"][0]["text"] == "start model=gpt-6.1-sol effort=xhigh"

    # a later page of the stream numbers its crops against the whole log
    tail = digest_events(log.envelopes, after=marks["crop3_call"] - 1)
    assert tail[0]["seq"] == marks["crop3_call"] and tail[0]["crop_n"] == 3


def test_digest_clipping_and_first_request_images() -> None:
    long_text, long_input = "t" * 9000, {"ql": "q" * 900}
    response = console_digest({"seq": 3, "type": "model_response", "data": {"turn": 4, "content": [
        {"type": "thinking", "thinking": "r" * 5000},
        {"type": "text", "text": long_text},
        {"type": "tool_use", "name": "overpass_query", "input": long_input},
        {"type": "server_tool_use", "name": "web_search", "input": {"type": "search", "query": "igreja"}},
    ], "stop_reason": "max_tokens"}})
    thinking, text, tool, hosted, stop = response["lines"]
    assert (len(thinking["text"]), thinking["truncated"]) == (5000, False)  # sent whole: the page clamps it
    assert (len(text["text"]), text["truncated"]) == (8000, True)
    assert tool["truncated"] is True and len(tool["text"]) == len("overpass_query ") + 400
    assert hosted["text"] == 'web_search search "igreja"' and stop["text"] == "stop_reason: max_tokens"
    assert response["turn"] == 4

    refusal = console_digest({"seq": 4, "type": "model_response", "data": {"content": [], "stop_reason": "refusal"}})
    assert (refusal["category"], refusal["is_error"]) == ("errors", True)

    call = console_digest({"seq": 5, "type": "tool_call", "data": {"tool": "overpass_query", "input": long_input}}, turn=7)
    assert call["turn"] == 7 and call["lines"][0]["truncated"] is True and call["crop_n"] is None

    views = [{"type": "image", "sha256": sha, "path": "x.jpg", "yaw": 90.0, "pitch": 0.0, "fov": 100.0} for sha in (SHA_A, SHA_B, SHA_A)]
    request = {"message_count": 1, "image_count": 2, "messages": [{"role": "user", "content": views}]}
    first = console_digest({"seq": 2, "type": "model_request", "data": {"turn": 1, **request}})
    assert (first["category"], [i["sha256"] for i in first["images"]]) == ("images", [SHA_A, SHA_B])
    later = console_digest({"seq": 9, "type": "model_request", "data": {"turn": 2, **request}})
    assert (later["category"], later["images"]) == ("harness", [])

    error = console_digest({"seq": 6, "type": "api_error", "data": {"message": "bad key https://x/y?key=AIzaSECRETSECRET&q=1"}})
    assert "AIzaSECRET" not in error["lines"][0]["text"] and "q=1" in error["lines"][0]["text"]
    assert console_digest({"seq": 7, "type": "mystery", "data": {}})["lines"] == []
    assert console_digest({"seq": 8, "type": "mystery", "data": {"a": 1}})["lines"][0]["text"] == '{"a": 1}'


# ---------------------------------------------------------------------------------------------
# security helpers


@pytest.mark.parametrize("value", ["run-1", "20261010T174153Z", "eval_1331ae8dad3b", "a.b_c-d", "A" * 100])
def test_safe_id_accepts_plain_names(value: str) -> None:
    assert safe_id(value, "run id") == value


@pytest.mark.parametrize(
    "value",
    ["", "..", ".", ".hidden", "a..b", "../x", "a/b", "a\\b", "%2e%2e", "a b", "a\x00b", "-rf", "A" * 101, "é", None, 7, ["a"]],
)
def test_safe_id_rejects_anything_that_could_leave_a_directory(value: Any) -> None:
    with pytest.raises(ValueError, match="invalid run id"):
        safe_id(value, "run id")


def test_safe_tag_and_sha() -> None:
    assert safe_tag("hedge_on-2") == "hedge_on-2" and safe_sha(SHA_A) == SHA_A
    for bad in ("", "Hedge", "a.b", "../x", "x" * 33, None):
        with pytest.raises(ValueError):
            safe_tag(bad)
    for bad in ("a" * 63, "A" * 64, "g" * 64, "a" * 64 + "/..", None):
        with pytest.raises(ValueError):
            safe_sha(bad)


def test_confine_resolves_before_it_compares(tmp_path: Path) -> None:
    root, outside = tmp_path / "root", tmp_path / "outside"
    (root / "sub").mkdir(parents=True)
    outside.mkdir()
    (root / "sub" / "pano.jpg").write_bytes(b"x")
    (outside / "secret.txt").write_text("s")
    resolved_root = root.resolve()

    assert confine(root / "sub" / "pano.jpg", [root]) == resolved_root / "sub" / "pano.jpg"
    assert confine(root, root) == resolved_root  # the root itself, and a single root not in a list
    assert confine(str(root / "sub" / ".." / "sub"), [outside, root]) == resolved_root / "sub"

    with pytest.raises(PermissionError):
        confine(root / ".." / "outside" / "secret.txt", [root])
    with pytest.raises(PermissionError):
        confine(outside, [root])
    with pytest.raises(PermissionError):
        confine(str(root) + "_sibling", [root], strict=False)  # a prefix of the name is not inside
    with pytest.raises(PermissionError):
        confine(root, [])
    with pytest.raises(PermissionError):
        confine("bad\x00name", [root])

    (root / "link").symlink_to(outside, target_is_directory=True)
    with pytest.raises(PermissionError):
        confine(root / "link" / "secret.txt", [root])
    (root / "inner").symlink_to(root / "sub", target_is_directory=True)
    assert confine(root / "inner" / "pano.jpg", [root]) == resolved_root / "sub" / "pano.jpg"

    with pytest.raises(FileNotFoundError):
        confine(root / "missing.json", [root])
    assert confine(root / "missing.json", [root], strict=False) == resolved_root / "missing.json"
    with pytest.raises(PermissionError):
        confine(root / ".." / "new.json", [root], strict=False)


def test_redact_removes_keys_wherever_they_appear(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-live-0123456789abcdef")
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "AIzaGOOGLEKEY1234")
    monkeypatch.setenv("MAPILLARY_TOKEN", "MLY|1234|abcdef")
    text = (
        "401 for sk-live-0123456789abcdef; GET https://maps.googleapis.com/x?location=1,2&key=AIzaGOOGLEKEY1234&size=640 "
        "and https://graph.mapillary.com/images?access_token=MLY|1234|abcdef&fields=id"
    )
    out = redact(text)
    assert "sk-live" not in out and "AIzaGOOGLE" not in out and "MLY|1234" not in out
    assert "location=1,2" in out and "size=640" in out and "fields=id" in out

    # values that are not the current keys still go when they sit where a secret sits
    assert redact("https://x/y?api_key=abc123&q=lisboa") == "https://x/y?api_key=REDACTED&q=lisboa"
    assert redact("retry https://x/y?token=t0k3n") == "retry https://x/y?token=REDACTED"
    assert redact("Authorization: Bearer abc.def-ghi rest") == "Authorization: Bearer REDACTED rest"
    assert redact('{"Authorization": "Bearer abcdefgh12345678"}') == '{"Authorization": "Bearer REDACTED"}'
    assert redact("header x-api-key: secretvalue") == "header x-api-key: REDACTED"
    assert "sk-proj" not in redact("Incorrect API key provided: sk-proj-ab***********wxyz.")
    assert redact("join with ?token=x", extra=["lan-token-123456"]) == "join with ?token=REDACTED"
    assert redact("the cookie was lan-token-123456", extra=["lan-token-123456"]) == "the cookie was REDACTED"

    assert redact("nothing secret: turn 3 of 30, yaw=135") == "nothing secret: turn 3 of 30, yaw=135"
    assert redact(ValueError("boom key=abcdefgh")) == "boom key=REDACTED"
    monkeypatch.setenv("MAPILLARY_TOKEN", "abc")  # too short to be a key: text is left alone
    assert redact("abcdef") == "abcdef"


def _write_log(path: Path, events: list[tuple[str, str, dict[str, Any]]]) -> None:
    lines = [json.dumps({"seq": i, "actor": actor, "type": type_, "data": data}) for i, (actor, type_, data) in enumerate(events, 1)]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_truth_is_only_for_autonomous_eval_runs(tmp_path: Path) -> None:
    run = tmp_path / "run"
    run.mkdir()
    start = ("harness", "run_start", {"flags": {"no_human": True}, "system_prompt": "never mention a human_cue"})
    _write_log(run / "a.events.jsonl", [start, ("agent", "model_response", {"content": "mcq_asked is a word"}), ("harness", "run_end", {})])
    _write_log(run / "b.events.jsonl", [start, ("harness", "mcq_answered", {"selected_index": None})])
    meta = {"kind": "eval", "settings": {"no_human": True}}

    assert truth_allowed(meta, run) is True
    assert truth_allowed({"kind": "eval"}, run) is True  # a CLI eval run: its logs prove no_human
    assert truth_allowed({"kind": "training", "settings": {"no_human": True}}, run) is False
    assert truth_allowed({"kind": "eval", "settings": {"no_human": False}}, run) is False
    assert truth_allowed({"kind": "eval", "settings": {}}, run) is False
    assert truth_allowed(None, run) is False
    assert truth_allowed({"kind": "eval"}, tmp_path / "empty") is False  # nothing proves anything

    for actor, type_ in (("human", "human_cue"), ("agent", "mcq_asked"), ("human", "mcq_answered"), ("human", "human_geocode")):
        other = tmp_path / type_ / actor
        other.mkdir(parents=True)
        _write_log(other / "a.events.jsonl", [start, (actor, type_, {})])
        assert truth_allowed(meta, other) is False, type_

    assisted = tmp_path / "assisted"
    assisted.mkdir()
    _write_log(assisted / "a.events.jsonl", [("harness", "run_start", {"flags": {"no_human": False}})])
    assert truth_allowed(meta, assisted) is False

    # the verdict follows the log: a human event appended later closes the gate
    with (run / "a.events.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"seq": 9, "actor": "human", "type": "human_geocode", "data": {}}) + "\n")
    assert truth_allowed(meta, run) is False


# ---------------------------------------------------------------------------------------------
# ConsoleStore


def test_console_store_round_trip(tmp_path: Path) -> None:
    data = tmp_path / "data"
    store = ConsoleStore(data)
    assert store.defaults() == {} and store.lan() == {"enabled": False, "token": None}
    assert store.paths() == {"runs_dir": None, "cache_dir": None}
    assert not (data / "console.json").exists()  # reading creates nothing

    chosen = {"hedge": True, "max_mcq": 2, "team": "Albatroz 1"}
    saved = store.set_defaults({**chosen, "standard": {**BUDGET, "max_turns": 20}, "disabled_tools": ["web_search", "view_crop"]})
    assert saved == {**chosen, "standard": {**BUDGET, "max_turns": 20}, "disabled_tools": ["view_crop", "web_search"]}
    store.set_defaults({"special": BUDGET, "max_mcq": None})  # merged key by key; null forgets
    lan = store.set_lan(True)
    assert lan["enabled"] is True and len(lan["token"]) >= 24
    assert store.set_lan(True)["token"] == lan["token"]  # no change, no new token
    store.set_paths({"runs_dir": str(tmp_path / "elsewhere" / "runs")})

    again = ConsoleStore(data)
    assert again.defaults() == {
        "hedge": True,
        "team": "Albatroz 1",
        "standard": {**BUDGET, "max_turns": 20},
        "special": BUDGET,
        "disabled_tools": ["view_crop", "web_search"],
    }
    Settings.model_validate({**Settings().model_dump(), **again.defaults()})  # the layers merge key by key
    assert again.lan() == lan
    assert again.paths() == {"runs_dir": str(tmp_path / "elsewhere" / "runs"), "cache_dir": None}
    assert again.set_lan(False) == {"enabled": False, "token": None}
    assert again.set_lan(True)["token"] != lan["token"]  # an old join link stops working

    on_disk = json.loads((data / "console.json").read_text(encoding="utf-8"))
    assert set(on_disk["defaults"]) <= set(LAUNCH_FIELDS)
    assert os.stat(data / "console.json").st_mode & 0o777 == 0o600
    assert [p.name for p in data.iterdir()] == ["console.json"]  # no temp file left behind

    assert again.set_defaults({"hedge": False}, replace=True) == {"hedge": False}

    (data / "console.json").write_text("{not json", encoding="utf-8")
    broken = ConsoleStore(data)
    assert broken.defaults() == {} and (data / "console.json.damaged").exists()
    (data / "console.json").write_text(json.dumps({"defaults": {"hedge": True, "nominatim_url": "http://evil", "max_mcq": 99}}), encoding="utf-8")
    assert ConsoleStore(data).defaults() == {"hedge": True}  # a hand-edited file is filtered, not trusted


def test_console_store_validation(tmp_path: Path) -> None:
    store = ConsoleStore(tmp_path / "data")
    for forbidden in ("cue_max_chars", "mcq_timeout_s", "nominatim_url", "runs_dir", "google_maps_api_key", "pricing", "prior_urban"):
        with pytest.raises(SettingsError) as caught:
            store.set_defaults({forbidden: 1})
        assert caught.value.code == "unknown_setting" and forbidden in caught.value.problems[0]
    with pytest.raises(SettingsError) as caught:
        store.set_defaults({"openai_api_key": None})
    assert caught.value.code == "unknown_setting"

    bad = [
        {"max_mcq": 4}, {"max_mcq": -1}, {"max_mcq": True}, {"concurrency": 0}, {"concurrency": 13}, {"global_watchdog_s": 0},
        {"model": "gpt-unknown"}, {"team": "x" * 41}, {"team": "a/b"}, {"hedge": "yes"}, {"penalty_scope": "none"},
        {"image_detail": "ultra"}, {"max_tokens": 0}, {"disabled_tools": ["submit_locations"]}, {"disabled_tools": ["nope"]},
        {"disabled_tools": "view_crop"}, {"standard": {**BUDGET, "soft_deadline_s": 900, "hard_deadline_s": 600}},
        {"standard": {**BUDGET, "max_turns": 0}}, {"special": {**BUDGET, "max_spend_usd": -1}},
        {"live": {**BUDGET, "effort": "extreme"}}, {"live": {**BUDGET, "deadline": 1}}, {"standard": 5},
        {"standard": {"max_spend_usd": 5}}, {"global_watchdog_s": float("nan")},
    ]
    for values in bad:
        with pytest.raises(SettingsError) as caught:
            store.set_defaults(values)
        assert caught.value.code == "invalid_setting" and caught.value.problems, values
    assert store.defaults() == {} and not store.path.exists()  # nothing was saved on the way

    with pytest.raises(SettingsError) as caught:
        validate_launch_settings({"max_mcq": 9, "concurrency": 99, "team": ""})
    assert len(caught.value.problems) == 3  # every fault at once, for the form
    assert validate_launch_settings({"model": "house-model"}, models=["house-model"]) == {"model": "house-model"}
    everything = validate_launch_settings({
        "model": "gpt-6.1-sol", "max_tokens": 32000, "image_detail": "high", "standard": BUDGET, "special": BUDGET, "live": BUDGET,
        "allow_web": False, "disabled_tools": [], "hedge": True, "allow_duplicates": False, "penalty_scope": "subsequent",
        "no_human": True, "mcq_allowed": False, "max_mcq": 0, "concurrency": 12, "global_watchdog_s": 3000, "embed_images": True, "team": "t",
    })
    assert set(everything) == set(LAUNCH_FIELDS)
    Settings.model_validate(everything)  # what passes here is a valid Settings

    # half a budget would wipe the other half where the layers of settings are merged
    with pytest.raises(SettingsError) as caught:
        store.set_defaults({"standard": {"max_spend_usd": 5, "effort": "low"}})
    assert caught.value.problems == [f"standard.{key} is missing" for key in ("soft_deadline_s", "hard_deadline_s", "max_turns")]

    for values in ({"runs_dir": "relative/runs"}, {"cache_dir": "/"}, {"runs_dir": 5}, {"data_dir": "/tmp/x"}):
        with pytest.raises(SettingsError):
            store.set_paths(values)
    with pytest.raises(SettingsError):
        store.set_lan("yes")  # type: ignore[arg-type]


def test_organiser_answers_follow_the_defaults(tmp_path: Path) -> None:
    store = ConsoleStore(tmp_path / "data")
    rows = store.organiser_answers()
    assert [row["id"] for row in rows] == [f"Q{n}" for n in range(1, 13)]
    assert all(set(row) == {"id", "question", "default", "control", "setting", "value", "note", "noted_at"} for row in rows)
    by_id = {row["id"]: row for row in rows}
    settings = {q: by_id[q]["setting"] for q in ("Q1", "Q2", "Q3", "Q4", "Q10", "Q5")}
    assert settings == {
        "Q1": "allow_web", "Q2": "penalty_scope", "Q3": "allow_duplicates", "Q4": "embed_images", "Q10": "clock_start", "Q5": None,
    }
    assert by_id["Q1"]["value"] is None and by_id["Q10"]["value"] == "launch" and by_id["Q2"]["default"] == "Whole list"
    # the caller's resolved defaults fill in what is not saved here
    assert {r["id"]: r["value"] for r in store.organiser_answers({"allow_web": True, "penalty_scope": "whole_list"})}["Q1"] is True

    rows = store.set_organiser_answers([
        {"id": "Q1", "value": False, "note": "Organisers: no internet for the agent."},
        {"id": "Q2", "value": "subsequent"},
        {"id": "Q7", "note": "Confirmed on Discord."},
        {"id": "Q10", "value": "launch"},
    ])
    by_id = {row["id"]: row for row in rows}
    assert by_id["Q1"]["value"] is False and by_id["Q1"]["note"].startswith("Organisers") and by_id["Q1"]["noted_at"].endswith("Z")
    assert by_id["Q2"]["value"] == "subsequent" and by_id["Q7"]["note"] == "Confirmed on Discord."
    # one stored copy: the answer is the default
    assert store.defaults() == {"allow_web": False, "penalty_scope": "subsequent"}
    store.set_defaults({"allow_web": True})
    assert {r["id"]: r for r in ConsoleStore(tmp_path / "data").organiser_answers()}["Q1"]["value"] is True

    stamp = by_id["Q7"]["noted_at"]
    assert {r["id"]: r for r in store.set_organiser_answers([{"id": "Q7", "note": "Confirmed on Discord."}])}["Q7"]["noted_at"] == stamp

    refused = (
        [{"id": "Q13", "note": "x"}],
        [{"id": "Q5", "value": "UTC"}],
        [{"id": "Q2", "value": "sometimes"}],
        [{"id": "Q7", "note": "x" * 2001}],
        {"Q1": True},
    )
    for items in refused:
        with pytest.raises(SettingsError):
            store.set_organiser_answers(items)  # type: ignore[arg-type]


def test_allowed_roots_never_reach_runs_settings_or_evaluation_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    data, runs, usb, evaldata = home / "app" / "data", home / "app" / "runs", tmp_path / "usb", home / "app" / "eval" / "data"
    for folder in (home / "Downloads", home / "Desktop", data / "sets" / "s1", runs / "r1", usb / "day2", evaldata):
        folder.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    store = ConsoleStore(data, protected_dirs=[runs, evaldata])
    sets = (data / "sets").resolve()

    defaults = store.allowed_roots()
    assert defaults[0] == sets and (home / "Downloads").resolve() in defaults and (home / "Desktop").resolve() in defaults
    assert home.resolve() not in defaults and all(root.is_absolute() for root in defaults)

    saved = store.set_paths({"allowed_roots": [str(usb), str(usb / "day2" / ".." / "day2"), str(usb)]})
    assert saved["allowed_roots"] == [str(sets), str(usb.resolve()), str((usb / "day2").resolve())]
    assert ConsoleStore(data, protected_dirs=[runs, evaldata]).allowed_roots() == [sets, usb.resolve(), (usb / "day2").resolve()]
    assert confine(usb / "day2", store.allowed_roots()) == (usb / "day2").resolve()
    with pytest.raises(PermissionError):
        confine(runs / "r1", store.allowed_roots())

    (tmp_path / "file.txt").write_text("x")
    refused = [
        "/", str(home), str(tmp_path), str(runs), str(runs / "r1"), str(data), str(home / "app"), str(evaldata),
        str(tmp_path / "missing"), str(tmp_path / "file.txt"), "relative/dir", "", 7,
        str(Path(runstate.__file__).resolve().parent),  # the repository itself
    ]
    for root in refused:
        with pytest.raises(SettingsError):
            store.set_paths({"allowed_roots": [root]})
    assert store.allowed_roots() == [sets, usb.resolve(), (usb / "day2").resolve()]  # refusals changed nothing

    # a root that was fine when saved is dropped once it holds something protected
    later = ConsoleStore(data, protected_dirs=[runs, evaldata, usb / "day2" / "cache"])
    assert later.allowed_roots() == [sets]
    assert store.set_paths({"allowed_roots": None})["allowed_roots"] == [str(root) for root in defaults]


# ---------------------------------------------------------------------------------------------
# EventHub


async def test_hub_messages_are_ordered_and_gap_free_from_any_thread() -> None:
    hub = EventHub()
    assert hub.publish("index", {}) is True and hub.seq == 1  # nobody listening: still numbered
    snapshot_seq, queue = hub.subscribe()
    assert snapshot_seq == 1

    def worker(name: str) -> None:
        for i in range(50):
            hub.publish("job", {"from": name, "i": i})

    threads = [threading.Thread(target=worker, args=(name,)) for name in ("a", "b", "c")]
    for thread in threads:
        thread.start()
    for i in range(50):
        hub.publish("run", {"i": i, "seq": "ignored", "kind": "ignored"})
        await asyncio.sleep(0)
    await asyncio.to_thread(lambda: [thread.join() for thread in threads])
    await asyncio.sleep(0.05)

    messages = [queue.get_nowait() for _ in range(queue.qsize())]
    assert [m["seq"] for m in messages] == list(range(2, 202))  # consecutive, starting after the snapshot
    assert {m["kind"] for m in messages} == {"job", "run"}
    for name in ("a", "b", "c"):  # each sender's own order is kept
        assert [m["i"] for m in messages if m.get("from") == name] == list(range(50))
    assert hub.seq == 201

    hub.unsubscribe(queue)
    hub.publish("index", {})
    assert queue.empty() and hub.subscriber_count == 0


async def test_subscribe_and_snapshot_are_one_step() -> None:
    hub = EventHub()
    state = {"value": 0}

    # The worker may run this far ahead of the loop and no further: an unbounded flood overflows
    # the subscriber's queue on a busy machine, and the hub then (rightly) closes it.
    room = threading.Semaphore(100)

    def change() -> dict[str, Any]:
        room.release()
        state["value"] += 1
        return {"value": state["value"]}

    stop = threading.Event()

    def worker() -> None:
        while not stop.is_set():
            if room.acquire(timeout=0.05):
                hub.publish("run", change)  # the state changes on the loop thread, as the seq is assigned

    hub.bind()
    thread = threading.Thread(target=worker)
    thread.start()
    try:
        for _ in range(20):
            await asyncio.sleep(0.002)
            seq, queue = hub.subscribe()
            snapshot = dict(state)  # same synchronous block: nothing can slip in between
            first = await asyncio.wait_for(queue.get(), 1)
            assert first["seq"] == seq + 1 and first["value"] == snapshot["value"] + 1
            hub.unsubscribe(queue)
    finally:
        stop.set()
        await asyncio.to_thread(thread.join)


async def test_a_subscriber_that_falls_behind_is_closed_not_gapped() -> None:
    hub = EventHub(queue_size=5)
    _, slow = hub.subscribe()
    _, fast = hub.subscribe()
    for i in range(5):
        hub.publish("run", {"i": i})
        fast.get_nowait()
    hub.publish("run", {"i": 5})  # one more than the slow reader has room for
    assert slow.qsize() == 1 and slow.get_nowait() is CLOSED
    assert fast.get_nowait()["i"] == 5 and hub.subscriber_count == 1
    hub.publish("run", {"i": 6})
    assert slow.empty() and fast.get_nowait()["seq"] == 7

    # a payload that fails to build, or builds to nothing, sends nothing and burns no seq
    hub.publish("run", lambda: None)
    hub.publish("run", lambda: 1 / 0)
    assert fast.empty() and hub.seq == 7


async def test_hub_follows_a_live_log_once(tmp_path: Path) -> None:
    hub = EventHub()
    log = EventLog("run1", "p1", tmp_path / "p1.events.jsonl")
    log.emit("harness", "run_start", {"label": "Urban", "flags": {"no_human": False}, "budget": BUDGET})
    seen: list[tuple[str, str, int]] = []

    def pano(run_id: str, pid: str, envelope: dict[str, Any], fold: LogFold) -> dict[str, Any] | None:
        seen.append((run_id, pid, envelope["seq"]))
        if envelope["type"] == "quiet":
            return None
        return {"run_id": run_id, "panorama_id": pid, "event": fold.digest(envelope), "tile": fold.tile(run_id=run_id, replay=True)}

    hub.pano_payload = pano
    fold = hub.attach("run1", "p1", log)
    assert fold.last_seq == 1 and fold.status == "running"  # primed with what the log already held
    assert hub.attach("run1", "p1", log) is fold and hub.fold("run1", "p1") is fold  # a retry attaches again
    _, queue = hub.subscribe()

    log.emit("human", "human_cue", {"text": "Concrete poles.", "char_count": 15})
    message = queue.get_nowait()
    assert (message["seq"], message["kind"], message["run_id"], message["panorama_id"]) == (1, "pano", "run1", "p1")
    assert message["event"]["type"] == "human_cue" and message["tile"]["penalty"]["cues"] == 1
    assert message["tile"]["last_seq"] == 2 and queue.empty()  # one listener: folded and published once

    # emitted from worker threads: folded on the loop, in an order the fold accepts
    await asyncio.gather(*(asyncio.to_thread(log.emit, "harness", "note", {"i": i}) for i in range(20)))
    await asyncio.sleep(0.05)
    published = [queue.get_nowait() for _ in range(queue.qsize())]
    assert [m["seq"] for m in published] == list(range(2, 2 + len(published)))
    assert [m["tile"]["last_seq"] for m in published] == sorted(m["tile"]["last_seq"] for m in published)
    assert fold.last_seq == 22

    log.emit("harness", "quiet", {})
    assert queue.empty() and seen[-1] == ("run1", "p1", 23) and fold.last_seq == 23

    hub.detach_run("run1")
    log.emit("harness", "note", {})
    await asyncio.sleep(0)
    assert queue.empty() and fold.last_seq == 23 and hub.fold("run1", "p1") is None

    # without a builder the hub still announces the event with a record tile
    hub.pano_payload = None
    again = hub.attach("run1", "p1", log)
    assert again is not fold and again.last_seq == 24
    log.emit("harness", "note", {})
    message = queue.get_nowait()
    assert message["event"]["seq"] == 25 and message["tile"]["status"] == "interrupted"


def test_hub_binds_its_loop_lazily_and_drops_when_there_is_none(tmp_path: Path) -> None:
    hub = EventHub()  # built before any loop exists, as the Workspace is
    assert hub.loop is None and hub.publish("index", {}) is False and hub.seq == 0
    log = EventLog("run1", "p1", tmp_path / "p1.events.jsonl")
    fold = hub.attach("run1", "p1", log)
    log.emit("human", "human_cue", {"text": "Concrete poles."})  # no loop yet: not folded for now
    assert fold.last_seq == 0

    async def first() -> list[dict[str, Any]]:
        _, queue = hub.subscribe()
        log.emit("harness", "note", {})
        hub.publish("index", {})
        return [queue.get_nowait() for _ in range(queue.qsize())]

    # the next event shows the gap, and the missed one (a penalty) is read back from the file
    messages = asyncio.run(first())
    assert [(m["seq"], m["kind"]) for m in messages] == [(1, "pano"), (2, "pano"), (3, "index")]
    assert [m["event"]["seq"] for m in messages[:2]] == [1, 2]
    assert fold.last_seq == 2 and fold.counts["cue"] == 1
    closed = hub.loop
    assert closed is not None and closed.is_closed()
    log.emit("harness", "note", {})  # after shutdown: dropped, never raised
    assert hub.publish("index", {}) is False and fold.last_seq == 2

    async def second() -> int:
        return hub.subscribe()[0]

    assert asyncio.run(second()) == 3 and hub.loop is not closed  # a new loop is adopted


# ---------------------------------------------------------------------------------------------
# IdempotencyStore


async def test_concurrent_duplicates_run_the_factory_once() -> None:
    store = IdempotencyStore()
    calls = 0
    release = asyncio.Event()

    async def charge() -> dict[str, Any]:
        nonlocal calls
        calls += 1
        await release.wait()
        return {"ok": True, "tile": {"penalty": {"cues": calls}}}

    scope = "POST /api/runs/r/pano/p/cue"
    running = [asyncio.create_task(store.run(scope, KEY, charge, fingerprint="f1")) for _ in range(5)]
    await asyncio.sleep(0.01)
    assert calls == 1
    release.set()
    results = await asyncio.gather(*running)
    assert calls == 1
    assert [replayed for _, replayed in results] == [False, True, True, True, True]
    assert all(body == {"ok": True, "tile": {"penalty": {"cues": 1}}} for body, _ in results)

    body, replayed = await store.run(scope, KEY, charge, fingerprint="f1")  # a retry after a timeout
    assert replayed is True and calls == 1
    body["tile"]["penalty"]["cues"] = 99  # a caller may change its copy
    assert (await store.run(scope, KEY, charge, fingerprint="f1"))[0]["tile"]["penalty"]["cues"] == 1

    other, replayed = await store.run(scope, "another-key-0123456789", charge, fingerprint="f1")
    assert replayed is False and calls == 2 and other["tile"]["penalty"]["cues"] == 2


async def test_idempotency_key_rules() -> None:
    store = IdempotencyStore()
    calls = 0

    async def act() -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return {"n": calls}

    # no key: just runs, every time; unless the endpoint requires one
    assert await store.run("POST /a", None, act) == ({"n": 1}, False)
    assert await store.run("POST /a", None, act) == ({"n": 2}, False)
    with pytest.raises(HTTPException) as caught:
        await store.run("POST /a", None, act, required=True)
    assert (caught.value.status_code, caught.value.detail["code"]) == (400, "idempotency_key_required")
    for bad in ("short", "has space in it 0123456789", "x" * 65, "../../etc/passwd-0123"):
        with pytest.raises(HTTPException) as caught:
            await store.run("POST /a", bad, act)
        assert (caught.value.status_code, caught.value.detail["code"]) == (400, "idempotency_key_invalid")
    assert calls == 2

    first = fingerprint(b'{"text": "poles"}')
    assert first == fingerprint('{"text": "poles"}') != fingerprint(b'{"text": "wires"}')
    assert fingerprint({"b": 1, "a": 2}) == fingerprint({"a": 2, "b": 1})
    assert await store.run("POST /a", KEY, act, fingerprint=first) == ({"n": 3}, False)
    for scope, body in (("POST /a", fingerprint(b"other")), ("POST /b", first), ("DELETE /a", first)):
        with pytest.raises(HTTPException) as caught:
            await store.run(scope, KEY, act, fingerprint=body)
        assert (caught.value.status_code, caught.value.detail["code"]) == (422, "idempotency_key_reuse")
        assert caught.value.detail["message"]
    assert calls == 3 and await store.run("POST /a", KEY, act, fingerprint=first) == ({"n": 3}, True)


async def test_a_refusal_is_remembered_and_a_failure_is_not() -> None:
    store = IdempotencyStore()
    calls = {"conflict": 0, "broken": 0, "crash": 0}

    async def conflict() -> dict[str, Any]:
        calls["conflict"] += 1
        raise HTTPException(409, {"message": "this panorama is already final", "action": None})

    async def broken() -> dict[str, Any]:
        calls["broken"] += 1
        if calls["broken"] == 1:
            raise HTTPException(503, {"message": "export failed"})
        return {"ok": True}

    async def crash() -> dict[str, Any]:
        calls["crash"] += 1
        if calls["crash"] == 1:
            raise RuntimeError("disk full")
        return {"ok": True}

    with pytest.raises(HTTPException) as first:
        await store.run("POST /a", KEY, conflict)
    with pytest.raises(HTTPException) as second:
        await store.run("POST /a", KEY, conflict)
    assert calls["conflict"] == 1  # a 4xx is an answer: the repeat gets the same one
    assert (second.value.status_code, second.value.detail) == (409, first.value.detail)
    assert second.value.headers == {"Idempotency-Replayed": "true"} and not first.value.headers

    key = "b" * 20
    with pytest.raises(HTTPException) as failed:
        await store.run("POST /b", key, broken)
    assert failed.value.status_code == 503
    assert await store.run("POST /b", key, broken) == ({"ok": True}, False)  # a 5xx may be tried again
    assert calls["broken"] == 2

    key = "c" * 20
    with pytest.raises(RuntimeError, match="disk full"):
        await store.run("POST /c", key, crash)
    assert await store.run("POST /c", key, crash) == ({"ok": True}, False)
    assert await store.run("POST /c", key, crash) == ({"ok": True}, True)


async def test_idempotent_work_survives_a_dropped_connection_and_expires_after_an_hour() -> None:
    now = [1000.0]
    store = IdempotencyStore(clock=lambda: now[0])
    calls = 0
    completed: list[int] = []
    release = asyncio.Event()

    async def charge() -> dict[str, Any]:
        nonlocal calls
        calls += 1
        await release.wait()
        completed.append(calls)
        return {"n": calls}

    request = asyncio.create_task(store.run("POST /a", KEY, charge))
    await asyncio.sleep(0.01)
    request.cancel()  # the browser went away mid-request
    with pytest.raises(asyncio.CancelledError):
        await request
    release.set()
    assert await store.run("POST /a", KEY, charge) == ({"n": 1}, True)  # the charge happened once and is on record

    # the same holds without a key: the work is not cut off half way
    release.clear()
    request = asyncio.create_task(store.run("POST /a", None, charge))
    await asyncio.sleep(0.01)
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    release.set()
    await asyncio.sleep(0.01)
    assert completed == [1, 2]
    calls = 1

    now[0] += 3599
    assert await store.run("POST /a", KEY, charge) == ({"n": 1}, True)
    now[0] += 2
    assert await store.run("POST /a", KEY, charge) == ({"n": 2}, False) and len(store) == 1


# ---------------------------------------------------------------------------------------------
# JobManager


async def test_job_reports_progress_from_its_worker_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAPILLARY_TOKEN", "MLY|secret|token")
    hub = EventHub()
    jobs = JobManager(hub)
    _, queue = hub.subscribe()
    loop_thread = threading.get_ident()
    worker_threads: list[int] = []
    gate = threading.Event()

    def build(job: Any) -> dict[str, Any]:
        worker_threads.append(threading.get_ident())
        job.progress(0, 3, "starting")
        gate.wait(2)
        for i in range(1, 4):
            job.progress(i, text=f"area {i} of 3")
            job.log(f"fetched https://graph.mapillary.com/images?access_token=MLY|secret|token&area={i}")
        return {"count": 3, "path": Path("eval/data")}

    job = jobs.start("eval_build", "Build evaluation set", build)
    assert job.state == "queued" and jobs.get(job.id) is job and safe_id(job.id, "job id")
    await asyncio.sleep(0.05)
    assert jobs.find("eval_build", "running") is job and jobs.find("eval_build", {"queued", "running"}) is job
    assert jobs.find("eval_build", "done") is None and jobs.find("export") is None
    assert job.to_dict()["progress"] == {"done": 0, "total": 3, "text": "starting"}
    gate.set()
    assert (await job.wait()) is job
    await asyncio.sleep(0.01)

    assert worker_threads and worker_threads[0] != loop_thread
    final = job.to_dict()
    json.dumps(final)
    assert set(final) == {"id", "kind", "title", "state", "progress", "log", "result", "error", "created_at", "finished_at", "run_id"}
    assert (final["state"], final["error"], final["run_id"]) == ("done", None, None)
    assert final["progress"] == {"done": 3, "total": 3, "text": "area 3 of 3"}
    assert final["result"] == {"count": 3, "path": "eval/data"} and final["finished_at"] >= final["created_at"]
    assert len(final["log"]) == 3 and all("secret" not in line and "area=" in line for line in final["log"])

    messages = [queue.get_nowait() for _ in range(queue.qsize())]
    assert [m["seq"] for m in messages] == list(range(1, len(messages) + 1))
    assert all(m["kind"] == "job" and m["job"]["id"] == job.id for m in messages)
    states = [m["job"]["state"] for m in messages]
    assert states[0] == "queued" and "running" in states and states[-1] == "done"
    assert states == sorted(states, key=["queued", "running", "done"].index)
    assert messages[-1]["job"] == final
    done = [m["job"]["progress"]["done"] for m in messages]
    assert done == sorted(done)
    assert jobs.find("eval_build", "running") is None and jobs.find("eval_build") is job and jobs.list() == [job]


async def test_job_failures_async_work_and_log_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0123456789abcdef")
    jobs = JobManager(EventHub())

    def explode(job: Any) -> None:
        job.log("about to fail")
        raise RuntimeError("401 with key sk-test-0123456789abcdef")

    failed = await jobs.start("export", "Rebuild exports", explode, run_id="run1").wait()
    state = failed.to_dict()
    assert (state["state"], state["result"], state["run_id"]) == ("failed", None, "run1")
    assert state["error"] == "RuntimeError: 401 with key REDACTED" and state["finished_at"]
    assert state["log"] == ["about to fail", "failed: RuntimeError: 401 with key REDACTED"]

    async def score(job: Any) -> dict[str, Any]:
        for i in range(250):
            job.log(f"line {i}")
        job.progress(250, 250)
        await asyncio.sleep(0)
        return {"scored": 250}

    scored = await jobs.start("eval_score", "Score run", score, run_id="run2").wait()
    state = scored.to_dict()
    assert (state["state"], state["result"]) == ("done", {"scored": 250})
    assert len(state["log"]) == 200 and state["log"][-1] == "line 249" and state["log"][0] == "line 50"

    assert jobs.find("export", "failed", run_id="run1") is failed and jobs.find("export", run_id="run2") is None
    assert jobs.find("eval_score", run_id="run2") is scored and jobs.list() == [failed, scored]
    assert jobs.get("nope") is None
    with pytest.raises(ValueError, match="unknown job kind"):
        jobs.start("mystery", "x", explode)

    # without a hub a job still runs and keeps its state (a test, or a tool outside the server)
    quiet = await JobManager().start("unzip", "Unpack", lambda job: job.progress(1, 1) or "ok").wait()
    assert quiet.to_dict()["result"] == "ok"
