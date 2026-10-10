"""Operator UI backend: rule compliance of the three human channels (SPEC sections 4 and 8)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from PIL import Image

from geoagent.config import Settings
from geoagent.schema import Hypothesis, Label, PanoramaTask
from geoagent.session import PanoramaSession
from server.app import STATIC_DIR, create_app, digest_event

CUE = "The road has a double white centre line and the poles are concrete with a square section."
PLACE = "roundabout by the white chapel"


class FakeManager:
    def __init__(self, settings: Settings, sessions: list[PanoramaSession]) -> None:
        self.settings = settings
        self.run_id = "testrun"
        self.sessions = {s.task.panorama_id: s for s in sessions}
        self.finalize_reasons: list[str] = []
        self.exported = False

    def snapshot(self) -> dict[str, Any]:
        return {"run_id": self.run_id, "sessions": {k: s.snapshot() for k, s in self.sessions.items()}}

    def finalize_all(self, reason: str) -> None:
        self.finalize_reasons.append(reason)
        for session in self.sessions.values():
            session.finalize(reason=reason)

    def export_all(self) -> list[Path]:
        self.exported = True
        return [Path("runs/testrun/a.json")]


def make_manager(tmp_path: Path, *, no_human: bool = False, tasks: list[tuple[str, Label, bool]] | None = None) -> FakeManager:
    settings = Settings(runs_dir=tmp_path / "runs", no_human=no_human, mcq_timeout_s=5.0)
    image = tmp_path / "pano.jpg"
    if not image.exists():
        Image.new("RGB", (800, 400), (90, 120, 160)).save(image, "JPEG")
    specs = tasks or [("p1", Label.URBAN, False)]
    sessions = [
        PanoramaSession(PanoramaTask(panorama_id=pid, path=image, label=label, special=special), settings, "testrun")
        for pid, label, special in specs
    ]
    return FakeManager(settings, sessions)


def client_for(manager: FakeManager, **kwargs: Any) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=create_app(manager, **kwargs))
    return httpx.AsyncClient(transport=transport, base_url="http://ui")


def name_a_place(session: PanoramaSession) -> None:
    session.update_candidates([Hypothesis(lat=38.7, lng=-9.14, probability=0.7, label=PLACE)])


async def wait_for_pending(session: PanoramaSession) -> dict[str, Any]:
    for _ in range(200):
        if session.pending_mcq is not None:
            return session.pending_mcq
        await asyncio.sleep(0.005)
    raise AssertionError("MCQ never became pending")


# ---------------------------------------------------------------------------------------------
# --no-human


async def test_no_human_mode_rejects_every_human_channel(tmp_path: Path) -> None:
    manager = make_manager(tmp_path, no_human=True)
    session = manager.sessions["p1"]
    name_a_place(session)
    async with client_for(manager) as client:
        responses = [
            await client.post("/api/pano/p1/mcq/whatever/answer", json={"index": 0}),
            await client.post("/api/pano/p1/mcq_allowed", json={"allowed": True}),
            await client.post("/api/pano/p1/cue/lint", json={"text": CUE}),
            await client.post("/api/pano/p1/cue", json={"text": CUE, "confirmed": True}),
            await client.post(
                "/api/pano/p1/geocode", json={"lat": 38.7, "lng": -9.14, "place_label": PLACE, "confirmed": True}
            ),
        ]
        state = (await client.get("/api/state")).json()
    assert [r.status_code for r in responses] == [403] * 5
    assert session.ledger.multiplier == 1.0
    assert session.drain_cues() == []
    tile = state["panoramas"][0]
    assert state["no_human"] is True
    assert tile["human_enabled"] is False and tile["geocode_enabled"] is False and tile["pending_mcq"] is None


# ---------------------------------------------------------------------------------------------
# cue (R6)


async def test_cue_requires_confirmed_true(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    session = manager.sessions["p1"]
    async with client_for(manager) as client:
        missing = await client.post("/api/pano/p1/cue", json={"text": CUE})
        false = await client.post("/api/pano/p1/cue", json={"text": CUE, "confirmed": False})
        truthy_string = await client.post("/api/pano/p1/cue", json={"text": CUE, "confirmed": "yes"})
        assert (missing.status_code, false.status_code, truthy_string.status_code) == (400, 400, 422)
        assert session.ledger.cues == 0 and session.drain_cues() == []

        sent = await client.post("/api/pano/p1/cue", json={"text": CUE, "confirmed": True})
    assert sent.status_code == 200
    assert sent.json()["state"]["penalty"] == {"cues": 1, "mcqs": 0, "human_geocodes": 0, "multiplier": 0.8}
    assert session.drain_cues() == [CUE]
    assert [e["type"] for e in session.log.events()].count("human_cue") == 1


async def test_cue_lint_dry_run_costs_nothing(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    session = manager.sessions["p1"]
    async with client_for(manager) as client:
        clean = (await client.post("/api/pano/p1/cue/lint", json={"text": CUE})).json()
        located = (await client.post("/api/pano/p1/cue/lint", json={"text": "It is near Lisboa at 38.7223, -9.1393"})).json()
    assert clean["ok"] is True and clean["problems"] == []
    assert clean["multiplier_before"] == 1.0 and clean["multiplier_after"] == pytest.approx(0.8)
    assert clean["char_count"] == len(CUE) and clean["max_chars"] == 1000
    assert located["ok"] is False and located["problems"]
    assert session.ledger.cues == 0 and session.ledger.multiplier == 1.0
    assert session.drain_cues() == []
    assert "human_cue" not in [e["type"] for e in session.log.events()]


async def test_cue_blocked_by_lint_and_length_without_penalty(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    session = manager.sessions["p1"]
    async with client_for(manager) as client:
        located = await client.post("/api/pano/p1/cue", json={"text": "Look around Lisboa", "confirmed": True})
        too_long = await client.post("/api/pano/p1/cue", json={"text": "wide road " * 101, "confirmed": True})
        empty = await client.post("/api/pano/p1/cue", json={"text": "   ", "confirmed": True})
    assert (located.status_code, too_long.status_code, empty.status_code) == (422, 422, 422)
    assert located.json()["detail"]["lint"]["ok"] is False
    assert session.ledger.multiplier == 1.0 and session.drain_cues() == []


# ---------------------------------------------------------------------------------------------
# MCQ (R7)


async def test_mcq_answer_resolves_the_pending_question(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    session = manager.sessions["p1"]
    async with client_for(manager) as client:
        asking = asyncio.create_task(session.ask_mcq("Which street matches?", ["tiled facade", "plain render"], "splits 2 towns"))
        pending = await wait_for_pending(session)

        tile = (await client.get("/api/state")).json()["panoramas"][0]
        assert tile["status"] == "awaiting_mcq"
        assert tile["pending_mcq"]["options"] == ["tiled facade", "plain render"]
        assert 0 < tile["pending_mcq"]["remaining_s"] <= 5.0
        assert tile["penalty"]["multiplier"] == pytest.approx(0.95)  # charged when asked

        stale = await client.post("/api/pano/p1/mcq/not-the-id/answer", json={"index": 0})
        out_of_range = await client.post(f"/api/pano/p1/mcq/{pending['id']}/answer", json={"index": 2})
        free_text = await client.post(f"/api/pano/p1/mcq/{pending['id']}/answer", json={"index": 0, "text": "x" * 5000})
        assert (stale.status_code, out_of_range.status_code) == (409, 409)
        assert free_text.status_code == 200
        assert free_text.json()["state"]["pending_mcq"] is None

        result = await asyncio.wait_for(asking, 2)
        again = await client.post(f"/api/pano/p1/mcq/{pending['id']}/answer", json={"index": 1})
    assert result == {"answered": True, "selected_index": 0, "selected_option": "tiled facade"}
    assert again.status_code == 409
    assert session.ledger.mcqs == 1
    answered = [e for e in session.log.events() if e["type"] == "mcq_answered"]
    assert len(answered) == 1 and "x" * 100 not in json.dumps(answered)


async def test_mcq_allowed_toggle(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    session = manager.sessions["p1"]
    async with client_for(manager) as client:
        off = await client.post("/api/pano/p1/mcq_allowed", json={"allowed": False})
        bad = await client.post("/api/pano/p1/mcq_allowed", json={"allowed": "maybe"})
    assert off.status_code == 200 and off.json()["state"]["mcq_allowed"] is False
    assert bad.status_code == 422
    assert session.mcq_allowed is False and session.ledger.multiplier == 1.0


# ---------------------------------------------------------------------------------------------
# last-resort geocode (R8)


async def test_geocode_disabled_until_the_agent_names_a_place(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    session = manager.sessions["p1"]
    body = {"lat": 38.71, "lng": -9.13, "place_label": PLACE, "confirmed": True}
    async with client_for(manager) as client:
        assert (await client.get("/api/state")).json()["panoramas"][0]["geocode_enabled"] is False
        refused = await client.post("/api/pano/p1/geocode", json=body)
        assert refused.status_code == 409 and session.ledger.human_geocodes == 0

        name_a_place(session)
        assert (await client.get("/api/state")).json()["panoramas"][0]["geocode_enabled"] is True
        unconfirmed = await client.post("/api/pano/p1/geocode", json={**body, "confirmed": False})
        other_place = await client.post("/api/pano/p1/geocode", json={**body, "place_label": "somewhere I chose"})
        out_of_range = await client.post("/api/pano/p1/geocode", json={**body, "lat": 123.0})
        assert (unconfirmed.status_code, other_place.status_code, out_of_range.status_code) == (400, 409, 422)
        assert session.ledger.human_geocodes == 0

        done = await client.post("/api/pano/p1/geocode", json=body)
    assert done.status_code == 200
    state = done.json()["state"]
    assert state["penalty"]["multiplier"] == pytest.approx(0.5)
    assert len(state["provisional"]) == 10
    assert {(e["lat"], e["lng"], e["origin"]) for e in state["provisional"]} == {(38.71, -9.13, "human_geocode")}


# ---------------------------------------------------------------------------------------------
# read-only endpoints, harness controls, stream


async def test_state_sorts_special_first_then_urban(tmp_path: Path) -> None:
    manager = make_manager(
        tmp_path,
        tasks=[("a_rural", Label.NON_URBAN, False), ("b_urban", Label.URBAN, False), ("c_special", Label.NON_URBAN, True)],
    )
    async with client_for(manager) as client:
        state = (await client.get("/api/state")).json()
    assert [p["panorama_id"] for p in state["panoramas"]] == ["c_special", "b_urban", "a_rural"]
    special = state["panoramas"][0]
    assert special["special"] is True and special["budget"]["hard_deadline_s"] == 1200
    assert state["panoramas"][1]["budget"]["soft_deadline_s"] == 600
    assert state["run"]["run_id"] == "testrun"
    assert (await _status(manager, "/api/pano/nope/events")) == 404


async def _status(manager: FakeManager, url: str) -> int:
    async with client_for(manager) as client:
        return (await client.get(url)).status_code


async def test_image_and_view_endpoints(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    session = manager.sessions["p1"]
    sha = "ab" * 32
    Image.new("RGB", (32, 32)).save(session.image_dir / f"{sha}.jpg", "JPEG")
    (session.image_dir.parent / "secret.jpg").write_bytes(b"no")
    async with client_for(manager) as client:
        image = await client.get("/api/pano/p1/image?w=1000")
        view = await client.get(f"/api/pano/p1/views/{sha}")
        missing = await client.get(f"/api/pano/p1/views/{'cd' * 32}")
        traversal = await client.get("/api/pano/p1/views/..%2Fsecret")
        page = await client.get("/")
    assert image.status_code == 200 and image.headers["content-type"] == "image/jpeg"
    assert (session.image_dir.parent / "ui_equirect_1024.jpg").is_file()
    assert view.status_code == 200
    assert missing.status_code == 404
    assert traversal.status_code in {400, 404}
    assert page.status_code == 200 and "Send cue (x0.8)" in page.text


async def test_finalize_and_export_controls(tmp_path: Path) -> None:
    manager = make_manager(tmp_path, tasks=[("p1", Label.URBAN, False), ("p2", Label.NON_URBAN, False)])
    async with client_for(manager) as client:
        one = await client.post("/api/pano/p1/finalize")
        assert one.status_code == 200 and len(one.json()["state"]["final"]) == 10
        assert manager.sessions["p2"].final is None
        frozen = one.json()["state"]["elapsed_s"]
        await asyncio.sleep(0.05)
        assert (await client.get("/api/state")).json()["panoramas"][0]["elapsed_s"] == frozen

        everything = await client.post("/api/finalize_all")
        exported = await client.post("/api/export")
    assert everything.status_code == 200 and all(p["final"] for p in everything.json()["panoramas"])
    assert manager.finalize_reasons == ["operator_finalize_all"]
    assert exported.json() == {"ok": True, "paths": ["runs/testrun/a.json"]}


async def test_event_stream_sends_snapshot_then_events_and_heartbeats(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    session = manager.sessions["p1"]
    app = create_app(manager, heartbeat_s=0.05)
    stream = app.state.event_stream()
    try:
        first = await anext(stream)
        assert first.startswith("event: snapshot\n")
        assert json.loads(first.split("data: ", 1)[1])["panoramas"][0]["panorama_id"] == "p1"

        name_a_place(session)
        message = await asyncio.wait_for(anext(stream), 2)
        assert message.startswith("event: event\n") and message.endswith("\n\n")
        payload = json.loads(message.split("data: ", 1)[1])
        assert payload["panorama_id"] == "p1" and payload["event"]["type"] == "candidates_update"
        assert payload["state"]["named_places"] == [PLACE]

        assert await asyncio.wait_for(anext(stream), 2) == ": ping\n\n"
    finally:
        await stream.aclose()
    assert session._subscribers == []


def test_digest_keeps_reasoning_and_drops_bulk() -> None:
    search = {"type": "search", "query": "Pastelaria Santo António Alfama", "sources": [{"type": "url", "url": "https://x.pt/" + "p" * 300}] * 20}
    digest = digest_event(
        {
            "seq": 4,
            "t_rel_s": 12.5,
            "actor": "agent",
            "type": "model_response",
            "penalty_state": {"multiplier": 0.95},
            "data": {
                "stop_reason": "tool_use",
                # as the loop logs them: the raw API item behind each block is not in the log
                "content": [
                    {"type": "thinking", "thinking": "Azulejo tiles suggest <b>Portugal</b>"},
                    {"type": "thinking", "thinking": ""},
                    {"type": "server_tool_use", "id": "ws_1", "name": "web_search", "input": search},
                    {"type": "server_tool_use", "id": "ws_2", "name": "web_search", "input": {"type": "open_page", "url": "https://x.pt/a"}},
                    {"type": "text", "text": "Zooming on the sign.", "annotations": [{"type": "url_citation", "url": "https://x.pt/a"}]},
                    {"type": "tool_use", "id": "t1", "name": "view_crop", "input": {"yaw": 90, "pitch": 0, "fov": 20}},
                    {"type": "compaction", "item": {"id": "cmp_1", "type": "compaction", "encrypted_content": "<9000 chars omitted>"}},
                ],
            },
        }
    )
    assert [line["kind"] for line in digest["lines"]] == ["thinking", "tool", "tool", "text", "tool"]
    assert digest["lines"][0]["text"] == "Azulejo tiles suggest <b>Portugal</b>"
    assert digest["lines"][1]["text"] == 'web_search search "Pastelaria Santo António Alfama"'
    assert digest["lines"][2]["text"] == "web_search open_page https://x.pt/a"
    assert digest["lines"][4]["text"].startswith("view_crop {")
    assert digest["multiplier"] == 0.95 and len(json.dumps(digest)) < 1000

    refused = digest_event(
        {"seq": 6, "type": "model_response", "data": {"stop_reason": "refusal", "content": [{"type": "refusal", "refusal": "I can't help with that."}]}}
    )
    assert refused["lines"] == [
        {"kind": "text", "text": "I can't help with that."},
        {"kind": "harness", "text": "stop_reason: refusal"},
    ]

    result = digest_event(
        {"seq": 5, "type": "tool_result", "data": {"name": "view_crop", "is_error": False, "duration_ms": 41.2,
                                                    "log": {"image": {"sha256": "ef" * 32, "path": "x.jpg"}}}}
    )
    assert result["images"] == ["ef" * 32] and result["lines"][0]["kind"] == "result"


def test_page_never_assigns_markup_from_dynamic_text() -> None:
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = page.split("<script>", 1)[1]
    for sink in ("innerHTML =", "outerHTML =", "insertAdjacentHTML", "document.write"):
        assert sink not in script
    # the only free-text input on the page is the cue box; the MCQ path has buttons only
    assert page.count("<input") == 0 and script.count('el("textarea")') == 1 and script.count('el("input")') == 1
    assert "Submit geocode (x0.5)" in page


# ---------------------------------------------------------------------------------------------
# exports follow operator actions, and never run on the event loop


async def test_geocode_and_finalize_refresh_the_exports_off_the_event_loop(tmp_path: Path) -> None:
    import threading

    manager = make_manager(tmp_path)
    session = manager.sessions["p1"]
    name_a_place(session)
    threads: list[int] = []

    def export_all() -> list[Path]:
        threads.append(threading.get_ident())
        return [Path("runs/testrun/a.json")]

    manager.export_all = export_all  # type: ignore[method-assign]
    loop_thread = threading.get_ident()
    body = {"lat": 38.71, "lng": -9.13, "place_label": PLACE, "confirmed": True}
    async with client_for(manager) as client:
        assert (await client.post("/api/pano/p1/geocode", json=body)).status_code == 200
        assert len(threads) == 1
        assert (await client.post("/api/pano/p1/finalize")).status_code == 200
        assert (await client.post("/api/finalize_all")).status_code == 200
        assert (await client.post("/api/export")).json()["paths"] == ["runs/testrun/a.json"]
    assert len(threads) == 4 and loop_thread not in threads


async def test_failed_export_does_not_fail_the_geocode(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    session = manager.sessions["p1"]
    name_a_place(session)

    def export_all() -> list[Path]:
        raise OSError("disk full")

    manager.export_all = export_all  # type: ignore[method-assign]
    body = {"lat": 38.71, "lng": -9.13, "place_label": PLACE, "confirmed": True}
    async with client_for(manager) as client:
        done = await client.post("/api/pano/p1/geocode", json=body)
    assert done.status_code == 200 and session.ledger.human_geocodes == 1
    assert done.json()["state"]["status"] == "done"


async def test_geocode_after_the_run_rewrites_the_files_that_get_submitted(tmp_path: Path) -> None:
    """All panoramas final and exported; a last-resort geocode at T+40 must reach the files on
    disk without anyone pressing Export."""
    from geoagent.runner import RunManager

    settings = Settings(runs_dir=tmp_path / "runs", mcq_timeout_s=5.0)
    image = tmp_path / "pano.jpg"
    Image.new("RGB", (800, 400), (90, 120, 160)).save(image, "JPEG")
    manager = RunManager(settings, run_id="testrun")
    manager.add_tasks([PanoramaTask(panorama_id="p1", path=image, label=Label.URBAN)])
    session = manager.sessions["p1"]
    name_a_place(session)
    session.finalize(reason="submit_locations")
    manager.export_all()
    export_path = manager.run_dir / "p1.json"
    assert json.loads(export_path.read_text())["final"]["locations"][0]["origin"] == "agent"

    body = {"lat": 38.71, "lng": -9.13, "place_label": PLACE, "confirmed": True}
    async with client_for(manager) as client:  # type: ignore[arg-type]
        assert (await client.post("/api/pano/p1/geocode", json=body)).status_code == 200

    final = json.loads(export_path.read_text())["final"]
    assert {(e["lat"], e["lng"], e["origin"], e["multiplier"]) for e in final["locations"]} == {
        (38.71, -9.13, "human_geocode", 0.5)
    }
    assert final["penalty_state"]["human_geocodes"] == 1
    answers = (manager.run_dir / "answers.csv").read_text().splitlines()
    assert answers[1] == "p1,1,38.710000,-9.130000"


async def test_geocode_makes_the_tile_final_and_closes_the_other_channels(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    session = manager.sessions["p1"]
    name_a_place(session)
    body = {"lat": 38.71, "lng": -9.13, "place_label": PLACE, "confirmed": True}
    async with client_for(manager) as client:
        state = (await client.post("/api/pano/p1/geocode", json=body)).json()["state"]
        cue = await client.post("/api/pano/p1/cue", json={"text": CUE, "confirmed": True})
    assert state["status"] == "done" and state["final"] is not None
    assert cue.status_code == 422 and session.ledger.cues == 0
    assert session.ledger.multiplier == 0.5
