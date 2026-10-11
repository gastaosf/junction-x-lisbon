// The operator controls of one panorama (UI-SPEC 3 and 5.5): the MCQ panel, the cue drawer, the
// last-resort geocode and the harness controls. These are the only places in the console where a
// click costs score, and the MCQ answer, the cue text and the geocode are the only three inputs
// that reach the agent. Nothing else in this file sends the model anything.
//
// Rules every control here follows:
// - the server decides (penalty, lint, deadline); the page shows state and asks;
// - a penalised action takes two deliberate steps and is never triggered by a single key;
// - the idempotency key of a request is made when its confirmation opens and reused for every
//   retry, so a double click or a retry after a timeout is charged once;
// - a penalised control is disabled, with the reason in words, while the event stream is down,
//   when the panorama is not live, or when the action no longer applies; an open confirmation is
//   locked rather than closed when the tile changes under it (contract A3).
//
// Which control is enabled and why is decided in logic/controls.js (pure, tested).

import { api, errorText, newKey, panoUrl } from "../api.js";
import { badge, clear, copyButton, debounce, el, icon, replace, syncList } from "../dom.js";
import { fmtCoord, fmtDist, fmtLatLng, fmtMult } from "../format.js";
import { shortcuts } from "../keyboard.js";
import {
  LAST_MCQ_LINGER_S,
  TEXT,
  ackState,
  checkSentence,
  cueDraft,
  cueLine,
  cueSendState,
  cueState,
  cueWindowLine,
  describeFailure,
  dialogLock,
  dialogSnapshot,
  distanceM,
  exportState,
  finalizeState,
  geocodeForm,
  geocodeState,
  groupReasons,
  humanEnabled,
  hypothesisForPlace,
  isLive,
  lingerLeft,
  lintItems,
  lintSegments,
  mcqView,
  multiplierAfter,
  multiplierLine,
  multiplierNow,
  optionIndexForKey,
  optionLetter,
  parseCoordinate,
  parseCoordinatePair,
  retryState,
  toggleState,
} from "../logic/controls.js";
import { prefs } from "../prefs.js";
import { store } from "../store.js";
import { createMap } from "./map.js";
import { confirmDialog, toast } from "./shell.js";

const SEND_TIMEOUT_MS = 20000; // a geocode waits for the conversation to stop and the files to be written
const CHECK_TIMEOUT_MS = 10000;
const MCQ_TICK_MS = 250;
const CLOCK_TICK_MS = 1000;
const DRAFT_SAVE_MS = 300;

const NOT_STARTED = "Another request for this panorama was still on its way, so this one was not sent. Wait for it, then try again.";

let serial = 0;
const nextId = (name) => "ctl-" + name + "-" + (serial += 1);

const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const setHidden = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };
const setDisabled = (node, disabled) => { if (node.disabled !== disabled) node.disabled = disabled; };

