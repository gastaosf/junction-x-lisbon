import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_FOV,
  MIN_FOV,
  aimAt,
  cameraBasis,
  clampCamera,
  createPanoViewer,
  cropOutline,
  direction,
  focalPx,
  formatPitch,
  formatYaw,
  fovLimits,
  neededWidth,
  outlinePolygons,
  pickSource,
  project,
  rulerTicks,
  unproject,
  unwrapOutline,
  verticalFov,
  wrapDelta,
  wrapYaw,
} from "../../server/static/console/js/components/pano-viewer.js";

const RAD = Math.PI / 180;
const near = (actual, expected, tolerance = 1e-6, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, message || `${actual} is not within ${tolerance} of ${expected}`);
const camera = (over = {}) => ({ mode: "360", yaw: 180, pitch: 0, fov: 90, width: 800, height: 400, ...over });

// The same mapping as astrolabio/pano.py::_rectilinear_maps, written out independently: x and y are
// offsets from the view centre in units of the focal length (x right, y up).
function panoPyAngles(yaw, pitch, x, y) {
  const sinP = Math.sin(pitch * RAD);
  const cosP = Math.cos(pitch * RAD);
  const up = y * cosP + sinP;
  const forward = cosP - y * sinP;
  return {
    yaw: wrapYaw((Math.atan2(x, forward) + yaw * RAD) / RAD),
    pitch: Math.atan2(up, Math.hypot(x, forward)) / RAD,
  };
}

// ---------------------------------------------------------------------------------------------
// Angles and the camera
// ---------------------------------------------------------------------------------------------

test("wrapYaw and wrapDelta", () => {
  assert.equal(wrapYaw(0), 0);
  assert.equal(wrapYaw(360), 0);
  assert.equal(wrapYaw(-10), 350);
  assert.equal(wrapYaw(725), 5);
  assert.equal(wrapDelta(10 - 350), 20);
  assert.equal(wrapDelta(350 - 10), -20);
  assert.equal(wrapDelta(180), -180);
  assert.equal(wrapDelta(0), 0);
});

test("the frame: yaw 0 looks along +Z, yaw 90 along +X, pitch 90 straight up", () => {
  const close = (v, e) => v.forEach((c, i) => near(c, e[i], 1e-12));
  close(direction(0, 0), [0, 0, 1]);
  close(direction(90, 0), [1, 0, 0]);
  close(direction(180, 0), [0, 0, -1]);
  close(direction(37, 90), [0, 1, 0]);
});

test("the camera basis is orthonormal and right-handed for any yaw and pitch", () => {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const [yaw, pitch] of [[0, 0], [135, 20], [359, -70], [200, 89]]) {
    const { right, up, forward } = cameraBasis(yaw, pitch);
    for (const v of [right, up, forward]) near(dot(v, v), 1, 1e-12);
    near(dot(right, up), 0, 1e-12);
    near(dot(right, forward), 0, 1e-12);
    near(dot(up, forward), 0, 1e-12);
    // up x forward = right
    near(up[1] * forward[2] - up[2] * forward[1], right[0], 1e-12);
    near(up[2] * forward[0] - up[0] * forward[2], right[1], 1e-12);
  }
});

test("the centre of the view projects to the centre of the viewport", () => {
  for (const [yaw, pitch] of [[180, 0], [0, 0], [350, 40], [77.5, -63]]) {
    const p = project(yaw, pitch, camera({ yaw, pitch }));
    near(p.x, 400, 1e-9);
    near(p.y, 200, 1e-9);
    assert.equal(p.visible, true);
    assert.equal(p.front, true);
  }
});

test("yaw grows to the right and pitch grows upwards", () => {
  const cam = camera({ yaw: 135 });
  assert.ok(project(145, 0, cam).x > 400);
  assert.ok(project(125, 0, cam).x < 400);
  assert.ok(project(135, 10, cam).y < 200);
  assert.ok(project(135, -10, cam).y > 200);
});

test("the horizontal fov spans the viewport width", () => {
  const cam = camera({ fov: 90 });
  near(project(225, 0, cam).x, 800, 1e-9);
  near(project(135, 0, cam).x, 0, 1e-9);
  near(focalPx(cam), 400, 1e-9);
  // 2:1 viewport at fov 90: the vertical half-angle is atan(0.5).
  near(project(180, Math.atan(0.5) / RAD, cam).y, 0, 1e-9);
});

test("a point 180 degrees away is not visible", () => {
  const behind = project(0, 0, camera({ yaw: 180 }));
  assert.equal(behind.visible, false);
  assert.equal(behind.front, false);
  assert.ok(Number.isNaN(behind.x));
  // Still behind when it is merely more than 90 degrees off.
  assert.equal(project(300, 0, camera({ yaw: 180 })).front, false);
  // In front but outside the viewport: front, not visible.
  const aside = project(260, 0, camera({ yaw: 180 }));
  assert.equal(aside.front, true);
  assert.equal(aside.visible, false);
});

test("yaw wraps around the seam", () => {
  const acrossSeam = project(10, 0, camera({ yaw: 350 }));
  const plain = project(200, 0, camera({ yaw: 180 }));
  near(acrossSeam.x, plain.x, 1e-9);
  assert.equal(acrossSeam.visible, true);
  near(project(370, 5, camera({ yaw: 350 })).x, acrossSeam.x, 1e-9);
  near(project(-350, 0, camera({ yaw: 350 })).x, acrossSeam.x, 1e-9);
  assert.ok(project(340, 0, camera({ yaw: 5 })).x < 400);
});

test("unproject inverts project", () => {
  const cam = camera({ yaw: 310, pitch: 25, fov: 70, width: 900, height: 500 });
  for (const [x, y] of [[450, 250], [0, 0], [900, 500], [123, 456], [800, 20]]) {
    const angles = unproject(x, y, cam);
    const back = project(angles.yaw, angles.pitch, cam);
    near(back.x, x, 1e-6);
    near(back.y, y, 1e-6);
  }
  const centre = unproject(450, 250, cam);
  near(centre.yaw, 310, 1e-9);
  near(centre.pitch, 25, 1e-9);
});

