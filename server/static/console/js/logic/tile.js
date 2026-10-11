// Derived values and words for one panorama tile (UI-SPEC 5.4 "What each tile must make obvious",
// 5.5). Pure: everything here is computed from a TileState (contract 3.1 + Appendix A), the
// seconds the tile has been running and the current time, so it can be tested with `node --test`.
//
// The server is authoritative: nothing here decides a penalty, a deadline or an answer. These
// functions only choose the words and the numbers the tile shows for what the server reported.

import { panoUrl } from "../api.js";
import { fmtClock, fmtCountdown, fmtDist, fmtDuration, fmtInt, fmtLatLng, fmtMult, fmtPct, fmtUsd, plural } from "../format.js";
import { SPEND_SHARE, WINDOW_WARN_S } from "./attention.js";

export const STALL_S = 60; // "stalled" after this long without an event (UI-SPEC 5.4)
export const PREVIEW_WIDTHS = [1024, 2048, 4096]; // the widths the image route re-encodes to
export const THUMB_WIDTH = 320;
export const EXPECTED_ENTRIES = 10;
const MAX_SCORE = 16050; // an ordinary panorama; the Special One counts three times
const SPECIAL_FACTOR = 3;
const CUE_MARGIN_S = 30; // a cue is refused inside the last 30 s (session.CUE_MIN_REMAINING_S)

const STATUSES = new Set(["pending", "running", "awaiting_mcq", "done", "interrupted"]);

// Number(null) is 0, which would read as "deadline at zero seconds": treat missing as missing.
function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const list = (value) => (Array.isArray(value) ? value : []);
const hasPoint = (thing) => Boolean(thing) && finite(thing.lat) !== null && finite(thing.lng) !== null;

// ---------------------------------------------------------------- status

/** True once the answer of record exists. */
export function isFinal(tile) {
  return Boolean(tile) && Array.isArray(tile.final);
}

/**
 * The status the tile shows. A panorama that no session of this server is running and that has
 * no final answer is `interrupted` (contract A2), whatever its log last said. In a replay the
 * status is the one the log had at that moment: a past state is not an interruption.
 */
export function tileStatus(tile, { replay = false } = {}) {
  if (!tile) return "pending";
  const status = STATUSES.has(tile.status) ? tile.status : "pending";
  if (replay) return status;
  if (isFinal(tile)) return "done";
  if (tile.live === false) return "interrupted";
  return status;
}

export function isInterrupted(tile, options) {
  return tileStatus(tile, options) === "interrupted";
}

// ---------------------------------------------------------------- image sources

/**
 * Sources for the 360° viewer, smallest first: the re-encoded previews that are narrower than
 * the panorama, then the original. Without the image size (a panorama that has not started) the
 * previews alone are offered. Every url is an API path of this app (contract A30).
 */
export function panoSources(runId, pid, tile) {
  const full = tile && tile.image ? finite(tile.image.width) : null;
  const sources = [];
  for (const width of PREVIEW_WIDTHS) {
    // A preview is never scaled up, so one as wide as the original would only repeat it.
    if (full !== null && full > 0 && width >= full && sources.length) continue;
    sources.push({ width: full !== null && full > 0 ? Math.min(width, full) : width, url: panoUrl(runId, pid, "/image?w=" + width) });
    if (full !== null && full > 0 && width >= full) break;
  }
  const widest = sources[sources.length - 1].width;
  if (full !== null && full > widest) sources.push({ width: full, url: panoUrl(runId, pid, "/image?w=full") });
  return sources;
}

/** The small preview a board row shows. */
export function thumbUrl(runId, pid) {
  return panoUrl(runId, pid, "/image?w=" + THUMB_WIDTH);
}

/** A string that changes when, and only when, a list of sources does. */
export function sourcesKey(sources) {
  return list(sources).map((source) => source.width + "@" + source.url).join("|");
}

/** The crops the viewer can outline: every view_crop that has a direction. */
export function viewerCrops(tile) {
  return list(tile && tile.crops).filter((crop) => crop && finite(crop.n) !== null && finite(crop.yaw) !== null && finite(crop.fov) !== null);
}

// ---------------------------------------------------------------- time

