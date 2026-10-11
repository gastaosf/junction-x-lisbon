"""The console's evaluation API: set state, the build job, labels, eval launch, results, rescore,
compare and the ground-truth gate. Offline: a tmp eval data dir, synthetic exports, a scripted
model client and httpx mock transports for Mapillary."""

from __future__ import annotations

import asyncio
import io
import json
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import cv2
import httpx
import numpy as np
import pytest
from fastapi import FastAPI
from PIL import Image

from eval import build_set, run_eval
from eval.build_set import Area
from astrolabio.config import Budget, Settings
from server import evalops
from server.routes.evalapi import router
from server.sets import ConsoleError
from server.workspace import Workspace

LISBON = (38.713900, -9.139400)
PORTO = (41.145600, -8.611000)
HYP = {"lat": LISBON[0], "lng": LISBON[1], "probability": 0.8, "radius_m": 40.0, "label": "Baixa", "evidence": "tram"}
FAST = Budget(effort="high", soft_deadline_s=600, hard_deadline_s=840, max_turns=6, max_spend_usd=8.0)
MAX_SCORE = run_eval.MAX_PANORAMA_SCORE  # 16,050.5: ten entries on the spot
TOKEN = "mapillary-token-0123456789"
HOLD = object()  # in a script: a model call that stays in flight until the test releases it


# --- helpers ----------------------------------------------------------------------------------


def pano_bytes(seed: int = 0, size: tuple[int, int] = (256, 128)) -> bytes:
    noise = np.random.default_rng(seed).integers(0, 255, (size[1], size[0], 3), dtype=np.uint8)
    ok, encoded = cv2.imencode(".jpg", noise)
    assert ok
    return encoded.tobytes()


def reply(name: str, **arguments: Any) -> SimpleNamespace:
    block = {"type": "tool_use", "id": f"call_{name}", "name": name, "input": arguments}
    usage = {"input_tokens": 1000, "cached_input_tokens": 0, "cache_write_tokens": 0, "output_tokens": 100}
    return SimpleNamespace(id="resp", model="gpt-6.1-sol", content=[block], stop_reason="tool_use", stop_details=None, usage=usage)


class ScriptClient:
    """Every panorama: update_candidates, then submit_locations (or HOLD in place of the submit)."""

    def __init__(self, hold: bool = False) -> None:
        self.hold = hold
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def create(self, **params: Any) -> Any:
        turn = 1 + sum(1 for message in params["messages"] if message["role"] == "assistant")
        if turn == 1:
            await asyncio.sleep(0)
            return reply("update_candidates", hypotheses=[HYP])
        if self.hold:
            self.started.set()
            await self.release.wait()
        return reply("submit_locations", hypotheses=[HYP], reasoning_summary="ok")


def workspace(tmp_path: Path, client: Any = None) -> Workspace:
    base = Settings(
        runs_dir=tmp_path / "runs",
        cache_dir=tmp_path / "cache",
        allow_web=False,
        standard=FAST,
        special=FAST,
        live=FAST,
        team="albatross",
    )
    (tmp_path / "runs").mkdir(exist_ok=True)
    return Workspace(
        base,
        data_dir=tmp_path / "data",
        eval_data_dir=tmp_path / "eval",
        client_factory=(lambda settings: client) if client is not None else None,
        env_path=tmp_path / ".env",
        fake_model=False,
    )


def api(ws: Workspace) -> httpx.AsyncClient:
    app = FastAPI()
    app.state.workspace = ws
    app.include_router(router)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1")


def key(n: int = 0) -> dict[str, str]:
    return {"Idempotency-Key": f"eval-test-key-{n:06d}"}


def refusal(response: httpx.Response) -> tuple[int, str | None]:
    return response.status_code, response.json()["detail"]["code"]


def entry(pid: str, label: str, *, point: tuple[float, float] = LISBON, **more: Any) -> dict[str, Any]:
    return {
        "panorama_id": pid,
        "filename": f"{pid}.jpg",
        "lat": point[0],
        "lng": point[1],
        "label": label,
        "label_confirmed": False,
        "timestamp": "20180511142427",
        "source_image_id": f"img-{pid}",
        "sequence": f"seq-{pid}",
        "area": "Lisboa Baixa",
        "country": "PT",
        "kind": "city",
        "creator": "alice",
        **more,
    }


def write_set(ws: Workspace, entries: list[dict[str, Any]], *, images: bool = True) -> Path:
    ws.eval_data_dir.mkdir(parents=True, exist_ok=True)
    if images:
        for index, item in enumerate(entries):
            (ws.eval_data_dir / item["filename"]).write_bytes(pano_bytes(index))
    path = ws.eval_data_dir / "manifest.json"
    build_set.save_manifest(path, entries)
    return path


def hyp(point: tuple[float, float], probability: float) -> dict[str, Any]:
    return {"lat": point[0], "lng": point[1], "probability": probability, "radius_m": 50.0, "label": "", "evidence": ""}


