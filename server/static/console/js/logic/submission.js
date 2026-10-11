// Decisions of the Submission screen (UI-SPEC 5.8), kept apart from the DOM so they can be tested
// with `node --test`: the verdict over the checklist, the grouping of the answers, the words for
// each check and each confirmation, and why a control is disabled.
//
// The server decides what passes (contract 4.5). Nothing here re-validates a file: it only turns
// the server's answer into what the operator reads in the last minutes of the hour.

import { fmtCoord, fmtDateTime, fmtLatLng, fmtTime, plural } from "../format.js";

/** How many entries a panorama's answer has in the submission format. */
export const ENTRIES = 10;

const DASH = "–";

// ---------------------------------------------------------------- checks

/** What each check of the checklist is for, in the operator's words. */
export const CHECK_INFO = {
  all_final: {
    label: "Every panorama is final",
    why: "A panorama that is still running has no fixed answer to hand in.",
  },
  ten_entries: {
    label: "Ten entries each",
    why: "The scorer reads exactly 10 points per panorama, with 6 decimals, inside the valid range.",
  },
  exports_valid: {
    label: "Exports valid",
    why: "Each panorama's JSON file must pass the format check before it is handed in.",
  },
  ledger: {
    label: "Ledger consistent",
    why: "The penalty multiplier in the files must match the cues, questions and geocodes in the log.",
  },
  files_fresh: {
    label: "Files match the page",
    why: "Files written before the last event are older than what this page shows.",
  },
  no_fallback: {
    label: "No fallback answers",
    why: "A fallback point is the harness's placeholder, not an answer from the agent. You may accept it.",
  },
  real_model: {
    label: "Real model",
    why: "Answers from the scripted demo model are made up and must not be handed in.",
  },
};

const STATUS_WORDS = {
  pass: { text: "pass", kind: "ok", icon: "check" },
  warn: { text: "warning", kind: "warn", icon: "alert" },
  fail: { text: "fail", kind: "bad", icon: "x" },
};

/** "pass" | "warn" | "fail". A status this build does not know counts as a failure, never a pass. */
export function checkStatus(check) {
  const status = check && check.status;
  return status === "pass" || status === "warn" ? status : "fail";
}

/** The label of the button a check's `action` offers, or null when it offers none. */
export function actionLabel(action, { interrupted = false } = {}) {
  if (action === "finalize_all") return "Finalize all";
  if (action === "rebuild") return interrupted ? "Recover and export" : "Rebuild exports";
  return null;
}

/** Everything the page prints for one row of the checklist. */
export function checkWords(check, { interrupted = false } = {}) {
  const source = check || {};
  const id = String(source.id ?? "");
  const info = CHECK_INFO[id] || null;
  const status = checkStatus(source);
  const words = STATUS_WORDS[status];
  const items = Array.isArray(source.items) ? source.items : [];
  const action = status === "pass" ? null : source.action || null;
  return {
    id,
    label: String(source.label || (info && info.label) || id || "Unnamed check"),
    status,
    statusText: words.text,
    kind: words.kind,
    icon: words.icon,
    detail: String(source.detail || ""),
    why: info ? info.why : "",
    items: items.map((item) => ({
      panorama_id: String((item && item.panorama_id) ?? ""),
      text: String((item && item.text) ?? ""),
    })),
    action: actionLabel(action, { interrupted }) ? action : null,
    actionLabel: actionLabel(action, { interrupted }),
  };
}

/** `{pass, warn, fail, total}` over a checklist. */
export function checkCounts(checks) {
  const counts = { pass: 0, warn: 0, fail: 0, total: 0 };
  for (const check of checks || []) {
    counts[checkStatus(check)] += 1;
    counts.total += 1;
  }
  return counts;
}

/** "5 pass, 1 warning, 0 fail". */
export function countsText(counts) {
  return counts.pass + " pass, " + plural(counts.warn, "warning") + ", " + counts.fail + " fail";
}

// ---------------------------------------------------------------- the run

