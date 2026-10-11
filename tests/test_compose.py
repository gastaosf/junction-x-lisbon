"""Cross-module composition checks: the tool list, the handlers and the request settings must
agree with each other and with what gpt-6.1-sol and the Responses API accept."""

from __future__ import annotations

import base64
import inspect
import io
import json
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np
import pytest
from openai.resources.responses import AsyncResponses
from openai.types.responses import FunctionToolParam, WebSearchToolParam
from openai.types.responses.response_create_params import ResponseCreateParamsStreaming
from PIL import Image

from astrolabio.config import MODEL_PRICING, SPECIAL_BUDGET, STANDARD_BUDGET, Pricing, Settings, load_settings, pricing_for
from astrolabio.loop import build_request_params
from astrolabio.pano import Panorama
from astrolabio.schema import Label, PanoramaTask
from astrolabio.session import PanoramaSession
from astrolabio.tools import registry
from astrolabio.tools.base import ToolContext, ToolResult
from astrolabio.tools.schemas import tool_definitions

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
    return {t["name"]: t for t in tool_definitions(settings) if t["type"] == "function"}


def strict_problems(schema: dict[str, Any], path: str = "$") -> list[str]:
    """Where a schema breaks strict mode: an object that allows extra keys or has an optional
    property, at any depth, is a 400 for the whole request."""
    problems = []
    if schema["type"] == "object":
        if schema.get("additionalProperties") is not False:
            problems.append(f"{path}: additionalProperties is not false")
        if sorted(schema.get("required", [])) != sorted(schema["properties"]):
            problems.append(f"{path}: required does not list every property")
        for key, sub in schema["properties"].items():
            problems += strict_problems(sub, f"{path}.{key}")
    elif schema["type"] == "array":
        problems += strict_problems(schema["items"], f"{path}[]")
    return problems


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
    # hosted tools come last, carry no "name" key, and there is no hosted fetch tool
    # the empty approximate location stops the API ranking results for a user in the United States
    hosted = {"type": "web_search", "user_location": {"type": "approximate"}}
    assert [t for t in tool_definitions(Settings()) if t["type"] != "function"] == [hosted]
    assert tool_definitions(Settings())[-1] == hosted
    assert all(t["type"] == "function" for t in tool_definitions(Settings(allow_web=False)))


def test_schemas_are_strict_and_examples_match_them() -> None:
    for name, tool in client_tools(Settings()).items():
        # the flat Responses shape: a nested "function" object is the Chat Completions one
        assert set(tool) == {"type", "name", "description", "parameters", "strict"}, name
        assert set(tool) <= set(FunctionToolParam.__annotations__)
        assert tool["strict"] is True
        assert strict_problems(tool["parameters"]) == [], name
        assert conforms(EXAMPLES[name], tool["parameters"]), name
    # ranges and lengths are checked by the handlers, so the schemas carry no such keywords
    text = json.dumps([t["parameters"] for t in client_tools(Settings()).values()])
    assert not any(f'"{key}"' in text for key in ("minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"))


