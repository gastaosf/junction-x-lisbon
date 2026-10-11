"""The console app: one long-lived server for every run of the workspace (UI-SPEC section 8).

`create_console_app(workspace)` puts together the security middleware, the API routers, the
static files, the single-page app (every non-API GET gets its index.html, so a reload on any
screen lands in the same place) and, under `/legacy/<run_id>/`, the old operator page for a run
of this process.

Nothing here depends on lifespan events: tests drive the app through `httpx.ASGITransport`,
which sends none. The event stream is exposed as `app.state.stream` for the same reason: that
transport buffers a whole response, so a never-ending one can only be tested as a generator.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import re
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse, Response
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.routing import Route
from starlette.staticfiles import StaticFiles
from starlette.types import Message, Receive, Scope, Send

from .app import STATIC_DIR, create_app
from .hub import CLOSED
from .middleware import (
    CONTENT_SECURITY_POLICY,
    CSP_HEADER,
    SecurityMiddleware,
    SecurityPolicy,
    lan_address,
)
from .routes import dumps, error_detail, evalapi, http_error, json_body, launch, refuse, replay, reply, runs
from .routes import sets as sets_routes
from .routes import settings as settings_routes
from .routes import submission
from .security import safe_id
from .sets import ConsoleError
from .workspace import RunHandle, Workspace

CONSOLE_INDEX = STATIC_DIR / "console" / "index.html"
LEGACY_INDEX = STATIC_DIR / "index.html"
PING_S = 10.0
_LEGACY_LINT_KEYS = ("ok", "problems", "char_count", "max_chars", "multiplier_before", "multiplier_after")
# The legacy page's two actions that fix an answer while the agent may still be working on it.
_LEGACY_FINAL_RE = re.compile(r"^api/pano/([^/]+)/(?:finalize|geocode)$")
_INLINE_SCRIPT_RE = re.compile(r"<script>(.*?)</script>", re.DOTALL)
_SCOPE_OF_PARENT = ("app", "router", "endpoint", "route", "path_params")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _sse(event: str, payload: Any) -> str:
    return f"event: {event}\ndata: {dumps(payload)}\n\n"


class _RevalidatedStatic(StaticFiles):
    """Static files the browser must ask about every time (answered 304 when unchanged): a
    module cached from before an update would run against a newer server."""

    def file_response(self, *args: Any, **kwargs: Any) -> Response:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


# ---------------------------------------------------------------------------------------------
# legacy page


class _LegacyManager:
    """One run of the workspace, as the manager `server.app.create_app` expects. Sessions are the
    run's own (so the legacy page's three human controls charge the same ledgers); "finalize
    all" and the exports go through the workspace, so both pages and the files stay in step."""

    def __init__(self, workspace: Workspace, handle: RunHandle) -> None:
        self._workspace = workspace
        self._handle = handle
        self.run_id = handle.run_id
        self.settings = handle.settings
        self.live = handle.manager.live

    @property
    def sessions(self) -> dict[str, Any]:
        return self._handle.manager.sessions

    def snapshot(self) -> dict[str, Any]:
        return self._handle.manager.snapshot()

    def finalize_all(self, reason: str) -> Any:
        return self._workspace.finalize_all(self.run_id)  # awaited by the legacy app

    def export_all(self) -> Any:
        async def export() -> list[Path]:
            return [Path(path) for path in (await self._workspace.export_now(self.run_id))["files"]]

        return export()  # the legacy app awaits what its worker thread hands back


def _legacy_handle(workspace: Workspace, run_id: str) -> RunHandle | None:
    """The run the legacy page may operate: one of this process, and never an evaluation run
    (its page has the human controls, and truth must not meet them)."""
    try:
        handle = workspace.owned(safe_id(run_id, "run id"))
    except ValueError:
        return None
    return None if handle is None or handle.kind == "eval" else handle


_legacy_csp_cache: tuple[int, str] | None = None


