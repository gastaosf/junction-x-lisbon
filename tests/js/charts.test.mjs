// Scale, tick and binning maths of the charts. Run with `node --test tests/js`.
// The module is imported without a DOM: only its pure exports are exercised here.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DASHES, PALETTE_SIZE, axisSpec, barPath, extent, formatTick, histogramBins, histogramEdges,
  linePath, linearScale, logScale, logTicks, niceDomain, niceStep, niceTicks, seriesStyle, valueAt,
  lineChart, barChart, scatterChart, histogram,
} from "../../server/static/console/js/components/charts.js";

const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not ${expected}`);

test("the module loads without a DOM and exports the four charts", () => {
  for (const fn of [lineChart, barChart, scatterChart, histogram]) assert.equal(typeof fn, "function");
});

test("extent skips what is not a finite number", () => {
  assert.deepEqual(extent([3, null, NaN, -2, undefined, 7, Infinity]), [-2, 7]);
  assert.equal(extent([]), null);
  assert.equal(extent([null, NaN]), null);
});

test("linearScale maps, inverts and survives a zero-width domain", () => {
  const scale = linearScale([0, 10], [100, 200]);
  assert.equal(scale(0), 100);
  assert.equal(scale(5), 150);
  assert.equal(scale(10), 200);
  assert.equal(scale.invert(175), 7.5);
  assert.deepEqual(scale.domain, [0, 10]);
  // SVG y grows downwards: the range may be reversed.
  const flipped = linearScale([0, 1], [300, 20]);
  assert.equal(flipped(1), 20);
  assert.equal(flipped.invert(160), 0.5);
  // One value only: drawn in the middle, never NaN.
  assert.equal(linearScale([4, 4], [0, 100])(4), 50);
});

test("logScale is linear in decades and clamps what has no logarithm", () => {
  const scale = logScale([1, 1000], [0, 300]);
  close(scale(1), 0);
  close(scale(10), 100);
  close(scale(100), 200);
  close(scale(1000), 300);
  close(scale.invert(150), Math.sqrt(1000), 1e-6);
  assert.equal(scale(0), 0);
  assert.equal(scale(-5), 0);
  assert.throws(() => logScale([0, 10], [0, 1]), RangeError);
});

test("niceStep picks 1, 2 or 5 times a power of ten", () => {
  assert.equal(niceStep(100, 5), 20);
  assert.equal(niceStep(1, 5), 0.2);
  assert.equal(niceStep(7, 5), 2);
  assert.equal(niceStep(4000, 6), 1000);
  assert.equal(niceStep(0.03, 3), 0.01);
  assert.equal(niceStep(4200, 4), 1000);
  assert.equal(niceStep(0, 5), 1);
});

test("niceTicks returns round values inside the range without float dust", () => {
  assert.deepEqual(niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(niceTicks(0.13, 0.87, 4), [0.2, 0.4, 0.6, 0.8]);
  assert.deepEqual(niceTicks(-3, 3, 6), [-3, -2, -1, 0, 1, 2, 3]);
  assert.deepEqual(niceTicks(37, 412, 4), [100, 200, 300, 400]);
  // Reversed arguments and a single value are tolerated.
  assert.deepEqual(niceTicks(100, 0, 5), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(5, 5), [5]);
  assert.deepEqual(niceTicks(NaN, 5), []);
  for (const tick of niceTicks(0, 0.7, 7)) assert.ok(String(tick).length <= 4, `dusty tick ${tick}`);
});

test("niceDomain widens to the surrounding ticks", () => {
  assert.deepEqual(niceDomain(0, 0.9, 5), [0, 1]);
  assert.deepEqual(niceDomain(3, 97, 5), [0, 100]);
  assert.deepEqual(niceDomain(-12, 48, 5), [-20, 60]);
  assert.deepEqual(niceDomain(0, 100, 5), [0, 100]);
  assert.deepEqual(niceDomain(0, 0), [0, 1]);
  assert.deepEqual(niceDomain(5, 5), [0, 7.5]);
  assert.deepEqual(niceDomain(-4, -4), [-6, 0]);
});

test("logTicks sit on the decades", () => {
  assert.deepEqual(logTicks(1, 1000), [1, 10, 100, 1000]);
  assert.deepEqual(logTicks(0.001, 1), [0.001, 0.01, 0.1, 1]);
  assert.deepEqual(logTicks(3, 20000), [10, 100, 1000, 10000]);
  assert.deepEqual(logTicks(1000, 1), [1, 10, 100, 1000]);
});

test("logTicks add 2x and 5x steps when the range holds fewer than two decades", () => {
  assert.deepEqual(logTicks(10, 50), [10, 20, 50]);
  assert.deepEqual(logTicks(3, 40), [5, 10, 20]);
  assert.deepEqual(logTicks(0.2, 0.9), [0.2, 0.5]);
});

test("logTicks thin a very wide range and refuse a non-positive one", () => {
  const ticks = logTicks(1e-6, 1e12);
  assert.ok(ticks.length <= 10, `too many ticks: ${ticks.length}`);
  for (const tick of ticks) close(Math.log10(tick), Math.round(Math.log10(tick)));
  assert.deepEqual(logTicks(0, 100), []);
  assert.deepEqual(logTicks(-1, 100), []);
});

test("formatTick is short and compact from one thousand up", () => {
  assert.equal(formatTick(0), "0");
  assert.equal(formatTick(0.25), "0.25");
  assert.equal(formatTick(950), "950");
  assert.equal(formatTick(1500), "1.5K");
  assert.equal(formatTick(-8000), "-8K");
  assert.equal(formatTick(25000), "25K");
  assert.equal(formatTick(3200000), "3.2M");
  assert.equal(formatTick(NaN), "");
});

test("histogramEdges: round linear steps, decade-aligned log steps", () => {
  assert.deepEqual(histogramEdges(0, 10, { count: 5 }), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(histogramEdges(3, 3), [2.5, 3.5]);
  const log = histogramEdges(10, 1000, { log: true, count: 4 });
  assert.equal(log.length, 5);
  assert.equal(log[0], 10);
  assert.equal(log[2], 100);
  assert.equal(log[4], 1000);
  close(log[1], Math.sqrt(10) * 10, 1e-9);
  // One value: still one whole decade to draw.
  assert.deepEqual(histogramEdges(100, 100, { log: true, count: 1 }), [100, 1000]);
  assert.deepEqual(histogramEdges(NaN, 1), []);
});

test("histogramBins counts every value exactly once", () => {
  const bins = histogramBins([0, 1, 2, 2, 3, 9, 10], { count: 5 });
  assert.deepEqual(bins.map((bin) => [bin.x0, bin.x1]), [[0, 2], [2, 4], [4, 6], [6, 8], [8, 10]]);
  // 2 sits on an inner edge and belongs to the bin on its right; 10 closes the last bin.
  assert.deepEqual(bins.map((bin) => bin.count), [2, 3, 0, 0, 2]);
  assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), 7);
});

test("histogramBins on a log axis, with shared edges and out-of-range values", () => {
  const edges = histogramEdges(1, 1000, { log: true, count: 3 });
  assert.deepEqual(edges, [1, 10, 100, 1000]);
  const urban = histogramBins([5, 50, 50, 500, 0, 5000], { edges });
  // 0 has no logarithm and 5000 is above the last edge: both land in the nearest end bin.
  assert.deepEqual(urban.map((bin) => bin.count), [2, 2, 2]);
  const rural = histogramBins([20000], { edges });
  assert.deepEqual(rural.map((bin) => bin.count), [0, 0, 1]);
  // Without edges the log bins come from the positive values only.
  const own = histogramBins([0, 20, 300], { log: true, count: 2 });
  assert.equal(own[0].x0, 10);
  assert.equal(own[own.length - 1].x1, 1000);
  assert.equal(own.reduce((sum, bin) => sum + bin.count, 0), 3);
  assert.deepEqual(histogramBins([], { log: true }), []);
  assert.deepEqual(histogramBins([null, NaN]), []);
});

test("seriesStyle: colour alone up to four series, colour and dash beyond", () => {
  for (let i = 0; i < 4; i += 1) assert.deepEqual(seriesStyle(i, 4), { slot: i + 1, dash: "" });
  const styles = Array.from({ length: PALETTE_SIZE * DASHES.length }, (_, i) => seriesStyle(i, 30));
  const distinct = new Set(styles.map((style) => style.slot + "|" + style.dash));
  assert.equal(distinct.size, 30);
  for (const style of styles) assert.ok(style.slot >= 1 && style.slot <= PALETTE_SIZE);
  // The colour of a series does not depend on how many others there are.
  assert.equal(seriesStyle(2, 3).slot, seriesStyle(2, 9).slot);
});

test("valueAt interpolates lines, holds steps and respects gaps", () => {
  const points = [[0, 0], [10, 1], [20, null], [30, 4]];
  assert.equal(valueAt(points, 5), 0.5);
  assert.equal(valueAt(points, 10), 1);
  assert.equal(valueAt(points, 15), null);
  assert.equal(valueAt(points, 20), null);
  assert.equal(valueAt(points, -1), null);
  assert.equal(valueAt(points, 31), null);
  assert.equal(valueAt(points, 5, true), 0);
  assert.equal(valueAt(points, 15, true), 1);
  assert.equal(valueAt(points, 25, true), null);
  assert.equal(valueAt(points, 99, true), 4);
  assert.equal(valueAt([], 1), null);
});

test("linePath breaks at gaps and reports points that stand alone", () => {
  const sx = linearScale([0, 3], [0, 30]);
  const sy = linearScale([0, 1], [100, 0]);
  assert.deepEqual(linePath([[0, 0], [1, 1], [2, 0.5]], sx, sy), { d: "M0 100 L10 0 L20 50", dots: [] });
  assert.equal(linePath([[0, 0], [1, 1]], sx, sy, true).d, "M0 100 H10 V0");
  const gap = linePath([[0, 0], [1, null], [2, 1], [3, 1]], sx, sy);
  assert.equal(gap.d, "M0 100 M20 0 L30 0");
  assert.deepEqual(gap.dots, [[0, 100]]);
  assert.deepEqual(linePath([], sx, sy), { d: "", dots: [] });
});

test("barPath rounds the data end only and never past the bar", () => {
  assert.equal(barPath(10, 20, 100, 40, 4), "M10 100 V44 Q10 40 14 40 H26 Q30 40 30 44 V100 Z");
  // A negative value hangs below the baseline, rounded at the bottom.
  assert.equal(barPath(0, 10, 50, 80, 4), "M0 50 V76 Q0 80 4 80 H6 Q10 80 10 76 V50 Z");
  // Shorter than the radius: the corner shrinks instead of overshooting the baseline.
  assert.equal(barPath(0, 10, 50, 48, 4), "M0 50 V50 Q0 48 2 48 H8 Q10 48 10 50 V50 Z");
});

test("axisSpec: linear axes include zero, log axes span whole decades", () => {
  assert.deepEqual(axisSpec([0.2, 0.9], { count: 5 }), { domain: [0, 1], ticks: [0, 0.2, 0.4, 0.6, 0.8, 1], log: false });
  assert.deepEqual(axisSpec([12, 48], { count: 5, zero: false }).domain, [10, 50]);
  assert.deepEqual(axisSpec([0.3], { min: 0, max: 1, count: 2 }).domain, [0, 1]);
  assert.deepEqual(axisSpec([85, 1200, 40000], { log: true }), { domain: [10, 100000], ticks: [10, 100, 1000, 10000, 100000], log: true });
  // Nothing positive to show on a log axis: a harmless default instead of NaN.
  assert.deepEqual(axisSpec([0, -1], { log: true }).domain, [1, 10]);
  assert.deepEqual(axisSpec([], {}).domain, [0, 1]);
});

// ---------------------------------------------------------------- map helpers
// The pure half of components/map.js (coordinates, graticule, entry grouping). The Leaflet half
// needs a browser; these are the parts whose mistakes would be silent.

const geo = await import("../../server/static/console/js/components/map.js");

test("map.js loads without a DOM or Leaflet", () => {
  assert.equal(typeof geo.createMap, "function");
});

test("normalizeLng wraps into [-180, 180] and normalizePoint rounds to 6 decimals", () => {
  assert.equal(geo.normalizeLng(-9.1399), -9.1399);
  assert.equal(geo.normalizeLng(180), 180);
  assert.equal(geo.normalizeLng(-180), -180);
  close(geo.normalizeLng(190), -170);
  close(geo.normalizeLng(350.8601), -9.1399);
  close(geo.normalizeLng(-369.1399), -9.1399);
  close(geo.normalizeLng(725), 5);
  // A pin dropped on a repeated copy of the world is the same place.
  assert.deepEqual(geo.normalizePoint({ lat: 38.71690049, lng: 350.86010051 }), { lat: 38.7169, lng: -9.139899 });
  assert.deepEqual(geo.normalizePoint({ lat: 91, lng: -181 }), { lat: 90, lng: 179 });
});

test("hypothesisRadius makes the marker AREA proportional to the probability", () => {
  const area = (p) => Math.PI * geo.hypothesisRadius(p) ** 2;
  close(area(0.8) / area(0.2), 4, 1e-9);
  close(area(1) / area(0.25), 4, 1e-9);
  assert.equal(geo.hypothesisRadius(1), geo.HYPOTHESIS_MAX_RADIUS);
  // Tiny, missing or out-of-range probabilities still give a marker that can be seen.
  assert.equal(geo.hypothesisRadius(0), geo.HYPOTHESIS_MIN_RADIUS);
  assert.equal(geo.hypothesisRadius(undefined), geo.HYPOTHESIS_MIN_RADIUS);
  assert.equal(geo.hypothesisRadius(7), geo.HYPOTHESIS_MAX_RADIUS);
});

test("haversineM", () => {
  const lisbon = { lat: 38.7169, lng: -9.1399 };
  const porto = { lat: 41.1496, lng: -8.611 };
  assert.equal(geo.haversineM(lisbon, lisbon), 0);
  close(geo.haversineM(lisbon, porto), 274300, 1500);
  close(geo.haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 180 }), Math.PI * 6371008.8, 1);
});

test("groupEntries collapses identical points and names their ranks", () => {
  const same = Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, lat: 38.7169, lng: -9.1399 }));
  assert.deepEqual(geo.groupEntries(same).map((g) => g.label), ["1\u201310"]);
  const hedged = [
    { rank: 1, lat: 1, lng: 1 }, { rank: 2, lat: 1, lng: 1 }, { rank: 3, lat: 2, lng: 2 },
    { rank: 4, lat: 1, lng: 1 }, { rank: 5, lat: 3, lng: 3 }, { rank: 6, lat: 2, lng: 2 }, { rank: 7, lat: 2, lng: 2 },
  ];
  assert.deepEqual(geo.groupEntries(hedged).map((g) => [g.lat, g.label]), [[1, "1\u20132, 4"], [2, "3, 6\u20137"], [3, "5"]]);
  // No rank given: the position in the list. Broken rows are skipped.
  assert.deepEqual(geo.groupEntries([{ lat: 5, lng: 5 }, null, { lat: NaN, lng: 1 }, { lat: 5, lng: 5 }])[0].ranks, [1, 4]);
  assert.deepEqual(geo.groupEntries(null), []);
  assert.equal(geo.rankRanges([3, 1, 2, 2, 9]), "1\u20133, 9");
});

test("mercator projection round-trips and matches the tile grid", () => {
  assert.equal(geo.mercatorX(-180, 0), 0);
  assert.equal(geo.mercatorX(180, 0), 256);
  close(geo.mercatorY(0, 0), 128);
  close(geo.mercatorY(85.0511287798, 0), 0, 1e-6);
  for (const [lat, lng, zoom] of [[38.7169, -9.1399, 12], [-33.86, 151.21, 5], [64.1, -21.9, 17]]) {
    close(geo.latFromY(geo.mercatorY(lat, zoom), zoom), lat, 1e-9);
    close(geo.lngFromX(geo.mercatorX(lng, zoom), zoom), lng, 1e-9);
  }
});

test("gridStep gets finer with zoom and stays on round steps", () => {
  assert.equal(geo.gridStep(1), 90);
  assert.equal(geo.gridStep(4), 10);
  assert.equal(geo.gridStep(12), 0.05);
  assert.equal(geo.gridStep(19), 0.0005);
  for (let zoom = 1; zoom < 19; zoom += 1) assert.ok(geo.gridStep(zoom + 1) <= geo.gridStep(zoom));
});

test("formatDegrees labels with hemisphere letters at the precision of the step", () => {
  assert.equal(geo.formatDegrees(38.7, 0.1, "lat"), "38.7\u00b0N");
  assert.equal(geo.formatDegrees(-9.15, 0.05, "lng"), "9.15\u00b0W");
  assert.equal(geo.formatDegrees(-30, 10, "lat"), "30\u00b0S");
  assert.equal(geo.formatDegrees(0, 10, "lat"), "0\u00b0");
  assert.equal(geo.formatDegrees(190, 10, "lng"), "170\u00b0W");
  assert.equal(geo.formatDegrees(-9.1395, 0.0005, "lng"), "9.1395\u00b0W");
});

test("gridTileLines: the graticule lines crossing one tile, in tile pixels", () => {
  // Zoom 2, tile (1, 1): longitudes -90..0, latitudes 66.5..0, step 45 degrees.
  const { step, lines } = geo.gridTileLines({ x: 1, y: 1, z: 2 });
  assert.equal(step, 45);
  const meridians = lines.filter((line) => line.axis === "lng");
  assert.deepEqual(meridians.map((line) => line.value), [-90, -45, 0]);
  close(meridians[0].px, 0);
  close(meridians[1].px, 128);
  close(meridians[2].px, 256);
  const parallels = lines.filter((line) => line.axis === "lat");
  assert.deepEqual(parallels.map((line) => line.value), [0, 45]);
  close(parallels[0].px, 256);
  assert.ok(parallels[1].px > 0 && parallels[1].px < 128, "45N is above the middle of the tile on Mercator");
  // Every line of a street-level tile lies inside it, and there are only a few of them.
  const z = 15;
  const tile = { x: Math.floor(geo.mercatorX(-9.1399, z) / 256), y: Math.floor(geo.mercatorY(38.7169, z) / 256), z };
  const near = geo.gridTileLines(tile);
  assert.ok(near.lines.length >= 1 && near.lines.length <= 8, `${near.lines.length} lines`);
  for (const line of near.lines) assert.ok(line.px >= -1e-6 && line.px <= 256 + 1e-6);
});

test("fitSignature only changes when a point moves by about a metre or more", () => {
  const a = [{ lat: 38.7169, lng: -9.1399 }, { lat: 40, lng: -8 }];
  assert.equal(geo.fitSignature(a), geo.fitSignature(a.map((p) => ({ ...p, probability: 0.3 }))));
  assert.equal(geo.fitSignature(a), geo.fitSignature([{ lat: 38.716900001, lng: -9.1399 }, a[1], null, { lat: NaN, lng: 0 }]));
  assert.notEqual(geo.fitSignature(a), geo.fitSignature([{ lat: 38.7179, lng: -9.1399 }, a[1]]));
  assert.equal(geo.fitSignature([]), "");
});
