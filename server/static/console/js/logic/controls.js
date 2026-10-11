// Decision logic of the operator controls (UI-SPEC 3 and 5.5). Pure: no DOM, no network, so the
// rules that decide whether a click may cost score are tested with `node --test`.
//
// The server stays authoritative for penalties, lint, deadlines and validation. What is decided
// here is only what the page offers: which control is enabled and the reason shown when it is
// not, what a confirmation says, and when an open confirmation no longer applies.

import { fmtClock, fmtCountdown, fmtMult } from "../format.js";
import { isTicking } from "./reduce.js";

/** The factor each human channel multiplies a panorama's score by (SPEC 8). */
export const FACTOR = { mcq: 0.95, cue: 0.8, geocode: 0.5 };
export const LAST_MCQ_LINGER_S = 20; // a closed question stays on screen this long (A3)
export const DEFAULT_CUE_MAX_CHARS = 1000;
export const CUE_MIN_REMAINING_S = 30; // the server refuses a cue this close to the hard deadline
export const CUE_WINDOW_WARN_S = 120; // the drawer counts the window down from here
export const MCQ_WARN_S = 30;
export const MCQ_URGENT_S = 15;

export const TEXT = {
  autonomous: "Autonomous: human channels disabled",
  loading: "Loading this panorama.",
  disconnected:
    "The event stream is down, so this page may be out of date. Controls that charge a penalty come back when it reconnects.",
  interrupted: "The server stopped while this panorama was running, so nothing can be sent to its agent.",
  notLive: "This panorama is not running in this server, so nothing can be sent to its agent.",
  cueFinal: "The answer is final, so a cue can no longer reach the agent.",
  cueWindow: "Too late for a cue: fewer than 30 s remain before the hard deadline, so the agent could not act on it.",
  cueEmpty: "Type the cue first.",
  cueUnresolved:
    "The last cue may or may not have reached the server. Retry it (it is not charged twice) or dismiss it first.",
  geocodeDone: "A human geocode is already recorded for this panorama.",
  geocodeNoPlace: "Waits until the agent names a place: a geocode is only allowed for a place it has named (rule R8).",
  geocodeChoosePlace: "Choose the place from the agent's list.",
  geocodePlaceGone: "The agent no longer names that place. Choose again from its list.",
  geocodeNoPin: "Click the map to place the pin, or enter both coordinates.",
  geocodeBadLat: "Latitude must be a number between -90 and 90, written with a decimal point (38.716900).",
  geocodeBadLng: "Longitude must be a number between -180 and 180, written with a decimal point (-9.139900).",
  mcqExpired: "Time is up. No answer can be sent; the agent proceeds.",
  mcqSending: "Sending your answer. The options are locked until the server replies.",
  mcqUnresolved:
    "It is not known whether your answer arrived. Retry it below (same request), or dismiss it to choose again.",
  mcqSent: "Answer sent. Waiting for the agent to pick it up.",
  mcqTimeout: "No answer sent; the agent proceeds.",
  mcqReleased: "No answer sent: the panorama became final while the question was open.",
  mcqCharged: "Already charged: x0.95 applied when the agent asked. Answering costs nothing more.",
  finalizeDone: "Already final.",
  toggleHelp: "Switch this off and the agent's next question is refused at no cost.",
  toggleOff: "Off: the agent's next question is refused at no cost.",
  exportEmpty: "Nothing to export yet: this panorama has not written an event.",
  ackNotLive: "This run is not held by this server, so the acknowledgement cannot be recorded.",
  retrySame: "Retry (same request, not charged twice)",
  cueRule:
    "A cue costs x0.8. Describe visual features only: no place, street, landmark, country, region, road or " +
    "language name, and no coordinates. The lint is a backstop, not a guarantee: you answer for rule R6. " +
    "A cue only reaches the agent while this panorama is still running, and not in its last 30 s.",
  cueReminder:
    "Rule R6: a cue may describe visual features only. No place, street, landmark, country, region, road or " +
    "language name, and no coordinates. The lint is a backstop, not a guarantee: you answer for this rule.",
  geocodeRule:
    "Costs x0.5. Your point becomes all ten entries of the answer and this panorama ends at once. " +
    "Only for a place the agent itself has named (rule R8): the place is chosen from its list, never typed.",
};

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

