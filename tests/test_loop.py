"""Agent loop driven by a scripted fake model client: no network, no API key."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import anthropic
import cv2
import httpx2
import numpy as np
import pytest

from geoagent import loop as loop_module
from geoagent import prompts
from geoagent import session as session_module
from geoagent.config import Budget, Pricing, Settings
from geoagent.loop import FALLBACK_BETA, AnthropicModelClient, estimate_cost, run_agent, usage_dict
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
REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def budget(**overrides: Any) -> Budget:
    base = {"effort": "high", "soft_deadline_s": 600, "hard_deadline_s": 840, "max_turns": 30, "max_spend_usd": 8.0}
    return Budget(**{**base, **overrides})


def tool_use(name: str, input_: dict[str, Any], id_: str = "toolu_1") -> SimpleNamespace:
    return SimpleNamespace(type="tool_use", id=id_, name=name, input=input_)


def text(value: str) -> SimpleNamespace:
    return SimpleNamespace(type="text", text=value)


def message(stop_reason: str, *blocks: Any, **usage: int) -> SimpleNamespace:
    counters = {"input_tokens": 1000, "output_tokens": 200, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
    return SimpleNamespace(
        id="msg_test",
        model="claude-opus-5-5",
        content=list(blocks),
        stop_reason=stop_reason,
        stop_details=None,
        usage=SimpleNamespace(**{**counters, **usage}, server_tool_use=None),
    )


def update(*hyps: dict[str, Any], id_: str = "toolu_u") -> SimpleNamespace:
    return message("tool_use", tool_use("update_candidates", {"hypotheses": list(hyps or (HYP,))}, id_))


def submit(*hyps: dict[str, Any]) -> SimpleNamespace:
    args = {"hypotheses": list(hyps or (HYP,)), "reasoning_summary": "matched the tram stop"}
    return message("tool_use", tool_use("submit_locations", args, "toolu_s"))


def rate_limited() -> anthropic.RateLimitError:
    return anthropic.RateLimitError("rate limited", response=httpx2.Response(429, request=REQUEST), body=None)


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
    assert first["model"] == "claude-opus-5-5"
    assert first["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert first["output_config"] == {"effort": "high"}
    assert first["fallbacks"] == "default" and first["betas"] == [FALLBACK_BETA]
    assert first["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert not {"tool_choice", "temperature", "top_p", "top_k"} & set(first)
    assert [m["role"] for m in first["messages"]] == ["user"]
    assert sum(b["type"] == "image" for b in first["messages"][0]["content"]) == 11

    # Byte-stable prefix: identical system and tools on every call, history only ever appended.
    assert json.dumps(first["system"]) == json.dumps(second["system"])
    assert json.dumps(first["tools"]) == json.dumps(second["tools"])
    assert [m["role"] for m in second["messages"]] == ["user", "assistant", "user"]
    assert second["messages"][0] is first["messages"][0]
    assert second["messages"][1]["content"] == update(OTHER).content
    (result,) = tool_results(second["messages"][2])
    assert result["tool_use_id"] == "toolu_u" and "is_error" not in result
    assert second["messages"][2]["content"][0] is result  # tool results come first in the message
    assert first["max_tokens"] == 64_000

    types = [e["type"] for e in session.log.events()]
    assert types[0] == "run_start" and types[-1] == "run_end"
    assert types.count("model_request") == types.count("model_response") == 2
    assert types.count("tool_call") == types.count("tool_result") == 2
    assert types.index("final_submission") < types.index("run_end")
    end = run_end(session)
    assert end["stop_reason"] == "submitted" and end["turns"] == 2
    assert end["tokens"]["input_tokens"] == 2000 and end["tokens"]["output_tokens"] == 400
    assert end["cost_usd"] == pytest.approx(2 * (1000 * 4 + 200 * 20) / 1e6)
    assert session.spend_usd == pytest.approx(end["cost_usd"]) and session.turns == 2


async def test_run_start_and_model_events_are_complete_and_image_free(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    thinking = SimpleNamespace(type="thinking", thinking="Looks like Lisbon.", signature="s" * 2000)
    reply = message("tool_use", thinking, *submit().content)

    await run_agent(session, pano, FakeClient(reply), budget=budget(effort="xhigh"))

    (start,) = events(session, "run_start")
    data = start["data"]
    assert data["panorama"]["filename"] == pano_path.name and data["panorama"]["sha256"] == pano.sha256
    assert data["label"] == "Urban" and data["capture_timestamp"] == "20261011093000"
    assert data["model"] == "claude-opus-5-5" and data["effort"] == "xhigh"
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
    assert logged["content"][0]["thinking"] == "Looks like Lisbon."
    assert logged["content"][0]["signature"] == "<2000 chars omitted>"
    assert logged["content"][1]["name"] == "submit_locations"
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


async def test_pause_turn_resends_without_a_user_message(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    paused = message("pause_turn", SimpleNamespace(type="server_tool_use", id="srvtoolu_1", name="web_search", input={}))
    client = FakeClient(paused, submit())

    await run_agent(session, pano, client, budget=budget())

    resumed = client.calls[1]["messages"]
    assert [m["role"] for m in resumed] == ["user", "assistant"]
    assert resumed[1]["content"] == paused.content
    assert events(session, "model_request")[1]["data"]["messages"] == []
    assert run_end(session)["stop_reason"] == "submitted"


async def test_non_retryable_api_error_ends_with_best_so_far(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    bad_request = anthropic.BadRequestError("bad", response=httpx2.Response(400, request=REQUEST), body=None)
    client = FakeClient(update(HYP), bad_request)

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 2
    assert_final(session, HYP["lat"], HYP["lng"], "agent")
    assert run_end(session)["stop_reason"] == "api_error"
    (error,) = events(session, "api_error")
    assert error["data"]["error_class"] == "BadRequestError" and error["data"]["status_code"] == 400


async def test_retryable_api_errors_are_retried(tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.0)
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(rate_limited(), anthropic.APIConnectionError(request=REQUEST), submit())

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
    outage = [anthropic.APIConnectionError(request=REQUEST)] * 9
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


def in_stream_error(kind: str) -> anthropic.APIStatusError:
    """What the SDK raises for `event: error` inside an open 200 stream."""
    body = {"type": "error", "error": {"type": kind, "message": kind}}
    return anthropic.APIStatusError(str(body), response=httpx2.Response(200, request=REQUEST), body=body)


def status_error(code: int, cls: type[anthropic.APIStatusError] = anthropic.APIStatusError) -> anthropic.APIStatusError:
    return cls("error", response=httpx2.Response(code, request=REQUEST), body=None)


def test_retry_classification() -> None:
    retryable = loop_module._retryable
    assert retryable(in_stream_error("overloaded_error"))
    assert retryable(in_stream_error("api_error"))
    assert retryable(in_stream_error("rate_limit_error"))
    assert not retryable(in_stream_error("invalid_request_error"))
    assert not retryable(in_stream_error("authentication_error"))
    assert retryable(status_error(529)) and retryable(status_error(500, anthropic.InternalServerError))
    assert retryable(status_error(408)) and retryable(rate_limited())
    assert retryable(anthropic.APITimeoutError(request=REQUEST))
    assert retryable(httpx2.ReadError("reset"))
    for code, cls in ((400, anthropic.BadRequestError), (401, anthropic.AuthenticationError), (413, anthropic.APIStatusError)):
        assert not retryable(status_error(code, cls))
    assert not retryable(anthropic.AnthropicError("no credentials"))
    assert not retryable(RuntimeError("boom"))


async def test_in_stream_overloaded_error_is_retried(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.0)
    session, pano = make_session(tmp_path, pano_path)
    client = FakeClient(in_stream_error("overloaded_error"), submit())

    await run_agent(session, pano, client, budget=budget())

    assert len(client.calls) == 2
    (retry,) = events(session, "api_retry")
    assert retry["data"]["status_code"] == 200 and retry["data"]["error_type"] == "overloaded_error"
    assert run_end(session)["stop_reason"] == "submitted"


def test_retry_delay_backs_off_with_a_cap_and_honours_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(loop_module, "RETRY_JITTER", 0.0)
    delay = loop_module._retry_delay
    error = anthropic.APIConnectionError(request=REQUEST)
    assert [delay(error, n) for n in range(5)] == [2.0, 4.0, 8.0, 16.0, 20.0]
    assert delay(error, 500) == loop_module.RETRY_MAX_DELAY_S

    def limited(retry_after: str) -> anthropic.RateLimitError:
        response = httpx2.Response(429, request=REQUEST, headers={"retry-after": retry_after})
        return anthropic.RateLimitError("rate limited", response=response, body=None)

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
    client = FakeClient(update(HYP, id_="toolu_a"))

    await run_agent(session, pano, client, budget=budget(max_spend_usd=0.01))

    assert len(client.calls) == 2  # 0.008 USD per call
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
        tool_use("view_crop", {"yaw": 90, "pitch": 0, "fov": 60, "enhance": False}, "toolu_v"),
        tool_use("update_candidates", {"hypotheses": [HYP]}, "toolu_u"),
        tool_use("no_such_tool", {}, "toolu_x"),
    )
    client = FakeClient(turn, submit())

    await run_agent(session, pano, client, budget=budget())

    results = tool_results(client.calls[1]["messages"][-1])
    assert [r["tool_use_id"] for r in results] == ["toolu_v", "toolu_u", "toolu_x"]
    assert [r.get("is_error", False) for r in results] == [False, False, True]
    assert any(b["type"] == "image" for b in results[0]["content"])
    logged = events(session, "model_request")[1]["data"]["messages"][0]["content"]
    (crop,) = [b for b in logged[0]["content"] if b["type"] == "image"]
    assert Path(crop["path"]).is_file() and "source" not in crop


async def test_max_tokens_does_not_execute_truncated_tool_calls(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    truncated = message("max_tokens", tool_use("submit_locations", {"hypotheses": [OTHER]}, "toolu_t"))
    client = FakeClient(truncated, submit(HYP))

    await run_agent(session, pano, client, budget=budget())

    (result,) = tool_results(client.calls[1]["messages"][-1])
    assert result["tool_use_id"] == "toolu_t" and result["is_error"] is True
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
        "input_tokens": 1_000_000,
        "output_tokens": 1_000_000,
        "cache_creation_input_tokens": 1_000_000,
        "cache_read_input_tokens": 1_000_000,
        "server_tool_use": {"web_search_requests": 100},
    }
    assert estimate_cost(usage, Pricing()) == pytest.approx(4 + 20 + 5 + 0.2 + 1.0)
    assert estimate_cost(SimpleNamespace(input_tokens=500, output_tokens=None), Pricing()) == pytest.approx(0.002)
    assert usage_dict(None)["input_tokens"] == 0


class _FakeStream:
    def __init__(self, outcome: Any) -> None:
        self.outcome = outcome

    async def __aenter__(self) -> "_FakeStream":
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def get_final_message(self) -> Any:
        return self.outcome


class _FakeSdk:
    def __init__(self, *outcomes: Any) -> None:
        self.outcomes = list(outcomes)
        self.requests: list[dict[str, Any]] = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **params: Any) -> _FakeStream:
        self.requests.append(params)
        return _FakeStream(self.outcomes.pop(0))


async def test_anthropic_client_streams_and_drops_unsupported_fallbacks() -> None:
    rejected = anthropic.BadRequestError(
        "fallbacks: Extra inputs are not permitted", response=httpx2.Response(400, request=REQUEST), body=None
    )
    sdk = _FakeSdk(rejected, "first", "second")
    client = AnthropicModelClient(sdk)  # type: ignore[arg-type]
    params = {"model": "claude-opus-5-5", "messages": [], "betas": [FALLBACK_BETA], "fallbacks": "default"}

    assert await client.create(**params) == "first"
    assert await client.create(**params) == "second"

    assert "fallbacks" in sdk.requests[0]
    assert all("fallbacks" not in r and "betas" not in r for r in sdk.requests[1:])


async def test_anthropic_client_reraises_other_bad_requests() -> None:
    other = anthropic.BadRequestError("max_tokens too large", response=httpx2.Response(400, request=REQUEST), body=None)
    client = AnthropicModelClient(_FakeSdk(other))  # type: ignore[arg-type]

    with pytest.raises(anthropic.BadRequestError):
        await client.create(model="claude-opus-5-5", messages=[], betas=[FALLBACK_BETA], fallbacks="default")


async def test_missing_api_key_is_a_clear_api_error_with_a_fallback_answer(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    session, pano = make_session(tmp_path, pano_path)
    # The SDK rejects the request for lack of credentials before it opens a connection.
    client = AnthropicModelClient(anthropic.AsyncAnthropic(max_retries=0, base_url="http://127.0.0.1:9"))
    await run_agent(session, pano, client, budget=budget())
    assert run_end(session)["stop_reason"] == "api_error"
    (error,) = events(session, "api_error")
    assert "ANTHROPIC_API_KEY" in error["data"]["message"]
    assert not events(session, "harness_error")
    assert session.final is not None and len(session.final) == 10
    assert {e.origin for e in session.final} == {"harness_fallback"}


async def test_images_stop_at_the_request_budget(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loop_module, "MAX_REQUEST_IMAGES", 12)  # 11 initial views + one crop
    session, pano = make_session(tmp_path, pano_path)
    crop = {"yaw": 10.0, "pitch": 0.0, "fov": 60.0, "enhance": False}
    client = FakeClient(
        message("tool_use", tool_use("view_crop", crop, "toolu_c1"), tool_use("view_crop", crop, "toolu_c2")),
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


def _sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


MESSAGE_START = _sse(
    "message_start",
    {
        "type": "message_start",
        "message": {
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": [],
            "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 3, "output_tokens": 1},
        },
    },
)  # fmt: skip
COMPLETE_STREAM = [
    MESSAGE_START,
    _sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    _sse("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}}),
    _sse("content_block_stop", {"type": "content_block_stop", "index": 0}),
    _sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 2}}),
    _sse("message_stop", {"type": "message_stop"}),
]  # fmt: skip
BAD_TOOL_JSON = [
    MESSAGE_START,
    _sse(
        "content_block_start",
        {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "view_crop", "input": {}}},
    ),
    _sse("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": '{"yaw": }'}}),
]  # fmt: skip
OVERLOADED = [MESSAGE_START, _sse("error", {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})]


class _Body(httpx2.AsyncByteStream):
    def __init__(self, chunks: list[bytes], error: Exception | None = None) -> None:
        self.chunks, self.error = chunks, error

    async def __aiter__(self) -> Any:
        for chunk in self.chunks:
            yield chunk
        if self.error is not None:
            raise self.error


def sdk_client(*bodies: _Body) -> tuple[AnthropicModelClient, list[httpx2.Request]]:
    """An AnthropicModelClient on the real SDK whose HTTP layer plays the given SSE bodies."""
    pending, seen = list(bodies), []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, stream=pending.pop(0))

    sdk = anthropic.AsyncAnthropic(
        api_key="test-key", max_retries=0, http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    )
    return AnthropicModelClient(sdk), seen


SDK_PARAMS: dict[str, Any] = {"model": "claude-opus-5-5", "max_tokens": 64, "messages": [{"role": "user", "content": "hi"}]}


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (httpx2.ReadError("connection reset by peer"), anthropic.APIConnectionError),
        (httpx2.RemoteProtocolError("incomplete chunked read"), anthropic.APIConnectionError),
        (httpx2.ReadTimeout("no bytes for 120 s"), anthropic.APITimeoutError),
    ],
)
async def test_mid_stream_transport_error_becomes_a_retryable_sdk_error(
    error: Exception, expected: type[Exception]
) -> None:
    """The SDK wraps transport errors only while sending; a body that dies after message_start
    raises raw httpx2 errors, which the client must turn into the SDK's retryable types."""
    client, seen = sdk_client(_Body([MESSAGE_START], error))

    with pytest.raises(expected) as caught:
        await client.create(**SDK_PARAMS)

    assert isinstance(caught.value, anthropic.APIConnectionError)
    assert loop_module._retryable(caught.value)
    assert caught.value.__cause__ is error
    assert len(seen) == 1


