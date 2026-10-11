import test from "node:test";
import assert from "node:assert/strict";

import {
  LAUNCH_FIELDS,
  addPanoramasBody,
  addSummaryLines,
  baseSettings,
  canRetry,
  changedFields,
  costCeiling,
  countRows,
  editsFromSettings,
  effectiveKind,
  effectiveLiveBudget,
  effectiveSettings,
  enabledTools,
  evalBody,
  formatTimestamp,
  hasChoices,
  isLocked,
  isTimestamp,
  labelSummary,
  launchBlockers,
  launchLabel,
  launchSpec,
  liveReadiness,
  lockReason,
  modeOf,
  needsNoKeyConfirm,
  optionsSummary,
  parseLimit,
  parseNumber,
  pastEstimate,
  prefillFromRun,
  preflightBody,
  presetFacts,
  presetForRun,
  presetNames,
  promptQuery,
  pruneChoices,
  pruneEdits,
  readinessItems,
  runIdProblem,
  setImageUrl,
  setNameFromPaths,
  settingsProblems,
  shortDuration,
  sourceText,
  stepStates,
  summaryLines,
  taskChoices,
  timeCeiling,
  timestampFromInput,
  unlabelledRows,
  unreadImageCount,
  unreadImagesText,
  uploadPlan,
  uploadTotals,
  uploadUrl,
  worstVerdict,
} from "../../server/static/console/js/logic/launch.js";

// The launch context as GET /api/launch/context answers it (server/workspace.py PRESETS).
function context(extra = {}) {
  return {
    presets: {
      autonomous: { label: "Autonomous batch", settings: { no_human: true, concurrency: 6 }, live_budget: false, kind: "training", requires_special: false, locked: ["no_human"] },
      scoring: { label: "Scoring run", settings: { no_human: false, concurrency: 6 }, live_budget: false, kind: "scoring", requires_special: true, locked: ["no_human"] },
      live: { label: "Live on stage", settings: { no_human: true, concurrency: 1 }, live_budget: true, kind: "live", requires_special: false, locked: ["no_human", "live_budget"] },
      eval: { label: "Evaluation", settings: { no_human: true }, live_budget: false, kind: "eval", requires_special: false, locked: ["no_human", "live_budget"] },
      custom: { label: "Custom", settings: {}, live_budget: false, kind: "training", requires_special: false, locked: [] },
    },
    defaults: {
      model: "gpt-6.1-sol", max_tokens: 64000, image_detail: "original",
      standard: { effort: "high", soft_deadline_s: 600, hard_deadline_s: 840, max_turns: 30, max_spend_usd: 8 },
      special: { effort: "xhigh", soft_deadline_s: 900, hard_deadline_s: 1200, max_turns: 45, max_spend_usd: 15 },
      live: { effort: "high", soft_deadline_s: 150, hard_deadline_s: 210, max_turns: 12, max_spend_usd: 4 },
      allow_web: true, disabled_tools: [], hedge: false, allow_duplicates: true, penalty_scope: "whole_list",
      no_human: false, mcq_allowed: true, max_mcq: 3, concurrency: 6, global_watchdog_s: 3000, embed_images: false,
      team: "Astrolábio",
      // Not launch fields: the server's settings dump carries more than a form may send.
      cue_max_chars: 1000, runs_dir: "/somewhere/runs",
    },
    tools: [
      { name: "view_crop", protected: false, web: false },
      { name: "update_candidates", protected: true, web: false },
      { name: "submit_locations", protected: true, web: false },
      { name: "sun_position", protected: false, web: false },
      { name: "search_places", protected: false, web: true },
      { name: "web_search", protected: false, web: true },
    ],
    models: ["gpt-6.1-sol", "gpt-6-luna"],
    readiness: { openai_key: true, google_key: true, mapillary_token: false, internet: true, disk_free_bytes: 50 * 1024 ** 3, active_runs: [] },
    estimates: {},
    fake_model: false,
    ...extra,
  };
}

function row(extra = {}) {
  const rel = extra.rel_path || "Urban/a.jpg";
  const name = rel.split("/").pop();
  return {
    panorama_id: name.replace(/\.[^.]+$/, ""), filename: name, rel_path: rel,
    label: "Urban", timestamp: null, special: false,
    sources: { label: "folder", timestamp: "none", special: "none" },
    parsed: { label: "Urban", timestamp: null, special: false },
    budget: { effort: "high", soft_deadline_s: 600, hard_deadline_s: 840, max_turns: 30, max_spend_usd: 8 },
    collides: false, duplicate: false,
    ...extra,
  };
}

function form(ctx, preset, extra = {}) {
  const edits = extra.edits || {};
  return {
    preset, setId: "set-1", choices: { labels: {}, timestamps: {}, special: undefined },
    bulkOn: false, bulkLabel: null, runId: "", kind: null, addRunId: null, evalEffort: null, evalLimit: null,
    settings: effectiveSettings(ctx, preset, edits), liveBudget: effectiveLiveBudget(ctx, preset, undefined),
    ...extra,
  };
}

// ---------------------------------------------------------------- presets and settings

test("presets come in the order of the spec, unknown ones last", () => {
  const ctx = context();
  ctx.presets = { custom: ctx.presets.custom, zeta: { label: "Zeta", settings: {}, locked: [] }, scoring: ctx.presets.scoring, autonomous: ctx.presets.autonomous };
  assert.deepEqual(presetNames(ctx), ["autonomous", "scoring", "custom", "zeta"]);
  assert.deepEqual(presetNames(null), []);
});

test("a preset's values sit on the saved defaults, and a lock beats an edit", () => {
  const ctx = context();
  assert.equal(baseSettings(ctx, "autonomous").no_human, true);
  assert.equal(baseSettings(ctx, "live").concurrency, 1);
  const edited = effectiveSettings(ctx, "autonomous", { no_human: false, concurrency: 3, hedge: true });
  assert.equal(edited.no_human, true, "no_human is locked by the autonomous preset");
  assert.equal(edited.concurrency, 3);
  assert.equal(edited.hedge, true);
  assert.equal(effectiveSettings(ctx, "custom", { no_human: true }).no_human, true);
  assert.equal(isLocked(ctx, "scoring", "no_human"), true);
  assert.equal(isLocked(ctx, "custom", "no_human"), false);
});

