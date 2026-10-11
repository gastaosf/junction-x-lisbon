import test from "node:test";
import assert from "node:assert/strict";

import {
  CLIENT_QUIET_MS,
  DOWN_REPEAT_MS,
  IDLE_CLOSE_MS,
  RELAY_BACKOFF_MS,
  RELAY_SILENCE_MS,
  RELAY_TICK_MS,
  REOPEN_MIN_MS,
  createRelay,
} from "../../server/static/console/js/logic/relay.js";

// A relay on a hand-wound clock, with a stream whose frames and failures the test produces.
function harness() {
  let nowMs = 1_000_000;
  let nextId = 1;
  const timers = new Map(); // id -> {at, fn, every}
  const sources = [];
  const relay = createRelay({
    openSource(handlers) {
      const source = { handlers, closed: false, close() { this.closed = true; } };
      sources.push(source);
      return source;
    },
    now: () => nowMs,
    setTimer: (fn, ms) => { timers.set(nextId, { at: nowMs + ms, fn, every: null }); return nextId++; },
    clearTimer: (id) => { timers.delete(id); },
    setTicker: (fn, ms) => { timers.set(nextId, { at: nowMs + ms, fn, every: ms }); return nextId++; },
    clearTicker: (id) => { timers.delete(id); },
  });
  const advance = (ms) => {
    const until = nowMs + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      nowMs = timer.at;
      if (timer.every === null) timers.delete(id);
      else timer.at += timer.every;
      timer.fn();
    }
    nowMs = until;
  };
  const port = () => {
    const inbox = [];
    return { inbox, postMessage: (message) => inbox.push(message), take() { return inbox.splice(0); } };
  };
  const open = () => sources.filter((s) => !s.closed);
  const live = () => open()[0];
  return { relay, advance, port, sources, open, live, timers };
}

const snapshot = (seq) => JSON.stringify({ boot_id: "b", seq, runs: [], jobs: [] });

test("the first tab opens the stream; a second tab joins it without a second connection", () => {
  const h = harness();
  const a = h.port();
  h.relay.receive(a, { t: "hello" });
  assert.equal(h.sources.length, 1);
  assert.deepEqual(a.take(), [{ t: "welcome", state: "opening" }]);

  h.live().handlers.onFrame("snapshot", snapshot(7));
  assert.deepEqual(a.take(), [{ t: "frame", event: "snapshot", data: snapshot(7) }]);

  const b = h.port();
  h.relay.receive(b, { t: "hello" });
  assert.equal(h.sources.length, 1, "eight tabs, one connection");
  assert.deepEqual(b.take(), [{ t: "welcome", state: "up" }], "an open stream: this tab reads its snapshot over HTTP");

  h.live().handlers.onFrame("msg", '{"seq":8,"kind":"index"}');
  h.live().handlers.onFrame("ping", '{"seq":8}');
  for (const tab of [a, b]) {
    assert.deepEqual(tab.take().map((m) => m.event), ["msg", "ping"], "every frame reaches every tab, in order");
  }
  assert.deepEqual(h.relay.info(), { clients: 2, state: "up" });
});

test("a dropped stream is announced and reopened with a backoff", () => {
  const h = harness();
  const a = h.port();
  h.relay.receive(a, { t: "hello" });
  h.live().handlers.onFrame("snapshot", snapshot(1));
  a.take();

  h.live().handlers.onError();
  assert.deepEqual(a.take(), [{ t: "down" }]);
  assert.equal(h.open().length, 0);
  assert.equal(h.relay.info().state, "down");

  h.advance(RELAY_BACKOFF_MS[0]);
  assert.equal(h.open().length, 1, "first retry");
  h.live().handlers.onError();
  h.advance(RELAY_BACKOFF_MS[0]);
  assert.equal(h.open().length, 0, "the second retry waits longer");
  h.advance(RELAY_BACKOFF_MS[1] - RELAY_BACKOFF_MS[0]);
  assert.equal(h.open().length, 1);

  h.live().handlers.onFrame("snapshot", snapshot(2));
  assert.equal(a.take().at(-1).event, "snapshot", "the new stream's snapshot goes to every tab");
  h.live().handlers.onError();
  h.advance(RELAY_BACKOFF_MS[0]);
  assert.equal(h.open().length, 1, "a snapshot resets the backoff");
});

test("a late frame or error from a replaced stream is ignored", () => {
  const h = harness();
  const a = h.port();
  h.relay.receive(a, { t: "hello" });
  const first = h.live();
  first.handlers.onFrame("snapshot", snapshot(1));
  first.handlers.onError();
  h.advance(RELAY_BACKOFF_MS[0]);
  a.take();
  first.handlers.onFrame("msg", '{"seq":2}');
  first.handlers.onError();
  assert.deepEqual(a.take(), []);
  assert.equal(h.open().length, 1);
});

