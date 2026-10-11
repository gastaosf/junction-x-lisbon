import pytest

from astrolabio.allocate import AllocationResult, allocate, mcq_gate, value_at
from astrolabio.schema import Hypothesis, Label
from astrolabio.scoring import expected_value, haversine_m, theta

M_PER_DEG_LAT = 111_195.08
BASE = (39.5, -8.0)
FAR = (41.1579, -8.6291)


def north_of(point: tuple[float, float], d_m: float) -> tuple[float, float]:
    return (point[0] + d_m / M_PER_DEG_LAT, point[1])


def hyp(point: tuple[float, float], p: float, label: str = "") -> Hypothesis:
    return Hypothesis(lat=round(point[0], 6), lng=round(point[1], 6), probability=p, label=label)


def rounded(point: tuple[float, float]) -> tuple[float, float]:
    return (round(point[0], 6), round(point[1], 6))


def assert_valid(result: AllocationResult, hyps: list[Hypothesis], label: Label) -> None:
    assert len(result.points) == 10
    for lat, lng in result.points:
        assert (lat, lng) == (round(lat, 6), round(lng, 6))
        assert -90 <= lat <= 90 and -180 <= lng <= 180
    values = [value_at(lat, lng, hyps, label) for lat, lng in result.points]
    assert all(a >= b - 1e-12 for a, b in zip(values, values[1:]))
    ranked_values = [c["v"] for c in result.ranked]
    assert ranked_values == sorted(ranked_values, reverse=True)
    assert {c["source"] for c in result.ranked} <= {"hypothesis", "centroid"}


def two_far(p1: float, p2: float) -> list[Hypothesis]:
    """Two hypotheses ~200 km apart, so rho is p2/p1 to within 0.1% (Urban)."""
    return [hyp(BASE, p1), hyp(FAR, p2)]


# --- default plan --------------------------------------------------------------------------------


@pytest.mark.parametrize("label", list(Label))
def test_default_is_ten_copies_of_the_best_point(label: Label) -> None:
    hyps = [hyp(FAR, 0.3), hyp(BASE, 0.6), hyp((43.0, 2.0), 0.1)]
    result = allocate(hyps, label)
    assert result.points == [BASE] * 10
    assert (result.plan, result.hedge, result.allow_duplicates) == ("10x1", False, True)
    assert_valid(result, hyps, label)


def test_single_hypothesis() -> None:
    hyps = [hyp((38.7223456789, -9.1393456789), 1.0)]
    for hedge in (False, True):
        result = allocate(hyps, Label.URBAN, hedge=hedge)
        assert result.points == [(38.722346, -9.139346)] * 10
        assert result.rho is None
        assert result.plan == "10x1"
        assert result.ranked == [{"lat": 38.722346, "lng": -9.139346, "v": 2.0, "source": "hypothesis"}]


def test_v_matches_the_spec_formula() -> None:
    hyps = [hyp(BASE, 0.6), hyp(north_of(BASE, 100), 0.4)]
    result = allocate(hyps, Label.URBAN)
    d = haversine_m(*rounded(BASE), *rounded(north_of(BASE, 100)))
    assert result.ranked[0]["v"] == pytest.approx(0.6 * 2 + 0.4 * theta(d, Label.URBAN))
    assert result.ranked[1]["v"] == pytest.approx(0.4 * 2 + 0.6 * theta(d, Label.URBAN))
    assert result.rho == pytest.approx(result.ranked[1]["v"] / result.ranked[0]["v"])


def test_best_point_maximises_expected_score_over_candidates() -> None:
    hyps = [hyp(BASE, 0.35), hyp(north_of(BASE, 60), 0.33), hyp(north_of(BASE, 120), 0.32)]
    result = allocate(hyps, Label.URBAN)
    # The middle point is not the most probable but has the highest expected theta.
    assert result.points[0] == rounded(north_of(BASE, 60))
    best = expected_value(result.points, hyps, Label.URBAN)
    for h in hyps:
        assert expected_value([(h.lat, h.lng)] * 10, hyps, Label.URBAN) <= best + 1e-9