test("aimAt turns the camera so a direction lands on a given pixel", () => {
  for (const mode of ["360", "flat"]) {
    const cam = camera({ mode, yaw: 350, pitch: mode === "flat" ? 5 : 30, fov: 80, width: 900, height: 500 });
    for (const [x, y] of [[450, 250], [100, 60], [820, 470], [450, 10]]) {
      for (const target of [{ yaw: 10, pitch: 20 }, { yaw: 300, pitch: -15 }, { yaw: 355, pitch: 40 }]) {
        const aimed = { ...cam, ...aimAt(target, x, y, cam) };
        const at = project(target.yaw, target.pitch, aimed);
        near(at.x, x, 1e-6);
        near(at.y, y, 1e-6);
      }
    }
  }
  // A target near the zenith cannot be brought to the bottom edge without tipping over: the
  // camera stops at the pole instead of returning nonsense.
  const stuck = aimAt({ yaw: 355, pitch: 80 }, 820, 470, camera({ width: 900, height: 500 }));
  assert.equal(stuck.pitch, 90);
  assert.ok(Number.isFinite(stuck.yaw));
});

test("the viewer's rays match the renderer in astrolabio/pano.py", () => {
  for (const [yaw, pitch, fov] of [[135, 0, 60], [350, 30, 90], [10, -45, 40], [200, 80, 100]]) {
    const cam = camera({ yaw, pitch, fov, width: 1000, height: 1000 });
    const focal = focalPx(cam);
    for (const [x, y] of [[0, 0], [0.4, 0.1], [-0.3, -0.5], [0.55, 0.55]]) {
      const expected = panoPyAngles(yaw, pitch, x, y);
      const actual = unproject(500 + x * focal, 500 - y * focal, cam);
      near(wrapDelta(actual.yaw - expected.yaw), 0, 1e-9);
      near(actual.pitch, expected.pitch, 1e-9);
    }
  }
});

test("flat mode: yaw and pitch map linearly, nearest copy across the seam", () => {
  const cam = camera({ mode: "flat", yaw: 180, pitch: 0, fov: 360 });
  near(project(180, 0, cam).x, 400);
  near(project(0, 0, cam).x, 0);
  near(project(270, 0, cam).x, 600);
  near(project(180, 90, cam).y, 0);
  near(project(180, -90, cam).y, 400);
  const seam = camera({ mode: "flat", yaw: 350, pitch: 0, fov: 90 });
  near(project(10, 0, seam).x, 400 + 20 * (800 / 90));
  const back = unproject(700, 150, seam);
  const again = project(back.yaw, back.pitch, seam);
  near(again.x, 700, 1e-9);
  near(again.y, 150, 1e-9);
});

// ---------------------------------------------------------------------------------------------
// Crop outlines
// ---------------------------------------------------------------------------------------------

test("cropOutline: point count, corners, default steps", () => {
  const crop = { n: 1, yaw: 135, pitch: 0, fov: 60, width: 1000, height: 1000 };
  assert.equal(cropOutline(crop).length, 64);
  const outline = cropOutline(crop, 8);
  assert.equal(outline.length, 32);
  // Top-left corner first, then clockwise.
  assert.ok(wrapDelta(outline[0].yaw - 135) < 0 && outline[0].pitch > 0);
  assert.ok(wrapDelta(outline[8].yaw - 135) > 0 && outline[8].pitch > 0);
  assert.ok(wrapDelta(outline[16].yaw - 135) > 0 && outline[16].pitch < 0);
  assert.ok(wrapDelta(outline[24].yaw - 135) < 0 && outline[24].pitch < 0);
  // Mid-points of the side edges lie on the horizon, half the fov away.
  near(wrapDelta(outline[12].yaw - 135), 30, 1e-9);
  near(outline[12].pitch, 0, 1e-9);
  near(wrapDelta(outline[28].yaw - 135), -30, 1e-9);
});

test("cropOutline is symmetric about the view centre at pitch 0", () => {
  const steps = 8;
  const outline = cropOutline({ yaw: 200, pitch: 0, fov: 80, width: 1200, height: 800 }, steps);
  const has = (yaw, pitch) =>
    outline.some((p) => Math.abs(wrapDelta(p.yaw - yaw)) < 1e-9 && Math.abs(p.pitch - pitch) < 1e-9);
  for (const point of outline) {
    const offset = wrapDelta(point.yaw - 200);
    assert.ok(has(200 - offset, point.pitch), "left-right mirror image is on the outline");
    assert.ok(has(point.yaw, -point.pitch), "top-bottom mirror image is on the outline");
  }
});

test("cropOutline keeps its left-right symmetry when the crop is pitched", () => {
  const outline = cropOutline({ yaw: 90, pitch: 35, fov: 70, width: 1000, height: 600 }, 6);
  for (const point of outline) {
    const offset = wrapDelta(point.yaw - 90);
    assert.ok(
      outline.some((p) => Math.abs(wrapDelta(p.yaw - (90 - offset))) < 1e-9 && Math.abs(p.pitch - point.pitch) < 1e-9),
    );
  }
});

test("vertical fov comes from the aspect (amendment A9)", () => {
  const crop = { yaw: 40, pitch: 0, fov: 60, width: 1456, height: 728 };
  const expected = (2 * Math.atan(Math.tan(30 * RAD) * 0.5)) / RAD;
  near(verticalFov(crop), expected, 1e-12);
  const steps = 10;
  const outline = cropOutline(crop, steps);
  // Middle of the top edge and of the bottom edge.
  near(outline[steps / 2].pitch, expected / 2, 1e-9);
  near(outline[2 * steps + steps / 2].pitch, -expected / 2, 1e-9);
  near(wrapDelta(outline[steps / 2].yaw - 40), 0, 1e-9);
  // A portrait crop is taller than it is wide; a crop without a size is square.
  assert.ok(verticalFov({ fov: 60, width: 500, height: 1000 }) > 60);
  near(verticalFov({ fov: 60 }), 60, 1e-9);
  near(cropOutline({ yaw: 40, pitch: 0, fov: 60 }, 4)[2].pitch, 30, 1e-9);
});

