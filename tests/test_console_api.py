"""The console's HTTP layer: middleware, runs, sets, launch, the stream, the legacy mount and the
`serve` command. Offline: a scripted model client, tmp_path directories, httpx.ASGITransport."""

from __future__ import annotations

import asyncio
import csv
import json
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import cv2
import httpx
import numpy as np
import pytest
from fastapi import FastAPI
from typer.testing import CliRunner

import cli
import server.console as console_module
from astrolabio.config import Budget, Settings
from astrolabio.eventlog import validate_export
from server import middleware
from server.app import create_app
from server.console import create_console_app
from server.routes import dumps
from server.runstate import read_events
from server.workspace import Workspace

BASE = "http://127.0.0.1:8000"
HYP = {"lat": 38.7223, "lng": -9.1393, "probability": 0.8, "radius_m": 40.0, "label": "Baixa", "evidence": "tram"}
FAST = Budget(effort="high", soft_deadline_s=600, hard_deadline_s=840, max_turns=6, max_spend_usd=8.0)
CUE = "the kerb stones are painted yellow"
PLACE_CUE = "it is near Lisboa"
HOLD = object()  # in a script: a model call that stays in flight until the run is stopped


def pano_bytes(seed: int = 0, size: tuple[int, int] = (256, 128)) -> bytes:
    noise = np.random.default_rng(seed).integers(0, 255, (size[1], size[0], 3), dtype=np.uint8)
    ok, encoded = cv2.imencode(".jpg", noise)
    assert ok
    return encoded.tobytes()


def model_reply(name: str, **arguments: Any) -> SimpleNamespace:
    block = {"type": "tool_use", "id": f"call_{name}", "name": name, "input": arguments}
    usage = {"input_tokens": 1000, "cached_input_tokens": 0, "cache_write_tokens": 0, "output_tokens": 100}
    return SimpleNamespace(
        id="resp", model="gpt-6.1-sol", content=[block], stop_reason="tool_use", stop_details=None, usage=usage
    )


def update() -> SimpleNamespace:
    return model_reply("update_candidates", hypotheses=[HYP])


def submit() -> SimpleNamespace:
    return model_reply("submit_locations", hypotheses=[HYP], reasoning_summary="ok")


def ask() -> SimpleNamespace:
    return model_reply(
        "ask_multiple_choice",
        question="Which view matches?",
        options=["Baixa: a lane with tram rails", "A granite quay on a river"],
        why_it_matters="It settles the two candidates.",
    )


class ScriptClient:
    """One script per panorama id ("" stands for every other panorama); the last item repeats."""

    def __init__(self, **scripts: Any) -> None:
        self.scripts = {"": [update(), submit()], **scripts}
        self.calls: dict[str, int] = {}
        self.started = asyncio.Event()

    async def create(self, **params: Any) -> Any:
        panorama_id = params["prompt_cache_key"].rsplit("-", 1)[-1]
        key = panorama_id if panorama_id in self.scripts else ""
        turn = 1 + sum(1 for message in params["messages"] if message["role"] == "assistant")
        self.calls[panorama_id] = self.calls.get(panorama_id, 0) + 1
        script = self.scripts[key]
        item = script[min(self.calls[panorama_id] if key else turn, len(script)) - 1]
        if item is HOLD:
            self.started.set()
            await asyncio.sleep(3600)
        await asyncio.sleep(0)
        return item


def workspace(tmp_path: Path, client: Any = None, **overrides: Any) -> Workspace:
    base = Settings(
        **{
            "runs_dir": tmp_path / "runs",
            "cache_dir": tmp_path / "cache",
            "allow_web": False,
            "standard": FAST,
            "special": FAST,
            "live": FAST,
            "team": "albatross",
            **overrides,
        }
    )
    return Workspace(
        base,
        data_dir=tmp_path / "data",
        eval_data_dir=tmp_path / "eval",
        client_factory=(lambda settings: client) if client is not None else None,
        env_path=tmp_path / ".env",
        fake_model=False,
    )


def browser(app: Any, **kwargs: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE, **kwargs)


def key() -> dict[str, str]:
    return {"Idempotency-Key": uuid.uuid4().hex}


async def until(condition: Any, timeout: float = 10.0) -> None:
    async def poll() -> None:
        while not condition():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


async def finished(ws: Workspace, run_id: str) -> None:
    handle = ws.owned(run_id)
    await until(lambda: handle.idle and handle.task is not None)
    await asyncio.sleep(0.02)


async def upload_set(http: httpx.AsyncClient, files: dict[str, bytes]) -> str:
    created = await http.post("/api/sets", json={"name": "Sunday"})
    assert created.status_code == 200, created.text
    set_id = created.json()["set_id"]
    for path, data in files.items():
        stored = await http.put(f"/api/sets/{set_id}/files", params={"path": path}, content=data)
        assert stored.status_code == 200, stored.text
    return set_id


async def start_run(http: httpx.AsyncClient, files: dict[str, bytes] | None = None, **spec: Any) -> str:
    files = files or {"Urban/a.jpg": pano_bytes(1), "non-Urban/b.jpg": pano_bytes(2)}
    set_id = await upload_set(http, files)
    body = {"preset": "custom", "set_id": set_id, "confirm_no_key": True, **spec}
    launched = await http.post("/api/runs", json=body, headers=key())
    assert launched.status_code == 201, launched.text
    return launched.json()["run_id"]


def log_events(ws: Workspace, run_id: str, pid: str, *kinds: str) -> list[dict[str, Any]]:
    events = read_events(ws.runs_dir / run_id / f"{pid}.events.jsonl")
    return [event for event in events if not kinds or event["type"] in kinds]


def detail(response: httpx.Response) -> dict[str, Any]:
    body = response.json()["detail"]
    assert isinstance(body, dict) and body["message"], body
    return body


# --- the assisted flow, end to end --------------------------------------------------------------


