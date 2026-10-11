import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILD_FIELDS,
  FILTERS,
  IMAGE_WIDTHS,
  TABS,
  breakdown,
  buildBlockedReason,
  buildQueue,
  canReuseKey,
  countStates,
  filterCounts,
  fmtStamp,
  hasPoint,
  imageSources,
  imageUrl,
  indexById,
  jobView,
  labelBadge,
  labelState,
  matchesFilter,
  nextSort,
  nextToDo,
  normaliseFilter,
  progressText,
  queueProgress,
  readBuildForm,
  replaceEntry,
  replaceLossLines,
  sortEntries,
  stateBadge,
  step,
  tabOf,
} from "../../server/static/console/js/logic/evalset.js";

// One entry of GET /api/eval/set, as server/evalops.py `_public` writes it.
function entry(id, label, confirmed, extra = {}) {
  return {
    panorama_id: id, filename: id + ".jpg", label, label_confirmed: confirmed,
    lat: 38.7, lng: -9.1, area: "Lisboa Baixa", country: "PT", kind: "city", timestamp: "20180511142427", ...extra,
  };
}

const SET = [
  entry("a", "Urban", true, { area: "Porto", kind: "city", lat: 41.1 }),
  entry("b", "TODO", false, { area: "aldeia", kind: "village", country: "PT", lat: 40.2 }),
  entry("c", "non-Urban", false, { area: "Camargue", kind: "rural", country: "FR", lat: 43.5 }),
  entry("d", "Urban", false, { area: "Sevilla", kind: "city", country: "ES", lat: 37.4 }),
  entry("e", "non-Urban", true, { area: "Beira track", kind: "track", country: "PT", lat: 40.6 }),
];

// ---------------------------------------------------------------- tabs

test("the tabs are the ?tab= values of contract A1, in order", () => {
  assert.deepEqual(TABS.map((tab) => tab.name), ["set", "label", "run", "results", "compare"]);
});

test("tabOf falls back to the Set tab for a missing or mistyped value", () => {
  assert.equal(tabOf("label"), "label");
  assert.equal(tabOf("compare"), "compare");
  assert.equal(tabOf(null), "set");
  assert.equal(tabOf(""), "set");
  assert.equal(tabOf("Label"), "set");
  assert.equal(tabOf("../x"), "set");
});

// ---------------------------------------------------------------- label state

test("labelState: the three states are disjoint, as the server counts them", () => {
  assert.equal(labelState(entry("x", "Urban", true)), "confirmed");
  assert.equal(labelState(entry("x", "non-Urban", false)), "unconfirmed");
  assert.equal(labelState(entry("x", "TODO", false)), "todo");
  // A label that is not one of the two cannot be "confirmed", whatever the flag says.
  assert.equal(labelState(entry("x", "TODO", true)), "todo");
  assert.equal(labelState(entry("x", "urban", true)), "todo");
  assert.equal(labelState(null), "todo");
});

test("countStates adds up to the size of the set", () => {
  assert.deepEqual(countStates(SET), { count: 5, confirmed: 2, unconfirmed: 2, todo: 1 });
  assert.deepEqual(countStates([]), { count: 0, confirmed: 0, unconfirmed: 0, todo: 0 });
  assert.deepEqual(countStates(null), { count: 0, confirmed: 0, unconfirmed: 0, todo: 0 });
});

test("badges say the state in words and never rely on colour alone", () => {
  assert.deepEqual(labelBadge("Urban"), { text: "Urban", kind: "urban", icon: null });
  assert.deepEqual(labelBadge("non-Urban"), { text: "non-Urban", kind: "nonurban", icon: null });
  assert.equal(labelBadge("TODO").icon, "alert");
  assert.equal(labelBadge("anything else").text, "TODO");
  for (const state of ["confirmed", "unconfirmed", "todo"]) {
    const spec = stateBadge(state);
    assert.ok(spec.text.length > 0 && spec.icon, state);
    assert.notEqual(spec.kind, "penalty");
  }
});

// ---------------------------------------------------------------- filters and queue

test("filters: TODO is a subset of not confirmed, which is a subset of all", () => {
  assert.deepEqual(FILTERS.map((filter) => filter.name), ["todo", "unconfirmed", "all"]);
  assert.deepEqual(filterCounts(SET), { todo: 1, unconfirmed: 3, all: 5 });
  assert.equal(matchesFilter(SET[1], "todo"), true);
  assert.equal(matchesFilter(SET[2], "todo"), false);
  assert.equal(matchesFilter(SET[1], "unconfirmed"), true);
  assert.equal(matchesFilter(SET[0], "unconfirmed"), false);
  assert.equal(matchesFilter(SET[0], "all"), true);
});

