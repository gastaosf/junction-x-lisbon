import math
import random

import pytest

from astrolabio.schema import Hypothesis, Label
from astrolabio.scoring import (
    EARTH_RADIUS_M,
    RANK_WEIGHTS,
    effective_distance_m,
    expected_value,
    haversine_m,
    penalty_multiplier,
    score_list,
    theta,
)

M_PER_DEG_LAT = 111_195.08
LISBON = (38.7223, -9.1393)
PORTO = (41.1579, -8.6291)
MADRID = (40.4168, -3.7038)
PARIS = (48.8566, 2.3522)


def north_of(point: tuple[float, float], d_m: float) -> tuple[float, float]:
    return (point[0] + d_m / M_PER_DEG_LAT, point[1])


def hyp(point: tuple[float, float], p: float) -> Hypothesis:
    return Hypothesis(lat=point[0], lng=point[1], probability=p)


# --- haversine -----------------------------------------------------------------------------------


def test_earth_radius() -> None:
    assert EARTH_RADIUS_M == 6371008.8


def test_one_degree_of_latitude() -> None:
    assert haversine_m(0, 0, 1, 0) == pytest.approx(111_195.08, abs=0.01)
    assert haversine_m(38, -9, 39, -9) == pytest.approx(111_195.08, abs=0.01)


def test_one_degree_of_longitude_on_the_equator_and_at_60_north() -> None:
    assert haversine_m(0, 0, 0, 1) == pytest.approx(111_195.08, abs=0.01)
    # Great circle, not the parallel: slightly shorter than 111195.08 * cos(60) = 55597.54.
    assert haversine_m(60, 0, 60, 1) == pytest.approx(55_597.01, abs=0.01)


def test_quarter_and_half_circumference() -> None:
    assert haversine_m(0, 0, 0, 90) == pytest.approx(10_007_557.22, abs=0.01)
    assert haversine_m(0, 0, 90, 0) == pytest.approx(10_007_557.22, abs=0.01)
    assert haversine_m(0, 0, 0, 180) == pytest.approx(20_015_114.44, abs=0.01)
    assert haversine_m(90, 0, -90, 0) == pytest.approx(20_015_114.44, abs=0.01)


# Reference values computed independently with the vector form atan2(|u x v|, u . v) * R.
@pytest.mark.parametrize(
    ("a", "b", "expected_m"),
    [
        (LISBON, PORTO, 274_295.88),
        (LISBON, MADRID, 502_447.92),
        (LISBON, PARIS, 1_452_935.86),
        (MADRID, PARIS, 1_052_893.70),
    ],
)
def test_city_pairs(a: tuple[float, float], b: tuple[float, float], expected_m: float) -> None:
    assert haversine_m(*a, *b) == pytest.approx(expected_m, abs=0.01)
    assert haversine_m(*b, *a) == pytest.approx(expected_m, abs=0.01)


def test_haversine_identity_and_antimeridian() -> None:
    assert haversine_m(*LISBON, *LISBON) == 0.0
    assert haversine_m(0, 179.5, 0, -179.5) == pytest.approx(111_195.08, abs=0.01)


# --- theta ---------------------------------------------------------------------------------------

THETA_TABLE = [
    (0.0, 2.000, 2.000),
    (9.99, 2.000, 2.000),
    (50.0, 1.333, 1.990),
    (100.0, 1.000, 1.980),
    (500.0, 0.333, 1.905),
    (1_000.0, 0.182, 1.818),
    (10_000.0, 0.020, 1.000),
    (50_000.0, 0.004, 0.333),
    (100_000.0, 0.002, 0.182),
]


@pytest.mark.parametrize(("d", "urban", "non_urban"), THETA_TABLE)
def test_theta_table(d: float, urban: float, non_urban: float) -> None:
    assert round(theta(d, Label.URBAN), 3) == urban
    assert round(theta(d, Label.NON_URBAN), 3) == non_urban


def test_snap_below_10_m() -> None:
    assert effective_distance_m(0) == 0
    assert effective_distance_m(9.999) == 0
    assert effective_distance_m(10) == 10
    assert effective_distance_m(10.001) == 10.001
    assert theta(9.999, Label.URBAN) == 2.0
    assert theta(10, Label.URBAN) == pytest.approx(2 / 1.1)
    assert theta(10, Label.NON_URBAN) == pytest.approx(2 / 1.001)


