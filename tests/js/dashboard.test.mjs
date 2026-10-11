import test from "node:test";
import assert from "node:assert/strict";

import { attentionItems } from "../../server/static/console/js/logic/attention.js";
import {
  DENSITIES,
  SORTS,
  clockModel,
  clockStart,
  confirmWords,
  controlReasons,
  controlStates,
  displayOrder,
  effortText,
  focusTarget,
  gridSummary,
  headerTotals,
  isReadOnly,
  orderTiles,
  otherSort,
  parseClockTime,
  parseView,
  phaseStrip,
  runBanner,
  runFacts,
  timeInputValue,
  toggleFocus,
  watchdogModel,
} from "../../server/static/console/js/logic/dashboard.js";

const NOW = Date.parse("2026-10-11T10:07:42.000Z");

const PHASES = [
  { key: "launch", label: "Launch", start_min: 0, end_min: 2 },
  { key: "autonomous", label: "Autonomous pass", start_min: 2, end_min: 12 },
  { key: "special", label: "Special One", start_min: 12, end_min: 26 },
  { key: "others", label: "Other panoramas", start_min: 26, end_min: 52 },
  { key: "freeze", label: "Freeze", start_min: 52, end_min: 55 },
  { key: "submit", label: "Submit", start_min: 55, end_min: 60 },
];

const tenOf = (lat, lng, origin = "agent") =>
  Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, lat, lng, multiplier: 1, origin }));

// A running tile of an assisted run, shaped as runstate.LogFold.tile() returns it.
function tile(pid, extra = {}) {
  return {
    run_id: "r1", panorama_id: pid, filename: pid + ".jpg", label: "Urban", special: false,
    status: "running", active: true, live: true, human_enabled: true,
    hypotheses: [{ lat: 38.7, lng: -9.1, probability: 0.6, radius_m: 200, label: "Lisbon" }],
    provisional: tenOf(38.7, -9.1), final: null,
    penalty: { cues: 0, mcqs: 0, human_geocodes: 0, multiplier: 1 },
    pending_mcq: null, elapsed_s: 100, spend_usd: 0.5, turns: 4,
    budget: { soft_deadline_s: 600, hard_deadline_s: 840, max_turns: 30, max_spend_usd: 8 },
    human_window: { cue_closes_at_s: 810, mcq_closes_at_s: 740 },
    expected_score: { value: 9000, max: 16050, share: 0.56 },
    first_candidates_t_rel_s: 20, api_trouble: false, export_problems: null,
    fallback_acknowledged: false, origin: null, _at: NOW,
    ...extra,
  };
}

const done = (pid, extra = {}) => tile(pid, {
  status: "done", active: false, final: tenOf(38.7, -9.1), origin: "agent", ...extra,
});

function run(extra = {}) {
  const panoramas = extra.panoramas || [tile("p1"), tile("p2")];
  return {
    run_id: "r1", kind: "scoring", preset: "scoring", mode: "assisted", state: "running",
    owned: true, active: true, external: false, model: "gpt-x", effort: { standard: "high", special: "xhigh" },
    started_at: "2026-10-11T10:00:00.000Z", clock_started_at: "2026-10-11T10:00:00.000Z",
    elapsed_s: 462, watchdog_s: 3000, watchdog_remaining_s: 2538, phases: PHASES,
    totals: {
      done: 0, total: panoramas.length, spend_usd: 1, spend_cap_usd: 16, expected_score: 18000,
      expected_score_max: 32100, lowest_multiplier: 1, penalties: { cues: 0, mcqs: 0, human_geocodes: 0 },
    },
    special_present: false, no_human: false, fake_model: false,
    export: { written_at: null, stale: false, problems: {} },
    ...extra,
    panoramas,
  };
}

const stateOf = (...runs) => ({ runs: new Map(runs.map((r) => [r.run_id, r])) });
const ids = (tiles) => tiles.map((t) => t.panorama_id);

// ---------------------------------------------------------------- view

test("parseView reads the three keys of the URL contract", () => {
  const query = new URLSearchParams("density=board&sort=attention&pano=p%203");
  assert.deepEqual(parseView(query), { density: "board", sort: "attention", pano: "p 3" });
});

