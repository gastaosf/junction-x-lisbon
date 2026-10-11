"""The submission checklist and the files that get handed in (UI-SPEC 5.8).

The event logs are the record and the exports are what is submitted; the checklist says whether
the second still tells the first's story. It is decided from the files on disk, so it reads the
same for a run this server holds and for one found in the runs directory. The run's state only
says which panoramas there are and how far each one got.

Downloads come from an allow-list (the run's `<panorama_id>.json`, answers.csv, summary.csv) and
never from a directory walk: run.json, the lock, the logs and evaluation results cannot leave
through here. The zip is checked and packed from one read of each file, so what was validated is
byte for byte what is downloaded.

Everything here blocks (it reads logs and exports): call it from a worker thread.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
import zipfile
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from astrolabio.eventlog import validate_export
from astrolabio.runner import EVENTS_SUFFIX, START_MARKERS
from astrolabio.scoring import penalty_multiplier

from .devmodel import MODEL_NAME as FAKE_MODEL_NAME
from .runstate import iter_events
from .security import confine, safe_id
from .sets import ConsoleError
from .words import count, plural

__all__ = ["allowed_files", "media_type", "submission_file", "submission_zip", "validate_run"]

ANSWERS_NAME = "answers.csv"
SUMMARY_NAME = "summary.csv"
ENTRIES = 10

LABELS: dict[str, str] = {
    "all_final": "Every panorama is final",
    "ten_entries": "Ten entries each",
    "exports_valid": "Exports valid",
    "ledger": "Ledger consistent",
    "files_fresh": "Files match the page",
    "no_fallback": "No fallback answers",
    "real_model": "Real model",
}
_PENALISED: dict[str, str] = {"human_cue": "cues", "mcq_asked": "mcqs", "human_geocode": "human_geocodes"}
_NOT_FINAL: dict[str, str] = {
    "pending": "queued",
    "running": "running",
    "awaiting_mcq": "waiting for an answer to its question",
    "interrupted": "interrupted: the server stopped while it was running",
}
# What the console keeps in a run directory for itself. A panorama called "run" would have its
# export take one of these names; it is not served as one.
_RESERVED_RE = re.compile(r"^(?:run|results(?:\..+)?)\.json$")
_MEDIA_TYPES = {".json": "application/json", ".csv": "text/csv; charset=utf-8"}
_SUMMARY_FLOATS = ("lat", "lng", "multiplier", "cost_usd", "wall_time_s")
_SUMMARY_TEXTS = ("label", "stop_reason", "origin")
_TOLERANCE = 1e-9

Problem = tuple[str, str]  # (panorama id, what is wrong with it)


# ---------------------------------------------------------------------------------------------
# the allow-list


def _export_name(panorama_id: Any) -> str | None:
    try:
        name = f"{safe_id(panorama_id, 'panorama id')}.json"
    except ValueError:
        return None
    return None if _RESERVED_RE.match(name) else name


def allowed_files(panorama_ids: Iterable[Any]) -> list[str]:
    """The names a run may hand out, in the order they are packed: one export per panorama, then
    the two tables."""
    exports = dict.fromkeys(name for name in map(_export_name, panorama_ids) if name is not None)
    return [*exports, ANSWERS_NAME, SUMMARY_NAME]


def submission_file(run_dir: Path, name: str, panorama_ids: Iterable[Any]) -> Path:
    """Where the submission file `name` of a run is. `name` is looked up, never joined as a path:
    KeyError when it is not one of the run's files or is not there, PermissionError when what
    sits under that name is a link to something else."""
    if name not in allowed_files(panorama_ids):
        raise KeyError(name)
    try:
        root = confine(run_dir, run_dir)
        path = confine(root / name, root)
    except FileNotFoundError:
        raise KeyError(name) from None
    if path != root / name:
        # inside the run directory is not enough: a link could name run.json or a log
        raise PermissionError(f"{name} is a link, not a file of this run")
    if not path.is_file():
        raise KeyError(name)
    return path


def media_type(name: str) -> str:
    return _MEDIA_TYPES.get(Path(name).suffix, "application/octet-stream")


# ---------------------------------------------------------------------------------------------
# what the files say


@dataclass
class _Log:
    """What a panorama's event log says about its ending."""

    last_seq: Any = None
    counts: dict[str, int] = field(default_factory=lambda: dict.fromkeys(_PENALISED.values(), 0))
    final: dict[str, Any] | None = None  # the last final_submission: {penalty_state, entries}
    scope: str | None = None  # penalty scope of the conversation the log ends with
    closed: bool = False  # that conversation has its run_end