function setAttr(node, name, value) {
  if (value === null || value === undefined || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
}

const context = (tile) => ({ connected: store.state.connected, elapsed: tile ? store.elapsed(tile) : 0 });

// Every POST here returns the tile as the server now holds it: show it before the stream does.
function applyTile(result) {
  if (result && result.tile) store.patchTile(result.tile);
  return result;
}

// The tile a control works from, right after its own request: the store's copy when the store
// holds the run (it may already be newer than the response), else the response's.
function freshTile(runId, pid, result, held) {
  return store.tile(runId, pid) || (result && result.tile) || held;
}

function scrollTo(node) {
  if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- shared parts

// The message of a failed request, at the control that sent it. `retry` re-sends the very same
// request (same key, same body); it is offered only when the outcome is unknown.
function failureBox() {
  const node = el("div", { class: "notice notice-bad ctl-failure", role: "alert", hidden: true });
  let retryButton = null;
  let retryPenalised = false;

  function clearBox() {
    retryButton = null;
    clear(node);
    node.hidden = true;
  }

  function setConnected(connected) {
    if (!retryButton || !retryPenalised) return;
    setDisabled(retryButton, !connected);
    retryButton.title = connected ? "" : TEXT.disconnected;
  }

  function render(title, text, note, { retry = null, dismiss = null, penalised = false } = {}) {
    const actions = el("div", "row wrap");
    retryButton = null;
    retryPenalised = penalised;
    if (retry) {
      retryButton = el("button", { type: "button", class: (penalised ? "penalty " : "") + "small", onclick: retry },
        icon("refresh"), TEXT.retrySame);
      actions.append(retryButton);
    }
    actions.append(el("button", { type: "button", class: "small ghost", onclick: () => { clearBox(); if (dismiss) dismiss(); } }, "Dismiss"));
    replace(node, icon("alert"), el("div", "stack tight grow",
      el("strong", null, title),
      el("div", "pre", text),
      note ? el("div", null, note) : null,
      actions));
    node.hidden = false;
    setConnected(store.state.connected);
    scrollTo(node);
  }

  return {
    el: node,
    clear: clearBox,
    setConnected,
    /** Show a failed request: the server's own words (errorText), under a title for its kind. */
    show(err, failure, options) {
      render(failure.title, errorText(err) || failure.message, failure.note, options);
    },
    /** Show a refusal decided on the page (the action stopped applying before it was sent). */
    say(title, text) {
      render(title, text, "", {});
    },
  };
}

// One request and its retries. `request.send()` must close over one idempotency key and one body.
// While the outcome of a request is unknown (`unresolved`) the control keeps it instead of
// letting the operator start a second, different one.
function createSender({ box, onState, penalised = false }) {
  let current = null;
  let busy = false;
  let alive = true;
  const changed = () => { if (alive) onState(); };

  function dismiss() {
    const request = current;
    current = null;
    busy = false;
    box.clear();
    if (request && request.onDismiss) request.onDismiss();
    changed();
  }

  async function attempt() {
    const request = current;
    if (!request || busy) return;
    busy = true;
    box.clear();
    changed();
    try {
      const result = await request.send();
      if (current !== request) return;
      current = null;
      busy = false;
      changed();
      if (alive && request.onSuccess) request.onSuccess(result);
    } catch (err) {
      if (current !== request) return;
      busy = false;
      const failure = describeFailure(err);
      if (!failure.retry) current = null; // the server answered: nothing is in doubt
      if (!alive) return;
      const handled = request.onFailure ? request.onFailure(err, failure) === true : false;
      changed();
      if (!handled) box.show(err, failure, { retry: failure.retry ? attempt : null, dismiss, penalised });
    }
  }

  return {
    /** Start a request. Refused (false) while another one is in flight: one outcome at a time. */
    send(request) {
      if (busy) return false;
      current = request;
      attempt();
      return true;
    },
    dismiss,
    destroy() { alive = false; },
    get busy() { return busy; },
    get unresolved() { return current !== null && !busy; },
  };
}

// A confirmation and what it was opened against. watch() runs on every tile change and clock
// tick: when the action stops applying the dialog is locked with the reason, never closed under
// the operator's cursor.
function createConfirm() {
  let current = null;
  return {
    get open() { return current !== null; },
    async ask(kind, opened, options) {
      const promise = confirmDialog(options);
      const mine = { kind, opened, promise, handle: confirmDialog.current, locked: false };
      current = mine;
      const ok = await promise;
      if (current === mine) current = null;
      return ok === true && !mine.locked;
    },
    watch(tile, ctx) {
      if (!current || current.locked) return;
      const message = dialogLock(current.kind, current.opened, tile, ctx);
      if (!message) return;
      current.locked = true;
      current.promise.lock(message);
    },
    close() {
      const mine = current;
      current = null;
      if (mine && confirmDialog.current === mine.handle) mine.handle.close();
    },
  };
}

// "Cue, Geocode: <why they are disabled>", one line per distinct reason, always on screen.
function reasonList() {
  const node = el("ul", { class: "ctl-reasons", hidden: true });
  let shown = "";
  return {
    el: node,
    set(rows) {
      const groups = groupReasons(rows);
      const signature = JSON.stringify(groups);
      if (signature === shown) return;
      shown = signature;
      node.hidden = groups.length === 0;
      syncList(node, groups, (group) => group.reason,
        () => el("li", "ctl-reason", icon("lock"), el("span", "ctl-reason-labels"), el("span", "ctl-reason-text")),
        (item, group) => {
          setText(item.children[1], group.labels.join(", ") + ":");
          setText(item.children[2], group.reason);
        });
    },
  };
}

function costTag(text) {
  return el("span", "ctl-cost num", text);
}

// ---------------------------------------------------------------- control 1: MCQ

const SVG_NS = "http://www.w3.org/2000/svg";
const RING_RADIUS = 16;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function ringCircle(className) {
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("class", className);
  circle.setAttribute("cx", "20");
  circle.setAttribute("cy", "20");
  circle.setAttribute("r", String(RING_RADIUS));
  circle.setAttribute("fill", "none");
  return circle;
}

function countdownRing() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "ctl-ring-svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.setAttribute("aria-hidden", "true");
  const arc = ringCircle("ctl-ring-arc");
  arc.setAttribute("stroke-dasharray", RING_LENGTH.toFixed(2));
  svg.append(ringCircle("ctl-ring-track"), arc);
  const text = el("span", "ctl-ring-text num");
  const node = el("div", { class: "ctl-ring", role: "timer", "aria-label": "Time left to answer" }, svg, text);
  let shown = "";
  return {
    el: node,
    set(countdown) {
      const signature = countdown.text + "|" + countdown.level + "|" + countdown.fraction.toFixed(3);
      if (signature === shown) return;
      shown = signature;
      setText(text, countdown.text);
      node.dataset.level = countdown.level;
      arc.style.strokeDashoffset = (RING_LENGTH * (1 - countdown.fraction)).toFixed(2);
    },
  };
}

// "a-d then Enter" is listed once in the shortcut help however many panels a dashboard holds.
let mcqPanels = 0;
let offMcqHelp = null;

function listMcqShortcut() {
  mcqPanels += 1;
  if (mcqPanels === 1) {
    offMcqHelp = shortcuts.register("Question panel", {
      "a-d then Enter": { label: "Choose an option, then send it (while the question panel has focus)" },
    });
  }
}

function unlistMcqShortcut() {
  mcqPanels -= 1;
  if (mcqPanels === 0 && offMcqHelp) {
    offMcqHelp();
    offMcqHelp = null;
  }
}

/**
 * Control 1: the agent's multiple-choice question (x0.95, charged when asked).
 * mcqPanel(container, {runId, pid, onHighlightHypothesis?(index|null)}) -> {update(tile, run), focus(), destroy(), el}
 * Hidden unless a question is pending or closed less than 20 s ago (`tile.last_mcq`, contract A3).
 * An answer takes two steps: choose an option (click, or A to D), then send it (the button, or
 * Enter). The option buttons are the whole input: there is no text field on this path (R7).
 */
export function mcqPanel(container, { runId, pid, onHighlightHypothesis = null } = {}) {
  let tile = null;
  let view = { mode: "hidden" };
  let selected = null; // the option chosen and not yet sent
  let questionId = null; // the question `selected` and `sent` belong to
  let sent = null; // {id, index}: the answer this tab sent
  let seenPendingId = null;
  let closedAtMs; // when this page saw the last question close
  let closedMark = null;
  let firstUpdate = true;
  let timer = null;
  let highlighted = null;
  let builtOptions = "";
  let rows = [];
  let alive = true;
  const keys = new Map(); // "<question id>:<option>" -> idempotency key, reused by every retry

  const ring = countdownRing();
  const questionNode = el("h3", "ctl-mcq-question wrap-any");
  const whyText = el("span", "wrap-any");
  const whyNode = el("p", "ctl-mcq-why", el("span", "caps dim", "Why it matters"), whyText);
  const optionsNode = el("div", { class: "ctl-mcq-options", role: "radiogroup", "aria-label": "Options" });
  const sendButton = el("button", { type: "button", class: "penalty ctl-mcq-send" }, "Send answer");
  const statusIcon = el("span", "ctl-mcq-status-icon");
  const statusText = el("span", "wrap-any");
  const statusNode = el("div", { class: "ctl-mcq-status", role: "status" }, statusIcon, statusText);
  const actionsNode = el("div", "ctl-mcq-actions", sendButton);
  const box = failureBox();
  const root = el("section", { class: "ctl-mcq", tabindex: "-1", "aria-label": "Question from the agent", hidden: true });
  container.append(root);
  listMcqShortcut();

  // Filled when the first question arrives: until then, and for the whole of an autonomous run,
  // the page holds no penalised control at all, not even a hidden one.
  let filled = false;
  function fill() {
    if (filled) return;
    filled = true;
    root.append(
      el("header", "ctl-mcq-head",
        ring.el,
        el("div", "stack tight grow",
          el("div", "row wrap",
            el("span", "caps", "Question from the agent"),
            badge("x0.95 already charged", "penalty", "alert")),
          questionNode)),
      whyNode,
      optionsNode,
      actionsNode,
      statusNode,
      box.el,
      el("p", "ctl-mcq-note small dim", TEXT.mcqCharged));
  }

  const sender = createSender({ box, onState: () => render(), penalised: true });
  // The stream dropping or coming back changes what may be sent without a new tile arriving.
  const offConnection = store.on("connection", () => render());

  function highlight(index) {
    const option = index === null || view.mode === "hidden" ? null : (view.options || [])[index];
    const target = option && option.place && option.place.index !== null ? option.place.index : null;
    if (target === highlighted) return;
    highlighted = target;
    if (onHighlightHypothesis) onHighlightHypothesis(target);
  }

  function buildOption(option) {
    const mark = el("span", { class: "ctl-mcq-mark", hidden: true });
    const button = el("button", {
      type: "button", class: "penalty ctl-mcq-choice", role: "radio", "aria-checked": "false", dataset: { index: option.index },
      onclick: () => select(option.index),
    }, el("span", "ctl-mcq-letter", option.letter), el("span", "ctl-mcq-text wrap-any", option.text), mark);
    const place = el("div", { class: "ctl-mcq-place", hidden: true });
    const row = el("div", "ctl-mcq-option", button, place);
    row.addEventListener("mouseenter", () => highlight(option.index));
    row.addEventListener("mouseleave", () => highlight(null));
    row.addEventListener("focusin", () => highlight(option.index));
    row.addEventListener("focusout", () => highlight(null));
    return { row, button, mark, place, placeShown: "", markShown: "" };
  }

  function renderOption(row, option) {
    const chosen = view.mode === "pending" && view.markedIndex === null && selected === option.index;
    const marked = view.markedIndex === option.index;
    setAttr(row.button, "aria-checked", chosen || marked ? "true" : "false");
    setDisabled(row.button, !view.enabled);
    row.row.classList.toggle("is-chosen", chosen);
    row.row.classList.toggle("is-marked", marked);
    const sentText = sender.busy ? "sending" : sender.unresolved ? "not confirmed" : "sent";
    const markText = marked ? (view.mode === "pending" ? sentText : "chosen") : chosen ? "selected" : "";
    if (markText !== row.markShown) {
      row.markShown = markText;
      row.mark.hidden = markText === "";
      const markIcon = { selected: "dot", sending: "clock", "not confirmed": "alert" }[markText] || "check";
      replace(row.mark, markText ? [icon(markIcon), markText] : null);
    }
    const place = option.place;
    const placeText = place ? place.label + "|" + place.lat + "|" + place.lng : "";
    if (placeText !== row.placeShown) {
      row.placeShown = placeText;
      row.place.hidden = !place;
      // The hand-off to a second device for the plausibility check: copy only, no link out (U2).
      replace(row.place, place ? [
        el("span", "dim", "Hypothesis"),
        el("span", "wrap-any", place.label),
        el("span", "mono", fmtLatLng(place.lat, place.lng)),
        copyButton(fmtLatLng(place.lat, place.lng), { title: "Copy these coordinates" }),
      ] : null);
    }
  }

  function renderStatus() {
    let iconName = "info";
    let text = "";
    let tone = "info";
    if (view.mode === "result") {
      ({ icon: iconName, text, tone } = view.outcome);
    } else if (view.reason) {
      text = view.reason;
      const settled = view.markedIndex !== null && !sender.busy && !sender.unresolved;
      iconName = settled ? "check" : sender.busy ? "clock" : "lock";
      tone = settled ? "ok" : sender.busy ? "info" : "warn";
    } else if (selected === null) {
      text = "Choose an option, then send it. Keyboard: A to D, then Enter.";
    } else {
      text = "Selected " + optionLetter(selected) + ". Press Send answer or Enter to send it; choosing costs nothing.";
    }
    if (statusNode.dataset.shown !== iconName + text) {
      statusNode.dataset.shown = iconName + text;
      statusNode.dataset.tone = tone;
      replace(statusIcon, icon(iconName));
      setText(statusText, text);
    }
  }

  function render() {
    if (!alive || !tile) return;
    view = mcqView(tile, {
      connected: store.state.connected,
      remaining: store.mcqRemaining(tile),
      nowMs: Date.now(),
      closedAtMs,
      elapsed: store.elapsed(tile),
      sent,
      sending: sender.busy,
      unresolved: sender.unresolved,
      seenPendingId,
    });
    if (view.mode === "hidden") {
      setHidden(root, true);
      root.style.minHeight = "";
      highlight(null);
      stopTimer();
      return;
    }
    // A closed question is shorter than an open one. The panel keeps its height while the result
    // shows, so the second click of a double click on "Send answer" cannot land on whatever
    // would otherwise slide up under the pointer.
    if (view.mode === "result" && root.dataset.mode === "pending" && !root.hidden) {
      root.style.minHeight = root.offsetHeight + "px";
    } else if (view.mode === "pending") {
      root.style.minHeight = "";
    }
    if (view.mode === "pending" && view.id !== questionId) {
      // A new question: nothing chosen for the last one applies to it.
      questionId = view.id;
      selected = null;
      if (sent && sent.id !== view.id) sent = null;
      box.clear();
    }
    fill();
    setHidden(root, false);
    root.dataset.mode = view.mode;
    setText(questionNode, view.question);
    setHidden(whyNode, !view.why);
    setText(whyText, view.why);
    setHidden(ring.el, view.mode !== "pending");
    if (view.countdown) ring.set(view.countdown);

    const signature = view.id + "\u0000" + view.options.map((option) => option.text).join("\u0000");
    if (signature !== builtOptions) {
      builtOptions = signature;
      rows = view.options.map(buildOption);
      replace(optionsNode, rows.map((row) => row.row));
    }
    view.options.forEach((option, index) => renderOption(rows[index], option));

    setHidden(actionsNode, view.mode !== "pending");
    setText(sendButton, selected === null ? "Send answer" : "Send answer " + optionLetter(selected));
    setDisabled(sendButton, !view.enabled || selected === null || sender.busy);
    renderStatus();
    box.setConnected(store.state.connected);
    startTimer();
  }

  function startTimer() {
    if (timer === null) timer = setInterval(render, MCQ_TICK_MS);
  }

  function stopTimer() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  // Step one: choose. Reaches nothing but this panel.
  function select(index, { focus = false } = {}) {
    if (view.mode !== "pending" || !view.enabled) return;
    selected = index;
    render();
    if (focus && rows[index]) rows[index].button.focus();
  }

  // Step two: send the chosen option. The only request this panel makes.
  function send() {
    if (view.mode !== "pending" || !view.enabled || selected === null || sender.busy) return;
    const id = view.id;
    const index = selected;
    const name = id + ":" + index;
    if (!keys.has(name)) keys.set(name, newKey());
    const key = keys.get(name);
    sent = { id, index };
    const forget = () => { if (sent && sent.id === id && sent.index === index) sent = null; };
    sender.send({
      send: () => api.post(panoUrl(runId, pid, "/mcq/" + encodeURIComponent(id) + "/answer"), { index },
        { key, timeoutMs: SEND_TIMEOUT_MS }).then(applyTile).then((result) => {
        accept(freshTile(runId, pid, result, tile));
        return result;
      }),
      onFailure: (err, failure) => { if (!failure.retry) forget(); return false; },
      onDismiss: forget,
    });
    render();
  }

  sendButton.addEventListener("click", send);

  // A to D choose, Enter sends: two keys, never one. The letters are stopped here so that "c"
  // typed in this panel is option C and not the dashboard's "open the cue box".
  root.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || view.mode !== "pending") return;
    const index = optionIndexForKey(event.key, view.options.length);
    if (index !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) select(index, { focus: true });
      return;
    }
    if (event.key !== "Enter") return;
    const control = event.target && event.target.closest ? event.target.closest("button, a, input, select, textarea") : null;
    const onChosen = control && control.classList.contains("ctl-mcq-choice") && Number(control.dataset.index) === selected;
    // Enter on any other control activates that control (choosing a different option included).
    if (control && control !== sendButton && !onChosen) return;
    event.preventDefault();
    event.stopPropagation();
    // A held key repeats: the keypress that chose an option must not also send it.
    if (!event.repeat) send();
  });

  function track() {
    if (tile.pending_mcq && isLive(tile)) {
      seenPendingId = String(tile.pending_mcq.id);
      closedMark = null;
      closedAtMs = undefined;
      return;
    }
    const last = tile.last_mcq;
    if (!last) {
      closedMark = null;
      return;
    }
    const mark = last.id + ":" + last.seq;
    if (mark === closedMark) return;
    closedMark = mark;
    const now = Date.now();
    // Seen closing just now, or the page was opened afterwards: then only the panorama's own
    // clock says how long ago that was.
    closedAtMs = firstUpdate
      ? now - (LAST_MCQ_LINGER_S - lingerLeft(tile, { elapsed: store.elapsed(tile) })) * 1000
      : now;
  }

  function accept(next) {
    if (!alive || !next) return;
    tile = next;
    track();
    firstUpdate = false;
    render();
  }

  return {
    el: root,
    update: accept,
    /** Scroll to the question and give it the keyboard. Returns false when there is none. */
    focus() {
      if (!alive || root.hidden) return false;
      if (typeof root.scrollIntoView === "function") root.scrollIntoView({ block: "center" });
      root.focus({ preventScroll: true });
      return true;
    },
    destroy() {
      if (!alive) return;
      alive = false;
      stopTimer();
      offConnection();
      sender.destroy();
      if (highlighted !== null && onHighlightHypothesis) onHighlightHypothesis(null);
      unlistMcqShortcut();
      root.remove();
    },
  };
}

