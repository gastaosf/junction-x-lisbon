"""update_candidates, submit_locations and ask_multiple_choice: thin wrappers over PanoramaSession.

Strict tool schemas guarantee shape only, so counts and ranges are checked here and reported back
to the model as tool errors it can correct.
"""

from __future__ import annotations

from typing import Any, Sequence

from pydantic import ValidationError

from ..schema import Entry, Hypothesis
from ..session import MAX_HYPOTHESES, MAX_MCQ_OPTIONS, MIN_MCQ_OPTIONS, McqRefused
from .base import ToolContext, ToolResult


def _parse_hypotheses(raw: Any) -> list[Hypothesis]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_HYPOTHESES:
        raise ValueError(f"hypotheses must be a list of 1 to {MAX_HYPOTHESES} items")
    hypotheses: list[Hypothesis] = []
    for i, item in enumerate(raw, start=1):
        try:
            hypotheses.append(Hypothesis.model_validate(item))
        except ValidationError as exc:
            issues = "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors())
            raise ValueError(
                f"hypothesis {i} is invalid ({issues}). lat must be -90..90, lng -180..180, "
                "probability 0..1, radius_m >= 0."
            ) from exc
    return hypotheses


def _describe(entries: Sequence[Entry]) -> str:
    """Compact run-length view of the 10 slots, e.g. '8 x (38.7, -9.1), 2 x (41.1, -8.6)'."""
    runs: list[tuple[tuple[float, float], int]] = []
    for entry in entries:
        point = (entry.lat, entry.lng)
        if runs and runs[-1][0] == point:
            runs[-1] = (point, runs[-1][1] + 1)
        else:
            runs.append((point, 1))
    return ", ".join(f"{count} x ({lat:.6f}, {lng:.6f})" for (lat, lng), count in runs)


def _log(ctx: ToolContext, entries: Sequence[Entry]) -> dict[str, Any]:
    return {
        "entries": [e.model_dump() for e in entries],
        "penalty_state": ctx.session.ledger.state().model_dump(),
    }


async def run_update_candidates(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    session = ctx.session
    if session.final is not None:
        return ToolResult.error("The answer for this panorama is already final; it can no longer be updated.")
    try:
        entries = session.update_candidates(_parse_hypotheses(args.get("hypotheses")))
    except ValueError as exc:
        return ToolResult.error(f"update_candidates rejected: {exc}")
    return ToolResult.text(
        f"Recorded {len(session.hypotheses)} hypotheses. Best-so-far answer held by the harness: "
        f"{_describe(entries)}. Current score multiplier: x{session.ledger.multiplier:.4g}.",
        **_log(ctx, entries),
    )


async def run_submit_locations(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    session = ctx.session
    if session.final is not None:
        return ToolResult.text(
            f"The answer was already final: {_describe(session.final)}. Stop here.", **_log(ctx, session.final)
        )
    summary = args.get("reasoning_summary")
    try:
        hypotheses = _parse_hypotheses(args.get("hypotheses"))
        if session.has_pending_cues():
            # The cue is already charged x0.8. Submitting now would fix the answer before the
            # agent has read it; the loop delivers it in the same user message as this result.
            session.update_candidates(hypotheses)
            return ToolResult.error(
                "Not submitted yet: an operator cue arrived while you were working, and its penalty is "
                "already charged. Your hypotheses were recorded as the best-so-far answer. Read the cue "
                "that follows, re-check what it points to, then call submit_locations again.",
                deferred_for_cue=True,
            )
        entries = session.finalize(
            "agent",
            hypotheses=hypotheses,
            reasoning_summary=summary if isinstance(summary, str) else None,
            reason="submit_locations",
        )
    except ValueError as exc:
        return ToolResult.error(f"submit_locations rejected, nothing was submitted: {exc}")
    return ToolResult.text(f"Final answer recorded: {_describe(entries)}. The run is complete.", **_log(ctx, entries))


async def run_ask_multiple_choice(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    session = ctx.session
    question, options, why = args.get("question"), args.get("options"), args.get("why_it_matters", "")
    if not isinstance(question, str) or not isinstance(options, list):
        return ToolResult.error(
            f"Question not asked and no penalty applied: need a question and {MIN_MCQ_OPTIONS} to "
            f"{MAX_MCQ_OPTIONS} text options."
        )
    try:
        answer = await session.ask_mcq(question, options, why if isinstance(why, str) else "")
    except McqRefused as exc:
        return ToolResult.error(f"Question not asked and no penalty applied: {exc}. Proceed on your own.")
    multiplier = session.ledger.multiplier
    remaining = max(0, session.settings.max_mcq - session.ledger.mcqs)
    tail = f"Score multiplier is now x{multiplier:.4g}; {remaining} question(s) left."
    if not answer["answered"]:
        text = f"No answer; proceed on your own judgement. The x0.95 cost of asking still applies. {tail}"
    else:
        text = (
            f"The operator chose option {answer['selected_index'] + 1}: {answer['selected_option']!r}. "
            f"Treat the click as about {session.settings.mcq_answer_accuracy:.0%} reliable. {tail}"
        )
    return ToolResult.text(text, **answer, penalty_state=session.ledger.state().model_dump())
