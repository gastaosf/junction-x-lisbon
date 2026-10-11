import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_VIEW,
  KINDS,
  STATES,
  deleteBlock,
  describeKind,
  downloadBlock,
  exportOutcome,
  exportingRuns,
  filterCounts,
  filterRows,
  groupRows,
  isFiltered,
  liveRow,
  mergeRows,
  modeInfo,
  parseView,
  penaltyParts,
  penaltyText,
  rebuildBlock,
  rowActions,
  rowNote,
  rowSeconds,
  sortRows,
  stateInfo,
  summaryText,
  toggleSort,
  truthVisible,
  viewQuery,
} from "../../server/static/console/js/logic/runs.js";

const NOW = 5_000_000;

// A finished training run found on disk: nothing about it is special.
function row(id, extra = {}) {
  return {
    run_id: id, kind: "training", preset: "autonomous", mode: "autonomous", state: "finished",
    owned: false, active: false, external: false, no_human: true, fake_model: false,
    created_at: "2026-10-10T10:00:00+00:00", wall_time_s: 300, elapsed_s: 300,
    totals: {
      done: 6, total: 6, spend_usd: 1.5, spend_cap_usd: 12, lowest_multiplier: 1,
      penalties: { cues: 0, mcqs: 0, human_geocodes: 0 },
    },
    special_present: false, submitted_at: null,
    export: { written_at: "2026-10-10T10:05:00+00:00", stale: false, problems: {} },
    results: null, ...extra,
  };
}

const ids = (rows) => rows.map((r) => r.run_id);

test("parseView reads the filters and falls back to the defaults for anything unknown", () => {
  assert.deepEqual(parseView(new URLSearchParams("")), { ...DEFAULT_VIEW });
  assert.deepEqual(
    parseView(new URLSearchParams("kind=eval&state=interrupted&q=2026&sort=spend&dir=asc")),
    { kind: "eval", state: "interrupted", q: "2026", sort: "spend", dir: "asc" },
  );
  const odd = parseView(new URLSearchParams("kind=<script>&state=dead&sort=__proto__&dir=sideways"));
  assert.deepEqual(odd, { ...DEFAULT_VIEW });
  // A column without a direction takes its natural one.
  assert.equal(parseView(new URLSearchParams("sort=run")).dir, "asc");
  assert.equal(parseView(new URLSearchParams("sort=spend")).dir, "desc");
  assert.deepEqual(parseView(null), { ...DEFAULT_VIEW });
});

test("viewQuery removes defaults from the URL and round-trips through parseView", () => {
  assert.deepEqual(viewQuery({ ...DEFAULT_VIEW }), { kind: null, state: null, q: null, sort: null, dir: null });
  const view = { kind: "scoring", state: "running", q: "abc", sort: "multiplier", dir: "desc" };
  const changes = viewQuery(view);
  assert.deepEqual(changes, { kind: "scoring", state: "running", q: "abc", sort: "multiplier", dir: "desc" });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(changes)) if (value !== null) params.set(key, value);
  assert.deepEqual(parseView(params), view);
  assert.equal(viewQuery({ ...DEFAULT_VIEW, q: "   " }).q, null);
});

test("toggleSort starts a new column in its natural direction and flips the current one", () => {
  const first = toggleSort({ ...DEFAULT_VIEW }, "spend");
  assert.deepEqual([first.sort, first.dir], ["spend", "desc"]);
  const second = toggleSort(first, "spend");
  assert.deepEqual([second.sort, second.dir], ["spend", "asc"]);
  const third = toggleSort(second, "run");
  assert.deepEqual([third.sort, third.dir], ["run", "asc"]);
  assert.equal(toggleSort(third, "nonsense"), third);
});