async def test_assisted_flow_from_upload_to_geocode(tmp_path: Path) -> None:
    client = ScriptClient(a=[update(), ask(), HOLD])
    ws = workspace(tmp_path, client)
    async with browser(create_console_app(ws)) as http:
        manifest = "filename,label,timestamp,special\na.jpg,Urban,20261011093000,true\nb.jpg,non-Urban,20261011101500,false\n"
        files = {"a.jpg": pano_bytes(1), "b.jpg": pano_bytes(2), "labels.csv": manifest.encode()}
        set_id = await upload_set(http, files)

        verdict = (await http.post(f"/api/sets/{set_id}/preflight", json={"preset": "scoring"})).json()
        rows = {row["panorama_id"]: row for row in verdict["rows"]}
        assert verdict["ready"] is True and verdict["blocking"] == [] and set(rows) == {"a", "b"}
        assert (rows["a"]["label"], rows["a"]["sources"]["label"], rows["a"]["special"]) == ("Urban", "manifest", True)
        assert rows["b"]["timestamp"] == "20261011101500" and verdict["cost_ceiling_usd"] == 16.0

        spec = {"preset": "scoring", "set_id": set_id, "confirm_no_key": True, "preflight_token": verdict["preflight_token"]}
        unkeyed = await http.post("/api/runs", json=spec)
        assert unkeyed.status_code == 400 and detail(unkeyed)["code"] == "idempotency_key_required"
        launch_key = key()
        launched = await http.post("/api/runs", json=spec, headers=launch_key)
        again = await http.post("/api/runs", json=spec, headers=launch_key)
        run_id = launched.json()["run_id"]
        assert launched.status_code == again.status_code == 201 and launched.json() == again.json()
        assert launched.json()["url"] == f"/runs/{run_id}" and again.headers["idempotency-replayed"] == "true"
        assert "idempotency-replayed" not in launched.headers and list(ws.handles) == [run_id]
        pano = f"/api/runs/{run_id}/pano/a"

        # the question: charged when asked, answered by one deliberate request
        await until(lambda: ws.tile(run_id, "a")["pending_mcq"] is not None)
        state = (await http.get(f"/api/runs/{run_id}")).json()
        assert (state["kind"], state["mode"], state["owned"], state["set_id"]) == ("scoring", "assisted", True, set_id)
        tile = state["panoramas"][0]
        assert (tile["panorama_id"], tile["special"], tile["status"]) == ("a", True, "awaiting_mcq")
        mcq = f"{pano}/mcq/{tile['pending_mcq']['id']}/answer"
        assert (await http.post(mcq, json={"index": 0})).status_code == 400  # no key
        assert (await http.post(mcq, json={"index": 7}, headers=key())).status_code == 422
        answered = await http.post(mcq, json={"index": 0}, headers=key())
        assert answered.status_code == 200 and answered.json()["tile"]["pending_mcq"] is None
        assert answered.json()["tile"]["penalty"]["mcqs"] == 1
        late = await http.post(mcq, json={"index": 1}, headers=key())
        assert late.status_code == 409 and "no longer open" in detail(late)["message"]
        await asyncio.wait_for(client.started.wait(), 5)
        assert log_events(ws, run_id, "a", "mcq_answered")[0]["data"]["selected_index"] == 0

        # checking a cue leaves no trace: no event, no penalty, no idempotency entry
        before, remembered = len(log_events(ws, run_id, "a")), len(ws.idempotency)
        checked = await http.post(f"{pano}/cue/check", json={"text": PLACE_CUE}, headers=key())
        verdict = checked.json()
        assert checked.status_code == 200 and verdict["ok"] is False and verdict["reason"] == "lint"
        assert verdict["matches"] and all({"category", "word", "start", "end"} <= set(m) for m in verdict["matches"])
        assert (await http.post(f"{pano}/cue/check", json={"text": CUE})).json()["ok"] is True
        assert len(log_events(ws, run_id, "a")) == before and len(ws.idempotency) == remembered

        # the lint blocks a place name; a compliant cue is charged once however often it is sent
        blocked = await http.post(f"{pano}/cue", json={"text": PLACE_CUE, "confirmed": True}, headers=key())
        refusal = detail(blocked)
        assert blocked.status_code == 422 and refusal["code"] == "cue_lint" and refusal["lint"]["ok"] is False
        assert refusal["matches"] == verdict["matches"] and ws.tile(run_id, "a")["penalty"]["cues"] == 0
        unkeyed = await http.post(f"{pano}/cue", json={"text": CUE, "confirmed": True})
        assert unkeyed.status_code == 400 and detail(unkeyed)["code"] == "idempotency_key_required"
        unconfirmed = await http.post(f"{pano}/cue", json={"text": CUE}, headers=key())
        assert unconfirmed.status_code == 400 and ws.tile(run_id, "a")["penalty"]["cues"] == 0
        cue_key = key()
        first = await http.post(f"{pano}/cue", json={"text": CUE, "confirmed": True}, headers=cue_key)
        second = await http.post(f"{pano}/cue", json={"text": CUE, "confirmed": True}, headers=cue_key)
        assert first.status_code == second.status_code == 200 and second.headers["idempotency-replayed"] == "true"
        assert first.json()["result"]["accepted"] is True and first.json() == second.json()
        tile = ws.tile(run_id, "a")
        assert tile["penalty"]["cues"] == 1 and tile["penalty"]["multiplier"] == pytest.approx(0.76)
        assert len(log_events(ws, run_id, "a", "human_cue")) == 1
        reused = await http.post(f"{pano}/cue", json={"text": "another text", "confirmed": True}, headers=cue_key)
        assert reused.status_code == 422 and detail(reused)["code"] == "idempotency_key_reuse"
        other_tab = await http.post(f"{pano}/cue", json={"text": CUE, "confirmed": True}, headers=key())
        assert other_tab.status_code == 409 and detail(other_tab)["code"] == "cue_duplicate"
        assert ws.tile(run_id, "a")["penalty"]["cues"] == 1

        # the last resort: the tile ends at once and the files on disk follow
        pin = {"lat": 38.7101, "lng": -9.1402, "confirmed": True}
        unnamed = await http.post(f"{pano}/geocode", json={**pin, "place_label": "Atlantis"}, headers=key())
        assert unnamed.status_code == 409 and detail(unnamed)["code"] == "place_not_named"
        assert (await http.post(f"{pano}/geocode", json={**pin, "place_label": "Baixa"})).status_code == 400
        out_of_range = await http.post(f"{pano}/geocode", json={**pin, "lat": 99, "place_label": "Baixa"}, headers=key())
        assert out_of_range.status_code == 422
        pinned = await http.post(f"{pano}/geocode", json={**pin, "place_label": "Baixa"}, headers=key())
        tile = pinned.json()["tile"]
        assert pinned.status_code == 200 and (tile["status"], tile["origin"]) == ("done", "human_geocode")
        assert tile["penalty"]["multiplier"] == pytest.approx(0.38) and tile["active"] is False
        assert {(e["lat"], e["lng"]) for e in tile["final"]} == {(38.7101, -9.1402)}
        run_dir = ws.runs_dir / run_id
        doc = json.loads((run_dir / "a.json").read_text())
        assert validate_export(doc) == [] and doc["final"]["locations"][0]["origin"] == "human_geocode"
        assert doc["events"][-1]["type"] == "run_end"
        with (run_dir / "answers.csv").open(newline="") as fh:
            answers = [row for row in csv.DictReader(fh) if row["panorama_id"] == "a"]
        assert len(answers) == 10 and {(row["lat"], row["lng"]) for row in answers} == {("38.710100", "-9.140200")}
        twice_key = key()
        twice = await http.post(f"{pano}/geocode", json={**pin, "place_label": "Baixa"}, headers=twice_key)
        replay = await http.post(f"{pano}/geocode", json={**pin, "place_label": "Baixa"}, headers=twice_key)
        assert twice.status_code == replay.status_code == 409 and replay.headers["idempotency-replayed"] == "true"
        assert ws.tile(run_id, "a")["penalty"]["human_geocodes"] == 1

        await finished(ws, run_id)
        state = (await http.get(f"/api/runs/{run_id}")).json()
        assert state["state"] == "finished" and state["totals"]["penalties"] == {"cues": 1, "mcqs": 1, "human_geocodes": 1}
        index = (await http.get("/api/runs")).json()["runs"]
        assert [(row["run_id"], row["state"]) for row in index] == [(run_id, "finished")] and "panoramas" not in index[0]

        # the stream's backlog, one whole event, and the images
        digests = (await http.get(f"{pano}/events")).json()["events"]
        assert [d["seq"] for d in digests] == list(range(1, len(digests) + 1)) and digests[0]["type"] == "run_start"
        assert {"category", "lines", "turn", "images"} <= set(digests[0])
        tail = (await http.get(f"{pano}/events", params={"after": digests[-2]["seq"]})).json()["events"]
        assert [d["seq"] for d in tail] == [digests[-1]["seq"]]
        whole = (await http.get(f"{pano}/events", params={"seq": 1, "full": 1})).json()["events"]
        assert len(whole) == 1 and whole[0]["type"] == "run_start" and "system_prompt" in json.dumps(whole[0])
        assert (await http.get(f"/api/runs/{run_id}/pano/nope/events")).status_code == 404
        for width in ("1024", "full"):
            image = await http.get(f"{pano}/image", params={"w": width})
            assert image.status_code == 200 and image.headers["content-type"] == "image/jpeg"
        assert image.content == files["a.jpg"]  # "full" is the stored file, byte for byte
        sha = next((run_dir / "a" / "images").glob("*.jpg")).stem
        view = await http.get(f"{pano}/views/{sha}")
        assert view.status_code == 200 and view.headers["content-type"] == "image/jpeg"
        assert (await http.get(f"{pano}/views/{'cd' * 32}")).status_code == 404