// ---------------------------------------------------------------- control 2: cue

function lintVerdictNode(text, problems, matches) {
  const items = lintItems(problems, matches).map((item) => (item.word !== null
    ? el("li", null, item.category + ": ", el("mark", "ctl-lint-word", item.word))
    : el("li", null, item.text)));
  const mirror = el("div", { class: "ctl-lint-mirror pre", "aria-label": "The checked text, offending words underlined" },
    lintSegments(text, matches).map((part) => (part.mark ? el("mark", "ctl-lint-mark", part.text) : part.text)));
  return el("div", { class: "notice notice-bad", role: "alert" }, icon("x"), el("div", "stack tight grow",
    el("strong", null, "The lint blocks this cue. Nothing was sent, charged or logged."),
    items.length ? el("ul", "ctl-problems", items) : null,
    mirror,
    el("div", "small", "Remove the reference and check again. The text stays in the box.")));
}

/**
 * Control 2: the cue (x0.8). Closed by default, behind the "Cue…" button.
 * cueDrawer(container, {runId, pid}) -> {update(tile, run), open(), close(), destroy(), el}
 * Also `trigger` (the button), `rendered()` and `reasonRows()`, used by controlBar.
 * "Check" asks the server's lint and leaves no trace; "Send cue" checks, then opens the penalty
 * confirmation, then sends once. The draft is kept in this browser only until the cue is sent.
 */