/**
 * The time bar. `elapsed` is the seconds the panorama has run (store.elapsed).
 * Returns `{known, hard, soft, fraction, softFraction, cueFraction, phase, tone, clock, text}`;
 * `phase` is "queued" | "before_soft" | "after_soft" | "over" | "ended" | "interrupted".
 * The bar runs from zero to the hard deadline, so the fractions are shares of it.
 */
export function deadlineModel(tile, elapsed, options) {
  const budget = (tile && tile.budget) || {};
  const hard = finite(budget.hard_deadline_s);
  const soft = finite(budget.soft_deadline_s);
  const spent = Math.max(0, finite(elapsed) ?? 0);
  const status = tileStatus(tile, options);
  const known = hard !== null && hard > 0;
  const window = tile && tile.human_window;
  const cueAt = window ? finite(window.cue_closes_at_s) : null;

  let phase;
  if (status === "pending") phase = "queued";
  else if (status === "done") phase = "ended";
  else if (status === "interrupted") phase = "interrupted";
  else if (known && spent >= hard) phase = "over";
  else if (soft !== null && spent >= soft) phase = "after_soft";
  else phase = "before_soft";

  let text;
  if (phase === "queued") text = "not started";
  else if (phase === "ended") text = "ended at " + fmtClock(spent);
  else if (phase === "interrupted") text = "stopped at " + fmtClock(spent);
  else if (phase === "over") text = "hard deadline reached: the best-so-far list is used";
  else if (phase === "after_soft") {
    text = "soft deadline passed" + (known ? "; hard deadline in " + fmtClock(hard - spent) : "");
  } else if (soft !== null) text = "soft deadline in " + fmtClock(soft - spent);
  else text = known ? "hard deadline in " + fmtClock(hard - spent) : "running";

  const tone = { queued: "dim", ended: "done", interrupted: "warn", over: "bad", after_soft: "warn", before_soft: "ok" }[phase];
  return {
    known,
    hard,
    soft,
    fraction: known ? clamp01(spent / hard) : 0,
    softFraction: known && soft !== null ? clamp01(soft / hard) : null,
    cueFraction: known && cueAt !== null ? clamp01(cueAt / hard) : null,
    phase,
    tone,
    clock: known ? fmtClock(spent) + " / " + fmtClock(hard) : fmtClock(spent),
    text,
  };
}

function questionDetail(tile, elapsed) {
  if (tile.mcq_allowed === false) return "questions are switched off";
  if (finite(tile.mcqs_left) === 0) return "no questions left";
  const closes = tile.human_window ? finite(tile.human_window.mcq_closes_at_s) : null;
  if (closes === null) return null;
  const left = closes - elapsed;
  return left > 0 ? "the agent can still ask a question for " + fmtClock(left) : "too late for a new question";
}

/**
 * The human-window line under the time bar (UI-SPEC 5.4 "How long do I have?").
 * Null for a run with human channels off: the control bar says so instead.
 * Returns `{state: "waiting"|"open"|"closing"|"closed", tone, text, short, detail}`; `short` is
 * the same fact in the few words a board row has room for, with the time left kept whole.
 */
export function humanWindow(tile, elapsed, options) {
  if (!tile || tile.human_enabled === false) return null;
  const status = tileStatus(tile, options);
  const spent = Math.max(0, finite(elapsed) ?? 0);
  if (status === "interrupted") {
    return {
      state: "closed",
      tone: "warn",
      text: "human channels closed: this panorama is no longer running",
      short: "human channels closed",
      detail: null,
    };
  }
  if (status === "done") {
    const used = tile.origin === "human_geocode" || (tile.penalty && finite(tile.penalty.human_geocodes) > 0);
    if (used) {
      return { state: "closed", tone: "dim", text: "cue / question window closed; the geocode has been used", short: "closed; geocode used", detail: null };
    }
    if (tile.live === false) {
      return {
        state: "closed", tone: "dim", text: "cue / question window closed", short: "window closed",
        detail: "no human channel reaches a panorama that is not running in this server",
      };
    }
    const named = list(tile.named_places).length > 0;
    return {
      state: "closed",
      tone: "dim",
      text: "cue / question window closed; only the x0.5 geocode remains",
      short: named ? "closed; x0.5 geocode only" : "window closed",
      detail: named ? null : "the agent named no place, so the geocode is unavailable too",
    };
  }
  if (status === "pending") {
    return {
      state: "waiting", tone: "dim", text: "cue / question window opens when this panorama starts",
      short: "window opens at start", detail: null,
    };
  }
  const hard = tile.budget ? finite(tile.budget.hard_deadline_s) : null;
  const fromWindow = tile.human_window ? finite(tile.human_window.cue_closes_at_s) : null;
  const closes = fromWindow ?? (hard === null ? null : Math.max(0, hard - CUE_MARGIN_S));
  if (closes === null) {
    return { state: "open", tone: "ok", text: "cue / question window open", short: "window open", detail: questionDetail(tile, spent) };
  }
  const left = closes - spent;
  if (left <= 0) {
    return {
      state: "closed",
      tone: "bad",
      text: "cue window closed: a cue no longer reaches the agent; only the x0.5 geocode remains",
      short: "cue window closed",
      detail: null,
    };
  }
  const closing = left < WINDOW_WARN_S;
  return {
    state: closing ? "closing" : "open",
    tone: closing ? "warn" : "ok",
    text: "cue / question window closes in " + fmtClock(left),
    short: "window closes in " + fmtClock(left),
    detail: questionDetail(tile, spent),
  };
}

