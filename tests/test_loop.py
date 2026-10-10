"""Agent loop driven by a scripted fake model client: no network, no API key."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import cv2
import httpx2
import numpy as np
import openai
import pytest

from geoagent import loop as loop_module
from geoagent import prompts
from geoagent import session as session_module
from geoagent.config import Budget, Pricing, Settings
from geoagent.loop import estimate_cost, prompt_cache_key, run_agent, usage_dict
from geoagent.openai_client import API_READ_TIMEOUT_S, OpenAIModelClient
from geoagent.pano import Panorama
from geoagent.schema import Label, PanoramaTask
from geoagent.session import PanoramaSession

HYP = {
    "lat": 38.7223,
    "lng": -9.1393,
    "probability": 0.7,
    "radius_m": 50.0,
    "label": "Baixa",
    "evidence": "tram tracks and calçada paving",
}
OTHER = {**HYP, "lat": 41.1496, "lng": -8.6109, "label": "Ribeira"}
REQUEST = httpx2.Request("POST", "https://api.openai.com/v1/responses")


def budget(**overrides: Any) -> Budget:
    base = {"effort": "high", "soft_deadline_s": 600, "hard_deadline_s": 840, "max_turns": 30, "max_spend_usd": 8.0}
    return Budget(**{**base, **overrides})


def tool_use(name: str, input_: dict[str, Any], id_: str = "call_1", *, incomplete: bool = False) -> SimpleNamespace:
    block = SimpleNamespace(type="tool_use", id=id_, name=name, input=input_)
    if incomplete:  # what the client sets on a call cut off mid-arguments
        block.incomplete = True
    return block


def text(value: str) -> SimpleNamespace:
    return SimpleNamespace(type="text", text=value)


def message(stop_reason: str, *blocks: Any, **usage: int) -> SimpleNamespace:
    counters = {
        "input_tokens": 1000,
        "cached_input_tokens": 0,
        "cache_write_tokens": 0,
        "output_tokens": 200,
        "reasoning_tokens": 0,
        "web_search_requests": 0,
    }
    return SimpleNamespace(
        id="resp_test",
        model="gpt-6.1-sol",
        content=list(blocks),
        stop_reason=stop_reason,
        stop_details=None,
        usage={**counters, **usage},
    )


def update(*hyps: dict[str, Any], id_: str = "call_u") -> SimpleNamespace:
    return message("tool_use", tool_use("update_candidates", {"hypotheses": list(hyps or (HYP,))}, id_))


def submit(*hyps: dict[str, Any]) -> SimpleNamespace:
    args = {"hypotheses": list(hyps or (HYP,)), "reasoning_summary": "matched the tram stop"}
    return message("tool_use", tool_use("submit_locations", args, "call_s"))


def rate_limited(code: str = "rate_limit_exceeded") -> openai.RateLimitError:
    body = {"code": code, "type": code, "message": "rate limited"}
    return openai.RateLimitError("rate limited", response=httpx2.Response(429, request=REQUEST), body=body)


class FakeClient:
    """Plays a script: a message is returned, an exception raised, a callable awaited. The last
    item repeats, so a short script can stand for 'the model keeps doing this'."""

    def __init__(self, *script: Any) -> None:
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []

    async def create(self, **params: Any) -> Any:
        self.calls.append({**params, "messages": list(params["messages"])})
        item = self.script[min(len(self.calls), len(self.script)) - 1]
        if isinstance(item, BaseException):
            raise item
        if callable(item):
            return await item()
        return item


async def hang() -> Any:
    await asyncio.sleep(3600)


@pytest.fixture
def pano_path(tmp_path: Path) -> Path:
    path = tmp_path / "20261011093000_Urban.jpg"
    noise = np.random.default_rng(0).integers(0, 255, (256, 512, 3), dtype=np.uint8)
    assert cv2.imwrite(str(path), noise)
    return path


def make_session(tmp_path: Path, pano_path: Path, **settings: Any) -> tuple[PanoramaSession, Panorama]:
    config = Settings(
        **{"runs_dir": tmp_path / "runs", "cache_dir": tmp_path / "cache", "allow_web": False, "no_human": True, **settings}
    )
    task = PanoramaTask(panorama_id="p1", path=pano_path, label=Label.URBAN, timestamp="20261011093000")
    session = PanoramaSession(task, config, "run-test")
    return session, Panorama(pano_path, session.image_dir)


def events(session: PanoramaSession, type_: str) -> list[dict[str, Any]]:
    return [e for e in session.log.events() if e["type"] == type_]


def run_end(session: PanoramaSession) -> dict[str, Any]:
    (event,) = events(session, "run_end")
    return event["data"]


def user_texts(message_: dict[str, Any]) -> list[str]:
    """Text blocks of a user message, without the per-turn harness status line."""
    texts = [b["text"] for b in message_["content"] if isinstance(b, dict) and b.get("type") == "text"]
    return [t for t in texts if not t.startswith(prompts.STATUS_PREFIX)]


def status_lines(message_: dict[str, Any]) -> list[str]:
    texts = [b["text"] for b in message_["content"] if isinstance(b, dict) and b.get("type") == "text"]
    return [t for t in texts if t.startswith(prompts.STATUS_PREFIX)]


def tool_results(message_: dict[str, Any]) -> list[dict[str, Any]]:
    return [b for b in message_["content"] if isinstance(b, dict) and b.get("type") == "tool_result"]


def assert_final(session: PanoramaSession, lat: float, lng: float, origin: str) -> None:
    assert session.final is not None and len(session.final) == 10
    assert [e.rank for e in session.final] == list(range(1, 11))
    assert {(e.lat, e.lng, e.origin) for e in session.final} == {(lat, lng, origin)}
    assert session.status == "done"


async def test_happy_path_update_then_submit(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(update(OTHER), submit(HYP))

    await run_agent(session, pano, client, budget=budget())

    assert_final(session, HYP["lat"], HYP["lng"], "agent")
    assert len(client.calls) == 2
    first, second = client.calls
    assert first["model"] == "gpt-6.1-sol"
    assert first["reasoning"] == {"effort": "high", "summary": "auto"}
    assert first["store"] is False and first["parallel_tool_calls"] is True
    assert first["include"] == ["reasoning.encrypted_content"]  # allow_web is off in these tests
    assert first["prompt_cache_key"] == second["prompt_cache_key"] == "geoagent-run-test-p1"
    assert not {"tool_choice", "temperature", "top_p", "truncation", "previous_response_id", "max_tool_calls"} & set(first)
    assert [m["role"] for m in first["messages"]] == ["user"]
    assert sum(b["type"] == "image" for b in first["messages"][0]["content"]) == 11

    # Byte-stable prefix: identical instructions and tools on every call, history only ever appended.
    assert first["instructions"] == second["instructions"] == prompts.build_system_prompt(session.settings)
    assert json.dumps(first["tools"]) == json.dumps(second["tools"])
    assert [m["role"] for m in second["messages"]] == ["user", "assistant", "user"]
    assert second["messages"][0] is first["messages"][0]
    assert second["messages"][1]["content"] == update(OTHER).content
    (result,) = tool_results(second["messages"][2])
    assert result["tool_use_id"] == "call_u" and "is_error" not in result
    assert second["messages"][2]["content"][0] is result  # tool results come first in the message
    assert first["max_output_tokens"] == 64_000

    types = [e["type"] for e in session.log.events()]
    assert types[0] == "run_start" and types[-1] == "run_end"
    assert types.count("model_request") == types.count("model_response") == 2
    assert types.count("tool_call") == types.count("tool_result") == 2
    assert types.index("final_submission") < types.index("run_end")
    end = run_end(session)
    assert end["stop_reason"] == "submitted" and end["turns"] == 2
    assert end["tokens"]["input_tokens"] == 2000 and end["tokens"]["output_tokens"] == 400
    assert end["cost_usd"] == pytest.approx(2 * (1000 * 2 + 200 * 10) / 1e6)
    assert session.spend_usd == pytest.approx(end["cost_usd"]) and session.turns == 2


async def test_run_start_and_model_events_are_complete_and_image_free(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    reasoning = {"id": "rs_1", "type": "reasoning", "summary": [], "encrypted_content": "e" * 2000}
    thinking = {"type": "thinking", "thinking": "Looks like Lisbon.", "item": reasoning}
    unknown = {"type": "compaction", "item": {"id": "cmp_1", "type": "compaction", "encrypted_content": "e" * 2000}}
    reply = message("tool_use", thinking, unknown, *submit().content)

    await run_agent(session, pano, FakeClient(reply), budget=budget(effort="xhigh"))

    (start,) = events(session, "run_start")
    data = start["data"]
    assert data["panorama"]["filename"] == pano_path.name and data["panorama"]["sha256"] == pano.sha256
    assert data["label"] == "Urban" and data["capture_timestamp"] == "20261011093000"
    assert data["model"] == "gpt-6.1-sol" and data["effort"] == "xhigh"
    assert data["request"]["reasoning"] == {"effort": "xhigh", "summary": "auto"}
    assert data["request"]["prompt_cache_key"] == "geoagent-run-test-p1"
    assert not {"instructions", "tools"} & set(data["request"])
    assert data["system_prompt"] == prompts.build_system_prompt(session.settings)
    assert [t["name"] for t in data["tools"]][:3] == ["view_crop", "update_candidates", "submit_locations"]
    assert "git_sha" in data

    (request,) = events(session, "model_request")
    images = [b for b in request["data"]["messages"][0]["content"] if b["type"] == "image"]
    assert len(images) == 11
    for ref in images:
        assert {"sha256", "path", "yaw", "pitch", "fov"} <= set(ref) and "source" not in ref
        assert Path(ref["path"]).is_file()
    assert any(ref["yaw"] == 45 for ref in images)

    (response,) = events(session, "model_response")
    logged = response["data"]
    assert logged["stop_reason"] == "tool_use" and logged["latency_ms"] >= 0
    assert logged["usage"]["input_tokens"] == 1000
    # The raw API item is dropped from blocks the log already describes, and elided elsewhere.
    assert logged["content"][0] == {"type": "thinking", "thinking": "Looks like Lisbon."}
    assert logged["content"][1]["item"]["encrypted_content"] == "<2000 chars omitted>"
    assert logged["content"][2]["name"] == "submit_locations"
    # No base64 payload anywhere in the log.
    assert max(len(line) for line in session.log.path.read_text().splitlines()) < 200_000


async def test_model_never_submits_uses_best_so_far(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(update(HYP), message("end_turn", text("I am fairly sure it is Lisbon.")))

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 3  # update, end_turn, end_turn again after one nudge
    assert user_texts(client.calls[2]["messages"][-1]) == [prompts.NO_SUBMISSION_NUDGE]
    assert_final(session, HYP["lat"], HYP["lng"], "agent")
    assert run_end(session)["stop_reason"] == "end_turn"


async def test_no_hypotheses_falls_back_to_prior(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)

    await run_agent(session, pano, FakeClient(message("end_turn", text("No idea."))), budget=budget())

    lat, lng = session.settings.prior_for(Label.URBAN)
    assert_final(session, lat, lng, "harness_fallback")
    (final,) = events(session, "final_submission")
    assert final["data"]["origin"] == "harness_fallback" and len(final["data"]["entries"]) == 10


async def test_hard_deadline_cancels_hanging_model_call(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    session.started_monotonic = time.monotonic()
    client = FakeClient(update(HYP), hang)

    started = time.monotonic()
    await run_agent(session, pano, client, budget=budget(hard_deadline_s=1.0))

    assert time.monotonic() - started < 5
    assert len(client.calls) == 2
    assert_final(session, HYP["lat"], HYP["lng"], "agent")
    assert run_end(session)["stop_reason"] == "hard_deadline"


async def test_hard_deadline_already_passed_still_answers(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    session.started_monotonic = time.monotonic() - 10_000

    await run_agent(session, pano, FakeClient(hang), budget=budget())

    lat, lng = session.settings.prior_for(Label.URBAN)
    assert_final(session, lat, lng, "harness_fallback")
    assert run_end(session)["stop_reason"] == "hard_deadline"


async def test_refusal_never_executes_that_turns_tools(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    refused = message("refusal", *submit(OTHER).content)
    client = FakeClient(update(HYP), refused)

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 2
    assert_final(session, HYP["lat"], HYP["lng"], "agent")
    assert run_end(session)["stop_reason"] == "refusal"
    assert [e["data"]["tool"] for e in events(session, "tool_call")] == ["update_candidates"]


async def test_non_retryable_api_error_ends_with_best_so_far(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    bad_request = openai.BadRequestError("bad", response=httpx2.Response(400, request=REQUEST), body=None)
    client = FakeClient(update(HYP), bad_request)

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 2
    assert_final(session, HYP["lat"], HYP["lng"], "agent")
    assert run_end(session)["stop_reason"] == "api_error"
    (error,) = events(session, "api_error")
    assert error["data"]["error_class"] == "BadRequestError" and error["data"]["status_code"] == 400


async def test_exhausted_quota_is_terminal_although_it_is_a_429(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Waiting does not refill an account: retrying to the deadline would only hide the cause."""
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.0)
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(update(HYP), rate_limited("insufficient_quota"))

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 2 and not events(session, "api_retry")
    assert run_end(session)["stop_reason"] == "api_error"
    (error,) = events(session, "api_error")
    assert error["data"]["error_class"] == "RateLimitError" and error["data"]["error_code"] == "insufficient_quota"
    assert_final(session, HYP["lat"], HYP["lng"], "agent")


