from __future__ import annotations

import base64
import math
import time
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from geoagent.pano import (
    INITIAL_YAWS,
    MAX_SIDE,
    Panorama,
    View,
    output_size,
    ruler_ticks,
)
from geoagent.tools import view_crop

W, H = 2048, 1024
RED = (0, 0, 255)  # BGR


def equirect_xy(yaw: float, pitch: float, width: int = W, height: int = H) -> tuple[float, float]:
    return yaw / 360 * width, (90 - pitch) / 180 * height


def draw_marker(img: np.ndarray, yaw: float, pitch: float, radius: int = 6) -> None:
    """Red disc centred on (yaw, pitch), drawn on both sides of the seam when it straddles it."""
    height, width = img.shape[:2]
    x, y = equirect_xy(yaw, pitch, width, height)
    for shift in (-width, 0, width):
        cv2.circle(img, (round(x - 0.5) + shift, round(y - 0.5)), radius, RED, -1, cv2.LINE_AA)


def write_pano(tmp_path: Path, img: np.ndarray, name: str = "pano.png") -> Path:
    path = tmp_path / name
    assert cv2.imwrite(str(path), img)
    return path


def marker_pano(tmp_path: Path, yaw: float, pitch: float, name: str = "pano.png") -> Panorama:
    img = np.full((H, W, 3), 128, np.uint8)
    draw_marker(img, yaw, pitch)
    return Panorama(write_pano(tmp_path, img, name))


def decode(view: View) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(view.jpeg, np.uint8), cv2.IMREAD_COLOR)
    assert img.shape[:2] == (view.height, view.width)
    return img


def red_centroid(img: np.ndarray) -> tuple[float, float]:
    b, g, r = (img[:, :, i].astype(int) for i in range(3))
    ys, xs = np.nonzero((r > 180) & (g < 90) & (b < 90))
    assert len(xs) > 20, "marker not found in the view"
    return float(xs.mean()), float(ys.mean())


@pytest.mark.parametrize(
    ("yaw", "pitch"),
    [(180, 0), (0, 0), (359.5, 0), (45, 30), (90, -40), (270, 60), (200, -75), (10, 70)],
)
def test_marker_lands_at_view_centre(tmp_path: Path, yaw: float, pitch: float) -> None:
    pano = marker_pano(tmp_path, yaw, pitch)
    view = pano.render(yaw, pitch, 40)
    cx, cy = red_centroid(decode(view))
    assert cx == pytest.approx((view.width - 1) / 2, abs=2.0)
    assert cy == pytest.approx((view.height - 1) / 2, abs=2.0)


def test_yaw_increases_rightwards_and_pitch_upwards(tmp_path: Path) -> None:
    pano = marker_pano(tmp_path, 100, 0, "right.png")
    view = pano.render(90, 0, 60)
    focal = view.width / (2 * math.tan(math.radians(30)))
    cx, cy = red_centroid(decode(view))
    assert cx - (view.width - 1) / 2 == pytest.approx(focal * math.tan(math.radians(10)), abs=3.0)
    assert cy == pytest.approx((view.height - 1) / 2, abs=2.0)

    pano = marker_pano(tmp_path, 90, 10, "up.png")
    view = pano.render(90, 0, 60)
    cx, cy = red_centroid(decode(view))
    assert (view.height - 1) / 2 - cy == pytest.approx(focal * math.tan(math.radians(10)), abs=3.0)
    assert cx == pytest.approx((view.width - 1) / 2, abs=2.0)


