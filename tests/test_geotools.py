"""Offline tests for the external tools: every request goes through httpx.MockTransport."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import cv2
import httpx
import numpy as np
import pytest

from astrolabio.config import Settings
from astrolabio.schema import Label, PanoramaTask
from astrolabio.tools import http, overpass, places, satellite, streetview
from astrolabio.tools.base import ToolContext

Handler = Callable[[httpx.Request], httpx.Response]


class Recorder:
    """MockTransport handler that records requests and delegates to a routing function."""

    def __init__(self, route: Handler) -> None:
        self.route = route
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.route(request)

    def hosts(self) -> list[str]:
        return [r.url.host for r in self.requests]


def jpeg_bytes(width: int = 64, height: int = 64) -> bytes:
    pixels = np.random.default_rng(0).integers(0, 255, (height, width, 3), dtype=np.uint8)
    return cv2.imencode(".jpg", pixels)[1].tobytes()


def image_size(block: dict[str, Any]) -> tuple[int, int]:
    raw = base64.standard_b64decode(block["source"]["data"])
    decoded = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    return decoded.shape[1], decoded.shape[0]


def text_of(result: Any) -> str:
    return "\n".join(b["text"] for b in result.content if b["type"] == "text")


def images_of(result: Any) -> list[dict[str, Any]]:
    return [b for b in result.content if b["type"] == "image"]


@pytest.fixture(autouse=True)
def pauses(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Replace every sleep (throttle, backoff) with a recorder so tests run instantly."""
    recorded: list[float] = []

    async def fake_pause(seconds: float) -> None:
        if seconds > 0:
            recorded.append(seconds)

    monkeypatch.setattr(http, "_pause", fake_pause)
    http._next_slot.clear()
    return recorded


@pytest.fixture
def make_ctx(tmp_path: Path):
    clients: list[httpx.AsyncClient] = []

    def build(route: Handler | None, **overrides: Any) -> tuple[ToolContext, Recorder]:
        settings = Settings(cache_dir=tmp_path / "cache", runs_dir=tmp_path / "runs", **overrides)
        recorder = Recorder(route or (lambda request: httpx.Response(500)))
        client = httpx.AsyncClient(transport=httpx.MockTransport(recorder)) if route else None
        if client:
            clients.append(client)
        session = SimpleNamespace(
            task=PanoramaTask(panorama_id="p1", path=tmp_path / "p1.jpg", label=Label.URBAN),
            image_dir=tmp_path / "runs" / "r1" / "p1" / "images",
            log=SimpleNamespace(emit=lambda actor, type, data: {}),
        )
        return ToolContext(session=session, pano=None, settings=settings, http=client), recorder

    return build


# --- http -------------------------------------------------------------------------------------


def test_cache_key_is_canonical() -> None:
    a = http.DiskCache.key("get", "https://x/y", {"a": 1, "b": 2})
    b = http.DiskCache.key("GET", "https://x/y", {"b": 2, "a": 1})
    assert a == b and len(a) == 64
    assert a != http.DiskCache.key("GET", "https://x/y", {"a": 1, "b": 3})
    assert http.DiskCache.key("POST", "https://x", data={"data": "q1"}) != http.DiskCache.key(
        "POST", "https://x", data={"data": "q2"}
    )


def test_disk_cache_round_trip(tmp_path: Path) -> None:
    cache = http.DiskCache(tmp_path)
    assert cache.get("ab" * 32) is None
    cache.set("ab" * 32, http.CachedResponse(200, b"\x00body", {"content-type": "x/y"}, url="https://u"))
    hit = cache.get("ab" * 32)
    assert hit and hit.from_cache and hit.content == b"\x00body" and hit.status == 200 and hit.url == "https://u"


def test_redact_url_hides_secrets() -> None:
    shown = http.redact_url("https://maps/api", {"key": "SECRET", "q": "a b"})
    assert "SECRET" not in shown and "key=REDACTED" in shown and "q=a+b" in shown


async def test_fetch_caches_successes(make_ctx) -> None:
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, json={"ok": True}))
    cache = http.http_cache(ctx.settings)
    first = await http.fetch(ctx, "GET", "https://api.test/a", params={"q": "x"}, cache=cache)
    second = await http.fetch(ctx, "GET", "https://api.test/a", params={"q": "x"}, cache=cache)
    assert first.json() == {"ok": True} and not first.from_cache
    assert second.from_cache and second.json() == {"ok": True}
    assert len(recorder.requests) == 1


async def test_fetch_retries_with_backoff(make_ctx, pauses: list[float]) -> None:
    statuses = iter([503, 429, 200])
    ctx, recorder = make_ctx(lambda request: httpx.Response(next(statuses), text="body"))
    response = await http.fetch(ctx, "GET", "https://api.test/a", cache=None, retries=2)
    assert response.status == 200 and len(recorder.requests) == 3
    assert pauses == [1.0, 2.0]


async def test_fetch_honours_retry_after_and_gives_up(make_ctx, pauses: list[float]) -> None:
    ctx, recorder = make_ctx(lambda request: httpx.Response(429, headers={"Retry-After": "600"}))
    cache = http.http_cache(ctx.settings)
    response = await http.fetch(ctx, "GET", "https://api.test/a", cache=cache, retries=1)
    assert response.status == 429 and len(recorder.requests) == 2
    assert pauses == [http.MAX_RETRY_AFTER_S]
    assert cache.get(http.DiskCache.key("GET", "https://api.test/a")) is None  # failures are not cached


async def test_fetch_never_raises_on_network_errors(make_ctx) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out")

    ctx, recorder = make_ctx(boom)
    response = await http.fetch(ctx, "GET", "https://api.test/a", cache=None, retries=1)
    assert response.status == 0 and "ConnectTimeout" in response.text
    assert "network error" in response.describe_failure()
    assert len(recorder.requests) == 2


async def test_fetch_without_client_reports_web_disabled(make_ctx) -> None:
    ctx, _ = make_ctx(None)
    response = await http.fetch(ctx, "GET", "https://api.test/a", cache=None)
    assert response.status == 0 and "disabled" in response.text


