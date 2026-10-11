"""Answer construction (SPEC 7.1) and the multi-modality test of the question gate (SPEC 7.2).

Two refinements of the SPEC 7.1 pseudo-code, both reducing to it exactly in its own setting:

- radius_m is honoured. The tool schema defines a hypothesis as "the camera stood within radius_m
  of this point with this probability", so its mass is spread over that disc when a candidate is
  valued. With every radius at or below the 10 m snap distance this is the SPEC's point-mass
  formula v_i = SUM_j p_j * theta(d(x_i, x_j)). Without it a vague "somewhere in this town" entry
  with a large radius outranks a verified exact spot that has slightly less probability.
- With HEDGE on, x_2 is the best candidate outside x_1's tight cluster (SPEC 3.1 point 3 treats
  such a cluster as one candidate). Taking the literal second-ranked entry puts the hedge slots a
  few metres from x_1, which costs expectation and hedges nothing.
"""

from __future__ import annotations

import math
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from itertools import count

from .schema import Hypothesis, Label
from .scoring import MAX_ENTRIES, MCQ_FACTOR, SNAP_DISTANCE_M, haversine_m, theta

DECIMALS = 6
HEDGE_RHO_LOW = 0.67
HEDGE_RHO_HIGH = 0.9
# Two hypotheses count as separate modes for the question gate when they are at least this many
# scales s apart (theta of one seen from the other is then <= 0.5, a quarter of the maximum).
MCQ_FAR_SCALES = 3.0
# 2e-5 degrees is about 2 m: distinct at 6 decimals, yet nine pads stay inside the 10 m snap of x_1.
PAD_STEP_DEG = 2e-5
_PAD_DIRECTIONS = [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (-1, -1), (1, -1)]

# A hypothesis no wider than the snap distance is a point mass; wider ones are sampled on a
# sunflower pattern, which covers the disc evenly and is deterministic.
POINT_RADIUS_M = SNAP_DISTANCE_M
DISC_SAMPLES = 48
_GOLDEN_ANGLE = math.pi * (3.0 - math.sqrt(5.0))
_M_PER_DEG = 111_320.0

Point = tuple[float, float]
Weighted = tuple[float, float, float]  # lat, lng, normalised probability
Mass = tuple[float, tuple[Point, ...]]  # normalised probability, points it is spread over


@dataclass
class AllocationResult:
    points: list[Point]
    ranked: list[dict]
    rho: float | None
    hedge: bool
    allow_duplicates: bool
    plan: str

    def settings_dict(self) -> dict:
        return {
            "hedge": self.hedge,
            "allow_duplicates": self.allow_duplicates,
            "plan": self.plan,
            "rho": self.rho,
        }


def _round_point(lat: float, lng: float) -> Point:
    return (round(lat, DECIMALS), round(lng, DECIMALS))


def _weighted_points(hypotheses: Sequence[Hypothesis]) -> list[Weighted]:
    """Distinct 6-decimal points with normalised probabilities (all-zero => uniform)."""
    if not hypotheses:
        raise ValueError("allocate needs at least one hypothesis")
    total = sum(h.probability for h in hypotheses)
    mass: dict[Point, float] = {}
    for h in hypotheses:
        p = h.probability / total if total > 0 else 1.0 / len(hypotheses)
        key = _round_point(h.lat, h.lng)
        mass[key] = mass.get(key, 0.0) + p
    return [(lat, lng, p) for (lat, lng), p in mass.items()]


def _disc_points(lat: float, lng: float, radius_m: float) -> tuple[Point, ...]:
    """Points standing for "somewhere within radius_m of (lat, lng)", uniform over the disc."""
    if not radius_m > POINT_RADIUS_M:
        return ((lat, lng),)
    lng_scale = _M_PER_DEG * max(math.cos(math.radians(lat)), 0.01)
    points = []
    for k in range(DISC_SAMPLES):
        r = radius_m * math.sqrt((k + 0.5) / DISC_SAMPLES)
        angle = k * _GOLDEN_ANGLE
        sample_lat = max(-90.0, min(90.0, lat + r * math.cos(angle) / _M_PER_DEG))
        points.append((sample_lat, lng + r * math.sin(angle) / lng_scale))
    return tuple(points)


