// The live state of the console: one event stream (/api/stream) carries every active run and job
// (UI-SPEC 7).
//
// On connect the server sends a snapshot, then messages with consecutive seq numbers. They are
// applied by logic/reduce.js; a gap, a ping ahead of us or a new boot id makes the store take a
// new snapshot, so a lost message is repaired rather than ignored. While the stream is down the
// store polls GET /api/snapshot so the page still shows state, and `state.connected` is false so
// that controls which charge a penalty can be disabled (UI-SPEC 5.1).
//
// "Any number of tabs may be open": a browser gives a host six connections and a stream holds
// one, so the tabs of one browser share a single stream. It lives in a SharedWorker
// (stream-worker.js, logic/relay.js) that relays every frame to every tab; a tab that joins reads
// the snapshot over HTTP and applies the relayed messages after it. Where shared workers are not
// available, or the worker does not answer, the tab opens an EventSource of its own. Either way
// the stream is let go when the page is hidden for good or kept in the back/forward cache
// (`pagehide`), and taken up again, with a new snapshot, when the page comes back (`pageshow`).

import { api, runUrl } from "./api.js";
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
  stampRun,
  tileElapsed,
  watchdogRemaining,
} from "./logic/reduce.js";

const STREAM_URL = "/api/stream";
const SNAPSHOT_URL = "/api/snapshot";
const WORKER_URL = "/static/console/js/stream-worker.js";
const WORKER_NAME = "astrolabio-stream-1"; // change it with the relay protocol: an old worker is never joined
const POLL_MS = 3000; // snapshot poll while the stream is down
const SILENCE_MS = 25000; // the server pings every 10 s; this long without a byte means it dropped
const RESYNC_GRACE_MS = 3000; // a resync that takes longer than this is shown as a disconnect
const RESYNC_WINDOW_MS = 10000;
const RESYNC_MAX = 5; // more resyncs than this inside the window is treated as a broken stream
const BACKOFF_MS = [500, 1000, 2000, 3000, 5000];
const READY_TIMEOUT_MS = 4000; // loadRun does not wait for a first snapshot for ever
const WELCOME_TIMEOUT_MS = 3000; // a shared worker that has not answered by then is not used
const SNAPSHOT_TIMEOUT_MS = 8000;
const BACKLOG_MAX = 5000; // messages held while a snapshot is on its way; more means start again

function safely(fn, ...args) {
  try {
    fn(...args);
  } catch (err) {
    console.error("store listener failed", err);
  }
}

// Exported for the tests; the app uses the one instance below.
export class Store {
  constructor() {
    // {connected, bootId, seq, runs: Map<run_id, RunState>, jobs: Map<id, Job>, health, serverOffsetMs}
    // plus `everConnected` and `lastContactMs` for the connection banner.
    this.state = { ...emptyState(), everConnected: false, lastContactMs: 0 };
    this.subscribers = new Set();
    this.listeners = new Map(); // kind -> Set<fn>
    this.loaded = new Map(); // run_id -> {run, stale}: runs read from disk, not in the snapshot
    this.jobWatchers = new Map(); // job id -> Set<fn>
    this.mode = null; // "shared" (frames come from the worker) or "direct" (our own EventSource)
    this.source = null; // direct mode: the EventSource
    this.worker = null; // shared mode: the SharedWorker
    this.port = null;
    this.relayUp = false; // shared mode: the worker's stream is delivering
    this.awaiting = false; // shared mode: a snapshot is on its way and messages wait in `backlog`
    this.backlog = [];
    this.joinToken = 0;
    this.joinBusy = false; // a snapshot GET for this tab's join is in flight
    this.paused = false; // the page is hidden for good or in the back/forward cache
    this.started = false;
    this.attempt = 0;
    this.flushPending = false;
    this.timers = { reconnect: null, poll: null, silence: null, resync: null, welcome: null };
    this.lastByteMs = 0;
    this.resyncs = [];
    this.ready = new Promise((resolve) => { this.markReady = resolve; });
  }

  // ------------------------------------------------------------ connection

  /** Open the stream. Safe to call more than once. */
  connect() {
    if (this.started) return;
    this.started = true;
    setTimeout(() => this.markReady(), READY_TIMEOUT_MS);
    if (!this.openShared()) this.openDirect();
    this.timers.silence = setInterval(() => this.checkSilence(), 5000);
    // A laptop waking from sleep: do not wait for the silence check.
    window.addEventListener("online", () => this.onOnline());
    // A page that is left must give its connection back, also when the browser keeps the page
    // for the Back button: six kept pages would otherwise hold all six connections to the host.
    window.addEventListener("pagehide", () => this.pause());
    window.addEventListener("pageshow", (event) => { if (event.persisted) this.resume(); });
    // A tab the browser froze to save power missed whatever happened meanwhile.
    document.addEventListener("resume", () => {
      this.lastByteMs = Date.now();
      if (!this.paused) this.resync();
    });
  }

