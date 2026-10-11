// Pure logic of the run dashboard (UI-SPEC 5.4): the view in the URL, the two orders of the
// panorama grid, which panorama the focus density shows, the run clock with its phase guide, the
// header totals and their words, and when each run control is available and why not. No DOM, so
// `node --test` covers it.
//
// A run is a RunState (contract 3.1 + Appendix A), its tiles are TileStates. The server is
// authoritative: nothing here decides a deadline, a penalty or an answer. These functions choose
// the words and the numbers the header shows for what the server reported.

import { fmtClock, fmtDuration, fmtInt, fmtMult, fmtPct, fmtTime, fmtUsd, plural } from "../format.js";
import { describeKind, modeInfo, penaltyParts } from "./runs.js";
import { reviewGain, sortTiles, tileStatus } from "./tile.js";

export const DENSITIES = ["board", "tiles", "focus"];
export const SORTS = ["default", "attention"];
const MAX_SCORE = 16050; // an ordinary panorama; the Special One counts three times
const SPECIAL_FACTOR = 3;
const WATCHDOG_WARN_S = 300;
const WATCHDOG_URGENT_S = 60;
const HALF_DAY_MS = 12 * 3600 * 1000;

// Number(null) is 0, which would read as "a cap of zero dollars": treat missing as missing.
function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const list = (value) => (Array.isArray(value) ? value : []);
const clamp01 = (value) => Math.min(1, Math.max(0, value));

function read(query, key) {
  if (!query) return "";
  const value = typeof query.get === "function" ? query.get(key) : query[key];
  return value === null || value === undefined ? "" : String(value);
}

// ---------------------------------------------------------------- the view in the URL (A1)

/**
 * `?density=board|tiles|focus&sort=default|attention&pano=<pid>`. A key that is absent or not one
 * of its values falls back to the operator's preference (`fallback`), then to tiles / default.
 * Returns `{density, sort, pano}`; `pano` is null when the URL names none.
 */
export function parseView(query, fallback = {}) {
  const pick = (value, allowed, preferred, last) => {
    if (allowed.includes(value)) return value;
    return allowed.includes(preferred) ? preferred : last;
  };
  return {
    density: pick(read(query, "density"), DENSITIES, fallback.density, "tiles"),
    sort: pick(read(query, "sort"), SORTS, fallback.sort, "default"),
    pano: read(query, "pano") || null,
  };
}

/** The other sort: what the `a` key and the toolbar button switch to. */
export function otherSort(sort) {
  return sort === "attention" ? "default" : "attention";
}

/**
 * The `f` key: into the focus density, and back out to the density the operator came from
 * (`previous`; tiles when that is unknown or is focus itself).
 */
export function toggleFocus(density, previous) {
  if (density !== "focus") return "focus";
  return previous && previous !== "focus" && DENSITIES.includes(previous) ? previous : "tiles";
}

// ---------------------------------------------------------------- order of the grid

// The inbox raises one "Invalid export" item for a whole run when several panoramas are affected
// (panorama_id null). In the grid each of those panoramas needs attention, so the item is spread
// over them, keeping its place in the urgency order.
function spreadRunItems(items, tiles, run) {
  const out = [];
  for (const item of list(items)) {
    if (!item) continue;
    if (item.panorama_id || item.kind !== "export") {
      out.push(item);
      continue;
    }
    const problems = (run && run.export && run.export.problems) || {};
    for (const tile of tiles) {
      if (tile.run_id !== item.run_id) continue;
      if (tile.export_problems || problems[tile.panorama_id]) out.push({ ...item, panorama_id: tile.panorama_id });
    }
  }
  return out;
}

function labelRank(tile) {
  if (tile.special) return 0;
  return tile.label === "Urban" ? 1 : 2;
}

/**
 * The tiles in the order the grid shows them.
 * `sort: "default"`: Special One first, then Urban, then non-Urban (UI-SPEC 5.4).
 * `sort: "attention"`: panoramas with an inbox item first, grouped as the inbox groups them (a
 * waiting question before a closing window before a failing API, and so on; `items` is the list
 * from attentionItems), then the rest by what a review could still gain according to the agent's
 * own belief.
 *
 * Inside one group the inbox orders by seconds left, which changes every second and would make
 * two tiles swap places while the operator reads them. So the tiles of a group keep the order
 * they have on screen (`previous`: the panorama ids as shown now); a panorama that was not on
 * screen goes behind them. The order only changes when an item is raised or cleared.
 * Returns a new array.
 */
