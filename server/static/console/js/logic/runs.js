// Pure logic of the Runs screen (UI-SPEC 5.2): which rows are shown, in what order, the words
// for a run's state and the reason an action is not available. No DOM, so `node --test` covers it.
//
// A row is a RunRow (contract 3.1: RunState without `panoramas` and `settings`, plus
// `wall_time_s`). Rows of runs this server holds are rebuilt from the store's RunState, which is
// fresher than the last GET /api/runs; those carry `_live: true`.

import { plural } from "../format.js";
import { runElapsed, runTotals } from "./reduce.js";

export const KINDS = ["training", "scoring", "live", "eval", "cli"];
export const STATES = ["running", "queued", "interrupted", "invalid", "finished"];

const KIND_LABEL = {
  training: "Training",
  scoring: "Scoring",
  live: "Live",
  eval: "Evaluation",
  cli: "Command line",
};

const STATE_LABEL = {
  running: "Running",
  queued: "Queued",
  interrupted: "Interrupted",
  invalid: "Invalid",
  finished: "Finished",
};

// The direction a column sorts in when it is first chosen: the end an operator looks for first.
export const SORTS = {
  created: "desc",
  run: "asc",
  state: "asc",
  panoramas: "desc",
  spend: "desc",
  multiplier: "asc",
  time: "desc",
  score: "desc",
};

export const DEFAULT_VIEW = Object.freeze({ kind: "all", state: "all", q: "", sort: "created", dir: "desc" });

export function kindLabel(kind) {
  return KIND_LABEL[kind] || String(kind || "Unknown");
}

export function stateLabel(state) {
  return STATE_LABEL[state] || String(state || "Unknown");
}

/**
 * "Training · autonomous preset": what a run is and which preset launched it. A preset that only
 * repeats the kind (scoring, live, eval) is left out.
 */
export function describeKind(row) {
  const kind = kindLabel(row.kind);
  return row.preset && row.preset !== row.kind ? kind + " · " + row.preset + " preset" : kind;
}

/** The mode badge: text, badge kind, icon and the sentence behind it. */
export function modeInfo(row) {
  const assisted = row.mode === "assisted" || (row.mode === undefined && row.no_human === false);
  if (assisted) {
    return {
      text: "ASSISTED",
      kind: "info",
      icon: "eye",
      title: "Human channels on: MCQ answers, cues and the last-resort geocode can reach the agent, each at a penalty.",
    };
  }
  return {
    text: "AUTONOMOUS",
    kind: "dim",
    icon: "lock",
    title: "Human channels off: nothing an operator does reaches the agent.",
  };
}

// ---------------------------------------------------------------- the view in the URL

function read(query, key) {
  if (!query) return "";
  const value = typeof query.get === "function" ? query.get(key) : query[key];
  return value === null || value === undefined ? "" : String(value);
}

/** The filters and the sort from the query string; anything unknown falls back to the default. */
export function parseView(query) {
  const kind = read(query, "kind");
  const state = read(query, "state");
  const sort = read(query, "sort");
  const dir = read(query, "dir");
  const column = Object.prototype.hasOwnProperty.call(SORTS, sort) ? sort : DEFAULT_VIEW.sort;
  return {
    kind: KINDS.includes(kind) ? kind : "all",
    state: STATES.includes(state) ? state : "all",
    q: read(query, "q"),
    sort: column,
    dir: dir === "asc" || dir === "desc" ? dir : SORTS[column],
  };
}

/** The changes for router.setQuery: a value at its default is removed from the URL. */
export function viewQuery(view) {
  return {
    kind: view.kind === "all" ? null : view.kind,
    state: view.state === "all" ? null : view.state,
    q: view.q.trim() ? view.q : null,
    sort: view.sort === DEFAULT_VIEW.sort ? null : view.sort,
    dir: view.dir === SORTS[view.sort] ? null : view.dir,
  };
}

/** Clicking a column header: a new column starts in its natural direction, the same one flips. */
export function toggleSort(view, column) {
  if (!Object.prototype.hasOwnProperty.call(SORTS, column)) return view;
  if (view.sort !== column) return { ...view, sort: column, dir: SORTS[column] };
  return { ...view, dir: view.dir === "asc" ? "desc" : "asc" };
}

export function isFiltered(view) {
  return view.kind !== "all" || view.state !== "all" || view.q.trim() !== "";
}

// ---------------------------------------------------------------- rows

function penaltiesOf(run) {
  const tiles = run.panoramas || [];
  const fromRun = (run.totals && run.totals.penalties) || {};
  if (!tiles.length) {
    return { cues: fromRun.cues || 0, mcqs: fromRun.mcqs || 0, human_geocodes: fromRun.human_geocodes || 0 };
  }
  const sum = { cues: 0, mcqs: 0, human_geocodes: 0 };
  for (const tile of tiles) {
    const penalty = tile.penalty || {};
    for (const key of Object.keys(sum)) sum[key] += Number(penalty[key]) || 0;
  }
  return sum;
}

