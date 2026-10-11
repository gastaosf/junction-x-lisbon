"""UI-SPEC section 11, at the server: what each acceptance scenario needs from the console's HTTP
API, driven as the page drives it. Scenarios 1, 3, 4, 5, 6, 7 and 9, then the hard constraints
of section 3 that hold across all of them (three inputs to the agent, keys never leave, every
control is logged). Offline: a scripted model client, tmp_path directories, httpx.ASGITransport.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import shutil
import socket
import subprocess
import sys
import uuid
import zipfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import cv2
import httpx
import numpy as np
import openai
import pytest

import cli
from eval import build_set
from astrolabio.config import Budget, Settings
from astrolabio.eventlog import validate_export
from astrolabio.runner import LOCK_NAME
from server import health
from server.console import create_console_app
from server.runstate import read_events
from server.sets import ConsoleError
from server.workspace import RUN_FILE, Workspace, read_meta

BASE = "http://127.0.0.1:8000"
LISBON = (38.7139, -9.1394)
PORTO = (41.1456, -8.6110)
STANDARD = Budget(effort="high", soft_deadline_s=600, hard_deadline_s=840, max_turns=6, max_spend_usd=8.0)
SPECIAL = Budget(effort="xhigh", soft_deadline_s=900, hard_deadline_s=1200, max_turns=7, max_spend_usd=15.0)
CUE = "the kerb stones are painted yellow"
PLACE_CUE = "it is near Lisboa"
CHECKLIST = ["all_final", "ten_entries", "exports_valid", "ledger", "files_fresh", "no_fallback"]
SECRETS = {
    "OPENAI_API_KEY": "sk-acceptance-openai-0123456789",
    "GOOGLE_MAPS_API_KEY": "google-acceptance-0123456789",
    "MAPILLARY_TOKEN": "mapillary-acceptance-0123456789",
}
WAIT_S = 20.0  # for a step that takes milliseconds: generous, so a busy machine does not fail it
# Fields that tick with the clock: two looks at the same state differ in these and in nothing else.
CLOCKS = frozenset({"server_time", "elapsed_s", "remaining_s", "watchdog_remaining_s", "wall_time_s"})


# --- helpers ----------------------------------------------------------------------------------


def pano_bytes(seed: int = 0, size: tuple[int, int] = (256, 128)) -> bytes:
    noise = np.random.default_rng(seed).integers(0, 255, (size[1], size[0], 3), dtype=np.uint8)
    ok, encoded = cv2.imencode(".jpg", noise)
    assert ok
    return encoded.tobytes()


def hyp(point: tuple[float, float], probability: float, label: str) -> dict[str, Any]:
    return {"lat": point[0], "lng": point[1], "probability": probability, "radius_m": 40.0, "label": label, "evidence": "tram"}


HYPS = [hyp(LISBON, 0.8, "Baixa")]


def reply(name: str, **arguments: Any) -> SimpleNamespace:
    block = {"type": "tool_use", "id": f"call_{name}", "name": name, "input": arguments}
    usage = {"input_tokens": 1000, "cached_input_tokens": 0, "cache_write_tokens": 0, "output_tokens": 100}
    return SimpleNamespace(id="resp", model="gpt-6.1-sol", content=[block], stop_reason="tool_use", stop_details=None, usage=usage)


def update(hypotheses: list[dict[str, Any]] | None = None) -> SimpleNamespace:
    return reply("update_candidates", hypotheses=hypotheses or HYPS)


def submit(hypotheses: list[dict[str, Any]] | None = None) -> SimpleNamespace:
    return reply("submit_locations", hypotheses=hypotheses or HYPS, reasoning_summary="ok")


def ask() -> SimpleNamespace:
    return reply(
        "ask_multiple_choice",
        question="Which view matches?",
        options=["Baixa: a lane with tram rails", "A granite quay on a river"],
        why_it_matters="It settles the two candidates.",
    )


def auth_error() -> openai.AuthenticationError:
    request = httpx.Request("POST", "https://api.openai.com/v1/responses")
    return openai.AuthenticationError("bad key", response=httpx.Response(401, request=request), body=None)


class Gate:
    """In a script: a model call that stays in flight until the test opens it, then answers."""

    def __init__(self, then: SimpleNamespace | None = None) -> None:
        self.then = then or submit()
        self.entered = asyncio.Event()
        self.open = asyncio.Event()


class Script:
    """A scripted model. One list per panorama id ("" for every other panorama), walked one call
    at a time, the last item repeating; an item is a reply, an exception to raise, or a Gate.
    Of every request it keeps what the model reads (instructions, tools, conversation), and
    apart from that the cache partition it was sent under."""

    def __init__(self, **scripts: Any) -> None:
        self.scripts = {"": [update(), submit()], **scripts}
        self.calls: dict[str, int] = {}
        self.requests: list[tuple[str, str]] = []
        self.cache_keys: set[str] = set()

    async def create(self, **params: Any) -> Any:
        pid = params["prompt_cache_key"].rsplit("-", 1)[-1]
        readable = {name: params[name] for name in ("instructions", "tools", "messages")}
        self.requests.append((pid, json.dumps(readable, default=str)))
        self.cache_keys.add(params["prompt_cache_key"])
        self.calls[pid] = self.calls.get(pid, 0) + 1
        script = self.scripts[pid if pid in self.scripts else ""]
        item = script[min(self.calls[pid], len(script)) - 1]
        if isinstance(item, Gate):
            item.entered.set()
            await item.open.wait()
            return item.then
        if isinstance(item, BaseException):
            raise item
        await asyncio.sleep(0)
        return item

    def sent(self, pid: str | None = None) -> str:
        return "\n".join(body for owner, body in self.requests if pid is None or owner == pid)


def workspace(tmp_path: Path, client: Any = None, *, runs: Path | None = None, **overrides: Any) -> Workspace:
    base = Settings(
        **{
            "runs_dir": runs or tmp_path / "runs",
            "cache_dir": tmp_path / "cache",
            "allow_web": False,
            "standard": STANDARD,
            "special": SPECIAL,
            "live": STANDARD,
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


def browser(ws: Workspace) -> httpx.AsyncClient:
    """One tab: the console app of `ws` behind an HTTP client."""
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=create_console_app(ws)), base_url=BASE)


def key() -> dict[str, str]:
    return {"Idempotency-Key": uuid.uuid4().hex}


async def until(condition: Any, timeout: float = WAIT_S) -> None:
    async def poll() -> None:
        while not condition():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


async def finished(ws: Workspace, run_id: str) -> None:
    handle = ws.owned(run_id)
    await until(lambda: handle.idle and handle.task is not None)


async def upload_set(http: httpx.AsyncClient, files: dict[str, bytes], name: str = "Sunday") -> str:
    created = await http.post("/api/sets", json={"name": name})
    assert created.status_code == 200, created.text
    set_id = created.json()["set_id"]
    for path, data in files.items():
        stored = await http.put(f"/api/sets/{set_id}/files", params={"path": path}, content=data)
        assert stored.status_code == 200, stored.text
    return set_id


async def start_run(http: httpx.AsyncClient, files: dict[str, bytes] | None = None, **spec: Any) -> str:
    """Upload a set (by default a: Urban, b: non-Urban) and launch it; assisted unless told otherwise."""
    files = files or {"Urban/a.jpg": pano_bytes(1), "non-Urban/b.jpg": pano_bytes(2)}
    body = {"preset": "custom", "set_id": await upload_set(http, files), "confirm_no_key": True, **spec}
    launched = await http.post("/api/runs", json=body, headers=key())
    assert launched.status_code == 201, launched.text
    return launched.json()["run_id"]


def events(ws: Workspace, run_id: str, pid: str, *kinds: str) -> list[dict[str, Any]]:
    logged = read_events(ws.runs_dir / run_id / f"{pid}.events.jsonl")
    return [event for event in logged if not kinds or event["type"] in kinds]


def refusal(response: httpx.Response) -> tuple[int, str | None]:
    detail = response.json()["detail"]
    assert detail["message"], detail  # every refusal says what happened
    return response.status_code, detail["code"]


async def tile_of(http: httpx.AsyncClient, run_id: str, pid: str) -> dict[str, Any]:
    run = (await http.get(f"/api/runs/{run_id}")).json()
    return next(tile for tile in run["panoramas"] if tile["panorama_id"] == pid)


async def checklist(http: httpx.AsyncClient, run_id: str) -> dict[str, Any]:
    response = await http.get(f"/api/runs/{run_id}/validation")
    assert response.status_code == 200, response.text
    body = response.json()
    body["by_id"] = {check["id"]: check for check in body["checks"]}
    return body


async def submission_zip(http: httpx.AsyncClient, run_id: str) -> zipfile.ZipFile:
    response = await http.get(f"/api/runs/{run_id}/download")
    assert response.status_code == 200, response.text
    return zipfile.ZipFile(io.BytesIO(response.content))


def answer_rows(text: str) -> dict[str, list[dict[str, str]]]:
    rows: dict[str, list[dict[str, str]]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        rows.setdefault(row["panorama_id"], []).append(row)
    return rows


def stable(value: Any) -> Any:
    """A state payload without the fields that tick with the clock."""
    if isinstance(value, dict):
        return {name: stable(item) for name, item in value.items() if name not in CLOCKS}
    if isinstance(value, list):
        return [stable(item) for item in value]
    return value


class Tab:
    """A tab's event stream, read frame by frame as the page reads it."""

    def __init__(self, http: httpx.AsyncClient) -> None:
        self.frames = http._transport.app.state.stream(ping_s=60.0)  # type: ignore[attr-defined]
        self.snapshot: dict[str, Any] = {}
        self.messages: dict[int, dict[str, Any]] = {}

    async def open(self) -> dict[str, Any]:
        kind, self.snapshot = await self._frame()
        assert kind == "snapshot"
        return self.snapshot

    async def _frame(self) -> tuple[str, dict[str, Any]]:
        frame = await asyncio.wait_for(anext(self.frames), WAIT_S)
        head, data = frame.strip().split("\n", 1)
        return head.removeprefix("event: "), json.loads(data.removeprefix("data: "))

    async def read_to(self, seq: int) -> None:
        """Take messages until the stream has delivered `seq`; a gap is a failure."""
        last = max(self.messages, default=self.snapshot["seq"])
        while last < seq:
            kind, message = await self._frame()
            if kind != "msg":
                continue
            assert message["seq"] == last + 1, "the stream skipped a message"
            last = message["seq"]
            self.messages[last] = message

    def tile(self, pid: str) -> dict[str, Any] | None:
        """The panorama's tile as this tab has it: from its snapshot, then every `pano` message."""
        tile = next(
            (t for run in self.snapshot["runs"] for t in run["panoramas"] if t["panorama_id"] == pid), None
        )
        for seq in sorted(self.messages):
            message = self.messages[seq]
            if message["kind"] == "pano" and message["panorama_id"] == pid:
                tile = message["tile"]
        return tile

    async def close(self) -> None:
        await self.frames.aclose()


