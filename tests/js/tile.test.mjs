import test from "node:test";
import assert from "node:assert/strict";

import { attentionItems } from "../../server/static/console/js/logic/attention.js";
import {
  STALL_S,
  answerModel,
  chosenPoint,
  confidence,
  deadlineModel,
  eventAge,
  flagModel,
  humanWindow,
  hypothesisRows,
  isFinal,
  isInterrupted,
  liveness,
  multiplierModel,
  originWords,
  panoSources,
  reviewGain,
  sortTiles,
  sourcesKey,
  spendModel,
  thumbUrl,
  tileStatus,
  topHypothesis,
  turnText,
  viewerCrops,
} from "../../server/static/console/js/logic/tile.js";

const NOW = Date.parse("2026-10-11T10:07:42.000Z");

const entry = (rank, lat, lng, extra = {}) => ({ rank, lat, lng, multiplier: 1, origin: "agent", ...extra });
const tenOf = (lat, lng, extra) => Array.from({ length: 10 }, (_, i) => entry(i + 1, lat, lng, extra));

// A healthy running tile of an assisted run, shaped as runstate.LogFold.tile() returns it.
function tile(extra = {}) {
  return {
    run_id: "r1", panorama_id: "p1", filename: "p1.jpg", label: "Urban", special: false,
    status: "running", active: true, live: true,
    hypotheses: [
      { lat: 38.7169, lng: -9.1399, probability: 0.3, radius_m: 250, label: "Rossio, Lisbon", evidence: "Wave paving." },
      { lat: 41.1496, lng: -8.611, probability: 0.6, radius_m: 5500, label: "Ribeira, Porto", evidence: "" },
    ],
    provisional: tenOf(41.1496, -8.611), final: null,
    penalty: { cues: 0, mcqs: 0, human_geocodes: 0, multiplier: 1 }, ledger: [], ledger_text: "x1.0 (no penalties)",
    pending_mcq: null, mcq_allowed: true, mcqs_left: 3, max_mcq: 3, named_places: ["Rossio, Lisbon"],
    geocode_enabled: true, human_enabled: true,
    elapsed_s: 100, turns: 7, segment_turns: 7,
    budget: { effort: "high", soft_deadline_s: 600, hard_deadline_s: 840, max_turns: 30, max_spend_usd: 8 },
    human_window: { cue_closes_at_s: 810, mcq_closes_at_s: 690 },
    origin: null, stop_reason: null, stop_text: "", plan_text: "hedge off: best point repeated",
    clusters: 2, top_gap_m: 274000, multimodal: true, gate_reason: "two clusters far apart",
    cluster_points: [], chosen: { lat: 41.1496, lng: -8.611 },
    expected_score: { value: 9630, max: 16050, share: 0.6 },
    last_seq: 40, last_event_ts: "2026-10-11T10:07:39.000Z", last_event_t_rel_s: 97,
    image: { width: 6080, height: 3040, sha256: "a".repeat(64) }, crops: [],
    ...extra,
  };
}

// ---------------------------------------------------------------- status

test("status: a non-live tile without a final answer is interrupted, whatever its log said", () => {
  assert.equal(tileStatus(tile()), "running");
  assert.equal(tileStatus(tile({ live: false, active: false, status: "running" })), "interrupted");
  assert.equal(tileStatus(tile({ live: false, active: false, status: "awaiting_mcq" })), "interrupted");
  assert.equal(isInterrupted(tile({ live: false, status: "pending" })), true);
  assert.equal(tileStatus(tile({ live: false, status: "running", final: tenOf(1, 2) })), "done");
  assert.equal(tileStatus(tile({ status: "awaiting_mcq" })), "awaiting_mcq");
  assert.equal(tileStatus(tile({ status: "something new" })), "pending");
  assert.equal(tileStatus(null), "pending");
});

test("status: a replay keeps the status the log had at that moment", () => {
  const past = tile({ live: false, active: false, status: "running" });
  assert.equal(tileStatus(past, { replay: true }), "running");
  assert.equal(isInterrupted(past, { replay: true }), false);
});

