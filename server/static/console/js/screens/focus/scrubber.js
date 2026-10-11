// The timeline scrubber of the panorama focus screen (UI-SPEC 5.6): the whole run on one track,
// with a tick where each turn starts and a mark for every hypotheses update, human interaction,
// soft-deadline notice, final submission and error.
//
//   const scrubber = createScrubber(container, {onSeek: (seq, {settled}) => ...});
//   scrubber.setModel(timelineModel(inspect));     // logic/replay.js
//   scrubber.setCursor(at);                        // a seq, or null for live
//
// The scrubber only reports where the operator wants to look; the screen owns the cursor (it is
// `?at=` in the URL) and tells the scrubber what to show. `onSeek(seq|null, {settled})` is called
// with `settled: false` while the thumb is being dragged and `true` once it is let go or a step
// was made.
//
// Rule compliance: nothing here reaches the agent or changes a run. It is navigation over a log.

import { errorText } from "../../api.js";
import { el, icon, replace } from "../../dom.js";
import {
  canStep,
  describeCursor,
  entryAt,
  kindLabel,
  positionOf,
  resolveCursor,
  seqAtPosition,
  stepEvent,
  stepMark,
  stepTurn,
} from "../../logic/replay.js";
import { fmtClock } from "../../format.js";

const SNAP_PX = 5; // a press this close to a mark means the mark
const TURN_LABEL_GAP = 0.035; // turn numbers closer than this share of the track would collide

const percent = (fraction) => (Math.min(1, Math.max(0, fraction)) * 100).toFixed(3) + "%";

function stepButton(label, title, iconName, onClick) {
  return el("button", { type: "button", class: "small focus-scrub-step", title, "aria-label": title, onclick: onClick },
    iconName === "chevron-left" ? icon(iconName) : null, el("span", null, label), iconName === "chevron-right" ? icon(iconName) : null);
}

/**
 * createScrubber(container, {onSeek(seq|null, {settled}), onRetry?()}) ->
 *   {el, setModel(model), setCursor(at), setBanner({mode, text, back}), setLoading(), setError(err),
 *    step("event"|"turn"|"mark", direction), focus(), destroy()}
 */