  // ---- shared mode: frames come from the SharedWorker

  openShared() {
    if (typeof SharedWorker !== "function") return false;
    let worker = null;
    try {
      worker = new SharedWorker(WORKER_URL, { type: "module", name: WORKER_NAME });
    } catch (_) {
      return false; // module workers not supported, or blocked
    }
    this.mode = "shared";
    this.worker = worker;
    this.port = worker.port;
    this.relayUp = false;
    this.awaiting = true;
    this.backlog = [];
    this.lastByteMs = Date.now();
    worker.onerror = () => { if (this.worker === worker) this.openDirect(); }; // the script did not load
    worker.port.onmessage = (event) => { if (this.worker === worker) this.onRelay(event.data); };
    worker.port.start();
    this.hello();
    return true;
  }

  hello() {
    this.send({ t: "hello" });
    clearTimeout(this.timers.welcome);
    this.timers.welcome = setTimeout(() => {
      if (this.mode === "shared" && !this.paused) this.openDirect();
    }, WELCOME_TIMEOUT_MS);
  }

  send(message) {
    if (!this.port) return;
    try {
      this.port.postMessage(message);
    } catch (_) {
      // The worker is gone: the silence check moves this tab to a stream of its own.
    }
  }

  closeShared() {
    clearTimeout(this.timers.welcome);
    if (!this.port) return;
    this.send({ t: "bye" });
    this.port.onmessage = null;
    try {
      this.port.close();
    } catch (_) {
      // already closed
    }
    this.worker = null;
    this.port = null;
    this.relayUp = false;
    this.awaiting = false;
    this.backlog = [];
  }

  onRelay(message) {
    if (this.paused || !message) return;
    this.lastByteMs = Date.now();
    if (message.t === "welcome") {
      clearTimeout(this.timers.welcome);
      this.relayUp = message.state === "up";
      if (message.state === "up") this.join(); // the stream is running: our snapshot comes over HTTP
      else if (message.state === "down") this.markDown();
      // "opening": the stream's own snapshot frame is on its way.
      return;
    }
    if (message.t === "down") {
      this.relayUp = false;
      this.markDown();
      this.send({ t: "alive" });
      return;
    }
    if (message.t !== "frame") return;
    let data = null;
    try {
      data = JSON.parse(message.data);
    } catch (_) {
      return;
    }
    if (message.event === "snapshot") {
      // A new stream: everything held back is older than this snapshot.
      this.relayUp = true;
      this.cancelJoin();
      this.awaiting = false;
      this.backlog = [];
      this.onSnapshot(data, true);
    } else if (message.event === "msg") {
      if (this.awaiting) this.hold(data);
      else this.onMessage(data);
    } else if (message.event === "ping") {
      this.send({ t: "alive" });
      this.onPing(data);
    }
  }

  hold(msg) {
    this.backlog.push(msg);
    if (this.backlog.length > BACKLOG_MAX) this.join(); // the snapshot never came: ask again
  }

  cancelJoin() {
    this.joinToken += 1;
    this.joinBusy = false;
  }

  // Take a snapshot over HTTP and apply the messages the worker relayed meanwhile.
  async join() {
    this.cancelJoin();
    const token = this.joinToken;
    this.joinBusy = true;
    this.awaiting = true;
    this.backlog = [];
    let snapshot = null;
    try {
      snapshot = await api.get(SNAPSHOT_URL, { timeoutMs: SNAPSHOT_TIMEOUT_MS });
    } catch (_) {
      snapshot = null;
    }
    if (token !== this.joinToken) return; // a newer join, a new stream or a hidden page took over
    this.joinBusy = false;
    if (!snapshot) {
      // The server did not answer although the stream looked alive: have the stream checked.
      // Nothing is applied meanwhile; the poll tries the join again.
      this.markDown();
      this.send({ t: "reopen" });
      return;
    }
    const backlog = this.backlog;
    this.awaiting = false;
    this.backlog = [];
    this.onSnapshot(snapshot, this.relayUp);
    const now = Date.now();
    const out = applyBacklog(this.state, backlog, now);
    this.state = { ...out.state, lastContactMs: now };
    for (const msg of out.applied) this.afterMessage(msg);
    if (out.gap) this.resync();
    else if (out.applied.length) this.schedule();
  }

