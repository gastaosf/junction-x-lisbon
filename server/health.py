"""Keys and surroundings of the console: the .env writer, key tests, reachability, disk, version.

Keys are write-only from the browser's side: a value arrives once, goes into the .env file the
workspace names and into this process's environment, and is never sent back. Whatever text leaves
this module (a provider's error, a probed URL) has passed `security.redact`.

Nothing here runs unless a route asks: there is no background probing, so a test that never calls
the health or key-test routes never opens a connection. Outgoing requests go through
`make_probe_client`, which tests replace with an httpx mock transport.

Where a key may travel: only to its own provider, over https, and never along a redirect. The
health page is read on every page load, so its probes are free of charge, shared between tabs
that ask at the same moment, and, under the scripted demo model, leave every provider that would
take a key alone.
"""

from __future__ import annotations

import asyncio
import os
import platform
import re
import shutil
import threading
import time
import weakref
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
import openai

from astrolabio.config import Settings
from astrolabio.loop import git_sha
from astrolabio.tools.http import http_cache
from astrolabio.tools.streetview import GOOGLE_METADATA_URL, MAPILLARY_IMAGES_URL

from .security import KEY_NAMES, confine, redact

if TYPE_CHECKING:
    from .workspace import Workspace

OPENAI, GOOGLE, MAPILLARY = KEY_NAMES
OPENAI_BASE_URL = "https://api.openai.com/v1"
# The hosts a key is its provider's to see. A health probe sends a key nowhere else: a custom
# OPENAI_BASE_URL (a gateway) is asked without it, and the explicit key test is the way to try it.
KEY_HOSTS: dict[str, frozenset[str]] = {
    OPENAI: frozenset({"api.openai.com"}),
    GOOGLE: frozenset({"maps.googleapis.com"}),
    MAPILLARY: frozenset({"graph.mapillary.com"}),
}
NOT_CHECKED_DEMO = "not checked: demo model"
PROBE_TIMEOUT_S = 6.0
# A model request, however small, takes longer than a status page.
KEY_TEST_TIMEOUT_S = 10.0
# Several tabs on the health page must not add up to a request a second against Nominatim.
PROBE_TTL_S = 30.0
# Printable ASCII with no whitespace. The characters left out are the ones a .env parser gives a
# meaning to (quotes, comment, assignment, escape, interpolation); no provider's keys use them.
KEY_VALUE_RE = re.compile(r"[\x21-\x7e]{8,512}")
_ENV_SPECIAL = frozenset("\"'`#=\\$")
# Central Lisbon: somewhere both imagery providers certainly cover.
_PROBE_LAT, _PROBE_LNG = 38.7169, -9.1399

# (ok, what was found); ok None: the service answered, but what matters could not be asked
Check = Callable[[httpx.AsyncClient], Awaitable[tuple[bool | None, str]]]
KeyTester = Callable[[str, str, str], "Awaitable[dict[str, Any]] | dict[str, Any]"]

_env_lock = threading.Lock()
_recent: "weakref.WeakKeyDictionary[Any, tuple[float, dict[str, Any]]]" = weakref.WeakKeyDictionary()
# the round of probes in flight, so that tabs loading together share it
_probing: "weakref.WeakKeyDictionary[Any, asyncio.Task[dict[str, Any]]]" = weakref.WeakKeyDictionary()


