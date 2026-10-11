"""Replay and the inspectors of one panorama (UI-SPEC 5.6), from its event log alone.

`replay_tile` is the tile as it stood at one event; `inspect_log` is everything the focus screen
draws around it: the scrubber's timeline, the hypothesis chart, and the turn, tool and image
inspectors. Both fold the JSONL file with `runstate.LogFold`, so a replay cannot disagree with the
live tile, and both serve a run this process holds as well as one that only exists on disk.

Everything here reads files and blocks: call it from a worker thread. Nothing reads ground truth
(no manifest, no results file), so the output is safe to show for any run.
"""

from __future__ import annotations

import io
import math
import re
import zipfile
from collections.abc import Iterable, Iterator, Mapping
from pathlib import Path
from typing import Any

from PIL import Image

from astrolabio import prompts
from astrolabio.config import Settings
from astrolabio.loop import MAX_IMAGE_PAYLOAD_CHARS, MAX_REQUEST_IMAGES

from .app import _tool_name
from .runstate import LogFold, _dict, _dicts, _number, fold_file, iter_events
from .security import SHA_RE, confine, redact
from .workspace import _tile_state

# Estimated input tokens of one image: its 32-pixel patches times 1.2. That is the figure the
# harness budgets with (astrolabio.loop: a 1456 px view is about 2,540 tokens; astrolabio.pano: a
# 2000 px one about 4,800), and on a logged 20-turn run it puts the images within about 4% of
# the input tokens the API billed once instructions and text are taken off. It assumes the default
# image_detail "original": the log does not record that setting.
IMAGE_PATCH_PX = 32
IMAGE_TOKENS_PER_PATCH = 1.2

_IMAGE_NAME_RE = re.compile(r"^[0-9a-f]{64}\.jpg$")
_MARKS = {
    "candidates_update": "candidates",
    "final_submission": "final",
    "soft_deadline_notice": "soft_deadline",
    "human_cue": "human",
    "mcq_asked": "human",
    "mcq_answered": "human",
    "human_geocode": "human",
    "api_retry": "error",
    "api_error": "error",
    "harness_error": "error",
}
_FACT_KEYS = ("model", "effort", "budget", "flags", "git_sha", "request", "system_prompt", "tools", "provenance")
_TOKEN_KEYS = {
    "input": "input_tokens",
    "cached": "cached_input_tokens",
    "output": "output_tokens",
    "reasoning": "reasoning_tokens",
}


def estimate_image_tokens(width: Any, height: Any) -> int | None:
    if not width or not height:
        return None
    patches = math.ceil(width / IMAGE_PATCH_PX) * math.ceil(height / IMAGE_PATCH_PX)
    return round(patches * IMAGE_TOKENS_PER_PATCH)


def replay_tile(
    log_path: str | Path,
    *,
    run_id: str,
    panorama_id: str,
    at: int | None = None,
    task: Any = None,
    settings: Settings | None = None,
    live_budget: bool = False,
    acks: Iterable[str] = (),
) -> dict[str, Any]:
    """The TileState of a panorama as its log stood at event `at`.

    A past moment keeps the status it had then (a log read up to the middle is not an interrupted
    run); with `at` None the whole log is folded as the record it is now, so one that stops short
    of an answer does read `interrupted`. `task` names a panorama whose log is still empty."""
    fold = fold_file(log_path, at, task=task)
    fold.panorama_id = fold.panorama_id or panorama_id
    budget = None
    if settings is not None and not fold.budget:
        budget = settings.budget_for(fold.special, live=live_budget)
    return _tile_state(fold, run_id=run_id, settings=settings, budget=budget, acks=acks, replay=at is not None)


# ---------------------------------------------------------------------------------------------
# images on disk


