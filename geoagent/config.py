"""Run configuration: model, effort, budgets, keys, feature flags.

Every default that answers an open organiser question (SPEC section 13) is a flag here.
Values come from the environment (optionally a .env file); nothing in here may change
during a run, because the system prompt and tool list must stay byte-stable.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from pydantic import BaseModel

from .schema import Label

Effort = Literal["low", "medium", "high", "xhigh", "max"]


class Budget(BaseModel):
    effort: Effort
    soft_deadline_s: float  # "commit now" notice
    hard_deadline_s: float  # use best-so-far
    max_turns: int
    max_spend_usd: float


STANDARD_BUDGET = Budget(effort="high", soft_deadline_s=600, hard_deadline_s=840, max_turns=30, max_spend_usd=8.0)
SPECIAL_BUDGET = Budget(effort="xhigh", soft_deadline_s=900, hard_deadline_s=1200, max_turns=45, max_spend_usd=15.0)
LIVE_BUDGET = Budget(effort="high", soft_deadline_s=150, hard_deadline_s=210, max_turns=12, max_spend_usd=4.0)


class Pricing(BaseModel):
    """USD per million tokens for claude-opus-5-5."""

    input: float = 4.0
    output: float = 20.0
    cache_write: float = 5.0
    cache_read: float = 0.20
    web_search_per_1k: float = 10.0


class Settings(BaseModel):
    # model
    model: str = "claude-opus-5-5"
    # Thinking cannot be disabled on this model and counts toward max_tokens; 64K is the published
    # starting point at xhigh effort. Requests are streamed, so the size carries no HTTP-timeout risk.
    max_tokens: int = 64_000
    # Per-chunk read timeout on the streamed response: a stalled connection is retried after this.
    api_read_timeout_s: float = 120.0
    pricing: Pricing = Pricing()
    standard: Budget = STANDARD_BUDGET
    special: Budget = SPECIAL_BUDGET
    live: Budget = LIVE_BUDGET

    # organiser-question defaults (Q1, Q2, Q3)
    allow_web: bool = True  # Q1: False switches every external tool off
    penalty_scope: Literal["whole_list", "subsequent"] = "whole_list"  # Q2
    allow_duplicates: bool = True  # Q3

    # answer construction
    hedge: bool = False
    max_mcq: int = 3
    mcq_timeout_s: float = 90.0
    mcq_answer_accuracy: float = 0.9
    cue_max_chars: int = 1000

    # human channels; --no-human switches all three off
    no_human: bool = False
    mcq_allowed: bool = True

    # fallback prior when no hypothesis exists (central mainland Portugal)
    prior_urban: tuple[float, float] = (39.6000, -8.4000)
    prior_non_urban: tuple[float, float] = (39.6000, -8.0000)

    # run orchestration
    concurrency: int = 6
    global_watchdog_s: float = 3000.0  # T+50 min: finalise everything
    team: str = "team"
    runs_dir: Path = Path("runs")
    cache_dir: Path = Path(".cache")
    embed_images: bool = False  # embed base64 images in the exported JSON

    # external services
    http_timeout_s: float = 20.0
    osm_concurrency: int = 2  # shared semaphore for Nominatim and Overpass
    user_agent: str = "geoagent-junctionx/0.1 (hackathon team; contact via JunctionX Lisbon)"
    nominatim_url: str = "https://nominatim.openstreetmap.org"
    photon_url: str = "https://photon.komoot.io"
    overpass_urls: tuple[str, ...] = (
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
    )
    esri_export_url: str = (
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
    )
    web_search_max_uses: int = 20
    web_fetch_max_uses: int = 10

    # keys (optional; a missing key disables that backend, never raises)
    google_maps_api_key: str | None = None
    mapillary_token: str | None = None

    def budget_for(self, special: bool, live: bool = False) -> Budget:
        if live:
            return self.live
        return self.special if special else self.standard

    def prior_for(self, label: Label) -> tuple[float, float]:
        return self.prior_urban if label is Label.URBAN else self.prior_non_urban


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def load_settings(**overrides) -> Settings:
    """Build Settings from the environment, then apply explicit overrides (CLI flags).

    An empty variable (a blank line left in .env) counts as unset."""
    load_dotenv()
    base = Settings()
    env: dict = {
        "model": os.environ.get("GEOAGENT_MODEL") or base.model,
        "allow_web": _env_bool("ALLOW_WEB", base.allow_web),
        "allow_duplicates": _env_bool("ALLOW_DUPLICATES", base.allow_duplicates),
        "hedge": _env_bool("HEDGE", base.hedge),
        "no_human": _env_bool("NO_HUMAN", base.no_human),
        "mcq_allowed": _env_bool("MCQ_ALLOWED", base.mcq_allowed),
        "embed_images": _env_bool("EMBED_IMAGES", base.embed_images),
        "penalty_scope": os.environ.get("PENALTY_SCOPE") or base.penalty_scope,
        "max_mcq": int(os.environ.get("MAX_MCQ") or base.max_mcq),
        "api_read_timeout_s": float(os.environ.get("API_READ_TIMEOUT_S") or base.api_read_timeout_s),
        "global_watchdog_s": float(os.environ.get("GLOBAL_WATCHDOG_S") or base.global_watchdog_s),
        "team": os.environ.get("TEAM_NAME") or base.team,
        "runs_dir": Path(os.environ.get("RUNS_DIR") or base.runs_dir),
        "cache_dir": Path(os.environ.get("CACHE_DIR") or base.cache_dir),
        "google_maps_api_key": os.environ.get("GOOGLE_MAPS_API_KEY") or None,
        "mapillary_token": os.environ.get("MAPILLARY_TOKEN") or None,
    }
    env.update({k: v for k, v in overrides.items() if v is not None})
    return Settings(**env)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return load_settings()