/** A RunRow built from a RunState the store holds: its tiles are fresher than `run.totals`. */
export function liveRow(run) {
  const { panoramas, settings, ...rest } = run;
  const tiles = panoramas || [];
  const totals = runTotals(run);
  return {
    ...rest,
    totals: {
      ...(run.totals || {}),
      done: totals.done,
      total: totals.total,
      spend_usd: totals.spend_usd,
      lowest_multiplier: totals.lowest_multiplier,
      penalties: penaltiesOf(run),
    },
    special_present: tiles.length ? tiles.some((tile) => tile.special) : Boolean(run.special_present),
    pending_mcqs: totals.pending_mcqs,
    _live: true,
  };
}

/**
 * The rows to show: the last GET /api/runs with every run the store holds laid over it (and
 * added, when it was launched after that GET). `hidden` holds ids deleted a moment ago.
 */
export function mergeRows(fetched, liveRuns, hidden) {
  const byId = new Map();
  for (const row of fetched || []) {
    if (row && row.run_id) byId.set(row.run_id, row);
  }
  for (const run of liveRuns || []) {
    if (run && run.run_id) byId.set(run.run_id, liveRow(run));
  }
  if (hidden) for (const id of hidden) byId.delete(id);
  return Array.from(byId.values());
}

/** Seconds on the row's clock: ticking for a run that is going here, else its wall time. */
export function rowSeconds(row, nowMs) {
  if (row.active) {
    if (row._live) return runElapsed(row, nowMs);
    return numberOr(row.elapsed_s, numberOr(row.wall_time_s, null));
  }
  return numberOr(row.wall_time_s, null);
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Score and distance come from ground truth, which is only ever shown for an evaluation run with
 * human channels off (UI-SPEC 3). The server already withholds them otherwise; this is the page's
 * own check on top.
 */
export function truthVisible(row) {
  return row.kind === "eval" && row.no_human !== false && row.mode !== "assisted" && Boolean(row.results);
}

// ---------------------------------------------------------------- filter, sort, group

const needleOf = (text) => String(text || "").trim().toLowerCase();

function matches(row, view, { skip } = {}) {
  if (skip !== "kind" && view.kind !== "all" && row.kind !== view.kind) return false;
  if (skip !== "state" && view.state !== "all" && row.state !== view.state) return false;
  const needle = needleOf(view.q);
  return !needle || String(row.run_id).toLowerCase().includes(needle);
}

export function filterRows(rows, view) {
  return rows.filter((row) => matches(row, view));
}

/**
 * The number beside each filter button: how many rows that choice would show with the other
 * filter and the search left as they are.
 */
export function filterCounts(rows, view) {
  const kind = { all: 0 };
  const state = { all: 0 };
  for (const name of KINDS) kind[name] = 0;
  for (const name of STATES) state[name] = 0;
  for (const row of rows) {
    if (matches(row, view, { skip: "kind" })) {
      kind.all += 1;
      if (row.kind in kind) kind[row.kind] += 1;
    }
    if (matches(row, view, { skip: "state" })) {
      state.all += 1;
      if (row.state in state) state[row.state] += 1;
    }
  }
  return { kind, state };
}

function createdMs(row) {
  const parsed = Date.parse(row.created_at || "");
  return Number.isNaN(parsed) ? null : parsed;
}

function sortValue(row, column, nowMs) {
  const totals = row.totals || {};
  switch (column) {
    case "run": return String(row.run_id);
    case "state": {
      const index = STATES.indexOf(row.state);
      return index === -1 ? STATES.length : index;
    }
    case "panoramas": return numberOr(totals.total, null);
    case "spend": return numberOr(totals.spend_usd, null);
    case "multiplier": return numberOr(totals.lowest_multiplier, null);
    case "time": return rowSeconds(row, nowMs);
    case "score": return truthVisible(row) ? numberOr(row.results.score_share, null) : null;
    default: return createdMs(row);
  }
}

function compareValues(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Newest first, then the id (run ids default to UTC timestamps), so the order never flickers.
function newestFirst(a, b) {
  const byTime = compareValues(createdMs(b) ?? -Infinity, createdMs(a) ?? -Infinity);
  return byTime || compareValues(String(b.run_id), String(a.run_id));
}

/**
 * Sorted copy. Active runs are pinned on top whatever the column (UI-SPEC 5.2); a row without a
 * value for the column goes last in both directions.
 */
export function sortRows(rows, view, nowMs = 0) {
  const sign = view.dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
    const va = sortValue(a, view.sort, nowMs);
    const vb = sortValue(b, view.sort, nowMs);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
      return newestFirst(a, b);
    }
    return sign * compareValues(va, vb) || newestFirst(a, b);
  });
}