// ---------------------------------------------------------------- tile facts

/** True when a session of this server process is behind the tile, so an action can reach it. */
export function isLive(tile) {
  return Boolean(tile) && tile.live !== false && tile.status !== "interrupted";
}

export function isFinal(tile) {
  return Boolean(tile) && ((tile.final !== null && tile.final !== undefined) || tile.status === "done");
}

export function humanEnabled(tile) {
  return Boolean(tile) && tile.human_enabled !== false;
}

function notLiveReason(tile) {
  return tile.status === "interrupted" ? TEXT.interrupted : TEXT.notLive;
}

export function multiplierNow(tile) {
  const value = tile && tile.penalty ? finite(tile.penalty.multiplier) : null;
  return value === null ? 1 : value;
}

/** The multiplier after one more cue or geocode: the server's number, else the factor applied here. */
export function multiplierAfter(tile, kind) {
  const told = tile && tile.multiplier_after ? finite(tile.multiplier_after[kind]) : null;
  return told === null ? multiplierNow(tile) * FACTOR[kind] : told;
}

export function multiplierLine(tile, kind) {
  return fmtMult(multiplierNow(tile)) + " now, " + fmtMult(multiplierAfter(tile, kind)) + " after";
}

export function cueMaxChars(run) {
  const told = run ? finite(run.cue_max_chars) : null;
  return told !== null && told > 0 ? told : DEFAULT_CUE_MAX_CHARS;
}

// ---------------------------------------------------------------- cue

/** Seconds until a cue can no longer be sent, or null when the tile has no deadline. */
export function cueClosesIn(tile, elapsed) {
  if (!tile) return null;
  const window = tile.human_window ? finite(tile.human_window.cue_closes_at_s) : null;
  const hard = tile.budget ? finite(tile.budget.hard_deadline_s) : null;
  const closesAt = window !== null ? window : hard !== null ? Math.max(0, hard - CUE_MIN_REMAINING_S) : null;
  if (closesAt === null) return null;
  return closesAt - (finite(elapsed) ?? finite(tile.elapsed_s) ?? 0);
}

/**
 * Whether the cue control is offered. `ctx` is `{connected, elapsed}` with `elapsed` the tile's
 * locally ticking clock. Returns `{rendered, enabled, code, reason, closesIn, maxChars}`.
 */
export function cueState(tile, run, ctx = {}) {
  const base = { rendered: false, enabled: false, code: "loading", reason: TEXT.loading, closesIn: null, maxChars: cueMaxChars(run) };
  if (!tile) return base;
  if (!humanEnabled(tile)) return { ...base, code: "autonomous", reason: TEXT.autonomous };
  const closesIn = cueClosesIn(tile, ctx.elapsed);
  const shown = { ...base, rendered: true, closesIn };
  if (!isLive(tile)) return { ...shown, code: "not_live", reason: notLiveReason(tile) };
  if (isFinal(tile)) return { ...shown, code: "final", reason: TEXT.cueFinal, closesIn: null };
  if (ctx.connected === false) return { ...shown, code: "disconnected", reason: TEXT.disconnected };
  if (closesIn !== null && closesIn <= 0) return { ...shown, code: "window", reason: TEXT.cueWindow };
  return { ...shown, enabled: true, code: null, reason: "" };
}

/** "Cue window closes in 0:47" while it is close, else "". */
export function cueWindowLine(state) {
  if (!state || !state.enabled || state.closesIn === null || state.closesIn > CUE_WINDOW_WARN_S) return "";
  return "Cue window closes in " + fmtCountdown(state.closesIn);
}

/**
 * The draft as the server will count it: stripped, in code points (Python's `len`), so the
 * number shown is the number the server compares with the limit.
 */
export function cueDraft(text, maxChars = DEFAULT_CUE_MAX_CHARS) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const count = Array.from(trimmed).length;
  return {
    text: trimmed,
    count,
    max: maxChars,
    empty: count === 0,
    over: Math.max(0, count - maxChars),
    label: count + " / " + maxChars,
  };
}