def dead_pid() -> int:
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    return process.pid


# --- 1: six panoramas and a manifest, the Special One, a scoring run ----------------------------


async def test_1_scoring_run_from_six_dropped_panoramas_and_a_manifest(tmp_path: Path) -> None:
    ws = workspace(tmp_path, Script())
    labels = {"p1": "Urban", "p2": "non-Urban", "p3": "Urban", "p4": "Urban", "p5": "non-Urban", "p6": "Urban"}
    manifest = "filename,label,timestamp\n" + "".join(
        f"{pid}.jpg,{label},2026101109{index:02d}00\n" for index, (pid, label) in enumerate(labels.items())
    )
    files = {f"{pid}.jpg": pano_bytes(index) for index, pid in enumerate(labels)}
    async with browser(ws) as http:
        set_id = await upload_set(http, {**files, "labels.csv": manifest.encode(), ".DS_Store": b"x"})

        # the preflight table: what the files said, and where each value came from
        table = (await http.post(f"/api/sets/{set_id}/preflight", json={"preset": "scoring"})).json()
        rows = {row["panorama_id"]: row for row in table["rows"]}
        assert {pid: row["label"] for pid, row in rows.items()} == labels
        assert all(row["sources"] == {"label": "manifest", "timestamp": "manifest", "special": "none"} for row in rows.values())
        assert rows["p3"]["timestamp"] == "20261011090200" and rows["p3"]["budget"]["max_turns"] == STANDARD.max_turns
        assert all(row["sha256"] and row["width"] == 256 for row in rows.values()) and ".DS_Store" in table["ignored"]
        assert table["summary"].startswith("6 panoramas: 4 Urban, 2 non-Urban")
        # a scoring run without its Special One is blocked, by the table and by the launch alike
        assert table["ready"] is False and [item["code"] for item in table["blocking"]] == ["special_missing"]
        spec = {"preset": "scoring", "set_id": set_id, "confirm_no_key": True}
        blocked = await http.post("/api/runs", json=spec, headers=key())
        assert refusal(blocked) == (422, "preflight_blocked") and ws.handles == {}
        assert [item["code"] for item in blocked.json()["detail"]["problems"]] == ["special_missing"]
        # a task value is a fixed choice, never text
        typed = await http.post("/api/runs", json={**spec, "overrides": {"p1": {"timestamp": "noon, by the cathedral"}}}, headers=key())
        assert refusal(typed) == (422, "invalid_override") and ws.handles == {}

        picked = (await http.post(f"/api/sets/{set_id}/preflight", json={"preset": "scoring", "special": "p3"})).json()
        chosen = {row["panorama_id"]: row for row in picked["rows"]}["p3"]
        assert picked["ready"] is True and "p3" in picked["summary"]
        assert chosen["special"] is True and chosen["sources"]["special"] == "operator"
        assert chosen["budget"]["max_turns"] == SPECIAL.max_turns  # the Special One's own budget
        assert picked["cost_ceiling_usd"] == 5 * STANDARD.max_spend_usd + SPECIAL.max_spend_usd

        launched = await http.post(
            "/api/runs", json={**spec, "special": "p3", "preflight_token": picked["preflight_token"]}, headers=key()
        )
        assert launched.status_code == 201, launched.text
        run_id = launched.json()["run_id"]
        assert launched.json()["url"] == f"/runs/{run_id}"  # the dashboard

        # the dashboard's state: all six, the Special One first, then Urban, then non-Urban
        run = (await http.get(f"/api/runs/{run_id}")).json()
        assert (run["kind"], run["preset"], run["mode"], run["owned"], run["special_present"]) == (
            "scoring",
            "scoring",
            "assisted",
            True,
            True,
        )
        assert [phase["key"] for phase in run["phases"]] == ["launch", "autonomous", "special", "others", "freeze", "submit"]
        order = [(tile["panorama_id"], tile["label"], tile["special"]) for tile in run["panoramas"]]
        assert order[0] == ("p3", "Urban", True)
        assert [label for _, label, _ in order[1:]] == ["Urban"] * 3 + ["non-Urban"] * 2
        assert run["totals"]["total"] == 6 and run["totals"]["spend_cap_usd"] == picked["cost_ceiling_usd"]
        snapshot = (await http.get("/api/snapshot")).json()
        assert [owned["run_id"] for owned in snapshot["runs"]] == [run_id]

        await finished(ws, run_id)
        listed = (await http.get("/api/runs")).json()["runs"]
        assert [(row["run_id"], row["state"], row["totals"]["done"]) for row in listed] == [(run_id, "finished", 6)]
        # nothing about a task was typed: the log records where each value came from
        start = events(ws, run_id, "p3", "run_start")[0]["data"]
        proof = start["provenance"]
        assert proof["special"] == {"value": True, "source": "operator", "parsed": False}
        assert proof["label"] == {"value": "Urban", "source": "manifest", "parsed": "Urban"}
        assert (proof["filename"], proof["set_id"], proof["sha256"]) == ("p3.jpg", set_id, chosen["sha256"])
        assert start["special"] is True and start["capture_timestamp"] == "20261011090200"


# --- 3: a cue ----------------------------------------------------------------------------------


