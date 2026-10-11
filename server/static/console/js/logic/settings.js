// Pure logic of the Settings screen (UI-SPEC 5.10): which section a hash names, how a form value
// is read and checked against its `fields` entry, what a Save sends, where a server problem
// belongs, and the words for keys, health rows and LAN access.
//
// Nothing here decides what is valid in the end: the server checks whatever is sent. These checks
// only stop a request that could not succeed and put the reason next to the field.

import { fmtBytes, fmtInt } from "../format.js";

// ---------------------------------------------------------------- sections

/** The sections of the page, in order. The first five ids are the hashes of contract A1. */
export const SECTIONS = [
  { id: "keys", label: "Keys" },
  { id: "defaults", label: "Defaults for new runs" },
  { id: "organiser", label: "Organiser answers" },
  { id: "paths", label: "Directories" },
  { id: "health", label: "Health" },
  { id: "lan", label: "LAN access" },
  { id: "browser", label: "This browser" },
];

/** The section a location hash names ("#health", "health"), or null. */
export function sectionFromHash(hash) {
  let id = String(hash ?? "").replace(/^#/, "");
  try {
    id = decodeURIComponent(id);
  } catch (_) {
    // keep the raw text
  }
  return SECTIONS.some((section) => section.id === id) ? id : null;
}

/**
 * The section the operator is reading: the last one whose top edge is at or above `line` (a y
 * position in the viewport), else the first. `tops` is `[{id, top}]` in page order.
 */
export function sectionAt(tops, line) {
  let current = tops.length ? tops[0].id : null;
  for (const { id, top } of tops) {
    if (top <= line) current = id;
  }
  return current;
}

// ---------------------------------------------------------------- fields of the defaults form

/** "standard.max_turns" -> "standard": the key `PUT /api/settings {defaults}` is sent under. */
export function topKey(key) {
  return String(key).split(".")[0];
}

/** Read a dotted key out of the `defaults` object. */
export function readPath(source, key) {
  let value = source;
  for (const part of String(key).split(".")) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

const KINDS = new Set(["bool", "choice", "tools", "int", "number", "text"]);

/** The control a field is edited with. A type this page does not know is edited as text. */
export function controlKind(field) {
  const type = field ? field.type : null;
  if (KINDS.has(type)) return type;
  return field && Array.isArray(field.choices) ? "choice" : "text";
}

/** A saved value as the control holds it: a boolean, a sorted list of names, or a string. */
export function toRaw(field, value) {
  const kind = controlKind(field);
  if (kind === "bool") return value === true;
  if (kind === "tools") return Array.isArray(value) ? value.map(String).sort() : [];
  if (value === null || value === undefined) return "";
  return String(value);
}

function bounds(field, n) {
  if (typeof field.min === "number" && n < field.min) return "Must be " + field.min + " or more.";
  if (typeof field.max === "number" && n > field.max) return "Must be " + field.max + " or less.";
  return null;
}

/** What a control holds, as the value to send: `{value, error}` with `error` null when it is usable. */
export function parseRaw(field, raw) {
  const kind = controlKind(field);
  if (kind === "bool") return { value: raw === true, error: null };
  if (kind === "tools") {
    const names = Array.isArray(raw) ? Array.from(new Set(raw.map(String))).sort() : [];
    const allowed = Array.isArray(field.choices) ? new Set(field.choices) : null;
    const unknown = allowed ? names.filter((name) => !allowed.has(name)) : [];
    return {
      value: names,
      error: unknown.length ? unknown.join(", ") + " cannot be switched off here." : null,
    };
  }
  const text = String(raw ?? "").trim();
  if (kind === "int" || kind === "number") {
    if (text === "") return { value: null, error: kind === "int" ? "Enter a whole number." : "Enter a number." };
    const n = Number(text);
    if (!Number.isFinite(n)) return { value: null, error: "Must be a number." };
    if (kind === "int" && !Number.isInteger(n)) return { value: null, error: "Must be a whole number." };
    return { value: n, error: bounds(field, n) };
  }
  if (kind === "choice") {
    const known = !Array.isArray(field.choices) || field.choices.some((choice) => String(choice) === text);
    return { value: text, error: known ? null : "Choose one of the listed values." };
  }
  const limit = typeof field.max_length === "number" ? field.max_length : null;
  if (limit !== null && text.length > limit) return { value: text, error: "At most " + limit + " characters." };
  return { value: text, error: null };
}

/** Why a control's content cannot be saved, or null. */
export function validateField(field, raw) {
  return parseRaw(field, raw).error;
}

/** Two setting values are the same setting: lists compare as sets, numbers by value. */
export function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const names = new Set(a.map(String));
    return b.every((item) => names.has(String(item)));
  }
  if (typeof a === "number" && typeof b === "number") return a === b;
  return a === b || (a === undefined && b === null) || (a === null && b === undefined);
}

