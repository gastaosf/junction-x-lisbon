"""SetStore: the panorama sets a run is launched from, and the preflight verdict on one.

An upload set is a directory under `<data_dir>/sets/<set_id>/files/` holding the dropped files
byte for byte, with `set.json` beside it recording each file's sha256. A path set is only a
reference to a directory on this machine (a USB stick, a downloads folder). Both are read by
`runner.load_tasks_detailed`, so the console parses labels, timestamps and the Special One flag
exactly as the CLI does.

Everything here blocks (hashing, Pillow, zip extraction): call it from a worker thread.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import secrets
import shutil
import threading
import zipfile
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image

from astrolabio.config import Settings
from astrolabio.runner import (
    IMAGE_SUFFIXES,
    MANIFEST_SUFFIXES,
    Preflight,
    PreflightRow,
    _panorama_id,
    load_tasks_detailed,
)
from astrolabio.schema import Label, PanoramaTask

from .security import confine, safe_id
from .store import ConsoleStore
from .words import count, plural

SET_FILE = "set.json"
FILES_DIR = "files"
ARCHIVE_SUFFIX = ".zip"
ACCEPTED_SUFFIXES = IMAGE_SUFFIXES | MANIFEST_SUFFIXES
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
MAX_ZIP_ENTRIES = 500
MAX_ZIP_BYTES = 2 * 1024**3
MAX_PATH_COMPONENTS = 4
MAX_NAME_CHARS = 80
EXPECTED_SIZE = (6080, 3040)  # the organisers' panoramas (SPEC 2)
SIZE_TOLERANCE = 0.2
IMAGE_WIDTHS = (320, 1024, 2048, 4096)
_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png"}
_CHUNK = 1024 * 1024
# What only one preset demands: exactly one Special One.
SPECIAL_REQUIRED_PRESETS = frozenset({"scoring"})
# A panorama's export is `<id>.json` in the run directory, where the console keeps run.json and
# the evaluation its results.json and results.<tag>.json (any case: the venue laptop's disk folds it).
_RESERVED_ID_RE = re.compile(r"^(?:run|results(?:\..+)?)$", re.IGNORECASE)


class ConsoleError(Exception):
    """A refusal the route layer answers as it stands: `status` is the HTTP status and `detail()`
    the body of contract section 4 (`message` says what happened and what to do next)."""

    def __init__(
        self,
        status: int,
        message: str,
        *,
        code: str | None = None,
        action: str | None = None,
        problems: list[Any] | None = None,
        **extra: Any,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code
        self.action = action
        self.problems = problems
        self.extra = extra

    def detail(self) -> dict[str, Any]:
        return {
            "message": self.message,
            "code": self.code,
            "action": self.action,
            "problems": self.problems,
            **self.extra,
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _image_format(source: Path | bytes) -> str | None:
    """"JPEG" or "PNG" when Pillow can open and verify the image, else None."""
    try:
        with Image.open(io.BytesIO(source) if isinstance(source, bytes) else source) as image:
            kind = image.format
            image.verify()
    except Exception:  # Pillow raises many types for a damaged or disguised file
        return None
    return kind if kind in _FORMATS else None


def _holds_truth(data: bytes) -> bool:
    """True for a manifest whose entries carry lat and lng: evaluation ground truth. A set that
    an assisted run could be launched from must never sit beside it."""
    try:
        doc = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        return False
    if isinstance(doc, dict):
        lists = [value for value in doc.values() if isinstance(value, list)]
        records = lists[0] if lists else list(doc.values())
    else:
        records = doc if isinstance(doc, list) else []
    return any(
        isinstance(record, dict) and {"lat", "lng"} <= {str(key).lower() for key in record} for record in records
    )


def preview_image(src: Path, cache_dir: Path, width: int | str | None) -> tuple[Path, str]:
    """(file to send, media type) for a panorama at about `width` pixels, or the original for
    "full". Never the stored bytes unchecked: a preview is re-encoded and the original is
    verified with Pillow first, so nothing but a JPEG or PNG is ever served from an upload."""
    src = Path(src)
    try:
        stat = src.stat()
    except OSError as exc:
        raise ConsoleError(404, "The image file is no longer there.", code="image_missing") from exc
    if width in (None, "", "full"):
        kind = _image_format(src)
        if kind is None:
            raise ConsoleError(404, "This file is not a readable JPEG or PNG image.", code="image_unreadable")
        return src, _FORMATS[kind]
    try:
        wanted = int(width)
    except (TypeError, ValueError):
        raise ConsoleError(400, "w must be a width in pixels or 'full'.", code="invalid_width") from None
    wanted = min(IMAGE_WIDTHS, key=lambda choice: abs(choice - wanted))
    key = hashlib.sha256(f"{src.resolve()}|{stat.st_mtime_ns}|{stat.st_size}".encode()).hexdigest()[:24]
    out = Path(cache_dir) / f"{key}_{wanted}.jpg"
    if out.is_file():
        return out, "image/jpeg"
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{secrets.token_hex(8)}.tmp")
    try:
        with Image.open(src) as image:
            image.draft("RGB", (wanted, wanted // 2))
            preview = image.convert("RGB")
            preview.thumbnail((wanted, wanted), Image.Resampling.LANCZOS)
            preview.save(tmp, "JPEG", quality=85)
        os.replace(tmp, out)
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        raise ConsoleError(404, "This file is not a readable JPEG or PNG image.", code="image_unreadable") from exc
    return out, "image/jpeg"


def _upload_path(raw: Any, *, archive_member: bool = False) -> PurePosixPath | None:
    """The relative path a file may be stored at; None for one that is skipped (the caller lists
    it as ignored); ConsoleError for a path that is not acceptable. Inside an archive nothing is
    an error: a member that does not fit is skipped."""

    def refuse(message: str, code: str) -> None:
        if not archive_member:
            raise ConsoleError(422, message, code=code)

    if not isinstance(raw, str) or not raw or "\x00" in raw or "\\" in raw or raw.startswith("/"):
        refuse("path must be a relative file path with '/' separators.", "invalid_path")
        return None
    parts = raw.split("/")
    # a drive letter is an absolute path on the machine that made the archive
    if any(part in {"", ".", ".."} for part in parts) or ":" in parts[0]:
        refuse("path must not contain empty, '.' or '..' components.", "invalid_path")
        return None
    if any(part.startswith(".") or part == "__MACOSX" for part in parts):
        return None  # dot-files and macOS resource forks, as runner._is_panorama_file ignores them
    if len(parts) > MAX_PATH_COMPONENTS:
        refuse(f"path may have at most {MAX_PATH_COMPONENTS} components.", "invalid_path")
        return None
    path = PurePosixPath(*parts)
    accepted = ACCEPTED_SUFFIXES if archive_member else ACCEPTED_SUFFIXES | {ARCHIVE_SUFFIX}
    if path.suffix.lower() not in accepted:
        refuse(
            f"{path.name}: only {', '.join(sorted(ACCEPTED_SUFFIXES))} files and .zip archives are accepted.",
            "unsupported_file",
        )
        return None
    return path


class SetStore:
    """Upload sets and path sets under `<data_dir>/sets`, and what a launch would make of one.

    `store` supplies the allowed roots for path sets. `references(set_id)` is set by the
    workspace: (run ids whose directory references the set, those of them that are active)."""

    def __init__(self, data_dir: str | Path, store: ConsoleStore, *, eval_data_dir: str | Path | None = None) -> None:
        self.data_dir = Path(data_dir)
        self.root = self.data_dir / "sets"
        self.cache_dir = self.data_dir / "cache" / "sets"
        self.store = store
        self.eval_data_dir = Path(eval_data_dir) if eval_data_dir is not None else None
        self.references: Callable[[str], tuple[list[str], list[str]]] = lambda set_id: ([], [])
        self._lock = threading.RLock()
        self._file_info: dict[str, tuple[int, int, dict[str, Any]]] = {}

    # ------------------------------------------------------------------ set.json

    def _dir(self, set_id: str) -> Path:
        return confine(self.root / safe_id(set_id, "set id"), self.root, strict=False)

    def get(self, set_id: str) -> dict[str, Any]:
        """The set's record. KeyError for an unknown set, ValueError for an unsafe id."""
        path = self._dir(set_id) / SET_FILE
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise KeyError(set_id) from None
        if not isinstance(meta, dict):
            raise KeyError(set_id)
        return meta

    def _save(self, meta: dict[str, Any]) -> None:
        directory = self._dir(meta["set_id"])
        directory.mkdir(parents=True, exist_ok=True)
        tmp = directory / f".{SET_FILE}.{os.getpid()}.{threading.get_ident()}.tmp"
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, directory / SET_FILE)

    def _new(self, kind: str, name: Any, fallback: str, **fields: Any) -> dict[str, Any]:
        if name is not None and not isinstance(name, str):
            raise ConsoleError(422, "name must be text.", code="invalid_name")
        set_id = f"set-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{secrets.token_hex(3)}"
        meta = {
            "set_id": set_id,
            "name": ((name or "").strip() or fallback)[:MAX_NAME_CHARS],
            "kind": kind,
            "path": None,
            "created_at": _now(),
            "files": {},
            "ignored": [],
            **fields,
        }
        with self._lock:
            self._save(meta)
        return meta

    def create(self, name: str | None = None) -> dict[str, Any]:
        """An empty upload set."""
        return self._summary(self._new("upload", name, f"Upload {datetime.now():%Y-%m-%d %H:%M}"))

    def create_path(self, path: str | Path, *, name: str | None = None, confined: bool = True) -> dict[str, Any]:
        """A set that points at a directory (or one image) on this machine; nothing is copied.

        `confined=False` is for a path the operator typed in the server's own terminal
        (`serve <dir>`): it skips the allowed-roots check, now and when the set is launched.
        PermissionError outside the allowed roots, FileNotFoundError for a missing path."""
        target = Path(path).expanduser()
        resolved = confine(target, self.store.allowed_roots()) if confined else target.resolve(strict=True)
        self._refuse_evaluation_data(resolved)
        fallback = resolved.name or str(resolved)
        return self._summary(self._new("path", name, fallback, path=str(resolved), trusted=not confined))

    def _refuse_evaluation_data(self, path: Path) -> None:
        refusal = ConsoleError(
            422,
            "This directory holds evaluation data with ground truth; it is only run from the Evaluation screen.",
            code="evaluation_data",
        )
        if self.eval_data_dir is not None:
            try:
                if path.is_relative_to(self.eval_data_dir.expanduser().resolve()):
                    raise refusal
            except OSError:
                pass
        folders = [path] if path.is_dir() else [path.parent]
        folders += [p for p in folders[0].iterdir() if p.is_dir()] if path.is_dir() else []
        for folder in folders:
            manifest = folder / "manifest.json"
            try:
                if manifest.is_file() and _holds_truth(manifest.read_bytes()):
                    raise refusal
            except OSError:
                continue

    def _load_path(self, meta: Mapping[str, Any]) -> Path:
        """Where the loader reads this set from."""
        if meta.get("kind") == "path":
            raw = Path(str(meta.get("path")))
            # checked again at every use: the allowed roots, or a link below them, may have changed
            path = raw.resolve(strict=True) if meta.get("trusted") is True else confine(raw, self.store.allowed_roots())
            self._refuse_evaluation_data(path)
            return path
        return self._dir(str(meta["set_id"])) / FILES_DIR

    def _layout(self, meta: Mapping[str, Any]) -> tuple[Path, list[Path], Path | None]:
        """(folder, further folders, the folder they share) for the loader.

        A path set is one directory, read as the CLI reads it. An upload is whatever was dropped:
        a folder arrives as "<folder>/Urban/a.jpg", a loose file beside it as "b.jpg", an archive
        adds a folder of its own. Every folder that holds images is read, so a stored image is
        always a row; `rel_path` and manifests are relative to the upload as a whole."""
        path = self._load_path(meta)
        if meta.get("kind") == "path":
            return path, [], None
        folders = _image_folders(path)
        if not folders:
            return path, [], path
        return folders[0], folders[1:], path

    def _summary(self, meta: Mapping[str, Any]) -> dict[str, Any]:
        files = meta.get("files") if isinstance(meta.get("files"), dict) else {}
        if meta.get("kind") == "path":
            try:
                panoramas = len(load_tasks_detailed(self._load_path(meta)).rows)
            except (OSError, ValueError, PermissionError, ConsoleError):
                panoramas = 0
            count = panoramas
        else:
            panoramas = sum(1 for rel in files if PurePosixPath(rel).suffix.lower() in IMAGE_SUFFIXES)
            count = len(files)
        return {
            "set_id": meta.get("set_id"),
            "name": meta.get("name"),
            "kind": meta.get("kind"),
            "path": meta.get("path"),
            "created_at": meta.get("created_at"),
            "files": count,
            "panoramas": panoramas,
        }

    def list(self) -> list[dict[str, Any]]:
        """Every stored set, newest first."""
        try:
            names = sorted(p.name for p in self.root.iterdir() if p.is_dir())
        except OSError:
            return []
        out = []
        for name in names:
            try:
                out.append(self._summary(self.get(name)))
            except (KeyError, ValueError, PermissionError):
                continue
        return sorted(out, key=lambda row: str(row["created_at"]), reverse=True)

    def delete(self, set_id: str) -> None:
        """Remove an upload set, or forget a path set. Refused while a run still needs it: the
        replay and an embedded export of that run read the images from here."""
        meta = self.get(set_id)
        runs, active = self.references(set_id)
        blocking = active if meta.get("kind") == "path" else runs
        if blocking:
            raise ConsoleError(
                409,
                f"This set is used by {plural(len(blocking), 'run')} {', '.join(sorted(blocking))}; delete it once "
                f"{'that run is' if len(blocking) == 1 else 'those runs are'} gone.",
                code="set_in_use",
            )
        with self._lock:
            shutil.rmtree(self._dir(set_id), ignore_errors=True)
        shutil.rmtree(self.cache_dir / set_id, ignore_errors=True)

    # ------------------------------------------------------------------ uploads

    def add_file(self, set_id: str, rel_path: str, data: bytes) -> dict[str, Any]:
        """Store one uploaded file byte for byte, or unpack a .zip; returns
        `{stored: [{path, size, sha256}], ignored: [str]}`.

        Never overwrites: the same bytes again are a success that changes nothing, other bytes
        at an existing path are a 409. A set a run was launched from is frozen."""
        meta = self.get(set_id)
        if meta.get("kind") != "upload":
            raise ConsoleError(409, "Files can only be added to an upload set.", code="not_an_upload_set")
        if len(data) > MAX_UPLOAD_BYTES:
            raise ConsoleError(413, "The file is larger than 200 MB.", code="file_too_large")
        rel = _upload_path(rel_path)
        if rel is None:
            # not stored, but remembered: the preflight table lists what was dropped and left out
            with self._lock:
                meta = self.get(set_id)
                meta["ignored"] = sorted({*(meta.get("ignored") or []), str(rel_path)})
                self._save(meta)
            return {"stored": [], "ignored": [str(rel_path)]}
        with self._lock:
            if rel.suffix.lower() == ARCHIVE_SUFFIX:
                incoming, ignored = self._staged_archive(set_id, rel.parent, data)
            else:
                incoming, ignored = {rel.as_posix(): data}, []
            try:
                return self._store(set_id, incoming, ignored)
            finally:
                shutil.rmtree(self._dir(set_id) / ".incoming", ignore_errors=True)

    def _staged_archive(self, set_id: str, base: PurePosixPath, data: bytes) -> tuple[dict[str, Path], list[str]]:
        """Unpack into a staging directory, so a refused archive leaves nothing behind. Members
        that are absolute, climb out, are links or are not an accepted type are skipped and named."""
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except (zipfile.BadZipFile, OSError) as exc:
            raise ConsoleError(422, "This is not a readable .zip archive.", code="invalid_zip") from exc
        infos = [info for info in archive.infolist() if not info.is_dir()]
        if len(infos) > MAX_ZIP_ENTRIES:
            raise ConsoleError(422, f"The archive has more than {MAX_ZIP_ENTRIES} files.", code="zip_too_large")
        files_dir = self._dir(set_id) / FILES_DIR
        staging = self._dir(set_id) / ".incoming"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        staged: dict[str, Path] = {}
        ignored: list[str] = []
        total = 0
        for index, info in enumerate(infos):
            is_link = (info.external_attr >> 16) & 0o170000 == 0o120000
            rel = None if is_link else _upload_path(info.filename, archive_member=True)
            if rel is not None and base.parts:
                rel = base / rel if len(base.parts) + len(rel.parts) <= MAX_PATH_COMPONENTS else None
            if rel is not None:
                try:
                    confine(files_dir / rel, files_dir, strict=False)
                except PermissionError:
                    rel = None
            if rel is None or rel.as_posix() in staged:
                ignored.append(info.filename)
                continue
            out = staging / str(index)
            with archive.open(info) as member, out.open("wb") as fh:
                # counted while streaming: the sizes an archive declares are not to be believed
                while chunk := member.read(_CHUNK):
                    total += len(chunk)
                    if total > MAX_ZIP_BYTES:
                        raise ConsoleError(422, "The archive unpacks to more than 2 GB.", code="zip_too_large")
                    fh.write(chunk)
            staged[rel.as_posix()] = out
        return staged, ignored

    def _store(self, set_id: str, incoming: Mapping[str, bytes | Path], ignored: list[str]) -> dict[str, Any]:
        """Check every incoming file before any is put in place: all or nothing."""
        meta = self.get(set_id)
        files_dir = self._dir(set_id) / FILES_DIR
        files: dict[str, Any] = dict(meta.get("files") or {})
        plan: list[tuple[str, bytes | Path, dict[str, Any]]] = []
        clashes: list[str] = []
        for rel, source in incoming.items():
            data = source if isinstance(source, bytes) else source.read_bytes()
            if PurePosixPath(rel).name.lower() == "manifest.json" and _holds_truth(data):
                raise ConsoleError(
                    422,
                    "manifest.json holds coordinates: this is evaluation data, which is only run from the "
                    "Evaluation screen.",
                    code="evaluation_data",
                )
            info: dict[str, Any] = {"size": len(data), "sha256": _sha256(data)}
            if PurePosixPath(rel).suffix.lower() in IMAGE_SUFFIXES:
                info["image"] = _image_format(data) is not None
            target = confine(files_dir / rel, files_dir, strict=False)
            if target.exists():
                if _sha256(target.read_bytes()) != info["sha256"]:
                    clashes.append(rel)
                continue  # the same bytes again: nothing to do
            plan.append((rel, source, info))
        if plan and self.references(set_id)[0]:
            raise ConsoleError(
                409,
                "A run was launched from this set, so it can no longer change. Upload into a new set.",
                code="set_in_use",
            )
        if clashes:
            raise ConsoleError(
                409,
                "A different file is already stored as " + ", ".join(clashes) + "; files are never overwritten.",
                code="file_exists",
                problems=clashes,
            )
        stored = []
        for rel, source, info in plan:
            target = files_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(source, bytes):
                with target.open("xb") as fh:
                    fh.write(source)
            else:
                os.replace(source, target)
            files[rel] = info
            stored.append({"path": rel, "size": info["size"], "sha256": info["sha256"]})
            if info.get("image") is False:
                ignored.append(rel)  # kept as uploaded, but never served or launched
        meta["files"] = files
        meta["ignored"] = sorted({*(meta.get("ignored") or []), *ignored})
        self._save(meta)
        return {"stored": stored, "ignored": ignored}

    # ------------------------------------------------------------------ preflight

    def _info(self, path: Path) -> dict[str, Any]:
        """Size, sha256 and pixel size of a panorama file; cached until the file changes."""
        try:
            stat = path.stat()
        except OSError:
            return {"size_bytes": None, "sha256": None, "width": None, "height": None, "readable": False}
        key = str(path)
        cached = self._file_info.get(key)
        if cached is not None and cached[:2] == (stat.st_mtime_ns, stat.st_size):
            return cached[2]
        digest = hashlib.sha256()
        with path.open("rb") as fh:
            while chunk := fh.read(_CHUNK):
                digest.update(chunk)
        width = height = None
        readable = _image_format(path) is not None
        if readable:
            with Image.open(path) as image:
                width, height = image.size
        info = {
            "size_bytes": stat.st_size,
            "sha256": digest.hexdigest(),
            "width": width,
            "height": height,
            "readable": readable,
        }
        self._file_info[key] = (stat.st_mtime_ns, stat.st_size, info)
        return info

    def sha256(self, path: str | Path) -> str | None:
        return self._info(Path(path))["sha256"]

    def load(
        self,
        set_id: str,
        *,
        overrides: Mapping[str, Any] | None = None,
        special: str | None = None,
        apply_label_to_unlabelled: str | None = None,
        taken_ids: Iterable[str] | None = None,
        default_source: str = "operator_bulk",
    ) -> Preflight:
        """The set as the loader reads it with these fixed choices. ConsoleError 422 for a choice
        that is not valid or names no panorama; an empty set is a Preflight without rows."""
        meta = self.get(set_id)
        if overrides is not None and not isinstance(overrides, Mapping):
            raise ConsoleError(422, "overrides must be an object keyed by panorama.", code="invalid_override")
        if special is not None and not isinstance(special, str):
            raise ConsoleError(422, "special must name one panorama, or be null.", code="invalid_override")
        if apply_label_to_unlabelled is not None and apply_label_to_unlabelled not in {label.value for label in Label}:
            raise ConsoleError(
                422, "apply_label_to_unlabelled must be exactly 'Urban' or 'non-Urban'.", code="invalid_override"
            )
        try:
            path, also, root = self._layout(meta)
        except FileNotFoundError:
            raise ConsoleError(409, f"{meta.get('path')} is no longer there.", code="set_missing") from None
        if not path.exists():
            return Preflight(rows=[])
        try:
            loaded = load_tasks_detailed(
                path,
                special=special or None,
                default_label=Label(apply_label_to_unlabelled) if apply_label_to_unlabelled else None,
                overrides=overrides or None,
                taken_ids=taken_ids,
                default_source=default_source,
                also=also,
                root=root,
            )
        except ValueError as exc:
            if str(exc).startswith("no panorama images"):
                loaded = Preflight(rows=[])
            else:
                raise ConsoleError(422, str(exc), code="invalid_override", problems=str(exc).split("; ")) from exc
        if meta.get("kind") == "path" and path.is_dir():
            unread = _unread_images(path, {row.path for row in loaded.rows})
            if unread:
                # The CLI reads a directory and its Urban/ and non-Urban/ folders, nothing deeper.
                loaded.ignored = sorted({*loaded.ignored, *(f"{name} (not read: {_UNREAD_WHY})" for name in unread)})
                loaded.warnings.append(
                    f"{count(len(unread), 'image')} in other sub-folders {plural(len(unread), 'is')} not read and "
                    f"would not run ({_UNREAD_WHY}): " + _listed(unread)
                )
        return loaded

    def preflight(
        self,
        set_id: str,
        *,
        preset: str = "custom",
        overrides: Mapping[str, Any] | None = None,
        special: str | None = None,
        apply_label_to_unlabelled: str | None = None,
        live_budget: bool = False,
        settings: Settings,
        taken_ids: Iterable[str] | None = None,
        run_has_special: bool = False,
        taken_sha256: Iterable[str] = (),
        frozen: Mapping[str, Mapping[str, Any]] | None = None,
        default_source: str = "operator_bulk",
    ) -> dict[str, Any]:
        """What a launch with exactly these inputs would run, and whether it may.

        `taken_ids` and `run_has_special` describe the run the rows would be added to;
        `taken_sha256` its images (a row with one of them is a `duplicate` and would be skipped).
        `frozen` maps panorama ids that already have a log under a reused run id to their logged
        `{label, timestamp, special, sha256}`: a task cannot change once launched."""
        meta = self.get(set_id)
        taken = set(taken_ids or ())
        loaded = self.load(
            set_id,
            overrides=overrides,
            special=special,
            apply_label_to_unlabelled=apply_label_to_unlabelled,
            taken_ids=taken or None,
            default_source=default_source,
        )
        recorded = meta.get("files") if isinstance(meta.get("files"), dict) else {}
        files_dir = self._dir(set_id) / FILES_DIR
        in_run = set(taken_sha256)
        rows: list[dict[str, Any]] = []
        changed: list[str] = []
        unreadable: list[str] = []
        for row in loaded.rows:
            info = self._info(row.path)
            duplicate = info["sha256"] is not None and info["sha256"] in in_run
            budget = settings.budget_for(row.special, live=live_budget).model_dump(mode="json")
            rows.append(
                {
                    **row.to_dict(),
                    **{key: info[key] for key in ("size_bytes", "width", "height", "sha256")},
                    "image_warning": _image_warning(info),
                    "budget": budget,
                    "collides": _natural_id(row) in taken,
                    "duplicate": duplicate,
                }
            )
            if not info["readable"]:
                unreadable.append(row.panorama_id)
            stored = recorded.get(_stored_rel(files_dir, row.path)) if meta.get("kind") == "upload" else None
            if isinstance(stored, dict) and stored.get("sha256") != info["sha256"]:
                changed.append(row.panorama_id)
        left_out = self._left_out(meta, files_dir, loaded) if meta.get("kind") == "upload" else {}
        fresh = [row for row in rows if not row["duplicate"]]
        warnings = list(loaded.warnings)
        warnings += [f"{row['filename']}: {row['image_warning']}" for row in rows if row["image_warning"]]
        warnings += [
            f"{row['filename']} is already in this run and will be skipped" for row in rows if row["duplicate"]
        ]
        warnings += [
            f"{row['filename']}: a panorama with this name is already in the run; this one would be "
            f"added as {row['panorama_id']}"
            for row in fresh
            if row["collides"]
        ]

        blocking: list[dict[str, Any]] = []

        def block(code: str, text: str, ids: Iterable[str] = ()) -> None:
            blocking.append({"code": code, "text": text, "panorama_ids": list(ids)})

        if not rows:
            # (rows that are all already in the run are not a fault: adding them again adds nothing)
            block("no_panoramas", "There is no panorama to run: add .jpg, .jpeg or .png files.")
        if left_out:
            # every stored image runs or is named here with the reason: none leaves the run unseen
            block(
                "image_not_read",
                f"{count(len(left_out), 'stored image')} would not run: "
                + "; ".join(f"{rel} ({why})" for rel, why in left_out.items())
                + ". Upload the files into a new set.",
            )
        unlabelled = [row["panorama_id"] for row in fresh if row["label"] is None]
        if unlabelled:
            block("no_label", "Choose Urban or non-Urban for: " + ", ".join(unlabelled) + ".", unlabelled)
        flagged = [row["panorama_id"] for row in fresh if row["special"]]
        if run_has_special and flagged:
            block(
                "special_already_in_run",
                "This run already has its Special One; " + ", ".join(flagged) + " cannot be flagged too.",
                flagged,
            )
        elif len(flagged) > 1:
            block(
                "special_multiple",
                f"{len(flagged)} panoramas are flagged as the Special One; choose exactly one.",
                flagged,
            )
        elif not flagged and preset in SPECIAL_REQUIRED_PRESETS and not run_has_special and fresh:
            block("special_missing", "A scoring run needs its Special One: choose it in the table.")
        if unreadable:
            block(
                "unreadable_image",
                "Cannot be opened as a JPEG or PNG image: " + ", ".join(unreadable) + ".",
                unreadable,
            )
        if changed:
            block(
                "file_changed",
                "Changed on disk since it was uploaded: " + ", ".join(changed) + ". Upload the files into a new set.",
                changed,
            )
        reserved = [row["panorama_id"] for row in fresh if _RESERVED_ID_RE.match(row["panorama_id"])]
        if reserved:
            block(
                "reserved_name",
                "Rename and upload again: "
                + ", ".join(reserved)
                + ". The export of a panorama with this name would overwrite one of the run's own files "
                "(run.json, results.json).",
                reserved,
            )
        moved = [row["panorama_id"] for row in rows if _differs(row, (frozen or {}).get(row["panorama_id"]))]
        if moved:
            block(
                "id_collision",
                "Already logged under this run id with another label, timestamp, Special One flag or image: "
                + ", ".join(moved)
                + ". A launched task cannot change; use a new run id.",
                moved,
            )
        return {
            "set_id": set_id,
            "name": meta.get("name"),
            "kind": meta.get("kind"),
            "rows": rows,
            "warnings": warnings,
            "blocking": blocking,
            "ready": not blocking,
            "ignored": sorted(
                {*loaded.ignored, *(meta.get("ignored") or []), *(f"{rel} ({why})" for rel, why in left_out.items())}
            ),
            "summary": _summary_line(fresh),
            "cost_ceiling_usd": round(sum(row["budget"]["max_spend_usd"] for row in fresh), 2),
            "preflight_token": preflight_token(rows),
        }

    @staticmethod
    def _left_out(meta: Mapping[str, Any], files_dir: Path, loaded: Preflight) -> dict[str, str]:
        """Images the set stored that the loader did not turn into rows, each with the reason.
        Empty unless something changed the set's directory behind the store's back."""
        recorded = meta.get("files") if isinstance(meta.get("files"), dict) else {}
        read = {_stored_rel(files_dir, row.path) for row in loaded.rows}
        out: dict[str, str] = {}
        for rel in sorted(recorded):
            if PurePosixPath(rel).suffix.lower() not in IMAGE_SUFFIXES or rel in read:
                continue
            present = (files_dir / rel).is_file()
            out[rel] = "stored, but not read as a panorama" if present else "stored, but the file is no longer on disk"
        return out

    def tasks(
        self,
        set_id: str,
        *,
        overrides: Mapping[str, Any] | None = None,
        special: str | None = None,
        apply_label_to_unlabelled: str | None = None,
        taken_ids: Iterable[str] | None = None,
        default_source: str = "operator_bulk",
        skip: Iterable[str] = (),
    ) -> list[PanoramaTask]:
        """The tasks a launch runs, each with its provenance and the set it came from. `skip`
        names panorama ids to leave out (rows that are already in the run)."""
        loaded = self.load(
            set_id,
            overrides=overrides,
            special=special,
            apply_label_to_unlabelled=apply_label_to_unlabelled,
            taken_ids=taken_ids,
            default_source=default_source,
        )
        left_out = set(skip)
        try:
            tasks = Preflight(rows=[row for row in loaded.rows if row.panorama_id not in left_out]).tasks()
        except ValueError as exc:
            raise ConsoleError(422, str(exc), code="no_label") from exc
        return [task.model_copy(update={"provenance": {**(task.provenance or {}), "set_id": set_id}}) for task in tasks]

    # ------------------------------------------------------------------ images

    def image(self, set_id: str, key: str, width: int | str | None = 1024) -> tuple[Path, str]:
        """(file, media type) of one panorama of the set: a thumbnail, a preview, or the verified
        original for "full". `key` is the panorama id the preflight showed, or its relative path."""
        rows = self.load(set_id).rows
        by_id = next((r for r in rows if r.panorama_id == key), None)
        row = by_id or next((r for r in rows if r.rel_path == key), None)
        if row is None:
            raise KeyError(key)
        return preview_image(row.path, self.cache_dir / safe_id(set_id, "set id"), width)