/** Whether "Send cue" can be pressed: `{enabled, reason}`. The server decides length and lint. */
export function cueSendState(state, draft, { busy = false, unresolved = false } = {}) {
  if (!state.enabled) return { enabled: false, reason: state.reason };
  if (unresolved) return { enabled: false, reason: TEXT.cueUnresolved };
  if (busy) return { enabled: false, reason: "" };
  if (draft.empty) return { enabled: false, reason: TEXT.cueEmpty };
  return { enabled: true, reason: "" };
}

/** What the page says about a cue that was sent, from `tile.cues[i]`. */
export function cueLine(cue, index) {
  const head = "Cue " + (index + 1) + " (" + (finite(cue.char_count) ?? "?") + " characters, sent at " + fmtClock(cue.t_rel_s) + ")";
  if (cue.state === "delivered") {
    const turn = finite(cue.delivered_turn);
    return {
      state: "delivered",
      tone: "ok",
      icon: "check",
      label: "delivered",
      text: head + ": delivered at " + fmtClock(cue.delivered_t_rel_s) + (turn !== null ? " (turn " + turn + ")" : ""),
    };
  }
  if (cue.state === "undelivered") {
    return {
      state: "undelivered",
      tone: "bad",
      icon: "alert",
      label: "charged, undelivered",
      text: head + ": charged x0.8 and undelivered. The panorama ended before the agent's next turn.",
    };
  }
  return {
    state: "queued",
    tone: "info",
    icon: "clock",
    label: "queued",
    text: head + ": queued; delivered at the agent's next turn",
  };
}

/** A sentence for a check verdict that is not a lint failure ("empty", "too_late", ...). */
export function checkSentence(verdict) {
  const problem = Array.isArray(verdict.problems) && verdict.problems.length ? String(verdict.problems[0]) : "the server refused it";
  return "This cue cannot be sent: " + problem + ". Nothing was charged.";
}

/** The lint's findings as rows for the list: the offending word when the server located one. */
export function lintItems(problems, matches) {
  const list = Array.isArray(problems) ? problems.map(String) : [];
  const found = Array.isArray(matches) ? matches.filter((m) => m && typeof m.word === "string") : [];
  if (found.length && found.length === list.length) {
    return found.map((m) => ({ category: String(m.category || "location reference"), word: m.word, text: null }));
  }
  return list.map((text) => ({ category: null, word: null, text }));
}

/**
 * The checked text cut into plain and marked runs for the read-only mirror. Offsets are code
 * points into the stripped text, as the server computed them; overlapping, unsorted and unlocated
 * matches are tolerated.
 */
export function lintSegments(text, matches) {
  const points = Array.from(typeof text === "string" ? text : "");
  const marked = new Array(points.length).fill(false);
  for (const match of Array.isArray(matches) ? matches : []) {
    if (!match) continue;
    const start = finite(match.start);
    const end = finite(match.end);
    if (start === null || end === null) continue;
    for (let i = Math.max(0, Math.floor(start)); i < Math.min(points.length, Math.ceil(end)); i += 1) marked[i] = true;
  }
  const segments = [];
  for (let i = 0; i < points.length; i += 1) {
    const last = segments[segments.length - 1];
    if (last && last.mark === marked[i]) last.text += points[i];
    else segments.push({ text: points[i], mark: marked[i] });
  }
  return segments;
}

// ---------------------------------------------------------------- geocode

/** Whether the last-resort geocode is offered: `{rendered, enabled, code, reason}`. */
export function geocodeState(tile, ctx = {}) {
  const base = { rendered: false, enabled: false, code: "loading", reason: TEXT.loading };
  if (!tile) return base;
  if (!humanEnabled(tile)) return { ...base, code: "autonomous", reason: TEXT.autonomous };
  const shown = { ...base, rendered: true };
  if (!isLive(tile)) return { ...shown, code: "not_live", reason: notLiveReason(tile) };
  const charged = tile.penalty ? finite(tile.penalty.human_geocodes) || 0 : 0;
  if (charged > 0 || tile.origin === "human_geocode") return { ...shown, code: "done", reason: TEXT.geocodeDone };
  const places = Array.isArray(tile.named_places) ? tile.named_places : [];
  if (!tile.geocode_enabled || !places.length) return { ...shown, code: "no_place", reason: TEXT.geocodeNoPlace };
  if (ctx.connected === false) return { ...shown, code: "disconnected", reason: TEXT.disconnected };
  return { ...shown, enabled: true, code: null, reason: "" };
}

