"""Core changes behind the web console: per-run tool switches, task provenance, the detailed task
loader, the pure cue lint, delivery events, late additions, retry, stop and recovery. Offline,
scripted model client."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import cv2
import httpx2
import numpy as np
import openai
import pytest

from eval import run_eval
from astrolabio import config as config_module
from astrolabio import prompts
from astrolabio import runner as runner_module
from astrolabio.allocate import describe
from astrolabio.config import STANDARD_BUDGET, Budget, Settings
from astrolabio.eventlog import EventLog, validate_export
from astrolabio.loop import build_request_params, run_agent
from astrolabio.pano import Panorama
from astrolabio.runner import (
    LOCK_NAME,
    RETRYABLE_STOP_REASONS,
    Preflight,
    RunManager,
    export_run,
    load_tasks,
    load_tasks_detailed,
    log_is_unfinished,
    read_run_lock,
    recover_run,
)
from astrolabio.schema import Hypothesis, Label, PanoramaTask
from astrolabio.session import HumanChannelError, PanoramaSession
from astrolabio.tools import schemas
from astrolabio.tools.base import ToolContext
from astrolabio.tools.registry import execute_tool
from astrolabio.tools.schemas import (
    ALL_TOOL_NAMES,
    PROTECTED_TOOLS,
    tool_definitions,
    validate_disabled_tools,
)

HYP = {"lat": 38.7223, "lng": -9.1393, "probability": 0.8, "radius_m": 40.0, "label": "Baixa", "evidence": "tram"}
FAST = Budget(effort="high", soft_deadline_s=600, hard_deadline_s=840, max_turns=5, max_spend_usd=8.0)
CUE = "the kerb stones are painted yellow"
REQUEST = httpx2.Request("POST", "https://api.openai.com/v1/responses")
HOLD = object()  # in a script: a model call that stays in flight until the test releases it
RUN_START_KEYS = {
    "panorama", "label", "capture_timestamp", "special", "model", "effort", "budget", "request",
    "system_prompt", "tools", "git_sha", "flags",
}  # fmt: skip
FLAG_KEYS = {"allow_web", "no_human", "hedge", "allow_duplicates", "penalty_scope", "max_mcq"}


def write_pano(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    noise = np.random.default_rng(len(path.name)).integers(0, 255, (128, 256, 3), dtype=np.uint8)
    assert cv2.imwrite(str(path), noise)
    return path


def touch(directory: Path, *names: str) -> None:
    for name in names:
        (directory / name).parent.mkdir(parents=True, exist_ok=True)
        (directory / name).write_bytes(b"not decoded by the loader")


def reply(name: str, **extra: Any) -> SimpleNamespace:
    block = {"type": "tool_use", "id": f"call_{name}", "name": name, "input": {"hypotheses": [HYP], **extra}}
    usage = {"input_tokens": 1000, "cached_input_tokens": 0, "cache_write_tokens": 0, "output_tokens": 100}
    return SimpleNamespace(id="resp", model="gpt-6.1-sol", content=[block], stop_reason="tool_use", stop_details=None, usage=usage)


def update() -> SimpleNamespace:
    return reply("update_candidates")


def submit() -> SimpleNamespace:
    return reply("submit_locations", reasoning_summary="ok")


def auth_error() -> openai.AuthenticationError:
    return openai.AuthenticationError("bad key", response=httpx2.Response(401, request=REQUEST), body=None)


class ScriptClient:
    """One script per panorama id ("" stands for every other panorama). An item is a message, an
    exception to raise, a coroutine function to await, or HOLD; the last one repeats."""

    def __init__(self, **scripts: Any) -> None:
        self.scripts = {
            key: [self.hold if item is HOLD else item for item in script] for key, script in scripts.items()
        }
        self.calls: dict[str, int] = {}
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def hold(self) -> Any:
        """Stand for a model call that is in flight until the test lets it go."""
        self.started.set()
        await self.release.wait()
        return submit()

    async def create(self, **params: Any) -> Any:
        panorama_id = params["prompt_cache_key"].rsplit("-", 1)[-1]
        key = panorama_id if panorama_id in self.scripts else ""
        self.calls[key] = self.calls.get(key, 0) + 1
        script = self.scripts[key]
        item = script[min(self.calls[key], len(script)) - 1]
        if isinstance(item, BaseException):
            raise item
        if callable(item):
            return await item()
        return item


async def until(condition: Any) -> None:
    async def poll() -> None:
        while not condition():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), 10)


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


def task(tmp_path: Path, name: str, **fields: Any) -> PanoramaTask:
    return PanoramaTask(panorama_id=name, path=write_pano(tmp_path / "set" / f"{name}.jpg"), label=Label.URBAN, **fields)


def events(session: PanoramaSession, *kinds: str) -> list[dict[str, Any]]:
    return [e for e in session.log.events() if not kinds or e["type"] in kinds]


def kinds(session: PanoramaSession) -> list[str]:
    return [e["type"] for e in session.log.events()]


def stop_reasons(manager: RunManager) -> dict[str, list[str]]:
    return {pid: [e["data"]["stop_reason"] for e in events(s, "run_end")] for pid, s in manager.sessions.items()}


# --- tools switched off per run ---------------------------------------------------------------


def test_default_settings_send_the_tool_list_and_prompt_they_always_did() -> None:
    full = [*schemas.LOCAL_TOOLS, *schemas.HUMAN_TOOLS, *schemas.WEB_CLIENT_TOOLS, schemas.WEB_SEARCH]
    assert Settings().disabled_tools == ()
    assert json.dumps(tool_definitions(Settings())) == json.dumps(full)
    assert json.dumps(tool_definitions(Settings(allow_web=False))) == json.dumps(
        [*schemas.LOCAL_TOOLS, *schemas.HUMAN_TOOLS]
    )
    params = build_request_params(Settings(), STANDARD_BUDGET, "k")
    assert params["include"] == ["reasoning.encrypted_content", "web_search_call.action.sources"]
    # the instructions do not depend on the switches, so an ablation keeps the cached prefix
    off = Settings(disabled_tools=("satellite_tile", "web_search"))
    assert prompts.build_system_prompt(off) == prompts.build_system_prompt(Settings()) == params["instructions"]


def test_disabled_tools_leave_the_list_in_order() -> None:
    off = Settings(disabled_tools=("web_search", "sun_position", "overpass_query"))
    names = [t.get("name") or t["type"] for t in tool_definitions(off)]
    assert names == [n for n in ALL_TOOL_NAMES if n not in off.disabled_tools]
    assert "web_search_call.action.sources" not in build_request_params(off, STANDARD_BUDGET, "k")["include"]
    # a hand-built Settings cannot remove the answer path either
    forced = Settings(disabled_tools=PROTECTED_TOOLS)
    assert tool_definitions(forced) == tool_definitions(Settings())


def test_validate_disabled_tools() -> None:
    assert ALL_TOOL_NAMES[-1] == "web_search" and set(PROTECTED_TOOLS) == {"update_candidates", "submit_locations"}
    assert validate_disabled_tools(None) == validate_disabled_tools([]) == validate_disabled_tools("") == ()
    assert validate_disabled_tools(["web_search", "view_crop", "view_crop"]) == ("view_crop", "web_search")
    assert validate_disabled_tools("satellite_tile, sun_position") == ("sun_position", "satellite_tile")
    with pytest.raises(ValueError, match="unknown tool"):
        validate_disabled_tools(["teleport"])
    with pytest.raises(ValueError, match="submit_locations cannot be switched off"):
        validate_disabled_tools(["view_crop", "submit_locations"])
    with pytest.raises(ValueError, match="strings"):
        validate_disabled_tools([3])  # type: ignore[list-item]


async def test_a_disabled_tool_answers_with_a_free_error(tmp_path: Path) -> None:
    config = settings(tmp_path, disabled_tools=("sun_position",))
    session = PanoramaSession(task(tmp_path, "a"), config, "r1")
    ctx = ToolContext(session=session, pano=None, settings=config, http=None)  # type: ignore[arg-type]

    result = await execute_tool(ctx, "sun_position", {"sun_yaw": 0, "sun_pitch": 10, "candidates": []})

    assert result.is_error and "switched off for this run" in result.content[0]["text"]
    assert session.ledger.multiplier == 1.0
    assert kinds(session) == ["tool_call", "tool_result"]
    # protected tools still run even when a hand-built Settings lists them
    forced = PanoramaSession(task(tmp_path, "b"), settings(tmp_path, disabled_tools=("update_candidates",)), "r1")
    ctx = ToolContext(session=forced, pano=None, settings=forced.settings, http=None)  # type: ignore[arg-type]
    assert not (await execute_tool(ctx, "update_candidates", {"hypotheses": [HYP]})).is_error


def test_eval_settings_can_switch_tools_off_without_touching_the_tables(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config_module, "load_dotenv", lambda *a, **k: False)
    before = json.dumps(tool_definitions(Settings()))

    config = run_eval.eval_settings(
        effort=None, hedge=False, allow_web=True, runs_dir=tmp_path, disabled_tools=["web_search", "satellite_tile"]
    )

    assert config.disabled_tools == ("satellite_tile", "web_search") and config.no_human is True
    assert run_eval.eval_settings(effort="low", hedge=False, allow_web=True, runs_dir=tmp_path).disabled_tools == ()
    assert json.dumps(tool_definitions(Settings())) == before
    with pytest.raises(ValueError):
        run_eval.eval_settings(effort=None, hedge=False, allow_web=True, runs_dir=tmp_path, disabled_tools=["submit_locations"])


# --- allocate.describe ------------------------------------------------------------------------


def test_describe_counts_distinct_places_and_reports_the_gate() -> None:
    lisbon = Hypothesis(lat=38.7, lng=-9.1, probability=0.5)
    beside = Hypothesis(lat=38.70001, lng=-9.1, probability=0.2)  # about 1 m away: the same place
    porto = Hypothesis(lat=41.1, lng=-8.6, probability=0.3)

    seen = describe([porto, lisbon, beside], Label.URBAN)

    assert seen["clusters"] == 2 and seen["multimodal"] is True and seen["gate_reason"].startswith("multi-modal")
    assert [(c["probability"], c["members"]) for c in seen["cluster_points"]] == [(0.7, 2), (0.3, 1)]
    top, second = seen["cluster_points"]
    assert abs(top["lat"] - 38.700003) < 1e-6 and (second["lat"], second["lng"]) == (41.1, -8.6)
    assert 269_000 < seen["top_gap_m"] < 272_000
    json.dumps(seen)

    alone = describe([lisbon, beside], Label.URBAN)
    assert (alone["clusters"], alone["top_gap_m"], alone["multimodal"]) == (1, None, False)
    assert describe([], Label.NON_URBAN) == {
        "clusters": 0, "top_gap_m": None, "multimodal": False, "gate_reason": "no hypotheses yet", "cluster_points": [],
    }  # fmt: skip
    # two points 1 km apart are one place for a non-Urban panorama (3 km clusters), two for an Urban one
    near = [Hypothesis(lat=38.7, lng=-9.1, probability=0.5), Hypothesis(lat=38.709, lng=-9.1, probability=0.5)]
    assert describe(near, Label.NON_URBAN)["clusters"] == 1 and describe(near, Label.URBAN)["clusters"] == 2
    assert describe(near, Label.URBAN, accuracy=0.5)["multimodal"] is False


# --- the detailed loader ----------------------------------------------------------------------


def test_detailed_loader_says_where_every_value_came_from(tmp_path: Path) -> None:
    touch(tmp_path, "Urban/a.jpg", "non-Urban/b_20261011093000.jpg", "c_urban_special.jpg", "d.jpg", "e.jpg", "._d.jpg", "Urban/.DS_Store")
    (tmp_path / "d.txt").write_text("Label: non-Urban\nSpecial One: no\n")
    (tmp_path / "manifest.csv").write_text("filename,label,timestamp\nc_urban_special.jpg,NU,2026-10-11 10:00:05\n")

    pre = load_tasks_detailed(tmp_path)

    assert isinstance(pre, Preflight)
    rows = {row.filename: row for row in pre.rows}
    assert [row.rel_path for row in pre.rows] == ["c_urban_special.jpg", "d.jpg", "e.jpg", "Urban/a.jpg", "non-Urban/b_20261011093000.jpg"]
    assert rows["a.jpg"].sources == {"label": "folder", "timestamp": "none", "special": "none"}
    assert rows["b_20261011093000.jpg"].sources == {"label": "folder", "timestamp": "filename", "special": "none"}
    special = rows["c_urban_special.jpg"]
    assert (special.label, special.timestamp, special.special) == (Label.NON_URBAN, "20261011100005", True)
    assert special.sources == {"label": "manifest", "timestamp": "manifest", "special": "filename"}
    assert rows["d.jpg"].sources == {"label": "sidecar", "timestamp": "none", "special": "sidecar"}
    assert rows["e.jpg"].label is None and rows["e.jpg"].sources["label"] == "none"
    assert special.parsed == {"label": "non-Urban", "timestamp": "20261011100005", "special": True}
    assert pre.ignored == ["._d.jpg", "Urban/.DS_Store"]
    assert any("no Urban / non-Urban label found for: e.jpg" in w for w in pre.warnings)
    assert any("no capture timestamp" in w for w in pre.warnings)
    json.dumps([row.to_dict() for row in pre.rows])
    with pytest.raises(ValueError, match="e.jpg.*U or NU"):
        pre.tasks()


def test_detailed_loader_overrides_are_fixed_choices_with_provenance(tmp_path: Path) -> None:
    touch(tmp_path, "a_urban.jpg", "b.jpg", "c_special_urban_20261011093000.jpg")
    overrides = {
        "b": {"label": "non-Urban", "timestamp": "20261011120000"},
        "a_urban.jpg": {"label": "non-Urban", "special": True},
        "c_special_urban_20261011093000": {"timestamp": None, "special": False},
    }

    pre = load_tasks_detailed(tmp_path, overrides=overrides)
    a, b, c = pre.tasks()

    assert (a.label, a.special, b.label, b.timestamp, c.timestamp, c.special) == (
        Label.NON_URBAN, True, Label.NON_URBAN, "20261011120000", None, False,
    )  # fmt: skip
    assert a.provenance == {
        "label": {"value": "non-Urban", "source": "operator", "parsed": "Urban"},
        "timestamp": {"value": None, "source": "none", "parsed": None},
        "special": {"value": True, "source": "operator", "parsed": False},
    }
    assert b.provenance["label"] == {"value": "non-Urban", "source": "operator", "parsed": None}
    assert c.provenance["timestamp"] == {"value": None, "source": "operator", "parsed": "20261011093000"}
    assert c.provenance["label"] == {"value": "Urban", "source": "filename", "parsed": "Urban"}
    # load_tasks itself records nothing, as before
    assert all(t.provenance is None for t in load_tasks(tmp_path, default_label=Label.URBAN))


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"a": {"label": "urban"}}, "label must be exactly"),
        ({"a": {"label": "the old town of Lisbon"}}, "label must be exactly"),
        ({"a": {"timestamp": "church of Sao Roque, Lisbon"}}, "timestamp must be 14 digits"),
        ({"a": {"timestamp": "20269911093000"}}, "not a real date"),
        ({"a": {"timestamp": 20261011093000}}, "timestamp must be 14 digits"),
        ({"a": {"special": "yes"}}, "special must be true or false"),
        ({"a": {"note": "look near the river"}}, "unknown field"),
        ({"a": "Urban"}, "must be an object"),
        ({"zzz": {"label": "Urban"}}, "matches no panorama"),
        ({"a": {"label": "Urban"}, "a.jpg": {"special": True}}, "another override already names"),
        ({"a": {"label": "rural"}, "zzz": {"special": True}}, "label must be exactly.*matches no panorama"),
    ],
)
def test_detailed_loader_refuses_anything_but_the_three_fixed_fields(
    tmp_path: Path, overrides: dict[str, Any], message: str
) -> None:
    touch(tmp_path, "a.jpg", "b_urban.jpg")
    with pytest.raises(ValueError, match=message):
        load_tasks_detailed(tmp_path, overrides=overrides)


def test_detailed_loader_resolves_keys_without_guessing(tmp_path: Path) -> None:
    touch(tmp_path, "Urban/a.jpg", "non-Urban/a.jpg", "non-Urban/b.jpg")

    pre = load_tasks_detailed(tmp_path)
    assert [(row.panorama_id, row.rel_path) for row in pre.rows] == [
        ("a", "Urban/a.jpg"), ("a_2", "non-Urban/a.jpg"), ("b", "non-Urban/b.jpg"),
    ]  # fmt: skip

    # the id wins over the file name it was derived from; a relative path is exact
    by_id = load_tasks_detailed(tmp_path, overrides={"a": {"special": True}, "non-Urban/a.jpg": {"label": "Urban"}})
    assert [row.special for row in by_id.rows] == [True, False, False] and by_id.rows[1].label is Label.URBAN
    with pytest.raises(ValueError, match="'a.jpg' matches more than one panorama.*Urban/a.jpg, non-Urban/a.jpg"):
        load_tasks_detailed(tmp_path, overrides={"a.jpg": {"special": True}})
    with pytest.raises(ValueError, match="more than one"):
        load_tasks_detailed(tmp_path, special="a.jpg")

    # ids already used by the run the rows are for are never handed out again
    added = load_tasks_detailed(tmp_path, taken_ids={"a", "b"})
    assert [row.panorama_id for row in added.rows] == ["a_2", "a_3", "b_2"]
    assert load_tasks_detailed(tmp_path, taken_ids=["a"], special="a_3").rows[1].special is True


def test_detailed_loader_special_and_default_label(tmp_path: Path) -> None:
    touch(tmp_path, "a_urban.jpg", "special_urban.jpg", "c.jpg")

    pre = load_tasks_detailed(tmp_path, special="A_URBAN", default_label=Label.NON_URBAN)

    a, c, flagged = pre.rows
    assert (a.special, flagged.special) == (True, False)  # naming one clears the flag found in the files
    assert a.sources["special"] == flagged.sources["special"] == "operator" and c.sources["special"] == "none"
    assert (c.label, c.sources["label"], c.parsed["label"]) == (Label.NON_URBAN, "default", None)
    assert any("applied to 1 panorama that had no label of its own" in w and "c.jpg" in w for w in pre.warnings)
    bulk = load_tasks_detailed(tmp_path, default_label=Label.URBAN, default_source="operator_bulk")
    assert bulk.tasks()[1].provenance["label"] == {"value": "Urban", "source": "operator_bulk", "parsed": None}

    with pytest.raises(ValueError, match="matches no panorama"):
        load_tasks_detailed(tmp_path, special="nope.jpg")
    with pytest.raises(ValueError, match="an override says otherwise for: c"):
        load_tasks_detailed(tmp_path, special="a_urban", overrides={"c": {"special": True}})
    agreeing = load_tasks_detailed(tmp_path, special="c", overrides={"c": {"special": True, "label": "Urban"}})
    assert [row.special for row in agreeing.rows] == [False, True, False]
    (single,) = load_tasks_detailed(tmp_path / "a_urban.jpg").rows
    assert (single.panorama_id, single.rel_path, single.label) == ("a_urban", "a_urban.jpg", Label.URBAN)
    with pytest.raises(FileNotFoundError):
        load_tasks_detailed(tmp_path / "missing")


# --- run_start provenance ---------------------------------------------------------------------


async def test_run_start_is_unchanged_without_provenance_and_carries_it_when_given(tmp_path: Path) -> None:
    plain = task(tmp_path, "plain")
    origin = {
        "label": {"value": "Urban", "source": "operator", "parsed": None},
        "timestamp": {"value": None, "source": "none", "parsed": None},
        "special": {"value": False, "source": "none", "parsed": False},
        "set_id": "set-1",
    }
    traced = task(tmp_path, "traced", provenance=origin)
    manager = RunManager(settings(tmp_path, disabled_tools=("sun_position",)), run_id="r1", client=ScriptClient(**{"": [submit()]}))
    manager.add_tasks([plain, traced])

    await manager.start()

    start = events(manager.sessions["plain"], "run_start")[0]["data"]
    assert set(start) == RUN_START_KEYS
    assert start["flags"]["disabled_tools"] == ["sun_position"]
    assert "sun_position" not in [t.get("name") for t in start["tools"]]
    traced_start = events(manager.sessions["traced"], "run_start")[0]["data"]
    assert set(traced_start) == RUN_START_KEYS | {"provenance"}
    assert traced_start["provenance"] == {
        "filename": "traced.jpg", "sha256": traced_start["panorama"]["sha256"], **origin,
    }  # fmt: skip

    default = RunManager(settings(tmp_path), run_id="r2", client=ScriptClient(**{"": [submit()]}))
    default.add_tasks([plain])
    await default.start()
    flags = events(default.sessions["plain"], "run_start")[0]["data"]["flags"]
    assert set(flags) == FLAG_KEYS


# --- the cue channel --------------------------------------------------------------------------


def human_session(tmp_path: Path, **overrides: Any) -> PanoramaSession:
    return PanoramaSession(task(tmp_path, "a"), settings(tmp_path, no_human=False, **overrides), "r1")


def test_check_cue_is_the_lint_and_leaves_no_trace(tmp_path: Path) -> None:
    session = human_session(tmp_path)
    session.update_candidates([HYP])
    before = session.log.path.read_bytes()

    ok = session.check_cue(f"  {CUE}  ")
    blocked = session.check_cue("the sign says Lisboa, near São Bento station")
    long = session.check_cue("a" * 1001)
    empty = session.check_cue("   ")

    assert ok == {
        "ok": True, "problems": [], "matches": [], "lint": {"ok": True, "problems": []}, "char_count": len(CUE),
        "max_chars": 1000, "multiplier_before": 1.0, "multiplier_after": 0.8, "reason": None,
    }  # fmt: skip
    assert blocked["ok"] is False and blocked["reason"] == "lint" and blocked["problems"] == blocked["lint"]["problems"]
    text = "the sign says Lisboa, near São Bento station"
    assert {(m["category"], text[m["start"] : m["end"]].lower()) for m in blocked["matches"]} >= {("place name", "lisboa")}
    assert all(set(m) == {"category", "word", "start", "end"} for m in blocked["matches"])
    assert (long["reason"], long["char_count"], long["lint"]) == ("too_long", 1001, None)
    assert (empty["reason"], empty["ok"]) == ("empty", False)
    assert all(len(result["problems"]) == 1 for result in (long, empty))
    # nothing was written, charged or queued: not even the rejection events submit_cue logs
    assert session.log.path.read_bytes() == before
    assert session.ledger.cues == 0 and session.drain_cues() == [] and session.ledger.multiplier == 1.0


def test_check_cue_reports_every_refusal_submit_cue_would_make(tmp_path: Path) -> None:
    autonomous = PanoramaSession(task(tmp_path, "auto"), settings(tmp_path), "r1")
    assert autonomous.check_cue(CUE)["reason"] == "disabled"

    session = human_session(tmp_path)
    session.submit_cue(CUE, confirmed=True)
    assert session.check_cue(CUE)["reason"] == "duplicate"
    after_one = session.check_cue("the bollards are green")
    assert (after_one["ok"], after_one["multiplier_before"]) == (True, 0.8)
    assert after_one["multiplier_after"] == pytest.approx(0.64)

    session.deadline_monotonic = session.started_monotonic + 10  # under 30 s left
    assert session.check_cue("the bollards are green")["reason"] == "too_late"
    session.finalize()
    assert session.check_cue("the bollards are green")["reason"] == "final"


def test_lint_matches_locate_words_the_lint_reports_in_another_spelling() -> None:
    from astrolabio.cuelint import lint_cue
    from astrolabio.session import lint_matches

    text = "A café near Évora, by the n-125"
    found = {m["word"]: m for m in lint_matches(text, lint_cue(text).problems)}

    # the word comes back as it was typed, so the page can show it beside the problem
    assert text[found["Évora"]["start"] : found["Évora"]["end"]] == "Évora" and "evora" not in found
    assert text[found["n-125"]["start"] : found["n-125"]["end"]] == "n-125"
    assert lint_matches(text, ["place name: 'atlantis'", "not in the usual form"]) == [
        {"category": "place name", "word": "atlantis", "start": None, "end": None}
    ]
    assert lint_cue(text).to_dict() == {"ok": False, "problems": lint_cue(text).problems}  # the verdict is untouched


def test_the_same_cue_is_charged_once(tmp_path: Path) -> None:
    session = human_session(tmp_path)
    session.submit_cue(CUE, confirmed=True)
    before = session.log.path.read_bytes()

    for confirmed in (True, False):
        with pytest.raises(HumanChannelError, match="already sent"):
            session.submit_cue(f" {CUE} ", confirmed=confirmed)

    assert session.ledger.cues == 1 and session.drain_cues() == [CUE]
    assert session.log.path.read_bytes() == before
    # a restart on the same run id remembers what was charged, delivered or not
    again = human_session(tmp_path)
    with pytest.raises(HumanChannelError, match="already sent"):
        again.submit_cue(CUE, confirmed=True)
    assert again.ledger.cues == 1 and again.check_cue(CUE)["reason"] == "duplicate"
    assert again.submit_cue("the bollards are green", confirmed=True)["multiplier_after"] == pytest.approx(0.64)


def test_one_human_geocode_per_panorama(tmp_path: Path) -> None:
    session = human_session(tmp_path)
    session.update_candidates([HYP])
    session.human_geocode(38.71, -9.14, "Baixa")
    before = session.log.path.read_bytes()

    with pytest.raises(HumanChannelError, match="already recorded"):
        session.human_geocode(38.72, -9.15, "Baixa")

    assert session.ledger.human_geocodes == 1 and session.ledger.multiplier == 0.5
    assert session.log.path.read_bytes() == before
    assert {(e.lat, e.lng) for e in session.final or []} == {(38.71, -9.14)}
    again = human_session(tmp_path)  # the override is restored from the log
    with pytest.raises(HumanChannelError, match="already recorded"):
        again.human_geocode(38.72, -9.15, "Baixa")
    assert again.ledger.human_geocodes == 1 and "human_geocode" not in kinds(again)[-1:]


# --- delivery and deadline events -------------------------------------------------------------


def loop_session(tmp_path: Path, **overrides: Any) -> tuple[PanoramaSession, Panorama]:
    session = PanoramaSession(task(tmp_path, "p1", timestamp="20261011093000"), settings(tmp_path, **overrides), "r1")
    return session, Panorama(session.task.path, session.image_dir)


async def test_cue_delivery_is_logged_with_the_turn_that_carries_it(tmp_path: Path) -> None:
    session, pano = loop_session(tmp_path, no_human=False)

    async def cue_arrives() -> Any:
        session.submit_cue(CUE, confirmed=True)
        return update()

    client = ScriptClient(**{"": [update(), cue_arrives, update(), submit()]})
    await run_agent(session, pano, client, budget=FAST)

    (delivered,) = events(session, "human_cue_delivered")
    assert delivered["actor"] == "harness" and delivered["data"] == {"text": CUE, "char_count": len(CUE), "turn": 3}
    assert delivered["penalty_state"]["cues"] == 1
    order = kinds(session)
    requests = [i for i, kind in enumerate(order) if kind == "model_request"]
    assert order.index("human_cue") < order.index("human_cue_delivered") < requests[2]
    carried = events(session, "model_request")[2]["data"]
    assert carried["turn"] == 3 and carried["messages"][0]["content"][-1]["text"] == prompts.cue_message(CUE)
    assert not events(session, "human_cue_undelivered", "soft_deadline_notice")


async def test_cue_arriving_on_the_last_turn_is_undelivered_not_delivered(tmp_path: Path) -> None:
    session, pano = loop_session(tmp_path, no_human=False)

    async def cue_arrives() -> Any:
        session.submit_cue(CUE, confirmed=True)
        return update()

    await run_agent(session, pano, ScriptClient(**{"": [update(), cue_arrives]}), budget=FAST.model_copy(update={"max_turns": 2}))

    assert events(session, "run_end")[0]["data"]["stop_reason"] == "max_turns"
    assert not events(session, "human_cue_delivered")
    (lost,) = events(session, "human_cue_undelivered")
    assert lost["data"]["text"] == CUE and {e.multiplier for e in session.final or []} == {0.8}


async def test_soft_deadline_notice_is_an_event(tmp_path: Path) -> None:
    session, pano = loop_session(tmp_path)
    client = ScriptClient(**{"": [update(), update(), submit()]})

    await run_agent(session, pano, client, budget=FAST.model_copy(update={"soft_deadline_s": 0.0}))

    (notice,) = events(session, "soft_deadline_notice")
    assert notice["actor"] == "harness" and set(notice["data"]) == {"turn", "elapsed_s", "soft_deadline_s"}
    assert notice["data"]["turn"] == 2 and notice["data"]["soft_deadline_s"] == 0.0
    second = events(session, "model_request")[1]["data"]["messages"][0]["content"]
    assert second[-1]["text"] == prompts.COMMIT_NOW_NOTICE

    quiet, pano = loop_session(tmp_path / "quiet")
    await run_agent(quiet, pano, ScriptClient(**{"": [update(), submit()]}), budget=FAST)
    assert not events(quiet, "soft_deadline_notice", "human_cue_delivered")


# --- RunManager: late additions, retry, stop --------------------------------------------------


async def test_panorama_added_while_the_run_is_going_is_run_by_it(tmp_path: Path) -> None:
    client = ScriptClient(a=[HOLD], late=[submit()])
    manager = RunManager(settings(tmp_path), run_id="r1", client=client)
    seen: list[str] = []
    manager.on_session(lambda session: seen.append(session.task.panorama_id))
    manager.add_tasks([task(tmp_path, "a")])
    assert manager.is_running is False and manager.watchdog_remaining_s() is None

    running = manager.start_background(concurrency=2)
    await asyncio.wait_for(client.started.wait(), 5)
    assert manager.is_running is True and manager.snapshot()["finished"] is False
    assert 0 < manager.watchdog_remaining_s() <= manager.settings.global_watchdog_s
    lock = read_run_lock(manager.run_dir)
    assert lock is not None and lock["pid"] == os.getpid() and lock["alive"] and lock["own"]
    assert lock["boot_id"] == manager.boot_id == runner_module.BOOT_ID and lock["started_at"].endswith("Z")

    manager.add_tasks([task(tmp_path, "late")])
    with pytest.raises(ValueError, match="duplicate"):
        manager.add_tasks([task(tmp_path, "late")])
    with pytest.raises(RuntimeError, match="event loop"):
        await asyncio.to_thread(manager.add_tasks, [task(tmp_path, "from_a_thread")])
    with pytest.raises(RuntimeError, match="already started"):
        await manager.start()
    await until(lambda: manager.sessions["late"].final is not None)  # while the first is still in flight
    assert not running.done()
    client.release.set()
    await asyncio.wait_for(running, 10)

    assert seen == ["a", "late"] and "from_a_thread" not in manager.sessions
    assert stop_reasons(manager) == {"a": ["submitted"], "late": ["submitted"]}
    assert manager.is_running is False and manager.snapshot()["finished"] is True
    assert manager.watchdog_remaining_s() is None and not (manager.run_dir / LOCK_NAME).exists()
    assert all(validate_export(json.loads(p.read_text())) == [] for p in manager.export_all()[:2])


async def test_panorama_added_after_the_run_waits_for_the_next_start(tmp_path: Path) -> None:
    client = ScriptClient(**{"": [submit()]})
    manager = RunManager(settings(tmp_path), run_id="r1", client=client)
    manager.add_tasks([task(tmp_path, "a")])
    await manager.start()

    manager.add_tasks([task(tmp_path, "b")])
    assert manager.sessions["b"].status == "pending" and manager.is_running is False
    await manager.start()

    assert stop_reasons(manager) == {"a": ["submitted"], "b": ["submitted"]} and client.calls == {"": 2}


async def test_retry_starts_a_new_conversation_in_the_same_log(tmp_path: Path) -> None:
    client = ScriptClient(**{"": [auth_error(), submit()]})
    manager = RunManager(settings(tmp_path, no_human=False), run_id="r1", client=client)
    created: list[PanoramaSession] = []
    manager.on_session(created.append)
    manager.add_tasks([task(tmp_path, "a")])
    old = manager.sessions["a"]
    old.submit_cue(CUE, confirmed=True)  # x0.8 before the conversation fails
    old.set_mcq_allowed(False)
    old.excluded_image_ids, old.excluded_sequence_ids, old.excluded_point = {"img1"}, {"seq1"}, (38.7, -9.1)  # type: ignore[attr-defined]
    await manager.start()
    assert stop_reasons(manager) == {"a": ["api_error"]} and old.final[0].origin == "harness_fallback"

    new = manager.retry("a")

    assert new is manager.sessions["a"] is created[-1] and new is not old and len(created) == 2
    assert new.log is old.log  # one seq counter, and whoever listens keeps listening
    assert (new.status, new.final, new.ledger.cues, new.ledger.multiplier) == ("pending", None, 1, 0.8)
    assert new.mcq_allowed is False
    assert (new.excluded_image_ids, new.excluded_sequence_ids, new.excluded_point) == ({"img1"}, {"seq1"}, (38.7, -9.1))  # type: ignore[attr-defined]
    tail = events(new)[-2:]
    assert [(e["actor"], e["type"]) for e in tail] == [("harness", "retry"), ("harness", "run_resumed")]
    assert tail[0]["data"] == {"previous_stop_reason": "api_error"} and tail[0]["penalty_state"]["cues"] == 1
    with pytest.raises(ValueError, match="has not ended"):
        manager.retry("a")

    await manager.start()

    assert client.calls == {"": 2} and stop_reasons(manager) == {"a": ["api_error", "submitted"]}
    assert new.final[0].origin == "agent" and {e.multiplier for e in new.final} == {0.8}
    seqs = [e["seq"] for e in events(new)]
    assert seqs == list(range(1, len(seqs) + 1))
    manager.export_all()
    (row,) = manager.summary
    assert (row["multiplier"], row["origin"], row["stop_reason"], row["problems"]) == (0.8, "agent", "submitted", "")
    with pytest.raises(ValueError, match="ended with submitted"):
        manager.retry("a")
    with pytest.raises(KeyError):
        manager.retry("nope")


async def test_retry_while_running_is_scheduled_at_once(tmp_path: Path) -> None:
    client = ScriptClient(bad=[auth_error(), submit()], slow=[HOLD])
    manager = RunManager(settings(tmp_path), run_id="r1", client=client)
    manager.add_tasks([task(tmp_path, "bad"), task(tmp_path, "slow")])
    running = manager.start_background()
    await until(lambda: stop_reasons(manager)["bad"])
    await asyncio.wait_for(client.started.wait(), 5)

    session = manager.retry("bad")
    await until(lambda: session.final is not None)
    client.release.set()
    await asyncio.wait_for(running, 10)

    assert stop_reasons(manager) == {"bad": ["api_error", "submitted"], "slow": ["submitted"]}


async def test_retry_is_refused_where_it_could_not_help(tmp_path: Path) -> None:
    assert RETRYABLE_STOP_REASONS == {"api_error", "panorama_load_failed", "not_started"}
    client = ScriptClient(**{"": [auth_error()]})
    manager = RunManager(settings(tmp_path, no_human=False), run_id="r1", client=client)
    manager.add_tasks([task(tmp_path, "geocoded"), task(tmp_path, "failed")])
    manager.sessions["geocoded"].update_candidates([HYP])
    await manager.start()
    # the geocode is still open after final; once used, a new conversation could only cost money
    manager.sessions["geocoded"].human_geocode(38.71, -9.14, "Baixa")
    with pytest.raises(ValueError, match="human geocode"):
        manager.retry("geocoded")
    assert "retry" not in kinds(manager.sessions["geocoded"])

    manager.stop("operator_stop")  # a run the operator closed stays closed
    with pytest.raises(ValueError, match="run was closed"):
        manager.retry("failed")
    assert "retry" not in kinds(manager.sessions["failed"])


async def test_stop_cancels_in_flight_work_and_ends_every_panorama(tmp_path: Path) -> None:
    client = ScriptClient(**{"": [update(), HOLD]})
    manager = RunManager(settings(tmp_path), run_id="r1", client=client)
    manager.add_tasks([task(tmp_path, name) for name in ("a", "b", "c")])
    running = manager.start_background(concurrency=1)  # two panoramas never leave the queue
    await asyncio.wait_for(client.started.wait(), 5)

    manager.stop("operator_stop")
    assert manager.is_running is False
    manager.add_tasks([task(tmp_path, "too_late")])  # not picked up by the run being stopped
    await asyncio.wait_for(running, 5)  # the model call was cancelled, not waited for

    assert client.calls == {"": 2} and not client.release.is_set()
    assert sorted(sum(stop_reasons(manager).values(), [])) == ["cancelled", "not_started", "not_started"]
    for name in ("a", "b", "c"):
        session = manager.sessions[name]
        assert [e["data"]["reason"] for e in events(session, "final_submission")] == ["operator_stop"]
        assert kinds(session)[-1] == "run_end" and len(session.final or []) == 10
    assert manager.sessions["too_late"].status == "pending"
    in_flight = next(s for s in manager.sessions.values() if events(s, "model_request"))
    assert in_flight.final[0].origin == "agent"  # its best-so-far hypotheses, not the fallback
    assert manager.snapshot()["finished"] is True and not (manager.run_dir / LOCK_NAME).exists()
    paths = manager.export_all()
    assert all(validate_export(json.loads(p.read_text())) == [] for p in paths[:3])
    assert {row["stop_reason"] for row in manager.summary if row["panorama"] != "too_late"} == {"cancelled", "not_started"}


async def test_stop_before_any_start_still_ends_every_panorama(tmp_path: Path) -> None:
    manager = RunManager(settings(tmp_path), run_id="r1", client=ScriptClient(**{"": [submit()]}))
    manager.add_tasks([task(tmp_path, "a"), task(tmp_path, "b")])

    manager.stop("server_shutdown")
    await manager.start()  # nothing is left to run

    assert stop_reasons(manager) == {"a": ["not_started"], "b": ["not_started"]}
    assert all(s.final[0].origin == "harness_fallback" for s in manager.sessions.values())


async def test_finalize_one_panorama_stops_working_on_it(tmp_path: Path) -> None:
    client = ScriptClient(**{"": [update(), HOLD]})
    manager = RunManager(settings(tmp_path), run_id="r1", client=client)
    manager.add_tasks([task(tmp_path, "a"), task(tmp_path, "b")])
    running = manager.start_background(concurrency=1)
    await asyncio.wait_for(client.started.wait(), 5)

    entries = manager.finalize("b", "operator_finalize")  # still queued: it gets its run_end at once
    assert len(entries) == 10 and stop_reasons(manager)["b"] == ["not_started"]
    assert manager.is_running is True and not running.done()

    manager.finalize("a", "operator_finalize")  # in flight: the model call is cancelled
    await asyncio.wait_for(running, 5)

    assert stop_reasons(manager) == {"a": ["cancelled"], "b": ["not_started"]}
    assert [e["data"]["reason"] for e in events(manager.sessions["a"], "final_submission")] == ["operator_finalize"]
    assert client.calls == {"": 2} and not events(manager.sessions["b"], "run_start")
    assert manager.finalize("a", "again") == manager.sessions["a"].final  # idempotent, nothing new is logged
    assert kinds(manager.sessions["a"])[-1] == "run_end"
    with pytest.raises(KeyError):
        manager.finalize("nope", "operator_finalize")


# --- run.lock ---------------------------------------------------------------------------------


def dead_pid() -> int:
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    return process.pid


def write_lock(run_dir: Path, **fields: Any) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / LOCK_NAME).write_text(json.dumps({"boot_id": "other", "started_at": "2026-10-10T10:00:00Z", **fields}))


async def test_a_run_another_process_is_writing_is_refused(tmp_path: Path) -> None:
    config = settings(tmp_path)
    manager = RunManager(config, run_id="r1", client=ScriptClient(**{"": [submit()]}))
    write_lock(manager.run_dir, pid=os.getppid())  # some live process that is not this one

    lock = read_run_lock(manager.run_dir)
    assert lock is not None and lock["alive"] is True and lock["own"] is False
    with pytest.raises(RuntimeError, match="another process"):
        manager.add_tasks([task(tmp_path, "a")])
    assert manager.sessions == {} and not list(manager.run_dir.glob("*.jsonl"))
    with pytest.raises(RuntimeError, match="still being written"):
        recover_run(manager.run_dir, settings=config, tasks={"a": task(tmp_path, "a")})
    assert (manager.run_dir / LOCK_NAME).exists()


async def test_a_stale_lock_does_not_block_the_run(tmp_path: Path) -> None:
    manager = RunManager(settings(tmp_path), run_id="r1", client=ScriptClient(**{"": [submit()]}))
    write_lock(manager.run_dir, pid=dead_pid())
    assert read_run_lock(manager.run_dir)["alive"] is False
    if runner_module._process_started(os.getppid()) is not None:  # needs `ps`
        # a live pid that started at another time is a recycled pid, not the owner
        write_lock(manager.run_dir, pid=os.getppid(), proc_start="Thu Jan  1 00:00:00 1970")
        assert read_run_lock(manager.run_dir)["alive"] is False
    (manager.run_dir / LOCK_NAME).write_text("{torn")
    assert read_run_lock(manager.run_dir) is None and read_run_lock(tmp_path / "nowhere") is None
    write_lock(manager.run_dir, pid=dead_pid())

    manager.add_tasks([task(tmp_path, "a")])
    await manager.start()

    assert stop_reasons(manager) == {"a": ["submitted"]} and not (manager.run_dir / LOCK_NAME).exists()


# --- recovery ---------------------------------------------------------------------------------


async def killed_run(tmp_path: Path, keep_until: tuple[str, int], **overrides: Any) -> tuple[Settings, Path, Path]:
    """A run directory as kill -9 leaves it: the log of panorama "a" cut after the n-th event of
    a type, ending in half a line, and no export."""
    config = settings(tmp_path, **overrides)
    manager = RunManager(config, run_id="r1", client=ScriptClient(**{"": [update(), submit()]}))
    manager.add_tasks([task(tmp_path, "a", special=True, timestamp="20261011093000")])
    if not config.no_human:
        manager.sessions["a"].submit_cue(CUE, confirmed=True)
    await manager.start()
    log_path = manager.sessions["a"].log.path
    lines = log_path.read_text().splitlines()
    kind, nth = keep_until
    cut = [i for i, line in enumerate(lines) if json.loads(line)["type"] == kind][nth - 1]
    log_path.write_text("\n".join(lines[: cut + 1]) + '\n{"schema_version": "1.0", "seq": 999, "ty')
    return config, manager.run_dir, log_path


def read_log(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if not line.endswith('"ty')]


async def test_recover_run_finishes_a_log_cut_after_the_agent_named_a_place(tmp_path: Path) -> None:
    config, run_dir, log_path = await killed_run(tmp_path, ("model_request", 2), no_human=False)
    assert log_is_unfinished(read_log(log_path))
    _, rows = export_run(run_dir, team="albatross")
    assert "no final_submission" in rows[0]["problems"]  # what recovery is for

    # today's defaults point elsewhere; the run directory given is the one that is written
    elsewhere = config.model_copy(update={"runs_dir": tmp_path / "elsewhere"})
    assert recover_run(run_dir, settings=elsewhere) == ["a"]

    assert not (tmp_path / "elsewhere").exists()
    log = read_log(log_path)
    assert len(log) + 1 == len(log_path.read_text().splitlines())  # only the torn line is unreadable
    seqs = [e["seq"] for e in log]
    assert seqs == sorted(set(seqs)) and not log_is_unfinished(log)
    assert [e["type"] for e in log[-3:]] == ["run_resumed", "final_submission", "run_end"]
    final, end = log[-2], log[-1]
    assert final["data"]["reason"] == "recovered_from_provisional" and final["data"]["origin"] == "agent"
    assert {(e["lat"], e["lng"], e["multiplier"]) for e in final["data"]["entries"]} == {(38.7223, -9.1393, 0.8)}
    assert final["data"]["special"] is True
    assert end["data"] == {
        "stop_reason": "recovered_from_provisional", "turns": 1, "tokens": end["data"]["tokens"],
        "cost_usd": end["data"]["cost_usd"], "wall_time_s": end["data"]["wall_time_s"], "final_origin": "agent",
        "recovered": True,
    }  # fmt: skip
    assert end["data"]["tokens"]["input_tokens"] == 1000 and end["data"]["cost_usd"] > 0
    # the penalty charged before the crash is on everything recovery wrote
    assert all(e["penalty_state"] == {"cues": 1, "mcqs": 0, "human_geocodes": 0, "multiplier": 0.8} for e in log[-3:])

    paths, rows = export_run(run_dir, team="albatross")
    doc = json.loads(paths[0].read_text())
    assert validate_export(doc) == [] and rows[0]["problems"] == ""
    assert (rows[0]["label"], rows[0]["special"], rows[0]["stop_reason"], rows[0]["turns"]) == (
        "Urban", True, "recovered_from_provisional", 1,
    )  # fmt: skip
    # a second pass finds nothing to do and writes nothing
    before = log_path.read_bytes()
    assert recover_run(run_dir, settings=config) == [] and log_path.read_bytes() == before


async def test_recover_run_falls_back_when_the_agent_had_said_nothing(tmp_path: Path) -> None:
    config, run_dir, log_path = await killed_run(tmp_path, ("model_request", 1))
    never_started = task(tmp_path, "queued").model_copy(update={"label": Label.NON_URBAN})

    assert recover_run(run_dir, settings=config, tasks={"queued": never_started}) == ["a", "queued"]

    log = read_log(log_path)
    assert log[-2]["data"]["reason"] == log[-1]["data"]["stop_reason"] == "recovered_no_hypotheses"
    assert log[-2]["data"]["origin"] == log[-1]["data"]["final_origin"] == "harness_fallback"
    assert (log[-1]["data"]["turns"], log[-1]["data"]["cost_usd"]) == (0, 0.0)
    queued = read_log(run_dir / "queued.events.jsonl")
    assert [e["type"] for e in queued] == ["final_submission", "run_end"]  # no earlier log to resume
    assert queued[0]["data"]["entries"][0]["lat"] == config.prior_non_urban[0]

    paths, rows = export_run(run_dir, team="albatross", tasks={"queued": never_started})
    assert all(validate_export(json.loads(p.read_text())) == [] for p in paths[:2])
    assert [(r["panorama"], r["label"], r["origin"], r["problems"]) for r in rows] == [
        ("a", "Urban", "harness_fallback", ""), ("queued", "non-Urban", "harness_fallback", ""),
    ]  # fmt: skip


async def test_recover_run_keeps_an_answer_that_was_already_fixed(tmp_path: Path) -> None:
    config, run_dir, log_path = await killed_run(tmp_path, ("final_submission", 1), hedge=False)
    fixed = read_log(log_path)[-1]["data"]

    # other allocator settings would change a recomputed answer; this one is copied, not recomputed
    assert recover_run(run_dir, settings=config.model_copy(update={"allow_duplicates": False})) == ["a"]

    log = read_log(log_path)
    assert [e["type"] for e in log[-3:]] == ["run_resumed", "final_submission", "run_end"]
    assert log[-2]["data"] == {**fixed, "recovered": True} and log[-2]["actor"] == "harness"
    assert log[-1]["data"]["stop_reason"] == "recovered_final" and log[-1]["data"]["final_origin"] == "agent"
    assert log[-1]["data"]["turns"] == 2
    paths, rows = export_run(run_dir, team="albatross")
    assert validate_export(json.loads(paths[0].read_text())) == [] and rows[0]["problems"] == ""


def test_recover_run_leaves_alone_what_it_cannot_identify(tmp_path: Path) -> None:
    run_dir = tmp_path / "runs" / "r1"
    run_dir.mkdir(parents=True)
    orphan = run_dir / "orphan.events.jsonl"
    orphan.write_text(json.dumps({"schema_version": "1.0", "seq": 1, "type": "model_request", "data": {}, "penalty_state": {}}) + "\n")
    write_lock(run_dir, pid=dead_pid())
    before = orphan.read_bytes()

    assert recover_run(run_dir, settings=settings(tmp_path)) == []

    assert orphan.read_bytes() == before and not (run_dir / LOCK_NAME).exists()


def test_an_event_after_a_torn_line_is_not_glued_to_it(tmp_path: Path) -> None:
    path = tmp_path / "p.events.jsonl"
    first = EventLog("r1", "p", path)
    first.emit("harness", "a", {})
    intact = path.read_bytes()
    assert EventLog("r1", "p", path)._seq == 1 and path.read_bytes() == intact  # a whole file is not touched
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"seq": 2, "type": "b"')

    again = EventLog("r1", "p", path)
    again.emit("harness", "c", {})

    assert [(e["seq"], e["type"]) for e in again.events()] == [(1, "a"), (2, "c")]
    assert path.read_text().splitlines()[1] == '{"seq": 2, "type": "b"'
    empty = tmp_path / "empty.events.jsonl"
    empty.write_bytes(b"")
    EventLog("r1", "e", empty)
    assert empty.read_bytes() == b""
