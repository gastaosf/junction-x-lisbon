// Data of the panorama focus screen that is fetched rather than streamed: the inspect payload
// (timeline, keyframes, turns, tools, images, ledger, facts) and, for evaluation runs, the truth.
//
// The scrubber and the inspector read the same payload, so it is fetched once: callers that ask
// while a request is in flight share it, and the last answer of each panorama is kept. A forced
// load never returns an answer that was requested before the call was made, which is what a
// caller needs after it has seen a new event.

import { api, ApiError, panoUrl } from "../../api.js";
import { downloadName, truthAllowed } from "../../logic/inspect.js";
import { store } from "../../store.js";

export { keyframeAt } from "../../logic/inspect.js";

const MAX_KEPT = 8; // payloads kept; one is a few hundred kilobytes
// A run that is still going scores each panorama as it is exported, so a truth answer is only
// reused for a short while: long enough for the screen and its inspector to share one request.
const TRUTH_MAX_AGE_MS = 20000;

const inspects = new Map(); // "<run>\n<pid>" -> entry
const truths = new Map(); // "<run>" -> entry

function abortError() {
  const error = new Error("The request was cancelled.");
  error.name = "AbortError";
  return error;
}

function entryOf(cache, key) {
  let entry = cache.get(key);
  if (entry) {
    // re-inserting keeps the most recently used entries at the end
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }
  entry = { loaded: false, value: null, at: 0, flight: null, queued: null };
  cache.set(key, entry);
  for (const [oldKey, old] of cache) {
    if (cache.size <= MAX_KEPT) break;
    if (!old.flight && !old.queued) cache.delete(oldKey);
  }
  return entry;
}

function settle(entry, flight) {
  flight.done = true;
  if (entry.flight === flight) {
    entry.flight = entry.queued;
    entry.queued = null;
  } else if (entry.queued === flight) entry.queued = null;
}

// One request, shared. `after` is a request that must finish first (a forced reload waits for the
// one in flight instead of running beside it).
function startFlight(entry, fetcher, after) {
  const controller = new AbortController();
  const flight = { controller, waiters: 0, done: false, promise: null };
  const run = () => fetcher(controller.signal);
  flight.promise = (after ? after.then(run, run) : run()).then(
    (value) => {
      entry.loaded = true;
      entry.value = value;
      entry.at = Date.now();
      settle(entry, flight);
      return value;
    },
    (error) => {
      settle(entry, flight);
      throw error;
    },
  );
  return flight;
}

// A caller joins a shared request and may leave it with its own signal. The request itself is
// only aborted once every caller has left, and it is then forgotten at once: a screen that is
// remounted asks again in the same tick, and must get a request of its own, not the aborted one.
function join(entry, flight, signal) {
  flight.waiters += 1;
  if (!signal) return flight.promise;
  return new Promise((resolve, reject) => {
    const leave = () => {
      flight.waiters -= 1;
      if (flight.waiters <= 0 && !flight.done) {
        flight.controller.abort();
        settle(entry, flight);
      }
      reject(abortError());
    };
    signal.addEventListener("abort", leave, { once: true });
    flight.promise.then(
      (value) => {
        signal.removeEventListener("abort", leave);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", leave);
        reject(error);
      },
    );
  });
}

function load(cache, key, fetcher, { force = false, signal = null } = {}, maxAgeMs = null) {
  if (signal && signal.aborted) return Promise.reject(abortError());
  const entry = entryOf(cache, key);
  if (!force) {
    const fresh = maxAgeMs === null || Date.now() - entry.at <= maxAgeMs;
    if (entry.loaded && fresh) return Promise.resolve(entry.value);
    if (!entry.flight) entry.flight = startFlight(entry, fetcher, null);
    return join(entry, entry.flight, signal);
  }
  if (!entry.flight) {
    entry.flight = startFlight(entry, fetcher, null);
    return join(entry, entry.flight, signal);
  }
  if (!entry.queued) entry.queued = startFlight(entry, fetcher, entry.flight.promise);
  return join(entry, entry.queued, signal);
}