  // ---- direct mode: an EventSource of our own

  openDirect() {
    this.closeShared();
    this.mode = "direct";
    this.open();
  }

  open() {
    this.closeSource();
    clearTimeout(this.timers.reconnect);
    if (this.paused) return;
    this.lastByteMs = Date.now();
    const source = new EventSource(STREAM_URL);
    this.source = source;
    const guard = (handler) => (event) => {
      if (this.source !== source) return; // a late event from a stream we already replaced
      this.lastByteMs = Date.now();
      handler(JSON.parse(event.data));
    };
    source.addEventListener("snapshot", guard((snapshot) => this.onSnapshot(snapshot, true)));
    source.addEventListener("msg", guard((msg) => this.onMessage(msg)));
    source.addEventListener("ping", guard((ping) => this.onPing(ping)));
    source.onerror = () => {
      if (this.source === source) this.onDrop();
    };
  }

  closeSource() {
    if (!this.source) return;
    this.source.onerror = null;
    this.source.close();
    this.source = null;
  }

  // ---- both modes

  // The page is going away, or into the back/forward cache: let the stream go.
  pause() {
    if (!this.started || this.paused) return;
    this.paused = true;
    this.cancelJoin();
    for (const name of ["reconnect", "resync", "welcome"]) clearTimeout(this.timers[name]);
    this.stopPolling();
    if (this.mode === "shared") {
      this.send({ t: "bye" });
      this.awaiting = true;
      this.backlog = [];
    } else this.closeSource();
    this.setConnected(false); // what the page shows from here on is no longer kept up to date
  }

