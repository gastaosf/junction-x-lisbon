"""Hand-written async Responses API loop (SPEC 6.1, 6.5).

Not the Agents SDK: we need every request and response in the event log, pre-emption of an
in-flight call at the hard deadline, and the ability to wait on an operator's MCQ click.

Invariants this module must keep:
- the instructions, tool list and request settings are built once and never change (they are
  the cached prefix of every request);
- conversation history is append-only and assistant content is echoed back unchanged (the API
  is used statelessly, so each reasoning item must return exactly as it arrived);
- tool choice is left to the model, so nothing depends on submit_locations being called:
  whatever happens, run_agent ends with session.finalize().

The history is kept in a vendor-neutral block format; the model client translates it to and
from Responses API items.
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

import httpx
import httpx2  # the transport under the openai SDK; `httpx` above is what our own tools use
import openai

from . import prompts
from .config import Budget, Pricing, Settings
from .pano import Panorama, View
from .session import PanoramaSession
from .tools.base import ToolContext, ToolResult
from .tools.registry import execute_tool, refuse_tool
from .tools.schemas import tool_definitions

# Transient API failures are retried until the hard deadline pre-empts the run: giving up early
# only swaps a possible recovery for the same best-so-far answer the deadline would submit.
RETRY_BASE_DELAY_S = 2.0
RETRY_MAX_DELAY_S = 20.0
RETRY_JITTER = 0.25  # six panoramas share one API key; do not retry in lockstep
RETRYABLE_STATUS_CODES = frozenset({408, 409, 429})
# A 429 that waiting cannot cure: the account is out of credit.
QUOTA_ERROR_CODE = "insufficient_quota"
# An error inside an already-open stream (an `error` event or a failed response) has no HTTP
# status and is transient unless its code names a fault in the request itself.
REQUEST_FAULT_CODES = frozenset(
    {
        QUOTA_ERROR_CODE,
        "invalid_prompt",
        "context_length_exceeded",
        "content_filter",
        "content_policy_violation",
        "bio_policy",
        "data_residency_mismatch",
        "unsupported_image_media_type",
        "empty_image_file",
        "failed_to_download_image",
    }
)
REQUEST_FAULT_CODE_PARTS = ("invalid_", "image_", "policy_violation")
# An in-stream error with no code at all cannot be classified. A few are worth re-issuing the
# turn for; a longer run of them is a fault in the request that would repeat until the deadline.
UNCODED_STREAM_ERROR_RETRIES = 3

# Harness budgets, far inside the API's own per-request limits. Above 272K input tokens the whole
# request moves to the long-context price, and a full-size view costs about 2,540 tokens: eighty
# images are about 200K, which with the 16.5K of instructions and tools leaves some 55K for text,
# tool output and echoed reasoning. The payload is counted in base64 characters, which is what is
# re-uploaded on every turn.
MAX_REQUEST_IMAGES = 80
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
INCOMPLETE_TOOL_NOTICE = "Not executed: this tool call arrived with incomplete or malformed arguments. Re-issue it."
MCQ_WITH_SUBMIT_NOTICE = (
    "Question not asked and no penalty applied: do not combine ask_multiple_choice with "
    "submit_locations in one turn, because the answer could not change a list that is already "
    "final. Ask first and submit after the answer, or just submit."
)

# Opaque blobs that would bloat the log without telling a reader anything.
_OPAQUE_KEYS = frozenset({"encrypted_content", "data"})
# Blocks whose logged fields already say everything their Responses API item does.
_ITEM_FREE_BLOCKS = frozenset({"thinking", "text", "tool_use", "server_tool_use", "refusal"})
_OPAQUE_MIN_CHARS = 256
_IMAGE_SUFFIX = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}


class ModelClient(Protocol):
    async def create(self, **params: Any) -> Any:
        """Send one request (the request params plus `messages`, the neutral history) and return
        the finished response as an object with id, model, content, stop_reason, stop_details
        and usage."""


def _field(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


_USAGE_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_tokens",
    "output_tokens",
    "reasoning_tokens",
    "web_search_requests",
)


def usage_dict(usage: Any) -> dict[str, int]:
    """The integer counters we price and log, from a model client's usage (dict or object).
    `input_tokens` includes the cached and cache-write tokens; `output_tokens` includes reasoning."""
    return {key: int(_field(usage, key) or 0) for key in _USAGE_KEYS}


def estimate_cost(usage: Any, pricing: Pricing) -> float:
    """USD for one response. Above the long-context threshold the whole request is re-priced,
    not just the tokens past it."""
    u = usage_dict(usage)
    long = u["input_tokens"] > pricing.long_context_threshold
    in_mult, out_mult = (pricing.long_input_multiplier, pricing.long_output_multiplier) if long else (1.0, 1.0)
    cached, written = u["cached_input_tokens"], u["cache_write_tokens"]
    uncached = max(u["input_tokens"] - cached - written, 0)
    tokens = (
        uncached * pricing.input + cached * pricing.cached_input + written * pricing.cache_write
    ) * in_mult + u["output_tokens"] * pricing.output * out_mult
    return tokens / 1_000_000 + u["web_search_requests"] * pricing.web_search_per_1k / 1000


def prompt_cache_key(run_id: str, panorama_id: str) -> str:
    """One cache partition per panorama conversation, the same on every turn and on a resumed
    run. The API caps the key at 64 characters."""
    key = f"geoagent-{run_id}-{panorama_id}"
    if len(key) <= 64:
        return key
    return "geoagent-" + hashlib.sha256(f"{run_id}/{panorama_id}".encode()).hexdigest()[:40]


def build_request_params(settings: Settings, budget: Budget, cache_key: str) -> dict[str, Any]:
    """Everything except the conversation. Built once per run: any change here between turns
    would invalidate the prompt cache, whose prefix is the tools and the instructions."""
    include = ["reasoning.encrypted_content"]
    if settings.allow_web:
        include.append("web_search_call.action.sources")
    return {
        "model": settings.model,
        "instructions": prompts.build_system_prompt(settings),
        "tools": tool_definitions(settings),
        "reasoning": {"effort": budget.effort, "summary": "auto"},
        # Reasoning tokens count toward this limit.
        "max_output_tokens": settings.max_tokens,
        "parallel_tool_calls": True,
        # Stateless: nothing is kept server-side, so the history is re-sent in full and the
        # reasoning items must come back encrypted to be echoed.
        "store": False,
        "include": include,
        "prompt_cache_key": cache_key,
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


def _without_items(content: list[Any]) -> list[Any]:
    """Response content for the log, without the raw API item behind each block we understand."""
    out = []
    for block in content:
        if isinstance(block, dict) and block.get("type") in _ITEM_FREE_BLOCKS:
            block = {k: v for k, v in block.items() if k != "item"}
        out.append(block)
    return out


def _error_field(exc: BaseException, name: str) -> str | None:
    value = getattr(exc, name, None)
    if not isinstance(value, str):
        body = getattr(exc, "body", None)
        value = body.get(name) if isinstance(body, dict) else None
    return value if isinstance(value, str) else None


def _request_fault(code: str | None) -> bool:
    return code is not None and (code in REQUEST_FAULT_CODES or any(part in code for part in REQUEST_FAULT_CODE_PARTS))


def _retryable(exc: BaseException) -> bool:
    """Transient failures worth re-issuing the turn for. 400/401/403/404/413/422 stay terminal."""
    if isinstance(exc, (openai.APIConnectionError, httpx2.TransportError)):
        return True
    if not isinstance(exc, openai.APIError):
        return False
    code = _error_field(exc, "code")
    if code == QUOTA_ERROR_CODE:
        return False
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status >= 500 or status in RETRYABLE_STATUS_CODES
    # No status: the error arrived inside an open stream. One that names a request parameter is
    # a fault in the request, whatever its code.
    if _error_field(exc, "type") == "invalid_request_error" or _error_field(exc, "param"):
        return False
    return not _request_fault(code)


def _uncoded_stream_error(exc: BaseException) -> bool:
    if isinstance(exc, (openai.APIConnectionError, openai.APIStatusError, httpx2.TransportError)):
        return False
    return _error_field(exc, "code") is None


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
        "error_type": _error_field(exc, "type"),
        "error_code": _error_field(exc, "code"),
        "param": _error_field(exc, "param"),
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
        cache_key = prompt_cache_key(session.run_id, session.task.panorama_id)
        self.params = build_request_params(session.settings, budget, cache_key)
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
        request = {k: v for k, v in self.params.items() if k not in {"instructions", "tools"}}
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
                "system_prompt": self.params["instructions"],
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
            except (openai.OpenAIError, httpx2.TransportError) as exc:
                self.emit("harness", "api_error", _api_error_data(exc))
                return "finalized_externally" if self.session.final is not None else "api_error"
            stop = _field(response, "stop_reason")
            content = list(_field(response, "content") or [])
            if stop == "refusal":
                # A refusal can cut a tool call off mid-arguments: never execute that turn's tools.
                return "refusal"
            if content:
                self.messages.append({"role": "assistant", "content": content})
            tool_uses = [b for b in content if _field(b, "type") == "tool_use"]
            reply: list[dict[str, Any]]
            if tool_uses:
                notice = TRUNCATED_TOOL_NOTICE if stop == "max_tokens" else INCOMPLETE_TOOL_NOTICE
                reply = await self._run_tools(tool_uses, notice)
            elif stop == "max_tokens":
                reply = [_text(prompts.MAX_TOKENS_NOTICE)]
            elif nudged:
                return "end_turn"
            else:
                nudged = True
                reply = [_text(prompts.NO_SUBMISSION_NUDGE)]
            if self.session.final is not None:
                submitted = any(
                    _field(b, "name") == "submit_locations" and not _field(b, "incomplete") for b in tool_uses
                )
                return "submitted" if submitted else "finalized_externally"
            if self.spend >= self.budget.max_spend_usd:
                return "max_spend"
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
                "content": self.images.for_log(_without_items(list(_field(response, "content") or []))),
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
        attempt = uncoded = 0
        while True:
            try:
                return await self.client.create(**self.params, messages=self.messages)
            except (openai.APIError, httpx2.TransportError) as exc:
                uncoded = uncoded + 1 if _uncoded_stream_error(exc) else 0
                if not _retryable(exc) or uncoded > UNCODED_STREAM_ERROR_RETRIES or self.session.final is not None:
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

    async def _run_tools(self, tool_uses: list[Any], unexecuted_notice: str) -> list[dict[str, Any]]:
        """Run every function call of the turn concurrently; all results go in one user message.

        A call flagged incomplete (cut off at the output limit, or with arguments that are not a
        JSON object) is answered with the notice instead of being run. Only the call being
        written when the limit hit can be incomplete, so earlier ones still run.
        """
        runnable = [b for b in tool_uses if not _field(b, "incomplete")]
        # A question asked in the turn that submits is charged x0.95 and then closed unanswered by
        # the submission itself, so it is never put to the operator.
        submitting = any(_field(b, "name") == "submit_locations" for b in runnable)

        async def one(block: Any) -> ToolResult:
            name, args, tool_use_id = _field(block, "name"), _field(block, "input"), _field(block, "id")
            if submitting and name == "ask_multiple_choice":
                return refuse_tool(self.ctx, name, args, MCQ_WITH_SUBMIT_NOTICE, tool_use_id=tool_use_id)
            return await execute_tool(self.ctx, name, args, tool_use_id=tool_use_id)

        results = iter(await asyncio.gather(*(one(b) for b in runnable), return_exceptions=True))
        # Every function call needs an output, run or not, or the next request is a 400.
        return [
            {"type": "tool_result", "tool_use_id": _field(b, "id"), "content": unexecuted_notice, "is_error": True}
            if _field(b, "incomplete")
            else self._tool_result(b, next(results))
            for b in tool_uses
        ]

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
        # A function call without a matching output is a 400 that would end the conversation.
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