async def test_fetch_accepts_a_bare_client(make_ctx) -> None:
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, text="hi"))
    response = await http.fetch(ctx.http, "GET", "https://api.test/a", cache=None)
    assert response.text == "hi" and len(recorder.requests) == 1


async def test_throttle_spaces_requests_per_host(make_ctx, pauses: list[float]) -> None:
    ctx, _ = make_ctx(lambda request: httpx.Response(200, text="ok"))
    for path in ("a", "b", "c"):
        await http.fetch(ctx, "GET", f"https://slow.test/{path}", cache=None, min_interval_s=1.0)
    await http.fetch(ctx, "GET", "https://other.test/a", cache=None, min_interval_s=1.0)
    assert len(pauses) == 2
    assert pauses[0] == pytest.approx(1.0, abs=0.05) and pauses[1] == pytest.approx(2.0, abs=0.05)


async def test_osm_semaphore_is_shared_and_sized(make_ctx) -> None:
    ctx, _ = make_ctx(None)
    semaphore = http.osm_semaphore(ctx.settings)
    assert semaphore is http.osm_semaphore(ctx.settings)
    assert semaphore._value == ctx.settings.osm_concurrency == 2


def test_make_http_client_sets_user_agent_and_timeout() -> None:
    settings = Settings()
    client = http.make_http_client(settings)
    assert client.headers["User-Agent"] == settings.user_agent
    assert client.timeout.read == settings.http_timeout_s


def test_encode_jpeg_caps_the_longest_side() -> None:
    encoded = http.encode_jpeg(np.zeros((1500, 3000, 3), np.uint8))
    decoded = http.decode_image(encoded)
    assert decoded is not None and decoded.shape[:2] == (1000, 2000)
    assert http.decode_image(b'{"error": "nope"}') is None and http.decode_image(b"") is None


# --- search_places ----------------------------------------------------------------------------

NOMINATIM_HIT = {
    "lat": "38.7139092",
    "lon": "-9.1334762",
    "name": "Pastelaria Santo António",
    "category": "amenity",
    "type": "cafe",
    "display_name": "Pastelaria Santo António, Rua do Milagre, Lisboa, Portugal",
    "address": {
        "road": "Rua do Milagre de Santo António",
        "suburb": "Santa Maria Maior",
        "city": "Lisboa",
        "county": "Lisboa",
        "postcode": "1100-351",
        "country": "Portugal",
    },
}
PHOTON_BODY = {
    "features": [
        {
            "geometry": {"coordinates": [-8.61, 41.15]},
            "properties": {"name": "Ribeira", "osm_key": "place", "osm_value": "suburb", "city": "Porto",
                           "country": "Portugal", "countrycode": "PT"},
        },
        {
            "geometry": {"coordinates": [-47.8, -21.17]},
            "properties": {"name": "Ribeira", "osm_key": "place", "osm_value": "city", "country": "Brasil",
                           "countrycode": "BR"},
        },
    ]
}  # fmt: skip


async def test_places_nominatim_request_and_format(make_ctx) -> None:
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, json=[NOMINATIM_HIT]))
    result = await places.run(
        ctx, {"query": "Pastelaria Santo António", "countrycodes": "PT, es", "viewbox": "-9.0,38.8,-9.3,38.6"}
    )
    assert not result.is_error
    request = recorder.requests[0]
    assert len(recorder.requests) == 1 and request.url.path == "/search"
    params = dict(request.url.params)
    assert params["format"] == "jsonv2" and params["addressdetails"] == "1" and params["limit"] == "8"
    assert params["countrycodes"] == "pt,es" and params["bounded"] == "1"
    assert params["viewbox"] == "-9.300000,38.600000,-9.000000,38.800000"
    assert request.headers["User-Agent"] == ctx.settings.user_agent
    text = text_of(result)
    assert "1. Pastelaria Santo António | amenity/cafe | 38.713909,-9.133476 |" in text
    assert "Lisboa" in text and "Portugal" in text and "source: nominatim" in text
    assert result.log["results"][0]["lat"] == pytest.approx(38.7139092)
    assert result.urls and "nominatim" in result.urls[0]


async def test_places_is_cached_on_disk(make_ctx) -> None:
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, json=[NOMINATIM_HIT]))
    args = {"query": "Pastelaria", "countrycodes": "", "viewbox": ""}
    first = await places.run(ctx, args)
    second = await places.run(ctx, args)
    assert len(recorder.requests) == 1
    assert text_of(first) == text_of(second) and second.log["sources"][0]["from_cache"]


async def test_places_falls_back_to_photon_and_filters_countries(make_ctx) -> None:
    def route(request: httpx.Request) -> httpx.Response:
        if "nominatim" in request.url.host:
            return httpx.Response(503)
        return httpx.Response(200, json=PHOTON_BODY)

    ctx, recorder = make_ctx(route)
    result = await places.run(ctx, {"query": "Ribeira", "countrycodes": "pt", "viewbox": ""})
    assert not result.is_error
    assert recorder.hosts().count("nominatim.openstreetmap.org") == 3  # 1 try + 2 retries
    assert recorder.hosts()[-1] == "photon.komoot.io"
    text = text_of(result)
    assert "1. Ribeira | place/suburb | 41.150000,-8.610000 | Porto, Portugal | source: photon" in text
    assert "Brasil" not in text and "nominatim: HTTP 503" in text


async def test_places_empty_nominatim_then_empty_photon_is_not_an_error(make_ctx) -> None:
    def route(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[] if "nominatim" in request.url.host else {"features": []})

    ctx, recorder = make_ctx(route)
    result = await places.run(ctx, {"query": "zzzz", "countrycodes": "", "viewbox": ""})
    assert not result.is_error and "No results" in text_of(result)
    assert len(recorder.requests) == 2


async def test_places_all_backends_down_is_an_error(make_ctx) -> None:
    ctx, _ = make_ctx(lambda request: httpx.Response(502))
    result = await places.run(ctx, {"query": "Lisboa", "countrycodes": "", "viewbox": ""})
    assert result.is_error and "nominatim: HTTP 502" in text_of(result) and "photon: HTTP 502" in text_of(result)


