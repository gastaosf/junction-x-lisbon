"""Append-only JSONL interaction log (SPEC section 9) and the per-panorama export."""

from __future__ import annotations

import base64
import dataclasses
import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Literal

from pydantic import BaseModel

from .schema import PenaltyState

SCHEMA_VERSION = "1.0"

Actor = Literal["agent", "human", "harness", "tool"]
Listener = Callable[[dict[str, Any]], None]

ORIGINS = {"agent", "harness_fallback", "human_geocode"}
_IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


def _json_default(obj: Any) -> Any:
    if isinstance(obj, BaseModel):
        return obj.model_dump(mode="json")
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    if isinstance(obj, (bytes, bytearray, memoryview)):
        return f"<{len(obj)} bytes>"  # raw image bytes never belong in the log
    if isinstance(obj, (set, frozenset)):
        return sorted(obj, key=str)
    return str(obj)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    """Parse a JSONL file, skipping a torn last line (a crash mid-write must not lose the rest)."""
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def _end_torn_line(path: Path) -> None:
    """After kill -9 the file can end in half a line. Close it, or the next event would be glued
    to it and lost with it."""
    try:
        with path.open("rb+") as fh:
            if fh.seek(0, os.SEEK_END) == 0:
                return
            fh.seek(-1, os.SEEK_END)
            if fh.read(1) != b"\n":
                fh.write(b"\n")
                fh.flush()
                os.fsync(fh.fileno())
    except OSError:  # no file yet, or a disk that emit() will not be able to write to either
        pass


