"""Submission: the checklist of UI-SPEC 5.8, the zip and its files one by one. Offline: a scripted
model, tmp_path only, the router on a bare app."""

from __future__ import annotations

import asyncio
import io
import json
import zipfile
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from PIL import Image

from astrolabio.config import Budget, Settings
from astrolabio.eventlog import validate_export
from astrolabio.runner import SUMMARY_COLUMNS
from server.devmodel import MODEL_NAME
from server.routes.submission import router
from server.runstate import read_events
from server.validation import allowed_files, submission_file
from server.workspace import Workspace

HYP = {"lat": 38.7223, "lng": -9.1393, "probability": 0.8, "radius_m": 40.0, "label": "Baixa", "evidence": "tram"}
FAST = Budget(effort="high", soft_deadline_s=600, hard_deadline_s=840, max_turns=6, max_spend_usd=8.0)
HOLD = object()  # in a script: a model call that stays in flight until the test releases it
CUE = "the kerb stones are painted yellow"
CHECK_IDS = ["all_final", "ten_entries", "exports_valid", "ledger", "files_fresh", "no_fallback"]


def pano_bytes(seed: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (256, 128), (40 + 20 * seed, 120, 160)).save(out, "JPEG")
    return out.getvalue()


def reply(name: str, **arguments: Any) -> SimpleNamespace:
    block = {"type": "tool_use", "id": f"call_{name}", "name": name, "input": arguments}
    usage = {"input_tokens": 1000, "cached_input_tokens": 0, "cache_write_tokens": 0, "output_tokens": 100}
    return SimpleNamespace(
        id="resp", model="gpt-6.1-sol", content=[block], stop_reason="tool_use", stop_details=None, usage=usage
    )


def update() -> SimpleNamespace:
    return reply("update_candidates", hypotheses=[HYP])


def submit() -> SimpleNamespace:
    return reply("submit_locations", hypotheses=[HYP], reasoning_summary="ok")


class ScriptClient:
    """One script per panorama id ("" stands for every other panorama); the last item repeats."""

    def __init__(self, **scripts: Any) -> None:
        self.scripts = {"": [update(), submit()], **scripts}
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def create(self, **params: Any) -> Any:
        panorama_id = params["prompt_cache_key"].rsplit("-", 1)[-1]
        script = self.scripts[panorama_id if panorama_id in self.scripts else ""]
        turn = 1 + sum(1 for message in params["messages"] if message["role"] == "assistant")
        item = script[min(turn, len(script)) - 1]
        if item is HOLD:
            self.started.set()
            await self.release.wait()
            return submit()
        await asyncio.sleep(0)
        return item


def workspace(tmp_path: Path, client: Any = None, *, fake_model: bool = False) -> Workspace:
    base = Settings(
        runs_dir=tmp_path / "runs",
        cache_dir=tmp_path / "cache",
        allow_web=False,
        standard=FAST,
        special=FAST,
        live=FAST,
        team="albatross",
    )
    return Workspace(
        base,
        data_dir=tmp_path / "data",
        eval_data_dir=tmp_path / "eval",
        client_factory=(lambda settings: client) if client is not None else None,
        env_path=tmp_path / ".env",
        fake_model=fake_model,
    )


async def launch(ws: Workspace, *paths: str, **spec: Any) -> str:
    set_id = ws.sets.create("test set")["set_id"]
    for index, path in enumerate(paths):
        ws.sets.add_file(set_id, path, pano_bytes(index))
    spec = {"preset": "custom", "set_id": set_id, "confirm_no_key": True, "settings": {"no_human": True}, **spec}
    return (await ws.launch(spec))["run_id"]


async def finished(ws: Workspace, run_id: str) -> None:
    handle = ws.owned(run_id)

    async def poll() -> None:
        while not (handle.idle and handle.task is not None):
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), 30)


async def finished_run(tmp_path: Path, *paths: str, **spec: Any) -> tuple[Workspace, str, Path]:
    """A run that ended by itself and was exported; the workspace still holds it."""
    ws = workspace(tmp_path, ScriptClient())
    run_id = await launch(ws, *paths, **spec)
    await finished(ws, run_id)
    return ws, run_id, ws.runs_dir / run_id