@dataclass
class _Export:
    problems: list[str]  # validate_export
    locations: list[Any]
    state: Any  # final.penalty_state
    last_seq: Any


@dataclass
class _Facts:
    tiles: list[Mapping[str, Any]]
    logs: dict[str, _Log | None] = field(default_factory=dict)
    exports: dict[str, _Export | None] = field(default_factory=dict)
    answers: list[dict[str, str]] | None = None  # None: there is no such file
    summary: list[dict[str, str]] | None = None
    files: list[dict[str, Any]] = field(default_factory=list)


def _read_log(path: Path) -> _Log | None:
    if not path.is_file():
        return None
    log = _Log()
    for event in iter_events(path):
        kind, data = event.get("type"), event.get("data")
        log.last_seq = event.get("seq", log.last_seq)
        if kind in _PENALISED:
            log.counts[_PENALISED[kind]] += 1
        if kind in START_MARKERS:
            log.closed = False
        if kind == "run_start" and isinstance(data, dict) and isinstance(data.get("flags"), dict):
            log.scope = data["flags"].get("penalty_scope")
        elif kind == "final_submission":
            entries = data.get("entries") if isinstance(data, dict) else None
            log.final = {"penalty_state": event.get("penalty_state"), "entries": entries}
        elif kind == "run_end":
            log.closed = True
    return log


def _read_export(data: bytes) -> _Export:
    try:
        doc = json.loads(data)
    except ValueError:
        return _Export(["the file is not valid JSON"], [], None, None)
    try:
        problems = validate_export(doc)
    except Exception as exc:  # a hand-edited file: the operator needs the list, not a traceback
        problems = [f"the file could not be validated ({type(exc).__name__})"]
    final = doc.get("final") if isinstance(doc, dict) else None
    final = final if isinstance(final, dict) else {}
    events = doc.get("events") if isinstance(doc, dict) else None
    last = events[-1] if isinstance(events, list) and events else None
    locations = final.get("locations")
    return _Export(
        problems,
        locations if isinstance(locations, list) else [],
        final.get("penalty_state"),
        last.get("seq") if isinstance(last, dict) else None,
    )


def _table(data: bytes | None) -> list[dict[str, str]] | None:
    if data is None:
        return None
    try:
        reader = csv.DictReader(io.StringIO(data.decode("utf-8", "replace"), newline=""))
        return [{key: value or "" for key, value in row.items() if isinstance(key, str)} for row in reader]
    except csv.Error:
        return []