/** True when the control differs from the saved value (content that cannot be parsed counts). */
export function isDirty(field, saved, raw) {
  const parsed = parseRaw(field, raw);
  return parsed.error !== null || !sameValue(parsed.value, saved);
}

/** Fields grouped under their `group`, groups in the order they first appear. */
export function groupFields(fields) {
  const groups = [];
  const byName = new Map();
  for (const field of fields || []) {
    const name = field.group || "Other";
    if (!byName.has(name)) {
      byName.set(name, { group: name, fields: [] });
      groups.push(byName.get(name));
    }
    byName.get(name).fields.push(field);
  }
  return groups;
}

/**
 * A group's fields cut into blocks for layout: a run of two or more fields of the same dotted
 * prefix (the four numbers of one budget) is a block of its own, so the budgets line up as rows.
 * Returns `[{prefix: string|null, fields}]`.
 */
export function fieldBlocks(fields) {
  const blocks = [];
  const prefixOf = (field) => (String(field.key).includes(".") ? topKey(field.key) : null);
  let i = 0;
  while (i < fields.length) {
    const prefix = prefixOf(fields[i]);
    let j = i + 1;
    while (prefix !== null && j < fields.length && prefixOf(fields[j]) === prefix) j += 1;
    if (prefix !== null && j - i >= 2) {
      blocks.push({ prefix, fields: fields.slice(i, j) });
      i = j;
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last && last.prefix === null) last.fields.push(fields[i]);
    else blocks.push({ prefix: null, fields: [fields[i]] });
    i += 1;
  }
  return blocks;
}

/** A saved override can be forgotten: the value then follows the server's environment again. */
export function canReset(field, overridden) {
  return Array.isArray(overridden) && overridden.includes(topKey(field.key));
}

// A budget is stored whole, so forgetting one field of it forgets the five.
export function resetScope(field, fields) {
  const top = topKey(field.key);
  return (fields || []).filter((other) => topKey(other.key) === top);
}

function draftOf(drafts, key) {
  if (drafts instanceof Map) return drafts.has(key) ? { has: true, raw: drafts.get(key) } : { has: false };
  const has = Boolean(drafts) && Object.prototype.hasOwnProperty.call(drafts, key);
  return has ? { has: true, raw: drafts[key] } : { has: false };
}

const hasKey = (set, key) => (set instanceof Set ? set.has(key) : Array.isArray(set) && set.includes(key));

/**
 * What "Save" sends for the defaults form: only what differs from the saved values.
 *   drafts  Map (or object) field key -> what its control holds, for the fields the operator touched
 *   resets  Set (or list) of top-level keys to forget (a null in the body)
 * Returns `{body, changed: [field keys], resets: [top keys], errors: {field key: text}}`; `body`
 * is null when there is nothing to send. A dotted key becomes one entry of a nested object, so a
 * budget is sent with its changed fields only (the server fills in the rest).
 */
export function buildDefaultsBody(fields, defaults, drafts, resets) {
  const body = {};
  const changed = [];
  const errors = {};
  const effective = new Map(); // field key -> the value new runs would get after this save
  const dropped = [];
  for (const field of fields || []) {
    const top = topKey(field.key);
    const saved = readPath(defaults, field.key);
    if (hasKey(resets, top)) {
      if (!dropped.includes(top)) dropped.push(top);
      continue;
    }
    const draft = draftOf(drafts, field.key);
    if (!draft.has) {
      effective.set(field.key, saved);
      continue;
    }
    const parsed = parseRaw(field, draft.raw);
    if (parsed.error) {
      errors[field.key] = parsed.error;
      continue;
    }
    effective.set(field.key, parsed.value);
    if (sameValue(parsed.value, saved)) continue;
    changed.push(field.key);
    if (top === field.key) body[top] = parsed.value;
    else {
      if (!body[top] || typeof body[top] !== "object") body[top] = {};
      body[top][field.key.slice(top.length + 1)] = parsed.value;
    }
  }
  for (const [key, text] of Object.entries(crossErrors(fields, (key) => effective.get(key)))) {
    if (!errors[key]) errors[key] = text;
  }
  for (const top of dropped) body[top] = null;
  const empty = changed.length === 0 && dropped.length === 0;
  return { body: empty ? null : body, changed, resets: dropped, errors };
}