class EventLog:
    """One JSONL file per panorama; every event is flushed and fsync'd before emit() returns."""

    def __init__(
        self,
        run_id: str,
        panorama_id: str,
        path: Path,
        penalty_state: Callable[[], PenaltyState] | None = None,
    ) -> None:
        self.run_id = run_id
        self.panorama_id = panorama_id
        self.path = Path(path)
        self.t0 = time.monotonic()  # origin of t_rel_s
        self._penalty_state = penalty_state
        self._lock = threading.RLock()
        self._listeners: list[Listener] = []
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _end_torn_line(self.path)
        # A restarted run appends to the same file, so seq continues instead of restarting at 1.
        self._seq = max((int(e.get("seq", 0)) for e in _read_jsonl(self.path)), default=0)

    def bind_penalty_state(self, penalty_state: Callable[[], PenaltyState]) -> None:
        with self._lock:
            self._penalty_state = penalty_state

    def add_listener(self, cb: Listener) -> None:
        with self._lock:
            self._listeners.append(cb)

    def remove_listener(self, cb: Listener) -> None:
        with self._lock:
            if cb in self._listeners:
                self._listeners.remove(cb)

    def emit(self, actor: Actor, type: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        """Append one event and return its envelope exactly as written (JSON-safe). Never raises."""
        with self._lock:
            self._seq += 1
            envelope: dict[str, Any] = {
                "schema_version": SCHEMA_VERSION,
                "seq": self._seq,
                "ts": _utc_now(),
                "t_rel_s": round(time.monotonic() - self.t0, 3),
                "run_id": self.run_id,
                "panorama_id": self.panorama_id,
                "actor": actor,
                "type": type,
                "penalty_state": self._current_penalty_state(),
                "data": data if data is not None else {},
            }
            line = self._serialise(envelope)
            envelope = json.loads(line)
            self._append(line)
            listeners = list(self._listeners)
        for cb in listeners:
            try:
                cb(envelope)
            except Exception:  # a broken UI subscriber must never break the run
                continue
        return envelope

    def events(self) -> list[dict[str, Any]]:
        with self._lock:
            return _read_jsonl(self.path)

    def _current_penalty_state(self) -> dict[str, Any]:
        try:
            state = self._penalty_state() if self._penalty_state else PenaltyState()
            return state.model_dump(mode="json")
        except Exception:
            return PenaltyState().model_dump(mode="json")

    @staticmethod
    def _serialise(envelope: dict[str, Any]) -> str:
        try:
            return json.dumps(envelope, default=_json_default, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            pass
        try:  # NaN/inf floats: keep the structure, accept non-strict tokens rather than lose the event
            text = json.dumps(envelope, default=_json_default, ensure_ascii=False)
            return json.dumps(json.loads(text, parse_constant=lambda _: None), ensure_ascii=False)
        except (TypeError, ValueError, RecursionError):
            return json.dumps({**envelope, "data": {"unserialisable": repr(envelope["data"])[:20000]}}, default=str)

    def _append(self, line: str) -> None:
        try:
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
                fh.flush()
                os.fsync(fh.fileno())
        except OSError:
            pass  # a full or vanished disk must not kill the run; listeners still get the event


def _walk_dicts(node: Any) -> Iterator[dict[str, Any]]:
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk_dicts(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk_dicts(value)


def _resolve_image(raw: str, base: Path) -> Path | None:
    for candidate in (Path(raw), base / raw):
        if candidate.suffix.lower() in _IMAGE_TYPES and candidate.is_file():
            return candidate
    return None


def _collect_images(events: list[dict[str, Any]], base: Path) -> dict[str, dict[str, str]]:
    """Base64 of every image referenced as {sha256, path}, stored once per hash."""
    images: dict[str, dict[str, str]] = {}
    for ref in _walk_dicts(events):
        sha, raw = ref.get("sha256"), ref.get("path")
        if not isinstance(sha, str) or not isinstance(raw, str) or sha in images:
            continue
        path = _resolve_image(raw, base)
        if path is None:
            continue
        try:
            payload = base64.b64encode(path.read_bytes()).decode("ascii")
        except OSError:
            continue
        images[sha] = {"media_type": _IMAGE_TYPES[path.suffix.lower()], "path": raw, "base64": payload}
    return images


def _last(events: list[dict[str, Any]], type: str) -> dict[str, Any] | None:
    return next((e for e in reversed(events) if e.get("type") == type), None)


_PENALTY_EVENTS = {"human_cue": "cues", "mcq_asked": "mcqs", "human_geocode": "human_geocodes"}
_FACTORS = {"cues": 0.8, "mcqs": 0.95, "human_geocodes": 0.5}


def _penalty_counts(events: list[dict[str, Any]]) -> dict[str, int]:
    """Penalised interactions the log itself records, whatever a later penalty_state claims."""
    counts = dict.fromkeys(_PENALTY_EVENTS.values(), 0)
    for event in events:
        key = _PENALTY_EVENTS.get(event.get("type", "")) if isinstance(event, dict) else None
        if key:
            counts[key] += 1
    return counts


def _state_from_counts(counts: dict[str, int]) -> dict[str, Any]:
    multiplier = 1.0
    for key, factor in _FACTORS.items():
        multiplier *= factor ** counts[key]
    return {**counts, "multiplier": round(multiplier, 12)}


def _recovered_final(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]] | None:
    """The answer of record for a run that died before finalising (kill -9, SIGTERM, power loss).

    SPEC 6.5 persists a provisional 10-entry list on every update_candidates; the last one is the
    answer. Its multiplier is re-stamped from the penalties counted in the log, because a cue or a
    question may have been charged after that list was written."""
    update = _last(events, "candidates_update")
    entries = (update or {}).get("data", {}).get("provisional") if update else None
    if not isinstance(entries, list) or not entries:
        return None
    state = _state_from_counts(_penalty_counts(events))
    stamped = [{**entry, "multiplier": state["multiplier"]} for entry in entries if isinstance(entry, dict)]
    return stamped, state


def export_panorama(
    log_path: Path,
    out_path: Path,
    *,
    team: str,
    panorama: dict[str, Any],
    config: dict[str, Any],
    embed_images: bool = False,
) -> dict[str, Any]:
    """Write the single-file export for one panorama and return the document."""
    log_path, out_path = Path(log_path), Path(out_path)
    events = _read_jsonl(log_path)
    final_event = _last(events, "final_submission")
    run_end = _last(events, "run_end")
    last_state = events[-1]["penalty_state"] if events else PenaltyState().model_dump(mode="json")
    totals: dict[str, Any] = dict(run_end["data"]) if run_end else {}
    if final_event:
        locations = final_event["data"].get("entries", [])
        penalty_state = final_event["penalty_state"]
    elif (recovered := _recovered_final(events)) is not None:
        locations, penalty_state = recovered
        totals.setdefault("stop_reason", "recovered_from_provisional")
        totals["recovered_from_provisional"] = True
    else:
        locations, penalty_state = [], last_state
    doc: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "team": team,
        "panorama": panorama,
        "config": config,
        "events": events,
        "final": {"locations": locations, "penalty_state": penalty_state},
        "totals": totals,
    }
    if embed_images:
        doc["images"] = _collect_images(events, log_path.parent)
    text = json.dumps(doc, default=_json_default, ensure_ascii=False, indent=2)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # A unique temp name: exports may run from a worker thread while another one is in flight.
    tmp = out_path.with_name(f"{out_path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, out_path)  # never leave a half-written export where a submission could pick it up
    return json.loads(text)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value


def _check_coordinate(name: str, value: Any, limit: float, where: str) -> list[str]:
    if not _is_number(value):
        return [f"{where}: {name} is not a number"]
    problems = []
    if abs(value) > limit:
        problems.append(f"{where}: {name} {value} out of range +/-{limit:g}")
    if abs(round(value, 6) - value) > 1e-12:
        problems.append(f"{where}: {name} {value} has more than 6 decimals")
    return problems


def _check_multiplier(value: Any, where: str) -> list[str]:
    if not _is_number(value):
        return [f"{where}: multiplier missing"]
    if not 0 < value <= 1:
        return [f"{where}: multiplier {value} outside (0, 1]"]
    return []


def _check_locations(locations: Any) -> list[str]:
    if not isinstance(locations, list):
        return ["final.locations is not a list"]
    problems = []
    if len(locations) != 10:
        problems.append(f"final.locations has {len(locations)} entries, expected 10")
    for i, entry in enumerate(locations, start=1):
        where = f"final.locations[{i}]"
        if not isinstance(entry, dict):
            problems.append(f"{where}: not an object")
            continue
        if entry.get("rank") != i:
            problems.append(f"{where}: rank is {entry.get('rank')!r}, expected {i}")
        problems += _check_coordinate("lat", entry.get("lat"), 90.0, where)
        problems += _check_coordinate("lng", entry.get("lng"), 180.0, where)
        problems += _check_multiplier(entry.get("multiplier"), where)
        if entry.get("origin") not in ORIGINS:
            problems.append(f"{where}: origin {entry.get('origin')!r} is not one of {sorted(ORIGINS)}")
    return problems


def _check_penalty_state(state: Any) -> list[str]:
    if not isinstance(state, dict):
        return ["final.penalty_state missing"]
    problems = []
    for key in ("cues", "mcqs", "human_geocodes"):
        if not isinstance(state.get(key), int) or isinstance(state.get(key), bool) or state[key] < 0:
            problems.append(f"final.penalty_state.{key} missing or negative")
    problems += _check_multiplier(state.get("multiplier"), "final.penalty_state")
    if not problems:
        expected = 0.8 ** state["cues"] * 0.95 ** state["mcqs"] * 0.5 ** state["human_geocodes"]
        if abs(expected - state["multiplier"]) > 1e-9:
            problems.append(f"final.penalty_state.multiplier {state['multiplier']} != {expected:.6f} from the counts")
    return problems


def _check_events(events: Any) -> list[str]:
    if not isinstance(events, list) or not events:
        return ["events is empty or not a list"]
    problems = []
    seqs = [e.get("seq") if isinstance(e, dict) else None for e in events]
    if any(not isinstance(s, int) for s in seqs):
        problems.append("events: every event needs an integer seq")
    elif any(b <= a for a, b in zip(seqs, seqs[1:])):
        problems.append("events: seq is not strictly increasing")
    if not any(isinstance(e, dict) and e.get("type") == "final_submission" for e in events):
        problems.append("events: no final_submission event")
    return problems


def _check_penalties_against_events(state: Any, events: Any) -> list[str]:
    """The final penalty_state must account for every penalised interaction the log records."""
    if not isinstance(state, dict) or not isinstance(events, list):
        return []
    counted = _penalty_counts(events)
    names = {key: event for event, key in _PENALTY_EVENTS.items()}
    return [
        f"final.penalty_state.{key} is {state.get(key)!r} but the log has {count} {names[key]} event(s)"
        for key, count in counted.items()
        if state.get(key) != count
    ]


def validate_export(doc: dict[str, Any]) -> list[str]:
    """Problems that would make an export unfit to submit; an empty list means valid."""
    if not isinstance(doc, dict):
        return ["export is not an object"]
    problems = [
        f"missing top-level key: {key}"
        for key in ("schema_version", "team", "panorama", "config", "events", "final", "totals")
        if key not in doc
    ]
    final = doc.get("final")
    if not isinstance(final, dict):
        return problems + ["final is not an object"]
    problems += _check_locations(final.get("locations"))
    problems += _check_penalty_state(final.get("penalty_state"))
    problems += _check_events(doc.get("events"))
    problems += _check_penalties_against_events(final.get("penalty_state"), doc.get("events"))
    return problems
