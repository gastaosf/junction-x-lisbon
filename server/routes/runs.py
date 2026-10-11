"""Runs: the event stream, the index, launch, the run-level controls and everything under
`/api/runs/<run_id>/pano/<panorama_id>/`.

Rule compliance is the point of this module, as it was of the legacy app (SPEC section 4).
Exactly three endpoints carry operator input to the agent, and each only forwards to the
PanoramaSession method that owns the penalty: the MCQ answer (R7), the cue (R6) and the
last-resort geocode (R8). Everything else is read-only or a harness control that passes no
information. `cue/check` writes nothing anywhere.

Threading: every route here is `async def` and calls a live session or manager inline on the
loop thread; what blocks (logs, images) is read in a worker thread that never touches one.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from PIL import Image

from astrolabio.session import HumanChannelError, PanoramaSession

from ..runstate import digest_events, iter_events
from ..security import confine, redact_deep, safe_sha
from . import (
    body_id,
    check_task_choices,
    idempotent,
    json_body,
    path_id,
    refusals,
    refuse,
    reply,
    workspace,
)

router = APIRouter()

_IMAGE_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png"}
# What `check_cue` calls a refused cue, as an HTTP status: a state the cue cannot be sent in is a
# conflict, a text that cannot be sent at all is a validation failure.
_CUE_STATUS = {"disabled": 403, "final": 409, "duplicate": 409, "too_late": 409}
_MCQ_SETTLE_STEPS = 5


def _ids(run_id: str, panorama_id: str | None = None) -> None:
    path_id(run_id, "run id")
    if panorama_id is not None:
        path_id(panorama_id, "panorama id")


def _session(request: Request, run_id: str, panorama_id: str) -> PanoramaSession:
    """A live session of this process: 404 for an unknown run or panorama, 409 for a run that
    exists only on disk (there is nothing to send the action to)."""
    handle = workspace(request).require_owned(run_id)
    session = handle.manager.sessions.get(panorama_id)
    if session is None:
        raise refuse(
            404,
            f"Run {run_id} has no panorama {panorama_id}. Reload the page to see what it holds.",
            code="unknown_panorama",
        )
    return session


def _human_session(request: Request, run_id: str, panorama_id: str) -> PanoramaSession:
    session = _session(request, run_id, panorama_id)
    if workspace(request).require_owned(run_id).settings.no_human or session.settings.no_human:
        raise refuse(
            403,
            "Human channels are off for this run (it is autonomous): no question, cue or geocode can reach "
            "the agent. Launch an assisted run to use them.",
            code="human_channels_off",
        )
    return session


def _confirmed(body: dict[str, Any], what: str) -> None:
    if body.get("confirmed") is not True:
        raise refuse(
            400, f"confirmed=true is required: {what}. Confirm in the dialog, then send again.", code="unconfirmed"
        )


def _number(body: dict[str, Any], key: str, limit: float) -> float:
    value = body.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not abs(value) <= limit:
        raise refuse(422, f"{key} must be a number within +/-{limit:g}.", code="invalid_coordinates")
    return float(value)


# ---------------------------------------------------------------------------------------------
# stream and index


@router.get("/api/stream")
async def stream(request: Request) -> StreamingResponse:
    headers = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
    return StreamingResponse(request.app.state.stream(), media_type="text/event-stream", headers=headers)


@router.get("/api/snapshot")
async def snapshot(request: Request) -> Response:
    return reply(workspace(request).snapshot(), headers={"Cache-Control": "no-store"})


@router.get("/api/runs")
async def list_runs(request: Request) -> Response:
    return reply({"runs": await workspace(request).list_runs()})


@router.post("/api/runs")
async def launch(request: Request) -> Response:
    spec = await json_body(request)
    check_task_choices(spec)
    for key, what in (("run_id", "run id"), ("set_id", "set id")):
        if spec.get(key) is not None:
            body_id(spec[key], what)
    ws = workspace(request)
    return await idempotent(request, lambda: ws.launch(spec), required=True, status=201)


@router.get("/api/runs/{run_id}")
async def get_run(request: Request, run_id: str) -> Response:
    _ids(run_id)
    with refusals():
        return reply(await workspace(request).get_run(run_id))


@router.get("/api/jobs/{job_id}")
async def get_job(request: Request, job_id: str) -> Response:
    job = workspace(request).jobs.get(path_id(job_id, "job id"))
    if job is None:
        raise refuse(
            404, "That job is not known (any more): jobs are forgotten when the server restarts.", code="unknown_job"
        )
    return reply(job.to_dict())


# ---------------------------------------------------------------------------------------------
# run-level controls (harness: nothing here reaches the agent)


@router.post("/api/runs/{run_id}/stop")
async def stop_run(request: Request, run_id: str) -> Response:
    _ids(run_id)
    ws = workspace(request)

    async def work() -> dict[str, Any]:
        return {"ok": True, "run": await ws.stop_run(run_id)}

    return await idempotent(request, work)


@router.post("/api/runs/{run_id}/finalize_all")
async def finalize_all(request: Request, run_id: str) -> Response:
    _ids(run_id)
    ws = workspace(request)

    async def work() -> dict[str, Any]:
        return {"ok": True, "run": await ws.finalize_all(run_id)}

    return await idempotent(request, work)


@router.post("/api/runs/{run_id}/panoramas")
async def add_panoramas(request: Request, run_id: str) -> Response:
    _ids(run_id)
    body = await json_body(request)
    check_task_choices(body)
    if body.get("set_id") is not None:
        body_id(body["set_id"], "set id")
    ws = workspace(request)

    async def work() -> dict[str, Any]:
        return {"ok": True, **await ws.add_panoramas(run_id, body)}

    return await idempotent(request, work)


@router.post("/api/runs/{run_id}/export")
async def export(request: Request, run_id: str) -> Response:
    _ids(run_id)
    body = await json_body(request, optional=True)
    for key in ("embed_images", "force"):
        if body.get(key) is not None and not isinstance(body[key], bool):
            raise refuse(422, f"{key} must be true or false.", code="invalid_request")
    ws = workspace(request)

    async def work() -> dict[str, Any]:
        job = await ws.start_export(run_id, embed_images=body.get("embed_images"), force=body.get("force") is True)
        return {"job": job.to_dict()}

    return await idempotent(request, work)


@router.delete("/api/runs/{run_id}")
async def delete_run(request: Request, run_id: str) -> Response:
    _ids(run_id)
    body = await json_body(request, optional=True)
    with refusals():
        await workspace(request).delete_run(run_id, body.get("confirm"))
    return reply({"ok": True})


@router.patch("/api/runs/{run_id}/meta")
async def set_meta(request: Request, run_id: str) -> Response:
    _ids(run_id)
    body = await json_body(request)
    with refusals():
        return reply({"ok": True, "run": await workspace(request).set_meta(run_id, body)})


@router.put("/api/runs/{run_id}/stage_truth")
async def stage_truth(request: Request, run_id: str) -> Response:
    """Reveal truth on stage: a note in run.json, never an event, an export or a `pano` message."""
    _ids(run_id)
    body = await json_body(request)
    panorama_id = body_id(body.get("panorama_id"), "panorama id")
    with refusals():
        shown = await workspace(request).set_stage_truth(run_id, panorama_id, body.get("lat"), body.get("lng"))
    return reply({"ok": True, **shown})


# ---------------------------------------------------------------------------------------------
# one panorama, read-only


def _read_events(path: Path, after: int, full: bool, seq: int | None) -> list[dict[str, Any]] | None:
    """Blocking. Digests (or whole envelopes) from the log file; None when there is no file."""
    if not path.is_file():
        return None
    if not full:
        digests = digest_events(iter_events(path), 0 if seq is not None else after)
        return digests if seq is None else [digest for digest in digests if digest["seq"] == seq]
    # whole envelopes get the redaction their digests get: a tool error can quote a URL with a key
    return [
        redact_deep(envelope)
        for envelope in iter_events(path)
        if isinstance(envelope.get("seq"), int)
        and (envelope["seq"] == seq if seq is not None else envelope["seq"] > after)
    ]


@router.get("/api/runs/{run_id}/pano/{panorama_id}/events")
async def pano_events(
    request: Request, run_id: str, panorama_id: str, after: int = 0, full: bool = False, seq: int | None = None
) -> Response:
    """The reasoning stream's backlog. Read from the file in a thread, also for a live run: the
    session's own reader holds the log's lock, which would stall the agent writing to it."""
    _ids(run_id, panorama_id)
    ws = workspace(request)
    with refusals():
        events = await asyncio.to_thread(_read_events, ws.log_path(run_id, panorama_id), after, full, seq)
        if events is None:
            run = await ws.get_run(run_id)
            if not any(tile["panorama_id"] == panorama_id for tile in run["panoramas"]):
                raise KeyError(panorama_id)
            events = []  # queued: it has written nothing yet
    return reply({"run_id": run_id, "panorama_id": panorama_id, "events": events})


@router.get("/api/runs/{run_id}/pano/{panorama_id}/image")
async def pano_image(request: Request, run_id: str, panorama_id: str, w: str = "2048") -> FileResponse:
    _ids(run_id, panorama_id)
    with refusals():
        path, media_type = await asyncio.to_thread(workspace(request).pano_image, run_id, panorama_id, w)
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, max-age=3600"})


def _view_file(run_dir: Path, panorama_id: str, sha: str) -> tuple[Path, str] | None:
    """Blocking. A view the harness sent to the model, checked to be the image it claims to be."""
    try:
        path = confine(run_dir / panorama_id / "images" / f"{sha}.jpg", run_dir)
        with Image.open(path) as image:
            kind = image.format
            image.verify()
    except Exception:  # missing, outside the run, or not an image Pillow accepts
        return None
    return (path, _IMAGE_TYPES[kind]) if kind in _IMAGE_TYPES else None


@router.get("/api/runs/{run_id}/pano/{panorama_id}/views/{sha}")
async def pano_view(request: Request, run_id: str, panorama_id: str, sha: str) -> FileResponse:
    _ids(run_id, panorama_id)
    try:
        safe_sha(sha)
    except ValueError as exc:
        raise refuse(400, f"{exc}.", code="invalid_id") from exc
    with refusals():
        run_dir = workspace(request).run_dir(run_id)
    found = await asyncio.to_thread(_view_file, run_dir, panorama_id, sha)
    if found is None:
        raise refuse(404, "This run has no such view.", code="unknown_view")
    # named by its content, so it can never change
    headers = {"Cache-Control": "private, max-age=86400, immutable"}
    return FileResponse(found[0], media_type=found[1], headers=headers)


# ---------------------------------------------------------------------------------------------
# the three human controls (penalised; the session owns the ledger)


@router.post("/api/runs/{run_id}/pano/{panorama_id}/mcq/{mcq_id}/answer")
async def answer_mcq(request: Request, run_id: str, panorama_id: str, mcq_id: str) -> Response:
    _ids(run_id, panorama_id)
    body = await json_body(request)
    index = body.get("index")
    if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index <= 3:
        raise refuse(422, "index must be the number of one of the options (0 to 3).", code="invalid_index")
    ws = workspace(request)

    async def work() -> dict[str, Any]:
        session = _human_session(request, run_id, panorama_id)
        try:
            session.answer_mcq(mcq_id, index)
        except HumanChannelError as exc:
            raise refuse(
                409, f"The answer was not sent: {exc}. Nothing was charged for this click.", code="mcq_closed"
            ) from exc
        # the agent's side records the answer when it wakes; give it the turn so the tile shows it
        for _ in range(_MCQ_SETTLE_STEPS):
            if session.pending_mcq is None:
                break
            await asyncio.sleep(0)
        return {"ok": True, "tile": ws.tile(run_id, panorama_id)}

    return await idempotent(request, work, required=True)


@router.post("/api/runs/{run_id}/pano/{panorama_id}/cue/check")
async def check_cue(request: Request, run_id: str, panorama_id: str) -> Response:
    """The lint as a question. No penalty, no event, nothing queued, and no idempotency entry:
    a cue the operator typed and thought better of was never an interaction."""
    _ids(run_id, panorama_id)
    body = await json_body(request)
    with refusals():
        session = _human_session(request, run_id, panorama_id)
    return reply(session.check_cue(body.get("text")))


@router.post("/api/runs/{run_id}/pano/{panorama_id}/cue")
async def send_cue(request: Request, run_id: str, panorama_id: str) -> Response:
    _ids(run_id, panorama_id)
    body = await json_body(request)
    text = body.get("text")
    if not isinstance(text, str):
        raise refuse(422, "text must be the cue to send.", code="invalid_cue")
    _confirmed(body, "a cue costs x0.8")
    ws = workspace(request)

    async def work() -> dict[str, Any]:
        session = _human_session(request, run_id, panorama_id)
        try:
            result = session.submit_cue(text, confirmed=True)
        except HumanChannelError as exc:
            # nothing was charged or queued, so the pure check now gives the same verdict, with
            # the words the lint objected to
            verdict = session.check_cue(text)
            reason = verdict["reason"]
            raise refuse(
                _CUE_STATUS.get(reason, 422),
                f"The cue was not sent and nothing was charged: {exc}.",
                code=f"cue_{reason or 'refused'}",
                problems=verdict["problems"] or None,
                lint=exc.lint,
                matches=verdict["matches"],
            ) from exc
        return {"ok": True, "result": result, "tile": ws.tile(run_id, panorama_id)}

    return await idempotent(request, work, required=True)


@router.post("/api/runs/{run_id}/pano/{panorama_id}/geocode")
async def geocode(request: Request, run_id: str, panorama_id: str) -> Response:
    _ids(run_id, panorama_id)
    body = await json_body(request)
    lat, lng = _number(body, "lat", 90.0), _number(body, "lng", 180.0)
    place_label = body.get("place_label")
    if not isinstance(place_label, str):
        raise refuse(422, "place_label must be one of the places the agent named.", code="invalid_place")
    _confirmed(body, "a human geocode costs x0.5 and ends this panorama")
    ws = workspace(request)

    async def work() -> dict[str, Any]:
        session = _human_session(request, run_id, panorama_id)
        if place_label not in session.named_places:
            raise refuse(
                409,
                "A geocode is only allowed for a place the agent has named: choose one from its list.",
                code="place_not_named",
            )
        try:
            session.human_geocode(lat, lng, place_label)
        except HumanChannelError as exc:
            raise refuse(
                409, f"The geocode was not recorded and nothing was charged: {exc}.", code="geocode_refused"
            ) from exc
        # The human point is final at once: stop the conversation and make the files follow.
        await ws.settle(run_id, panorama_id)
        return {"ok": True, "tile": ws.tile(run_id, panorama_id)}

    return await idempotent(request, work, required=True)


# ---------------------------------------------------------------------------------------------
# harness controls on one panorama (no information reaches the agent)


@router.post("/api/runs/{run_id}/pano/{panorama_id}/mcq_allowed")
async def set_mcq_allowed(request: Request, run_id: str, panorama_id: str) -> Response:
    _ids(run_id, panorama_id)
    body = await json_body(request)
    allowed = body.get("allowed")
    if not isinstance(allowed, bool):
        raise refuse(422, "allowed must be true or false.", code="invalid_request")
    ws = workspace(request)

    async def work() -> dict[str, Any]:
        session = _human_session(request, run_id, panorama_id)
        if session.mcq_allowed != allowed:  # the log records a change, not a click
            session.set_mcq_allowed(allowed)
        return {"ok": True, "tile": ws.tile(run_id, panorama_id)}

    return await idempotent(request, work)


@router.post("/api/runs/{run_id}/pano/{panorama_id}/finalize")
async def finalize(request: Request, run_id: str, panorama_id: str) -> Response:
    _ids(run_id, panorama_id)
    ws = workspace(request)

    async def work() -> dict[str, Any]:
        _session(request, run_id, panorama_id)
        return {"ok": True, "tile": await ws.finalize(run_id, panorama_id)}

    return await idempotent(request, work)


@router.post("/api/runs/{run_id}/pano/{panorama_id}/retry")
async def retry(request: Request, run_id: str, panorama_id: str) -> Response:
    _ids(run_id, panorama_id)
    ws = workspace(request)

    async def work() -> dict[str, Any]:
        return {"ok": True, "tile": await ws.retry(run_id, panorama_id)}

    return await idempotent(request, work)


@router.post("/api/runs/{run_id}/pano/{panorama_id}/ack")
async def ack(request: Request, run_id: str, panorama_id: str) -> Response:
    """The operator has seen a fallback answer: a note in run.json, not an event."""
    _ids(run_id, panorama_id)
    body = await json_body(request)
    ws = workspace(request)

    async def work() -> dict[str, Any]:
        return {"ok": True, "tile": await ws.ack(run_id, panorama_id, body.get("kind"))}

    return await idempotent(request, work)
