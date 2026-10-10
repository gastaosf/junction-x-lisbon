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
    """USD per million tokens, Standard tier. The defaults are gpt-6.1-sol's."""

    input: float = 2.0
    cached_input: float = 0.10
    cache_write: float = 2.50
    output: float = 10.0
    web_search_per_1k: float = 10.0
    long_context_threshold: int = 272_000  # input tokens; above it the whole request is re-priced
    long_input_multiplier: float = 2.0  # applies to input, cached input and cache writes
    long_output_multiplier: float = 1.5


_GPT_5_6_SOL = Pricing(input=4.0, cached_input=0.40, cache_write=5.0, output=20.0)
MODEL_PRICING: dict[str, Pricing] = {
    "gpt-6.1-sol": Pricing(),
    "gpt-6-astra": Pricing(input=10.0, cached_input=1.0, cache_write=12.50, output=50.0),
    "gpt-6-sol": Pricing(input=2.0, cached_input=0.20, cache_write=2.50, output=10.0),
    "gpt-6-luna": Pricing(input=0.10, cached_input=0.01, cache_write=0.125, output=0.50),
    "gpt-5.6-sol": _GPT_5_6_SOL,
    "gpt-5.6": _GPT_5_6_SOL,  # alias
    # No cache-write surcharge on this model: a write is billed as plain input.
    "gpt-5.5": Pricing(input=5.0, cached_input=0.50, cache_write=5.0, output=30.0),
}


def pricing_for(model: str) -> Pricing:
    """Exact id, else the longest id it extends with a dated suffix ("gpt-5.5-2026-04-23"), else
    the default. The suffix must start with a digit: "gpt-5.5-pro" is another model at another
    price, and an unknown model gets the default rather than a relative's."""
    if model in MODEL_PRICING:
        return MODEL_PRICING[model]
    snapshots = [k for k in MODEL_PRICING if model.startswith(k + "-") and model[len(k) + 1 : len(k) + 2].isdigit()]
    return MODEL_PRICING[max(snapshots, key=len)] if snapshots else Pricing()


class Settings(BaseModel):
    # model
    model: str = "gpt-6.1-sol"
    # Sent as max_output_tokens. Reasoning cannot be switched off on this model and counts toward
    # it: a turn that spends the whole allowance reasoning comes back with no tool call at all.
    # Requests are streamed, so the size carries no HTTP-timeout risk.
    max_tokens: int = 64_000
    # Sent with every image. "original" keeps a view at the size the harness rendered it; "high"
    # would shrink the larger ones to a fixed patch budget, and "auto" differs between models.
    image_detail: Literal["low", "high", "original", "auto"] = "original"
    # Per-chunk read timeout on the streamed response: a stalled connection is retried after this.
    api_read_timeout_s: float = 60.0
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
        "image_detail": os.environ.get("GEOAGENT_IMAGE_DETAIL") or base.image_detail,
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
    env.setdefault("pricing", pricing_for(env["model"]))  # after the overrides: --model changes the rates
    return Settings(**env)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return load_settings()