test("isFinal follows the final list, not the status word", () => {
  assert.equal(isFinal(tile()), false);
  assert.equal(isFinal(tile({ final: tenOf(1, 2) })), true);
  assert.equal(isFinal(tile({ status: "done", final: null })), false);
  assert.equal(isFinal(null), false);
});

// ---------------------------------------------------------------- image sources

test("panoSources: previews narrower than the panorama, then the original", () => {
  const sources = panoSources("r 1", "p/1", tile());
  assert.deepEqual(sources.map((s) => s.width), [1024, 2048, 4096, 6080]);
  assert.equal(sources[0].url, "/api/runs/r%201/pano/p%2F1/image?w=1024");
  assert.equal(sources[3].url, "/api/runs/r%201/pano/p%2F1/image?w=full");
  for (const source of sources) assert.ok(source.url.startsWith("/api/runs/"), "only API paths of this app");
});

test("panoSources: no preview is offered wider than the image, and none twice", () => {
  assert.deepEqual(panoSources("r", "p", tile({ image: { width: 3000, height: 1500 } })).map((s) => [s.width, s.url.split("w=")[1]]),
    [[1024, "1024"], [2048, "2048"], [3000, "full"]]);
  assert.deepEqual(panoSources("r", "p", tile({ image: { width: 800, height: 400 } })).map((s) => [s.width, s.url.split("w=")[1]]),
    [[800, "1024"]]);
  assert.deepEqual(panoSources("r", "p", tile({ image: { width: 4096, height: 2048 } })).map((s) => s.width), [1024, 2048, 4096]);
});

test("panoSources: without the image size the three previews are offered", () => {
  assert.deepEqual(panoSources("r", "p", tile({ image: null })).map((s) => s.width), [1024, 2048, 4096]);
  assert.deepEqual(panoSources("r", "p", null).map((s) => s.width), [1024, 2048, 4096]);
});

test("sourcesKey changes only when the sources do; thumbUrl is the 320 px preview", () => {
  const a = panoSources("r", "p", tile({ image: null }));
  const b = panoSources("r", "p", tile({ image: null }));
  assert.equal(sourcesKey(a), sourcesKey(b));
  assert.notEqual(sourcesKey(a), sourcesKey(panoSources("r", "p", tile())));
  assert.equal(thumbUrl("r", "p"), "/api/runs/r/pano/p/image?w=320");
});

test("viewerCrops keeps the crops that have a direction", () => {
  const crops = [
    { n: 1, yaw: 135, pitch: 0, fov: 40, width: 1024, height: 768 },
    { n: 2, yaw: null, pitch: 0, fov: 40 },
    null,
    { n: 3, yaw: 0, pitch: -10, fov: 25 },
  ];
  assert.deepEqual(viewerCrops(tile({ crops })).map((c) => c.n), [1, 3]);
  assert.deepEqual(viewerCrops(tile({ crops: undefined })), []);
});

// ---------------------------------------------------------------- time

test("deadline: before the soft deadline", () => {
  const model = deadlineModel(tile(), 462);
  assert.equal(model.phase, "before_soft");
  assert.equal(model.tone, "ok");
  assert.equal(model.clock, "07:42 / 14:00");
  assert.equal(model.text, "soft deadline in 02:18");
  assert.equal(model.fraction, 0.55);
  assert.ok(Math.abs(model.softFraction - 600 / 840) < 1e-9);
  assert.ok(Math.abs(model.cueFraction - 810 / 840) < 1e-9);
});

test("deadline: after the soft deadline, at the hard deadline, ended and queued", () => {
  const late = deadlineModel(tile(), 700);
  assert.equal(late.phase, "after_soft");
  assert.equal(late.tone, "warn");
  assert.equal(late.text, "soft deadline passed; hard deadline in 02:20");

  const over = deadlineModel(tile(), 900);
  assert.equal(over.phase, "over");
  assert.equal(over.tone, "bad");
  assert.equal(over.fraction, 1);
  assert.match(over.text, /hard deadline reached/);

  const ended = deadlineModel(tile({ status: "done", final: tenOf(1, 2), elapsed_s: 378 }), 378);
  assert.equal(ended.phase, "ended");
  assert.equal(ended.text, "ended at 06:18");

  const queued = deadlineModel(tile({ status: "pending", active: true }), 0);
  assert.equal(queued.phase, "queued");
  assert.equal(queued.text, "not started");

  const dead = deadlineModel(tile({ live: false, active: false }), 97);
  assert.equal(dead.phase, "interrupted");
  assert.equal(dead.text, "stopped at 01:37");
});