# --- hedge table ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("p1", "p2", "plan", "n_first"),
    [
        (0.70, 0.30, "10x1", 10),  # rho ~ 0.43
        (0.61, 0.39, "10x1", 10),  # rho ~ 0.64
        (0.59, 0.41, "8x1+2x2", 8),  # rho ~ 0.69
        (0.55, 0.45, "8x1+2x2", 8),  # rho ~ 0.82
        (0.53, 0.47, "8x1+2x2", 8),  # rho ~ 0.887
        (0.52, 0.48, "6x1+4x2", 6),  # rho ~ 0.92
        (0.50, 0.50, "6x1+4x2", 6),  # rho = 1
    ],
)
def test_hedge_table(p1: float, p2: float, plan: str, n_first: int) -> None:
    hyps = two_far(p1, p2)
    result = allocate(hyps, Label.URBAN, hedge=True)
    assert result.rho == pytest.approx(p2 / p1, abs=2e-3)
    assert result.plan == plan
    assert result.points == [BASE] * n_first + [FAR] * (10 - n_first)
    assert result.hedge is True
    assert_valid(result, hyps, Label.URBAN)


@pytest.mark.parametrize(("p1", "p2"), [(0.59, 0.41), (0.5, 0.5)])
def test_hedge_off_ignores_rho(p1: float, p2: float) -> None:
    result = allocate(two_far(p1, p2), Label.URBAN, hedge=False)
    assert result.points == [BASE] * 10
    assert result.plan == "10x1"
    assert result.rho == pytest.approx(p2 / p1, abs=2e-3)


def test_hedge_thresholds_are_on_rho_not_on_probability() -> None:
    # 60/40 far apart gives rho ~ 0.667 (10x1); non-Urban 5 km apart the second point keeps most of the value.
    assert allocate(two_far(0.6, 0.4), Label.URBAN, hedge=True).plan == "10x1"
    hyps = [hyp(BASE, 0.6), hyp(north_of(BASE, 5_000), 0.4)]
    result = allocate(hyps, Label.NON_URBAN, hedge=True)
    assert result.rho is not None and result.rho >= 0.9
    assert result.plan == "6x1+4x2"
    assert result.points == [rounded(BASE)] * 6 + [rounded(north_of(BASE, 5_000))] * 4


def test_settings_dict() -> None:
    result = allocate(two_far(0.55, 0.45), Label.URBAN, hedge=True)
    assert result.settings_dict() == {
        "hedge": True,
        "allow_duplicates": True,
        "plan": "8x1+2x2",
        "rho": result.rho,
    }


# --- centroid merging ----------------------------------------------------------------------------


def centroids(result: AllocationResult) -> list[dict]:
    return [c for c in result.ranked if c["source"] == "centroid"]


@pytest.mark.parametrize(
    ("label", "inside_m", "outside_m"),
    [(Label.URBAN, 28.0, 32.0), (Label.NON_URBAN, 2_900.0, 3_100.0)],
)
def test_centroid_threshold(label: Label, inside_m: float, outside_m: float) -> None:
    tight = [hyp(BASE, 0.5), hyp(north_of(BASE, inside_m), 0.5)]
    merged = allocate(tight, label)
    assert len(centroids(merged)) == 1
    assert centroids(merged)[0]["lat"] == pytest.approx(BASE[0] + inside_m / 2 / M_PER_DEG_LAT, abs=1e-6)
    assert centroids(merged)[0]["lng"] == pytest.approx(BASE[1], abs=1e-6)
    assert_valid(merged, tight, label)

    loose = [hyp(BASE, 0.5), hyp(north_of(BASE, outside_m), 0.5)]
    assert centroids(allocate(loose, label)) == []


def test_urban_cluster_radius_does_not_apply_to_non_urban_scale_and_vice_versa() -> None:
    hyps = [hyp(BASE, 0.5), hyp(north_of(BASE, 1_000), 0.5)]
    assert centroids(allocate(hyps, Label.URBAN)) == []
    assert len(centroids(allocate(hyps, Label.NON_URBAN))) == 1


def test_centroid_is_probability_weighted() -> None:
    hyps = [hyp(BASE, 0.75), hyp(north_of(BASE, 20), 0.25)]
    (centroid,) = centroids(allocate(hyps, Label.URBAN))
    assert centroid["lat"] == pytest.approx(BASE[0] + 5 / M_PER_DEG_LAT, abs=1e-6)