class _ImageFiles:
    """Pixel size and upload size of a panorama's views, by sha256. The log records the size of
    a view_crop only; everything else is measured from the file the run saved."""

    def __init__(self, image_dir: Path | None) -> None:
        self._dir = image_dir
        self._sizes: dict[str, tuple[int | None, int | None]] = {}

    def _path(self, sha: str) -> Path | None:
        # built from the hash, never from the path the log quotes
        return self._dir / f"{sha}.jpg" if self._dir is not None and SHA_RE.match(sha) else None

    def note(self, sha: Any, width: Any, height: Any) -> None:
        width, height = _number(width), _number(height)
        if isinstance(sha, str) and width and height:
            self._sizes[sha] = (int(width), int(height))

    def size(self, sha: str) -> tuple[int | None, int | None]:
        if sha not in self._sizes:
            path, size = self._path(sha), (None, None)
            if path is not None:
                try:
                    with Image.open(path) as image:  # reads the header only
                        size = image.size
                except (OSError, ValueError):
                    pass
            self._sizes[sha] = size
        return self._sizes[sha]

    def payload_chars(self, sha: str) -> int | None:
        """Base64 characters of the file: what the loop counts against its payload budget."""
        path = self._path(sha)
        try:
            return None if path is None else 4 * ((path.stat().st_size + 2) // 3)
        except OSError:
            return None


def _image_refs(node: Any, found: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Image references ({sha256, ...}) anywhere in a tool's log, each view once, in order."""
    if isinstance(node, dict):
        sha = node.get("sha256")
        if isinstance(sha, str) and SHA_RE.match(sha) and all(ref["sha256"] != sha for ref in found):
            found.append(node)
        for value in node.values():
            _image_refs(value, found)
    elif isinstance(node, list):
        for value in node:
            _image_refs(value, found)
    return found


def _sent_images(messages: Any) -> Iterator[tuple[dict[str, Any], Any]]:
    """(image block, id of the tool call that returned it or None) for every image a request
    added to the conversation, in the order the model received them."""
    for message in _dicts(messages):
        for block in _dicts(message.get("content")):
            if block.get("type") == "image":
                yield block, None
            elif block.get("type") == "tool_result":
                for inner in _dicts(block.get("content")):
                    if inner.get("type") == "image":
                        yield inner, block.get("tool_use_id")


def _carries_commit_notice(messages: Any) -> bool:
    return any(
        block.get("type") == "text" and prompts.COMMIT_NOW_NOTICE in str(block.get("text") or "")
        for message in _dicts(messages)
        for block in _dicts(message.get("content"))
    )


def _cache_hit(log: Mapping[str, Any]) -> bool | None:
    """True when the log says every lookup of the call was answered from the HTTP cache."""
    if isinstance(log.get("from_cache"), bool):
        return log["from_cache"]
    flags = [s["from_cache"] for s in _dicts(log.get("sources")) if isinstance(s.get("from_cache"), bool)]
    return all(flags) if flags else None


def _hosted_urls(action: Mapping[str, Any]) -> list[str]:
    urls = [action.get("url"), *(source.get("url") for source in _dicts(action.get("sources")))]
    return [redact(url) for url in dict.fromkeys(urls) if isinstance(url, str) and url]


# ---------------------------------------------------------------------------------------------
# the inspectors


class _Inspection:
    """One pass over a log, collecting what each inspector shows while a LogFold keeps the state."""

    def __init__(self, fold: LogFold, files: _ImageFiles) -> None:
        self.fold = fold
        self.files = files
        self.timeline: list[dict[str, Any]] = []
        self.keyframes: list[dict[str, Any]] = []
        self.labels: list[str] = []
        self.beliefs: list[dict[str, Any]] = []
        self.top_path: list[dict[str, Any]] = []
        self.turns: list[dict[str, Any]] = []
        self.tools: list[dict[str, Any]] = []
        self.images: list[dict[str, Any]] = []
        self.run_start: dict[str, Any] = {}
        self._open_turn: dict[str, Any] | None = None
        self._calls: dict[Any, dict[str, Any]] = {}
        self._unanswered: list[dict[str, Any]] = []
        self._notice_logged = False  # a soft_deadline_notice event announced the next request's notice
        # the image budget is per conversation: what the latest one has used
        self._budget = {"count": 0, "payload_chars": 0}
        self._sent = {"count": 0, "payload_chars": 0}

    def _state(self) -> tuple[Any, ...]:
        fold = self.fold
        return fold.hypotheses, fold.provisional, fold.final, tuple(fold.counts.values()), fold.status

    def feed(self, envelope: dict[str, Any]) -> None:
        fold = self.fold
        before = self._state()
        if not fold.apply(envelope):
            return
        seq, type_ = envelope["seq"], str(envelope.get("type"))
        data, t_rel = _dict(envelope.get("data")), _number(envelope.get("t_rel_s"))
        mark = _MARKS.get(type_)
        handler = _HANDLERS.get(type_)
        if handler is not None:
            try:
                mark = handler(self, seq, t_rel, data) or mark
            except Exception:  # one damaged event must not hide the rest of the log
                pass
        self.timeline.append(
            {
                "seq": seq,
                "t_rel_s": t_rel,
                "segment": fold.segment,
                "type": type_,
                "turn": fold.turn_at(seq),
                "mark": mark,
            }
        )
        after = self._state()
        if after != before:
            self.keyframes.append(
                {
                    "seq": seq,
                    "t_rel_s": t_rel,
                    "segment": fold.segment,
                    "status": fold.status,
                    "hypotheses": list(fold.hypotheses),
                    "provisional": list(fold.provisional),
                    "final": None if fold.final is None else list(fold.final),
                    "penalty": {
                        "cues": fold.counts["cue"],
                        "mcqs": fold.counts["mcq"],
                        "human_geocodes": fold.counts["geocode"],
                        "multiplier": fold.multiplier,
                    },
                }
            )
        if after[0] != before[0]:
            self._belief(seq, t_rel)

    def _belief(self, seq: int, t_rel: Any) -> None:
        shares: dict[str, float] = {}
        for hyp in self.fold.hypotheses:
            name = str(hyp.get("label") or "").strip() or "(no label)"
            # two hypotheses under one name are one place as far as the chart can tell
            shares[name] = shares.get(name, 0.0) + (_number(hyp.get("probability")) or 0.0)
        self.labels += [name for name in shares if name not in self.labels]
        self.beliefs.append({"seq": seq, "t_rel_s": t_rel, "shares": shares})
        top = max(self.fold.hypotheses, key=lambda h: _number(h.get("probability")) or 0.0, default=None)
        if top is not None:
            self.top_path.append(
                {
                    "seq": seq,
                    "t_rel_s": t_rel,
                    "lat": top.get("lat"),
                    "lng": top.get("lng"),
                    "label": top.get("label"),
                    "probability": top.get("probability"),
                }
            )

    def _on_run_start(self, seq: int, t_rel: Any, data: dict[str, Any]) -> None:
        self.run_start = data
        self._open_turn = None
        self._notice_logged = False
        self._budget = {"count": 0, "payload_chars": 0}
        self._sent = {"count": 0, "payload_chars": 0}

    def _on_soft_deadline_notice(self, seq: int, t_rel: Any, data: dict[str, Any]) -> None:
        self._notice_logged = True

    def _on_model_request(self, seq: int, t_rel: Any, data: dict[str, Any]) -> str | None:
        added = 0
        for block, use_id in _sent_images(data.get("messages")):
            sha = block.get("sha256")
            if not isinstance(sha, str):
                continue
            call = self._calls.get(use_id) if use_id is not None else None
            width, height = self.files.size(sha)
            chars = self.files.payload_chars(sha)
            added += 1
            self._sent["count"] += 1
            self._sent["payload_chars"] += chars or 0
            self.images.append(
                {
                    "n": len(self.images) + 1,
                    "seq": seq,
                    "turn": data.get("turn"),
                    "segment": self.fold.segment,
                    "sha256": sha,
                    "yaw": _number(block.get("yaw")),
                    "pitch": _number(block.get("pitch")),
                    "fov": _number(block.get("fov")),
                    "width": width,
                    "height": height,
                    "est_tokens": estimate_image_tokens(width, height),
                    "payload_chars": chars,
                    "source": "initial" if use_id is None else call["tool"] if call else "tool",
                    "seq_call": call["seq_call"] if call else None,
                }
            )
        # the loop's own counters when it logged them; older logs only have what we can count
        for key, logged in (("count", "image_count"), ("payload_chars", "image_payload_chars")):
            value = _number(data.get(logged))
            self._budget[key] = self._sent[key] if value is None else int(value)
        self._open_turn = {
            "turn": data.get("turn"),
            "segment": self.fold.segment,
            "seq_request": seq,
            "seq_response": None,
            "t_rel_s": t_rel,
            "message_count": data.get("message_count"),
            "image_count": data.get("image_count"),
            "image_payload_chars": data.get("image_payload_chars"),
            "images_added": added,
            "tokens": None,
            "latency_ms": None,
            "cost_usd": None,
            "stop_reason": None,
            "error": None,
            "retries": [],
        }
        self.turns.append(self._open_turn)
        # Logs written before the soft_deadline_notice event existed only show the notice as text.
        announced, self._notice_logged = self._notice_logged, False
        return "soft_deadline" if not announced and _carries_commit_notice(data.get("messages")) else None

    def _on_model_response(self, seq: int, t_rel: Any, data: dict[str, Any]) -> str | None:
        turn, self._open_turn = self._open_turn, None
        if turn is not None:
            usage = _dict(data.get("usage"))
            turn.update(
                seq_response=seq,
                tokens={name: int(_number(usage.get(key)) or 0) for name, key in _TOKEN_KEYS.items()},
                latency_ms=_number(data.get("latency_ms")),
                cost_usd=_number(data.get("cost_usd")),
                stop_reason=data.get("stop_reason"),
            )
        # the hosted web search runs inside the model's turn: it has no tool_call event of its own
        for block in _dicts(data.get("content")):
            if block.get("type") != "server_tool_use":
                continue
            action = _dict(block.get("input"))
            self.tools.append(
                {
                    "seq_call": seq,
                    "seq_result": seq,
                    "turn": self.fold.turn_at(seq),
                    "segment": self.fold.segment,
                    "t_rel_s": t_rel,
                    "tool": str(block.get("name") or "web_search"),
                    "input": {key: value for key, value in action.items() if key != "sources"},
                    "output": None,
                    "is_error": False,
                    "duration_ms": None,
                    "urls": _hosted_urls(action),
                    "cache_hit": None,
                    "images": [],
                    "hosted": True,
                }
            )
        return "error" if data.get("stop_reason") == "refusal" else None

    def _on_api_retry(self, seq: int, t_rel: Any, data: dict[str, Any]) -> None:
        if self._open_turn is not None:
            self._open_turn["retries"].append(
                {
                    "seq": seq,
                    "t_rel_s": t_rel,
                    "message": redact(str(data.get("message") or data.get("error_class") or "")),
                    "delay_s": _number(data.get("delay_s")),
                    "attempt": data.get("attempt"),
                    "status_code": data.get("status_code"),
                }
            )

    def _on_api_error(self, seq: int, t_rel: Any, data: dict[str, Any]) -> None:
        turn, self._open_turn = self._open_turn, None
        if turn is not None:
            turn["error"] = redact(str(data.get("message") or data.get("error_class") or "API error"))

    def _on_tool_call(self, seq: int, t_rel: Any, data: dict[str, Any]) -> None:
        call = {
            "seq_call": seq,
            "seq_result": None,
            "turn": self.fold.turn_at(seq),
            "segment": self.fold.segment,
            "t_rel_s": t_rel,
            "tool": _tool_name(data),
            "input": data.get("input", data.get("args")),
            "output": None,
            "is_error": False,
            "duration_ms": None,
            "urls": [],
            "cache_hit": None,
            "images": [],
            "hosted": False,
        }
        self.tools.append(call)
        self._unanswered.append(call)
        if data.get("tool_use_id") is not None:
            self._calls[data["tool_use_id"]] = call

    def _on_tool_result(self, seq: int, t_rel: Any, data: dict[str, Any]) -> None:
        tool, use_id = _tool_name(data), data.get("tool_use_id")
        call = self._calls.get(use_id) if use_id is not None else None
        if call is None or call["seq_result"] is not None:
            # no id to go by: results of one tool come back in the order they were asked for
            call = next((c for c in self._unanswered if c["tool"] == tool), None)
        if call is None:
            return
        self._unanswered.remove(call)
        log = _dict(data.get("log"))
        if tool == "view_crop":
            self.files.note(_dict(log.get("image")).get("sha256"), log.get("width"), log.get("height"))
        images = []
        for ref in _image_refs(log, []):
            width, height = self.files.size(ref["sha256"])
            image = {
                "sha256": ref["sha256"],
                "yaw": _number(ref.get("yaw")),
                "pitch": _number(ref.get("pitch")),
                "fov": _number(ref.get("fov")),
                "width": width,
                "height": height,
            }
            # what a street-level or satellite result is compared by
            image.update({key: ref[key] for key in ("source", "heading") if ref.get(key) is not None})
            images.append(image)
        output = data.get("output")
        call.update(
            seq_result=seq,
            output=redact(output) if isinstance(output, str) else output,
            is_error=bool(data.get("is_error")),
            duration_ms=_number(data.get("duration_ms")),
            urls=[redact(url) for url in data.get("urls") or [] if isinstance(url, str)],
            cache_hit=_cache_hit(log),
            images=images,
        )

    def result(self, run_id: str, panorama_id: str) -> dict[str, Any]:
        fold, start = self.fold, self.run_start
        panorama = _dict(start.get("panorama")) or {"panorama_id": fold.panorama_id, "filename": fold.filename}
        points = [
            {
                "seq": belief["seq"],
                "t_rel_s": belief["t_rel_s"],
                "probabilities": [
                    round(belief["shares"][name], 6) if name in belief["shares"] else None for name in self.labels
                ],
            }
            for belief in self.beliefs
        ]
        # the number of a crop's footprint on the viewer, so a call or a view can highlight it
        footprints = {crop["seq_call"]: crop["n"] for crop in fold.crops}
        for item in (*self.tools, *self.images):
            item["crop_n"] = footprints.get(item["seq_call"])
        return {
            "run_id": run_id,
            "panorama_id": fold.panorama_id or panorama_id,
            "last_seq": fold.last_seq,
            "segments": fold.segment,
            "timeline": self.timeline,
            "keyframes": self.keyframes,
            "series": {"labels": self.labels, "points": points, "top_path": self.top_path},
            "turns": self.turns,
            "tools": self.tools,
            "images": self.images,
            "image_budget": {
                "count": self._budget["count"],
                "max_count": MAX_REQUEST_IMAGES,
                "payload_chars": self._budget["payload_chars"],
                "max_payload_chars": MAX_IMAGE_PAYLOAD_CHARS,
            },
            "ledger": list(fold.ledger),
            "facts": {
                # exactly as the run logged them: the request, the system prompt and the tool list
                **{key: start.get(key) for key in _FACT_KEYS},
                "panorama": panorama,
                "label": fold.label,
                "capture_timestamp": fold.timestamp,
                "special": fold.special,
            },
        }


_HANDLERS = {
    "run_start": _Inspection._on_run_start,
    "soft_deadline_notice": _Inspection._on_soft_deadline_notice,
    "model_request": _Inspection._on_model_request,
    "model_response": _Inspection._on_model_response,
    "api_retry": _Inspection._on_api_retry,
    "api_error": _Inspection._on_api_error,
    "tool_call": _Inspection._on_tool_call,
    "tool_result": _Inspection._on_tool_result,
}


def inspect_log(
    log_path: str | Path,
    *,
    run_id: str,
    panorama_id: str,
    image_dir: str | Path | None = None,
    task: Any = None,
) -> dict[str, Any]:
    """The inspect payload of contract 4.4 for one panorama's log (empty lists for a log that
    does not exist yet). `image_dir` is where the run saved its views (`<run>/<pid>/images`)."""
    inspection = _Inspection(LogFold(task), _ImageFiles(Path(image_dir) if image_dir is not None else None))
    for envelope in iter_events(log_path):
        inspection.feed(envelope)
    return inspection.result(run_id, panorama_id)


# ---------------------------------------------------------------------------------------------
# downloads


def events_bytes(log_path: str | Path) -> bytes:
    """The event log as it stands, whole lines only: a live run may be half-way through one."""
    data = Path(log_path).read_bytes()
    return data[: data.rfind(b"\n") + 1]


def images_zip(image_dir: str | Path) -> bytes | None:
    """A zip of the views a panorama's run saved, or None when there are none.

    Built from an allow-list, never a directory walk: only `<sha256>.jpg` files that really lie in
    the directory go in, so nothing else a run directory holds can leave through it."""
    image_dir = Path(image_dir)
    try:
        names = sorted(p.name for p in image_dir.iterdir() if _IMAGE_NAME_RE.match(p.name))
    except OSError:
        return None
    buffer, stored = io.BytesIO(), 0
    # JPEGs do not deflate; storing them keeps a 20 MB archive quick to build
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        for name in names:
            path = image_dir / name
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                archive.writestr(name, confine(path, image_dir).read_bytes())
            except OSError:  # PermissionError included: a file that resolves outside is left out
                continue
            stored += 1
    return buffer.getvalue() if stored else None