async def get(ws: Workspace, url: str) -> httpx.Response:
    app = FastAPI()
    app.state.workspace = ws
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://console") as client:
        return await client.get(url)


async def checklist(ws: Workspace, run_id: str) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    response = await get(ws, f"/api/runs/{run_id}/validation")
    assert response.status_code == 200, response.text
    body = response.json()
    return body, {check["id"]: check for check in body["checks"]}


def failing(checks: dict[str, dict[str, Any]]) -> list[str]:
    return [check_id for check_id, check in checks.items() if check["status"] == "fail"]


def items(check: dict[str, Any]) -> dict[str, str]:
    return {item["panorama_id"]: item["text"] for item in check["items"]}


def unzip(response: httpx.Response) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def rewrite_export(path: Path, change: Callable[[dict[str, Any]], None]) -> None:
    doc = json.loads(path.read_text())
    change(doc)
    path.write_text(json.dumps(doc))


def append_event(run_dir: Path, pid: str, type_: str, actor: str = "harness") -> None:
    """One more event at the end of a log, as a control used after the run ended leaves it."""
    path = run_dir / f"{pid}.events.jsonl"
    last = read_events(path)[-1]
    with path.open("a") as fh:
        fh.write(json.dumps({**last, "seq": last["seq"] + 1, "actor": actor, "type": type_, "data": {}}) + "\n")


def cut_log(run_dir: Path, pid: str, after: str) -> None:
    """The log as kill -9 leaves it: nothing after the first `after` event but half a line."""
    path = run_dir / f"{pid}.events.jsonl"
    lines = path.read_text().splitlines()
    cut = next(i for i, line in enumerate(lines) if json.loads(line)["type"] == after)
    path.write_text("\n".join(lines[: cut + 1]) + '\n{"schema_version": "1.0", "seq": 999, "ty')


def directory(run_dir: Path) -> dict[str, bytes]:
    return {path.name: path.read_bytes() for path in run_dir.iterdir() if path.is_file()}


# --- the checklist passing, and what is downloaded --------------------------------------------


async def test_a_finished_run_passes_every_check_and_the_zip_holds_ten_rows_per_panorama(tmp_path: Path) -> None:
    ws, run_id, run_dir = await finished_run(tmp_path, "Urban/a.jpg", "Urban/b.jpg", "non-Urban/c.jpg", special="b")
    await ws.set_meta(run_id, {"submitted_at": "2026-10-11T10:58:00+00:00"})
    before = directory(run_dir)

    body, checks = await checklist(ws, run_id)

    assert list(checks) == CHECK_IDS and body["ok"] is True and failing(checks) == []
    for check in checks.values():
        assert check["status"] == "pass" and check["items"] == [] and check["action"] is None
    assert all(check["label"] and check["detail"] for check in checks.values())
    assert (body["submitted_at"], body["interrupted"], body["fake_model"]) == ("2026-10-11T10:58:00.000Z", False, False)
    assert len(body["answers"]) == 30
    for pid in ("a", "b", "c"):
        rows = [row for row in body["answers"] if row["panorama_id"] == pid]
        assert [row["rank"] for row in rows] == list(range(1, 11))
        assert all(isinstance(row["lat"], float) and isinstance(row["lng"], float) for row in rows)
    summary = {row["panorama"]: row for row in body["summary"]}
    assert set(summary) == {"a", "b", "c"} and all(list(row) == list(SUMMARY_COLUMNS) for row in summary.values())
    for row in summary.values():
        assert row["problems"] == "" and row["origin"] == "agent" and row["multiplier"] == 1.0
    assert [summary[pid]["special"] for pid in ("a", "b", "c")] == [False, True, False]
    assert summary["a"]["lat"] == body["answers"][0]["lat"] and isinstance(summary["a"]["turns"], int)
    files = {entry["name"]: entry for entry in body["files"]}
    assert sorted(files) == ["a.json", "answers.csv", "b.json", "c.json", "summary.csv"]
    for name, entry in files.items():
        assert Path(entry["path"]) == (run_dir / name).resolve() and entry["size_bytes"] == len(before[name])
        assert entry["modified_at"].endswith("Z")

    response = await get(ws, f"/api/runs/{run_id}/download")

    assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"] == f'attachment; filename="{run_id}_submission.zip"'
    packed = unzip(response)
    # the allow-list and nothing else: no run.json, no lock, no log
    assert sorted(packed) == sorted(files) and all(packed[name] == before[name] for name in packed)
    table = packed["answers.csv"].decode().splitlines()
    assert table[0] == "panorama_id,rank,lat,lng" and len(table) == 31
    assert all(sum(1 for line in table if line.startswith(f"{pid},")) == 10 for pid in ("a", "b", "c"))
    assert all(validate_export(json.loads(packed[f"{pid}.json"])) == [] for pid in ("a", "b", "c"))

    for name in files:
        one = await get(ws, f"/api/runs/{run_id}/files/{name}")
        assert one.status_code == 200 and one.content == before[name]
        assert one.headers["content-disposition"] == f'attachment; filename="{name}"'
        assert one.headers["content-type"].startswith("text/csv" if name.endswith(".csv") else "application/json")
    assert directory(run_dir) == before  # reading and downloading write nothing

    # the same run after a restart, read from its files alone
    again, checks = await checklist(workspace(tmp_path), run_id)
    assert again["ok"] is True and failing(checks) == [] and again["answers"] == body["answers"]
    assert again["submitted_at"] == body["submitted_at"]