def test_centroid_wins_for_a_tight_symmetric_cluster() -> None:
    # 18 m apart: the centroid is inside the 10 m snap of both, so it scores the full 2.0.
    hyps = [hyp(BASE, 0.5), hyp(north_of(BASE, 18), 0.5)]
    result = allocate(hyps, Label.URBAN)
    assert result.ranked[0]["source"] == "centroid"
    assert result.ranked[0]["v"] == pytest.approx(2.0)
    assert result.points == [rounded(north_of(BASE, 9))] * 10


def test_centroid_never_wins_between_distinct_hypotheses() -> None:
    # 25 m apart: clustered, but theta is convex so the more probable endpoint keeps rank 1.
    hyps = [hyp(BASE, 0.6), hyp(north_of(BASE, 25), 0.4)]
    result = allocate(hyps, Label.URBAN)
    assert len(centroids(result)) == 1
    assert result.ranked[0]["source"] == "hypothesis"
    assert result.points == [rounded(BASE)] * 10


def test_cluster_does_not_absorb_a_distant_hypothesis() -> None:
    hyps = [hyp(BASE, 0.3), hyp(north_of(BASE, 15), 0.3), hyp(FAR, 0.4)]
    result = allocate(hyps, Label.URBAN)
    (centroid,) = centroids(result)
    assert haversine_m(centroid["lat"], centroid["lng"], *BASE) < 10
    assert result.points == [(centroid["lat"], centroid["lng"])] * 10


def test_centroid_across_the_antimeridian() -> None:
    hyps = [hyp((0.0, 179.9999), 0.5), hyp((0.0, -179.9999), 0.5)]
    (centroid,) = centroids(allocate(hyps, Label.URBAN))
    assert abs(centroid["lng"]) == pytest.approx(180.0, abs=1e-6)
    assert centroid["lat"] == pytest.approx(0.0, abs=1e-6)


# --- no-duplicates fallback ----------------------------------------------------------------------


def test_distinct_top_ten_by_value() -> None:
    hyps = [hyp((39.0 + 0.5 * i, -8.0), (12 - i) / 78) for i in range(12)]
    result = allocate(hyps, Label.URBAN, allow_duplicates=False)
    assert result.plan == "distinct"
    assert len(set(result.points)) == 10
    assert result.points == [(39.0 + 0.5 * i, -8.0) for i in range(10)]
    assert_valid(result, hyps, Label.URBAN)


@pytest.mark.parametrize("hedge", [False, True])
def test_distinct_pads_around_the_best_point(hedge: bool) -> None:
    hyps = two_far(0.6, 0.4)
    result = allocate(hyps, Label.URBAN, hedge=hedge, allow_duplicates=False)
    assert result.plan == "distinct"
    assert len(set(result.points)) == 10
    assert BASE in result.points and FAR in result.points
    near = [pt for pt in result.points if haversine_m(*pt, *BASE) < 10]
    assert len(near) == 9
    assert result.points[-1] == FAR
    assert_valid(result, hyps, Label.URBAN)
    assert result == allocate(hyps, Label.URBAN, hedge=hedge, allow_duplicates=False)


def test_distinct_padding_costs_almost_nothing_when_the_best_point_is_right() -> None:
    hyps = [hyp(BASE, 1.0)]
    result = allocate(hyps, Label.URBAN, allow_duplicates=False)
    assert len(set(result.points)) == 10
    assert expected_value(result.points, hyps, Label.URBAN) == pytest.approx(16_050, abs=1)


def test_distinct_pads_stay_in_range_at_the_corner_of_the_map() -> None:
    hyps = [hyp((90.0, 180.0), 1.0)]
    result = allocate(hyps, Label.NON_URBAN, allow_duplicates=False)
    assert len(set(result.points)) == 10
    assert_valid(result, hyps, Label.NON_URBAN)


# --- degenerate inputs ---------------------------------------------------------------------------


def test_empty_raises() -> None:
    with pytest.raises(ValueError):
        allocate([], Label.URBAN)


