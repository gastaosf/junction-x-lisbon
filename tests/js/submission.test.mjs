import test from "node:test";
import assert from "node:assert/strict";

import {
  CHECK_INFO,
  ENTRIES,
  HOUR_GRACE_S,
  actionLabel,
  actionState,
  activeExportJob,
  answerMarkers,
  answerRows,
  answersCsv,
  checkCounts,
  checkStatus,
  checkWords,
  countsText,
  downloadPlan,
  downloadQuery,
  entriesText,
  exportPlan,
  filesChangedSince,
  finalizePlan,
  forcePlan,
  groupAnswers,
  hourElapsed,
  hourPosition,
  jobView,
  originWords,
  phasePosition,
  rankText,
  refusalConfirm,
  stampText,
  totalBytes,
  unfinishedTiles,
  verdict,
} from "../../server/static/console/js/logic/submission.js";

// ---------------------------------------------------------------- fixtures (contract 4.5 shapes)

const CHECK_IDS = ["all_final", "ten_entries", "exports_valid", "ledger", "files_fresh", "no_fallback"];

function check(id, status = "pass", extra = {}) {
  return { id, label: CHECK_INFO[id].label, status, detail: status === "pass" ? "fine." : "not fine.", items: [], action: null, ...extra };
}

function tenRows(pid, lat = 38.7, lng = -9.14) {
  return Array.from({ length: ENTRIES }, (_, i) => ({ panorama_id: pid, rank: i + 1, lat, lng }));
}

function validationOf(overrides = {}) {
  return {
    run_id: "r1",
    checks: CHECK_IDS.map((id) => check(id)),
    ok: true,
    answers: [...tenRows("pano_a"), ...tenRows("pano_b", 41.15, -8.61)],
    summary: [
      { panorama: "pano_a", label: "Urban", special: true, lat: 38.7, lng: -9.14, multiplier: 1, turns: 12, cost_usd: 0.4, wall_time_s: 200, stop_reason: "submitted", origin: "agent", problems: "" },
      { panorama: "pano_b", label: "non-Urban", special: false, lat: 41.15, lng: -8.61, multiplier: 0.8, turns: 9, cost_usd: 0.3, wall_time_s: 180, stop_reason: "submitted", origin: "agent", problems: "" },
    ],
    files: [
      { name: "pano_a.json", path: "/runs/r1/pano_a.json", size_bytes: 500000, modified_at: "2026-10-11T10:52:00.000Z" },
      { name: "pano_b.json", path: "/runs/r1/pano_b.json", size_bytes: 400000, modified_at: "2026-10-11T10:52:00.000Z" },
      { name: "answers.csv", path: "/runs/r1/answers.csv", size_bytes: 700, modified_at: "2026-10-11T10:52:00.000Z" },
      { name: "summary.csv", path: "/runs/r1/summary.csv", size_bytes: 300, modified_at: "2026-10-11T10:52:00.000Z" },
    ],
    submitted_at: null,
    interrupted: false,
    fake_model: false,
    ...overrides,
  };
}

function tile(pid, status = "done", extra = {}) {
  return { run_id: "r1", panorama_id: pid, status, label: "Urban", special: false, origin: "agent", penalty: { multiplier: 1 }, ...extra };
}

function runOf(overrides = {}) {
  return {
    run_id: "r1", state: "finished", owned: true, active: false, external: false, fake_model: false,
    panoramas: [tile("pano_a", "done", { special: true }), tile("pano_b")],
    ...overrides,
  };
}

const withCheck = (id, status, extra) => CHECK_IDS.map((name) => (name === id ? check(name, status, extra) : check(name)));

// ---------------------------------------------------------------- checks

test("a status the page does not know is a failure, never a pass", () => {
  assert.equal(checkStatus({ status: "pass" }), "pass");
  assert.equal(checkStatus({ status: "warn" }), "warn");
  assert.equal(checkStatus({ status: "fail" }), "fail");
  assert.equal(checkStatus({ status: "skipped" }), "fail");
  assert.equal(checkStatus({}), "fail");
  assert.equal(checkStatus(null), "fail");
});

test("checkWords keeps the server's words and adds what the check is for", () => {
  const words = checkWords(check("files_fresh", "fail", {
    detail: "1 panorama whose files are missing or older than the log. Rebuild the exports.",
    items: [{ panorama_id: "pano_a", text: "the export ends at event 40, its log has reached 44" }],
    action: "rebuild",
  }));
  assert.equal(words.label, "Files match the page");
  assert.equal(words.status, "fail");
  assert.equal(words.statusText, "fail");
  assert.equal(words.kind, "bad");
  assert.equal(words.icon, "x");
  assert.match(words.detail, /older than the log/);
  assert.equal(words.why, CHECK_INFO.files_fresh.why);
  assert.deepEqual(words.items, [{ panorama_id: "pano_a", text: "the export ends at event 40, its log has reached 44" }]);
  assert.equal(words.action, "rebuild");
  assert.equal(words.actionLabel, "Rebuild exports");
});

