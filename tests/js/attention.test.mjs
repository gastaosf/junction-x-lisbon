import test from "node:test";
import assert from "node:assert/strict";

import {
  attentionFor,
  attentionItems,
  mcqTitle,
  oldestPendingMcq,
} from "../../server/static/console/js/logic/attention.js";

const NOW = 5_000_000;

// A healthy running tile: nothing about it needs a human.
function tile(pid, extra = {}) {
  return {
    run_id: "r1", panorama_id: pid, label: "Urban", special: false, status: "running", active: true, live: true,
    hypotheses: [{ lat: 1, lng: 2, probability: 0.6 }], final: null, origin: null,
    penalty: { cues: 0, mcqs: 0, human_geocodes: 0, multiplier: 1 }, pending_mcq: null,
    human_enabled: true, human_window: { cue_closes_at_s: 570, mcq_closes_at_s: 540 },
    elapsed_s: 60, spend_usd: 0.2,
    budget: { effort: "medium", soft_deadline_s: 420, hard_deadline_s: 600, max_turns: 40, max_spend_usd: 2 },
    first_candidates_t_rel_s: 31, api_trouble: false, api_trouble_text: null,
    fallback_acknowledged: false, export_problems: null, last_seq: 12, _at: NOW, ...extra,
  };
}

function stateOf(tiles, runExtra = {}) {
  const run = {
    run_id: "r1", state: "running", active: true, owned: true,
    export: { written_at: null, stale: false, problems: {} }, panoramas: tiles, _at: NOW, ...runExtra,
  };
  return { runs: new Map([[run.run_id, run]]), jobs: new Map(), health: null };
}

const kinds = (state, now = NOW) => attentionItems(state, now).map((it) => it.kind);

test("a healthy run raises nothing", () => {
  assert.deepEqual(attentionItems(stateOf([tile("p1"), tile("p2")]), NOW), []);
});

test("MCQ waiting: raised with seconds left, cleared when answered or timed out", () => {
  const asked = tile("p1", { status: "awaiting_mcq", pending_mcq: { id: "q7", question: "?", remaining_s: 47 } });
  const [item] = attentionItems(stateOf([asked]), NOW);
  assert.equal(item.kind, "mcq");
  assert.equal(item.run_id, "r1");
  assert.equal(item.panorama_id, "p1");
  assert.equal(item.seconds_left, 47);
  assert.equal(item.href, "/runs/r1/p1?open=mcq");
  assert.equal(item.id, "mcq:r1:p1:q7");
  assert.match(item.text, /MCQ waiting: p1 \(0:47 left\)/);

  const later = attentionItems(stateOf([asked]), NOW + 40_000)[0];
  assert.equal(later.seconds_left, 7, "the countdown ticks locally");

  assert.deepEqual(kinds(stateOf([tile("p1", { status: "running", pending_mcq: null })])), []);
});

test("MCQ waiting is not raised for a tile that is no longer active", () => {
  const dead = tile("p1", { status: "interrupted", active: false, pending_mcq: { id: "q", remaining_s: 30 } });
  assert.deepEqual(kinds(stateOf([dead])), []);
});

test("human window closing: raised under 120 s to the hard deadline, cleared when final", () => {
  const far = tile("p1", { elapsed_s: 479 });
  assert.deepEqual(kinds(stateOf([far])), [], "121 s left is not yet closing");

  const near = tile("p1", { elapsed_s: 500 });
  const [item] = attentionItems(stateOf([near]), NOW);
  assert.equal(item.kind, "window");
  assert.equal(item.seconds_left, 70, "seconds until the cue window shuts (570 - 500)");
  assert.equal(item.href, "/runs/r1/p1?open=cue");

  assert.equal(attentionItems(stateOf([far]), NOW + 10_000)[0].kind, "window", "raised by the local clock alone");

  const shut = attentionItems(stateOf([tile("p1", { elapsed_s: 590 })]), NOW)[0];
  assert.equal(shut.seconds_left, 0);
  assert.match(shut.text, /closed/);

  const final = tile("p1", { elapsed_s: 500, status: "done", active: false, final: [{ rank: 1, origin: "agent" }], origin: "agent" });
  assert.deepEqual(kinds(stateOf([final])), []);
});

test("human window closing needs human channels on", () => {
  const auto = tile("p1", { elapsed_s: 550, human_enabled: false, human_window: null });
  assert.deepEqual(kinds(stateOf([auto])), []);
});