class KeyValueError(ValueError):
    """A key value the console will not write to .env. The message never quotes the value."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def key_may_go_to(name: str, url: str) -> bool:
    """Whether `url` is the provider of key `name` itself (https, its own host)."""
    parts = urlsplit(url)
    return parts.scheme == "https" and (parts.hostname or "").lower() in KEY_HOSTS.get(name, frozenset())


def make_probe_client(settings: Settings) -> httpx.AsyncClient:
    """The client of every key test and reachability probe. A module global on purpose, like
    `runner.make_http_client`: tests swap it for a mock transport."""
    return httpx.AsyncClient(
        timeout=PROBE_TIMEOUT_S, headers={"User-Agent": settings.user_agent}, follow_redirects=True
    )


# ---------------------------------------------------------------------------------------------
# keys


def key_status() -> dict[str, dict[str, Any]]:
    """Which keys this process has. The last four characters of the OpenAI key only: enough to
    tell two keys apart, and the only part of any key a response ever carries."""
    status: dict[str, dict[str, Any]] = {name: {"set": bool(os.environ.get(name))} for name in KEY_NAMES}
    value = os.environ.get(OPENAI) or ""
    status[OPENAI]["last4"] = value[-4:] if len(value) >= 8 else None
    return status


def check_key_value(value: Any) -> str:
    if not isinstance(value, str) or not KEY_VALUE_RE.fullmatch(value) or _ENV_SPECIAL & set(value):
        raise KeyValueError(
            "A key must be 8 to 512 printable characters with no spaces, line breaks, quotes, "
            "'#', '=', '$' or backslash. Paste the key alone, without its NAME= prefix."
        )
    return value


def write_env_key(env_path: str | Path, name: str, value: str) -> None:
    """Set `NAME=value` in the .env file, touching no other line.

    The last assignment of the name is the one a .env reader keeps, so that is the line replaced
    (with its own line ending); a name the file does not have is appended. Written through a
    temporary file of mode 0600 and renamed into place, so a crash leaves the old file whole."""
    if name not in KEY_NAMES:
        raise KeyValueError(f"{name} is not a key the console manages")
    check_key_value(value)
    # a .env that is a link stays one: write what it points at
    path = Path(os.path.realpath(env_path))
    assignment = re.compile(rb"[ \t]*(?:export[ \t]+)?" + re.escape(name.encode()) + rb"[ \t]*=")
    line = f"{name}={value}".encode("ascii")
    with _env_lock:
        try:
            lines = path.read_bytes().splitlines(keepends=True)
        except FileNotFoundError:
            lines = []
        matches = [index for index, old in enumerate(lines) if assignment.match(old)]
        if matches:
            old = lines[matches[-1]]
            lines[matches[-1]] = line + old[len(old.rstrip(b"\r\n")) :]
        else:
            if lines and not lines[-1].endswith((b"\n", b"\r")):
                lines[-1] += b"\n"
            lines.append(line + b"\n")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "wb") as fh:
                os.fchmod(fh.fileno(), 0o600)  # whatever the umask or a leftover file says
                fh.write(b"".join(lines))
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise


async def set_key(workspace: "Workspace", name: str, value: Any) -> dict[str, Any]:
    """Store a key: .env first, then this process, so a failed write changes nothing. New runs
    read it at launch; a run already going keeps the client it was started with."""
    value = check_key_value(value)
    await asyncio.to_thread(write_env_key, workspace.env_path, name, value)
    os.environ[name] = value
    if name == OPENAI:
        workspace.health["openai"] = None  # what the old key's test found says nothing about this one
    workspace.publish_health()
    status = key_status()[name]
    return {"ok": True, **status}


def _error_message(response: httpx.Response) -> tuple[str, str | None, str | None]:
    """(message, code, param) of a provider's JSON error body, as far as it has one."""
    try:
        body = response.json()
    except ValueError:
        return response.text[:200], None, None
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        return str(error.get("message") or "")[:300], error.get("code"), error.get("param")
    if isinstance(body, dict):
        return str(body.get("error_message") or body.get("status") or "")[:300], None, None
    return "", None, None


def _openai_request() -> tuple[str, dict[str, str]]:
    """Base URL and identity headers as the SDK would take them from the environment, so the
    test asks the same endpoint, organisation and project as a run."""
    base = (os.environ.get("OPENAI_BASE_URL") or OPENAI_BASE_URL).rstrip("/")
    headers = {}
    for header, variable in (("OpenAI-Organization", "OPENAI_ORG_ID"), ("OpenAI-Project", "OPENAI_PROJECT_ID")):
        if os.environ.get(variable):
            headers[header] = os.environ[variable]
    return base, headers