test("a partial budget edit keeps the other four fields", () => {
  const ctx = context();
  const settings = effectiveSettings(ctx, "custom", { standard: { max_spend_usd: 2 } });
  assert.deepEqual(settings.standard, { effort: "high", soft_deadline_s: 600, hard_deadline_s: 840, max_turns: 30, max_spend_usd: 2 });
  assert.equal(ctx.defaults.standard.max_spend_usd, 8, "the context is not changed by an edit");
});

test("live budget and kind follow the preset unless it leaves them free", () => {
  const ctx = context();
  assert.equal(effectiveLiveBudget(ctx, "live", false), true, "locked on");
  assert.equal(effectiveLiveBudget(ctx, "eval", true), false, "locked off");
  assert.equal(effectiveLiveBudget(ctx, "custom", true), true);
  assert.equal(effectiveLiveBudget(ctx, "custom", undefined), false);
  assert.equal(effectiveKind(ctx, "scoring", "training"), "scoring");
  assert.equal(effectiveKind(ctx, "custom", "scoring"), "scoring");
  assert.equal(effectiveKind(ctx, "custom", "eval"), "training", "eval is never a choice of the form (A20)");
  assert.equal(effectiveKind(ctx, "nope", null), null);
});

test("lock reasons say why, in words", () => {
  const ctx = context();
  assert.match(lockReason("no_human", { context: ctx, preset: "autonomous" }), /Autonomous batch preset always runs with human channels off/);
  assert.match(lockReason("no_human", { context: ctx, preset: "scoring" }), /human channels on/);
  assert.equal(lockReason("no_human", { context: ctx, preset: "custom" }), null);
  assert.match(lockReason("kind", { context: ctx, preset: "scoring" }), /always creates a scoring run/);
  assert.equal(lockReason("kind", { context: ctx, preset: "custom" }), null);
  assert.match(lockReason("live_budget", { context: ctx, preset: "live" }), /always uses the live budget/);
  assert.match(lockReason("tool:submit_locations", { context: ctx, preset: "custom", settings: {} }), /cannot record or submit/);
  assert.match(lockReason("tool:web_search", { context: ctx, preset: "custom", settings: { allow_web: false } }), /web access is off/);
  assert.equal(lockReason("tool:web_search", { context: ctx, preset: "custom", settings: { allow_web: true } }), null);
  assert.match(lockReason("max_mcq", { context: ctx, preset: "custom", settings: { no_human: true } }), /Human channels are off/);
  assert.equal(lockReason("max_mcq", { context: ctx, preset: "scoring", settings: { no_human: false } }), null);
});

test("changed fields and pruned edits only count what differs from the preset", () => {
  const ctx = context();
  assert.deepEqual(changedFields(ctx, "autonomous", {}), []);
  assert.deepEqual(changedFields(ctx, "autonomous", { concurrency: 6, hedge: true, special: { effort: "xhigh" } }), ["hedge"]);
  assert.deepEqual(changedFields(ctx, "custom", { disabled_tools: ["web_search"], standard: { max_turns: 5 } }), ["standard", "disabled_tools"]);
  assert.deepEqual(
    pruneEdits(ctx, "autonomous", { concurrency: 6, hedge: true, standard: { effort: "high", max_turns: 5 }, special: { effort: "xhigh" }, runs_dir: "/x" }),
    { hedge: true, standard: { max_turns: 5 } });
  assert.deepEqual(pruneEdits(ctx, "custom", { disabled_tools: [] }), {});
  const kept = pruneEdits(ctx, "custom", { concurrency: NaN });
  assert.ok(Number.isNaN(kept.concurrency), "an unfinished number stays an edit, so it is reported");
});

test("duplicating a run turns its frozen settings into edits of its preset", () => {
  const ctx = context();
  const frozen = { ...effectiveSettings(ctx, "scoring", {}), hedge: true, concurrency: 4, model: "fake-demo", no_human: true };
  frozen.special = { ...frozen.special, max_spend_usd: 20 };
  const edits = editsFromSettings(ctx, "scoring", frozen);
  assert.deepEqual(edits, { special: { max_spend_usd: 20 }, hedge: true, concurrency: 4 }, "locked fields and an unknown model are left out");
  assert.deepEqual(editsFromSettings(ctx, "scoring", null), {});
  assert.equal(presetForRun(ctx, { preset: "scoring", kind: "scoring" }), "scoring");
  assert.equal(presetForRun(ctx, { preset: null, kind: "cli" }), "custom");
  assert.equal(presetForRun(ctx, { preset: "gone", kind: "eval" }), "eval");
  assert.equal(presetForRun(ctx, null), null);
});

test("the prefill of ?from= carries preset, edits, live budget, kind and set", () => {
  const ctx = context();
  const settings = { ...effectiveSettings(ctx, "custom", {}), hedge: true };
  const filled = prefillFromRun(ctx, { preset: "custom", kind: "live", live_budget: true, set_id: "set-9", settings });
  assert.deepEqual(filled, { preset: "custom", edits: { hedge: true }, liveBudget: true, kind: "live", setId: "set-9", evalEffort: null, evalLimit: null });
  const forced = prefillFromRun(ctx, { preset: "custom", kind: "training", live_budget: false, set_id: null, settings }, "autonomous");
  assert.equal(forced.preset, "autonomous", "?preset= wins over the run's own");
  assert.equal(forced.kind, null);
  assert.equal(forced.liveBudget, undefined);
  assert.equal(prefillFromRun(ctx, null), null);
});

test("the prefill of an evaluation run keeps only what its form can change", () => {
  const ctx = context();
  const settings = { ...effectiveSettings(ctx, "eval", {}), hedge: true, max_tokens: 1000, concurrency: 2 };
  settings.standard = { ...settings.standard, effort: "low" };
  settings.special = { ...settings.special, effort: "low" };
  const filled = prefillFromRun(ctx, { preset: "eval", kind: "eval", live_budget: false, set_id: null, settings, totals: { total: 5 } });
  assert.deepEqual(filled, { preset: "eval", edits: { hedge: true, concurrency: 2 }, liveBudget: undefined, kind: null, setId: null, evalEffort: "low", evalLimit: 5 });
  const plain = prefillFromRun(ctx, { preset: "eval", kind: "eval", settings: effectiveSettings(ctx, "eval", {}), totals: { total: 0 } });
  assert.equal(plain.evalEffort, null, "the saved efforts are not an override");
  assert.equal(plain.evalLimit, null);
});

