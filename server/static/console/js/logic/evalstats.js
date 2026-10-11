// Decisions of the Evaluation screen's Run, Results and Compare tabs (UI-SPEC 5.9), kept pure so
// they can be tested with `node --test`: nothing here touches the DOM or the network.
//
// Shapes (server/evalops.py, eval/run_eval.py):
//   results   {run_id, config, summary: {all|Urban|non-Urban: {n, mean_score, total_score,
//             score_share_of_max, median_rank1_distance_m, within_100m, within_1km, within_10km,
//             mean_cost_usd, total_cost_usd, mean_time_s, median_time_s}}, panoramas: [PanoScore]}
//   PanoScore {panorama_id, label, special, score, max_score, rank1_distance_m, best_distance_m,
//             multiplier, origin, plan, n_hypotheses, cost_usd, time_s, turns}
//   truth     {panoramas: {pid: {lat, lng, label, entries: [{rank, lat, lng, distance_m, theta}],
//             rank1_distance_m, score, max_score, share, band, top_distance_series}}}

import { fmtDist, fmtDuration, fmtInt, fmtPct, fmtUsd } from "../format.js";

const DASH = "–";

export const URBAN = "Urban";
export const NON_URBAN = "non-Urban";
export const GROUPS = ["all", URBAN, NON_URBAN];
// theta runs from 0 (nothing) to 2 (on the spot): astrolabio.scoring.
export const MAX_THETA = 2;

export function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

const numOrNull = (value) => (isNum(value) ? value : null);
const text = (value) => String(value ?? "");

export function groupLabel(group) {
  return group === "all" ? "All" : text(group);
}

/** How a label is written on a badge: {text, kind, icon}. A property, not a status: no icon. */
export function labelBadge(label) {
  if (label === URBAN) return { text: URBAN, kind: "urban", icon: null };
  if (label === NON_URBAN) return { text: NON_URBAN, kind: "nonurban", icon: null };
  return { text: label ? text(label) : "no label", kind: "dim", icon: "question" };
}

/** Badge words for where an answer came from. */
export function originBadge(origin) {
  if (origin === "agent") return { text: "agent", kind: "dim", icon: "target" };
  if (origin === "harness_fallback") return { text: "fallback", kind: "warn", icon: "alert" };
  // The result of a penalised channel is not itself a penalised control: no penalty colour here.
  if (origin === "human_geocode") return { text: "human geocode", kind: "info", icon: "map" };
  if (!origin || origin === "none") return { text: "no answer", kind: "bad", icon: "x" };
  return { text: text(origin).replace(/_/g, " "), kind: "dim", icon: "info" };
}

/** True when any of the given configs, runs or rows says the scripted demo model answered. */
export function isDemo(...sources) {
  return sources.some((source) => Boolean(source && source.fake_model));
}

export const DEMO_NOTE = "Answered by the scripted demo model. These numbers are not meaningful: they say nothing about the agent.";

// ---------------------------------------------------------------- distance bands

// The thresholds of the results table (eval.run_eval.THRESHOLDS_M) as disjoint bands, which is
// how the truth map colours its lines (contract A10). Kind and icon are the badge that names the
// band beside the map: never colour alone.
export const BANDS = [
  { key: "100m", limit: 100, label: "within 100 m", short: "\u2264 100 m", kind: "ok", icon: "check" },
  { key: "1km", limit: 1000, label: "100 m to 1 km", short: "\u2264 1 km", kind: "info", icon: "target" },
  { key: "10km", limit: 10000, label: "1 km to 10 km", short: "\u2264 10 km", kind: "warn", icon: "alert" },
  { key: "far", limit: Infinity, label: "beyond 10 km", short: "> 10 km", kind: "bad", icon: "x" },
];

const BAND_KEYS = BANDS.map((band) => band.key);

/** The band of a rank-1 distance in metres. No answer is as far as it gets, as the server has it. */
export function bandOf(distanceM) {
  if (!isNum(distanceM)) return "far";
  return BANDS.find((band) => distanceM <= band.limit).key;
}

export function bandInfo(key) {
  return BANDS.find((band) => band.key === key) || BANDS[BANDS.length - 1];
}

/** The bands with how many rows fall in each: [{...band, n}]. */
export function bandCounts(rows) {
  return BANDS.map((band) => ({ ...band, n: (rows || []).filter((row) => row.band === band.key).length }));
}

// ---------------------------------------------------------------- medians, means, shares

function numbers(values) {
  return (values || []).filter(isNum);
}

export function mean(values) {
  const list = numbers(values);
  return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
}

