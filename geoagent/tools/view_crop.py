"""view_crop: zoom into the panorama at native resolution."""

from __future__ import annotations

import asyncio
import math
from typing import Any

from ..pano import MAX_FOV, MIN_FOV, NATIVE_UPSCALE, View
from .base import ToolContext, ToolResult


def _number(args: dict[str, Any], key: str) -> float:
    value = args.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{key} must be a finite number, got {value!r}")
    return float(value)


def describe(view: View, native_px_per_deg: float, adjusted: list[str]) -> str:
    yaw, pitch, fov = view.yaw or 0.0, view.pitch or 0.0, view.fov or 0.0
    half_tan = math.tan(math.radians(fov) / 2)
    yaw_half_span = math.degrees(math.atan2(half_tan, math.cos(math.radians(pitch))))
    pitch_half_span = math.degrees(math.atan(half_tan * view.height / view.width))
    zoom = view.width / (2 * half_tan) * math.pi / 180 / native_px_per_deg
    lines = [
        f"View centred on yaw {yaw:.1f}, pitch {pitch:+.1f}; horizontal fov {fov:.1f}; "
        f"{view.width} x {view.height} px.",
        f"The centre row spans yaw {(yaw - yaw_half_span) % 360:.1f} (left edge) to "
        f"{(yaw + yaw_half_span) % 360:.1f} (right edge); the centre column spans pitch "
        f"{max(-90.0, pitch - pitch_half_span):+.1f} to {min(90.0, pitch + pitch_half_span):+.1f}.",
    ]
    if zoom >= NATIVE_UPSCALE * 0.99:
        lines.append(
            f"Shown at {zoom:.1f}x the panorama's native resolution: a narrower fov will not reveal "
            "more detail."
        )
    else:
        lines.append(f"Shown at {zoom:.1f}x the panorama's native resolution; a narrower fov shows more detail.")
    if adjusted:
        lines.append("Adjusted input: " + "; ".join(adjusted) + ".")
    return "\n".join(lines)


async def run(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    try:
        yaw, pitch, fov = (_number(args, key) for key in ("yaw", "pitch", "fov"))
    except ValueError as exc:
        return ToolResult.error(f"view_crop: {exc}. Give yaw 0-360, pitch -90..90, fov {MIN_FOV:g}-{MAX_FOV:g}.")
    enhance = args.get("enhance") is True

    adjusted: list[str] = []
    if not 0 <= yaw < 360:
        adjusted.append(f"yaw {yaw:g} wrapped to {yaw % 360:g}")
    if not -90 <= pitch <= 90:
        adjusted.append(f"pitch {pitch:g} clamped to {max(-90.0, min(90.0, pitch)):g}")
    if not MIN_FOV <= fov <= MAX_FOV:
        adjusted.append(f"fov {fov:g} clamped to {max(MIN_FOV, min(MAX_FOV, fov)):g}")

    try:
        view = await asyncio.to_thread(ctx.pano.render, yaw, pitch, fov, enhance=enhance)
    except Exception as exc:  # a failed render must reach the model as a tool error, not kill the loop
        return ToolResult.error(f"view_crop: rendering failed ({type(exc).__name__}: {exc}).")

    text = describe(view, ctx.pano.width / 360, adjusted)
    return ToolResult(
        content=[{"type": "text", "text": text}, view.to_block()],
        log={
            "image": view.ref(),
            "width": view.width,
            "height": view.height,
            "enhance": enhance,
            "adjusted": adjusted,
            "text": text,
        },
    )
