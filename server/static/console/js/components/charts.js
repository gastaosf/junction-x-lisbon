// Charts for the console: plain SVG sized to the container, themed through CSS variables
// (css/components/charts.css). No library and no import, so the scale and tick maths at the top of
// this file can be loaded by `node --test` without a DOM.
//
// Every label (series names, bar labels, mark labels) can be model or log text: it only ever
// reaches the page through textContent.

const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------- pure: numbers

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const log10 = (v) => Math.log10(v);
// Number("1e-3") is exactly 0.001; 10 ** -3 is not always the nearest double.
const pow10 = (e) => Number("1e" + e);

// Removes the float dust of repeated additions (0.1 + 0.2) at the precision of the step.
function roundTo(value, step) {
  if (!isNum(step) || step <= 0) return value;
  const decimals = clamp(Math.ceil(-log10(step)) + 2, 0, 12);
  return Number(value.toFixed(decimals));
}

export function extent(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values || []) {
    if (!isNum(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

// ---------------------------------------------------------------- pure: scales

// domain -> range, with .invert. A zero-width domain maps to the middle of the range so a single
// value is drawn in the centre rather than dividing by zero.
export function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const scale = (v) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));
  scale.invert = (p) => (r1 === r0 ? d0 : d0 + ((p - r0) / (r1 - r0)) * (d1 - d0));
  scale.domain = [d0, d1];
  scale.range = [r0, r1];
  return scale;
}

// Base-10 log scale. The domain must be positive; a value at or below zero has no logarithm and is
// drawn at the low end of the axis instead of disappearing.
export function logScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (!(d0 > 0) || !(d1 > 0)) throw new RangeError("logScale needs a positive domain");
  const l0 = log10(d0);
  const l1 = log10(d1);
  const scale = (v) => {
    if (!(v > 0)) return r0;
    return l1 === l0 ? (r0 + r1) / 2 : r0 + ((log10(v) - l0) / (l1 - l0)) * (r1 - r0);
  };
  scale.invert = (p) => (r1 === r0 ? d0 : 10 ** (l0 + ((p - r0) / (r1 - r0)) * (l1 - l0)));
  scale.domain = [d0, d1];
  scale.range = [r0, r1];
  return scale;
}

// ---------------------------------------------------------------- pure: ticks

// The step of 1, 2 or 5 x 10^n that gives about `count` intervals over `span`. The thresholds
// lean towards the larger step: a few labels too few read calmer than a few too many.
export function niceStep(span, count = 5) {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(log10(raw));
  const norm = raw / magnitude;
  const nice = norm < 1.2 ? 1 : norm < 2.5 ? 2 : norm < 6 ? 5 : 10;
  return nice * magnitude;
}

// Round tick values inside [min, max], about `count` of them.
export function niceTicks(min, max, count = 5) {
  if (!isNum(min) || !isNum(max)) return [];
  if (min > max) [min, max] = [max, min];
  if (min === max) return [min];
  const step = niceStep(max - min, count);
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);
  const ticks = [];
  for (let i = first; i <= last; i += 1) ticks.push(roundTo(i * step, step));
  return ticks;
}

// [min, max] widened to the surrounding ticks, so the axis starts and ends on a round number.
export function niceDomain(min, max, count = 5) {
  if (!isNum(min) || !isNum(max)) return [0, 1];
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    if (min === 0) return [0, 1];
    const pad = Math.abs(min) * 0.5;
    return min > 0 ? [0, roundTo(min + pad, pad)] : [roundTo(min - pad, pad), 0];
  }
  const step = niceStep(max - min, count);
  return [roundTo(Math.floor(min / step + 1e-9) * step, step), roundTo(Math.ceil(max / step - 1e-9) * step, step)];
}

// Ticks of a log axis: the decades inside [min, max]. A range that holds fewer than two decades
// also gets the 2x and 5x steps, otherwise the axis would carry a single label.
export function logTicks(min, max) {
  if (!(min > 0) || !(max > 0)) return [];
  if (min > max) [min, max] = [max, min];
  const lo = Math.ceil(log10(min) - 1e-9);
  const hi = Math.floor(log10(max) + 1e-9);
  const decades = [];
  for (let e = lo; e <= hi; e += 1) decades.push(pow10(e));
  if (decades.length >= 2) {
    // A very wide range keeps every 2nd or 3rd decade so that labels stay readable.
    const stride = Math.ceil(decades.length / 8);
    return decades.filter((_, i) => i % stride === 0);
  }
  const ticks = [];
  for (let e = Math.floor(log10(min) + 1e-9); e <= Math.ceil(log10(max) - 1e-9); e += 1) {
    for (const m of [1, 2, 5]) {
      const v = m * pow10(e);
      if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9)) ticks.push(Number(v.toPrecision(12)));
    }
  }
  return ticks;
}