/** Split sorted rows into the pinned active runs and the rest. */
export function groupRows(rows) {
  return { active: rows.filter((row) => row.active), rest: rows.filter((row) => !row.active) };
}

/** "12 runs, 2 active" or "3 of 12 runs shown". */
export function summaryText(all, shown) {
  if (!all.length) return "";
  const active = all.filter((row) => row.active).length;
  const head = shown.length === all.length
    ? plural(all.length, "run")
    : shown.length + " of " + plural(all.length, "run") + " shown";
  return active ? head + ", " + active + " active" : head;
}

// ---------------------------------------------------------------- words for a row

/** ["2 cues", "1 MCQ"]: the penalties used, one entry per kind; empty when there were none. */
export function penaltyParts(penalties) {
  const p = penalties || {};
  const parts = [];
  if (p.cues) parts.push(plural(p.cues, "cue"));
  if (p.mcqs) parts.push(plural(p.mcqs, "MCQ"));
  if (p.human_geocodes) parts.push(plural(p.human_geocodes, "geocode"));
  return parts;
}

/** "2 cues, 1 MCQ" or "no penalties". */
export function penaltyText(penalties) {
  const parts = penaltyParts(penalties);
  return parts.length ? parts.join(", ") : "no penalties";
}

export function penaltiesUsed(row) {
  const p = (row.totals && row.totals.penalties) || {};
  return (p.cues || 0) + (p.mcqs || 0) + (p.human_geocodes || 0);
}

function problemList(row) {
  const problems = (row.export && row.export.problems) || {};
  return Object.entries(problems).map(([pid, text]) => pid + ": " + text);
}

/**
 * The state cell: `status` for dom.statusBadge, and a short `detail` in plain words (or "").
 * `tone` is "warn" or "bad" when the detail is something to act on.
 */
export function stateInfo(row) {
  const totals = row.totals || {};
  const total = totals.total || 0;
  const left = Math.max(0, total - (totals.done || 0));
  switch (row.state) {
    case "running":
      if (row.external) return { status: "running", detail: "in another process", tone: "" };
      return { status: "running", detail: "", tone: "" };
    case "queued":
      return { status: "queued", detail: "waiting to start", tone: "" };
    case "interrupted":
      return { status: "interrupted", detail: left + " of " + total + " not final", tone: "warn" };
    case "invalid": {
      const problems = problemList(row).length;
      if (problems) return { status: "invalid", detail: "export problems in " + plural(problems, "panorama"), tone: "bad" };
      return { status: "invalid", detail: total ? "exports missing or unreadable" : "no usable logs", tone: "bad" };
    }
    case "finished":
      if (row.export && row.export.stale) return { status: "finished", detail: "exports out of date", tone: "warn" };
      return { status: "finished", detail: "", tone: "" };
    default:
      return { status: row.state, detail: "", tone: "" };
  }
}

const MAX_PROBLEMS = 3;

/**
 * The explanation under a row that needs one, or null: `{tone: "info"|"warn"|"bad", text,
 * problems: [str], more: int, action: "recover"|"submission"|null}`.
 */
export function rowNote(row) {
  const totals = row.totals || {};
  const total = totals.total || 0;
  const left = Math.max(0, total - (totals.done || 0));
  if (row.external) {
    return {
      tone: "info",
      text: "Another process is writing this run (a command-line run or a second server). It can be watched here, "
        + "but it cannot be operated, exported or deleted from this server while that process is alive.",
      problems: [],
      more: 0,
      action: null,
    };
  }
  if (row.state === "interrupted") {
    return {
      tone: "warn",
      text: "The server stopped before " + left + " of " + plural(total, "panorama") + " had a final answer. "
        + "Recover and export finishes the logs and rebuilds the files: a panorama without a final submission is "
        + "exported from its last provisional list (recovered_from_provisional), and one with no hypothesis yet "
        + "gets the harness fallback.",
      problems: [],
      more: 0,
      action: "recover",
    };
  }
  if (row.state === "invalid") {
    const problems = problemList(row);
    if (!problems.length && !total) {
      return {
        tone: "bad",
        text: "This directory holds nothing a run can be read from. It can be deleted.",
        problems: [],
        more: 0,
        action: null,
      };
    }
    return {
      tone: "bad",
      text: problems.length
        ? "The exported files of this run have problems. Open Submission to see the checklist and rebuild them."
        : "The exported files of this run are missing or cannot be read. Open Submission to rebuild them.",
      problems: problems.slice(0, MAX_PROBLEMS),
      more: Math.max(0, problems.length - MAX_PROBLEMS),
      action: "submission",
    };
  }
  return null;
}