def test_all_zero_probabilities_are_uniform() -> None:
    hyps = [hyp(BASE, 0.0), hyp(FAR, 0.0)]
    result = allocate(hyps, Label.URBAN, hedge=True)
    assert result.rho == pytest.approx(1.0)
    assert result.points == [BASE] * 6 + [FAR] * 4
    assert sum(c["v"] for c in result.ranked) == pytest.approx(2.0, abs=1e-2)


def test_unnormalised_probabilities_are_normalised() -> None:
    scaled = allocate([hyp(BASE, 0.06), hyp(FAR, 0.04)], Label.URBAN, hedge=True)
    proper = allocate([hyp(BASE, 0.6), hyp(FAR, 0.4)], Label.URBAN, hedge=True)
    assert scaled.points == proper.points
    assert scaled.ranked[0]["v"] == pytest.approx(proper.ranked[0]["v"])


def test_duplicate_hypotheses_are_merged() -> None:
    hyps = [hyp(BASE, 0.3), hyp(BASE, 0.3), hyp(FAR, 0.4)]
    result = allocate(hyps, Label.URBAN)
    assert len(result.ranked) == 2
    assert result.points == [BASE] * 10


def test_ten_hypotheses_and_determinism() -> None:
    hyps = [hyp((38.0 + 0.3 * i, -9.0 + 0.2 * i), 0.1) for i in range(10)]
    first = allocate(hyps, Label.NON_URBAN, hedge=True)
    assert first == allocate(hyps, Label.NON_URBAN, hedge=True)
    assert_valid(first, hyps, Label.NON_URBAN)


# --- question gate -------------------------------------------------------------------------------


def test_gate_passes_for_a_multi_modal_posterior() -> None:
    ok, reason = mcq_gate(two_far(0.5, 0.5), Label.URBAN)
    assert ok and "multi-modal" in reason


def test_gate_fails_when_the_top_mode_dominates() -> None:
    # 0.95 * 0.9 * 1.0 = 0.855 <= 0.9
    ok, reason = mcq_gate(two_far(0.9, 0.1), Label.URBAN)
    assert not ok and "dominates" in reason
    assert mcq_gate(two_far(0.85, 0.15), Label.URBAN)[0] is True


def test_gate_fails_for_a_single_mode() -> None:
    near = [hyp(BASE, 0.5), hyp(north_of(BASE, 150), 0.5)]
    assert mcq_gate(near, Label.URBAN)[0] is False
    assert mcq_gate([hyp(BASE, 1.0)], Label.URBAN)[0] is False
    assert mcq_gate([], Label.URBAN)[0] is False


def test_gate_distance_is_relative_to_the_label_scale() -> None:
    hyps = [hyp(BASE, 0.5), hyp(north_of(BASE, 5_000), 0.5)]
    assert mcq_gate(hyps, Label.URBAN)[0] is True
    assert mcq_gate(hyps, Label.NON_URBAN)[0] is False


def test_gate_counts_only_the_options_that_fit() -> None:
    six = [hyp((38.0 + i, -8.0), p) for i, p in enumerate([0.3, 0.14, 0.14, 0.14, 0.14, 0.14])]
    # top 4 modes: 0.72 * 0.855 = 0.616 > 0.3
    assert mcq_gate(six, Label.NON_URBAN)[0] is True
    # with 2 options: 0.44 * 0.855 = 0.376 > 0.3; with poor accuracy it fails
    assert mcq_gate(six, Label.NON_URBAN, max_options=2)[0] is True
    assert mcq_gate(six, Label.NON_URBAN, max_options=2, accuracy=0.7)[0] is False


def test_gate_merges_nearby_hypotheses_into_one_mode() -> None:
    hyps = [hyp(BASE, 0.45), hyp(north_of(BASE, 40), 0.45), hyp(FAR, 0.10)]
    # modes 0.9 / 0.1: 0.855 <= 0.9
    assert mcq_gate(hyps, Label.URBAN)[0] is False


# --- radius_m: probability is "within radius_m of the point", not a point mass ---------------------


def _h(lat: float, lng: float, p: float, radius_m: float = 0.0) -> Hypothesis:
    return Hypothesis(lat=lat, lng=lng, probability=p, radius_m=radius_m)


