// HTTP client for the console API (contract section 4).
//
// Calls resolve with the parsed JSON body and reject with an ApiError whose `message` says what
// happened and what to do next, ready to be shown at the control that caused it.
//
// Idempotency (A17): every POST carries an `Idempotency-Key`. By default a fresh one is generated
// per call; a caller that may retry the same action (after a timeout, after a double click) must
// create the key once with newKey() and pass it as `{key}` on every attempt, so the server charges
// a penalty once and returns the first result for the repeats.

export class ApiError extends Error {
  constructor(status, fields = {}) {
    super(fields.message || "request failed (" + status + ")");
    this.name = "ApiError";
    this.status = status; // 0 = the request never reached the server
    this.detail = fields.detail ?? null; // the raw `detail` of the response
    this.action = fields.action ?? null;
    this.problems = fields.problems ?? null;
    this.lint = fields.lint ?? null;
    this.code = fields.code ?? null;
  }
}

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(buffer);
  } else {
    for (let i = 0; i < bytes; i += 1) buffer[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new idempotency key (matches the server's `^[A-Za-z0-9_-]{16,64}$`). */
export function newKey() {
  // randomUUID only exists in secure contexts; LAN access over plain http is not one.
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  return randomHex(16);
}

// FastAPI answers with {"detail": "text"}, {"detail": {message, ...}} or, for a body that failed
// validation, {"detail": [{loc, msg}, ...]}. Turn each into the same fields.
function fieldsFromBody(status, body) {
  const detail = body && typeof body === "object" ? body.detail : null;
  if (typeof detail === "string") return { message: detail, detail };
  if (Array.isArray(detail)) {
    const lines = detail.map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const where = Array.isArray(item.loc) ? item.loc.filter((part) => part !== "body").join(".") : "";
      return (where ? where + ": " : "") + (item.msg || JSON.stringify(item));
    });
    return { message: "The server rejected the request: " + lines.join("; "), detail, problems: lines };
  }
  if (detail && typeof detail === "object") {
    return {
      message: detail.message || detail.code || "request failed (" + status + ")",
      detail,
      action: detail.action ?? null,
      problems: detail.problems ?? null,
      lint: detail.lint ?? null,
      code: detail.code ?? null,
    };
  }
  if (status === 404) return { message: "Not found (404). It may have been deleted, or the server was restarted.", detail };
  if (status >= 500) return { message: "The server failed (" + status + "). Check the terminal running `cli.py serve`, then retry.", detail };
  return { message: "request failed (" + status + ")", detail };
}

function networkError(err, timedOut) {
  const message = timedOut
    ? "The server did not answer in time. Check the connection, then retry; a repeated action is not charged twice."
    : "Cannot reach the server. Check that `cli.py serve` is still running, then retry.";
  const error = new ApiError(0, { message, detail: err ? String(err.message || err) : null });
  error.cause = err;
  return error;
}

async function request(method, url, body, options = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined && body !== null) headers["Content-Type"] = "application/json";
  // POSTs always carry a key unless the caller opts out with {key: false}.
  const wantsKey = options.key === undefined ? method === "POST" : options.key;
  if (wantsKey) headers["Idempotency-Key"] = typeof wantsKey === "string" ? wantsKey : newKey();

  const controller = new AbortController();
  let timedOut = false;
  const timer = options.timeoutMs
    ? setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs)
    : null;
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (err) {
    // A caller that aborted on purpose (screen unmounted) gets the AbortError itself.
    if (err && err.name === "AbortError" && !timedOut) throw err;
    throw networkError(err, timedOut);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null; // an empty or non-JSON body
  }
  if (!response.ok) throw new ApiError(response.status, fieldsFromBody(response.status, data));
  return data;
}

/**
 * Raw upload with progress (XHR, because fetch reports none). The body is sent byte for byte.
 * Method defaults to PUT, as `PUT /api/sets/<id>/files?path=` expects.
 */
function upload(url, blob, { onProgress, signal, method = "PUT" } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.responseType = "text";
    if (onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        onProgress(event.loaded, event.lengthComputable ? event.total : blob.size);
      });
    }
    xhr.addEventListener("load", () => {
      let data = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch (_) {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, fieldsFromBody(xhr.status, data)));
    });
    xhr.addEventListener("error", () => reject(networkError(null, false)));
    xhr.addEventListener("timeout", () => reject(networkError(null, true)));
    xhr.addEventListener("abort", () => {
      const err = new Error("upload aborted");
      err.name = "AbortError";
      reject(err);
    });
    if (signal) {
      if (signal.aborted) xhr.abort();
      else signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(blob);
  });
}

export const api = {
  /** GET. options: {signal, timeoutMs}. */
  get: (url, options) => request("GET", url, undefined, options),
  /** POST. options: {key: true | "<key>" | false, signal, timeoutMs}; a key is sent by default. */
  post: (url, body, options) => request("POST", url, body, options),
  put: (url, body, options) => request("PUT", url, body, options),
  patch: (url, body, options) => request("PATCH", url, body, options),
  del: (url, body, options) => request("DELETE", url, body, options),
  upload,
};

function problemText(problem) {
  if (typeof problem === "string") return problem;
  if (problem && typeof problem === "object") return problem.text || problem.message || JSON.stringify(problem);
  return String(problem);
}

/** One readable message for any thrown value: what happened, what to do, and the problems. */
export function errorText(err) {
  if (!err) return "Unknown error";
  if (!(err instanceof ApiError)) return String(err.message || err);
  const parts = [err.message];
  // `action` is either a sentence for the operator or a machine name such as "rebuild".
  if (typeof err.action === "string" && /\s/.test(err.action)) parts.push(err.action);
  const problems = Array.isArray(err.problems) ? err.problems.map(problemText) : [];
  const unseen = problems.filter((line) => !err.message.includes(line));
  if (unseen.length) parts.push(unseen.map((line) => "• " + line).join("\n"));
  return parts.join("\n");
}

const enc = encodeURIComponent;

function join(base, rest) {
  if (!rest) return base;
  return base + (rest.startsWith("/") || rest.startsWith("?") ? rest : "/" + rest);
}

/** "/api/runs/<id>" + rest, with the id escaped: runUrl(id, "/stop"). */
export function runUrl(runId, rest) {
  return join("/api/runs/" + enc(runId), rest);
}

/** "/api/runs/<id>/pano/<pid>" + rest: panoUrl(id, pid, "/image?w=1024"). */
export function panoUrl(runId, pid, rest) {
  return join("/api/runs/" + enc(runId) + "/pano/" + enc(pid), rest);
}
