"""Hand-written async Messages API loop (SPEC 6.1, 6.5).

Not the Agent SDK: we need every request and response in the event log, pre-emption of an
in-flight call at the hard deadline, and the ability to wait on an operator's MCQ click.

Invariants this module must keep for claude-opus-5-5:
- the system prompt, tool list and request settings are built once and never change;
- conversation history is append-only and assistant content is echoed back unchanged
  (thinking blocks are bound to the exact prefix that produced them);
- tool choice cannot be forced, so nothing depends on submit_locations being called:
  whatever happens, run_agent ends with session.finalize().
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import random
import subprocess
import time
import traceback
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Protocol

import anthropic
import httpx
import httpx2  # the transport under anthropic 1.x; `httpx` above is what our own tools use

from . import prompts
from .config import Budget, Pricing, Settings
from .pano import Panorama, View
from .session import PanoramaSession
from .tools.base import ToolContext, ToolResult
from .tools.registry import execute_tool, refuse_tool
from .tools.schemas import tool_definitions

# `fallbacks: "default"` re-runs a classifier-declined request on Anthropic's recommended
# substitute model inside the same call; this header gates the scalar form.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

# Transient API failures are retried until the hard deadline pre-empts the run: giving up early
# only swaps a possible recovery for the same best-so-far answer the deadline would submit.
RETRY_BASE_DELAY_S = 2.0
RETRY_MAX_DELAY_S = 20.0
RETRY_JITTER = 0.25  # six panoramas share one API key; do not retry in lockstep
# Error types that are transient whatever HTTP status carries them. An `event: error` inside an
# already-open stream surfaces as an APIStatusError whose status_code is the stream's 200.
RETRYABLE_ERROR_TYPES = frozenset({"overloaded_error", "api_error", "rate_limit_error", "timeout_error"})
TERMINAL_ERROR_TYPES = frozenset(
    {
        "invalid_request_error",
        "authentication_error",
        "permission_error",
        "not_found_error",
        "request_too_large",
        "billing_error",
    }
)
RETRYABLE_STATUS_CODES = frozenset({408, 409, 429})
# Per-chunk read timeout. The SDK default of 600 s lets a half-open connection eat most of a
# panorama's deadline; a healthy stream sends deltas or pings far more often than this.
API_READ_TIMEOUT_S = 120.0
API_CONNECT_TIMEOUT_S = 10.0
_PLACEHOLDER_REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
_TOOL_JSON_ERROR = "Unable to parse tool parameter JSON"

# A request body over 32 MB is rejected outright and would end the run, so images stop well short
# of it (base64 characters, which is what travels). The count is the documented per-request floor.
MAX_REQUEST_IMAGES = 100
MAX_IMAGE_PAYLOAD_CHARS = 24_000_000
IMAGE_BUDGET_NOTICE = (
    "[Image omitted by the harness: this conversation has reached its image budget, so no further "
    "images can be returned. Work from what you have already seen and from text tools, then call "
    "submit_locations.]"
)

TRUNCATED_TOOL_NOTICE = (
    "Not executed: your previous output hit the output-token limit, so this tool call may be "
    "incomplete. Re-issue it, keeping any accompanying text short."
)
MCQ_WITH_SUBMIT_NOTICE = (
    "Question not asked and no penalty applied: do not combine ask_multiple_choice with "
    "submit_locations in one turn, because the answer could not change a list that is already "
    "final. Ask first and submit after the answer, or just submit."
)

# Opaque blobs that would bloat the log without telling a reader anything.
_OPAQUE_KEYS = frozenset({"signature", "encrypted_content", "encrypted_index", "data"})
_OPAQUE_MIN_CHARS = 256
_IMAGE_SUFFIX = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}


class ModelClient(Protocol):
    async def create(self, **params: Any) -> Any:
        """Send one Messages API request and return the final message."""


class AnthropicModelClient:
    """Streams every request (long thinking turns would otherwise hit HTTP timeouts) and returns
    the accumulated final message."""

    def __init__(
        self, client: anthropic.AsyncAnthropic | None = None, *, read_timeout_s: float = API_READ_TIMEOUT_S
    ) -> None:
        # The loop does its own deadline-aware retries; keep the SDK's short.
        self._client = client or anthropic.AsyncAnthropic(
            max_retries=1,
            timeout=anthropic.Timeout(600.0, connect=API_CONNECT_TIMEOUT_S, read=read_timeout_s),
        )
        self._fallbacks_supported = True

    async def create(self, **params: Any) -> Any:
        if not self._fallbacks_supported:
            params = _without_fallbacks(params)
        try:
            return await self._stream(params)
        except anthropic.BadRequestError as exc:
            # Server-side fallbacks are a beta that not every platform or account accepts. Losing
            # the opt-in costs little; a 400 on every request would cost the whole run.
            if "fallbacks" not in params or "fallback" not in str(exc).lower():
                raise
            self._fallbacks_supported = False
            return await self._stream(_without_fallbacks(params))

    async def _stream(self, params: dict[str, Any]) -> Any:
        try:
            async with self._client.beta.messages.stream(**params) as stream:
                return await stream.get_final_message()
        except TypeError as exc:
            # The SDK reports missing credentials as a bare TypeError; surface it as an API
            # failure so the log says "no key" instead of recording a harness crash.
            if "authentication method" not in str(exc):
                raise
            raise anthropic.AnthropicError(
                "No Anthropic credentials: set ANTHROPIC_API_KEY (environment or .env) before running."
            ) from exc
        except httpx2.TimeoutException as exc:
            # The SDK wraps transport errors only while sending. Once the 200 stream is open, a
            # stall or a dropped connection surfaces raw; give it the SDK's own retryable types.
            raise anthropic.APITimeoutError(request=_request_of(exc)) from exc
        except httpx2.TransportError as exc:
            raise anthropic.APIConnectionError(
                message=f"Connection lost mid-stream ({type(exc).__name__}: {exc})", request=_request_of(exc)
            ) from exc
        except ValueError as exc:
            # The stream accumulator raises a bare ValueError when a tool call's input is not
            # valid JSON, and a corrupted event payload fails to decode. Either way the response
            # is unusable and re-issuing the turn is the remedy (the SDK's own advice for the
            # first). Any other ValueError is a programming error and must stay visible.
            if _TOOL_JSON_ERROR not in str(exc) and not isinstance(exc, json.JSONDecodeError):
                raise
            raise anthropic.APIConnectionError(
                message=f"Unusable streamed response ({str(exc)[:300]})", request=_PLACEHOLDER_REQUEST
            ) from exc

    async def aclose(self) -> None:
        await self._client.close()


def _request_of(exc: httpx2.TransportError) -> httpx2.Request:
    try:
        return exc.request
    except RuntimeError:  # ".request property has not been set"
        return _PLACEHOLDER_REQUEST


def _without_fallbacks(params: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in params.items() if k != "fallbacks"}
    betas = [b for b in out.pop("betas", []) if b != FALLBACK_BETA]
    if betas:
        out["betas"] = betas
    return out


def _field(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def usage_dict(usage: Any) -> dict[str, int]:
    """Flatten an SDK usage object (or dict) to the integer counters we price and log."""
    server = _field(usage, "server_tool_use")
    return {
        "input_tokens": int(_field(usage, "input_tokens") or 0),
        "output_tokens": int(_field(usage, "output_tokens") or 0),
        "cache_creation_input_tokens": int(_field(usage, "cache_creation_input_tokens") or 0),
        "cache_read_input_tokens": int(_field(usage, "cache_read_input_tokens") or 0),
        "web_search_requests": int(_field(server, "web_search_requests") or 0),
        "web_fetch_requests": int(_field(server, "web_fetch_requests") or 0),
    }


def estimate_cost(usage: Any, pricing: Pricing) -> float:
    """USD for one response. An estimate: a turn served by a fallback model bills at that
    model's rates, which we do not track."""
    u = usage_dict(usage)
    tokens = (
        u["input_tokens"] * pricing.input
        + u["output_tokens"] * pricing.output
        + u["cache_creation_input_tokens"] * pricing.cache_write
        + u["cache_read_input_tokens"] * pricing.cache_read
    )
    return tokens / 1_000_000 + u["web_search_requests"] * pricing.web_search_per_1k / 1000


