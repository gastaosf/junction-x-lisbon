// Snapshot + message reducer for the event stream (contract 4.1). Pure: every function takes the
// state and the current time and returns a new state, so the store stays a thin shell around
// EventSource and this file can be tested with `node --test`.
//
// Each tile and run carries `_at`, the local time (ms, same clock as the `nowMs` arguments) at
// which the server-supplied `elapsed_s` / `remaining_s` values were received. Clocks tick from
// there, so a slow stream never freezes a countdown and the server's clock never has to match ours.

const RUNNING = new Set(["running", "awaiting_mcq"]);

export function emptyState() {
  return {
    connected: false,
    bootId: null,
    seq: 0,
    runs: new Map(),
    jobs: new Map(),
    health: null,
    serverOffsetMs: 0,
  };
}

/** `server_time` as milliseconds; accepts epoch seconds, epoch milliseconds or an ISO string. */
export function serverTimeMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

const stampTile = (tile, nowMs) => ({ ...tile, _at: nowMs });

export function stampRun(run, nowMs) {
  return { ...run, _at: nowMs, panoramas: (run.panoramas || []).map((tile) => stampTile(tile, nowMs)) };
}

// The order the server uses for RunState.panoramas; needed when a late addition arrives as a
// message rather than in a snapshot.
function tileRank(tile) {
  if (tile.special) return 0;
  return tile.label === "Urban" ? 1 : 2;
}

function sortTiles(tiles) {
  return tiles
    .map((tile, index) => ({ tile, index }))
    .sort((a, b) => tileRank(a.tile) - tileRank(b.tile) || a.index - b.index)
    .map((entry) => entry.tile);
}

const seqOf = (tile) => (typeof tile.last_seq === "number" ? tile.last_seq : null);

// A34 (8): a tile built before the one we hold must not replace it. Equal seqs are accepted
// because live-only fields (the MCQ countdown, questions left) change without a log event.
function isOlder(incoming, held) {
  const a = seqOf(incoming);
  const b = seqOf(held);
  return a !== null && b !== null && a < b;
}

/** Put one tile into a run. Returns `{run, applied}`; `applied` is false for an older tile. */
export function mergeTile(run, tile, nowMs) {
  const tiles = run.panoramas || [];
  const index = tiles.findIndex((t) => t.panorama_id === tile.panorama_id);
  const stamped = stampTile(tile, nowMs);
  if (index === -1) return { run: { ...run, panoramas: sortTiles([...tiles, stamped]) }, applied: true };
  if (isOlder(tile, tiles[index])) return { run, applied: false };
  const next = tiles.slice();
  next[index] = stamped;
  return { run: { ...run, panoramas: next }, applied: true };
}

/**
 * Replace the state with a snapshot. Returns `{state, gap: false, bootChanged, stale}`.
 * A snapshot older than what we hold (a slow poll overtaken by the stream) is dropped as `stale`.
 * Within one server boot, a tile already patched from a POST response wins over an older copy.
 */
export function applySnapshot(state, snapshot, nowMs) {
  const bootId = snapshot.boot_id ?? null;
  const sameBoot = state.bootId !== null && state.bootId === bootId;
  const bootChanged = state.bootId !== null && state.bootId !== bootId;
  const seq = typeof snapshot.seq === "number" ? snapshot.seq : 0;
  if (sameBoot && seq < state.seq) return { state, gap: false, bootChanged: false, stale: true };

  const runs = new Map();
  for (const raw of snapshot.runs || []) {
    const run = stampRun(raw, nowMs);
    const held = sameBoot ? state.runs.get(run.run_id) : null;
    if (held) {
      const heldTiles = new Map((held.panoramas || []).map((t) => [t.panorama_id, t]));
      run.panoramas = run.panoramas.map((tile) => {
        const mine = heldTiles.get(tile.panorama_id);
        return mine && isOlder(tile, mine) ? mine : tile;
      });
    }
    runs.set(run.run_id, run);
  }
  const jobs = new Map((snapshot.jobs || []).map((job) => [job.id, job]));
  const serverMs = serverTimeMs(snapshot.server_time);
  return {
    state: {
      ...state,
      bootId,
      seq,
      runs,
      jobs,
      health: snapshot.health ?? null,
      serverOffsetMs: serverMs === null ? state.serverOffsetMs : serverMs - nowMs,
    },
    gap: false,
    bootChanged,
    stale: false,
  };
}

