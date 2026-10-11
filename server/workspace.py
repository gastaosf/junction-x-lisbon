"""Workspace: every run of this server process, the runs on disk, and what may be done to them.

The legacy server owned one run fixed at start-up; the console launches, supervises and replays
many. A `RunHandle` wraps one `RunManager` for the life of the process; `run.json` in each run
directory holds what a restart needs (kind, frozen settings, tasks, operator notes) and is never
part of the interaction log. Runs this process does not hold are read from their logs.

Threading: everything that touches a live session or manager runs on the event-loop thread, and
everything that blocks (exports, recovery, reading logs, hashing, images) in a worker thread that
never touches one. Methods documented as blocking are for `asyncio.to_thread`.

What callers can expect to be raised: `ConsoleError` (carries its HTTP status and detail),
`KeyError` for an unknown run, panorama or set (404), `ValueError` from `safe_id` for a name that
is not safe (400 for a path parameter, 422 for a body field) and `PermissionError` for a path
outside the allowed roots (403).
"""

from __future__ import annotations

import asyncio
import copy
import csv
import hashlib
import json
import os
import secrets
import shutil
import statistics
import threading
import time
import warnings
from collections import deque
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import find_dotenv

from eval.build_set import DEFAULT_DATA_DIR, MANIFEST_NAME, load_manifest
from eval.run_eval import Truth, apply_leak_guards, tasks_from_manifest, truths_from_manifest
from astrolabio import prompts
from astrolabio.config import MODEL_PRICING, Settings, load_settings, pricing_for
from astrolabio.loop import ModelClient
from astrolabio.runner import (
    EVENTS_SUFFIX,
    RunManager,
    export_run,
    new_run_id,
    read_run_lock,
    recover_run,
)
from astrolabio.schema import Label, PanoramaTask
from astrolabio.scoring import RANK_WEIGHTS, SPECIAL_MULTIPLIER, haversine_m, score_list, theta
from astrolabio.session import PanoramaSession
from astrolabio.tools.schemas import (
    ALL_TOOL_NAMES,
    PROTECTED_TOOLS,
    WEB_CLIENT_TOOLS,
    WEB_SEARCH,
    tool_definitions,
    validate_disabled_tools,
)

from .devmodel import MODEL_NAME as FAKE_MODEL_NAME
from .devmodel import DemoClient
from .hub import EventHub, IdempotencyStore
from .jobs import ACTIVE_STATES, Job, JobManager
from .runstate import LogFold, iter_events, run_totals, sort_tiles
from .security import KEY_NAMES, confine, redact, safe_id, truth_allowed
from .sets import ConsoleError, SetStore, preview_image
from .store import BUDGET_FIELDS, LAUNCH_FIELDS, ConsoleStore, SettingsError, validate_launch_settings
from .words import count, plural

__all__ = ["LAUNCH_FIELDS", "PRESETS", "ConsoleError", "RunHandle", "Workspace", "public_settings"]

RUN_FILE = "run.json"
FAKE_MODEL_ENV = "ASTROLABIO_FAKE_MODEL"
DATA_DIR_ENV = "ASTROLABIO_DATA_DIR"
KINDS = ("training", "scoring", "live", "eval")
CUSTOM_KINDS = ("training", "scoring", "live")
# What a run of the scripted demo model can never be: it is launched as training instead.
REHEARSED_KINDS = frozenset({"scoring", "live"})
ACK_KINDS = ("fallback",)
METRICS_WINDOW_S = 900.0
EXPORT_DEBOUNCE_S = 1.0
SETTLE_TIMEOUT_S = 5.0
# A run with no lock and no run.json may be a CLI started before locks existed: silence this
# long is taken as proof that nothing is writing it any more.
RECENT_WRITE_S = 1800.0
REMOVE_ATTEMPTS = 10

# SPEC 10: the scoring run's 60 minutes.
SCORING_PHASES: tuple[dict[str, Any], ...] = (
    {"key": "launch", "label": "Launch", "start_min": 0, "end_min": 2},
    {"key": "autonomous", "label": "Autonomous pass", "start_min": 2, "end_min": 12},
    {"key": "special", "label": "Special One", "start_min": 12, "end_min": 26},
    {"key": "others", "label": "Other panoramas", "start_min": 26, "end_min": 52},
    {"key": "freeze", "label": "Freeze", "start_min": 52, "end_min": 55},
    {"key": "submit", "label": "Submit", "start_min": 55, "end_min": 60},
)

# UI-SPEC 5.3 step 1. Data, so the launch form is built from what the server enforces: `settings`
# are the preset's values, and those named in `locked` are forced whatever the form sends.
PRESETS: dict[str, dict[str, Any]] = {
    "autonomous": {
        "label": "Autonomous batch",
        "description": "Training and trial sets: every panorama runs with human channels off.",
        "settings": {"no_human": True, "concurrency": 6},
        "live_budget": False,
        "kind": "training",
        "requires_special": False,
        "locked": ["no_human"],
    },
    "scoring": {
        "label": "Scoring run",
        "description": "The 60-minute run: human channels on, phase guide, exactly one Special One.",
        "settings": {"no_human": False, "concurrency": 6},
        "live_budget": False,
        "kind": "scoring",
        "requires_special": True,
        "locked": ["no_human"],
        "clock_min": 60,
        "phases": [dict(phase) for phase in SCORING_PHASES],
    },
    "live": {
        "label": "Live on stage",
        "description": "One panorama on the live budget (210 s hard deadline); opens the stage view.",
        "settings": {"no_human": True, "concurrency": 1},
        "live_budget": True,
        "kind": "live",
        "requires_special": False,
        "locked": ["no_human", "live_budget"],
    },
    "eval": {
        "label": "Evaluation",
        "description": "The evaluation set with ground truth: always autonomous, leak guards on.",
        "settings": {"no_human": True},
        "live_budget": False,
        "kind": "eval",
        "requires_special": False,
        "locked": ["no_human", "live_budget"],
    },
    "custom": {
        "label": "Custom",
        "description": "Every field editable.",
        "settings": {},
        "live_budget": False,
        "kind": "training",
        "requires_special": False,
        "locked": [],
    },
}