test("a crop's outline matches where pano.py puts its border pixels", () => {
  const crop = { yaw: 300, pitch: -20, fov: 50, width: 1000, height: 500 };
  const outline = cropOutline(crop, 4);
  const tanX = Math.tan(25 * RAD);
  const tanY = tanX * 0.5;
  const corners = [[-tanX, tanY], [tanX, tanY], [tanX, -tanY], [-tanX, -tanY]];
  corners.forEach(([x, y], i) => {
    const expected = panoPyAngles(300, -20, x, y);
    near(wrapDelta(outline[i * 4].yaw - expected.yaw), 0, 1e-9);
    near(outline[i * 4].pitch, expected.pitch, 1e-9);
  });
});

test("seen through a camera with the same view, a crop's outline is the viewport border", () => {
  const view = { yaw: 350, pitch: 25, fov: 70, width: 800, height: 600 };
  const [polygon] = outlinePolygons(cropOutline(view, 12), camera(view));
  assert.equal(polygon.length, 48);
  for (const p of polygon) {
    const onBorder =
      Math.abs(p.x) < 1e-6 || Math.abs(p.x - 800) < 1e-6 || Math.abs(p.y) < 1e-6 || Math.abs(p.y - 600) < 1e-6;
    assert.ok(onBorder, `(${p.x}, ${p.y}) is on the viewport border`);
  }
  near(polygon[0].x, 0, 1e-6);
  near(polygon[0].y, 0, 1e-6);
  near(polygon[24].x, 800, 1e-6);
  near(polygon[24].y, 600, 1e-6);
});

test("an outline that straddles the wrap seam stays one shape", () => {
  const outline = cropOutline({ yaw: 2, pitch: 0, fov: 40, width: 1, height: 1 }, 8);
  assert.ok(outline.some((p) => p.yaw > 330));
  assert.ok(outline.some((p) => p.yaw < 30));
  const unwrapped = unwrapOutline(outline);
  assert.equal(unwrapped.winding, 0);
  assert.equal(unwrapped.pole, 0);
  for (let i = 1; i < unwrapped.points.length; i += 1) {
    assert.ok(Math.abs(unwrapped.points[i].yaw - unwrapped.points[i - 1].yaw) < 20, "no jump at the seam");
  }
  // 360 mode: one polygon, continuous across the seam.
  const [polygon] = outlinePolygons(outline, camera({ yaw: 0, fov: 90 }));
  assert.ok(polygon.every((p) => p.x > 150 && p.x < 650));
  // Flat mode, whole strip centred on yaw 180: the shape shows at both ends.
  const flat = outlinePolygons(outline, camera({ mode: "flat", fov: 360 }));
  assert.equal(flat.length, 2);
  const centres = flat.map((poly) => poly.reduce((sum, p) => sum + p.x, 0) / poly.length).sort((a, b) => a - b);
  near(centres[0], 800 * (2 / 360), 1);
  near(centres[1], 800 * (362 / 360), 1);
  // Centred on the seam there is exactly one copy.
  assert.equal(outlinePolygons(outline, camera({ mode: "flat", yaw: 0, fov: 120 })).length, 1);
});

