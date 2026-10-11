"""Pure security helpers of the console: names, paths, secrets and the ground-truth gate.

Nothing here knows about HTTP. The route layer turns a ValueError from `safe_id` into a 400 (path
parameter) or 422 (body field) and a PermissionError from `confine` into a 403; the middleware
(host, origin, LAN token, headers) lives in server/middleware.py.
"""

from __future__ import annotations

import json
import os
import re
import threading
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from astrolabio.tools.http import SECRET_PARAMS

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
TAG_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")

KEY_NAMES: tuple[str, ...] = ("OPENAI_API_KEY", "GOOGLE_MAPS_API_KEY", "MAPILLARY_TOKEN")
REDACTED = "REDACTED"
# A shorter value is not a credible key, and replacing it everywhere would shred ordinary text.
_MIN_SECRET_CHARS = 6

EVENTS_SUFFIX = ".events.jsonl"


def safe_id(value: Any, what: str = "id") -> str:
    """`value` as a name that is safe to join onto a directory, or ValueError.

    Run ids, panorama ids, set ids, job ids and tags all become file or directory names, and a
    percent-encoded `..` reaches a handler as an ordinary path parameter."""
    if not isinstance(value, str) or not ID_RE.match(value) or ".." in value:
        shown = value if isinstance(value, str) and len(value) <= 40 else type(value).__name__
        raise ValueError(
            f"invalid {what} {shown!r}: use 1 to 100 letters, digits, '.', '_' or '-', starting with a "
            "letter or digit and without '..'"
        )
    return value


def safe_tag(value: Any, what: str = "tag") -> str:
    """A rescore tag: written to disk as results.<tag>.json."""
    if not isinstance(value, str) or not TAG_RE.match(value):
        raise ValueError(f"invalid {what}: use 1 to 32 lower-case letters, digits, '_' or '-'")
    return value


def safe_sha(value: Any, what: str = "image id") -> str:
    if not isinstance(value, str) or not SHA_RE.match(value):
        raise ValueError(f"invalid {what}: expected 64 lower-case hex characters")
    return value


def confine(path: str | Path, roots: Path | str | Iterable[Path | str], *, strict: bool = True) -> Path:
    """The resolved `path` when it lies inside one of `roots`, else PermissionError.

    The one path check of the console: symlinks and `..` are resolved before the comparison, so a
    link that leaves a root is refused. `strict` (the default) also requires the path to exist and
    lets FileNotFoundError through; pass strict=False for a file about to be written."""
    if isinstance(roots, (str, Path)):
        roots = [roots]
    try:
        resolved = Path(path).expanduser().resolve(strict=strict)
    except FileNotFoundError:
        raise
    except (OSError, RuntimeError, ValueError) as exc:  # symlink loop, NUL byte, unreadable parent
        raise PermissionError(f"path cannot be resolved: {type(exc).__name__}") from exc
    for root in roots:
        try:
            if resolved.is_relative_to(Path(root).expanduser().resolve()):
                return resolved
        except (OSError, RuntimeError, ValueError):
            continue
    raise PermissionError("path is outside the allowed directories")


# ---------------------------------------------------------------------------------------------
# secrets

_PARAM_NAMES = "|".join(sorted((re.escape(name) for name in SECRET_PARAMS), key=len, reverse=True))
# Any parameter whose name ends in one of the secret names: `key=`, `api_key=`, `access_token=`.
_PARAM_RE = re.compile(rf"(?i)\b([A-Za-z0-9_.-]*(?:{_PARAM_NAMES}))=([^&\s\"'<>#]+)")
_HEADER_RE = re.compile(
    r"(?i)\b((?:proxy-)?authorization|x-api-key|x-astrolabio-token)"
    r"(\"?'?\s*[:=]\s*\"?'?)((?:bearer|basic)\s+)?[^\s\"',;]+"
)
_BEARER_RE = re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}")
# Provider errors echo the key they were given, in full or starred out ("sk-abc***wxyz").
_PROVIDER_KEY_RE = re.compile(r"\bsk-[A-Za-z0-9_*.-]{6,}")