/** The panoramas of a run that have no final answer yet, in the run's order. */
export function unfinishedTiles(run) {
  return ((run && run.panoramas) || []).filter((tile) => tile && tile.status !== "done");
}

function listNames(names, limit = 6) {
  const shown = names.slice(0, limit);
  const rest = names.length - shown.length;
  return shown.join(", ") + (rest > 0 ? " and " + rest + " more" : "");
}

/** The files written after the "submitted" stamp: what was handed in may no longer be what is here. */
export function filesChangedSince(files, submittedAt) {
  const stamp = Date.parse(submittedAt || "");
  if (Number.isNaN(stamp)) return [];
  return (files || [])
    .filter((file) => {
      const modified = Date.parse((file && file.modified_at) || "");
      return !Number.isNaN(modified) && modified > stamp;
    })
    .map((file) => String(file.name));
}

/** Date and time with seconds: a stamp or a file time has to be told apart to the second. */
export function stampText(iso) {
  const day = fmtDateTime(iso);
  if (day === DASH) return DASH;
  return day.slice(0, 10) + " " + fmtTime(iso);
}

// ---------------------------------------------------------------- verdict

const TONE_ICON = { ok: "check", warn: "alert", bad: "x", wait: "clock" };

function made(state, tone, ready, title, reasons, next) {
  return { state, tone, icon: TONE_ICON[tone], ready, title, reasons: reasons.filter(Boolean), next };
}

/**
 * The one sentence at the top of the screen and what stands behind it.
 *   state: "running" | "external" | "interrupted" | "demo" | "failing" | "warnings" | "ready"
 *   tone:  "ok" | "warn" | "bad" | "wait"       ready: true only when the files may be handed in
 * `validation` is the body of GET /validation; `run` the RunState when the page holds it.
 * Returns null while there is no checklist to judge.
 */
export function verdict(validation, run) {
  if (!validation || !Array.isArray(validation.checks)) return null;
  const words = validation.checks.map((check) => checkWords(check, { interrupted: Boolean(validation.interrupted) }));
  const failing = words.filter((check) => check.status === "fail");
  const warnings = words.filter((check) => check.status === "warn");
  const reasonsOf = (list) => list.map((check) => check.label + ": " + (check.detail || check.statusText + "."));
  const tiles = (run && run.panoramas) || [];
  const unfinished = unfinishedTiles(run);
  const waiting = unfinished.length
    ? unfinished.length + " of " + plural(tiles.length, "panorama") + " not final: " +
      listNames(unfinished.map((tile) => String(tile.panorama_id))) + "."
    : null;

  if (run && run.external) {
    return made("external", "wait", false, "Not ready: another process is running this run", [
      waiting,
      "This server is not the one writing its logs, so it can only watch.",
    ], "Wait for that process to end, then check again.");
  }
  if (run && run.active && unfinished.length) {
    return made("running", "wait", false, "Not ready: the run is still going", [waiting],
      "Wait for the panoramas to finish, or use Finalize all to fix every answer as it stands.");
  }
  if (validation.interrupted) {
    return made("interrupted", "bad", false, "Not ready: this run was interrupted", [
      "The server stopped while the run was going, so its logs and files are unfinished.",
      waiting,
    ], "Use Recover and export below. It finishes the logs from each panorama's last list, then writes the files.");
  }
  const fake = Boolean(validation.fake_model) || failing.some((check) => check.id === "real_model");
  if (fake) {
    const others = failing.filter((check) => check.id !== "real_model");
    return made("demo", "bad", false, "Do not submit: these are demo answers", [
      "This run was answered by the scripted demo model. Its answers are made up.",
      ...reasonsOf(others),
    ], "Launch a run with the real model. These files are only good for trying the console out.");
  }
  if (failing.length) {
    const actions = new Set(failing.map((check) => check.action).filter(Boolean));
    let next = "Read the failing checks below. Nothing on this page can repair them, so look at the panoramas named there.";
    if (actions.has("finalize_all")) next = "Use Finalize all, then read the checklist again.";
    else if (actions.has("rebuild")) next = "Rebuild the exports, then read the checklist again.";
    return made("failing", "bad", false,
      "Not ready: " + plural(failing.length, "check") + (failing.length === 1 ? " fails" : " fail"),
      reasonsOf(failing), next);
  }
  const count = words.length;
  const all = "All " + plural(count, "check") + " pass" + (tiles.length ? " for " + plural(tiles.length, "panorama") : "") + ".";
  if (warnings.length) {
    return made("warnings", "warn", true, "Ready to submit, with " + plural(warnings.length, "warning"),
      reasonsOf(warnings), "You may accept the warning and download the zip, or put it right first.");
  }
  return made("ready", "ok", true, "Ready to submit", [all], "Download the submission zip and hand it in.");
}

