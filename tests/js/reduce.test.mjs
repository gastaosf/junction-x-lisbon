import test from "node:test";
import assert from "node:assert/strict";

import {
  applyBacklog,
  applyMessage,
  applySnapshot,
  emptyState,
  mcqRemaining,
  mergeRunFields,
  mergeTile,
  patchTile,
  pingGap,
  runElapsed,
  runTotals,
  serverTimeMs,
  tileElapsed,
  watchdogRemaining,
} from "../../server/static/console/js/logic/reduce.js";

const NOW = 1_000_000;

function tile(pid, extra = {}) {
  return {
    run_id: "r1", panorama_id: pid, label: "Urban", special: false, status: "running", active: true,
    final: null, elapsed_s: 10, spend_usd: 0.1, penalty: { cues: 0, mcqs: 0, human_geocodes: 0, multiplier: 1 },
    pending_mcq: null, last_seq: 5, ...extra,
  };
}

function snapshot(extra = {}) {
  return {
    boot_id: "boot-a", seq: 40, server_time: 2000,
    runs: [{ run_id: "r1", state: "running", active: true, elapsed_s: 100, panoramas: [tile("p1"), tile("p2")] }],
    jobs: [{ id: "j1", state: "running" }],
    health: { openai: { present: true, ok: true }, fake_model: false },
    ...extra,
  };
}

function loaded() {
  return applySnapshot(emptyState(), snapshot(), NOW).state;
}

test("snapshot replaces the state and stamps receipt times", () => {
  const { state, gap, bootChanged, stale } = applySnapshot(emptyState(), snapshot(), NOW);
  assert.equal(gap, false);
  assert.equal(bootChanged, false, "the first snapshot is not a restart");
  assert.equal(stale, false);
  assert.equal(state.bootId, "boot-a");
  assert.equal(state.seq, 40);
  assert.deepEqual([...state.runs.keys()], ["r1"]);
  assert.equal(state.runs.get("r1").panoramas.length, 2);
  assert.equal(state.runs.get("r1")._at, NOW);
  assert.equal(state.runs.get("r1").panoramas[0]._at, NOW);
  assert.equal(state.jobs.get("j1").state, "running");
  assert.equal(state.health.openai.ok, true);
  assert.equal(state.serverOffsetMs, 2000 * 1000 - NOW);
});

test("snapshot does not mutate the previous state", () => {
  const before = emptyState();
  applySnapshot(before, snapshot(), NOW);
  assert.equal(before.bootId, null);
  assert.equal(before.runs.size, 0);
});

test("messages apply in order by seq", () => {
  let state = loaded();
  let out = applyMessage(state, {
    seq: 41, kind: "pano", run_id: "r1", panorama_id: "p1", event: null,
    tile: tile("p1", { status: "awaiting_mcq", last_seq: 6, pending_mcq: { id: "q1", remaining_s: 90 } }),
  }, NOW + 500);
  assert.equal(out.gap, false);
  state = out.state;
  assert.equal(state.seq, 41);
  const p1 = state.runs.get("r1").panoramas.find((t) => t.panorama_id === "p1");
  assert.equal(p1.status, "awaiting_mcq");
  assert.equal(p1._at, NOW + 500);

  out = applyMessage(state, { seq: 42, kind: "run", run_id: "r1", run: { run_id: "r1", state: "finished", active: false } }, NOW);
  state = out.state;
  assert.equal(state.runs.get("r1").state, "finished");
  assert.equal(state.runs.get("r1").panoramas.length, 2, "a run message keeps the tiles we hold");

  out = applyMessage(state, { seq: 43, kind: "job", job: { id: "j1", state: "done" } }, NOW);
  state = out.state;
  assert.equal(state.jobs.get("j1").state, "done");

  out = applyMessage(state, { seq: 44, kind: "health", health: { fake_model: true } }, NOW);
  state = out.state;
  assert.equal(state.health.fake_model, true);

  out = applyMessage(state, { seq: 45, kind: "index" }, NOW);
  assert.equal(out.gap, false);
  assert.equal(out.state.seq, 45);

  out = applyMessage(out.state, { seq: 46, kind: "something_new" }, NOW);
  assert.equal(out.gap, false, "an unknown kind still advances the sequence");
  assert.equal(out.state.seq, 46);
});

test("a run message can add and remove a run", () => {
  let state = loaded();
  state = applyMessage(state, { seq: 41, kind: "run", run_id: "r2", run: { run_id: "r2", state: "queued", active: true } }, NOW).state;
  assert.deepEqual(state.runs.get("r2").panoramas, []);
  state = applyMessage(state, { seq: 42, kind: "pano", run_id: "r2", tile: tile("x", { run_id: "r2" }) }, NOW).state;
  assert.equal(state.runs.get("r2").panoramas.length, 1);
  state = applyMessage(state, { seq: 43, kind: "run", run_id: "r2", removed: true }, NOW).state;
  assert.equal(state.runs.has("r2"), false);
});

