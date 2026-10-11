import test from "node:test";
import assert from "node:assert/strict";

import {
  CUE_MIN_REMAINING_S,
  DEFAULT_CUE_MAX_CHARS,
  FACTOR,
  LAST_MCQ_LINGER_S,
  TEXT,
  ackState,
  checkSentence,
  cueClosesIn,
  cueDraft,
  cueLine,
  cueMaxChars,
  cueSendState,
  cueState,
  cueWindowLine,
  describeFailure,
  dialogLock,
  dialogSnapshot,
  distanceM,
  exportState,
  finalizeState,
  geocodeForm,
  geocodeState,
  groupReasons,
  hasFallback,
  humanEnabled,
  hypothesisForPlace,
  isFinal,
  isLive,
  lingerLeft,
  lintItems,
  lintSegments,
  mcqCountdown,
  mcqOutcome,
  mcqView,
  multiplierAfter,
  multiplierLine,
  multiplierNow,
  optionIndexForKey,
  optionLetter,
  parseCoordinate,
  parseCoordinatePair,
  retryState,
  roundCoordinate,
  toggleState,
} from "../../server/static/console/js/logic/controls.js";

const entry = (rank, lat, lng, extra = {}) => ({ rank, lat, lng, multiplier: 1, origin: "agent", ...extra });
const tenOf = (lat, lng, extra) => Array.from({ length: 10 }, (_, i) => entry(i + 1, lat, lng, extra));

const HYPOTHESES = [
  { lat: 38.7169, lng: -9.1399, probability: 0.55, radius_m: 300, label: "Praca do Comercio", evidence: "arcade" },
  { lat: 41.1456, lng: -8.611, probability: 0.3, radius_m: 600, label: "Ribeira", evidence: "river" },
];

// A running tile of an assisted run, shaped as runstate.LogFold.tile() returns it.
function tile(extra = {}) {
  return {
    run_id: "r1", panorama_id: "p1", label: "Urban", special: false,
    status: "running", active: true, live: true,
    hypotheses: HYPOTHESES, provisional: tenOf(38.7169, -9.1399), final: null,
    penalty: { cues: 0, mcqs: 0, human_geocodes: 0, multiplier: 1 },
    multiplier_after: { cue: 0.8, geocode: 0.5 },
    pending_mcq: null, last_mcq: null,
    mcq_allowed: true, mcqs_left: 3, max_mcq: 3,
    named_places: ["Praca do Comercio", "Ribeira"], geocode_enabled: true, human_enabled: true,
    elapsed_s: 100, budget: { hard_deadline_s: 600, soft_deadline_s: 420, max_turns: 40 },
    human_window: { cue_closes_at_s: 570, mcq_closes_at_s: 500 },
    cues: [], origin: null, stop_reason: null, stop_text: "",
    last_seq: 42, retryable: false, fallback_acknowledged: false,
    ...extra,
  };
}

const finalTile = (extra = {}) => tile({
  status: "done", active: false, final: tenOf(38.7169, -9.1399), origin: "agent", stop_reason: "submitted",
  stop_text: "the agent submitted its answer", ...extra,
});

const interrupted = (extra = {}) => tile({
  status: "interrupted", active: false, live: false, pending_mcq: null, human_window: null,
  geocode_enabled: false, ...extra,
});

const question = (extra = {}) => ({
  id: "q1",
  question: "Which river front is this?",
  options: ["Praca do Comercio, facing the Tagus", "Ribeira, facing the Douro", "Neither"],
  why_it_matters: "The two candidates are 270 km apart.",
  timeout_s: 90,
  remaining_s: 60,
  option_places: [
    { index: 0, label: "Praca do Comercio", lat: 38.7169, lng: -9.1399 },
    { index: 1, label: "Ribeira", lat: 41.1456, lng: -8.611 },
    null,
  ],
  ...extra,
});

const ON = { connected: true, elapsed: 100 };

// ---------------------------------------------------------------- tile facts

test("the module loads without a DOM", () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.deepEqual(FACTOR, { mcq: 0.95, cue: 0.8, geocode: 0.5 });
});

test("isLive: a session of this server must be behind the tile", () => {
  assert.equal(isLive(tile()), true);
  assert.equal(isLive(finalTile()), true); // final but still held by this server (geocode stays possible)
  assert.equal(isLive(interrupted()), false);
  assert.equal(isLive(tile({ live: false, status: "done" })), false);
  assert.equal(isLive(null), false);
});

test("isFinal and humanEnabled", () => {
  assert.equal(isFinal(tile()), false);
  assert.equal(isFinal(finalTile()), true);
  assert.equal(isFinal(tile({ status: "done" })), true);
  assert.equal(isFinal(null), false);
  assert.equal(humanEnabled(tile()), true);
  assert.equal(humanEnabled(tile({ human_enabled: false })), false);
  assert.equal(humanEnabled(null), false);
});

test("multipliers: the server's number first, the factor as a fallback", () => {
  const charged = tile({ penalty: { cues: 1, mcqs: 1, human_geocodes: 0, multiplier: 0.76 }, multiplier_after: { cue: 0.608, geocode: 0.38 } });
  assert.equal(multiplierNow(charged), 0.76);
  assert.equal(multiplierAfter(charged, "cue"), 0.608);
  assert.equal(multiplierAfter(charged, "geocode"), 0.38);
  assert.equal(multiplierLine(charged, "cue"), "x0.76 now, x0.608 after");
  const bare = tile({ penalty: { multiplier: 0.95 }, multiplier_after: undefined });
  assert.ok(Math.abs(multiplierAfter(bare, "cue") - 0.76) < 1e-12);
  assert.ok(Math.abs(multiplierAfter(bare, "geocode") - 0.475) < 1e-12);
  assert.equal(multiplierNow(null), 1);
  assert.equal(multiplierNow({ penalty: { multiplier: "0.5" } }), 1); // never trust a non-number
});