test("fallback answer: raised on a final fallback list until acknowledged, also on a finished run", () => {
  const fallback = tile("p1", {
    status: "done", active: false, origin: "harness_fallback", stop_text: "hard deadline: fallback point used",
    final: [{ rank: 1, lat: 0, lng: 0, origin: "harness_fallback" }],
  });
  const finished = { state: "finished", active: false };
  const [item] = attentionItems(stateOf([fallback], finished), NOW);
  assert.equal(item.kind, "fallback");
  assert.equal(item.href, "/runs/r1/p1?open=ack");
  assert.equal(item.seconds_left, null);
  assert.match(item.text, /hard deadline/);

  const byEntry = tile("p1", { status: "done", active: false, origin: null, final: [{ rank: 1, origin: "harness_fallback" }] });
  assert.deepEqual(kinds(stateOf([byEntry], finished)), ["fallback"], "the entries' origin counts too");

  assert.deepEqual(kinds(stateOf([{ ...fallback, fallback_acknowledged: true }], finished)), []);
  const agent = tile("p1", { status: "done", active: false, origin: "agent", final: [{ rank: 1, origin: "agent" }] });
  assert.deepEqual(kinds(stateOf([agent], finished)), []);
});

test("API failing: raised from api_trouble, cleared at the next successful turn", () => {
  const failing = tile("p1", { api_trouble: true, api_trouble_text: "3 retries in 60 s" });
  const [item] = attentionItems(stateOf([failing]), NOW);
  assert.equal(item.kind, "api");
  assert.equal(item.href, "/runs/r1/p1?filter=errors");
  assert.match(item.text, /3 retries in 60 s/);
  assert.deepEqual(kinds(stateOf([tile("p1", { api_trouble: false })])), []);
  assert.deepEqual(kinds(stateOf([{ ...failing, active: false, status: "done", final: [{ origin: "agent" }] }])), []);
});

test("invalid export: raised from run.export.problems, cleared when the export is valid", () => {
  const done = (pid) => tile(pid, { status: "done", active: false, origin: "agent", final: [{ rank: 1, origin: "agent" }] });
  const broken = stateOf([done("p1"), done("p2")], {
    state: "invalid", active: false, export: { written_at: "x", stale: false, problems: { p2: "9 locations, expected 10" } },
  });
  const [item] = attentionItems(broken, NOW);
  assert.equal(item.kind, "export");
  assert.equal(item.panorama_id, "p2");
  assert.equal(item.href, "/runs/r1/submit");
  assert.match(item.text, /9 locations/);

  const two = stateOf([done("p1"), done("p2")], { active: false, export: { problems: { p1: "a", p2: "b" } } });
  const many = attentionItems(two, NOW)[0];
  assert.equal(many.panorama_id, null);
  assert.match(many.text, /2 panoramas/);

  const viaTile = stateOf([{ ...done("p1"), export_problems: "lat out of range" }], { active: false });
  assert.deepEqual(kinds(viaTile), ["export"], "a tile's own export_problems counts");

  const valid = stateOf([done("p1"), done("p2")], { state: "finished", active: false, export: { problems: {} } });
  assert.deepEqual(kinds(valid), []);
});

test("no hypothesis yet: raised after 3 minutes without a candidates update, cleared by the first", () => {
  const blank = { hypotheses: [], first_candidates_t_rel_s: null };
  assert.deepEqual(kinds(stateOf([tile("p1", { ...blank, elapsed_s: 179 })])), []);
  const [item] = attentionItems(stateOf([tile("p1", { ...blank, elapsed_s: 180 })]), NOW);
  assert.equal(item.kind, "no_hypothesis");
  assert.equal(item.href, "/runs/r1/p1");
  assert.deepEqual(kinds(stateOf([tile("p1", { ...blank, elapsed_s: 170 })]), NOW + 10_000), ["no_hypothesis"]);

  assert.deepEqual(kinds(stateOf([tile("p1", { elapsed_s: 400, first_candidates_t_rel_s: 181 })])), []);
  assert.deepEqual(kinds(stateOf([tile("p1", { ...blank, elapsed_s: 400, status: "pending" })])), [], "a queued tile is not running");
});

test("spend near cap: raised above 80% of max_spend_usd, cleared when final", () => {
  assert.deepEqual(kinds(stateOf([tile("p1", { spend_usd: 1.6 })])), [], "exactly 80% is not above");
  const [item] = attentionItems(stateOf([tile("p1", { spend_usd: 1.7 })]), NOW);
  assert.equal(item.kind, "spend");
  assert.equal(item.href, "/runs/r1/p1");
  assert.match(item.text, /85% of \$2\.00/);
  const final = tile("p1", { spend_usd: 1.9, status: "done", active: false, origin: "agent", final: [{ origin: "agent" }] });
  assert.deepEqual(kinds(stateOf([final])), []);
  assert.deepEqual(kinds(stateOf([tile("p1", { spend_usd: 5, budget: { hard_deadline_s: 600, max_spend_usd: null } })])), []);
});

