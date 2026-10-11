// One event stream for every tab of a browser (UI-SPEC 7: "any number of tabs may be open").
//
// A browser allows six HTTP/1.1 connections to a host, and an event stream holds one for as long
// as its tab lives: with a stream per tab the seventh tab could not even load its scripts. So the
// stream lives in a SharedWorker (stream-worker.js) and this relay hands its frames to every tab.
// The relay keeps no run state: a tab that joins a stream which is already open reads the
// snapshot over HTTP and applies the relayed messages after it (reduce.js `applyBacklog`).
//
// Pure: the stream, the clock and the timers are passed in, so this runs under `node --test`.
//
// A client is anything with `postMessage(message)` (a MessagePort). Messages from a tab:
//   {t: "hello"}    join; answered with {t: "welcome", state}
//   {t: "alive"}    still here (sent in answer to every ping frame and every "down")
//   {t: "bye"}      leaving (page hidden, closed, or kept in the back/forward cache)
//   {t: "reopen"}   this tab thinks the stream is broken: open a new one
// Messages to a tab:
//   {t: "welcome", state: "up" | "opening" | "down", rejoin?}
//   {t: "frame", event: "snapshot" | "msg" | "ping", data: <the frame's JSON text>}
//   {t: "down"}     the stream dropped; repeated every few seconds until it is back

export const RELAY_BACKOFF_MS = [500, 1000, 2000, 3000, 5000];
export const RELAY_SILENCE_MS = 25000; // the server pings every 10 s
export const RELAY_TICK_MS = 5000;
export const CLIENT_QUIET_MS = 45000; // a tab that said nothing for this long is gone (crashed, frozen)
export const DOWN_REPEAT_MS = 10000;
export const IDLE_CLOSE_MS = 4000; // the last tab left: keep the stream this long for the next page
export const REOPEN_MIN_MS = 2000; // several tabs asking at once get one new stream

export function createRelay({
  openSource, // ({onFrame(event, data), onError()}) -> {close()}
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  setTicker = (fn, ms) => setInterval(fn, ms),
  clearTicker = (id) => clearInterval(id),
}) {
  const clients = new Map(); // port -> {heardMs}
  let source = null;
  let up = false; // the open stream has delivered its snapshot
  let attempt = 0;
  let openedMs = 0;
  let lastByteMs = 0;
  let lastDownMs = 0;
  let retryTimer = null;
  let idleTimer = null;
  let ticker = null;

  const post = (port, message) => {
    try {
      port.postMessage(message);
    } catch (_) {
      clients.delete(port); // a port that cannot be written to is a tab that is gone
    }
  };
  const broadcast = (message) => {
    for (const port of Array.from(clients.keys())) post(port, message);
  };
  const state = () => (up ? "up" : source ? "opening" : "down");

  function closeSource() {
    if (!source) return;
    const closing = source;
    source = null;
    up = false;
    closing.close();
  }

  function open() {
    clearTimer(retryTimer);
    retryTimer = null;
    closeSource();
    openedMs = lastByteMs = now();
    let mine = null;
    mine = openSource({
      onFrame: (event, data) => {
        if (source !== mine) return; // a late frame from a stream we already replaced
        lastByteMs = now();
        if (event === "snapshot") {
          up = true;
          attempt = 0;
        }
        broadcast({ t: "frame", event, data });
      },
      onError: () => {
        if (source === mine) dropped();
      },
    });
    source = mine;
  }

  // The stream failed or went silent: tell the tabs, then try again with a short backoff.
  function dropped() {
    closeSource();
    lastDownMs = now();
    broadcast({ t: "down" });
    if (!clients.size) return;
    const delay = RELAY_BACKOFF_MS[Math.min(attempt, RELAY_BACKOFF_MS.length - 1)];
    attempt += 1;
    clearTimer(retryTimer);
    retryTimer = setTimer(open, delay);
  }

  function tick() {
    const at = now();
    for (const [port, client] of Array.from(clients)) {
      if (at - client.heardMs > CLIENT_QUIET_MS) clients.delete(port);
    }
    if (!clients.size) {
      // The last tab said goodbye a moment ago: the grace timer decides. Otherwise the tabs
      // just went quiet, and there is nobody to keep a connection for.
      if (idleTimer === null) rest();
      return;
    }
    if (source && at - lastByteMs > RELAY_SILENCE_MS) {
      dropped();
      return;
    }
    // While the stream is down nothing else reaches the tabs: this keeps them answering, so the
    // ones that are still there are not mistaken for closed ones.
    if (!up && at - lastDownMs >= DOWN_REPEAT_MS) {
      lastDownMs = at;
      broadcast({ t: "down" });
    }
  }

  // Nobody is listening: hold no connection and run no timer.
  function rest() {
    clearTimer(retryTimer);
    clearTimer(idleTimer);
    retryTimer = idleTimer = null;
    if (ticker !== null) clearTicker(ticker);
    ticker = null;
    closeSource();
    attempt = 0;
  }

  function join(port, rejoin) {
    clients.set(port, { heardMs: now() });
    clearTimer(idleTimer);
    idleTimer = null;
    if (ticker === null) ticker = setTicker(tick, RELAY_TICK_MS);
    if (!source && retryTimer === null) open();
    post(port, rejoin ? { t: "welcome", state: state(), rejoin: true } : { t: "welcome", state: state() });
  }

  function leave(port) {
    if (!clients.delete(port) || clients.size) return;
    clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (!clients.size) rest();
    }, IDLE_CLOSE_MS);
  }

  /** One message from a tab. */
  function receive(port, message) {
    const kind = message && message.t;
    if (kind === "bye") {
      leave(port);
      return;
    }
    const known = clients.get(port);
    if (kind === "hello" || !known) {
      // A tab we had given up on (it was frozen for a while) speaks again: it missed frames.
      join(port, kind !== "hello");
      if (kind !== "reopen") return;
    } else known.heardMs = now();
    if (kind === "reopen" && now() - openedMs >= REOPEN_MIN_MS) {
      attempt = 0;
      open();
    }
  }

  return {
    receive,
    /** For tests and the worker's own log: `{clients, state}`. */
    info: () => ({ clients: clients.size, state: state() }),
  };
}