test("a passing check offers no action, and a check of an unknown id still prints", () => {
  const passing = checkWords(check("all_final", "pass", { action: "rebuild" }));
  assert.equal(passing.action, null);
  assert.equal(passing.actionLabel, null);
  const unknown = checkWords({ id: "new_rule", label: "A newer rule", status: "warn", detail: "look at this", items: null, action: "something_else" });
  assert.equal(unknown.label, "A newer rule");
  assert.equal(unknown.status, "warn");
  assert.equal(unknown.statusText, "warning");
  assert.equal(unknown.why, "");
  assert.deepEqual(unknown.items, []);
  assert.equal(unknown.action, null, "an action the page cannot perform is not offered");
});

test("the rebuild action is called recovery on an interrupted run", () => {
  assert.equal(actionLabel("rebuild"), "Rebuild exports");
  assert.equal(actionLabel("rebuild", { interrupted: true }), "Recover and export");
  assert.equal(actionLabel("finalize_all", { interrupted: true }), "Finalize all");
  assert.equal(actionLabel(null), null);
  assert.equal(checkWords(check("all_final", "fail", { action: "rebuild" }), { interrupted: true }).actionLabel, "Recover and export");
});

test("checkCounts and countsText", () => {
  const counts = checkCounts([check("all_final"), check("ledger", "fail"), check("no_fallback", "warn"), { id: "x", status: "odd" }]);
  assert.deepEqual(counts, { pass: 1, warn: 1, fail: 2, total: 4 });
  assert.equal(countsText(counts), "1 pass, 1 warning, 2 fail");
  assert.equal(countsText(checkCounts(CHECK_IDS.map((id) => check(id)))), "6 pass, 0 warnings, 0 fail");
  assert.deepEqual(checkCounts(null), { pass: 0, warn: 0, fail: 0, total: 0 });
});

// ---------------------------------------------------------------- verdict

test("no checklist, no verdict", () => {
  assert.equal(verdict(null, runOf()), null);
  assert.equal(verdict({ ok: true }, runOf()), null);
});

test("ready when every check passes", () => {
  const result = verdict(validationOf(), runOf());
  assert.equal(result.state, "ready");
  assert.equal(result.ready, true);
  assert.equal(result.tone, "ok");
  assert.equal(result.icon, "check");
  assert.equal(result.title, "Ready to submit");
  assert.deepEqual(result.reasons, ["All 6 checks pass for 2 panoramas."]);
  assert.match(result.next, /Download the submission zip/);
});

test("ready without a RunState: the checklist alone is enough", () => {
  const result = verdict(validationOf(), null);
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, ["All 6 checks pass."]);
});

test("a warning leaves the run ready and says what it is", () => {
  const checks = withCheck("no_fallback", "warn", { detail: "1 panorama would be submitted with the harness's fallback point." });
  const result = verdict(validationOf({ checks }), runOf());
  assert.equal(result.state, "warnings");
  assert.equal(result.ready, true);
  assert.equal(result.tone, "warn");
  assert.equal(result.title, "Ready to submit, with 1 warning");
  assert.deepEqual(result.reasons, ["No fallback answers: 1 panorama would be submitted with the harness's fallback point."]);
});

test("a failing check: not ready, with the reason and the repair it offers", () => {
  const checks = withCheck("files_fresh", "fail", { detail: "answers.csv is missing. Rebuild the exports.", action: "rebuild" });
  const result = verdict(validationOf({ checks, ok: false }), runOf());
  assert.equal(result.state, "failing");
  assert.equal(result.ready, false);
  assert.equal(result.tone, "bad");
  assert.equal(result.title, "Not ready: 1 check fails");
  assert.deepEqual(result.reasons, ["Files match the page: answers.csv is missing. Rebuild the exports."]);
  assert.match(result.next, /Rebuild the exports/);
});

test("two failures are counted, and a failure nothing repairs says so", () => {
  const checks = CHECK_IDS.map((id) => (id === "ledger" || id === "exports_valid" ? check(id, "fail") : check(id)));
  const result = verdict(validationOf({ checks, ok: false }), runOf());
  assert.equal(result.title, "Not ready: 2 checks fail");
  assert.equal(result.reasons.length, 2);
  assert.match(result.next, /Nothing on this page can repair them/);
});

test("finalize all is the next step when a failing check offers it", () => {
  const checks = withCheck("all_final", "fail", { action: "finalize_all" });
  const settled = runOf({ active: false, panoramas: [tile("pano_a", "running"), tile("pano_b")] });
  assert.match(verdict(validationOf({ checks, ok: false }), settled).next, /Finalize all/);
});

test("a run that is still going is not ready whatever the files say", () => {
  const run = runOf({ state: "running", active: true, panoramas: [tile("pano_a", "running"), tile("pano_b", "awaiting_mcq"), tile("pano_c")] });
  const result = verdict(validationOf(), run);
  assert.equal(result.state, "running");
  assert.equal(result.ready, false);
  assert.equal(result.tone, "wait");
  assert.equal(result.title, "Not ready: the run is still going");
  assert.deepEqual(result.reasons, ["2 of 3 panoramas not final: pano_a, pano_b."]);
  assert.match(result.next, /Finalize all/);
});

