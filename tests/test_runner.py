"""Task loading, parallel orchestration, watchdog, exports and the CLI: offline, fake model client."""

from __future__ import annotations

import asyncio
import csv
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import cv2
import numpy as np
import pytest
from typer.testing import CliRunner

import cli
from geoagent.config import Budget, Settings
from geoagent.eventlog import validate_export
from geoagent.runner import RunManager, export_run, load_tasks
from geoagent.schema import Label

HYP = {"lat": 38.7223, "lng": -9.1393, "probability": 0.8, "radius_m": 40.0, "label": "Baixa", "evidence": "tram"}
FAST = Budget(effort="high", soft_deadline_s=600, hard_deadline_s=840, max_turns=5, max_spend_usd=8.0)


def write_pano(path: Path) -> Path:
    noise = np.random.default_rng(len(path.name)).integers(0, 255, (128, 256, 3), dtype=np.uint8)
    assert cv2.imwrite(str(path), noise)
    return path


def touch(directory: Path, *names: str) -> None:
    for name in names:
        (directory / name).write_bytes(b"not decoded by load_tasks")


def submit_message() -> SimpleNamespace:
    block = {
        "type": "tool_use", "id": "call_s", "name": "submit_locations", "input": {"hypotheses": [HYP], "reasoning_summary": "ok"}
    }
    usage = {"input_tokens": 1000, "cached_input_tokens": 0, "cache_write_tokens": 0, "output_tokens": 100}
    return SimpleNamespace(id="resp", model="gpt-6.1-sol", content=[block], stop_reason="tool_use", stop_details=None, usage=usage)


class SubmittingClient:
    def __init__(self, delay_s: float = 0.0) -> None:
        self.delay_s = delay_s
        self.active = 0
        self.peak = 0
        self.calls = 0

    async def create(self, **params: Any) -> Any:
        self.calls += 1
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await asyncio.sleep(self.delay_s)
        finally:
            self.active -= 1
        return submit_message()


class HangingClient:
    async def create(self, **params: Any) -> Any:
        await asyncio.sleep(3600)


def settings(tmp_path: Path, **overrides: Any) -> Settings:
    base = {
        "runs_dir": tmp_path / "runs",
        "cache_dir": tmp_path / "cache",
        "allow_web": False,
        "no_human": True,
        "standard": FAST,
        "special": FAST,
        "team": "albatross",
    }
    return Settings(**{**base, **overrides})


@pytest.fixture
def pano_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "set"
    directory.mkdir()
    write_pano(directory / "20261011093000_Urban.jpg")
    write_pano(directory / "20261011101500_non-Urban.jpg")
    write_pano(directory / "special_20261011120000_urban.jpg")
    return directory


# --- load_tasks ---------------------------------------------------------------------------------


def test_metadata_parsed_from_filenames(tmp_path: Path) -> None:
    touch(tmp_path, "20261011093000_Urban.jpg", "pano_2_non-Urban_2026-10-11_10.15.00.JPG", "Special_nonurban.jpeg", "notes.md")

    tasks = {t.path.name: t for t in load_tasks(tmp_path)}

    assert set(tasks) == {"20261011093000_Urban.jpg", "pano_2_non-Urban_2026-10-11_10.15.00.JPG", "Special_nonurban.jpeg"}
    first = tasks["20261011093000_Urban.jpg"]
    assert (first.label, first.timestamp, first.special) == (Label.URBAN, "20261011093000", False)
    assert first.panorama_id == "20261011093000_Urban"
    second = tasks["pano_2_non-Urban_2026-10-11_10.15.00.JPG"]
    assert (second.label, second.timestamp) == (Label.NON_URBAN, "20261011101500")
    third = tasks["Special_nonurban.jpeg"]
    assert (third.label, third.timestamp, third.special) == (Label.NON_URBAN, None, True)


