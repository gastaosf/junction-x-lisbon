"""What stands between a browser and the console: who may talk to it, and what every answer carries.

The console drives paid runs and penalised controls from a page on localhost, so any other page
open in the same browser is the attacker to plan for. Four checks, in this order:

1. `Host` must be one of the names this server was started under, port included (421). That is
   what stops DNS rebinding: a hostile name that resolves to 127.0.0.1 still sends its own Host.
2. With LAN access on, every request needs the shared token (cookie or header).
3. A state-changing request is refused when its `Origin` is not the console's own, or when the
   browser says it did not come from the console's own pages (403).
4. A request body must be declared as JSON (415), which a cross-site form cannot do without a
   preflight; the one raw-body route is the file upload.

The checks are pure functions; `SecurityMiddleware` applies them and adds the response headers.
No `Access-Control-Allow-*` header is ever sent and no CORS middleware may be installed.
"""

from __future__ import annotations

import hmac
import ipaddress
import json
import re
import socket
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

LOOPBACK_HOSTS: tuple[str, ...] = ("127.0.0.1", "localhost", "[::1]")
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
TOKEN_COOKIE = "astrolabio_token"
TOKEN_HEADER = "x-astrolabio-token"
TOKEN_PARAM = "token"
# The file upload: its body is the file, byte for byte.
RAW_BODY_ROUTES: tuple[tuple[str, re.Pattern[str]], ...] = (("PUT", re.compile(r"^/api/sets/[^/]+/files$")),)

# Map tiles are the only thing a page may fetch from elsewhere. The bare tile.openstreetmap.org
# is the address OpenStreetMap asks clients to use; the wildcard covers its older a/b/c mirrors.
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org "
    "https://server.arcgisonline.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
    "form-action 'self'"
)
SECURITY_HEADERS: tuple[tuple[str, str], ...] = (
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
)
CSP_HEADER = "Content-Security-Policy"


# ---------------------------------------------------------------------------------------------
# the checks


def is_loopback(host: str) -> bool:
    """True for an address a server can bind without being reachable from another machine."""
    name = host.strip().strip("[]").lower()
    if name == "localhost":
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False


