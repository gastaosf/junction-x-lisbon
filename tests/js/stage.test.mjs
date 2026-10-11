import test from "node:test";
import assert from "node:assert/strict";

import {
  activityLine,
  clockState,
  collapseEntries,
  cropView,
  endCard,
  freshCrops,
  guessKey,
  lastCropNumber,
  listLines,
  panoramaChoices,
  parseTruth,
  pickPanorama,
  presenterProblems,
  reasoningText,
  shownTruth,
  stagePhase,
  stepPanorama,
  tickerState,
  topGuess,
  truthAvailability,
  truthFrame,
  truthSettled,
  viewerSources,
  worldZoom,
  zoomForRadius,
} from "../../server/static/console/js/logic/stage.js";

function tile(pid, extra = {}) {
  return {
    run_id: "r1", panorama_id: pid, label: "Urban", special: false, status: "running", active: true, live: true,
    hypotheses: [], provisional: [], final: null, origin: null, turns: 3, elapsed_s: 40,
    penalty: { cues: 0, mcqs: 0, human_geocodes: 0, multiplier: 1 },
    budget: { effort: "medium", soft_deadline_s: 150, hard_deadline_s: 210, max_turns: 20, max_spend_usd: 2 },
    crops: [], activity: null, last_reasoning: null, stop_text: "", ...extra,
  };
}

const entries = (points) => points.map(([lat, lng], i) => ({ rank: i + 1, lat, lng, multiplier: 1, origin: "agent" }));
const repeat = (point, n) => Array.from({ length: n }, () => point);

const run = (extra = {}) => ({
  run_id: "r1", no_human: true, fake_model: false, stage_truth: {},
  totals: { penalties: { cues: 0, mcqs: 0, human_geocodes: 0 } }, ...extra,
});

// ---------------------------------------------------------------- which panorama

test("the panorama asked for in the URL wins when the run has it", () => {
  const tiles = [tile("a", { special: true }), tile("b"), tile("c")];
  assert.equal(pickPanorama(tiles, "c").panorama_id, "c");
});

test("without a choice the Special One is shown, else the first running one, else the first", () => {
  assert.equal(pickPanorama([tile("a"), tile("b", { special: true })], null).panorama_id, "b");
  const done = { status: "done", active: false, final: entries([[1, 2]]) };
  assert.equal(pickPanorama([tile("a", done), tile("b"), tile("c")], null).panorama_id, "b");
  assert.equal(pickPanorama([tile("a", done), tile("b", done)], null).panorama_id, "a");
});

test("an unknown panorama id falls back to the default and an empty run gives null", () => {
  assert.equal(pickPanorama([tile("a"), tile("b", { special: true })], "zzz").panorama_id, "b");
  assert.equal(pickPanorama([], "a"), null);
  assert.equal(pickPanorama(null, null), null);
});

test("a panorama that is not live is not taken for a running one", () => {
  const stale = tile("a", { status: "running", active: false });
  assert.equal(pickPanorama([tile("x", { status: "pending", active: false }), stale, tile("b")], null).panorama_id, "b");
});

test("the arrow keys step through the panoramas and wrap", () => {
  const tiles = [tile("a"), tile("b"), tile("c")];
  assert.equal(stepPanorama(tiles, "a", 1), "b");
  assert.equal(stepPanorama(tiles, "c", 1), "a");
  assert.equal(stepPanorama(tiles, "a", -1), "c");
  assert.equal(stepPanorama(tiles, "gone", 1), "a");
  assert.equal(stepPanorama([tile("a")], "a", 1), null);
});

test("picker lines name the Special One, the label and the status in words", () => {
  const lines = panoramaChoices([tile("p1", { special: true }), tile("p2", { label: "non-Urban", status: "awaiting_mcq" })]);
  assert.deepEqual(lines, [
    { pid: "p1", text: "p1 (Special One) · Urban · running" },
    // A pending question is the operator's business: the stage only says the panorama is running.
    { pid: "p2", text: "p2 · non-Urban · running" },
  ]);
});