// ---------------------------------------------------------------- answers

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Two entries are the same point when they print the same in the submission format.
function pointKey(lat, lng) {
  return lat === null || lng === null ? null : fmtCoord(lat) + "," + fmtCoord(lng);
}

/** "#3" or "#1–10". */
export function rankText(start, end) {
  return start === end ? "#" + start : "#" + start + "–" + end;
}

/** What a panorama's list amounts to, in a few words. */
export function entriesText(row) {
  if (!row.count) return "no entries";
  if (row.identical) return row.count + " x the same point";
  return row.count + " entries, " + plural(row.distinct, "distinct point");
}

/**
 * answers.csv rows grouped per panorama, in the order of the file. Consecutive entries with the
 * same coordinates collapse into one group, so the common list ("10 x the same point") is one line
 * and a hedged list shows where it splits.
 * Each row: `{panorama_id, entries: [{rank, lat, lng}], groups: [{start, end, count, lat, lng,
 * ranks}], count, distinct, identical, complete}`.
 */
export function groupAnswers(answers) {
  const order = [];
  const held = new Map();
  for (const raw of answers || []) {
    if (!raw) continue;
    const pid = String(raw.panorama_id ?? "");
    if (!held.has(pid)) {
      held.set(pid, []);
      order.push(pid);
    }
    const entries = held.get(pid);
    const rank = Number.isInteger(raw.rank) ? raw.rank : entries.length + 1;
    entries.push({ rank, lat: asNumber(raw.lat), lng: asNumber(raw.lng) });
  }
  return order.map((pid) => {
    const entries = held.get(pid);
    const groups = [];
    const seen = new Set();
    for (const entry of entries) {
      const key = pointKey(entry.lat, entry.lng);
      seen.add(key ?? "invalid:" + entry.rank);
      const last = groups[groups.length - 1];
      if (last && key !== null && last.key === key && entry.rank === last.end + 1) {
        last.end = entry.rank;
        last.count += 1;
      } else {
        groups.push({ key, start: entry.rank, end: entry.rank, count: 1, lat: entry.lat, lng: entry.lng });
      }
    }
    for (const group of groups) group.ranks = rankText(group.start, group.end);
    return {
      panorama_id: pid,
      entries,
      groups,
      count: entries.length,
      distinct: seen.size,
      identical: entries.length > 0 && seen.size === 1 && groups.length === 1 && groups[0].key !== null,
      complete: entries.length === ENTRIES,
    };
  });
}

const ORIGIN_WORDS = {
  agent: { text: "agent", kind: "dim", icon: "target" },
  // The result of a penalised channel is not itself a penalised control: no penalty colour here.
  human_geocode: { text: "human geocode", kind: "info", icon: "map" },
  harness_fallback: { text: "fallback", kind: "warn", icon: "alert" },
};

/** Badge words for where a final answer came from. */
export function originWords(origin) {
  if (origin === null || origin === undefined || origin === "") return { text: "unknown", kind: "dim", icon: "question" };
  return ORIGIN_WORDS[origin] || { text: String(origin), kind: "dim", icon: "info" };
}

