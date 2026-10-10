"""Offline tests for the evaluation harness: metrics on synthetic exports, sampling, image prep."""

from __future__ import annotations

import io
import json
import random
import sys
import types
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np
import pytest
from PIL import Image
from typer.testing import CliRunner

from eval import build_set, run_eval
from eval.build_set import AREAS, Area
from eval.run_eval import Truth
from geoagent.schema import Label, PanoramaTask
from geoagent.tools import schemas

LISBON = (38.713900, -9.139400)
PORTO = (41.145600, -8.611000)
MAX_SCORE = 2000 * sum(0.95**r for r in range(10))  # 16,050.5; the SPEC rounds it to 16,050
M_PER_DEG_LAT = 111_195.08  # one degree of latitude on the SPEC's sphere


def north_of(point: tuple[float, float], metres: float) -> tuple[float, float]:
    return (point[0] + metres / M_PER_DEG_LAT, point[1])


def make_export(
    panorama_id: str,
    points: list[tuple[float, float]],
    *,
    multiplier: float = 1.0,
    origin: str = "agent",
    hypotheses: list[dict[str, Any]] | None = None,
    totals: dict[str, Any] | None = None,
) -> dict[str, Any]:
    locations = [
        {"rank": i, "lat": lat, "lng": lng, "multiplier": multiplier, "origin": origin}
        for i, (lat, lng) in enumerate(points, start=1)
    ]
    events: list[dict[str, Any]] = []
    if hypotheses is not None:
        events.append({"seq": 1, "type": "candidates_update", "t_rel_s": 5.0, "data": {"hypotheses": hypotheses}})
    events.append(
        {
            "seq": 2,
            "type": "final_submission",
            "t_rel_s": 42.0,
            "data": {"entries": locations, "allocator": {"plan": "10x1"}, "origin": origin},
        }
    )
    return {
        "schema_version": "1.0",
        "team": "t",
        "panorama": {"panorama_id": panorama_id},
        "config": {},
        "events": events,
        "final": {"locations": locations, "penalty_state": {"cues": 0, "mcqs": 0, "human_geocodes": 0, "multiplier": multiplier}},
        "totals": {} if totals is None else totals,
    }


def hyp(point: tuple[float, float], probability: float) -> dict[str, Any]:
    return {"lat": point[0], "lng": point[1], "probability": probability, "radius_m": 50.0, "label": "", "evidence": ""}


# --- scoring one export -----------------------------------------------------------------------


def test_exact_hit_scores_the_maximum() -> None:
    score = run_eval.score_export("p", make_export("p", [LISBON] * 10), Truth(*LISBON, Label.URBAN))
    assert score.score == pytest.approx(MAX_SCORE, abs=0.5)
    assert score.max_score == pytest.approx(MAX_SCORE, abs=0.5)
    assert score.rank1_distance_m == pytest.approx(0.0, abs=1e-6)
    assert score.plan == "10x1"


def test_urban_100m_halves_the_score_and_non_urban_barely_moves() -> None:
    doc = make_export("p", [north_of(LISBON, 100.0)] * 10)
    urban = run_eval.score_export("p", doc, Truth(*LISBON, Label.URBAN))
    rural = run_eval.score_export("p", doc, Truth(*LISBON, Label.NON_URBAN))
    assert urban.rank1_distance_m == pytest.approx(100.0, abs=0.1)
    assert urban.score == pytest.approx((MAX_SCORE / 2), rel=1e-3)
    assert rural.score == pytest.approx(MAX_SCORE / 1.01, rel=1e-3)


def test_stamped_multipliers_and_special_are_applied() -> None:
    doc = make_export("p", [LISBON] * 10, multiplier=0.95)
    score = run_eval.score_export("p", doc, Truth(*LISBON, Label.URBAN, special=True))
    assert score.score == pytest.approx(3 * 0.95 * MAX_SCORE, abs=0.5)
    assert score.max_score == pytest.approx(3 * MAX_SCORE, abs=0.5)
    assert score.multiplier == 0.95