// ---------------------------------------------------------------- phase and clock

test("phases follow the tile", () => {
  assert.equal(stagePhase(tile("a", { status: "pending" })), "waiting");
  assert.equal(stagePhase(tile("a")), "running");
  assert.equal(stagePhase(tile("a", { status: "awaiting_mcq" })), "running");
  assert.equal(stagePhase(tile("a", { status: "interrupted", active: false })), "interrupted");
  assert.equal(stagePhase(tile("a", { status: "done", final: entries([[1, 2]]) })), "final");
  assert.equal(stagePhase(null), "waiting");
});

test("the clock counts down to the hard deadline", () => {
  const state = clockState(tile("a"), 40);
  assert.equal(state.seconds, 170);
  assert.equal(state.tone, "ok");
  assert.equal(state.label, "Time left");
  assert.equal(state.note, "");
  assert.ok(Math.abs(state.share - 40 / 210) < 1e-9);
  assert.ok(Math.abs(state.soft_share - 150 / 210) < 1e-9);
});

test("the clock says so in words after the soft deadline, near the end and past it", () => {
  // Past the soft deadline (150 s) but outside the last stretch (a quarter of 210 s = 52.5 s).
  assert.deepEqual(
    [clockState(tile("a"), 155).tone, clockState(tile("a"), 155).note],
    ["soft", "Past the soft deadline, wrapping up"],
  );
  const late = clockState(tile("a"), 200);
  assert.equal(late.tone, "warn");
  assert.equal(late.seconds, 10);
  assert.equal(late.note, "Almost out of time");
  const over = clockState(tile("a"), 230);
  assert.deepEqual([over.tone, over.seconds, over.share], ["over", 0, 1]);
  assert.match(over.note, /Deadline reached/);
});

test("on a long budget the warning starts at one minute", () => {
  const long = tile("a", { budget: { soft_deadline_s: 420, hard_deadline_s: 600 } });
  assert.equal(clockState(long, 530).tone, "soft");
  assert.equal(clockState(long, 541).tone, "warn");
});

test("the clock shows the budget while waiting and the elapsed time once final or interrupted", () => {
  const waiting = clockState(tile("a", { status: "pending" }), 0);
  assert.deepEqual([waiting.seconds, waiting.tone, waiting.label], [210, "idle", "Waiting to start"]);
  const done = clockState(tile("a", { status: "done", final: entries([[1, 2]]) }), 161.4);
  assert.deepEqual([done.seconds, done.tone, done.label], [161.4, "final", "Finished in"]);
  const stopped = clockState(tile("a", { status: "interrupted" }), 75);
  assert.deepEqual([stopped.seconds, stopped.tone, stopped.label], [75, "stopped", "Interrupted after"]);
});

test("without a hard deadline the clock counts up", () => {
  const state = clockState(tile("a", { budget: null }), 12);
  assert.deepEqual([state.seconds, state.label, state.share], [12, "Elapsed", null]);
});

// ---------------------------------------------------------------- belief, crops, ticker

test("the top guess is the most probable hypothesis, wherever it sits in the list", () => {
  const guess = topGuess([
    { lat: 1, lng: 2, probability: 0.2, label: "A", radius_m: 100 },
    { lat: 38.7169, lng: -9.1399, probability: 0.7, label: "Lisbon", radius_m: 300 },
    { lat: null, lng: 4, probability: 0.9, label: "broken" },
  ]);
  assert.deepEqual(guess, { index: 1, label: "Lisbon", probability: 0.7, lat: 38.7169, lng: -9.1399, radius_m: 300 });
  assert.equal(topGuess([]), null);
  assert.equal(topGuess(undefined), null);
});

test("a guess only counts as moved when it moved by more than a few metres", () => {
  const a = guessKey({ lat: 38.71690, lng: -9.13990 });
  assert.equal(a, guessKey({ lat: 38.71692, lng: -9.13988 }));
  assert.notEqual(a, guessKey({ lat: 38.7269, lng: -9.1399 }));
  assert.equal(guessKey(null), null);
});

