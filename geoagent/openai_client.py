"""OpenAI Responses API model client.

The loop keeps a vendor-neutral history of content blocks. This module is the only place that
knows Responses API items: `to_input` turns the history into the `input` list, `from_response`
turns a finished response into neutral blocks. Each assistant block carries the item it came from
under "item", which is what gets sent back: the API is used statelessly (`store=False`), so the
reasoning items must return exactly as they arrived, encrypted content included.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx2  # the transport under the openai SDK
import openai

# Per-chunk read timeout. The SDK default of 600 s lets a half-open connection eat most of a
# panorama's deadline. A healthy stream has no keep-alives and goes quiet while a reasoning item
# is being produced, but long reasoning arrives as many short items: the longest silence measured
# on `gpt-6.1-sol` at efforts `high` and `xhigh` was 11 s.
API_READ_TIMEOUT_S = 60.0
API_CONNECT_TIMEOUT_S = 10.0
_PLACEHOLDER_REQUEST = httpx2.Request("POST", "https://api.openai.com/v1/responses")
_TERMINAL_EVENTS = frozenset({"response.completed", "response.incomplete", "response.failed"})
NO_CREDENTIALS = "No OpenAI credentials: set OPENAI_API_KEY (environment or .env) before running."


def _field(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


# --- neutral history -> Responses input ------------------------------------------------------------


def _input_part(block: Any, image_detail: str) -> dict[str, Any] | None:
    kind = _field(block, "type")
    if kind == "text":
        return {"type": "input_text", "text": str(_field(block, "text") or "")}
    if kind == "image":
        source = _field(block, "source") or {}
        url = f"data:{source.get('media_type', 'image/jpeg')};base64,{source.get('data', '')}"
        # Always explicit: the API's "auto" picks a resolution, and with it a price, for us.
        return {"type": "input_image", "image_url": url, "detail": image_detail}
    return None


def _input_parts(blocks: Any, image_detail: str) -> list[dict[str, Any]]:
    parts = (_input_part(b, image_detail) for b in blocks)
    return [p for p in parts if p is not None]


def _assistant_items(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"role": "assistant", "content": [{"type": "output_text", "text": content}]}]
    items: list[dict[str, Any]] = []
    for block in content or []:
        item = _field(block, "item")
        kind = _field(block, "type")
        if isinstance(item, dict):
            items.append(item)
        elif kind == "tool_use":
            arguments = json.dumps(_field(block, "input") or {})
            items.append(
                {"type": "function_call", "call_id": _field(block, "id"), "name": _field(block, "name"), "arguments": arguments}
            )
        elif kind == "text":
            text = str(_field(block, "text") or "")
            items.append({"role": "assistant", "content": [{"type": "output_text", "text": text}]})
    # A reasoning item must be followed by the item it led to. A turn cut off while still
    # reasoning ends on one, and leaving it out is always accepted (the model re-reasons).
    while items and items[-1].get("type") == "reasoning":
        items.pop()
    return items


def _user_items(content: Any, image_detail: str) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"role": "user", "content": content}]
    items: list[dict[str, Any]] = []
    rest: list[Any] = []
    for block in content or []:
        if _field(block, "type") != "tool_result":
            rest.append(block)
            continue
        output = _field(block, "content")
        if not isinstance(output, str):
            output = _input_parts(output or [], image_detail)
        # Images travel inside the output itself, next to the text that labels them.
        items.append({"type": "function_call_output", "call_id": _field(block, "tool_use_id"), "output": output})
    parts = _input_parts(rest, image_detail)
    if parts:
        items.append({"role": "user", "content": parts})
    return items


def to_input(messages: list[dict[str, Any]], image_detail: str = "original") -> list[dict[str, Any]]:
    """The neutral history as a Responses API `input` list."""
    items: list[dict[str, Any]] = []
    for message in messages:
        if message.get("role") == "assistant":
            items += _assistant_items(message.get("content"))
        else:
            items += _user_items(message.get("content"), image_detail)
    return items


# --- Responses output -> neutral response ----------------------------------------------------------


def item_dict(item: Any) -> dict[str, Any]:
    """An output item as it must be echoed back: None-valued fields and the SDK's
    `parsed_arguments` are rejected as unknown parameters, while `summary` (even empty) and
    `encrypted_content` on reasoning items are required."""
    if not isinstance(item, dict):
        item = item.model_dump(mode="json", by_alias=True, exclude_none=True, warnings=False)
    # The dump leaves None values inside the plain dicts of an item type the SDK does not model.
    dumped = _without_nulls(item)
    dumped.pop("parsed_arguments", None)
    return dumped


def _without_nulls(node: Any) -> Any:
    if isinstance(node, dict):
        return {k: _without_nulls(v) for k, v in node.items() if v is not None}
    if isinstance(node, list):
        return [_without_nulls(v) for v in node]
    return node


def _message_block(item: dict[str, Any]) -> dict[str, Any]:
    parts = [p for p in item.get("content") or [] if isinstance(p, dict)]
    refusals = [str(p.get("refusal") or "") for p in parts if p.get("type") == "refusal"]
    if refusals:
        return {"type": "refusal", "refusal": "".join(refusals), "item": item}
    texts = [p for p in parts if p.get("type") == "output_text"]
    block: dict[str, Any] = {"type": "text", "text": "".join(str(p.get("text") or "") for p in texts), "item": item}
    annotations = [a for p in texts for a in p.get("annotations") or []]
    if annotations:
        block["annotations"] = annotations
    return block


def _tool_use_block(item: dict[str, Any]) -> dict[str, Any]:
    block: dict[str, Any] = {"type": "tool_use", "id": item.get("call_id"), "name": item.get("name"), "item": item}
    args: Any = None
    # A call cut off at the output limit keeps its half-written arguments and is marked only by
    # its status; it must never be run.
    if item.get("status", "completed") == "completed":
        try:
            args = json.loads(item.get("arguments") or "")
        except ValueError:
            args = None
    if isinstance(args, dict):
        block["input"] = args
    else:
        block["input"] = {}
        block["incomplete"] = True
    return block


def _block(item: dict[str, Any]) -> dict[str, Any]:
    kind = item.get("type")
    if kind == "reasoning":
        summary = [str(s.get("text") or "") for s in item.get("summary") or [] if isinstance(s, dict)]
        return {"type": "thinking", "thinking": "\n\n".join(summary), "item": item}
    if kind == "message":
        return _message_block(item)
    if kind == "function_call":
        return _tool_use_block(item)
    if kind == "web_search_call":
        action = item.get("action") or {}
        return {"type": "server_tool_use", "id": item.get("id"), "name": "web_search", "input": action, "item": item}
    return {"type": kind, "item": item}


def flatten_usage(response: Any) -> dict[str, int]:
    """The integer counters the loop prices and logs. `input_tokens` includes the cached and
    cache-write tokens, and `output_tokens` includes the reasoning tokens, as the API reports them."""
    usage = _field(response, "usage")
    input_details = _field(usage, "input_tokens_details")
    output_details = _field(usage, "output_tokens_details")
    # Searches are billed per request but reported only in an undeclared extra of the response.
    extra = response if isinstance(response, dict) else (getattr(response, "model_extra", None) or {})
    searches = _field(_field(extra.get("tool_usage"), "web_search"), "num_requests")
    if searches is None:
        actions = [_field(i, "action") for i in _field(response, "output") or [] if _field(i, "type") == "web_search_call"]
        searches = sum(_field(a, "type") == "search" for a in actions)
    return {
        "input_tokens": int(_field(usage, "input_tokens") or 0),
        "cached_input_tokens": int(_field(input_details, "cached_tokens") or 0),
        "cache_write_tokens": int(_field(input_details, "cache_write_tokens") or 0),
        "output_tokens": int(_field(usage, "output_tokens") or 0),
        "reasoning_tokens": int(_field(output_details, "reasoning_tokens") or 0),
        "web_search_requests": int(searches or 0),
    }


def from_response(response: Any) -> SimpleNamespace:
    """A finished (completed or incomplete) response as the neutral object the loop reads."""
    content = [_block(item_dict(item)) for item in _field(response, "output") or []]
    details = _field(response, "incomplete_details")
    reason = _field(details, "reason") if _field(response, "status") == "incomplete" else None
    kinds = {block["type"] for block in content}
    # The API has no stop reason: a tool-call turn and a final turn are both just "completed".
    if reason == "max_output_tokens":
        stop_reason = "max_tokens"
    elif "refusal" in kinds or reason == "content_filter":
        stop_reason = "refusal"
    elif "tool_use" in kinds:
        stop_reason = "tool_use"
    else:
        stop_reason = "end_turn"
    if details is not None and not isinstance(details, dict):
        details = details.model_dump(mode="json", exclude_none=True)
    return SimpleNamespace(
        id=_field(response, "id"),
        model=_field(response, "model"),
        content=content,
        stop_reason=stop_reason,
        stop_details=details,
        usage=flatten_usage(response),
    )


# --- the client ------------------------------------------------------------------------------------


def _stream_error(error: Any, fallback: str) -> openai.APIError:
    """An error reported inside an open 200 stream, in the SDK's own type so that `.code` is set.
    It has no HTTP status; the loop classifies it by code. `type` is left out: on a stream event
    it is the event's own name ("error"), not an error class."""
    body = {k: _field(error, k) for k in ("code", "message", "param") if _field(error, k) is not None}
    return openai.APIError(str(body.get("message") or fallback), _PLACEHOLDER_REQUEST, body=body)