async def test_while_panoramas_work_the_checklist_offers_finalize_all_and_a_fallback_only_warns(tmp_path: Path) -> None:
    client = ScriptClient(a=[update(), HOLD])
    ws = workspace(tmp_path, client)
    run_id = await launch(ws, "Urban/a.jpg", "Urban/b.jpg", settings={"no_human": True, "concurrency": 1})
    await asyncio.wait_for(client.started.wait(), 15)  # a is in flight, b is queued behind it

    body, checks = await checklist(ws, run_id)

    assert body["ok"] is False and body["interrupted"] is False and body["answers"] == [] and body["files"] == []
    assert failing(checks) == ["all_final", "ten_entries", "exports_valid", "ledger", "files_fresh"]
    assert items(checks["all_final"]) == {"a": "running", "b": "queued"}
    assert all(checks[check_id]["action"] == "finalize_all" for check_id in failing(checks))
    assert items(checks["exports_valid"]) == {"a": "no export file", "b": "no export file"}
    refused = await get(ws, f"/api/runs/{run_id}/download")
    detail = refused.json()["detail"]
    assert refused.status_code == 409 and (detail["code"], detail["action"]) == ("validation_failed", "force")
    assert detail["checks"] == failing(checks) and len(detail["problems"]) == 5
    forced = await get(ws, f"/api/runs/{run_id}/download?force=1")
    detail = forced.json()["detail"]
    assert forced.status_code == 409 and (detail["code"], detail["action"]) == ("nothing_to_download", "finalize_all")

    await ws.finalize_all(run_id)

    body, checks = await checklist(ws, run_id)
    assert failing(checks) == [] and body["ok"] is True  # a warning is the operator's to accept
    fallback = checks["no_fallback"]
    assert (fallback["status"], fallback["action"], list(items(fallback))) == ("warn", None, ["b"])
    assert items(fallback)["b"].startswith("fallback point:")
    await ws.ack(run_id, "b", "fallback")
    assert "(acknowledged)" in items((await checklist(ws, run_id))[1]["no_fallback"])["b"]
    response = await get(ws, f"/api/runs/{run_id}/download")
    assert response.status_code == 200 and sorted(unzip(response)) == ["a.json", "answers.csv", "b.json", "summary.csv"]


