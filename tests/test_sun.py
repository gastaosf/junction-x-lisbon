from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from astrolabio.tools import sun
from astrolabio.tools.sun import (
    candidate_readings,
    compass_name,
    parse_timestamp,
    solar_position,
    timezone_for,
    view_bearings,
)

LISBON = (38.7223, -9.1393)
MADRID = (40.4168, -3.7038)
PARIS = (48.8566, 2.3522)


def utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=timezone.utc)


def ctx_for(timestamp: str | None) -> SimpleNamespace:
    task = SimpleNamespace(timestamp=timestamp)
    return SimpleNamespace(session=SimpleNamespace(task=task), pano=None, settings=None, http=None)


def test_solar_noon_on_the_greenwich_meridian_at_equinox() -> None:
    # 20 March 2026: equation of time is about -7.4 min, so solar noon at lng 0 is ~12:07 UTC and
    # the sun stands due south at elevation 90 - latitude (declination ~0).
    azimuth, elevation = solar_position(utc(2026, 3, 20, 12, 7, 26), 40.0, 0.0)
    assert azimuth == pytest.approx(180.0, abs=0.5)
    assert elevation == pytest.approx(50.0, abs=0.5)


def test_solar_noon_shifts_four_minutes_per_degree_of_longitude() -> None:
    # Lisbon is 9.14 deg west: solar noon is 36.6 min later than at Greenwich.
    azimuth, elevation = solar_position(utc(2026, 3, 20, 12, 44, 0), *LISBON)
    assert azimuth == pytest.approx(180.0, abs=0.5)
    assert elevation == pytest.approx(90 - LISBON[0], abs=0.5)


def test_solstice_noon_elevations() -> None:
    _, summer = solar_position(utc(2026, 6, 21, 12, 2, 0), 40.0, 0.0)
    _, winter = solar_position(utc(2026, 12, 21, 11, 58, 0), 40.0, 0.0)
    assert summer == pytest.approx(90 - 40 + 23.44, abs=0.4)
    assert winter == pytest.approx(90 - 40 - 23.44, abs=0.4)


def test_morning_sun_is_east_and_evening_sun_is_west() -> None:
    morning, _ = solar_position(utc(2026, 10, 11, 8, 0, 0), *LISBON)
    evening, _ = solar_position(utc(2026, 10, 11, 17, 0, 0), *LISBON)
    assert 90 < morning < 150
    assert 230 < evening < 270


@pytest.mark.parametrize(
    ("lat", "lng", "zone"),
    [
        (*LISBON, "Europe/Lisbon"),
        (41.1579, -8.6291, "Europe/Lisbon"),  # Porto
        (37.0194, -7.9304, "Europe/Lisbon"),  # Faro
        (41.8061, -6.7567, "Europe/Lisbon"),  # Braganca
        (38.8794, -7.1634, "Europe/Lisbon"),  # Elvas
        (38.8794, -6.9707, "Europe/Madrid"),  # Badajoz
        (42.2406, -8.7207, "Europe/Madrid"),  # Vigo
        (37.3891, -5.9845, "Europe/Madrid"),  # Seville
        (43.3623, -8.4115, "Europe/Madrid"),  # A Coruna
        (43.2630, -2.9350, "Europe/Madrid"),  # Bilbao
        (41.3874, 2.1686, "Europe/Madrid"),  # Barcelona
        (39.5696, 2.6502, "Europe/Madrid"),  # Palma
        (*MADRID, "Europe/Madrid"),
        (*PARIS, "Europe/Paris"),
        (43.4832, -1.5586, "Europe/Paris"),  # Biarritz
        (42.6887, 2.8948, "Europe/Paris"),  # Perpignan
        (48.3904, -4.4861, "Europe/Paris"),  # Brest
        (41.9192, 8.7386, "Europe/Paris"),  # Ajaccio
        (37.7412, -25.6756, "Atlantic/Azores"),  # Ponta Delgada
        (32.6669, -16.9241, "Atlantic/Madeira"),  # Funchal
        (28.1235, -15.4363, "Atlantic/Canary"),  # Las Palmas
    ],
)
def test_timezone_rule(lat: float, lng: float, zone: str) -> None:
    assert timezone_for(lat, lng) == zone


def test_parse_timestamp() -> None:
    assert parse_timestamp("20261011093000") == datetime(2026, 10, 11, 9, 30, 0)
    assert parse_timestamp("2026-10-11 09:30:00") == datetime(2026, 10, 11, 9, 30, 0)
    assert parse_timestamp("202610110930") == datetime(2026, 10, 11, 9, 30, 0)
    for bad in ("", "2026", "20261341093000"):
        with pytest.raises(ValueError):
            parse_timestamp(bad)


