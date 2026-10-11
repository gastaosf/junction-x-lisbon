// Decisions of the New run screen (UI-SPEC 5.3), kept pure so they can be tested without a page:
// what a preset fixes, what the form sends, what still blocks the launch, and the arithmetic of
// the cost and time ceilings.
//
// The server stays the authority (contract section 0): every check here is repeated by
// `POST /api/runs` and by the preflight. These functions only decide what the page shows and
// which request it builds, so that a wrong form is caught before the click, not after it.

import { fmtBytes, fmtDuration, fmtUsd } from "../format.js";

// The order of UI-SPEC 5.3 step 1.
export const PRESET_ORDER = ["autonomous", "scoring", "live", "eval", "custom"];

// The only keys `LaunchSpec.settings` may carry (contract A22, server/store.py LAUNCH_FIELDS).
export const LAUNCH_FIELDS = [
  "model", "max_tokens", "image_detail", "standard", "special", "live", "allow_web", "disabled_tools",
  "hedge", "allow_duplicates", "penalty_scope", "no_human", "mcq_allowed", "max_mcq", "concurrency",
  "global_watchdog_s", "embed_images", "team",
];
export const BUDGET_NAMES = ["standard", "special", "live"];
export const BUDGET_KEYS = ["effort", "soft_deadline_s", "hard_deadline_s", "max_turns", "max_spend_usd"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const IMAGE_DETAILS = ["low", "high", "original", "auto"];
export const PENALTY_SCOPES = ["whole_list", "subsequent"];
export const LABELS = ["Urban", "non-Urban"];
export const CUSTOM_KINDS = ["training", "scoring", "live"];
export const MAX_MCQ_LIMIT = 3;
export const MAX_CONCURRENCY = 12;
export const MAX_OUTPUT_TOKENS = 128000;

// What an evaluation run may change (contract 4.6: the body of POST /api/eval/runs); everything
// else comes from the saved defaults.
export const EVAL_FIELDS = ["hedge", "allow_web", "disabled_tools", "concurrency"];

// What `PUT /api/sets/<id>/files` accepts (contract A29, server/sets.py).
export const ACCEPTED_SUFFIXES = [".jpg", ".jpeg", ".png", ".csv", ".tsv", ".txt", ".json", ".zip"];
export const IMAGE_SUFFIXES = [".jpg", ".jpeg", ".png"];
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_PATH_COMPONENTS = 4;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TEAM_RE = /^[\p{L}\p{N}_ .-]{1,40}$/u;
const TIMESTAMP_RE = /^\d{14}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isInt = (value) => Number.isInteger(value);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function same(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    // Tool lists are sets: their order carries nothing.
    const left = a.map(String).sort();
    const right = b.map(String).sort();
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return Array.from(keys).every((key) => same(a[key], b[key]));
  }
  return a === b;
}

// ---------------------------------------------------------------- presets and settings

export function presetOf(context, name) {
  const presets = context && context.presets;
  return presets && Object.prototype.hasOwnProperty.call(presets, name) ? presets[name] : null;
}

/** The preset names the server offers, in the order of the spec; unknown ones go last. */
export function presetNames(context) {
  const known = Object.keys((context && context.presets) || {});
  const ordered = PRESET_ORDER.filter((name) => known.includes(name));
  return ordered.concat(known.filter((name) => !ordered.includes(name)));
}

function merge(base, over) {
  const out = clone(base || {});
  for (const [key, value] of Object.entries(over || {})) {
    if (!LAUNCH_FIELDS.includes(key) || value === undefined) continue;
    if (BUDGET_NAMES.includes(key) && isObject(value)) out[key] = { ...(out[key] || {}), ...value };
    else out[key] = clone(value);
  }
  return out;
}

/** What a preset gives before the operator changes anything: saved defaults under its values. */
export function baseSettings(context, presetName) {
  const preset = presetOf(context, presetName);
  return merge((context && context.defaults) || {}, preset ? preset.settings : {});
}

/**
 * The settings a launch would run with: defaults < preset < the operator's edits < what the preset
 * locks. `edits` holds only the fields the operator changed; a budget may be partial.
 */
export function effectiveSettings(context, presetName, edits) {
  const preset = presetOf(context, presetName);
  const out = merge(baseSettings(context, presetName), edits);
  if (preset) {
    for (const field of preset.locked || []) {
      if (preset.settings && field in preset.settings) out[field] = clone(preset.settings[field]);
    }
  }
  return out;
}

export function isLocked(context, presetName, field) {
  const preset = presetOf(context, presetName);
  return Boolean(preset && (preset.locked || []).includes(field));
}

/** Whether every panorama gets the live budget: the preset's value when it locks it, else the form's. */
export function effectiveLiveBudget(context, presetName, chosen) {
  const preset = presetOf(context, presetName);
  if (!preset) return false;
  if ((preset.locked || []).includes("live_budget") || typeof chosen !== "boolean") return Boolean(preset.live_budget);
  return chosen;
}

/** The kind a run of this preset gets (A20: only the custom preset lets the form choose). */
export function effectiveKind(context, presetName, chosen) {
  const preset = presetOf(context, presetName);
  if (!preset) return null;
  if (presetName === "custom" && CUSTOM_KINDS.includes(chosen)) return chosen;
  return preset.kind || null;
}

/**
 * Why a control cannot be changed, in words for the operator, or null when it can.
 * `field` is a launch field, "live_budget", "kind", or "tool:<name>".
 */