function entryMultipliers(tile) {
  const entries = tile && Array.isArray(tile.final) ? tile.final : [];
  const values = entries.map((entry) => asNumber(entry && entry.multiplier)).filter((value) => value !== null);
  if (!values.length) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * One row per panorama for the answers table: the grouped entries of answers.csv, with the
 * multiplier and origin summary.csv gives (the tile's when the file has no row), in the run's own
 * order. A panorama of the run with no row in answers.csv is listed with no entries, so a missing
 * answer is seen, not skipped.
 */
export function answerRows(validation, run) {
  const groups = groupAnswers(validation && validation.answers);
  const byId = new Map(groups.map((group) => [group.panorama_id, group]));
  const summary = new Map(((validation && validation.summary) || []).map((row) => [String(row.panorama ?? ""), row]));
  const tiles = new Map(((run && run.panoramas) || []).map((tile) => [String(tile.panorama_id), tile]));
  const order = [];
  for (const pid of tiles.keys()) order.push(pid);
  for (const group of groups) if (!tiles.has(group.panorama_id)) order.push(group.panorama_id);
  return order.map((pid) => {
    const group = byId.get(pid) || {
      panorama_id: pid, entries: [], groups: [], count: 0, distinct: 0, identical: false, complete: false,
    };
    const row = summary.get(pid) || null;
    const tile = tiles.get(pid) || null;
    const tileMult = tile && tile.penalty ? asNumber(tile.penalty.multiplier) : null;
    const range = entryMultipliers(tile);
    return {
      ...group,
      label: (row && row.label) || (tile && tile.label) || null,
      special: row ? Boolean(row.special) : Boolean(tile && tile.special),
      multiplier: row && asNumber(row.multiplier) !== null ? asNumber(row.multiplier) : tileMult,
      // Under the "subsequent" penalty scope the entries of one list can carry different multipliers.
      multiplierRange: range && range.min !== range.max ? range : null,
      origin: (row && row.origin) || (tile && tile.origin) || null,
      problems: row && row.problems ? String(row.problems) : "",
      in_run: tiles.size === 0 || tiles.has(pid),
    };
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** The rows as answers.csv writes them (header, 6 decimals), for the clipboard. */
export function answersCsv(answers, panoramaId = null) {
  const lines = ["panorama_id,rank,lat,lng"];
  for (const row of answers || []) {
    if (!row || (panoramaId !== null && String(row.panorama_id) !== String(panoramaId))) continue;
    const lat = asNumber(row.lat);
    const lng = asNumber(row.lng);
    lines.push([
      csvCell(row.panorama_id),
      row.rank === null || row.rank === undefined ? "" : String(row.rank),
      lat === null ? "" : fmtCoord(lat),
      lng === null ? "" : fmtCoord(lng),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

/** Markers for the one map of every answer: one per distinct point of a panorama. */
export function answerMarkers(rows) {
  const markers = [];
  for (const row of rows || []) {
    const seen = new Map();
    for (const group of row.groups) {
      if (group.key === null) continue;
      if (!seen.has(group.key)) seen.set(group.key, { lat: group.lat, lng: group.lng, ranks: [] });
      seen.get(group.key).ranks.push(group.ranks);
    }
    for (const point of seen.values()) {
      markers.push({
        lat: point.lat,
        lng: point.lng,
        kind: "answer",
        label: row.panorama_id + " " + point.ranks.join(", "),
        panorama_id: row.panorama_id,
      });
    }
  }
  return markers;
}

// ---------------------------------------------------------------- the hour

/**
 * Where a scoring run stands on its phase strip (SPEC 10 timeline). Null when the run has none.
 * `{index, phase, fraction, phase_fraction, remaining_s, phase_remaining_s, total_s, over, segments:
 * [{key, label, start_min, end_min, share, state: "past"|"current"|"future"}]}`. `fraction` is how
 * far the hour is, `phase_fraction` how far the current phase is (both 0 to 1).
 */
export function phasePosition(phases, elapsedS) {
  if (!Array.isArray(phases) || !phases.length) return null;
  const elapsed = Math.max(0, Number(elapsedS) || 0);
  const totalMin = Math.max(...phases.map((phase) => Number(phase.end_min) || 0));
  if (totalMin <= 0) return null;
  const total = totalMin * 60;
  let index = phases.findIndex((phase) => elapsed < (Number(phase.end_min) || 0) * 60);
  const over = index === -1;
  if (over) index = phases.length - 1;
  const phase = phases[index];
  const phaseStart = (Number(phase.start_min) || 0) * 60;
  const phaseLength = (Number(phase.end_min) || 0) * 60 - phaseStart;
  return {
    index,
    phase,
    fraction: Math.min(1, elapsed / total),
    phase_fraction: over || phaseLength <= 0 ? 1 : Math.min(1, Math.max(0, (elapsed - phaseStart) / phaseLength)),
    remaining_s: Math.max(0, total - elapsed),
    phase_remaining_s: Math.max(0, (Number(phase.end_min) || 0) * 60 - elapsed),
    total_s: total,
    over,
    segments: phases.map((item, i) => ({
      key: String(item.key ?? i),
      label: String(item.label ?? item.key ?? ""),
      start_min: Number(item.start_min) || 0,
      end_min: Number(item.end_min) || 0,
      share: Math.max(0, ((Number(item.end_min) || 0) - (Number(item.start_min) || 0)) / totalMin),
      state: over || i < index ? "past" : i === index ? "current" : "future",
    })),
  };
}

/** How long after the end of the hour the strip is still shown (as "over time"). */
export const HOUR_GRACE_S = 30 * 60;

/**
 * Seconds since the clock of a scoring run started, by the wall clock: the hour keeps running
 * after the last panorama is final and across a server restart. Null for a run with no phases.
 */
export function hourElapsed(run, serverNowMs) {
  if (!run || !Array.isArray(run.phases) || !run.phases.length) return null;
  const started = Date.parse(run.clock_started_at || "");
  if (Number.isNaN(started) || !Number.isFinite(serverNowMs)) return null;
  return Math.max(0, (serverNowMs - started) / 1000);
}

/**
 * The phase strip to show for a run now, or null: only for a scoring run that has not been
 * marked as submitted, until half an hour past the end of its hour.
 */
export function hourPosition(run, serverNowMs, submittedAt = null) {
  const elapsed = hourElapsed(run, serverNowMs);
  if (elapsed === null || submittedAt) return null;
  const position = phasePosition(run.phases, elapsed);
  if (!position || elapsed > position.total_s + HOUR_GRACE_S) return null;
  return { ...position, elapsed_s: elapsed, over_s: Math.max(0, elapsed - position.total_s) };
}

// ---------------------------------------------------------------- confirmations

/** What "Finalize all" will do, for its confirmation. */
export function finalizePlan(run) {
  const unfinished = unfinishedTiles(run);
  const names = listNames(unfinished.map((tile) => String(tile.panorama_id)));
  return {
    title: "Finalize all panoramas?",
    lines: [
      unfinished.length
        ? plural(unfinished.length, "panorama") + " still " + (unfinished.length === 1 ? "has" : "have") + " no final answer: " + names + "."
        : "Every panorama already has a final answer.",
      "Each one is fixed at its best list so far. A panorama with no hypothesis yet gets the fallback point.",
      "The agent stops working on them and the files are written. This cannot be undone.",
    ],
    okLabel: "Finalize all",
    tone: "danger",
  };
}

const EMBED_LINE =
  "Images will be embedded: expect roughly 10 to 20 MB per panorama instead of about half a megabyte.";

/**
 * What the export job will do. `confirm` is true when it changes the logs for good (recovering an
 * interrupted run); a plain rebuild changes no answer and needs no confirmation.
 */
export function exportPlan({ interrupted = false, unfinished = 0, embed = false } = {}) {
  if (!interrupted) {
    return {
      confirm: false,
      title: "Rebuild the exports",
      lines: [
        "Writes every panorama's JSON file, answers.csv and summary.csv again from the logs. No answer changes.",
        embed ? EMBED_LINE : null,
      ].filter(Boolean),
      okLabel: "Rebuild exports",
      tone: "default",
    };
  }
  return {
    confirm: true,
    title: "Recover this run and write its files?",
    lines: [
      unfinished
        ? "The server stopped while this run was going. " + plural(unfinished, "panorama") + " " +
          (unfinished === 1 ? "has" : "have") + " no final answer."
        : "The server stopped while this run was going, and some of its logs were never closed.",
      "Recovering closes those logs: each panorama's last provisional list becomes its final answer, and one " +
        "with no hypothesis gets the fallback point. No model call is made.",
      "The logs are the record, and this writes into them. It cannot be undone.",
      embed ? EMBED_LINE : null,
    ].filter(Boolean),
    okLabel: "Recover and export",
    tone: "danger",
  };
}

const FORCE_CONSEQUENCE = {
  run_owned_elsewhere:
    "The files will show the run as it stands at this moment and go stale as soon as that process writes again.",
  run_recently_written:
    "If a process is still writing these logs, finishing them here leaves duplicate events and a wrong final " +
    "answer in them. Continue only when you are sure nothing else is running this run.",
};

/**
 * The second confirmation, for an export the server refused until it is forced (contract A36).
 * Returns null when the refusal is not one that `force` answers.
 */
export function forcePlan(err) {
  if (!err || err.status !== 409 || err.action !== "force") return null;
  const consequence = FORCE_CONSEQUENCE[err.code] ||
    "Forcing skips the check that nothing else is writing this run. If something is, its logs can be damaged.";
  return {
    title: "Go ahead although the run may still be written?",
    lines: [String(err.message || "The server refused to rebuild this run."), consequence],
    okLabel: err.code === "run_owned_elsewhere" ? "Rebuild anyway" : "Finish the logs and rebuild",
    tone: "danger",
  };
}

function fakeConfirm(message) {
  return {
    flag: "fake_ok",
    title: "Download demo answers?",
    lines: [
      message || "This run was answered by the scripted demo model.",
      "These are demo answers, not real ones. Do not hand this zip in.",
    ],
    okLabel: "Download the demo answers",
    tone: "danger",
  };
}

function forceConfirm(labels, message) {
  return {
    flag: "force",
    title: "Download files that fail the checklist?",
    lines: [
      message || "These checks fail: " + labels.join(", ") + ".",
      "The zip will hold the files exactly as they are on disk. Do not hand it in unless you know why each check fails.",
    ],
    okLabel: "Download the files as they are",
    tone: "danger",
  };
}

/**
 * What must be asked before the submission zip is fetched, from the checklist as it stands.
 * `{empty, confirms: [{flag: "fake_ok"|"force", title, lines, okLabel, tone}]}`: each confirmed
 * flag is added to the download URL; `empty` means there is no file to pack.
 */
export function downloadPlan(validation) {
  const checks = (validation && validation.checks) || [];
  const failing = checks.filter((check) => checkStatus(check) === "fail");
  const fake = Boolean(validation && validation.fake_model) || failing.some((check) => check.id === "real_model");
  const others = failing.filter((check) => check.id !== "real_model").map((check) => checkWords(check).label);
  const confirms = [];
  if (fake) confirms.push(fakeConfirm(null));
  if (others.length) confirms.push(forceConfirm(others, null));
  return { empty: !((validation && validation.files) || []).length, confirms };
}

/**
 * The confirmation for a download the server refused with 409 and a flag we have not sent yet
 * (the checklist changed between the page's last read and the click). Null for any other error.
 */
export function refusalConfirm(err, flags = {}) {
  if (!err || err.status !== 409) return null;
  if (err.action === "fake_ok" && !flags.fake_ok) return fakeConfirm(String(err.message || ""));
  if (err.action === "force" && !flags.force) return forceConfirm([], String(err.message || ""));
  return null;
}

/** "?fake_ok=1&force=1" for the confirmed flags, or "". */
export function downloadQuery(flags = {}) {
  const parts = [];
  if (flags.fake_ok) parts.push("fake_ok=1");
  if (flags.force) parts.push("force=1");
  return parts.length ? "?" + parts.join("&") : "";
}

// ---------------------------------------------------------------- controls

const enabled = { disabled: false, reason: "" };
const off = (reason) => ({ disabled: true, reason });

/**
 * Whether a control of the screen can be used now, and the sentence shown when it cannot.
 *   name: "finalize_all" | "rebuild" | "download" | "mark" | "unmark"
 *   facts: {run, validation, jobActive (an export job is running), busy (a request is in flight)}
 */
export function actionState(name, facts = {}) {
  const { run = null, validation = null, jobActive = false, busy = false } = facts;
  if (busy) return off("Another action is in progress. Wait for it to finish.");
  const files = (validation && validation.files) || [];
  const unfinished = unfinishedTiles(run);
  if (name === "finalize_all") {
    if (run && run.external) return off("Another process is running this run. Only that process can finalise it.");
    if (run && !run.owned) return off("This server is not running this run, so there is nothing to finalise. Rebuild the exports instead.");
    if (run && !unfinished.length) return off("Every panorama is already final.");
    return enabled;
  }
  if (name === "rebuild") {
    if (jobActive) return off("An export is already running. Wait for it to finish.");
    return enabled;
  }
  if (name === "download") {
    if (jobActive) return off("The files are being written. Wait for the export to finish.");
    if (validation && !files.length) {
      if (run && run.active && unfinished.length) return off("There are no export files yet. They are written when every panorama is final.");
      if (validation.interrupted) return off("There are no export files yet. Use Recover and export first.");
      return off("There are no export files yet. Rebuild the exports first.");
    }
    return enabled;
  }
  if (name === "mark") {
    if (run && run.active && unfinished.length) return off("The run is still going. Finalize it and download the files first.");
    if (jobActive) return off("The files are being written. Wait for the export to finish.");
    if (validation && !files.length) return off("There is nothing to submit yet: no export files on disk.");
    return enabled;
  }
  return enabled;
}

// ---------------------------------------------------------------- jobs, files

/** What the page shows of an export job. */
export function jobView(job) {
  if (!job) return null;
  const progress = job.progress || {};
  const done = Number(progress.done);
  const total = Number(progress.total);
  const active = job.state === "queued" || job.state === "running";
  const result = job.result && typeof job.result === "object" ? job.result : {};
  const problems = result.problems && typeof result.problems === "object" ? result.problems : {};
  return {
    id: String(job.id ?? ""),
    title: String(job.title || "Export"),
    state: String(job.state || "queued"),
    active,
    failed: job.state === "failed",
    done: job.state === "done",
    // No total: the bar slides instead of pretending to know how far it is.
    fraction: Number.isFinite(done) && Number.isFinite(total) && total > 0 ? Math.min(1, Math.max(0, done / total)) : null,
    text: String(progress.text || (job.state === "queued" ? "waiting to start" : "")),
    lines: Array.isArray(job.log) ? job.log.map((line) => String(line)) : [],
    error: job.error ? String(job.error) : null,
    recovered: Array.isArray(result.recovered) ? result.recovered.map((pid) => String(pid)) : [],
    problems: Object.entries(problems).map(([pid, text]) => ({ panorama_id: String(pid), text: String(text) })),
    written_at: result.written_at || null,
  };
}

/** The newest export job of a run that is still working, from the store's jobs. */
export function activeExportJob(jobs, runId) {
  let found = null;
  for (const job of jobs || []) {
    if (!job || job.kind !== "export" || job.run_id !== runId) continue;
    if (job.state !== "queued" && job.state !== "running") continue;
    if (!found || String(job.created_at || "") > String(found.created_at || "")) found = job;
  }
  return found;
}

/** Total size of the listed files, in bytes. */
export function totalBytes(files) {
  return (files || []).reduce((sum, file) => sum + (Number(file && file.size_bytes) || 0), 0);
}

/** "lat, lng" with 6 decimals: the text a copy button puts on the clipboard. */
export function pointText(lat, lng) {
  return fmtLatLng(lat, lng);
}