async def test_retryable_api_errors_are_retried(tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.0)
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(rate_limited(), openai.APIConnectionError(request=REQUEST), submit())

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 3 and len(events(session, "api_retry")) == 2
    assert run_end(session)["stop_reason"] == "submitted" and run_end(session)["turns"] == 1


async def test_transient_errors_are_retried_until_the_hard_deadline(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An outage must not end the panorama while deadline is left: only the hard deadline does."""
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.05)
    monkeypatch.setattr(loop_module, "RETRY_MAX_DELAY_S", 0.1)
    session, pano = make_session(tmp_path, pano_path)
    session.started_monotonic = time.monotonic()
    client = FakeClient(update(HYP), rate_limited())

    await run_agent(session, pano, client, budget=budget(hard_deadline_s=1.5))

    assert len(client.calls) > 6  # the old fixed budget was four attempts
    assert run_end(session)["stop_reason"] == "hard_deadline"
    assert not events(session, "api_error")
    assert_final(session, HYP["lat"], HYP["lng"], "agent")


async def test_outage_longer_than_the_old_retry_budget_recovers(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.0)
    session, pano = make_session(tmp_path, pano_path)
    outage = [openai.APIConnectionError(request=REQUEST)] * 9
    client = FakeClient(*outage, submit())

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 10 and len(events(session, "api_retry")) == 9
    assert run_end(session)["stop_reason"] == "submitted"
    assert_final(session, HYP["lat"], HYP["lng"], "agent")


@pytest.mark.parametrize(
    "error",
    [
        httpx2.ReadError("connection reset"),
        httpx2.RemoteProtocolError("peer closed connection without sending complete message body"),
        httpx2.ReadTimeout("stalled"),
    ],
)
async def test_raw_transport_errors_from_a_client_are_retried_not_a_crash(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.0)
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(update(OTHER), error, submit())

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 3
    assert not events(session, "harness_error")
    assert run_end(session)["stop_reason"] == "submitted"
    # The failed attempt left no trace in the history: the turn was re-issued unchanged.
    assert client.calls[1]["messages"] == client.calls[2]["messages"]


def in_stream_error(code: str | None, type_: str | None = None, param: str | None = None) -> openai.APIError:
    """What the client raises for an `error` event or a failed response inside an open 200 stream."""
    fields = (("code", code), ("type", type_), ("param", param), ("message", "stream error"))
    body = {k: v for k, v in fields if v is not None}
    return openai.APIError("stream error", REQUEST, body=body)


def status_error(code: int, cls: type[openai.APIStatusError] = openai.APIStatusError) -> openai.APIStatusError:
    return cls("error", response=httpx2.Response(code, request=REQUEST), body=None)


def test_retry_classification() -> None:
    retryable = loop_module._retryable
    assert retryable(in_stream_error("server_error"))
    assert retryable(in_stream_error("rate_limit_exceeded"))
    assert retryable(in_stream_error("vector_store_timeout"))
    assert retryable(in_stream_error(None))
    for code in ("invalid_prompt", "invalid_image", "image_too_large", "image_content_policy_violation", "bio_policy"):
        assert not retryable(in_stream_error(code))
    assert not retryable(in_stream_error(None, "invalid_request_error"))
    assert not retryable(in_stream_error(None, param="input"))  # it names a part of the request
    assert not retryable(in_stream_error("insufficient_quota"))
    assert retryable(status_error(503)) and retryable(status_error(500, openai.InternalServerError))
    assert retryable(status_error(408)) and retryable(status_error(409, openai.ConflictError))
    assert retryable(rate_limited()) and not retryable(rate_limited("insufficient_quota"))
    assert retryable(openai.APITimeoutError(request=REQUEST))
    assert retryable(httpx2.ReadError("reset"))
    terminal = (
        (400, openai.BadRequestError),
        (401, openai.AuthenticationError),
        (403, openai.PermissionDeniedError),
        (404, openai.NotFoundError),
        (413, openai.APIStatusError),
        (422, openai.UnprocessableEntityError),
    )
    for code, cls in terminal:
        assert not retryable(status_error(code, cls))
    assert not retryable(openai.OpenAIError("no credentials"))
    assert not retryable(RuntimeError("boom"))


async def test_in_stream_server_error_is_retried(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.0)
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(in_stream_error("server_error"), submit())

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 2
    (retry,) = events(session, "api_retry")
    assert retry["data"]["status_code"] is None and retry["data"]["error_code"] == "server_error"
    assert run_end(session)["stop_reason"] == "submitted"


async def test_uncoded_in_stream_errors_are_not_retried_until_the_deadline(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An error event with no code may be a request fault (the API omits the code on some): a
    run of them ends the panorama instead of re-sending the same request for minutes."""
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.0)
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(*[in_stream_error(None)] * 10)

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == loop_module.UNCODED_STREAM_ERROR_RETRIES + 1
    assert len(events(session, "api_retry")) == loop_module.UNCODED_STREAM_ERROR_RETRIES
    (error,) = events(session, "api_error")
    assert error["data"]["error_code"] is None and "param" in error["data"]
    assert run_end(session)["stop_reason"] == "api_error"