async def test_3_cue_is_linted_charged_once_and_shown_delivered(tmp_path: Path) -> None:
    gate = Gate(then=update())
    client = Script(a=[update(), gate, submit()])
    ws = workspace(tmp_path, client)
    async with browser(ws) as http:
        run_id = await start_run(http)
        pano = f"/api/runs/{run_id}/pano/a"
        await asyncio.wait_for(gate.entered.wait(), WAIT_S)

        # "Check" is the server's lint and leaves nothing behind
        before = len(events(ws, run_id, "a"))
        verdict = (await http.post(f"{pano}/cue/check", json={"text": PLACE_CUE})).json()
        assert (verdict["ok"], verdict["reason"]) == (False, "lint")
        assert [match["word"].lower() for match in verdict["matches"]] == ["lisboa"]
        assert (verdict["multiplier_before"], verdict["multiplier_after"]) == (1.0, 0.8)
        assert len(events(ws, run_id, "a")) == before

        # the lint blocks a place name: nothing is charged and nothing is queued
        blocked = await http.post(f"{pano}/cue", json={"text": PLACE_CUE, "confirmed": True}, headers=key())
        assert refusal(blocked) == (422, "cue_lint") and blocked.json()["detail"]["matches"] == verdict["matches"]
        tile = await tile_of(http, run_id, "a")
        assert tile["penalty"]["cues"] == 0 and tile["cues"] == [] and events(ws, run_id, "a", "human_cue") == []

        # a double click: two identical requests in flight at once
        cue_key = key()
        body = {"text": CUE, "confirmed": True}
        first, second = await asyncio.gather(
            http.post(f"{pano}/cue", json=body, headers=cue_key), http.post(f"{pano}/cue", json=body, headers=cue_key)
        )
        assert first.status_code == second.status_code == 200 and first.json() == second.json()
        assert sorted(r.headers.get("idempotency-replayed", "") for r in (first, second)) == ["", "true"]
        sent = first.json()
        assert (sent["result"]["multiplier_before"], sent["result"]["multiplier_after"]) == (1.0, 0.8)
        assert sent["tile"]["penalty"] == {"cues": 1, "mcqs": 0, "human_geocodes": 0, "multiplier": 0.8}
        assert sent["tile"]["ledger_text"] == "x0.8 = 0.8 cue" and len(events(ws, run_id, "a", "human_cue")) == 1
        assert [cue["state"] for cue in sent["tile"]["cues"]] == ["queued"]  # waiting for the agent's next turn
        assert CUE not in client.sent()

        gate.open.set()
        await finished(ws, run_id)
        tile = await tile_of(http, run_id, "a")
        cue = tile["cues"][0]
        delivered = events(ws, run_id, "a", "human_cue_delivered")
        assert (cue["state"], cue["delivered_seq"], cue["delivered_turn"]) == ("delivered", delivered[0]["seq"], 3)
        assert cue["delivered_t_rel_s"] is not None and client.sent("a").count(CUE) >= 1 and CUE not in client.sent("b")
        # charged exactly once, on the whole list
        assert tile["penalty"]["multiplier"] == 0.8 and {entry["multiplier"] for entry in tile["final"]} == {0.8}
        assert (await checklist(http, run_id))["by_id"]["ledger"]["status"] == "pass"


# --- 4: the last-resort geocode ------------------------------------------------------------------


async def test_4_geocode_ends_the_tile_and_the_files_follow(tmp_path: Path) -> None:
    gate = Gate()
    ws = workspace(tmp_path, Script(b=[update(), gate]))
    async with browser(ws) as http:
        run_id = await start_run(http)
        pano = f"/api/runs/{run_id}/pano/b"
        await asyncio.wait_for(gate.entered.wait(), WAIT_S)
        tile = await tile_of(http, run_id, "b")
        assert tile["named_places"] == ["Baixa"] and tile["geocode_enabled"] is True and tile["status"] == "running"
        assert tile["multiplier_after"]["geocode"] == 0.5

        # only a place the agent named, and only once confirmed
        pin = {"lat": 38.7101, "lng": -9.1402, "confirmed": True}
        typed = await http.post(f"{pano}/geocode", json={**pin, "place_label": "Atlantis"}, headers=key())
        assert refusal(typed) == (409, "place_not_named")
        unconfirmed = await http.post(f"{pano}/geocode", json={**pin, "confirmed": False, "place_label": "Baixa"}, headers=key())
        assert unconfirmed.status_code == 400 and (await tile_of(http, run_id, "b"))["penalty"]["human_geocodes"] == 0

        pinned = await http.post(f"{pano}/geocode", json={**pin, "place_label": "Baixa"}, headers=key())
        assert pinned.status_code == 200, pinned.text
        tile = pinned.json()["tile"]
        # the tile ends at once, on the human point, at x0.5
        assert (tile["status"], tile["active"], tile["origin"], tile["stop_reason"]) == ("done", False, "human_geocode", "human_geocode")
        assert tile["penalty"] == {"cues": 0, "mcqs": 0, "human_geocodes": 1, "multiplier": 0.5}
        assert [(e["lat"], e["lng"], e["multiplier"], e["origin"]) for e in tile["final"]] == [(38.7101, -9.1402, 0.5, "human_geocode")] * 10
        assert not gate.open.is_set() and events(ws, run_id, "b", "run_end")  # the conversation was halted, not awaited

        # ... and the files on disk already say the same
        run_dir = ws.runs_dir / run_id
        doc = json.loads((run_dir / "b.json").read_text())
        assert validate_export(doc) == [] and doc["final"]["penalty_state"]["multiplier"] == 0.5
        assert {(e["lat"], e["lng"]) for e in doc["final"]["locations"]} == {(38.7101, -9.1402)}
        answers = answer_rows((run_dir / "answers.csv").read_text())["b"]
        assert len(answers) == 10 and {(row["lat"], row["lng"]) for row in answers} == {("38.710100", "-9.140200")}
        summary = {row["panorama"]: row for row in csv.DictReader(io.StringIO((run_dir / "summary.csv").read_text()))}
        assert (summary["b"]["origin"], float(summary["b"]["multiplier"]), summary["b"]["problems"]) == ("human_geocode", 0.5, "")

        # a second pin, from another tab with its own key, charges nothing
        again = await http.post(f"{pano}/geocode", json={**pin, "lat": 40.0, "place_label": "Baixa"}, headers=key())
        assert refusal(again) == (409, "geocode_refused")
        assert (await tile_of(http, run_id, "b"))["penalty"]["multiplier"] == 0.5 and len(events(ws, run_id, "b", "human_geocode")) == 1

        await finished(ws, run_id)
        verdict = await checklist(http, run_id)
        assert verdict["ok"] is True and verdict["by_id"]["files_fresh"]["status"] == "pass"


# --- 5: a reload and a second tab ----------------------------------------------------------------