test("deadline: a tile without a budget still shows its clock", () => {
  const model = deadlineModel(tile({ budget: null, human_window: null }), 65);
  assert.equal(model.known, false);
  assert.equal(model.clock, "01:05");
  assert.equal(model.fraction, 0);
  assert.equal(model.softFraction, null);
  assert.equal(model.cueFraction, null);
});

test("human window: counts down to the moment a cue stops reaching the agent", () => {
  const open = humanWindow(tile(), 558);
  assert.equal(open.state, "open");
  assert.equal(open.text, "cue / question window closes in 04:12");
  assert.equal(open.detail, "the agent can still ask a question for 02:12");

  const closing = humanWindow(tile(), 750);
  assert.equal(closing.state, "closing");
  assert.equal(closing.tone, "warn");
  assert.equal(closing.text, "cue / question window closes in 01:00");
  assert.equal(closing.detail, "too late for a new question");

  const shut = humanWindow(tile(), 815);
  assert.equal(shut.state, "closed");
  assert.equal(shut.tone, "bad");
  assert.match(shut.text, /only the x0\.5 geocode remains/);
});

test("human window: what the questions line says follows the toggle and the count left", () => {
  assert.equal(humanWindow(tile({ mcq_allowed: false }), 100).detail, "questions are switched off");
  assert.equal(humanWindow(tile({ mcqs_left: 0 }), 100).detail, "no questions left");
});

test("human window: falls back to the hard deadline minus 30 s when the server sent no window", () => {
  assert.equal(humanWindow(tile({ human_window: null }), 700).text, "cue / question window closes in 01:50");
});

test("human window: after final only the geocode remains, and it says when that is gone too", () => {
  const done = tile({ status: "done", final: tenOf(1, 2), origin: "agent" });
  assert.equal(humanWindow(done, 300).text, "cue / question window closed; only the x0.5 geocode remains");
  assert.equal(humanWindow(done, 300).detail, null);
  assert.match(humanWindow({ ...done, named_places: [] }, 300).detail, /named no place/);
  const used = { ...done, origin: "human_geocode", penalty: { cues: 0, mcqs: 0, human_geocodes: 1, multiplier: 0.5 } };
  assert.equal(humanWindow(used, 300).text, "cue / question window closed; the geocode has been used");
  assert.match(humanWindow({ ...done, live: false }, 300).detail, /not running in this server/);
});

test("human window: none for an autonomous run, a plain sentence for queued and interrupted tiles", () => {
  assert.equal(humanWindow(tile({ human_enabled: false, human_window: null }), 100), null);
  assert.match(humanWindow(tile({ status: "pending" }), 0).text, /opens when this panorama starts/);
  const dead = humanWindow(tile({ live: false, active: false }), 97);
  assert.equal(dead.state, "closed");
  assert.match(dead.text, /no longer running/);
});

test("turn text uses the current conversation and the budget", () => {
  assert.equal(turnText(tile()), "turn 7/30");
  assert.equal(turnText(tile({ segment_turns: 2, turns: 9 })), "turn 2/30");
  assert.equal(turnText(tile({ segment_turns: undefined, turns: 4, budget: null })), "turn 4");
});

test("event age is measured on the server's clock", () => {
  assert.equal(eventAge(tile(), NOW), 3);
  assert.equal(eventAge(tile(), NOW, 5000), 8, "the server is five seconds ahead of this browser");
  assert.equal(eventAge(tile({ last_event_ts: null }), NOW), null);
  assert.equal(eventAge(tile({ last_event_ts: "not a date" }), NOW), null);
  assert.equal(eventAge(tile(), NOW - 60_000), 0, "never negative");
});

