"""Per-panorama penalty ledger (R6-R9): counts interactions and stamps the multiplier on every entry."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

from .schema import Entry, EntryOrigin, PenaltyState
from .scoring import penalty_multiplier

PenaltyScope = Literal["whole_list", "subsequent"]
PenaltyKind = Literal["cue", "mcq", "human_geocode"]
_SCOPES: tuple[str, ...] = ("whole_list", "subsequent")
_DECIMALS = 6


def _slot_key(rank: int, lat: float, lng: float) -> tuple[int, float, float]:
    return (rank, round(lat, _DECIMALS), round(lng, _DECIMALS))


class PenaltyLedger:
    def __init__(self, scope: PenaltyScope = "whole_list") -> None:
        if scope not in _SCOPES:
            raise ValueError(f"unknown penalty scope: {scope!r}")
        self.scope: PenaltyScope = scope
        self.cues = 0
        self.mcqs = 0
        self.human_geocodes = 0
        self.history: list[dict] = []

    @property
    def multiplier(self) -> float:
        return penalty_multiplier(self.cues, self.mcqs, self.human_geocodes)

    def state(self) -> PenaltyState:
        return PenaltyState(
            cues=self.cues, mcqs=self.mcqs, human_geocodes=self.human_geocodes, multiplier=self.multiplier
        )

    def add_cue(self) -> tuple[float, float]:
        return self._add("cue")

    def add_mcq(self) -> tuple[float, float]:
        return self._add("mcq")

    def add_human_geocode(self) -> tuple[float, float]:
        return self._add("human_geocode")

    def _add(self, kind: PenaltyKind) -> tuple[float, float]:
        before = self.multiplier
        if kind == "cue":
            self.cues += 1
        elif kind == "mcq":
            self.mcqs += 1
        else:
            self.human_geocodes += 1
        after = self.multiplier
        self.history.append({"kind": kind, "seq": len(self.history) + 1, "before": before, "after": after})
        return before, after

    def stamp(
        self,
        points: Sequence[tuple[float, float]],
        origin: EntryOrigin,
        *,
        committed: Sequence[Entry] | None = None,
    ) -> list[Entry]:
        """Under 'subsequent' (R9 read literally) a slot unchanged since `committed` keeps its earlier multiplier."""
        earlier: dict[tuple[int, float, float], float] = {}
        if self.scope == "subsequent" and committed:
            earlier = {_slot_key(e.rank, e.lat, e.lng): e.multiplier for e in committed}
        current = self.multiplier
        return [
            Entry(
                rank=rank,
                lat=lat,
                lng=lng,
                multiplier=earlier.get(_slot_key(rank, lat, lng), current),
                origin=origin,
            )
            for rank, (lat, lng) in enumerate(points, start=1)
        ]