async def test_5_two_tabs_agree_and_no_penalty_is_charged_twice(tmp_path: Path) -> None:
    gate = Gate()
    ws = workspace(tmp_path, Script(a=[update(), ask(), gate]))
    async with browser(ws) as http:
        run_id = await start_run(http)
        pano = f"/api/runs/{run_id}/pano/a"
        await until(lambda: ws.tile(run_id, "a")["pending_mcq"] is not None)
        await finished_but(ws, run_id, "a")

        # two tabs open on the run: the same state, whichever asks
        one, two = Tab(http), Tab(http)
        first, second = await one.open(), await two.open()
        polled = (await http.get("/api/snapshot")).json()
        assert stable(first) == stable(second) == stable(polled) and first["boot_id"] == ws.boot_id
        tile = one.tile("a")
        assert (tile["status"], tile["penalty"]["mcqs"]) == ("awaiting_mcq", 1)  # charged when asked
        mcq = f"{pano}/mcq/{tile['pending_mcq']['id']}/answer"

        # both tabs show the question; one answers, the other's click arrives late
        mcq_key = key()
        answered = await http.post(mcq, json={"index": 0}, headers=mcq_key)
        other_tab = await http.post(mcq, json={"index": 1}, headers=key())
        retried = await http.post(mcq, json={"index": 0}, headers=mcq_key)  # the first tab's retry after a timeout
        assert answered.status_code == 200 and refusal(other_tab) == (409, "mcq_closed")
        assert retried.status_code == 200 and retried.headers["idempotency-replayed"] == "true"
        await asyncio.wait_for(gate.entered.wait(), WAIT_S)
        assert [e["data"]["selected_index"] for e in events(ws, run_id, "a", "mcq_answered")] == [0]

        # the same for a cue confirmed in both tabs
        cue_key = key()
        body = {"text": CUE, "confirmed": True}
        assert (await http.post(f"{pano}/cue", json=body, headers=cue_key)).status_code == 200
        assert refusal(await http.post(f"{pano}/cue", json=body, headers=key())) == (409, "cue_duplicate")
        assert (await http.post(f"{pano}/cue", json=body, headers=cue_key)).headers["idempotency-replayed"] == "true"
        # a key is bound to its request: it cannot replay another action's answer
        assert refusal(await http.post(f"{pano}/cue", json={**body, "text": "look up"}, headers=cue_key)) == (422, "idempotency_key_reuse")

        # both streams carried every change, in the same order, with no gap
        now = (await http.get("/api/snapshot")).json()
        await one.read_to(now["seq"])
        await two.read_to(now["seq"])
        assert one.messages == two.messages and len(one.messages) == now["seq"] - first["seq"]
        expected = {"cues": 1, "mcqs": 1, "human_geocodes": 0, "multiplier": 0.76}
        assert one.tile("a")["penalty"] == two.tile("a")["penalty"] == expected
        assert len(events(ws, run_id, "a", "mcq_asked")) == 1 and len(events(ws, run_id, "a", "human_cue")) == 1

        # a reload: the new tab's snapshot is the state the old tabs arrived at
        reloaded = Tab(http)
        await reloaded.open()
        assert stable(reloaded.tile("a")) == stable(one.tile("a")) and reloaded.snapshot["seq"] == now["seq"]
        assert reloaded.tile("a")["last_mcq"]["outcome"] == "answered" and reloaded.tile("a")["last_mcq"]["selected_index"] == 0
        for tab in (one, two, reloaded):
            await tab.close()
        assert ws.hub.subscriber_count == 0

        gate.open.set()
        await finished(ws, run_id)
        final = await tile_of(http, run_id, "a")
        assert final["penalty"] == expected and final["ledger_text"] == "x0.76 = 0.95 MCQ x 0.8 cue"


async def finished_but(ws: Workspace, run_id: str, waiting: str) -> None:
    """Every other panorama of the run has ended, so nothing but `waiting` can still change it."""
    sessions = ws.owned(run_id).manager.sessions
    others = [pid for pid in sessions if pid != waiting]
    await until(lambda: all(events(ws, run_id, pid, "run_end") for pid in others))
    await asyncio.sleep(0.05)


# --- 6: kill -9, restart, rebuild ----------------------------------------------------------------


async def test_6_killed_server_run_is_interrupted_rebuilt_and_downloaded(tmp_path: Path) -> None:
    held, unstarted = Gate(), Gate()
    first = workspace(tmp_path, Script(a=[update(), ask(), held], b=[unstarted]))
    async with browser(first) as http:
        run_id = await start_run(http, run_id="sunday")
        await until(lambda: first.tile(run_id, "a")["pending_mcq"] is not None)
        await asyncio.wait_for(unstarted.entered.wait(), WAIT_S)

        # kill -9: the directory exactly as it is now (every event is flushed as it is written),
        # with the line being written cut short and the lock of a process that no longer exists
        after = tmp_path / "after" / "runs"
        shutil.copytree(first.runs_dir, after)
        run_dir = after / run_id
        with (run_dir / "a.events.jsonl").open("a") as log:
            log.write('{"schema_version": "1.0", "seq": 999, "ty')
        lock = json.loads((run_dir / LOCK_NAME).read_text())
        (run_dir / LOCK_NAME).write_text(json.dumps({**lock, "pid": dead_pid(), "proc_start": None}))
        assert not (run_dir / "a.json").exists() and not (run_dir / "answers.csv").exists()
        await first.stop_run(run_id)  # (the test's own process tidies up; `after` no longer sees it)

    restarted = workspace(tmp_path, Script(), runs=after)
    async with browser(restarted) as http:
        # the restarted server holds no run, and finds this one interrupted
        assert (await http.get("/api/snapshot")).json()["runs"] == []
        rows = (await http.get("/api/runs")).json()["runs"]
        assert [(row["run_id"], row["state"], row["owned"], row["active"]) for row in rows] == [(run_id, "interrupted", False, False)]
        run = (await http.get(f"/api/runs/{run_id}")).json()
        tiles = {tile["panorama_id"]: tile for tile in run["panoramas"]}
        assert {pid: tile["status"] for pid, tile in tiles.items()} == {"a": "interrupted", "b": "interrupted"}
        # a dead panorama is not shown as waiting for an answer, and takes no action
        assert tiles["a"]["pending_mcq"] is None and tiles["a"]["penalty"]["mcqs"] == 1 and "Rebuild exports" in tiles["a"]["stop_text"]
        cue = await http.post(f"/api/runs/{run_id}/pano/a/cue", json={"text": CUE, "confirmed": True}, headers=key())
        assert refusal(cue) == (409, "run_not_owned")
        assert refusal(await http.post(f"/api/runs/{run_id}/stop", headers=key())) == (409, "run_not_owned")
        before = await checklist(http, run_id)
        assert (before["ok"], before["interrupted"], before["by_id"]["all_final"]["action"]) == (False, True, "rebuild")
        assert refusal(await http.get(f"/api/runs/{run_id}/download")) == (409, "validation_failed")

        # nor can its id be taken over while that would leave one of its panoramas unfinished for good
        only_a = await upload_set(http, {"Urban/a.jpg": pano_bytes(1)})
        spec = {"preset": "custom", "set_id": only_a, "run_id": run_id, "confirm_no_key": True}
        assert refusal(await http.post("/api/runs", json=spec, headers=key())) == (409, "run_interrupted")

        # Rebuild exports: the logs are finished from what they hold, then the files are written
        started = await http.post(f"/api/runs/{run_id}/export", json={}, headers=key())
        assert started.status_code == 200, started.text
        job = started.json()["job"]
        assert (job["kind"], job["run_id"]) == ("export", run_id)
        await until(lambda: restarted.jobs.get(job["id"]).state in {"done", "failed"})
        job = (await http.get(f"/api/jobs/{job['id']}")).json()
        assert (job["state"], job["error"], job["result"]["recovered"], job["result"]["problems"]) == ("done", None, ["a", "b"], {})

        run = (await http.get(f"/api/runs/{run_id}")).json()
        tiles = {tile["panorama_id"]: tile for tile in run["panoramas"]}
        assert run["state"] == "finished" and not (run_dir / LOCK_NAME).exists()
        assert (tiles["a"]["status"], tiles["a"]["origin"], tiles["a"]["stop_reason"]) == ("done", "agent", "recovered_from_provisional")
        assert (tiles["b"]["origin"], tiles["b"]["stop_reason"]) == ("harness_fallback", "recovered_no_hypotheses")
        assert tiles["a"]["penalty"] == {"cues": 0, "mcqs": 1, "human_geocodes": 0, "multiplier": 0.95}  # still charged

        # the checklist passes (the fallback answer is a warning the operator may accept)
        verdict = await checklist(http, run_id)
        assert verdict["ok"] is True and verdict["interrupted"] is False
        statuses = {check["id"]: check["status"] for check in verdict["checks"]}
        assert statuses == {**dict.fromkeys(CHECKLIST, "pass"), "no_fallback": "warn"}
        assert [item["panorama_id"] for item in verdict["by_id"]["no_fallback"]["items"]] == ["b"]

        # and the zip is a valid submission
        with await submission_zip(http, run_id) as archive:
            assert archive.namelist() == ["a.json", "b.json", "answers.csv", "summary.csv"]
            for name in ("a.json", "b.json"):
                assert validate_export(json.loads(archive.read(name))) == []
                assert archive.read(name) == (run_dir / name).read_bytes()
            answers = answer_rows(archive.read("answers.csv").decode())
            assert {pid: len(rows) for pid, rows in answers.items()} == {"a": 10, "b": 10}
            answer = json.loads(archive.read("a.json"))["final"]
            top = answer["locations"][0]
            assert answer["penalty_state"]["multiplier"] == 0.95 and (top["lat"], top["lng"]) == LISBON


# --- 7: the submission checklist and answers.csv ------------------------------------------------


