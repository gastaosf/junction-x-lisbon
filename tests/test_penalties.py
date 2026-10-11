import pytest

from astrolabio.penalties import PenaltyLedger
from astrolabio.schema import Entry, PenaltyState

A = (38.722300, -9.139300)
B = (41.157900, -8.629100)


def test_fresh_ledger() -> None:
    ledger = PenaltyLedger()
    assert ledger.scope == "whole_list"
    assert (ledger.cues, ledger.mcqs, ledger.human_geocodes) == (0, 0, 0)
    assert ledger.multiplier == 1.0
    assert ledger.history == []
    assert ledger.state() == PenaltyState(cues=0, mcqs=0, human_geocodes=0, multiplier=1.0)


def test_unknown_scope_is_rejected() -> None:
    with pytest.raises(ValueError):
        PenaltyLedger("everything")  # type: ignore[arg-type]


def test_before_and_after_values() -> None:
    ledger = PenaltyLedger()
    assert ledger.add_mcq() == (1.0, 0.95)
    assert ledger.add_mcq() == (0.95, 0.9025)
    assert ledger.add_cue() == (0.9025, pytest.approx(0.722))
    before, after = ledger.add_human_geocode()
    assert (before, after) == (pytest.approx(0.722), pytest.approx(0.361))
    assert (ledger.cues, ledger.mcqs, ledger.human_geocodes) == (1, 2, 1)
    assert ledger.multiplier == pytest.approx(0.8 * 0.95**2 * 0.5)
    assert ledger.state() == PenaltyState(cues=1, mcqs=2, human_geocodes=1, multiplier=ledger.multiplier)


@pytest.mark.parametrize(
    ("method", "factor"),
    [("add_cue", 0.8), ("add_mcq", 0.95), ("add_human_geocode", 0.5)],
)
def test_single_factors(method: str, factor: float) -> None:
    ledger = PenaltyLedger()
    assert getattr(ledger, method)() == (1.0, factor)
    assert ledger.multiplier == factor


def test_three_mcqs() -> None:
    ledger = PenaltyLedger()
    for _ in range(3):
        ledger.add_mcq()
    assert round(ledger.multiplier, 3) == 0.857


def test_history() -> None:
    ledger = PenaltyLedger()
    ledger.add_mcq()
    ledger.add_cue()
    ledger.add_human_geocode()
    assert ledger.history == [
        {"kind": "mcq", "seq": 1, "before": 1.0, "after": 0.95},
        {"kind": "cue", "seq": 2, "before": 0.95, "after": 0.76},
        {"kind": "human_geocode", "seq": 3, "before": 0.76, "after": 0.38},
    ]


@pytest.mark.parametrize("scope", ["whole_list", "subsequent"])
def test_stamp_without_committed_uses_the_current_multiplier(scope: str) -> None:
    ledger = PenaltyLedger(scope)  # type: ignore[arg-type]
    ledger.add_mcq()
    entries = ledger.stamp([A] * 6 + [B] * 4, "agent")
    assert [e.rank for e in entries] == list(range(1, 11))
    assert [(e.lat, e.lng) for e in entries] == [A] * 6 + [B] * 4
    assert all(e.multiplier == 0.95 and e.origin == "agent" for e in entries)


def test_whole_list_restamps_everything() -> None:
    ledger = PenaltyLedger("whole_list")
    committed = ledger.stamp([A] * 10, "agent")
    assert all(e.multiplier == 1.0 for e in committed)
    ledger.add_cue()
    entries = ledger.stamp([A] * 10, "agent", committed=committed)
    assert all(e.multiplier == 0.8 for e in entries)


def test_subsequent_keeps_the_multiplier_of_unchanged_slots() -> None:
    ledger = PenaltyLedger("subsequent")
    committed = ledger.stamp([A] * 10, "agent")
    ledger.add_mcq()
    entries = ledger.stamp([A] * 6 + [B] * 4, "agent", committed=committed)
    assert [e.multiplier for e in entries] == [1.0] * 6 + [0.95] * 4

    ledger.add_cue()
    later = ledger.stamp([B] + [A] * 5 + [B] * 4, "agent", committed=entries)
    assert [e.multiplier for e in later] == [0.76] + [1.0] * 5 + [0.95] * 4


def test_subsequent_matches_on_rank_as_well_as_position() -> None:
    ledger = PenaltyLedger("subsequent")
    committed = [Entry(rank=1, lat=A[0], lng=A[1], multiplier=1.0)]
    ledger.add_human_geocode()
    entries = ledger.stamp([B, A], "human_geocode", committed=committed)
    assert [e.multiplier for e in entries] == [0.5, 0.5]
    assert all(e.origin == "human_geocode" for e in entries)


def test_subsequent_ignores_differences_below_six_decimals() -> None:
    ledger = PenaltyLedger("subsequent")
    committed = ledger.stamp([A], "agent")
    ledger.add_mcq()
    (entry,) = ledger.stamp([(A[0] + 1e-9, A[1])], "agent", committed=committed)
    assert entry.multiplier == 1.0


def test_stamp_origin_and_empty_list() -> None:
    ledger = PenaltyLedger()
    assert ledger.stamp([], "harness_fallback") == []
    (entry,) = ledger.stamp([A], "harness_fallback")
    assert entry == Entry(rank=1, lat=A[0], lng=A[1], multiplier=1.0, origin="harness_fallback")


def test_stamp_rejects_more_than_ten_points() -> None:
    with pytest.raises(ValueError):
        PenaltyLedger().stamp([A] * 11, "agent")