async def test_penalties_of_an_assisted_run_pass_the_ledger_and_a_later_event_makes_the_files_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("server.workspace.EXPORT_DEBOUNCE_S", 60.0)  # the test says when the files follow
    client = ScriptClient(a=[update(), HOLD])
    ws = workspace(tmp_path, client)
    run_id = await launch(ws, "Urban/a.jpg", "Urban/b.jpg", settings={"no_human": False})
    await asyncio.wait_for(client.started.wait(), 15)
    session = ws.session(run_id, "a")
    session.submit_cue(CUE, confirmed=True)
    session.human_geocode(38.7101, -9.1402, "Baixa")
    await ws.settle(run_id, "a")
    await finished(ws, run_id)

    body, checks = await checklist(ws, run_id)

    assert body["ok"] is True and [check["status"] for check in checks.values()] == ["pass"] * 6
    summary = {row["panorama"]: row for row in body["summary"]}
    assert (summary["a"]["multiplier"], summary["a"]["origin"]) == (0.4, "human_geocode")
    assert {(row["lat"], row["lng"]) for row in body["answers"] if row["panorama_id"] == "a"} == {(38.7101, -9.1402)}

    ws.session(run_id, "b").set_mcq_allowed(False)  # logged after the files were written
    body, checks = await checklist(ws, run_id)
    assert failing(checks) == ["files_fresh"] and list(items(checks["files_fresh"])) == ["b"]
    assert checks["files_fresh"]["action"] == "rebuild"  # every panorama is final: nothing left to finalize
    await ws.export_now(run_id)
    assert failing((await checklist(ws, run_id))[1]) == []


# --- each check failing -------------------------------------------------------------------------


async def test_ten_entries_fails_for_a_short_list_and_for_coordinates_that_are_not_clean(tmp_path: Path) -> None:
    _, run_id, run_dir = await finished_run(tmp_path, "Urban/a.jpg", "Urban/b.jpg", "Urban/c.jpg")
    ws = workspace(tmp_path)  # on disk: nothing rewrites the files behind the test
    rewrite_export(run_dir / "a.json", lambda doc: doc["final"]["locations"].pop())
    rewrite_export(run_dir / "b.json", lambda doc: doc["final"]["locations"][2].update(lat=38.12345678, lng=181.0))
    (run_dir / "c.json").write_text("{not json")

    body, checks = await checklist(ws, run_id)

    found = items(checks["ten_entries"])
    assert body["ok"] is False
    assert checks["ten_entries"]["status"] == "fail" and checks["ten_entries"]["action"] == "rebuild"
    assert found["a"] == "9 entries, not 10" and found["c"] == "0 entries, not 10"
    assert "entry 3: lat 38.12345678 has more than 6 decimals" in found["b"]
    assert "entry 3: lng 181.0 is outside +/-180" in found["b"]
    assert set(items(checks["exports_valid"])) == {"a", "b", "c"}
    assert items(checks["exports_valid"])["c"] == "the file is not valid JSON"
    assert checks["all_final"]["status"] == "pass" and checks["ledger"]["status"] == "pass"
    assert set(items(checks["files_fresh"])) == {"a", "b", "c"}  # the tables no longer tell the exports' answer


async def test_exports_valid_lists_what_validate_export_finds_per_panorama(tmp_path: Path) -> None:
    _, run_id, run_dir = await finished_run(tmp_path, "Urban/a.jpg", "Urban/b.jpg")
    ws = workspace(tmp_path)
    rewrite_export(run_dir / "a.json", lambda doc: doc["final"]["locations"][4].update(origin="nobody"))

    body, checks = await checklist(ws, run_id)

    assert failing(checks) == ["exports_valid"] and body["ok"] is False
    assert list(items(checks["exports_valid"])) == ["a"] and "origin 'nobody'" in items(checks["exports_valid"])["a"]
    assert checks["exports_valid"]["action"] == "rebuild"
    assert (await get(ws, f"/api/runs/{run_id}/download")).status_code == 409

    await (await ws.start_export(run_id)).wait()
    assert failing((await checklist(ws, run_id))[1]) == []