/**
 * Problems that involve two fields: a soft deadline later than its hard deadline. `valueOf(key)`
 * gives the value a field would have after saving. Returns `{field key: text}`.
 */
export function crossErrors(fields, valueOf) {
  const out = {};
  for (const field of fields || []) {
    if (!String(field.key).endsWith(".soft_deadline_s")) continue;
    const hardKey = topKey(field.key) + ".hard_deadline_s";
    const soft = valueOf(field.key);
    const hard = valueOf(hardKey);
    if (typeof soft === "number" && typeof hard === "number" && soft > hard) {
      out[field.key] = "Must not be later than the hard deadline (" + hard + " s).";
    }
  }
  return out;
}

function capitalise(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * Sort the server's `problems` to the things they are about. A problem belongs to the longest of
 * `keys` it starts with ("max_mcq must be…", "standard.max_turns is missing", "Q3: the note…").
 * Returns `{byKey: {key: [text]}, rest: [text]}`; the key is cut from the text shown at its field.
 */
export function problemsByField(problems, keys) {
  const byKey = {};
  const rest = [];
  const ordered = Array.from(keys || [], String).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const problem of problems || []) {
    const text = typeof problem === "string" ? problem : String((problem && (problem.text || problem.message)) ?? problem);
    const key = ordered.find((candidate) => {
      if (!text.startsWith(candidate)) return false;
      const next = text.charAt(candidate.length);
      return next === "" || next === " " || next === ":";
    });
    if (!key) {
      rest.push(text);
      continue;
    }
    const tail = text.slice(key.length).replace(/^[:\s]+/, "");
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(capitalise(tail) || text);
  }
  return { byKey, rest };
}

// ---------------------------------------------------------------- keys

/** What each key is for. `required`: runs cannot reach the model without it. */
export const KEY_INFO = {
  OPENAI_API_KEY: {
    title: "OpenAI",
    purpose: "The model. Without it every panorama ends on the fallback answer.",
    required: true,
    testNote: "The test sends one minimal request with the stored key (a few tokens).",
  },
  GOOGLE_MAPS_API_KEY: {
    title: "Google Maps",
    purpose: "Street View lookups by the agent. Optional: without it that tool is off.",
    required: false,
    testNote: "The test asks Street View for metadata with the stored key. It is free of charge.",
  },
  MAPILLARY_TOKEN: {
    title: "Mapillary",
    purpose: "Mapillary street-level imagery, and building the evaluation set. Optional.",
    required: false,
    testNote: "The test asks Mapillary for one image id with the stored token. It is free of charge.",
  },
};

export const KEY_NAMES = Object.keys(KEY_INFO);

/** Badge for a key: `{kind, text, icon}`. The value itself never reaches the page. */
export function keyStatus(name, entry) {
  const info = KEY_INFO[name] || { required: false };
  if (entry && entry.set) {
    const tail = typeof entry.last4 === "string" && entry.last4 ? ", ends in " + entry.last4 : "";
    return { kind: "ok", text: "set" + tail, icon: "check" };
  }
  return info.required
    ? { kind: "bad", text: "not set", icon: "x" }
    : { kind: "dim", text: "not set (optional)", icon: "minus" };
}