export function orderTiles(tiles, { sort = "default", items = [], run = null, previous = [] } = {}) {
  const all = list(tiles).filter(Boolean);
  if (sort !== "attention") return sortTiles(all, { sort: "default" });

  // The inbox list is sorted by kind first, so the order in which kinds appear is their urgency.
  const kindRank = new Map();
  const group = new Map(); // pid -> rank of its most urgent item
  const position = new Map(); // pid -> place of that item in the inbox
  spreadRunItems(items, all, run).forEach((item, index) => {
    if (!kindRank.has(item.kind)) kindRank.set(item.kind, kindRank.size);
    if (!item.panorama_id || group.has(item.panorama_id)) return;
    if (run && item.run_id !== undefined && item.run_id !== run.run_id) return;
    group.set(item.panorama_id, kindRank.get(item.kind));
    position.set(item.panorama_id, index);
  });
  const shown = new Map(list(previous).map((pid, index) => [pid, index]));

  return all
    .map((tile, index) => ({ tile, index, pid: tile.panorama_id }))
    .sort((a, b) => {
      const ga = group.get(a.pid) ?? Infinity;
      const gb = group.get(b.pid) ?? Infinity;
      if (ga !== gb) return ga < gb ? -1 : 1;
      if (ga === Infinity) {
        const gain = reviewGain(b.tile) - reviewGain(a.tile);
        if (gain) return gain;
      } else {
        const pa = shown.get(a.pid);
        const pb = shown.get(b.pid);
        if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb;
        // On screen for the first time: as the inbox has them.
        if (pa === undefined && pb === undefined && position.get(a.pid) !== position.get(b.pid)) {
          return position.get(a.pid) - position.get(b.pid);
        }
        if ((pa === undefined) !== (pb === undefined)) return pa === undefined ? 1 : -1;
      }
      return labelRank(a.tile) - labelRank(b.tile) || a.index - b.index;
    })
    .map((row) => row.tile);
}

/**
 * The order to show when it must not change under the operator's hands (typing a cue, a dialog
 * open): what was shown before, without the panoramas that are gone, and with the new ones at the
 * end. With `hold` false it is simply `wanted`. Both lists are panorama ids.
 */
export function displayOrder(previous, wanted, hold) {
  const next = list(wanted);
  if (!hold) return next.slice();
  const still = new Set(next);
  const kept = list(previous).filter((pid) => still.has(pid));
  const shown = new Set(kept);
  return kept.concat(next.filter((pid) => !shown.has(pid)));
}

/**
 * Which panorama the focus density shows large. The one the URL asks for when the run has it;
 * else the one already shown (so that a changing order never swaps the tile under the operator);
 * else the first of the ordered tiles. `missing` is the id that was asked for and is not in the
 * run. Returns `{pid, missing}`; `pid` is null for a run without panoramas.
 */
export function focusTarget(ordered, wanted, current) {
  const ids = list(ordered).map((tile) => tile.panorama_id);
  if (wanted && ids.includes(wanted)) return { pid: wanted, missing: null };
  const missing = wanted && ids.length ? wanted : null;
  if (current && ids.includes(current)) return { pid: current, missing };
  return { pid: ids.length ? ids[0] : null, missing };
}

/**
 * A run this server process does not hold is a record: its tiles are drawn read-only (no control,
 * no clock that ticks), exactly as the log left them.
 */
export function isReadOnly(run) {
  return !run || run.owned !== true;
}

/** "5 panoramas: Special One eval_13, 2 Urban, 2 non-Urban". */
export function gridSummary(tiles) {
  const all = list(tiles);
  if (!all.length) return "No panoramas";
  const special = all.filter((tile) => tile.special);
  const others = all.filter((tile) => !tile.special);
  const urban = others.filter((tile) => tile.label === "Urban").length;
  const rural = others.filter((tile) => tile.label === "non-Urban").length;
  const unlabelled = others.length - urban - rural;
  const parts = [];
  if (special.length === 1) parts.push("Special One " + special[0].panorama_id);
  else if (special.length > 1) parts.push(special.length + " flagged as Special One");
  if (urban) parts.push(urban + " Urban");
  if (rural) parts.push(rural + " non-Urban");
  if (unlabelled) parts.push(unlabelled + " without a label");
  return plural(all.length, "panorama") + (parts.length ? ": " + parts.join(", ") : "");
}