def test_yaw_180_is_the_image_centre(tmp_path: Path) -> None:
    img = np.full((H, W, 3), 128, np.uint8)
    cv2.circle(img, (W // 2, H // 2), 6, RED, -1)
    pano = Panorama(write_pano(tmp_path, img))
    view = pano.render(180, 0, 40)
    cx, cy = red_centroid(decode(view))
    assert cx == pytest.approx((view.width - 1) / 2, abs=2.0)
    assert cy == pytest.approx((view.height - 1) / 2, abs=2.0)


def textured(seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    noise = rng.integers(0, 256, (H // 8, W // 8, 3), dtype=np.uint8)
    # wrap-pad before upscaling so the texture is continuous across the 360 seam, like a real panorama
    wrapped = cv2.copyMakeBorder(noise, 0, 0, 4, 4, cv2.BORDER_WRAP)
    return cv2.resize(wrapped, (W + 64, H), interpolation=cv2.INTER_CUBIC)[:, 32:-32].copy()


@pytest.mark.parametrize(("pitch", "fov", "size"), [(0, 90, 600), (35, 60, 600), (-80, 110, 500), (0, 20, 400)])
def test_seam_is_seamless(tmp_path: Path, pitch: float, fov: float, size: int) -> None:
    """Looking straight at the seam must give the same pixels as looking at the same content after
    it has been rolled to the middle of the image."""
    img = textured()
    at_seam = Panorama(write_pano(tmp_path, img, "a.png"))
    rolled = Panorama(write_pano(tmp_path, np.roll(img, W // 2, axis=1), "b.png"))
    a = at_seam._render_array(0, pitch, fov, size, size).astype(int)
    b = rolled._render_array(180, pitch, fov, size, size).astype(int)
    assert np.abs(a - b).max() <= 2


def test_seam_has_no_visible_edge(tmp_path: Path) -> None:
    yaw = np.arange(W) / W * 2 * math.pi
    row = (127 + 100 * np.cos(yaw)).astype(np.uint8)
    img = np.repeat(np.repeat(row[None, :, None], H, axis=0), 3, axis=2)
    pano = Panorama(write_pano(tmp_path, img))
    out = pano._render_array(0, 0, 30, 800, 800).astype(int)
    assert np.abs(np.diff(out[400, :, 0])).max() <= 2


def test_poles_render_without_artifacts(tmp_path: Path) -> None:
    img = np.zeros((H, W, 3), np.uint8)
    img[: H // 2] = (200, 120, 40)
    img[H // 2 :] = (40, 160, 60)
    pano = Panorama(write_pano(tmp_path, img))
    up = pano._render_array(0, 90, 60, 300, 300)
    down = pano._render_array(0, -90, 60, 300, 300)
    assert np.abs(up.astype(int) - (200, 120, 40)).max() <= 2
    assert np.abs(down.astype(int) - (40, 160, 60)).max() <= 2


def test_up_and_down_view_edges_match_their_labels(tmp_path: Path) -> None:
    pano = marker_pano(tmp_path, 0, 55, "sky.png")
    up = pano.initial_views()[-2]
    cx, cy = red_centroid(decode(up))
    assert "bottom edge faces yaw 0" in up.label
    assert cy > up.height / 2 + 50 and cx == pytest.approx((up.width - 1) / 2, abs=4)

    pano = marker_pano(tmp_path, 90, 55, "sky90.png")
    cx, cy = red_centroid(decode(pano.initial_views()[-2]))
    assert cx > up.width / 2 + 50 and cy == pytest.approx((up.height - 1) / 2, abs=4)

    pano = marker_pano(tmp_path, 0, -55, "ground.png")
    down = pano.initial_views()[-1]
    cx, cy = red_centroid(decode(down))
    assert "top edge faces yaw 0" in down.label
    assert cy < down.height / 2 - 50 and cx == pytest.approx((down.width - 1) / 2, abs=4)


def test_ruler_ticks_follow_the_yaw_convention() -> None:
    ticks = dict((yaw, x) for x, yaw in ruler_ticks(2000))
    assert ticks[0] == 0
    assert ticks[90] == 500
    assert ticks[180] == 1000
    assert ticks[360] == 1999
    assert sorted(ticks) == list(range(0, 361, 15))


def test_overview_ruler_is_drawn_where_the_content_is(tmp_path: Path) -> None:
    img = np.full((H, W, 3), 60, np.uint8)
    draw_marker(img, 90, 0, radius=10)
    pano = Panorama(write_pano(tmp_path, img))
    view = pano.overview()
    out = decode(view)
    assert (view.width, view.height) == (2000, 1000)
    assert (view.yaw, view.pitch, view.fov) == (None, None, None)
    assert "yaw 0 is the left edge" in view.label

    cx, cy = red_centroid(out)
    assert cx == pytest.approx(500, abs=2) and cy == pytest.approx(500, abs=2)

    top = out[2].astype(int).min(axis=1)  # one row through the ticks
    for x, _yaw in ruler_ticks(2000)[1:-1]:
        assert top[x] > 200, f"missing tick at x={x}"
    for yaw in (7, 22, 97, 187, 352):
        assert top[round(yaw / 360 * 2000)] < 80, f"unexpected tick at yaw {yaw}"


def test_overview_labels_sit_under_their_ticks(tmp_path: Path) -> None:
    pano = Panorama(write_pano(tmp_path, np.full((H, W, 3), 60, np.uint8)))
    out = decode(pano.overview())
    text_rows = out[18:32].astype(int).min(axis=2)
    bright = np.nonzero((text_rows > 200).any(axis=0))[0]
    bright = bright[bright > 60]  # skip the pitch labels on the left edge
    for yaw in range(45, 360, 45):
        x = yaw / 360 * 2000
        assert np.abs(bright - x).min() <= 14, f"no label under the yaw {yaw} tick"
    for yaw in (22, 68, 112, 338):
        x = yaw / 360 * 2000
        assert np.abs(bright - x).min() > 14, f"label where none is expected (yaw {yaw})"


def test_output_size_rules() -> None:
    native = 6080 / (2 * math.pi)
    assert output_size(90, 1456, 1.0, native) == (1456, 1456)
    assert output_size(120, 1024, 1.0, native) == (1024, 1024)
    assert output_size(90, 5000, 1.0, native) == (MAX_SIDE, MAX_SIDE)
    assert output_size(90, 2000, 0.5, native) == (1000, 2000)
    assert output_size(90, 2000, 2.0, native) == (2000, 1000)
    # narrow crops: 2x native, not blown up to the full width
    width, height = output_size(20, 1456, 1.0, native)
    assert width == height == round(2 * 2 * math.tan(math.radians(10)) * native)
    assert output_size(5, 1456, 1.0, native) == (512, 512)


def test_render_clamps_inputs(tmp_path: Path) -> None:
    pano = Panorama(write_pano(tmp_path, textured()))
    view = pano.render(-90, 120, 500, out_width=400)
    assert (view.yaw, view.pitch, view.fov) == (270.0, 90.0, 120.0)
    assert pano.render(370, -200, 1, out_width=300).fov == 5.0


def test_views_are_saved_by_hash_and_blocks_are_valid(tmp_path: Path) -> None:
    image_dir = tmp_path / "run" / "images"
    pano = Panorama(write_pano(tmp_path, textured()), image_dir)
    view = pano.render(10, 5, 60, out_width=320, enhance=True)
    assert view.path == image_dir / f"{view.sha256}.jpg"
    assert view.path.read_bytes() == view.jpeg
    block = view.to_block()
    assert block["type"] == "image" and block["source"]["media_type"] == "image/jpeg"
    assert base64.standard_b64decode(block["source"]["data"]) == view.jpeg
    assert view.ref() == {"sha256": view.sha256, "path": str(view.path), "yaw": 10.0, "pitch": 5.0, "fov": 60.0}
    assert pano.render(10, 5, 60, out_width=320, enhance=True).sha256 == view.sha256
    assert pano.render(10, 5, 60, out_width=320).sha256 != view.sha256


def test_unreadable_image_raises(tmp_path: Path) -> None:
    path = tmp_path / "broken.jpg"
    path.write_bytes(b"not an image")
    with pytest.raises(ValueError):
        Panorama(path)


@pytest.fixture(scope="module")
def full_size_pano(tmp_path_factory: pytest.TempPathFactory) -> Panorama:
    width, height = 6080, 3040
    rng = np.random.default_rng(3)
    noise = rng.integers(0, 256, (height // 16, width // 16), dtype=np.uint8)
    img = cv2.cvtColor(cv2.resize(noise, (width, height), interpolation=cv2.INTER_LINEAR), cv2.COLOR_GRAY2BGR)
    for yaw, pitch in ((0, 0), (135, 0)):
        x, y = equirect_xy(yaw, pitch, width, height)
        for shift in (-width, 0, width):
            cv2.circle(img, (round(x) + shift, round(y)), 20, RED, -1)
    path = tmp_path_factory.mktemp("full") / "20261011093000_Urban.jpg"
    assert cv2.imwrite(str(path), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return Panorama(path, path.parent / "images")


def test_full_size_initial_views(full_size_pano: Panorama) -> None:
    pano = full_size_pano
    assert (pano.width, pano.height) == (6080, 3040)
    assert len(pano.sha256) == 64

    views = pano.initial_views()
    assert len(views) == 1 + len(INITIAL_YAWS) + 2
    assert (views[0].width, views[0].height) == (2000, 1000)
    for yaw, view in zip(INITIAL_YAWS, views[1:9]):
        assert (view.yaw, view.pitch, view.fov) == (float(yaw), 0.0, 90.0)
        assert (view.width, view.height) == (1456, 1456)
        assert f"yaw {yaw}, pitch 0, fov 90" in view.label
    up, down = views[9], views[10]
    assert (up.pitch, up.width, up.height) == (90.0, 1024, 1024)
    assert (down.pitch, down.width, down.height) == (-90.0, 1024, 1024)
    for view in views:
        assert max(view.width, view.height) <= MAX_SIDE
        assert view.path is not None and view.path.exists()
        assert decode(view).shape[:2] == (view.height, view.width)

    # the seam marker is centred in the yaw-0 view, the other one in the yaw-135 view
    for index in (1, 4):
        cx, cy = red_centroid(decode(views[index]))
        assert cx == pytest.approx(727.5, abs=2.5) and cy == pytest.approx(727.5, abs=2.5)


def test_full_size_zoom_sizes(full_size_pano: Panorama) -> None:
    native = 6080 / (2 * math.pi)
    narrow = full_size_pano.render(0, 0, 20)
    assert narrow.width == narrow.height == round(2 * 2 * math.tan(math.radians(10)) * native)
    assert full_size_pano.render(0, 0, 5).width == 512
    cx, cy = red_centroid(decode(narrow))
    assert cx == pytest.approx((narrow.width - 1) / 2, abs=2.5)
    assert cy == pytest.approx((narrow.height - 1) / 2, abs=2.5)
    assert full_size_pano.render(0, 0, 60).width == 1456
    huge = full_size_pano.render(0, 0, 100, out_width=4000, aspect=0.5)
    assert (huge.width, huge.height) == (1000, 2000)


def test_full_size_render_is_fast(full_size_pano: Panorama) -> None:
    full_size_pano.render(200, 0, 120)  # builds the downscaled level once
    timings = []
    for yaw, pitch, fov, enhance in ((10, 0, 90, False), (200, -20, 25, True), (300, 40, 120, False)):
        start = time.perf_counter()
        full_size_pano.render(yaw, pitch, fov, enhance=enhance)
        timings.append(time.perf_counter() - start)
    assert max(timings) < 1.0, timings


def ctx_for(pano: Panorama) -> SimpleNamespace:
    return SimpleNamespace(pano=pano, session=None, settings=None, http=None)


async def test_view_crop_returns_text_then_image(tmp_path: Path) -> None:
    pano = marker_pano(tmp_path, 300, 20)
    pano.image_dir = tmp_path / "images"
    result = await view_crop.run(ctx_for(pano), {"yaw": 300, "pitch": 20, "fov": 30, "enhance": False})
    assert not result.is_error
    assert [block["type"] for block in result.content] == ["text", "image"]
    assert "yaw 300.0, pitch +20.0" in result.content[0]["text"]
    image = cv2.imdecode(
        np.frombuffer(base64.standard_b64decode(result.content[1]["source"]["data"]), np.uint8), cv2.IMREAD_COLOR
    )
    cx, cy = red_centroid(image)
    assert cx == pytest.approx((image.shape[1] - 1) / 2, abs=2.5)
    assert cy == pytest.approx((image.shape[0] - 1) / 2, abs=2.5)
    ref = result.log["image"]
    assert (ref["yaw"], ref["pitch"], ref["fov"]) == (300.0, 20.0, 30.0)
    assert Path(ref["path"]).exists() and len(ref["sha256"]) == 64


async def test_view_crop_describes_the_span_and_clamps(tmp_path: Path) -> None:
    pano = Panorama(write_pano(tmp_path, textured()))
    result = await view_crop.run(ctx_for(pano), {"yaw": 10, "pitch": 0, "fov": 90, "enhance": True})
    assert "spans yaw 325.0 (left edge) to 55.0 (right edge)" in result.content[0]["text"]
    assert "pitch -45.0 to +45.0" in result.content[0]["text"]
    assert result.log["enhance"] is True and result.log["adjusted"] == []

    result = await view_crop.run(ctx_for(pano), {"yaw": 400, "pitch": -120, "fov": 2, "enhance": False})
    assert not result.is_error
    assert result.log["image"]["yaw"] == 40.0
    assert result.log["image"]["pitch"] == -90.0
    assert result.log["image"]["fov"] == 5.0
    assert len(result.log["adjusted"]) == 3
    assert "Adjusted input" in result.content[0]["text"]


@pytest.mark.parametrize(
    "args",
    [{}, {"yaw": "north", "pitch": 0, "fov": 60}, {"yaw": 0, "pitch": None, "fov": 60}, {"yaw": 0, "pitch": 0, "fov": float("nan")}],
)
async def test_view_crop_rejects_bad_input(tmp_path: Path, args: dict) -> None:
    pano = Panorama(write_pano(tmp_path, np.full((64, 128, 3), 90, np.uint8)))
    result = await view_crop.run(ctx_for(pano), args)
    assert result.is_error
    assert result.content[0]["type"] == "text"


def test_initial_views_are_lighter_than_crops_at_the_spec_sizes(full_size_pano: Panorama) -> None:
    """The initial set is re-uploaded on every request, so it is encoded more compactly; the
    sizes stay as SPEC 6.2 fixes them and on-demand crops keep full quality for reading text."""
    from geoagent import pano as pano_module

    assert pano_module.INITIAL_JPEG_QUALITY < pano_module.JPEG_QUALITY
    initial = full_size_pano.initial_views()
    forward = initial[1]
    same_view_as_crop = full_size_pano.render(0, 0, 90, out_width=1456)
    assert (forward.width, forward.height) == (same_view_as_crop.width, same_view_as_crop.height) == (1456, 1456)
    assert len(forward.jpeg) < 0.85 * len(same_view_as_crop.jpeg)
    total_b64 = sum(len(v.to_block()["source"]["data"]) for v in initial)
    at_crop_quality = (
        len(full_size_pano.overview().jpeg)
        + sum(len(full_size_pano.render(y, 0, 90, out_width=1456).jpeg) for y in INITIAL_YAWS)
        + len(full_size_pano.render(0, 90, 120, out_width=1024).jpeg)
        + len(full_size_pano.render(0, -90, 110, out_width=1024).jpeg)
    )
    assert total_b64 < 0.85 * at_crop_quality * 4 / 3
