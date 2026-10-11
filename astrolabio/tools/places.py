"""search_places: geocode names read off signs. Nominatim, then Photon; Google when a key exists."""

from __future__ import annotations

import asyncio
import re
from dataclasses import asdict, dataclass, field
from typing import Any

from .base import ToolContext, ToolResult
from .http import CachedResponse, fetch, google_settled, http_cache, osm_semaphore

NOMINATIM_MIN_INTERVAL_S = 1.0  # usage policy: at most 1 request per second
# Nominatim shares its two slots with Overpass. Waiting longer than this for a slot or an answer
# costs more than it is worth: Photon and Google are tried next either way.
NOMINATIM_BUDGET_S = 30.0
BACKEND_LIMIT = 8
MAX_RESULTS = 12
GOOGLE_TEXTSEARCH_URL = "https://maps.googleapis.com/maps/api/place/textsearch/json"
GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"

Viewbox = tuple[float, float, float, float]  # min_lng, min_lat, max_lng, max_lat

_NOMINATIM_ADMIN_KEYS = (
    ("road", "pedestrian", "footway"),
    ("neighbourhood", "suburb", "quarter", "hamlet"),
    ("village", "town", "city"),
    ("municipality",),
    ("county",),
    ("state_district", "province"),
    ("state", "region"),
    ("postcode",),
    ("country",),
)
_PHOTON_ADMIN_KEYS = ("street", "district", "city", "county", "state", "postcode", "country")


@dataclass(frozen=True)
class Place:
    name: str
    kind: str
    lat: float
    lng: float
    admin: str
    source: str


@dataclass
class Outcome:
    source: str
    url: str
    places: list[Place] = field(default_factory=list)
    error: str | None = None
    from_cache: bool = False
    dropped_outside: int = 0  # results a bias-only backend returned outside the requested viewbox


def parse_countrycodes(raw: str) -> list[str]:
    codes = [c.lower() for c in re.split(r"[,\s;]+", raw.strip()) if c]
    bad = [c for c in codes if not re.fullmatch(r"[a-z]{2}", c)]
    if bad:
        raise ValueError(f"countrycodes must be ISO 3166-1 alpha-2 codes like 'pt,es,fr'; got {', '.join(bad)}")
    return codes


def parse_viewbox(raw: str) -> Viewbox | None:
    if not raw.strip():
        return None
    try:
        lng_a, lat_a, lng_b, lat_b = (float(part) for part in raw.split(","))
    except ValueError:
        raise ValueError("viewbox must be 'min_lng,min_lat,max_lng,max_lat' (four numbers)") from None
    box = (min(lng_a, lng_b), min(lat_a, lat_b), max(lng_a, lng_b), max(lat_a, lat_b))
    if not (-180 <= box[0] <= 180 and -180 <= box[2] <= 180 and -90 <= box[1] <= 90 and -90 <= box[3] <= 90):
        raise ValueError("viewbox is out of range; the order is min_lng,min_lat,max_lng,max_lat")
    if box[0] == box[2] or box[1] == box[3]:
        raise ValueError("viewbox has zero area")
    return box


def _coords(lat: Any, lng: Any) -> tuple[float, float] | None:
    try:
        point = float(lat), float(lng)
    except (TypeError, ValueError):
        return None
    return point if -90 <= point[0] <= 90 and -180 <= point[1] <= 180 else None


def _failure(source: str, response: CachedResponse) -> Outcome:
    return Outcome(source, response.url, error=response.describe_failure())


def _nominatim_place(item: dict[str, Any]) -> Place | None:
    point = _coords(item.get("lat"), item.get("lon"))
    if point is None:
        return None
    address = item.get("address") or {}
    display = str(item.get("display_name", ""))
    admin = [next((str(address[k]) for k in keys if address.get(k)), None) for keys in _NOMINATIM_ADMIN_KEYS]
    kind = "/".join(str(v) for v in (item.get("category") or item.get("class"), item.get("type")) if v)
    return Place(
        name=str(item.get("name") or display.split(",")[0]),
        kind=kind or "place",
        lat=point[0],
        lng=point[1],
        admin=", ".join(a for a in admin if a) or display,
        source="nominatim",
    )


