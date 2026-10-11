import test from "node:test";
import assert from "node:assert/strict";

import {
  MARK_KINDS,
  REFRESH_GAP_MS,
  bannerModel,
  beliefSeries,
  canStep,
  describeCursor,
  entryAt,
  frameTile,
  kindLabel,
  markLabel,
  neighbours,
  parseAt,
  parseOpen,
  pathUpTo,
  positionOf,
  refreshPlan,
  resolveCursor,
  seqAtPosition,
  stepEvent,
  stepMark,
  stepTurn,
  timelineModel,
  truthPoint,
} from "../../server/static/console/js/logic/replay.js";

// One conversation of three turns: hypotheses at 5 and 9, a question at 7 and 8, the soft
// deadline at 10, the answer at 12 and the end of the run at 13.
function inspectPayload() {
  const event = (seq, t, type, turn, mark = null) => ({ seq, t_rel_s: t, segment: 1, type, turn, mark });
  return {
    last_seq: 13,
    segments: 1,
    timeline: [
      event(1, 0, "run_start", null),
      event(2, 1, "model_request", 1),
      event(3, 10, "model_response", 1),
      event(4, 10, "tool_call", 1),
      event(5, 11, "candidates_update", 1, "candidates"),
      event(6, 20, "model_request", 2),
      event(7, 30, "mcq_asked", 2, "human"),
      event(8, 40, "mcq_answered", 2, "human"),
      event(9, 41, "candidates_update", 2, "candidates"),
      event(10, 50, "soft_deadline_notice", 2, "soft_deadline"),
      event(11, 51, "model_request", 3),
      event(12, 90, "final_submission", 3, "final"),
      event(13, 100, "run_end", 3),
    ],
    keyframes: [
      { seq: 1, t_rel_s: 0, segment: 1, status: "running", hypotheses: [], provisional: [], final: null, penalty: { cues: 0, mcqs: 0, human_geocodes: 0, multiplier: 1 } },
      {
        seq: 5, t_rel_s: 11, segment: 1, status: "running",
        hypotheses: [{ lat: 38.7, lng: -9.1, probability: 0.6, label: "Lisbon" }, { lat: 41.1, lng: -8.6, probability: 0.4, label: "Porto" }],
        provisional: [{ rank: 1, lat: 38.7, lng: -9.1, multiplier: 1, origin: "agent" }],
        final: null,
        penalty: { cues: 0, mcqs: 0, human_geocodes: 0, multiplier: 1 },
      },
      {
        seq: 7, t_rel_s: 30, segment: 1, status: "awaiting_mcq",
        hypotheses: [{ lat: 38.7, lng: -9.1, probability: 0.6, label: "Lisbon" }, { lat: 41.1, lng: -8.6, probability: 0.4, label: "Porto" }],
        provisional: [{ rank: 1, lat: 38.7, lng: -9.1, multiplier: 0.95, origin: "agent" }],
        final: null,
        penalty: { cues: 0, mcqs: 1, human_geocodes: 0, multiplier: 0.95 },
      },
      {
        seq: 12, t_rel_s: 90, segment: 1, status: "done",
        hypotheses: [{ lat: 41.15, lng: -8.61, probability: 0.9, label: "Porto" }],
        provisional: [{ rank: 1, lat: 41.15, lng: -8.61, multiplier: 0.95, origin: "agent" }],
        final: [{ rank: 1, lat: 41.15, lng: -8.61, multiplier: 0.95, origin: "agent" }],
        penalty: { cues: 0, mcqs: 1, human_geocodes: 0, multiplier: 0.95 },
      },
    ],
    series: {
      labels: ["Lisbon", "Porto"],
      points: [
        { seq: 5, t_rel_s: 11, probabilities: [0.6, 0.4] },
        { seq: 9, t_rel_s: 41, probabilities: [null, 0.9] },
      ],
      top_path: [
        { seq: 5, t_rel_s: 11, lat: 38.7, lng: -9.1 },
        { seq: 9, t_rel_s: 41, lat: 41.15, lng: -8.61 },
        { seq: 12, t_rel_s: 90, lat: 41.15, lng: -8.61 },
      ],
    },
    turns: [
      { turn: 1, seq_request: 2, seq_response: 3, cost_usd: 0.1 },
      { turn: 2, seq_request: 6, seq_response: 9, cost_usd: 0.2 },
      { turn: 3, seq_request: 11, seq_response: 12, cost_usd: 0.3 },
    ],
    ledger: [{ seq: 7, kind: "mcq", before: 1, after: 0.95 }],
  };
}