test("enabled tools, the prompt query and the one-line summary follow the settings", () => {
  const ctx = context();
  const settings = effectiveSettings(ctx, "scoring", { disabled_tools: ["sun_position"], max_mcq: 2 });
  assert.deepEqual(enabledTools(ctx.tools, settings), ["view_crop", "update_candidates", "submit_locations", "search_places", "web_search"]);
  assert.deepEqual(enabledTools(ctx.tools, { ...settings, allow_web: false }), ["view_crop", "update_candidates", "submit_locations"]);
  assert.equal(promptQuery(settings), "allow_web=true&no_human=false&disabled_tools=sun_position&max_mcq=2");
  const line = optionsSummary(settings, { tools: ctx.tools }).join(" | ");
  assert.match(line, /^gpt-6\.1-sol \| effort high \/ xhigh for the Special One \| web on, 5 of 6 tools \| human channels on, up to 2 MCQ per panorama \| hedge off \| 6 in parallel \| watchdog 50 min 00 s$/);
  assert.match(optionsSummary(effectiveSettings(ctx, "live", {}), { tools: ctx.tools, liveBudget: true }).join(" | "), /live budget, 3 min 30 s hard/);
  assert.deepEqual(optionsSummary(null), []);
});

test("preset cards state what the preset sets and locks", () => {
  const ctx = context();
  const facts = Object.fromEntries(presetFacts(ctx, "live").map((fact) => [fact.label, fact.value]));
  assert.equal(facts["Human channels"], "off, locked");
  assert.equal(facts["Hard deadline"], "3 min 30 s (live budget, locked)");
  assert.equal(facts["In parallel"], "1");
  const scoring = Object.fromEntries(presetFacts(ctx, "scoring").map((fact) => [fact.label, fact.value]));
  assert.equal(scoring["Human channels"], "on, locked");
  assert.equal(scoring["Hard deadline"], "14 min, Special One 20 min");
  assert.equal(scoring["Special One"], "exactly one needed");
  assert.equal(facts["Special One"], undefined);
  assert.equal(Object.fromEntries(presetFacts(ctx, "custom").map((fact) => [fact.label, fact.value]))["Human channels"], "on");
  assert.deepEqual(presetFacts(ctx, "nope"), []);
  assert.equal(shortDuration(45), "45 s");
  assert.equal(shortDuration(840), "14 min");
  assert.equal(shortDuration(NaN), "–");
});

// ---------------------------------------------------------------- validation

test("a run id is optional and must be a safe directory name", () => {
  assert.equal(runIdProblem(""), null);
  assert.equal(runIdProblem(null), null);
  assert.equal(runIdProblem("scoring-run_1.a"), null);
  assert.match(runIdProblem("a..b"), /two dots/);
  assert.match(runIdProblem("-starts-with-hyphen"), /starting with a letter or digit/);
  assert.match(runIdProblem("has space"), /letters, digits/);
  assert.match(runIdProblem("x".repeat(101)), /at most 100/);
});

test("valid settings have no problems; each bound of the server is repeated", () => {
  const ctx = context();
  assert.deepEqual(settingsProblems(effectiveSettings(ctx, "scoring", {}), ctx), []);
  const fields = (edits) => settingsProblems(effectiveSettings(ctx, "custom", edits), ctx).map((problem) => problem.field);
  assert.deepEqual(fields({ model: "gpt-unknown" }), ["model"]);
  assert.deepEqual(fields({ max_tokens: 0 }), ["max_tokens"]);
  assert.deepEqual(fields({ max_tokens: 128001 }), ["max_tokens"]);
  assert.deepEqual(fields({ image_detail: "huge" }), ["image_detail"]);
  assert.deepEqual(fields({ max_mcq: 4 }), ["max_mcq"]);
  assert.deepEqual(fields({ max_mcq: 0 }), []);
  assert.deepEqual(fields({ concurrency: 13 }), ["concurrency"]);
  assert.deepEqual(fields({ concurrency: 1.5 }), ["concurrency"]);
  assert.deepEqual(fields({ global_watchdog_s: 0 }), ["global_watchdog_s"]);
  assert.deepEqual(fields({ penalty_scope: "none" }), ["penalty_scope"]);
  assert.deepEqual(fields({ team: "" }), ["team"]);
  assert.deepEqual(fields({ team: "Team <script>" }), ["team"]);
  assert.deepEqual(fields({ team: "Astrolábio 2.0_x-y" }), []);
  assert.deepEqual(fields({ disabled_tools: ["submit_locations"] }), ["disabled_tools"]);
  assert.deepEqual(fields({ disabled_tools: ["made_up"] }), ["disabled_tools"]);
  assert.deepEqual(fields({ standard: { soft_deadline_s: 900 } }), ["standard.soft_deadline_s"], "soft later than hard");
  assert.deepEqual(fields({ live: { max_turns: 0, max_spend_usd: NaN, effort: "extreme" } }), ["live.effort", "live.max_spend_usd", "live.max_turns"]);
});

test("numbers typed into a field: empty and junk are NaN, never 0", () => {
  assert.equal(parseNumber("12"), 12);
  assert.equal(parseNumber(" 0.5 "), 0.5);
  assert.ok(Number.isNaN(parseNumber("")));
  assert.ok(Number.isNaN(parseNumber("1e3")));
  assert.ok(Number.isNaN(parseNumber("abc")));
  assert.ok(Number.isNaN(parseNumber("2.5", { integer: true })));
  assert.equal(parseNumber("3", { integer: true }), 3);
  assert.equal(parseLimit("5"), 5);
  assert.equal(parseLimit("0"), null);
  assert.equal(parseLimit("-2"), null);
  assert.equal(parseLimit("1.5"), null);
  assert.equal(parseLimit(null), null);
});

// ---------------------------------------------------------------- timestamps