export function createScrubber(container, { onSeek, onRetry = null } = {}) {
  let model = null;
  let at = null;
  let destroyed = false;
  let dragging = false;
  let dragSeq = null;
  let phase = "loading"; // "loading" | "error" | "ready"
  let banner = { mode: "ended", text: "", back: null };

  const seek = (seq, settled) => {
    if (!destroyed && typeof onSeek === "function") onSeek(seq, { settled });
  };

  // ---- the line above the track

  const bannerIcon = el("span", "focus-scrub-banner-icon");
  const bannerText = el("span", "focus-scrub-banner-text");
  const backButton = el("button", { type: "button", class: "primary small focus-scrub-back", hidden: true, onclick: () => seek(null, true) });
  const bannerLine = el("div", { class: "focus-scrub-banner", role: "status" }, bannerIcon, bannerText, backButton);

  // ---- the track

  const fill = el("div", "focus-scrub-fill");
  const turnLayer = el("div", { class: "focus-scrub-turns", "aria-hidden": "true" });
  const markLayer = el("div", { class: "focus-scrub-marks", "aria-hidden": "true" });
  const thumb = el("div", "focus-scrub-thumb");
  const bubble = el("div", { class: "focus-scrub-bubble", hidden: true, "aria-hidden": "true" });
  const track = el("div", {
    class: "focus-scrub-track",
    role: "slider",
    tabIndex: 0,
    "aria-label": "Timeline of this panorama",
    "aria-orientation": "horizontal",
  }, el("div", "focus-scrub-rail", fill), turnLayer, markLayer, thumb, bubble);
  const scaleStart = el("span", "num");
  const scaleEnd = el("span", "num");
  const scale = el("div", { class: "focus-scrub-scale dim xsmall", "aria-hidden": "true" }, scaleStart, scaleEnd);

  const previousTurn = stepButton("Turn", "Start of the previous turn ( [ )", "chevron-left", () => step("turn", -1));
  const nextTurn = stepButton("Turn", "Start of the next turn ( ] )", "chevron-right", () => step("turn", 1));
  const previousMark = stepButton("Mark", "Previous mark ( , )", "chevron-left", () => step("mark", -1));
  const nextMark = stepButton("Mark", "Next mark ( . )", "chevron-right", () => step("mark", 1));
  const readout = el("div", "focus-scrub-readout num");
  const controls = el("div", "focus-scrub-controls",
    el("div", { class: "btn-group", role: "group", "aria-label": "Step by turn" }, previousTurn, nextTurn),
    el("div", { class: "btn-group", role: "group", "aria-label": "Step by mark" }, previousMark, nextMark),
    readout);

  const legend = el("div", { class: "focus-scrub-legend xsmall dim" });
  const stateBox = el("div", { class: "focus-scrub-state", hidden: true });
  const body = el("div", "focus-scrub-body", el("div", "focus-scrub-trackbox", track, scale), controls);
  const root = el("section", { class: "focus-scrub", "aria-label": "Timeline", dataset: { mode: "ended" } },
    bannerLine, stateBox, body, legend);
  container.append(root);

  // ---- drawing

  function drawModel() {
    const ready = phase === "ready" && model && model.entries.length > 0;
    body.hidden = !ready;
    legend.hidden = !ready;
    if (!ready) return;
    let lastLabelled = -1;
    replace(turnLayer, model.turns.map((turn) => {
      const labelled = turn.pos - lastLabelled >= TURN_LABEL_GAP;
      if (labelled) lastLabelled = turn.pos;
      const node = el("span", { class: "focus-scrub-turn", dataset: { seq: String(turn.seq) } },
        labelled ? el("span", "focus-scrub-turn-n num", String(turn.turn)) : null);
      node.style.left = percent(turn.pos);
      return node;
    }));
    replace(markLayer, model.marks.map((mark) => {
      const node = el("span", { class: "focus-scrub-mark", dataset: { kind: mark.kind, seq: String(mark.seq) } });
      node.style.left = percent(mark.pos);
      return node;
    }));
    if (model.axis === "time") {
      scaleStart.textContent = fmtClock(0);
      scaleEnd.textContent = fmtClock(model.span);
    } else {
      // After a retry the clock starts again, so the track counts events instead.
      scaleStart.textContent = "event 1";
      scaleEnd.textContent = "event " + model.entries.length + " (the clock restarted in this log, so events are evenly spaced)";
    }
    replace(legend,
      el("span", "focus-scrub-key", el("span", "focus-scrub-turn is-key"), "start of a turn"),
      model.kinds.map((kind) => el("span", "focus-scrub-key", el("span", { class: "focus-scrub-mark is-key", dataset: { kind } }), kindLabel(kind))));
  }

  function drawCursor() {
    if (phase !== "ready" || !model || !model.entries.length) return;
    const shown = dragging ? dragSeq : at;
    const position = positionOf(model, shown);
    const where = describeCursor(model, shown);
    thumb.style.left = percent(position);
    fill.style.width = percent(position);
    const cursor = shown === null ? Infinity : shown;
    for (const layer of [turnLayer, markLayer]) {
      for (const node of layer.children) node.classList.toggle("is-later", Number(node.dataset.seq) > cursor);
    }
    const live = shown === null;
    replace(readout,
      el("span", "focus-scrub-readout-main", where.text),
      where.markText ? el("span", "focus-scrub-readout-mark", where.markText) : null);
    track.setAttribute("aria-valuemin", "1");
    track.setAttribute("aria-valuemax", String(Math.max(1, where.total)));
    track.setAttribute("aria-valuenow", String(Math.max(1, where.index)));
    track.setAttribute("aria-valuetext", where.text + (where.markText ? ", " + where.markText : "") + (live ? ", latest state" : ", replay"));
    previousTurn.disabled = !canStep(model, shown, -1);
    previousMark.disabled = !canStep(model, shown, -1);
    nextTurn.disabled = !canStep(model, shown, 1);
    nextMark.disabled = !canStep(model, shown, 1);
  }

  function drawBanner() {
    root.dataset.mode = banner.mode;
    const icons = { replay: "clock", live: "play", waiting: "clock", ended: "check" };
    replace(bannerIcon, icon(icons[banner.mode] || "info"));
    bannerText.textContent = banner.text;
    backButton.hidden = !banner.back;
    if (banner.back) replace(backButton, icon("arrow-right"), banner.back);
  }

  function drawState(...children) {
    replace(stateBox, children);
    stateBox.hidden = children.length === 0;
  }

  // ---- pointer

  function seqAtPointer(event) {
    const box = track.getBoundingClientRect();
    if (!box.width) return null;
    return seqAtPosition(model, (event.clientX - box.left) / box.width, { snap: SNAP_PX / box.width });
  }

  function showBubble(event) {
    if (!model || !model.entries.length) return;
    const seq = seqAtPointer(event);
    if (seq === null) return;
    const where = describeCursor(model, seq);
    bubble.textContent = where.text + (where.markText ? " · " + where.markText : "");
    const entry = entryAt(model, seq);
    bubble.style.left = percent(entry ? entry.pos : 0);
    bubble.dataset.side = entry && entry.pos > 0.75 ? "left" : entry && entry.pos < 0.25 ? "right" : "middle";
    bubble.hidden = false;
  }

  function onPointerDown(event) {
    if (event.button !== 0 || !model || !model.entries.length) return;
    const seq = seqAtPointer(event);
    if (seq === null) return;
    // The press itself gives the track the focus, so the arrow keys work straight after a drag.
    dragging = true;
    dragSeq = resolveCursor(model, seq);
    root.classList.add("is-dragging");
    if (typeof track.setPointerCapture === "function") {
      try {
        track.setPointerCapture(event.pointerId);
      } catch (_) {
        // a pointer that is already gone: the drag ends with the next event anyway
      }
    }
    drawCursor();
    showBubble(event);
    seek(dragSeq, false);
  }

  function onPointerMove(event) {
    if (!dragging) {
      showBubble(event);
      return;
    }
    const seq = seqAtPointer(event);
    if (seq === null) return;
    const next = resolveCursor(model, seq);
    showBubble(event);
    if (next === dragSeq) return;
    dragSeq = next;
    drawCursor();
    seek(dragSeq, false);
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("is-dragging");
    const seq = dragSeq;
    dragSeq = null;
    at = seq;
    drawCursor();
    seek(seq, true);
  }

  function onKeyDown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || !model || !model.entries.length) return;
    let next;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = stepEvent(model, at, -1);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = stepEvent(model, at, 1);
    else if (event.key === "PageUp") next = stepTurn(model, at, -1);
    else if (event.key === "PageDown") next = stepTurn(model, at, 1);
    else if (event.key === "Home") next = resolveCursor(model, model.first);
    else if (event.key === "End") next = null;
    else return;
    event.preventDefault();
    event.stopPropagation();
    seek(next, true);
  }

  track.addEventListener("pointerdown", onPointerDown);
  track.addEventListener("pointermove", onPointerMove);
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);
  track.addEventListener("lostpointercapture", endDrag);
  track.addEventListener("pointerleave", () => { if (!dragging) bubble.hidden = true; });
  track.addEventListener("keydown", onKeyDown);

  function step(kind, direction) {
    if (destroyed || !model || !model.entries.length) return;
    const fn = kind === "turn" ? stepTurn : kind === "mark" ? stepMark : stepEvent;
    seek(fn(model, at, direction), true);
  }

  drawBanner();
  setLoading();

  function setLoading() {
    if (destroyed || (model && model.entries.length)) return;
    phase = "loading";
    drawState(el("span", "dim", el("span", "spinner"), " Loading the timeline of this panorama…"));
    drawModel();
  }

  return {
    el: root,

    /** The timeline (logic/replay.js timelineModel). An empty one shows the "no events" state. */
    setModel(next) {
      if (destroyed) return;
      model = next || null;
      phase = "ready";
      if (!model || !model.entries.length) {
        drawState(el("span", "dim", icon("info"), " No events yet. The timeline appears when this panorama starts."));
      } else drawState();
      drawModel();
      drawCursor();
    },

    /** Where the page is: a seq, or null for live. Ignored while the thumb is being dragged. */
    setCursor(next) {
      if (destroyed) return;
      at = next === null || next === undefined ? null : Number(next);
      if (!dragging) drawCursor();
    },

    /** The line above the track: `{mode: "live"|"waiting"|"ended"|"replay", text, back}` (logic bannerModel). */
    setBanner(next) {
      if (destroyed || !next) return;
      if (next.mode === banner.mode && next.text === banner.text && next.back === banner.back) return;
      banner = next;
      drawBanner();
    },

    setLoading,

    /** The inspect request failed and there is no timeline to show. */
    setError(err) {
      if (destroyed || (model && model.entries.length)) return;
      phase = "error";
      drawState(el("div", "notice notice-bad",
        icon("alert"),
        el("div", "grow stack tight",
          el("div", "strong", "The timeline could not be loaded, so this panorama cannot be replayed yet."),
          el("div", "pre", errorText(err)),
          typeof onRetry === "function"
            ? el("div", null, el("button", { type: "button", class: "small", onclick: () => onRetry() }, icon("refresh"), "Try again"))
            : null)));
      drawModel();
    },

    step,

    focus() {
      if (!destroyed) track.focus();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      dragging = false;
      root.remove();
    },
  };
}
