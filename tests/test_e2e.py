"""Offline end-to-end batch: RunManager + agent loop + real tools + operator API + export.

Two synthetic panoramas (one Urban Special One, one non-Urban) are driven by a scripted fake
model. HTTP goes through httpx.MockTransport and the MCQ is answered through the server API,
exactly as the operator's click would be. No network, no API key.

Set GEOAGENT_WRITE_SAMPLE=<path> to also write the Special One's export there (this is how
docs/sample_export.json is produced).
"""

from __future__ import annotations

import asyncio
import base64
import csv
import io
import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import cv2
import httpx
import numpy as np
import pytest
from PIL import Image

from eval.run_eval import Truth, load_exports, score_run
from geoagent import runner as runner_module
from geoagent.config import Settings
from geoagent.eventlog import validate_export
from geoagent.runner import RunManager, export_run, load_tasks
from geoagent.schema import Label
from geoagent.scoring import haversine_m
from server.app import create_app

SAMPLE_ENV = "GEOAGENT_WRITE_SAMPLE"
SPECIAL_ID, RURAL_ID = "pano_a", "pano_b"

ALFAMA = {
    "lat": 38.713909,
    "lng": -9.133476,
    "probability": 0.5,
    "radius_m": 30.0,
    "label": "Alfama, by the cafe",
    "evidence": "synthetic fixture: tram wires, tiled facades",
}
RIBEIRA = {
    "lat": 41.140600,
    "lng": -8.611000,
    "probability": 0.4,
    "radius_m": 60.0,
    "label": "Ribeira quay",
    "evidence": "synthetic fixture: granite quay, river to the south",
}
SERRA = {
    "lat": 40.321800,
    "lng": -7.612500,
    "probability": 0.7,
    "radius_m": 4000.0,
    "label": "Serra plateau",
    "evidence": "synthetic fixture: granite boulders, heather, no trees",
}
NOMINATIM_HIT = {
    "lat": "38.7139092",
    "lon": "-9.1334762",
    "name": "Pastelaria Santo António",
    "category": "amenity",
    "type": "cafe",
    "display_name": "Pastelaria Santo António, Rua do Milagre, Lisboa, Portugal",
    "address": {"road": "Rua do Milagre de Santo António", "city": "Lisboa", "country": "Portugal"},
}


def tool_use(name: str, input_: dict[str, Any], id_: str) -> SimpleNamespace:
    return SimpleNamespace(type="tool_use", id=id_, name=name, input=input_)


def thinking(text: str) -> SimpleNamespace:
    return SimpleNamespace(type="thinking", thinking=text, signature="sig-fixture")


def message(*blocks: Any) -> SimpleNamespace:
    usage = SimpleNamespace(
        input_tokens=4000,
        output_tokens=300,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=20000,
        server_tool_use=None,
    )
    return SimpleNamespace(
        id="msg_fixture",
        model="claude-opus-5-5",
        content=list(blocks),
        stop_reason="tool_use",
        stop_details=None,
        usage=usage,
    )


SEARCH = {"query": "Pastelaria Santo António", "countrycodes": "pt", "viewbox": ""}
SCRIPTS: dict[str, list[SimpleNamespace]] = {
    SPECIAL_ID: [
        message(
            thinking("Scripted test fixture. Two candidate cities; zoom on the shop sign first."),
            tool_use("view_crop", {"yaw": 350.0, "pitch": 5.0, "fov": 20.0, "enhance": True}, "toolu_a1"),
            tool_use("update_candidates", {"hypotheses": [ALFAMA, RIBEIRA]}, "toolu_a2"),
        ),
        message(tool_use("search_places", SEARCH, "toolu_a3")),
        message(
            tool_use(
                "ask_multiple_choice",
                {
                    "question": "Which street-level view matches the panorama?",
                    "options": ["Narrow lane with tram rails and a blue-tiled cafe", "Wide granite quay on a river"],
                    "why_it_matters": "Option 1 confirms the first hypothesis, option 2 the second.",
                },
                "toolu_a4",
            )
        ),
        message(
            tool_use(
                "submit_locations",
                {
                    "hypotheses": [{**ALFAMA, "probability": 0.9}, {**RIBEIRA, "probability": 0.05}],
                    "reasoning_summary": "Scripted fixture: sign geocoded, operator confirmed the lane.",
                },
                "toolu_a5",
            )
        ),
    ],
    RURAL_ID: [
        message(tool_use("view_crop", {"yaw": 90.0, "pitch": -10.0, "fov": 60.0, "enhance": False}, "toolu_b1")),
        message(
            tool_use("update_candidates", {"hypotheses": [SERRA]}, "toolu_b2"),
            tool_use("search_places", {"query": "Serra plateau", "countrycodes": "", "viewbox": ""}, "toolu_b3"),
        ),
        message(
            tool_use(
                "submit_locations",
                {"hypotheses": [SERRA], "reasoning_summary": "Scripted fixture: upland granite."},
                "toolu_b4",
            )
        ),
    ],
}


