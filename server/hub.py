"""EventHub: the one ordered stream every browser tab reads, and the idempotency store.

Threading (the reason this module exists): event-log listeners run on whichever thread called
emit(), outside the log's lock. Everything that orders or mutates shared state (the global seq,
LogFold.apply, the fan-out to subscribers) therefore happens on the event-loop thread only;
calls from other threads are handed to the loop, and dropped once the loop is closed. The hub
binds its loop on first use, because a Workspace is built before any loop exists.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from astrolabio.eventlog import EventLog

from .runstate import LogFold, iter_events

QUEUE_SIZE = 1000
# What a subscriber reads when the hub has closed its queue (it fell too far behind): the stream
# ends there and the client reconnects for a fresh snapshot.
CLOSED = None

Payload = Mapping[str, Any] | Callable[[], Mapping[str, Any] | None]
PanoPayload = Callable[[str, str, dict[str, Any], LogFold], Mapping[str, Any] | None]


def _running_loop() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


@dataclass
class _Attachment:
    run_id: str
    panorama_id: str
    log: EventLog
    fold: LogFold
    listener: Callable[[dict[str, Any]], None] | None = None
    detached: bool = False


class EventHub:
    """Global sequence numbers and bounded fan-out for `pano`, `run`, `job`, `index` and `health`
    messages. A message is `{seq, kind, **payload}`; seq has no gaps, so a client that sees one
    knows it missed something."""

    def __init__(self, *, queue_size: int = QUEUE_SIZE) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.seq = 0
        self.queue_size = queue_size
        # (run_id, panorama_id, envelope, fold) -> the payload of the `pano` message, or None to
        # send nothing. The workspace sets it: only it can overlay the live session on the tile.
        self.pano_payload: PanoPayload | None = None
        self._subscribers: list[asyncio.Queue[dict[str, Any] | None]] = []
        self._attached: dict[int, _Attachment] = {}

    # ------------------------------------------------------------------ loop

    def bind(self) -> asyncio.AbstractEventLoop | None:
        """Adopt the running loop if the hub has none (or its own is closed). Returns the loop
        in use; None when there is none yet."""
        if self.loop is None or self.loop.is_closed():
            running = _running_loop()
            if running is not None and running is not self.loop:
                # queues of a dead loop have no reader left
                self.loop, self._subscribers = running, []
        return self.loop

    def _on_loop(self, fn: Callable[..., Any], *args: Any) -> bool:
        """Run `fn` on the hub's loop: now when we are on it, else as soon as it is free. False
        when there is no usable loop (not started, or shut down) and the call was dropped."""
        loop = self.bind()
        if loop is None or loop.is_closed():
            return False
        if _running_loop() is loop:
            fn(*args)
            return True
        try:
            loop.call_soon_threadsafe(fn, *args)
        except RuntimeError:  # closed between the check and the call
            return False
        return True

    # ------------------------------------------------------------------ publish / subscribe

    def publish(self, kind: str, payload: Payload) -> bool:
        """Send a message to every subscriber. Safe from any thread; order is the order in which
        the loop thread gets to them. `payload` may be a callable, evaluated on the loop thread
        at the moment the seq is assigned (so a burst of updates can share one late snapshot);
        returning None sends nothing. False when the message was dropped for want of a loop."""
        return self._on_loop(self._publish, kind, payload)

    def _publish(self, kind: str, payload: Payload) -> None:
        if callable(payload):
            try:
                payload = payload()
            except Exception:  # a broken state builder must not take the stream down
                return
        if payload is None:
            return
        self.seq += 1
        message = {**payload, "seq": self.seq, "kind": kind}
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                self._close(queue)

    def _close(self, queue: asyncio.Queue[dict[str, Any] | None]) -> None:
        """A reader that fell a whole queue behind is cut off rather than allowed to hold memory
        or see a gap: what it had queued is discarded and it reads CLOSED next."""
        if queue in self._subscribers:
            self._subscribers.remove(queue)
        while not queue.empty():
            queue.get_nowait()
        queue.put_nowait(CLOSED)

    def subscribe(self) -> tuple[int, asyncio.Queue[dict[str, Any] | None]]:
        """(seq of the last message already sent, queue of every later one). Loop thread only.
        Build the snapshot in the same synchronous block, with no await in between: then the
        snapshot is the state at that seq and the queue's first message is seq + 1."""
        self.bind()
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=self.queue_size)
        self._subscribers.append(queue)
        return self.seq, queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any] | None]) -> None:
        if queue in self._subscribers:
            self._subscribers.remove(queue)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    # ------------------------------------------------------------------ event logs

    def attach(self, run_id: str, panorama_id: str, log: EventLog, *, fold: LogFold | None = None) -> LogFold:
        """Follow a live log: every event it emits is folded and published as a `pano` message.

        Returns the fold, primed with what the log already holds. Idempotent per EventLog object:
        a retried panorama gets a new session on the same log, and a second listener would fold
        and publish every event twice. Loop thread (or before the loop starts)."""
        attachment = self._attached.get(id(log))
        if attachment is not None and attachment.log is log:
            return attachment.fold
        self.bind()
        attachment = _Attachment(run_id, panorama_id, log, fold if fold is not None else LogFold())
        attachment.listener = lambda envelope: self._deliver(attachment, envelope)
        self._attached[id(log)] = attachment
        # Listen first, then read: an event emitted in between is seen twice and apply() drops
        # the repeat, where the other order could lose it.
        log.add_listener(attachment.listener)
        for envelope in iter_events(log.path):
            attachment.fold.apply(envelope)
        return attachment.fold

    def detach(self, log: EventLog) -> None:
        attachment = self._attached.get(id(log))
        if attachment is None or attachment.log is not log:
            return
        del self._attached[id(log)]
        attachment.detached = True
        if attachment.listener is not None:
            log.remove_listener(attachment.listener)

    def detach_run(self, run_id: str) -> None:
        """Stop following every log of a run (its id is being reused, or the run was deleted)."""
        for attachment in [a for a in self._attached.values() if a.run_id == run_id]:
            self.detach(attachment.log)

    def fold(self, run_id: str, panorama_id: str) -> LogFold | None:
        for attachment in self._attached.values():
            if attachment.run_id == run_id and attachment.panorama_id == panorama_id:
                return attachment.fold
        return None

    def _deliver(self, attachment: _Attachment, envelope: dict[str, Any]) -> None:
        """The log listener: any thread."""
        if not attachment.detached:
            self._on_loop(self._folded, attachment, envelope)

    def _folded(self, attachment: _Attachment, envelope: dict[str, Any]) -> None:
        if attachment.detached:
            return
        fold, seq = attachment.fold, envelope.get("seq")
        missed: list[dict[str, Any]] = []
        if isinstance(seq, int) and seq > fold.last_seq + 1:
            # An earlier event never got here: two threads delivered out of order, or it was
            # emitted while there was no loop. The file has every event in order, and skipping
            # one could be skipping a penalty.
            missed = [
                e
                for e in iter_events(attachment.log.path)
                if isinstance(e.get("seq"), int) and fold.last_seq < e["seq"] < seq
            ]
        for event in (*missed, envelope):
            if fold.apply(event):
                self._announce(attachment, event)

    def _announce(self, attachment: _Attachment, envelope: dict[str, Any]) -> None:
        fold = attachment.fold
        try:
            if self.pano_payload is not None:
                payload = self.pano_payload(attachment.run_id, attachment.panorama_id, envelope, fold)
            else:
                payload = {
                    "run_id": attachment.run_id,
                    "panorama_id": attachment.panorama_id,
                    "event": fold.digest(envelope),
                    "tile": fold.tile(run_id=attachment.run_id),
                }
        except Exception:  # the event is folded and logged; only its announcement is lost
            return
        self._publish("pano", payload)


