// The run dashboard (UI-SPEC 5.4): every panorama of one run, live, for the whole scoring hour.
//
// The header says what the run is, how its clock stands (against the 60 minutes and the phase
// guide in the scoring preset), when the watchdog finalises everything, and the totals. Below it
// the panoramas in one of three densities: board rows, the tiles of 5.5, or one tile large with
// the others as a side rail.
//
// Everything is read from the store. A run this server does not hold (finished, or interrupted)
// is read once from disk and drawn read-only, with a banner saying what can be done with it.
//
// Rule compliance: nothing on this screen reaches the agent. Finalize all and Stop run are
// harness controls and are confirmed; the three penalised channels live inside the tiles
// (components/controls.js). The clock start is a note on the run, shown here and nowhere else.
//
// Tiles are created once per panorama and never moved in the document: the order on screen is
// the CSS `order` of their cells. Moving a node would drop the focus of a cue being typed and
// the scroll position of a reasoning stream.

import { ApiError, api, errorText, newKey, runUrl } from "../api.js";
import { confirmDialog, toast } from "../components/shell.js";
import { createTile, tileBoardHeader } from "../components/tile.js";
import { badge, el, icon, replace, statusBadge } from "../dom.js";
import { fmtAgo, fmtClock, fmtDuration, fmtTime } from "../format.js";
import { isTyping, shortcuts } from "../keyboard.js";
import { attentionItems, oldestPendingMcq } from "../logic/attention.js";
import {
  DENSITIES,
  clockModel,
  clockStart,
  confirmWords,
  controlReasons,
  controlStates,
  displayOrder,
  focusTarget,
  gridSummary,
  headerTotals,
  isReadOnly,
  orderTiles,
  otherSort,
  parseClockTime,
  parseView,
  phaseStrip,
  runBanner,
  runFacts,
  timeInputValue,
  toggleFocus,
  watchdogModel,
} from "../logic/dashboard.js";
import { prefs } from "../prefs.js";
import { link, navigate, paths, setQuery } from "../router.js";
import { store } from "../store.js";

const TICK_MS = 500;
const HOLD_MS = 3000; // the attention order waits this long after the operator last touched the grid
const ACTION_TIMEOUT_MS = 120000; // Stop waits for the work in flight to unwind and the exports to be written
const META_TIMEOUT_MS = 15000;
const STRAY_CLICK_MS = 500;

const DENSITY_INFO = {
  board: { label: "Board", icon: "list", title: "One row per panorama (1)" },
  tiles: { label: "Tiles", icon: "grid", title: "One tile per panorama (2)" },
  focus: { label: "Focus", icon: "expand", title: "One panorama large, the others as a side rail (3, or f)" },
};

const ACTION_NAME = { stop: "Stop run", finalize_all: "Finalize all" };

let editorCount = 0;

// ---------------------------------------------------------------- small DOM helpers

function setText(node, text) {
  const value = String(text ?? "");
  if (node.textContent !== value) node.textContent = value;
}

function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

function setData(node, name, value) {
  const text = String(value ?? "");
  if (node.dataset[name] !== text) node.dataset[name] = text;
}

function setTitle(node, text) {
  const value = String(text ?? "");
  if (value) {
    if (node.getAttribute("title") !== value) node.setAttribute("title", value);
  } else if (node.hasAttribute("title")) node.removeAttribute("title");
}

// Rebuild the content of `holder` only when `key` changes (badges are small trees, not text).
function swap(holder, key, build) {
  const text = String(key);
  if (holder.dataset.shown === text) return;
  holder.dataset.shown = text;
  replace(holder, build());
}

const tilesOf = (run) => (run && Array.isArray(run.panoramas) ? run.panoramas : []);

const isGone = (err) => err instanceof ApiError && (err.status === 404 || err.status === 400);

// ---------------------------------------------------------------- header parts

function stat(label) {
  const value = el("span", "dash-stat-value num");
  const detail = el("span", "dash-stat-detail small dim");
  const fill = el("div", "progress-fill");
  const meter = el("div", { class: "progress dash-stat-meter", hidden: true, "aria-hidden": "true" }, fill);
  const node = el("div", "dash-stat", el("span", "caps dim", label), value, detail, meter);
  return {
    node,
    update(model) {
      setText(value, model.value);
      setText(detail, model.detail);
      setData(node, "tone", model.tone || "");
      setTitle(node, model.title);
      const share = typeof model.share === "number" ? Math.min(1, Math.max(0, model.share)) : null;
      setHidden(meter, share === null);
      if (share !== null) {
        const width = (share * 100).toFixed(1) + "%";
        if (fill.style.width !== width) fill.style.width = width;
        fill.classList.toggle("warn", model.tone === "warn");
      }
    },
  };
}

