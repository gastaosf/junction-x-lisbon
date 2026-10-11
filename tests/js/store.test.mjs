// The store against a fake browser: an EventSource, a SharedWorker, fetch and the page lifecycle
// events are stand-ins, the clock is the test runner's. The reducer itself is in reduce.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";

import { Store } from "../../server/static/console/js/store.js";
import { createRelay } from "../../server/static/console/js/logic/relay.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

function tile(pid, extra = {}) {
  return { run_id: "r1", panorama_id: pid, label: "Urban", special: false, status: "running", active: true, final: null, last_seq: 1, ...extra };
}
const ownedRun = (extra = {}) => ({ run_id: "r1", state: "running", owned: true, active: true, panoramas: [tile("p1"), tile("p2")], ...extra });
const diskRun = (extra = {}) => ({ run_id: "old", state: "finished", owned: false, active: false, submitted_at: null, panoramas: [tile("a", { run_id: "old" }), tile("b", { run_id: "old" })], ...extra });

// One fake browser per test. `server` is what GET requests answer and what streams deliver.
function browser(t, { sharedWorker = false } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const env = {
    server: { boot: "boot-a", seq: 0, runs: [], disk: new Map(), snapshotFails: false },
    sources: [], // every EventSource ever opened, by tabs (direct) or by the worker
    fetched: [],
    listeners: { window: new Map(), document: new Map() },
    workers: 0,
  };
  env.snapshot = () => ({ boot_id: env.server.boot, seq: env.server.seq, server_time: Date.now(), runs: env.server.runs, jobs: [], health: null });
  env.open = () => env.sources.filter((s) => !s.closed);

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.handlers = new Map();
      this.onerror = null;
      env.sources.push(this);
    }
    addEventListener(kind, fn) { this.handlers.set(kind, fn); }
    close() { this.closed = true; }
    emit(kind, data) { if (!this.closed) this.handlers.get(kind)({ data: JSON.stringify(data) }); }
    fail() { if (!this.closed && this.onerror) this.onerror(); }
  }

  // Every stream delivers to its reader: the snapshot first, then messages.
  env.deliverSnapshot = (source = env.open().at(-1)) => source.emit("snapshot", env.snapshot());
  env.publish = (msg) => {
    env.server.seq += 1;
    const full = { seq: env.server.seq, ...msg };
    for (const source of env.open()) source.emit("msg", full);
    return full;
  };
  env.ping = () => { for (const source of env.open()) source.emit("ping", { seq: env.server.seq }); };

  // The worker: the real relay, wired to ports that deliver in a later microtask like the real ones.
  let relay = null;
  class FakeSharedWorker {
    constructor(url, options) {
      env.workers += 1;
      env.workerOptions = options;
      if (!relay) {
        relay = createRelay({
          openSource({ onFrame, onError }) {
            const source = new FakeEventSource("/api/stream");
            for (const kind of ["snapshot", "msg", "ping"]) source.addEventListener(kind, (event) => onFrame(kind, event.data));
            source.onerror = onError;
            return { close() { source.onerror = null; source.close(); } };
          },
        });
        env.relay = relay;
      }
      const tabSide = { onmessage: null, closed: false, start() {}, close() { this.closed = true; } };
      const workerSide = { postMessage: (data) => queueMicrotask(() => { if (!tabSide.closed && tabSide.onmessage) tabSide.onmessage({ data }); }) };
      tabSide.postMessage = (data) => {
        if (env.workerDead) return;
        queueMicrotask(() => relay.receive(workerSide, data));
      };
      this.port = tabSide;
      this.onerror = null;
    }
  }

  const target = (name) => ({
    addEventListener(type, fn) {
      if (!env.listeners[name].has(type)) env.listeners[name].set(type, []);
      env.listeners[name].get(type).push(fn);
    },
  });
  env.fire = (name, type, event = {}) => { for (const fn of env.listeners[name].get(type) || []) fn(event); };

  const saved = {};
  const install = (key, value) => { saved[key] = Object.getOwnPropertyDescriptor(globalThis, key); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  install("window", target("window"));
  install("document", target("document"));
  install("EventSource", FakeEventSource);
  install("SharedWorker", sharedWorker ? FakeSharedWorker : undefined);
  install("fetch", async (url) => {
    env.fetched.push(url);
    const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (url === "/api/snapshot") {
      if (env.server.snapshotFails) throw new TypeError("network");
      return json(200, env.snapshot());
    }
    const match = /^\/api\/runs\/([^/]+)$/.exec(url);
    if (match) {
      const run = env.server.disk.get(decodeURIComponent(match[1]));
      return run ? json(200, run) : json(404, { detail: { message: "No such run.", code: "not_found" } });
    }
    return json(404, { detail: "not found" });
  });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  env.advance = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  return env;
}

