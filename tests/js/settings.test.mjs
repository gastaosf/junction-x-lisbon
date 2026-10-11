import test from "node:test";
import assert from "node:assert/strict";

import {
  KEY_NAMES,
  NOTE_MAX,
  SECTIONS,
  addRoot,
  answerControl,
  answerEffect,
  answerValueWords,
  buildAnswersBody,
  buildDefaultsBody,
  buildPathsBody,
  canReset,
  checkKeyValue,
  controlKind,
  crossErrors,
  diskRows,
  editableRoots,
  fieldBlocks,
  groupFields,
  healthSummary,
  isDirty,
  isSetsRoot,
  keyStatus,
  keyTestLines,
  lanState,
  latencyWords,
  maskJoinUrl,
  notificationState,
  parseRaw,
  problemsByField,
  readPath,
  resetScope,
  restartWords,
  sameValue,
  sectionAt,
  sectionFromHash,
  serviceStatus,
  toRaw,
  topKey,
  validateField,
  windowStats,
} from "../../server/static/console/js/logic/settings.js";

// The shapes `GET /api/settings` sends (server/routes/settings.py), cut down to what the tests need.
const FIELDS = [
  { key: "team", group: "Run", label: "Team name", type: "text", help: "", max_length: 40 },
  { key: "no_human", group: "Autonomy", label: "Autonomous", type: "bool", help: "" },
  { key: "max_mcq", group: "Autonomy", label: "Max MCQs per panorama", type: "int", help: "", min: 0, max: 3 },
  { key: "model", group: "Model", label: "Model", type: "choice", help: "", choices: ["gpt-a", "gpt-b"] },
  { key: "standard.effort", group: "Model", label: "Effort, standard", type: "choice", help: "", choices: ["low", "high"] },
  { key: "special.effort", group: "Model", label: "Effort, Special One", type: "choice", help: "", choices: ["low", "high"] },
  { key: "standard.soft_deadline_s", group: "Budgets", label: "Soft deadline, standard", type: "number", help: "", min: 1, unit: "s" },
  { key: "standard.hard_deadline_s", group: "Budgets", label: "Hard deadline, standard", type: "number", help: "", min: 1, unit: "s" },
  { key: "standard.max_turns", group: "Budgets", label: "Max turns, standard", type: "int", help: "", min: 1 },
  { key: "standard.max_spend_usd", group: "Budgets", label: "Max spend, standard", type: "number", help: "", min: 0.01, unit: "USD" },
  { key: "special.soft_deadline_s", group: "Budgets", label: "Soft deadline, Special One", type: "number", help: "", min: 1, unit: "s" },
  { key: "special.hard_deadline_s", group: "Budgets", label: "Hard deadline, Special One", type: "number", help: "", min: 1, unit: "s" },
  { key: "allow_web", group: "Tools", label: "Web tools on (Q1)", type: "bool", help: "" },
  { key: "disabled_tools", group: "Tools", label: "Tools switched off", type: "tools", help: "", choices: ["web_search", "geocode", "street_view"] },
  { key: "penalty_scope", group: "Answer", label: "Penalty scope (Q2)", type: "choice", help: "", choices: ["whole_list", "subsequent"] },
];

const DEFAULTS = {
  team: "astrolabio",
  no_human: false,
  max_mcq: 3,
  model: "gpt-a",
  standard: { effort: "high", soft_deadline_s: 420, hard_deadline_s: 540, max_turns: 40, max_spend_usd: 2.5 },
  special: { effort: "high", soft_deadline_s: 900, hard_deadline_s: 1200, max_turns: 80, max_spend_usd: 6 },
  allow_web: true,
  disabled_tools: [],
  penalty_scope: "whole_list",
};

const field = (key) => FIELDS.find((item) => item.key === key);

// ---------------------------------------------------------------- sections

