// The panorama tile (UI-SPEC 5.4 and 5.5): what the operator looks at during the scoring hour.
//
//   createTile(container, {runId, pid, density: "board"|"tiles"|"focus", replay?, onSelect?})
//
// and the parts the focus screen composes itself: tileHead, timeBar, confidenceLine,
// hypothesisTable, answerList, plus panoSources for the viewer.
//
// A dashboard shows six or more tiles and each gets a new TileState several times a second, so
// nothing here rebuilds on update: every part keeps its nodes and writes only what changed. The
// viewer, the map and the stream are created once, when the tile first comes on screen, and not
// at all for a board row. Clocks tick from one shared timer.
//
// Rule compliance: a tile reads state and places the operator controls of components/controls.js.
// It has no input of its own that reaches the agent, and it never uses the penalty colour.
// Coordinates are copy-only; every link goes to a route of this app (decision U2, contract A30).

import { api, errorText, panoUrl } from "../api.js";
import { badge, copyButton, el, icon, replace, statusBadge, syncList } from "../dom.js";
import { fmtClock, fmtCoord } from "../format.js";
import { attentionFor, attentionItems } from "../logic/attention.js";
import {
  answerModel,
  chosenPoint,
  confidence,
  deadlineModel,
  flagModel,
  humanWindow,
  hypothesisRows,
  isFinal,
  liveness,
  multiplierModel,
  panoSources as buildPanoSources,
  sourcesKey,
  spendModel,
  thumbUrl,
  tileStatus,
  topHypothesis,
  turnText,
  viewerCrops,
} from "../logic/tile.js";
import { navigate, paths, setQuery } from "../router.js";
import { store } from "../store.js";
import { controlBar, mcqPanel } from "./controls.js";
import { createMap } from "./map.js";
import { createPanoViewer } from "./pano-viewer.js";
import { createStream } from "./stream.js";

const TICK_MS = 500;
const HEAVY_MARGIN_PX = 400; // the viewer, map and stream are built this far before they scroll in
const SPECIAL_BANNER = "SPECIAL ONE · SCORE x3";
const PROXY_HELP =
  "Expected-score proxy: multiplier x 16,050 x the expected theta of the chosen point under the agent's own " +
  "hypotheses (x3 for the Special One). It is the agent's own belief, not a score. Use it to decide where review time is best spent.";

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

const isPlainClick = (event) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

// Only the app's own paths are ever put in an href.
function appPath(path) {
  const text = String(path ?? "");
  return text.startsWith("/") && !text.startsWith("//") && !text.startsWith("/\\") ? text : "/";
}

/**
 * An <a> to a route of the app. A plain click calls `activate(event)` when given (and nothing
 * else), otherwise it navigates inside the app; a modified click keeps the browser's behaviour.
 */
function routeLink(path, attrs, activate, ...children) {
  const anchor = el("a", attrs || {}, ...children);
  anchor.setAttribute("href", appPath(path));
  anchor.addEventListener("click", (event) => {
    if (event.defaultPrevented || !isPlainClick(event)) return;
    event.preventDefault();
    if (activate) activate(event);
    else navigate(anchor.getAttribute("href"));
  });
  return anchor;
}

function labelBadge(label) {
  if (label === "Urban") return badge("Urban", "urban");
  if (label === "non-Urban") return badge("non-Urban", "nonurban");
  return badge(label ? String(label) : "no label", "dim");
}

// ---------------------------------------------------------------- shared clock and attention

// One timer for every tile on the page: countdowns and "last event" ages tick from it.
const tickers = new Set();
let tickTimer = null;

function runTick() {
  if (typeof document !== "undefined" && document.hidden) return;
  for (const fn of Array.from(tickers)) {
    try {
      fn();
    } catch (err) {
      console.error("tile tick failed", err);
    }
  }
}

