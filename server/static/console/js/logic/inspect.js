// Pure logic of the panorama inspector (UI-SPEC 5.6): the rows, totals, filters and labels that
// screens/focus/inspector.js draws from the payload of `GET /api/runs/<id>/pano/<pid>/inspect`.
//
// Nothing here touches the DOM, so `node --test` can load it. Every function accepts a payload
// with missing or damaged parts (a log can stop anywhere) and returns something drawable.

import { fmtClock, fmtInt, fmtMult } from "../format.js";

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const list = (value) => (Array.isArray(value) ? value : []);
const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const text = (value) => (value === null || value === undefined ? "" : String(value));
const enc = encodeURIComponent;

function clip(value, limit) {
  const flat = text(value).replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

// ---------------------------------------------------------------- tabs

/** The tabs in order; these names are the `?tab=` values of the URL contract (A1). */
export const TABS = ["turns", "tools", "images", "ledger", "facts", "truth"];

export const TAB_LABELS = {
  turns: "Turns",
  tools: "Tools",
  images: "Images",
  ledger: "Penalties",
  facts: "Run facts",
  truth: "Ground truth",
};

/** A tab name that can be shown: an unknown name, or `truth` without truth, falls back to turns. */
export function tabName(value, { truth = false } = {}) {
  const name = text(value).trim().toLowerCase();
  if (!TABS.includes(name)) return "turns";
  if (name === "truth" && !truth) return "turns";
  return name;
}

// ---------------------------------------------------------------- the cursor

/**
 * How many of `seqs` (ascending) had happened by `cursor`. A null cursor is the live tail: all of
 * them. Rows after that count are the ones the scrubber dims.
 */
export function countUpTo(seqs, cursor) {
  if (cursor === null || cursor === undefined) return seqs.length;
  const at = Number(cursor);
  if (!Number.isFinite(at)) return seqs.length;
  let lo = 0;
  let hi = seqs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (seqs[mid] <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The last keyframe at or before `seq`; a null seq means the latest. Null when there is none. */
export function keyframeAt(inspect, seq) {
  const frames = list(inspect && inspect.keyframes);
  if (!frames.length) return null;
  const count = countUpTo(frames.map((frame) => frame.seq), seq);
  return count > 0 ? frames[count - 1] : null;
}

/** The timeline entry of the last event at or before `seq` (null seq: the last event). */
export function eventAt(inspect, seq) {
  const timeline = list(inspect && inspect.timeline);
  if (!timeline.length) return null;
  const count = countUpTo(timeline.map((entry) => entry.seq), seq);
  return count > 0 ? timeline[count - 1] : null;
}

/** Events the tile has seen that the loaded payload has not: the "newer events" note. */
export function staleCount(inspect, tile) {
  const loaded = finite(inspect && inspect.last_seq);
  const now = finite(tile && tile.last_seq);
  if (loaded === null || now === null) return 0;
  return Math.max(0, now - loaded);
}

// ---------------------------------------------------------------- small formats

/** A duration in milliseconds: "812 ms", "3.2 s", "1 min 12 s". "–" when unknown. */
export function fmtLatency(ms) {
  const n = finite(ms);
  if (n === null || n < 0) return "–";
  if (n < 1000) return Math.round(n) + " ms";
  if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + " s";
  const total = Math.round(n / 1000);
  return Math.floor(total / 60) + " min " + String(total % 60).padStart(2, "0") + " s";
}

// The image budget is counted in base64 characters, one per byte uploaded, and the limit is
// written "24 MB" in the spec: 24,000,000 of them. Decimal megabytes keep the two in step.
const CHARS_PER_MB = 1e6;

/** Upload size of images: "16.3 MB", "0.29 MB". */
export function fmtPayload(chars) {
  const n = finite(chars);
  if (n === null) return "–";
  const mb = n / CHARS_PER_MB;
  return (mb >= 10 ? mb.toFixed(1) : mb.toFixed(2)) + " MB";
}

/** An angle as the agent wrote it: "273°", "-7.5°". */
export function fmtDeg(value) {
  const n = finite(value);
  return n === null ? "–" : String(Math.round(n * 10) / 10) + "°";
}

/** "02:03" for a moment of the run, or "–". */
export function fmtMoment(tRel) {
  return finite(tRel) === null ? "–" : fmtClock(tRel);
}

// ---------------------------------------------------------------- turns

const STOP_WORDS = {
  tool_use: "called tools",
  end_turn: "ended its turn",
  max_tokens: "output limit reached",
  refusal: "refused",
  pause_turn: "paused",
  stop_sequence: "stop sequence",
};

/** A stop reason in plain words; an unknown one is shown as logged. */
export function stopReasonText(reason) {
  if (reason === null || reason === undefined || reason === "") return "";
  return STOP_WORDS[reason] || text(reason);
}

const turnKey = (segment, turn) => text(segment ?? 1) + ":" + text(turn);

/**
 * One row per model request. `key` is unique across retries of the conversation (a retried
 * panorama starts again at turn 1 in a new segment). `calls` and `views` count what belongs to
 * the turn: the tool calls the model made in it, and the images its request added.
 */
export function turnRows(inspect) {
  const turns = list(inspect && inspect.turns);
  const calls = new Map();
  for (const tool of list(inspect && inspect.tools)) {
    const key = turnKey(tool.segment, tool.turn);
    calls.set(key, (calls.get(key) || 0) + 1);
  }
  const views = new Map();
  for (const image of list(inspect && inspect.images)) {
    const key = turnKey(image.segment, image.turn);
    views.set(key, (views.get(key) || 0) + 1);
  }
  let previousSegment = null;
  return turns.map((turn, index) => {
    const segment = finite(turn.segment) ?? 1;
    const key = turnKey(segment, turn.turn);
    const tokens = turn.tokens && typeof turn.tokens === "object"
      ? {
        input: finite(turn.tokens.input) ?? 0,
        cached: finite(turn.tokens.cached) ?? 0,
        output: finite(turn.tokens.output) ?? 0,
        reasoning: finite(turn.tokens.reasoning) ?? 0,
      }
      : null;
    const row = {
      index,
      key,
      turn: turn.turn ?? index + 1,
      segment,
      newSegment: previousSegment !== null && segment !== previousSegment,
      seq: finite(turn.seq_request) ?? 0,
      seqResponse: finite(turn.seq_response),
      t_rel_s: finite(turn.t_rel_s),
      messages: finite(turn.message_count),
      images: finite(turn.image_count),
      imagesAdded: finite(turn.images_added) ?? views.get(key) ?? 0,
      payloadChars: finite(turn.image_payload_chars),
      tokens,
      latencyMs: finite(turn.latency_ms),
      costUsd: finite(turn.cost_usd),
      stopReason: turn.stop_reason ?? null,
      error: turn.error ? text(turn.error) : null,
      retries: list(turn.retries).map((retry) => ({
        seq: finite(retry.seq),
        t_rel_s: finite(retry.t_rel_s),
        message: text(retry.message) || "the request failed",
        delayS: finite(retry.delay_s),
        attempt: finite(retry.attempt),
        statusCode: finite(retry.status_code),
      })),
      calls: calls.get(key) || 0,
      views: views.get(key) || 0,
      // no response and no error: the model is still answering (or the log stops here)
      pending: finite(turn.seq_response) === null && !turn.error,
    };
    previousSegment = segment;
    return row;
  });
}

/** Sums over the turns, for the totals line. */
export function turnTotals(rows) {
  const totals = {
    turns: rows.length,
    answered: 0,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    costUsd: 0,
    latencyMs: 0,
    retries: 0,
    errors: 0,
    cachedShare: null,
    meanLatencyMs: null,
    slowest: null,
    dearest: null,
  };
  for (const row of rows) {
    totals.retries += row.retries.length;
    if (row.error) totals.errors += 1;
    if (!row.tokens) continue;
    totals.answered += 1;
    totals.input += row.tokens.input;
    totals.cached += row.tokens.cached;
    totals.output += row.tokens.output;
    totals.reasoning += row.tokens.reasoning;
    totals.costUsd += row.costUsd ?? 0;
    totals.latencyMs += row.latencyMs ?? 0;
    if (row.latencyMs !== null && (totals.slowest === null || row.latencyMs > rows[totals.slowest].latencyMs)) totals.slowest = row.index;
    if (row.costUsd !== null && (totals.dearest === null || row.costUsd > rows[totals.dearest].costUsd)) totals.dearest = row.index;
  }
  if (totals.input > 0) totals.cachedShare = totals.cached / totals.input;
  if (totals.answered > 0) totals.meanLatencyMs = totals.latencyMs / totals.answered;
  return totals;
}

/** Index of the turn in progress at `cursor` (null cursor: the last turn); -1 before the first. */
export function turnIndexAt(rows, cursor) {
  return countUpTo(rows.map((row) => row.seq), cursor) - 1;
}

/** Bars for the cost and latency chart: one per turn, latency in seconds. */
export function turnBars(rows) {
  const repeated = rows.some((row) => row.segment !== rows[0].segment);
  return rows.map((row) => ({
    label: repeated ? row.segment + "." + row.turn : text(row.turn),
    value: row.costUsd ?? 0,
    value2: row.latencyMs === null ? 0 : row.latencyMs / 1000,
  }));
}

/** "39 messages, 74 images (2 new), 16.3 MB": what one request carried. */
export function requestText(row) {
  const parts = [];
  if (row.messages !== null) parts.push(fmtInt(row.messages) + (row.messages === 1 ? " message" : " messages"));
  if (row.images !== null) {
    const added = row.imagesAdded ? " (" + fmtInt(row.imagesAdded) + " new)" : "";
    parts.push(fmtInt(row.images) + (row.images === 1 ? " image" : " images") + added);
  }
  if (row.payloadChars !== null) parts.push(fmtPayload(row.payloadChars));
  return parts.length ? parts.join(", ") : "–";
}

// ---------------------------------------------------------------- tools

function hypothesesSummary(input) {
  const hyps = list(input.hypotheses);
  if (!hyps.length) return "";
  const top = hyps.reduce((best, hyp) => ((finite(hyp && hyp.probability) ?? 0) > (finite(best && best.probability) ?? 0) ? hyp : best), hyps[0]);
  const label = top && top.label ? ": " + top.label : "";
  return hyps.length + (hyps.length === 1 ? " hypothesis" : " hypotheses") + label;
}

function coords(input) {
  const lat = finite(input.lat);
  const lng = finite(input.lng);
  return lat === null || lng === null ? "" : lat.toFixed(6) + ", " + lng.toFixed(6);
}

const INPUT_SUMMARY = {
  view_crop: (input) => ["yaw", "pitch", "fov"].filter((key) => finite(input[key]) !== null).map((key) => key + " " + fmtDeg(input[key])).join(", "),
  search_places: (input) => text(input.query),
  overpass_query: (input) => text(input.description || input.ql || input.query),
  streetview_lookup: (input) => {
    const parts = [coords(input)];
    if (finite(input.radius_m) !== null) parts.push("within " + input.radius_m + " m");
    if (list(input.headings).length) parts.push("headings " + input.headings.join(", "));
    return parts.filter(Boolean).join(", ");
  },
  satellite_tile: (input) => [coords(input), finite(input.zoom) !== null ? "zoom " + input.zoom : ""].filter(Boolean).join(", "),
  web_search: (input) => text(input.query || list(input.queries)[0] || input.url),
  update_candidates: hypothesesSummary,
  submit_locations: hypothesesSummary,
  ask_multiple_choice: (input) => text(input.question),
};

/** One line that says what a call asked for; the whole input is in the detail pane. */
export function inputSummary(tool, input) {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") return clip(input, 160);
  const known = INPUT_SUMMARY[tool];
  let summary = "";
  if (known) {
    try {
      summary = known(input) || "";
    } catch (_) {
      summary = "";
    }
  }
  if (!summary) {
    try {
      summary = JSON.stringify(input);
    } catch (_) {
      summary = "";
    }
  }
  return clip(summary, 160);
}

const COMPARE_TOOLS = new Set(["streetview_lookup", "satellite_tile"]);

const IMAGE_SOURCES = {
  google: "Google Street View",
  mapillary: "Mapillary",
  esri_world_imagery: "Esri World Imagery",
};

/** Where a returned image came from, in words ("Google Street View, heading 270°"). */
export function imageOrigin(image) {
  const parts = [];
  if (image && image.source) parts.push(IMAGE_SOURCES[image.source] || text(image.source));
  if (image && finite(image.heading) !== null) parts.push("heading " + fmtDeg(image.heading));
  return parts.join(", ");
}

/**
 * One row per tool call, in the order the calls were made (by seq; the cursor's binary search
 * relies on it). Hosted web searches run inside a model turn and share its seq, so `key` adds a
 * counter to stay unique.
 */
export function toolRows(inspect) {
  const seen = new Map();
  const rows = list(inspect && inspect.tools).filter((tool) => tool && typeof tool === "object").map((tool) => {
    const seq = finite(tool.seq_call) ?? 0;
    const nth = seen.get(seq) || 0;
    seen.set(seq, nth + 1);
    const name = text(tool.tool) || "tool";
    const images = list(tool.images).filter((image) => image && typeof image.sha256 === "string");
    const seqResult = finite(tool.seq_result);
    return {
      index: 0,
      key: seq + "." + nth,
      seq,
      seqResult,
      turn: tool.turn ?? null,
      segment: finite(tool.segment) ?? 1,
      turnKey: turnKey(tool.segment, tool.turn),
      t_rel_s: finite(tool.t_rel_s),
      tool: name,
      input: tool.input ?? null,
      output: tool.output ?? null,
      isError: !!tool.is_error,
      durationMs: finite(tool.duration_ms),
      urls: list(tool.urls).filter((url) => typeof url === "string" && url),
      cacheHit: typeof tool.cache_hit === "boolean" ? tool.cache_hit : null,
      images,
      hosted: !!tool.hosted,
      cropN: name === "view_crop" ? finite(tool.crop_n) : null,
      pending: seqResult === null,
      summary: inputSummary(name, tool.input),
      comparable: images.length > 0 && (COMPARE_TOOLS.has(name) || images.some((image) => image.source || finite(image.heading) !== null)),
    };
  });
  rows.sort((a, b) => a.seq - b.seq); // stable: calls of one seq keep the order they were logged in
  rows.forEach((row, index) => {
    row.index = index;
  });
  return rows;
}

/** Tool names with how often each was called, most used first: the filter's choices. */
export function toolNames(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.tool, (counts.get(row.tool) || 0) + 1);
  return Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function searchable(row) {
  if (row.search === undefined) {
    let body = "";
    try {
      body = JSON.stringify(row.input ?? "") + " " + (typeof row.output === "string" ? row.output : JSON.stringify(row.output ?? ""));
    } catch (_) {
      body = "";
    }
    row.search = (row.tool + " " + body + " " + row.urls.join(" ")).toLowerCase();
  }
  return row.search;
}

/**
 * The calls that pass the filter: `tool` (a name, "" for all), `turn` (a turn key, "" for all),
 * `text` (every word must appear in the name, input, output or URLs), `errors` and `cached`.
 */
export function filterTools(rows, { tool = "", turn = "", text: needle = "", errors = false, cached = false } = {}) {
  const words = text(needle).toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (tool && row.tool !== tool) return false;
    if (turn && row.turnKey !== turn) return false;
    if (errors && !row.isError) return false;
    if (cached && row.cacheHit !== true) return false;
    if (!words.length) return true;
    const haystack = searchable(row);
    return words.every((word) => haystack.includes(word));
  });
}

/** Index in `rows` of the last call made at or before `cursor`; -1 when there is none. */
export function toolIndexAt(rows, cursor) {
  return countUpTo(rows.map((row) => row.seq), cursor) - 1;
}

// A log keeps long outputs as a clipped copy that ends in an ellipsis, so the JSON text of a
// string can stop before its closing quote.
function parseClipped(raw) {
  if (!raw.startsWith('"') || !raw.endsWith("…")) return null;
  let body = raw.slice(0, -1);
  // a cut can fall inside an escape: drop the dangling backslashes (and a half-written \uXXXX)
  body = body.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
  const slashes = /\\*$/.exec(body)[0].length;
  if (slashes % 2 === 1) body = body.slice(0, -1);
  try {
    const value = JSON.parse(body + '"');
    return typeof value === "string" ? value + "…" : null;
  } catch (_) {
    return null;
  }
}

/**
 * What a call returned, ready to draw: `{kind: "none"}`, `{kind: "text", text, clipped}` or
 * `{kind: "json", value}`. Outputs are logged either as they are or as JSON text of them.
 */
export function parseOutput(output) {
  if (output === null || output === undefined) return { kind: "none" };
  if (typeof output !== "string") {
    return typeof output === "object" ? { kind: "json", value: output } : { kind: "text", text: String(output), clipped: false };
  }
  const raw = output.trim();
  if (!raw) return { kind: "none" };
  if (/^["[{]|^(null|true|false|-?\d)/.test(raw)) {
    try {
      const value = JSON.parse(raw);
      if (value === null) return { kind: "none" };
      if (typeof value === "string") return { kind: "text", text: value, clipped: value.endsWith("…") };
      if (typeof value === "object") return { kind: "json", value };
      return { kind: "text", text: String(value), clipped: false };
    } catch (_) {
      const rescued = parseClipped(raw);
      if (rescued !== null) return { kind: "text", text: rescued, clipped: true };
    }
  }
  return { kind: "text", text: output, clipped: raw.endsWith("…") };
}

// ---------------------------------------------------------------- crops and views

/**
 * Crop number by the seq of its `view_crop` call: the number drawn on that crop's footprint in the
 * panorama viewer. The payload carries it (`crop_n`) and the tile's `crops` may be ahead of the
 * payload on a live run. A payload without either gets the same numbering rebuilt: every
 * view_crop call counts, failed ones included, in the order they were made.
 */
export function cropNumbers(inspect, tile) {
  const numbers = new Map();
  const tools = list(inspect && inspect.tools);
  for (const tool of tools) {
    if (tool && finite(tool.seq_call) !== null && finite(tool.crop_n) !== null) numbers.set(tool.seq_call, tool.crop_n);
  }
  for (const crop of list(tile && tile.crops)) {
    if (crop && finite(crop.seq_call) !== null && finite(crop.n) !== null) numbers.set(crop.seq_call, crop.n);
  }
  if (numbers.size) return numbers;
  let n = 0;
  for (const tool of tools) {
    if (!tool || tool.tool !== "view_crop") continue;
    n += 1;
    if (finite(tool.seq_call) !== null && !tool.is_error && list(tool.images).length) numbers.set(tool.seq_call, n);
  }
  return numbers;
}

const SOURCE_LABELS = {
  initial: "initial view",
  view_crop: "crop",
  streetview_lookup: "street-level",
  satellite_tile: "satellite",
  tool: "tool result",
};

/** What kind of view an image is, in the gallery's words. */
export function sourceLabel(source) {
  return SOURCE_LABELS[source] || text(source) || "view";
}

/**
 * The image gallery: every view sent to the model, in order. The request only records the hash
 * of an image, so yaw, pitch and FOV (and where a street-level or satellite image came from) are
 * filled in from the tool call that returned it.
 */
export function galleryRows(inspect, tile) {
  const numbers = cropNumbers(inspect, tile);
  const bySeq = new Map();
  for (const tool of list(inspect && inspect.tools)) {
    if (finite(tool.seq_call) !== null && !bySeq.has(tool.seq_call)) bySeq.set(tool.seq_call, tool);
  }
  return list(inspect && inspect.images).filter((image) => image && typeof image.sha256 === "string").map((image, index) => {
    const call = finite(image.seq_call) !== null ? bySeq.get(image.seq_call) : null;
    const returned = call ? list(call.images).find((item) => item && item.sha256 === image.sha256) : null;
    const pick = (key) => finite(image[key]) ?? finite(returned && returned[key]);
    const source = text(image.source) || "tool";
    return {
      index,
      key: (finite(image.n) ?? index + 1) + ":" + image.sha256,
      n: finite(image.n) ?? index + 1,
      seq: finite(image.seq) ?? 0,
      seqCall: finite(image.seq_call),
      turn: image.turn ?? null,
      segment: finite(image.segment) ?? 1,
      turnKey: turnKey(image.segment, image.turn),
      sha256: image.sha256,
      yaw: pick("yaw"),
      pitch: pick("pitch"),
      fov: pick("fov"),
      width: finite(image.width) ?? finite(returned && returned.width),
      height: finite(image.height) ?? finite(returned && returned.height),
      estTokens: finite(image.est_tokens),
      payloadChars: finite(image.payload_chars),
      source,
      sourceText: sourceLabel(source),
      origin: returned ? imageOrigin(returned) : "",
      cropN: source === "view_crop" ? finite(image.crop_n) ?? (finite(image.seq_call) !== null ? numbers.get(image.seq_call) ?? null : null) : null,
    };
  });
}

/** Sources present in the gallery with their counts, in order of first appearance. */
export function gallerySources(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.source, (counts.get(row.source) || 0) + 1);
  return Array.from(counts, ([source, count]) => ({ source, label: sourceLabel(source), count }));
}

export function filterGallery(rows, { source = "", turn = "" } = {}) {
  return rows.filter((row) => (!source || row.source === source) && (!turn || row.turnKey === turn));
}

/** Count, estimated tokens and upload size of a set of gallery rows. */
export function galleryTotals(rows) {
  const totals = { count: rows.length, tokens: 0, chars: 0, unknownTokens: 0 };
  for (const row of rows) {
    if (row.estTokens === null) totals.unknownTokens += 1;
    else totals.tokens += row.estTokens;
    totals.chars += row.payloadChars ?? 0;
  }
  return totals;
}

/** "yaw 273° · pitch -7° · FOV 20°" of a view, or "" when the log holds no angle for it. */
export function anglesText(row) {
  const parts = [];
  if (row.yaw !== null && row.yaw !== undefined) parts.push("yaw " + fmtDeg(row.yaw));
  if (row.pitch !== null && row.pitch !== undefined) parts.push("pitch " + fmtDeg(row.pitch));
  if (row.fov !== null && row.fov !== undefined) parts.push("FOV " + fmtDeg(row.fov));
  return parts.join(" · ");
}

/**
 * The line under a gallery view that says where it points: its angles, else where a street-level
 * or satellite image came from, else what kind of view has no angles at all.
 */
export function aimText(row) {
  const angles = anglesText(row);
  if (angles) return angles;
  if (row.origin) return row.origin;
  return row.source === "initial" ? "the whole panorama, no angles" : "angles not recorded";
}

/** "#12 · crop 3 · yaw 273° · pitch -7° · FOV 20° · 682 × 682 px · about 581 tokens". */
export function viewCaption(row) {
  const parts = ["#" + row.n];
  parts.push(row.cropN !== null && row.cropN !== undefined ? "crop " + row.cropN : row.sourceText);
  if (row.origin) parts.push(row.origin);
  if (anglesText(row)) parts.push(anglesText(row));
  if (row.width && row.height) parts.push(row.width + " × " + row.height + " px");
  if (row.estTokens !== null && row.estTokens !== undefined) parts.push("about " + fmtInt(row.estTokens) + " tokens");
  return parts.join(" · ");
}

/**
 * Views of the panorama itself that a street-level or satellite result can be set beside: the
 * initial views and every successful view_crop, in order. Crops come from the tool calls, so one
 * requested in the same turn as the lookup is there even before the model has been sent it.
 */
export function panoramaViews(inspect, tile) {
  const numbers = cropNumbers(inspect, tile);
  const views = [];
  let initial = 0;
  for (const image of list(inspect && inspect.images)) {
    if (!image || image.source !== "initial" || typeof image.sha256 !== "string") continue;
    initial += 1;
    views.push({
      key: "i" + initial,
      kind: "initial",
      seq: finite(image.seq) ?? 0,
      sha256: image.sha256,
      yaw: finite(image.yaw),
      pitch: finite(image.pitch),
      fov: finite(image.fov),
      width: finite(image.width),
      height: finite(image.height),
      cropN: null,
      label: (initial === 1 ? "Overview" : "Initial view " + initial) + (image.width && image.height ? " (" + image.width + " × " + image.height + " px)" : ""),
    });
  }
  for (const tool of list(inspect && inspect.tools)) {
    if (tool.tool !== "view_crop" || tool.is_error) continue;
    const image = list(tool.images).find((item) => item && typeof item.sha256 === "string");
    if (!image || finite(tool.seq_call) === null) continue;
    const n = numbers.get(tool.seq_call) ?? null;
    const angles = ["yaw", "pitch", "fov"].filter((key) => finite(image[key]) !== null)
      .map((key) => (key === "fov" ? "FOV" : key) + " " + fmtDeg(image[key])).join(", ");
    views.push({
      key: "c" + tool.seq_call,
      kind: "crop",
      seq: tool.seq_call,
      sha256: image.sha256,
      yaw: finite(image.yaw),
      pitch: finite(image.pitch),
      fov: finite(image.fov),
      width: finite(image.width),
      height: finite(image.height),
      cropN: n,
      label: "Crop" + (n === null ? "" : " " + n) + (angles ? ": " + angles : ""),
    });
  }
  return views;
}

/**
 * The view to put beside the result of `row` by default: the crop the agent requested just
 * before that call, else its first crop, else the overview. Null when the log has no view at all.
 */
export function defaultComparison(views, row) {
  const crops = views.filter((view) => view.kind === "crop");
  const before = crops.filter((view) => view.seq < row.seq);
  if (before.length) return before[before.length - 1];
  if (crops.length) return crops[0];
  return views.length ? views[0] : null;
}

// ---------------------------------------------------------------- image budget

/**
 * The two budget meters: images of the request limit and megabytes of the payload limit. `level`
 * is `ok` below 80%, `warn` from there, `bad` at the limit (the loop then withholds every further
 * image from the model and tells it so).
 */
export function budgetMeters(budget) {
  const b = record(budget);
  const meter = (key, label, used, max, format) => {
    const u = finite(used) ?? 0;
    const m = finite(max);
    const share = m && m > 0 ? Math.min(1, u / m) : null;
    const level = share === null ? "ok" : share >= 1 ? "bad" : share >= 0.8 ? "warn" : "ok";
    const state = level === "bad" ? "at the limit: further images are withheld from the model" : level === "warn" ? "near the limit" : "within the limit";
    // rounded down, so "100%" is only ever said of a budget that is really used up
    const percent = share === null ? "" : Math.floor(share * 100 + 1e-9) + "%";
    return { key, label, used: u, max: m, share, level, state, percent, text: format(u, m) };
  };
  const mb = (chars) => (chars / CHARS_PER_MB).toFixed(1);
  return [
    meter("count", "Images in the conversation", b.count, b.max_count, (u, m) => fmtInt(u) + (m === null ? "" : " of " + fmtInt(m))),
    meter("payload", "Image upload size", b.payload_chars, b.max_payload_chars, (u, m) => mb(u) + (m === null ? " MB" : " of " + mb(m).replace(/\.0$/, "") + " MB")),
  ];
}

// ---------------------------------------------------------------- penalty ledger

const CHARGE_LABELS = { cue: "Cue", mcq: "MCQ asked", geocode: "Last-resort geocode" };
const CHARGE_SHORT = { cue: "cue", mcq: "MCQ", geocode: "geocode" };

function factorOf(before, after) {
  if (before === null || after === null || before === 0) return null;
  return Math.round((after / before) * 1000) / 1000;
}

const bare = (value) => fmtMult(value).slice(1); // "0.8" from "x0.8"

const factorText = (row) => (row.factor === null ? "" : bare(row.factor) + " ") + row.short;

/**
 * One row per charge, in order. `after` is the multiplier once that charge is applied and
 * `product` writes out how it came about: "0.95 MCQ x 0.8 cue = x0.76".
 */
export function ledgerRows(ledger) {
  const rows = [];
  list(ledger).filter((entry) => entry && typeof entry === "object").forEach((entry, index) => {
    const before = finite(entry.before);
    const after = finite(entry.after);
    const kind = text(entry.kind);
    const row = {
      index,
      key: (finite(entry.seq) ?? index) + ":" + index,
      seq: finite(entry.seq) ?? 0,
      ts: entry.ts ?? null,
      t_rel_s: finite(entry.t_rel_s),
      kind,
      label: CHARGE_LABELS[kind] || kind || "charge",
      short: CHARGE_SHORT[kind] || kind || "charge",
      factor: factorOf(before, after),
      before,
      after,
      product: "",
    };
    rows.push(row);
    row.product = rows.map(factorText).join(" x ") + (after === null ? "" : " = " + fmtMult(after));
  });
  return rows;
}

/**
 * The multiplier at `cursor` (null: now) and how it came about:
 * `{count, multiplier, text}` with text "No penalties: x1.0" or "x0.76 = 0.8 cue x 0.95 MCQ".
 */
export function ledgerSummary(rows, cursor = null) {
  const count = countUpTo(rows.map((row) => row.seq), cursor);
  if (!count) return { count: 0, multiplier: 1, text: "No penalties: x1.0" };
  const charged = rows.slice(0, count);
  const multiplier = charged[count - 1].after ?? 1;
  return { count, multiplier, text: fmtMult(multiplier) + " = " + charged.map(factorText).join(" x ") };
}

// ---------------------------------------------------------------- run facts

const onOff = (value, on, off) => (value === true ? on : value === false ? off : null);

/** The run's flags in words, in a fixed order; flags the log does not carry are left out. */
export function flagRows(flags) {
  const f = record(flags);
  const rows = [];
  const add = (key, label, value) => {
    if (value !== null && value !== undefined && value !== "") rows.push({ key, label, value: text(value) });
  };
  add("allow_web", "External tools", onOff(f.allow_web, "on", "off: no web search, map or imagery lookups"));
  add("no_human", "Human channels", onOff(f.no_human, "off: autonomous", "on: MCQ, cue and geocode available"));
  add("hedge", "Hedge", onOff(f.hedge, "on: the list may be split between the top two places", "off: best point repeated"));
  add("allow_duplicates", "Duplicate entries", onOff(f.allow_duplicates, "allowed", "not allowed"));
  add("penalty_scope", "Penalty scope", f.penalty_scope);
  add("max_mcq", "Questions allowed", finite(f.max_mcq) === null ? null : fmtInt(f.max_mcq));
  if (list(f.disabled_tools).length) add("disabled_tools", "Tools switched off", f.disabled_tools.join(", "));
  const known = new Set(["allow_web", "no_human", "hedge", "allow_duplicates", "penalty_scope", "max_mcq", "disabled_tools"]);
  for (const [key, value] of Object.entries(f)) {
    if (known.has(key)) continue;
    add(key, key, typeof value === "object" ? JSON.stringify(value) : value);
  }
  return rows;
}

/** The budget of the panorama in words. */
export function budgetRows(budget) {
  const b = record(budget);
  const rows = [];
  if (b.effort) rows.push({ key: "effort", label: "Effort", value: text(b.effort) });
  if (finite(b.soft_deadline_s) !== null) rows.push({ key: "soft", label: "Soft deadline", value: fmtClock(b.soft_deadline_s) });
  if (finite(b.hard_deadline_s) !== null) rows.push({ key: "hard", label: "Hard deadline", value: fmtClock(b.hard_deadline_s) });
  if (finite(b.max_turns) !== null) rows.push({ key: "turns", label: "Turn limit", value: fmtInt(b.max_turns) });
  if (finite(b.max_spend_usd) !== null) rows.push({ key: "spend", label: "Spend cap", value: "$" + b.max_spend_usd.toFixed(2) });
  return rows;
}

const SOURCE_WORDS = {
  filename: "parsed from the file name",
  manifest: "read from the manifest",
  sidecar: "read from the file's sidecar",
  directory: "taken from the directory name",
  folder: "taken from the directory name",
  operator: "set by the operator before launch",
  operator_bulk: "set by the operator for every unlabelled panorama at once",
  default: "default applied (the files did not say)",
  cli: "given on the command line",
  none: "not found in the files",
};

/** Where a task value came from, in words; an unknown source is shown as logged. */
export function sourceWords(source) {
  if (source === null || source === undefined || source === "") return "not recorded";
  return SOURCE_WORDS[source] || text(source);
}

/**
 * Label, timestamp and Special One of the panorama with where each came from. Logs written by the
 * command line carry no provenance: the value is still shown, the source reads "not recorded".
 */
export function provenanceRows(facts) {
  const f = record(facts);
  const provenance = record(f.provenance);
  const field = (key, label, fallback, show) => {
    const entry = record(provenance[key]);
    const value = entry.value !== undefined ? entry.value : fallback;
    return {
      key,
      label,
      value: show(value),
      source: sourceWords(entry.source),
      recorded: entry.source !== undefined && entry.source !== null,
      parsed: entry.parsed === null || entry.parsed === undefined || entry.parsed === value ? null : show(entry.parsed),
    };
  };
  return [
    field("label", "Label", f.label, (value) => (value === null || value === undefined || value === "" ? "none" : text(value))),
    field("timestamp", "Capture timestamp", f.capture_timestamp, (value) => (value === null || value === undefined || value === "" ? "none" : text(value))),
    field("special", "Special One", f.special, (value) => (value === true ? "yes: score x3" : value === false ? "no" : "not recorded")),
  ];
}

/** The tool definitions as the text that is copied: pretty-printed JSON, exactly the logged list. */
export function toolsText(facts) {
  const tools = record(facts).tools;
  if (tools === null || tools === undefined) return "";
  try {
    return JSON.stringify(tools, null, 2);
  } catch (_) {
    return "";
  }
}

/** Names of the tools sent to the model, in order. */
export function toolDefinitionNames(facts) {
  return list(record(facts).tools).map((tool) => text(tool && (tool.name || (tool.function && tool.function.name) || tool.type))).filter(Boolean);
}

// ---------------------------------------------------------------- downloads

const DOWNLOADS = [
  { what: "export", label: "Export JSON", hint: "This panorama's export file, as it would be submitted." },
  { what: "events", label: "events.jsonl", hint: "The full event log of this panorama, one JSON object per line." },
  { what: "images", label: "Images (zip)", hint: "Every view the run saved for this panorama." },
];

/** The name the server gives a download, for a file saved by the page. */
export function downloadName(runId, pid, what) {
  // ids are checked by the server; a character a file name cannot hold is still replaced here
  const safe = (value) => text(value).replace(/[^A-Za-z0-9._-]/g, "_") || "panorama";
  if (what === "events") return safe(pid) + ".events.jsonl";
  if (what === "images") return safe(runId) + "_" + safe(pid) + "_images.zip";
  return safe(pid) + ".json";
}

/**
 * The three downloads of a panorama. `href` is always the app's own endpoint; `disabled` is the
 * reason a file cannot exist yet, when the payload already shows it.
 */
export function downloadItems(runId, pid, inspect) {
  const base = "/api/runs/" + enc(runId) + "/pano/" + enc(pid) + "/download?what=";
  const events = list(inspect && inspect.timeline).length;
  const images = list(inspect && inspect.images).length;
  return DOWNLOADS.map((item) => {
    let disabled = null;
    if (inspect && item.what === "events" && !events) disabled = "This panorama has not written an event log yet.";
    if (inspect && item.what === "images" && !images) disabled = "The run saved no images for this panorama.";
    return { ...item, href: base + item.what, filename: downloadName(runId, pid, item.what), disabled };
  });
}

// ---------------------------------------------------------------- ground truth

/**
 * May truth be shown for this run? The server is the gate (it answers 403 for every other run);
 * this is the page's own second check, so truth never renders beside a human channel even if a
 * payload reached it by mistake. Unknown run and tile: the server's answer stands.
 */
export function truthAllowed(run, tile) {
  if (tile && tile.human_enabled === true) return false;
  if (run && run.no_human === false) return false;
  if (run && run.kind && run.kind !== "eval") return false;
  return true;
}

/** This panorama's entry of a truth payload (or the entry itself, if that is what was given). */
export function truthFor(truth, pid) {
  if (!truth || typeof truth !== "object") return null;
  if (truth.panoramas && typeof truth.panoramas === "object") {
    const entry = truth.panoramas[pid];
    return entry && typeof entry === "object" ? entry : null;
  }
  return finite(truth.lat) !== null && finite(truth.lng) !== null ? truth : null;
}

/** "1–3, 7" for a list of ranks. */
export function rankText(ranks) {
  const sorted = Array.from(new Set(ranks)).sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let previous = null;
  for (const rank of sorted) {
    if (previous !== null && rank === previous + 1) {
      previous = rank;
      continue;
    }
    if (start !== null) parts.push(start === previous ? String(start) : start + "–" + previous);
    start = rank;
    previous = rank;
  }
  if (start !== null) parts.push(start === previous ? String(start) : start + "–" + previous);
  return parts.join(", ");
}

/** The answer list collapsed to its distinct points, each with its ranks, distance and theta. */
export function distinctAnswers(entries) {
  const groups = new Map();
  list(entries).forEach((entry, index) => {
    if (!entry || finite(entry.lat) === null || finite(entry.lng) === null) return;
    const key = entry.lat.toFixed(6) + "," + entry.lng.toFixed(6);
    let group = groups.get(key);
    if (!group) {
      group = { key, lat: entry.lat, lng: entry.lng, ranks: [], distanceM: finite(entry.distance_m), theta: finite(entry.theta) };
      groups.set(key, group);
    }
    group.ranks.push(finite(entry.rank) ?? index + 1);
  });
  return Array.from(groups.values()).map((group) => ({ ...group, rankText: rankText(group.ranks) }));
}

const BAND_WORDS = { "100m": "within 100 m", "1km": "within 1 km", "10km": "within 10 km", far: "more than 10 km away" };

/** The headline numbers of the truth tab. */
export function truthStats(entry) {
  const e = record(entry);
  const answers = distinctAnswers(e.entries);
  const nearest = answers.reduce((best, group) => (group.distanceM !== null && (best === null || group.distanceM < best.distanceM) ? group : best), null);
  return {
    label: e.label ? text(e.label) : null,
    rank1DistanceM: finite(e.rank1_distance_m),
    score: finite(e.score),
    maxScore: finite(e.max_score),
    share: finite(e.share),
    band: e.band ? text(e.band) : null,
    bandText: BAND_WORDS[e.band] || null,
    distinct: answers.length,
    entries: list(e.entries).length,
    nearest,
  };
}

/**
 * The distance of the top hypothesis over the run, ready for the line chart. The x axis is the
 * elapsed time while the log is one conversation; after a retry the clock starts again, so the
 * axis falls back to the event number, which always increases.
 *   {axis: "time"|"seq", points: [[x, distance_m]], log, xAt(seq) -> x|null, seqAt(x) -> seq|null}
 */
export function truthChart(entry, inspect) {
  const series = list(record(entry).top_distance_series)
    .filter((point) => point && finite(point.seq) !== null && finite(point.distance_m) !== null)
    .sort((a, b) => a.seq - b.seq);
  const timeline = list(inspect && inspect.timeline).filter((item) => item && finite(item.seq) !== null);
  let monotonic = (finite(inspect && inspect.segments) ?? 1) <= 1 && series.every((point) => finite(point.t_rel_s) !== null);
  for (let i = 1; monotonic && i < series.length; i += 1) {
    if (series[i].t_rel_s < series[i - 1].t_rel_s) monotonic = false;
  }
  const axis = monotonic && series.length ? "time" : "seq";
  const xOf = (point) => (axis === "time" ? point.t_rel_s : point.seq);
  const points = series.map((point) => [xOf(point), point.distance_m]);
  const distances = series.map((point) => point.distance_m).filter((d) => d > 0);
  const spread = distances.length ? Math.max(...distances) / Math.min(...distances) : 1;
  const seqs = timeline.map((item) => item.seq);
  return {
    axis,
    points,
    // from continents to a street corner: a linear axis would flatten everything after turn 1
    log: distances.length === series.length && spread >= 50,
    xAt(seq) {
      if (seq === null || seq === undefined || !series.length) return null;
      if (axis === "seq") return Number(seq);
      const count = countUpTo(seqs, seq);
      if (count > 0 && finite(timeline[count - 1].t_rel_s) !== null) return timeline[count - 1].t_rel_s;
      const known = countUpTo(series.map((point) => point.seq), seq);
      return known > 0 ? series[known - 1].t_rel_s : null;
    },
    seqAt(x) {
      if (!series.length || finite(x) === null) return null;
      let best = series[0];
      for (const point of series) {
        if (Math.abs(xOf(point) - x) < Math.abs(xOf(best) - x)) best = point;
      }
      return best.seq;
    },
  };
}