test("parseView falls back to the preference, then to tiles and the default order", () => {
  assert.deepEqual(parseView(new URLSearchParams("")), { density: "tiles", sort: "default", pano: null });
  assert.deepEqual(parseView(new URLSearchParams(""), { density: "focus", sort: "attention" }),
    { density: "focus", sort: "attention", pano: null });
  // An unknown value is not trusted, and neither is an unknown preference.
  assert.deepEqual(parseView(new URLSearchParams("density=huge&sort=random"), { density: "x", sort: null }),
    { density: "tiles", sort: "default", pano: null });
  // The URL wins over the preference.
  assert.equal(parseView(new URLSearchParams("density=tiles"), { density: "board" }).density, "tiles");
  assert.deepEqual(DENSITIES, ["board", "tiles", "focus"]);
  assert.deepEqual(SORTS, ["default", "attention"]);
});

test("the sort toggles, and f goes into focus and back to where the operator came from", () => {
  assert.equal(otherSort("default"), "attention");
  assert.equal(otherSort("attention"), "default");
  assert.equal(toggleFocus("tiles", null), "focus");
  assert.equal(toggleFocus("board", "tiles"), "focus");
  assert.equal(toggleFocus("focus", "board"), "board");
  assert.equal(toggleFocus("focus", null), "tiles");
  assert.equal(toggleFocus("focus", "focus"), "tiles");
});

// ---------------------------------------------------------------- order

test("default order: Special One first, then Urban, then non-Urban, otherwise as the server sent them", () => {
  const tiles = [
    tile("n1", { label: "non-Urban" }),
    tile("u1"),
    tile("s", { special: true, label: "non-Urban" }),
    tile("u2"),
    tile("n2", { label: "non-Urban" }),
  ];
  assert.deepEqual(ids(orderTiles(tiles)), ["s", "u1", "u2", "n1", "n2"]);
  assert.deepEqual(ids(orderTiles(tiles, { sort: "default", items: [{ run_id: "r1", panorama_id: "n2" }] })),
    ["s", "u1", "u2", "n1", "n2"]);
  assert.deepEqual(ids(tiles), ["n1", "u1", "s", "u2", "n2"], "the input is not reordered");
});

test("attention order agrees with the inbox: same items, same urgency", () => {
  const tiles = [
    tile("calm"),
    tile("asking", { status: "awaiting_mcq", pending_mcq: { id: "m1", question: "?", options: ["a", "b"], remaining_s: 40 } }),
    tile("failing", { api_trouble: true, api_trouble_text: "3 retries" }),
    done("fallback", { origin: "harness_fallback", final: tenOf(0, 0, "harness_fallback") }),
  ];
  const r = run({ panoramas: tiles });
  const items = attentionItems(stateOf(r), NOW);
  const inbox = items.map((item) => item.panorama_id);
  const order = ids(orderTiles(tiles, { sort: "attention", items, run: r }));
  assert.deepEqual(order.slice(0, inbox.length), inbox);
  assert.deepEqual(order, ["asking", "failing", "fallback", "calm"]);
});

test("attention order does not swap two tiles of the same urgency as their seconds tick", () => {
  const asking = (pid, remaining, extra = {}) =>
    tile(pid, { status: "awaiting_mcq", pending_mcq: { id: "m-" + pid, question: "?", options: ["a", "b"], remaining_s: remaining }, ...extra });
  // Two questions a fraction of a second apart. The inbox orders them by the moment each runs
  // out (attention.js), not by the rounded seconds on screen, so it no longer puts the Special
  // One first at one moment and the other tile first half a second later.
  const tiles = [asking("special", 40.9, { special: true }), asking("urban", 40.2), tile("calm")];
  const r = run({ panoramas: tiles });
  const early = attentionItems(stateOf(r), NOW);
  const late = attentionItems(stateOf(r), NOW + 500);
  assert.deepEqual(early.map((item) => item.panorama_id), ["urban", "special"]);
  assert.deepEqual(late.map((item) => item.panorama_id), ["urban", "special"]);

  // Without an order on screen the grid follows the inbox.
  assert.deepEqual(ids(orderTiles(tiles, { sort: "attention", items: early, run: r })), ["urban", "special", "calm"]);
  // And whatever the inbox says, what is on screen stays where it is.
  const shown = ["special", "urban", "calm"];
  const second = ids(orderTiles(tiles, { sort: "attention", items: late, run: r, previous: shown }));
  assert.deepEqual(second, shown, "what is on screen stays where it is");
});