async def test_a_coded_error_between_uncoded_ones_resets_their_count(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.0)
    session, pano = make_session(tmp_path, pano_path)
    uncoded = [in_stream_error(None)] * loop_module.UNCODED_STREAM_ERROR_RETRIES
    client = FakeClient(*uncoded, in_stream_error("server_error"), *uncoded, submit())

    await run_agent(session, pano, client, budget=budget())

    assert run_end(session)["stop_reason"] == "submitted"


def test_retry_delay_backs_off_with_a_cap_and_honours_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(loop_module, "RETRY_JITTER", 0.0)
    delay = loop_module._retry_delay
    error = openai.APIConnectionError(request=REQUEST)
    assert [delay(error, n) for n in range(5)] == [2.0, 4.0, 8.0, 16.0, 20.0]
    assert delay(error, 500) == loop_module.RETRY_MAX_DELAY_S

    def limited(retry_after: str) -> openai.RateLimitError:
        response = httpx2.Response(429, request=REQUEST, headers={"retry-after": retry_after})
        return openai.RateLimitError("rate limited", response=response, body=None)

    assert delay(limited("45"), 0, remaining_s=600) == 45.0  # the full server-requested wait
    assert delay(limited("45"), 0) == 45.0
    assert delay(limited("45"), 0, remaining_s=30) == 2.0  # it would outlast the run: keep trying
    assert delay(limited("1"), 2, remaining_s=600) == 8.0
    monkeypatch.setattr(loop_module, "RETRY_JITTER", 0.25)
    assert all(2.0 <= delay(error, 0) <= 2.5 for _ in range(50))


async def test_unexpected_exception_never_escapes(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)

    await run_agent(session, pano, FakeClient(update(HYP), RuntimeError("boom")), budget=budget())

    assert_final(session, HYP["lat"], HYP["lng"], "agent")
    assert run_end(session)["stop_reason"] == "crash"
    assert "boom" in events(session, "harness_error")[0]["data"]["error"]