# ---------------------------------------------------------------------------------------------
# idempotency

KEY_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
TTL_S = 3600.0


def fingerprint(body: Any) -> str:
    """sha256 of a request body: the raw bytes, or the canonical JSON of a parsed one."""
    if isinstance(body, str):
        body = body.encode("utf-8")
    if not isinstance(body, (bytes, bytearray, memoryview)):
        body = json.dumps(body, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    return hashlib.sha256(bytes(body)).hexdigest()


def _refuse(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, {"message": message, "code": code, "action": None, "problems": None})


@dataclass
class _Entry:
    scope: str
    fingerprint: str | None
    future: asyncio.Future[tuple[str, Any]]
    finished_at: float | None = None


class IdempotencyStore:
    """First result wins: a repeat of a state-changing request (a double click, a retry after a
    timeout) gets the first one's answer instead of charging a penalty twice.

    In memory and loop-thread only. Losing it on restart is acceptable: a restarted server owns no
    run, so every human-channel request is then refused anyway."""

    def __init__(self, ttl_s: float = TTL_S, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.ttl_s = ttl_s
        self._clock = clock
        self._entries: dict[str, _Entry] = {}
        self._tasks: set[asyncio.Future[Any]] = set()

    def __len__(self) -> int:
        return len(self._entries)

    async def run(
        self,
        scope: str,
        key: str | None,
        factory: Callable[[], Awaitable[dict[str, Any]]],
        *,
        fingerprint: str | None = None,
        required: bool = False,
    ) -> tuple[dict[str, Any], bool]:
        """Run `factory` once per key and return `(body, replayed)`.

        `scope` is "METHOD path"; with `fingerprint` (see `fingerprint()`) it is what the key was
        first used for, and using the key for anything else is a 422. Without a key the factory
        just runs (400 when `required`). A repeat that arrives while the first is still running
        waits for it. An HTTPException below 500 is an answer like any other and is raised again
        for repeats; a 5xx or any other failure is forgotten, so the client may try again.
        The factory runs in a task of its own: a client that disconnects cannot leave a penalty
        charged with no stored answer. Every side effect belongs inside the factory."""
        if key is None:
            if required:
                raise _refuse(
                    400,
                    "idempotency_key_required",
                    "This request needs an Idempotency-Key header, so that a repeat cannot act twice.",
                )
            return await self._detached(factory()), False
        if not isinstance(key, str) or not KEY_RE.match(key):
            raise _refuse(
                400, "idempotency_key_invalid", "Idempotency-Key must be 16 to 64 letters, digits, '-' or '_'."
            )
        self._forget_old()
        entry = self._entries.get(key)
        replayed = entry is not None
        if entry is None:
            # stored before the first await: a duplicate arriving meanwhile must find it
            loop = asyncio.get_running_loop()
            entry = _Entry(scope, fingerprint, loop.create_future())
            self._entries[key] = entry
            task = loop.create_task(self._execute(key, entry, factory))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        elif (entry.scope, entry.fingerprint) != (scope, fingerprint):
            raise _refuse(
                422,
                "idempotency_key_reuse",
                "This Idempotency-Key was already used for a different request; send a new key.",
            )
        kind, value = await asyncio.shield(entry.future)
        if kind == "ok":
            # always a copy: what is stored must stay what the first request answered
            return copy.deepcopy(value), replayed
        if kind == "http" and replayed:
            headers = {**(value.headers or {}), "Idempotency-Replayed": "true"}
            raise HTTPException(value.status_code, copy.deepcopy(value.detail), headers=headers)
        raise value

    async def _detached(self, work: Awaitable[dict[str, Any]]) -> dict[str, Any]:
        """Await `work` so that cancelling the caller (a dropped connection) does not stop it
        half way through a state change."""
        task = asyncio.ensure_future(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        # if the caller is gone nobody reads the outcome; reading it here keeps asyncio quiet
        task.add_done_callback(lambda done: done.cancelled() or done.exception())
        return await asyncio.shield(task)

    async def _execute(self, key: str, entry: _Entry, factory: Callable[[], Awaitable[dict[str, Any]]]) -> None:
        keep = False
        try:
            outcome: tuple[str, Any] = ("ok", await factory())
            keep = True
        except HTTPException as exc:
            outcome = ("http", exc)
            keep = exc.status_code < 500
        except asyncio.CancelledError:  # shutdown: nothing to remember, the waiters are going too
            outcome = ("error", asyncio.CancelledError())
        except Exception as exc:
            outcome = ("error", exc)
        if not keep and self._entries.get(key) is entry:
            del self._entries[key]
        entry.finished_at = self._clock()
        # a result, never set_exception: with every waiter gone an exception would only be
        # reported as "never retrieved"
        entry.future.set_result(outcome)

    def _forget_old(self) -> None:
        now = self._clock()
        finished = [(key, entry.finished_at) for key, entry in self._entries.items() if entry.finished_at is not None]
        for key, at in finished:
            if now - at > self.ttl_s:
                del self._entries[key]