test("a timestamp is fourteen digits that are a real date and time", () => {
  assert.equal(isTimestamp("20180511142427"), true);
  assert.equal(isTimestamp("20240229000000"), true);
  assert.equal(isTimestamp("20230229000000"), false, "not a leap year");
  assert.equal(isTimestamp("20181311142427"), false);
  assert.equal(isTimestamp("20180511242427"), false);
  assert.equal(isTimestamp("2018051114242"), false);
  assert.equal(isTimestamp("church of Sao Roque"), false, "free text can never be a timestamp (A18)");
  assert.equal(isTimestamp(20180511142427), false);
});

test("the date-time picker gives the digits as typed, with seconds or without", () => {
  assert.equal(timestampFromInput("2026-10-10T09:30"), "20261010093000");
  assert.equal(timestampFromInput("2026-10-10T09:30:15"), "20261010093015");
  assert.equal(timestampFromInput("2026-10-10T09:30:15.250"), "20261010093015");
  assert.equal(timestampFromInput("2026-02-30T09:30"), null);
  assert.equal(timestampFromInput(""), null);
  assert.equal(timestampFromInput("yesterday"), null);
  assert.equal(formatTimestamp("20180511142427"), "2018-05-11 14:24:27");
  assert.equal(formatTimestamp("odd"), "odd");
  assert.equal(sourceText("folder"), "from the folder name");
  assert.equal(sourceText("operator_bulk"), "set here for every unlabelled panorama");
  assert.equal(sourceText("new_source"), "new_source");
});

// ---------------------------------------------------------------- preflight choices

test("choices are kept by path and sent by the panorama id of the last preflight", () => {
  const rows = [
    row({ rel_path: "Urban/a.jpg", parsed: { label: "Urban", timestamp: null, special: true }, special: true }),
    row({ rel_path: "b.jpg", label: null, parsed: { label: null, timestamp: null, special: false } }),
    row({ rel_path: "non-Urban/a.jpg", panorama_id: "a_2", label: "non-Urban", parsed: { label: "non-Urban", timestamp: "20180511142427", special: false } }),
  ];
  const choices = {
    labels: { "b.jpg": "non-Urban", "Urban/a.jpg": "Urban", "gone.jpg": "Urban", "non-Urban/a.jpg": "Sideways" },
    timestamps: { "b.jpg": "20261010093000", "non-Urban/a.jpg": "20180511142427", "Urban/a.jpg": "not a time" },
    special: "non-Urban/a.jpg",
  };
  assert.deepEqual(taskChoices(rows, choices), {
    overrides: { b: { label: "non-Urban", timestamp: "20261010093000" } },
    special: "a_2",
  }, "what equals the files, names no row or is not a fixed choice is not sent");
  assert.deepEqual(taskChoices(rows, { labels: {}, timestamps: {}, special: null }), {
    overrides: { a: { special: false } }, special: null,
  }, "'No Special One' clears a flag the files set");
  assert.deepEqual(taskChoices(rows, { labels: {}, timestamps: {}, special: undefined }), { overrides: {}, special: null });
  assert.deepEqual(taskChoices([], choices), { overrides: {}, special: null }, "without rows nothing can be keyed");
  assert.deepEqual(pruneChoices(rows, choices), {
    labels: { "b.jpg": "non-Urban", "Urban/a.jpg": "Urban", "non-Urban/a.jpg": "Sideways" },
    timestamps: choices.timestamps,
    special: "non-Urban/a.jpg",
  });
  assert.equal(pruneChoices([], choices).special, undefined);
  assert.equal(pruneChoices([], { labels: {}, timestamps: {}, special: null }).special, null);
  assert.equal(hasChoices({ labels: {}, timestamps: {}, special: undefined }), false);
  assert.equal(hasChoices({ labels: {}, timestamps: {}, special: null }), true);
  assert.equal(hasChoices({ labels: { "b.jpg": "Urban" }, timestamps: {} }), true);
  assert.equal(hasChoices(null), false);
});

test("row counts, the label summary and the bulk-label rows leave out files already in the run", () => {
  const rows = [
    row({ rel_path: "Urban/a.jpg", special: true }),
    row({ rel_path: "b.jpg", label: null }),
    row({ rel_path: "c.jpg", label: "non-Urban", sources: { label: "operator_bulk", timestamp: "none", special: "none" } }),
    row({ rel_path: "d.jpg", duplicate: true }),
  ];
  assert.deepEqual(countRows(rows), { total: 3, urban: 1, nonUrban: 1, unlabelled: 1, special: ["a"], skipped: 1 });
  assert.equal(labelSummary(rows), "3: 1 Urban, 1 non-Urban, 1 without a label");
  assert.equal(labelSummary([]), "none");
  assert.deepEqual(unlabelledRows(rows).map((item) => item.panorama_id), ["b", "c"]);
  assert.equal(costCeiling(rows), 24);
  assert.equal(costCeiling([]), 0);
});

test("stored images the loader does not read are counted, for upload sets only", () => {
  const preflight = { rows: [row(), row({ rel_path: "b.jpg" })] };
  assert.equal(unreadImageCount({ kind: "upload", panoramas: 7 }, preflight), 5);
  assert.equal(unreadImageCount({ kind: "upload", panoramas: 2 }, preflight), 0);
  assert.equal(unreadImageCount({ kind: "upload", panoramas: 1 }, preflight), 0, "a stale count never warns");
  assert.equal(unreadImageCount({ kind: "path", panoramas: 7 }, preflight), 0);
  assert.equal(unreadImageCount({ kind: "upload" }, preflight), 0);
  assert.equal(unreadImageCount(null, preflight), 0);
  assert.equal(unreadImageCount({ kind: "upload", panoramas: 7 }, null), 0);
  assert.equal(unreadImagesText(0), null);
  assert.match(unreadImagesText(1), /^1 stored image is not read/);
  assert.match(unreadImagesText(5), /^5 stored images are not read .* Start a new set/);
});