export function lockReason(field, { context, preset: presetName, settings, tools } = {}) {
  const preset = presetOf(context, presetName);
  const label = preset ? preset.label || presetName : "";
  if (field === "kind") {
    return presetName === "custom" ? null : "The " + label + " preset always creates a " + ((preset && preset.kind) || "run of its own kind") + " run.";
  }
  if (field.startsWith("tool:")) {
    const name = field.slice(5);
    const tool = (tools || (context && context.tools) || []).find((item) => item.name === name);
    if (tool && tool.protected) return "The agent cannot record or submit an answer without this tool.";
    if (tool && tool.web && settings && settings.allow_web === false) return "Off because web access is off.";
    return null;
  }
  if (preset && (preset.locked || []).includes(field)) {
    if (field === "no_human") {
      const off = preset.settings && preset.settings.no_human;
      return "The " + label + " preset always runs with human channels " + (off ? "off" : "on") + ".";
    }
    if (field === "live_budget") {
      return "The " + label + " preset always uses the " + (preset.live_budget ? "live budget" : "standard and Special One budgets") + ".";
    }
    return "Locked by the " + label + " preset.";
  }
  if ((field === "mcq_allowed" || field === "max_mcq") && settings && settings.no_human) {
    return "Human channels are off, so the agent cannot ask anything.";
  }
  return null;
}

/** The fields whose value differs from what the preset alone would give. */
export function changedFields(context, presetName, edits) {
  const base = baseSettings(context, presetName);
  const now = effectiveSettings(context, presetName, edits);
  return LAUNCH_FIELDS.filter((field) => !same(base[field], now[field]));
}

/** `edits` without what merely repeats the preset: an edit set back to its start is no edit. */
export function pruneEdits(context, presetName, edits) {
  const base = baseSettings(context, presetName);
  const out = {};
  for (const [field, value] of Object.entries(edits || {})) {
    if (!LAUNCH_FIELDS.includes(field)) continue;
    if (BUDGET_NAMES.includes(field) && isObject(value)) {
      const part = Object.fromEntries(Object.entries(value).filter(([key, item]) => !same(item, (base[field] || {})[key])));
      if (Object.keys(part).length) out[field] = part;
    } else if (!same(value, base[field])) out[field] = clone(value);
  }
  return out;
}

/**
 * Edits that turn the preset's own values into `settings` (the frozen settings of another run, for
 * `/new?from=<run_id>`). Locked fields stay with the preset; a model this server does not offer
 * (a demo run's "fake-demo") is left out.
 */
export function editsFromSettings(context, presetName, settings) {
  const base = baseSettings(context, presetName);
  const models = (context && context.models) || [];
  const edits = {};
  if (!isObject(settings)) return edits;
  for (const field of LAUNCH_FIELDS) {
    if (!(field in settings) || isLocked(context, presetName, field)) continue;
    if (field === "model" && !models.includes(settings.model)) continue;
    if (BUDGET_NAMES.includes(field)) {
      if (!isObject(settings[field])) continue;
      const part = {};
      for (const key of BUDGET_KEYS) {
        if (key in settings[field] && !same(settings[field][key], (base[field] || {})[key])) part[key] = settings[field][key];
      }
      if (Object.keys(part).length) edits[field] = part;
    } else if (!same(settings[field], base[field])) edits[field] = clone(settings[field]);
  }
  return edits;
}

/** The preset a past run is duplicated into: its own when the server still offers it. */
export function presetForRun(context, run) {
  if (!run) return null;
  if (presetOf(context, run.preset)) return run.preset;
  if (run.kind === "eval" && presetOf(context, "eval")) return "eval";
  return presetOf(context, "custom") ? "custom" : null;
}

/**
 * What `/new?from=<run_id>` fills the form with: the preset, the settings that differ from it,
 * and the set the run was launched from. `wantedPreset` (from `?preset=`) wins over the run's own.
 * An evaluation run only carries what its form can change. Returns null when nothing can be copied.
 */
export function prefillFromRun(context, run, wantedPreset = null) {
  if (!run) return null;
  const preset = presetOf(context, wantedPreset) ? wantedPreset : presetForRun(context, run);
  if (!preset) return null;
  const edits = editsFromSettings(context, preset, run.settings);
  const out = { preset, edits, liveBudget: undefined, kind: null, setId: null, evalEffort: null, evalLimit: null };
  if (preset === "eval") {
    out.edits = Object.fromEntries(Object.entries(edits).filter(([field]) => EVAL_FIELDS.includes(field)));
    const base = baseSettings(context, preset);
    const settings = isObject(run.settings) ? run.settings : {};
    const standard = isObject(settings.standard) ? settings.standard.effort : null;
    const special = isObject(settings.special) ? settings.special.effort : null;
    const differs = standard !== (base.standard || {}).effort || special !== (base.special || {}).effort;
    if (EFFORTS.includes(standard) && standard === special && differs) out.evalEffort = standard;
    const total = run.totals ? run.totals.total : null;
    if (run.kind === "eval" && isInt(total) && total > 0) out.evalLimit = total;
    return out;
  }
  const own = presetOf(context, preset);
  if (!isLocked(context, preset, "live_budget") && typeof run.live_budget === "boolean" && run.live_budget !== Boolean(own.live_budget)) {
    out.liveBudget = run.live_budget;
  }
  if (preset === "custom" && CUSTOM_KINDS.includes(run.kind)) out.kind = run.kind;
  if (typeof run.set_id === "string" && run.set_id) out.setId = run.set_id;
  return out;
}

/** Tool names a run with these settings would be offered. */
export function enabledTools(tools, settings) {
  const off = new Set((settings && settings.disabled_tools) || []);
  const web = !settings || settings.allow_web !== false;
  return (tools || []).filter((tool) => !off.has(tool.name) && (web || !tool.web)).map((tool) => tool.name);
}

/** The query of `GET /api/prompt`: the four settings the prompt and the tool list depend on (A39). */
export function promptQuery(settings) {
  const params = new URLSearchParams();
  params.set("allow_web", settings.allow_web === false ? "false" : "true");
  params.set("no_human", settings.no_human ? "true" : "false");
  params.set("disabled_tools", (settings.disabled_tools || []).join(","));
  params.set("max_mcq", String(settings.max_mcq));
  return params.toString();
}

/** A deadline in as few words as it takes: "14 min", "3 min 30 s", "45 s". */
export function shortDuration(seconds) {
  if (!isNumber(seconds) || seconds < 0) return "–";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (!minutes) return rest + " s";
  return minutes + " min" + (rest ? " " + rest + " s" : "");
}