# --- who may talk to the console ----------------------------------------------------------------


def test_security_checks_are_exact_about_hosts_origins_and_bodies() -> None:
    hosts = middleware.allowed_hosts(8000)
    assert hosts == {"127.0.0.1:8000", "localhost:8000", "[::1]:8000"}
    assert middleware.allowed_hosts(8000, "192.168.1.20") == hosts | {"192.168.1.20:8000"}
    assert middleware.host_allowed("LOCALHOST:8000", hosts) and not middleware.host_allowed("localhost", hosts)
    assert not middleware.host_allowed("localhost:3000", hosts) and not middleware.host_allowed(None, hosts)
    assert middleware.host_allowed("localhost", middleware.allowed_hosts(80))
    origins = middleware.allowed_origins(hosts)
    assert middleware.origin_problem("POST", None, None, origins) is None  # curl, tests, the CLI
    assert middleware.origin_problem("POST", "http://localhost:8000", "same-origin", origins) is None
    assert middleware.origin_problem("GET", "https://evil.example", "cross-site", origins) is None  # reads change nothing
    for origin in ("https://evil.example", "http://localhost:3000", "http://localhost", "null"):
        assert middleware.origin_problem("POST", origin, None, origins), origin
    for site in ("cross-site", "same-site"):
        assert middleware.origin_problem("DELETE", None, site, origins), site
    json_body = {"content-length": "2", "content-type": "application/json; charset=utf-8"}
    assert middleware.content_type_problem("POST", "/api/runs", json_body) is None
    assert middleware.content_type_problem("POST", "/api/runs", {"content-length": "2", "content-type": "text/plain"})
    assert middleware.content_type_problem("POST", "/api/runs", {"content-length": "0"}) is None
    assert middleware.content_type_problem("PUT", "/api/sets/s1/files", {"content-length": "9"}) is None
    assert middleware.content_type_problem("PUT", "/api/sets/s1/files/x", {"content-length": "9"})
    assert middleware.token_matches("abc", "abc") and not middleware.token_matches(None, "abc")
    assert middleware.is_loopback("127.0.0.1") and middleware.is_loopback("localhost") and middleware.is_loopback("::1")
    assert not middleware.is_loopback("0.0.0.0") and not middleware.is_loopback("192.168.1.20")