test("a late panorama is inserted in the server's order: Special One, Urban, non-Urban", () => {
  let state = loaded();
  state = applyMessage(state, { seq: 41, kind: "pano", run_id: "r1", tile: tile("n1", { label: "non-Urban" }) }, NOW).state;
  state = applyMessage(state, { seq: 42, kind: "pano", run_id: "r1", tile: tile("s1", { special: true, label: "non-Urban" }) }, NOW).state;
  state = applyMessage(state, { seq: 43, kind: "pano", run_id: "r1", tile: tile("p3") }, NOW).state;
  assert.deepEqual(state.runs.get("r1").panoramas.map((t) => t.panorama_id), ["s1", "p1", "p2", "p3", "n1"]);
});

test("a gap is reported and leaves the state untouched", () => {
  const state = loaded();
  const out = applyMessage(state, { seq: 43, kind: "job", job: { id: "j9", state: "queued" } }, NOW);
  assert.equal(out.gap, true);
  assert.equal(out.state, state);
  assert.equal(state.jobs.has("j9"), false);
});

test("a message the snapshot already covered is ignored without a gap", () => {
  const state = loaded();
  const out = applyMessage(state, { seq: 40, kind: "job", job: { id: "j1", state: "failed" } }, NOW);
  assert.equal(out.gap, false);
  assert.equal(out.state, state);
});

test("a message without a seq, or for a run we never saw, asks for a resync", () => {
  const state = loaded();
  assert.equal(applyMessage(state, { kind: "index" }, NOW).gap, true);
  assert.equal(applyMessage(state, { seq: 41, kind: "pano", run_id: "ghost", tile: tile("p1", { run_id: "ghost" }) }, NOW).gap, true);
});

test("a ping ahead of us is a gap; a ping at our seq is not", () => {
  const state = loaded();
  assert.equal(pingGap(state, { seq: 40 }), false);
  assert.equal(pingGap(state, { seq: 39 }), false);
  assert.equal(pingGap(state, { seq: 41 }), true);
});

test("a new boot id replaces everything, even with a lower seq", () => {
  let state = loaded();
  state = patchTile(state, tile("p1", { last_seq: 99 }), NOW).state;
  const out = applySnapshot(state, snapshot({
    boot_id: "boot-b", seq: 3,
    runs: [{ run_id: "r7", state: "running", active: true, panoramas: [tile("p1", { run_id: "r7", last_seq: 1 })] }],
    jobs: [],
  }), NOW + 10);
  assert.equal(out.bootChanged, true);
  assert.equal(out.stale, false);
  assert.equal(out.state.bootId, "boot-b");
  assert.equal(out.state.seq, 3);
  assert.deepEqual([...out.state.runs.keys()], ["r7"]);
  assert.equal(out.state.runs.get("r7").panoramas[0].last_seq, 1);
  assert.equal(out.state.jobs.size, 0);
});

test("an older snapshot from the same boot is dropped as stale", () => {
  let state = loaded();
  state = applyMessage(state, { seq: 41, kind: "index" }, NOW).state;
  const out = applySnapshot(state, snapshot({ seq: 40 }), NOW);
  assert.equal(out.stale, true);
  assert.equal(out.state, state);
});

test("a same-boot snapshot keeps a tile that a POST already moved ahead", () => {
  let state = loaded();
  state = patchTile(state, tile("p1", { last_seq: 9, status: "done", final: [{ rank: 1 }] }), NOW).state;
  const out = applySnapshot(state, snapshot({ seq: 41 }), NOW + 5);
  const tiles = out.state.runs.get("r1").panoramas;
  assert.equal(tiles.find((t) => t.panorama_id === "p1").last_seq, 9);
  assert.equal(tiles.find((t) => t.panorama_id === "p2").last_seq, 5);
});

test("patchTile applies a newer or equal tile and ignores an older one", () => {
  const state = loaded();

  const newer = patchTile(state, tile("p1", { last_seq: 8, spend_usd: 0.5 }), NOW + 1);
  assert.equal(newer.applied, true);
  assert.equal(newer.state.runs.get("r1").panoramas[0].spend_usd, 0.5);
  assert.equal(state.runs.get("r1").panoramas[0].spend_usd, 0.1, "the old state is not mutated");

  const equal = patchTile(newer.state, tile("p1", { last_seq: 8, spend_usd: 0.6 }), NOW + 2);
  assert.equal(equal.applied, true, "live-only fields change without a new log event");

  const older = patchTile(equal.state, tile("p1", { last_seq: 7, spend_usd: 0.2 }), NOW + 3);
  assert.equal(older.applied, false);
  assert.equal(older.state, equal.state);
  assert.equal(older.state.runs.get("r1").panoramas[0].spend_usd, 0.6);
});

