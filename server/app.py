"""Operator UI backend (SPEC section 8): FastAPI + server-sent events + one static page.

Rule compliance is the point of this module (SPEC section 4). Exactly three endpoints carry
operator input to the agent, and each one only forwards to the PanoramaSession method that owns
the penalty: MCQ answer (R7), cue (R6), last-resort geocode (R8). Everything else is read-only
or a harness control (finalise, export, the "MCQ allowed" switch) that passes no information.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image
from pydantic import BaseModel, Field, StrictBool

from geoagent.schema import Label
from geoagent.scoring import penalty_multiplier
from geoagent.session import HumanChannelError, PanoramaSession

STATIC_DIR = Path(__file__).parent / "static"
HEARTBEAT_S = 10.0
IMAGE_WIDTHS = (1024, 2048, 4096)
ACTIVE_STATUSES = {"running", "awaiting_mcq"}
_SHA_RE = re.compile(r"^[0-9a-f]{8,64}$")
_TEXT_LIMIT = 6000
_SNIPPET_LIMIT = 400


class McqAnswerBody(BaseModel):
    index: int = Field(ge=0, le=3)


class McqAllowedBody(BaseModel):
    allowed: StrictBool


class CueLintBody(BaseModel):
    text: str


class CueBody(BaseModel):
    text: str
    confirmed: StrictBool = False


class GeocodeBody(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    place_label: str
    confirmed: StrictBool = False


# ---------------------------------------------------------------------------------------------
# state for the page


def _dump(obj: Any) -> Any:
    return obj.model_dump(mode="json") if hasattr(obj, "model_dump") else obj


def _mcq_remaining_s(asked_at: Any, timeout_s: float) -> float:
    """Seconds left to answer; `asked_at` is the session's UTC ISO timestamp."""
    try:
        asked = datetime.fromisoformat(str(asked_at).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return timeout_s
    return min(timeout_s, max(0.0, timeout_s - (time.time() - asked)))


def _sort_key(session: PanoramaSession) -> tuple[bool, bool, str]:
    task = session.task
    return (not task.special, task.label is not Label.URBAN, task.panorama_id)


def tile_state(session: PanoramaSession, *, live: bool = False, elapsed_s: float | None = None) -> dict[str, Any]:
    """JSON-safe state of one panorama tile. `elapsed_s` overrides the running clock (frozen once final)."""
    task, settings = session.task, session.settings
    penalty = session.ledger.state()
    human = not settings.no_human
    pending = session.pending_mcq
    mcq = None
    if pending and human and not pending.get("answered"):
        mcq = {
            "id": str(pending.get("id")),
            "question": str(pending.get("question", "")),
            "options": [str(o) for o in pending.get("options", [])][:4],
            "why_it_matters": str(pending.get("why_it_matters", "")),
            "timeout_s": settings.mcq_timeout_s,
            "remaining_s": _mcq_remaining_s(pending.get("asked_at"), settings.mcq_timeout_s),
        }
    named_places = list(session.named_places)
    return {
        "panorama_id": task.panorama_id,
        "filename": Path(task.path).name,
        "label": task.label.value,
        "timestamp": task.timestamp,
        "special": task.special,
        "status": session.status,
        "active": session.status in ACTIVE_STATUSES,
        "hypotheses": [_dump(h) for h in session.hypotheses],
        "provisional": [_dump(e) for e in session.provisional],
        "final": None if session.final is None else [_dump(e) for e in session.final],
        "penalty": _dump(penalty),
        "multiplier_after": {
            "cue": penalty_multiplier(penalty.cues + 1, penalty.mcqs, penalty.human_geocodes),
            "geocode": penalty_multiplier(penalty.cues, penalty.mcqs, penalty.human_geocodes + 1),
        },
        "pending_mcq": mcq,
        "mcq_allowed": bool(session.mcq_allowed),
        "mcqs_left": max(0, settings.max_mcq - penalty.mcqs),
        "named_places": named_places,
        "geocode_enabled": human and bool(named_places),
        "human_enabled": human,
        "elapsed_s": session.elapsed_s() if elapsed_s is None else elapsed_s,
        "spend_usd": session.spend_usd,
        "turns": session.turns,
        "budget": _dump(settings.budget_for(task.special, live)),
    }


# ---------------------------------------------------------------------------------------------
# event digests for the reasoning stream


def _clip(value: Any, limit: int = _SNIPPET_LIMIT) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _line(kind: str, text: str) -> dict[str, str]:
    return {"kind": kind, "text": text}


def _content_lines(content: Any) -> list[dict[str, str]]:
    if isinstance(content, str):
        return [_line("text", _clip(content, _TEXT_LIMIT))] if content.strip() else []
    lines: list[dict[str, str]] = []
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "thinking" and str(block.get("thinking") or "").strip():
            lines.append(_line("thinking", _clip(block["thinking"], _TEXT_LIMIT)))
        elif kind == "text" and str(block.get("text") or "").strip():
            lines.append(_line("text", _clip(block["text"], _TEXT_LIMIT)))
        elif kind in {"tool_use", "server_tool_use"}:
            lines.append(_line("tool", f"{block.get('name', '?')} {_clip(block.get('input', {}))}"))
        elif isinstance(kind, str) and kind.endswith("_tool_result"):
            lines.append(_line("result", kind.removesuffix("_tool_result") + " result"))
    return lines


def _image_shas(node: Any, found: list[str]) -> list[str]:
    if isinstance(node, dict):
        sha = node.get("sha256")
        if isinstance(sha, str) and _SHA_RE.match(sha) and sha not in found:
            found.append(sha)
        for value in node.values():
            _image_shas(value, found)
    elif isinstance(node, list):
        for value in node:
            _image_shas(value, found)
    return found


def _tool_name(data: dict[str, Any]) -> str:
    return str(data.get("name") or data.get("tool") or data.get("tool_name") or "?")


def _event_lines(type_: str, data: dict[str, Any]) -> list[dict[str, str]]:
    if type_ == "model_request":
        return []
    if type_ == "model_response":
        lines = _content_lines(data.get("content"))
        stop = data.get("stop_reason")
        if stop and stop not in {"tool_use", "end_turn"}:
            lines.append(_line("harness", f"stop_reason: {stop}"))
        return lines
    if type_ == "tool_call":
        return [_line("tool", f"{_tool_name(data)} {_clip(data.get('input', data.get('args', {})))}")]
    if type_ == "tool_result":
        kind = "error" if data.get("is_error") else "result"
        duration = data.get("duration_ms")
        took = f" ({duration:.0f} ms)" if isinstance(duration, (int, float)) else ""
        output = data.get("output", data.get("log", ""))
        return [_line(kind, f"{_tool_name(data)}{took}: {_clip(output)}")]
    if type_ == "candidates_update":
        hyps = [h for h in data.get("hypotheses", []) if isinstance(h, dict)]
        top = max(hyps, key=lambda h: h.get("probability", 0), default=None)
        best = f"; top {top.get('probability', 0):.0%} {_clip(top.get('label', ''), 80)}" if top else ""
        return [_line("harness", f"{len(hyps)} hypotheses{best}")]
    if type_ == "mcq_asked":
        options = " | ".join(str(o) for o in data.get("options", []))
        return [_line("human", f"MCQ: {_clip(data.get('question', ''))} [{_clip(options)}]")]
    if type_ == "mcq_answered":
        index = data.get("selected_index")
        answer = "no answer (timeout)" if index is None else f"option {index + 1}: {data.get('selected_option', '')}"
        return [_line("human", f"MCQ answer: {_clip(answer)}")]
    if type_ == "human_cue":
        return [_line("human", f"Cue: {_clip(data.get('text', ''), 1000)}")]
    if type_ == "human_geocode":
        return [_line("human", f"Human geocode: {_clip(data)}")]
    if type_ == "final_submission":
        return [_line("harness", f"FINAL origin={data.get('origin')} reason={_clip(data.get('reason', ''))}")]
    if type_ == "run_start":
        return [_line("harness", f"start model={data.get('model')} effort={data.get('effort')}")]
    return [_line("harness", _clip(data))] if data else []


def digest_event(envelope: dict[str, Any]) -> dict[str, Any]:
    """Compact, display-ready form of a log event (the full event stays in the JSONL log)."""
    data = envelope.get("data")
    data = data if isinstance(data, dict) else {}
    type_ = str(envelope.get("type", ""))
    return {
        "seq": envelope.get("seq"),
        "ts": envelope.get("ts"),
        "t_rel_s": envelope.get("t_rel_s"),
        "actor": envelope.get("actor"),
        "type": type_,
        "multiplier": (envelope.get("penalty_state") or {}).get("multiplier"),
        "lines": _event_lines(type_, data),
        "images": _image_shas(data, [])[:6] if type_ == "tool_result" else [],
    }


# ---------------------------------------------------------------------------------------------
# SSE


def _sse(event: str, payload: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, default=str, ensure_ascii=False)}\n\n"


