"""Replay, the inspectors and the per-panorama downloads of the console (contract 4.4).

Offline: synthetic logs in tmp_path, the scripted demo model for a run the server owns, and the
router on a bare FastAPI app (the console app itself belongs to another module)."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from PIL import Image

from astrolabio import prompts
from astrolabio.config import Budget, Settings
from astrolabio.loop import MAX_IMAGE_PAYLOAD_CHARS, MAX_REQUEST_IMAGES
from astrolabio.scoring import penalty_multiplier
from server import inspect as inspector
from server.devmodel import DemoClient
from server.routes.replay import router
from server.runstate import read_events
from server.workspace import RUN_FILE, Workspace

REAL_LOG = Path(__file__).resolve().parent.parent / "runs/20261010T174153Z/eval_1331ae8dad3b.events.jsonl"
RUN, PANO = "run1", "pano_a"
FAST = Budget(effort="high", soft_deadline_s=600, hard_deadline_s=840, max_turns=8, max_spend_usd=8.0)
BUDGET = {"effort": "high", "soft_deadline_s": 600.0, "hard_deadline_s": 840.0, "max_turns": 30, "max_spend_usd": 8.0}
FLAGS = {"allow_web": True, "no_human": False, "hedge": False, "allow_duplicates": True, "penalty_scope": "whole_list", "max_mcq": 3}
ALLOCATOR = {"hedge": False, "allow_duplicates": True, "plan": "10x1", "rho": 0.5}
SYSTEM_PROMPT = "You are the geolocation agent.\n  Keep this text byte for byte.\n"
TOOLS = [{"type": "function", "name": "view_crop", "strict": True}, {"type": "web_search"}]
PROVENANCE = {"filename": "pano_a.jpg", "label": {"value": "Urban", "source": "operator", "parsed": None}}
CHAPEL = {"lat": 38.7, "lng": -9.14, "probability": 0.6, "radius_m": 20.0, "label": "white chapel", "evidence": "tiles"}
MILL = {"lat": 41.15, "lng": -8.61, "probability": 0.3, "radius_m": 20.0, "label": "old mill", "evidence": "granite"}
QUAY = {"lat": 41.14, "lng": -8.61, "probability": 0.1, "radius_m": 20.0, "label": "granite quay", "evidence": "river"}
GOOGLE_KEY = "google-key-0123456789"
TRUTH_LAT = 12.345678  # planted next to the logs: it must never come back


def entries(lat: float, lng: float, multiplier: float = 1.0, origin: str = "agent") -> list[dict[str, Any]]:
    return [{"rank": r, "lat": lat, "lng": lng, "multiplier": multiplier, "origin": origin} for r in range(1, 11)]


def usage(tokens: int, cached: int = 0, out: int = 100, reasoning: int = 40) -> dict[str, int]:
    return {
        "input_tokens": tokens,
        "cached_input_tokens": cached,
        "cache_write_tokens": 0,
        "output_tokens": out,
        "reasoning_tokens": reasoning,
        "web_search_requests": 0,
    }


class Log:
    """Writes a panorama's events.jsonl the way EventLog does, one envelope per `add`."""

    def __init__(self, run_dir: Path, pid: str = PANO) -> None:
        self.run_dir, self.pid = run_dir, pid
        self.path = run_dir / f"{pid}.events.jsonl"
        self.image_dir = run_dir / pid / "images"
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self.seq, self.t = 0, 0.0
        self.counts = {"human_cue": 0, "mcq_asked": 0, "human_geocode": 0}

    def add(self, type_: str, data: dict[str, Any] | None = None, *, actor: str = "harness", dt: float = 1.0) -> int:
        self.seq += 1
        self.t += dt
        if type_ in self.counts:
            self.counts[type_] += 1
        cues, mcqs, geocodes = self.counts.values()
        envelope = {
            "schema_version": "1.0",
            "seq": self.seq,
            "ts": (datetime(2026, 10, 11, 10, tzinfo=timezone.utc) + timedelta(seconds=self.t)).isoformat(),
            "t_rel_s": self.t,
            "run_id": self.run_dir.name,
            "panorama_id": self.pid,
            "actor": actor,
            "type": type_,
            "penalty_state": {
                "cues": cues,
                "mcqs": mcqs,
                "human_geocodes": geocodes,
                "multiplier": penalty_multiplier(cues, mcqs, geocodes),
            },
            "data": data or {},
        }
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(envelope) + "\n")
        return self.seq

    def image(self, width: int, height: int, shade: int) -> str:
        """A view saved as the run saves them: <sha256>.jpg in the panorama's image directory."""
        buffer = io.BytesIO()
        Image.new("RGB", (width, height), (shade, shade, shade)).save(buffer, "JPEG")
        sha = hashlib.sha256(buffer.getvalue()).hexdigest()
        (self.image_dir / f"{sha}.jpg").write_bytes(buffer.getvalue())
        return sha

    def start(self, **extra: Any) -> int:
        return self.add(
            "run_start",
            {
                "panorama": {"panorama_id": self.pid, "filename": f"{self.pid}.jpg", "sha256": "f" * 64, "width": 6080, "height": 3040},
                "label": "Urban",
                "capture_timestamp": "20240102030405",
                "special": True,
                "model": "gpt-6.1-sol",
                "effort": "high",
                "budget": BUDGET,
                "request": {"model": "gpt-6.1-sol", "store": False},
                "system_prompt": SYSTEM_PROMPT,
                "tools": TOOLS,
                "git_sha": "abc123",
                "flags": FLAGS,
                **extra,
            },
        )

    def request(self, turn: int, content: list[dict[str, Any]], **counters: Any) -> int:
        data = {"turn": turn, "message_count": 2 * turn - 1, **counters, "messages": [{"role": "user", "content": content}]}
        return self.add("model_request", data)

    def response(self, turn: int, content: list[dict[str, Any]], *, stop: str = "tool_use", **numbers: Any) -> int:
        data = {"turn": turn, "stop_reason": stop, "content": content, "usage": usage(1000 * turn), "cost_usd": 0.01, "latency_ms": 1500}
        return self.add("model_response", {**data, **numbers}, actor="agent", dt=2.0)

    def call(self, tool: str, use_id: str, **arguments: Any) -> int:
        return self.add("tool_call", {"tool": tool, "tool_use_id": use_id, "input": arguments}, actor="agent")

    def result(self, tool: str, use_id: str, output: str, log: dict[str, Any] | None = None, **extra: Any) -> int:
        data = {"tool": tool, "tool_use_id": use_id, "is_error": False, "duration_ms": 152, "output": output, "urls": [], "log": log or {}}
        return self.add("tool_result", {**data, **extra}, actor="tool")

    def candidates(self, hypotheses: list[dict[str, Any]], multiplier: float = 1.0) -> int:
        top = hypotheses[0]
        data = {"hypotheses": hypotheses, "provisional": entries(top["lat"], top["lng"], multiplier), "allocator": ALLOCATOR}
        return self.add("candidates_update", data, actor="agent")

    def final(self, hypotheses: list[dict[str, Any]], multiplier: float = 1.0, reason: str = "submit_locations") -> int:
        # with no hypothesis the harness answers with its fallback point for the label
        origin = "agent" if hypotheses else "harness_fallback"
        top = hypotheses[0] if hypotheses else {"lat": 38.72, "lng": -9.14}
        data = {
            "entries": entries(top["lat"], top["lng"], multiplier, origin),
            "allocator": ALLOCATOR,
            "origin": origin,
            "reason": reason,
            "reasoning_summary": "tiles and tram rails",
            "hypotheses": hypotheses,
            "special": True,
        }
        return self.add("final_submission", data)

    def end(self, stop: str = "submitted") -> int:
        return self.add("run_end", {"stop_reason": stop, "turns": 4, "cost_usd": 0.04, "wall_time_s": self.t, "final_origin": "agent"})