/** "turn 7/30": the turns of the current conversation against the budget. */
export function turnText(tile) {
  if (!tile) return "";
  const turns = finite(tile.segment_turns) ?? finite(tile.turns) ?? 0;
  const max = tile.budget ? finite(tile.budget.max_turns) : null;
  return "turn " + fmtInt(turns) + (max !== null ? "/" + fmtInt(max) : "");
}

/**
 * Spend against the cap of this panorama: `{text: "$0.42 of $8.00", share, near}` or null when the
 * tile reports no spend. `near` above the share at which the inbox raises "Spend near cap".
 */
export function spendModel(tile) {
  const spend = tile ? finite(tile.spend_usd) : null;
  if (spend === null) return null;
  const cap = tile.budget ? finite(tile.budget.max_spend_usd) : null;
  if (cap === null || cap <= 0) return { text: fmtUsd(spend), share: null, near: false };
  const share = spend / cap;
  return { text: fmtUsd(spend) + " of " + fmtUsd(cap), share, near: !isFinal(tile) && share > SPEND_SHARE };
}

/**
 * Seconds since the panorama's last event, on the server's clock (`serverOffsetMs` is
 * store.state.serverOffsetMs). Null when the log has no event yet.
 */
export function eventAge(tile, nowMs, serverOffsetMs = 0) {
  if (!tile || !tile.last_event_ts) return null;
  const at = typeof tile.last_event_ts === "number"
    ? (tile.last_event_ts < 1e11 ? tile.last_event_ts * 1000 : tile.last_event_ts)
    : Date.parse(String(tile.last_event_ts));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, (nowMs + (finite(serverOffsetMs) ?? 0) - at) / 1000);
}

function ageWords(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return total < 60 ? total + " s" : fmtDuration(total);
}

/**
 * "Is it working?": the words beside the status badge.
 * Returns `{state, tone, text, stalled, hint}`; `stalled` after STALL_S of silence on a running tile.
 */
export function liveness(tile, nowMs, serverOffsetMs = 0, options) {
  const status = tileStatus(tile, options);
  if (status === "pending") return { state: "queued", tone: "dim", text: "waiting for a free slot", stalled: false, hint: null };
  // The clock beside it already reads "ended at 01:44": this says how.
  if (status === "done") return { state: "ended", tone: "dim", text: tile.stop_text ? String(tile.stop_text) : "ended", stalled: false, hint: null };
  if (status === "interrupted") return { state: "interrupted", tone: "warn", text: "no longer running", stalled: false, hint: null };
  if (status === "awaiting_mcq") return { state: "asking", tone: "attn", text: "waiting for your answer", stalled: false, hint: null };
  const age = eventAge(tile, nowMs, serverOffsetMs);
  if (age === null) return { state: "starting", tone: "dim", text: "no event yet", stalled: false, hint: null };
  if (age >= STALL_S) {
    return {
      state: "stalled",
      tone: "bad",
      text: "no event for " + ageWords(age),
      stalled: true,
      hint: "A long model call can be silent this long. If it lasts, look at the errors in the stream, or use Finalize now.",
    };
  }
  return { state: "alive", tone: "ok", text: "last event " + ageWords(age) + " ago", stalled: false, hint: null };
}

// ---------------------------------------------------------------- belief