def test_rank1_and_best_distance_differ_for_a_split_list() -> None:
    doc = make_export("p", [PORTO] * 6 + [LISBON] * 4)
    score = run_eval.score_export("p", doc, Truth(*LISBON, Label.URBAN))
    assert score.rank1_distance_m > 250_000
    assert score.best_distance_m == pytest.approx(0.0, abs=1e-6)
    # ranks 7-10 hit exactly: 2000 * (0.95^6 + ... + 0.95^9), plus a negligible tail from Porto
    assert score.score == pytest.approx(2000 * sum(0.95**r for r in range(6, 10)), rel=1e-2)


def test_export_without_an_answer_scores_zero() -> None:
    doc = make_export("p", [])
    score = run_eval.score_export("p", doc, Truth(*LISBON, Label.URBAN))
    assert (score.score, score.rank1_distance_m, score.origin) == (0.0, None, "none")


def test_cost_and_time_come_from_totals_with_event_fallback() -> None:
    with_totals = make_export("p", [LISBON] * 10, totals={"cost_usd": 1.25, "wall_time_s": 300.0, "turns": 12})
    assert run_eval.export_cost_time(with_totals) == (1.25, 300.0, 12)
    assert run_eval.export_cost_time(make_export("p", [LISBON] * 10)) == (None, 42.0, None)


# --- aggregation ------------------------------------------------------------------------------


def synthetic_run() -> tuple[dict[str, dict[str, Any]], dict[str, Truth]]:
    offsets = {"u_hit": 0.0, "u_50m": 50.0, "u_500m": 500.0, "u_5km": 5_000.0}
    exports = {
        pid: make_export(pid, [north_of(LISBON, d)] * 10, totals={"cost_usd": 1.0, "wall_time_s": 100.0})
        for pid, d in offsets.items()
    }
    truths = {pid: Truth(*LISBON, Label.URBAN) for pid in offsets}
    exports["r_5km"] = make_export("r_5km", [north_of(PORTO, 5_000.0)] * 10, totals={"cost_usd": 3.0, "wall_time_s": 200.0})
    exports["r_50km"] = make_export("r_50km", [north_of(PORTO, 50_000.0)] * 10)
    truths["r_5km"] = Truth(*PORTO, Label.NON_URBAN)
    truths["r_50km"] = Truth(*PORTO, Label.NON_URBAN)
    exports["not_in_manifest"] = make_export("not_in_manifest", [LISBON] * 10)
    return exports, truths


def test_summary_splits_by_label() -> None:
    exports, truths = synthetic_run()
    scores = run_eval.score_run(exports, truths)
    summary = run_eval.summarise(scores)

    assert [s.panorama_id for s in scores] == sorted(truths)
    assert (summary["all"]["n"], summary["Urban"]["n"], summary["non-Urban"]["n"]) == (6, 4, 2)

    urban = summary["Urban"]
    assert (urban["within_100m"], urban["within_1km"], urban["within_10km"]) == (0.5, 0.75, 1.0)
    assert urban["median_rank1_distance_m"] == pytest.approx(275.0, abs=1.0)
    expected_mean = MAX_SCORE * (1 + 1 / 1.5 + 1 / 6 + 1 / 51) / 4
    assert urban["mean_score"] == pytest.approx(expected_mean, rel=1e-3)
    assert urban["score_share_of_max"] == pytest.approx(expected_mean / MAX_SCORE, rel=1e-3)
    assert (urban["mean_cost_usd"], urban["total_cost_usd"], urban["mean_time_s"]) == (1.0, 4.0, 100.0)

    rural = summary["non-Urban"]
    assert (rural["within_100m"], rural["within_1km"], rural["within_10km"]) == (0.0, 0.0, 0.5)
    assert rural["mean_score"] == pytest.approx(MAX_SCORE * (1 / 1.5 + 1 / 6) / 2, rel=1e-3)
    # cost is averaged over the panoramas that report one; time falls back to the last event
    assert rural["mean_cost_usd"] == 3.0
    assert rural["mean_time_s"] == pytest.approx((200.0 + 42.0) / 2)

    assert summary["all"]["total_score"] == pytest.approx(urban["total_score"] + rural["total_score"])


