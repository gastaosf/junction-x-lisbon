"""sun_position: compass orientation of the panorama from where the sun appears in it.

The capture timestamp's time zone is unknown (SPEC Q5), so every candidate is evaluated with the
timestamp read as UTC and as local civil time at that candidate. The result is a weak prior.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Literal
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from pvlib import solarposition

from ..pano import INITIAL_YAWS
from .base import ToolContext, ToolResult

Interpretation = Literal["utc", "local"]

MAX_CANDIDATES = 10
CONSISTENT_DEG = 5.0
WEAK_DEG = 12.0
HIGH_SUN_DEG = 70.0  # above this the sun's azimuth barely constrains the heading

_COMPASS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")

# Approximate Portugal/Spain border, good to a few km: (latitude -> easternmost Portuguese
# longitude) and (longitude -> northernmost Portuguese latitude). Only decides a 1 h offset.
_PT_EAST_LAT = (36.9, 37.5, 37.9, 38.1, 38.4, 38.8, 39.0, 39.4, 39.66, 39.7, 40.0, 40.6, 41.0, 41.3, 41.5, 41.95)
_PT_EAST_LNG = (-7.40, -7.47, -7.27, -6.93, -7.30, -7.22, -6.95, -7.31, -7.53, -7.00, -6.93, -6.80, -6.93, -6.50, -6.20, -6.55)
_PT_NORTH_LNG = (-8.9, -8.75, -8.6, -8.2, -8.1, -8.0, -7.7, -7.2, -7.0, -6.5)
_PT_NORTH_LAT = (41.87, 41.93, 42.05, 42.15, 42.05, 41.88, 41.90, 41.83, 41.97, 41.95)
# Pyrenees: longitude -> latitude of the Spain/France border.
_PYRENEES_LNG = (-1.8, -1.4, -0.7, 0.0, 0.7, 1.5, 2.0, 3.2)
_PYRENEES_LAT = (43.35, 43.05, 42.90, 42.70, 42.85, 42.60, 42.40, 42.43)


@dataclass(frozen=True)
class SunReading:
    interpretation: Interpretation
    utc: str  # ISO instant this interpretation corresponds to
    sun_azimuth: float  # compass degrees, 0 = north, clockwise
    sun_elevation: float  # expected apparent elevation, degrees
    yaw0_heading: float  # compass heading of panorama yaw 0
    elevation_mismatch: float  # observed sun_pitch minus expected elevation
    plausible: bool  # False when the sun would be below the horizon (daylight is guaranteed)
    fit: Literal["consistent", "weak", "poor", "implausible"]
    zone: str = "UTC"  # the civil time zone a "local" reading assumed


def parse_timestamp(raw: str) -> datetime:
    """Naive datetime from the organisers' YYYYMMDDhhmmss (separators tolerated, seconds optional)."""
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 12:
        digits += "00"
    if len(digits) != 14:
        raise ValueError(f"expected YYYYMMDDhhmmss, got {raw!r}")
    return datetime.strptime(digits, "%Y%m%d%H%M%S")


def _in_mainland_portugal(lat: float, lng: float) -> bool:
    if not (36.9 <= lat <= 42.16 and -9.6 <= lng <= -6.15):
        return False
    east = float(np.interp(lat, _PT_EAST_LAT, _PT_EAST_LNG))
    north = float(np.interp(lng, _PT_NORTH_LNG, _PT_NORTH_LAT))
    return lng < east and lat < north


def timezone_for(lat: float, lng: float) -> str:
    """Civil time zone by a simple lon/lat rule covering Portugal, Spain, France and their islands."""
    if lng < -24.0:
        return "Atlantic/Azores"
    if 32.0 <= lat <= 33.6 and -17.6 <= lng <= -16.0:
        return "Atlantic/Madeira"
    if 27.0 <= lat <= 29.7 and -18.5 <= lng <= -13.0:
        return "Atlantic/Canary"
    if _in_mainland_portugal(lat, lng):
        return "Europe/Lisbon"
    if lng > 8.0 and lat > 41.3:  # Corsica
        return "Europe/Paris"
    if lat > float(np.interp(lng, _PYRENEES_LNG, _PYRENEES_LAT)) and (lng > -1.8 or lat > 43.8):
        return "Europe/Paris"
    return "Europe/Madrid"


# The border model above is good to a few km, and Portugal and Spain are an hour apart. Within this
# distance of the modelled border the local reading is given for both countries instead of
# trusting the model: towns such as Vila Real de Santo António and Valença sit on the line.
BORDER_MARGIN_M = 12_000.0
_IBERIAN_ZONES = frozenset({"Europe/Lisbon", "Europe/Madrid"})