test("outlines behind the camera are dropped; those crossing the camera plane are clipped", () => {
  const cam = camera({ yaw: 180, fov: 90 });
  assert.deepEqual(outlinePolygons(cropOutline({ yaw: 0, pitch: 0, fov: 60 }), cam), []);
  // Out of the picture altogether, although in front of the camera.
  assert.deepEqual(outlinePolygons(cropOutline({ yaw: 250, pitch: 0, fov: 20 }), cam), []);
  // Centred 80 degrees to the right with a wide fov: part in view, part behind the camera.
  const [clipped] = outlinePolygons(cropOutline({ yaw: 260, pitch: 0, fov: 110 }), cam);
  assert.ok(clipped.length >= 3);
  assert.ok(clipped.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.ok(clipped.some((p) => p.x > 400 && p.x < 800), "its near edge is inside the viewport");
  assert.ok(clipped.every((p) => p.x > 400), "nothing is mirrored to the left half");
});

test("an outline around a pole runs across the whole flat strip", () => {
  const outline = cropOutline({ yaw: 30, pitch: 90, fov: 100 }, 12);
  assert.ok(outline.every((p) => p.pitch > 0));
  const unwrapped = unwrapOutline(outline);
  assert.equal(Math.abs(unwrapped.winding), 1);
  assert.equal(unwrapped.pole, 90);
  const cam = camera({ mode: "flat", fov: 360, width: 800, height: 400 });
  const polygons = outlinePolygons(outline, cam);
  assert.equal(polygons.length, 1);
  const xs = polygons[0].map((p) => p.x);
  assert.ok(Math.min(...xs) <= 0 && Math.max(...xs) >= 800, "covers the viewport from edge to edge");
  // The closing edge is above the strip, so it is never drawn across the image.
  assert.ok(polygons[0].some((p) => p.y < 0));
  const nadir = unwrapOutline(cropOutline({ yaw: 0, pitch: -90, fov: 110 }, 12));
  assert.equal(nadir.pole, -90);
  // Seen from below in 360 mode the zenith crop is simply behind the camera.
  assert.deepEqual(outlinePolygons(outline, camera({ pitch: -60 })), []);
});

// ---------------------------------------------------------------------------------------------
// Limits, ruler, sources, formatting
// ---------------------------------------------------------------------------------------------

test("fov limits", () => {
  assert.deepEqual(fovLimits("360", 800, 400), { min: MIN_FOV, max: MAX_FOV });
  // A tall viewport: the vertical fov is capped at 120 degrees, which narrows the horizontal one.
  const tall = fovLimits("360", 300, 600);
  near(tall.max, (2 * Math.atan(Math.tan(60 * RAD) * 0.5)) / RAD, 1e-9);
  // Flat: the whole strip fits the height.
  assert.equal(fovLimits("flat", 800, 400).max, 360);
  assert.equal(fovLimits("flat", 700, 200).max, 630);
});

test("clampCamera", () => {
  const wide = clampCamera(camera({ yaw: -30, pitch: 120, fov: 400 }));
  assert.equal(wide.yaw, 330);
  assert.equal(wide.pitch, 90);
  assert.equal(wide.fov, MAX_FOV);
  assert.equal(clampCamera(camera({ fov: 1 })).fov, MIN_FOV);
  // The whole strip leaves no room to scroll vertically; zoomed in, it scrolls to the edge only.
  const whole = clampCamera(camera({ mode: "flat", fov: Infinity, pitch: 40 }));
  assert.equal(whole.fov, 360);
  assert.equal(whole.pitch, 0);
  const zoomed = clampCamera(camera({ mode: "flat", fov: 180, pitch: 80 }));
  assert.equal(zoomed.pitch, 45);
  // Garbage in, a usable camera out.
  const junk = clampCamera({ mode: "x", yaw: "a", pitch: null, fov: NaN, width: 0, height: 0 });
  assert.equal(junk.mode, "360");
  assert.equal(junk.yaw, 0);
  assert.equal(junk.pitch, 0);
  assert.ok(junk.fov >= MIN_FOV && junk.fov <= MAX_FOV);
});

test("the flat ruler at full strip is the agent's ruler: ticks every 15, labels every 45", () => {
  const ticks = rulerTicks(camera({ mode: "flat", fov: 360, width: 1000, height: 500 }));
  assert.deepEqual(ticks.map((t) => t.yaw), [...Array(25).keys()].map((i) => (i * 15) % 360));
  assert.deepEqual(ticks.filter((t) => t.label).map((t) => t.yaw), [0, 45, 90, 135, 180, 225, 270, 315, 0]);
  assert.ok(ticks.filter((t) => t.label).every((t) => t.anchor));
  near(ticks[0].x, 0, 1e-9);
  near(ticks[12].x, 500, 1e-9);
  near(ticks[24].x, 1000, 1e-9);
});

test("the ruler refines as the view zooms in and keeps the 45 degree anchors", () => {
  const steps = (fov) => {
    const labelled = rulerTicks(camera({ fov, width: 1200, height: 600 })).filter((t) => t.label);
    return wrapYaw(labelled[1].yaw - labelled[0].yaw);
  };
  assert.equal(steps(100), 15);
  assert.equal(steps(40), 5);
  assert.equal(steps(15), 1);
  const ticks = rulerTicks(camera({ yaw: 135, fov: 40, width: 1200, height: 600 }));
  const centre = ticks.find((t) => t.yaw === 135);
  near(centre.x, 600, 1e-9);
  assert.equal(centre.anchor, true);
  assert.equal(centre.label, true);
  assert.ok(ticks.every((t, i) => i === 0 || t.x > ticks[i - 1].x), "ticks run left to right");
  assert.ok(ticks.every((t) => t.x >= -1e-9 && t.x <= 1200 + 1e-9));
});

test("the 360 ruler reads the centre row, as view_crop reports it", () => {
  const cam = camera({ yaw: 350, pitch: 30, fov: 90, width: 1000, height: 1000 });
  const ticks = rulerTicks(cam);
  assert.ok(ticks.some((t) => t.yaw === 0) && ticks.some((t) => t.yaw === 345), "wraps through 0");
  for (const tick of ticks) {
    // The tick sits in the column whose centre-row pixel has that yaw.
    near(wrapDelta(unproject(tick.x, 500, cam).yaw - tick.yaw), 0, 1e-9);
  }
  // Looking straight up there is no yaw scale along the centre row.
  assert.deepEqual(rulerTicks(camera({ pitch: 90 })), []);
});

test("neededWidth: pixels of panorama that one turn takes at the centre of the view", () => {
  near(neededWidth(camera({ fov: 90 })), 2 * Math.PI * 400, 1e-9);
  near(neededWidth(camera({ fov: 90 }), 2), 4 * Math.PI * 400, 1e-9);
  assert.ok(neededWidth(camera({ fov: 20 })) > neededWidth(camera({ fov: 90 })));
  near(neededWidth(camera({ mode: "flat", fov: 360 })), 800, 1e-9);
  near(neededWidth(camera({ mode: "flat", fov: 90 }), 2), 6400, 1e-9);
});

test("pickSource: the smallest that is sharp enough, else the widest", () => {
  const sources = [{ width: 1024 }, { width: 2048 }, { width: 4096 }, { width: 6080 }];
  assert.equal(pickSource(sources, 600), 0);
  assert.equal(pickSource(sources, 1024), 0);
  // A little short of ideal is accepted rather than doubling the download.
  assert.equal(pickSource(sources, 1150), 0);
  assert.equal(pickSource(sources, 1500), 1);
  assert.equal(pickSource(sources, 5000), 3);
  assert.equal(pickSource(sources, 50000), 3);
  // Bounded by MAX_TEXTURE_SIZE: the 6080 image would be scaled to 4096, so the 4096 one wins.
  assert.equal(pickSource(sources, 50000, { maxSize: 4096 }), 2);
  assert.equal(pickSource(sources, 3000, { maxSize: 2048 }), 1);
  // A source that failed to load is skipped in both directions.
  assert.equal(pickSource(sources, 1500, { failed: new Set([1]) }), 2);
  assert.equal(pickSource(sources, 50000, { failed: new Set([3]) }), 2);
  assert.equal(pickSource(sources, 600, { failed: new Set([0, 1, 2, 3]) }), -1);
  assert.equal(pickSource([], 600), -1);
  // Order of the list does not matter.
  assert.equal(pickSource([{ width: 4096 }, { width: 1024 }], 800), 1);
});

test("formatYaw and formatPitch", () => {
  assert.equal(formatYaw(135), "135.0°");
  assert.equal(formatYaw(359.96), "0.0°");
  assert.equal(formatYaw(-0.5), "359.5°");
  assert.equal(formatPitch(2), "+2.0°");
  assert.equal(formatPitch(-12.54), "-12.5°");
  assert.equal(formatPitch(-0.01), "+0.0°");
});

// ---------------------------------------------------------------------------------------------
// The viewer itself, against a minimal fake DOM (no browser): construction, loading, drawing,
// input and teardown paths run, with a recording stand-in for WebGL and for the 2D canvas.
// ---------------------------------------------------------------------------------------------

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(name) { this.names.add(name); }
  remove(name) { this.names.delete(name); }
  contains(name) { return this.names.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : Boolean(force);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
}

class FakeNode {
  constructor(tag, doc) {
    this.tagName = tag;
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.clientWidth = 0;
    this.clientHeight = 0;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === "string") { this.textContent += node; continue; }
      node.remove();
      node.parentNode = this;
      this.children.push(node);
    }
  }
  insertBefore(node, reference) {
    node.remove();
    node.parentNode = this;
    this.children.splice(this.children.indexOf(reference), 0, node);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  contains(node) {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
  closest(selector) {
    const name = selector.slice(1, -1);
    for (let at = this; at; at = at.parentNode) if (name in at.attributes) return at;
    return null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    if (options.signal) options.signal.addEventListener("abort", () => this.listeners.get(type).delete(handler));
  }
  emit(type, event = {}) {
    const full = { type, target: this, timeStamp: 0, preventDefault() {}, stopPropagation() {}, ...event };
    for (const handler of [...(this.listeners.get(type) || [])]) handler(full);
    return full;
  }
  listenerCount() {
    let total = 0;
    for (const handlers of this.listeners.values()) total += handlers.size;
    return total;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  setPointerCapture() {}
  getContext(name) { return this.ownerDocument.context(name, this); }
  decode() {
    const found = this.ownerDocument.images[this.src];
    if (!found) return Promise.reject(new Error("404"));
    this.naturalWidth = found.width;
    this.naturalHeight = found.height;
    return Promise.resolve();
  }
  find(className) {
    if (this.className.split(" ").includes(className) || (this.attributes.class || "").split(" ").includes(className)) return this;
    for (const child of this.children) {
      const hit = child.find(className);
      if (hit) return hit;
    }
    return null;
  }
  findAll(className, out = []) {
    if (this.className.split(" ").includes(className) || (this.attributes.class || "").split(" ").includes(className)) out.push(this);
    for (const child of this.children) child.findAll(className, out);
    return out;
  }
}

// A WebGL context that accepts every call and records them.
function fakeGl() {
  const calls = [];
  const state = { lost: false, released: false };
  const known = {
    calls,
    state,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getParameter: () => 4096,
    isContextLost: () => state.lost,
    getUniformLocation: (_, name) => name,
    getExtension: () => ({ loseContext: () => { state.released = true; } }),
  };
  return new Proxy(known, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => { calls.push([key, ...args]); return {}; };
    },
  });
}