def test_csv_manifest_wins_over_filename(tmp_path: Path) -> None:
    touch(tmp_path, "a_urban.jpg", "b.jpg")
    (tmp_path / "manifest.csv").write_text(
        "Filename;Label;Timestamp;Special\na_urban.jpg;non-Urban;20261011093000;\nb;Urban;2026-10-11 10:00:05;yes\n"
    )

    a, b = load_tasks(tmp_path)

    assert (a.label, a.timestamp, a.special) == (Label.NON_URBAN, "20261011093000", False)
    assert (b.label, b.timestamp, b.special) == (Label.URBAN, "20261011100005", True)


@pytest.mark.parametrize(
    "manifest",
    [
        [{"file": "a.jpg", "type": "Urban", "time": "20261011093000"}, {"image": "b.jpg", "class": "Non Urban"}],
        {"panoramas": [{"filename": "a.jpg", "label": "urban", "timestamp": 20261011093000}, {"name": "b", "label": "rural"}]},
        {"a.jpg": {"label": "Urban", "datetime": "2026-10-11T09:30:00"}, "b.jpg": "non-Urban"},
    ],
)
def test_json_manifest_shapes(tmp_path: Path, manifest: Any) -> None:
    touch(tmp_path, "a.jpg", "b.jpg")
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))

    a, b = load_tasks(tmp_path)

    assert (a.label, a.timestamp) == (Label.URBAN, "20261011093000")
    assert b.label is Label.NON_URBAN


def test_sidecars(tmp_path: Path) -> None:
    touch(tmp_path, "a.jpg", "b.jpg")
    (tmp_path / "a.txt").write_text("Label: non-Urban\nCaptured: 20261011093000\n")
    (tmp_path / "b.json").write_text(json.dumps({"label": "Urban", "timestamp": "20261011101500", "special": True}))

    a, b = load_tasks(tmp_path)

    assert (a.label, a.timestamp, a.special) == (Label.NON_URBAN, "20261011093000", False)
    assert (b.label, b.timestamp, b.special) == (Label.URBAN, "20261011101500", True)


def test_missing_label_is_an_error_unless_a_default_is_given(tmp_path: Path) -> None:
    touch(tmp_path, "a.jpg", "b_urban.jpg")

    with pytest.raises(ValueError, match="a.jpg"):
        load_tasks(tmp_path)

    a, b = load_tasks(tmp_path, default_label=Label.NON_URBAN)
    assert (a.label, b.label) == (Label.NON_URBAN, Label.URBAN)


def test_special_argument_names_the_special_one(tmp_path: Path) -> None:
    touch(tmp_path, "a_urban.jpg", "special_urban.jpg")

    a, b = load_tasks(tmp_path, special="A_URBAN")
    assert (a.special, b.special) == (True, False)  # the explicit choice overrides the filename hint

    with pytest.raises(ValueError, match="matches none"):
        load_tasks(tmp_path, special="c.jpg")


def test_single_file_and_bad_paths(tmp_path: Path) -> None:
    touch(tmp_path, "one urban (1).jpg", "other_urban.jpg")

    (task,) = load_tasks(tmp_path / "one urban (1).jpg")
    assert task.panorama_id == "one_urban_1" and task.label is Label.URBAN

    with pytest.raises(FileNotFoundError):
        load_tasks(tmp_path / "missing.jpg")
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="no panorama images"):
        load_tasks(empty)


def test_invalid_dates_are_not_timestamps(tmp_path: Path) -> None:
    touch(tmp_path, "20269911093000_urban.jpg")

    (task,) = load_tasks(tmp_path)

    assert task.timestamp is None


# --- RunManager ---------------------------------------------------------------------------------