/** The most probable hypothesis: `{index, label, probability, lat, lng}` or null. */
export function topHypothesis(tile) {
  let best = null;
  list(tile && tile.hypotheses).forEach((hyp, index) => {
    if (!hyp) return;
    const probability = finite(hyp.probability) ?? 0;
    if (!best || probability > best.probability) {
      best = { index, label: String(hyp.label || ""), probability, lat: finite(hyp.lat), lng: finite(hyp.lng) };
    }
  });
  return best;
}

/**
 * Rows of the hypothesis table, most probable first. `index` is the position in
 * `tile.hypotheses` (what the map and the MCQ options refer to); `key` follows a hypothesis
 * across updates so that an opened evidence stays with it.
 */
export function hypothesisRows(tile) {
  const seen = new Map();
  const rows = list(tile && tile.hypotheses).map((hyp, index) => {
    const source = hyp || {};
    const label = String(source.label || "");
    const coords = hasPoint(source) ? fmtLatLng(source.lat, source.lng) : "";
    const base = label + "|" + coords;
    const repeat = seen.get(base) || 0;
    seen.set(base, repeat + 1);
    const radius = finite(source.radius_m);
    return {
      key: repeat ? base + "|" + repeat : base,
      index,
      label: label || "(no label)",
      probability: finite(source.probability) ?? 0,
      probabilityText: fmtPct(finite(source.probability) ?? 0),
      radiusText: radius !== null && radius > 0 ? "± " + fmtDist(radius) : "–",
      evidence: String(source.evidence || ""),
      lat: finite(source.lat),
      lng: finite(source.lng),
      coords,
    };
  });
  return rows.sort((a, b) => b.probability - a.probability || a.index - b.index);
}

function proxyOf(tile) {
  const proxy = tile && tile.expected_score;
  if (!proxy || finite(proxy.value) === null || finite(proxy.max) === null) return null;
  const value = finite(proxy.value);
  const max = finite(proxy.max);
  const share = finite(proxy.share) ?? (max > 0 ? value / max : 0);
  return { value, max, share, text: fmtInt(value) + " of " + fmtInt(max) + " (" + fmtPct(share) + ")" };
}

/**
 * "How sure is it?": top probability, clusters, the distance between the top two, the
 * multi-modal flag with the gate's reason, and the expected-score proxy (the agent's own belief).
 */
export function confidence(tile) {
  const top = topHypothesis(tile);
  const count = list(tile && tile.hypotheses).length;
  if (!top) {
    return {
      hasBelief: false, topText: "no hypothesis yet", clustersText: null, gapText: null,
      multimodal: false, gateReason: tile && tile.gate_reason ? String(tile.gate_reason) : "", proxy: proxyOf(tile),
    };
  }
  const clusters = finite(tile.clusters) ?? 0;
  const gap = finite(tile.top_gap_m);
  let gapText = null;
  if (gap !== null) gapText = "top two " + fmtDist(gap) + " apart";
  else if (count === 1 || clusters === 1) gapText = "one place";
  return {
    hasBelief: true,
    topProbability: top.probability,
    topText: "top " + fmtPct(top.probability),
    clusters,
    clustersText: clusters > 0 ? plural(clusters, "cluster") : plural(count, "hypothesis", "hypotheses"),
    gapText,
    multimodal: Boolean(tile.multimodal),
    gateReason: tile.gate_reason ? String(tile.gate_reason) : "",
    proxy: proxyOf(tile),
  };
}

// ---------------------------------------------------------------- answer

const ORIGIN_WORDS = {
  agent: "agent",
  harness_fallback: "harness fallback",
  human_geocode: "human geocode",
};

/** An entry origin in words; an unknown one is shown as it is, underscores as spaces. */
export function originWords(origin) {
  if (!origin) return "";
  return ORIGIN_WORDS[origin] || String(origin).replace(/_/g, " ");
}

function rankRange(ranks) {
  const parts = [];
  let start = null;
  let previous = null;
  for (const rank of ranks) {
    if (start === null) start = rank;
    else if (rank !== previous + 1) {
      parts.push(start === previous ? String(start) : start + "–" + previous);
      start = rank;
    }
    previous = rank;
  }
  if (start !== null) parts.push(start === previous ? String(start) : start + "–" + previous);
  return parts.join(", ");
}