async def test_max_turns(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(update(OTHER), update(OTHER), update(HYP))

    await run_agent(session, pano, client, budget=budget(max_turns=3))

    assert len(client.calls) == 3
    replies = [m for m in client.calls[-1]["messages"][1:] if m["role"] == "user"]
    assert [user_texts(m) for m in replies] == [[], [prompts.FINAL_REMINDER]]
    assert_final(session, HYP["lat"], HYP["lng"], "agent")  # the last turn's tools still ran
    assert run_end(session)["stop_reason"] == "max_turns"


async def test_max_spend(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(update(HYP, id_="call_a"))

    await run_agent(session, pano, client, budget=budget(max_spend_usd=0.005))

    assert len(client.calls) == 2  # 0.004 USD per call
    assert_final(session, HYP["lat"], HYP["lng"], "agent")
    assert run_end(session)["stop_reason"] == "max_spend"


async def test_soft_deadline_notice_is_appended_once(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(update(HYP), update(HYP), update(HYP), submit())

    await run_agent(session, pano, client, budget=budget(soft_deadline_s=0.0))

    history = client.calls[-1]["messages"]
    replies = [m for m in history[1:] if m["role"] == "user"]
    assert len(replies) == 3
    assert replies[0]["content"][0]["type"] == "tool_result"  # notice comes after the tool results
    assert user_texts(replies[0]) == [prompts.COMMIT_NOW_NOTICE]
    assert user_texts(replies[1]) == user_texts(replies[2]) == []


async def test_no_notice_before_the_soft_deadline(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(update(HYP), submit())

    await run_agent(session, pano, client, budget=budget())

    assert user_texts(client.calls[-1]["messages"][-1]) == []


async def test_operator_cue_is_injected_after_tool_results(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, pano = make_session(tmp_path, pano_path, no_human=False)
    queued = ["the kerb stones are painted yellow"]

    def drain() -> list[str]:
        cues, queued[:] = list(queued), []
        return cues

    monkeypatch.setattr(session, "drain_cues", drain)
    client = FakeClient(update(HYP), update(HYP), submit())

    await run_agent(session, pano, client, budget=budget())

    replies = [m for m in client.calls[-1]["messages"][1:] if m["role"] == "user"]
    assert user_texts(replies[0]) == [prompts.cue_message("the kerb stones are painted yellow")]
    assert user_texts(replies[1]) == []
    logged = events(session, "model_request")[1]["data"]["messages"][0]["content"]
    assert logged[-1]["text"] == prompts.cue_message("the kerb stones are painted yellow")


async def test_parallel_tool_calls_return_in_one_user_message(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    turn = message(
        "tool_use",
        tool_use("view_crop", {"yaw": 90, "pitch": 0, "fov": 60, "enhance": False}, "call_v"),
        tool_use("update_candidates", {"hypotheses": [HYP]}, "call_u"),
        tool_use("no_such_tool", {}, "call_x"),
    )
    client = FakeClient(turn, submit())

    await run_agent(session, pano, client, budget=budget())

    results = tool_results(client.calls[1]["messages"][-1])
    assert [r["tool_use_id"] for r in results] == ["call_v", "call_u", "call_x"]
    assert [r.get("is_error", False) for r in results] == [False, False, True]
    assert any(b["type"] == "image" for b in results[0]["content"])
    logged = events(session, "model_request")[1]["data"]["messages"][0]["content"]
    (crop,) = [b for b in logged[0]["content"] if b["type"] == "image"]
    assert Path(crop["path"]).is_file() and "source" not in crop


async def test_max_tokens_does_not_execute_truncated_tool_calls(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    cut_off = tool_use("submit_locations", {"hypotheses": [OTHER]}, "call_t", incomplete=True)
    client = FakeClient(message("max_tokens", cut_off), submit(HYP))

    await run_agent(session, pano, client, budget=budget())

    (result,) = tool_results(client.calls[1]["messages"][-1])
    assert result["tool_use_id"] == "call_t" and result["is_error"] is True
    assert result["content"] == loop_module.TRUNCATED_TOOL_NOTICE
    assert events(session, "tool_call")[0]["data"]["input"]["hypotheses"] == [HYP]
    assert_final(session, HYP["lat"], HYP["lng"], "agent")


async def test_stops_when_finalised_from_outside(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)

    async def finalise_then_reply() -> Any:
        session.finalize(reason="operator")
        return update(OTHER)

    client = FakeClient(finalise_then_reply)

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 1
    assert session.final is not None and session.final[0].origin == "harness_fallback"
    assert run_end(session)["stop_reason"] == "finalized_externally"


async def test_cancellation_still_finalises(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    job = asyncio.create_task(run_agent(session, pano, FakeClient(update(HYP), hang), budget=budget()))
    while not events(session, "candidates_update"):
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)

    job.cancel()
    with pytest.raises(asyncio.CancelledError):
        await job

    assert_final(session, HYP["lat"], HYP["lng"], "agent")
    assert run_end(session)["stop_reason"] == "cancelled"


def test_estimate_cost_uses_every_counter() -> None:
    usage = {
        "input_tokens": 200_000,  # as reported: includes the cached and the cache-write tokens
        "cached_input_tokens": 100_000,
        "cache_write_tokens": 50_000,
        "output_tokens": 100_000,  # includes the reasoning tokens, which are not charged twice
        "reasoning_tokens": 60_000,
        "web_search_requests": 100,
    }
    tokens = 50_000 * 2.0 + 100_000 * 0.10 + 50_000 * 2.50 + 100_000 * 10.0
    assert estimate_cost(usage, Pricing()) == pytest.approx(tokens / 1e6 + 1.0)
    assert estimate_cost(SimpleNamespace(input_tokens=500, output_tokens=None), Pricing()) == pytest.approx(0.001)
    assert usage_dict(None) == dict.fromkeys(usage, 0)
    assert usage_dict({**usage, "total_tokens": 9}) == usage
    # Counters that do not add up never produce a negative charge.
    assert estimate_cost({"input_tokens": 10, "cached_input_tokens": 1_000_000}, Pricing()) == pytest.approx(0.10)


def test_long_context_reprices_the_whole_request() -> None:
    pricing = Pricing()
    at_threshold = {"input_tokens": 272_000, "output_tokens": 1000}
    assert estimate_cost(at_threshold, pricing) == pytest.approx((272_000 * 2.0 + 1000 * 10.0) / 1e6)
    over = {"input_tokens": 300_000, "cached_input_tokens": 100_000, "cache_write_tokens": 20_000, "output_tokens": 1000}
    inputs = (180_000 * 2.0 + 100_000 * 0.10 + 20_000 * 2.50) * 2.0
    assert estimate_cost(over, pricing) == pytest.approx((inputs + 1000 * 10.0 * 1.5) / 1e6)
    custom = Pricing(input=1.0, cached_input=0.0, cache_write=0.0, output=0.0, long_context_threshold=100, long_input_multiplier=3.0)
    assert estimate_cost({"input_tokens": 1_000_000}, custom) == pytest.approx(3.0)


def test_prompt_cache_key_is_stable_per_panorama_and_fits_the_api_limit() -> None:
    assert prompt_cache_key("run-test", "p1") == prompt_cache_key("run-test", "p1") == "geoagent-run-test-p1"
    assert prompt_cache_key("run-test", "p1") != prompt_cache_key("run-test", "p2")
    long = prompt_cache_key("run-" + "x" * 80, "panorama-" + "y" * 80)
    assert len(long) <= 64 and long == prompt_cache_key("run-" + "x" * 80, "panorama-" + "y" * 80)
    assert long != prompt_cache_key("run-" + "x" * 80, "panorama-" + "y" * 79)


def test_request_params_ask_for_what_a_stateless_conversation_needs(tmp_path: Path) -> None:
    web = Settings(runs_dir=tmp_path, cache_dir=tmp_path, allow_web=True)
    params = loop_module.build_request_params(web, budget(effort="max"), "key-1")
    assert params["include"] == ["reasoning.encrypted_content", "web_search_call.action.sources"]
    assert params["reasoning"] == {"effort": "max", "summary": "auto"} and params["prompt_cache_key"] == "key-1"
    assert set(params) == {
        "model", "instructions", "tools", "reasoning", "max_output_tokens", "parallel_tool_calls", "store",
        "include", "prompt_cache_key",
    }  # fmt: skip


async def test_missing_api_key_is_a_clear_api_error_with_a_fallback_answer(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("OPENAI_API_KEY", "OPENAI_ADMIN_KEY"):
        monkeypatch.delenv(name, raising=False)
    session, pano = make_session(tmp_path, pano_path)
    client = OpenAIModelClient()  # constructing it must not need the key: the run has to start
    await run_agent(session, pano, client, budget=budget())
    assert run_end(session)["stop_reason"] == "api_error"
    (error,) = events(session, "api_error")
    assert "OPENAI_API_KEY" in error["data"]["message"] and error["data"]["error_class"] == "OpenAIError"
    assert not events(session, "harness_error") and not events(session, "api_retry")
    assert session.final is not None and len(session.final) == 10
    assert {e.origin for e in session.final} == {"harness_fallback"}
    await client.aclose()  # nothing was built, nothing to close


async def test_images_stop_at_the_request_budget(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loop_module, "MAX_REQUEST_IMAGES", 12)  # 11 initial views + one crop
    session, pano = make_session(tmp_path, pano_path)
    crop = {"yaw": 10.0, "pitch": 0.0, "fov": 60.0, "enhance": False}
    client = FakeClient(
        message("tool_use", tool_use("view_crop", crop, "call_c1"), tool_use("view_crop", crop, "call_c2")),
        submit(),
    )
    await run_agent(session, pano, client, budget=budget())
    first, second = client.calls[1]["messages"][-1]["content"][:2]
    assert [b["type"] for b in first["content"]] == ["text", "image"]
    assert [b["type"] for b in second["content"]] == ["text", "text"]
    assert second["content"][1]["text"] == loop_module.IMAGE_BUDGET_NOTICE
    images = sum(
        block.get("type") == "image"
        for m in client.calls[1]["messages"]
        if m["role"] == "user"
        for outer in m["content"]
        for block in (outer.get("content", []) if outer.get("type") == "tool_result" else [outer])
    )
    assert images == 12
    assert run_end(session)["stop_reason"] == "submitted"


# --- the real SDK over a mock transport: what actually comes out of a broken stream ------------


def _sse(data: dict[str, Any]) -> bytes:
    return f"event: {data['type']}\ndata: {json.dumps(data)}\n\n".encode()


def _response(status: str = "completed", output: list[dict[str, Any]] | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "id": "resp_1", "object": "response", "created_at": 0, "model": "gpt-6.1-sol", "status": status,
        "output": output or [], "parallel_tool_calls": True, "tool_choice": "auto", "tools": [],
        "usage": {
            "input_tokens": 3, "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
            "output_tokens": 2, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 5,
        },
        **extra,
    }  # fmt: skip


def _terminal(kind: str, response: dict[str, Any]) -> bytes:
    return _sse({"type": f"response.{kind}", "sequence_number": 9, "response": response})


CREATED = _sse({"type": "response.created", "sequence_number": 0, "response": _response("in_progress")})
TEXT_ITEM = {
    "id": "msg_1", "type": "message", "role": "assistant", "status": "completed",
    "content": [{"type": "output_text", "text": "ok", "annotations": []}],
}  # fmt: skip
CUT_CALL = {
    "id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "view_crop", "status": "incomplete",
    "arguments": '{"yaw": 1',
}  # fmt: skip
COMPLETE_STREAM = [
    CREATED,
    _sse({"type": "response.output_item.done", "sequence_number": 1, "output_index": 0, "item": TEXT_ITEM}),
    _terminal("completed", _response(output=[TEXT_ITEM])),
]
TRUNCATED_STREAM = [
    CREATED,
    _terminal("incomplete", _response("incomplete", [CUT_CALL], incomplete_details={"reason": "max_output_tokens"})),
]


def failed_stream(code: str) -> list[bytes]:
    return [CREATED, _terminal("failed", _response("failed", error={"code": code, "message": f"failed: {code}"}))]


ERROR_EVENT = [
    CREATED,
    _sse({"type": "error", "sequence_number": 1, "code": "server_error", "message": "The server had an error", "param": None}),
]


class _Body(httpx2.AsyncByteStream):
    def __init__(self, chunks: list[bytes], error: Exception | None = None) -> None:
        self.chunks, self.error = chunks, error

    async def __aiter__(self) -> Any:
        for chunk in self.chunks:
            yield chunk
        if self.error is not None:
            raise self.error


def rejection(message_: str, **error: Any) -> httpx2.Response:
    """A 400 as the API words it: the error object carries message, type, param and code."""
    body = {"error": {"message": message_, "type": "invalid_request_error", "param": None, "code": None, **error}}
    return httpx2.Response(400, json=body)


def sdk_client(*replies: _Body | httpx2.Response) -> tuple[OpenAIModelClient, list[httpx2.Request]]:
    """An OpenAIModelClient on the real SDK whose HTTP layer plays the given SSE bodies (or
    whole responses, for a request rejected before the stream opens)."""
    pending, seen = list(replies), []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        reply = pending.pop(0)
        if isinstance(reply, httpx2.Response):
            return reply
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, stream=reply)

    sdk = openai.AsyncOpenAI(
        api_key="test-key", max_retries=0, http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    )
    return OpenAIModelClient(sdk, image_detail="low"), seen


SDK_PARAMS: dict[str, Any] = {
    "model": "gpt-6.1-sol",
    "max_output_tokens": 64,
    "reasoning": {"effort": "high", "summary": "auto"},
    "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
}


async def test_client_streams_the_translated_history_and_returns_a_neutral_response() -> None:
    client, seen = sdk_client(_Body(COMPLETE_STREAM))

    response = await client.create(**SDK_PARAMS)

    sent = json.loads(seen[0].content)
    assert seen[0].url.path == "/v1/responses" and sent["stream"] is True and "messages" not in sent
    assert sent["input"] == [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}]
    assert sent["reasoning"] == {"effort": "high", "summary": "auto"}
    assert response.id == "resp_1" and response.model == "gpt-6.1-sol"
    assert response.stop_reason == "end_turn" and response.stop_details is None
    assert response.content == [{"type": "text", "text": "ok", "item": TEXT_ITEM}]
    assert usage_dict(response.usage) == response.usage and response.usage["input_tokens"] == 3


async def test_truncated_response_is_returned_with_its_cut_tool_call_flagged() -> None:
    """The SDK's own stream helper raises on `response.incomplete`; the client must hand it over."""
    client, _ = sdk_client(_Body(TRUNCATED_STREAM))

    response = await client.create(**SDK_PARAMS)

    assert response.stop_reason == "max_tokens" and response.stop_details == {"reason": "max_output_tokens"}
    (call,) = response.content
    assert call["id"] == "call_1" and call["input"] == {} and call["incomplete"] is True
    assert call["item"] == CUT_CALL  # echoed as it came, so that its error output has a call to answer


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (httpx2.ReadError("connection reset by peer"), openai.APIConnectionError),
        (httpx2.RemoteProtocolError("incomplete chunked read"), openai.APIConnectionError),
        (httpx2.ReadTimeout("no bytes for 120 s"), openai.APITimeoutError),
    ],
)
async def test_mid_stream_transport_error_becomes_a_retryable_sdk_error(
    error: Exception, expected: type[Exception]
) -> None:
    client, seen = sdk_client(_Body([CREATED], error))

    with pytest.raises(expected) as caught:
        await client.create(**SDK_PARAMS)

    assert isinstance(caught.value, openai.APIConnectionError)
    assert loop_module._retryable(caught.value)
    assert caught.value.__cause__ is error
    assert len(seen) == 1


async def test_failed_response_is_raised_and_classified_by_its_code() -> None:
    client, _ = sdk_client(_Body(failed_stream("server_error")), _Body(failed_stream("invalid_prompt")))

    with pytest.raises(openai.APIError) as transient:
        await client.create(**SDK_PARAMS)
    with pytest.raises(openai.APIError) as fault:
        await client.create(**SDK_PARAMS)

    assert transient.value.code == "server_error" and "failed: server_error" in str(transient.value)
    assert not hasattr(transient.value, "status_code")  # it arrived inside a 200 stream
    assert loop_module._retryable(transient.value)
    assert fault.value.code == "invalid_prompt" and not loop_module._retryable(fault.value)


async def test_stream_error_event_is_raised_as_a_retryable_api_error() -> None:
    client, _ = sdk_client(_Body(ERROR_EVENT))

    with pytest.raises(openai.APIError) as caught:
        await client.create(**SDK_PARAMS)

    assert caught.value.code == "server_error" and "The server had an error" in str(caught.value)
    assert loop_module._retryable(caught.value)


async def test_stream_error_event_naming_a_parameter_is_terminal_and_logged_without_a_fake_type() -> None:
    """The event's own `type` is "error"; it must not pass for the error class."""
    event = {"type": "error", "sequence_number": 1, "code": None, "message": "Invalid prompt: too long", "param": "input"}
    client, _ = sdk_client(_Body([CREATED, _sse(event)]))

    with pytest.raises(openai.APIError) as caught:
        await client.create(**SDK_PARAMS)

    data = loop_module._api_error_data(caught.value)
    assert data["error_type"] is None and data["error_code"] is None and data["param"] == "input"
    assert "Invalid prompt" in data["message"]
    assert not loop_module._retryable(caught.value)


async def test_stream_that_ends_without_a_terminal_event_is_retryable() -> None:
    """The SDK ends iteration cleanly when the body just stops: no response must not pass for one."""
    client, _ = sdk_client(_Body([CREATED, _sse({"type": "response.output_item.done", "sequence_number": 1, "output_index": 0, "item": TEXT_ITEM})]))

    with pytest.raises(openai.APIConnectionError) as caught:
        await client.create(**SDK_PARAMS)

    assert "before the response completed" in str(caught.value)
    assert loop_module._retryable(caught.value)


async def test_corrupted_event_payload_in_the_stream_is_retryable() -> None:
    garbled = b'event: response.output_item.done\ndata: {"type": "response.output_item.done", "output_index": 0, "it\n\n'
    client, _ = sdk_client(_Body([CREATED, garbled]))

    with pytest.raises(openai.APIConnectionError) as caught:
        await client.create(**SDK_PARAMS)

    assert isinstance(caught.value.__cause__, json.JSONDecodeError)
    assert loop_module._retryable(caught.value)


class _FakeSdk:
    """Stands in for AsyncOpenAI where the failure comes from the SDK call itself."""

    def __init__(self, outcome: BaseException) -> None:
        self.outcome = outcome
        self.responses = SimpleNamespace(create=self._create)
        self.closed = False

    async def _create(self, **params: Any) -> Any:
        raise self.outcome

    async def close(self) -> None:
        self.closed = True


async def test_other_value_errors_are_not_disguised_as_connection_errors() -> None:
    sdk = _FakeSdk(ValueError("max_output_tokens must be positive"))
    client = OpenAIModelClient(sdk)  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="max_output_tokens"):
        await client.create(model="gpt-6.1-sol", messages=[])

    await client.aclose()
    assert sdk.closed


async def test_client_drops_reasoning_summaries_once_the_api_rejects_them() -> None:
    unverified = rejection(
        "Your organization must be verified to generate reasoning summaries.",
        param="reasoning.summary", code="unsupported_value",
    )  # fmt: skip
    client, seen = sdk_client(unverified, _Body(COMPLETE_STREAM), _Body(COMPLETE_STREAM))

    first = await client.create(**SDK_PARAMS)
    second = await client.create(**SDK_PARAMS)

    assert first.stop_reason == second.stop_reason == "end_turn"
    sent = [json.loads(r.content)["reasoning"] for r in seen]
    assert sent == [{"effort": "high", "summary": "auto"}, {"effort": "high"}, {"effort": "high"}]
    assert SDK_PARAMS["reasoning"] == {"effort": "high", "summary": "auto"}  # the caller's params are not edited


async def test_concurrent_requests_all_survive_the_summary_rejection() -> None:
    """Six panoramas share the client: every first request is rejected before any is re-sent."""
    seen: list[dict[str, Any]] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent = json.loads(request.content)
        seen.append(sent["reasoning"])
        if "summary" in sent["reasoning"]:
            return rejection("Your organization must be verified.", param="reasoning.summary", code="unsupported_value")
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, stream=_Body(COMPLETE_STREAM))

    sdk = openai.AsyncOpenAI(
        api_key="test-key", max_retries=0, http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    )
    client = OpenAIModelClient(sdk)

    responses = await asyncio.gather(*(client.create(**SDK_PARAMS) for _ in range(6)))
    later = await client.create(**SDK_PARAMS)

    assert [r.stop_reason for r in (*responses, later)] == ["end_turn"] * 7
    assert seen.count({"effort": "high", "summary": "auto"}) == 6 and seen.count({"effort": "high"}) == 7


async def test_client_reraises_other_bad_requests() -> None:
    client, seen = sdk_client(rejection("Unsupported value: 'none'", param="reasoning.effort", code="unsupported_value"))

    with pytest.raises(openai.BadRequestError) as caught:
        await client.create(**SDK_PARAMS)

    assert len(seen) == 1 and caught.value.param == "reasoning.effort"
    assert not loop_module._retryable(caught.value)


async def test_run_survives_a_dropped_stream_on_the_real_sdk(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End to end: connection reset mid-response, then a failed response, then a good one."""
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.0)
    session, pano = make_session(tmp_path, pano_path)
    client, seen = sdk_client(
        _Body([CREATED], httpx2.ReadError("reset")),
        _Body(failed_stream("server_error")),
        _Body(COMPLETE_STREAM),
        _Body(COMPLETE_STREAM),
    )

    await run_agent(session, pano, client, budget=budget())

    assert len(seen) == 4  # two failed attempts, the answer, then the nudge turn
    assert [e["data"]["error_class"] for e in events(session, "api_retry")] == ["APIConnectionError", "APIError"]
    assert not events(session, "harness_error") and not events(session, "api_error")
    assert run_end(session)["stop_reason"] == "end_turn"
    first, retried, _, nudge = (json.loads(r.content) for r in seen)
    assert first["stream"] is True and first["max_output_tokens"] == 64_000 and first["store"] is False
    assert first["instructions"] == prompts.build_system_prompt(session.settings) and "messages" not in first
    assert first["input"] == retried["input"]  # a failed attempt leaves no trace in what is sent
    (opening,) = first["input"]
    images = [part for part in opening["content"] if part["type"] == "input_image"]
    assert len(images) == 11 and {part["detail"] for part in images} == {"low"}
    assert all(part["image_url"].startswith("data:image/jpeg;base64,") for part in images)
    # The answer is echoed as the item the API sent, followed by the nudge as a user message.
    assert nudge["input"][1] == TEXT_ITEM
    assert nudge["input"][2]["content"][0] == {"type": "input_text", "text": prompts.NO_SUBMISSION_NUDGE}
    assert run_end(session)["tokens"]["input_tokens"] == 6


async def test_truncated_tool_call_on_the_real_sdk_is_answered_not_executed(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    client, seen = sdk_client(_Body(TRUNCATED_STREAM), _Body(COMPLETE_STREAM), _Body(COMPLETE_STREAM))

    await run_agent(session, pano, client, budget=budget())

    assert not events(session, "tool_call") and not events(session, "harness_error")
    call, output, notices = json.loads(seen[1].content)["input"][1:]
    assert call == CUT_CALL
    assert output == {"type": "function_call_output", "call_id": "call_1", "output": loop_module.TRUNCATED_TOOL_NOTICE}
    assert notices["role"] == "user" and notices["content"][0]["text"].startswith(prompts.STATUS_PREFIX)


def test_default_client_detects_a_stalled_stream_quickly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    sdk = OpenAIModelClient()._sdk()
    assert sdk.timeout.read == API_READ_TIMEOUT_S == 60.0
    assert sdk.timeout.connect == 10.0 and sdk.timeout.write == 600.0
    assert sdk.max_retries == 1  # the loop does the retrying, against the deadline
    assert OpenAIModelClient(read_timeout_s=90.0)._sdk().timeout.read == 90.0
    assert Settings().api_read_timeout_s == 60.0 and Settings().max_tokens == 64_000


# --- max_tokens, same-turn question + submit, status line ------------------------------------------


async def test_max_tokens_keeps_the_tool_calls_completed_before_the_cut(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    truncated = message(
        "max_tokens",
        tool_use("update_candidates", {"hypotheses": [OTHER]}, "call_done"),
        tool_use("view_crop", {}, "call_cut", incomplete=True),
    )
    client = FakeClient(truncated, message("end_turn", text("done")))

    await run_agent(session, pano, client, budget=budget())

    done, cut = tool_results(client.calls[1]["messages"][-1])
    assert done["tool_use_id"] == "call_done" and "is_error" not in done
    assert cut["tool_use_id"] == "call_cut" and cut["is_error"] is True
    assert cut["content"] == loop_module.TRUNCATED_TOOL_NOTICE
    assert [e["data"]["tool"] for e in events(session, "tool_call")] == ["update_candidates"]
    assert_final(session, OTHER["lat"], OTHER["lng"], "agent")  # the complete update was recorded


async def test_max_tokens_with_trailing_text_runs_every_tool_call(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    truncated = message("max_tokens", tool_use("update_candidates", {"hypotheses": [OTHER]}, "call_a"), text("and then"))
    client = FakeClient(truncated, message("end_turn", text("done")))

    await run_agent(session, pano, client, budget=budget())

    (result,) = tool_results(client.calls[1]["messages"][-1])
    assert "is_error" not in result
    assert_final(session, OTHER["lat"], OTHER["lng"], "agent")


async def test_max_tokens_while_still_reasoning_asks_the_model_to_be_brief(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    reasoning = {"type": "thinking", "thinking": "", "item": {"id": "rs_1", "type": "reasoning", "summary": []}}
    client = FakeClient(message("max_tokens", reasoning), submit(HYP))

    await run_agent(session, pano, client, budget=budget())

    history = client.calls[1]["messages"]
    assert history[1] == {"role": "assistant", "content": [reasoning]}
    assert user_texts(history[2]) == [prompts.MAX_TOKENS_NOTICE]
    assert run_end(session)["stop_reason"] == "submitted"


async def test_incomplete_tool_call_in_a_finished_turn_is_answered_not_executed(tmp_path: Path, pano_path: Path) -> None:
    """Arguments that are not a JSON object must not reach a handler, and still need an output."""
    session, pano = make_session(tmp_path, pano_path)
    turn = message(
        "tool_use",
        tool_use("submit_locations", {}, "call_bad", incomplete=True),
        tool_use("update_candidates", {"hypotheses": [OTHER]}, "call_ok"),
    )
    client = FakeClient(turn, submit(HYP))

    await run_agent(session, pano, client, budget=budget())

    bad, ok = tool_results(client.calls[1]["messages"][-1])
    assert bad == {
        "type": "tool_result",
        "tool_use_id": "call_bad",
        "content": loop_module.INCOMPLETE_TOOL_NOTICE,
        "is_error": True,
    }
    assert ok["tool_use_id"] == "call_ok" and "is_error" not in ok
    assert [e["data"]["tool"] for e in events(session, "tool_call")] == ["update_candidates", "submit_locations"]
    assert events(session, "tool_call")[1]["data"]["tool_use_id"] == "call_s"
    assert_final(session, HYP["lat"], HYP["lng"], "agent")


async def test_question_in_the_same_turn_as_submit_is_never_charged(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path, no_human=False)
    question = {"question": "Which square?", "options": ["A", "B"], "why_it_matters": "splits the top two"}
    turn = message(
        "tool_use",
        tool_use("ask_multiple_choice", question, "call_q"),
        tool_use("submit_locations", {"hypotheses": [HYP], "reasoning_summary": "x"}, "call_s"),
    )
    client = FakeClient(turn)

    await run_agent(session, pano, client, budget=budget())

    assert session.ledger.mcqs == 0 and session.ledger.multiplier == 1.0
    assert not events(session, "mcq_asked")
    assert {e.multiplier for e in session.final or []} == {1.0}
    refused = [e for e in events(session, "tool_result") if e["data"]["tool"] == "ask_multiple_choice"]
    assert len(refused) == 1 and refused[0]["data"]["is_error"] is True
    assert "no penalty" in refused[0]["data"]["output"]
    assert run_end(session)["stop_reason"] == "submitted"


async def test_question_on_its_own_is_still_asked(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path, no_human=False, mcq_timeout_s=0.05)
    question = {"question": "Which square?", "options": ["A", "B"], "why_it_matters": "splits the top two"}
    client = FakeClient(update(HYP), message("tool_use", tool_use("ask_multiple_choice", question, "call_q")), submit())

    await run_agent(session, pano, client, budget=budget())

    assert session.ledger.mcqs == 1 and len(events(session, "mcq_asked")) == 1
    assert {e.multiplier for e in session.final or []} == {0.95}


async def test_agent_is_told_its_real_budget_and_progress(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    live = budget(soft_deadline_s=150, hard_deadline_s=210, max_turns=12)
    client = FakeClient(update(HYP), submit())

    await run_agent(session, pano, client, budget=live)

    task = client.calls[0]["messages"][0]["content"][0]["text"]
    assert "2 min 30 s" in task and "3 min 30 s" in task and "12 turns" in task
    assert f"{loop_module.MAX_REQUEST_IMAGES} images" in task
    assert "FIRST turn" in task
    assert "ten minutes" not in client.calls[0]["instructions"]
    (status,) = status_lines(client.calls[1]["messages"][-1])
    assert "turn 1 of 12" in status
    # Count or payload share, whichever is nearer its cap (noise JPEGs are large, so payload here).
    used = int(status.split("image budget used ")[1].split(" of ")[0])
    assert 11 <= used < loop_module.MAX_REQUEST_IMAGES and status.endswith(f"of {loop_module.MAX_REQUEST_IMAGES}.")
    assert "until you are asked to commit" in status
    request = events(session, "model_request")[1]["data"]
    assert request["image_count"] == 11 and request["image_payload_chars"] > 0


async def test_standard_budget_task_text_has_no_first_turn_pressure(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(submit())

    await run_agent(session, pano, client, budget=budget())

    task = client.calls[0]["messages"][0]["content"][0]["text"]
    assert "10 min" in task and "14 min" in task and "30 turns" in task and "FIRST turn" not in task


async def test_cue_arriving_during_the_submit_turn_is_delivered_before_the_answer_is_fixed(
    tmp_path: Path, pano_path: Path
) -> None:
    session, pano = make_session(tmp_path, pano_path, no_human=False)

    async def cue_arrives_then_model_submits() -> Any:
        session.submit_cue("the kerb stones are painted yellow", confirmed=True)
        return submit(OTHER)

    client = FakeClient(cue_arrives_then_model_submits, submit(HYP))

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 2
    reply = client.calls[1]["messages"][-1]
    (deferred,) = tool_results(reply)
    assert deferred["is_error"] is True and "cue" in deferred["content"][0]["text"]
    assert user_texts(reply) == [prompts.cue_message("the kerb stones are painted yellow")]
    assert not events(session, "human_cue_undelivered")
    assert_final(session, HYP["lat"], HYP["lng"], "agent")
    assert {e.multiplier for e in session.final or []} == {0.8}
    # The deferred submission was still kept as best-so-far in case the run had ended there.
    assert events(session, "candidates_update")[0]["data"]["hypotheses"][0]["label"] == OTHER["label"]


async def test_cue_that_never_reaches_the_agent_is_logged_as_undelivered(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_module, "CUE_MIN_REMAINING_S", 0.0)
    session, pano = make_session(tmp_path, pano_path, no_human=False)
    session.started_monotonic = time.monotonic()

    async def cue_then_hang() -> Any:
        session.submit_cue("the kerb stones are painted yellow", confirmed=True)
        await asyncio.sleep(3600)

    client = FakeClient(update(HYP), cue_then_hang)

    await run_agent(session, pano, client, budget=budget(hard_deadline_s=1.0))

    assert run_end(session)["stop_reason"] == "hard_deadline"
    (lost,) = events(session, "human_cue_undelivered")
    assert lost["data"]["text"] == "the kerb stones are painted yellow"
    assert lost["data"]["delivered_to_agent"] is False and lost["data"]["penalty_kept"] is True
    types = [e["type"] for e in session.log.events()]
    assert types.index("human_cue_undelivered") < types.index("final_submission")
    assert {e.multiplier for e in session.final or []} == {0.8}  # the human did submit it: R6 applies


async def test_cue_too_close_to_the_hard_deadline_is_refused_without_penalty(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path, no_human=False)
    session.started_monotonic = time.monotonic()
    outcome: list[Any] = []

    async def cue_then_hang() -> Any:
        try:
            session.submit_cue("the kerb stones are painted yellow", confirmed=True)
        except session_module.HumanChannelError as exc:
            outcome.append(exc)
        await asyncio.sleep(3600)

    await run_agent(session, pano, FakeClient(update(HYP), cue_then_hang), budget=budget(hard_deadline_s=1.0))

    assert len(outcome) == 1 and "too late" in str(outcome[0])
    assert session.ledger.cues == 0 and not events(session, "human_cue")
    assert {e.multiplier for e in session.final or []} == {1.0}


async def test_question_too_close_to_the_hard_deadline_is_refused_without_penalty(
    tmp_path: Path, pano_path: Path
) -> None:
    session, pano = make_session(tmp_path, pano_path, no_human=False)
    session.started_monotonic = time.monotonic()
    question = {"question": "Which square?", "options": ["A", "B"], "why_it_matters": "splits the top two"}
    client = FakeClient(update(HYP), message("tool_use", tool_use("ask_multiple_choice", question, "call_q")), submit())

    # 100 s left is less than the 90 s answer window plus a turn to act on the click.
    await run_agent(session, pano, client, budget=budget(hard_deadline_s=100.0))

    assert session.ledger.mcqs == 0 and not events(session, "mcq_asked")
    (refused,) = [e for e in events(session, "tool_result") if e["data"]["tool"] == "ask_multiple_choice"]
    assert refused["data"]["is_error"] is True and "no penalty" in refused["data"]["output"]
    assert {e.multiplier for e in session.final or []} == {1.0}