test("attention order: a newly raised item moves its tile up, behind the tiles already in that group", () => {
  const asking = (pid, remaining) =>
    tile(pid, { status: "awaiting_mcq", pending_mcq: { id: "m-" + pid, question: "?", options: ["a", "b"], remaining_s: remaining } });
  const before = [asking("a", 60), tile("b"), tile("c", { api_trouble: true })];
  const r1 = run({ panoramas: before });
  const shown = ids(orderTiles(before, { sort: "attention", items: attentionItems(stateOf(r1), NOW), run: r1 }));
  assert.deepEqual(shown, ["a", "c", "b"]);
  // b now asks too, with less time left than a: it joins the group without displacing a.
  const after = [asking("a", 60), asking("b", 20), tile("c", { api_trouble: true })];
  const r2 = run({ panoramas: after });
  const items = attentionItems(stateOf(r2), NOW);
  assert.deepEqual(items.map((item) => item.panorama_id), ["b", "a", "c"]);
  assert.deepEqual(ids(orderTiles(after, { sort: "attention", items, run: r2, previous: shown })), ["a", "b", "c"]);
  // A panorama added late, already asking, goes behind those on screen.
  const more = [...after, asking("new", 5)];
  const r3 = run({ panoramas: more });
  assert.deepEqual(ids(orderTiles(more, { sort: "attention", items: attentionItems(stateOf(r3), NOW), run: r3, previous: ["a", "b", "c"] })),
    ["a", "b", "new", "c"]);
  // Items of another run never reorder this one.
  const foreign = [{ kind: "mcq", run_id: "other", panorama_id: "b" }];
  assert.deepEqual(ids(orderTiles([tile("a"), tile("b")], { sort: "attention", items: foreign, run: run() })), ["a", "b"]);
});

test("attention order: without an item, the tile a review could gain most on comes first", () => {
  const tiles = [
    tile("sure", { expected_score: { value: 15000, max: 16050 } }),
    tile("unsure", { expected_score: { value: 4000, max: 16050 } }),
    tile("special", { special: true, expected_score: { value: 30000, max: 48150 } }),
    done("finished", { expected_score: { value: 16000, max: 16050 } }),
  ];
  assert.deepEqual(ids(orderTiles(tiles, { sort: "attention", items: [] })), ["special", "unsure", "sure", "finished"]);
});

test("attention order: an export problem raised for the whole run reaches each affected panorama", () => {
  const tiles = [done("a"), done("b", { export_problems: "9 entries" }), done("c")];
  const r = run({ panoramas: tiles, state: "finished", active: false, export: { problems: { b: "9 entries", c: "lat out of range" } } });
  const items = attentionItems(stateOf(r), NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].panorama_id, null, "the inbox raises one item for the run");
  assert.deepEqual(ids(orderTiles(tiles, { sort: "attention", items, run: r })), ["b", "c", "a"]);
});

test("displayOrder holds the order while the operator is typing, and still shows new panoramas", () => {
  assert.deepEqual(displayOrder(["a", "b", "c"], ["c", "a", "b"], false), ["c", "a", "b"]);
  assert.deepEqual(displayOrder(["a", "b", "c"], ["c", "a", "b"], true), ["a", "b", "c"]);
  assert.deepEqual(displayOrder(["a", "b", "c"], ["d", "c", "a"], true), ["a", "c", "d"]);
  assert.deepEqual(displayOrder([], ["b", "a"], true), ["b", "a"]);
  assert.deepEqual(displayOrder(null, null, true), []);
});

test("focusTarget: the asked panorama, else the one already shown, else the first of the order", () => {
  const ordered = [tile("s", { special: true }), tile("u1"), tile("u2")];
  assert.deepEqual(focusTarget(ordered, "u2", "u1"), { pid: "u2", missing: null });
  assert.deepEqual(focusTarget(ordered, null, "u1"), { pid: "u1", missing: null });
  assert.deepEqual(focusTarget(ordered, null, null), { pid: "s", missing: null });
  // A link to a panorama that is not in the run: say so, show something that exists.
  assert.deepEqual(focusTarget(ordered, "gone", "u1"), { pid: "u1", missing: "gone" });
  assert.deepEqual(focusTarget(ordered, "gone", null), { pid: "s", missing: "gone" });
  // The shown panorama left the run.
  assert.deepEqual(focusTarget(ordered, null, "removed"), { pid: "s", missing: null });
  // Nothing loaded yet is not a missing panorama.
  assert.deepEqual(focusTarget([], "p1", null), { pid: null, missing: null });
});

test("a run this server does not hold is read-only", () => {
  assert.equal(isReadOnly(run()), false);
  assert.equal(isReadOnly(run({ owned: false })), true);
  assert.equal(isReadOnly(run({ owned: true, active: false, state: "finished" })), false);
  assert.equal(isReadOnly(null), true);
});