def _dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True, default=vars)


class ScriptedClient:
    """Routes each request to its panorama's script and records what was sent."""

    def __init__(self) -> None:
        self.calls: dict[str, list[dict[str, Any]]] = {SPECIAL_ID: [], RURAL_ID: []}

    async def create(self, **params: Any) -> Any:
        first = params["messages"][0]["content"][0]["text"]
        panorama_id = next(pid for pid in self.calls if f"Panorama {pid}." in first)
        calls = self.calls[panorama_id]
        calls.append(
            {
                "fixed": _dump({k: v for k, v in params.items() if k != "messages"}),
                "messages": [_dump(m) for m in params["messages"]],
                "params": {k: v for k, v in params.items() if k != "messages"},
                "raw_messages": list(params["messages"]),
            }
        )
        await asyncio.sleep(0)
        return SCRIPTS[panorama_id][len(calls) - 1]


def write_pano(path: Path, seed: int) -> None:
    rng = np.random.default_rng(seed)
    image = cv2.resize(rng.integers(0, 255, (16, 32, 3), dtype=np.uint8), (1024, 512), interpolation=cv2.INTER_CUBIC)
    assert cv2.imwrite(str(path), image)


def geocoder(requests: list[httpx.Request]) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.host == "nominatim.openstreetmap.org":
            hit = "Pastelaria" in request.url.params.get("q", "")
            return httpx.Response(200, json=[NOMINATIM_HIT] if hit else [])
        if request.url.host == "photon.komoot.io":
            return httpx.Response(200, json={"features": []})
        return httpx.Response(404)

    return httpx.MockTransport(handle)


async def click_first_mcq(api: httpx.AsyncClient, index: int) -> dict[str, Any]:
    """The operator: wait for a question to appear on the page state, then click one button."""
    for _ in range(2000):
        state = (await api.get("/api/state")).json()
        for tile in state["panoramas"]:
            if tile["pending_mcq"]:
                mcq = tile["pending_mcq"]
                url = f"/api/pano/{tile['panorama_id']}/mcq/{mcq['id']}/answer"
                response = await api.post(url, json={"index": index})
                assert response.status_code == 200, response.text
                return {"panorama_id": tile["panorama_id"], **mcq}
        await asyncio.sleep(0.01)
    raise AssertionError("no MCQ appeared")


def image_sizes(messages: list[Any]) -> list[tuple[int, int]]:
    sizes = []
    for msg in messages:
        blocks = msg["content"] if isinstance(msg["content"], list) else []
        for block in blocks:
            nested = block.get("content", []) if isinstance(block, dict) and block.get("type") == "tool_result" else [block]
            for item in nested if isinstance(nested, list) else []:
                if isinstance(item, dict) and item.get("type") == "image":
                    sizes.append(Image.open(io.BytesIO(base64.b64decode(item["source"]["data"]))).size)
    return sizes


@pytest.fixture
async def finished_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    # Relative paths, as in real use (cwd = repo root): the log then holds no machine-specific paths.
    monkeypatch.chdir(tmp_path)
    Path("set").mkdir()
    write_pano(Path("set/pano_a.jpg"), 1)
    write_pano(Path("set/pano_b.jpg"), 2)
    Path("set/manifest.csv").write_text(
        "filename,label,timestamp,special\n"
        "pano_a.jpg,Urban,20261011093000,yes\n"
        "pano_b.jpg,non-Urban,20261011101500,\n",
        encoding="utf-8",
    )
    tasks = load_tasks(Path("set"))
    settings = Settings(runs_dir=Path("runs"), cache_dir=Path(".cache"), team="e2e-team", mcq_timeout_s=20.0)
    requests: list[httpx.Request] = []
    monkeypatch.setattr(
        runner_module, "make_http_client", lambda _settings: httpx.AsyncClient(transport=geocoder(requests))
    )
    client = ScriptedClient()
    manager = RunManager(settings, run_id="e2e", client=client)
    manager.add_tasks(tasks)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(manager)), base_url="http://ui") as api:
        operator = asyncio.create_task(click_first_mcq(api, 0))
        await asyncio.wait_for(manager.start(concurrency=2), timeout=60)
        mcq = await asyncio.wait_for(operator, timeout=5)
        exported = (await api.post("/api/export")).json()
    return {
        "manager": manager,
        "client": client,
        "requests": requests,
        "mcq": mcq,
        "paths": manager.export_all(),
        "api_export": exported,
        "run_dir": Path("runs/e2e"),
    }