// ---------------------------------------------------------------- one stream per tab (fallback)

test("direct mode: snapshot, messages, and the stream is given back on pagehide", async (t) => {
  const env = browser(t);
  env.server.runs = [ownedRun()];
  const store = new Store();
  store.connect();
  assert.equal(store.mode, "direct");
  assert.equal(env.open().length, 1);
  env.deliverSnapshot();
  assert.equal(store.state.connected, true);
  assert.equal(store.run("r1").panoramas.length, 2);

  env.publish({ kind: "pano", run_id: "r1", tile: tile("p1", { status: "done", last_seq: 4 }) });
  assert.equal(store.tile("r1", "p1").status, "done");

  // Left by a full navigation, or kept in the back/forward cache: the connection must be freed.
  env.fire("window", "pagehide", { persisted: true });
  assert.equal(env.open().length, 0, "no EventSource is left open");
  assert.equal(store.state.connected, false);
  await env.advance(60_000);
  assert.equal(env.open().length, 0, "and nothing reopens it while the page is away");
  assert.ok(!env.fetched.includes("/api/snapshot"), "no polling either");

  // A page that was not kept (a fresh load) does not reconnect twice.
  env.fire("window", "pageshow", { persisted: false });
  assert.equal(env.open().length, 0);

  // Back out of the cache: a new stream and a new snapshot.
  env.server.seq = 9;
  env.server.runs = [ownedRun({ state: "finished", active: false })];
  env.fire("window", "pageshow", { persisted: true });
  assert.equal(env.open().length, 1);
  env.deliverSnapshot();
  assert.equal(store.state.connected, true);
  assert.equal(store.state.seq, 9);
  assert.equal(store.run("r1").state, "finished");
  assert.equal(env.sources.length, 2);
});

test("direct mode: a gap takes a new snapshot, a drop polls and reconnects", async (t) => {
  const env = browser(t);
  const store = new Store();
  store.connect();
  env.deliverSnapshot();
  const connection = [];
  store.on("connection", ({ connected }) => connection.push(connected));

  env.open()[0].emit("msg", { seq: 5, kind: "index" });
  assert.equal(env.sources.length, 2, "a hole in the sequence reopens the stream");
  env.server.seq = 5;
  env.deliverSnapshot();
  assert.equal(store.state.seq, 5);
  assert.deepEqual(connection, [], "a quick resync is not shown as a disconnect");

  env.open()[0].fail();
  await settle();
  assert.equal(store.state.connected, false);
  assert.ok(env.fetched.includes("/api/snapshot"), "polling stands in while the stream is down");
  await env.advance(500);
  assert.equal(env.open().length, 1);
  env.deliverSnapshot();
  assert.deepEqual(connection, [false, true]);
});

// ---------------------------------------------------------------- runs on disk

test("a run message about a run on disk does not empty it, and its fields arrive at once", async (t) => {
  const env = browser(t);
  env.server.disk.set("old", diskRun());
  const store = new Store();
  store.connect();
  env.deliverSnapshot();

  const read = await store.loadRun("old");
  assert.equal(read.panoramas.length, 2);
  // The server stamps the run as submitted and tells every tab.
  env.server.disk.set("old", diskRun({ submitted_at: "2026-10-10T10:00:00Z" }));
  env.publish({ kind: "run", run_id: "old", run: { run_id: "old", state: "finished", owned: false, active: false, submitted_at: "2026-10-10T10:00:00Z" } });

  assert.equal(store.state.runs.has("old"), false);
  assert.equal(store.run("old").panoramas.length, 2, "store.run still has the panoramas");
  assert.equal(store.run("old").submitted_at, "2026-10-10T10:00:00Z", "and the new field, without a request");
  const before = env.fetched.length;
  const again = await store.loadRun("old");
  assert.equal(env.fetched.length, before + 1, "loadRun reads it again instead of trusting the message");
  assert.equal(again.panoramas.length, 2);

  // A run the store never read: the message leaves nothing behind, and loadRun fetches.
  env.server.disk.set("other", diskRun({ run_id: "other" }));
  env.publish({ kind: "run", run_id: "other", run: { run_id: "other", state: "finished", owned: false } });
  assert.equal(store.run("other"), null);
  assert.equal((await store.loadRun("other")).panoramas.length, 2);
});