// The server's rule (server/health.py): printable ASCII, no whitespace, none of the characters a
// .env file gives a meaning to.
const KEY_FORBIDDEN = /["'`#=\\$]/;

/** Why a typed key would be refused, or null. The message never repeats the value. */
export function checkKeyValue(value) {
  const text = String(value ?? "");
  if (text === "") return "Paste the key first.";
  if (/\s/.test(text)) return "A key has no spaces or line breaks. Paste the key alone.";
  if (text.includes("=")) return "Paste the key alone, without its NAME= prefix.";
  if (!/^[\x21-\x7e]+$/.test(text) || KEY_FORBIDDEN.test(text)) {
    return "A key is plain printable characters, without quotes, '#', '$' or backslash.";
  }
  if (text.length < 8) return "That is too short to be a key (8 characters at least).";
  if (text.length > 512) return "That is too long to be a key (512 characters at most).";
  return null;
}

/** The result of a key test as lines: `[{kind: "ok"|"bad"|"warn"|"dim", icon, text}]`. */
export function keyTestLines(result) {
  if (!result) return [];
  const lines = [{
    kind: result.ok ? "ok" : "bad",
    icon: result.ok ? "check" : "x",
    text: (result.ok ? "Working. " : "Not working. ") + String(result.detail || "").trim(),
  }];
  if (result.model_access === true) lines.push({ kind: "ok", icon: "check", text: "Model access: yes." });
  if (result.model_access === false) {
    lines.push({ kind: "bad", icon: "x", text: "Model access: no. Runs with this key would end on fallback answers." });
  }
  if (result.reasoning_summaries === true) lines.push({ kind: "ok", icon: "check", text: "Reasoning summaries: granted." });
  if (result.reasoning_summaries === false) {
    lines.push({
      kind: "warn",
      icon: "alert",
      text: "Reasoning summaries: not granted. Runs work, but the reasoning stream shows no thinking lines.",
    });
  }
  if (typeof result.latency_ms === "number") {
    lines.push({ kind: "dim", icon: "clock", text: "Answered in " + latencyWords(result.latency_ms) + "." });
  }
  return lines;
}

// ---------------------------------------------------------------- organiser answers

export const NOTE_MAX = 2000; // the server's limit for one note

/**
 * The control an organiser answer is given with, from the default it changes:
 * `{kind: "bool"|"choice"|"fixed"|"none", field, choices}`. "fixed": the answer has a behaviour
 * but no saved default behind it (Q10); "none": nothing to switch, only a note.
 */
export function answerControl(answer, fields) {
  const setting = answer ? answer.setting : null;
  if (!setting) return { kind: "none", field: null, choices: [] };
  const field = (fields || []).find((candidate) => candidate.key === setting) || null;
  if (!field) return { kind: "fixed", field: null, choices: [] };
  const kind = controlKind(field);
  if (kind === "bool") return { kind: "bool", field, choices: [] };
  if (kind === "choice") return { kind: "choice", field, choices: (field.choices || []).map(String) };
  return { kind: "fixed", field, choices: [] };
}

/** One sentence: which behaviour this answer changes. */
export function answerEffect(answer, fields) {
  const control = answerControl(answer, fields);
  if (control.kind === "none") return "Changes no setting. Record what the organisers said in the note.";
  if (answer.setting === "clock_start") {
    return "Nothing is saved here: the 60-minute clock starts at launch and can be moved to the hand-over time in the run header.";
  }
  if (control.field) return "Changes the default \"" + control.field.label + "\" for new runs.";
  return "Changes the default " + answer.setting + " for new runs.";
}

/** The saved value of an answer in words. */
export function answerValueWords(answer, fields) {
  const control = answerControl(answer, fields);
  if (control.kind === "none") return "";
  if (control.kind === "bool") return answer.value === true ? "On" : "Off";
  if (answer.setting === "clock_start") return "At launch";
  return answer.value === null || answer.value === undefined ? "" : String(answer.value);
}

/**
 * What "Save" sends for the organiser table: `{items: [{id, value?, note?}], changed: [ids],
 * errors: {id: text}}`. `drafts` maps an id to `{value?, note?}` as the controls hold them; an
 * entry equal to what is saved is left out.
 */
export function buildAnswersBody(answers, drafts) {
  const items = [];
  const changed = [];
  const errors = {};
  for (const answer of answers || []) {
    const draft = drafts instanceof Map ? drafts.get(answer.id) : drafts && drafts[answer.id];
    if (!draft) continue;
    const item = { id: answer.id };
    if (draft.value !== undefined && !sameValue(draft.value, answer.value)) item.value = draft.value;
    if (typeof draft.note === "string") {
      const note = draft.note.trim();
      if (note.length > NOTE_MAX) errors[answer.id] = "The note is " + fmtInt(note.length) + " characters; the limit is " + fmtInt(NOTE_MAX) + ".";
      else if (note !== String(answer.note || "")) item.note = note;
    }
    if (Object.keys(item).length > 1) {
      items.push(item);
      changed.push(answer.id);
    }
  }
  return { items, changed, errors };
}

// ---------------------------------------------------------------- directories

const trimSlash = (path) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/** Uploaded sets live in `<data_dir>/sets`; the server always allows that directory. */
export function isSetsRoot(root, dataDir) {
  if (!root || !dataDir) return false;
  return trimSlash(String(root)) === trimSlash(String(dataDir)) + "/sets";
}

/** The roots the operator can edit: the list without the one the server always adds. */
export function editableRoots(roots, dataDir) {
  return (roots || []).map(String).filter((root) => !isSetsRoot(root, dataDir));
}

/** Add a typed directory to a list of roots: `{list, error}`. */
export function addRoot(list, raw) {
  const path = trimSlash(String(raw ?? "").trim());
  if (!path) return { list, error: "Type a directory first, such as /Volumes/USB." };
  if (list.some((root) => trimSlash(root) === path)) return { list, error: "That directory is already in the list." };
  return { list: list.concat(path), error: null };
}

/**
 * What "Save" sends for the directories: `{body, changed: [names]}` with `body` null when nothing
 * differs.
 *   draft.runs_dir / draft.cache_dir  text of the "from the next start" inputs (undefined: untouched);
 *                                     empty means "follow the environment again" (null)
 *   draft.roots                       the edited list (undefined: untouched), or null to go back
 *                                     to the usual places
 */
export function buildPathsBody(paths, draft) {
  const body = {};
  const changed = [];
  const saved = (paths && paths.saved) || {};
  for (const key of ["runs_dir", "cache_dir"]) {
    if (!draft || typeof draft[key] !== "string") continue;
    const text = draft[key].trim();
    const before = typeof saved[key] === "string" ? saved[key] : null;
    const after = text === "" ? null : text;
    if (after === before) continue;
    body[key] = after;
    changed.push(key);
  }
  if (draft && draft.roots === null) {
    body.allowed_roots = null;
    changed.push("allowed_roots");
  } else if (draft && Array.isArray(draft.roots)) {
    const before = editableRoots(paths && paths.allowed_roots, paths && paths.data_dir);
    const same = before.length === draft.roots.length && before.every((root, i) => root === draft.roots[i]);
    if (!same) {
      body.allowed_roots = draft.roots.slice();
      changed.push("allowed_roots");
    }
  }
  return { body: changed.length ? body : null, changed };
}

const RESTART_WORDS = {
  runs_dir: "the runs directory",
  cache_dir: "the cache directory",
  lan: "LAN access",
};

/** "the runs directory and LAN access": what a restart would change, or "" when nothing waits. */
export function restartWords(required) {
  const names = (required || []).map((key) => RESTART_WORDS[key] || String(key));
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

// ---------------------------------------------------------------- LAN access

/**
 * Where LAN access stands: `{state, kind, icon, text, detail}` with state
 *   "off"          local only
 *   "on"           serving the local network now
 *   "pending_on"   switched on, in force after the next start
 *   "pending_off"  switched off, still in force until the next start
 */
export function lanState(payload) {
  const lan = (payload && payload.lan) || {};
  const pending = Boolean(payload && Array.isArray(payload.restart_required) && payload.restart_required.includes("lan"));
  if (lan.enabled && !pending) {
    return {
      state: "on", kind: "warn", icon: "wifi", text: "on",
      detail: "Other machines on this network can open the console with the token.",
    };
  }
  if (lan.enabled) {
    return {
      state: "pending_on", kind: "warn", icon: "clock", text: "on from the next start",
      detail: "Switched on, not in force yet. The server still answers this machine only until it is restarted.",
    };
  }
  if (pending) {
    return {
      state: "pending_off", kind: "warn", icon: "clock", text: "off from the next start",
      detail: "Switched off, but the running server still accepts the old token until it is restarted.",
    };
  }
  return {
    state: "off", kind: "ok", icon: "lock", text: "off",
    detail: "The server answers this machine only.",
  };
}

/**
 * The address for the other device with its token hidden, for a screen that may be on a
 * projector: "http://192.168.1.20:8000/?token=••••••••".
 */
export function maskJoinUrl(url) {
  return String(url ?? "").replace(/([?&]token=)[^&#]*/, "$1••••••••");
}

// ---------------------------------------------------------------- health

/** "640 ms", "1.2 s"; "–" when there was no answer. */
export function latencyWords(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return Math.round(ms) + " ms";
  return (ms / 1000).toFixed(1) + " s";
}

const SLOW_MS = 3000;

/** Status of one probed service: `{kind, icon, text}`. Text and icon, never colour alone. */
export function serviceStatus(service) {
  if (service && service.ok) {
    if (typeof service.latency_ms === "number" && service.latency_ms >= SLOW_MS) {
      return { kind: "warn", icon: "clock", text: "reachable, slow" };
    }
    return { kind: "ok", icon: "check", text: "reachable" };
  }
  // An answer that is not usable (a rejected key, an error page) is a different fault from silence.
  if (service && typeof service.latency_ms === "number") return { kind: "bad", icon: "alert", text: "answered with a problem" };
  return { kind: "bad", icon: "x", text: "no answer" };
}

/** One line for the whole table: `{kind, icon, text}`. */
export function healthSummary(services) {
  const rows = services || [];
  if (!rows.length) return { kind: "dim", icon: "info", text: "No service was checked." };
  const failing = rows.filter((row) => !row.ok).map((row) => String(row.name));
  if (!failing.length) return { kind: "ok", icon: "check", text: "All " + rows.length + " services reachable." };
  return {
    kind: "bad",
    icon: "alert",
    text: failing.length + " of " + rows.length + " with a problem: " + failing.join(", ") + ".",
  };
}

/**
 * The numbers of the recent window as tiles: `[{key, label, value, kind, help}]`. `kind` is "warn"
 * or "bad" when the number deserves a look, else "plain".
 */
export function windowStats(window) {
  const w = window || {};
  const count = (value) => (typeof value === "number" ? fmtInt(value) : "–");
  const quiet = "No model turn in this window.";
  return [
    {
      key: "api_retries", label: "API retries", value: count(w.api_retries),
      kind: w.api_retries > 0 ? "warn" : "plain",
      help: "Requests to the model that had to be sent again.",
    },
    {
      key: "api_errors", label: "API errors", value: count(w.api_errors),
      kind: w.api_errors > 0 ? "bad" : "plain",
      help: "Requests that failed for good. A panorama that hits one ends on its best list so far.",
    },
    {
      key: "timeouts", label: "Timeouts", value: count(w.timeouts),
      kind: w.timeouts > 0 ? "warn" : "plain",
      help: "Requests that got no answer in time.",
    },
    {
      key: "median_turn_latency_ms", label: "Median turn latency", value: latencyWords(w.median_turn_latency_ms),
      kind: "plain",
      help: typeof w.median_turn_latency_ms === "number" ? "Time the model took to answer one turn." : quiet,
    },
    {
      key: "mean_upload_chars", label: "Mean upload per turn",
      value: typeof w.mean_upload_chars === "number" ? fmtBytes(w.mean_upload_chars) : "–",
      kind: "plain",
      help: typeof w.mean_upload_chars === "number" ? "Size of one request to the model, images included." : quiet,
    },
  ];
}

const LOW_DISK = 2 * 1024 ** 3;
const VERY_LOW_DISK = 500 * 1024 ** 2;

/** Disk usage as rows: `[{key, label, value, kind, help}]`. */
export function diskRows(disk) {
  const d = disk || {};
  const free = typeof d.free_bytes === "number" ? d.free_bytes : null;
  let freeKind = "plain";
  let freeHelp = "Free space on the disk that holds the runs.";
  if (free !== null && free < VERY_LOW_DISK) {
    freeKind = "bad";
    freeHelp = "Almost full. A run that cannot write its log loses its answers: free some space before launching.";
  } else if (free !== null && free < LOW_DISK) {
    freeKind = "warn";
    freeHelp = "Getting low. A run with embedded images can write several hundred megabytes.";
  }
  return [
    { key: "runs_bytes", label: "Runs", value: fmtBytes(d.runs_bytes), kind: "plain", help: "Logs, exports and images of every run." },
    { key: "uploads_bytes", label: "Uploaded sets", value: fmtBytes(d.uploads_bytes), kind: "plain", help: "Panorama sets kept for reuse." },
    { key: "cache_bytes", label: "HTTP cache", value: fmtBytes(d.cache_bytes), kind: "plain", help: "Answers of geocoding, map and imagery lookups." },
    { key: "free_bytes", label: "Free", value: fmtBytes(free), kind: freeKind, help: freeHelp },
  ];
}

// ---------------------------------------------------------------- this browser

/**
 * What the notification switch can do, from the browser's permission ("granted", "denied",
 * "default", or "unsupported") and the stored preference: `{on, canToggle, text}`.
 */
export function notificationState(permission, wanted) {
  if (permission === "unsupported") {
    return { on: false, canToggle: false, text: "This browser cannot show notifications. The tab title and the inbox still announce a question." };
  }
  if (permission === "denied") {
    return { on: false, canToggle: false, text: "Blocked for this site. Allow notifications in the browser's site settings, then reload." };
  }
  if (wanted && permission === "granted") {
    return { on: true, canToggle: true, text: "A notification is raised when a question arrives while this tab is in the background." };
  }
  if (permission === "granted") return { on: false, canToggle: true, text: "Off. The browser already allows them for this site." };
  return { on: false, canToggle: true, text: "Off. Switching this on makes the browser ask for permission." };
}
