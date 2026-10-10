"""Tool definitions sent to the model. Byte-stable: no timestamps, deterministic order.

Strict schemas guarantee shape only; numeric ranges, option counts and the 10-entry cap are
validated in code by the handlers (strict mode does not support min/max keywords).
"""

from __future__ import annotations

from typing import Any

from ..config import Settings


def _obj(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties) if required is None else required,
        "additionalProperties": False,
    }


_NUM = {"type": "number"}
_STR = {"type": "string"}

_HYPOTHESIS = _obj(
    {
        "lat": {"type": "number", "description": "Latitude, decimal WGS84."},
        "lng": {"type": "number", "description": "Longitude, decimal WGS84."},
        "probability": {
            "type": "number",
            "description": "Your probability (0-1) that the camera stood within radius_m of this point. "
            "Probabilities across hypotheses should sum to at most 1.",
        },
        "radius_m": {
            "type": "number",
            "description": "Radius in metres within which you believe the camera stood if this hypothesis is "
            "right. It is used: the harness spreads the probability over that disc when it picks the "
            "answer, so give a verified exact spot a small radius (10-20) and an area-level fallback "
            "its real extent.",
        },
        "label": {"type": "string", "description": "Short place name for this hypothesis."},
        "evidence": {"type": "string", "description": "The observations that support it."},
    }
)

_HYPOTHESES = {
    "type": "array",
    "items": _HYPOTHESIS,
    "description": "1 to 10 weighted location hypotheses. Pin where the camera stood, not a landmark's centroid.",
}


def _tool(name: str, description: str, schema: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "description": description, "input_schema": schema, "strict": True}


VIEW_CROP = _tool(
    "view_crop",
    "Render a rectilinear view of the panorama at native resolution. Use it to zoom on signs, plates, "
    "shopfronts, road markings, poles and distant landmarks. yaw is in degrees clockwise from the left "
    "edge of the overview ruler (0-360, the panorama's own frame, not compass north); pitch is degrees "
    "above (+) or below (-) the horizon; fov is the horizontal field of view in degrees (5-120). "
    "Narrow fields of view (< 30) are upscaled for legibility. Free.",
    _obj(
        {
            "yaw": _NUM,
            "pitch": _NUM,
            "fov": _NUM,
            "enhance": {
                "type": "boolean",
                "description": "Apply local contrast enhancement and sharpening; helps with shadowed or hazy text.",
            },
        }
    ),
)

UPDATE_CANDIDATES = _tool(
    "update_candidates",
    "Record your current location hypotheses. Free and unlimited: call it within your first two turns and "
    "again whenever your belief changes. The harness keeps the latest call as the best-so-far answer and "
    "submits it if you run out of time, so never leave it stale.",
    _obj({"hypotheses": _HYPOTHESES}),
)

SUBMIT_LOCATIONS = _tool(
    "submit_locations",
    "Submit your final hypotheses and end the run. The harness, not you, turns them into the ranked "
    "10-entry list. Give honest probabilities and error radii.",
    _obj({"hypotheses": _HYPOTHESES, "reasoning_summary": _STR}),
)

SEARCH_PLACES = _tool(
    "search_places",
    "Geocode a place name, business, street or address to coordinates (OpenStreetMap Nominatim, then "
    "Photon; Google if configured). Use it for names read off signs and for your own place names. "
    "countrycodes is a comma-separated list of ISO 3166-1 alpha-2 codes such as 'pt,es,fr' (empty string "
    "for no restriction). viewbox is 'min_lng,min_lat,max_lng,max_lat' to restrict results to a box "
    "(empty string for none).",
    _obj({"query": _STR, "countrycodes": _STR, "viewbox": _STR}),
)