test("an active run whose panoramas are all final is judged by its checklist", () => {
  const result = verdict(validationOf(), runOf({ state: "running", active: true }));
  assert.equal(result.state, "ready");
});

test("an interrupted run points at recovery", () => {
  const run = runOf({ state: "interrupted", owned: false, panoramas: [tile("pano_a", "interrupted"), tile("pano_b")] });
  const checks = withCheck("all_final", "fail", { action: "rebuild" });
  const result = verdict(validationOf({ checks, ok: false, interrupted: true }), run);
  assert.equal(result.state, "interrupted");
  assert.equal(result.ready, false);
  assert.equal(result.tone, "bad");
  assert.equal(result.title, "Not ready: this run was interrupted");
  assert.ok(result.reasons.includes("1 of 2 panoramas not final: pano_a."));
  assert.match(result.next, /Recover and export/);
});

test("a run another process is writing can only be waited for", () => {
  const run = runOf({ state: "running", owned: false, external: true, panoramas: [tile("pano_a", "running")] });
  const result = verdict(validationOf({ ok: false }), run);
  assert.equal(result.state, "external");
  assert.equal(result.ready, false);
  assert.match(result.title, /another process/);
  assert.match(result.next, /Wait for that process/);
});

test("demo answers are never ready, even when everything else passes", () => {
  const checks = [...CHECK_IDS.map((id) => check(id)), { id: "real_model", label: "Real model", status: "fail", detail: "scripted demo model", items: [], action: null }];
  const result = verdict(validationOf({ checks, ok: false, fake_model: true }), runOf({ fake_model: true }));
  assert.equal(result.state, "demo");
  assert.equal(result.ready, false);
  assert.equal(result.tone, "bad");
  assert.match(result.title, /demo answers/);
  assert.equal(result.reasons.length, 1, "the demo-model check is not repeated as a second reason");
  const viaCheckOnly = verdict(validationOf({ checks, ok: false, fake_model: false }), runOf());
  assert.equal(viaCheckOnly.state, "demo");
});

test("a long list of unfinished panoramas is cut short", () => {
  const panoramas = Array.from({ length: 9 }, (_, i) => tile("p" + i, "running"));
  const result = verdict(validationOf(), runOf({ state: "running", active: true, panoramas }));
  assert.deepEqual(result.reasons, ["9 of 9 panoramas not final: p0, p1, p2, p3, p4, p5 and 3 more."]);
});

// ---------------------------------------------------------------- answers

test("ten identical entries collapse to one group", () => {
  const [row] = groupAnswers(tenRows("pano_a"));
  assert.equal(row.panorama_id, "pano_a");
  assert.equal(row.count, 10);
  assert.equal(row.complete, true);
  assert.equal(row.identical, true);
  assert.equal(row.distinct, 1);
  assert.equal(row.groups.length, 1);
  assert.deepEqual({ ...row.groups[0], key: undefined }, { key: undefined, start: 1, end: 10, count: 10, lat: 38.7, lng: -9.14, ranks: "#1–10" });
  assert.equal(entriesText(row), "10 x the same point");
});

test("a hedged list shows where it splits", () => {
  const answers = [...tenRows("pano_a").slice(0, 6), ...tenRows("pano_a", 40.2, -8.4).slice(6)];
  const [row] = groupAnswers(answers);
  assert.equal(row.identical, false);
  assert.equal(row.distinct, 2);
  assert.deepEqual(row.groups.map((g) => [g.ranks, g.count, g.lat]), [["#1–6", 6, 38.7], ["#7–10", 4, 40.2]]);
  assert.equal(entriesText(row), "10 entries, 2 distinct points");
});

test("the same point at separated ranks stays two groups but one distinct point", () => {
  const a = { lat: 1, lng: 2 };
  const b = { lat: 3, lng: 4 };
  const answers = [a, b, a].map((point, i) => ({ panorama_id: "p", rank: i + 1, ...point }));
  const [row] = groupAnswers(answers);
  assert.deepEqual(row.groups.map((g) => g.ranks), ["#1", "#2", "#3"]);
  assert.equal(row.distinct, 2);
  assert.equal(row.identical, false);
  assert.equal(row.complete, false);
});

test("points that print the same in the file are the same point", () => {
  const answers = [
    { panorama_id: "p", rank: 1, lat: 38.7000001, lng: -9.14 },
    { panorama_id: "p", rank: 2, lat: 38.7000002, lng: -9.14 },
    { panorama_id: "p", rank: 3, lat: 38.700002, lng: -9.14 },
  ];
  const [row] = groupAnswers(answers);
  assert.deepEqual(row.groups.map((g) => g.ranks), ["#1–2", "#3"]);
});