/**
 * The facts on a preset card (UI-SPEC 5.3 step 1), read from what the server says the preset
 * sets and locks, so the card cannot promise something the launch would not do.
 * Returns `[{label, value}]`.
 */
export function presetFacts(context, presetName) {
  const preset = presetOf(context, presetName);
  if (!preset) return [];
  const settings = baseSettings(context, presetName);
  const locked = preset.locked || [];
  const fixed = (field) => (locked.includes(field) ? ", locked" : "");
  const budget = (name) => settings[name] || {};
  // The server's own description says what the preset is for; these are the numbers behind it.
  const facts = [
    { label: "Human channels", value: (settings.no_human ? "off" : "on") + fixed("no_human") },
    {
      label: "Hard deadline",
      value: preset.live_budget
        ? shortDuration(budget("live").hard_deadline_s) + " (live budget" + fixed("live_budget") + ")"
        : shortDuration(budget("standard").hard_deadline_s) + ", Special One " + shortDuration(budget("special").hard_deadline_s),
    },
    { label: "In parallel", value: String(settings.concurrency ?? "–") },
  ];
  if (preset.requires_special) facts.push({ label: "Special One", value: "exactly one needed" });
  return facts;
}

/** The one-line summary above the Advanced disclosure. */
export function optionsSummary(settings, { tools, liveBudget = false, evalMode = false } = {}) {
  if (!settings) return [];
  const parts = [String(settings.model)];
  const budget = (name) => settings[name] || {};
  if (liveBudget) parts.push("effort " + budget("live").effort + " (live budget, " + fmtDuration(budget("live").hard_deadline_s) + " hard)");
  else parts.push("effort " + budget("standard").effort + " / " + budget("special").effort + " for the Special One");
  const offered = enabledTools(tools, settings).length;
  parts.push("web " + (settings.allow_web === false ? "off" : "on") + ", " + offered + " of " + (tools || []).length + " tools");
  if (settings.no_human || evalMode) parts.push("human channels off");
  else {
    parts.push("human channels on, " + (settings.mcq_allowed ? "up to " + settings.max_mcq + " MCQ per panorama" : "questions off at start"));
  }
  parts.push("hedge " + (settings.hedge ? "on" : "off"));
  parts.push(settings.concurrency + " in parallel");
  if (!evalMode) parts.push("watchdog " + fmtDuration(settings.global_watchdog_s));
  return parts;
}

// ---------------------------------------------------------------- validation

/** Why a run id cannot be used, or null. An empty id is fine: the server makes one from the UTC time. */
export function runIdProblem(text) {
  const value = String(text ?? "");
  if (value === "") return null;
  if (value.includes("..")) return "A run id cannot contain two dots in a row.";
  if (!RUN_ID_RE.test(value)) {
    return "Use letters, digits, dot, underscore or hyphen, starting with a letter or digit (at most 100 characters).";
  }
  return null;
}

function budgetProblems(name, budget, problems) {
  const where = (key) => name + "." + key;
  if (!isObject(budget)) {
    problems.push({ field: name, text: "The " + name + " budget is missing." });
    return;
  }
  if (!EFFORTS.includes(budget.effort)) problems.push({ field: where("effort"), text: "Choose an effort." });
  for (const key of ["soft_deadline_s", "hard_deadline_s", "max_spend_usd"]) {
    if (!isNumber(budget[key]) || budget[key] <= 0) problems.push({ field: where(key), text: "Enter a number above 0." });
  }
  if (!isInt(budget.max_turns) || budget.max_turns <= 0) {
    problems.push({ field: where("max_turns"), text: "Enter a whole number above 0." });
  }
  if (isNumber(budget.soft_deadline_s) && isNumber(budget.hard_deadline_s) && budget.soft_deadline_s > budget.hard_deadline_s) {
    problems.push({ field: where("soft_deadline_s"), text: "The soft deadline cannot be later than the hard deadline." });
  }
}

/**
 * Problems with the settings as `[{field, text}]`; `field` is a launch field or "<budget>.<key>".
 * The same bounds as the server (A22), so a mistake is marked at its control before the launch.
 */
export function settingsProblems(settings, context) {
  const problems = [];
  const s = settings || {};
  const models = (context && context.models) || [];
  const tools = (context && context.tools) || [];
  if (models.length && !models.includes(s.model)) problems.push({ field: "model", text: "Choose one of the listed models." });
  if (!isInt(s.max_tokens) || s.max_tokens < 1 || s.max_tokens > MAX_OUTPUT_TOKENS) {
    problems.push({ field: "max_tokens", text: "Enter a whole number from 1 to " + MAX_OUTPUT_TOKENS + "." });
  }
  if (!IMAGE_DETAILS.includes(s.image_detail)) problems.push({ field: "image_detail", text: "Choose an image detail." });
  for (const name of BUDGET_NAMES) budgetProblems(name, s[name], problems);
  if (!PENALTY_SCOPES.includes(s.penalty_scope)) problems.push({ field: "penalty_scope", text: "Choose a penalty scope." });
  if (!isInt(s.max_mcq) || s.max_mcq < 0 || s.max_mcq > MAX_MCQ_LIMIT) {
    problems.push({ field: "max_mcq", text: "Enter a whole number from 0 to " + MAX_MCQ_LIMIT + " (the rules allow three questions)." });
  }
  if (!isInt(s.concurrency) || s.concurrency < 1 || s.concurrency > MAX_CONCURRENCY) {
    problems.push({ field: "concurrency", text: "Enter a whole number from 1 to " + MAX_CONCURRENCY + "." });
  }
  if (!isNumber(s.global_watchdog_s) || s.global_watchdog_s <= 0) {
    problems.push({ field: "global_watchdog_s", text: "Enter a number of seconds above 0." });
  }
  if (typeof s.team !== "string" || !TEAM_RE.test(s.team)) {
    problems.push({ field: "team", text: "Use 1 to 40 letters, digits, spaces, dots, underscores or hyphens." });
  }
  const known = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of s.disabled_tools || []) {
    if (tools.length && !known.has(name)) problems.push({ field: "disabled_tools", text: name + " is not a tool of this agent." });
    else if (known.get(name) && known.get(name).protected) {
      problems.push({ field: "disabled_tools", text: name + " cannot be switched off." });
    }
  }
  return problems;
}