def test_missing_answer_counts_as_a_miss() -> None:
    scores = run_eval.score_run(
        {"a": make_export("a", [LISBON] * 10), "b": make_export("b", [])},
        {"a": Truth(*LISBON, Label.URBAN), "b": Truth(*LISBON, Label.URBAN)},
    )
    summary = run_eval.summarise_group(scores)
    assert summary["within_100m"] == 0.5
    assert summary["mean_score"] == pytest.approx((MAX_SCORE / 2), abs=0.5)


def test_empty_group_has_no_metrics() -> None:
    summary = run_eval.summarise([])
    assert summary["all"]["n"] == 0
    assert summary["all"]["mean_score"] is None
    assert "-" in run_eval.format_table(summary)


def test_table_lists_every_group() -> None:
    exports, truths = synthetic_run()
    table = run_eval.format_table(run_eval.summarise(run_eval.score_run(exports, truths)))
    lines = table.splitlines()
    assert [line.split()[0] for line in lines] == ["group", "all", "Urban", "non-Urban"]
    assert "<=100m" in lines[0] and "50%" in lines[2]


# --- re-allocation (hedge on/off offline) -----------------------------------------------------


def test_hypotheses_are_recovered_from_the_log() -> None:
    doc = make_export("p", [LISBON] * 10, hypotheses=[hyp(LISBON, 0.6), hyp(PORTO, 0.4)])
    assert [h.probability for h in run_eval.logged_hypotheses(doc["events"])] == [0.6, 0.4]

    tool_call = {"type": "tool_call", "data": {"name": "submit_locations", "input": {"hypotheses": [hyp(PORTO, 1.0)]}}}
    invalid = {"type": "candidates_update", "data": {"hypotheses": [{"lat": 999, "lng": 0, "probability": 1}]}}
    recovered = run_eval.logged_hypotheses([*doc["events"], tool_call, invalid])
    assert [(h.lat, h.lng) for h in recovered] == [PORTO]
    assert run_eval.logged_hypotheses(make_export("p", [LISBON] * 10)["events"]) is None


def test_rescore_with_hedge_recovers_the_second_hypothesis() -> None:
    # The agent's top pick is wrong and the truth is its close second: v_2 / v_1 = 0.9.
    hypotheses = [hyp(PORTO, 0.5), hyp(LISBON, 0.45), hyp((43.0, -2.0), 0.05)]
    exports = {"p": make_export("p", [PORTO] * 10, multiplier=0.95, hypotheses=hypotheses)}
    truths = {"p": Truth(*LISBON, Label.URBAN)}

    logged = run_eval.score_run(exports, truths)[0]
    unhedged = run_eval.score_run(exports, truths, hedge=False)[0]
    hedged = run_eval.score_run(exports, truths, hedge=True)[0]

    assert unhedged.score == pytest.approx(logged.score)
    assert (unhedged.plan, hedged.plan) == ("10x1", "6x1+4x2")
    assert hedged.score == pytest.approx(0.95 * 2000 * sum(0.95**r for r in range(6, 10)), rel=1e-2)
    assert hedged.multiplier == 0.95
    assert hedged.rank1_distance_m == pytest.approx(logged.rank1_distance_m)


def test_reallocation_keeps_human_geocodes_and_hypothesis_free_answers() -> None:
    geocoded = make_export("p", [LISBON] * 10, origin="human_geocode", hypotheses=[hyp(PORTO, 1.0)])
    assert run_eval.reallocate(geocoded, Label.URBAN, hedge=True, allow_duplicates=True) is None
    fallback = make_export("p", [LISBON] * 10, origin="harness_fallback")
    assert run_eval.reallocate(fallback, Label.URBAN, hedge=True, allow_duplicates=True) is None


def test_distinct_reallocation_yields_ten_distinct_entries() -> None:
    doc = make_export("p", [LISBON] * 10, hypotheses=[hyp(LISBON, 1.0)])
    entries, plan = run_eval.reallocate(doc, Label.URBAN, hedge=False, allow_duplicates=False)
    assert plan == "distinct"
    assert len({(e["lat"], e["lng"]) for e in entries}) == 10
    assert [e["rank"] for e in entries] == list(range(1, 11))


