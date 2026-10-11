"""Background jobs: long operations (export rebuild, set build, eval scoring, rescore, unzip)
that must not block the loop driving the agents, with progress the page can follow.

A job's work is a callable taking the Job: a plain function runs in a worker thread, a coroutine
function as a task on the loop. Either may call `job.progress(...)` and `job.log(...)` freely;
every change is published to the hub as a `job` message.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import threading
import uuid
from collections import deque
from collections.abc import Callable, Collection
from datetime import datetime, timezone
from typing import Any

from .hub import EventHub
from .security import redact

JOB_KINDS: tuple[str, ...] = ("export", "eval_build", "eval_score", "rescore", "unzip")
LOG_LINES = 200
KEEP_FINISHED = 100
ACTIVE_STATES = frozenset({"queued", "running"})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Job:
    def __init__(self, kind: str, title: str, *, run_id: str | None = None, hub: EventHub | None = None) -> None:
        self.id = uuid.uuid4().hex[:16]
        self.kind = kind
        self.title = title
        self.run_id = run_id
        self.state = "queued"
        self.result: Any = None
        self.error: str | None = None
        self.created_at = _now()
        self.finished_at: str | None = None
        self.task: asyncio.Task[None] | None = None
        self._hub = hub
        self._progress: dict[str, Any] = {"done": 0, "total": None, "text": ""}
        self._lines: deque[str] = deque(maxlen=LOG_LINES)
        self._lock = threading.Lock()  # the work reports from its own thread
        self._announcing = False

    # ---- for the work (any thread) -----------------------------------------------------------

    def progress(self, done: float | None = None, total: float | None = None, text: str | None = None) -> None:
        """Report how far the work is. An argument left out keeps its last value."""
        with self._lock:
            if done is not None:
                self._progress["done"] = done
            if total is not None:
                self._progress["total"] = total
            if text is not None:
                self._progress["text"] = redact(text)
        self._changed()

    def log(self, line: Any) -> None:
        """Append a line to the job's log (the last 200 are kept). Redacted: build and export
        errors quote the URLs they failed on."""
        with self._lock:
            self._lines.append(redact(line))
        self._changed()

    # ---- state -------------------------------------------------------------------------------

    @property
    def done(self) -> bool:
        return self.state not in ACTIVE_STATES

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            return {
                "id": self.id,
                "kind": self.kind,
                "title": self.title,
                "state": self.state,
                "progress": dict(self._progress),
                "log": list(self._lines),
                "result": self.result,
                "error": self.error,
                "created_at": self.created_at,
                "finished_at": self.finished_at,
                "run_id": self.run_id,
            }

    async def wait(self) -> "Job":
        """Until the work has ended, whichever way. Never raises for a failed job."""
        if self.task is not None:
            await asyncio.wait({self.task})
        return self

    def _changed(self) -> None:
        """Announce the job as it is when the loop gets to it. A burst of progress calls from a
        worker thread shares one message: a thousand files must not flood a subscriber's queue."""
        if self._hub is None:
            return
        with self._lock:
            if self._announcing:
                return
            self._announcing = True
        if not self._hub.publish("job", self._announce):
            with self._lock:
                self._announcing = False

    def _announce(self) -> dict[str, Any]:
        with self._lock:
            self._announcing = False
        return {"job": self.to_dict()}

    def _set(self, state: str, *, result: Any = None, error: str | None = None) -> None:
        with self._lock:
            self.state = state
            if state not in ACTIVE_STATES:
                self.result, self.error, self.finished_at = result, error, _now()
        self._changed()


def _json_safe(value: Any) -> Any:
    """A job's result goes to the browser as it is; make sure it can."""
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return str(value)


class JobManager:
    """Starts jobs and remembers them for the life of the process (the last finished ones)."""

    def __init__(self, hub: EventHub | None = None) -> None:
        self.hub = hub
        self._jobs: dict[str, Job] = {}

    def start(
        self,
        kind: str,
        title: str,
        work: Callable[[Job], Any],
        *,
        run_id: str | None = None,
    ) -> Job:
        """Begin `work(job)` in the background and return its Job at once. Loop thread only.
        What the work returns becomes `job.result`; what it raises becomes `job.error`."""
        if kind not in JOB_KINDS:
            raise ValueError(f"unknown job kind {kind!r}; one of {', '.join(JOB_KINDS)}")
        job = Job(kind, title, run_id=run_id, hub=self.hub)
        self._jobs[job.id] = job
        self._trim()
        job._changed()
        job.task = asyncio.get_running_loop().create_task(self._run(job, work))
        return job

    async def _run(self, job: Job, work: Callable[[Job], Any]) -> None:
        job._set("running")
        try:
            if inspect.iscoroutinefunction(work):
                result = await work(job)
            else:
                result = await asyncio.to_thread(work, job)
                if inspect.isawaitable(result):
                    result = await result
        except asyncio.CancelledError:
            job._set("failed", error="cancelled: the server is shutting down")
            raise
        except Exception as exc:
            message = redact(f"{type(exc).__name__}: {exc}")
            job.log(f"failed: {message}")
            job._set("failed", error=message)
        else:
            job._set("done", result=_json_safe(result))

    def _trim(self) -> None:
        finished = [job for job in self._jobs.values() if job.done]
        for job in finished[: max(0, len(finished) - KEEP_FINISHED)]:
            del self._jobs[job.id]

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        """Every remembered job, oldest first."""
        return list(self._jobs.values())

    def find(
        self, kind: str, state: str | Collection[str] | None = None, *, run_id: str | None = None
    ) -> Job | None:
        """The newest job of `kind` (in `state`, one name or several; for `run_id`), if any: how
        a reloaded page finds the build or export it started."""
        states = None if state is None else {state} if isinstance(state, str) else set(state)
        for job in reversed(self._jobs.values()):
            if job.kind != kind or (run_id is not None and job.run_id != run_id):
                continue
            if states is None or job.state in states:
                return job
        return None