function applyPano(state, msg, nowMs) {
  const run = state.runs.get(msg.run_id);
  // A tile for a run we do not hold means we missed its `run` message: resynchronise.
  if (!run || !msg.tile) return null;
  const merged = mergeTile(run, msg.tile, nowMs);
  if (!merged.applied) return state;
  const runs = new Map(state.runs);
  runs.set(msg.run_id, merged.run);
  return { ...state, runs };
}

// A run this server owns lives in `state.runs`; every other run is a record on disk that the store
// reads with loadRun. The server also sends a `run` message after a change to a disk run (a
// submitted stamp, a stage note, rebuilt exports): it says `owned: false` and must not create an
// entry here, because the message has no panoramas and the entry would pass for the whole run.
function applyRun(state, msg, nowMs) {
  const held = state.runs.get(msg.run_id);
  const disowned = msg.removed || !msg.run || msg.run.owned === false;
  if (disowned) {
    if (!held) return state;
    const runs = new Map(state.runs);
    runs.delete(msg.run_id);
    return { ...state, runs };
  }
  const runs = new Map(state.runs);
  // `run` messages carry RunState without panoramas: keep the tiles we already hold. A run we do
  // not hold yet was just launched, and its tiles follow as `pano` messages.
  runs.set(msg.run_id, { ...held, ...msg.run, panoramas: held ? held.panoramas : [], _at: nowMs });
  return { ...state, runs };
}

function applyJob(state, msg) {
  if (!msg.job) return state;
  const jobs = new Map(state.jobs);
  jobs.set(msg.job.id, msg.job);
  return { ...state, jobs };
}

/**
 * Apply one stream message. Returns `{state, gap}`: `gap` is true when the message is not the
 * next in sequence (or refers to a run we never saw), and the caller must take a new snapshot.
 * A message at or below the current seq was already covered by a snapshot and is ignored.
 */
export function applyMessage(state, msg, nowMs) {
  if (typeof msg.seq !== "number") return { state, gap: true };
  if (msg.seq <= state.seq) return { state, gap: false, ignored: true };
  if (msg.seq !== state.seq + 1) return { state, gap: true };

  let next = state;
  if (msg.kind === "pano") next = applyPano(state, msg, nowMs);
  else if (msg.kind === "run") next = applyRun(state, msg, nowMs);
  else if (msg.kind === "job") next = applyJob(state, msg);
  else if (msg.kind === "health") next = { ...state, health: msg.health ?? null };
  // "index" and kinds this build does not know change nothing here; listeners still get them.
  if (next === null) return { state, gap: true };
  return { state: { ...next, seq: msg.seq }, gap: false };
}

/** True when a ping reports a seq we have not reached: messages were lost on the way. */
export function pingGap(state, ping) {
  return typeof ping.seq === "number" && ping.seq > state.seq;
}

/**
 * Apply messages that were held back while a snapshot was on its way (a tab joining a stream that
 * other tabs already share reads the snapshot over HTTP and the messages from the stream).
 * Messages the snapshot already covers are skipped. Returns `{state, gap, applied}`: `applied` is
 * the list of messages that changed the state, in order; `gap` is true when one is missing
 * between the snapshot and the messages, and the caller must take a new snapshot.
 */
