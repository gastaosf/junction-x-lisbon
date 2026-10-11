"""satellite_tile: north-up Esri World Imagery around a coordinate, annotated with a scale bar,
a north arrow and a centre crosshair."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np

from .base import ToolContext, ToolResult
from .http import decode_image, encode_jpeg, fetch, http_cache, image_block, is_image, store_image

IMAGE_PX = 1024
MIN_ZOOM, MAX_ZOOM = 3, 20
MAX_LAT = 85.0  # Web Mercator limit
WGS84_RADIUS_M = 6378137.0  # Web Mercator sphere, not the mean Earth radius used for scoring
TILE_PX = 256

_WHITE, _BLACK = (255, 255, 255), (0, 0, 0)
_FONT = cv2.FONT_HERSHEY_SIMPLEX


@dataclass(frozen=True)
class Footprint:
    """The Web Mercator square requested from Esri and its ground dimensions."""

    xmin: float
    ymin: float
    xmax: float
    ymax: float
    south: float
    west: float
    north: float
    east: float
    metres_per_px: float  # true ground metres at the centre latitude

    @property
    def ground_width_m(self) -> float:
        return self.metres_per_px * IMAGE_PX


def _mercator_y_to_lat(y: float) -> float:
    return math.degrees(2 * math.atan(math.exp(y / WGS84_RADIUS_M)) - math.pi / 2)


def footprint(lat: float, lng: float, zoom: int) -> Footprint:
    """Square of IMAGE_PX pixels at the resolution of web-map zoom level `zoom`."""
    resolution = 2 * math.pi * WGS84_RADIUS_M / (TILE_PX * 2**zoom)  # projected metres per pixel
    half = resolution * IMAGE_PX / 2
    x = WGS84_RADIUS_M * math.radians(lng)
    y = WGS84_RADIUS_M * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return Footprint(
        xmin=x - half, ymin=y - half, xmax=x + half, ymax=y + half,
        south=_mercator_y_to_lat(y - half), north=_mercator_y_to_lat(y + half),
        west=math.degrees((x - half) / WGS84_RADIUS_M), east=math.degrees((x + half) / WGS84_RADIUS_M),
        metres_per_px=resolution * math.cos(math.radians(lat)),
    )  # fmt: skip


def nice_scale_m(metres_per_px: float, max_px: float) -> float:
    """Largest 1/2/5 x 10^n length whose bar fits in max_px."""
    limit = metres_per_px * max_px
    magnitude = 10 ** math.floor(math.log10(limit))
    return next(step * magnitude for step in (5, 2, 1) if step * magnitude <= limit)


def _format_length(metres: float) -> str:
    return f"{metres / 1000:g} km" if metres >= 1000 else f"{metres:g} m"


def _outlined_line(image: np.ndarray, start: tuple[int, int], end: tuple[int, int]) -> None:
    cv2.line(image, start, end, _BLACK, 5, cv2.LINE_AA)
    cv2.line(image, start, end, _WHITE, 2, cv2.LINE_AA)


def _outlined_text(image: np.ndarray, text: str, origin: tuple[int, int], scale: float = 0.7) -> None:
    cv2.putText(image, text, origin, _FONT, scale, _BLACK, 5, cv2.LINE_AA)
    cv2.putText(image, text, origin, _FONT, scale, _WHITE, 2, cv2.LINE_AA)


def annotate(image: np.ndarray, metres_per_px: float) -> tuple[np.ndarray, float]:
    """Draw crosshair, scale bar and north arrow; returns the image and the bar length in metres."""
    out = image.copy()
    height, width = out.shape[:2]
    cx, cy = width // 2, height // 2

    # Crosshair with an open centre so the pinned spot itself stays visible.
    gap, arm = max(6, width // 100), max(20, width // 28)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        _outlined_line(out, (cx + dx * gap, cy + dy * gap), (cx + dx * arm, cy + dy * arm))

    bar_m = nice_scale_m(metres_per_px, width * 0.25)
    bar_px = round(bar_m / metres_per_px)
    x0, y0 = 30, height - 30
    _outlined_line(out, (x0, y0), (x0 + bar_px, y0))
    for x in (x0, x0 + bar_px):
        _outlined_line(out, (x, y0 - 8), (x, y0 + 8))
    _outlined_text(out, _format_length(bar_m), (x0, y0 - 16))

    ax, tip, tail = width - 50, 50, 120
    cv2.arrowedLine(out, (ax, tail), (ax, tip), _BLACK, 6, cv2.LINE_AA, tipLength=0.35)
    cv2.arrowedLine(out, (ax, tail), (ax, tip), _WHITE, 2, cv2.LINE_AA, tipLength=0.35)
    _outlined_text(out, "N", (ax - 10, tail + 30), 0.9)
    return out, bar_m


def parse_args(args: dict[str, Any]) -> tuple[float, float, int]:
    try:
        lat, lng, zoom = float(args["lat"]), float(args["lng"]), float(args["zoom"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("lat, lng and zoom must be numbers.") from None
    if not all(map(math.isfinite, (lat, lng, zoom))):
        raise ValueError("lat, lng and zoom must be finite numbers.")
    if not (-MAX_LAT <= lat <= MAX_LAT and -180 <= lng <= 180):
        raise ValueError(f"coordinate out of range: lat {lat}, lng {lng}.")
    return lat, lng, min(max(round(zoom), MIN_ZOOM), MAX_ZOOM)


async def run(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    try:
        lat, lng, zoom = parse_args(args)
    except ValueError as exc:
        return ToolResult.error(f"satellite_tile: {exc}")

    area = footprint(lat, lng, zoom)
    params = {
        "bbox": f"{area.xmin:.2f},{area.ymin:.2f},{area.xmax:.2f},{area.ymax:.2f}",
        "bboxSR": 3857,
        "imageSR": 3857,
        "size": f"{IMAGE_PX},{IMAGE_PX}",
        "format": "jpg",
        "f": "image",
    }
    response = await fetch(
        ctx, "GET", ctx.settings.esri_export_url, params=params, cache=http_cache(ctx.settings), should_cache=is_image
    )
    image = decode_image(response.content) if response.status == 200 else None
    if image is None:
        reason = response.describe_failure() if response.status != 200 else f"not an image: {response.text[:200]}"
        message = f"satellite_tile: imagery request failed ({reason}). Retry once, or try a different zoom."
        return ToolResult(content=[{"type": "text", "text": message}], is_error=True, urls=[response.url])

    # Scale by the delivered width, in case the server returns a different size than requested.
    metres_per_px = area.ground_width_m / image.shape[1]
    annotated, bar_m = annotate(image, metres_per_px)
    jpeg = encode_jpeg(annotated)
    ref = store_image(ctx, jpeg, source="esri_world_imagery", lat=lat, lng=lng, zoom=zoom)
    height, width = annotated.shape[:2]
    text = (
        f"Esri World Imagery centred on {lat:.6f},{lng:.6f} at zoom {zoom}, north up. The image is "
        f"{width}x{height} px and covers about {area.ground_width_m:.0f} m x {area.ground_width_m:.0f} m "
        f"({metres_per_px:.2f} m/px). Bounds: north {area.north:.6f}, south {area.south:.6f}, "
        f"west {area.west:.6f}, east {area.east:.6f}. The crosshair marks the requested coordinate; the "
        f"scale bar (bottom left) is {_format_length(bar_m)}. To convert a feature to coordinates: 100 px up = "
        f"+{(area.north - area.south) / height * 100:.6f} lat, 100 px right = +{(area.east - area.west) / width * 100:.6f} lng."
    )
    log = {
        "lat": lat, "lng": lng, "zoom": zoom, "ground_width_m": round(area.ground_width_m, 1),
        "metres_per_px": round(metres_per_px, 4), "bounds": [area.south, area.west, area.north, area.east],
        "image": ref, "from_cache": response.from_cache,
    }  # fmt: skip
    return ToolResult(content=[{"type": "text", "text": text}, image_block(jpeg)], log=log, urls=[response.url])
