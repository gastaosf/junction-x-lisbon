"""Tool plumbing shared by every client tool.

A tool handler is `async def run(ctx: ToolContext, args: dict) -> ToolResult`. Handlers never
raise for expected failures (bad input, network error, timeout): they return
`ToolResult.error(...)`, which the loop sends back as a tool_result with is_error=true.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Awaitable, Callable

if TYPE_CHECKING:  # avoid import cycles; these are only type hints
    import httpx

    from ..config import Settings
    from ..pano import Panorama
    from ..session import PanoramaSession


@dataclass
class ToolResult:
    # Anthropic tool_result content blocks: {"type": "text", ...} and/or
    # {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": ...}}
    content: list[dict[str, Any]]
    is_error: bool = False
    # JSON-serialisable summary for the event log (never raw image bytes; reference images as
    # {"sha256", "path", ...})
    log: dict[str, Any] = field(default_factory=dict)
    # external URLs called, for the tool_result event
    urls: list[str] = field(default_factory=list)

    @classmethod
    def text(cls, text: str, **log: Any) -> "ToolResult":
        return cls(content=[{"type": "text", "text": text}], log=dict(log))

    @classmethod
    def error(cls, message: str, **log: Any) -> "ToolResult":
        return cls(content=[{"type": "text", "text": message}], is_error=True, log=dict(log))


@dataclass
class ToolContext:
    session: "PanoramaSession"  # task, settings, penalty ledger, event log, hypotheses
    pano: "Panorama"
    settings: "Settings"
    http: "httpx.AsyncClient | None"  # None when ALLOW_WEB is false


ToolHandler = Callable[[ToolContext, dict[str, Any]], Awaitable[ToolResult]]
