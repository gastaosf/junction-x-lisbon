"""overpass_query: OSM feature search with retry, backoff and a mirror; compact summaries."""

from __future__ import annotations

import asyncio
import html
import re
import time
from typing import Any

from .base import ToolContext, ToolResult
from . import http as _http
from .http import CachedResponse, fetch, http_cache, osm_semaphore

MAX_ELEMENTS = 50
DEFAULT_TIMEOUT_S = 25
# The server-side [timeout] is clamped to the default: a longer one could not finish inside the
# call's total budget below, and would leave no time to try the mirror.
MAX_TIMEOUT_S = 25
HTTP_MARGIN_S = 10.0  # the HTTP timeout must outlast the server-side [timeout]
# Wall-clock ceiling for one tool call across both servers, their retries and the wait for a free
# OSM slot. A turn's tool calls are gathered, so one hung query used to hold the whole turn (and
# one of the two slots Nominatim shares) for up to 280 s.
TOTAL_BUDGET_S = 60.0
MIN_ATTEMPT_S = 5.0  # not worth starting a request with less time than this left
# A 429/502/503/504 that comes back at once is the server shedding load: one more try on the same
# server is cheap. A timeout or a slow failure will repeat itself, so those go straight to the mirror.
FAST_FAILURE_S = 5.0
FAST_RETRY_STATUSES = frozenset({429, 502, 503, 504})
FAST_RETRY_PAUSE_S = 2.0
MAX_TAGS_PER_ELEMENT = 8
RAW_TEXT_LIMIT = 4000

_TIMEOUT_RE = re.compile(r"\[\s*timeout\s*:\s*(\d+)\s*\]", re.I)
_OUT_FORMAT_RE = re.compile(r"\[\s*out\s*:", re.I)
_NUMBER = r"-?\d+(?:\.\d+)?"
_SCOPE_RE = re.compile(
    rf"""
      \[\s*bbox\s*:                                   # global bbox setting
    | \(\s*{_NUMBER}\s*(?:,\s*{_NUMBER}\s*){{3}}\)    # (south,west,north,east) filter
    | \(\s*around\b                                   # (around:r,lat,lng) / (around.set:r)
    | \barea\b                                        # area[...] / (area.name) / map_to_area
    | \(\s*poly\s*:                                   # polygon filter
    | \(\s*(?:id\s*:\s*)?\d+(?:\s*,\s*\d+)*\s*\)      # lookup by id
    """,
    re.I | re.X,
)
_KEY_TAGS = (
    "name", "ref", "int_ref", "amenity", "shop", "tourism", "historic", "man_made", "power",
    "generator:source", "tower:type", "highway", "junction", "railway", "aeroway", "waterway", "natural",
    "water", "landuse", "leisure", "building", "place", "religion", "denomination", "brand", "operator",
    "network", "addr:street", "addr:housenumber", "addr:postcode", "addr:city", "ele", "wikidata",
)  # fmt: skip


def prepare_query(ql: str) -> tuple[str, int]:
    """Validated query and its server-side timeout. Raises ValueError with advice for the model."""
    query = ql.strip()
    if not query:
        raise ValueError("ql is empty.")
    if "{{" in query:
        raise ValueError(
            "Overpass Turbo macros such as {{bbox}} or {{geocodeArea:...}} are not supported by the API. "
            "Write the bbox as (south,west,north,east) or use area[\"ISO3166-2\"=\"PT-11\"]->.a; ... (area.a)."
        )
    timeout_match = _TIMEOUT_RE.search(query)
    if not timeout_match and not _SCOPE_RE.search(query):
        raise ValueError(
            "Query rejected: it has no spatial scope and no [timeout]. Scope it with a bounding box "
            "(south,west,north,east), (around:radius_m,lat,lng) or an area such as "
            "area[\"ISO3166-2\"=\"PT-11\"]->.a; ... (area.a); and start with [out:json][timeout:25];"
        )
    timeout_s = DEFAULT_TIMEOUT_S
    if timeout_match:
        timeout_s = max(1, min(int(timeout_match.group(1)), MAX_TIMEOUT_S))
        query = _TIMEOUT_RE.sub(f"[timeout:{timeout_s}]", query, count=1)
    missing = ("" if _OUT_FORMAT_RE.search(query) else "[out:json]") + (
        "" if timeout_match else f"[timeout:{timeout_s}]"
    )
    if missing:
        # Settings must form one leading statement: extend it if present, else create it.
        query = missing + (query if query.startswith("[") else f";\n{query}")
    return query, timeout_s


def _remark(response: CachedResponse) -> str:
    body = response.json()
    return str(body.get("remark", "")) if isinstance(body, dict) else ""


def _syntax_error(response: CachedResponse) -> str:
    """Overpass answers bad queries with an HTML page; keep only the error lines."""
    found = re.findall(r"<p>(.*?)</p>", response.text, re.S)
    lines = [re.sub(r"<[^>]+>", "", html.unescape(line)).strip() for line in found]
    errors = [line for line in lines if "error" in line.lower()]
    return " ".join(errors or lines)[:800] or response.text[:400]


def _center(element: dict[str, Any]) -> tuple[float, float] | None:
    try:
        return _locate(element)
    except (KeyError, TypeError, ValueError):
        return None


def _locate(element: dict[str, Any]) -> tuple[float, float] | None:
    if "lat" in element and "lon" in element:
        return float(element["lat"]), float(element["lon"])
    if centre := element.get("center"):
        return float(centre["lat"]), float(centre["lon"])
    if bounds := element.get("bounds"):
        return (bounds["minlat"] + bounds["maxlat"]) / 2, (bounds["minlon"] + bounds["maxlon"]) / 2
    points = [p for p in element.get("geometry") or [] if p]
    if points:
        return sum(p["lat"] for p in points) / len(points), sum(p["lon"] for p in points) / len(points)
    return None


