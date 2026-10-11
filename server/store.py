"""ConsoleStore: what the console remembers between server starts (data/console.json).

Saved defaults for new runs, the notes on the organiser questions of SPEC 13, the LAN switch with
its token, the directories the path browser may show, and the runs/cache directories for the next
start. Never a key: keys live in the environment and .env only.
"""

from __future__ import annotations

import json
import math
import os
import re
import secrets
import threading
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, get_args

from astrolabio.config import MODEL_PRICING, Budget, Effort
from astrolabio.tools.schemas import validate_disabled_tools

from .security import redact

FILE_NAME = "console.json"
REPO_ROOT = Path(__file__).resolve().parent.parent

# The only keys a launch form or the saved defaults may set. Everything else in Settings (the cue
# limit, the MCQ window, the fallback points, service URLs, pricing, paths, keys) is not for a
# browser to choose: it would move a rule or redirect tool traffic.
LAUNCH_FIELDS: tuple[str, ...] = (
    "model",
    "max_tokens",
    "image_detail",
    "standard",
    "special",
    "live",
    "allow_web",
    "disabled_tools",
    "hedge",
    "allow_duplicates",
    "penalty_scope",
    "no_human",
    "mcq_allowed",
    "max_mcq",
    "concurrency",
    "global_watchdog_s",
    "embed_images",
    "team",
)
BUDGET_FIELDS: tuple[str, ...] = ("standard", "special", "live")
_BUDGET_KEYS: tuple[str, ...] = tuple(Budget.model_fields)
_BOOL_FIELDS = frozenset({"allow_web", "hedge", "allow_duplicates", "no_human", "mcq_allowed", "embed_images"})
_CHOICES: dict[str, tuple[str, ...]] = {
    "image_detail": ("low", "high", "original", "auto"),
    "penalty_scope": ("whole_list", "subsequent"),
}
_EFFORTS: tuple[str, ...] = get_args(Effort)
_TEAM_RE = re.compile(r"^[\w .-]{1,40}$")
MAX_MCQ_LIMIT = 3  # R7 allows three questions per panorama; a form may only lower it
MAX_CONCURRENCY = 12
MAX_OUTPUT_TOKENS = 128_000
MAX_NOTE_CHARS = 2000

# SPEC 13. `setting` is the saved default an answer changes (None: nothing to switch); `control`
# says where the operator finds it.
ORGANISER_QUESTIONS: tuple[dict[str, Any], ...] = (
    {
        "id": "Q1",
        "question": "May the agent itself use the internet: web search, geocoding, street-level and "
        "satellite imagery APIs?",
        "default": "Assume yes, with ALLOW_WEB able to switch every external tool off",
        "control": "New run, Tools: web on/off",
        "setting": "allow_web",
    },
    {
        "id": "Q2",
        "question": "Do R6-R8 penalties apply only to entries produced after the interaction, or to the "
        "whole final list?",
        "default": "Whole list",
        "control": "New run, Answer: penalty scope",
        "setting": "penalty_scope",
    },
    {
        "id": "Q3",
        "question": "Are exact duplicate coordinates scored at every rank?",
        "default": "Yes, per the brief",
        "control": "New run, Answer: allow duplicates",
        "setting": "allow_duplicates",
    },
    {
        "id": "Q4",
        "question": "Required JSON log schema, one file per panorama or per run, where and when to submit?",
        "default": "Our schema, one file per panorama",
        "control": "New run, Export: embed images; Submission: download",
        "setting": "embed_images",
    },
    {
        "id": "Q5",
        "question": "Is the capture timestamp UTC or local time?",
        "default": "Unknown; sun_position evaluates both and the result is a weak prior only",
        "control": "None: both readings are always evaluated",
        "setting": None,
    },
    {
        "id": "Q6",
        "question": "Is theta = 2 / (1 + d/scale), so an exact rank-1 hit scores 2000?",
        "default": "Yes; strategy does not depend on it",
        "control": "None",
        "setting": None,
    },
    {
        "id": "Q7",
        "question": "Is an MCQ whose options are candidate places, checked by a human with tools on other "
        "equipment, acceptable under R7?",
        "default": 'Yes ("geographic zones" are named in R7)',
        "control": "New run, Autonomy: questions allowed, max MCQs",
        "setting": None,
    },
    {
        "id": "Q8",
        "question": "Do the label and timestamp, passed as text, count as a cue? Does the system prompt?",
        "default": "No; they are task input and preparation",
        "control": "None",
        "setting": None,
    },
    {
        "id": "Q9",
        "question": "What counts as an indirect location reference in a cue (country, language of signs, "
        "vegetation)?",
        "default": "Only visual-feature descriptions; no toponyms, countries or regions",
        "control": "Cue box: the server lint",
        "setting": None,
    },
    {
        "id": "Q10",
        "question": "When does the 60-minute clock start, and can a submission be revised inside the window?",
        "default": "One clock from hand-over; last submission counts",
        "control": "Run header: the start of the clock can be set",
        "setting": "clock_start",
    },
    {
        "id": "Q11",
        "question": "Answer format: order, datum, file or form?",
        "default": "lat,lng, decimal WGS84, 6 decimals",
        "control": "Submission: answers.csv",
        "setting": None,
    },
    {
        "id": "Q12",
        "question": "Rules and time limit for the live panorama?",
        "default": "Same rules, a few minutes, autonomous",
        "control": "New run, preset Live on stage",
        "setting": None,
    },
)
_QUESTION_IDS = frozenset(q["id"] for q in ORGANISER_QUESTIONS)
# Q10 has no saved default behind it: the clock starts at launch and is moved per run (U7).
CLOCK_START_VALUE = "launch"