async def test_ledger_compares_the_final_penalty_state_with_the_penalised_events(tmp_path: Path) -> None:
    _, run_id, run_dir = await finished_run(tmp_path, "Urban/a.jpg", "Urban/b.jpg", "Urban/c.jpg")
    ws = workspace(tmp_path)

    # an export that says a cue was charged which the log never recorded
    stale = {"cues": 1, "mcqs": 0, "human_geocodes": 0, "multiplier": 0.8}
    rewrite_export(run_dir / "a.json", lambda doc: doc["final"].update(penalty_state=stale))
    _, checks = await checklist(ws, run_id)
    assert checks["ledger"]["status"] == "fail" and checks["ledger"]["action"] == "rebuild"
    assert items(checks["ledger"]) == {"a": "the export carries a penalty state its log has since replaced"}

    # a cue in the log that the final answer does not account for: no rebuild repairs the record
    append_event(run_dir, "b", "human_cue", actor="human")
    _, checks = await checklist(ws, run_id)
    assert items(checks["ledger"])["b"] == "the final state counts 0 cues, the log records 1"
    await (await ws.start_export(run_id)).wait()
    body, checks = await checklist(ws, run_id)
    assert items(checks["ledger"]) == {"b": "the final state counts 0 cues, the log records 1"}
    assert checks["ledger"]["action"] is None and "check it before submitting" in checks["ledger"]["detail"]
    assert body["ok"] is False and "ledger" in failing(checks)

    # an entry stamped with another multiplier than the ledger's
    def restamp(line: str) -> str:
        event = json.loads(line)
        if event["type"] == "final_submission":
            event["data"]["entries"][6]["multiplier"] = 0.5
        return json.dumps(event)

    log = run_dir / "c.events.jsonl"
    log.write_text("\n".join(restamp(line) for line in log.read_text().splitlines()) + "\n")
    _, checks = await checklist(ws, run_id)
    assert items(checks["ledger"])["c"] == "entry 7 is stamped x0.5, the ledger says x1"


async def test_files_match_the_page_compares_each_export_with_its_log_and_asks_for_a_rebuild(tmp_path: Path) -> None:
    _, run_id, run_dir = await finished_run(tmp_path, "Urban/a.jpg", "Urban/b.jpg")
    ws = workspace(tmp_path)
    last = read_events(run_dir / "a.events.jsonl")[-1]["seq"]
    append_event(run_dir, "a", "mcq_toggle")  # a state change after the files were written

    body, checks = await checklist(ws, run_id)

    assert failing(checks) == ["files_fresh"] and body["ok"] is False
    assert items(checks["files_fresh"]) == {"a": f"the export ends at event {last}, its log has reached {last + 1}"}
    assert checks["files_fresh"]["action"] == "rebuild"
    assert checks["files_fresh"]["detail"].endswith("Rebuild the exports.")
    refused = await get(ws, f"/api/runs/{run_id}/download")
    assert refused.status_code == 409 and refused.json()["detail"]["checks"] == ["files_fresh"]
    forced = unzip(await get(ws, f"/api/runs/{run_id}/download?force=1"))
    assert sorted(forced) == ["a.json", "answers.csv", "b.json", "summary.csv"]

    await (await ws.start_export(run_id)).wait()
    assert failing((await checklist(ws, run_id))[1]) == []

    # a table that is gone, and one that tells another answer than the exports
    (run_dir / "summary.csv").unlink()
    answers = run_dir / "answers.csv"
    answers.write_text(answers.read_text().replace("b,1,38.", "b,1,39."))
    body, checks = await checklist(ws, run_id)
    assert failing(checks) == ["files_fresh"] and checks["files_fresh"]["detail"].startswith("summary.csv is missing.")
    assert items(checks["files_fresh"]) == {"b": "answers.csv does not list the points of its export"}
    assert body["summary"] == [] and [entry["name"] for entry in body["files"]] == ["a.json", "b.json", "answers.csv"]