test("a deleted run is forgotten: by a 404 on a forced read, and by its removal message", async (t) => {
  const env = browser(t);
  env.server.disk.set("old", diskRun());
  env.server.disk.set("gone", diskRun({ run_id: "gone" }));
  const store = new Store();
  store.connect();
  env.deliverSnapshot();
  await store.loadRun("old");
  await store.loadRun("gone");

  env.server.disk.delete("old");
  assert.equal(store.run("old").run_id, "old", "still cached until someone looks");
  await assert.rejects(store.loadRun("old", { force: true }), (err) => err.status === 404);
  assert.equal(store.run("old"), null, "a 404 drops the cached copy");
  await assert.rejects(store.loadRun("old"), (err) => err.status === 404);

  env.publish({ kind: "run", run_id: "gone", run: null, removed: true });
  assert.equal(store.run("gone"), null);
});

test("a run that becomes owned replaces the copy read from disk", async (t) => {
  const env = browser(t);
  env.server.disk.set("r1", ownedRun({ owned: false, active: false, state: "interrupted" }));
  const store = new Store();
  store.connect();
  env.deliverSnapshot();
  assert.equal((await store.loadRun("r1")).state, "interrupted");
  env.publish({ kind: "run", run_id: "r1", run: { run_id: "r1", state: "running", owned: true, active: true } });
  env.publish({ kind: "pano", run_id: "r1", tile: tile("p9") });
  assert.equal(store.run("r1").state, "running");
  assert.deepEqual(store.run("r1").panoramas.map((p) => p.panorama_id), ["p9"]);
  assert.equal((await store.loadRun("r1")).owned, true);
});

// ---------------------------------------------------------------- one stream for every tab

test("shared mode: three tabs, one connection, all live and all in step", async (t) => {
  const env = browser(t, { sharedWorker: true });
  env.server.runs = [ownedRun()];
  const first = new Store();
  first.connect();
  await settle();
  assert.equal(first.mode, "shared");
  assert.deepEqual(env.workerOptions, { type: "module", name: "astrolabio-stream-1" });
  assert.equal(env.open().length, 1);
  env.deliverSnapshot();
  await settle();
  assert.equal(first.state.connected, true);

  // Later tabs join the running stream: their snapshot comes over HTTP.
  env.server.seq = 3;
  const second = new Store();
  const third = new Store();
  second.connect();
  third.connect();
  await settle();
  assert.equal(env.open().length, 1, "still one connection");
  assert.equal(env.sources.length, 1);
  assert.equal(env.fetched.filter((u) => u === "/api/snapshot").length, 2);
  for (const store of [second, third]) {
    assert.equal(store.state.connected, true);
    assert.equal(store.state.seq, 3);
  }
  // The first tab was at seq 0: the message with seq 4 is a gap for it, which it repairs alone.
  const seen = [];
  third.on("pano", (msg) => seen.push(msg.seq));
  const done = tile("p2", { status: "done", last_seq: 7 });
  env.server.runs = [ownedRun({ panoramas: [tile("p1"), done] })]; // what a snapshot says from now on
  env.publish({ kind: "pano", run_id: "r1", tile: done });
  await settle();
  for (const store of [first, second, third]) {
    assert.equal(store.state.seq, 4);
    assert.equal(store.tile("r1", "p2").status, "done");
    assert.equal(store.state.connected, true);
  }
  assert.deepEqual(seen, [4]);
  assert.equal(env.sources.length, 1, "repairing one tab's gap does not reopen the shared stream");
});