test("filterRows applies kind, state and a case-insensitive id search together", () => {
  const rows = [
    row("20261010T100000Z"),
    row("Sunday-Scoring", { kind: "scoring", state: "running", active: true }),
    row("eval-a", { kind: "eval", state: "interrupted" }),
  ];
  assert.deepEqual(ids(filterRows(rows, { ...DEFAULT_VIEW })), ids(rows));
  assert.deepEqual(ids(filterRows(rows, { ...DEFAULT_VIEW, kind: "eval" })), ["eval-a"]);
  assert.deepEqual(ids(filterRows(rows, { ...DEFAULT_VIEW, state: "running" })), ["Sunday-Scoring"]);
  assert.deepEqual(ids(filterRows(rows, { ...DEFAULT_VIEW, q: "  SCORING " })), ["Sunday-Scoring"]);
  assert.deepEqual(ids(filterRows(rows, { ...DEFAULT_VIEW, kind: "eval", state: "running" })), []);
  assert.equal(isFiltered({ ...DEFAULT_VIEW }), false);
  assert.equal(isFiltered({ ...DEFAULT_VIEW, q: " " }), false);
  assert.equal(isFiltered({ ...DEFAULT_VIEW, state: "invalid" }), true);
});

test("filterCounts says what each button would show with the other filter left alone", () => {
  const rows = [
    row("a"),
    row("b", { kind: "eval" }),
    row("c", { kind: "eval", state: "interrupted" }),
    row("d", { kind: "scoring", state: "running", active: true }),
  ];
  const counts = filterCounts(rows, { ...DEFAULT_VIEW, kind: "eval" });
  // Kind buttons ignore the kind filter itself.
  assert.deepEqual(
    [counts.kind.all, counts.kind.training, counts.kind.eval, counts.kind.scoring, counts.kind.live],
    [4, 1, 2, 1, 0],
  );
  // State buttons are counted inside the chosen kind.
  assert.deepEqual([counts.state.all, counts.state.finished, counts.state.interrupted, counts.state.running], [2, 1, 1, 0]);
  for (const kind of KINDS) assert.equal(typeof counts.kind[kind], "number");
  for (const state of STATES) assert.equal(typeof counts.state[state], "number");
});

test("sortRows keeps active runs on top and newest first by default", () => {
  const rows = [
    row("old", { created_at: "2026-10-09T08:00:00+00:00" }),
    row("new", { created_at: "2026-10-10T12:00:00+00:00" }),
    row("live-old", { created_at: "2026-10-08T08:00:00+00:00", active: true, owned: true, state: "running" }),
    row("mid", { created_at: "2026-10-10T09:00:00+00:00" }),
    row("live-new", { created_at: "2026-10-10T13:00:00+00:00", active: true, owned: true, state: "queued" }),
  ];
  assert.deepEqual(ids(sortRows(rows, { ...DEFAULT_VIEW })), ["live-new", "live-old", "new", "mid", "old"]);
  // Pinning survives any column and direction.
  const bySpend = sortRows(
    [row("cheap", { totals: { ...row("x").totals, spend_usd: 0.1 } }), row("dear", { totals: { ...row("x").totals, spend_usd: 9 } }),
      row("going", { active: true, state: "running", totals: { ...row("x").totals, spend_usd: 0.5 } })],
    { ...DEFAULT_VIEW, sort: "spend", dir: "desc" },
  );
  assert.deepEqual(ids(bySpend), ["going", "dear", "cheap"]);
  const groups = groupRows(sortRows(rows, { ...DEFAULT_VIEW }));
  assert.deepEqual(ids(groups.active), ["live-new", "live-old"]);
  assert.deepEqual(ids(groups.rest), ["new", "mid", "old"]);
});