function onTick(fn) {
  tickers.add(fn);
  if (tickTimer === null) tickTimer = setInterval(runTick, TICK_MS);
  return () => {
    tickers.delete(fn);
    if (!tickers.size && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

// The inbox items are the same for every tile: compute them once per state and second.
let attention = { state: null, second: -1, items: [] };

function currentAttention() {
  const now = Date.now();
  const second = Math.floor(now / 1000);
  if (attention.state !== store.state || attention.second !== second) {
    attention = { state: store.state, second, items: attentionItems(store.state, now) };
  }
  return attention.items;
}

// Creating a viewer compiles shaders and creating a map lays out panes: a dashboard that opens
// with ten tiles on screen builds them one per task, so that clicks and paints get in between.
// A timer, not an animation frame: a tab in the background must still get its tiles built.
const heavyQueue = [];
let heavyTimer = null;

function drainHeavy() {
  heavyTimer = null;
  const build = heavyQueue.shift();
  if (heavyQueue.length) heavyTimer = setTimeout(drainHeavy, 0);
  if (build) {
    try {
      build();
    } catch (err) {
      console.error("tile build failed", err);
    }
  }
}

function queueHeavy(build) {
  heavyQueue.push(build);
  if (heavyTimer === null) heavyTimer = setTimeout(drainHeavy, 0);
  return () => {
    const at = heavyQueue.indexOf(build);
    if (at !== -1) heavyQueue.splice(at, 1);
  };
}

// ---------------------------------------------------------------- sources

/** Sources for createPanoViewer, smallest first: `[{width, url}]` (previews, then the original). */
export function panoSources(runId, pid, tile) {
  return buildPanoSources(runId, pid, tile);
}

// ---------------------------------------------------------------- head

/**
 * Head of a tile: id, file name, label, the Special One banner, status, and the multiplier with
 * its ledger written out ("x0.76 = 0.8 cue x 0.95 MCQ").
 * opts: {runId, pid, link = true (the id opens the focus screen), replay = false}.
 */
export function tileHead(container, { runId, pid, link = true, replay = false } = {}) {
  const idText = el("span", "tile-id mono", String(pid ?? ""));
  const idNode = link
    ? routeLink(paths.pano(runId, pid), { class: "tile-id-link", title: "Open this panorama on its own page" }, null, idText)
    : idText;
  const file = el("span", "tile-file dim small");
  const labelSlot = el("span", "tile-slot");
  const statusSlot = el("span", "tile-slot");
  const multValue = el("span", "tile-mult-value num");
  const multDetail = el("span", "tile-mult-detail mono");
  const mult = el("span", { class: "tile-mult", "aria-label": "Score multiplier" }, multValue, multDetail);
  const banner = el("div", { class: "tile-special", hidden: true }, icon("star"), el("span", null, SPECIAL_BANNER));
  const line = el("div", "tile-head-line",
    el("div", "tile-head-main", idNode, labelSlot, statusSlot, file),
    mult);
  const root = el("header", "tile-head", banner, line);
  container.append(root);

  return {
    el: root,
    update(tile) {
      if (!tile) return;
      setText(idText, tile.panorama_id ?? pid);
      setText(file, tile.filename && tile.filename !== tile.panorama_id ? tile.filename : "");
      setTitle(file, tile.filename || "");
      swap(labelSlot, tile.label, () => labelBadge(tile.label));
      const status = tileStatus(tile, { replay });
      swap(statusSlot, status, () => statusBadge(status));
      setHidden(banner, !tile.special);
      const cost = multiplierModel(tile);
      setText(multValue, cost.text);
      setText(multDetail, cost.detail);
      mult.classList.toggle("is-reduced", cost.reduced);
      setTitle(mult, "Score multiplier: " + cost.full);
    },
    destroy() {
      root.remove();
    },
  };
}

// ---------------------------------------------------------------- time bar

/**
 * Time bar with the soft and hard marks, the human-window line, turn n/max and the age of the
 * last event ("stalled" after 60 s of silence). Ticks by itself from the store clock.
 * opts: {compact = false (the board row: clock, bar and a one-line window), replay = false
 * (frozen at the tile's own elapsed time, no ticking)}.
 */
export function timeBar(container, { compact = false, replay = false } = {}) {
  const clock = el("span", "tile-clock num");
  const phase = el("span", "tile-phase");
  const turn = el("span", "tile-turn num");
  const spend = el("span", "tile-spend num");
  const stalled = badge("stalled", "bad", "alert");
  stalled.hidden = true;
  const liveText = el("span", "tile-live-text");
  const live = el("span", "tile-live", stalled, liveText);
  const fill = el("div", "tile-bar-fill");
  const softMark = el("span", { class: "tile-bar-mark is-soft", hidden: true });
  const cueMark = el("span", { class: "tile-bar-mark is-cue", hidden: true });
  const bar = el("div", {
    class: "tile-bar",
    role: "progressbar",
    "aria-label": "Time used against the hard deadline",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
  }, fill, softMark, cueMark);
  const softLabel = el("span", { class: "tile-bar-label is-soft num", hidden: true });
  const hardLabel = el("span", { class: "tile-bar-label is-hard num", hidden: true });
  const scale = el("div", { class: "tile-bar-scale", "aria-hidden": "true" }, softLabel, hardLabel);
  const windowIcon = el("span", "tile-window-icon");
  const windowText = el("span", "tile-window-text");
  const windowDetail = el("span", "tile-window-detail dim");
  const windowLine = el("div", { class: "tile-window", hidden: true }, windowIcon, windowText, windowDetail);

  const root = compact
    ? el("div", "tile-time is-compact", el("div", "tile-time-row", clock, turn, live), bar, windowLine)
    : el("div", "tile-time", el("div", "tile-time-row", clock, phase, turn, spend, live), bar, scale, windowLine);
  container.append(root);

  let tile = null;
  let shownWidth = "";

  function render() {
    if (!tile) return;
    const options = { replay };
    const elapsed = replay ? Number(tile.elapsed_s) || 0 : store.elapsed(tile);
    const deadline = deadlineModel(tile, elapsed, options);
    setText(clock, deadline.clock);
    setText(phase, deadline.text);
    setText(turn, turnText(tile));
    const cost = spendModel(tile);
    setText(spend, cost ? cost.text : "");
    setTitle(spend, cost ? "Spend of this panorama against its cap" + (cost.near ? ": close to the cap, where the harness finalises it" : "") : "");
    spend.classList.toggle("warn-text", Boolean(cost && cost.near));
    setData(root, "tone", deadline.tone);
    setData(root, "phase", deadline.phase);

    const width = (deadline.fraction * 100).toFixed(1) + "%";
    if (width !== shownWidth) {
      shownWidth = width;
      fill.style.width = width;
      bar.setAttribute("aria-valuenow", String(Math.round(deadline.fraction * 100)));
    }
    bar.setAttribute("aria-valuetext", deadline.clock + ", " + deadline.text);
    setHidden(softMark, deadline.softFraction === null);
    setHidden(softLabel, deadline.softFraction === null);
    setHidden(hardLabel, !deadline.known);
    if (deadline.softFraction !== null) {
      const at = (deadline.softFraction * 100).toFixed(2) + "%";
      if (softMark.style.left !== at) {
        softMark.style.left = at;
        softLabel.style.left = at;
      }
      setText(softLabel, "soft " + fmtClock(deadline.soft));
      setTitle(softMark, "Soft deadline: the agent is told to commit now");
    }
    if (deadline.known) setText(hardLabel, "hard " + fmtClock(deadline.hard));
    setHidden(cueMark, deadline.cueFraction === null);
    if (deadline.cueFraction !== null) {
      const at = (deadline.cueFraction * 100).toFixed(2) + "%";
      if (cueMark.style.left !== at) cueMark.style.left = at;
      setTitle(cueMark, "After this point a cue no longer reaches the agent");
    }

    const state = replay ? null : liveness(tile, Date.now(), store.state.serverOffsetMs, options);
    setHidden(live, !state);
    if (state) {
      setHidden(stalled, !state.stalled);
      setText(liveText, state.text);
      setData(live, "tone", state.tone);
      setTitle(live, state.hint || state.text);
    }

    const human = humanWindow(tile, elapsed, options);
    setHidden(windowLine, !human);
    if (human) {
      setData(windowLine, "tone", human.tone);
      swap(windowIcon, human.state, () => icon(human.state === "closed" ? "lock" : "clock"));
      setText(windowText, compact ? human.short : human.text);
      setText(windowDetail, human.detail || "");
      setHidden(windowDetail, compact || !human.detail);
      setTitle(windowLine, compact ? human.text + (human.detail ? " (" + human.detail + ")" : "") : "");
    }
  }

  const stopTick = replay ? null : onTick(render);

  return {
    el: root,
    update(next) {
      tile = next || null;
      render();
    },
    destroy() {
      if (stopTick) stopTick();
      tile = null;
      root.remove();
    },
  };
}

// ---------------------------------------------------------------- confidence

/**
 * "How sure is it?": top probability, clusters, the distance between the top two, the
 * "multi-modal" flag with the gate's reason, and the expected-score proxy, labelled as the
 * agent's own belief.
 */
export function confidenceLine(container) {
  const top = el("span", "tile-conf-top num");
  const clusters = el("span", "tile-conf-item num");
  const gap = el("span", "tile-conf-item num");
  const mode = el("span", "tile-slot");
  const gate = el("span", "tile-conf-gate dim small");
  const proxyValue = el("span", "tile-conf-proxy-value num");
  const proxy = el("span", { class: "tile-conf-proxy", title: PROXY_HELP, hidden: true },
    el("span", "tile-conf-proxy-label", "agent's own belief"), proxyValue, el("span", "dim", "not a score"));
  const root = el("div", "tile-conf", top, clusters, gap, mode, gate, proxy);
  container.append(root);

  return {
    el: root,
    update(tile) {
      if (!tile) return;
      const model = confidence(tile);
      setText(top, model.topText);
      top.classList.toggle("dim", !model.hasBelief);
      setText(clusters, model.clustersText || "");
      setHidden(clusters, !model.clustersText);
      setText(gap, model.gapText || "");
      setHidden(gap, !model.gapText);
      const modeKey = !model.hasBelief ? "none" : model.multimodal ? "multi" : "single";
      swap(mode, modeKey, () => {
        if (modeKey === "multi") return badge("multi-modal", "warn", "layers");
        if (modeKey === "single") return badge("single mode", "dim", "target");
        return null;
      });
      setText(gate, model.hasBelief && model.gateReason ? "question gate: " + model.gateReason : "");
      setTitle(gate, model.gateReason ? "Why the agent may or may not ask a question now (SPEC 7.2): " + model.gateReason : "");
      setHidden(gate, !(model.hasBelief && model.gateReason));
      setHidden(proxy, !model.proxy);
      if (model.proxy) setText(proxyValue, model.proxy.text);
    },
    destroy() {
      root.remove();
    },
  };
}

// ---------------------------------------------------------------- hypotheses

/**
 * The hypothesis table: probability, label, radius, coordinates with a copy button, and the
 * evidence behind a toggle. Hovering or focusing a row calls `onHover(index)` with its index in
 * `tile.hypotheses` (null on leave); `highlight(index|null)` marks a row from outside (the map,
 * an MCQ option).
 */
export function hypothesisTable(container, { onHover = null } = {}) {
  const header = el("div", { class: "tile-hyp tile-hyp-header", "aria-hidden": "true" },
    el("span", "tile-hyp-prob", "P"),
    el("span", "tile-hyp-label", "Hypothesis"),
    el("span", "tile-hyp-radius", "Radius"),
    el("span", "tile-hyp-coords", "Coordinates"),
    el("span", "tile-hyp-more"));
  const rowsNode = el("div", { class: "tile-hyp-rows", role: "list" });
  const empty = el("p", { class: "tile-empty dim", hidden: true },
    "No hypotheses yet. They appear when the agent first records its candidates.");
  const root = el("div", "tile-hyps", header, rowsNode, empty);
  container.append(root);

  const views = new WeakMap();
  let shown = "";
  let hot = null;
  let hovering = null;

  const say = (index) => {
    if (hovering === index) return;
    hovering = index;
    if (onHover) onHover(index);
  };

  function create(row) {
    const meter = el("span", "tile-hyp-meter");
    const prob = el("span", "tile-hyp-prob num", meter, el("span", "tile-hyp-prob-text"));
    const label = el("span", "tile-hyp-label");
    const radius = el("span", "tile-hyp-radius num dim");
    const coordsText = el("span", "mono");
    const view = { row, coordsText };
    const coords = el("span", "tile-hyp-coords", coordsText,
      copyButton(() => view.row.coords, { title: "Copy these coordinates" }));
    const evidence = el("div", { class: "tile-hyp-evidence", hidden: true });
    const toggle = el("button", {
      type: "button",
      class: "icon-btn small tile-hyp-toggle",
      "aria-expanded": "false",
      title: "Show the evidence",
      "aria-label": "Show the evidence",
    }, icon("chevron-down"));
    toggle.addEventListener("click", () => {
      const open = evidence.hidden;
      evidence.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      const title = open ? "Hide the evidence" : "Show the evidence";
      toggle.title = title;
      toggle.setAttribute("aria-label", title);
      replace(toggle, icon(open ? "chevron-up" : "chevron-down"));
    });
    // Radius and coordinates are two columns of a wide table and one line of a narrow one.
    const node = el("div", { class: "tile-hyp", role: "listitem" },
      prob, label, el("span", "tile-hyp-meta", radius, coords), el("span", "tile-hyp-more", toggle), evidence);
    node.addEventListener("mouseenter", () => say(view.row.index));
    node.addEventListener("mouseleave", () => say(null));
    node.addEventListener("focusin", () => say(view.row.index));
    node.addEventListener("focusout", (event) => {
      if (!node.contains(event.relatedTarget)) say(null);
    });
    Object.assign(view, { meter, probText: prob.lastChild, label, radius, evidence, toggle });
    views.set(node, view);
    return node;
  }

  function refresh(node, row) {
    const view = views.get(node);
    view.row = row;
    setData(node, "index", row.index);
    setText(view.probText, row.probabilityText);
    const width = Math.round(Math.min(1, Math.max(0, row.probability)) * 100) + "%";
    if (view.meter.style.width !== width) view.meter.style.width = width;
    setText(view.label, row.label);
    setTitle(view.label, row.label);
    setText(view.radius, row.radiusText);
    setTitle(view.radius, "Uncertainty radius the agent gave");
    setText(view.coordsText, row.coords || "–");
    setText(view.evidence, row.evidence);
    setHidden(view.toggle, !row.evidence);
    if (!row.evidence) setHidden(view.evidence, true);
    node.classList.toggle("is-highlight", row.index === hot);
  }

  function mark() {
    for (const node of rowsNode.children) node.classList.toggle("is-highlight", Number(node.dataset.index) === hot);
  }

  return {
    el: root,
    update(tile) {
      if (!tile) return;
      const key = JSON.stringify(tile.hypotheses || []);
      if (key === shown) return;
      shown = key;
      const rows = hypothesisRows(tile);
      syncList(rowsNode, rows, (row) => row.key, create, refresh);
      setHidden(empty, rows.length > 0);
      setHidden(header, rows.length === 0);
      // A row that went away while the pointer was on it never sends its "leave".
      if (hovering !== null && !rows.some((row) => row.index === hovering)) say(null);
    },
    highlight(index) {
      const next = typeof index === "number" && Number.isFinite(index) ? index : null;
      if (next === hot) return;
      hot = next;
      mark();
    },
    destroy() {
      root.remove();
    },
  };
}

// ---------------------------------------------------------------- answer list

/**
 * The answer list: ten rows (rank, lat, lng, multiplier, origin), or "10 x the same point" when
 * they are identical. Titled "Provisional answer" until final. Below it, in words: how the
 * panorama ended, where the answer came from, and what the allocator did with the ten slots.
 * opts: {replay = false}.
 */
export function answerList(container, { replay = false } = {}) {
  const title = el("h4", "section-title tile-answer-title");
  const stateSlot = el("span", "tile-answer-state");
  const copyAll = copyButton(() => model.copyAll, { label: "Copy all", title: "Copy the ten coordinates, one per line" });
  copyAll.classList.add("tile-copy-all");
  const head = el("div", "tile-answer-head", title, stateSlot, copyAll);

  const summaryText = el("span", "tile-answer-point mono");
  const summaryMult = el("span", "num dim");
  const summaryOrigin = el("span", "dim");
  const summary = el("div", { class: "tile-answer-summary", hidden: true },
    summaryText, copyButton(() => (model.rows[0] ? model.rows[0].coords : ""), { title: "Copy these coordinates" }),
    summaryMult, summaryOrigin);

  const body = el("tbody");
  const table = el("table", "table compact tile-answer-table",
    el("thead", null, el("tr", null,
      el("th", "r", "#"), el("th", "r", "Lat"), el("th", "r", "Lng"), el("th", "r", "Mult."), el("th", null, "Origin"), el("th", null, el("span", "sr-only", "Copy")))),
    body);
  const tableWrap = el("div", { class: "tile-answer-rows", hidden: true }, table);
  const empty = el("p", { class: "tile-empty dim", hidden: true });
  const problem = el("div", { class: "notice notice-warn", hidden: true }, icon("alert"), el("span"));

  const ended = el("dd");
  const origin = el("dd");
  const plan = el("dd");
  const endedRow = [el("dt", null, "Ended"), ended];
  const originRow = [el("dt", null, "Origin"), origin];
  const planRow = [el("dt", null, "Plan"), plan];
  const facts = el("dl", "kv tile-answer-facts", endedRow, originRow, planRow);
  const root = el("div", { class: "tile-answer" }, head, summary, tableWrap, empty, problem, facts);
  container.append(root);

  let model = answerModel(null, { replay });
  let shown = "";
  const rowViews = new WeakMap();

  function createRow(row) {
    const view = { row };
    const cells = {
      rank: el("td", "r num"),
      lat: el("td", "r mono"),
      lng: el("td", "r mono"),
      mult: el("td", "r num"),
      origin: el("td"),
    };
    const node = el("tr", null, cells.rank, cells.lat, cells.lng, cells.mult, cells.origin,
      el("td", null, copyButton(() => view.row.coords, { title: "Copy these coordinates" })));
    Object.assign(view, cells);
    rowViews.set(node, view);
    return node;
  }

  function refreshRow(node, row) {
    const view = rowViews.get(node);
    view.row = row;
    setText(view.rank, row.rank);
    setText(view.lat, fmtCoord(row.lat));
    setText(view.lng, fmtCoord(row.lng));
    setText(view.mult, row.multiplierText);
    setText(view.origin, row.originText);
    view.origin.classList.toggle("warn-text", row.origin === "harness_fallback");
  }

  function pair(nodes, text) {
    for (const node of nodes) setHidden(node, !text);
  }

  return {
    el: root,
    update(tile) {
      if (!tile) return;
      const key = JSON.stringify([tile.final, tile.provisional, tile.origin, tile.stop_text, tile.plan_text, tile.status, tile.live]);
      if (key === shown) return;
      shown = key;
      model = answerModel(tile, { replay });
      setData(root, "state", model.state);
      setText(title, model.title);
      swap(stateSlot, model.state, () => {
        if (model.state === "none") return null;
        const mark = { final: "check", provisional: "clock", stranded: "alert" }[model.state];
        return [icon(mark), el("span", null, model.stateText)];
      });
      setHidden(copyAll, !model.rows.length);

      setHidden(summary, !model.identical);
      if (model.identical) {
        const first = model.rows[0];
        setText(summaryText, model.summary);
        setText(summaryMult, first.multiplierText);
        setText(summaryOrigin, first.originText ? "origin: " + first.originText : "");
        summaryOrigin.classList.toggle("warn-text", first.origin === "harness_fallback");
      }
      // The one-line form already names the origin of all ten entries.
      const originSaid = model.identical && model.rows[0].originText === model.originText;
      const tabular = model.rows.length > 0 && !model.identical;
      setHidden(tableWrap, !tabular);
      syncList(body, tabular ? model.rows : [], (row) => row.rank, createRow, refreshRow);

      setHidden(empty, model.rows.length > 0);
      setText(empty, model.emptyText);
      setHidden(problem, !model.countProblem);
      if (model.countProblem) setText(problem.lastChild, model.countProblem + ". Open Submission to check the export.");

      setText(ended, model.stopText);
      pair(endedRow, model.stopText);
      setText(origin, model.originText);
      origin.classList.toggle("warn-text", model.fallback);
      pair(originRow, originSaid ? "" : model.originText);
      setText(plan, model.planText);
      pair(planRow, model.planText);
      setHidden(facts, !(model.stopText || (model.originText && !originSaid) || model.planText));
    },
    destroy() {
      root.remove();
    },
  };
}

// ---------------------------------------------------------------- attention flags

// Flags of one panorama, from the same items as the inbox. `asLinks` false renders plain marks
// (a board row is already one link).
function flagStrip(container, { runId, pid, asLinks, onActivate }) {
  const root = el("div", { class: "tile-flags", hidden: true, role: "group", "aria-label": "Needs attention" });
  container.append(root);
  const views = new WeakMap();

  function create(flag) {
    const view = { flag };
    const text = el("span", "tile-flag-text");
    const node = asLinks
      ? routeLink(flag.href, { class: "tile-flag" }, (event) => onActivate(view.flag, event), icon(flag.icon), text)
      : el("span", { class: "tile-flag" }, icon(flag.icon), text);
    view.text = text;
    views.set(node, view);
    return node;
  }

  function refresh(node, flag) {
    const view = views.get(node);
    view.flag = flag;
    setText(view.text, asLinks ? flag.text : flag.short);
    setTitle(node, flag.text);
    setData(node, "tone", flag.tone);
    if (asLinks && node.getAttribute("href") !== appPath(flag.href)) node.setAttribute("href", appPath(flag.href));
  }

  let first = null;
  return {
    el: root,
    /** Re-read the inbox. Returns the most urgent flag of this panorama, or null. */
    render() {
      const flags = attentionFor(currentAttention(), runId, pid).map(flagModel);
      syncList(root, flags, (flag) => flag.id, create, refresh);
      setHidden(root, flags.length === 0);
      first = flags[0] || null;
      return first;
    },
    destroy() {
      root.remove();
    },
  };
}

// ---------------------------------------------------------------- board row

/**
 * Column titles for a list of board rows; the columns line up with `createTile(..., {density:
 * "board"})`. Returns the element (not appended).
 */
export function tileBoardHeader() {
  return el("div", { class: "tile-board tile-board-header", "aria-hidden": "true" },
    el("div", "tile-b-grid",
      el("div", "tile-b-thumb"),
      el("div", "tile-b-id", "Panorama"),
      el("div", "tile-b-status", "Status"),
      el("div", "tile-b-time", "Time"),
      el("div", "tile-b-top", "Top hypothesis"),
      el("div", "tile-b-mult", "Multiplier"),
      el("div", "tile-b-flags", "Needs attention")));
}

function boardTile(container, { runId, pid, replay, onSelect }) {
  const image = el("img", { class: "tile-b-img", alt: "", loading: "lazy", decoding: "async" });
  const thumb = el("div", "tile-b-thumb", image, el("span", "tile-b-noimg", icon("image")));
  image.addEventListener("error", () => thumb.classList.add("is-missing"));
  image.addEventListener("load", () => thumb.classList.remove("is-missing"));
  // Built from the run and panorama ids only: an API path of this app.
  image.src = thumbUrl(runId, pid);

  const idText = el("span", "tile-id mono", String(pid));
  const file = el("span", "tile-file dim xsmall");
  const labelSlot = el("span", "tile-slot");
  const specialMark = badge("SPECIAL ONE x3", "special", "star");
  specialMark.hidden = true;
  const statusSlot = el("span", "tile-slot");
  const timeCell = el("div", "tile-b-time");
  const topLabel = el("span", "tile-b-top-label");
  const topProb = el("span", "tile-b-top-prob num");
  const answerMark = el("span", "tile-b-answer xsmall");
  const multValue = el("span", "tile-mult-value num");
  const multDetail = el("span", "tile-b-ledger xsmall dim");
  const multCell = el("div", "tile-b-mult", multValue, multDetail);
  const flagCell = el("div", "tile-b-flags");

  const root = routeLink(paths.pano(runId, pid), {
    class: "tile tile-board is-waiting",
    dataset: { pid: String(pid), run: String(runId) },
  }, onSelect ? () => onSelect(pid) : null,
    el("div", "tile-b-grid",
      thumb,
      el("div", "tile-b-id", el("div", "tile-b-id-line", idText, labelSlot, specialMark), file),
      el("div", "tile-b-status", statusSlot),
      timeCell,
      el("div", "tile-b-top", el("div", "tile-b-top-line", topProb, topLabel), answerMark),
      multCell,
      flagCell));
  container.append(root);

  const time = timeBar(timeCell, { compact: true, replay });
  const flags = flagStrip(flagCell, { runId, pid, asLinks: false });
  let tile = null;
  let destroyed = false;

  // The row leads to the control that resolves its most urgent flag, as the inbox does.
  function renderFlags() {
    if (destroyed || replay || !tile) return;
    const first = flags.render();
    const href = appPath(first ? first.href : paths.pano(runId, pid));
    if (root.getAttribute("href") !== href) root.setAttribute("href", href);
  }
  const stopTick = replay ? null : onTick(renderFlags);

  return {
    el: root,
    update(next) {
      if (destroyed) return;
      if (next === tile) return;
      tile = next || null;
      root.classList.toggle("is-waiting", !tile);
      if (!tile) return;
      const status = tileStatus(tile, { replay });
      setData(root, "status", status);
      root.classList.toggle("is-special", Boolean(tile.special));
      setText(idText, tile.panorama_id ?? pid);
      setText(file, tile.filename && tile.filename !== tile.panorama_id ? tile.filename : "");
      swap(labelSlot, tile.label, () => labelBadge(tile.label));
      setHidden(specialMark, !tile.special);
      swap(statusSlot, status, () => statusBadge(status));
      time.update(tile);

      const top = topHypothesis(tile);
      setText(topProb, top ? Math.round(top.probability * 100) + "%" : "");
      setText(topLabel, top ? top.label || "(no label)" : "no hypothesis yet");
      setTitle(topLabel, top ? top.label : "");
      topLabel.classList.toggle("dim", !top);
      const final = isFinal(tile);
      const answer = answerModel(tile, { replay });
      let answerText = "";
      if (answer.state === "final") answerText = "final" + (answer.originText ? ", " + answer.originText : "");
      else if (answer.state === "provisional") answerText = "provisional";
      else if (answer.state === "stranded") answerText = "not final";
      setText(answerMark, answerText);
      setData(answerMark, "state", answer.state);
      answerMark.classList.toggle("warn-text", final && answer.fallback);

      const cost = multiplierModel(tile);
      setText(multValue, cost.text);
      setText(multDetail, cost.brief);
      setTitle(multCell, "Score multiplier: " + cost.full);
      multValue.classList.toggle("is-reduced", cost.reduced);
      renderFlags();
    },
    // A board row has no controls: the focus screen it links to opens them.
    open() {},
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (stopTick) stopTick();
      time.destroy();
      flags.destroy();
      tile = null;
      root.remove();
    },
  };
}

// ---------------------------------------------------------------- the full tile

function part(className, title, ...children) {
  return el("section", "tile-part " + className, title ? el("h4", "section-title", title) : null, ...children);
}

function noticeLine(kind, iconName) {
  const text = el("span", "tile-notice-text");
  const actions = el("span", "tile-notice-actions");
  const node = el("div", { class: "notice notice-" + kind + " tile-notice", hidden: true, role: "status" },
    icon(iconName), el("div", "tile-notice-body", text, actions));
  return { node, text, actions };
}

function fullTile(container, { runId, pid, density, replay, onSelect, stream: streamOptions }) {
  const headSlot = el("div", "tile-slot-head");
  const flagSlot = el("div", "tile-slot-flags");
  const timeSlot = el("div", "tile-slot-time");
  const viewerBox = el("div", "tile-viewer");
  const mcqSlot = el("div", "tile-mcq");
  const confSlot = el("div", "tile-conf-slot");
  const mapBox = el("div", "tile-map");
  const hypSlot = el("div", "tile-hyp-slot");
  const answerSlot = el("div", "tile-answer-slot");
  const streamNote = el("div", { class: "tile-stream-note", hidden: true });
  const streamBox = el("div", "tile-stream");
  const controlSlot = el("div", "tile-controls");
  const waiting = el("p", "tile-waiting dim", el("span", "spinner"), " Waiting for the state of this panorama…");

  const interrupted = noticeLine("warn", "alert");
  const apiTrouble = noticeLine("bad", "alert");
  const exportTrouble = noticeLine("bad", "file");
  const notices = el("div", "tile-notices", interrupted.node, apiTrouble.node, exportTrouble.node);

  const root = el("article", {
    class: "tile tile-" + density + " is-waiting" + (replay ? " is-replay" : ""),
    dataset: { pid: String(pid), run: String(runId) },
    "aria-label": "Panorama " + pid,
  },
    headSlot,
    flagSlot,
    notices,
    timeSlot,
    el("div", "tile-main",
      viewerBox,
      mcqSlot,
      el("div", "tile-col tile-col-a",
        part("tile-part-map", "Where it thinks it is", confSlot, mapBox),
        part("tile-part-hyps", "Hypotheses", hypSlot)),
      el("div", "tile-col tile-col-b",
        part("tile-part-answer", null, answerSlot),
        part("tile-part-stream", "Reasoning stream", streamNote, streamBox))),
    controlSlot,
    waiting);
  container.append(root);

  let destroyed = false;
  let tile = null;
  let run = null;
  let heavy = null; // {viewer, map, stream}: built when the tile first comes on screen
  let onScreen = typeof IntersectionObserver !== "function";
  let looked = false; // the one synchronous look at where the tile is, at its first state
  let unqueue = null; // removes this tile's pending build from the shared queue
  let wantedOpen = null; // open(name) asked for before the first state
  const aborter = typeof AbortController === "function" ? new AbortController() : null;
  const drawn = { sources: "", crops: "", hypotheses: "", clusters: "", answer: "" };
  const cleanups = [];

  const head = tileHead(headSlot, { runId, pid, replay });
  const time = timeBar(timeSlot, { replay });
  const conf = confidenceLine(confSlot);
  const hyps = hypothesisTable(hypSlot, {
    onHover: (index) => { if (heavy) heavy.map.highlightHypothesis(index); },
  });
  const answer = answerList(answerSlot, { replay });
  const flags = flagStrip(flagSlot, { runId, pid, asLinks: true, onActivate: activateFlag });

  // The controls belong to components/controls.js; a replay has none.
  const mcq = replay ? null : mcqPanel(mcqSlot, {
    runId,
    pid,
    onHighlightHypothesis: (index) => {
      hyps.highlight(index);
      if (heavy) heavy.map.highlightHypothesis(index);
    },
  });
  const bar = replay ? null : controlBar(controlSlot, { runId, pid });

  interrupted.actions.append(routeLink(paths.submit(runId), { class: "btn small" }, null, "Open Submission"));
  exportTrouble.actions.append(routeLink(paths.submit(runId), { class: "btn small" }, null, "Open Submission"));
  apiTrouble.actions.append(el("button", { type: "button", class: "small", onclick: () => showErrors() }, icon("search"), "Show the errors"));

  // ---- heavy parts

  // Queue the build; `buildHeavy` itself stays synchronous for a caller that needs the parts now.
  function wantHeavy() {
    if (heavy || unqueue || destroyed) return;
    unqueue = queueHeavy(() => {
      unqueue = null;
      buildHeavy();
    });
  }

  function buildHeavy() {
    if (heavy || destroyed || !tile) return;
    if (unqueue) {
      unqueue();
      unqueue = null;
    }
    const sources = panoSources(runId, pid, tile);
    drawn.sources = sourcesKey(sources);
    const viewer = createPanoViewer(viewerBox, {
      sources,
      mode: "360",
      ruler: true,
      controls: true,
      label: "Panorama " + pid + ": drag to look around, wheel to zoom, double-click to reset",
    });
    const map = createMap(mapBox, { interactive: true, layer: "street", scale: true, wheel: density === "focus" ? true : "focus" });
    const options = streamOptions || {};
    const stream = createStream(streamBox, {
      runId,
      pid,
      height: "fill",
      live: !replay,
      filter: options.filter,
      search: options.search,
      onChange: options.onChange || null,
      onOpenEvent: options.onOpenEvent || null,
      onImage: options.onImage || null,
      onCropHover: (n) => viewer.highlightCrop(n),
    });
    cleanups.push(viewer.onCropHover((n) => stream.highlightCrop(n)));
    // A click on a footprint finds the call that made it in the stream.
    cleanups.push(viewer.onCropClick((n) => stream.highlightCrop(n, { scroll: true })));
    heavy = { viewer, map, stream };
    if (replay) loadReplayEvents();
    drawHeavy();
  }

  // A replay follows nothing live: the events are read once and handed to the stream.
  async function loadReplayEvents() {
    replace(streamNote, el("span", "spinner"), " Loading the events of this panorama…");
    streamNote.className = "tile-stream-note dim";
    streamNote.hidden = false;
    try {
      const data = await api.get(panoUrl(runId, pid, "/events?after=0"), { signal: aborter ? aborter.signal : undefined });
      if (destroyed || !heavy) return;
      heavy.stream.reset(data && Array.isArray(data.events) ? data.events : []);
      streamNote.hidden = true;
    } catch (err) {
      if (destroyed || (err && err.name === "AbortError")) return;
      streamNote.className = "tile-stream-note notice notice-bad";
      replace(streamNote, icon("alert"),
        el("div", "tile-notice-body",
          el("span", "tile-notice-text pre", "The events of this panorama could not be loaded. " + errorText(err)),
          el("span", "tile-notice-actions",
            el("button", { type: "button", class: "small", onclick: () => loadReplayEvents() }, icon("refresh"), "Try again"))));
    }
  }

  function drawHeavy() {
    if (!heavy || !tile) return;
    const { viewer, map } = heavy;
    const sources = panoSources(runId, pid, tile);
    const sourceKey = sourcesKey(sources);
    if (sourceKey !== drawn.sources) {
      drawn.sources = sourceKey;
      viewer.setSources(sources);
    }
    const crops = viewerCrops(tile);
    const cropKey = JSON.stringify(crops);
    if (cropKey !== drawn.crops) {
      drawn.crops = cropKey;
      viewer.setCrops(crops);
    }

    let moved = false;
    const hypotheses = Array.isArray(tile.hypotheses) ? tile.hypotheses : [];
    const hypKey = JSON.stringify(hypotheses);
    if (hypKey !== drawn.hypotheses) {
      drawn.hypotheses = hypKey;
      map.setHypotheses(hypotheses, { onHover: (index) => hyps.highlight(index) });
      moved = true;
    }
    const clusters = Array.isArray(tile.cluster_points) ? tile.cluster_points : [];
    const clusterKey = JSON.stringify(clusters);
    if (clusterKey !== drawn.clusters) {
      drawn.clusters = clusterKey;
      map.setClusters(clusters);
      moved = true;
    }
    const final = isFinal(tile);
    const list = final ? tile.final : tile.provisional;
    const entries = Array.isArray(list) ? list.filter(Boolean) : [];
    const chosen = chosenPoint(tile);
    const answerKey = JSON.stringify([final, chosen, entries.map((entry) => [entry.rank, entry.lat, entry.lng])]);
    if (answerKey !== drawn.answer) {
      drawn.answer = answerKey;
      map.setEntries(entries);
      map.setAnswer(chosen, { final });
      moved = true;
    }
    // fit() stands down by itself once the operator has moved the map.
    if (moved) map.fit();
  }

  const watcher = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        onScreen = true;
        watcher.disconnect();
        if (tile) wantHeavy();
      }, { rootMargin: HEAVY_MARGIN_PX + "px" })
    : null;
  if (watcher) watcher.observe(root);

  // The observer answers on the next frame, and a tab in the background gets none. A tile that
  // is plainly in the window when its state arrives does not wait for it.
  function inWindow() {
    const box = root.getBoundingClientRect();
    if (!box.width && !box.height) return false;
    return box.bottom > -HEAVY_MARGIN_PX && box.top < window.innerHeight + HEAVY_MARGIN_PX &&
      box.right > 0 && box.left < window.innerWidth;
  }

  // ---- notices and flags

  function renderNotices() {
    if (replay) return;
    const status = tileStatus(tile);
    const stopped = status === "interrupted";
    setHidden(interrupted.node, !stopped);
    if (stopped) {
      const hasList = Array.isArray(tile.provisional) && tile.provisional.length > 0;
      setText(interrupted.text,
        "Interrupted: the server stopped while this panorama was running, so no control can reach it now. " +
        "Open Submission and use Rebuild exports to recover " +
        (hasList ? "its last provisional list." : "it; with no hypothesis on record the fallback point for its label is written."));
    }
    const failing = Boolean(tile.api_trouble) && !stopped;
    setHidden(apiTrouble.node, !failing);
    if (failing) {
      setText(apiTrouble.text, "The model API is failing" + (tile.api_trouble_text ? ": " + tile.api_trouble_text : ".") +
        " The harness retries by itself; if it keeps failing, use Finalize now to keep the best-so-far list.");
    }
    setHidden(exportTrouble.node, !tile.export_problems);
    if (tile.export_problems) {
      setText(exportTrouble.text, "The export of this panorama is not valid: " +
        String(tile.export_problems).replace(/[.\s]+$/, "") + ". Open Submission to rebuild it before the freeze.");
    }
  }

  function renderFlags() {
    if (destroyed || replay || !tile) return;
    flags.render();
  }

  function reveal(node) {
    const target = node && !node.hidden && node.isConnected ? node : root;
    if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
  }

  function open(name) {
    if (destroyed || replay) return;
    // A link with ?open= can arrive before the state of the panorama does.
    if (!tile) {
      wantedOpen = name;
      return;
    }
    if (name === "mcq") {
      if (!mcq) return;
      reveal(mcq.el || mcqSlot);
      mcq.focus();
      return;
    }
    if (bar) bar.open(name);
  }

  function showErrors() {
    if (!heavy) buildHeavy();
    // On this panorama's own page the filter is URL state (A1); the screen mirrors it to the stream.
    if (window.location.pathname === paths.pano(runId, pid)) setQuery({ filter: "errors" });
    if (heavy) heavy.stream.setFilter(["errors"]);
    reveal(streamBox);
  }

  // A flag on a full tile opens the control right here; the same flag in the inbox links to it.
  function activateFlag(flag) {
    if (flag.kind === "mcq") open("mcq");
    else if (flag.kind === "window") open("cue");
    else if (flag.kind === "fallback") open("ack");
    else if (flag.kind === "api") showErrors();
    else navigate(appPath(flag.href));
  }

  const stopTick = replay ? null : onTick(renderFlags);

  if (onSelect) {
    const select = () => onSelect(pid);
    root.addEventListener("pointerdown", select);
    root.addEventListener("focusin", select);
  }

  // ---- public

  function update(nextTile, nextRun) {
    if (destroyed) return;
    const changed = nextTile !== tile;
    tile = nextTile || null;
    run = nextRun || null;
    root.classList.toggle("is-waiting", !tile);
    if (!tile) return;
    if (changed) {
      const status = tileStatus(tile, { replay });
      setData(root, "status", status);
      root.classList.toggle("is-special", Boolean(tile.special));
      root.classList.toggle("is-final", isFinal(tile));
      head.update(tile, run);
      time.update(tile, run);
      conf.update(tile, run);
      hyps.update(tile, run);
      answer.update(tile, run);
      renderNotices();
      renderFlags();
      if (heavy) drawHeavy();
      else if (onScreen || (!looked && inWindow())) {
        onScreen = true;
        if (watcher) watcher.disconnect();
        wantHeavy();
      }
      looked = true;
    }
    // The controls also follow the connection and the run, which change without a new tile.
    if (mcq) mcq.update(tile, run);
    if (bar) bar.update(tile, run);
    if (wantedOpen) {
      const name = wantedOpen;
      wantedOpen = null;
      open(name);
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (stopTick) stopTick();
    if (watcher) watcher.disconnect();
    if (unqueue) unqueue();
    unqueue = null;
    if (aborter) aborter.abort();
    for (const off of cleanups.splice(0)) {
      if (typeof off === "function") off();
    }
    if (mcq) mcq.destroy();
    if (bar) bar.destroy();
    if (heavy) {
      heavy.stream.destroy();
      heavy.viewer.destroy();
      heavy.map.destroy();
      heavy = null;
    }
    for (const piece of [head, time, conf, hyps, answer, flags]) piece.destroy();
    tile = null;
    run = null;
    root.remove();
  }

  return {
    el: root,
    update,
    open,
    destroy,
    /** Put the cursor in this tile's stream search (the `/` shortcut). */
    focusSearch() {
      if (!heavy) buildHeavy();
      if (heavy) {
        reveal(streamBox);
        heavy.stream.focusSearch();
      }
    },
    /** The heavy parts, or null until the tile has been on screen: for a screen that drives them. */
    get viewer() { return heavy ? heavy.viewer : null; },
    get map() { return heavy ? heavy.map : null; },
    get stream() { return heavy ? heavy.stream : null; },
  };
}

/**
 * One panorama tile.
 *
 *   const tile = createTile(container, {runId, pid, density: "tiles"});
 *   tile.update(store.tile(runId, pid), store.run(runId));    // on every store change
 *
 * density "board": one row (thumbnail, label, status, time bar, top hypothesis and probability,
 *   multiplier, attention flags); no viewer, map or stream; the whole row links to the focus
 *   screen. With `onSelect`, a plain click calls `onSelect(pid)` instead of navigating.
 * density "tiles": the full tile of UI-SPEC 5.5. density "focus": the same tile laid out for the
 *   full width of the page. With `onSelect`, it is called when the tile is pressed or focused.
 * replay: true renders no control and follows nothing live; `update` is given the reconstructed
 *   TileState. The events are read once into the stream.
 * stream: {filter, search, onChange, onOpenEvent, onImage} is passed on to createStream so that a
 *   screen can mirror `?filter=`, `?q=` and `?event=`.
 *
 * Returns {update(tile, run), open(name), destroy(), el} plus focusSearch() and the getters
 * viewer / map / stream (null until built). `open("mcq")` scrolls to the question and focuses
 * it; any other name goes to the control bar ("cue" | "geocode" | "ack"). Nothing is ever sent.
 */
export function createTile(container, options = {}) {
  const density = ["board", "tiles", "focus"].includes(options.density) ? options.density : "tiles";
  const settings = { ...options, density, replay: Boolean(options.replay), onSelect: options.onSelect || null };
  return density === "board" ? boardTile(container, settings) : fullTile(container, settings);
}