def test_strict_check_catches_a_loose_nested_object() -> None:
    loose = {"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "string"}}, "required": ["a"]}
    schema = {
        "type": "object",
        "properties": {"items": {"type": "array", "items": loose}},
        "required": ["items"],
        "additionalProperties": False,
    }
    assert strict_problems(schema) == [
        "$.items[]: additionalProperties is not false",
        "$.items[]: required does not list every property",
    ]


async def test_every_handler_accepts_its_schema_shaped_input(ctx: ToolContext) -> None:
    for name in ORDER:
        result = await registry.execute_tool(ctx, name, EXAMPLES[name], tool_use_id=f"call_{name}")
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
    params = build_request_params(Settings(), STANDARD_BUDGET, "run-1:pano-1")
    assert set(params) == {
        "model",
        "instructions",
        "tools",
        "reasoning",
        "max_output_tokens",
        "parallel_tool_calls",
        "store",
        "include",
        "prompt_cache_key",
    }
    # the client adds input and stream; everything must be a real parameter of the SDK call
    assert set(params) | {"input", "stream"} <= set(inspect.signature(AsyncResponses.create).parameters)
    streaming = ResponseCreateParamsStreaming.__required_keys__ | ResponseCreateParamsStreaming.__optional_keys__
    assert set(params) | {"input", "stream"} <= streaming
    assert params["model"] == "gpt-6.1-sol"
    assert params["reasoning"] == {"effort": "high", "summary": "auto"}
    assert build_request_params(Settings(), SPECIAL_BUDGET, "k")["reasoning"]["effort"] == "xhigh"
    assert params["max_output_tokens"] == 64_000
    assert params["parallel_tool_calls"] is True
    # stateless replay: nothing is stored, so the reasoning items must come back encrypted
    assert params["store"] is False
    assert params["include"] == ["reasoning.encrypted_content", "web_search_call.action.sources"]
    assert build_request_params(Settings(allow_web=False), STANDARD_BUDGET, "k")["include"] == ["reasoning.encrypted_content"]
    assert params["prompt_cache_key"] == "run-1:pano-1"
    assert isinstance(params["instructions"], str) and params["instructions"]
    # sampling parameters are 400s on this model; the harness never forces a tool or truncates history
    assert not {"temperature", "top_p", "tool_choice", "truncation", "previous_response_id", "max_tool_calls"} & set(params)
    hosted = [t for t in params["tools"] if t["type"] != "function"]
    assert hosted == [{"type": "web_search", "user_location": {"type": "approximate"}}]
    assert set(hosted[0]) <= set(WebSearchToolParam.__annotations__)


def test_request_prefix_is_byte_stable() -> None:
    def prefix(settings: Settings, budget: Any = STANDARD_BUDGET) -> str:
        params = build_request_params(settings, budget, "k")
        return json.dumps([params["tools"], params["instructions"]], sort_keys=True)

    base = prefix(Settings())
    assert base == prefix(Settings())
    # per-run and per-panorama settings must not leak into the cached prefix
    assert base == prefix(Settings(team="x", hedge=True, concurrency=2, runs_dir=Path("elsewhere")), SPECIAL_BUDGET)
    assert base != prefix(Settings(allow_web=False))


def test_pricing_follows_the_model() -> None:
    assert pricing_for("gpt-6.1-sol") == Pricing() == Settings().pricing
    astra = pricing_for("gpt-6-astra")
    assert (astra.input, astra.cached_input, astra.cache_write, astra.output) == (10.0, 1.0, 12.5, 50.0)
    assert set(MODEL_PRICING) >= {"gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.5"}
    for pricing in MODEL_PRICING.values():
        assert (pricing.long_context_threshold, pricing.long_input_multiplier, pricing.long_output_multiplier) == (272_000, 2.0, 1.5)
        assert pricing.web_search_per_1k == 10.0
    # gpt-5.5 has no cache-write surcharge: a write costs what plain input does
    assert pricing_for("gpt-5.5").cache_write == pricing_for("gpt-5.5").input == 5.0
    # a dated snapshot is priced as its model, and the longest id wins
    assert pricing_for("gpt-5.5-2026-04-23") == MODEL_PRICING["gpt-5.5"]
    assert pricing_for("gpt-6-astra-2026-09-01") == astra
    assert pricing_for("gpt-5.6-sol-2026-08-05") == MODEL_PRICING["gpt-5.6-sol"]
    # an unknown model, or a different model sharing a prefix, gets the default rather than a relative's rates
    assert pricing_for("gpt-7") == pricing_for("gpt-5.5-pro") == pricing_for("gpt-6.1-solar") == Pricing()


def test_model_and_image_detail_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    # blank, not deleted: load_settings re-reads .env, which fills in whatever is missing
    monkeypatch.setenv("ASTROLABIO_MODEL", "")
    monkeypatch.setenv("ASTROLABIO_IMAGE_DETAIL", "")
    assert (load_settings().model, load_settings().image_detail) == ("gpt-6.1-sol", "original")
    assert load_settings().pricing == Pricing()

    monkeypatch.setenv("ASTROLABIO_MODEL", "gpt-6-astra")
    monkeypatch.setenv("ASTROLABIO_IMAGE_DETAIL", "high")
    settings = load_settings()
    assert (settings.model, settings.image_detail, settings.pricing) == ("gpt-6-astra", "high", MODEL_PRICING["gpt-6-astra"])
    # the price follows the final model, so a CLI override beats the environment for both
    assert load_settings(model="gpt-6-luna").pricing == MODEL_PRICING["gpt-6-luna"]
    assert load_settings(model="gpt-6-luna", pricing=Pricing(input=1.0)).pricing.input == 1.0
    assert load_settings(image_detail="low").image_detail == "low"

    monkeypatch.setenv("ASTROLABIO_IMAGE_DETAIL", "")  # a blank line in .env
    assert load_settings().image_detail == "original"
    monkeypatch.setenv("ASTROLABIO_IMAGE_DETAIL", "sharp")
    with pytest.raises(ValueError, match="image_detail"):
        load_settings()


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
    for name in (*env, "ASTROLABIO_MODEL", "ASTROLABIO_IMAGE_DETAIL", "API_READ_TIMEOUT_S", "RUNS_DIR", "CACHE_DIR"):
        monkeypatch.setenv(name, "")
    assert load_settings().model_dump(exclude={"google_maps_api_key", "mapillary_token"}) == Settings().model_dump(
        exclude={"google_maps_api_key", "mapillary_token"}
    )
