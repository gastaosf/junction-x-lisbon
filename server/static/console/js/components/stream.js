// The reasoning stream of one panorama (UI-SPEC 5.5; contract 6.1 with amendments A9, A12, A30).
//
// One entry per Digest: time, type and readable lines, with thumbnails of the views the model was
// sent. Category chips and a search box filter the digests that are loaded; the list follows the
// tail until the operator scrolls up; any entry opens its full event JSON in the shell side panel.
//
// Every digest is kept in memory, but beyond a few hundred entries only a window of them is in
// the DOM. The arithmetic for that window (buildOffsets, indexAt, windowRange, anchorAt) is pure
// and sits at the top of this file with the other pure helpers, so `node --test` can import it
// without a DOM.
//
// Rule compliance: nothing typed here reaches the agent. The search box filters what is already
// on the page and is never sent anywhere. Text from the model, a tool or a log goes in as text
// nodes; image URLs are built only from a checked sha256 against the app's own endpoint (A30).

import { api, errorText, panoUrl } from "../api.js";
import { badge, copyButton, debounce, el, icon, replace } from "../dom.js";
import { fmtClock, fmtInt, fmtMult, fmtTime } from "../format.js";
import { store } from "../store.js";
import { lightbox, sidePanel } from "./shell.js";

// ================================================================ pure: categories and labels

/** Digest categories, in the order of the filter chips. */
export const CATEGORIES = ["reasoning", "tools", "images", "human", "harness", "errors"];

const CATEGORY_INFO = {
  reasoning: { label: "Reasoning", icon: "list" },
  tools: { label: "Tools", icon: "settings" },
  images: { label: "Images", icon: "image" },
  human: { label: "Human", icon: "flag" },
  harness: { label: "Harness", icon: "layers" },
  errors: { label: "Errors", icon: "alert" },
};

const LINE_KINDS = new Set(["thinking", "text", "tool", "result", "error", "human", "harness"]);

const TYPE_LABELS = {
  run_start: "Start",
  run_end: "End",
  run_resumed: "Resumed",
  retry: "Retry",
  model_request: "Request",
  model_response: "Agent",
  tool_call: "Tool call",
  tool_result: "Result",
  candidates_update: "Hypotheses",
  final_submission: "Final answer",
  mcq_asked: "MCQ asked",
  mcq_answered: "MCQ answer",
  mcq_toggle: "Questions toggle",
  human_cue: "Cue",
  human_cue_delivered: "Cue delivered",
  human_cue_undelivered: "Cue undelivered",
  human_cue_rejected: "Cue rejected",
  human_geocode: "Human geocode",
  soft_deadline_notice: "Soft deadline",
  operator_stop: "Operator stop",
  api_retry: "API retry",
  api_error: "API error",
  harness_error: "Harness error",
};

/** A readable name for an event type; unknown types are shown as their own words. */
export function typeLabel(type) {
  const key = String(type ?? "");
  if (Object.prototype.hasOwnProperty.call(TYPE_LABELS, key)) return TYPE_LABELS[key];
  const words = key.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Event";
}

/** The label of an entry: the type, with the failure spelled out so red is never the only sign. */
export function entryLabel(digest) {
  if (digest.is_error && digest.type === "tool_result") return "Tool error";
  if (digest.is_error && digest.type === "model_response") return "Agent refusal";
  return typeLabel(digest.type);
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function wholeOrNull(value) {
  const n = finite(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

/** A duration in milliseconds as "812 ms" or "3.2 s"; "" when unknown. */
export function fmtMs(ms) {
  const n = finite(ms);
  if (n === null || n < 0) return "";
  if (n < 1000) return Math.round(n) + " ms";
  return (n / 1000).toFixed(n < 10000 ? 1 : 0) + " s";
}

/** The small facts beside an entry's type: turn and duration. */
export function metaParts(digest) {
  const parts = [];
  const turn = wholeOrNull(digest.turn);
  if (turn !== null) parts.push("turn " + turn);
  const took = fmtMs(digest.duration_ms);
  if (took) parts.push(took);
  return parts;
}

// ================================================================ pure: digests

function cleanLine(line) {
  return {
    kind: LINE_KINDS.has(line.kind) ? line.kind : "harness",
    text: String(line.text ?? ""),
    truncated: Boolean(line.truncated),
  };
}

// The legacy digest lists images as bare sha256 strings; the console digest as objects.
function cleanImage(image) {
  if (typeof image === "string") return { sha256: image };
  return image && typeof image === "object" ? image : null;
}

/**
 * A digest in the shape the stream renders, or null when it has no usable seq. Unknown categories
 * and line kinds fall back to "harness", so a class name never comes from data.
 */
export function normaliseDigest(raw) {
  if (!raw || typeof raw !== "object") return null;
  const seq = Number(raw.seq);
  if (!Number.isInteger(seq) || seq < 0) return null;
  const lines = Array.isArray(raw.lines) ? raw.lines.filter((l) => l && typeof l === "object").map(cleanLine) : [];
  const images = Array.isArray(raw.images) ? raw.images.map(cleanImage).filter(Boolean) : [];
  return {
    ...raw,
    seq,
    type: String(raw.type ?? ""),
    category: CATEGORIES.includes(raw.category) ? raw.category : "harness",
    lines,
    images,
    tool: typeof raw.tool === "string" && raw.tool ? raw.tool : null,
    is_error: Boolean(raw.is_error),
    crop_n: wholeOrNull(raw.crop_n),
  };
}

// First index whose seq is >= the given one (the list is sorted by seq).
function lowerBound(list, seq) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid].seq < seq) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Insert a digest into a list kept sorted by seq. Returns its index, or -1 when that seq is
 * already there (the backlog and the live stream overlap, and a reconnect replays events).
 */
export function insertDigest(list, digest) {
  const last = list.length ? list[list.length - 1].seq : -Infinity;
  if (digest.seq > last) {
    list.push(digest);
    return list.length - 1;
  }
  const at = lowerBound(list, digest.seq);
  if (at < list.length && list[at].seq === digest.seq) return -1;
  list.splice(at, 0, digest);
  return at;
}

/** Index of the entry with this seq, or -1. */
export function indexOfSeq(list, seq) {
  const at = lowerBound(list, seq);
  return at < list.length && list[at].seq === seq ? at : -1;
}

/** How many entries have a seq above the given one: the "n new" of the jump pill. */
export function countAfter(list, seq) {
  if (seq === null || seq === undefined) return list.length;
  return list.length - lowerBound(list, seq + 1);
}

// ================================================================ pure: filter and search

/**
 * Categories from the `?filter=` value (a comma list) or from an array, in chip order, unknown
 * names dropped. An empty result means "everything", and so does naming all six.
 */
export function parseFilter(value) {
  const names = Array.isArray(value) ? value : value instanceof Set ? Array.from(value) : String(value ?? "").split(",");
  const wanted = new Set(names.map((name) => String(name).trim().toLowerCase()));
  const picked = CATEGORIES.filter((category) => wanted.has(category));
  return picked.length === CATEGORIES.length ? [] : picked;
}

/** The `?filter=` value for a list of categories; "" when nothing is filtered. */
export function formatFilter(categories) {
  return parseFilter(categories).join(",");
}

const haystacks = new WeakMap();

/** What the search looks at: the text of every line and the tool name, lower-cased. */
export function searchText(digest) {
  let text = haystacks.get(digest);
  if (text === undefined) {
    text = ((digest.tool || "") + "\n" + digest.lines.map((line) => line.text).join("\n")).toLowerCase();
    haystacks.set(digest, text);
  }
  return text;
}

/** The search as it is matched: trimmed and lower-cased. */
export function searchNeedle(text) {
  return String(text ?? "").trim().toLowerCase();
}

export function matchesSearch(digest, needle) {
  return !needle || searchText(digest).includes(needle);
}

/** The digests that pass the category filter (empty = all) and the search. */
export function visibleDigests(digests, categories, needle) {
  const wanted = new Set(categories || []);
  return digests.filter((digest) => (!wanted.size || wanted.has(digest.category)) && matchesSearch(digest, needle));
}

/** Chip counts: per category and in total, among the digests that match the search. */
export function countByCategory(digests, needle) {
  const counts = { all: 0 };
  for (const category of CATEGORIES) counts[category] = 0;
  for (const digest of digests) {
    if (!matchesSearch(digest, needle)) continue;
    counts.all += 1;
    counts[digest.category] += 1;
  }
  return counts;
}

/**
 * Cut a text into `[{text, hit}]` around the matches of the search, for highlighting with DOM
 * nodes. At most `limit` matches are marked; a line of 8000 characters can hold thousands.
 */
export function splitMatches(text, needle, limit = 200) {
  const source = String(text ?? "");
  const find = String(needle ?? "").toLowerCase();
  const lower = source.toLowerCase();
  // A few characters change length when lower-cased; then positions no longer line up.
  if (!find || lower.length !== source.length) return [{ text: source, hit: false }];
  const parts = [];
  let from = 0;
  let hits = 0;
  while (hits < limit) {
    const at = lower.indexOf(find, from);
    if (at === -1) break;
    if (at > from) parts.push({ text: source.slice(from, at), hit: false });
    parts.push({ text: source.slice(at, at + find.length), hit: true });
    from = at + find.length;
    hits += 1;
  }
  if (from < source.length || !parts.length) parts.push({ text: source.slice(from), hit: false });
  return parts;
}

// ================================================================ pure: lines

/**
 * A first guess at whether a line is cut by the CSS clamp, used until the browser has measured
 * it: the "More" button should not appear and disappear as an entry scrolls into view.
 */
export function isLongLine(line) {
  const text = String(line.text ?? "");
  const prose = line.kind === "thinking" || line.kind === "text";
  if (text.length > (prose ? 260 : 170)) return true;
  return text.split("\n").length > (prose ? 4 : 3);
}

/** A tool line is "name {arguments}": split it so the name can be set apart. */
export function splitToolLine(text) {
  const source = String(text ?? "");
  const space = source.indexOf(" ");
  if (space <= 0) return { name: source, rest: "" };
  return { name: source.slice(0, space), rest: source.slice(space) };
}

function pretty(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (_) {
    return String(value);
  }
}

function toolName(data) {
  return String(data.name || data.tool || data.tool_name || "?");
}

// What a hosted web search did, as the server's digest words it (without its list of sources).
function hostedAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return action ?? {};
  const what = action.query || action.pattern || "";
  const said = [action.type, what ? JSON.stringify(what) : "", action.url || ""].filter(Boolean).join(" ");
  return said || action;
}