test("liveness: last event age, then stalled after 60 s of silence", () => {
  const alive = liveness(tile(), NOW);
  assert.equal(alive.stalled, false);
  assert.equal(alive.text, "last event 3 s ago");

  const edge = liveness(tile(), NOW + (STALL_S - 4) * 1000);
  assert.equal(edge.stalled, false);

  const silent = liveness(tile(), NOW + 69_000);
  assert.equal(silent.stalled, true);
  assert.equal(silent.tone, "bad");
  assert.equal(silent.text, "no event for 1 min 12 s");
  assert.ok(silent.hint);
});

test("liveness: a tile that is not running is never called stalled", () => {
  const long = NOW + 600_000;
  assert.equal(liveness(tile({ status: "awaiting_mcq" }), long).stalled, false);
  assert.equal(liveness(tile({ status: "awaiting_mcq" }), long).text, "waiting for your answer");
  assert.equal(liveness(tile({ status: "pending" }), long).text, "waiting for a free slot");
  assert.equal(liveness(tile({ live: false, active: false }), long).text, "no longer running");
  const done = tile({ status: "done", final: tenOf(1, 2), stop_text: "hard deadline: best-so-far list used" });
  assert.equal(liveness(done, long).text, "hard deadline: best-so-far list used");
  assert.equal(liveness(done, long).stalled, false);
  assert.equal(liveness(tile({ last_event_ts: null }), long).text, "no event yet");
});

// ---------------------------------------------------------------- belief

test("top hypothesis is the most probable one, with its index in the tile's array", () => {
  const top = topHypothesis(tile());
  assert.equal(top.index, 1);
  assert.equal(top.label, "Ribeira, Porto");
  assert.equal(top.probability, 0.6);
  assert.equal(topHypothesis(tile({ hypotheses: [] })), null);
  assert.equal(topHypothesis(tile({ hypotheses: undefined })), null);
});

test("hypothesis rows: most probable first, original index kept, coordinates to 6 decimals", () => {
  const rows = hypothesisRows(tile());
  assert.deepEqual(rows.map((r) => r.index), [1, 0]);
  assert.equal(rows[0].coords, "41.149600, -8.611000");
  assert.equal(rows[0].probabilityText, "60%");
  assert.equal(rows[0].radiusText, "± 5.5 km");
  assert.equal(rows[1].radiusText, "± 250 m");
  assert.equal(rows[1].evidence, "Wave paving.");
});

test("hypothesis rows: keys follow a hypothesis across a reorder and stay unique", () => {
  const before = hypothesisRows(tile());
  const swapped = tile();
  swapped.hypotheses = [swapped.hypotheses[1], swapped.hypotheses[0]];
  const after = hypothesisRows(swapped);
  assert.equal(before.find((r) => r.label === "Rossio, Lisbon").key, after.find((r) => r.label === "Rossio, Lisbon").key);
  const twins = hypothesisRows(tile({ hypotheses: [
    { lat: 1, lng: 2, probability: 0.5, label: "A" },
    { lat: 1, lng: 2, probability: 0.5, label: "A" },
  ] }));
  assert.equal(new Set(twins.map((r) => r.key)).size, 2);
  assert.equal(hypothesisRows(tile({ hypotheses: [{ lat: 1, lng: 2, probability: 1 }] }))[0].label, "(no label)");
});

test("confidence: top probability, clusters, gap, the multi-modal flag and the proxy", () => {
  const model = confidence(tile());
  assert.equal(model.hasBelief, true);
  assert.equal(model.topText, "top 60%");
  assert.equal(model.clustersText, "2 clusters");
  assert.equal(model.gapText, "top two 274 km apart");
  assert.equal(model.multimodal, true);
  assert.equal(model.gateReason, "two clusters far apart");
  assert.equal(model.proxy.text, "9,630 of 16,050 (60%)");
});

test("confidence: one place, and no belief at all", () => {
  const one = confidence(tile({ clusters: 1, top_gap_m: null, multimodal: false }));
  assert.equal(one.clustersText, "1 cluster");
  assert.equal(one.gapText, "one place");
  const none = confidence(tile({ hypotheses: [], clusters: 0, top_gap_m: null, expected_score: null, gate_reason: "no hypotheses yet" }));
  assert.equal(none.hasBelief, false);
  assert.equal(none.topText, "no hypothesis yet");
  assert.equal(none.proxy, null);
});

// ---------------------------------------------------------------- answer