def test_compass_names_and_view_bearings() -> None:
    assert [compass_name(h) for h in (0, 44, 90, 180, 225, 337, 338, 359.9)] == [
        "N", "NE", "E", "S", "SW", "NW", "N", "N",
    ]
    bearings = view_bearings(350.0)
    assert list(bearings) == [0, 45, 90, 135, 180, 225, 270, 315]
    assert bearings[0] == 350.0 and bearings[45] == 35.0 and bearings[315] == 305.0


def test_readings_differ_by_the_utc_offset() -> None:
    # 11 Oct 2026 is still summer time: Lisbon = UTC+1, Madrid = UTC+2.
    stamp = parse_timestamp("20261011130000")
    zone, readings = candidate_readings(stamp, *LISBON, sun_yaw=100.0, sun_pitch=40.0)
    assert zone == "Europe/Lisbon"
    assert [r.interpretation for r in readings] == ["utc", "local"]
    assert readings[0].utc == "2026-10-11T13:00:00Z"
    assert readings[1].utc == "2026-10-11T12:00:00Z"

    _, madrid = candidate_readings(stamp, *MADRID, sun_yaw=100.0, sun_pitch=40.0)
    assert madrid[1].utc == "2026-10-11T11:00:00Z"


def test_heading_is_azimuth_minus_sun_yaw() -> None:
    stamp = parse_timestamp("20260320124400")  # solar noon in Lisbon when read as UTC
    _, readings = candidate_readings(stamp, *LISBON, sun_yaw=100.0, sun_pitch=51.3)
    as_utc = readings[0]
    assert as_utc.sun_azimuth == pytest.approx(180.0, abs=0.5)
    assert as_utc.yaw0_heading == pytest.approx(80.0, abs=0.5)
    assert as_utc.elevation_mismatch == pytest.approx(0.0, abs=0.5)
    assert as_utc.fit == "consistent" and as_utc.plausible

    _, wrapped = candidate_readings(stamp, *LISBON, sun_yaw=270.0, sun_pitch=20.0)
    assert wrapped[0].yaw0_heading == pytest.approx(270.0, abs=0.5)
    assert wrapped[0].elevation_mismatch == pytest.approx(-31.3, abs=0.5)
    assert wrapped[0].fit == "poor"


def test_zone_on_utc_gives_a_single_reading() -> None:
    stamp = parse_timestamp("20260115120000")  # winter: Lisbon is on UTC
    zone, readings = candidate_readings(stamp, *LISBON, sun_yaw=0.0, sun_pitch=30.0)
    assert zone == "Europe/Lisbon" and len(readings) == 1


def test_night_interpretation_is_flagged_implausible() -> None:
    # 06:30 on 11 Oct: as UTC the sun is just up in Lisbon (07:30 local); as Lisbon local time it is
    # 05:30 UTC, well before sunrise.
    stamp = parse_timestamp("20261011070000")
    _, readings = candidate_readings(stamp, *LISBON, sun_yaw=10.0, sun_pitch=3.0)
    by_name = {r.interpretation: r for r in readings}
    assert by_name["utc"].plausible and by_name["utc"].sun_elevation > 0
    assert not by_name["local"].plausible
    assert by_name["local"].fit == "implausible" and by_name["local"].sun_elevation < 0


async def test_run_reports_every_candidate_and_interpretation() -> None:
    args = {
        "sun_yaw": 460.0,  # wraps to 100
        "sun_pitch": 38.0,
        "candidates": [{"lat": LISBON[0], "lng": LISBON[1]}, {"lat": PARIS[0], "lng": PARIS[1]}],
    }
    result = await sun.run(ctx_for("20261011130000"), args)
    assert not result.is_error
    text = result.content[0]["text"]
    assert "Candidate 1" in text and "Candidate 2" in text
    assert "read as UTC" in text and "read as local time (Europe/Lisbon)" in text
    assert "read as local time (Europe/Paris)" in text
    assert "Initial views: yaw 0 = " in text and "yaw 315 = " in text
    assert "Summary:" in text and "Timestamp as UTC" in text and "Timestamp as local time" in text

    log = result.log
    assert log["sun_yaw"] == 100.0
    assert [c["timezone"] for c in log["candidates"]] == ["Europe/Lisbon", "Europe/Paris"]
    for candidate in log["candidates"]:
        assert [r["interpretation"] for r in candidate["readings"]] == ["utc", "local"]
        for reading in candidate["readings"]:
            assert reading["yaw0_heading"] == pytest.approx((reading["sun_azimuth"] - 100.0) % 360, abs=0.11)
            assert reading["elevation_mismatch"] == pytest.approx(38.0 - reading["sun_elevation"], abs=0.11)


async def test_run_flags_night_reading_in_text() -> None:
    args = {"sun_yaw": 10.0, "sun_pitch": 3.0, "candidates": [{"lat": LISBON[0], "lng": LISBON[1]}]}
    result = await sun.run(ctx_for("20261011070000"), args)
    assert not result.is_error
    assert "IMPLAUSIBLE" in result.content[0]["text"]
    assert "below the horizon" in result.content[0]["text"]