async def test_a_run_of_the_scripted_model_fails_real_model_and_needs_fake_ok_to_download(tmp_path: Path) -> None:
    ws = workspace(tmp_path, ScriptClient(), fake_model=True)
    run_id = await launch(ws, "Urban/a.jpg")
    await finished(ws, run_id)

    body, checks = await checklist(ws, run_id)

    assert list(checks) == [*CHECK_IDS, "real_model"] and failing(checks) == ["real_model"]
    assert body["ok"] is False and body["fake_model"] is True and "demo model" in checks["real_model"]["detail"]
    assert json.loads((ws.runs_dir / run_id / "a.json").read_text())["config"]["model"] == MODEL_NAME
    for query in ("", "?force=1", "?fake_ok=0"):
        refused = await get(ws, f"/api/runs/{run_id}/download{query}")
        detail = refused.json()["detail"]
        assert refused.status_code == 409 and (detail["code"], detail["action"]) == ("fake_model", "fake_ok")
    accepted = await get(ws, f"/api/runs/{run_id}/download?fake_ok=1")
    assert accepted.status_code == 200 and sorted(unzip(accepted)) == ["a.json", "answers.csv", "summary.csv"]

    # the flag is the run's own: a restarted server without the scripted model still refuses
    restarted = workspace(tmp_path)
    assert (await get(restarted, f"/api/runs/{run_id}/download")).json()["detail"]["code"] == "fake_model"
    (ws.runs_dir / run_id / "run.json").unlink()  # and without run.json the logs still name the model
    assert "real_model" in (await checklist(workspace(tmp_path), run_id))[1]


# --- an interrupted run -------------------------------------------------------------------------


async def test_an_interrupted_run_asks_for_a_rebuild_and_passes_after_recovery(tmp_path: Path) -> None:
    _, run_id, run_dir = await finished_run(tmp_path, "Urban/a.jpg", "Urban/b.jpg", "non-Urban/c.jpg")
    cut_log(run_dir, "a", "candidates_update")  # had hypotheses, no answer
    cut_log(run_dir, "b", "run_start")  # had nothing
    cut_log(run_dir, "c", "final_submission")  # had its answer, but no run_end
    for name in ("a.json", "b.json", "c.json", "summary.csv", "answers.csv"):
        (run_dir / name).unlink()
    ws = workspace(tmp_path)  # the restarted server
    before = directory(run_dir)

    body, checks = await checklist(ws, run_id)

    assert body["interrupted"] is True and body["ok"] is False and body["files"] == [] and body["answers"] == []
    assert failing(checks) == ["all_final", "ten_entries", "exports_valid", "ledger", "files_fresh"]
    assert all(checks[check_id]["action"] == "rebuild" for check_id in failing(checks))
    stopped = items(checks["all_final"])
    assert stopped["a"].startswith("interrupted") and stopped["b"].startswith("interrupted")
    assert stopped["c"] == "final, but the server stopped before its log was closed"
    assert "Rebuild exports" in checks["all_final"]["detail"]
    assert items(checks["ledger"]) == {pid: "no final answer in its log to check" for pid in ("a", "b")}
    assert checks["files_fresh"]["detail"].startswith("answers.csv and summary.csv are missing.")
    assert (await get(ws, f"/api/runs/{run_id}/download")).status_code == 409
    assert (await get(ws, f"/api/runs/{run_id}/download?force=1")).json()["detail"]["action"] == "rebuild"
    assert directory(run_dir) == before  # looking finishes nothing: recovery is the export job's

    job = await ws.start_export(run_id)
    await job.wait()

    assert job.state == "done" and job.result["recovered"] == ["a", "b", "c"]
    body, checks = await checklist(ws, run_id)
    assert body["interrupted"] is False and body["ok"] is True and failing(checks) == []
    assert checks["no_fallback"]["status"] == "warn" and list(items(checks["no_fallback"])) == ["b"]
    stops = {row["panorama"]: (row["stop_reason"], row["origin"], row["problems"]) for row in body["summary"]}
    assert stops == {
        "a": ("recovered_from_provisional", "agent", ""),
        "b": ("recovered_no_hypotheses", "harness_fallback", ""),
        "c": ("recovered_final", "agent", ""),
    }
    response = await get(ws, f"/api/runs/{run_id}/download")
    packed = unzip(response)
    assert response.status_code == 200
    assert sorted(packed) == ["a.json", "answers.csv", "b.json", "c.json", "summary.csv"]
    assert len(packed["answers.csv"].decode().splitlines()) == 31
    assert all(validate_export(json.loads(packed[f"{pid}.json"])) == [] for pid in ("a", "b", "c"))