def _key_tags(tags: dict[str, Any]) -> list[str]:
    chosen = [k for k in _KEY_TAGS if k in tags] or list(tags)
    return [f"{k}={tags[k]}" for k in chosen[:MAX_TAGS_PER_ELEMENT]]


def summarise_elements(elements: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Text for the model and the matching rows for the log."""
    counts = [e for e in elements if e.get("type") == "count"]
    features = [e for e in elements if e.get("type") != "count"]
    tagged = [e for e in features if e.get("tags")]
    untagged = len(features) - len(tagged)
    lines = [f"count: {', '.join(f'{k}={v}' for k, v in (c.get('tags') or {}).items())}" for c in counts]
    rows: list[dict[str, Any]] = []
    # Untagged elements are member nodes/ways pulled in by recursion; list them only if nothing else came back.
    for i, element in enumerate((tagged or features)[:MAX_ELEMENTS], 1):
        centre = _center(element)
        where = f"{centre[0]:.6f},{centre[1]:.6f}" if centre else "no coordinates (use 'out center;')"
        tags = _key_tags(element.get("tags") or {})
        lines.append(" | ".join([f"{i}. {element.get('type')}/{element.get('id')} @ {where}", *tags]))
        rows.append({"type": element.get("type"), "id": element.get("id"), "center": centre, "tags": tags})
    shown_from = tagged or features
    if len(shown_from) > MAX_ELEMENTS:
        lines.append(f"... and {len(shown_from) - MAX_ELEMENTS} more elements not shown; narrow the query.")
    if tagged and untagged:
        lines.append(f"({untagged} untagged member nodes/ways omitted)")
    header = f"Overpass returned {len(features)} element(s)"
    if len(shown_from) > MAX_ELEMENTS:
        header += f", showing the first {MAX_ELEMENTS}"
    return "\n".join([header + ":" if lines else header + ".", *lines]), rows


async def _attempt(ctx: ToolContext, url: str, query: str, http_timeout_s: float, budget_s: float) -> CachedResponse:
    """One request, bounded in total: the HTTP timeout is per phase and does not cover the wait
    for the shared semaphore, so the whole attempt also runs under a wall-clock limit."""
    request = fetch(
        ctx,
        "POST",
        url,
        data={"data": query},
        headers={"User-Agent": ctx.settings.user_agent},
        cache=http_cache(ctx.settings),
        semaphore=osm_semaphore(ctx.settings),
        retries=0,
        timeout=http_timeout_s,
        should_cache=lambda response: not _remark(response),
    )
    try:
        return await asyncio.wait_for(request, timeout=budget_s)
    except asyncio.TimeoutError:
        return CachedResponse(0, f"no answer within {budget_s:.0f} s".encode(), url=url)


async def _post(ctx: ToolContext, url: str, query: str, timeout_s: int, deadline: float) -> CachedResponse:
    """Query one server within what is left of the call's budget."""
    response = CachedResponse(0, b"time budget for this query is spent", url=url)
    for attempt in range(2):
        remaining = deadline - time.monotonic()
        if remaining < MIN_ATTEMPT_S:
            break
        started = time.monotonic()
        response = await _attempt(ctx, url, query, min(timeout_s + HTTP_MARGIN_S, remaining), remaining)
        fast = time.monotonic() - started < FAST_FAILURE_S
        if attempt or response.status not in FAST_RETRY_STATUSES or not fast:
            break
        await _http._pause(FAST_RETRY_PAUSE_S)
    return response


async def run(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    try:
        query, timeout_s = prepare_query(str(args.get("ql") or ""))
    except ValueError as exc:
        return ToolResult.error(f"overpass_query: {exc}")

    urls: list[str] = []
    failures: list[str] = []
    response: CachedResponse | None = None
    deadline = time.monotonic() + TOTAL_BUDGET_S
    for url in ctx.settings.overpass_urls:
        response = await _post(ctx, url, query, timeout_s, deadline)
        urls.append(response.url)
        if response.status in {200, 400}:  # a syntax error will not improve on the mirror
            break
        failures.append(f"{url}: {response.describe_failure()}")
        response = None

    log: dict[str, Any] = {"ql": query, "failures": failures}
    if response is None:
        message = (
            "overpass_query: every Overpass server failed (" + "; ".join(failures) + "). "
            "Retry with a smaller area or lower [timeout], or use search_places / satellite_tile instead."
        )
        return ToolResult(content=[{"type": "text", "text": message}], is_error=True, log=log, urls=urls)
    log["from_cache"] = response.from_cache
    if response.status == 400:
        message = f"overpass_query: the server rejected the query. {_syntax_error(response)}"
        return ToolResult(content=[{"type": "text", "text": message}], is_error=True, log=log, urls=urls)

    body = response.json()
    if not isinstance(body, dict):
        text = "Overpass returned a non-JSON response (use [out:json]):\n" + response.text[:RAW_TEXT_LIMIT]
        return ToolResult(content=[{"type": "text", "text": text}], log=log, urls=urls)

    elements = [e for e in body.get("elements") or [] if isinstance(e, dict)]
    remark = _remark(response)
    text, rows = summarise_elements(elements)
    log |= {"element_count": len(elements), "elements": rows, "remark": remark or None}
    if remark:
        text += (
            f"\nServer remark: {remark}\nThe result may be incomplete: shrink the bounding box or area, "
            "or simplify the filters."
        )
    elif not elements:
        text += " Widen the area, relax the tag filters, or check the tag spelling."
    return ToolResult(content=[{"type": "text", "text": text}], is_error=bool(remark) and not elements, log=log, urls=urls)
