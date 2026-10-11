"""streetview_lookup: street-level imagery near a coordinate, with the imagery's own coordinate.

Google Street View Static is the first source (its metadata call is free and gives the snapped
pano position); Mapillary is the second. The returned text always states the imagery's own
coordinate, because that coordinate, not the queried one, is the answer when a view matches.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from ..scoring import haversine_m
from .base import ToolContext, ToolResult
from .http import decode_image, encode_jpeg, fetch, google_settled, http_cache, image_block, is_image, store_image

GOOGLE_METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata"
GOOGLE_IMAGE_URL = "https://maps.googleapis.com/maps/api/streetview"
MAPILLARY_IMAGES_URL = "https://graph.mapillary.com/images"
MAPILLARY_FIELDS = (
    "id,computed_geometry,geometry,captured_at,compass_angle,is_pano,sequence,thumb_1024_url,thumb_2048_url"
)

MAX_HEADINGS = 4
# Every view returned counts against the conversation's image budget, so an unspecified request
# gets two opposite views rather than four.
DEFAULT_HEADINGS = (0.0, 180.0)
MIN_RADIUS_M, MAX_RADIUS_M = 10.0, 1000.0
IMAGE_SIZE = "640x640"
IMAGE_FOV = 90
EXCLUSION_RADIUS_M = 25.0  # eval leakage guard around the panorama's own source image
MAPILLARY_LIMIT = 100
# The Graph API returns an arbitrary subset of a box that holds more images than the limit, so
# "nearest" is only meaningful when the box is small. Search outwards and stop at the first hit.
MAPILLARY_SEARCH_STEPS_M = (30.0, 100.0, 300.0)
MAPILLARY_POOL = 20  # nearest images considered when matching requested headings
PANO_PREFERENCE = 5  # a 360 image among this many nearest ones beats directional photos

NO_BACKEND_MESSAGE = (
    "streetview_lookup is unavailable: no street-level imagery source is configured (no Google Maps "
    "key and no Mapillary token). Do not call it again; verify candidates with satellite_tile "
    "(road layout, roofs, field patterns) and overpass_query instead."
)
_COMPASS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")


@dataclass
class Lookup:
    """What one backend produced: content blocks on success, else a note on why not."""

    content: list[dict[str, Any]] | None
    note: str
    failed: bool = False  # True = backend error, False = clean "no coverage"
    log: dict[str, Any] | None = None


@dataclass(frozen=True)
class MapillaryImage:
    id: str
    lat: float
    lng: float
    distance_m: float
    compass: float | None
    is_pano: bool
    captured: str
    thumb_url: str


def compass_name(heading: float) -> str:
    return _COMPASS[round((heading % 360) / 45) % 8]


def angular_diff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def parse_args(args: dict[str, Any]) -> tuple[float, float, float, list[float]]:
    try:
        lat, lng = float(args["lat"]), float(args["lng"])
        radius = float(args.get("radius_m") or 50)
        headings = [float(h) % 360 for h in args.get("headings") or []]
    except (KeyError, TypeError, ValueError):
        raise ValueError("lat, lng and radius_m must be numbers and headings a list of numbers.") from None
    if not all(map(math.isfinite, (lat, lng, radius, *headings))):
        raise ValueError("lat, lng, radius_m and headings must be finite numbers.")
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise ValueError(f"coordinate out of range: lat {lat}, lng {lng}.")
    if len(headings) > MAX_HEADINGS:
        raise ValueError(f"at most {MAX_HEADINGS} headings per call; got {len(headings)}.")
    radius = min(max(radius, MIN_RADIUS_M), MAX_RADIUS_M)
    return lat, lng, radius, headings or list(DEFAULT_HEADINGS)


async def _download_image(ctx: ToolContext, url: str, params: dict[str, Any] | None, urls: list[str]) -> bytes | None:
    response = await fetch(ctx, "GET", url, params=params, cache=http_cache(ctx.settings), should_cache=is_image)
    urls.append(response.url)
    image = decode_image(response.content) if response.status == 200 else None
    return None if image is None else encode_jpeg(image)


async def _google(
    ctx: ToolContext, lat: float, lng: float, radius: float, headings: list[float], urls: list[str]
) -> Lookup:
    key = ctx.settings.google_maps_api_key
    meta_params = {"location": f"{lat:.6f},{lng:.6f}", "radius": round(radius), "source": "outdoor", "key": key}
    response = await fetch(
        ctx, "GET", GOOGLE_METADATA_URL, params=meta_params, cache=http_cache(ctx.settings), should_cache=google_settled
    )
    urls.append(response.url)
    meta = response.json()
    if response.status != 200 or not isinstance(meta, dict):
        return Lookup(None, f"Google Street View metadata failed ({response.describe_failure()})", failed=True)
    status = meta.get("status")
    if status in {"ZERO_RESULTS", "NOT_FOUND"}:
        return Lookup(None, f"Google Street View has no outdoor pano within {radius:.0f} m")
    location = meta.get("location") or {}
    if status != "OK" or "lat" not in location or "lng" not in location:
        detail = f"{status}: {meta.get('error_message', '')}".strip(": ")
        return Lookup(None, f"Google Street View metadata failed ({detail})", failed=True)

    pano_lat, pano_lng = float(location["lat"]), float(location["lng"])
    pano_id, date = str(meta.get("pano_id", "")), str(meta.get("date") or "unknown date")
    distance = haversine_m(lat, lng, pano_lat, pano_lng)
    views: list[dict[str, Any]] = []
    refs: list[dict[str, Any]] = []
    for heading in headings:
        params = {
            "size": IMAGE_SIZE, "pano": pano_id, "heading": f"{heading:.1f}", "fov": IMAGE_FOV, "pitch": 0,
            "return_error_code": "true", "key": key,
        }  # fmt: skip
        jpeg = await _download_image(ctx, GOOGLE_IMAGE_URL, params, urls)
        if jpeg is None:
            continue
        label = f"Street View at {pano_lat:.6f},{pano_lng:.6f}, compass heading {heading:.0f} ({compass_name(heading)}):"
        views += [{"type": "text", "text": label}, image_block(jpeg)]
        refs.append(store_image(ctx, jpeg, source="google", pano_id=pano_id, heading=heading))
    if not views:
        return Lookup(None, f"Google Street View pano {pano_id} exists but its images could not be fetched", failed=True)

    summary = (
        f"Google Street View pano {pano_id}, captured {date}. PANO COORDINATE: {pano_lat:.6f},{pano_lng:.6f} "
        f"({distance:.0f} m from the point you asked for). If these views show the same place as the "
        f"panorama, the answer is this pano coordinate ({pano_lat:.6f},{pano_lng:.6f}), not the coordinate "
        f"you queried. {len(refs)} view(s) follow, {IMAGE_FOV} degree field of view, pitch 0."
    )
    log = {
        "source": "google", "pano_id": pano_id, "pano_lat": pano_lat, "pano_lng": pano_lng, "date": date,
        "distance_m": round(distance, 1), "images": refs,
    }  # fmt: skip
    return Lookup([{"type": "text", "text": summary}, *views], "", log=log)


def _excluded(ctx: ToolContext, image_id: str, lat: float, lng: float, sequence: str = "") -> bool:
    """Eval leakage guard: the panorama's own source image, anything right next to it, and the
    rest of the drive it came from (same camera, same minute, same cars and light)."""
    ids = {str(i) for i in getattr(ctx.session, "excluded_image_ids", None) or ()}
    if image_id in ids:
        return True
    sequences = {str(i) for i in getattr(ctx.session, "excluded_sequence_ids", None) or () if i}
    if sequence and sequence in sequences:
        return True
    point = getattr(ctx.session, "excluded_point", None)
    return point is not None and haversine_m(lat, lng, point[0], point[1]) <= EXCLUSION_RADIUS_M


def _captured(raw: Any) -> str:
    try:
        return datetime.fromtimestamp(float(raw) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OverflowError, OSError):
        return "unknown date"


def parse_mapillary(ctx: ToolContext, items: list[Any], lat: float, lng: float, radius: float) -> list[MapillaryImage]:
    """Usable images within the radius, nearest first, with the eval exclusions applied."""
    images: list[MapillaryImage] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        geometry = item.get("computed_geometry") or item.get("geometry") or {}
        lnglat = geometry.get("coordinates") or []
        # A 360 image at 1024 x 512 is under 3 px per degree, too coarse to compare shopfronts.
        thumb = (item.get("thumb_2048_url") if item.get("is_pano") else None) or item.get("thumb_1024_url")
        if len(lnglat) < 2 or not thumb:
            continue
        image_lat, image_lng, image_id = float(lnglat[1]), float(lnglat[0]), str(item.get("id", ""))
        distance = haversine_m(lat, lng, image_lat, image_lng)
        sequence = item.get("sequence")
        sequence = str(sequence.get("id", "")) if isinstance(sequence, dict) else str(sequence or "")
        if distance > radius or _excluded(ctx, image_id, image_lat, image_lng, sequence):
            continue
        compass = item.get("compass_angle")
        images.append(
            MapillaryImage(
                id=image_id, lat=image_lat, lng=image_lng, distance_m=distance,
                compass=None if compass is None else float(compass) % 360,
                is_pano=bool(item.get("is_pano")), captured=_captured(item.get("captured_at")), thumb_url=str(thumb),
            )  # fmt: skip
        )
    return sorted(images, key=lambda image: image.distance_m)


def choose_mapillary(images: list[MapillaryImage], headings: list[float]) -> list[MapillaryImage]:
    """A nearby 360 image covers every heading; otherwise pick, per requested heading, the nearby
    photo facing closest to it."""
    pano = next((image for image in images[:PANO_PREFERENCE] if image.is_pano), None)
    if pano is not None:
        return [pano]
    pool = images[:MAPILLARY_POOL]
    chosen: dict[str, MapillaryImage] = {}
    for heading in headings:
        best = min(
            pool,
            key=lambda image: (180.0 if image.compass is None else angular_diff(image.compass, heading), image.distance_m),
        )
        chosen.setdefault(best.id, best)
    return list(chosen.values())


def _mapillary_label(image: MapillaryImage) -> str:
    where = f"{image.lat:.6f},{image.lng:.6f}"
    if image.is_pano:
        facing = "" if image.compass is None else f"; the image centre faces roughly compass {image.compass:.0f}"
        return f"Mapillary 360 image {image.id} at {where}, captured {image.captured} (equirectangular{facing}):"
    facing = "unknown heading" if image.compass is None else f"facing compass {image.compass:.0f} ({compass_name(image.compass)})"
    return f"Mapillary photo {image.id} at {where}, {facing}, captured {image.captured}, {image.distance_m:.0f} m from the query:"


def search_radii(radius: float) -> list[float]:
    """Box sizes to try, smallest first, ending with the requested radius."""
    return [step for step in MAPILLARY_SEARCH_STEPS_M if step < radius] + [radius]


async def _mapillary(
    ctx: ToolContext, lat: float, lng: float, radius: float, headings: list[float], urls: list[str]
) -> Lookup:
    images: list[MapillaryImage] = []
    searched, truncated = radius, False
    for searched in search_radii(radius):
        dlat = searched / 111_320
        dlng = searched / (111_320 * max(math.cos(math.radians(lat)), 0.01))
        params = {
            "fields": MAPILLARY_FIELDS,
            "bbox": f"{lng - dlng:.6f},{lat - dlat:.6f},{lng + dlng:.6f},{lat + dlat:.6f}",
            "limit": MAPILLARY_LIMIT,
        }
        response = await fetch(
            ctx,
            "GET",
            MAPILLARY_IMAGES_URL,
            params=params,
            headers={"Authorization": f"OAuth {ctx.settings.mapillary_token}"},
            cache=http_cache(ctx.settings),
        )
        urls.append(response.url)
        body = response.json()
        if response.status != 200 or not isinstance(body, dict):
            return Lookup(None, f"Mapillary search failed ({response.describe_failure()})", failed=True)
        items = body.get("data") or []
        truncated = len(items) >= MAPILLARY_LIMIT
        images = parse_mapillary(ctx, items, lat, lng, searched)
        if images:
            break
    if not images:
        return Lookup(None, f"Mapillary has no imagery within {radius:.0f} m")

    views: list[dict[str, Any]] = []
    refs: list[dict[str, Any]] = []
    shown: list[MapillaryImage] = []
    for image in choose_mapillary(images, headings):
        jpeg = await _download_image(ctx, image.thumb_url, None, urls)
        if jpeg is None:
            continue
        views += [{"type": "text", "text": _mapillary_label(image)}, image_block(jpeg)]
        refs.append(store_image(ctx, jpeg, source="mapillary", image_id=image.id, lat=image.lat, lng=image.lng, heading=image.compass))
        shown.append(image)
    if not shown:
        return Lookup(None, "Mapillary images were found but could not be downloaded", failed=True)

    nearest = shown[0]
    found = f"{len(images)} image(s) within {searched:.0f} m"
    if truncated:
        found = (
            f"at least {len(images)} images within {searched:.0f} m; the search hit its limit, so the ones "
            "shown may not be the nearest. Ask again with a smaller radius_m for a precise spot"
        )
    summary = (
        f"Mapillary street-level imagery ({found}; showing {len(shown)}). "
        f"Each image below is labelled with ITS OWN COORDINATE. If an image shows the same place as the "
        f"panorama, the answer is that image's coordinate (nearest shown: {nearest.lat:.6f},{nearest.lng:.6f}, "
        f"{nearest.distance_m:.0f} m from the point you asked for), not the coordinate you queried."
    )
    log = {
        "source": "mapillary", "found": len(images), "searched_radius_m": searched, "truncated": truncated,
        "images": refs,
        "pano_lat": nearest.lat, "pano_lng": nearest.lng, "distance_m": round(nearest.distance_m, 1),
    }  # fmt: skip
    return Lookup([{"type": "text", "text": summary}, *views], "", log=log)


async def run(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    try:
        lat, lng, radius, headings = parse_args(args)
    except ValueError as exc:
        return ToolResult.error(f"streetview_lookup: {exc}")
    settings = ctx.settings
    backends = [
        backend
        for backend, enabled in ((_google, settings.google_maps_api_key), (_mapillary, settings.mapillary_token))
        if enabled
    ]
    if not backends:
        return ToolResult.error(NO_BACKEND_MESSAGE)

    urls: list[str] = []
    lookups: list[Lookup] = []
    query = {"lat": lat, "lng": lng, "radius_m": radius, "headings": headings}
    for backend in backends:
        lookup = await backend(ctx, lat, lng, radius, headings, urls)
        lookups.append(lookup)
        if lookup.content is not None:
            notes = [earlier.note for earlier in lookups[:-1]]
            content = lookup.content + ([{"type": "text", "text": "Note: " + "; ".join(notes) + "."}] if notes else [])
            return ToolResult(content=content, log={"query": query, **(lookup.log or {}), "notes": notes}, urls=urls)

    notes = [lookup.note for lookup in lookups]
    message = (
        f"No street-level imagery returned for {lat:.6f},{lng:.6f}: " + "; ".join(notes) + ". "
        "Try a larger radius_m (up to 1000) or a point on a road; otherwise verify with satellite_tile."
    )
    return ToolResult(
        content=[{"type": "text", "text": message}],
        is_error=all(lookup.failed for lookup in lookups),
        log={"query": query, "notes": notes},
        urls=urls,
    )