async def _nominatim(ctx: ToolContext, query: str, codes: list[str], viewbox: Viewbox | None) -> Outcome:
    settings = ctx.settings
    params: dict[str, Any] = {"q": query, "format": "jsonv2", "addressdetails": 1, "limit": BACKEND_LIMIT}
    if codes:
        params["countrycodes"] = ",".join(codes)
    if viewbox:
        params["viewbox"] = ",".join(f"{v:.6f}" for v in viewbox)
        params["bounded"] = 1
    url = f"{settings.nominatim_url.rstrip('/')}/search"
    request = fetch(
        ctx,
        "GET",
        url,
        params=params,
        headers={"User-Agent": settings.user_agent},
        cache=http_cache(settings),
        semaphore=osm_semaphore(settings),
        min_interval_s=NOMINATIM_MIN_INTERVAL_S,
    )
    try:
        response = await asyncio.wait_for(request, timeout=NOMINATIM_BUDGET_S)
    except asyncio.TimeoutError:
        return Outcome("nominatim", url, error=f"no answer within {NOMINATIM_BUDGET_S:.0f} s")
    items = response.json()
    if response.status != 200 or not isinstance(items, list):
        return _failure("nominatim", response)
    places = [p for p in map(_nominatim_place, items) if p]
    return Outcome("nominatim", response.url, places, from_cache=response.from_cache)


def _photon_place(feature: dict[str, Any], codes: list[str]) -> Place | None:
    props = feature.get("properties") or {}
    lnglat = (feature.get("geometry") or {}).get("coordinates") or [None, None]
    point = _coords(lnglat[1], lnglat[0]) if len(lnglat) >= 2 else None
    if point is None or (codes and str(props.get("countrycode", "")).lower() not in codes):
        return None
    street = " ".join(str(props[k]) for k in ("street", "housenumber") if props.get(k))
    admin = [street] + [str(props[k]) for k in _PHOTON_ADMIN_KEYS[1:] if props.get(k)]
    kind = "/".join(str(props[k]) for k in ("osm_key", "osm_value") if props.get(k))
    return Place(
        name=str(props.get("name") or street or props.get("city") or "(unnamed)"),
        kind=kind or str(props.get("type", "place")),
        lat=point[0],
        lng=point[1],
        admin=", ".join(a for a in admin if a),
        source="photon",
    )


async def _photon(ctx: ToolContext, query: str, codes: list[str], viewbox: Viewbox | None) -> Outcome:
    settings = ctx.settings
    params: dict[str, Any] = {"q": query, "limit": BACKEND_LIMIT}
    if viewbox:
        params["bbox"] = ",".join(f"{v:.6f}" for v in viewbox)
    response = await fetch(
        ctx,
        "GET",
        f"{settings.photon_url.rstrip('/')}/api",
        params=params,
        headers={"User-Agent": settings.user_agent},
        cache=http_cache(settings),
    )
    body = response.json()
    if response.status != 200 or not isinstance(body, dict):
        return _failure("photon", response)
    places = [p for f in body.get("features") or [] if (p := _photon_place(f, codes))]
    return Outcome("photon", response.url, places, from_cache=response.from_cache)


def _google_place(item: dict[str, Any], source: str) -> Place | None:
    location = (item.get("geometry") or {}).get("location") or {}
    point = _coords(location.get("lat"), location.get("lng"))
    if point is None:
        return None
    address = str(item.get("formatted_address", ""))
    return Place(
        name=str(item.get("name") or address.split(",")[0]),
        kind="/".join(str(t) for t in (item.get("types") or [])[:2]) or "place",
        lat=point[0],
        lng=point[1],
        admin=address,
        source=source,
    )


async def _google_call(ctx: ToolContext, source: str, url: str, params: dict[str, Any]) -> Outcome:
    response = await fetch(ctx, "GET", url, params=params, cache=http_cache(ctx.settings), should_cache=google_settled)
    body = response.json()
    if response.status != 200 or not isinstance(body, dict):
        return _failure(source, response)
    status = body.get("status")
    if status not in {"OK", "ZERO_RESULTS"}:
        return Outcome(source, response.url, error=f"{status}: {body.get('error_message', '')}".strip(": "))
    places = [p for item in (body.get("results") or [])[:BACKEND_LIMIT] if (p := _google_place(item, source))]
    return Outcome(source, response.url, places, from_cache=response.from_cache)


async def _google(ctx: ToolContext, query: str, codes: list[str], viewbox: Viewbox | None) -> list[Outcome]:
    """Places text search finds businesses OSM lacks; plain geocoding is the fallback when the
    (legacy) Places API is not enabled on the key or finds nothing."""
    key = ctx.settings.google_maps_api_key
    region = {"region": codes[0]} if len(codes) == 1 else {}
    search: dict[str, Any] = {"query": query, "key": key, **region}
    geocode: dict[str, Any] = {"address": query, "key": key, **region}
    if viewbox:
        min_lng, min_lat, max_lng, max_lat = viewbox
        radius_m = max(1000, min(50_000, round((max_lat - min_lat) * 111_320 / 2)))
        search |= {"location": f"{(min_lat + max_lat) / 2:.6f},{(min_lng + max_lng) / 2:.6f}", "radius": radius_m}
        geocode["bounds"] = f"{min_lat:.6f},{min_lng:.6f}|{max_lat:.6f},{max_lng:.6f}"
    outcomes = [await _google_call(ctx, "google_places", GOOGLE_TEXTSEARCH_URL, search)]
    if not _kept(outcomes[0], viewbox):
        outcomes.append(await _google_call(ctx, "google_geocoding", GOOGLE_GEOCODE_URL, geocode))
    if viewbox:
        # Google takes the box only as a bias and still returns matches elsewhere. Nominatim and
        # Photon are truly bounded, so anything outside the box is dropped here to keep the
        # result's "restricted to the viewbox" true: a same-named place in another town must not
        # read as confirmation of the hypothesised one.
        for outcome in outcomes:
            outcome.dropped_outside = sum(1 for p in outcome.places if not _inside(p, viewbox))
            outcome.places = [p for p in outcome.places if _inside(p, viewbox)]
    return outcomes


