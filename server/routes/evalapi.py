"""Evaluation routes of the console (contract 4.6): the set, its build job, eval runs, results,
rescore, compare and ground truth. The work is in server/evalops.py; a route reads the request
and keeps blocking work off the loop.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response

from .. import evalops
from ..security import safe_tag
from ..sets import ConsoleError
from . import idempotent, json_body, path_id, refuse, refusals, reply, workspace

router = APIRouter()


def _tag(request: Request) -> str:
    """`?tag=` of a results or truth request; absent or empty is the run's own results."""
    tag = request.query_params.get("tag") or ""
    try:
        return safe_tag(tag) if tag else ""
    except ValueError as exc:
        raise refuse(400, f"{exc}.", code="invalid_tag") from exc


# ---------------------------------------------------------------------------------------------
# the set


@router.get("/api/eval/set")
async def eval_set(request: Request) -> Response:
    ws = workspace(request)
    state = await asyncio.to_thread(evalops.set_state, ws.eval_data_dir)
    job = evalops.build_job(ws)
    last = ws.jobs.find(evalops.BUILD_KIND)
    return reply(
        {
            **state,
            # presence only: no endpoint returns a stored key
            "mapillary_token": bool(os.environ.get("MAPILLARY_TOKEN")),
            "build_job_id": job.id if job is not None else None,
            "last_build_job_id": last.id if last is not None else None,
        }
    )


@router.post("/api/eval/set/build")
async def build_eval_set(request: Request) -> Response:
    ws = workspace(request)
    body = await json_body(request, optional=True)

    async def work() -> dict[str, Any]:
        return {"job": evalops.start_build(ws, body).to_dict()}

    return await idempotent(request, work)


@router.patch("/api/eval/set/{panorama_id}")
async def label_eval_panorama(request: Request, panorama_id: str) -> Response:
    ws = workspace(request)
    pid = path_id(panorama_id, "panorama id")
    body = await json_body(request)
    with refusals():
        if set(body) != {"label"}:
            raise ConsoleError(422, "Send exactly one field: label.", code="invalid_request")
        evalops.refuse_during_build(ws, "Label")
        frozen = bool(evalops.active_eval_runs(ws))
        changed = await asyncio.to_thread(evalops.set_label, ws.eval_data_dir, pid, body["label"], frozen=frozen)
    return reply({"ok": True, **changed})


@router.get("/api/eval/set/{panorama_id}/image")
async def eval_panorama_image(request: Request, panorama_id: str) -> FileResponse:
    ws = workspace(request)
    pid = path_id(panorama_id, "panorama id")
    width = request.query_params.get("w", "1024")
    with refusals():
        path, media_type = await asyncio.to_thread(
            evalops.set_image, ws.eval_data_dir, ws.data_dir / "cache" / "eval", pid, width
        )
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, max-age=3600"})


# ---------------------------------------------------------------------------------------------
# runs


@router.post("/api/eval/runs")
async def launch_eval_run(request: Request) -> Response:
    ws = workspace(request)
    body = await json_body(request, optional=True)
    return await idempotent(request, lambda: evalops.launch(ws, body), required=True, status=201)


@router.post("/api/eval/runs/estimate")
async def estimate_eval_run(request: Request) -> Response:
    body = await json_body(request, optional=True)
    with refusals():
        return reply(await evalops.estimate(workspace(request), body))


@router.get("/api/runs/{run_id}/results")
async def run_results(request: Request, run_id: str) -> Response:
    ws = workspace(request)
    run_id, tag = path_id(run_id, "run id"), _tag(request)
    with refusals():
        run_dir, _ = await evalops.gated(ws, run_id)
        return reply(await asyncio.to_thread(evalops.results, run_dir, tag))


@router.post("/api/runs/{run_id}/rescore")
async def rescore_run(request: Request, run_id: str) -> Response:
    ws = workspace(request)
    run_id = path_id(run_id, "run id")
    body = await json_body(request, optional=True)

    async def work() -> dict[str, Any]:
        # the gate first: a run that may not be scored answers 403 whatever the body says
        run_dir, meta = await evalops.gated(ws, run_id, settled=True)
        hedge, duplicates, tag = evalops.rescore_options(body)
        manifest = evalops.manifest_of(run_dir, meta, ws.eval_data_dir / evalops.MANIFEST_NAME)
        result = await asyncio.to_thread(
            evalops.rescore,
            run_dir,
            manifest,
            hedge=hedge,
            duplicates=duplicates,
            tag=tag,
            meta=meta,
            run_config=ws.eval_config(meta),
        )
        await ws.refresh_results(run_id)
        return result

    return await idempotent(request, work)


@router.get("/api/eval/compare")
async def compare_runs(request: Request) -> Response:
    ws = workspace(request)
    try:
        refs = [evalops.split_ref(request.query_params.get(name)) for name in ("a", "b")]
    except ValueError as exc:
        raise refuse(400, f"{exc}.", code="invalid_ref") from exc
    with refusals():
        sides = []
        for run_id, tag in refs:
            run_dir, meta = await evalops.gated(ws, run_id)  # both sides: neither may leak a score
            sides.append((run_dir, tag, meta))
        return reply(await asyncio.to_thread(evalops.compare, *sides))


@router.get("/api/eval/runs/{run_id}/truth")
async def run_truth(request: Request, run_id: str) -> Response:
    ws = workspace(request)
    run_id, tag = path_id(run_id, "run id"), _tag(request)
    with refusals():
        run_dir, meta = await evalops.gated(ws, run_id)
        manifest = evalops.manifest_of(run_dir, meta, ws.eval_data_dir / evalops.MANIFEST_NAME)
        return reply(await asyncio.to_thread(evalops.truth, run_dir, manifest, tag))