async def test_places_uses_google_only_with_a_key(make_ctx) -> None:
    def route(request: httpx.Request) -> httpx.Response:
        if "googleapis" in request.url.host:
            assert request.url.params["key"] == "GKEY"
            body = {
                "status": "OK",
                "results": [
                    {"name": "Café Central", "formatted_address": "Praça 1, Évora, Portugal",
                     "geometry": {"location": {"lat": 38.5714, "lng": -7.9135}}, "types": ["cafe", "food"]}
                ],
            }  # fmt: skip
            return httpx.Response(200, json=body)
        return httpx.Response(200, json=[NOMINATIM_HIT])

    ctx, recorder = make_ctx(route, google_maps_api_key="GKEY")
    result = await places.run(ctx, {"query": "Café Central", "countrycodes": "pt", "viewbox": ""})
    text = text_of(result)
    assert "source: nominatim" in text and "Café Central | cafe/food | 38.571400,-7.913500" in text
    assert "source: google_places" in text
    assert "maps.googleapis.com" in recorder.hosts()
    assert all("GKEY" not in url for url in result.urls)

    ctx_no_key, recorder_no_key = make_ctx(route)
    await places.run(ctx_no_key, {"query": "Café Central 2", "countrycodes": "pt", "viewbox": ""})
    assert "maps.googleapis.com" not in recorder_no_key.hosts()


async def test_places_google_geocoding_fallback_when_places_denied(make_ctx) -> None:
    def route(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/place/textsearch/json"):
            return httpx.Response(200, json={"status": "REQUEST_DENIED", "error_message": "legacy API"})
        if request.url.path.endswith("/geocode/json"):
            hit = {"formatted_address": "Tomar, Portugal", "geometry": {"location": {"lat": 39.6, "lng": -8.41}},
                   "types": ["locality"]}  # fmt: skip
            return httpx.Response(200, json={"status": "OK", "results": [hit]})
        return httpx.Response(200, json=[] if "nominatim" in request.url.host else {"features": []})

    ctx, _ = make_ctx(route, google_maps_api_key="GKEY")
    result = await places.run(ctx, {"query": "Tomar", "countrycodes": "", "viewbox": ""})
    text = text_of(result)
    assert not result.is_error and "Tomar | locality | 39.600000,-8.410000" in text
    assert "source: google_geocoding" in text and "google_places: REQUEST_DENIED" in text


@pytest.mark.parametrize(
    "args",
    [
        {"query": "  ", "countrycodes": "", "viewbox": ""},
        {"query": "x", "countrycodes": "portugal", "viewbox": ""},
        {"query": "x", "countrycodes": "", "viewbox": "1,2,3"},
        {"query": "x", "countrycodes": "", "viewbox": "-9,95,-8,96"},
    ],
)
async def test_places_rejects_bad_input_without_network(make_ctx, args: dict[str, str]) -> None:
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, json=[]))
    result = await places.run(ctx, args)
    assert result.is_error and not recorder.requests


# --- overpass_query ---------------------------------------------------------------------------


def test_prepare_query_rejects_unscoped_queries_without_timeout() -> None:
    with pytest.raises(ValueError, match="no spatial scope"):
        overpass.prepare_query('node["man_made"="mast"]; out;')
    with pytest.raises(ValueError, match="empty"):
        overpass.prepare_query("   ")
    with pytest.raises(ValueError, match="macros"):
        overpass.prepare_query("[out:json][timeout:25]; node({{bbox}}); out;")


@pytest.mark.parametrize(
    "ql",
    [
        'node["amenity"="place_of_worship"](38.7,-9.2,38.8,-9.1); out;',
        'node(around:200,38.7,-9.1)["highway"="mini_roundabout"]; out;',
        'area["ISO3166-2"="PT-11"]->.a; node(area.a)["power"="generator"]; out;',
        "[bbox:38.7,-9.2,38.8,-9.1]; node[shop]; out;",
        "way(123456); out center;",
    ],
)
def test_prepare_query_accepts_scoped_queries_and_adds_settings(ql: str) -> None:
    query, timeout_s = overpass.prepare_query(ql)
    assert timeout_s == 25
    assert query.startswith("[out:json][timeout:25]")
    assert query.count("[timeout:") == 1 and ql.split(";")[-2] in query
    # the settings must stay a single leading statement
    assert query.startswith("[out:json][timeout:25][bbox:") or query.startswith("[out:json][timeout:25];\n")


def test_prepare_query_keeps_existing_settings_and_clamps_timeout() -> None:
    query, timeout_s = overpass.prepare_query('[out:json][timeout:900]; node["name"="X"]; out;')
    assert timeout_s == 25 and query == '[out:json][timeout:25]; node["name"="X"]; out;'
    # One hung query: 35 s on the first server leaves 25 s of the 60 s budget for the mirror.
    assert overpass.MAX_TIMEOUT_S + overpass.HTTP_MARGIN_S < overpass.TOTAL_BUDGET_S - overpass.MIN_ATTEMPT_S
    query, timeout_s = overpass.prepare_query("[out:json];node(1,2,3,4);out;")
    assert query == "[timeout:25][out:json];node(1,2,3,4);out;" and timeout_s == 25
    query, _ = overpass.prepare_query("[timeout:10];node(1,2,3,4);out;")
    assert query == "[out:json][timeout:10];node(1,2,3,4);out;"


def overpass_elements(count: int) -> list[dict[str, Any]]:
    return [
        {"type": "node", "id": i, "lat": 38.7 + i * 0.001, "lon": -9.1, "tags": {"name": f"Igreja {i}", "amenity": "place_of_worship", "source": "survey"}}
        for i in range(count)
    ]  # fmt: skip


SCOPED_QL = '[out:json][timeout:25]; nwr["amenity"="place_of_worship"](38.7,-9.2,38.8,-9.1); out center;'


