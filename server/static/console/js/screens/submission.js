// The Submission screen, /runs/:runId/submit (UI-SPEC 5.8): the freeze of the scoring hour as a
// checklist that turns green, the files that get handed in, and the place where an interrupted
// run is recovered.
//
// The server decides what passes (GET /validation); this screen shows its answer, offers the two
// repairs it names (Finalize all, Rebuild exports) and hands out the files. Nothing here reaches
// the agent: every control is a harness control. Ground truth is never loaded on this screen.

import { ApiError, api, errorText, newKey, runUrl } from "../api.js";
import { createMap } from "../components/map.js";
import { confirmDialog, toast } from "../components/shell.js";
import { badge, copyButton, el, icon, replace, statusBadge } from "../dom.js";
import { fmtBytes, fmtClock, fmtCountdown, fmtDuration, fmtInt, fmtMult, fmtUsd, plural } from "../format.js";
import { shortcuts } from "../keyboard.js";
import {
  actionState,
  activeExportJob,
  answerMarkers,
  answerRows,
  answersCsv,
  checkCounts,
  checkWords,
  countsText,
  downloadPlan,
  downloadQuery,
  entriesText,
  exportPlan,
  filesChangedSince,
  finalizePlan,
  forcePlan,
  hourPosition,
  jobView,
  originWords,
  pointText,
  refusalConfirm,
  stampText,
  totalBytes,
  unfinishedTiles,
  verdict,
} from "../logic/submission.js";
import { link, paths, setQuery } from "../router.js";
import { store } from "../store.js";

// How long after a change the checklist is read again. Reading it makes the server parse every
// export and log of the run, so while the agents are still working it is not done on every event.
const SOON_MS = 700;
const SETTLED_MS = 1500;
const WORKING_MS = 15000;
const OFFLINE_MS = 15000; // with the stream down nothing announces a change: look again this often
const BLOB_URL_MS = 60000;

// What this tab last asked a run's exports to carry, so the box keeps its tick across a remount.
const embedChoice = new Map();

const SUMMARY_COLUMNS = [
  { key: "panorama", label: "Panorama" },
  { key: "label", label: "Label" },
  { key: "lat", label: "Lat", right: true },
  { key: "lng", label: "Lng", right: true },
  { key: "multiplier", label: "Multiplier", right: true },
  { key: "turns", label: "Turns", right: true },
  { key: "cost_usd", label: "Cost", right: true },
  { key: "wall_time_s", label: "Wall time", right: true },
  { key: "stop_reason", label: "Stop reason" },
  { key: "origin", label: "Origin" },
  { key: "problems", label: "Problems" },
];

/**
 * A node whose children are rebuilt only when `key` changes, so hover and scroll survive a tick.
 *
 * A rebuild replaces the controls inside. Two things must survive that:
 * - a click in progress: between press and release (mouse, or Space on a button) nothing is
 *   rebuilt, or the click would be swallowed; `rerender` is called once the press is over;
 * - the focus: the control marked with the same `data-focus` as the one that had it gets it back,
 *   at once or as soon as it can take it (a button is disabled while its own action runs, and a
 *   confirmation holds the focus while it is open). `forget()` drops that claim: the screen calls
 *   it when the operator presses somewhere else.
 */
function region(node, rerender) {
  let last = null;
  let wanted = null;
  let pressed = false;
  const hold = (releaseEvents) => {
    if (pressed) return;
    pressed = true;
    const release = () => {
      for (const name of releaseEvents) window.removeEventListener(name, release, true);
      // A timer, so the click this release completes is delivered to the old nodes first.
      setTimeout(() => {
        pressed = false;
        rerender();
      }, 0);
    };
    for (const name of releaseEvents) window.addEventListener(name, release, true);
  };
  node.addEventListener("pointerdown", () => hold(["pointerup", "pointercancel"]));
  node.addEventListener("keydown", (event) => { if (event.key === " ") hold(["keyup", "blur"]); });
  node.addEventListener("focusin", (event) => { wanted = (event.target.dataset && event.target.dataset.focus) || null; });
  node.addEventListener("focusout", (event) => {
    const to = event.relatedTarget;
    // Tabbing to another control gives the focus up; a dialog that opens only borrows it.
    if (to && !node.contains(to) && !to.closest("dialog")) wanted = null;
  });
  return {
    node,
    forget() { wanted = null; },
    set(key, build) {
      if (pressed) return;
      const text = JSON.stringify(key);
      if (text === last) return;
      last = text;
      replace(node, build());
      const active = document.activeElement;
      if (!wanted || (active && active !== document.body)) return;
      const next = Array.from(node.querySelectorAll("[data-focus]")).find((item) => item.dataset.focus === wanted);
      if (next && !next.disabled) next.focus({ preventScroll: true });
    },
  };
}

function paragraphs(lines) {
  return el("div", "stack", lines.map((line) => el("p", null, line)));
}

// `retry` is `{run, label}`: the same request again, or the question that was left unanswered.
function errorNotice(err, retry = null) {
  if (!err) return null;
  return el("div", { class: "notice notice-bad sub-error", role: "alert" },
    icon("alert"),
    el("div", "stack tight grow",
      el("div", "pre", errorText(err)),
      retry ? el("div", "row", el("button", { type: "button", class: "small", dataset: { focus: "retry" }, onclick: retry.run },
        icon("refresh"), retry.label || "Try again")) : null));
}

function labelBadge(label) {
  if (label === "Urban") return badge("Urban", "urban");
  if (label === "non-Urban") return badge("non-Urban", "nonurban");
  return null;
}

function originBadge(origin) {
  const words = originWords(origin);
  return badge(words.text, words.kind, words.icon);
}

function multiplierNode(row) {
  if (row.multiplierRange) {
    const { min, max } = row.multiplierRange;
    return el("span", { class: "mono warn-text", title: "The entries of this list carry different multipliers" },
      fmtMult(min) + " to " + fmtMult(max));
  }
  if (row.multiplier === null || row.multiplier === undefined) return el("span", "dim", "unknown");
  return el("span", "mono" + (row.multiplier < 1 ? " warn-text" : ""), fmtMult(row.multiplier));
}

// A 409 from a GET that returns a file carries the same `{detail: {...}}` body as the JSON API.
async function refusal(response) {
  let detail = null;
  try {
    const body = await response.json();
    detail = body && typeof body === "object" ? body.detail : null;
  } catch (_) {
    detail = null;
  }
  if (detail && typeof detail === "object") {
    return new ApiError(response.status, {
      message: detail.message || detail.code,
      detail,
      action: detail.action ?? null,
      problems: detail.problems ?? null,
      code: detail.code ?? null,
    });
  }
  const message = typeof detail === "string" && detail
    ? detail
    : "The server refused the download (" + response.status + "). Check the checklist, then try again.";
  return new ApiError(response.status, { message, detail });
}

function attachmentName(response, fallback) {
  const header = response.headers.get("Content-Disposition") || "";
  const match = /filename="([^"\\/]+)"/.exec(header);
  return match ? match[1] : fallback;
}