test("answer: ten identical entries collapse to one line, titled Provisional until final", () => {
  const model = answerModel(tile());
  assert.equal(model.state, "provisional");
  assert.equal(model.title, "Provisional answer");
  assert.equal(model.identical, true);
  assert.equal(model.summary, "10 x 41.149600, -8.611000");
  assert.equal(model.rows.length, 10);
  assert.equal(model.planText, "hedge off: best point repeated");
  assert.equal(model.stopText, "", "nothing has ended yet");
  assert.equal(model.originText, "");
  assert.equal(model.copyAll.split("\n").length, 10);
});

test("answer: a hedged list keeps its ten rows and names the groups", () => {
  const entries = [...tenOf(38.7169, -9.1399).slice(0, 8), entry(9, 41.1496, -8.611), entry(10, 41.1496, -8.611)];
  const model = answerModel(tile({ provisional: entries }));
  assert.equal(model.identical, false);
  assert.equal(model.summary, null);
  assert.deepEqual(model.groups.map((g) => [g.count, g.rankText]), [[8, "1–8"], [2, "9–10"]]);
  assert.equal(model.rows[8].coords, "41.149600, -8.611000");
});

test("answer: the same point with different multipliers is not collapsed", () => {
  const entries = tenOf(1, 2).map((e, i) => (i < 5 ? e : { ...e, multiplier: 0.8 }));
  assert.equal(answerModel(tile({ provisional: entries })).identical, false);
});

test("answer: final shows origin and how it ended, in words", () => {
  const final = tenOf(38.7169, -9.1399, { multiplier: 0.76 });
  const model = answerModel(tile({
    status: "done", final, provisional: final, origin: "agent",
    stop_reason: "hard_deadline", stop_text: "hard deadline: best-so-far list used",
  }));
  assert.equal(model.state, "final");
  assert.equal(model.title, "Final answer");
  assert.equal(model.originText, "agent");
  assert.equal(model.stopText, "hard deadline: best-so-far list used");
  assert.equal(model.rows[0].multiplierText, "x0.76");
  assert.equal(model.fallback, false);
  assert.equal(model.countProblem, null);
});

test("answer: a fallback and a short final list are both called out", () => {
  const fallback = answerModel(tile({ final: tenOf(39.5, -8, { origin: "harness_fallback" }), origin: "harness_fallback" }));
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.originText, "harness fallback");
  const short = answerModel(tile({ final: tenOf(1, 2).slice(0, 7), origin: "agent" }));
  assert.equal(short.countProblem, "7 entries in the final list; 10 are expected");
  assert.equal(originWords("human_geocode"), "human geocode");
  assert.equal(originWords("some_new_origin"), "some new origin");
  assert.equal(originWords(null), "");
});

test("answer: the empty state says why there is no list", () => {
  const running = answerModel(tile({ provisional: [], hypotheses: [] }));
  assert.equal(running.state, "none");
  assert.match(running.emptyText, /first hypotheses/);
  assert.match(answerModel(tile({ provisional: [], status: "pending" })).emptyText, /has not started/);
  const dead = answerModel(tile({ provisional: [], live: false, active: false, stop_text: "server stopped while this panorama was running" }));
  assert.match(dead.emptyText, /fallback point/);
  assert.equal(dead.stopText, "server stopped while this panorama was running");
  assert.equal(answerModel(null).state, "none");
});

test("chosen point: the server's, else entry 1 of the list in force", () => {
  assert.deepEqual(chosenPoint(tile()), { lat: 41.1496, lng: -8.611 });
  assert.deepEqual(chosenPoint(tile({ chosen: null })), { lat: 41.1496, lng: -8.611 });
  assert.deepEqual(chosenPoint(tile({ chosen: null, final: tenOf(5, 6) })), { lat: 5, lng: 6 });
  assert.equal(chosenPoint(tile({ chosen: null, provisional: [] })), null);
});

// ---------------------------------------------------------------- multiplier

