"""The console's workspace: sets and preflight, launch, the lifecycle controls, exports, recovery
of a killed run, and the scripted demo model. Offline: scripted model clients, tmp_path only."""

from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import sys
import types
import zipfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import cv2
import httpx2
import numpy as np
import openai
import pytest

from astrolabio import prompts
from astrolabio.config import Budget, Settings
from astrolabio.eventlog import validate_export
from astrolabio.runner import LOCK_NAME, RunManager
from astrolabio.schema import Label, PanoramaTask
from astrolabio.session import HumanChannelError
from server.devmodel import MODEL_NAME, DemoClient
from server.runstate import read_events
from server.sets import ConsoleError
from server.store import LAUNCH_FIELDS, SettingsError
from server.workspace import PRESETS, RUN_FILE, Workspace, public_settings

HYP = {"lat": 38.7223, "lng": -9.1393, "probability": 0.8, "radius_m": 40.0, "label": "Baixa", "evidence": "tram"}
FAST = Budget(effort="high", soft_deadline_s=600, hard_deadline_s=840, max_turns=6, max_spend_usd=8.0)
CUE = "the kerb stones are painted yellow"
REQUEST = httpx2.Request("POST", "https://api.openai.com/v1/responses")
HOLD = object()  # in a script: a model call that stays in flight until the test releases it
SECRETS = {
    "OPENAI_API_KEY": "sk-test-openai-0123456789",
    "GOOGLE_MAPS_API_KEY": "google-key-0123456789",
    "MAPILLARY_TOKEN": "mapillary-token-0123456789",
}


def pano_bytes(seed: int = 0, size: tuple[int, int] = (256, 128)) -> bytes:
    noise = np.random.default_rng(seed).integers(0, 255, (size[1], size[0], 3), dtype=np.uint8)
    ok, encoded = cv2.imencode(".jpg", noise)
    assert ok
    return encoded.tobytes()


def reply(name: str, **arguments: Any) -> SimpleNamespace:
    block = {"type": "tool_use", "id": f"call_{name}", "name": name, "input": arguments}
    usage = {"input_tokens": 1000, "cached_input_tokens": 0, "cache_write_tokens": 0, "output_tokens": 100}
    return SimpleNamespace(id="resp", model="gpt-6.1-sol", content=[block], stop_reason="tool_use", stop_details=None, usage=usage)


def update() -> SimpleNamespace:
    return reply("update_candidates", hypotheses=[HYP])


def submit() -> SimpleNamespace:
    return reply("submit_locations", hypotheses=[HYP], reasoning_summary="ok")


def ask() -> SimpleNamespace:
    return reply(
        "ask_multiple_choice",
        question="Which view matches?",
        options=["Baixa: a lane with tram rails", "A granite quay on a river"],
        why_it_matters="It settles the two candidates.",
    )


def auth_error() -> openai.AuthenticationError:
    return openai.AuthenticationError("bad key", response=httpx2.Response(401, request=REQUEST), body=None)


class ScriptClient:
    """One script per panorama id ("" stands for every other panorama). An item is a message, an
    exception to raise, or HOLD; the last one repeats."""

    def __init__(self, **scripts: Any) -> None:
        self.scripts = {"": [update(), submit()], **scripts}
        self.calls: dict[str, int] = {}
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def create(self, **params: Any) -> Any:
        panorama_id = params["prompt_cache_key"].rsplit("-", 1)[-1]
        key = panorama_id if panorama_id in self.scripts else ""
        turn = 1 + sum(1 for message in params["messages"] if message["role"] == "assistant")
        self.calls[panorama_id] = self.calls.get(panorama_id, 0) + 1
        script = self.scripts[key]
        # a panorama's own script goes on where it stopped; the shared one is walked by every conversation
        item = script[min(self.calls[panorama_id] if key else turn, len(script)) - 1]
        if item is HOLD:
            self.started.set()
            await self.release.wait()
            return submit()
        if isinstance(item, BaseException):
            raise item
        await asyncio.sleep(0)
        return item


async def until(condition: Any, timeout: float = 10.0) -> None:
    async def poll() -> None:
        while not condition():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


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


def upload(ws: Workspace, *paths: str, seed: int = 0) -> str:
    """A stored set holding one small panorama per path."""
    set_id = ws.sets.create("test set")["set_id"]
    for index, path in enumerate(paths):
        ws.sets.add_file(set_id, path, pano_bytes(seed + index))
    return set_id


async def launch(ws: Workspace, set_id: str, **spec: Any) -> str:
    spec = {"preset": "custom", "set_id": set_id, "confirm_no_key": True, **spec}
    return (await ws.launch(spec))["run_id"]


async def finished(ws: Workspace, run_id: str) -> Any:
    handle = ws.owned(run_id)
    await until(lambda: handle.idle and handle.task is not None)
    await asyncio.sleep(0.02)  # the `run` message that follows is sent from a callback
    return handle


def drain(queue: asyncio.Queue) -> list[dict[str, Any]]:
    messages = []
    while not queue.empty():
        messages.append(queue.get_nowait())
    return messages


def log_events(ws: Workspace, run_id: str, pid: str, *kinds: str) -> list[dict[str, Any]]:
    events = read_events(ws.runs_dir / run_id / f"{pid}.events.jsonl")
    return [event for event in events if not kinds or event["type"] in kinds]


def export_doc(ws: Workspace, run_id: str, pid: str) -> dict[str, Any]:
    return json.loads((ws.runs_dir / run_id / f"{pid}.json").read_text())


def dead_pid() -> int:
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    return process.pid


def refused(excinfo: pytest.ExceptionInfo[ConsoleError]) -> tuple[int, str | None]:
    return excinfo.value.status, excinfo.value.code


# --- sets and preflight -----------------------------------------------------------------------