test("the map zooms out as the uncertainty grows", () => {
  assert.equal(zoomForRadius(500), 14);
  assert.equal(zoomForRadius(4000), 11);
  assert.equal(zoomForRadius(40), 16);
  assert.equal(zoomForRadius(5_000_000), 4);
  assert.equal(zoomForRadius(null), 11);
  assert.equal(zoomForRadius(0), 11);
});

test("before there is a hypothesis the world fills the map pane, whatever the screen", () => {
  assert.equal(worldZoom(1280 * 0.42, 720 * 0.68), 2);
  assert.equal(worldZoom(1920 * 0.42, 1080 * 0.68), 2);
  assert.equal(worldZoom(3840 * 0.42, 2160 * 0.68), 3);
  assert.equal(worldZoom(0, 0), 1);
  assert.equal(worldZoom(undefined, null), 1);
  assert.equal(worldZoom(100000, 100000), 4);
});

test("only crops that were not flashed yet are fresh", () => {
  const crops = [{ n: 1, yaw: 10 }, { n: 3, yaw: 30 }, { n: 2, yaw: 20 }, { yaw: 5 }];
  assert.deepEqual(freshCrops(crops, 1).map((c) => c.n), [2, 3]);
  assert.deepEqual(freshCrops(crops, 3), []);
  assert.equal(lastCropNumber(crops), 3);
  assert.equal(lastCropNumber(null), 0);
});

test("the camera turns to a crop with room around it", () => {
  assert.deepEqual(cropView({ yaw: 200, pitch: -5, fov: 30 }), { yaw: 200, pitch: -5, fov: 72 });
  assert.equal(cropView({ yaw: 0, pitch: 0, fov: 10 }).fov, 55);
  assert.equal(cropView({ yaw: 0, pitch: 0, fov: 90 }).fov, 100);
});

test("viewer sources go from small to the full image and never upscale", () => {
  const url = (w) => "/img?w=" + w;
  assert.deepEqual(viewerSources(tile("a", { image: { width: 6080, height: 3040 } }), url), [
    { width: 1024, url: "/img?w=1024" }, { width: 2048, url: "/img?w=2048" },
    { width: 4096, url: "/img?w=4096" }, { width: 6080, url: "/img?w=full" },
  ]);
  assert.deepEqual(viewerSources(tile("a", { image: { width: 2048, height: 1024 } }), url).map((s) => s.width), [1024, 2048]);
  assert.deepEqual(viewerSources(tile("a", { image: null }), url).map((s) => s.width), [1024, 2048, 4096]);
});

test("the ticker uses the server's sentence and only stands in when it is missing", () => {
  const given = activityLine(tile("a", { activity: { text: "Searching OpenStreetMap for a church", tool: "overpass_query", seq: 9 } }));
  assert.deepEqual(given, { text: "Searching OpenStreetMap for a church", tool: "overpass_query", seq: 9, fallback: false });
  assert.deepEqual(activityLine(tile("a")), { text: "Working", tool: null, seq: null, fallback: true });
  assert.equal(activityLine(tile("a", { status: "pending" })).text, "Waiting to start");
  assert.equal(activityLine(tile("a", { activity: { text: "   " } })).fallback, true);
  assert.equal(reasoningText(tile("a", { last_reasoning: { text: " The tram is yellow. " } })), "The tram is yellow.");
  assert.equal(reasoningText(tile("a")), "");
});

test("the bottom of the stage shows the activity and the reasoning while the panorama runs", () => {
  const state = tickerState(tile("a", {
    activity: { text: "Comparing street-level imagery", tool: "streetview_lookup", seq: 12 },
    last_reasoning: { text: "Two candidates remain.", seq: 11 },
  }));
  assert.deepEqual(state, {
    headline: "Comparing street-level imagery", tool: "streetview_lookup", seq: 12,
    caption: "Latest reasoning", body: "Two candidates remain.", asking: false,
  });
});