function phaseGuide() {
  const node = el("ol", { class: "dash-phases", hidden: true, "aria-label": "Phase guide of the scoring run" });
  let built = "";
  let parts = [];

  function build(strip) {
    parts = strip.phases.map((phase) => {
      const mark = el("span", "dash-phase-mark");
      const left = el("span", "dash-phase-left num");
      const fill = el("span", "dash-phase-fill");
      const item = el("li", { class: "dash-phase", title: phase.title },
        fill,
        el("span", "dash-phase-line", mark, el("span", "dash-phase-label", phase.label)),
        el("span", "dash-phase-line", el("span", "dash-phase-range num", phase.range + " min"), left));
      return { item, mark, left, fill };
    });
    replace(node, parts.map((part) => part.item));
  }

  return {
    node,
    update(strip) {
      setHidden(node, !strip);
      if (!strip) return;
      const key = strip.phases.map((phase) => phase.key + ":" + phase.range).join("|");
      if (key !== built) {
        built = key;
        build(strip);
      }
      node.setAttribute("aria-label", "Phase guide of the scoring run. " + strip.text);
      strip.phases.forEach((phase, index) => {
        const part = parts[index];
        setData(part.item, "state", phase.state);
        if (phase.state === "current") part.item.setAttribute("aria-current", "step");
        else part.item.removeAttribute("aria-current");
        // Never colour alone: a past phase carries a tick, the current one a play mark and its time left.
        swap(part.mark, phase.state, () => (phase.state === "past" ? icon("check") : phase.state === "current" ? icon("play") : null));
        let left = "";
        if (phase.leftS !== null) left = fmtClock(phase.leftS) + " left";
        else if (phase.state === "current") left = "stopped here";
        setText(part.left, left);
        const width = (phase.fraction * 100).toFixed(1) + "%";
        if (part.fill.style.width !== width) part.fill.style.width = width;
      });
    },
  };
}

// ---------------------------------------------------------------- the screen