async def test_csrf_host_and_content_type_are_enforced_and_every_answer_is_hardened(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    async with browser(create_console_app(ws)) as http:
        foreign = await http.post("/api/sets", json={}, headers={"Origin": "https://evil.example"})
        assert foreign.status_code == 403 and detail(foreign)["code"] == "forbidden_origin"
        neighbour = await http.post("/api/sets", json={}, headers={"Origin": "http://localhost:3000"})
        same_site = await http.post("/api/sets", json={}, headers={"Sec-Fetch-Site": "same-site"})
        assert neighbour.status_code == same_site.status_code == 403 and ws.sets.list() == []
        rebound = await http.get("/api/snapshot", headers={"Host": "evil.example:8000"})
        assert rebound.status_code == 421 and detail(rebound)["code"] == "wrong_host"
        assert (await http.get("/", headers={"Host": "127.0.0.1:9000"})).status_code == 421
        form = await http.post("/api/sets", content=b'{"name": "x"}', headers={"Content-Type": "text/plain"})
        assert form.status_code == 415 and ws.sets.list() == []

        plain = await http.post("/api/sets", json={})  # no Origin: curl, a script
        own = await http.post(
            "/api/sets", json={}, headers={"Origin": "http://localhost:8000", "Sec-Fetch-Site": "same-origin"}
        )
        assert plain.status_code == own.status_code == 200 and len(ws.sets.list()) == 2
        assert (await http.get("/api/snapshot", headers={"Origin": "https://evil.example"})).status_code == 200

        for response in (plain, foreign, rebound, await http.get("/"), await http.get("/api/nope")):
            assert response.headers["x-content-type-options"] == "nosniff"
            assert response.headers["x-frame-options"] == "DENY" and response.headers["referrer-policy"] == "no-referrer"
            policy = response.headers["content-security-policy"]
            assert "script-src 'self';" in policy and "frame-ancestors 'none'" in policy and "unsafe-eval" not in policy
            assert not any(name.lower().startswith("access-control-") for name in response.headers)


async def test_a_crash_is_answered_in_the_api_shape_with_the_headers_and_still_raised() -> None:
    app = FastAPI()
    app.add_middleware(middleware.SecurityMiddleware, policy=middleware.SecurityPolicy.for_server(8000))

    @app.get("/api/broken")
    async def broken() -> None:
        raise RuntimeError("boom")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url=BASE) as http:
        crashed = await http.get("/api/broken")
    assert crashed.status_code == 500 and detail(crashed)["code"] == "internal_error"
    assert "boom" not in crashed.text and crashed.headers["x-content-type-options"] == "nosniff"
    with pytest.raises(RuntimeError):  # it still reaches the server's log
        async with browser(app) as http:
            await http.get("/api/broken")
    assert dumps({"gap": float("nan"), "far": [float("inf")], "ok": 1.5}) == '{"gap": null, "far": [null], "ok": 1.5}'


