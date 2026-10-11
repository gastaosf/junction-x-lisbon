import test from "node:test";
import assert from "node:assert/strict";

import {
  ALLOCATIONS,
  BANDS,
  DELTA_SORTS,
  GROUPS,
  METRICS,
  bandCounts,
  bandInfo,
  bandOf,
  canReuseKey,
  compareRows,
  configLines,
  configSummary,
  costScorePoints,
  defaultEffortText,
  defaultTag,
  deltaVerdict,
  deltaWinner,
  distanceGroups,
  evalRuns,
  fmtDelta,
  fmtMetric,
  fmtScore,
  fmtTheta,
  focusView,
  formatRef,
  groupLabel,
  groupRows,
  groupSummary,
  initialRunForm,
  isDemo,
  labelBadge,
  latestWithResults,
  launchState,
  mapLines,
  mapMarkers,
  mean,
  median,
  mergeRows,
  metricInfo,
  nextSort,
  originBadge,
  overlayLive,
  pairedView,
  parseRef,
  pastEstimate,
  readRescoreForm,
  readRunForm,
  resultRefs,
  runListView,
  scatterPoints,
  scoreDomain,
  shareOf,
  sortDeltas,
  sortRows,
  summariseRows,
  toggleTool,
  toolSwitches,
  truthVisible,
  variantRows,
  variantText,
} from "../../server/static/console/js/logic/evalstats.js";

// One PanoScore of results.json, as eval/run_eval.py `asdict(PanoScore)` writes it.
function score(id, label, rank1, points, extra = {}) {
  return {
    panorama_id: id, label, special: false, score: points, max_score: 16050,
    rank1_distance_m: rank1, best_distance_m: rank1, multiplier: 1.0, origin: "agent", plan: "10x1",
    n_hypotheses: 3, cost_usd: 0.5, time_s: 300, turns: 12, ...extra,
  };
}

const PANORAMAS = [
  score("eval_a", "Urban", 40, 16000),
  score("eval_b", "Urban", 900, 9000, { cost_usd: 1.5, time_s: 500 }),
  score("eval_c", "non-Urban", 7000, 12000, { cost_usd: null }),
  score("eval_d", "non-Urban", 250000, 300, { origin: "harness_fallback", time_s: null }),
  score("eval_e", "Urban", null, 0, { best_distance_m: null, origin: "none", max_score: 16050 }),
];

// GET /api/eval/runs/<id>/truth, as server/evalops.py `truth` writes it.
const TRUTH = {
  run_id: "r1",
  tag: "",
  panoramas: {
    eval_a: {
      lat: 38.7, lng: -9.14, label: "Urban", rank1_distance_m: 40, score: 16000, max_score: 16050, share: 0.99, band: "100m",
      entries: [
        { rank: 1, lat: 38.7003, lng: -9.14, distance_m: 40, theta: 1.98 },
        { rank: 2, lat: 38.7003, lng: -9.14, distance_m: 40, theta: 1.98 },
        { rank: 3, lat: 38.8, lng: -9.2, distance_m: 12000, theta: 0.1 },
      ],
      top_distance_series: [],
    },
    eval_d: {
      lat: 40.0, lng: -7.0, label: "non-Urban", rank1_distance_m: 250000, score: 300, max_score: 16050, share: 0.02, band: "far",
      entries: [{ rank: 1, lat: 42.0, lng: -8.0, distance_m: 250000, theta: 0.02 }],
      top_distance_series: [],
    },
  },
};

const TILES = [
  { panorama_id: "eval_a", stop_reason: "submit_locations", stop_text: "the agent submitted its answer" },
  { panorama_id: "eval_d", stop_reason: "hard_deadline", stop_text: "hard deadline: best-so-far list used" },
];

test("bands follow the thresholds of the results table, and no answer is the farthest", () => {
  assert.deepEqual(BANDS.map((band) => band.key), ["100m", "1km", "10km", "far"]);
  assert.equal(bandOf(0), "100m");
  assert.equal(bandOf(100), "100m");
  assert.equal(bandOf(100.1), "1km");
  assert.equal(bandOf(1000), "1km");
  assert.equal(bandOf(10000), "10km");
  assert.equal(bandOf(10000.5), "far");
  assert.equal(bandOf(null), "far");
  assert.equal(bandOf(undefined), "far");
  assert.equal(bandOf(NaN), "far");
  assert.equal(bandInfo("1km").kind, "info");
  assert.equal(bandInfo("nonsense").key, "far");
  // every band has words and an icon: never colour alone
  for (const band of BANDS) assert.ok(band.label && band.short && band.icon && band.kind);
});

test("mean, median and share ignore what is not a number", () => {
  assert.equal(mean([1, 2, 3, null, undefined, NaN]), 2);
  assert.equal(mean([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null]), null);
  assert.equal(median([10, 9, 100]), 10); // numeric, not lexical
  assert.equal(shareOf(1, 4), 0.25);
  assert.equal(shareOf(0, 0), null);
  assert.equal(shareOf(null, 3), null);
});