test("rows keep the order of the file, and a broken coordinate is not grouped away", () => {
  const answers = [
    { panorama_id: "b", rank: 1, lat: 1, lng: 1 },
    { panorama_id: "a", rank: 1, lat: null, lng: 2 },
    { panorama_id: "a", rank: 2, lat: null, lng: 2 },
    { panorama_id: "b", rank: 2, lat: 1, lng: 1 },
  ];
  const rows = groupAnswers(answers);
  assert.deepEqual(rows.map((row) => row.panorama_id), ["b", "a"]);
  assert.equal(rows[1].groups.length, 2, "two invalid entries are two lines");
  assert.equal(rows[1].groups[0].key, null);
  assert.equal(rows[1].identical, false);
  assert.equal(rows[1].distinct, 2);
});

test("a missing rank falls back to the position in the file", () => {
  const [row] = groupAnswers([{ panorama_id: "p", rank: null, lat: 1, lng: 1 }, { panorama_id: "p", rank: null, lat: 1, lng: 1 }]);
  assert.deepEqual(row.entries.map((entry) => entry.rank), [1, 2]);
  assert.equal(row.groups[0].ranks, "#1–2");
});

test("groupAnswers of nothing", () => {
  assert.deepEqual(groupAnswers(null), []);
  assert.deepEqual(groupAnswers([]), []);
  assert.equal(entriesText({ count: 0 }), "no entries");
});

test("rankText", () => {
  assert.equal(rankText(3, 3), "#3");
  assert.equal(rankText(1, 10), "#1–10");
});

test("answerRows follows the run's order and takes multiplier and origin from summary.csv", () => {
  const run = runOf({ panoramas: [tile("pano_b", "done", { special: true }), tile("pano_a")] });
  const rows = answerRows(validationOf(), run);
  assert.deepEqual(rows.map((row) => row.panorama_id), ["pano_b", "pano_a"]);
  assert.equal(rows[0].multiplier, 0.8);
  assert.equal(rows[0].origin, "agent");
  assert.equal(rows[0].label, "non-Urban");
  assert.equal(rows[0].special, false, "summary.csv is what gets handed in: its value wins over the tile's");
  assert.equal(rows[1].special, true);
  assert.equal(rows[1].identical, true);
  assert.equal(rows[0].multiplierRange, null);
});

test("a panorama of the run with no row in answers.csv is listed, not skipped", () => {
  const run = runOf({ panoramas: [tile("pano_a"), tile("pano_b"), tile("pano_c", "interrupted", { origin: null, penalty: { multiplier: 0.8 }, label: "non-Urban" })] });
  const rows = answerRows(validationOf(), run);
  assert.equal(rows.length, 3);
  const missing = rows[2];
  assert.equal(missing.panorama_id, "pano_c");
  assert.equal(missing.count, 0);
  assert.equal(missing.complete, false);
  assert.equal(missing.multiplier, 0.8, "falls back to the tile when summary.csv has no row");
  assert.equal(missing.label, "non-Urban");
  assert.equal(missing.origin, null);
  assert.equal(entriesText(missing), "no entries");
});

test("rows of answers.csv that belong to no panorama of the run are flagged", () => {
  const validation = validationOf({ answers: [...tenRows("pano_a"), ...tenRows("stray")] });
  const rows = answerRows(validation, runOf());
  assert.deepEqual(rows.map((row) => [row.panorama_id, row.in_run]), [["pano_a", true], ["pano_b", true], ["stray", false]]);
  const noRun = answerRows(validation, null);
  assert.ok(noRun.every((row) => row.in_run), "without a RunState nothing can be called a stray");
});

test("entries with different multipliers are shown as a range", () => {
  const final = Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, lat: 1, lng: 1, multiplier: i < 4 ? 1 : 0.8 }));
  const run = runOf({ panoramas: [tile("pano_a", "done", { final }), tile("pano_b")] });
  const rows = answerRows(validationOf(), run);
  assert.deepEqual(rows[0].multiplierRange, { min: 0.8, max: 1 });
  assert.equal(rows[1].multiplierRange, null);
});

test("answerRows carries the problems column", () => {
  const validation = validationOf();
  validation.summary[1].problems = "9 locations, expected 10";
  assert.equal(answerRows(validation, runOf())[1].problems, "9 locations, expected 10");
  assert.equal(answerRows(validation, runOf())[0].problems, "");
});

test("originWords never uses the penalty kind", () => {
  assert.deepEqual(originWords("agent"), { text: "agent", kind: "dim", icon: "target" });
  assert.equal(originWords("harness_fallback").text, "fallback");
  assert.equal(originWords("harness_fallback").kind, "warn");
  assert.equal(originWords("human_geocode").text, "human geocode");
  assert.equal(originWords(null).text, "unknown");
  assert.equal(originWords("something_new").text, "something_new");
  for (const origin of ["agent", "harness_fallback", "human_geocode", null, "x"]) {
    assert.notEqual(originWords(origin).kind, "penalty");
  }
});

