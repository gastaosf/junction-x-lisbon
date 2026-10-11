"""Per-panorama state shared by the agent loop, the tools and the operator UI.

The session owns the penalty ledger and is the only place where the three human channels
(MCQ click, cue, last-resort geocode) can reach the agent, so every rule in SPEC sections 4
and 8 is enforced here rather than in the UI.
"""

from __future__ import annotations

import ast
import asyncio
import re
import threading
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from pydantic import ValidationError

from .allocate import AllocationResult, allocate, mcq_gate
from .config import Settings
from .cuelint import lint_cue
from .eventlog import EventLog
from .penalties import PenaltyLedger
from .schema import Entry, EntryOrigin, Hypothesis, PanoramaTask

MIN_MCQ_OPTIONS = 2
MAX_MCQ_OPTIONS = 4
MAX_HYPOTHESES = 10
# A question needs its full answer window plus a model turn to act on the click; a cue needs at
# least one more turn. Later than this the penalty could buy nothing, so the channel refuses.
MCQ_DEADLINE_MARGIN_S = 60.0
CUE_MIN_REMAINING_S = 30.0
CUE_FACTOR = 0.8
# A lint problem reads "<category>: '<word>'", the word written with repr().
_LINT_PROBLEM_RE = re.compile(r"(?P<category>.+?): (?P<word>(?P<quote>['\"]).*(?P=quote))", re.DOTALL)

Point = tuple[float, float]


class McqRefused(Exception):
    """ask_multiple_choice was not put to the operator; no penalty was applied."""