async def test_7_checklist_passes_and_answers_csv_has_ten_rows_per_panorama(tmp_path: Path) -> None:
    gate = Gate()
    ws = workspace(tmp_path, Script(b=[update(), gate]))
    async with browser(ws) as http:
        run_id = await start_run(http, settings={"no_human": True})
        await asyncio.wait_for(gate.entered.wait(), WAIT_S)
        await finished_but(ws, run_id, "b")

        # a panorama is still working: the checklist says so and offers "Finalize all"
        early = await checklist(http, run_id)
        assert early["ok"] is False and early["by_id"]["all_final"]["status"] == "fail"
        assert early["by_id"]["all_final"]["action"] == "finalize_all"
        assert [item["panorama_id"] for item in early["by_id"]["all_final"]["items"]] == ["b"]
        assert refusal(await http.get(f"/api/runs/{run_id}/download")) == (409, "validation_failed")

        frozen = await http.post(f"/api/runs/{run_id}/finalize_all", headers=key())
        assert frozen.status_code == 200 and frozen.json()["run"]["state"] == "finished"
        tile = await tile_of(http, run_id, "b")
        assert (tile["status"], tile["origin"], tile["stop_reason"]) == ("done", "agent", "operator_finalize_all")
        assert tile["stop_text"] == "finalised by the operator (finalize all): best-so-far list used"

        verdict = await checklist(http, run_id)
        assert verdict["ok"] is True and [check["id"] for check in verdict["checks"]] == CHECKLIST
        assert all(check["status"] == "pass" and check["action"] is None for check in verdict["checks"])
        assert [file["name"] for file in verdict["files"]] == ["a.json", "b.json", "answers.csv", "summary.csv"]
        assert len(verdict["answers"]) == 20 and [row["panorama"] for row in verdict["summary"]] == ["a", "b"]

        # answers.csv: ten rows per panorama, ranks 1 to 10, coordinates in range
        table = await http.get(f"/api/runs/{run_id}/files/answers.csv")
        assert table.status_code == 200 and table.headers["content-type"].startswith("text/csv")
        answers = answer_rows(table.text)
        assert sorted(answers) == ["a", "b"]
        for rows in answers.values():
            assert [int(row["rank"]) for row in rows] == list(range(1, 11))
            assert all(abs(float(row["lat"])) <= 90 and abs(float(row["lng"])) <= 180 for row in rows)

        run_dir = ws.runs_dir / run_id
        with await submission_zip(http, run_id) as archive:
            assert archive.namelist() == ["a.json", "b.json", "answers.csv", "summary.csv"]
            assert all(archive.read(name) == (run_dir / name).read_bytes() for name in archive.namelist())
        # the run's own files are not part of a submission, whatever is asked for
        for name in (RUN_FILE, "a.events.jsonl", "..%2Frun.json"):
            assert (await http.get(f"/api/runs/{run_id}/files/{name}")).status_code == 404

        stamped = await http.patch(f"/api/runs/{run_id}/meta", json={"submitted_at": "2026-10-11T10:58:00Z"})
        assert stamped.status_code == 200 and (await checklist(http, run_id))["submitted_at"] == "2026-10-11T10:58:00.000Z"
        assert events(ws, run_id, "a", "run_end") and read_meta(run_dir)["submitted_at"]  # a note, not an event
        assert not gate.open.is_set()


# --- 9: evaluation: run, results, rescore with hedge, compare -----------------------------------


def eval_entry(pid: str, label: str, point: tuple[float, float], confirmed: bool) -> dict[str, Any]:
    return {
        "panorama_id": pid,
        "filename": f"{pid}.jpg",
        "lat": point[0],
        "lng": point[1],
        "label": label,
        "label_confirmed": confirmed,
        "timestamp": "20180511142427",
        "source_image_id": f"img-{pid}",
        "sequence": f"seq-{pid}",
        "area": "Lisboa Baixa",
        "country": "PT",
        "kind": "city",
        "creator": "alice",
    }


async def test_9_eval_run_results_rescore_with_hedge_and_compare(tmp_path: Path) -> None:
    # the agent's top pick is Porto with Lisbon a close second: right for one panorama, wrong for the other
    belief = [hyp(PORTO, 0.5, "Ribeira"), hyp(LISBON, 0.45, "Baixa")]
    client = Script(**{"": [update(belief), submit(belief)]})
    ws = workspace(tmp_path, client)
    ws.eval_data_dir.mkdir(parents=True)
    entries = [eval_entry("eval_0", "Urban", LISBON, False), eval_entry("eval_1", "TODO", PORTO, False)]
    for index, item in enumerate(entries):
        (ws.eval_data_dir / item["filename"]).write_bytes(pano_bytes(index))
    build_set.save_manifest(ws.eval_data_dir / "manifest.json", entries)

    async with browser(ws) as http:
        # the set, and its labels confirmed by eye: a run refuses to start while one is TODO
        state = (await http.get("/api/eval/set")).json()
        assert (state["count"], state["todo"], state["unconfirmed"], state["leaking"]) == (2, 1, 1, [])
        estimate = (await http.post("/api/eval/runs/estimate", json={"hedge": False})).json()
        assert estimate["todo_labels"] == 1 and estimate["blocking"]
        assert refusal(await http.post("/api/eval/runs", json={"hedge": False}, headers=key())) == (409, "todo_labels")
        assert refusal(await http.patch("/api/eval/set/eval_1", json={"label": "somewhere rural"})) == (422, "invalid_label")
        labelled = (await http.patch("/api/eval/set/eval_1", json={"label": "non-Urban"})).json()
        assert labelled["entry"]["label"] == "non-Urban" and labelled["counts"]["todo"] == 0
        assert (await http.patch("/api/eval/set/eval_0", json={"label": "Urban"})).json()["counts"]["confirmed"] == 2

        # the run: it says what it may cost before it starts, and is always autonomous
        estimate = (await http.post("/api/eval/runs/estimate", json={"hedge": False})).json()
        assert estimate == {"panoramas": 2, "cost_ceiling_usd": 16.0, "todo_labels": 0, "unconfirmed_labels": 0, "blocking": []}
        launched = await http.post("/api/eval/runs", json={"hedge": False, "web": False, "run_id": "baseline"}, headers=key())
        assert launched.status_code == 201 and launched.json() == {"run_id": "baseline", "url": "/runs/baseline", "cost_ceiling_usd": 16.0}
        guarded = ws.owned("baseline").manager.sessions["eval_0"]
        assert guarded.excluded_image_ids and guarded.excluded_point  # the agent cannot fetch its own source image
        cue = await http.post("/api/runs/baseline/pano/eval_0/cue", json={"text": CUE, "confirmed": True}, headers=key())
        assert refusal(cue) == (403, "human_channels_off")
        await finished(ws, "baseline")
        run = (await http.get("/api/runs/baseline")).json()
        assert (run["kind"], run["mode"], run["state"], run["results"]["variants"]) == ("eval", "autonomous", "finished", [])

        # the results: one right (rank 1 on the spot), one about 270 km off
        results = (await http.get("/api/runs/baseline/results")).json()
        scores = {row["panorama_id"]: row for row in results["results"]["panoramas"]}
        assert results["results"]["summary"]["all"]["n"] == 2 and results["config"]["hedge"] is False
        assert scores["eval_1"]["rank1_distance_m"] < 1 and scores["eval_0"]["rank1_distance_m"] > 200_000
        assert scores["eval_1"]["score"] > 16_000 and scores["eval_0"]["score"] < 100
        assert run["results"]["score_share"] == results["results"]["summary"]["all"]["score_share_of_max"]

        # rescore with hedge on: offline, saved beside the original
        calls = len(client.requests)
        hedged = await http.post("/api/runs/baseline/rescore", json={"hedge": True, "duplicates": True, "tag": "hedge"}, headers=key())
        assert hedged.status_code == 200 and hedged.json()["tag"] == "hedge" and len(client.requests) == calls
        assert (ws.runs_dir / "baseline" / "results.hedge.json").is_file()
        listed = (await http.get("/api/runs/baseline/results", params={"tag": "hedge"})).json()
        assert [variant["tag"] for variant in listed["variants"]] == ["hedge"] and listed["results"]["config"]["hedge"] is True
        assert (await http.get("/api/runs/baseline")).json()["results"]["variants"] == ["hedge"]

        # compare the two: the hedge rescues the wrong one and costs the right one a little
        compared = (await http.get("/api/eval/compare", params={"a": "baseline", "b": "baseline:hedge"})).json()
        assert (compared["a"]["tag"], compared["b"]["tag"]) == ("", "hedge")
        table = {row["panorama_id"]: row for row in compared["panoramas"]}
        assert table["eval_0"]["delta"] > 0 and table["eval_1"]["delta"] < 0
        assert abs(compared["panoramas"][0]["delta"]) >= abs(compared["panoramas"][1]["delta"])  # largest change first
        paired = compared["comparison"]["paired"]
        assert (paired["n"], paired["b_better"], paired["a_better"], paired["ties"]) == (2, 1, 1, 0)
        assert paired["mean_score_delta"] > 0 and compared["comparison"]["groups"]["all"]["mean_score"]["delta"] > 0

        # ground truth leaves through the eval endpoints, and only for a run like this one
        truth = (await http.get("/api/eval/runs/baseline/truth", params={"tag": "hedge"})).json()["panoramas"]
        assert (truth["eval_0"]["lat"], truth["eval_0"]["lng"]) == LISBON and truth["eval_1"]["band"] == "100m"
        assisted = await start_run(http)
        await finished(ws, assisted)
        for path in (f"/api/runs/{assisted}/results", f"/api/eval/runs/{assisted}/truth"):
            assert refusal(await http.get(path)) == (403, "truth_not_allowed")
        assert refusal(await http.get("/api/eval/compare", params={"a": "baseline", "b": assisted})) == (403, "truth_not_allowed")
        assert refusal(await http.post(f"/api/runs/{assisted}/rescore", json={"hedge": True}, headers=key())) == (403, "truth_not_allowed")
        plain = (await http.get(f"/api/runs/{assisted}")).json()
        assert plain["results"] is None and plain["stage_truth"] is None
        reveal = await http.put(f"/api/runs/{assisted}/stage_truth", json={"panorama_id": "a", "lat": 38.7, "lng": -9.1})
        assert refusal(reveal) == (403, "human_channels_on")
        # nothing truth-derived rides on a tile or an inspector, not even for the evaluation run
        inspected = (await http.get("/api/runs/baseline/pano/eval_0/inspect")).text
        tiles = json.dumps((await http.get("/api/runs/baseline")).json()["panoramas"])
        assert "rank1_distance" not in inspected + tiles and "distance_m" not in tiles