def _label_of(name: str) -> Label | None:
    try:
        return Label.parse(name)
    except ValueError:
        return None


def _is_image_file(path: Path) -> bool:
    return not path.name.startswith(".") and path.suffix.lower() in IMAGE_SUFFIXES and path.is_file()


def _image_folders(files_dir: Path) -> list[Path]:
    """The folders of an upload the loader must read so that every stored image is a row,
    shallowest first. An image in `<folder>/Urban/` belongs to `<folder>`: the loader reads a
    folder together with the label-named folders directly inside it."""
    found: set[Path] = set()
    try:
        walk = list(os.walk(files_dir))
    except OSError:
        return []
    for current, dirs, names in walk:
        dirs[:] = [name for name in dirs if not name.startswith(".")]
        folder = Path(current)
        if not any(_is_image_file(folder / name) for name in names):
            continue
        inside_label = folder != files_dir and _label_of(folder.name) is not None
        found.add(folder.parent if inside_label else folder)
    return sorted(found, key=lambda folder: (len(folder.parts), folder.parts))


_UNREAD_WHY = "only this folder and its Urban/ and non-Urban/ folders are read"
_UNREAD_SCAN_LIMIT = 5000
_UNREAD_DEPTH = 3
_LISTED = 12


def _unread_images(directory: Path, read: set[Path]) -> list[str]:
    """Images below a path set's directory that the loader does not read, as relative paths.
    A bounded look: a path set may point at a whole downloads folder."""
    out: list[str] = []
    seen = 0
    pending = [(directory, 0)]
    while pending:
        folder, depth = pending.pop()
        try:
            entries = sorted(os.scandir(folder), key=lambda entry: entry.name)
        except OSError:
            continue
        for entry in entries:
            seen += 1
            if seen > _UNREAD_SCAN_LIMIT:
                return out
            if entry.name.startswith("."):
                continue
            path = Path(entry.path)
            if entry.is_dir(follow_symlinks=False):
                if depth + 1 < _UNREAD_DEPTH:
                    pending.append((path, depth + 1))
            elif depth and path.suffix.lower() in IMAGE_SUFFIXES and path not in read:
                out.append(path.relative_to(directory).as_posix())
    return sorted(out)