test("shared mode: messages that arrive while the snapshot is on its way are applied after it", async (t) => {
  const env = browser(t, { sharedWorker: true });
  env.server.runs = [ownedRun()];
  const first = new Store();
  first.connect();
  await settle();
  env.deliverSnapshot();
  await settle();

  // The second tab's GET /api/snapshot answers late: hold it back by hand.
  const realFetch = globalThis.fetch;
  let release = null;
  globalThis.fetch = async (url) => {
    if (url !== "/api/snapshot") return realFetch(url);
    const frozen = env.snapshot(); // taken now, at seq 0
    await new Promise((resolve) => { release = resolve; });
    return { ok: true, status: 200, text: async () => JSON.stringify(frozen) };
  };
  const second = new Store();
  const kinds = [];
  second.on("pano", (msg) => kinds.push("pano " + msg.seq));
  second.on("index", (msg) => kinds.push("index " + msg.seq));
  second.connect();
  await settle();
  env.publish({ kind: "pano", run_id: "r1", tile: tile("p1", { status: "done", last_seq: 3 }) });
  env.publish({ kind: "index" });
  await settle();
  assert.equal(second.state.seq, 0, "nothing is applied before the snapshot");
  assert.deepEqual(kinds, []);
  release();
  await settle();
  assert.equal(second.state.seq, 2);
  assert.equal(second.state.connected, true);
  assert.equal(second.tile("r1", "p1").status, "done");
  assert.deepEqual(kinds, ["pano 1", "index 2"], "listeners hear them once, in order");
  globalThis.fetch = realFetch;
});

test("shared mode: the page leaves and comes back from the back/forward cache", async (t) => {
  const env = browser(t, { sharedWorker: true });
  const store = new Store();
  store.connect();
  await settle();
  env.deliverSnapshot();
  await settle();
  assert.equal(env.relay.info().clients, 1);

  env.fire("window", "pagehide", { persisted: true });
  await settle();
  assert.equal(store.state.connected, false);
  assert.equal(env.relay.info().clients, 0, "the worker is told, so it can give the connection back");
  await env.advance(10_000);
  assert.equal(env.open().length, 0);

  env.server.seq = 12;
  env.fire("window", "pageshow", { persisted: true });
  await settle();
  assert.equal(env.open().length, 1);
  env.deliverSnapshot();
  await settle();
  assert.equal(store.state.connected, true);
  assert.equal(store.state.seq, 12);
});

test("shared mode: a dropped stream shows in every tab and heals in every tab", async (t) => {
  const env = browser(t, { sharedWorker: true });
  const a = new Store();
  const b = new Store();
  a.connect();
  await settle();
  env.deliverSnapshot();
  b.connect();
  await settle();
  assert.equal(b.state.connected, true);

  env.open()[0].fail();
  await settle();
  assert.equal(a.state.connected, false);
  assert.equal(b.state.connected, false);
  assert.ok(env.fetched.filter((u) => u === "/api/snapshot").length >= 2, "each tab polls while it is down");

  env.server.seq = 20;
  await env.advance(500);
  assert.equal(env.open().length, 1, "the worker reconnects once for both");
  env.deliverSnapshot();
  await settle();
  for (const store of [a, b]) {
    assert.equal(store.state.connected, true);
    assert.equal(store.state.seq, 20);
  }
});

test("a worker that does not answer is given up for a stream of the tab's own", async (t) => {
  const env = browser(t, { sharedWorker: true });
  env.workerDead = true;
  const store = new Store();
  store.connect();
  await settle();
  assert.equal(store.mode, "shared");
  assert.equal(env.open().length, 0);
  await env.advance(3000);
  assert.equal(store.mode, "direct");
  assert.equal(env.open().length, 1);
  env.deliverSnapshot();
  assert.equal(store.state.connected, true);
});

test("without SharedWorker, or when it cannot be constructed, the tab opens its own stream", async (t) => {
  const env = browser(t);
  globalThis.SharedWorker = class { constructor() { throw new Error("module workers are not supported"); } };
  const store = new Store();
  store.connect();
  assert.equal(store.mode, "direct");
  assert.equal(env.open().length, 1);
});