def load_export(run: dict[str, Any], panorama_id: str) -> dict[str, Any]:
    return json.loads((run["run_dir"] / f"{panorama_id}.json").read_text(encoding="utf-8"))


def types(doc: dict[str, Any]) -> list[str]:
    return [e["type"] for e in doc["events"]]


async def test_tasks_come_from_the_manifest(finished_run: dict[str, Any]) -> None:
    sessions = finished_run["manager"].sessions
    assert set(sessions) == {SPECIAL_ID, RURAL_ID}
    assert sessions[SPECIAL_ID].task.special and sessions[SPECIAL_ID].task.label.value == "Urban"
    assert not sessions[RURAL_ID].task.special and sessions[RURAL_ID].task.label.value == "non-Urban"
    assert sessions[SPECIAL_ID].task.timestamp == "20261011093000"
    assert all(s.status == "done" and s.final is not None for s in sessions.values())


async def test_exports_are_valid_with_ten_stamped_entries(finished_run: dict[str, Any]) -> None:
    for panorama_id, multiplier, mcqs in ((SPECIAL_ID, 0.95, 1), (RURAL_ID, 1.0, 0)):
        doc = load_export(finished_run, panorama_id)
        assert validate_export(doc) == []
        locations = doc["final"]["locations"]
        assert len(locations) == 10
        assert [loc["rank"] for loc in locations] == list(range(1, 11))
        assert all(loc["multiplier"] == pytest.approx(multiplier) for loc in locations)
        assert all(loc["origin"] == "agent" for loc in locations)
        assert doc["final"]["penalty_state"] == {
            "cues": 0,
            "mcqs": mcqs,
            "human_geocodes": 0,
            "multiplier": pytest.approx(multiplier),
        }
        assert doc["team"] == "e2e-team" and doc["schema_version"] == "1.0"
        assert doc["totals"]["stop_reason"] == "submitted"
        assert doc["totals"]["turns"] == len(SCRIPTS[panorama_id])
        assert doc["totals"]["cost_usd"] > 0

    special = load_export(finished_run, SPECIAL_ID)
    top = special["final"]["locations"][0]
    assert haversine_m(top["lat"], top["lng"], ALFAMA["lat"], ALFAMA["lng"]) < 1.0
    assert len({(loc["lat"], loc["lng"]) for loc in special["final"]["locations"]}) == 1  # 10 x x_1
    assert special["panorama"]["special"] is True and special["panorama"]["label"] == "Urban"
    assert special["config"]["effort"] == "xhigh"
    rural = load_export(finished_run, RURAL_ID)
    assert rural["panorama"]["label"] == "non-Urban" and rural["config"]["effort"] == "high"


