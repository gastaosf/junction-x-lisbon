"""Replay, inspectors and per-panorama downloads (contract 4.4).

Read-only: these routes never build a session on a log and never change a live one. A panorama is
read from its JSONL file in a worker thread whether this process is running it or it only exists
on disk; only the tile of "now" (`replay` without `at`) is the workspace's own, so it is the tile
the dashboard shows. Nothing here is derived from ground truth: every route serves every run.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from astrolabio.config import Settings

from .. import inspect as inspector
from ..security import confine
from ..sets import ConsoleError
from ..workspace import Workspace, read_meta
from . import path_id, refuse, reply, workspace

router = APIRouter()

DOWNLOADS = ("export", "events", "images")


@dataclass
class _Panorama:
    """Where one panorama's files are and what its run knows about it."""

    run_id: str
    panorama_id: str
    run_dir: Path
    log_path: Path
    task: Any  # the live PanoramaTask, else the run.json row, else None
    settings: Settings | None
    live_budget: bool
    acks: tuple[str, ...]
    live: bool  # a session of this process is running it

    @property
    def image_dir(self) -> Path:
        return self.run_dir / self.panorama_id / "images"


def _read_run(ws: Workspace, run_dir: Path, panorama_id: str) -> tuple[Any, Settings | None, bool, tuple[str, ...]]:
    """Blocking. What run.json says about a panorama of a run this process does not hold."""
    meta = read_meta(run_dir) or {}
    rows = [row for row in meta.get("tasks") or [] if isinstance(row, dict)]
    task = next((row for row in rows if row.get("panorama_id") == panorama_id), None)
    acks = (meta.get("acks") or {}).get(panorama_id) or ()
    return task, ws.frozen_settings(meta), bool(meta.get("live_budget")), tuple(acks)


async def _panorama(request: Request, run_id: str, panorama_id: str) -> _Panorama:
    ws: Workspace = workspace(request)
    run_id, panorama_id = path_id(run_id, "run id"), path_id(panorama_id, "panorama id")
    try:
        run_dir = ws.run_dir(run_id)
        log_path = confine(ws.log_path(run_id, panorama_id), run_dir, strict=False)
    except KeyError:
        raise refuse(404, f"There is no run {run_id}.", code="unknown_run") from None
    except PermissionError as exc:
        raise refuse(403, f"The files of {panorama_id} lie outside run {run_id}.", code="forbidden_path") from exc
    handle = ws.owned(run_id)
    session = handle.manager.sessions.get(panorama_id) if handle is not None else None
    if handle is not None and session is not None:
        task, settings, live_budget = session.task, handle.settings, bool(handle.manager.live)
        acks = tuple((handle.meta.get("acks") or {}).get(panorama_id) or ())
    else:
        task, settings, live_budget, acks = await asyncio.to_thread(_read_run, ws, run_dir, panorama_id)
    if task is None and not await asyncio.to_thread(log_path.is_file):
        raise refuse(404, f"Run {run_id} has no panorama {panorama_id}.", code="unknown_panorama")
    return _Panorama(run_id, panorama_id, run_dir, log_path, task, settings, live_budget, acks, session is not None)


def _attachment(content: bytes, media_type: str, filename: str) -> Response:
    # the file name is built from ids that passed safe_id, so it needs no quoting
    headers = {"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"}
    return Response(content, media_type=media_type, headers=headers)


async def _current_tile(ws: Workspace, pano: _Panorama) -> dict[str, Any] | None:
    """The tile exactly as the run shows it now: the live one, else the one its files give."""
    try:
        if pano.live:
            return ws.tile(pano.run_id, pano.panorama_id)
        run = await ws.get_run(pano.run_id)
    except (KeyError, ConsoleError):
        return None  # replaced or removed between the two looks: the log still answers
    return next((tile for tile in run.get("panoramas") or [] if tile["panorama_id"] == pano.panorama_id), None)


@router.get("/api/runs/{run_id}/pano/{panorama_id}/replay")
async def replay(request: Request, run_id: str, panorama_id: str, at: str | None = None) -> Response:
    """The TileState as it stood at event `at`; without `at`, as it is now."""
    pano = await _panorama(request, run_id, panorama_id)
    seq: int | None = None
    if at:
        try:
            seq = int(at)
        except ValueError:
            seq = -1
        if seq < 0:
            raise refuse(422, "at must be the seq of an event: a whole number, 0 or above.", code="invalid_at")
    if seq is None:
        current = await _current_tile(workspace(request), pano)
        if current is not None:
            return reply(current)
    tile = await asyncio.to_thread(
        inspector.replay_tile,
        pano.log_path,
        run_id=pano.run_id,
        panorama_id=pano.panorama_id,
        at=seq,
        task=pano.task,
        settings=pano.settings,
        live_budget=pano.live_budget,
        acks=pano.acks,
    )
    return reply(tile)


@router.get("/api/runs/{run_id}/pano/{panorama_id}/inspect")
async def inspect(request: Request, run_id: str, panorama_id: str) -> Response:
    pano = await _panorama(request, run_id, panorama_id)
    payload = await asyncio.to_thread(
        inspector.inspect_log,
        pano.log_path,
        run_id=pano.run_id,
        panorama_id=pano.panorama_id,
        image_dir=pano.image_dir,
        task=pano.task,
    )
    return reply(payload)


async def _export_bytes(ws: Workspace, pano: _Panorama) -> bytes:
    """The export file of one panorama. For a run of this process it is rewritten first when it
    is missing or behind the log, so the file downloaded is the one the page shows; a run on disk
    is only ever read (finishing its logs is the Rebuild job's business)."""
    path = pano.run_dir / f"{pano.panorama_id}.json"
    handle = ws.owned(pano.run_id)
    fold = handle.folds.get(pano.panorama_id) if handle is not None else None
    if handle is not None and fold is not None and fold.last_seq:
        if handle.export["seqs"].get(pano.panorama_id) != fold.last_seq or not await asyncio.to_thread(path.is_file):
            try:
                await ws.export_now(pano.run_id)
            except Exception:  # whatever is on disk is still the answer below
                pass
    try:
        return await asyncio.to_thread(confine(path, pano.run_dir).read_bytes)
    except OSError:  # missing, or (PermissionError) a link that leaves the run
        raise refuse(
            404,
            f"No export has been written for {pano.panorama_id} yet. Use Rebuild exports on run {pano.run_id}, "
            "then download again.",
            code="no_export",
            action="rebuild",
        ) from None


@router.get("/api/runs/{run_id}/pano/{panorama_id}/download")
async def download(request: Request, run_id: str, panorama_id: str, what: str = "export") -> Response:
    pano = await _panorama(request, run_id, panorama_id)
    if what not in DOWNLOADS:
        raise refuse(422, f"what must be one of: {', '.join(DOWNLOADS)}.", code="invalid_download")
    if what == "export":
        content = await _export_bytes(workspace(request), pano)
        return _attachment(content, "application/json", f"{pano.panorama_id}.json")
    if what == "events":
        try:
            content = await asyncio.to_thread(inspector.events_bytes, pano.log_path)
        except OSError:
            raise refuse(404, f"{pano.panorama_id} has not written an event log yet.", code="no_events") from None
        return _attachment(content, "application/x-ndjson", f"{pano.panorama_id}.events.jsonl")
    archive = await asyncio.to_thread(inspector.images_zip, pano.image_dir)
    if archive is None:
        raise refuse(404, f"Run {pano.run_id} saved no images for {pano.panorama_id}.", code="no_images")
    return _attachment(archive, "application/zip", f"{pano.run_id}_{pano.panorama_id}_images.zip")