async def test_run_without_timestamp_is_a_helpful_error() -> None:
    args = {"sun_yaw": 10.0, "sun_pitch": 30.0, "candidates": [{"lat": 38.0, "lng": -9.0}]}
    for missing in (None, ""):
        result = await sun.run(ctx_for(missing), args)
        assert result.is_error
        assert "no capture timestamp" in result.content[0]["text"]


@pytest.mark.parametrize(
    "args",
    [
        {"sun_yaw": 10.0, "sun_pitch": 30.0, "candidates": []},
        {"sun_yaw": 10.0, "sun_pitch": 30.0},
        {"sun_yaw": 10.0, "sun_pitch": 30.0, "candidates": [{"lat": 95.0, "lng": 0.0}]},
        {"sun_yaw": 10.0, "sun_pitch": 30.0, "candidates": [{"lat": 38.0}]},
        {"sun_yaw": 10.0, "sun_pitch": 30.0, "candidates": [{"lat": 38.0, "lng": -9.0}] * 11},
        {"sun_yaw": "east", "sun_pitch": 30.0, "candidates": [{"lat": 38.0, "lng": -9.0}]},
        {"sun_yaw": 10.0, "sun_pitch": 130.0, "candidates": [{"lat": 38.0, "lng": -9.0}]},
    ],
)
async def test_run_rejects_bad_input(args: dict) -> None:
    result = await sun.run(ctx_for("20261011130000"), args)
    assert result.is_error


async def test_run_rejects_a_malformed_timestamp() -> None:
    args = {"sun_yaw": 10.0, "sun_pitch": 30.0, "candidates": [{"lat": 38.0, "lng": -9.0}]}
    result = await sun.run(ctx_for("yesterday"), args)
    assert result.is_error and "YYYYMMDDhhmmss" in result.content[0]["text"]


# --- the Portugal/Spain border: an hour apart, and the border model is only approximate ---------------


@pytest.mark.parametrize(
    ("name", "lat", "lng"),
    [
        ("Vila Real de Santo Antonio (PT)", 37.194, -7.416),
        ("Valenca (PT)", 42.03, -8.645),
        ("Fuentes de Onoro (ES)", 40.59, -6.81),
        ("Rosal de la Frontera (ES)", 37.97, -7.22),
        ("Elvas (PT)", 38.881, -7.163),
        ("Badajoz (ES)", 38.879, -6.970),
    ],
)
def test_border_towns_get_a_local_reading_for_both_countries(name: str, lat: float, lng: float) -> None:
    assert set(sun.local_zones(lat, lng)) == {"Europe/Lisbon", "Europe/Madrid"}, name
    _, readings = candidate_readings(datetime(2026, 10, 11, 11, 0, 0), lat, lng, 120.0, 35.0)
    local = [r for r in readings if r.interpretation == "local"]
    # 11:00 in Lisbon (WEST, UTC+1) is 10:00 UTC; 11:00 in Madrid (CEST, UTC+2) is 09:00 UTC.
    assert {r.zone: r.utc for r in local} == {
        "Europe/Lisbon": "2026-10-11T10:00:00Z",
        "Europe/Madrid": "2026-10-11T09:00:00Z",
    }
    assert abs(local[0].yaw0_heading - local[1].yaw0_heading) > 8  # the hour matters for the heading


@pytest.mark.parametrize(
    ("lat", "lng", "zone"),
    [
        (38.7223, -9.1393, "Europe/Lisbon"),  # Lisbon
        (38.78, -9.50, "Europe/Lisbon"),  # Cabo da Roca: sea to the west is not Spain
        (37.01, -8.94, "Europe/Lisbon"),  # Sagres: sea to the south is not Spain
        (41.15, -8.61, "Europe/Lisbon"),  # Porto
        (40.4168, -3.7038, "Europe/Madrid"),
        (37.39, -5.99, "Europe/Madrid"),  # Seville
        (48.8566, 2.3522, "Europe/Paris"),
        (37.74, -25.67, "Atlantic/Azores"),
    ],
)
def test_places_away_from_the_border_keep_a_single_zone(lat: float, lng: float, zone: str) -> None:
    assert sun.local_zones(lat, lng) == [zone]


async def test_sun_tool_explains_the_two_local_readings_at_the_border() -> None:
    args = {"sun_yaw": 120.0, "sun_pitch": 35.0, "candidates": [{"lat": 37.194, "lng": -7.416}]}
    result = await sun.run(ctx_for("20261011110000"), args)
    text = result.content[0]["text"]
    assert "within about 10 km of the Portugal/Spain border" in text
    assert "read as local time (Europe/Lisbon)" in text and "read as local time (Europe/Madrid)" in text
    assert [r["zone"] for r in result.log["candidates"][0]["readings"]] == ["UTC", "Europe/Madrid", "Europe/Lisbon"]