async def test_event_log_covers_the_run_in_order(finished_run: dict[str, Any]) -> None:
    special, rural = load_export(finished_run, SPECIAL_ID), load_export(finished_run, RURAL_ID)
    common = {
        "run_start",
        "model_request",
        "model_response",
        "tool_call",
        "tool_result",
        "candidates_update",
        "final_submission",
        "run_end",
    }
    assert set(types(special)) == common | {"mcq_asked", "mcq_answered"}
    assert set(types(rural)) == common
    for doc in (special, rural):
        kinds = types(doc)
        assert kinds[0] == "run_start" and kinds[-1] == "run_end"
        assert [e["seq"] for e in doc["events"]] == list(range(1, len(kinds) + 1))
        assert kinds.index("final_submission") < kinds.index("run_end")
        for event in doc["events"]:
            assert set(event) == {
                "schema_version",
                "seq",
                "ts",
                "t_rel_s",
                "run_id",
                "panorama_id",
                "actor",
                "type",
                "penalty_state",
                "data",
            }
            assert event["run_id"] == "e2e" and event["ts"].endswith("Z")
        on_disk = [json.loads(line) for line in (finished_run["run_dir"] / f"{doc['panorama']['panorama_id']}.events.jsonl").read_text().splitlines()]
        assert on_disk == doc["events"]

    start = special["events"][0]["data"]
    assert start["panorama"]["filename"] == "pano_a.jpg" and len(start["panorama"]["sha256"]) == 64
    assert start["label"] == "Urban" and start["capture_timestamp"] == "20261011093000"
    assert start["model"] == "claude-opus-5-5" and start["effort"] == "xhigh"
    assert "Regional cue playbook" in start["system_prompt"]
    assert {t["name"] for t in start["tools"]} >= {"view_crop", "submit_locations", "web_search"}

    tools_called = [e["data"]["tool"] for e in special["events"] if e["type"] == "tool_call"]
    assert tools_called == ["view_crop", "update_candidates", "search_places", "ask_multiple_choice", "submit_locations"]
    results = {e["data"]["tool"]: e["data"] for e in special["events"] if e["type"] == "tool_result"}
    assert not any(r["is_error"] for r in results.values())
    assert results["search_places"]["urls"] and "nominatim" in results["search_places"]["urls"][0]
    assert "38.713909" in results["search_places"]["output"]
    crop = results["view_crop"]["log"]["image"]
    assert Path(crop["path"]).is_file() and not Path(crop["path"]).is_absolute()

    first_request = next(e for e in special["events"] if e["type"] == "model_request")
    images = [b for b in first_request["data"]["messages"][0]["content"] if b["type"] == "image"]
    assert len(images) == 11 and all(len(b["sha256"]) == 64 and Path(b["path"]).is_file() for b in images)
    assert "base64" not in json.dumps(special["events"])
    response = next(e for e in special["events"] if e["type"] == "model_response")
    assert response["data"]["content"][0]["type"] == "thinking" and response["data"]["usage"]["input_tokens"] == 4000


async def test_mcq_went_through_the_operator_api(finished_run: dict[str, Any]) -> None:
    mcq = finished_run["mcq"]
    assert mcq["panorama_id"] == SPECIAL_ID and len(mcq["options"]) == 2
    events = {e["type"]: e for e in load_export(finished_run, SPECIAL_ID)["events"]}
    asked, answered = events["mcq_asked"], events["mcq_answered"]
    assert asked["actor"] == "agent" and answered["actor"] == "human"
    assert asked["data"]["multiplier_before"] == 1.0 and asked["data"]["multiplier_after"] == pytest.approx(0.95)
    # the fee is charged when the question is asked, not when it is answered
    assert asked["penalty_state"] == {"cues": 0, "mcqs": 1, "human_geocodes": 0, "multiplier": pytest.approx(0.95)}
    assert answered["data"]["selected_index"] == 0
    assert answered["data"]["selected_option"] == mcq["options"][0]
    # the click reached the model as the tool result of its own question
    last_call = finished_run["client"].calls[SPECIAL_ID][-1]["raw_messages"]
    reply = last_call[-1]["content"][0]
    assert reply["type"] == "tool_result" and reply["tool_use_id"] == "toolu_a4"
    assert "option 1" in reply["content"][0]["text"]