export function cueDrawer(container, { runId, pid, composed = false, onChange = null } = {}) {
  let tile = null;
  let run = null;
  let state = cueState(null, null);
  let open = false;
  let wantOpen = false;
  let checking = false;
  let preparing = false; // the free check that precedes a confirmation
  let checked = null; // {text, verdict}
  let checkError = null;
  let checkShown = "";
  let cuesShown = "";
  let alive = true;
  const draftKey = "cueDraft:" + runId + ":" + pid;
  const abort = new AbortController();
  const confirm = createConfirm();
  const box = failureBox();
  const reasons = reasonList();
  const drawerId = nextId("cue");
  const textId = nextId("cue-text");

  const trigger = el("button", { type: "button", class: "penalty ctl-trigger", "aria-expanded": "false", "aria-controls": drawerId },
    "Cue…", costTag("x0.8"));
  const textarea = el("textarea", { id: textId, class: "ctl-cue-text", rows: 4, spellcheck: true,
    placeholder: "What to look at, in visual terms only. For example: read the small sign above the door on the left." });
  textarea.value = String(prefs.get(draftKey, "") || "");
  const countNode = el("span", "num ctl-cue-count");
  const overNode = el("span", { class: "bad-text small", hidden: true });
  const multNode = el("span", "num small");
  const windowNode = el("span", { class: "warn-text small num", hidden: true });
  const checkNode = el("div", { class: "ctl-cue-check", hidden: true });
  const checkButton = el("button", { type: "button", class: "ctl-cue-checkbtn" }, icon("search"), "Check (no charge)");
  const sendButton = el("button", { type: "button", class: "penalty" }, "Send cue (x0.8)…");
  const closeButton = el("button", { type: "button", class: "ghost" }, "Close");
  const sendReason = el("span", { class: "ctl-inline-reason small", hidden: true });
  const cornerClose = el("button", { type: "button", class: "icon-btn", title: "Close the cue box (the draft is kept)", "aria-label": "Close the cue box" }, icon("x"));
  const cuesNode = el("ul", { class: "ctl-cues", "aria-label": "Cues sent", hidden: true });

  const drawer = el("div", { class: "ctl-drawer ctl-cue", id: drawerId, role: "region", "aria-label": "Cue to the agent", hidden: true },
    el("div", "row spread",
      el("div", "row", el("strong", null, "Cue to the agent"), badge("x0.8", "penalty", "alert")),
      cornerClose),
    el("p", "ctl-rule", TEXT.cueRule),
    el("label", { class: "field", for: textId },
      el("span", "field-label", "Cue text. This is sent to the agent exactly as written."),
      textarea),
    el("div", "row wrap spread",
      el("div", "row wrap", el("span", "small dim", "Characters"), countNode, overNode),
      el("div", "row wrap", windowNode, el("span", "small dim", "Multiplier"), multNode)),
    checkNode,
    el("div", "row wrap", checkButton, sendButton, closeButton, sendReason),
    box.el);
  const root = el("div", "ctl-cuebox", composed ? null : el("div", "row wrap", trigger), composed ? null : reasons.el, cuesNode, drawer);
  container.append(root);

  const sender = createSender({ box, onState: () => render(), penalised: true });
  // The stream dropping or coming back changes what may be sent without a new tile arriving.
  const offConnection = store.on("connection", () => render());
  const adopt = (result) => {
    tile = freshTile(runId, pid, result, tile);
    return result;
  };

  const saveDraft = debounce(() => {
    const text = textarea.value;
    prefs.set(draftKey, text.trim() ? text : null);
  }, DRAFT_SAVE_MS);

  // Another tab edited or sent the draft: follow it unless the operator is typing here.
  const offDraft = prefs.onChange(draftKey, (value) => {
    const text = String(value || "");
    if (!alive || textarea.value === text || document.activeElement === textarea) return;
    if (sender.busy || sender.unresolved || confirm.open || preparing) return;
    textarea.value = text;
    checked = null;
    render();
  });

  function reasonRows() {
    return [{ label: "Cue", reason: state.rendered && !state.enabled ? state.reason : "" }];
  }

  function renderCheck() {
    const signature = JSON.stringify([checking, checkError ? errorText(checkError) : null, checked]);
    if (signature === checkShown) return;
    checkShown = signature;
    checkNode.hidden = !checking && !checkError && !checked;
    if (checking) {
      replace(checkNode, el("div", "row", el("span", "spinner"), el("span", null, "Checking with the server's lint. Nothing is charged.")));
    } else if (checkError) {
      replace(checkNode, el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight grow", el("strong", null, "The check did not run. Nothing was charged."), el("div", "pre", errorText(checkError)))));
    } else if (checked && checked.verdict.ok) {
      replace(checkNode, el("div", { class: "notice notice-ok", role: "status" }, icon("check"),
        el("div", null, "The lint found no location reference in these " + checked.verdict.char_count +
          " characters. Nothing was charged or logged. The lint is a backstop, not a guarantee: you answer for rule R6.")));
    } else if (checked && checked.verdict.reason === "lint") {
      replace(checkNode, lintVerdictNode(checked.text, checked.verdict.problems, checked.verdict.matches));
    } else if (checked) {
      replace(checkNode, el("div", { class: "notice notice-warn", role: "alert" }, icon("alert"), el("div", null, checkSentence(checked.verdict))));
    } else {
      clear(checkNode);
    }
  }

  function renderCues() {
    const cues = Array.isArray(tile.cues) ? tile.cues : [];
    const signature = JSON.stringify(cues);
    if (signature === cuesShown) return;
    cuesShown = signature;
    cuesNode.hidden = cues.length === 0;
    syncList(cuesNode, cues.map((cue, index) => ({ cue, index })), (item) => item.cue.seq ?? "n" + item.index,
      () => el("li", "ctl-cue-line"),
      (node, item) => {
        const line = cueLine(item.cue, item.index);
        if (node.dataset.shown === line.text) return;
        node.dataset.shown = line.text;
        node.dataset.state = line.state;
        replace(node, badge(line.label, line.tone, line.icon), el("span", "wrap-any num", line.text));
      });
  }

  function render() {
    if (!alive || !tile) return;
    const ctx = context(tile);
    state = cueState(tile, run, ctx);
    confirm.watch(tile, ctx);
    setHidden(root, !state.rendered);
    if (!state.rendered) {
      if (onChange) onChange();
      return;
    }
    const locked = sender.busy || sender.unresolved || confirm.open || preparing;
    const draft = cueDraft(textarea.value, state.maxChars);
    const sendState = cueSendState(state, draft, { busy: sender.busy || checking || preparing || confirm.open, unresolved: sender.unresolved });

    // The button also closes the drawer, so it stays usable while the drawer is open.
    setDisabled(trigger, !state.enabled && !open);
    trigger.title = !state.enabled && !open ? state.reason : "";
    setAttr(trigger, "aria-expanded", open ? "true" : "false");
    setHidden(drawer, !open);
    if (!composed) reasons.set(reasonRows());
    renderCues();

    if (open) {
      if (textarea.readOnly !== locked) textarea.readOnly = locked;
      setText(countNode, draft.label);
      countNode.classList.toggle("bad-text", draft.over > 0);
      setHidden(overNode, draft.over === 0);
      setText(overNode, draft.over + " over the limit: the server will refuse it");
      setText(multNode, multiplierLine(tile, "cue"));
      const windowText = cueWindowLine(state);
      setHidden(windowNode, !windowText);
      setText(windowNode, windowText);
      renderCheck();
      setDisabled(checkButton, checking || preparing || sender.busy || confirm.open || draft.empty || !isLive(tile));
      setDisabled(sendButton, !sendState.enabled);
      setText(sendButton, sender.busy ? "Sending…" : "Send cue (x0.8)…");
      setHidden(sendReason, !sendState.reason);
      setText(sendReason, sendState.reason);
      // While a request is out or in doubt its outcome is shown here, so the drawer stays.
      setDisabled(closeButton, sender.busy || sender.unresolved);
      setDisabled(cornerClose, sender.busy || sender.unresolved);
      box.setConnected(ctx.connected);
    }
    if (onChange) onChange();
  }

  // The server's lint as a question: no penalty, no event, nothing queued, no idempotency entry.
  async function runCheck() {
    const text = cueDraft(textarea.value).text;
    checking = true;
    checkError = null;
    render();
    let verdict = null;
    try {
      verdict = await api.post(panoUrl(runId, pid, "/cue/check"), { text },
        { key: false, timeoutMs: CHECK_TIMEOUT_MS, signal: abort.signal });
      // A verdict on text that has changed since says nothing about what is in the box now.
      checked = cueDraft(textarea.value).text === text ? { text, verdict } : null;
      if (!checked) verdict = null;
    } catch (err) {
      if (err && err.name === "AbortError") return null;
      checked = null;
      checkError = err;
    }
    checking = false;
    if (alive) render();
    return verdict;
  }

  function confirmBody(text, count) {
    return el("div", "stack",
      el("div", "small dim", "This text goes to the agent exactly as written (" + count + " characters):"),
      el("div", "ctl-confirm-text pre wrap-any", text),
      el("p", null, "It is charged once, now: x0.8 on this panorama. It is delivered at the agent's next turn; " +
        "if the panorama ends first it stays charged and undelivered."),
      el("p", "ctl-rule", TEXT.cueReminder));
  }

  async function sendClicked() {
    if (preparing || confirm.open || sender.busy || sender.unresolved || !state.enabled) return;
    if (cueDraft(textarea.value).empty) return;
    // Free, and it saves a confirmation for a cue the server would refuse anyway.
    preparing = true;
    const verdict = await runCheck();
    preparing = false;
    if (!alive) return;
    if (!verdict || !verdict.ok || !checked) {
      render();
      return;
    }
    const text = checked.text;
    const ctx = context(tile);
    if (!cueState(tile, run, ctx).enabled) {
      render();
      return;
    }
    // One key for this confirmation and every retry of what it sends (A17).
    const key = newKey();
    const opened = dialogSnapshot(tile);
    const asked = confirm.ask("cue", opened, {
      title: "Send this cue to the agent?",
      body: confirmBody(text, verdict.char_count ?? cueDraft(text).count),
      okLabel: "Send cue (x0.8)",
      cancelLabel: "Do not send",
      tone: "penalty",
      before: multiplierNow(tile),
      after: multiplierAfter(tile, "cue"),
      lockMessage: "This cue can no longer be sent.",
    });
    render();
    const ok = await asked;
    if (!alive) return;
    if (!ok) {
      render();
      return;
    }
    const stale = dialogLock("cue", opened, tile, context(tile));
    if (stale) {
      box.say("Not sent", stale);
      render();
      return;
    }
    sender.send({
      send: () => api.post(panoUrl(runId, pid, "/cue"), { text, confirmed: true }, { key, timeoutMs: SEND_TIMEOUT_MS })
        .then(applyTile).then(adopt),
      onSuccess: (result) => {
        saveDraft.cancel();
        textarea.value = "";
        prefs.remove(draftKey);
        checked = null;
        const charged = result && result.result ? result.result : {};
        toast("Cue sent and charged once (" + fmtMult(charged.multiplier_before ?? opened.multiplier) + " to " +
          fmtMult(charged.multiplier_after ?? multiplierNow(tile)) + "). It is delivered at the agent's next turn.", "ok");
        close(true);
      },
      onFailure: (err, failure) => {
        if (failure.kind !== "lint") return false;
        // The same list and underlines as "Check"; the text stays in the box.
        checkError = null;
        checked = { text, verdict: { ok: false, reason: "lint", problems: failure.problems, matches: failure.matches, char_count: cueDraft(text).count } };
        return true;
      },
    });
  }

  function openDrawer({ focus = true } = {}) {
    if (!alive) return false;
    if (!tile) {
      wantOpen = true;
      return false;
    }
    if (!state.rendered) return false;
    if (!state.enabled && !open) {
      // Nothing to open: show where the reason is written instead.
      scrollTo(composed ? trigger : root);
      return false;
    }
    open = true;
    render();
    scrollTo(drawer);
    if (focus) textarea.focus({ preventScroll: true });
    return true;
  }

  function close(refocus = false) {
    if (!open || sender.busy || sender.unresolved) return;
    open = false;
    saveDraft.flush();
    render();
    if (refocus && !trigger.disabled) trigger.focus();
  }

  trigger.addEventListener("click", () => (open ? close(true) : openDrawer()));
  closeButton.addEventListener("click", () => close(true));
  cornerClose.addEventListener("click", () => close(true));
  checkButton.addEventListener("click", () => { runCheck(); });
  sendButton.addEventListener("click", () => { sendClicked(); });
  textarea.addEventListener("input", () => {
    saveDraft();
    checkError = null;
    if (checked && cueDraft(textarea.value).text !== checked.text) checked = null;
    render();
  });
  drawer.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });

  const timer = composed ? null : setInterval(render, CLOCK_TICK_MS);

  return {
    el: root,
    trigger,
    update(nextTile, nextRun) {
      if (!alive || !nextTile) return;
      tile = nextTile;
      run = nextRun || run;
      render();
      if (wantOpen) {
        wantOpen = false;
        openDrawer();
      }
    },
    refresh: render,
    rendered: () => state.rendered,
    reasonRows,
    /** Open the drawer and focus the text. Sends nothing. Returns false when the cue is not available. */
    open: openDrawer,
    close: () => close(false),
    destroy() {
      if (!alive) return;
      saveDraft.flush();
      alive = false;
      if (timer !== null) clearInterval(timer);
      abort.abort();
      offDraft();
      offConnection();
      confirm.close();
      sender.destroy();
      trigger.remove();
      root.remove();
    },
  };
}