test("answersCsv writes the file's own format", () => {
  const answers = [...tenRows("pano_a").slice(0, 2), { panorama_id: "pano_b", rank: 1, lat: -33.5, lng: 151 }];
  assert.equal(answersCsv(answers), "panorama_id,rank,lat,lng\npano_a,1,38.700000,-9.140000\npano_a,2,38.700000,-9.140000\npano_b,1,-33.500000,151.000000\n");
  assert.equal(answersCsv(answers, "pano_b"), "panorama_id,rank,lat,lng\npano_b,1,-33.500000,151.000000\n");
  assert.equal(answersCsv([]), "panorama_id,rank,lat,lng\n");
  assert.equal(answersCsv([{ panorama_id: 'a,"b"', rank: 1, lat: null, lng: 2 }]), 'panorama_id,rank,lat,lng\n"a,""b""",1,,2.000000\n');
});

test("answerMarkers: one marker per distinct point of a panorama", () => {
  const a = { lat: 1, lng: 2 };
  const b = { lat: 3, lng: 4 };
  const answers = [a, a, b, a].map((point, i) => ({ panorama_id: "p", rank: i + 1, ...point }));
  answers.push({ panorama_id: "q", rank: 1, lat: null, lng: 5 });
  const markers = answerMarkers(answerRows({ answers, summary: [] }, null));
  assert.deepEqual(markers, [
    { lat: 1, lng: 2, kind: "answer", label: "p #1–2, #4", panorama_id: "p" },
    { lat: 3, lng: 4, kind: "answer", label: "p #3", panorama_id: "p" },
  ]);
  assert.deepEqual(answerMarkers(null), []);
});

// ---------------------------------------------------------------- the hour

const PHASES = [
  { key: "launch", label: "Launch", start_min: 0, end_min: 2 },
  { key: "autonomous", label: "Autonomous pass", start_min: 2, end_min: 12 },
  { key: "special", label: "Special One", start_min: 12, end_min: 26 },
  { key: "others", label: "Other panoramas", start_min: 26, end_min: 52 },
  { key: "freeze", label: "Freeze", start_min: 52, end_min: 55 },
  { key: "submit", label: "Submit", start_min: 55, end_min: 60 },
];

test("phasePosition finds the phase, the time left and the states of the strip", () => {
  const at = phasePosition(PHASES, 53 * 60 + 30);
  assert.equal(at.index, 4);
  assert.equal(at.phase.key, "freeze");
  assert.equal(at.over, false);
  assert.equal(at.remaining_s, 6 * 60 + 30);
  assert.equal(at.phase_remaining_s, 90);
  assert.equal(at.total_s, 3600);
  assert.ok(Math.abs(at.fraction - 53.5 / 60) < 1e-9);
  assert.equal(at.phase_fraction, 0.5, "half way through the three minutes of the freeze");
  assert.deepEqual(at.segments.map((s) => s.state), ["past", "past", "past", "past", "current", "future"]);
  assert.ok(Math.abs(at.segments.reduce((sum, s) => sum + s.share, 0) - 1) < 1e-9);
  assert.equal(at.segments[3].share, 26 / 60);
});

test("phasePosition at the edges", () => {
  assert.equal(phasePosition(PHASES, 0).index, 0);
  assert.equal(phasePosition(PHASES, 119.9).index, 0);
  assert.equal(phasePosition(PHASES, 120).index, 1, "a phase ends where the next one starts");
  const over = phasePosition(PHASES, 3700);
  assert.equal(over.over, true);
  assert.equal(over.index, 5);
  assert.equal(over.fraction, 1);
  assert.equal(over.phase_fraction, 1);
  assert.equal(over.remaining_s, 0);
  assert.ok(over.segments.every((s) => s.state === "past"));
  assert.equal(phasePosition(PHASES, -5).index, 0);
  assert.equal(phasePosition(PHASES, 0).phase_fraction, 0);
  assert.equal(phasePosition(PHASES, 120).phase_fraction, 0);
  assert.equal(phasePosition(null, 10), null);
  assert.equal(phasePosition([], 10), null);
});

test("the hour is counted by the wall clock from the run's clock start", () => {
  const run = { phases: PHASES, clock_started_at: "2026-10-11T10:00:00.000Z", active: false, state: "finished" };
  const at = Date.parse("2026-10-11T10:56:00.000Z");
  assert.equal(hourElapsed(run, at), 56 * 60);
  assert.equal(hourElapsed({ ...run, phases: null }, at), null, "only a scoring run has an hour");
  assert.equal(hourElapsed({ ...run, clock_started_at: null }, at), null);
  assert.equal(hourElapsed(run, Date.parse("2026-10-11T09:59:00.000Z")), 0);
  assert.equal(hourElapsed(null, at), null);
});