def test_verified_precise_point_beats_a_vague_wide_hypothesis_urban() -> None:
    """'Somewhere in this town' at 60% must not take all ten slots from a street-view match at 40%."""
    town = _h(39.6036, -8.4151, 0.6, radius_m=1500)
    spot = _h(39.6108, -8.4151, 0.4, radius_m=15)  # 800 m away
    result = allocate([town, spot], Label.URBAN)
    assert set(result.points) == {(39.6108, -8.4151)}
    values = {(c["lat"], c["lng"]): c["v"] for c in result.ranked}
    # Expected theta of the town centre is about 0.6 * mean theta over a 1.5 km disc (0.22) + a little.
    assert values[(39.6036, -8.4151)] == pytest.approx(0.22, abs=0.03)
    assert values[(39.6108, -8.4151)] > 3 * values[(39.6036, -8.4151)]


def test_verified_precise_point_beats_a_vague_region_non_urban() -> None:
    region = _h(38.2, -7.9, 0.55, radius_m=60_000)
    field = _h(38.69, -7.9, 0.45, radius_m=1000)  # about 55 km away, inside the region
    assert set(allocate([region, field], Label.NON_URBAN).points) == {(38.69, -7.9)}


def test_wide_hypothesis_still_wins_when_it_holds_nearly_all_the_mass() -> None:
    town = _h(39.6036, -8.4151, 0.97, radius_m=300)
    elsewhere = _h(41.1496, -8.611, 0.03, radius_m=10)
    assert set(allocate([town, elsewhere], Label.URBAN).points) == {(39.6036, -8.4151)}


@pytest.mark.parametrize("radius_m", [0.0, 5.0, 10.0])
def test_radius_within_the_snap_distance_is_the_spec_point_mass_formula(radius_m: float) -> None:
    a, b = _h(38.7223, -9.1393, 0.6, radius_m), _h(38.7300, -9.1393, 0.4, radius_m)
    d = haversine_m(a.lat, a.lng, b.lat, b.lng)
    assert value_at(a.lat, a.lng, [a, b], Label.URBAN) == pytest.approx(0.6 * 2.0 + 0.4 * theta(d, Label.URBAN))


def test_disc_value_matches_the_closed_form_mean_of_theta() -> None:
    """Mean of 2/(1+d/s) over a disc of radius R seen from its centre is (4s/R^2)(R - s ln(1+R/s))."""
    import math

    for label, radius in ((Label.URBAN, 1500.0), (Label.URBAN, 200.0), (Label.NON_URBAN, 60_000.0)):
        s = label.scale_m
        exact = 4 * s / radius**2 * (radius - s * math.log(1 + radius / s))
        got = value_at(40.0, -8.0, [_h(40.0, -8.0, 1.0, radius)], label)
        assert got == pytest.approx(exact, rel=0.05), (label, radius)


def test_small_radius_costs_non_urban_almost_nothing() -> None:
    assert value_at(40.0, -8.0, [_h(40.0, -8.0, 1.0, 500.0)], Label.NON_URBAN) > 1.9


# --- hedge: x_2 must be a different place ---------------------------------------------------------


def test_hedge_second_point_is_not_a_near_duplicate_of_the_first() -> None:
    a, a2 = _h(38.7100, -9.14, 0.30), _h(38.71015, -9.14, 0.25)  # 17 m apart: one tight cluster
    porto = _h(41.1496, -8.611, 0.45)
    result = allocate([a, a2, porto], Label.URBAN, hedge=True)
    assert result.plan == "8x1+2x2" and result.rho == pytest.approx(0.82, abs=0.01)
    first, second = result.points[0], result.points[-1]
    assert result.points == [first] * 8 + [second] * 2
    assert second == (41.1496, -8.611)
    assert haversine_m(*first, *second) > 1000
    assert haversine_m(*first, a.lat, a.lng) < 30  # x_1 is the cluster's centroid


def test_hedge_with_only_one_tight_cluster_does_not_split() -> None:
    a, a2 = _h(38.7100, -9.14, 0.55), _h(38.71015, -9.14, 0.45)
    result = allocate([a, a2], Label.URBAN, hedge=True)
    assert result.rho is None and result.plan == "10x1" and len(set(result.points)) == 1