ASK_MULTIPLE_CHOICE = _tool(
    "ask_multiple_choice",
    "Ask the human operator ONE multiple-choice question. Costs x0.95 on this panorama's whole score the "
    "moment you ask, answered or not. The operator cannot type: they click one of your options. Only ask "
    "when your posterior is truly multi-modal between far-apart candidates and a human with street-level "
    "tools on another machine could tell them apart; describe each option by checkable visual features. "
    "Never ask what is visible in the panorama. Returns an error at no cost if questions are disabled or "
    "the limit is reached.",
    _obj(
        {
            "question": _STR,
            "options": {"type": "array", "items": _STR, "description": "2 to 4 options."},
            "why_it_matters": {
                "type": "string",
                "description": "Which hypotheses each answer would confirm or rule out.",
            },
        }
    ),
)

STREETVIEW_LOOKUP = _tool(
    "streetview_lookup",
    "Find street-level imagery near a coordinate and return views at the given compass headings, plus "
    "the imagery's own exact coordinate and capture date. Compare with the panorama to verify a "
    "candidate; when a view matches, the answer is the returned pano coordinate. headings are compass "
    "degrees (0 = north), at most 4; each heading returns one image that counts against the image "
    "budget, so ask for the one or two directions that are distinctive in the panorama (an empty list "
    "gives north and south).",
    _obj(
        {
            "lat": _NUM,
            "lng": _NUM,
            "radius_m": {"type": "number", "description": "Search radius in metres (10-1000)."},
            "headings": {"type": "array", "items": _NUM},
        }
    ),
)

SATELLITE_TILE = _tool(
    "satellite_tile",
    "Aerial image centred on a coordinate, north up, with a scale bar. zoom is a web-map zoom level "
    "(10 = region, 14 = town, 17 = street, 19 = building). Use it for road layout, roundabouts, roofs, "
    "field patterns, tracks and coastline.",
    _obj({"lat": _NUM, "lng": _NUM, "zoom": {"type": "integer"}}),
)

OVERPASS_QUERY = _tool(
    "overpass_query",
    "Run an Overpass QL query against OpenStreetMap to find feature combinations (e.g. a church within "
    "200 m of a roundabout, wind turbines, masts, reservoirs). Always scope the query to a bounding box "
    "or an area such as area[\"ISO3166-2\"=\"PT-11\"]; country-wide regex queries time out. Use "
    "[out:json][timeout:25]; and 'out center 50;' to keep results small.",
    _obj({"ql": _STR}),
)

SUN_POSITION = _tool(
    "sun_position",
    "Given where the sun appears in the panorama (sun_yaw and sun_pitch in the panorama's own frame, as "
    "used by view_crop) and candidate coordinates, return for each candidate the compass heading of "
    "panorama yaw 0 and the mismatch between observed and expected sun elevation. Evaluated for the "
    "timestamp read as UTC and as local time; treat the result as a weak prior.",
    _obj(
        {
            "sun_yaw": _NUM,
            "sun_pitch": _NUM,
            "candidates": {"type": "array", "items": _obj({"lat": _NUM, "lng": _NUM})},
        }
    ),
)

# Order matters for prompt caching; never reorder at runtime.
LOCAL_TOOLS = [VIEW_CROP, UPDATE_CANDIDATES, SUBMIT_LOCATIONS, SUN_POSITION]
HUMAN_TOOLS = [ASK_MULTIPLE_CHOICE]
WEB_CLIENT_TOOLS = [SEARCH_PLACES, STREETVIEW_LOOKUP, SATELLITE_TILE, OVERPASS_QUERY]


def server_tools(settings: Settings) -> list[dict[str, Any]]:
    return [
        {"type": "web_search_20260209", "name": "web_search", "max_uses": settings.web_search_max_uses},
        {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": settings.web_fetch_max_uses},
    ]


def tool_definitions(settings: Settings) -> list[dict[str, Any]]:
    """The full tool list for a run. ask_multiple_choice stays listed even in --no-human mode
    (it returns a free error) so the tool list is identical across modes and cache-friendly."""
    tools = [*LOCAL_TOOLS, *HUMAN_TOOLS]
    if settings.allow_web:
        tools += [*WEB_CLIENT_TOOLS, *server_tools(settings)]
    return tools