// Default tick label: compact from one thousand up (1K, 2.5K, 3.2M), short everywhere.
export function formatTick(value) {
  if (!isNum(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return trim(value / 1e9) + "B";
  if (abs >= 1e6) return trim(value / 1e6) + "M";
  if (abs >= 1e3) return trim(value / 1e3) + "K";
  return trim(value);
}
const trim = (v) => String(Number(v.toPrecision(4)));

// ---------------------------------------------------------------- pure: histogram

// Bin edges for [min, max]. Linear: round steps. Log: equal steps in log10 on decade boundaries
// (1, 2 or 3 bins per decade), so decade ticks always fall on an edge.
export function histogramEdges(min, max, { log = false, count = 12 } = {}) {
  if (!isNum(min) || !isNum(max)) return [];
  if (min > max) [min, max] = [max, min];
  if (log) {
    if (!(max > 0)) return [];
    if (!(min > 0)) min = max;
    const lo = Math.floor(log10(min) + 1e-9);
    let hi = Math.ceil(log10(max) - 1e-9);
    if (hi <= lo) hi = lo + 1;
    const perDecade = clamp(Math.round(count / (hi - lo)), 1, 3);
    const edges = [];
    for (let i = 0; i <= (hi - lo) * perDecade; i += 1) {
      edges.push(i % perDecade === 0 ? pow10(lo + i / perDecade) : 10 ** (lo + i / perDecade));
    }
    return edges;
  }
  if (min === max) return [min - 0.5, max + 0.5];
  const step = niceStep(max - min, count);
  const first = Math.floor(min / step + 1e-9);
  let last = Math.ceil(max / step - 1e-9);
  if (last === first) last += 1;
  const edges = [];
  for (let i = first; i <= last; i += 1) edges.push(roundTo(i * step, step));
  return edges;
}

// Counts per bin: [{x0, x1, count}]. Pass `edges` to bin several groups on the same bins. A value
// outside the edges is counted in the nearest end bin (so a zero on a log axis is still counted);
// a value on an inner edge belongs to the bin on its right, and the last edge closes the last bin.
export function histogramBins(values, { log = false, count = 12, edges = null } = {}) {
  const clean = (values || []).filter(isNum);
  let bounds = edges;
  if (!bounds) {
    const range = extent(log ? clean.filter((v) => v > 0) : clean);
    bounds = range ? histogramEdges(range[0], range[1], { log, count }) : [];
  }
  const bins = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) bins.push({ x0: bounds[i], x1: bounds[i + 1], count: 0 });
  if (!bins.length) return bins;
  for (const v of clean) {
    let index = bins.length - 1;
    for (let i = 0; i < bins.length; i += 1) {
      if (v < bins[i].x1) { index = i; break; }
    }
    bins[index].count += 1;
  }
  return bins;
}

// ---------------------------------------------------------------- pure: series helpers

// Six hues (charts.css --chart-1..6) and five dash patterns. Colour alone identifies up to four
// lines; beyond that every line also gets a dash pattern, and because 6 and 5 share no factor
// the pair (colour, dash) stays unique for the first thirty series.
export const PALETTE_SIZE = 6;
export const DASHES = ["", "7 3", "2 3", "9 3 2 3", "4 2"];
export function seriesStyle(index, total) {
  return {
    slot: (index % PALETTE_SIZE) + 1,
    dash: total > 4 ? DASHES[index % DASHES.length] : "",
  };
}

// Value of a series at x for the hover read-out. Step series hold their last value; ordinary
// series are interpolated between the two neighbouring points. Null outside the series or
// across a gap (a null y).
export function valueAt(points, x, step = false) {
  let before = null;
  let after = null;
  for (const p of points || []) {
    if (!p || !isNum(p[0])) continue;
    if (p[0] <= x && (!before || p[0] >= before[0])) before = p;
    if (p[0] >= x && (!after || p[0] < after[0])) after = p;
  }
  if (before && before[0] === x) return isNum(before[1]) ? before[1] : null;
  if (step) return before && isNum(before[1]) ? before[1] : null;
  if (!before || !after || !isNum(before[1]) || !isNum(after[1])) return null;
  const t = (x - before[0]) / (after[0] - before[0]);
  return before[1] + t * (after[1] - before[1]);
}

// SVG path for one series. A null y breaks the line; a point with no neighbour on either side
// cannot be seen as a line, so it is returned in `dots`.
export function linePath(points, sx, sy, step = false) {
  let d = "";
  const dots = [];
  let run = [];
  const flush = () => {
    if (run.length === 1) dots.push(run[0]);
    run = [];
  };
  for (const p of points || []) {
    if (!p || !isNum(p[0]) || !isNum(p[1])) { flush(); continue; }
    const x = round1(sx(p[0]));
    const y = round1(sy(p[1]));
    if (!run.length) d += (d ? " " : "") + "M" + x + " " + y;
    else d += step ? " H" + x + " V" + y : " L" + x + " " + y;
    run.push([x, y]);
  }
  flush();
  return { d, dots };
}
const round1 = (v) => Math.round(v * 10) / 10;

// A bar from the baseline y0 to the value y1 with a rounded data end and a square foot.
export function barPath(x, width, y0, y1, radius = 4) {
  const r = Math.max(0, Math.min(radius, width / 2, Math.abs(y1 - y0)));
  const up = y1 <= y0 ? 1 : -1;
  const x1 = x + width;
  const f = round1;
  return "M" + f(x) + " " + f(y0) + " V" + f(y1 + up * r) + " Q" + f(x) + " " + f(y1) + " " + f(x + r) + " " + f(y1)
    + " H" + f(x1 - r) + " Q" + f(x1) + " " + f(y1) + " " + f(x1) + " " + f(y1 + up * r) + " V" + f(y0) + " Z";
}

// Domain and ticks of one value axis. Linear axes start at zero when the data is not negative
// (bars and probabilities are read against zero); log axes run over whole decades.
export function axisSpec(values, { min, max, log = false, count = 5, zero = true } = {}) {
  if (log) {
    const range = extent((values || []).filter((v) => v > 0)) || [1, 10];
    let lo = pow10(Math.floor(log10(range[0]) + 1e-9));
    let hi = pow10(Math.ceil(log10(range[1]) - 1e-9));
    if (min > 0) lo = min;
    if (max > 0) hi = max;
    if (hi <= lo) hi = lo * 10;
    return { domain: [lo, hi], ticks: logTicks(lo, hi), log: true };
  }
  const range = extent(values) || [0, 1];
  let lo = zero && range[0] > 0 ? 0 : range[0];
  let hi = zero && range[1] < 0 ? 0 : range[1];
  [lo, hi] = niceDomain(lo, hi, count);
  if (isNum(min)) lo = min;
  if (isNum(max)) hi = max;
  if (hi <= lo) hi = lo + 1;
  return { domain: [lo, hi], ticks: niceTicks(lo, hi, count), log: false };
}

// ---------------------------------------------------------------- DOM helpers

function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function s(tag, cls) {
  const node = document.createElementNS(SVG_NS, tag);
  if (cls) node.setAttribute("class", cls);
  return node;
}

function attr(node, name, value) {
  if (value === null || value === undefined || value === false || value === "") node.removeAttribute(name);
  else node.setAttribute(name, String(value));
}

function attrs(node, map) {
  for (const name of Object.keys(map)) attr(node, name, map[name]);
}

// Makes the children of `group` match `items`, reusing the nodes that are already there. A live
// chart is updated several times a second: this keeps the DOM stable instead of rebuilding it.
function sync(group, tag, items, apply) {
  while (group.childElementCount > items.length) group.lastElementChild.remove();
  items.forEach((item, i) => {
    let node = group.children[i];
    if (!node) { node = s(tag); group.append(node); }
    apply(node, item, i);
  });
}

// A caller may pass its own series colour. Only a hex colour or a CSS variable is accepted, so a
// string that came from anywhere else can never become a style.
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i;
function paint(node, slot, color) {
  if (typeof color === "string" && SAFE_COLOR.test(color)) node.style.setProperty("--c", color);
  else node.style.removeProperty("--c");
  return "chart-c" + slot;
}

// Width of a label without touching the DOM (works in a hidden container too). Tabular digits in
// the system fonts are close to 0.58 em.
const textWidth = (text, fontPx) => String(text).length * fontPx * 0.58;

const callFormat = (format, value) => (typeof format === "function" ? String(format(value)) : formatTick(value));

const LAYERS = ["band", "grid", "axes", "markLines", "markTexts", "bars", "lines", "dots", "cursor", "hover"];
let clipCount = 0;

function createFrame(container, kind) {
  // "chart-kind-line", not "chart-line": that class styles the line marks themselves.
  const root = h("div", "chart chart-kind-" + kind);
  const legend = h("div", "chart-legend");
  legend.hidden = true;
  const plot = h("div", "chart-plot");
  const svg = s("svg", "chart-svg");
  attrs(svg, { role: "img", tabindex: 0, focusable: "true" });
  const clipId = "chart-clip-" + (clipCount += 1);
  const defs = s("defs");
  const clip = s("clipPath");
  clip.setAttribute("id", clipId);
  const clipRect = s("rect");
  clip.append(clipRect);
  defs.append(clip);
  svg.append(defs);
  const g = {};
  for (const name of LAYERS) {
    // "chart-layer-band", not "chart-band": the short names are the classes of the marks.
    g[name] = s("g", "chart-layer-" + name);
    svg.append(g[name]);
  }
  // Data is clipped to the plot box: a caller-fixed axis range may be narrower than the data.
  for (const name of ["bars", "lines", "dots"]) g[name].setAttribute("clip-path", "url(#" + clipId + ")");
  const empty = h("div", "chart-empty");
  const tip = h("div", "chart-tip");
  tip.hidden = true;
  plot.append(svg, empty, tip);
  root.append(legend, plot);
  container.append(root);
  return { root, legend, plot, svg, g, clipRect, empty, tip, width: 0, height: 0, fontPx: 12, legendSig: "" };
}

function measure(frame) {
  const rect = frame.plot.getBoundingClientRect();
  frame.width = Math.floor(rect.width);
  frame.height = Math.floor(rect.height);
  frame.fontPx = parseFloat(getComputedStyle(frame.root).fontSize) || 12;
}

// Functions are compared by their source: callers pass inline formatters, and a new closure with
// the same text must not count as a change.
function signature(opts, frame) {
  const data = JSON.stringify(opts, (key, value) => {
    if (key === "cursor") return undefined;
    return typeof value === "function" ? String(value) : value;
  });
  return data + "|" + frame.width + "x" + frame.height + "@" + frame.fontPx;
}

// ---------------------------------------------------------------- axes, marks, legend

function plotBox(frame, yLabels, { xLabel, yLabel, markRows = 0 }) {
  const f = frame.fontPx;
  const widest = Math.max(0, ...yLabels.map((label) => textWidth(label, f)));
  return {
    left: Math.ceil(widest + f * 0.9),
    right: frame.width - Math.ceil(f * 1.2),
    top: Math.ceil(f * 0.7 + (yLabel ? f * 1.35 : 0) + markRows * f * 1.3),
    bottom: frame.height - Math.ceil(f * 1.8 + (xLabel ? f * 1.35 : 0)),
  };
}

const newParts = () => ({ grid: [], texts: [], markLines: [], markTexts: [] });

function addYAxis(parts, frame, box, scale, ticks, format, label) {
  const f = frame.fontPx;
  for (const tick of ticks) {
    const y = round1(scale(tick));
    parts.grid.push({ x1: box.left, x2: box.right, y1: y, y2: y, cls: "chart-gridline" });
    parts.texts.push({ x: box.left - f * 0.5, y: y + f * 0.33, text: callFormat(format, tick), anchor: "end", cls: "chart-tick" });
  }
  parts.grid.push({ x1: box.left, x2: box.right, y1: box.bottom, y2: box.bottom, cls: "chart-axis" });
  if (label) parts.texts.push({ x: 0, y: box.labelY ?? f * 1.05, text: label, anchor: "start", cls: "chart-axis-label" });
}

// ticks: [{px, text}] from left to right. A label that would touch the previous one is dropped;
// its tick mark stays.
function addXAxis(parts, frame, box, ticks, label) {
  const f = frame.fontPx;
  let lastRight = -Infinity;
  for (const tick of ticks) {
    const px = round1(tick.px);
    parts.grid.push({ x1: px, x2: px, y1: box.bottom, y2: box.bottom + f * 0.35, cls: "chart-axis" });
    const width = textWidth(tick.text, f);
    const centre = clamp(px, width / 2 + 1, Math.max(width / 2 + 1, frame.width - width / 2 - 1));
    if (centre - width / 2 < lastRight + f * 0.6) continue;
    lastRight = centre + width / 2;
    parts.texts.push({ x: centre, y: box.bottom + f * 1.35, text: tick.text, anchor: "middle", cls: "chart-tick" });
  }
  if (label) {
    parts.texts.push({ x: (box.left + box.right) / 2, y: frame.height - f * 0.35, text: label, anchor: "middle", cls: "chart-axis-label" });
  }
}

const cleanMarks = (marks) => (Array.isArray(marks) ? marks.filter((m) => m && isNum(m.x)) : []);
const MARK_KIND = /^[a-z][a-z0-9_-]{0,23}$/;

// Places the mark labels above the plot. A label that would run into its left neighbour goes to
// a second row; with nowhere left it is dropped (the line stays and the hover of the caller's
// own list still names it).
function layoutMarks(marks, sx, frame) {
  const f = frame.fontPx;
  const rows = [-Infinity, -Infinity];
  const placed = [...marks].sort((a, b) => a.x - b.x).map((mark) => {
    const px = sx(mark.x);
    const text = mark.label === undefined || mark.label === null ? "" : String(mark.label);
    const width = textWidth(text, f * 0.92);
    const start = clamp(px - width / 2, 0, Math.max(0, frame.width - width));
    let row = text ? rows.findIndex((right) => start > right + f * 0.5) : -1;
    if (row >= 0) rows[row] = start + width;
    return { px, text, start, width, row, kind: MARK_KIND.test(mark.kind || "") ? mark.kind : "" };
  });
  const used = placed.reduce((max, m) => Math.max(max, m.row + 1), 0);
  return { placed, rows: used };
}

function addMarks(parts, frame, box, layout) {
  const f = frame.fontPx;
  for (const mark of layout.placed) {
    if (mark.px < box.left - 0.5 || mark.px > box.right + 0.5) continue;
    const cls = mark.kind ? " chart-mark-" + mark.kind : "";
    // Row 0 sits just above the plot, row 1 above it.
    const labelY = box.top - f * 0.45 - mark.row * f * 1.3;
    parts.markLines.push({ x1: round1(mark.px), x2: round1(mark.px), y1: mark.row >= 0 ? labelY + f * 0.25 : box.top, y2: box.bottom, cls: "chart-mark" + cls });
    if (mark.row >= 0) parts.markTexts.push({ x: mark.start + mark.width / 2, y: labelY, text: mark.text, anchor: "middle", cls: "chart-mark-label" + cls });
  }
}

function applyLine(node, item) {
  attrs(node, { x1: item.x1, x2: item.x2, y1: item.y1, y2: item.y2, class: item.cls });
}

function applyText(node, item) {
  attrs(node, { x: round1(item.x), y: round1(item.y), "text-anchor": item.anchor, class: item.cls });
  if (node.textContent !== item.text) node.textContent = item.text;
}

function flush(frame, parts, box) {
  sync(frame.g.grid, "line", parts.grid, applyLine);
  sync(frame.g.axes, "text", parts.texts, applyText);
  sync(frame.g.markLines, "line", parts.markLines, applyLine);
  sync(frame.g.markTexts, "text", parts.markTexts, applyText);
  // A little slack, so a dot or a line end sitting exactly on the edge is not cut in half.
  attrs(frame.clipRect, { x: box.left - 7, y: box.top - 7, width: Math.max(0, box.right - box.left + 14), height: Math.max(0, box.bottom - box.top + 8) });
}

// Legend keys mirror the mark: a stroke (with its dash) for lines, a dot for points, a block for
// bars. Names are text nodes. One series needs no legend: the axis label already names it.
function renderLegend(frame, items, onHover) {
  const sig = JSON.stringify(items);
  frame.legend.hidden = items.length < 2;
  if (sig === frame.legendSig) return;
  frame.legendSig = sig;
  frame.legend.replaceChildren(...items.map((item, index) => {
    const entry = h("span", "chart-legend-item");
    const key = s("svg", "chart-legend-key");
    attrs(key, { viewBox: "0 0 24 10", "aria-hidden": "true" });
    key.append(legendMark(item));
    const name = h("span", "chart-legend-name", item.name);
    name.title = item.name;
    entry.append(key, name);
    if (onHover) {
      entry.addEventListener("pointerenter", () => onHover(index));
      entry.addEventListener("pointerleave", () => onHover(null));
    }
    return entry;
  }));
}

function legendMark(item) {
  if (item.shape === "dot") {
    const dot = s("circle");
    attrs(dot, { cx: 12, cy: 5, r: 4, class: "chart-dot " + paint(dot, item.slot, item.color) });
    return dot;
  }
  if (item.shape === "rect") {
    const rect = s("rect");
    attrs(rect, { x: 6, y: 0, width: 12, height: 10, rx: 2, class: "chart-bar " + paint(rect, item.slot, item.color) });
    return rect;
  }
  const line = s("line");
  attrs(line, { x1: 1, x2: 23, y1: 5, y2: 5, "stroke-dasharray": item.dash, class: "chart-line " + paint(line, item.slot, item.color) });
  return line;
}

function showTip(frame, stop, pointerY) {
  const tip = frame.tip;
  const nodes = [];
  if (stop.title) nodes.push(h("div", "chart-tip-title", stop.title));
  for (const row of stop.rows || []) {
    const line = h("div", "chart-tip-row");
    if (row.slot) {
      const key = h("span", "chart-tip-key");
      key.classList.add(paint(key, row.slot, row.color));
      line.append(key);
    }
    // The value leads: the reader already knows the series and wants the number.
    line.append(h("strong", "chart-tip-value", row.value), h("span", "chart-tip-label", row.label));
    nodes.push(line);
  }
  tip.replaceChildren(...nodes);
  tip.hidden = false;
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  let left = stop.x + 12;
  if (left + width > frame.width - 4) left = stop.x - 12 - width;
  left = clamp(left, 4, Math.max(4, frame.width - width - 4));
  const top = clamp((isNum(pointerY) ? pointerY : stop.y) - height / 2, 4, Math.max(4, frame.height - height - 4));
  tip.style.transform = "translate(" + Math.round(left) + "px, " + Math.round(top) + "px)";
}

function describe(kind, opts) {
  const names = { line: "Line chart", bar: "Bar chart", scatter: "Scatter chart", histogram: "Histogram" };
  const parts = [names[kind]];
  const yLabel = opts.y && opts.y.label;
  const xLabel = opts.x && opts.x.label;
  if (yLabel && xLabel) parts.push(yLabel + " by " + xLabel);
  else if (yLabel || xLabel) parts.push(yLabel || xLabel);
  return parts.join(": ") + ". Arrow keys read the values.";
}

// ---------------------------------------------------------------- the shared chart shell

// `draw(frame, opts)` paints the chart and returns a scene, or null when there is nothing to
// show. A scene is what the shell needs for the hover read-out, the keyboard and the cursor:
//   count, stop(i) -> {x, y, title, rows}, nearest(px, py) -> i|null, highlight(i|null),
//   pick?(i, point), sx? + box? (for the cursor line).
function createChart(container, kind, initial, draw) {
  const frame = createFrame(container, kind);
  let opts = { ...(initial || {}) };
  let scene = null;
  let lastSig = "";
  let active = null;
  let pointer = null;
  let destroyed = false;
  let pending = 0;

  function setActive(index, pointerY) {
    active = scene && index !== null && index >= 0 && index < scene.count ? index : null;
    if (scene) scene.highlight(active);
    if (active === null) { frame.tip.hidden = true; return; }
    showTip(frame, scene.stop(active), pointerY);
  }

  function drawCursor() {
    const x = opts.cursor;
    const visible = !!(scene && scene.sx && isNum(x) && x >= scene.sx.domain[0] && x <= scene.sx.domain[1]);
    // A line with a small handle on top, so it cannot be mistaken for one of the marks.
    sync(frame.g.cursor, "path", visible ? [0] : [], (node) => {
      const px = round1(scene.sx(x));
      const top = scene.box.top;
      attrs(node, { d: "M" + px + " " + top + " V" + scene.box.bottom + " M" + (px - 4.5) + " " + (top - 7) + " h9 l-4.5 6 z", class: "chart-cursor-line" });
    });
  }

  function render() {
    if (destroyed) return;
    if (isNum(opts.height)) frame.root.style.height = opts.height + "px";
    measure(frame);
    // Hidden or collapsed: the ResizeObserver calls again when the container gets a size.
    if (frame.width < 48 || frame.height < 48) return;
    const sig = signature(opts, frame);
    if (sig === lastSig) return;
    lastSig = sig;
    attrs(frame.svg, { viewBox: "0 0 " + frame.width + " " + frame.height, "aria-label": describe(kind, opts) });
    scene = draw(frame, opts);
    frame.root.classList.toggle("is-empty", !scene);
    frame.root.classList.toggle("is-pickable", !!(scene && scene.pick));
    if (!scene) {
      frame.empty.textContent = typeof opts.empty === "string" ? opts.empty : "no data yet";
      frame.legend.hidden = true;
      frame.legendSig = "";
    }
    drawCursor();
    // Keep the read-out under a resting pointer when live data arrives.
    if (scene && pointer) setActive(scene.nearest(pointer.x, pointer.y), pointer.y);
    else setActive(scene ? active : null);
  }

  function local(event) {
    const rect = frame.svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  frame.svg.addEventListener("pointermove", (event) => {
    if (!scene) return;
    pointer = local(event);
    setActive(scene.nearest(pointer.x, pointer.y), pointer.y);
  });
  frame.svg.addEventListener("pointerleave", () => { pointer = null; setActive(null); });
  frame.svg.addEventListener("click", (event) => {
    if (!scene || !scene.pick) return;
    const point = local(event);
    const index = scene.nearest(point.x, point.y);
    if (index !== null) scene.pick(index, point);
  });
  frame.svg.addEventListener("blur", () => { if (!pointer) setActive(null); });
  // The same read-out for the keyboard: arrows move along the data, Enter picks.
  frame.svg.addEventListener("keydown", (event) => {
    if (!scene || !scene.count || event.ctrlKey || event.metaKey || event.altKey) return;
    const last = scene.count - 1;
    let next = null;
    if (event.key === "ArrowRight") next = active === null ? 0 : Math.min(last, active + 1);
    else if (event.key === "ArrowLeft") next = active === null ? last : Math.max(0, active - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") { if (active === null) return; setActive(null); }
    else if (event.key === "Enter" || event.key === " ") { if (active === null || !scene.pick) return; scene.pick(active, null); }
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== null) { pointer = null; setActive(next); }
  });

  const schedule = () => {
    if (pending || destroyed) return;
    pending = requestAnimationFrame(() => { pending = 0; render(); });
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  if (observer) observer.observe(frame.plot);
  render();

  return {
    // Shallow merge: update({series}) keeps the axes, update({cursor}) only moves the cursor.
    update(next) {
      if (destroyed || !next) return;
      const keys = Object.keys(next);
      opts = { ...opts, ...next };
      if (keys.length === 1 && keys[0] === "cursor") { drawCursor(); return; }
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (observer) observer.disconnect();
      if (pending) cancelAnimationFrame(pending);
      frame.root.remove();
    },
    el: frame.root,
  };
}

// Vertical tick budget from the height in pixels: one label every three text lines or so.
const tickCount = (pixels, fontPx, max = 7) => clamp(Math.floor(pixels / (fontPx * 2.8)), 2, max);

function xTicksOf(spec, sx, format) {
  return spec.ticks.map((tick) => ({ px: sx(tick), text: callFormat(format, tick) }));
}

function nearestIndex(positions, px) {
  let best = null;
  let bestDistance = Infinity;
  for (let i = 0; i < positions.length; i += 1) {
    const distance = Math.abs(positions[i] - px);
    if (distance < bestDistance) { best = i; bestDistance = distance; }
  }
  return best;
}

// ---------------------------------------------------------------- line chart

function cleanSeries(series) {
  const list = Array.isArray(series) ? series.filter((sr) => sr && Array.isArray(sr.points)) : [];
  return list.map((sr, index) => ({
    name: sr.name === undefined || sr.name === null ? "series " + (index + 1) : String(sr.name),
    color: sr.color,
    points: sr.points.filter((p) => Array.isArray(p) && isNum(p[0])),
    ...seriesStyle(index, list.length),
  }));
}

function drawLine(frame, o) {
  const series = cleanSeries(o.series);
  const xValues = [];
  const yValues = [];
  for (const sr of series) {
    for (const p of sr.points) {
      if (!isNum(p[1])) continue;
      xValues.push(p[0]);
      yValues.push(p[1]);
    }
  }
  if (!yValues.length) return null;
  const xa = o.x || {};
  const ya = o.y || {};
  const marks = cleanMarks(o.marks);
  const f = frame.fontPx;

  // The x axis is not rounded outwards: a time line should start at its first event and end at
  // its last. Marks inside a caller-less range widen it so the final-submission mark is visible.
  let [x0, x1] = extent(xValues.concat(marks.map((m) => m.x)));
  if (isNum(xa.min)) x0 = xa.min;
  if (isNum(xa.max)) x1 = xa.max;
  if (x1 <= x0) { x0 -= 0.5; x1 += 0.5; }

  const ySpec = axisSpec(yValues, { min: ya.min, max: ya.max, log: !!ya.log, count: tickCount(frame.height - f * 5, f) });
  const yLabels = ySpec.ticks.map((tick) => callFormat(ya.format, tick));
  let box = plotBox(frame, yLabels, { xLabel: xa.label, yLabel: ya.label });
  let sx = linearScale([x0, x1], [box.left, box.right]);
  const markLayout = layoutMarks(marks, sx, frame);
  if (markLayout.rows) box = plotBox(frame, yLabels, { xLabel: xa.label, yLabel: ya.label, markRows: markLayout.rows });
  const sy = (ySpec.log ? logScale : linearScale)(ySpec.domain, [box.bottom, box.top]);

  const parts = newParts();
  addYAxis(parts, frame, box, sy, ySpec.ticks, ya.format, ya.label);
  const xTicks = niceTicks(x0, x1, clamp(Math.floor((box.right - box.left) / (f * 7)), 2, 10));
  addXAxis(parts, frame, box, xTicks.map((tick) => ({ px: sx(tick), text: callFormat(xa.format, tick) })), xa.label);
  addMarks(parts, frame, box, markLayout);
  flush(frame, parts, box);

  const step = !!o.step;
  const lone = [];
  const shapes = series.map((sr) => {
    const shape = linePath(sr.points, sx, sy, step);
    for (const dot of shape.dots) lone.push({ x: dot[0], y: dot[1], sr });
    return shape.d;
  });
  sync(frame.g.bars, "path", [], () => {});
  sync(frame.g.lines, "path", series, (node, sr, i) => {
    attrs(node, { d: shapes[i], "stroke-dasharray": sr.dash, class: "chart-line " + paint(node, sr.slot, sr.color) });
  });
  sync(frame.g.dots, "circle", lone, (node, dot) => {
    attrs(node, { cx: dot.x, cy: dot.y, r: 3, class: "chart-dot " + paint(node, dot.sr.slot, dot.sr.color) });
  });
  renderLegend(frame, series.map((sr) => ({ name: sr.name, slot: sr.slot, color: sr.color, dash: sr.dash, shape: "line" })), (index) => {
    [...frame.g.lines.children].forEach((node, i) => node.classList.toggle("is-dim", index !== null && i !== index));
  });

  const stops = [...new Set(xValues)].filter((x) => x >= x0 && x <= x1).sort((a, b) => a - b);
  const positions = stops.map((x) => sx(x));
  const title = (x) => (xa.label ? xa.label + " " : "") + callFormat(xa.format, x);
  return {
    sx,
    box,
    count: stops.length,
    stop(i) {
      const rows = [];
      for (const sr of series) {
        const value = valueAt(sr.points, stops[i], step);
        if (value !== null) rows.push({ label: sr.name, value: callFormat(ya.format, value), slot: sr.slot, color: sr.color });
      }
      return { x: positions[i], y: box.top + f, title: title(stops[i]), rows };
    },
    nearest: (px) => nearestIndex(positions, px),
    highlight(i) {
      const marks = [];
      if (i !== null) {
        for (const sr of series) {
          const value = valueAt(sr.points, stops[i], step);
          if (value !== null) marks.push({ y: sy(value), sr });
        }
      }
      sync(frame.g.hover, "g", i === null ? [] : [0], (group) => {
        let line = group.firstElementChild;
        if (!line) { line = s("line", "chart-crosshair"); group.append(line); }
        attrs(line, { x1: round1(positions[i]), x2: round1(positions[i]), y1: box.top, y2: box.bottom });
        while (group.childElementCount > marks.length + 1) group.lastElementChild.remove();
        marks.forEach((mark, k) => {
          let dot = group.children[k + 1];
          if (!dot) { dot = s("circle"); group.append(dot); }
          attrs(dot, { cx: round1(positions[i]), cy: round1(mark.y), r: 4, class: "chart-dot chart-dot-hover " + paint(dot, mark.sr.slot, mark.sr.color) });
        });
      });
    },
    // The picked x is the data position under the crosshair; `raw` is where the pointer was.
    pick: typeof o.onPick === "function" ? (i, point) => o.onPick(stops[i], { raw: point ? sx.invert(point.x) : stops[i] }) : null,
  };
}

// ---------------------------------------------------------------- bar chart

function drawBars(frame, o) {
  const bars = (Array.isArray(o.bars) ? o.bars : []).map((bar, index) => ({ bar, index })).filter(({ bar }) => bar && (isNum(bar.value) || isNum(bar.value2)));
  if (!bars.length) return null;
  const f = frame.fontPx;
  // value and value2 are different measures (cost and latency per turn). Two scales on one plot
  // would invent a relation between them, so each gets its own panel over the shared x axis.
  const panels = [{ key: "value", axis: o.y || {}, slot: 1 }];
  if (bars.some(({ bar }) => isNum(bar.value2))) panels.push({ key: "value2", axis: o.y2 || {}, slot: 2 });

  const xLabel = o.x && o.x.label;
  const outer = plotBox(frame, [], { xLabel, yLabel: true });
  const gap = panels.length > 1 ? f * 2.9 : 0;
  const panelHeight = (outer.bottom - outer.top - gap * (panels.length - 1)) / panels.length;
  for (const panel of panels) {
    const values = bars.map(({ bar }) => bar[panel.key]).filter(isNum);
    panel.spec = axisSpec(values, { min: panel.axis.min, max: panel.axis.max, count: tickCount(panelHeight, f, 5) });
    panel.labels = panel.spec.ticks.map((tick) => callFormat(panel.axis.format, tick));
  }
  const left = plotBox(frame, panels.flatMap((panel) => panel.labels), {}).left;
  const band = (outer.right - left) / bars.length;
  // Thin bars with air between them; a bar never fills its slot.
  const width = clamp(Math.min(band * 0.72, band - 2), 1, 24);
  const centre = (i) => left + band * (i + 0.5);

  const parts = newParts();
  const shapes = [];
  panels.forEach((panel, p) => {
    const top = outer.top + p * (panelHeight + gap);
    const box = { left, right: outer.right, top, bottom: top + panelHeight, labelY: top - f * 0.85 };
    panel.box = box;
    panel.sy = linearScale(panel.spec.domain, [box.bottom, box.top]);
    addYAxis(parts, frame, box, panel.sy, panel.spec.ticks, panel.axis.format, panel.axis.label || (p ? "value 2" : ""));
    const zero = panel.sy(clamp(0, panel.spec.domain[0], panel.spec.domain[1]));
    bars.forEach(({ bar }, i) => {
      if (!isNum(bar[panel.key])) return;
      shapes.push({ d: barPath(centre(i) - width / 2, width, zero, panel.sy(bar[panel.key])), slot: panel.slot, i });
    });
  });
  const lastBox = panels[panels.length - 1].box;
  addXAxis(parts, frame, lastBox, bars.map(({ bar }, i) => ({ px: centre(i), text: bar.label === undefined || bar.label === null ? String(i + 1) : String(bar.label) })), xLabel);
  const whole = { left, right: outer.right, top: panels[0].box.top, bottom: lastBox.bottom };
  flush(frame, parts, whole);

  const selected = bars.findIndex(({ index }) => index === o.selected);
  const bandRect = (node, item) => attrs(node, { x: round1(left + band * item.i), y: whole.top, width: round1(band), height: whole.bottom - whole.top, class: item.cls });
  const drawBands = (hovered) => {
    const items = [];
    if (selected >= 0) items.push({ i: selected, cls: "chart-band chart-band-selected" });
    if (hovered !== null && hovered !== selected) items.push({ i: hovered, cls: "chart-band" });
    sync(frame.g.band, "rect", items, bandRect);
  };
  drawBands(null);
  sync(frame.g.lines, "path", [], () => {});
  sync(frame.g.dots, "circle", [], () => {});
  sync(frame.g.bars, "path", shapes, (node, shape) => {
    attrs(node, { d: shape.d, class: "chart-bar chart-c" + shape.slot + (shape.i === selected ? " is-selected" : "") });
  });
  frame.legend.hidden = true;

  return {
    count: bars.length,
    stop(i) {
      const { bar } = bars[i];
      const rows = panels.filter((panel) => isNum(bar[panel.key])).map((panel) => ({
        label: panel.axis.label || panel.key, value: callFormat(panel.axis.format, bar[panel.key]), slot: panel.slot,
      }));
      const label = bar.label === undefined || bar.label === null ? String(i + 1) : String(bar.label);
      return { x: centre(i), y: whole.top + f, title: (xLabel ? xLabel + " " : "") + label, rows };
    },
    nearest: (px) => (px < left || px > outer.right ? null : clamp(Math.floor((px - left) / band), 0, bars.length - 1)),
    highlight(i) {
      drawBands(i);
      [...frame.g.bars.children].forEach((node, k) => node.classList.toggle("is-active", shapes[k].i === i));
    },
    pick: typeof o.onPick === "function" ? (i) => o.onPick(bars[i].bar, bars[i].index) : null,
  };
}

// ---------------------------------------------------------------- scatter chart

function drawScatter(frame, o) {
  const points = (Array.isArray(o.points) ? o.points : []).map((point, index) => ({ point, index })).filter(({ point }) => point && isNum(point.x) && isNum(point.y));
  if (!points.length) return null;
  const xa = o.x || {};
  const ya = o.y || {};
  const f = frame.fontPx;
  // Colour follows the kind in order of first appearance, so it is stable while points arrive.
  const kinds = [];
  for (const { point } of points) {
    const kind = point.kind === undefined || point.kind === null ? "" : String(point.kind);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  const slotOf = (point) => (kinds.indexOf(point.kind === undefined || point.kind === null ? "" : String(point.kind)) % PALETTE_SIZE) + 1;

  const ySpec = axisSpec(points.map(({ point }) => point.y), { min: ya.min, max: ya.max, log: !!o.logY, count: tickCount(frame.height - f * 5, f), zero: false });
  const yLabels = ySpec.ticks.map((tick) => callFormat(ya.format, tick));
  const marks = cleanMarks(o.marks);
  let box = plotBox(frame, yLabels, { xLabel: xa.label, yLabel: ya.label });
  const xSpec = axisSpec(points.map(({ point }) => point.x), { min: xa.min, max: xa.max, log: !!o.logX, count: clamp(Math.floor((box.right - box.left) / (f * 7)), 2, 10), zero: false });
  const makeX = () => (xSpec.log ? logScale : linearScale)(xSpec.domain, [box.left, box.right]);
  let sx = makeX();
  const markLayout = layoutMarks(marks, sx, frame);
  if (markLayout.rows) {
    box = plotBox(frame, yLabels, { xLabel: xa.label, yLabel: ya.label, markRows: markLayout.rows });
    sx = makeX();
  }
  const sy = (ySpec.log ? logScale : linearScale)(ySpec.domain, [box.bottom, box.top]);

  const parts = newParts();
  addYAxis(parts, frame, box, sy, ySpec.ticks, ya.format, ya.label);
  addXAxis(parts, frame, box, xTicksOf(xSpec, sx, xa.format), xa.label);
  addMarks(parts, frame, box, markLayout);
  flush(frame, parts, box);

  const placed = points.map(({ point }) => ({ x: sx(point.x), y: sy(point.y), slot: slotOf(point) }));
  sync(frame.g.bars, "path", [], () => {});
  // `diagonal`: the line y = x across the part both axes cover, for a plot of one quantity
  // against the same quantity (run A against run B): above it one side won, below it the other.
  const diagonal = [];
  if (o.diagonal) {
    const from = Math.max(xSpec.domain[0], ySpec.domain[0]);
    const to = Math.min(xSpec.domain[1], ySpec.domain[1]);
    if (to > from) diagonal.push("M" + round1(sx(from)) + " " + round1(sy(from)) + "L" + round1(sx(to)) + " " + round1(sy(to)));
  }
  sync(frame.g.lines, "path", diagonal, (node, d) => {
    attrs(node, { d, class: "chart-diagonal" });
  });
  sync(frame.g.dots, "circle", placed, (node, dot) => {
    // r 5 with the 2 px surface ring leaves an 8 px dot of colour.
    attrs(node, { cx: round1(dot.x), cy: round1(dot.y), r: 5, class: "chart-dot chart-c" + dot.slot });
  });
  renderLegend(frame, kinds.map((kind, i) => ({ name: kind || "other", slot: (i % PALETTE_SIZE) + 1, shape: "dot" })), null);

  return {
    sx,
    box,
    count: points.length,
    stop(i) {
      const { point } = points[i];
      const rows = [
        { label: xa.label || "x", value: callFormat(xa.format, point.x) },
        { label: ya.label || "y", value: callFormat(ya.format, point.y) },
      ];
      if (kinds.length > 1 && point.kind) rows.push({ label: "", value: String(point.kind), slot: placed[i].slot });
      return { x: placed[i].x, y: placed[i].y, title: point.label === undefined || point.label === null ? "" : String(point.label), rows };
    },
    // The pointer only has to be closest to a dot, not on it.
    nearest(px, py) {
      let best = null;
      let bestDistance = 32 * 32;
      placed.forEach((dot, i) => {
        const distance = (dot.x - px) ** 2 + (dot.y - py) ** 2;
        if (distance < bestDistance) { best = i; bestDistance = distance; }
      });
      return best;
    },
    highlight(i) {
      sync(frame.g.hover, "circle", i === null ? [] : [placed[i]], (node, dot) => {
        attrs(node, { cx: round1(dot.x), cy: round1(dot.y), r: 8, class: "chart-ring" });
      });
    },
    pick: typeof o.onPick === "function" ? (i) => o.onPick(points[i].point, points[i].index) : null,
  };
}

// ---------------------------------------------------------------- histogram

function drawHistogram(frame, o) {
  const log = !!o.log;
  const groups = (Array.isArray(o.groups) ? o.groups : []).filter((group) => group && Array.isArray(group.values)).map((group, index) => ({
    name: group.name === undefined || group.name === null ? "group " + (index + 1) : String(group.name),
    values: group.values.filter(isNum),
    slot: (index % PALETTE_SIZE) + 1,
  }));
  const all = groups.flatMap((group) => group.values);
  const range = extent(log ? all.filter((v) => v > 0) : all);
  if (!all.length || !range) return null;
  const xa = o.x || {};
  const ya = o.y || {};
  const f = frame.fontPx;
  const edges = histogramEdges(isNum(xa.min) ? xa.min : range[0], isNum(xa.max) ? xa.max : range[1], { log, count: isNum(o.bins) ? o.bins : 12 });
  const binned = groups.map((group) => histogramBins(group.values, { edges }));
  const bins = binned[0].length;
  const top = Math.max(1, ...binned.flatMap((list) => list.map((bin) => bin.count)));

  const ySpec = axisSpec([0, top], { count: tickCount(frame.height - f * 5, f) });
  // Counts are whole numbers: a tick at 0.5 would be noise.
  ySpec.ticks = ySpec.ticks.filter(Number.isInteger);
  const yLabel = ya.label || "count";
  const yLabels = ySpec.ticks.map((tick) => callFormat(ya.format, tick));
  const marks = cleanMarks(o.marks);
  const domain = [edges[0], edges[edges.length - 1]];
  let box = plotBox(frame, yLabels, { xLabel: xa.label, yLabel });
  const makeX = () => (log ? logScale : linearScale)(domain, [box.left, box.right]);
  let sx = makeX();
  const markLayout = layoutMarks(marks, sx, frame);
  if (markLayout.rows) {
    box = plotBox(frame, yLabels, { xLabel: xa.label, yLabel, markRows: markLayout.rows });
    sx = makeX();
  }
  const sy = linearScale(ySpec.domain, [box.bottom, box.top]);

  const parts = newParts();
  addYAxis(parts, frame, box, sy, ySpec.ticks, ya.format, yLabel);
  const ticks = log ? logTicks(domain[0], domain[1]) : niceTicks(domain[0], domain[1], clamp(Math.floor((box.right - box.left) / (f * 7)), 2, 10));
  addXAxis(parts, frame, box, ticks.map((tick) => ({ px: sx(tick), text: callFormat(xa.format, tick) })), xa.label);
  addMarks(parts, frame, box, markLayout);
  flush(frame, parts, box);

  // Groups stand side by side inside a bin, separated by a 2 px gap of the surface.
  const shapes = [];
  for (let b = 0; b < bins; b += 1) {
    const x0 = sx(edges[b]) + 1;
    const x1 = sx(edges[b + 1]) - 1;
    const width = Math.max(1, (x1 - x0 - 2 * (groups.length - 1)) / groups.length);
    groups.forEach((group, g) => {
      const count = binned[g][b].count;
      if (count > 0) shapes.push({ d: barPath(x0 + g * (width + 2), width, sy(0), sy(count), 3), slot: group.slot, b });
    });
  }
  sync(frame.g.lines, "path", [], () => {});
  sync(frame.g.dots, "circle", [], () => {});
  sync(frame.g.bars, "path", shapes, (node, shape) => attrs(node, { d: shape.d, class: "chart-bar chart-c" + shape.slot }));
  sync(frame.g.band, "rect", [], () => {});
  renderLegend(frame, groups.map((group) => ({ name: group.name, slot: group.slot, shape: "rect" })), null);

  const binLabel = (b) => callFormat(xa.format, edges[b]) + " to " + callFormat(xa.format, edges[b + 1]);
  return {
    sx,
    box,
    count: bins,
    stop(b) {
      const rows = groups.map((group, g) => ({ label: group.name, value: String(binned[g][b].count), slot: group.slot }));
      return { x: (sx(edges[b]) + sx(edges[b + 1])) / 2, y: box.top + f, title: (xa.label ? xa.label + " " : "") + binLabel(b), rows };
    },
    nearest(px) {
      if (px < box.left || px > box.right) return null;
      for (let b = 0; b < bins; b += 1) if (px <= sx(edges[b + 1])) return b;
      return bins - 1;
    },
    highlight(b) {
      sync(frame.g.band, "rect", b === null ? [] : [b], (node) => {
        const x0 = sx(edges[b]);
        attrs(node, { x: round1(x0), y: box.top, width: round1(sx(edges[b + 1]) - x0), height: box.bottom - box.top, class: "chart-band" });
      });
      [...frame.g.bars.children].forEach((node, k) => node.classList.toggle("is-active", shapes[k].b === b));
    },
    pick: typeof o.onPick === "function"
      ? (b) => o.onPick({ x0: edges[b], x1: edges[b + 1], counts: groups.map((group, g) => ({ name: group.name, count: binned[g][b].count })) }, b)
      : null,
  };
}

// ---------------------------------------------------------------- public API

// lineChart(container, {series: [{name, color?, points: [[x, y|null]]}], x: {label, format, min?, max?},
//   y: {label, format, min?, max?, log?}, marks?: [{x, label, kind?}], cursor?: x, onPick?(x, {raw}),
//   step?: bool, height?: px, empty?: text}) -> {update(opts), destroy(), el}
export function lineChart(container, opts) {
  return createChart(container, "line", opts, drawLine);
}

// barChart(container, {bars: [{label, value, value2?}], y: {label, format}, y2?: {label, format},
//   x?: {label}, selected?: index, onPick?(bar, index), height?, empty?})
export function barChart(container, opts) {
  return createChart(container, "bar", opts, drawBars);
}

// scatterChart(container, {points: [{x, y, label, kind}], x, y, logX?, logY?, marks?, cursor?,
//   onPick?(point, index), diagonal?: bool (draw y = x), height?, empty?})
export function scatterChart(container, opts) {
  return createChart(container, "scatter", opts, drawScatter);
}

// histogram(container, {groups: [{name, values}], log?: bool, x: {label, format, min?, max?},
//   y?: {label, format}, bins?: n, marks?, cursor?, onPick?(bin, index), height?, empty?})
export function histogram(container, opts) {
  return createChart(container, "histogram", opts, drawHistogram);
}
