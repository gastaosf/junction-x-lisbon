// Replay of one panorama (UI-SPEC 5.6): where the scrubber's ticks and marks sit, what a step
// with a key lands on, what the page shows for a moment in the past, and when a running panorama's
// inspect payload is fetched again. Pure: everything is computed from the inspect payload
// (contract 4.4), a TileState and a cursor, so it can be tested with `node --test`.
//
// A cursor is the seq of an event, or null for "live": the latest state, with the controls. The
// last event of the log is the same moment as live, so a step or a drag that reaches it returns
// null and the page goes back to following the panorama.

import { fmtClock } from "../format.js";
import { eventAt, keyframeAt, truthAllowed, truthFor } from "./inspect.js";

export const REFRESH_GAP_MS = 4000; // a running panorama's inspect payload is refetched at most this often
export const SERIES_MAX = 8; // lines in the hypothesis chart; more than that cannot be told apart

const list = (value) => (Array.isArray(value) ? value : []);
const clamp01 = (value) => Math.min(1, Math.max(0, value));

// Number(null) is 0, which would read as "event zero": treat missing as missing.
function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const hasPoint = (thing) => Boolean(thing) && finite(thing.lat) !== null && finite(thing.lng) !== null;

// ---------------------------------------------------------------- the cursor in the URL

/** `?at=` as a cursor: a whole number of at most nine digits, else null (live). */
export function parseAt(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return /^\d{1,9}$/.test(text) ? Number(text) : null;
}

const OPENABLE = ["mcq", "cue", "geocode", "ack"];

/** `?open=` as the name of a control (contract A1), else null. */
export function parseOpen(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return OPENABLE.includes(name) ? name : null;
}

// ---------------------------------------------------------------- the timeline

const MARK_WORDS = {
  candidates_update: "hypotheses updated",
  final_submission: "final submission",
  soft_deadline_notice: "soft-deadline notice",
  human_cue: "cue sent",
  mcq_asked: "question asked",
  mcq_answered: "question answered",
  human_geocode: "human geocode",
  api_retry: "API retry",
  api_error: "API error",
  harness_error: "harness error",
};

const KIND_WORDS = {
  candidates: "hypotheses updated",
  human: "human interaction",
  soft_deadline: "soft-deadline notice",
  final: "final submission",
  error: "error",
};

export const MARK_KINDS = Object.keys(KIND_WORDS);

/** What a mark stands for, in words: by the event's type, else by the kind of mark. */
export function markLabel(entry) {
  if (!entry) return "";
  return MARK_WORDS[entry.type] || KIND_WORDS[entry.mark] || String(entry.mark || entry.type || "");
}

/** The words of the scrubber's legend for one kind of mark. */
export function kindLabel(kind) {
  return KIND_WORDS[kind] || String(kind || "");
}

/**
 * The scrubber's model of a run:
 *   {entries: [{seq, t, turn, segment, type, mark, pos}], axis: "time"|"events", span, first, last,
 *    turns: [{seq, pos, turn, segment}], marks: [{seq, pos, kind, type, label, t}], kinds: [kind]}
 * `pos` is the place on the track, 0 to 1. The track is the panorama's own clock when the log is
 * one conversation whose clock never goes backwards; after a retry the clock starts again
 * (contract A38), so the events are then spread evenly in the order they happened.
 */