test("the preflight body carries preset, budgets and choices; add mode carries the run instead", () => {
  const ctx = context();
  const rows = [row({ rel_path: "b.jpg", label: null, parsed: { label: null, timestamp: null, special: false } })];
  const filled = form(ctx, "scoring", {
    choices: { labels: { "b.jpg": "Urban" }, timestamps: {}, special: "b.jpg" }, runId: "trial-2", bulkOn: true, bulkLabel: "non-Urban",
  });
  const body = preflightBody(filled, rows);
  assert.deepEqual(Object.keys(body).sort(), ["apply_label_to_unlabelled", "launch_run_id", "live_budget", "overrides", "preset", "settings", "special"]);
  assert.deepEqual(body.overrides, { b: { label: "Urban" } });
  assert.equal(body.special, "b");
  assert.equal(body.apply_label_to_unlabelled, "non-Urban");
  assert.equal(body.launch_run_id, "trial-2");
  assert.deepEqual(Object.keys(body.settings), ["standard", "special", "live"]);
  assert.equal(preflightBody({ ...filled, runId: "bad id" }, rows).launch_run_id, undefined);
  assert.equal(preflightBody({ ...filled, bulkOn: false }, rows).apply_label_to_unlabelled, null, "the box must be ticked");
  assert.equal(preflightBody({ ...filled, bulkLabel: "Rural" }, rows).apply_label_to_unlabelled, null);
  assert.deepEqual(preflightBody({ ...filled, addRunId: "run-7" }, rows), {
    overrides: { b: { label: "Urban" } }, special: "b", apply_label_to_unlabelled: "non-Urban", run_id: "run-7",
  });
});

test("the launch spec holds every launch field and nothing else from the settings", () => {
  const ctx = context();
  const rows = [row({ rel_path: "b.jpg" })];
  const spec = launchSpec(form(ctx, "scoring", { choices: { labels: {}, timestamps: {}, special: "b.jpg" } }), rows, "token-1");
  assert.deepEqual(Object.keys(spec).sort(), ["apply_label_to_unlabelled", "live_budget", "overrides", "preflight_token", "preset", "run_id", "set_id", "settings", "special"]);
  assert.deepEqual(Object.keys(spec.settings), LAUNCH_FIELDS);
  assert.equal(spec.settings.cue_max_chars, undefined);
  assert.equal(spec.preset, "scoring");
  assert.equal(spec.set_id, "set-1");
  assert.equal(spec.special, "b");
  assert.equal(spec.run_id, null);
  assert.equal(spec.live_budget, false);
  assert.equal(spec.preflight_token, "token-1");
  assert.equal(spec.kind, undefined, "only the custom preset may name a kind");
  assert.equal(spec.confirm_no_key, undefined);
  const custom = launchSpec(form(ctx, "custom", { kind: "live", runId: "demo", confirmNoKey: true }), rows, null);
  assert.equal(custom.kind, "live");
  assert.equal(custom.run_id, "demo");
  assert.equal(custom.confirm_no_key, true);
  assert.equal(custom.preflight_token, undefined);
  assert.equal(launchSpec(form(ctx, "custom", { kind: "eval" }), rows).kind, undefined);
  assert.deepEqual(addPanoramasBody(form(ctx, "custom", { addRunId: "run-7" }), rows), {
    set_id: "set-1", overrides: {}, special: null, apply_label_to_unlabelled: null,
  });
});

test("the evaluation body is the short form of contract 4.6", () => {
  const ctx = context();
  const base = form(ctx, "eval", { edits: { hedge: true, disabled_tools: ["sun_position"], allow_web: false, concurrency: 2 } });
  assert.deepEqual(evalBody(base), { hedge: true, web: false, tools_off: ["sun_position"], concurrency: 2 });
  assert.deepEqual(evalBody({ ...base, evalEffort: "low", evalLimit: 3, runId: "eval-a", confirmNoKey: true }),
    { hedge: true, web: false, tools_off: ["sun_position"], concurrency: 2, effort: "low", limit: 3, run_id: "eval-a" },
    "confirm_no_key belongs to the launch, not to the estimate");
  assert.equal(evalBody({ ...base, confirmNoKey: true }, { launch: true }).confirm_no_key, true);
  assert.equal(evalBody({ ...base, evalEffort: "turbo", evalLimit: 0 }).effort, undefined);
});

// ---------------------------------------------------------------- uploads

test("an upload keeps the file's own path; hidden and foreign files are never sent", () => {
  assert.deepEqual(uploadPlan("Urban/pano_1.jpg", 10), { action: "upload", path: "Urban/pano_1.jpg", trimmed: false });
  assert.deepEqual(uploadPlan("/set/non-Urban/pano_2.JPG", 10), { action: "upload", path: "set/non-Urban/pano_2.JPG", trimmed: false });
  assert.deepEqual(uploadPlan("a/b/c/set/Urban/p.png", 10), { action: "upload", path: "c/set/Urban/p.png", trimmed: true });
  assert.equal(uploadPlan("set\\Urban\\p.jpg", 10).path, "set/Urban/p.jpg");
  assert.equal(uploadPlan("labels.csv", 10).action, "upload");
  assert.equal(uploadPlan("set.zip", 10).action, "upload");
  assert.equal(uploadPlan(".DS_Store", 10).action, "ignore");
  assert.equal(uploadPlan("__MACOSX/Urban/p.jpg", 10).action, "ignore");
  assert.equal(uploadPlan("Urban/.hidden/p.jpg", 10).action, "ignore");
  assert.equal(uploadPlan("notes.docx", 10).action, "reject");
  assert.equal(uploadPlan("README", 10).action, "reject");
  assert.equal(uploadPlan("a/../b.jpg", 10).action, "reject");
  assert.equal(uploadPlan("", 10).action, "reject");
  assert.match(uploadPlan("big.zip", 201 * 1024 * 1024).reason, /Larger than 200 MB/);
  assert.equal(uploadPlan("exact.zip", 200 * 1024 * 1024).action, "upload");
});

test("upload and image URLs are same-origin API paths with every part escaped", () => {
  assert.equal(uploadUrl("set-1", "Urban/a b#.jpg"), "/api/sets/set-1/files?path=Urban%2Fa%20b%23.jpg");
  assert.equal(setImageUrl("set-1", "non-Urban/a b?.jpg", 320), "/api/sets/set-1/image/non-Urban/a%20b%3F.jpg?w=320");
  assert.equal(setImageUrl("s/../x", "a.jpg", "full"), "/api/sets/s%2F..%2Fx/image/a.jpg?w=full");
});