# --- results files, compare, CLI --------------------------------------------------------------


def write_run(tmp_path: Path) -> tuple[Path, Path]:
    """A run directory of synthetic exports plus a data directory with the matching manifest."""
    run_dir, data_dir = tmp_path / "runs" / "r1", tmp_path / "data"
    run_dir.mkdir(parents=True)
    hypotheses = [hyp(PORTO, 0.5), hyp(LISBON, 0.45), hyp((43.0, -2.0), 0.05)]
    exports = {
        "mly_1": make_export("mly_1", [PORTO] * 10, hypotheses=hypotheses, totals={"cost_usd": 2.0}),
        "mly_2": make_export("mly_2", [north_of(PORTO, 2_000.0)] * 10),
    }
    for pid, doc in exports.items():
        (run_dir / f"{pid}.json").write_text(json.dumps(doc))
    (run_dir / "summary.json").write_text(json.dumps({"not": "an export"}))
    manifest = [
        {"panorama_id": "mly_1", "filename": "mly_1.jpg", "lat": LISBON[0], "lng": LISBON[1], "label": "Urban",
         "timestamp": "20250601120000", "source_image_id": "1", "sequence": "s1"},
        {"panorama_id": "mly_2", "filename": "mly_2.jpg", "lat": PORTO[0], "lng": PORTO[1], "label": "non-Urban",
         "timestamp": "20250601120000", "source_image_id": "2", "sequence": "s2"},
    ]
    build_set.save_manifest(data_dir / "manifest.json", manifest)
    return run_dir, data_dir


def test_rescore_and_compare_commands(tmp_path: Path) -> None:
    run_dir, data_dir = write_run(tmp_path)
    runner = CliRunner()

    plain = runner.invoke(run_eval.app, ["rescore", str(run_dir), "--data", str(data_dir)])
    assert plain.exit_code == 0, plain.output
    assert "non-Urban" in plain.output
    hedged = runner.invoke(run_eval.app, ["rescore", str(run_dir), "--data", str(data_dir), "--hedge"])
    assert hedged.exit_code == 0, hedged.output

    baseline = json.loads((run_dir / "results.rescore.json").read_text())
    candidate = json.loads((run_dir / "results.hedge.json").read_text())
    assert baseline["config"]["reallocated"] is False and candidate["config"]["hedge"] is True
    assert [p["panorama_id"] for p in baseline["panoramas"]] == ["mly_1", "mly_2"]
    assert candidate["summary"]["Urban"]["mean_score"] > baseline["summary"]["Urban"]["mean_score"]
    rows = (run_dir / "results.hedge.csv").read_text().splitlines()
    assert rows[0].startswith("panorama_id,label,special,score") and len(rows) == 3

    comparison = run_eval.compare_results(baseline, candidate)
    assert comparison["paired"]["n"] == 2
    assert (comparison["paired"]["b_better"], comparison["paired"]["a_better"], comparison["paired"]["ties"]) == (1, 0, 1)
    assert comparison["groups"]["Urban"]["mean_score"]["delta"] > 0
    assert comparison["groups"]["non-Urban"]["mean_score"]["delta"] == pytest.approx(0.0)

    shown = runner.invoke(
        run_eval.app, ["compare", str(run_dir / "results.rescore.json"), str(run_dir / "results.hedge.json")]
    )
    assert shown.exit_code == 0, shown.output
    assert "b better on 1" in shown.output


def test_rescore_rejects_unlabelled_manifest(tmp_path: Path) -> None:
    run_dir, data_dir = write_run(tmp_path)
    entries = build_set.load_manifest(data_dir / "manifest.json")
    entries[1]["label"] = "TODO"
    build_set.save_manifest(data_dir / "manifest.json", entries)
    result = CliRunner().invoke(run_eval.app, ["rescore", str(run_dir), "--data", str(data_dir)])
    assert result.exit_code == 2
    assert "mly_2" in result.output