function contentLines(content) {
  if (typeof content === "string") return content.trim() ? [{ kind: "text", text: content }] : [];
  const lines = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== "object") continue;
    const kind = block.type;
    if (["thinking", "text", "refusal"].includes(kind) && String(block[kind] || "").trim()) {
      lines.push({ kind: kind === "thinking" ? "thinking" : "text", text: String(block[kind]) });
    } else if (kind === "server_tool_use") {
      lines.push({ kind: "tool", text: (block.name ?? "?") + " " + pretty(hostedAction(block.input)) });
    } else if (kind === "tool_use") {
      lines.push({ kind: "tool", text: (block.name ?? "?") + " " + pretty(block.input ?? {}) });
    }
  }
  return lines;
}

function envelopeLines(type, data) {
  if (type === "model_response") {
    const lines = contentLines(data.content);
    const stop = data.stop_reason;
    if (stop && stop !== "tool_use" && stop !== "end_turn") {
      lines.push({ kind: stop === "refusal" ? "error" : "harness", text: "stop_reason: " + stop });
    }
    return lines;
  }
  if (type === "tool_call") {
    return [{ kind: "tool", text: toolName(data) + " " + pretty(data.input ?? data.args ?? {}) }];
  }
  if (type === "tool_result") {
    const took = finite(data.duration_ms);
    const head = toolName(data) + (took === null ? "" : " (" + Math.round(took) + " ms)") + ": ";
    return [{ kind: data.is_error ? "error" : "result", text: head + pretty(data.output ?? data.log ?? "") }];
  }
  if (type === "mcq_asked") {
    const options = (Array.isArray(data.options) ? data.options : []).map(String).join(" | ");
    return [{ kind: "human", text: "MCQ: " + String(data.question ?? "") + " [" + options + "]" }];
  }
  return null;
}

/**
 * The lines of an event without the server's clipping, rebuilt from the full envelope (A12:
 * expanding a truncated line fetches it). Mirrors `runstate._event_lines` for the event types
 * whose lines can be cut, with JSON indented for reading. Returns null when the envelope cannot
 * be matched line for line to the digest; the caller then keeps the snippet and points at the
 * event JSON, which always has everything.
 */
export function fullLines(envelope, digest) {
  if (!envelope || typeof envelope !== "object") return null;
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data : {};
  const lines = envelopeLines(String(envelope.type ?? ""), data);
  if (!lines || lines.length !== digest.lines.length) return null;
  // The digest decides the kind (it is what the entry was styled with); the envelope the text.
  return lines.map((line, index) => ({ kind: digest.lines[index].kind, text: line.text, truncated: false }));
}

// ================================================================ pure: images

const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * URL of a view sent to the model, or null when the id is not a sha256. The id comes from a log,
 * so it is checked before it becomes part of a URL, and the URL is always the app's own endpoint.
 */
export function viewUrl(runId, pid, sha256) {
  if (typeof sha256 !== "string" || !SHA_RE.test(sha256)) return null;
  return panoUrl(runId, pid, "/views/" + sha256);
}

function degrees(value) {
  const n = finite(value);
  return n === null ? null : String(Math.round(n * 10) / 10) + "°";
}

/** Caption of a view: crop number, yaw, pitch, FOV and pixel size, as far as they are known. */
export function imageCaption(image) {
  const parts = [];
  const n = wholeOrNull(image.crop_n);
  if (n !== null) parts.push("crop " + n);
  const yaw = degrees(image.yaw);
  const pitch = degrees(image.pitch);
  const fov = degrees(image.fov);
  if (yaw !== null) parts.push("yaw " + yaw);
  if (pitch !== null) parts.push("pitch " + pitch);
  if (fov !== null) parts.push("FOV " + fov);
  const width = wholeOrNull(image.width);
  const height = wholeOrNull(image.height);
  if (width && height) parts.push(width + " × " + height + " px");
  return parts.length ? parts.join(" · ") : "view " + String(image.sha256 ?? "").slice(0, 8);
}

// ================================================================ pure: windowing

/**
 * Prefix sums of entry heights: `offsets[i]` is the top of entry i and `offsets[n]` the height
 * of the whole list.
 */
export function buildOffsets(heights) {
  const offsets = new Float64Array(heights.length + 1);
  for (let i = 0; i < heights.length; i += 1) offsets[i + 1] = offsets[i] + heights[i];
  return offsets;
}

/** Index of the entry that contains the vertical position `y` (clamped to the list); -1 if empty. */
export function indexAt(offsets, y) {
  const count = offsets.length - 1;
  if (count <= 0) return -1;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Which entries to put in the DOM for a scroll position: `{start, end, padTop, padBottom}`, with
 * `end` exclusive and the two pads standing in for the entries that are left out, so
 * padTop + rendered heights + padBottom is always the height of the whole list.
 * `overscan` (px) is rendered beyond each edge of the viewport; a list of at most `minCount`
 * entries is rendered whole (UI-SPEC 7: "virtualised beyond a few hundred entries").
 */
export function windowRange(offsets, scrollTop, viewport, { overscan = 0, minCount = 0 } = {}) {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  if (count <= minCount) return { start: 0, end: count, padTop: 0, padBottom: 0 };
  const total = offsets[count];
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, total - viewport));
  const start = indexAt(offsets, top - overscan);
  const end = indexAt(offsets, top + viewport + overscan) + 1;
  return { start, end, padTop: offsets[start], padBottom: total - offsets[end] };
}

