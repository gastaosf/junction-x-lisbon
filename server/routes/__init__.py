"""Console API routes, and what every route module shares: the error shape, JSON replies, body
and id checks, and the idempotency wrapper.

Route modules get the workspace from `request.app.state.workspace`, so each can be tested on a
bare `FastAPI()`. Errors leave as `{"detail": {"message", "code", "action", "problems", ...}}`
with a message that says what happened and what to do next.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Awaitable, Callable, Iterator, Mapping
from contextlib import contextmanager
from datetime import datetime
from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import Response

from astrolabio.schema import Label

from ..hub import fingerprint
from ..security import redact, safe_id
from ..sets import ConsoleError

IDEMPOTENCY_HEADER = "Idempotency-Key"
REPLAYED_HEADER = "Idempotency-Replayed"
_LABELS = frozenset(label.value for label in Label)
_TIMESTAMP_RE = re.compile(r"^\d{14}$")
_OVERRIDE_FIELDS = ("label", "timestamp", "special")
_TRUE, _FALSE = frozenset({"1", "true", "yes", "on"}), frozenset({"0", "false", "no", "off"})


def workspace(request: Request) -> Any:
    return request.app.state.workspace


def lan_enabled(request: Request) -> bool:
    """Whether this server was started with LAN access on (what it was at start is what counts:
    a change in Settings only applies after a restart)."""
    started_with = getattr(request.app.state, "lan", None)
    return bool(workspace(request).store.lan()["enabled"]) if started_with is None else bool(started_with)


# ---------------------------------------------------------------------------------------------
# replies


def _finite(value: Any) -> Any:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {key: _finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(item) for item in value]
    return value


def dumps(payload: Any) -> str:
    """JSON a browser can parse: `NaN` and `Infinity` are not JSON, and one of them in a state
    payload would otherwise take the whole page's stream down."""
    try:
        return json.dumps(payload, ensure_ascii=False, allow_nan=False, default=str)
    except ValueError:
        return json.dumps(_finite(payload), ensure_ascii=False, default=str)


def reply(content: Any, status: int = 200, headers: Mapping[str, str] | None = None) -> Response:
    return Response(dumps(content), status_code=status, media_type="application/json", headers=dict(headers or {}))


# ---------------------------------------------------------------------------------------------
# errors


def error_detail(
    message: Any, *, code: str | None = None, action: str | None = None, problems: list[Any] | None = None, **extra: Any
) -> dict[str, Any]:
    # redacted: upstream errors quote the URL they failed on, and the URL can carry a key
    return {"message": redact(message), "code": code, "action": action, "problems": problems, **extra}


def refuse(
    status: int,
    message: str,
    *,
    code: str | None = None,
    action: str | None = None,
    problems: list[Any] | None = None,
    **extra: Any,
) -> HTTPException:
    return HTTPException(status, error_detail(message, code=code, action=action, problems=problems, **extra))


def http_error(exc: BaseException) -> HTTPException:
    """What the workspace and the set store raise (see server/workspace.py), as an HTTP refusal."""
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, ConsoleError):
        detail = exc.detail()
        return HTTPException(exc.status, {**detail, "message": redact(detail["message"])})
    if isinstance(exc, KeyError):
        name = exc.args[0] if exc.args else "it"
        return refuse(
            404,
            f"There is no {name!r} here. It may have been deleted, or the server was restarted: reload the page.",
            code="not_found",
        )
    if isinstance(exc, FileNotFoundError):
        return refuse(404, "That path does not exist (any more). Check it and try again.", code="not_found")
    if isinstance(exc, PermissionError):
        return refuse(
            403,
            "That path is outside the directories the console may read. Add its folder to the allowed "
            "roots in Settings, or upload the files instead.",
            code="outside_allowed_roots",
        )
    raise exc


@contextmanager
def refusals() -> Iterator[None]:
    """Turn the refusals of the layers below into HTTP errors; anything else is a bug and stays one."""
    try:
        yield
    except HTTPException:
        raise
    except (ConsoleError, KeyError, PermissionError, FileNotFoundError) as exc:
        raise http_error(exc) from exc


# ---------------------------------------------------------------------------------------------
# request parts


