"""What the screens asked of the backend once they met it: sets that lose no image, sentences that
read right for one panorama, the facts a page needs to refuse or repeat an action up front, a
health check that is safe on every page load, and the scoring hour rehearsed on the demo model.
Offline: scripted model clients, mock probe transports, tmp_path only."""

from __future__ import annotations

import asyncio
import io
import json
import uuid
import zipfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import cv2
import httpx
import numpy as np
import pytest

from eval import build_set, run_eval
from astrolabio.config import Budget, Settings
from astrolabio.runner import load_tasks_detailed
from astrolabio.schema import Label
from server import health
from server.console import create_console_app
from server.devmodel import MODEL_NAME
from server.security import KEY_NAMES
from server.validation import validate_run
from server.words import count, listed, plural
from server.workspace import Workspace

BASE = "http://127.0.0.1:8000"
LISBON = (38.713900, -9.139400)
HYP = {"lat": LISBON[0], "lng": LISBON[1], "probability": 0.8, "radius_m": 40.0, "label": "Baixa", "evidence": "tram"}
FAST = Budget(effort="high", soft_deadline_s=600, hard_deadline_s=840, max_turns=6, max_spend_usd=8.0)
LIVE = Budget(effort="low", soft_deadline_s=150, hard_deadline_s=210, max_turns=6, max_spend_usd=2.0)
SECRETS = {
    "OPENAI_API_KEY": "sk-test-openai-0123456789",
    "GOOGLE_MAPS_API_KEY": "google-key-0123456789",
    "MAPILLARY_TOKEN": "mapillary-token-0123456789",
}
DASHES = ("—", "–")  # em and en dash: the console writes plain punctuation


@pytest.fixture(autouse=True)
def offline(monkeypatch: pytest.MonkeyPatch) -> None:
    """No key of the developer's environment, no delay in the scripted model, and no way out."""
    for name in (*KEY_NAMES, "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"):
        monkeypatch.setenv(name, "recorded")
        monkeypatch.delenv(name)
    monkeypatch.setenv("ASTROLABIO_FAKE_MODEL_DELAY_S", "0")

    def no_network(settings: Settings) -> httpx.AsyncClient:
        raise AssertionError("a test reached the real probe client")

    monkeypatch.setattr(health, "make_probe_client", no_network)


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


class ScriptClient:
    """Every panorama updates its candidates, then submits."""

    async def create(self, **params: Any) -> Any:
        turn = 1 + sum(1 for message in params["messages"] if message["role"] == "assistant")
        await asyncio.sleep(0)
        if turn == 1:
            return model_reply("update_candidates", hypotheses=[HYP])
        return model_reply("submit_locations", hypotheses=[HYP], reasoning_summary="ok")


def workspace(tmp_path: Path, client: Any = None, *, fake_model: bool = False, **overrides: Any) -> Workspace:
    base = Settings(
        **{
            "runs_dir": tmp_path / "runs",
            "cache_dir": tmp_path / "cache",
            "allow_web": False,
            "standard": FAST,
            "special": FAST,
            "live": LIVE,
            **overrides,
        }
    )
    return Workspace(
        base,
        data_dir=tmp_path / "data",
        eval_data_dir=tmp_path / "eval",
        client_factory=(lambda settings: client) if client is not None else None,
        env_path=tmp_path / ".env",
        fake_model=fake_model,
    )


def browser(ws: Workspace) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=create_console_app(ws)), base_url=BASE)


def key() -> dict[str, str]:
    return {"Idempotency-Key": uuid.uuid4().hex}


def refusal(response: httpx.Response) -> tuple[int, str | None]:
    return response.status_code, response.json()["detail"].get("code")


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
    set_id = (await http.post("/api/sets", json={"name": "Sunday"})).json()["set_id"]
    for path, data in files.items():
        stored = await http.put(f"/api/sets/{set_id}/files", params={"path": path}, content=data)
        assert stored.status_code == 200, stored.text
    return set_id