// ---------------------------------------------------------------- actions

/**
 * Why this run cannot be deleted, or null when it can. Mirrors `Workspace.delete_run`, which has
 * the last word: an active run, one another process is writing, one being exported, and a
 * scoring run (U3) are refused.
 */
export function deleteBlock(row, { exportJob = false } = {}) {
  if (row.active) return "This run is still going. Stop it on its dashboard first.";
  if (row.external) return "Another process is writing this run, so it cannot be deleted from here.";
  if (exportJob) return "The exports of this run are being rebuilt. Wait for that to finish.";
  if (row.kind === "scoring") return "A scoring run is never deleted from the console: its logs are the record.";
  if (row.kind === "cli" && (row.no_human === false || penaltiesUsed(row) > 0)) {
    return "This command-line run had human channels on, so it is kept like a scoring run and is never deleted from the console.";
  }
  return null;
}

/** Why the submission zip cannot be taken straight from the list, or null when it can. */
export function downloadBlock(row) {
  if (row.active) return "This run is still going. The zip is available once it has finished.";
  if (row.external) return "Another process is writing this run. Wait for it to finish.";
  if (row.state === "interrupted") return "This run was interrupted. Recover and export it first.";
  if (row.state === "invalid") return "The exports of this run have problems. Open Submission to see and fix them.";
  if (row.fake_model) {
    return "This run was made by the demo model, so its answers are not real. Open Submission if you need the files anyway.";
  }
  const exported = row.export || {};
  if (!exported.written_at) return "This run has no exported files yet. Rebuild its exports first.";
  if (exported.stale) return "The files on disk are older than the logs. Rebuild the exports first.";
  return null;
}

/**
 * Why the exports cannot be rebuilt straight from the list, or null when they can. A plain
 * rebuild writes the files again from the logs and changes no answer. An interrupted run is
 * different (its logs are finished first, which fixes answers), so that goes through the
 * Submission screen, where the checklist is.
 */
export function rebuildBlock(row) {
  if (row.active) return "This run is still going. Its exports are written when it finishes.";
  if (row.external) return "Another process is writing this run. Wait for it to finish.";
  if (row.state === "interrupted") {
    return "This run was interrupted. Use Recover and export instead: it finishes the logs before the files are rebuilt.";
  }
  if (!((row.totals && row.totals.total) || 0)) return "This run has no panorama to export.";
  return null;
}

/**
 * Every row action with the reason it is unavailable (`null` = available). `recover` is true for
 * a run whose exports must be rebuilt from its logs before anything else.
 */
export function rowActions(row, { exportJob = false } = {}) {
  const total = (row.totals && row.totals.total) || 0;
  let replay = null;
  if (row.active) replay = "This run is still going. Open it to follow it live; replay is for a run that has ended.";
  else if (!total) replay = "This run has no panorama to replay.";
  return {
    replay,
    rebuild: rebuildBlock(row),
    // The files are being written right now: a zip taken in the middle could hold half of them.
    download: exportJob ? "The exports of this run are being rebuilt. Wait for that to finish." : downloadBlock(row),
    duplicate: row.kind === "cli"
      ? "This run was started from the command line and has no saved settings to copy."
      : null,
    delete: deleteBlock(row, { exportJob }),
    recover: row.state === "interrupted" && !row.external,
  };
}

/**
 * How a finished export job is reported: `{tone: "ok"|"warn"|"error", text}`, or null while it is
 * still queued or running. `job.result.problems` is `{panorama_id: text}`.
 */
export function exportOutcome(runId, job) {
  if (!job) return null;
  if (job.state === "failed") {
    const why = String(job.error || "The server gave no reason").trim().replace(/[.\s]+$/, "");
    return {
      tone: "error",
      text: "The exports of run " + runId + " could not be rebuilt. " + why + ". Open Submission to see what is on disk.",
    };
  }
  if (job.state !== "done") return null;
  const problems = Object.keys((job.result && job.result.problems) || {}).length;
  if (problems) {
    return {
      tone: "warn",
      text: "The exports of run " + runId + " were rebuilt, but " + plural(problems, "panorama") + " "
        + (problems === 1 ? "has" : "have") + " problems. Open Submission to see them.",
    };
  }
  return { tone: "ok", text: "The exports of run " + runId + " were rebuilt from its logs." };
}

/** Ids of the runs with an export job that is queued or running, from the store's jobs. */
export function exportingRuns(jobs) {
  const ids = new Set();
  for (const job of jobs || []) {
    if (job && job.kind === "export" && job.run_id && (job.state === "queued" || job.state === "running")) ids.add(job.run_id);
  }
  return ids;
}