test("an open question is only noted, never shown, and only while the panorama runs", () => {
  const question = { id: "q1", question: "Which street is it?", options: ["Rua A", "Rua B"], remaining_s: 60 };
  const asking = tickerState(tile("a", { status: "awaiting_mcq", pending_mcq: question }));
  assert.equal(asking.asking, true);
  // Nothing of the question travels into what the stage renders.
  assert.equal(JSON.stringify(asking).includes("Rua A"), false);
  assert.equal(JSON.stringify(asking).includes("Which street"), false);
  assert.equal(tickerState(tile("a")).asking, false);
  assert.equal(tickerState(tile("a", { status: "interrupted", active: false, pending_mcq: question })).asking, false);
});

test("an interrupted panorama says what happened, as a sentence", () => {
  const state = tickerState(tile("a", {
    status: "interrupted", active: false,
    stop_text: "server stopped while this panorama was running; Rebuild exports recovers its last provisional list",
    activity: { text: "Checking satellite imagery", tool: "satellite_tile", seq: 4 },
  }));
  assert.equal(state.headline, "Interrupted before it finished");
  assert.equal(state.caption, "What happened");
  assert.match(state.body, /^Server stopped while this panorama was running/);
  assert.equal(state.tool, null);
  assert.equal(tickerState(tile("a", { status: "interrupted", stop_text: null })).body, "");
});

// ---------------------------------------------------------------- end card

test("ten copies of one point collapse to the line the brief shows", () => {
  assert.deepEqual(listLines(entries(repeat([38.7169, -9.1399], 10))), ["10 x 38.716900, -9.139900"]);
});

test("a hedged list keeps its order and its ranks", () => {
  const list = entries([...repeat([38.7169, -9.1399], 7), ...repeat([41.1496, -8.611], 3)]);
  assert.deepEqual(listLines(list), ["7 x 38.716900, -9.139900", "3 x 41.149600, -8.611000"]);
  assert.deepEqual(collapseEntries(list).map((g) => [g.first_rank, g.last_rank]), [[1, 7], [8, 10]]);
});

test("the same point at separate ranks is not merged across another point", () => {
  const list = entries([[1, 1], [2, 2], [1, 1]]);
  assert.deepEqual(collapseEntries(list).map((g) => g.count), [1, 1, 1]);
});

test("points that differ below the sixth decimal are one point", () => {
  assert.equal(collapseEntries(entries([[38.7169, -9.1399], [38.71690000001, -9.1399]])).length, 1);
});

test("the end card states the point, the list, the time and where the answer came from", () => {
  const card = endCard(tile("a", {
    status: "done", active: false, final: entries(repeat([38.7169, -9.1399], 10)), origin: "agent",
    elapsed_s: 161.4, turns: 9, stop_text: "the agent submitted its answer",
  }));
  assert.equal(card.point_text, "38.716900, -9.139900");
  assert.deepEqual(card.lines, ["10 x 38.716900, -9.139900"]);
  assert.deepEqual([card.elapsed_s, card.turns, card.entries, card.multiplier], [161.4, 9, 10, 1]);
  assert.equal(card.origin_text, "Submitted by the agent");
  assert.equal(card.fallback, false);
  assert.equal(card.stop_text, "the agent submitted its answer");
});

test("a fallback answer is called a fallback, and there is no card before the answer is final", () => {
  const card = endCard(tile("a", { final: entries([[0, 0]]), origin: "harness_fallback" }));
  assert.equal(card.fallback, true);
  assert.match(card.origin_text, /Fallback/);
  assert.equal(endCard(tile("a")), null);
  assert.equal(endCard(tile("a", { final: [] })), null);
  assert.equal(endCard(null), null);
});

// ---------------------------------------------------------------- reveal truth: when