const inspectKey = (runId, pid) => String(runId) + "\n" + String(pid);

/**
 * The inspect payload of one panorama (`GET /api/runs/<id>/pano/<pid>/inspect`).
 * Without `force` the last answer is returned when there is one. With `force` it is fetched
 * again; pass it after the tile's `last_seq` has moved past `inspect.last_seq`.
 */
export function loadInspect(runId, pid, options = {}) {
  const fetcher = async (signal) => {
    const payload = await api.get(panoUrl(runId, pid, "/inspect"), { signal });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("The server answered the inspector request with something this page cannot read. Reload the page; if it happens again, check the terminal running `cli.py serve`.");
    }
    return payload;
  };
  return load(inspects, inspectKey(runId, pid), fetcher, options);
}

/** The payload loadInspect last resolved with for this panorama, or null. */
export function cachedInspect(runId, pid) {
  const entry = inspects.get(inspectKey(runId, pid));
  return entry && entry.loaded ? entry.value : null;
}

/**
 * Ground truth of an evaluation run (`GET /api/eval/runs/<id>/truth`), or null when it is not
 * available: the server answers 403 for every run that is not an evaluation run with human
 * channels off, and 404 for a run it does not know. A run this page already knows to have human
 * channels on is not asked about at all (UI-SPEC 3: truth never meets a human channel).
 * An answer is reused for 20 seconds; `force` asks again at once.
 */
export function loadTruth(runId, options = {}) {
  if (!truthAllowed(store.run(runId), null)) return Promise.resolve(null);
  const fetcher = async (signal) => {
    try {
      const payload = await api.get("/api/eval/runs/" + encodeURIComponent(runId) + "/truth", { signal });
      return payload && typeof payload === "object" && payload.panoramas && typeof payload.panoramas === "object" ? payload : null;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
  };
  return load(truths, String(runId), fetcher, options, TRUTH_MAX_AGE_MS);
}

/**
 * One of a panorama's files (`GET /api/runs/<id>/pano/<pid>/download?what=export|events|images`)
 * as `{blob, filename}`. Fetched rather than left to a bare link, so a file that does not exist
 * yet is reported on the page with the server's reason instead of as a failed download.
 */
export async function fetchDownload(runId, pid, what, { signal } = {}) {
  let response;
  try {
    response = await fetch(panoUrl(runId, pid, "/download?what=" + encodeURIComponent(what)), {
      headers: { Accept: "application/json, application/x-ndjson, application/zip" },
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (error && error.name === "AbortError") throw error;
    throw new ApiError(0, { message: "Cannot reach the server. Check that `cli.py serve` is still running, then try the download again." });
  }
  if (response.ok) return { blob: await response.blob(), filename: downloadName(runId, pid, what) };
  let detail = null;
  try {
    detail = (await response.json()).detail;
  } catch (_) {
    detail = null; // not JSON: the status alone has to do
  }
  const fields = detail && typeof detail === "object" ? detail : { message: typeof detail === "string" ? detail : null };
  throw new ApiError(response.status, {
    message: fields.message || "The server refused the download (" + response.status + ").",
    detail,
    action: fields.action,
    problems: fields.problems,
    code: fields.code,
  });
}

/** Drop what is kept: one panorama, one run, or everything. */
export function forgetInspect(runId, pid) {
  if (runId === undefined) {
    inspects.clear();
    truths.clear();
    return;
  }
  if (pid !== undefined) {
    inspects.delete(inspectKey(runId, pid));
    return;
  }
  const prefix = String(runId) + "\n";
  for (const key of Array.from(inspects.keys())) {
    if (key.startsWith(prefix)) inspects.delete(key);
  }
  truths.delete(String(runId));
}

// A restarted server may have recovered or rewritten a run's logs: nothing kept from before the
// restart can be trusted. Screens are remounted then and load again.
store.on("snapshot", (info) => {
  if (info && info.bootChanged) forgetInspect();
});