// ---------------------------------------------------------------- control 3: last-resort geocode

/**
 * Control 3: the last-resort geocode (x0.5).
 * geocodeControl(container, {runId, pid}) -> {update(tile, run), open(), close(), destroy(), el}
 * Also `trigger`, `rendered()` and `reasonRows()`, used by controlBar.
 * Disabled until the agent has named a place. The place is chosen from the agent's list (never
 * typed, R8); the point comes from a draggable pin on the drawer's own map or from two numbers.
 */
export function geocodeControl(container, { runId, pid, composed = false, onChange = null } = {}) {
  let tile = null;
  let state = geocodeState(null);
  let open = false;
  let wantOpen = false;
  let map = null;
  let pin = null;
  let fromInputs = false;
  let placesShown = null;
  let hypothesesShown = "";
  let alive = true;
  const confirm = createConfirm();
  const box = failureBox();
  const reasons = reasonList();
  const drawerId = nextId("geo");
  const placeId = nextId("geo-place");
  const latId = nextId("geo-lat");
  const lngId = nextId("geo-lng");

  const trigger = el("button", { type: "button", class: "penalty ctl-trigger", "aria-expanded": "false", "aria-controls": drawerId },
    "Last-resort geocode…", costTag("x0.5"));
  const select = el("select", { id: placeId, class: "ctl-geo-place" });
  const agentPoint = el("div", { class: "ctl-geo-agent small", hidden: true });
  // Text fields, not number fields: a number field shows a decimal comma in some locales, and the
  // coordinates must read the same here, in the confirmation and in the export.
  const coordinate = (id, placeholder) => el("input", { id, type: "text", class: "mono", inputmode: "decimal",
    autocomplete: "off", spellcheck: "false", maxlength: 24, placeholder });
  const latInput = coordinate(latId, "decimal degrees");
  const lngInput = coordinate(lngId, "decimal degrees");
  const pinText = el("span", "mono");
  const pinCopy = copyButton(() => pinText.textContent, { title: "Copy the pin's coordinates" });
  const pinLine = el("div", "row wrap ctl-geo-pin", el("span", "small dim", "Pin"), pinText, pinCopy);
  const pinDistance = el("div", { class: "small dim num", hidden: true });
  const multNode = el("span", "num small");
  const confirmButton = el("button", { type: "button", class: "penalty" }, "Record geocode (x0.5)…");
  const closeButton = el("button", { type: "button", class: "ghost" }, "Close");
  const formReason = el("span", { class: "ctl-inline-reason small", hidden: true });
  const mapHost = el("div", "ctl-geo-map");
  const cornerClose = el("button", { type: "button", class: "icon-btn", title: "Close without recording anything", "aria-label": "Close the geocode" }, icon("x"));

  const drawer = el("div", { class: "ctl-drawer ctl-geo", id: drawerId, role: "region", "aria-label": "Last-resort geocode", hidden: true },
    el("div", "row spread",
      el("div", "row", el("strong", null, "Last-resort geocode"), badge("x0.5", "penalty", "alert")),
      cornerClose),
    el("p", "ctl-rule", TEXT.geocodeRule),
    el("div", "ctl-geo-grid",
      el("div", "stack",
        el("label", { class: "field", for: placeId }, el("span", "field-label", "Place named by the agent"), select),
        agentPoint,
        el("div", "ctl-geo-coords",
          el("label", { class: "field", for: latId }, el("span", "field-label", "Latitude"), latInput),
          el("label", { class: "field", for: lngId }, el("span", "field-label", "Longitude"), lngInput)),
        pinLine,
        pinDistance,
        el("div", "row wrap", el("span", "small dim", "Multiplier"), multNode),
        el("div", "row wrap", confirmButton, closeButton),
        formReason),
      mapHost),
    box.el);
  const root = el("div", "ctl-geobox", composed ? null : el("div", "row wrap", trigger), composed ? null : reasons.el, drawer);
  container.append(root);

  const sender = createSender({ box, onState: () => render(), penalised: true });
  // The stream dropping or coming back changes what may be sent without a new tile arriving.
  const offConnection = store.on("connection", () => render());
  const adopt = (result) => {
    tile = freshTile(runId, pid, result, tile);
    return result;
  };

  function reasonRows() {
    return [{ label: "Geocode", reason: state.rendered && !state.enabled ? state.reason : "" }];
  }

  const places = () => (tile && Array.isArray(tile.named_places) ? tile.named_places.map(String) : []);
  const form = () => geocodeForm({ place: select.value, places: places(), lat: latInput.value, lng: lngInput.value });

  function renderPlaces() {
    const list = places();
    const signature = list.join("\u0000");
    if (signature === placesShown) return;
    placesShown = signature;
    const kept = list.includes(select.value) ? select.value : "";
    replace(select,
      el("option", { value: "" }, "Choose a place the agent named…"),
      list.map((name) => el("option", { value: name }, name)));
    select.value = kept;
  }

  // The agent's own point for the chosen place, when one of its hypotheses carries that name.
  const agentHypothesis = () => hypothesisForPlace(tile, select.value);

  // How far the pin is from the agent's own point: a mistyped coordinate shows up here as a
  // distance that makes no sense, before it costs anything.
  function distanceText(point) {
    const metres = point ? distanceM(point, agentHypothesis()) : null;
    return metres === null ? "" : fmtDist(metres) + " from the agent's own point for this place";
  }

  function renderAgentPoint() {
    const hypothesis = agentHypothesis();
    const text = hypothesis ? fmtLatLng(hypothesis.lat, hypothesis.lng) : "";
    if (agentPoint.dataset.shown === text) return;
    agentPoint.dataset.shown = text;
    agentPoint.hidden = !text;
    replace(agentPoint, text ? [
      el("span", "dim", "The agent's own point for this place: "),
      el("span", "mono", text),
      copyButton(text, { title: "Copy the agent's coordinates" }),
    ] : null);
  }

  function renderMap() {
    if (!map) return;
    const hypotheses = Array.isArray(tile.hypotheses) ? tile.hypotheses : [];
    const signature = JSON.stringify(hypotheses.map((h) => [h.lat, h.lng, h.probability, h.radius_m, h.label]));
    if (signature === hypothesesShown) return;
    hypothesesShown = signature;
    map.setHypotheses(hypotheses);
  }

  function render() {
    if (!alive || !tile) return;
    const ctx = context(tile);
    state = geocodeState(tile, ctx);
    confirm.watch(tile, ctx);
    setHidden(root, !state.rendered);
    if (!state.rendered) {
      if (open) closeMap();
      open = false;
      if (onChange) onChange();
      return;
    }
    setDisabled(trigger, !state.enabled && !open);
    trigger.title = !state.enabled && !open ? state.reason : "";
    setAttr(trigger, "aria-expanded", open ? "true" : "false");
    setHidden(drawer, !open);
    if (!composed) reasons.set(reasonRows());

    if (open) {
      const locked = sender.busy || sender.unresolved || confirm.open;
      renderPlaces();
      renderAgentPoint();
      renderMap();
      const current = form();
      setDisabled(select, locked);
      setDisabled(latInput, locked);
      setDisabled(lngInput, locked);
      setHidden(pinLine, !current.point);
      setText(pinText, current.point ? fmtLatLng(current.point.lat, current.point.lng) : "");
      const distance = distanceText(current.point);
      setHidden(pinDistance, !distance);
      setText(pinDistance, distance);
      setText(multNode, multiplierLine(tile, "geocode"));
      const reason = !state.enabled ? state.reason : sender.unresolved
        ? "The last geocode may or may not have reached the server. Retry it (it is not charged twice) or dismiss it first."
        : current.reason;
      setDisabled(confirmButton, locked || !state.enabled || !current.ready);
      setText(confirmButton, sender.busy ? "Recording…" : "Record geocode (x0.5)…");
      setHidden(formReason, !reason || sender.busy);
      setText(formReason, reason);
      setDisabled(closeButton, sender.busy || sender.unresolved);
      setDisabled(cornerClose, sender.busy || sender.unresolved);
      box.setConnected(ctx.connected);
    }
    if (onChange) onChange();
  }

  function onPin(point) {
    if (!fromInputs) {
      latInput.value = fmtCoord(point.lat);
      lngInput.value = fmtCoord(point.lng);
    }
    render();
  }

  function onCoordinates() {
    const lat = parseCoordinate(latInput.value, 90);
    const lng = parseCoordinate(lngInput.value, 180);
    if (pin) {
      fromInputs = true;
      if (lat !== null && lng !== null) pin.set({ lat, lng });
      else pin.remove();
      fromInputs = false;
    }
    render();
  }

  function openMap() {
    // The drawer's own map: the tile's map keeps showing the agent's state undisturbed.
    map = createMap(mapHost, { interactive: true, layer: "street", wheel: true });
    hypothesesShown = "";
    renderMap();
    map.fit({ force: true });
    pin = map.enablePin({ onChange: onPin });
  }

  function closeMap() {
    if (pin) pin.clear();
    if (map) map.destroy();
    pin = null;
    map = null;
    // A pin left from an earlier look must not be one click away from a confirmation later.
    select.value = "";
    latInput.value = "";
    lngInput.value = "";
    box.clear();
  }

  function openDrawer({ focus = true, scroll = true } = {}) {
    if (!alive) return false;
    if (!tile) {
      wantOpen = true;
      return false;
    }
    if (!state.rendered) return false;
    if (open) {
      if (scroll) scrollTo(drawer);
      if (focus) select.focus({ preventScroll: true });
      return true;
    }
    if (!state.enabled) {
      scrollTo(composed ? trigger : root);
      return false;
    }
    open = true;
    setHidden(drawer, false); // the map needs a laid-out container
    placesShown = null;
    openMap();
    render();
    if (scroll) scrollTo(drawer);
    if (focus) select.focus({ preventScroll: true });
    return true;
  }

  function close(refocus = false) {
    if (!open) return;
    if (sender.busy || sender.unresolved) return; // its outcome is shown here
    open = false;
    closeMap();
    render();
    if (refocus && !trigger.disabled) trigger.focus();
  }

  function confirmBody(current) {
    const distance = distanceText(current.point);
    return el("div", "stack",
      el("dl", "kv",
        el("dt", null, "Place"), el("dd", "wrap-any", current.place),
        el("dt", null, "Your point"), el("dd", "mono", fmtLatLng(current.point.lat, current.point.lng)),
        distance ? [el("dt", null, "Distance"), el("dd", "num", distance)] : null),
      el("ol", "ctl-consequences",
        el("li", null, "The multiplier of this panorama is multiplied by 0.5, on all ten entries."),
        el("li", null, "Your point becomes all ten entries of the answer, replacing the agent's list."),
        el("li", null, "The panorama ends at once: the agent stops, and no cue or question can follow.")),
      el("p", null, "This cannot be undone, and it can be done once per panorama."));
  }

  async function confirmClicked() {
    const current = form();
    if (!state.enabled || !current.ready || confirm.open || sender.busy || sender.unresolved) return;
    const key = newKey();
    const opened = dialogSnapshot(tile, { place: current.place });
    const body = { lat: current.point.lat, lng: current.point.lng, place_label: current.place, confirmed: true };
    const asked = confirm.ask("geocode", opened, {
      title: "Record a human geocode?",
      body: confirmBody(current),
      okLabel: "Record geocode (x0.5)",
      cancelLabel: "Do not record",
      tone: "penalty",
      before: multiplierNow(tile),
      after: multiplierAfter(tile, "geocode"),
      lockMessage: "This geocode can no longer be recorded.",
    });
    render();
    const ok = await asked;
    if (!alive) return;
    if (!ok) {
      render();
      return;
    }
    const stale = dialogLock("geocode", opened, tile, context(tile));
    if (stale) {
      box.say("Not recorded", stale);
      render();
      return;
    }
    sender.send({
      send: () => api.post(panoUrl(runId, pid, "/geocode"), body, { key, timeoutMs: SEND_TIMEOUT_MS })
        .then(applyTile).then(adopt),
      onSuccess: (result) => {
        const after = result && result.tile && result.tile.penalty ? result.tile.penalty.multiplier : multiplierNow(tile);
        toast("Geocode recorded for " + pid + ". It is final: your point is all ten entries, at " + fmtMult(after) + ".", "ok");
        close(false);
      },
    });
  }

  trigger.addEventListener("click", () => (open ? close(true) : openDrawer()));
  closeButton.addEventListener("click", () => close(true));
  cornerClose.addEventListener("click", () => close(true));
  confirmButton.addEventListener("click", () => { confirmClicked(); });
  latInput.addEventListener("input", onCoordinates);
  lngInput.addEventListener("input", onCoordinates);
  for (const input of [latInput, lngInput]) {
    input.addEventListener("change", () => {
      const value = parseCoordinate(input.value, input === latInput ? 90 : 180);
      if (value !== null) input.value = fmtCoord(value);
      // A typed point may be anywhere: bring it into view so the pin can be checked and dragged.
      const point = form().point;
      if (map && point) map.flyTo(point.lat, point.lng);
    });
    // "38.716900, -9.139900" copied from a second device fills both fields at once.
    input.addEventListener("paste", (event) => {
      const pair = parseCoordinatePair(event.clipboardData ? event.clipboardData.getData("text") : "");
      if (!pair || input.readOnly || input.disabled) return;
      event.preventDefault();
      latInput.value = fmtCoord(pair.lat);
      lngInput.value = fmtCoord(pair.lng);
      onCoordinates();
      if (map) map.flyTo(pair.lat, pair.lng);
    });
  }
  select.addEventListener("change", () => {
    const hypothesis = agentHypothesis();
    // Look there; the pin is still the operator's to place.
    if (map && hypothesis) map.flyTo(hypothesis.lat, hypothesis.lng);
    render();
  });
  drawer.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });

  return {
    el: root,
    trigger,
    update(nextTile) {
      if (!alive || !nextTile) return;
      tile = nextTile;
      render();
      if (wantOpen) {
        wantOpen = false;
        openDrawer();
      }
    },
    refresh: render,
    rendered: () => state.rendered,
    reasonRows,
    /** Open the drawer and focus the place list. Sends nothing. Returns false when it is not available. */
    open: () => openDrawer(),
    close: () => close(false),
    destroy() {
      if (!alive) return;
      alive = false;
      offConnection();
      confirm.close();
      sender.destroy();
      if (pin) pin.clear();
      if (map) map.destroy();
      pin = null;
      map = null;
      trigger.remove();
      root.remove();
    },
  };
}