test("an older tile is also ignored when it arrives on the stream, but the seq advances", () => {
  let state = loaded();
  state = patchTile(state, tile("p1", { last_seq: 8 }), NOW).state;
  const out = applyMessage(state, { seq: 41, kind: "pano", run_id: "r1", tile: tile("p1", { last_seq: 6 }) }, NOW);
  assert.equal(out.gap, false);
  assert.equal(out.state.seq, 41);
  assert.equal(out.state.runs.get("r1").panoramas[0].last_seq, 8);
});

test("patchTile ignores a tile of a run that is not in the state", () => {
  const state = loaded();
  const out = patchTile(state, tile("p1", { run_id: "elsewhere" }), NOW);
  assert.equal(out.applied, false);
  assert.equal(out.state, state);
  assert.equal(patchTile(state, null, NOW).applied, false);
});

test("mergeTile works on a run held outside the state", () => {
  const run = { run_id: "disk", panoramas: [tile("p1", { run_id: "disk", last_seq: 4 })] };
  assert.equal(mergeTile(run, tile("p1", { run_id: "disk", last_seq: 3 }), NOW).applied, false);
  const out = mergeTile(run, tile("p1", { run_id: "disk", last_seq: 4, fallback_acknowledged: true }), NOW);
  assert.equal(out.applied, true);
  assert.equal(out.run.panoramas[0].fallback_acknowledged, true);
});

test("clocks tick locally from the receipt time and freeze when a tile is final", () => {
  const state = loaded();
  const run = state.runs.get("r1");
  const running = run.panoramas[0];
  assert.equal(tileElapsed(running, NOW), 10);
  assert.equal(tileElapsed(running, NOW + 4000), 14);
  assert.equal(tileElapsed(running, NOW - 4000), 10, "a clock never runs backwards");

  const done = { ...running, status: "done", active: false, final: [{ rank: 1 }], elapsed_s: 33 };
  assert.equal(tileElapsed(done, NOW + 60_000), 33);
  const queued = { ...running, status: "pending", elapsed_s: 0 };
  assert.equal(tileElapsed(queued, NOW + 60_000), 0);
  const interrupted = { ...running, status: "interrupted", active: false, elapsed_s: 21 };
  assert.equal(tileElapsed(interrupted, NOW + 60_000), 21);

  assert.equal(runElapsed(run, NOW + 2000), 102);
  assert.equal(runElapsed({ ...run, state: "finished", active: false }, NOW + 2000), 100);

  assert.equal(watchdogRemaining({ ...run, watchdog_remaining_s: 30 }, NOW + 10_000), 20);
  assert.equal(watchdogRemaining({ ...run, watchdog_remaining_s: 30 }, NOW + 90_000), 0);
  assert.equal(watchdogRemaining(run, NOW), null);
});

test("the MCQ countdown ticks down and stops at zero", () => {
  const asked = { ...tile("p1", { status: "awaiting_mcq", pending_mcq: { id: "q", remaining_s: 47 } }), _at: NOW };
  assert.equal(mcqRemaining(asked, NOW), 47);
  assert.equal(mcqRemaining(asked, NOW + 7000), 40);
  assert.equal(mcqRemaining(asked, NOW + 100_000), 0);
  assert.equal(mcqRemaining(tile("p2"), NOW), null);
});

test("runTotals comes from the tiles when we hold them, else from run.totals", () => {
  const run = {
    run_id: "r1", totals: { done: 9, total: 9, spend_usd: 9, spend_cap_usd: 12, lowest_multiplier: 0.1 },
    panoramas: [
      tile("p1", { final: [{ rank: 1 }], status: "done", spend_usd: 1.25, penalty: { multiplier: 0.76 } }),
      tile("p2", { spend_usd: 0.5, pending_mcq: { id: "q" } }),
    ],
  };
  assert.deepEqual(runTotals(run), {
    done: 1, total: 2, spend_usd: 1.75, spend_cap_usd: 12, lowest_multiplier: 0.76, pending_mcqs: 1,
  });
  assert.deepEqual(runTotals({ run_id: "r2", totals: { done: 2, total: 6, spend_usd: 3, lowest_multiplier: 0.8 } }), {
    done: 2, total: 6, spend_usd: 3, spend_cap_usd: null, lowest_multiplier: 0.8, pending_mcqs: 0,
  });
});

test("server_time is read as seconds, milliseconds or ISO", () => {
  assert.equal(serverTimeMs(1_760_000_000), 1_760_000_000_000);
  assert.equal(serverTimeMs(1_760_000_000_000), 1_760_000_000_000);
  assert.equal(serverTimeMs("2026-10-11T10:00:00Z"), Date.parse("2026-10-11T10:00:00Z"));
  assert.equal(serverTimeMs("nonsense"), null);
  assert.equal(serverTimeMs(undefined), null);
});