/** True when the rendered range already holds every entry of the wanted one. */
export function coversRange(rendered, wanted) {
  if (wanted.end <= wanted.start) return true;
  return rendered.start <= wanted.start && rendered.end >= wanted.end;
}

/**
 * The entry at the top edge of the viewport and how far it is scrolled past: `{index, offset}`.
 * Restoring `offsets[index] + offset` after heights above it changed keeps the same text under
 * the operator's eyes. Null for an empty list.
 */
export function anchorAt(offsets, scrollTop) {
  const index = indexAt(offsets, scrollTop);
  if (index < 0) return null;
  return { index, offset: scrollTop - offsets[index] };
}

// ================================================================ pure: JSON tree

export function jsonKind(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return type === "object" || type === "string" || type === "number" || type === "boolean" ? type : "string";
}

/** What a collapsed branch says about itself: "{3 keys}", "[12 items]". */
export function jsonSummary(value) {
  if (Array.isArray(value)) return "[" + value.length + (value.length === 1 ? " item]" : " items]");
  const count = Object.keys(value).length;
  return "{" + count + (count === 1 ? " key}" : " keys}");
}

// ================================================================ DOM: JSON tree (side panel)

const OPEN_DEPTH = 2; // the envelope and its `data` are open; what is nested deeper starts closed
const CHILD_CAP = 400; // children built per branch; the copy button always has all of them
const STRING_PREVIEW = 1200;

// Branches build their children when first opened, so a large event opens at once.
const branchBuilders = new WeakMap();

function jsonKey(key) {
  if (key === null) return null;
  const isIndex = typeof key === "number";
  return el("span", isIndex ? "json-key json-index" : "json-key", isIndex ? String(key) : key + ":");
}

function jsonString(text) {
  const node = el("span", "json-value json-string");
  if (text.length <= STRING_PREVIEW) {
    node.textContent = text;
    return node;
  }
  const showAll = el("button", {
    type: "button",
    class: "small ghost json-more",
    onclick: () => { node.textContent = text; },
  }, "Show all " + fmtInt(text.length) + " characters");
  node.append(text.slice(0, STRING_PREVIEW) + "…", " ", showAll);
  return node;
}

function jsonLeaf(key, value, kind) {
  const shown = kind === "string" ? jsonString(value) : el("span", "json-value json-" + kind, kind === "null" ? "null" : String(value));
  return el("div", "json-leaf", jsonKey(key), shown);
}

function fillBranch(holder, entries, depth) {
  for (const [key, value] of entries.slice(0, CHILD_CAP)) holder.append(jsonNode(key, value, depth + 1));
  if (entries.length > CHILD_CAP) {
    holder.append(el("div", "json-leaf dim", "… " + fmtInt(entries.length - CHILD_CAP) + " more; copy the JSON to see all of them"));
  }
}

function jsonNode(key, value, depth) {
  const kind = jsonKind(value);
  if (kind !== "object" && kind !== "array") return jsonLeaf(key, value, kind);
  const entries = kind === "array" ? value.map((item, index) => [index, item]) : Object.entries(value);
  if (!entries.length) return el("div", "json-leaf", jsonKey(key), el("span", "json-value json-null", kind === "array" ? "[]" : "{}"));
  const holder = el("div", "json-children");
  const details = el("details", "json-branch", el("summary", "json-summary", jsonKey(key), el("span", "json-count", jsonSummary(value))), holder);
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    fillBranch(holder, entries, depth);
  };
  branchBuilders.set(details, build);
  details.addEventListener("toggle", () => { if (details.open) build(); });
  if (depth < OPEN_DEPTH) {
    details.open = true;
    build();
  }
  return details;
}

/** An indented, collapsible tree of any JSON value, built with DOM nodes only. */
export function jsonTree(value) {
  const tree = el("div", "json-tree");
  const kind = jsonKind(value);
  if (kind === "object" || kind === "array") {
    const entries = kind === "array" ? value.map((item, index) => [index, item]) : Object.entries(value);
    fillBranch(tree, entries, 0);
  } else tree.append(jsonLeaf(null, value, kind));
  return tree;
}

const EXPAND_ROUNDS = 40; // nesting depth "Expand all" follows; an event is nowhere near this deep

function expandTree(tree) {
  for (let round = 0; round < EXPAND_ROUNDS; round += 1) {
    const closed = tree.querySelectorAll("details:not([open])");
    if (!closed.length) return;
    for (const details of closed) {
      const build = branchBuilders.get(details);
      if (build) build();
      details.open = true;
    }
  }
}

function collapseTree(tree) {
  for (const details of tree.querySelectorAll("details[open]")) details.open = false;
}

// ================================================================ DOM: lines

function appendMarked(node, text, needle) {
  if (!needle) {
    node.append(text);
    return;
  }
  for (const part of splitMatches(text, needle)) {
    node.append(part.hit ? el("mark", "stream-mark", part.text) : part.text);
  }
}

function buildLine(line, needle) {
  const node = el("div", "stream-line kind-" + line.kind);
  if (line.kind === "tool") {
    const { name, rest } = splitToolLine(line.text);
    const nameNode = el("span", "stream-tool-name");
    appendMarked(nameNode, name, needle);
    node.append(nameNode);
    appendMarked(node, rest, needle);
  } else appendMarked(node, line.text, needle);
  return node;
}

// ================================================================ the component

const VIRTUAL_MIN = 300; // up to this many entries all are in the DOM; beyond, a window of them
const MIN_OVERSCAN_PX = 400; // rendered beyond each edge of the viewport, so a wheel tick shows no gap
const FOLLOW_SLACK_PX = 24; // this close to the bottom still counts as following the tail
const TARGET_MARGIN_PX = 8; // room left above an entry scrolled to
const SEARCH_DEBOUNCE_MS = 120;
const FULL_TEXT_CAP = 20000; // characters of one expanded line shown in the stream itself
const FLUSH_FALLBACK_MS = 200; // a hidden tab gets no animation frames
const SEARCH_PLACEHOLDER = "Search loaded entries (text, tool name)";

function cssLength(value) {
  return typeof value === "number" ? value + "px" : String(value);
}

function entryHeight(node, observed) {
  const box = observed && observed.borderBoxSize && observed.borderBoxSize[0];
  // Fractional heights matter: rounding each of a hundred entries drifts by tens of pixels.
  return box ? box.blockSize : node.getBoundingClientRect().height;
}

/**
 * The reasoning stream of one panorama.
 *
 *   const stream = createStream(container, {runId, pid, onCropHover: (n) => viewer.highlightCrop(n)});
 *
 * options:
 *   runId, pid         the panorama
 *   onImage(image, digest)   a thumbnail was opened; return false to keep the lightbox closed
 *   onCropHover(n|null)      the pointer or the focus is on a view_crop entry (its crop number)
 *   height             height of the list: px number or CSS length; "fill" takes the height of a
 *                      flex or sized container. Default 25rem.
 *   live (true)        load the backlog and follow the store. false: only reset() / append()
 *   filter, search     initial values (the screen passes `?filter=` and `?q=`)
 *   onChange({filter, search})   the operator changed the chips or the search box
 *   onOpenEvent(seq|null)        the operator opened an entry's JSON, or closed the panel
 *
 * Programmatic calls (setFilter, setSearch, openEvent, scrollToSeq) never call the callbacks, so
 * a screen can mirror the URL both ways without a loop.
 */