def test_theta_is_monotone_and_positive() -> None:
    for label in Label:
        values = [theta(d, label) for d in (0, 10, 11, 100, 1e3, 1e4, 1e5, 1e6, 2e7)]
        assert all(a >= b > 0 for a, b in zip(values, values[1:]))


# --- rank weights and maxima ---------------------------------------------------------------------


def test_rank_weights() -> None:
    assert len(RANK_WEIGHTS) == 10
    assert RANK_WEIGHTS[0] == 1000
    assert RANK_WEIGHTS[1] == pytest.approx(950)
    assert RANK_WEIGHTS[9] == pytest.approx(1000 * 0.95**9)
    assert round(sum(RANK_WEIGHTS) / 1000, 3) == 8.025


def test_maximum_scores() -> None:
    perfect = [LISBON] * 10
    for label in Label:
        assert score_list(perfect, LISBON, label) == pytest.approx(16_050, abs=1)
        assert score_list(perfect, LISBON, label, special=True) == pytest.approx(48_150, abs=3)
    assert score_list(perfect, LISBON, Label.URBAN, special=True) == pytest.approx(
        3 * score_list(perfect, LISBON, Label.URBAN)
    )


def test_exact_rank_one_hit_scores_2000() -> None:
    assert score_list([LISBON], LISBON, Label.URBAN) == pytest.approx(2000)


# --- score_list ----------------------------------------------------------------------------------


def test_score_list_hand_computed() -> None:
    truth = LISBON
    entries = [north_of(truth, 100), truth, north_of(truth, 500)]
    expected = 1000 * 1.0 + 950 * 2.0 + 902.5 * (2 / 6)
    assert score_list(entries, truth, Label.URBAN) == pytest.approx(expected, rel=1e-6)


def test_score_list_snaps_entries_within_10_m() -> None:
    assert score_list([north_of(LISBON, 9)] * 10, LISBON, Label.URBAN) == pytest.approx(
        score_list([LISBON] * 10, LISBON, Label.URBAN)
    )
    assert score_list([north_of(LISBON, 11)] * 10, LISBON, Label.URBAN) < 16_050 * 0.91


def test_score_list_multipliers() -> None:
    entries = [LISBON] * 10
    base = score_list(entries, LISBON, Label.URBAN)
    assert score_list(entries, LISBON, Label.URBAN, multipliers=0.8) == pytest.approx(0.8 * base)
    per_entry = [1.0] * 5 + [0.95] * 5
    expected = 2 * (sum(RANK_WEIGHTS[:5]) + 0.95 * sum(RANK_WEIGHTS[5:]))
    assert score_list(entries, LISBON, Label.URBAN, multipliers=per_entry) == pytest.approx(expected)


def test_score_list_rejects_bad_shapes() -> None:
    with pytest.raises(ValueError):
        score_list([LISBON] * 11, LISBON, Label.URBAN)
    with pytest.raises(ValueError):
        score_list([LISBON] * 3, LISBON, Label.URBAN, multipliers=[1.0, 1.0])


def test_empty_and_wrong_entries_are_never_negative() -> None:
    assert score_list([], LISBON, Label.URBAN) == 0
    assert score_list([PARIS] * 10, LISBON, Label.URBAN) > 0


def test_an_empty_slot_forfeits_8_to_12_percent() -> None:
    total = sum(RANK_WEIGHTS)
    assert RANK_WEIGHTS[9] / total == pytest.approx(0.0785, abs=5e-4)
    assert RANK_WEIGHTS[0] / total == pytest.approx(0.1246, abs=5e-4)


# --- penalties -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("counts", "factor", "break_even_gain"),
    [
        ((0, 1, 0), 0.95, 0.053),
        ((0, 3, 0), 0.857, 0.166),
        ((1, 0, 0), 0.8, 0.25),
        ((0, 0, 1), 0.5, 1.0),
    ],
)
def test_penalty_table(counts: tuple[int, int, int], factor: float, break_even_gain: float) -> None:
    multiplier = penalty_multiplier(*counts)
    assert round(multiplier, 3) == factor
    assert 1 / multiplier - 1 == pytest.approx(break_even_gain, abs=5e-4)


def test_penalty_multiplier_composes() -> None:
    assert penalty_multiplier(0, 0, 0) == 1.0
    assert penalty_multiplier(2, 1, 1) == pytest.approx(0.8**2 * 0.95 * 0.5)
    assert penalty_multiplier(0, 2, 0) == 0.9025
    with pytest.raises(ValueError):
        penalty_multiplier(-1, 0, 0)