  // The page came back from the back/forward cache: connect again and take a new snapshot.
  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.attempt = 0;
    this.resyncs = [];
    this.lastByteMs = Date.now();
    if (this.mode === "shared") {
      this.relayUp = false;
      this.hello();
    } else this.open();
  }

  onOnline() {
    if (this.paused) return;
    if (this.mode === "shared") this.send({ t: "reopen" }); // the worker opens one new stream for all tabs
    else this.resync();
  }

  // Shown as disconnected, with the snapshot poll standing in, until a stream delivers again.
  markDown() {
    clearTimeout(this.timers.resync);
    this.setConnected(false);
    if (!this.paused) this.startPolling();
  }

  // The stream failed or went silent: show it, poll, and try again with a short backoff. We
  // reconnect ourselves instead of leaving it to EventSource so that a closed stream (HTTP error)
  // and a stalled one are handled the same way. In shared mode the worker does the reconnecting.
  onDrop() {
    if (this.mode === "shared") {
      this.cancelJoin();
      this.awaiting = true; // nothing is applied until a new snapshot arrives
      this.backlog = [];
      this.markDown();
      this.send({ t: "reopen" });
      return;
    }
    this.closeSource();
    this.markDown();
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    clearTimeout(this.timers.reconnect);
    this.timers.reconnect = setTimeout(() => this.open(), delay);
  }

  checkSilence() {
    if (this.paused || Date.now() - this.lastByteMs <= SILENCE_MS) return;
    if (this.mode === "shared") {
      // The worker says something at least every ten seconds, also while its stream is down.
      // Ask it once (a laptop that slept wakes the tab and the worker in no fixed order); if it
      // does not answer, hello() moves this tab to a stream of its own.
      this.lastByteMs = Date.now();
      this.hello();
    } else if (this.source) this.onDrop();
  }

  /** Take a new snapshot now (gap, ping ahead of us). The banner only shows if it takes long. */
  resync() {
    if (!this.started || this.paused) return;
    // A stream that keeps producing gaps must not turn into a reconnect storm: after a few quick
    // resyncs treat it as a drop, which backs off and shows the banner.
    const now = Date.now();
    this.resyncs = this.resyncs.filter((at) => now - at < RESYNC_WINDOW_MS);
    this.resyncs.push(now);
    if (this.resyncs.length > RESYNC_MAX) {
      this.onDrop();
      return;
    }
    clearTimeout(this.timers.resync);
    this.timers.resync = setTimeout(() => {
      if (this.state.connected) this.onDrop();
    }, RESYNC_GRACE_MS);
    if (this.mode === "shared") this.join();
    else this.open();
  }

  startPolling() {
    if (this.timers.poll) return;
    const poll = async () => {
      if (this.state.connected || this.paused) return;
      // The shared stream is delivering and only this tab is behind: take its snapshot and the
      // messages after it, which also marks the tab connected again.
      if (this.mode === "shared" && this.relayUp) {
        if (!this.joinBusy) this.join();
        return;
      }
      try {
        this.onSnapshot(await api.get(SNAPSHOT_URL, { timeoutMs: POLL_MS }), false);
      } catch (_) {
        // Still unreachable: the banner already says so.
      }
    };
    this.timers.poll = setInterval(poll, POLL_MS);
    poll();
  }

  stopPolling() {
    clearInterval(this.timers.poll);
    this.timers.poll = null;
  }

  setConnected(connected) {
    if (this.state.connected === connected) return;
    this.state = { ...this.state, connected, everConnected: this.state.everConnected || connected };
    this.emit("connection", { connected });
    this.schedule();
  }

  // ------------------------------------------------------------ applying data

  onSnapshot(snapshot, fromStream) {
    if (this.paused) return;
    const now = Date.now();
    const out = applySnapshot(this.state, snapshot, now);
    if (fromStream) {
      clearTimeout(this.timers.resync);
      this.attempt = 0;
      this.stopPolling();
    }
    if (!out.stale) {
      this.state = { ...out.state, lastContactMs: now };
      // A restarted server owns no run: whatever we read from disk before may have changed too.
      if (out.bootChanged) this.loaded.clear();
      for (const id of this.state.runs.keys()) this.loaded.delete(id);
    }
    if (fromStream) this.setConnected(true);
    this.markReady();
    if (!out.stale) {
      this.emit("snapshot", { bootChanged: out.bootChanged, fromStream });
      for (const id of this.jobWatchers.keys()) this.notifyJob(id);
    }
    this.schedule();
  }

  onMessage(msg) {
    const now = Date.now();
    const out = applyMessage(this.state, msg, now);
    if (out.gap) {
      this.resync();
      return;
    }
    if (out.ignored) return;
    this.state = { ...out.state, lastContactMs: now };
    this.afterMessage(msg);
    this.schedule();
  }

  // What a message means for the runs read from disk, then the raw listeners.
  afterMessage(msg) {
    // The runs index changed: disk runs we cached may have new exports or a new state.
    if (msg.kind === "index") for (const entry of this.loaded.values()) entry.stale = true;
    if (msg.kind === "run") this.noteRun(msg);
    this.emit(msg.kind, msg);
    if (msg.kind === "job" && msg.job) this.notifyJob(msg.job.id);
  }

  // A `run` message has no panoramas. For a run this server owns the reducer keeps the tiles; for
  // a run on disk the copy we read keeps its own, takes the new fields at once and is read again
  // by the next loadRun. A deleted run is forgotten.
  noteRun(msg) {
    const entry = this.loaded.get(msg.run_id);
    if (!entry) return;
    if (msg.removed || !msg.run || this.state.runs.has(msg.run_id)) this.loaded.delete(msg.run_id);
    else {
      entry.run = mergeRunFields(entry.run, msg.run, Date.now());
      entry.stale = true;
    }
  }

  onPing(ping) {
    this.state = { ...this.state, lastContactMs: Date.now() };
    if (!this.awaiting && pingGap(this.state, ping)) this.resync();
    this.emit("ping", ping);
  }

  // ------------------------------------------------------------ subscriptions

  /** Call `fn(state)` after any change, at most once per animation frame. Returns an unsubscribe. */
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /**
   * Raw messages as they arrive, not throttled: kinds "pano", "run", "job", "index", "health"
   * (the stream message), "snapshot" ({bootChanged, fromStream}), "connection" ({connected}) and
   * "ping". Returns an unsubscribe.
   */
  on(kind, fn) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, new Set());
    this.listeners.get(kind).add(fn);
    return () => this.listeners.get(kind).delete(fn);
  }

  emit(kind, payload) {
    for (const fn of Array.from(this.listeners.get(kind) || [])) safely(fn, payload);
  }

  // Animation frames do not fire in a hidden tab, and the tab title must still change when a
  // question arrives there: whichever of the frame and the timer comes first does the flush.
  schedule() {
    if (this.flushPending) return;
    this.flushPending = true;
    let frame = null;
    let timer = null;
    const flush = () => {
      if (!this.flushPending) return;
      this.flushPending = false;
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      clearTimeout(timer);
      for (const fn of Array.from(this.subscribers)) safely(fn, this.state);
    };
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(flush);
    timer = setTimeout(flush, 250);
  }

  // ------------------------------------------------------------ reading

  /** The RunState we hold for a run (owned, or loaded from disk with loadRun), or null. */
  run(runId) {
    const owned = this.state.runs.get(runId);
    if (owned) return owned;
    const entry = this.loaded.get(runId);
    return entry ? entry.run : null;
  }

  tile(runId, pid) {
    const run = this.run(runId);
    if (!run) return null;
    return (run.panoramas || []).find((tile) => tile.panorama_id === pid) || null;
  }

  /** Runs that are owned and queued or running (A6): the strip, and the "other active run" warning. */
  activeRuns() {
    return Array.from(this.state.runs.values()).filter((run) => run.active);
  }

  /**
   * The RunState of any run: from the snapshot when this server owns it, else GET /api/runs/<id>
   * (cached until the runs index changes; `{force: true}` refetches).
   */
  async loadRun(runId, { force = false } = {}) {
    await this.ready;
    const owned = this.state.runs.get(runId);
    if (owned) return owned;
    const entry = this.loaded.get(runId);
    if (entry && !entry.stale && !force) return entry.run;
    let run = null;
    try {
      run = stampRun(await api.get(runUrl(runId)), Date.now());
    } catch (err) {
      // The run is gone (deleted here, in another tab or on disk): the copy we held is not it.
      if (err && err.status === 404 && this.loaded.delete(runId)) this.schedule();
      throw err;
    }
    // The stream may have delivered the run while we were waiting for the GET.
    if (this.state.runs.has(runId)) return this.state.runs.get(runId);
    this.loaded.set(runId, { run, stale: false });
    this.schedule();
    return run;
  }

  // ------------------------------------------------------------ clocks (tick locally)

  /** Seconds a panorama has been running, ticking locally while it is active. */
  elapsed(tile) {
    return tileElapsed(tile, Date.now());
  }

  runElapsed(run) {
    return runElapsed(run, Date.now());
  }

  /** Seconds left to answer the pending MCQ of a tile, or null. */
  mcqRemaining(tile) {
    return mcqRemaining(tile, Date.now());
  }

  /** Seconds until the watchdog finalises the run, or null. */
  watchdogRemaining(run) {
    return watchdogRemaining(run, Date.now());
  }

  /** The server's clock, in milliseconds. */
  serverNow() {
    return Date.now() + this.state.serverOffsetMs;
  }

  // ------------------------------------------------------------ writing

  /**
   * Apply a tile returned by a POST at once, without waiting for the stream. A tile whose
   * `last_seq` is lower than the one we hold is ignored (A34). Returns true when it was applied.
   */
  patchTile(tile) {
    if (!tile || !tile.run_id) return false;
    const now = Date.now();
    const out = patchTile(this.state, tile, now);
    if (out.applied) {
      this.state = out.state;
      this.schedule();
      return true;
    }
    const entry = this.loaded.get(tile.run_id);
    if (!entry || this.state.runs.has(tile.run_id)) return false;
    const merged = mergeTile(entry.run, tile, now);
    if (!merged.applied) return false;
    entry.run = merged.run;
    this.schedule();
    return true;
  }

  // ------------------------------------------------------------ jobs

  job(id) {
    return this.state.jobs.get(id) || null;
  }

  notifyJob(id) {
    const job = this.state.jobs.get(id);
    if (!job) return;
    for (const fn of Array.from(this.jobWatchers.get(id) || [])) safely(fn, job);
  }

  /**
   * Follow a background job: `fn(job)` now (when we know it) and on every change. A job that is
   * not on the stream (it finished before we looked) is fetched once. Returns an unsubscribe.
   */
  watchJob(id, fn) {
    if (!this.jobWatchers.has(id)) this.jobWatchers.set(id, new Set());
    const watchers = this.jobWatchers.get(id);
    watchers.add(fn);
    const known = this.state.jobs.get(id);
    if (known) safely(fn, known);
    else {
      api.get("/api/jobs/" + encodeURIComponent(id)).then((job) => {
        if (!watchers.has(fn) || this.state.jobs.has(id)) return;
        const jobs = new Map(this.state.jobs);
        jobs.set(id, job);
        this.state = { ...this.state, jobs };
        safely(fn, job);
        this.schedule();
      }).catch(() => { /* unknown job: the caller keeps what it has */ });
    }
    return () => {
      watchers.delete(fn);
      if (!watchers.size) this.jobWatchers.delete(id);
    };
  }
}

export const store = new Store();