class HumanChannelError(Exception):
    """A human input was rejected; no penalty was applied and nothing reached the agent."""

    def __init__(self, message: str, *, lint: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.lint = lint


def _coerce_hypotheses(raw: Sequence[Hypothesis | dict[str, Any]]) -> list[Hypothesis]:
    try:
        hyps = [h if isinstance(h, Hypothesis) else Hypothesis.model_validate(h) for h in raw]
    except ValidationError as exc:
        raise ValueError(f"invalid hypothesis: {exc}") from exc
    if not 1 <= len(hyps) <= MAX_HYPOTHESES:
        raise ValueError(f"expected 1 to {MAX_HYPOTHESES} hypotheses, got {len(hyps)}")
    return hyps


class PanoramaSession:
    def __init__(self, task: PanoramaTask, settings: Settings, run_id: str, log: EventLog | None = None) -> None:
        self.task = task
        self.settings = settings
        self.run_id = run_id
        self.ledger = PenaltyLedger(settings.penalty_scope)
        run_dir = Path(settings.runs_dir) / run_id
        self.log = log or EventLog(run_id, task.panorama_id, run_dir / f"{task.panorama_id}.events.jsonl")
        # the ledger is the single source of the penalty_state stamped on every event
        self.log.bind_penalty_state(self.ledger.state)
        self.image_dir = run_dir / task.panorama_id / "images"
        self.image_dir.mkdir(parents=True, exist_ok=True)

        self.hypotheses: list[Hypothesis] = []
        self.provisional: list[Entry] = []
        self.final: list[Entry] | None = None
        self.allocation: AllocationResult | None = None
        self.status: str = "pending"
        self.mcq_allowed: bool = settings.mcq_allowed
        self.pending_mcq: dict[str, Any] | None = None
        self.named_places: list[str] = []
        self.spend_usd: float = 0.0
        self.turns: int = 0
        self.tokens: dict[str, float] = {}

        self._lock = threading.RLock()
        self._cues: list[str] = []
        self._sent_cues: set[str] = set()  # every cue charged on this panorama, delivered or not
        self._override: dict[str, Any] | None = None  # {lat, lng, place_label} once a human geocode happened
        self._mcq_future: asyncio.Future[int | None] | None = None
        self._mcq_loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: list[tuple[asyncio.Queue[dict[str, Any]], asyncio.AbstractEventLoop]] = []
        # Hard deadline on the monotonic clock, set by the agent loop when the run starts.
        self.deadline_monotonic: float | None = None
        self.resumed = self._restore(self.log.events())
        self.log.add_listener(self._fan_out)

    def _restore(self, events: list[dict[str, Any]]) -> bool:
        """A reused run id appends to the same log, so the penalties already recorded there still
        apply: replay them into the ledger, with the human override and the best-so-far hypotheses.
        Returns True when there was something to restore."""
        if not events:
            return False
        counts = {"human_cue": 0, "mcq_asked": 0, "human_geocode": 0}
        override: dict[str, Any] | None = None
        hypotheses: Any = None
        for event in events:
            kind, data = event.get("type"), event.get("data")
            data = data if isinstance(data, dict) else {}
            if kind in counts:
                counts[kind] += 1
            if kind == "human_geocode":
                override = {key: data.get(key) for key in ("lat", "lng", "place_label")}
            if kind == "human_cue" and isinstance(data.get("text"), str):
                self._sent_cues.add(data["text"])
            if kind in {"candidates_update", "final_submission"} and data.get("hypotheses"):
                hypotheses = data["hypotheses"]
        self.ledger.cues = counts["human_cue"]
        self.ledger.mcqs = counts["mcq_asked"]
        self.ledger.human_geocodes = counts["human_geocode"]
        try:
            restored = _coerce_hypotheses(hypotheses) if hypotheses else []
            if restored:
                allocation = self._allocate(restored)
                self._remember(restored, allocation)
                self.provisional = self._stamp(allocation.points, "agent")
            if override and _is_coordinate(override["lat"], 90.0) and _is_coordinate(override["lng"], 180.0):
                self._override = override
                self.provisional = self._stamp(self._override_points(), "human_geocode")
        except Exception:  # a damaged log must not stop the run; the penalty counts are already in
            pass
        self.log.emit(
            "harness",
            "run_resumed",
            {
                "previous_events": len(events),
                "restored": {
                    "penalty_state": self.ledger.state().model_dump(),
                    "hypotheses": len(self.hypotheses),
                    "human_geocode_override": self._override,
                },
            },
        )
        return True

    # ------------------------------------------------------------------ clock and usage

    @property
    def started_monotonic(self) -> float:
        """Shared with the event log so elapsed_s() and t_rel_s are the same clock."""
        return self.log.t0

    @started_monotonic.setter
    def started_monotonic(self, value: float) -> None:
        self.log.t0 = value

    def elapsed_s(self) -> float:
        return time.monotonic() - self.started_monotonic

    def remaining_s(self) -> float | None:
        """Seconds until the hard deadline; None while no run has set one."""
        if self.deadline_monotonic is None:
            return None
        return self.deadline_monotonic - time.monotonic()

    @property
    def human_override(self) -> dict[str, Any] | None:
        return self._override

    def record_usage(self, usage: dict[str, Any], cost_usd: float) -> None:
        with self._lock:
            for key, value in usage.items():
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    self.tokens[key] = self.tokens.get(key, 0) + value
            self.spend_usd += cost_usd
            self.turns += 1

    # ------------------------------------------------------------------ candidates and the final answer

    def update_candidates(self, hyps: Sequence[Hypothesis | dict[str, Any]]) -> list[Entry]:
        """Persist the best-so-far 10-entry list (SPEC 6.5). Raises ValueError on bad input or once final."""
        with self._lock:
            if self.final is not None:
                raise ValueError("the answer for this panorama is already final")
            hypotheses = _coerce_hypotheses(hyps)
            allocation = self._allocate(hypotheses)
            self._remember(hypotheses, allocation)
            if self._override is None:
                self.provisional = self._stamp(allocation.points, "agent")
            self.log.emit(
                "agent",
                "candidates_update",
                {
                    "hypotheses": [h.model_dump() for h in hypotheses],
                    "provisional": self._dump(self.provisional),
                    "allocator": allocation.settings_dict(),
                    "human_geocode_override": self._override,
                },
            )
            return list(self.provisional)

    def finalize(
        self,
        origin: EntryOrigin | None = None,
        *,
        hypotheses: Sequence[Hypothesis | dict[str, Any]] | None = None,
        reasoning_summary: str | None = None,
        reason: str = "",
    ) -> list[Entry]:
        """Fix the answer. Idempotent. Raises ValueError only for invalid `hypotheses` passed in
        (before any state change); with none passed it always succeeds."""
        with self._lock:
            if self.final is not None:
                return self.final
            if hypotheses is not None:
                given = _coerce_hypotheses(hypotheses)
                self._remember(given, self._allocate(given))
            self._log_undelivered_cues(reason or "finalized")
            points, allocator, resolved = self._final_points(origin)
            self.final = self._stamp(points, resolved)
            self.provisional = list(self.final)
            self.status = "done"
            self._emit_final(allocator, resolved, reason, reasoning_summary)
            self._release_pending_mcq()
            return self.final

    def _final_points(self, origin: EntryOrigin | None) -> tuple[list[Point], dict[str, Any], EntryOrigin]:
        if self._override is not None:
            return self._override_points(), self._override_allocator(), "human_geocode"
        if self.hypotheses and self.allocation is not None:
            return self.allocation.points, self.allocation.settings_dict(), origin or "agent"
        prior = self.settings.prior_for(self.task.label)
        allocation = self._allocate_point(prior)
        return allocation.points, {**allocation.settings_dict(), "prior": list(prior)}, "harness_fallback"

    def _emit_final(
        self, allocator: dict[str, Any], origin: EntryOrigin, reason: str, reasoning_summary: str | None
    ) -> None:
        self.log.emit(
            "human" if origin == "human_geocode" else "harness",
            "final_submission",
            {
                "entries": self._dump(self.final or []),
                "allocator": allocator,
                "origin": origin,
                "reason": reason,
                "reasoning_summary": reasoning_summary,
                "hypotheses": [h.model_dump() for h in self.hypotheses],
                "special": self.task.special,
            },
        )

    def _allocate(self, hypotheses: Sequence[Hypothesis]) -> AllocationResult:
        return allocate(
            hypotheses,
            self.task.label,
            hedge=self.settings.hedge,
            allow_duplicates=self.settings.allow_duplicates,
        )

    def _allocate_point(self, point: Point) -> AllocationResult:
        """A single certain point through the allocator, so ALLOW_DUPLICATES=false still yields 10 distinct entries."""
        return self._allocate([Hypothesis(lat=point[0], lng=point[1], probability=1.0)])

    def _remember(self, hypotheses: list[Hypothesis], allocation: AllocationResult) -> None:
        self.hypotheses = hypotheses
        self.allocation = allocation
        for hyp in hypotheses:
            name = hyp.label.strip()
            if name and name not in self.named_places:
                self.named_places.append(name)

    def _stamp(self, points: Sequence[Point], origin: EntryOrigin) -> list[Entry]:
        rounded = [(round(lat, 6), round(lng, 6)) for lat, lng in points]
        return self.ledger.stamp(rounded, origin, committed=self.provisional)

    def _restamp_provisional(self) -> None:
        """After a penalty the provisional list must show the multiplier it would be submitted
        with (R9). Under the 'subsequent' scope the ledger keeps unchanged slots as they were."""
        if self.provisional and self.final is None:
            self.provisional = self._stamp([(e.lat, e.lng) for e in self.provisional], self.provisional[0].origin)

    def _log_undelivered_cues(self, reason: str) -> None:
        """A cue still queued when the answer is fixed was charged but never reached the agent.
        The penalty stays (the human did submit the text); the log says what happened."""
        cues, self._cues = self._cues, []
        for text in cues:
            self.log.emit(
                "harness",
                "human_cue_undelivered",
                {
                    "text": text,
                    "char_count": len(text),
                    "delivered_to_agent": False,
                    "penalty_kept": True,
                    "reason": reason,
                },
            )

    @staticmethod
    def _dump(entries: Sequence[Entry]) -> list[dict[str, Any]]:
        return [e.model_dump() for e in entries]

    # ------------------------------------------------------------------ human channel 1: MCQ (R7)

    def set_mcq_allowed(self, allowed: bool) -> None:
        """The operator's "MCQ allowed" toggle; logged because it changes what the agent may do."""
        with self._lock:
            self.mcq_allowed = bool(allowed)
            self.log.emit("human", "mcq_toggle", {"mcq_allowed": self.mcq_allowed})

    def _mcq_refusal(self, question: str, options: Sequence[str]) -> str | None:
        if self.settings.no_human:
            return "questions are disabled: this run is fully autonomous"
        if not self.mcq_allowed:
            return "questions are currently disabled by the operator"
        if self.final is not None:
            return "the answer for this panorama is already final"
        if self.pending_mcq is not None:
            return "another question is still awaiting an answer"
        if self.ledger.mcqs >= self.settings.max_mcq:
            return f"the limit of {self.settings.max_mcq} questions for this panorama is reached"
        remaining = self.remaining_s()
        if remaining is not None and remaining < self.settings.mcq_timeout_s + MCQ_DEADLINE_MARGIN_S:
            return "too little time is left before the deadline for an answer to be used"
        if not isinstance(question, str) or not question.strip():
            return "the question is empty"
        if not MIN_MCQ_OPTIONS <= len(options) <= MAX_MCQ_OPTIONS:
            return f"a question needs {MIN_MCQ_OPTIONS} to {MAX_MCQ_OPTIONS} options, got {len(options)}"
        if any(not isinstance(o, str) or not o.strip() for o in options):
            return "every option must be non-empty text"
        return None

    def _gate_verdict(self) -> dict[str, Any] | None:
        """SPEC 7.2 gate, recorded for the log; the decision to ask stays with the agent."""
        if not self.hypotheses:
            return None
        try:
            passes, why = mcq_gate(
                self.hypotheses,
                self.task.label,
                accuracy=self.settings.mcq_answer_accuracy,
                max_options=MAX_MCQ_OPTIONS,
            )
        except Exception as exc:
            return {"passes": None, "reason": f"gate failed: {exc}"}
        return {"passes": passes, "reason": why}

    async def ask_mcq(self, question: str, options: list[str], why_it_matters: str) -> dict[str, Any]:
        """Put one question to the operator. The x0.95 penalty is charged when the question is asked."""
        loop = asyncio.get_running_loop()
        with self._lock:
            refusal = self._mcq_refusal(question, options)
            if refusal:
                raise McqRefused(refusal)
            options = list(options)
            before, after = self.ledger.add_mcq()
            mcq = {
                "id": f"{self.task.panorama_id}-mcq-{self.ledger.mcqs}",
                "question": question,
                "options": options,
                "why_it_matters": why_it_matters,
                "asked_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            }
            penalty = {"multiplier_before": before, "multiplier_after": after}
            self._mcq_future, self._mcq_loop = loop.create_future(), loop
            future = self._mcq_future
            previous_status = self.status
            self.pending_mcq = mcq
            self.status = "awaiting_mcq"
            self._restamp_provisional()
            self.log.emit("agent", "mcq_asked", {**mcq, **penalty, "gate": self._gate_verdict()})
            timeout = self.settings.mcq_timeout_s
            remaining = self.remaining_s()
            if remaining is not None:
                timeout = max(0.0, min(timeout, remaining - MCQ_DEADLINE_MARGIN_S / 2))

        asked = time.monotonic()
        selected: int | None = None
        try:
            selected = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            selected = None
        finally:
            with self._lock:
                self.pending_mcq = None
                self._mcq_future = self._mcq_loop = None
                if self.status == "awaiting_mcq":
                    self.status = previous_status
                self.log.emit(
                    "human" if selected is not None else "harness",
                    "mcq_answered",
                    {
                        "id": mcq["id"],
                        "question": question,
                        "options": options,
                        "selected_index": selected,
                        "selected_option": options[selected] if selected is not None else None,
                        "wait_s": round(time.monotonic() - asked, 3),
                        **penalty,
                    },
                )
        return {
            "answered": selected is not None,
            "selected_index": selected,
            "selected_option": options[selected] if selected is not None else None,
        }

    def answer_mcq(self, mcq_id: str, index: int) -> None:
        """The operator's click. Safe to call from any thread."""
        with self._lock:
            if self.settings.no_human:
                raise HumanChannelError("human input is disabled for this run")
            pending, future = self.pending_mcq, self._mcq_future
            if pending is None or future is None or pending["id"] != mcq_id or pending.get("answered"):
                raise HumanChannelError("this question is no longer open")
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(pending["options"]):
                raise HumanChannelError(f"option index must be 0..{len(pending['options']) - 1}")
            pending["answered"] = True
            self._resolve(future, index)

    def _release_pending_mcq(self) -> None:
        """Finalising while a question is open ends the wait as "no answer"."""
        if self._mcq_future is not None:
            self._resolve(self._mcq_future, None)

    def _resolve(self, future: asyncio.Future[int | None], value: int | None) -> None:
        def settle() -> None:
            if not future.done():
                future.set_result(value)

        loop = self._mcq_loop
        if loop is None or loop.is_closed():
            return
        if _running_loop() is loop:
            settle()
        else:
            loop.call_soon_threadsafe(settle)

    # ------------------------------------------------------------------ human channel 2: cue (R6)

    def submit_cue(self, text: str, *, confirmed: bool = False) -> dict[str, Any]:
        """Validate a cue and, only when `confirmed`, charge x0.8 and queue it for the agent.

        Without `confirmed` this is the confirm dialog's dry run: same checks, no penalty, nothing
        queued. Every rejection raises HumanChannelError; a lint failure carries the verdict.
        """
        with self._lock:
            if self.settings.no_human:
                raise HumanChannelError("human input is disabled for this run")
            if self.final is not None:
                raise HumanChannelError("the answer for this panorama is already final")
            text = text.strip() if isinstance(text, str) else ""
            if not text:
                raise HumanChannelError("the cue is empty")
            if text in self._sent_cues:
                # A second tab, or the same click sent twice: the text is already paid for.
                raise HumanChannelError("this cue was already sent")
            if len(text) > self.settings.cue_max_chars:
                self._log_rejected_cue(text, "too_long", None)
                raise HumanChannelError(
                    f"the cue has {len(text)} characters; the limit is {self.settings.cue_max_chars}"
                )
            lint = lint_cue(text).to_dict()
            if not lint["ok"]:
                self._log_rejected_cue(text, "lint", lint)
                raise HumanChannelError(
                    "the cue refers to a location and was blocked: " + "; ".join(lint["problems"]), lint=lint
                )
            remaining = self.remaining_s()
            if remaining is not None and remaining < CUE_MIN_REMAINING_S:
                raise HumanChannelError(
                    "too late for a cue: the run reaches its hard deadline before the agent could act on it"
                )
            before = self.ledger.multiplier
            if not confirmed:
                return {
                    "accepted": False,
                    "needs_confirmation": True,
                    "char_count": len(text),
                    "lint": lint,
                    "multiplier_before": before,
                    "multiplier_after": before * CUE_FACTOR,
                }
            before, after = self.ledger.add_cue()
            self._cues.append(text)
            self._sent_cues.add(text)
            self._restamp_provisional()
            self.log.emit(
                "human",
                "human_cue",
                {
                    "text": text,
                    "char_count": len(text),
                    "lint": lint,
                    "multiplier_before": before,
                    "multiplier_after": after,
                },
            )
            return {
                "accepted": True,
                "needs_confirmation": False,
                "char_count": len(text),
                "lint": lint,
                "multiplier_before": before,
                "multiplier_after": after,
            }

    def check_cue(self, text: str) -> dict[str, Any]:
        """The lint as a pure question: what submit_cue would say, in the same order, without
        charging, queueing or writing an event. A check must leave no trace (R6): a cue the
        operator typed and then thought better of was never an interaction."""
        with self._lock:
            text = text.strip() if isinstance(text, str) else ""
            before = self.ledger.multiplier
            verdict: dict[str, Any] = {
                "ok": False,
                "problems": [],
                "matches": [],
                "lint": None,
                "char_count": len(text),
                "max_chars": self.settings.cue_max_chars,
                "multiplier_before": before,
                "multiplier_after": before * CUE_FACTOR,
                "reason": None,
            }

            def refused(reason: str, problem: str) -> dict[str, Any]:
                return {**verdict, "reason": reason, "problems": [problem]}

            if self.settings.no_human:
                return refused("disabled", "human input is disabled for this run")
            if self.final is not None:
                return refused("final", "the answer for this panorama is already final")
            if not text:
                return refused("empty", "the cue is empty")
            if text in self._sent_cues:
                return refused("duplicate", "this cue was already sent")
            if len(text) > self.settings.cue_max_chars:
                return refused(
                    "too_long", f"the cue has {len(text)} characters; the limit is {self.settings.cue_max_chars}"
                )
            lint = lint_cue(text).to_dict()
            verdict["lint"] = lint
            if not lint["ok"]:
                matches = lint_matches(text, lint["problems"])
                return {**verdict, "reason": "lint", "problems": list(lint["problems"]), "matches": matches}
            remaining = self.remaining_s()
            if remaining is not None and remaining < CUE_MIN_REMAINING_S:
                return refused(
                    "too_late",
                    "too late for a cue: the run reaches its hard deadline before the agent could act on it",
                )
            return {**verdict, "ok": True}

    def _log_rejected_cue(self, text: str, why: str, lint: dict[str, Any] | None) -> None:
        self.log.emit(
            "harness",
            "human_cue_rejected",
            {"text": text, "char_count": len(text), "rejected_because": why, "lint": lint, "delivered_to_agent": False},
        )

    def drain_cues(self) -> list[str]:
        with self._lock:
            cues, self._cues = self._cues, []
            return cues

    def has_pending_cues(self) -> bool:
        with self._lock:
            return bool(self._cues)

    # ------------------------------------------------------------------ human channel 3: last-resort geocode (R8)

    def human_geocode(self, lat: float, lng: float, place_label: str) -> list[Entry]:
        """The operator pins a coordinate for a place the agent named; x0.5, and it becomes the
        final answer at once. Leaving the run open would let the agent go on charging questions
        (and the operator cues) against a list that can no longer change."""
        with self._lock:
            if self.settings.no_human:
                raise HumanChannelError("human input is disabled for this run")
            if self._override is not None:
                # Also after a restart: a second pin would charge x0.5 again for the same decision.
                raise HumanChannelError("a human geocode is already recorded for this panorama")
            if place_label not in self.named_places:
                raise HumanChannelError("a human geocode is only allowed for a place the agent has named")
            if not _is_coordinate(lat, 90.0) or not _is_coordinate(lng, 180.0):
                raise HumanChannelError("coordinates out of range")
            before, after = self.ledger.add_human_geocode()
            self._override = {"lat": round(float(lat), 6), "lng": round(float(lng), 6), "place_label": place_label}
            self.log.emit(
                "human",
                "human_geocode",
                {**self._override, "multiplier_before": before, "multiplier_after": after},
            )
            self._log_undelivered_cues("human_geocode")
            entries = self._stamp(self._override_points(), "human_geocode")
            self.provisional = entries
            self.final = entries
            self.status = "done"
            self._emit_final(self._override_allocator(), "human_geocode", "human_geocode", None)
            self._release_pending_mcq()
            return list(entries)

    def _override_points(self) -> list[Point]:
        assert self._override is not None
        return self._allocate_point((self._override["lat"], self._override["lng"])).points

    def _override_allocator(self) -> dict[str, Any]:
        assert self._override is not None
        allocation = self._allocate_point((self._override["lat"], self._override["lng"]))
        return {**allocation.settings_dict(), "human_geocode": self._override}

    # ------------------------------------------------------------------ UI feed

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            pending = self.pending_mcq
            return {
                "run_id": self.run_id,
                "task": self.task.model_dump(mode="json"),
                "special": self.task.special,
                "status": self.status,
                "hypotheses": [h.model_dump() for h in self.hypotheses],
                "provisional": self._dump(self.provisional),
                "final": self._dump(self.final) if self.final is not None else None,
                "allocator": self.allocation.settings_dict() if self.allocation else None,
                "penalty_state": self.ledger.state().model_dump(),
                "pending_mcq": {k: v for k, v in pending.items() if k != "answered"} if pending else None,
                "named_places": list(self.named_places),
                "human_geocode_override": self._override,
                "elapsed_s": round(self.elapsed_s(), 1),
                "spend_usd": round(self.spend_usd, 4),
                "turns": self.turns,
                "tokens": dict(self.tokens),
                "mcq_allowed": self.mcq_allowed and not self.settings.no_human,
                "mcqs_remaining": max(0, self.settings.max_mcq - self.ledger.mcqs),
                "no_human": self.settings.no_human,
            }

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        with self._lock:
            self._subscribers.append((queue, asyncio.get_running_loop()))
        return queue

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._subscribers = [(queue, loop) for queue, loop in self._subscribers if queue is not q]

    def _fan_out(self, envelope: dict[str, Any]) -> None:
        """Events may be emitted from the loop or from a server worker thread."""
        with self._lock:
            subscribers = list(self._subscribers)
        running = _running_loop()
        for queue, loop in subscribers:
            if loop.is_closed():
                continue
            if running is loop:
                queue.put_nowait(envelope)
            else:
                loop.call_soon_threadsafe(queue.put_nowait, envelope)


def _fold(text: str) -> tuple[str, list[int]]:
    """Accent- and case-free text as the lint's gazetteer sees it (anything that is not a letter
    or digit becomes a space), with the index in `text` of every folded character."""
    folded: list[str] = []
    origin: list[int] = []
    for index, char in enumerate(text):
        plain = "".join(c for c in unicodedata.normalize("NFKD", char) if not unicodedata.combining(c)).casefold()
        for c in plain or " ":
            folded.append(c if c.isascii() and c.isalnum() else " ")
            origin.append(index)
    return "".join(folded), origin


def _locate(text: str, word: str) -> tuple[int, int] | None:
    """Where the lint's `word` stands in `text`. The lint reports some words as typed and others
    lower-cased without accents or punctuation, so try the literal text first."""
    literal = re.search(re.escape(word), text, re.IGNORECASE)
    if literal:
        return literal.span()
    tokens = _fold(word)[0].split()
    if not tokens:
        return None
    folded, origin = _fold(text)
    match = re.search(r"(?<![a-z0-9])" + r" +".join(map(re.escape, tokens)) + r"(?![a-z0-9])", folded)
    return (origin[match.start()], origin[match.end() - 1] + 1) if match else None


def lint_matches(text: str, problems: Sequence[str]) -> list[dict[str, Any]]:
    """The offending words of a lint verdict as {category, word, start, end}, offsets into the
    stripped cue (None when a word cannot be found), so a page can mark them without parsing
    message text. `word` is the word as the operator typed it ("Évora", where the lint says
    "evora") when it was found. The verdict itself stays as the lint wrote it."""
    text = text.strip()
    matches: list[dict[str, Any]] = []
    for problem in problems:
        parsed = _LINT_PROBLEM_RE.fullmatch(problem)
        if parsed is None:
            continue
        try:
            word = ast.literal_eval(parsed.group("word"))
        except (ValueError, SyntaxError):
            continue
        if not isinstance(word, str):
            continue
        span = _locate(text, word)
        matches.append(
            {
                "category": parsed.group("category"),
                "word": text[span[0] : span[1]] if span else word,
                "start": span[0] if span else None,
                "end": span[1] if span else None,
            }
        )
    return matches


def _running_loop() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def _is_coordinate(value: Any, limit: float) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and abs(value) <= limit