const finalTile = (extra = {}) => tile("a", { status: "done", active: false, final: entries(repeat([38.7169, -9.1399], 10)), ...extra });

test("the truth can be revealed after final on a run with human channels off", () => {
  assert.deepEqual(truthAvailability(run(), finalTile()), { available: true, reason: "" });
});

test("the truth is unavailable while the panorama is running, with the reason", () => {
  const out = truthAvailability(run(), tile("a"));
  assert.equal(out.available, false);
  assert.match(out.reason, /running/);
  assert.match(truthAvailability(run(), tile("a", { status: "pending" })).reason, /once this panorama has run/);
  assert.match(truthAvailability(run(), tile("a", { status: "interrupted", active: false })).reason, /interrupted/);
});

test("the truth is never available beside a human channel", () => {
  const assisted = truthAvailability(run({ no_human: false }), finalTile());
  assert.equal(assisted.available, false);
  assert.match(assisted.reason, /human channels are on/);
  const charged = run({ totals: { penalties: { cues: 1, mcqs: 0, human_geocodes: 0 } } });
  assert.equal(truthAvailability(charged, finalTile()).available, false);
  assert.equal(truthAvailability(null, null).available, false);
});

test("a stored truth is shown only after final and only with human channels off", () => {
  const note = { lat: 38.72, lng: -9.14, distance_m: 350, theta: 0.8, score: 12000, max_score: 16050, share: 0.75 };
  const withNote = run({ stage_truth: { a: note } });
  assert.deepEqual(shownTruth(withNote, finalTile(), null), note);
  assert.equal(shownTruth(withNote, tile("a"), null), null);
  assert.equal(shownTruth(run({ no_human: false, stage_truth: { a: note } }), finalTile(), null), null);
  assert.equal(shownTruth(run({ stage_truth: null }), finalTile(), null), null);
  assert.equal(shownTruth(run(), finalTile(), null), null);
});

test("what this tab just sent wins until the server's note carries the same point", () => {
  const old = { lat: 38.72, lng: -9.14, distance_m: 350 };
  const sent = { lat: 38.7301, lng: -9.1502, distance_m: 1900 };
  assert.deepEqual(shownTruth(run({ stage_truth: { a: old } }), finalTile(), sent), sent);
  assert.equal(truthSettled(run({ stage_truth: { a: old } }), "a", sent), false);
  const caughtUp = run({ stage_truth: { a: { ...sent, at: "2026-10-11T10:00:00Z" } } });
  assert.equal(truthSettled(caughtUp, "a", sent), true);
  assert.equal(shownTruth(caughtUp, finalTile(), sent).at, "2026-10-11T10:00:00Z");
  assert.equal(truthSettled(run({ stage_truth: null }), "a", sent), false);
});

test("the answer and the truth are framed together with room for their labels", () => {
  const answer = { lat: 40.20942, lng: -8.42948 };
  const truth = { lat: 40.2056, lng: -8.4196 };
  const frame = truthFrame([answer, truth], 537, 428);
  assert.ok(Math.abs(frame.lat - 40.20751) < 1e-5 && Math.abs(frame.lng - -8.42454) < 1e-5);
  // 840 m across at this latitude must take no more than half of the 537 px pane.
  const metresPerPx = (156543.03392 * Math.cos((frame.lat * Math.PI) / 180)) / 2 ** frame.zoom;
  assert.ok(840 / metresPerPx <= 537 * 0.5, "too tight at zoom " + frame.zoom);
  assert.ok(840 / (metresPerPx / 2) > 537 * 0.5, "one zoom level closer would still fit");
  // A larger pane allows a closer view.
  assert.ok(truthFrame([answer, truth], 1612, 1400).zoom > frame.zoom);
});