test("sortRows puts rows without a value last in both directions and breaks ties by newest", () => {
  const scored = (id, share, created) => row(id, {
    kind: "eval", preset: "eval", created_at: created,
    results: share === null ? null : { score_share: share, median_rank1_m: 100, variants: [] },
  });
  const rows = [
    scored("none", null, "2026-10-10T12:00:00+00:00"),
    scored("low", 0.2, "2026-10-10T11:00:00+00:00"),
    scored("high", 0.8, "2026-10-10T10:00:00+00:00"),
    scored("high-newer", 0.8, "2026-10-10T10:30:00+00:00"),
  ];
  assert.deepEqual(ids(sortRows(rows, { ...DEFAULT_VIEW, sort: "score", dir: "desc" })), ["high-newer", "high", "low", "none"]);
  assert.deepEqual(ids(sortRows(rows, { ...DEFAULT_VIEW, sort: "score", dir: "asc" })), ["low", "high-newer", "high", "none"]);
  const byState = sortRows(
    [row("f"), row("i", { state: "interrupted" }), row("x", { state: "invalid" })],
    { ...DEFAULT_VIEW, sort: "state", dir: "asc" },
  );
  assert.deepEqual(ids(byState), ["i", "x", "f"]);
  // A run without a creation time does not break the order.
  assert.deepEqual(ids(sortRows([row("b", { created_at: null }), row("a")], { ...DEFAULT_VIEW })), ["a", "b"]);
});

test("liveRow rebuilds the totals from the tiles the store holds and drops the heavy fields", () => {
  const tile = (pid, extra = {}) => ({
    run_id: "r1", panorama_id: pid, special: false, status: "running", active: true, final: null,
    spend_usd: 0.25, penalty: { cues: 0, mcqs: 0, human_geocodes: 0, multiplier: 1 }, pending_mcq: null, ...extra,
  });
  const run = {
    ...row("r1", { state: "running", active: true, owned: true, mode: "assisted", no_human: false }),
    totals: { done: 0, total: 3, spend_usd: 0, spend_cap_usd: 6, lowest_multiplier: 1, penalties: { cues: 0, mcqs: 0, human_geocodes: 0 } },
    settings: { model: "m" },
    panoramas: [
      tile("a", { special: true, penalty: { cues: 1, mcqs: 1, human_geocodes: 0, multiplier: 0.76 }, pending_mcq: { id: "q" } }),
      tile("b", { status: "done", final: [{ rank: 1 }], active: false }),
      tile("c", { penalty: { cues: 0, mcqs: 0, human_geocodes: 1, multiplier: 0.5 } }),
    ],
    _at: NOW,
  };
  const live = liveRow(run);
  assert.equal("panoramas" in live, false);
  assert.equal("settings" in live, false);
  assert.equal(live._live, true);
  assert.deepEqual(
    [live.totals.done, live.totals.total, live.totals.spend_usd, live.totals.lowest_multiplier, live.totals.spend_cap_usd],
    [1, 3, 0.75, 0.5, 6],
  );
  assert.deepEqual(live.totals.penalties, { cues: 1, mcqs: 1, human_geocodes: 1 });
  assert.equal(live.special_present, true);
  assert.equal(live.pending_mcqs, 1);
  // A `run` message before any tile: keep what the server said.
  const bare = liveRow({ ...run, panoramas: [], special_present: true, totals: { ...run.totals, done: 2, penalties: { cues: 3, mcqs: 0, human_geocodes: 0 } } });
  assert.deepEqual([bare.totals.done, bare.totals.total, bare.totals.penalties.cues, bare.special_present], [2, 3, 3, true]);
});

test("mergeRows lays the store's runs over the fetched list and hides deleted ids", () => {
  const fetched = [row("disk"), row("held", { state: "running", active: true, owned: true }), row("gone")];
  const held = { ...row("held", { state: "finished", active: false, owned: true }), panoramas: [], _at: NOW };
  const fresh = { ...row("fresh", { state: "queued", active: true, owned: true }), panoramas: [], _at: NOW };
  const merged = mergeRows(fetched, [held, fresh], new Set(["gone"]));
  assert.deepEqual(ids(merged).sort(), ["disk", "fresh", "held"]);
  assert.equal(merged.find((r) => r.run_id === "held").state, "finished");
  assert.equal(merged.find((r) => r.run_id === "disk")._live, undefined);
  assert.deepEqual(mergeRows(null, [], null), []);
});