# --- nothing but the allow-list -----------------------------------------------------------------


NOT_SERVED = [
    "run.json",
    "run.lock",
    "a.events.jsonl",
    "results.json",
    "A.JSON",
    "nobody.json",
    "..",
    "%2e%2e",
    "..%2frun.json",
    "%2e%2e%2f%2e%2e%2f%2e%2e%2fdata%2fconsole.json",
    "a.json%2f..%2frun.json",
    "%2fetc%2fpasswd",
    "a.json%00",
    "answers.csv%00.json",
]


async def test_only_the_runs_own_submission_files_are_served(tmp_path: Path) -> None:
    ws, run_id, run_dir = await finished_run(tmp_path, "Urban/a.jpg")
    (run_dir / "run.lock").write_text("{}")
    (run_dir / "results.json").write_text("{}")

    for name in NOT_SERVED:
        response = await get(ws, f"/api/runs/{run_id}/files/{name}")
        assert response.status_code == 404, name
        assert b"run_id" not in response.content, name  # nothing of run.json came back


async def test_a_link_under_an_allowed_name_is_not_followed(tmp_path: Path) -> None:
    _, run_id, run_dir = await finished_run(tmp_path, "Urban/a.jpg", "Urban/b.jpg")
    ws = workspace(tmp_path)
    secret = tmp_path / "secret.json"
    secret.write_text('{"key": "sk-not-a-run-file"}')
    (run_dir / "a.json").unlink()
    (run_dir / "a.json").symlink_to(secret)  # leaves the run directory
    (run_dir / "b.json").unlink()
    (run_dir / "b.json").symlink_to(run_dir / "run.json")  # stays inside it, and is still not an export

    for name in ("a.json", "b.json"):
        response = await get(ws, f"/api/runs/{run_id}/files/{name}")
        assert response.status_code == 403 and response.json()["detail"]["code"] == "not_a_run_file"
    body, checks = await checklist(ws, run_id)
    assert items(checks["exports_valid"]) == {"a": "no export file", "b": "no export file"}
    assert [entry["name"] for entry in body["files"]] == ["answers.csv", "summary.csv"]
    packed = unzip(await get(ws, f"/api/runs/{run_id}/download?force=1"))
    assert sorted(packed) == ["answers.csv", "summary.csv"] and b"sk-not-a-run-file" not in b"".join(packed.values())


async def test_unknown_and_unsafe_run_ids_are_refused(tmp_path: Path) -> None:
    ws, run_id, run_dir = await finished_run(tmp_path, "Urban/a.jpg")
    (ws.runs_dir.parent / "answers.csv").write_text("panorama_id,rank,lat,lng\n")  # what `..` would reach

    for rest in ("validation", "download", "download?force=1", "files/answers.csv"):
        missing = await get(ws, f"/api/runs/no-such-run/{rest}")
        assert missing.status_code == 404 and missing.json()["detail"]["code"] == "unknown_run"
        for unsafe in ("%2e%2e", ".hidden", "a%20b"):
            response = await get(ws, f"/api/runs/{unsafe}/{rest}")
            assert response.status_code == 400 and response.json()["detail"]["code"] == "invalid_run_id"


def test_the_allow_list_is_the_exports_and_the_two_tables(tmp_path: Path) -> None:
    # a panorama whose export would take the name of a console file is not handed out as one
    names = allowed_files(["a", "b.2", "run", "results", "results.hedge", "../x", None, "a"])
    assert names == ["a.json", "b.2.json", "answers.csv", "summary.csv"]
    (tmp_path / "a.json").write_text("{}")
    assert submission_file(tmp_path, "a.json", ["a"]) == (tmp_path / "a.json").resolve()
    for name in ("b.json", "answers.csv", "run.json", "../a.json", str(tmp_path / "a.json")):
        with pytest.raises(KeyError):
            submission_file(tmp_path, name, ["a"])