def text(value: str) -> dict[str, Any]:
    return {"type": "text", "text": value}


def view(sha: str, yaw: float | None = None, pitch: float | None = None, fov: float | None = None) -> dict[str, Any]:
    return {"type": "image", "sha256": sha, "path": f"elsewhere/{sha}.jpg", "yaw": yaw, "pitch": pitch, "fov": fov}


def story(run_dir: Path) -> SimpleNamespace:
    """One assisted panorama from start to answer: a retried first turn, a crop, a place search, a
    hosted web search, a cue, the soft-deadline notice, a question and the submission."""
    log = Log(run_dir)
    s = SimpleNamespace(log=log)
    s.overview, s.front = log.image(2000, 1000, 10), log.image(1456, 1456, 20)
    s.crop, s.street = log.image(682, 682, 30), log.image(640, 640, 40)
    s.start = log.start(provenance=PROVENANCE)
    opening = [text("Panorama pano_a."), view(s.overview), text("View 1 of 8"), view(s.front, 0.0, 0.0, 90.0)]
    s.request1 = log.request(1, opening, image_count=2, image_payload_chars=5000)
    s.retry = log.add(
        "api_retry",
        {"error_class": "RateLimitError", "status_code": 429, "message": f"429 from /v1?key={GOOGLE_KEY}", "attempt": 1, "delay_s": 2.5},
    )
    searched = {"type": "search", "query": "white chapel tram", "sources": [{"type": "url", "url": "https://example.org/chapel"}]}
    s.response1 = log.response(
        1,
        [
            {"type": "thinking", "thinking": "A tram line and a chapel."},
            {"type": "tool_use", "id": "c1", "name": "view_crop", "input": {"yaw": 273, "pitch": -7, "fov": 20}},
            {"type": "server_tool_use", "id": "ws1", "name": "web_search", "input": searched},
        ],
        usage=usage(41000, cached=0, out=527, reasoning=199),
        cost_usd=0.1095,
        latency_ms=15227,
    )
    s.crop_call = log.call("view_crop", "c1", yaw=273, pitch=-7, fov=20, enhance=True)
    s.places_call = log.call("search_places", "c2", query="white chapel")
    s.street_call = log.call("streetview_lookup", "c3", lat=38.7, lng=-9.14)
    s.crop_result = log.result(
        "view_crop",
        "c1",
        "View centred on yaw 273.0",
        {"image": {"sha256": s.crop, "path": "x", "yaw": 273.0, "pitch": -7.0, "fov": 20.0}, "width": 682, "height": 682},
    )
    s.places_result = log.result(
        "search_places",
        "c2",
        "1 result(s) for 'white chapel'",
        {"sources": [{"source": "nominatim", "from_cache": True}, {"source": "google", "from_cache": True}]},
        urls=["https://nominatim.openstreetmap.org/search?q=white+chapel", f"https://maps.googleapis.com/x?query=chapel&key={GOOGLE_KEY}"],
        duration_ms=1052,
    )
    s.street_result = log.result(
        "streetview_lookup",
        "c3",
        "Google Street View pano P1",
        {"source": "google", "distance_m": 12.0, "images": [{"sha256": s.street, "path": "x", "source": "google", "heading": 90.0}]},
    )
    returned = [
        {"type": "tool_result", "tool_use_id": "c1", "content": [text("View centred"), view(s.crop, 273.0, -7.0, 20.0)]},
        {"type": "tool_result", "tool_use_id": "c2", "content": [text("1 result(s)")]},
        {"type": "tool_result", "tool_use_id": "c3", "content": [text("pano P1"), view(s.street)]},
        text("Harness status: 20 s elapsed"),
    ]
    s.request2 = log.request(2, returned, image_count=4, image_payload_chars=9000)
    s.response2 = log.response(2, [{"type": "tool_use", "id": "c4", "name": "update_candidates", "input": {}}])
    log.call("update_candidates", "c4", hypotheses=[CHAPEL, MILL])
    s.candidates = log.candidates([CHAPEL, MILL])
    log.result("update_candidates", "c4", "Recorded 2 hypotheses.")
    s.cue = log.add("human_cue", {"text": "the kerb stones are yellow", "char_count": 26}, actor="human")
    s.delivered = log.add("human_cue_delivered", {"text": "the kerb stones are yellow", "char_count": 26, "turn": 3})
    s.notice = log.add("soft_deadline_notice", {"turn": 3, "elapsed_s": 601.0, "soft_deadline_s": 600.0})
    s.request3 = log.request(3, [text("Harness status"), text(prompts.COMMIT_NOW_NOTICE)], image_count=4, image_payload_chars=9000)
    s.response3 = log.response(3, [{"type": "tool_use", "id": "c5", "name": "ask_multiple_choice", "input": {}}])
    log.call("ask_multiple_choice", "c5", question="Which?")
    s.asked = log.add(
        "mcq_asked",
        {"id": "q1", "question": "Which is it?", "options": ["the white chapel", "the old mill"], "why_it_matters": "It splits them."},
        actor="agent",
    )
    s.answered = log.add(
        "mcq_answered",
        {"id": "q1", "question": "Which is it?", "options": ["the white chapel", "the old mill"], "selected_index": 0, "wait_s": 4.0},
        actor="human",
    )
    log.result("ask_multiple_choice", "c5", "The operator chose option 1")
    s.request4 = log.request(4, [text("Harness status")], image_count=4, image_payload_chars=9000)
    s.response4 = log.response(4, [{"type": "tool_use", "id": "c6", "name": "submit_locations", "input": {}}])
    log.call("submit_locations", "c6", hypotheses=[CHAPEL, QUAY])
    s.final = log.final([{**CHAPEL, "probability": 0.9}, QUAY], multiplier=0.76)
    log.result("submit_locations", "c6", "Submitted.")
    s.end = log.end()
    return s