// ---------------------------------------------------------------- runs on disk, shared stream

test("a run message about a run on disk creates no entry", () => {
  const state = loaded();
  // What the server publishes after a submitted stamp, a stage note or rebuilt exports on a run
  // it does not own: RunState without panoramas, `owned: false`.
  const msg = { seq: 41, kind: "run", run_id: "old", run: { run_id: "old", state: "finished", owned: false, active: false, submitted_at: "2026-10-10T10:00:00Z" } };
  const out = applyMessage(state, msg, NOW);
  assert.equal(out.gap, false);
  assert.equal(out.state.seq, 41, "the sequence still advances");
  assert.equal(out.state.runs.has("old"), false, "an entry without panoramas would pass for the whole run");
  assert.equal(out.state.runs, state.runs, "the runs map is untouched");
});

test("a run message keeps the tiles of an owned run, and a new owned run starts empty", () => {
  let state = loaded();
  state = applyMessage(state, { seq: 41, kind: "run", run_id: "r1", run: { run_id: "r1", state: "finished", owned: true, active: false } }, NOW + 5).state;
  assert.equal(state.runs.get("r1").state, "finished");
  assert.equal(state.runs.get("r1").panoramas.length, 2);
  assert.equal(state.runs.get("r1")._at, NOW + 5);
  state = applyMessage(state, { seq: 42, kind: "run", run_id: "new", run: { run_id: "new", state: "queued", owned: true, active: true } }, NOW).state;
  assert.deepEqual(state.runs.get("new").panoramas, [], "its tiles follow as pano messages");
});

test("a run that is removed, or no longer owned, leaves the live state", () => {
  let state = loaded();
  const untouched = applyMessage(state, { seq: 41, kind: "run", run_id: "never-held", run: null, removed: true }, NOW).state;
  assert.equal(untouched.runs, state.runs);
  state = applyMessage(state, { seq: 41, kind: "run", run_id: "r1", run: { run_id: "r1", owned: false, state: "interrupted" } }, NOW).state;
  assert.equal(state.runs.has("r1"), false, "the store reads it from disk from now on");
});

test("mergeRunFields: new fields, the panoramas that were read, a new stamp", () => {
  const read = { run_id: "old", state: "finished", submitted_at: null, panoramas: [tile("p1"), tile("p2")], _at: NOW };
  const merged = mergeRunFields(read, { run_id: "old", state: "finished", submitted_at: "2026-10-10T10:00:00Z", owned: false }, NOW + 9);
  assert.equal(merged.submitted_at, "2026-10-10T10:00:00Z");
  assert.equal(merged.panoramas, read.panoramas);
  assert.equal(merged._at, NOW + 9);
  assert.equal(read.submitted_at, null, "the copy that was read is not changed");
});

test("applyBacklog: a tab that joins a shared stream applies what arrived while its snapshot was on the way", () => {
  // The snapshot was taken at seq 40; the stream relayed 39..43 meanwhile.
  const state = loaded();
  const held = [
    { seq: 39, kind: "job", job: { id: "old", state: "done" } },
    { seq: 40, kind: "index" },
    { seq: 41, kind: "pano", run_id: "r1", tile: tile("p1", { status: "done", last_seq: 9 }) },
    { seq: 42, kind: "index" },
    { seq: 43, kind: "job", job: { id: "j2", state: "queued" } },
  ];
  const out = applyBacklog(state, held, NOW + 3);
  assert.equal(out.gap, false);
  assert.equal(out.state.seq, 43);
  assert.deepEqual(out.applied.map((m) => m.seq), [41, 42, 43], "what the snapshot already covers is skipped");
  assert.equal(out.state.jobs.has("old"), false);
  assert.equal(out.state.runs.get("r1").panoramas[0].status, "done");
  assert.equal(state.seq, 40, "the input state is not changed");
  assert.deepEqual(applyBacklog(state, [], NOW), { state, gap: false, applied: [] });
});

test("applyBacklog: a hole between the snapshot and the messages asks for a new snapshot", () => {
  const state = loaded();
  const out = applyBacklog(state, [
    { seq: 41, kind: "index" },
    { seq: 43, kind: "job", job: { id: "j2", state: "queued" } },
    { seq: 44, kind: "index" },
  ], NOW);
  assert.equal(out.gap, true);
  assert.equal(out.state.seq, 41, "everything before the hole is kept");
  assert.deepEqual(out.applied.map((m) => m.seq), [41]);
  // The snapshot is older than the first message that was held: nothing can be applied.
  const late = applyBacklog(state, [{ seq: 45, kind: "index" }], NOW);
  assert.equal(late.gap, true);
  assert.equal(late.state, state);
});
