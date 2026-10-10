"""HTTP plumbing shared by the external tools: disk cache, throttling, retries, image helpers.

Nothing in here raises for network trouble. A failed request comes back as a CachedResponse with
status 0 and the error text as its body, so every tool can turn it into an is_error result.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import time
import weakref
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Mapping
from urllib.parse import urlencode, urlsplit

import cv2
import httpx
import numpy as np

if TYPE_CHECKING:
    from ..config import Settings
    from .base import ToolContext

SECRET_PARAMS = frozenset({"key", "access_token", "token", "api_key"})
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
BACKOFF_BASE_S = 1.0
MAX_RETRY_AFTER_S = 10.0
DEFAULT_TIMEOUT_S = 20.0
MAX_IMAGE_SIDE = 2000
JPEG_QUALITY = 90

RequestData = Mapping[str, Any] | str | bytes | None


@dataclass
class CachedResponse:
    status: int  # 0 = the request never produced an HTTP response; content holds the error text
    content: bytes
    headers: dict[str, str] = field(default_factory=dict)
    from_cache: bool = False
    url: str = ""  # secrets redacted, safe for the event log

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", "replace")

    def json(self) -> Any:
        """Parsed body, or None when it is not JSON."""
        try:
            return json.loads(self.content)
        except ValueError:
            return None

    def describe_failure(self) -> str:
        if self.status == 0:
            return f"network error ({self.text[:200]})"
        return f"HTTP {self.status}"


class DiskCache:
    """Response cache: <dir>/<k[:2]>/<k>.bin (body) + <k>.json (status, headers, url)."""

    def __init__(self, directory: Path) -> None:
        self.dir = Path(directory)

    @staticmethod
    def key(method: str, url: str, params: Mapping[str, Any] | None = None, data: RequestData = None) -> str:
        body = sorted(data.items()) if isinstance(data, Mapping) else data
        canonical = json.dumps(
            [method.upper(), url, sorted((params or {}).items()), body], default=str, ensure_ascii=False
        )
        return hashlib.sha256(canonical.encode()).hexdigest()

    def _paths(self, key: str) -> tuple[Path, Path]:
        base = self.dir / key[:2] / key
        return base.with_suffix(".bin"), base.with_suffix(".json")

    def get(self, key: str) -> CachedResponse | None:
        body_path, meta_path = self._paths(key)
        try:
            meta = json.loads(meta_path.read_text())
            content = body_path.read_bytes()
        except (OSError, ValueError):
            return None
        return CachedResponse(meta["status"], content, meta.get("headers", {}), from_cache=True, url=meta.get("url", ""))

    def set(self, key: str, response: CachedResponse) -> None:
        body_path, meta_path = self._paths(key)
        meta = {"status": response.status, "headers": response.headers, "url": response.url}
        try:
            body_path.parent.mkdir(parents=True, exist_ok=True)
            # The meta file is written last, so a reader never sees a meta without its body.
            _atomic_write(body_path, response.content)
            _atomic_write(meta_path, json.dumps(meta).encode())
        except OSError:
            pass  # a read-only or full disk must not fail the tool call


def _atomic_write(path: Path, payload: bytes) -> None:
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    tmp.write_bytes(payload)
    os.replace(tmp, path)


def http_cache(settings: "Settings") -> DiskCache:
    return DiskCache(Path(settings.cache_dir) / "http")


def make_http_client(settings: "Settings") -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=settings.http_timeout_s,
        headers={"User-Agent": settings.user_agent},
        follow_redirects=True,
    )


def redact_url(url: str, params: Mapping[str, Any] | None = None) -> str:
    if not params:
        return url
    shown = {k: ("REDACTED" if k in SECRET_PARAMS else v) for k, v in params.items()}
    return f"{url}?{urlencode(shown)}"


# asyncio primitives bind to the loop that first contends on them, so the "global" semaphore is
# one per event loop (the run has a single loop; tests create one per test).
_osm_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary()
)


def osm_semaphore(settings: "Settings | None" = None) -> asyncio.Semaphore:
    """The shared limiter for Nominatim and Overpass (settings.osm_concurrency slots)."""
    loop = asyncio.get_running_loop()
    semaphore = _osm_semaphores.get(loop)
    if semaphore is None:
        if settings is None:
            from ..config import get_settings

            settings = get_settings()
        semaphore = _osm_semaphores[loop] = asyncio.Semaphore(settings.osm_concurrency)
    return semaphore


_next_slot: dict[str, float] = {}  # host -> monotonic time of the next allowed request


async def _pause(seconds: float) -> None:
    if seconds > 0:
        await asyncio.sleep(seconds)


async def _throttle(host: str, min_interval_s: float) -> None:
    """Space requests to one host. The slot is reserved before sleeping, so concurrent callers
    queue up min_interval_s apart instead of all waking at once."""
    if min_interval_s <= 0:
        return
    now = time.monotonic()
    slot = max(now, _next_slot.get(host, 0.0))
    _next_slot[host] = slot + min_interval_s
    await _pause(slot - now)


def _retry_delay(attempt: int, response: CachedResponse) -> float:
    delay = BACKOFF_BASE_S * 2**attempt
    try:
        retry_after = float(response.headers.get("retry-after", ""))
    except ValueError:
        return delay
    return max(delay, min(retry_after, MAX_RETRY_AFTER_S))


async def _attempt(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    params: Mapping[str, Any] | None,
    data: RequestData,
    headers: Mapping[str, str] | None,
    semaphore: asyncio.Semaphore | None,
    min_interval_s: float,
    timeout: float,
    shown_url: str,
) -> CachedResponse:
    body: dict[str, Any] = {"content": data} if isinstance(data, (str, bytes)) else {"data": data}
    try:
        await _throttle(urlsplit(url).netloc, min_interval_s)
        async with semaphore or contextlib.nullcontext():
            response = await client.request(method, url, params=params, headers=headers, timeout=timeout, **body)
    except Exception as exc:  # tool boundary: timeouts, DNS, TLS, malformed URLs all become status 0
        return CachedResponse(0, f"{type(exc).__name__}: {exc}".encode(), url=shown_url)
    kept = {k.lower(): v for k, v in response.headers.items() if k.lower() in {"content-type", "retry-after"}}
    return CachedResponse(response.status_code, response.content, kept, url=shown_url)


async def fetch(
    ctx_or_client: "ToolContext | httpx.AsyncClient",
    method: str,
    url: str,
    *,
    params: Mapping[str, Any] | None = None,
    data: RequestData = None,
    headers: Mapping[str, str] | None = None,
    cache: DiskCache | None = None,
    semaphore: asyncio.Semaphore | None = None,
    min_interval_s: float = 0.0,
    retries: int = 2,
    timeout: float | None = None,
    should_cache: Callable[[CachedResponse], bool] | None = None,
) -> CachedResponse:
    """One cached, throttled, retried request. Only HTTP 200 responses are cached; should_cache
    can veto (e.g. an Overpass 200 that carries a runtime-error remark)."""
    shown_url = redact_url(url, params)
    key = DiskCache.key(method, url, params, data)
    if cache is not None and (hit := cache.get(key)) is not None:
        return hit

    if isinstance(ctx_or_client, httpx.AsyncClient):
        client, default_timeout = ctx_or_client, DEFAULT_TIMEOUT_S
    else:
        client, default_timeout = ctx_or_client.http, ctx_or_client.settings.http_timeout_s
    if client is None:
        return CachedResponse(0, b"web access is disabled (ALLOW_WEB=false)", url=shown_url)

    response = CachedResponse(0, b"no attempt made", url=shown_url)
    for attempt in range(max(0, retries) + 1):
        if attempt:
            await _pause(_retry_delay(attempt - 1, response))
        response = await _attempt(
            client,
            method,
            url,
            params=params,
            data=data,
            headers=headers,
            semaphore=semaphore,
            min_interval_s=min_interval_s,
            timeout=default_timeout if timeout is None else timeout,
            shown_url=shown_url,
        )
        if response.status != 0 and response.status not in RETRY_STATUSES:
            break

    if cache is not None and response.status == 200 and (should_cache is None or should_cache(response)):
        cache.set(key, response)
    return response


# --- images returned to the model -------------------------------------------------------------


def decode_image(content: bytes) -> np.ndarray | None:
    """BGR pixels, or None when the bytes are not an image (APIs answer errors with JSON/HTML)."""
    if not content:
        return None
    return cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)


def is_image(response: CachedResponse) -> bool:
    """should_cache predicate for image endpoints, which report some errors as HTTP 200 + JSON."""
    return decode_image(response.content) is not None


def google_settled(response: CachedResponse) -> bool:
    """should_cache predicate for Google JSON APIs: quota and key errors arrive as HTTP 200 and
    must not be replayed from the cache once the key is fixed."""
    body = response.json()
    return isinstance(body, dict) and body.get("status") in {"OK", "ZERO_RESULTS", "NOT_FOUND"}


def encode_jpeg(image: np.ndarray, *, max_side: int = MAX_IMAGE_SIDE) -> bytes:
    """JPEG bytes, downscaled so neither side exceeds max_side (the API's many-image limit)."""
    height, width = image.shape[:2]
    scale = max_side / max(height, width)
    if scale < 1:
        size = (max(1, round(width * scale)), max(1, round(height * scale)))
        image = cv2.resize(image, size, interpolation=cv2.INTER_AREA)
    ok, buffer = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if not ok:
        raise ValueError("JPEG encoding failed")
    return buffer.tobytes()


def image_block(jpeg: bytes) -> dict[str, Any]:
    data = base64.standard_b64encode(jpeg).decode("ascii")
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}}


def store_image(ctx: "ToolContext", jpeg: bytes, **meta: Any) -> dict[str, Any]:
    """Save under the session's image_dir as <sha256>.jpg and return the event-log reference."""
    digest = hashlib.sha256(jpeg).hexdigest()
    image_dir = getattr(ctx.session, "image_dir", None)
    path: str | None = None
    if image_dir is not None:
        target = Path(image_dir) / f"{digest}.jpg"
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                _atomic_write(target, jpeg)
            path = str(target)
        except OSError:
            path = None
    return {"sha256": digest, "path": path, **meta}