// ---------------------------------------------------------------- run clock and phase guide

function phasesOf(run) {
  return list(run && run.phases)
    .map((phase) => ({
      key: String(phase.key ?? ""),
      label: String(phase.label ?? phase.key ?? ""),
      start: finite(phase.start_min),
      end: finite(phase.end_min),
    }))
    .filter((phase) => phase.start !== null && phase.end !== null && phase.end > phase.start)
    .sort((a, b) => a.start - b.start);
}

const isTicking = (run) => Boolean(run) && run.state === "running" && run.active !== false;

/**
 * The run clock. `elapsed` is store.runElapsed(run). For a run with a phase guide (the scoring
 * preset) the clock counts against the end of the last phase, 60 minutes.
 * Returns `{clock, limitS, scoring, remainingS, over, text, detail, tone, ticking}`.
 */
export function clockModel(run, elapsed) {
  const spent = Math.max(0, finite(elapsed) ?? 0);
  const phases = phasesOf(run);
  const limitS = phases.length ? phases[phases.length - 1].end * 60 : null;
  const ticking = isTicking(run);
  const clock = fmtClock(spent);
  if (limitS === null) {
    let detail = "";
    if (run && run.state === "queued") detail = "not started";
    else if (!ticking) detail = "stopped";
    return { clock, limitS: null, scoring: false, remainingS: null, over: false, text: clock, detail, tone: ticking ? "ok" : "dim", ticking };
  }
  const remainingS = limitS - spent;
  const over = remainingS < 0;
  const current = phases.find((phase) => spent >= phase.start * 60 && spent < phase.end * 60) || null;
  const late = Boolean(current) && ["freeze", "submit"].includes(current.key);
  let detail = over ? "over by " + fmtClock(-remainingS) : fmtClock(remainingS) + " left";
  if (!ticking) detail = (run && run.state === "queued" ? "not started" : "stopped") + ", " + detail;
  return {
    clock,
    limitS,
    scoring: true,
    remainingS,
    over,
    text: clock + " of " + fmtClock(limitS),
    detail,
    tone: !ticking ? "dim" : over ? "bad" : late ? "warn" : "ok",
    ticking,
  };
}

/**
 * The phase guide of SPEC 10 as a strip, or null for a run without one.
 * `{totalMin, fraction, over, ticking, current, text, phases: [{key, label, range, state, fraction,
 * leftS, title}]}`: `state` is "past" | "current" | "future", `fraction` how far the clock is through
 * that phase (0 to 1), `leftS` the seconds left in the current phase while the clock runs (null
 * otherwise), `current` the key of the phase the clock is in (null before the start and after the
 * end), `text` one sentence saying where the clock stands.
 */
export function phaseStrip(run, elapsed) {
  const phases = phasesOf(run);
  if (!phases.length) return null;
  const spent = Math.max(0, finite(elapsed) ?? 0);
  const minutes = spent / 60;
  const totalMin = phases[phases.length - 1].end;
  const over = minutes >= totalMin;
  const ticking = isTicking(run);
  let current = null;
  const rows = phases.map((phase) => {
    let state = "future";
    let fraction = 0;
    if (minutes >= phase.end) {
      state = "past";
      fraction = 1;
    } else if (minutes >= phase.start) {
      state = "current";
      fraction = clamp01((minutes - phase.start) / (phase.end - phase.start));
      current = phase;
    }
    return {
      key: phase.key,
      label: phase.label,
      range: phase.start + "–" + phase.end,
      state,
      fraction,
      // Time left only means something on a clock that is running.
      leftS: state === "current" && ticking ? phase.end * 60 - spent : null,
      title: phase.label + ": minutes " + phase.start + " to " + phase.end + " of the run clock",
    };
  });
  let text;
  if (over) {
    text = ticking
      ? "Past the " + totalMin + " minutes of the guide: submit now."
      : "The clock stopped after the " + totalMin + " minutes of the guide.";
  } else if (!current) text = "The clock has not reached the first phase.";
  else if (ticking) text = "Now: " + current.label + ", " + fmtClock(current.end * 60 - spent) + " left in this phase.";
  else text = "The clock stopped in the phase " + current.label + ".";
  return { totalMin, fraction: clamp01(minutes / totalMin), over, ticking, current: current ? current.key : null, text, phases: rows };
}