def build_request_params(settings: Settings, budget: Budget) -> dict[str, Any]:
    """Everything except `messages`. Built once per run: any change here between turns would
    invalidate the prompt cache and the thinking blocks already in the history."""
    return {
        "model": settings.model,
        "max_tokens": settings.max_tokens,
        # Tools render before system, so this one breakpoint caches both.
        "system": [
            {
                "type": "text",
                "text": prompts.build_system_prompt(settings),
                "cache_control": {"type": "ephemeral"},
            }
        ],
        "tools": tool_definitions(settings),
        "thinking": {"type": "adaptive", "display": "summarized"},
        "output_config": {"effort": budget.effort},
        # Automatic breakpoint on the growing conversation tail (images are the bulk of the cost).
        "cache_control": {"type": "ephemeral"},
        "betas": [FALLBACK_BETA],
        "fallbacks": "default",
    }


@lru_cache(maxsize=1)
def git_sha() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parent,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


def _jsonable(obj: Any) -> Any:
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if hasattr(obj, "model_dump"):
        return _jsonable(obj.model_dump(mode="json", exclude_none=True))
    if isinstance(obj, SimpleNamespace):
        return _jsonable(vars(obj))
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    return str(obj)


class _ImageRefs:
    """Maps base64 image blocks to log references {sha256, path, yaw, pitch, fov}, saving any
    image that is not on disk yet so every reference in the log can be resolved later."""

    def __init__(self, image_dir: Path) -> None:
        self._dir = image_dir
        self._known: dict[str, dict[str, Any]] = {}

    def register(self, view: View) -> None:
        self._known[hashlib.sha256(view.jpeg).hexdigest()] = _jsonable(view.ref())

    def ref(self, source: dict[str, Any]) -> dict[str, Any]:
        raw = base64.b64decode(source.get("data", ""))
        sha = hashlib.sha256(raw).hexdigest()
        if sha not in self._known:
            path = self._dir / f"{sha}{_IMAGE_SUFFIX.get(source.get('media_type', ''), '.jpg')}"
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
            self._known[sha] = {"sha256": sha, "path": str(path), "yaw": None, "pitch": None, "fov": None}
        return self._known[sha]

    def for_log(self, value: Any) -> Any:
        """JSON-safe copy of message content with images as references and opaque blobs elided."""
        return self._scrub(_jsonable(value))

    def _scrub(self, value: Any) -> Any:
        if isinstance(value, list):
            return [self._scrub(v) for v in value]
        if not isinstance(value, dict):
            return value
        source = value.get("source")
        if value.get("type") == "image" and isinstance(source, dict) and source.get("type") == "base64":
            return {"type": "image", **self.ref(source)}
        return {k: self._elide(k, v) for k, v in value.items()}

    def _elide(self, key: str, value: Any) -> Any:
        if key in _OPAQUE_KEYS and isinstance(value, str) and len(value) >= _OPAQUE_MIN_CHARS:
            return f"<{len(value)} chars omitted>"
        return self._scrub(value)


