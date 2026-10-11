// 360° panorama viewer (UI-SPEC 5.5): a hand-written WebGL equirectangular viewer with a flat-strip
// mode, a yaw ruler and the footprints of the agent's view_crop calls.
//
// Frame: the panorama's own, shared with astrolabio/pano.py and view_crop. Yaw 0 is the LEFT edge of
// the equirectangular image and grows to the right (yaw 180 is the image centre); pitch is degrees
// above (+) the horizon. World axes used here: +Z looks at yaw 0, +X at yaw 90, +Y is up.
//
// A camera is {mode: "360"|"flat", yaw, pitch, fov, width, height}: width and height are the
// viewport in CSS pixels; fov is the horizontal field of view in 360 mode and the span of yaw
// across the viewport in flat mode.
//
// The first half of this file is pure maths with no DOM access so it can be tested with
// `node --test`; nothing touches window or document until createPanoViewer is called.
//
// Injection rule (contract A30): every value that reaches the DOM is a number formatted here or a
// fixed string. Source URLs are built by the calling screen from API paths, never from model text.

const RAD = Math.PI / 180;

export const MIN_FOV = 15;
export const MAX_FOV = 110;
// A tall, narrow viewport would otherwise get a fish-eye vertical field of view.
const MAX_VERTICAL_FOV = 120;
const MIN_FLAT_FOV = 10;
export const DEFAULT_VIEW = Object.freeze({ yaw: 180, pitch: 0, fov: 100 });

// Outline points closer to the camera plane than this are clipped: their projection runs away to
// infinity and, behind the plane, mirrors through the centre.
const NEAR = 0.02;
// A source this fraction of the ideal width is accepted, so a 2048 px image is not replaced by a
// 4096 px one for a need of 2100 px.
const SOURCE_SLACK = 0.85;

// The agent's overview has a tick every 15° and a label every 45° (astrolabio/pano.py). The viewer
// starts from the same scale and refines it as the operator zooms in; every label the agent sees
// stays a label here.
const RULER_STEPS = [1, 5, 15, 45, 90];
const RULER_MINOR = { 1: 1, 5: 1, 15: 5, 45: 15, 90: 45 };
const RULER_ANCHOR = 45;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const positive = (value) => (value > 0 ? value : 1);