def _rejects_summary(message: str, param: str | None) -> bool:
    # same reading as astrolabio.openai_client, which drops the summary and carries on
    text = message.lower()
    return param == "reasoning.summary" or "reasoning.summary" in text or "reasoning summar" in text


async def _test_openai(client: httpx.AsyncClient, value: str, model: str) -> dict[str, Any]:
    """One smallest-possible Responses request, asking for a reasoning summary as every run does.
    Only when the summary itself is refused is a second one sent without it, to tell "no
    summaries" apart from "no access to the model"."""
    base, headers = _openai_request()
    headers["Authorization"] = f"Bearer {value}"
    # 16 is the least the API accepts; reasoning counts toward it, so the answer may be cut short
    body: dict[str, Any] = {"model": model, "input": "Reply with OK.", "max_output_tokens": 16, "store": False}

    async def ask(reasoning: dict[str, str]) -> httpx.Response:
        request = {**body, "reasoning": reasoning}
        return await client.post(
            f"{base}/responses", headers=headers, json=request, timeout=KEY_TEST_TIMEOUT_S, follow_redirects=False
        )

    response = await ask({"effort": "low", "summary": "auto"})
    summaries: bool | None = True if response.status_code == 200 else None
    if response.status_code == 400:
        message, _, param = _error_message(response)
        if _rejects_summary(message, param):
            summaries = False
            response = await ask({"effort": "low"})
    status = response.status_code
    if status == 200:
        granted = (
            "reasoning summaries are granted"
            if summaries
            else "reasoning summaries are NOT granted (the organisation is not verified): runs work, "
            "but the stream shows no thinking lines"
        )
        return {
            "ok": True,
            "detail": f"Key accepted; {model} answered; {granted}.",
            "model_access": True,
            "reasoning_summaries": summaries,
        }
    message, code, _ = _error_message(response)
    result: dict[str, Any] = {"ok": False, "model_access": None, "reasoning_summaries": summaries}
    if status == 401:
        result["detail"] = f"The key was rejected (HTTP 401). {message}"
    elif status in {403, 404} or code == "model_not_found":
        result["model_access"] = False
        result["detail"] = f"The key works but has no access to {model} (HTTP {status}). {message}"
    elif status == 429:
        result["detail"] = f"The key is valid but rate limited or out of quota (HTTP 429). {message}"
    else:
        result["detail"] = f"Unexpected answer (HTTP {status}). {message}"
    return result


async def _check_google(client: httpx.AsyncClient, key: str | None) -> tuple[bool, str]:
    """A Street View metadata request: free of charge, and it reports a bad key in its body."""
    params = {"location": f"{_PROBE_LAT},{_PROBE_LNG}"}
    key = key if key and key_may_go_to(GOOGLE, GOOGLE_METADATA_URL) else None
    # no redirect is followed with a key on board: it stays with the host it was meant for
    response = await client.get(
        GOOGLE_METADATA_URL, params={**params, "key": key} if key else params, follow_redirects=False
    )
    if not key:
        return True, f"Reachable (HTTP {response.status_code}); no key is set, so Google lookups are off."
    message, _, _ = _error_message(response)
    try:
        status = response.json().get("status")
    except (ValueError, AttributeError):
        status = None
    if response.status_code == 200 and status in {"OK", "ZERO_RESULTS"}:
        return True, "Key accepted by Street View metadata."
    return False, f"Key not accepted (HTTP {response.status_code}, {status or 'no status'}). {message}"


