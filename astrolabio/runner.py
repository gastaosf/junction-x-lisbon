"""Run orchestration (SPEC section 10): task loading, parallel runs, watchdog, exports, recovery."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import re
import secrets
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from .config import Settings
from .eventlog import export_panorama, validate_export
from .loop import ModelClient, run_agent
from .openai_client import OpenAIModelClient
from .pano import Panorama
from .schema import Entry, Label, PanoramaTask
from .session import PanoramaSession
from .tools.http import make_http_client

IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png"})
MANIFEST_NAMES = (
    "manifest.json",
    "manifest.csv",
    "labels.csv",
    "labels.json",
    "metadata.json",
    "metadata.csv",
)
MANIFEST_SUFFIXES = frozenset({".csv", ".tsv", ".json", ".txt"})
# Files this program writes into a directory; never read back as a manifest.
OWN_OUTPUTS = frozenset({"summary.csv", "answers.csv"})
EVENTS_SUFFIX = ".events.jsonl"
SUMMARY_COLUMNS = (
    "panorama",
    "label",
    "special",
    "lat",
    "lng",
    "multiplier",
    "turns",
    "cost_usd",
    "wall_time_s",
    "stop_reason",
    "origin",
    "problems",
)

# The organisers' metadata format is unknown, so accept the obvious spellings.
_FILE_KEYS = ("filename", "file", "image", "panorama", "panorama_id", "name", "id", "path")
_LABEL_KEYS = ("label", "type", "class", "category", "environment")
_TIME_KEYS = ("timestamp", "capture_timestamp", "time", "datetime", "capture_time", "captured_at", "date")
_SPECIAL_KEYS = ("special", "special_one", "is_special", "special one", "specialone")
_URBAN_FLAG_KEYS = ("urban", "is_urban")
_LIST_KEYS = ("panoramas", "images", "items", "files", "entries")
_TRUTHY = frozenset({"1", "true", "yes", "y", "x", "special", "special one"})
_FALSY = frozenset({"0", "false", "no", "n", "", "none", "-"})

_LABEL_RE = re.compile(r"(?<![a-z])(non[-_ ]?urban|rural|urban)(?![a-z])", re.IGNORECASE)
_TIMESTAMP_RE = re.compile(
    # seconds are optional: "2025-10-04 12:30" is a timestamp too
    r"(?<!\d)((?:19|20)\d{2})[-_./]?(\d{2})[-_./]?(\d{2})[-_T ]?(\d{2})[-_.:h]?(\d{2})(?:[-_.:]?(\d{2}))?(?!\d)"
)
# In a file name the bare token is the documented convention (`*special*`).
_SPECIAL_RE = re.compile(r"(?<![a-z])special(?![a-z])", re.IGNORECASE)
# In free text it must be a statement, not a word in a sentence: "special", "Special One: yes".
_SPECIAL_LINE_RE = re.compile(r"\s*(?:is[_ ]?)?special(?:[_ -]?one)?\s*(?:[:=]\s*(\S+))?\s*", re.IGNORECASE)
_UNSAFE_ID_RE = re.compile(r"[^A-Za-z0-9._-]+")

Meta = dict[str, Any]  # optional keys: label (Label), timestamp (str), special (bool)


def _parse_timestamp(text: str) -> str | None:
    """First YYYYMMDDhhmm[ss] in the text (separators tolerated), if it is a real date and time."""
    for match in _TIMESTAMP_RE.finditer(text):
        stamp = "".join(group or "00" for group in match.groups())
        try:
            datetime.strptime(stamp, "%Y%m%d%H%M%S")
        except ValueError:
            continue
        return stamp
    return None


def _parse_label(text: str) -> Label | None:
    """A label written out somewhere in free text (file name, sidecar)."""
    match = _LABEL_RE.search(text)
    return Label.parse(match.group(1)) if match else None


def _parse_label_cell(raw: Any) -> Label | None:
    """A manifest cell: the whole value is the label, so the short forms U / NU count too."""
    try:
        return Label.parse(str(raw))
    except ValueError:
        return _parse_label(str(raw))


def _special_statement(text: str) -> bool | None:
    """What a free-text sidecar states about the Special One, or None when it states nothing.
    "Nothing special about this one" is prose, not a flag."""
    for line in text.splitlines():
        match = _SPECIAL_LINE_RE.fullmatch(line)
        if match:
            value = match.group(1)
            return True if value is None else value.strip().lower() in _TRUTHY
    return None


def _meta_from_text(text: str, *, free_text: bool = False) -> Meta:
    """Whatever a file name (or, with free_text, a sidecar) gives away."""
    meta: Meta = {}
    if (label := _parse_label(text)) is not None:
        meta["label"] = label
    if (stamp := _parse_timestamp(text)) is not None:
        meta["timestamp"] = stamp
    if free_text:
        if (special := _special_statement(text)) is not None:
            meta["special"] = special
    elif _SPECIAL_RE.search(text):
        meta["special"] = True
    return meta


def _first(record: Mapping[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        value = record.get(key)
        if value is not None and str(value).strip() != "":
            return value
    return None


def _meta_from_record(record: Mapping[str, Any], warnings: list[str] | None = None) -> tuple[str | None, Meta]:
    """(filename, meta) from one manifest row or JSON sidecar."""
    row = {str(k).strip().lower(): v for k, v in record.items() if k is not None}
    meta: Meta = {}
    filename = _first(row, _FILE_KEYS)
    if (raw := _first(row, _LABEL_KEYS)) is not None and (label := _parse_label_cell(raw)) is not None:
        meta["label"] = label
    elif (raw := _first(row, _URBAN_FLAG_KEYS)) is not None:
        flag = raw if isinstance(raw, bool) else str(raw).strip().lower()
        if flag is True or flag in _TRUTHY:
            meta["label"] = Label.URBAN
        elif flag is False or flag in _FALSY:
            meta["label"] = Label.NON_URBAN
        elif (label := _parse_label_cell(raw)) is not None:
            meta["label"] = label
    if (raw := _first(row, _TIME_KEYS)) is not None:
        if (stamp := _parse_timestamp(str(raw))) is not None:
            meta["timestamp"] = stamp
        elif warnings is not None:
            warnings.append(f"{filename or '?'}: timestamp {str(raw)!r} was not understood and is ignored")
    if (raw := _first(row, _SPECIAL_KEYS)) is not None:
        meta["special"] = raw is True or str(raw).strip().lower() in _TRUTHY
    return (None if filename is None else str(filename)), meta


def _is_image_name(value: Any) -> bool:
    return isinstance(value, str) and Path(value.strip()).suffix.lower() in IMAGE_SUFFIXES


def _headerless_record(cells: list[str]) -> Mapping[str, Any] | None:
    """One row of a CSV that has no header line: find the columns by what they contain."""
    cells = [c.strip() for c in cells]
    filename = next((c for c in cells if _is_image_name(c)), None)
    if filename is None:
        return None
    record: dict[str, Any] = {"filename": filename}
    for cell in cells:
        if cell == filename or not cell:
            continue
        if "label" not in record and _parse_label_cell(cell) is not None:
            record["label"] = cell
        elif "timestamp" not in record and _parse_timestamp(cell) is not None:
            record["timestamp"] = cell
        elif "special" not in record and cell.lower() in {"special", "special one", "special_one"}:
            record["special"] = True
    return record


def _csv_records(path: Path) -> list[Mapping[str, Any]]:
    with path.open(newline="", encoding="utf-8-sig") as fh:
        sample = fh.read(4096)
        fh.seek(0)
        try:
            dialect: Any = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        rows = [row for row in csv.reader(fh, dialect=dialect) if any(cell.strip() for cell in row)]
    if not rows:
        return []
    header = [cell.strip().lower() for cell in rows[0]]
    if any(_is_image_name(cell) for cell in rows[0]) or not set(header) & set(_FILE_KEYS):
        # No header line (the first row is already data), or one we do not recognise.
        return [r for r in map(_headerless_record, rows) if r is not None]
    return [dict(zip(header, row)) for row in rows[1:]]


def _manifest_records(path: Path) -> list[Mapping[str, Any]]:
    if path.suffix.lower() != ".json":
        return _csv_records(path)
    doc = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(doc, dict):
        nested = next((doc[k] for k in _LIST_KEYS if isinstance(doc.get(k), list)), None)
        if nested is None:  # a list of records under a key we did not think of, e.g. {"data": [...]}
            nested = next(
                (v for v in doc.values() if isinstance(v, list) and v and all(isinstance(r, dict) for r in v)),
                None,
            )
        if nested is None:  # {"<filename>": {...} | "<label>"}
            return [
                {"filename": name, **(value if isinstance(value, dict) else {"label": value})}
                for name, value in doc.items()
            ]
        doc = nested
    return [r for r in doc if isinstance(r, dict)] if isinstance(doc, list) else []


def _manifest_files(directory: Path, image_stems: set[str]) -> list[Path]:
    """The well-known manifest names first, then any other table in the directory that is not a
    per-image sidecar: the organisers' file may be called anything (set3.csv, labels.txt)."""
    known = [directory / name for name in MANIFEST_NAMES if (directory / name).is_file()]
    others = sorted(
        p
        for p in directory.iterdir()
        if p.is_file()
        and not p.name.startswith(".")
        and p.suffix.lower() in MANIFEST_SUFFIXES
        and p.name not in MANIFEST_NAMES
        and p.name not in OWN_OUTPUTS
        and p.stem.lower() not in image_stems
    )
    return others + known  # later files win, so the well-known names keep priority