test("a dropped folder names the set, unless it is a label folder or there is no single one", () => {
  assert.equal(setNameFromPaths(["trial/Urban/a.jpg", "trial/non-Urban/b.jpg", "trial/labels.csv"]), "trial");
  assert.equal(setNameFromPaths(["Urban/a.jpg", "Urban/b.jpg"]), null);
  assert.equal(setNameFromPaths(["a.jpg", "trial/b.jpg"]), null);
  assert.equal(setNameFromPaths(["one/a.jpg", "two/b.jpg"]), null);
  assert.equal(setNameFromPaths([]), null);
});

test("upload totals count bytes of what is sent, and files that are not", () => {
  const totals = uploadTotals([
    { action: "upload", state: "done", size: 100, loaded: 100 },
    { action: "upload", state: "uploading", size: 300, loaded: 150 },
    { action: "upload", state: "failed", size: 100, loaded: 500 },
    { action: "upload", state: "queued", size: 0, loaded: 0 },
    { action: "ignore", state: "ignored", size: 9 },
    { action: "reject", state: "rejected", size: 9 },
  ]);
  assert.deepEqual(totals, { files: 4, done: 1, failed: 1, pending: 2, bytes: 500, sent: 350, share: 0.7, skipped: 2 });
  assert.equal(uploadTotals([]).share, 0);
  assert.equal(uploadTotals([{ action: "upload", state: "done", size: 0 }]).share, 1);
});

// ---------------------------------------------------------------- ceilings

test("the time ceiling is the longest deadline up to the slots, a safe bound beyond, capped by the watchdog", () => {
  assert.equal(timeCeiling([], 6, 3000), null);
  assert.deepEqual(timeCeiling([840, 840, 1200], 6, 3000), { seconds: 1200, uncapped: 1200, capped: false });
  assert.equal(timeCeiling(Array(12).fill(840), 6, 3000).seconds, 1680, "equal deadlines: two rounds");
  assert.equal(timeCeiling(Array(13).fill(840), 6, 3000).seconds, 2520, "a thirteenth needs a third round");
  // Unequal deadlines: the bound that holds whichever panorama starts first.
  assert.equal(timeCeiling([1200, ...Array(11).fill(840)], 6, 9000).seconds, (1200 + 11 * 840) / 6 + 1200 * (1 - 1 / 6));
  assert.deepEqual(timeCeiling([840, 840, 840], 1, 2000), { seconds: 2000, uncapped: 2520, capped: true });
  assert.equal(timeCeiling([210], 0, null).seconds, 210, "a bad concurrency is read as one slot");
});

test("past runs give an estimate only when there are any", () => {
  assert.equal(pastEstimate({}, "scoring", 6), null);
  assert.equal(pastEstimate({ scoring: { runs: 0, panoramas: 0, mean_cost_usd: null } }, "scoring", 6), null);
  assert.deepEqual(pastEstimate({ scoring: { runs: 2, panoramas: 12, mean_cost_usd: 1.2345 } }, "scoring", 6),
    { usd: 7.41, per_panorama_usd: 1.2345, runs: 2, panoramas: 12 });
  assert.equal(pastEstimate({ scoring: { runs: 2, panoramas: 12, mean_cost_usd: 1 } }, "scoring", 0), null);
});

// ---------------------------------------------------------------- readiness

test("the readiness checklist gives one verdict per item", () => {
  const ctx = context();
  const verdicts = (input) => Object.fromEntries(readinessItems(input).map((item) => [item.id, item.verdict]));
  assert.deepEqual(verdicts({ readiness: ctx.readiness }), { openai: "unknown", google: "ok", mapillary: "warn", internet: "ok", disk: "ok", active: "ok" });
  assert.equal(verdicts({ readiness: ctx.readiness, health: { openai: { present: true, ok: true } } }).openai, "ok");
  assert.equal(verdicts({ readiness: ctx.readiness, health: { openai: { present: true, ok: false } } }).openai, "bad");
  const none = { ...ctx.readiness, openai_key: false, internet: false, disk_free_bytes: 500 * 1024 ** 2, active_runs: ["run-a", "run-b"] };
  assert.deepEqual(verdicts({ readiness: none }), { openai: "bad", google: "ok", mapillary: "warn", internet: "bad", disk: "bad", active: "warn" });
  assert.equal(verdicts({ readiness: { ...none, disk_free_bytes: 3 * 1024 ** 3, internet: null } }).disk, "warn");
  assert.equal(verdicts({ readiness: { ...none, disk_free_bytes: null, internet: null } }).disk, "unknown");
  assert.equal(verdicts({ readiness: { ...none, internet: null } }).internet, "unknown");
  const fake = readinessItems({ readiness: none, fakeModel: true });
  assert.equal(fake[0].id, "model");
  assert.match(fake[0].text, /answers are not real/);
  assert.ok(!fake.some((item) => item.id === "openai"), "the demo model needs no key");
  const own = readinessItems({ readiness: none, ownRunId: "run-a" }).find((item) => item.id === "active");
  assert.deepEqual(own.runs, ["run-b"]);
  assert.equal(readinessItems({ readiness: { ...none, active_runs: ["run-a"] }, ownRunId: "run-a" }).find((item) => item.id === "active").verdict, "ok");
  assert.equal(worstVerdict(readinessItems({ readiness: none })), "bad");
  assert.equal(worstVerdict(readinessItems({ readiness: ctx.readiness, health: { openai: { ok: true } } })), "warn");
  assert.equal(worstVerdict([]), "ok");
  assert.equal(needsNoKeyConfirm(none, false), true);
  assert.equal(needsNoKeyConfirm(none, true), false);
  assert.equal(needsNoKeyConfirm(ctx.readiness, false), false);
  assert.equal(needsNoKeyConfirm(null, false), false);
});

test("readiness is brought up to date from the event stream", () => {
  const ctx = context();
  assert.equal(liveReadiness(null, {}, []), null);
  assert.deepEqual(liveReadiness(ctx.readiness, null, null), ctx.readiness);
  const live = liveReadiness(ctx.readiness, {
    openai: { present: false, ok: null }, google: { present: true }, mapillary: { present: true }, internet: { ok: null },
  }, ["run-a"]);
  assert.equal(live.openai_key, false);
  assert.equal(live.mapillary_token, true);
  assert.equal(live.internet, true, "an unknown check does not overwrite a known one");
  assert.deepEqual(live.active_runs, ["run-a"]);
  assert.deepEqual(ctx.readiness.active_runs, [], "the context is not changed");
  assert.equal(liveReadiness(ctx.readiness, { internet: { ok: false } }, null).internet, false);
});