def _listed(names: list[str]) -> str:
    """A list a person can read: the first dozen, then how many more."""
    shown = ", ".join(names[:_LISTED])
    return shown if len(names) <= _LISTED else f"{shown} and {len(names) - _LISTED} more"


def _natural_id(row: PreflightRow) -> str:
    """The id the file would have in a run of its own: the loader appends _2, _3 to one that the
    run it is added to has already taken."""
    return _panorama_id(row.path, set())


def _stored_rel(files_dir: Path, path: Path) -> str | None:
    try:
        return path.resolve().relative_to(files_dir.resolve()).as_posix()
    except (OSError, ValueError):
        return None


def _image_warning(info: Mapping[str, Any]) -> str | None:
    if not info["readable"]:
        return "cannot be opened as a JPEG or PNG image"
    width, height = info["width"], info["height"]
    if width != 2 * height:
        return f"{width} x {height} is not 2:1, so this may not be an equirectangular panorama"
    if abs(width - EXPECTED_SIZE[0]) > SIZE_TOLERANCE * EXPECTED_SIZE[0]:
        return f"{width} x {height} is far from the expected {EXPECTED_SIZE[0]} x {EXPECTED_SIZE[1]}"
    return None


def _differs(row: Mapping[str, Any], logged: Mapping[str, Any] | None) -> bool:
    if logged is None:
        return False
    return any(
        key in logged and logged[key] is not None and logged[key] != row.get(key)
        for key in ("label", "special", "sha256")
    ) or ("timestamp" in logged and logged["timestamp"] != row.get("timestamp"))


def _summary_line(rows: list[dict[str, Any]]) -> str:
    """"6 panoramas: 4 Urban, 2 non-Urban, Special One = pano_3"."""
    if not rows:
        return "no panoramas"
    counts = [(label.value, sum(1 for row in rows if row["label"] == label.value)) for label in Label]
    parts = [f"{n} {name}" for name, n in counts if n]
    unlabelled = sum(1 for row in rows if row["label"] is None)
    if unlabelled:
        parts.append(f"{unlabelled} without a label")
    special = [row["panorama_id"] for row in rows if row["special"]]
    parts.append("Special One = " + ", ".join(special) if special else "no Special One")
    return f"{len(rows)} panorama{'s' if len(rows) != 1 else ''}: " + ", ".join(parts)


def preflight_token(rows: Iterable[Mapping[str, Any]]) -> str:
    """What a launch must still find: the panorama ids and the bytes behind them."""
    pairs = sorted((str(row["panorama_id"]), str(row.get("sha256"))) for row in rows)
    return hashlib.sha256(json.dumps(pairs).encode()).hexdigest()[:32]