async def _check_mapillary(client: httpx.AsyncClient, token: str | None) -> tuple[bool, str]:
    params = {
        "fields": "id",
        "limit": 1,
        "bbox": f"{_PROBE_LNG - 0.001},{_PROBE_LAT - 0.001},{_PROBE_LNG + 0.001},{_PROBE_LAT + 0.001}",
    }
    token = token if token and key_may_go_to(MAPILLARY, MAPILLARY_IMAGES_URL) else None
    headers = {"Authorization": f"OAuth {token}"} if token else {}
    response = await client.get(MAPILLARY_IMAGES_URL, params=params, headers=headers, follow_redirects=False)
    if not token:
        return True, f"Reachable (HTTP {response.status_code}); no token is set, so Mapillary lookups are off."
    if response.status_code == 200:
        return True, "Token accepted."
    message, _, _ = _error_message(response)
    return False, f"Token not accepted (HTTP {response.status_code}). {message}"


async def default_key_tester(name: str, value: str, model: str) -> dict[str, Any]:
    """What `workspace.key_tester` is when nobody injected one: a real request to the provider.
    The OpenAI test is the only request in this module that costs money (a few tokens)."""
    async with make_probe_client(Settings()) as client:
        if name == OPENAI:
            return await _test_openai(client, value, model)
        ok, detail = await (_check_google(client, value) if name == GOOGLE else _check_mapillary(client, value))
        return {"ok": ok, "detail": detail}


async def run_key_test(workspace: "Workspace", name: str) -> dict[str, Any]:
    """Try the stored key `name` against its provider and record what the OpenAI one answered.

    The tester is `workspace.key_tester(name, value, model)` (sync or async, returning at least
    `ok` and `detail`); whatever it returns or raises is redacted before it leaves."""
    value = os.environ.get(name)
    if not value:
        return {"ok": False, "detail": f"{name} is not set.", "latency_ms": None}
    tester: KeyTester = workspace.key_tester or default_key_tester
    started = time.monotonic()
    try:
        result = tester(name, value, workspace.build_settings().model)
        if isinstance(result, Awaitable):
            result = await asyncio.wait_for(result, 2 * KEY_TEST_TIMEOUT_S + PROBE_TIMEOUT_S)
        result = dict(result)
    except asyncio.TimeoutError:
        result = {"ok": False, "detail": "No answer in time; check the connection and try again."}
    except Exception as exc:  # the provider boundary: DNS, TLS, a tester that broke
        result = {"ok": False, "detail": f"The test could not be made: {type(exc).__name__}: {exc}"}
    out: dict[str, Any] = {
        "ok": result.get("ok") is True,
        "detail": redact(result.get("detail") or "", extra=(value,)),
        "latency_ms": round((time.monotonic() - started) * 1000),
    }
    for extra in ("model_access", "reasoning_summaries"):
        if isinstance(result.get(extra), bool):
            out[extra] = result[extra]
    if name == OPENAI:
        workspace.set_health(openai=out["ok"])
    return out


# ---------------------------------------------------------------------------------------------
# reachability


@dataclass(frozen=True)
class Service:
    name: str
    url: str
    check: Check
    public: bool = False  # needs no key: answering at all means the internet is there
    keyed: bool = False  # a provider that takes one of the three keys


def _answers(url: str, params: dict[str, Any] | None = None) -> Check:
    async def check(client: httpx.AsyncClient) -> tuple[bool, str]:
        response = await client.get(url, params=params)
        return response.status_code < 400, f"HTTP {response.status_code}"

    return check


