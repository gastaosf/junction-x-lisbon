"""Equirectangular panorama -> model-sized views (SPEC 6.2).

Yaw convention (shared with the overview ruler, view_crop and sun_position): yaw 0 is the left
edge of the equirectangular image and increases rightwards, so yaw 180 is the image centre.
Pitch is degrees above (+) or below (-) the horizon. This is the panorama's own frame, not
compass north.
"""

from __future__ import annotations

import base64
import hashlib
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

MAX_SIDE = 2000  # requests with more than 20 images reject anything larger
MIN_FOV = 5.0
MAX_FOV = 120.0
MIN_ZOOM_SIDE = 512
NATIVE_UPSCALE = 2.0  # narrow crops are rendered at 2x native resolution for legibility
JPEG_QUALITY = 90
# The eleven initial views are re-uploaded with every request of the conversation (prompt caching
# saves tokens, not bytes), by up to six panoramas at once on a shared uplink. They are for
# surveying the scene; anything that must be read is fetched again with view_crop at full quality.
# The sizes are fixed by SPEC 6.2, so the saving comes from the encoder setting alone.
INITIAL_JPEG_QUALITY = 80

INITIAL_YAWS: tuple[int, ...] = tuple(range(0, 360, 45))
INITIAL_FOV = 90.0
INITIAL_WIDTH = 1456
SKY_FOV = 120.0
GROUND_FOV = 110.0
VERTICAL_WIDTH = 1024

OVERVIEW_SIZE = (2000, 1000)
RULER_MINOR_STEP = 15
RULER_MAJOR_STEP = 45
RULER_BAND_PX = 36

_PAD = 8  # wrapped columns on each side, wider than the Lanczos kernel, so the 360 seam is seamless
_MAX_LEVEL = 3
_FONT = cv2.FONT_HERSHEY_SIMPLEX


@dataclass
class View:
    label: str
    jpeg: bytes
    yaw: float | None
    pitch: float | None
    fov: float | None
    width: int
    height: int
    sha256: str
    path: Path | None

    def to_block(self) -> dict[str, Any]:
        data = base64.standard_b64encode(self.jpeg).decode("ascii")
        return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}}

    def ref(self) -> dict[str, Any]:
        return {
            "sha256": self.sha256,
            "path": str(self.path) if self.path else None,
            "yaw": self.yaw,
            "pitch": self.pitch,
            "fov": self.fov,
        }


def ruler_ticks(width: int) -> list[tuple[int, int]]:
    """(x, yaw) of every ruler tick for an overview of the given width; yaw 0 is x = 0."""
    return [
        (min(width - 1, round(yaw / 360 * width)), yaw) for yaw in range(0, 361, RULER_MINOR_STEP)
    ]


def output_size(fov: float, out_width: int, aspect: float, native_px_per_rad: float) -> tuple[int, int]:
    """Output size for a view: never more than NATIVE_UPSCALE x the source resolution (extra pixels
    carry no detail and cost tokens), never more than MAX_SIDE per side."""
    native_width = 2 * math.tan(math.radians(fov) / 2) * native_px_per_rad
    useful = max(MIN_ZOOM_SIDE, round(NATIVE_UPSCALE * native_width))
    width = max(16, min(int(out_width), useful, MAX_SIDE))
    height = max(16, round(width / aspect))
    if height > MAX_SIDE:
        width = max(16, round(width * MAX_SIDE / height))
        height = MAX_SIDE
    return width, height


def _rectilinear_maps(
    yaw: float, pitch: float, focal: float, width: int, height: int, src_w: int, src_h: int
) -> tuple[np.ndarray, np.ndarray]:
    """Source pixel coordinates (in the padded level image) for every output pixel."""
    x = ((np.arange(width, dtype=np.float32) - (width - 1) / 2) / focal)[None, :]
    y = (((height - 1) / 2 - np.arange(height, dtype=np.float32)) / focal)[:, None]
    sin_p, cos_p = math.sin(math.radians(pitch)), math.cos(math.radians(pitch))
    up = y * cos_p + sin_p
    forward = cos_p - y * sin_p
    lon = np.arctan2(x, forward) + np.float32(math.radians(yaw))
    lat = np.arctan2(up, np.hypot(x, forward))
    map_x = np.mod(lon / (2 * math.pi), 1.0) * src_w - 0.5 + _PAD
    map_y = np.clip((0.5 - lat / math.pi) * src_h - 0.5, 0, src_h - 1)
    return map_x.astype(np.float32), map_y.astype(np.float32)