// ---------------------------------------------------------------- steps and blockers

test("steps unlock in order: preset, panoramas, a ready preflight", () => {
  const open = (state) => [state.panoramas.open, state.preflight.open, state.options.open];
  assert.deepEqual(open(stepStates({ preset: null })), [false, false, false]);
  assert.deepEqual(open(stepStates({ preset: "scoring" })), [true, false, false]);
  assert.match(stepStates({ preset: "scoring", uploading: true }).preflight.reason, /still uploading/);
  assert.deepEqual(open(stepStates({ preset: "scoring", setId: "s" })), [true, true, false]);
  assert.match(stepStates({ preset: "scoring", setId: "s" }).options.reason, /being checked/);
  assert.match(stepStates({ preset: "scoring", setId: "s", preflightError: "gone" }).options.reason, /could not be checked/);
  assert.match(stepStates({ mode: "add", setId: "s", preflight: { ready: false, blocking: [{ code: "no_label" }] } }).options.reason, /blocks adding them/);
  assert.deepEqual(open(stepStates({ preset: "scoring", setId: "s", preflight: { ready: false, blocking: [{ code: "no_label" }] } })), [true, true, false]);
  assert.deepEqual(open(stepStates({ preset: "scoring", setId: "s", preflight: { ready: true, blocking: [] } })), [true, true, true]);
  assert.deepEqual(open(stepStates({ preset: "scoring", setId: "s", preflight: { ready: false, blocking: [{ code: "id_collision" }] } })), [true, true, true],
    "a clash with a reused run id is fixed in step 4, so it must not lock step 4");
  assert.deepEqual(open(stepStates({ preset: "eval" })), [true, true, true]);
  assert.deepEqual(open(stepStates({ mode: "add", preset: null })), [true, false, false]);
  assert.deepEqual(open(stepStates({ mode: "add", setId: "s", preflight: { ready: true } })), [true, true, true]);
});

test("the launch is blocked for every reason the operator can act on, in order", () => {
  const ctx = context();
  const ready = { ready: true, blocking: [], rows: [row()] };
  assert.deepEqual(launchBlockers({ context: null }), ["The launch settings have not loaded yet."]);
  assert.deepEqual(launchBlockers({ context: ctx }), ["Choose a preset (step 1)."]);
  assert.deepEqual(launchBlockers({ context: ctx, preset: "scoring" }), ["Choose the panoramas (step 2)."]);
  assert.deepEqual(launchBlockers({ context: ctx, preset: "scoring", setId: "s", uploading: true }), ["Files are still uploading.", "The panoramas are being checked."]);
  assert.deepEqual(launchBlockers({ context: ctx, preset: "scoring", setId: "s", preflight: ready, preflightLoading: true }), ["The panoramas are being checked."]);
  assert.deepEqual(launchBlockers({ context: ctx, preset: "scoring", setId: "s", preflight: ready, preflightError: "gone" }), ["The panoramas could not be checked: gone"]);
  assert.deepEqual(
    launchBlockers({ context: ctx, preset: "scoring", setId: "s", preflight: { ready: false, blocking: [{ text: "Choose Urban or non-Urban for: b." }, { text: "A scoring run needs its Special One." }] } }),
    ["Choose Urban or non-Urban for: b.", "A scoring run needs its Special One."]);
  assert.deepEqual(launchBlockers({ context: ctx, preset: "scoring", setId: "s", preflight: ready }), []);
  assert.deepEqual(
    launchBlockers({ context: ctx, preset: "custom", setId: "s", preflight: ready, problems: [{ field: "team", text: "x" }], runIdError: "bad" }),
    ["Correct the settings marked in step 4 (1).", "Correct the run id: bad"]);
  assert.deepEqual(launchBlockers({ context: ctx, preset: "scoring", setId: "s", preflight: ready, launching: true }), ["Launching…"]);
});

test("the demo model blocks scoring and live runs, as the server would refuse them", () => {
  const ctx = context({ fake_model: true });
  const ready = { ready: true, blocking: [], rows: [row()] };
  assert.match(launchBlockers({ context: ctx, preset: "scoring", setId: "s", preflight: ready, fakeModel: true })[0], /demo model is active/);
  assert.match(launchBlockers({ context: ctx, preset: "custom", kind: "live", setId: "s", preflight: ready, fakeModel: true })[0], /ASTROLABIO_FAKE_MODEL/);
  assert.deepEqual(launchBlockers({ context: ctx, preset: "autonomous", kind: "training", setId: "s", preflight: ready, fakeModel: true }), []);
});

test("an evaluation launch waits for the estimate and repeats what blocks it", () => {
  const ctx = context();
  assert.deepEqual(launchBlockers({ context: ctx, preset: "eval" }), ["The evaluation set is being checked."]);
  assert.deepEqual(launchBlockers({ context: ctx, preset: "eval", estimateError: "down" }), ["The evaluation set could not be checked: down"]);
  assert.deepEqual(launchBlockers({ context: ctx, preset: "eval", estimate: { blocking: ["Label them first."] } }), ["Label them first."]);
  assert.deepEqual(launchBlockers({ context: ctx, preset: "eval", estimate: { blocking: [] }, estimateLoading: true }), ["The evaluation set is being checked."]);
  assert.deepEqual(launchBlockers({ context: ctx, preset: "eval", estimate: { blocking: [] } }), []);
});

