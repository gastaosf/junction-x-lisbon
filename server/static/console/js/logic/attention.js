// The attention inbox (UI-SPEC 5.1, contract A1 + A6): what needs a human now, most urgent first.
// Pure: derived from the store state and the current time only.
//
// Scope is every owned run in the snapshot. Items that need a live panorama (mcq, window, api,
// no_hypothesis, spend) come from active tiles only; a fallback answer stays raised on a finished
// run until it is acknowledged, and an invalid export until the export is valid.

import { isTicking, mcqRemaining, tileElapsed } from "./reduce.js";

export const WINDOW_WARN_S = 120; // "human window closing" is raised this close to the hard deadline
export const NO_HYPOTHESIS_S = 180; // a tile that has run this long without a candidates update
export const SPEND_SHARE = 0.8; // share of max_spend_usd above which a tile is flagged

// Lower is more urgent. A question has 90 s and is already paid for; a closing window is the last
// chance to use a channel; the rest cost points only if left until the freeze.
const URGENCY = { mcq: 0, window: 1, api: 2, export: 3, fallback: 4, spend: 5, no_hypothesis: 6 };

const TITLES = {
  mcq: "MCQ waiting",
  window: "Human window closing",
  api: "API failing",
  export: "Invalid export",
  fallback: "Fallback answer",
  spend: "Spend near cap",
  no_hypothesis: "No hypothesis yet",
};

const enc = encodeURIComponent;
const runPath = (runId) => "/runs/" + enc(runId);
const panoPath = (runId, pid, query) => runPath(runId) + "/" + enc(pid) + (query ? "?" + query : "");

// Number(null) is 0, which would read as "deadline at zero seconds": treat missing as missing.
function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function countdown(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}

// A backend that omits `active` must not silence the inbox: fall back to the tile's own status.
function isActive(tile) {
  if (typeof tile.active === "boolean") return tile.active;
  return tile.live !== false && ["pending", "running", "awaiting_mcq"].includes(tile.status);
}

// The moment an item's countdown reaches zero, on the clock of `nowMs`. It is worked out from the
// tile's own stamp, so it stays the same number from one second to the next: the inbox is sorted
// by it and never by the rounded seconds on screen, which would make two questions asked a
// fraction of a second apart change places every half second.
function dueAt(tile, secondsFromReceipt, nowMs) {
  const base = typeof tile._at === "number" ? tile._at : nowMs;
  return base + secondsFromReceipt * 1000;
}

// `text` is the whole sentence ("MCQ waiting: pano_3 (0:47 left)"); `title` and `detail` are its
// parts, for a list that lays them out separately.
function item(kind, run, tile, fields) {
  const pid = tile ? tile.panorama_id : null;
  const detail = fields.detail || null;
  return {
    id: [kind, run.run_id, pid ?? ""].join(":"),
    kind,
    run_id: run.run_id,
    panorama_id: pid,
    title: TITLES[kind],
    text: TITLES[kind] + ": " + (pid ?? run.run_id) + (detail ? " (" + detail + ")" : ""),
    detail,
    seconds_left: null,
    due_ms: null,
    special: Boolean(tile && tile.special),
    ...fields,
  };
}

function mcqItem(run, tile, nowMs) {
  if (!isActive(tile) || !tile.pending_mcq) return null;
  const left = mcqRemaining(tile, nowMs);
  const seconds = left === null ? null : Math.ceil(left);
  return item("mcq", run, tile, {
    id: ["mcq", run.run_id, tile.panorama_id, tile.pending_mcq.id ?? ""].join(":"),
    detail: seconds === null ? null : countdown(seconds) + " left",
    question: tile.pending_mcq.question ?? null,
    seconds_left: seconds,
    due_ms: left === null ? null : dueAt(tile, Number(tile.pending_mcq.remaining_s), nowMs),
    href: panoPath(run.run_id, tile.panorama_id, "open=mcq"),
  });
}

function windowItem(run, tile, nowMs) {
  if (!isActive(tile) || !isTicking(tile)) return null;
  if (tile.human_enabled === false || !tile.human_window) return null;
  const elapsed = tileElapsed(tile, nowMs);
  const hard = tile.budget ? finite(tile.budget.hard_deadline_s) : null;
  const closesAt = finite(tile.human_window.cue_closes_at_s) ?? hard;
  const deadline = hard ?? closesAt;
  if (deadline === null || deadline - elapsed >= WINDOW_WARN_S) return null;
  const seconds = Math.max(0, Math.ceil(closesAt - elapsed));
  return item("window", run, tile, {
    detail: seconds > 0
      ? "cue window shuts in " + countdown(seconds)
      : "closed: a cue no longer reaches the agent",
    seconds_left: seconds,
    due_ms: dueAt(tile, closesAt - (Number(tile.elapsed_s) || 0), nowMs),
    href: panoPath(run.run_id, tile.panorama_id, "open=cue"),
  });
}