test("rowSeconds ticks only for a run that is going on this server", () => {
  const going = { ...row("r", { state: "running", active: true, owned: true, elapsed_s: 100, wall_time_s: 40 }), _at: NOW, _live: true };
  assert.equal(rowSeconds(going, NOW + 5000), 105);
  assert.equal(rowSeconds({ ...going, _live: false }, NOW + 5000), 100);
  assert.equal(rowSeconds(row("done", { wall_time_s: 321.5 }), NOW + 5000), 321.5);
  assert.equal(rowSeconds(row("none", { wall_time_s: null }), NOW), null);
});

test("truthVisible only lets score and distance through for an autonomous evaluation run", () => {
  const results = { score_share: 0.5, median_rank1_m: 900, variants: [] };
  assert.equal(truthVisible(row("e", { kind: "eval", results })), true);
  assert.equal(truthVisible(row("e", { kind: "eval", results: null })), false);
  assert.equal(truthVisible(row("t", { kind: "training", results })), false);
  assert.equal(truthVisible(row("e", { kind: "eval", results, no_human: false })), false);
  assert.equal(truthVisible(row("e", { kind: "eval", results, mode: "assisted" })), false);
});

test("stateInfo gives every state its badge status and plain words", () => {
  assert.deepEqual(stateInfo(row("a")), { status: "finished", detail: "", tone: "" });
  assert.deepEqual(
    stateInfo(row("a", { export: { written_at: "x", stale: true, problems: {} } })),
    { status: "finished", detail: "exports out of date", tone: "warn" },
  );
  assert.deepEqual(stateInfo(row("a", { state: "running", active: true })), { status: "running", detail: "", tone: "" });
  assert.equal(stateInfo(row("a", { state: "running", external: true })).detail, "in another process");
  assert.equal(stateInfo(row("a", { state: "queued", active: true })).detail, "waiting to start");
  const cut = row("a", { state: "interrupted", totals: { ...row("x").totals, done: 4, total: 6 } });
  assert.deepEqual(stateInfo(cut), { status: "interrupted", detail: "2 of 6 not final", tone: "warn" });
  const broken = row("a", { state: "invalid", export: { written_at: "x", stale: false, problems: { p1: "9 entries", p2: "bad seq" } } });
  assert.deepEqual(stateInfo(broken), { status: "invalid", detail: "export problems in 2 panoramas", tone: "bad" });
  const empty = row("a", { state: "invalid", totals: { ...row("x").totals, done: 0, total: 0 } });
  assert.equal(stateInfo(empty).detail, "no usable logs");
  assert.equal(stateInfo(row("a", { state: "later" })).status, "later");
});

test("rowNote explains an interrupted run and offers recovery, as UI-SPEC 5.2 asks", () => {
  assert.equal(rowNote(row("fine")), null);
  const cut = rowNote(row("a", { state: "interrupted", totals: { ...row("x").totals, done: 5, total: 6 } }));
  assert.equal(cut.tone, "warn");
  assert.equal(cut.action, "recover");
  assert.match(cut.text, /1 of 6 panoramas/);
  assert.match(cut.text, /last provisional list \(recovered_from_provisional\)/);
  assert.doesNotMatch(cut.text, /—/);

  const elsewhere = rowNote(row("a", { state: "running", external: true }));
  assert.equal(elsewhere.tone, "info");
  assert.equal(elsewhere.action, null);

  const problems = { p1: "one", p2: "two", p3: "three", p4: "four", p5: "five" };
  const broken = rowNote(row("a", { state: "invalid", export: { written_at: "x", stale: false, problems } }));
  assert.equal(broken.action, "submission");
  assert.deepEqual(broken.problems, ["p1: one", "p2: two", "p3: three"]);
  assert.equal(broken.more, 2);

  const empty = rowNote(row("a", { state: "invalid", totals: { ...row("x").totals, done: 0, total: 0 } }));
  assert.equal(empty.action, null);
  assert.match(empty.text, /can be deleted/);
});