test("hourPosition: shown until submitted, and for half an hour past the end", () => {
  const run = { phases: PHASES, clock_started_at: "2026-10-11T10:00:00.000Z" };
  const at = (text) => Date.parse("2026-10-11T" + text + ".000Z");
  const freeze = hourPosition(run, at("10:56:00"));
  assert.equal(freeze.phase.key, "submit");
  assert.equal(freeze.remaining_s, 240);
  assert.equal(freeze.over_s, 0);
  assert.equal(hourPosition(run, at("10:56:00"), "2026-10-11T10:55:30.000Z"), null, "the strip goes once the run is marked submitted");
  const late = hourPosition(run, at("11:05:00"));
  assert.equal(late.over, true);
  assert.equal(late.over_s, 300);
  assert.equal(hourPosition(run, Date.parse("2026-10-11T11:00:00.000Z") + HOUR_GRACE_S * 1000 + 1000), null);
  assert.equal(hourPosition({ phases: null }, at("10:10:00")), null);
});

// ---------------------------------------------------------------- confirmations

test("finalizePlan states what is fixed and that it cannot be undone", () => {
  const plan = finalizePlan(runOf({ active: true, panoramas: [tile("pano_a", "running"), tile("pano_b", "awaiting_mcq"), tile("pano_c")] }));
  assert.equal(plan.title, "Finalize all panoramas?");
  assert.equal(plan.okLabel, "Finalize all");
  assert.equal(plan.tone, "danger");
  assert.equal(plan.lines[0], "2 panoramas still have no final answer: pano_a, pano_b.");
  assert.match(plan.lines[1], /best list so far/);
  assert.match(plan.lines[2], /cannot be undone/);
  assert.equal(finalizePlan(runOf({ panoramas: [tile("pano_a", "running")] })).lines[0], "1 panorama still has no final answer: pano_a.");
});

test("a plain rebuild needs no confirmation; a recovery does", () => {
  const rebuild = exportPlan({ interrupted: false, embed: false });
  assert.equal(rebuild.confirm, false);
  assert.equal(rebuild.okLabel, "Rebuild exports");
  assert.equal(rebuild.lines.length, 1);
  const recovery = exportPlan({ interrupted: true, unfinished: 2, embed: false });
  assert.equal(recovery.confirm, true);
  assert.equal(recovery.tone, "danger");
  assert.equal(recovery.okLabel, "Recover and export");
  assert.match(recovery.lines[0], /2 panoramas have no final answer/);
  assert.match(recovery.lines[1], /No model call is made/);
  assert.match(recovery.lines[2], /cannot be undone/);
  assert.match(exportPlan({ interrupted: true, unfinished: 1 }).lines[0], /1 panorama has no final answer/);
  assert.match(exportPlan({ interrupted: true, unfinished: 0 }).lines[0], /never closed/);
});

test("embedding images states its size", () => {
  for (const interrupted of [false, true]) {
    const plan = exportPlan({ interrupted, unfinished: 1, embed: true });
    assert.match(plan.lines[plan.lines.length - 1], /10 to 20 MB per panorama/);
    assert.ok(!exportPlan({ interrupted, unfinished: 1, embed: false }).lines.some((line) => /MB/.test(line)));
  }
});

test("forcePlan only answers a 409 that asks for force, and states the consequence", () => {
  const recent = forcePlan({ status: 409, action: "force", code: "run_recently_written", message: "The logs of run r1 changed less than 30 minutes ago." });
  assert.equal(recent.tone, "danger");
  assert.equal(recent.lines[0], "The logs of run r1 changed less than 30 minutes ago.");
  assert.match(recent.lines[1], /duplicate events and a wrong final answer/);
  assert.equal(recent.okLabel, "Finish the logs and rebuild");
  const elsewhere = forcePlan({ status: 409, action: "force", code: "run_owned_elsewhere", message: "Run r1 is being written by another process." });
  assert.match(elsewhere.lines[1], /go stale/);
  assert.equal(elsewhere.okLabel, "Rebuild anyway");
  assert.match(forcePlan({ status: 409, action: "force", code: "new_code", message: "x" }).lines[1], /Forcing skips the check/);
  assert.equal(forcePlan({ status: 409, action: "rebuild", message: "x" }), null);
  assert.equal(forcePlan({ status: 422, action: "force", message: "x" }), null);
  assert.equal(forcePlan(null), null);
});

test("downloadPlan asks nothing for a clean run", () => {
  assert.deepEqual(downloadPlan(validationOf()), { empty: false, confirms: [] });
  const warned = validationOf({ checks: withCheck("no_fallback", "warn") });
  assert.deepEqual(downloadPlan(warned).confirms, [], "a warning never blocks the download");
});