# --- UI-SPEC 3: the hard constraints ------------------------------------------------------------


async def test_only_the_three_channels_reach_the_agent(tmp_path: Path) -> None:
    """Every field of the console that takes text, filled with a marker; then every request the
    model received is searched for it. Only the cue that was sent may be found."""
    gate = Gate(then=update())
    client = Script(a=[update(), ask(), gate, submit()])
    ws = workspace(tmp_path, client)
    async with browser(ws) as http:
        saved = await http.put(
            "/api/settings",
            json={
                "defaults": {"team": "MARKER team"},
                "organiser_answers": [{"id": "Q5", "note": "MARKER the organisers said the church is in Alfama"}],
            },
        )
        assert saved.status_code == 200, saved.text
        files = {"Urban/a.jpg": pano_bytes(1), "non-Urban/b.jpg": pano_bytes(2)}
        body = {"preset": "custom", "set_id": await upload_set(http, files, name="MARKER set"), "run_id": "MARKER-run"}
        for field, value in (("notes", "MARKER"), ("hint", "MARKER"), ("message", "MARKER")):
            assert refusal(await http.post("/api/runs", json={**body, field: value}, headers=key())) == (422, "unknown_field")
        typed = {**body, "settings": {"system_prompt": "MARKER"}}
        assert refusal(await http.post("/api/runs", json=typed, headers=key())) == (422, "unknown_setting")
        launched = await http.post("/api/runs", json={**body, "confirm_no_key": True}, headers=key())
        assert launched.status_code == 201, launched.text
        run_id = launched.json()["run_id"]
        pano = f"/api/runs/{run_id}/pano/a"
        await until(lambda: ws.tile(run_id, "a")["pending_mcq"] is not None)

        # harness controls and notes take no text; what they are sent beyond their fields goes nowhere
        mcq = f"{pano}/mcq/{ws.tile(run_id, 'a')['pending_mcq']['id']}/answer"
        assert (await http.post(mcq, json={"index": 1, "text": "MARKER it is the quay"}, headers=key())).status_code == 200
        await asyncio.wait_for(gate.entered.wait(), WAIT_S)
        await http.post(f"{pano}/cue/check", json={"text": "MARKER checked and never sent"})
        await http.post(f"{pano}/mcq_allowed", json={"allowed": False, "reason": "MARKER"}, headers=key())
        await http.post(f"{pano}/ack", json={"kind": "fallback", "note": "MARKER"}, headers=key())
        await http.patch(f"/api/runs/{run_id}/meta", json={"submitted_at": "2026-10-11T10:58:00Z"})
        assert refusal(await http.patch(f"/api/runs/{run_id}/meta", json={"note": "MARKER"})) == (422, "unknown_field")
        sent = await http.post(f"{pano}/cue", json={"text": CUE, "confirmed": True}, headers=key())
        assert sent.status_code == 200
        gate.open.set()
        await finished(ws, run_id)
        retry = await http.post(f"{pano}/retry", json={"with": "MARKER try the riverside"}, headers=key())
        assert refusal(retry) == (409, "not_retryable")

        received = client.sent()
        assert len(client.requests) >= 5 and "MARKER" not in received and "albatross" not in received
        # the three inputs did arrive: the option that was clicked, and the cue, once each
        assert '"A granite quay on a river"' in received and received.count(CUE) >= 1
        # (the run id names the API's cache partition, as it always has; that is not text the model reads)
        assert client.cache_keys == {"astrolabio-MARKER-run-a", "astrolabio-MARKER-run-b"}
        # and what was typed elsewhere is where it belongs
        assert (await http.get(f"/api/runs/{run_id}")).json()["team"] == "MARKER team"
        assert json.loads((ws.runs_dir / run_id / "a.json").read_text())["team"] == "MARKER team"