test("multiplier: the ledger is written out", () => {
  const clean = multiplierModel(tile());
  assert.deepEqual([clean.text, clean.detail, clean.reduced], ["x1.0", "(no penalties)", false]);
  const charged = multiplierModel(tile({
    penalty: { cues: 1, mcqs: 1, human_geocodes: 0, multiplier: 0.76 },
    ledger: [{ kind: "cue" }, { kind: "mcq" }], ledger_text: "x0.76 = 0.8 cue x 0.95 MCQ",
  }));
  assert.deepEqual([charged.text, charged.detail, charged.reduced], ["x0.76", "= 0.8 cue x 0.95 MCQ", true]);
  assert.equal(charged.full, "x0.76 = 0.8 cue x 0.95 MCQ");
});

test("multiplier: rebuilt from the ledger when the server sent no sentence", () => {
  const model = multiplierModel(tile({
    penalty: { cues: 0, mcqs: 1, human_geocodes: 1, multiplier: 0.475 },
    ledger: [{ kind: "mcq" }, { kind: "geocode" }], ledger_text: undefined,
  }));
  assert.equal(model.full, "x0.475 = 0.95 MCQ x 0.5 geocode");
  assert.equal(multiplierModel(tile({ ledger_text: undefined })).full, "x1.0 (no penalties)");
  assert.equal(multiplierModel(null).text, "x1.0");
});

// ---------------------------------------------------------------- flags and order

test("flags are built from the inbox items of the panorama", () => {
  const asked = tile({ status: "awaiting_mcq", pending_mcq: { id: "q1", question: "?", remaining_s: 47 }, _at: NOW });
  const run = { run_id: "r1", state: "running", active: true, owned: true, export: { problems: {} }, panoramas: [asked], _at: NOW };
  const [item] = attentionItems({ runs: new Map([["r1", run]]) }, NOW);
  const flag = flagModel(item);
  assert.equal(flag.kind, "mcq");
  assert.equal(flag.tone, "attn");
  assert.equal(flag.icon, "question");
  assert.equal(flag.text, "MCQ waiting: 0:47 left");
  assert.equal(flag.href, "/runs/r1/p1?open=mcq");
  assert.equal(flagModel({ id: "x", kind: "something_new", title: "New", href: "/" }).tone, "warn");
});

test("default order: Special One first, then Urban, then non-Urban, stable", () => {
  const tiles = [
    tile({ panorama_id: "n1", label: "non-Urban" }),
    tile({ panorama_id: "u1" }),
    tile({ panorama_id: "s", label: "non-Urban", special: true }),
    tile({ panorama_id: "u2" }),
  ];
  assert.deepEqual(sortTiles(tiles).map((t) => t.panorama_id), ["s", "u1", "u2", "n1"]);
  assert.deepEqual(tiles.map((t) => t.panorama_id), ["n1", "u1", "s", "u2"], "the input is not reordered");
});

test("attention order: flagged tiles first by urgency, then by what a review could still gain", () => {
  const tiles = [
    tile({ panorama_id: "sure", expected_score: { value: 15000, max: 16050, share: 0.93 } }),
    tile({ panorama_id: "unsure", expected_score: { value: 4000, max: 16050, share: 0.25 } }),
    tile({ panorama_id: "special", special: true, expected_score: { value: 40000, max: 48150, share: 0.83 } }),
    tile({ panorama_id: "asked" }),
    tile({ panorama_id: "failing" }),
  ];
  const items = [
    { run_id: "r1", panorama_id: "asked", kind: "mcq" },
    { run_id: "r1", panorama_id: "failing", kind: "api" },
    { run_id: "other", panorama_id: "sure", kind: "mcq" },
  ];
  assert.deepEqual(sortTiles(tiles, { sort: "attention", items }).map((t) => t.panorama_id),
    ["asked", "failing", "unsure", "special", "sure"]);
});

test("review gain: nothing left on a final tile without a proxy, everything on one with no belief", () => {
  assert.equal(reviewGain(tile({ expected_score: null, final: tenOf(1, 2) })), 0);
  assert.equal(reviewGain(tile({ expected_score: null })), 16050);
  assert.equal(reviewGain(tile({ expected_score: null, special: true })), 48150);
  assert.equal(reviewGain(tile()), 6420);
});

// ---------------------------------------------------------------- board row wording, spend