class SettingsError(ValueError):
    """A value the console refuses to save or launch with. `code` is `unknown_setting` when a key
    is not one of LAUNCH_FIELDS, else `invalid_setting`; `problems` has one sentence per fault."""

    def __init__(self, problems: list[str], code: str = "invalid_setting") -> None:
        super().__init__("; ".join(problems))
        self.problems = problems
        self.code = code


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_budget(name: str, value: Any, problems: list[str]) -> dict[str, Any] | None:
    """A whole Budget. Half of one would replace the other half with nothing where the layers of
    settings are merged, so a form sends all five fields or leaves the budget alone."""
    if not isinstance(value, Mapping):
        problems.append(f"{name} must be an object with {', '.join(_BUDGET_KEYS)}")
        return None
    problems += [f"{name}.{key} is missing" for key in _BUDGET_KEYS if key not in value]
    out: dict[str, Any] = {}
    for key, item in value.items():
        if key not in _BUDGET_KEYS:
            problems.append(f"{name}.{key} is not a budget field")
        elif key == "effort":
            if item not in _EFFORTS:
                problems.append(f"{name}.effort must be one of {', '.join(_EFFORTS)}")
            else:
                out[key] = item
        elif key == "max_turns":
            if not _is_int(item) or item <= 0:
                problems.append(f"{name}.max_turns must be a whole number above 0")
            else:
                out[key] = item
        elif not _is_number(item) or item <= 0:
            problems.append(f"{name}.{key} must be a number above 0")
        else:
            out[key] = float(item)
    soft, hard = out.get("soft_deadline_s"), out.get("hard_deadline_s")
    if soft is not None and hard is not None and soft > hard:
        problems.append(f"{name}.soft_deadline_s must not be later than {name}.hard_deadline_s")
    return out


def validate_launch_settings(values: Any, *, models: Iterable[str] | None = None) -> dict[str, Any]:
    """`values` (a launch form's `settings`, or saved defaults) as a clean JSON-safe dict, or
    SettingsError. An unknown key is an error, never dropped in silence: the operator would
    believe a setting applied that did not. `models` defaults to the models we have prices for."""
    if not isinstance(values, Mapping):
        raise SettingsError(["settings must be an object"])
    unknown = sorted(str(key) for key in values if key not in LAUNCH_FIELDS)
    if unknown:
        raise SettingsError(
            [f"{key} is not a setting a run can be launched with" for key in unknown], code="unknown_setting"
        )
    known_models = tuple(models) if models is not None else tuple(MODEL_PRICING)
    problems: list[str] = []
    out: dict[str, Any] = {}
    for key, value in values.items():
        if key in BUDGET_FIELDS:
            budget = _check_budget(key, value, problems)
            if budget is not None:
                out[key] = budget
        elif key in _BOOL_FIELDS:
            if not isinstance(value, bool):
                problems.append(f"{key} must be true or false")
            else:
                out[key] = value
        elif key in _CHOICES:
            if value not in _CHOICES[key]:
                problems.append(f"{key} must be one of {', '.join(_CHOICES[key])}")
            else:
                out[key] = value
        elif key == "model":
            if value not in known_models:
                problems.append(f"model must be one of {', '.join(known_models)}")
            else:
                out[key] = value
        elif key == "max_tokens":
            if not _is_int(value) or not 1 <= value <= MAX_OUTPUT_TOKENS:
                problems.append(f"max_tokens must be a whole number from 1 to {MAX_OUTPUT_TOKENS}")
            else:
                out[key] = value
        elif key == "max_mcq":
            if not _is_int(value) or not 0 <= value <= MAX_MCQ_LIMIT:
                problems.append(f"max_mcq must be a whole number from 0 to {MAX_MCQ_LIMIT}")
            else:
                out[key] = value
        elif key == "concurrency":
            if not _is_int(value) or not 1 <= value <= MAX_CONCURRENCY:
                problems.append(f"concurrency must be a whole number from 1 to {MAX_CONCURRENCY}")
            else:
                out[key] = value
        elif key == "global_watchdog_s":
            if not _is_number(value) or value <= 0:
                problems.append("global_watchdog_s must be a number above 0")
            else:
                out[key] = float(value)
        elif key == "disabled_tools":
            if not isinstance(value, (list, tuple)):
                problems.append("disabled_tools must be a list of tool names")
                continue
            try:
                out[key] = list(validate_disabled_tools(value))
            except ValueError as exc:
                problems.append(f"disabled_tools: {exc}")
        elif key == "team":
            if not isinstance(value, str) or not _TEAM_RE.match(value):
                problems.append("team must be 1 to 40 letters, digits, spaces, '.', '_' or '-'")
            else:
                out[key] = value
    if problems:
        raise SettingsError(problems)
    return out


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _related(a: Path, b: Path) -> bool:
    """One contains the other (or they are the same directory)."""
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