const liveTile = () => ({
  run_id: "r1",
  panorama_id: "p1",
  filename: "p1.jpg",
  label: "Urban",
  special: true,
  budget: { hard_deadline_s: 600, soft_deadline_s: 480, max_turns: 30 },
  human_enabled: true,
  status: "done",
  live: true,
  final: [{ rank: 1, lat: 41.15, lng: -8.61, multiplier: 0.95, origin: "agent" }],
  stop_text: "the agent submitted its answer",
  plan_text: "hedge off: best point repeated",
  ledger: [{ seq: 7, kind: "mcq", before: 1, after: 0.95 }],
  cues: [],
  crops: [{ n: 1, seq_call: 4, yaw: 10, pitch: 0, fov: 60 }, { n: 2, seq_call: 11, yaw: 90, pitch: 0, fov: 40 }],
  pending_mcq: { id: "q" },
  cluster_points: [{ lat: 1, lng: 2 }],
  expected_score: { value: 1, max: 2, share: 0.5 },
});

// ---------------------------------------------------------------- the cursor in the URL

test("parseAt accepts whole numbers only", () => {
  assert.equal(parseAt("42"), 42);
  assert.equal(parseAt(" 7 "), 7);
  assert.equal(parseAt("0"), 0);
  assert.equal(parseAt(null), null);
  assert.equal(parseAt(""), null);
  assert.equal(parseAt("-3"), null);
  assert.equal(parseAt("4.5"), null);
  assert.equal(parseAt("12abc"), null);
  assert.equal(parseAt("1e3"), null);
  assert.equal(parseAt("12345678901"), null);
});

test("parseOpen knows the four controls and nothing else", () => {
  assert.equal(parseOpen("mcq"), "mcq");
  assert.equal(parseOpen(" Cue "), "cue");
  assert.equal(parseOpen("geocode"), "geocode");
  assert.equal(parseOpen("ack"), "ack");
  assert.equal(parseOpen("finalize"), null);
  assert.equal(parseOpen(""), null);
  assert.equal(parseOpen(null), null);
});

// ---------------------------------------------------------------- the timeline

test("timelineModel places events on the panorama's clock", () => {
  const model = timelineModel(inspectPayload());
  assert.equal(model.axis, "time");
  assert.equal(model.span, 100);
  assert.equal(model.first, 1);
  assert.equal(model.last, 13);
  assert.equal(model.entries.length, 13);
  assert.equal(model.entries[0].pos, 0);
  assert.equal(model.entries[4].pos, 0.11);
  assert.equal(model.entries[12].pos, 1);
});

test("timelineModel ticks the start of each turn and lists the marks", () => {
  const model = timelineModel(inspectPayload());
  assert.deepEqual(model.turns.map((turn) => [turn.seq, turn.turn]), [[2, 1], [6, 2], [11, 3]]);
  assert.deepEqual(model.marks.map((mark) => [mark.seq, mark.kind]), [[5, "candidates"], [7, "human"], [8, "human"], [9, "candidates"], [10, "soft_deadline"], [12, "final"]]);
  assert.equal(model.marks[1].label, "question asked");
  assert.equal(model.marks[4].label, "soft-deadline notice");
  // in the order of the legend, and only the kinds that occur
  assert.deepEqual(model.kinds, ["candidates", "human", "soft_deadline", "final"]);
});