// ---------------------------------------------------------------- harness controls

/**
 * Harness controls: nothing here reaches the agent, so none of it is magenta.
 * harnessControls(container, {runId, pid}) -> {update(tile, run), open(name), destroy(), el}
 * Questions-allowed switch, Finalize now (confirmed), Retry (only when `tile.retryable`),
 * Export JSON (a same-origin download) and the fallback acknowledgement. `open("ack")` scrolls
 * to the acknowledgement and focuses its button.
 */
export function harnessControls(container, { runId, pid, composed = false, onChange = null } = {}) {
  let tile = null;
  let toggling = false;
  let acking = false;
  let wantAck = false;
  let alive = true;
  const confirm = createConfirm();
  const box = failureBox();
  const reasons = reasonList();
  const exportUrl = panoUrl(runId, pid, "/download?what=export");

  const toggleInput = el("input", { type: "checkbox" });
  const toggleCount = el("span", "num ctl-toggle-count");
  const toggleHelp = el("span", "small dim ctl-toggle-help");
  const toggleNode = el("div", { class: "ctl-toggle", hidden: true },
    el("div", "row wrap",
      el("label", "switch", toggleInput, el("span", "switch-track"), el("span", null, "Questions allowed")),
      toggleCount),
    toggleHelp);
  const finalizeButton = el("button", { type: "button", class: "ctl-finalize" }, icon("flag"), "Finalize now");
  const retryButton = el("button", { type: "button", hidden: true }, icon("refresh"), "Retry");
  // A plain same-origin link: the browser downloads the file the server names (A30).
  const exportLink = el("a", { class: "btn", href: exportUrl, download: "" }, icon("download"), "Export JSON");
  const ackText = el("span", "wrap-any grow");
  const ackButton = el("button", { type: "button", class: "small" }, icon("check"), "Acknowledge");
  const ackIcon = el("span", "ctl-ack-icon");
  const ackNode = el("div", { class: "notice notice-warn ctl-ack", hidden: true }, ackIcon, ackText, ackButton);

  const root = el("div", "ctl-harness",
    el("div", "ctl-harness-row", toggleNode, el("div", "ctl-harness-buttons", finalizeButton, retryButton, exportLink)),
    composed ? null : reasons.el,
    ackNode,
    box.el);
  container.append(root);

  const sender = createSender({ box, onState: () => render() });
  // The stream dropping or coming back changes what may be sent without a new tile arriving.
  const offConnection = store.on("connection", () => render());
  const adopt = (result) => {
    tile = freshTile(runId, pid, result, tile);
    return result;
  };

  function reasonRows() {
    if (!tile) return [];
    const finalize = finalizeState(tile);
    const exported = exportState(tile);
    return [
      { label: "Finalize now", reason: finalize.rendered && !finalize.enabled ? finalize.reason : "" },
      { label: "Export JSON", reason: exported.enabled ? "" : exported.reason },
    ];
  }

  function render() {
    if (!alive || !tile) return;
    const ctx = context(tile);
    confirm.watch(tile, ctx);
    const busy = sender.busy || confirm.open;

    const toggle = toggleState(tile);
    setHidden(toggleNode, !toggle.rendered);
    if (toggle.rendered) {
      // While its request is in flight the switch shows what was asked for, not the old state.
      if (!toggling && toggleInput.checked !== toggle.checked) toggleInput.checked = toggle.checked;
      setDisabled(toggleInput, toggling || busy);
      setText(toggleCount, toggle.count);
      setText(toggleHelp, toggle.help);
    }

    const finalize = finalizeState(tile);
    setHidden(finalizeButton, !finalize.rendered);
    setDisabled(finalizeButton, !finalize.enabled || busy);
    finalizeButton.title = finalize.enabled ? "Fix the current best list as the final answer" : finalize.reason;

    setHidden(retryButton, !retryState(tile).rendered);
    setDisabled(retryButton, busy);

    const exported = exportState(tile);
    setAttr(exportLink, "href", exported.enabled ? exportUrl : null);
    setAttr(exportLink, "aria-disabled", exported.enabled ? null : "true");
    exportLink.title = exported.enabled ? "Download this panorama's export file" : exported.reason;

    const ack = ackState(tile);
    setHidden(ackNode, !ack.rendered);
    if (ack.rendered) {
      ackNode.classList.toggle("notice-warn", !ack.acknowledged);
      ackNode.classList.toggle("notice-info", ack.acknowledged);
      if (ackIcon.dataset.shown !== String(ack.acknowledged)) {
        ackIcon.dataset.shown = String(ack.acknowledged);
        replace(ackIcon, icon(ack.acknowledged ? "check" : "alert"));
      }
      setText(ackText, ack.text + (ack.reason ? " " + ack.reason : ""));
      setHidden(ackButton, ack.acknowledged);
      setDisabled(ackButton, !ack.enabled || acking || busy);
    }
    if (wantAck) {
      wantAck = false;
      scrollTo(ack.rendered ? ackNode : root);
      if (ack.rendered && !ackButton.hidden && !ackButton.disabled) ackButton.focus({ preventScroll: true });
    }
    if (!composed) reasons.set(reasonRows());
    box.setConnected(ctx.connected);
    if (onChange) onChange();
  }

  async function finalizeClicked() {
    const finalize = finalizeState(tile);
    if (!finalize.enabled || confirm.open || sender.busy) return;
    const key = newKey();
    const opened = dialogSnapshot(tile);
    const asked = confirm.ask("finalize", opened, {
      title: "Finalize " + pid + " now?",
      body: el("div", "stack",
        el("p", null, "The agent stops and its current best list becomes the final answer for this panorama. This cannot be undone."),
        el("p", null, "No penalty is charged and nothing is sent to the agent."),
        finalize.warning ? el("div", "notice notice-warn", icon("alert"), el("div", null, finalize.warning)) : null,
        store.state.connected ? null : el("div", "notice notice-warn", icon("wifi-off"),
          el("div", null, "The event stream is down, so what this page shows may be out of date."))),
      okLabel: "Finalize now",
      tone: "danger",
      lockMessage: "This panorama can no longer be finalized from here.",
    });
    render();
    const ok = await asked;
    if (!alive) return;
    if (!ok) {
      render();
      return;
    }
    const started = sender.send({
      send: () => api.post(panoUrl(runId, pid, "/finalize"), undefined, { key, timeoutMs: SEND_TIMEOUT_MS })
        .then(applyTile).then(adopt),
      onSuccess: () => toast("Finalized " + pid + ": its current best list is now the final answer.", "ok"),
    });
    if (!started) box.say("Not sent", NOT_STARTED);
  }

  async function retryClicked() {
    if (!retryState(tile).rendered || confirm.open || sender.busy) return;
    const key = newKey();
    const opened = dialogSnapshot(tile);
    const why = tile.stop_text ? " (" + tile.stop_text + ")" : "";
    const asked = confirm.ask("retry", opened, {
      title: "Retry " + pid + "?",
      body: el("div", "stack",
        el("p", null, "This panorama ended without an answer from the agent" + why + "."),
        el("p", null, "Retry starts a new conversation in the same log, so penalties already recorded carry over: " +
          "the multiplier stays " + fmtMult(multiplierNow(tile)) + "."),
        el("p", null, "It spends model budget again. Nothing you choose here reaches the agent.")),
      okLabel: "Retry",
      tone: "default",
      lockMessage: "This panorama can no longer be retried.",
    });
    render();
    const ok = await asked;
    if (!alive) return;
    if (!ok) {
      render();
      return;
    }
    const started = sender.send({
      send: () => api.post(panoUrl(runId, pid, "/retry"), undefined, { key, timeoutMs: SEND_TIMEOUT_MS })
        .then(applyTile).then(adopt),
      onSuccess: () => toast("Retry started for " + pid + ". Penalties already recorded carry over.", "ok"),
    });
    if (!started) box.say("Not sent", NOT_STARTED);
  }

  function toggleChanged() {
    if (toggling || !tile || sender.busy || confirm.open) {
      render(); // puts the switch back to what the server holds
      return;
    }
    const allowed = toggleInput.checked;
    const key = newKey();
    toggling = true;
    const started = sender.send({
      send: () => api.post(panoUrl(runId, pid, "/mcq_allowed"), { allowed }, { key, timeoutMs: SEND_TIMEOUT_MS })
        .then(applyTile).then(adopt).finally(() => { toggling = false; }),
      onDismiss: () => { toggling = false; },
    });
    if (!started) toggling = false;
  }

  function ackClicked() {
    if (acking || sender.busy || !ackState(tile).enabled) return;
    const key = newKey();
    acking = true;
    const started = sender.send({
      send: () => api.post(panoUrl(runId, pid, "/ack"), { kind: "fallback" }, { key, timeoutMs: SEND_TIMEOUT_MS })
        .then(applyTile).then(adopt).finally(() => { acking = false; }),
      onDismiss: () => { acking = false; },
    });
    if (!started) acking = false;
  }

  finalizeButton.addEventListener("click", () => { finalizeClicked(); });
  retryButton.addEventListener("click", () => { retryClicked(); });
  toggleInput.addEventListener("change", toggleChanged);
  ackButton.addEventListener("click", ackClicked);
  exportLink.addEventListener("click", (event) => {
    if (!exportLink.hasAttribute("href")) event.preventDefault();
  });

  return {
    el: root,
    update(nextTile) {
      if (!alive || !nextTile) return;
      tile = nextTile;
      render();
    },
    refresh: render,
    reasonRows,
    /** open("ack"): scroll to the fallback acknowledgement and focus its button. Sends nothing. */
    open(name) {
      if (!alive || name !== "ack") return false;
      wantAck = true; // kept for the first tile when none has arrived yet
      render();
      return Boolean(tile) && !ackNode.hidden;
    },
    destroy() {
      if (!alive) return;
      alive = false;
      offConnection();
      confirm.close();
      sender.destroy();
      root.remove();
    },
  };
}

