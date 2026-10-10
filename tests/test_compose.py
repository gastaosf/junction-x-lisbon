"""Cross-module composition checks: the tool list, the handlers and the request settings must
agree with each other and with what claude-opus-5-5 accepts."""

from __future__ import annotations

import base64
import inspect
import io
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import cv2
import httpx
import numpy as np
import pytest
from anthropic.resources.beta.messages import AsyncMessages
from PIL import Image

from geoagent import loop as loop_module
from geoagent.config import SPECIAL_BUDGET, STANDARD_BUDGET, Settings, load_settings
from geoagent.loop import FALLBACK_BETA, build_request_params
from geoagent.pano import Panorama
from geoagent.schema import Label, PanoramaTask
from geoagent.session import PanoramaSession
from geoagent.tools import registry
from geoagent.tools.base import ToolContext, ToolResult
from geoagent.tools.schemas import tool_definitions

HYPOTHESIS = {
    "lat": 38.7223,
    "lng": -9.1393,
    "probability": 0.6,
    "radius_m": 50.0,
    "label": "Baixa",
    "evidence": "tram tracks",
}
# One realistic input per client tool, in exactly the shape its strict schema allows.
EXAMPLES: dict[str, dict[str, Any]] = {
    "view_crop": {"yaw": 123.0, "pitch": -5.0, "fov": 25.0, "enhance": True},
    "update_candidates": {"hypotheses": [HYPOTHESIS]},
    "submit_locations": {"hypotheses": [HYPOTHESIS], "reasoning_summary": "matched the tram stop"},
    "sun_position": {"sun_yaw": 200.0, "sun_pitch": 35.0, "candidates": [{"lat": 38.7223, "lng": -9.1393}]},
    "ask_multiple_choice": {"question": "Which one?", "options": ["A", "B"], "why_it_matters": "splits the modes"},
    "search_places": {"query": "Pastelaria Santo António", "countrycodes": "pt,es", "viewbox": "-9.3,38.6,-9.0,38.9"},
    "streetview_lookup": {"lat": 38.7223, "lng": -9.1393, "radius_m": 50.0, "headings": [0.0, 90.0]},
    "satellite_tile": {"lat": 38.7223, "lng": -9.1393, "zoom": 17},
    "overpass_query": {"ql": '[out:json][timeout:25];node["amenity"="cafe"](38.70,-9.15,38.73,-9.12);out center 50;'},
}
# submit_locations ends the run, so it goes last.
ORDER = [name for name in EXAMPLES if name != "submit_locations"] + ["submit_locations"]


def client_tools(settings: Settings) -> dict[str, dict[str, Any]]:
    return {t["name"]: t for t in tool_definitions(settings) if "input_schema" in t}


def conforms(value: Any, schema: dict[str, Any]) -> bool:
    kind = schema["type"]
    if kind == "object":
        return (
            isinstance(value, dict)
            and set(value) == set(schema["properties"]) == set(schema["required"])
            and all(conforms(value[k], sub) for k, sub in schema["properties"].items())
        )
    if kind == "array":
        return isinstance(value, list) and all(conforms(v, schema["items"]) for v in value)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    return isinstance(value, {"string": str, "boolean": bool}[kind])


def fake_services(request: httpx.Request) -> httpx.Response:
    host = request.url.host
    if "nominatim" in host:
        return httpx.Response(200, json=[{"lat": "38.7139", "lon": "-9.1334", "name": "Pastelaria", "display_name": "Lisboa"}])
    if "overpass" in host:
        return httpx.Response(200, json={"elements": [{"type": "node", "id": 1, "lat": 38.71, "lon": -9.13, "tags": {"amenity": "cafe"}}]})
    if "arcgisonline" in host:
        tile = np.full((1024, 1024, 3), 90, dtype=np.uint8)
        return httpx.Response(200, content=cv2.imencode(".jpg", tile)[1].tobytes(), headers={"content-type": "image/jpeg"})
    return httpx.Response(404)


@pytest.fixture
def ctx(tmp_path: Path) -> ToolContext:
    path = tmp_path / "pano.jpg"
    assert cv2.imwrite(str(path), np.random.default_rng(3).integers(0, 255, (256, 512, 3), dtype=np.uint8))
    settings = Settings(runs_dir=tmp_path / "runs", cache_dir=tmp_path / "cache", no_human=True)
    task = PanoramaTask(panorama_id="p", path=path, label=Label.URBAN, timestamp="20261011093000")
    session = PanoramaSession(task, settings, "compose")
    http = httpx.AsyncClient(transport=httpx.MockTransport(fake_services))
    return ToolContext(session=session, pano=Panorama(path, session.image_dir), settings=settings, http=http)


def test_tool_list_and_handlers_name_the_same_tools() -> None:
    assert set(client_tools(Settings())) == set(registry.HANDLERS) == set(EXAMPLES)
    offline = set(client_tools(Settings(allow_web=False)))
    assert offline == set(registry.HANDLERS) - registry.WEB_TOOL_NAMES
    server = [t["name"] for t in tool_definitions(Settings()) if "input_schema" not in t]
    assert server == ["web_search", "web_fetch"]
    assert not any("input_schema" not in t for t in tool_definitions(Settings(allow_web=False)))


def test_schemas_are_strict_and_examples_match_them() -> None:
    for name, tool in client_tools(Settings()).items():
        assert tool["strict"] is True
        assert tool["input_schema"]["additionalProperties"] is False
        assert conforms(EXAMPLES[name], tool["input_schema"]), name
    # strict mode rejects numeric and length constraints, so none may appear anywhere
    text = json.dumps([t["input_schema"] for t in client_tools(Settings()).values()])
    assert not any(f'"{key}"' in text for key in ("minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"))