test("downloadPlan asks before packing files that fail, and before packing demo answers", () => {
  const failing = downloadPlan(validationOf({ checks: withCheck("ledger", "fail"), ok: false }));
  assert.deepEqual(failing.confirms.map((step) => step.flag), ["force"]);
  assert.match(failing.confirms[0].lines[0], /Ledger consistent/);
  assert.equal(failing.confirms[0].tone, "danger");

  const real = { id: "real_model", label: "Real model", status: "fail", detail: "demo", items: [], action: null };
  const demo = downloadPlan(validationOf({ checks: [...CHECK_IDS.map((id) => check(id)), real], ok: false, fake_model: true }));
  assert.deepEqual(demo.confirms.map((step) => step.flag), ["fake_ok"], "the demo-model check alone does not also ask for force");
  assert.match(demo.confirms[0].lines.join(" "), /demo answers, not real ones/);

  const both = downloadPlan(validationOf({ checks: [...withCheck("files_fresh", "fail"), real], ok: false, fake_model: true }));
  assert.deepEqual(both.confirms.map((step) => step.flag), ["fake_ok", "force"]);
});

test("downloadPlan knows when there is nothing to pack", () => {
  assert.equal(downloadPlan(validationOf({ files: [] })).empty, true);
  assert.equal(downloadPlan(null).empty, true);
});

test("refusalConfirm turns a late 409 into the question it stands for, once", () => {
  const fake = { status: 409, action: "fake_ok", message: "This run was answered by the scripted demo model." };
  assert.equal(refusalConfirm(fake, {}).flag, "fake_ok");
  assert.equal(refusalConfirm(fake, {}).lines[0], fake.message);
  assert.equal(refusalConfirm(fake, { fake_ok: true }), null, "a flag already sent is not asked again");
  const force = { status: 409, action: "force", message: "The submission checklist has failing checks: Ledger consistent." };
  assert.equal(refusalConfirm(force, { fake_ok: true }).flag, "force");
  assert.equal(refusalConfirm(force, { force: true }), null);
  assert.equal(refusalConfirm({ status: 409, action: "rebuild", message: "no files" }, {}), null);
  assert.equal(refusalConfirm({ status: 500, action: "force" }, {}), null);
  assert.equal(refusalConfirm(null), null);
});

test("downloadQuery", () => {
  assert.equal(downloadQuery(), "");
  assert.equal(downloadQuery({}), "");
  assert.equal(downloadQuery({ fake_ok: true }), "?fake_ok=1");
  assert.equal(downloadQuery({ force: true }), "?force=1");
  assert.equal(downloadQuery({ force: true, fake_ok: true }), "?fake_ok=1&force=1");
});

// ---------------------------------------------------------------- controls

test("finalize all: only for a run this server is working on", () => {
  const going = runOf({ state: "running", active: true, panoramas: [tile("pano_a", "running"), tile("pano_b")] });
  assert.deepEqual(actionState("finalize_all", { run: going }), { disabled: false, reason: "" });
  assert.match(actionState("finalize_all", { run: runOf() }).reason, /already final/);
  const disk = runOf({ owned: false, state: "interrupted", panoramas: [tile("pano_a", "interrupted")] });
  assert.match(actionState("finalize_all", { run: disk }).reason, /Rebuild the exports instead/);
  const external = runOf({ owned: false, external: true, state: "running", panoramas: [tile("pano_a", "running")] });
  assert.match(actionState("finalize_all", { run: external }).reason, /Another process/);
});

test("anything in flight disables every control with one reason", () => {
  for (const name of ["finalize_all", "rebuild", "download", "mark", "unmark"]) {
    const state = actionState(name, { run: runOf(), validation: validationOf(), busy: true });
    assert.equal(state.disabled, true);
    assert.match(state.reason, /Another action is in progress/);
  }
});

test("rebuild waits for a running export", () => {
  assert.equal(actionState("rebuild", { run: runOf(), validation: validationOf() }).disabled, false);
  assert.match(actionState("rebuild", { run: runOf(), jobActive: true }).reason, /already running/);
});

test("download and mark need files, and wait for an export that is writing them", () => {
  const empty = validationOf({ files: [] });
  assert.match(actionState("download", { run: runOf(), validation: empty }).reason, /no export files yet\. Rebuild the exports first/);
  const going = runOf({ state: "running", active: true, panoramas: [tile("pano_a", "running")] });
  assert.match(actionState("download", { run: going, validation: empty }).reason, /written when every panorama is final/);
  const cut = validationOf({ files: [], interrupted: true });
  assert.match(actionState("download", { run: runOf({ owned: false, state: "interrupted" }), validation: cut }).reason, /Recover and export first/);
  assert.match(actionState("mark", { run: runOf(), validation: empty }).reason, /nothing to submit/);
  assert.match(actionState("download", { run: runOf(), validation: validationOf(), jobActive: true }).reason, /being written/);
  assert.match(actionState("mark", { run: runOf(), validation: validationOf(), jobActive: true }).reason, /being written/);
  assert.equal(actionState("download", { run: runOf(), validation: validationOf() }).disabled, false);
  assert.equal(actionState("mark", { run: runOf(), validation: validationOf() }).disabled, false);
  assert.equal(actionState("download", { run: null, validation: null }).disabled, false, "before the first read nothing is known to be wrong");
});