/** A number typed into a form field, or NaN (never 0 for an empty field: that would pass as a value). */
export function parseNumber(text, { integer = false } = {}) {
  const raw = String(text ?? "").trim();
  if (raw === "" || !/^-?\d+(\.\d+)?$/.test(raw)) return NaN;
  const value = Number(raw);
  if (integer && !Number.isInteger(value)) return NaN;
  return value;
}

// ---------------------------------------------------------------- timestamps

/** Fourteen digits that are a real date and time: the only timestamp a task may carry (A18). */
export function isTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP_RE.test(value)) return false;
  const part = (from, to) => Number(value.slice(from, to));
  const [y, mo, d, h, mi, s] = [part(0, 4), part(4, 6), part(6, 8), part(8, 10), part(10, 12), part(12, 14)];
  if (y < 1 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return false;
  // setUTCFullYear, because Date.UTC reads a year below 100 as 19xx.
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(y, mo - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * The value of a `datetime-local` input ("2026-10-10T09:30" or "…:15") as YYYYMMDDhhmmss, or null.
 * The digits are kept as typed: nobody knows yet whether the organisers' times are UTC or local
 * (Q5), and the agent is told the same digits.
 */
export function timestampFromInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const digits = match[1] + match[2] + match[3] + match[4] + match[5] + (match[6] || "00");
  return isTimestamp(digits) ? digits : null;
}

/** "20180511142427" as "2018-05-11 14:24:27"; anything else is shown as it is. */
export function formatTimestamp(value) {
  const text = String(value ?? "");
  if (!TIMESTAMP_RE.test(text)) return text;
  return text.slice(0, 4) + "-" + text.slice(4, 6) + "-" + text.slice(6, 8) + " " + text.slice(8, 10) + ":" + text.slice(10, 12) + ":" + text.slice(12, 14);
}

const SOURCE_TEXT = {
  folder: "from the folder name",
  filename: "from the file name",
  sidecar: "from its sidecar file",
  manifest: "from the manifest",
  operator: "set here by the operator",
  operator_bulk: "set here for every unlabelled panorama",
  default: "default label",
  none: "not found in the files",
};

/** Where a parsed value came from, in words. */
export function sourceText(source) {
  return SOURCE_TEXT[source] || String(source || "unknown source");
}

// ---------------------------------------------------------------- preflight choices

/** The row of a preflight a choice is about. Choices are kept by relative path: a panorama id can
 * move to another file when files are added (ids get _2, _3 in sorted order), a path cannot. */
function rowByPath(rows) {
  return new Map((rows || []).map((row) => [row.rel_path, row]));
}

/**
 * The `overrides` and `special` of a preflight or launch request, from the operator's choices.
 *   choices = {labels: {rel_path: "Urban"|"non-Urban"}, timestamps: {rel_path: "YYYYMMDDhhmmss"},
 *              special: undefined (the files decide) | null (no Special One) | rel_path}
 * Keys on the wire are the panorama ids of `rows` (the last preflight), which the server resolves
 * first. Only real changes are sent: a choice equal to what the files say is no override.
 */
export function taskChoices(rows, choices) {
  const overrides = {};
  const put = (row, key, value) => {
    if (!overrides[row.panorama_id]) overrides[row.panorama_id] = {};
    overrides[row.panorama_id][key] = value;
  };
  const labels = (choices && choices.labels) || {};
  const timestamps = (choices && choices.timestamps) || {};
  const chosen = choices ? choices.special : undefined;
  let special = null;
  for (const row of rows || []) {
    const parsed = row.parsed || {};
    const label = labels[row.rel_path];
    if (LABELS.includes(label) && label !== parsed.label) put(row, "label", label);
    const timestamp = timestamps[row.rel_path];
    if (isTimestamp(timestamp) && timestamp !== parsed.timestamp) put(row, "timestamp", timestamp);
    if (chosen === null && parsed.special) put(row, "special", false);
    if (typeof chosen === "string" && chosen === row.rel_path) special = row.panorama_id;
  }
  return { overrides, special };
}

/** Whether the operator chose anything in the table: such a request needs the rows it is keyed by. */
export function hasChoices(choices) {
  if (!choices) return false;
  return Object.keys(choices.labels || {}).length > 0
    || Object.keys(choices.timestamps || {}).length > 0
    || choices.special !== undefined;
}

/** Drop the choices that name a file the set no longer has. */
export function pruneChoices(rows, choices) {
  const known = rowByPath(rows);
  const keep = (map) => Object.fromEntries(Object.entries(map || {}).filter(([path]) => known.has(path)));
  const special = typeof choices.special === "string" && !known.has(choices.special) ? undefined : choices.special;
  return { labels: keep(choices.labels), timestamps: keep(choices.timestamps), special };
}

/** Rows a launch would really run: in add-panoramas mode a file already in the run is skipped. */
export function freshRows(rows) {
  return (rows || []).filter((row) => !row.duplicate);
}

export function countRows(rows) {
  const fresh = freshRows(rows);
  return {
    total: fresh.length,
    urban: fresh.filter((row) => row.label === "Urban").length,
    nonUrban: fresh.filter((row) => row.label === "non-Urban").length,
    unlabelled: fresh.filter((row) => !row.label).length,
    special: fresh.filter((row) => row.special).map((row) => row.panorama_id),
    skipped: (rows || []).length - fresh.length,
  };
}

/** "6: 4 Urban, 2 non-Urban" for the launch summary. */
export function labelSummary(rows) {
  const counts = countRows(rows);
  if (!counts.total) return "none";
  const parts = [];
  if (counts.urban) parts.push(counts.urban + " Urban");
  if (counts.nonUrban) parts.push(counts.nonUrban + " non-Urban");
  if (counts.unlabelled) parts.push(counts.unlabelled + " without a label");
  return counts.total + ": " + parts.join(", ");
}

/**
 * Images that are stored in an upload set but that the loader does not read as panoramas. It
 * reads the top of the set and its Urban/ and non-Urban/ folders, so files added beside a folder
 * that was dropped earlier push that folder's images out of the run without any error.
 * `setInfo` is the set's row of `GET /api/sets` (its `panoramas` counts the stored image files).
 */
export function unreadImageCount(setInfo, preflight) {
  if (!setInfo || setInfo.kind !== "upload" || !isInt(setInfo.panoramas) || !preflight) return 0;
  return Math.max(0, setInfo.panoramas - (preflight.rows || []).length);
}

export function unreadImagesText(count) {
  if (!count) return null;
  return count + " stored image" + (count === 1 ? " is" : "s are") + " not read as a panorama and would not run. "
    + "Only the images at the top of the set and in its Urban/ and non-Urban/ folders are read; "
    + "files added beside a folder that was dropped earlier push that folder out. "
    + "Start a new set and drop everything for this run in one go.";
}

/** Rows that still need the operator: the ones the bulk-label box would fill. */
export function unlabelledRows(rows) {
  return freshRows(rows).filter((row) => !row.label || (row.sources && row.sources.label === "operator_bulk"));
}

/** The body of `POST /api/sets/<id>/preflight` (A4). In add mode the run decides preset and budgets. */
export function preflightBody(form, rows) {
  const { overrides, special } = taskChoices(rows, form.choices);
  const body = {
    overrides,
    special,
    apply_label_to_unlabelled: form.bulkOn && LABELS.includes(form.bulkLabel) ? form.bulkLabel : null,
  };
  if (form.addRunId) {
    body.run_id = form.addRunId;
    return body;
  }
  body.preset = form.preset;
  body.live_budget = form.liveBudget;
  body.settings = Object.fromEntries(BUDGET_NAMES.map((name) => [name, clone(form.settings[name])]));
  if (form.runId && !runIdProblem(form.runId)) body.launch_run_id = form.runId;
  return body;
}

/** The LaunchSpec of `POST /api/runs` (contract 4.2). `rows` and `token` are the last preflight's. */
export function launchSpec(form, rows, token) {
  const { overrides, special } = taskChoices(rows, form.choices);
  const settings = {};
  for (const field of LAUNCH_FIELDS) settings[field] = clone(form.settings[field]);
  const spec = {
    preset: form.preset,
    set_id: form.setId,
    overrides,
    special,
    apply_label_to_unlabelled: form.bulkOn && LABELS.includes(form.bulkLabel) ? form.bulkLabel : null,
    run_id: form.runId ? form.runId : null,
    settings,
    live_budget: Boolean(form.liveBudget),
  };
  if (form.preset === "custom" && CUSTOM_KINDS.includes(form.kind)) spec.kind = form.kind;
  if (token) spec.preflight_token = token;
  if (form.confirmNoKey) spec.confirm_no_key = true;
  return spec;
}

/** The body of `POST /api/runs/<id>/panoramas`: the set and the operator's fixed choices, nothing else. */
export function addPanoramasBody(form, rows) {
  const { overrides, special } = taskChoices(rows, form.choices);
  return {
    set_id: form.setId,
    overrides,
    special,
    apply_label_to_unlabelled: form.bulkOn && LABELS.includes(form.bulkLabel) ? form.bulkLabel : null,
  };
}

/**
 * The body of `POST /api/eval/runs` and of its `/estimate` (contract 4.6, A5). `effort` and
 * `limit` are left out when the operator did not choose one.
 */
export function evalBody(form, { launch = false } = {}) {
  const settings = form.settings || {};
  const body = {
    hedge: Boolean(settings.hedge),
    web: settings.allow_web !== false,
    tools_off: (settings.disabled_tools || []).slice(),
    concurrency: settings.concurrency,
  };
  if (EFFORTS.includes(form.evalEffort)) body.effort = form.evalEffort;
  if (isInt(form.evalLimit) && form.evalLimit > 0) body.limit = form.evalLimit;
  if (form.runId) body.run_id = form.runId;
  if (launch && form.confirmNoKey) body.confirm_no_key = true;
  return body;
}

/** `?limit=` as a whole number above 0, or null. */
export function parseLimit(text) {
  const value = parseNumber(text, { integer: true });
  return Number.isInteger(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------- uploads

function suffixOf(name) {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * What to do with one dropped file, by its relative path:
 *   {action: "upload", path, trimmed}   send it to `?path=<path>`
 *   {action: "ignore", reason}          a dot-file or macOS resource fork: listed, never sent
 *   {action: "reject", reason}          not a file the server accepts: listed with the reason
 * The path is the file's own (A18: no renaming; the panorama id is its file name). Only when it is
 * nested deeper than the server stores are the outer folders dropped, never the file name or the
 * folder it sits in, so `Urban/` and `non-Urban/` survive.
 */
export function uploadPlan(relPath, size) {
  const raw = String(relPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = raw.split("/");
  const name = parts[parts.length - 1] || "";
  if (!raw || parts.some((part) => part === "" || part === "." || part === "..")) {
    return { action: "reject", reason: "This is not a usable file path." };
  }
  if (parts.some((part) => part.startsWith(".") || part === "__MACOSX")) {
    return { action: "ignore", reason: "Hidden file (its name starts with a dot)." };
  }
  if (!ACCEPTED_SUFFIXES.includes(suffixOf(name))) {
    return { action: "reject", reason: "Not accepted: only " + ACCEPTED_SUFFIXES.join(", ") + " files." };
  }
  if (typeof size === "number" && size > MAX_UPLOAD_BYTES) {
    return { action: "reject", reason: "Larger than " + fmtBytes(MAX_UPLOAD_BYTES) + ". Split the archive or upload the files one by one." };
  }
  const kept = parts.slice(-MAX_PATH_COMPONENTS);
  return { action: "upload", path: kept.join("/"), trimmed: kept.length < parts.length };
}

/** `/api/sets/<id>/files?path=…` for one file. */
export function uploadUrl(setId, path) {
  return "/api/sets/" + encodeURIComponent(setId) + "/files?path=" + encodeURIComponent(path);
}

/** A same-origin image URL of a panorama of a set, by its relative path (stable when ids move). */
export function setImageUrl(setId, relPath, width) {
  const key = String(relPath).split("/").map(encodeURIComponent).join("/");
  return "/api/sets/" + encodeURIComponent(setId) + "/image/" + key + "?w=" + encodeURIComponent(String(width));
}

/** The folder every dropped path shares, as a name for the set; null when there is none. */
export function setNameFromPaths(paths) {
  const tops = new Set();
  for (const path of paths || []) {
    const parts = String(path).replace(/^\/+/, "").split("/");
    if (parts.length < 2) return null;
    tops.add(parts[0]);
  }
  if (tops.size !== 1) return null;
  const [name] = Array.from(tops);
  return LABELS.includes(name) ? null : name.slice(0, 80);
}

/** Totals of an upload queue, for the overall progress bar. */
export function uploadTotals(items) {
  const sending = (items || []).filter((item) => item.action === "upload");
  const done = sending.filter((item) => item.state === "done").length;
  const failed = sending.filter((item) => item.state === "failed").length;
  const bytes = sending.reduce((sum, item) => sum + (item.size || 0), 0);
  const sent = sending.reduce((sum, item) => {
    if (item.state === "done") return sum + (item.size || 0);
    return sum + Math.min(item.loaded || 0, item.size || 0);
  }, 0);
  return {
    files: sending.length,
    done,
    failed,
    pending: sending.length - done - failed,
    bytes,
    sent,
    share: bytes > 0 ? Math.min(1, sent / bytes) : sending.length ? done / sending.length : 0,
    skipped: (items || []).length - sending.length,
  };
}

// ---------------------------------------------------------------- ceilings

/** The sum of the spend caps of the panoramas that would run: the most the run can cost. */
export function costCeiling(rows) {
  const total = freshRows(rows).reduce((sum, row) => sum + ((row.budget && row.budget.max_spend_usd) || 0), 0);
  return Math.round(total * 100) / 100;
}

/** What past runs of this preset cost for this many panoramas, or null when there are none. */
export function pastEstimate(estimates, presetName, panoramas) {
  const entry = estimates && estimates[presetName];
  if (!entry || !entry.runs || !isNumber(entry.mean_cost_usd) || !panoramas) return null;
  return {
    usd: Math.round(entry.mean_cost_usd * panoramas * 100) / 100,
    per_panorama_usd: entry.mean_cost_usd,
    runs: entry.runs,
    panoramas: entry.panoramas,
  };
}

/**
 * The longest the run can take if every panorama uses its whole hard deadline. With no more
 * panoramas than slots that is the longest deadline; with equal deadlines it is one deadline per
 * round; otherwise it is the bound that holds for any start order (total / slots + the longest,
 * less its share). The global watchdog caps it.
 */
export function timeCeiling(hardDeadlines, concurrency, watchdogS) {
  const times = (hardDeadlines || []).filter((value) => isNumber(value) && value > 0);
  if (!times.length) return null;
  const slots = Math.max(1, Math.floor(concurrency) || 1);
  const longest = Math.max(...times);
  const total = times.reduce((sum, value) => sum + value, 0);
  let uncapped = total / slots + longest * (1 - 1 / slots);
  if (times.length <= slots) uncapped = longest;
  else if (times.every((value) => value === longest)) uncapped = Math.ceil(times.length / slots) * longest;
  const capped = isNumber(watchdogS) && watchdogS > 0 && uncapped > watchdogS;
  return { seconds: capped ? watchdogS : uncapped, uncapped, capped };
}

// ---------------------------------------------------------------- readiness

const GB = 1024 ** 3;
export const DISK_WARN_BYTES = 5 * GB;
export const DISK_BAD_BYTES = 1 * GB;

/**
 * The readiness checklist next to the Launch button: one verdict per item.
 *   verdict: "ok" | "warn" | "bad" | "unknown";  `section` is the part of Settings that fixes it.
 * Nothing here blocks by itself except what `launchBlockers` repeats: a missing OpenAI key needs
 * the explicit second click, other active runs are a warning (U4).
 */
export function readinessItems({ readiness, health = null, fakeModel = false, ownRunId = null } = {}) {
  const r = readiness || {};
  const items = [];
  const openaiOk = health && health.openai ? health.openai.ok : null;
  if (fakeModel) {
    items.push({
      id: "model", label: "Model", verdict: "warn", section: null,
      text: "Demo model: this server answers with a script. No OpenAI call is made and the answers are not real.",
    });
  } else if (!r.openai_key) {
    items.push({
      id: "openai", label: "OpenAI key", verdict: "bad", section: "keys",
      text: "Missing. Every panorama would get the fallback answer. Set the key in Settings.",
    });
  } else if (openaiOk === false) {
    items.push({
      id: "openai", label: "OpenAI key", verdict: "bad", section: "keys",
      text: "Present, but the last test failed. Test it in Settings before launching.",
    });
  } else if (openaiOk === true) {
    items.push({ id: "openai", label: "OpenAI key", verdict: "ok", section: "keys", text: "Present and answering." });
  } else {
    items.push({
      id: "openai", label: "OpenAI key", verdict: "unknown", section: "keys",
      text: "Present, not tested since the server started. Test it in Settings.",
    });
  }
  items.push(r.google_key
    ? { id: "google", label: "Google key", verdict: "ok", section: "keys", text: "Present (optional)." }
    : { id: "google", label: "Google key", verdict: "warn", section: "keys", text: "Missing (optional): no street-level lookups or Google geocoding." });
  items.push(r.mapillary_token
    ? { id: "mapillary", label: "Mapillary token", verdict: "ok", section: "keys", text: "Present (optional)." }
    : { id: "mapillary", label: "Mapillary token", verdict: "warn", section: "keys", text: "Missing (optional): no Mapillary imagery." });
  if (r.internet === true) items.push({ id: "internet", label: "Internet", verdict: "ok", section: "health", text: "Reachable." });
  else if (r.internet === false) {
    items.push({ id: "internet", label: "Internet", verdict: "bad", section: "health", text: "Not reachable. The model and the web tools need it: check the network." });
  } else {
    items.push({ id: "internet", label: "Internet", verdict: "unknown", section: "health", text: "Not checked yet. Run the health check in Settings." });
  }
  const free = r.disk_free_bytes;
  if (!isNumber(free)) items.push({ id: "disk", label: "Disk space", verdict: "unknown", section: "health", text: "Free space could not be read." });
  else if (free < DISK_BAD_BYTES) {
    items.push({ id: "disk", label: "Disk space", verdict: "bad", section: "health", text: fmtBytes(free) + " free. Logs and images may not fit: free some space first." });
  } else if (free < DISK_WARN_BYTES) {
    items.push({ id: "disk", label: "Disk space", verdict: "warn", section: "health", text: fmtBytes(free) + " free. Enough for a run, but low." });
  } else items.push({ id: "disk", label: "Disk space", verdict: "ok", section: "health", text: fmtBytes(free) + " free." });
  const others = (r.active_runs || []).filter((id) => id !== ownRunId);
  items.push(others.length
    ? {
      id: "active", label: "Other active runs", verdict: "warn", section: null, runs: others,
      text: others.length + " still running (" + others.join(", ") + "). They share the rate limits; this is allowed.",
    }
    : { id: "active", label: "Other active runs", verdict: "ok", section: null, runs: [], text: "None." });
  return items;
}

/**
 * The readiness the checklist is drawn from: what the launch context said when it was loaded,
 * brought up to date with what the event stream has told the page since (key presence, the last
 * internet check, the runs that are active now). `activeRunIds` is null until the stream connected.
 */
export function liveReadiness(readiness, health, activeRunIds) {
  if (!readiness) return null;
  const out = { ...readiness };
  const chip = (name) => (health && isObject(health[name]) ? health[name] : null);
  if (chip("openai") && typeof chip("openai").present === "boolean") out.openai_key = chip("openai").present;
  if (chip("google") && typeof chip("google").present === "boolean") out.google_key = chip("google").present;
  if (chip("mapillary") && typeof chip("mapillary").present === "boolean") out.mapillary_token = chip("mapillary").present;
  if (chip("internet") && typeof chip("internet").ok === "boolean") out.internet = chip("internet").ok;
  if (Array.isArray(activeRunIds)) out.active_runs = activeRunIds.slice();
  return out;
}

/** The worst verdict of a checklist: "bad" > "warn" > "unknown" > "ok". */
export function worstVerdict(items) {
  const order = ["ok", "unknown", "warn", "bad"];
  return (items || []).reduce((worst, item) => (order.indexOf(item.verdict) > order.indexOf(worst) ? item.verdict : worst), "ok");
}

/** Whether the launch must take the explicit "no key" path (`confirm_no_key`). */
export function needsNoKeyConfirm(readiness, fakeModel) {
  return !fakeModel && Boolean(readiness) && !readiness.openai_key;
}

// ---------------------------------------------------------------- steps and blockers

/**
 * Which steps are open ("later steps unlock when the earlier one is valid").
 * Returns `{panoramas: {open, reason}, preflight: {…}, options: {…}}`.
 * Step 4 opens when the preflight says ready (A4). One exception: a clash with a reused run id is
 * fixed in step 4 itself, so that alone must not lock it.
 */
export function stepStates({ mode = "new", preset = null, setId = null, preflight = null, preflightError = null, uploading = false } = {}) {
  const closed = (reason) => ({ open: false, reason });
  const open = { open: true, reason: null };
  if (mode !== "add" && !preset) {
    const wait = closed("Choose a preset first.");
    return { panoramas: wait, preflight: wait, options: wait };
  }
  if (preset === "eval" && mode !== "add") return { panoramas: open, preflight: open, options: open };
  const steps = { panoramas: open, preflight: open, options: open };
  if (!setId) {
    steps.preflight = closed(uploading ? "The files are still uploading." : "Choose the panoramas first.");
    steps.options = closed("Choose and check the panoramas first.");
    return steps;
  }
  if (!preflight) {
    steps.options = closed(preflightError
      ? "The panoramas could not be checked. See the step above."
      : uploading ? "The files are still uploading." : "The panoramas are being checked.");
    return steps;
  }
  const blocking = preflight.blocking || [];
  const fixedInOptions = blocking.length > 0 && blocking.every((item) => item.code === "id_collision");
  if (!preflight.ready && !fixedInOptions) {
    steps.options = closed(mode === "add"
      ? "Resolve what blocks adding them in the table above first."
      : "Resolve what blocks the launch in the table above first.");
  }
  return steps;
}

function label(context, presetName) {
  const preset = presetOf(context, presetName);
  return preset ? preset.label || presetName : String(presetName || "");
}

/**
 * Every reason the Launch (or Add) button is disabled, in the order the operator should deal
 * with them. Empty means the button works.
 */
export function launchBlockers(input) {
  const {
    mode = "new", context = null, preset = null, kind = null, setId = null, uploading = false,
    preflight = null, preflightLoading = false, preflightError = null, preflightStale = false,
    estimate = null, estimateLoading = false, estimateError = null,
    problems = [], runIdError = null, fakeModel = false, launching = false, addRun = null,
  } = input || {};
  const out = [];
  if (launching) return [mode === "add" ? "Adding the panoramas…" : "Launching…"];
  if (mode === "add") {
    if (!addRun) out.push("The run these panoramas go to has not loaded.");
    else if (!addRun.owned) out.push("This run is not held by the running server, so nothing can be added to it. Launch a new run instead.");
    else if (addRun.kind === "eval") out.push("An evaluation run takes its panoramas from the evaluation set only.");
  } else {
    if (!context) return ["The launch settings have not loaded yet."];
    if (!preset) return ["Choose a preset (step 1)."];
    if (fakeModel && (preset === "scoring" || preset === "live" || kind === "scoring" || kind === "live")) {
      out.push("The demo model is active: a " + (kind || label(context, preset)) + " run would produce demo answers. Restart the server without ASTROLABIO_FAKE_MODEL.");
    }
  }
  if (mode !== "add" && preset === "eval") {
    if (estimateError) out.push("The evaluation set could not be checked: " + estimateError);
    else if (!estimate || estimateLoading) out.push("The evaluation set is being checked.");
    else out.push(...(estimate.blocking || []));
  } else {
    if (uploading) out.push("Files are still uploading.");
    if (!setId) out.push("Choose the panoramas (step 2).");
    else if (preflightError) out.push("The panoramas could not be checked: " + preflightError);
    else if (!preflight || preflightLoading || preflightStale) out.push("The panoramas are being checked.");
    else if (!preflight.ready) out.push(...(preflight.blocking || []).map((item) => item.text));
    else if (!freshRows(preflight.rows).length) out.push("Every panorama of this set is already in the run: there is nothing to add.");
  }
  if (mode !== "add") {
    if (problems.length) out.push("Correct the settings marked in step 4 (" + problems.length + ").");
    if (runIdError) out.push("Correct the run id: " + runIdError);
  }
  return out;
}

/** The words on the launch button (UI-SPEC 5.3: without a key it says what will happen). */
export function launchLabel({ mode = "new", context = null, preset = null, noKey = false, count = 0 } = {}) {
  if (mode === "add") return "Add " + count + " panorama" + (count === 1 ? "" : "s") + " to the run";
  if (noKey) return "Launch anyway (fallback answers only)";
  if (preset === "live") return "Go: launch on stage";
  if (!preset) return "Launch";
  const name = label(context, preset).toLowerCase();
  return "Launch " + name + (/\b(run|batch)$/.test(name) ? "" : " run");
}

/** The run mode in the words of the spec. */
export function modeOf(settings) {
  return settings && settings.no_human ? "AUTONOMOUS" : "ASSISTED";
}

/** Whether a failed launch may be sent again as it is (same key, same body): only when the
 * server never answered or failed itself. A refusal (4xx) needs a change first. */
export function canRetry(err) {
  const status = err && typeof err.status === "number" ? err.status : null;
  return status === 0 || (status !== null && status >= 500);
}

/** The summary of an addition to a run that is already going, as `[label, value]` pairs. */
export function addSummaryLines({ run, rows, ceilingUsd }) {
  const counts = countRows(rows);
  const lines = [];
  if (run) {
    const mode = run.no_human ? "AUTONOMOUS" : "ASSISTED";
    lines.push(["Run", run.run_id + " (" + run.kind + ", " + mode + ", " + run.state + ")"]);
    const totals = run.totals || {};
    lines.push(["In the run now", (totals.total ?? 0) + " panorama" + (totals.total === 1 ? "" : "s") + ", " + (totals.done ?? 0) + " done"]);
  }
  lines.push(["To add", labelSummary(rows) + (counts.skipped ? " (" + counts.skipped + " already in the run, skipped)" : "")]);
  if (counts.special.length) lines.push(["Special One", counts.special.join(", ")]);
  const cost = isNumber(ceilingUsd) ? ceilingUsd : costCeiling(rows);
  lines.push(["Added cost ceiling", fmtUsd(cost) + " (sum of the spend caps of the new panoramas)"]);
  lines.push(["Settings", "As the run was launched. They are frozen and cannot change."]);
  return lines;
}

/** The lines of the launch summary, as `[label, value]` pairs of plain text. */
export function summaryLines({ context, preset, kind, settings, liveBudget, rows, ceilingUsd, estimates, runId, evalMode = false, estimate = null }) {
  const lines = [["Preset", label(context, preset) + (kind && kind !== preset ? " (" + kind + " run)" : "")]];
  const counts = countRows(rows);
  const panoramas = evalMode ? ((estimate && estimate.panoramas) || 0) : counts.total;
  if (evalMode) lines.push(["Panoramas", panoramas + " from the evaluation set"]);
  else {
    lines.push(["Panoramas", labelSummary(rows)]);
    lines.push(["Special One", counts.special.length ? counts.special.join(", ") : "none"]);
  }
  lines.push(["Mode", modeOf(settings) + (settings && settings.no_human ? " (no human channel)" : " (MCQ, cue and geocode available, each penalised)")]);
  const cost = evalMode ? (estimate ? estimate.cost_ceiling_usd : null) : (isNumber(ceilingUsd) ? ceilingUsd : costCeiling(rows));
  const past = pastEstimate(estimates, preset, panoramas);
  lines.push(["Cost ceiling", (cost === null ? "unknown" : fmtUsd(cost) + " (sum of the spend caps)")
    + (past ? "; past runs of this preset suggest about " + fmtUsd(past.usd) : "")]);
  const budgetName = (row) => (liveBudget ? "live" : row.special ? "special" : "standard");
  const deadlines = evalMode
    ? Array.from({ length: panoramas }, () => settings.standard.hard_deadline_s)
    : freshRows(rows).map((row) => (row.budget ? row.budget.hard_deadline_s : (settings[budgetName(row)] || {}).hard_deadline_s));
  const time = timeCeiling(deadlines, settings ? settings.concurrency : 1, settings ? settings.global_watchdog_s : null);
  lines.push(["Time ceiling", time
    ? fmtDuration(time.seconds) + (time.capped ? " (the global watchdog ends the run)" : " (hard deadlines, " + settings.concurrency + " in parallel)")
    : "unknown"]);
  lines.push(["Run id", runId ? runId : "UTC timestamp, made at launch"]);
  return lines;
}
