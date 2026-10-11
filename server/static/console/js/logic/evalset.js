// Decisions of the Evaluation screen's Set and Label tabs (UI-SPEC 5.9), kept pure so they can be
// tested with `node --test`: nothing here touches the DOM or the network.
//
// An entry is one item of `GET /api/eval/set` `entries`:
//   {panorama_id, filename, label ("Urban"|"non-Urban"|"TODO"), label_confirmed, lat, lng, area,
//    country, kind, timestamp}

export const URBAN = "Urban";
export const NON_URBAN = "non-Urban";
export const TODO = "TODO";
export const LABELS = [URBAN, NON_URBAN];

// ---------------------------------------------------------------- tabs (A1: /eval?tab=…)

export const TABS = [
  { name: "set", label: "Set" },
  { name: "label", label: "Label" },
  { name: "run", label: "Run" },
  { name: "results", label: "Results" },
  { name: "compare", label: "Compare" },
];

/** The tab a `?tab=` value names; anything else (absent, mistyped) is the Set tab. */
export function tabOf(value) {
  return TABS.some((tab) => tab.name === value) ? value : "set";
}

// Per-browser preferences of the labelling tool (prefs.js). They are not part of the URL: A1
// fixes the query keys of /eval, and how one operator likes to walk the set is not worth a link.
export const PREF_FILTER = "evalLabelFilter";
export const PREF_VIEW = "evalLabelView";

// ---------------------------------------------------------------- label state

/**
 * "todo" (no usable label: runs refuse to start), "unconfirmed" (a guess from the kind of place
 * that nobody has looked at) or "confirmed" (set by hand). The three are disjoint, as the server
 * counts them.
 */
export function labelState(entry) {
  if (!entry || !LABELS.includes(entry.label)) return "todo";
  return entry.label_confirmed ? "confirmed" : "unconfirmed";
}