def _masses(hypotheses: Sequence[Hypothesis]) -> list[Mass]:
    """Each hypothesis as probability spread over its radius (all-zero probabilities => uniform)."""
    if not hypotheses:
        raise ValueError("allocate needs at least one hypothesis")
    total = sum(h.probability for h in hypotheses)
    return [
        (
            h.probability / total if total > 0 else 1.0 / len(hypotheses),
            _disc_points(round(h.lat, DECIMALS), round(h.lng, DECIMALS), h.radius_m),
        )
        for h in hypotheses
    ]


def _value(point: Point, masses: Sequence[Mass], label: Label) -> float:
    """Expected theta of pinning `point` when the camera is distributed as `masses` say."""
    return sum(
        p * sum(theta(haversine_m(point[0], point[1], lat, lng), label) for lat, lng in spread) / len(spread)
        for p, spread in masses
    )


def value_at(lat: float, lng: float, hypotheses: Sequence[Hypothesis], label: Label) -> float:
    """Expected theta v of pinning (lat, lng) under the normalised hypotheses."""
    return _value((lat, lng), _masses(hypotheses), label)


def _groups(weighted: Sequence[Weighted], radius_m: float) -> list[list[Weighted]]:
    """Single-linkage groups of points closer than radius_m; a point with no neighbour is its own group."""
    parent = list(range(len(weighted)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, (lat_i, lng_i, _) in enumerate(weighted):
        for j in range(i + 1, len(weighted)):
            if haversine_m(lat_i, lng_i, weighted[j][0], weighted[j][1]) < radius_m:
                parent[find(j)] = find(i)
    groups: dict[int, list[Weighted]] = {}
    for i, item in enumerate(weighted):
        groups.setdefault(find(i), []).append(item)
    return list(groups.values())


def _clusters(weighted: Sequence[Weighted], radius_m: float) -> list[list[Weighted]]:
    """Single-linkage groups of two or more points closer than radius_m."""
    return [g for g in _groups(weighted, radius_m) if len(g) > 1]


def _centroid(cluster: Sequence[Weighted]) -> Point:
    """Probability-weighted mean on the unit sphere, so it is safe across the antimeridian."""
    total = sum(p for _, _, p in cluster)
    x = y = z = 0.0
    for lat, lng, p in cluster:
        w = p / total if total > 0 else 1.0 / len(cluster)
        phi, lmb = math.radians(lat), math.radians(lng)
        x += w * math.cos(phi) * math.cos(lmb)
        y += w * math.cos(phi) * math.sin(lmb)
        z += w * math.sin(phi)
    return _round_point(math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x)))


def _ranked_candidates(weighted: Sequence[Weighted], masses: Sequence[Mass], label: Label) -> list[dict]:
    sources: dict[Point, str] = {(lat, lng): "hypothesis" for lat, lng, _ in weighted}
    for cluster in _clusters(weighted, label.cluster_radius_m):
        sources.setdefault(_centroid(cluster), "centroid")
    ranked = [
        {"lat": lat, "lng": lng, "v": _value((lat, lng), masses, label), "source": source}
        for (lat, lng), source in sources.items()
    ]
    ranked.sort(key=lambda c: -c["v"])
    return ranked


def _pad_points(origin: Point) -> Iterator[Point]:
    for ring in count(1):
        for dy, dx in _PAD_DIRECTIONS:
            lat = origin[0] + ring * PAD_STEP_DEG * dy
            lng = origin[1] + ring * PAD_STEP_DEG * dx
            if -90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0:
                yield _round_point(lat, lng)


def _distinct_points(ranked: Sequence[dict], masses: Sequence[Mass], label: Label) -> list[Point]:
    valued = [((c["lat"], c["lng"]), c["v"]) for c in ranked[:MAX_ENTRIES]]
    taken = {point for point, _ in valued}
    pads = _pad_points(valued[0][0])
    while len(valued) < MAX_ENTRIES:
        pad = next(pads)
        if pad not in taken:
            taken.add(pad)
            valued.append((pad, _value(pad, masses, label)))
    valued.sort(key=lambda item: -item[1])
    return [point for point, _ in valued]


def _hedge_split(rho: float | None, hedge: bool) -> tuple[int, str]:
    if not hedge or rho is None or rho < HEDGE_RHO_LOW:
        return MAX_ENTRIES, "10x1"
    if rho < HEDGE_RHO_HIGH:
        return 8, "8x1+2x2"
    return 6, "6x1+4x2"