function fakeBrowser({ webgl = true, images = {}, width = 800, height = 400, observers = false } = {}) {
  const frames = [];
  const timers = new Map();
  let timerId = 0;
  const gl = webgl ? fakeGl() : null;
  const drawn = [];
  const context2d = { fillStyle: "", fillRect() {}, drawImage: (...args) => drawn.push(args) };
  const doc = {
    images,
    fullscreenElement: null,
    createElement: (tag) => {
      const node = new FakeNode(tag, doc);
      if (tag === "div") { node.clientWidth = width; node.clientHeight = height; }
      return node;
    },
    createElementNS: (_, tag) => new FakeNode(tag, doc),
    context: (name) => (name === "2d" ? context2d : name.startsWith("webgl") || name === "experimental-webgl" ? gl : null),
    exitFullscreen: () => { doc.fullscreenElement = null; return Promise.resolve(); },
  };
  const docNode = new FakeNode("#document", doc);
  doc.addEventListener = docNode.addEventListener.bind(docNode);
  doc.emit = docNode.emit.bind(docNode);
  doc.listenerCount = docNode.listenerCount.bind(docNode);
  const winNode = new FakeNode("#window", doc);
  const win = {
    devicePixelRatio: 2,
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => { frames.length = 0; },
    setTimeout: (fn) => { timerId += 1; timers.set(timerId, fn); return timerId; },
    clearTimeout: (id) => { timers.delete(id); },
    getComputedStyle: () => ({ fontSize: "11px" }),
    matchMedia: () => ({ matches: false }),
    addEventListener: winNode.addEventListener.bind(winNode),
    listenerCount: winNode.listenerCount.bind(winNode),
  };
  if (observers) {
    win.observed = [];
    win.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; win.observed.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    };
  }
  doc.defaultView = win;
  const container = new FakeNode("div", doc);
  let now = 0;
  return {
    doc, win, gl, drawn, container,
    // Runs one animation frame, `ms` after the previous one.
    frame(ms = 16) {
      now += ms;
      const batch = frames.splice(0);
      for (const fn of batch) fn(now);
      return batch.length;
    },
    pendingFrames: () => frames.length,
    runTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

const SOURCES = [
  { width: 1024, url: "/img?w=1024" },
  { width: 4096, url: "/img?w=4096" },
  { width: 2048, url: "/img?w=2048" },
];
const IMAGES = {
  "/img?w=1024": { width: 1024, height: 512 },
  "/img?w=2048": { width: 2048, height: 1024 },
  "/img?w=4096": { width: 4096, height: 2048 },
};
const glCalls = (browser, name) => browser.gl.calls.filter((call) => call[0] === name);
const lastUniform = (browser, name) => glCalls(browser, "uniform1f").filter((c) => c[1] === name).pop();
const uploads = (browser) => glCalls(browser, "texImage2D").map((call) => call[6].naturalWidth);

test("viewer: first paint from the smallest source, then sharper ones on zoom", async () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES });
  assert.equal(browser.container.children[0], viewer.el);
  assert.equal(viewer.getMode(), "360");
  assert.equal(viewer.el.find("pv-note").hidden, false, "says it is loading");
  await browser.settle();
  browser.frame();
  assert.deepEqual(uploads(browser), [1024]);
  assert.equal(viewer.el.find("pv-note").hidden, true);
  assert.ok(glCalls(browser, "drawArrays").length >= 1);
  assert.equal(lastUniform(browser, "u_flat")[2], 0);
  // Canvas honours devicePixelRatio.
  const canvas = viewer.el.find("pv-canvas");
  assert.equal(canvas.width, 1600);
  assert.equal(canvas.height, 800);
  // The default view (fov 100 on 800 css px at 2x) needs about 4200 px: the 4096 source follows.
  browser.runTimers();
  await browser.settle();
  assert.deepEqual(uploads(browser), [1024, 4096]);
  // Zooming back out to something the 2048 source covers swaps the detail layer down again.
  viewer.setMode("flat");
  browser.frame();
  browser.runTimers();
  await browser.settle();
  assert.deepEqual(uploads(browser), [1024, 4096, 2048]);
  assert.equal(glCalls(browser, "deleteTexture").length, 1, "the replaced detail texture is released");
  viewer.destroy();
});