export function countStates(entries) {
  const counts = { count: 0, confirmed: 0, unconfirmed: 0, todo: 0 };
  for (const entry of entries || []) {
    counts.count += 1;
    counts[labelState(entry)] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------- labelling queue

// "unconfirmed" is everything a human has not confirmed yet, TODO included: one pass over that
// filter finishes the set, as `build_set label --todo` does.
export const FILTERS = [
  { name: "todo", label: "TODO" },
  { name: "unconfirmed", label: "Not confirmed" },
  { name: "all", label: "All" },
];

export function normaliseFilter(value) {
  return FILTERS.some((filter) => filter.name === value) ? value : "unconfirmed";
}

export function matchesFilter(entry, filter) {
  const state = labelState(entry);
  if (filter === "todo") return state === "todo";
  if (filter === "unconfirmed") return state !== "confirmed";
  return true;
}

export function filterCounts(entries) {
  const counts = countStates(entries);
  return { todo: counts.todo, unconfirmed: counts.todo + counts.unconfirmed, all: counts.count };
}

/**
 * The ids to walk through, in manifest order. The queue is fixed when the filter is chosen: a
 * panorama that has just been labelled stays in it, so the operator can step back and correct a
 * slip. `keepId` (the panorama named in the URL) is included whatever the filter says.
 */
export function buildQueue(entries, filter, keepId = null) {
  return (entries || [])
    .filter((entry) => matchesFilter(entry, filter) || entry.panorama_id === keepId)
    .map((entry) => entry.panorama_id);
}

export function indexById(entries) {
  const byId = new Map();
  for (const entry of entries || []) byId.set(entry.panorama_id, entry);
  return byId;
}

/** The neighbour `delta` places away in the queue, or null at either end (no wrap-around). */
export function step(queue, currentId, delta) {
  const at = queue.indexOf(currentId);
  if (at === -1) return queue.length ? queue[0] : null;
  const next = at + delta;
  return next >= 0 && next < queue.length ? queue[next] : null;
}

/**
 * The next panorama after `currentId` that still is not confirmed, searching forward and then
 * from the start (so skipped ones come round again). Null when nothing else is left to do.
 */
export function nextToDo(queue, byId, currentId) {
  const at = queue.indexOf(currentId);
  for (let offset = 1; offset < queue.length + (at === -1 ? 1 : 0); offset += 1) {
    const id = queue[(at + offset + queue.length) % queue.length];
    if (id !== currentId && labelState(byId.get(id)) !== "confirmed") return id;
  }
  return null;
}

/** Where the operator is: `{position (1-based, 0 when not in the queue), total, toDo}`. */
export function queueProgress(queue, byId, currentId) {
  let toDo = 0;
  for (const id of queue) if (labelState(byId.get(id)) !== "confirmed") toDo += 1;
  return { position: queue.indexOf(currentId) + 1, total: queue.length, toDo };
}

/** "12 of 50, 3 to do" */
export function progressText(progress) {
  if (!progress.total) return "nothing to label";
  const where = progress.position ? progress.position + " of " + progress.total : progress.total + " in this list";
  return where + ", " + (progress.toDo ? progress.toDo + " to do" : "all confirmed");
}

// How a label and its state are written on a badge: {text, kind, icon}. Urban / non-Urban is a
// property, not a status, so it carries no icon; the states do (never colour alone).
export function labelBadge(label) {
  if (label === URBAN) return { text: URBAN, kind: "urban", icon: null };
  if (label === NON_URBAN) return { text: NON_URBAN, kind: "nonurban", icon: null };
  return { text: TODO, kind: "bad", icon: "alert" };
}

export function stateBadge(state) {
  if (state === "confirmed") return { text: "confirmed by hand", kind: "ok", icon: "check" };
  if (state === "unconfirmed") return { text: "guess, not confirmed", kind: "warn", icon: "question" };
  return { text: "no label yet", kind: "bad", icon: "alert" };
}

/** A copy of `entries` with the one the server returned swapped in. */
export function replaceEntry(entries, entry) {
  return (entries || []).map((old) => (old.panorama_id === entry.panorama_id ? { ...old, ...entry } : old));
}

// ---------------------------------------------------------------- entries table

const STATE_ORDER = { todo: 0, unconfirmed: 1, confirmed: 2 };
const text = (value) => String(value ?? "");

export const SORT_KEYS = {
  panorama_id: (entry) => text(entry.panorama_id),
  label: (entry) => text(entry.label),
  state: (entry) => STATE_ORDER[labelState(entry)],
  area: (entry) => text(entry.area).toLowerCase(),
  country: (entry) => text(entry.country),
  kind: (entry) => text(entry.kind),
  timestamp: (entry) => text(entry.timestamp),
  lat: (entry) => (Number.isFinite(Number(entry.lat)) ? Number(entry.lat) : -Infinity),
  lng: (entry) => (Number.isFinite(Number(entry.lng)) ? Number(entry.lng) : -Infinity),
};

/** `{key: null}` keeps the manifest order, which is the order the runs take them in. */
export function sortEntries(entries, sort) {
  const list = (entries || []).slice();
  const read = sort && SORT_KEYS[sort.key];
  if (!read) return list;
  const sign = sort.dir === "desc" ? -1 : 1;
  // Array.prototype.sort is stable, so equal rows keep their manifest order.
  return list.sort((a, b) => {
    const x = read(a);
    const y = read(b);
    if (x < y) return -sign;
    if (x > y) return sign;
    return 0;
  });
}

/** Click on a column header: ascending, then descending, then back to the manifest order. */
export function nextSort(sort, key) {
  if (!sort || sort.key !== key) return { key, dir: "asc" };
  if (sort.dir === "asc") return { key, dir: "desc" };
  return { key: null, dir: "asc" };
}

/** `by_country` / `by_kind` of the set as rows, largest first: [{name, n, share}]. */
export function breakdown(counts) {
  const rows = Object.entries(counts || {}).map(([name, n]) => ({ name: name || "(not recorded)", n: Number(n) || 0 }));
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  rows.sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows.map((row) => ({ ...row, share: total ? row.n / total : 0 }));
}

/** True when the entry has coordinates that can go on a map. */
export function hasPoint(entry) {
  if (!entry || entry.lat === null || entry.lat === undefined || entry.lng === null || entry.lng === undefined) return false;
  return Number.isFinite(Number(entry.lat)) && Number.isFinite(Number(entry.lng));
}

/** The capture stamp of an entry ("20180511142427") as "2018-05-11 14:24"; other text as it is. */
export function fmtStamp(stamp) {
  const value = text(stamp);
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!m) return value || "–";
  return m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5];
}

// ---------------------------------------------------------------- images

export const IMAGE_WIDTHS = [1024, 2048, 4096];