test("adding panoramas needs an owned run that is not an evaluation, and something new to add", () => {
  const ready = { ready: true, blocking: [], rows: [row()] };
  const run = { run_id: "r", owned: true, kind: "scoring" };
  assert.deepEqual(launchBlockers({ mode: "add", addRun: run, setId: "s", preflight: ready }), []);
  assert.match(launchBlockers({ mode: "add", addRun: null, setId: "s", preflight: ready })[0], /has not loaded/);
  assert.match(launchBlockers({ mode: "add", addRun: { ...run, owned: false }, setId: "s", preflight: ready })[0], /not held by the running server/);
  assert.match(launchBlockers({ mode: "add", addRun: { ...run, kind: "eval" }, setId: "s", preflight: ready })[0], /evaluation set only/);
  assert.match(launchBlockers({ mode: "add", addRun: run, setId: "s", preflight: { ready: true, rows: [row({ duplicate: true })] } })[0], /nothing to add/);
  assert.deepEqual(launchBlockers({ mode: "add", addRun: run, setId: "s", preflight: ready, launching: true }), ["Adding the panoramas…"]);
});

test("the button says what it will do", () => {
  const ctx = context();
  assert.equal(launchLabel({ context: ctx, preset: "scoring" }), "Launch scoring run");
  assert.equal(launchLabel({ context: ctx, preset: "live" }), "Go: launch on stage");
  assert.equal(launchLabel({ context: ctx, preset: "autonomous" }), "Launch autonomous batch");
  assert.equal(launchLabel({ context: ctx, preset: "eval" }), "Launch evaluation run");
  assert.equal(launchLabel({ context: ctx, preset: "custom" }), "Launch custom run");
  assert.equal(launchLabel({ context: ctx, preset: "scoring", noKey: true }), "Launch anyway (fallback answers only)");
  assert.equal(launchLabel({ context: ctx }), "Launch");
  assert.equal(launchLabel({ mode: "add", count: 1 }), "Add 1 panorama to the run");
  assert.equal(launchLabel({ mode: "add", count: 3 }), "Add 3 panoramas to the run");
  assert.equal(modeOf({ no_human: true }), "AUTONOMOUS");
  assert.equal(modeOf({ no_human: false }), "ASSISTED");
});

test("only an unanswered or failed request may be sent again with the same key", () => {
  assert.equal(canRetry({ status: 0 }), true);
  assert.equal(canRetry({ status: 503 }), true);
  assert.equal(canRetry({ status: 422 }), false);
  assert.equal(canRetry({ status: 409 }), false);
  assert.equal(canRetry(new Error("boom")), false);
  assert.equal(canRetry(null), false);
});

test("the launch summary names preset, panoramas, Special One, mode and both ceilings", () => {
  const ctx = context({ estimates: { scoring: { runs: 1, panoramas: 6, mean_cost_usd: 2 } } });
  const rows = [
    row({ rel_path: "Urban/a.jpg", special: true, budget: { ...row().budget, hard_deadline_s: 1200, max_spend_usd: 15 } }),
    row({ rel_path: "non-Urban/b.jpg", label: "non-Urban" }),
  ];
  const lines = Object.fromEntries(summaryLines({
    context: ctx, preset: "scoring", kind: "scoring", settings: effectiveSettings(ctx, "scoring", {}), liveBudget: false,
    rows, ceilingUsd: 23, estimates: ctx.estimates, runId: "",
  }));
  assert.equal(lines.Preset, "Scoring run");
  assert.equal(lines.Panoramas, "2: 1 Urban, 1 non-Urban");
  assert.equal(lines["Special One"], "a");
  assert.match(lines.Mode, /^ASSISTED \(MCQ, cue and geocode available, each penalised\)$/);
  assert.equal(lines["Cost ceiling"], "$23.00 (sum of the spend caps); past runs of this preset suggest about $4.00");
  assert.equal(lines["Time ceiling"], "20 min 00 s (hard deadlines, 6 in parallel)");
  assert.equal(lines["Run id"], "UTC timestamp, made at launch");
  const custom = Object.fromEntries(summaryLines({
    context: ctx, preset: "custom", kind: "live", settings: effectiveSettings(ctx, "custom", { no_human: true, global_watchdog_s: 600 }), liveBudget: false,
    rows, ceilingUsd: null, estimates: {}, runId: "demo",
  }));
  assert.equal(custom.Preset, "Custom (live run)");
  assert.match(custom.Mode, /^AUTONOMOUS/);
  assert.equal(custom["Cost ceiling"], "$23.00 (sum of the spend caps)", "falls back to the sum over the rows");
  assert.equal(custom["Time ceiling"], "10 min 00 s (the global watchdog ends the run)");
  assert.equal(custom["Run id"], "demo");
});

test("the summary of an evaluation run and of an addition", () => {
  const ctx = context();
  const settings = effectiveSettings(ctx, "eval", {});
  const waiting = Object.fromEntries(summaryLines({ context: ctx, preset: "eval", kind: "eval", settings, liveBudget: false, rows: [], estimates: {}, runId: "", evalMode: true, estimate: null }));
  assert.equal(waiting.Panoramas, "0 from the evaluation set");
  assert.equal(waiting["Cost ceiling"], "unknown");
  assert.equal(waiting["Time ceiling"], "unknown");
  assert.equal(waiting["Special One"], undefined);
  const known = Object.fromEntries(summaryLines({
    context: ctx, preset: "eval", kind: "eval", settings, liveBudget: false, rows: [], estimates: {}, runId: "", evalMode: true,
    estimate: { panoramas: 12, cost_ceiling_usd: 96 },
  }));
  assert.equal(known.Panoramas, "12 from the evaluation set");
  assert.equal(known["Cost ceiling"], "$96.00 (sum of the spend caps)");
  assert.match(known["Time ceiling"], /^28 min 00 s \(hard deadlines, 6 in parallel\)$/);
  const added = Object.fromEntries(addSummaryLines({
    run: { run_id: "r1", kind: "scoring", no_human: false, state: "running", totals: { total: 6, done: 2 } },
    rows: [row({ special: true }), row({ rel_path: "x.jpg", duplicate: true })], ceilingUsd: 8,
  }));
  assert.equal(added.Run, "r1 (scoring, ASSISTED, running)");
  assert.equal(added["In the run now"], "6 panoramas, 2 done");
  assert.equal(added["To add"], "1: 1 Urban (1 already in the run, skipped)");
  assert.equal(added["Special One"], "a");
  assert.match(added["Added cost ceiling"], /^\$8\.00/);
  assert.ok(!("Run" in Object.fromEntries(addSummaryLines({ run: null, rows: [], ceilingUsd: null }))));
});