test("a silent stream counts as dropped", () => {
  const h = harness();
  const a = h.port();
  h.relay.receive(a, { t: "hello" });
  h.live().handlers.onFrame("snapshot", snapshot(1));
  a.take();
  // The tab keeps answering; the stream says nothing.
  for (let waited = 0; waited < RELAY_SILENCE_MS + RELAY_TICK_MS; waited += RELAY_TICK_MS) {
    h.relay.receive(a, { t: "alive" });
    h.advance(RELAY_TICK_MS);
  }
  assert.ok(a.take().some((m) => m.t === "down"));
});

test("while the stream is down the tabs are told again, so they keep answering and are not dropped", () => {
  const h = harness();
  const a = h.port();
  h.relay.receive(a, { t: "hello" });
  // The server is gone: every attempt fails at once.
  let downs = 0;
  for (let waited = 0; waited < 3 * CLIENT_QUIET_MS; waited += 1000) {
    for (const source of h.open()) source.handlers.onError();
    for (const message of a.take()) {
      if (message.t !== "down") continue;
      downs += 1;
      h.relay.receive(a, { t: "alive" }); // what store.js answers
    }
    h.advance(1000);
  }
  assert.ok(downs >= Math.floor((3 * CLIENT_QUIET_MS) / DOWN_REPEAT_MS) - 1, "a 'down' at least every " + DOWN_REPEAT_MS + " ms");
  assert.equal(h.relay.info().clients, 1, "the tab is still known");
  assert.ok(h.sources.length > 5, "and the relay keeps trying");
});

test("a tab that stops answering is forgotten; when it speaks again it is told to catch up", () => {
  const h = harness();
  const a = h.port();
  const frozen = h.port();
  h.relay.receive(a, { t: "hello" });
  h.relay.receive(frozen, { t: "hello" });
  h.live().handlers.onFrame("snapshot", snapshot(1));
  for (let waited = 0; waited < CLIENT_QUIET_MS + 2 * RELAY_TICK_MS; waited += RELAY_TICK_MS) {
    h.live().handlers.onFrame("ping", '{"seq":1}');
    h.relay.receive(a, { t: "alive" });
    h.advance(RELAY_TICK_MS);
  }
  assert.equal(h.relay.info().clients, 1);
  frozen.take();
  h.live().handlers.onFrame("msg", '{"seq":2}');
  assert.deepEqual(frozen.take(), [], "nothing is queued for a tab that is gone");

  h.relay.receive(frozen, { t: "alive" });
  assert.deepEqual(frozen.take(), [{ t: "welcome", state: "up", rejoin: true }]);
  assert.equal(h.relay.info().clients, 2);
});

test("when the last tab leaves the connection is given back, and a new tab opens a new one", () => {
  const h = harness();
  const a = h.port();
  h.relay.receive(a, { t: "hello" });
  h.live().handlers.onFrame("snapshot", snapshot(1));
  h.relay.receive(a, { t: "bye" });
  assert.equal(h.open().length, 1, "kept for a moment: the next page of the same tab is about to join");
  h.advance(IDLE_CLOSE_MS);
  assert.equal(h.open().length, 0);
  assert.equal(h.timers.size, 0, "nobody listening: no connection and no timer");

  const b = h.port();
  h.relay.receive(b, { t: "hello" });
  assert.equal(h.open().length, 1);
  assert.deepEqual(b.take(), [{ t: "welcome", state: "opening" }]);

  // A page that leaves and the next page that joins within the grace share the stream, whenever
  // the relay's own tick falls.
  h.live().handlers.onFrame("snapshot", snapshot(2));
  h.advance(RELAY_TICK_MS - 1000);
  h.relay.receive(b, { t: "bye" });
  h.advance(IDLE_CLOSE_MS / 2);
  assert.equal(h.open().length, 1, "a tick inside the grace does not close the stream");
  const c = h.port();
  h.relay.receive(c, { t: "hello" });
  h.advance(IDLE_CLOSE_MS);
  assert.equal(h.open().length, 1);
  assert.equal(h.sources.length, 2);
  assert.deepEqual(c.take()[0], { t: "welcome", state: "up" });
});

test("several tabs asking for a new stream at once get one", () => {
  const h = harness();
  const tabs = [h.port(), h.port(), h.port()];
  for (const tab of tabs) h.relay.receive(tab, { t: "hello" });
  h.live().handlers.onFrame("snapshot", snapshot(1));
  h.advance(REOPEN_MIN_MS);
  for (const tab of tabs) h.relay.receive(tab, { t: "reopen" });
  assert.equal(h.sources.length, 2);
  assert.equal(h.open().length, 1);
  h.advance(REOPEN_MIN_MS);
  h.relay.receive(tabs[0], { t: "reopen" });
  assert.equal(h.sources.length, 3);
});

test("a tab whose port cannot be written to is dropped", () => {
  const h = harness();
  const a = h.port();
  const broken = { postMessage() { throw new Error("closed"); } };
  h.relay.receive(a, { t: "hello" });
  h.relay.receive(broken, { t: "hello" });
  h.live().handlers.onFrame("snapshot", snapshot(1));
  assert.equal(h.relay.info().clients, 1);
  assert.equal(a.take().at(-1).event, "snapshot");
});