export function mount(container, params, ctx) {
  const runId = params.runId;
  const abort = new AbortController();
  const cleanup = []; // everything unmount has to undo
  let dead = false;

  let view = parseView(ctx.query, { density: prefs.get("density"), sort: prefs.get("sort") });
  let cameFrom = view.density === "focus" ? "tiles" : view.density; // where `f` goes back to
  let lastGood = null; // the last RunState we held with its panoramas
  let loading = true;
  let loadError = null;
  let refreshError = null;
  let loadToken = 0;
  let gone = false; // the server said this run does not exist (any more)

  let busy = null; // "stop" | "finalize_all" while the request is out
  let actionError = null; // {kind, key, err}: the last run action that failed, for Retry with the same key
  let dialog = null; // the confirm dialog this screen opened, while it is open
  let stoppedHere = false;

  let built = ""; // density + mode the grid was built for
  let listNode = null; // where the cells go (board rows, tiles, or rail rows)
  let mainNode = null; // focus density: where the large tile goes
  const cells = new Map(); // pid -> {pid, wrapper, tile, order}
  let focusCell = null; // {pid, tile}: the large tile of the focus density
  let shownOrder = []; // panorama ids in the order on screen
  let selectedPid = null; // the panorama the operator last touched (target of `c` and `/`)
  let lastTouchMs = 0;
  let warnedMissing = null;

  let editorOpen = false;
  let clockBusy = false;
  let clockError = null;

  ctx.setTitle(runId);

  // ---------------------------------------------------------------- DOM: states

  const statusBox = el("div", "dash-status");
  const head = el("header", "dash-head card");
  const body = el("div", { class: "dash-body", hidden: true });
  const root = el("div", "dash", statusBox, body);
  container.append(root);

  // ---------------------------------------------------------------- DOM: header

  const stateSlot = el("span", "dash-slot");
  const modeSlot = el("span", "dash-slot");
  const kindText = el("span", "dash-kind");
  const modelText = el("span", "dash-model dim");
  const demoMark = badge("DEMO", "warn", "alert");
  demoMark.hidden = true;
  demoMark.title = "This run used the scripted demo model. Its answers are not real and must not be submitted.";

  const finalizeBtn = el("button", { type: "button", onclick: () => askRunAction("finalize_all") }, icon("check"), "Finalize all");
  const stopBtn = el("button", { type: "button", class: "danger", onclick: () => askRunAction("stop") }, icon("stop"), "Stop run");
  const addBtn = el("button", { type: "button", onclick: () => navigate(paths.newRun({ run: runId })) }, icon("plus"), "Add panoramas");
  const submitLink = link(paths.submit(runId), { class: "btn", title: "Validate, freeze and download the submission (g s)" },
    icon("download"), "Submission");
  const stageLink = link(paths.stage(runId), { class: "btn", title: "The view for an audience: no controls, large type" },
    icon("eye"), "Stage view");
  const busyNote = el("span", { class: "dash-busy dim small", hidden: true, role: "status" });
  const reasonList = el("ul", { class: "dash-reasons small dim", hidden: true });
  const actionText = el("span", "pre");
  const actionRetry = el("button", { type: "button", class: "small", onclick: () => retryRunAction() }, icon("refresh"), "Retry (same request)");
  const actionNote = el("div", { class: "notice notice-bad dash-action-error", hidden: true, role: "alert" },
    icon("alert"),
    el("div", "dash-notice-body", actionText,
      el("span", "row tight", actionRetry,
        el("button", { type: "button", class: "small ghost", onclick: () => { actionError = null; render(); } }, "Dismiss"))));

  const stats = {
    progress: stat("Panoramas"),
    spend: stat("Spend"),
    proxy: stat("Agent's own belief"),
    penalties: stat("Penalties used"),
  };

  head.append(
    el("div", "dash-top",
      el("div", "dash-title",
        link(paths.runs(), { class: "btn ghost small", title: "Back to the list of runs" }, icon("arrow-left"), "Runs"),
        el("h1", "page-title dash-run-id mono", runId),
        stateSlot, kindText, modeSlot, demoMark, modelText),
      el("div", "dash-controls",
        el("div", { class: "dash-control-row", role: "group", "aria-label": "Run controls" },
          busyNote, finalizeBtn, stopBtn, addBtn, submitLink, stageLink),
        reasonList)),
    actionNote,
    el("div", "dash-stats", stats.progress.node, stats.spend.node, stats.proxy.node, stats.penalties.node));

  // ---------------------------------------------------------------- DOM: clock strip

  const clockValue = el("span", "dash-clock-value num");
  const clockDetail = el("span", "dash-clock-detail num");
  const editorId = "dash-clock-editor-" + (editorCount += 1);
  const clockButton = el("button", {
    type: "button", class: "small ghost dash-clock-set", "aria-expanded": "false", "aria-controls": editorId,
    title: "Set where the run clock starts (the hand-over time). Display only.",
    onclick: () => toggleEditor(),
  }, icon("clock"), "Set clock");
  const clockInfo = el("p", "dash-editor-info");
  const nowBtn = el("button", { type: "button", onclick: () => saveClock(new Date(store.serverNow()).toISOString()) },
    icon("play"), "Start the clock now");
  const timeInput = el("input", { type: "time", step: "1", class: "num dash-editor-time", id: editorId + "-time" });
  const timeHint = el("span", "field-help");
  const setBtn = el("button", { type: "submit" }, "Set");
  const resetBtn = el("button", { type: "button", class: "ghost", onclick: () => saveClock(null) }, icon("refresh"), "Reset to the launch time");
  const clockErrorNote = el("div", { class: "notice notice-bad small pre", hidden: true, role: "alert" });
  const timeForm = el("form", { class: "dash-editor-form" },
    el("label", { class: "field", for: editorId + "-time" }, el("span", "field-label", "Hand-over time (local time of this computer)")),
    el("div", "row tight", timeInput, setBtn),
    timeHint);
  const editor = el("div", { class: "dash-clock-editor panel", id: editorId, hidden: true, role: "group", "aria-label": "Run clock start" },
    clockInfo,
    el("div", "row wrap", nowBtn, resetBtn),
    timeForm,
    clockErrorNote,
    el("p", "field-help dash-editor-note",
      "Display only: deadlines, the watchdog and what the agent is told do not change."),
    el("div", "row", el("button", { type: "button", class: "small ghost", onclick: () => closeEditor(true) }, "Close")));
  const clockBox = el("div", "dash-clock",
    el("span", "caps dim", "Run clock"), clockValue, clockDetail, clockButton, editor);

  const guide = phaseGuide();
  const dogText = el("span", "num");
  const dog = el("div", { class: "dash-watchdog", hidden: true }, icon("clock"), dogText);
  const strip = el("div", "dash-strip", clockBox, dog, guide.node);

  timeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const parsed = parseClockTime(timeInput.value, Date.now());
    if (!parsed) {
      clockError = "Enter the time as hours and minutes, for example 10:00.";
      renderEditor(currentRun());
      timeInput.focus();
      return;
    }
    saveClock(parsed.iso);
  });
  timeInput.addEventListener("input", () => {
    clockError = null;
    renderEditor(currentRun());
  });
  editor.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeEditor(true);
  });

  // ---------------------------------------------------------------- DOM: notices, toolbar, grid

  const lostText = el("span");
  const lostNote = el("div", { class: "notice notice-warn dash-lost", hidden: true, role: "status" }, icon("wifi-off"), lostText);
  const refreshText = el("span", "pre");
  const refreshNote = el("div", { class: "notice notice-warn dash-refresh", hidden: true, role: "status" },
    icon("alert"),
    el("div", "dash-notice-body", refreshText,
      el("button", { type: "button", class: "small", onclick: () => load({ force: true }) }, icon("refresh"), "Read it again")));
  const bannerSlot = el("div", "dash-banner-slot");

  const densityButtons = new Map();
  const densityGroup = el("div", { class: "btn-group", role: "group", "aria-label": "Density" });
  for (const name of DENSITIES) {
    const info = DENSITY_INFO[name];
    const button = el("button", { type: "button", title: info.title, "aria-pressed": "false", onclick: () => setDensity(name) },
      icon(info.icon), info.label);
    densityButtons.set(name, button);
    densityGroup.append(button);
  }
  const sortButton = el("button", {
    type: "button", "aria-pressed": "false",
    title: "Panoramas with something in the inbox first, most urgent first; then by what a review could still gain (a)",
    onclick: () => setSort(otherSort(view.sort)),
  }, icon("bell"), "Needs attention first");
  const summary = el("span", "dash-summary dim");
  const heldNote = el("span", { class: "dash-held small dim", hidden: true, role: "status" },
    icon("pause"), "Order held while you work in a tile");
  const toolbar = el("div", "dash-toolbar", densityGroup, sortButton, summary, el("span", "grow"), heldNote);

  const gridBox = el("div", "dash-grid-box");
  const emptyNote = el("div", { class: "card dash-empty", hidden: true });

  body.append(head, strip, lostNote, refreshNote, bannerSlot, toolbar, emptyNote, gridBox);

  // The rail of the focus density sticks under the shell and the clock strip.
  const publishStripHeight = () => root.style.setProperty("--dash-strip-h", strip.offsetHeight + "px");
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(publishStripHeight);
    observer.observe(strip);
    cleanup.push(() => observer.disconnect());
  }

  const touch = () => { lastTouchMs = Date.now(); };
  for (const type of ["pointermove", "pointerdown", "keydown", "wheel"]) gridBox.addEventListener(type, touch, { passive: true });

  // ---------------------------------------------------------------- state

  function currentRun() {
    let held = store.run(runId);
    // The store keeps a run it once read from disk; after a 404 that copy is of a deleted run.
    if (gone && held && !held.owned) held = null;
    if (held && tilesOf(held).length) {
      lastGood = held;
      return held;
    }
    // A `run` message for a run the server does not hold in memory (its clock was set, its
    // exports were rebuilt) arrives without tiles and the store keeps it that way: lay the newer
    // run fields over the tiles we read from disk.
    if (held && !held.owned && lastGood) return { ...lastGood, ...held, panoramas: lastGood.panoramas };
    return held || lastGood;
  }

  function adopt(run) {
    if (!run || !tilesOf(run).length) return;
    const held = store.state.runs.get(runId);
    if (held && tilesOf(held).length) return; // the stream is the fresher source for a run it carries
    lastGood = { ...run, _at: Date.now() };
  }

  function load({ force = false } = {}) {
    loadToken += 1;
    const token = loadToken;
    loading = !currentRun();
    if (loading) renderStatus();
    store.loadRun(runId, { force }).then((run) => {
      // See currentRun(): the store may answer with a run that has lost its tiles.
      if (run && !run.owned && !tilesOf(run).length) return api.get(runUrl(runId), { signal: abort.signal });
      return run;
    }).then((run) => {
      if (dead || token !== loadToken) return;
      loading = false;
      loadError = null;
      refreshError = null;
      gone = false;
      if (run && (tilesOf(run).length || !lastGood)) lastGood = run._at ? run : { ...run, _at: Date.now() };
      render();
    }).catch((err) => {
      if (dead || token !== loadToken || (err && err.name === "AbortError")) return;
      loading = false;
      if (isGone(err)) {
        // Deleted while we were looking at it: what is on screen no longer exists.
        gone = true;
        lastGood = null;
        loadError = err;
      } else if (currentRun()) refreshError = err; // a failed refresh must not take down what is shown
      else loadError = err;
      render();
    });
  }

  // ---------------------------------------------------------------- view changes

  function setDensity(next) {
    if (!DENSITIES.includes(next) || next === view.density) return;
    if (view.density !== "focus") cameFrom = view.density;
    const changes = { density: next };
    // Into focus: the panorama the operator was working on, when there is one.
    if (next === "focus" && selectedPid && cells.has(selectedPid)) {
      view = { ...view, pano: selectedPid };
      changes.pano = selectedPid;
    }
    view = { ...view, density: next };
    prefs.set("density", next);
    setQuery(changes);
    render();
  }

  function setSort(next) {
    if (next === view.sort) return;
    view = { ...view, sort: next };
    prefs.set("sort", next);
    setQuery({ sort: next });
    lastTouchMs = 0; // the operator asked for the new order: show it now
    render();
  }

  function choosePano(pid) {
    if (!pid || pid === view.pano) return;
    view = { ...view, pano: pid };
    setQuery({ pano: pid });
    render();
  }

  // ---------------------------------------------------------------- run actions

  async function askRunAction(kind) {
    const run = currentRun();
    if (!run || busy || dialog) return;
    const states = controlStates(run, { stopped: stoppedHere });
    if (!(kind === "stop" ? states.stop : states.finalizeAll).enabled) return;
    const words = confirmWords(kind, run, { connected: store.state.connected });
    // One key per confirmation: a retry after a timeout repeats the same request (A17).
    const key = newKey();
    const asked = confirmDialog({
      title: words.title,
      body: el("div", "stack dash-confirm", words.lines.map((line) => el("p", null, line))),
      okLabel: words.okLabel,
      cancelLabel: words.cancelLabel,
      tone: "danger",
      lockMessage: "This run has ended in the meantime, so there is nothing left to do here. Nothing was sent.",
    });
    dialog = { kind, handle: confirmDialog.current, locked: false };
    const mine = dialog;
    const confirmed = await asked;
    if (dialog === mine) dialog = null;
    if (!confirmed || dead) return;
    swallowClicks();
    sendRunAction(kind, key);
  }

  // The second click of a double click on the confirm button arrives after the dialog has gone,
  // on whatever lies under it: a board row (which would leave this screen) or a tile control.
  function swallowClicks() {
    const stop = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    document.addEventListener("click", stop, true);
    setTimeout(() => document.removeEventListener("click", stop, true), STRAY_CLICK_MS);
  }

  // Not tied to this screen's abort signal: once confirmed, the action runs to its end on the
  // server whether or not the operator stays here, and its outcome is reported either way.
  async function sendRunAction(kind, key) {
    if (busy) return;
    busy = kind;
    actionError = null;
    render();
    try {
      const data = await api.post(runUrl(runId, kind === "stop" ? "/stop" : "/finalize_all"), undefined,
        { key, timeoutMs: ACTION_TIMEOUT_MS });
      if (kind === "stop") stoppedHere = true;
      if (!dead) adopt(data && data.run);
      toast(kind === "stop"
        ? "Run " + runId + " stopped. Every panorama is final and the exports are written."
        : "Every panorama of " + runId + " is final. The exports are written.", "ok");
    } catch (err) {
      if (dead) toast(ACTION_NAME[kind] + " on run " + runId + " did not go through. " + errorText(err), "error");
      else actionError = { kind, key, err };
    } finally {
      busy = null;
      if (!dead) render();
    }
  }

  function retryRunAction() {
    if (actionError) sendRunAction(actionError.kind, actionError.key);
  }

  // ---------------------------------------------------------------- clock editor

  function onOutsidePress(event) {
    if (!clockBox.contains(event.target)) closeEditor(false);
  }

  function toggleEditor() {
    if (editorOpen) closeEditor(true);
    else openEditor();
  }

  function openEditor() {
    if (editorOpen) return;
    editorOpen = true;
    clockError = null;
    const run = currentRun();
    timeInput.value = timeInputValue(run && run.clock_started_at);
    document.addEventListener("pointerdown", onOutsidePress, true);
    renderEditor(run);
    nowBtn.focus();
  }

  function closeEditor(refocus) {
    if (!editorOpen) return;
    editorOpen = false;
    document.removeEventListener("pointerdown", onOutsidePress, true);
    renderEditor(currentRun());
    if (refocus) clockButton.focus();
  }

  async function saveClock(iso) {
    if (clockBusy) return;
    clockBusy = true;
    clockError = null;
    renderEditor(currentRun());
    try {
      const data = await api.patch(runUrl(runId, "/meta"), { clock_started_at: iso }, { timeoutMs: META_TIMEOUT_MS, signal: abort.signal });
      if (dead) return;
      adopt(data && data.run);
      clockBusy = false;
      closeEditor(true);
      toast(iso ? "Run clock now counts from " + fmtTime(iso) + "." : "Run clock reset to the launch time.", "ok");
      render();
    } catch (err) {
      if (dead || (err && err.name === "AbortError")) return;
      clockBusy = false;
      clockError = "The clock was not changed. " + errorText(err);
      renderEditor(currentRun());
    }
  }

  function renderEditor(run) {
    setHidden(editor, !editorOpen);
    clockButton.setAttribute("aria-expanded", String(editorOpen));
    if (!editorOpen) return;
    const start = clockStart(run);
    setText(clockInfo, start.text);
    nowBtn.disabled = clockBusy;
    setBtn.disabled = clockBusy;
    timeInput.disabled = clockBusy;
    resetBtn.disabled = clockBusy || !start.custom;
    setTitle(resetBtn, start.custom ? "" : "The clock already counts from the launch time.");
    const parsed = parseClockTime(timeInput.value, Date.now());
    let hint = "";
    if (parsed) {
      const away = Math.abs(Date.now() - parsed.ms) / 1000;
      hint = parsed.future
        ? "That is in " + fmtDuration(Math.round(away)) + ": the clock stays at 00:00 until then."
        : "That was " + fmtDuration(Math.round(away)) + " ago.";
    }
    setText(timeHint, hint);
    setHidden(clockErrorNote, !clockError);
    setText(clockErrorNote, clockError || "");
  }

  // ---------------------------------------------------------------- rendering: states

  function stateCard(iconName, title, lines, ...actions) {
    return el("div", "card screen-error",
      el("h2", "card-title row", icon(iconName), title),
      lines.map((line) => el("p", typeof line === "string" ? null : "pre", typeof line === "string" ? line : line.pre)),
      el("div", "row wrap", actions));
  }

  function renderStatus() {
    setHidden(body, true);
    setHidden(statusBox, false);
    const back = link(paths.runs(), { class: "btn" }, icon("arrow-left"), "Back to Runs");
    const again = el("button", { type: "button", class: "primary", onclick: () => load({ force: true }) }, icon("refresh"), "Try again");
    let key;
    let build;
    if (loadError && isGone(loadError)) {
      key = "gone";
      build = () => stateCard("question", "No run named " + runId, [
        "No run with this id is on disk or running in this server. It may have been deleted, or the link may be wrong.",
        "The Runs screen lists every run there is.",
      ], link(paths.runs(), { class: "btn primary" }, icon("arrow-left"), "Back to Runs"), el("button", { type: "button", onclick: () => load({ force: true }) }, icon("refresh"), "Look again"));
    } else if (loadError) {
      key = "error:" + errorText(loadError);
      build = () => stateCard("alert", "Run " + runId + " could not be loaded", [
        { pre: errorText(loadError) },
        loadError instanceof ApiError && loadError.status === 0
          ? "The page keeps trying to reach the server by itself. Try again once the connection mark at the top right says live."
          : "Nothing was changed. Try again, or go back to the list of runs.",
      ], again, back);
    } else {
      key = "loading:" + (store.state.connected || store.state.everConnected ? "run" : "server");
      build = () => el("p", { class: "screen-loading dim", role: "status" }, el("span", "spinner"),
        store.state.connected || store.state.everConnected
          ? " Loading run " + runId + "…"
          : " Connecting to the server to load run " + runId + "…");
    }
    swap(statusBox, key, build);
  }

  // ---------------------------------------------------------------- rendering: header

  function renderHead(run) {
    const facts = runFacts(run);
    const stateKey = run.state + (run.external ? ":external" : "");
    swap(stateSlot, stateKey, () => [statusBadge(run.state), run.external ? el("span", "small dim", "in another process") : null]);
    setText(kindText, facts.kind);
    swap(modeSlot, facts.mode.text, () => {
      const node = badge(facts.mode.text, facts.mode.kind, facts.mode.icon);
      node.title = facts.mode.title;
      return node;
    });
    setHidden(demoMark, !facts.demo);
    setText(modelText, facts.effort ? facts.model + " · " + facts.effort : facts.model);

    const totals = headerTotals(run);
    stats.progress.update(totals.progress);
    stats.spend.update(totals.spend);
    stats.proxy.update(totals.proxy);
    stats.penalties.update(totals.penalties);
  }

  function renderControls(run) {
    const states = controlStates(run, { stopped: stoppedHere });
    const apply = (button, state, help) => {
      button.disabled = !state.enabled || Boolean(busy);
      setTitle(button, state.enabled ? help : state.reason);
    };
    apply(finalizeBtn, states.finalizeAll, "Fix the answer of every panorama as it stands now. Asks first.");
    apply(stopBtn, states.stop, "Finalise everything with the best-so-far lists and write the exports, as Ctrl-C does. Asks first.");
    apply(addBtn, states.add, "Add more panoramas to this run (opens the upload and preflight steps)");

    setHidden(busyNote, !busy);
    if (busy) {
      swap(busyNote, busy, () => [el("span", "spinner"), busy === "stop"
        ? " Stopping: waiting for the work in flight to end and the exports to be written…"
        : " Finalising: waiting for the exports to be written…"]);
    }

    const rows = controlReasons(states);
    setHidden(reasonList, rows.length === 0);
    swap(reasonList, JSON.stringify(rows), () => rows.map((row) =>
      el("li", null, icon("lock"), el("span", null, el("strong", null, row.controls + ": "), row.reason))));

    setHidden(actionNote, !actionError);
    if (actionError) {
      const { kind, err } = actionError;
      setText(actionText, ACTION_NAME[kind] + " did not go through. " + errorText(err));
      // The same key makes the repeat safe: the server answers with the first result.
      setHidden(actionRetry, !(err instanceof ApiError && (err.status === 0 || err.status >= 500)));
      actionRetry.disabled = Boolean(busy);
    }

    // Another tab stopped or finalised the run while our question was open.
    if (dialog && !dialog.locked) {
      const state = dialog.kind === "stop" ? states.stop : states.finalizeAll;
      if (!state.enabled) {
        dialog.locked = true;
        dialog.handle.lock(state.reason + " Nothing was sent from this page.");
      }
    }

    const pano = view.density === "focus" && focusCell ? focusCell.pid : null;
    const stagePath = paths.stage(runId, pano ? { pano } : undefined);
    if (stageLink.getAttribute("href") !== stagePath) stageLink.setAttribute("href", stagePath);
  }

  function renderClock(run) {
    const elapsed = store.runElapsed(run);
    const clock = clockModel(run, elapsed);
    setText(clockValue, clock.text);
    setText(clockDetail, clock.detail);
    setData(clockBox, "tone", clock.tone);
    setTitle(clockValue, clock.scoring
      ? "Time on the run clock, against the " + Math.round(clock.limitS / 60) + " minutes of the scoring run"
      : "Time since the run clock started");
    // The start can be moved while it still matters: a run in progress, or a scoring run.
    const editable = Boolean(run.active) || clock.scoring;
    setHidden(clockButton, !editable);
    if (!editable && editorOpen) closeEditor(false);
    guide.update(phaseStrip(run, elapsed));

    const watchdog = watchdogModel(run, store.watchdogRemaining(run));
    setHidden(dog, !watchdog);
    if (watchdog) {
      setText(dogText, watchdog.text);
      setData(dog, "tone", watchdog.tone);
      setTitle(dog, watchdog.title);
    }
  }

  function renderNotices(run) {
    const state = store.state;
    const down = !state.connected && state.everConnected;
    setHidden(lostNote, !down);
    if (down) {
      const age = state.lastContactMs ? fmtAgo((Date.now() - state.lastContactMs) / 1000) : "some time ago";
      setText(lostText, run.owned
        ? "The event stream is down. This dashboard shows the state received " + age + " and keeps asking the server "
          + "every few seconds; the clocks tick on by themselves. Finalize all and Stop run still work if the server "
          + "answers. Cues, questions and geocodes are disabled until the stream is back."
        : "The event stream is down. This run is a record on disk, so nothing here is going stale; it is read again "
          + "when the connection is back.");
    }

    setHidden(refreshNote, !refreshError);
    if (refreshError) {
      setText(refreshText, "This run could not be read again, so what you see may be out of date. " + errorText(refreshError));
    }

    const banner = runBanner(run);
    swap(bannerSlot, banner ? JSON.stringify(banner) : "", () => {
      if (!banner) return null;
      const buttons = banner.actions.map((action, index) => {
        const main = index === 0 ? " primary" : "";
        if (action === "submission") return link(paths.submit(runId), { class: "btn small" + main }, icon("download"), "Open Submission");
        if (action === "runs") return link(paths.runs(), { class: "btn small" + main }, icon("arrow-left"), "Back to Runs");
        return null;
      });
      return el("div", { class: "notice notice-" + banner.tone + " dash-banner", role: "status" },
        icon(banner.icon),
        el("div", "dash-notice-body",
          el("div", null, el("strong", null, banner.title + ". "), banner.text),
          buttons.some(Boolean) ? el("span", "row tight wrap", buttons) : null));
    });
  }

  function renderToolbar(run) {
    for (const [name, button] of densityButtons) button.setAttribute("aria-pressed", String(name === view.density));
    sortButton.setAttribute("aria-pressed", String(view.sort === "attention"));
    setText(summary, gridSummary(tilesOf(run)));
  }

  // ---------------------------------------------------------------- the grid

  function teardownGrid() {
    for (const cell of cells.values()) cell.tile.destroy();
    cells.clear();
    if (focusCell) focusCell.tile.destroy();
    focusCell = null;
    shownOrder = [];
    listNode = null;
    mainNode = null;
    replace(gridBox);
  }

  function buildGrid(density) {
    setData(gridBox, "density", density);
    if (density === "board") {
      listNode = el("div", "dash-list");
      replace(gridBox, el("div", "dash-board", tileBoardHeader(), listNode));
    } else if (density === "focus") {
      mainNode = el("div", "dash-focus-main");
      listNode = el("div", "dash-list");
      replace(gridBox, el("div", "dash-focus",
        mainNode,
        el("aside", { class: "dash-rail", "aria-label": "Panoramas of this run" },
          el("h2", "section-title dash-rail-title", "Panoramas"), listNode)));
    } else {
      listNode = el("div", "dash-tiles");
      replace(gridBox, listNode);
    }
  }

  function select(pid) {
    if (selectedPid === pid) return;
    selectedPid = pid;
    if (view.density !== "tiles") return;
    for (const cell of cells.values()) cell.wrapper.classList.toggle("is-selected", cell.pid === pid);
  }

  function makeCell(pid, density, readOnly) {
    const wrapper = el("div", { class: "dash-cell", dataset: { pid: String(pid) } });
    listNode.append(wrapper);
    let onSelect = null;
    if (density === "focus") onSelect = (chosen) => choosePano(chosen); // a rail row picks the large tile
    else if (density === "tiles") onSelect = (chosen) => select(chosen);
    const tile = createTile(wrapper, { runId, pid, density: density === "tiles" ? "tiles" : "board", replay: readOnly, onSelect });
    return { pid, wrapper, tile, order: null };
  }

  // Hold the attention order while the operator is working inside the grid: a tile that jumps
  // away under the pointer, or under a cue being typed, costs more than a late re-sort.
  function orderHeld() {
    if (view.sort !== "attention") return false;
    if (document.querySelector("dialog[open]")) return true;
    const active = document.activeElement;
    if (active && gridBox.contains(active) && isTyping(active)) return true;
    return Date.now() - lastTouchMs < HOLD_MS;
  }

  function wantedOrder(run) {
    const items = view.sort === "attention" ? attentionItems(store.state, Date.now()) : [];
    return orderTiles(tilesOf(run), { sort: view.sort, items, run, previous: shownOrder });
  }

  function applyOrder(run) {
    const wanted = wantedOrder(run).map((tile) => tile.panorama_id);
    const hold = orderHeld();
    shownOrder = displayOrder(shownOrder, wanted, hold);
    shownOrder.forEach((pid, index) => {
      const cell = cells.get(pid);
      if (!cell || cell.order === index) return;
      cell.order = index;
      cell.wrapper.style.order = String(index);
    });
    setHidden(heldNote, !(hold && shownOrder.some((pid, index) => pid !== wanted[index])));
  }

  function syncFocus(run, readOnly) {
    const target = focusTarget(wantedOrder(run), view.pano, focusCell ? focusCell.pid : selectedPid);
    if (target.missing && target.missing !== warnedMissing) {
      warnedMissing = target.missing;
      toast("Panorama " + target.missing + " is not in this run. Showing " + target.pid + " instead.", "warn");
    }
    if (target.pid && target.pid !== view.pano) {
      // Written to the URL so that a reload, or a changing order, keeps the same panorama large.
      view = { ...view, pano: target.pid };
      setQuery({ pano: target.pid });
    }
    if (focusCell && focusCell.pid !== target.pid) {
      focusCell.tile.destroy();
      focusCell = null;
    }
    if (!focusCell && target.pid) {
      focusCell = { pid: target.pid, tile: createTile(mainNode, { runId, pid: target.pid, density: "focus", replay: readOnly }) };
    }
    selectedPid = target.pid;
    for (const cell of cells.values()) {
      const current = cell.pid === target.pid;
      cell.wrapper.classList.toggle("is-current", current);
      if (current) cell.wrapper.setAttribute("aria-current", "true");
      else cell.wrapper.removeAttribute("aria-current");
    }
  }

  function syncGrid(run) {
    const tiles = tilesOf(run);
    const readOnly = isReadOnly(run);
    const wantedBuild = view.density + (readOnly ? ":record" : ":live");
    if (wantedBuild !== built) {
      teardownGrid();
      buildGrid(view.density);
      built = wantedBuild;
    }

    setHidden(emptyNote, tiles.length > 0);
    setHidden(gridBox, tiles.length === 0);
    if (!tiles.length) {
      swap(emptyNote, run.owned ? "owned" : "record", () => el("div", "empty",
        el("div", "empty-title", "This run has no panoramas"),
        el("p", null, run.owned
          ? "Nothing has been added to it yet. Panoramas added now start at once."
          : "Its directory holds no panorama log."),
        run.owned ? el("button", { type: "button", class: "primary", onclick: () => navigate(paths.newRun({ run: runId })) }, icon("plus"), "Add panoramas") : null));
    }

    const byPid = new Map(tiles.map((tile) => [tile.panorama_id, tile]));
    for (const [pid, cell] of cells) {
      if (byPid.has(pid)) continue;
      cell.tile.destroy();
      cell.wrapper.remove();
      cells.delete(pid);
    }
    // New cells are appended and existing ones never move: a panorama added late appears
    // without disturbing a tile that is in use.
    for (const tile of tiles) {
      if (!cells.has(tile.panorama_id)) cells.set(tile.panorama_id, makeCell(tile.panorama_id, view.density, readOnly));
    }
    if (selectedPid && !byPid.has(selectedPid)) selectedPid = null;

    if (view.density === "focus") syncFocus(run, readOnly);
    applyOrder(run);
    // After the order: a tile decides at its first state whether it is on screen and worth building.
    for (const cell of cells.values()) cell.tile.update(byPid.get(cell.pid) || null, run);
    if (focusCell) focusCell.tile.update(byPid.get(focusCell.pid) || null, run);
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (dead) return;
    const run = currentRun();
    if (!run) {
      if (built) {
        teardownGrid();
        built = "";
      }
      renderStatus();
      return;
    }
    setHidden(statusBox, true);
    setHidden(body, false);
    renderHead(run);
    renderClock(run);
    renderEditor(run);
    renderNotices(run);
    renderToolbar(run);
    syncGrid(run);
    renderControls(run);
  }

  function tick() {
    if (dead || document.hidden) return;
    const run = currentRun();
    if (!run) return;
    renderClock(run);
    if (editorOpen) renderEditor(run);
    if (!lostNote.hidden) renderNotices(run);
    // Inbox items come and go with the clock (a window closing, a tile with no hypothesis yet).
    if (view.sort === "attention") applyOrder(run);
  }

  // ---------------------------------------------------------------- shortcuts

  // The full tile that `c` and `/` act on: the large one, or the one last touched.
  function workingTile() {
    if (view.density === "focus") return focusCell ? focusCell.tile : null;
    if (view.density === "tiles" && selectedPid && cells.has(selectedPid)) return cells.get(selectedPid).tile;
    return null;
  }

  function needTile(action) {
    const tile = workingTile();
    if (tile) return tile;
    toast(view.density === "board"
      ? "Switch to Tiles or Focus first: a board row has no " + action + "."
      : "Click a panorama first, then press the key again.", "info");
    return null;
  }

  function openCue() {
    const run = currentRun();
    if (!run) return;
    if (isReadOnly(run)) {
      toast("This run is a record: no cue can reach it.", "info");
      return;
    }
    if (run.mode === "autonomous" || run.no_human) {
      toast("This run is autonomous: human channels are disabled, so there is no cue box.", "info");
      return;
    }
    const tile = needTile("cue box");
    if (tile) tile.open("cue"); // opens and focuses the box; nothing is sent
  }

  function searchStream() {
    const tile = needTile("reasoning stream");
    if (tile && typeof tile.focusSearch === "function") tile.focusSearch();
  }

  // The question with the least time left, when it belongs to this run and a full tile can show it.
  function pendingHere() {
    if (view.density === "board") return null;
    const item = oldestPendingMcq(store.state, Date.now());
    return item && item.run_id === runId && item.panorama_id ? item : null;
  }

  function jumpToQuestion() {
    const item = pendingHere();
    if (!item) return;
    if (view.density === "focus") {
      choosePano(item.panorama_id);
      if (focusCell && focusCell.pid === item.panorama_id) focusCell.tile.open("mcq");
      return;
    }
    const cell = cells.get(item.panorama_id);
    if (cell) cell.tile.open("mcq"); // scrolls to the question and focuses it; a bare key never answers
  }

  // None of these keys sends anything: they change what the dashboard shows, or open a box.
  cleanup.push(shortcuts.register("Run dashboard", {
    1: { label: "Board: one row per panorama", run: () => setDensity("board") },
    2: { label: "Tiles: one tile per panorama", run: () => setDensity("tiles") },
    3: { label: "Focus: one panorama large, the others as a side rail", run: () => setDensity("focus") },
    f: { label: "Into the focus density and back", run: () => setDensity(toggleFocus(view.density, cameFrom)) },
    a: { label: "Needs attention first, or the default order", run: () => setSort(otherSort(view.sort)) },
    "g s": { label: "Go to the Submission of this run (on this screen, instead of Settings)", run: () => navigate(paths.submit(runId)) },
    m: { label: "Show the oldest pending question in its tile", when: () => Boolean(pendingHere()), run: jumpToQuestion },
    c: { label: "Open the cue box of the panorama you last touched (sends nothing)", run: openCue },
    "/": { label: "Search the reasoning stream of the panorama you last touched", run: searchStream },
    Escape: { label: "Close the run clock editor", when: () => editorOpen, run: () => closeEditor(true) },
  }));

  // ---------------------------------------------------------------- wiring

  cleanup.push(store.subscribe(render));
  cleanup.push(store.on("connection", render));
  // A run read from disk is not on the stream: read it again when the list of runs changes.
  cleanup.push(store.on("index", () => {
    const run = currentRun();
    if (!run || !run.owned) load({ force: true });
  }));
  cleanup.push(store.on("run", (msg) => {
    if (msg.run_id === runId && msg.removed) load({ force: true });
  }));
  const timer = setInterval(tick, TICK_MS);
  cleanup.push(() => clearInterval(timer));
  cleanup.push(() => document.removeEventListener("pointerdown", onOutsidePress, true));

  render();
  load();
  publishStripHeight();

  return {
    unmount() {
      if (dead) return;
      dead = true;
      abort.abort();
      for (const off of cleanup.splice(0)) off();
      if (dialog && confirmDialog.current === dialog.handle) dialog.handle.close();
      dialog = null;
      teardownGrid();
      root.remove();
    },
    onQuery(query) {
      const next = parseView(query, { density: prefs.get("density"), sort: prefs.get("sort") });
      // A URL without ?pano= keeps the panorama that is shown.
      if (!next.pano) next.pano = view.pano;
      if (next.density === view.density && next.sort === view.sort && next.pano === view.pano) return;
      if (next.density !== view.density && view.density !== "focus") cameFrom = view.density;
      view = next;
      render();
    },
  };
}