/**
 * The watchdog countdown ("everything is finalised in 38:12"), or null when the run is not
 * active or has no watchdog. `remaining` is store.watchdogRemaining(run).
 */
export function watchdogModel(run, remaining) {
  const left = finite(remaining);
  if (!run || !run.active || left === null) return null;
  const total = finite(run.watchdog_s);
  return {
    remainingS: left,
    text: left > 0 ? "everything is finalised in " + fmtClock(left) : "the watchdog is finalising everything now",
    tone: left <= WATCHDOG_URGENT_S ? "bad" : left <= WATCHDOG_WARN_S ? "warn" : "dim",
    title: "Global watchdog: when it reaches zero, every panorama that is not final is finalised with its "
      + "best-so-far list" + (total !== null ? " (" + fmtDuration(total) + " after launch)" : "")
      + ". It counts from the launch, whatever the run clock is set to.",
  };
}

/**
 * Where the run clock starts: `{iso, custom, text}`. `custom` when it was moved away from the
 * launch time (the hand-over time, decision U7).
 */
export function clockStart(run) {
  const iso = (run && run.clock_started_at) || null;
  const launched = (run && run.started_at) || null;
  if (!iso) return { iso: null, custom: false, text: "The clock has no start time yet: the run has not started." };
  const custom = Boolean(launched) && Date.parse(iso) !== Date.parse(launched);
  return {
    iso,
    custom,
    text: custom
      ? "The clock counts from " + fmtTime(iso) + ", set by hand. The run was launched at " + fmtTime(launched) + "."
      : "The clock counts from the launch, at " + fmtTime(iso) + ".",
  };
}

/**
 * A time of day typed into the clock editor ("10:00" or "10:00:30", local time) as a moment: the
 * one nearest to `nowMs`, so 23:55 typed just after midnight is yesterday's. Returns
 * `{iso, ms, future}` or null when the text is not a time.
 */
export function parseClockTime(value, nowMs) {
  const match = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(value ?? ""));
  if (!match) return null;
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const now = finite(nowMs) ?? Date.now();
  const day = new Date(now);
  day.setHours(hours, minutes, seconds, 0);
  let ms = day.getTime();
  if (ms - now > HALF_DAY_MS) ms = shiftDays(day, -1);
  else if (now - ms > HALF_DAY_MS) ms = shiftDays(day, 1);
  return { iso: new Date(ms).toISOString(), ms, future: ms > now };
}

// Through the calendar, not by 24 h: the day a clock change falls on is 23 or 25 hours long.
function shiftDays(date, days) {
  const moved = new Date(date.getTime());
  moved.setDate(moved.getDate() + days);
  return moved.getTime();
}

/** An ISO time as the value of an `<input type="time" step="1">`: local "HH:MM:SS", or "". */
export function timeInputValue(iso) {
  const text = fmtTime(iso);
  return /^\d{2}:\d{2}:\d{2}$/.test(text) ? text : "";
}

// ---------------------------------------------------------------- header facts and totals

/** "effort high" or "effort high, Special One xhigh". */
export function effortText(run) {
  const effort = (run && run.effort) || {};
  const standard = effort.standard ? String(effort.standard) : "";
  const special = effort.special ? String(effort.special) : "";
  if (!standard && !special) return "";
  if (!standard) return "effort " + special;
  if (!special || special === standard || !(run && run.special_present)) return "effort " + standard;
  return "effort " + standard + ", Special One " + special;
}

/**
 * The identity line of the header: `{kind, mode: {text, kind, icon, title}, model, effort, demo}`.
 * `demo` marks a run of the scripted model, whose answers are not real.
 */
export function runFacts(run) {
  return {
    kind: describeKind(run || {}),
    mode: modeInfo(run || {}),
    model: run && run.model ? String(run.model) : "model not recorded",
    effort: effortText(run),
    demo: Boolean(run && run.fake_model),
  };
}