async def test_overpass_posts_and_summarises(make_ctx) -> None:
    elements = [
        *overpass_elements(1),
        {"type": "way", "id": 77, "center": {"lat": 38.75, "lon": -9.15}, "tags": {"junction": "roundabout", "highway": "primary"}},
        {"type": "relation", "id": 9, "bounds": {"minlat": 38.0, "minlon": -9.0, "maxlat": 39.0, "maxlon": -8.0}, "tags": {"note": "x"}},
        {"type": "node", "id": 500, "lat": 1.0, "lon": 2.0},
    ]  # fmt: skip
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, json={"elements": elements}))
    result = await overpass.run(ctx, {"ql": SCOPED_QL})
    request = recorder.requests[0]
    assert request.method == "POST" and request.url.host == "overpass-api.de"
    assert b"data=" in request.content and request.headers["User-Agent"] == ctx.settings.user_agent
    text = text_of(result)
    assert not result.is_error and "Overpass returned 4 element(s):" in text
    assert "1. node/0 @ 38.700000,-9.100000 | name=Igreja 0 | amenity=place_of_worship" in text
    assert "2. way/77 @ 38.750000,-9.150000 | highway=primary | junction=roundabout" in text
    assert "3. relation/9 @ 38.500000,-8.500000 | note=x" in text
    assert "node/500" not in text and "(1 untagged member nodes/ways omitted)" in text
    assert result.log["element_count"] == 4 and len(result.log["elements"]) == 3

    await overpass.run(ctx, {"ql": SCOPED_QL})
    assert len(recorder.requests) == 1  # cached by request


async def test_overpass_caps_the_listing(make_ctx) -> None:
    ctx, _ = make_ctx(lambda request: httpx.Response(200, json={"elements": overpass_elements(130)}))
    result = await overpass.run(ctx, {"ql": SCOPED_QL})
    text = text_of(result)
    assert "130 element(s), showing the first 50" in text and "... and 80 more elements not shown" in text
    assert "\n50. node/49" in text and "\n51." not in text


async def test_overpass_falls_back_to_the_mirror(make_ctx, pauses: list[float]) -> None:
    def route(request: httpx.Request) -> httpx.Response:
        if request.url.host == "overpass-api.de":
            return httpx.Response(504)
        return httpx.Response(200, json={"elements": overpass_elements(2)})

    ctx, recorder = make_ctx(route)
    result = await overpass.run(ctx, {"ql": SCOPED_QL})
    assert not result.is_error and "2 element(s)" in text_of(result)
    assert recorder.hosts() == ["overpass-api.de", "overpass-api.de", "overpass.kumi.systems"]
    assert pauses == [overpass.FAST_RETRY_PAUSE_S]  # a fast 504 earns one retry on the same server
    assert result.log["failures"] == ["https://overpass-api.de/api/interpreter: HTTP 504"]


async def test_overpass_all_servers_down(make_ctx) -> None:
    ctx, recorder = make_ctx(lambda request: httpx.Response(429))
    result = await overpass.run(ctx, {"ql": SCOPED_QL})
    assert result.is_error and "every Overpass server failed" in text_of(result)
    assert len(recorder.requests) == 4 and len(result.urls) == 2


async def test_overpass_syntax_error_is_reported_and_not_retried(make_ctx) -> None:
    page = '<html><body><p>The data included in this document is from OSM.</p><p><strong style="color:#FF0000">Error</strong>: line 1: parse error: Unknown type &quot;nod&quot; </p></body></html>'
    ctx, recorder = make_ctx(lambda request: httpx.Response(400, text=page))
    result = await overpass.run(ctx, {"ql": "[out:json][timeout:25]; nod(1,2,3,4); out;"})
    assert result.is_error and 'parse error: Unknown type "nod"' in text_of(result)
    assert len(recorder.requests) == 1


async def test_overpass_runtime_remark_is_an_error_and_not_cached(make_ctx) -> None:
    body = {"elements": [], "remark": "runtime error: Query timed out in \"query\" at line 1 after 26 seconds."}
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, json=body))
    result = await overpass.run(ctx, {"ql": SCOPED_QL})
    assert result.is_error and "Query timed out" in text_of(result)
    await overpass.run(ctx, {"ql": SCOPED_QL})
    assert len(recorder.requests) == 2


async def test_overpass_rejects_unscoped_query_without_network(make_ctx) -> None:
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, json={"elements": []}))
    result = await overpass.run(ctx, {"ql": 'node["name"~"Igreja"]; out;'})
    assert result.is_error and "no spatial scope" in text_of(result) and not recorder.requests


async def test_overpass_empty_result_and_count(make_ctx) -> None:
    ctx, _ = make_ctx(lambda request: httpx.Response(200, json={"elements": []}))
    result = await overpass.run(ctx, {"ql": SCOPED_QL})
    assert not result.is_error and "0 element(s)." in text_of(result) and "Widen the area" in text_of(result)

    counted = {"elements": [{"type": "count", "id": 0, "tags": {"nodes": "3", "total": "3"}}]}
    ctx, _ = make_ctx(lambda request: httpx.Response(200, json=counted))
    result = await overpass.run(ctx, {"ql": SCOPED_QL.replace("out center", "out count")})
    assert "count: nodes=3, total=3" in text_of(result)


# --- streetview_lookup ------------------------------------------------------------------------

LOOKUP_ARGS = {"lat": 38.7139, "lng": -9.1334, "radius_m": 50, "headings": [0, 90]}


