// The inspector of the panorama focus and replay screen (UI-SPEC 5.6): six tabs in which every
// turn, tool call, image, penalty and fact of one panorama can be examined.
//
//   turns   request size, tokens, latency, cost and stop reason per turn, with api_retry inline
//   tools   every call with its full input and output, the URLs it called and the images returned
//   images  every view sent to the model, and how much of the image budget is used
//   ledger  each penalty charge and the running multiplier
//   facts   model, budget, flags, provenance, the prompt and tools as sent, and the downloads
//   truth   evaluation runs with human channels off only: truth against the answer
//
// Rule compliance: this is a read-only view. Nothing typed or clicked here reaches the agent: the
// filter boxes narrow what is already on the page and are never sent anywhere. Text from the
// model, a tool, a log or a file name goes in as text nodes; external URLs are shown as text with
// a copy button and are never links (A30, U2); image URLs are built only from a checked sha256
// against the app's own endpoint. Ground truth is drawn only when the caller passed it and the
// run is an evaluation run with human channels off.

import { errorText } from "../../api.js";
import { barChart, lineChart } from "../../components/charts.js";
import { createMap } from "../../components/map.js";
import { lightbox } from "../../components/shell.js";
import { jsonTree, viewUrl } from "../../components/stream.js";
import { badge, copyButton, debounce, el, icon, replace, syncList } from "../../dom.js";
import { fmtClock, fmtCoord, fmtDist, fmtInt, fmtLatLng, fmtMult, fmtPct, fmtTime, fmtUsd, plural } from "../../format.js";
import {
  TABS,
  TAB_LABELS,
  aimText,
  anglesText,
  budgetMeters,
  budgetRows,
  countUpTo,
  defaultComparison,
  distinctAnswers,
  downloadItems,
  eventAt,
  filterGallery,
  filterTools,
  flagRows,
  fmtLatency,
  fmtMoment,
  fmtPayload,
  galleryRows,
  gallerySources,
  galleryTotals,
  imageOrigin,
  ledgerRows,
  ledgerSummary,
  panoramaViews,
  parseOutput,
  provenanceRows,
  staleCount,
  stopReasonText,
  tabName,
  toolDefinitionNames,
  toolIndexAt,
  toolNames,
  toolRows,
  toolsText,
  truthAllowed,
  truthChart,
  truthFor,
  truthStats,
  turnBars,
  turnIndexAt,
  turnRows,
  turnTotals,
  viewCaption,
} from "../../logic/inspect.js";
import { fetchDownload, loadInspect, loadTruth } from "./data.js";

const LIST_CAP = 400; // rows built at once in the call list and the gallery; a button shows the rest
const URL_CAP = 8; // URLs listed before "show all" (one web search can return dozens)
const FILTER_DEBOUNCE_MS = 120;
const FOLLOW_DEBOUNCE_MS = 140; // the call detail follows the scrubber once it rests
const REVOKE_MS = 60000; // a saved file's object URL is released after the browser has taken it
const AUTO_REFRESH_MS = 5000; // how soon an inspector that loads its own data catches up with a live run

let instances = 0;

const callable = (fn) => (typeof fn === "function" ? fn : null);
const seconds = (value) => (value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)) + " s";

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

// Brings a row into view inside its own scroller only. scrollIntoView would also scroll the page,
// which must not move while the operator drags the scrubber above the inspector. A row that was
// out of view lands in the middle, so what came before and after it can be seen.
function scrollWithin(box, node) {
  const outer = box.getBoundingClientRect();
  const inner = node.getBoundingClientRect();
  if (inner.top >= outer.top && inner.bottom <= outer.bottom) return;
  box.scrollTop += inner.top - outer.top - (outer.height - inner.height) / 2;
}

function section(title, ...children) {
  return el("section", "insp-section", el("h4", "section-title", title), children);
}

function notice(kind, iconName, ...children) {
  return el("div", "notice notice-" + kind, icon(iconName), el("div", "grow", children));
}

function labelledCopy(source, label, title) {
  const button = copyButton(source, { label, title: title || label });
  button.classList.add("insp-copy");
  return button;
}

function selectField(label, onChange) {
  const select = el("select", { class: "insp-select", onchange: () => onChange(select.value) });
  return { select, node: el("label", "field insp-field", el("span", "field-label", label), select) };
}

// Options are rebuilt only when they change, so an open drop-down is not replaced under the pointer.
function setOptions(select, options, value) {
  const sig = JSON.stringify(options);
  if (select.dataset.sig !== sig) {
    select.dataset.sig = sig;
    replace(select, options.map((option) => el("option", { value: option.value }, option.label)));
  }
  select.value = options.some((option) => option.value === value) ? value : "";
}

// Marks the rows that had not happened yet at the scrubber's position. The rows are in event
// order, so a move of the cursor only touches the rows between the old position and the new one.
function createDimmer() {
  let nodes = [];
  let seqs = [];
  let shown = 0;
  let ordered = true;
  const full = (cursor) => {
    const at = cursor === null || cursor === undefined ? Infinity : Number(cursor);
    nodes.forEach((node, i) => node.classList.toggle("is-later", seqs[i] > at));
  };
  return {
    reset(items, cursor) {
      nodes = items.map((item) => item.node);
      seqs = items.map((item) => item.seq);
      ordered = seqs.every((seq, i) => i === 0 || seq >= seqs[i - 1]);
      if (!ordered) {
        full(cursor);
        return;
      }
      shown = countUpTo(seqs, cursor);
      nodes.forEach((node, i) => node.classList.toggle("is-later", i >= shown));
    },
    apply(cursor) {
      if (!ordered) {
        full(cursor);
        return;
      }
      const next = countUpTo(seqs, cursor);
      for (let i = Math.min(next, shown); i < Math.max(next, shown); i += 1) nodes[i].classList.toggle("is-later", i >= next);
      shown = next;
    },
  };
}

/**
 * The inspector of one panorama.
 *
 *   const inspector = createInspector(container, {runId, pid, tab: query.get("tab"),
 *     onTab: (name) => setQuery({tab: name}), onSeek: (seq) => setQuery({at: seq})});
 *   inspector.setData(await loadInspect(runId, pid), {truth: await loadTruth(runId)});
 *
 * options:
 *   runId, pid          the panorama
 *   tab                 the tab to open first (`?tab=`); `truth` is honoured once truth is given
 *   onTab(name)         the operator chose a tab (never called for setTab)
 *   onSeek(seq)         the operator clicked "go to this moment" on a row
 *   onCropHover(n|null) the pointer or the focus is on a crop in the gallery
 *   onOpenEvent(seq)    the operator asked for the full event JSON of a row
 *   onRefresh()         the operator clicked Refresh on the "newer events" note; without it the
 *                       inspector reloads its own data through load({force: true})
 *
 * returns {setData(inspect, {truth}), setTab(name), setCursor(seq|null), update(tile, run),
 *          destroy(), el} and, beyond the contract, {load({force}), setLoading(),
 *          setError(err, {onRetry}), highlightCrop(n|null), getState()}.
 *
 * Who keeps it current: a screen that fetches the payload itself calls setData again when the tile
 * has moved on (the status line says how many events are missing until it does). An inspector
 * started with load() fetches for itself and, given the tile through update(), catches up with a
 * running panorama every few seconds.
 */