test("a run that is still going cannot be marked as submitted", () => {
  const going = runOf({ state: "running", active: true, panoramas: [tile("pano_a", "running")] });
  assert.match(actionState("mark", { run: going, validation: validationOf() }).reason, /still going/);
  assert.equal(actionState("unmark", { run: going, validation: validationOf() }).disabled, false);
});

// ---------------------------------------------------------------- jobs, files, stamps

test("jobView of a running job with a known total", () => {
  const view = jobView({
    id: "j1", kind: "export", title: "Rebuild exports of r1", state: "running", run_id: "r1",
    progress: { done: 1, total: 2, text: "writing the exports" }, log: ["finishing the logs", "recovered: pano_a"], result: null, error: null,
  });
  assert.equal(view.active, true);
  assert.equal(view.done, false);
  assert.equal(view.failed, false);
  assert.equal(view.fraction, 0.5);
  assert.equal(view.text, "writing the exports");
  assert.deepEqual(view.lines, ["finishing the logs", "recovered: pano_a"]);
  assert.deepEqual(view.recovered, []);
});

test("jobView without a total does not invent a fraction", () => {
  const view = jobView({ id: "j1", state: "queued", progress: { done: 0, total: null, text: "" }, log: [] });
  assert.equal(view.fraction, null);
  assert.equal(view.active, true);
  assert.equal(view.text, "waiting to start");
  assert.equal(view.title, "Export");
});

test("jobView of a finished recovery lists what was recovered and what the export complained about", () => {
  const view = jobView({
    id: "j1", state: "done", progress: { done: 2, total: 2, text: "done" }, log: [],
    result: { recovered: ["pano_a"], written_at: "2026-10-11T10:57:00Z", problems: { pano_b: "9 locations" }, files: ["/x"] },
  });
  assert.equal(view.done, true);
  assert.equal(view.active, false);
  assert.equal(view.fraction, 1);
  assert.deepEqual(view.recovered, ["pano_a"]);
  assert.deepEqual(view.problems, [{ panorama_id: "pano_b", text: "9 locations" }]);
  assert.equal(view.written_at, "2026-10-11T10:57:00Z");
});

test("jobView of a failed job keeps the error", () => {
  const view = jobView({ id: "j1", state: "failed", progress: { done: 1, total: 2, text: "writing" }, log: ["boom"], error: "disk full", result: null });
  assert.equal(view.failed, true);
  assert.equal(view.error, "disk full");
  assert.equal(jobView(null), null);
});

test("activeExportJob picks the newest working export of this run", () => {
  const jobs = [
    { id: "a", kind: "export", run_id: "r1", state: "done", created_at: "2026-10-11T10:50:00Z" },
    { id: "b", kind: "export", run_id: "r2", state: "running", created_at: "2026-10-11T10:51:00Z" },
    { id: "c", kind: "rescore", run_id: "r1", state: "running", created_at: "2026-10-11T10:52:00Z" },
    { id: "d", kind: "export", run_id: "r1", state: "queued", created_at: "2026-10-11T10:53:00Z" },
    { id: "e", kind: "export", run_id: "r1", state: "running", created_at: "2026-10-11T10:52:30Z" },
  ];
  assert.equal(activeExportJob(jobs, "r1").id, "d");
  assert.equal(activeExportJob(new Map(jobs.map((job) => [job.id, job])).values(), "r2").id, "b");
  assert.equal(activeExportJob(jobs, "r3"), null);
  assert.equal(activeExportJob(null, "r1"), null);
});

test("filesChangedSince names the files written after the stamp", () => {
  const files = validationOf().files.map((file) => ({ ...file }));
  files[2].modified_at = "2026-10-11T10:59:30.000Z";
  assert.deepEqual(filesChangedSince(files, "2026-10-11T10:58:00.000Z"), ["answers.csv"]);
  assert.deepEqual(filesChangedSince(files, "2026-10-11T11:00:00.000Z"), []);
  assert.deepEqual(filesChangedSince(files, null), []);
  assert.deepEqual(filesChangedSince(null, "2026-10-11T10:58:00.000Z"), []);
  assert.deepEqual(filesChangedSince([{ name: "x", modified_at: "not a date" }], "2026-10-11T10:58:00.000Z"), []);
});

test("unfinishedTiles, totalBytes and stampText", () => {
  const run = runOf({ panoramas: [tile("a", "running"), tile("b"), tile("c", "interrupted"), tile("d", "pending"), tile("e", "awaiting_mcq")] });
  assert.deepEqual(unfinishedTiles(run).map((t) => t.panorama_id), ["a", "c", "d", "e"]);
  assert.deepEqual(unfinishedTiles(null), []);
  assert.equal(totalBytes(validationOf().files), 901000);
  assert.equal(totalBytes(null), 0);
  const local = new Date(2026, 9, 11, 10, 58, 7);
  assert.equal(stampText(local.toISOString()), "2026-10-11 10:58:07");
  assert.equal(stampText(local.getTime()), "2026-10-11 10:58:07");
  assert.equal(stampText(null), "–");
});
