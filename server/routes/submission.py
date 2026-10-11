"""Submission: the checklist of UI-SPEC 5.8, the zip that is handed in, and its files one by one.

Read-only, for a run this server holds and for one found on disk alike. The run's state is taken
on the loop thread; reading logs and exports and packing the zip happen in a worker thread.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from ..sets import ConsoleError
from ..validation import media_type, submission_file, submission_zip, validate_run

router = APIRouter()

_ON = frozenset({"1", "true", "yes", "on"})


def _refusal(status: int, message: str, code: str) -> HTTPException:
    return HTTPException(status, {"message": message, "code": code, "action": None, "problems": None})


def _flag(request: Request, name: str) -> bool:
    return request.query_params.get(name, "").strip().lower() in _ON


async def _run(request: Request, run_id: str) -> tuple[dict[str, Any], Path]:
    """(RunState, run directory) of the run a request names, live or on disk."""
    workspace = request.app.state.workspace
    try:
        return await workspace.get_run(run_id), workspace.run_dir(run_id)
    except ValueError as exc:  # not a name a run can have: nothing was looked up
        raise _refusal(400, str(exc), "invalid_run_id") from exc
    except KeyError:
        message = f"There is no run {run_id}. It may have been deleted; see the Runs list."
        raise _refusal(404, message, "unknown_run") from None


def _attachment(data: bytes, filename: str, content_type: str) -> Response:
    # `filename` is built from an allow-listed name or a checked run id, never from the request as sent
    headers = {"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"}
    return Response(data, media_type=content_type, headers=headers)


@router.get("/api/runs/{run_id}/validation")
async def validation(run_id: str, request: Request) -> dict[str, Any]:
    run, run_dir = await _run(request, run_id)
    return await asyncio.to_thread(validate_run, run_dir, run)


@router.get("/api/runs/{run_id}/download")
async def download(run_id: str, request: Request) -> Response:
    """The submission zip. 409 while a check fails (`?force=1` takes the files as they are) and
    for a run of the scripted model (`?fake_ok=1`)."""
    run, run_dir = await _run(request, run_id)
    try:
        data = await asyncio.to_thread(
            submission_zip, run_dir, run, force=_flag(request, "force"), fake_ok=_flag(request, "fake_ok")
        )
    except ConsoleError as exc:
        raise HTTPException(exc.status, exc.detail()) from exc
    return _attachment(data, f"{run['run_id']}_submission.zip", "application/zip")


@router.get("/api/runs/{run_id}/files/{name}")
async def submission_file_download(run_id: str, name: str, request: Request) -> Response:
    """One file of the submission. `name` is looked up among the run's own files, never opened
    as a path."""
    run, run_dir = await _run(request, run_id)
    panorama_ids = [tile.get("panorama_id") for tile in run.get("panoramas") or []]

    def read() -> bytes:
        return submission_file(run_dir, name, panorama_ids).read_bytes()

    try:
        data = await asyncio.to_thread(read)
    except PermissionError as exc:
        raise _refusal(403, f"{name} of run {run_id} is not a file of the run itself.", "not_a_run_file") from exc
    except (KeyError, OSError):
        raise _refusal(
            404,
            f"Run {run_id} has no submission file of that name. Its files are listed on the Submission screen; "
            "rebuild the exports if one is missing.",
            "unknown_file",
        ) from None
    return _attachment(data, name, media_type(name))