/** A typed coordinate as a number within +/-limit, else null. */
export function parseCoordinate(value, limit) {
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
  const text = String(value ?? "").trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

export const roundCoordinate = (value) => Number(Number(value).toFixed(6));

/**
 * A pasted "38.716900, -9.139900" (the form this console and most maps copy) as `{lat, lng}`,
 * else null. A bare comma only separates two numbers that each carry a decimal point, so a
 * comma-decimal "38,71" is never read as latitude 38, longitude 71.
 */
export function parseCoordinatePair(text) {
  const value = String(text ?? "").trim();
  let parts = value.split(/\s*;\s*|\s*,\s+|\s+/);
  if (parts.length !== 2 && /^[^,]*\.[^,]*,[^,]*\.[^,]*$/.test(value)) parts = value.split(",");
  if (parts.length !== 2) return null;
  const lat = parseCoordinate(parts[0], 90);
  const lng = parseCoordinate(parts[1], 180);
  return lat === null || lng === null ? null : { lat: roundCoordinate(lat), lng: roundCoordinate(lng) };
}

/** Great-circle distance in metres between two `{lat, lng}` points, or null. */
export function distanceM(a, b) {
  const numbers = [a && a.lat, a && a.lng, b && b.lat, b && b.lng].map(finite);
  if (numbers.includes(null)) return null;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The agent's hypothesis that carries the chosen place name, or null. */
export function hypothesisForPlace(tile, place) {
  const name = String(place ?? "").trim();
  if (!name || !tile || !Array.isArray(tile.hypotheses)) return null;
  return tile.hypotheses.find((h) => h && String(h.label ?? "").trim() === name) || null;
}

/**
 * The geocode form: `{ready, reason, point, place}`. `place` must be one of the agent's own
 * names (R8: chosen, never typed), and both coordinates must be numbers in range.
 */
export function geocodeForm({ place, places, lat, lng }) {
  const list = Array.isArray(places) ? places : [];
  const none = { ready: false, point: null, place: null };
  const latitude = parseCoordinate(lat, 90);
  const longitude = parseCoordinate(lng, 180);
  const blank = (value) => value === null || value === undefined || String(value).trim() === "";
  const point = latitude !== null && longitude !== null
    ? { lat: roundCoordinate(latitude), lng: roundCoordinate(longitude) }
    : null;
  if (!place) return { ...none, point, reason: TEXT.geocodeChoosePlace };
  if (!list.includes(place)) return { ...none, point, reason: TEXT.geocodePlaceGone };
  if (blank(lat) && blank(lng)) return { ...none, reason: TEXT.geocodeNoPin };
  if (latitude === null) return { ...none, reason: blank(lat) ? TEXT.geocodeNoPin : TEXT.geocodeBadLat };
  if (longitude === null) return { ...none, reason: blank(lng) ? TEXT.geocodeNoPin : TEXT.geocodeBadLng };
  return { ready: true, reason: "", point, place };
}

// ---------------------------------------------------------------- MCQ

export const optionLetter = (index) => String.fromCharCode(65 + index);

/** The option a key selects ("a".."d", either case), or null. Never sends anything. */
export function optionIndexForKey(key, count) {
  if (typeof key !== "string" || key.length !== 1) return null;
  const index = key.toLowerCase().charCodeAt(0) - 97;
  return index >= 0 && index < Math.min(4, count) ? index : null;
}

/** The countdown ring: `{known, seconds, text, fraction, level}`; level is ok, warn or urgent. */
export function mcqCountdown(remaining, timeout) {
  const left = finite(remaining);
  if (left === null) return { known: false, seconds: null, text: "–", fraction: 1, level: "ok" };
  const total = finite(timeout) && timeout > 0 ? timeout : 90;
  const seconds = Math.max(0, Math.ceil(left));
  return {
    known: true,
    seconds,
    text: fmtCountdown(left),
    fraction: Math.max(0, Math.min(1, left / total)),
    level: left <= MCQ_URGENT_S ? "urgent" : left <= MCQ_WARN_S ? "warn" : "ok",
  };
}

function mcqOptions(options, places) {
  return (Array.isArray(options) ? options : []).slice(0, 4).map((text, index) => {
    const place = Array.isArray(places) ? places[index] : null;
    const located = place && finite(place.lat) !== null && finite(place.lng) !== null;
    return {
      index,
      letter: optionLetter(index),
      text: String(text),
      place: located
        ? { index: finite(place.index), label: String(place.label ?? ""), lat: place.lat, lng: place.lng }
        : null,
    };
  });
}

/**
 * Seconds a closed question still has on screen. `closedAtMs` is when this page saw it close;
 * a page that was opened afterwards only has the panorama's own clock, which runs while it does.
 */
export function lingerLeft(tile, { nowMs, closedAtMs, elapsed } = {}) {
  const last = tile ? tile.last_mcq : null;
  if (!last || tile.pending_mcq) return 0;
  if (typeof closedAtMs === "number") return Math.max(0, LAST_MCQ_LINGER_S - (nowMs - closedAtMs) / 1000);
  const closedAt = finite(last.t_rel_s);
  const now = finite(elapsed);
  if (!isTicking(tile) || closedAt === null || now === null || now < closedAt) return 0;
  return Math.max(0, LAST_MCQ_LINGER_S - (now - closedAt));
}

/** What the panel says once a question has closed. `sent` is `{id, index}` when this tab answered. */
export function mcqOutcome(last, { sent = null, seenPendingId = null } = {}) {
  const index = finite(last.selected_index);
  const options = Array.isArray(last.options) ? last.options : [];
  const chosen = index !== null ? optionLetter(index) + (options[index] !== undefined ? ": " + options[index] : "") : null;
  if (last.outcome === "answered" && chosen !== null) {
    const mine = sent && sent.id === last.id && sent.index === index;
    if (mine) return { tone: "ok", icon: "check", text: "Answer sent (" + chosen + "). The agent continues with it." };
    if (seenPendingId === last.id) {
      return { tone: "info", icon: "info", text: "Answered from another tab (" + chosen + "). Nothing more to do here." };
    }
    return { tone: "info", icon: "info", text: "Answered (" + chosen + ")." };
  }
  if (last.outcome === "released") return { tone: "warn", icon: "info", text: TEXT.mcqReleased };
  return { tone: "warn", icon: "clock", text: TEXT.mcqTimeout };
}

/**
 * The MCQ panel's whole state. `ctx`: `{connected, remaining, nowMs, closedAtMs, elapsed, sent,
 * sending, unresolved, seenPendingId}`. mode "pending" while the agent waits, "result" for 20 s
 * afterwards, else "hidden". Buttons are only `enabled` while an answer can still reach the agent.
 */
export function mcqView(tile, ctx = {}) {
  if (!tile || !humanEnabled(tile)) return { mode: "hidden" };
  const mcq = tile.pending_mcq;
  if (mcq && isLive(tile)) {
    const countdown = mcqCountdown(ctx.remaining, mcq.timeout_s);
    const sentIndex = ctx.sent && ctx.sent.id === String(mcq.id) ? ctx.sent.index : null;
    let reason = "";
    if (sentIndex !== null) reason = ctx.sending ? TEXT.mcqSending : ctx.unresolved ? TEXT.mcqUnresolved : TEXT.mcqSent;
    else if (countdown.known && countdown.seconds <= 0) reason = TEXT.mcqExpired;
    else if (ctx.connected === false) reason = TEXT.disconnected;
    return {
      mode: "pending",
      id: String(mcq.id),
      question: String(mcq.question ?? ""),
      why: String(mcq.why_it_matters ?? ""),
      options: mcqOptions(mcq.options, mcq.option_places),
      countdown,
      enabled: reason === "",
      reason,
      markedIndex: sentIndex,
    };
  }
  const last = tile.last_mcq;
  if (last && lingerLeft(tile, ctx) > 0) {
    return {
      mode: "result",
      id: String(last.id),
      question: String(last.question ?? ""),
      why: "",
      options: mcqOptions(last.options, null),
      countdown: null,
      enabled: false,
      reason: "",
      markedIndex: last.outcome === "answered" ? finite(last.selected_index) : null,
      outcome: mcqOutcome(last, ctx),
    };
  }
  return { mode: "hidden" };
}

// ---------------------------------------------------------------- harness controls

/** "Finalize now": `{rendered, enabled, reason, warning}`. Not offered once the answer is final. */
export function finalizeState(tile) {
  if (!tile) return { rendered: false, enabled: false, reason: TEXT.loading, warning: "" };
  if (isFinal(tile)) return { rendered: false, enabled: false, reason: TEXT.finalizeDone, warning: "" };
  if (!isLive(tile)) return { rendered: true, enabled: false, reason: notLiveReason(tile), warning: "" };
  const empty = !(Array.isArray(tile.hypotheses) && tile.hypotheses.length) &&
    !(Array.isArray(tile.provisional) && tile.provisional.length);
  return {
    rendered: true,
    enabled: true,
    reason: "",
    warning: empty ? "The agent has no hypothesis yet: the answer would be the harness fallback point." : "",
  };
}

export function retryState(tile) {
  return { rendered: Boolean(tile) && tile.retryable === true && isLive(tile) };
}

export function exportState(tile) {
  const written = tile ? finite(tile.last_seq) || 0 : 0;
  return written > 0 ? { enabled: true, reason: "" } : { enabled: false, reason: tile ? TEXT.exportEmpty : TEXT.loading };
}

/**
 * The "questions allowed" switch: `{rendered, checked, count, help}`. It is a harness control
 * (nothing reaches the agent), offered only while the agent could still ask.
 */
export function toggleState(tile) {
  if (!tile || !humanEnabled(tile) || !isLive(tile) || isFinal(tile)) {
    return { rendered: false, checked: false, count: "", help: "" };
  }
  const left = finite(tile.mcqs_left);
  const max = finite(tile.max_mcq);
  const checked = tile.mcq_allowed !== false;
  return {
    rendered: true,
    checked,
    count: left !== null && max !== null ? left + " of " + max + " left" : "",
    help: checked ? TEXT.toggleHelp : TEXT.toggleOff,
  };
}

export function hasFallback(tile) {
  if (!tile) return false;
  if (tile.origin === "harness_fallback") return true;
  return Array.isArray(tile.final) && tile.final.some((entry) => entry && entry.origin === "harness_fallback");
}

/** The fallback acknowledgement: shown for a final answer the harness, not the agent, produced. */
export function ackState(tile) {
  if (!tile || !isFinal(tile) || !hasFallback(tile)) return { rendered: false, acknowledged: false, enabled: false, reason: "", text: "" };
  const why = tile.stop_text ? " (" + tile.stop_text + ")" : "";
  const acknowledged = tile.fallback_acknowledged === true;
  return {
    rendered: true,
    acknowledged,
    enabled: !acknowledged && tile.live !== false,
    reason: !acknowledged && tile.live === false ? TEXT.ackNotLive : "",
    text: acknowledged
      ? "Fallback answer acknowledged" + why + "."
      : "Fallback answer: the harness, not the agent, produced this list" + why + ". Check it before you submit.",
  };
}

/** Reasons of disabled controls, one row per distinct sentence: [{labels: ["Cue", "Geocode"], reason}]. */
export function groupReasons(rows) {
  const groups = [];
  for (const row of rows) {
    if (!row || !row.reason) continue;
    const held = groups.find((group) => group.reason === row.reason);
    if (held) held.labels.push(row.label);
    else groups.push({ labels: [row.label], reason: row.reason });
  }
  return groups;
}

// ---------------------------------------------------------------- confirmations

/** What a confirmation was opened against; compared with the tile on every change (A3). */
export function dialogSnapshot(tile, extra = {}) {
  const penalty = (tile && tile.penalty) || {};
  return {
    multiplier: multiplierNow(tile),
    cues: finite(penalty.cues) || 0,
    geocodes: finite(penalty.human_geocodes) || 0,
    final: isFinal(tile),
    retryable: Boolean(tile) && tile.retryable === true,
    ...extra,
  };
}

/**
 * Why an open confirmation no longer applies, or null while it does. `kind`: "cue", "geocode",
 * "finalize" or "retry". `ctx`: `{connected, elapsed}`.
 */
export function dialogLock(kind, opened, tile, ctx = {}) {
  const penalised = kind === "cue" || kind === "geocode";
  if (!tile) return "This panorama is no longer on the page. Nothing was sent.";
  if (!isLive(tile)) return notLiveReason(tile) + " Nothing was sent.";
  const penalty = tile.penalty || {};
  if (kind === "cue") {
    if ((finite(penalty.cues) || 0) > opened.cues) {
      return "Already sent by another tab: a cue was charged on this panorama while this was open. Close this and check the cues sent.";
    }
    if (isFinal(tile)) return "The panorama became final while this was open, so a cue can no longer reach the agent. Nothing was sent.";
    const closesIn = cueClosesIn(tile, ctx.elapsed);
    if (closesIn !== null && closesIn <= 0) return TEXT.cueWindow + " Nothing was sent.";
  }
  if (kind === "geocode") {
    if ((finite(penalty.human_geocodes) || 0) > opened.geocodes || tile.origin === "human_geocode") {
      return "Already sent by another tab: a human geocode is recorded for this panorama. Nothing more was charged.";
    }
    const places = Array.isArray(tile.named_places) ? tile.named_places : [];
    if (!tile.geocode_enabled || (opened.place && !places.includes(opened.place))) {
      return "The agent no longer names this place, so the geocode does not apply. Nothing was sent.";
    }
    if (isFinal(tile) && !opened.final) {
      return "The panorama became final while this was open. Look at its final answer, then open the geocode again if you still want it.";
    }
  }
  if (kind === "finalize" && isFinal(tile)) return "This panorama is already final. Nothing was changed by this dialog.";
  if (kind === "retry" && tile.retryable !== true) return "This panorama can no longer be retried. Nothing was started.";
  if (penalised) {
    if (ctx.connected === false) {
      return "The event stream dropped, so this page may be out of date. Close this and try again once it is back.";
    }
    if (Math.abs(multiplierNow(tile) - opened.multiplier) > 1e-9) {
      return "The multiplier changed while this was open (" + fmtMult(opened.multiplier) + " to " + fmtMult(multiplierNow(tile)) +
        "), so the numbers above are out of date. Close this and open it again.";
    }
  }
  return null;
}

// ---------------------------------------------------------------- failures

const sentence = (text) => {
  const value = String(text ?? "").trim();
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
};

/**
 * A failed request in the operator's words. `err` is an ApiError-shaped object
 * (`{status, message, problems, lint, detail, code}`). Returns `{kind, title, message, note,
 * problems, matches, retry, status, code}`. `note` is what to add to the server's own message;
 * `retry` is true when the outcome is unknown and the same request (same idempotency key) may be
 * sent again without being charged twice.
 */
export function describeFailure(err) {
  const status = Number(err && err.status) || 0;
  const code = err && err.code ? String(err.code) : "";
  const message = sentence(err && err.message ? err.message : "The request failed.");
  const detail = err && err.detail && typeof err.detail === "object" ? err.detail : {};
  const lint = err && err.lint && typeof err.lint === "object" ? err.lint : null;
  const lintProblems = lint && Array.isArray(lint.problems) ? lint.problems.map(String) : [];
  const problems = lintProblems.length ? lintProblems : Array.isArray(err && err.problems) ? err.problems.map(String) : [];
  const matches = Array.isArray(detail.matches) ? detail.matches : [];
  const base = { status, code, message, note: "", problems, matches, retry: false };
  if (status === 0) {
    return {
      ...base,
      kind: "network",
      title: "No answer from the server",
      note: "It is not known whether the request arrived. Retrying sends the same request again: if the first one arrived, nothing is charged twice.",
      retry: true,
    };
  }
  if (status === 403) return { ...base, kind: "disabled", title: "Channel disabled" };
  if (status === 409) return { ...base, kind: "conflict", title: "No longer applies" };
  if (status === 422 && (lintProblems.length || code === "cue_lint")) {
    return { ...base, kind: "lint", title: "Blocked by the lint: nothing was sent or charged" };
  }
  if (code === "idempotency_key_reuse") {
    return { ...base, kind: "invalid", title: "Not sent", note: "The request changed after it was first sent. Dismiss this and send it again." };
  }
  if (status >= 500) {
    return {
      ...base,
      kind: "server",
      title: "The server failed",
      note: "Retrying sends the same request again and is not charged twice.",
      retry: true,
    };
  }
  if (status === 404) return { ...base, kind: "missing", title: "Not found" };
  return { ...base, kind: "invalid", title: "Rejected by the server" };
}