def local_zones(lat: float, lng: float) -> list[str]:
    """Civil time zones the candidate may be in: one, or both Iberian ones close to the border."""
    zones = [timezone_for(lat, lng)]
    if zones[0] not in _IBERIAN_ZONES:
        return zones
    lng_scale = 111_320.0 * max(math.cos(math.radians(lat)), 0.01)
    for bearing in range(0, 360, 45):
        near_lat = lat + BORDER_MARGIN_M * math.cos(math.radians(bearing)) / 111_320.0
        near_lng = lng + BORDER_MARGIN_M * math.sin(math.radians(bearing)) / lng_scale
        if near_lat < 36.9 or near_lng < -9.6:
            continue  # open sea south or west of Portugal, not Spain
        other = timezone_for(near_lat, near_lng)
        if other in _IBERIAN_ZONES and other not in zones:
            zones.append(other)
    return zones


def solar_position(when_utc: datetime, lat: float, lng: float) -> tuple[float, float]:
    """(azimuth, apparent elevation) in degrees; azimuth is compass, clockwise from north."""
    times = pd.DatetimeIndex([when_utc.astimezone(timezone.utc)])
    row = solarposition.get_solarposition(times, lat, lng).iloc[0]
    return float(row["azimuth"]), float(row["apparent_elevation"])


def compass_name(heading: float) -> str:
    return _COMPASS[round((heading % 360) / 45) % 8]


def view_bearings(yaw0_heading: float) -> dict[int, float]:
    """Compass bearing of the centre of each initial view, keyed by its yaw."""
    return {yaw: round((yaw0_heading + yaw) % 360, 1) for yaw in INITIAL_YAWS}


def _fit(mismatch: float, plausible: bool) -> Literal["consistent", "weak", "poor", "implausible"]:
    if not plausible:
        return "implausible"
    if abs(mismatch) <= CONSISTENT_DEG:
        return "consistent"
    return "weak" if abs(mismatch) <= WEAK_DEG else "poor"


def sun_reading(
    interpretation: Interpretation,
    when_utc: datetime,
    lat: float,
    lng: float,
    sun_yaw: float,
    sun_pitch: float,
    zone: str = "UTC",
) -> SunReading:
    azimuth, elevation = solar_position(when_utc, lat, lng)
    mismatch = sun_pitch - elevation
    plausible = elevation > 0
    return SunReading(
        interpretation=interpretation,
        utc=when_utc.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        sun_azimuth=round(azimuth, 1),
        sun_elevation=round(elevation, 1),
        yaw0_heading=round((azimuth - sun_yaw) % 360, 1),
        elevation_mismatch=round(mismatch, 1),
        plausible=plausible,
        fit=_fit(mismatch, plausible),
        zone=zone,
    )


def candidate_readings(
    stamp: datetime, lat: float, lng: float, sun_yaw: float, sun_pitch: float
) -> tuple[str, list[SunReading]]:
    """Zone name and the readings for one candidate: UTC first, then local civil time unless the
    two are the same instant. Near the Portugal/Spain border there is one local reading per
    country, since the two are an hour apart and the border model is only approximate."""
    zones = local_zones(lat, lng)
    as_utc = stamp.replace(tzinfo=timezone.utc)
    readings = [sun_reading("utc", as_utc, lat, lng, sun_yaw, sun_pitch)]
    seen = {as_utc}
    for zone in zones:
        as_local = stamp.replace(tzinfo=ZoneInfo(zone)).astimezone(timezone.utc)
        if as_local not in seen:
            seen.add(as_local)
            readings.append(sun_reading("local", as_local, lat, lng, sun_yaw, sun_pitch, zone))
    return zones[0], readings


def _circular_summary(headings: list[float]) -> tuple[float, float]:
    """(circular mean, largest deviation from it) in degrees."""
    radians = np.radians(headings)
    mean = math.degrees(math.atan2(np.sin(radians).mean(), np.cos(radians).mean())) % 360
    spread = max(abs((h - mean + 180) % 360 - 180) for h in headings)
    return mean, spread


def _reading_lines(reading: SunReading, zone: str, same_instant: bool) -> list[str]:
    if same_instant:
        title = f"read as UTC or as local time ({zone} is on UTC then)"
    elif reading.interpretation == "utc":
        title = "read as UTC"
    else:
        title = f"read as local time ({reading.zone if reading.zone != 'UTC' else zone})"
    head = f"  Timestamp {title} = {reading.utc}:"
    if not reading.plausible:
        return [
            f"{head} the sun would be {abs(reading.sun_elevation):.1f} deg below the horizon. IMPLAUSIBLE: "
            "the panorama was taken in daylight, so this reading (or this candidate) is wrong."
        ]
    direction = "higher" if reading.elevation_mismatch > 0 else "lower"
    bearings = ", ".join(
        f"yaw {yaw} = {bearing:.0f} ({compass_name(bearing)})"
        for yaw, bearing in view_bearings(reading.yaw0_heading).items()
    )
    return [
        f"{head} sun at compass azimuth {reading.sun_azimuth:.1f} ({compass_name(reading.sun_azimuth)}), "
        f"expected elevation {reading.sun_elevation:.1f}.",
        f"    Panorama yaw 0 faces compass {reading.yaw0_heading:.1f} ({compass_name(reading.yaw0_heading)}). "
        f"Observed sun is {abs(reading.elevation_mismatch):.1f} deg {direction} than expected: "
        f"{reading.fit} fit.",
        f"    Initial views: {bearings}.",
    ]