def console(tmp_path: Path, client: Any = None) -> tuple[Workspace, httpx.AsyncClient]:
    base = Settings(
        runs_dir=tmp_path / "runs", cache_dir=tmp_path / "cache", allow_web=False, standard=FAST, special=FAST, live=FAST
    )
    ws = Workspace(
        base,
        data_dir=tmp_path / "data",
        eval_data_dir=tmp_path / "eval",
        client_factory=(lambda settings: client) if client is not None else None,
        env_path=tmp_path / ".env",
        fake_model=False,
    )
    app = FastAPI()
    app.state.workspace = ws
    app.include_router(router)
    return ws, httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1")


def run_dir(tmp_path: Path, run_id: str = RUN) -> Path:
    path = tmp_path / "runs" / run_id
    path.mkdir(parents=True)
    return path


def url(rest: str, run_id: str = RUN, pid: str = PANO) -> str:
    return f"/api/runs/{run_id}/pano/{pid}/{rest}"


async def get(http: httpx.AsyncClient, rest: str, **where: str) -> Any:
    response = await http.get(url(rest, **where))
    assert response.status_code == 200, response.text
    return response.json()


def pano_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.effect_noise((256, 128), 60).convert("RGB").save(buffer, "JPEG")
    return buffer.getvalue()


async def until(condition: Any, timeout: float = 10.0) -> None:
    async def poll() -> None:
        while not condition():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


# --- replay -----------------------------------------------------------------------------------


async def test_replay_rewinds_the_tile_to_the_event_asked_for(tmp_path: Path) -> None:
    s = story(run_dir(tmp_path))
    _, http = console(tmp_path)

    early = await get(http, f"replay?at={s.request1}")
    assert (early["status"], early["last_seq"], early["hypotheses"], early["final"]) == ("running", s.request1, [], None)
    assert early["live"] is False and early["active"] is False and early["penalty"]["multiplier"] == 1.0
    assert early["special"] is True and early["label"] == "Urban" and early["budget"] == BUDGET

    believed = await get(http, f"replay?at={s.candidates}")
    assert [h["label"] for h in believed["hypotheses"]] == ["white chapel", "old mill"]
    assert believed["provisional"][0]["multiplier"] == 1.0 and believed["turns"] == 2 and len(believed["crops"]) == 1

    cued = await get(http, f"replay?at={s.cue}")
    assert cued["penalty"] == {"cues": 1, "mcqs": 0, "human_geocodes": 0, "multiplier": 0.8}
    assert cued["provisional"][0]["multiplier"] == 0.8 and cued["cues"][0]["state"] == "queued"
    assert cued["ledger_text"] == "x0.8 = 0.8 cue" and cued["human_window"] is not None

    asked = await get(http, f"replay?at={s.asked}")
    assert asked["status"] == "awaiting_mcq" and asked["pending_mcq"]["id"] == "q1"
    assert asked["pending_mcq"]["option_places"][0]["label"] == "white chapel"
    assert asked["penalty"]["multiplier"] == pytest.approx(0.76) and asked["cues"][0]["state"] == "delivered"

    fixed = await get(http, f"replay?at={s.final}")  # between the answer and the run_end
    assert (fixed["status"], fixed["origin"], fixed["stop_reason"]) == ("done", "agent", "submit_locations")
    assert fixed["final"][0]["multiplier"] == 0.76 and fixed["last_mcq"]["outcome"] == "answered"

    for rest in ("replay", f"replay?at={s.end}", "replay?at=99999"):
        last = await get(http, rest)
        assert (last["status"], last["last_seq"], last["turns"]) == ("done", s.end, 4)
    empty = await get(http, "replay?at=0")
    assert (empty["status"], empty["last_seq"], empty["panorama_id"]) == ("pending", 0, PANO)


async def test_a_replayed_moment_is_not_an_interruption_but_a_log_cut_short_is(tmp_path: Path) -> None:
    log = Log(run_dir(tmp_path))
    log.start()
    log.request(1, [text("Panorama")])
    log.response(1, [])
    seen = log.candidates([CHAPEL])
    asked = log.add("mcq_asked", {"id": "q1", "question": "Which?", "options": ["a", "b"]}, actor="agent")
    with log.path.open("a") as fh:
        fh.write('{"seq": 6, "type": "model_req')  # the server died in the middle of a line
    ws, http = console(tmp_path)

    assert (await get(http, f"replay?at={seen}"))["status"] == "running"
    waiting = await get(http, f"replay?at={asked}")
    assert waiting["status"] == "awaiting_mcq" and waiting["pending_mcq"] is not None and waiting["stop_text"] == ""
    now = await get(http, "replay")
    assert (now["status"], now["pending_mcq"], now["last_seq"]) == ("interrupted", None, asked)
    assert "Rebuild exports" in now["stop_text"] and now["penalty"]["mcqs"] == 1
    # "now" is the tile the run's own page shows, whatever else that page knows about it
    assert now == json.loads(json.dumps((await ws.get_run(RUN))["panoramas"][0]))
    record = inspector.replay_tile(log.path, run_id=RUN, panorama_id=PANO)  # and the log alone agrees
    assert (record["status"], record["last_seq"], record["stop_text"]) == ("interrupted", asked, now["stop_text"])