/**
 * The answer list: ten rows, or one line when they are the same point.
 * `{state: "final"|"provisional"|"stranded"|"none", title, stateText, entries, rows, identical,
 *   summary, groups, countProblem, originText, fallback, stopText, planText, copyAll, emptyText}`.
 * `stranded` is the last provisional list of an interrupted panorama: nothing will change it,
 * and it is not the answer until the exports are rebuilt.
 */
export function answerModel(tile, options) {
  const final = isFinal(tile);
  const entries = list(final ? tile.final : tile && tile.provisional).filter(hasPoint);
  const rows = entries.map((entry, i) => ({
    rank: finite(entry.rank) ?? i + 1,
    lat: finite(entry.lat),
    lng: finite(entry.lng),
    coords: fmtLatLng(entry.lat, entry.lng),
    multiplier: finite(entry.multiplier),
    multiplierText: finite(entry.multiplier) === null ? "–" : fmtMult(entry.multiplier),
    origin: entry.origin || null,
    originText: originWords(entry.origin),
  }));
  const groups = [];
  for (const row of rows) {
    let group = groups.find((g) => g.coords === row.coords);
    if (!group) {
      group = { coords: row.coords, lat: row.lat, lng: row.lng, ranks: [], count: 0 };
      groups.push(group);
    }
    group.ranks.push(row.rank);
    group.count += 1;
  }
  for (const group of groups) group.rankText = rankRange(group.ranks);
  const first = rows[0];
  const identical = rows.length > 0 && rows.every((row) =>
    row.coords === first.coords && row.multiplier === first.multiplier && row.origin === first.origin);
  const status = tileStatus(tile, options);
  const origin = final ? tile.origin || (first ? first.origin : null) : null;

  let emptyText = "";
  if (!rows.length) {
    if (status === "interrupted") emptyText = "No list was built before this panorama stopped. Rebuilding the exports writes the fallback point for its label.";
    else if (status === "pending") emptyText = "No answer yet: this panorama has not started.";
    else emptyText = "No answer yet: the list appears with the agent's first hypotheses.";
  }
  let state = "none";
  if (rows.length) state = final ? "final" : status === "interrupted" ? "stranded" : "provisional";
  const stateText = {
    final: "final",
    provisional: "provisional: can still change",
    stranded: "not final: rebuild the exports to keep it",
    none: "",
  }[state];
  return {
    state,
    title: final ? "Final answer" : state === "stranded" ? "Last provisional answer" : "Provisional answer",
    stateText,
    entries,
    rows,
    identical,
    summary: identical ? rows.length + " x " + first.coords : null,
    groups,
    countProblem: final && rows.length !== EXPECTED_ENTRIES
      ? plural(rows.length, "entry", "entries") + " in the final list; " + EXPECTED_ENTRIES + " are expected"
      : null,
    originText: originWords(origin),
    fallback: origin === "harness_fallback" || rows.some((row) => row.origin === "harness_fallback"),
    stopText: final || status === "interrupted" ? String((tile && tile.stop_text) || "") : "",
    // Without a list the server's plan reads "no answer yet", which the empty text already says.
    planText: rows.length ? String((tile && tile.plan_text) || "") : "",
    copyAll: rows.map((row) => row.coords).join("\n"),
    emptyText,
  };
}

/** The point the map marks as chosen: `tile.chosen` (contract A8), else entry 1 of the list. */
export function chosenPoint(tile) {
  if (tile && hasPoint(tile.chosen)) return { lat: finite(tile.chosen.lat), lng: finite(tile.chosen.lng) };
  const entries = list(isFinal(tile) ? tile.final : tile && tile.provisional);
  const first = entries.find(hasPoint);
  return first ? { lat: finite(first.lat), lng: finite(first.lng) } : null;
}

// ---------------------------------------------------------------- multiplier

const FACTOR_WORDS = { cue: "0.8 cue", mcq: "0.95 MCQ", geocode: "0.5 geocode" };

/**
 * "What did it cost me?": `{value, text: "x0.76", detail: "= 0.8 cue x 0.95 MCQ", full, brief, reduced}`.
 * The server's `ledger_text` is used when present; the same sentence is rebuilt from the ledger
 * for a tile that lacks it. `brief` counts the charges ("2 cues, 1 MCQ") for a board row, where
 * the written-out ledger of a much-helped panorama would not fit.
 */