def strings(value: Any) -> list[str]:
    """Every string anywhere in a JSON payload."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [text for item in value.values() for text in strings(item)]
    if isinstance(value, list):
        return [text for item in value for text in strings(item)]
    return []


def no_dashes(payload: Any) -> None:
    found = [text for text in strings(payload) if any(dash in text for dash in DASHES)]
    assert not found, found


def drain(queue: asyncio.Queue[Any]) -> list[dict[str, Any]]:
    out = []
    while not queue.empty():
        out.append(queue.get_nowait())
    return out


# --- 1. every stored image is a row, or is named with the reason --------------------------------


async def test_a_dropped_folder_and_a_loose_file_all_become_rows(tmp_path: Path) -> None:
    """The reported loss: `trial/` dropped, then one loose file added, and five panoramas became
    two because only the top folder was read."""
    ws = workspace(tmp_path)
    files = {
        "trial/Urban/a.jpg": pano_bytes(1),
        "trial/Urban/b.jpg": pano_bytes(2),
        "trial/non-Urban/c.jpg": pano_bytes(3),
        "trial/d_urban.jpg": pano_bytes(4),
    }
    async with browser(ws) as http:
        set_id = await upload_set(http, files)
        before = (await http.post(f"/api/sets/{set_id}/preflight", json={})).json()
        assert sorted(row["rel_path"] for row in before["rows"]) == sorted(files)

        loose = await http.put(f"/api/sets/{set_id}/files", params={"path": "e.jpg"}, content=pano_bytes(5))
        assert loose.status_code == 200
        after = (await http.post(f"/api/sets/{set_id}/preflight", json={})).json()
        rows = {row["rel_path"]: row for row in after["rows"]}
        assert sorted(rows) == sorted([*files, "e.jpg"])
        # the paths the page keys the operator's choices by did not move under the first four
        assert {path: rows[path]["panorama_id"] for path in files} == {
            row["rel_path"]: row["panorama_id"] for row in before["rows"]
        }
        assert (rows["trial/Urban/a.jpg"]["label"], rows["trial/Urban/a.jpg"]["sources"]["label"]) == ("Urban", "folder")
        assert rows["trial/non-Urban/c.jpg"]["label"] == "non-Urban" and rows["trial/d_urban.jpg"]["label"] == "Urban"
        assert rows["e.jpg"]["label"] is None and after["blocking"][0]["code"] == "no_label"
        assert [item["code"] for item in after["blocking"]] == ["no_label"] and after["ignored"] == []
        listed_sets = {item["set_id"]: item for item in (await http.get("/api/sets")).json()["sets"]}
        assert listed_sets[set_id]["panoramas"] == len(after["rows"]) == 5  # what is stored is what would run

        # each image is served under the path its row shows
        for rel_path in rows:
            image = await http.get(f"/api/sets/{set_id}/image/{rel_path}", params={"w": 320})
            assert image.status_code == 200 and image.headers["content-type"] == "image/jpeg"

        launched = await http.post(
            "/api/runs",
            json={"preset": "autonomous", "set_id": set_id, "confirm_no_key": True, "overrides": {"e": {"label": "Urban"}}},
            headers=key(),
        )
        assert launched.status_code == 201, launched.text
        run = (await http.get(f"/api/runs/{launched.json()['run_id']}")).json()
        assert sorted(tile["panorama_id"] for tile in run["panoramas"]) == ["a", "b", "c", "d_urban", "e"]
        await http.post(f"/api/runs/{run['run_id']}/stop", headers=key())


async def test_a_manifest_dropped_beside_a_folder_still_labels_it(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    manifest = "filename,label,timestamp,special\na.jpg,Urban,20261011093000,true\nb.jpg,non-Urban,,false\n"
    async with browser(ws) as http:
        files = {"usb/a.jpg": pano_bytes(1), "usb/b.jpg": pano_bytes(2), "labels.csv": manifest.encode()}
        set_id = await upload_set(http, files)
        verdict = (await http.post(f"/api/sets/{set_id}/preflight", json={"preset": "scoring"})).json()
    rows = {row["panorama_id"]: row for row in verdict["rows"]}
    assert verdict["ready"] is True and set(rows) == {"a", "b"}
    assert (rows["a"]["label"], rows["a"]["sources"]["label"], rows["a"]["special"]) == ("Urban", "manifest", True)
    assert rows["a"]["timestamp"] == "20261011093000" and rows["b"]["label"] == "non-Urban"
    # a manifest nearer the image wins over one further out
    nearer = ws.sets.create()["set_id"]
    ws.sets.add_file(nearer, "labels.csv", b"filename,label\na.jpg,Urban\n")
    ws.sets.add_file(nearer, "usb/labels.csv", b"filename,label\na.jpg,non-Urban\n")
    ws.sets.add_file(nearer, "usb/a.jpg", pano_bytes(1))
    assert [row.label for row in ws.sets.load(nearer).rows] == [Label.NON_URBAN]


def test_images_in_folders_of_any_depth_and_name_are_rows(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    set_id = ws.sets.create()["set_id"]
    paths = ["a.jpg", "Urban/b.jpg", "day1/c.jpg", "day1/extra/d.jpg", "day2/non-Urban/e.jpg", "x/y/z/f.jpg"]
    for seed, path in enumerate(paths):
        ws.sets.add_file(set_id, path, pano_bytes(seed))
    loaded = ws.sets.load(set_id)
    assert sorted(row.rel_path for row in loaded.rows) == sorted(paths)
    assert len({row.panorama_id for row in loaded.rows}) == len(paths)
    labels = {row.rel_path: row.label for row in loaded.rows}
    assert labels["Urban/b.jpg"] == Label.URBAN and labels["day2/non-Urban/e.jpg"] == Label.NON_URBAN
    assert labels["day1/extra/d.jpg"] is None  # a folder that is not a label says nothing
    verdict = ws.sets.preflight(set_id, settings=ws.build_settings())
    assert verdict["ignored"] == [] and not any(item["code"] == "image_not_read" for item in verdict["blocking"])


def test_a_stored_image_that_is_not_a_row_blocks_the_launch_by_name(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    set_id = ws.sets.create()["set_id"]
    ws.sets.add_file(set_id, "Urban/a.jpg", pano_bytes(1))
    ws.sets.add_file(set_id, "Urban/b.jpg", pano_bytes(2))
    (ws.sets.root / set_id / "files" / "Urban" / "b.jpg").unlink()  # behind the store's back

    verdict = ws.sets.preflight(set_id, settings=ws.build_settings())

    assert [row["panorama_id"] for row in verdict["rows"]] == ["a"] and verdict["ready"] is False
    blocked = {item["code"]: item["text"] for item in verdict["blocking"]}
    assert "Urban/b.jpg" in blocked["image_not_read"] and "no longer on disk" in blocked["image_not_read"]
    assert blocked["image_not_read"].startswith("1 stored image would not run")
    assert verdict["ignored"] == ["Urban/b.jpg (stored, but the file is no longer on disk)"]


def test_a_path_set_names_the_images_its_folder_layout_leaves_out(tmp_path: Path) -> None:
    """A directory on the server is read as the CLI reads it; what that leaves out is said."""
    ws = workspace(tmp_path)
    usb = tmp_path / "usb"
    for seed, path in enumerate(["Urban/a.jpg", "b_urban.jpg", "old/c.jpg", "Urban/deeper/d.jpg"]):
        (usb / path).parent.mkdir(parents=True, exist_ok=True)
        (usb / path).write_bytes(pano_bytes(seed))
    set_id = ws.sets.create_path(usb, confined=False)["set_id"]

    verdict = ws.sets.preflight(set_id, settings=ws.build_settings())

    assert sorted(row["rel_path"] for row in verdict["rows"]) == ["Urban/a.jpg", "b_urban.jpg"]
    assert len(verdict["ignored"]) == 2 and all("not read" in name for name in verdict["ignored"])
    assert verdict["ignored"][0].startswith("Urban/deeper/d.jpg") and verdict["ignored"][1].startswith("old/c.jpg")
    warning = next(text for text in verdict["warnings"] if "sub-folders" in text)
    assert warning.startswith("2 images in other sub-folders are not read") and "old/c.jpg" in warning
    # and the CLI's own reading of the same directory is unchanged
    assert sorted(row.rel_path for row in load_tasks_detailed(usb).rows) == ["Urban/a.jpg", "b_urban.jpg"]


# --- 2. sentences ---------------------------------------------------------------------------------


def test_counts_agree_with_their_nouns() -> None:
    assert (count(1, "panorama"), count(0, "panorama"), count(3, "panorama")) == ("1 panorama", "0 panoramas", "3 panoramas")
    assert (count(1, "entry"), count(2, "entry"), count(2, "hypothesis")) == ("1 entry", "2 entries", "2 hypotheses")
    assert (count(2, "stored image"), count(1, "earlier event")) == ("2 stored images", "1 earlier event")
    assert (plural(1, "is"), plural(2, "is"), plural(1, "has"), plural(4, "has"), plural(2, "was")) == ("is", "are", "has", "have", "were")
    assert (listed(["a"]), listed(["a", "b"]), listed(["a", "b", "c"]), listed([])) == ("a", "a and b", "a, b and c", "")


async def test_one_panorama_reads_as_one(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient())
    async with browser(ws) as http:
        set_id = await upload_set(http, {"Urban/a.jpg": pano_bytes(1)})
        launched = await http.post(
            "/api/runs", json={"preset": "autonomous", "set_id": set_id, "confirm_no_key": True}, headers=key()
        )
        run_id = launched.json()["run_id"]
        await finished(ws, run_id)
        body = (await http.get(f"/api/runs/{run_id}/validation")).json()
        checks = {check["id"]: check for check in body["checks"]}
        assert body["ok"] is True and checks["all_final"]["detail"] == "The 1 panorama is final."
        no_dashes(body)
        digests = (await http.get(f"/api/runs/{run_id}/pano/a/events")).json()["events"]
        lines = [line["text"] for digest in digests for line in digest["lines"]]
        assert any(line.startswith("1 hypothesis; top 80% Baixa") for line in lines)
        assert any("turn 1 request: 1 message, " in line for line in lines), lines
        assert any(line.startswith("end: submitted, 2 turns, ") for line in lines)
        assert not [line for line in lines if " 1 turns" in line or " 1 messages" in line or " 1 images" in line]
        no_dashes(digests)
        no_dashes((await http.get(f"/api/runs/{run_id}")).json())


def test_an_unfinished_single_panorama_and_several_are_told_apart() -> None:
    def tile(pid: str, status: str) -> dict[str, Any]:
        return {"panorama_id": pid, "status": status, "origin": None}

    def all_final(tiles: list[dict[str, Any]], **run: Any) -> dict[str, Any]:
        state = {"run_id": "r", "owned": True, "panoramas": tiles, **run}
        return validate_run(Path("/nonexistent/run"), state)["checks"][0]

    one = all_final([tile("a", "running")])
    assert one["detail"].startswith("1 of 1 panorama is not finished.") and one["action"] == "finalize_all"
    some = all_final([tile("a", "running"), tile("b", "pending"), tile("c", "done")])
    assert some["detail"].startswith("2 of 3 panoramas are not finished.")
    lone = all_final([tile("a", "interrupted")], owned=False, state="interrupted")
    assert "while it was running" in lone["detail"] and "finishes it from its last" in lone["detail"]
    many = all_final([tile("a", "interrupted"), tile("b", "interrupted")], owned=False, state="interrupted")
    assert "while they were running" in many["detail"]


async def test_no_page_of_settings_or_launch_text_carries_a_dash(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient())
    async with browser(ws) as http:
        set_id = await upload_set(http, {"a.jpg": pano_bytes(1), "b.jpg": pano_bytes(2)})
        for response in (
            await http.get("/api/launch/context"),
            await http.get("/api/settings"),
            await http.post(f"/api/sets/{set_id}/preflight", json={"preset": "scoring"}),
            await http.post("/api/eval/runs/estimate", json={}),
            await http.post("/api/runs", json={"preset": "scoring", "set_id": set_id}, headers=key()),
            await http.post("/api/runs", json={"preset": "nonsense"}, headers=key()),
            await http.get("/api/runs/none/validation"),
            await http.put("/api/settings", json={"defaults": {"max_mcq": 99, "nonsense": 1}}),
        ):
            no_dashes(response.json())
        verdict = (
            await http.post(f"/api/sets/{set_id}/preflight", json={"apply_label_to_unlabelled": "Urban"})
        ).json()
        assert any("applied to 2 panoramas that had no label of their own" in text for text in verdict["warnings"])


async def test_the_eval_estimate_counts_one_unlabelled_panorama_in_the_singular(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient())
    ws.eval_data_dir.mkdir(parents=True)
    entries = []
    for n, label in enumerate(("Urban", build_set.TODO_LABEL)):
        (ws.eval_data_dir / f"eval_{n}.jpg").write_bytes(pano_bytes(n))
        entries.append(
            {
                "panorama_id": f"eval_{n}",
                "filename": f"eval_{n}.jpg",
                "label": label,
                "label_confirmed": label != build_set.TODO_LABEL,
                "lat": LISBON[0],
                "lng": LISBON[1],
                "mapillary_id": str(1000 + n),
                "sequence_id": f"seq{n}",
            }
        )
    build_set.save_manifest(ws.eval_data_dir / build_set.MANIFEST_NAME, entries)
    async with browser(ws) as http:
        estimate = (await http.post("/api/eval/runs/estimate", json={})).json()
        assert estimate["blocking"] == ["1 panorama still has no Urban / non-Urban label. Label it first."]
        refused = await http.post("/api/eval/runs", json={"confirm_no_key": True}, headers=key())
        assert refusal(refused) == (409, "todo_labels")
        assert refused.json()["detail"]["message"].startswith("1 evaluation panorama still has no Urban / non-Urban label")


# --- 3. RunState: stopped, and what an eval run was launched with ---------------------------------


async def test_a_stopped_run_says_so_to_every_tab_and_after_a_restart(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient())
    async with browser(ws) as http:
        set_id = await upload_set(http, {"Urban/a.jpg": pano_bytes(1)})
        more = await upload_set(http, {"Urban/b.jpg": pano_bytes(2)})
        launched = await http.post(
            "/api/runs", json={"preset": "autonomous", "set_id": set_id, "confirm_no_key": True}, headers=key()
        )
        run_id = launched.json()["run_id"]
        await finished(ws, run_id)
        state = (await http.get(f"/api/runs/{run_id}")).json()
        assert state["stopped"] is False and state["eval"] is None
        assert (await http.get("/api/snapshot")).json()["runs"][0]["stopped"] is False
        row = next(row for row in (await http.get("/api/runs")).json()["runs"] if row["run_id"] == run_id)
        assert row["stopped"] is False

        _, queue = ws.subscribe()
        stopped = await http.post(f"/api/runs/{run_id}/stop", headers=key())
        assert stopped.status_code == 200 and stopped.json()["run"]["stopped"] is True
        await asyncio.sleep(0.05)
        told = [message["run"]["stopped"] for message in drain(queue) if message["kind"] == "run" and message.get("run")]
        assert told and told[-1] is True  # every panorama was already final: the tabs still hear of it
        assert (await http.get(f"/api/runs/{run_id}")).json()["stopped"] is True
        # so the page can refuse Add panoramas before the operator fills the form; the server still does
        added = await http.post(f"/api/runs/{run_id}/panoramas", json={"set_id": more}, headers=key())
        assert refusal(added) == (409, "run_stopped")

    # a restarted server reads it from run.json
    again = workspace(tmp_path, ScriptClient())
    disk = await again.get_run(run_id)
    assert disk["owned"] is False and disk["stopped"] is True
    # and a new launch under the same id is a run that is open again
    relaunched = await again.launch({"preset": "autonomous", "set_id": set_id, "run_id": run_id, "confirm_no_key": True})
    assert (await again.get_run(relaunched["run_id"]))["stopped"] is False
    await finished(again, run_id)


def write_eval_set(ws: Workspace, n: int = 3) -> None:
    ws.eval_data_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for index in range(n):
        (ws.eval_data_dir / f"eval_{index}.jpg").write_bytes(pano_bytes(index))
        entries.append(
            {
                "panorama_id": f"eval_{index}",
                "filename": f"eval_{index}.jpg",
                "label": "Urban",
                "label_confirmed": True,
                "lat": LISBON[0],
                "lng": LISBON[1],
                "mapillary_id": str(1000 + index),
                "sequence_id": f"seq{index}",
            }
        )
    build_set.save_manifest(ws.eval_data_dir / build_set.MANIFEST_NAME, entries)


async def test_an_eval_run_carries_the_form_that_launched_it_and_one_results_request_is_enough(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient())
    write_eval_set(ws)
    form = {"effort": "low", "hedge": False, "web": False, "tools_off": ["sun_position"], "limit": 2, "concurrency": 1}
    async with browser(ws) as http:
        launched = await http.post("/api/eval/runs", json={**form, "run_id": "evalrun", "confirm_no_key": True}, headers=key())
        assert launched.status_code == 201, launched.text
        await finished(ws, "evalrun")

        # 3. the facts of the launch, in the words of the form: posting them again repeats the run
        state = (await http.get("/api/runs/evalrun")).json()
        assert state["kind"] == "eval" and state["eval"] == {**form, "panoramas": 2}
        row = next(row for row in (await http.get("/api/runs")).json()["runs"] if row["run_id"] == "evalrun")
        assert row["eval"] == state["eval"]
        duplicate = {key_: value for key_, value in state["eval"].items() if key_ != "panoramas"}
        estimate = (await http.post("/api/eval/runs/estimate", json=duplicate)).json()
        assert estimate["panoramas"] == 2 and estimate["blocking"] == []
        whole = await http.post("/api/eval/runs", json={"run_id": "whole", "confirm_no_key": True}, headers=key())
        assert whole.status_code == 201
        await finished(ws, "whole")
        assert (await http.get("/api/runs/whole")).json()["eval"]["limit"] is None  # the whole set, not "3"

        # 7. a variant's answer carries the original's summary beside it
        plain = (await http.get("/api/runs/evalrun/results")).json()
        assert plain["original"] == {"summary": plain["results"]["summary"], "config": plain["config"]}
        rescored = await http.post("/api/runs/evalrun/rescore", json={"hedge": True, "duplicates": True}, headers=key())
        assert rescored.status_code == 200, rescored.text
        tag = rescored.json()["tag"]
        variant = (await http.get("/api/runs/evalrun/results", params={"tag": tag})).json()
        assert variant["tag"] == tag and variant["results"]["config"]["mode"] == "rescore"
        assert variant["original"]["summary"] == plain["results"]["summary"]
        assert variant["original"]["config"] == plain["config"] == variant["config"]
        assert variant["original"]["summary"]["all"]["n"] == 2 and "panoramas" not in variant["original"]
        assert [item["tag"] for item in variant["variants"]] == [tag]
        assert run_eval.MAX_PANORAMA_SCORE > 0  # (the scores themselves are test_console_eval's subject)

    # a CLI evaluation run left no record of its launch: nothing is made up for it
    disk = tmp_path / "runs" / "clieval"
    disk.mkdir(parents=True)
    (disk / "results.json").write_text(json.dumps({"config": {"mode": "run"}, "summary": {"all": {"n": 0}}}))
    assert (await ws.get_run("clieval"))["kind"] == "eval" and (await ws.get_run("clieval"))["eval"] is None


# --- 4. a saved setting reaches the other tabs ------------------------------------------------------


async def test_saving_settings_tells_the_stream(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    async with browser(ws) as http:
        snapshot, queue = ws.subscribe()
        saved = await http.put("/api/settings", json={"defaults": {"team": "albatross", "max_mcq": 2}})
        assert saved.status_code == 200 and saved.json()["defaults"]["team"] == "albatross"
        await asyncio.sleep(0.02)
        messages = drain(queue)
        assert [message["kind"] for message in messages] == ["health"]
        assert messages[0]["seq"] == snapshot["seq"] + 1 and messages[0]["health"] == ws.chips()

        answered = await http.put("/api/settings", json={"organiser_answers": [{"id": "Q3", "note": "asked on Sunday"}]})
        assert answered.status_code == 200
        await asyncio.sleep(0.02)
        assert [message["kind"] for message in drain(queue)] == ["health"]

        refused = await http.put("/api/settings", json={"defaults": {"max_mcq": 99}})
        assert refused.status_code == 422
        await asyncio.sleep(0.02)
        assert drain(queue) == []  # nothing was saved, so there is nothing to read again


# --- 5. health --------------------------------------------------------------------------------------

KEYED_HOSTS = {"api.openai.com", "maps.googleapis.com", "graph.mapillary.com"}


def provider(monkeypatch: pytest.MonkeyPatch, handler: Any) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    async def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        answer = handler(request)
        return await answer if asyncio.iscoroutine(answer) else answer

    monkeypatch.setattr(
        health,
        "make_probe_client",
        lambda settings: httpx.AsyncClient(transport=httpx.MockTransport(handle), follow_redirects=True),
    )
    return seen


def up(request: httpx.Request) -> httpx.Response:
    host = request.url.host
    if host == "maps.googleapis.com":
        return httpx.Response(200, json={"status": "OK"})
    if host == "api.openai.com":
        return httpx.Response(200 if "authorization" in request.headers else 401, json={"id": "gpt-6.1-sol"})
    if host == "graph.mapillary.com":
        return httpx.Response(200 if "authorization" in request.headers else 400, json={"data": []})
    return httpx.Response(200, json={"status": 0})


def carries_a_key(request: httpx.Request) -> bool:
    sent = str(request.url) + json.dumps(dict(request.headers))
    return any(value in sent for value in SECRETS.values()) or "authorization" in request.headers


async def test_health_under_the_demo_model_contacts_no_provider_that_takes_a_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)  # keys are there, as on the operator's own laptop
    seen = provider(monkeypatch, up)
    ws = workspace(tmp_path, fake_model=True)
    async with browser(ws) as http:
        got = await http.get("/api/health")
        body = got.json()
    assert got.status_code == 200 and not any(value in got.text for value in SECRETS.values())
    rows = {row["name"]: row for row in body["services"]}
    for name in ("OpenAI", "Google", "Mapillary"):
        assert rows[name] == {
            "name": name,
            "url": rows[name]["url"],
            "ok": None,
            "latency_ms": None,
            "detail": "not checked: demo model",
            "checked": False,
        }
    public = [name for name in rows if name not in ("OpenAI", "Google", "Mapillary")]
    assert len(public) == 5 and all(rows[name]["ok"] is True and rows[name]["checked"] is True for name in public)
    assert len(seen) == 5 and not {request.url.host for request in seen} & KEYED_HOSTS
    assert not any(carries_a_key(request) for request in seen)
    # nothing was learnt about the key; the internet is there
    assert ws.chips()["openai"] == {"present": True, "ok": None} and ws.chips()["internet"] == {"ok": True}
    no_dashes(body)


async def test_health_sends_each_key_to_its_own_provider_and_nowhere_else(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("OPENAI_ORG_ID", "org-albatross")

    def with_redirects(request: httpx.Request) -> httpx.Response:
        # every provider tries to send the caller on to another host, which a probe must not follow
        if request.url.host in KEYED_HOSTS:
            return httpx.Response(307, headers={"Location": f"https://elsewhere.example{request.url.raw_path.decode()}"})
        return up(request)

    seen = provider(monkeypatch, with_redirects)
    ws = workspace(tmp_path)
    async with browser(ws) as http:
        body = (await http.get("/api/health")).json()
    assert "elsewhere.example" not in {request.url.host for request in seen}  # no key followed a redirect
    for request in seen:
        if request.url.host not in KEYED_HOSTS:
            assert not carries_a_key(request) and "openai-organization" not in request.headers, request.url
    by_host = {request.url.host: request for request in seen}
    assert by_host["api.openai.com"].headers["authorization"] == f"Bearer {SECRETS['OPENAI_API_KEY']}"
    assert SECRETS["GOOGLE_MAPS_API_KEY"] not in json.dumps(dict(by_host["api.openai.com"].headers))
    assert by_host["maps.googleapis.com"].url.params["key"] == SECRETS["GOOGLE_MAPS_API_KEY"]
    assert "authorization" not in by_host["maps.googleapis.com"].headers
    assert by_host["graph.mapillary.com"].headers["authorization"] == f"OAuth {SECRETS['MAPILLARY_TOKEN']}"
    assert not any(value in json.dumps(body) for value in SECRETS.values())
    assert {row["name"] for row in body["services"] if row["ok"] is False} == {"OpenAI", "Google", "Mapillary"}

    # a base URL that is not OpenAI's own (a gateway, or a mistake) is asked without the key
    monkeypatch.setenv("OPENAI_BASE_URL", "https://gateway.example/v1")
    seen = provider(monkeypatch, up)
    async with browser(ws) as http:
        rows = {row["name"]: row for row in (await http.get("/api/health?refresh=1")).json()["services"]}
    gateway = next(request for request in seen if request.url.host == "gateway.example")
    assert not carries_a_key(gateway) and "openai-organization" not in gateway.headers
    assert rows["OpenAI"]["ok"] is None and "The key was not sent" in rows["OpenAI"]["detail"]
    assert ws.chips()["openai"]["ok"] is not True  # nothing was learnt about the key, so nothing turns green
    assert health.key_may_go_to("OPENAI_API_KEY", "https://api.openai.com/v1")
    assert not health.key_may_go_to("OPENAI_API_KEY", "http://api.openai.com/v1")  # never in the clear
    assert not health.key_may_go_to("OPENAI_API_KEY", "https://api.openai.com.evil.example/v1")
    assert not health.key_may_go_to("GOOGLE_MAPS_API_KEY", "https://api.openai.com/v1")


async def test_health_is_one_round_of_probes_however_many_tabs_load_at_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release = asyncio.Event()

    async def slow(request: httpx.Request) -> httpx.Response:
        await release.wait()
        return up(request)

    seen = provider(monkeypatch, slow)
    ws = workspace(tmp_path)
    async with browser(ws) as http:
        tabs = [asyncio.ensure_future(http.get("/api/health")) for _ in range(6)]
        tabs.append(asyncio.ensure_future(http.get("/api/health?refresh=1")))  # joins the round in flight
        await until(lambda: len(seen) == 8)
        await asyncio.sleep(0.05)
        assert len(seen) == 8  # eight services, asked once
        release.set()
        answers = [(await tab).json() for tab in tabs]
        assert len({answer["checked_at"] for answer in answers}) == 1 and len(seen) == 8
        assert {request.method for request in seen} == {"GET"}  # a look costs nothing: no model request
        assert not any(request.url.path.endswith("/responses") for request in seen)
        # a page load a moment later reuses the answer; only the button asks again
        assert (await http.get("/api/health")).json()["checked_at"] == answers[0]["checked_at"] and len(seen) == 8
        assert (await http.get("/api/health?refresh=1")).status_code == 200 and len(seen) == 16


# --- 6. rehearsal on the demo model ---------------------------------------------------------------


async def test_the_scoring_hour_and_the_stage_can_be_rehearsed_on_the_demo_model(tmp_path: Path) -> None:
    ws = workspace(tmp_path, fake_model=True)
    async with browser(ws) as http:
        context = (await http.get("/api/launch/context")).json()
        assert context["fake_model"] is True and context["rehearsal_kind"] == "training"
        assert context["presets"]["scoring"]["kind"] == "scoring"  # what the preset is on a real model
        set_id = await upload_set(http, {"Urban/a.jpg": pano_bytes(1), "non-Urban/b.jpg": pano_bytes(2)})

        # the scoring preset: human channels on, the 60-minute guide, but never a scoring run
        missing = await http.post("/api/runs", json={"preset": "scoring", "set_id": set_id}, headers=key())
        assert refusal(missing) == (422, "preflight_blocked")  # the preset's own rules still hold
        launched = await http.post("/api/runs", json={"preset": "scoring", "set_id": set_id, "special": "a"}, headers=key())
        assert launched.status_code == 201, launched.text
        run_id = launched.json()["run_id"]
        assert launched.json()["url"] == f"/runs/{run_id}"
        state = (await http.get(f"/api/runs/{run_id}")).json()
        assert (state["kind"], state["preset"], state["mode"], state["fake_model"]) == ("training", "scoring", "assisted", True)
        assert [phase["key"] for phase in state["phases"]] == ["launch", "autonomous", "special", "others", "freeze", "submit"]
        assert state["model"] == MODEL_NAME and state["no_human"] is False and state["special_present"] is True
        meta = json.loads((ws.runs_dir / run_id / "run.json").read_text())
        assert (meta["kind"], meta["preset"], meta["fake_model"], meta["settings"]["model"]) == ("training", "scoring", True, MODEL_NAME)

        # the question the scripted model asks can be answered: the three channels are the real ones
        await until(lambda: ws.tile(run_id, "a")["pending_mcq"] is not None)
        question = ws.tile(run_id, "a")["pending_mcq"]
        answered = await http.post(f"/api/runs/{run_id}/pano/a/mcq/{question['id']}/answer", json={"index": 0}, headers=key())
        assert answered.status_code == 200 and answered.json()["tile"]["penalty"]["mcqs"] == 1
        stopped = await http.post(f"/api/runs/{run_id}/stop", headers=key())
        assert stopped.status_code == 200 and stopped.json()["run"]["state"] in {"finished", "invalid"}

        # the checklist fails on the model, and the zip asks first
        body = (await http.get(f"/api/runs/{run_id}/validation")).json()
        checks = {check["id"]: check for check in body["checks"]}
        assert body["ok"] is False and body["fake_model"] is True and checks["real_model"]["status"] == "fail"
        assert all(check["status"] != "fail" for name, check in checks.items() if name != "real_model"), checks
        assert refusal(await http.get(f"/api/runs/{run_id}/download")) == (409, "fake_model")
        taken = await http.get(f"/api/runs/{run_id}/download", params={"fake_ok": 1})
        assert taken.status_code == 200
        assert sorted(zipfile.ZipFile(io.BytesIO(taken.content)).namelist()) == ["a.json", "answers.csv", "b.json", "summary.csv"]
        # a rehearsal can be thrown away, which a scoring run never can
        assert (await http.request("DELETE", f"/api/runs/{run_id}", json={"confirm": run_id})).status_code == 200

        # the live preset: one panorama on the live budget, opening on the stage
        live = await http.post("/api/runs", json={"preset": "live", "set_id": set_id}, headers=key())
        assert live.status_code == 201, live.text
        live_id = live.json()["run_id"]
        assert live.json()["url"] == f"/runs/{live_id}/stage"
        await finished(ws, live_id)
        state = (await http.get(f"/api/runs/{live_id}")).json()
        assert (state["kind"], state["preset"], state["live_budget"], state["fake_model"]) == ("training", "live", True, True)
        assert state["mode"] == "autonomous" and state["phases"] is None
        assert {tile["budget"]["hard_deadline_s"] for tile in state["panoramas"]} == {LIVE.hard_deadline_s}
        assert all(tile["final"] and tile["origin"] == "agent" for tile in state["panoramas"])
        # reveal truth works on a rehearsal as it will on the day
        shown = await http.put(f"/api/runs/{live_id}/stage_truth", json={"panorama_id": "a", "lat": 38.7, "lng": -9.1})
        assert shown.status_code == 200 and shown.json()["distance_m"] > 0
        assert refusal(await http.get(f"/api/runs/{live_id}/download")) == (409, "fake_model")

        # a custom run that asks to be a scoring run is a rehearsal too
        custom = await http.post("/api/runs", json={"preset": "custom", "kind": "scoring", "set_id": set_id}, headers=key())
        assert custom.status_code == 201
        custom_state = (await http.get(f"/api/runs/{custom.json()['run_id']}")).json()
        assert (custom_state["kind"], custom_state["preset"], custom_state["phases"]) == ("training", "custom", None)
        await http.post(f"/api/runs/{custom.json()['run_id']}/stop", headers=key())
        # demo runs never feed the cost estimates of real ones
        assert (await http.get("/api/launch/context")).json()["estimates"] == {}


async def test_a_real_model_still_makes_real_scoring_and_live_runs(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient())
    async with browser(ws) as http:
        set_id = await upload_set(http, {"Urban/a.jpg": pano_bytes(1), "non-Urban/b.jpg": pano_bytes(2)})
        spec = {"set_id": set_id, "confirm_no_key": True}
        assert (await http.get("/api/launch/context")).json()["rehearsal_kind"] is None
        scoring = await http.post("/api/runs", json={**spec, "preset": "scoring", "special": "a"}, headers=key())
        live = await http.post("/api/runs", json={**spec, "preset": "live"}, headers=key())
        for response, kind in ((scoring, "scoring"), (live, "live")):
            assert response.status_code == 201, response.text
            run_id = response.json()["run_id"]
            await finished(ws, run_id)
            state = (await http.get(f"/api/runs/{run_id}")).json()
            assert (state["kind"], state["preset"], state["fake_model"]) == (kind, kind, False)
        scoring_id = scoring.json()["run_id"]
        refused = await http.request("DELETE", f"/api/runs/{scoring_id}", json={"confirm": scoring_id})
        assert refusal(refused) == (409, "scoring_run")


# --- whole events are redacted like their digests ---------------------------------------------------


async def test_a_whole_event_shown_on_the_page_carries_no_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    google = SECRETS["GOOGLE_MAPS_API_KEY"]
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", google)
    ws = workspace(tmp_path)
    run_dir = ws.runs_dir / "old"
    run_dir.mkdir(parents=True)
    failed = f"GET https://maps.googleapis.com/maps/api/streetview/metadata?location=1,2&key={google} failed"
    events = [
        {"seq": 1, "ts": "2026-10-10T10:00:00.000Z", "t_rel_s": 0.0, "actor": "harness", "type": "run_start", "data": {}},
        {
            "seq": 2,
            "ts": "2026-10-10T10:00:01.000Z",
            "t_rel_s": 1.0,
            "actor": "tool",
            "type": "tool_result",
            "data": {"tool": "streetview_lookup", "is_error": True, "output": failed, "headers": ["Authorization: Bearer sk-abcdef123456"]},
        },
    ]
    (run_dir / "a.events.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
    async with browser(ws) as http:
        one = await http.get("/api/runs/old/pano/a/events", params={"seq": 2, "full": 1})
        whole = await http.get("/api/runs/old/pano/a/events", params={"after": 0, "full": 1})
        digests = await http.get("/api/runs/old/pano/a/events", params={"after": 0})
    for response in (one, whole, digests):
        assert response.status_code == 200 and google not in response.text and "sk-abcdef123456" not in response.text
    envelope = one.json()["events"][0]
    assert envelope["seq"] == 2 and envelope["type"] == "tool_result" and "location=1,2" in envelope["data"]["output"]
    assert [event["seq"] for event in whole.json()["events"]] == [1, 2]
    assert google in (run_dir / "a.events.jsonl").read_text()  # the log itself, the record, is not rewritten