async def test_every_control_that_changes_a_run_is_logged_and_reading_is_not(tmp_path: Path) -> None:
    gate_a, gate_c = Gate(), Gate()
    client = Script(a=[update(), gate_a], b=[auth_error(), update(), submit()], c=[update(), gate_c])
    ws = workspace(tmp_path, client)
    files = {"Urban/a.jpg": pano_bytes(1), "Urban/b.jpg": pano_bytes(2), "non-Urban/c.jpg": pano_bytes(3)}
    async with browser(ws) as http:
        run_id = await start_run(http, files)
        base = f"/api/runs/{run_id}"
        await asyncio.wait_for(gate_a.entered.wait(), WAIT_S)
        await asyncio.wait_for(gate_c.entered.wait(), WAIT_S)
        await until(lambda: bool(events(ws, run_id, "b", "run_end")))

        # read-only navigation and notes write nothing to any log
        size = {pid: len(events(ws, run_id, pid)) for pid in "abc"}
        for path in ("", "/validation", "/pano/a/events", "/pano/a/replay", "/pano/a/inspect", "/pano/a/image?w=1024"):
            assert (await http.get(base + path)).status_code == 200, path
        assert (await http.get("/api/runs")).status_code == (await http.get("/api/snapshot")).status_code == 200
        assert (await http.post(f"{base}/pano/a/cue/check", json={"text": CUE})).status_code == 200
        assert (await http.post(f"{base}/pano/b/ack", json={"kind": "fallback"}, headers=key())).json()["tile"]["fallback_acknowledged"]
        assert (await http.patch(f"{base}/meta", json={"clock_started_at": "2026-10-11T09:00:00Z"})).status_code == 200
        assert {pid: len(events(ws, run_id, pid)) for pid in "abc"} == size

        # the question toggle: logged when it changes, not when it is clicked again
        for _ in range(2):
            off = await http.post(f"{base}/pano/a/mcq_allowed", json={"allowed": False}, headers=key())
            assert off.status_code == 200 and off.json()["tile"]["mcq_allowed"] is False
        assert [e["data"] for e in events(ws, run_id, "a", "mcq_toggle")] == [{"mcq_allowed": False}]

        # retry: only for a tile that ended without an agent answer; a new conversation in the same log
        tile = await tile_of(http, run_id, "b")
        assert (tile["origin"], tile["stop_reason"], tile["retryable"]) == ("harness_fallback", "api_error", True)
        assert refusal(await http.post(f"{base}/pano/a/retry", headers=key())) == (409, "not_retryable")
        retried = await http.post(f"{base}/pano/b/retry", headers=key())
        assert retried.status_code == 200 and retried.json()["tile"]["final"] is None
        await until(lambda: len(events(ws, run_id, "b", "run_end")) == 2)
        kinds = [event["type"] for event in events(ws, run_id, "b")]
        assert kinds.count("retry") == 1 and kinds.index("retry") > kinds.index("run_end")
        tile = await tile_of(http, run_id, "b")
        assert (tile["origin"], tile["stop_reason"], tile["retryable"], tile["segment"]) == ("agent", "submit_locations", False, 2)

        # finalize now: the answer is fixed, logged, and the conversation ends
        fixed = await http.post(f"{base}/pano/a/finalize", headers=key())
        assert fixed.status_code == 200 and fixed.json()["tile"]["stop_reason"] == "operator_finalize"
        assert fixed.json()["tile"]["stop_text"] == "finalised by the operator: best-so-far list used"
        assert [e["data"]["reason"] for e in events(ws, run_id, "a", "final_submission")] == ["operator_finalize"]
        again = await http.post(f"{base}/pano/a/finalize", headers=key())
        assert again.status_code == 200 and len(events(ws, run_id, "a", "final_submission")) == 1

        # stop run: every panorama's log records it, final or not
        stopped = await http.post(f"{base}/stop", headers=key())
        assert stopped.status_code == 200 and stopped.json()["run"]["state"] == "finished"
        for pid in "abc":
            assert [e["data"] for e in events(ws, run_id, pid, "operator_stop")] == [{"panoramas_finalised": 1}]
        assert [e["data"]["reason"] for e in events(ws, run_id, "c", "final_submission")] == ["operator_stop"]
        assert (await tile_of(http, run_id, "c"))["stop_text"] == "run stopped by the operator: best-so-far list used"
        # a stopped run takes no more work: the tile does not offer what the server would refuse
        assert all(not tile["retryable"] for tile in (await http.get(base)).json()["panoramas"])
        added = await http.post(f"{base}/panoramas", json={"set_id": (await http.get(base)).json()["set_id"]}, headers=key())
        assert refusal(added) == (409, "run_stopped")
        assert (await checklist(http, run_id))["ok"] is True