async def test_replay_follows_a_retry_into_its_second_conversation(tmp_path: Path) -> None:
    log = Log(run_dir(tmp_path))
    log.start()
    log.add("api_error", {"message": "401 bad key"})
    failed = log.final([], reason="api_error")
    ended = log.end("api_error")
    retried = log.add("retry", {"previous_stop_reason": "api_error"})
    log.t = 0.0  # the clock restarts with the new conversation
    restarted = log.start()
    log.request(1, [text("Panorama")])
    log.response(1, [])
    log.candidates([CHAPEL])
    answered = log.final([CHAPEL])
    log.end()
    _, http = console(tmp_path)

    first = await get(http, f"replay?at={ended}")
    assert (first["status"], first["stop_reason"], first["segment"], first["last_seq"]) == ("done", "api_error", 1, ended)
    assert (await get(http, f"replay?at={failed}"))["final"] is not None
    again = await get(http, f"replay?at={retried}")
    assert (again["status"], again["final"], again["stop_reason"]) == ("pending", None, None)
    running = await get(http, f"replay?at={restarted}")
    assert (running["status"], running["segment"]) == ("running", 2)
    assert (await get(http, f"replay?at={answered}"))["origin"] == "agent"

    inspected = await get(http, "inspect")
    assert inspected["segments"] == 2 and [turn["segment"] for turn in inspected["turns"]] == [2]
    frames = {frame["seq"]: frame for frame in inspected["keyframes"]}
    assert frames[retried]["status"] == "pending" and frames[retried]["final"] is None
    assert (frames[ended - 1]["segment"], frames[restarted]["segment"], frames[answered]["segment"]) == (1, 2, 2)
    # time is per conversation, so the page orders by seq and reads the segment
    assert [e["segment"] for e in inspected["timeline"]][:6] == [1, 1, 1, 1, 1, 2]
    assert inspected["timeline"][restarted - 1]["t_rel_s"] < inspected["timeline"][ended - 1]["t_rel_s"]


# --- inspect ----------------------------------------------------------------------------------


async def test_inspect_timeline_marks_what_the_scrubber_shows(tmp_path: Path) -> None:
    s = story(run_dir(tmp_path))
    _, http = console(tmp_path)

    inspected = await get(http, "inspect")

    timeline = inspected["timeline"]
    assert [e["seq"] for e in timeline] == list(range(1, s.end + 1)) and inspected["last_seq"] == s.end
    assert set(timeline[0]) == {"seq", "t_rel_s", "segment", "type", "turn", "mark"}
    marks = {e["seq"]: e["mark"] for e in timeline if e["mark"]}
    assert marks == {
        s.retry: "error",
        s.candidates: "candidates",
        s.cue: "human",
        s.notice: "soft_deadline",
        s.asked: "human",
        s.answered: "human",
        s.final: "final",
    }
    turns = {e["seq"]: e["turn"] for e in timeline}
    assert (turns[s.start], turns[s.request1], turns[s.crop_result], turns[s.request2], turns[s.end]) == (None, 1, 1, 2, 4)
    assert timeline[s.response1 - 1] == {
        "seq": s.response1,
        "t_rel_s": 5.0,
        "segment": 1,
        "type": "model_response",
        "turn": 1,
        "mark": None,
    }


async def test_inspect_marks_the_soft_deadline_in_logs_older_than_its_event(tmp_path: Path) -> None:
    log = Log(run_dir(tmp_path))
    log.start()
    log.request(1, [text("Panorama")])
    log.response(1, [])
    told = log.request(2, [text("Harness status"), text(prompts.COMMIT_NOW_NOTICE)])
    log.response(2, [])
    log.request(3, [text("Harness status")])
    _, http = console(tmp_path)

    marks = {e["seq"]: e["mark"] for e in (await get(http, "inspect"))["timeline"] if e["mark"]}

    assert marks == {told: "soft_deadline"}


async def test_inspect_keyframes_follow_every_change_of_state(tmp_path: Path) -> None:
    s = story(run_dir(tmp_path))
    _, http = console(tmp_path)

    frames = (await get(http, "inspect"))["keyframes"]

    assert [f["seq"] for f in frames] == [s.start, s.candidates, s.cue, s.asked, s.answered, s.final]
    assert [f["status"] for f in frames] == ["running", "running", "running", "awaiting_mcq", "running", "done"]
    assert [f["penalty"]["multiplier"] for f in frames] == pytest.approx([1.0, 1.0, 0.8, 0.76, 0.76, 0.76])
    assert all(f["segment"] == 1 for f in frames) and set(frames[0]) == {
        "seq",
        "t_rel_s",
        "segment",
        "status",
        "hypotheses",
        "provisional",
        "final",
        "penalty",
    }
    assert frames[0]["hypotheses"] == [] and frames[1]["hypotheses"] == [CHAPEL, MILL]
    assert [f["provisional"][0]["multiplier"] for f in frames[1:]] == pytest.approx([1.0, 0.8, 0.76, 0.76, 0.76])
    assert [f["final"] is not None for f in frames] == [False] * 5 + [True]
    # a frame is the tile a replay of that event returns
    for frame in frames:
        tile = await get(http, f"replay?at={frame['seq']}")
        assert all(tile[key] == frame[key] for key in ("status", "hypotheses", "provisional", "final", "penalty"))


async def test_inspect_series_tracks_each_hypothesis_label_and_the_top_point(tmp_path: Path) -> None:
    s = story(run_dir(tmp_path))
    _, http = console(tmp_path)

    inspected = await get(http, "inspect")

    series, at = inspected["series"], {e["seq"]: e["t_rel_s"] for e in inspected["timeline"]}
    assert series["labels"] == ["white chapel", "old mill", "granite quay"]
    assert series["points"] == [
        {"seq": s.candidates, "t_rel_s": at[s.candidates], "probabilities": [0.6, 0.3, None]},
        {"seq": s.final, "t_rel_s": at[s.final], "probabilities": [0.9, None, 0.1]},
    ]
    assert [(p["seq"], p["lat"], p["lng"], p["probability"]) for p in series["top_path"]] == [
        (s.candidates, 38.7, -9.14, 0.6),
        (s.final, 38.7, -9.14, 0.9),
    ]


async def test_inspect_turns_carry_usage_cost_and_their_retries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", GOOGLE_KEY)
    s = story(run_dir(tmp_path))
    _, http = console(tmp_path)

    turns = (await get(http, "inspect"))["turns"]

    assert [(t["turn"], t["seq_request"], t["seq_response"]) for t in turns] == [
        (1, s.request1, s.response1),
        (2, s.request2, s.response2),
        (3, s.request3, s.response3),
        (4, s.request4, s.response4),
    ]
    first = turns[0]
    assert (first["message_count"], first["image_count"], first["image_payload_chars"], first["images_added"]) == (1, 2, 5000, 2)
    assert first["tokens"] == {"input": 41000, "cached": 0, "output": 527, "reasoning": 199}
    assert (first["latency_ms"], first["cost_usd"], first["stop_reason"], first["t_rel_s"]) == (15227, 0.1095, "tool_use", 2.0)
    assert first["retries"] == [
        {"seq": s.retry, "t_rel_s": 3.0, "message": "429 from /v1?key=REDACTED", "delay_s": 2.5, "attempt": 1, "status_code": 429}
    ]
    assert turns[1]["retries"] == [] and turns[1]["images_added"] == 2 and turns[1]["error"] is None