// ---------------------------------------------------------------- the control bar

/**
 * The control bar of a tile (UI-SPEC 5.5 item 6).
 * controlBar(container, {runId, pid}) -> {update(tile, run), open(name), destroy(), el}
 * Left: the penalised controls ("Cue…", "Last-resort geocode…") with their drawers below.
 * Right: the harness controls. In an autonomous run no penalised control exists at all and the
 * bar says so. `open("cue" | "geocode" | "ack")` scrolls to, opens and focuses that control and
 * never sends anything.
 */
export function controlBar(container, { runId, pid } = {}) {
  let tile = null;
  let run = null;
  let cue = null;
  let geocode = null;
  let wanted = null;
  let alive = true;
  let refreshing = false;

  const humanNode = el("div", { class: "ctl-human", hidden: true });
  const autonomousNode = el("div", { class: "ctl-autonomous", hidden: true }, badge(TEXT.autonomous, "dim", "lock"));
  const harnessHost = el("div", "ctl-bar-harness");
  const reasons = reasonList();
  const drawers = el("div", "ctl-drawers");
  const root = el("div", { class: "ctl-bar", role: "group", "aria-label": "Controls for " + pid },
    el("div", "ctl-bar-row", humanNode, autonomousNode, harnessHost),
    reasons.el,
    drawers);
  container.append(root);

  function gather() {
    if (!alive || refreshing) return;
    reasons.set([
      ...(cue ? cue.reasonRows() : []),
      ...(geocode ? geocode.reasonRows() : []),
      ...harness.reasonRows(),
    ]);
  }

  const harness = harnessControls(harnessHost, { runId, pid, composed: true, onChange: gather });

  // The penalised controls are only built for a run whose human channels are on: in an
  // autonomous run they are not hidden, they do not exist.
  function setHuman(enabled) {
    setHidden(humanNode, !enabled);
    setHidden(autonomousNode, enabled);
    if (enabled && !cue) {
      cue = cueDrawer(drawers, { runId, pid, composed: true, onChange: gather });
      geocode = geocodeControl(drawers, { runId, pid, composed: true, onChange: gather });
      humanNode.append(cue.trigger, geocode.trigger);
    } else if (!enabled && cue) {
      cue.destroy();
      geocode.destroy();
      cue = null;
      geocode = null;
    }
  }

  function open(name) {
    if (!alive) return false;
    if (!tile) {
      wanted = name;
      return false;
    }
    scrollTo(root);
    if (name === "cue") return cue ? cue.open() : false;
    if (name === "geocode") return geocode ? geocode.open() : false;
    if (name === "ack") return harness.open("ack");
    return false;
  }

  // The cue window closes on the clock, not on an event: re-evaluate once a second.
  const timer = setInterval(() => {
    if (cue) cue.refresh();
  }, CLOCK_TICK_MS);

  return {
    el: root,
    update(nextTile, nextRun) {
      if (!alive || !nextTile) return;
      tile = nextTile;
      run = nextRun || run;
      refreshing = true;
      setHuman(humanEnabled(tile));
      if (cue) cue.update(tile, run);
      if (geocode) geocode.update(tile, run);
      harness.update(tile, run);
      refreshing = false;
      gather();
      if (wanted) {
        const name = wanted;
        wanted = null;
        open(name);
      }
    },
    open,
    destroy() {
      if (!alive) return;
      alive = false;
      clearInterval(timer);
      if (cue) cue.destroy();
      if (geocode) geocode.destroy();
      harness.destroy();
      root.remove();
    },
  };
}