function countStatuses(tiles, readOnly) {
  const counts = { done: 0, running: 0, awaiting_mcq: 0, pending: 0, interrupted: 0 };
  for (const tile of tiles) {
    const status = tileStatus(tile, { replay: readOnly });
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function progressDetail(counts) {
  const parts = [];
  if (counts.running) parts.push(counts.running + " running");
  if (counts.awaiting_mcq) parts.push(counts.awaiting_mcq + " waiting for your answer");
  if (counts.pending) parts.push(counts.pending + " queued");
  if (counts.interrupted) parts.push(counts.interrupted + " interrupted");
  return parts.join(", ");
}

/**
 * The totals of the header. Computed from the tiles when we hold them (they are fresher than the
 * last `run` message), else from `run.totals`.
 * Returns `{done, total, open, counts, progress, spend, proxy, penalties}`; each of the last four
 * is `{value, detail, tone, title}` ready to print, and `proxy.share` / `spend.share` are numbers
 * (or null) for a meter.
 */
export function headerTotals(run) {
  const tiles = list(run && run.panoramas);
  const totals = (run && run.totals) || {};
  const readOnly = isReadOnly(run);
  const held = tiles.length > 0;

  const counts = held ? countStatuses(tiles, readOnly) : { done: finite(totals.done) ?? 0, running: 0, awaiting_mcq: 0, pending: 0, interrupted: 0 };
  const total = held ? tiles.length : finite(totals.total) ?? 0;
  const done = counts.done;
  const open = Math.max(0, total - done);
  const progress = {
    value: done + " / " + total + " final",
    detail: total === 0 ? "no panoramas" : open === 0 ? "every panorama has its final answer" : progressDetail(counts),
    tone: total > 0 && open === 0 ? "ok" : counts.awaiting_mcq ? "attn" : counts.interrupted ? "warn" : "",
    title: "Panoramas with a final answer, out of all in the run",
  };

  const spent = held ? tiles.reduce((sum, tile) => sum + (finite(tile.spend_usd) ?? 0), 0) : finite(totals.spend_usd) ?? 0;
  let cap = finite(totals.spend_cap_usd);
  if (cap === null && held) {
    const caps = tiles.map((tile) => (tile.budget ? finite(tile.budget.max_spend_usd) : null));
    cap = caps.every((value) => value !== null) ? caps.reduce((sum, value) => sum + value, 0) : null;
  }
  const spendShare = cap !== null && cap > 0 ? spent / cap : null;
  const spend = {
    value: fmtUsd(spent),
    detail: cap !== null ? "of " + fmtUsd(cap) + " in caps" + (spendShare !== null ? " (" + fmtPct(spendShare) + ")" : "") : "no cap recorded",
    tone: spendShare !== null && spendShare > 0.8 ? "warn" : "",
    share: spendShare,
    title: "Model cost so far, against the sum of the spend caps of every panorama",
  };

  let value = 0;
  let believed = 0;
  let max = 0;
  for (const tile of tiles) {
    const proxy = tile.expected_score || {};
    const tileMax = finite(proxy.max) ?? MAX_SCORE * (tile.special ? SPECIAL_FACTOR : 1);
    max += tileMax;
    if (finite(proxy.value) !== null) {
      value += finite(proxy.value);
      believed += 1;
    }
  }
  if (!held) {
    value = finite(totals.expected_score) ?? 0;
    believed = finite(totals.expected_score) === null ? 0 : 1;
  }
  // The server counts a panorama with no belief yet toward what the run could score.
  max = finite(totals.expected_score_max) ?? max;
  const share = believed && max > 0 ? value / max : null;
  const proxy = {
    value: believed ? fmtInt(value) : "no belief yet",
    detail: believed
      ? "of " + fmtInt(max) + " (" + fmtPct(share) + "), not a score"
      : "appears with the first hypotheses; not a score",
    tone: "",
    share,
    title: "Expected-score proxy, summed over the panoramas: multiplier x 16,050 x the expected theta of the chosen "
      + "point under the agent's own hypotheses (x3 for the Special One). It is the agent's own belief, not a "
      + "score. Use it to decide where review time is best spent.",
  };

  const used = { cues: 0, mcqs: 0, human_geocodes: 0 };
  let lowest = 1;
  if (held) {
    for (const tile of tiles) {
      const penalty = tile.penalty || {};
      for (const key of Object.keys(used)) used[key] += finite(penalty[key]) ?? 0;
      lowest = Math.min(lowest, finite(penalty.multiplier) ?? 1);
    }
  } else {
    Object.assign(used, totals.penalties || {});
    lowest = finite(totals.lowest_multiplier) ?? 1;
  }
  const parts = penaltyParts(used);
  const autonomous = Boolean(run) && (run.mode === "autonomous" || run.no_human === true);
  let penaltyDetail = "lowest multiplier " + fmtMult(lowest);
  if (!parts.length) penaltyDetail = autonomous ? "human channels are off" : "every panorama at x1.0";
  const penalties = {
    value: parts.length ? parts.join(", ") : "none used",
    detail: penaltyDetail,
    tone: lowest < 1 ? "cut" : "",
    lowest,
    title: "Penalised human channels used in this run: a cue costs x0.8, a question x0.95, a geocode x0.5, "
      + "each on the panorama it was used for.",
  };

  return { done, total, open, counts, progress, spend, proxy, penalties };
}

// ---------------------------------------------------------------- run controls

const NOT_OWNED = "This run is not running in this server process, so it cannot be operated from here.";
const EXTERNAL =
  "Another process is running this run (a command-line run or a second server). It can only be operated from there.";

/**
 * Whether each run control is available, and the sentence shown when it is not:
 * `{finalizeAll, stop, add}`, each `{enabled, reason}`. Mirrors what the server accepts
 * (`Workspace.finalize_all`, `stop_run`, `add_panoramas`), which has the last word.
 * `stopped`: this page stopped the run, after which the server takes no more panoramas.
 */
export function controlStates(run, { stopped = false } = {}) {
  const off = (reason) => ({ enabled: false, reason });
  const on = { enabled: true, reason: "" };
  if (!run) {
    const loading = off("The run has not loaded.");
    return { finalizeAll: loading, stop: loading, add: loading };
  }
  if (run.external) return { finalizeAll: off(EXTERNAL), stop: off(EXTERNAL), add: off(EXTERNAL) };
  if (!run.owned) {
    // One sentence for all three: the banner over the grid says what can be done instead.
    const record = run.state === "interrupted"
      ? NOT_OWNED + " Recover it on the Submission screen with Rebuild exports."
      : NOT_OWNED + " Launch a new run for more panoramas.";
    return { finalizeAll: off(record), stop: off(record), add: off(record) };
  }
  const { open } = headerTotals(run);
  let finalizeAll = on;
  let stop = on;
  if (!run.active) {
    finalizeAll = off("The run has ended: every panorama is final and the exports are written.");
    stop = finalizeAll;
  } else if (open === 0) {
    finalizeAll = off("Every panorama already has its final answer; the run is closing.");
  }
  let add = on;
  if (run.kind === "eval") add = off("An evaluation run takes its panoramas from the evaluation set only.");
  else if (stopped) add = off("This run was stopped, and a stopped run takes no more panoramas. Launch a new run instead.");
  return { finalizeAll, stop, add };
}

/**
 * The sentences under the run controls: one line per distinct reason, naming the controls it
 * applies to. `[{controls: "Finalize all and Stop run", reason}]`; empty when all are available.
 */
export function controlReasons(states) {
  const names = { finalizeAll: "Finalize all", stop: "Stop run", add: "Add panoramas" };
  const groups = new Map();
  for (const key of Object.keys(names)) {
    const state = states && states[key];
    if (!state || state.enabled || !state.reason) continue;
    if (!groups.has(state.reason)) groups.set(state.reason, []);
    groups.get(state.reason).push(names[key]);
  }
  return Array.from(groups, ([reason, controls]) => ({
    controls: controls.length > 1 ? controls.slice(0, -1).join(", ") + " and " + controls[controls.length - 1] : controls[0],
    reason,
  }));
}

function openWords(totals) {
  const detail = progressDetail(totals.counts);
  return totals.open + " of " + plural(totals.total, "panorama") + (totals.open === 1 ? " is" : " are") + " not final yet"
    + (detail ? " (" + detail + ")" : "") + ".";
}

/**
 * What a run-level confirmation says: `{title, lines, okLabel, cancelLabel}`. Each says exactly
 * what the action does (UI-SPEC 5.4): Stop is the console's Ctrl-C.
 * `connected` false adds the warning that the page may be out of date.
 */
export function confirmWords(kind, run, { connected = true } = {}) {
  const totals = headerTotals(run);
  const stale = connected ? [] : ["The event stream is down, so the counts on this page may be out of date. The server acts on what is true now."];
  const untouched = "Nothing is sent to the agent and no penalty is charged.";
  if (kind === "stop") {
    return {
      title: "Stop run " + run.run_id + "?",
      lines: [
        openWords(totals),
        "Stop does what Ctrl-C does in the command line: every panorama that is not final is finalised with its "
          + "best-so-far list, the work in flight is cancelled, and the exports are written.",
        "A panorama that has not started, or has no hypothesis yet, gets the fallback point for its label. "
          + "An open question is closed without an answer, and a cue still queued is not delivered (it stays charged). "
          + untouched,
        "This cannot be undone, and a stopped run takes no more panoramas.",
        ...stale,
      ],
      okLabel: "Stop the run",
      cancelLabel: "Keep it running",
    };
  }
  return {
    title: "Finalize all panoramas of " + run.run_id + "?",
    lines: [
      openWords(totals),
      "Each of them keeps the best list it has now as its final answer, and the agent stops working on it. "
        + "A panorama that has not started, or has no hypothesis yet, gets the fallback point for its label. "
        + "An open question is closed without an answer, and a cue still queued is not delivered (it stays charged).",
      untouched + " The exports are written afterwards. The run itself stays open: panoramas can still be added to it.",
      "This cannot be undone.",
      ...stale,
    ],
    okLabel: "Finalize all (" + totals.open + ")",
    cancelLabel: "Keep them running",
  };
}

// ---------------------------------------------------------------- state banner

function exportTrouble(run) {
  const problems = (run.export && run.export.problems) || {};
  const pids = Object.keys(problems).filter((pid) => problems[pid]);
  if (!pids.length) return "";
  return pids.length === 1
    ? " The export of " + pids[0] + " has a problem."
    : " The exports of " + pids.length + " panoramas have problems.";
}

/**
 * The banner over the grid for a run that is not being worked on by this server, or null while it
 * is: `{tone: "info"|"ok"|"warn"|"bad", icon, title, text, actions}`. `actions` lists what the
 * banner offers, in order, from "submission" | "runs" | "new"; the first is the main one.
 */
export function runBanner(run) {
  if (!run || run.active) return null;
  const totals = headerTotals(run);
  if (run.external) {
    return {
      tone: "info",
      icon: "info",
      title: "Running in another process",
      text: "A command-line run or a second server is writing this run. This page shows what its logs say and is "
        + "read-only: nothing here can finalise it, stop it or add to it. It is read again whenever the list of runs changes.",
      actions: ["runs"],
    };
  }
  if (!run.owned && run.state === "interrupted") {
    return {
      tone: "warn",
      icon: "alert",
      title: "Interrupted run",
      text: "The server stopped before " + totals.open + " of " + plural(totals.total, "panorama") + " had a final answer, "
        + "and nothing is running them now. This page is read-only. To recover the run, open Submission and use "
        + "Rebuild exports: a panorama without a final answer is exported from its last provisional list, or from the "
        + "fallback point for its label when it had no hypothesis. Open a panorama to replay what the agent did.",
      actions: ["submission", "runs"],
    };
  }
  if (run.state === "invalid") {
    return {
      tone: "bad",
      icon: "alert",
      title: "The exported files of this run are not valid",
      text: (totals.total
        ? "The files written for this run are missing, unreadable or fail validation."
        : "This directory holds no log a run can be read from.")
        + exportTrouble(run)
        + (totals.total ? " Open Submission to see the checklist and rebuild them. Each panorama can still be replayed from its own page." : ""),
      actions: totals.total ? ["submission", "runs"] : ["runs"],
    };
  }
  if (!run.owned) {
    const stale = run.export && run.export.stale
      ? " The exported files are older than the logs: rebuild them on the Submission screen before using them."
      : "";
    return {
      tone: stale ? "warn" : "info",
      icon: stale ? "alert" : "info",
      title: "Finished run, read from disk",
      text: "Every panorama has its final answer and no process is running this run, so this page is read-only. "
        + "Open a panorama to replay it step by step, or open Submission to check and download the files." + stale,
      actions: ["submission", "runs"],
    };
  }
  if (run.state === "queued") {
    return { tone: "info", icon: "clock", title: "Queued", text: "This run is waiting to start.", actions: [] };
  }
  const assisted = run.mode === "assisted" || run.no_human === false;
  return {
    tone: "ok",
    icon: "check",
    title: "This run has ended",
    text: "Every panorama has its final answer and the exports are written." + exportTrouble(run)
      + (assisted ? " The last-resort geocode is still available on a panorama whose agent named a place." : "")
      + " Open Submission to validate, freeze and download the files.",
    actions: ["submission", "runs"],
  };
}