test("viewer: renders only when something changed", async () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES.slice(0, 1) });
  await browser.settle();
  while (browser.frame()) { /* drain */ }
  const before = glCalls(browser, "drawArrays").length;
  assert.equal(browser.pendingFrames(), 0, "no permanent loop");
  viewer.lookAt({ yaw: 90 });
  assert.equal(browser.pendingFrames(), 1);
  browser.frame();
  assert.equal(glCalls(browser, "drawArrays").length, before + 1);
  assert.equal(browser.pendingFrames(), 0);
  assert.equal(viewer.getCamera().yaw, 90);
  assert.equal(viewer.el.find("pv-field-yaw").find("pv-val").textContent, "90.0°");
  viewer.destroy();
});

test("viewer: a source that 404s keeps the previous image; none at all shows a note", async () => {
  const browser = fakeBrowser({ images: { "/img?w=1024": IMAGES["/img?w=1024"] } });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES });
  await browser.settle();
  browser.frame();
  browser.runTimers();
  await browser.settle();
  browser.frame();
  browser.runTimers();
  await browser.settle();
  assert.deepEqual(uploads(browser), [1024], "both sharper sources failed; the first stays");
  assert.equal(viewer.el.find("pv-note").hidden, true);
  // Nothing loads at all.
  viewer.setSources([{ width: 512, url: "/missing-a" }, { width: 1024, url: "/missing-b" }]);
  await browser.settle();
  const note = viewer.el.find("pv-note");
  assert.equal(note.hidden, false);
  assert.equal(note.children[1].textContent, "Image unavailable");
  assert.ok(note.classList.contains("is-problem"));
  // And a later good source clears it.
  viewer.setSources(SOURCES.slice(0, 1));
  await browser.settle();
  assert.equal(note.hidden, true);
  viewer.destroy();
});

test("viewer: a failed image is tried again later, when the view next changes", async () => {
  const images = {};
  const browser = fakeBrowser({ images });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES.slice(0, 1) });
  await browser.settle();
  const note = viewer.el.find("pv-note");
  assert.equal(note.children[1].textContent, "Image unavailable");
  // The connection is back, but nothing is retried at once or on a timer.
  images["/img?w=1024"] = IMAGES["/img?w=1024"];
  viewer.lookAt({ yaw: 10 });
  browser.frame();
  browser.runTimers();
  await browser.settle();
  assert.deepEqual(uploads(browser), []);
  const realNow = Date.now;
  Date.now = () => realNow() + 60000;
  try {
    viewer.lookAt({ yaw: 20 });
    browser.frame();
    browser.runTimers();
    await browser.settle();
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(uploads(browser), [1024]);
  assert.equal(note.hidden, true);
  viewer.destroy();
});

test("viewer: images wait until the viewer is on screen", async () => {
  const browser = fakeBrowser({ images: IMAGES, observers: true });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES });
  await browser.settle();
  assert.deepEqual(uploads(browser), []);
  browser.win.observed[0].callback([{ isIntersecting: false }]);
  await browser.settle();
  assert.deepEqual(uploads(browser), []);
  browser.win.observed[0].callback([{ isIntersecting: true }]);
  await browser.settle();
  assert.deepEqual(uploads(browser), [1024]);
  assert.equal(browser.win.observed[0].disconnected, true);
  viewer.destroy();
});

test("viewer: without WebGL it falls back to the flat strip", async () => {
  const browser = fakeBrowser({ webgl: false, images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES.slice(0, 1), mode: "360" });
  assert.equal(viewer.getMode(), "flat");
  assert.equal(viewer.setMode("360"), "flat");
  await browser.settle();
  browser.frame();
  assert.ok(browser.drawn.length >= 1, "drawn on the 2D canvas");
  const [sphere, flat] = viewer.el.find("pv-segment").children;
  assert.equal(sphere.disabled, true);
  assert.match(sphere.title, /WebGL/);
  assert.equal(flat.attributes["aria-pressed"], "true");
  // Whole strip: 800 x 400 viewport shows exactly one turn.
  assert.equal(viewer.getCamera().fov, 360);
  viewer.destroy();
});

test("viewer: a lost WebGL context falls back to the strip and comes back when restored", async () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES.slice(0, 1) });
  await browser.settle();
  browser.frame();
  const canvas = viewer.el.find("pv-canvas");
  browser.gl.state.lost = true;
  canvas.emit("webglcontextlost");
  browser.frame();
  assert.equal(viewer.getMode(), "flat");
  assert.equal(canvas.hidden, true);
  assert.ok(browser.drawn.length >= 1);
  browser.gl.state.lost = false;
  canvas.emit("webglcontextrestored");
  browser.frame();
  assert.equal(viewer.getMode(), "360");
  assert.equal(canvas.hidden, false);
  assert.deepEqual(uploads(browser), [1024, 1024], "the texture is uploaded again");
  viewer.destroy();
});

test("viewer: mode toggle, flat uniforms, lookAt clamps", async () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES.slice(0, 1), mode: "flat" });
  await browser.settle();
  browser.frame();
  assert.equal(viewer.getMode(), "flat");
  assert.equal(lastUniform(browser, "u_flat")[2], 1);
  const strip = glCalls(browser, "uniform4f").pop();
  // centre u, centre v, half span u, half span v for the whole strip centred on yaw 180.
  assert.deepEqual(strip.slice(2), [0.5, 0.5, 0.5, 0.5]);
  assert.equal(viewer.setMode("360"), "360");
  viewer.lookAt({ yaw: 725, pitch: 200, fov: 1 });
  const cam = viewer.getCamera();
  assert.equal(cam.yaw, 5);
  assert.equal(cam.pitch, 90);
  assert.equal(cam.fov, MIN_FOV);
  // Each mode keeps its own zoom; going back to flat is the whole strip again.
  viewer.setMode("flat");
  assert.equal(viewer.getCamera().fov, 360);
  viewer.destroy();
});