def _rejects_summary(exc: openai.BadRequestError) -> bool:
    text = str(exc).lower()
    return exc.param == "reasoning.summary" or "reasoning.summary" in text or "reasoning summar" in text


def _without_summary(params: dict[str, Any]) -> dict[str, Any]:
    reasoning = {k: v for k, v in params["reasoning"].items() if k != "summary"}
    return {**params, "reasoning": reasoning}


class OpenAIModelClient:
    """Streams every request (a long reasoning turn would otherwise sit silent until an HTTP
    timeout) and returns the finished response in the loop's neutral shape."""

    def __init__(
        self,
        client: openai.AsyncOpenAI | None = None,
        *,
        read_timeout_s: float = API_READ_TIMEOUT_S,
        image_detail: str = "original",
    ) -> None:
        self._client = client
        self._read_timeout_s = read_timeout_s
        self._image_detail = image_detail
        self._summary_supported = True

    def _sdk(self) -> openai.AsyncOpenAI:
        """Built on first use: the SDK refuses to construct without a key, and a run without one
        must still start and end with a logged API error and a fallback answer."""
        if self._client is None:
            try:
                # The loop does its own deadline-aware retries; keep the SDK's short.
                self._client = openai.AsyncOpenAI(
                    max_retries=1,
                    timeout=openai.Timeout(600.0, connect=API_CONNECT_TIMEOUT_S, read=self._read_timeout_s),
                )
            except openai.OpenAIError as exc:
                raise openai.OpenAIError(NO_CREDENTIALS) from exc
        return self._client

    async def create(self, *, messages: list[dict[str, Any]], **params: Any) -> Any:
        params = {**params, "input": to_input(messages, self._image_detail)}
        if not self._summary_supported and "summary" in (params.get("reasoning") or {}):
            params = _without_summary(params)
        try:
            return await self._stream(params)
        except openai.BadRequestError as exc:
            # Reasoning summaries need a verified organisation. Losing them costs only the
            # "thinking" lines in the log; a 400 on every request would cost the whole run.
            # Decided by what this request sent, not by the shared flag: the panoramas of a run
            # share the client, and their first requests are all rejected at once.
            if not ("summary" in (params.get("reasoning") or {}) and _rejects_summary(exc)):
                raise
            self._summary_supported = False
            return await self._stream(_without_summary(params))

    async def _stream(self, params: dict[str, Any]) -> Any:
        sdk = self._sdk()
        final: Any = None
        try:
            # Raw events, not the `.stream()` helper: its final-response accessor raises on a
            # truncated response, and its items carry fields the API rejects when echoed.
            async with await sdk.responses.create(stream=True, **params) as stream:
                async for event in stream:
                    kind = getattr(event, "type", None)
                    if kind == "error":
                        raise _stream_error(event, "The stream reported an error")
                    if kind in _TERMINAL_EVENTS:
                        final = event.response
                        break
        except json.JSONDecodeError as exc:
            # A corrupted event payload: the response is unusable and re-issuing the turn is the
            # remedy. Any other ValueError is a programming error and must stay visible.
            raise openai.APIConnectionError(
                message=f"Unusable streamed response ({str(exc)[:300]})", request=_PLACEHOLDER_REQUEST
            ) from exc
        if final is None:
            raise openai.APIConnectionError(
                message="Stream ended before the response completed", request=_PLACEHOLDER_REQUEST
            )
        if final.status == "failed":
            error = final.error or {"code": "server_error"}
            raise _stream_error(error, "The response failed")
        return from_response(final)

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.close()
