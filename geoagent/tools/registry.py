"""Tool dispatch: name -> handler, with the event logging and error containment the loop relies on.

Handlers are resolved lazily so that importing the registry never fails because one tool module
(or one of its heavy dependencies) is broken; that tool alone then returns an error result.
"""

from __future__ import annotations

import importlib
import time
from typing import Any

from .base import ToolContext, ToolHandler, ToolResult
from .schemas import WEB_CLIENT_TOOLS

_TARGETS: dict[str, tuple[str, str]] = {
    "view_crop": ("view_crop", "run"),
    "update_candidates": ("candidates", "run_update_candidates"),
    "submit_locations": ("candidates", "run_submit_locations"),
    "sun_position": ("sun", "run"),
    "ask_multiple_choice": ("candidates", "run_ask_multiple_choice"),
    "search_places": ("places", "run"),
    "streetview_lookup": ("streetview", "run"),
    "satellite_tile": ("satellite", "run"),
    "overpass_query": ("overpass", "run"),
}
WEB_TOOL_NAMES = frozenset(tool["name"] for tool in WEB_CLIENT_TOOLS)


def _lazy(module: str, attr: str) -> ToolHandler:
    async def handler(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        run = getattr(importlib.import_module(f"{__package__}.{module}"), attr)
        return await run(ctx, args)

    handler.__name__ = f"{module}_{attr}"
    return handler


HANDLERS: dict[str, ToolHandler] = {name: _lazy(*target) for name, target in _TARGETS.items()}


def _emit(ctx: ToolContext, actor: str, event_type: str, data: dict[str, Any]) -> None:
    """Logging must never break a tool call."""
    try:
        ctx.session.log.emit(actor, event_type, data)
    except Exception:
        pass


def _output_text(result: ToolResult) -> str:
    parts = [
        str(block.get("text", "")) if block.get("type") == "text" else f"[{block.get('type', 'block')}]"
        for block in result.content
    ]
    return "\n".join(parts)


async def _dispatch(ctx: ToolContext, name: str, args: Any) -> ToolResult:
    handler = HANDLERS.get(name)
    if handler is None:
        return ToolResult.error(f"Unknown tool '{name}'. Available tools: {', '.join(HANDLERS)}.")
    if not isinstance(args, dict):
        return ToolResult.error(f"{name}: the tool input must be a JSON object.")
    if name in WEB_TOOL_NAMES and (not ctx.settings.allow_web or ctx.http is None):
        return ToolResult.error(
            f"{name} is disabled: external web access is switched off for this run. Rely on the "
            "panorama views, view_crop and sun_position."
        )
    try:
        result = await handler(ctx, args)
    except Exception as exc:  # tool boundary: a broken tool is an error result, never a crashed run
        return ToolResult.error(f"{name} failed: {type(exc).__name__}: {exc}", exception=type(exc).__name__)
    if not isinstance(result, ToolResult):
        return ToolResult.error(f"{name} failed: handler returned {type(result).__name__}, not a ToolResult.")
    return result


def _emit_result(
    ctx: ToolContext, name: str, tool_use_id: str | None, result: ToolResult, started: float
) -> None:
    _emit(
        ctx,
        "tool",
        "tool_result",
        {
            "tool": name,
            "tool_use_id": tool_use_id,
            "is_error": result.is_error,
            "duration_ms": round((time.monotonic() - started) * 1000),
            "output": _output_text(result),
            "urls": result.urls,
            "log": result.log,
        },
    )


def refuse_tool(
    ctx: ToolContext, name: str, args: Any, message: str, *, tool_use_id: str | None = None
) -> ToolResult:
    """An error result for a call the harness declines to dispatch, logged like any other call."""
    _emit(ctx, "agent", "tool_call", {"tool": name, "tool_use_id": tool_use_id, "input": args})
    result = ToolResult.error(message, refused_by_harness=True)
    _emit_result(ctx, name, tool_use_id, result, time.monotonic())
    return result


async def execute_tool(
    ctx: ToolContext, name: str, args: dict[str, Any], *, tool_use_id: str | None = None
) -> ToolResult:
    """Run one client tool. Never raises (cancellation aside); always logs tool_call and tool_result."""
    _emit(ctx, "agent", "tool_call", {"tool": name, "tool_use_id": tool_use_id, "input": args})
    started = time.monotonic()
    result = await _dispatch(ctx, name, args)
    _emit_result(ctx, name, tool_use_id, result, started)
    return result