def lan_address() -> str | None:
    """This machine's address on the local network, or None. Nothing is sent: connecting a UDP
    socket only asks the kernel which interface it would route through."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        address = probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()
    return None if is_loopback(address) or address == "0.0.0.0" else address


def allowed_hosts(port: int, lan_host: str | None = None) -> frozenset[str]:
    """Every `Host` value the console answers to. The port is part of the name: a page served
    from localhost:3000 is another origin and must not pass as ours."""
    names = [*LOOPBACK_HOSTS, *([lan_host] if lan_host else [])]
    hosts = {f"{name}:{port}" for name in names}
    if port == 80:
        hosts |= set(names)  # a browser leaves the default port out
    return frozenset(host.lower() for host in hosts)


def allowed_origins(hosts: Iterable[str]) -> frozenset[str]:
    return frozenset(f"http://{host}" for host in hosts)


def host_allowed(host: str | None, hosts: Iterable[str]) -> bool:
    return host is not None and host.strip().lower() in hosts


def origin_problem(method: str, origin: str | None, fetch_site: str | None, origins: Iterable[str]) -> str | None:
    """Why a request may not change anything, or None. A request with neither header (curl, a
    test, the CLI) passes: only a browser can be tricked into sending one, and a browser says
    where it came from."""
    if method.upper() not in UNSAFE_METHODS:
        return None
    if origin is not None and origin.strip().lower() not in origins:
        return "its Origin is not this console"
    if fetch_site is not None and fetch_site.strip().lower() not in {"same-origin", "none"}:
        return "the browser reports it as coming from another site"
    return None


def has_body(headers: Mapping[str, str]) -> bool:
    length = (headers.get("content-length") or "").strip()
    return "transfer-encoding" in headers or (length.isdigit() and int(length) > 0)


def content_type_problem(method: str, path: str, headers: Mapping[str, str]) -> str | None:
    """A body must say it is JSON, except on the upload route."""
    method = method.upper()
    if method not in UNSAFE_METHODS or not has_body(headers):
        return None
    if any(method == verb and pattern.match(path) for verb, pattern in RAW_BODY_ROUTES):
        return None
    media_type = (headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    return None if media_type == "application/json" else "send the body as Content-Type: application/json"


def token_matches(given: str | None, token: str) -> bool:
    return isinstance(given, str) and hmac.compare_digest(given.encode(), token.encode())


def cookie_value(header: str | None, name: str) -> str | None:
    for part in (header or "").split(";"):
        key, _, value = part.strip().partition("=")
        if key == name:
            return value
    return None


@dataclass(frozen=True)
class SecurityPolicy:
    """What this server answers to, fixed when it starts. `token` is None while LAN access is off."""

    hosts: frozenset[str]
    origins: frozenset[str]
    token: str | None = None

    @classmethod
    def for_server(cls, port: int, *, lan_token: str | None = None, lan_host: str | None = None) -> "SecurityPolicy":
        hosts = allowed_hosts(port, lan_host if lan_token else None)
        return cls(hosts=hosts, origins=allowed_origins(hosts), token=lan_token or None)


# ---------------------------------------------------------------------------------------------
# the middleware


def _is_api(path: str) -> bool:
    """The console's API and the legacy page's (`/legacy/<run_id>/api/...`) answer in JSON."""
    return "/api/" in path


class SecurityMiddleware:
    """Pure ASGI (no BaseHTTPMiddleware): the event stream must pass through unbuffered."""

    def __init__(self, app: ASGIApp, *, policy: SecurityPolicy) -> None:
        self.app = app
        self.policy = policy

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        policy, headers = self.policy, Headers(scope=scope)
        method, path = str(scope["method"]).upper(), str(scope["path"])

        if not host_allowed(headers.get("host"), policy.hosts):
            await self._refuse(
                send,
                path,
                421,
                "wrong_host",
                "This console only answers under its own address. Open it at the URL the server printed "
                "when it started.",
            )
            return
        if policy.token is not None:
            query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
            offered = (query.get(TOKEN_PARAM) or [None])[0]
            if method == "GET" and path == "/" and offered is not None:
                # The join link: trade the token in the URL for a cookie, and get it out of the
                # address bar and the history at once.
                if token_matches(offered, policy.token):
                    cookie = f"{TOKEN_COOKIE}={policy.token}; HttpOnly; SameSite=Strict; Path=/"
                    await self._send(send, 303, b"", [("Location", "/"), ("Set-Cookie", cookie)])
                else:
                    await self._refuse(send, path, 403, "wrong_token", "That join link is not valid (any more).")
                return
            given = headers.get(TOKEN_HEADER) or cookie_value(headers.get("cookie"), TOKEN_COOKIE)
            if not token_matches(given, policy.token):
                await self._refuse(
                    send,
                    path,
                    401,
                    "token_required",
                    "This console is shared on the local network and needs its join link: open the link "
                    "printed on the server's terminal (or shown under Settings on the server itself).",
                )
                return
        problem = origin_problem(method, headers.get("origin"), headers.get("sec-fetch-site"), policy.origins)
        if problem:
            await self._refuse(
                send,
                path,
                403,
                "forbidden_origin",
                f"This request was refused because {problem}. Use the console's own page to do this.",
            )
            return
        problem = content_type_problem(method, path, headers)
        if problem:
            await self._refuse(send, path, 415, "unsupported_media_type", f"The request was refused: {problem}.")
            return

        started = False

        async def send_with_headers(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                _add_headers(MutableHeaders(scope=message))
            await send(message)

        try:
            await self.app(scope, receive, send_with_headers)
        except Exception as exc:
            if not started:
                # Answer in the API's own error shape, then let the failure travel on to be logged.
                await self._refuse(
                    send,
                    path,
                    500,
                    "internal_error",
                    f"The server failed ({type(exc).__name__}). Look at the terminal running `cli.py serve`, "
                    "then try again.",
                    api=True,
                )
            raise

    async def _refuse(
        self, send: Send, path: str, status: int, code: str, message: str, *, api: bool | None = None
    ) -> None:
        if _is_api(path) if api is None else api:
            detail = {"message": message, "code": code, "action": None, "problems": None}
            body = json.dumps({"detail": detail}).encode()
            await self._send(send, status, body, [("Content-Type", "application/json")])
        else:
            await self._send(send, status, (message + "\n").encode(), [("Content-Type", "text/plain; charset=utf-8")])

    @staticmethod
    async def _send(send: Send, status: int, body: bytes, extra: list[tuple[str, str]]) -> None:
        message: dict[str, Any] = {"type": "http.response.start", "status": status, "headers": []}
        headers = MutableHeaders(scope=message)
        for name, value in extra:
            headers.append(name, value)
        headers["Content-Length"] = str(len(body))
        headers["Cache-Control"] = "no-store"
        _add_headers(headers)
        await send(message)
        await send({"type": "http.response.body", "body": body})


def _add_headers(headers: MutableHeaders) -> None:
    for name, value in SECURITY_HEADERS:
        headers[name] = value
    # the legacy page brings its own policy (one inline script, allowed by its hash)
    if CSP_HEADER not in headers:
        headers[CSP_HEADER] = CONTENT_SECURITY_POLICY