test("a truth on the answer is shown at street level, and a far one is left to the map", () => {
  const here = { lat: 38.7169, lng: -9.1399 };
  assert.deepEqual(truthFrame([here, here], 800, 700), { lat: 38.7169, lng: -9.1399, zoom: 17 });
  assert.equal(truthFrame([here, { lat: -33.8688, lng: 151.2093 }], 800, 700), null);
  assert.equal(truthFrame([here, { lat: 38.7, lng: -9.1 }], 0, 0), null);
  assert.equal(truthFrame([], 800, 700), null);
  // Every distinct point of a hedged list is inside the frame, not only the first.
  const hedged = truthFrame([here, { lat: 41.1496, lng: -8.611 }, { lat: 38.72, lng: -9.14 }], 800, 700);
  assert.ok(hedged.zoom <= 7 && hedged.lat > 39.5 && hedged.lat < 40.5);
});

// ---------------------------------------------------------------- reveal truth: reading the input

const reads = (text, lat, lng) => {
  const out = parseTruth(text);
  assert.equal(out.ok, true, text + " -> " + out.problem);
  assert.ok(Math.abs(out.lat - lat) < 1e-6 && Math.abs(out.lng - lng) < 1e-6, text + " -> " + out.lat + ", " + out.lng);
};
const refuses = (text, pattern) => {
  const out = parseTruth(text);
  assert.equal(out.ok, false, text + " was read as " + out.lat + ", " + out.lng);
  assert.ok(out.problem.length > 10);
  if (pattern) assert.match(out.problem, pattern);
};

test("plain decimal pairs are read whatever the separator", () => {
  for (const text of [
    "38.7169, -9.1399", "38.7169,-9.1399", "38.7169 -9.1399", "  38.7169 ;  -9.1399 ", "38.7169\t-9.1399",
    "(38.7169, -9.1399)", "[38.7169, -9.1399]", "38.7169, -9.1399.", "+38.7169, -9.1399",
  ]) reads(text, 38.7169, -9.1399);
  reads("38, -9", 38, -9);
  reads("38.5,9", 38.5, 9);
  reads("-33.8688, 151.2093", -33.8688, 151.2093);
});

test("the result carries six decimals and the text the page shows", () => {
  const out = parseTruth("38.71690049, -9.13990051");
  assert.deepEqual(out, { ok: true, lat: 38.7169, lng: -9.139901, text: "38.716900, -9.139901" });
});

test("a typographic minus is a minus", () => {
  reads("38.7169, −9.1399", 38.7169, -9.1399);
  reads("38.7169, –9.1399", 38.7169, -9.1399);
  // A dash with a space after it separates the numbers instead.
  reads("38.7169 – 9.1399", 38.7169, 9.1399);
});

test("decimal commas are read when both numbers have decimals", () => {
  reads("38,7169; -9,1399", 38.7169, -9.1399);
  reads("38,7169 -9,1399", 38.7169, -9.1399);
  reads("38,7169, -9,1399", 38.7169, -9.1399);
});

test("labels are read, in either order", () => {
  reads("lat 38.7169 lng -9.1399", 38.7169, -9.1399);
  reads("Latitude: 38.7169, Longitude: -9.1399", 38.7169, -9.1399);
  reads("lat=38.7169, lon=-9.1399", 38.7169, -9.1399);
  reads("lng: -9.1399, lat: 38.7169", 38.7169, -9.1399);
  reads("long -9.1399 lat 38.7169", 38.7169, -9.1399);
});

test("compass letters set the sign and the order", () => {
  reads("38.7169 N, 9.1399 W", 38.7169, -9.1399);
  reads("38.7169N 9.1399W", 38.7169, -9.1399);
  reads("N 38.7169, W 9.1399", 38.7169, -9.1399);
  reads("N38.7169 W9.1399", 38.7169, -9.1399);
  reads("9.1399 W 38.7169 N", 38.7169, -9.1399);
  reads("33.8688 s 151.2093 e", -33.8688, 151.2093);
  reads("38.7169° N, 9.1399° W", 38.7169, -9.1399);
  reads("38,7169 N 9,1399 W", 38.7169, -9.1399);
});

