"""Panorama sets: uploads, path sets, the preflight verdict, thumbnails and the directory browser.

Uploads are raw request bodies stored byte for byte (no multipart parser in the dependencies);
the set store does the checking, hashing and unzipping, all of it blocking, so it runs in a
worker thread. The directory browser lists names inside the allowed roots and nothing else: it
never serves a file.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response

from astrolabio.runner import IMAGE_SUFFIXES

from ..security import confine
from ..sets import MAX_UPLOAD_BYTES
from . import (
    body_id,
    check_task_choices,
    idempotent,
    json_body,
    lan_enabled,
    path_id,
    refusals,
    refuse,
    reply,
    workspace,
)

router = APIRouter()

MAX_ENTRIES = 1000  # of one directory listing
_COUNT_LIMIT = 5000  # directory entries looked at to count a folder's images


def _no_lan(request: Request, what: str) -> None:
    """A second laptop on the network may upload, but not read this machine's disk."""
    if lan_enabled(request):
        raise refuse(
            403,
            f"{what} is switched off while LAN access is on. Upload the files instead, or use the browser on "
            "the server itself with LAN access off.",
            code="lan_restricted",
        )


# ---------------------------------------------------------------------------------------------
# sets


@router.get("/api/sets")
async def list_sets(request: Request) -> Response:
    return reply({"sets": await asyncio.to_thread(workspace(request).sets.list)})


@router.post("/api/sets")
async def create_set(request: Request) -> Response:
    """`{name?}` makes an empty upload set; `{path, name?}` a reference to a directory on this
    machine (nothing is copied; the path must lie inside an allowed root)."""
    body = await json_body(request, optional=True)
    path, name = body.get("path"), body.get("name")
    if path is not None:
        _no_lan(request, "Reading a path on the server")
        if not isinstance(path, str) or not path.strip() or "\x00" in path:
            raise refuse(422, "path must be a directory (or one image) on the server.", code="invalid_path")
    sets = workspace(request).sets

    async def work() -> dict[str, Any]:
        if path is None:
            return await asyncio.to_thread(sets.create, name)
        return await asyncio.to_thread(lambda: sets.create_path(path, name=name))

    return await idempotent(request, work)


@router.put("/api/sets/{set_id}/files")
async def upload_file(request: Request, set_id: str, path: str | None = None) -> Response:
    """One file, as the raw request body, at `?path=<relative path>`; a .zip is unpacked."""
    path_id(set_id, "set id")
    if not path:
        raise refuse(
            422, "Say where the file goes: ?path=<its relative path, as it was dropped>.", code="path_required"
        )
    too_large = refuse(413, "The file is larger than 200 MB. Split the set, or zip fewer files.", code="file_too_large")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
        raise too_large
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        # counted as it arrives: a declared length is not to be believed, and may be absent
        size += len(chunk)
        if size > MAX_UPLOAD_BYTES:
            raise too_large
        chunks.append(chunk)
    with refusals():
        stored = await asyncio.to_thread(workspace(request).sets.add_file, set_id, path, b"".join(chunks))
    return reply({"ok": True, **stored})


def _preflight_body(body: dict[str, Any]) -> dict[str, Any]:
    check_task_choices(body)
    for key in ("run_id", "launch_run_id"):
        if body.get(key) is not None:
            body_id(body[key], "run id")
    return body


@router.get("/api/sets/{set_id}")
async def get_set(
    request: Request, set_id: str, overrides: str | None = None, special: str | None = None, run_id: str | None = None
) -> Response:
    """The set as a launch would read it. `overrides=<json>&special=<id>` previews the operator's
    choices; `run_id=` shows the ids the panoramas would get when added to that run."""
    path_id(set_id, "set id")
    try:
        chosen = json.loads(overrides) if overrides else None
    except ValueError as exc:
        raise refuse(422, "overrides must be a JSON object.", code="invalid_override") from exc
    body = _preflight_body({"overrides": chosen, "special": special or None, "run_id": run_id or None})
    with refusals():
        return reply(await workspace(request).preflight(set_id, body))