def _text(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def _echoable(content: list[Any]) -> list[Any]:
    """Assistant content as it may be sent back.

    Normally that is the content unchanged. After a mid-output server-side fallback the blocks
    before the last `fallback` marker came from the model that declined: its thinking, client
    tool calls and unanswered server tool calls must be left out, or the next request is a 400.
    """
    boundary = max((i for i, b in enumerate(content) if _field(b, "type") == "fallback"), default=-1)
    if boundary < 0:
        return content
    head = content[:boundary]
    answered = {_field(b, "tool_use_id") for b in head if str(_field(b, "type")).endswith("_tool_result")}

    def survives(block: Any) -> bool:
        kind = str(_field(block, "type"))
        if kind == "server_tool_use":
            return _field(block, "id") in answered
        return kind == "text" or kind.endswith("_tool_result")

    return [b for b in head if survives(b)] + content[boundary:]


def _error_type(exc: BaseException) -> str | None:
    kind = getattr(exc, "type", None)
    if isinstance(kind, str):
        return kind
    body = getattr(exc, "body", None)
    error = body.get("error") if isinstance(body, dict) else None
    kind = error.get("type") if isinstance(error, dict) else None
    return kind if isinstance(kind, str) else None


def _retryable(exc: BaseException) -> bool:
    """Transient failures worth re-issuing the turn for. 400/401/403/404/413 stay terminal."""
    if isinstance(exc, (anthropic.APIConnectionError, anthropic.RateLimitError, httpx2.TransportError)):
        return True
    if not isinstance(exc, anthropic.APIStatusError):
        return False
    kind = _error_type(exc)
    if kind in RETRYABLE_ERROR_TYPES:
        return True
    status = exc.status_code
    if status >= 500 or status in RETRYABLE_STATUS_CODES:
        return True
    # Below 400 the error arrived inside an open stream: transient unless it names a request fault.
    return status < 400 and kind not in TERMINAL_ERROR_TYPES


def _retry_delay(exc: BaseException, attempt: int, remaining_s: float | None = None) -> float:
    """Capped exponential backoff with jitter. A server-requested `retry-after` is honoured in
    full when it fits in the time left; retrying sooner than asked only burns attempts."""
    delay = min(RETRY_BASE_DELAY_S * 2 ** min(attempt, 16), RETRY_MAX_DELAY_S)
    delay *= 1.0 + random.uniform(0.0, RETRY_JITTER)
    response = getattr(exc, "response", None)
    try:
        retry_after = float(response.headers.get("retry-after", 0))
    except (AttributeError, TypeError, ValueError):
        retry_after = 0.0
    if retry_after > delay and (remaining_s is None or retry_after < remaining_s):
        delay = retry_after
    return delay


def _api_error_data(exc: BaseException) -> dict[str, Any]:
    return {
        "error_class": type(exc).__name__,
        "status_code": getattr(exc, "status_code", None),
        "error_type": _error_type(exc),
        "request_id": getattr(exc, "request_id", None),
        "message": str(exc),
    }


class _AgentRun:
    def __init__(
        self,
        session: PanoramaSession,
        pano: Panorama,
        client: ModelClient,
        budget: Budget,
        http: httpx.AsyncClient | None,
    ) -> None:
        self.session = session
        self.pano = pano
        self.client = client
        self.budget = budget
        self.ctx = ToolContext(session=session, pano=pano, settings=session.settings, http=http)
        self.params = build_request_params(session.settings, budget)
        self.images = _ImageRefs(session.image_dir)
        self.messages: list[dict[str, Any]] = []
        self.logged = 0  # messages[:logged] have already appeared in a model_request event
        self.turns = 0
        self.spend = 0.0
        self.tokens: dict[str, int] = {}
        self.commit_notice_sent = False
        self.image_count = 0
        self.image_chars = 0

    def emit(self, actor: str, type_: str, data: dict[str, Any]) -> None:
        self.session.log.emit(actor, type_, data)  # type: ignore[arg-type]

    async def run(self) -> str:
        self.session.status = "running"
        # The session refuses penalised interactions that could no longer pay off before this.
        self.session.deadline_monotonic = self.session.started_monotonic + self.budget.hard_deadline_s
        self._emit_run_start()
        remaining = self.budget.hard_deadline_s - self.session.elapsed_s()
        # One timeout around the whole conversation pre-empts whatever is in flight at the hard
        # deadline: a model call, a slow tool, or the wait for an MCQ click.
        deadline = asyncio.timeout(max(remaining, 0.0))
        try:
            async with deadline:
                return await self._converse()
        except TimeoutError:
            if not deadline.expired():
                raise
            return "hard_deadline"

    def _emit_run_start(self) -> None:
        task, settings = self.session.task, self.session.settings
        request = {k: v for k, v in self.params.items() if k not in {"system", "tools"}}
        self.emit(
            "harness",
            "run_start",
            {
                "panorama": {
                    "panorama_id": task.panorama_id,
                    "filename": task.path.name,
                    "path": str(task.path),
                    "sha256": self.pano.sha256,
                    "width": self.pano.width,
                    "height": self.pano.height,
                },
                "label": task.label.value,
                "capture_timestamp": task.timestamp,
                "special": task.special,
                "model": settings.model,
                "effort": self.budget.effort,
                "budget": self.budget.model_dump(),
                "request": request,
                "system_prompt": self.params["system"][0]["text"],
                "tools": self.params["tools"],
                "git_sha": git_sha(),
                "flags": {
                    "allow_web": settings.allow_web,
                    "no_human": settings.no_human,
                    "hedge": settings.hedge,
                    "allow_duplicates": settings.allow_duplicates,
                    "penalty_scope": settings.penalty_scope,
                    "max_mcq": settings.max_mcq,
                },
            },
        )

    async def _converse(self) -> str:
        views = await asyncio.to_thread(self.pano.initial_views)  # cv2 remaps; keep the event loop free
        for view in views:
            self.images.register(view)
        session = self.session
        mcq_available = session.mcq_allowed and not session.settings.no_human
        first = prompts.initial_user_content(
            session.task,
            views,
            mcq_available=mcq_available,
            budget=self.budget,
            max_images=MAX_REQUEST_IMAGES,
        )
        for block in first:
            self._admit_image(block)
        self.messages.append({"role": "user", "content": first})
        nudged = False
        for turn in range(1, self.budget.max_turns + 1):
            if self.session.final is not None:
                return "finalized_externally"
            try:
                response = await self._model_turn()
            except (anthropic.AnthropicError, httpx2.TransportError) as exc:
                self.emit("harness", "api_error", _api_error_data(exc))
                return "finalized_externally" if self.session.final is not None else "api_error"
            stop = _field(response, "stop_reason")
            content = _echoable(list(_field(response, "content") or []))
            if stop == "refusal":
                # A refusal can cut a tool_use off mid-input: never execute that turn's tools.
                return "refusal"
            if content:
                self.messages.append({"role": "assistant", "content": content})
            tool_uses = [b for b in content if _field(b, "type") == "tool_use"]
            reply: list[dict[str, Any]] | None
            if stop == "pause_turn":
                reply = None  # the server resumes from the trailing server_tool_use block
            elif stop == "max_tokens":
                reply = await self._truncated_reply(content, tool_uses)
            elif tool_uses:
                reply = await self._run_tools(tool_uses)
            elif nudged:
                return "end_turn"
            else:
                nudged = True
                reply = [_text(prompts.NO_SUBMISSION_NUDGE)]
            if self.session.final is not None:
                submitted = any(_field(b, "name") == "submit_locations" for b in tool_uses)
                return "submitted" if submitted else "finalized_externally"
            if self.spend >= self.budget.max_spend_usd:
                return "max_spend"
            if reply is not None:
                last_turn_next = turn == self.budget.max_turns - 1
                self.messages.append({"role": "user", "content": reply + self._notices(last_turn_next)})
        return "max_turns"

    async def _model_turn(self) -> Any:
        self.turns += 1
        appended = [m for m in self.messages[self.logged :] if m["role"] == "user"]
        self.logged = len(self.messages)
        self.emit(
            "harness",
            "model_request",
            {
                "turn": self.turns,
                "message_count": len(self.messages),
                # What is re-uploaded on every request: the bulk of the body is base64 images.
                "image_count": self.image_count,
                "image_payload_chars": self.image_chars,
                "messages": [{"role": m["role"], "content": self.images.for_log(m["content"])} for m in appended],
            },
        )
        started = time.monotonic()
        response = await self._create()
        latency_ms = round((time.monotonic() - started) * 1000)
        usage = usage_dict(_field(response, "usage"))
        cost = estimate_cost(usage, self.session.settings.pricing)
        self.spend += cost
        for key, value in usage.items():
            self.tokens[key] = self.tokens.get(key, 0) + value
        self.session.record_usage(usage, cost)
        self.emit(
            "agent",
            "model_response",
            {
                "turn": self.turns,
                "id": _field(response, "id"),
                "model": _field(response, "model"),
                "stop_reason": _field(response, "stop_reason"),
                "stop_details": _jsonable(_field(response, "stop_details")),
                "content": self.images.for_log(_field(response, "content") or []),
                "usage": usage,
                "cost_usd": round(cost, 6),
                "latency_ms": latency_ms,
            },
        )
        return response

    async def _create(self) -> Any:
        """One model call, re-issued on transient failures until it succeeds. The hard-deadline
        timeout around the conversation is what bounds this loop. Re-sending is safe: nothing is
        appended to self.messages until a response has come back whole."""
        attempt = 0
        while True:
            try:
                return await self.client.create(**self.params, messages=self.messages)
            except (anthropic.APIError, httpx2.TransportError) as exc:
                if not _retryable(exc) or self.session.final is not None:
                    raise
                remaining = self.budget.hard_deadline_s - self.session.elapsed_s()
                delay = _retry_delay(exc, attempt, remaining)
                attempt += 1
                self.emit(
                    "harness",
                    "api_retry",
                    {
                        **_api_error_data(exc),
                        "attempt": attempt,
                        "delay_s": round(delay, 3),
                        "remaining_s": round(remaining, 1),
                    },
                )
                await asyncio.sleep(delay)

    async def _run_tools(self, tool_uses: list[Any]) -> list[dict[str, Any]]:
        """Run every client tool call of the turn concurrently; all results go in one user message."""
        # A question asked in the turn that submits is charged x0.95 and then closed unanswered by
        # the submission itself, so it is never put to the operator.
        submitting = any(_field(b, "name") == "submit_locations" for b in tool_uses)

        async def one(block: Any) -> ToolResult:
            name, args, tool_use_id = _field(block, "name"), _field(block, "input"), _field(block, "id")
            if submitting and name == "ask_multiple_choice":
                return refuse_tool(self.ctx, name, args, MCQ_WITH_SUBMIT_NOTICE, tool_use_id=tool_use_id)
            return await execute_tool(self.ctx, name, args, tool_use_id=tool_use_id)

        results = await asyncio.gather(*(one(b) for b in tool_uses), return_exceptions=True)
        return [self._tool_result(block, result) for block, result in zip(tool_uses, results)]

    def _admit_image(self, block: dict[str, Any]) -> bool:
        """Count an image block against the conversation's budget; False once the budget is spent."""
        if block.get("type") != "image":
            return True
        size = len(str((block.get("source") or {}).get("data", "")))
        if self.image_count >= MAX_REQUEST_IMAGES or self.image_chars + size > MAX_IMAGE_PAYLOAD_CHARS:
            return False
        self.image_count += 1
        self.image_chars += size
        return True

    def _tool_result(self, block: Any, result: ToolResult | BaseException) -> dict[str, Any]:
        # A tool_use without a matching tool_result is a 400 that would end the conversation.
        if isinstance(result, BaseException):
            result = ToolResult.error(f"Tool failed: {type(result).__name__}: {result}")
        content = [b if self._admit_image(b) else _text(IMAGE_BUDGET_NOTICE) for b in result.content]
        out: dict[str, Any] = {
            "type": "tool_result",
            "tool_use_id": _field(block, "id"),
            "content": content or [_text("(no output)")],
        }
        if result.is_error:
            out["is_error"] = True
        return out

    async def _truncated_reply(self, content: list[Any], tool_uses: list[Any]) -> list[dict[str, Any]]:
        """Reply to a turn cut off at max_tokens. Only the block being written when the limit hit
        can be incomplete, so earlier tool calls (an update_candidates, say) still run."""
        if not tool_uses:
            return [_text(prompts.MAX_TOKENS_NOTICE)]
        cut = tool_uses[-1] if _field(content[-1], "type") == "tool_use" else None
        complete = [b for b in tool_uses if b is not cut]
        reply = await self._run_tools(complete) if complete else []
        if cut is not None:
            reply.append(
                {
                    "type": "tool_result",
                    "tool_use_id": _field(cut, "id"),
                    "content": TRUNCATED_TOOL_NOTICE,
                    "is_error": True,
                }
            )
        return reply

    def _status(self) -> str:
        payload = self.image_chars / MAX_IMAGE_PAYLOAD_CHARS
        return prompts.status_notice(
            elapsed_s=self.session.elapsed_s(),
            soft_deadline_s=self.budget.soft_deadline_s,
            turn=self.turns,
            max_turns=self.budget.max_turns,
            images_used=self.image_count,
            images_max=MAX_REQUEST_IMAGES,
            image_payload_fraction=payload,
        )

    def _notices(self, last_turn_next: bool) -> list[dict[str, Any]]:
        """The status line, operator cues, the one-off commit-now notice and the last-turn
        reminder, appended after the tool results so that earlier turns are never edited."""
        blocks = [_text(self._status())]
        blocks += [_text(prompts.cue_message(cue)) for cue in self.session.drain_cues()]
        if not self.commit_notice_sent and self.session.elapsed_s() >= self.budget.soft_deadline_s:
            self.commit_notice_sent = True
            blocks.append(_text(prompts.COMMIT_NOW_NOTICE))
        if last_turn_next:
            blocks.append(_text(prompts.FINAL_REMINDER))
        return blocks

    def finish(self, stop_reason: str) -> None:
        try:
            entries = self.session.finalize(reason=stop_reason)
        except Exception as exc:  # run_end must still be written
            entries = []
            self.emit("harness", "harness_error", {"where": "finalize", "error": repr(exc)})
        self.emit(
            "harness",
            "run_end",
            {
                "stop_reason": stop_reason,
                "turns": self.turns,
                "tokens": self.tokens,
                "cost_usd": round(self.spend, 6),
                "wall_time_s": round(self.session.elapsed_s(), 3),
                "final_origin": entries[0].origin if entries else None,
            },
        )


async def run_agent(
    session: PanoramaSession,
    pano: Panorama,
    client: ModelClient,
    *,
    budget: Budget,
    http: httpx.AsyncClient | None = None,
) -> None:
    """Drive one panorama to a final answer. Never raises (cancellation aside) and always leaves
    session.final set."""
    stop_reason = "crash"
    run: _AgentRun | None = None
    try:
        run = _AgentRun(session, pano, client, budget, http)
        stop_reason = await run.run()
    except asyncio.CancelledError:
        stop_reason = "cancelled"
        raise
    except Exception as exc:
        session.log.emit(
            "harness", "harness_error", {"where": "loop", "error": repr(exc), "traceback": traceback.format_exc()}
        )
    finally:
        if run is not None:
            run.finish(stop_reason)
        else:
            session.finalize(reason=stop_reason)