test("the five hashes of the URL contract are sections, in that order", () => {
  const ids = SECTIONS.map((section) => section.id);
  assert.deepEqual(ids.filter((id) => ["keys", "defaults", "organiser", "health", "lan"].includes(id)),
    ["keys", "defaults", "organiser", "health", "lan"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("sectionFromHash accepts a hash with or without #, and nothing else", () => {
  assert.equal(sectionFromHash("#health"), "health");
  assert.equal(sectionFromHash("lan"), "lan");
  assert.equal(sectionFromHash("#nope"), null);
  assert.equal(sectionFromHash(""), null);
  assert.equal(sectionFromHash(null), null);
  assert.equal(sectionFromHash("#%E0%A4%A"), null); // a malformed escape is not a section
});

test("sectionAt picks the last section whose top has passed the reading line", () => {
  const tops = [{ id: "keys", top: -900 }, { id: "defaults", top: -40 }, { id: "organiser", top: 600 }];
  assert.equal(sectionAt(tops, 80), "defaults");
  assert.equal(sectionAt([{ id: "keys", top: 200 }, { id: "defaults", top: 900 }], 80), "keys");
  assert.equal(sectionAt([], 80), null);
});

// ---------------------------------------------------------------- reading and checking fields

test("topKey and readPath follow dotted keys", () => {
  assert.equal(topKey("standard.max_turns"), "standard");
  assert.equal(topKey("team"), "team");
  assert.equal(readPath(DEFAULTS, "standard.max_turns"), 40);
  assert.equal(readPath(DEFAULTS, "team"), "astrolabio");
  assert.equal(readPath(DEFAULTS, "live.max_turns"), undefined);
  assert.equal(readPath(null, "team"), undefined);
});

test("controlKind falls back to text, or to a choice when choices are given", () => {
  assert.equal(controlKind(field("no_human")), "bool");
  assert.equal(controlKind(field("disabled_tools")), "tools");
  assert.equal(controlKind({ key: "x", type: "duration" }), "text");
  assert.equal(controlKind({ key: "x", type: "enum", choices: ["a"] }), "choice");
});

test("toRaw gives the control's own form of a saved value", () => {
  assert.equal(toRaw(field("no_human"), true), true);
  assert.equal(toRaw(field("no_human"), null), false);
  assert.equal(toRaw(field("max_mcq"), 3), "3");
  assert.equal(toRaw(field("standard.soft_deadline_s"), 420.0), "420");
  assert.equal(toRaw(field("standard.max_spend_usd"), 2.5), "2.5");
  assert.equal(toRaw(field("team"), undefined), "");
  assert.deepEqual(toRaw(field("disabled_tools"), ["web_search", "geocode"]), ["geocode", "web_search"]);
});

test("a whole-number field refuses text, fractions and values outside its bounds", () => {
  const f = field("max_mcq");
  assert.deepEqual(parseRaw(f, "2"), { value: 2, error: null });
  assert.deepEqual(parseRaw(f, " 0 "), { value: 0, error: null });
  assert.equal(validateField(f, ""), "Enter a whole number.");
  assert.equal(validateField(f, "two"), "Must be a number.");
  assert.equal(validateField(f, "1.5"), "Must be a whole number.");
  assert.equal(validateField(f, "4"), "Must be 3 or less.");
  assert.equal(validateField(f, "-1"), "Must be 0 or more.");
});

test("a number field accepts decimals and keeps to its minimum", () => {
  const f = field("standard.max_spend_usd");
  assert.deepEqual(parseRaw(f, "0.75"), { value: 0.75, error: null });
  assert.equal(validateField(f, "0"), "Must be 0.01 or more.");
  assert.equal(validateField(f, ""), "Enter a number.");
  assert.equal(validateField(f, "Infinity"), "Must be a number.");
});

test("a choice must be one of the listed values; text keeps to its length", () => {
  assert.equal(validateField(field("model"), "gpt-b"), null);
  assert.equal(validateField(field("model"), "gpt-z"), "Choose one of the listed values.");
  assert.equal(validateField(field("team"), "x".repeat(40)), null);
  assert.equal(validateField(field("team"), "x".repeat(41)), "At most 40 characters.");
  assert.deepEqual(parseRaw(field("team"), "  Lisbon 1 "), { value: "Lisbon 1", error: null });
});

test("a tools field sends a sorted list without repeats and names what it cannot switch", () => {
  const f = field("disabled_tools");
  assert.deepEqual(parseRaw(f, ["web_search", "geocode", "geocode"]), { value: ["geocode", "web_search"], error: null });
  assert.match(validateField(f, ["submit_locations"]), /submit_locations cannot be switched off/);
  assert.deepEqual(parseRaw(f, null), { value: [], error: null });
});

test("sameValue compares lists as sets and does not confuse 0, false and empty", () => {
  assert.equal(sameValue(["a", "b"], ["b", "a"]), true);
  assert.equal(sameValue(["a"], ["a", "b"]), false);
  assert.equal(sameValue([], null), false);
  assert.equal(sameValue(420, 420.0), true);
  assert.equal(sameValue(0, false), false);
  assert.equal(sameValue("", null), false);
  assert.equal(sameValue(undefined, null), true);
});

test("isDirty: a control that shows the saved value is clean, unreadable content is dirty", () => {
  assert.equal(isDirty(field("max_mcq"), 3, "3"), false);
  assert.equal(isDirty(field("max_mcq"), 3, " 3 "), false);
  assert.equal(isDirty(field("max_mcq"), 3, "2"), true);
  assert.equal(isDirty(field("max_mcq"), 3, ""), true);
  assert.equal(isDirty(field("disabled_tools"), ["geocode"], ["geocode"]), false);
  assert.equal(isDirty(field("no_human"), false, true), true);
});

// ---------------------------------------------------------------- layout of the form

test("groupFields keeps the server's order of groups and of fields", () => {
  const groups = groupFields(FIELDS);
  assert.deepEqual(groups.map((group) => group.group), ["Run", "Autonomy", "Model", "Budgets", "Tools", "Answer"]);
  assert.deepEqual(groups[1].fields.map((item) => item.key), ["no_human", "max_mcq"]);
  assert.deepEqual(groupFields([{ key: "x" }]).map((group) => group.group), ["Other"]);
  assert.deepEqual(groupFields(null), []);
});

test("fieldBlocks puts each budget on a line of its own and leaves single dotted fields in the flow", () => {
  const budgets = groupFields(FIELDS).find((group) => group.group === "Budgets").fields;
  const blocks = fieldBlocks(budgets);
  assert.deepEqual(blocks.map((block) => [block.prefix, block.fields.length]), [["standard", 4], ["special", 2]]);
  const model = groupFields(FIELDS).find((group) => group.group === "Model").fields;
  // model, standard.effort, special.effort: no two neighbours share a prefix
  assert.deepEqual(fieldBlocks(model).map((block) => [block.prefix, block.fields.length]), [[null, 3]]);
  assert.deepEqual(fieldBlocks([]), []);
});

// ---------------------------------------------------------------- what Save sends

test("nothing touched: nothing to send", () => {
  const plan = buildDefaultsBody(FIELDS, DEFAULTS, new Map(), new Set());
  assert.deepEqual(plan, { body: null, changed: [], resets: [], errors: {} });
});

test("only the changed fields are sent, and a budget is sent with its changed fields only", () => {
  const drafts = new Map([
    ["team", "Lisbon 1"],
    ["max_mcq", "3"], // touched, but the same as saved
    ["standard.max_turns", "30"],
    ["standard.max_spend_usd", "1.5"],
    ["disabled_tools", ["web_search"]],
    ["no_human", true],
  ]);
  const plan = buildDefaultsBody(FIELDS, DEFAULTS, drafts, new Set());
  assert.deepEqual(plan.body, {
    team: "Lisbon 1",
    no_human: true,
    standard: { max_turns: 30, max_spend_usd: 1.5 },
    disabled_tools: ["web_search"],
  });
  assert.deepEqual(plan.changed, ["team", "no_human", "standard.max_turns", "standard.max_spend_usd", "disabled_tools"]);
  assert.deepEqual(plan.errors, {});
});

test("drafts may be a plain object as well as a Map", () => {
  const plan = buildDefaultsBody(FIELDS, DEFAULTS, { penalty_scope: "subsequent" }, []);
  assert.deepEqual(plan.body, { penalty_scope: "subsequent" });
});

test("a field that cannot be read is reported and not sent", () => {
  const plan = buildDefaultsBody(FIELDS, DEFAULTS, new Map([["max_mcq", "many"], ["team", "B"]]), new Set());
  assert.deepEqual(plan.errors, { max_mcq: "Must be a number." });
  assert.deepEqual(plan.body, { team: "B" });
  assert.deepEqual(plan.changed, ["team"]);
});

test("a reset sends null for the whole top-level key and wins over drafts inside it", () => {
  const drafts = new Map([["standard.max_turns", "30"], ["team", "B"]]);
  const plan = buildDefaultsBody(FIELDS, DEFAULTS, drafts, new Set(["standard", "allow_web"]));
  assert.deepEqual(plan.body, { team: "B", standard: null, allow_web: null });
  assert.deepEqual(plan.resets, ["standard", "allow_web"]);
  assert.deepEqual(plan.changed, ["team"]);
});

test("a soft deadline later than its hard deadline is an error on the soft field", () => {
  let plan = buildDefaultsBody(FIELDS, DEFAULTS, new Map([["standard.soft_deadline_s", "600"]]), new Set());
  assert.deepEqual(plan.errors, { "standard.soft_deadline_s": "Must not be later than the hard deadline (540 s)." });
  // lowering the hard deadline under an untouched soft one is the same fault
  plan = buildDefaultsBody(FIELDS, DEFAULTS, new Map([["special.hard_deadline_s", "800"]]), new Set());
  assert.deepEqual(Object.keys(plan.errors), ["special.soft_deadline_s"]);
  // both moved together is fine
  plan = buildDefaultsBody(FIELDS, DEFAULTS, new Map([["standard.soft_deadline_s", "600"], ["standard.hard_deadline_s", "700"]]), new Set());
  assert.deepEqual(plan.errors, {});
  assert.deepEqual(plan.body, { standard: { soft_deadline_s: 600, hard_deadline_s: 700 } });
  // a budget that is being reset is not checked
  plan = buildDefaultsBody(FIELDS, DEFAULTS, new Map([["standard.soft_deadline_s", "600"]]), new Set(["standard"]));
  assert.deepEqual(plan.errors, {});
});

test("crossErrors ignores a budget with a missing or unreadable deadline", () => {
  assert.deepEqual(crossErrors(FIELDS, () => undefined), {});
  assert.deepEqual(crossErrors(FIELDS, (key) => (key === "standard.soft_deadline_s" ? 10 : null)), {});
});

test("canReset and resetScope: a saved override can be forgotten, a budget only as a whole", () => {
  assert.equal(canReset(field("team"), ["team"]), true);
  assert.equal(canReset(field("team"), ["model"]), false);
  assert.equal(canReset(field("standard.max_turns"), ["standard"]), true);
  assert.equal(canReset(field("team"), undefined), false);
  assert.deepEqual(resetScope(field("team"), FIELDS).map((item) => item.key), ["team"]);
  assert.deepEqual(resetScope(field("standard.max_turns"), FIELDS).map((item) => item.key),
    ["standard.effort", "standard.soft_deadline_s", "standard.hard_deadline_s", "standard.max_turns", "standard.max_spend_usd"]);
});

// ---------------------------------------------------------------- server problems

test("problemsByField sends each problem to the longest key it starts with", () => {
  const keys = FIELDS.map((item) => item.key);
  const out = problemsByField([
    "max_mcq must be a whole number from 0 to 3",
    "standard.soft_deadline_s must not be later than standard.hard_deadline_s",
    "disabled_tools: unknown tool 'x'",
    "standard must be an object with effort, soft_deadline_s",
    "teamwork is not a setting a run can be launched with",
  ], keys);
  assert.deepEqual(out.byKey, {
    max_mcq: ["Must be a whole number from 0 to 3"],
    "standard.soft_deadline_s": ["Must not be later than standard.hard_deadline_s"],
    disabled_tools: ["Unknown tool 'x'"],
  });
  assert.deepEqual(out.rest, [
    "standard must be an object with effort, soft_deadline_s",
    "teamwork is not a setting a run can be launched with",
  ]);
});

test("problemsByField works for organiser ids and for folder paths", () => {
  const ids = ["Q1", "Q10", "Q12"];
  const answers = problemsByField(["Q10 has no setting to change; record the answer in its note", "Q1: the note must be text"], ids);
  assert.deepEqual(Object.keys(answers.byKey).sort(), ["Q1", "Q10"]);
  const roots = problemsByField(["/Users/a/b: no such directory", "paths.runs_dir must be an absolute directory path"],
    ["paths.runs_dir", "/Users/a", "/Users/a/b"]);
  assert.deepEqual(roots.byKey, {
    "/Users/a/b": ["No such directory"],
    "paths.runs_dir": ["Must be an absolute directory path"],
  });
  assert.deepEqual(problemsByField(null, ids), { byKey: {}, rest: [] });
  assert.deepEqual(problemsByField([{ message: "Q12: too long" }], ids).byKey, { Q12: ["Too long"] });
});

// ---------------------------------------------------------------- keys

test("the three keys the console manages", () => {
  assert.deepEqual(KEY_NAMES, ["OPENAI_API_KEY", "GOOGLE_MAPS_API_KEY", "MAPILLARY_TOKEN"]);
});

test("keyStatus shows the last four characters only where the server sends them", () => {
  assert.deepEqual(keyStatus("OPENAI_API_KEY", { set: true, last4: "ab12" }), { kind: "ok", text: "set, ends in ab12", icon: "check" });
  assert.deepEqual(keyStatus("GOOGLE_MAPS_API_KEY", { set: true }), { kind: "ok", text: "set", icon: "check" });
  assert.equal(keyStatus("OPENAI_API_KEY", { set: false, last4: null }).kind, "bad");
  assert.equal(keyStatus("MAPILLARY_TOKEN", { set: false }).text, "not set (optional)");
  assert.equal(keyStatus("OPENAI_API_KEY", undefined).text, "not set");
});

test("checkKeyValue mirrors the server's rule and never repeats the value", () => {
  assert.equal(checkKeyValue("sk-proj-abcdefgh12345678"), null);
  assert.match(checkKeyValue(""), /Paste the key/);
  assert.match(checkKeyValue("sk abc defgh"), /no spaces/);
  assert.match(checkKeyValue("OPENAI_API_KEY=sk-abcdefgh"), /without its NAME= prefix/);
  assert.match(checkKeyValue("\"sk-abcdefgh\""), /without quotes/);
  assert.match(checkKeyValue("sk-abc$defgh"), /without quotes/);
  assert.match(checkKeyValue("sk-àbcdefgh"), /plain printable/);
  assert.match(checkKeyValue("sk-12"), /too short/);
  assert.match(checkKeyValue("x".repeat(513)), /too long/);
  for (const bad of ["sk abc defgh", "sk-abc$defgh", "sk-12"]) assert.equal(checkKeyValue(bad).includes(bad), false);
});

test("keyTestLines reports the outcome, model access, summaries and latency", () => {
  const good = keyTestLines({ ok: true, detail: "Key accepted; gpt-a answered.", model_access: true, reasoning_summaries: false, latency_ms: 1840 });
  assert.deepEqual(good.map((line) => line.kind), ["ok", "ok", "warn", "dim"]);
  assert.match(good[0].text, /^Working\. Key accepted/);
  assert.match(good[2].text, /not granted/);
  assert.equal(good[3].text, "Answered in 1.8 s.");
  const bad = keyTestLines({ ok: false, detail: "The key was rejected (HTTP 401).", latency_ms: null });
  assert.deepEqual(bad.map((line) => line.kind), ["bad"]);
  assert.match(bad[0].text, /^Not working\./);
  assert.deepEqual(keyTestLines(null), []);
});

// ---------------------------------------------------------------- organiser answers

const ANSWERS = [
  { id: "Q1", question: "May the agent use the internet?", default: "Assume yes", control: "New run, Tools", setting: "allow_web", value: true, note: "", noted_at: null },
  { id: "Q2", question: "Penalty scope?", default: "Whole list", control: "New run, Answer", setting: "penalty_scope", value: "whole_list", note: "Asked Ana, 10:02", noted_at: "2026-10-10T10:02:00Z" },
  { id: "Q5", question: "UTC or local?", default: "Unknown", control: "None", setting: null, value: null, note: "", noted_at: null },
  { id: "Q10", question: "When does the clock start?", default: "At launch", control: "Run header", setting: "clock_start", value: "launch", note: "", noted_at: null },
];

test("answerControl takes the kind of control from the default the answer changes", () => {
  assert.equal(answerControl(ANSWERS[0], FIELDS).kind, "bool");
  assert.equal(answerControl(ANSWERS[0], FIELDS).field.key, "allow_web");
  assert.deepEqual(answerControl(ANSWERS[1], FIELDS).choices, ["whole_list", "subsequent"]);
  assert.equal(answerControl(ANSWERS[2], FIELDS).kind, "none");
  assert.equal(answerControl(ANSWERS[3], FIELDS).kind, "fixed");
  assert.equal(answerControl({ id: "Q1", setting: "allow_web" }, []).kind, "fixed"); // no field: nothing to edit it with
});

test("answerEffect says which behaviour an answer changes", () => {
  assert.equal(answerEffect(ANSWERS[0], FIELDS), "Changes the default \"Web tools on (Q1)\" for new runs.");
  assert.match(answerEffect(ANSWERS[2], FIELDS), /Changes no setting/);
  assert.match(answerEffect(ANSWERS[3], FIELDS), /clock starts at launch/);
  assert.equal(answerValueWords(ANSWERS[0], FIELDS), "On");
  assert.equal(answerValueWords(ANSWERS[1], FIELDS), "whole_list");
  assert.equal(answerValueWords(ANSWERS[2], FIELDS), "");
  assert.equal(answerValueWords(ANSWERS[3], FIELDS), "At launch");
});

test("buildAnswersBody sends only the rows and the parts that changed", () => {
  const drafts = new Map([
    ["Q1", { value: false }],
    ["Q2", { value: "whole_list", note: "Asked Ana, 10:02  " }], // both as saved
    ["Q5", { note: " Local time, said Rui at 11:40 " }],
  ]);
  const plan = buildAnswersBody(ANSWERS, drafts);
  assert.deepEqual(plan.items, [{ id: "Q1", value: false }, { id: "Q5", note: "Local time, said Rui at 11:40" }]);
  assert.deepEqual(plan.changed, ["Q1", "Q5"]);
  assert.deepEqual(plan.errors, {});
  assert.deepEqual(buildAnswersBody(ANSWERS, new Map()).items, []);
});

test("a note can be cleared, and one over the limit is refused before it is sent", () => {
  assert.deepEqual(buildAnswersBody(ANSWERS, { Q2: { note: "" } }).items, [{ id: "Q2", note: "" }]);
  const long = buildAnswersBody(ANSWERS, { Q5: { note: "x".repeat(NOTE_MAX + 1) } });
  assert.deepEqual(long.items, []);
  assert.match(long.errors.Q5, /the limit is 2,000/);
});

// ---------------------------------------------------------------- directories

const PATHS = {
  runs_dir: "/srv/geo/runs",
  cache_dir: "/srv/geo/.cache",
  data_dir: "/srv/geo/data",
  allowed_roots: ["/srv/geo/data/sets", "/Users/op/Downloads", "/Volumes"],
  saved: { runs_dir: null, cache_dir: "/srv/geo/.cache" },
  env_file: "/srv/geo/.env",
};

test("the uploaded-sets folder is the server's own entry and is never sent back", () => {
  assert.equal(isSetsRoot("/srv/geo/data/sets", "/srv/geo/data"), true);
  assert.equal(isSetsRoot("/srv/geo/data/sets/", "/srv/geo/data/"), true);
  assert.equal(isSetsRoot("/srv/geo/data/sets2", "/srv/geo/data"), false);
  assert.equal(isSetsRoot("/x", null), false);
  assert.deepEqual(editableRoots(PATHS.allowed_roots, PATHS.data_dir), ["/Users/op/Downloads", "/Volumes"]);
  assert.deepEqual(editableRoots(undefined, PATHS.data_dir), []);
});

test("addRoot refuses an empty entry and a repeat", () => {
  assert.deepEqual(addRoot(["/Volumes"], " /Volumes/USB/ "), { list: ["/Volumes", "/Volumes/USB"], error: null });
  assert.match(addRoot(["/Volumes"], "  ").error, /Type a directory/);
  assert.match(addRoot(["/Volumes"], "/Volumes/").error, /already in the list/);
  assert.deepEqual(addRoot([], "/").list, ["/"]); // the server decides what is allowed
});

test("buildPathsBody sends a changed directory, null for an emptied one, and the roots without the sets folder", () => {
  assert.deepEqual(buildPathsBody(PATHS, {}), { body: null, changed: [] });
  assert.deepEqual(buildPathsBody(PATHS, { runs_dir: "", cache_dir: " /srv/geo/.cache " }), { body: null, changed: [] });
  assert.deepEqual(buildPathsBody(PATHS, { runs_dir: " /Volumes/fast/runs ", cache_dir: "" }),
    { body: { runs_dir: "/Volumes/fast/runs", cache_dir: null }, changed: ["runs_dir", "cache_dir"] });
  assert.deepEqual(buildPathsBody(PATHS, { roots: ["/Users/op/Downloads", "/Volumes"] }), { body: null, changed: [] });
  assert.deepEqual(buildPathsBody(PATHS, { roots: ["/Volumes"] }), { body: { allowed_roots: ["/Volumes"] }, changed: ["allowed_roots"] });
  assert.deepEqual(buildPathsBody(PATHS, { roots: null }), { body: { allowed_roots: null }, changed: ["allowed_roots"] });
  assert.deepEqual(buildPathsBody(PATHS, { roots: [] }), { body: { allowed_roots: [] }, changed: ["allowed_roots"] });
});

test("restartWords names what a restart would change", () => {
  assert.equal(restartWords([]), "");
  assert.equal(restartWords(["lan"]), "LAN access");
  assert.equal(restartWords(["runs_dir", "lan"]), "the runs directory and LAN access");
  assert.equal(restartWords(["runs_dir", "cache_dir", "lan"]), "the runs directory, the cache directory and LAN access");
  assert.equal(restartWords(undefined), "");
});

// ---------------------------------------------------------------- LAN access

test("lanState tells in force from saved-for-the-next-start", () => {
  assert.equal(lanState({ lan: { enabled: false }, restart_required: [] }).state, "off");
  assert.equal(lanState({ lan: { enabled: true }, restart_required: ["lan"] }).state, "pending_on");
  assert.equal(lanState({ lan: { enabled: true }, restart_required: ["runs_dir"] }).state, "on");
  assert.equal(lanState({ lan: { enabled: false }, restart_required: ["lan"] }).state, "pending_off");
  assert.equal(lanState(null).state, "off");
  for (const payload of [{ lan: { enabled: true }, restart_required: [] }, { lan: { enabled: false }, restart_required: ["lan"] }]) {
    const words = lanState(payload);
    assert.ok(words.text && words.icon && words.detail && words.kind === "warn");
  }
});

test("maskJoinUrl hides the token and nothing else", () => {
  assert.equal(maskJoinUrl("http://192.168.1.20:8000/?token=abcDEF-123_x"), "http://192.168.1.20:8000/?token=••••••••");
  assert.equal(maskJoinUrl("http://h/?a=1&token=secret&b=2"), "http://h/?a=1&token=••••••••&b=2");
  assert.equal(maskJoinUrl("http://h/"), "http://h/");
  assert.equal(maskJoinUrl(null), "");
});

// ---------------------------------------------------------------- health

test("latencyWords", () => {
  assert.equal(latencyWords(84), "84 ms");
  assert.equal(latencyWords(999.6), "1000 ms");
  assert.equal(latencyWords(1840), "1.8 s");
  assert.equal(latencyWords(null), "–");
  assert.equal(latencyWords(undefined), "–");
});

test("serviceStatus tells reachable, slow, a refusing answer and silence apart", () => {
  assert.deepEqual(serviceStatus({ ok: true, latency_ms: 120 }), { kind: "ok", icon: "check", text: "reachable" });
  assert.equal(serviceStatus({ ok: true, latency_ms: 4200 }).text, "reachable, slow");
  assert.equal(serviceStatus({ ok: false, latency_ms: 300 }).text, "answered with a problem");
  assert.equal(serviceStatus({ ok: false, latency_ms: null }).text, "no answer");
  assert.equal(serviceStatus(null).kind, "bad");
  for (const row of [{ ok: true, latency_ms: 1 }, { ok: false, latency_ms: 1 }, { ok: false, latency_ms: null }]) {
    const status = serviceStatus(row);
    assert.ok(status.text && status.icon, "status is never colour alone");
  }
});

test("healthSummary counts and names the services with a problem", () => {
  const rows = [{ name: "OpenAI", ok: true }, { name: "Photon", ok: false }, { name: "Overpass 2", ok: false }];
  assert.equal(healthSummary(rows).text, "2 of 3 with a problem: Photon, Overpass 2.");
  assert.equal(healthSummary(rows).kind, "bad");
  assert.equal(healthSummary([{ name: "OpenAI", ok: true }]).text, "All 1 services reachable.");
  assert.equal(healthSummary([]).kind, "dim");
});

test("windowStats marks retries, errors and timeouts, and says when there was no turn", () => {
  const busy = windowStats({ minutes: 15, api_retries: 2, api_errors: 1, timeouts: 0, median_turn_latency_ms: 8400, mean_upload_chars: 1572864 });
  assert.deepEqual(busy.map((row) => [row.key, row.value, row.kind]), [
    ["api_retries", "2", "warn"],
    ["api_errors", "1", "bad"],
    ["timeouts", "0", "plain"],
    ["median_turn_latency_ms", "8.4 s", "plain"],
    ["mean_upload_chars", "1.5 MB", "plain"],
  ]);
  const quiet = windowStats({ minutes: 15, api_retries: 0, api_errors: 0, timeouts: 0, median_turn_latency_ms: null, mean_upload_chars: null });
  assert.deepEqual(quiet.map((row) => row.value), ["0", "0", "0", "–", "–"]);
  assert.match(quiet[3].help, /No model turn/);
  assert.deepEqual(windowStats(null).map((row) => row.value), ["–", "–", "–", "–", "–"]);
});

test("diskRows warns when the runs disk is nearly full", () => {
  const GB = 1024 ** 3;
  const roomy = diskRows({ runs_bytes: 3 * GB, uploads_bytes: 0, cache_bytes: 12 * 1024 ** 2, free_bytes: 200 * GB });
  assert.deepEqual(roomy.map((row) => [row.key, row.value, row.kind]), [
    ["runs_bytes", "3.0 GB", "plain"],
    ["uploads_bytes", "0 B", "plain"],
    ["cache_bytes", "12.0 MB", "plain"],
    ["free_bytes", "200 GB", "plain"],
  ]);
  assert.equal(diskRows({ free_bytes: GB })[3].kind, "warn");
  assert.equal(diskRows({ free_bytes: 100 * 1024 ** 2 })[3].kind, "bad");
  assert.equal(diskRows({ free_bytes: null })[3].value, "–");
  assert.equal(diskRows(undefined).length, 4);
});

// ---------------------------------------------------------------- this browser

test("notificationState: the switch is only on with both the preference and the permission", () => {
  assert.deepEqual([notificationState("granted", true).on, notificationState("granted", true).canToggle], [true, true]);
  assert.equal(notificationState("granted", false).on, false);
  assert.equal(notificationState("default", true).on, false);
  assert.match(notificationState("default", false).text, /ask for permission/);
  assert.deepEqual([notificationState("denied", true).on, notificationState("denied", true).canToggle], [false, false]);
  assert.match(notificationState("denied", true).text, /site settings/);
  assert.equal(notificationState("unsupported", true).canToggle, false);
});