export function mount(container, params, ctx) {
  const runId = params.runId;
  const abort = new AbortController();
  const cleanups = [];
  const blobUrls = new Map(); // object URL -> the timer that revokes it
  let alive = true;

  let fetchedRun = null; // RunState read with GET when the store does not hold the run
  let runError = null;
  let validation = null;
  let validationError = null;
  let checkedAt = null; // ms: when `validation` was read
  let reading = true; // a validation request is in flight
  let inFlight = null;
  let again = false;
  let refreshTimer = null;
  let refreshDue = 0;

  let jobId = null;
  let job = null;
  let offJob = null;
  let jobEnded = null; // the id of the job whose end was already announced
  let busy = null; // the action whose request (or confirmation) is open
  const errors = { finalize: null, export: null, download: null, mark: null };
  const retries = { finalize: null, export: null, mark: null };
  let lastDownload = null; // {name, bytes, at}
  let expanded = ctx.query.get("pano") || null;
  let tickers = []; // functions that refresh a clock in place, once a second
  let map = null;
  let lastRunKey = "";
  let lastTileKey = "";
  let ownDialog = null; // the confirmation this screen has open
  let ownDialogKind = null;

  ctx.setTitle("Submit " + runId);

  const regions = [];
  const area = (node) => {
    const made = region(node, () => render());
    regions.push(made);
    return made;
  };
  // A press anywhere else ends a region's claim on the focus (see region()). Answering a
  // confirmation is not "anywhere else": the focus goes back to the button that opened it.
  const onPress = (event) => {
    if (event.target instanceof Element && event.target.closest("dialog")) return;
    for (const made of regions) if (!made.node.contains(event.target)) made.forget();
  };
  document.addEventListener("pointerdown", onPress, true);

  // ---------------------------------------------------------------- state

  // A `run` message for a run this server does not hold reaches the store without its panoramas,
  // so only an owned run is taken from there; any other is read with GET /api/runs/<id>.
  function heldRun() {
    const held = store.state.runs.get(runId);
    return held && held.owned ? held : null;
  }

  const currentRun = () => heldRun() || fetchedRun;

  function submittedAt() {
    const run = currentRun();
    if (run && run.submitted_at !== undefined) return run.submitted_at || null;
    return (validation && validation.submitted_at) || null;
  }

  function embed() {
    if (embedChoice.has(runId)) return embedChoice.get(runId);
    const run = currentRun();
    return Boolean(run && run.settings && run.settings.embed_images);
  }

  const isInterrupted = () => {
    const run = currentRun();
    return Boolean((validation && validation.interrupted) || (run && run.state === "interrupted"));
  };

  const facts = () => ({
    run: currentRun(),
    validation,
    jobActive: Boolean(job && (job.state === "queued" || job.state === "running")),
    busy: Boolean(busy),
  });

  // The parts of a run this screen draws, small enough to compare on every store update.
  function runKey(run) {
    if (!run) return "none";
    return JSON.stringify([
      run.state, run.active, run.owned, run.external, run.kind, run.preset, run.mode, run.fake_model,
      run.submitted_at, run.settings ? run.settings.embed_images : null, run.watchdog_s,
      (run.panoramas || []).map((tile) => [
        tile.panorama_id, tile.status, tile.special, tile.label, tile.origin,
        tile.penalty ? tile.penalty.multiplier : null, Boolean(tile.final), Boolean(tile.pending_mcq),
      ]),
    ]);
  }

  const tileKey = (run) => JSON.stringify(((run && run.panoramas) || []).map((tile) => [tile.panorama_id, tile.status]));

  // ---------------------------------------------------------------- loading

  async function fetchRun() {
    try {
      const data = await api.get(runUrl(runId), { signal: abort.signal });
      const now = Date.now();
      fetchedRun = { ...data, _at: now, panoramas: (data.panoramas || []).map((tile) => ({ ...tile, _at: now })) };
      runError = null;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      runError = err;
    }
  }

  function refresh() {
    if (!alive) return Promise.resolve();
    if (inFlight) {
      again = true;
      return inFlight;
    }
    clearTimeout(refreshTimer);
    refreshTimer = null;
    reading = true;
    render();
    inFlight = (async () => {
      try {
        const [fresh] = await Promise.all([
          api.get(runUrl(runId, "/validation"), { signal: abort.signal }),
          heldRun() ? null : fetchRun(),
        ]);
        validation = fresh;
        validationError = null;
        checkedAt = Date.now();
      } catch (err) {
        if (err && err.name === "AbortError") return;
        validationError = err;
      } finally {
        inFlight = null;
        reading = false;
        if (alive) {
          render();
          if (again) {
            again = false;
            schedule(SOON_MS);
          }
        }
      }
    })();
    return inFlight;
  }

  function schedule(delay) {
    if (!alive) return;
    const due = Date.now() + delay;
    if (refreshTimer && refreshDue <= due) return;
    clearTimeout(refreshTimer);
    refreshDue = due;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, delay);
  }

  // ---------------------------------------------------------------- jobs

  function attachJob(next) {
    if (!next || jobId === next.id) return;
    if (offJob) offJob();
    jobId = next.id;
    job = next;
    offJob = store.watchJob(next.id, (latest) => {
      if (!alive || jobId !== latest.id) return;
      job = latest;
      if ((latest.state === "done" || latest.state === "failed") && jobEnded !== latest.id) {
        jobEnded = latest.id;
        if (latest.state === "done") toast("The exports of " + runId + " were written. Reading the checklist again.", "ok");
        else toast("The export of " + runId + " failed: " + (latest.error || "no reason was given") + ". Its log is on the Submission screen.", "error");
        refresh();
      }
      render();
    });
  }

  function findJob() {
    const running = activeExportJob(store.state.jobs.values(), runId);
    if (running) attachJob(running);
  }

  function dismissJob() {
    if (offJob) offJob();
    offJob = null;
    jobId = null;
    job = null;
    render();
  }

  // ---------------------------------------------------------------- actions

  // One request of an action. A failure that never reached the server (or a 5xx) can be sent again
  // with the same idempotency key from the notice; a 4xx is the server's answer and stays.
  async function attempt(name, send) {
    busy = name;
    errors[name] = null;
    retries[name] = null;
    render();
    try {
      return await send();
    } catch (err) {
      if (err && err.name === "AbortError") return null;
      errors[name] = err;
      if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) {
        retries[name] = { run: () => { attempt(name, send).then((out) => { if (out) refresh(); }).catch(() => {}); }, label: "Try again" };
      }
      throw err;
    } finally {
      busy = null;
      if (alive) render();
    }
  }

  async function ask(plan, kind = null) {
    busy = busy || "confirm";
    render();
    const asked = confirmDialog({ title: plan.title, body: paragraphs(plan.lines), okLabel: plan.okLabel, tone: plan.tone });
    ownDialog = confirmDialog.current;
    ownDialogKind = kind;
    const ok = await asked;
    ownDialog = null;
    ownDialogKind = null;
    if (busy === "confirm") busy = null;
    if (alive) render();
    return ok && alive;
  }

  async function finalizeAll() {
    if (actionState("finalize_all", facts()).disabled) return;
    const key = newKey(); // made when the confirmation opens; every retry of this action reuses it
    if (!(await ask(finalizePlan(currentRun()), "finalize"))) return;
    try {
      const out = await attempt("finalize", async () => {
        const body = await api.post(runUrl(runId, "/finalize_all"), undefined, { key, signal: abort.signal });
        for (const tile of (body && body.run && body.run.panoramas) || []) store.patchTile(tile);
        return body || {};
      });
      if (out) {
        toast("Every panorama of " + runId + " is final. Reading the checklist again.", "ok");
        refresh();
      }
    } catch (_) {
      // shown next to the button
    }
  }

  async function sendExport(body, key) {
    const out = await api.post(runUrl(runId, "/export"), body, { key, signal: abort.signal });
    if (out && out.job) attachJob(out.job);
    return out || {};
  }

  async function exportRun() {
    if (actionState("rebuild", facts()).disabled) return;
    const interrupted = isInterrupted();
    const plan = exportPlan({ interrupted, unfinished: unfinishedTiles(currentRun()).length, embed: embed() });
    const key = newKey();
    if (plan.confirm && !(await ask(plan))) return;
    const body = { embed_images: embed() };
    try {
      await attempt("export", () => sendExport(body, key));
    } catch (err) {
      await forceExport(err, body);
    }
  }

  // The server refused until the export is forced (contract A36): say what forcing risks, then
  // send it again with the flag. Declining leaves the refusal on screen with a way back here.
  async function forceExport(err, body) {
    const forced = forcePlan(err);
    if (!forced || !alive) return;
    // A forced export is a different request, so it gets a key of its own.
    const forceKey = newKey();
    if (!(await ask(forced))) {
      if (!alive) return;
      retries.export = { run: () => { forceExport(err, body); }, label: forced.okLabel + " (asks first)" };
      render();
      return;
    }
    try {
      await attempt("export", () => sendExport({ ...body, force: true }, forceKey));
    } catch (_) {
      // shown in the export card
    }
  }

  async function patchSubmitted(value) {
    try {
      const out = await attempt("mark", async () => {
        const body = await api.patch(runUrl(runId, "/meta"), { submitted_at: value }, { signal: abort.signal });
        const stored = body && body.run ? body.run.submitted_at ?? null : value;
        if (fetchedRun) fetchedRun = { ...fetchedRun, submitted_at: stored };
        if (validation) validation = { ...validation, submitted_at: stored };
        return body || {};
      });
      if (out) refresh();
    } catch (_) {
      // shown next to the button
    }
  }

  async function markSubmitted() {
    if (actionState("mark", facts()).disabled) return;
    const result = judge(currentRun());
    if (!result.ready) {
      const ok = await ask({
        title: "Mark as submitted although the checklist is not green?",
        lines: [
          result.title + ".",
          "The stamp only records when you handed the files in. It changes nothing in them and can be undone.",
        ],
        okLabel: "Mark as submitted",
        tone: "danger",
      });
      if (!ok) return;
    }
    await patchSubmitted(new Date(store.serverNow()).toISOString());
  }

  async function undoSubmitted() {
    if (busy) return;
    const ok = await ask({
      title: "Remove the submitted stamp?",
      lines: ["The run was marked as submitted at " + stampText(submittedAt()) + ". Removing the stamp forgets that time."],
      okLabel: "Remove the stamp",
      tone: "default",
    });
    if (ok) await patchSubmitted(null);
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = el("a", { href: url, download: name, hidden: true });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    blobUrls.set(url, setTimeout(() => {
      blobUrls.delete(url);
      URL.revokeObjectURL(url);
    }, BLOB_URL_MS));
  }

  async function fetchZip(flags) {
    let response;
    try {
      response = await fetch(runUrl(runId, "/download" + downloadQuery(flags)), {
        credentials: "same-origin", cache: "no-store", signal: abort.signal,
      });
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      throw new ApiError(0, { message: "Cannot reach the server. Check that `cli.py serve` is still running, then try the download again." });
    }
    if (!response.ok) throw await refusal(response);
    const blob = await response.blob();
    return { blob, name: attachmentName(response, runId + "_submission.zip") };
  }

  // The zip is fetched by the page, not followed as a link, so that a refusal (a failing check, a
  // demo run) is shown here with its reason instead of landing in the browser's download list.
  async function downloadZip() {
    if (busy) return;
    busy = "download";
    errors.download = null;
    render();
    try {
      // The question to ask depends on the files as they are now, not as they were a minute ago.
      await refresh();
      if (!alive) return;
      if (validationError) throw validationError;
      const state = actionState("download", { ...facts(), busy: false });
      if (state.disabled) throw new ApiError(409, { message: state.reason });
      const flags = {};
      for (const step of downloadPlan(validation).confirms) {
        if (!(await ask(step))) return;
        flags[step.flag] = true;
      }
      for (;;) {
        try {
          const { blob, name } = await fetchZip(flags);
          if (!alive) return;
          saveBlob(blob, name);
          lastDownload = { name, bytes: blob.size, at: Date.now(), demo: Boolean(flags.fake_ok), forced: Boolean(flags.force) };
          return;
        } catch (err) {
          const step = refusalConfirm(err, flags);
          if (!step) throw err;
          if (!(await ask(step))) return;
          flags[step.flag] = true;
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      errors.download = err;
    } finally {
      busy = null;
      if (alive) render();
    }
  }

  function setExpanded(pid) {
    expanded = pid || null;
    setQuery({ pano: expanded });
    render();
  }

  // ---------------------------------------------------------------- head

  const headBadges = area(el("span", "row wrap sub-head-badges"));
  const head = el("header", "page-head sub-head",
    link(paths.run(runId), { class: "btn ghost small", title: "Back to the dashboard of this run" }, icon("arrow-left"), "Run"),
    el("h1", "page-title", "Submission"),
    el("span", "row tight", el("span", "mono sub-run-id", runId), copyButton(runId, { title: "Copy the run id" })),
    headBadges.node);

  function renderHead(run) {
    headBadges.set([run && [run.state, run.kind, run.mode, run.fake_model, run.external]], () => (run ? [
      statusBadge(run.state),
      run.kind ? badge(run.kind, "dim") : null,
      run.mode ? badge(run.mode, "dim") : null,
      run.fake_model ? badge("demo model", "bad", "alert") : null,
      run.external ? badge("run by another process", "warn", "lock") : null,
    ] : null));
  }

  // ---------------------------------------------------------------- verdict

  const verdictNode = el("section", { class: "card sub-verdict tone-wait", "aria-label": "Verdict" });
  const verdictBody = area(el("div", { class: "sub-verdict-body", role: "status", "aria-live": "polite" }));
  const verdictActions = area(el("div", "sub-verdict-actions stack"));
  verdictNode.append(verdictBody.node, verdictActions.node);

  function judge(run) {
    if (!validation && validationError) {
      return {
        tone: "bad", icon: "x", ready: false, state: "unread",
        title: "The checklist could not be read",
        reasons: [errorText(validationError)],
        next: "Try again. Until it can be read, do not assume the files are valid.",
      };
    }
    if (!validation) {
      return { tone: "wait", icon: "clock", ready: false, state: "reading", title: "Reading the checklist", reasons: [], next: "" };
    }
    if (validationError) {
      return {
        tone: "warn", icon: "alert", ready: false, state: "stale",
        title: "Not confirmed: the checklist could not be read again",
        reasons: [errorText(validationError), "What is shown below is the checklist as it was at " + stampText(checkedAt) + "."],
        next: "Try again before you hand anything in.",
      };
    }
    return verdict(validation, run) || {
      tone: "bad", icon: "x", ready: false, state: "unread",
      title: "The server's answer holds no checklist",
      reasons: ["Without a checklist nothing here can be called valid."],
      next: "Check again, or look at the terminal running the server.",
    };
  }

  function renderVerdict(run) {
    const result = judge(run);
    const stamp = submittedAt();
    const changed = filesChangedSince(validation && validation.files, stamp);
    verdictNode.className = "card sub-verdict tone-" + result.tone;
    verdictBody.set([result, stamp, changed], () => [
      el("div", "sub-verdict-mark", result.state === "reading" ? el("span", "spinner") : icon(result.icon)),
      el("div", "sub-verdict-text stack tight",
        el("h2", "sub-verdict-title", result.title),
        result.reasons.length
          ? el("ul", "sub-verdict-reasons", result.reasons.map((reason) => el("li", "pre", reason)))
          : null,
        result.next ? el("p", "sub-verdict-next", result.next) : null,
        stamp ? el("p", "row wrap sub-stamp", badge("submitted", "ok", "check"),
          el("span", null, "Marked as submitted at ", el("span", "num strong", stampText(stamp)), ".")) : null,
        stamp && changed.length ? el("div", "notice notice-warn", icon("alert"),
          el("span", null, plural(changed.length, "file") + " " + (changed.length === 1 ? "was" : "were") +
            " written again after that stamp: " + changed.join(", ") +
            ". If you already handed the files in, download them again and compare.")) : null),
    ]);

    const download = actionState("download", facts());
    const mark = actionState("mark", facts());
    const stale = result.state === "unread" || result.state === "stale";
    verdictActions.set([result.ready, stale, download, mark, stamp, busy, errors.download && errorText(errors.download),
      errors.mark && errorText(errors.mark), Boolean(retries.mark), lastDownload], () => {
      const anchor = el("a", {
        class: "btn sub-download" + (result.ready ? " primary" : ""),
        dataset: { focus: "download" },
        href: runUrl(runId, "/download"),
        download: runId + "_submission.zip",
        "aria-disabled": download.disabled ? "true" : false,
        title: download.disabled ? download.reason : "The per-panorama JSON files, answers.csv and summary.csv in one zip",
      }, busy === "download" ? el("span", "spinner") : icon("download"), "Download submission zip");
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        if (!download.disabled) downloadZip();
      });
      const markButton = stamp
        ? el("button", { type: "button", dataset: { focus: "mark" }, disabled: Boolean(busy), title: "Remove the stamp. Asks first.", onclick: undoSubmitted },
          icon("x"), "Undo submitted")
        : el("button", { type: "button", dataset: { focus: "mark" }, disabled: mark.disabled,
          title: mark.disabled ? mark.reason : "Record the time you handed the files in", onclick: markSubmitted },
          busy === "mark" ? el("span", "spinner") : icon("flag"), "Mark as submitted");
      const notes = [];
      if (download.disabled && !busy) notes.push(el("p", "dim small", "Download: " + download.reason));
      else if (!result.ready && !stale && !download.disabled) notes.push(el("p", "dim small", "Not ready: the download asks before it packs the files as they are."));
      if (!stamp && mark.disabled && !busy && mark.reason !== download.reason) notes.push(el("p", "dim small", "Mark as submitted: " + mark.reason));
      if (lastDownload) {
        notes.push(el("p", "small row wrap", icon("check"),
          el("span", null, "Downloaded ", el("span", "mono", lastDownload.name), " (" + fmtBytes(lastDownload.bytes) + ") at " +
            stampText(lastDownload.at) + "." + (lastDownload.demo ? " Demo answers: do not hand it in." : "") +
            (lastDownload.forced ? " Packed although checks fail." : ""))));
      }
      return [
        el("div", "row wrap", anchor, markButton),
        notes,
        errorNotice(errors.download),
        errorNotice(errors.mark, retries.mark),
      ];
    });
  }

  // ---------------------------------------------------------------- the run is still going

  const liveCard = area(el("section", { class: "card sub-live", hidden: true, "aria-label": "Run in progress" }));

  // The marker is a bar along the bottom of the current phase (the last one when the hour is
  // over) that fills as the phase passes, so it stays true whatever width the short phases need
  // for their names and never covers them.
  function phaseStrip(position) {
    const marker = el("div", { class: "sub-phase-marker", "aria-hidden": "true" });
    const strip = el("div", { class: "sub-phases", role: "img",
      "aria-label": position.over
        ? "Past the last phase of the hour"
        : "Phase " + (position.index + 1) + " of " + position.segments.length + ": " + position.phase.label },
      position.segments.map((segment, index) => el("div", {
        class: "sub-phase is-" + segment.state,
        style: { flexGrow: String(Math.max(segment.share, 0.001)) },
        title: segment.label + ": minute " + segment.start_min + " to " + segment.end_min,
      },
        el("span", "sub-phase-label clamp-1", segment.state === "current" ? icon("play") : null, segment.label),
        el("span", "sub-phase-min num xsmall", segment.start_min + " to " + segment.end_min),
        index === position.index ? marker : null)));
    return { strip, marker };
  }

  function renderLive(run) {
    const unfinished = unfinishedTiles(run);
    // Also for a run this server holds but is no longer working on: Finalize all is still the
    // repair the checklist offers, and its outcome is shown in this card.
    const working = Boolean(run && (run.owned || run.external) && unfinished.length);
    const going = Boolean(working && (run.active || run.external));
    const position = run ? hourPosition(run, store.serverNow(), submittedAt()) : null;
    liveCard.node.hidden = !working && !position;
    if (!working && !position) {
      tickers = [];
      liveCard.set(["hidden"], () => null);
      return;
    }
    const finalize = actionState("finalize_all", facts());
    const hasWatchdog = going && typeof run.watchdog_remaining_s === "number";
    liveCard.set([
      working, going, run.external, hasWatchdog, position && [position.index, position.over],
      unfinished.map((tile) => [tile.panorama_id, tile.status, tile.special, tile.label, Boolean(tile.pending_mcq)]),
      (run.panoramas || []).length, finalize, busy === "finalize", errors.finalize && errorText(errors.finalize), Boolean(retries.finalize),
    ], () => {
      tickers = [];
      let filling = true;
      const latest = () => currentRun() || run;
      const clocks = [];
      let strip = null;
      if (position) {
        const hour = el("span", "num sub-clock-value");
        const phase = el("span", "sub-clock-value");
        const made = phaseStrip(position);
        strip = made.strip;
        tickers.push(() => {
          const now = hourPosition(latest(), store.serverNow(), submittedAt());
          // Crossing into the next phase changes which segment is marked: build the strip again.
          if (!now || now.index !== position.index || now.over !== position.over) {
            if (!filling) renderLive(latest());
            return;
          }
          hour.textContent = now.over ? "over by " + fmtClock(now.over_s) : fmtClock(now.remaining_s);
          hour.classList.toggle("bad-text", now.over);
          hour.classList.toggle("warn-text", !now.over && now.remaining_s < 300);
          phase.textContent = now.over ? "past the last phase" : now.phase.label + ", " + fmtCountdown(now.phase_remaining_s) + " left";
          made.marker.style.width = (now.phase_fraction * 100).toFixed(2) + "%";
        });
        clocks.push(
          el("div", { class: "sub-clock", title: "Counted from the run's clock start, by the wall clock" },
            el("span", "caps dim", "Left of the hour"), hour),
          el("div", "sub-clock", el("span", "caps dim", "Phase"), phase));
      }
      if (going) {
        const clock = el("span", "num sub-clock-value");
        tickers.push(() => { clock.textContent = fmtClock(store.runElapsed(latest())); });
        clocks.push(el("div", "sub-clock", el("span", "caps dim", "Run clock"), clock));
      }
      if (hasWatchdog) {
        const watchdog = el("span", "num sub-clock-value");
        tickers.push(() => {
          const left = store.watchdogRemaining(latest());
          watchdog.textContent = left === null ? "--:--" : fmtClock(left);
          watchdog.classList.toggle("warn-text", left !== null && left < 300);
        });
        clocks.push(el("div", { class: "sub-clock", title: "When this reaches zero the server finalises every panorama by itself" },
          el("span", "caps dim", "Watchdog finalises all in"), watchdog));
      }
      const rows = unfinished.map((tile) => {
        const elapsed = el("span", "num");
        tickers.push(() => {
          const now = (latest().panoramas || []).find((item) => item.panorama_id === tile.panorama_id) || tile;
          elapsed.textContent = fmtClock(store.elapsed(now));
        });
        return el("tr", null,
          el("td", null, el("span", "row wrap",
            link(paths.pano(runId, tile.panorama_id), { class: "mono" }, tile.panorama_id),
            tile.special ? badge("Special One", "special", "star") : null,
            labelBadge(tile.label))),
          el("td", null, statusBadge(tile.status)),
          el("td", "r", elapsed),
          el("td", null, tile.pending_mcq
            ? link(paths.pano(runId, tile.panorama_id, { open: "mcq" }), null, "A question is waiting for an answer")
            : el("span", "dim", tile.stop_text || "")));
      });
      const title = !working ? "The scoring hour"
        : run.external ? "Another process is running this run"
          : going ? "The run is still going" : "Panoramas without a final answer";
      const nodes = [
        el("div", "row spread wrap",
          el("h2", "card-title sub-card-title", title),
          working ? el("span", "dim num", unfinished.length + " of " + plural((run.panoramas || []).length, "panorama") + " not final") : null),
        clocks.length ? el("div", "sub-clocks", clocks) : null,
        strip,
      ];
      if (working) {
        nodes.push(
          el("div", "table-wrap", el("table", "table compact",
            el("thead", null, el("tr", null,
              el("th", null, "Panorama"), el("th", null, "Status"), el("th", "r", "Elapsed"), el("th", null, "Note"))),
            el("tbody", null, rows))),
          run.external
            ? el("div", "notice notice-info", icon("info"), el("span", null,
              "A command in a terminal, or a second server, is writing this run. This page can only watch. Wait for it to end, then check again."))
            : el("div", "row wrap top",
              el("button", { type: "button", class: "danger", dataset: { focus: "finalize" }, disabled: finalize.disabled,
                title: finalize.disabled ? finalize.reason : "", onclick: finalizeAll },
                busy === "finalize" ? el("span", "spinner") : icon("stop"), "Finalize all"),
              el("p", "dim small grow sub-hint", finalize.disabled
                ? finalize.reason
                : (going ? "Fixes every running panorama at its best list so far" : "Fixes every panorama listed here at its best list so far") +
                  " and writes the files. Asks first; it cannot be undone.")));
      }
      nodes.push(errorNotice(errors.finalize, retries.finalize));
      // Fill the clocks before the nodes are shown, not a second later.
      for (const tick of tickers) tick();
      filling = false;
      return nodes;
    });
  }


  // ---------------------------------------------------------------- recovery and the export job

  const recoveryCard = area(el("section", { class: "card sub-recovery", hidden: true, "aria-label": "Recovery" }));

  function renderRecovery(run) {
    const show = isInterrupted();
    recoveryCard.node.hidden = !show;
    if (!show) {
      recoveryCard.set(["hidden"], () => null);
      return;
    }
    const rebuild = actionState("rebuild", facts());
    const unfinished = unfinishedTiles(run);
    recoveryCard.set([unfinished.map((tile) => tile.panorama_id), rebuild, busy === "export", embed()], () => [
      el("h2", "card-title sub-card-title row", icon("alert"), "This run was interrupted"),
      el("p", null,
        "The server stopped while this run was going (a crash, a kill, or the laptop went to sleep). " +
        (unfinished.length
          ? plural(unfinished.length, "panorama") + " " + (unfinished.length === 1 ? "has" : "have") + " no final answer: "
          : "Its logs were not closed."),
        unfinished.length ? unfinished.map((tile, index) => [index ? ", " : "", link(paths.pano(runId, tile.panorama_id), { class: "mono" }, tile.panorama_id)]) : null,
        unfinished.length ? "." : null),
      el("p", null,
        "Recover and export finishes those logs without calling the model: each panorama's last provisional list becomes " +
        "its final answer, and one with no hypothesis gets the fallback point. Then it writes the files and this page reads the checklist again."),
      el("div", "row wrap top",
        el("button", { type: "button", class: "primary", dataset: { focus: "recover" }, disabled: rebuild.disabled,
          title: rebuild.disabled ? rebuild.reason : "", onclick: exportRun },
          busy === "export" ? el("span", "spinner") : icon("refresh"), "Recover and export"),
        el("p", "dim small grow sub-hint", rebuild.disabled
          ? rebuild.reason
          : "Asks first: it writes into the logs and cannot be undone. Images are " + (embed() ? "embedded" : "not embedded") + " (change this under Files).")),
    ]);
  }

  const jobCard = area(el("section", { class: "card sub-job", hidden: true, "aria-label": "Export job" }));

  function renderJob() {
    const view = jobView(job);
    const failed = errors.export;
    jobCard.node.hidden = !view && !failed;
    jobCard.set([view, failed && errorText(failed), retries.export && retries.export.label], () => {
      if (!view) {
        return failed ? [
          el("h2", "card-title sub-card-title", "The export did not start"),
          errorNotice(failed, retries.export),
        ] : null;
      }
      const state = view.active
        ? badge(view.state === "queued" ? "queued" : "running", "info", "play")
        : view.done ? badge("done", "ok", "check") : badge("failed", "bad", "x");
      const fill = el("div", {
        class: "progress-fill" + (view.done ? " ok" : view.failed ? " bad" : ""),
        style: { width: view.fraction === null ? null : Math.round(view.fraction * 100) + "%" },
      });
      const bar = el("div", {
        class: "progress" + (view.active && view.fraction === null ? " indeterminate" : ""),
        role: "progressbar", "aria-label": "Export progress",
        "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": view.fraction === null ? false : String(Math.round(view.fraction * 100)),
      }, fill);
      if (view.done) fill.style.width = "100%";
      return [
        el("div", "row spread wrap",
          el("h2", "card-title sub-card-title row", view.active ? el("span", "spinner") : null, view.title),
          el("span", "row", state,
            view.active ? null : el("button", { type: "button", class: "small ghost", title: "Hide this card. The files stay as they are.", onclick: dismissJob },
              icon("x"), "Dismiss"))),
        bar,
        view.text ? el("p", "small", view.text) : null,
        view.failed ? el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
          el("span", "pre", "The export failed: " + (view.error || "no reason was given") +
            ". Nothing was handed in. Read the log below, then try Rebuild exports again.")) : null,
        view.done ? el("div", "notice notice-ok", icon("check"), el("span", null,
          "The files were written" + (view.written_at ? " at " + stampText(view.written_at) : "") + ". ",
          view.recovered.length ? "Recovered from their logs: " + view.recovered.join(", ") + "." : null)) : null,
        view.problems.length ? el("div", "notice notice-warn", icon("alert"), el("div", "stack tight",
          el("span", null, "The export reports a problem in " + plural(view.problems.length, "panorama") + ":"),
          el("ul", "sub-items", view.problems.map((item) => el("li", null,
            link(paths.pano(runId, item.panorama_id), { class: "mono" }, item.panorama_id), ": ", item.text))))) : null,
        view.lines.length
          ? el("details", { open: view.active || view.failed }, el("summary", null, "Log (" + plural(view.lines.length, "line") + ")"),
            el("pre", "code-block sub-job-log", view.lines.join("\n")))
          : null,
        errorNotice(failed, retries.export),
      ];
    });
  }

  // ---------------------------------------------------------------- checklist

  const checksCard = area(el("section", { class: "card flush sub-checks-card", "aria-label": "Checklist" }));

  function runAction(action) {
    if (action === "finalize_all") finalizeAll();
    else if (action === "rebuild") exportRun();
  }

  function checkRow(check) {
    const words = checkWords(check, { interrupted: isInterrupted() });
    const state = words.action ? actionState(words.action, facts()) : null;
    const itemQuery = words.id === "no_fallback" ? { open: "ack" } : undefined;
    return el("li", "sub-check is-" + words.status,
      el("div", "sub-check-mark", icon(words.icon)),
      el("div", "sub-check-main stack tight",
        el("div", "row wrap", el("span", "strong sub-check-label", words.label), badge(words.statusText, words.kind, words.icon)),
        words.detail ? el("p", "pre", words.detail) : null,
        words.status !== "pass" && words.why ? el("p", "dim small", words.why) : null,
        words.items.length ? el("ul", "sub-items", words.items.map((item) => el("li", null,
          item.panorama_id ? link(paths.pano(runId, item.panorama_id, itemQuery), { class: "mono" }, item.panorama_id) : null,
          item.panorama_id ? ": " : null, item.text))) : null),
      words.action ? el("div", "sub-check-action stack tight",
        el("button", {
          type: "button", class: "small" + (words.action === "finalize_all" ? " danger" : ""),
          dataset: { focus: "check-" + words.id },
          disabled: state.disabled, title: state.disabled ? state.reason : "",
          onclick: () => runAction(words.action),
        }, icon(words.action === "finalize_all" ? "stop" : "refresh"), words.actionLabel),
        state.disabled ? el("span", "dim xsmall", state.reason) : null) : null);
  }

  function renderChecks() {
    const checks = (validation && validation.checks) || [];
    const counts = checkCounts(checks);
    checksCard.set([checks, reading, checkedAt, validationError && errorText(validationError), facts().jobActive, busy,
      isInterrupted(), tileKey(currentRun())], () => [
      el("div", "card-head",
        el("h2", "card-title", "Checklist"),
        validation ? el("span", "dim num", countsText(counts)) : null,
        el("span", "grow"),
        checkedAt ? el("span", "dim small num", "Read at " + stampText(checkedAt).slice(11)) : null,
        el("button", { type: "button", class: "small", dataset: { focus: "check-again" }, disabled: reading, title: "Read the checklist again (r)", onclick: () => refresh() },
          reading ? el("span", "spinner") : icon("refresh"), reading ? "Reading" : "Check again")),
      validationError ? el("div", "card-body", errorNotice(validationError, { run: () => refresh(), label: "Try again" }),
        validation ? el("p", "dim small sub-stale-note", "Below is the checklist as it was at " + stampText(checkedAt) + ". It may be out of date.") : null) : null,
      !validation && !validationError ? el("div", "empty", el("span", "spinner"), el("span", null, "Reading the exports and logs of this run")) : null,
      validation && !checks.length ? el("div", "empty", el("div", "empty-title", "The server sent no checks"),
        el("span", null, "Without a checklist nothing here can be called valid. Check again, or look at the server's terminal.")) : null,
      checks.length ? el("ol", "sub-checks" + (validationError ? " is-stale" : ""), checks.map(checkRow)) : null,
    ]);
  }

  // ---------------------------------------------------------------- answers

  const answersCard = area(el("div", "sub-answers-body"));
  const mapHost = el("div", "sub-map");
  const mapWrap = el("div", { class: "sub-map-wrap", hidden: true },
    el("div", "sub-map-head row wrap", el("span", "section-title", "Every answer on one map"),
      el("span", "dim small", "Click a marker to see that panorama's ten entries.")),
    mapHost);
  const answersSection = el("section", { class: "card flush sub-answers", "aria-label": "Answers" }, answersCard.node, mapWrap);

  function entryLine(group) {
    const text = pointText(group.lat, group.lng);
    return el("div", "row tight sub-entry",
      el("span", "num dim sub-entry-ranks", group.ranks),
      group.count > 1 ? el("span", "num sub-entry-count", group.count + " x") : null,
      el("span", "mono", text),
      group.key === null ? badge("not a coordinate", "bad", "x") : copyButton(text, { title: "Copy " + text }));
  }

  function answerRow(row) {
    const open = expanded === row.panorama_id;
    const cells = [
      el("td", "top", el("div", "row wrap",
        link(paths.pano(runId, row.panorama_id), { class: "mono" }, row.panorama_id),
        row.special ? badge("Special One", "special", "star") : null,
        labelBadge(row.label),
        row.in_run ? null : badge("not in this run", "warn", "alert"))),
      el("td", "top", el("div", "stack tight",
        el("div", "row wrap",
          el("span", row.count ? "strong" : "bad-text", entriesText(row)),
          row.count && !row.complete ? badge(row.count + " of 10", "bad", "x") : null,
          !row.count ? badge("no rows in answers.csv", "bad", "x") : null),
        row.groups.map(entryLine),
        row.problems ? el("div", "notice notice-bad", icon("alert"), el("span", null, row.problems)) : null)),
      el("td", "r top", multiplierNode(row)),
      el("td", "top", originBadge(row.origin)),
      el("td", "top", row.count ? el("div", "row tight sub-row-actions",
        el("button", {
          type: "button", class: "small ghost", dataset: { focus: "all-" + row.panorama_id }, "aria-expanded": String(open),
          title: open ? "Hide the ten entries" : "Show the ten entries one by one",
          onclick: () => setExpanded(open ? null : row.panorama_id),
        }, icon(open ? "chevron-up" : "chevron-down"), open ? "Hide" : "All 10"),
        copyButton(() => answersCsv(validation && validation.answers, row.panorama_id), { title: "Copy this panorama's rows of answers.csv" })) : null),
    ];
    const nodes = [el("tr", { class: open ? "selected" : null, dataset: { pano: row.panorama_id } }, cells)];
    if (open) {
      nodes.push(el("tr", "sub-expanded", el("td", { colSpan: 5 },
        el("table", "table compact sub-entries",
          el("thead", null, el("tr", null, el("th", "r", "Rank"), el("th", "r", "Lat"), el("th", "r", "Lng"), el("th", null, ""))),
          el("tbody", null, row.entries.map((entry) => {
            const text = pointText(entry.lat, entry.lng);
            return el("tr", null,
              el("td", "r", String(entry.rank)),
              el("td", "r mono", entry.lat === null ? "–" : entry.lat.toFixed(6)),
              el("td", "r mono", entry.lng === null ? "–" : entry.lng.toFixed(6)),
              el("td", null, copyButton(text, { title: "Copy " + text })));
          }))))));
    }
    return nodes;
  }

  function renderMap(rows) {
    const markers = answerMarkers(rows);
    mapWrap.hidden = !markers.length;
    answersSection.classList.toggle("has-map", markers.length > 0);
    if (!markers.length) return;
    if (!map) map = createMap(mapHost, { interactive: true, layer: "street" });
    map.setMarkers(markers, { onClick: (marker) => setExpanded(marker.panorama_id) });
    map.fit();
  }

  let mapKey = "";

  function renderAnswers(run) {
    const rows = validation ? answerRows(validation, run) : [];
    const answers = (validation && validation.answers) || [];
    const hasFile = Boolean(validation && (validation.files || []).some((file) => file.name === "answers.csv"));
    answersCard.set([rows, expanded, hasFile, Boolean(validation), Boolean(validationError)], () => [
      el("div", "card-head",
        el("h2", "card-title", "Answers"),
        validation ? el("span", "dim num", "answers.csv: " + plural(answers.length, "row") + " for " + plural(rows.filter((row) => row.count).length, "panorama")) : null,
        el("span", "grow"),
        answers.length ? el("span", "row tight", el("span", "dim small", "Copy answers.csv"),
          copyButton(() => answersCsv(validation && validation.answers), { title: "Copy the whole of answers.csv" })) : null,
        hasFile ? el("a", { class: "btn small", href: runUrl(runId, "/files/answers.csv"), download: "answers.csv" }, icon("download"), "answers.csv") : null),
      !validation ? el("div", "empty", validationError ? "The answers could not be read. See the checklist above." : [el("span", "spinner"), "Reading answers.csv"]) : null,
      validation && !rows.length ? el("div", "empty",
        el("div", "empty-title", "No answers on disk yet"),
        el("span", null, "answers.csv has no rows for this run. Rebuild the exports to write it.")) : null,
      rows.length ? el("div", "sub-answers-table scroll-x", el("table", "table",
        el("thead", null, el("tr", null,
          el("th", null, "Panorama"), el("th", null, "Entries (rank, lat, lng)"), el("th", "r", "Multiplier"), el("th", null, "Origin"), el("th", null, ""))),
        el("tbody", null, rows.map(answerRow)))) : null,
    ]);
    const key = JSON.stringify(answerMarkers(rows));
    if (key !== mapKey) {
      mapKey = key;
      renderMap(rows);
    }
  }

  // ---------------------------------------------------------------- summary

  const summaryCard = area(el("section", { class: "card flush sub-summary", "aria-label": "Summary" }));

  function summaryCell(column, row) {
    const value = row[column.key];
    const missing = value === null || value === undefined || value === "";
    if (column.key === "panorama") {
      return el("td", null, el("span", "row wrap",
        link(paths.pano(runId, String(value ?? "")), { class: "mono" }, String(value ?? "")),
        row.special ? badge("Special One", "special", "star") : null));
    }
    if (column.key === "label") return el("td", null, labelBadge(value) || el("span", "dim", missing ? "none" : String(value)));
    if (column.key === "origin") return el("td", null, originBadge(value));
    if (column.key === "problems") {
      return el("td", "sub-problems" + (missing ? "" : " has"),
        missing ? el("span", "dim", "none") : el("span", "row top", icon("alert"), el("span", "wrap-any", String(value))));
    }
    if (missing) return el("td", column.right ? "r dim" : "dim", "–");
    if (column.key === "lat" || column.key === "lng") return el("td", "r mono", Number(value).toFixed(6));
    if (column.key === "multiplier") return el("td", "r mono" + (Number(value) < 1 ? " warn-text" : ""), fmtMult(value));
    if (column.key === "turns") return el("td", "r", fmtInt(value));
    if (column.key === "cost_usd") return el("td", "r", fmtUsd(value));
    if (column.key === "wall_time_s") return el("td", "r", fmtDuration(value));
    return el("td", column.right ? "r" : null, String(value));
  }

  function renderSummary() {
    const rows = (validation && validation.summary) || [];
    const hasFile = Boolean(validation && (validation.files || []).some((file) => file.name === "summary.csv"));
    const flagged = rows.filter((row) => row.problems).length;
    summaryCard.set([rows, hasFile, Boolean(validation), Boolean(validationError)], () => [
      el("div", "card-head",
        el("h2", "card-title", "Summary"),
        validation ? el("span", "dim num", "summary.csv: " + plural(rows.length, "row")) : null,
        rows.length ? (flagged
          ? badge(plural(flagged, "row") + " with problems", "bad", "alert")
          : badge("no problems listed", "ok", "check")) : null,
        el("span", "grow"),
        hasFile ? el("a", { class: "btn small", href: runUrl(runId, "/files/summary.csv"), download: "summary.csv" }, icon("download"), "summary.csv") : null),
      !validation ? el("div", "empty", validationError ? "The summary could not be read. See the checklist above." : [el("span", "spinner"), "Reading summary.csv"]) : null,
      validation && !rows.length ? el("div", "empty",
        el("div", "empty-title", "No summary on disk yet"),
        el("span", null, "summary.csv has no rows for this run. Rebuild the exports to write it.")) : null,
      rows.length ? el("div", "scroll-x", el("table", "table compact",
        el("thead", null, el("tr", null, SUMMARY_COLUMNS.map((column) => el("th", column.right ? "r" : null, column.label)))),
        el("tbody", null, rows.map((row) => el("tr", row.problems ? "sub-flagged" : null,
          SUMMARY_COLUMNS.map((column) => summaryCell(column, row))))))) : null,
    ]);
  }

  // ---------------------------------------------------------------- files and rebuild

  const filesCard = area(el("section", { class: "card flush sub-files", "aria-label": "Files" }));

  function renderFiles(run) {
    const files = (validation && validation.files) || [];
    const rebuild = actionState("rebuild", facts());
    const interrupted = isInterrupted();
    const launchedWith = run && run.settings ? Boolean(run.settings.embed_images) : null;
    filesCard.set([files, Boolean(validation), rebuild, embed(), busy === "export", interrupted, launchedWith,
      validationError && !validation], () => [
      el("div", "card-head",
        el("h2", "card-title", "Files"),
        validation ? el("span", "dim num", plural(files.length, "file") + ", " + fmtBytes(totalBytes(files))) : null),
      !validation ? el("div", "empty", validationError ? "The files could not be listed. See the checklist above." : [el("span", "spinner"), "Listing the files"]) : null,
      validation && !files.length ? el("div", "empty",
        el("div", "empty-title", "No export files on disk yet"),
        el("span", null, interrupted
          ? "This run was interrupted before its files were written. Use Recover and export."
          : "Rebuild the exports to write one JSON file per panorama, answers.csv and summary.csv.")) : null,
      files.length ? el("div", "scroll-x", el("table", "table compact",
        el("thead", null, el("tr", null,
          el("th", null, "File"), el("th", "r", "Size"), el("th", null, "Written"), el("th", null, "Path on disk"), el("th", null, ""))),
        el("tbody", null, files.map((file) => el("tr", null,
          el("td", "mono", icon("file"), " ", file.name),
          el("td", "r", fmtBytes(file.size_bytes)),
          el("td", { class: "num nowrap", title: String(file.modified_at || "") }, stampText(file.modified_at)),
          el("td", "sub-path", el("span", "row tight", el("span", "mono small wrap-any dim", file.path), copyButton(String(file.path || ""), { title: "Copy the path" }))),
          el("td", "r", el("a", {
            class: "btn small", href: runUrl(runId, "/files/" + encodeURIComponent(file.name)), download: file.name,
            title: "Download " + file.name,
          }, icon("download"), "Download"))))))) : null,
      el("div", "card-foot sub-rebuild",
        el("div", "stack tight grow",
          el("label", "check",
            el("input", {
              type: "checkbox", dataset: { focus: "embed" }, checked: embed(), disabled: Boolean(busy) || rebuild.disabled,
              onchange: (event) => {
                embedChoice.set(runId, event.target.checked);
                render();
              },
            }),
            el("span", "strong", "Embed images in the exports")),
          el("p", "dim small",
            "Off, each panorama's JSON is about half a megabyte. On, it also carries every image the agent looked at, " +
            "as base64: expect roughly 10 to 20 MB per panorama and a zip of that size. Switch it on only if the organisers ask for it." +
            (launchedWith === null ? "" : " This run was launched with images " + (launchedWith ? "embedded." : "not embedded.")))),
        el("div", "stack tight sub-rebuild-action",
          el("button", { type: "button", dataset: { focus: "rebuild" }, disabled: rebuild.disabled, title: rebuild.disabled ? rebuild.reason : "", onclick: exportRun },
            busy === "export" ? el("span", "spinner") : icon("refresh"), interrupted ? "Recover and export" : "Rebuild exports"),
          el("span", "dim xsmall", rebuild.disabled
            ? rebuild.reason
            : interrupted ? "Finishes the logs first. Asks before it does." : "Writes the files again from the logs. No answer changes."))),
    ]);
  }

  // ---------------------------------------------------------------- page

  const missing = area(el("div", { hidden: true }));
  const runNotice = area(el("div", { hidden: true }));

  // The checklist is read on its own, so the page still works; but the clocks, the list of running
  // panoramas and the order of the tables come from the run's state, and the operator must know
  // when those are missing or old.
  function renderRunNotice(run) {
    // When the checklist cannot be read either, the verdict already says so.
    const show = Boolean(runError && !heldRun() && validation && !validationError);
    runNotice.node.hidden = !show;
    runNotice.set([show && errorText(runError), Boolean(run)], () => (show ? el("div", { class: "notice notice-warn", role: "alert" },
      icon("alert"),
      el("div", "stack tight grow",
        el("div", "pre", (run ? "The state of this run could not be read again: " : "The state of this run could not be read: ") + errorText(runError)),
        el("div", "dim small", run
          ? "The clocks and statuses on this page are as they were at the last read. The checklist is read separately and says when it was read."
          : "The checklist below is read separately and still holds. The run's clocks and its list of running panoramas are not shown."),
        el("div", "row", el("button", { type: "button", class: "small", dataset: { focus: "retry" }, onclick: () => refresh() }, icon("refresh"), "Try again")))) : null));
  }

  const page = el("div", "sub-page stack loose",
    runNotice.node, verdictNode, liveCard.node, recoveryCard.node, jobCard.node, checksCard.node, answersSection, summaryCard.node, filesCard.node);
  container.append(head, missing.node, page);

  function render() {
    if (!alive) return;
    const run = currentRun();
    const gone = [runError, validationError].find((err) => err instanceof ApiError && (err.status === 404 || err.status === 400));
    if (gone && !validation && !run) {
      // Not a run at all: one message instead of a page of empty cards.
      page.hidden = true;
      missing.node.hidden = false;
      missing.set([errorText(gone)], () => el("div", "card screen-error",
        el("h2", "card-title row", icon("question"), "This run cannot be shown"),
        el("p", "pre", errorText(gone)),
        el("div", "row", link(paths.runs(), { class: "btn primary" }, "Go to runs"),
          el("button", { type: "button", onclick: () => refresh() }, icon("refresh"), "Try again"))));
      return;
    }
    page.hidden = false;
    missing.node.hidden = true;
    renderHead(run);
    renderRunNotice(run);
    renderVerdict(run);
    renderLive(run);
    renderRecovery(run);
    renderJob();
    renderChecks();
    renderAnswers(run);
    renderSummary();
    renderFiles(run);
  }

  // ---------------------------------------------------------------- wiring

  function onStore() {
    if (!alive) return;
    const run = currentRun();
    const key = runKey(run);
    if (key === lastRunKey) return;
    lastRunKey = key;
    // The run ended, or another tab finalised it, while the question was still open.
    if (ownDialogKind === "finalize" && ownDialog && confirmDialog.current === ownDialog && run && !unfinishedTiles(run).length) {
      ownDialogKind = null;
      ownDialog.lock("Every panorama is final now. There is nothing left to finalise.");
    }
    render();
  }

  // A panorama that reached its final answer changes the checklist at once; any other event of a
  // run that is still working only makes the files a little older, which can wait.
  function onPano(msg) {
    if (msg.run_id !== runId) return;
    const run = currentRun();
    const key = tileKey(run);
    const changed = key !== lastTileKey;
    lastTileKey = key;
    if (changed) schedule(SOON_MS);
    else schedule(run && run.active ? WORKING_MS : SETTLED_MS);
  }

  cleanups.push(
    store.subscribe(onStore),
    store.on("pano", onPano),
    store.on("run", (msg) => { if (msg.run_id === runId) schedule(SOON_MS); }),
    store.on("index", () => schedule(SETTLED_MS)),
    store.on("job", (msg) => { if (msg.job && msg.job.kind === "export" && msg.job.run_id === runId) findJob(); }),
    store.on("snapshot", () => {
      findJob();
      schedule(SOON_MS);
    }),
    store.on("connection", ({ connected }) => { if (connected) schedule(SOON_MS); }),
    shortcuts.register("Submission", {
      r: { label: "Read the checklist again", run: () => refresh() },
    }),
  );

  const ticker = setInterval(() => {
    for (const tick of tickers) tick();
    // With the stream down no message will say that something changed.
    if (!store.state.connected && !inFlight && checkedAt && Date.now() - checkedAt > OFFLINE_MS) refresh();
  }, 1000);

  render();
  findJob();
  refresh();

  return {
    unmount() {
      alive = false;
      abort.abort();
      document.removeEventListener("pointerdown", onPress, true);
      clearInterval(ticker);
      clearTimeout(refreshTimer);
      for (const off of cleanups) off();
      if (offJob) offJob();
      for (const [url, timer] of blobUrls) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      blobUrls.clear();
      tickers = [];
      if (map) map.destroy();
      map = null;
      // A confirmation of this screen must not outlive it and act on another screen's run.
      if (ownDialog && confirmDialog.current === ownDialog) ownDialog.close();
    },
    onQuery(query) {
      const next = query.get("pano") || null;
      if (next === expanded) return;
      expanded = next;
      render();
    },
  };
}