async def test_in_stream_error_event_from_the_sdk_is_retryable() -> None:
    client, _ = sdk_client(_Body(OVERLOADED))

    with pytest.raises(anthropic.APIStatusError) as caught:
        await client.create(**SDK_PARAMS)

    assert caught.value.status_code == 200  # the already-open response, not a 529
    assert loop_module._error_type(caught.value) == "overloaded_error"
    assert loop_module._retryable(caught.value)


async def test_unparseable_tool_json_in_the_stream_is_retryable() -> None:
    client, _ = sdk_client(_Body(BAD_TOOL_JSON))

    with pytest.raises(anthropic.APIConnectionError) as caught:
        await client.create(**SDK_PARAMS)

    assert isinstance(caught.value.__cause__, ValueError)
    assert loop_module._retryable(caught.value)


async def test_corrupted_event_payload_in_the_stream_is_retryable() -> None:
    garbled = b"event: content_block_start\ndata: {\"type\": \"content_block_start\", \"index\": 0, \"content_bl\n\n"
    client, _ = sdk_client(_Body([MESSAGE_START, garbled]))

    with pytest.raises(anthropic.APIConnectionError) as caught:
        await client.create(**SDK_PARAMS)

    assert isinstance(caught.value.__cause__, json.JSONDecodeError)


