"""What the New-run screen is built from: presets, defaults, readiness, and the read-only system
prompt and tool list exactly as a run with the chosen settings would send them."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from . import flag, refusals, refuse, reply, workspace

router = APIRouter()


@router.get("/api/launch/context")
async def launch_context(request: Request) -> Response:
    return reply(await workspace(request).launch_context(), headers={"Cache-Control": "no-store"})


@router.get("/api/prompt")
async def prompt(
    request: Request,
    allow_web: str | None = None,
    no_human: str | None = None,
    disabled_tools: str | None = None,
    max_mcq: str | None = None,
) -> Response:
    """Only the settings the prompt and the tool list depend on; whatever is left out is the
    default a new run would get."""
    form: dict[str, Any] = {}
    for name, raw in (("allow_web", allow_web), ("no_human", no_human)):
        value = flag(raw, name)
        if value is not None:
            form[name] = value
    if disabled_tools is not None:
        form["disabled_tools"] = [name.strip() for name in disabled_tools.split(",") if name.strip()]
    if max_mcq not in (None, ""):
        if not max_mcq.strip().isdigit():
            raise refuse(422, "max_mcq must be a whole number.", code="invalid_query")
        form["max_mcq"] = int(max_mcq)
    with refusals():
        return reply(workspace(request).prompt_preview(form))