def test_upload_is_stored_byte_for_byte_and_never_overwritten(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    set_id = ws.sets.create("Sunday")["set_id"]
    data = pano_bytes(1)

    stored = ws.sets.add_file(set_id, "Urban/a.jpg", data)

    record = ws.sets.get(set_id)["files"]["Urban/a.jpg"]
    assert stored["stored"] == [{"path": "Urban/a.jpg", "size": len(data), "sha256": record["sha256"]}]
    assert (ws.sets.root / set_id / "files" / "Urban" / "a.jpg").read_bytes() == data
    assert ws.sets.add_file(set_id, "Urban/a.jpg", data) == {"stored": [], "ignored": []}  # the same bytes again
    with pytest.raises(ConsoleError) as excinfo:
        ws.sets.add_file(set_id, "Urban/a.jpg", pano_bytes(2))
    assert refused(excinfo) == (409, "file_exists")
    assert ws.sets.add_file(set_id, ".DS_Store", b"x") == {"stored": [], "ignored": [".DS_Store"]}
    for bad in ("../a.jpg", "/etc/a.jpg", "a\\b.jpg", "a/b/c/d/e.jpg", "a.exe", "x/../a.jpg"):
        with pytest.raises(ConsoleError) as excinfo:
            ws.sets.add_file(set_id, bad, data)
        assert excinfo.value.status == 422, bad
    with pytest.raises(ConsoleError) as excinfo:
        ws.sets.add_file(set_id, "manifest.json", json.dumps([{"filename": "a.jpg", "lat": 1.0, "lng": 2.0}]).encode())
    assert refused(excinfo) == (422, "evaluation_data")
    listed = ws.sets.list()
    assert [(row["set_id"], row["name"], row["kind"], row["files"], row["panoramas"]) for row in listed] == [
        (set_id, "Sunday", "upload", 1, 1)
    ]


def test_zip_members_that_climb_out_are_skipped(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    set_id = ws.sets.create()["set_id"]
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("batch/Urban/ok.jpg", pano_bytes(1))
        zf.writestr("batch/labels.csv", "filename,label\nok.jpg,Urban\n")
        zf.writestr("../evil.jpg", pano_bytes(2))
        zf.writestr("/abs.jpg", pano_bytes(3))
        zf.writestr("batch/../../up.jpg", pano_bytes(4))
        zf.writestr("__MACOSX/batch/._ok.jpg", b"fork")
        zf.writestr("batch/run.sh", "rm -rf /")
        link = zipfile.ZipInfo("batch/link.jpg")
        link.external_attr = 0o120777 << 16  # a symbolic link
        zf.writestr(link, "/etc/passwd")

    result = ws.sets.add_file(set_id, "sunday.zip", archive.getvalue())

    assert sorted(item["path"] for item in result["stored"]) == ["batch/Urban/ok.jpg", "batch/labels.csv"]
    assert sorted(result["ignored"]) == sorted(
        ["../evil.jpg", "/abs.jpg", "batch/../../up.jpg", "__MACOSX/batch/._ok.jpg", "batch/run.sh", "batch/link.jpg"]
    )
    written = sorted(p.name for p in tmp_path.rglob("*") if p.is_file() and p.suffix in {".jpg", ".sh"})
    assert written == ["ok.jpg"] and not (ws.sets.root / set_id / ".incoming").exists()
    # the folder the archive wrapped everything in is seen through
    rows = ws.sets.load(set_id).rows
    assert [(row.panorama_id, row.label, row.sources["label"]) for row in rows] == [("ok", Label.URBAN, "manifest")]

    clash = io.BytesIO()
    with zipfile.ZipFile(clash, "w") as zf:
        zf.writestr("batch/Urban/ok.jpg", pano_bytes(9))
        zf.writestr("batch/Urban/new.jpg", pano_bytes(5))
    with pytest.raises(ConsoleError) as excinfo:
        ws.sets.add_file(set_id, "again.zip", clash.getvalue())
    assert refused(excinfo) == (409, "file_exists")
    assert not (ws.sets.root / set_id / "files" / "batch" / "Urban" / "new.jpg").exists()  # all or nothing
    with pytest.raises(ConsoleError) as excinfo:
        ws.sets.add_file(set_id, "broken.zip", b"not a zip")
    assert refused(excinfo) == (422, "invalid_zip")


def test_path_sets_are_confined_and_evaluation_data_is_refused(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    usb = tmp_path / "usb"
    (usb / "Urban").mkdir(parents=True)
    (usb / "Urban" / "a.jpg").write_bytes(pano_bytes(1))

    with pytest.raises(PermissionError):
        ws.sets.create_path(usb)
    ws.store.set_paths({"allowed_roots": [str(usb)]})
    created = ws.sets.create_path(usb)
    assert created["kind"] == "path" and created["panoramas"] == 1 and Path(created["path"]) == usb.resolve()
    assert [row.panorama_id for row in ws.sets.load(created["set_id"]).rows] == ["a"]
    # the roots are checked again at every use, not only when the set was made
    ws.store.set_paths({"allowed_roots": []})
    with pytest.raises(PermissionError):
        ws.sets.load(created["set_id"])
    trusted = ws.sets.create_path(usb, confined=False)  # typed in the server's own terminal
    assert [row.panorama_id for row in ws.sets.load(trusted["set_id"]).rows] == ["a"]

    (usb / "manifest.json").write_text(json.dumps([{"panorama_id": "a", "filename": "a.jpg", "lat": 38.7, "lng": -9.1}]))
    with pytest.raises(ConsoleError) as excinfo:
        ws.sets.create_path(usb, confined=False)
    assert refused(excinfo) == (422, "evaluation_data")
    ws.eval_data_dir.mkdir()
    (ws.eval_data_dir / "x.jpg").write_bytes(pano_bytes(2))
    with pytest.raises(ConsoleError) as excinfo:
        ws.sets.create_path(ws.eval_data_dir, confined=False)
    assert refused(excinfo) == (422, "evaluation_data")


async def test_preflight_says_what_would_run_and_what_blocks_it(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    set_id = ws.sets.create()["set_id"]
    ws.sets.add_file(set_id, "Urban/a.jpg", pano_bytes(1))
    ws.sets.add_file(set_id, "non-Urban/b_20261011093000.jpg", pano_bytes(2))
    ws.sets.add_file(set_id, "c.jpg", pano_bytes(3, size=(300, 200)))

    verdict = await ws.preflight(set_id, {"preset": "scoring"})

    assert [code["code"] for code in verdict["blocking"]] == ["no_label", "special_missing"]
    assert verdict["blocking"][0]["panorama_ids"] == ["c"] and verdict["ready"] is False
    rows = {row["panorama_id"]: row for row in verdict["rows"]}
    assert set(rows) == {"a", "b_20261011093000", "c"}
    a = rows["a"]
    assert (a["label"], a["sources"]["label"], a["rel_path"], a["width"], a["height"]) == ("Urban", "folder", "Urban/a.jpg", 256, 128)
    assert a["sha256"] == ws.sets.get(set_id)["files"]["Urban/a.jpg"]["sha256"] and a["size_bytes"] > 0
    assert a["budget"] == FAST.model_dump(mode="json") and a["collides"] is False
    assert "far from the expected 6080 x 3040" in a["image_warning"] and "not 2:1" in rows["c"]["image_warning"]
    assert rows["b_20261011093000"]["timestamp"] == "20261011093000"
    assert verdict["summary"] == "3 panoramas: 1 Urban, 1 non-Urban, 1 without a label, no Special One"
    assert verdict["cost_ceiling_usd"] == 24.0 and any("no capture timestamp" in w for w in verdict["warnings"])

    choices = {"overrides": {"c": {"label": "non-Urban"}}, "special": "a"}
    ready = await ws.preflight(set_id, {"preset": "scoring", **choices, "settings": {"special": {"max_spend_usd": 20}}})
    assert ready["ready"] is True and ready["blocking"] == []
    rows = {row["panorama_id"]: row for row in ready["rows"]}
    assert rows["c"]["sources"]["label"] == "operator" and rows["c"]["parsed"]["label"] is None
    assert rows["a"]["special"] is True and rows["a"]["budget"]["max_spend_usd"] == 20.0  # a partial budget is completed
    assert ready["cost_ceiling_usd"] == 36.0 and ready["summary"].endswith("Special One = a")
    assert ready["preflight_token"] == verdict["preflight_token"]  # same files, whatever the choices

    bulk = await ws.preflight(set_id, {"apply_label_to_unlabelled": "Urban"})
    assert {row["panorama_id"]: row["sources"]["label"] for row in bulk["rows"]}["c"] == "operator_bulk"
    two = await ws.preflight(set_id, {"overrides": {"a": {"special": True}, "c": {"special": True, "label": "Urban"}}})
    assert [code["code"] for code in two["blocking"]] == ["special_multiple"]
    with pytest.raises(ConsoleError) as excinfo:
        await ws.preflight(set_id, {"overrides": {"nobody": {"label": "Urban"}}})
    assert refused(excinfo) == (422, "invalid_override")
    with pytest.raises(ConsoleError) as excinfo:
        await ws.preflight(set_id, {"overrides": {"a": {"timestamp": "church of Sao Roque, Lisbon"}}})
    assert excinfo.value.status == 422
    with pytest.raises(ConsoleError) as excinfo:
        await ws.preflight(set_id, {"settings": {"cue_max_chars": 5000}})
    assert refused(excinfo) == (422, "unknown_setting")
    with pytest.raises(KeyError):
        await ws.preflight("set-unknown", {})

    empty = ws.sets.create()["set_id"]
    assert [code["code"] for code in (await ws.preflight(empty, {}))["blocking"]] == ["no_panoramas"]
    broken = ws.sets.create()["set_id"]
    result = ws.sets.add_file(broken, "Urban/not_an_image.jpg", b"<html>hello</html>")
    assert result["ignored"] == ["Urban/not_an_image.jpg"]  # kept, but never served or launched
    assert [code["code"] for code in (await ws.preflight(broken, {}))["blocking"]] == ["unreadable_image"]
    with pytest.raises(ConsoleError) as excinfo:
        ws.sets.image(broken, "not_an_image", "full")
    assert excinfo.value.status == 404

    # a file changed behind the console's back no longer matches what was uploaded
    (ws.sets.root / set_id / "files" / "Urban" / "a.jpg").write_bytes(pano_bytes(7))
    changed = await ws.preflight(set_id, choices)
    assert [code["code"] for code in changed["blocking"]] == ["file_changed"]


def test_set_images_are_re_encoded_previews(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    set_id = ws.sets.create()["set_id"]
    ws.sets.add_file(set_id, "Urban/a.jpg", pano_bytes(1, size=(800, 400)))

    thumb, kind = ws.sets.image(set_id, "a", 300)
    full, full_kind = ws.sets.image(set_id, "Urban/a.jpg", "full")

    assert kind == full_kind == "image/jpeg" and thumb.parent == ws.data_dir / "cache" / "sets" / set_id
    assert cv2.imread(str(thumb)).shape[:2] == (160, 320) and cv2.imread(str(full)).shape[:2] == (400, 800)
    assert ws.sets.image(set_id, "a", 300)[0] == thumb  # cached
    with pytest.raises(KeyError):
        ws.sets.image(set_id, "nobody", 300)


# --- settings ---------------------------------------------------------------------------------


def test_settings_are_layered_and_only_launch_fields_ever_leave(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    ws = workspace(tmp_path, hedge=True)
    ws.store.set_defaults({"max_mcq": 1, "team": "saved"})

    settings = ws.build_settings({"model": "gpt-5.5", "team": "form", "standard": {"effort": "low"}})

    assert (settings.hedge, settings.max_mcq, settings.team) == (True, 1, "form")  # environment < saved < form
    assert settings.standard == FAST.model_copy(update={"effort": "low"})
    assert settings.pricing.input == 5.0 and settings.runs_dir == tmp_path / "runs"  # prices follow the model
    assert settings.google_maps_api_key == SECRETS["GOOGLE_MAPS_API_KEY"]  # keys: from the environment, now
    public = public_settings(settings)
    assert set(public) == set(LAUNCH_FIELDS) and ws.public_settings(settings) == public
    assert not any(secret in json.dumps(public) for secret in SECRETS.values())
    for form in ({"cue_max_chars": 5000}, {"runs_dir": "/tmp/x"}, {"nominatim_url": "http://evil"}, {"model": "gpt-0"}):
        with pytest.raises(SettingsError):
            ws.build_settings(form)
    assert ws.frozen_settings({"settings": public}).model_dump() == settings.model_dump()

    preview = ws.prompt_preview({"allow_web": False, "no_human": True, "disabled_tools": ["sun_position"]})
    assert "sun_position" not in [tool.get("name") for tool in preview["tools"]]
    assert preview["system_prompt"] == prompts.build_system_prompt(Settings(allow_web=False, no_human=True))


# --- launch -----------------------------------------------------------------------------------


async def test_launch_assisted_run_and_hub_messages_arrive_in_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    ws = workspace(tmp_path, ScriptClient())
    set_id = upload(ws, "Urban/a.jpg", "non-Urban/b.jpg")
    snapshot, queue = ws.subscribe()
    assert snapshot["runs"] == [] and snapshot["boot_id"] == ws.boot_id and snapshot["health"]["fake_model"] is False

    result = await ws.launch({"preset": "scoring", "set_id": set_id, "special": "a", "settings": {"no_human": True}})
    run_id = result["run_id"]
    handle = await finished(ws, run_id)

    assert result == {"run_id": run_id, "url": f"/runs/{run_id}", "cost_ceiling_usd": 16.0}
    messages = drain(queue)
    assert [m["seq"] for m in messages] == list(range(snapshot["seq"] + 1, snapshot["seq"] + 1 + len(messages)))
    assert ws.snapshot()["seq"] == messages[-1]["seq"]
    about = [m for m in messages if m.get("run_id") == run_id]
    assert about[0]["kind"] == "run" and about[0]["run"]["state"] == "queued"  # a tab learns of the run first
    assert [m["panorama_id"] for m in about[1:3]] == ["a", "b"] and all(m["event"] is None for m in about[1:3])
    for pid in ("a", "b"):
        events = [m["event"] for m in about if m["kind"] == "pano" and m["panorama_id"] == pid and m["event"]]
        assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
        assert [e["type"] for e in events][0] == "run_start" and [e["type"] for e in events][-1] == "run_end"
        last = [m["tile"] for m in about if m["kind"] == "pano" and m["panorama_id"] == pid][-1]
        assert last["status"] == "done" and len(last["final"]) == 10 and last["origin"] == "agent"
    runs = [m["run"] for m in about if m["kind"] == "run"]
    assert runs[-1]["state"] == "finished" and runs[-1]["totals"]["done"] == 2 and "panoramas" not in runs[-1]
    assert any(m["kind"] == "index" for m in messages)

    state = await ws.get_run(run_id)
    # the scoring preset forces the human channels on, whatever the form sent
    assert (state["kind"], state["preset"], state["mode"], state["no_human"]) == ("scoring", "scoring", "assisted", False)
    assert (state["owned"], state["active"], state["state"], state["set_id"]) == (True, False, "finished", set_id)
    assert [tile["panorama_id"] for tile in state["panoramas"]] == ["a", "b"] and state["special_present"] is True
    assert state["phases"][0] == {"key": "launch", "label": "Launch", "start_min": 0, "end_min": 2}
    assert state["export"]["stale"] is False and state["export"]["problems"] == {} and state["stage_truth"] is None
    assert state["totals"]["spend_usd"] > 0 and state["elapsed_s"] is not None and state["fake_model"] is False
    assert all(validate_export(export_doc(ws, run_id, pid)) == [] for pid in ("a", "b"))

    # run.json: written ahead, frozen, and never a key
    text = (handle.run_dir / RUN_FILE).read_text()
    meta = json.loads(text)
    assert not any(secret in text for secret in SECRETS.values())
    assert not any(secret in json.dumps(ws.snapshot()) for secret in SECRETS.values())
    assert set(meta["settings"]) == set(LAUNCH_FIELDS) and meta["settings"]["no_human"] is False
    assert [(row["panorama_id"], row["label"], row["special"]) for row in meta["tasks"]] == [
        ("a", "Urban", True),
        ("b", "non-Urban", False),
    ]
    assert meta["tasks"][0]["sha256"] == ws.sets.get(set_id)["files"]["Urban/a.jpg"]["sha256"]
    assert meta["tasks"][0]["provenance"]["special"] == {"value": True, "source": "operator", "parsed": False}
    assert meta["finished_at"] and len(meta["launches"]) == 1
    start = log_events(ws, run_id, "a", "run_start")[0]["data"]
    assert start["provenance"]["set_id"] == set_id and start["provenance"]["label"]["source"] == "folder"
    assert start["provenance"]["sha256"] == meta["tasks"][0]["sha256"]

    rows = await ws.list_runs()
    assert [(row["run_id"], row["state"]) for row in rows] == [(run_id, "finished")]
    assert "panoramas" not in rows[0] and "settings" not in rows[0] and rows[0]["wall_time_s"] >= 0


async def test_launch_refuses_what_it_should(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    ws = workspace(tmp_path)
    set_id = upload(ws, "Urban/a.jpg", "b.jpg")

    async def refusal(**spec: Any) -> tuple[int, str | None]:
        with pytest.raises(ConsoleError) as excinfo:
            await ws.launch({"preset": "custom", "set_id": set_id, "confirm_no_key": True, **spec})
        return refused(excinfo)

    assert await refusal() == (422, "preflight_blocked")  # b has no label
    labelled = {"apply_label_to_unlabelled": "Urban"}
    assert await refusal(preset="scoring", **labelled) == (422, "preflight_blocked")  # no Special One
    assert await refusal(confirm_no_key=False, **labelled) == (422, "openai_key_missing")
    assert await refusal(preset="nope") == (422, "invalid_preset")
    assert await refusal(hint="look near the river") == (422, "unknown_field")
    assert await refusal(run_id="../escape", **labelled) == (422, "invalid_run_id")
    assert await refusal(kind="eval", **labelled) == (422, "invalid_kind")
    assert await refusal(preset="autonomous", kind="scoring", **labelled) == (422, "invalid_kind")
    assert await refusal(settings={"mcq_timeout_s": 1}, **labelled) == (422, "unknown_setting")
    assert await refusal(settings={"max_mcq": 9}, **labelled) == (422, "invalid_setting")
    assert await refusal(set_id="set-unknown") == (422, "unknown_set")
    assert await refusal(preflight_token="0" * 32, **labelled) == (422, "set_changed")
    assert ws.handles == {} and not (tmp_path / "runs").exists()


async def test_penalised_actions_through_the_session_show_on_the_tile(tmp_path: Path) -> None:
    client = ScriptClient(a=[update(), ask(), HOLD])
    ws = workspace(tmp_path, client)
    run_id = await launch(ws, upload(ws, "Urban/a.jpg", "non-Urban/b.jpg"))
    session = ws.session(run_id, "a")
    assert ws.owned(run_id).manager.sessions["a"] is session and ws.owned("nope") is None

    await until(lambda: ws.tile(run_id, "a")["pending_mcq"] is not None)
    tile = ws.tile(run_id, "a")
    assert (tile["status"], tile["active"], tile["live"], tile["human_enabled"]) == ("awaiting_mcq", True, True, True)
    assert tile["penalty"] == {"cues": 0, "mcqs": 1, "human_geocodes": 0, "multiplier": 0.95}  # charged when asked
    assert tile["pending_mcq"]["option_places"][0]["label"] == "Baixa" and tile["mcqs_left"] == 2
    session.answer_mcq(tile["pending_mcq"]["id"], 0)
    await asyncio.wait_for(client.started.wait(), 5)
    assert ws.tile(run_id, "a")["last_mcq"]["outcome"] == "answered"

    before = len(log_events(ws, run_id, "a"))
    assert session.check_cue("it is near Lisboa")["ok"] is False
    assert len(log_events(ws, run_id, "a")) == before  # a check leaves no trace
    session.submit_cue(CUE, confirmed=True)
    tile = ws.tile(run_id, "a")
    assert tile["penalty"]["cues"] == 1 and tile["penalty"]["multiplier"] == pytest.approx(0.76)
    assert tile["cues"][0]["state"] == "queued" and tile["ledger_text"].startswith("x0.76")
    assert [row["kind"] for row in tile["ledger"]] == ["mcq", "cue"] and tile["geocode_enabled"] is True

    session.human_geocode(38.7101, -9.1402, "Baixa")
    await ws.settle(run_id, "a")
    tile = ws.tile(run_id, "a")
    assert (tile["status"], tile["origin"], tile["stop_reason"]) == ("done", "human_geocode", "human_geocode")
    assert tile["penalty"]["multiplier"] == pytest.approx(0.38) and tile["cues"][0]["state"] == "undelivered"
    assert {(e["lat"], e["lng"], e["multiplier"]) for e in tile["final"]} == {(38.7101, -9.1402, 0.38)}
    # the files followed at once, with the run_end of the conversation that was cut short
    doc = export_doc(ws, run_id, "a")
    assert validate_export(doc) == [] and doc["final"]["locations"][0]["origin"] == "human_geocode"
    assert doc["events"][-1]["type"] == "run_end" and ws.owned(run_id).export["problems"] == {}

    await finished(ws, run_id)
    state = await ws.get_run(run_id)
    assert state["totals"]["penalties"] == {"cues": 1, "mcqs": 1, "human_geocodes": 1}
    assert state["totals"]["lowest_multiplier"] == pytest.approx(0.38) and state["mode"] == "assisted"
    with pytest.raises(ConsoleError) as excinfo:
        await ws.retry(run_id, "a")  # its answer is the human point
    assert refused(excinfo) == (409, "not_retryable")

    # written after the run ended: the debounced export keeps the files in step
    ws.session(run_id, "b").set_mcq_allowed(False)
    assert ws.owned(run_id).clean is False
    await until(lambda: ws.owned(run_id).clean, timeout=5)
    assert export_doc(ws, run_id, "b")["events"][-1]["type"] == "mcq_toggle"


async def test_stop_mid_run_leaves_a_valid_export_for_every_panorama(tmp_path: Path) -> None:
    client = ScriptClient(a=[update(), HOLD], **{"": [update(), submit()]})
    ws = workspace(tmp_path, client)
    set_id = upload(ws, "Urban/a.jpg", "Urban/b.jpg", "Urban/c.jpg")
    run_id = await launch(ws, set_id, settings={"concurrency": 1, "no_human": True})
    await asyncio.wait_for(client.started.wait(), 5)  # a is in flight; b and c are queued behind it
    assert (await ws.get_run(run_id))["state"] == "running" and ws.owned(run_id).active

    state = await ws.stop_run(run_id)

    assert (state["state"], state["active"], state["totals"]["done"]) == ("finished", False, 3)
    assert state["export"] == {"written_at": state["export"]["written_at"], "stale": False, "problems": {}}
    ends = {}
    for pid in ("a", "b", "c"):
        doc = export_doc(ws, run_id, pid)
        assert validate_export(doc) == [] and len(doc["final"]["locations"]) == 10
        events = log_events(ws, run_id, pid)
        stops = [e for e in events if e["type"] == "operator_stop"]
        assert len(stops) == 1 and stops[0]["actor"] == "harness" and stops[0]["data"] == {"panoramas_finalised": 3}
        assert [e["data"]["reason"] for e in events if e["type"] == "final_submission"] == ["operator_stop"]
        assert doc["events"][-1]["seq"] == events[-1]["seq"]  # the files hold everything the logs do
        ends[pid] = [e["data"]["stop_reason"] for e in events if e["type"] == "run_end"]
    assert ends == {"a": ["cancelled"], "b": ["not_started"], "c": ["not_started"]}
    tiles = {tile["panorama_id"]: tile for tile in state["panoramas"]}
    assert tiles["a"]["origin"] == "agent" and tiles["b"]["origin"] == "harness_fallback"
    assert tiles["a"]["stop_reason"] == "operator_stop"  # the reason the answer was fixed, not "cancelled"

    with pytest.raises(ConsoleError) as excinfo:
        await ws.add_panoramas(run_id, {"set_id": upload(ws, "Urban/d.jpg", seed=9)})
    assert refused(excinfo) == (409, "run_stopped")
    with pytest.raises(ConsoleError) as excinfo:
        await ws.retry(run_id, "b")  # the run was closed by the operator
    assert refused(excinfo) == (409, "not_retryable")
    # a second Stop finds nothing to do and writes nothing
    before = len(log_events(ws, run_id, "a"))
    await ws.stop_run(run_id)
    assert len(log_events(ws, run_id, "a")) == before


async def test_finalize_one_and_finalize_all_log_their_reason(tmp_path: Path) -> None:
    client = ScriptClient(**{"": [update(), HOLD]})
    ws = workspace(tmp_path, client)
    run_id = await launch(ws, upload(ws, "Urban/a.jpg", "Urban/b.jpg", "Urban/c.jpg"), settings={"concurrency": 2})
    await until(lambda: all(ws.tile(run_id, pid)["hypotheses"] for pid in ("a", "b")))

    tile = await ws.finalize(run_id, "a")

    assert (tile["status"], tile["origin"], tile["stop_reason"]) == ("done", "agent", "operator_finalize")
    assert validate_export(export_doc(ws, run_id, "a")) == [] and ws.owned(run_id).active  # the others go on
    before = len(log_events(ws, run_id, "a"))
    await ws.finalize(run_id, "a")
    assert len(log_events(ws, run_id, "a")) == before  # already final: nothing happens

    state = await ws.finalize_all(run_id)
    assert state["state"] == "finished" and state["totals"]["done"] == 3
    reasons = {pid: log_events(ws, run_id, pid, "final_submission")[-1]["data"]["reason"] for pid in ("a", "b", "c")}
    assert reasons == {"a": "operator_finalize", "b": "operator_finalize_all", "c": "operator_finalize_all"}
    assert all(validate_export(export_doc(ws, run_id, pid)) == [] for pid in ("a", "b", "c"))


async def test_add_panoramas_to_a_running_and_to_a_finished_run(tmp_path: Path) -> None:
    client = ScriptClient(a=[update(), HOLD], **{"": [update(), submit()]})
    ws = workspace(tmp_path, client)
    first = upload(ws, "Urban/a.jpg")
    run_id = await launch(ws, first, special="a")
    await asyncio.wait_for(client.started.wait(), 5)
    second = upload(ws, "Urban/a.jpg", "non-Urban/late.jpg", "x.jpg", seed=0)  # a.jpg again, byte for byte

    preview = await ws.preflight(second, {"run_id": run_id, "overrides": {"x": {"label": "Urban"}}})
    rows = {row["panorama_id"]: row for row in preview["rows"]}
    assert set(rows) == {"a_2", "late", "x"} and rows["a_2"]["duplicate"] and rows["a_2"]["collides"]
    assert preview["ready"] is True and any("will be skipped" in w for w in preview["warnings"])

    async def refusal(**body: Any) -> tuple[int, str | None]:
        with pytest.raises(ConsoleError) as excinfo:
            await ws.add_panoramas(run_id, {"set_id": second, **body})
        return refused(excinfo)

    assert await refusal() == (422, "preflight_blocked")  # x has no label
    assert await refusal(overrides={"a": {"label": "non-Urban"}}) == (422, "task_is_frozen")
    assert await refusal(overrides={"A.JPG": {"label": "non-Urban"}}) == (422, "task_is_frozen")
    assert await refusal(special="late") == (409, "special_already_in_run")
    assert await refusal(overrides={"x": {"label": "Urban", "special": True}}) == (422, "preflight_blocked")
    assert await refusal(hint="x") == (422, "unknown_field")

    result = await ws.add_panoramas(run_id, {"set_id": second, "overrides": {"x": {"label": "Urban"}}})

    assert result == {"added": ["x", "late"], "skipped": ["a.jpg"]}
    await until(lambda: all(ws.tile(run_id, pid)["status"] == "done" for pid in ("late", "x")))
    assert ws.tile(run_id, "a")["status"] == "running"  # run by the start that was already going
    assert log_events(ws, run_id, "x", "run_start")[0]["data"]["provenance"]["label"]["source"] == "operator"
    # the same set again adds nothing, and x is now a launched task like any other
    again = await ws.add_panoramas(run_id, {"set_id": second})
    assert again["added"] == [] and sorted(again["skipped"]) == ["a.jpg", "late.jpg", "x.jpg"]
    assert await refusal(overrides={"x": {"label": "non-Urban"}}) == (422, "task_is_frozen")
    client.release.set()
    await finished(ws, run_id)

    third = upload(ws, "Urban/after.jpg", seed=20)
    assert await ws.add_panoramas(run_id, {"set_id": third}) == {"added": ["after"], "skipped": []}
    handle = await finished(ws, run_id)
    state = await ws.get_run(run_id)
    assert state["state"] == "finished" and state["totals"]["done"] == 4 and state["finished_at"]
    assert [row["panorama_id"] for row in handle.meta["tasks"]] == ["a", "x", "late", "after"]
    assert handle.meta["extra_set_ids"] == sorted([second, third]) and handle.meta["set_id"] == first
    assert validate_export(export_doc(ws, run_id, "after")) == []

    # a set a run was launched from is frozen, and kept while that run is on disk
    with pytest.raises(ConsoleError) as excinfo:
        ws.sets.add_file(third, "Urban/more.jpg", pano_bytes(30))
    assert refused(excinfo) == (409, "set_in_use")
    assert ws.sets.add_file(third, "Urban/after.jpg", pano_bytes(20)) == {"stored": [], "ignored": []}
    with pytest.raises(ConsoleError) as excinfo:
        ws.sets.delete(first)
    assert refused(excinfo) == (409, "set_in_use")


async def test_retry_after_an_api_error(tmp_path: Path) -> None:
    client = ScriptClient(a=[auth_error(), update(), submit()])
    ws = workspace(tmp_path, client)
    run_id = await launch(ws, upload(ws, "Urban/a.jpg", "Urban/b.jpg"), settings={"no_human": True})
    await finished(ws, run_id)
    tile = ws.tile(run_id, "a")
    assert (tile["stop_reason"], tile["origin"], tile["retryable"], tile["api_trouble"]) == ("api_error", "harness_fallback", True, True)
    assert ws.tile(run_id, "b")["retryable"] is False and ws.metrics_window()["api_errors"] == 1
    with pytest.raises(ConsoleError) as excinfo:
        await ws.retry(run_id, "b")
    assert refused(excinfo) == (409, "not_retryable")
    with pytest.raises(KeyError):
        await ws.retry(run_id, "nobody")

    acked = await ws.ack(run_id, "a", "fallback")
    assert acked["fallback_acknowledged"] is True and ws.owned(run_id).meta["acks"] == {"a": ["fallback"]}
    with pytest.raises(ConsoleError) as excinfo:
        await ws.ack(run_id, "a", "everything")
    assert excinfo.value.status == 422

    tile = await ws.retry(run_id, "a")

    assert tile["status"] in {"pending", "running"} and tile["final"] is None and ws.owned(run_id).active
    await finished(ws, run_id)
    tile = ws.tile(run_id, "a")
    assert (tile["status"], tile["origin"], tile["stop_reason"], tile["retryable"]) == ("done", "agent", "submit_locations", False)
    kinds = [event["type"] for event in log_events(ws, run_id, "a")]
    assert kinds.count("retry") == 1 and kinds.count("run_start") == 2 and kinds.index("retry") > kinds.index("run_end")
    assert log_events(ws, run_id, "a", "retry")[0]["data"] == {"previous_stop_reason": "api_error"}
    assert validate_export(export_doc(ws, run_id, "a")) == [] and tile["segment"] == 2
    window = ws.metrics_window()
    assert window["minutes"] == 15 and window["median_turn_latency_ms"] is not None and window["mean_upload_chars"] > 0


# --- runs on disk -----------------------------------------------------------------------------


async def killed_run(tmp_path: Path) -> tuple[str, Path]:
    """A run directory as kill -9 leaves it: a's log cut after its first hypotheses and ending in
    half a line, b's cut right after its start, no export, and the dead server's lock."""
    ws = workspace(tmp_path, ScriptClient())
    run_id = await launch(ws, upload(ws, "Urban/a.jpg", "non-Urban/b.jpg"), preset="scoring", special="a", run_id="sunday")
    handle = await finished(ws, run_id)
    for pid, kind in (("a", "candidates_update"), ("b", "run_start")):
        path = handle.run_dir / f"{pid}.events.jsonl"
        lines = path.read_text().splitlines()
        cut = next(i for i, line in enumerate(lines) if json.loads(line)["type"] == kind)
        path.write_text("\n".join(lines[: cut + 1]) + '\n{"schema_version": "1.0", "seq": 999, "ty')
    for name in ("a.json", "b.json", "summary.csv", "answers.csv"):
        (handle.run_dir / name).unlink()
    lock = {"pid": dead_pid(), "boot_id": ws.boot_id, "started_at": "2026-10-11T10:00:00Z"}
    (handle.run_dir / LOCK_NAME).write_text(json.dumps(lock))
    return run_id, handle.run_dir


async def test_a_killed_run_is_listed_interrupted_then_recovered_by_the_export_job(tmp_path: Path) -> None:
    run_id, run_dir = await killed_run(tmp_path)
    ws = workspace(tmp_path, ScriptClient())  # the restarted server
    before = {path.name: path.read_bytes() for path in run_dir.glob("*.jsonl")}

    rows = await ws.list_runs()
    state = await ws.get_run(run_id)

    assert [(row["run_id"], row["state"], row["owned"], row["active"], row["kind"]) for row in rows] == [
        (run_id, "interrupted", False, False, "scoring")
    ]
    assert {tile["panorama_id"]: tile["status"] for tile in state["panoramas"]} == {"a": "interrupted", "b": "interrupted"}
    assert all(not tile["live"] and tile["pending_mcq"] is None for tile in state["panoramas"])
    assert state["export"]["written_at"] is None and state["export"]["stale"] is True and state["mode"] == "assisted"
    assert {path.name: path.read_bytes() for path in run_dir.glob("*.jsonl")} == before  # looking changes nothing
    for action in (ws.stop_run(run_id), ws.finalize(run_id, "a"), ws.retry(run_id, "a"), ws.add_panoramas(run_id, {})):
        with pytest.raises(ConsoleError) as excinfo:
            await action  # nothing here to send it to
        assert refused(excinfo) == (409, "run_not_owned")
    with pytest.raises(ConsoleError):
        ws.session(run_id, "a")
    with pytest.raises(KeyError):
        ws.require_owned("no-such-run")

    job = await ws.start_export(run_id)
    assert (await ws.start_export(run_id)) is job  # one rebuild at a time
    await job.wait()

    assert job.state == "done" and job.result["recovered"] == ["a", "b"] and job.result["problems"] == {}
    state = await ws.get_run(run_id)
    assert state["state"] == "finished" and state["export"]["stale"] is False and not (run_dir / LOCK_NAME).exists()
    tiles = {tile["panorama_id"]: tile for tile in state["panoramas"]}
    assert (tiles["a"]["status"], tiles["a"]["stop_reason"], tiles["a"]["origin"]) == ("done", "recovered_from_provisional", "agent")
    assert (tiles["b"]["stop_reason"], tiles["b"]["origin"]) == ("recovered_no_hypotheses", "harness_fallback")
    for pid in ("a", "b"):
        doc = export_doc(ws, run_id, pid)
        assert validate_export(doc) == [] and doc["team"] == "albatross"
        kinds = [event["type"] for event in doc["events"]]
        assert kinds[-3:] == ["run_resumed", "final_submission", "run_end"]
    assert (run_dir / "answers.csv").read_text().count("\n") == 21

    # a finished run on disk: a plain rebuild recovers nothing, and notes go to run.json only
    again = await ws.start_export(run_id, embed_images=True)
    await again.wait()
    assert again.result["recovered"] == [] and "images" in export_doc(ws, run_id, "a")
    stamped = await ws.set_meta(run_id, {"submitted_at": "2026-10-11T10:58:00+00:00"})
    assert stamped["submitted_at"] == "2026-10-11T10:58:00.000Z" and stamped["kind"] == "scoring"
    with pytest.raises(ConsoleError):
        await ws.set_meta(run_id, {"submitted_at": "soon"})
    with pytest.raises(ConsoleError):
        await ws.set_meta(run_id, {"kind": "training"})
    with pytest.raises(ConsoleError) as excinfo:
        await ws.delete_run(run_id, run_id)
    assert refused(excinfo) == (409, "scoring_run")


async def test_a_run_another_process_is_writing_is_left_alone(tmp_path: Path) -> None:
    run_id, run_dir = await killed_run(tmp_path)
    (run_dir / LOCK_NAME).write_text(json.dumps({"pid": os.getppid(), "boot_id": "other", "started_at": "x"}))
    ws = workspace(tmp_path, ScriptClient())

    state = await ws.get_run(run_id)

    assert (state["state"], state["owned"], state["external"], state["active"]) == ("running", False, True, False)
    with pytest.raises(ConsoleError) as excinfo:
        await ws.start_export(run_id)
    assert refused(excinfo) == (409, "run_owned_elsewhere") and excinfo.value.action == "force"
    with pytest.raises(ConsoleError) as excinfo:
        await ws.launch({"preset": "scoring", "set_id": upload(ws, "Urban/a.jpg"), "special": "a", "run_id": run_id})
    assert refused(excinfo) == (409, "run_owned_elsewhere")
    logs = {path.name: path.read_bytes() for path in run_dir.glob("*.jsonl")}
    forced = await ws.start_export(run_id, force=True)  # copies the logs as they stand, finishes nothing
    await forced.wait()
    assert forced.result["recovered"] == [] and {p.name: p.read_bytes() for p in run_dir.glob("*.jsonl")} == logs


async def test_cli_runs_are_indexed_from_their_logs(tmp_path: Path) -> None:
    def task(name: str) -> PanoramaTask:
        path = tmp_path / "cli" / f"{name}.jpg"
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(pano_bytes(len(name)))
        return PanoramaTask(panorama_id=name, path=path, label=Label.URBAN)

    ws = workspace(tmp_path)
    assisted = RunManager(ws.base_settings, run_id="cli-assisted", client=ScriptClient())
    assisted.add_tasks([task("a")])
    assisted.sessions["a"].submit_cue(CUE, confirmed=True)
    batch = RunManager(ws.base_settings.model_copy(update={"no_human": True}), run_id="cli-batch", client=ScriptClient())
    batch.add_tasks([task("bb")])
    for manager in (assisted, batch):
        await manager.start()
        manager.export_all()
    (tmp_path / "runs" / "empty").mkdir()
    (tmp_path / "runs" / "not a run id").mkdir()

    rows = {row["run_id"]: row for row in await ws.list_runs()}

    assert set(rows) == {"cli-assisted", "cli-batch", "empty"}
    assert (rows["cli-assisted"]["kind"], rows["cli-assisted"]["mode"], rows["cli-assisted"]["state"]) == ("cli", "assisted", "finished")
    assert rows["cli-assisted"]["totals"]["penalties"]["cues"] == 1 and rows["cli-batch"]["mode"] == "autonomous"
    assert rows["empty"]["state"] == "invalid" and rows["cli-batch"]["started_at"] and rows["cli-batch"]["preset"] is None
    image, kind = await asyncio.to_thread(ws.pano_image, "cli-batch", "bb", 1024)
    assert kind == "image/jpeg" and image.parent == tmp_path / "runs" / "cli-batch" / "bb"

    # with a human channel used it is a scoring run as far as Delete is concerned
    with pytest.raises(ConsoleError) as excinfo:
        await ws.delete_run("cli-assisted", "cli-assisted")
    assert refused(excinfo) == (409, "scoring_run")
    with pytest.raises(ConsoleError) as excinfo:
        await ws.delete_run("cli-batch", "cli")
    assert refused(excinfo) == (422, "confirmation_mismatch")
    for unsafe in ("..", "../runs", ".", "a/b"):
        with pytest.raises(ValueError):
            await ws.delete_run(unsafe, unsafe)
    with pytest.raises(KeyError):
        await ws.delete_run("gone", "gone")
    await ws.delete_run("cli-batch", "cli-batch")
    assert not (tmp_path / "runs" / "cli-batch").exists() and (tmp_path / "runs" / "cli-assisted").is_dir()
    # a lock-less CLI run that stopped mid-way a moment ago may still have its writer
    log = tmp_path / "runs" / "cli-assisted" / "a.events.jsonl"
    log.write_text("\n".join(line for line in log.read_text().splitlines() if '"type": "run_end"' not in line) + "\n")
    assert (await ws.get_run("cli-assisted"))["state"] == "interrupted"
    with pytest.raises(ConsoleError) as excinfo:
        await ws.start_export("cli-assisted")
    assert refused(excinfo) == (409, "run_recently_written") and excinfo.value.action == "force"
    job = await ws.start_export("cli-assisted", force=True)
    await job.wait()
    assert job.result["recovered"] == ["a"] and (await ws.get_run("cli-assisted"))["state"] == "finished"


async def test_run_id_reuse_rules(tmp_path: Path) -> None:
    client = ScriptClient()
    ws = workspace(tmp_path, client)
    set_id = upload(ws, "Urban/a.jpg", "Urban/b.jpg")
    run_id = await launch(ws, set_id, run_id="r1", settings={"no_human": True})
    first = await finished(ws, run_id)
    created = first.meta["created_at"]
    await ws.set_meta(run_id, {"submitted_at": "2026-10-11T10:58:00Z"})

    async def refusal(**spec: Any) -> tuple[int, str | None]:
        with pytest.raises(ConsoleError) as excinfo:
            await ws.launch({"preset": "custom", "set_id": set_id, "run_id": "r1", "settings": {"no_human": True}, **spec})
        return refused(excinfo)

    assert await refusal(settings={"no_human": False}) == (409, "run_id_in_use")  # the channels must stay as they were
    assert await refusal(kind="live") == (409, "run_id_in_use")
    assert await refusal(overrides={"a": {"label": "non-Urban"}}) == (409, "preflight_blocked")  # a logged task changed
    assert await refusal(overrides={"a": {"timestamp": "20261011093000"}}) == (409, "preflight_blocked")
    assert await refusal(special="b") == (409, "preflight_blocked")
    changed = upload(ws, "Urban/a.jpg", seed=50)  # the same name, another image
    assert await refusal(set_id=changed) == (409, "preflight_blocked")
    blocked = await ws.preflight(changed, {"launch_run_id": "r1"})
    assert [code["code"] for code in blocked["blocking"]] == ["id_collision"]
    assert ws.owned("r1") is first  # nothing was replaced by a refused launch

    _, queue = ws.subscribe()
    assert await launch(ws, set_id, run_id="r1", settings={"no_human": True}) == "r1"
    second = await finished(ws, "r1")

    assert second is not first and ws.owned("r1") is second
    messages = drain(queue)
    assert messages[0]["kind"] == "run" and messages[0]["removed"] is True  # tabs drop the old tiles first
    assert second.meta["created_at"] == created and second.meta["submitted_at"] is None
    assert len(second.meta["launches"]) == 2 and len(second.meta["tasks"]) == 2
    kinds = [event["type"] for event in log_events(ws, "r1", "a")]
    assert kinds.count("run_resumed") == 1 and kinds.count("run_start") == 2 and kinds.count("run_end") == 2
    seqs = [event["seq"] for event in log_events(ws, "r1", "a")]
    assert seqs == list(range(1, len(seqs) + 1)) and validate_export(export_doc(ws, "r1", "a")) == []
    assert ws.tile("r1", "a")["segment"] == 2 and ws.tile("r1", "a")["turns"] == 4  # spend is counted over the whole log

    held = ScriptClient(**{"": [update(), HOLD]})
    ws.client_factory = lambda settings: held
    assert await launch(ws, set_id, run_id="r1", settings={"no_human": True}) == "r1"
    await asyncio.wait_for(held.started.wait(), 5)
    assert await refusal() == (409, "run_active")
    with pytest.raises(ConsoleError) as excinfo:
        await ws.delete_run("r1", "r1")
    assert refused(excinfo) == (409, "run_active")
    await ws.stop_run("r1")
    await ws.delete_run("r1", "r1")
    assert ws.owned("r1") is None and not (tmp_path / "runs" / "r1").exists() and (await ws.list_runs()) == []
    ws.sets.delete(set_id)  # no run needs it any more


# --- evaluation and ground truth --------------------------------------------------------------


def eval_set(ws: Workspace, *labels: str) -> list[dict[str, Any]]:
    ws.eval_data_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for index, label in enumerate(labels):
        pid = f"eval_{index}"
        (ws.eval_data_dir / f"{pid}.jpg").write_bytes(pano_bytes(index))
        entries.append(
            {
                "panorama_id": pid,
                "filename": f"{pid}.jpg",
                "lat": 38.7 + index,
                "lng": -9.1,
                "label": label,
                "timestamp": "20180511142427",
                "source_image_id": f"img{index}",
                "sequence": f"seq{index}",
            }
        )
    (ws.eval_data_dir / "manifest.json").write_text(json.dumps(entries))
    return entries


async def test_eval_launch_refuses_todo_labels_and_applies_leak_guards(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = ScriptClient(**{"": [update(), HOLD]})
    ws = workspace(tmp_path, client)
    scored: list[tuple[Path, Path, dict[str, Any]]] = []

    def score_run_dir(run_dir: Path, manifest_path: Path, config: dict[str, Any]) -> dict[str, Any]:
        scored.append((run_dir, manifest_path, config))
        summary = {"all": {"score_share_of_max": 0.42, "median_rank1_distance_m": 1234.5}}
        (run_dir / "results.json").write_text(json.dumps({"run_id": run_dir.name, "config": config, "summary": summary}))
        (run_dir / "results.hedge.json").write_text("{}")
        return {}

    fake = types.ModuleType("server.evalops")
    fake.score_run_dir = score_run_dir  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "server.evalops", fake)
    monkeypatch.setattr(sys.modules["server"], "evalops", fake, raising=False)

    async def refusal(**spec: Any) -> tuple[int, str | None]:
        with pytest.raises(ConsoleError) as excinfo:
            await ws.launch({"preset": "eval", **spec})
        return refused(excinfo)

    assert await refusal() == (409, "no_eval_set")
    eval_set(ws, "Urban", "TODO", "non-Urban")
    assert await refusal() == (409, "todo_labels")
    entries = eval_set(ws, "Urban", "non-Urban", "Urban")
    assert await refusal(set_id=upload(ws, "Urban/a.jpg")) == (422, "eval_takes_no_set")
    assert await refusal(special="eval_0") == (422, "eval_takes_no_set")
    assert await refusal(eval={"limit": 0}) == (422, "invalid_limit")
    assert await refusal(kind="training") == (422, "invalid_kind")

    spec = {"preset": "eval", "eval": {"limit": 2}, "settings": {"no_human": False, "hedge": True, "disabled_tools": ["sun_position"]}}
    result = await ws.launch(spec)
    run_id = result["run_id"]
    handle = ws.owned(run_id)

    assert result["cost_ceiling_usd"] == 16.0 and sorted(handle.manager.sessions) == ["eval_0", "eval_1"]
    assert handle.settings.no_human is True and handle.meta["kind"] == "eval" and handle.meta["set_id"] is None
    assert handle.meta["eval"] == {"manifest": str(ws.eval_data_dir / "manifest.json"), "limit": 2}
    for index, pid in enumerate(("eval_0", "eval_1")):
        session = handle.manager.sessions[pid]
        assert session.excluded_image_ids == {f"img{index}"} and session.excluded_sequence_ids == {f"seq{index}"}
        assert session.excluded_point == (entries[index]["lat"], entries[index]["lng"])
    assert '"lat"' not in json.dumps(handle.meta)  # the truth stays in the manifest
    with pytest.raises(ConsoleError) as excinfo:
        await ws.add_panoramas(run_id, {"set_id": "set-x"})
    assert refused(excinfo) == (409, "eval_run")
    with pytest.raises(HumanChannelError):
        ws.session(run_id, "eval_0").submit_cue(CUE, confirmed=True)  # forced autonomous, whatever the form said
    await ws.stop_run(run_id)
    assert [(run_dir.name, manifest.name, config["panoramas"]) for run_dir, manifest, config in scored] == [
        (run_id, "manifest.json", 2)
    ]


async def test_eval_run_is_scored_when_it_ends_and_only_behind_the_truth_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = workspace(tmp_path, ScriptClient(eval_0=[auth_error(), update(), submit()]))
    calls: list[dict[str, Any]] = []

    def score_run_dir(run_dir: Path, manifest_path: Path, config: dict[str, Any]) -> dict[str, Any]:
        calls.append(config)
        summary = {"all": {"score_share_of_max": 0.42, "median_rank1_distance_m": 1234.5}}
        (run_dir / "results.json").write_text(json.dumps({"run_id": run_dir.name, "config": config, "summary": summary}))
        (run_dir / "results.hedge.json").write_text("{}")
        return {}

    fake = types.ModuleType("server.evalops")
    fake.score_run_dir = score_run_dir  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "server.evalops", fake)
    monkeypatch.setattr(sys.modules["server"], "evalops", fake, raising=False)
    eval_set(ws, "Urban", "non-Urban")

    run_id = (await ws.launch({"preset": "eval", "settings": {"hedge": True, "disabled_tools": ["sun_position"]}}))["run_id"]
    handle = await finished(ws, run_id)

    assert calls == [
        {
            "mode": "run",
            "model": "gpt-6.1-sol",
            "effort": {"standard": "high", "special": "high"},
            "hedge": True,
            "allow_duplicates": True,
            "allow_web": False,
            "tools_off": ["sun_position"],
            "manifest": str(ws.eval_data_dir / "manifest.json"),
            "panoramas": 2,
            "fake_model": False,
        }
    ]
    state = await ws.get_run(run_id)
    assert state["results"] == {"score_share": 0.42, "median_rank1_m": 1234.5, "variants": ["hedge"]}
    assert state["kind"] == "eval" and state["no_human"] is True and state["phases"] is None

    # a retried eval panorama gets its leak guards again, and the run is scored again when it ends
    await ws.retry(run_id, "eval_0")
    assert handle.manager.sessions["eval_0"].excluded_image_ids == {"img0"}
    await finished(ws, run_id)
    assert len(calls) == 2 and ws.tile(run_id, "eval_0")["origin"] == "agent"

    # reveal truth on stage: only with the human channels off, only once final, and in run.json only
    events_before = len(log_events(ws, run_id, "eval_1"))
    revealed = await ws.set_stage_truth(run_id, "eval_1", HYP["lat"], HYP["lng"])
    assert revealed == {"distance_m": 0.0, "theta": 2.0, "score": 16050.5, "max_score": 16050.5, "share": 1.0}
    note = (await ws.get_run(run_id))["stage_truth"]["eval_1"]
    assert note["score"] == 16050.5 and note["lat"] == HYP["lat"] and note["at"].endswith("Z")
    assert len(log_events(ws, run_id, "eval_1")) == events_before and "stage_truth" not in json.dumps(export_doc(ws, run_id, "eval_1"))
    with pytest.raises(ConsoleError) as excinfo:
        await ws.set_stage_truth(run_id, "eval_1", 91.0, 0.0)
    assert excinfo.value.status == 422
    with pytest.raises(KeyError):
        await ws.set_stage_truth(run_id, "nobody", 1.0, 1.0)

    # the same files after a restart, and then with a human event in a log: no truth-derived number
    restarted = workspace(tmp_path)
    assert (await restarted.get_run(run_id))["results"]["score_share"] == 0.42
    log = handle.run_dir / "eval_1.events.jsonl"
    cue = {**log_events(ws, run_id, "eval_1")[-1], "seq": 9999, "type": "human_cue", "actor": "human", "data": {"text": CUE}}
    log.write_text(log.read_text() + json.dumps(cue) + "\n")
    state = await restarted.get_run(run_id)
    assert state["results"] is None and state["totals"]["penalties"]["cues"] == 1
    with pytest.raises(ConsoleError) as excinfo:
        await restarted.set_stage_truth(run_id, "eval_1", 1.0, 1.0)
    assert refused(excinfo) == (403, "human_channels_on")


async def test_truth_gate_on_assisted_and_unfinished_runs(tmp_path: Path) -> None:
    client = ScriptClient(**{"": [update(), HOLD]})
    ws = workspace(tmp_path, client)
    assisted = await launch(ws, upload(ws, "Urban/a.jpg"), run_id="assisted")
    autonomous = await launch(ws, upload(ws, "Urban/b.jpg", seed=5), run_id="autonomous", settings={"no_human": True})
    await until(lambda: ws.tile(autonomous, "b")["hypotheses"] and ws.tile(assisted, "a")["hypotheses"])

    with pytest.raises(ConsoleError) as excinfo:
        await ws.set_stage_truth(autonomous, "b", 38.7, -9.1)
    assert refused(excinfo) == (409, "not_final")  # unavailable while the panorama is running
    await ws.finalize_all(assisted)
    with pytest.raises(ConsoleError) as excinfo:
        await ws.set_stage_truth(assisted, "a", 38.7, -9.1)  # final, but a geocode could still follow
    assert refused(excinfo) == (403, "human_channels_on")
    assert (await ws.get_run(assisted))["stage_truth"] is None and (await ws.get_run(assisted))["results"] is None
    await ws.finalize_all(autonomous)
    _, queue = ws.subscribe()
    shown = await ws.set_stage_truth(autonomous, "b", 38.7223, -9.1393)
    assert shown["share"] == 1.0 and (await ws.get_run(autonomous))["stage_truth"]["b"]["distance_m"] == 0.0
    await asyncio.sleep(0.02)
    kinds = [message["kind"] for message in drain(queue)]
    assert "run" in kinds and "pano" not in kinds  # other tabs draw it; it is never a panorama event


# --- the scripted demo model ------------------------------------------------------------------


async def test_demo_client_plays_a_whole_conversation_with_local_tools(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASTROLABIO_FAKE_MODEL_DELAY_S", "0")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert DemoClient().delay_s == 0.0 and DemoClient(1.5).delay_s == 1.5
    base = Settings(runs_dir=tmp_path / "runs", cache_dir=tmp_path / "cache", allow_web=False, live=FAST)
    ws = Workspace(base, data_dir=tmp_path / "data", eval_data_dir=tmp_path / "eval", env_path=tmp_path / ".env", fake_model=True)
    set_id = upload(ws, "Urban/a.jpg", "non-Urban/b.jpg")
    assert ws.chips()["fake_model"] is True and (await ws.launch_context())["fake_model"] is True

    # A scoring or live launch under the scripted model is a rehearsal: the preset stays (phase guide,
    # live budget), the kind is training, and the run says what answered it.
    for spec in ({"preset": "scoring", "special": "a"}, {"preset": "live"}, {"preset": "custom", "kind": "scoring"}):
        rehearsal = (await ws.launch({"set_id": set_id, **spec}))["run_id"]
        state = await ws.stop_run(rehearsal)
        assert (state["kind"], state["preset"], state["fake_model"]) == ("training", spec["preset"], True)
        assert (state["phases"] is not None) == (spec["preset"] == "scoring") and state["stopped"] is True
        assert state["live_budget"] is (spec["preset"] == "live")
        await ws.delete_run(rehearsal, rehearsal)  # a training run: it can be thrown away

    run_id = (await ws.launch({"preset": "custom", "set_id": set_id}))["run_id"]  # no key needed, none asked for
    await until(lambda: ws.tile(run_id, "a")["pending_mcq"] is not None)
    question = ws.tile(run_id, "a")["pending_mcq"]
    assert len(question["options"]) == 3 and all(place is not None for place in question["option_places"])
    ws.session(run_id, "a").answer_mcq(question["id"], 1)
    await until(lambda: ws.tile(run_id, "b")["pending_mcq"] is not None)
    await ws.finalize(run_id, "b")  # a question nobody answers ends with the panorama
    handle = await finished(ws, run_id)

    tiles = {pid: ws.tile(run_id, pid) for pid in ("a", "b")}
    assert tiles["a"]["origin"] == "agent" and tiles["a"]["stop_reason"] == "submit_locations"
    assert 2 <= len(tiles["a"]["hypotheses"]) <= 3 and len(tiles["a"]["crops"]) == 3 and tiles["a"]["turns"] == 5
    assert tiles["a"]["hypotheses"][0]["label"] == question["option_places"][1]["label"]  # the click was honoured
    assert all(35 < h["lat"] < 44 and -10 < h["lng"] < 4 for h in tiles["a"]["hypotheses"])  # Portugal or Spain
    assert tiles["a"]["model"] == MODEL_NAME and 0 < tiles["a"]["spend_usd"] < 1 and tiles["b"]["last_mcq"]["outcome"] == "released"
    tools = {event["data"]["tool"] for event in log_events(ws, run_id, "a", "tool_call")}
    assert tools == {"view_crop", "update_candidates", "ask_multiple_choice", "submit_locations"}
    assert handle.meta["fake_model"] is True and handle.meta["settings"]["model"] == MODEL_NAME
    assert export_doc(ws, run_id, "a")["config"]["model"] == MODEL_NAME
    state = await ws.get_run(run_id)
    assert state["fake_model"] is True and (await ws.launch_context())["estimates"] == {}  # never mixed with real costs

    # the same panorama id always gets the same places
    again = (await ws.launch({"preset": "autonomous", "set_id": set_id}))["run_id"]
    await finished(ws, again)
    assert ws.tile(again, "a")["turns"] == 4 and ws.tile(again, "a")["last_mcq"] is None  # autonomous: no question
    assert {h["label"] for h in ws.tile(again, "a")["hypotheses"]} == {h["label"] for h in tiles["a"]["hypotheses"]}


def test_fake_model_comes_from_the_process_environment_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = Settings(runs_dir=tmp_path / "runs", cache_dir=tmp_path / "cache")
    args = {"data_dir": tmp_path / "data", "eval_data_dir": tmp_path / "eval", "env_path": tmp_path / ".env"}
    monkeypatch.delenv("ASTROLABIO_FAKE_MODEL", raising=False)
    assert Workspace(base, **args).fake_model is False
    monkeypatch.setenv("ASTROLABIO_FAKE_MODEL", "1")
    assert Workspace(base, **args).fake_model is True
    assert Workspace(base, fake_model=False, **args).fake_model is False  # the CLI's captured value wins


# --- the rest of the surface ------------------------------------------------------------------


async def test_launch_context_and_estimates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", SECRETS["OPENAI_API_KEY"])
    monkeypatch.delenv("MAPILLARY_TOKEN", raising=False)
    ws = workspace(tmp_path, ScriptClient())
    run_id = await launch(ws, upload(ws, "Urban/a.jpg", "Urban/b.jpg"), preset="autonomous")
    await finished(ws, run_id)

    context = await ws.launch_context()

    assert list(context["presets"]) == ["autonomous", "scoring", "live", "eval", "custom"] and context["presets"] == PRESETS
    assert context["presets"]["scoring"]["requires_special"] is True and context["presets"]["eval"]["locked"][0] == "no_human"
    assert set(context["defaults"]) == set(LAUNCH_FIELDS) and context["defaults"]["team"] == "albatross"
    tools = {tool["name"]: tool for tool in context["tools"]}
    assert tools["submit_locations"]["protected"] and tools["web_search"]["web"] and not tools["view_crop"]["web"]
    assert "gpt-6.1-sol" in context["models"] and context["fake_model"] is False
    readiness = context["readiness"]
    assert readiness["openai_key"] is True and readiness["mapillary_token"] is False and readiness["disk_free_bytes"] > 0
    assert readiness["active_runs"] == [] and readiness["internet"] is None
    estimate = context["estimates"]["autonomous"]
    assert (estimate["runs"], estimate["panoramas"]) == (1, 2) and estimate["mean_cost_usd"] > 0
    assert SECRETS["OPENAI_API_KEY"] not in json.dumps(context)

    _, queue = ws.subscribe()
    ws.set_health(openai=True, internet=False)
    message = drain(queue)[-1]
    assert message["kind"] == "health" and message["health"]["openai"] == {"present": True, "ok": True}
    assert message["health"]["internet"] == {"ok": False} and message["health"]["lan"] is False


async def test_launch_path_runs_a_directory_named_in_the_terminal(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient())
    stick = tmp_path / "stick"
    stick.mkdir()
    for index, name in enumerate(("one_Urban.jpg", "two.jpg")):
        (stick / name).write_bytes(pano_bytes(index))

    result = await ws.launch_path(stick, special="two", label="non-Urban", settings_overrides={"hedge": True}, concurrency=1)
    handle = await finished(ws, result["run_id"])

    assert (handle.meta["kind"], handle.meta["preset"], handle.settings.hedge, handle.settings.concurrency) == ("scoring", "custom", True, 1)
    tasks = {row["panorama_id"]: row for row in handle.meta["tasks"]}
    assert tasks["two"]["special"] is True and tasks["two"]["provenance"]["label"]["source"] == "default"
    assert tasks["one_Urban"]["label"] == "Urban" and ws.sets.get(handle.meta["set_id"])["kind"] == "path"
    live = await ws.launch_path(stick, label="Urban", settings_overrides={"no_human": True}, live=True, run_id="onstage")
    assert live["run_id"] == "onstage" and ws.owned("onstage").meta["kind"] == "live" and ws.owned("onstage").manager.live
    await finished(ws, "onstage")


async def test_shutdown_finalises_and_exports_what_is_still_going(tmp_path: Path) -> None:
    client = ScriptClient(**{"": [update(), HOLD]})
    ws = workspace(tmp_path, client)
    run_id = await launch(ws, upload(ws, "Urban/a.jpg", "Urban/b.jpg"), settings={"concurrency": 1, "no_human": True})
    await asyncio.wait_for(client.started.wait(), 5)

    await ws.shutdown()

    assert not ws.owned(run_id).active and ws.shutdown_sync() == []  # nothing left for the CLI's finally
    reasons = {pid: log_events(ws, run_id, pid, "final_submission")[-1]["data"]["reason"] for pid in ("a", "b")}
    assert reasons == {"a": "server_shutdown", "b": "server_shutdown"}
    assert all(validate_export(export_doc(ws, run_id, pid)) == [] for pid in ("a", "b"))


def test_shutdown_sync_writes_the_files_after_the_loop_died(tmp_path: Path) -> None:
    client = ScriptClient(**{"": [update(), HOLD]})
    ws = workspace(tmp_path, client)

    async def serve_until_interrupted() -> str:
        run_id = await launch(ws, upload(ws, "Urban/a.jpg"), settings={"no_human": True})
        await asyncio.wait_for(client.started.wait(), 5)
        return run_id  # the loop ends here with the model call still in flight, as on Ctrl-C

    run_id = asyncio.run(serve_until_interrupted())
    assert not (tmp_path / "runs" / run_id / "a.json").exists()

    written = ws.shutdown_sync()

    assert sorted(path.name for path in written) == ["a.json", "answers.csv", "summary.csv"]
    doc = export_doc(ws, run_id, "a")
    assert validate_export(doc) == [] and doc["totals"]["stop_reason"] == "cancelled"
    assert json.loads((tmp_path / "runs" / run_id / RUN_FILE).read_text())["finished_at"]
    assert ws.shutdown_sync() == []