export function timelineModel(inspect) {
  const entries = list(inspect && inspect.timeline)
    .filter((item) => item && finite(item.seq) !== null)
    .map((item) => ({
      seq: finite(item.seq),
      t: finite(item.t_rel_s),
      turn: finite(item.turn),
      segment: finite(item.segment) ?? 1,
      type: String(item.type || ""),
      mark: item.mark ? String(item.mark) : null,
      pos: 0,
    }))
    .sort((a, b) => a.seq - b.seq);
  const count = entries.length;
  let timed = count > 1 && entries.every((entry) => entry.t !== null && entry.segment === entries[0].segment);
  for (let i = 1; timed && i < count; i += 1) {
    if (entries[i].t < entries[i - 1].t) timed = false;
  }
  const span = timed ? entries[count - 1].t : Math.max(0, count - 1);
  if (timed && !(span > 0)) timed = false;
  entries.forEach((entry, index) => {
    if (timed) entry.pos = clamp01(entry.t / span);
    else entry.pos = count > 1 ? index / (count - 1) : 1;
  });

  // A turn starts with its request. A log without requests still has the turn of each event.
  let turns = entries.filter((entry) => entry.type === "model_request" && entry.turn !== null);
  if (!turns.length) {
    const seen = new Set();
    turns = entries.filter((entry) => {
      if (entry.turn === null) return false;
      const key = entry.segment + ":" + entry.turn;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const marks = entries.filter((entry) => entry.mark).map((entry) => ({
    seq: entry.seq,
    pos: entry.pos,
    kind: entry.mark,
    type: entry.type,
    label: markLabel(entry),
    t: entry.t,
  }));
  return {
    entries,
    axis: timed ? "time" : "events",
    span: timed ? span : Math.max(0, count - 1),
    first: count ? entries[0].seq : null,
    last: count ? entries[count - 1].seq : null,
    turns: turns.map((entry) => ({ seq: entry.seq, pos: entry.pos, turn: entry.turn, segment: entry.segment })),
    marks,
    kinds: MARK_KINDS.filter((kind) => marks.some((mark) => mark.kind === kind)),
  };
}

// Index of the last entry whose `key` is at or below `value`; -1 when there is none.
function lastAtOrBelow(entries, key, value) {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid][key] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The last event at or before the cursor; for a null cursor the last event. Null when none. */
export function entryAt(model, at) {
  const entries = model ? model.entries : [];
  if (!entries.length) return null;
  if (at === null || at === undefined) return entries[entries.length - 1];
  const index = lastAtOrBelow(entries, "seq", at);
  return index >= 0 ? entries[index] : null;
}

/**
 * A seq someone asked for as a cursor: null (live) at or past the last event, the first event for
 * anything before it. With no timeline yet the request is kept as it is.
 */
export function resolveCursor(model, seq) {
  const wanted = finite(seq);
  if (wanted === null) return null;
  if (!model || model.last === null) return Math.max(0, Math.round(wanted));
  if (wanted >= model.last) return null;
  return Math.max(model.first, Math.round(wanted));
}

/** Where the thumb sits: 0 to 1. Live is the right end. */
export function positionOf(model, at) {
  if (at === null || at === undefined) return 1;
  const entry = entryAt(model, at);
  return entry ? entry.pos : 0;
}

/**
 * The event a press at `fraction` of the track means: the state at that moment, so the last event
 * at or before it. A mark within `snap` (a fraction of the track) wins, so that a mark can be hit
 * without aiming at its exact pixel. Returns a seq, or null for an empty timeline.
 */
export function seqAtPosition(model, fraction, { snap = 0 } = {}) {
  const entries = model ? model.entries : [];
  if (!entries.length) return null;
  const at = clamp01(finite(fraction) ?? 0);
  if (snap > 0) {
    let best = null;
    for (const mark of model.marks) {
      const distance = Math.abs(mark.pos - at);
      if (distance <= snap && (best === null || distance < best.distance)) best = { distance, seq: mark.seq };
    }
    if (best) return best.seq;
  }
  // The small allowance keeps a press on the very end of the track on the last event.
  const index = lastAtOrBelow(entries, "pos", at + 1e-9);
  return entries[Math.max(0, index)].seq;
}

function step(seqs, model, at, direction) {
  if (!model || model.last === null) return at ?? null;
  if (direction > 0) {
    if (at === null || at === undefined) return null;
    const next = seqs.find((seq) => seq > at);
    return next === undefined ? null : resolveCursor(model, next);
  }
  const from = at === null || at === undefined ? model.last : at;
  let previous = null;
  for (const seq of seqs) {
    if (seq >= from) break;
    previous = seq;
  }
  // Before the first of them there is still the start of the run to go back to.
  if (previous === null) return from > model.first ? model.first : resolveCursor(model, from);
  return resolveCursor(model, previous);
}

/** One event back (-1) or on (+1). Stepping on from the last but one event is live (null). */
export function stepEvent(model, at, direction) {
  return step(model ? model.entries.map((entry) => entry.seq) : [], model, at, direction);
}

/** To the start of the previous (-1) or the next (+1) turn; past the last one is live (null). */
export function stepTurn(model, at, direction) {
  return step(model ? model.turns.map((turn) => turn.seq) : [], model, at, direction);
}

/** To the previous (-1) or the next (+1) mark; past the last one is live (null). */
export function stepMark(model, at, direction) {
  return step(model ? model.marks.map((mark) => mark.seq) : [], model, at, direction);
}

/** Whether a step in that direction would move: the scrubber's buttons are disabled otherwise. */
export function canStep(model, at, direction) {
  if (!model || model.last === null || model.entries.length < 2) return false;
  if (direction > 0) return at !== null && at !== undefined;
  const from = at === null || at === undefined ? model.last : at;
  return from > model.first;
}

/**
 * The cursor in words:
 *   {seq, index, total, clock, turn, type, markText, text: "02:14 · event 73 of 183 · turn 9"}
 * `index` counts the events up to the cursor. For a null cursor it describes the last event.
 */
export function describeCursor(model, at) {
  const total = model ? model.entries.length : 0;
  const entry = entryAt(model, at);
  if (!entry) {
    return { seq: at ?? null, index: 0, total, clock: null, turn: null, type: "", markText: "", text: total ? "before the first event" : "no events yet" };
  }
  const index = lastAtOrBelow(model.entries, "seq", entry.seq) + 1;
  let turn = entry.turn;
  for (let i = index - 1; turn === null && i >= 0; i -= 1) turn = model.entries[i].turn;
  const clock = entry.t !== null ? fmtClock(entry.t) : null;
  const parts = [];
  if (clock) parts.push(clock);
  parts.push("event " + index + " of " + total);
  if (turn !== null) parts.push("turn " + turn);
  return { seq: entry.seq, index, total, clock, turn, type: entry.type, markText: entry.mark ? markLabel(entry) : "", text: parts.join(" · ") };
}

/**
 * The line above the track. In replay it says so and names the moment; `running` tells whether
 * there is a live panorama for the controls to act on, `pending` that it has not started.
 *   {mode: "live"|"waiting"|"ended"|"replay", text, back}    `back` labels the button that removes `at`
 */
export function bannerModel(model, at, { running = false, pending = false } = {}) {
  if (at === null || at === undefined) {
    if (running) return { mode: "live", text: "Live: following this panorama as it runs. Drag the timeline to look back.", back: null };
    if (pending) return { mode: "waiting", text: "Waiting: this panorama has not started. The timeline fills in as it runs.", back: null };
    return { mode: "ended", text: "Latest state: this panorama is not running. Drag the timeline to replay it.", back: null };
  }
  const where = describeCursor(model, at);
  const moment = where.clock ? where.clock : "event #" + at;
  return running
    ? { mode: "replay", text: "Replay: showing the state at " + moment + ". Controls act on the live panorama.", back: "Back to live" }
    : { mode: "replay", text: "Replay: showing the state at " + moment + ". No control is shown while you look back.", back: "Back to the latest state" };
}

// ---------------------------------------------------------------- the state at a cursor

function sameList(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * A TileState for the moment `at`, built from what the page already holds: the nearest keyframe
 * of the inspect payload (hypotheses, lists, penalty, status) over the identity and budget of the
 * tile as it is now. It is what the page draws while the scrubber moves; fields a keyframe does
 * not carry (clusters, the question gate, the proxy) are left empty rather than guessed, and
 * `GET …/replay?at=` then gives the exact tile. `approximate: true` marks it.
 */
export function frameTile(base, inspect, at) {
  const source = base || {};
  const frame = keyframeAt(inspect, at);
  const event = eventAt(inspect, at);
  const cursor = finite(at) ?? Infinity;
  const hypotheses = frame ? list(frame.hypotheses) : [];
  const provisional = frame ? list(frame.provisional) : [];
  const final = frame && Array.isArray(frame.final) ? frame.final : null;
  const entries = (final || provisional).filter(hasPoint);
  const upTo = (items, key) => list(items).filter((item) => item && (finite(item[key]) ?? 0) <= cursor);
  const turns = list(inspect && inspect.turns);
  const asked = upTo(turns, "seq_request");
  const lastTurn = asked.length ? asked[asked.length - 1] : null;
  const answered = turns.filter((turn) => turn && finite(turn.seq_response) !== null && turn.seq_response <= cursor);
  const ledgerSource = list(inspect && inspect.ledger).length >= list(source.ledger).length ? list(inspect && inspect.ledger) : list(source.ledger);
  // The words for how it ended belong to the answer of record: only shown with that very list.
  const ended = final !== null && sameList(final, source.final);
  return {
    run_id: source.run_id,
    panorama_id: source.panorama_id,
    filename: source.filename,
    label: source.label,
    timestamp: source.timestamp,
    special: Boolean(source.special),
    image: source.image || null,
    budget: source.budget || null,
    model: source.model,
    effort: source.effort,
    human_enabled: source.human_enabled,
    max_mcq: source.max_mcq,
    approximate: true,
    status: frame ? String(frame.status || "pending") : "pending",
    active: false,
    live: false,
    hypotheses,
    provisional,
    final,
    penalty: frame && frame.penalty ? frame.penalty : { cues: 0, mcqs: 0, human_geocodes: 0, multiplier: 1 },
    ledger: upTo(ledgerSource, "seq"),
    pending_mcq: null,
    last_mcq: null,
    human_window: null,
    named_places: [],
    geocode_enabled: false,
    elapsed_s: event && event.t_rel_s !== null && event.t_rel_s !== undefined ? Number(event.t_rel_s) || 0 : 0,
    turns: asked.length,
    segment_turns: lastTurn ? finite(lastTurn.turn) ?? asked.length : 0,
    spend_usd: answered.reduce((sum, turn) => sum + (finite(turn.cost_usd) ?? 0), 0),
    cues: upTo(source.cues, "seq"),
    crops: upTo(source.crops, "seq_call"),
    origin: final && final[0] ? final[0].origin || null : null,
    stop_reason: ended ? source.stop_reason ?? null : null,
    stop_text: ended ? String(source.stop_text || "") : "",
    plan_text: ended ? String(source.plan_text || "") : "",
    clusters: 0,
    cluster_points: [],
    chosen: entries.length ? { lat: finite(entries[0].lat), lng: finite(entries[0].lng) } : null,
    top_gap_m: null,
    multimodal: false,
    gate_reason: "",
    expected_score: null,
    last_seq: finite(at),
    last_event_ts: null,
    last_event_t_rel_s: event ? finite(event.t_rel_s) : null,
    api_trouble: false,
    api_trouble_text: null,
    retryable: false,
    fallback_acknowledged: true,
    export_problems: null,
  };
}

/** The path of the top hypothesis up to the cursor (all of it when live), without repeats. */
export function pathUpTo(inspect, at) {
  const cursor = at === null || at === undefined ? Infinity : Number(at);
  const points = [];
  for (const item of list(inspect && inspect.series && inspect.series.top_path)) {
    if (!hasPoint(item) || (finite(item.seq) ?? 0) > cursor) continue;
    const point = { lat: finite(item.lat), lng: finite(item.lng) };
    const previous = points[points.length - 1];
    if (!previous || previous.lat !== point.lat || previous.lng !== point.lng) points.push(point);
  }
  return points;
}

// ---------------------------------------------------------------- hypothesis evolution

const CHART_MARKS = { soft_deadline: "soft deadline", final: "final" };
const HUMAN_MARKS = { human_cue: "cue", mcq_asked: "question", mcq_answered: "answer", human_geocode: "geocode" };

/**
 * The hypothesis chart: the probability of each hypothesis after every update, as steps (a belief
 * holds until the next update).
 *   {axis: "time"|"events", series: [{name, points: [[x, p|null]]}], marks: [{x, label, kind}],
 *    folded, xOf(seq) -> x|null, seqOf(x) -> seq|null, end}
 * At most `max` lines are drawn: first every hypothesis that was the agent's top one at some
 * moment, then those that ever weighed most; when there are more, the rest are summed into one
 * line named for how many it holds (`folded`). A hypothesis the agent dropped keeps its line up to
 * the update that dropped it. x is the panorama's clock in seconds, or the event number after a
 * retry (see timelineModel).
 */
export function beliefSeries(inspect, model, { max = SERIES_MAX } = {}) {
  const timeline = model || timelineModel(inspect);
  const timed = timeline.axis === "time";
  const labels = list(inspect && inspect.series && inspect.series.labels).map((label) => String(label));
  const points = list(inspect && inspect.series && inspect.series.points)
    .filter((point) => point && finite(point.seq) !== null)
    .sort((a, b) => a.seq - b.seq);
  const xOf = (seq) => {
    const wanted = finite(seq);
    if (wanted === null) return null;
    if (!timed) return wanted;
    const entry = entryAt(timeline, wanted);
    return entry ? entry.t : 0;
  };
  const seqOf = (x) => {
    const value = finite(x);
    if (value === null || timeline.last === null) return null;
    if (!timed) return Math.round(value);
    return seqAtPosition(timeline, timeline.span > 0 ? value / timeline.span : 1);
  };
  const share = (point, index) => finite(list(point.probabilities)[index]);

  const leaders = new Set();
  for (const point of points) {
    let top = -1;
    labels.forEach((_, index) => {
      const value = share(point, index);
      if (value !== null && (top < 0 || value > share(point, top))) top = index;
    });
    if (top >= 0) leaders.add(top);
  }
  const order = labels.map((name, index) => {
    let peak = 0;
    for (const point of points) peak = Math.max(peak, share(point, index) ?? 0);
    return { name, index, peak, led: leaders.has(index) };
  }).sort((a, b) => Number(b.led) - Number(a.led) || b.peak - a.peak || a.index - b.index);
  const limit = Math.max(1, max);
  const kept = order.length > limit ? order.slice(0, limit - 1) : order;
  const rest = order.length > limit ? order.slice(limit - 1) : [];
  // Shown in the order the agent first named them, so a line keeps its colour as others arrive.
  kept.sort((a, b) => a.index - b.index);

  const end = timeline.last === null ? null : xOf(timeline.last);
  const line = (valueOf) => {
    const out = [];
    let held = null;
    for (const point of points) {
      const x = xOf(point.seq);
      const value = valueOf(point);
      // A belief holds until the update that replaces it: the step is drawn up to there.
      if (value === null && held !== null) out.push([x, held]);
      out.push([x, value]);
      held = value;
    }
    // The last belief holds to the end of the run.
    if (out.length && held !== null && end !== null && end > out[out.length - 1][0]) out.push([end, held]);
    return out;
  };
  const series = kept.map((item) => ({ name: item.name, points: line((point) => share(point, item.index)) }));
  if (rest.length) {
    series.push({
      name: rest.length + " other hypotheses (summed)",
      points: line((point) => {
        let sum = null;
        for (const item of rest) {
          const value = share(point, item.index);
          if (value !== null) sum = (sum ?? 0) + value;
        }
        return sum === null ? null : Math.round(sum * 1e6) / 1e6;
      }),
    });
  }
  const marks = timeline.marks
    .filter((mark) => CHART_MARKS[mark.kind] || (mark.kind === "human" && HUMAN_MARKS[mark.type]))
    .map((mark) => ({ x: xOf(mark.seq), label: CHART_MARKS[mark.kind] || HUMAN_MARKS[mark.type], kind: mark.kind }));
  return { axis: timeline.axis, series: points.length ? series : [], marks, folded: rest.length, xOf, seqOf, end };
}

// ---------------------------------------------------------------- keeping a live run current

/**
 * Whether to fetch the inspect payload of a running panorama again, and if not now, how long to
 * wait. `loadedSeq` is the payload's last_seq, `askedSeq` the tile's last_seq when the last
 * request was started, `tileSeq` the tile's last_seq now.
 *   {load: bool, waitMs: number|null}      waitMs null: nothing to wait for
 * A payload behind the tile is fetched at most every `gapMs`; once the panorama is final it is
 * fetched once more straight away. A request is never repeated for a seq it already covered, so
 * a server whose payload stays behind is not asked in a loop.
 */
export function refreshPlan({ loadedSeq, askedSeq, tileSeq, final = false, loading = false, hidden = false, lastStartMs = 0, nowMs = 0, gapMs = REFRESH_GAP_MS }) {
  const now = finite(tileSeq);
  if (now === null) return { load: false, waitMs: null };
  const covered = Math.max(finite(loadedSeq) ?? -1, finite(askedSeq) ?? -1);
  if (now <= covered || loading || hidden) return { load: false, waitMs: null };
  if (final) return { load: true, waitMs: 0 };
  const waitMs = Math.max(0, (finite(lastStartMs) ?? 0) + gapMs - nowMs);
  return { load: waitMs === 0, waitMs };
}

// ---------------------------------------------------------------- around the panorama

/**
 * This panorama among those of its run, in the run's own order (Special One first):
 *   {ids, index, total, previous, next}     index is -1 for a panorama the run does not have
 */
export function neighbours(run, pid) {
  const ids = list(run && run.panoramas).map((tile) => tile && tile.panorama_id).filter((id) => id !== null && id !== undefined);
  const index = ids.indexOf(pid);
  return {
    ids,
    index,
    total: ids.length,
    previous: index > 0 ? ids[index - 1] : null,
    next: index >= 0 && index < ids.length - 1 ? ids[index + 1] : null,
  };
}

/**
 * The truth point of this panorama for the main map, or null. Stricter than the inspector's own
 * guard: the run must be known to be an evaluation run with human channels off (UI-SPEC 3: truth
 * never meets a human channel), and the server must have handed the truth over.
 *   {lat, lng} | null
 */
export function truthPoint(truth, run, tile, pid) {
  if (!run || run.kind !== "eval" || run.no_human !== true) return null;
  if (!truthAllowed(run, tile)) return null;
  const entry = truthFor(truth, pid);
  return hasPoint(entry) ? { lat: finite(entry.lat), lng: finite(entry.lng) } : null;
}