def test_tasks_from_manifest(tmp_path: Path) -> None:
    _, data_dir = write_run(tmp_path)
    tasks = run_eval.tasks_from_manifest(build_set.load_manifest(data_dir / "manifest.json"), data_dir)
    assert [(t.panorama_id, t.label, t.path.name, t.special) for t in tasks] == [
        ("mly_1", Label.URBAN, "mly_1.jpg", False),
        ("mly_2", Label.NON_URBAN, "mly_2.jpg", False),
    ]
    assert tasks[0].timestamp == "20250601120000"


# --- running: leak guards, settings, tool ablation --------------------------------------------


class FakeSession:
    pass


class FakeManager:
    def __init__(self, eager: bool = True) -> None:
        self.sessions: dict[str, FakeSession] = {}
        self.eager = eager
        self.started_with: int | None = None
        self.guards_at_start: dict[str, tuple[set[str], tuple[float, float]]] = {}

    def add_tasks(self, tasks: list[PanoramaTask]) -> None:
        if self.eager:
            self.sessions.update({t.panorama_id: FakeSession() for t in tasks})

    async def start(self, concurrency: int | None = None) -> None:
        self.started_with = concurrency
        self.guards_at_start = {
            pid: (s.excluded_image_ids, s.excluded_point) for pid, s in self.sessions.items()  # type: ignore[attr-defined]
        }

    def export_all(self) -> list[Path]:
        return [Path(f"{pid}.json") for pid in self.sessions]


def eval_tasks() -> tuple[list[PanoramaTask], dict[str, Truth]]:
    tasks = [PanoramaTask(panorama_id="mly_1", path=Path("mly_1.jpg"), label=Label.URBAN)]
    truths = {
        "mly_1": Truth(*LISBON, Label.URBAN, source_image_id="1"),
        "mly_2": Truth(*PORTO, Label.NON_URBAN, source_image_id="2"),
    }
    return tasks, truths


async def test_leak_guards_are_set_before_the_run_starts() -> None:
    tasks, truths = eval_tasks()
    manager = FakeManager()
    exported = await run_eval.drive(manager, tasks, truths, 3)
    assert manager.started_with == 3
    assert manager.guards_at_start == {"mly_1": ({"1"}, LISBON)}
    assert exported == [Path("mly_1.json")]


async def test_run_refuses_to_start_without_leak_guards() -> None:
    tasks, truths = eval_tasks()
    manager = FakeManager(eager=False)
    with pytest.raises(RuntimeError, match="mly_1"):
        await run_eval.drive(manager, tasks, truths, None)
    assert manager.started_with is None