test("human window: the short form keeps the time left whole", () => {
  assert.equal(humanWindow(tile(), 100).short, "window closes in 11:50");
  assert.equal(humanWindow(tile(), 811).short, "cue window closed");
  assert.equal(humanWindow(tile({ status: "pending" }), 0).short, "window opens at start");
  assert.equal(humanWindow(tile({ live: false, active: false }), 100).short, "human channels closed");
  const final = tile({ status: "done", final: tenOf(1, 2), origin: "agent" });
  assert.equal(humanWindow(final, 300).short, "closed; x0.5 geocode only");
  assert.equal(humanWindow({ ...final, named_places: [] }, 300).short, "window closed");
  assert.equal(humanWindow({ ...final, origin: "human_geocode" }, 300).short, "closed; geocode used");
  for (const state of [tile(), final, tile({ status: "pending" }), tile({ budget: null, human_window: null })]) {
    assert.equal(typeof humanWindow(state, 10).short, "string");
  }
});

test("flags: the board form carries the countdown of a question and of a closing window", () => {
  const mcq = flagModel({ id: "a", kind: "mcq", title: "MCQ waiting", detail: "0:47 left", seconds_left: 47, href: "/runs/r/p?open=mcq" });
  assert.equal(mcq.short, "MCQ waiting: 0:47 left");
  const closing = flagModel({ id: "b", kind: "window", title: "Human window closing", detail: "cue window shuts in 1:20", seconds_left: 80, href: "/x" });
  assert.equal(closing.short, "Cue window shuts in 1:20");
  assert.equal(flagModel({ id: "c", kind: "window", title: "Human window closing", detail: "closed", seconds_left: 0, href: "/x" }).short, "Cue window closed");
  assert.equal(flagModel({ id: "d", kind: "fallback", title: "Fallback answer", detail: "hard deadline", seconds_left: null, href: "/x" }).short, "Fallback answer");
});

test("spend: against the cap, flagged near it only while the panorama can still spend", () => {
  assert.deepEqual(spendModel(tile({ spend_usd: 0.42 })), { text: "$0.42 of $8.00", share: 0.42 / 8, near: false });
  assert.equal(spendModel(tile({ spend_usd: 7 })).near, true);
  assert.equal(spendModel(tile({ spend_usd: 7, final: tenOf(1, 2) })).near, false);
  assert.deepEqual(spendModel(tile({ spend_usd: 1.5, budget: null })), { text: "$1.50", share: null, near: false });
  assert.equal(spendModel(tile()), null);
  assert.equal(spendModel(null), null);
});

test("answer: the plan is not repeated when there is no list to plan", () => {
  assert.equal(answerModel(tile({ provisional: [], plan_text: "no answer yet" })).planText, "");
  assert.equal(answerModel(tile()).planText, "hedge off: best point repeated");
});

test("answer: the list of an interrupted panorama is not called changeable, nor final", () => {
  const stranded = answerModel(tile({ live: false, active: false, stop_text: "server stopped while this panorama was running" }));
  assert.equal(stranded.state, "stranded");
  assert.equal(stranded.title, "Last provisional answer");
  assert.equal(stranded.stateText, "not final: rebuild the exports to keep it");
  assert.equal(stranded.stopText, "server stopped while this panorama was running");
  assert.equal(answerModel(tile()).stateText, "provisional: can still change");
  assert.equal(answerModel(tile({ status: "done", final: tenOf(1, 2), origin: "agent" })).stateText, "final");
  assert.equal(answerModel(tile({ live: false, provisional: [] })).state, "none");
  // A replay shows the state the log had: a past provisional list was still changeable then.
  assert.equal(answerModel(tile({ live: false }), { replay: true }).state, "provisional");
});

test("multiplier: the board form counts the charges", () => {
  assert.equal(multiplierModel(tile()).brief, "");
  const helped = tile({ penalty: { cues: 2, mcqs: 1, human_geocodes: 0, multiplier: 0.608 }, ledger_text: "x0.608 = 0.8 cue x 0.95 MCQ x 0.8 cue" });
  assert.equal(multiplierModel(helped).brief, "2 cues, 1 MCQ");
  assert.equal(multiplierModel(tile({ penalty: { cues: 0, mcqs: 0, human_geocodes: 1, multiplier: 0.5 } })).brief, "1 geocode");
  assert.equal(multiplierModel(null).brief, "");
});