def _kept(outcome: Outcome, viewbox: Viewbox | None) -> list[Place]:
    return [p for p in outcome.places if viewbox is None or _inside(p, viewbox)]


def _inside(place: Place, viewbox: Viewbox) -> bool:
    min_lng, min_lat, max_lng, max_lat = viewbox
    return min_lat <= place.lat <= max_lat and min_lng <= place.lng <= max_lng


def _merge(outcomes: list[Outcome]) -> list[Place]:
    seen: set[tuple[str, float, float]] = set()
    merged: list[Place] = []
    for place in (p for outcome in outcomes for p in outcome.places):
        fingerprint = (place.name.casefold(), round(place.lat, 4), round(place.lng, 4))
        if fingerprint not in seen:
            seen.add(fingerprint)
            merged.append(place)
    return merged[:MAX_RESULTS]


def format_places(places: list[Place]) -> str:
    return "\n".join(
        f"{i}. {p.name} | {p.kind} | {p.lat:.6f},{p.lng:.6f} | {p.admin or '-'} | source: {p.source}"
        for i, p in enumerate(places, 1)
    )


async def run(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    query = str(args.get("query") or "").strip()
    if not query:
        return ToolResult.error("search_places: query is empty.")
    try:
        codes = parse_countrycodes(str(args.get("countrycodes") or ""))
        viewbox = parse_viewbox(str(args.get("viewbox") or ""))
    except ValueError as exc:
        return ToolResult.error(f"search_places: {exc}")

    outcomes = [await _nominatim(ctx, query, codes, viewbox)]
    if not outcomes[0].places:
        outcomes.append(await _photon(ctx, query, codes, viewbox))
    if ctx.settings.google_maps_api_key:
        outcomes.extend(await _google(ctx, query, codes, viewbox))

    places = _merge(outcomes)
    failures = [f"{o.source}: {o.error}" for o in outcomes if o.error]
    dropped = sum(o.dropped_outside for o in outcomes)
    google_rows = any(p.source.startswith("google") for p in places)
    log = {
        "query": query,
        "countrycodes": codes,
        "viewbox": viewbox,
        "results": [asdict(p) for p in places],
        "sources": [
            {
                "source": o.source,
                "count": len(o.places),
                "error": o.error,
                "from_cache": o.from_cache,
                "dropped_outside_viewbox": o.dropped_outside,
            }
            for o in outcomes
        ],
    }
    urls = [o.url for o in outcomes]
    scope = "".join(
        [f", countries {','.join(codes)}" if codes else "", ", restricted to the viewbox" if viewbox else ""]
    )
    notes = ""
    if codes and google_rows:
        notes += (
            "\nNote: the country restriction is enforced for nominatim and photon rows only. Google takes "
            "it as a preference, so check the location column of google rows before relying on them."
        )
    if dropped:
        notes += (
            f"\nNote: Google also matched {dropped} place(s) with this name outside the viewbox; they are "
            "not listed. The name exists elsewhere, so a hit inside the box is weaker evidence than it looks."
        )
    if places:
        text = f"{len(places)} result(s) for '{query}'{scope} (name | type | lat,lng | location | source):\n"
        text += format_places(places) + notes
        if failures:
            text += "\nUnavailable backends: " + "; ".join(failures)
        return ToolResult(content=[{"type": "text", "text": text}], log=log, urls=urls)
    if len(failures) == len(outcomes):
        message = f"search_places failed for '{query}': " + "; ".join(failures) + ". Retry later or use web_search."
        return ToolResult(content=[{"type": "text", "text": message}], is_error=True, log=log, urls=urls)
    text = (
        f"No results for '{query}'{scope}. Try a shorter or differently spelled query, drop the "
        "countrycodes/viewbox restriction, or search the feature type with overpass_query."
    ) + notes
    if failures:
        text += " Unavailable backends: " + "; ".join(failures)
    return ToolResult(content=[{"type": "text", "text": text}], log=log, urls=urls)