def _manifest_meta(
    directory: Path, image_stems: set[str] | None = None, warnings: list[str] | None = None
) -> dict[str, Meta]:
    """Metadata from every manifest in the directory, keyed by lower-cased file name and stem."""
    by_name: dict[str, Meta] = {}
    for path in _manifest_files(directory, image_stems or set()):
        try:
            records = _manifest_records(path)
        except (OSError, ValueError, csv.Error) as exc:
            if warnings is not None:
                warnings.append(f"{path.name}: could not be read as a manifest ({exc})")
            continue
        for record in records:
            filename, meta = _meta_from_record(record, warnings)
            if filename is None:
                continue
            leaf = Path(filename).name.lower()
            for key in {leaf, Path(leaf).stem}:
                by_name.setdefault(key, {}).update(meta)
    return by_name


def _sidecar_meta(image: Path) -> Meta:
    meta: Meta = {}
    text_path, json_path = image.with_suffix(".txt"), image.with_suffix(".json")
    if text_path.is_file():
        meta.update(_meta_from_text(text_path.read_text(encoding="utf-8", errors="replace"), free_text=True))
    if json_path.is_file():
        try:
            doc = json.loads(json_path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            doc = None
        if isinstance(doc, dict):
            meta.update(_meta_from_record(doc)[1])
    return meta


def _is_panorama_file(path: Path) -> bool:
    # A leading dot is never a panorama: macOS writes "._<name>.jpg" resource forks next to every
    # image on a FAT/exFAT stick or in a zip, and they would otherwise take the real image's id.
    return path.is_file() and not path.name.startswith(".") and path.suffix.lower() in IMAGE_SUFFIXES


def _directory_images(directory: Path) -> list[Path]:
    """Images in the directory and, for an `Urban/` + `non-Urban/` layout, one level below it."""
    images = sorted(p for p in directory.iterdir() if _is_panorama_file(p))
    for sub in sorted(p for p in directory.iterdir() if p.is_dir() and not p.name.startswith(".")):
        if _parse_label_cell(sub.name) is not None:
            images += sorted(p for p in sub.iterdir() if _is_panorama_file(p))
    return images


def _panorama_id(image: Path, taken: set[str]) -> str:
    base = _UNSAFE_ID_RE.sub("_", image.stem).strip("._") or "panorama"
    candidate, n = base, 2
    while candidate in taken:
        candidate, n = f"{base}_{n}", n + 1
    taken.add(candidate)
    return candidate


_FIELDS = ("label", "timestamp", "special")
_OVERRIDE_TIMESTAMP_RE = re.compile(r"[0-9]{14}")


@dataclass
class PreflightRow:
    """One panorama as the files describe it, and after the operator's fixed choices.

    `sources` says where each of label / timestamp / special came from (folder, filename, sidecar,
    manifest, operator, operator_bulk, default, none); `parsed` keeps what the files said before
    any override or default, so the log can show both."""

    panorama_id: str
    path: Path
    filename: str
    rel_path: str  # relative to the directory that was loaded, POSIX
    label: Label | None
    timestamp: str | None
    special: bool
    sources: dict[str, str]
    parsed: dict[str, Any]

    def values(self) -> dict[str, Any]:
        return {"label": self.label.value if self.label else None, "timestamp": self.timestamp, "special": self.special}

    def provenance(self) -> dict[str, Any]:
        values = self.values()
        return {
            key: {"value": values[key], "source": self.sources[key], "parsed": self.parsed[key]} for key in _FIELDS
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "panorama_id": self.panorama_id,
            "path": str(self.path),
            "filename": self.filename,
            "rel_path": self.rel_path,
            **self.values(),
            "sources": dict(self.sources),
            "parsed": dict(self.parsed),
        }


@dataclass
class Preflight:
    rows: list[PreflightRow]
    warnings: list[str] = field(default_factory=list)
    ignored: list[str] = field(default_factory=list)  # dot-files that were skipped

    def tasks(self) -> list[PanoramaTask]:
        """The tasks to launch, each carrying its provenance. Raises ValueError while any row
        still has no label: the label selects the scoring function, so it is never guessed."""
        unlabelled = [row.filename for row in self.rows if row.label is None]
        if unlabelled:
            raise ValueError(_unlabelled_message(unlabelled))
        return [
            PanoramaTask(
                panorama_id=row.panorama_id,
                path=row.path,
                label=row.label,  # type: ignore[arg-type]
                timestamp=row.timestamp,
                special=row.special,
                provenance=row.provenance(),
            )
            for row in self.rows
        ]


def _unlabelled_message(names: Iterable[str]) -> str:
    return (
        "no Urban / non-Urban label found for: " + ", ".join(names) + ". Labels are read from "
        "the file name (*_Urban*, *_non-Urban*), an Urban/ or non-Urban/ sub-directory, a sidecar "
        "<name>.txt, or any CSV/JSON table in the directory with columns filename,label,timestamp,"
        "special (label may be Urban, non-Urban, U or NU). A default label applies to EVERY "
        "unlabelled panorama, so use it only when they really all share it."
    )


def _folders_between(root: Path | None, directory: Path) -> list[Path]:
    """The folders from `root` down to the parent of `directory` (none when it is not below it)."""
    if root is None or directory == root or not directory.is_relative_to(root):
        return []
    chain, folder = [], directory.parent
    while folder != root:
        chain.append(folder)
        folder = folder.parent
    return [root, *reversed(chain)]


def _scan(
    path: Path, notes: list[str], taken: set[str], *, also: Iterable[Path] = (), root: Path | None = None
) -> list[PreflightRow]:
    """What the files say about every image under `path`, later sources winning: a parent
    directory named after a label, the file name, a sidecar, then a manifest.

    `also` names further directories read exactly as `path` is, for a set whose files are spread
    over several folders (a dropped folder plus loose files). With `root`, the folder all of them
    lie under, `rel_path` is relative to it and a manifest in any folder between it and an image
    applies to that image too, the nearest one winning."""
    if path.is_dir():
        groups = [(path, _directory_images(path))]
    elif path.is_file():
        groups = [(path.parent, [path])]
    else:
        raise FileNotFoundError(f"no such panorama or directory: {path}")
    groups += [(Path(extra), _directory_images(Path(extra))) for extra in also]
    if not any(images for _, images in groups):
        raise ValueError(f"no panorama images ({', '.join(sorted(IMAGE_SUFFIXES))}) in {path}")

    stems = {image.stem.lower() for _, images in groups for image in images}
    manifests: dict[Path, dict[str, Meta]] = {}

    def manifest_of(folder: Path) -> dict[str, Meta]:
        if folder not in manifests:
            manifests[folder] = _manifest_meta(folder, stems, notes)
        return manifests[folder]

    rows: list[PreflightRow] = []
    seen: set[Path] = set()
    for directory, images in groups:
        outer = _folders_between(root, directory)
        for image in images:
            if image in seen:
                continue  # two of the directories overlap
            seen.add(image)
            meta: Meta = {}
            sources: dict[str, str] = {}

            def merge(found: Meta, source: str) -> None:
                meta.update(found)
                sources.update(dict.fromkeys(found, source))

            if image.parent != directory and (folder_label := _parse_label_cell(image.parent.name)) is not None:
                merge({"label": folder_label}, "folder")
            merge(_meta_from_text(image.stem), "filename")
            merge(_sidecar_meta(image), "sidecar")
            for folder in (*outer, directory, image.parent):
                manifest = manifest_of(folder)
                merge(manifest.get(image.stem.lower(), {}), "manifest")
                merge(manifest.get(image.name.lower(), {}), "manifest")
            label, special = meta.get("label"), bool(meta.get("special", False))
            base = root if root is not None and image.is_relative_to(root) else directory
            rows.append(
                PreflightRow(
                    panorama_id=_panorama_id(image, taken),
                    path=image,
                    filename=image.name,
                    rel_path=image.relative_to(base).as_posix(),
                    label=label,
                    timestamp=meta.get("timestamp"),
                    special=special,
                    sources={key: sources.get(key, "none") for key in _FIELDS},
                    parsed={
                        "label": label.value if label else None,
                        "timestamp": meta.get("timestamp"),
                        "special": special,
                    },
                )
            )
    return rows


def _task_notes(
    rows: list[PreflightRow], default_label: Label | None, defaulted: list[str], *, plain: bool = False
) -> list[str]:
    """What the operator should check before launching. `plain` is the console's wording; the
    command line keeps the sentence its users and scripts know."""
    notes = []
    if defaulted and plain:
        one = len(defaulted) == 1
        notes.append(
            f"label {default_label.value} was applied to {len(defaulted)} "  # type: ignore[union-attr]
            + ("panorama that had no label of its own: " if one else "panoramas that had no label of their own: ")
            + ", ".join(defaulted)
        )
    elif defaulted:
        notes.append(
            f"label {default_label.value} was applied by default to {len(defaulted)} panorama(s) with no "  # type: ignore[union-attr]
            "label of their own: " + ", ".join(defaulted)
        )
    flagged = [row.panorama_id for row in rows if row.special]
    if len(flagged) > 1:
        notes.append(f"{len(flagged)} panoramas are flagged as the Special One: " + ", ".join(flagged))
    missing_time = [row.panorama_id for row in rows if row.timestamp is None]
    if missing_time:
        notes.append("no capture timestamp (sun_position will be unavailable) for: " + ", ".join(missing_time))
    return notes


def load_tasks(
    path: Path,
    *,
    special: str | None = None,
    default_label: Label | None = None,
    warnings: list[str] | None = None,
) -> list[PanoramaTask]:
    """Tasks for a single image or every image in a directory.

    Label, timestamp and the Special One flag come from (later wins) a parent directory named
    after a label, the file name, a sidecar `<name>.txt` / `<name>.json`, then a manifest (any
    CSV/TSV/JSON table in the directory). `special` names the Special One by file name, stem or
    panorama id. A panorama with no discoverable label needs `default_label`: the label selects
    the scoring function, so we refuse to guess it. Anything the operator should check before
    launching (a defaulted label, an unreadable timestamp, several Special Ones) is appended to
    `warnings`.
    """
    notes: list[str] = [] if warnings is None else warnings
    rows = _scan(Path(path), notes, set())
    wanted = special.strip().lower() if special else None
    if wanted is not None:
        for row in rows:
            row.special = wanted in {row.filename.lower(), row.path.stem.lower(), row.panorama_id.lower()}
    unlabelled = [row for row in rows if row.label is None]
    if unlabelled and default_label is None:
        raise ValueError(_unlabelled_message(row.filename for row in unlabelled))
    for row in unlabelled:
        row.label = default_label
    if wanted is not None and not any(row.special for row in rows):
        raise ValueError(f"--special {special!r} matches none of: " + ", ".join(row.filename for row in rows))
    notes += _task_notes(rows, default_label, [row.filename for row in unlabelled])
    return [
        PanoramaTask(
            panorama_id=row.panorama_id,
            path=row.path,
            label=row.label,  # type: ignore[arg-type]
            timestamp=row.timestamp,
            special=row.special,
        )
        for row in rows
    ]


def _ignored_files(path: Path) -> list[str]:
    """Dot-files next to the panoramas (macOS resource forks, .DS_Store): skipped, but said so."""
    if not path.is_dir():
        return []
    folders = [path, *(p for p in path.iterdir() if p.is_dir() and _parse_label_cell(p.name) is not None)]
    return sorted(
        p.relative_to(path).as_posix()
        for folder in folders
        for p in folder.iterdir()
        if p.is_file() and p.name.startswith(".")
    )


def _resolve_row(key: Any, rows: list[PreflightRow]) -> PreflightRow:
    """The one row a key names: by panorama id, else path relative to the set, else file name,
    else stem. A key that fits none, or several (Urban/a.jpg and non-Urban/a.jpg), is an error:
    a choice that silently lands on no panorama changes the scoring function."""
    wanted = key.strip() if isinstance(key, str) else ""
    readers: tuple[Callable[[PreflightRow], str], ...] = (
        lambda row: row.panorama_id,
        lambda row: row.rel_path,
        lambda row: row.filename,
        lambda row: row.path.stem,
    )
    for read in readers if wanted else ():
        exact = [row for row in rows if read(row) == wanted]
        found = exact if len(exact) == 1 else [row for row in rows if read(row).lower() == wanted.lower()]
        if len(found) == 1:
            return found[0]
        if found:
            raise ValueError(
                f"{key!r} matches more than one panorama ({', '.join(row.rel_path for row in found)}); "
                "name it by panorama id"
            )
    raise ValueError(f"{key!r} matches no panorama")


def _checked_override(key: Any, change: Any) -> dict[str, Any]:
    """An override is a fixed choice, never free text: anything else is refused, because the
    timestamp and the label are written into the first message the model reads."""
    if not isinstance(change, Mapping):
        raise ValueError(f"override for {key!r} must be an object with label, timestamp and/or special")
    unknown = sorted(str(name) for name in change if name not in _FIELDS)
    if unknown:
        fields = "field" if len(unknown) == 1 else "fields"
        raise ValueError(f"override for {key!r} has unknown {fields} {', '.join(unknown)}; allowed: {', '.join(_FIELDS)}")
    checked: dict[str, Any] = {}
    if "label" in change:
        if not isinstance(change["label"], str) or change["label"] not in {label.value for label in Label}:
            raise ValueError(f"override for {key!r}: label must be exactly 'Urban' or 'non-Urban'")
        checked["label"] = Label(change["label"])
    if "timestamp" in change:
        stamp = change["timestamp"]
        if stamp is not None:
            if not isinstance(stamp, str) or not _OVERRIDE_TIMESTAMP_RE.fullmatch(stamp):
                raise ValueError(f"override for {key!r}: timestamp must be 14 digits (YYYYMMDDhhmmss) or null")
            try:
                datetime.strptime(stamp, "%Y%m%d%H%M%S")
            except ValueError:
                raise ValueError(f"override for {key!r}: timestamp is not a real date and time") from None
        checked["timestamp"] = stamp
    if "special" in change:
        if not isinstance(change["special"], bool):
            raise ValueError(f"override for {key!r}: special must be true or false")
        checked["special"] = change["special"]
    return checked


def _resolved_overrides(overrides: Mapping[Any, Any], rows: list[PreflightRow]) -> list[tuple[PreflightRow, dict[str, Any]]]:
    """Every override checked and matched to its row before any is applied; all problems at once."""
    resolved: list[tuple[PreflightRow, dict[str, Any]]] = []
    problems: list[str] = []
    for key, change in overrides.items():
        try:
            row, checked = _resolve_row(key, rows), _checked_override(key, change)
        except ValueError as exc:
            problems.append(str(exc))
            continue
        if any(row is other for other, _ in resolved):
            problems.append(f"{key!r} names a panorama that another override already names ({row.panorama_id})")
        resolved.append((row, checked))
    if problems:
        raise ValueError("; ".join(problems))
    return resolved


def load_tasks_detailed(
    path: Path,
    *,
    special: str | None = None,
    default_label: Label | None = None,
    overrides: Mapping[str, Mapping[str, Any]] | None = None,
    taken_ids: Iterable[str] | None = None,
    default_source: str = "default",
    also: Iterable[Path] = (),
    root: Path | None = None,
) -> Preflight:
    """load_tasks for a page that shows its working: one row per image with where each value came
    from, and no error for a missing label (the row has label None until someone chooses).

    `overrides` maps a panorama (id, relative path, file name or stem) to the operator's fixed
    choices {"label": "Urban"|"non-Urban", "timestamp": "YYYYMMDDhhmmss"|None, "special": bool};
    an overridden value has source "operator". `special` names the one Special One as in
    load_tasks (every other flag is cleared) and wins over files and overrides. `default_label`
    fills rows that still have none, recorded with source `default_source`. `taken_ids` are
    panorama ids already used by the run these rows will be added to, so the ids shown are the
    ids launched. `also` and `root` are for a set spread over several folders (see `_scan`).
    Raises ValueError for an override or `special` that is invalid, matches no row or matches
    several.
    """
    path = Path(path)
    also = [Path(extra) for extra in also]
    notes: list[str] = []
    rows = _scan(path, notes, set(taken_ids or ()), also=also, root=root)
    resolved = _resolved_overrides(overrides or {}, rows)
    chosen = None if special is None else _resolve_row(special, rows)
    if chosen is not None:
        contradicting = [
            row.panorama_id for row, change in resolved if change.get("special", row is chosen) is not (row is chosen)
        ]
        if contradicting:
            raise ValueError(
                f"the Special One is {chosen.panorama_id}, but an override says otherwise for: " + ", ".join(contradicting)
            )
    for row, change in resolved:
        for key, value in change.items():
            setattr(row, key, value)
            row.sources[key] = "operator"
    if chosen is not None:
        for row in rows:
            if row.special is not (row is chosen) or row is chosen:
                row.special, row.sources["special"] = row is chosen, "operator"
    defaulted = [row for row in rows if row.label is None] if default_label is not None else []
    for row in defaulted:
        row.label, row.sources["label"] = Label(default_label), default_source
    notes += _task_notes(rows, default_label, [row.filename for row in defaulted], plain=True)
    unlabelled = [row.filename for row in rows if row.label is None]
    if unlabelled:
        notes.append("no Urban / non-Urban label found for: " + ", ".join(unlabelled) + " (each needs one before launch)")
    ignored: list[str] = []
    for folder in (path, *also):
        below = root is not None and folder != root and folder.is_relative_to(root)
        prefix = folder.relative_to(root).as_posix() + "/" if below else ""  # type: ignore[arg-type]
        ignored += [prefix + name for name in _ignored_files(folder)]
    return Preflight(rows=rows, warnings=notes, ignored=sorted(set(ignored)))


def describe_tasks(tasks: Iterable[PanoramaTask]) -> list[str]:
    """One line per task for the operator to check before launch: a wrong label changes the
    scoring function, the allocator and the fallback point without any error."""
    return [
        f"{task.panorama_id:<32} {task.label.value:<10} timestamp={task.timestamp or '-':<15}"
        f"{'  SPECIAL ONE (x3)' if task.special else ''}"
        for task in tasks
    ]


def _read_events(path: Path) -> list[dict[str, Any]]:
    events = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:  # a torn last line after a crash
            continue
    return events


def _event_data(events: list[dict[str, Any]], type_: str) -> dict[str, Any]:
    return next((e.get("data") or {} for e in events if e.get("type") == type_), {})


def _panorama_info(panorama_id: str, run_start: Mapping[str, Any], task: PanoramaTask | None) -> dict[str, Any]:
    """Prefer the run_start event; fall back to the task for a panorama whose run never began."""
    info: dict[str, Any] = {"panorama_id": panorama_id, **(run_start.get("panorama") or {})}
    if task is not None:
        info.setdefault("filename", task.path.name)
    info["label"] = run_start.get("label") or (task.label.value if task else None)
    info["capture_timestamp"] = run_start.get("capture_timestamp") or (task.timestamp if task else None)
    info["special"] = bool(run_start.get("special", task.special if task else False))
    return info


def _summary_row(doc: Mapping[str, Any], problems: list[str]) -> dict[str, Any]:
    panorama, totals = doc["panorama"], doc.get("totals") or {}
    top = next(iter(doc["final"]["locations"]), {})
    return {
        "panorama": panorama["panorama_id"],
        "label": panorama.get("label"),
        "special": panorama.get("special"),
        "lat": top.get("lat"),
        "lng": top.get("lng"),
        "multiplier": top.get("multiplier"),
        "turns": totals.get("turns"),
        "cost_usd": totals.get("cost_usd"),
        "wall_time_s": totals.get("wall_time_s"),
        "stop_reason": totals.get("stop_reason"),
        "origin": top.get("origin"),
        "problems": "; ".join(problems),
    }


def _coordinate(value: Any) -> str:
    return f"{value:.6f}" if isinstance(value, (int, float)) else ""


def export_run(
    run_dir: Path,
    *,
    team: str,
    embed_images: bool = False,
    tasks: Mapping[str, PanoramaTask] | None = None,
) -> tuple[list[Path], list[dict[str, Any]]]:
    """Export every panorama that has an event log in run_dir, from the logs alone.

    Writes <panorama_id>.json per panorama, summary.csv and answers.csv; returns the paths and the
    summary rows. Validation problems land in each row's `problems` column instead of raising: at
    the freeze the operator needs every file plus a list of what is wrong, not a traceback.
    """
    run_dir = Path(run_dir)
    paths: list[Path] = []
    rows: list[dict[str, Any]] = []
    answers: list[tuple[str, Any, str, str]] = []
    for log_path in sorted(run_dir.glob(f"*{EVENTS_SUFFIX}")):
        panorama_id = log_path.name[: -len(EVENTS_SUFFIX)]
        run_start = _event_data(_read_events(log_path), "run_start")
        out_path = run_dir / f"{panorama_id}.json"
        doc = export_panorama(
            log_path,
            out_path,
            team=team,
            panorama=_panorama_info(panorama_id, run_start, (tasks or {}).get(panorama_id)),
            config={k: run_start.get(k) for k in ("model", "effort", "budget", "request", "flags", "git_sha")},
            embed_images=embed_images,
        )
        paths.append(out_path)
        rows.append(_summary_row(doc, validate_export(doc)))
        answers += [
            (panorama_id, loc.get("rank"), _coordinate(loc.get("lat")), _coordinate(loc.get("lng")))
            for loc in doc["final"]["locations"]
        ]

    summary_path, answers_path = run_dir / "summary.csv", run_dir / "answers.csv"
    summary = io.StringIO(newline="")
    writer = csv.DictWriter(summary, fieldnames=SUMMARY_COLUMNS)
    writer.writeheader()
    writer.writerows(rows)
    _replace_text(summary_path, summary.getvalue())
    table = io.StringIO(newline="")
    csv.writer(table).writerows([("panorama_id", "rank", "lat", "lng"), *answers])
    _replace_text(answers_path, table.getvalue())
    return [*paths, summary_path, answers_path], rows


def _replace_text(path: Path, text: str) -> None:
    """Two exports of one run can overlap (a job and the automatic one): each file is swapped in
    whole, so a reader never sees half a table or two tables interleaved."""
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def new_run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


# --- who is writing a run directory ---------------------------------------------------------------

LOCK_NAME = "run.lock"
# One id per process: a reader can tell "this server" from an earlier one that had the same pid.
BOOT_ID = secrets.token_hex(8)


def _process_started(pid: int) -> str | None:
    """When a process started, as `ps` prints it. A pid alone is reused after a reboot; the pair
    is not."""
    try:
        out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


@lru_cache(maxsize=1)
def _own_start() -> str | None:
    return _process_started(os.getpid())


def read_run_lock(run_dir: Path) -> dict[str, Any] | None:
    """The lock a RunManager holds on a run directory while start() is running: its content
    ({pid, boot_id, started_at, proc_start}) plus `alive` (that process still exists) and `own`
    (it is this process). None without a readable lock. A lock that is not alive is stale: its
    process died without cleaning up, and the run is interrupted."""
    try:
        lock = json.loads((Path(run_dir) / LOCK_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(lock, dict):
        return None
    pid = lock.get("pid")
    alive = isinstance(pid, int) and not isinstance(pid, bool) and pid > 0
    if alive:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            alive = False
        except OSError:  # it exists but belongs to someone else
            pass
    if alive and lock.get("proc_start"):
        started = _own_start() if pid == os.getpid() else _process_started(pid)
        alive = started is None or started == lock["proc_start"]
    return {**lock, "alive": alive, "own": alive and pid == os.getpid()}


# --- recovery -------------------------------------------------------------------------------------

# A log can hold several conversations (a reused run id, a retry); each begins with one of these.
START_MARKERS = frozenset({"run_start", "run_resumed", "retry"})


def open_segment(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The events of the conversation a log ends with: from its last start marker on."""
    last = max((i for i, event in enumerate(events) if event.get("type") in START_MARKERS), default=0)
    return events[last:]


def log_is_unfinished(events: list[dict[str, Any]]) -> bool:
    """True when the last conversation in a log has no run_end. Events after a run_end are legal
    (a geocode after final), so neither "has a run_end" nor "ends with one" is the test."""
    return not any(event.get("type") == "run_end" for event in open_segment(events))


def _task_from_log(panorama_id: str, events: list[dict[str, Any]]) -> PanoramaTask | None:
    start = _event_data(events, "run_start")
    try:
        return PanoramaTask(
            panorama_id=panorama_id,
            path=Path((start.get("panorama") or {})["path"]),
            label=Label(start["label"]),
            timestamp=start.get("capture_timestamp"),
            special=bool(start.get("special", False)),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _recover_panorama(task: PanoramaTask, settings: Settings, run_id: str, events: list[dict[str, Any]]) -> None:
    segment = open_segment(events)
    answered = next((e for e in reversed(segment) if e.get("type") == "final_submission"), None)
    responses = [e.get("data") or {} for e in segment if e.get("type") == "model_response"]
    tokens: dict[str, float] = {}
    for response in responses:
        for key, value in (response.get("usage") or {}).items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                tokens[key] = tokens.get(key, 0) + value
    # The session replays the log into its ledger, so what is written below carries the penalties
    # already charged; a bare EventLog would stamp x1.0 on them.
    session = PanoramaSession(task, settings, run_id)
    if answered is not None:
        # The answer was fixed before the process died (operator finalize, geocode); only its
        # run_end is missing. It is repeated as it stands, never recomputed: the session's
        # run_resumed opened a new conversation in the log, and the answer of record is the last
        # final_submission.
        data = answered.get("data") or {}
        session.log.emit(answered.get("actor") or "harness", "final_submission", {**data, "recovered": True})
        reason, origin = "recovered_final", data.get("origin")
    else:
        believed = bool(session.hypotheses) or session.human_override is not None
        reason = "recovered_from_provisional" if believed else "recovered_no_hypotheses"
        entries = session.finalize(reason=reason)
        origin = entries[0].origin if entries else None
    session.log.emit(
        "harness",
        "run_end",
        {
            "stop_reason": reason,
            "turns": len(responses),
            "tokens": tokens,
            "cost_usd": round(sum(float(r.get("cost_usd") or 0.0) for r in responses), 6),
            "wall_time_s": float(events[-1].get("t_rel_s") or 0.0) if events else 0.0,
            "final_origin": origin,
            "recovered": True,
        },
    )


def recover_run(
    run_dir: Path, *, settings: Settings, tasks: Mapping[str, PanoramaTask] | None = None
) -> list[str]:
    """Finish the logs of a run whose process died (kill -9, power loss), so that export_run
    yields valid files; returns the panorama ids it completed.

    Every panorama whose last conversation has no run_end gets one, and a final_submission built
    from its last hypotheses ("recovered_from_provisional"), from the fallback point
    ("recovered_no_hypotheses"), or repeated from the log when the answer was already fixed
    ("recovered_final"). `settings` must be the run's own frozen settings: they decide the
    allocation. `tasks` supplies panoramas that never wrote a log, and wins over the run_start
    of those that did; a panorama known from neither is left alone.

    Blocking (every event is fsync'd): run it in a thread, never on the event loop, and never on
    a run that some process is still writing, which the lock check refuses.
    """
    run_dir = Path(run_dir)
    lock = read_run_lock(run_dir)
    if lock is not None and lock["alive"]:
        raise RuntimeError(f"run {run_dir.name} is still being written by process {lock.get('pid')}; it cannot be recovered")
    settings = settings.model_copy(update={"runs_dir": run_dir.parent})
    known = dict(tasks or {})
    logs = {path.name[: -len(EVENTS_SUFFIX)]: path for path in run_dir.glob(f"*{EVENTS_SUFFIX}")}
    recovered: list[str] = []
    for panorama_id in sorted({*logs, *known}):
        events = _read_events(logs[panorama_id]) if panorama_id in logs else []
        if events and not log_is_unfinished(events):
            continue
        task = known.get(panorama_id) or _task_from_log(panorama_id, events)
        if task is None:
            continue  # nothing says what it was; it surfaces as an export problem
        _recover_panorama(task, settings, run_dir.name, events)
        recovered.append(panorama_id)
    (run_dir / LOCK_NAME).unlink(missing_ok=True)  # the dead owner's; nobody else will remove it
    return recovered


# --- the run --------------------------------------------------------------------------------------

# How a panorama can end without the agent ever answering; only these may be retried.
RETRYABLE_STOP_REASONS = frozenset({"api_error", "panorama_load_failed", "not_started"})
# Reasons with which the operator or the server closed the whole run.
_RUN_CLOSED_BY = frozenset({"operator_stop", "server_shutdown"})
# Set on a session by the eval harness (eval.run_eval.apply_leak_guards), not by its constructor.
_LEAK_GUARD_ATTRIBUTES = ("excluded_image_ids", "excluded_sequence_ids", "excluded_point")


class RunManager:
    """Owns the sessions of one run and drives them in parallel with shared clients.

    Sessions may be touched from any thread, but scheduling is not thread-safe: while start() is
    running, add_tasks, retry, finalize and stop belong to its event loop."""

    def __init__(
        self,
        settings: Settings,
        run_id: str | None = None,
        client: ModelClient | None = None,
        live: bool = False,
        boot_id: str | None = None,
    ) -> None:
        self.settings = settings
        self.run_id = run_id or new_run_id()
        self.run_dir = Path(settings.runs_dir) / self.run_id
        self.live = live
        self.boot_id = boot_id or BOOT_ID
        self.sessions: dict[str, PanoramaSession] = {}
        self.summary: list[dict[str, Any]] = []
        self._client = client
        self._started_at: float | None = None
        self._entered: set[str] = set()  # panoramas whose run began (and so writes its own run_end)
        self._export_lock = threading.Lock()  # exports may be requested from a worker thread
        # State of the start() in flight. Late additions and retries are run by the same
        # semaphore, clients and watchdog as the panoramas that were there from the beginning.
        self._accepting = False
        self._starts = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._jobs: dict[str, asyncio.Task[None]] = {}
        self._scheduled: dict[str, PanoramaSession] = {}
        self._semaphore: asyncio.Semaphore | None = None
        self._http: Any = None
        self._model: ModelClient | None = None
        self._watchdog_at: float | None = None
        self._lock_text: str | None = None
        self._closed_by: str | None = None
        self._last_end: dict[str, str | None] = {}  # stop_reason of each panorama's last conversation
        self._watched: set[int] = set()
        self._on_session: list[Callable[[PanoramaSession], None]] = []

    @property
    def is_running(self) -> bool:
        """True while start() takes panoramas: an addition or a retry made now is run by it."""
        return self._accepting

    @property
    def _finished(self) -> bool:
        return self._started_at is not None and not self._accepting and self._starts == 0

    def on_session(self, callback: Callable[[PanoramaSession], None]) -> None:
        """Call `callback` with every session created from now on (add_tasks, retry), before it
        can emit anything from a run."""
        self._on_session.append(callback)

    def watchdog_remaining_s(self) -> float | None:
        """Seconds until the watchdog finalises everything; it counts from each start()."""
        if not self._accepting or self._watchdog_at is None:
            return None
        return max(0.0, self._watchdog_at - time.monotonic())

    def add_tasks(self, tasks: Iterable[PanoramaTask]) -> None:
        """Create a session per task. While start() is running the new panoramas are scheduled
        at once; otherwise they wait for the next start()."""
        tasks = list(tasks)
        ids = [task.panorama_id for task in tasks]
        for panorama_id in ids:
            if panorama_id in self.sessions or ids.count(panorama_id) > 1:
                raise ValueError(f"duplicate panorama_id: {panorama_id}")
        if self._accepting:
            self._require_loop("add_tasks")
        self._refuse_foreign_owner()
        for task in tasks:
            self._adopt(PanoramaSession(task, self.settings, self.run_id))

    def retry(self, panorama_id: str) -> PanoramaSession:
        """A new conversation for a panorama that ended without the agent answering, in the same
        log: the fresh session replays it, so penalties already charged carry over. Raises
        ValueError when the panorama may not be retried."""
        old = self.sessions[panorama_id]
        previous = self._last_end.get(panorama_id)
        refusal = self._retry_refusal(old, previous)
        if refusal:
            raise ValueError(f"{panorama_id} cannot be retried: {refusal}")
        if self._accepting:
            self._require_loop("retry")
        old.log.emit("harness", "retry", {"previous_stop_reason": previous})
        # The same EventLog object: one seq counter, and whoever listens to it keeps listening.
        session = PanoramaSession(old.task, self.settings, self.run_id, log=old.log)
        for name in _LEAK_GUARD_ATTRIBUTES:
            if hasattr(old, name):
                setattr(session, name, getattr(old, name))
        session.mcq_allowed = old.mcq_allowed
        self._entered.discard(panorama_id)
        self._adopt(session)
        return session

    def _retry_refusal(self, session: PanoramaSession, previous: str | None) -> str | None:
        if session.final is None:
            return "it has not ended"
        if session.human_override is not None or session.final[0].origin == "human_geocode":
            return "its answer is the human geocode, which a new conversation could not change"
        if previous not in RETRYABLE_STOP_REASONS:
            return (
                f"it ended with {previous or 'no run_end'}; only {', '.join(sorted(RETRYABLE_STOP_REASONS))} "
                "leave a panorama without an agent answer"
            )
        if not self._accepting and self._closed_by is not None:
            return f"the run was closed ({self._closed_by})"
        return None

    def _adopt(self, session: PanoramaSession) -> None:
        panorama_id = session.task.panorama_id
        self.sessions[panorama_id] = session
        if id(session.log) not in self._watched:  # a retry reuses the log; one listener is enough
            self._watched.add(id(session.log))
            session.log.add_listener(self._note_event)
        for callback in self._on_session:
            try:
                callback(session)
            except Exception:  # a broken observer must not leave the panorama unscheduled
                continue
        if self._accepting:
            self._spawn(session)

    def _note_event(self, envelope: dict[str, Any]) -> None:
        kind = envelope.get("type")
        if kind == "run_end":
            self._last_end[envelope["panorama_id"]] = (envelope.get("data") or {}).get("stop_reason")
        elif kind in START_MARKERS:
            self._last_end[envelope["panorama_id"]] = None

    def _require_loop(self, what: str) -> None:
        try:
            running: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is not self._loop:
            raise RuntimeError(f"{what} must be called on the event loop that is running this run")

    def _refuse_foreign_owner(self) -> None:
        """Two processes appending to the same logs give duplicate seq numbers and two answers."""
        lock = read_run_lock(self.run_dir)
        if lock is not None and lock["alive"] and not lock["own"]:
            raise RuntimeError(
                f"run {self.run_id} is being written by another process (pid {lock.get('pid')}); use another run id"
            )

    def _take_lock(self) -> None:
        if self._lock_text is not None:
            return
        self._refuse_foreign_owner()
        text = json.dumps(
            {
                "pid": os.getpid(),
                "boot_id": self.boot_id,
                "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                "proc_start": _own_start(),
            }
        )
        path = self.run_dir / LOCK_NAME
        try:
            self.run_dir.mkdir(parents=True, exist_ok=True)
            for _ in range(2):
                try:
                    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
                except FileExistsError:
                    path.unlink(missing_ok=True)  # stale, or left by an earlier start() of this process
                    continue
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(text)
                self._lock_text = text
                return
        except OSError:
            pass  # a lock that cannot be written must not stop the run

    def _release_lock(self) -> None:
        text, self._lock_text = self._lock_text, None
        path = self.run_dir / LOCK_NAME
        try:
            if text is not None and path.read_text(encoding="utf-8") == text:
                path.unlink()
        except OSError:
            pass

    def _spawn(self, session: PanoramaSession) -> None:
        assert self._semaphore is not None and self._model is not None
        self._take_lock()
        panorama_id = session.task.panorama_id
        self._scheduled[panorama_id] = session
        self._jobs[panorama_id] = asyncio.create_task(
            self._run_one(session, self._model, self._http, self._semaphore)
        )

    async def start(self, concurrency: int | None = None) -> None:
        """Run every session that is still pending, and any added or retried meanwhile; returns
        when all have a final answer."""
        if self._accepting:
            raise RuntimeError(f"run {self.run_id} is already started; panoramas added now are picked up by it")
        pending = [s for s in self.sessions.values() if s.status == "pending" and s.final is None]
        if pending:
            self._take_lock()  # before anything is spent: a run owned elsewhere is refused here
        self._starts += 1
        self._loop = asyncio.get_running_loop()
        self._started_at, self._closed_by = time.monotonic(), None
        self._watchdog_at = self._started_at + self.settings.global_watchdog_s
        self._semaphore = asyncio.Semaphore(concurrency or self.settings.concurrency)
        self._http = http = make_http_client(self.settings) if self.settings.allow_web else None
        owned_client = (
            None
            if self._client is not None
            else OpenAIModelClient(
                read_timeout_s=self.settings.api_read_timeout_s, image_detail=self.settings.image_detail
            )
        )
        self._model = self._client or owned_client
        self._jobs, self._scheduled = {}, {}
        self._accepting = True
        try:
            for session in pending:
                self._spawn(session)
            while self._accepting:
                live = [job for job in self._jobs.values() if not job.done()]
                if not live:
                    break
                remaining = self._watchdog_at - time.monotonic()
                if remaining <= 0:
                    self.finalize_all("global_watchdog")
                    break
                await asyncio.wait(live, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
        finally:
            # Closed before the first await below: a panorama added from here on is not scheduled
            # by this start() and would not be swept by it either, so it must wait for the next.
            self._accepting = False
            jobs, scheduled = list(self._jobs.values()), list(self._scheduled.values())
            try:
                for job in jobs:
                    job.cancel()
                await asyncio.gather(*jobs, return_exceptions=True)
                for session in scheduled:
                    if session.task.panorama_id not in self._entered:
                        self._end_unstarted(session)
                if http is not None:
                    await http.aclose()
                if owned_client is not None:
                    await owned_client.aclose()
            finally:
                self._release_lock()
                self._starts -= 1

    def start_background(self, concurrency: int | None = None) -> asyncio.Task[None]:
        return asyncio.create_task(self.start(concurrency))

    async def _run_one(
        self,
        session: PanoramaSession,
        client: ModelClient,
        http: Any,
        semaphore: asyncio.Semaphore,
    ) -> None:
        async with semaphore:
            if session.final is not None:
                return
            self._entered.add(session.task.panorama_id)
            # Deadlines count from when this panorama actually starts, not from when it queued.
            session.started_monotonic = time.monotonic()
            if session.human_override is not None:
                # Restored from an earlier run under the same run id: the answer is locked to the
                # human point, so running the agent again could only spend money and penalties.
                self._end_without_agent(session, "human_geocode_restored")
                return
            budget = self.settings.budget_for(session.task.special, live=self.live)
            try:
                pano = await asyncio.to_thread(Panorama, session.task.path, session.image_dir)
            except asyncio.CancelledError:
                # Stopped while the image was loading: the agent never began, so nobody else
                # would write this panorama's run_end.
                self._end_without_agent(session, "cancelled")
                raise
            except Exception as exc:
                session.log.emit("harness", "harness_error", {"where": "panorama_load", "error": repr(exc)})
                self._end_without_agent(session, "panorama_load_failed")
                return
            await run_agent(session, pano, client, budget=budget, http=http)

    @staticmethod
    def _end_without_agent(session: PanoramaSession, stop_reason: str) -> None:
        """Final answer and run_end for a panorama the agent never worked on."""
        entries = session.finalize(reason=stop_reason)
        session.log.emit(
            "harness",
            "run_end",
            {
                "stop_reason": stop_reason,
                "turns": 0,
                "tokens": {},
                "cost_usd": 0.0,
                "wall_time_s": round(session.elapsed_s(), 3),
                "final_origin": entries[0].origin if entries else None,
            },
        )

    def _end_unstarted(self, session: PanoramaSession) -> None:
        """A panorama still queued when the run ended (watchdog, operator finalise, interrupt)
        gets the fallback answer and a run_end, so its export is as complete as the others."""
        self._entered.add(session.task.panorama_id)
        self._end_without_agent(session, "not_started")

    def finalize(self, panorama_id: str, reason: str) -> list[Entry]:
        """Fix one panorama's answer and stop working on it now. The answer alone would leave its
        model call running (and spending) until it returned, and a queued panorama without a
        run_end until the whole run ended."""
        session = self.sessions[panorama_id]
        entries = session.finalize(reason=reason)
        self._halt(session)
        return entries

    def _halt(self, session: PanoramaSession) -> None:
        panorama_id = session.task.panorama_id
        job = self._jobs.get(panorama_id)
        if job is not None and not job.done():
            job.cancel()  # in flight: run_agent writes run_end "cancelled" on its way out
        if panorama_id not in self._entered:
            self._end_unstarted(session)  # never began, and cancelled above it never will

    def finalize_all(self, reason: str) -> None:
        if reason in _RUN_CLOSED_BY:
            self._closed_by = reason
        for session in list(self.sessions.values()):
            session.finalize(reason=reason)

    def stop(self, reason: str) -> None:
        """Finalise everything with the best-so-far answers and cancel what is still in flight,
        as Ctrl-C does: every panorama ends up with a run_end ("cancelled" when it was running,
        "not_started" when it was queued) and start() returns once the jobs have unwound."""
        self.finalize_all(reason)
        self._accepting = False  # nothing added from now on may be scheduled by the start() being stopped
        for session in list(self.sessions.values()):
            self._halt(session)

    def export_all(self) -> list[Path]:
        with self._export_lock:
            paths, self.summary = export_run(
                self.run_dir,
                team=self.settings.team,
                embed_images=self.settings.embed_images,
                tasks={pid: s.task for pid, s in list(self.sessions.items())},
            )
        return paths

    def snapshot(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "run_dir": str(self.run_dir),
            "live": self.live,
            "started": self._started_at is not None,
            "finished": self._finished,
            "elapsed_s": None if self._started_at is None else round(time.monotonic() - self._started_at, 1),
            "watchdog_s": self.settings.global_watchdog_s,
            "spend_usd": round(sum(s.spend_usd for s in self.sessions.values()), 4),
            "panoramas": {pid: s.snapshot() for pid, s in self.sessions.items()},
        }