function finite(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Yaw in [0, 360). */
export function wrapYaw(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Signed shortest turn in [-180, 180). */
export function wrapDelta(deg) {
  return wrapYaw(deg + 180) - 180;
}

/** Unit vector looking at (yaw, pitch). */
export function direction(yaw, pitch) {
  const cosPitch = Math.cos(pitch * RAD);
  return [cosPitch * Math.sin(yaw * RAD), Math.sin(pitch * RAD), cosPitch * Math.cos(yaw * RAD)];
}

/** Right, up and forward unit vectors of a camera looking at (yaw, pitch) with no roll. */
export function cameraBasis(yaw, pitch) {
  const sinYaw = Math.sin(yaw * RAD);
  const cosYaw = Math.cos(yaw * RAD);
  const sinPitch = Math.sin(pitch * RAD);
  return {
    right: [cosYaw, 0, -sinYaw],
    up: [-sinPitch * sinYaw, Math.cos(pitch * RAD), -sinPitch * cosYaw],
    forward: direction(yaw, pitch),
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function toCamera(vector, basis) {
  return [dot(vector, basis.right), dot(vector, basis.up), dot(vector, basis.forward)];
}

function anglesOf(vector) {
  return {
    yaw: wrapYaw(Math.atan2(vector[0], vector[2]) / RAD),
    pitch: Math.atan2(vector[1], Math.hypot(vector[0], vector[2])) / RAD,
  };
}

/** Focal length in CSS pixels of a 360-mode camera. */
export function focalPx(camera) {
  return positive(camera.width) / 2 / Math.tan((camera.fov * RAD) / 2);
}

function inViewport(x, y, camera) {
  return x >= 0 && x <= positive(camera.width) && y >= 0 && y <= positive(camera.height);
}

function projectFlat(yaw, pitch, camera) {
  const pxPerDeg = positive(camera.width) / camera.fov;
  const x = positive(camera.width) / 2 + wrapDelta(yaw - camera.yaw) * pxPerDeg;
  const y = positive(camera.height) / 2 - (pitch - camera.pitch) * pxPerDeg;
  return { x, y, front: true, visible: inViewport(x, y, camera) };
}

/**
 * Viewport position (CSS pixels, origin top left) of the direction (yaw, pitch).
 * `front` is false for a point behind the camera (x and y are then NaN); `visible` also requires
 * the point to fall inside the viewport. In flat mode the copy nearest the centre is returned.
 */
export function project(yaw, pitch, camera) {
  if (camera.mode === "flat") return projectFlat(yaw, pitch, camera);
  const point = toCamera(direction(yaw, pitch), cameraBasis(camera.yaw, camera.pitch));
  if (point[2] <= 1e-6) return { x: NaN, y: NaN, front: false, visible: false };
  const focal = focalPx(camera);
  const x = positive(camera.width) / 2 + (focal * point[0]) / point[2];
  const y = positive(camera.height) / 2 - (focal * point[1]) / point[2];
  return { x, y, front: true, visible: inViewport(x, y, camera) };
}

/** The direction under a viewport position: the inverse of project(). */
export function unproject(x, y, camera) {
  const dx = x - positive(camera.width) / 2;
  const dy = positive(camera.height) / 2 - y;
  if (camera.mode === "flat") {
    const degPerPx = camera.fov / positive(camera.width);
    return { yaw: wrapYaw(camera.yaw + dx * degPerPx), pitch: clamp(camera.pitch + dy * degPerPx, -90, 90) };
  }
  const focal = focalPx(camera);
  const { right, up, forward } = cameraBasis(camera.yaw, camera.pitch);
  const ray = [0, 1, 2].map((i) => (dx / focal) * right[i] + (dy / focal) * up[i] + forward[i]);
  return anglesOf(ray);
}

/**
 * The camera yaw and pitch that put the direction `target` ({yaw, pitch}) at viewport position
 * (x, y), keeping the camera's fov: what zooming about the pointer needs.
 */
export function aimAt(target, x, y, camera) {
  const dx = x - positive(camera.width) / 2;
  const dy = positive(camera.height) / 2 - y;
  if (camera.mode === "flat") {
    const degPerPx = camera.fov / positive(camera.width);
    return { yaw: wrapYaw(target.yaw - dx * degPerPx), pitch: target.pitch - dy * degPerPx };
  }
  const focal = focalPx(camera);
  const nx = dx / focal;
  const ny = dy / focal;
  // The ray through (x, y) has height (ny * cos(pitch) + sin(pitch)) / |ray|, which must equal
  // sin(target pitch): solve for the camera pitch, then turn the camera until the yaw agrees.
  const height = Math.sin(target.pitch * RAD) * Math.hypot(nx, ny, 1);
  const reach = Math.hypot(1, ny);
  // Out of reach without tipping the camera over (a high target at the bottom edge): stop at the pole.
  const pitch = clamp(Math.asin(clamp(height / reach, -1, 1)) - Math.atan2(ny, 1), -Math.PI / 2, Math.PI / 2);
  const forward = Math.cos(pitch) - ny * Math.sin(pitch);
  return { yaw: wrapYaw(target.yaw - Math.atan2(nx, forward) / RAD), pitch: pitch / RAD };
}

/** Vertical field of view of a rectilinear crop whose `fov` is horizontal (amendment A9). */
export function verticalFov(crop) {
  const aspect = positive(finite(crop.height, 1)) / positive(finite(crop.width, 1));
  return (2 * Math.atan(Math.tan((crop.fov * RAD) / 2) * aspect)) / RAD;
}

/**
 * Border of a rectilinear view_crop on the sphere as [{yaw, pitch}], clockwise from the top-left
 * corner, `steps` points per edge (4 * steps in all; the corners are at multiples of `steps`).
 * A crop without width and height is square, which is view_crop's default aspect.
 */
export function cropOutline(crop, steps = 16) {
  const perEdge = Math.max(1, Math.floor(steps));
  const tanX = Math.tan((clamp(crop.fov, 0.1, 179) * RAD) / 2);
  const tanY = Math.tan((verticalFov({ ...crop, fov: clamp(crop.fov, 0.1, 179) }) * RAD) / 2);
  const { right, up, forward } = cameraBasis(crop.yaw, finite(crop.pitch, 0));
  const corners = [[-tanX, tanY], [tanX, tanY], [tanX, -tanY], [-tanX, -tanY]];
  const outline = [];
  corners.forEach((from, edge) => {
    const to = corners[(edge + 1) % 4];
    for (let i = 0; i < perEdge; i += 1) {
      const t = i / perEdge;
      const x = from[0] + (to[0] - from[0]) * t;
      const y = from[1] + (to[1] - from[1]) * t;
      outline.push(anglesOf([0, 1, 2].map((k) => x * right[k] + y * up[k] + forward[k])));
    }
  });
  return outline;
}

/**
 * The outline with yaw made continuous (no jump at the 0/360 seam). `winding` is the number of
 * whole turns the outline makes around the vertical axis: non-zero means it encloses a pole
 * (`pole` is then +90 or -90) and is not a closed loop on the flat strip.
 */
export function unwrapOutline(points) {
  const out = [];
  let yaw = 0;
  let pitchSum = 0;
  points.forEach((point, i) => {
    yaw = i === 0 ? wrapYaw(point.yaw) : yaw + wrapDelta(point.yaw - points[i - 1].yaw);
    pitchSum += point.pitch;
    out.push({ yaw, pitch: point.pitch });
  });
  if (!out.length) return { points: out, winding: 0, pole: 0 };
  const closing = wrapDelta(points[0].yaw - points[points.length - 1].yaw);
  const winding = Math.round((yaw + closing - out[0].yaw) / 360);
  return { points: out, winding, pole: winding === 0 ? 0 : pitchSum >= 0 ? 90 : -90 };
}

// Sutherland-Hodgman against the plane z = NEAR, in camera space.
function clipNear(points) {
  const out = [];
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    const aIn = a[2] >= NEAR;
    if (aIn) out.push(a);
    if (aIn !== b[2] >= NEAR) {
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
    }
  });
  return out;
}

function offViewport(points, camera) {
  const width = positive(camera.width);
  const height = positive(camera.height);
  return (
    points.every((p) => p.x < 0) || points.every((p) => p.x > width) ||
    points.every((p) => p.y < 0) || points.every((p) => p.y > height)
  );
}

// The edges of a rectilinear crop are great-circle arcs, which a rectilinear camera draws as
// straight lines, so projecting the samples is exact once the part behind the camera is cut off.
function spherePolygons(directions, camera, basis) {
  const clipped = clipNear(directions.map((d) => toCamera(d, basis)));
  if (clipped.length < 3) return [];
  const focal = focalPx(camera);
  const cx = positive(camera.width) / 2;
  const cy = positive(camera.height) / 2;
  const polygon = clipped.map((p) => ({ x: cx + (focal * p[0]) / p[2], y: cy - (focal * p[1]) / p[2] }));
  return offViewport(polygon, camera) ? [] : [polygon];
}

// An outline around a pole runs once round the strip instead of closing. Repeat it until it covers
// the viewport and close it beyond the pole edge, so the closing sides fall outside the view.
function capPolygon(unwrapped, camera, toPx) {
  const turn = unwrapped.winding > 0 ? 1 : -1;
  const first = unwrapped.points[0];
  const start = turn > 0 ? first.yaw : first.yaw - 360;
  const left = camera.yaw - camera.fov / 2;
  const right = camera.yaw + camera.fov / 2;
  const copies = [];
  for (let k = Math.floor((left - start) / 360); k <= Math.floor((right - start) / 360); k += 1) copies.push(k);
  if (turn < 0) copies.reverse();
  const polygon = [];
  for (const k of copies) {
    for (const point of unwrapped.points) polygon.push(toPx(point.yaw + 360 * k, point.pitch));
  }
  const endYaw = first.yaw + 360 * copies[copies.length - 1] + 360 * turn;
  const beyond = unwrapped.pole > 0 ? 100 : -100;
  polygon.push(toPx(endYaw, first.pitch), toPx(endYaw, beyond), toPx(first.yaw + 360 * copies[0], beyond));
  return polygon;
}

function flatPolygons(unwrapped, camera) {
  if (unwrapped.points.length < 3) return [];
  const pxPerDeg = positive(camera.width) / camera.fov;
  const cx = positive(camera.width) / 2;
  const cy = positive(camera.height) / 2;
  const toPx = (yaw, pitch) => ({ x: cx + (yaw - camera.yaw) * pxPerDeg, y: cy - (pitch - camera.pitch) * pxPerDeg });
  if (unwrapped.winding !== 0) return [capPolygon(unwrapped, camera, toPx)];
  const yaws = unwrapped.points.map((p) => p.yaw);
  const first = Math.ceil((camera.yaw - camera.fov / 2 - Math.max(...yaws)) / 360);
  const last = Math.floor((camera.yaw + camera.fov / 2 - Math.min(...yaws)) / 360);
  const polygons = [];
  // One copy per repetition of the strip that is in view: an outline across the seam shows at both ends.
  for (let k = first; k <= last; k += 1) polygons.push(unwrapped.points.map((p) => toPx(p.yaw + 360 * k, p.pitch)));
  return polygons;
}

/**
 * Closed polygons ([[{x, y}]], CSS pixels) that draw an outline from cropOutline() through a
 * camera. Empty when nothing of it is in front of a 360 camera; several in flat mode when the
 * strip repeats or the outline straddles the seam.
 */
export function outlinePolygons(outline, camera) {
  if (camera.mode === "flat") return flatPolygons(unwrapOutline(outline), camera);
  const directions = outline.map((p) => direction(p.yaw, p.pitch));
  return spherePolygons(directions, camera, cameraBasis(camera.yaw, camera.pitch));
}

/** Allowed fov range for a viewport: {min, max}. In flat mode max shows the whole strip. */
export function fovLimits(mode, width, height) {
  const aspect = positive(width) / positive(height);
  if (mode === "flat") {
    const whole = 180 * aspect;
    return { min: Math.min(MIN_FLAT_FOV, whole), max: whole };
  }
  const byHeight = (2 * Math.atan(Math.tan((MAX_VERTICAL_FOV * RAD) / 2) * aspect)) / RAD;
  return { min: MIN_FOV, max: Math.max(MIN_FOV, Math.min(MAX_FOV, byHeight)) };
}

/** A camera with yaw wrapped and pitch and fov inside what the viewport allows. */
export function clampCamera(camera) {
  const mode = camera.mode === "flat" ? "flat" : "360";
  const width = positive(camera.width);
  const height = positive(camera.height);
  const limits = fovLimits(mode, width, height);
  const fov = clamp(finite(camera.fov, limits.max), limits.min, limits.max);
  // The flat strip may not scroll past its top or bottom edge.
  const reach = mode === "flat" ? Math.max(0, 90 - (fov * height) / width / 2) : 90;
  return {
    mode,
    yaw: wrapYaw(finite(camera.yaw, 0)),
    pitch: clamp(finite(camera.pitch, 0), -reach, reach),
    fov,
    width,
    height,
  };
}

/**
 * Ticks of the yaw ruler: [{x, yaw, label, anchor}], x in CSS pixels. In 360 mode a tick sits
 * where its meridian crosses the centre row of the view, the same reading view_crop reports
 * ("the centre row spans yaw A to B"). `label` marks ticks that carry a number, `anchor` the 45°
 * ticks of the agent's own ruler.
 */
export function rulerTicks(camera, minLabelPx = 56) {
  const flat = camera.mode === "flat";
  const width = positive(camera.width);
  // Pixels per degree (flat) or per unit of tan (360) along the centre row.
  const scale = flat ? width / camera.fov : focalPx(camera) * Math.cos(camera.pitch * RAD);
  const pxPerDeg = flat ? scale : scale * RAD;
  const step = RULER_STEPS.find((candidate) => candidate * pxPerDeg >= minLabelPx) || 90;
  const minor = RULER_MINOR[step];
  // Looking straight up or down every meridian meets at the centre: no scale to draw.
  if (minor * pxPerDeg < 3) return [];
  const half = flat ? camera.fov / 2 : Math.min(89, Math.atan2(width / 2, scale) / RAD);
  const ticks = [];
  const last = Math.floor((camera.yaw + half) / minor);
  for (let i = Math.ceil((camera.yaw - half) / minor); i <= last; i += 1) {
    const delta = i * minor - camera.yaw;
    const yaw = wrapYaw(i * minor);
    const x = width / 2 + (flat ? delta * scale : Math.tan(delta * RAD) * scale);
    ticks.push({ x, yaw, label: yaw % step === 0, anchor: yaw % RULER_ANCHOR === 0 });
  }
  return ticks;
}

/** Width in pixels the equirectangular image needs so the centre of the view is not upscaled. */
export function neededWidth(camera, pixelRatio = 1) {
  const cssWidth = camera.mode === "flat" ? (360 * positive(camera.width)) / camera.fov : 2 * Math.PI * focalPx(camera);
  return cssWidth * pixelRatio;
}

/**
 * Index of the source to show for a needed width: the smallest one that is wide enough, else the
 * widest. Widths count up to `maxSize` (gl.MAX_TEXTURE_SIZE); indices in `failed` (a Set or Map)
 * are skipped.
 * Returns -1 when nothing is left.
 */
export function pickSource(sources, needed, { maxSize = Infinity, failed = null } = {}) {
  const usable = (index) => Math.min(sources[index].width, maxSize);
  let enough = -1;
  let widest = -1;
  sources.forEach((_, index) => {
    if (failed && failed.has(index)) return;
    const width = usable(index);
    if (widest < 0 || width > usable(widest)) widest = index;
    if (width >= needed * SOURCE_SLACK && (enough < 0 || width < usable(enough))) enough = index;
  });
  return enough >= 0 ? enough : widest;
}

/** "135.0°": yaw as the agent writes it, never "360.0". */
export function formatYaw(deg) {
  return ((Math.round(wrapYaw(deg) * 10) / 10) % 360).toFixed(1) + "°";
}

/** "+2.0°" / "-12.5°": pitch with an explicit sign, as in the agent's view labels. */
export function formatPitch(deg) {
  const rounded = Math.round(deg * 10) / 10;
  return (rounded < 0 ? "-" : "+") + Math.abs(rounded).toFixed(1) + "°";
}

// ---------------------------------------------------------------------------------------------
// Everything below needs a browser.
// ---------------------------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_PIXEL_RATIO = 3;
const MAX_CANVAS_SIDE = 4096;
const CROP_STEPS = 24;
const AUTO_PAN_DEG_PER_S = 3;
const TWEEN_MS = 600;
const NUDGE_MS = 160;
const FLASH_MS = 1600;
const DETAIL_DELAY_MS = 200;
// A failed image is tried again after this long, the next time the view changes: a dropped
// connection at the venue must not pin a viewer to its preview (or to "unavailable") for good.
const RETRY_AFTER_MS = 20000;
const CLICK_SLOP_PX = 4;
// Inertia is kept modest: the hardest flick coasts about a fifth of the view and is over in half
// a second; it never spins the scene.
const GLIDE_TIME_S = 0.18;
const GLIDE_STOP_DEG_PER_S = 2;
const GLIDE_MAX_VIEWS_PER_S = 1.2;
const WHEEL_CHAIN_MS = 400;
const RULER_BAND_EM = 1.9;
const RULER_LABEL_EM = 4;
const TICK_EM = { minor: 0.35, major: 0.6, anchor: 0.85 };
const STAGE_LABEL =
  "Panorama viewer. Drag or use the arrow keys to look around, scroll or press plus and minus to zoom, " +
  "double-click or press Home to reset.";
const NOTES = { loading: "Loading panorama…", unavailable: "Image unavailable", empty: "No image" };

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_ndc;
void main() {
  v_ndc = a_pos;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// highp matters: at fov 15 on a 6000 px texture mediump cannot tell neighbouring texels apart.
// The texture has no mipmaps, so the jump of u from 1 to 0 at the seam cannot pick a blurred level
// and draw a line; fract() plus REPEAT (or CLAMP for odd sizes on WebGL 1) keeps the lookup valid.
const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_tex;
uniform mat3 u_basis;
uniform vec2 u_tan;
uniform vec4 u_strip;
uniform float u_flat;
varying vec2 v_ndc;
const float INV_TAU = 0.15915494309189535;
const float INV_PI = 0.3183098861837907;
void main() {
  vec2 uv;
  if (u_flat > 0.5) {
    uv = u_strip.xy + vec2(v_ndc.x, -v_ndc.y) * u_strip.zw;
  } else {
    vec3 ray = u_basis * vec3(v_ndc * u_tan, 1.0);
    uv = vec2(atan(ray.x, ray.z) * INV_TAU, 0.5 - atan(ray.y, length(ray.xz)) * INV_PI);
  }
  gl_FragColor = vec4(texture2D(u_tex, vec2(fract(uv.x), clamp(uv.y, 0.0, 1.0))).rgb, 1.0);
}`;

// Authored here (static), so the module needs no import: 16 x 16, stroked with currentColor.
const ICONS = {
  plus: [["path", { d: "M8 3v10M3 8h10" }]],
  minus: [["path", { d: "M3 8h10" }]],
  reset: [["circle", { cx: 8, cy: 8, r: 4.5 }], ["path", { d: "M8 1v3M8 12v3M1 8h3M12 8h3" }]],
  eye: [["path", { d: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" }], ["circle", { cx: 8, cy: 8, r: 2 }]],
  "eye-off": [
    ["path", { d: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" }],
    ["path", { d: "M2.5 2.5l11 11" }],
  ],
  expand: [["path", { d: "M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" }]],
  collapse: [["path", { d: "M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" }]],
  alert: [["path", { d: "M8 2l6.5 11.5h-13zM8 6.5V10M8 11.8v.4" }]],
};

function html(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function svg(doc, tag, attrs = {}) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

function iconNode(doc, name) {
  const node = svg(doc, "svg", { class: "pv-icon", viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" });
  for (const [tag, attrs] of ICONS[name]) node.append(svg(doc, tag, attrs));
  return node;
}

function pathData(polygons) {
  let d = "";
  for (const polygon of polygons) {
    polygon.forEach((point, i) => {
      d += (i ? "L" : "M") + point.x.toFixed(1) + " " + point.y.toFixed(1);
    });
    d += "Z";
  }
  return d;
}

const isPowerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0;
const imageWidth = (image) => image.naturalWidth || image.width;
const imageHeight = (image) => image.naturalHeight || image.height;
// A failed fullscreen request or exit (no user gesture, already left) needs no handling.
const quiet = (result) => Promise.resolve(result).catch(() => {});

// An image wider than the texture limit is scaled down once rather than refused.
function fitImage(doc, image, maxSize) {
  const width = imageWidth(image);
  const height = imageHeight(image);
  if (Math.max(width, height) <= maxSize) return image;
  const scale = maxSize / Math.max(width, height);
  const canvas = doc.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function buildProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

function openGl(canvas) {
  const attrs = { alpha: false, antialias: false, depth: false, stencil: false };
  for (const name of ["webgl2", "webgl", "experimental-webgl"]) {
    try {
      const gl = canvas.getContext(name, attrs);
      if (gl) return { gl, webgl2: name === "webgl2" };
    } catch {
      // Some browsers throw instead of returning null for a blocked context: try the next name.
    }
  }
  return null;
}

/** Draws either projection from one equirectangular texture. Null when WebGL is unavailable. */
function createGlRenderer(canvas) {
  const opened = openGl(canvas);
  if (!opened) return null;
  const { gl, webgl2 } = opened;
  let program = null;
  let buffer = null;
  let uniform = null;

  // Also run after a restored context, which has lost every object.
  function setup() {
    program = buildProgram(gl);
    if (!program) return false;
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    uniform = {};
    for (const name of ["u_tex", "u_basis", "u_tan", "u_strip", "u_flat"]) uniform[name] = gl.getUniformLocation(program, name);
    gl.uniform1i(uniform.u_tex, 0);
    return true;
  }

  function upload(image) {
    if (gl.isContextLost()) return null;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    } catch {
      gl.deleteTexture(texture);
      return null;
    }
    // WebGL 1 allows REPEAT only for power-of-two sizes; clamping costs half a texel of blend at the seam.
    const repeat = webgl2 || (isPowerOfTwo(imageWidth(image)) && isPowerOfTwo(imageHeight(image)));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return { texture };
  }

  function setSphere(camera) {
    const { right, up, forward } = cameraBasis(camera.yaw, camera.pitch);
    const tanX = Math.tan((camera.fov * RAD) / 2);
    gl.uniform1f(uniform.u_flat, 0);
    gl.uniformMatrix3fv(uniform.u_basis, false, new Float32Array([...right, ...up, ...forward]));
    gl.uniform2f(uniform.u_tan, tanX, (tanX * camera.height) / camera.width);
  }

  function setStrip(camera) {
    const halfV = (camera.fov * camera.height) / camera.width / 360;
    gl.uniform1f(uniform.u_flat, 1);
    gl.uniform4f(uniform.u_strip, camera.yaw / 360, 0.5 - camera.pitch / 180, camera.fov / 720, halfV);
  }

  function draw(camera, handle) {
    if (gl.isContextLost()) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (!handle) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, handle.texture);
    if (camera.mode === "flat") setStrip(camera);
    else setSphere(camera);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function destroy() {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    // Browsers cap live contexts per page; give this one back now instead of at garbage collection.
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
  }

  if (!setup()) return null;
  return {
    kind: "gl",
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048,
    upload,
    release: (handle) => gl.deleteTexture(handle.texture),
    draw,
    restore: setup,
    destroy,
  };
}

/** The flat strip on a 2D canvas: used when WebGL is missing or its context is lost. */
function createCanvasRenderer(canvas) {
  const context = canvas.getContext("2d");

  function draw(camera, handle) {
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!handle) return;
    const pxPerDeg = canvas.width / camera.fov;
    // Whole pixels, and one of overlap, so no hairline shows between repetitions of the strip.
    const stripWidth = Math.round(360 * pxPerDeg);
    const top = Math.round(canvas.height / 2 - (90 - camera.pitch) * pxPerDeg);
    let x = Math.round(canvas.width / 2 - camera.yaw * pxPerDeg);
    x -= Math.ceil(x / stripWidth) * stripWidth;
    for (; x < canvas.width; x += stripWidth) {
      context.drawImage(handle.image, x, top, stripWidth + 1, Math.round(180 * pxPerDeg));
    }
  }

  return { kind: "2d", maxTextureSize: 8192, upload: (image) => ({ image }), release() {}, draw, destroy() {} };
}

function normaliseSources(list) {
  return (list || [])
    .filter((source) => source && typeof source.url === "string" && source.url && finite(source.width, 0) > 0)
    .map((source) => ({ width: Number(source.width), url: source.url }))
    .sort((a, b) => a.width - b.width);
}

/**
 * Progressive image loading: the smallest source first, then at most one sharper "detail" layer
 * for the current zoom. Memory stays bounded at two images per viewer however far the operator
 * zooms, and a source that fails to load is skipped for a while and what is on screen stays.
 * hooks: upload(image) -> handle, release(handle), maxSize(), changed(), status(kind|null).
 */
function createLoader(doc, hooks) {
  let sources = [];
  const failed = new Map();
  let base = null;
  let detail = null;
  let pending = null;
  let started = false;

  const drop = (layer) => {
    if (layer && layer.handle) hooks.release(layer.handle);
  };

  function cancel() {
    if (!pending) return;
    const { image } = pending;
    pending = null;
    image.src = "";
  }

  function accept(index, role, image) {
    const fitted = fitImage(doc, image, hooks.maxSize());
    const layer = { index, image: fitted, width: imageWidth(fitted), handle: hooks.upload(fitted) };
    if (role === "base") {
      base = layer;
    } else {
      drop(detail);
      detail = layer;
    }
    hooks.status(null);
    hooks.changed();
  }

  function reject(index, role) {
    failed.set(index, Date.now());
    // A missing detail keeps what is shown; the next evaluation picks another source.
    if (role === "base") loadBase();
    else hooks.changed();
  }

  function load(index, role) {
    const image = doc.createElement("img");
    image.decoding = "async";
    pending = { image };
    const settle = (ok) => {
      if (!pending || pending.image !== image) return;
      pending = null;
      if (ok) accept(index, role, image);
      else reject(index, role);
    };
    image.src = sources[index].url;
    // decode() finishes off the main thread, so the upload does not stall a drag in progress.
    const ready = typeof image.decode === "function"
      ? image.decode()
      : new Promise((resolve, fail) => { image.onload = resolve; image.onerror = fail; });
    ready.then(() => settle(true), () => settle(false));
  }

  function loadBase() {
    const index = sources.findIndex((_, i) => !failed.has(i));
    if (index < 0) {
      hooks.status(sources.length ? "unavailable" : "empty");
      return;
    }
    hooks.status("loading");
    load(index, "base");
  }

  function reset(list) {
    cancel();
    drop(base);
    drop(detail);
    base = null;
    detail = null;
    failed.clear();
    sources = normaliseSources(list);
    if (started) loadBase();
  }

  function start() {
    if (started) return;
    started = true;
    loadBase();
  }

  function forgetOldFailures() {
    for (const [index, at] of failed) {
      if (Date.now() - at > RETRY_AFTER_MS) failed.delete(index);
    }
  }

  /** Fetch a sharper (or, after zooming back out, a smaller) detail layer when the view needs one. */
  function want(needed) {
    if (pending || !started) return;
    forgetOldFailures();
    if (!base) {
      if (sources.some((_, i) => !failed.has(i))) loadBase();
      return;
    }
    const index = pickSource(sources, needed, { maxSize: hooks.maxSize(), failed });
    if (index < 0 || index === base.index || (detail && index === detail.index)) return;
    load(index, "detail");
  }

  /** The loaded layer to draw: the smallest that is sharp enough, so nothing is heavily minified. */
  function pick(needed) {
    const layers = [base, detail].filter(Boolean).sort((a, b) => a.width - b.width);
    return layers.find((layer) => layer.width >= needed * SOURCE_SLACK) || layers[layers.length - 1] || null;
  }

  function reupload() {
    for (const layer of [base, detail]) {
      if (layer) layer.handle = hooks.upload(layer.image);
    }
  }

  function destroy() {
    cancel();
    drop(base);
    drop(detail);
    base = null;
    detail = null;
  }

  return { reset, start, want, pick, reupload, destroy };
}

function normaliseCrop(raw) {
  const crop = {
    n: finite(raw && raw.n, null),
    yaw: finite(raw && raw.yaw, null),
    pitch: finite(raw && raw.pitch, 0),
    fov: finite(raw && raw.fov, null),
    width: positive(finite(raw && raw.width, 1)),
    height: positive(finite(raw && raw.height, 1)),
  };
  if (crop.n === null || crop.yaw === null || crop.fov === null || crop.fov <= 0) return null;
  crop.key = [crop.yaw, crop.pitch, crop.fov, crop.width, crop.height].join(",");
  return crop;
}

/**
 * "Where the agent looked": one numbered outline per view_crop on the SVG overlay.
 * hooks: hover(n|null) when the pointer enters or leaves a footprint.
 */
function buildCropLayer(doc, hooks) {
  const node = svg(doc, "g", { class: "pv-crops" });
  const win = doc.defaultView;
  const entries = new Map();
  let highlighted = null;
  let hovered = null;
  let pendingFlash = null;
  let visible = true;

  function setHovered(n) {
    if (hovered === n) return;
    hovered = n;
    applyHighlight();
    hooks.hover(n);
  }

  function createEntry(crop) {
    const outline = cropOutline(crop, CROP_STEPS);
    const group = svg(doc, "g", { class: "pv-crop", "data-crop": crop.n });
    const title = svg(doc, "title");
    title.textContent =
      `Crop ${crop.n}: yaw ${formatYaw(crop.yaw)}, pitch ${formatPitch(crop.pitch)}, fov ${Math.round(crop.fov)}°`;
    const paths = ["pv-crop-hit", "pv-crop-halo", "pv-crop-line"].map((name) => svg(doc, "path", { class: name }));
    const label = svg(doc, "g", { class: "pv-crop-label", "data-crop-label": crop.n });
    const text = svg(doc, "text", { "text-anchor": "middle", dy: "0.35em" });
    text.textContent = String(crop.n);
    label.append(svg(doc, "circle", { r: "0.95em" }), text);
    group.append(title, ...paths, label);
    group.addEventListener("pointerenter", () => setHovered(crop.n));
    group.addEventListener("pointerleave", () => setHovered(null));
    return {
      crop,
      node: group,
      paths,
      label,
      d: null,
      timer: 0,
      directions: outline.map((p) => direction(p.yaw, p.pitch)),
      unwrapped: unwrapOutline(outline),
      // The label sits on a corner: nested zooms on one spot share a centre but not their corners.
      corners: [0, 1, 2, 3].map((i) => outline[i * CROP_STEPS]),
    };
  }

  function removeEntry(n) {
    const entry = entries.get(n);
    win.clearTimeout(entry.timer);
    entry.node.remove();
    entries.delete(n);
    if (hovered === n) setHovered(null);
  }

  function set(list) {
    const seen = new Set();
    for (const raw of list || []) {
      const crop = normaliseCrop(raw);
      if (!crop) continue;
      seen.add(crop.n);
      const old = entries.get(crop.n);
      // The dashboard calls this on every state update: unchanged footprints keep their nodes.
      if (old && old.crop.key === crop.key) continue;
      if (old) removeEntry(crop.n);
      const entry = createEntry(crop);
      entries.set(crop.n, entry);
      node.append(entry.node);
    }
    for (const n of [...entries.keys()]) {
      if (!seen.has(n)) removeEntry(n);
    }
    applyHighlight();
    if (pendingFlash !== null && entries.has(pendingFlash)) flash(pendingFlash);
  }

  function applyHighlight() {
    const active = hovered !== null ? hovered : highlighted;
    for (const [n, entry] of entries) entry.node.classList.toggle("is-on", n === active);
    node.classList.toggle("has-on", active !== null && entries.has(active));
  }

  // Re-inserting the node under the pointer would fire leave and enter again, so a hovered crop stays put.
  function raise(entry) {
    if (entry.crop.n !== hovered) node.append(entry.node);
  }

  function highlight(n) {
    highlighted = finite(n, null);
    const entry = entries.get(highlighted);
    if (entry) raise(entry);
    applyHighlight();
  }

  function flash(n) {
    const entry = entries.get(finite(n, null));
    // The stage view may flash a crop before its state update has delivered it.
    pendingFlash = entry ? null : finite(n, null);
    if (!entry) return;
    raise(entry);
    win.clearTimeout(entry.timer);
    entry.node.classList.remove("is-flash");
    // Reading layout between the two class changes restarts the CSS animation.
    if (typeof entry.node.getBoundingClientRect === "function") entry.node.getBoundingClientRect();
    entry.node.classList.add("is-flash");
    entry.timer = win.setTimeout(() => entry.node.classList.remove("is-flash"), FLASH_MS);
  }

  // A corner when one is in view; zoomed inside a large crop, any point of its border that is.
  function labelSpot(entry, camera, polygons, em) {
    const corner = entry.corners.map((c) => project(c.yaw, c.pitch, camera)).find((p) => p.visible);
    if (corner) return corner;
    const inside = (p) => p.x > em && p.x < camera.width - em && p.y > em && p.y < camera.height - em;
    for (const polygon of polygons) {
      const point = polygon.find(inside);
      if (point) return point;
    }
    return null;
  }

  function placeLabel(entry, camera, polygons, em) {
    const spot = labelSpot(entry, camera, polygons, em);
    if (!spot) {
      entry.label.setAttribute("display", "none");
      return;
    }
    entry.label.removeAttribute("display");
    entry.label.setAttribute("transform", `translate(${spot.x.toFixed(1)} ${spot.y.toFixed(1)})`);
  }

  function draw(camera, em) {
    if (!visible || !entries.size) return;
    const basis = camera.mode === "flat" ? null : cameraBasis(camera.yaw, camera.pitch);
    for (const entry of entries.values()) {
      const polygons = basis ? spherePolygons(entry.directions, camera, basis) : flatPolygons(entry.unwrapped, camera);
      const d = pathData(polygons);
      if (d !== entry.d) {
        entry.d = d;
        for (const path of entry.paths) path.setAttribute("d", d);
      }
      placeLabel(entry, camera, polygons, em);
    }
  }

  function setVisible(next) {
    visible = Boolean(next);
    if (visible) node.removeAttribute("display");
    else node.setAttribute("display", "none");
    if (!visible) setHovered(null);
  }

  function destroy() {
    for (const entry of entries.values()) win.clearTimeout(entry.timer);
  }

  return {
    node,
    set,
    draw,
    highlight,
    flash,
    setVisible,
    destroy,
    get: (n) => (entries.has(n) ? entries.get(n).crop : null),
    count: () => entries.size,
    isVisible: () => visible,
  };
}

function buildRuler(doc) {
  const node = svg(doc, "g", { class: "pv-ruler" });
  const band = svg(doc, "rect", { class: "pv-ruler-band", x: 0, y: 0 });
  const paths = {
    minor: svg(doc, "path", { class: "pv-tick" }),
    major: svg(doc, "path", { class: "pv-tick pv-tick-major" }),
    anchor: svg(doc, "path", { class: "pv-tick pv-tick-anchor" }),
  };
  const labels = svg(doc, "g", { class: "pv-ruler-labels" });
  const marker = svg(doc, "path", { class: "pv-ruler-marker" });
  const pool = [];
  node.append(band, paths.minor, paths.major, paths.anchor, labels, marker);

  function label(index) {
    if (!pool[index]) {
      pool[index] = svg(doc, "text", { "text-anchor": "middle" });
      labels.append(pool[index]);
    }
    return pool[index];
  }

  function draw(camera, em) {
    const height = RULER_BAND_EM * em;
    const d = { minor: "", major: "", anchor: "" };
    let used = 0;
    for (const tick of rulerTicks(camera, RULER_LABEL_EM * em)) {
      const kind = tick.anchor ? "anchor" : tick.label ? "major" : "minor";
      d[kind] += `M${tick.x.toFixed(1)} 0v${(TICK_EM[kind] * em).toFixed(1)}`;
      // A number cut in half by the edge reads as a different number: leave it out.
      if (!tick.label || tick.x < em || tick.x > camera.width - em) continue;
      const text = label(used);
      used += 1;
      text.textContent = String(tick.yaw);
      text.setAttribute("x", tick.x.toFixed(1));
      text.setAttribute("y", (1.55 * em).toFixed(1));
      text.setAttribute("class", tick.anchor ? "pv-ruler-label is-anchor" : "pv-ruler-label");
      text.removeAttribute("display");
    }
    for (let i = used; i < pool.length; i += 1) pool[i].setAttribute("display", "none");
    for (const kind of Object.keys(paths)) paths[kind].setAttribute("d", d[kind]);
    band.setAttribute("width", String(camera.width));
    band.setAttribute("height", height.toFixed(1));
    // The notch marks the centre of the view, the yaw shown in the readout. It hangs under the
    // band so it never covers a number.
    const apex = `M${(camera.width / 2).toFixed(1)} ${height.toFixed(1)}`;
    marker.setAttribute("d", `${apex}l${(0.45 * em).toFixed(1)} ${(0.6 * em).toFixed(1)}h${(-0.9 * em).toFixed(1)}z`);
  }

  return { node, draw };
}

function buildReadout(doc) {
  const node = html(doc, "div", "pv-readout");
  const pointer = html(doc, "span", "pv-readout-pointer");

  function field(name) {
    const wrap = html(doc, "span", "pv-field pv-field-" + name);
    const value = html(doc, "span", "pv-val");
    wrap.append(html(doc, "span", "pv-key", name), value);
    node.append(wrap);
    return value;
  }

  const yaw = field("yaw");
  const pitch = field("pitch");
  const fov = field("fov");
  node.append(pointer);
  pointer.hidden = true;

  function update(camera, hover) {
    yaw.textContent = formatYaw(camera.yaw);
    pitch.textContent = formatPitch(camera.pitch);
    // The flat strip repeats beyond one turn; more than 360° of yaw is not more field of view.
    fov.textContent = Math.round(Math.min(360, camera.fov)) + "°";
    pointer.hidden = !hover;
    if (!hover) return;
    const at = unproject(hover.x, hover.y, camera);
    pointer.textContent = `pointer ${formatYaw(at.yaw)} ${formatPitch(at.pitch)}`;
  }

  return { node, update };
}

function buildNote(doc) {
  const node = html(doc, "div", "pv-note");
  const text = html(doc, "span");
  const alert = iconNode(doc, "alert");
  node.setAttribute("role", "status");
  node.append(alert, text);
  node.hidden = true;

  function show(kind) {
    node.hidden = !kind;
    if (!kind) return;
    text.textContent = NOTES[kind];
    // Loading is not a problem, so it carries no warning icon.
    if (kind === "loading") alert.setAttribute("display", "none");
    else alert.removeAttribute("display");
    node.classList.toggle("is-problem", kind !== "loading");
  }

  return { node, show };
}

/** actions: {mode(name), zoom(factor), reset(), crops(), fullscreen()}. */
function buildControls(doc, actions) {
  const node = html(doc, "div", "pv-controls");

  function button(className, title, onClick, content) {
    const control = html(doc, "button", className);
    control.type = "button";
    control.title = title;
    control.setAttribute("aria-label", title);
    if (content) control.append(content);
    control.addEventListener("click", onClick);
    return control;
  }

  const iconButton = (icon, title, onClick) => button("pv-button", title, onClick, iconNode(doc, icon));

  function setIcon(control, icon, title) {
    if (control.dataset.icon === icon) return;
    control.dataset.icon = icon;
    control.replaceChildren(iconNode(doc, icon));
    control.title = title;
    control.setAttribute("aria-label", title);
  }

  const modes = html(doc, "div", "pv-segment");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Projection");
  const sphere = button("pv-button pv-button-text", "", () => actions.mode("360"), "360°");
  const flat = button("pv-button pv-button-text", "Flat strip: the whole equirectangular image", () => actions.mode("flat"), "Flat");
  modes.append(sphere, flat);

  const zoomOut = iconButton("minus", "Zoom out", () => actions.zoom(1 / 0.7));
  const zoomIn = iconButton("plus", "Zoom in", () => actions.zoom(0.7));
  const reset = iconButton("reset", "Reset the view (double-click)", () => actions.reset());
  // Icon and title of these two depend on state: sync() fills them in.
  const crops = button("pv-button", "", () => actions.crops(), null);
  const full = button("pv-button", "", () => actions.fullscreen(), null);
  node.append(modes, zoomOut, zoomIn, reset, crops, full);
  let synced = "";

  /** state: {mode, canSphere, fullscreen, hasCrops, cropsVisible}. */
  function sync(state) {
    const signature = JSON.stringify(state);
    if (signature === synced) return;
    synced = signature;
    sphere.disabled = !state.canSphere;
    sphere.title = state.canSphere
      ? "360° view: drag to look around"
      : "360° view unavailable: this browser has no WebGL";
    sphere.setAttribute("aria-label", sphere.title);
    sphere.setAttribute("aria-pressed", String(state.mode === "360"));
    flat.setAttribute("aria-pressed", String(state.mode === "flat"));
    crops.hidden = !state.hasCrops;
    crops.setAttribute("aria-pressed", String(state.cropsVisible));
    setIcon(crops, state.cropsVisible ? "eye" : "eye-off",
      state.cropsVisible ? "Hide where the agent looked" : "Show where the agent looked");
    setIcon(full, state.fullscreen ? "collapse" : "expand", state.fullscreen ? "Leave full screen" : "Full screen");
  }

  return { node, sync };
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (2 * (1 - t)) * (1 - t));

/**
 * createPanoViewer(container, {sources: [{width, url}], mode: "360"|"flat", ruler: true,
 * autoPan: false, controls: true}) -> viewer (contract 6.1, amendment A9).
 *
 * Additions to the contract: options `initial` ({yaw, pitch, fov} of the reset view),
 * `autoPanSpeed` (degrees per second) and `label` (accessible name); viewer members `setSources`,
 * `setCropsVisible`, `onCropClick`, `reset`, `zoomBy`, `getCamera`, `getMode` and `el`.
 * onCropHover and onCropClick return an unsubscribe function.
 */
export function createPanoViewer(container, options = {}) {
  const opts = { sources: [], mode: "360", ruler: true, autoPan: false, controls: true, ...options };
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const initial = opts.initial || {};
  const home = {
    yaw: finite(initial.yaw, DEFAULT_VIEW.yaw),
    pitch: finite(initial.pitch, DEFAULT_VIEW.pitch),
    fov: finite(initial.fov, DEFAULT_VIEW.fov),
  };
  const panSpeed = finite(opts.autoPanSpeed, AUTO_PAN_DEG_PER_S);

  // Each mode keeps its own zoom; Infinity in flat mode means "the whole strip", whatever the size.
  const view = { yaw: home.yaw, pitch: home.pitch, fov: { 360: home.fov, flat: Infinity } };
  const state = {
    wanted: opts.mode === "flat" ? "flat" : "360",
    mode: "flat",
    width: 0,
    height: 0,
    pixelRatio: 1,
    em: 11,
    dirty: false,
    raf: 0,
    lastTs: 0,
    autoPan: Boolean(opts.autoPan),
    tween: null,
    glide: null,
    hover: null,
    destroyed: false,
  };
  const hoverListeners = new Set();
  const clickListeners = new Set();
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  let detailTimer = 0;
  let foreignWheelAt = -Infinity;
  let cropClickAt = -Infinity;
  let flatCanvas = null;
  let flat2d = null;

  // One abort removes every listener in destroy().
  const teardown = new AbortController();
  const listen = (target, type, handler, extra = {}) =>
    target.addEventListener(type, handler, { signal: teardown.signal, ...extra });

  const root = html(doc, "div", "pano-viewer");
  const stage = html(doc, "div", "pv-stage");
  const glCanvas = html(doc, "canvas", "pv-canvas");
  const overlay = svg(doc, "svg", { class: "pv-overlay", "aria-hidden": "true" });
  const crops = buildCropLayer(doc, { hover: (n) => hoverListeners.forEach((fn) => fn(n)) });
  const ruler = opts.ruler ? buildRuler(doc) : null;
  const readout = buildReadout(doc);
  const note = buildNote(doc);
  const controls = opts.controls
    ? buildControls(doc, {
        mode: (name) => { touched(); setMode(name); },
        zoom: (factor) => { touched(); zoomBy(factor); },
        reset: () => { touched(); reset(); },
        crops: () => setCropsVisible(!crops.isVisible()),
        fullscreen,
      })
    : null;

  stage.tabIndex = 0;
  stage.setAttribute("role", "application");
  stage.setAttribute("aria-label", typeof opts.label === "string" && opts.label ? opts.label : STAGE_LABEL);
  overlay.append(crops.node);
  if (ruler) overlay.append(ruler.node);
  stage.append(glCanvas, overlay);
  root.append(stage, readout.node, note.node);
  if (controls) {
    // The stylesheet lets the readout give way to the buttons in a narrow tile.
    root.classList.add("has-controls");
    root.append(controls.node);
  }
  container.append(root);

  const glRenderer = createGlRenderer(glCanvas);
  let renderer = glRenderer || canvasRenderer();
  const loader = createLoader(doc, {
    upload: (image) => renderer.upload(image),
    release: (handle) => renderer.release(handle),
    maxSize: () => renderer.maxTextureSize,
    changed: invalidate,
    status: (kind) => note.show(kind),
  });

  function canvasRenderer() {
    if (!flat2d) {
      flatCanvas = html(doc, "canvas", "pv-canvas");
      stage.insertBefore(flatCanvas, overlay);
      flat2d = createCanvasRenderer(flatCanvas);
    }
    return flat2d;
  }

  // Without a usable WebGL context only the strip can be drawn, whatever mode was asked for.
  function applyRenderer() {
    const usingGl = renderer.kind === "gl";
    glCanvas.hidden = !usingGl;
    if (flatCanvas) flatCanvas.hidden = usingGl;
    state.mode = usingGl ? state.wanted : "flat";
    root.dataset.mode = state.mode;
    syncControls();
  }

  function useRenderer(next) {
    renderer = next;
    loader.reupload();
    applyRenderer();
    sizeCanvases();
    setView({});
  }

  function camera() {
    return clampCamera({
      mode: state.mode,
      yaw: view.yaw,
      pitch: view.pitch,
      fov: view.fov[state.mode],
      width: state.width,
      height: state.height,
    });
  }

  function setView(next) {
    if (next.yaw !== undefined) view.yaw = next.yaw;
    if (next.pitch !== undefined) view.pitch = next.pitch;
    if (next.fov !== undefined) view.fov[state.mode] = next.fov;
    // Before the first layout there is no aspect ratio to clamp against: keep what was asked for.
    if (!state.width) return;
    const clamped = camera();
    view.yaw = clamped.yaw;
    view.pitch = clamped.pitch;
    const whole = state.mode === "flat" && view.fov.flat >= fovLimits("flat", clamped.width, clamped.height).max;
    view.fov[state.mode] = whole ? Infinity : clamped.fov;
    invalidate();
  }

  function invalidate() {
    state.dirty = true;
    requestFrame();
  }

  // Frames are requested only when something changed; the loop runs on its own only while
  // auto-panning, gliding or animating.
  function requestFrame() {
    if (!state.raf && !state.destroyed) state.raf = win.requestAnimationFrame(frame);
  }

  function frame(ts) {
    state.raf = 0;
    const dt = state.lastTs ? Math.min(0.1, (ts - state.lastTs) / 1000) : 0;
    state.lastTs = ts;
    const moving = step(dt, ts);
    if (state.dirty) drawNow();
    if (moving) requestFrame();
    else state.lastTs = 0;
  }

  function step(dt, ts) {
    if (state.tween) stepTween(ts);
    else if (state.glide) stepGlide(dt);
    else if (state.autoPan) setView({ yaw: view.yaw + panSpeed * dt });
    return Boolean(state.tween || state.glide || state.autoPan);
  }

  function stepTween(ts) {
    const tween = state.tween;
    if (tween.start === null) tween.start = ts;
    const t = Math.min(1, (ts - tween.start) / tween.duration);
    const eased = easeInOut(t);
    if (t >= 1) state.tween = null;
    setView({
      yaw: tween.from.yaw + tween.turn * eased,
      pitch: tween.from.pitch + (tween.to.pitch - tween.from.pitch) * eased,
      // Zoom is multiplicative, so interpolating the ratio keeps its speed even.
      fov: tween.from.fov * Math.pow(tween.to.fov / tween.from.fov, eased),
    });
  }

  function stepGlide(dt) {
    const glide = state.glide;
    const decay = Math.exp(-dt / GLIDE_TIME_S);
    setView({ yaw: view.yaw + glide.yaw * dt, pitch: view.pitch + glide.pitch * dt });
    glide.yaw *= decay;
    glide.pitch *= decay;
    if (Math.hypot(glide.yaw, glide.pitch) < GLIDE_STOP_DEG_PER_S) state.glide = null;
  }

  function drawNow() {
    state.dirty = false;
    if (!state.width || !state.height) return;
    const cam = camera();
    const layer = loader.pick(neededWidth(cam, state.pixelRatio));
    renderer.draw(cam, layer ? layer.handle : null);
    if (ruler) ruler.draw(cam, state.em);
    crops.draw(cam, state.em);
    readout.update(cam, state.hover);
    scheduleDetail();
  }

  // Wait for the zoom to settle before fetching a sharper image: a wheel gesture passes through
  // several levels that would each be downloaded and thrown away.
  function scheduleDetail() {
    win.clearTimeout(detailTimer);
    detailTimer = win.setTimeout(() => {
      if (!state.destroyed && state.width) loader.want(neededWidth(camera(), state.pixelRatio));
    }, DETAIL_DELAY_MS);
  }

  function sizeCanvases() {
    const longest = Math.max(state.width, state.height) * state.pixelRatio;
    const scale = state.pixelRatio * Math.min(1, MAX_CANVAS_SIDE / positive(longest));
    for (const canvas of [glCanvas, flatCanvas]) {
      if (!canvas) continue;
      canvas.width = Math.max(1, Math.round(state.width * scale));
      canvas.height = Math.max(1, Math.round(state.height * scale));
    }
  }

  function measure() {
    if (state.destroyed) return;
    const width = root.clientWidth;
    const height = root.clientHeight;
    if (!width || !height) return;
    state.width = width;
    state.height = height;
    state.pixelRatio = clamp(win.devicePixelRatio || 1, 1, MAX_PIXEL_RATIO);
    // Ruler and labels are laid out in em, so the stage view can scale them with its type.
    state.em = parseFloat(win.getComputedStyle(root).fontSize) || 11;
    sizeCanvases();
    setView({});
    // Resizing clears a canvas; drawing in the same task avoids a black flash before the next frame.
    drawNow();
  }

  function reduceMotion() {
    return typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function lookAt(target = {}, { animate = false, duration = TWEEN_MS } = {}) {
    const from = camera();
    const to = clampCamera({
      ...from,
      yaw: finite(target.yaw, from.yaw),
      pitch: finite(target.pitch, from.pitch),
      fov: finite(target.fov, from.fov),
    });
    state.glide = null;
    state.tween = null;
    if (!animate || reduceMotion() || !state.width) {
      setView(to);
      return;
    }
    state.tween = { from, to, turn: wrapDelta(to.yaw - from.yaw), start: null, duration };
    requestFrame();
  }

  function zoomBy(factor, { animate = true } = {}) {
    lookAt({ fov: camera().fov * factor }, { animate, duration: NUDGE_MS });
  }

  function reset({ animate = true } = {}) {
    const fov = state.mode === "flat" ? fovLimits("flat", positive(state.width), positive(state.height)).max : home.fov;
    lookAt({ yaw: home.yaw, pitch: home.pitch, fov }, { animate });
  }

  function setMode(mode) {
    state.wanted = mode === "flat" ? "flat" : "360";
    state.tween = null;
    state.glide = null;
    applyRenderer();
    setView({});
    return state.mode;
  }

  function setAutoPan(on) {
    state.autoPan = Boolean(on);
    if (state.autoPan) requestFrame();
  }

  // Any deliberate input takes the view over: auto-pan stops for good and motion in progress ends.
  function touched() {
    state.autoPan = false;
    state.tween = null;
    state.glide = null;
  }

  function setCropsVisible(visible) {
    crops.setVisible(visible);
    syncControls();
    invalidate();
  }

  function syncControls() {
    if (!controls) return;
    controls.sync({
      mode: state.mode,
      canSphere: renderer.kind === "gl",
      fullscreen: doc.fullscreenElement === root,
      hasCrops: crops.count() > 0,
      cropsVisible: crops.isVisible(),
    });
  }

  function fullscreen() {
    if (doc.fullscreenElement === root) return quiet(doc.exitFullscreen());
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    return request ? quiet(request.call(root)) : Promise.resolve();
  }

  function localPoint(event) {
    const box = stage.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  // Zoom about a point: the direction under the pointer stays under it.
  function zoomAt(factor, point) {
    const under = unproject(point.x, point.y, camera());
    setView({ fov: camera().fov * factor });
    setView(aimAt(under, point.x, point.y, camera()));
  }

  function degreesPerPixel() {
    const cam = camera();
    return cam.mode === "flat" ? cam.fov / cam.width : 1 / RAD / focalPx(cam);
  }

  function startDrag(event) {
    drag = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      ts: event.timeStamp,
      target: event.target,
      moved: false,
      velocity: { yaw: 0, pitch: 0 },
    };
  }

  function onPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    touched();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (typeof stage.setPointerCapture === "function") stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-dragging");
    if (pointers.size === 1) startDrag(event);
    else startPinch();
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, fov: camera().fov };
    drag = null;
  }

  function onPointerMove(event) {
    // A finger hides what it points at; the pointer readout is for mouse and pen.
    state.hover = event.pointerType === "touch" ? null : localPoint(event);
    if (!pointers.has(event.pointerId)) {
      if (state.width) readout.update(camera(), state.hover);
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      setView({ fov: (pinch.fov * pinch.distance) / (Math.hypot(a.x - b.x, a.y - b.y) || 1) });
    } else if (drag) {
      dragTo(event);
    }
  }

  // The scene follows the pointer: dragging right turns the camera left.
  function dragTo(event) {
    const scale = degreesPerPixel();
    const turn = { yaw: -(event.clientX - drag.x) * scale, pitch: (event.clientY - drag.y) * scale };
    const dt = (event.timeStamp - drag.ts) / 1000;
    if (dt > 0) {
      drag.velocity.yaw = 0.5 * drag.velocity.yaw + (0.5 * turn.yaw) / dt;
      drag.velocity.pitch = 0.5 * drag.velocity.pitch + (0.5 * turn.pitch) / dt;
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.ts = event.timeStamp;
    if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > CLICK_SLOP_PX) drag.moved = true;
    setView({ yaw: view.yaw + turn.yaw, pitch: view.pitch + turn.pitch });
  }

  function onPointerUp(event) {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size === 1) {
      // One finger of a pinch stays down: carry on as a drag from where it is.
      const [rest] = [...pointers.values()];
      pinch = null;
      startDrag({ clientX: rest.x, clientY: rest.y, timeStamp: event.timeStamp, target: stage });
      drag.moved = true;
      return;
    }
    if (pointers.size > 1) return;
    stage.classList.remove("is-dragging");
    pinch = null;
    const ended = drag;
    drag = null;
    if (!ended || event.type === "pointercancel") return;
    if (!ended.moved) clickCrop(ended.target, event.timeStamp);
    else if (event.timeStamp - ended.ts < 80) startGlide(ended.velocity);
  }

  function startGlide(velocity) {
    if (reduceMotion()) return;
    const limit = GLIDE_MAX_VIEWS_PER_S * Math.min(360, camera().fov);
    const speed = Math.hypot(velocity.yaw, velocity.pitch);
    if (speed < 10 * GLIDE_STOP_DEG_PER_S) return;
    const scale = Math.min(1, limit / speed);
    state.glide = { yaw: velocity.yaw * scale, pitch: velocity.pitch * scale };
    requestFrame();
  }

  // The stage captures the pointer, so a click never reaches the label itself: it is recognised
  // here from where the press began.
  function clickCrop(target, ts) {
    const label = target && typeof target.closest === "function" ? target.closest("[data-crop-label]") : null;
    const crop = label ? crops.get(Number(label.getAttribute("data-crop-label"))) : null;
    if (!crop) return;
    cropClickAt = ts;
    lookAt({ yaw: crop.yaw, pitch: crop.pitch, fov: crop.fov * 1.5 }, { animate: true });
    clickListeners.forEach((fn) => fn(crop.n));
  }

  function onWheel(event) {
    // A scroll that began on the page keeps scrolling it when the pointer drifts over the viewer;
    // otherwise a dashboard of viewers could not be scrolled past.
    if (event.timeStamp - foreignWheelAt < WHEEL_CHAIN_MS && !event.ctrlKey) {
      foreignWheelAt = event.timeStamp;
      return;
    }
    event.preventDefault();
    touched();
    const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1;
    // A trackpad pinch arrives as ctrl+wheel with small deltas.
    const delta = clamp(event.deltaY * lines, -160, 160) * (event.ctrlKey ? 5 : 1);
    zoomAt(Math.exp(delta * 0.0016), localPoint(event));
  }

  function onKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const stepDeg = Math.min(360, camera().fov) / 8;
    const quick = { animate: true, duration: NUDGE_MS };
    const keys = {
      ArrowLeft: () => lookAt({ yaw: view.yaw - stepDeg }, quick),
      ArrowRight: () => lookAt({ yaw: view.yaw + stepDeg }, quick),
      ArrowUp: () => lookAt({ pitch: view.pitch + stepDeg }, quick),
      ArrowDown: () => lookAt({ pitch: view.pitch - stepDeg }, quick),
      "+": () => zoomBy(0.8),
      "=": () => zoomBy(0.8),
      "-": () => zoomBy(1.25),
      _: () => zoomBy(1.25),
      Home: () => reset(),
    };
    if (!Object.prototype.hasOwnProperty.call(keys, event.key)) return;
    // Handled here only: the arrows must not also scroll the page or move a screen's selection.
    event.preventDefault();
    event.stopPropagation();
    touched();
    keys[event.key]();
  }

  function onPointerLeave() {
    state.hover = null;
    if (state.width) readout.update(camera(), null);
  }

  listen(stage, "pointerdown", onPointerDown);
  listen(stage, "pointermove", onPointerMove);
  listen(stage, "pointerup", onPointerUp);
  listen(stage, "pointercancel", onPointerUp);
  listen(stage, "pointerleave", onPointerLeave);
  listen(stage, "wheel", onWheel, { passive: false });
  listen(stage, "keydown", onKeyDown);
  listen(stage, "dblclick", (event) => {
    // Two quick clicks on a footprint number mean "look there", not "reset".
    if (event.timeStamp - cropClickAt < 500) return;
    touched();
    reset();
  });
  listen(doc, "wheel", (event) => {
    if (!root.contains(event.target)) foreignWheelAt = event.timeStamp;
  }, { capture: true, passive: true });
  listen(doc, "fullscreenchange", () => { syncControls(); measure(); });
  listen(win, "resize", measure);
  // A lost context (GPU reset, or too many viewers on one page) must not leave a blank tile.
  listen(glCanvas, "webglcontextlost", (event) => {
    event.preventDefault();
    useRenderer(canvasRenderer());
  });
  listen(glCanvas, "webglcontextrestored", () => {
    if (glRenderer && glRenderer.restore()) useRenderer(glRenderer);
  });

  const sizes = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(() => measure()) : null;
  if (sizes) sizes.observe(root);

  // Images load lazily: a dashboard of ten tiles fetches only the panoramas that are on screen.
  let seen = null;
  if (typeof win.IntersectionObserver === "function") {
    seen = new win.IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      loader.start();
    });
    seen.observe(root);
  } else {
    loader.start();
  }

  applyRenderer();
  loader.reset(opts.sources);
  measure();
  if (state.autoPan) requestFrame();

  function subscribe(listeners, fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    teardown.abort();
    win.cancelAnimationFrame(state.raf);
    win.clearTimeout(detailTimer);
    if (sizes) sizes.disconnect();
    if (seen) seen.disconnect();
    if (doc.fullscreenElement === root) quiet(doc.exitFullscreen());
    hoverListeners.clear();
    clickListeners.clear();
    crops.destroy();
    loader.destroy();
    if (glRenderer) glRenderer.destroy();
    root.remove();
  }

  return {
    el: root,
    setCrops(list) {
      crops.set(list);
      syncControls();
      invalidate();
    },
    highlightCrop: (n) => crops.highlight(n),
    flashCrop: (n) => crops.flash(n),
    onCropHover: (fn) => subscribe(hoverListeners, fn),
    onCropClick: (fn) => subscribe(clickListeners, fn),
    setCropsVisible,
    lookAt,
    reset,
    zoomBy,
    setMode,
    setAutoPan,
    setSources(list) {
      loader.reset(list);
      invalidate();
    },
    getCamera: camera,
    getMode: () => state.mode,
    fullscreen,
    resize: measure,
    destroy,
  };
}