def _modified(epoch_s: float) -> str:
    return datetime.fromtimestamp(epoch_s, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _gather(run_dir: Path, run: Mapping[str, Any], archive: zipfile.ZipFile | None = None) -> _Facts:
    """Read every submission file of the run once, and each panorama's log. With `archive`, the
    bytes that were read are the bytes that are packed."""
    tiles = [tile for tile in run.get("panoramas") or [] if isinstance(tile.get("panorama_id"), str)]
    facts = _Facts(tiles)
    panorama_ids = [tile["panorama_id"] for tile in tiles]

    def take(name: str | None) -> bytes | None:
        if name is None:
            return None
        try:
            path = submission_file(run_dir, name, panorama_ids)
            data, modified = path.read_bytes(), path.stat().st_mtime
        except (KeyError, OSError):  # not there, or a link: either way not a file of this run
            return None
        facts.files.append(
            {"name": name, "path": str(path), "size_bytes": len(data), "modified_at": _modified(modified)}
        )
        if archive is not None:
            archive.writestr(name, data)
        return data

    for panorama_id in panorama_ids:
        data = take(_export_name(panorama_id))
        facts.exports[panorama_id] = None if data is None else _read_export(data)
        try:
            log_path = confine(run_dir / f"{safe_id(panorama_id, 'panorama id')}{EVENTS_SUFFIX}", run_dir)
            facts.logs[panorama_id] = _read_log(log_path)
        except (ValueError, OSError):
            facts.logs[panorama_id] = None
    facts.answers = _table(take(ANSWERS_NAME))
    facts.summary = _table(take(SUMMARY_NAME))
    return facts


# ---------------------------------------------------------------------------------------------
# the checks


def _panoramas(n: int) -> str:
    return count(n, "panorama")


def _check(
    check_id: str,
    problems: list[Problem],
    *,
    ok: str,
    bad: str,
    action: str | None = None,
    level: str = "fail",
    broken: bool = False,
) -> dict[str, Any]:
    """One row of the checklist. `problems` name the panoramas at fault; `broken` fails the check
    for a reason that belongs to no single panorama (it is then told in `bad`)."""
    failed = bool(problems) or broken
    return {
        "id": check_id,
        "label": LABELS[check_id],
        "status": level if failed else "pass",
        "detail": bad if failed else ok,
        "items": [{"panorama_id": panorama_id, "text": text} for panorama_id, text in problems],
        "action": action if failed else None,
    }


def _remedy(run: Mapping[str, Any], tiles: list[Mapping[str, Any]]) -> str | None:
    """What puts the files right. While this server is still working on the run that is Finalize
    all (which also writes the files); for a run on disk it is a rebuild, which first finishes
    the logs of an interrupted one. A run another process is writing can only be waited for."""
    if run.get("owned") and any(tile.get("status") != "done" for tile in tiles):
        return "finalize_all"
    return None if run.get("external") else "rebuild"


def _all_final(facts: _Facts, run: Mapping[str, Any], remedy: str | None) -> dict[str, Any]:
    problems: list[Problem] = []
    for tile in facts.tiles:
        panorama_id, status = tile["panorama_id"], tile.get("status")
        log = facts.logs.get(panorama_id)
        # On disk an answer is not the end: one fixed by the operator just before the server died
        # has no run_end, and only a rebuild closes its log.
        if status == "done" and (run.get("owned") or log is None or log.closed):
            continue
        if run.get("external"):
            problems.append((panorama_id, "still being run by another process"))
        elif status == "done":
            problems.append((panorama_id, "final, but the server stopped before its log was closed"))
        else:
            problems.append((panorama_id, _NOT_FINAL.get(str(status), str(status))))
    total = len(facts.tiles)
    if not total:
        return _check("all_final", [], ok="", bad="This run has no panoramas.", broken=True)
    one = len(problems) == 1
    next_step = {
        "finalize_all": "Finalize all fixes every answer as it stands.",
        "rebuild": (
            "The server stopped while it was running: Rebuild exports finishes it from its last provisional list."
            if one
            else "The server stopped while they were running: Rebuild exports finishes them from their last "
            "provisional list."
        ),
        None: "Another process is running this run: wait for it to end.",
    }[remedy]
    bad = f"{len(problems)} of {_panoramas(total)} {plural(len(problems), 'is')} not finished. {next_step}"
    ok = "The 1 panorama is final." if total == 1 else f"All {total} panoramas are final."
    return _check("all_final", problems, ok=ok, bad=bad, action=remedy)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _entry_problems(locations: list[Any]) -> list[str]:
    problems = [] if len(locations) == ENTRIES else [f"{len(locations)} entries, not {ENTRIES}"]
    for rank, entry in enumerate(locations, start=1):
        for name, limit in (("lat", 90.0), ("lng", 180.0)):
            value = entry.get(name) if isinstance(entry, dict) else None
            if not _is_number(value):
                problems.append(f"entry {rank}: {name} is not a number")
            elif abs(value) > limit:
                problems.append(f"entry {rank}: {name} {value} is outside +/-{limit:g}")
            elif abs(round(value, 6) - value) > 1e-12:
                problems.append(f"entry {rank}: {name} {value} has more than 6 decimals")
    return problems


def _ten_entries(facts: _Facts, remedy: str | None) -> dict[str, Any]:
    problems: list[Problem] = []
    for panorama_id, export in facts.exports.items():
        found = ["no export file"] if export is None else _entry_problems(export.locations)
        if found:
            problems.append((panorama_id, "; ".join(found)))
    return _check(
        "ten_entries",
        problems,
        ok=f"Every export lists {ENTRIES} points with 6 decimals, in range.",
        bad=f"{_panoramas(len(problems))} without a clean list of {ENTRIES} points.",
        action=remedy,
    )


def _exports_valid(facts: _Facts, remedy: str | None) -> dict[str, Any]:
    problems: list[Problem] = []
    for panorama_id, export in facts.exports.items():
        found = ["no export file"] if export is None else export.problems
        if found:
            problems.append((panorama_id, "; ".join(found)))
    return _check(
        "exports_valid",
        problems,
        ok="Every export passes validation.",
        bad=f"{_panoramas(len(problems))} with an export that is missing or not fit to submit.",
        action=remedy,
    )


def _ledger_problem(log: _Log) -> str | None:
    """How a log's final penalty state disagrees with the penalised events it records, if it does."""
    state = (log.final or {}).get("penalty_state")
    if not isinstance(state, dict):
        return "the final answer carries no penalty state"
    for key, counted in log.counts.items():
        if state.get(key) != counted:
            kind = key.replace("_", " ")
            return f"the final state counts {state.get(key)!r} {kind}, the log records {counted}"
    expected = penalty_multiplier(**log.counts)
    multiplier = state.get("multiplier")
    if not _is_number(multiplier) or abs(multiplier - expected) > _TOLERANCE:
        return f"the final multiplier is {multiplier!r}, the penalties recorded make x{expected:g}"
    # under "subsequent" (R9 read literally) a slot fixed before a penalty keeps its earlier, higher one
    ceiling = 1.0 if log.scope == "subsequent" else multiplier
    entries = (log.final or {}).get("entries")
    for rank, entry in enumerate(entries if isinstance(entries, list) else [], start=1):
        stamped = entry.get("multiplier") if isinstance(entry, dict) else None
        if not _is_number(stamped) or not multiplier - _TOLERANCE <= stamped <= ceiling + _TOLERANCE:
            return f"entry {rank} is stamped x{stamped!r}, the ledger says x{multiplier:g}"
    return None


def _ledger(facts: _Facts, remedy: str | None) -> dict[str, Any]:
    problems: list[Problem] = []
    unanswered = stale = wrong = 0
    for tile in facts.tiles:
        panorama_id = tile["panorama_id"]
        log, export = facts.logs.get(panorama_id), facts.exports.get(panorama_id)
        if log is None or log.final is None:
            unanswered += 1
            problems.append((panorama_id, "no final answer in its log to check"))
        elif (found := _ledger_problem(log)) is not None:
            wrong += 1
            problems.append((panorama_id, found))
        elif export is not None and isinstance(export.state, dict) and export.state != log.final["penalty_state"]:
            # an export with no readable state at all is the "Exports valid" check's to report
            stale += 1
            problems.append((panorama_id, "the export carries a penalty state its log has since replaced"))
    told = []
    if unanswered:
        told.append(f"{_panoramas(unanswered)} with no final answer, so no final penalty state to check.")
    if stale:
        told.append(f"{_panoramas(stale)} whose export carries an older penalty state than its log.")
    if wrong:
        told.append(
            f"{_panoramas(wrong)} whose final penalty state does not match the penalised events in the log. "
            "The log is the record: check it before submitting."
        )
    return _check(
        "ledger",
        problems,
        ok="Every final penalty state matches the cues, questions and geocodes in its log.",
        bad=" ".join(told),
        # a log at odds with itself is not something a rebuild repairs
        action=remedy if unanswered or stale else None,
    )


def _cell(value: Any) -> str:
    """A value as export_run's csv writer puts it in a table."""
    return "" if value is None else str(value)


def _fixed(value: Any) -> str:
    return f"{value:.6f}" if isinstance(value, (int, float)) else ""


def _tables_problem(facts: _Facts, panorama_id: str, export: _Export) -> str | None:
    """The two tables are written with the exports, so they tell the same answer unless something
    was replaced in between."""
    points = [entry for entry in export.locations if isinstance(entry, dict)]
    if facts.answers is not None:
        listed = [
            (row.get("rank"), row.get("lat"), row.get("lng"))
            for row in facts.answers
            if row.get("panorama_id") == panorama_id
        ]
        if listed != [(_cell(p.get("rank")), _fixed(p.get("lat")), _fixed(p.get("lng"))) for p in points]:
            return f"{ANSWERS_NAME} does not list the points of its export"
    if facts.summary is not None:
        row = next((row for row in facts.summary if row.get("panorama") == panorama_id), None)
        top = points[0] if points else {}
        if row is None or any(row.get(key) != _cell(top.get(key)) for key in ("lat", "lng", "multiplier", "origin")):
            return f"{SUMMARY_NAME} does not match its export"
    return None


def _files_fresh(facts: _Facts, remedy: str | None) -> dict[str, Any]:
    problems: list[Problem] = []
    for tile in facts.tiles:
        panorama_id = tile["panorama_id"]
        log, export = facts.logs.get(panorama_id), facts.exports.get(panorama_id)
        if export is None:
            problems.append((panorama_id, "no export file"))
        elif log is None:
            problems.append((panorama_id, "the export has no event log beside it"))
        elif export.last_seq != log.last_seq:
            problems.append(
                (panorama_id, f"the export ends at event {export.last_seq}, its log has reached {log.last_seq}")
            )
        elif (found := _tables_problem(facts, panorama_id, export)) is not None:
            problems.append((panorama_id, found))
    missing = [name for name, table in ((ANSWERS_NAME, facts.answers), (SUMMARY_NAME, facts.summary)) if table is None]
    told = [f"{' and '.join(missing)} {'is' if len(missing) == 1 else 'are'} missing."] if missing else []
    if problems:
        told.append(f"{_panoramas(len(problems))} whose files are missing or older than the log.")
    if remedy == "rebuild":
        told.append("Rebuild the exports.")
    return _check(
        "files_fresh",
        problems,
        ok="Every export holds every event of its log, and both tables match the exports.",
        bad=" ".join(told),
        action=remedy,
        broken=bool(missing),
    )


def _no_fallback(facts: _Facts) -> dict[str, Any]:
    problems: list[Problem] = []
    for tile in facts.tiles:
        if tile.get("origin") != "harness_fallback":
            continue
        why = tile.get("stop_text") or tile.get("stop_reason") or "no answer from the agent"
        seen = " (acknowledged)" if tile.get("fallback_acknowledged") else ""
        problems.append((tile["panorama_id"], f"fallback point{seen}: {why}"))
    return _check(
        "no_fallback",
        problems,
        ok="Every answer comes from the agent or the operator.",
        bad=(
            f"{_panoramas(len(problems))} would be submitted with the harness's fallback point, not an answer. "
            f"Retry {'it' if len(problems) == 1 else 'them'} while the run is open, or accept this."
        ),
        level="warn",
    )


def _is_fake(run: Mapping[str, Any]) -> bool:
    """The run.json flag, or a log that names the scripted model (a run whose run.json is gone)."""
    return bool(run.get("fake_model")) or any(
        tile.get("model") == FAKE_MODEL_NAME for tile in run.get("panoramas") or []
    )


def _checks(facts: _Facts, run: Mapping[str, Any]) -> list[dict[str, Any]]:
    remedy = _remedy(run, facts.tiles)
    checks = [
        _all_final(facts, run, remedy),
        _ten_entries(facts, remedy),
        _exports_valid(facts, remedy),
        _ledger(facts, remedy),
        _files_fresh(facts, remedy),
        _no_fallback(facts),
    ]
    if _is_fake(run):
        bad = "This run was answered by the scripted demo model: its answers are made up. Do not submit them."
        checks.append(_check("real_model", [], ok="", bad=bad, broken=True))
    return checks


# ---------------------------------------------------------------------------------------------
# what the page gets


def _float(text: str) -> float | None:
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _int(text: str) -> int | None:
    value = _float(text)
    return int(value) if value is not None and value == int(value) else None


def _answer_rows(table: list[dict[str, str]] | None) -> list[dict[str, Any]]:
    return [
        {
            "panorama_id": row.get("panorama_id", ""),
            "rank": _int(row.get("rank", "")),
            "lat": _float(row.get("lat", "")),
            "lng": _float(row.get("lng", "")),
        }
        for row in table or []
    ]


def _summary_rows(table: list[dict[str, str]] | None) -> list[dict[str, Any]]:
    """summary.csv with its own columns, numbers as numbers. `problems` stays the text it is."""
    rows = []
    for raw in table or []:
        row: dict[str, Any] = dict(raw)
        row["special"] = raw.get("special") == "True"
        row["turns"] = _int(raw.get("turns", ""))
        row.update({key: _float(raw.get(key, "")) for key in _SUMMARY_FLOATS})
        row.update({key: raw.get(key) or None for key in _SUMMARY_TEXTS})
        rows.append(row)
    return rows


def validate_run(run_dir: Path, run: Mapping[str, Any]) -> dict[str, Any]:
    """The submission screen's payload for one run. `run` is its RunState (with `panoramas`) and
    `run_dir` its directory. Reads only."""
    facts = _gather(Path(run_dir), run)
    checks = _checks(facts, run)
    return {
        "run_id": run.get("run_id"),
        "checks": checks,
        "ok": all(check["status"] != "fail" for check in checks),
        "answers": _answer_rows(facts.answers),
        "summary": _summary_rows(facts.summary),
        "files": facts.files,
        "submitted_at": run.get("submitted_at"),
        "interrupted": run.get("state") == "interrupted",
        "fake_model": _is_fake(run),
    }


def submission_zip(run_dir: Path, run: Mapping[str, Any], *, force: bool = False, fake_ok: bool = False) -> bytes:
    """The submission as one zip: the exports, answers.csv and summary.csv, flat.

    Refused with a 409 `ConsoleError` for a run of the scripted model unless `fake_ok`, and while
    any check fails unless `force` (a warning never blocks). A forced zip holds whatever of the
    allow-list exists."""
    if _is_fake(run) and not fake_ok:
        raise ConsoleError(
            409,
            "This run was answered by the scripted demo model, so these are demo answers, not a submission. "
            "Confirm to download them anyway.",
            code="fake_model",
            action="fake_ok",
        )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        facts = _gather(Path(run_dir), run, archive)
        packed = archive.namelist()
    failing = [c for c in _checks(facts, run) if c["status"] == "fail" and c["id"] != "real_model"]
    if failing and not force:
        raise ConsoleError(
            409,
            "The submission checklist has failing checks: " + ", ".join(check["label"] for check in failing) + ". "
            "Put them right on the Submission screen, or confirm to download the files as they are.",
            code="validation_failed",
            action="force",
            problems=[f"{check['label']}: {check['detail']}" for check in failing],
            checks=[check["id"] for check in failing],
        )
    if not packed:
        raise ConsoleError(
            409,
            "This run has no export files yet: there is nothing to download. Finalize it, or rebuild its exports.",
            code="nothing_to_download",
            action=_remedy(run, facts.tiles),
        )
    return buffer.getvalue()