@router.post("/api/sets/{set_id}/preflight")
async def preflight(request: Request, set_id: str) -> Response:
    """The verdict for exactly these inputs: rows, budgets, what blocks the launch, the cost
    ceiling. Changes nothing, so it takes no idempotency key and can be asked on every edit."""
    path_id(set_id, "set id")
    body = _preflight_body(await json_body(request, optional=True))
    with refusals():
        return reply(await workspace(request).preflight(set_id, body))


@router.get("/api/sets/{set_id}/image/{key:path}")
async def set_image(request: Request, set_id: str, key: str, w: str = "1024") -> FileResponse:
    """A panorama of the set by the id the preflight shows (or its relative path, which is looked
    up among the set's rows and never joined to a directory)."""
    path_id(set_id, "set id")
    with refusals():
        path, media_type = await asyncio.to_thread(workspace(request).sets.image, set_id, key, w)
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, max-age=3600"})


@router.delete("/api/sets/{set_id}")
async def delete_set(request: Request, set_id: str) -> Response:
    path_id(set_id, "set id")
    with refusals():
        await asyncio.to_thread(workspace(request).sets.delete, set_id)
    return reply({"ok": True})


# ---------------------------------------------------------------------------------------------
# directory browser


def _image_count(directory: Path) -> int:
    """Images in a folder and in the folders directly inside it (Urban/, non-Urban/)."""
    count = seen = 0
    pending = [(directory, True)]
    while pending:
        folder, descend = pending.pop()
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    seen += 1
                    if seen > _COUNT_LIMIT:
                        return count
                    if entry.name.startswith("."):
                        continue
                    if Path(entry.name).suffix.lower() in IMAGE_SUFFIXES:
                        count += 1
                    elif descend and entry.is_dir(follow_symlinks=False):
                        pending.append((Path(entry.path), False))
        except OSError:
            continue
    return count


def _browse(roots: list[Path], raw: str | None) -> dict[str, Any]:
    """Blocking. Names only; dot-entries and anything that resolves outside the roots are left out."""
    shown = [str(root) for root in roots]
    if not raw:
        entries = [{"name": str(root), "path": str(root), "dir": True, "images": _image_count(root)} for root in roots]
        return {"path": None, "parent": None, "roots": shown, "entries": entries}
    directory = confine(raw, roots)
    if not directory.is_dir():
        raise refuse(422, "That path is a file: choose the folder that holds the panoramas.", code="not_a_directory")
    entries = []
    try:
        names = sorted(os.listdir(directory), key=str.casefold)
    except OSError as exc:
        raise refuse(403, "That folder cannot be read by the server.", code="unreadable") from exc
    for name in names:
        if name.startswith("."):
            continue
        try:
            child = confine(directory / name, roots)  # a link that leaves the roots is not listed
        except (PermissionError, OSError):
            continue
        if child.is_dir():
            entries.append({"name": name, "path": str(child), "dir": True, "images": _image_count(child)})
        elif child.suffix.lower() in IMAGE_SUFFIXES:
            entries.append({"name": name, "path": str(child), "dir": False, "images": 1})
        if len(entries) >= MAX_ENTRIES:
            break
    entries.sort(key=lambda entry: (not entry["dir"], entry["name"].casefold()))
    inside = any(directory != root and directory.is_relative_to(root) for root in roots)
    parent = str(directory.parent) if inside else None  # above a root there is only the list of roots
    return {"path": str(directory), "parent": parent, "roots": shown, "entries": entries}


@router.get("/api/fs")
async def browse(request: Request, path: str | None = None) -> Response:
    _no_lan(request, "The directory browser")
    roots = workspace(request).store.allowed_roots()
    with refusals():
        return reply(await asyncio.to_thread(_browse, roots, path))