def google_route(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/streetview/metadata"):
        meta = {"status": "OK", "pano_id": "PANO123", "date": "2023-05", "location": {"lat": 38.71402, "lng": -9.13351}}
        return httpx.Response(200, json=meta)
    if request.url.path.endswith("/streetview"):
        return httpx.Response(200, content=jpeg_bytes(640, 640), headers={"content-type": "image/jpeg"})
    return httpx.Response(404)


async def test_streetview_without_keys_points_to_satellite(make_ctx) -> None:
    ctx, recorder = make_ctx(lambda request: httpx.Response(200))
    result = await streetview.run(ctx, LOOKUP_ARGS)
    assert result.is_error and "satellite_tile" in text_of(result) and not recorder.requests


async def test_streetview_google_metadata_first_then_views(make_ctx) -> None:
    ctx, recorder = make_ctx(google_route, google_maps_api_key="GKEY")
    result = await streetview.run(ctx, LOOKUP_ARGS)
    assert not result.is_error
    paths = [r.url.path for r in recorder.requests]
    assert paths[0].endswith("/streetview/metadata") and len(paths) == 3
    image_params = dict(recorder.requests[1].url.params)
    assert image_params["size"] == "640x640" and image_params["fov"] == "90" and image_params["pano"] == "PANO123"
    assert [r.url.params["heading"] for r in recorder.requests[1:]] == ["0.0", "90.0"]

    text = text_of(result)
    assert "PANO COORDINATE: 38.714020,-9.133510" in text and "captured 2023-05" in text
    assert "the answer is this pano coordinate (38.714020,-9.133510)" in text
    assert "compass heading 0 (N)" in text and "compass heading 90 (E)" in text
    # every image is preceded by its text label
    kinds = [b["type"] for b in result.content]
    assert kinds == ["text", "text", "image", "text", "image"]
    assert all(max(image_size(b)) <= 2000 for b in images_of(result))

    refs = result.log["images"]
    assert len(refs) == 2 and all(Path(ref["path"]).is_file() for ref in refs)
    assert Path(refs[0]["path"]).parent == ctx.session.image_dir
    assert result.log["pano_lat"] == pytest.approx(38.71402) and result.log["distance_m"] == pytest.approx(16.4, abs=0.5)
    assert all("GKEY" not in url for url in result.urls) and len(result.urls) == 3


async def test_streetview_validates_input(make_ctx) -> None:
    ctx, recorder = make_ctx(google_route, google_maps_api_key="GKEY")
    too_many = await streetview.run(ctx, {**LOOKUP_ARGS, "headings": [0, 72, 144, 216, 288]})
    out_of_range = await streetview.run(ctx, {**LOOKUP_ARGS, "lat": 123})
    assert too_many.is_error and "at most 4" in text_of(too_many)
    assert out_of_range.is_error and not recorder.requests


async def test_streetview_defaults_to_two_headings_and_clamps_radius(make_ctx) -> None:
    """Each view costs image budget, so an unspecified request gets two opposite views, not four."""
    ctx, recorder = make_ctx(google_route, google_maps_api_key="GKEY")
    result = await streetview.run(ctx, {**LOOKUP_ARGS, "headings": [], "radius_m": 99999})
    assert len(images_of(result)) == 2
    assert "heading 0 (N)" in text_of(result) and "heading 180 (S)" in text_of(result)
    assert recorder.requests[0].url.params["radius"] == "1000"


def mapillary_item(image_id: str, lat: float, lng: float, compass: float, *, pano: bool = False) -> dict[str, Any]:
    return {
        "id": image_id,
        "computed_geometry": {"type": "Point", "coordinates": [lng, lat]},
        "captured_at": 1684000000000,
        "compass_angle": compass,
        "is_pano": pano,
        "thumb_1024_url": f"https://cdn.mapillary.test/{image_id}.jpg",
    }


def mapillary_route(items: list[dict[str, Any]]) -> Handler:
    def route(request: httpx.Request) -> httpx.Response:
        if request.url.host == "graph.mapillary.com":
            assert request.headers["Authorization"] == "OAuth MTOKEN"
            return httpx.Response(200, json={"data": items})
        if request.url.host == "cdn.mapillary.test":
            return httpx.Response(200, content=jpeg_bytes(1024, 512))
        if request.url.path.endswith("/streetview/metadata"):
            return httpx.Response(200, json={"status": "ZERO_RESULTS"})
        return httpx.Response(404)

    return route


async def test_streetview_falls_back_to_mapillary_and_matches_headings(make_ctx) -> None:
    items = [
        mapillary_item("north", 38.71392, -9.13340, 5.0),
        mapillary_item("east", 38.71395, -9.13340, 92.0),
        mapillary_item("south", 38.71398, -9.13340, 181.0),
        mapillary_item("far", 38.7300, -9.1334, 0.0),
    ]
    ctx, recorder = make_ctx(mapillary_route(items), google_maps_api_key="GKEY", mapillary_token="MTOKEN")
    result = await streetview.run(ctx, LOOKUP_ARGS)
    assert not result.is_error
    assert recorder.hosts()[:2] == ["maps.googleapis.com", "graph.mapillary.com"]
    search = dict(recorder.requests[1].url.params)
    assert search["fields"] == streetview.MAPILLARY_FIELDS and len(search["bbox"].split(",")) == 4
    text = text_of(result)
    assert "Mapillary photo north at 38.713920,-9.133400, facing compass 5 (N), captured 2023-05-13" in text
    assert "Mapillary photo east at 38.713950,-9.133400, facing compass 92 (E)" in text
    assert "south" not in text and "far" not in text
    assert "ITS OWN COORDINATE" in text and "the answer is that image's coordinate" in text
    assert "Google Street View has no outdoor pano within 50 m" in text
    assert [ref["image_id"] for ref in result.log["images"]] == ["north", "east"]


async def test_streetview_mapillary_prefers_a_nearby_360_image(make_ctx) -> None:
    items = [mapillary_item("flat", 38.71391, -9.13340, 0.0), mapillary_item("sphere", 38.71394, -9.13340, 40.0, pano=True)]
    ctx, _ = make_ctx(mapillary_route(items), mapillary_token="MTOKEN")
    result = await streetview.run(ctx, LOOKUP_ARGS)
    assert len(images_of(result)) == 1
    assert "Mapillary 360 image sphere at 38.713940,-9.133400" in text_of(result)
    assert "image centre faces roughly compass 40" in text_of(result)


async def test_streetview_mapillary_applies_eval_exclusions(make_ctx) -> None:
    items = [
        mapillary_item("source", 38.71390, -9.13340, 0.0),
        mapillary_item("neighbour", 38.71400, -9.13340, 0.0),  # ~11 m from the source: same sequence
        mapillary_item("independent", 38.71430, -9.13340, 0.0),  # ~44 m away
    ]
    ctx, _ = make_ctx(mapillary_route(items), mapillary_token="MTOKEN")
    ctx.session.excluded_image_ids = {"source"}
    by_id = await streetview.run(ctx, LOOKUP_ARGS)
    assert [ref["image_id"] for ref in by_id.log["images"]] == ["neighbour"]

    ctx.session.excluded_point = (38.71390, -9.13340)
    by_point = await streetview.run(ctx, {**LOOKUP_ARGS, "headings": [0]})
    assert [ref["image_id"] for ref in by_point.log["images"]] == ["independent"]

    ctx.session.excluded_image_ids = {"source", "neighbour", "independent"}
    nothing = await streetview.run(ctx, LOOKUP_ARGS)
    assert not nothing.is_error and "Mapillary has no imagery within 50 m" in text_of(nothing)


async def test_streetview_backend_failure_is_an_error(make_ctx) -> None:
    ctx, _ = make_ctx(lambda request: httpx.Response(500), google_maps_api_key="GKEY", mapillary_token="MTOKEN")
    result = await streetview.run(ctx, LOOKUP_ARGS)
    assert result.is_error and "metadata failed (HTTP 500)" in text_of(result)
    assert "Mapillary search failed (HTTP 500)" in text_of(result)


async def test_streetview_google_denied_key(make_ctx) -> None:
    denied = {"status": "REQUEST_DENIED", "error_message": "API key invalid"}
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, json=denied), google_maps_api_key="GKEY")
    result = await streetview.run(ctx, LOOKUP_ARGS)
    assert result.is_error and "REQUEST_DENIED: API key invalid" in text_of(result)
    assert len(recorder.requests) == 1  # no paid image call without an OK metadata answer
    await streetview.run(ctx, LOOKUP_ARGS)
    assert len(recorder.requests) == 2  # key/quota errors are not replayed from the cache


