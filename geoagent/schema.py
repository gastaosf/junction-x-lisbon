"""Shared data types. Every module imports from here; keep it dependency-free (pydantic only)."""

from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Label(str, Enum):
    URBAN = "Urban"
    NON_URBAN = "non-Urban"

    @classmethod
    def parse(cls, raw: str) -> "Label":
        s = raw.strip().lower().replace("_", "-").replace(" ", "-")
        if s in {"urban", "u"}:
            return cls.URBAN
        if s in {"non-urban", "nonurban", "nu", "rural"}:
            return cls.NON_URBAN
        raise ValueError(f"unknown label: {raw!r}")

    @property
    def scale_m(self) -> float:
        """Distance scale s of theta = 2 / (1 + d/s)."""
        return 100.0 if self is Label.URBAN else 10_000.0

    @property
    def cluster_radius_m(self) -> float:
        """Candidates closer than this are a tight cluster and may be merged into a centroid."""
        return 30.0 if self is Label.URBAN else 3_000.0


class Hypothesis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    probability: float = Field(ge=0, le=1)
    radius_m: float = Field(default=0.0, ge=0)
    label: str = ""
    evidence: str = ""


EntryOrigin = Literal["agent", "harness_fallback", "human_geocode"]


class Entry(BaseModel):
    """One ranked slot of the 10-entry answer."""

    rank: int = Field(ge=1, le=10)
    lat: float
    lng: float
    multiplier: float = 1.0
    origin: EntryOrigin = "agent"


class PanoramaTask(BaseModel):
    panorama_id: str
    path: Path
    label: Label
    timestamp: str | None = None  # YYYYMMDDhhmmss as given by the organisers; time zone unknown (Q5)
    special: bool = False  # the "Special One" (M = 3)

    @property
    def score_multiplier(self) -> int:
        return 3 if self.special else 1


class PenaltyState(BaseModel):
    cues: int = 0
    mcqs: int = 0
    human_geocodes: int = 0
    multiplier: float = 1.0