async def test_requests_are_cache_stable_and_append_only(finished_run: dict[str, Any]) -> None:
    calls = finished_run["client"].calls
    for panorama_id, script in SCRIPTS.items():
        made = calls[panorama_id]
        assert len(made) == len(script)
        assert len({c["fixed"] for c in made}) == 1  # system, tools and settings never change
        for earlier, later in zip(made, made[1:]):
            assert later["messages"][: len(earlier["messages"])] == earlier["messages"]
        for call in made:
            roles = [m["role"] for m in call["raw_messages"]]
            assert roles[0] == "user" and roles[-1] == "user"
            assert all(w <= 2000 and h <= 2000 for w, h in image_sizes(call["raw_messages"]))
        # one user message answers every tool call of the turn
        parallel = made[-1]["raw_messages"][2 if panorama_id == SPECIAL_ID else 4]["content"]
        assert [b["type"] for b in parallel[:2]] == ["tool_result", "tool_result"]

    special, rural = calls[SPECIAL_ID][0]["params"], calls[RURAL_ID][0]["params"]
    assert special["output_config"] == {"effort": "xhigh"} and rural["output_config"] == {"effort": "high"}
    assert special["system"] == rural["system"] and special["tools"] == rural["tools"]
    assert special["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert not {"tool_choice", "temperature", "top_p", "top_k"} & set(special)


async def test_only_the_mock_geocoder_was_called(finished_run: dict[str, Any]) -> None:
    hosts = {r.url.host for r in finished_run["requests"]}
    assert hosts == {"nominatim.openstreetmap.org", "photon.komoot.io"}
    assert all("geoagent" in r.headers.get("user-agent", "") for r in finished_run["requests"])


async def test_summary_and_answers_files(finished_run: dict[str, Any]) -> None:
    run_dir, paths = finished_run["run_dir"], finished_run["paths"]
    assert {p.name for p in paths} == {"pano_a.json", "pano_b.json", "summary.csv", "answers.csv"}
    assert sorted(Path(p).name for p in finished_run["api_export"]["paths"]) == sorted(p.name for p in paths)

    with (run_dir / "summary.csv").open(newline="", encoding="utf-8") as fh:
        rows = {row["panorama"]: row for row in csv.DictReader(fh)}
    assert set(rows) == {SPECIAL_ID, RURAL_ID}
    assert rows[SPECIAL_ID]["label"] == "Urban" and rows[SPECIAL_ID]["special"] == "True"
    assert float(rows[SPECIAL_ID]["multiplier"]) == pytest.approx(0.95)
    assert float(rows[RURAL_ID]["multiplier"]) == 1.0
    assert all(row["stop_reason"] == "submitted" and row["problems"] == "" for row in rows.values())
    assert finished_run["manager"].summary and not any(r["problems"] for r in finished_run["manager"].summary)

    with (run_dir / "answers.csv").open(newline="", encoding="utf-8") as fh:
        answers = list(csv.reader(fh))
    assert answers[0] == ["panorama_id", "rank", "lat", "lng"]
    assert len(answers) == 21
    assert answers[1] == [SPECIAL_ID, "1", "38.713909", "-9.133476"]
    assert all(len(row[2].split(".")[1]) == 6 and len(row[3].split(".")[1]) == 6 for row in answers[1:])


async def test_exports_rebuild_from_the_logs_alone(finished_run: dict[str, Any]) -> None:
    """`cli.py export <run_dir>` has no sessions in memory; the logs must carry everything."""
    before = {pid: load_export(finished_run, pid) for pid in (SPECIAL_ID, RURAL_ID)}
    paths, rows = export_run(finished_run["run_dir"], team="e2e-team")
    assert len(paths) == 4 and not any(row["problems"] for row in rows)
    assert {pid: load_export(finished_run, pid) for pid in before} == before


async def test_eval_harness_scores_the_real_exports(finished_run: dict[str, Any]) -> None:
    exports = load_exports(finished_run["run_dir"])
    assert set(exports) == {SPECIAL_ID, RURAL_ID}
    truths = {
        SPECIAL_ID: Truth(ALFAMA["lat"], ALFAMA["lng"], Label.URBAN, special=True),
        RURAL_ID: Truth(SERRA["lat"], SERRA["lng"], Label.NON_URBAN),
    }
    scores = {s.panorama_id: s for s in score_run(exports, truths)}
    weights = sum(1000 * 0.95**r for r in range(10))
    # exact hit at every rank: 2 x rank weights, x0.95 for the question, x3 for the Special One
    assert scores[SPECIAL_ID].score == pytest.approx(2 * weights * 0.95 * 3)
    assert scores[RURAL_ID].score == pytest.approx(2 * weights)
    assert scores[SPECIAL_ID].multiplier == pytest.approx(0.95) and scores[SPECIAL_ID].origin == "agent"
    assert scores[SPECIAL_ID].n_hypotheses == 2 and scores[SPECIAL_ID].plan == "10x1"
    assert scores[SPECIAL_ID].turns == 4 and scores[SPECIAL_ID].cost_usd > 0
    # the hedge can be re-run offline from the logged hypotheses
    hedged = {s.panorama_id: s for s in score_run(exports, truths, hedge=True)}
    assert hedged[SPECIAL_ID].score <= scores[SPECIAL_ID].score + 1e-6


async def test_write_sample_export(finished_run: dict[str, Any], request: pytest.FixtureRequest) -> None:
    target = os.environ.get(SAMPLE_ENV)
    if not target:
        pytest.skip(f"set {SAMPLE_ENV}=<path> to write the sample export")
    out = Path(target) if Path(target).is_absolute() else request.config.rootpath / target
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(finished_run["run_dir"] / f"{SPECIAL_ID}.json", out)
    assert validate_export(json.loads(out.read_text(encoding="utf-8"))) == []
