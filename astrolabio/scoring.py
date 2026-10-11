"""Scoring model of SPEC section 3. The allocator and the evaluation harness both depend on it."""

from __future__ import annotations

import math
from collections.abc import Sequence

from .schema import Hypothesis, Label

EARTH_RADIUS_M = 6371008.8
SNAP_DISTANCE_M = 10.0
MAX_ENTRIES = 10
RANK_DECAY = 0.95
RANK_WEIGHTS: list[float] = [1000.0 * RANK_DECAY ** (r - 1) for r in range(1, MAX_ENTRIES + 1)]
CUE_FACTOR = 0.8
MCQ_FACTOR = 0.95
HUMAN_GEOCODE_FACTOR = 0.5
SPECIAL_MULTIPLIER = 3.0

Point = tuple[float, float]


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlmb = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, a)))


def effective_distance_m(d: float) -> float:
    return 0.0 if d < SNAP_DISTANCE_M else d


def theta(d_m: float, label: Label) -> float:
    return 2.0 / (1.0 + effective_distance_m(d_m) / label.scale_m)


def penalty_multiplier(cues: int, mcqs: int, human_geocodes: int) -> float:
    if min(cues, mcqs, human_geocodes) < 0:
        raise ValueError("penalty counts must be non-negative")
    raw = CUE_FACTOR**cues * MCQ_FACTOR**mcqs * HUMAN_GEOCODE_FACTOR**human_geocodes
    # Rounded so that logged multipliers read 0.9025, not 0.9024999999999999.
    return round(raw, 12)


def _per_entry_multipliers(multipliers: Sequence[float] | float, n: int) -> list[float]:
    if isinstance(multipliers, (int, float)):
        return [float(multipliers)] * n
    if len(multipliers) != n:
        raise ValueError(f"{len(multipliers)} multipliers for {n} entries")
    return [float(m) for m in multipliers]


def score_list(
    entries: Sequence[Point],
    truth: Point,
    label: Label,
    *,
    special: bool = False,
    multipliers: Sequence[float] | float = 1.0,
) -> float:
    if len(entries) > MAX_ENTRIES:
        raise ValueError(f"at most {MAX_ENTRIES} entries, got {len(entries)}")
    per_entry = _per_entry_multipliers(multipliers, len(entries))
    total = sum(
        weight * theta(haversine_m(lat, lng, truth[0], truth[1]), label) * mult
        for weight, (lat, lng), mult in zip(RANK_WEIGHTS, entries, per_entry)
    )
    return (SPECIAL_MULTIPLIER if special else 1.0) * total


def expected_value(
    entries: Sequence[Point],
    hypotheses: Sequence[Hypothesis],
    label: Label,
    *,
    special: bool = False,
    multipliers: Sequence[float] | float = 1.0,
) -> float:
    """Expectation of score_list with each hypothesis point as the truth, weighted by its probability as given."""
    return sum(
        h.probability * score_list(entries, (h.lat, h.lng), label, special=special, multipliers=multipliers)
        for h in hypotheses
    )