export function createStream(container, options = {}) {
  const {
    runId,
    pid,
    onImage = null,
    onCropHover = null,
    onChange = null,
    onOpenEvent = null,
    height = null,
    live = true,
  } = options;

  const state = {
    all: [], // every digest, sorted by seq
    seqs: new Set(),
    items: [], // the digests that pass the filter and the search
    counts: countByCategory([], ""),
    filter: new Set(parseFilter(options.filter)), // categories shown; empty = all
    search: String(options.search ?? ""),
    needle: searchNeedle(options.search),
    expanded: new Set(), // seqs whose lines are shown whole
    full: new Map(), // seq -> {status: "loading"|"ready"|"partial"|"error", lines?, message?}
    envelopes: new Map(), // seq -> Promise<envelope>, shared by "More" and the JSON panel
    heights: new Map(), // seq -> measured height in px
    overflow: new Map(), // seq -> whether the clamp actually cuts a line (measured)
    nodes: new Map(), // seq -> view of a rendered entry
    range: { start: 0, end: 0, padTop: 0, padBottom: 0 },
    offsets: buildOffsets([]),
    offsetsDirty: false,
    itemsDirty: false,
    layoutDirty: false,
    needleDirty: false, // rendered lines still carry the highlights of the previous search
    domStale: false, // `items` was rebuilt and the DOM still shows the list before it
    following: true,
    seenSeq: null, // the last seq that was there when the operator was last at the bottom
    anchor: null, // {seq, offset}: what is at the top edge while not following
    contiguous: 0, // every event up to this seq is loaded
    loading: false,
    loadedOnce: false,
    reload: false,
    loadError: null,
    hotCrop: null,
    hoverSeq: null,
    targetSeq: null,
    pendingTarget: null,
    cursor: null,
    openSeq: null,
    panelBody: null,
    silentClose: false,
    emptyKind: null,
    scheduled: false,
    destroyed: false,
  };
  const aborter = typeof AbortController === "function" ? new AbortController() : null;
  const signal = aborter ? aborter.signal : undefined;
  const cleanups = [];
  let frame = null;
  let timer = null;
  let estimate = 60;

  // ---------------------------------------------------------------- skeleton

  const chips = new Map(); // "all" | category -> {button, count}

  function buildChip(key, label, iconName) {
    const count = el("span", "stream-chip-count num", "0");
    const button = el("button", {
      type: "button",
      class: "stream-chip cat-" + key,
      "aria-pressed": "false",
      onclick: () => toggleCategory(key),
    }, iconName ? icon(iconName) : null, el("span", "stream-chip-label", label), count);
    chips.set(key, { button, count });
    return button;
  }

  const filterRow = el("div", { class: "stream-filters", role: "group", "aria-label": "Kinds of entries shown" },
    buildChip("all", "All", null),
    CATEGORIES.map((category) => buildChip(category, CATEGORY_INFO[category].label, CATEGORY_INFO[category].icon)));

  const input = el("input", {
    type: "search",
    class: "stream-search-input",
    placeholder: SEARCH_PLACEHOLDER,
    title: "Filters the entries already loaded, on their text and tool name. Nothing typed here reaches the agent.",
    "aria-label": "Search the loaded stream entries",
    autocomplete: "off",
    value: state.search,
  });
  input.spellcheck = false;
  const matchCount = el("span", { class: "stream-search-count num", hidden: true });
  const clearSearch = el("button", {
    type: "button",
    class: "icon-btn small stream-search-clear",
    title: "Clear the search (Esc)",
    "aria-label": "Clear the search",
    hidden: true,
    onclick: () => { applySearch("", true); input.focus(); },
  }, icon("x"));
  const searchBox = el("div", "stream-search", icon("search"), input, el("span", "stream-search-side", matchCount, clearSearch));
  const bar = el("div", "stream-bar", filterRow, searchBox);

  const padTop = el("div", { class: "stream-pad", "aria-hidden": "true" });
  const padBottom = el("div", { class: "stream-pad", "aria-hidden": "true" });
  const list = el("div", "stream-list");
  const scroller = el("div", {
    class: "stream-scroll",
    tabindex: "0",
    role: "log",
    "aria-live": "off",
    "aria-label": "Reasoning stream entries",
  }, padTop, list, padBottom);
  const empty = el("div", { class: "stream-empty", hidden: true });
  const alertBar = el("div", { class: "stream-alert", hidden: true });
  const jumpCount = el("span", { class: "stream-jump-count num", hidden: true });
  const jump = el("button", {
    type: "button",
    class: "stream-jump",
    hidden: true,
    onclick: () => jumpToLatest(),
  }, icon("chevron-down"), el("span", null, "Jump to latest"), jumpCount);
  const body = el("div", "stream-body", alertBar, scroller, empty, jump);
  const root = el("section", { class: "stream", "aria-label": "Reasoning stream" }, bar, body);

  if (height === "fill") root.classList.add("fill");
  else if (height !== null && height !== undefined) root.style.setProperty("--stream-h", cssLength(height));
  container.append(root);

  // Entries that were never measured are assumed this tall; about three lines of text.
  if (typeof getComputedStyle === "function") {
    const fontPx = parseFloat(getComputedStyle(root).fontSize);
    if (Number.isFinite(fontPx) && fontPx > 0) estimate = Math.round(fontPx * 4.6);
  }

  // ---------------------------------------------------------------- scheduling

  // Everything that changes the list is coalesced into one pass per frame: a backlog of five
  // hundred events and a burst of live ones cost one layout each.
  function schedule() {
    if (state.scheduled || state.destroyed) return;
    state.scheduled = true;
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(() => runFlush());
    timer = setTimeout(() => runFlush(), FLUSH_FALLBACK_MS);
  }

  function runFlush(jump = false) {
    if (!state.scheduled || state.destroyed) return;
    state.scheduled = false;
    if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = null;
    flush(jump === true);
  }

  // Do the pending pass now instead of on the next frame (a jump must not show a frame of the old place).
  function runNow(jump = false) {
    if (state.destroyed) return;
    state.scheduled = true;
    runFlush(jump);
  }

  // `jump`: the anchor was just set by scrollToSeq and must not be re-read from the page.
  function flush(jump = false) {
    if (!jump) holdPlace();
    syncItems();
    takePendingTarget();
    if (state.needleDirty) relineViews();
    if (state.layoutDirty) layout();
    else checkWindow();
    updateChrome();
  }

  function invalidate() {
    state.itemsDirty = true;
    schedule();
  }

  // ---------------------------------------------------------------- geometry

  function heightOf(digest) {
    return state.heights.get(digest.seq) ?? estimate;
  }

  function ensureOffsets() {
    if (!state.offsetsDirty) return;
    state.offsets = buildOffsets(state.items.map(heightOf));
    state.offsetsDirty = false;
  }

  function overscan(viewport) {
    return Math.max(MIN_OVERSCAN_PX, viewport);
  }

  // Remember which entry is at the top edge, from the page as it stands. Only valid while the
  // DOM shows `items`; between a rebuild of the list and its layout the previous anchor is kept.
  function captureAnchor() {
    if (state.domStale || !scroller.clientHeight || !state.items.length) return;
    ensureOffsets();
    const at = anchorAt(state.offsets, scroller.scrollTop);
    if (at) state.anchor = { seq: state.items[at.index].seq, offset: at.offset };
  }

  function holdPlace() {
    if (!state.following) captureAnchor();
  }

  // Where the anchor entry is now, or null when it (and everything after it) is gone.
  function anchorTop() {
    if (!state.anchor) return null;
    const at = lowerBound(state.items, state.anchor.seq);
    if (at >= state.items.length) return null;
    const exact = state.items[at].seq === state.anchor.seq;
    return state.offsets[at] + (exact ? state.anchor.offset : 0);
  }

  function pin() {
    scroller.scrollTop = scroller.scrollHeight;
  }

  // Bring `items` up to date with the digests, the filter and the search. The operator's place
  // is read first, because the DOM shows the old list until layout() has run.
  function syncItems() {
    if (!state.itemsDirty) return;
    holdPlace();
    state.items = visibleDigests(state.all, state.filter, state.needle);
    state.counts = countByCategory(state.all, state.needle);
    state.itemsDirty = false;
    state.offsetsDirty = true;
    state.layoutDirty = true;
    state.domStale = true;
  }

  // A full pass after the list changed: put the operator back where they were (or at the tail),
  // then render the window for that position.
  function layout() {
    state.layoutDirty = false;
    state.offsetsDirty = true;
    ensureOffsets();
    const viewport = scroller.clientHeight;
    const maxTop = Math.max(0, state.offsets[state.items.length] - viewport);
    let top = maxTop;
    if (!state.following) {
      const wanted = anchorTop();
      if (wanted === null) setFollowing(true);
      else top = Math.min(Math.max(0, wanted), maxTop);
    }
    renderRange(windowRange(state.offsets, top, viewport, { overscan: overscan(viewport), minCount: VIRTUAL_MIN }));
    if (state.following) pin();
    else if (Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top;
    state.domStale = false;
    if (!observer) measureRendered();
  }

  // After a scroll or a measurement: render a new window only when the viewport has come close
  // to the edge of the one in the DOM.
  function checkWindow() {
    ensureOffsets();
    const viewport = scroller.clientHeight;
    const top = scroller.scrollTop;
    const reach = overscan(viewport);
    const needed = windowRange(state.offsets, top, viewport, { overscan: reach / 4, minCount: VIRTUAL_MIN });
    if (coversRange(state.range, needed)) return;
    renderRange(windowRange(state.offsets, top, viewport, { overscan: reach, minCount: VIRTUAL_MIN }));
    if (!observer) measureRendered();
  }

  function renderRange(range) {
    const wanted = new Set();
    for (let i = range.start; i < range.end; i += 1) wanted.add(state.items[i].seq);
    for (const [seq, view] of state.nodes) if (!wanted.has(seq)) dropView(seq, view);
    let previous = null;
    for (let i = range.start; i < range.end; i += 1) {
      const digest = state.items[i];
      let view = state.nodes.get(digest.seq);
      if (!view) {
        view = buildEntry(digest);
        state.nodes.set(digest.seq, view);
        if (observer) observer.observe(view.node);
      }
      const expected = previous ? previous.nextSibling : list.firstChild;
      if (view.node !== expected) list.insertBefore(view.node, expected);
      previous = view.node;
    }
    padTop.style.height = range.padTop + "px";
    padBottom.style.height = range.padBottom + "px";
    state.range = range;
  }

  function dropView(seq, view) {
    if (observer) observer.unobserve(view.node);
    view.node.remove();
    state.nodes.delete(seq);
    // A node removed under the pointer gets no mouseleave: end its crop highlight here.
    if (state.hoverSeq === seq) hoverCrop(null, null);
  }

  function dropAllViews() {
    for (const [seq, view] of Array.from(state.nodes)) dropView(seq, view);
  }

  // ---------------------------------------------------------------- measuring

  // Heights of rendered entries, as the browser laid them out. The entries themselves are real
  // DOM, so nothing moves when their height is recorded; what must be corrected is the scroll
  // position when an entry ABOVE the operator's place turned out taller or shorter than the pad
  // that stood in for it.
  function recordHeights(measured) {
    if (state.destroyed || !scroller.clientHeight) return; // hidden: the sizes mean nothing
    const anchorSeq = state.following || !state.anchor ? null : state.anchor.seq;
    let shift = 0;
    let changed = false;
    for (const { node, height: tall } of measured) {
      const view = state.nodes.get(Number(node.dataset.seq));
      if (!view || view.node !== node || !(tall > 0)) continue;
      const before = heightOf(view.digest);
      if (Math.abs(tall - before) > 0.05) {
        state.heights.set(view.digest.seq, tall);
        changed = true;
        if (anchorSeq !== null && view.digest.seq < anchorSeq) shift += tall - before;
      }
      noteOverflow(view);
    }
    if (changed) state.offsetsDirty = true;
    if (state.following) pin();
    else if (shift) scroller.scrollTop += shift;
    return changed;
  }

  function measureRendered() {
    const measured = [];
    for (const view of state.nodes.values()) measured.push({ node: view.node, height: entryHeight(view.node, null) });
    recordHeights(measured);
  }

  // Whether the CSS clamp really cuts a line of this entry: decides if "More" is offered. Only a
  // collapsed entry can tell; an expanded one keeps what was found before.
  function noteOverflow(view) {
    const seq = view.digest.seq;
    if (state.expanded.has(seq)) return;
    const cut = view.lineNodes.some((line) => line.scrollHeight > line.clientHeight + 1);
    if (state.overflow.get(seq) === cut) return;
    state.overflow.set(seq, cut);
    updateEntry(view);
  }

  function onResize(entries) {
    if (state.destroyed) return;
    const measured = [];
    let viewportChanged = false;
    for (const entry of entries) {
      if (entry.target === scroller) viewportChanged = true;
      else measured.push({ node: entry.target, height: entryHeight(entry.target, entry) });
    }
    const changed = recordHeights(measured);
    // The window is re-checked on the next frame: rendering inside a ResizeObserver callback
    // would resize what it is observing.
    if (viewportChanged) state.layoutDirty = true;
    if (viewportChanged || changed) schedule();
  }

  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
  if (observer) observer.observe(scroller);

  // ---------------------------------------------------------------- scrolling

  function setFollowing(following) {
    state.following = following;
    if (following) {
      state.anchor = null;
      markSeen();
    }
  }

  function markSeen() {
    state.seenSeq = state.all.length ? state.all[state.all.length - 1].seq : null;
  }

  function onScroll() {
    if (state.destroyed || !scroller.clientHeight) return;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const atBottom = gap <= FOLLOW_SLACK_PX;
    if (atBottom !== state.following) setFollowing(atBottom);
    updateJump();
    if (state.domStale) return; // the pass that is about to run renders the new list
    if (!atBottom) captureAnchor();
    checkWindow();
  }

  scroller.addEventListener("scroll", onScroll, { passive: true });

  function jumpToLatest() {
    if (state.destroyed) return;
    state.pendingTarget = null;
    setFollowing(true);
    state.layoutDirty = true;
    runNow(true);
    // The pill is hidden now; keep the keyboard in the list instead of dropping focus to the page.
    scroller.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- entries

  function expandable(digest) {
    if (digest.lines.some((line) => line.truncated)) return true;
    const measured = state.overflow.get(digest.seq);
    return measured === undefined ? digest.lines.some(isLongLine) : measured;
  }

  function shownLines(digest) {
    const full = state.full.get(digest.seq);
    if (state.expanded.has(digest.seq) && full && full.status === "ready") return full.lines;
    return digest.lines;
  }

  function capLine(line) {
    if (line.text.length <= FULL_TEXT_CAP) return { line, cut: 0 };
    return { line: { ...line, text: line.text.slice(0, FULL_TEXT_CAP) + "…" }, cut: line.text.length - FULL_TEXT_CAP };
  }

  // What the entry says about its full text while it is expanded: loading, failed, or not here.
  function fullNote(digest, cut) {
    if (!state.expanded.has(digest.seq)) return null;
    const full = state.full.get(digest.seq);
    const openJson = el("button", { type: "button", class: "small ghost", onclick: () => openByOperator(digest.seq) }, "Open the event JSON");
    if (cut > 0) {
      return el("div", "stream-note", fmtInt(cut) + " more characters are not shown here. ", openJson);
    }
    if (!full) return null;
    if (full.status === "loading") return el("div", "stream-note", el("span", "spinner"), " Loading the full text…");
    if (full.status === "partial") {
      return el("div", "stream-note", "The server clipped this entry; the whole of it is in the event JSON. ", openJson);
    }
    if (full.status === "error") {
      const retry = el("button", { type: "button", class: "small", onclick: () => loadFull(digest) }, icon("refresh"), "Retry");
      return el("div", "stream-note bad-text", icon("alert"), " Could not load the full text. " + full.message + " ", retry);
    }
    return null;
  }

  function renderLines(view) {
    const { digest } = view;
    let cut = 0;
    view.lineNodes = shownLines(digest).map((line) => {
      const capped = capLine(line);
      cut += capped.cut;
      return buildLine(capped.line, state.needle);
    });
    replace(view.linesBox, view.lineNodes, fullNote(digest, cut));
    view.linesBox.hidden = !view.lineNodes.length;
  }

  function buildThumb(image, digest) {
    const url = viewUrl(runId, pid, image.sha256);
    if (!url) return null;
    const caption = imageCaption(image);
    const picture = el("img", { class: "stream-thumb-img", alt: caption, loading: "lazy", decoding: "async" });
    const width = wholeOrNull(image.width);
    const tall = wholeOrNull(image.height);
    // The pixel size reserves the thumbnail's width before it has loaded.
    if (width && tall) {
      picture.width = width;
      picture.height = tall;
    }
    const n = wholeOrNull(image.crop_n);
    const button = el("button", {
      type: "button",
      class: "stream-thumb",
      title: caption + " (click to enlarge)",
      onclick: () => openImage(image, digest),
    }, picture, n === null ? null : el("span", "stream-thumb-n num", String(n)));
    picture.addEventListener("error", () => {
      button.classList.add("is-missing");
      button.disabled = true;
      button.title = caption + " (image not available)";
      replace(button, icon("image"), el("span", "stream-thumb-gone", "not available"));
    });
    picture.src = url;
    return button;
  }

  function openImage(image, digest) {
    if (onImage && onImage(image, digest) === false) return;
    const url = viewUrl(runId, pid, image.sha256);
    if (url) lightbox({ src: url, caption: imageCaption(image) });
  }

  function entryCrop(digest) {
    if (digest.crop_n !== null) return digest.crop_n;
    for (const image of digest.images) {
      const n = wholeOrNull(image.crop_n);
      if (n !== null) return n;
    }
    return null;
  }

  function hoverCrop(seq, n) {
    state.hoverSeq = seq;
    if (onCropHover) onCropHover(n);
  }

  function buildEntry(digest) {
    const info = CATEGORY_INFO[digest.category];
    const crop = entryCrop(digest);
    const meta = metaParts(digest);
    const final = digest.type === "final_submission";
    const kind = el("span", "stream-kind", icon(digest.is_error ? "alert" : final ? "check" : info.icon), entryLabel(digest));
    const open = el("button", {
      type: "button",
      class: "stream-open",
      title: "Open the full event JSON",
      onclick: () => openByOperator(digest.seq),
    },
      el("span", "stream-time mono", fmtClock(digest.t_rel_s)),
      kind,
      crop === null ? null : el("span", "stream-crop num", "crop " + crop),
      el("span", "stream-meta num", meta.length ? el("span", null, meta.join(" · ")) : null, el("span", "stream-seq mono", "#" + digest.seq)));
    const toggleLabel = el("span", null, "More");
    const toggleMark = el("span", "stream-toggle-mark", icon("chevron-down"));
    const toggle = el("button", {
      type: "button",
      class: "small ghost stream-toggle",
      "aria-expanded": "false",
      hidden: true,
      onclick: () => toggleExpanded(digest),
    }, toggleLabel, toggleMark);
    const linesBox = el("div", "stream-lines");
    linesBox.addEventListener("click", () => expandByClick(digest));
    const thumbs = digest.images.map((image) => buildThumb(image, digest)).filter(Boolean);
    const node = el("article", {
      class: ["stream-entry", "cat-" + digest.category, digest.is_error && "is-error", final && "is-final"],
      dataset: { seq: digest.seq },
    }, el("div", "stream-head", open, toggle), linesBox, thumbs.length ? el("div", "stream-thumbs", thumbs) : null);
    if (crop !== null) {
      node.addEventListener("mouseenter", () => hoverCrop(digest.seq, crop));
      node.addEventListener("mouseleave", () => hoverCrop(null, null));
      node.addEventListener("focusin", () => hoverCrop(digest.seq, crop));
      node.addEventListener("focusout", () => hoverCrop(null, null));
    }
    const view = { node, digest, crop, linesBox, lineNodes: [], toggle, toggleLabel, toggleMark, shownExpanded: null };
    renderLines(view);
    updateEntry(view);
    return view;
  }

  function updateToggle(view, expanded) {
    if (view.shownExpanded === expanded) return;
    view.shownExpanded = expanded;
    view.toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    view.toggle.title = expanded ? "Clamp this entry again" : "Show this entry in full";
    view.toggleLabel.textContent = expanded ? "Less" : "More";
    replace(view.toggleMark, icon(expanded ? "chevron-up" : "chevron-down"));
  }

  // The state of an entry that can change while it is in the DOM.
  function updateEntry(view) {
    const { digest, node } = view;
    const seq = digest.seq;
    const expanded = state.expanded.has(seq);
    const can = expanded || expandable(digest);
    node.classList.toggle("is-expanded", expanded);
    node.classList.toggle("can-expand", can && !expanded);
    node.classList.toggle("is-hot", state.hotCrop !== null && view.crop === state.hotCrop);
    node.classList.toggle("is-target", state.targetSeq === seq);
    node.classList.toggle("is-open", state.openSeq === seq && isPanelOpen());
    node.classList.toggle("is-future", state.cursor !== null && seq > state.cursor);
    // The head keeps its height with or without the button, so this never moves the list.
    view.toggle.hidden = !can;
    updateToggle(view, expanded);
  }

  // A new search: the rendered lines carry the old highlights.
  function relineViews() {
    state.needleDirty = false;
    for (const view of state.nodes.values()) renderLines(view);
  }

  function updateAllEntries() {
    for (const view of state.nodes.values()) updateEntry(view);
  }

  function refreshEntry(seq) {
    const view = state.nodes.get(seq);
    if (!view) return;
    renderLines(view);
    updateEntry(view);
  }

  function toggleExpanded(digest) {
    const seq = digest.seq;
    if (state.expanded.has(seq)) state.expanded.delete(seq);
    else {
      state.expanded.add(seq);
      const full = state.full.get(seq);
      const clipped = digest.lines.some((line) => line.truncated);
      if (clipped && (!full || full.status === "error")) loadFull(digest);
    }
    refreshEntry(seq);
  }

  // UI-SPEC 5.5: clamped text "expands on click". Collapsing is left to the button, so that
  // selecting expanded text to copy it does not fold it away.
  function expandByClick(digest) {
    if (state.expanded.has(digest.seq) || !expandable(digest)) return;
    const selection = typeof getSelection === "function" ? getSelection() : null;
    if (selection && !selection.isCollapsed) return;
    toggleExpanded(digest);
  }

  // ---------------------------------------------------------------- full events

  function fetchEnvelope(seq) {
    let pending = state.envelopes.get(seq);
    if (pending) return pending;
    pending = api.get(panoUrl(runId, pid, "/events?seq=" + seq + "&full=1"), { signal }).then((data) => {
      const events = data && Array.isArray(data.events) ? data.events : [];
      // Only the event that was asked for: showing a neighbour's JSON under this number would mislead.
      const envelope = events.find((event) => event && Number(event.seq) === seq) || (events.length === 1 && events[0] && events[0].seq === undefined ? events[0] : null);
      if (!envelope) throw new Error("The server has no event #" + seq + " for this panorama. Reload the page; the log may have been rebuilt.");
      return envelope;
    });
    state.envelopes.set(seq, pending);
    // A failed request is not kept: Retry must ask the server again.
    pending.catch(() => { if (state.envelopes.get(seq) === pending) state.envelopes.delete(seq); });
    return pending;
  }

  async function loadFull(digest) {
    const seq = digest.seq;
    state.full.set(seq, { status: "loading" });
    refreshEntry(seq);
    let result;
    try {
      const lines = fullLines(await fetchEnvelope(seq), digest);
      result = lines ? { status: "ready", lines } : { status: "partial" };
    } catch (err) {
      if (err && err.name === "AbortError") return;
      result = { status: "error", message: errorText(err) };
    }
    if (state.destroyed || !state.seqs.has(seq)) return;
    state.full.set(seq, result);
    refreshEntry(seq);
  }

  function isPanelOpen() {
    return Boolean(state.panelBody && state.panelBody.isConnected);
  }

  function fact(label, value) {
    return el("span", "stream-json-fact", el("span", "dim", label), " ", el("span", "mono", value));
  }

  function fillPanel(holder, envelope) {
    const tree = jsonTree(envelope);
    const copy = copyButton(() => JSON.stringify(envelope, null, 2), { label: "Copy JSON", title: "Copy the full event as JSON" });
    copy.classList.add("stream-copy");
    const penalty = envelope.penalty_state && typeof envelope.penalty_state === "object" ? envelope.penalty_state : {};
    const facts = el("div", "stream-json-facts",
      badge(typeLabel(envelope.type), "dim"),
      fact("at", fmtClock(envelope.t_rel_s)),
      fact("clock", fmtTime(envelope.ts)),
      envelope.actor ? fact("actor", String(envelope.actor)) : null,
      finite(penalty.multiplier) === null ? null : fact("multiplier", fmtMult(penalty.multiplier)));
    const tools = el("div", "stream-json-tools",
      copy,
      el("button", { type: "button", class: "small", onclick: () => expandTree(tree) }, icon("expand"), "Expand all"),
      el("button", { type: "button", class: "small", onclick: () => collapseTree(tree) }, icon("collapse"), "Collapse all"));
    replace(holder, facts, tools, tree);
  }

  async function loadPanel(holder, seq) {
    replace(holder, el("div", "stream-note", el("span", "spinner"), " Loading event #" + seq + "…"));
    try {
      const envelope = await fetchEnvelope(seq);
      if (holder.isConnected) fillPanel(holder, envelope);
    } catch (err) {
      if ((err && err.name === "AbortError") || !holder.isConnected) return;
      replace(holder,
        el("div", "notice notice-bad", icon("alert"), el("span", "pre", "Could not load event #" + seq + ". " + errorText(err))),
        el("div", null, el("button", { type: "button", onclick: () => loadPanel(holder, seq) }, icon("refresh"), "Retry")));
    }
  }

  function setOpenSeq(seq) {
    state.openSeq = seq;
    updateAllEntries();
  }

  function showPanel(seq) {
    if (state.openSeq === seq && isPanelOpen()) return;
    const digest = state.all[indexOfSeq(state.all, seq)];
    const holder = el("div", "stream-json");
    state.panelBody = holder;
    sidePanel.open({
      title: "Event #" + seq + (digest ? " · " + entryLabel(digest) : ""),
      body: holder,
      onClose: () => {
        if (state.panelBody !== holder) return;
        state.panelBody = null;
        setOpenSeq(null);
        if (!state.silentClose && onOpenEvent) onOpenEvent(null);
      },
    });
    setOpenSeq(seq);
    loadPanel(holder, seq);
  }

  function hidePanel() {
    if (!isPanelOpen()) {
      // Another component replaced our panel: only forget it.
      state.panelBody = null;
      if (state.openSeq !== null) setOpenSeq(null);
      return;
    }
    state.silentClose = true;
    try {
      sidePanel.close();
    } finally {
      state.silentClose = false;
    }
  }

  function openByOperator(seq) {
    showPanel(seq);
    if (onOpenEvent) onOpenEvent(seq);
  }

  // ---------------------------------------------------------------- chrome: chips, search, pill, empty

  function publicFilter() {
    return CATEGORIES.filter((category) => state.filter.has(category));
  }

  function notifyChange() {
    if (onChange) onChange({ filter: publicFilter(), search: state.search });
  }

  function toggleCategory(key) {
    if (key === "all") state.filter.clear();
    else if (state.filter.has(key)) state.filter.delete(key);
    else state.filter.add(key);
    // All six pressed is the same as none: say "All" rather than six pressed chips.
    if (state.filter.size === CATEGORIES.length) state.filter.clear();
    invalidate();
    updateChips();
    notifyChange();
  }

  function applySearch(text, byOperator) {
    const value = String(text ?? "");
    if (input.value !== value) input.value = value;
    if (value === state.search) return;
    state.search = value;
    const needle = searchNeedle(value);
    if (needle !== state.needle) {
      state.needle = needle;
      state.needleDirty = true;
      invalidate();
    }
    updateSearchSide();
    if (byOperator) notifyChange();
  }

  const typed = debounce(() => applySearch(input.value, true), SEARCH_DEBOUNCE_MS);
  input.addEventListener("input", typed);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    typed.cancel();
    if (input.value) applySearch("", true);
    else input.blur();
  });

  function updateChips() {
    const all = chips.get("all");
    all.button.setAttribute("aria-pressed", state.filter.size ? "false" : "true");
    all.count.textContent = fmtInt(state.counts.all);
    for (const category of CATEGORIES) {
      const chip = chips.get(category);
      const count = state.counts[category];
      chip.button.setAttribute("aria-pressed", state.filter.has(category) ? "true" : "false");
      chip.button.classList.toggle("is-zero", count === 0);
      chip.count.textContent = fmtInt(count);
    }
  }

  function updateSearchSide() {
    clearSearch.hidden = !state.search;
    matchCount.hidden = !state.needle;
    if (state.needle) matchCount.textContent = fmtInt(state.counts.all) + " of " + fmtInt(state.all.length);
  }

  function updateJump() {
    const show = !state.following && state.items.length > 0;
    jump.hidden = !show;
    if (!show) return;
    const unseen = countAfter(state.items, state.seenSeq);
    jumpCount.hidden = unseen === 0;
    jumpCount.textContent = fmtInt(unseen) + " new";
  }

  function emptyContent(kind) {
    if (kind === "loading") return [el("span", "spinner"), el("div", null, "Loading events…")];
    if (kind === "error") {
      return [
        el("div", "notice notice-bad", icon("alert"), el("span", "pre", "Could not load the events. " + state.loadError)),
        el("button", { type: "button", onclick: () => loadBacklog() }, icon("refresh"), "Retry"),
      ];
    }
    if (kind === "filtered") {
      return [
        el("div", "stream-empty-title", "No entry matches"),
        el("div", null, fmtInt(state.all.length) + " loaded, none passes the filters and the search."),
        el("button", { type: "button", class: "small", onclick: () => clearFilters() }, "Show everything"),
      ];
    }
    return [el("div", "stream-empty-title", "No events yet"), el("div", null, "Entries appear here as the agent works.")];
  }

  function emptyKindNow() {
    if (state.items.length) return null;
    if (state.all.length) return "filtered";
    if (state.loadError) return "error";
    if (state.loading && !state.loadedOnce) return "loading";
    return "none";
  }

  function updateEmpty() {
    const kind = emptyKindNow();
    // An error message can change while the kind stays the same.
    const key = kind === "error" ? "error:" + state.loadError : kind === "filtered" ? "filtered:" + state.all.length : kind;
    if (key === state.emptyKind) return;
    state.emptyKind = key;
    empty.hidden = kind === null;
    replace(empty, kind === null ? null : emptyContent(kind));
  }

  // A failed reload while entries are on screen: they stay, and a bar says they may be behind.
  function updateAlert() {
    const show = Boolean(state.loadError) && state.items.length > 0;
    alertBar.hidden = !show;
    if (!show) {
      alertBar.dataset.message = "";
      return;
    }
    if (alertBar.dataset.message === state.loadError) return;
    alertBar.dataset.message = state.loadError;
    replace(alertBar,
      icon("alert"),
      el("span", "stream-alert-text", "Could not load newer events; this list may be behind. " + state.loadError),
      el("button", { type: "button", class: "small", onclick: () => loadBacklog() }, icon("refresh"), "Retry"));
  }

  function updateChrome() {
    updateChips();
    updateSearchSide();
    updateEmpty();
    updateAlert();
    updateJump();
  }

  function clearFilters() {
    typed.cancel();
    state.filter.clear();
    applySearch("", false);
    invalidate();
    updateChips();
    notifyChange();
  }

  // ---------------------------------------------------------------- data in

  function add(rawDigests) {
    let added = false;
    for (const raw of rawDigests) {
      const digest = normaliseDigest(raw);
      if (!digest || state.seqs.has(digest.seq)) continue;
      state.seqs.add(digest.seq);
      insertDigest(state.all, digest);
      added = true;
    }
    if (!added) return;
    if (state.following) markSeen();
    invalidate();
  }

  // Every seq up to `contiguous` is loaded; step over what arrived live ahead of the backlog.
  function absorbContiguous() {
    while (state.seqs.has(state.contiguous + 1)) state.contiguous += 1;
  }

  async function loadBacklog() {
    if (state.destroyed || !live) return;
    if (state.loading) {
      state.reload = true;
      return;
    }
    state.loading = true;
    state.reload = false;
    updateChrome();
    const before = state.contiguous;
    let failed = null;
    try {
      const data = await api.get(panoUrl(runId, pid, "/events?after=" + state.contiguous), { signal });
      const events = data && Array.isArray(data.events) ? data.events : [];
      add(events);
      for (const event of events) {
        const seq = Number(event && event.seq);
        // The response is complete up to its last event, whatever the server chose to leave out.
        if (Number.isInteger(seq) && seq > state.contiguous) state.contiguous = seq;
      }
      absorbContiguous();
      state.loadedOnce = true;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      failed = errorText(err);
    } finally {
      state.loading = false;
    }
    if (state.destroyed) return;
    state.loadError = failed;
    // Live events can run ahead of the response that was on its way: fetch the stretch between,
    // but only while the server keeps bringing something, or a hole it never fills would loop.
    const newest = state.all.length ? state.all[state.all.length - 1].seq : 0;
    const behind = newest > state.contiguous && state.contiguous > before;
    const again = !failed && (state.reload || behind);
    state.reload = false;
    schedule();
    if (again) loadBacklog();
  }

  function receiveLive(raw) {
    const seq = Number(raw && raw.seq);
    if (!Number.isInteger(seq)) return;
    add([raw]);
    absorbContiguous();
    // A seq ahead of what we hold means events were missed (a dropped stream, a late mount):
    // fetch from the last complete one. While the first load is under way it will cover them.
    if (seq > state.contiguous && state.loadedOnce) loadBacklog();
  }

  if (live) {
    cleanups.push(store.on("pano", (msg) => {
      if (!msg || msg.run_id !== runId || msg.panorama_id !== pid || !msg.event) return;
      receiveLive(msg.event);
    }));
    // A new snapshot means the stream was (re)connected, or is being polled while it is down:
    // either way events may have been missed in between.
    cleanups.push(store.on("snapshot", () => {
      if (state.loadedOnce || state.loadError) loadBacklog();
    }));
    loadBacklog();
  }

  // ---------------------------------------------------------------- targets

  // Make an entry the place to restore: layout() then puts it at the top of the viewport.
  function aimAt(seq) {
    state.following = false;
    state.anchor = { seq, offset: -TARGET_MARGIN_PX };
    state.layoutDirty = true;
  }

  // Whether a digest that is not in memory may still arrive: until the first backlog is in for a
  // live stream, and at any time for one that is fed by the screen.
  function mayArrive(seq) {
    if (state.seqs.has(seq)) return false;
    return live ? !state.loadedOnce && !state.loadError : true;
  }

  // A target asked for before its digest was loaded (a `?event=` link opened cold).
  function takePendingTarget() {
    if (state.pendingTarget === null) return;
    const seq = state.pendingTarget;
    if (indexOfSeq(state.items, seq) >= 0) aimAt(seq);
    // Loaded but hidden by the filters, or no such event: there is nothing to scroll to.
    else if (mayArrive(seq)) return;
    state.pendingTarget = null;
  }

  function scrollToSeq(seq, { highlight = true } = {}) {
    const wanted = wholeOrNull(seq);
    if (highlight) {
      state.targetSeq = wanted;
      updateAllEntries();
    }
    state.pendingTarget = null;
    if (wanted === null || state.destroyed) return false;
    syncItems();
    if (indexOfSeq(state.items, wanted) >= 0) {
      aimAt(wanted);
      runNow(true);
      return true;
    }
    if (mayArrive(wanted)) state.pendingTarget = wanted;
    return false;
  }

  // ---------------------------------------------------------------- public API

  updateChrome();

  return {
    /** The root element (already appended to the container). */
    el: root,

    /** Add one digest (or an array of them); a seq that is already there is ignored. */
    append(digest) {
      if (state.destroyed) return;
      add(Array.isArray(digest) ? digest : [digest]);
    },

    /**
     * Replace everything with these digests (replay). Filters, search and the entry marked by
     * scrollToSeq are kept; the list goes back to following the tail, unless a target that was
     * asked for earlier is among the new digests. Meant for `live: false`; on a live stream the
     * given digests are taken as complete up to their last seq.
     */
    reset(digests) {
      if (state.destroyed) return;
      dropAllViews();
      state.all = [];
      state.seqs = new Set();
      state.expanded.clear();
      state.full.clear();
      state.envelopes.clear();
      state.heights.clear();
      state.overflow.clear();
      state.contiguous = 0;
      state.loadError = null;
      setFollowing(true);
      add(Array.isArray(digests) ? digests : []);
      if (state.all.length) state.contiguous = state.all[state.all.length - 1].seq;
      markSeen();
      invalidate();
    },

    /** Show only these categories: an array, a comma list (`?filter=`), or null / [] for all. */
    setFilter(categories) {
      const next = parseFilter(categories);
      if (next.join() === publicFilter().join()) return;
      state.filter = new Set(next);
      invalidate();
      updateChips();
    },

    /** Set the search text (`?q=`). Matches line text and tool name of the loaded digests. */
    setSearch(text) {
      // The echo of what the operator just typed (the screen mirrors it in `?q=`) must not
      // overwrite the characters typed since.
      if (String(text ?? "") === state.search) return;
      typed.cancel();
      applySearch(text, false);
    },

    /** `{filter, search, total, shown, counts, following, unseen, lastSeq, openSeq, loading, error}`. */
    getState() {
      syncItems();
      return {
        filter: publicFilter(),
        search: state.search,
        total: state.all.length,
        shown: state.items.length,
        counts: { ...state.counts },
        following: state.following,
        unseen: state.following ? 0 : countAfter(state.items, state.seenSeq),
        lastSeq: state.all.length ? state.all[state.all.length - 1].seq : null,
        openSeq: isPanelOpen() ? state.openSeq : null,
        loading: state.loading,
        error: state.loadError,
      };
    },

    /** Put the cursor in the search box (the `/` shortcut). */
    focusSearch() {
      input.focus();
      input.select();
    },

    /**
     * `scrollToSeq(seq, {highlight = true}?)`: scroll to an entry and mark it; `scrollToSeq(null)`
     * removes the mark. Returns false when the entry is not in the list: hidden by the filters
     * (nothing happens), or not loaded yet (the stream goes there when it arrives).
     */
    scrollToSeq,

    /**
     * Open the full JSON of an event in the side panel and scroll to its entry (`?event=`);
     * `openEvent(null)` closes the panel. Does not call onOpenEvent.
     */
    openEvent(seq, { scroll = true } = {}) {
      const wanted = wholeOrNull(seq);
      if (wanted === null) {
        hidePanel();
        return;
      }
      showPanel(wanted);
      if (scroll) scrollToSeq(wanted);
    },

    /**
     * Mark the entries of view_crop number `n` (the viewer's footprint is hovered); null clears.
     * `{scroll: true}` also brings the crop's entry into view.
     */
    highlightCrop(n, { scroll = false } = {}) {
      state.hotCrop = wholeOrNull(n);
      updateAllEntries();
      if (!scroll || state.hotCrop === null) return;
      syncItems();
      const match = state.items.filter((digest) => entryCrop(digest) === state.hotCrop).pop();
      if (match) scrollToSeq(match.seq, { highlight: false });
    },

    /**
     * Replay: dim the entries after this seq (the scrubber's position); null shows all as usual.
     * Nothing is removed, so the operator can still read ahead.
     */
    setCursor(seq) {
      state.cursor = wholeOrNull(seq);
      updateAllEntries();
    },

    /** Scroll to the newest entry and follow the tail again. */
    jumpToLatest,

    /** Unsubscribe from the store, stop every request and timer, and remove the element. */
    destroy() {
      if (state.destroyed) return;
      hidePanel();
      state.destroyed = true;
      state.scheduled = false;
      for (const off of cleanups) off();
      if (aborter) aborter.abort();
      typed.cancel();
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      clearTimeout(timer);
      if (observer) observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      if (state.hoverSeq !== null && onCropHover) onCropHover(null);
      state.nodes.clear();
      root.remove();
    },
  };
}