test("summariseRows computes what summarise_group does, plus the mean rank-1 distance", () => {
  const all = summariseRows(PANORAMAS);
  assert.equal(all.n, 5);
  assert.equal(all.total_score, 37300);
  assert.equal(all.mean_score, 7460);
  assert.equal(all.score_share_of_max, 37300 / (5 * 16050));
  // the panorama without an answer has no distance, but counts as a miss in every share
  assert.equal(all.median_rank1_distance_m, (900 + 7000) / 2);
  assert.equal(all.mean_rank1_distance_m, (40 + 900 + 7000 + 250000) / 4);
  assert.equal(all.within_100m, 1 / 5);
  assert.equal(all.within_1km, 2 / 5);
  assert.equal(all.within_10km, 3 / 5);
  assert.equal(all.total_cost_usd, 0.5 + 1.5 + 0.5 + 0.5);
  assert.equal(all.mean_cost_usd, 3 / 4);
  assert.equal(all.mean_time_s, (300 + 500 + 300 + 300) / 4);
  assert.equal(all.median_time_s, 300);

  const empty = summariseRows([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.mean_score, null);
  assert.equal(empty.score_share_of_max, null);
  assert.equal(empty.within_100m, null);
  assert.equal(empty.total_cost_usd, null);
});

test("groupRows and groupSummary split by label, and the server's numbers win", () => {
  assert.deepEqual(GROUPS, ["all", "Urban", "non-Urban"]);
  assert.equal(groupLabel("all"), "All");
  assert.equal(groupLabel("non-Urban"), "non-Urban");
  assert.equal(groupRows(PANORAMAS, "Urban").length, 3);
  assert.equal(groupRows(PANORAMAS, "non-Urban").length, 2);
  assert.equal(groupRows(PANORAMAS, "all").length, 5);

  const results = { panoramas: PANORAMAS, summary: { all: { n: 5, mean_score: 7460.4, median_rank1_distance_m: 3950 }, Urban: null } };
  const all = groupSummary(results, "all");
  assert.equal(all.mean_score, 7460.4); // as stored
  assert.equal(all.mean_rank1_distance_m, (40 + 900 + 7000 + 250000) / 4); // not stored: computed
  const urban = groupSummary(results, "Urban"); // no stored summary: all computed
  assert.equal(urban.n, 3);
  assert.equal(urban.within_100m, 1 / 3);
  // a results file without rows still shows its stored summary
  assert.equal(groupSummary({ summary: { all: { n: 40, mean_score: 9000 } } }, "all").n, 40);
  assert.equal(groupSummary(null, "all").n, 0);
});

test("metrics are named, typed and formatted in their own unit", () => {
  assert.ok(METRICS.some((metric) => metric.key === "mean_rank1_distance_m"));
  assert.equal(metricInfo("within_1km").label, "Within 1 km");
  assert.deepEqual(metricInfo("made_up_metric"), { key: "made_up_metric", label: "made up metric", short: "made up metric", type: "number", better: null });
  assert.equal(metricInfo("median_rank1_distance_m").short, "Median rank-1");
  for (const metric of METRICS) assert.ok(metric.label && metric.short, metric.key);
  assert.equal(fmtMetric("int", 40), "40");
  assert.equal(fmtMetric("score", 16050.52), "16,051");
  assert.equal(fmtMetric("share", 0.3741), "37.4%");
  assert.equal(fmtMetric("dist", 1234), "1.2 km");
  assert.equal(fmtMetric("usd", 0.617718), "$0.62");
  assert.equal(fmtMetric("time", 378.9), "6 min 19 s");
  assert.equal(fmtMetric("number", 3.14159), "3.14");
  assert.equal(fmtMetric("share", null), "–");
  assert.equal(fmtScore(null), "–");
  assert.equal(fmtScore(16050.5), "16,051");
  assert.equal(fmtTheta(1.98765), "1.99");
  assert.equal(fmtTheta(undefined), "–");
});

test("a delta is signed, in the unit of its metric, and a share changes in points", () => {
  assert.equal(fmtDelta("score", 1204.4), "+1,204");
  assert.equal(fmtDelta("score", -1204.4), "-1,204");
  assert.equal(fmtDelta("score", 0.25), "+0.25"); // never "+0" for a real change
  assert.equal(fmtDelta("score", -0.004), "-<0.01"); // nor "+0.00"
  assert.equal(fmtDelta("score", 0), "0");
  assert.equal(fmtDelta("score", 1e-12), "0");
  assert.equal(fmtDelta("share", 0.042), "+4.2 pts");
  assert.equal(fmtDelta("share", -0.5), "-50.0 pts");
  assert.equal(fmtDelta("dist", -120), "-120 m");
  assert.equal(fmtDelta("dist", 2500), "+2.5 km");
  assert.equal(fmtDelta("usd", -0.12), "-$0.12");
  assert.equal(fmtDelta("time", 42), "+42 s");
  assert.equal(fmtDelta("int", -2), "-2");
  assert.equal(fmtDelta("share", null), "–");
});

test("deltaVerdict knows which way is better for each metric", () => {
  assert.equal(deltaVerdict("higher", 5), "better");
  assert.equal(deltaVerdict("higher", -5), "worse");
  assert.equal(deltaVerdict("lower", -5), "better"); // a shorter distance, a lower cost
  assert.equal(deltaVerdict("lower", 5), "worse");
  assert.equal(deltaVerdict("higher", 0), "same");
  assert.equal(deltaVerdict(null, 5), null); // the number of panoramas is neither
  assert.equal(deltaVerdict("higher", null), null);
});

test("mergeRows joins the score, the truth and how the panorama ended", () => {
  const rows = mergeRows({ panoramas: PANORAMAS }, TRUTH, TILES);
  assert.equal(rows.length, 5);
  const a = rows[0];
  assert.equal(a.panorama_id, "eval_a");
  assert.equal(a.share, 16000 / 16050);
  assert.equal(a.theta, 1.98);
  assert.equal(a.band, "100m");
  assert.deepEqual(a.truth, { lat: 38.7, lng: -9.14 });
  assert.deepEqual(a.answer, { lat: 38.7003, lng: -9.14 });
  assert.equal(a.entries.length, 3);
  assert.equal(a.distinct, 2);
  assert.equal(a.stop_text, "the agent submitted its answer");

  // no truth document for this one: the band comes from its own distance, the rest is null
  const b = rows[1];
  assert.equal(b.band, "1km");
  assert.equal(b.theta, null);
  assert.equal(b.truth, null);
  assert.equal(b.answer, null);
  assert.equal(b.stop_reason, null);

  const e = rows[4];
  assert.equal(e.rank1_distance_m, null);
  assert.equal(e.band, "far");
  assert.equal(e.share, 0);

  // every source may be missing
  assert.deepEqual(mergeRows(null, null, null), []);
  const bare = mergeRows({ panoramas: PANORAMAS }, null, null);
  assert.equal(bare[3].band, "far");
  assert.equal(bare[0].entries.length, 0);
});

test("mergeRows drops an entry that is not a point on the globe", () => {
  const truth = { panoramas: { eval_a: { lat: 38.7, lng: -9.14, entries: [{ rank: 1, lat: "38.7", lng: -9.14 }, { rank: 2, lat: 95, lng: 0 }] } } };
  const row = mergeRows({ panoramas: [PANORAMAS[0]] }, truth, [])[0];
  assert.equal(row.entries.length, 0);
  assert.equal(row.answer, null);
});

test("sortRows sorts numbers as numbers, keeps missing values last and breaks ties by id", () => {
  const rows = mergeRows({ panoramas: PANORAMAS }, TRUTH, TILES);
  const ids = (list) => list.map((row) => row.panorama_id);
  assert.deepEqual(ids(sortRows(rows, { key: null, dir: "asc" })), ["eval_a", "eval_b", "eval_c", "eval_d", "eval_e"]);
  assert.deepEqual(ids(sortRows(rows, { key: "rank1_distance_m", dir: "asc" })), ["eval_a", "eval_b", "eval_c", "eval_d", "eval_e"]);
  // descending: the panorama without a distance still goes last
  assert.deepEqual(ids(sortRows(rows, { key: "rank1_distance_m", dir: "desc" })), ["eval_d", "eval_c", "eval_b", "eval_a", "eval_e"]);
  assert.deepEqual(ids(sortRows(rows, { key: "score", dir: "desc" })), ["eval_a", "eval_c", "eval_b", "eval_d", "eval_e"]);
  assert.deepEqual(ids(sortRows(rows, { key: "label", dir: "asc" })), ["eval_a", "eval_b", "eval_e", "eval_c", "eval_d"]);
  assert.deepEqual(ids(sortRows(rows, { key: "cost_usd", dir: "desc" })), ["eval_b", "eval_a", "eval_d", "eval_e", "eval_c"]);
  assert.deepEqual(ids(sortRows(rows, { key: "stop", dir: "asc" })).slice(0, 2), ["eval_d", "eval_a"]);
  assert.deepEqual(ids(sortRows(rows, { key: "no_such_column", dir: "asc" })), ids(rows));
  // the input is not reordered
  sortRows(rows, { key: "score", dir: "asc" });
  assert.equal(rows[0].panorama_id, "eval_a");
});

test("nextSort cycles ascending, descending, off", () => {
  let sort = { key: null, dir: "asc" };
  sort = nextSort(sort, "score");
  assert.deepEqual(sort, { key: "score", dir: "asc" });
  sort = nextSort(sort, "score");
  assert.deepEqual(sort, { key: "score", dir: "desc" });
  sort = nextSort(sort, "score");
  assert.deepEqual(sort, { key: null, dir: "asc" });
  assert.deepEqual(nextSort({ key: "score", dir: "desc" }, "theta"), { key: "theta", dir: "asc" });
});

test("mapLines and mapMarkers draw every panorama that has both ends, except the selected one", () => {
  const rows = mergeRows({ panoramas: PANORAMAS }, TRUTH, TILES);
  const lines = mapLines(rows);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].from, { lat: 38.7, lng: -9.14 });
  assert.deepEqual(lines[0].to, { lat: 38.7003, lng: -9.14 });
  assert.equal(lines[0].band, "100m");
  assert.equal(lines[1].band, "far");
  assert.ok(lines[1].label.includes("eval_d") && lines[1].label.includes("250 km"));

  const markers = mapMarkers(rows);
  assert.equal(markers.length, 4);
  assert.deepEqual(markers.map((m) => m.kind), ["truth", "answer", "truth", "answer"]);
  assert.ok(markers.every((m) => m.pid && m.permanent === false));

  assert.equal(mapLines(rows, "eval_a").length, 1);
  assert.deepEqual(mapMarkers(rows, "eval_a").map((m) => m.pid), ["eval_d", "eval_d"]);
});