test("gridSummary names the Special One and counts the labels", () => {
  const tiles = [tile("s", { special: true }), tile("u1"), tile("u2"), tile("n1", { label: "non-Urban" })];
  assert.equal(gridSummary(tiles), "4 panoramas: Special One s, 2 Urban, 1 non-Urban");
  assert.equal(gridSummary([tile("u1")]), "1 panorama: 1 Urban");
  assert.equal(gridSummary([tile("x", { label: null })]), "1 panorama: 1 without a label");
  assert.equal(gridSummary([]), "No panoramas");
});

// ---------------------------------------------------------------- clock

test("the scoring clock counts against the 60 minutes of the phase guide", () => {
  const model = clockModel(run(), 7 * 60 + 42);
  assert.equal(model.scoring, true);
  assert.equal(model.limitS, 3600);
  assert.equal(model.text, "07:42 of 1:00:00");
  assert.equal(model.detail, "52:18 left");
  assert.equal(model.tone, "ok");
  assert.equal(model.over, false);
  assert.equal(model.ticking, true);
});

test("the scoring clock warns in the freeze and turns bad past the hour", () => {
  assert.equal(clockModel(run(), 53 * 60).tone, "warn");
  assert.equal(clockModel(run(), 58 * 60).tone, "warn");
  const over = clockModel(run(), 62 * 60 + 10);
  assert.equal(over.over, true);
  assert.equal(over.tone, "bad");
  assert.equal(over.detail, "over by 02:10");
});

test("a clock that is not ticking says so", () => {
  const ended = clockModel(run({ state: "finished", active: false }), 300);
  assert.equal(ended.ticking, false);
  assert.equal(ended.tone, "dim");
  assert.equal(ended.detail, "stopped, 55:00 left");
  assert.equal(clockModel(run({ state: "queued" }), 0).detail, "not started, 1:00:00 left");
});

test("a run without a phase guide shows the plain clock", () => {
  const model = clockModel(run({ phases: null, preset: "autonomous" }), 3725);
  assert.equal(model.scoring, false);
  assert.equal(model.text, "1:02:05");
  assert.equal(model.limitS, null);
  assert.equal(model.detail, "");
  assert.equal(clockModel(run({ phases: null, state: "finished", active: false }), 60).detail, "stopped");
  assert.equal(clockModel(null, null).text, "00:00");
});

test("phaseStrip marks past, current and future phases", () => {
  const strip = phaseStrip(run(), 14 * 60);
  assert.equal(strip.current, "special");
  assert.equal(strip.totalMin, 60);
  assert.deepEqual(strip.phases.map((p) => p.state), ["past", "past", "current", "future", "future", "future"]);
  assert.deepEqual(strip.phases.map((p) => p.range), ["0–2", "2–12", "12–26", "26–52", "52–55", "55–60"]);
  const special = strip.phases[2];
  assert.ok(Math.abs(special.fraction - 2 / 14) < 1e-9);
  assert.equal(special.leftS, 12 * 60);
  assert.equal(strip.phases[0].fraction, 1);
  assert.equal(strip.phases[0].leftS, null);
  assert.equal(strip.phases[3].fraction, 0);
  assert.equal(strip.text, "Now: Special One, 12:00 left in this phase.");
  assert.ok(Math.abs(strip.fraction - 14 / 60) < 1e-9);
});

test("phaseStrip: a boundary belongs to the phase that starts there", () => {
  assert.equal(phaseStrip(run(), 0).current, "launch");
  assert.equal(phaseStrip(run(), 120).current, "autonomous");
  assert.equal(phaseStrip(run(), 119.9).current, "launch");
  assert.equal(phaseStrip(run(), 52 * 60).current, "freeze");
});

test("phaseStrip past the hour, on a stopped run, and without phases", () => {
  const over = phaseStrip(run(), 61 * 60);
  assert.equal(over.over, true);
  assert.equal(over.current, null);
  assert.ok(over.phases.every((p) => p.state === "past"));
  assert.equal(over.text, "Past the 60 minutes of the guide: submit now.");
  assert.equal(over.fraction, 1);
  const stopped = phaseStrip(run({ state: "finished", active: false }), 5 * 60);
  assert.equal(stopped.text, "The clock stopped in the phase Autonomous pass.");
  assert.equal(stopped.ticking, false);
  assert.equal(stopped.phases[1].state, "current");
  assert.equal(stopped.phases[1].leftS, null, "no time left is shown on a clock that is not running");
  assert.equal(phaseStrip(run({ phases: null }), 100), null);
  assert.equal(phaseStrip(run({ phases: [] }), 100), null);
});