def _openai_models(model: str) -> Check:
    """A model lookup costs nothing and answers both questions: reachable, and may this key use
    the model new runs are launched with."""

    async def check(client: httpx.AsyncClient) -> tuple[bool | None, str]:
        base, headers = _openai_request()
        key = os.environ.get(OPENAI)
        own = key_may_go_to(OPENAI, base)
        if key and own:
            headers["Authorization"] = f"Bearer {key}"
        else:
            # the organisation and project ids say whose account this is: they travel with the key
            headers = {}
        response = await client.get(f"{base}/models/{model}", headers=headers, follow_redirects=False)
        status = response.status_code
        if not key:
            return False, f"Reachable (HTTP {status}), but {OPENAI} is not set."
        if not own:
            # neither working nor failing: a run sends the key there itself, this look did not
            return None, (
                f"Reachable (HTTP {status}). The key was not sent: OPENAI_BASE_URL is not OpenAI's own "
                "address, and this check sends a key only to its provider. Use Test on the key to try it there."
            )
        if status == 200:
            return True, f"{model} is available to this key."
        if status == 401:
            return False, "Reachable, but the key was rejected (HTTP 401)."
        if status in {403, 404}:
            return False, f"Reachable, but this key has no access to {model} (HTTP {status})."
        return False, f"HTTP {status}"

    return check


def services(settings: Settings) -> list[Service]:
    """What a run depends on, in the order of UI-SPEC 5.10. Each check is one cheap GET."""
    base, _ = _openai_request()
    nominatim = settings.nominatim_url.rstrip("/")
    photon = settings.photon_url.rstrip("/")
    # the MapServer's own description: the export endpoint without a bounding box is an error
    esri = settings.esri_export_url.removesuffix("/export")
    out = [
        Service("OpenAI", base, _openai_models(settings.model), keyed=True),
        Service("Nominatim", nominatim, _answers(f"{nominatim}/status", {"format": "json"}), public=True),
        Service("Photon", photon, _answers(f"{photon}/api", {"q": "Lisboa", "limit": 1}), public=True),
    ]
    for number, url in enumerate(settings.overpass_urls, start=1):
        status_url = url.removesuffix("/interpreter") + "/status" if url.endswith("/interpreter") else url
        out.append(Service(f"Overpass {number}", url, _answers(status_url), public=True))
    out += [
        Service("Esri imagery", esri, _answers(esri, {"f": "json"}), public=True),
        Service(
            "Google", GOOGLE_METADATA_URL, lambda client: _check_google(client, os.environ.get(GOOGLE)), keyed=True
        ),
        Service(
            "Mapillary",
            MAPILLARY_IMAGES_URL,
            lambda client: _check_mapillary(client, os.environ.get(MAPILLARY)),
            keyed=True,
        ),
    ]
    return out


async def _probe(client: httpx.AsyncClient, service: Service) -> dict[str, Any]:
    started = time.monotonic()
    ok: bool | None = False
    latency_ms = None
    try:
        # httpx times each phase separately; this caps the whole exchange
        ok, detail = await asyncio.wait_for(service.check(client), PROBE_TIMEOUT_S)
        latency_ms = round((time.monotonic() - started) * 1000)
    except asyncio.TimeoutError:
        detail = f"No answer within {PROBE_TIMEOUT_S:g} s."
    except Exception as exc:  # DNS, TLS, refused, a body that is not what the service sends
        detail = f"Not reachable: {type(exc).__name__}: {exc}"
    return {
        "name": service.name,
        "url": redact(service.url),
        "ok": ok,
        "latency_ms": latency_ms,
        "detail": redact(detail)[:300],
        "checked": True,
    }


def _not_checked(service: Service, why: str) -> dict[str, Any]:
    """The row of a service that was left alone: `ok` is unknown, not false."""
    return {
        "name": service.name,
        "url": redact(service.url),
        "ok": None,
        "latency_ms": None,
        "detail": why,
        "checked": False,
    }