test("bandCounts counts the rows of each band", () => {
  const rows = mergeRows({ panoramas: PANORAMAS }, TRUTH, TILES);
  assert.deepEqual(bandCounts(rows).map((band) => [band.key, band.n]), [["100m", 1], ["1km", 1], ["10km", 1], ["far", 2]]);
  assert.deepEqual(bandCounts([]).map((band) => band.n), [0, 0, 0, 0]);
});

test("focusView puts both points in view and zooms out as they move apart", () => {
  const lisbon = { lat: 38.72, lng: -9.14 };
  const near = focusView(lisbon, { lat: 38.7203, lng: -9.14 }, 600);
  const porto = focusView(lisbon, { lat: 41.15, lng: -8.61 }, 600);
  const tokyo = focusView(lisbon, { lat: 35.68, lng: 139.69 }, 600);
  assert.ok(near.zoom > porto.zoom && porto.zoom > tokyo.zoom, JSON.stringify([near, porto, tokyo]));
  assert.ok(near.zoom <= 16 && tokyo.zoom >= 2);
  assert.ok(Math.abs(porto.lat - (38.72 + 41.15) / 2) < 1e-9);
  // the same spot, or one point alone: street level on that point
  assert.deepEqual(focusView(lisbon, lisbon), { lat: 38.72, lng: -9.14, zoom: 16 });
  assert.deepEqual(focusView(lisbon, null), { lat: 38.72, lng: -9.14, zoom: 16 });
  assert.deepEqual(focusView(null, lisbon), { lat: 38.72, lng: -9.14, zoom: 16 });
  assert.equal(focusView(null, null), null);
  // across the date line the middle is on the date line, not in the Atlantic
  const pacific = focusView({ lat: 0, lng: 179 }, { lat: 0, lng: -179 });
  assert.ok(Math.abs(Math.abs(pacific.lng) - 180) < 1e-9, String(pacific.lng));
  // a wider map shows the same pair at the same or a closer zoom
  assert.ok(focusView(lisbon, { lat: 41.15, lng: -8.61 }, 1600).zoom >= porto.zoom);
});