test("timelineModel spreads events evenly when the clock restarts or runs backwards", () => {
  const retried = inspectPayload();
  retried.timeline[10].segment = 2;
  retried.timeline[11].segment = 2;
  retried.timeline[12].segment = 2;
  const a = timelineModel(retried);
  assert.equal(a.axis, "events");
  assert.equal(a.entries[0].pos, 0);
  assert.equal(a.entries[6].pos, 0.5);
  assert.equal(a.entries[12].pos, 1);

  const backwards = inspectPayload();
  backwards.timeline[5].t_rel_s = 2;
  assert.equal(timelineModel(backwards).axis, "events");

  const untimed = inspectPayload();
  untimed.timeline[3].t_rel_s = null;
  assert.equal(timelineModel(untimed).axis, "events");
});

test("timelineModel survives nothing, one event and damaged entries", () => {
  const empty = timelineModel(null);
  assert.deepEqual([empty.entries.length, empty.first, empty.last, empty.axis], [0, null, null, "events"]);
  const one = timelineModel({ timeline: [{ seq: 4, t_rel_s: 0.5, type: "run_start" }] });
  assert.deepEqual([one.first, one.last, one.entries[0].pos], [4, 4, 1]);
  const damaged = timelineModel({ timeline: [null, { t_rel_s: 3 }, { seq: 2, t_rel_s: 1 }, { seq: 1, t_rel_s: 0 }] });
  assert.deepEqual(damaged.entries.map((entry) => entry.seq), [1, 2]);
});

test("a log without requests still gets one tick per turn", () => {
  const payload = inspectPayload();
  payload.timeline = payload.timeline.filter((entry) => entry.type !== "model_request");
  assert.deepEqual(timelineModel(payload).turns.map((turn) => [turn.seq, turn.turn]), [[3, 1], [7, 2], [12, 3]]);
});

test("markLabel and kindLabel fall back to what the log says", () => {
  assert.equal(markLabel({ type: "human_cue", mark: "human" }), "cue sent");
  assert.equal(markLabel({ type: "something_new", mark: "human" }), "human interaction");
  assert.equal(markLabel({ type: "something_new", mark: "odd" }), "odd");
  assert.equal(markLabel(null), "");
  assert.equal(kindLabel("final"), "final submission");
  assert.equal(kindLabel("odd"), "odd");
  assert.deepEqual(MARK_KINDS, ["candidates", "human", "soft_deadline", "final", "error"]);
});

// ---------------------------------------------------------------- cursor

test("entryAt finds the last event at or before the cursor", () => {
  const model = timelineModel(inspectPayload());
  assert.equal(entryAt(model, 5).seq, 5);
  assert.equal(entryAt(model, 5.5).seq, 5);
  assert.equal(entryAt(model, 0), null);
  assert.equal(entryAt(model, 999).seq, 13);
  assert.equal(entryAt(model, null).seq, 13);
  assert.equal(entryAt(timelineModel(null), 3), null);
});

test("resolveCursor turns the end of the log into live and clamps the start", () => {
  const model = timelineModel(inspectPayload());
  assert.equal(resolveCursor(model, 7), 7);
  assert.equal(resolveCursor(model, 13), null);
  assert.equal(resolveCursor(model, 400), null);
  assert.equal(resolveCursor(model, 0), 1);
  assert.equal(resolveCursor(model, null), null);
  // nothing loaded yet: the request stands
  assert.equal(resolveCursor(timelineModel(null), 40), 40);
});

test("positionOf puts live at the right end", () => {
  const model = timelineModel(inspectPayload());
  assert.equal(positionOf(model, null), 1);
  assert.equal(positionOf(model, 9), 0.41);
  assert.equal(positionOf(model, 0), 0);
});

test("seqAtPosition gives the state at that moment, and snaps to a mark that is close", () => {
  const model = timelineModel(inspectPayload());
  assert.equal(seqAtPosition(model, 0), 1);
  assert.equal(seqAtPosition(model, 0.15), 5); // between 11 s and 20 s: nothing happened since event 5
  assert.equal(seqAtPosition(model, 0.1), 4); // two events share 10 s: the later one
  assert.equal(seqAtPosition(model, 1), 13);
  assert.equal(seqAtPosition(model, 7), 13);
  assert.equal(seqAtPosition(model, -1), 1);
  assert.equal(seqAtPosition(model, 0.29), 6);
  assert.equal(seqAtPosition(model, 0.29, { snap: 0.02 }), 7);
  assert.equal(seqAtPosition(model, 0.403, { snap: 0.02 }), 8); // 8 at 0.40 is nearer than 9 at 0.41
  assert.equal(seqAtPosition(timelineModel(null), 0.5), null);
});