def test_heading_helpers() -> None:
    assert streetview.compass_name(350) == "N" and streetview.compass_name(225) == "SW"
    assert streetview.angular_diff(350, 10) == pytest.approx(20) and streetview.angular_diff(90, 270) == pytest.approx(180)


# --- satellite_tile ---------------------------------------------------------------------------


def test_footprint_matches_web_mercator_zoom() -> None:
    area = satellite.footprint(38.7139, -9.1334, 17)
    assert area.metres_per_px == pytest.approx(1.19433 * np.cos(np.radians(38.7139)), rel=1e-4)
    assert area.ground_width_m == pytest.approx(954.3, abs=1.0)
    assert area.xmax - area.xmin == pytest.approx(area.ymax - area.ymin)
    assert area.south < 38.7139 < area.north and area.west < -9.1334 < area.east
    assert (area.north + area.south) / 2 == pytest.approx(38.7139, abs=1e-4)
    # the box really is that wide on the ground
    from astrolabio.scoring import haversine_m

    assert haversine_m(38.7139, area.west, 38.7139, area.east) == pytest.approx(area.ground_width_m, rel=5e-3)


@pytest.mark.parametrize(
    ("metres_per_px", "expected"), [(0.93, 200.0), (0.3, 50.0), (30.0, 5000.0), (0.08, 20.0), (4.0, 1000.0)]
)
def test_nice_scale(metres_per_px: float, expected: float) -> None:
    assert satellite.nice_scale_m(metres_per_px, 256) == expected


def test_annotate_draws_without_resizing() -> None:
    blank = np.full((1024, 1024, 3), 90, np.uint8)
    annotated, bar_m = satellite.annotate(blank, 0.93)
    assert annotated.shape == blank.shape and bar_m == 200.0
    assert (blank == 90).all()  # input untouched
    changed = (annotated != 90).any(axis=2)
    assert changed[512, 540] and not changed[512, 512]  # crosshair arm drawn, centre left open
    assert changed[990:1000, 30:240].any() and changed[40:130, 960:990].any()  # scale bar, north arrow


async def test_satellite_returns_annotated_image_and_scale(make_ctx) -> None:
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, content=jpeg_bytes(1024, 1024)))
    result = await satellite.run(ctx, {"lat": 38.7139, "lng": -9.1334, "zoom": 17})
    assert not result.is_error
    params = dict(recorder.requests[0].url.params)
    assert params["f"] == "image" and params["format"] == "jpg" and params["size"] == "1024,1024"
    assert params["bboxSR"] == "3857" and len(params["bbox"].split(",")) == 4
    assert recorder.requests[0].url.host == "server.arcgisonline.com"

    text = text_of(result)
    assert "centred on 38.713900,-9.133400 at zoom 17, north up" in text
    assert "covers about 954 m x 954 m (0.93 m/px)" in text and "scale bar (bottom left) is 200 m" in text
    (image,) = images_of(result)
    assert image_size(image) == (1024, 1024)
    assert [b["type"] for b in result.content] == ["text", "image"]
    ref = result.log["image"]
    assert Path(ref["path"]).is_file() and Path(ref["path"]).parent == ctx.session.image_dir
    assert result.log["ground_width_m"] == pytest.approx(954.3, abs=1.0)
    json.dumps(result.log)  # the log must be JSON-serialisable

    await satellite.run(ctx, {"lat": 38.7139, "lng": -9.1334, "zoom": 17})
    assert len(recorder.requests) == 1


async def test_satellite_clamps_zoom_and_rejects_bad_coordinates(make_ctx) -> None:
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, content=jpeg_bytes(1024, 1024)))
    result = await satellite.run(ctx, {"lat": 38.7, "lng": -9.1, "zoom": 42})
    assert "at zoom 20" in text_of(result)
    bad = await satellite.run(ctx, {"lat": 95, "lng": -9.1, "zoom": 15})
    missing = await satellite.run(ctx, {"lat": 38.7, "lng": -9.1})
    assert bad.is_error and missing.is_error and len(recorder.requests) == 1


async def test_satellite_reports_non_image_and_http_failures(make_ctx) -> None:
    ctx, _ = make_ctx(lambda request: httpx.Response(200, json={"error": {"code": 400, "message": "Invalid bbox"}}))
    not_image = await satellite.run(ctx, {"lat": 38.7, "lng": -9.1, "zoom": 15})
    assert not_image.is_error and "Invalid bbox" in text_of(not_image)
    assert not list((ctx.settings.cache_dir / "http").rglob("*.bin"))  # a 200 that is not an image is not cached

    ctx, recorder = make_ctx(lambda request: httpx.Response(503))
    down = await satellite.run(ctx, {"lat": 38.7, "lng": -9.1, "zoom": 15})
    assert down.is_error and "HTTP 503" in text_of(down) and len(recorder.requests) == 3