async def test_run_and_export(tmp_path: Path, pano_dir: Path) -> None:
    client = SubmittingClient()
    manager = RunManager(settings(tmp_path), run_id="r1", client=client)
    manager.add_tasks(load_tasks(pano_dir))
    assert {s.status for s in manager.sessions.values()} == {"pending"}

    await manager.start()
    paths = manager.export_all()

    assert client.calls == 3
    assert all(s.final is not None and len(s.final) == 10 for s in manager.sessions.values())
    assert [p.name for p in paths] == [
        "20261011093000_Urban.json",
        "20261011101500_non-Urban.json",
        "special_20261011120000_urban.json",
        "summary.csv",
        "answers.csv",
    ]
    for path in paths[:3]:
        doc = json.loads(path.read_text())
        assert validate_export(doc) == []
        assert doc["team"] == "albatross" and doc["config"]["model"] == "gpt-6.1-sol"
        assert doc["panorama"]["panorama_id"] == path.stem and doc["panorama"]["sha256"]
        assert doc["totals"]["stop_reason"] == "submitted"

    rows = list(csv.DictReader((manager.run_dir / "summary.csv").open()))
    assert [r["panorama"] for r in rows] == [p.stem for p in paths[:3]]
    assert [r["label"] for r in rows] == ["Urban", "non-Urban", "Urban"]
    assert [r["special"] for r in rows] == ["False", "False", "True"]
    assert {(r["lat"], r["lng"], r["multiplier"], r["turns"], r["stop_reason"]) for r in rows} == {
        ("38.7223", "-9.1393", "1.0", "1", "submitted")
    }
    assert all(float(r["cost_usd"]) > 0 and float(r["wall_time_s"]) >= 0 and r["problems"] == "" for r in rows)

    answers = list(csv.reader((manager.run_dir / "answers.csv").open()))
    assert answers[0] == ["panorama_id", "rank", "lat", "lng"] and len(answers) == 31
    assert answers[1] == ["20261011093000_Urban", "1", "38.722300", "-9.139300"]

    snapshot = manager.snapshot()
    assert snapshot["run_id"] == "r1" and snapshot["finished"] is True and len(snapshot["panoramas"]) == 3
    json.dumps(snapshot)


async def test_special_one_gets_the_special_budget(tmp_path: Path, pano_dir: Path) -> None:
    special = FAST.model_copy(update={"effort": "xhigh"})
    manager = RunManager(settings(tmp_path, special=special), client=SubmittingClient())
    manager.add_tasks(load_tasks(pano_dir))

    await manager.start()

    efforts = {
        pid: next(e for e in s.log.events() if e["type"] == "run_start")["data"]["effort"]
        for pid, s in manager.sessions.items()
    }
    assert efforts == {
        "20261011093000_Urban": "high",
        "20261011101500_non-Urban": "high",
        "special_20261011120000_urban": "xhigh",
    }


async def test_concurrency_limit_and_deadlines_count_from_the_actual_start(tmp_path: Path, pano_dir: Path) -> None:
    client = SubmittingClient(delay_s=0.3)
    # A hard deadline shorter than the queueing time: a panorama that waited must still get its turn.
    tight = FAST.model_copy(update={"hard_deadline_s": 5.0})
    manager = RunManager(settings(tmp_path, standard=tight, special=tight), client=client)
    manager.add_tasks(load_tasks(pano_dir))
    for session in manager.sessions.values():
        session.started_monotonic = time.monotonic() - 100

    await manager.start(concurrency=1)

    assert client.peak == 1 and client.calls == 3
    assert {s.final[0].origin for s in manager.sessions.values() if s.final} == {"agent"}


async def test_global_watchdog_finalises_everything(tmp_path: Path, pano_dir: Path) -> None:
    manager = RunManager(settings(tmp_path, global_watchdog_s=1.0), client=HangingClient())
    manager.add_tasks(load_tasks(pano_dir))

    started = time.monotonic()
    await manager.start(concurrency=2)  # one panorama never even leaves the queue

    assert time.monotonic() - started < 10
    for session in manager.sessions.values():
        assert session.final is not None and len(session.final) == 10
        final = [e for e in session.log.events() if e["type"] == "final_submission"]
        assert [e["data"]["reason"] for e in final] == ["global_watchdog"]
    paths = manager.export_all()
    assert all(validate_export(json.loads(p.read_text())) == [] for p in paths[:3])
    rows = list(csv.DictReader((manager.run_dir / "summary.csv").open()))
    assert [r["label"] for r in rows] == ["Urban", "non-Urban", "Urban"]  # known even without a run_start