# --- expected value ------------------------------------------------------------------------------


def test_expected_value_is_the_probability_weighted_score() -> None:
    hyps = [hyp(LISBON, 0.7), hyp(PORTO, 0.3)]
    entries = [LISBON] * 6 + [PORTO] * 4
    expected = 0.7 * score_list(entries, LISBON, Label.URBAN) + 0.3 * score_list(entries, PORTO, Label.URBAN)
    assert expected_value(entries, hyps, Label.URBAN) == pytest.approx(expected)
    assert expected_value(entries, hyps, Label.URBAN, special=True, multipliers=0.95) == pytest.approx(
        3 * 0.95 * expected
    )


# --- strategy claims of SPEC 3.1 (property tests, seeded) ----------------------------------------


def random_hypotheses(rng: random.Random, label: Label) -> list[Hypothesis]:
    n = rng.randint(2, 6)
    spread_deg = rng.choice([0.0005, 0.01, 0.2, 3.0])
    raw = [rng.random() + 1e-3 for _ in range(n)]
    return [
        Hypothesis(
            lat=39.5 + rng.uniform(-spread_deg, spread_deg),
            lng=-8.0 + rng.uniform(-spread_deg, spread_deg),
            probability=p / sum(raw),
        )
        for p in raw
    ]


@pytest.mark.parametrize("label", list(Label))
def test_one_entry_earns_an_eighth_of_ten_copies(label: Label) -> None:
    rng = random.Random(1)
    for _ in range(50):
        hyps = random_hypotheses(rng, label)
        point = (hyps[0].lat, hyps[0].lng)
        ratio = expected_value([point], hyps, label) / expected_value([point] * 10, hyps, label)
        assert ratio == pytest.approx(0.125, abs=1e-3)
        assert ratio == pytest.approx(1 / 8.025, rel=1e-3)


@pytest.mark.parametrize("label", list(Label))
def test_ten_copies_of_the_best_point_beat_any_split(label: Label) -> None:
    rng = random.Random(2)
    for _ in range(200):
        hyps = random_hypotheses(rng, label)
        points = [(h.lat, h.lng) for h in hyps]
        best = max(points, key=lambda pt: expected_value([pt], hyps, label))
        best_ev = expected_value([best] * 10, hyps, label)
        for _ in range(20):
            split = [rng.choice(points) for _ in range(10)]
            assert expected_value(split, hyps, label) <= best_ev + 1e-6
        # Even the split ordered by decreasing value loses unless it is the best point everywhere.
        ordered = sorted(points, key=lambda pt: -expected_value([pt], hyps, label))
        hedged = [ordered[0]] * 6 + [ordered[1]] * 4
        assert expected_value(hedged, hyps, label) <= best_ev + 1e-6


@pytest.mark.parametrize("label", list(Label))
def test_the_more_probable_endpoint_beats_the_midpoint(label: Label) -> None:
    rng = random.Random(3)
    for _ in range(500):
        # Distinct hypotheses: below 20 m the midpoint is inside the 10 m snap of both.
        d = math.exp(rng.uniform(math.log(20.0), math.log(300_000.0)))
        p1 = rng.uniform(0.5, 1.0)
        a, b = LISBON, north_of(LISBON, d)
        hyps = [hyp(a, p1), hyp(b, 1 - p1)]
        midpoint = north_of(LISBON, d / 2)
        assert expected_value([a] * 10, hyps, label) >= expected_value([midpoint] * 10, hyps, label) - 1e-6


def test_midpoint_wins_only_inside_the_snap_radius() -> None:
    a, b = LISBON, north_of(LISBON, 15)
    hyps = [hyp(a, 0.5), hyp(b, 0.5)]
    midpoint = north_of(LISBON, 7.5)
    assert expected_value([midpoint] * 10, hyps, Label.URBAN) > expected_value([a] * 10, hyps, Label.URBAN)


def test_urban_and_non_urban_retention_at_1_km() -> None:
    assert theta(1000, Label.URBAN) / 2 == pytest.approx(0.09, abs=0.005)
    assert theta(1000, Label.NON_URBAN) / 2 == pytest.approx(0.91, abs=0.005)
    # 60 m off an Urban pin costs 37%.
    assert 1 - theta(60, Label.URBAN) / 2 == pytest.approx(0.375, abs=0.005)