def allocate(
    hypotheses: Sequence[Hypothesis],
    label: Label,
    *,
    hedge: bool = False,
    allow_duplicates: bool = True,
) -> AllocationResult:
    weighted = _weighted_points(hypotheses)
    masses = _masses(hypotheses)
    ranked = _ranked_candidates(weighted, masses, label)
    top = (ranked[0]["lat"], ranked[0]["lng"])
    # x_2 is a different place, not another member (or the centroid) of x_1's own tight cluster.
    second = next(
        (c for c in ranked[1:] if haversine_m(top[0], top[1], c["lat"], c["lng"]) >= label.cluster_radius_m),
        None,
    )
    rho = second["v"] / ranked[0]["v"] if second is not None and ranked[0]["v"] > 0 else None
    if allow_duplicates:
        first, plan = _hedge_split(rho, hedge)
        points = [top] * first
        if first < MAX_ENTRIES and second is not None:
            points += [(second["lat"], second["lng"])] * (MAX_ENTRIES - first)
    else:
        points, plan = _distinct_points(ranked, masses, label), "distinct"
    return AllocationResult(
        points=points, ranked=ranked, rho=rho, hedge=hedge, allow_duplicates=allow_duplicates, plan=plan
    )


def _mode_masses(weighted: Sequence[Weighted], far_m: float) -> list[float]:
    """Greedy modes: each point, most probable first, joins the first mode whose seed is nearer than far_m."""
    modes: list[tuple[Point, float]] = []
    for lat, lng, p in sorted(weighted, key=lambda w: -w[2]):
        for i, (seed, mass) in enumerate(modes):
            if haversine_m(lat, lng, seed[0], seed[1]) < far_m:
                modes[i] = (seed, mass + p)
                break
        else:
            modes.append(((lat, lng), p))
    return sorted((mass for _, mass in modes), reverse=True)


def mcq_gate(
    hypotheses: Sequence[Hypothesis],
    label: Label,
    *,
    accuracy: float = 0.9,
    max_options: int = 4,
) -> tuple[bool, str]:
    if not hypotheses:
        return False, "no hypotheses yet"
    masses = _mode_masses(_weighted_points(hypotheses), MCQ_FAR_SCALES * label.scale_m)
    if len(masses) < 2:
        return False, f"hypotheses form a single mode (all within {MCQ_FAR_SCALES * label.scale_m:.0f} m)"
    k = min(max_options, len(masses))
    gain = MCQ_FACTOR * accuracy * sum(masses[:k])
    verdict = (
        f"{MCQ_FACTOR} * {accuracy} * (p_1+..+p_{k} = {sum(masses[:k]):.3f}) = {gain:.3f} "
        f"{'>' if gain > masses[0] else '<='} p_1 = {masses[0]:.3f}"
    )
    if gain > masses[0]:
        return True, f"multi-modal posterior: {verdict}"
    return False, f"top mode dominates: {verdict}"


def describe(hypotheses: Sequence[Hypothesis], label: Label, *, accuracy: float = 0.9) -> dict:
    """What an operator needs to judge a belief at a glance: how many distinct places it names, how
    far apart the two likeliest are, and whether the question gate of SPEC 7.2 would pass.

    A place is a tight cluster as the allocator sees it (label.cluster_radius_m). cluster_points
    carry the probabilities as the agent gave them, summed, so they read against the hypothesis
    table; the gate itself normalises, as allocate does."""
    multimodal, gate_reason = mcq_gate(hypotheses, label, accuracy=accuracy)
    if not hypotheses:
        return {"clusters": 0, "top_gap_m": None, "multimodal": multimodal, "gate_reason": gate_reason, "cluster_points": []}
    raw: dict[Point, float] = {}
    members: dict[Point, int] = {}
    for h in hypotheses:
        key = _round_point(h.lat, h.lng)
        raw[key] = raw.get(key, 0.0) + h.probability
        members[key] = members.get(key, 0) + 1
    points = []
    for group in _groups(_weighted_points(hypotheses), label.cluster_radius_m):
        lat, lng = _centroid(group) if len(group) > 1 else (group[0][0], group[0][1])
        points.append(
            {
                "lat": lat,
                "lng": lng,
                "probability": round(sum(raw[(g[0], g[1])] for g in group), DECIMALS),
                "members": sum(members[(g[0], g[1])] for g in group),
            }
        )
    points.sort(key=lambda c: -c["probability"])
    gap = (
        round(haversine_m(points[0]["lat"], points[0]["lng"], points[1]["lat"], points[1]["lng"]), 1)
        if len(points) > 1
        else None
    )
    return {
        "clusters": len(points),
        "top_gap_m": gap,
        "multimodal": multimodal,
        "gate_reason": gate_reason,
        "cluster_points": points,
    }