def make_export(pid: str, points: list[tuple[float, float]], *, hypotheses: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    locations = [{"rank": i, "lat": lat, "lng": lng, "multiplier": 1.0, "origin": "agent"} for i, (lat, lng) in enumerate(points, 1)]
    events: list[dict[str, Any]] = []
    if hypotheses is not None:
        events.append({"seq": 1, "type": "candidates_update", "t_rel_s": 5.0, "data": {"hypotheses": hypotheses}})
    events.append({"seq": 2, "type": "final_submission", "t_rel_s": 42.0, "data": {"entries": locations, "allocator": {"plan": "10x1"}}})
    return {
        "schema_version": "1.0",
        "team": "t",
        "panorama": {"panorama_id": pid},
        "config": {},
        "events": events,
        "final": {"locations": locations, "penalty_state": {"cues": 0, "mcqs": 0, "human_geocodes": 0, "multiplier": 1.0}},
        "totals": {"cost_usd": 2.0},
    }


def disk_run(ws: Workspace, run_id: str, *, kind: str = "eval", no_human: bool = True, **meta: Any) -> Path:
    """A finished run on disk as the console writes it: run.json and two exports. p1's top pick is
    wrong and the truth is its close second (hedging recovers it); p2 has no hypotheses logged."""
    run_dir = ws.runs_dir / run_id
    run_dir.mkdir(parents=True)
    hypotheses = [hyp(PORTO, 0.5), hyp(LISBON, 0.45), hyp((43.0, -2.0), 0.05)]
    (run_dir / "p1.json").write_text(json.dumps(make_export("p1", [PORTO] * 10, hypotheses=hypotheses)))
    (run_dir / "p2.json").write_text(json.dumps(make_export("p2", [(PORTO[0] + 0.02, PORTO[1])] * 10)))
    settings = {"no_human": no_human, "model": "gpt-6.1-sol", "hedge": False, "allow_duplicates": True, "allow_web": False}
    doc = {"run_id": run_id, "kind": kind, "preset": kind, "settings": settings, "tasks": [], **meta}
    (run_dir / "run.json").write_text(json.dumps(doc))
    return run_dir


def scored_set(ws: Workspace) -> Path:
    """The manifest the synthetic runs are scored against."""
    return write_set(ws, [entry("p1", "Urban", point=LISBON), entry("p2", "non-Urban", point=PORTO)])


async def until(condition: Any, timeout: float = 10.0) -> None:
    async def poll() -> None:
        while not condition():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


# --- the set ----------------------------------------------------------------------------------


async def test_set_state_counts_splits_and_flags(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MAPILLARY_TOKEN", raising=False)
    ws = workspace(tmp_path)
    async with api(ws) as http:
        empty = (await http.get("/api/eval/set")).json()
        assert (empty["exists"], empty["count"], empty["entries"], empty["mapillary_token"]) == (False, 0, [], False)
        assert empty["build_job_id"] is None and empty["data_dir"] == str(ws.eval_data_dir)

        write_set(
            ws,
            [
                entry("eval_a", "Urban", label_confirmed=True),
                entry("eval_b", "non-Urban", country="ES", kind="rural"),
                entry("eval_c", "TODO", country="FR", kind="village"),
                entry("mly_1234567890", "Urban", label_confirmed=True),
            ],
        )
        (ws.eval_data_dir / "eval_b.jpg").unlink()
        monkeypatch.setenv("MAPILLARY_TOKEN", TOKEN)
        response = await http.get("/api/eval/set")
        state = response.json()

    assert TOKEN not in response.text and state["mapillary_token"] is True
    assert (state["exists"], state["count"]) == (True, 4)
    assert (state["confirmed"], state["unconfirmed"], state["todo"]) == (2, 1, 1)
    assert state["by_label"] == {"Urban": 2, "non-Urban": 1, "TODO": 1}
    assert state["by_country"] == {"PT": 2, "ES": 1, "FR": 1}
    assert state["by_kind"] == {"city": 2, "rural": 1, "village": 1}
    assert state["leaking"] == ["mly_1234567890"] and state["missing"] == ["eval_b"]
    # what the labelling screen needs and no more: the source image key stays in the manifest
    assert set(state["entries"][0]) == {
        "panorama_id", "filename", "label", "label_confirmed", "lat", "lng", "area", "country", "kind", "timestamp"
    }
    assert [(e["label"], e["label_confirmed"]) for e in state["entries"]] == [
        ("Urban", True), ("non-Urban", False), ("TODO", False), ("Urban", True)
    ]


async def test_label_is_a_fixed_choice_written_atomically(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    entries = [entry(f"eval_{i}", "TODO") for i in range(8)]
    path = write_set(ws, entries, images=False)
    async with api(ws) as http:
        done = await http.patch("/api/eval/set/eval_0", json={"label": "non-Urban"})
        assert done.status_code == 200 and done.json()["ok"] is True
        assert (done.json()["entry"]["label"], done.json()["entry"]["label_confirmed"]) == ("non-Urban", True)
        assert done.json()["counts"] == {
            "count": 8, "confirmed": 1, "unconfirmed": 0, "todo": 7, "by_label": {"Urban": 0, "non-Urban": 1, "TODO": 7}
        }

        # never free text, never another field, never a name that is not a panorama of the set
        assert refusal(await http.patch("/api/eval/set/eval_1", json={"label": "rural"})) == (422, "invalid_label")
        assert refusal(await http.patch("/api/eval/set/eval_1", json={"label": "Urban", "lat": 1.0})) == (422, "invalid_request")
        assert refusal(await http.patch("/api/eval/set/eval_99", json={"label": "Urban"})) == (404, "not_found")
        assert refusal(await http.patch("/api/eval/set/img-eval_1", json={"label": "Urban"})) == (404, "not_found")
        assert refusal(await http.patch("/api/eval/set/a..b", json={"label": "Urban"})) == (400, "invalid_id")

        # U / N pressed quickly: every edit is a read-modify-write of the one file, and none is lost
        answers = await asyncio.gather(
            *(http.patch(f"/api/eval/set/eval_{i}", json={"label": "Urban"}) for i in range(1, 8))
        )
    assert {a.status_code for a in answers} == {200}
    saved = build_set.load_manifest(path)
    assert [(e["label"], e["label_confirmed"]) for e in saved] == [("non-Urban", True)] + [("Urban", True)] * 7
    assert saved[3]["source_image_id"] == "img-eval_3" and saved[3]["creator"] == "alice"  # nothing else changed
    assert sorted(p.name for p in ws.eval_data_dir.iterdir()) == ["manifest.json"]  # no temp file left behind


async def test_image_for_the_labelling_viewer(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    write_set(ws, [entry("eval_a", "Urban"), entry("eval_out", "Urban", filename="../secret.jpg")])
    (ws.eval_data_dir / "eval_a.jpg").write_bytes(pano_bytes(1, size=(2048, 1024)))
    (tmp_path / "secret.jpg").write_bytes(pano_bytes(2))
    async with api(ws) as http:
        preview = await http.get("/api/eval/set/eval_a/image?w=320")
        full = await http.get("/api/eval/set/eval_a/image?w=full")
        assert refusal(await http.get("/api/eval/set/eval_zz/image")) == (404, "not_found")
        # a file name in the manifest cannot lead out of the set
        assert refusal(await http.get("/api/eval/set/eval_out/image")) == (403, "outside_eval_set")

    assert preview.status_code == 200 and preview.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(preview.content)).size == (320, 160)
    assert Image.open(io.BytesIO(full.content)).size == (2048, 1024)
    assert not list(ws.eval_data_dir.glob("*_320.jpg"))  # previews are cached outside the set


# --- build ------------------------------------------------------------------------------------


def mapillary(
    areas: tuple[Area, ...], gate: threading.Event | None = None, broken_image: str | None = None
) -> httpx.MockTransport:
    """Mapillary as the builder sees it: one panorama per area, except the last area, whose
    search fails. `gate` holds every search until the test opens it; the download of
    `broken_image` fails."""
    image = io.BytesIO()
    Image.new("RGB", (400, 200), (90, 140, 200)).save(image, "JPEG")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host != "graph.mapillary.com":
            if request.url.path == f"/{broken_image}.jpg":
                return httpx.Response(404)
            return httpx.Response(200, content=image.getvalue())
        if gate is not None:
            gate.wait(10)
        assert request.headers["Authorization"] == f"OAuth {TOKEN}"
        lng = float(request.url.params["bbox"].split(",")[0])
        index = min(range(len(areas)), key=lambda i: abs(areas[i].bbox[0] - lng))
        if index == len(areas) - 1:
            return httpx.Response(401, json={"error": {"message": f"bad token {TOKEN}"}})
        raw = {
            "id": str(1000 + index),
            "computed_geometry": {"type": "Point", "coordinates": [areas[index].lng, areas[index].lat]},
            "captured_at": 1_717_243_200_000,
            "is_pano": True,
            "thumb_original_url": f"https://cdn.example/{1000 + index}.jpg?access_token={TOKEN}",
            "sequence": f"seq{index}",
            "creator": {"username": "alice"},
        }
        return httpx.Response(200, json={"data": [raw]})

    return httpx.MockTransport(handler)


AREAS = (
    Area("Lisboa Baixa", "PT", 38.7139, -9.1394, "city"),
    Area("Monsanto", "PT", 40.0389, -7.1144, "village"),
    Area("La Mancha plain", "ES", 39.4000, -3.1200, "rural"),
    Area("Annecy", "FR", 45.8992, 6.1294, "town"),
    Area("Paris centre", "FR", 48.8566, 2.3522, "city"),
)


async def test_build_runs_as_a_job_with_progress_and_a_log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = workspace(tmp_path)
    gate = threading.Event()
    monkeypatch.setattr(build_set, "AREAS", AREAS)
    # La Mancha's image (1002) cannot be downloaded: the build goes on to the next candidate
    monkeypatch.setattr(build_set, "make_client", lambda: httpx.Client(transport=mapillary(AREAS, gate, "1002")))
    monkeypatch.delenv("MAPILLARY_TOKEN", raising=False)
    async with api(ws) as http:
        missing = await http.post("/api/eval/set/build", json={"count": 3})
        assert refusal(missing) == (409, "mapillary_token_missing") and "MAPILLARY_TOKEN" in missing.json()["detail"]["message"]
        monkeypatch.setenv("MAPILLARY_TOKEN", TOKEN)
        assert refusal(await http.post("/api/eval/set/build", json={"count": 51})) == (422, "invalid_build")
        assert refusal(await http.post("/api/eval/set/build", json={"count": 3, "out": "/tmp"})) == (422, "unknown_field")

        started = await http.post("/api/eval/set/build", json={"count": 4, "seed": 7, "per_area_limit": 5}, headers=key(1))
        assert started.status_code == 200
        job_id = started.json()["job"]["id"]
        assert started.json()["job"]["kind"] == "eval_build"
        # a repeat of the same request is the same job, not a second build
        again = await http.post("/api/eval/set/build", json={"count": 4, "seed": 7, "per_area_limit": 5}, headers=key(1))
        assert again.json()["job"]["id"] == job_id and again.headers["Idempotency-Replayed"] == "true"

        # while it runs: the page finds it again, and nothing else may write the set
        assert (await http.get("/api/eval/set")).json()["build_job_id"] == job_id
        assert refusal(await http.post("/api/eval/set/build", json={"count": 3, "replace": True})) == (409, "build_running")
        assert refusal(await http.patch("/api/eval/set/eval_a", json={"label": "Urban"})) == (409, "build_running")
        assert refusal(await http.post("/api/eval/runs", json={}, headers=key(2))) == (409, "build_running")
        estimate = (await http.post("/api/eval/runs/estimate", json={})).json()
        assert any("being built" in line for line in estimate["blocking"])

        gate.set()
        job = (await ws.jobs.get(job_id).wait()).to_dict()
        state = (await http.get("/api/eval/set")).json()
        exists = await http.post("/api/eval/set/build", json={"count": 3})
        assert refusal(exists) == (409, "set_exists") and exists.json()["detail"]["action"] == "replace"

    assert job["state"] == "done" and job["error"] is None
    assert job["result"] == {"count": 3, "requested": 4, "todo": 1, "manifest": str(ws.eval_data_dir / "manifest.json")}
    assert job["progress"] == {"done": 3, "total": 4, "text": "done"}
    log = "\n".join(job["log"])
    for area in AREAS[:4]:
        assert f"{area.name} [{area.country}, {area.kind}]: 1 panorama\n" in log + "\n"
    assert "Paris centre: search failed" in log and "1002: download failed" in log
    assert "Wrote 3 panoramas (1 labelled TODO, none confirmed)." in log
    assert "Only 3 of 4 requested panoramas were available." in log
    # the failed download's URL carries the token as a query parameter: the log is redacted
    assert "access_token=REDACTED" in log and TOKEN not in json.dumps(job)

    assert (state["count"], state["todo"], state["confirmed"], state["build_job_id"]) == (3, 1, 0, None)
    assert state["by_kind"] == {"city": 1, "village": 1, "town": 1} and state["last_build_job_id"] == job_id
    assert state["leaking"] == [] and state["missing"] == []
    saved = build_set.load_manifest(ws.eval_data_dir / "manifest.json")
    assert {e["source_image_id"] for e in saved} == {"1000", "1001", "1003"}
    assert Image.open(ws.eval_data_dir / saved[0]["filename"]).size == build_set.TARGET_SIZE


async def test_a_build_that_finds_nothing_keeps_the_existing_set(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = workspace(tmp_path)
    path = write_set(ws, [entry("eval_a", "Urban", label_confirmed=True)])
    before = path.read_bytes()
    monkeypatch.setenv("MAPILLARY_TOKEN", TOKEN)
    monkeypatch.setattr(build_set, "AREAS", AREAS[-1:])  # the one area whose search fails
    monkeypatch.setattr(build_set, "make_client", lambda: httpx.Client(transport=mapillary(AREAS[-1:])))
    async with api(ws) as http:
        started = await http.post("/api/eval/set/build", json={"count": 2, "replace": True})
        job = (await ws.jobs.get(started.json()["job"]["id"]).wait()).to_dict()

    assert job["state"] == "failed" and "no panorama could be downloaded" in job["error"]
    assert path.read_bytes() == before


def test_build_set_reports_progress_to_its_caller(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(build_set, "AREAS", AREAS)
    monkeypatch.setattr(build_set, "make_client", lambda: httpx.Client(transport=mapillary(AREAS)))
    progress: list[tuple[int, int, str]] = []
    lines: list[str] = []

    entries = build_set.build_set(
        2, 0, tmp_path, 5, False, token=TOKEN, progress=lambda *step: progress.append(step), log=lines.append
    )

    assert len(entries) == 2 and not (tmp_path / "manifest.json").exists()  # the caller writes the manifest
    assert [step[:2] for step in progress] == [(1, 5), (2, 5), (3, 5), (4, 5), (5, 5), (1, 2), (2, 2)]
    assert progress[0][2] == "searched Lisboa Baixa" and progress[-1][2].startswith("downloaded eval_")
    assert lines[0] == "Searching 5 areas..." and lines[6] == "Downloading up to 2 of 4 candidates..."
    build_set.save_manifest(tmp_path / "manifest.json", entries)
    with pytest.raises(FileExistsError):
        build_set.build_set(2, 0, tmp_path, 5, False, token=TOKEN)


# --- launching and scoring a run --------------------------------------------------------------


async def test_eval_run_from_launch_to_results_rescore_compare_and_truth(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient())
    write_set(
        ws,
        [
            entry("eval_0", "Urban", point=LISBON, label_confirmed=True),
            entry("eval_1", "non-Urban", point=PORTO),
            entry("eval_2", "TODO", point=PORTO),
        ],
    )
    form = {"effort": "low", "hedge": False, "web": False, "tools_off": ["sun_position"], "limit": 2, "concurrency": 1, "run_id": "evalrun"}
    async with api(ws) as http:
        assert refusal(await http.post("/api/eval/runs", json=form)) == (400, "idempotency_key_required")
        todo = await http.post("/api/eval/runs", json=form, headers=key(1))
        assert refusal(todo) == (409, "todo_labels") and todo.json()["detail"]["problems"] == ["eval_2"]
        blocked = (await http.post("/api/eval/runs/estimate", json=form)).json()
        assert (blocked["todo_labels"], len(blocked["blocking"])) == (1, 1) and "label" in blocked["blocking"][0]
        assert (await http.patch("/api/eval/set/eval_2", json={"label": "Urban"})).status_code == 200

        # the form is translated, never trusted: what an eval run is cannot be sent
        for n, extra in enumerate(({"set_id": "x"}, {"no_human": False}, {"special": "eval_0"})):
            sent = await http.post("/api/eval/runs", json={**form, **extra}, headers=key(20 + n))
            assert refusal(sent) == (422, "unknown_field")
        assert refusal(await http.post("/api/eval/runs/estimate", json={**form, "effort": "extreme"})) == (422, "invalid_setting")
        assert refusal(await http.post("/api/eval/runs/estimate", json={**form, "limit": 0})) == (422, "invalid_limit")
        assert refusal(await http.post("/api/eval/runs/estimate", json={**form, "tools_off": ["submit_locations"]}))[0] == 422

        estimate = (await http.post("/api/eval/runs/estimate", json=form)).json()
        assert estimate == {"panoramas": 2, "cost_ceiling_usd": 16.0, "todo_labels": 0, "unconfirmed_labels": 1, "blocking": []}
        assert (await http.post("/api/eval/runs/estimate", json={})).json()["panoramas"] == 3
        assert not (ws.runs_dir / "evalrun").exists()  # an estimate creates nothing

        launched = await http.post("/api/eval/runs", json=form, headers=key(3))
        assert launched.status_code == 201
        assert launched.json() == {"run_id": "evalrun", "url": "/runs/evalrun", "cost_ceiling_usd": 16.0}
        repeat = await http.post("/api/eval/runs", json=form, headers=key(3))
        assert repeat.json() == launched.json() and repeat.headers["Idempotency-Replayed"] == "true"
        reused = await http.post("/api/eval/runs", json={**form, "limit": 1}, headers=key(3))
        assert refusal(reused) == (422, "idempotency_key_reuse")

        handle = ws.owned("evalrun")
        settings = handle.settings
        assert (settings.standard.effort, settings.special.effort, settings.standard.max_spend_usd) == ("low", "low", 8.0)
        assert (settings.hedge, settings.allow_web, settings.disabled_tools, settings.concurrency) == (False, False, ("sun_position",), 1)
        assert settings.no_human is True and handle.kind == "eval" and sorted(handle.manager.sessions) == ["eval_0", "eval_1"]
        assert handle.meta["eval"]["limit"] == 2
        await until(lambda: handle.idle and handle.task is not None)

        # scored by the workspace through evalops.score_run_dir when the run ended
        run_dir = ws.runs_dir / "evalrun"
        stored = json.loads((run_dir / "results.json").read_text())
        assert stored["config"] == {
            "mode": "run",
            "model": "gpt-6.1-sol",
            "effort": {"standard": "low", "special": "low"},
            "hedge": False,
            "allow_duplicates": True,
            "allow_web": False,
            "tools_off": ["sun_position"],
            "manifest": str(ws.eval_data_dir / "manifest.json"),
            "panoramas": 2,
            "fake_model": False,
        }
        assert (run_dir / "results.csv").is_file()
        results = (await http.get("/api/runs/evalrun/results")).json()
        assert results["run_id"] == "evalrun" and results["tag"] == "" and results["variants"] == []
        assert results["results"] == stored and results["config"] == stored["config"]
        assert set(results["results"]["summary"]) == {"all", "Urban", "non-Urban"}
        scores = {p["panorama_id"]: p for p in results["results"]["panoramas"]}
        assert scores["eval_0"]["rank1_distance_m"] == pytest.approx(0.0) and scores["eval_0"]["score"] == pytest.approx(MAX_SCORE)
        assert scores["eval_1"]["rank1_distance_m"] > 200_000 and scores["eval_1"]["label"] == "non-Urban"
        assert (await ws.get_run("evalrun"))["results"]["variants"] == []

        # rescore: offline, one file per variant, listed beside the original
        hedged = await http.post("/api/runs/evalrun/rescore", json={"hedge": True}, headers=key(4))
        assert hedged.status_code == 200 and hedged.json()["tag"] == "hedge"
        assert hedged.json()["results"]["config"] == {
            "mode": "rescore",
            "reallocated": True,
            "hedge": True,
            "allow_duplicates": True,
            "manifest": str(ws.eval_data_dir / "manifest.json"),
            "panoramas": 2,
            "fake_model": False,
        }
        assert json.loads((run_dir / "results.hedge.json").read_text()) == hedged.json()["results"]
        distinct = await http.post("/api/runs/evalrun/rescore", json={"hedge": False, "duplicates": False})
        named = await http.post("/api/runs/evalrun/rescore", json={"hedge": None, "duplicates": True, "tag": "again"})
        assert (distinct.json()["tag"], named.json()["tag"]) == ("nohedge-distinct", "again")
        assert named.json()["results"]["config"]["reallocated"] is False
        for bad in ({"tag": "../../x"}, {"tag": "UPPER"}, {"hedge": True, "tag": ""}, {"hedge": "yes"}, {"plan": "10x1"}):
            assert (await http.post("/api/runs/evalrun/rescore", json=bad)).status_code == 422, bad
        assert sorted(p.name for p in run_dir.glob("results*")) == [
            "results.again.csv", "results.again.json", "results.csv", "results.hedge.csv", "results.hedge.json",
            "results.json", "results.nohedge-distinct.csv", "results.nohedge-distinct.json",
        ]
        assert not list(tmp_path.rglob("x.json")) and not list(run_dir.glob(".results-*"))

        listed = (await http.get("/api/runs/evalrun/results?tag=nohedge-distinct")).json()
        assert [v["tag"] for v in listed["variants"]] == ["again", "hedge", "nohedge-distinct"]
        assert listed["results"] == distinct.json()["results"] and listed["config"]["mode"] == "run"
        assert listed["variants"][2]["config"]["allow_duplicates"] is False and "all" in listed["variants"][2]["summary"]
        assert refusal(await http.get("/api/runs/evalrun/results?tag=nope")) == (404, "no_results")
        assert refusal(await http.get("/api/runs/evalrun/results?tag=..%2Fx")) == (400, "invalid_tag")
        assert (await ws.get_run("evalrun"))["results"]["variants"] == ["again", "hedge", "nohedge-distinct"]

        # the empty tag rewrites results.json itself, with the run's own configuration
        (run_dir / "results.json").unlink()
        assert refusal(await http.get("/api/runs/evalrun/results")) == (404, "no_results")
        rewritten = await http.post("/api/runs/evalrun/rescore", json={"hedge": None, "duplicates": True, "tag": ""})
        assert rewritten.json()["tag"] == "" and rewritten.json()["results"] == stored
        assert json.loads((run_dir / "results.json").read_text()) == stored

        # ground truth: where each entry is, how far, and how far the top hypothesis was over time
        truth = (await http.get("/api/eval/runs/evalrun/truth")).json()["panoramas"]
        assert sorted(truth) == ["eval_0", "eval_1"]
        hit, miss = truth["eval_0"], truth["eval_1"]
        assert (hit["lat"], hit["lng"], hit["label"], hit["band"]) == (*LISBON, "Urban", "100m")
        assert hit["entries"] == [{"rank": r, "lat": LISBON[0], "lng": LISBON[1], "distance_m": 0.0, "theta": 2.0} for r in range(1, 11)]
        assert (hit["rank1_distance_m"], hit["share"]) == (0.0, 1.0)
        assert hit["score"] == hit["max_score"] == round(MAX_SCORE, 2)
        assert [set(point) for point in hit["top_distance_series"]] == [{"seq", "t_rel_s", "distance_m"}]
        assert hit["top_distance_series"][0]["distance_m"] == 0.0
        assert miss["band"] == "far" and miss["share"] < 0.05 and miss["entries"][0]["distance_m"] == miss["rank1_distance_m"]
        varied = (await http.get("/api/eval/runs/evalrun/truth?tag=nohedge-distinct")).json()
        assert varied["tag"] == "nohedge-distinct"
        assert len({(e["lat"], e["lng"]) for e in varied["panoramas"]["eval_0"]["entries"]}) == 10
        assert refusal(await http.get("/api/eval/runs/evalrun/truth?tag=nope")) == (404, "no_results")

        compared = (await http.get("/api/eval/compare?a=evalrun&b=evalrun:nohedge-distinct")).json()
        assert (compared["a"]["tag"], compared["b"]["tag"], compared["b"]["run_id"]) == ("", "nohedge-distinct", "evalrun")
        assert compared["comparison"]["paired"]["n"] == 2 and "mean_score" in compared["comparison"]["groups"]["all"]
        assert [set(row) for row in compared["panoramas"]] == [{"panorama_id", "label", "score_a", "score_b", "delta"}] * 2
        changes = [abs(row["delta"]) for row in compared["panoramas"]]
        assert changes == sorted(changes, reverse=True) and changes[0] > changes[1]  # the largest change first


async def test_while_an_eval_run_is_going_its_set_and_results_are_frozen(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = ScriptClient(hold=True)
    ws = workspace(tmp_path, client)
    path = write_set(ws, [entry("eval_0", "Urban", point=LISBON)])
    monkeypatch.setenv("MAPILLARY_TOKEN", TOKEN)
    async with api(ws) as http:
        launched = await http.post("/api/eval/runs", json={"run_id": "held"}, headers=key(1))
        assert launched.status_code == 201
        await asyncio.wait_for(client.started.wait(), 10)

        build = await http.post("/api/eval/set/build", json={"count": 1, "replace": True})
        assert refusal(build) == (409, "eval_run_active") and "held" in build.json()["detail"]["message"]
        # the run was launched with this label: confirming it is fine, changing it is not
        assert refusal(await http.patch("/api/eval/set/eval_0", json={"label": "non-Urban"})) == (409, "eval_run_active")
        assert (await http.patch("/api/eval/set/eval_0", json={"label": "Urban"})).status_code == 200
        assert build_set.load_manifest(path)[0]["label_confirmed"] is True
        assert refusal(await http.post("/api/runs/held/rescore", json={"hedge": True})) == (409, "run_active")
        assert refusal(await http.get("/api/runs/held/results")) == (404, "no_results")
        assert (await http.get("/api/eval/runs/held/truth")).json()["panoramas"] == {}  # nothing exported yet

        client.release.set()
        handle = ws.owned("held")
        await until(lambda: handle.idle)
        assert (await http.get("/api/runs/held/results")).json()["results"]["summary"]["all"]["n"] == 1


# --- results of runs on disk, and the gate ----------------------------------------------------


async def test_rescore_and_compare_of_a_run_on_disk(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    manifest = scored_set(ws)
    run_dir = disk_run(ws, "r1", eval={"manifest": str(manifest), "limit": None})
    async with api(ws) as http:
        assert refusal(await http.get("/api/runs/r1/results")) == (404, "no_results")
        # an interrupted and rebuilt run has no results.json: the empty tag writes it from run.json
        first = (await http.post("/api/runs/r1/rescore", json={"tag": ""}, headers=key(1))).json()
        assert first["tag"] == "" and first["results"]["config"] == {
            "mode": "run",
            "model": "gpt-6.1-sol",
            # what the run.json does not freeze is this server's own value, as for every other use of it
            "effort": {"standard": FAST.effort, "special": FAST.effort},
            "hedge": False,
            "allow_duplicates": True,
            "allow_web": False,
            "tools_off": [],
            "manifest": str(manifest),
            "panoramas": 2,
            "fake_model": False,
        }
        hedged = (await http.post("/api/runs/r1/rescore", json={"hedge": True}, headers=key(2))).json()
        plans = {p["panorama_id"]: p["plan"] for p in hedged["results"]["panoramas"]}
        assert plans == {"p1": "6x1+4x2", "p2": "10x1"}

        compared = (await http.get("/api/eval/compare?a=r1&b=r1:hedge")).json()
        assert compared["comparison"]["paired"] == {
            "n": 2, "mean_score_delta": pytest.approx(compared["panoramas"][0]["delta"] / 2), "b_better": 1, "a_better": 0, "ties": 1
        }
        assert [(row["panorama_id"], row["label"]) for row in compared["panoramas"]] == [("p1", "Urban"), ("p2", "non-Urban")]
        assert compared["panoramas"][0]["delta"] == pytest.approx(compared["panoramas"][0]["score_b"] - compared["panoramas"][0]["score_a"])
        assert compared["panoramas"][0]["delta"] > 1000 and compared["panoramas"][1]["delta"] == 0

        # the variant's truth view shows the list that variant scored, not the logged one
        logged = (await http.get("/api/eval/runs/r1/truth")).json()["panoramas"]["p1"]
        varied = (await http.get("/api/eval/runs/r1/truth?tag=hedge")).json()["panoramas"]["p1"]
        assert [e["distance_m"] > 200_000 for e in logged["entries"]] == [True] * 10 and logged["band"] == "far"
        assert [e["theta"] for e in varied["entries"][6:]] == [2.0] * 4 and varied["score"] > logged["score"]
        assert varied["band"] == "far"  # the band is the rank-1 distance, which hedging leaves alone
        assert [p["distance_m"] for p in logged["top_distance_series"]] == [logged["rank1_distance_m"]]
        assert (await http.get("/api/eval/runs/r1/truth")).json()["panoramas"]["p2"]["band"] == "10km"

        # a side answered by the scripted model is not compared with a real one
        fake_dir = disk_run(ws, "r2", eval={"manifest": str(manifest), "limit": None}, fake_model=True)
        await http.post("/api/runs/r2/rescore", json={"tag": ""})
        assert json.loads((fake_dir / "results.json").read_text())["config"]["fake_model"] is True
        assert refusal(await http.get("/api/eval/compare?a=r1&b=r2")) == (409, "fake_model_mismatch")
        assert (await http.get("/api/eval/compare?a=r2&b=r2")).status_code == 200

        assert refusal(await http.get("/api/eval/compare?a=r1")) == (400, "invalid_ref")
        assert refusal(await http.get("/api/eval/compare?a=r1&b=r1:..%2Fx")) == (400, "invalid_ref")
        assert refusal(await http.get("/api/eval/compare?a=r1&b=nobody")) == (404, "not_found")
        assert refusal(await http.get("/api/eval/compare?a=r1&b=r1:nope")) == (404, "no_results")
    assert sorted(p.name for p in run_dir.glob("results*")) == ["results.csv", "results.hedge.csv", "results.hedge.json", "results.json"]


async def test_truth_derived_data_only_leaves_for_an_autonomous_eval_run(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    manifest = scored_set(ws)
    good = disk_run(ws, "good", eval={"manifest": str(manifest)})
    evalops.score_run_dir(good, manifest, {"mode": "run"})

    # a scoring run, an eval run launched with the human channels on, and one whose log shows a cue
    for run_id, options in (("scoring", {"kind": "scoring", "no_human": False}), ("assisted", {"no_human": False}), ("cued", {})):
        run_dir = disk_run(ws, run_id, **options)
        evalops.score_run_dir(run_dir, manifest, {"mode": "run"})  # results on disk must not be enough
    start = {"seq": 1, "ts": "2026-10-10T10:00:00.000Z", "t_rel_s": 0.0, "actor": "harness", "type": "run_start",
             "data": {"flags": {"no_human": True}, "label": "Urban"}, "penalty_state": {}}
    cue = {**start, "seq": 2, "actor": "human", "type": "human_cue", "data": {"text": "look left"}}
    (ws.runs_dir / "cued" / "p1.events.jsonl").write_text(json.dumps(start) + "\n" + json.dumps(cue) + "\n")

    # `cli.py eval run` writes no run.json: its results and its logs say what it was
    cli = ws.runs_dir / "cli"
    cli.mkdir()
    (cli / "p1.json").write_text((good / "p1.json").read_text())
    (cli / "p1.events.jsonl").write_text(json.dumps(start) + "\n")
    evalops.score_run_dir(cli, manifest, {"mode": "run", "manifest": str(manifest)})

    async with api(ws) as http:
        for run_id in ("scoring", "assisted", "cued"):
            assert refusal(await http.get(f"/api/runs/{run_id}/results")) == (403, "truth_not_allowed"), run_id
            assert refusal(await http.get(f"/api/eval/runs/{run_id}/truth")) == (403, "truth_not_allowed"), run_id
            assert refusal(await http.post(f"/api/runs/{run_id}/rescore", json={"hedge": True})) == (403, "truth_not_allowed")
            for query in (f"a={run_id}&b=good", f"a=good&b={run_id}"):
                denied = await http.get(f"/api/eval/compare?{query}")
                assert refusal(denied) == (403, "truth_not_allowed") and "score" not in denied.text.replace("Scores", "")
            assert not list((ws.runs_dir / run_id).glob("results.hedge*"))

        assert (await http.get("/api/runs/good/results")).status_code == 200
        assert sorted((await http.get("/api/eval/runs/cli/truth")).json()["panoramas"]) == ["p1"]
        assert (await http.get("/api/runs/cli/results")).json()["config"]["mode"] == "run"
        assert (await http.get("/api/eval/compare?a=good&b=cli")).json()["comparison"]["paired"]["n"] == 1

        assert refusal(await http.get("/api/runs/nobody/results")) == (404, "not_found")
        assert refusal(await http.get("/api/eval/runs/nobody/truth")) == (404, "not_found")
        assert refusal(await http.get("/api/runs/a..b/results")) == (400, "invalid_id")
        assert refusal(await http.post("/api/runs/a..b/rescore", json={})) == (400, "invalid_id")


def test_score_run_dir_scores_like_the_cli(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    manifest = scored_set(ws)
    run_dir = disk_run(ws, "r1")
    config = {"mode": "run", "model": "m", "panoramas": 2}

    results = evalops.score_run_dir(run_dir, manifest, config)

    truths = run_eval.truths_from_manifest(build_set.load_manifest(manifest))
    expected = run_eval.build_results("r1", config, run_eval.score_run(run_eval.load_exports(run_dir), truths))
    assert results == expected == json.loads((run_dir / "results.json").read_text())
    assert (run_dir / "results.csv").read_text().splitlines()[0].startswith("panorama_id,label,special,score")
    assert sorted(p.name for p in run_dir.iterdir()) == ["p1.json", "p2.json", "results.csv", "results.json", "run.json"]

    # a label still TODO on a panorama the run never held does not stop its scoring
    build_set.save_manifest(manifest, [*build_set.load_manifest(manifest), entry("p3", "TODO")])
    assert evalops.score_run_dir(run_dir, manifest, config) == expected

    empty = ws.runs_dir / "empty"
    empty.mkdir()
    with pytest.raises(ConsoleError) as no_exports:
        evalops.score_run_dir(empty, manifest, config)
    assert (no_exports.value.status, no_exports.value.code) == (409, "no_exports")
    build_set.save_manifest(manifest, [entry("other", "Urban")])
    with pytest.raises(ConsoleError) as replaced:
        evalops.score_run_dir(run_dir, manifest, config)
    assert replaced.value.code == "set_changed"
    with pytest.raises(ConsoleError) as gone:
        evalops.score_run_dir(run_dir, tmp_path / "nowhere.json", config)
    assert gone.value.code == "no_eval_set"