test("viewer: animated lookAt takes the short way round and ends on target", async () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES.slice(0, 1) });
  viewer.lookAt({ yaw: 350, pitch: 0, fov: 90 });
  viewer.lookAt({ yaw: 20, pitch: 10, fov: 45 }, { animate: true });
  browser.frame();
  browser.frame(300);
  const mid = viewer.getCamera();
  assert.ok(mid.yaw > 350 || mid.yaw < 20, `passes through the seam, not the long way (${mid.yaw})`);
  assert.ok(mid.fov < 90 && mid.fov > 45);
  for (let i = 0; i < 10; i += 1) browser.frame(100);
  const end = viewer.getCamera();
  near(end.yaw, 20, 1e-9);
  near(end.pitch, 10, 1e-9);
  near(end.fov, 45, 1e-9);
  assert.equal(browser.pendingFrames(), 0);
  viewer.destroy();
});

test("viewer: drag looks around, wheel zooms about the pointer, double-click resets", async () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES.slice(0, 1) });
  const stage = viewer.el.find("pv-stage");
  const start = viewer.getCamera();
  const pointer = (x, y, timeStamp) => ({ pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y, timeStamp });
  stage.emit("pointerdown", pointer(400, 200, 0));
  stage.emit("pointermove", pointer(500, 240, 400));
  stage.emit("pointerup", pointer(500, 240, 900));
  const dragged = viewer.getCamera();
  // The scene follows the pointer: dragging right and down turns the camera left and up.
  assert.ok(wrapDelta(dragged.yaw - start.yaw) < 0);
  assert.ok(dragged.pitch > start.pitch);
  assert.equal(browser.pendingFrames(), 1);
  browser.frame();
  assert.equal(browser.pendingFrames(), 0, "a drag released at rest does not glide");
  // The pointer readout names what is under the pointer.
  assert.match(viewer.el.find("pv-readout-pointer").textContent, /^pointer \d+\.\d° [+-]\d+\.\d°$/);

  const under = unproject(600, 100, viewer.getCamera());
  const wheel = stage.emit("wheel", { clientX: 600, clientY: 100, deltaY: -120, deltaMode: 0, timeStamp: 5000, prevented: false, preventDefault() { this.prevented = true; } });
  assert.equal(wheel.prevented, true);
  const zoomed = viewer.getCamera();
  assert.ok(zoomed.fov < dragged.fov);
  const still = project(under.yaw, under.pitch, zoomed);
  near(still.x, 600, 1e-6);
  near(still.y, 100, 1e-6);

  stage.emit("dblclick", { timeStamp: 9000 });
  for (let i = 0; i < 10; i += 1) browser.frame(100);
  const reset = viewer.getCamera();
  near(reset.yaw, 180, 1e-9);
  near(reset.pitch, 0, 1e-9);
  near(reset.fov, 100, 1e-9);
  viewer.destroy();
});

test("viewer: a quick flick glides briefly and stops", async () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES.slice(0, 1) });
  const stage = viewer.el.find("pv-stage");
  const pointer = (x, timeStamp) => ({ pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: 200, timeStamp });
  stage.emit("pointerdown", pointer(400, 0));
  stage.emit("pointermove", pointer(380, 16));
  stage.emit("pointermove", pointer(350, 32));
  stage.emit("pointerup", pointer(350, 40));
  const released = viewer.getCamera().yaw;
  browser.frame();
  browser.frame();
  assert.ok(viewer.getCamera().yaw > released, "keeps turning the way it was dragged");
  let frames = 0;
  while (browser.frame() && frames < 400) frames += 1;
  assert.ok(frames < 120, `settles within two seconds (${frames} frames)`);
  assert.ok(wrapDelta(viewer.getCamera().yaw - released) < 25, "modest: about a fifth of the view at most");
  viewer.destroy();
});

test("viewer: a page scroll that drifts over the viewer is not hijacked", () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: [] });
  const stage = viewer.el.find("pv-stage");
  const before = viewer.getCamera().fov;
  const wheel = (timeStamp) => ({ clientX: 400, clientY: 200, deltaY: 120, deltaMode: 0, timeStamp, target: stage, prevented: false, preventDefault() { this.prevented = true; } });
  browser.doc.emit("wheel", { target: browser.container, timeStamp: 1000 });
  assert.equal(stage.emit("wheel", wheel(1100)).prevented, false);
  assert.equal(stage.emit("wheel", wheel(1400)).prevented, false, "the gesture is still the page's");
  assert.equal(viewer.getCamera().fov, before);
  // A fresh gesture over the viewer zooms.
  assert.equal(stage.emit("wheel", wheel(3000)).prevented, true);
  assert.ok(viewer.getCamera().fov > before);
  viewer.destroy();
});

test("viewer: arrow keys pan when focused and do not leak to the page", () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: [] });
  const stage = viewer.el.find("pv-stage");
  assert.equal(stage.tabIndex, 0);
  const key = (name, extra = {}) => stage.emit("keydown", { key: name, stopped: false, stopPropagation() { this.stopped = true; }, ...extra });
  assert.equal(key("ArrowRight").stopped, true);
  for (let i = 0; i < 6; i += 1) browser.frame(100);
  near(viewer.getCamera().yaw, 180 + 100 / 8, 1e-9);
  key("ArrowUp");
  for (let i = 0; i < 6; i += 1) browser.frame(100);
  near(viewer.getCamera().pitch, 100 / 8, 1e-9);
  key("+");
  for (let i = 0; i < 6; i += 1) browser.frame(100);
  near(viewer.getCamera().fov, 80, 1e-9);
  // Keys that belong to the console's own shortcuts pass through untouched.
  assert.equal(key("f").stopped, false);
  assert.equal(key("ArrowLeft", { ctrlKey: true }).stopped, false);
  viewer.destroy();
});

test("viewer: auto-pan turns slowly and stops on the first interaction", () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: [], autoPan: true });
  browser.frame();
  browser.frame(1000);
  browser.frame(1000);
  const yaw = viewer.getCamera().yaw;
  assert.ok(yaw > 180 && yaw < 181, "the frame gap is capped so a stalled tab does not jump");
  for (let i = 0; i < 50; i += 1) browser.frame(100);
  near(viewer.getCamera().yaw, yaw + 15, 1e-6);
  assert.equal(browser.pendingFrames(), 1, "keeps running while auto-panning");
  viewer.el.find("pv-stage").emit("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 1, clientY: 1 });
  browser.frame();
  browser.frame();
  assert.equal(browser.pendingFrames(), 0);
  viewer.setAutoPan(true);
  assert.equal(browser.pendingFrames(), 1);
  viewer.destroy();
});