test("stepping by event, turn and mark", () => {
  const model = timelineModel(inspectPayload());
  assert.equal(stepEvent(model, 5, 1), 6);
  assert.equal(stepEvent(model, 5, -1), 4);
  assert.equal(stepEvent(model, 12, 1), null); // the last event is live
  assert.equal(stepEvent(model, null, -1), 12);
  assert.equal(stepEvent(model, null, 1), null);
  assert.equal(stepEvent(model, 1, -1), 1);

  assert.equal(stepTurn(model, 8, -1), 6); // inside turn 2: its start
  assert.equal(stepTurn(model, 6, -1), 2);
  assert.equal(stepTurn(model, 2, -1), 1); // before the first turn: the start of the run
  assert.equal(stepTurn(model, 8, 1), 11);
  assert.equal(stepTurn(model, 11, 1), null);
  assert.equal(stepTurn(model, null, -1), 11);

  assert.equal(stepMark(model, null, -1), 12);
  assert.equal(stepMark(model, 12, -1), 10);
  assert.equal(stepMark(model, 5, -1), 1);
  assert.equal(stepMark(model, 5, 1), 7);
  assert.equal(stepMark(model, 12, 1), null);
});

test("a mark on the very last event can still be stepped back from", () => {
  const payload = inspectPayload();
  payload.timeline.pop(); // the log now ends with the final submission
  const model = timelineModel(payload);
  assert.equal(model.last, 12);
  assert.equal(stepMark(model, null, -1), 10);
  assert.equal(stepMark(model, 10, 1), null);
});

test("canStep is false at the ends and without a timeline", () => {
  const model = timelineModel(inspectPayload());
  assert.equal(canStep(model, null, 1), false);
  assert.equal(canStep(model, null, -1), true);
  assert.equal(canStep(model, 1, -1), false);
  assert.equal(canStep(model, 1, 1), true);
  assert.equal(canStep(timelineModel(null), 3, -1), false);
  assert.equal(canStep(timelineModel({ timeline: [{ seq: 1, t_rel_s: 0 }] }), null, -1), false);
});

test("stepping without a timeline leaves the cursor where it is", () => {
  const empty = timelineModel(null);
  assert.equal(stepEvent(empty, 7, 1), 7);
  assert.equal(stepTurn(empty, null, -1), null);
});

test("describeCursor names the moment", () => {
  const model = timelineModel(inspectPayload());
  const at = describeCursor(model, 8);
  assert.deepEqual([at.seq, at.index, at.total, at.clock, at.turn, at.markText], [8, 8, 13, "00:40", 2, "question answered"]);
  assert.equal(at.text, "00:40 · event 8 of 13 · turn 2");
  assert.equal(describeCursor(model, 1).text, "00:00 · event 1 of 13");
  assert.equal(describeCursor(model, null).seq, 13);
  assert.equal(describeCursor(model, 0).text, "before the first event");
  assert.equal(describeCursor(timelineModel(null), 4).text, "no events yet");
});