export function median(values) {
  const list = numbers(values).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

/** `count` of `n` as a share between 0 and 1; null when there is nothing to take a share of. */
export function shareOf(count, n) {
  return isNum(count) && isNum(n) && n > 0 ? count / n : null;
}

export function groupRows(rows, group) {
  return (rows || []).filter((row) => group === "all" || row.label === group);
}

/**
 * The metrics of one group of PanoScore rows, as `eval.run_eval.summarise_group` computes them
 * (a panorama without an answer is a miss at every threshold), plus the mean rank-1 distance,
 * which the server does not store.
 */
export function summariseRows(rows) {
  const list = rows || [];
  const n = list.length;
  const rank1 = numbers(list.map((row) => row.rank1_distance_m));
  const costs = numbers(list.map((row) => row.cost_usd));
  const times = numbers(list.map((row) => row.time_s));
  const total = list.reduce((sum, row) => sum + (isNum(row.score) ? row.score : 0), 0);
  const maxTotal = list.reduce((sum, row) => sum + (isNum(row.max_score) ? row.max_score : 0), 0);
  const within = (limit) => shareOf(rank1.filter((d) => d <= limit).length, n);
  return {
    n,
    mean_score: n ? total / n : null,
    total_score: total,
    score_share_of_max: maxTotal ? total / maxTotal : null,
    median_rank1_distance_m: median(rank1),
    mean_rank1_distance_m: mean(rank1),
    within_100m: within(100),
    within_1km: within(1000),
    within_10km: within(10000),
    mean_cost_usd: mean(costs),
    total_cost_usd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
    mean_time_s: mean(times),
    median_time_s: median(times),
  };
}

/**
 * The summary of one group of a results document. The numbers the server wrote are the record
 * and win; what it does not store (the mean rank-1 distance) is worked out from the rows.
 */
export function groupSummary(results, group) {
  const computed = summariseRows(groupRows(results && results.panoramas, group));
  const stored = results && results.summary && results.summary[group];
  if (!stored || typeof stored !== "object") return computed;
  const merged = { ...computed };
  for (const [key, value] of Object.entries(stored)) if (value !== undefined) merged[key] = value;
  return merged;
}

// ---------------------------------------------------------------- metrics: names, formats, deltas

// `better` says which way is an improvement, so a delta can be called better or worse in words.
export const METRICS = [
  { key: "n", label: "Panoramas", short: "n", type: "int", better: null },
  { key: "mean_score", label: "Mean score", short: "Mean score", type: "score", better: "higher" },
  { key: "total_score", label: "Total score", short: "Total score", type: "score", better: "higher" },
  { key: "score_share_of_max", label: "Share of maximum", short: "Share of max", type: "share", better: "higher" },
  { key: "median_rank1_distance_m", label: "Median rank-1 distance", short: "Median rank-1", type: "dist", better: "lower" },
  { key: "mean_rank1_distance_m", label: "Mean rank-1 distance", short: "Mean rank-1", type: "dist", better: "lower" },
  { key: "within_100m", label: "Within 100 m", short: "\u2264 100 m", type: "share", better: "higher" },
  { key: "within_1km", label: "Within 1 km", short: "\u2264 1 km", type: "share", better: "higher" },
  { key: "within_10km", label: "Within 10 km", short: "\u2264 10 km", type: "share", better: "higher" },
  { key: "mean_cost_usd", label: "Mean cost", short: "Mean cost", type: "usd", better: "lower" },
  { key: "total_cost_usd", label: "Total cost", short: "Total cost", type: "usd", better: "lower" },
  { key: "mean_time_s", label: "Mean time", short: "Mean time", type: "time", better: "lower" },
  { key: "median_time_s", label: "Median time", short: "Median time", type: "time", better: "lower" },
];

export function metricInfo(key) {
  const label = text(key).replace(/_/g, " ");
  return METRICS.find((metric) => metric.key === key) || { key, label, short: label, type: "number", better: null };
}

function plainNumber(value) {
  const abs = Math.abs(value);
  if (Number.isInteger(value)) return fmtInt(value);
  return abs >= 100 ? fmtInt(value) : value.toFixed(abs >= 10 ? 1 : 2);
}

export function fmtScore(value) {
  return isNum(value) ? fmtInt(value) : DASH;
}

export function fmtTheta(value) {
  return isNum(value) ? value.toFixed(2) : DASH;
}

/** One metric value in the unit of its type. */
export function fmtMetric(type, value) {
  if (!isNum(value)) return DASH;
  if (type === "int" || type === "score") return fmtInt(value);
  if (type === "share") return fmtPct(value, 1);
  if (type === "dist") return fmtDist(value);
  if (type === "usd") return fmtUsd(value);
  if (type === "time") return fmtDuration(value);
  return plainNumber(value);
}

const EPSILON = 1e-9;

/** A signed difference in the unit of its type; a share changes in percentage points ("pts"). */
export function fmtDelta(type, delta) {
  if (!isNum(delta)) return DASH;
  if (Math.abs(delta) <= EPSILON) return "0";
  const sign = delta > 0 ? "+" : "-";
  const abs = Math.abs(delta);
  if (type === "share") return sign + (abs * 100).toFixed(1) + " pts";
  if (type === "dist") return sign + fmtDist(abs);
  if (type === "usd") return sign + fmtUsd(abs);
  if (type === "time") return sign + fmtDuration(abs);
  if (type === "int") return sign + fmtInt(abs);
  // A score change below half a point must not print as "+0", nor a real one as "+0.00".
  if (type === "score") return sign + (abs >= 0.5 ? fmtInt(abs) : abs < 0.01 ? "<0.01" : abs.toFixed(2));
  return sign + plainNumber(abs);
}

/** "better", "worse" or "same" for a delta (b - a) of a metric; null when neither way is better. */
export function deltaVerdict(better, delta) {
  if (!isNum(delta) || !better) return null;
  if (Math.abs(delta) <= EPSILON) return "same";
  return (delta > 0) === (better === "higher") ? "better" : "worse";
}

// ---------------------------------------------------------------- results: per-panorama rows

export function hasPoint(point) {
  return Boolean(point) && isNum(point.lat) && isNum(point.lng)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
}

function distinctPoints(entries) {
  return new Set(entries.map((entry) => entry.lat.toFixed(6) + "," + entry.lng.toFixed(6))).size;
}

/**
 * One row per scored panorama: the PanoScore of the results document, the truth and the answer
 * list of the truth document, and how the panorama ended from the run's tiles. Any of the last
 * two may be missing (the request failed, the run is not on this server): the row then has nulls.
 */
export function mergeRows(results, truth, tiles) {
  const truths = (truth && truth.panoramas) || {};
  const tileOf = new Map((tiles || []).map((tile) => [text(tile.panorama_id), tile]));
  return ((results && results.panoramas) || []).map((score) => {
    const pid = text(score.panorama_id);
    const known = truths[pid] || null;
    const tile = tileOf.get(pid) || null;
    const entries = known && Array.isArray(known.entries) ? known.entries.filter(hasPoint) : [];
    const first = entries.find((entry) => entry.rank === 1) || entries[0] || null;
    const rank1 = isNum(score.rank1_distance_m)
      ? score.rank1_distance_m
      : numOrNull(known && known.rank1_distance_m);
    const points = numOrNull(score.score);
    const max = numOrNull(score.max_score);
    return {
      panorama_id: pid,
      label: score.label ?? (known ? known.label : null) ?? null,
      special: Boolean(score.special),
      score: points,
      max_score: max,
      share: points !== null && max ? points / max : null,
      rank1_distance_m: rank1,
      best_distance_m: numOrNull(score.best_distance_m),
      theta: first && isNum(first.theta) ? first.theta : null,
      band: known && BAND_KEYS.includes(known.band) ? known.band : bandOf(rank1),
      multiplier: numOrNull(score.multiplier),
      origin: score.origin ?? null,
      plan: score.plan ? text(score.plan) : "",
      n_hypotheses: numOrNull(score.n_hypotheses),
      cost_usd: numOrNull(score.cost_usd),
      time_s: numOrNull(score.time_s),
      turns: numOrNull(score.turns),
      stop_reason: tile ? tile.stop_reason ?? null : null,
      stop_text: tile ? tile.stop_text ?? null : null,
      truth: hasPoint(known) ? { lat: known.lat, lng: known.lng } : null,
      answer: first ? { lat: first.lat, lng: first.lng } : null,
      entries,
      distinct: distinctPoints(entries),
    };
  });
}

// ---------------------------------------------------------------- table sorting

const lower = (value) => text(value).toLowerCase();

/** What each sortable column of the per-panorama table sorts by. */
export const RESULT_SORTS = {
  panorama_id: (row) => text(row.panorama_id),
  label: (row) => text(row.label),
  rank1_distance_m: (row) => row.rank1_distance_m,
  best_distance_m: (row) => row.best_distance_m,
  theta: (row) => row.theta,
  score: (row) => row.score,
  share: (row) => row.share,
  multiplier: (row) => row.multiplier,
  origin: (row) => text(row.origin),
  plan: (row) => text(row.plan),
  n_hypotheses: (row) => row.n_hypotheses,
  cost_usd: (row) => row.cost_usd,
  time_s: (row) => row.time_s,
  turns: (row) => row.turns,
  stop: (row) => lower(row.stop_text || row.stop_reason),
};

/** The delta table of the Compare tab. `change` is the size of the change, whichever way. */
export const DELTA_SORTS = {
  panorama_id: (row) => text(row.panorama_id),
  label: (row) => text(row.label),
  score_a: (row) => row.score_a,
  score_b: (row) => row.score_b,
  delta: (row) => row.delta,
  change: (row) => (isNum(row.delta) ? Math.abs(row.delta) : null),
};

const missing = (value) => value === null || value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value));