test("viewer: crop footprints are drawn, numbered, hovered, highlighted and flashed", () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: [] });
  const hovered = [];
  const clicked = [];
  const off = viewer.onCropHover((n) => hovered.push(n));
  viewer.onCropClick((n) => clicked.push(n));
  viewer.flashCrop(2);
  viewer.setCrops([
    { n: 1, yaw: 170, pitch: 5, fov: 30, width: 1000, height: 500 },
    { n: 2, yaw: 190, pitch: -5, fov: 20, width: 800, height: 800 },
    { n: 3, yaw: 0, pitch: 0, fov: 30, width: 800, height: 800 },
    { n: "x", yaw: 10, pitch: 0, fov: 30 },
    { n: 5, yaw: null, pitch: 0, fov: 30 },
  ]);
  browser.frame();
  const groups = viewer.el.findAll("pv-crop");
  assert.equal(groups.length, 3, "malformed entries are left out");
  const byN = (n) => groups.find((g) => g.attributes["data-crop"] === String(n));
  assert.match(byN(1).find("pv-crop-line").attributes.d, /^M[\d.-]+ [\d.-]+L.*Z$/);
  assert.equal(byN(1).find("pv-crop-label").find("pv-crop-label").children[1].textContent, "1");
  assert.equal(byN(1).find("pv-crop-label").attributes.display, undefined);
  // Crop 3 is behind the camera: no outline, no label.
  assert.equal(byN(3).find("pv-crop-line").attributes.d, "");
  assert.equal(byN(3).find("pv-crop-label").attributes.display, "none");
  assert.ok(byN(2).classList.contains("is-flash"), "a flash requested before the crop arrived is honoured");

  byN(1).emit("pointerenter");
  byN(1).emit("pointerleave");
  assert.deepEqual(hovered, [1, null]);
  viewer.highlightCrop(2);
  assert.ok(byN(2).classList.contains("is-on"));
  assert.ok(viewer.el.find("pv-crops").classList.contains("has-on"));
  viewer.highlightCrop(null);
  assert.ok(!byN(2).classList.contains("is-on"));
  assert.ok(!viewer.el.find("pv-crops").classList.contains("has-on"));

  // Same list again: the nodes are kept. A changed crop is rebuilt, a missing one removed.
  viewer.setCrops([{ n: 1, yaw: 170, pitch: 5, fov: 30, width: 1000, height: 500 }, { n: 2, yaw: 200, pitch: 0, fov: 20 }]);
  const after = viewer.el.findAll("pv-crop");
  assert.equal(after.length, 2);
  assert.equal(after.find((g) => g.attributes["data-crop"] === "1"), byN(1));
  assert.notEqual(after.find((g) => g.attributes["data-crop"] === "2"), byN(2));

  // A click on a number looks at that crop; a following double-click is not a reset.
  const stage = viewer.el.find("pv-stage");
  const label = byN(1).find("pv-crop-label");
  const pointer = (timeStamp) => ({ pointerId: 1, pointerType: "mouse", button: 0, clientX: 300, clientY: 150, timeStamp, target: label });
  stage.emit("pointerdown", pointer(100));
  stage.emit("pointerup", pointer(160));
  stage.emit("dblclick", { timeStamp: 300 });
  for (let i = 0; i < 10; i += 1) browser.frame(100);
  assert.deepEqual(clicked, [1]);
  near(viewer.getCamera().yaw, 170, 1e-9);
  near(viewer.getCamera().fov, 45, 1e-9);

  // The eye button hides the footprints; the listener can be removed.
  const eye = viewer.el.find("pv-controls").children[4];
  assert.equal(eye.hidden, false);
  assert.equal(eye.title, "Hide where the agent looked");
  eye.emit("click");
  assert.equal(viewer.el.find("pv-crops").attributes.display, "none");
  assert.equal(eye.title, "Show where the agent looked");
  off();
  viewer.setCropsVisible(true);
  byN(1).emit("pointerenter");
  assert.deepEqual(hovered, [1, null]);
  viewer.destroy();
});

test("viewer: the ruler and the controls are optional, and every button has a title", () => {
  const browser = fakeBrowser({ images: IMAGES });
  const bare = createPanoViewer(browser.container, { sources: [], ruler: false, controls: false });
  browser.frame();
  assert.equal(bare.el.find("pv-ruler"), null);
  assert.equal(bare.el.find("pv-controls"), null);
  bare.destroy();
  const full = createPanoViewer(browser.container, { sources: [] });
  browser.frame();
  assert.ok(full.el.find("pv-ruler").find("pv-ruler-label"));
  const buttons = full.el.findAll("pv-button");
  assert.equal(buttons.length, 7);
  for (const button of buttons) {
    assert.ok(button.title.length > 3, "has a title");
    assert.equal(button.attributes["aria-label"], button.title);
    assert.equal(button.type, "button");
  }
  // No crops yet: the footprints toggle is not offered.
  assert.equal(full.el.find("pv-controls").children[4].hidden, true);
  full.destroy();
});

test("viewer: destroy releases the context, the listeners and the DOM", async () => {
  const browser = fakeBrowser({ images: IMAGES });
  const viewer = createPanoViewer(browser.container, { sources: SOURCES.slice(0, 1), autoPan: true });
  await browser.settle();
  browser.frame();
  const stage = viewer.el.find("pv-stage");
  assert.ok(stage.listenerCount() > 0);
  viewer.destroy();
  viewer.destroy();
  assert.equal(browser.container.children.length, 0);
  assert.equal(browser.gl.state.released, true, "WEBGL_lose_context was used");
  assert.equal(glCalls(browser, "deleteTexture").length, 1);
  assert.equal(stage.listenerCount(), 0);
  assert.equal(browser.doc.listenerCount(), 0);
  assert.equal(browser.win.listenerCount(), 0);
  assert.equal(browser.pendingFrames(), 0);
  // Late callbacks after teardown are harmless.
  browser.runTimers();
  viewer.lookAt({ yaw: 10 });
  assert.equal(browser.pendingFrames(), 0);
});