async def test_other_value_errors_are_not_disguised_as_connection_errors() -> None:
    client = AnthropicModelClient(_FakeSdk(ValueError("max_tokens must be positive")))  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="max_tokens"):
        await client.create(model="claude-opus-5-5", messages=[])


async def test_run_survives_a_dropped_stream_on_the_real_sdk(
    tmp_path: Path, pano_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End to end: connection reset mid-response, then an overload event, then a good response."""
    monkeypatch.setattr(loop_module, "RETRY_BASE_DELAY_S", 0.0)
    session, pano = make_session(tmp_path, pano_path)
    client, seen = sdk_client(
        _Body([MESSAGE_START], httpx2.ReadError("reset")), _Body(OVERLOADED), _Body(COMPLETE_STREAM), _Body(COMPLETE_STREAM)
    )

    await run_agent(session, pano, client, budget=budget())

    assert len(seen) == 4  # two failed attempts, the answer, then the nudge turn
    assert [e["data"]["error_class"] for e in events(session, "api_retry")] == ["APIConnectionError", "APIStatusError"]
    assert not events(session, "harness_error") and not events(session, "api_error")
    assert run_end(session)["stop_reason"] == "end_turn"
    sent = json.loads(seen[0].content)
    assert sent["stream"] is True and sent["max_tokens"] == 64_000


def test_default_client_detects_a_stalled_stream_quickly() -> None:
    timeout = AnthropicModelClient()._client.timeout
    assert timeout.read == loop_module.API_READ_TIMEOUT_S == 120.0
    assert timeout.connect == 10.0 and timeout.write == 600.0
    assert AnthropicModelClient(read_timeout_s=90.0)._client.timeout.read == 90.0
    assert Settings().api_read_timeout_s == 120.0 and Settings().max_tokens == 64_000


# --- max_tokens, same-turn question + submit, status line ------------------------------------------


async def test_max_tokens_keeps_the_tool_calls_completed_before_the_cut(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    truncated = message(
        "max_tokens",
        tool_use("update_candidates", {"hypotheses": [OTHER]}, "toolu_done"),
        tool_use("view_crop", {"yaw": 10}, "toolu_cut"),
    )
    client = FakeClient(truncated, message("end_turn", text("done")))

    await run_agent(session, pano, client, budget=budget())

    done, cut = tool_results(client.calls[1]["messages"][-1])
    assert done["tool_use_id"] == "toolu_done" and "is_error" not in done
    assert cut["tool_use_id"] == "toolu_cut" and cut["is_error"] is True
    assert cut["content"] == loop_module.TRUNCATED_TOOL_NOTICE
    assert [e["data"]["tool"] for e in events(session, "tool_call")] == ["update_candidates"]
    assert_final(session, OTHER["lat"], OTHER["lng"], "agent")  # the complete update was recorded


async def test_max_tokens_with_trailing_text_runs_every_tool_call(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path)
    truncated = message("max_tokens", tool_use("update_candidates", {"hypotheses": [OTHER]}, "toolu_a"), text("and then"))
    client = FakeClient(truncated, message("end_turn", text("done")))

    await run_agent(session, pano, client, budget=budget())

    (result,) = tool_results(client.calls[1]["messages"][-1])
    assert "is_error" not in result
    assert_final(session, OTHER["lat"], OTHER["lng"], "agent")


async def test_question_in_the_same_turn_as_submit_is_never_charged(tmp_path: Path, pano_path: Path) -> None:
    session, pano = make_session(tmp_path, pano_path, no_human=False)
    question = {"question": "Which square?", "options": ["A", "B"], "why_it_matters": "splits the top two"}
    turn = message(
        "tool_use",
        tool_use("ask_multiple_choice", question, "toolu_q"),
        tool_use("submit_locations", {"hypotheses": [HYP], "reasoning_summary": "x"}, "toolu_s"),
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
    client = FakeClient(update(HYP), message("tool_use", tool_use("ask_multiple_choice", question, "toolu_q")), submit())

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
    assert "ten minutes" not in client.calls[0]["system"][0]["text"]
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
    client = FakeClient(update(HYP), message("tool_use", tool_use("ask_multiple_choice", question, "toolu_q")), submit())

    # 100 s left is less than the 90 s answer window plus a turn to act on the click.
    await run_agent(session, pano, client, budget=budget(hard_deadline_s=100.0))

    assert session.ledger.mcqs == 0 and not events(session, "mcq_asked")
    (refused,) = [e for e in events(session, "tool_result") if e["data"]["tool"] == "ask_multiple_choice"]
    assert refused["data"]["is_error"] is True and "no penalty" in refused["data"]["output"]
    assert {e.multiplier for e in session.final or []} == {1.0}