def _legacy_csp() -> str:
    """The console's policy, plus the hash of the legacy page's one inline script: the page is a
    single file and must keep working, but nothing else inline may run under this origin."""
    global _legacy_csp_cache
    stamp = LEGACY_INDEX.stat().st_mtime_ns
    if _legacy_csp_cache is None or _legacy_csp_cache[0] != stamp:
        html = LEGACY_INDEX.read_text(encoding="utf-8")
        digests = [hashlib.sha256(script.encode("utf-8")).digest() for script in _INLINE_SCRIPT_RE.findall(html)]
        allowed = " ".join(f"'sha256-{base64.b64encode(digest).decode()}'" for digest in digests)
        policy = CONTENT_SECURITY_POLICY.replace("script-src 'self'", f"script-src 'self' {allowed}".rstrip())
        _legacy_csp_cache = (stamp, policy)
    return _legacy_csp_cache[1]


class _LegacyDispatch:
    """`/legacy/<run_id>/<rest>` handed to the legacy app of that run, as if it were served at
    `/`. The sub-app is made once per RunHandle and kept on it, because `create_app` holds
    per-app state and must die with the sessions it points at (a reused run id gets a new one)."""

    def __init__(self, workspace: Workspace) -> None:
        self.workspace = workspace

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        params = scope.get("path_params") or {}
        run_id, rest = str(params.get("run_id", "")), str(params.get("rest", ""))
        handle = _legacy_handle(self.workspace, run_id)
        if handle is None:
            message = (
                "The legacy page only shows a run this server is holding (and never an evaluation run). "
                "Open the console at / instead."
            )
            await PlainTextResponse(message + "\n", status_code=404)(scope, receive, send)
            return
        if handle.legacy_app is None:
            handle.legacy_app = create_app(_LegacyManager(self.workspace, handle))
        child = {key: value for key, value in scope.items() if key not in _SCOPE_OF_PARENT}
        child.update(path="/" + rest, raw_path=quote("/" + rest).encode("ascii"), root_path="")
        status = 0

        async def relay(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = MutableHeaders(scope=message)
                if headers.get("content-type", "").startswith("text/html"):
                    headers[CSP_HEADER] = _legacy_csp()
            await send(message)

        await handle.legacy_app(child, receive, relay)
        acted = _LEGACY_FINAL_RE.match(rest) if scope["method"] == "POST" and status == 200 else None
        if acted:
            # The legacy handler fixed the answer and wrote the files, but left the conversation
            # running (and spending); end it as the console does, and write the files again.
            try:
                await self.workspace.settle(run_id, acted.group(1))
            except (ConsoleError, KeyError):
                pass


# ---------------------------------------------------------------------------------------------
# the app


def _install_error_handlers(app: FastAPI) -> None:
    """Every refusal in the contract's shape, whatever raised it."""

    @app.exception_handler(ConsoleError)
    async def console_error(request: Request, exc: ConsoleError) -> Response:
        refusal = http_error(exc)
        return reply({"detail": refusal.detail}, refusal.status_code)

    @app.exception_handler(PermissionError)
    async def outside_roots(request: Request, exc: PermissionError) -> Response:
        refusal = http_error(exc)
        return reply({"detail": refusal.detail}, refusal.status_code)

    @app.exception_handler(StarletteHTTPException)
    async def http_exception(request: Request, exc: StarletteHTTPException) -> Response:
        detail = exc.detail
        if not isinstance(detail, dict) or "message" not in detail:
            detail = error_detail(detail if isinstance(detail, str) else dumps(detail))
        return reply({"detail": detail}, exc.status_code, getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError) -> Response:
        problems = [
            ".".join(str(part) for part in error.get("loc", ())) + ": " + str(error.get("msg", "invalid"))
            for error in exc.errors()
        ]
        detail = error_detail(
            "The request is not valid: " + "; ".join(problems) + ".", code="invalid_request", problems=problems
        )
        return reply({"detail": detail}, 422)


def create_console_app(
    workspace: Workspace, *, port: int = 8000, ping_s: float = PING_S, lan_host: str | None = None
) -> FastAPI:
    """The console for `workspace`, to be served on `port` (the port is part of the names and
    origins the app answers to). `lan_host` is this machine's LAN address when LAN access is on;
    by default it is looked up."""
    app = FastAPI(title="astrolabio console", docs_url=None, redoc_url=None, openapi_url=None)
    lan = workspace.store.lan()  # read once: a change in Settings needs a restart
    if lan["enabled"] and lan_host is None:
        lan_host = lan_address()
    policy = SecurityPolicy.for_server(port, lan_token=lan["token"] if lan["enabled"] else None, lan_host=lan_host)
    app.state.workspace = workspace
    app.state.port = port
    app.state.lan = bool(lan["enabled"])
    app.state.lan_host = lan_host if lan["enabled"] else None
    app.state.policy = policy
    app.add_middleware(SecurityMiddleware, policy=policy)
    _install_error_handlers(app)

    def stream_factory(*, ping_s: float = ping_s) -> AsyncIterator[str]:
        """The exact frames of `GET /api/stream`: a snapshot, then every hub message in seq
        order, and a ping when `ping_s` has passed without one."""

        async def frames() -> AsyncIterator[str]:
            loop = asyncio.get_running_loop()
            # one synchronous step: the first message in the queue is snapshot.seq + 1
            snapshot, queue = workspace.subscribe()
            last = snapshot["seq"]
            try:
                yield _sse("snapshot", snapshot)
                next_ping = loop.time() + ping_s
                while True:
                    try:
                        message = await asyncio.wait_for(queue.get(), max(0.0, next_ping - loop.time()))
                    except asyncio.TimeoutError:
                        message = None
                    else:
                        if message is CLOSED:
                            return  # fell a whole queue behind: the tab reconnects for a new snapshot
                        last = message["seq"]
                        yield _sse("msg", message)
                    if message is None or loop.time() >= next_ping:
                        yield _sse("ping", {"seq": last, "server_time": _now()})
                        next_ping = loop.time() + ping_s
            finally:
                workspace.hub.unsubscribe(queue)

        return frames()

    app.state.stream = stream_factory

    for module in (runs, sets_routes, launch, replay, submission, evalapi, settings_routes):
        app.include_router(module.router)

    app.mount("/static", _RevalidatedStatic(directory=STATIC_DIR), name="static")

    # ---- legacy page ---------------------------------------------------------------------------

    @app.post("/legacy/{run_id}/api/pano/{panorama_id}/cue/lint")
    async def legacy_lint(request: Request, run_id: str, panorama_id: str) -> Response:
        """Ahead of the legacy app's own route, whose dry run writes a `human_cue_rejected` event
        for a failed check: from either page, checking a cue leaves no trace."""
        handle = _legacy_handle(workspace, run_id)
        session = handle.manager.sessions.get(panorama_id) if handle is not None else None
        if session is None:
            raise refuse(404, f"unknown panorama {panorama_id!r}", code="unknown_panorama")
        if handle.settings.no_human or session.settings.no_human:
            raise refuse(403, "human channels are disabled (--no-human)", code="human_channels_off")
        verdict = session.check_cue((await json_body(request)).get("text"))
        return reply({key: verdict[key] for key in _LEGACY_LINT_KEYS})

    @app.get("/legacy")
    @app.get("/legacy/")
    async def legacy_latest() -> Response:
        newest = next((h for h in reversed(list(workspace.handles.values())) if h.kind != "eval"), None)
        if newest is None:
            text = "No run is going in this server yet: launch one from the console (/new) first.\n"
            return PlainTextResponse(text, status_code=404)
        return RedirectResponse(f"/legacy/{newest.run_id}/")

    @app.get("/legacy/{run_id}")
    async def legacy_slash(run_id: str) -> Response:
        # the page's URLs are relative ("api/state"): without the slash they would miss the run id
        if _legacy_handle(workspace, run_id) is None:
            return PlainTextResponse("No such run in this server.\n", status_code=404)
        return RedirectResponse(f"/legacy/{run_id}/")

    app.router.routes.append(Route("/legacy/{run_id}/{rest:path}", endpoint=_LegacyDispatch(workspace)))

    # ---- the single-page app -------------------------------------------------------------------

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> Response:
        if path == "api" or path.startswith("api/"):
            raise refuse(404, f"There is no /{path} in this API.", code="not_found")
        if not CONSOLE_INDEX.is_file():
            text = (
                "The astrolabio server is running, but the console page is missing "
                f"({CONSOLE_INDEX}).\nRestore server/static/console/ from the repository; meanwhile the API "
                "under /api/ and the old page under /legacy answer.\n"
            )
            return PlainTextResponse(text, status_code=503)
        # revalidated on every load: the page is the entry point to whatever version is on disk
        return FileResponse(CONSOLE_INDEX, media_type="text/html", headers={"Cache-Control": "no-cache"})

    return app