/**
 * A sorted copy of `rows`. `sort = {key, dir}`; `{key: null}` keeps the order given. A row without
 * the value goes last whichever way the column is sorted, and equal rows fall back to the id.
 */
export function sortRows(rows, sort, readers = RESULT_SORTS) {
  const list = (rows || []).slice();
  const read = sort && readers[sort.key];
  if (!read) return list;
  const sign = sort.dir === "desc" ? -1 : 1;
  return list.sort((a, b) => {
    const x = read(a);
    const y = read(b);
    const noX = missing(x);
    const noY = missing(y);
    if (noX !== noY) return noX ? 1 : -1;
    if (!noX && x !== y) return (x < y ? -1 : 1) * sign;
    const idA = text(a.panorama_id);
    const idB = text(b.panorama_id);
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
}

/** Click on a column header: ascending, then descending, then back to the order given. */
export function nextSort(sort, key) {
  if (!sort || sort.key !== key) return { key, dir: "asc" };
  if (sort.dir === "asc") return { key, dir: "desc" };
  return { key: null, dir: "asc" };
}

// ---------------------------------------------------------------- results: map and charts

/**
 * The truth-against-answer lines of `map.setLines`, one per panorama that has both ends. The
 * selected panorama is left out: the screen draws it in full (every distinct entry) instead.
 */
export function mapLines(rows, selected = null) {
  return (rows || []).filter((row) => row.truth && row.answer && row.panorama_id !== selected).map((row) => ({
    from: row.truth,
    to: row.answer,
    band: row.band,
    label: row.panorama_id + " \u00b7 " + fmtDist(row.rank1_distance_m),
  }));
}

/**
 * The markers of `map.setMarkers`: a star at each truth, a tick at each rank-1 answer, named on
 * hover (forty labels at once cannot be read). The selected panorama is left out, as above.
 */
export function mapMarkers(rows, selected = null) {
  const markers = [];
  for (const row of rows || []) {
    if (row.panorama_id === selected) continue;
    if (row.truth) {
      markers.push({ ...row.truth, kind: "truth", pid: row.panorama_id, permanent: false, label: "truth \u00b7 " + row.panorama_id });
    }
    if (row.answer) {
      markers.push({
        ...row.answer, kind: "answer", pid: row.panorama_id, permanent: false,
        label: "answer \u00b7 " + row.panorama_id + " \u00b7 " + fmtDist(row.rank1_distance_m),
      });
    }
  }
  return markers;
}

/**
 * Where to put the map so that both points are in view: the middle, at the zoom where the
 * distance between them takes about two fifths of a map `widthPx` wide. One point alone, or two
 * on the same spot, are shown at street level.
 */
export function focusView(a, b, widthPx = 600) {
  const first = hasPoint(a) ? a : hasPoint(b) ? b : null;
  if (!first) return null;
  const second = hasPoint(b) && hasPoint(a) ? b : first;
  let dLng = second.lng - first.lng;
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  const lat = (first.lat + second.lat) / 2;
  let lng = first.lng + dLng / 2;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  const rad = Math.PI / 180;
  const cosLat = Math.max(0.05, Math.cos(lat * rad));
  // equirectangular distance: good enough to choose a zoom level
  const metres = 6371008.8 * rad * Math.hypot(second.lat - first.lat, dLng * cosLat);
  if (metres < 1) return { lat, lng, zoom: 16 };
  const metresPerPixel = metres / (0.4 * Math.max(200, widthPx));
  const zoom = Math.floor(Math.log2((156543.03392 * cosLat) / metresPerPixel));
  return { lat, lng, zoom: Math.min(16, Math.max(2, zoom)) };
}

/**
 * Rank-1 distances by label for the log histogram. A log axis has no zero, so an answer on the
 * spot is drawn at 1 m. Both groups are always there, in the same order, so their colours hold.
 */
export function distanceGroups(rows) {
  return [URBAN, NON_URBAN].map((label) => ({
    name: label,
    values: (rows || []).filter((row) => row.label === label && isNum(row.rank1_distance_m))
      .map((row) => Math.max(1, row.rank1_distance_m)),
  }));
}

// A scatter chart colours its kinds in order of first appearance: Urban first, then non-Urban,
// whatever order the rows come in, so a label has the same colour on every chart of the screen.
function byLabel(points) {
  const rank = (point) => (point.kind === URBAN ? 0 : point.kind === NON_URBAN ? 1 : 2);
  return points.map((point, index) => ({ point, index }))
    .sort((a, b) => rank(a.point) - rank(b.point) || a.index - b.index)
    .map((item) => item.point);
}

/** Score against cost, one point per panorama that has both. */
export function costScorePoints(rows) {
  return byLabel((rows || []).filter((row) => isNum(row.cost_usd) && isNum(row.score)).map((row) => ({
    x: row.cost_usd, y: row.score, label: row.panorama_id, kind: text(row.label), pid: row.panorama_id,
  })));
}

// ---------------------------------------------------------------- configuration in words

const onOff = (value) => (value ? "on" : "off");

/** What a rescore variant changed, in words, from its `config`. */
export function variantText(config) {
  if (!config || config.mode !== "rescore") return "as the run answered";
  if (!config.reallocated) return "same answers, scored again";
  return "re-allocated: hedge " + onOff(config.hedge) + ", "
    + (config.allow_duplicates === false ? "distinct points only" : "duplicates allowed");
}

/** The configuration behind a results document as [label, value] lines for a key-value list. */
export function configLines(config) {
  const c = config || {};
  if (c.mode === "rescore") {
    return [
      ["Kind", "rescore variant (offline, no model call)"],
      ["Allocation", variantText(c)],
      ["Panoramas", isNum(c.panoramas) ? fmtInt(c.panoramas) : DASH],
      ["Scored against", c.manifest ? text(c.manifest) : DASH],
    ];
  }
  const effort = c.effort && typeof c.effort === "object" ? c.effort : {};
  const efforts = [effort.standard, effort.special].filter(Boolean);
  const tools = Array.isArray(c.tools_off) ? c.tools_off : [];
  return [
    ["Model", c.model ? text(c.model) : DASH],
    ["Effort", efforts.length
      ? (effort.standard || DASH) + (effort.special && effort.special !== effort.standard ? " (Special One: " + effort.special + ")" : "")
      : DASH],
    ["Hedge", c.hedge === undefined ? DASH : onOff(c.hedge)],
    ["Duplicates", c.allow_duplicates === undefined ? DASH : c.allow_duplicates ? "allowed" : "distinct points only"],
    ["Web", c.allow_web === undefined ? DASH : onOff(c.allow_web)],
    ["Tools switched off", tools.length ? tools.join(", ") : "none"],
    ["Panoramas", isNum(c.panoramas) ? fmtInt(c.panoramas) : DASH],
    ["Scored against", c.manifest ? text(c.manifest) : DASH],
  ];
}

/** One line for a run's configuration, for the head of a compare side. */
export function configSummary(config) {
  const c = config || {};
  if (c.mode === "rescore") return variantText(c);
  const parts = [];
  if (c.model) parts.push(text(c.model));
  if (c.effort && c.effort.standard) parts.push("effort " + c.effort.standard);
  if (c.hedge !== undefined) parts.push("hedge " + onOff(c.hedge));
  if (c.allow_web !== undefined) parts.push("web " + onOff(c.allow_web));
  const tools = Array.isArray(c.tools_off) ? c.tools_off : [];
  if (tools.length) parts.push(tools.length + " tool" + (tools.length === 1 ? "" : "s") + " off");
  return parts.join(", ") || "configuration not recorded";
}

// ---------------------------------------------------------------- variants and rescore

// server/security.py TAG_RE and ID_RE: a tag and a run id become file names.
export const TAG_RE = /^[a-z0-9_-]{1,32}$/;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// `keep` scores the answers as the run gave them; the other two re-allocate the logged hypotheses.
export const ALLOCATIONS = [
  { value: "hedge", hedge: true, label: "Hedge on", help: "Split the list between the top two hypotheses when they are close." },
  { value: "nohedge", hedge: false, label: "Hedge off", help: "The best point takes the list." },
  { value: "keep", hedge: null, label: "Keep the answers", help: "No re-allocation: the same lists, scored again." },
];

/** The tag the server derives when none is sent (evalops.rescore_options, as the CLI does). */
export function defaultTag({ hedge, duplicates }) {
  const reallocating = hedge !== null || !duplicates;
  if (!reallocating) return "rescore";
  return (hedge ? "hedge" : "nohedge") + (duplicates ? "" : "-distinct");
}

/**
 * The rescore form as the body of `POST /api/runs/<id>/rescore`.
 * `form = {allocation: "hedge"|"nohedge"|"keep", distinct: bool, tag: text}`.
 * Returns `{body, tag, error}`: `tag` is the variant that will be written.
 */
export function readRescoreForm(form) {
  const choice = ALLOCATIONS.find((item) => item.value === form.allocation) || ALLOCATIONS[0];
  // "Distinct points" is itself a re-allocation, so it cannot go with "keep the answers".
  const duplicates = choice.hedge === null ? true : !form.distinct;
  const body = { hedge: choice.hedge, duplicates };
  const typed = text(form.tag).trim();
  let error = null;
  if (typed) {
    if (TAG_RE.test(typed)) body.tag = typed;
    else error = "Use 1 to 32 lower-case letters, digits, '_' or '-'.";
  }
  return { body, tag: body.tag || defaultTag(body), error };
}

/**
 * The original and its variants as rows for the variants list:
 * `[{tag, label, text, n, mean_score, score_share, median_rank1_m, share_delta, current}]`.
 * `share_delta` is against the original, in share of maximum. While a variant is on screen the
 * payload does not hold the original's own summary: pass its results document as `originalResults`.
 */
export function variantRows(payload, currentTag = "", originalResults = null) {
  if (!payload) return [];
  const row = (tag, summary, config) => {
    const all = (summary && summary.all) || {};
    return {
      tag,
      label: tag || "Original",
      text: variantText(config),
      n: numOrNull(all.n),
      mean_score: numOrNull(all.mean_score),
      score_share: numOrNull(all.score_share_of_max),
      median_rank1_m: numOrNull(all.median_rank1_distance_m),
      current: tag === (currentTag || ""),
    };
  };
  const variants = Array.isArray(payload.variants) ? payload.variants : [];
  // `payload.results` is the variant asked for; the original's summary is only there untagged.
  const ownSummary = originalResults ? originalResults.summary : payload.tag ? null : payload.results && payload.results.summary;
  const original = row("", ownSummary, payload.config);
  const rows = [original, ...variants.map((variant) => row(text(variant.tag), variant.summary, variant.config))];
  return rows.map((item) => ({
    ...item,
    share_delta: item.tag && isNum(item.score_share) && isNum(original.score_share) ? item.score_share - original.score_share : null,
  }));
}

// ---------------------------------------------------------------- result files: run[:tag]

/** `run_id[:tag]` (contract A1, `?a=` and `?b=`) as `{run_id, tag}`; null when it names nothing. */
export function parseRef(ref) {
  const value = text(ref);
  const at = value.indexOf(":");
  const runId = at === -1 ? value : value.slice(0, at);
  const tag = at === -1 ? "" : value.slice(at + 1);
  if (!ID_RE.test(runId) || runId.includes("..")) return null;
  if (tag && !TAG_RE.test(tag)) return null;
  return { run_id: runId, tag };
}

export function formatRef(runId, tag = "") {
  return tag ? runId + ":" + tag : text(runId);
}

/** Score, distance and truth are shown only for an evaluation run with human channels off. */
export function truthVisible(row) {
  return Boolean(row) && row.kind === "eval" && row.no_human !== false && row.mode !== "assisted";
}

/** The evaluation runs of `GET /api/runs`, in the order given (newest first, active on top). */
export function evalRuns(rows) {
  return (rows || []).filter((row) => row && row.kind === "eval");
}

/**
 * Every result file that can be compared, from the runs index: each evaluation run that has
 * results, then its rescore variants. `[{ref, run_id, tag, label, fake}]`.
 */
export function resultRefs(rows) {
  const refs = [];
  for (const row of evalRuns(rows)) {
    if (!truthVisible(row) || !row.results) continue;
    const fake = Boolean(row.fake_model);
    refs.push({ ref: row.run_id, run_id: row.run_id, tag: "", label: row.run_id + (fake ? " (demo)" : ""), fake });
    for (const tag of Array.isArray(row.results.variants) ? row.results.variants : []) {
      if (!TAG_RE.test(text(tag))) continue;
      refs.push({ ref: formatRef(row.run_id, tag), run_id: row.run_id, tag, label: row.run_id + " : " + tag + (fake ? " (demo)" : ""), fake });
    }
  }
  return refs;
}

/** The newest evaluation run whose results can be opened, or null. */
export function latestWithResults(rows) {
  return evalRuns(rows).find((row) => truthVisible(row) && row.results && !row.active) || null;
}

// ---------------------------------------------------------------- runs list

/**
 * The index rows with what the event stream knows on top: a run this server owns reports its
 * progress and its results there before the index is read again.
 */
export function overlayLive(rows, liveRuns) {
  return (rows || []).map((row) => {
    const live = liveRuns && liveRuns.get ? liveRuns.get(row.run_id) : null;
    if (!live) return row;
    return {
      ...row,
      state: live.state ?? row.state,
      active: live.active ?? row.active,
      totals: live.totals || row.totals,
      results: live.results === undefined ? row.results : live.results,
      fake_model: live.fake_model ?? row.fake_model,
    };
  });
}

/** What one row of the evaluation runs list shows and where it leads. */
export function runListView(row) {
  const totals = row.totals || {};
  const results = truthVisible(row) ? row.results || null : null;
  const active = Boolean(row.active) || row.state === "queued" || row.state === "running";
  const effort = row.effort && row.effort.standard ? row.effort.standard : null;
  return {
    run_id: row.run_id,
    state: row.state,
    active,
    fake: Boolean(row.fake_model),
    done: numOrNull(totals.done),
    total: numOrNull(totals.total),
    model: row.model || null,
    effort,
    spend_usd: numOrNull(totals.spend_usd),
    wall_time_s: active ? null : numOrNull(row.wall_time_s),
    created_at: row.created_at || row.started_at || null,
    score_share: results ? numOrNull(results.score_share) : null,
    median_rank1_m: results ? numOrNull(results.median_rank1_m) : null,
    variants: results && Array.isArray(results.variants) ? results.variants.length : 0,
    has_results: Boolean(results),
    // A run that is going is watched on its dashboard; a finished one opens its results.
    target: active ? "dashboard" : "results",
  };
}

// ---------------------------------------------------------------- launch form (Run tab)

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const MAX_CONCURRENCY = 12;

/** The form as it opens: the defaults a new run would get (`GET /api/launch/context`). */
export function initialRunForm(context) {
  const defaults = (context && context.defaults) || {};
  return {
    effort: "", // "" leaves the effort of the defaults alone
    hedge: Boolean(defaults.hedge),
    web: defaults.allow_web !== false,
    toolsOff: Array.isArray(defaults.disabled_tools) ? defaults.disabled_tools.slice() : [],
    limit: "",
    concurrency: isNum(defaults.concurrency) ? String(defaults.concurrency) : "4",
    runId: "",
  };
}

/** The effort a run gets when the form leaves it alone, in words. */
export function defaultEffortText(context) {
  const defaults = (context && context.defaults) || {};
  const standard = defaults.standard && defaults.standard.effort;
  return standard ? "Default (" + standard + ")" : "Default";
}

/**
 * One switch per tool of the launch context: `[{name, on, locked, note}]`. The two tools of the
 * answer path cannot be switched off, and with web off the external tools are off whatever
 * their own switch says.
 */
export function toolSwitches(tools, form) {
  const off = new Set(form.toolsOff || []);
  return (tools || []).map((tool) => {
    if (tool.protected) return { name: tool.name, on: true, locked: true, note: "always on: the answer path needs it" };
    if (tool.web && !form.web) return { name: tool.name, on: false, locked: true, note: "off because web is off" };
    return {
      name: tool.name,
      on: !off.has(tool.name),
      locked: false,
      note: tool.name === "ask_multiple_choice"
        ? "answers with a free error here: an evaluation run has no human channels"
        : tool.web ? "external" : "",
    };
  });
}

/** A copy of `toolsOff` with `name` switched on or off. */
export function toggleTool(toolsOff, name, on) {
  const off = new Set(toolsOff || []);
  if (on) off.delete(name);
  else off.add(name);
  return Array.from(off).sort();
}

function wholeNumber(value) {
  const typed = text(value).trim();
  if (!/^-?\d+$/.test(typed)) return null;
  return Number(typed);
}

/**
 * The launch form as the body of `POST /api/eval/runs` and of its `/estimate` (contract 4.6, A5).
 * Returns `{body, errors}`; `errors` maps a field to what is wrong with it. `effort`, `limit` and
 * `run_id` are left out when the operator did not choose one.
 */
export function readRunForm(form, tools = null) {
  const errors = {};
  const known = tools ? new Map(tools.map((tool) => [tool.name, tool])) : null;
  const body = {
    hedge: Boolean(form.hedge),
    web: Boolean(form.web),
    // A protected tool can never be in the list, whatever a stale default says.
    tools_off: (form.toolsOff || []).filter((name) => !known || (known.has(name) && !known.get(name).protected)).sort(),
  };
  if (form.effort) {
    if (EFFORTS.includes(form.effort)) body.effort = form.effort;
    else errors.effort = "Choose one of " + EFFORTS.join(", ") + ".";
  }
  const concurrency = wholeNumber(form.concurrency);
  if (concurrency === null || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    errors.concurrency = "A whole number from 1 to " + MAX_CONCURRENCY + ".";
  } else body.concurrency = concurrency;
  if (text(form.limit).trim()) {
    const limit = wholeNumber(form.limit);
    if (limit === null || limit < 1) errors.limit = "A whole number above 0, or leave it empty for the whole set.";
    else body.limit = limit;
  }
  const runId = text(form.runId).trim();
  if (runId) {
    if (!ID_RE.test(runId) || runId.includes("..")) {
      errors.runId = "1 to 100 letters, digits, '.', '_' or '-', starting with a letter or digit, without '..'.";
    } else body.run_id = runId;
  }
  return { body, errors };
}

/**
 * Whether the run can be launched and what the button says.
 * `{blocked, reasons: [text], needsLabels, noKey, label}`. The server decides again at launch;
 * this only keeps the operator from asking for what is known to be refused.
 */
export function launchState({ context = null, contextError = null, estimate = null, estimateError = null, estimating = false, errors = {}, launching = false } = {}) {
  const reasons = [];
  const fake = Boolean(context && context.fake_model);
  const noKey = Boolean(context && context.readiness && !context.readiness.openai_key) && !fake;
  // Without the launch settings nothing else can be known: say that and only that.
  if (!context) reasons.push(contextError ? "The launch settings could not be read." : "Waiting for the launch settings.");
  else if (Object.keys(errors).length) reasons.push("Correct the marked fields first.");
  else if (estimateError) reasons.push("The evaluation set could not be checked, so the cost ceiling is unknown.");
  else if (!estimate) reasons.push(estimating ? "Checking the evaluation set." : "The evaluation set has not been checked yet.");
  else for (const line of Array.isArray(estimate.blocking) ? estimate.blocking : []) reasons.push(text(line));
  const count = estimate && isNum(estimate.panoramas) ? estimate.panoramas : null;
  const what = count === null ? "" : " (" + fmtInt(count) + (count === 1 ? " panorama)" : " panoramas)");
  let label = "Launch evaluation run" + what;
  if (fake) label = "Launch demo run" + what;
  else if (noKey) label = "Launch anyway (fallback answers only)";
  if (launching) label = "Launching";
  return {
    blocked: reasons.length > 0 || launching,
    reasons,
    needsLabels: Boolean(estimate && estimate.todo_labels > 0),
    noKey,
    label,
  };
}

/**
 * What past evaluation runs cost for this many panoramas (`context.estimates.eval`, which leaves
 * demo runs out), or null when there is nothing to go by: `{usd, per_panorama_usd, runs}`.
 */
export function pastEstimate(estimates, panoramas) {
  const entry = estimates && estimates.eval;
  if (!entry || !entry.runs || !isNum(entry.mean_cost_usd) || !isNum(panoramas) || panoramas < 1) return null;
  return {
    usd: Math.round(entry.mean_cost_usd * panoramas * 100) / 100,
    per_panorama_usd: entry.mean_cost_usd,
    runs: entry.runs,
  };
}

/**
 * Idempotency for a launch or a rescore: a retry of the very same request after the server could
 * not be reached (or failed) reuses its key, so it happens once. After any answer from the
 * server, or with a changed form, a new key is needed.
 */
export function canReuseKey(last, bodyJson) {
  if (!last || last.bodyJson !== bodyJson) return false;
  return last.status === 0 || last.status >= 500;
}

// ---------------------------------------------------------------- compare

/**
 * The group summaries of `comparison.groups` side by side: one row per metric, in the order of
 * METRICS, each with `cells[group] = {a, b, delta, verdict}`. A metric no group has is left out.
 */
export function compareRows(groups) {
  const all = groups || {};
  const keys = [];
  for (const metric of METRICS) if (GROUPS.some((group) => all[group] && metric.key in all[group])) keys.push(metric.key);
  for (const group of GROUPS) for (const key of Object.keys(all[group] || {})) if (!keys.includes(key)) keys.push(key);
  return keys.map((key) => {
    const info = metricInfo(key);
    const cells = {};
    for (const group of GROUPS) {
      const cell = (all[group] && all[group][key]) || {};
      const delta = numOrNull(cell.delta);
      cells[group] = { a: numOrNull(cell.a), b: numOrNull(cell.b), delta, verdict: deltaVerdict(info.better, delta) };
    }
    return { ...info, cells };
  });
}

/** The per-panorama rows with the largest change first; a panorama only one side holds goes last. */
export function sortDeltas(panoramas) {
  return sortRows(panoramas, { key: "change", dir: "desc" }, DELTA_SORTS);
}

/** Who scored higher on one panorama: "b", "a", "tie", or "unpaired" when one side lacks it. */
export function deltaWinner(row) {
  if (!isNum(row.delta)) return "unpaired";
  if (Math.abs(row.delta) <= EPSILON) return "tie";
  return row.delta > 0 ? "b" : "a";
}

/** Score A against score B, one point per panorama both sides hold. */
export function scatterPoints(panoramas) {
  return byLabel((panoramas || []).filter((row) => isNum(row.score_a) && isNum(row.score_b)).map((row) => ({
    x: row.score_a, y: row.score_b, label: row.panorama_id, kind: text(row.label), pid: row.panorama_id,
  })));
}

/**
 * One domain for both axes of the scatter, so the diagonal from corner to corner is "no change":
 * from 0 to the highest score rounded up to a whole thousand.
 */
export function scoreDomain(panoramas) {
  let top = 0;
  for (const row of panoramas || []) {
    if (isNum(row.score_a)) top = Math.max(top, row.score_a);
    if (isNum(row.score_b)) top = Math.max(top, row.score_b);
  }
  return [0, Math.max(1000, Math.ceil(top / 1000) * 1000)];
}

/** The paired comparison in numbers and in one sentence. */
export function pairedView(paired) {
  const p = paired || {};
  const n = numOrNull(p.n) ?? 0;
  const view = {
    n,
    a_better: numOrNull(p.a_better) ?? 0,
    b_better: numOrNull(p.b_better) ?? 0,
    ties: numOrNull(p.ties) ?? 0,
    mean_delta: numOrNull(p.mean_score_delta),
  };
  if (!n) return { ...view, text: "The two sides share no panorama, so there is nothing to pair." };
  const lead = view.b_better > view.a_better ? "B scored higher on more panoramas"
    : view.a_better > view.b_better ? "A scored higher on more panoramas"
      : "Neither side is ahead on the count";
  return {
    ...view,
    text: lead + ": B on " + view.b_better + ", A on " + view.a_better + ", " + view.ties
      + (view.ties === 1 ? " tie" : " ties") + ", over " + n + (n === 1 ? " panorama" : " panoramas") + " both hold.",
  };
}