export function createInspector(container, options = {}) {
  const runId = options.runId;
  const pid = options.pid;
  const onTab = callable(options.onTab);
  const onSeek = callable(options.onSeek);
  const onCropHover = callable(options.onCropHover);
  const onOpenEvent = callable(options.onOpenEvent);
  const onRefresh = callable(options.onRefresh);
  const uid = "insp" + (instances += 1);

  const state = {
    inspect: null,
    truthPayload: null,
    truthEntry: null,
    tile: null,
    run: null,
    cursor: null,
    tab: "turns",
    wantedTab: String(options.tab ?? "").toLowerCase(),
    turns: [],
    tools: [],
    gallery: [],
    views: [],
    ledger: [],
    loadError: null,
    refreshing: false,
  };
  let destroyed = false;
  let loader = null;
  let ownsData = false; // load() was used: the inspector fetches for itself and keeps itself current
  let refreshTimer = null;
  let openBox = null;
  let hoveredCrop = null;
  let updateSig = "";

  // ---------------------------------------------------------------- frame

  const tabButtons = new Map();
  const tabCounts = new Map();
  const tablist = el("div", { class: "tabs insp-tabs", role: "tablist", "aria-label": "Inspector" });
  for (const name of TABS) {
    const count = el("span", "insp-tab-count num");
    const button = el("button", {
      type: "button",
      class: "tab insp-tab",
      role: "tab",
      id: uid + "-tab-" + name,
      "aria-controls": uid + "-pane-" + name,
      "aria-selected": "false",
      tabIndex: -1,
      onclick: () => chooseTab(name),
    }, TAB_LABELS[name], count);
    // the truth tab exists only once truth was given (setData)
    if (name === "truth") button.hidden = true;
    tabButtons.set(name, button);
    tabCounts.set(name, count);
    tablist.append(button);
  }
  // Arrow keys move between tabs, as in any tab list. They only act while a tab has the focus.
  tablist.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const names = TABS.filter((name) => !tabButtons.get(name).hidden);
    const at = names.indexOf(state.tab);
    let next = null;
    if (event.key === "ArrowRight") next = names[(at + 1) % names.length];
    else if (event.key === "ArrowLeft") next = names[(at - 1 + names.length) % names.length];
    else if (event.key === "Home") next = names[0];
    else if (event.key === "End") next = names[names.length - 1];
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    chooseTab(next);
    tabButtons.get(next).focus();
  });

  const status = el("div", { class: "insp-status small", role: "status" });
  const head = el("div", "insp-head", tablist, status);
  const stateBox = el("div", "insp-state");
  const body = el("div", "insp-body");
  const root = el("div", { class: "insp", dataset: { tab: state.tab } }, head, stateBox, body);
  container.append(root);

  // ---------------------------------------------------------------- shared row parts

  function seekButton(seq, what = "this moment") {
    if (!onSeek || seq === null || seq === undefined) return null;
    const label = "Go to " + what + " (event #" + seq + ")";
    return el("button", {
      type: "button",
      class: "icon-btn small insp-seek",
      title: label,
      "aria-label": label,
      onclick: (event) => {
        event.stopPropagation();
        onSeek(seq);
      },
    }, icon("clock"));
  }

  function eventButton(seq) {
    if (!onOpenEvent || seq === null || seq === undefined) return null;
    const label = "Open the full JSON of event #" + seq;
    return el("button", {
      type: "button",
      class: "icon-btn small insp-event",
      title: label,
      "aria-label": label,
      onclick: (event) => {
        event.stopPropagation();
        onOpenEvent(seq);
      },
    }, icon("file"));
  }

  function openImage(sha256, caption) {
    const src = viewUrl(runId, pid, sha256);
    if (!src) return;
    if (openBox) openBox.close();
    openBox = lightbox({ src, caption });
  }

  // A thumbnail that opens the shell lightbox. The pixel size reserves its shape before it loads.
  function thumb(image, caption, className) {
    const src = viewUrl(runId, pid, image.sha256);
    const button = el("button", { type: "button", class: "insp-thumb " + (className || ""), title: caption + " (click to enlarge)" });
    if (!src) {
      button.disabled = true;
      button.classList.add("is-missing");
      button.append(icon("image"), el("span", "xsmall", "not available"));
      return button;
    }
    const picture = el("img", { class: "insp-thumb-img", alt: caption, loading: "lazy", decoding: "async" });
    if (image.width && image.height) {
      picture.width = image.width;
      picture.height = image.height;
    }
    picture.addEventListener("error", () => {
      button.disabled = true;
      button.classList.add("is-missing");
      button.title = caption + " (image not available)";
      replace(button, icon("image"), el("span", "xsmall", "not available"));
    });
    button.addEventListener("click", () => openImage(image.sha256, caption));
    picture.src = src;
    button.append(picture);
    return button;
  }

  function hoverCrop(n) {
    const value = n === null || n === undefined ? null : n;
    if (value === hoveredCrop) return;
    hoveredCrop = value;
    if (onCropHover) onCropHover(value);
  }

  const turnOptions = () => [{ value: "", label: "All turns" }].concat(state.turns.map((row) => ({
    value: row.key,
    label: "Turn " + row.turn + (state.turns.some((other) => other.segment !== row.segment) ? " (conversation " + row.segment + ")" : ""),
  })));

  // ---------------------------------------------------------------- turns

  function buildTurns() {
    const stats = el("div", "insp-stats");
    const chartHost = el("div", "insp-chart");
    const tbody = el("tbody");
    const tfoot = el("tfoot");
    const dimmer = createDimmer();
    let chart = null;
    let selected = -1;
    let barsSig = "";

    const th = (label, attrs = {}) => el("th", attrs, label);
    const table = el("table", "table compact insp-table insp-turn-table",
      el("thead", null,
        el("tr", null,
          th("Turn", { rowSpan: 2 }), th("Time", { rowSpan: 2 }),
          th("Request", { colSpan: 3, class: "insp-th-group" }),
          th("Tokens", { colSpan: 4, class: "insp-th-group" }),
          th("Latency", { rowSpan: 2, class: "r" }), th("Cost", { rowSpan: 2, class: "r" }),
          th("Stop reason", { rowSpan: 2 }), th("In this turn", { rowSpan: 2 })),
        el("tr", null,
          th("Messages", { class: "r" }), th("Images", { class: "r" }), th("Upload", { class: "r" }),
          th("Input", { class: "r" }), th("Cached", { class: "r" }), th("Output", { class: "r" }), th("Reasoning", { class: "r" }))),
      tbody, tfoot);
    const empty = el("div", "empty", el("div", "empty-title", "No turns yet"),
      "The model has not been sent a request for this panorama. Turns appear here as soon as the first one is logged.");
    const content = el("div", "stack", stats, chartHost, el("div", "table-wrap", table));
    const pane = el("div", "insp-pane-inner", empty, content);

    function select(index, { scroll = false } = {}) {
      selected = index >= 0 && index < state.turns.length ? index : -1;
      for (const row of tbody.children) {
        const on = row.dataset.turn !== undefined && Number(row.dataset.turn) === selected;
        row.classList.toggle("selected", on);
        const button = row.querySelector(".insp-turn-btn");
        if (button) button.setAttribute("aria-pressed", on ? "true" : "false");
        // Only after a click on the chart: the operator asked for that turn, so the page may move.
        if (on && scroll && row.dataset.kind === "turn") row.scrollIntoView({ block: "nearest" });
      }
      if (chart) chart.update({ selected: selected < 0 ? null : selected });
    }

    function jump(tab, turnKey) {
      if (tab === "tools") panes.tools.api.setFilter({ tool: "", turn: turnKey, text: "", errors: false, cached: false });
      else panes.images.api.setFilter({ source: "", turn: turnKey });
      chooseTab(tab);
    }

    function turnCells(row) {
      const tokens = row.tokens;
      const number = (value) => el("td", "r", value === null || value === undefined ? "–" : fmtInt(value));
      let stop;
      if (row.error) stop = badge("API error", "bad", "alert");
      else if (row.pending) stop = badge("no response logged", "dim", "clock");
      else stop = el("span", { title: row.stopReason ? "logged as " + row.stopReason : null }, stopReasonText(row.stopReason) || "–");
      return [
        el("td", null, el("button", {
          type: "button",
          class: "small ghost insp-turn-btn num",
          "aria-pressed": "false",
          title: "Mark turn " + row.turn + " in the chart",
          onclick: (event) => {
            event.stopPropagation();
            select(row.index);
          },
        }, String(row.turn))),
        el("td", "num", fmtMoment(row.t_rel_s)),
        number(row.messages),
        el("td", "r", row.images === null ? "–" : fmtInt(row.images), row.imagesAdded ? el("span", "dim", " +" + fmtInt(row.imagesAdded)) : null),
        el("td", "r", fmtPayload(row.payloadChars)),
        number(tokens ? tokens.input : null),
        number(tokens ? tokens.cached : null),
        number(tokens ? tokens.output : null),
        number(tokens ? tokens.reasoning : null),
        el("td", "r", fmtLatency(row.latencyMs)),
        el("td", "r", row.costUsd === null ? "–" : fmtUsd(row.costUsd)),
        el("td", null, stop),
        el("td", null, el("div", "insp-turn-actions",
          row.calls ? el("button", { type: "button", class: "small ghost", title: "Show the tool calls of turn " + row.turn, onclick: (event) => { event.stopPropagation(); jump("tools", row.key); } }, plural(row.calls, "call")) : el("span"),
          row.views ? el("button", { type: "button", class: "small ghost", title: "Show the views sent with the request of turn " + row.turn, onclick: (event) => { event.stopPropagation(); jump("images", row.key); } }, plural(row.views, "view")) : el("span"),
          seekButton(row.seq, "turn " + row.turn), eventButton(row.seqResponse ?? row.seq))),
      ];
    }

    function items() {
      const out = [];
      for (const row of state.turns) {
        if (row.newSegment) out.push({ kind: "segment", key: "s" + row.segment + ":" + row.index, seq: row.seq, row });
        out.push({ kind: "turn", key: "t" + row.key + ":" + row.index, seq: row.seq, row });
        row.retries.forEach((retry, i) => out.push({ kind: "retry", key: "r" + row.key + ":" + row.index + ":" + i, seq: retry.seq ?? row.seq, row, retry, nth: i + 1 }));
        if (row.error) out.push({ kind: "error", key: "e" + row.key + ":" + row.index, seq: row.seq, row });
      }
      return out;
    }

    function fill(node, item) {
      const row = item.row;
      const sig = JSON.stringify([item.kind, row.turn, row.seqResponse, row.tokens, row.latencyMs, row.costUsd, row.stopReason, row.error, row.calls, row.views, row.images, item.retry || null]);
      node.dataset.kind = item.kind;
      if (item.kind === "segment") delete node.dataset.turn;
      else node.dataset.turn = String(row.index);
      if (node.dataset.sig === sig) return;
      node.dataset.sig = sig;
      if (item.kind === "turn") {
        node.className = "clickable";
        replace(node, turnCells(row));
      } else if (item.kind === "segment") {
        node.className = "insp-subrow insp-segment";
        replace(node, el("td", { colSpan: 13 }, icon("refresh"), " Conversation " + row.segment + ": the panorama was started again here, so turn numbers begin at 1 again. Penalties already charged carry over."));
      } else if (item.kind === "retry") {
        const retry = item.retry;
        const facts = ["Retry " + (retry.attempt ?? item.nth)];
        if (retry.t_rel_s !== null) facts.push("at " + fmtClock(retry.t_rel_s));
        if (retry.statusCode !== null) facts.push("HTTP " + retry.statusCode);
        if (retry.delayS !== null) facts.push("waited " + seconds(retry.delayS));
        node.className = "insp-subrow insp-retry";
        replace(node, el("td", { colSpan: 13 },
          el("div", "row tight", badge("api_retry", "warn", "refresh"), el("span", "num nowrap", facts.join(" · ")),
            el("span", "grow wrap-any", retry.message), seekButton(retry.seq, "this retry"), eventButton(retry.seq))));
      } else {
        node.className = "insp-subrow insp-retry";
        replace(node, el("td", { colSpan: 13 },
          el("div", "row tight", badge("api_error", "bad", "alert"),
            el("span", "grow wrap-any", "The request of turn " + row.turn + " failed and was not answered: " + row.error))));
      }
    }

    function renderStats() {
      const totals = turnTotals(state.turns);
      const stat = (label, value, note) => el("div", "insp-stat", el("span", "insp-stat-label", label), el("span", "insp-stat-value num", value), note ? el("span", "insp-stat-note dim num", note) : null);
      replace(stats,
        stat("Turns", fmtInt(totals.turns), totals.answered < totals.turns ? fmtInt(totals.turns - totals.answered) + " without a response" : null),
        stat("Input tokens", fmtInt(totals.input), totals.cachedShare === null ? null : fmtPct(totals.cachedShare) + " read from cache"),
        stat("Output tokens", fmtInt(totals.output), fmtInt(totals.reasoning) + " of them reasoning"),
        stat("Cost", fmtUsd(totals.costUsd), totals.dearest === null ? null : "dearest: turn " + state.turns[totals.dearest].turn),
        stat("Model time", fmtLatency(totals.latencyMs), totals.meanLatencyMs === null ? null : fmtLatency(totals.meanLatencyMs) + " per turn"),
        stat("API trouble", plural(totals.retries, "retry", "retries"), totals.errors ? plural(totals.errors, "failed request") : "no failed request"));
      replace(tfoot, el("tr", "insp-total",
        el("td", { colSpan: 5 }, "Total"),
        el("td", "r", fmtInt(totals.input)), el("td", "r", fmtInt(totals.cached)),
        el("td", "r", fmtInt(totals.output)), el("td", "r", fmtInt(totals.reasoning)),
        el("td", "r", fmtLatency(totals.latencyMs)), el("td", "r", fmtUsd(totals.costUsd)),
        el("td", { colSpan: 2 })));
    }

    function render() {
      const none = !state.turns.length;
      empty.hidden = !none;
      content.hidden = none;
      if (none) return;
      renderStats();
      const list = items();
      syncList(tbody, list, (item) => item.key, () => {
        const node = el("tr");
        node.addEventListener("click", () => {
          if (node.dataset.kind === "turn") select(Number(node.dataset.turn));
        });
        return node;
      }, fill);
      dimmer.reset(list.map((item, i) => ({ seq: item.seq, node: tbody.children[i] })), state.cursor);

      const bars = turnBars(state.turns);
      const sig = JSON.stringify(bars);
      const chartOptions = {
        bars,
        y: { label: "Cost", format: fmtUsd },
        y2: { label: "Latency", format: seconds },
        x: { label: "Turn" },
        empty: "No turn has been answered yet.",
        onPick: (bar, index) => select(index, { scroll: true }),
      };
      if (!chart) chart = barChart(chartHost, chartOptions);
      else if (sig !== barsSig) chart.update({ bars });
      barsSig = sig;
      const wanted = state.cursor === null ? (selected >= 0 ? selected : -1) : turnIndexAt(state.turns, state.cursor);
      select(wanted);
    }

    return {
      el: pane,
      render,
      cursor() {
        dimmer.apply(state.cursor);
        if (state.cursor !== null) select(turnIndexAt(state.turns, state.cursor));
      },
      destroy() {
        if (chart) chart.destroy();
      },
    };
  }

  // ---------------------------------------------------------------- tools

  function buildTools() {
    const filter = { tool: "", turn: "", text: "", errors: false, cached: false };
    const dimmer = createDimmer();
    let shown = [];
    let selectedKey = null;
    let detailSig = "";
    let showAll = false;
    let compare = { image: 0, view: null };

    const toolField = selectField("Tool", (value) => { filter.tool = value; showAll = false; renderList(); });
    const turnField = selectField("Turn", (value) => { filter.turn = value; showAll = false; renderList(); });
    const applyText = debounce(() => { showAll = false; renderList(); }, FILTER_DEBOUNCE_MS);
    const search = el("input", {
      type: "search",
      class: "insp-search",
      placeholder: "Words in the input, output or URL",
      autocomplete: "off",
      spellcheck: false,
      oninput: () => { filter.text = search.value; applyText(); },
    });
    const errorsBox = el("input", { type: "checkbox", onchange: () => { filter.errors = errorsBox.checked; renderList(); } });
    const cachedBox = el("input", { type: "checkbox", onchange: () => { filter.cached = cachedBox.checked; renderList(); } });
    const count = el("span", { class: "insp-count small dim num", role: "status" });
    const clearButton = el("button", { type: "button", class: "small ghost", onclick: () => setFilter({ tool: "", turn: "", text: "", errors: false, cached: false }) }, icon("x"), "Clear filters");
    const filterBar = el("div", "insp-filter",
      toolField.node, turnField.node,
      el("label", "field insp-field grow", el("span", "field-label", "Filter the list (stays on this page)"), search),
      el("label", "check", errorsBox, "Errors only"),
      el("label", "check", cachedBox, "Cache hits only"),
      clearButton, count);

    const listBox = el("div", { class: "insp-call-list", role: "group", "aria-label": "Tool calls" });
    const moreButton = el("button", { type: "button", class: "small", onclick: () => { showAll = true; renderList(); } });
    const listEmpty = el("div", "empty insp-list-empty");
    const listSide = el("div", "insp-call-side", listBox, listEmpty, moreButton);
    const detail = el("div", { class: "insp-call-detail", "aria-live": "polite" });
    const split = el("div", "insp-split", listSide, detail);
    const empty = el("div", "empty", el("div", "empty-title", "No tool calls yet"),
      "The agent has not called a tool on this panorama. Calls appear here with their input, output, the URLs they fetched and the images they returned.");
    const content = el("div", "stack", filterBar, split);
    const pane = el("div", "insp-pane-inner", empty, content);

    // Up and down move through the list like a menu; the detail follows.
    listBox.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const rows = Array.from(listBox.children);
      const at = rows.indexOf(document.activeElement);
      const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      next.focus();
      pick(next.dataset.key);
    });

    function rowOf(key) {
      return state.tools.find((row) => row.key === key) || null;
    }

    function pick(key, { scroll = false } = {}) {
      if (key !== selectedKey) compare = { image: 0, view: null };
      selectedKey = key;
      for (const node of listBox.children) {
        const on = node.dataset.key === key;
        node.classList.toggle("selected", on);
        if (on) node.setAttribute("aria-current", "true");
        else node.removeAttribute("aria-current");
        if (on && scroll) scrollWithin(listBox, node);
      }
      renderDetail();
    }

    function callCells(row) {
      const flags = [];
      if (row.isError) flags.push(badge("error", "bad", "alert"));
      if (row.pending) flags.push(badge("no result", "dim", "clock"));
      if (row.cacheHit === true) flags.push(badge("cached", "info", "layers"));
      if (row.images.length) flags.push(el("span", { class: "insp-call-images dim num", title: plural(row.images.length, "image") + " returned" }, icon("image"), String(row.images.length)));
      return [
        el("span", "insp-call-time num", fmtMoment(row.t_rel_s)),
        el("span", { class: "insp-call-turn dim num", title: row.turn === null ? null : "turn " + row.turn }, row.turn === null ? "" : "T" + row.turn),
        el("span", "insp-call-name mono", row.tool),
        el("span", "insp-call-summary", row.summary),
        el("span", "insp-call-flags", flags),
        el("span", "insp-call-ms num dim", row.durationMs === null ? "" : fmtLatency(row.durationMs)),
      ];
    }

    function renderList() {
      setOptions(toolField.select, [{ value: "", label: "All tools (" + state.tools.length + ")" }]
        .concat(toolNames(state.tools).map((item) => ({ value: item.name, label: item.name + " (" + item.count + ")" }))), filter.tool);
      filter.tool = toolField.select.value;
      setOptions(turnField.select, turnOptions(), filter.turn);
      filter.turn = turnField.select.value;
      if (search.value !== filter.text) search.value = filter.text;
      errorsBox.checked = filter.errors;
      cachedBox.checked = filter.cached;

      const matching = filterTools(state.tools, filter);
      shown = showAll ? matching : matching.slice(0, LIST_CAP);
      const filtered = !!(filter.tool || filter.turn || filter.text.trim() || filter.errors || filter.cached);
      clearButton.hidden = !filtered;
      count.textContent = filtered ? fmtInt(matching.length) + " of " + plural(state.tools.length, "call") : plural(state.tools.length, "call");
      moreButton.hidden = matching.length <= shown.length;
      moreButton.textContent = "Show all " + fmtInt(matching.length) + " calls (the first " + fmtInt(shown.length) + " are listed)";
      listEmpty.hidden = matching.length > 0;
      listBox.hidden = matching.length === 0;
      if (!matching.length) replace(listEmpty, el("div", "empty-title", "No call matches"), "No tool call passes these filters. Clear them to see all " + plural(state.tools.length, "call") + ".");

      syncList(listBox, shown, (row) => row.key, () => {
        const node = el("button", { type: "button", class: "insp-call" });
        const enter = () => { if (node.dataset.crop) hoverCrop(Number(node.dataset.crop)); };
        const leave = () => { if (node.dataset.crop) hoverCrop(null); };
        node.addEventListener("click", () => pick(node.dataset.key));
        node.addEventListener("mouseenter", enter);
        node.addEventListener("mouseleave", leave);
        node.addEventListener("focus", enter);
        node.addEventListener("blur", leave);
        return node;
      }, (node, row) => {
        const sig = JSON.stringify([row.seqResult, row.isError, row.durationMs, row.cacheHit, row.images.length, row.summary]);
        if (row.cropN === null) delete node.dataset.crop;
        else node.dataset.crop = String(row.cropN);
        if (node.dataset.sig !== sig) {
          node.dataset.sig = sig;
          node.classList.toggle("is-error", row.isError);
          replace(node, callCells(row));
        }
      });
      dimmer.reset(shown.map((row, i) => ({ seq: row.seq, node: listBox.children[i] })), state.cursor);

      // Keep the operator's call while it is still listed; otherwise the one at the scrubber,
      // brought into view (the latest call of a long run is far down the list).
      const kept = shown.some((row) => row.key === selectedKey) ? selectedKey : null;
      pick(kept ?? atCursor(), { scroll: kept === null });
    }

    function atCursor() {
      if (!shown.length) return null;
      const index = toolIndexAt(shown, state.cursor);
      return shown[Math.max(0, index)].key;
    }

    function renderCompare(row, host) {
      const views = state.views;
      if (!views.length) {
        replace(host, notice("info", "info", "The log holds no view of the panorama to set beside this result."));
        return;
      }
      const image = row.images[compare.image] || row.images[0];
      const view = views.find((item) => item.key === compare.view) || defaultComparison(views, row);
      const imageSelect = row.images.length > 1
        ? selectField("Result image", (value) => { compare.image = Number(value) || 0; renderCompare(row, host); })
        : null;
      if (imageSelect) {
        setOptions(imageSelect.select, row.images.map((item, i) => ({ value: String(i), label: (i + 1) + ": " + (imageOrigin(item) || "image " + (i + 1)) })), String(compare.image));
        imageSelect.select.value = String(row.images.indexOf(image));
      }
      const viewSelect = selectField("Panorama view", (value) => { compare.view = value; renderCompare(row, host); });
      setOptions(viewSelect.select, views.map((item) => ({ value: item.key, label: item.label })), view.key);
      viewSelect.select.value = view.key;
      const resultCaption = [row.tool, imageOrigin(image), image.width && image.height ? image.width + " × " + image.height + " px" : ""].filter(Boolean).join(" · ");
      const side = (title, picture, caption, onEnter) => {
        const figure = el("figure", "insp-compare-side", el("div", "section-title", title), thumb(picture, caption, "insp-compare-thumb"), el("figcaption", "small dim", caption));
        if (onEnter) {
          figure.addEventListener("mouseenter", () => onEnter(true));
          figure.addEventListener("mouseleave", () => onEnter(false));
        }
        return figure;
      };
      replace(host,
        el("div", "insp-filter", imageSelect ? imageSelect.node : null, viewSelect.node,
          compare.view ? el("button", { type: "button", class: "small ghost", onclick: () => { compare.view = null; renderCompare(row, host); } }, "Back to the crop requested just before") : null),
        el("div", "insp-compare",
          side("Returned by " + row.tool, image, resultCaption, null),
          side("The panorama", view, view.label, view.cropN === null ? null : (on) => hoverCrop(on ? view.cropN : null))));
    }

    function renderDetail() {
      const row = rowOf(selectedKey);
      if (!row) {
        detailSig = "";
        replace(detail, el("div", "empty", el("div", "empty-title", "No call selected"), "Choose a call in the list to see its full input and output."));
        return;
      }
      const sig = JSON.stringify([row.key, row.seqResult, row.isError, row.images.length, row.urls.length, state.views.length]);
      if (sig === detailSig) return;
      detailSig = sig;

      const meta = [];
      if (row.turn !== null) meta.push("turn " + row.turn);
      if (row.t_rel_s !== null) meta.push("at " + fmtClock(row.t_rel_s));
      if (row.durationMs !== null) meta.push("took " + fmtLatency(row.durationMs));
      meta.push("event #" + row.seq + (row.seqResult !== null && row.seqResult !== row.seq ? ", result #" + row.seqResult : ""));
      const flags = [];
      if (row.isError) flags.push(badge("error", "bad", "alert"));
      if (row.pending) flags.push(badge("no result logged", "dim", "clock"));
      if (row.cacheHit === true) flags.push(badge("answered from the cache", "info", "layers"));
      if (row.cacheHit === false) flags.push(badge("fetched, not cached", "dim", "download"));
      if (row.hosted) flags.push(badge("hosted by the model provider", "dim", "info"));

      const parts = [
        el("div", "insp-detail-head",
          el("h3", "insp-detail-title mono", row.tool), flags,
          el("span", "grow"), seekButton(row.seq, "this call"), eventButton(row.seq),
          row.seqResult !== null && row.seqResult !== row.seq ? eventButton(row.seqResult) : null),
        el("div", "small dim num", meta.join(" · ")),
      ];
      if (row.hosted) {
        parts.push(notice("info", "info", "A hosted web search runs inside the model's turn, so the log has no separate result, duration or cache record for it. The pages it read are listed below."));
      }
      // What a street-level or satellite call is opened for, so it comes before the JSON.
      if (row.comparable) {
        const host = el("div", "stack tight");
        renderCompare(row, host);
        parts.push(section("Beside the panorama", host));
      }

      const urlSection = [];
      if (row.urls.length) {
        const urlList = el("div", "insp-urls");
        const drawUrls = (all) => {
          const list = all ? row.urls : row.urls.slice(0, URL_CAP);
          replace(urlList,
            list.map((url) => el("div", "insp-url", el("span", "mono wrap-any grow", url), copyButton(url, { title: "Copy this URL" }))),
            row.urls.length > list.length
              ? el("button", { type: "button", class: "small", onclick: () => drawUrls(true) }, "Show all " + fmtInt(row.urls.length) + " URLs")
              : null);
        };
        drawUrls(false);
        urlSection.push(section("External URLs called (" + row.urls.length + ")",
          el("div", "small dim", "Shown as text to copy; this page never opens an outside site. Keys are removed by the server."), urlList));
      }
      // A hosted search has nothing but its URLs: they come first, under the note about it.
      if (row.hosted) parts.push(...urlSection);

      const inputIsTree = row.input !== null && typeof row.input === "object";
      parts.push(section("Input",
        el("div", "row tight", labelledCopy(() => (typeof row.input === "string" ? row.input : prettyJson(row.input)), "Copy input")),
        row.input === null ? el("div", "dim", "The call had no input.") : inputIsTree ? jsonTree(row.input) : el("pre", "code-block insp-output", String(row.input))));

      const output = parseOutput(row.output);
      const outputParts = [];
      if (output.kind === "none") {
        outputParts.push(el("div", "dim", row.pending ? "No result has been logged for this call yet." : row.hosted ? "The log holds no output for a hosted search." : "The call returned nothing."));
      } else {
        outputParts.push(el("div", "row tight", labelledCopy(() => (output.kind === "json" ? prettyJson(output.value) : output.text), "Copy output")));
        if (output.kind === "json") outputParts.push(jsonTree(output.value));
        else outputParts.push(el("pre", "code-block insp-output" + (row.isError ? " is-error" : ""), output.text));
        if (output.clipped) {
          outputParts.push(el("div", "small dim", "The log keeps a shortened copy of long outputs: the text above ends where the log's copy ends."));
        }
      }
      parts.push(section(row.isError ? "Output (the tool reported an error)" : "Output", outputParts));
      if (!row.hosted) parts.push(...urlSection);

      if (row.images.length) {
        parts.push(section("Images returned (" + row.images.length + ")",
          el("div", "insp-returned", row.images.map((image, i) => {
            const caption = [row.tool + " image " + (i + 1), imageOrigin(image), image.width && image.height ? image.width + " × " + image.height + " px" : ""].filter(Boolean).join(" · ");
            return el("figure", "insp-returned-item", thumb(image, caption, "insp-returned-thumb"), el("figcaption", "xsmall dim", imageOrigin(image) || "image " + (i + 1)));
          }))));
      }
      replace(detail, parts);
      detail.scrollTop = 0;
    }

    function setFilter(next) {
      Object.assign(filter, next);
      showAll = false;
      applyText.cancel();
      if (panes.tools.built) renderList();
    }

    const follow = debounce(() => {
      if (destroyed || state.cursor === null) return;
      pick(atCursor(), { scroll: true });
    }, FOLLOW_DEBOUNCE_MS);

    function render() {
      const none = !state.tools.length;
      empty.hidden = !none;
      content.hidden = none;
      if (none) return;
      renderList();
    }

    return {
      el: pane,
      render,
      cursor() {
        dimmer.apply(state.cursor);
        follow();
      },
      api: { setFilter },
      destroy() {
        applyText.cancel();
        follow.cancel();
      },
    };
  }

  // ---------------------------------------------------------------- images

  function buildImages() {
    const filter = { source: "", turn: "" };
    const dimmer = createDimmer();
    let showAll = false;
    let highlighted = null;

    const meters = el("div", "insp-meters");
    const sourceField = selectField("Kind of view", (value) => { filter.source = value; showAll = false; renderGrid(); });
    const turnField = selectField("Sent with turn", (value) => { filter.turn = value; showAll = false; renderGrid(); });
    const totals = el("span", { class: "insp-count small dim num", role: "status" });
    const clearButton = el("button", { type: "button", class: "small ghost", onclick: () => setFilter({ source: "", turn: "" }) }, icon("x"), "Clear filters");
    const grid = el("div", "insp-gallery");
    const gridEmpty = el("div", "empty");
    const moreButton = el("button", { type: "button", class: "small", onclick: () => { showAll = true; renderGrid(); } });
    const empty = el("div", "empty", el("div", "empty-title", "No images yet"),
      "No view of this panorama has been sent to the model. The overview and the first views appear here with the first request.");
    const content = el("div", "stack", meters,
      el("div", "insp-filter", sourceField.node, turnField.node, clearButton, totals),
      grid, gridEmpty, moreButton,
      el("div", "small dim", "Token cost is an estimate from the pixel size (32 px patches). The model is billed what the API reports in the Turns tab."));
    const pane = el("div", "insp-pane-inner", empty, content);

    function renderMeters() {
      const budget = state.inspect ? state.inspect.image_budget : null;
      replace(meters, budgetMeters(budget).map((meter) => {
        const fill = el("div", "progress-fill " + meter.level);
        fill.style.width = (meter.share === null ? 0 : Math.round(meter.share * 1000) / 10) + "%";
        return el("div", "insp-meter",
          el("div", "row spread",
            el("span", "insp-meter-label", meter.label),
            el("span", "insp-meter-value num strong", meter.text)),
          el("div", { class: "progress", role: "progressbar", "aria-label": meter.label, "aria-valuemin": 0, "aria-valuemax": meter.max ?? 0, "aria-valuenow": meter.used }, fill),
          el("div", "small num " + (meter.level === "bad" ? "bad-text" : meter.level === "warn" ? "warn-text" : "dim"),
            (meter.percent ? meter.percent + " used, " : "") + meter.state));
      }));
    }

    function card(row) {
      const caption = viewCaption(row);
      const angles = anglesText(row);
      const picture = thumb(row, caption, "insp-view-thumb");
      if (row.cropN !== null) picture.append(el("span", { class: "insp-view-n num", title: "crop " + row.cropN + " on the panorama" }, String(row.cropN)));
      // Each fact is one unit: a line that is too long breaks between facts, never inside one.
      const facts = (parts, className) => el("div", "insp-view-facts xsmall num " + className, parts.map((part) => el("span", null, part)));
      return [
        picture,
        el("figcaption", "insp-view-caption",
          el("div", "row tight spread",
            el("span", "strong num nowrap", "#" + row.n),
            el("span", "small dim num grow", (row.turn === null ? "" : "turn " + row.turn + " · ") + (row.cropN !== null ? "crop " + row.cropN : row.sourceText)),
            seekButton(row.seq, "the request that sent it")),
          angles ? facts(angles.split(" · "), "") : el("div", "xsmall", aimText(row)),
          facts([
            row.width && row.height ? row.width + " × " + row.height + " px" : "size unknown",
            row.estTokens === null ? "tokens unknown" : "about " + fmtInt(row.estTokens) + " tokens",
          ], "dim")),
      ];
    }

    function renderGrid() {
      setOptions(sourceField.select, [{ value: "", label: "All views (" + state.gallery.length + ")" }]
        .concat(gallerySources(state.gallery).map((item) => ({ value: item.source, label: item.label + " (" + item.count + ")" }))), filter.source);
      filter.source = sourceField.select.value;
      setOptions(turnField.select, turnOptions(), filter.turn);
      filter.turn = turnField.select.value;

      const matching = filterGallery(state.gallery, filter);
      const shown = showAll ? matching : matching.slice(0, LIST_CAP);
      const filtered = !!(filter.source || filter.turn);
      const sum = galleryTotals(matching);
      clearButton.hidden = !filtered;
      totals.textContent = (filtered ? fmtInt(matching.length) + " of " : "") + plural(state.gallery.length, "view")
        + " · about " + fmtInt(sum.tokens) + " tokens" + (sum.unknownTokens ? " (" + sum.unknownTokens + " unknown)" : "")
        + " · " + fmtPayload(sum.chars);
      moreButton.hidden = matching.length <= shown.length;
      moreButton.textContent = "Show all " + fmtInt(matching.length) + " views (the first " + fmtInt(shown.length) + " are shown)";
      gridEmpty.hidden = matching.length > 0;
      grid.hidden = matching.length === 0;
      if (!matching.length) replace(gridEmpty, el("div", "empty-title", "No view matches"), "No view passes these filters. Clear them to see all " + plural(state.gallery.length, "view") + ".");

      syncList(grid, shown, (row) => row.key, () => {
        const node = el("figure", "insp-view");
        const enter = () => { if (node.dataset.crop) hoverCrop(Number(node.dataset.crop)); };
        const leave = () => { if (node.dataset.crop) hoverCrop(null); };
        node.addEventListener("mouseenter", enter);
        node.addEventListener("mouseleave", leave);
        node.addEventListener("focusin", enter);
        node.addEventListener("focusout", leave);
        return node;
      }, (node, row) => {
        const sig = JSON.stringify([row.cropN, row.yaw, row.pitch, row.fov, row.width, row.height, row.estTokens, row.turn]);
        if (row.cropN === null) delete node.dataset.crop;
        else node.dataset.crop = String(row.cropN);
        if (node.dataset.sig !== sig) {
          node.dataset.sig = sig;
          replace(node, card(row));
        }
        node.classList.toggle("is-highlight", highlighted !== null && row.cropN === highlighted);
      });
      dimmer.reset(shown.map((row, i) => ({ seq: row.seq, node: grid.children[i] })), state.cursor);
    }

    function setFilter(next) {
      Object.assign(filter, next);
      showAll = false;
      if (panes.images.built) renderGrid();
    }

    function render() {
      const none = !state.gallery.length;
      empty.hidden = !none;
      content.hidden = none;
      if (none) return;
      renderMeters();
      renderGrid();
    }

    return {
      el: pane,
      render,
      cursor() {
        dimmer.apply(state.cursor);
      },
      api: {
        setFilter,
        highlight(n) {
          highlighted = n;
          for (const node of grid.children) node.classList.toggle("is-highlight", n !== null && node.dataset.crop === String(n));
        },
      },
      destroy() {},
    };
  }

  // ---------------------------------------------------------------- penalty ledger

  function buildLedger() {
    const summary = el("div", "insp-ledger-summary");
    const tbody = el("tbody");
    const dimmer = createDimmer();
    const table = el("div", "table-wrap", el("table", "table compact insp-table",
      el("thead", null, el("tr", null,
        el("th", null, "#"), el("th", null, "Run time"), el("th", null, "Clock"), el("th", null, "Charge"),
        el("th", { class: "r" }, "Factor"), el("th", { class: "r" }, "Before"), el("th", { class: "r" }, "After"),
        el("th", null, "Running product"), el("th", null, el("span", "sr-only", "Actions")))),
      tbody));
    const empty = el("div", "empty");
    const pane = el("div", "insp-pane-inner stack", summary, empty, table);

    function renderSummary() {
      const rows = state.ledger;
      const now = ledgerSummary(rows, null);
      const parts = [el("div", "insp-ledger-now mono strong", now.text)];
      if (state.cursor !== null && rows.length) {
        const then = ledgerSummary(rows, state.cursor);
        parts.push(el("div", "small dim num", "At the scrubber: " + fmtMult(then.multiplier) + " (" + then.count + " of " + plural(rows.length, "charge") + " made by then)."));
      }
      replace(summary, parts);
    }

    function render() {
      const rows = state.ledger;
      renderSummary();
      // the empty state says the same thing, with the reason
      summary.hidden = rows.length === 0;
      empty.hidden = rows.length > 0;
      table.hidden = rows.length === 0;
      if (!rows.length) {
        const humanOff = (state.run && state.run.no_human === true) || (state.tile && state.tile.human_enabled === false);
        replace(empty, el("div", "empty-title mono", "No penalties: x1.0"),
          humanOff
            ? "Human channels were off for this run, so no question, cue or last-resort geocode could be charged."
            : "No question, cue or last-resort geocode has been charged on this panorama.");
        return;
      }
      syncList(tbody, rows, (row) => row.key, () => el("tr"), (node, row) => {
        const sig = JSON.stringify([row.kind, row.before, row.after, row.t_rel_s, row.ts, row.product]);
        if (node.dataset.sig === sig) return;
        node.dataset.sig = sig;
        replace(node,
          el("td", "num", String(row.index + 1)),
          el("td", "num", fmtMoment(row.t_rel_s)),
          el("td", "num dim", fmtTime(row.ts)),
          // A record of a charge, not a control: the penalty colour stays with the controls.
          el("td", null, badge(row.label, "warn", "alert")),
          el("td", "r mono", row.factor === null ? "–" : fmtMult(row.factor)),
          el("td", "r mono", row.before === null ? "–" : fmtMult(row.before)),
          el("td", "r mono", row.after === null ? "–" : fmtMult(row.after)),
          el("td", "mono strong", row.product || "–"),
          el("td", "insp-actions", seekButton(row.seq, "this charge"), eventButton(row.seq)));
      });
      dimmer.reset(rows.map((row, i) => ({ seq: row.seq, node: tbody.children[i] })), state.cursor);
    }

    return {
      el: pane,
      render,
      cursor() {
        dimmer.apply(state.cursor);
        renderSummary();
      },
      destroy() {},
    };
  }

  // ---------------------------------------------------------------- run facts and downloads

  function buildFacts() {
    const downloadsBox = el("section", "insp-section insp-downloads");
    const factsBox = el("div", "stack");
    const pane = el("div", "insp-pane-inner stack", downloadsBox, factsBox);
    const fetching = new AbortController();
    const revokes = new Map(); // timer -> object URL of a file that was just handed to the browser
    let busy = null; // which download is being fetched
    let failure = null; // {label, err} of the last download that failed
    let sig = "";
    let downloadsSig = "";

    const kv = (rows) => el("dl", "kv insp-kv", rows.map((row) => [
      el("dt", null, row.label),
      el("dd", null, el("span", "insp-kv-value wrap-any" + (row.mono ? " mono" : ""), row.value), row.extra || null),
    ]));

    function saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const anchor = el("a", { href: url, download: filename, hidden: true });
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      const timer = setTimeout(() => {
        revokes.delete(timer);
        URL.revokeObjectURL(url);
      }, REVOKE_MS);
      revokes.set(timer, url);
    }

    // The file is fetched by the page, so one that does not exist yet is explained here with the
    // server's reason. The link itself stays a plain link to the app's own endpoint.
    async function download(item) {
      if (busy) return;
      busy = item.what;
      failure = null;
      renderDownloads();
      try {
        const file = await fetchDownload(runId, pid, item.what, { signal: fetching.signal });
        if (destroyed) return;
        saveBlob(file.blob, file.filename);
      } catch (err) {
        if (destroyed || (err && err.name === "AbortError")) return;
        failure = { label: item.label, err };
      } finally {
        busy = null;
        if (!destroyed) renderDownloads();
      }
    }

    function renderDownloads() {
      const items = downloadItems(runId, pid, state.inspect);
      // unchanged: keep the nodes, so a link the operator has tabbed to keeps the focus
      const next = JSON.stringify([items.map((item) => item.disabled), busy, failure ? [failure.label, errorText(failure.err)] : null]);
      if (next === downloadsSig) return;
      downloadsSig = next;
      replace(downloadsBox,
        el("h4", "section-title", "Downloads"),
        el("div", "row wrap", items.map((item) => {
          if (item.disabled) return el("button", { type: "button", disabled: true, title: item.disabled }, icon("download"), item.label);
          const working = busy === item.what;
          return el("a", {
            class: "btn",
            href: item.href,
            download: item.filename,
            title: item.hint,
            "aria-busy": working ? "true" : null,
            "aria-disabled": busy && !working ? "true" : null,
            onclick: (event) => {
              // a modified click (new tab, save as) is the browser's own business
              if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              download(item);
            },
          }, working ? el("span", "spinner") : icon("download"), item.label, working ? el("span", "sr-only", " (downloading)") : null);
        })),
        items.filter((item) => item.disabled).map((item) => el("div", "small dim", item.label + ": " + item.disabled)),
        failure
          ? el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
            el("div", "grow stack tight",
              el("div", "strong", failure.label + " was not downloaded."),
              el("div", "pre", errorText(failure.err))),
            el("button", { type: "button", class: "icon-btn small", title: "Dismiss", "aria-label": "Dismiss this message", onclick: () => { failure = null; renderDownloads(); } }, icon("x")))
          : null);
    }

    function render() {
      const facts = (state.inspect && state.inspect.facts) || {};
      const tile = state.tile || {};
      const run = state.run || {};
      const panorama = facts.panorama || {};
      const prompt = typeof facts.system_prompt === "string" ? facts.system_prompt : "";
      const tools = toolsText(facts);
      renderDownloads();
      const next = JSON.stringify([
        facts.model, facts.effort, facts.git_sha, prompt.length, tools.length, facts.flags, facts.budget, facts.provenance, facts.request,
        facts.label, facts.capture_timestamp, facts.special, panorama, tile.model, tile.effort, tile.budget, run.fake_model, run.kind, run.preset,
      ]);
      if (next === sig) return;
      sig = next;

      const logged = facts.model !== null && facts.model !== undefined;
      const model = facts.model ?? tile.model ?? run.model ?? null;
      const effort = facts.effort ?? tile.effort ?? null;
      const budget = facts.budget || tile.budget || null;
      const runRows = [
        { label: "Model", value: model === null ? "not recorded" : String(model), mono: true },
        { label: "Effort", value: effort === null ? "not recorded" : String(effort) },
      ];
      if (run.preset || run.kind) runRows.push({ label: "Run", value: [run.preset ? "preset " + run.preset : null, run.kind ? "kind " + run.kind : null].filter(Boolean).join(", ") });
      runRows.push({
        label: "Git SHA",
        value: facts.git_sha ? String(facts.git_sha) : "not recorded",
        mono: true,
        extra: facts.git_sha ? copyButton(String(facts.git_sha), { title: "Copy the git SHA" }) : null,
      });
      runRows.push({ label: "Panorama", value: String(panorama.panorama_id ?? pid), mono: true });
      if (panorama.filename) runRows.push({ label: "File", value: String(panorama.filename), mono: true });
      if (panorama.width && panorama.height) runRows.push({ label: "Image size", value: fmtInt(panorama.width) + " × " + fmtInt(panorama.height) + " px" });
      if (panorama.sha256) runRows.push({ label: "Image SHA-256", value: String(panorama.sha256), mono: true, extra: copyButton(String(panorama.sha256), { title: "Copy the image hash" }) });

      const provenance = provenanceRows(facts);
      const flags = flagRows(facts.flags);
      const budgetList = budgetRows(budget);
      const names = toolDefinitionNames(facts);

      const parts = [];
      if (!logged) {
        parts.push(notice("info", "info", "This panorama has not logged a run start yet, so the prompt, tools and flags are not known. They appear with its first request."));
      }
      if (run.fake_model) {
        parts.push(notice("warn", "alert", "This run used the scripted demo model, not the real one: its answers are demo answers."));
      }
      parts.push(el("div", "insp-facts-grid",
        el("div", "card", el("h4", "section-title", "Run"), kv(runRows)),
        el("div", "card", el("h4", "section-title", "Budget"),
          budgetList.length ? kv(budgetList) : el("div", "dim", "No budget was recorded.")),
        el("div", "card", el("h4", "section-title", "Flags"),
          flags.length ? kv(flags) : el("div", "dim", "No flags were recorded.")),
        el("div", "card", el("h4", "section-title", "Task input and where it came from"),
          kv(provenance.map((row) => ({
            label: row.label,
            value: row.value,
            extra: el("div", "small dim", row.source + (row.parsed ? " (the files said " + row.parsed + ")" : "")),
          }))),
          provenance.some((row) => !row.recorded)
            ? el("div", "small dim", logged
              ? "A source reads \"not recorded\" when the run was started from the command line, which logs the values without their origin."
              : "Where each value came from is logged when the panorama starts.")
            : null)));

      if (facts.request !== null && facts.request !== undefined) {
        parts.push(section("Request parameters",
          el("div", "row tight", labelledCopy(() => prettyJson(facts.request), "Copy JSON")), jsonTree(facts.request)));
      }
      parts.push(section("System prompt, exactly as sent" + (prompt ? " (" + fmtInt(prompt.length) + " characters)" : ""),
        prompt
          ? [el("div", "row tight", labelledCopy(prompt, "Copy prompt"), el("span", "small dim", "Read-only: the prompt cannot be edited from the console.")),
            el("pre", { class: "code-block insp-prompt", tabIndex: 0, "aria-label": "System prompt" }, prompt)]
          : el("div", "dim", "The log holds no system prompt for this panorama.")));
      parts.push(section("Tool definitions, exactly as sent" + (names.length ? " (" + plural(names.length, "tool") + ")" : ""),
        tools
          ? [el("div", "row tight wrap", labelledCopy(tools, "Copy JSON"), names.map((name) => el("span", "chip mono", name))),
            jsonTree(facts.tools)]
          : el("div", "dim", "The log holds no tool definitions for this panorama.")));
      replace(factsBox, parts);
    }

    return {
      el: pane,
      render,
      cursor() {},
      destroy() {
        fetching.abort();
        for (const [timer, url] of revokes) {
          clearTimeout(timer);
          URL.revokeObjectURL(url);
        }
        revokes.clear();
      },
    };
  }

  // ---------------------------------------------------------------- ground truth

  function buildTruth() {
    const pane = el("div", "insp-pane-inner stack");
    const mapHost = el("div", "insp-truth-map");
    const facts = el("div", "insp-truth-facts stack");
    const chartHost = el("div", "insp-chart insp-truth-chart");
    const chartNote = el("div", "small dim");
    const empty = el("div", "empty");
    const content = el("div", "stack",
      notice("info", "info", "Ground truth is shown because this is an evaluation run with human channels off. It never appears for a run where a question, cue or geocode could be used."),
      el("div", "insp-truth-grid", mapHost, facts),
      section("Distance of the top hypothesis from the truth", chartHost, chartNote));
    pane.append(empty, content);
    let map = null;
    let chart = null;
    let plan = null;
    let sig = "";

    function render() {
      const entry = state.truthEntry;
      empty.hidden = !!entry;
      content.hidden = !entry;
      if (!entry) {
        replace(empty, el("div", "empty-title", "No score for this panorama yet"),
          "The run's truth is available, but this panorama has no export to score. It is scored once its answer is final and exported.",
          el("div", null, el("button", { type: "button", class: "small", onclick: refresh }, icon("refresh"), "Check again")));
        return;
      }
      const next = JSON.stringify([entry, state.inspect ? state.inspect.last_seq : null]);
      if (next === sig) {
        cursor();
        return;
      }
      sig = next;

      const stats = truthStats(entry);
      const answers = distinctAnswers(entry.entries);
      const rows = [
        { label: "Rank-1 distance", value: fmtDist(stats.rank1DistanceM), extra: stats.bandText ? el("span", "small dim", " (" + stats.bandText + ")") : null },
        { label: "Score", value: stats.score === null ? "–" : fmtInt(stats.score) + (stats.maxScore === null ? "" : " of " + fmtInt(stats.maxScore)) },
        { label: "Share of the maximum", value: fmtPct(stats.share, 1) },
        { label: "Truth", value: fmtLatLng(entry.lat, entry.lng), mono: true, extra: copyButton(fmtLatLng(entry.lat, entry.lng), { title: "Copy the truth coordinates" }) },
      ];
      if (stats.label) rows.push({ label: "Label", value: stats.label });
      if (stats.nearest && stats.nearest.ranks[0] !== 1) {
        rows.push({ label: "Nearest entry", value: fmtDist(stats.nearest.distanceM) + " at rank " + stats.nearest.rankText });
      }
      const share = el("div", "progress-fill ok");
      share.style.width = (stats.share === null ? 0 : Math.max(0, Math.min(100, stats.share * 100))) + "%";
      replace(facts,
        el("dl", "kv insp-kv", rows.map((row) => [
          el("dt", null, row.label),
          el("dd", null, el("span", "insp-kv-value num" + (row.mono ? " mono" : ""), row.value), row.extra || null),
        ])),
        el("div", { class: "progress", role: "progressbar", "aria-label": "Share of the maximum score", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": stats.share === null ? 0 : Math.round(stats.share * 100) }, share),
        el("div", "table-wrap", el("table", "table compact insp-table",
          el("thead", null, el("tr", null, el("th", null, "Ranks"), el("th", null, "Answer"), el("th", { class: "r" }, "Distance"), el("th", { class: "r" }, "Theta"))),
          el("tbody", null, answers.length
            ? answers.map((answer) => el("tr", null,
              el("td", "num", answer.rankText),
              el("td", "mono", fmtCoord(answer.lat) + ", " + fmtCoord(answer.lng), copyButton(fmtLatLng(answer.lat, answer.lng), { title: "Copy these coordinates" })),
              el("td", "r", fmtDist(answer.distanceM)),
              el("td", "r", answer.theta === null ? "–" : answer.theta.toFixed(3))))
            : el("tr", null, el("td", { colSpan: 4, class: "dim" }, "The export holds no answer entries."))))),
        el("div", "small dim", plural(stats.entries, "entry", "entries") + " in the list, " + plural(stats.distinct, "distinct point") + ". Theta is the distance factor of an entry: 2 within 10 m of the truth, 1 at "
          + (stats.label === "Urban" ? "100 m" : stats.label === "non-Urban" ? "10 km" : "100 m (Urban) or 10 km (non-Urban)")
          + ", falling towards 0 further away."));

      if (!map) map = createMap(mapHost, { interactive: true, layer: "street", scale: true });
      const entries = Array.isArray(entry.entries) ? entry.entries : [];
      map.setEntries(entries);
      map.setAnswer(entries[0] || null, { final: true });
      map.setPath(state.inspect && state.inspect.series ? state.inspect.series.top_path : []);
      map.setTruth({ lat: entry.lat, lng: entry.lng }, { lines: entries });
      map.fit();

      plan = truthChart(entry, state.inspect);
      const chartOptions = {
        series: [{ name: "Top hypothesis to truth", points: plan.points }],
        x: plan.axis === "time" ? { label: "Run time", format: fmtClock } : { label: "Event", format: (value) => "#" + Math.round(value) },
        y: { label: "Distance", format: fmtDist, log: plan.log },
        step: true,
        cursor: plan.xAt(state.cursor),
        empty: "The agent logged no hypotheses, so there is no distance to draw.",
        onPick: onSeek ? (x) => {
          const seq = plan.seqAt(x);
          if (seq !== null) onSeek(seq);
        } : undefined,
      };
      if (!chart) chart = lineChart(chartHost, chartOptions);
      else chart.update(chartOptions);
      chartNote.textContent = plan.points.length
        ? "One step per hypothesis update" + (plan.log ? ", on a logarithmic scale" : "") + (onSeek ? ". Click the chart to go to that moment." : ".")
        : "";
    }

    function cursor() {
      if (chart && plan) chart.update({ cursor: plan.xAt(state.cursor) });
    }

    return {
      el: pane,
      render,
      cursor,
      shown() {
        if (map) map.invalidate();
      },
      destroy() {
        if (chart) chart.destroy();
        if (map) map.destroy();
      },
    };
  }

  // ---------------------------------------------------------------- panes and tabs

  const builders = { turns: buildTurns, tools: buildTools, images: buildImages, ledger: buildLedger, facts: buildFacts, truth: buildTruth };
  const panes = {};
  for (const name of TABS) {
    const host = el("div", {
      class: "insp-pane insp-pane-" + name,
      role: "tabpanel",
      id: uid + "-pane-" + name,
      "aria-labelledby": uid + "-tab-" + name,
      tabIndex: -1,
      hidden: true,
    });
    body.append(host);
    panes[name] = { host, built: false, dirty: true, cursorDirty: false, part: null, api: null };
  }
  // The tools and images filters are set from the turns tab before those panes may exist.
  panes.tools.api = { setFilter: (next) => ensure("tools").api.setFilter(next) };
  panes.images.api = { setFilter: (next) => ensure("images").api.setFilter(next), highlight: (n) => { if (panes.images.built) panes.images.part.api.highlight(n); } };

  function ensure(name) {
    const pane = panes[name];
    if (!pane.built) {
      pane.part = builders[name]();
      pane.host.append(pane.part.el);
      pane.built = true;
    }
    return pane.part;
  }

  const hasTruth = () => state.truthPayload !== null && truthAllowed(state.run, state.tile);

  function renderPane(name) {
    const pane = panes[name];
    if (!state.inspect) return;
    const part = ensure(name);
    if (pane.dirty) {
      pane.dirty = false;
      pane.cursorDirty = false;
      part.render();
    } else if (pane.cursorDirty) {
      pane.cursorDirty = false;
      part.cursor();
    }
  }

  function showTab(name) {
    const next = tabName(name, { truth: hasTruth() });
    state.tab = next;
    root.dataset.tab = next;
    for (const tab of TABS) {
      const on = tab === next;
      const button = tabButtons.get(tab);
      button.setAttribute("aria-selected", on ? "true" : "false");
      button.tabIndex = on ? 0 : -1;
      panes[tab].host.hidden = !on || !state.inspect;
    }
    if (!state.inspect) return;
    renderPane(next);
    const part = panes[next].part;
    if (part && part.shown) part.shown();
  }

  function chooseTab(name) {
    const before = state.tab;
    state.wantedTab = "";
    showTab(name);
    if (state.tab !== before && onTab) onTab(state.tab);
  }

  function renderTabs() {
    const truth = hasTruth();
    tabButtons.get("truth").hidden = !truth;
    const counts = {
      turns: state.turns.length,
      tools: state.tools.length,
      images: state.gallery.length,
      ledger: state.ledger.length,
    };
    for (const [name, node] of tabCounts) {
      node.textContent = state.inspect && counts[name] !== undefined ? fmtInt(counts[name]) : "";
    }
    // `?tab=truth` can arrive before the truth does: honour it once it is here.
    if (truth && state.wantedTab === "truth") {
      state.wantedTab = "";
      showTab("truth");
    } else if (!truth && state.tab === "truth") showTab("turns");
  }

  // ---------------------------------------------------------------- status line

  function renderStatus() {
    if (!state.inspect) {
      replace(status);
      return;
    }
    const parts = [];
    const last = state.inspect.last_seq;
    if (state.cursor !== null) {
      const event = eventAt(state.inspect, state.cursor);
      parts.push(el("span", "num", "Showing the run at event #" + state.cursor
        + (event && typeof event.t_rel_s === "number" ? " (" + fmtClock(event.t_rel_s) + ")" : "") + "; later rows are dimmed."));
    } else if (typeof last === "number") {
      parts.push(el("span", "dim num", last > 0 ? "Loaded up to event #" + last + "." : "No events logged yet."));
    }
    const newer = staleCount(state.inspect, state.tile);
    if (state.loadError) {
      parts.push(el("span", "bad-text", icon("alert"), " Refresh failed: " + errorText(state.loadError)));
    } else if (newer > 0) {
      parts.push(el("span", "warn-text num", icon("info"), " " + plural(newer, "newer event") + " not shown yet."));
    }
    if (newer > 0 || state.loadError) {
      parts.push(el("button", { type: "button", class: "small", disabled: state.refreshing, onclick: refresh },
        state.refreshing ? el("span", "spinner") : icon("refresh"), state.refreshing ? "Refreshing" : "Refresh"));
    }
    replace(status, parts);
  }

  function refresh() {
    if (state.refreshing) return;
    if (onRefresh) {
      onRefresh();
      return;
    }
    load({ force: true });
  }

  // One timer at a time, and none for a tab in the background: a live run is caught up with at
  // most every AUTO_REFRESH_MS, however fast its events arrive.
  function scheduleRefresh() {
    if (!ownsData || onRefresh || destroyed || refreshTimer !== null) return;
    if (staleCount(state.inspect, state.tile) <= 0) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (destroyed || state.refreshing || document.hidden) return;
      if (staleCount(state.inspect, state.tile) > 0) load({ force: true, auto: true });
    }, AUTO_REFRESH_MS);
  }

  // ---------------------------------------------------------------- data in

  function showState(...children) {
    replace(stateBox, children);
    stateBox.hidden = children.length === 0;
    body.hidden = children.length > 0;
  }

  function showLoading() {
    showState(el("div", "empty", el("span", "spinner"), "Loading the turns, tool calls and images of this panorama…"));
  }

  function setLoading() {
    if (destroyed || state.inspect) return;
    showLoading();
  }

  function setError(err, { onRetry } = {}) {
    if (destroyed) return;
    state.loadError = err || null;
    if (state.inspect) {
      renderStatus();
      return;
    }
    const retry = callable(onRetry);
    showState(el("div", "notice notice-bad insp-error", icon("alert"),
      el("div", "grow stack tight",
        el("div", "strong", "The inspector could not be loaded."),
        el("div", "pre", errorText(err)),
        retry ? el("div", null, el("button", { type: "button", onclick: () => { showLoading(); retry(); } }, icon("refresh"), "Try again")) : null)));
  }

  function derive() {
    const inspect = state.inspect;
    state.turns = turnRows(inspect);
    state.tools = toolRows(inspect);
    state.gallery = galleryRows(inspect, state.tile);
    state.views = panoramaViews(inspect, state.tile);
    deriveLedger();
    state.truthEntry = hasTruth() ? truthFor(state.truthPayload, pid) : null;
  }

  // The tile's ledger comes over the live stream, so it can be ahead of the loaded payload.
  function deriveLedger() {
    const loaded = state.inspect && Array.isArray(state.inspect.ledger) ? state.inspect.ledger : [];
    const live = state.tile && Array.isArray(state.tile.ledger) ? state.tile.ledger : [];
    state.ledger = ledgerRows(live.length > loaded.length ? live : loaded);
  }

  function setData(inspect, extra = {}) {
    if (destroyed) return;
    if (!inspect || typeof inspect !== "object") {
      setError(new Error("The inspector was given no data for this panorama. Reload the page."));
      return;
    }
    state.inspect = inspect;
    state.loadError = null;
    if (extra && extra.truth !== undefined) state.truthPayload = extra.truth && typeof extra.truth === "object" ? extra.truth : null;
    derive();
    for (const name of TABS) panes[name].dirty = true;
    showState();
    renderTabs();
    showTab(state.wantedTab && state.wantedTab !== "truth" ? state.wantedTab : state.tab);
    if (state.wantedTab !== "truth") state.wantedTab = "";
    renderStatus();
  }

  function setTab(name) {
    if (destroyed) return;
    const wanted = String(name ?? "").toLowerCase();
    state.wantedTab = wanted === "truth" && !hasTruth() ? "truth" : state.inspect ? "" : wanted;
    showTab(wanted);
  }

  function setCursor(seq) {
    if (destroyed) return;
    const n = seq === null || seq === undefined || seq === "" ? null : Number(seq);
    const next = n === null || !Number.isFinite(n) ? null : n;
    if (next === state.cursor) return;
    state.cursor = next;
    if (!state.inspect) return;
    for (const name of TABS) {
      const pane = panes[name];
      if (!pane.built || pane.dirty) continue;
      if (name === state.tab) pane.part.cursor();
      else pane.cursorDirty = true;
    }
    renderStatus();
  }

  function update(tile, run) {
    if (destroyed) return;
    state.tile = tile || null;
    state.run = run || null;
    const t = state.tile || {};
    const r = state.run || {};
    const sig = JSON.stringify([
      t.last_seq, t.human_enabled, t.model, t.effort, t.status,
      Array.isArray(t.ledger) ? t.ledger.length : 0, Array.isArray(t.crops) ? t.crops.length : 0,
      r.kind, r.no_human, r.fake_model, r.preset, r.model,
    ]);
    if (sig === updateSig) return;
    const previous = updateSig ? JSON.parse(updateSig) : [];
    updateSig = sig;
    if (!state.inspect) return;
    const now = JSON.parse(sig);
    const ledgerBefore = state.ledger.length;
    deriveLedger();
    if (state.ledger.length !== ledgerBefore || now[1] !== previous[1] || now[8] !== previous[8]) panes.ledger.dirty = true;
    if (now[6] !== previous[6]) {
      state.gallery = galleryRows(state.inspect, state.tile);
      state.views = panoramaViews(state.inspect, state.tile);
      panes.images.dirty = true;
      panes.tools.dirty = true;
    }
    state.truthEntry = hasTruth() ? truthFor(state.truthPayload, pid) : null;
    panes.truth.dirty = true;
    panes.facts.dirty = true;
    renderTabs();
    renderPane(state.tab);
    renderStatus();
    scheduleRefresh();
  }

  /**
   * Load the payload (and the truth, when the run has one) and show it, with the loading and error
   * states handled here. Resolves with `{inspect, truth}`, or null when it failed or was replaced.
   * `auto` marks the inspector's own catching up: the truth is then only asked for again once
   * its last answer has aged, because scoring a whole run every few seconds is not free.
   */
  function load({ force = false, auto = false } = {}) {
    if (destroyed) return Promise.resolve(null);
    if (loader) loader.abort();
    const controller = new AbortController();
    loader = controller;
    ownsData = true;
    state.refreshing = true;
    setLoading();
    renderStatus();
    const done = () => {
      if (loader === controller) {
        loader = null;
        state.refreshing = false;
      }
    };
    // A truth request that fails for another reason than "not available" must not hide the
    // inspector: the payload is shown and the failure is reported on the status line.
    let truthError = null;
    const truth = loadTruth(runId, { force: force && !auto, signal: controller.signal }).catch((err) => {
      if (!err || err.name !== "AbortError") truthError = err;
      return undefined;
    });
    return Promise.all([loadInspect(runId, pid, { force, signal: controller.signal }), truth]).then(
      ([inspect, truthPayload]) => {
        if (destroyed || loader !== controller) return null;
        done();
        setData(inspect, { truth: truthPayload });
        if (truthError) {
          state.loadError = truthError;
          renderStatus();
        }
        scheduleRefresh();
        return { inspect, truth: truthPayload ?? null };
      },
      (err) => {
        if (destroyed || loader !== controller || (err && err.name === "AbortError")) return null;
        done();
        setError(err, { onRetry: () => load({ force: true }) });
        return null;
      },
    );
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (loader) loader.abort();
    loader = null;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    if (openBox) openBox.close();
    openBox = null;
    if (hoveredCrop !== null && onCropHover) onCropHover(null);
    hoveredCrop = null;
    for (const name of TABS) {
      if (panes[name].built) panes[name].part.destroy();
    }
    root.remove();
  }

  setTab(state.wantedTab || "turns");
  setLoading();

  return {
    setData,
    setTab,
    setCursor,
    update,
    destroy,
    el: root,
    load,
    setLoading,
    setError,
    highlightCrop(n) {
      if (!destroyed) panes.images.api.highlight(n === null || n === undefined ? null : n);
    },
    getState() {
      return {
        tab: state.tab,
        cursor: state.cursor,
        loaded: !!state.inspect,
        lastSeq: state.inspect ? state.inspect.last_seq ?? null : null,
        truth: hasTruth(),
        turns: state.turns.length,
        tools: state.tools.length,
        images: state.gallery.length,
        charges: state.ledger.length,
      };
    },
  };
}