def _equirect_preview(session: PanoramaSession, width: int) -> Path:
    """Downscaled copy of the panorama for the tile, cached next to the run's images."""
    out = session.image_dir.parent / f"ui_equirect_{width}.jpg"
    if out.exists():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{uuid.uuid4().hex}.tmp")
    with Image.open(session.task.path) as image:
        image.draft("RGB", (width, width // 2))
        preview = image.convert("RGB")
        preview.thumbnail((width, width // 2), Image.Resampling.LANCZOS)
        preview.save(tmp, "JPEG", quality=85)
    tmp.replace(out)
    return out


def create_app(manager: Any, *, heartbeat_s: float = HEARTBEAT_S) -> FastAPI:
    """`manager` is a RunManager (needs .sessions, .settings, .snapshot(), .finalize_all(), .export_all())."""
    app = FastAPI(title="geoagent operator UI", docs_url=None, redoc_url=None)
    finished_at: dict[str, float] = {}  # elapsed time at which each panorama was first seen final
    live = bool(getattr(manager, "live", False))

    def session_or_404(panorama_id: str) -> PanoramaSession:
        session = manager.sessions.get(panorama_id)
        if session is None:
            raise HTTPException(404, f"unknown panorama {panorama_id!r}")
        return session

    def human_session(panorama_id: str) -> PanoramaSession:
        session = session_or_404(panorama_id)
        if manager.settings.no_human or session.settings.no_human:
            raise HTTPException(403, "human channels are disabled (--no-human)")
        return session

    def tile(session: PanoramaSession) -> dict[str, Any]:
        frozen = None
        if session.final is not None:
            frozen = finished_at.setdefault(session.task.panorama_id, session.elapsed_s())
        return tile_state(session, live=live, elapsed_s=frozen)

    def ui_state() -> dict[str, Any]:
        settings = manager.settings
        return {
            "run_id": getattr(manager, "run_id", None),
            "team": settings.team,
            "no_human": settings.no_human,
            "cue_max_chars": settings.cue_max_chars,
            "max_mcq": settings.max_mcq,
            "watchdog_s": settings.global_watchdog_s,
            "penalty_scope": settings.penalty_scope,
            "panoramas": [tile(s) for s in sorted(manager.sessions.values(), key=_sort_key)],
        }

    async def event_stream() -> AsyncIterator[str]:
        merged: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue()
        queues: dict[str, asyncio.Queue[dict[str, Any]]] = {}
        pumps: list[asyncio.Task[None]] = []

        async def pump(panorama_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
            while True:
                await merged.put((panorama_id, await queue.get()))

        def subscribe_new() -> bool:
            added = False
            for panorama_id, session in list(manager.sessions.items()):
                if panorama_id not in queues:
                    queues[panorama_id] = session.subscribe()
                    pumps.append(asyncio.create_task(pump(panorama_id, queues[panorama_id])))
                    added = True
            return added

        try:
            subscribe_new()
            yield _sse("snapshot", ui_state())
            while True:
                try:
                    panorama_id, envelope = await asyncio.wait_for(merged.get(), heartbeat_s)
                except asyncio.TimeoutError:
                    # sessions added after connect (add_tasks) need a subscription and a tile
                    yield _sse("snapshot", ui_state()) if subscribe_new() else ": ping\n\n"
                    continue
                session = manager.sessions.get(panorama_id)
                yield _sse(
                    "event",
                    {
                        "panorama_id": panorama_id,
                        "event": digest_event(envelope),
                        "state": tile(session) if session is not None else None,
                    },
                )
        finally:
            for task in pumps:
                task.cancel()
            for panorama_id, queue in queues.items():
                session = manager.sessions.get(panorama_id)
                if session is not None:
                    session.unsubscribe(queue)

    app.state.event_stream = event_stream
    app.state.ui_state = ui_state

    export_lock = asyncio.Lock()

    async def export_now() -> list[Any]:
        """Rewrite the exports off the event loop: it reads and re-serialises every log, and the
        loop it would block is the one driving all agent runs, MCQ timers and the SSE stream."""
        async with export_lock:
            result = await asyncio.to_thread(manager.export_all)
            if inspect.isawaitable(result):
                result = await result
            return list(result or [])

    async def refresh_exports() -> None:
        """After an operator action that changes a final answer, the files on disk must follow:
        they are what gets submitted. Never fails the request that triggered it."""
        try:
            await export_now()
        except Exception:
            pass

    # ---- read-only ---------------------------------------------------------------------------

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", media_type="text/html", headers={"Cache-Control": "no-store"})

    @app.get("/api/state")
    def get_state() -> dict[str, Any]:
        return {**ui_state(), "run": manager.snapshot()}

    @app.get("/api/stream")
    async def stream() -> StreamingResponse:
        headers = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
        return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)

    @app.get("/api/pano/{panorama_id}/events")
    def pano_events(panorama_id: str, after: int = 0) -> dict[str, Any]:
        session = session_or_404(panorama_id)
        events = [e for e in session.log.events() if (e.get("seq") or 0) > after]
        return {"panorama_id": panorama_id, "events": [digest_event(e) for e in events]}

    @app.get("/api/pano/{panorama_id}/image")
    def pano_image(panorama_id: str, w: int = 2048) -> FileResponse:
        session = session_or_404(panorama_id)
        width = min(IMAGE_WIDTHS, key=lambda choice: abs(choice - w))
        try:
            path = _equirect_preview(session, width)
        except OSError as exc:
            raise HTTPException(404, f"panorama image unavailable: {exc}") from exc
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})

    @app.get("/api/pano/{panorama_id}/views/{sha}")
    def pano_view(panorama_id: str, sha: str) -> FileResponse:
        session = session_or_404(panorama_id)
        if not _SHA_RE.match(sha):
            raise HTTPException(400, "bad image id")
        path = session.image_dir / f"{sha}.jpg"
        if not path.is_file():
            raise HTTPException(404, "no such view")
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})

    # ---- the three human controls (penalised; the session owns the ledger) ---------------------

    @app.post("/api/pano/{panorama_id}/mcq/{mcq_id}/answer")
    async def answer_mcq(panorama_id: str, mcq_id: str, body: McqAnswerBody) -> dict[str, Any]:
        session = human_session(panorama_id)
        try:
            session.answer_mcq(mcq_id, body.index)
        except HumanChannelError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"ok": True, "state": tile(session)}

    @app.post("/api/pano/{panorama_id}/cue/lint")
    async def lint(panorama_id: str, body: CueLintBody) -> dict[str, Any]:
        """Dry run of the session's own checks: no penalty, nothing reaches the agent."""
        session = human_session(panorama_id)
        before = session.ledger.multiplier
        problems: list[str] = []
        try:
            session.submit_cue(body.text, confirmed=False)
        except HumanChannelError as exc:
            problems = list((exc.lint or {}).get("problems") or [str(exc)])
        return {
            "ok": not problems,
            "problems": problems,
            "char_count": len(body.text.strip()),
            "max_chars": session.settings.cue_max_chars,
            "multiplier_before": before,
            "multiplier_after": tile(session)["multiplier_after"]["cue"],
        }

    @app.post("/api/pano/{panorama_id}/cue")
    async def cue(panorama_id: str, body: CueBody) -> dict[str, Any]:
        session = human_session(panorama_id)
        if not body.confirmed:
            raise HTTPException(400, "confirmed=true is required: a cue costs x0.8")
        try:
            result = session.submit_cue(body.text, confirmed=True)
        except HumanChannelError as exc:
            raise HTTPException(422, {"message": str(exc), "lint": exc.lint}) from exc
        return {"ok": True, "result": result, "state": tile(session)}

    @app.post("/api/pano/{panorama_id}/geocode")
    async def geocode(panorama_id: str, body: GeocodeBody) -> dict[str, Any]:
        session = human_session(panorama_id)
        if not body.confirmed:
            raise HTTPException(400, "confirmed=true is required: a human geocode costs x0.5")
        if body.place_label not in session.named_places:
            raise HTTPException(409, "geocode is only allowed for a place the agent has named")
        try:
            session.human_geocode(body.lat, body.lng, body.place_label)
        except HumanChannelError as exc:
            raise HTTPException(409, str(exc)) from exc
        await refresh_exports()  # the human point is final at once; stale files would contradict it
        return {"ok": True, "state": tile(session)}

    # ---- harness controls (no information reaches the agent) -----------------------------------

    @app.post("/api/pano/{panorama_id}/mcq_allowed")
    async def set_mcq_allowed(panorama_id: str, body: McqAllowedBody) -> dict[str, Any]:
        session = human_session(panorama_id)
        if session.mcq_allowed != body.allowed:
            session.set_mcq_allowed(body.allowed)
        return {"ok": True, "state": tile(session)}

    @app.post("/api/pano/{panorama_id}/finalize")
    async def finalize(panorama_id: str) -> dict[str, Any]:
        session = session_or_404(panorama_id)
        session.finalize(reason="operator_finalize")
        await refresh_exports()
        return {"ok": True, "state": tile(session)}

    @app.post("/api/finalize_all")
    async def finalize_all() -> dict[str, Any]:
        result = manager.finalize_all("operator_finalize_all")
        if inspect.isawaitable(result):
            await result
        await refresh_exports()
        return {"ok": True, **ui_state()}

    @app.post("/api/export")
    async def export() -> dict[str, Any]:
        return {"ok": True, "paths": [str(p) for p in await export_now()]}

    return app