async def test_every_handler_accepts_its_schema_shaped_input(ctx: ToolContext) -> None:
    for name in ORDER:
        result = await registry.execute_tool(ctx, name, EXAMPLES[name], tool_use_id=f"toolu_{name}")
        assert isinstance(result, ToolResult), name
        assert "exception" not in result.log, (name, result.content)
        assert result.content and all(block["type"] in {"text", "image"} for block in result.content), name
        for block in result.content:
            if block["type"] == "image":
                assert block["source"]["type"] == "base64" and block["source"]["media_type"] == "image/jpeg"
                width, height = Image.open(io.BytesIO(base64.b64decode(block["source"]["data"]))).size
                assert max(width, height) <= 2000, name
    # the expected refusals, not crashes: no street-level key, and no operator in --no-human
    events = {e["data"]["tool"]: e["data"] for e in ctx.session.log.events() if e["type"] == "tool_result"}
    assert set(events) == set(EXAMPLES)
    assert {name for name, data in events.items() if data["is_error"]} == {"streetview_lookup", "ask_multiple_choice"}
    assert ctx.session.ledger.mcqs == 0
    assert ctx.session.final is not None and len(ctx.session.final) == 10
    json.dumps(ctx.session.log.events())  # every tool log is JSON-safe


def test_initial_views_fit_the_image_limit(ctx: ToolContext) -> None:
    views = ctx.pano.initial_views()
    assert len(views) == 11
    assert all(max(v.width, v.height) <= 2000 for v in views)
    assert all(v.to_block()["source"]["media_type"] == "image/jpeg" for v in views)


def test_request_params_are_valid_for_the_model_and_the_sdk() -> None:
    params = build_request_params(Settings(), STANDARD_BUDGET)
    accepted = set(inspect.signature(AsyncMessages.stream).parameters)
    assert set(params) | {"messages"} <= accepted
    assert params["model"] == "claude-opus-5-5"
    assert params["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert params["output_config"] == {"effort": "high"}
    assert build_request_params(Settings(), SPECIAL_BUDGET)["output_config"] == {"effort": "xhigh"}
    # forced tool choice, sampling parameters and thinking budgets are all 400s on this model
    assert not {"tool_choice", "temperature", "top_p", "top_k"} & set(params)
    assert "budget_tokens" not in json.dumps(params)
    assert params["fallbacks"] == "default" and params["betas"] == [FALLBACK_BETA]
    assert [t["type"] for t in params["tools"] if "type" in t] == ["web_search_20260209", "web_fetch_20260209"]
    assert params["system"][0]["cache_control"] == {"type": "ephemeral"}


def test_request_prefix_is_byte_stable() -> None:
    def prefix(settings: Settings, budget: Any = STANDARD_BUDGET) -> str:
        params = build_request_params(settings, budget)
        return json.dumps([params["tools"], params["system"]], sort_keys=True)

    base = prefix(Settings())
    assert base == prefix(Settings())
    # per-run and per-panorama settings must not leak into the cached prefix
    assert base == prefix(Settings(team="x", hedge=True, concurrency=2, runs_dir=Path("elsewhere")), SPECIAL_BUDGET)
    assert base != prefix(Settings(allow_web=False))


def test_blocks_from_a_declined_model_are_not_echoed_after_a_fallback() -> None:
    def block(kind: str, **fields: Any) -> SimpleNamespace:
        return SimpleNamespace(type=kind, **fields)

    plain = [block("thinking", thinking="t"), block("tool_use", id="a", name="view_crop", input={})]
    assert loop_module._echoable(plain) is plain

    content = [
        block("thinking", thinking="from the model that declined"),
        block("text", text="partial"),
        block("server_tool_use", id="srv_1", name="web_search", input={}),
        block("web_search_tool_result", tool_use_id="srv_1", content=[]),
        block("server_tool_use", id="srv_2", name="web_search", input={}),
        block("tool_use", id="toolu_old", name="view_crop", input={}),
        block("fallback"),
        block("thinking", thinking="from the fallback model"),
        block("tool_use", id="toolu_new", name="view_crop", input={}),
    ]
    kept = loop_module._echoable(content)
    assert [(b.type, getattr(b, "id", None)) for b in kept] == [
        ("text", None),
        ("server_tool_use", "srv_1"),
        ("web_search_tool_result", None),
        ("fallback", None),
        ("thinking", None),
        ("tool_use", "toolu_new"),
    ]


def test_every_organiser_question_flag_is_settable_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    env = {
        "ALLOW_WEB": "false",  # Q1
        "PENALTY_SCOPE": "subsequent",  # Q2
        "ALLOW_DUPLICATES": "false",  # Q3
        "EMBED_IMAGES": "true",  # Q4
        "MCQ_ALLOWED": "false",  # Q7
        "MAX_MCQ": "1",
        "GLOBAL_WATCHDOG_S": "1200",  # Q10
        "HEDGE": "true",
        "NO_HUMAN": "true",
        "TEAM_NAME": "albatroz",
    }
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    settings = load_settings()
    assert (settings.allow_web, settings.penalty_scope, settings.allow_duplicates) == (False, "subsequent", False)
    assert (settings.embed_images, settings.mcq_allowed, settings.max_mcq) == (True, False, 1)
    assert (settings.global_watchdog_s, settings.hedge, settings.no_human, settings.team) == (1200.0, True, True, "albatroz")
    # an explicit CLI flag beats the environment; None leaves it alone
    assert load_settings(allow_web=True, hedge=None).allow_web is True
    assert load_settings(allow_web=True, hedge=None).hedge is True
    for name in env:
        monkeypatch.setenv(name, "")
    assert load_settings().model_dump(exclude={"google_maps_api_key", "mapillary_token"}) == Settings().model_dump(
        exclude={"google_maps_api_key", "mapillary_token"}
    )