export function multiplierModel(tile) {
  const value = tile && tile.penalty ? finite(tile.penalty.multiplier) ?? 1 : 1;
  const text = fmtMult(value);
  const ledger = list(tile && tile.ledger);
  let full = tile && typeof tile.ledger_text === "string" ? tile.ledger_text : "";
  if (!full) {
    full = ledger.length
      ? text + " = " + ledger.map((item) => FACTOR_WORDS[item && item.kind] || "?").join(" x ")
      : text + " (no penalties)";
  }
  const detail = full.startsWith(text) ? full.slice(text.length).trim() : full;
  const penalty = (tile && tile.penalty) || {};
  const counts = [
    [finite(penalty.cues), "cue", "cues"],
    [finite(penalty.mcqs), "MCQ", "MCQs"],
    [finite(penalty.human_geocodes), "geocode", "geocodes"],
  ];
  const brief = counts.filter(([n]) => n !== null && n > 0).map(([n, one, many]) => plural(n, one, many)).join(", ");
  return { value, text, detail, full, brief, reduced: value < 1 };
}

// ---------------------------------------------------------------- attention flags

const FLAG_LOOK = {
  mcq: { icon: "question", tone: "attn" },
  window: { icon: "clock", tone: "warn" },
  api: { icon: "alert", tone: "bad" },
  export: { icon: "file", tone: "bad" },
  fallback: { icon: "flag", tone: "warn" },
  spend: { icon: "alert", tone: "warn" },
  no_hypothesis: { icon: "search", tone: "warn" },
};

/**
 * One attention item (logic/attention.js) as a tile flag:
 * `{id, kind, icon, tone, title, detail, text, short, href}`. `short` is for a board row: the
 * title, with the time left for the two flags that run against a clock.
 */
export function flagModel(item) {
  const look = FLAG_LOOK[item.kind] || { icon: "info", tone: "warn" };
  const title = item.title || item.kind;
  const detail = item.detail || "";
  const left = finite(item.seconds_left);
  let short = title;
  if (item.kind === "mcq" && left !== null) short = "MCQ waiting: " + fmtCountdown(left) + " left";
  else if (item.kind === "window" && left !== null) short = left > 0 ? "Cue window shuts in " + fmtCountdown(left) : "Cue window closed";
  return {
    id: item.id,
    kind: item.kind,
    icon: look.icon,
    tone: look.tone,
    title,
    detail,
    text: detail ? title + ": " + detail : title,
    short,
    href: item.href,
  };
}

// ---------------------------------------------------------------- order of the grid

function labelRank(tile) {
  if (tile.special) return 0;
  return tile.label === "Urban" ? 1 : 2;
}

/**
 * What a review could still gain on a tile, by the agent's own belief: the maximum minus the
 * expected-score proxy. The Special One and low-confidence tiles come out highest (UI-SPEC 5.4).
 */
export function reviewGain(tile) {
  const proxy = proxyOf(tile);
  if (proxy) return Math.max(0, proxy.max - proxy.value);
  if (isFinal(tile)) return 0;
  return MAX_SCORE * (tile.special ? SPECIAL_FACTOR : 1);
}

/**
 * Order of the panorama grid. `sort: "default"`: Special One first, then Urban, then non-Urban.
 * `sort: "attention"`: tiles with an attention item first, most urgent first (`items` is the
 * sorted list from attentionItems), then the rest by what a review could still gain.
 * Stable; returns a new array.
 */
export function sortTiles(tiles, { sort = "default", items = [] } = {}) {
  const rows = list(tiles).map((tile, index) => ({ tile, index }));
  const base = (a, b) => labelRank(a.tile) - labelRank(b.tile) || a.index - b.index;
  if (sort !== "attention") return rows.sort(base).map((row) => row.tile);
  const urgency = new Map();
  list(items).forEach((item, position) => {
    if (!item || !item.panorama_id) return;
    const key = item.run_id + "\n" + item.panorama_id;
    if (!urgency.has(key)) urgency.set(key, position);
  });
  const rank = (row) => urgency.get(row.tile.run_id + "\n" + row.tile.panorama_id) ?? Infinity;
  return rows.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (ra === Infinity) {
      const gain = reviewGain(b.tile) - reviewGain(a.tile);
      if (gain) return gain;
    }
    return base(a, b);
  }).map((row) => row.tile);
}