def _summary_lines(results: list[dict[str, Any]]) -> list[str]:
    lines = ["Summary:"]
    for interpretation, name in (("utc", "UTC"), ("local", "local time")):
        headings = [
            r["yaw0_heading"]
            for result in results
            for r in result["readings"]
            if r["plausible"] and (r["interpretation"] == interpretation or len(result["readings"]) == 1)
        ]
        if not headings:
            lines.append(f"  Timestamp as {name}: no candidate has the sun above the horizon; implausible.")
            continue
        mean, spread = _circular_summary(headings)
        lines.append(
            f"  Timestamp as {name}: panorama yaw 0 faces about compass {mean:.0f} ({compass_name(mean)}), "
            f"within {spread:.0f} deg across {len(headings)} plausible candidate(s)."
        )
    lines.append(
        "  To convert any panorama yaw to a compass bearing add the yaw-0 heading (mod 360). The time zone "
        "of the timestamp is unknown and sun elevation changes slowly with location, so treat fit "
        "differences between candidates as a weak prior; the heading is the useful output."
    )
    return lines


def _parse_candidates(raw: Any) -> list[tuple[float, float]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("candidates must be a non-empty list of {lat, lng}")
    if len(raw) > MAX_CANDIDATES:
        raise ValueError(f"at most {MAX_CANDIDATES} candidates per call, got {len(raw)}")
    points: list[tuple[float, float]] = []
    for index, item in enumerate(raw, start=1):
        lat, lng = (item.get("lat"), item.get("lng")) if isinstance(item, dict) else (None, None)
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (lat, lng)):
            raise ValueError(f"candidate {index} needs numeric lat and lng")
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError(f"candidate {index} is out of range (lat {lat}, lng {lng})")
        points.append((float(lat), float(lng)))
    return points


def _parse_sun(args: dict[str, Any]) -> tuple[float, float]:
    yaw, pitch = args.get("sun_yaw"), args.get("sun_pitch")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (yaw, pitch)):
        raise ValueError("sun_yaw and sun_pitch must be finite numbers")
    if not -90 <= pitch <= 90:
        raise ValueError(f"sun_pitch must be between -90 and 90, got {pitch}")
    return float(yaw) % 360, float(pitch)


async def run(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    raw_stamp = ctx.session.task.timestamp
    if not raw_stamp:
        return ToolResult.error(
            "sun_position: this panorama has no capture timestamp, so the sun cannot give a compass "
            "heading. Use shadows only qualitatively (in PT/ES/FR the midday sun is in the south) and "
            "orient the scene from map features instead."
        )
    try:
        stamp = parse_timestamp(raw_stamp)
        sun_yaw, sun_pitch = _parse_sun(args)
        points = _parse_candidates(args.get("candidates"))
    except ValueError as exc:
        return ToolResult.error(f"sun_position: {exc}.")

    lines = [
        f"Sun observed at panorama yaw {sun_yaw:.1f}, pitch {sun_pitch:+.1f}. Capture timestamp "
        f"{stamp:%Y-%m-%d %H:%M:%S} (time zone not stated)."
    ]
    results: list[dict[str, Any]] = []
    for index, (lat, lng) in enumerate(points, start=1):
        zone, readings = candidate_readings(stamp, lat, lng, sun_yaw, sun_pitch)
        lines.append(f"Candidate {index} ({lat:.5f}, {lng:.5f}):")
        if sum(r.interpretation == "local" for r in readings) > 1:
            lines.append(
                "  This point is within about 10 km of the Portugal/Spain border, where local time differs "
                "by an hour; the local reading is given for both countries."
            )
        for reading in readings:
            lines.extend(_reading_lines(reading, zone, same_instant=len(readings) == 1))
        results.append(
            {"lat": lat, "lng": lng, "timezone": zone, "readings": [asdict(reading) for reading in readings]}
        )
    if sun_pitch > HIGH_SUN_DEG:
        lines.append(
            f"Caution: the sun is above {HIGH_SUN_DEG:.0f} deg, where a small error in its position "
            "swings the heading a lot."
        )
    lines.extend(_summary_lines(results))
    return ToolResult.text(
        "\n".join(lines), sun_yaw=sun_yaw, sun_pitch=sun_pitch, timestamp=raw_stamp, candidates=results
    )