test("distanceGroups keeps both labels and lifts zero to 1 m for the log axis", () => {
  const rows = mergeRows({ panoramas: [...PANORAMAS, score("eval_z", "Urban", 0, 16050)] }, null, null);
  const groups = distanceGroups(rows);
  assert.deepEqual(groups.map((group) => group.name), ["Urban", "non-Urban"]);
  assert.deepEqual(groups[0].values, [40, 900, 1]);
  assert.deepEqual(groups[1].values, [7000, 250000]);
  assert.deepEqual(distanceGroups([]).map((group) => group.values), [[], []]);
});

test("costScorePoints needs both a cost and a score", () => {
  const rows = mergeRows({ panoramas: PANORAMAS }, null, null);
  const points = costScorePoints(rows);
  assert.equal(points.length, 4); // eval_c has no cost
  assert.deepEqual(points[1], { x: 1.5, y: 9000, label: "eval_b", kind: "Urban", pid: "eval_b" });
  // Urban first whatever the order of the rows, so the labels keep their colours
  assert.deepEqual(costScorePoints(rows.slice().reverse()).map((point) => point.kind), ["Urban", "Urban", "Urban", "non-Urban"]);
});

test("badges for labels and origins carry words, and no penalty colour", () => {
  assert.deepEqual(labelBadge("Urban"), { text: "Urban", kind: "urban", icon: null });
  assert.equal(labelBadge("non-Urban").kind, "nonurban");
  assert.equal(labelBadge(null).text, "no label");
  assert.equal(originBadge("agent").text, "agent");
  assert.equal(originBadge("harness_fallback").kind, "warn");
  assert.equal(originBadge("none").text, "no answer");
  assert.equal(originBadge("").text, "no answer");
  assert.equal(originBadge("something_new").text, "something new");
  for (const origin of ["agent", "harness_fallback", "human_geocode", "none", "x"]) {
    assert.notEqual(originBadge(origin).kind, "penalty");
  }
});

test("isDemo is true when any source says the demo model answered", () => {
  assert.equal(isDemo({ fake_model: false }, null, undefined), false);
  assert.equal(isDemo({ fake_model: false }, { fake_model: true }), true);
  assert.equal(isDemo(), false);
});

test("variantText and the config lines say what a result file is", () => {
  assert.equal(variantText({ mode: "run", hedge: false }), "as the run answered");
  assert.equal(variantText({ mode: "rescore", reallocated: false }), "same answers, scored again");
  assert.equal(variantText({ mode: "rescore", reallocated: true, hedge: true, allow_duplicates: true }), "re-allocated: hedge on, duplicates allowed");
  assert.equal(variantText({ mode: "rescore", reallocated: true, hedge: false, allow_duplicates: false }), "re-allocated: hedge off, distinct points only");
  assert.equal(variantText(null), "as the run answered");

  const run = { mode: "run", model: "gpt-x", effort: { standard: "high", special: "xhigh" }, hedge: false, allow_duplicates: true, allow_web: true, tools_off: ["satellite_tile"], manifest: "/x/manifest.json", panoramas: 40 };
  const lines = Object.fromEntries(configLines(run));
  assert.equal(lines.Model, "gpt-x");
  assert.equal(lines.Effort, "high (Special One: xhigh)");
  assert.equal(lines.Hedge, "off");
  assert.equal(lines.Web, "on");
  assert.equal(lines["Tools switched off"], "satellite_tile");
  assert.equal(lines.Panoramas, "40");
  assert.equal(configSummary(run), "gpt-x, effort high, hedge off, web on, 1 tool off");
  assert.equal(Object.fromEntries(configLines({ mode: "rescore", reallocated: true, hedge: true, allow_duplicates: true })).Allocation, "re-allocated: hedge on, duplicates allowed");
  assert.equal(configSummary({}), "configuration not recorded");
  assert.equal(Object.fromEntries(configLines(null)).Model, "–");
});