async def test_lan_access_needs_the_token_and_closes_the_disk(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    token = ws.store.set_lan(True)["token"]
    app = create_console_app(ws, lan_host="192.168.1.20")
    async with browser(app) as http:
        assert (await http.get("/")).status_code == 401
        refused = await http.get("/api/snapshot")
        assert refused.status_code == 401 and detail(refused)["code"] == "token_required"
        assert (await http.get("/", params={"token": "wrong"})).status_code == 403
        assert (await http.get("/api/snapshot", params={"token": token})).status_code == 401  # only on GET /
        joined = await http.get("/", params={"token": token})
        cookie = joined.headers["set-cookie"]
        assert joined.status_code == 303 and joined.headers["location"] == "/"
        assert cookie.startswith(f"astrolabio_token={token};") and "HttpOnly" in cookie and "SameSite=Strict" in cookie
        assert token not in (await http.get("/api/snapshot")).text  # the cookie jar now holds it
        lan = {"Host": "192.168.1.20:8000"}
        assert (await http.get("/api/snapshot", headers=lan)).status_code == 200
        assert (await http.get("/api/snapshot", headers={"Host": "192.168.1.99:8000"})).status_code == 421

        browse = await http.get("/api/fs")
        path_set = await http.post("/api/sets", json={"path": str(tmp_path)})
        assert browse.status_code == path_set.status_code == 403 and detail(browse)["code"] == "lan_restricted"
        set_id = await upload_set(http, {"Urban/a.jpg": pano_bytes(1)})  # uploads still work
        assert (await http.get(f"/api/sets/{set_id}")).json()["rows"][0]["panorama_id"] == "a"
    async with browser(app, headers={"X-Astrolabio-Token": token}) as script:
        assert (await script.get("/api/snapshot")).json()["health"]["lan"] is True


# --- names that become paths --------------------------------------------------------------------


async def test_ids_and_paths_from_a_request_never_reach_the_disk_unchecked(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient())
    (tmp_path / "runs").mkdir()
    (tmp_path / "precious.txt").write_text("keep")
    async with browser(create_console_app(ws)) as http:
        for url in ("/api/runs/%2e%2e", "/api/runs/..%2Fdata", "/api/runs/a%20b", "/api/runs/%2e%2e/pano/a/events"):
            response = await http.get(url)
            assert response.status_code in {400, 404}, url
        climbed = await http.request("DELETE", "/api/runs/%2e%2e", json={"confirm": ".."})
        assert climbed.status_code == 400 and detail(climbed)["code"] == "invalid_id"
        assert (tmp_path / "precious.txt").read_text() == "keep" and (tmp_path / "runs").is_dir()
        assert (await http.get("/api/runs/unknown-run")).status_code == 404
        assert (await http.get("/api/jobs/..%2Fx")).status_code in {400, 404}
        assert (await http.get("/api/jobs/0123456789abcdef")).status_code == 404

        set_id = await upload_set(http, {"Urban/a.jpg": pano_bytes(1)})
        for bad in ("../a.jpg", "/etc/a.jpg", "a\\b.jpg", "x/../a.jpg", "a.exe"):
            stored = await http.put(f"/api/sets/{set_id}/files", params={"path": bad}, content=pano_bytes(2))
            assert stored.status_code == 422, bad
        assert (await http.put(f"/api/sets/{set_id}/files", content=b"x")).status_code == 422  # no path
        clash = await http.put(f"/api/sets/{set_id}/files", params={"path": "Urban/a.jpg"}, content=pano_bytes(9))
        assert clash.status_code == 409 and detail(clash)["code"] == "file_exists"
        hidden = await http.put(f"/api/sets/{set_id}/files", params={"path": ".DS_Store"}, content=b"x")
        assert hidden.json() == {"ok": True, "stored": [], "ignored": [".DS_Store"]}
        assert sorted(p.name for p in (ws.sets.root / set_id / "files").rglob("*") if p.is_file()) == ["a.jpg"]
        assert (await http.get("/api/sets/%2e%2e")).status_code in {400, 404}
        assert (await http.get("/api/sets/set-unknown")).status_code == 404
        thumb = await http.get(f"/api/sets/{set_id}/image/a", params={"w": 320})
        by_path = await http.get(f"/api/sets/{set_id}/image/Urban/a.jpg")
        assert thumb.status_code == by_path.status_code == 200 and thumb.headers["content-type"] == "image/jpeg"
        assert (await http.get(f"/api/sets/{set_id}/image/..%2F..%2Fprecious.txt")).status_code == 404

        async def launch(**spec: Any) -> httpx.Response:
            body = {"preset": "custom", "set_id": set_id, "confirm_no_key": True, **spec}
            return await http.post("/api/runs", json=body, headers=key())

        for spec in (
            {"run_id": "../escape"},
            {"set_id": "../../etc"},
            {"overrides": {"a": {"timestamp": "church of Sao Roque, Lisbon"}}},
            {"overrides": {"a": {"timestamp": "20261399000000"}}},
            {"overrides": {"a": {"label": "urban, near the river"}}},
            {"overrides": {"a": {"special": "yes"}}},
            {"overrides": {"a": {"hint": "look north"}}},
            {"overrides": {"nobody": {"label": "Urban"}}},
            {"apply_label_to_unlabelled": "Lisbon"},
            {"hint": "look near the river"},
            {"settings": {"mcq_timeout_s": 1}},
        ):
            refused = await launch(**spec)
            assert refused.status_code == 422 and detail(refused), spec
        assert ws.handles == {} and list((tmp_path / "runs").iterdir()) == []
        preview = await http.get(f"/api/sets/{set_id}", params={"overrides": json.dumps({"a": {"label": "non-Urban"}})})
        assert preview.json()["rows"][0]["sources"]["label"] == "operator"
        assert (await http.get(f"/api/sets/{set_id}", params={"overrides": "{not json"})).status_code == 422

        run_id = (await launch(run_id="trial-1")).json()["run_id"]
        await finished(ws, run_id)
        assert run_id == "trial-1"
        for sha in ("zz", "..%2Fsecret", "ab" * 31):
            assert (await http.get(f"/api/runs/{run_id}/pano/a/views/{sha}")).status_code in {400, 404}, sha
        assert (await http.get(f"/api/runs/{run_id}/pano/..%2Fa/image")).status_code in {400, 404}
        frozen = await http.put(f"/api/sets/{set_id}/files", params={"path": "Urban/new.jpg"}, content=pano_bytes(3))
        in_use = await http.request("DELETE", f"/api/sets/{set_id}")
        assert frozen.status_code == in_use.status_code == 409 and detail(in_use)["code"] == "set_in_use"


async def test_directory_browser_and_path_sets_stay_inside_the_allowed_roots(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    usb = tmp_path / "usb"
    (usb / "batch" / "Urban").mkdir(parents=True)
    (usb / "batch" / "Urban" / "a.jpg").write_bytes(pano_bytes(1))
    (usb / "batch" / "notes.txt").write_text("x")
    (usb / ".hidden").mkdir()
    (tmp_path / "outside").mkdir()
    (usb / "way-out").symlink_to(tmp_path / "outside")
    ws.store.set_paths({"allowed_roots": [str(usb)]})
    root = str(usb.resolve())
    async with browser(create_console_app(ws)) as http:
        top = (await http.get("/api/fs")).json()
        assert top["path"] is None and root in top["roots"] and root in [entry["path"] for entry in top["entries"]]
        listing = (await http.get("/api/fs", params={"path": str(usb)})).json()
        assert listing["path"] == root and listing["parent"] is None
        assert [(e["name"], e["dir"], e["images"]) for e in listing["entries"]] == [("batch", True, 1)]
        inner = (await http.get("/api/fs", params={"path": str(usb / "batch")})).json()
        assert inner["parent"] == root and [e["name"] for e in inner["entries"]] == ["Urban"]
        for outside in (str(tmp_path), str(usb / "way-out"), str(usb / ".." / "outside"), "/etc"):
            refused = await http.get("/api/fs", params={"path": outside})
            assert refused.status_code == 403 and detail(refused)["code"] == "outside_allowed_roots", outside
        assert (await http.get("/api/fs", params={"path": str(usb / "gone")})).status_code == 404

        assert (await http.post("/api/sets", json={"path": str(tmp_path / "outside")})).status_code == 403
        created = await http.post("/api/sets", json={"path": str(usb / "batch"), "name": "USB"})
        assert created.status_code == 200 and created.json()["kind"] == "path" and created.json()["panoramas"] == 1
        listed = (await http.get("/api/sets")).json()["sets"]
        assert [(row["set_id"], row["name"]) for row in listed] == [(created.json()["set_id"], "USB")]
        assert (await http.request("DELETE", f"/api/sets/{created.json()['set_id']}")).json() == {"ok": True}
        assert (await http.get("/api/sets")).json()["sets"] == []


# --- what a run accepts, and from whom ----------------------------------------------------------


async def test_human_channels_answer_403_on_an_autonomous_run(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient(**{"": [update(), HOLD]}))
    async with browser(create_console_app(ws)) as http:
        run_id = await start_run(http, preset="autonomous")
        pano = f"/api/runs/{run_id}/pano/a"
        await until(lambda: bool(ws.tile(run_id, "a")["named_places"]))
        attempts = [
            await http.post(f"{pano}/cue", json={"text": CUE, "confirmed": True}, headers=key()),
            await http.post(f"{pano}/cue/check", json={"text": CUE}),
            await http.post(f"{pano}/mcq/a-mcq-1/answer", json={"index": 0}, headers=key()),
            await http.post(
                f"{pano}/geocode",
                json={"lat": 38.7, "lng": -9.1, "place_label": "Baixa", "confirmed": True},
                headers=key(),
            ),
            await http.post(f"{pano}/mcq_allowed", json={"allowed": False}),
        ]
        assert [r.status_code for r in attempts] == [403] * 5
        assert {detail(r)["code"] for r in attempts} == {"human_channels_off"}
        human = ("human_cue", "human_cue_rejected", "human_geocode", "mcq_answered", "mcq_toggle")
        assert ws.tile(run_id, "a")["penalty"]["multiplier"] == 1.0 and not log_events(ws, run_id, "a", *human)
        assert (await http.get(f"/api/runs/{run_id}")).json()["mode"] == "autonomous"
        # harness controls still work: they pass nothing to the agent
        done = await http.post(f"{pano}/finalize", headers=key())
        assert done.status_code == 200 and done.json()["tile"]["status"] == "done"
        await http.post(f"/api/runs/{run_id}/stop")
        await finished(ws, run_id)


async def test_harness_controls_log_what_they_did(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient(**{"": [update(), HOLD]}))
    async with browser(create_console_app(ws)) as http:
        run_id = await start_run(http)
        run, pano = f"/api/runs/{run_id}", f"/api/runs/{run_id}/pano/a"
        await until(lambda: all(ws.tile(run_id, pid)["turns"] >= 1 for pid in ("a", "b")))

        toggled = await http.post(f"{pano}/mcq_allowed", json={"allowed": False})
        await http.post(f"{pano}/mcq_allowed", json={"allowed": False})  # no change: nothing to log
        assert toggled.json()["tile"]["mcq_allowed"] is False
        assert len(log_events(ws, run_id, "a", "mcq_toggle")) == 1
        assert (await http.post(f"{pano}/mcq_allowed", json={"allowed": "no"})).status_code == 422

        finalize_key = key()
        fixed = await http.post(f"{pano}/finalize", headers=finalize_key)
        await http.post(f"{pano}/finalize", headers=finalize_key)
        assert fixed.status_code == 200 and fixed.json()["tile"]["stop_reason"] == "operator_finalize"
        finals = log_events(ws, run_id, "a", "final_submission")
        assert [event["data"]["reason"] for event in finals] == ["operator_finalize"]
        assert validate_export(json.loads((ws.runs_dir / run_id / "a.json").read_text())) == []
        not_retryable = await http.post(f"{pano}/retry")
        assert not_retryable.status_code == 409 and detail(not_retryable)["code"] == "not_retryable"
        assert (await http.post(f"{run}/pano/nope/finalize")).status_code == 404

        stopped = await http.post(f"{run}/stop", headers=key())
        state = stopped.json()["run"]
        assert stopped.status_code == 200 and state["state"] in {"finished", "invalid"} and state["active"] is False
        assert all(log_events(ws, run_id, pid, "operator_stop") for pid in ("a", "b"))
        assert log_events(ws, run_id, "b", "final_submission")[-1]["data"]["reason"] == "operator_stop"
        assert log_events(ws, run_id, "b", "run_end")[-1]["data"]["stop_reason"] == "cancelled"
        late = await http.post(f"{run}/panoramas", json={"set_id": state["set_id"]}, headers=key())
        assert late.status_code == 409  # past stop
        assert (await http.post(f"{run}/finalize_all")).json()["run"]["totals"]["done"] == 2

        acked = await http.post(f"{pano}/ack", json={"kind": "fallback"})
        assert acked.status_code == 200 and acked.json()["tile"]["fallback_acknowledged"] is True
        assert (await http.post(f"{pano}/ack", json={"kind": "everything"})).status_code == 422
        stamped = await http.patch(f"{run}/meta", json={"submitted_at": "2026-10-11T10:55:00Z"})
        assert stamped.json()["run"]["submitted_at"].startswith("2026-10-11T10:55:00")
        assert (await http.patch(f"{run}/meta", json={"team": "x"})).status_code == 422
        truth = await http.put(f"{run}/stage_truth", json={"panorama_id": "a", "lat": 38.7, "lng": -9.1})
        assert truth.status_code == 403  # human channels were on: truth never meets them
        meta = json.loads((ws.runs_dir / run_id / "run.json").read_text())
        assert meta["acks"] == {"a": ["fallback"]} and meta["stage_truth"] == {}
        assert not log_events(ws, run_id, "a", "ack", "meta", "stage_truth")

        rebuilt = await http.post(f"{run}/export", json={"embed_images": False}, headers=key())
        job = rebuilt.json()["job"]
        assert rebuilt.status_code == 200 and job["kind"] == "export" and job["run_id"] == run_id
        await ws.jobs.get(job["id"]).wait()
        assert (await http.get(f"/api/jobs/{job['id']}")).json()["state"] == "done"
        assert (await http.post(f"{run}/export", json={"force": "yes"})).status_code == 422

        mistyped = await http.request("DELETE", run, json={"confirm": "something else"})
        assert mistyped.status_code == 422 and (ws.runs_dir / run_id).is_dir()
        # a custom-preset run is a training run, not the scoring run: it may go
        deleted = await http.request("DELETE", run, json={"confirm": run_id})
        assert deleted.json() == {"ok": True} and not (ws.runs_dir / run_id).exists() and ws.owned(run_id) is None
        assert (await http.get(run)).status_code == 404


async def test_a_run_on_disk_can_be_read_but_not_operated(tmp_path: Path) -> None:
    first = workspace(tmp_path, ScriptClient())
    async with browser(create_console_app(first)) as http:
        run_id = await start_run(http)
        await finished(first, run_id)
    restarted = workspace(tmp_path, ScriptClient())  # another process, as after a restart
    async with browser(create_console_app(restarted)) as http:
        state = (await http.get(f"/api/runs/{run_id}")).json()
        assert (state["owned"], state["state"], state["active"]) == (False, "finished", False)
        assert (await http.get(f"/api/runs/{run_id}/pano/a/events")).json()["events"][0]["type"] == "run_start"
        assert (await http.get(f"/api/runs/{run_id}/pano/a/image")).status_code == 200
        pano = f"/api/runs/{run_id}/pano/a"
        before = len(log_events(restarted, run_id, "a"))
        attempts = [
            await http.post(f"{pano}/cue", json={"text": CUE, "confirmed": True}, headers=key()),
            await http.post(f"{pano}/cue/check", json={"text": CUE}),
            await http.post(
                f"{pano}/geocode",
                json={"lat": 38.7, "lng": -9.1, "place_label": "Baixa", "confirmed": True},
                headers=key(),
            ),
            await http.post(f"{pano}/mcq/a-mcq-1/answer", json={"index": 0}, headers=key()),
            await http.post(f"{pano}/mcq_allowed", json={"allowed": False}),
            await http.post(f"{pano}/finalize"),
            await http.post(f"{pano}/retry"),
            await http.post(f"{pano}/ack", json={"kind": "fallback"}),
            await http.post(f"/api/runs/{run_id}/stop"),
            await http.post(f"/api/runs/{run_id}/finalize_all"),
            await http.post(f"/api/runs/{run_id}/panoramas", json={"set_id": state["set_id"]}),
        ]
        assert [r.status_code for r in attempts] == [409] * len(attempts)
        assert {detail(r)["code"] for r in attempts} == {"run_not_owned"}
        assert len(log_events(restarted, run_id, "a")) == before
        assert (await http.post("/api/runs/never-was/stop")).status_code == 404
        assert (await http.get(f"/legacy/{run_id}/")).status_code == 404  # nothing live to show


# --- the stream ---------------------------------------------------------------------------------


def frame(text: str) -> tuple[str, dict[str, Any]]:
    head, _, data = text.partition("\ndata: ")
    assert head.startswith("event: ") and text.endswith("\n\n")
    return head[len("event: ") :], json.loads(data)


async def test_stream_sends_a_snapshot_then_consecutive_messages_and_pings(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient())
    app = create_console_app(ws)
    async with browser(app) as http:
        set_id = await upload_set(http, {"Urban/a.jpg": pano_bytes(1)})
        stream = app.state.stream(ping_s=0.05)
        try:
            event, snapshot = frame(await asyncio.wait_for(anext(stream), 5))
            assert event == "snapshot" and snapshot["boot_id"] == ws.boot_id and snapshot["runs"] == []
            assert set(snapshot) == {"boot_id", "seq", "server_time", "runs", "jobs", "health"}
            assert (await http.get("/api/snapshot")).json()["seq"] == snapshot["seq"] and ws.hub.subscriber_count == 1
            event, ping = frame(await asyncio.wait_for(anext(stream), 5))
            assert event == "ping" and ping["seq"] == snapshot["seq"] and ping["server_time"]

            body = {"preset": "autonomous", "set_id": set_id, "confirm_no_key": True}
            run_id = (await http.post("/api/runs", json=body, headers=key())).json()["run_id"]
            messages: list[dict[str, Any]] = []
            last_ping = None
            while not any(m["kind"] == "run" and m["run"]["state"] == "finished" for m in messages):
                event, payload = frame(await asyncio.wait_for(anext(stream), 5))
                if event == "ping":
                    last_ping = payload
                    assert payload["seq"] == (messages[-1]["seq"] if messages else snapshot["seq"])
                else:
                    assert event == "msg"
                    messages.append(payload)
            assert [m["seq"] for m in messages] == list(range(snapshot["seq"] + 1, snapshot["seq"] + 1 + len(messages)))
            assert messages[0]["kind"] == "run" and messages[0]["run_id"] == run_id
            panos = [m for m in messages if m["kind"] == "pano" and m["event"]]
            assert [m["event"]["seq"] for m in panos] == list(range(1, len(panos) + 1))
            assert panos[-1]["tile"]["status"] == "done" and {m["kind"] for m in messages} >= {"run", "pano", "index"}
            assert last_ping is None or last_ping["seq"] <= messages[-1]["seq"]
        finally:
            await stream.aclose()
        assert ws.hub.subscriber_count == 0  # the generator unsubscribes on its way out


# --- pages --------------------------------------------------------------------------------------


async def test_legacy_page_is_served_per_run_and_its_lint_writes_nothing(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient(**{"": [update(), HOLD]}))
    async with browser(create_console_app(ws)) as http:
        assert (await http.get("/legacy")).status_code == 404
        run_id = await start_run(http)
        await until(lambda: ws.tile(run_id, "a")["turns"] >= 1)

        latest = await http.get("/legacy")
        assert latest.status_code == 307 and latest.headers["location"] == f"/legacy/{run_id}/"
        assert (await http.get(f"/legacy/{run_id}")).headers["location"] == f"/legacy/{run_id}/"
        page = await http.get(f"/legacy/{run_id}/")
        assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
        assert 'EventSource("api/stream")' in page.text and '"/api/' not in page.text and "unpkg" not in page.text
        assert "/static/vendor/leaflet/leaflet.js" in page.text
        policy = page.headers["content-security-policy"]
        assert "script-src 'self' 'sha256-" in policy and "unsafe-inline' 'sha256" not in policy
        assert page.headers["x-frame-options"] == "DENY"
        for asset in ("leaflet.js", "leaflet.css"):
            assert (await http.get(f"/static/vendor/leaflet/{asset}")).status_code == 200

        state = (await http.get(f"/legacy/{run_id}/api/state")).json()
        assert state["run_id"] == run_id and [p["panorama_id"] for p in state["panoramas"]] == ["a", "b"]
        assert (await http.get(f"/legacy/{run_id}/api/pano/a/events")).json()["events"][0]["type"] == "run_start"
        assert (await http.get(f"/legacy/{run_id}/api/pano/a/image")).headers["content-type"] == "image/jpeg"

        # the legacy app's own lint would log a human_cue_rejected for this text
        before = len(log_events(ws, run_id, "a"))
        lint = await http.post(f"/legacy/{run_id}/api/pano/a/cue/lint", json={"text": PLACE_CUE})
        assert lint.status_code == 200 and lint.json()["ok"] is False and lint.json()["problems"]
        assert set(lint.json()) == {"ok", "problems", "char_count", "max_chars", "multiplier_before", "multiplier_after"}
        assert (await http.post(f"/legacy/{run_id}/api/pano/a/cue/lint", json={"text": CUE})).json()["ok"] is True
        assert len(log_events(ws, run_id, "a")) == before
        foreign = await http.post(
            f"/legacy/{run_id}/api/pano/a/cue", json={"text": CUE, "confirmed": True}, headers={"Origin": "https://evil.example"}
        )
        assert foreign.status_code == 403 and ws.tile(run_id, "a")["penalty"]["cues"] == 0  # the mount is covered too

        # both pages act on the same sessions, and the console's state follows the legacy page
        sent = await http.post(f"/legacy/{run_id}/api/pano/a/cue", json={"text": CUE, "confirmed": True})
        assert sent.status_code == 200 and ws.tile(run_id, "a")["penalty"]["cues"] == 1
        console_too = await http.post(
            f"/api/runs/{run_id}/pano/a/cue", json={"text": CUE, "confirmed": True}, headers=key()
        )
        assert console_too.status_code == 409 and ws.tile(run_id, "a")["penalty"]["cues"] == 1
        done = await http.post(f"/legacy/{run_id}/api/pano/a/finalize")
        assert done.status_code == 200 and done.json()["state"]["status"] == "done"
        await until(lambda: bool(log_events(ws, run_id, "a", "run_end")))  # its conversation was ended too
        everything = await http.post(f"/legacy/{run_id}/api/finalize_all")
        assert everything.status_code == 200 and ws.owned(run_id).idle
        exported = (await http.post(f"/legacy/{run_id}/api/export")).json()["paths"]
        assert any(path.endswith("answers.csv") for path in exported)
        for pid in ("a", "b"):
            assert validate_export(json.loads((ws.runs_dir / run_id / f"{pid}.json").read_text())) == []

        assert (await http.get("/legacy/unknown-run/")).status_code == 404
        assert (await http.get("/legacy/%2e%2e/api/state")).status_code == 404
        handle = ws.owned(run_id)
        handle.meta = {**handle.meta, "kind": "eval"}  # an evaluation run never gets the page with human controls
        assert (await http.get(f"/legacy/{run_id}/")).status_code == 404
        assert (await http.post(f"/legacy/{run_id}/api/pano/a/cue/lint", json={"text": CUE})).status_code == 404


async def test_standalone_legacy_app_serves_the_vendored_assets(tmp_path: Path) -> None:
    manager = SimpleNamespace(sessions={}, settings=Settings(runs_dir=tmp_path / "runs", cache_dir=tmp_path / "cache"))
    transport = httpx.ASGITransport(app=create_app(manager))
    async with httpx.AsyncClient(transport=transport, base_url="http://ui") as http:
        assert (await http.get("/static/vendor/leaflet/leaflet.js")).status_code == 200
        page = await http.get("/")
        assert page.status_code == 200 and "/static/vendor/leaflet/leaflet.css" in page.text


async def test_spa_fallback_serves_the_console_for_every_page_route(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = workspace(tmp_path)
    async with browser(create_console_app(ws)) as http:
        for route in ("/", "/new", "/runs/20261011T100000Z", "/runs/r1/pano_3", "/runs/r1/stage", "/eval", "/settings"):
            page = await http.get(route)
            assert page.status_code == 200 and page.headers["content-type"].startswith("text/html"), route
            assert page.headers["cache-control"] == "no-cache" and "/static/console/js/main.js" in page.text
        script = await http.get("/static/console/js/main.js")
        assert script.status_code == 200 and script.headers["cache-control"] == "no-cache"
        missing = await http.get("/api/nope")
        assert missing.status_code == 404 and detail(missing)["code"] == "not_found"
        assert (await http.get("/static/console/js/nope.js")).status_code == 404
        assert (await http.post("/runs/r1")).status_code == 405  # a page is only ever read

        context = (await http.get("/api/launch/context")).json()
        assert set(context["presets"]) == {"autonomous", "scoring", "live", "eval", "custom"}
        assert context["fake_model"] is False and "google_maps_api_key" not in json.dumps(context)
        offline = (await http.get("/api/prompt")).json()  # this workspace's default: web off
        shown = (await http.get("/api/prompt", params={"allow_web": "true", "disabled_tools": "sun_position"})).json()
        names = [tool.get("name") for tool in shown["tools"]]
        assert shown["system_prompt"] and "sun_position" not in names and "submit_locations" in names
        assert len(names) > len(offline["tools"]) and shown["system_prompt"] != offline["system_prompt"]
        assert (await http.get("/api/prompt", params={"disabled_tools": "submit_locations"})).status_code == 422
        assert (await http.get("/api/prompt", params={"allow_web": "maybe"})).status_code == 422

        monkeypatch.setattr(console_module, "CONSOLE_INDEX", tmp_path / "not-built" / "index.html")
        absent = await http.get("/runs")
        assert absent.status_code == 503 and "console page is missing" in absent.text


# --- the command --------------------------------------------------------------------------------


def test_serve_help_lists_the_console_and_the_old_options() -> None:
    result = CliRunner().invoke(cli.app, ["serve", "--help"])

    assert result.exit_code == 0, result.output
    for option in ("--no-open", "--legacy", "--no-human", "--special", "--label", "--hedge", "--no-web", "--live"):
        assert option in result.output, option
    assert "--run-id" in result.output and "--concurrency" in result.output and "--host" in result.output


def test_serve_refuses_to_bind_the_network_without_lan_access(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = workspace(tmp_path)
    served: list[tuple[Any, ...]] = []
    monkeypatch.setattr("server.workspace.Workspace", lambda **kwargs: ws)
    monkeypatch.setattr(cli, "_serve_console_blocking", lambda *args, **kwargs: served.append((args, kwargs)))

    refused = CliRunner().invoke(cli.app, ["serve", "--host", "0.0.0.0", "--no-open"])
    assert refused.exit_code == 2 and "LAN access" in refused.output and served == []

    local = CliRunner().invoke(cli.app, ["serve", "--port", "8123"])
    assert local.exit_code == 0 and "http://127.0.0.1:8123" in local.output
    (args, kwargs), = served
    assert args[1:] == ("127.0.0.1", 8123, None) and kwargs == {"open_url": "http://127.0.0.1:8123/"}

    token = ws.store.set_lan(True)["token"]
    shared = CliRunner().invoke(cli.app, ["serve", "--no-open"])
    assert shared.exit_code == 0 and served[-1][0][1] == "0.0.0.0" and served[-1][1] == {"open_url": None}
    assert shared.output.count(token) <= 1  # shown once, on the server's own terminal


def test_serve_console_finalises_and_exports_when_the_server_is_interrupted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = ScriptClient(**{"": [update(), HOLD]})
    ws = workspace(tmp_path, client)
    usb = tmp_path / "usb"
    usb.mkdir()
    (usb / "a_Urban.jpg").write_bytes(pano_bytes(1))
    monkeypatch.setattr(cli, "_terminate_like_ctrl_c", lambda: None)

    async def interrupted_server(workspace_: Workspace, host: str, port: int, launch: Any, **kwargs: Any) -> None:
        await workspace_.launch_path(**launch)
        await asyncio.wait_for(client.started.wait(), 5)  # the run is in flight, mid model call
        raise KeyboardInterrupt()

    monkeypatch.setattr(cli, "_serve_console", interrupted_server)
    launch = {"path": usb, "special": None, "label": None, "settings_overrides": {"no_human": None}, "run_id": "r1"}
    with pytest.raises(KeyboardInterrupt):
        cli._serve_console_blocking(ws, "127.0.0.1", 0, launch)

    run_dir = ws.runs_dir / "r1"
    for name in ("a_Urban.json", "answers.csv", "summary.csv", "run.json"):
        assert (run_dir / name).is_file(), name
    doc = json.loads((run_dir / "a_Urban.json").read_text())
    assert len(doc["final"]["locations"]) == 10 and validate_export(doc) == []
    assert json.loads((run_dir / "run.json").read_text())["kind"] == "scoring"  # human channels on, as `serve <dir>` was