test("degrees, minutes and seconds are read", () => {
  reads("38°43'00.8\"N 9°08'23.6\"W", 38 + 43 / 60 + 0.8 / 3600, -(9 + 8 / 60 + 23.6 / 3600));
  reads("38°43′00.8″N 9°08′23.6″W", 38 + 43 / 60 + 0.8 / 3600, -(9 + 8 / 60 + 23.6 / 3600));
  reads("38° 43.0133' N, 9° 8.3933' W", 38 + 43.0133 / 60, -(9 + 8.3933 / 60));
  reads("38°43'0.8\", -9°8'23.6\"", 38 + 43 / 60 + 0.8 / 3600, -(9 + 8 / 60 + 23.6 / 3600));
  reads("38.7169°, -9.1399°", 38.7169, -9.1399);
  reads("38 deg 43' N 9 deg 8' W", 38 + 43 / 60, -(9 + 8 / 60));
  // South of the equator by less than a degree: the sign must survive a zero degree part.
  reads("-0° 30' 0\", 10° 0' 0\"", -0.5, 10);
});

test("what cannot be coordinates is refused in plain words", () => {
  refuses("", /latitude and the longitude/);
  refuses("   ");
  refuses("Lisbon", /does not read as coordinates/);
  refuses("https://example.com/?q=38.7169,-9.1399", /does not read as coordinates/);
  refuses("38.7169", /only one number/);
  refuses("38.7169, -9.1399, 12", /3 numbers/);
  refuses("1e5, 3");
  refuses("x".repeat(200), /too long/);
});

test("out-of-range numbers are refused with the way out", () => {
  refuses("-122.4194, 37.7749", /swap the two/);
  refuses("38.7169, 190", /longitude must be between -180 and 180/);
  refuses("91 N 10 E", /between -90 and 90/);
});

test("contradictory or incomplete compass input is refused", () => {
  refuses("-38.7169 N, 9.1399 W", /not both/);
  refuses("38.7169 N, 9.1399", /compass letter/);
  refuses("38.7169 N 9.1399 S", /N or S and the other E or W/);
  refuses("38 N 9 W 4 E");
  refuses("38° 75' N, 9° 8' W");
  refuses("38 1 2 3 N 9 W", /minutes and seconds/);
});

test("nothing typed can become anything but two numbers", () => {
  for (const text of ["<img src=x onerror=1>", "38.7169, -9.1399 near the cathedral", "javascript:alert(1)", "38.7169, -9.1399\n hint: Baixa"]) {
    assert.equal(parseTruth(text).ok, false, text);
  }
  const out = parseTruth("38.7169, -9.1399");
  assert.deepEqual(Object.keys(out).sort(), ["lat", "lng", "ok", "text"]);
  assert.equal(typeof out.lat, "number");
  assert.equal(typeof out.lng, "number");
});

// ---------------------------------------------------------------- presenter overlay

test("the presenter overlay lists what is wrong and nothing when all is well", () => {
  assert.deepEqual(presenterProblems(run(), tile("a")), []);
  const problems = presenterProblems(
    run({ fake_model: true }),
    tile("a", { api_trouble: true, api_trouble_text: "429 from the model API; retrying in 4 s", export_problems: "missing final_submission" }),
    { connected: false },
  );
  assert.equal(problems.length, 4);
  assert.match(problems[0], /connection to the server is down/);
  assert.match(problems[1], /demo model/);
  assert.equal(problems[2], "429 from the model API; retrying in 4 s");
  assert.match(problems[3], /missing final_submission/);
  const fallback = presenterProblems(run(), tile("a", { origin: "harness_fallback", stop_text: "the model API failed" }));
  assert.deepEqual(fallback, ["The answer is the harness fallback: the model API failed"]);
  const stopped = presenterProblems(run(), tile("a", { status: "interrupted", active: false, stop_text: "server stopped while this panorama was running" }));
  assert.deepEqual(stopped, ["Server stopped while this panorama was running"]);
});