test("defaultTag derives the name the server would", () => {
  assert.equal(defaultTag({ hedge: null, duplicates: true }), "rescore");
  assert.equal(defaultTag({ hedge: true, duplicates: true }), "hedge");
  assert.equal(defaultTag({ hedge: false, duplicates: true }), "nohedge");
  assert.equal(defaultTag({ hedge: true, duplicates: false }), "hedge-distinct");
  assert.equal(defaultTag({ hedge: false, duplicates: false }), "nohedge-distinct");
});

test("readRescoreForm builds the rescore body and checks the tag", () => {
  assert.deepEqual(ALLOCATIONS.map((choice) => choice.value), ["hedge", "nohedge", "keep"]);
  assert.deepEqual(readRescoreForm({ allocation: "hedge", distinct: false, tag: "" }),
    { body: { hedge: true, duplicates: true }, tag: "hedge", error: null });
  assert.deepEqual(readRescoreForm({ allocation: "nohedge", distinct: true, tag: " " }),
    { body: { hedge: false, duplicates: false }, tag: "nohedge-distinct", error: null });
  // keeping the answers cannot ask for distinct points: that would be a re-allocation
  assert.deepEqual(readRescoreForm({ allocation: "keep", distinct: true, tag: "" }),
    { body: { hedge: null, duplicates: true }, tag: "rescore", error: null });
  assert.deepEqual(readRescoreForm({ allocation: "hedge", distinct: false, tag: "try_2" }),
    { body: { hedge: true, duplicates: true, tag: "try_2" }, tag: "try_2", error: null });
  for (const bad of ["Hedge", "a b", "../x", "x".repeat(33), "é"]) {
    const read = readRescoreForm({ allocation: "hedge", distinct: false, tag: bad });
    assert.ok(read.error, bad);
    assert.equal(read.body.tag, undefined);
  }
});

test("variantRows lists the original first and each variant against it", () => {
  const summary = (share, meanScore, median) => ({ all: { n: 5, mean_score: meanScore, score_share_of_max: share, median_rank1_distance_m: median } });
  const payload = {
    run_id: "r1", tag: "", config: { mode: "run", hedge: false },
    results: { summary: summary(0.4, 6400, 900) },
    variants: [
      { tag: "hedge", summary: summary(0.45, 7200, 800), config: { mode: "rescore", reallocated: true, hedge: true, allow_duplicates: true } },
      { tag: "rescore", summary: summary(0.4, 6400, 900), config: { mode: "rescore", reallocated: false } },
    ],
  };
  const rows = variantRows(payload, "");
  assert.deepEqual(rows.map((row) => row.label), ["Original", "hedge", "rescore"]);
  assert.equal(rows[0].current, true);
  assert.equal(rows[0].share_delta, null);
  assert.ok(Math.abs(rows[1].share_delta - 0.05) < 1e-12);
  assert.equal(rows[2].share_delta, 0);
  assert.equal(rows[1].text, "re-allocated: hedge on, duplicates allowed");

  // looking at a variant: the original's own summary is not in the payload
  const viewing = variantRows({ ...payload, tag: "hedge", results: { summary: summary(0.45, 7200, 800) } }, "hedge");
  assert.equal(viewing[0].score_share, null);
  assert.equal(viewing[1].current, true);
  assert.equal(viewing[1].share_delta, null);
  assert.deepEqual(variantRows(null), []);
});

test("parseRef and formatRef round-trip run[:tag] and refuse what is not a name", () => {
  assert.deepEqual(parseRef("20261010T174153Z"), { run_id: "20261010T174153Z", tag: "" });
  assert.deepEqual(parseRef("run-1:hedge"), { run_id: "run-1", tag: "hedge" });
  assert.equal(formatRef("run-1", "hedge"), "run-1:hedge");
  assert.equal(formatRef("run-1", ""), "run-1");
  assert.equal(formatRef("run-1"), "run-1");
  for (const bad of ["", ":hedge", "run:", "run:Hedge", "../x", "a..b", "run:a:b", "a/b", null]) {
    if (bad === "run:") assert.deepEqual(parseRef(bad), { run_id: "run", tag: "" });
    else assert.equal(parseRef(bad), null, String(bad));
  }
});

// RunRows of GET /api/runs, as server/workspace.py writes them.
function runRow(id, extra = {}) {
  return {
    run_id: id, kind: "eval", mode: "autonomous", state: "finished", active: false, no_human: true, fake_model: false,
    model: "gpt-x", effort: { standard: "high", special: "xhigh" }, created_at: "2026-10-10T17:41:53.955Z", wall_time_s: 378.8,
    totals: { done: 5, total: 5, spend_usd: 3.1 },
    results: { score_share: 0.41, median_rank1_m: 950, variants: [] },
    ...extra,
  };
}