async def test_unreadable_panorama_still_gets_an_answer(tmp_path: Path, pano_dir: Path) -> None:
    (pano_dir / "broken_urban.jpg").write_bytes(b"this is not a jpeg")
    client = SubmittingClient()
    manager = RunManager(settings(tmp_path), client=client)
    manager.add_tasks(load_tasks(pano_dir))

    await manager.start()
    manager.export_all()

    broken = manager.sessions["broken_urban"]
    assert broken.final is not None and broken.final[0].origin == "harness_fallback"
    assert client.calls == 3
    row = next(r for r in manager.summary if r["panorama"] == "broken_urban")
    assert row["stop_reason"] == "panorama_load_failed" and row["problems"] == ""


async def test_start_background_and_duplicate_ids(tmp_path: Path, pano_dir: Path) -> None:
    manager = RunManager(settings(tmp_path), client=SubmittingClient())
    tasks = load_tasks(pano_dir)
    manager.add_tasks(tasks)
    with pytest.raises(ValueError, match="duplicate"):
        manager.add_tasks(tasks[:1])

    await manager.start_background()

    assert all(s.status == "done" for s in manager.sessions.values())


async def test_export_run_works_from_logs_alone_and_reports_problems(tmp_path: Path, pano_dir: Path) -> None:
    manager = RunManager(settings(tmp_path), run_id="r2", client=SubmittingClient())
    manager.add_tasks(load_tasks(pano_dir))
    await manager.start()
    # A log with no final_submission, as an interrupted process would leave behind.
    (manager.run_dir / "orphan.events.jsonl").write_text(
        json.dumps({"schema_version": "1.0", "seq": 1, "type": "model_request", "data": {}, "penalty_state": {}}) + "\n"
    )

    paths, rows = export_run(manager.run_dir, team="albatross")

    assert len(paths) == 6 and len(rows) == 4
    by_id = {r["panorama"]: r for r in rows}
    assert by_id["20261011101500_non-Urban"]["label"] == "non-Urban" and by_id["20261011101500_non-Urban"]["problems"] == ""
    assert "expected 10" in by_id["orphan"]["problems"]


# --- CLI ----------------------------------------------------------------------------------------