test("bannerModel says replay in the words of the spec, and never offers controls there", () => {
  const model = timelineModel(inspectPayload());
  assert.deepEqual(bannerModel(model, 8, { running: true }), {
    mode: "replay",
    text: "Replay: showing the state at 00:40. Controls act on the live panorama.",
    back: "Back to live",
  });
  const ended = bannerModel(model, 8, { running: false });
  assert.equal(ended.mode, "replay");
  assert.equal(ended.back, "Back to the latest state");
  assert.match(ended.text, /^Replay: showing the state at 00:40\./);
  assert.equal(bannerModel(model, null, { running: true }).mode, "live");
  assert.equal(bannerModel(model, null, { running: false }).mode, "ended");
  assert.equal(bannerModel(model, null, { pending: true }).mode, "waiting");
  assert.match(bannerModel(model, null, { pending: true }).text, /has not started/);
  assert.equal(bannerModel(model, null).back, null);
  // a cursor from a link, before the timeline is in
  assert.match(bannerModel(timelineModel(null), 40, { running: true }).text, /state at event #40\./);
});

// ---------------------------------------------------------------- the state at a cursor

test("frameTile draws the keyframe over the tile's identity", () => {
  const frame = frameTile(liveTile(), inspectPayload(), 8);
  assert.equal(frame.approximate, true);
  assert.equal(frame.panorama_id, "p1");
  assert.equal(frame.special, true);
  assert.deepEqual(frame.budget, { hard_deadline_s: 600, soft_deadline_s: 480, max_turns: 30 });
  assert.equal(frame.status, "awaiting_mcq");
  assert.equal(frame.live, false);
  assert.equal(frame.active, false);
  assert.equal(frame.final, null);
  assert.equal(frame.hypotheses.length, 2);
  assert.equal(frame.penalty.multiplier, 0.95);
  assert.deepEqual(frame.ledger, [{ seq: 7, kind: "mcq", before: 1, after: 0.95 }]);
  assert.equal(frame.elapsed_s, 40);
  assert.equal(frame.turns, 2);
  assert.equal(frame.segment_turns, 2);
  assert.ok(Math.abs(frame.spend_usd - 0.1) < 1e-9);
  assert.deepEqual(frame.crops.map((crop) => crop.n), [1]);
  assert.deepEqual(frame.chosen, { lat: 38.7, lng: -9.1 });
  assert.equal(frame.last_seq, 8);
});

test("frameTile carries nothing a past moment cannot have", () => {
  const frame = frameTile(liveTile(), inspectPayload(), 8);
  // no control can be built from a frame, and nothing is guessed
  assert.equal(frame.pending_mcq, null);
  assert.equal(frame.human_window, null);
  assert.equal(frame.geocode_enabled, false);
  assert.equal(frame.retryable, false);
  assert.deepEqual(frame.named_places, []);
  assert.deepEqual(frame.cluster_points, []);
  assert.equal(frame.expected_score, null);
  assert.equal(frame.stop_text, "");
  assert.equal(frame.plan_text, "");
  assert.equal(frame.origin, null);
  assert.equal(frame.ledger_text, undefined);
});

test("frameTile before the first keyframe and before any charge", () => {
  const early = frameTile(liveTile(), inspectPayload(), 0);
  assert.equal(early.status, "pending");
  assert.deepEqual(early.hypotheses, []);
  assert.equal(early.penalty.multiplier, 1);
  assert.equal(early.elapsed_s, 0);
  assert.equal(early.chosen, null);
  const beforeCharge = frameTile(liveTile(), inspectPayload(), 6);
  assert.deepEqual(beforeCharge.ledger, []);
  assert.equal(beforeCharge.turns, 2);
  assert.ok(Math.abs(beforeCharge.spend_usd - 0.1) < 1e-9);
});

test("frameTile shows how the panorama ended only with the answer of record", () => {
  const atEnd = frameTile(liveTile(), inspectPayload(), 12);
  assert.equal(atEnd.status, "done");
  assert.equal(atEnd.origin, "agent");
  assert.equal(atEnd.stop_text, "the agent submitted its answer");
  assert.equal(atEnd.plan_text, "hedge off: best point repeated");
  assert.ok(Math.abs(atEnd.spend_usd - 0.6) < 1e-9);
  // a retried panorama: the final of that moment is not the answer of record
  const retried = { ...liveTile(), final: [{ rank: 1, lat: 0, lng: 0, multiplier: 1, origin: "harness_fallback" }] };
  assert.equal(frameTile(retried, inspectPayload(), 12).stop_text, "");
});

test("frameTile works without a tile or a payload", () => {
  const frame = frameTile(null, null, 5);
  assert.equal(frame.status, "pending");
  assert.deepEqual(frame.provisional, []);
  assert.equal(frame.spend_usd, 0);
});

test("frameTile takes the longer ledger: the tile's can be ahead of the payload", () => {
  const tile = { ...liveTile(), ledger: [{ seq: 7, kind: "mcq" }, { seq: 8, kind: "cue" }] };
  assert.equal(frameTile(tile, inspectPayload(), 9).ledger.length, 2);
  assert.equal(frameTile(tile, inspectPayload(), 7).ledger.length, 1);
});

test("pathUpTo stops at the cursor and drops repeated points", () => {
  const payload = inspectPayload();
  assert.deepEqual(pathUpTo(payload, null), [{ lat: 38.7, lng: -9.1 }, { lat: 41.15, lng: -8.61 }]);
  assert.deepEqual(pathUpTo(payload, 8), [{ lat: 38.7, lng: -9.1 }]);
  assert.deepEqual(pathUpTo(payload, 2), []);
  assert.deepEqual(pathUpTo(null, null), []);
  payload.series.top_path.push({ seq: 13, lat: null, lng: 4 });
  assert.equal(pathUpTo(payload, null).length, 2);
});

// ---------------------------------------------------------------- hypothesis evolution

test("beliefSeries draws each hypothesis over the clock and holds the last belief to the end", () => {
  const payload = inspectPayload();
  const chart = beliefSeries(payload, timelineModel(payload));
  assert.equal(chart.axis, "time");
  assert.equal(chart.folded, 0);
  assert.deepEqual(chart.series.map((line) => line.name), ["Lisbon", "Porto"]);
  // Lisbon was dropped at 41 s: its line holds up to there and then ends
  assert.deepEqual(chart.series[0].points, [[11, 0.6], [41, 0.6], [41, null]]);
  assert.deepEqual(chart.series[1].points, [[11, 0.4], [41, 0.9], [100, 0.9]]);
  assert.equal(chart.end, 100);
  assert.deepEqual(chart.marks, [
    { x: 30, label: "question", kind: "human" },
    { x: 40, label: "answer", kind: "human" },
    { x: 50, label: "soft deadline", kind: "soft_deadline" },
    { x: 90, label: "final", kind: "final" },
  ]);
});

test("beliefSeries converts between the cursor and the chart's x", () => {
  const payload = inspectPayload();
  const chart = beliefSeries(payload, timelineModel(payload));
  assert.equal(chart.xOf(9), 41);
  assert.equal(chart.xOf(null), null);
  assert.equal(chart.seqOf(41), 9);
  assert.equal(chart.seqOf(45), 9);
  assert.equal(chart.seqOf(100), 13);
  assert.equal(chart.seqOf(null), null);
});

test("beliefSeries uses event numbers after a retry", () => {
  const payload = inspectPayload();
  payload.timeline[12].segment = 2;
  const chart = beliefSeries(payload, timelineModel(payload));
  assert.equal(chart.axis, "events");
  assert.deepEqual(chart.series[1].points, [[5, 0.4], [9, 0.9], [13, 0.9]]);
  assert.equal(chart.xOf(9), 9);
  assert.equal(chart.seqOf(9.2), 9);
});

test("beliefSeries folds the hypotheses that never weighed much into one line", () => {
  const payload = inspectPayload();
  payload.series.labels = ["a", "b", "c", "d", "e"];
  payload.series.points = [
    { seq: 5, t_rel_s: 11, probabilities: [0.5, 0.2, 0.15, 0.1, 0.05] },
    { seq: 9, t_rel_s: 41, probabilities: [0.1, 0.7, null, null, 0.2] },
  ];
  const chart = beliefSeries(payload, timelineModel(payload), { max: 3 });
  assert.equal(chart.folded, 3);
  assert.deepEqual(chart.series.map((line) => line.name), ["a", "b", "3 other hypotheses (summed)"]);
  assert.deepEqual(chart.series[2].points.map((point) => point[1]), [0.3, 0.2, 0.2]);
  // exactly at the limit nothing is folded
  assert.equal(beliefSeries(payload, timelineModel(payload), { max: 5 }).folded, 0);
});

test("beliefSeries keeps every hypothesis that once led, whatever it weighed", () => {
  const payload = inspectPayload();
  payload.series.labels = ["early leader", "runner-up", "late leader", "also-ran"];
  payload.series.points = [
    { seq: 5, t_rel_s: 11, probabilities: [0.4, 0.35, null, 0.25] },
    { seq: 9, t_rel_s: 41, probabilities: [null, 0.45, 0.5, 0.05] },
  ];
  const chart = beliefSeries(payload, timelineModel(payload), { max: 3 });
  // "runner-up" peaked above "early leader" but never led: it is the one that is folded
  assert.deepEqual(chart.series.map((line) => line.name), ["early leader", "late leader", "2 other hypotheses (summed)"]);
  assert.deepEqual(chart.series[2].points, [[11, 0.6], [41, 0.5], [100, 0.5]]);
});

test("beliefSeries is empty without hypotheses", () => {
  const payload = inspectPayload();
  payload.series = { labels: [], points: [], top_path: [] };
  assert.deepEqual(beliefSeries(payload, timelineModel(payload)).series, []);
  assert.deepEqual(beliefSeries(null, null).series, []);
});

// ---------------------------------------------------------------- keeping a live run current

test("refreshPlan loads a stale payload, but not more often than the gap", () => {
  const base = { loadedSeq: 10, askedSeq: 10, tileSeq: 14, lastStartMs: 1000 };
  assert.deepEqual(refreshPlan({ ...base, nowMs: 1000 + REFRESH_GAP_MS }), { load: true, waitMs: 0 });
  assert.deepEqual(refreshPlan({ ...base, nowMs: 2500 }), { load: false, waitMs: REFRESH_GAP_MS - 1500 });
  assert.deepEqual(refreshPlan({ ...base, tileSeq: 10, nowMs: 99999 }), { load: false, waitMs: null });
});

test("refreshPlan waits for a request in flight and for the tab to be seen", () => {
  const base = { loadedSeq: 10, askedSeq: 10, tileSeq: 14, lastStartMs: 0, nowMs: 60000 };
  assert.deepEqual(refreshPlan({ ...base, loading: true }), { load: false, waitMs: null });
  assert.deepEqual(refreshPlan({ ...base, hidden: true }), { load: false, waitMs: null });
});

test("refreshPlan loads once more at once when the panorama is final", () => {
  const base = { loadedSeq: 10, askedSeq: 12, tileSeq: 14, lastStartMs: 5000, nowMs: 5100 };
  assert.deepEqual(refreshPlan({ ...base, final: true }), { load: true, waitMs: 0 });
  // that request was started with the tile at 14: it is not repeated, even if the payload it
  // brought back is still behind
  assert.deepEqual(refreshPlan({ ...base, askedSeq: 14, final: true }), { load: false, waitMs: null });
  assert.deepEqual(refreshPlan({ tileSeq: null }), { load: false, waitMs: null });
});

// ---------------------------------------------------------------- around the panorama

test("neighbours follows the run's own order", () => {
  const run = { panoramas: [{ panorama_id: "s" }, { panorama_id: "a" }, { panorama_id: "b" }] };
  assert.deepEqual(neighbours(run, "a"), { ids: ["s", "a", "b"], index: 1, total: 3, previous: "s", next: "b" });
  assert.equal(neighbours(run, "s").previous, null);
  assert.equal(neighbours(run, "b").next, null);
  assert.deepEqual(neighbours(run, "zz"), { ids: ["s", "a", "b"], index: -1, total: 3, previous: null, next: null });
  assert.equal(neighbours(null, "a").total, 0);
});

test("truthPoint needs an evaluation run with human channels off", () => {
  const truth = { panoramas: { p1: { lat: 38.5, lng: -9.2, entries: [] } } };
  const run = { kind: "eval", no_human: true };
  assert.deepEqual(truthPoint(truth, run, { human_enabled: false }, "p1"), { lat: 38.5, lng: -9.2 });
  assert.equal(truthPoint(truth, run, { human_enabled: true }, "p1"), null);
  assert.equal(truthPoint(truth, { kind: "eval", no_human: false }, null, "p1"), null);
  assert.equal(truthPoint(truth, { kind: "scoring", no_human: true }, null, "p1"), null);
  assert.equal(truthPoint(truth, { kind: "eval" }, null, "p1"), null);
  assert.equal(truthPoint(truth, null, null, "p1"), null);
  assert.equal(truthPoint(truth, run, null, "other"), null);
  assert.equal(truthPoint(null, run, null, "p1"), null);
});