test("evalRuns, truthVisible and resultRefs keep to evaluation runs that may show a score", () => {
  const rows = [
    runRow("r3", { state: "running", active: true, results: null }),
    runRow("r2", { results: { score_share: 0.5, median_rank1_m: 100, variants: ["hedge", "Bad Tag"] }, fake_model: true }),
    { ...runRow("s1"), kind: "scoring" },
    runRow("r1"),
    runRow("r0", { no_human: false }),
  ];
  assert.deepEqual(evalRuns(rows).map((row) => row.run_id), ["r3", "r2", "r1", "r0"]);
  assert.equal(truthVisible(rows[1]), true);
  assert.equal(truthVisible(rows[2]), false);
  assert.equal(truthVisible(rows[4]), false);
  assert.equal(truthVisible({ ...rows[3], mode: "assisted" }), false);
  assert.equal(truthVisible(null), false);
  assert.deepEqual(resultRefs(rows).map((item) => item.ref), ["r2", "r2:hedge", "r1"]);
  assert.equal(resultRefs(rows)[0].label, "r2 (demo)");
  assert.equal(resultRefs(rows)[1].label, "r2 : hedge (demo)");
  assert.equal(resultRefs(rows)[2].fake, false);
  assert.equal(latestWithResults(rows).run_id, "r2");
  assert.equal(latestWithResults([rows[0]]), null);
  assert.deepEqual(resultRefs(null), []);
});

test("overlayLive puts what the stream knows over the index row", () => {
  const rows = [runRow("r3", { state: "queued", active: true, results: null, totals: { done: 0, total: 5 } }), runRow("r1")];
  const live = new Map([["r3", { state: "running", active: true, totals: { done: 2, total: 5, spend_usd: 1.2 }, results: null, fake_model: true }]]);
  const merged = overlayLive(rows, live);
  assert.equal(merged[0].state, "running");
  assert.equal(merged[0].totals.done, 2);
  assert.equal(merged[0].fake_model, true);
  assert.equal(merged[1], rows[1]);
  assert.deepEqual(overlayLive(rows, null), rows);
});

test("runListView says what a row shows and where it leads", () => {
  const done = runListView(runRow("r1", { results: { score_share: 0.41, median_rank1_m: 950, variants: ["hedge"] } }));
  assert.equal(done.target, "results");
  assert.equal(done.has_results, true);
  assert.equal(done.score_share, 0.41);
  assert.equal(done.variants, 1);
  assert.equal(done.wall_time_s, 378.8);
  assert.equal(done.effort, "high");

  const going = runListView(runRow("r3", { state: "running", active: true, results: null, totals: { done: 2, total: 5, spend_usd: 1 } }));
  assert.equal(going.target, "dashboard");
  assert.equal(going.active, true);
  assert.equal(going.has_results, false);
  assert.equal(going.wall_time_s, null);
  assert.equal(going.done, 2);

  // a row that must not show a score shows none, whatever it carries
  const steered = runListView(runRow("r0", { no_human: false }));
  assert.equal(steered.has_results, false);
  assert.equal(steered.score_share, null);
  assert.equal(runListView(runRow("r9", { fake_model: true })).fake, true);
});

const CONTEXT = {
  defaults: { hedge: false, allow_web: true, disabled_tools: [], concurrency: 6, standard: { effort: "high" } },
  tools: [
    { name: "view_crop", protected: false, web: false },
    { name: "update_candidates", protected: true, web: false },
    { name: "submit_locations", protected: true, web: false },
    { name: "ask_multiple_choice", protected: false, web: false },
    { name: "streetview_lookup", protected: false, web: true },
    { name: "web_search", protected: false, web: true },
  ],
  readiness: { openai_key: true },
  estimates: { eval: { runs: 2, panoramas: 10, mean_cost_usd: 0.62 } },
  fake_model: false,
};

test("initialRunForm opens on the defaults a new run would get", () => {
  assert.deepEqual(initialRunForm(CONTEXT), { effort: "", hedge: false, web: true, toolsOff: [], limit: "", concurrency: "6", runId: "" });
  assert.equal(initialRunForm(null).concurrency, "4");
  assert.equal(initialRunForm({ defaults: { allow_web: false, hedge: true, disabled_tools: ["web_search"] } }).web, false);
  assert.equal(defaultEffortText(CONTEXT), "Default (high)");
  assert.equal(defaultEffortText(null), "Default");
});

test("toolSwitches locks the answer path on and the web tools off when web is off", () => {
  const form = { ...initialRunForm(CONTEXT), toolsOff: ["view_crop"] };
  const on = Object.fromEntries(toolSwitches(CONTEXT.tools, form).map((item) => [item.name, item]));
  assert.deepEqual([on.update_candidates.on, on.update_candidates.locked], [true, true]);
  assert.deepEqual([on.submit_locations.on, on.submit_locations.locked], [true, true]);
  assert.deepEqual([on.view_crop.on, on.view_crop.locked], [false, false]);
  assert.deepEqual([on.streetview_lookup.on, on.streetview_lookup.locked], [true, false]);
  assert.ok(on.ask_multiple_choice.note.includes("no human channels"));

  const off = Object.fromEntries(toolSwitches(CONTEXT.tools, { ...form, web: false }).map((item) => [item.name, item]));
  assert.deepEqual([off.streetview_lookup.on, off.streetview_lookup.locked], [false, true]);
  assert.deepEqual([off.web_search.on, off.web_search.locked], [false, true]);
  assert.deepEqual(toolSwitches(null, form), []);

  assert.deepEqual(toggleTool(["view_crop"], "web_search", false), ["view_crop", "web_search"]);
  assert.deepEqual(toggleTool(["view_crop", "web_search"], "view_crop", true), ["web_search"]);
  assert.deepEqual(toggleTool(null, "x", true), []);
});

