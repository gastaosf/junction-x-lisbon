"""Run orchestration (SPEC section 10): task loading, parallel runs, watchdog, exports."""

from __future__ import annotations

import asyncio
import csv
import json
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from .config import Settings
from .eventlog import export_panorama, validate_export
from .loop import AnthropicModelClient, ModelClient, run_agent
from .pano import Panorama
from .schema import Label, PanoramaTask
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
    path = Path(path)
    notes: list[str] = [] if warnings is None else warnings
    if path.is_dir():
        directory, images = path, _directory_images(path)
    elif path.is_file():
        directory, images = path.parent, [path]
    else:
        raise FileNotFoundError(f"no such panorama or directory: {path}")
    if not images:
        raise ValueError(f"no panorama images ({', '.join(sorted(IMAGE_SUFFIXES))}) in {path}")

    stems = {image.stem.lower() for image in images}
    manifests: dict[Path, dict[str, Meta]] = {}
    for folder in {directory, *(image.parent for image in images)}:
        manifests[folder] = _manifest_meta(folder, stems, notes)
    wanted = special.strip().lower() if special else None
    taken: set[str] = set()
    tasks: list[PanoramaTask] = []
    unlabelled: list[str] = []
    defaulted: list[str] = []
    for image in images:
        meta: Meta = {}
        if image.parent != directory and (folder_label := _parse_label_cell(image.parent.name)) is not None:
            meta["label"] = folder_label
        meta.update(_meta_from_text(image.stem))
        meta.update(_sidecar_meta(image))
        for manifest in (manifests[directory], manifests[image.parent]):
            meta.update(manifest.get(image.stem.lower(), {}))
            meta.update(manifest.get(image.name.lower(), {}))
        panorama_id = _panorama_id(image, taken)
        if wanted is not None:
            meta["special"] = wanted in {image.name.lower(), image.stem.lower(), panorama_id.lower()}
        label = meta.get("label")
        if label is None:
            if default_label is None:
                unlabelled.append(image.name)
                continue
            label = default_label
            defaulted.append(image.name)
        tasks.append(
            PanoramaTask(
                panorama_id=panorama_id,
                path=image,
                label=label,
                timestamp=meta.get("timestamp"),
                special=bool(meta.get("special", False)),
            )
        )
    if unlabelled:
        raise ValueError(
            "no Urban / non-Urban label found for: " + ", ".join(unlabelled) + ". Labels are read from "
            "the file name (*_Urban*, *_non-Urban*), an Urban/ or non-Urban/ sub-directory, a sidecar "
            "<name>.txt, or any CSV/JSON table in the directory with columns filename,label,timestamp,"
            "special (label may be Urban, non-Urban, U or NU). A default label applies to EVERY "
            "unlabelled panorama, so use it only when they really all share it."
        )
    if wanted is not None and not any(t.special for t in tasks):
        raise ValueError(f"--special {special!r} matches none of: " + ", ".join(i.name for i in images))
    if defaulted:
        notes.append(
            f"label {default_label.value} was applied by default to {len(defaulted)} panorama(s) with no "  # type: ignore[union-attr]
            "label of their own: " + ", ".join(defaulted)
        )
    flagged = [t.panorama_id for t in tasks if t.special]
    if len(flagged) > 1:
        notes.append(f"{len(flagged)} panoramas are flagged as the Special One: " + ", ".join(flagged))
    missing_time = [t.panorama_id for t in tasks if t.timestamp is None]
    if missing_time:
        notes.append("no capture timestamp (sun_position will be unavailable) for: " + ", ".join(missing_time))
    return tasks


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
    with summary_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=SUMMARY_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    with answers_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(("panorama_id", "rank", "lat", "lng"))
        writer.writerows(answers)
    return [*paths, summary_path, answers_path], rows


def new_run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


class RunManager:
    """Owns the sessions of one run and drives them in parallel with shared clients."""

    def __init__(
        self,
        settings: Settings,
        run_id: str | None = None,
        client: ModelClient | None = None,
        live: bool = False,
    ) -> None:
        self.settings = settings
        self.run_id = run_id or new_run_id()
        self.run_dir = Path(settings.runs_dir) / self.run_id
        self.live = live
        self.sessions: dict[str, PanoramaSession] = {}
        self.summary: list[dict[str, Any]] = []
        self._client = client
        self._started_at: float | None = None
        self._finished = False
        self._entered: set[str] = set()  # panoramas whose run began (and so writes its own run_end)
        self._export_lock = threading.Lock()  # exports may be requested from a worker thread

    def add_tasks(self, tasks: Iterable[PanoramaTask]) -> None:
        for task in tasks:
            if task.panorama_id in self.sessions:
                raise ValueError(f"duplicate panorama_id: {task.panorama_id}")
            self.sessions[task.panorama_id] = PanoramaSession(task, self.settings, self.run_id)

    async def start(self, concurrency: int | None = None) -> None:
        """Run every session that is still pending; returns when all have a final answer."""
        self._started_at, self._finished = time.monotonic(), False
        pending = [s for s in self.sessions.values() if s.status == "pending" and s.final is None]
        semaphore = asyncio.Semaphore(concurrency or self.settings.concurrency)
        http = make_http_client(self.settings) if self.settings.allow_web else None
        owned_client = (
            None
            if self._client is not None
            else AnthropicModelClient(read_timeout_s=self.settings.api_read_timeout_s)
        )
        client = self._client or owned_client
        jobs = [asyncio.create_task(self._run_one(s, client, http, semaphore)) for s in pending]
        try:
            if jobs:
                _, late = await asyncio.wait(jobs, timeout=self.settings.global_watchdog_s)
                if late:
                    self.finalize_all("global_watchdog")
        finally:
            for job in jobs:
                job.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
            for session in pending:
                if session.task.panorama_id not in self._entered:
                    self._end_unstarted(session)
            if http is not None:
                await http.aclose()
            if owned_client is not None:
                await owned_client.aclose()
            self._finished = True

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

    def finalize_all(self, reason: str) -> None:
        for session in self.sessions.values():
            session.finalize(reason=reason)

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