async def _probe_all(workspace: "Workspace") -> dict[str, Any]:
    settings = workspace.build_settings()
    wanted = services(settings)
    # Under the scripted model no run uses a key, so no provider that takes one is contacted:
    # a rehearsal must not touch the account, and a demo laptop may hold no working key at all.
    skipped = {service.name for service in wanted if service.keyed and workspace.fake_model}
    async with make_probe_client(settings) as client:
        probed = await asyncio.gather(*(_probe(client, s) for s in wanted if s.name not in skipped))
    answers = iter(probed)
    rows = [_not_checked(s, NOT_CHECKED_DEMO) if s.name in skipped else next(answers) for s in wanted]
    result = {"services": rows, "checked_at": _now()}
    _recent[workspace] = (time.monotonic(), result)
    openai_row = rows[0]
    workspace.set_health(
        # without a key, or without a look, there is nothing to say about it
        openai=openai_row["ok"] if openai_row["checked"] and os.environ.get(OPENAI) else None,
        internet=any(row["ok"] is True for service, row in zip(wanted, rows) if service.public),
    )
    return result


async def check_services(workspace: "Workspace", *, refresh: bool = False) -> dict[str, Any]:
    """`{services, checked_at}`: every service probed at once, and the header chips updated from
    what came back. A result younger than PROBE_TTL_S is reused unless `refresh`, and callers
    that arrive while a round is in flight share that round: opening the console in several tabs
    is one request to each service, not one per tab."""
    running = _probing.get(workspace)
    if running is not None and not running.done():
        return await asyncio.shield(running)
    recent = _recent.get(workspace)
    if recent is not None and not refresh and time.monotonic() - recent[0] < PROBE_TTL_S:
        return recent[1]
    task = asyncio.ensure_future(_probe_all(workspace))
    _probing[workspace] = task
    try:
        return await asyncio.shield(task)
    finally:
        if task.done():
            _probing.pop(workspace, None)


# ---------------------------------------------------------------------------------------------
# disk, version, cache


def tree_bytes(path: str | Path) -> int:
    """Bytes of the files under `path` (0 when it does not exist). Links are not followed."""
    total = 0
    stack = [str(path)]
    while stack:
        try:
            with os.scandir(stack.pop()) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def _free_bytes(path: Path) -> int | None:
    """Free space where `path` is or will be: the nearest directory that exists."""
    for candidate in (path.absolute(), *path.absolute().parents):
        try:
            return shutil.disk_usage(candidate).free
        except OSError:
            continue
    return None


def http_cache_dir(workspace: "Workspace") -> Path:
    return http_cache(workspace.base_settings).dir


def disk(workspace: "Workspace") -> dict[str, Any]:
    """Blocking: walks the three directories."""
    return {
        "runs_bytes": tree_bytes(workspace.runs_dir),
        "uploads_bytes": tree_bytes(workspace.sets.root),
        "cache_bytes": tree_bytes(http_cache_dir(workspace)),
        "free_bytes": _free_bytes(Path(workspace.runs_dir)),
    }


def version(workspace: "Workspace") -> dict[str, Any]:
    """Blocking the first time (git)."""
    return {
        "git_sha": git_sha(),
        "model": workspace.build_settings().model,
        "sdk": f"openai {openai.__version__}",
        "python": platform.python_version(),
    }


def clear_http_cache(workspace: "Workspace") -> int:
    """Delete the cached HTTP responses and return the bytes freed. Blocking.

    Only `<cache_dir>/http`: previews and anything else under the cache directory stay. Safe
    under a running tool call: the cache treats a file that vanished as a miss and a failed write
    as nothing to keep."""
    target = http_cache_dir(workspace)
    if target.is_symlink():
        raise PermissionError("the HTTP cache directory is a link; remove it by hand")
    try:
        target = confine(target, workspace.cache_dir)
    except FileNotFoundError:
        return 0
    before = tree_bytes(target)
    shutil.rmtree(target, ignore_errors=True)
    return before - tree_bytes(target)


async def report(workspace: "Workspace", *, refresh: bool = False) -> dict[str, Any]:
    """`GET /api/health`."""
    probed, sizes, build = await asyncio.gather(
        check_services(workspace, refresh=refresh),
        asyncio.to_thread(disk, workspace),
        asyncio.to_thread(version, workspace),
    )
    return {**probed, "window": workspace.metrics_window(), "disk": sizes, "version": build}