test("readRunForm builds the body of the launch and of its estimate", () => {
  const form = initialRunForm(CONTEXT);
  assert.deepEqual(readRunForm(form, CONTEXT.tools), { body: { hedge: false, web: true, tools_off: [], concurrency: 6 }, errors: {} });

  const full = readRunForm({ effort: "xhigh", hedge: true, web: false, toolsOff: ["web_search", "view_crop"], limit: " 3 ", concurrency: "2", runId: " ablation-1 " }, CONTEXT.tools);
  assert.deepEqual(full.errors, {});
  assert.deepEqual(full.body, { hedge: true, web: false, tools_off: ["view_crop", "web_search"], effort: "xhigh", concurrency: 2, limit: 3, run_id: "ablation-1" });

  // a protected or unknown tool never reaches the request
  const guarded = readRunForm({ ...form, toolsOff: ["update_candidates", "made_up", "view_crop"] }, CONTEXT.tools);
  assert.deepEqual(guarded.body.tools_off, ["view_crop"]);
});

test("readRunForm names what is wrong with a field and leaves it out of the body", () => {
  const form = initialRunForm(CONTEXT);
  for (const bad of ["0", "13", "2.5", "", "abc", "-1"]) {
    const read = readRunForm({ ...form, concurrency: bad }, CONTEXT.tools);
    assert.ok(read.errors.concurrency, "concurrency " + bad);
    assert.equal(read.body.concurrency, undefined);
  }
  for (const bad of ["0", "-3", "1.5", "all"]) {
    const read = readRunForm({ ...form, limit: bad }, CONTEXT.tools);
    assert.ok(read.errors.limit, "limit " + bad);
    assert.equal(read.body.limit, undefined);
  }
  for (const bad of ["../x", "a b", ".hidden", "a..b", "x".repeat(101)]) {
    assert.ok(readRunForm({ ...form, runId: bad }, CONTEXT.tools).errors.runId, "run id " + bad);
  }
  assert.ok(readRunForm({ ...form, effort: "ludicrous" }, CONTEXT.tools).errors.effort);
  assert.equal(readRunForm({ ...form, concurrency: "12" }, CONTEXT.tools).body.concurrency, 12);
});

test("launchState blocks until the set is checked, and repeats the server's reasons", () => {
  const ok = { panoramas: 5, cost_ceiling_usd: 40, todo_labels: 0, unconfirmed_labels: 4, blocking: [] };
  const ready = launchState({ context: CONTEXT, estimate: ok });
  assert.equal(ready.blocked, false);
  assert.deepEqual(ready.reasons, []);
  assert.equal(ready.label, "Launch evaluation run (5 panoramas)");
  assert.equal(launchState({ context: CONTEXT, estimate: { ...ok, panoramas: 1 } }).label, "Launch evaluation run (1 panorama)");

  const todo = launchState({ context: CONTEXT, estimate: { ...ok, todo_labels: 1, blocking: ["1 panorama(s) still have no Urban / non-Urban label. Label them first."] } });
  assert.equal(todo.blocked, true);
  assert.equal(todo.needsLabels, true);
  assert.deepEqual(todo.reasons, ["1 panorama(s) still have no Urban / non-Urban label. Label them first."]);

  assert.equal(launchState({ context: CONTEXT, estimating: true }).blocked, true);
  assert.equal(launchState({ context: CONTEXT }).blocked, true);
  assert.equal(launchState({ context: CONTEXT, estimateError: new Error("x") }).blocked, true);
  assert.equal(launchState({ context: CONTEXT, estimate: ok, errors: { limit: "bad" } }).blocked, true);
  assert.deepEqual(launchState({ context: null, estimate: ok }).reasons, ["Waiting for the launch settings."]);
  assert.deepEqual(launchState({ context: null, contextError: new Error("x"), errors: { limit: "bad" } }).reasons, ["The launch settings could not be read."]);
  assert.equal(launchState().blocked, true);
  const busy = launchState({ context: CONTEXT, estimate: ok, launching: true });
  assert.equal(busy.blocked, true);
  assert.equal(busy.label, "Launching");
});

test("launchState says so on the button when there is no key, or when the demo model answers", () => {
  const ok = { panoramas: 5, cost_ceiling_usd: 40, todo_labels: 0, unconfirmed_labels: 0, blocking: [] };
  const noKey = launchState({ context: { ...CONTEXT, readiness: { openai_key: false } }, estimate: ok });
  assert.equal(noKey.noKey, true);
  assert.equal(noKey.blocked, false);
  assert.equal(noKey.label, "Launch anyway (fallback answers only)");
  // the demo model needs no key
  const demo = launchState({ context: { ...CONTEXT, readiness: { openai_key: false }, fake_model: true }, estimate: ok });
  assert.equal(demo.noKey, false);
  assert.equal(demo.label, "Launch demo run (5 panoramas)");
});

test("pastEstimate scales what past runs cost per panorama", () => {
  assert.deepEqual(pastEstimate(CONTEXT.estimates, 5), { usd: 3.1, per_panorama_usd: 0.62, runs: 2 });
  assert.equal(pastEstimate({}, 5), null);
  assert.equal(pastEstimate(CONTEXT.estimates, 0), null);
  assert.equal(pastEstimate({ eval: { runs: 0, mean_cost_usd: null } }, 5), null);
  assert.equal(pastEstimate(null, 5), null);
});

test("canReuseKey reuses a key only for the same request that never got an answer", () => {
  const body = JSON.stringify({ hedge: true });
  assert.equal(canReuseKey(null, body), false);
  assert.equal(canReuseKey({ bodyJson: body, key: "k", status: 0 }, body), true);
  assert.equal(canReuseKey({ bodyJson: body, key: "k", status: 503 }, body), true);
  assert.equal(canReuseKey({ bodyJson: body, key: "k", status: 409 }, body), false);
  assert.equal(canReuseKey({ bodyJson: body, key: "k", status: 0 }, JSON.stringify({ hedge: false })), false);
});