@pytest.fixture
def cli_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    runs = tmp_path / "runs"
    for name in ("ALLOW_WEB", "HEDGE", "NO_HUMAN", "EMBED_IMAGES", "ALLOW_DUPLICATES", "PENALTY_SCOPE", "GEOAGENT_MODEL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RUNS_DIR", str(runs))
    monkeypatch.setenv("CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("TEAM_NAME", "albatross")
    return runs


def test_cli_batch_then_export(cli_env: Path, pano_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[RunManager] = []

    def factory(config: Settings, **kwargs: Any) -> RunManager:
        created.append(RunManager(config, client=SubmittingClient(), **kwargs))
        return created[-1]

    monkeypatch.setattr(cli, "RunManager", factory)
    runner = CliRunner()

    result = runner.invoke(
        cli.app, ["batch", str(pano_dir), "--concurrency", "2", "--no-human", "--no-web", "--hedge", "--run-id", "trial"]
    )

    assert result.exit_code == 0, result.output
    (manager,) = created
    assert (manager.settings.no_human, manager.settings.allow_web, manager.settings.hedge) == (True, False, True)
    run_dir = cli_env / "trial"
    assert (run_dir / "summary.csv").is_file() and (run_dir / "answers.csv").is_file()
    assert "20261011101500_non-Urban" in result.output and "submitted" in result.output
    assert "summary.csv" in result.output

    (run_dir / "summary.csv").unlink()
    again = runner.invoke(cli.app, ["export", str(run_dir)])
    assert again.exit_code == 0, again.output
    assert (run_dir / "summary.csv").is_file() and "38.7223" in again.output


def test_cli_run_single_panorama_marks_special(cli_env: Path, pano_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[RunManager] = []
    monkeypatch.setattr(
        cli,
        "RunManager",
        lambda config, **kw: created.append(RunManager(config, client=SubmittingClient(), **kw)) or created[-1],
    )

    result = CliRunner().invoke(
        cli.app, ["run", str(pano_dir / "20261011093000_Urban.jpg"), "--special", "--live", "--no-web", "--run-id", "one"]
    )

    assert result.exit_code == 0, result.output
    (manager,) = created
    (session,) = manager.sessions.values()
    assert session.task.special is True and manager.live is True and manager.settings.no_human is True
    assert json.loads((cli_env / "one" / "20261011093000_Urban.json").read_text())["panorama"]["special"] is True


def test_cli_reports_unlabelled_panoramas(cli_env: Path, tmp_path: Path) -> None:
    directory = tmp_path / "unlabelled"
    directory.mkdir()
    touch(directory, "a.jpg")

    result = CliRunner().invoke(cli.app, ["batch", str(directory)])

    assert result.exit_code == 2 and "a.jpg" in result.output


def test_cli_eval_delegates_to_the_eval_app(cli_env: Path) -> None:
    result = CliRunner().invoke(cli.app, ["eval", "--help"])

    assert result.exit_code == 0, result.output
    assert "rescore" in result.output


def test_cli_serve_is_wired(cli_env: Path) -> None:
    result = CliRunner().invoke(cli.app, ["serve", "--help"])

    assert result.exit_code == 0 and "--no-human" in result.output


# --- task loading: the organisers' file layout is unknown ---------------------------------------


def by_name(tasks: list[Any]) -> dict[str, Any]:
    return {t.path.name: t for t in tasks}


def test_manifest_accepts_the_short_label_forms(tmp_path: Path) -> None:
    touch(tmp_path, "a.jpg", "b.jpg")
    (tmp_path / "labels.csv").write_text("filename,label\na.jpg,U\nb.jpg,NU\n")
    tasks = by_name(load_tasks(tmp_path))
    assert tasks["a.jpg"].label is Label.URBAN and tasks["b.jpg"].label is Label.NON_URBAN


def test_manifest_with_any_file_name_is_used(tmp_path: Path) -> None:
    """A correctly filled set3.csv must win over --label, which would mislabel one of them."""
    touch(tmp_path, "a.jpg", "b.jpg")
    (tmp_path / "set3.csv").write_text("file;type;time\na.jpg;Urban;20251004123000\nb.jpg;non-Urban;20251004124500\n")
    tasks = by_name(load_tasks(tmp_path, default_label=Label.URBAN))
    assert tasks["a.jpg"].label is Label.URBAN and tasks["b.jpg"].label is Label.NON_URBAN
    assert tasks["b.jpg"].timestamp == "20251004124500"


def test_headerless_manifest(tmp_path: Path) -> None:
    touch(tmp_path, "a.jpg", "b.jpg")
    (tmp_path / "labels.txt").write_text("a.jpg,U,20251004123000\nb.jpg,NU,2025-10-04 12:45,special\n")
    tasks = by_name(load_tasks(tmp_path))
    assert tasks["a.jpg"].label is Label.URBAN and tasks["a.jpg"].timestamp == "20251004123000"
    assert tasks["b.jpg"].label is Label.NON_URBAN and tasks["b.jpg"].timestamp == "20251004124500"
    assert tasks["b.jpg"].special and not tasks["a.jpg"].special


def test_json_manifest_under_an_unlisted_key_and_boolean_urban_column(tmp_path: Path) -> None:
    touch(tmp_path, "a.jpg", "b.jpg")
    doc = {"data": [{"image": "a.jpg", "urban": True}, {"image": "b.jpg", "urban": False}]}
    (tmp_path / "meta.json").write_text(json.dumps(doc))
    tasks = by_name(load_tasks(tmp_path))
    assert tasks["a.jpg"].label is Label.URBAN and tasks["b.jpg"].label is Label.NON_URBAN


def test_label_sub_directories(tmp_path: Path) -> None:
    (tmp_path / "Urban").mkdir()
    (tmp_path / "non-Urban").mkdir()
    touch(tmp_path / "Urban", "a.jpg")
    touch(tmp_path / "non-Urban", "b.jpg")
    tasks = by_name(load_tasks(tmp_path))
    assert tasks["a.jpg"].label is Label.URBAN and tasks["b.jpg"].label is Label.NON_URBAN


def test_macos_resource_fork_files_are_not_panoramas(tmp_path: Path) -> None:
    touch(tmp_path, "pano1_Urban.jpg", "._pano1_Urban.jpg", ".DS_Store.jpg")
    tasks = load_tasks(tmp_path, special="pano1_Urban")
    assert [(t.panorama_id, t.path.name, t.special) for t in tasks] == [("pano1_Urban", "pano1_Urban.jpg", True)]


@pytest.mark.parametrize(
    ("sidecar", "expected"),
    [
        ("Nothing special about this one", False),
        ("Special One: no", False),
        ("special: yes", True),
        ("Urban\nSpecial One\n", True),
        ("special", True),
    ],
)
def test_sidecar_must_state_the_special_one_not_merely_use_the_word(tmp_path: Path, sidecar: str, expected: bool) -> None:
    touch(tmp_path, "a_Urban.jpg")
    (tmp_path / "a_Urban.txt").write_text(sidecar)
    (task,) = load_tasks(tmp_path)
    assert task.special is expected


def test_file_name_token_still_flags_the_special_one(tmp_path: Path) -> None:
    touch(tmp_path, "pano_special_Urban.jpg", "especially_nice_Urban.jpg")
    tasks = by_name(load_tasks(tmp_path))
    assert tasks["pano_special_Urban.jpg"].special and not tasks["especially_nice_Urban.jpg"].special


def test_timestamp_without_seconds_is_kept(tmp_path: Path) -> None:
    touch(tmp_path, "a.jpg")
    (tmp_path / "manifest.csv").write_text("filename,label,timestamp\na.jpg,Urban,2025-10-04 12:30\n")
    (task,) = load_tasks(tmp_path)
    assert task.timestamp == "20251004123000"


def test_load_warnings_name_what_the_operator_must_check(tmp_path: Path) -> None:
    touch(tmp_path, "a_Urban_special.jpg", "b_special.jpg", "c.jpg")
    (tmp_path / "manifest.csv").write_text("filename,label,timestamp\nb_special.jpg,NU,yesterday at noon\n")
    warnings: list[str] = []
    tasks = load_tasks(tmp_path, default_label=Label.URBAN, warnings=warnings)
    text = " | ".join(warnings)
    assert "'yesterday at noon' was not understood" in text
    assert "applied by default to 1 panorama(s)" in text and "c.jpg" in text
    assert "2 panoramas are flagged as the Special One" in text
    assert "no capture timestamp" in text
    assert by_name(tasks)["b_special.jpg"].label is Label.NON_URBAN


def test_unlabelled_error_explains_the_accepted_forms(tmp_path: Path) -> None:
    touch(tmp_path, "a.jpg")
    with pytest.raises(ValueError) as caught:
        load_tasks(tmp_path)
    assert "U or NU" in str(caught.value) and "EVERY" in str(caught.value)


def test_cli_prints_the_parsed_tasks_before_launch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    touch(tmp_path, "a_Urban.jpg", "b.jpg")
    (tmp_path / "set3.csv").write_text("filename,label,special\nb.jpg,NU,yes\n")
    tasks = cli._load(tmp_path, None, None)
    assert [t.label for t in tasks] == [Label.URBAN, Label.NON_URBAN]
    lines = cli.describe_tasks(tasks)
    assert "Urban" in lines[0] and "non-Urban" in lines[1] and "SPECIAL ONE" in lines[1]


# --- stopping `serve`: the answer and the export must survive Ctrl-C ------------------------------


@pytest.mark.parametrize("interruption", [KeyboardInterrupt, asyncio.CancelledError])
def test_serve_finalises_and_exports_when_the_server_is_interrupted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, interruption: type[BaseException]
) -> None:
    """After Ctrl-C uvicorn re-raises SIGINT and asyncio cancels the main task; the finalise and
    export used to sit behind an await in that cancelled task and never ran."""
    write_pano(tmp_path / "a_Urban.jpg")
    settings = Settings(runs_dir=tmp_path / "runs", cache_dir=tmp_path / "cache", allow_web=False)
    manager = RunManager(settings, run_id="r1", client=SubmittingClient(delay_s=3600))
    manager.add_tasks(load_tasks(tmp_path))
    monkeypatch.setattr(cli, "_terminate_like_ctrl_c", lambda: None)

    async def interrupted_server(manager_: RunManager, host: str, port: int, concurrency: int | None) -> None:
        job = asyncio.create_task(manager_.start(concurrency))
        await asyncio.sleep(0.3)  # the run is in flight, mid model call
        job.cancel()
        await asyncio.gather(job, return_exceptions=True)
        raise interruption()

    monkeypatch.setattr(cli, "_serve", interrupted_server)
    with pytest.raises(BaseException) as caught:
        cli._serve_blocking(manager, "127.0.0.1", 0, 1)
    assert isinstance(caught.value, (KeyboardInterrupt, asyncio.CancelledError))

    session = manager.sessions["a_Urban"]
    assert session.final is not None and len(session.final) == 10
    for name in ("a_Urban.json", "answers.csv", "summary.csv"):
        assert (manager.run_dir / name).is_file(), name
    doc = json.loads((manager.run_dir / "a_Urban.json").read_text())
    assert len(doc["final"]["locations"]) == 10 and validate_export(doc) == []


def test_uvicorn_does_not_wait_forever_on_the_open_event_stream() -> None:
    config = cli._uvicorn_config(lambda scope, receive, send: None, "127.0.0.1", 8000)
    assert config.timeout_graceful_shutdown == cli.GRACEFUL_SHUTDOWN_S == 3


def test_sigterm_and_sighup_become_an_interrupt(monkeypatch: pytest.MonkeyPatch) -> None:
    import signal

    installed: dict[int, Any] = {}
    monkeypatch.setattr(signal, "signal", lambda sig, handler: installed.__setitem__(sig, handler))
    cli._terminate_like_ctrl_c()
    assert set(installed) == {signal.SIGTERM, signal.SIGHUP}
    with pytest.raises(KeyboardInterrupt):
        installed[signal.SIGTERM](signal.SIGTERM, None)


async def test_restored_human_geocode_ends_the_panorama_without_running_the_agent(tmp_path: Path) -> None:
    write_pano(tmp_path / "a_Urban.jpg")
    settings = Settings(runs_dir=tmp_path / "runs", cache_dir=tmp_path / "cache", allow_web=False)
    first = RunManager(settings, run_id="r1", client=SubmittingClient())
    first.add_tasks(load_tasks(tmp_path))
    session = first.sessions["a_Urban"]
    session.update_candidates([HYP])
    session.human_geocode(38.71, -9.13, "Baixa")

    client = SubmittingClient()
    second = RunManager(settings, run_id="r1", client=client)  # the same run id after a restart
    second.add_tasks(load_tasks(tmp_path))
    await second.start(1)
    second.export_all()

    assert client.calls == 0
    (row,) = second.summary
    assert (row["lat"], row["lng"], row["multiplier"], row["origin"]) == (38.71, -9.13, 0.5, "human_geocode")
    assert row["stop_reason"] == "human_geocode_restored" and row["problems"] == ""