export function applyBacklog(state, messages, nowMs) {
  let next = state;
  const applied = [];
  for (const msg of messages) {
    const out = applyMessage(next, msg, nowMs);
    if (out.gap) return { state: next, gap: true, applied };
    if (out.ignored) continue;
    next = out.state;
    applied.push(msg);
  }
  return { state: next, gap: false, applied };
}

/**
 * Fold a `run` message about a run on disk into the copy read with GET /api/runs/<id>: the
 * message has every field but the panoramas, which stay as they were read.
 */
export function mergeRunFields(run, fields, nowMs) {
  return { ...run, ...fields, panoramas: run.panoramas || [], _at: nowMs };
}

/** Apply a tile returned by a POST at once. Returns `{state, applied}` (false for an older tile). */
export function patchTile(state, tile, nowMs) {
  const run = tile ? state.runs.get(tile.run_id) : null;
  if (!run) return { state, applied: false };
  const merged = mergeTile(run, tile, nowMs);
  if (!merged.applied) return { state, applied: false };
  const runs = new Map(state.runs);
  runs.set(tile.run_id, merged.run);
  return { state: { ...state, runs }, applied: true };
}

// ---------------------------------------------------------------- clocks

const sinceReceipt = (thing, nowMs) =>
  typeof thing._at === "number" ? Math.max(0, (nowMs - thing._at) / 1000) : 0;

/** True for a tile that the server is working on right now. */
export function isTicking(tile) {
  return tile.active !== false && RUNNING.has(tile.status) && !tile.final;
}

/** Seconds a panorama has been running; ticks locally while it is active, frozen once final. */
export function tileElapsed(tile, nowMs) {
  const base = Number(tile.elapsed_s) || 0;
  return isTicking(tile) ? base + sinceReceipt(tile, nowMs) : base;
}

export function runElapsed(run, nowMs) {
  const base = Number(run.elapsed_s) || 0;
  return run.state === "running" && run.active !== false ? base + sinceReceipt(run, nowMs) : base;
}

/** Seconds until the run's watchdog finalises everything, or null when there is none. */
export function watchdogRemaining(run, nowMs) {
  if (typeof run.watchdog_remaining_s !== "number") return null;
  const ticking = run.state === "running" && run.active !== false;
  return Math.max(0, run.watchdog_remaining_s - (ticking ? sinceReceipt(run, nowMs) : 0));
}

/** Seconds left to answer the pending question, or null when none is pending. */
export function mcqRemaining(tile, nowMs) {
  const mcq = tile.pending_mcq;
  if (!mcq) return null;
  if (typeof mcq.remaining_s !== "number") return null;
  return Math.max(0, mcq.remaining_s - sinceReceipt(tile, nowMs));
}

/**
 * Totals for the active-run strip. Computed from the tiles when we hold them (they are fresher
 * than the last `run` message), else from `run.totals`.
 */
export function runTotals(run) {
  const tiles = run.panoramas || [];
  const totals = run.totals || {};
  if (!tiles.length) {
    return {
      done: totals.done ?? 0,
      total: totals.total ?? 0,
      spend_usd: totals.spend_usd ?? 0,
      spend_cap_usd: totals.spend_cap_usd ?? null,
      lowest_multiplier: totals.lowest_multiplier ?? 1,
      pending_mcqs: 0,
    };
  }
  let done = 0;
  let spend = 0;
  let lowest = 1;
  let pending = 0;
  for (const tile of tiles) {
    if (tile.final || tile.status === "done") done += 1;
    spend += Number(tile.spend_usd) || 0;
    const mult = tile.penalty && typeof tile.penalty.multiplier === "number" ? tile.penalty.multiplier : 1;
    lowest = Math.min(lowest, mult);
    if (tile.pending_mcq && tile.active !== false) pending += 1;
  }
  return {
    done,
    total: tiles.length,
    spend_usd: spend,
    spend_cap_usd: totals.spend_cap_usd ?? null,
    lowest_multiplier: lowest,
    pending_mcqs: pending,
  };
}