test("phaseStrip tolerates phases out of order and ignores broken ones", () => {
  const messy = [PHASES[2], PHASES[0], { key: "bad", label: "Bad", start_min: 5, end_min: 5 }, PHASES[1]];
  const strip = phaseStrip(run({ phases: messy }), 3 * 60);
  assert.deepEqual(strip.phases.map((p) => p.key), ["launch", "autonomous", "special"]);
  assert.equal(strip.current, "autonomous");
  assert.equal(strip.totalMin, 26);
});

test("the watchdog countdown, only for an active run that has one", () => {
  const model = watchdogModel(run(), 38 * 60 + 12);
  assert.equal(model.text, "everything is finalised in 38:12");
  assert.equal(model.tone, "dim");
  assert.match(model.title, /50 min 00 s after launch/);
  assert.equal(watchdogModel(run(), 299).tone, "warn");
  assert.equal(watchdogModel(run(), 45).tone, "bad");
  assert.equal(watchdogModel(run(), 0).text, "the watchdog is finalising everything now");
  assert.equal(watchdogModel(run(), null), null);
  assert.equal(watchdogModel(run({ active: false }), 100), null);
  assert.equal(watchdogModel(null, 100), null);
});

test("clockStart tells a clock set by hand from the launch time", () => {
  const atLaunch = clockStart(run());
  assert.equal(atLaunch.custom, false);
  assert.match(atLaunch.text, /^The clock counts from the launch, at \d\d:\d\d:\d\d\.$/);
  const moved = clockStart(run({ clock_started_at: "2026-10-11T10:02:00.000Z" }));
  assert.equal(moved.custom, true);
  assert.match(moved.text, /set by hand\. The run was launched at/);
  // The same moment written two ways is not a change.
  assert.equal(clockStart(run({ clock_started_at: "2026-10-11T10:00:00Z" })).custom, false);
  assert.equal(clockStart(run({ clock_started_at: null })).iso, null);
});

test("parseClockTime reads a local time of day as the moment nearest to now", () => {
  const now = new Date(2026, 9, 11, 10, 7, 42).getTime();
  const earlier = parseClockTime("10:00", now);
  assert.equal(earlier.ms, new Date(2026, 9, 11, 10, 0, 0).getTime());
  assert.equal(earlier.future, false);
  assert.equal(earlier.iso, new Date(earlier.ms).toISOString());
  const seconds = parseClockTime("10:00:30", now);
  assert.equal(seconds.ms, new Date(2026, 9, 11, 10, 0, 30).getTime());
  const later = parseClockTime("10:30", now);
  assert.equal(later.future, true);
  assert.equal(later.ms, new Date(2026, 9, 11, 10, 30, 0).getTime());
});

test("parseClockTime crosses midnight towards the nearest day", () => {
  const justAfter = new Date(2026, 9, 11, 0, 10, 0).getTime();
  assert.equal(parseClockTime("23:55", justAfter).ms, new Date(2026, 9, 10, 23, 55, 0).getTime());
  const justBefore = new Date(2026, 9, 11, 23, 50, 0).getTime();
  assert.equal(parseClockTime("00:05", justBefore).ms, new Date(2026, 9, 12, 0, 5, 0).getTime());
});

test("parseClockTime refuses what is not a time", () => {
  for (const bad of ["", "now", "25:00", "10:60", "10:00:61", "10", "10:0", null, undefined]) {
    assert.equal(parseClockTime(bad, NOW), null, String(bad));
  }
});

test("timeInputValue is the local time of an ISO string, or empty", () => {
  const iso = new Date(2026, 9, 11, 9, 58, 41).toISOString();
  assert.equal(timeInputValue(iso), "09:58:41");
  assert.equal(timeInputValue(null), "");
  assert.equal(timeInputValue("nonsense"), "");
  // What the input shows parses back to the same moment.
  assert.equal(parseClockTime(timeInputValue(iso), new Date(2026, 9, 11, 10, 30, 0).getTime()).iso, iso);
});

// ---------------------------------------------------------------- facts and totals