def path_id(value: str, what: str) -> str:
    """A path parameter that becomes a file or directory name (400 when it is not safe)."""
    try:
        return safe_id(value, what)
    except ValueError as exc:
        raise refuse(400, f"{exc}.", code="invalid_id") from exc


def body_id(value: Any, what: str) -> str:
    """The same for a value from a request body (422)."""
    try:
        return safe_id(value, what)
    except ValueError as exc:
        raise refuse(422, f"{exc}.", code="invalid_id") from exc


async def json_body(request: Request, *, optional: bool = False) -> dict[str, Any]:
    """The request body as a JSON object. Parsed by hand: the raw bytes are also what an
    idempotency key is bound to."""
    raw = await request.body()
    if not raw.strip():
        if optional:
            return {}
        raise refuse(422, "This request needs a JSON object as its body.", code="body_required")
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise refuse(422, "The request body is not valid JSON.", code="invalid_json") from exc
    if not isinstance(body, dict):
        raise refuse(422, "The request body must be a JSON object.", code="invalid_json")
    return body


def flag(raw: str | None, name: str) -> bool | None:
    """A boolean query parameter; None when it was not sent."""
    if raw is None or raw == "":
        return None
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    raise refuse(422, f"{name} must be true or false.", code="invalid_query")


def check_task_choices(body: Mapping[str, Any]) -> None:
    """The operator's fixed choices for a set (`overrides`, `special`, `apply_label_to_unlabelled`),
    checked here as well as in the loader: a label is one of two words, a timestamp fourteen
    digits that are a real date, the Special One flag a boolean. Anything looser would be a
    fourth channel of text to the model (the timestamp is quoted in its first message)."""
    problems: list[str] = []
    overrides = body.get("overrides")
    if overrides is not None and not isinstance(overrides, dict):
        problems.append("overrides must be an object keyed by panorama id")
        overrides = None
    for key, choice in (overrides or {}).items():
        if not isinstance(choice, dict):
            problems.append(f"overrides.{key} must be an object with label, timestamp and / or special")
            continue
        for field, value in choice.items():
            if field not in _OVERRIDE_FIELDS:
                problems.append(f"overrides.{key}.{field} is not a field a task has (label, timestamp, special)")
            elif field == "label" and value not in _LABELS:
                problems.append(f"overrides.{key}.label must be exactly 'Urban' or 'non-Urban'")
            elif field == "timestamp" and value is not None and not _is_timestamp(value):
                problems.append(f"overrides.{key}.timestamp must be YYYYMMDDhhmmss (a real date and time) or null")
            elif field == "special" and not isinstance(value, bool):
                problems.append(f"overrides.{key}.special must be true or false")
    special = body.get("special")
    if special is not None and not isinstance(special, str):
        problems.append("special must name one panorama, or be null")
    bulk = body.get("apply_label_to_unlabelled")
    if bulk is not None and bulk not in _LABELS:
        problems.append("apply_label_to_unlabelled must be exactly 'Urban' or 'non-Urban', or null")
    if problems:
        raise refuse(422, "; ".join(problems) + ".", code="invalid_override", problems=problems)


def _is_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not _TIMESTAMP_RE.match(value):
        return False
    try:
        datetime.strptime(value, "%Y%m%d%H%M%S")
    except ValueError:
        return False
    return True


# ---------------------------------------------------------------------------------------------
# idempotency


async def idempotent(
    request: Request,
    work: Callable[[], Awaitable[dict[str, Any]]],
    *,
    required: bool = False,
    status: int = 200,
) -> Response:
    """Run `work` once per Idempotency-Key and answer with its result; a repeat of the request (a
    double click, a retry after a timeout) gets the first answer and changes nothing.

    Everything that touches a run belongs inside `work`: it runs detached from the connection,
    and what it refuses is remembered with the key like any other answer."""

    async def factory() -> dict[str, Any]:
        with refusals():
            return await work()

    body, replayed = await workspace(request).idempotency.run(
        f"{request.method} {request.url.path}",
        request.headers.get(IDEMPOTENCY_HEADER),
        factory,
        fingerprint=fingerprint(await request.body()),
        required=required,
    )
    return reply(body, status, {REPLAYED_HEADER: "true"} if replayed else None)