async def test_no_key_leaves_the_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)

    def offline(settings: Settings) -> httpx.AsyncClient:
        # every probe answers with the request it was sent, keys and all, as a failing provider might
        def echo(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": {"message": f"bad credentials in {request.url} {dict(request.headers)}"}})

        return httpx.AsyncClient(transport=httpx.MockTransport(echo))

    monkeypatch.setattr(health, "make_probe_client", offline)
    ws = workspace(tmp_path, Script())
    async with browser(ws) as http:
        run_id = await start_run(http, settings={"no_human": True})
        await finished(ws, run_id)
        note = f"they asked for {SECRETS['OPENAI_API_KEY']}"
        assert (await http.put("/api/settings", json={"organiser_answers": [{"id": "Q1", "note": note}]})).status_code == 200
        paths = [
            "/api/snapshot",
            "/api/runs",
            f"/api/runs/{run_id}",
            f"/api/runs/{run_id}/validation",
            f"/api/runs/{run_id}/pano/a/inspect",
            f"/api/runs/{run_id}/pano/a/events?full=1",
            f"/api/runs/{run_id}/pano/a/download?what=export",
            "/api/launch/context",
            "/api/prompt",
            "/api/settings",
            "/api/health?refresh=1",
            "/api/eval/set",
            "/api/sets",
            "/api/fs",
        ]
        seen = ""
        for path in paths:
            response = await http.get(path)
            assert response.status_code == 200, (path, response.text[:200])
            seen += response.text
        for name in SECRETS:
            tested = await http.post(f"/api/settings/keys/{name}/test", headers=key())
            assert tested.status_code == 200, tested.text
            seen += tested.text
        frames = http._transport.app.state.stream(ping_s=60.0)  # type: ignore[attr-defined]
        seen += await asyncio.wait_for(anext(frames), WAIT_S)
        await frames.aclose()

        keys = (await http.get("/api/settings")).json()["keys"]
        assert keys["OPENAI_API_KEY"] == {"set": True, "last4": "6789"} and keys["GOOGLE_MAPS_API_KEY"] == {"set": True}
        on_disk = "".join(
            path.read_text(encoding="utf-8", errors="replace")
            for root in (ws.runs_dir, ws.data_dir)
            for path in root.rglob("*")
            if path.is_file() and path.suffix in {".json", ".jsonl", ".csv"}
        )
        assert RUN_FILE in {p.name for p in (ws.runs_dir / run_id).iterdir()} and "console.json" in {p.name for p in ws.data_dir.iterdir()}
        for value in SECRETS.values():
            assert value not in seen and value not in on_disk


# --- the pieces the reports left open -------------------------------------------------------------


async def test_a_reused_run_id_keeps_the_panoramas_of_the_earlier_launch(tmp_path: Path) -> None:
    ws = workspace(tmp_path, Script())
    async with browser(ws) as http:
        both = await upload_set(http, {"Urban/a.jpg": pano_bytes(1), "non-Urban/b.jpg": pano_bytes(2)})
        spec = {"preset": "custom", "run_id": "trial", "confirm_no_key": True, "settings": {"no_human": True}}
        assert (await http.post("/api/runs", json={**spec, "set_id": both}, headers=key())).status_code == 201
        await finished(ws, "trial")
        only_a = await upload_set(http, {"Urban/a.jpg": pano_bytes(1)})
        assert (await http.post("/api/runs", json={**spec, "set_id": only_a}, headers=key())).status_code == 201
        await finished(ws, "trial")

        # b ran under this id before and is in its files: the run still shows it, and submits it
        run = (await http.get("/api/runs/trial")).json()
        tiles = {tile["panorama_id"]: tile for tile in run["panoramas"]}
        assert (tiles["a"]["live"], tiles["a"]["segment"]) == (True, 2)
        assert (tiles["b"]["live"], tiles["b"]["status"], tiles["b"]["retryable"]) == (False, "done", False)
        assert run["totals"]["total"] == run["totals"]["done"] == 2 and run["state"] == "finished"
        assert refusal(await http.post("/api/runs/trial/pano/b/finalize", headers=key())) == (404, "unknown_panorama")
        verdict = await checklist(http, "trial")
        assert verdict["ok"] is True and [file["name"] for file in verdict["files"]][:2] == ["a.json", "b.json"]
        with await submission_zip(http, "trial") as archive:
            assert sorted(answer_rows(archive.read("answers.csv").decode())) == ["a", "b"]
        # a file of the same name added later does not take over b's log
        same_name = await upload_set(http, {"Urban/b.jpg": pano_bytes(9)})
        added = await http.post("/api/runs/trial/panoramas", json={"set_id": same_name}, headers=key())
        assert added.status_code == 200 and added.json()["added"] == ["b_2"]
        await finished(ws, "trial")
        assert len(events(ws, "trial", "b", "run_start")) == 1


async def test_a_launch_that_cannot_start_leaves_the_directory_as_it_was(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = workspace(tmp_path, Script())
    async with browser(ws) as http:
        set_id = await upload_set(http, {"Urban/a.jpg": pano_bytes(1)})
        spec = {"preset": "custom", "set_id": set_id, "run_id": "trial", "confirm_no_key": True, "settings": {"no_human": True}}
        assert (await http.post("/api/runs", json=spec, headers=key())).status_code == 201
        await finished(ws, "trial")
        before = (ws.runs_dir / "trial" / RUN_FILE).read_bytes()

        def refuse(self: Any, tasks: Any) -> None:
            raise RuntimeError("the run directory is locked by another process")

        monkeypatch.setattr("server.workspace.RunManager.add_tasks", refuse)
        for run_id in ("trial", "fresh"):
            failed = await http.post("/api/runs", json={**spec, "run_id": run_id}, headers=key())
            assert refusal(failed) == (409, "launch_failed")
        # the write-ahead run.json is taken back: neither a changed run nor one that never was
        assert json.loads((ws.runs_dir / "trial" / RUN_FILE).read_bytes()) == json.loads(before)
        assert not (ws.runs_dir / "fresh" / RUN_FILE).exists() and "fresh" not in ws.handles
        rows = (await http.get("/api/runs")).json()["runs"]
        assert [(row["run_id"], row["state"]) for row in rows if row["run_id"] == "trial"] == [("trial", "finished")]


async def test_a_panorama_named_like_the_runs_own_files_is_refused(tmp_path: Path) -> None:
    ws = workspace(tmp_path, Script())
    async with browser(ws) as http:
        set_id = await upload_set(http, {"Urban/run.jpg": pano_bytes(1), "Urban/Results.jpg": pano_bytes(2), "Urban/a.jpg": pano_bytes(3)})
        table = (await http.post(f"/api/sets/{set_id}/preflight", json={"preset": "custom"})).json()
        blocking = {item["code"]: item["panorama_ids"] for item in table["blocking"]}
        assert table["ready"] is False and sorted(blocking["reserved_name"]) == ["Results", "run"]
        launched = await http.post("/api/runs", json={"preset": "custom", "set_id": set_id, "confirm_no_key": True}, headers=key())
        assert refusal(launched) == (422, "preflight_blocked") and ws.handles == {}


async def test_a_run_another_process_is_writing_is_running_not_interrupted(tmp_path: Path) -> None:
    gate = Gate()
    elsewhere = workspace(tmp_path, Script(a=[update(), gate]))  # stands for `cli.py batch` in another terminal
    async with browser(elsewhere) as http:
        run_id = await start_run(http, settings={"no_human": True})
        await asyncio.wait_for(gate.entered.wait(), WAIT_S)

        console = workspace(tmp_path, Script())  # a second server on the same runs directory
        async with browser(console) as page:
            row = next(row for row in (await page.get("/api/runs")).json()["runs"] if row["run_id"] == run_id)
            assert (row["state"], row["owned"], row["external"], row["active"]) == ("running", False, True, False)
            tile = await tile_of(page, run_id, "a")
            assert (tile["status"], tile["live"], tile["active"]) == ("running", False, False)
            assert tile["stop_text"] == "another process is running this panorama"
            # its logs are that process's to finish: no recovery, no deletion, no reuse of the id
            export = await page.post(f"/api/runs/{run_id}/export", json={}, headers=key())
            assert refusal(export) == (409, "run_owned_elsewhere") and export.json()["detail"]["action"] == "force"
            deleted = await page.request("DELETE", f"/api/runs/{run_id}", json={"confirm": run_id})
            assert refusal(deleted) == (409, "run_owned_elsewhere")
        await elsewhere.stop_run(run_id)


async def test_serve_boots_launches_the_named_directory_and_finalises_on_exit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`cli.py serve <directory>` on a real socket: the console answers, the run it was started
    for is going, and stopping the server finalises and exports it."""
    import uvicorn

    servers: list[uvicorn.Server] = []

    class Recorded(uvicorn.Server):
        def __init__(self, config: uvicorn.Config) -> None:
            super().__init__(config)
            servers.append(self)

    monkeypatch.setattr(uvicorn, "Server", Recorded)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    panoramas = tmp_path / "usb"
    (panoramas / "Urban").mkdir(parents=True)
    (panoramas / "Urban" / "a.jpg").write_bytes(pano_bytes(1))
    gate = Gate()
    ws = workspace(tmp_path, Script(a=[update(), gate]))
    launch = {
        "path": panoramas,
        "special": None,
        "label": None,
        "settings_overrides": {"no_human": None, "hedge": None, "allow_web": None},
        "live": False,
        "run_id": "from-the-terminal",
        "concurrency": None,
    }
    serving = asyncio.create_task(cli._serve_console(ws, "127.0.0.1", port, launch))
    try:
        await asyncio.wait_for(gate.entered.wait(), WAIT_S)
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", trust_env=False) as http:
            page = await http.get("/")
            assert page.status_code == 200 and "frame-ancestors 'none'" in page.headers["content-security-policy"]
            run = (await http.get("/api/runs/from-the-terminal")).json()
            # human channels on, as `serve <dir>` always was: the scoring run
            assert (run["kind"], run["mode"], run["state"]) == ("scoring", "assisted", "running")
            assert (await http.get("/api/snapshot", headers={"Host": "evil.example"})).status_code == 421
            foreign = await http.post("/api/runs/from-the-terminal/stop", headers={"Origin": "http://evil.example"})
            assert foreign.status_code == 403 and ws.owned("from-the-terminal").stopped is False
    finally:
        for server in servers:
            server.should_exit = True
        await asyncio.wait_for(serving, WAIT_S)
    assert ws.shutdown_sync() == []  # nothing was left for the step after the loop
    run_dir = ws.runs_dir / "from-the-terminal"
    doc = json.loads((run_dir / "a.json").read_text())
    assert validate_export(doc) == [] and doc["totals"]["stop_reason"] == "cancelled"
    assert [e["data"]["reason"] for e in events(ws, "from-the-terminal", "a", "final_submission")] == ["server_shutdown"]
    assert (run_dir / "answers.csv").read_text().count("\n") == 11 and not (run_dir / LOCK_NAME).exists()


async def test_lan_access_needs_the_token_and_closes_what_a_second_laptop_must_not_touch(tmp_path: Path) -> None:
    ws = workspace(tmp_path, Script())
    ws.store.set_lan(True)
    token = ws.store.lan()["token"]
    assert len(token) >= 43  # 32 random bytes
    app = create_console_app(ws, lan_host="192.168.1.20")
    second_laptop = httpx.ASGITransport(app=app, client=("192.168.1.33", 50000))
    async with httpx.AsyncClient(transport=second_laptop, base_url="http://192.168.1.20:8000") as laptop:
        assert (await laptop.get("/api/snapshot")).status_code == 401
        assert (await laptop.get("/api/snapshot", headers={"X-Astrolabio-Token": "wrong"})).status_code in {401, 403}
        joined = await laptop.get("/", params={"token": token})
        assert joined.status_code == 303 and "HttpOnly" in joined.headers["set-cookie"] and token not in joined.headers["location"]
        laptop.headers["X-Astrolabio-Token"] = token
        chips = (await laptop.get("/api/snapshot")).json()["health"]
        assert chips["lan"] is True
        settings = (await laptop.get("/api/settings")).json()
        assert settings["keys_editable"] is False and token not in json.dumps(settings)
        # keys, the server's disk and the allowed roots are the server machine's own business
        replaced = await laptop.put("/api/settings/keys/OPENAI_API_KEY", json={"value": "sk-from-the-lan-0123456789"})
        assert refusal(replaced) == (403, "lan_access_on") and not (tmp_path / ".env").exists()
        assert (await laptop.get("/api/fs")).status_code == 403
        assert (await laptop.post("/api/sets", json={"path": str(tmp_path)})).status_code == 403
        assert refusal(await laptop.put("/api/settings", json={"paths": {"allowed_roots": [str(tmp_path)]}})) == (403, "lan_access_on")
        # uploads, and with them a run, still work
        run_id = await start_run(laptop, settings={"no_human": True})
        await finished(ws, run_id)
        assert (await checklist(laptop, run_id))["ok"] is True


def test_the_cli_refuses_to_open_the_console_to_the_network_without_lan_access(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from typer.testing import CliRunner

    monkeypatch.setenv("ASTROLABIO_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setattr(cli, "_serve_console_blocking", lambda *args, **kwargs: pytest.fail("the server was started"))
    result = CliRunner().invoke(cli.app, ["serve", "--no-open", "--host", "0.0.0.0", "--port", "8765"])
    assert result.exit_code == 2 and "LAN" in result.output


def test_console_error_is_what_the_helpers_expect() -> None:
    # (the route helpers above rely on this shape for every refusal)
    assert ConsoleError(409, "no", code="x").detail() == {"message": "no", "code": "x", "action": None, "problems": None}