/** Same-origin API path of one evaluation panorama at about `width` pixels. */
export function imageUrl(pid, width) {
  return "/api/eval/set/" + encodeURIComponent(pid) + "/image?w=" + encodeURIComponent(width);
}

/** Sources for the 360° viewer, smallest first. */
export function imageSources(pid) {
  return IMAGE_WIDTHS.map((width) => ({ width, url: imageUrl(pid, width) }));
}

// ---------------------------------------------------------------- build form

// The bounds of `POST /api/eval/set/build` (the server checks them again and is authoritative).
export const BUILD_FIELDS = {
  count: { label: "Panoramas", min: 1, max: 50, fallback: 40 },
  seed: { label: "Seed", min: -(2 ** 31), max: 2 ** 31 - 1, fallback: 0 },
  per_area_limit: { label: "Images per area", min: 1, max: 2000, fallback: 100 },
};

function wholeNumber(raw) {
  const value = text(raw).trim();
  return /^[+-]?\d+$/.test(value) ? Number(value) : null;
}

/**
 * Read the build form: `{body, errors}` where `errors` maps a field to what is wrong with it.
 * `body` is only meaningful when `errors` is empty.
 */
export function readBuildForm(form) {
  const body = { replace: Boolean(form.replace) };
  const errors = {};
  for (const [key, field] of Object.entries(BUILD_FIELDS)) {
    const value = wholeNumber(form[key]);
    if (value === null || value < field.min || value > field.max) {
      errors[key] = "A whole number from " + field.min + " to " + field.max + ".";
    } else body[key] = value;
  }
  return { body, errors };
}

/**
 * Why "Build set" cannot be pressed now, in the operator's words, or null when it can.
 * `set` is the `GET /api/eval/set` state (null while unknown).
 */
export function buildBlockedReason({ set, form, jobActive }) {
  if (!set) return "The state of the evaluation set is not known yet.";
  if (jobActive) return "A build is running. Wait for it to end.";
  if (!set.mapillary_token) return "MAPILLARY_TOKEN is not set. Save one under Settings, Keys.";
  if (Object.keys(readBuildForm(form).errors).length) return "Correct the fields marked above.";
  if (set.exists && !form.replace) {
    return "There is already an evaluation set. Tick \"Replace the existing set\" to build a new one.";
  }
  return null;
}

/** What replacing the set costs, as the lines of the confirmation. */
export function replaceLossLines(set) {
  const count = Number(set && set.count) || 0;
  const confirmed = Number(set && set.confirmed) || 0;
  const lines = [];
  lines.push(count
    ? "The current set of " + count + (count === 1 ? " panorama" : " panoramas") + " is replaced by a new sample."
    : "The current manifest is replaced by a new sample.");
  lines.push(confirmed
    ? confirmed + (confirmed === 1 ? " label" : " labels") + " confirmed by hand " + (confirmed === 1 ? "is" : "are") +
      " lost. Every panorama of the new set has to be reviewed again before a run."
    : "No label has been confirmed by hand yet, so no hand work is lost. The new set has to be reviewed before a run.");
  lines.push("Results of earlier evaluation runs stay on disk, but they were scored against the old set and do not " +
    "pair with runs on the new one.");
  return lines;
}

/**
 * Idempotency for the build: a retry of the very same request after the server could not be
 * reached (or failed) reuses its key so the build starts once. After any answer from the server
 * (a 4xx is cached with the key for an hour) or with a changed form, a new key is needed.
 */
export function canReuseKey(last, bodyJson) {
  if (!last || last.bodyJson !== bodyJson) return false;
  return last.status === 0 || last.status >= 500;
}

// ---------------------------------------------------------------- build job

/** What to show of a build Job: `{state, active, failed, fraction (0..1 or null), counts, text}`. */
export function jobView(job) {
  if (!job) return null;
  const progress = job.progress || {};
  const done = Number(progress.done);
  const total = Number(progress.total);
  const known = Number.isFinite(done) && Number.isFinite(total) && total > 0;
  const active = job.state === "queued" || job.state === "running";
  return {
    state: job.state,
    active,
    failed: job.state === "failed",
    fraction: job.state === "done" ? 1 : known ? Math.max(0, Math.min(1, done / total)) : null,
    counts: known ? done + " of " + total : "",
    text: text(progress.text),
  };
}