class ConsoleStore:
    """data/console.json, loaded once and rewritten atomically on every change.

    Methods are safe to call from any thread. `protected_dirs` are the directories no allowed
    root may contain or lie in (runs, cache, evaluation data); the data directory itself (apart
    from sets/) and the repository are always protected."""

    def __init__(self, data_dir: str | Path, *, protected_dirs: Iterable[str | Path] = ()) -> None:
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / FILE_NAME
        self.protected_dirs: list[Path] = [Path(p) for p in protected_dirs]
        self._lock = threading.RLock()
        self._doc = self._load()

    # ------------------------------------------------------------------ file

    def _load(self) -> dict[str, Any]:
        try:
            doc = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            # Keep the damaged file for a human to look at; the next save would overwrite it.
            try:
                os.replace(self.path, self.path.with_name(FILE_NAME + ".damaged"))
            except OSError:
                pass
            return {}
        return doc if isinstance(doc, dict) else {}

    def _save(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        text = json.dumps({"version": 1, **self._doc}, ensure_ascii=False, indent=2, sort_keys=True)
        tmp = self.path.with_name(f".{FILE_NAME}.{os.getpid()}.{threading.get_ident()}.tmp")
        # 0600: the file holds the LAN token
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text + "\n")
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    def _section(self, name: str) -> dict[str, Any]:
        value = self._doc.get(name)
        return value if isinstance(value, dict) else {}

    # ------------------------------------------------------------------ defaults for new runs

    def defaults(self) -> dict[str, Any]:
        """The saved overrides only (a subset of LAUNCH_FIELDS); what is absent comes from the
        environment. A hand-edited file is filtered key by key rather than trusted."""
        with self._lock:
            stored = self._section("defaults")
        out: dict[str, Any] = {}
        for key, value in stored.items():
            # the list of models is the caller's to judge (it can outgrow the price table)
            models = (value,) if key == "model" and isinstance(value, str) else None
            try:
                out.update(validate_launch_settings({key: value}, models=models))
            except SettingsError:
                continue
        return out

    def set_defaults(
        self, values: Any, *, replace: bool = False, models: Iterable[str] | None = None
    ) -> dict[str, Any]:
        """Merge `values` into the saved defaults (a null value forgets that key). Validated
        whole before anything is written."""
        if not isinstance(values, Mapping):
            raise SettingsError(["defaults must be an object"])
        forget = [key for key, value in values.items() if value is None]
        unknown = sorted(str(key) for key in forget if key not in LAUNCH_FIELDS)
        if unknown:
            raise SettingsError(
                [f"{key} is not a setting a run can be launched with" for key in unknown], code="unknown_setting"
            )
        clean = validate_launch_settings({k: v for k, v in values.items() if v is not None}, models=models)
        with self._lock:
            merged = {} if replace else self.defaults()
            for key in forget:
                merged.pop(key, None)
            merged.update(clean)
            self._doc["defaults"] = merged
            self._save()
            return dict(merged)

    # ------------------------------------------------------------------ organiser answers (SPEC 13)

    def organiser_answers(self, effective: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        """The Q1 to Q12 table as a form. `value` is read from the defaults (`effective`: the
        caller's fully resolved defaults; without it only what is saved here), never stored twice."""
        with self._lock:
            notes = self._section("organiser_answers")
        values = effective if effective is not None else self.defaults()
        rows = []
        for question in ORGANISER_QUESTIONS:
            note = notes.get(question["id"])
            note = note if isinstance(note, dict) else {}
            setting = question["setting"]
            value = CLOCK_START_VALUE if setting == "clock_start" else values.get(setting) if setting else None
            said = {"note": str(note.get("note") or ""), "noted_at": note.get("noted_at")}
            rows.append({**question, "value": value, **said})
        return rows

    def set_organiser_answers(
        self, items: Any, *, models: Iterable[str] | None = None, dry_run: bool = False
    ) -> list[dict[str, Any]]:
        """Apply `[{id, value?, note?}]`. A value goes to the default it controls; a note is kept
        beside it with the time it was written. `dry_run` checks everything and writes nothing,
        so a request that saves several sections can be refused before any of them is written."""
        if not isinstance(items, list):
            raise SettingsError(["organiser_answers must be a list of {id, value, note}"])
        problems: list[str] = []
        new_defaults: dict[str, Any] = {}
        new_notes: dict[str, str] = {}
        by_id = {q["id"]: q for q in ORGANISER_QUESTIONS}
        for item in items:
            qid = item.get("id") if isinstance(item, Mapping) else None
            if qid not in _QUESTION_IDS:
                problems.append(f"unknown organiser question {qid!r}")
                continue
            setting = by_id[qid]["setting"]
            if "value" in item and item["value"] is not None:
                if setting in LAUNCH_FIELDS:
                    new_defaults[setting] = item["value"]
                elif setting != "clock_start" or item["value"] != CLOCK_START_VALUE:
                    problems.append(f"{qid} has no setting to change; record the answer in its note")
            if "note" in item and item["note"] is not None:
                note = item["note"]
                if not isinstance(note, str) or len(note) > MAX_NOTE_CHARS:
                    problems.append(f"{qid}: the note must be text of at most {MAX_NOTE_CHARS} characters")
                else:
                    # free text an operator pastes into: a key must not end up in console.json
                    new_notes[qid] = redact(note.strip())
        if problems:
            raise SettingsError(problems)
        if new_defaults:
            validate_launch_settings(new_defaults, models=models)
        if dry_run:
            return self.organiser_answers()
        with self._lock:
            if new_defaults:
                self.set_defaults(new_defaults, models=models)
            if new_notes:
                notes = dict(self._section("organiser_answers"))
                for qid, text in new_notes.items():
                    previous = notes.get(qid) if isinstance(notes.get(qid), dict) else {}
                    if text != str(previous.get("note") or ""):
                        notes[qid] = {"note": text, "noted_at": _now()}
                self._doc["organiser_answers"] = notes
                self._save()
        return self.organiser_answers()

    # ------------------------------------------------------------------ LAN access

    def lan(self) -> dict[str, Any]:
        """`{enabled, token}`. Read at server start; a change needs a restart. The token is for the
        middleware and the join URL shown on loopback only: never put it in any other response."""
        with self._lock:
            lan = self._section("lan")
        token = lan.get("token") if isinstance(lan.get("token"), str) and lan.get("token") else None
        return {"enabled": lan.get("enabled") is True and token is not None, "token": token}

    def set_lan(self, enabled: bool) -> dict[str, Any]:
        """Switching on makes a fresh token; switching off forgets it, so an old link stops working."""
        if not isinstance(enabled, bool):
            raise SettingsError(["lan.enabled must be true or false"])
        with self._lock:
            current = self.lan()
            if enabled != current["enabled"]:
                self._doc["lan"] = {"enabled": enabled, "token": secrets.token_urlsafe(32) if enabled else None}
                self._save()
            return self.lan()

    # ------------------------------------------------------------------ paths

    def paths(self) -> dict[str, Any]:
        """`{runs_dir, cache_dir}` as saved (None: use the environment), applied at the next start."""
        with self._lock:
            paths = self._section("paths")
        return {key: paths.get(key) if isinstance(paths.get(key), str) else None for key in ("runs_dir", "cache_dir")}

    def set_paths(self, values: Any, *, dry_run: bool = False) -> dict[str, Any]:
        """Save any of `{runs_dir, cache_dir, allowed_roots}`; null resets one to its default.
        `dry_run` checks the values and writes nothing."""
        if not isinstance(values, Mapping):
            raise SettingsError(["paths must be an object"])
        unknown = sorted(str(k) for k in values if k not in {"runs_dir", "cache_dir", "allowed_roots"})
        if unknown:
            raise SettingsError([f"paths.{key} is not a path setting" for key in unknown], code="unknown_setting")
        problems: list[str] = []
        update: dict[str, Any] = {}
        for key in ("runs_dir", "cache_dir"):
            if key not in values:
                continue
            raw = values[key]
            if raw is None:
                update[key] = None
                continue
            path = Path(raw).expanduser() if isinstance(raw, str) and raw.strip() and "\x00" not in raw else None
            if path is None or not path.is_absolute() or path == Path(path.anchor):
                problems.append(f"paths.{key} must be an absolute directory path (not the file system root)")
            elif path.exists() and not path.is_dir():
                problems.append(f"paths.{key} exists and is not a directory")
            else:
                update[key] = str(path)
        if "allowed_roots" in values:
            raw_roots = values["allowed_roots"]
            if raw_roots is None:
                update["allowed_roots"] = None
            elif isinstance(raw_roots, list):
                roots = [self._check_root(raw, problems) for raw in raw_roots]
                update["allowed_roots"] = list(dict.fromkeys(str(root) for root in roots if root is not None))
            else:
                problems.append("paths.allowed_roots must be a list of directories")
        if problems:
            raise SettingsError(problems)
        if dry_run:
            return {**self.paths(), "allowed_roots": [str(root) for root in self.allowed_roots()]}
        with self._lock:
            paths = dict(self._section("paths"))
            for key, value in update.items():
                if value is None:
                    paths.pop(key, None)
                else:
                    paths[key] = value
            self._doc["paths"] = paths
            self._save()
        return {**self.paths(), "allowed_roots": [str(root) for root in self.allowed_roots()]}

    def _sets_dir(self) -> Path:
        return (self.data_dir / "sets").resolve()

    def _protected(self) -> list[Path]:
        out = []
        for path in (self.data_dir, REPO_ROOT, *self.protected_dirs):
            try:
                out.append(Path(path).expanduser().resolve())
            except (OSError, RuntimeError):
                continue
        return out

    def _root_problem(self, root: Path) -> str | None:
        """Why `root` (resolved) may not be browsed, or None. Uploaded sets are the one part of
        the data directory (and so of the repository) that is meant to be listed."""
        if root.is_relative_to(self._sets_dir()):
            return None
        if root == Path(root.anchor):
            return "the file system root is not allowed"
        if Path.home().resolve().is_relative_to(root):
            return "the home directory itself is not allowed; choose a folder inside it"
        for protected in self._protected():
            if _related(root, protected):
                return f"it contains or lies inside {protected}, which holds runs, settings or evaluation data"
        return None

    def _check_root(self, raw: Any, problems: list[str]) -> Path | None:
        if not isinstance(raw, str) or not raw.strip() or "\x00" in raw:
            problems.append("paths.allowed_roots entries must be directory paths")
            return None
        path = Path(raw).expanduser()
        if not path.is_absolute():
            problems.append(f"{raw}: an allowed root must be an absolute path")
            return None
        try:
            root = path.resolve(strict=True)
        except (OSError, RuntimeError):
            problems.append(f"{raw}: no such directory")
            return None
        if not root.is_dir():
            problems.append(f"{raw}: not a directory")
            return None
        problem = self._root_problem(root)
        if problem:
            problems.append(f"{raw}: {problem}")
            return None
        return root

    def allowed_roots(self) -> list[Path]:
        """The only source of "may the console look here": resolved directories for
        `security.confine`. The uploaded sets are always in; otherwise the saved list, or the
        places a set usually arrives in (downloads, desktop, removable volumes). Never the home
        directory itself, the repository, runs, settings or evaluation data."""
        with self._lock:
            saved = self._section("paths").get("allowed_roots")
        if isinstance(saved, list):
            candidates = [Path(raw) for raw in saved if isinstance(raw, str) and raw]
        else:
            home = Path.home()
            candidates = [home / "Downloads", home / "Desktop", Path("/Volumes"), Path("/media")]
        roots = [self._sets_dir()]
        for candidate in candidates:
            try:
                root = candidate.expanduser().resolve(strict=True)
            except (OSError, RuntimeError):
                continue
            # checked again on every read: the protected directories can change between starts
            if root.is_dir() and root not in roots and self._root_problem(root) is None:
                roots.append(root)
        return roots