async def test_inspect_shows_a_turn_the_api_never_answered(tmp_path: Path) -> None:
    log = Log(run_dir(tmp_path))
    log.start()
    asked = log.request(1, [text("Panorama")])
    log.add("api_retry", {"message": "503", "attempt": 1, "delay_s": 2.0})
    failed = log.add("api_error", {"error_class": "AuthenticationError", "message": "401 Bearer sk-abcdef123456"})
    log.final([], reason="api_error")
    log.end("api_error")
    _, http = console(tmp_path)

    inspected = await get(http, "inspect")

    (turn,) = inspected["turns"]
    assert (turn["seq_request"], turn["seq_response"], turn["tokens"], turn["cost_usd"]) == (asked, None, None, None)
    assert turn["error"] == "401 Bearer REDACTED" and len(turn["retries"]) == 1
    assert {e["seq"]: e["mark"] for e in inspected["timeline"]}[failed] == "error"
    assert inspected["tools"] == [] and inspected["images"] == [] and inspected["series"]["points"] == []


async def test_inspect_tools_show_input_output_urls_and_returned_images(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", GOOGLE_KEY)
    s = story(run_dir(tmp_path))
    _, http = console(tmp_path)

    tools = (await get(http, "inspect"))["tools"]

    by_call = {tool["seq_call"]: tool for tool in tools}
    crop = by_call[s.crop_call]
    assert (crop["tool"], crop["seq_result"], crop["turn"], crop["duration_ms"]) == ("view_crop", s.crop_result, 1, 152)
    assert crop["input"] == {"yaw": 273, "pitch": -7, "fov": 20, "enhance": True} and crop["output"] == "View centred on yaw 273.0"
    assert crop["images"] == [{"sha256": s.crop, "yaw": 273.0, "pitch": -7.0, "fov": 20.0, "width": 682, "height": 682}]
    assert (crop["is_error"], crop["cache_hit"], crop["urls"], crop["hosted"], crop["crop_n"]) == (False, None, [], False, 1)

    places = by_call[s.places_call]
    assert places["cache_hit"] is True and places["duration_ms"] == 1052 and places["images"] == []
    assert places["urls"] == [
        "https://nominatim.openstreetmap.org/search?q=white+chapel",
        "https://maps.googleapis.com/x?query=chapel&key=REDACTED",
    ]

    street = by_call[s.street_call]  # its size is not in the log: it is read from the saved file
    assert street["images"] == [
        {"sha256": s.street, "yaw": None, "pitch": None, "fov": None, "width": 640, "height": 640, "source": "google", "heading": 90.0}
    ]

    hosted = by_call[s.response1]
    assert (hosted["tool"], hosted["hosted"], hosted["seq_result"], hosted["turn"]) == ("web_search", True, s.response1, 1)
    assert hosted["input"] == {"type": "search", "query": "white chapel tram"} and hosted["urls"] == ["https://example.org/chapel"]
    assert [tool["tool"] for tool in tools][:4] == ["web_search", "view_crop", "search_places", "streetview_lookup"]
    assert all(tool["seq_result"] is not None for tool in tools)
    assert GOOGLE_KEY not in json.dumps(tools)


async def test_inspect_keeps_a_call_whose_result_never_came_and_matches_reused_ids(tmp_path: Path) -> None:
    log = Log(run_dir(tmp_path))
    log.start()
    first = log.call("view_crop", "call_view_crop", yaw=10)
    log.result("view_crop", "call_view_crop", "first", is_error=True)
    second = log.call("view_crop", "call_view_crop", yaw=20)  # a scripted model repeats its ids
    log.result("view_crop", "call_view_crop", "second")
    lost = log.call("overpass_query", "c9", ql="node")
    _, http = console(tmp_path)

    tools = {tool["seq_call"]: tool for tool in (await get(http, "inspect"))["tools"]}

    assert (tools[first]["output"], tools[first]["is_error"]) == ("first", True)
    assert (tools[second]["output"], tools[second]["is_error"]) == ("second", False)
    assert (tools[lost]["seq_result"], tools[lost]["output"], tools[lost]["input"]) == (None, None, {"ql": "node"})


async def test_inspect_gallery_lists_every_view_sent_with_size_and_token_estimate(tmp_path: Path) -> None:
    s = story(run_dir(tmp_path))
    _, http = console(tmp_path)

    inspected = await get(http, "inspect")

    images = inspected["images"]
    assert [(i["n"], i["sha256"], i["source"], i["seq"], i["turn"]) for i in images] == [
        (1, s.overview, "initial", s.request1, 1),
        (2, s.front, "initial", s.request1, 1),
        (3, s.crop, "view_crop", s.request2, 2),
        (4, s.street, "streetview_lookup", s.request2, 2),
    ]
    assert [(i["width"], i["height"]) for i in images] == [(2000, 1000), (1456, 1456), (682, 682), (640, 640)]
    assert [(i["yaw"], i["pitch"], i["fov"]) for i in images] == [(None,) * 3, (0.0, 0.0, 90.0), (273.0, -7.0, 20.0), (None,) * 3]
    # 32-pixel patches x 1.2: 63 x 32, 46 x 46, 22 x 22, 20 x 20
    assert [i["est_tokens"] for i in images] == [2419, 2539, 581, 480]
    assert [i["seq_call"] for i in images] == [None, None, s.crop_call, s.street_call]
    assert [i["crop_n"] for i in images] == [None, None, 1, None]  # the footprint numbered 1 on the viewer
    saved = (s.log.image_dir / f"{s.crop}.jpg").stat().st_size
    assert images[2]["payload_chars"] == 4 * ((saved + 2) // 3)
    assert inspected["image_budget"] == {
        "count": 4,
        "max_count": MAX_REQUEST_IMAGES,
        "payload_chars": 9000,
        "max_payload_chars": MAX_IMAGE_PAYLOAD_CHARS,
    }
    assert (MAX_REQUEST_IMAGES, MAX_IMAGE_PAYLOAD_CHARS) == (80, 24_000_000)


async def test_inspect_gallery_survives_missing_files_and_logs_without_counters(tmp_path: Path) -> None:
    log = Log(run_dir(tmp_path))
    kept, gone = log.image(640, 640, 50), "9" * 64
    log.start()
    log.request(1, [view(kept, 0.0, 0.0, 90.0), view(gone, 45.0, 0.0, 90.0)])
    _, http = console(tmp_path)

    inspected = await get(http, "inspect")

    lost = inspected["images"][1]
    assert (lost["sha256"], lost["width"], lost["height"], lost["est_tokens"], lost["payload_chars"]) == (gone, None, None, None, None)
    assert inspected["image_budget"]["count"] == 2
    assert inspected["image_budget"]["payload_chars"] == inspected["images"][0]["payload_chars"] > 0


async def test_inspect_facts_are_the_run_start_as_logged_and_the_ledger(tmp_path: Path) -> None:
    s = story(run_dir(tmp_path))
    _, http = console(tmp_path)

    inspected = await get(http, "inspect")

    facts = inspected["facts"]
    assert facts["system_prompt"] == SYSTEM_PROMPT and facts["tools"] == TOOLS
    assert (facts["model"], facts["effort"], facts["git_sha"]) == ("gpt-6.1-sol", "high", "abc123")
    assert facts["budget"] == BUDGET and facts["flags"] == FLAGS and facts["provenance"] == PROVENANCE
    assert facts["request"] == {"model": "gpt-6.1-sol", "store": False}
    assert facts["panorama"] == {"panorama_id": PANO, "filename": "pano_a.jpg", "sha256": "f" * 64, "width": 6080, "height": 3040}
    assert (facts["label"], facts["capture_timestamp"], facts["special"]) == ("Urban", "20240102030405", True)
    assert [(c["seq"], c["kind"], c["before"], c["after"]) for c in inspected["ledger"]] == [
        (s.cue, "cue", 1.0, 0.8),
        (s.asked, "mcq", 0.8, pytest.approx(0.76)),
    ]
    assert set(inspected) == {
        "run_id",
        "panorama_id",
        "last_seq",
        "segments",
        "timeline",
        "keyframes",
        "series",
        "turns",
        "tools",
        "images",
        "image_budget",
        "ledger",
        "facts",
    }


async def test_replay_and_inspect_never_carry_ground_truth(tmp_path: Path) -> None:
    directory = run_dir(tmp_path)
    s = story(directory)
    truth = {"lat": TRUTH_LAT, "lng": -TRUTH_LAT, "distance_m": 4321.0, "theta": 1.75, "score": 14000.0}
    (directory / "results.json").write_text(json.dumps({"config": {"mode": "run"}, "panoramas": [{"panorama_id": PANO, **truth}]}))
    meta = {"run_id": RUN, "kind": "eval", "settings": {"no_human": True}, "stage_truth": {PANO: truth}, "tasks": []}
    (directory / RUN_FILE).write_text(json.dumps(meta))
    (tmp_path / "eval").mkdir()
    (tmp_path / "eval" / "manifest.json").write_text(json.dumps([{"panorama_id": PANO, **truth}]))
    _, http = console(tmp_path)

    for rest in ("replay", f"replay?at={s.final}", "inspect"):
        body = (await http.get(url(rest))).text
        assert str(TRUTH_LAT) not in body and "4321" not in body and "theta" not in body, rest
    # the one distance in the story's log is a tool's own (street view to its query point): not shown
    assert "distance_m" not in (await http.get(url("inspect"))).text


async def test_a_panorama_that_never_started_replays_and_inspects_empty(tmp_path: Path) -> None:
    directory = run_dir(tmp_path)
    task = {"panorama_id": "queued", "path": "/sets/x/queued.jpg", "filename": "queued.jpg", "label": "non-Urban", "special": False}
    (directory / RUN_FILE).write_text(json.dumps({"run_id": RUN, "kind": "training", "tasks": [task], "acks": {"queued": ["fallback"]}}))
    _, http = console(tmp_path)

    tile = await get(http, "replay", pid="queued")
    assert (tile["status"], tile["label"], tile["filename"], tile["last_seq"]) == ("interrupted", "non-Urban", "queued.jpg", 0)
    assert tile["fallback_acknowledged"] is True
    assert (await get(http, "replay?at=5", pid="queued"))["status"] == "pending"
    inspected = await get(http, "inspect", pid="queued")
    assert (inspected["timeline"], inspected["turns"], inspected["last_seq"]) == ([], [], 0)
    assert inspected["facts"]["system_prompt"] is None and inspected["facts"]["label"] == "non-Urban"
    assert inspected["image_budget"]["count"] == 0
    missing = await http.get(url("download?what=events", pid="queued"))
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "no_events"


# --- downloads --------------------------------------------------------------------------------


async def test_download_events_is_the_log_in_whole_lines_as_an_attachment(tmp_path: Path) -> None:
    s = story(run_dir(tmp_path))
    whole = s.log.path.read_bytes()
    with s.log.path.open("ab") as fh:
        fh.write(b'{"seq": 99, "type": "tool_c')
    _, http = console(tmp_path)

    response = await http.get(url("download?what=events"))

    assert response.status_code == 200 and response.content == whole
    assert response.headers["content-disposition"] == f'attachment; filename="{PANO}.events.jsonl"'
    assert response.headers["content-type"].startswith("application/x-ndjson")
    assert response.headers["cache-control"] == "no-store"


async def test_download_export_serves_the_file_on_disk_or_says_how_to_get_one(tmp_path: Path) -> None:
    directory = run_dir(tmp_path)
    story(directory)
    _, http = console(tmp_path)

    missing = await http.get(url("download"))  # what=export is the default
    assert missing.status_code == 404
    assert (missing.json()["detail"]["code"], missing.json()["detail"]["action"]) == ("no_export", "rebuild")
    assert "Rebuild exports" in missing.json()["detail"]["message"]
    assert not (directory / f"{PANO}.json").exists()  # a download never finishes a disk run's files

    document = json.dumps({"schema_version": "1.0", "final": {"locations": []}}).encode()
    (directory / f"{PANO}.json").write_bytes(document)
    response = await http.get(url("download?what=export"))
    assert response.status_code == 200 and response.content == document
    assert response.headers["content-disposition"] == f'attachment; filename="{PANO}.json"'
    assert response.headers["content-type"].startswith("application/json")


async def test_download_images_zips_the_saved_views_and_nothing_else(tmp_path: Path) -> None:
    directory = run_dir(tmp_path)
    s = story(directory)
    images = s.log.image_dir
    secret = tmp_path / "secret.jpg"
    secret.write_bytes(b"not for download")
    (images / f"{'d' * 64}.jpg").symlink_to(secret)
    (images / "notes.txt").write_text("x")
    (images / f"{'e' * 64}.png").write_bytes(b"x")
    (images / f"{'c' * 64}.jpg").mkdir()
    (directory / PANO / "abc_1024.jpg").write_bytes(b"a cached preview")
    (directory / RUN_FILE).write_text(json.dumps({"run_id": RUN, "kind": "training", "tasks": []}))
    _, http = console(tmp_path)

    response = await http.get(url("download?what=images"))

    assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"] == f'attachment; filename="{RUN}_{PANO}_images.zip"'
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert sorted(archive.namelist()) == sorted(f"{sha}.jpg" for sha in (s.overview, s.front, s.crop, s.street))
        assert archive.read(f"{s.crop}.jpg") == (images / f"{s.crop}.jpg").read_bytes()

    Log(directory, "bare").start()
    none = await http.get(url("download?what=images", pid="bare"))
    assert none.status_code == 404 and none.json()["detail"]["code"] == "no_images"


async def test_ids_and_parameters_are_checked_before_any_file_is_touched(tmp_path: Path) -> None:
    story(run_dir(tmp_path))
    outside = tmp_path / "outside.events.jsonl"
    outside.write_text('{"seq": 1, "type": "run_start", "data": {}}\n')
    (tmp_path / "runs" / RUN / "linked.events.jsonl").symlink_to(outside)
    _, http = console(tmp_path)

    for rest in ("replay", "inspect", "download?what=events"):
        for where in ({"run_id": "%2e%2e"}, {"run_id": "bad id"}, {"pid": "%2e%2e"}, {"pid": "a..b"}, {"pid": ".hidden"}):
            refused = await http.get(url(rest, **where))
            assert refused.status_code == 400 and refused.json()["detail"]["code"] == "invalid_id", (rest, where)
        unknown = await http.get(url(rest, run_id="nope"))
        assert unknown.status_code == 404 and unknown.json()["detail"]["code"] == "unknown_run"
        absent = await http.get(url(rest, pid="nope"))
        assert absent.status_code == 404 and absent.json()["detail"]["code"] == "unknown_panorama"
        leaving = await http.get(url(rest, pid="linked"))
        assert leaving.status_code == 403, rest
    for at in ("abc", "-1", "1.5"):
        wrong = await http.get(url(f"replay?at={at}"))
        assert wrong.status_code == 422 and wrong.json()["detail"]["code"] == "invalid_at"
    other = await http.get(url("download?what=run.json"))
    assert other.status_code == 422 and other.json()["detail"]["code"] == "invalid_download"
    assert set(other.json()["detail"]) == {"message", "code", "action", "problems"}


# --- a run this server owns -------------------------------------------------------------------


async def launch(ws: Workspace, *paths: str) -> str:
    set_id = ws.sets.create("replay")["set_id"]
    for path in paths:
        ws.sets.add_file(set_id, path, pano_bytes())
    spec = {"preset": "autonomous", "set_id": set_id, "confirm_no_key": True}
    return (await ws.launch(spec))["run_id"]


async def test_owned_run_replays_inspects_and_downloads_from_its_files(tmp_path: Path) -> None:
    ws, http = console(tmp_path, DemoClient(0))
    run_id = await launch(ws, "Urban/a.jpg")
    handle = ws.owned(run_id)
    await until(lambda: handle.idle and handle.task is not None)
    events = read_events(ws.log_path(run_id, "a"))
    first_belief = next(e["seq"] for e in events if e["type"] == "candidates_update")

    now = await get(http, "replay", run_id=run_id, pid="a")
    assert now == json.loads(json.dumps(ws.tile(run_id, "a")))  # "now" is the live tile, as the stream sends it
    assert (now["live"], now["status"], now["last_seq"]) == (True, "done", events[-1]["seq"])
    then = await get(http, f"replay?at={first_belief}", run_id=run_id, pid="a")
    assert (then["live"], then["status"], then["final"], then["last_seq"]) == (False, "running", None, first_belief)
    assert then["hypotheses"] and then["human_enabled"] is False and then["budget"]["max_turns"] == FAST.max_turns

    inspected = await get(http, "inspect", run_id=run_id, pid="a")
    assert len(inspected["turns"]) == now["turns"] and all(turn["seq_response"] for turn in inspected["turns"])
    assert sum(turn["cost_usd"] for turn in inspected["turns"]) == pytest.approx(now["spend_usd"], abs=1e-5)
    crops = [tool for tool in inspected["tools"] if tool["tool"] == "view_crop"]
    assert [(tool["seq_call"], tool["crop_n"]) for tool in crops] == [(crop["seq_call"], crop["n"]) for crop in now["crops"]]
    assert all(tool["images"][0]["width"] and tool["output"] for tool in crops)
    sent = inspected["images"]
    assert [image["source"] for image in sent[:11]] == ["initial"] * 11 and {image["source"] for image in sent[11:]} == {"view_crop"}
    assert all(image["width"] and image["est_tokens"] and image["payload_chars"] for image in sent)
    last_request = [e for e in events if e["type"] == "model_request"][-1]["data"]
    assert inspected["image_budget"]["count"] == last_request["image_count"] == len(sent)
    assert sum(image["payload_chars"] for image in sent) == inspected["image_budget"]["payload_chars"]
    assert inspected["facts"]["system_prompt"] == events[0]["data"]["system_prompt"]
    assert inspected["facts"]["tools"] == events[0]["data"]["tools"] and inspected["facts"]["provenance"]["set_id"]
    assert inspected["keyframes"][-1]["final"] == now["final"] and inspected["timeline"][-1]["seq"] == now["last_seq"]

    export = await http.get(url("download?what=export", run_id=run_id, pid="a"))
    assert export.status_code == 200 and len(export.json()["final"]["locations"]) == 10
    assert export.json()["events"][-1]["seq"] == now["last_seq"]
    log = await http.get(url("download?what=events", run_id=run_id, pid="a"))
    assert log.content == ws.log_path(run_id, "a").read_bytes()
    archive = await http.get(url("download?what=images", run_id=run_id, pid="a"))
    with zipfile.ZipFile(io.BytesIO(archive.content)) as zipped:
        assert sorted(zipped.namelist()) == sorted(p.name for p in (ws.run_dir(run_id) / "a" / "images").iterdir())
        assert {image["sha256"] + ".jpg" for image in sent} <= set(zipped.namelist())
    assert read_events(ws.log_path(run_id, "a")) == events  # reading a run writes nothing to its log


class HoldingClient:
    """States a belief, then keeps its second call in flight until the test lets it submit."""

    def __init__(self) -> None:
        self.held, self.release = asyncio.Event(), asyncio.Event()

    def _reply(self, name: str, **arguments: Any) -> SimpleNamespace:
        block = {"type": "tool_use", "id": f"call_{name}", "name": name, "input": arguments}
        counted = {"input_tokens": 1000, "cached_input_tokens": 0, "cache_write_tokens": 0, "output_tokens": 100}
        return SimpleNamespace(id="resp", model="gpt-6.1-sol", content=[block], stop_reason="tool_use", stop_details=None, usage=counted)

    async def create(self, **params: Any) -> Any:
        if not any(message["role"] == "assistant" for message in params["messages"]):
            return self._reply("update_candidates", hypotheses=[CHAPEL])
        self.held.set()
        await self.release.wait()
        return self._reply("submit_locations", hypotheses=[CHAPEL], reasoning_summary="ok")


async def test_a_running_panorama_can_be_replayed_and_exported_without_disturbing_it(tmp_path: Path) -> None:
    client = HoldingClient()
    ws, http = console(tmp_path, client)
    run_id = await launch(ws, "Urban/a.jpg")
    await asyncio.wait_for(client.held.wait(), 10)
    where = {"run_id": run_id, "pid": "a"}

    now = await get(http, "replay", **where)
    assert (now["live"], now["active"], now["status"], now["final"]) == (True, True, "running", None)
    assert [h["label"] for h in now["hypotheses"]] == ["white chapel"]
    start = await get(http, "replay?at=1", **where)
    assert (start["live"], start["active"], start["status"], start["hypotheses"]) == (False, False, "running", [])
    inspected = await get(http, "inspect", **where)
    assert inspected["turns"][-1]["seq_response"] is None and inspected["last_seq"] == now["last_seq"]
    # Export JSON on a tile that is still working: written from the log as it stands
    export = await http.get(url("download?what=export", **where))
    assert export.status_code == 200 and export.json()["events"][-1]["seq"] == now["last_seq"]
    assert export.json()["final"]["locations"][0]["lat"] == CHAPEL["lat"]
    assert ws.session(run_id, "a").final is None and ws.tile(run_id, "a")["status"] == "running"

    client.release.set()
    handle = ws.owned(run_id)
    await until(lambda: handle.idle and handle.task is not None)
    done = await get(http, "replay", **where)
    assert (done["status"], done["origin"]) == ("done", "agent")
    assert (await get(http, f"replay?at={now['last_seq']}", **where))["status"] == "running"
    final = await http.get(url("download?what=export", **where))
    assert final.json()["events"][-1]["seq"] == done["last_seq"]  # rewritten: it was behind the log
    await ws.shutdown()


# --- the module, without HTTP -----------------------------------------------------------------


def test_image_token_estimate_is_patches_times_the_harness_factor() -> None:
    assert inspector.estimate_image_tokens(1456, 1456) == 2539  # astrolabio.loop budgets "about 2,540"
    assert inspector.estimate_image_tokens(2000, 2000) == 4763  # astrolabio.pano says "about 4,800"
    assert inspector.estimate_image_tokens(33, 32) == round(2 * 1.2)
    assert inspector.estimate_image_tokens(None, 640) is None and inspector.estimate_image_tokens(0, 0) is None


def test_inspect_of_the_real_log_agrees_with_what_it_recorded() -> None:
    if not REAL_LOG.exists():
        pytest.skip("no real run on this machine")
    events = read_events(REAL_LOG)
    of = lambda kind: [e for e in events if e["type"] == kind]  # noqa: E731
    end = of("run_end")[-1]["data"]
    images = REAL_LOG.parent / "eval_1331ae8dad3b" / "images"

    inspected = inspector.inspect_log(REAL_LOG, run_id="20261010T174153Z", panorama_id="eval_1331ae8dad3b", image_dir=images)

    json.dumps(inspected, allow_nan=False)
    assert [e["seq"] for e in inspected["timeline"]] == [e["seq"] for e in events]
    assert len(inspected["turns"]) == end["turns"] == len(of("model_response"))
    assert sum(t["cost_usd"] for t in inspected["turns"]) == pytest.approx(end["cost_usd"], abs=1e-3)
    assert sum(t["tokens"]["input"] for t in inspected["turns"]) == end["tokens"]["input_tokens"]
    assert sum(t["tokens"]["reasoning"] for t in inspected["turns"]) == end["tokens"]["reasoning_tokens"]
    called = [tool for tool in inspected["tools"] if not tool["hosted"]]
    assert [tool["seq_call"] for tool in called] == [e["seq"] for e in of("tool_call")]
    assert sorted(tool["seq_result"] for tool in called) == [e["seq"] for e in of("tool_result")]
    assert sum(tool["hosted"] for tool in inspected["tools"]) == end["tokens"]["web_search_requests"]
    assert all("key=" not in address or "key=REDACTED" in address for tool in inspected["tools"] for address in tool["urls"])
    last_request = of("model_request")[-1]["data"]
    budget = inspected["image_budget"]
    assert (budget["count"], budget["payload_chars"]) == (last_request["image_count"], last_request["image_payload_chars"])
    assert len(inspected["images"]) == budget["count"] and [i["n"] for i in inspected["images"]] == list(range(1, budget["count"] + 1))
    if images.is_dir():
        # the files are what was uploaded: their base64 size is the loop's own count
        assert sum(i["payload_chars"] for i in inspected["images"]) == budget["payload_chars"]
        assert all(i["width"] and i["est_tokens"] for i in inspected["images"])
    marks = [e["mark"] for e in inspected["timeline"] if e["mark"]]
    assert marks.count("candidates") == len(of("candidates_update")) and marks.count("final") == 1
    assert inspected["keyframes"][-1]["status"] == "done" and len(inspected["series"]["points"]) >= len(of("candidates_update"))
    assert inspected["facts"]["system_prompt"] == events[0]["data"]["system_prompt"]
    assert inspected["facts"]["tools"] == events[0]["data"]["tools"] and inspected["facts"]["git_sha"] == events[0]["data"]["git_sha"]

    middle = inspector.replay_tile(REAL_LOG, run_id="r", panorama_id="p", at=events[60]["seq"])
    assert (middle["status"], middle["last_seq"], middle["final"]) == ("running", events[60]["seq"], None)
    assert inspector.replay_tile(REAL_LOG, run_id="r", panorama_id="p")["status"] == "done"