def redact(text: Any, *, extra: Iterable[str] = ()) -> str:
    """`text` without the current key values, secret query parameters or Authorization values.

    Everything that leaves through a job log, a key test, a health row or an error message passes
    through here: upstream errors quote the URL they failed on, and the URL carries the key.
    `extra` names further secrets of the caller (the LAN token)."""
    out = text if isinstance(text, str) else str(text)
    secrets = [os.environ.get(name) or "" for name in KEY_NAMES] + [s for s in extra if isinstance(s, str)]
    # longest first, so a key that contains another is not left half-visible
    for secret in sorted({s for s in secrets if len(s) >= _MIN_SECRET_CHARS}, key=len, reverse=True):
        out = out.replace(secret, REDACTED)
    out = _HEADER_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3) or ''}{REDACTED}", out)
    out = _BEARER_RE.sub(lambda m: f"{m.group(1)} {REDACTED}", out)
    out = _PARAM_RE.sub(lambda m: f"{m.group(1)}={REDACTED}", out)
    return _PROVIDER_KEY_RE.sub(REDACTED, out)


def redact_deep(value: Any, *, extra: Iterable[str] = ()) -> Any:
    """`value` (JSON-shaped) with every string in it redacted; keys of objects are left as they are."""
    if isinstance(value, str):
        return redact(value, extra=extra)
    if isinstance(value, dict):
        return {key: redact_deep(item, extra=extra) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_deep(item, extra=extra) for item in value]
    return value


# ---------------------------------------------------------------------------------------------
# ground truth

_HUMAN_EVENTS = frozenset({"human_cue", "mcq_asked", "human_geocode"})
_MARKERS = (*_HUMAN_EVENTS, "mcq_answered", "run_start")
_log_verdicts: dict[str, tuple[int, int, tuple[bool, bool]]] = {}
_log_verdicts_lock = threading.Lock()


def _scan_log(path: Path) -> tuple[bool, bool]:
    """(a human channel was used, every run_start says no_human) for one event log."""
    human, autonomous = False, True
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                # run_start alone is hundreds of kilobytes (the system prompt): parse only the
                # lines that can matter.
                if not any(marker in line for marker in _MARKERS):
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                kind, data = event.get("type"), event.get("data")
                if kind in _HUMAN_EVENTS or (kind == "mcq_answered" and event.get("actor") == "human"):
                    human = True
                elif kind == "run_start":
                    flags = data.get("flags") if isinstance(data, dict) else None
                    if not isinstance(flags, dict) or flags.get("no_human") is not True:
                        autonomous = False
    except OSError:
        return True, False  # unreadable: nothing proves the run was autonomous
    return human, autonomous


def _log_verdict(path: Path) -> tuple[bool, bool]:
    try:
        stat = path.stat()
    except OSError:
        return True, False
    key = str(path)
    with _log_verdicts_lock:
        cached = _log_verdicts.get(key)
    if cached is not None and cached[:2] == (stat.st_mtime_ns, stat.st_size):
        return cached[2]
    verdict = _scan_log(path)
    with _log_verdicts_lock:
        _log_verdicts[key] = (stat.st_mtime_ns, stat.st_size, verdict)
    return verdict


def truth_allowed(meta: Mapping[str, Any] | None, run_dir: str | Path) -> bool:
    """The single gate for truth-derived data (coordinates, distance, theta, score, share).

    True only for an evaluation run whose human channels were off and whose logs record no human
    interaction: ground truth must never be visible where a cue, a question or a geocode could
    still carry it to the agent. `meta` is the run's run.json (for a CLI evaluation run, the
    index's stand-in with kind "eval" and no settings; its logs must then prove no_human).
    Reads the logs: call it from a worker thread."""
    if not isinstance(meta, Mapping) or meta.get("kind") != "eval":
        return False
    settings = meta.get("settings")
    frozen = isinstance(settings, Mapping)
    if frozen and settings.get("no_human") is not True:
        return False
    try:
        logs = sorted(Path(run_dir).glob(f"*{EVENTS_SUFFIX}"))
    except OSError:
        return False
    if not logs and not frozen:
        return False
    for log in logs:
        human, autonomous = _log_verdict(log)
        if human or not autonomous:
            return False
    return True