test("deleteBlock mirrors the server: active, external, exporting and scoring runs are refused", () => {
  assert.equal(deleteBlock(row("a")), null);
  assert.equal(deleteBlock(row("a", { kind: "eval" })), null);
  assert.equal(deleteBlock(row("a", { state: "interrupted" })), null);
  assert.match(deleteBlock(row("a", { active: true, state: "running" })), /still going/);
  assert.match(deleteBlock(row("a", { external: true, state: "running" })), /Another process/);
  assert.match(deleteBlock(row("a"), { exportJob: true }), /being rebuilt/);
  assert.match(deleteBlock(row("a", { kind: "scoring" })), /never deleted/);
  // A command-line run with human channels on, or with any penalty, is kept like a scoring run.
  assert.equal(deleteBlock(row("a", { kind: "cli", preset: null })), null);
  assert.match(deleteBlock(row("a", { kind: "cli", no_human: false })), /never deleted/);
  const used = { ...row("x").totals, penalties: { cues: 0, mcqs: 1, human_geocodes: 0 } };
  assert.match(deleteBlock(row("a", { kind: "cli", totals: used })), /never deleted/);
  // The most pressing reason comes first.
  assert.match(deleteBlock(row("a", { kind: "scoring", active: true, state: "running" })), /still going/);
});

test("downloadBlock only lets a clean, finished, real run be downloaded from the list", () => {
  assert.equal(downloadBlock(row("a")), null);
  assert.match(downloadBlock(row("a", { active: true, state: "running" })), /still going/);
  assert.match(downloadBlock(row("a", { state: "interrupted" })), /Recover and export/);
  assert.match(downloadBlock(row("a", { state: "invalid" })), /problems/);
  assert.match(downloadBlock(row("a", { fake_model: true })), /demo model/);
  assert.match(downloadBlock(row("a", { export: { written_at: null, stale: true, problems: {} } })), /no exported files/);
  assert.match(downloadBlock(row("a", { export: { written_at: "x", stale: true, problems: {} } })), /older than the logs/);
  assert.match(downloadBlock(row("a", { external: true, state: "running" })), /Another process/);
});

test("rowActions gives each unavailable action its reason", () => {
  const fine = rowActions(row("a"));
  assert.deepEqual(fine, { replay: null, rebuild: null, download: null, duplicate: null, delete: null, recover: false });
  const going = rowActions(row("a", { active: true, state: "running", owned: true }));
  assert.match(going.replay, /still going/);
  assert.match(going.delete, /still going/);
  assert.equal(going.duplicate, null);
  const cli = rowActions(row("a", { kind: "cli", preset: null }));
  assert.match(cli.duplicate, /no saved settings/);
  const empty = rowActions(row("a", { state: "invalid", totals: { ...row("x").totals, done: 0, total: 0 } }));
  assert.match(empty.replay, /no panorama/);
  assert.equal(rowActions(row("a", { state: "interrupted" })).recover, true);
  assert.equal(rowActions(row("a", { state: "interrupted", external: true })).recover, false);
  assert.match(rowActions(row("a"), { exportJob: true }).delete, /being rebuilt/);
  // No zip while the files are being written, and no second rebuild is offered as a reason either:
  // the row shows the job as work in progress.
  assert.match(rowActions(row("a"), { exportJob: true }).download, /being rebuilt/);
  assert.equal(rowActions(row("a"), { exportJob: true }).rebuild, null);
});

test("rebuildBlock keeps a plain rebuild away from runs whose answers it could change", () => {
  assert.equal(rebuildBlock(row("a")), null);
  assert.equal(rebuildBlock(row("a", { state: "invalid" })), null);
  assert.equal(rebuildBlock(row("a", { export: { written_at: null, stale: true, problems: {} } })), null);
  assert.match(rebuildBlock(row("a", { active: true, state: "running" })), /still going/);
  assert.match(rebuildBlock(row("a", { external: true, state: "running" })), /Another process/);
  // Recovery fixes answers, so it is not a one-click action on the list.
  assert.match(rebuildBlock(row("a", { state: "interrupted" })), /Recover and export/);
  assert.match(rebuildBlock(row("a", { state: "invalid", totals: { ...row("x").totals, done: 0, total: 0 } })), /no panorama/);
});