def test_eval_settings_overrides(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HEDGE", "false")
    settings = run_eval.eval_settings(effort="medium", hedge=True, allow_web=False, runs_dir=tmp_path)
    assert (settings.no_human, settings.hedge, settings.allow_web, settings.runs_dir) == (True, True, False, tmp_path)
    assert (settings.standard.effort, settings.special.effort) == ("medium", "medium")
    assert settings.standard.max_turns == 30
    assert run_eval.eval_settings(effort=None, hedge=False, allow_web=True, runs_dir=None).special.effort == "xhigh"


@pytest.fixture
def tool_tables(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    """Isolate disable_tools: copies of the schema lists and a stand-in handler registry."""
    for name in ("LOCAL_TOOLS", "HUMAN_TOOLS", "WEB_CLIENT_TOOLS"):
        monkeypatch.setattr(schemas, name, list(getattr(schemas, name)))
    monkeypatch.setattr(schemas, "server_tools", schemas.server_tools)
    registry = types.ModuleType("geoagent.tools.registry")
    registry.HANDLERS = {"satellite_tile": object(), "view_crop": object()}  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "geoagent.tools.registry", registry)
    monkeypatch.setattr("geoagent.tools.registry", registry, raising=False)
    return registry


async def test_disable_tools_removes_definitions_and_handlers(tool_tables: types.ModuleType) -> None:
    from geoagent.config import Settings

    untouched = tool_tables.HANDLERS["view_crop"]
    assert run_eval.disable_tools(["satellite_tile", " web_search", ""]) == ["satellite_tile", "web_search"]

    names = [tool["name"] for tool in schemas.tool_definitions(Settings())]
    assert "satellite_tile" not in names and "web_search" not in names
    assert {"view_crop", "streetview_lookup", "web_fetch", "submit_locations"} <= set(names)
    assert tool_tables.HANDLERS["view_crop"] is untouched
    result = await tool_tables.HANDLERS["satellite_tile"](None, {})
    assert result.is_error


def test_disable_tools_rejects_unknown_and_protected(tool_tables: types.ModuleType) -> None:
    with pytest.raises(ValueError, match="unknown tools: teleport"):
        run_eval.disable_tools(["teleport"])
    with pytest.raises(ValueError, match="submit_locations"):
        run_eval.disable_tools(["submit_locations"])
    assert run_eval.disable_tools([]) == []


# --- build_set --------------------------------------------------------------------------------


def raw_image(image_id: str, *, sequence: str = "seq", is_pano: bool = True) -> dict[str, Any]:
    return {
        "id": image_id,
        "computed_geometry": {"type": "Point", "coordinates": [-9.14, 38.71]},
        "geometry": {"type": "Point", "coordinates": [-9.15, 38.72]},
        "captured_at": 1_717_243_200_000,  # 2024-06-01 12:00:00 UTC
        "is_pano": is_pano,
        "thumb_original_url": f"https://cdn.example/{image_id}.jpg",
        "thumb_2048_url": f"https://cdn.example/{image_id}_2048.jpg",
        "sequence": sequence,
        "creator": {"username": "alice", "id": "9"},
    }


def test_builtin_areas_cover_the_scope() -> None:
    assert 55 <= len(AREAS) <= 80
    assert len({a.name for a in AREAS}) == len(AREAS)
    assert {a.country for a in AREAS} == {"PT", "ES", "FR"}
    assert {a.kind for a in AREAS} == {"city", "town", "village", "rural", "track"}
    assert any(a.lng < -15 for a in AREAS) and any(a.country == "FR" and a.lng > 8 for a in AREAS)  # islands
    for area in AREAS:
        min_lng, min_lat, max_lng, max_lat = area.bbox
        assert (max_lng - min_lng) * (max_lat - min_lat) < 0.01
        assert 27 < area.lat < 52 and -32 < area.lng < 10


def test_normalise_image() -> None:
    area = Area("Somewhere", "PT", 38.71, -9.14, "village")
    candidate = build_set.normalise_image(raw_image("42"), area)
    assert (candidate["lat"], candidate["lng"]) == (38.71, -9.14)  # computed_geometry wins
    assert candidate["timestamp"] == "20240601120000"
    assert (candidate["url"], candidate["creator"]) == ("https://cdn.example/42.jpg", "alice")
    assert candidate["label_guess"] == "TODO"

    assert build_set.normalise_image(raw_image("43", is_pano=False), area) is None
    no_computed = {**raw_image("44"), "computed_geometry": None, "thumb_original_url": None}
    fallback = build_set.normalise_image(no_computed, Area("Town", "ES", 0, 0, "town"))
    assert (fallback["lat"], fallback["lng"], fallback["url"]) == (38.72, -9.15, "https://cdn.example/44_2048.jpg")
    assert fallback["label_guess"] == "Urban"
    assert build_set.normalise_image({**raw_image("45"), "computed_geometry": None, "geometry": None}, area) is None


def test_manifest_entry_shape() -> None:
    candidate = build_set.normalise_image(raw_image("42"), Area("Plain", "PT", 38.71, -9.14, "rural"))
    entry = build_set.manifest_entry(candidate)
    shown = build_set.opaque_id("42")
    assert {
        "panorama_id": shown, "filename": f"{shown}.jpg", "lat": 38.71, "lng": -9.14, "label": "non-Urban",
        "timestamp": "20240601120000", "source_image_id": "42", "sequence": "seq",
    }.items() <= entry.items()
    assert entry["label_confirmed"] is False


def test_eval_panorama_id_does_not_reveal_the_mapillary_image() -> None:
    """The id is printed to the agent in the task text; the image key stays in the manifest."""
    key = "1234567890123456"
    shown = build_set.opaque_id(key)
    assert shown.startswith("eval_") and key not in shown and "mly" not in shown
    assert shown == build_set.opaque_id(key) != build_set.opaque_id("1234567890123457")


def test_fetch_area_sends_the_documented_query() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": [raw_image("1"), raw_image("2", is_pano=False)]})

    area = AREAS[0]
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        candidates = build_set.fetch_area(client, "tok", area, limit=7)

    assert [c["id"] for c in candidates] == ["1"]
    request = seen[0]
    assert request.url.host == "graph.mapillary.com" and request.url.path == "/images"
    assert request.headers["Authorization"] == "OAuth tok"
    assert "tok" not in str(request.url)
    params = request.url.params
    assert params["fields"] == build_set.FIELDS and params["is_pano"] == "true" and params["limit"] == "7"
    assert [float(v) for v in params["bbox"].split(",")] == pytest.approx(list(area.bbox))


def candidates_by_area() -> dict[str, list[dict[str, Any]]]:
    return {
        name: [{"id": f"{name}{i}", "sequence": f"{name}-seq{i // 2}"} for i in range(6)]
        for name in ("a", "b", "c", "d")
    }


def test_sampling_is_deterministic_and_balanced() -> None:
    first = build_set.sampling_order(candidates_by_area(), random.Random(11))
    shuffled_input = {k: list(reversed(v)) for k, v in reversed(candidates_by_area().items())}
    again = build_set.sampling_order(shuffled_input, random.Random(11))
    other = build_set.sampling_order(candidates_by_area(), random.Random(12))

    assert [c["id"] for c in first] == [c["id"] for c in again]
    assert [c["id"] for c in first] != [c["id"] for c in other]
    assert sorted(c["id"][0] for c in first[:4]) == ["a", "b", "c", "d"]  # one per area before any repeat
    sequences = [c["sequence"] for c in first]
    assert len(sequences) == len(set(sequences)) == 12  # 3 sequences per area, one image each


def test_sampling_handles_empty_areas() -> None:
    order = build_set.sampling_order({"a": [], "b": [{"id": "b1", "sequence": ""}, {"id": "b2", "sequence": ""}]}, random.Random(0))
    assert sorted(c["id"] for c in order) == ["b1", "b2"]  # images without a sequence id are not deduplicated
    assert build_set.sampling_order({}, random.Random(0)) == []


def jpeg_with_exif(width: int, height: int) -> bytes:
    exif = Image.Exif()
    exif[0x010F] = "SecretCameraMaker"
    exif[0x8825] = {1: "N", 2: (38.0, 42.0, 50.0)}  # GPS IFD
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (90, 140, 200)).save(buffer, "JPEG", exif=exif)
    return buffer.getvalue()