test("cueMaxChars comes from the run, with the rule's 1000 as the fallback", () => {
  assert.equal(cueMaxChars({ cue_max_chars: 400 }), 400);
  assert.equal(cueMaxChars(null), DEFAULT_CUE_MAX_CHARS);
  assert.equal(cueMaxChars({ cue_max_chars: 0 }), 1000);
  assert.equal(cueMaxChars({ cue_max_chars: "900" }), 1000);
});

// ---------------------------------------------------------------- cue

test("cueClosesIn: from the human window, else 30 s before the hard deadline", () => {
  assert.equal(cueClosesIn(tile(), 100), 470);
  assert.equal(cueClosesIn(tile({ human_window: null }), 500), 600 - CUE_MIN_REMAINING_S - 500);
  assert.equal(cueClosesIn(tile(), undefined), 470); // falls back to the tile's own elapsed_s
  assert.equal(cueClosesIn(tile({ human_window: null, budget: null }), 10), null);
  assert.equal(cueClosesIn(null, 10), null);
});

test("cueState: enabled only for a live, running, connected tile inside the window", () => {
  const open = cueState(tile(), { cue_max_chars: 1000 }, ON);
  assert.deepEqual(
    { rendered: open.rendered, enabled: open.enabled, code: open.code, reason: open.reason, closesIn: open.closesIn, maxChars: open.maxChars },
    { rendered: true, enabled: true, code: null, reason: "", closesIn: 470, maxChars: 1000 },
  );
});

test("cueState: every refusal carries its code and a reason in words", () => {
  const cases = [
    [null, ON, false, "loading", TEXT.loading],
    [tile({ human_enabled: false }), ON, false, "autonomous", TEXT.autonomous],
    [interrupted(), ON, true, "not_live", TEXT.interrupted],
    [tile({ live: false, status: "done", final: tenOf(1, 1) }), ON, true, "not_live", TEXT.notLive],
    [finalTile(), ON, true, "final", TEXT.cueFinal],
    [tile(), { connected: false, elapsed: 100 }, true, "disconnected", TEXT.disconnected],
    [tile(), { connected: true, elapsed: 570 }, true, "window", TEXT.cueWindow],
    [tile(), { connected: true, elapsed: 599 }, true, "window", TEXT.cueWindow],
  ];
  for (const [t, ctx, rendered, code, reason] of cases) {
    const state = cueState(t, null, ctx);
    assert.equal(state.enabled, false, code);
    assert.equal(state.rendered, rendered, code);
    assert.equal(state.code, code);
    assert.equal(state.reason, reason);
    assert.ok(state.reason.length > 0);
  }
});

test("cueState: an autonomous run renders no cue control at all", () => {
  assert.equal(cueState(tile({ human_enabled: false }), null, ON).rendered, false);
  assert.equal(geocodeState(tile({ human_enabled: false }), ON).rendered, false);
  assert.equal(mcqView(tile({ human_enabled: false, pending_mcq: question() }), { connected: true, remaining: 60 }).mode, "hidden");
  assert.equal(toggleState(tile({ human_enabled: false })).rendered, false);
});

test("cueState: final wins over the stream being down (the reason that will not go away)", () => {
  assert.equal(cueState(finalTile(), null, { connected: false, elapsed: 100 }).code, "final");
});

test("cueWindowLine counts down only when the window is close", () => {
  assert.equal(cueWindowLine(cueState(tile(), null, ON)), "");
  assert.equal(cueWindowLine(cueState(tile(), null, { connected: true, elapsed: 523 })), "Cue window closes in 0:47");
  assert.equal(cueWindowLine(cueState(tile(), null, { connected: true, elapsed: 580 })), ""); // closed: the reason says so
  assert.equal(cueWindowLine(null), "");
});

test("cueDraft counts what the server counts: stripped, in code points", () => {
  assert.deepEqual(cueDraft("  look left \n"), { text: "look left", count: 9, max: 1000, empty: false, over: 0, label: "9 / 1000" });
  assert.equal(cueDraft("").empty, true);
  assert.equal(cueDraft("   \n ").empty, true);
  assert.equal(cueDraft(null).empty, true);
  assert.equal(cueDraft("😀😀").count, 2); // Python len() counts code points, not UTF-16 units
  const long = cueDraft("x".repeat(1003));
  assert.equal(long.over, 3);
  assert.equal(long.label, "1003 / 1000");
  assert.equal(cueDraft("abcdef", 4).over, 2);
});