// GET /api/eval/compare `comparison.groups`, as eval/run_eval.py `compare_results` writes it.
function cell(a, b) {
  return { a, b, delta: typeof a === "number" && typeof b === "number" ? b - a : null };
}

test("compareRows lays the group summaries side by side in the order of the metrics", () => {
  const groups = {
    all: { n: cell(5, 5), mean_score: cell(6000, 7000), median_rank1_distance_m: cell(900, 700), mean_cost_usd: cell(0.5, 0.75), odd_metric: cell(1, 2) },
    Urban: { n: cell(3, 3), mean_score: cell(8000, 7000), median_rank1_distance_m: cell(null, null), mean_cost_usd: cell(0.5, 0.5) },
    "non-Urban": { n: cell(2, 2), mean_score: cell(null, 5000) },
  };
  const rows = compareRows(groups);
  assert.deepEqual(rows.map((row) => row.key), ["n", "mean_score", "median_rank1_distance_m", "mean_cost_usd", "odd_metric"]);
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.mean_score.cells.all.verdict, "better");
  assert.equal(byKey.mean_score.cells.Urban.verdict, "worse");
  assert.equal(byKey.mean_score.cells["non-Urban"].delta, null);
  assert.equal(byKey.mean_score.cells["non-Urban"].verdict, null);
  assert.equal(byKey.median_rank1_distance_m.cells.all.verdict, "better"); // 200 m closer
  assert.equal(byKey.mean_cost_usd.cells.all.verdict, "worse"); // dearer
  assert.equal(byKey.mean_cost_usd.cells.Urban.verdict, "same");
  assert.equal(byKey.n.cells.all.verdict, null);
  assert.equal(byKey.odd_metric.type, "number");
  // a metric a group lacks is a row of blanks there, not a crash
  assert.deepEqual(byKey.median_rank1_distance_m.cells["non-Urban"], { a: null, b: null, delta: null, verdict: null });
  assert.deepEqual(compareRows(null), []);
});

const DELTAS = [
  { panorama_id: "p1", label: "Urban", score_a: 100, score_b: 150, delta: 50 },
  { panorama_id: "p2", label: "Urban", score_a: 9000, score_b: 2000, delta: -7000 },
  { panorama_id: "p3", label: "non-Urban", score_a: 500, score_b: 500, delta: 0 },
  { panorama_id: "p4", label: "non-Urban", score_a: null, score_b: 800, delta: null },
  { panorama_id: "p5", label: "Urban", score_a: 4000, score_b: 11000, delta: 7000 },
];

test("sortDeltas puts the largest change first, whichever way, and the unpaired last", () => {
  assert.deepEqual(sortDeltas(DELTAS).map((row) => row.panorama_id), ["p2", "p5", "p1", "p3", "p4"]);
  assert.deepEqual(sortRows(DELTAS, { key: "delta", dir: "asc" }, DELTA_SORTS).map((row) => row.panorama_id), ["p2", "p3", "p1", "p5", "p4"]);
  assert.deepEqual(sortRows(DELTAS, { key: "score_b", dir: "desc" }, DELTA_SORTS).map((row) => row.panorama_id), ["p5", "p2", "p4", "p3", "p1"]);
  assert.deepEqual(sortDeltas(null), []);
});

test("deltaWinner, scatterPoints and scoreDomain describe the pairs", () => {
  assert.deepEqual(DELTAS.map(deltaWinner), ["b", "a", "tie", "unpaired", "b"]);
  const points = scatterPoints(DELTAS);
  assert.equal(points.length, 4); // p4 is on one side only
  assert.deepEqual(points[0], { x: 100, y: 150, label: "p1", kind: "Urban", pid: "p1" });
  assert.deepEqual(points.map((point) => point.pid), ["p1", "p2", "p5", "p3"]); // Urban first
  assert.deepEqual(scoreDomain(DELTAS), [0, 11000]);
  assert.deepEqual(scoreDomain([{ score_a: 16050.5, score_b: 3 }]), [0, 17000]);
  assert.deepEqual(scoreDomain([]), [0, 1000]);
});

test("pairedView counts wins, losses and ties in one sentence", () => {
  const view = pairedView({ n: 4, mean_score_delta: 12.5, b_better: 2, a_better: 1, ties: 1 });
  assert.equal(view.mean_delta, 12.5);
  assert.equal(view.text, "B scored higher on more panoramas: B on 2, A on 1, 1 tie, over 4 panoramas both hold.");
  assert.ok(pairedView({ n: 3, b_better: 1, a_better: 2, ties: 0 }).text.startsWith("A scored higher on more panoramas"));
  assert.ok(pairedView({ n: 2, b_better: 1, a_better: 1, ties: 0 }).text.startsWith("Neither side is ahead"));
  assert.ok(pairedView({ n: 1, b_better: 0, a_better: 0, ties: 1 }).text.endsWith("over 1 panorama both hold."));
  const none = pairedView({ n: 0, mean_score_delta: null, b_better: 0, a_better: 0, ties: 0 });
  assert.equal(none.mean_delta, null);
  assert.ok(none.text.includes("share no panorama"));
  assert.equal(pairedView(null).n, 0);
});