function hasFallback(tile) {
  if (!tile.final) return false;
  if (tile.origin === "harness_fallback") return true;
  return Array.isArray(tile.final) && tile.final.some((entry) => entry && entry.origin === "harness_fallback");
}

function fallbackItem(run, tile) {
  if (!hasFallback(tile) || tile.fallback_acknowledged) return null;
  return item("fallback", run, tile, {
    detail: tile.stop_text || null,
    href: panoPath(run.run_id, tile.panorama_id, "open=ack"),
  });
}

function apiItem(run, tile) {
  if (!isActive(tile) || !tile.api_trouble) return null;
  return item("api", run, tile, {
    detail: tile.api_trouble_text || null,
    href: panoPath(run.run_id, tile.panorama_id, "filter=errors"),
  });
}

function noHypothesisItem(run, tile, nowMs) {
  if (!isActive(tile) || !isTicking(tile)) return null;
  if (tile.first_candidates_t_rel_s !== null && tile.first_candidates_t_rel_s !== undefined) return null;
  if (Array.isArray(tile.hypotheses) && tile.hypotheses.length) return null;
  const elapsed = tileElapsed(tile, nowMs);
  if (elapsed < NO_HYPOTHESIS_S) return null;
  return item("no_hypothesis", run, tile, {
    detail: "running for " + countdown(elapsed),
    href: panoPath(run.run_id, tile.panorama_id),
  });
}

function spendItem(run, tile) {
  if (!isActive(tile) || tile.final) return null;
  const cap = tile.budget ? finite(tile.budget.max_spend_usd) : null;
  const spend = finite(tile.spend_usd);
  if (cap === null || spend === null || cap <= 0 || spend <= SPEND_SHARE * cap) return null;
  const share = Math.round((spend / cap) * 100);
  return item("spend", run, tile, {
    detail: share + "% of $" + cap.toFixed(2),
    href: panoPath(run.run_id, tile.panorama_id),
  });
}

function exportItem(run) {
  const problems = { ...((run.export && run.export.problems) || {}) };
  for (const tile of run.panoramas || []) {
    if (tile.export_problems && !problems[tile.panorama_id]) problems[tile.panorama_id] = tile.export_problems;
  }
  const pids = Object.keys(problems).filter((pid) => problems[pid]);
  if (!pids.length) return null;
  const which = pids.length === 1 ? pids[0] : pids.length + " panoramas";
  const detail = String(problems[pids[0]]);
  return item("export", run, null, {
    panorama_id: pids.length === 1 ? pids[0] : null,
    text: "Invalid export: " + which + " (" + detail + ")",
    detail,
    href: runPath(run.run_id) + "/submit",
  });
}

// By kind, then by the moment the countdown runs out (items without one last), then the Special
// One, then the id. Nothing in the key changes while the clock runs, so the order holds still.
function compare(a, b) {
  if (URGENCY[a.kind] !== URGENCY[b.kind]) return URGENCY[a.kind] - URGENCY[b.kind];
  const dueA = a.due_ms ?? Infinity;
  const dueB = b.due_ms ?? Infinity;
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  if (a.special !== b.special) return a.special ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Items that need a human, most urgent first.
 * Each: {id, kind, run_id, panorama_id|null, text, seconds_left|null, href} plus `title`
 * (the row's name in the UI-SPEC table), `detail` (the specifics, or null), `special` (the
 * panorama is the Special One), `due_ms` (when the countdown runs out, or null) and, for an MCQ,
 * `question`. Items of one kind keep their order while their seconds tick.
 */
export function attentionItems(state, nowMs) {
  const items = [];
  const push = (found) => { if (found) items.push(found); };
  for (const run of state.runs.values()) {
    for (const tile of run.panoramas || []) {
      push(mcqItem(run, tile, nowMs));
      push(windowItem(run, tile, nowMs));
      push(apiItem(run, tile));
      push(fallbackItem(run, tile));
      push(noHypothesisItem(run, tile, nowMs));
      push(spendItem(run, tile));
    }
    push(exportItem(run));
  }
  return items.sort(compare);
}

/** Items of one run or one panorama, for the "needs attention first" sort and the tile flags. */
export function attentionFor(items, runId, pid) {
  return items.filter((it) => it.run_id === runId && (pid === undefined || it.panorama_id === pid));
}

/** The pending question with the least time left (the oldest one), or null. */
export function oldestPendingMcq(state, nowMs) {
  return attentionItems(state, nowMs).find((it) => it.kind === "mcq") || null;
}

/** Tab-title prefix while a question is pending: "(1) MCQ 0:47"; null when none is. */
export function mcqTitle(state, nowMs) {
  const pending = attentionItems(state, nowMs).filter((it) => it.kind === "mcq");
  if (!pending.length) return null;
  const left = pending[0].seconds_left;
  return "(" + pending.length + ") MCQ" + (left === null ? "" : " " + countdown(left));
}
