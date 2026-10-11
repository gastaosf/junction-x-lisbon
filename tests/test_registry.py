"""Registry tests: dispatch, ALLOW_WEB gating, error containment and event logging."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from astrolabio.config import Settings
from astrolabio.tools import registry
from astrolabio.tools.base import ToolContext, ToolResult
from astrolabio.tools.schemas import HUMAN_TOOLS, LOCAL_TOOLS, WEB_CLIENT_TOOLS


class FakeLog:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict[str, Any]]] = []

    def emit(self, actor: str, type: str, data: dict[str, Any]) -> dict[str, Any]:
        self.events.append((actor, type, data))
        return {}


def make_ctx(*, allow_web: bool = True, with_http: bool = True, log: Any = None) -> ToolContext:
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(500)))
    session = SimpleNamespace(log=log or FakeLog())
    return ToolContext(session=session, pano=None, settings=Settings(allow_web=allow_web), http=client if with_http else None)


def install(monkeypatch: pytest.MonkeyPatch, name: str, handler: Any) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def wrapped(ctx: ToolContext, args: dict[str, Any]) -> Any:
        calls.append(args)
        return await handler(ctx, args)

    monkeypatch.setitem(registry.HANDLERS, name, wrapped)
    return calls


def test_handlers_cover_every_client_tool() -> None:
    expected = {tool["name"] for tool in [*LOCAL_TOOLS, *HUMAN_TOOLS, *WEB_CLIENT_TOOLS]}
    assert set(registry.HANDLERS) == expected
    assert registry.WEB_TOOL_NAMES == {"search_places", "streetview_lookup", "satellite_tile", "overpass_query"}


async def test_lazy_handlers_resolve_the_real_modules() -> None:
    ctx = make_ctx()
    result = await registry.execute_tool(ctx, "search_places", {"query": "", "countrycodes": "", "viewbox": ""})
    assert result.is_error and "query is empty" in result.content[0]["text"]
    result = await registry.execute_tool(ctx, "overpass_query", {"ql": ""})
    assert result.is_error and "ql is empty" in result.content[0]["text"]


async def test_execute_logs_call_and_result(monkeypatch: pytest.MonkeyPatch) -> None:
    async def handler(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        image = {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}}
        return ToolResult(
            content=[{"type": "text", "text": "aerial view"}, image],
            log={"image": {"sha256": "abc", "path": "x.jpg"}},
            urls=["https://example.test/export"],
        )

    calls = install(monkeypatch, "satellite_tile", handler)
    ctx = make_ctx()
    args = {"lat": 1.0, "lng": 2.0, "zoom": 15}
    result = await registry.execute_tool(ctx, "satellite_tile", args, tool_use_id="call_1")
    assert calls == [args] and not result.is_error

    (call_actor, call_type, call), (result_actor, result_type, logged) = ctx.session.log.events
    assert (call_actor, call_type) == ("agent", "tool_call")
    assert call == {"tool": "satellite_tile", "tool_use_id": "call_1", "input": args}
    assert (result_actor, result_type) == ("tool", "tool_result")
    assert logged["tool"] == "satellite_tile" and logged["tool_use_id"] == "call_1"
    assert logged["is_error"] is False and isinstance(logged["duration_ms"], int) and logged["duration_ms"] >= 0
    assert logged["urls"] == ["https://example.test/export"]
    assert logged["log"] == {"image": {"sha256": "abc", "path": "x.jpg"}}
    assert logged["output"] == "aerial view\n[image]"  # image bytes never reach the log


async def test_unknown_tool_is_an_error_result() -> None:
    ctx = make_ctx()
    result = await registry.execute_tool(ctx, "teleport", {})
    assert result.is_error and "Unknown tool 'teleport'" in result.content[0]["text"]
    assert [event[1] for event in ctx.session.log.events] == ["tool_call", "tool_result"]
    assert ctx.session.log.events[1][2]["is_error"] is True


@pytest.mark.parametrize("name", sorted(registry.WEB_TOOL_NAMES))
async def test_web_tools_are_blocked_when_allow_web_is_off(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    async def handler(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        return ToolResult.text("should not run")

    calls = install(monkeypatch, name, handler)
    for ctx in (make_ctx(allow_web=False), make_ctx(with_http=False)):
        result = await registry.execute_tool(ctx, name, {})
        assert result.is_error and "disabled" in result.content[0]["text"]
        assert ctx.session.log.events[-1][2]["is_error"] is True
    assert not calls


async def test_local_tools_still_run_when_allow_web_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    async def handler(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        return ToolResult.text("cropped")

    install(monkeypatch, "view_crop", handler)
    result = await registry.execute_tool(make_ctx(allow_web=False, with_http=False), "view_crop", {"yaw": 0})
    assert not result.is_error and result.content[0]["text"] == "cropped"


async def test_handler_exceptions_become_error_results(monkeypatch: pytest.MonkeyPatch) -> None:
    async def handler(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        raise RuntimeError("kaboom")

    install(monkeypatch, "sun_position", handler)
    ctx = make_ctx()
    result = await registry.execute_tool(ctx, "sun_position", {})
    assert result.is_error and "sun_position failed: RuntimeError: kaboom" in result.content[0]["text"]
    assert ctx.session.log.events[-1][2]["log"] == {"exception": "RuntimeError"}


async def test_bad_handler_return_and_bad_input(monkeypatch: pytest.MonkeyPatch) -> None:
    async def handler(ctx: ToolContext, args: dict[str, Any]) -> Any:
        return "not a result"

    install(monkeypatch, "view_crop", handler)
    ctx = make_ctx()
    wrong_type = await registry.execute_tool(ctx, "view_crop", {})
    not_a_dict = await registry.execute_tool(ctx, "view_crop", ["yaw", 10])  # type: ignore[arg-type]
    assert wrong_type.is_error and "not a ToolResult" in wrong_type.content[0]["text"]
    assert not_a_dict.is_error and "JSON object" in not_a_dict.content[0]["text"]


async def test_missing_tool_module_is_contained(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(registry.HANDLERS, "view_crop", registry._lazy("no_such_module", "run"))
    result = await registry.execute_tool(make_ctx(), "view_crop", {})
    assert result.is_error and "ModuleNotFoundError" in result.content[0]["text"]


async def test_logging_failures_do_not_break_the_tool(monkeypatch: pytest.MonkeyPatch) -> None:
    class BrokenLog:
        def emit(self, *args: Any) -> dict[str, Any]:
            raise OSError("disk full")

    async def handler(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        return ToolResult.text("fine")

    install(monkeypatch, "view_crop", handler)
    result = await registry.execute_tool(make_ctx(log=BrokenLog()), "view_crop", {})
    assert not result.is_error and result.content[0]["text"] == "fine"