def _enhance(bgr: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    lab[:, :, 0] = clahe.apply(lab[:, :, 0])
    out = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
    blurred = cv2.GaussianBlur(out, (0, 0), 2.0)
    return cv2.addWeighted(out, 1.6, blurred, -0.6, 0)


def _outlined_text(img: np.ndarray, text: str, org: tuple[int, int], scale: float = 0.5) -> None:
    cv2.putText(img, text, org, _FONT, scale, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(img, text, org, _FONT, scale, (255, 255, 255), 1, cv2.LINE_AA)


def _draw_yaw_ruler(img: np.ndarray) -> None:
    width = img.shape[1]
    img[:RULER_BAND_PX] = (img[:RULER_BAND_PX] * 0.4).astype(np.uint8)
    for x, yaw in ruler_ticks(width):
        major = yaw % RULER_MAJOR_STEP == 0
        cv2.line(img, (x, 0), (x, 13 if major else 6), (255, 255, 255), 2 if major else 1)
        if major:
            text = str(yaw)
            (text_w, _), _ = cv2.getTextSize(text, _FONT, 0.5, 1)
            _outlined_text(img, text, (int(np.clip(x - text_w // 2, 2, width - text_w - 2)), 30))


def _draw_pitch_ticks(img: np.ndarray) -> None:
    height = img.shape[0]
    for pitch in (60, 30, 0, -30, -60):
        y = round((90 - pitch) / 180 * height)
        cv2.line(img, (0, y), (10, y), (255, 255, 255), 2)
        _outlined_text(img, f"{pitch:+d}" if pitch else "0", (14, y + 5), 0.45)


class Panorama:
    """A loaded equirectangular panorama. The decoded image is held in memory for the session;
    rendering is thread-safe, so callers may use asyncio.to_thread."""

    def __init__(self, path: Path, image_dir: Path | None = None) -> None:
        self.path = Path(path)
        self.image_dir = Path(image_dir) if image_dir is not None else None
        raw = self.path.read_bytes()
        self.sha256 = hashlib.sha256(raw).hexdigest()
        image = cv2.imdecode(
            np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION
        )
        if image is None:
            raise ValueError(f"cannot decode panorama image: {self.path}")
        self.height, self.width = image.shape[:2]
        self._levels: dict[int, np.ndarray] = {0: self._pad(image)}

    @staticmethod
    def _pad(image: np.ndarray) -> np.ndarray:
        return cv2.copyMakeBorder(image, 0, 0, _PAD, _PAD, cv2.BORDER_WRAP)

    @property
    def native_px_per_rad(self) -> float:
        return self.width / (2 * math.pi)

    def _base(self) -> np.ndarray:
        return self._levels[0][:, _PAD:-_PAD]

    def _level(self, level: int) -> np.ndarray:
        """Padded source downscaled by 2**level; wide views sample from it to avoid aliasing."""
        if level not in self._levels:
            size = (max(2, self.width >> level), max(1, self.height >> level))
            self._levels[level] = self._pad(cv2.resize(self._base(), size, interpolation=cv2.INTER_AREA))
        return self._levels[level]

    def _render_array(
        self, yaw: float, pitch: float, fov: float, width: int, height: int
    ) -> np.ndarray:
        focal = width / (2 * math.tan(math.radians(fov) / 2))
        shrink = self.native_px_per_rad / focal
        level = int(np.clip(math.floor(math.log2(shrink)), 0, _MAX_LEVEL)) if shrink > 1 else 0
        source = self._level(level)
        map_x, map_y = _rectilinear_maps(
            yaw, pitch, focal, width, height, source.shape[1] - 2 * _PAD, source.shape[0]
        )
        return cv2.remap(source, map_x, map_y, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE)

    def _view(
        self,
        bgr: np.ndarray,
        label: str,
        yaw: float | None,
        pitch: float | None,
        fov: float | None,
        quality: int = JPEG_QUALITY,
    ) -> View:
        ok, encoded = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            raise RuntimeError("JPEG encoding failed")
        jpeg = encoded.tobytes()
        digest = hashlib.sha256(jpeg).hexdigest()
        path: Path | None = None
        if self.image_dir is not None:
            self.image_dir.mkdir(parents=True, exist_ok=True)
            path = self.image_dir / f"{digest}.jpg"
            if not path.exists():
                path.write_bytes(jpeg)
        return View(label, jpeg, yaw, pitch, fov, bgr.shape[1], bgr.shape[0], digest, path)

    def render(
        self,
        yaw: float,
        pitch: float,
        fov: float,
        *,
        out_width: int = INITIAL_WIDTH,
        enhance: bool = False,
        aspect: float = 1.0,
        label: str | None = None,
        quality: int = JPEG_QUALITY,
    ) -> View:
        """Rectilinear view centred on (yaw, pitch); fov is the horizontal field of view."""
        yaw = float(yaw) % 360.0
        pitch = float(np.clip(pitch, -90.0, 90.0))
        fov = float(np.clip(fov, MIN_FOV, MAX_FOV))
        aspect = float(np.clip(aspect, 0.25, 4.0))
        width, height = output_size(fov, out_width, aspect, self.native_px_per_rad)
        bgr = self._render_array(yaw, pitch, fov, width, height)
        if enhance:
            bgr = _enhance(bgr)
        text = label or f"Rectilinear view: yaw {yaw:g}, pitch {pitch:+g}, fov {fov:g}"
        return self._view(bgr, text, yaw, pitch, fov, quality)

    def overview(self, quality: int = JPEG_QUALITY) -> View:
        img = cv2.resize(self._base(), OVERVIEW_SIZE, interpolation=cv2.INTER_AREA)
        _draw_yaw_ruler(img)
        _draw_pitch_ticks(img)
        label = (
            "Overview: the full 360 x 180 degree panorama (equirectangular). The ruler along the top "
            "edge gives yaw in degrees: yaw 0 is the left edge, yaw 180 the centre, and the right edge "
            "wraps back to yaw 0. Ticks on the left edge give pitch (+ is above the horizon). Yaw is "
            "the panorama's own frame, not compass north."
        )
        return self._view(img, label, None, None, None, quality)

    def initial_views(self) -> list[View]:
        views = [self.overview(INITIAL_JPEG_QUALITY)]
        for index, yaw in enumerate(INITIAL_YAWS, start=1):
            label = (
                f"View {index} of {len(INITIAL_YAWS)}: yaw {yaw}, pitch 0, fov {INITIAL_FOV:g} "
                f"(covers yaw {(yaw - 45) % 360} to {(yaw + 45) % 360})"
            )
            views.append(
                self.render(yaw, 0, INITIAL_FOV, out_width=INITIAL_WIDTH, label=label, quality=INITIAL_JPEG_QUALITY)
            )
        views.append(
            self.render(
                0,
                90,
                SKY_FOV,
                out_width=VERTICAL_WIDTH,
                quality=INITIAL_JPEG_QUALITY,
                label=(
                    f"Up view (sky, sun, wires, pole tops): pitch +90, fov {SKY_FOV:g}; the zenith is at "
                    "the centre. The bottom edge faces yaw 0, the right edge yaw 90, the top edge "
                    "yaw 180, the left edge yaw 270."
                ),
            )
        )
        views.append(
            self.render(
                0,
                -90,
                GROUND_FOV,
                out_width=VERTICAL_WIDTH,
                quality=INITIAL_JPEG_QUALITY,
                label=(
                    f"Down view (road surface, markings): pitch -90, fov {GROUND_FOV:g}; the point under "
                    "the camera is at the centre. The top edge faces yaw 0, the right edge yaw 90, the "
                    "bottom edge yaw 180, the left edge yaw 270."
                ),
            )
        )
        return views