def test_prepare_image_resizes_and_strips_metadata() -> None:
    raw = jpeg_with_exif(800, 400)
    assert b"SecretCameraMaker" in raw
    prepared = build_set.prepare_image(raw)

    assert b"SecretCameraMaker" not in prepared and b"Exif" not in prepared
    assert len(Image.open(io.BytesIO(prepared)).getexif()) == 0
    decoded = cv2.imdecode(np.frombuffer(prepared, np.uint8), cv2.IMREAD_COLOR)
    assert decoded.shape == (3040, 6080, 3)


def test_prepare_image_rejects_non_panoramas() -> None:
    assert build_set.prepare_image(jpeg_with_exif(640, 480)) is None
    assert build_set.prepare_image(b"not an image") is None


def test_download_set_skips_failures_until_count(tmp_path: Path) -> None:
    good = jpeg_with_exif(400, 200)
    bodies = {"/1.jpg": httpx.Response(404), "/2.jpg": httpx.Response(200, content=jpeg_with_exif(300, 300)),
              "/3.jpg": httpx.Response(200, content=good), "/4.jpg": httpx.Response(200, content=good),
              "/5.jpg": httpx.Response(200, content=good)}
    area = Area("Plain", "PT", 38.71, -9.14, "rural")
    order = [build_set.normalise_image(raw_image(str(i)), area) for i in range(1, 6)]

    with httpx.Client(transport=httpx.MockTransport(lambda request: bodies[request.url.path])) as client:
        entries = build_set.download_set(client, order, 2, tmp_path)

    assert [e["source_image_id"] for e in entries] == ["3", "4"]
    names = sorted(p.name for p in tmp_path.iterdir())
    assert names == sorted(f"{build_set.opaque_id(i)}.jpg" for i in ("3", "4"))
    # The id the agent sees (task text, file name) gives away neither the source nor its image key.
    for entry in entries:
        shown = entry["panorama_id"]
        assert shown.startswith("eval_") and "mly" not in shown and entry["filename"] == f"{shown}.jpg"


