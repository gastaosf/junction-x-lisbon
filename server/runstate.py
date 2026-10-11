"""State of a panorama for the console, built from its event log alone.

`LogFold` folds event envelopes one at a time, so the same code serves a live session (fed by
the hub as events are emitted), a run that only exists on disk (`fold_file`) and a replay
(`fold_file(path, upto_seq=...)`). The log is the record that gets submitted, so whatever the page
shows about penalties, answers and spend is derived from it and never from an in-memory counter
that a retry or a restart would reset. The few things only a running session knows (is a question
open right now, how long has it run) are overlaid in `tile()`.

Nothing in here reads ground truth: a tile, a digest and a replay are safe to show for any run.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Iterator, Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from astrolabio import allocate
from astrolabio.config import Settings
from astrolabio.runner import RETRYABLE_STOP_REASONS
from astrolabio.schema import Hypothesis, Label
from astrolabio.scoring import RANK_WEIGHTS, SPECIAL_MULTIPLIER, expected_value, penalty_multiplier
from astrolabio.session import CUE_MIN_REMAINING_S, MCQ_DEADLINE_MARGIN_S

from .app import ACTIVE_STATUSES, _clip, _hosted_action, _mcq_remaining_s, _tool_name
from .security import SHA_RE, redact
from .words import count

TEXT_LIMIT = 8000  # reasoning summaries and agent text travel whole; the page clamps them in CSS
SNIPPET_LIMIT = 400
CUE_LIMIT = 1000
ACTIVITY_LIMIT = 120
REASONING_LIMIT = 600
RESULT_IMAGES = 6
REQUEST_IMAGES = 12
API_RETRY_WINDOW_S = 60.0
API_RETRY_COUNT = 3

INTERRUPTED_TEXT = (
    "server stopped while this panorama was running; Rebuild exports recovers its last provisional list"
)
_MCQ_TIMEOUT_S = float(Settings.model_fields["mcq_timeout_s"].default)
_MAX_MCQ = int(Settings.model_fields["max_mcq"].default)
_ACCURACY = float(Settings.model_fields["mcq_answer_accuracy"].default)
_MAX_SCORE = 2.0 * sum(RANK_WEIGHTS)  # theta is at most 2: 16,050 for an ordinary panorama

_PENALTY_KINDS = {"human_cue": "cue", "mcq_asked": "mcq", "human_geocode": "geocode"}
_ALLOCATOR_KEYS = ("hedge", "allow_duplicates", "plan", "rho")
_FACTOR_WORDS = {"cue": "0.8 cue", "mcq": "0.95 MCQ", "geocode": "0.5 geocode"}
_ERROR_TYPES = frozenset({"api_error", "api_retry", "harness_error"})
_HUMAN_TYPES = frozenset(
    {
        "mcq_asked",
        "mcq_answered",
        "mcq_toggle",
        "human_cue",
        "human_cue_delivered",
        "human_cue_undelivered",
        "human_cue_rejected",
        "human_geocode",
    }
)


# ---------------------------------------------------------------------------------------------
# reading logs


def iter_events(path: str | Path) -> Iterator[dict[str, Any]]:
    """Envelopes of a JSONL log in file order, skipping a torn line. Blocking: use a thread."""
    try:
        fh = Path(path).open("r", encoding="utf-8")
    except OSError:
        return
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                yield event


def read_events(path: str | Path) -> list[dict[str, Any]]:
    return list(iter_events(path))


# ---------------------------------------------------------------------------------------------
# small helpers


def _number(value: Any) -> float | int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return None
    return value


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _dicts(value: Any) -> list[dict[str, Any]]:
    return [dict(item) for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _epoch(ts: Any) -> float | None:
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _shorten(text: Any, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def fmt_multiplier(value: float) -> str:
    """x0.76, x0.9025, x1.0: as short as it can be without rounding a penalty away."""
    text = f"{value:.4f}".rstrip("0")
    return "x" + (text + "0" if text.endswith(".") else text)


def _coerce_hypotheses(raw: Any) -> list[Hypothesis]:
    out = []
    for item in raw if isinstance(raw, list) else []:
        try:
            out.append(item if isinstance(item, Hypothesis) else Hypothesis.model_validate(item))
        except ValueError:
            continue
    return out


def _label(value: Any) -> Label | None:
    try:
        return value if isinstance(value, Label) else Label(value)
    except ValueError:
        return None


# ---------------------------------------------------------------------------------------------
# wording


def ledger_text(ledger: Sequence[Mapping[str, Any]], multiplier: float) -> str:
    """The multiplier with every charge written out, in the order they were made."""
    if not ledger:
        return "x1.0 (no penalties)"
    factors = " x ".join(_FACTOR_WORDS.get(str(item.get("kind")), "?") for item in ledger)
    return f"{fmt_multiplier(multiplier)} = {factors}"


def plan_text(allocator: Mapping[str, Any] | None, origin: str | None = None) -> str:
    """What the allocator did with the ten slots, in words."""
    if origin == "human_geocode":
        return "human geocode: the operator's point fills all ten entries"
    if origin == "harness_fallback":
        return "no hypothesis: the fallback point for this label fills all ten entries"
    if not allocator:
        return "no answer yet"
    plan, rho = allocator.get("plan"), _number(allocator.get("rho"))
    ratio = f" (second place is worth {rho:.2f} of the best)" if rho is not None else ""
    if plan == "distinct":
        return "duplicates off: ten distinct points, best first"
    if plan == "8x1+2x2":
        return f"hedge on: 8 x best point, 2 x second place{ratio}"
    if plan == "6x1+4x2":
        return f"hedge on: 6 x best point, 4 x second place{ratio}"
    if not allocator.get("hedge"):
        return "hedge off: best point repeated"
    if rho is None:
        return "hedge on: no second place to hedge with, best point repeated"
    return f"hedge on: second place too weak to hedge{ratio}, best point repeated"


_STOP_WORDS = {
    "submit_locations": "the agent submitted its answer",
    "submitted": "the agent submitted its answer",
    "hard_deadline": "hard deadline",
    "max_turns": "turn limit reached",
    "max_spend": "spend cap reached",
    "end_turn": "the agent stopped without submitting",
    "refusal": "the model refused to continue",
    "api_error": "the model API failed",
    "crash": "the harness failed",
    "cancelled": "the run was cancelled",
    "panorama_load_failed": "the panorama could not be loaded",
    "not_started": "never started before the run ended",
    "operator_finalize": "finalised by the operator",
    "operator_finalize_all": "finalised by the operator (finalize all)",
    "operator_stop": "run stopped by the operator",
    "global_watchdog": "global watchdog: the whole run was finalised",
    "server_shutdown": "server shut down",
    "human_geocode": "human geocode",
    "human_geocode_restored": "human geocode carried over from an earlier run",
    "recovered_from_provisional": "recovered after a crash from the last provisional list",
    "recovered_no_hypotheses": "recovered after a crash with no hypothesis: fallback point used",
    "recovered_final": "recovered after a crash: the answer fixed before it was kept",
    "finalized_externally": "finalised from outside the agent",
}
_USED = {
    "agent": "best-so-far list used",
    "harness_fallback": "no hypothesis, fallback point used",
    "human_geocode": "the operator's point is the answer",
}
# endings that already say which list was used
_SELF_EXPLAINING = frozenset(
    {"submit_locations", "submitted", "recovered_from_provisional", "recovered_no_hypotheses", "recovered_final"}
)


def stop_text(stop_reason: str | None, origin: str | None, final_reason: str | None = None) -> str:
    """How a panorama ended, in plain words ("hard deadline: best-so-far list used").

    `stop_reason` is the loop's (run_end); when the answer was fixed from outside the loop it only
    says so (or says "cancelled", which is how the conversation then unwound), and `final_reason`
    (final_submission) names who did it."""
    reason = stop_reason
    if reason in (None, "", "finalized_externally", "cancelled") and final_reason:
        reason = final_reason
    if origin == "human_geocode" and reason != "human_geocode_restored":
        # a geocode replaces the answer even after the loop ended for a reason of its own
        reason = "human_geocode"
    if not reason:
        return ""
    words = _STOP_WORDS.get(reason, str(reason).replace("_", " "))
    used = _USED.get(origin or "")
    if reason in _SELF_EXPLAINING or not used:
        return words
    return f"{words}: {used}"


_OVERPASS_TAG = re.compile(r"""\[\s*["']?([\w:.-]+)["']?\s*(?:=|~)\s*["']?([^"'\]]+)["']?\s*\]""")
_OVERPASS_KEY = re.compile(r"""\[\s*["']?([A-Za-z_][\w:.-]*)["']?\s*\]""")
_OVERPASS_SETTINGS = frozenset({"out", "timeout", "maxsize", "bbox", "date", "diff", "adiff"})


def _overpass_subject(args: Mapping[str, Any]) -> str:
    described = args.get("description")
    if isinstance(described, str) and described.strip():
        return described
    ql = str(args.get("ql") or "")
    for key, value in _OVERPASS_TAG.findall(ql):
        if key not in _OVERPASS_SETTINGS and not key.startswith("ISO3166"):
            return f"{key}={value}"
    for key in _OVERPASS_KEY.findall(ql):
        if key not in _OVERPASS_SETTINGS:
            return key
    return "map features"


def activity_text(tool: str | None, input: Any = None) -> str:
    """What the agent is doing, for an audience: one short sentence from its latest tool call.
    `input` is the call's arguments (for the hosted web search, its action)."""
    args = _dict(input)
    if not tool:
        text = "Looking at the panorama"
    elif tool == "view_crop":
        yaw = _number(args.get("yaw"))
        text = "Zooming in" if yaw is None else f"Zooming in at yaw {round(yaw) % 360}"
    elif tool == "search_places":
        text = f"Searching place names for {_shorten(args.get('query'), 80) or 'a place'}"
    elif tool == "overpass_query":
        text = f"Searching OpenStreetMap for {_shorten(_overpass_subject(args), 80)}"
    elif tool == "streetview_lookup":
        text = "Comparing street-level imagery"
    elif tool == "satellite_tile":
        text = "Checking satellite imagery"
    elif tool == "sun_position":
        text = "Checking the sun's position"
    elif tool == "update_candidates":
        text = "Updating its hypotheses"
    elif tool == "ask_multiple_choice":
        text = "Asking the operator a question"
    elif tool == "submit_locations":
        text = "Submitting its answer"
    elif tool == "web_search":
        query = args.get("query") or args.get("pattern")
        if isinstance(query, list):
            query = ", ".join(str(q) for q in query)
        text = f"Searching the web for {_shorten(query, 80)}" if query else "Reading a web page"
    else:
        text = f"Using {tool}"
    return _shorten(text, ACTIVITY_LIMIT)


# ---------------------------------------------------------------------------------------------
# digests for the reasoning stream


def _line(kind: str, value: Any, limit: int = SNIPPET_LIMIT, prefix: str = "") -> dict[str, Any]:
    full = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return {"kind": kind, "text": prefix + _clip(full, limit), "truncated": len(full) > limit}


def _content_lines(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [_line("text", content, TEXT_LIMIT)] if content.strip() else []
    lines: list[dict[str, Any]] = []
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind in {"thinking", "text", "refusal"} and str(block.get(kind) or "").strip():
            lines.append(_line("thinking" if kind == "thinking" else "text", str(block[kind]), TEXT_LIMIT))
        elif kind == "server_tool_use":
            lines.append(_line("tool", _hosted_action(block.get("input")), prefix=f"{block.get('name', '?')} "))
        elif kind == "tool_use":
            lines.append(_line("tool", block.get("input", {}), prefix=f"{block.get('name', '?')} "))
    return lines


def _counted(n: Any, word: str) -> str:
    """A logged number with its noun; a value that is not a number reads as the plural."""
    return count(n, word) if _number(n) is not None else f"{n} {word}s"


def _error_message(data: Mapping[str, Any]) -> str:
    return redact(str(data.get("message") or data.get("error") or data.get("error_class") or "unknown error"))


def _event_lines(type_: str, data: dict[str, Any]) -> list[dict[str, Any]]:
    if type_ == "model_request":
        said = f"turn {data.get('turn', '?')} request: {_counted(data.get('message_count', '?'), 'message')}"
        return [_line("harness", f"{said}, {_counted(data.get('image_count', 0), 'image')} in the conversation")]
    if type_ == "model_response":
        lines = _content_lines(data.get("content"))
        stop = data.get("stop_reason")
        if stop and stop not in {"tool_use", "end_turn"}:
            lines.append(_line("error" if stop == "refusal" else "harness", f"stop_reason: {stop}"))
        return lines
    if type_ == "tool_call":
        return [_line("tool", data.get("input", data.get("args", {})), prefix=f"{_tool_name(data)} ")]
    if type_ == "tool_result":
        duration = _number(data.get("duration_ms"))
        took = f" ({duration:.0f} ms)" if duration is not None else ""
        output = data.get("output", data.get("log", ""))
        kind = "error" if data.get("is_error") else "result"
        if isinstance(output, str):
            output = redact(output)
        return [_line(kind, output, prefix=f"{_tool_name(data)}{took}: ")]
    if type_ == "candidates_update":
        hyps = _dicts(data.get("hypotheses"))
        top = max(hyps, key=lambda h: _number(h.get("probability")) or 0, default=None)
        if top is None:
            return [_line("harness", "0 hypotheses")]
        share, name = _number(top.get("probability")) or 0, _clip(str(top.get("label", "")), 80)
        return [_line("harness", f"{count(len(hyps), 'hypothesis')}; top {share:.0%} {name}")]
    if type_ == "mcq_asked":
        options = " | ".join(str(o) for o in data.get("options") or [])
        question = _clip(str(data.get("question", "")))
        return [_line("human", f"MCQ: {question} [{_clip(options)}]", 2 * SNIPPET_LIMIT + 10)]
    if type_ == "mcq_answered":
        index = data.get("selected_index")
        answer = "no answer sent" if index is None else f"option {index + 1}: {data.get('selected_option', '')}"
        return [_line("human", f"MCQ answer: {answer}")]
    if type_ == "mcq_toggle":
        return [_line("human", f"questions allowed: {'on' if data.get('mcq_allowed') else 'off'}")]
    if type_ == "human_cue":
        return [_line("human", str(data.get("text", "")), CUE_LIMIT, prefix="Cue: ")]
    if type_ == "human_cue_delivered":
        return [_line("human", f"cue delivered to the agent at turn {data.get('turn', '?')}")]
    if type_ == "human_cue_undelivered":
        return [_line("human", f"cue charged but not delivered ({data.get('reason') or 'the answer was fixed first'})")]
    if type_ == "human_cue_rejected":
        problems = "; ".join(str(p) for p in _dict(data.get("lint")).get("problems") or [])
        why = data.get("rejected_because") or "rejected"
        return [_line("human", f"cue rejected ({why}), not charged{': ' + problems if problems else ''}")]
    if type_ == "human_geocode":
        place = _clip(str(data.get("place_label", "")), 120)
        return [_line("human", f"human geocode: {data.get('lat')}, {data.get('lng')} for {place!r}")]
    if type_ == "final_submission":
        return [_line("harness", f"FINAL origin={data.get('origin')} reason={_clip(str(data.get('reason', '')))}")]
    if type_ == "run_start":
        return [_line("harness", f"start model={data.get('model')} effort={data.get('effort')}")]
    if type_ == "run_end":
        cost, wall = _number(data.get("cost_usd")) or 0.0, _number(data.get("wall_time_s")) or 0.0
        said = f"end: {data.get('stop_reason')}, {_counted(data.get('turns', 0), 'turn')}"
        return [_line("harness", f"{said}, ${cost:.2f}, {wall:.0f} s")]
    if type_ == "run_resumed":
        earlier = _counted(data.get("previous_events", "?"), "earlier event")
        return [_line("harness", f"continuing an existing log ({earlier})")]
    if type_ == "retry":
        return [_line("harness", f"retry: new conversation after {data.get('previous_stop_reason') or 'a failed run'}")]
    if type_ == "soft_deadline_notice":
        return [_line("harness", "soft deadline: the agent was told to commit")]
    if type_ == "operator_stop":
        return [_line("harness", "run stopped by the operator")]
    if type_ == "api_retry":
        said = f"API retry {data.get('attempt', '?')} in {data.get('delay_s', '?')} s: "
        return [_line("error", _error_message(data), prefix=said)]
    if type_ == "api_error":
        return [_line("error", _error_message(data), prefix="API error: ")]
    if type_ == "harness_error":
        return [_line("error", _error_message(data), prefix=f"harness error ({data.get('where', '?')}): ")]
    return [_line("harness", data)] if data else []


def _collect_images(node: Any, found: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    """Image references {sha256, ...} anywhere in an event's data, each view once."""
    if isinstance(node, dict):
        sha = node.get("sha256")
        if (
            isinstance(sha, str)
            and SHA_RE.match(sha)
            and len(found) < limit
            and all(image["sha256"] != sha for image in found)
        ):
            found.append(
                {
                    "sha256": sha,
                    "yaw": _number(node.get("yaw")),
                    "pitch": _number(node.get("pitch")),
                    "fov": _number(node.get("fov")),
                    "width": None,
                    "height": None,
                    "crop_n": None,
                }
            )
        for value in node.values():
            _collect_images(value, found, limit)
    elif isinstance(node, list):
        for value in node:
            _collect_images(value, found, limit)
    return found


def _digest_images(type_: str, data: dict[str, Any], crop_n: int | None) -> list[dict[str, Any]]:
    if type_ == "tool_result":
        log = _dict(data.get("log"))
        images = _collect_images(log, [], RESULT_IMAGES)
        if _tool_name(data) == "view_crop" and images:
            images[0].update(width=_number(log.get("width")), height=_number(log.get("height")), crop_n=crop_n)
        return images
    # Only the first request shows its images (the opening views): later requests re-log the tool
    # results of the turn before, whose images the stream has already shown.
    if type_ == "model_request" and data.get("turn") == 1:
        return _collect_images(data.get("messages"), [], REQUEST_IMAGES)
    return []


def console_digest(
    envelope: Mapping[str, Any], *, turn: int | None = None, crop_n: int | None = None
) -> dict[str, Any]:
    """Display-ready form of one log event for the reasoning stream.

    `turn` and `crop_n` are context a single envelope does not carry (which turn a tool call
    belongs to, which numbered crop a view_crop is); `LogFold.digest` supplies them."""
    data = _dict(envelope.get("data"))
    type_ = str(envelope.get("type", ""))
    is_tool = type_ in {"tool_call", "tool_result"}
    tool = _tool_name(data) if is_tool else None
    is_error = (
        type_ in _ERROR_TYPES
        or (type_ == "tool_result" and bool(data.get("is_error")))
        or (type_ == "model_response" and data.get("stop_reason") == "refusal")
    )
    images = _digest_images(type_, data, crop_n)
    if is_error:
        category = "errors"
    elif type_ == "model_response":
        category = "reasoning"
    elif is_tool:
        category = "images" if images else "tools"
    elif type_ in _HUMAN_TYPES:
        category = "human"
    else:
        category = "images" if images else "harness"
    own_turn = data.get("turn")
    return {
        "seq": envelope.get("seq"),
        "ts": envelope.get("ts"),
        "t_rel_s": envelope.get("t_rel_s"),
        "actor": envelope.get("actor"),
        "type": type_,
        "multiplier": _dict(envelope.get("penalty_state")).get("multiplier"),
        "turn": own_turn if isinstance(own_turn, int) and not isinstance(own_turn, bool) else turn,
        "category": category,
        "lines": _event_lines(type_, data),
        "images": images,
        "tool": tool,
        "is_error": is_error,
        "duration_ms": _number(data.get("duration_ms" if type_ == "tool_result" else "latency_ms")),
        "crop_n": crop_n if tool == "view_crop" else None,
    }


# ---------------------------------------------------------------------------------------------
# belief summaries


def expected_score(
    entries: Sequence[Mapping[str, Any]], hypotheses: Any, label: Any, special: bool
) -> dict[str, float] | None:
    """What the list would score if the agent's own hypotheses were the truth: a way to rank
    where review time is best spent, never a score. None while there is no list or no belief."""
    hyps, kind = _coerce_hypotheses(hypotheses), _label(label)
    points = [(e.get("lat"), e.get("lng")) for e in entries][: len(RANK_WEIGHTS)]
    if not hyps or kind is None or not points or any(_number(v) is None for point in points for v in point):
        return None
    total = sum(h.probability for h in hyps)
    if total <= 0:
        return None
    if total > 1:  # a careless belief must not promise more than the maximum
        hyps = [h.model_copy(update={"probability": h.probability / total}) for h in hyps]
    multipliers = [_number(e.get("multiplier")) or 0.0 for e in entries][: len(points)]
    value = expected_value(points, hyps, kind, special=special, multipliers=multipliers)
    maximum = _MAX_SCORE * (SPECIAL_MULTIPLIER if special else 1.0)
    return {"value": round(value, 1), "max": round(maximum, 1), "share": round(value / maximum, 4)}


def _belief_shape(hypotheses: Any, label: Any, accuracy: float) -> dict[str, Any]:
    """Clusters, the gap between the two likeliest and the question-gate verdict (SPEC 7.2)."""
    empty = {
        "clusters": 0,
        "top_gap_m": None,
        "multimodal": False,
        "gate_reason": "no hypotheses yet",
        "cluster_points": [],
    }
    hyps, kind = _coerce_hypotheses(hypotheses), _label(label)
    if not hyps or kind is None:
        return empty
    try:
        shape = allocate.describe(hyps, kind, accuracy=accuracy)
    except Exception as exc:  # a tile must render whatever a log holds
        return {**empty, "gate_reason": f"could not be evaluated: {type(exc).__name__}"}
    return {
        "clusters": int(shape.get("clusters") or 0),
        "top_gap_m": _number(shape.get("top_gap_m")),
        "multimodal": bool(shape.get("multimodal")),
        "gate_reason": str(shape.get("gate_reason") or ""),
        "cluster_points": _dicts(shape.get("cluster_points")),
    }


def option_places(options: Sequence[Any], hypotheses: Sequence[Mapping[str, Any]]) -> list[dict[str, Any] | None]:
    """For each MCQ option, the current hypothesis it names (its label appears in the option), so
    the page can show that place's coordinates. The longest label wins when several match."""
    labelled = [
        (index, str(h.get("label") or "").strip())
        for index, h in enumerate(hypotheses)
        if len(str(h.get("label") or "").strip()) >= 3
    ]
    out: list[dict[str, Any] | None] = []
    for option in options:
        text = str(option).casefold()
        hits = [(len(name), -index, index, name) for index, name in labelled if name.casefold() in text]
        if not hits:
            out.append(None)
            continue
        _, _, index, name = max(hits)
        place = hypotheses[index]
        out.append({"index": index, "label": name, "lat": place.get("lat"), "lng": place.get("lng")})
    return out


# ---------------------------------------------------------------------------------------------
# the fold


class LogFold:
    """Incremental fold of one panorama's event log into what a tile shows.

    Not thread-safe: for a live session the hub applies and reads it on the event-loop thread
    only. `task` (a PanoramaTask or a run.json task row) names a panorama that has no log yet."""

    def __init__(self, task: Any = None) -> None:
        self.panorama_id: str | None = None
        self.filename: str | None = None
        self.label: str | None = None
        self.timestamp: str | None = None
        self.special = False
        self.image: dict[str, Any] | None = None
        self.model: str | None = None
        self.effort: str | None = None
        self.budget: dict[str, Any] | None = None
        self.flags: dict[str, Any] = {}

        self.status = "pending"
        self.segment = 0  # conversations in this log; t_rel_s restarts with each
        self.started = False  # the current segment has a run_start
        self.hypotheses: list[dict[str, Any]] = []
        self.final: list[dict[str, Any]] | None = None
        self.final_elapsed_s: float | None = None
        self.final_reason: str | None = None
        self.origin: str | None = None
        self.stop_reason: str | None = None
        self.named_places: list[str] = []
        self.mcq_allowed = True
        self.pending_mcq: dict[str, Any] | None = None
        self.last_mcq: dict[str, Any] | None = None

        self.counts = {"cue": 0, "mcq": 0, "geocode": 0}
        self.ledger: list[dict[str, Any]] = []
        self.cues: list[dict[str, Any]] = []
        self.crops: list[dict[str, Any]] = []
        self.spend_usd = 0.0
        self.turns = 0
        self.segment_turns = 0

        self.last_seq = 0
        self.last_event_ts: str | None = None
        self.last_event_t_rel_s: float | None = None
        self.first_candidates_t_rel_s: float | None = None
        self.api_trouble = False
        self.api_trouble_text: str | None = None
        self.activity: dict[str, Any] | None = None
        self.last_reasoning: dict[str, Any] | None = None

        self._candidates_provisional: list[dict[str, Any]] = []
        self._candidates_allocator: dict[str, Any] | None = None
        self._final_allocator: dict[str, Any] | None = None
        self._before_mcq = "running"
        self._retry_times: list[float] = []
        self._crop_calls: list[dict[str, Any]] = []
        self._crop_count = 0
        self._crop_by_seq: dict[int, int] = {}
        # (seq, turn) at every model_request; (seq, None) where a new conversation begins
        self._turn_marks: list[tuple[int, int | None]] = []
        if task is not None:
            self._seed(task)

    def _seed(self, task: Any) -> None:
        row = task if isinstance(task, Mapping) else task.model_dump(mode="json")
        self.panorama_id = row.get("panorama_id")
        path = row.get("path")
        self.filename = row.get("filename") or (Path(str(path)).name if path else None)
        self.label = getattr(row.get("label"), "value", row.get("label"))
        self.timestamp = row.get("timestamp")
        self.special = bool(row.get("special", False))

    # ------------------------------------------------------------------ folding

    @property
    def multiplier(self) -> float:
        return penalty_multiplier(self.counts["cue"], self.counts["mcq"], self.counts["geocode"])

    @property
    def provisional(self) -> list[dict[str, Any]]:
        return self.final if self.final is not None else self._candidates_provisional

    @property
    def allocator(self) -> dict[str, Any] | None:
        return self._final_allocator if self.final is not None else self._candidates_allocator

    def apply(self, envelope: Mapping[str, Any]) -> bool:
        """Fold one event. False (and no change) for a repeat: listeners can deliver an event
        twice, or behind one that was emitted after it."""
        seq = envelope.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool) or seq <= self.last_seq:
            return False
        self.last_seq = seq
        self.last_event_ts = envelope.get("ts")
        t_rel = _number(envelope.get("t_rel_s"))
        self.last_event_t_rel_s = t_rel
        handler = _HANDLERS.get(str(envelope.get("type")))
        if handler is not None:
            try:
                handler(self, envelope, _dict(envelope.get("data")), t_rel or 0.0)
            except Exception:  # one damaged event must not hide the rest of the log
                pass
        return True

    def _reset_answer(self) -> None:
        self.final = None
        self.final_elapsed_s = None
        self.final_reason = None
        self._final_allocator = None
        self.origin = None
        self.stop_reason = None
        self.pending_mcq = None

    def _restamp(self, *, force: bool = False) -> None:
        """A penalty changes the multiplier the provisional list would be submitted with (R9).
        Under the "subsequent" scope the slots already committed keep theirs."""
        if force or self.flags.get("penalty_scope", "whole_list") == "whole_list":
            current = self.multiplier
            self._candidates_provisional = [{**entry, "multiplier": current} for entry in self._candidates_provisional]

    def _name(self, hypotheses: Sequence[Mapping[str, Any]]) -> None:
        for hyp in hypotheses:
            name = str(hyp.get("label") or "").strip()
            if name and name not in self.named_places:
                self.named_places.append(name)

    def _charge(self, envelope: Mapping[str, Any], t_rel: float) -> None:
        kind = _PENALTY_KINDS[str(envelope.get("type"))]
        before = self.multiplier
        self.counts[kind] += 1
        self.ledger.append(
            {
                "seq": envelope.get("seq"),
                "ts": envelope.get("ts"),
                "t_rel_s": t_rel,
                "kind": kind,
                "before": before,
                "after": self.multiplier,
            }
        )
        self._restamp()

    def _on_run_start(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        panorama = _dict(data.get("panorama"))
        self.panorama_id = panorama.get("panorama_id") or self.panorama_id or envelope.get("panorama_id")
        self.filename = panorama.get("filename") or self.filename
        self.label = data.get("label") or self.label
        self.timestamp = data.get("capture_timestamp") or self.timestamp
        self.special = bool(data.get("special", self.special))
        if panorama.get("sha256") or panorama.get("width"):
            self.image = {key: panorama.get(key) for key in ("width", "height", "sha256")}
        self.model = data.get("model") or self.model
        self.effort = data.get("effort") or self.effort
        self.budget = _dict(data.get("budget")) or self.budget
        self.flags = _dict(data.get("flags")) or self.flags
        self._reset_answer()
        self._turn_marks.append((int(envelope["seq"]), None))
        self.status = "running"
        self.segment += 1
        self.started = True
        self.segment_turns = 0
        self.first_candidates_t_rel_s = None
        self.api_trouble, self.api_trouble_text, self._retry_times = False, None, []
        self.activity = {"text": activity_text(None), "tool": None, "seq": envelope.get("seq"), "t_rel_s": t_rel}

    def _on_restart(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        """`retry` and `run_resumed`: a new session took over this log. The answer is open again;
        what the log already charged and the agent already believed carries over."""
        self._reset_answer()
        self._turn_marks.append((int(envelope["seq"]), None))
        self.status = "pending"
        self.started = False
        self._restamp(force=True)
        if envelope.get("type") == "run_resumed":
            # as PanoramaSession._restore: a new session only knows the places of the last belief
            self.named_places = []
            self._name(self.hypotheses)

    def _on_model_request(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        turn = data.get("turn")
        if isinstance(turn, int) and not isinstance(turn, bool):
            self._turn_marks.append((int(envelope["seq"]), turn))

    def _on_model_response(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        self.turns += 1
        self.segment_turns += 1
        self.spend_usd += _number(data.get("cost_usd")) or 0.0
        # a turn that came back whole is what clears the trouble flag
        self.api_trouble, self.api_trouble_text, self._retry_times = False, None, []
        content = data.get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content}]
        for block in blocks:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind in {"thinking", "text"} and str(block.get(kind) or "").strip():
                self._say(block[kind], envelope, t_rel)
            elif kind == "server_tool_use":
                self._do(str(block.get("name") or "web_search"), block.get("input"), envelope, t_rel)

    def _say(self, text: Any, envelope: Mapping[str, Any], t_rel: float) -> None:
        self.last_reasoning = {"text": _shorten(text, REASONING_LIMIT), "seq": envelope.get("seq"), "t_rel_s": t_rel}

    def _do(self, tool: str, args: Any, envelope: Mapping[str, Any], t_rel: float) -> None:
        self.activity = {"text": activity_text(tool, args), "tool": tool, "seq": envelope.get("seq"), "t_rel_s": t_rel}

    def _on_tool_call(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        tool = _tool_name(data)
        self._do(tool, data.get("input"), envelope, t_rel)
        if tool == "view_crop":
            # numbered when asked for, so the call and its result share a number in the stream
            self._crop_count += 1
            call = {
                "n": self._crop_count,
                "seq": envelope["seq"],
                "id": data.get("tool_use_id"),
                "input": _dict(data.get("input")),
            }
            self._crop_calls.append(call)
            self._crop_by_seq[envelope["seq"]] = call["n"]

    def _on_tool_result(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        if _tool_name(data) != "view_crop":
            return
        use_id = data.get("tool_use_id")
        call = next((c for c in self._crop_calls if use_id is None or c["id"] == use_id), None)
        if call is None:
            return
        self._crop_calls.remove(call)
        self._crop_by_seq[envelope["seq"]] = call["n"]
        log = _dict(data.get("log"))
        image = _dict(log.get("image"))
        if data.get("is_error") or not image.get("sha256"):
            return
        # the image reference holds what was rendered (yaw wrapped, pitch and fov clamped)
        view = {key: _number(image.get(key)) for key in ("yaw", "pitch", "fov")}
        asked = {key: _number(call["input"].get(key)) for key in ("yaw", "pitch", "fov")}
        self.crops.append(
            {
                "n": call["n"],
                "seq_call": call["seq"],
                "seq_result": envelope["seq"],
                "t_rel_s": t_rel,
                **{key: view[key] if view[key] is not None else asked[key] for key in view},
                "width": _number(log.get("width")),
                "height": _number(log.get("height")),
                "sha256": image["sha256"],
            }
        )

    def _on_candidates_update(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        self.hypotheses = _dicts(data.get("hypotheses"))
        self._candidates_provisional = _dicts(data.get("provisional"))
        self._candidates_allocator = _dict(data.get("allocator")) or None
        self._name(self.hypotheses)
        if self.first_candidates_t_rel_s is None:
            self.first_candidates_t_rel_s = t_rel

    def _on_final_submission(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        # the last one is the answer of record: a geocode after the run rewrites it
        self.final = _dicts(data.get("entries"))
        self._final_allocator = _dict(data.get("allocator")) or None
        self.origin = data.get("origin")
        self.final_reason = data.get("reason") or None
        if data.get("hypotheses"):
            self.hypotheses = _dicts(data["hypotheses"])
            self._name(self.hypotheses)
        if self.final_elapsed_s is None:
            # a panorama finalised in the queue never ran: its clock did not start
            self.final_elapsed_s = t_rel if self.started else 0.0
        if str(data.get("reasoning_summary") or "").strip():
            self._say(data["reasoning_summary"], envelope, t_rel)
        self.status = "done"
        self._close_mcq(envelope, "released", None, None, t_rel)

    def _on_run_end(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        self.stop_reason = data.get("stop_reason")
        if self.final is not None:
            self.status = "done"
        wall = _number(data.get("wall_time_s"))
        if data.get("recovered") and wall is not None:
            # written by a recovery, long after: it carries the time the dead run had reached
            self.final_elapsed_s = float(wall)
        self._close_mcq(envelope, "released", None, None, t_rel)

    def _on_mcq_asked(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        self._charge(envelope, t_rel)
        self.pending_mcq = {
            "id": str(data.get("id")),
            "question": str(data.get("question", "")),
            "options": [str(o) for o in data.get("options") or []][:4],
            "why_it_matters": str(data.get("why_it_matters", "")),
            "asked_at": data.get("asked_at") or envelope.get("ts"),
            "seq": envelope.get("seq"),
            "t_rel_s": t_rel,
        }
        if self.status != "awaiting_mcq":
            self._before_mcq = self.status
        self.status = "awaiting_mcq"

    def _close_mcq(self, envelope: Mapping[str, Any], outcome: str, selected: Any, wait_s: Any, t_rel: float) -> None:
        pending, self.pending_mcq = self.pending_mcq, None
        if pending is None:
            return
        self.last_mcq = {
            "id": pending["id"],
            "seq": envelope.get("seq"),
            "question": pending["question"],
            "options": pending["options"],
            "outcome": outcome,
            "selected_index": selected,
            "wait_s": wait_s,
            "t_rel_s": t_rel,
        }
        if self.status == "awaiting_mcq":
            self.status = self._before_mcq

    def _on_mcq_answered(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        selected = data.get("selected_index")
        selected = selected if isinstance(selected, int) and not isinstance(selected, bool) else None
        # no click and an answer already fixed: the wait was ended by the finalisation, not the clock
        outcome = "answered" if selected is not None else "released" if self.final is not None else "timeout"
        if self.pending_mcq is None:
            # the final_submission that released the question came first and closed it
            self.pending_mcq = {
                "id": str(data.get("id")),
                "question": str(data.get("question", "")),
                "options": [str(o) for o in data.get("options") or []][:4],
            }
        self._close_mcq(envelope, outcome, selected, _number(data.get("wait_s")), t_rel)

    def _on_mcq_toggle(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        self.mcq_allowed = bool(data.get("mcq_allowed"))

    def _on_human_cue(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        self._charge(envelope, t_rel)
        chars = data.get("char_count")
        self.cues.append(
            {
                "seq": envelope.get("seq"),
                "t_rel_s": t_rel,
                "char_count": chars if isinstance(chars, int) else len(str(data.get("text", ""))),
                "state": "queued",
                "delivered_t_rel_s": None,
                "delivered_seq": None,
                "delivered_turn": None,
            }
        )

    def _settle_cue(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        """Cues reach the agent in the order they were sent, so the oldest open one is meant."""
        cue = next((c for c in self.cues if c["state"] == "queued"), None)
        if cue is None:
            return
        if envelope.get("type") == "human_cue_delivered":
            cue.update(
                state="delivered",
                delivered_t_rel_s=t_rel,
                delivered_seq=envelope.get("seq"),
                delivered_turn=data.get("turn"),
            )
        else:
            cue["state"] = "undelivered"

    def _on_human_geocode(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        self._charge(envelope, t_rel)

    def _on_api_retry(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        now = _epoch(envelope.get("ts"))
        if now is None:
            return
        self._retry_times = [t for t in self._retry_times if now - t <= API_RETRY_WINDOW_S] + [now]
        if len(self._retry_times) >= API_RETRY_COUNT:
            self.api_trouble = True
            said = f"{len(self._retry_times)} API retries in {API_RETRY_WINDOW_S:.0f} s: "
            self.api_trouble_text = said + _shorten(_error_message(data), 200)

    def _on_api_error(self, envelope: Mapping[str, Any], data: dict[str, Any], t_rel: float) -> None:
        self.api_trouble = True
        self.api_trouble_text = "API error: " + _shorten(_error_message(data), 200)

    # ------------------------------------------------------------------ digests

    def turn_at(self, seq: Any) -> int | None:
        """The model turn an event belongs to: that of the last request at or before it."""
        if not isinstance(seq, int):
            return None
        turn = None
        for mark, number in self._turn_marks:
            if mark > seq:
                break
            turn = number
        return turn

    def digest(self, envelope: Mapping[str, Any]) -> dict[str, Any]:
        """`console_digest` with the turn and crop number of an event this fold has applied."""
        seq = envelope.get("seq")
        crop_n = self._crop_by_seq.get(seq) if isinstance(seq, int) else None
        return console_digest(envelope, turn=self.turn_at(seq), crop_n=crop_n)

    # ------------------------------------------------------------------ the tile

    def tile(
        self,
        *,
        run_id: str,
        live_session: Any = None,
        budget: Any = None,
        settings: Settings | None = None,
        acks: Iterable[str] = (),
        export_problem: str | None = None,
        replay: bool = False,
    ) -> dict[str, Any]:
        """The TileState of this panorama, JSON-safe.

        `live_session` is the PanoramaSession running it in this process; without one the tile
        is a record: `done`, or `interrupted` when the log stops short of an answer. `replay`
        keeps the status the log had at that moment instead (a past state is not an interruption).
        `budget` overrides the budget logged at run_start (a panorama that has not started);
        `acks` are the kinds the operator acknowledged for this panorama (run.json)."""
        session = live_session
        live = session is not None
        task = session.task if live else None
        settings = settings or (session.settings if live else None)
        special = bool(task.special) if task is not None else self.special
        label = task.label.value if task is not None else self.label
        human = not (settings.no_human if settings is not None else self.flags.get("no_human", True))
        logged_max = _number(self.flags.get("max_mcq"))
        max_mcq = settings.max_mcq if settings is not None else _MAX_MCQ if logged_max is None else int(logged_max)
        mcq_timeout = settings.mcq_timeout_s if settings is not None else _MCQ_TIMEOUT_S
        accuracy = settings.mcq_answer_accuracy if settings is not None else _ACCURACY
        if budget is not None:
            budget = budget.model_dump(mode="json") if hasattr(budget, "model_dump") else dict(budget)
        elif self.budget:
            budget = dict(self.budget)
        elif settings is not None:
            budget = settings.budget_for(special).model_dump(mode="json")
        hard = _number((budget or {}).get("hard_deadline_s"))

        final = self.final
        is_final = final is not None
        frozen = self.final_elapsed_s if self.final_elapsed_s is not None else self.last_event_t_rel_s or 0.0
        pending = None
        if live:
            status = session.status
            open_mcq = session.pending_mcq
            if open_mcq and human and not open_mcq.get("answered"):
                remaining = _mcq_remaining_s(open_mcq.get("asked_at"), mcq_timeout)
                left = session.remaining_s()
                if left is not None:
                    # near the deadline the session waits less than the full window
                    remaining = min(remaining, max(0.0, left - MCQ_DEADLINE_MARGIN_S / 2))
                pending = {**open_mcq, "remaining_s": remaining}
            if is_final or session.final is not None:
                elapsed = frozen if is_final else session.elapsed_s()
            else:
                # a queued panorama's clock starts when it leaves the queue
                elapsed = 0.0 if status == "pending" else session.elapsed_s()
            named = list(session.named_places)
            mcq_allowed = bool(session.mcq_allowed)
        else:
            status = self.status if replay or is_final else "interrupted"
            if replay and self.pending_mcq is not None:
                pending = {**self.pending_mcq, "remaining_s": mcq_timeout}
            elapsed = frozen if is_final else self.last_event_t_rel_s or 0.0
            named = list(self.named_places)
            mcq_allowed = self.mcq_allowed
        if pending is not None:
            options = [str(o) for o in pending.get("options") or []][:4]
            pending = {
                "id": str(pending.get("id")),
                "question": str(pending.get("question", "")),
                "options": options,
                "why_it_matters": str(pending.get("why_it_matters", "")),
                "timeout_s": mcq_timeout,
                "remaining_s": pending["remaining_s"],
                "option_places": option_places(options, self.hypotheses),
            }

        window = None
        if human and hard is not None and (live or replay):
            window = {
                "cue_closes_at_s": max(0.0, hard - CUE_MIN_REMAINING_S),
                "mcq_closes_at_s": max(0.0, hard - mcq_timeout - MCQ_DEADLINE_MARGIN_S),
            }
        # a cue is only still on its way while a session can deliver it
        waiting = (live or replay) and not is_final
        cues = [
            {**cue, "state": "undelivered" if cue["state"] == "queued" and not waiting else cue["state"]}
            for cue in self.cues
        ]
        multiplier = self.multiplier
        penalty = {
            "cues": self.counts["cue"],
            "mcqs": self.counts["mcq"],
            "human_geocodes": self.counts["geocode"],
            "multiplier": multiplier,
        }
        provisional = self.provisional
        chosen = provisional[0] if provisional else None
        allocator = self.allocator
        if not live and not replay and not is_final:
            words = INTERRUPTED_TEXT
        else:
            words = stop_text(self.stop_reason, self.origin, self.final_reason) if is_final else ""
        retryable = (
            live
            and is_final
            and session.final is not None
            and self.stop_reason in RETRYABLE_STOP_REASONS
            and self.origin != "human_geocode"
            and getattr(session, "human_override", None) is None
        )
        return {
            "run_id": run_id,
            "panorama_id": task.panorama_id if task is not None else self.panorama_id,
            "filename": Path(task.path).name if task is not None else self.filename,
            "label": label,
            "timestamp": task.timestamp if task is not None else self.timestamp,
            "special": special,
            "status": status,
            "active": live and status in ACTIVE_STATUSES,
            "live": live,
            "hypotheses": list(self.hypotheses),
            "provisional": list(provisional),
            "final": None if final is None else list(final),
            "penalty": penalty,
            "multiplier_after": {
                "cue": penalty_multiplier(penalty["cues"] + 1, penalty["mcqs"], penalty["human_geocodes"]),
                "geocode": penalty_multiplier(penalty["cues"], penalty["mcqs"], penalty["human_geocodes"] + 1),
            },
            "ledger": list(self.ledger),
            "ledger_text": ledger_text(self.ledger, multiplier),
            "pending_mcq": pending,
            "last_mcq": self.last_mcq,
            "mcq_allowed": mcq_allowed,
            "mcqs_left": max(0, max_mcq - penalty["mcqs"]),
            "max_mcq": max_mcq,
            "named_places": named,
            "geocode_enabled": live and human and bool(named),
            "human_enabled": human,
            "elapsed_s": round(float(elapsed), 3),
            "spend_usd": round(self.spend_usd, 6),
            "turns": self.turns,
            "segment": self.segment,
            "segment_turns": self.segment_turns,
            "budget": budget,
            "human_window": window,
            "cues": cues,
            "origin": self.origin,
            "stop_reason": self.stop_reason,
            "stop_text": words,
            "allocator": None if allocator is None else {key: allocator.get(key) for key in _ALLOCATOR_KEYS},
            "plan_text": plan_text(allocator, self.origin if is_final else None),
            **_belief_shape(self.hypotheses, label, accuracy),
            "chosen": None if chosen is None else {"lat": chosen.get("lat"), "lng": chosen.get("lng")},
            "expected_score": expected_score(provisional, self.hypotheses, label, special),
            "last_seq": self.last_seq,
            "last_event_ts": self.last_event_ts,
            "last_event_t_rel_s": self.last_event_t_rel_s,
            "first_candidates_t_rel_s": self.first_candidates_t_rel_s,
            "api_trouble": self.api_trouble,
            "api_trouble_text": self.api_trouble_text,
            "retryable": bool(retryable),
            "fallback_acknowledged": "fallback" in set(acks),
            "export_problems": export_problem or None,
            "image": self.image,
            # numbered as they were asked for; the results of one turn can land in any order
            "crops": sorted(self.crops, key=lambda crop: crop["n"]),
            "activity": self.activity,
            "last_reasoning": self.last_reasoning,
            "model": self.model or (settings.model if settings is not None else None),
            "effort": self.effort or (budget or {}).get("effort"),
        }


_HANDLERS = {
    "run_start": LogFold._on_run_start,
    "run_resumed": LogFold._on_restart,
    "retry": LogFold._on_restart,
    "model_request": LogFold._on_model_request,
    "model_response": LogFold._on_model_response,
    "tool_call": LogFold._on_tool_call,
    "tool_result": LogFold._on_tool_result,
    "candidates_update": LogFold._on_candidates_update,
    "final_submission": LogFold._on_final_submission,
    "run_end": LogFold._on_run_end,
    "mcq_asked": LogFold._on_mcq_asked,
    "mcq_answered": LogFold._on_mcq_answered,
    "mcq_toggle": LogFold._on_mcq_toggle,
    "human_cue": LogFold._on_human_cue,
    "human_cue_delivered": LogFold._settle_cue,
    "human_cue_undelivered": LogFold._settle_cue,
    "human_geocode": LogFold._on_human_geocode,
    "api_retry": LogFold._on_api_retry,
    "api_error": LogFold._on_api_error,
}


def fold_file(path: str | Path, upto_seq: int | None = None, *, task: Any = None) -> LogFold:
    """Fold a log on disk, whole or up to and including event `upto_seq` (a replay).
    Blocking: call it from a worker thread, never for a log a live session is writing."""
    fold = LogFold(task)
    for envelope in iter_events(path):
        seq = envelope.get("seq")
        if upto_seq is not None and isinstance(seq, int) and seq > upto_seq:
            break
        fold.apply(envelope)
    return fold


def digest_events(envelopes: Iterable[Mapping[str, Any]], after: int = 0) -> list[dict[str, Any]]:
    """Digests of the events with seq above `after`, numbered against the whole log (a crop keeps
    its number wherever the page starts reading)."""
    fold = LogFold()
    out = []
    for envelope in envelopes:
        if fold.apply(envelope) and envelope["seq"] > after:
            out.append(fold.digest(envelope))
    return out


# ---------------------------------------------------------------------------------------------
# a run's tiles together


def tile_sort_key(tile: Mapping[str, Any]) -> tuple[bool, bool, str]:
    """Special One first, then Urban, then non-Urban (the order of the legacy page)."""
    return (not tile.get("special"), tile.get("label") != Label.URBAN.value, str(tile.get("panorama_id")))


def sort_tiles(tiles: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(tiles, key=tile_sort_key)


def run_totals(tiles: Sequence[Mapping[str, Any]], settings: Settings | None = None) -> dict[str, Any]:
    """RunState.totals: the header line of a run. A tile without a budget of its own (a
    panorama that never started, in a run we have settings for) counts that run's cap."""
    spend_cap = 0.0
    score = score_max = 0.0
    for tile in tiles:
        cap = _number(_dict(tile.get("budget")).get("max_spend_usd"))
        if cap is None and settings is not None:
            cap = settings.budget_for(bool(tile.get("special"))).max_spend_usd
        spend_cap += cap or 0.0
        expected = _dict(tile.get("expected_score"))
        score += _number(expected.get("value")) or 0.0
        # a tile with no belief yet still counts toward what the run could score
        score_max += _MAX_SCORE * (SPECIAL_MULTIPLIER if tile.get("special") else 1.0)
    penalties = [_dict(tile.get("penalty")) for tile in tiles]
    return {
        "done": sum(1 for tile in tiles if tile.get("status") == "done"),
        "total": len(tiles),
        "spend_usd": round(sum(_number(tile.get("spend_usd")) or 0.0 for tile in tiles), 6),
        "spend_cap_usd": round(spend_cap, 2),
        "expected_score": round(score, 1),
        "expected_score_max": round(score_max, 1),
        "lowest_multiplier": min((_number(p.get("multiplier")) or 1.0 for p in penalties), default=1.0),
        "penalties": {
            key: sum(int(_number(p.get(key)) or 0) for p in penalties) for key in ("cues", "mcqs", "human_geocodes")
        },
    }