test("items are sorted most urgent first", () => {
  const state = stateOf([
    tile("slow", { hypotheses: [], first_candidates_t_rel_s: null, elapsed_s: 200 }),
    tile("rich", { spend_usd: 1.9 }),
    tile("fell", { status: "done", active: false, origin: "harness_fallback", final: [{ origin: "harness_fallback" }] }),
    tile("flaky", { api_trouble: true }),
    tile("late", { elapsed_s: 560 }),
    tile("ask2", { status: "awaiting_mcq", pending_mcq: { id: "b", remaining_s: 80 } }),
    tile("ask1", { status: "awaiting_mcq", pending_mcq: { id: "a", remaining_s: 20 } }),
  ], { export: { problems: { fell: "bad" } } });
  const items = attentionItems(state, NOW);
  assert.deepEqual(items.map((it) => it.kind), ["mcq", "mcq", "window", "api", "export", "fallback", "spend", "no_hypothesis"]);
  assert.deepEqual(items.slice(0, 2).map((it) => it.panorama_id), ["ask1", "ask2"], "least time left first");
});

test("the Special One wins a tie", () => {
  const state = stateOf([tile("a", { api_trouble: true }), tile("z", { api_trouble: true, special: true })]);
  assert.deepEqual(attentionItems(state, NOW).map((it) => it.panorama_id), ["z", "a"]);
});

test("ids in links are URL-encoded and every item has the contract fields", () => {
  const odd = tile("pano 1/a", { status: "awaiting_mcq", pending_mcq: { id: "q", remaining_s: 5 }, run_id: "run #1" });
  const state = stateOf([odd], { run_id: "run #1" });
  const [item] = attentionItems(state, NOW);
  assert.equal(item.href, "/runs/run%20%231/pano%201%2Fa?open=mcq");
  for (const key of ["id", "kind", "run_id", "panorama_id", "text", "seconds_left", "href"]) {
    assert.ok(key in item, "missing " + key);
  }
});

test("helpers: oldest pending MCQ, tab title, per-panorama filter", () => {
  const state = stateOf([
    tile("p1", { status: "awaiting_mcq", pending_mcq: { id: "a", remaining_s: 61 } }),
    tile("p2", { status: "awaiting_mcq", pending_mcq: { id: "b", remaining_s: 47 }, api_trouble: true }),
  ]);
  assert.equal(oldestPendingMcq(state, NOW).panorama_id, "p2");
  assert.equal(mcqTitle(state, NOW), "(2) MCQ 0:47");
  assert.equal(mcqTitle(stateOf([tile("p1")]), NOW), null);
  assert.equal(oldestPendingMcq(stateOf([tile("p1")]), NOW), null);

  const items = attentionItems(state, NOW);
  assert.deepEqual(attentionFor(items, "r1", "p2").map((it) => it.kind), ["mcq", "api"]);
  assert.equal(attentionFor(items, "r1").length, 3);
  assert.equal(attentionFor(items, "other").length, 0);
});

test("the order of one kind holds still while the seconds tick", () => {
  // Two questions asked a fraction of a second apart. Rounded to whole seconds they tie at some
  // moments and not at others, which used to make them change places every half second.
  const asking = (pid, remaining, extra = {}) =>
    tile(pid, { status: "awaiting_mcq", pending_mcq: { id: "m-" + pid, question: "?", remaining_s: remaining }, ...extra });
  const state = stateOf([asking("special", 40.9, { special: true }), asking("urban", 40.2), asking("later", 70)]);
  const orders = new Set();
  for (let ms = 0; ms <= 45_000; ms += 100) {
    orders.add(attentionItems(state, NOW + ms).map((it) => it.panorama_id).join(","));
  }
  assert.deepEqual([...orders], ["urban,special,later"], "least time left first, at every moment");
  assert.equal(oldestPendingMcq(state, NOW + 250).panorama_id, "urban");
  assert.equal(mcqTitle(state, NOW + 250), "(3) MCQ 0:40");

  // A tile that is refreshed by the stream (new stamp, less time left) keeps its place too.
  const refreshed = stateOf([
    asking("special", 40.9, { special: true }),
    asking("urban", 30.2, { _at: NOW + 10_000 }),
    asking("later", 70),
  ]);
  assert.deepEqual(attentionItems(refreshed, NOW + 10_050).map((it) => it.panorama_id), ["urban", "special", "later"]);
});

test("closing windows are ordered by when they shut, not by rounded seconds", () => {
  const closing = (pid, elapsed) => tile(pid, { elapsed_s: elapsed });
  const state = stateOf([closing("a", 500.4), closing("b", 500.9), closing("c", 485)]);
  const orders = new Set();
  for (let ms = 0; ms <= 20_000; ms += 250) {
    orders.add(attentionItems(state, NOW + ms).filter((it) => it.kind === "window").map((it) => it.panorama_id).join(","));
  }
  assert.deepEqual([...orders], ["b,a,c"]);
});

test("every item says when its countdown runs out, or null", () => {
  const state = stateOf([
    tile("ask", { status: "awaiting_mcq", pending_mcq: { id: "q", remaining_s: 47 } }),
    tile("flaky", { api_trouble: true }),
  ]);
  const [mcq, api] = attentionItems(state, NOW + 5_000);
  assert.equal(mcq.due_ms, NOW + 47_000, "fixed by the tile's own stamp, whatever the time of asking");
  assert.equal(mcq.seconds_left, 42);
  assert.equal(api.due_ms, null);
});