_SPEC_KEYS = frozenset(
    {
        "preset",
        "set_id",
        "overrides",
        "special",
        "apply_label_to_unlabelled",
        "run_id",
        "kind",
        "settings",
        "live_budget",
        "confirm_no_key",
        "eval",
        "preflight_token",
    }
)
_SET_KEYS = ("set_id", "overrides", "special", "apply_label_to_unlabelled")
# Events after which the run header (totals, state) reads differently.
_RUN_EVENTS = frozenset(
    {
        "run_start",
        "run_resumed",
        "retry",
        "model_response",
        "candidates_update",
        "final_submission",
        "run_end",
        "human_cue",
        "mcq_asked",
        "human_geocode",
    }
)
_MAX_SCORE = 2.0 * sum(RANK_WEIGHTS)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _epoch(ts: Any) -> float | None:
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _iso(epoch_s: float) -> str:
    return datetime.fromtimestamp(epoch_s, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _truthy(raw: str | None) -> bool:
    return (raw or "").strip().lower() in {"1", "true", "yes", "on"}


def public_settings(settings: Settings) -> dict[str, Any]:
    """The one way settings leave the process (run.json, RunState, launch context): the launch
    fields and nothing else, so no key, path or service URL can ride along."""
    dump = settings.model_dump(mode="json")
    return {key: dump[key] for key in LAUNCH_FIELDS}


def _settings_error(exc: SettingsError) -> ConsoleError:
    return ConsoleError(422, "; ".join(exc.problems), code=exc.code, problems=list(exc.problems))


# ---------------------------------------------------------------------------------------------
# run.json

_meta_locks: dict[str, threading.Lock] = {}
_meta_locks_guard = threading.Lock()


def read_meta(run_dir: Path) -> dict[str, Any] | None:
    try:
        meta = json.loads((Path(run_dir) / RUN_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def update_run_json(run_dir: Path, change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    """Read, change and atomically rewrite a run's run.json under that run's lock; the only
    writer of the file. `change` edits the dict in place. Returns what was written."""
    run_dir = Path(run_dir)
    with _meta_locks_guard:
        lock = _meta_locks.setdefault(str(run_dir), threading.Lock())
    with lock:
        # a directory the CLI made has none: say so, or a note on it would turn it into a console run
        meta = read_meta(run_dir) or {"run_id": run_dir.name, "kind": "cli"}
        change(meta)
        run_dir.mkdir(parents=True, exist_ok=True)
        tmp = run_dir / f".{RUN_FILE}.{os.getpid()}.{threading.get_ident()}.tmp"
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, run_dir / RUN_FILE)
        return meta


def _task_row(task: PanoramaTask, sha256: str | None) -> dict[str, Any]:
    return {
        "panorama_id": task.panorama_id,
        "path": str(task.path),
        "filename": task.path.name,
        "label": task.label.value,
        "timestamp": task.timestamp,
        "special": task.special,
        "provenance": task.provenance,
        "sha256": sha256,
    }


def _tasks_from_meta(meta: Mapping[str, Any] | None) -> dict[str, PanoramaTask]:
    tasks: dict[str, PanoramaTask] = {}
    for row in (meta or {}).get("tasks") or []:
        try:
            task = PanoramaTask.model_validate({key: row.get(key) for key in PanoramaTask.model_fields})
        except Exception:  # a hand-edited row must not hide the others
            continue
        tasks[task.panorama_id] = task
    return tasks


def _set_ids(meta: Mapping[str, Any] | None) -> set[str]:
    meta = meta or {}
    ids = {meta.get("set_id"), *(meta.get("extra_set_ids") or [])}
    return {value for value in ids if isinstance(value, str)}


def _tile_state(fold: LogFold, **options: Any) -> dict[str, Any]:
    """The fold's TileState, with `stop_reason` saying how the answer was fixed ("operator_stop")
    rather than how the conversation then unwound ("cancelled"), as contract A35 has it."""
    tile = fold.tile(**options)
    if fold.final is not None and fold.final_reason:
        tile["stop_reason"] = fold.final_reason
    return tile


class RunHandle:
    """One run this process launched: its manager, its run.json and its bookkeeping. It stays
    for the life of the process, so a finished run is still "owned" and its controls still work."""

    def __init__(
        self,
        run_id: str,
        manager: RunManager,
        settings: Settings,
        meta: dict[str, Any],
        truths: dict[str, Truth] | None = None,
    ) -> None:
        self.run_id = run_id
        self.run_dir = Path(manager.run_dir)
        self.manager = manager
        self.settings = settings
        self.meta = meta
        self.truths = truths or {}
        self.folds: dict[str, LogFold] = {}
        self.task: asyncio.Task[None] | None = None  # the start() in flight, or the last one
        self.after: asyncio.Task[None] | None = None  # what follows it: export, scoring
        self.lock = asyncio.Lock()  # additions, retries and restarts, one at a time
        self.stopped = False
        self.export: dict[str, Any] = {"written_at": None, "problems": {}, "seqs": {}, "files": []}
        self.results: dict[str, Any] | None = None
        self.score_error: str | None = None
        self.clean = False  # the files on disk hold every event (shutdown_sync skips such a run)
        self.embed_images = settings.embed_images  # until a Rebuild chooses otherwise
        self.debounce: asyncio.TimerHandle | None = None
        self.announcing = False
        self.legacy_app: Any = None  # the /legacy/<run_id> sub-app, cached here so it dies with the handle
        self.earlier: dict[str, LogFold] = {}  # panoramas of an earlier launch under this id, not relaunched

    @property
    def kind(self) -> str:
        return str(self.meta.get("kind") or "training")

    @property
    def idle(self) -> bool:
        """No start() and no follow-up export is in flight."""
        return not self.manager.is_running and all(task is None or task.done() for task in (self.task, self.after))

    @property
    def state(self) -> str:
        if not self.idle:
            return "running"
        if self.task is None:
            return "queued"
        return "invalid" if self.export["problems"] or not self.manager.sessions else "finished"

    @property
    def active(self) -> bool:
        return self.state in {"queued", "running"}

    def update_meta(self, change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        """The single way this run's run.json changes."""
        self.meta = update_run_json(self.run_dir, change)
        return self.meta


@dataclass
class _DiskRun:
    """A run directory this process does not hold, as its files describe it."""

    state: dict[str, Any]
    meta: dict[str, Any] | None
    folds: dict[str, LogFold] = field(default_factory=dict)
    logged: set[str] = field(default_factory=set)
    has_lock: bool = False
    newest_log_s: float = 0.0


def _frozen_tasks(folds: Mapping[str, LogFold], logged: Iterable[str]) -> dict[str, dict[str, Any]]:
    """What the logs under a run id already say about each panorama that has one."""
    frozen: dict[str, dict[str, Any]] = {}
    for pid in logged:
        fold = folds[pid]
        if fold.label is None:
            continue  # nothing recorded what it was
        frozen[pid] = {
            "label": fold.label,
            "timestamp": fold.timestamp,
            "special": fold.special,
            "sha256": (fold.image or {}).get("sha256"),
        }
    return frozen


class Workspace:
    def __init__(
        self,
        base_settings: Settings | None = None,
        *,
        data_dir: str | Path | None = None,
        eval_data_dir: str | Path | None = None,
        client_factory: Callable[[Settings], ModelClient | None] | None = None,
        env_path: str | Path | None = None,
        key_tester: Any = None,
        fake_model: bool | None = None,
    ) -> None:
        # Before anything can load .env: only the process environment may select the fake model.
        asked_for_fake = os.environ.get(FAKE_MODEL_ENV)
        self.data_dir = Path(data_dir or os.environ.get(DATA_DIR_ENV) or "data")
        self.eval_data_dir = Path(eval_data_dir) if eval_data_dir is not None else DEFAULT_DATA_DIR
        self.startup_warnings: list[str] = []
        if base_settings is None:
            # the directories saved in Settings apply from this start, ahead of the environment
            saved = ConsoleStore(self.data_dir).paths()
            base_settings = load_settings(
                runs_dir=Path(saved["runs_dir"]) if saved["runs_dir"] else None,
                cache_dir=Path(saved["cache_dir"]) if saved["cache_dir"] else None,
            )
        self.base_settings = base_settings
        self.runs_dir = Path(base_settings.runs_dir)
        self.cache_dir = Path(base_settings.cache_dir)
        if fake_model is None:
            fake_model = _truthy(asked_for_fake)
            if not fake_model and _truthy(os.environ.get(FAKE_MODEL_ENV)):
                self.startup_warnings.append(
                    f"{FAKE_MODEL_ENV} is set in .env and was ignored: the scripted model is only selected "
                    "from the command line's own environment."
                )
                warnings.warn(self.startup_warnings[-1], stacklevel=2)
        self.fake_model = bool(fake_model)
        self.client_factory = client_factory
        self.env_path = Path(env_path) if env_path is not None else Path(find_dotenv() or Path.cwd() / ".env")
        self.key_tester = key_tester
        self.boot_id = secrets.token_hex(8)

        self.store = ConsoleStore(self.data_dir, protected_dirs=(self.runs_dir, self.cache_dir, self.eval_data_dir))
        self.sets = SetStore(self.data_dir, self.store, eval_data_dir=self.eval_data_dir)
        self.sets.references = self._set_references
        self.hub = EventHub()
        self.hub.pano_payload = self._pano_payload
        self.jobs = JobManager(self.hub)
        self.idempotency = IdempotencyStore()
        self.handles: dict[str, RunHandle] = {}
        self.health: dict[str, bool | None] = {"openai": None, "internet": None}

        self._metrics: deque[tuple[float, str, float]] = deque()
        self._export_locks: dict[str, asyncio.Lock] = {}
        self._background: set[asyncio.Task[Any]] = set()
        self._scan_lock = threading.Lock()
        self._disk: dict[str, tuple[Any, _DiskRun]] = {}
        self._fold_cache: dict[str, tuple[int, int, LogFold, str | None]] = {}

    # ------------------------------------------------------------------ settings

    def models(self) -> tuple[str, ...]:
        """The models a launch may name: those we have prices for, and the configured one."""
        return tuple(dict.fromkeys([*MODEL_PRICING, self.base_settings.model]))

    def build_settings(self, form: Mapping[str, Any] | None = None) -> Settings:
        """Settings for a new run: Settings() < environment < saved defaults < `form`.

        `form` may only hold launch fields (SettingsError otherwise). A budget may be partial:
        it is completed from the layers below before it is validated. Prices follow the model,
        the directories are this server's, and the keys are read from the environment now."""
        layered = {**self.base_settings.model_dump(), **self.store.defaults()}
        form = dict(form or {})
        for key in BUDGET_FIELDS:
            if isinstance(form.get(key), Mapping):
                form[key] = {**layered[key], **form[key]}
        clean = validate_launch_settings(form, models=self.models())
        settings = Settings.model_validate({**layered, **clean})
        return self._at_home(settings)

    def _at_home(self, settings: Settings) -> Settings:
        return settings.model_copy(
            update={
                "pricing": pricing_for(settings.model),
                "runs_dir": self.runs_dir,
                "cache_dir": self.cache_dir,
                "disabled_tools": validate_disabled_tools(settings.disabled_tools),
                "google_maps_api_key": os.environ.get("GOOGLE_MAPS_API_KEY") or None,
                "mapillary_token": os.environ.get("MAPILLARY_TOKEN") or None,
            }
        )

    public_settings = staticmethod(public_settings)

    def frozen_settings(self, meta: Mapping[str, Any] | None) -> Settings | None:
        """The Settings a run was launched with, from its run.json: the frozen launch fields over
        this server's base (never the saved defaults, which may have changed since)."""
        frozen = (meta or {}).get("settings")
        if not isinstance(frozen, Mapping):
            return None
        try:
            values = {key: frozen[key] for key in LAUNCH_FIELDS if key in frozen}
            return self._at_home(Settings.model_validate({**self.base_settings.model_dump(), **values}))
        except Exception:  # a hand-edited run.json: fall back to what the logs say
            return None

    def prompt_preview(self, form: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """The system prompt and tool list exactly as a run with these settings would send them."""
        try:
            settings = self.build_settings(form)
        except SettingsError as exc:
            raise _settings_error(exc) from exc
        return {"system_prompt": prompts.build_system_prompt(settings), "tools": tool_definitions(settings)}

    def _client(self, settings: Settings) -> ModelClient | None:
        if self.client_factory is not None:
            return self.client_factory(settings)
        return DemoClient() if self.fake_model else None

    # ------------------------------------------------------------------ health and metrics

    def chips(self) -> dict[str, Any]:
        present = {name: bool(os.environ.get(name)) for name in KEY_NAMES}
        return {
            "openai": {"present": present["OPENAI_API_KEY"], "ok": self.health["openai"]},
            "google": {"present": present["GOOGLE_MAPS_API_KEY"]},
            "mapillary": {"present": present["MAPILLARY_TOKEN"]},
            "internet": {"ok": self.health["internet"]},
            "fake_model": self.fake_model,
            "lan": bool(self.store.lan()["enabled"]),
        }

    def set_health(self, *, openai: bool | None = None, internet: bool | None = None) -> None:
        """Record what a key test or reachability check found, and tell every tab."""
        for name, value in (("openai", openai), ("internet", internet)):
            if value is not None:
                self.health[name] = value
        self.publish_health()

    def publish_health(self) -> None:
        self.hub.publish("health", lambda: {"health": self.chips()})

    def _note_metrics(self, envelope: Mapping[str, Any]) -> None:
        kind, data = envelope.get("type"), envelope.get("data")
        data = data if isinstance(data, dict) else {}
        now = time.monotonic()
        if kind in {"api_retry", "api_error"}:
            self._metrics.append((now, str(kind), 1.0))
            if "timeout" in f"{data.get('type', '')} {data.get('message', '')}".lower():
                self._metrics.append((now, "timeout", 1.0))
        elif kind == "model_response" and isinstance(data.get("latency_ms"), (int, float)):
            self._metrics.append((now, "latency_ms", float(data["latency_ms"])))
        elif kind == "model_request" and isinstance(data.get("image_payload_chars"), (int, float)):
            self._metrics.append((now, "upload_chars", float(data["image_payload_chars"])))
        while self._metrics and now - self._metrics[0][0] > METRICS_WINDOW_S:
            self._metrics.popleft()

    def metrics_window(self) -> dict[str, Any]:
        """What the live runs reported over the last 15 minutes (the health page)."""
        horizon = time.monotonic() - METRICS_WINDOW_S
        recent = [(kind, value) for at, kind, value in self._metrics if at >= horizon]
        latencies = [value for kind, value in recent if kind == "latency_ms"]
        uploads = [value for kind, value in recent if kind == "upload_chars"]
        return {
            "minutes": int(METRICS_WINDOW_S // 60),
            "api_retries": sum(1 for kind, _ in recent if kind == "api_retry"),
            "api_errors": sum(1 for kind, _ in recent if kind == "api_error"),
            "timeouts": sum(1 for kind, _ in recent if kind == "timeout"),
            "median_turn_latency_ms": statistics.median(latencies) if latencies else None,
            "mean_upload_chars": statistics.fmean(uploads) if uploads else None,
        }

    # ------------------------------------------------------------------ the hub

    def _attach(self, handle: RunHandle, session: PanoramaSession) -> None:
        """RunManager.on_session: follow the new session's log. A retried panorama keeps its log,
        and with it the fold and the listener it already has."""
        pid = session.task.panorama_id
        handle.folds[pid] = self.hub.attach(handle.run_id, pid, session.log, fold=LogFold(session.task))
        handle.clean = False
        self.hub.publish("pano", lambda: self._pano_message(handle, pid, None))

    def _pano_message(self, handle: RunHandle, pid: str, event: dict[str, Any] | None) -> dict[str, Any] | None:
        if self.handles.get(handle.run_id) is not handle or pid not in handle.manager.sessions:
            return None
        return {"run_id": handle.run_id, "panorama_id": pid, "event": event, "tile": self._tile(handle, pid)}

    def _pano_payload(self, run_id: str, pid: str, envelope: dict[str, Any], fold: LogFold) -> dict[str, Any] | None:
        """EventHub's hook for every event of a followed log (loop thread)."""
        self._note_metrics(envelope)
        handle = self.handles.get(run_id)
        if handle is None or handle.folds.get(pid) is not fold:
            return None
        handle.clean = False
        if envelope.get("type") in _RUN_EVENTS:
            self._announce_run(handle)
        if not handle.manager.is_running and (handle.task is None or handle.task.done()):
            # Written after the run ended (a toggle, a geocode, a stop): the files must follow.
            self._export_later(handle)
        return self._pano_message(handle, pid, fold.digest(envelope))

    def _announce_run(self, handle: RunHandle) -> None:
        """A `run` message once the loop is free: after the `pano` message that caused it, and
        one for a burst of events."""
        loop = self.hub.bind()
        if handle.announcing or loop is None or loop.is_closed():
            return
        handle.announcing = True

        def announce() -> None:
            handle.announcing = False
            self.publish_run(handle.run_id)

        loop.call_soon(announce)

    def publish_run(self, run_id: str, state: Mapping[str, Any] | None = None) -> None:
        """Tell every tab how a run stands now. `state` is for a run this process does not hold."""

        def payload() -> dict[str, Any] | None:
            handle = self.handles.get(run_id)
            run = self._owned_state(handle, panoramas=False) if handle is not None else state
            if run is None:
                return None
            return {"run_id": run_id, "run": {key: value for key, value in run.items() if key != "panoramas"}}

        self.hub.publish("run", payload)

    def _export_later(self, handle: RunHandle) -> None:
        loop = self.hub.bind()
        if loop is None or loop.is_closed():
            return
        if handle.debounce is not None:
            handle.debounce.cancel()

        def fire() -> None:
            handle.debounce = None
            if self.handles.get(handle.run_id) is handle and not handle.clean:
                self._spawn(self._export_quietly(handle.run_id))

        handle.debounce = loop.call_later(EXPORT_DEBOUNCE_S, fire)

    def _spawn(self, work: Any) -> asyncio.Task[Any]:
        task = asyncio.ensure_future(work)
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return task

    async def _export_quietly(self, run_id: str) -> None:
        try:
            await self.export_now(run_id)
        except Exception:  # nobody is waiting for this export; the next one will say what is wrong
            pass

    # ------------------------------------------------------------------ owned runs

    def owned(self, run_id: str) -> RunHandle | None:
        """The handle of a run this process launched, else None."""
        return self.handles.get(run_id)

    def require_owned(self, run_id: str) -> RunHandle:
        """As `owned`, for an action that needs a live run: KeyError when no such run exists,
        ConsoleError 409 when it exists only on disk (there is nothing to send the action to)."""
        handle = self.handles.get(safe_id(run_id, "run id"))
        if handle is not None:
            return handle
        if not (self.runs_dir / run_id).is_dir():
            raise KeyError(run_id)
        raise ConsoleError(
            409,
            f"Run {run_id} is not running in this server: it can be replayed, exported and downloaded, "
            "but not operated.",
            code="run_not_owned",
        )

    def session(self, run_id: str, panorama_id: str) -> PanoramaSession:
        handle = self.require_owned(run_id)
        return handle.manager.sessions[safe_id(panorama_id, "panorama id")]

    def tile(self, run_id: str, panorama_id: str) -> dict[str, Any]:
        """The TileState of a live panorama as it is right now (the `tile` a POST returns)."""
        handle = self.require_owned(run_id)
        if panorama_id not in handle.manager.sessions:
            raise KeyError(panorama_id)
        return self._tile(handle, panorama_id)

    def _tile(self, handle: RunHandle, pid: str) -> dict[str, Any]:
        session = handle.manager.sessions[pid]
        fold = handle.folds.get(pid) or LogFold(session.task)
        acks = (handle.meta.get("acks") or {}).get(pid) or ()
        tile = _tile_state(
            fold,
            run_id=handle.run_id,
            live_session=session,
            budget=handle.settings.budget_for(session.task.special, live=handle.manager.live),
            settings=handle.settings,
            acks=acks,
            export_problem=handle.export["problems"].get(pid),
        )
        if tile["retryable"]:
            # the manager has the last word: a run closed by Stop or a shutdown takes no retry
            manager = handle.manager
            tile["retryable"] = manager._retry_refusal(session, manager._last_end.get(pid)) is None
        return tile

    def _earlier_tiles(self, handle: RunHandle) -> list[dict[str, Any]]:
        """Panoramas an earlier launch under this run id left in the directory and this launch did
        not take up again: their logs are exported with the rest, so the run shows them too."""
        acks = handle.meta.get("acks") or {}
        return [
            _tile_state(
                fold,
                run_id=handle.run_id,
                settings=handle.settings,
                acks=acks.get(pid) or (),
                export_problem=handle.export["problems"].get(pid),
            )
            for pid, fold in handle.earlier.items()
            if pid not in handle.manager.sessions
        ]

    def _owned_state(self, handle: RunHandle, *, panoramas: bool = True) -> dict[str, Any]:
        tiles = [self._tile(handle, pid) for pid in list(handle.manager.sessions)]
        tiles = sort_tiles(tiles + self._earlier_tiles(handle))
        seqs = handle.export["seqs"]
        export = {
            "written_at": handle.export["written_at"],
            "stale": any(fold.last_seq != seqs.get(pid) for pid, fold in handle.folds.items()),
            "problems": dict(handle.export["problems"]),
        }
        return self._compose(
            handle.run_id,
            handle.meta,
            tiles,
            kind=handle.kind,
            settings=handle.settings,
            state=handle.state,
            owned=True,
            external=False,
            export=export,
            results=handle.results,
            watchdog_remaining_s=handle.manager.watchdog_remaining_s(),
            last_event_ts=max((tile["last_event_ts"] for tile in tiles if tile["last_event_ts"]), default=None),
            panoramas=panoramas,
            stopped=handle.stopped,
        )

    def _compose(
        self,
        run_id: str,
        meta: Mapping[str, Any] | None,
        tiles: list[dict[str, Any]],
        *,
        kind: str,
        settings: Settings | None,
        state: str,
        owned: bool,
        external: bool,
        export: dict[str, Any],
        results: dict[str, Any] | None,
        watchdog_remaining_s: float | None,
        last_event_ts: str | None,
        first_event_ts: str | None = None,
        panoramas: bool = True,
        stopped: bool | None = None,
    ) -> dict[str, Any]:
        """RunState (contract 3.1). Without `settings` (a CLI run) the logs speak for themselves."""
        meta = meta or {}
        active = owned and state in {"queued", "running"}
        human = any(tile["human_enabled"] for tile in tiles) if settings is None else not settings.no_human
        live_budget = bool(meta.get("live_budget"))
        started_at = meta.get("started_at") or first_event_ts
        clock = meta.get("clock_started_at") or started_at
        ended_at = None if active else meta.get("finished_at") or last_event_ts
        begun, ended = _epoch(clock), time.time() if active else _epoch(ended_at)
        # display only: every deadline is counted by the manager's own monotonic clock
        elapsed = max(0.0, ended - begun) if begun is not None and ended is not None else None
        ran, done = _epoch(started_at), _epoch(ended_at)
        wall = done - ran if ran is not None and done is not None else max((t["elapsed_s"] for t in tiles), default=0.0)
        if settings is not None:
            both = (settings.standard.effort, settings.special.effort)
            efforts = (settings.live.effort,) * 2 if live_budget else both
        else:
            efforts = (
                next((t["effort"] for t in tiles if not t["special"]), None),
                next((t["effort"] for t in tiles if t["special"]), None),
            )
        first = tiles[0] if tiles else {}
        run: dict[str, Any] = {
            "run_id": run_id,
            "kind": kind,
            "preset": meta.get("preset"),
            "mode": "assisted" if human else "autonomous",
            "state": state,
            "owned": owned,
            "active": active,
            "external": external,
            "team": settings.team if settings is not None else None,
            "model": settings.model if settings is not None else first.get("model"),
            "effort": {"standard": efforts[0], "special": efforts[1]},
            "created_at": meta.get("created_at") or first_event_ts,
            "started_at": started_at,
            "clock_started_at": clock,
            "finished_at": ended_at,
            "elapsed_s": None if elapsed is None else round(elapsed, 1),
            "wall_time_s": round(max(0.0, wall), 1),
            "watchdog_s": settings.global_watchdog_s if settings is not None else None,
            "watchdog_remaining_s": watchdog_remaining_s,
            "phases": [dict(phase) for phase in SCORING_PHASES] if meta.get("preset") == "scoring" else None,
            "totals": run_totals(tiles, settings),
            "special_present": any(tile["special"] for tile in tiles),
            "no_human": not human,
            "live_budget": live_budget,
            "cue_max_chars": (settings or self.base_settings).cue_max_chars,
            "max_mcq": settings.max_mcq if settings is not None else first.get("max_mcq"),
            "penalty_scope": settings.penalty_scope if settings is not None else None,
            "submitted_at": meta.get("submitted_at"),
            # a note of the truth must never be on screen beside a channel that reaches the agent
            "stage_truth": None if human else dict(meta.get("stage_truth") or {}),
            "settings": public_settings(settings) if settings is not None else None,
            "fake_model": bool(meta.get("fake_model")),
            "set_id": meta.get("set_id"),
            # closed by Stop: it takes no more panoramas (a run on disk remembers it in run.json)
            "stopped": bool(meta.get("stopped")) if stopped is None else stopped,
            "eval": _eval_facts(meta, settings) if kind == "eval" else None,
            "export": export,
            "results": results,
        }
        if panoramas:
            run["panoramas"] = tiles
        return run

    @staticmethod
    def _row(state: Mapping[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in state.items() if key not in {"panoramas", "settings"}}

    def snapshot(self, seq: int | None = None) -> dict[str, Any]:
        """What a tab needs to draw everything this server is running. Loop thread, no awaits."""
        return {
            "boot_id": self.boot_id,
            "seq": self.hub.seq if seq is None else seq,
            "server_time": _now(),
            "runs": [self._owned_state(handle) for handle in list(self.handles.values())],
            "jobs": [job.to_dict() for job in self.jobs.list()],
            "health": self.chips(),
        }

    def subscribe(self) -> tuple[dict[str, Any], asyncio.Queue[dict[str, Any] | None]]:
        """(snapshot, queue) taken in one step, so the queue's first message is snapshot.seq + 1."""
        seq, queue = self.hub.subscribe()
        return self.snapshot(seq), queue

    # ------------------------------------------------------------------ runs on disk

    def _fold(self, path: Path, task: Mapping[str, Any] | None) -> tuple[LogFold, str | None]:
        """(fold, timestamp of the first event) of a log on disk; cached until the file changes."""
        stat = path.stat()
        cached = self._fold_cache.get(str(path))
        if cached is not None and cached[:2] == (stat.st_mtime_ns, stat.st_size):
            return cached[2], cached[3]
        fold, first_ts = LogFold(task), None
        for envelope in iter_events(path):
            first_ts = first_ts or envelope.get("ts")
            fold.apply(envelope)
        self._fold_cache[str(path)] = (stat.st_mtime_ns, stat.st_size, fold, first_ts)
        return fold, first_ts

    def _disk_run(self, run_id: str) -> _DiskRun | None:
        """Blocking. A run directory read from its files alone, or None when there is none. It
        only reads: finishing an interrupted run is the export job's business, never a GET's."""
        run_dir = self.runs_dir / safe_id(run_id, "run id")
        try:
            files = sorted((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in run_dir.iterdir() if p.is_file())
        except OSError:
            return None
        lock = read_run_lock(run_dir)
        external = lock is not None and bool(lock["alive"])
        signature = (tuple(files), external)
        with self._scan_lock:
            cached = self._disk.get(run_id)
            if cached is not None and cached[0] == signature:
                return cached[1]
            view = self._read_disk_run(run_id, run_dir, external)
            view.has_lock = lock is not None
            self._disk[run_id] = (signature, view)
            return view

    def _read_disk_run(self, run_id: str, run_dir: Path, external: bool) -> _DiskRun:
        meta = read_meta(run_dir)
        settings = self.frozen_settings(meta)
        rows = {str(row.get("panorama_id")): row for row in (meta or {}).get("tasks") or [] if isinstance(row, dict)}
        acks = (meta or {}).get("acks") or {}
        live_budget = bool((meta or {}).get("live_budget"))
        problems = _summary_problems(run_dir)
        folds: dict[str, LogFold] = {}
        logged: set[str] = set()
        first_ts: list[str] = []
        last_ts: list[str] = []
        newest, stale = 0.0, False
        for path in sorted(run_dir.glob(f"*{EVENTS_SUFFIX}")):
            pid = path.name[: -len(EVENTS_SUFFIX)]
            fold, began = self._fold(path, rows.get(pid))
            fold.panorama_id = fold.panorama_id or pid
            folds[pid] = fold
            logged.add(pid)
            first_ts += [began] if began else []
            last_ts += [fold.last_event_ts] if fold.last_event_ts else []
            written = path.stat().st_mtime
            newest = max(newest, written)
            try:
                stale = stale or (run_dir / f"{pid}.json").stat().st_mtime < written
            except OSError:
                stale = True
        for pid, row in rows.items():
            folds.setdefault(pid, LogFold(row))
        tiles = []
        for pid, fold in folds.items():
            special = fold.special
            budget = None
            if settings is not None and not fold.budget:
                budget = settings.budget_for(special, live=live_budget)
            tiles.append(
                _tile_state(
                    fold,
                    run_id=run_id,
                    settings=settings,
                    budget=budget,
                    acks=acks.get(pid) or (),
                    export_problem=problems.get(pid),
                )
            )
        if external:
            # Another process is working on these: not ours to operate, and not interrupted either.
            for tile in tiles:
                if tile["status"] == "interrupted":
                    tile.update(
                        status="running" if tile["last_seq"] else "pending",
                        stop_text="another process is running this panorama",
                    )
        tiles = sort_tiles(tiles)
        # A36: unfinished is a panorama that was to run and has no run_end in its last conversation.
        unfinished = any(fold.stop_reason is None for fold in folds.values())
        kind = (meta or {}).get("kind")
        results_config = _json_file(run_dir / "results.json").get("config")
        if kind not in KINDS:
            # `cli.py eval run` writes no run.json, but its results say what it was
            scored_by_cli = isinstance(results_config, dict) and results_config.get("mode") == "run"
            kind = "eval" if scored_by_cli else "cli"
        if external:
            state = "running"
        elif not folds:
            state = "invalid"
        elif unfinished:
            state = "interrupted"
        else:
            state = "invalid" if problems else "finished"
        summary = run_dir / "summary.csv"
        export = {
            "written_at": _iso(summary.stat().st_mtime) if summary.is_file() else None,
            "stale": stale or not summary.is_file(),
            "problems": problems,
        }
        gate_meta = {**(meta or {}), "kind": kind}
        results = _read_results(run_dir, gate_meta) if kind == "eval" else None
        run = self._compose(
            run_id,
            meta,
            tiles,
            kind=kind,
            settings=settings,
            state=state,
            owned=False,
            external=external,
            export=export,
            results=results,
            watchdog_remaining_s=None,
            last_event_ts=max(last_ts, default=None),
            first_event_ts=min(first_ts, default=None),
        )
        if run["created_at"] is None:
            run["created_at"] = _iso(run_dir.stat().st_mtime)
        return _DiskRun(state=run, meta=meta, folds=folds, logged=logged, newest_log_s=newest)

    def _scan_runs(self, skip: Iterable[str]) -> list[dict[str, Any]]:
        """Blocking. A RunRow for every run directory this process does not hold."""
        skip = set(skip)
        try:
            names = sorted(p.name for p in self.runs_dir.iterdir() if p.is_dir())
        except OSError:
            return []
        rows = []
        for name in names:
            if name in skip:
                continue
            try:
                view = self._disk_run(name)
            except ValueError:
                continue  # not a name a run can have
            if view is not None:
                rows.append(self._row(view.state))
        for gone in set(self._disk) - set(names):
            self._disk.pop(gone, None)
        return rows

    async def list_runs(self) -> list[dict[str, Any]]:
        """RunRows of every run: active ones first, then newest first."""
        disk = await asyncio.to_thread(self._scan_runs, list(self.handles))
        # read after the scan: a run launched meanwhile is live, whatever its directory looked like
        owned = [self._row(self._owned_state(handle, panoramas=False)) for handle in list(self.handles.values())]
        disk = [row for row in disk if row["run_id"] not in self.handles]
        rows = sorted(owned + disk, key=lambda row: str(row.get("created_at") or ""), reverse=True)
        return sorted(rows, key=lambda row: not row["active"])

    async def get_run(self, run_id: str) -> dict[str, Any]:
        """RunState of one run, live or rebuilt from disk. KeyError when there is none."""
        handle = self.handles.get(safe_id(run_id, "run id"))
        if handle is not None:
            return self._owned_state(handle)
        view = await asyncio.to_thread(self._disk_run, run_id)
        handle = self.handles.get(run_id)
        if handle is not None:  # launched while the directory was being read
            return self._owned_state(handle)
        if view is None:
            raise KeyError(run_id)
        return view.state

    def run_dir(self, run_id: str) -> Path:
        """The directory of an existing run, confined to the runs directory. KeyError when absent."""
        try:
            return confine(self.runs_dir / safe_id(run_id, "run id"), self.runs_dir)
        except FileNotFoundError:
            raise KeyError(run_id) from None

    def log_path(self, run_id: str, panorama_id: str) -> Path:
        """Where a panorama's event log is (it may not exist yet). Read it in a worker thread."""
        return self.run_dir(run_id) / f"{safe_id(panorama_id, 'panorama id')}{EVENTS_SUFFIX}"

    def _set_references(self, set_id: str) -> tuple[list[str], list[str]]:
        """SetStore's question (any thread): the runs whose run.json names this set, and those of
        them that are queued or running."""
        referencing = []
        try:
            metas = [(p.parent.name, read_meta(p.parent)) for p in self.runs_dir.glob(f"*/{RUN_FILE}")]
        except OSError:
            metas = []
        for run_id, meta in metas:
            rows = (meta or {}).get("tasks") or []
            if set_id in _set_ids(meta) or any((row.get("provenance") or {}).get("set_id") == set_id for row in rows):
                referencing.append(run_id)
        handles = [self.handles.get(run_id) for run_id in referencing]
        return referencing, [handle.run_id for handle in handles if handle is not None and handle.active]

    def pano_image(self, run_id: str, panorama_id: str, width: int | str | None) -> tuple[Path, str]:
        """Blocking. (file, media type) of a run's panorama, the preview cached next to the run's
        images. KeyError when the run or the panorama is not known."""
        run_dir = self.run_dir(run_id)
        pid = safe_id(panorama_id, "panorama id")
        handle = self.handles.get(run_id)
        if handle is not None and pid in handle.manager.sessions:
            source: Path | None = Path(handle.manager.sessions[pid].task.path)
        else:
            task = _tasks_from_meta(read_meta(run_dir)).get(pid)
            source = Path(task.path) if task is not None else _logged_path(run_dir / f"{pid}{EVENTS_SUFFIX}")
        if source is None:
            raise KeyError(panorama_id)
        return preview_image(source, run_dir / pid, width)

    # ------------------------------------------------------------------ launch

    def _resolve(self, preset: str, spec: Mapping[str, Any]) -> tuple[Settings, str, bool]:
        """(settings, kind, live budget) of a launch: the preset's values under the form, with
        what the preset locks put back on top. The kind is the server's to decide."""
        data = PRESETS[preset]
        form = spec.get("settings") or {}
        if not isinstance(form, Mapping):
            raise ConsoleError(422, "settings must be an object.", code="invalid_setting")
        locked = {key: data["settings"][key] for key in data["locked"] if key in data["settings"]}
        try:
            settings = self.build_settings({**data["settings"], **form, **locked})
        except SettingsError as exc:
            raise _settings_error(exc) from exc
        kind, asked = data["kind"], spec.get("kind")
        if preset == "custom" and asked is not None:
            if asked not in CUSTOM_KINDS:
                raise ConsoleError(422, f"kind must be one of {', '.join(CUSTOM_KINDS)}.", code="invalid_kind")
            kind = asked
        elif asked is not None and asked != kind:
            raise ConsoleError(422, f"The {data['label']} preset always creates a {kind} run.", code="invalid_kind")
        live = spec.get("live_budget")
        if live is not None and not isinstance(live, bool):
            raise ConsoleError(422, "live_budget must be true or false.", code="invalid_setting")
        if "live_budget" in data["locked"] or live is None:
            live = data["live_budget"]
        return settings, kind, bool(live)

    async def _existing(
        self, run_id: str
    ) -> tuple[dict[str, Any], dict[str, dict[str, Any]], dict[str, LogFold]] | None:
        """(state, logged tasks, folds of every panorama) of whatever already answers to a run id."""
        handle = self.handles.get(run_id)
        if handle is not None:
            folds = {**handle.earlier, **handle.folds}
            logged = [pid for pid, fold in folds.items() if fold.last_seq]
            return self._owned_state(handle, panoramas=False), _frozen_tasks(folds, logged), folds
        view = await asyncio.to_thread(self._disk_run, run_id)
        if view is None:
            return None
        return view.state, _frozen_tasks(view.folds, view.logged), view.folds

    @staticmethod
    def _refuse_reuse(run_id: str, kind: str, settings: Settings, state: Mapping[str, Any]) -> None:
        """A20: what a run was cannot change under its id."""

        def refuse(why: str, code: str = "run_id_in_use") -> ConsoleError:
            return ConsoleError(409, f"Run id {run_id} cannot be reused: {why}. Choose another run id.", code=code)

        if state["active"]:
            raise refuse("that run is still going", "run_active")
        if state["external"]:
            raise refuse("another process is writing it", "run_owned_elsewhere")
        if not state["totals"]["total"]:
            return  # an empty directory holds nothing to contradict
        if "eval" in {state["kind"], kind}:
            raise refuse("an evaluation run never shares its directory")
        if state["kind"] != "cli" and state["kind"] != kind:
            raise refuse(f"it is a {state['kind']} run and this would be a {kind} run")
        if state["no_human"] != settings.no_human:
            raise refuse("its human channels were " + ("off" if state["no_human"] else "on") + " and must stay so")

    def _eval_tasks(self, spec: Mapping[str, Any]) -> tuple[list[PanoramaTask], dict[str, Truth], dict[str, Any]]:
        """Blocking. The evaluation set as tasks, with the truths the leak guards need."""
        present = [key for key in _SET_KEYS if spec.get(key) not in (None, {}, "")]
        if present:
            raise ConsoleError(
                422,
                "An evaluation run takes its panoramas from the evaluation set: "
                + ", ".join(present)
                + " cannot be sent.",
                code="eval_takes_no_set",
                problems=present,
            )
        manifest = self.eval_data_dir / MANIFEST_NAME
        try:
            entries = load_manifest(manifest)
        except (OSError, ValueError) as exc:
            raise ConsoleError(
                409, "There is no evaluation set yet. Build one on the Evaluation screen.", code="no_eval_set"
            ) from exc
        todo = [str(entry.get("panorama_id")) for entry in entries if _label_or_none(entry.get("label")) is None]
        if todo:
            raise ConsoleError(
                409,
                f"{count(len(todo), 'evaluation panorama')} still {plural(len(todo), 'has')} no Urban / non-Urban "
                f"label: {', '.join(todo)}. Confirm every label on the Evaluation screen first.",
                code="todo_labels",
                problems=todo,
            )
        try:
            truths = truths_from_manifest(entries)
        except (KeyError, TypeError, ValueError) as exc:
            raise ConsoleError(409, f"The evaluation manifest cannot be used: {exc}", code="invalid_eval_set") from exc
        options = spec.get("eval") or {}
        limit = options.get("limit") if isinstance(options, Mapping) else None
        if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit < 1):
            raise ConsoleError(422, "eval.limit must be a whole number above 0, or null.", code="invalid_limit")
        tasks = tasks_from_manifest(entries[:limit] if limit else entries, self.eval_data_dir)
        missing = [task.panorama_id for task in tasks if not task.path.is_file()]
        if not tasks or missing:
            raise ConsoleError(
                409,
                "The evaluation set is incomplete" + (f" (no image for {', '.join(missing)})" if missing else "") + ".",
                code="invalid_eval_set",
            )
        chosen = {task.panorama_id: truths[task.panorama_id] for task in tasks}
        return tasks, chosen, {"manifest": str(manifest), "limit": limit}

    def _set_tasks(
        self,
        spec: Mapping[str, Any],
        preset: str,
        settings: Settings,
        live: bool,
        frozen: Mapping[str, Mapping[str, Any]] | None,
        default_source: str,
    ) -> tuple[list[PanoramaTask], float]:
        """Blocking. The tasks of a launch from a set, after the same verdict the page was shown."""
        set_id = spec.get("set_id")
        if not isinstance(set_id, str) or not set_id:
            raise ConsoleError(422, "Choose the panoramas to run: set_id is missing.", code="no_set")
        choices = {
            "overrides": spec.get("overrides") or None,
            "special": spec.get("special") or None,
            "apply_label_to_unlabelled": spec.get("apply_label_to_unlabelled") or None,
            "default_source": default_source,
        }
        try:
            verdict = self.sets.preflight(
                set_id, preset=preset, live_budget=live, settings=settings, frozen=frozen, **choices
            )
        except KeyError:
            raise ConsoleError(422, f"There is no set {set_id}.", code="unknown_set") from None
        _refuse_blocked(verdict)
        token = spec.get("preflight_token")
        if token is not None and token != verdict["preflight_token"]:
            raise ConsoleError(
                422,
                "The set changed since it was checked. Look at the preflight table again, then launch.",
                code="set_changed",
            )
        return self.sets.tasks(set_id, **choices), verdict["cost_ceiling_usd"]

    async def preflight(self, set_id: str, body: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """The preflight verdict for exactly these inputs; changes nothing. With `run_id` the rows
        are judged as additions to that run; `launch_run_id` is the id a new launch would reuse."""
        body = body or {}
        preset = body.get("preset") or "custom"
        if preset not in PRESETS or preset == "eval":
            raise ConsoleError(422, "preset must be one of autonomous, scoring, live or custom.", code="invalid_preset")
        options: dict[str, Any] = {}
        if body.get("run_id") is not None:
            handle = self.require_owned(body["run_id"])
            settings, live = handle.settings, handle.manager.live
            preset = str(handle.meta.get("preset") or "custom")
            options = self._addition(handle)
        else:
            settings, _, live = self._resolve(preset, body)
            if body.get("launch_run_id") is not None:
                existing = await self._existing(safe_id(body["launch_run_id"], "run id"))
                options = {"frozen": existing[1] if existing else None}
        return await asyncio.to_thread(
            self.sets.preflight,
            safe_id(set_id, "set id"),
            preset=preset,
            overrides=body.get("overrides") or None,
            special=body.get("special") or None,
            apply_label_to_unlabelled=body.get("apply_label_to_unlabelled") or None,
            live_budget=live,
            settings=settings,
            **options,
        )

    @staticmethod
    def _addition(handle: RunHandle) -> dict[str, Any]:
        """What a set is judged against when its panoramas are to join this run."""
        sessions = handle.manager.sessions
        return {
            # an earlier launch's panorama keeps its id and its log to itself
            "taken_ids": list(dict.fromkeys([*sessions, *handle.earlier])),
            "run_has_special": any(session.task.special for session in sessions.values()),
            "taken_sha256": [row.get("sha256") for row in handle.meta.get("tasks") or [] if row.get("sha256")],
        }

    async def launch(self, spec: Mapping[str, Any], *, default_source: str = "operator_bulk") -> dict[str, Any]:
        """Create and start a run from a LaunchSpec; returns `{run_id, url, cost_ceiling_usd}`.

        The only way a run starts: the eval path (TODO refusal, leak guards), the presets' locks,
        the reuse rules and the write-ahead run.json all live here."""
        if not isinstance(spec, Mapping):
            raise ConsoleError(422, "The launch request must be an object.", code="invalid_request")
        unknown = sorted(str(key) for key in spec if key not in _SPEC_KEYS)
        if unknown:
            raise ConsoleError(
                422,
                f"Unknown launch {plural(len(unknown), 'field')}: " + ", ".join(unknown) + ".",
                code="unknown_field",
                problems=unknown,
            )
        preset = spec.get("preset")
        if preset not in PRESETS:
            raise ConsoleError(422, f"preset must be one of {', '.join(PRESETS)}.", code="invalid_preset")
        settings, kind, live = self._resolve(preset, spec)
        if self.fake_model:
            # A rehearsal. The preset stays (its 60-minute phase guide, the live budget, the stage
            # view), so the scoring hour can be practised without spending; but answers a script
            # made up are never a scoring or a live run: the kind is training, run.json says
            # fake_model, the submission checklist fails on it and the zip asks first.
            if kind in REHEARSED_KINDS:
                kind = "training"
            # the frozen settings, the log and the exports must all say what answered
            settings = self._at_home(settings.model_copy(update={"model": FAKE_MODEL_NAME}))
        needs_key = not self.fake_model and self.client_factory is None
        if needs_key and not os.environ.get("OPENAI_API_KEY") and spec.get("confirm_no_key") is not True:
            raise ConsoleError(
                422,
                "There is no OpenAI key: every panorama would get the fallback answer. Set the key in "
                "Settings, or confirm to launch anyway.",
                code="openai_key_missing",
                action="confirm_no_key",
            )
        run_id = spec.get("run_id") or None
        try:
            run_id = safe_id(run_id, "run id") if run_id is not None else self._fresh_run_id()
        except ValueError as exc:
            raise ConsoleError(422, str(exc), code="invalid_run_id") from exc
        run_dir = confine(self.runs_dir / run_id, self.runs_dir, strict=False)

        existing = await self._existing(run_id)
        if existing is not None:
            self._refuse_reuse(run_id, kind, settings, existing[0])
        truths: dict[str, Truth] = {}
        eval_meta: dict[str, Any] | None = None
        if preset == "eval":
            tasks, truths, eval_meta = await asyncio.to_thread(self._eval_tasks, spec)
            ceiling = round(sum(settings.budget_for(task.special, live=live).max_spend_usd for task in tasks), 2)
        else:
            frozen = existing[1] if existing else None
            tasks, ceiling = await asyncio.to_thread(
                self._set_tasks, spec, preset, settings, live, frozen, default_source
            )
        shas = await asyncio.to_thread(lambda: {task.panorama_id: self.sets.sha256(task.path) for task in tasks})
        earlier = {pid: fold for pid, fold in (existing[2] if existing else {}).items() if pid not in shas}
        unfinished = sorted(pid for pid, fold in earlier.items() if fold.stop_reason is None)
        if unfinished:
            # nothing would ever finish them: this process does not recover a run it is running
            raise ConsoleError(
                409,
                f"Run {run_id} was interrupted and this launch would leave {', '.join(unfinished)} unfinished. "
                "Rebuild its exports first (Runs, Rebuild exports), or choose another run id.",
                code="run_interrupted",
            )

        # From here to the start there is no await: a second launch of the same id finds this one.
        old = self.handles.get(run_id)
        if old is not None and old.active:
            raise ConsoleError(409, f"Run {run_id} is still going. Choose another run id.", code="run_active")
        now = _now()
        frozen_settings = public_settings(settings)
        digest = hashlib.sha256(json.dumps(frozen_settings, sort_keys=True).encode()).hexdigest()

        def write(meta: dict[str, Any]) -> None:
            rows = {row.get("panorama_id"): row for row in meta.get("tasks") or [] if isinstance(row, dict)}
            rows.update({task.panorama_id: _task_row(task, shas[task.panorama_id]) for task in tasks})
            meta.update(
                run_id=run_id,
                kind=kind,
                preset=preset,
                mode="autonomous" if settings.no_human else "assisted",
                created_at=meta.get("created_at") or now,
                started_at=now,
                clock_started_at=now,
                finished_at=None,
                settings=frozen_settings,
                live_budget=live,
                set_id=None if preset == "eval" else spec.get("set_id"),
                fake_model=self.fake_model,
                stopped=False,
                tasks=list(rows.values()),
                submitted_at=None,
                stage_truth=meta.get("stage_truth") or {},
                acks=meta.get("acks") or {},
                eval=eval_meta,
                launches=[*(meta.get("launches") or []), {"at": now, "settings_sha256": digest}],
            )

        # Write-ahead: a crash from here on leaves a run whose queued panoramas are known.
        before = read_meta(run_dir)
        meta = update_run_json(run_dir, write)
        manager = RunManager(settings, run_id=run_id, client=self._client(settings), live=live, boot_id=self.boot_id)
        handle = RunHandle(run_id, manager, settings, meta, truths)
        handle.earlier = earlier
        if old is not None:
            self._drop(old)
        self.handles[run_id] = handle
        self._disk.pop(run_id, None)
        self.publish_run(run_id)  # before its tiles: a tab must know the run to place them
        manager.on_session(lambda session: self._attach(handle, session))
        try:
            manager.add_tasks(tasks)
            if truths:
                apply_leak_guards(manager.sessions, truths)
        except Exception as exc:
            self._drop(handle)
            # nothing was started: the directory must not be left describing a run that never was
            if before is None:
                (run_dir / RUN_FILE).unlink(missing_ok=True)
            else:

                def restore(meta: dict[str, Any]) -> None:
                    meta.clear()
                    meta.update(before)

                update_run_json(run_dir, restore)
            raise ConsoleError(409, f"Run {run_id} could not be created: {redact(exc)}", code="launch_failed") from exc
        self._start(handle)
        self.publish_run(run_id)
        self.hub.publish("index", {})
        return {
            "run_id": run_id,
            "url": f"/runs/{run_id}/stage" if preset == "live" else f"/runs/{run_id}",
            "cost_ceiling_usd": ceiling,
        }

    async def launch_path(
        self,
        path: str | Path,
        *,
        special: str | None = None,
        label: Label | str | None = None,
        settings_overrides: Mapping[str, Any] | None = None,
        live: bool = False,
        run_id: str | None = None,
        concurrency: int | None = None,
    ) -> dict[str, Any]:
        """`serve <directory>`: run a directory the operator named in the server's own terminal.
        It becomes a path set without the allowed-roots check, which only guards the browser."""
        created = await asyncio.to_thread(self.sets.create_path, path, confined=False)
        form = {key: value for key, value in (settings_overrides or {}).items() if value is not None}
        if concurrency is not None:
            form["concurrency"] = concurrency
        try:
            human = not self.build_settings(form).no_human
        except SettingsError as exc:
            raise _settings_error(exc) from exc
        # With the operator's channels on, this is the scoring run of old; a scripted model can
        # only ever make a training run.
        kind = "training" if self.fake_model or not (human or live) else "live" if live else "scoring"
        default_label = None if label is None else (label if isinstance(label, Label) else Label.parse(label)).value
        spec = {
            "preset": "custom",
            "set_id": created["set_id"],
            "special": special,
            "apply_label_to_unlabelled": default_label,
            "run_id": run_id,
            "kind": kind,
            "settings": form,
            "live_budget": live,
            "confirm_no_key": True,
        }
        return await self.launch(spec, default_source="default")

    def _fresh_run_id(self) -> str:
        run_id, n = new_run_id(), 2
        while (self.runs_dir / run_id).exists() or run_id in self.handles:
            run_id, n = f"{new_run_id()}-{n}", n + 1  # two launches inside one second
        return run_id

    def _start(self, handle: RunHandle) -> None:
        handle.task = handle.manager.start_background(handle.settings.concurrency)
        handle.after = self._spawn(self._after_run(handle, handle.task))

    async def _after_run(self, handle: RunHandle, task: asyncio.Task[None]) -> None:
        """Once start() has returned every panorama has its run_end, so the files written now are
        complete; an eval run is scored from them."""
        await asyncio.wait({task})
        if not task.cancelled() and task.exception() is not None:
            handle.score_error = redact(f"the run stopped early: {task.exception()!r}")
        try:
            await self.export_now(handle.run_id)
            if handle.kind == "eval":
                await self._score(handle.run_dir, handle.meta, handle)
            handle.update_meta(lambda meta: meta.update(finished_at=_now()))
        except Exception as exc:  # the run itself is over and logged; Rebuild can repeat this
            handle.score_error = redact(f"{type(exc).__name__}: {exc}")
        self._announce_run(handle)
        self.hub.publish("index", {})

    async def _ensure_running(self, handle: RunHandle) -> None:
        """After an addition or a retry: a run that is no longer taking panoramas is started
        again, once its previous start() and what followed have finished. Under handle.lock."""
        if handle.manager.is_running:
            return
        waiting = [task for task in (handle.task, handle.after) if task is not None and not task.done()]
        if waiting:
            await asyncio.wait(waiting)
        handle.update_meta(lambda meta: meta.update(finished_at=None))
        self._start(handle)

    def _drop(self, handle: RunHandle) -> None:
        """Forget a handle in one synchronous step: no route may reach its sessions afterwards
        (they hold EventLog objects whose seq would collide with a new session's)."""
        if handle.debounce is not None:
            handle.debounce.cancel()
        self.hub.detach_run(handle.run_id)
        if self.handles.get(handle.run_id) is handle:
            del self.handles[handle.run_id]
        handle.legacy_app = None
        self.hub.publish("run", {"run_id": handle.run_id, "run": None, "removed": True})

    # ------------------------------------------------------------------ lifecycle

    async def add_panoramas(self, run_id: str, body: Mapping[str, Any]) -> dict[str, Any]:
        """Add a set's panoramas to a run of this process; returns `{added, skipped}`. A task
        that is already in the run cannot be touched: overrides may only name new rows."""
        handle = self.require_owned(run_id)
        if handle.kind == "eval":
            raise ConsoleError(
                409, "An evaluation run takes its panoramas from the evaluation set only.", code="eval_run"
            )
        if not isinstance(body, Mapping) or not isinstance(body.get("set_id"), str):
            raise ConsoleError(422, "Choose the panoramas to add: set_id is missing.", code="no_set")
        unknown = sorted(str(key) for key in body if key not in _SET_KEYS)
        if unknown:
            raise ConsoleError(
                422,
                f"Unknown {plural(len(unknown), 'field')}: " + ", ".join(unknown) + ".",
                code="unknown_field",
                problems=unknown,
            )
        overrides, special = body.get("overrides") or None, body.get("special") or None
        choices = {
            "overrides": overrides,
            "special": special,
            "apply_label_to_unlabelled": body.get("apply_label_to_unlabelled") or None,
        }
        async with handle.lock:  # a double submit must find the first one's panoramas
            if handle.stopped:
                raise ConsoleError(409, f"Run {run_id} was stopped; launch a new run instead.", code="run_stopped")
            judged = self._addition(handle)
            if special is not None and judged["run_has_special"]:
                raise ConsoleError(409, "This run already has its Special One.", code="special_already_in_run")
            known = {
                name.casefold()
                for session in handle.manager.sessions.values()
                for name in (session.task.panorama_id, session.task.path.name, session.task.path.stem)
            }
            keys = [*(overrides if isinstance(overrides, Mapping) else {}), *([special] if special else [])]
            touched = sorted(str(key) for key in keys if str(key).casefold() in known)
            if touched:
                raise ConsoleError(
                    422,
                    "Already in the run and cannot change: " + ", ".join(touched) + ". Name new panoramas by the "
                    "id the preflight table shows.",
                    code="task_is_frozen",
                    problems=touched,
                )
            set_id = safe_id(body["set_id"], "set id")
            preset = str(handle.meta.get("preset") or "custom")
            try:
                verdict = await asyncio.to_thread(
                    self.sets.preflight,
                    set_id,
                    preset=preset,
                    live_budget=handle.manager.live,
                    settings=handle.settings,
                    **choices,
                    **judged,
                )
            except KeyError:
                raise ConsoleError(422, f"There is no set {set_id}.", code="unknown_set") from None
            _refuse_blocked(verdict)
            rows = {row["panorama_id"]: row for row in verdict["rows"]}
            skip = [pid for pid, row in rows.items() if row["duplicate"]]
            tasks = await asyncio.to_thread(
                self.sets.tasks, set_id, taken_ids=judged["taken_ids"], skip=skip, **choices
            )
            if handle.stopped or self.handles.get(run_id) is not handle:
                raise ConsoleError(409, f"Run {run_id} was stopped; launch a new run instead.", code="run_stopped")
            added = [_task_row(task, rows[task.panorama_id]["sha256"]) for task in tasks]

            def write(meta: dict[str, Any]) -> None:
                meta["tasks"] = [*(meta.get("tasks") or []), *added]
                meta["extra_set_ids"] = sorted({*(meta.get("extra_set_ids") or []), set_id} - {meta.get("set_id")})

            handle.update_meta(write)  # before the sessions exist: a crash must not lose queued panoramas
            try:
                handle.manager.add_tasks(tasks)
            except (ValueError, RuntimeError) as exc:
                raise ConsoleError(409, f"The panoramas could not be added: {exc}", code="add_failed") from exc
            if tasks:
                await self._ensure_running(handle)
        self.publish_run(run_id)
        return {
            "added": [task.panorama_id for task in tasks],
            "skipped": [row["filename"] for row in verdict["rows"] if row["duplicate"]],
        }

    async def _idle(self, handle: RunHandle) -> None:
        waiting = [task for task in (handle.task, handle.after) if task is not None and not task.done()]
        if waiting:
            await asyncio.wait(waiting)

    async def stop_run(self, run_id: str) -> dict[str, Any]:
        """The console's Ctrl-C: every panorama is finalised with its best list, what is in
        flight is cancelled, and the files are written. The log of every panorama records it."""
        handle = self.require_owned(run_id)
        sessions = list(handle.manager.sessions.values())
        pending = sum(1 for session in sessions if session.final is None)
        if pending or not handle.stopped:
            for session in sessions:
                session.log.emit("harness", "operator_stop", {"panoramas_finalised": pending})
        if not handle.stopped:
            handle.stopped = True
            handle.update_meta(lambda meta: meta.update(stopped=True))
        handle.manager.stop("operator_stop")
        await self._idle(handle)
        if not handle.clean:
            await self.export_now(run_id)
        # every tab learns that the run is closed, also when no panorama was left to finalise
        self.publish_run(run_id)
        return self._owned_state(handle)

    async def finalize_all(self, run_id: str) -> dict[str, Any]:
        """Fix every answer as it stands and stop working; the run can still take new panoramas."""
        handle = self.require_owned(run_id)
        if any(session.final is None for session in handle.manager.sessions.values()):
            handle.manager.stop("operator_finalize_all")
        await self._idle(handle)
        if not handle.clean:
            await self.export_now(run_id)
        return self._owned_state(handle)

    async def finalize(self, run_id: str, panorama_id: str) -> dict[str, Any]:
        """Fix one panorama's answer now. Nothing happens (and nothing is logged) when it is final."""
        handle = self.require_owned(run_id)
        session = handle.manager.sessions[panorama_id]
        if session.final is None:
            handle.manager.finalize(panorama_id, "operator_finalize")
            await self.settle(run_id, panorama_id)
        return self._tile(handle, panorama_id)

    async def settle(self, run_id: str, panorama_id: str) -> None:
        """After an operator action fixed a panorama's answer (finalize, geocode): stop the
        conversation still in flight, wait for its run_end, then write the files, so that what
        is on disk is what the page shows."""
        handle = self.require_owned(run_id)
        session = handle.manager.sessions[panorama_id]
        if session.final is None:
            return
        handle.manager.finalize(panorama_id, "operator_finalize")  # already final: only halts the work
        job = handle.manager._jobs.get(panorama_id)  # the manager's per-panorama task (contract A31)
        if job is not None and not job.done():
            await asyncio.wait({job}, timeout=SETTLE_TIMEOUT_S)
        await self.export_now(run_id)

    async def retry(self, run_id: str, panorama_id: str) -> dict[str, Any]:
        """A new conversation for a panorama that ended without an agent answer; its tile."""
        handle = self.require_owned(run_id)
        if panorama_id not in handle.manager.sessions:
            raise KeyError(panorama_id)
        async with handle.lock:
            try:
                session = handle.manager.retry(panorama_id)
            except (ValueError, RuntimeError) as exc:
                raise ConsoleError(409, str(exc), code="not_retryable") from exc
            if panorama_id in handle.truths:
                # the new session must not be able to fetch its own source image either
                apply_leak_guards({panorama_id: session}, {panorama_id: handle.truths[panorama_id]})
            await self._ensure_running(handle)
        self.publish_run(run_id)
        return self._tile(handle, panorama_id)

    async def export_now(self, run_id: str, *, embed_images: bool | None = None) -> dict[str, Any]:
        """Write a run's exports from its logs; the only path by which they are written, one at a
        time per run. Returns `{written_at, problems, files}`. Changes no answer and logs nothing."""
        run_dir = self.run_dir(run_id)
        lock = self._export_locks.setdefault(run_id, asyncio.Lock())
        async with lock:
            handle = self.handles.get(run_id)
            if handle is not None:
                settings: Settings = handle.settings
                sessions = dict(handle.manager.sessions)
                tasks = {**_tasks_from_meta(handle.meta), **{pid: s.task for pid, s in sessions.items()}}
                seqs = {pid: fold.last_seq for pid, fold in handle.folds.items()}
                # a panorama that is still working has no answer to validate yet
                unfinished = {pid for pid, session in sessions.items() if session.final is None}
            else:
                meta = await asyncio.to_thread(read_meta, run_dir)
                settings = self.frozen_settings(meta) or self.base_settings
                tasks, seqs, unfinished = _tasks_from_meta(meta), {}, set()
            if handle is not None:
                # the choice made at a Rebuild holds for the automatic exports that follow it
                handle.embed_images = handle.embed_images if embed_images is None else bool(embed_images)
                embed = handle.embed_images
            else:
                embed = settings.embed_images if embed_images is None else bool(embed_images)
            paths, rows = await asyncio.to_thread(
                export_run, run_dir, team=settings.team, embed_images=embed, tasks=tasks
            )
            info = {
                "written_at": _now(),
                "problems": {
                    str(row["panorama"]): row["problems"]
                    for row in rows
                    if row.get("problems") and row["panorama"] not in unfinished
                },
                "seqs": seqs,
                "files": [str(path) for path in paths],
            }
            if handle is not None and self.handles.get(run_id) is handle:
                handle.export = info
                handle.manager.summary = rows
                handle.clean = all(fold.last_seq == seqs.get(pid) for pid, fold in handle.folds.items())
        self._disk.pop(run_id, None)
        self.publish_run(run_id)
        self.hub.publish("index", {})
        return {key: info[key] for key in ("written_at", "problems", "files")}

    async def start_export(self, run_id: str, *, embed_images: bool | None = None, force: bool = False) -> Job:
        """The Rebuild-exports job. For an interrupted run the logs are finished first
        (`recover_run`); a run that is running here, or elsewhere, is never recovered."""
        run_dir = self.run_dir(run_id)
        running = self.jobs.find("export", ACTIVE_STATES, run_id=run_id)
        if running is not None:
            return running
        handle = self.handles.get(run_id)
        recover, kind, meta = False, "", None
        if handle is None:
            view = await asyncio.to_thread(self._disk_run, run_id)
            if view is None:
                raise KeyError(run_id)
            kind, meta = view.state["kind"], view.meta
            if view.state["external"] and not force:
                raise ConsoleError(
                    409,
                    f"Run {run_id} is being written by another process. Rebuilding now only copies its logs as "
                    "they stand; confirm to do that anyway.",
                    code="run_owned_elsewhere",
                    action="force",
                )
            recover = view.state["state"] == "interrupted"
            unowned = (view.meta or {}).get("kind") in (None, "cli") and not view.has_lock
            if recover and unowned and time.time() - view.newest_log_s < RECENT_WRITE_S and not force:
                raise ConsoleError(
                    409,
                    f"The logs of run {run_id} changed less than 30 minutes ago and nothing says who was "
                    "writing them. If that process is gone, confirm to finish the logs and rebuild.",
                    code="run_recently_written",
                    action="force",
                )
        settings = self.frozen_settings(meta) or self.base_settings

        async def work(job: Job) -> dict[str, Any]:
            recovered: list[str] = []
            if recover:
                job.log("finishing the logs of panoramas that have no final answer")
                recovered = await asyncio.to_thread(
                    recover_run, run_dir, settings=settings, tasks=_tasks_from_meta(meta) or None
                )
                job.log(f"recovered: {', '.join(recovered) or 'nothing'}")
                self._disk.pop(run_id, None)
            job.progress(1, 2, "writing the exports")
            info = await self.export_now(run_id, embed_images=embed_images)
            if (handle.kind if handle is not None else kind) == "eval":
                job.log("scoring against the evaluation manifest")
                await self._score(run_dir, {**(meta or {}), "kind": "eval"} if handle is None else handle.meta, handle)
            job.progress(2, 2, "done")
            return {"recovered": recovered, **info}

        return self.jobs.start("export", f"Rebuild exports of {run_id}", work, run_id=run_id)

    def eval_config(self, meta: Mapping[str, Any]) -> dict[str, Any]:
        """The `config` block of results.json for a run launched here, as `eval.run_eval.run`
        writes it, from the settings frozen in its run.json."""
        settings = self.frozen_settings(meta) or self.base_settings
        panoramas = len(meta.get("tasks") or [])
        manifest = (meta.get("eval") or {}).get("manifest") or str(self.eval_data_dir / MANIFEST_NAME)
        return {
            "mode": "run",
            "model": settings.model,
            "effort": {"standard": settings.standard.effort, "special": settings.special.effort},
            "hedge": settings.hedge,
            "allow_duplicates": settings.allow_duplicates,
            "allow_web": settings.allow_web,
            "tools_off": list(settings.disabled_tools),
            "manifest": manifest,
            "panoramas": panoramas,
            "fake_model": bool(meta.get("fake_model")),
        }

    async def _score(self, run_dir: Path, meta: Mapping[str, Any], handle: RunHandle | None) -> None:
        """Score an eval run with server.evalops, when that module exists. Behind the truth gate:
        a run in which a human channel was used never meets the manifest."""
        if meta.get("kind") != "eval" or not await asyncio.to_thread(truth_allowed, meta, run_dir):
            return
        try:
            from . import evalops
        except ImportError:
            return
        config = self.eval_config(meta)
        try:
            await asyncio.to_thread(evalops.score_run_dir, run_dir, Path(config["manifest"]), config)
        except Exception as exc:
            if handle is not None:
                handle.score_error = redact(f"scoring failed: {type(exc).__name__}: {exc}")
        results = await asyncio.to_thread(_read_results, run_dir, meta)
        if handle is not None:
            handle.results = results
        self._disk.pop(run_dir.name, None)

    async def refresh_results(self, run_id: str) -> None:
        """After a rescore wrote a result file: the run's row in every tab shows the new variant."""
        run_dir = self.run_dir(run_id)
        handle = self.handles.get(run_id)
        if handle is not None:
            handle.results = await asyncio.to_thread(_read_results, run_dir, handle.meta)
        self._disk.pop(run_id, None)
        self.publish_run(run_id)
        self.hub.publish("index", {})

    async def delete_run(self, run_id: str, confirm: Any) -> None:
        """Remove a run directory. Refused for a run that is going (here or elsewhere) and for a
        scoring run, which is never deleted from the console (U3)."""
        target = self.run_dir(run_id)
        root = self.runs_dir.resolve()
        if target == root or target.parent != root:
            raise ConsoleError(403, "Only a run directory can be deleted.", code="not_a_run")
        if confirm != run_id:
            raise ConsoleError(422, "Type the run id to confirm the deletion.", code="confirmation_mismatch")
        state = await self.get_run(run_id)
        if state["active"] or self.jobs.find("export", ACTIVE_STATES, run_id=run_id) is not None:
            raise ConsoleError(409, f"Run {run_id} is still going; stop it first.", code="run_active")
        if state["external"]:
            raise ConsoleError(409, f"Run {run_id} is being written by another process.", code="run_owned_elsewhere")
        used = sum(state["totals"]["penalties"].values())
        if state["kind"] == "scoring" or (state["kind"] == "cli" and (not state["no_human"] or used)):
            raise ConsoleError(
                409, "A scoring run is never deleted from the console: its logs are the record.", code="scoring_run"
            )
        handle = self.handles.get(run_id)
        if handle is not None:
            if handle.active:
                raise ConsoleError(409, f"Run {run_id} is still going; stop it first.", code="run_active")
            self._drop(handle)
        await asyncio.to_thread(_remove_tree, target)
        self._disk.pop(run_id, None)
        self.hub.publish("run", {"run_id": run_id, "run": None, "removed": True})
        self.hub.publish("index", {})

    # ------------------------------------------------------------------ notes on a run (run.json only)

    async def _change_meta(self, run_id: str, change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        """Apply a note to run.json, for a live run or one on disk; returns the RunState. Never
        an event in the interaction log, and never read by a session, the loop or the watchdog."""
        run_dir = self.run_dir(run_id)
        handle = self.handles.get(run_id)
        if handle is not None:
            handle.update_meta(change)
        else:
            await asyncio.to_thread(update_run_json, run_dir, change)
            self._disk.pop(run_id, None)
        state = await self.get_run(run_id)
        self.publish_run(run_id, state)
        return state

    async def set_meta(self, run_id: str, changes: Mapping[str, Any]) -> dict[str, Any]:
        """`submitted_at` and / or `clock_started_at` (an ISO time or null). Display only."""
        allowed = {"submitted_at", "clock_started_at"}
        if not isinstance(changes, Mapping) or not changes or set(changes) - allowed:
            raise ConsoleError(422, "Only submitted_at and clock_started_at can be set.", code="unknown_field")
        clean: dict[str, str | None] = {}
        for key, value in changes.items():
            at = _epoch(value) if isinstance(value, str) else None
            if value is not None and at is None:
                raise ConsoleError(422, f"{key} must be an ISO date-time or null.", code="invalid_time")
            clean[key] = None if at is None else _iso(at)
        return await self._change_meta(run_id, lambda meta: meta.update(clean))

    async def ack(self, run_id: str, panorama_id: str, kind: Any) -> dict[str, Any]:
        """The operator has seen this panorama's fallback answer; returns its tile."""
        handle = self.require_owned(run_id)
        if panorama_id not in handle.manager.sessions:
            raise KeyError(panorama_id)
        if kind not in ACK_KINDS:
            raise ConsoleError(422, f"kind must be one of {', '.join(ACK_KINDS)}.", code="invalid_ack")

        def change(meta: dict[str, Any]) -> None:
            acks = dict(meta.get("acks") or {})
            acks[panorama_id] = sorted({*(acks.get(panorama_id) or []), kind})
            meta["acks"] = acks

        handle.update_meta(change)
        self.hub.publish("pano", lambda: self._pano_message(handle, panorama_id, None))
        return self._tile(handle, panorama_id)

    async def set_stage_truth(self, run_id: str, panorama_id: str, lat: Any, lng: Any) -> dict[str, Any]:
        """Reveal truth on stage: the presenter's coordinates against the final answer. Only for
        a run whose human channels were off, and only once the panorama is final."""
        if not _coordinate(lat, 90.0) or not _coordinate(lng, 180.0):
            raise ConsoleError(422, "lat must be within +/-90 and lng within +/-180.", code="invalid_coordinates")
        state = await self.get_run(run_id)
        if not state["no_human"] or sum(state["totals"]["penalties"].values()):
            raise ConsoleError(
                403,
                "Ground truth is only shown for a run whose human channels are off.",
                code="human_channels_on",
            )
        tile = next((t for t in state["panoramas"] if t["panorama_id"] == panorama_id), None)
        if tile is None:
            raise KeyError(panorama_id)
        if not tile["final"]:
            raise ConsoleError(409, "The truth can be revealed once this panorama is final.", code="not_final")
        label = Label(tile["label"])
        points = [(entry["lat"], entry["lng"]) for entry in tile["final"]][: len(RANK_WEIGHTS)]
        multipliers = [entry.get("multiplier", 1.0) for entry in tile["final"]][: len(points)]
        distance = haversine_m(points[0][0], points[0][1], float(lat), float(lng))
        truth = (float(lat), float(lng))
        score = score_list(points, truth, label, special=bool(tile["special"]), multipliers=multipliers)
        maximum = _MAX_SCORE * (SPECIAL_MULTIPLIER if tile["special"] else 1.0)
        note = {
            "lat": round(float(lat), 6),
            "lng": round(float(lng), 6),
            "at": _now(),
            "distance_m": round(distance, 1),
            "theta": round(theta(distance, label), 6),
            "score": round(score, 1),
            "max_score": round(maximum, 1),
            "share": round(score / maximum, 4),
        }

        def change(meta: dict[str, Any]) -> None:
            meta["stage_truth"] = {**(meta.get("stage_truth") or {}), panorama_id: note}

        await self._change_meta(run_id, change)
        return {key: note[key] for key in ("distance_m", "theta", "score", "max_score", "share")}

    # ------------------------------------------------------------------ launch context

    async def launch_context(self) -> dict[str, Any]:
        """What the New-run screen is built from."""
        rows = await self.list_runs()
        web = {tool["name"] for tool in WEB_CLIENT_TOOLS} | {WEB_SEARCH["type"]}
        return {
            "presets": copy.deepcopy(PRESETS),
            "defaults": public_settings(self.build_settings()),
            "tools": [
                {"name": name, "protected": name in PROTECTED_TOOLS, "web": name in web} for name in ALL_TOOL_NAMES
            ],
            "models": list(self.models()),
            "readiness": {
                "openai_key": bool(os.environ.get("OPENAI_API_KEY")),
                "google_key": bool(os.environ.get("GOOGLE_MAPS_API_KEY")),
                "mapillary_token": bool(os.environ.get("MAPILLARY_TOKEN")),
                "internet": self.health["internet"],
                "disk_free_bytes": await asyncio.to_thread(_free_bytes, self.runs_dir),
                "active_runs": [row["run_id"] for row in rows if row["active"]],
            },
            "estimates": _estimates(rows),
            "fake_model": self.fake_model,
            # under the demo model every preset can be launched; a scoring or live one is a
            # rehearsal and becomes a run of this kind (null: the presets' own kinds apply)
            "rehearsal_kind": "training" if self.fake_model else None,
        }

    # ------------------------------------------------------------------ shutdown

    async def shutdown(self) -> None:
        """Finalise and export every run that is still going (loop thread)."""
        going = [handle for handle in list(self.handles.values()) if not handle.idle]
        for handle in going:
            handle.manager.stop("server_shutdown")
        for handle in going:
            await self._idle(handle)

    def shutdown_sync(self) -> list[Path]:
        """After the event loop has stopped (the CLI's `finally`): whatever the dying loop left
        unfinished is finalised and written. Returns the files written."""
        written: list[Path] = []
        for handle in list(self.handles.values()):
            sessions = handle.manager.sessions
            if handle.clean and all(session.final is not None for session in sessions.values()):
                continue
            handle.manager.finalize_all("server_shutdown")
            try:
                paths, rows = export_run(
                    handle.run_dir,
                    team=handle.settings.team,
                    embed_images=handle.embed_images,
                    tasks={**_tasks_from_meta(handle.meta), **{pid: s.task for pid, s in sessions.items()}},
                )
            except Exception:  # one run's failure must not cost the others their files
                continue
            handle.manager.summary = rows
            handle.clean = True
            handle.update_meta(lambda meta: meta.update(finished_at=meta.get("finished_at") or _now()))
            written += paths
        return written


# ---------------------------------------------------------------------------------------------
# helpers


def _eval_facts(meta: Mapping[str, Any], settings: Settings | None) -> dict[str, Any] | None:
    """What an evaluation run was launched with, in the words of `POST /api/eval/runs`, so that a
    duplicate can repeat it exactly. None for a run with no record of its launch (the CLI's)."""
    launched = meta.get("eval")
    if not isinstance(launched, Mapping):
        return None
    facts: dict[str, Any] = {"limit": launched.get("limit"), "panoramas": len(meta.get("tasks") or [])}
    if settings is not None:
        efforts = {settings.standard.effort, settings.special.effort}
        facts.update(
            # the form's one effort sets both budgets; where they differ it was left alone
            effort=settings.standard.effort if len(efforts) == 1 else None,
            hedge=settings.hedge,
            web=settings.allow_web,
            tools_off=list(settings.disabled_tools),
            concurrency=settings.concurrency,
        )
    return facts


def _label_or_none(raw: Any) -> Label | None:
    try:
        return Label.parse(str(raw))
    except ValueError:
        return None


def _coordinate(value: Any, limit: float) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and abs(value) <= limit


def _refuse_blocked(verdict: Mapping[str, Any]) -> None:
    """The launch-side of the preflight verdict: the same blocking list, as a refusal."""
    blocking = verdict["blocking"]
    if not blocking:
        return
    # changing a task that is already logged is a conflict with the run, not a form mistake
    status = 409 if any(item["code"] == "id_collision" for item in blocking) else 422
    raise ConsoleError(status, " ".join(item["text"] for item in blocking), code="preflight_blocked", problems=blocking)


def _remove_tree(target: Path) -> None:
    """Blocking. Remove a run directory. A conversation cancelled a moment ago may still have a
    worker thread saving a view (a thread cannot be cancelled), and a file that appears while the
    tree is being removed fails the removal: try again once that thread has had time to finish."""
    for attempt in range(REMOVE_ATTEMPTS):
        try:
            shutil.rmtree(target)
            return
        except FileNotFoundError:
            return
        except OSError:
            if attempt == REMOVE_ATTEMPTS - 1:
                raise
            time.sleep(0.2)


def _json_file(path: Path) -> dict[str, Any]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _summary_problems(run_dir: Path) -> dict[str, str]:
    """The `problems` column of a run's summary.csv, for the panoramas that have any."""
    try:
        with (run_dir / "summary.csv").open(newline="", encoding="utf-8") as fh:
            return {row["panorama"]: row["problems"] for row in csv.DictReader(fh) if row.get("problems")}
    except (OSError, KeyError, csv.Error):
        return {}


def _logged_path(log_path: Path) -> Path | None:
    """The panorama file a log's run_start names (a CLI run has no run.json to ask)."""
    for envelope in iter_events(log_path):
        if envelope.get("type") == "run_start":
            raw = ((envelope.get("data") or {}).get("panorama") or {}).get("path")
            return Path(raw) if raw else None
    return None


def _read_results(run_dir: Path, meta: Mapping[str, Any]) -> dict[str, Any] | None:
    """Blocking. RunState.results, behind the one gate for truth-derived numbers."""
    if not truth_allowed(meta, run_dir):
        return None
    summary = (_json_file(run_dir / "results.json").get("summary") or {}).get("all")
    if not isinstance(summary, dict):
        return None
    variants = sorted(path.name[len("results.") : -len(".json")] for path in run_dir.glob("results.*.json"))
    return {
        "score_share": summary.get("score_share_of_max"),
        "median_rank1_m": summary.get("median_rank1_distance_m"),
        "variants": variants,
    }


def _free_bytes(path: Path) -> int | None:
    for candidate in (path, *path.resolve().parents):
        try:
            return shutil.disk_usage(candidate).free
        except OSError:
            continue
    return None


def _estimates(rows: Iterable[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per preset, what past runs cost per panorama. Runs of the scripted model spent nothing
    real and would drag every estimate toward zero."""
    out: dict[str, dict[str, Any]] = {}
    spent: dict[str, float] = {}
    for row in rows:
        preset = row.get("preset") or ("eval" if row.get("kind") == "eval" else None)
        totals = row.get("totals") or {}
        if preset is None or row.get("fake_model") or row.get("active") or not totals.get("spend_usd"):
            continue
        entry = out.setdefault(preset, {"runs": 0, "panoramas": 0, "mean_cost_usd": None})
        entry["runs"] += 1
        entry["panoramas"] += int(totals.get("total") or 0)
        spent[preset] = spent.get(preset, 0.0) + float(totals["spend_usd"])
    for preset, entry in out.items():
        entry["mean_cost_usd"] = round(spent[preset] / entry["panoramas"], 4) if entry["panoramas"] else None
    return out