def test_set_label_and_manifest_roundtrip(tmp_path: Path) -> None:
    path = tmp_path / "manifest.json"
    build_set.save_manifest(path, [{"panorama_id": "mly_1", "source_image_id": "1", "label": "TODO", "label_confirmed": False}])
    entries = build_set.load_manifest(path)

    assert build_set.set_label(entries, "1", "rural")["label"] == "non-Urban"
    assert entries[0]["label_confirmed"] is True
    with pytest.raises(KeyError):
        build_set.set_label(entries, "nope", "Urban")
    with pytest.raises(ValueError):
        build_set.set_label(entries, "mly_1", "suburban")

    path.write_text(json.dumps({"panoramas": entries}))
    assert build_set.load_manifest(path) == entries


def test_label_command(tmp_path: Path) -> None:
    build_set.save_manifest(
        tmp_path / "manifest.json",
        [{"panorama_id": "mly_1", "source_image_id": "1", "label": "TODO", "label_confirmed": False, "kind": "village", "area": "X"}],
    )
    runner = CliRunner()
    assert "TODO" in runner.invoke(build_set.app, ["label", "--data", str(tmp_path)]).output
    done = runner.invoke(build_set.app, ["label", "mly_1", "Urban", "--data", str(tmp_path)])
    assert done.exit_code == 0, done.output
    assert build_set.load_manifest(tmp_path / "manifest.json")[0]["label"] == "Urban"
    assert runner.invoke(build_set.app, ["label", "mly_1", "nowhere", "--data", str(tmp_path)]).exit_code == 2
    assert runner.invoke(build_set.app, ["label", "mly_9", "Urban", "--data", str(tmp_path)]).exit_code == 2


def test_build_fails_clearly_without_a_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAPILLARY_TOKEN", "")
    result = CliRunner().invoke(build_set.app, ["build", "--out", str(tmp_path)])
    assert result.exit_code == 2
    assert "MAPILLARY_TOKEN is not set" in result.output
    assert list(tmp_path.iterdir()) == []


def test_leak_guards_exclude_the_source_sequence() -> None:
    manifest = [
        {"panorama_id": "eval_a", "filename": "eval_a.jpg", "lat": LISBON[0], "lng": LISBON[1], "label": "Urban",
         "source_image_id": "1", "sequence": "drive-7"},
        {"panorama_id": "eval_b", "filename": "eval_b.jpg", "lat": PORTO[0], "lng": PORTO[1], "label": "Urban",
         "source_image_id": "2"},
    ]  # fmt: skip
    truths = run_eval.truths_from_manifest(manifest)
    assert truths["eval_a"].sequence == "drive-7" and truths["eval_b"].sequence == ""
    sessions = {"eval_a": types.SimpleNamespace(), "eval_b": types.SimpleNamespace()}
    run_eval.apply_leak_guards(sessions, truths)
    assert sessions["eval_a"].excluded_sequence_ids == {"drive-7"}
    assert sessions["eval_a"].excluded_image_ids == {"1"} and sessions["eval_a"].excluded_point == LISBON
    assert sessions["eval_b"].excluded_sequence_ids == set()