# --- overpass: bounded wall-clock time ---------------------------------------------------------------


async def test_overpass_timeout_goes_straight_to_the_mirror_without_retrying(make_ctx, pauses: list[float]) -> None:
    """A query that timed out will time out again: four 35-70 s attempts used to block the turn."""

    def route(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    ctx, recorder = make_ctx(route)
    result = await overpass.run(ctx, {"ql": SCOPED_QL})
    assert result.is_error and "every Overpass server failed" in text_of(result)
    assert recorder.hosts() == ["overpass-api.de", "overpass.kumi.systems"]  # one attempt per server
    assert pauses == []


async def test_overpass_stops_when_its_time_budget_is_spent(make_ctx, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": 1000.0}
    monkeypatch.setattr(overpass.time, "monotonic", lambda: clock["now"])

    def route(request: httpx.Request) -> httpx.Response:
        clock["now"] += 58.0  # the first server eats nearly the whole budget
        return httpx.Response(504)

    ctx, recorder = make_ctx(route)
    result = await overpass.run(ctx, {"ql": SCOPED_QL})
    assert result.is_error
    assert recorder.hosts() == ["overpass-api.de"]  # no slow retry, and no time left for the mirror
    assert "time budget" in text_of(result)


async def test_overpass_attempt_is_cut_off_while_waiting_for_a_free_osm_slot(
    make_ctx, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    monkeypatch.setattr(overpass, "TOTAL_BUDGET_S", 0.5)
    monkeypatch.setattr(overpass, "MIN_ATTEMPT_S", 0.3)
    ctx, recorder = make_ctx(lambda request: httpx.Response(200, json={"elements": []}), osm_concurrency=1)
    semaphore = http.osm_semaphore(ctx.settings)
    await semaphore.acquire()  # another panorama's slow query holds the only slot
    try:
        result = await asyncio.wait_for(overpass.run(ctx, {"ql": SCOPED_QL}), timeout=8)
    finally:
        semaphore.release()
    assert result.is_error and recorder.requests == []
    assert "no answer within" in text_of(result)
    assert not semaphore.locked()  # the cancelled wait did not leak the slot


def test_overpass_budget_constants() -> None:
    assert overpass.TOTAL_BUDGET_S <= 60 and overpass.FAST_RETRY_STATUSES == {429, 502, 503, 504}


# --- search_places: the viewbox claim must be true for Google rows too ------------------------------


def google_place(name: str, lat: float, lng: float, address: str) -> dict[str, Any]:
    return {"name": name, "formatted_address": address, "types": ["cafe"], "geometry": {"location": {"lat": lat, "lng": lng}}}


async def test_places_drops_google_results_outside_the_viewbox(make_ctx) -> None:
    inside = google_place("Cafe Central", 39.60, -8.41, "Tomar, Portugal")
    outside = google_place("Cafe Central", 41.15, -8.61, "Porto, Portugal")

    def route(request: httpx.Request) -> httpx.Response:
        if "googleapis" in request.url.host:
            return httpx.Response(200, json={"status": "OK", "results": [outside, inside]})
        if "photon" in request.url.host:
            return httpx.Response(200, json={"features": []})
        return httpx.Response(200, json=[])

    ctx, _ = make_ctx(route, google_maps_api_key="GKEY")
    result = await places.run(ctx, {"query": "Cafe Central", "countrycodes": "pt", "viewbox": "-8.5,39.5,-8.3,39.7"})
    text = text_of(result)
    assert "1 result(s)" in text and "restricted to the viewbox" in text
    assert "39.600000,-8.410000" in text and "41.150000" not in text
    assert "1 place(s) with this name outside the viewbox" in text
    assert "country restriction is enforced for nominatim and photon rows only" in text
    assert [r["lat"] for r in result.log["results"]] == [39.60]
    assert result.log["sources"][-1]["dropped_outside_viewbox"] == 1


async def test_places_reports_nothing_in_the_box_when_google_only_matches_elsewhere(make_ctx) -> None:
    outside = google_place("Cafe Central", 41.15, -8.61, "Porto, Portugal")

    def route(request: httpx.Request) -> httpx.Response:
        if "googleapis" in request.url.host:
            return httpx.Response(200, json={"status": "OK", "results": [outside]})
        if "photon" in request.url.host:
            return httpx.Response(200, json={"features": []})
        return httpx.Response(200, json=[])

    ctx, _ = make_ctx(route, google_maps_api_key="GKEY")
    result = await places.run(ctx, {"query": "Cafe Central", "countrycodes": "", "viewbox": "-8.5,39.5,-8.3,39.7"})
    text = text_of(result)
    assert text.startswith("No results for 'Cafe Central', restricted to the viewbox")
    assert "outside the viewbox" in text and not result.is_error


async def test_places_without_a_viewbox_keeps_every_google_result(make_ctx) -> None:
    far = google_place("Cafe Central", 41.15, -8.61, "Porto, Portugal")

    def route(request: httpx.Request) -> httpx.Response:
        if "googleapis" in request.url.host:
            return httpx.Response(200, json={"status": "OK", "results": [far]})
        if "photon" in request.url.host:
            return httpx.Response(200, json={"features": []})
        return httpx.Response(200, json=[])

    ctx, _ = make_ctx(route, google_maps_api_key="GKEY")
    result = await places.run(ctx, {"query": "Cafe Central", "countrycodes": "", "viewbox": ""})
    assert "1 result(s)" in text_of(result) and "Note:" not in text_of(result)


async def test_nominatim_wait_is_bounded_and_falls_through_to_photon(make_ctx, monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    monkeypatch.setattr(places, "NOMINATIM_BUDGET_S", 0.2)
    feature = {"geometry": {"coordinates": [-8.41, 39.60]}, "properties": {"name": "Cafe Central", "countrycode": "PT"}}

    def route(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"features": [feature]})

    ctx, recorder = make_ctx(route, osm_concurrency=1)
    semaphore = http.osm_semaphore(ctx.settings)
    await semaphore.acquire()  # both OSM slots are held by slow Overpass queries
    try:
        result = await asyncio.wait_for(places.run(ctx, {"query": "Cafe Central", "countrycodes": "", "viewbox": ""}), 5)
    finally:
        semaphore.release()
    assert not result.is_error and "source: photon" in text_of(result)
    assert "nominatim: no answer within" in text_of(result)
    assert [h for h in recorder.hosts() if "nominatim" in h] == []


# --- Mapillary: nearest means nearest, panos are legible, same-drive frames are excluded in eval ------


def bbox_half_height_m(request: httpx.Request) -> float:
    _, south, _, north = (float(v) for v in request.url.params["bbox"].split(","))
    return (north - south) / 2 * 111_320


async def test_mapillary_searches_a_small_box_first_and_widens_only_when_empty(make_ctx) -> None:
    near = mapillary_item("near", 38.71392, -9.13340, 0.0)  # ~2 m from the query
    far = mapillary_item("far", 38.7160, -9.1334, 0.0)  # ~230 m away

    def route(request: httpx.Request) -> httpx.Response:
        if request.url.host == "graph.mapillary.com":
            return httpx.Response(200, json={"data": [far] if bbox_half_height_m(request) > 200 else []})
        return httpx.Response(200, content=jpeg_bytes(1024, 512))

    ctx, recorder = make_ctx(route, mapillary_token="MTOKEN")
    result = await streetview.run(ctx, {**LOOKUP_ARGS, "radius_m": 500, "headings": [0]})
    searches = [r for r in recorder.requests if r.url.host == "graph.mapillary.com"]
    assert [round(bbox_half_height_m(r)) for r in searches] == [30, 100, 300]  # stopped at the first hit
    assert "1 image(s) within 300 m" in text_of(result) and result.log["searched_radius_m"] == 300

    def dense(request: httpx.Request) -> httpx.Response:
        if request.url.host == "graph.mapillary.com":
            return httpx.Response(200, json={"data": [near]})
        return httpx.Response(200, content=jpeg_bytes(1024, 512))

    ctx, recorder = make_ctx(dense, mapillary_token="MTOKEN")
    # A slightly different query point, so the answer is not served from the first half's cache.
    result = await streetview.run(ctx, {**LOOKUP_ARGS, "lat": 38.71391, "radius_m": 1000, "headings": [0]})
    searches = [r for r in recorder.requests if r.url.host == "graph.mapillary.com"]
    assert [round(bbox_half_height_m(r)) for r in searches] == [30]
    assert "1 image(s) within 30 m" in text_of(result)


def test_mapillary_search_radii() -> None:
    assert streetview.search_radii(50) == [30, 50]
    assert streetview.search_radii(20) == [20]
    assert streetview.search_radii(1000) == [30, 100, 300, 1000]


async def test_mapillary_says_so_when_the_search_hit_its_limit(make_ctx) -> None:
    items = [mapillary_item(f"i{n}", 38.71392 + n * 1e-6, -9.13340, 0.0) for n in range(streetview.MAPILLARY_LIMIT)]
    ctx, _ = make_ctx(mapillary_route(items), mapillary_token="MTOKEN")
    result = await streetview.run(ctx, {**LOOKUP_ARGS, "headings": [0]})
    assert "at least 100 images within 30 m" in text_of(result) and "may not be the nearest" in text_of(result)
    assert result.log["truncated"] is True


async def test_mapillary_panos_use_the_larger_thumbnail(make_ctx) -> None:
    pano = {**mapillary_item("sphere", 38.71394, -9.13340, 40.0, pano=True), "thumb_2048_url": "https://cdn.mapillary.test/sphere_2048.jpg"}
    flat = {**mapillary_item("flat", 38.71391, -9.13340, 0.0), "thumb_2048_url": "https://cdn.mapillary.test/flat_2048.jpg"}
    ctx, recorder = make_ctx(mapillary_route([pano]), mapillary_token="MTOKEN")
    await streetview.run(ctx, LOOKUP_ARGS)
    assert recorder.requests[-1].url.path == "/sphere_2048.jpg"
    ctx, recorder = make_ctx(mapillary_route([flat]), mapillary_token="MTOKEN")
    await streetview.run(ctx, {**LOOKUP_ARGS, "lat": 38.71391, "headings": [0]})  # not the cached search
    assert recorder.requests[-1].url.path == "/flat.jpg"  # ordinary photos keep the 1024 px thumbnail
    assert "sequence" in streetview.MAPILLARY_FIELDS and "thumb_2048_url" in streetview.MAPILLARY_FIELDS


async def test_mapillary_excludes_the_whole_source_sequence_in_eval(make_ctx) -> None:
    """Frames of the same drive beyond 25 m show the same cars and light as the eval panorama."""
    items = [
        {**mapillary_item("same_drive", 38.71430, -9.13340, 0.0), "sequence": "seq-1"},  # ~44 m from the truth
        {**mapillary_item("other_drive", 38.71432, -9.13340, 0.0), "sequence": "seq-2"},
    ]
    ctx, _ = make_ctx(mapillary_route(items), mapillary_token="MTOKEN")
    ctx.session.excluded_image_ids = {"source"}
    ctx.session.excluded_point = (38.71390, -9.13340)
    ctx.session.excluded_sequence_ids = {"seq-1"}
    result = await streetview.run(ctx, {**LOOKUP_ARGS, "headings": [0]})
    assert [ref["image_id"] for ref in result.log["images"]] == ["other_drive"]

    ctx, _ = make_ctx(mapillary_route(items), mapillary_token="MTOKEN")  # the scoring run: no guards
    result = await streetview.run(ctx, {**LOOKUP_ARGS, "headings": [0]})
    assert [ref["image_id"] for ref in result.log["images"]] == ["same_drive"]
    assert streetview._excluded(ctx, "x", 0.0, 0.0, "") is False  # an image with no sequence is never matched