test("exportOutcome says how a rebuild ended, and nothing while it is still going", () => {
  assert.equal(exportOutcome("r", null), null);
  assert.equal(exportOutcome("r", { state: "queued" }), null);
  assert.equal(exportOutcome("r", { state: "running" }), null);
  const clean = exportOutcome("r", { state: "done", result: { recovered: [], written_at: "x", problems: {}, files: [] } });
  assert.deepEqual([clean.tone, clean.text], ["ok", "The exports of run r were rebuilt from its logs."]);
  const one = exportOutcome("r", { state: "done", result: { problems: { p1: "9 entries" } } });
  assert.equal(one.tone, "warn");
  assert.match(one.text, /1 panorama has problems/);
  assert.match(exportOutcome("r", { state: "done", result: { problems: { p1: "a", p2: "b" } } }).text, /2 panoramas have problems/);
  assert.equal(exportOutcome("r", { state: "done", result: null }).tone, "ok");
  const failed = exportOutcome("r", { state: "failed", error: "disk full" });
  assert.equal(failed.tone, "error");
  assert.equal(failed.text, "The exports of run r could not be rebuilt. disk full. Open Submission to see what is on disk.");
  assert.match(exportOutcome("r", { state: "failed", error: "scoring failed. " }).text, /rebuilt\. scoring failed\. Open/);
  assert.match(exportOutcome("r", { state: "failed", error: null }).text, /gave no reason\. Open/);
});

test("exportingRuns finds the runs with an export job in flight", () => {
  const jobs = [
    { id: "1", kind: "export", state: "running", run_id: "a" },
    { id: "2", kind: "export", state: "done", run_id: "b" },
    { id: "3", kind: "eval_score", state: "running", run_id: "c" },
    { id: "4", kind: "export", state: "queued", run_id: "d" },
    { id: "5", kind: "export", state: "running", run_id: null },
  ];
  assert.deepEqual([...exportingRuns(jobs)].sort(), ["a", "d"]);
  assert.equal(exportingRuns(null).size, 0);
});

test("labels and small texts", () => {
  assert.equal(describeKind(row("a")), "Training · autonomous preset");
  assert.equal(describeKind(row("a", { kind: "cli", preset: null })), "Command line");
  assert.equal(describeKind(row("a", { kind: "live", preset: null })), "Live");
  assert.equal(describeKind(row("a", { kind: "training", preset: "custom" })), "Training · custom preset");
  // A preset that only repeats the kind is not said twice.
  assert.equal(describeKind(row("a", { kind: "scoring", preset: "scoring" })), "Scoring");
  assert.equal(describeKind(row("a", { kind: "eval", preset: "eval" })), "Evaluation");
  assert.equal(modeInfo(row("a")).text, "AUTONOMOUS");
  assert.equal(modeInfo(row("a", { mode: "assisted" })).text, "ASSISTED");
  // The penalty colour is reserved for penalised controls: a mode badge never uses it.
  assert.notEqual(modeInfo(row("a", { mode: "assisted" })).kind, "penalty");
  assert.equal(penaltyText({ cues: 0, mcqs: 0, human_geocodes: 0 }), "no penalties");
  assert.equal(penaltyText({ cues: 2, mcqs: 1, human_geocodes: 1 }), "2 cues, 1 MCQ, 1 geocode");
  assert.equal(penaltyText(null), "no penalties");
  assert.deepEqual(penaltyParts({ cues: 1, mcqs: 0, human_geocodes: 2 }), ["1 cue", "2 geocodes"]);
  assert.deepEqual(penaltyParts(undefined), []);
  assert.equal(summaryText([], []), "");
  const rows = [row("a"), row("b", { active: true, state: "running" }), row("c")];
  assert.equal(summaryText(rows, rows), "3 runs, 1 active");
  assert.equal(summaryText(rows, [rows[0]]), "1 of 3 runs shown, 1 active");
  assert.equal(summaryText([rows[0]], [rows[0]]), "1 run");
});