test("runFacts: kind, mode badge, model, effort and the demo mark", () => {
  const facts = runFacts(run({ special_present: true }));
  assert.equal(facts.kind, "Scoring");
  assert.equal(facts.mode.text, "ASSISTED");
  assert.equal(facts.model, "gpt-x");
  assert.equal(facts.effort, "effort high, Special One xhigh");
  assert.equal(facts.demo, false);
  const auto = runFacts(run({ kind: "training", preset: "autonomous", mode: "autonomous", fake_model: true, model: null }));
  assert.equal(auto.kind, "Training · autonomous preset");
  assert.equal(auto.mode.text, "AUTONOMOUS");
  assert.equal(auto.model, "model not recorded");
  assert.equal(auto.demo, true);
});

test("effortText leaves the Special One effort out when there is none to apply it to", () => {
  assert.equal(effortText(run({ special_present: false })), "effort high");
  assert.equal(effortText(run({ special_present: true, effort: { standard: "high", special: "high" } })), "effort high");
  assert.equal(effortText(run({ effort: { standard: "high", special: null } })), "effort high");
  assert.equal(effortText(run({ effort: null })), "");
});

test("headerTotals counts from the tiles it holds", () => {
  const tiles = [
    tile("s", { special: true, spend_usd: 1.25, expected_score: { value: 30000, max: 48150 } }),
    tile("a", { status: "awaiting_mcq", pending_mcq: { id: "m" }, penalty: { cues: 1, mcqs: 1, human_geocodes: 0, multiplier: 0.76 } }),
    tile("q", { status: "pending", spend_usd: 0, expected_score: null, hypotheses: [], provisional: [] }),
    done("d", { spend_usd: 0.75, penalty: { cues: 0, mcqs: 2, human_geocodes: 0, multiplier: 0.9025 } }),
  ];
  const totals = headerTotals(run({ panoramas: tiles, totals: { spend_cap_usd: 39, expected_score_max: 96300, done: 0, total: 4 } }));
  assert.equal(totals.done, 1);
  assert.equal(totals.total, 4);
  assert.equal(totals.open, 3);
  assert.equal(totals.progress.value, "1 / 4 final");
  assert.equal(totals.progress.detail, "1 running, 1 waiting for your answer, 1 queued");
  assert.equal(totals.progress.tone, "attn");
  assert.equal(totals.spend.value, "$2.50");
  assert.equal(totals.spend.detail, "of $39.00 in caps (6%)");
  assert.ok(Math.abs(totals.spend.share - 2.5 / 39) < 1e-9);
  assert.equal(totals.proxy.value, "48,000");
  assert.equal(totals.proxy.detail, "of 96,300 (50%), not a score");
  assert.match(totals.proxy.title, /agent's own belief, not a\s+score/);
  assert.equal(totals.penalties.value, "1 cue, 3 MCQs");
  assert.equal(totals.penalties.detail, "lowest multiplier x0.76");
  assert.equal(totals.penalties.tone, "cut");
});

test("headerTotals: all final, no penalties, autonomous", () => {
  const r = run({ panoramas: [done("a"), done("b")], mode: "autonomous", no_human: true, state: "finished", active: false });
  const totals = headerTotals(r);
  assert.equal(totals.progress.value, "2 / 2 final");
  assert.equal(totals.progress.detail, "every panorama has its final answer");
  assert.equal(totals.progress.tone, "ok");
  assert.equal(totals.open, 0);
  assert.equal(totals.penalties.value, "none used");
  assert.equal(totals.penalties.detail, "human channels are off");
  assert.equal(headerTotals(run({ panoramas: [done("a")] })).penalties.detail, "every panorama at x1.0");
});

test("headerTotals: a read-only run shows the status the log has, interrupted included", () => {
  const tiles = [
    done("a", { live: false }),
    tile("b", { live: false, active: false, status: "interrupted" }),
    tile("c", { live: false, active: false, status: "running" }),
  ];
  const totals = headerTotals(run({ owned: false, active: false, state: "interrupted", panoramas: tiles }));
  assert.equal(totals.progress.value, "1 / 3 final");
  assert.equal(totals.progress.detail, "1 running, 1 interrupted");
  assert.equal(totals.progress.tone, "warn");
});

test("headerTotals falls back to run.totals without tiles, and to the tile budgets without a cap", () => {
  const bare = headerTotals({
    run_id: "r1", owned: true, panoramas: [],
    totals: { done: 2, total: 6, spend_usd: 1.5, spend_cap_usd: 48, expected_score: 20000, expected_score_max: 128400, lowest_multiplier: 0.8, penalties: { cues: 1, mcqs: 0, human_geocodes: 0 } },
  });
  assert.equal(bare.progress.value, "2 / 6 final");
  assert.equal(bare.spend.value, "$1.50");
  assert.equal(bare.spend.detail, "of $48.00 in caps (3%)");
  assert.equal(bare.proxy.value, "20,000");
  assert.equal(bare.penalties.value, "1 cue");
  assert.equal(bare.penalties.lowest, 0.8);

  const noCap = headerTotals(run({ totals: {}, panoramas: [tile("a"), tile("b")] }));
  assert.equal(noCap.spend.detail, "of $16.00 in caps (6%)");
  assert.equal(noCap.proxy.detail, "of 32,100 (56%), not a score");
  const unknown = headerTotals(run({ totals: {}, panoramas: [tile("a", { budget: null })] }));
  assert.equal(unknown.spend.detail, "no cap recorded");
  assert.equal(unknown.spend.share, null);
});

test("headerTotals: before any belief the proxy says so and is never called a score", () => {
  const empty = headerTotals(run({ panoramas: [tile("a", { expected_score: null }), tile("b", { expected_score: null })] }));
  assert.equal(empty.proxy.value, "no belief yet");
  assert.equal(empty.proxy.share, null);
  assert.match(empty.proxy.detail, /not a score/);
  assert.equal(headerTotals(null).progress.value, "0 / 0 final");
  assert.equal(headerTotals(null).progress.detail, "no panoramas");
});

// ---------------------------------------------------------------- controls

test("an active run this server holds can be finalised, stopped and added to", () => {
  const states = controlStates(run());
  assert.deepEqual(states.finalizeAll, { enabled: true, reason: "" });
  assert.deepEqual(states.stop, { enabled: true, reason: "" });
  assert.deepEqual(states.add, { enabled: true, reason: "" });
  assert.deepEqual(controlReasons(states), []);
});

test("a run that is not held by this server cannot be operated, and the reason says what to do", () => {
  const interrupted = controlStates(run({ owned: false, active: false, state: "interrupted" }));
  assert.equal(interrupted.finalizeAll.enabled, false);
  assert.equal(interrupted.stop.enabled, false);
  assert.equal(interrupted.add.enabled, false);
  assert.match(interrupted.stop.reason, /not running in this server process/);
  assert.match(interrupted.stop.reason, /Rebuild exports/);
  const finished = controlStates(run({ owned: false, active: false, state: "finished" }));
  assert.match(finished.finalizeAll.reason, /not running in this server process/);
  assert.match(finished.add.reason, /Launch a new run/);
  const external = controlStates(run({ owned: false, active: false, external: true, state: "running" }));
  assert.match(external.stop.reason, /Another process/);
  assert.equal(external.add.enabled, false);
});

test("an ended run this server holds: nothing to finalise or stop, panoramas can still be added", () => {
  const states = controlStates(run({ active: false, state: "finished", panoramas: [done("a")] }));
  assert.equal(states.finalizeAll.enabled, false);
  assert.match(states.finalizeAll.reason, /has ended/);
  assert.equal(states.stop.enabled, false);
  assert.equal(states.add.enabled, true);
  assert.equal(controlStates(run({ active: false, state: "finished" }), { stopped: true }).add.enabled, false);
  assert.match(controlStates(run(), { stopped: true }).add.reason, /stopped run takes no more panoramas/);
});

test("controls: every panorama final while the run closes, an evaluation run, a run not loaded", () => {
  const closing = controlStates(run({ panoramas: [done("a"), done("b")] }));
  assert.equal(closing.finalizeAll.enabled, false);
  assert.match(closing.finalizeAll.reason, /run is closing/);
  assert.equal(closing.stop.enabled, true);
  const evaluation = controlStates(run({ kind: "eval", preset: "eval" }));
  assert.equal(evaluation.add.enabled, false);
  assert.match(evaluation.add.reason, /evaluation set only/);
  assert.equal(evaluation.stop.enabled, true);
  const none = controlStates(null);
  assert.equal(none.stop.enabled, false);
  assert.equal(none.add.enabled, false);
});

test("controlReasons groups the controls that share a reason", () => {
  const ended = controlReasons(controlStates(run({ active: false, state: "finished", panoramas: [done("a")] })));
  assert.equal(ended.length, 1);
  assert.equal(ended[0].controls, "Finalize all and Stop run");
  assert.match(ended[0].reason, /has ended/);
  const stopped = controlReasons(controlStates(run({ kind: "eval", panoramas: [done("a")] })));
  assert.deepEqual(stopped.map((row) => row.controls), ["Finalize all", "Add panoramas"]);
  for (const record of [{ owned: false, active: false, state: "finished" }, { owned: false, external: true, active: false }]) {
    const all = controlReasons(controlStates(run(record)));
    assert.equal(all.length, 1);
    assert.equal(all[0].controls, "Finalize all, Stop run and Add panoramas");
  }
});

test("the Stop confirmation says exactly what Stop does", () => {
  const words = confirmWords("stop", run({ panoramas: [tile("a"), tile("b", { status: "pending" }), done("c")] }));
  assert.equal(words.title, "Stop run r1?");
  const text = words.lines.join(" ");
  assert.match(text, /^2 of 3 panoramas are not final yet \(1 running, 1 queued\)\./);
  assert.match(text, /Ctrl-C/);
  assert.match(text, /best-so-far list/);
  assert.match(text, /exports are written/);
  assert.match(text, /fallback point for its label/);
  assert.match(text, /no penalty is charged/);
  assert.match(text, /cannot be undone/);
  assert.match(text, /takes no more panoramas/);
  assert.equal(words.okLabel, "Stop the run");
  assert.doesNotMatch(text, /out of date/);
});

test("the Finalize all confirmation counts what it touches and warns when the stream is down", () => {
  const r = run({ panoramas: [tile("a"), done("b")] });
  const words = confirmWords("finalize_all", r, { connected: false });
  assert.equal(words.title, "Finalize all panoramas of r1?");
  assert.equal(words.okLabel, "Finalize all (1)");
  const text = words.lines.join(" ");
  assert.match(text, /^1 of 2 panoramas is not final yet \(1 running\)\./);
  assert.match(text, /agent stops working/);
  assert.match(text, /panoramas can still be added/);
  assert.match(text, /cannot be undone/);
  assert.match(text, /event stream is down/);
});

// ---------------------------------------------------------------- banner

test("no banner while this server is working on the run", () => {
  assert.equal(runBanner(run()), null);
  assert.equal(runBanner(null), null);
});

test("banner of an interrupted run sends the operator to Submission", () => {
  const r = run({ owned: false, active: false, state: "interrupted", panoramas: [done("a", { live: false }), tile("b", { live: false, active: false, status: "interrupted" })] });
  const banner = runBanner(r);
  assert.equal(banner.tone, "warn");
  assert.equal(banner.title, "Interrupted run");
  assert.match(banner.text, /before 1 of 2 panoramas had a final answer/);
  assert.match(banner.text, /Rebuild exports/);
  assert.match(banner.text, /read-only/);
  assert.match(banner.text, /replay/);
  assert.deepEqual(banner.actions, ["submission", "runs"]);
});

test("banner of a finished run read from disk, with and without stale exports", () => {
  const panoramas = [done("a", { live: false })];
  const fresh = runBanner(run({ owned: false, active: false, state: "finished", panoramas }));
  assert.equal(fresh.tone, "info");
  assert.equal(fresh.title, "Finished run, read from disk");
  assert.match(fresh.text, /read-only/);
  assert.match(fresh.text, /replay/);
  const stale = runBanner(run({ owned: false, active: false, state: "finished", panoramas, export: { stale: true, problems: {} } }));
  assert.equal(stale.tone, "warn");
  assert.match(stale.text, /older than the logs/);
});

test("banner of a run that ended in this server, of an external run, of an invalid one", () => {
  const ended = runBanner(run({ active: false, state: "finished", panoramas: [done("a")] }));
  assert.equal(ended.tone, "ok");
  assert.match(ended.text, /last-resort geocode is still available/);
  const auto = runBanner(run({ active: false, state: "finished", mode: "autonomous", no_human: true, panoramas: [done("a")] }));
  assert.doesNotMatch(auto.text, /geocode/);

  const external = runBanner(run({ owned: false, active: false, external: true, state: "running" }));
  assert.equal(external.title, "Running in another process");
  assert.deepEqual(external.actions, ["runs"]);

  const invalid = runBanner(run({ owned: false, active: false, state: "invalid", panoramas: [done("a", { live: false })], export: { problems: { a: "9 entries" } } }));
  assert.equal(invalid.tone, "bad");
  assert.match(invalid.text, /The export of a has a problem\./);
  assert.deepEqual(invalid.actions, ["submission", "runs"]);
  const empty = runBanner({ run_id: "x", owned: false, active: false, state: "invalid", panoramas: [], totals: { total: 0 } });
  assert.match(empty.text, /no log a run can be read from/);
  assert.deepEqual(empty.actions, ["runs"]);

  assert.equal(runBanner(run({ active: false, state: "queued" })).title, "Queued");
});