test("cueSendState: the reason shown next to a disabled Send", () => {
  const enabled = cueState(tile(), null, ON);
  const text = cueDraft("the sign above the door");
  assert.deepEqual(cueSendState(enabled, text), { enabled: true, reason: "" });
  assert.deepEqual(cueSendState(enabled, cueDraft("  ")), { enabled: false, reason: TEXT.cueEmpty });
  assert.deepEqual(cueSendState(enabled, text, { busy: true }), { enabled: false, reason: "" });
  assert.deepEqual(cueSendState(enabled, text, { unresolved: true }), { enabled: false, reason: TEXT.cueUnresolved });
  const closed = cueState(finalTile(), null, ON);
  assert.deepEqual(cueSendState(closed, text), { enabled: false, reason: TEXT.cueFinal });
  // A draft over the limit is not blocked here: the server decides, the count warns.
  assert.equal(cueSendState(enabled, cueDraft("x".repeat(1200))).enabled, true);
});

test("cueLine: queued, delivered, and charged but undelivered", () => {
  const queued = cueLine({ seq: 9, t_rel_s: 451, char_count: 87, state: "queued", delivered_t_rel_s: null }, 0);
  assert.equal(queued.state, "queued");
  assert.equal(queued.text, "Cue 1 (87 characters, sent at 07:31): queued; delivered at the agent's next turn");
  const delivered = cueLine({ seq: 9, t_rel_s: 451, char_count: 87, state: "delivered", delivered_t_rel_s: 462, delivered_turn: 14 }, 0);
  assert.equal(delivered.tone, "ok");
  assert.equal(delivered.text, "Cue 1 (87 characters, sent at 07:31): delivered at 07:42 (turn 14)");
  const lost = cueLine({ seq: 12, t_rel_s: 590, char_count: 20, state: "undelivered", delivered_t_rel_s: null }, 1);
  assert.equal(lost.tone, "bad");
  assert.equal(lost.label, "charged, undelivered");
  assert.match(lost.text, /^Cue 2 .*charged x0\.8 and undelivered/);
  assert.match(cueLine({ state: "queued", t_rel_s: 1 }, 0).text, /\(\? characters/);
});

test("checkSentence names the server's reason and says nothing was charged", () => {
  assert.equal(
    checkSentence({ ok: false, reason: "too_long", problems: ["the cue has 1203 characters; the limit is 1000"] }),
    "This cue cannot be sent: the cue has 1203 characters; the limit is 1000. Nothing was charged.",
  );
  assert.equal(checkSentence({ ok: false, problems: [] }), "This cue cannot be sent: the server refused it. Nothing was charged.");
});

test("lintItems lists the offending word when the server located every problem", () => {
  const problems = ["place name: 'Lisboa'", "country: 'Portugal'"];
  const matches = [
    { category: "place name", word: "Lisboa", start: 8, end: 14 },
    { category: "country", word: "Portugal", start: null, end: null },
  ];
  assert.deepEqual(lintItems(problems, matches), [
    { category: "place name", word: "Lisboa", text: null },
    { category: "country", word: "Portugal", text: null },
  ]);
  // A problem the server could not parse: show the server's sentences rather than half a list.
  assert.deepEqual(lintItems(problems, matches.slice(0, 1)), [
    { category: null, word: null, text: "place name: 'Lisboa'" },
    { category: null, word: null, text: "country: 'Portugal'" },
  ]);
  assert.deepEqual(lintItems(null, null), []);
});

test("lintSegments marks the located words by code-point offsets", () => {
  assert.deepEqual(lintSegments("look in Lisboa now", [{ word: "Lisboa", start: 8, end: 14 }]), [
    { text: "look in ", mark: false },
    { text: "Lisboa", mark: true },
    { text: " now", mark: false },
  ]);
  // An emoji is one code point for the server; the mark must not drift by a UTF-16 unit.
  assert.deepEqual(lintSegments("😀 Porto", [{ start: 2, end: 7 }]), [
    { text: "😀 ", mark: false },
    { text: "Porto", mark: true },
  ]);
  // Overlapping, unsorted, unlocated and out-of-range matches are tolerated.
  assert.deepEqual(lintSegments("abcdef", [{ start: 3, end: 99 }, { start: 1, end: 4 }, { start: null, end: null }, null]), [
    { text: "a", mark: false },
    { text: "bcdef", mark: true },
  ]);
  assert.deepEqual(lintSegments("plain", []), [{ text: "plain", mark: false }]);
  assert.deepEqual(lintSegments("", [{ start: 0, end: 3 }]), []);
});

// ---------------------------------------------------------------- geocode

test("geocodeState: disabled until the agent has named a place (R8)", () => {
  assert.deepEqual(geocodeState(tile(), ON), { rendered: true, enabled: true, code: null, reason: "" });
  const none = geocodeState(tile({ named_places: [], geocode_enabled: false }), ON);
  assert.equal(none.enabled, false);
  assert.equal(none.code, "no_place");
  assert.equal(none.reason, TEXT.geocodeNoPlace);
  // The flag alone is not enough: the place has to be chosen from a list that exists.
  assert.equal(geocodeState(tile({ named_places: [], geocode_enabled: true }), ON).code, "no_place");
  assert.equal(geocodeState(tile({ geocode_enabled: false }), ON).code, "no_place");
});

test("geocodeState: stays available after the answer is final, once", () => {
  assert.equal(geocodeState(finalTile(), ON).enabled, true); // "only the x0.5 geocode remains"
  const done = geocodeState(finalTile({ origin: "human_geocode", penalty: { cues: 0, mcqs: 0, human_geocodes: 1, multiplier: 0.5 } }), ON);
  assert.equal(done.enabled, false);
  assert.equal(done.code, "done");
  assert.equal(done.reason, TEXT.geocodeDone);
});

test("geocodeState: not live, disconnected, loading", () => {
  assert.equal(geocodeState(interrupted(), ON).code, "not_live");
  assert.equal(geocodeState(interrupted(), ON).reason, TEXT.interrupted);
  const down = geocodeState(tile(), { connected: false });
  assert.equal(down.enabled, false);
  assert.equal(down.reason, TEXT.disconnected);
  assert.deepEqual(geocodeState(null), { rendered: false, enabled: false, code: "loading", reason: TEXT.loading });
});

test("parseCoordinate accepts plain decimal numbers in range only", () => {
  assert.equal(parseCoordinate("38.716900", 90), 38.7169);
  assert.equal(parseCoordinate(" -9.1399 ", 180), -9.1399);
  assert.equal(parseCoordinate("+12", 90), 12);
  assert.equal(parseCoordinate(".5", 90), 0.5);
  assert.equal(parseCoordinate("5.", 90), 5);
  assert.equal(parseCoordinate(-90, 90), -90);
  for (const bad of ["", "  ", "abc", "1e2", "38,7169", "38.7 N", "91", "-90.000001", "0x10", "Infinity", "NaN", null, undefined]) {
    assert.equal(parseCoordinate(bad, 90), null, String(bad));
  }
  assert.equal(parseCoordinate(Number.NaN, 90), null);
  assert.equal(parseCoordinate(180.5, 180), null);
});

test("parseCoordinatePair: a pasted pair fills both fields, an ambiguous one fills none", () => {
  assert.deepEqual(parseCoordinatePair("38.716900, -9.139900"), { lat: 38.7169, lng: -9.1399 });
  assert.deepEqual(parseCoordinatePair(" 38.7169,-9.1399 "), { lat: 38.7169, lng: -9.1399 });
  assert.deepEqual(parseCoordinatePair("38.7169 -9.1399"), { lat: 38.7169, lng: -9.1399 });
  assert.deepEqual(parseCoordinatePair("41; 2"), { lat: 41, lng: 2 });
  assert.deepEqual(parseCoordinatePair("41, 2"), { lat: 41, lng: 2 });
  assert.deepEqual(parseCoordinatePair("38.71690049, -9.13990051"), { lat: 38.7169, lng: -9.139901 });
  // A comma-decimal number is one number, never latitude 38 and longitude 71.
  assert.equal(parseCoordinatePair("38,71"), null);
  assert.equal(parseCoordinatePair("38,7169"), null);
  for (const bad of ["", "38.7169", "95.0, 10.0", "10.0, 181.0", "a, b", "1, 2, 3", "38.7 N, 9.1 W", null]) {
    assert.equal(parseCoordinatePair(bad), null, String(bad));
  }
});

test("distanceM and hypothesisForPlace: how far the pin is from the agent's own point", () => {
  const lisbon = { lat: 38.7169, lng: -9.1399 };
  const porto = { lat: 41.1456, lng: -8.611 };
  assert.equal(distanceM(lisbon, lisbon), 0);
  assert.ok(Math.abs(distanceM(lisbon, porto) - 273_800) < 1500); // about 274 km
  assert.ok(Math.abs(distanceM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111_195) < 5);
  assert.equal(distanceM(lisbon, null), null);
  assert.equal(distanceM({ lat: "38", lng: 1 }, porto), null);
  assert.equal(hypothesisForPlace(tile(), "Ribeira"), HYPOTHESES[1]);
  assert.equal(hypothesisForPlace(tile(), " Ribeira "), HYPOTHESES[1]);
  assert.equal(hypothesisForPlace(tile(), "Lisbon cathedral"), null);
  assert.equal(hypothesisForPlace(tile(), ""), null);
  assert.equal(hypothesisForPlace(tile({ hypotheses: null }), "Ribeira"), null);
});

test("geocodeForm: a place from the agent's list and both coordinates, to 6 decimals", () => {
  const places = ["Praca do Comercio", "Ribeira"];
  assert.deepEqual(geocodeForm({ place: "Ribeira", places, lat: "41.14561234", lng: "-8.611" }), {
    ready: true, reason: "", point: { lat: 41.145612, lng: -8.611 }, place: "Ribeira",
  });
  assert.equal(roundCoordinate(41.14561251), 41.145613);
});

test("geocodeForm: each missing piece has its own sentence", () => {
  const places = ["Praca do Comercio", "Ribeira"];
  const reason = (input) => geocodeForm({ places, ...input });
  assert.equal(reason({ place: "", lat: "1", lng: "2" }).reason, TEXT.geocodeChoosePlace);
  assert.equal(reason({ place: "", lat: "1", lng: "2" }).ready, false);
  // A name that is not in the agent's list can never be sent, however it got into the form.
  assert.equal(reason({ place: "Lisbon cathedral", lat: "1", lng: "2" }).reason, TEXT.geocodePlaceGone);
  assert.equal(reason({ place: "Lisbon cathedral", lat: "1", lng: "2" }).ready, false);
  assert.equal(reason({ place: "Ribeira", lat: "", lng: "" }).reason, TEXT.geocodeNoPin);
  assert.equal(reason({ place: "Ribeira", lat: "41", lng: "" }).reason, TEXT.geocodeNoPin);
  assert.equal(reason({ place: "Ribeira", lat: "", lng: "-8" }).reason, TEXT.geocodeNoPin);
  assert.equal(reason({ place: "Ribeira", lat: "95", lng: "-8" }).reason, TEXT.geocodeBadLat);
  assert.equal(reason({ place: "Ribeira", lat: "41", lng: "181" }).reason, TEXT.geocodeBadLng);
  assert.equal(reason({ place: "Ribeira", lat: "41", lng: "x" }).reason, TEXT.geocodeBadLng);
  assert.equal(geocodeForm({ place: "Ribeira", places: null, lat: "1", lng: "2" }).ready, false);
});

// ---------------------------------------------------------------- MCQ

test("optionIndexForKey: a to d choose an option that exists, nothing else does", () => {
  assert.equal(optionIndexForKey("a", 3), 0);
  assert.equal(optionIndexForKey("C", 3), 2);
  assert.equal(optionIndexForKey("d", 3), null);
  assert.equal(optionIndexForKey("d", 4), 3);
  assert.equal(optionIndexForKey("e", 9), null); // never more than four options
  for (const key of ["Enter", " ", "1", "", "ab", null, undefined]) assert.equal(optionIndexForKey(key, 4), null, String(key));
  assert.equal(optionLetter(0), "A");
  assert.equal(optionLetter(3), "D");
});

test("mcqCountdown: text, share of the ring and urgency", () => {
  assert.deepEqual(mcqCountdown(90, 90), { known: true, seconds: 90, text: "1:30", fraction: 1, level: "ok" });
  assert.deepEqual(mcqCountdown(46.2, 90), { known: true, seconds: 47, text: "0:47", fraction: 46.2 / 90, level: "ok" });
  assert.equal(mcqCountdown(30, 90).level, "warn");
  assert.equal(mcqCountdown(15, 90).level, "urgent");
  assert.deepEqual(mcqCountdown(0, 90), { known: true, seconds: 0, text: "0:00", fraction: 0, level: "urgent" });
  assert.equal(mcqCountdown(-3, 90).seconds, 0);
  assert.equal(mcqCountdown(120, 90).fraction, 1);
  assert.equal(mcqCountdown(45, 0).fraction, 0.5); // no timeout told: the rule's 90 s
  assert.deepEqual(mcqCountdown(null, 90), { known: false, seconds: null, text: "–", fraction: 1, level: "ok" });
});

test("mcqView: a pending question with its options and the hypotheses they name", () => {
  const view = mcqView(tile({ status: "awaiting_mcq", pending_mcq: question() }), { connected: true, remaining: 60 });
  assert.equal(view.mode, "pending");
  assert.equal(view.id, "q1");
  assert.equal(view.enabled, true);
  assert.equal(view.reason, "");
  assert.equal(view.markedIndex, null);
  assert.equal(view.why, "The two candidates are 270 km apart.");
  assert.equal(view.countdown.text, "1:00");
  assert.deepEqual(view.options.map((o) => o.letter), ["A", "B", "C"]);
  assert.deepEqual(view.options[1].place, { index: 1, label: "Ribeira", lat: 41.1456, lng: -8.611 });
  assert.equal(view.options[2].place, null);
});

test("mcqView: never more than four options, and a place without coordinates is dropped", () => {
  const view = mcqView(tile({
    pending_mcq: question({ options: ["a", "b", "c", "d", "e"], option_places: [{ index: 0, label: "x", lat: null, lng: 1 }] }),
  }), { connected: true, remaining: 10 });
  assert.equal(view.options.length, 4);
  assert.equal(view.options[0].place, null);
});

test("mcqView: the buttons lock when time is up, when the stream is down and once sent", () => {
  const waiting = tile({ status: "awaiting_mcq", pending_mcq: question() });
  const expired = mcqView(waiting, { connected: true, remaining: 0 });
  assert.equal(expired.enabled, false);
  assert.equal(expired.reason, TEXT.mcqExpired);
  const down = mcqView(waiting, { connected: false, remaining: 40 });
  assert.equal(down.enabled, false);
  assert.equal(down.reason, TEXT.disconnected);
  const sent = mcqView(waiting, { connected: true, remaining: 40, sent: { id: "q1", index: 1 } });
  assert.equal(sent.enabled, false);
  assert.equal(sent.markedIndex, 1);
  assert.equal(sent.reason, TEXT.mcqSent);
  assert.equal(mcqView(waiting, { connected: true, remaining: 40, sent: { id: "q1", index: 1 }, sending: true }).reason, TEXT.mcqSending);
  assert.equal(mcqView(waiting, { connected: true, remaining: 40, sent: { id: "q1", index: 1 }, unresolved: true }).reason, TEXT.mcqUnresolved);
  // An answer sent to an earlier question says nothing about this one.
  const other = mcqView(waiting, { connected: true, remaining: 40, sent: { id: "q0", index: 1 } });
  assert.equal(other.enabled, true);
  assert.equal(other.markedIndex, null);
  // An unknown countdown does not lock the buttons: the server refuses a late answer.
  assert.equal(mcqView(waiting, { connected: true, remaining: null }).enabled, true);
});

test("mcqView: a dead panorama never shows a live question", () => {
  assert.equal(mcqView(interrupted({ pending_mcq: question() }), { connected: true, remaining: 60 }).mode, "hidden");
  assert.equal(mcqView(tile(), { connected: true }).mode, "hidden");
  assert.equal(mcqView(null).mode, "hidden");
});

const closed = (extra = {}) => ({
  id: "q1", seq: 77, question: "Which river front is this?",
  options: ["Praca do Comercio, facing the Tagus", "Ribeira, facing the Douro", "Neither"],
  outcome: "answered", selected_index: 1, wait_s: 12.5, t_rel_s: 300, ...extra,
});

test("lingerLeft: a closed question stays 20 s from when this page saw it close", () => {
  const t = tile({ last_mcq: closed() });
  assert.equal(lingerLeft(t, { nowMs: 50_000, closedAtMs: 50_000 }), LAST_MCQ_LINGER_S);
  assert.equal(lingerLeft(t, { nowMs: 62_000, closedAtMs: 50_000 }), 8);
  assert.equal(lingerLeft(t, { nowMs: 80_000, closedAtMs: 50_000 }), 0);
  assert.equal(lingerLeft(tile({ last_mcq: closed(), pending_mcq: question({ id: "q2" }) }), { nowMs: 1, closedAtMs: 1 }), 0);
  assert.equal(lingerLeft(tile(), { nowMs: 1, closedAtMs: 1 }), 0);
});

test("lingerLeft: a page opened afterwards uses the panorama's own clock", () => {
  const t = tile({ last_mcq: closed({ t_rel_s: 300 }) });
  assert.equal(lingerLeft(t, { elapsed: 305 }), 15);
  assert.equal(lingerLeft(t, { elapsed: 400 }), 0);
  assert.equal(lingerLeft(t, { elapsed: 200 }), 0); // a retry restarted the clock: that question is history
  // A finished panorama's clock does not run, so an old question is not shown again on every visit.
  assert.equal(lingerLeft(finalTile({ last_mcq: closed({ t_rel_s: 300 }), elapsed_s: 301 }), { elapsed: 301 }), 0);
});

test("mcqOutcome: who answered, a timeout and a release, each in its own words", () => {
  const mine = mcqOutcome(closed(), { sent: { id: "q1", index: 1 }, seenPendingId: "q1" });
  assert.equal(mine.tone, "ok");
  assert.equal(mine.text, "Answer sent (B: Ribeira, facing the Douro). The agent continues with it.");
  const theirs = mcqOutcome(closed(), { sent: null, seenPendingId: "q1" });
  assert.equal(theirs.text, "Answered from another tab (B: Ribeira, facing the Douro). Nothing more to do here.");
  // This tab chose A, another tab's B is what the agent got: say what was chosen, not what was clicked here.
  assert.match(mcqOutcome(closed(), { sent: { id: "q1", index: 0 }, seenPendingId: "q1" }).text, /^Answered from another tab \(B: /);
  assert.equal(mcqOutcome(closed(), {}).text, "Answered (B: Ribeira, facing the Douro).");
  const timeout = mcqOutcome(closed({ outcome: "timeout", selected_index: null }));
  assert.equal(timeout.text, TEXT.mcqTimeout);
  assert.equal(timeout.text, "No answer sent; the agent proceeds.");
  assert.equal(mcqOutcome(closed({ outcome: "released", selected_index: null })).text, TEXT.mcqReleased);
});

test("mcqView: the result of a closed question, with the chosen option marked", () => {
  const t = tile({ last_mcq: closed() });
  const view = mcqView(t, { connected: true, nowMs: 10_000, closedAtMs: 9_000, sent: { id: "q1", index: 1 }, seenPendingId: "q1" });
  assert.equal(view.mode, "result");
  assert.equal(view.enabled, false);
  assert.equal(view.markedIndex, 1);
  assert.equal(view.countdown, null);
  assert.equal(view.outcome.tone, "ok");
  assert.equal(view.options.length, 3);
  const timeout = mcqView(tile({ last_mcq: closed({ outcome: "timeout", selected_index: null }) }), { nowMs: 10_000, closedAtMs: 9_000 });
  assert.equal(timeout.mode, "result");
  assert.equal(timeout.markedIndex, null);
  assert.equal(timeout.outcome.text, "No answer sent; the agent proceeds.");
  assert.equal(mcqView(t, { nowMs: 40_000, closedAtMs: 9_000 }).mode, "hidden");
});

test("mcqView: a new question replaces the result of the last one at once", () => {
  const view = mcqView(tile({ last_mcq: closed(), pending_mcq: question({ id: "q2" }) }), { connected: true, remaining: 90, nowMs: 1, closedAtMs: 1 });
  assert.equal(view.mode, "pending");
  assert.equal(view.id, "q2");
});

// ---------------------------------------------------------------- harness controls

test("finalizeState: offered while running, warns when there is nothing to fix yet", () => {
  assert.deepEqual(finalizeState(tile()), { rendered: true, enabled: true, reason: "", warning: "" });
  const empty = finalizeState(tile({ hypotheses: [], provisional: [] }));
  assert.equal(empty.enabled, true);
  assert.match(empty.warning, /harness fallback point/);
  assert.equal(finalizeState(finalTile()).rendered, false);
  const dead = finalizeState(interrupted());
  assert.deepEqual([dead.rendered, dead.enabled, dead.reason], [true, false, TEXT.interrupted]);
  assert.equal(finalizeState(null).rendered, false);
  // Finalize is a harness control: it does not depend on the human channels.
  assert.equal(finalizeState(tile({ human_enabled: false })).enabled, true);
});

test("retryState: only for a retryable tile held by this server", () => {
  assert.equal(retryState(finalTile({ retryable: true, stop_reason: "api_error" })).rendered, true);
  assert.equal(retryState(finalTile()).rendered, false);
  assert.equal(retryState(interrupted({ retryable: true })).rendered, false);
  assert.equal(retryState(finalTile({ retryable: "yes" })).rendered, false);
  assert.equal(retryState(null).rendered, false);
});

test("exportState: nothing to download before the first event", () => {
  assert.deepEqual(exportState(tile()), { enabled: true, reason: "" });
  assert.deepEqual(exportState(tile({ last_seq: 0 })), { enabled: false, reason: TEXT.exportEmpty });
  assert.deepEqual(exportState(null), { enabled: false, reason: TEXT.loading });
  assert.equal(exportState(interrupted()).enabled, true); // a disk run still has its file
});

test("toggleState: the count left and what the switch does", () => {
  assert.deepEqual(toggleState(tile({ mcqs_left: 2 })), { rendered: true, checked: true, count: "2 of 3 left", help: TEXT.toggleHelp });
  const off = toggleState(tile({ mcq_allowed: false }));
  assert.equal(off.checked, false);
  assert.equal(off.help, TEXT.toggleOff);
  assert.match(TEXT.toggleHelp, /the agent's next question is refused at no cost/);
  assert.equal(toggleState(finalTile()).rendered, false);
  assert.equal(toggleState(interrupted()).rendered, false);
  assert.equal(toggleState(tile({ mcqs_left: null })).count, "");
});

test("hasFallback and ackState: a harness answer is flagged until acknowledged", () => {
  const fallback = finalTile({ origin: "harness_fallback", stop_reason: "api_error", stop_text: "the model API failed: fallback point used" });
  assert.equal(hasFallback(fallback), true);
  assert.equal(hasFallback(finalTile()), false);
  assert.equal(hasFallback(finalTile({ origin: "agent", final: tenOf(1, 1, { origin: "harness_fallback" }) })), true);
  const pending = ackState(fallback);
  assert.deepEqual([pending.rendered, pending.acknowledged, pending.enabled, pending.reason], [true, false, true, ""]);
  assert.match(pending.text, /^Fallback answer: the harness, not the agent, produced this list \(the model API failed: fallback point used\)\./);
  const done = ackState({ ...fallback, fallback_acknowledged: true });
  assert.deepEqual([done.rendered, done.acknowledged, done.enabled], [true, true, false]);
  assert.match(done.text, /^Fallback answer acknowledged/);
  const disk = ackState({ ...fallback, live: false });
  assert.equal(disk.enabled, false);
  assert.equal(disk.reason, TEXT.ackNotLive);
  assert.equal(ackState(finalTile()).rendered, false);
  // Not final yet: there is no answer to acknowledge.
  assert.equal(ackState(tile({ origin: "harness_fallback" })).rendered, false);
});

test("groupReasons: one line per distinct reason, naming every control it covers", () => {
  assert.deepEqual(groupReasons([
    { label: "Cue", reason: TEXT.disconnected },
    { label: "Geocode", reason: TEXT.disconnected },
    { label: "Finalize now", reason: "" },
    null,
    { label: "Export JSON", reason: TEXT.exportEmpty },
  ]), [
    { labels: ["Cue", "Geocode"], reason: TEXT.disconnected },
    { labels: ["Export JSON"], reason: TEXT.exportEmpty },
  ]);
  assert.deepEqual(groupReasons([]), []);
});

// ---------------------------------------------------------------- confirmations

test("dialogSnapshot records what a confirmation was opened against", () => {
  assert.deepEqual(dialogSnapshot(tile(), { place: "Ribeira" }), {
    multiplier: 1, cues: 0, geocodes: 0, final: false, retryable: false, place: "Ribeira",
  });
  assert.equal(dialogSnapshot(finalTile()).final, true);
});

test("dialogLock: an unchanged tile keeps every confirmation open", () => {
  for (const kind of ["cue", "geocode", "finalize"]) assert.equal(dialogLock(kind, dialogSnapshot(tile(), { place: "Ribeira" }), tile(), ON), null, kind);
  const retryable = finalTile({ retryable: true });
  assert.equal(dialogLock("retry", dialogSnapshot(retryable), retryable, ON), null);
});

test("dialogLock (cue): another tab's cue, a final answer, the window and the stream", () => {
  const opened = dialogSnapshot(tile());
  const charged = tile({ penalty: { cues: 1, mcqs: 0, human_geocodes: 0, multiplier: 0.8 } });
  assert.match(dialogLock("cue", opened, charged, ON), /^Already sent by another tab/);
  assert.match(dialogLock("cue", opened, finalTile(), ON), /became final while this was open/);
  assert.match(dialogLock("cue", opened, tile(), { connected: true, elapsed: 575 }), /^Too late for a cue/);
  assert.match(dialogLock("cue", opened, tile(), { connected: false, elapsed: 100 }), /event stream dropped/);
  assert.match(dialogLock("cue", opened, interrupted(), ON), /Nothing was sent\.$/);
  assert.match(dialogLock("cue", opened, null, ON), /no longer on the page/);
});

test("dialogLock: a multiplier that moved makes the numbers in the dialog wrong", () => {
  const opened = dialogSnapshot(tile());
  const asked = tile({ status: "awaiting_mcq", penalty: { cues: 0, mcqs: 1, human_geocodes: 0, multiplier: 0.95 } });
  const message = dialogLock("cue", opened, asked, ON);
  assert.match(message, /multiplier changed while this was open \(x1\.0 to x0\.95\)/);
  assert.match(dialogLock("geocode", dialogSnapshot(tile(), { place: "Ribeira" }), asked, ON), /multiplier changed/);
  // Harness confirmations carry no multiplier, so they stay open.
  assert.equal(dialogLock("finalize", opened, asked, ON), null);
});

test("dialogLock (geocode): recorded elsewhere, place withdrawn, became final", () => {
  const opened = dialogSnapshot(tile(), { place: "Ribeira" });
  const recorded = finalTile({ origin: "human_geocode", penalty: { cues: 0, mcqs: 0, human_geocodes: 1, multiplier: 0.5 } });
  assert.match(dialogLock("geocode", opened, recorded, ON), /^Already sent by another tab: a human geocode is recorded/);
  assert.match(dialogLock("geocode", opened, tile({ named_places: ["Praca do Comercio"] }), ON), /no longer names this place/);
  assert.match(dialogLock("geocode", opened, tile({ geocode_enabled: false }), ON), /no longer names this place/);
  assert.match(dialogLock("geocode", opened, finalTile(), ON), /became final while this was open/);
  // Opened on a tile that was already final: that is the ordinary "only the geocode remains" case.
  assert.equal(dialogLock("geocode", dialogSnapshot(finalTile(), { place: "Ribeira" }), finalTile(), ON), null);
  assert.match(dialogLock("geocode", opened, tile(), { connected: false }), /event stream dropped/);
});

test("dialogLock (harness): already final, no longer retryable; the stream does not lock them", () => {
  assert.match(dialogLock("finalize", dialogSnapshot(tile()), finalTile(), ON), /already final/);
  assert.equal(dialogLock("finalize", dialogSnapshot(tile()), tile(), { connected: false }), null);
  const retryable = finalTile({ retryable: true });
  assert.match(dialogLock("retry", dialogSnapshot(retryable), finalTile({ retryable: false }), ON), /can no longer be retried/);
  assert.match(dialogLock("retry", dialogSnapshot(retryable), interrupted(), ON), /Nothing was sent\.$/);
});

// ---------------------------------------------------------------- failures

test("describeFailure: no answer means unknown outcome and a same-key retry", () => {
  const failure = describeFailure({ status: 0, message: "The server did not answer in time." });
  assert.equal(failure.kind, "network");
  assert.equal(failure.retry, true);
  assert.equal(failure.title, "No answer from the server");
  assert.match(failure.note, /nothing is charged twice/);
  assert.equal(TEXT.retrySame, "Retry (same request, not charged twice)");
});

test("describeFailure: 403, 409 and 422 each have their own words and no retry", () => {
  const disabled = describeFailure({ status: 403, code: "human_channels_off", message: "Human channels are off for this run." });
  assert.deepEqual([disabled.kind, disabled.title, disabled.retry], ["disabled", "Channel disabled", false]);
  const conflict = describeFailure({ status: 409, code: "mcq_closed", message: "the answer was not sent: no such pending question" });
  assert.deepEqual([conflict.kind, conflict.title, conflict.retry], ["conflict", "No longer applies", false]);
  assert.equal(conflict.message, "The answer was not sent: no such pending question");
  const invalid = describeFailure({ status: 422, code: "cue_too_long", message: "The cue was not sent and nothing was charged.", problems: ["the cue has 1203 characters; the limit is 1000"] });
  assert.equal(invalid.kind, "invalid");
  assert.equal(invalid.title, "Rejected by the server");
  assert.deepEqual(invalid.problems, ["the cue has 1203 characters; the limit is 1000"]);
});

test("describeFailure: a lint refusal carries the problems and the located words", () => {
  const err = {
    status: 422,
    code: "cue_lint",
    message: "The cue was not sent and nothing was charged: the cue refers to a location and was blocked: place name: 'Lisboa'.",
    problems: ["place name: 'Lisboa'"],
    lint: { ok: false, problems: ["place name: 'Lisboa'"] },
    detail: { matches: [{ category: "place name", word: "Lisboa", start: 8, end: 14 }] },
  };
  const failure = describeFailure(err);
  assert.equal(failure.kind, "lint");
  assert.equal(failure.retry, false);
  assert.deepEqual(failure.problems, ["place name: 'Lisboa'"]);
  assert.deepEqual(failure.matches, [{ category: "place name", word: "Lisboa", start: 8, end: 14 }]);
  assert.match(failure.title, /nothing was sent or charged/);
  // The code alone is enough, should the verdict be missing.
  assert.equal(describeFailure({ status: 422, code: "cue_lint", message: "blocked" }).kind, "lint");
});

test("describeFailure: server errors may be retried with the same key; the rest may not", () => {
  const server = describeFailure({ status: 503, message: "The server failed (503)." });
  assert.deepEqual([server.kind, server.retry], ["server", true]);
  assert.match(server.note, /not charged twice/);
  const reuse = describeFailure({ status: 422, code: "idempotency_key_reuse", message: "key reused" });
  assert.deepEqual([reuse.kind, reuse.retry], ["invalid", false]);
  assert.match(reuse.note, /send it again/);
  assert.equal(describeFailure({ status: 404, message: "Not found" }).kind, "missing");
  assert.equal(describeFailure({ status: 400, code: "unconfirmed", message: "confirmed=true is required" }).retry, false);
  const unknown = describeFailure(null);
  assert.deepEqual([unknown.kind, unknown.retry, unknown.message], ["network", true, "The request failed."]);
});