test("normaliseFilter keeps a known filter and defaults to the review pass", () => {
  assert.equal(normaliseFilter("todo"), "todo");
  assert.equal(normaliseFilter("all"), "all");
  assert.equal(normaliseFilter(undefined), "unconfirmed");
  assert.equal(normaliseFilter("everything"), "unconfirmed");
});

test("buildQueue keeps manifest order and always includes the panorama the URL names", () => {
  assert.deepEqual(buildQueue(SET, "all"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(buildQueue(SET, "unconfirmed"), ["b", "c", "d"]);
  assert.deepEqual(buildQueue(SET, "todo"), ["b"]);
  assert.deepEqual(buildQueue(SET, "todo", "e"), ["b", "e"]);
  assert.deepEqual(buildQueue(SET, "unconfirmed", "a"), ["a", "b", "c", "d"]);
  assert.deepEqual(buildQueue(SET, "todo", "nope"), ["b"]);
  assert.deepEqual(buildQueue(null, "all"), []);
});

test("step moves by one and stops at the ends", () => {
  const queue = ["b", "c", "d"];
  assert.equal(step(queue, "b", 1), "c");
  assert.equal(step(queue, "d", -1), "c");
  assert.equal(step(queue, "d", 1), null);
  assert.equal(step(queue, "b", -1), null);
  assert.equal(step(queue, "zz", 1), "b");
  assert.equal(step([], "b", 1), null);
});

test("nextToDo searches forward, comes round to skipped ones and ends when all are confirmed", () => {
  const queue = ["b", "c", "d"];
  let entries = SET;
  assert.equal(nextToDo(queue, indexById(entries), "b"), "c");
  assert.equal(nextToDo(queue, indexById(entries), "d"), "b", "wraps to the one skipped earlier");
  assert.equal(nextToDo(queue, indexById(entries), null), "b", "no current panorama: the first one to do");

  entries = replaceEntry(entries, entry("c", "non-Urban", true));
  assert.equal(nextToDo(queue, indexById(entries), "b"), "d", "a confirmed one is passed over");

  entries = replaceEntry(entries, entry("d", "Urban", true));
  assert.equal(nextToDo(queue, indexById(entries), "b"), null, "only the current one is left");
  entries = replaceEntry(entries, entry("b", "Urban", true));
  assert.equal(nextToDo(queue, indexById(entries), "b"), null);
  assert.equal(nextToDo(queue, indexById(entries), null), null);
  assert.equal(nextToDo([], new Map(), "b"), null);
});

test("a labelled panorama stays in the queue so the operator can step back to it", () => {
  const queue = buildQueue(SET, "unconfirmed");
  const entries = replaceEntry(SET, { panorama_id: "b", label: "Urban", label_confirmed: true });
  assert.deepEqual(queue, ["b", "c", "d"]);
  assert.equal(step(queue, "c", -1), "b");
  assert.equal(labelState(indexById(entries).get("b")), "confirmed");
  // the fields the PATCH answer does not repeat are kept
  assert.equal(indexById(entries).get("b").area, "aldeia");
  assert.notEqual(entries, SET);
  assert.equal(SET[1].label, "TODO", "the old list is not changed in place");
});

test("progress reads '12 of 50, 3 to do'", () => {
  const queue = Array.from({ length: 50 }, (_, i) => "p" + i);
  const entries = queue.map((id, i) => entry(id, "Urban", i >= 3));
  const progress = queueProgress(queue, indexById(entries), "p11");
  assert.deepEqual(progress, { position: 12, total: 50, toDo: 3 });
  assert.equal(progressText(progress), "12 of 50, 3 to do");
  assert.equal(progressText({ position: 50, total: 50, toDo: 0 }), "50 of 50, all confirmed");
  assert.equal(progressText({ position: 0, total: 4, toDo: 1 }), "4 in this list, 1 to do");
  assert.equal(progressText({ position: 0, total: 0, toDo: 0 }), "nothing to label");
});

test("an id missing from the set counts as still to do, not as confirmed", () => {
  assert.deepEqual(queueProgress(["a", "ghost"], indexById(SET), "a"), { position: 1, total: 2, toDo: 1 });
});

// ---------------------------------------------------------------- entries table

test("sortEntries: manifest order without a key, stable within equal values", () => {
  assert.deepEqual(sortEntries(SET, { key: null, dir: "asc" }).map((e) => e.panorama_id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(sortEntries(SET, { key: "country", dir: "asc" }).map((e) => e.panorama_id), ["d", "c", "a", "b", "e"]);
  assert.deepEqual(sortEntries(SET, { key: "country", dir: "desc" }).map((e) => e.panorama_id), ["a", "b", "e", "c", "d"]);
  assert.deepEqual(sortEntries(SET, { key: "lat", dir: "asc" }).map((e) => e.panorama_id), ["d", "b", "e", "a", "c"]);
  assert.deepEqual(sortEntries(SET, { key: "bogus", dir: "asc" }).map((e) => e.panorama_id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(SET.map((e) => e.panorama_id), ["a", "b", "c", "d", "e"], "the input is not reordered");
});

test("sorting by state puts what needs a human first; area ignores case", () => {
  assert.deepEqual(sortEntries(SET, { key: "state", dir: "asc" }).map((e) => e.panorama_id), ["b", "c", "d", "a", "e"]);
  assert.deepEqual(sortEntries(SET, { key: "area", dir: "asc" }).map((e) => e.area),
    ["aldeia", "Beira track", "Camargue", "Porto", "Sevilla"]);
});

test("an entry without coordinates sorts first and is kept off the map", () => {
  const list = [...SET, entry("f", "Urban", true, { lat: null, lng: null })];
  assert.equal(sortEntries(list, { key: "lat", dir: "asc" })[0].panorama_id, "f");
  assert.equal(hasPoint(list[5]), false);
  assert.equal(hasPoint(SET[0]), true);
  assert.equal(hasPoint({ lat: 0, lng: 0 }), true);
  assert.equal(hasPoint({ lat: "x", lng: 1 }), false);
  assert.equal(hasPoint({ lng: 1 }), false);
  assert.equal(hasPoint(null), false);
});

test("nextSort cycles ascending, descending, manifest order", () => {
  let sort = { key: null, dir: "asc" };
  sort = nextSort(sort, "area");
  assert.deepEqual(sort, { key: "area", dir: "asc" });
  sort = nextSort(sort, "area");
  assert.deepEqual(sort, { key: "area", dir: "desc" });
  sort = nextSort(sort, "area");
  assert.deepEqual(sort, { key: null, dir: "asc" });
  assert.deepEqual(nextSort({ key: "area", dir: "desc" }, "kind"), { key: "kind", dir: "asc" });
});

test("breakdown: largest first, shares add up, an empty name is spelled out", () => {
  const rows = breakdown({ PT: 3, FR: 1, ES: 1, "": 1 });
  assert.deepEqual(rows.map((row) => row.name), ["PT", "(not recorded)", "ES", "FR"]);
  assert.equal(rows[0].n, 3);
  assert.equal(rows[0].share, 0.5);
  assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
  assert.deepEqual(breakdown({}), []);
  assert.deepEqual(breakdown(null), []);
});

test("fmtStamp prints the capture stamp and leaves anything else alone", () => {
  assert.equal(fmtStamp("20180511142427"), "2018-05-11 14:24");
  assert.equal(fmtStamp("2018-05-11"), "2018-05-11");
  assert.equal(fmtStamp(null), "–");
  assert.equal(fmtStamp(""), "–");
});

// ---------------------------------------------------------------- images

test("image URLs are same-origin API paths with the id escaped", () => {
  assert.equal(imageUrl("eval_835e1610efde", 1024), "/api/eval/set/eval_835e1610efde/image?w=1024");
  assert.equal(imageUrl("a/b?c", 320), "/api/eval/set/a%2Fb%3Fc/image?w=320");
  const sources = imageSources("p1");
  assert.deepEqual(sources.map((source) => source.width), IMAGE_WIDTHS);
  assert.ok(sources.every((source) => source.url.startsWith("/api/eval/set/p1/image?w=")));
  assert.ok(sources.every((source, i) => i === 0 || source.width > sources[i - 1].width), "smallest first");
});

// ---------------------------------------------------------------- build form

const FORM = { count: "40", seed: "0", per_area_limit: "100", replace: false };
const READY = { exists: false, count: 0, confirmed: 0, mapillary_token: true };

test("readBuildForm turns the fields into the body of POST /api/eval/set/build", () => {
  assert.deepEqual(readBuildForm(FORM), { body: { count: 40, seed: 0, per_area_limit: 100, replace: false }, errors: {} });
  assert.deepEqual(readBuildForm({ count: " 50 ", seed: "-7", per_area_limit: "2000", replace: true }).body,
    { count: 50, seed: -7, per_area_limit: 2000, replace: true });
});

test("readBuildForm refuses what the server would refuse", () => {
  for (const bad of ["", "0", "51", "4.5", "1e1", "forty", "0x10"]) {
    assert.ok(readBuildForm({ ...FORM, count: bad }).errors.count, "count " + JSON.stringify(bad));
  }
  assert.ok(readBuildForm({ ...FORM, per_area_limit: "2001" }).errors.per_area_limit);
  assert.ok(readBuildForm({ ...FORM, seed: "" }).errors.seed);
  assert.ok(readBuildForm({ ...FORM, seed: String(2 ** 31) }).errors.seed);
  assert.deepEqual(readBuildForm({ ...FORM, seed: String(2 ** 31 - 1) }).errors, {});
  assert.match(readBuildForm({ ...FORM, count: "99" }).errors.count, /1 to 50/);
  assert.deepEqual(Object.keys(BUILD_FIELDS), ["count", "seed", "per_area_limit"]);
});

test("buildBlockedReason: every reason a build cannot start, most basic first", () => {
  assert.match(buildBlockedReason({ set: null, form: FORM, jobActive: false }), /not known/);
  assert.match(buildBlockedReason({ set: READY, form: FORM, jobActive: true }), /build is running/);
  assert.match(buildBlockedReason({ set: { ...READY, mapillary_token: false }, form: FORM, jobActive: false }), /MAPILLARY_TOKEN/);
  assert.match(buildBlockedReason({ set: READY, form: { ...FORM, count: "0" }, jobActive: false }), /Correct the fields/);
  assert.match(buildBlockedReason({ set: { ...READY, exists: true }, form: FORM, jobActive: false }), /Replace the existing set/);
  assert.equal(buildBlockedReason({ set: { ...READY, exists: true }, form: { ...FORM, replace: true }, jobActive: false }), null);
  assert.equal(buildBlockedReason({ set: READY, form: FORM, jobActive: false }), null);
});

test("replaceLossLines says what is lost before a set is replaced", () => {
  const lines = replaceLossLines({ exists: true, count: 40, confirmed: 12 });
  assert.match(lines[0], /40 panoramas/);
  assert.match(lines[1], /12 labels confirmed by hand are lost/);
  assert.match(lines[2], /earlier evaluation runs/);
  assert.match(replaceLossLines({ exists: true, count: 1, confirmed: 1 })[1], /1 label confirmed by hand is lost/);
  assert.match(replaceLossLines({ exists: true, count: 5, confirmed: 0 })[1], /no hand work is lost/);
  assert.match(replaceLossLines({ exists: true, count: 0, confirmed: 0 })[0], /manifest is replaced/);
  for (const line of lines) assert.ok(!line.includes("—"), "no em dash in UI text");
});

test("canReuseKey: the same build is retried under its key only when the server never answered", () => {
  const body = JSON.stringify(readBuildForm(FORM).body);
  assert.equal(canReuseKey(null, body), false);
  assert.equal(canReuseKey({ bodyJson: body, key: "k", status: 0 }, body), true, "timeout or no connection");
  assert.equal(canReuseKey({ bodyJson: body, key: "k", status: 503 }, body), true, "5xx is never cached");
  // A 4xx is cached with the key for an hour: retrying under it would replay the refusal.
  assert.equal(canReuseKey({ bodyJson: body, key: "k", status: 409 }, body), false);
  assert.equal(canReuseKey({ bodyJson: body, key: "k", status: 422 }, body), false);
  // A changed form is another request: the same key with another body is refused (A17).
  assert.equal(canReuseKey({ bodyJson: body, key: "k", status: 0 }, body.replace("40", "41")), false);
});

// ---------------------------------------------------------------- build job

function job(state, progress = {}, extra = {}) {
  return { id: "j1", kind: "eval_build", title: "Build the evaluation set", state, progress: { done: 0, total: null, text: "", ...progress }, log: [], result: null, error: null, ...extra };
}

test("jobView: progress as a fraction when the total is known", () => {
  assert.equal(jobView(null), null);
  const queued = jobView(job("queued"));
  assert.deepEqual([queued.active, queued.failed, queued.fraction, queued.counts], [true, false, null, ""]);
  const running = jobView(job("running", { done: 12, total: 48, text: "searched Lisboa Baixa" }));
  assert.deepEqual([running.active, running.fraction, running.counts, running.text], [true, 0.25, "12 of 48", "searched Lisboa Baixa"]);
  assert.equal(jobView(job("running", { done: 60, total: 40 })).fraction, 1, "never past the end");
  assert.equal(jobView(job("running", { done: 3, total: 0 })).fraction, null);
});

test("jobView: a finished job is full, a failed one keeps where it stopped", () => {
  const done = jobView(job("done", { done: 38, total: 40, text: "done" }));
  assert.deepEqual([done.active, done.failed, done.fraction], [false, false, 1]);
  const failed = jobView(job("failed", { done: 5, total: 40 }, { error: "RuntimeError: no panorama could be downloaded" }));
  assert.deepEqual([failed.active, failed.failed, failed.fraction, failed.counts], [false, true, 0.125, "5 of 40"]);
  assert.equal(jobView({ id: "j", state: "running" }).text, "");
});
