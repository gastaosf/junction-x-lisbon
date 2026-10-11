// Panorama focus and replay (UI-SPEC 5.5 and 5.6): one panorama, full page.
//
// The same screen serves a panorama that is running and one that has ended. Without `?at=` it
// shows the latest state and, like a tile, the operator controls. With `?at=<seq>` it is a
// replay: the head, time bar, viewer footprints, map, hypothesis table and answer list are drawn
// from the state at that event, the stream and the inspector mark that moment, and no control
// that sends anything exists on the page until the operator goes back.
//
// URL (contract A1): at, event, filter, q, tab, open. The cursor lives in `at`; the scrubber, the
// keys [ ] , . and the inspector's "go to this moment" buttons all move it through seek().
//
// Rule compliance: this screen adds no input of its own. The MCQ panel and the control bar are
// the ones of components/controls.js, placed exactly as on a tile; everything else is read-only
// navigation over a log. Ground truth is drawn only for an evaluation run with human channels
// off, and only after the server handed it over (logic/replay.js truthPoint).

import { api, ApiError, errorText, panoUrl, runUrl } from "../api.js";
import { lineChart } from "../components/charts.js";
import { controlBar, mcqPanel } from "../components/controls.js";
import { createMap } from "../components/map.js";
import { createPanoViewer } from "../components/pano-viewer.js";
import { toast } from "../components/shell.js";
import { createStream, formatFilter } from "../components/stream.js";
import { answerList, confidenceLine, hypothesisTable, panoSources, tileHead, timeBar } from "../components/tile.js";
import { debounce, el, icon, replace, syncList } from "../dom.js";
import { fmtClock, fmtPct } from "../format.js";
import { isTyping, shortcuts } from "../keyboard.js";
import { attentionFor, attentionItems } from "../logic/attention.js";
import {
  bannerModel,
  beliefSeries,
  frameTile,
  neighbours,
  parseAt,
  parseOpen,
  pathUpTo,
  refreshPlan,
  resolveCursor,
  timelineModel,
  truthPoint,
} from "../logic/replay.js";
import { chosenPoint, flagModel, isFinal, sourcesKey, tileStatus, viewerCrops } from "../logic/tile.js";
import { link, navigate, paths, query as currentQuery, setQuery } from "../router.js";
import { store } from "../store.js";
import { loadInspect, loadTruth } from "./focus/data.js";
import { createInspector } from "./focus/inspector.js";
import { createScrubber } from "./focus/scrubber.js";

const URL_WRITE_MS = 150; // `?at=` follows the scrubber once it rests: browsers limit history writes
const EXACT_MS = 160; // the exact tile of a moment is asked for once the scrubber rests there
const EXACT_KEPT = 60; // exact tiles kept while the screen is open
const INDEX_REFRESH_MS = 600; // a run read from disk is read again this long after the index changed
const FLAG_TICK_MS = 1000; // the attention flags count down

const isNotFound = (err) => err instanceof ApiError && err.status === 404;
const hasTiles = (run) => Boolean(run) && Array.isArray(run.panoramas) && run.panoramas.length > 0;

function part(className, title, ...children) {
  return el("section", "focus-part " + className, title ? el("h3", "section-title", title) : null, ...children);
}

function noticeLine(kind, iconName) {
  const text = el("span", "tile-notice-text");
  const actions = el("span", "tile-notice-actions");
  const node = el("div", { class: "notice notice-" + kind, hidden: true, role: "status" }, icon(iconName), el("div", "tile-notice-body", text, actions));
  return { node, text, actions };
}

function setText(node, text) {
  const value = String(text ?? "");
  if (node.textContent !== value) node.textContent = value;
}

export function mount(container, params, ctx) {
  const runId = params.runId;
  const pid = params.pid;
  const abort = new AbortController();
  const cleanups = [];
  let alive = true;

  // ---- the run and the panorama
  let fetchedRun = null; // a run this server does not hold, read with GET
  let runLoading = true;
  let runError = null;
  let shownState = ""; // which of the whole-page states is drawn: "", "loading", "error", "missing", "main"

  // ---- the cursor
  let at = parseAt(ctx.query.get("at"));
  let atDirty = false; // the cursor moved and the URL has not followed yet
  let wantedOpen = parseOpen(ctx.query.get("open"));
  if (wantedOpen) at = null;
  let urlEvent = parseAt(ctx.query.get("event"));
  let urlTab = ctx.query.get("tab") || "";

  // ---- fetched data
  let inspect = null;
  let model = timelineModel(null);
  let chartPlan = beliefSeries(null, model);
  let truth = null;
  let truthAsked = false;
  let truthKey = "";
  let inspectLoading = false;
  let inspectError = null;
  let askedSeq = -1; // the tile's last_seq when the last forced inspect request was started
  let lastStartMs = 0;
  let refreshTimer = null;
  let exact = null; // {seq, tile}: the server's own tile for the cursor
  let exactError = null; // {seq, err}
  let exactAbort = null;
  const exactKept = new Map();

  // ---- the built screen (null until the panorama is known)
  let view = null;
  let lastTile = null;
  let lastRun = null;

  ctx.setTitle(pid + " · " + runId);

  // ================================================================ run state

  function currentRun() {
    const held = store.run(runId);
    // A `run` message for a run this server does not hold reaches the store without its
    // panoramas: such an entry cannot answer for a panorama, the run we read ourselves can.
    if (held && (held.owned || hasTiles(held))) return held;
    return fetchedRun;
  }

  const tileOf = (run) => (run && Array.isArray(run.panoramas) ? run.panoramas.find((tile) => tile && tile.panorama_id === pid) || null : null);

  async function loadRun({ force = false } = {}) {
    runLoading = true;
    if (!currentRun()) sync();
    try {
      let run = await store.loadRun(runId, { force });
      if (run && !run.owned && !hasTiles(run)) run = await api.get(runUrl(runId), { signal: abort.signal });
      if (!alive) return;
      fetchedRun = run;
      runError = null;
    } catch (err) {
      if (!alive || (err && err.name === "AbortError")) return;
      // A refresh that failed leaves the run we already show alone.
      if (!currentRun()) runError = err;
    }
    runLoading = false;
    sync();
  }

  // ================================================================ whole-page states

  function navRow(run) {
    const around = neighbours(run, pid);
    const step = (target, label, iconName, before) => {
      const children = before ? [icon(iconName), label] : [label, icon(iconName)];
      return target === null
        ? el("button", { type: "button", class: "small", disabled: true, title: "There is no " + label.toLowerCase() + " panorama in this run" }, children)
        : link(paths.pano(runId, target), { class: "btn small", title: label + " panorama: " + target }, children);
    };
    return el("nav", { class: "focus-nav", "aria-label": "Panorama navigation" },
      link(paths.run(runId), { class: "btn small" }, icon("arrow-left"), "Run dashboard"),
      el("span", "focus-nav-run mono dim", String(runId)),
      el("span", "grow"),
      around.index >= 0 ? el("span", "focus-nav-count num dim", "Panorama " + (around.index + 1) + " of " + around.total) : null,
      el("span", { class: "btn-group", role: "group", "aria-label": "Other panoramas of this run" },
        step(around.previous, "Previous", "chevron-left", true),
        step(around.next, "Next", "chevron-right", false)),
      link(paths.stage(runId, { pano: pid }), { class: "btn small", title: "The audience view of this panorama" }, icon("eye"), "Stage view"),
      link(paths.submit(runId), { class: "btn small", title: "Validate and download the exports of this run" }, icon("download"), "Submission"));
  }

  function showPage(state, ...children) {
    destroyView();
    shownState = state;
    replace(container, children);
  }

  function showLoading() {
    if (shownState === "loading") return;
    showPage("loading", el("p", "screen-loading dim", el("span", "spinner"), " Loading run " + runId + "…"));
  }

  function showRunError() {
    const key = "error:" + (runError ? runError.message : "");
    if (shownState === key) return;
    const missing = isNotFound(runError);
    showPage(key, el("div", "card screen-error",
      el("h2", "card-title row", icon(missing ? "question" : "alert"), missing ? "No such run" : "This run could not be loaded"),
      missing
        ? el("p", null, "There is no run ", el("code", null, String(runId)), " on this server. It may have been deleted, or the link is from another machine.")
        : el("p", null, "The page could not read run ", el("code", null, String(runId)), " from the server."),
      el("pre", "error-text", errorText(runError)),
      el("div", "row wrap",
        missing ? null : el("button", { type: "button", class: "primary", onclick: () => loadRun({ force: true }) }, icon("refresh"), "Try again"),
        link(paths.runs(), { class: "btn" + (missing ? " primary" : "") }, icon("arrow-left"), "Back to runs"))));
  }

  function showMissing(run) {
    const ids = neighbours(run, pid).ids;
    const key = "missing:" + ids.join("\n");
    if (shownState === key) return;
    showPage(key, el("div", "card screen-error",
      el("h2", "card-title row", icon("question"), "No such panorama"),
      el("p", null, "Run ", el("code", null, String(runId)), " has no panorama ", el("code", null, String(pid)), ". ",
        ids.length ? "These are the panoramas it has:" : "It has no panoramas yet."),
      ids.length ? el("ul", "focus-missing-list", ids.map((id) => el("li", null, link(paths.pano(runId, id), { class: "mono" }, String(id))))) : null,
      el("div", "row wrap",
        link(paths.run(runId), { class: "btn primary" }, icon("arrow-left"), "Back to the run dashboard"),
        link(paths.runs(), { class: "btn" }, "All runs"))));
  }

  // ================================================================ the main view

  function buildView(tile, run) {
    destroyView();
    shownState = "main";
    const offs = [];
    const drawn = { sources: "", crops: "", hypotheses: "", clusters: "", answer: "", path: "", truth: "", nav: "", chart: null, mode: null };

    const navSlot = el("div", "focus-nav-slot");
    const headSlot = el("div", "focus-head-slot");
    const flagBox = el("div", { class: "tile-flags", role: "group", "aria-label": "Needs attention now" });
    // In a replay the head above shows a past moment; these are about the panorama as it is now.
    const flagLabel = el("span", { class: "focus-flags-label caps xsmall", hidden: true }, "Live now");
    const flagRow = el("div", { class: "focus-flags", hidden: true }, flagLabel, flagBox);
    const timeSlot = el("div", "focus-time-slot");
    const scrubSlot = el("div", "focus-scrub-slot");
    const replayNote = el("div", { class: "notice notice-warn focus-replay-note", hidden: true, role: "status" });
    const viewerBox = el("div", "focus-viewer");
    const confSlot = el("div", "focus-conf-slot");
    const mapBox = el("div", "focus-map");
    const truthNote = el("p", { class: "focus-truth-note small dim", hidden: true },
      icon("star"), " The star is the ground truth. It is drawn because this is an evaluation run with human channels off.");
    const mcqSlot = el("div", "focus-mcq");
    const hypSlot = el("div", "focus-hyp-slot");
    const answerSlot = el("div", "focus-answer-slot");
    const streamBox = el("div", "focus-stream");
    const controlSlot = el("div", "focus-controls");
    const chartBox = el("div", "focus-chart");
    const chartNote = el("p", "focus-chart-note small dim");
    const inspectorBox = el("div", "focus-inspector-box");

    const interrupted = noticeLine("warn", "alert");
    const apiTrouble = noticeLine("bad", "alert");
    const exportTrouble = noticeLine("bad", "file");
    const notices = el("div", "tile-notices", interrupted.node, apiTrouble.node, exportTrouble.node);
    interrupted.actions.append(link(paths.submit(runId), { class: "btn small" }, "Open Submission"));
    exportTrouble.actions.append(link(paths.submit(runId), { class: "btn small" }, "Open Submission"));
    apiTrouble.actions.append(el("button", { type: "button", class: "small", onclick: () => showErrors() }, icon("search"), "Show the errors"));

    const root = el("div", { class: "focus", dataset: { pid: String(pid), run: String(runId) } },
      navSlot,
      el("div", "focus-top panel", headSlot, flagRow, notices, timeSlot),
      scrubSlot,
      replayNote,
      el("div", "focus-main",
        part("focus-part-viewer", null, viewerBox),
        part("focus-part-map", "Where it thinks it is", confSlot, mapBox, truthNote),
        mcqSlot,
        part("focus-part-hyps", "Hypotheses", hypSlot),
        part("focus-part-answer", null, answerSlot),
        part("focus-part-stream", "Reasoning stream", streamBox),
        controlSlot),
      el("section", "focus-evolution panel",
        el("h3", "section-title", "Hypothesis evolution"),
        chartNote,
        chartBox),
      el("section", "focus-inspector",
        el("h3", "section-title", "Inspector"),
        inspectorBox));
    replace(container, root);

    // ---- parts that follow the cursor

    let stateParts = null; // {replay, head, time, answer}: these three take `replay` when created
    const conf = confidenceLine(confSlot);
    const hyps = hypothesisTable(hypSlot, { onHover: (index) => map.highlightHypothesis(index) });

    function ensureStateParts(replay) {
      if (stateParts && stateParts.replay === replay) return;
      if (stateParts) for (const piece of [stateParts.head, stateParts.time, stateParts.answer]) piece.destroy();
      stateParts = {
        replay,
        head: tileHead(headSlot, { runId, pid, link: false, replay }),
        time: timeBar(timeSlot, { replay }),
        answer: answerList(answerSlot, { replay }),
      };
    }

    // ---- viewer, map, stream

    const viewer = createPanoViewer(viewerBox, {
      sources: panoSources(runId, pid, tile),
      mode: "360",
      ruler: true,
      controls: true,
      label: "Panorama " + pid + ": drag to look around, wheel to zoom, double-click to reset",
    });
    drawn.sources = sourcesKey(panoSources(runId, pid, tile));
    const map = createMap(mapBox, { interactive: true, layer: "street", scale: true, wheel: true });
    const stream = createStream(streamBox, {
      runId,
      pid,
      height: "fill",
      live: true,
      filter: currentQuery().get("filter"),
      search: currentQuery().get("q"),
      onChange: (state) => { if (alive) setQuery({ filter: formatFilter(state.filter), q: state.search }); },
      onOpenEvent: (seq) => {
        if (!alive) return;
        urlEvent = seq === null || seq === undefined ? null : Number(seq);
        setQuery({ event: urlEvent });
      },
      onCropHover: (n) => hoverCrop("stream", n),
    });

    // A crop is the same thing in three places: its footprint, its stream entries, its gallery view.
    function hoverCrop(from, n) {
      if (!alive) return;
      const value = n === null || n === undefined ? null : n;
      if (from !== "viewer") viewer.highlightCrop(value);
      if (from !== "stream") stream.highlightCrop(value);
      if (from !== "inspector") inspector.highlightCrop(value);
    }
    offs.push(viewer.onCropHover((n) => hoverCrop("viewer", n)));
    // A click on a footprint finds the call that made it in the stream.
    offs.push(viewer.onCropClick((n) => stream.highlightCrop(n, { scroll: true })));

    // ---- scrubber, chart, inspector

    const scrubber = createScrubber(scrubSlot, {
      onSeek: (seq) => seek(seq),
      onRetry: () => loadInspectNow({ force: true }),
    });

    const chart = lineChart(chartBox, {
      series: [],
      x: { label: "Time into the panorama", format: (value) => fmtClock(value) },
      y: { label: "Probability", format: (value) => fmtPct(value), min: 0, max: 1 },
      step: true,
      empty: "No hypotheses yet. The chart starts with the agent's first candidates.",
      onPick: (x, detail) => {
        const raw = detail && Number.isFinite(detail.raw) ? detail.raw : x;
        const seq = chartPlan.seqOf(raw);
        if (seq !== null) seek(resolveCursor(model, seq));
      },
    });

    const inspector = createInspector(inspectorBox, {
      runId,
      pid,
      tab: urlTab,
      onTab: (name) => {
        if (!alive) return;
        urlTab = name === "turns" ? "" : name;
        setQuery({ tab: urlTab });
      },
      onSeek: (seq) => seek(resolveCursor(model, seq)),
      onCropHover: (n) => hoverCrop("inspector", n),
      onOpenEvent: (seq) => openEvent(seq),
      onRefresh: () => {
        loadInspectNow({ force: true });
        loadTruthNow({ force: true });
      },
    });

    // ---- the operator controls: only at the live tail

    let controls = null; // {mcq, bar}

    function ensureControls(wanted) {
      if (wanted && !controls) {
        controls = {
          mcq: mcqPanel(mcqSlot, {
            runId,
            pid,
            onHighlightHypothesis: (index) => {
              hyps.highlight(index);
              map.highlightHypothesis(index);
            },
          }),
          bar: controlBar(controlSlot, { runId, pid }),
        };
      } else if (!wanted && controls) {
        controls.mcq.destroy();
        controls.bar.destroy();
        controls = null;
      }
    }

    // ---- drawing

    function drawNav(run) {
      const key = neighbours(run, pid).ids.join("\n");
      if (key === drawn.nav) return;
      drawn.nav = key;
      replace(navSlot, navRow(run));
    }

    function drawViewer(shown) {
      const sources = panoSources(runId, pid, lastTile || shown);
      const sourceKey = sourcesKey(sources);
      if (sourceKey !== drawn.sources) {
        drawn.sources = sourceKey;
        viewer.setSources(sources);
      }
      const crops = viewerCrops(shown);
      const cropKey = JSON.stringify(crops);
      if (cropKey !== drawn.crops) {
        drawn.crops = cropKey;
        viewer.setCrops(crops);
      }
    }

    function drawMap(shown, run) {
      let moved = false;
      const hypotheses = Array.isArray(shown.hypotheses) ? shown.hypotheses : [];
      const hypKey = JSON.stringify(hypotheses);
      if (hypKey !== drawn.hypotheses) {
        drawn.hypotheses = hypKey;
        map.setHypotheses(hypotheses, { onHover: (index) => hyps.highlight(index) });
        moved = true;
      }
      const clusters = Array.isArray(shown.cluster_points) ? shown.cluster_points : [];
      const clusterKey = JSON.stringify(clusters);
      if (clusterKey !== drawn.clusters) {
        drawn.clusters = clusterKey;
        map.setClusters(clusters);
        moved = true;
      }
      const final = isFinal(shown);
      const listed = final ? shown.final : shown.provisional;
      const entries = Array.isArray(listed) ? listed.filter(Boolean) : [];
      const chosen = chosenPoint(shown);
      const answerKey = JSON.stringify([final, chosen, entries.map((entry) => [entry.rank, entry.lat, entry.lng])]);
      const answerChanged = answerKey !== drawn.answer;
      if (answerChanged) {
        drawn.answer = answerKey;
        map.setEntries(entries);
        map.setAnswer(chosen, { final });
        moved = true;
      }
      const path = pathUpTo(inspect, at);
      const pathKey = JSON.stringify(path);
      if (pathKey !== drawn.path) {
        drawn.path = pathKey;
        map.setPath(path.length > 1 ? path : []);
      }
      // The truth is the same at every moment of the run; the lines go to the list shown now.
      const point = truthPoint(truth, run, lastTile, pid);
      const truthSig = JSON.stringify(point);
      if (truthSig !== drawn.truth || (point && answerChanged)) {
        drawn.truth = truthSig;
        map.setTruth(point, { lines: point ? entries : [] });
        truthNote.hidden = !point;
        moved = true;
      }
      // fit() stands down by itself once the operator has moved the map.
      if (moved) map.fit();
    }

    // What the cursor shows: the live tile, or the tile of that moment. Null while a replay has
    // nothing to draw from yet (the page was opened on `?at=` and neither request is back).
    function shownTile() {
      if (at === null) return lastTile;
      if (exact && exact.seq === at) return exact.tile;
      if (!inspect) return null;
      return frameTile(lastTile, inspect, at);
    }

    function drawState() {
      const shown = shownTile();
      if (!shown) return;
      const replay = at !== null;
      root.dataset.status = tileStatus(shown, { replay });
      stateParts.head.update(shown);
      stateParts.time.update(shown);
      // A frame built from the timeline knows the hypotheses but not what the allocator made of
      // them: the line that reports clusters and the question gate waits for the exact tile.
      confSlot.classList.toggle("is-pending", Boolean(shown.approximate));
      if (!shown.approximate) conf.update(shown);
      hyps.update(shown);
      stateParts.answer.update(shown);
      drawViewer(shown);
      drawMap(shown, lastRun);
    }

    function drawNotices() {
      // These describe the panorama as it is now; a replay shows a moment when they were not true.
      const tileNow = lastTile;
      const live = at === null && Boolean(tileNow);
      const status = tileNow ? tileStatus(tileNow) : "pending";
      const stopped = live && status === "interrupted";
      interrupted.node.hidden = !stopped;
      if (stopped) {
        const hasList = Array.isArray(tileNow.provisional) && tileNow.provisional.length > 0;
        setText(interrupted.text,
          "Interrupted: the server stopped while this panorama was running, so no control can reach it now. " +
          "Open Submission and use Rebuild exports to recover " +
          (hasList ? "its last provisional list." : "it; with no hypothesis on record the fallback point for its label is written."));
      }
      const failing = live && Boolean(tileNow.api_trouble) && !stopped;
      apiTrouble.node.hidden = !failing;
      if (failing) {
        setText(apiTrouble.text, "The model API is failing" + (tileNow.api_trouble_text ? ": " + tileNow.api_trouble_text : ".") +
          " The harness retries by itself; if it keeps failing, use Finalize now to keep the best-so-far list.");
      }
      const invalid = live && Boolean(tileNow.export_problems);
      exportTrouble.node.hidden = !invalid;
      if (invalid) {
        setText(exportTrouble.text, "The export of this panorama is not valid: " +
          String(tileNow.export_problems).replace(/[.\s]+$/, "") + ". Open Submission to rebuild it before the freeze.");
      }
    }

    // The same items as the inbox, for this panorama. Each links to the control that resolves it
    // (`?open=`), which also takes the page out of a replay.
    function drawFlags() {
      if (!alive) return;
      const flags = attentionFor(attentionItems(store.state, Date.now()), runId, pid).map(flagModel);
      syncList(flagBox, flags, (flag) => flag.id,
        (flag) => {
          const text = el("span", "tile-flag-text");
          return link(flag.href, { class: "tile-flag" }, icon(flag.icon), text);
        },
        (node, flag) => {
          setText(node.lastChild, flag.text);
          if (node.dataset.tone !== flag.tone) node.dataset.tone = flag.tone;
          if (node.getAttribute("href") !== flag.href && String(flag.href || "").startsWith("/")) node.setAttribute("href", flag.href);
        });
      flagRow.hidden = flags.length === 0;
      flagLabel.hidden = at === null;
    }

    function drawBanner() {
      const status = lastTile ? tileStatus(lastTile) : "pending";
      scrubber.setBanner(bannerModel(model, at, {
        running: status === "running" || status === "awaiting_mcq",
        pending: status === "pending",
      }));
      root.classList.toggle("is-replay", at !== null);
      const failed = at !== null && exactError && exactError.seq === at;
      replayNote.hidden = !failed;
      if (failed) {
        replace(replayNote, icon("alert"), el("div", "tile-notice-body",
          el("span", "tile-notice-text pre",
            "The exact state at this moment could not be loaded. " + errorText(exactError.err) +
            "\nThe page shows what the timeline holds: hypotheses, lists, status and multiplier are right; clusters, the question gate and the proxy are left out."),
          el("span", "tile-notice-actions",
            el("button", { type: "button", class: "small", onclick: () => loadExact(at) }, icon("refresh"), "Try again"))));
      }
    }

    function drawChart() {
      if (drawn.chart !== chartPlan) {
        drawn.chart = chartPlan;
        const timed = chartPlan.axis === "time";
        chart.update({
          series: chartPlan.series,
          marks: chartPlan.marks,
          x: timed
            ? { label: "Time into the panorama", format: (value) => fmtClock(value), min: 0, max: chartPlan.end ?? undefined }
            : { label: "Event number (the clock restarted in this log)", format: (value) => "#" + Math.round(value) },
          cursor: at === null ? null : chartPlan.xOf(at),
        });
        setText(chartNote,
          "The probability the agent gave each hypothesis after every update. Click the chart to replay that moment." +
          (chartPlan.folded ? " Every hypothesis that was once the top one has its own line; the other " + chartPlan.folded + " are summed into one." : ""));
      } else chart.update({ cursor: at === null ? null : chartPlan.xOf(at) });
    }

    // ---- the cursor moved, or the mode changed

    function applyCursor() {
      const replay = at !== null;
      const was = drawn.mode;
      drawn.mode = replay;
      ensureStateParts(replay);
      ensureControls(!replay);
      if (controls && lastTile) {
        controls.mcq.update(lastTile, lastRun);
        controls.bar.update(lastTile, lastRun);
      }
      scrubber.setCursor(at);
      stream.setCursor(at);
      if (replay) stream.scrollToSeq(at);
      else if (was === true) {
        stream.scrollToSeq(null);
        stream.jumpToLatest();
      }
      inspector.setCursor(at);
      drawChart();
      drawBanner();
      drawNotices();
      drawFlags();
      drawState();
    }

    function update(nextTile, nextRun) {
      const changed = nextTile !== lastTile || nextRun !== lastRun;
      lastTile = nextTile;
      lastRun = nextRun;
      if (changed) {
        root.classList.toggle("is-special", Boolean(nextTile.special));
        drawNav(nextRun);
        drawBanner();
        drawNotices();
        drawFlags();
        // A replay shows a past moment: a new event does not change it.
        if (at === null || !stateParts) {
          ensureStateParts(at !== null);
          drawState();
        } else if (!exact || exact.seq !== at) drawState();
        inspector.update(nextTile, nextRun);
      }
      // The controls also follow the connection and the run, which change without a new tile.
      if (controls) {
        controls.mcq.update(nextTile, nextRun);
        controls.bar.update(nextTile, nextRun);
      }
    }

    function showErrors() {
      setQuery({ filter: "errors" });
      stream.setFilter(["errors"]);
      streamBox.scrollIntoView({ block: "center" });
    }

    function openEvent(seq) {
      urlEvent = seq === null || seq === undefined ? null : Number(seq);
      setQuery({ event: urlEvent });
      stream.openEvent(urlEvent);
    }

    const flagTimer = setInterval(drawFlags, FLAG_TICK_MS);

    view = {
      root,
      scrubber,
      stream,
      inspector,
      get controls() { return controls; },
      update,
      applyCursor,
      drawState,
      drawBanner,
      drawChart,
      destroy() {
        clearInterval(flagTimer);
        for (const off of offs.splice(0)) if (typeof off === "function") off();
        ensureControls(false);
        inspector.destroy();
        chart.destroy();
        scrubber.destroy();
        stream.destroy();
        viewer.destroy();
        map.destroy();
        if (stateParts) for (const piece of [stateParts.head, stateParts.time, stateParts.answer]) piece.destroy();
        conf.destroy();
        hyps.destroy();
        root.remove();
      },
    };

    // What has been fetched before the view existed.
    if (inspect) {
      scrubber.setModel(model);
      inspector.setData(inspect, { truth });
    } else if (inspectError) showInspectError(scrubber, inspector);
    lastTile = tile;
    lastRun = run;
    applyCursor();
    lastTile = null; // so that the first update() draws everything that follows the tile
    update(tile, run);
    if (urlEvent !== null) stream.openEvent(urlEvent);
  }

  function destroyView() {
    if (!view) return;
    const leaving = view;
    view = null;
    lastTile = null;
    lastRun = null;
    leaving.destroy();
  }

  // ================================================================ the cursor

  // `?at=` follows the cursor once it rests. Until then the cursor on the page is the newer one.
  const writeAt = debounce(() => {
    if (!alive) return;
    atDirty = false;
    setQuery({ at });
  }, URL_WRITE_MS);

  const askExact = debounce((seq) => loadExact(seq), EXACT_MS);

  function wantExact() {
    askExact.cancel();
    if (exactAbort) {
      exactAbort.abort();
      exactAbort = null;
    }
    if (at === null) {
      exact = null;
      exactError = null;
      return;
    }
    const kept = exactKept.get(at);
    if (kept) {
      exact = { seq: at, tile: kept };
      exactError = null;
      return;
    }
    askExact(at);
  }

  async function loadExact(seq) {
    if (!alive || seq === null || seq !== at) return;
    if (exactAbort) exactAbort.abort();
    const controller = new AbortController();
    exactAbort = controller;
    try {
      const tile = await api.get(panoUrl(runId, pid, "/replay?at=" + encodeURIComponent(seq)), { signal: controller.signal });
      if (!alive || exactAbort !== controller) return;
      exactAbort = null;
      exactKept.set(seq, tile);
      if (exactKept.size > EXACT_KEPT) exactKept.delete(exactKept.keys().next().value);
      if (seq !== at) return;
      exact = { seq, tile };
      exactError = null;
    } catch (err) {
      if (!alive || exactAbort !== controller || (err && err.name === "AbortError")) return;
      exactAbort = null;
      if (seq !== at) return;
      exactError = { seq, err };
    }
    if (view) {
      view.drawBanner();
      view.drawState();
    }
  }

  function moveTo(next) {
    if (next === at) return false;
    at = next;
    wantExact();
    if (view) view.applyCursor();
    return true;
  }

  /** Move the cursor: a seq, or null for live. The URL follows. */
  function seek(seq) {
    const next = seq === null || seq === undefined || !Number.isFinite(Number(seq)) ? null : Number(seq);
    if (!moveTo(next)) return;
    atDirty = true;
    writeAt();
  }

  // ================================================================ `?open=`

  function tryOpen() {
    if (!wantedOpen || !view || at !== null || !lastTile || !view.controls) return;
    const name = wantedOpen;
    wantedOpen = null;
    // Opened once: the key goes, so the same link or the `m` key works again later.
    setQuery({ open: null, at: null });
    const opened = name === "mcq" ? view.controls.mcq.focus() : view.controls.bar.open(name);
    if (opened) return;
    toast(name === "mcq"
      ? "No question is waiting on " + pid + " now."
      : "That control is not available on " + pid + " now. The control bar says why.", "info");
  }

  function openControl(name) {
    wantedOpen = name;
    writeAt.cancel();
    atDirty = false;
    moveTo(null);
    tryOpen();
  }

  // ================================================================ inspect and truth

  function onInspect() {
    model = timelineModel(inspect);
    chartPlan = beliefSeries(inspect, model);
    if (!view) return;
    view.scrubber.setModel(model);
    view.scrubber.setCursor(at);
    view.inspector.setData(inspect, { truth });
    view.inspector.setCursor(at);
    view.drawChart();
    view.drawBanner();
    view.drawState();
  }

  // With a payload on the page the failure is a line in the inspector's status; without one both
  // the timeline and the inspector say so and offer to try again.
  function showInspectError(scrubber, inspector) {
    scrubber.setError(inspectError);
    inspector.setError(inspectError, { onRetry: () => loadInspectNow({ force: true }) });
  }

  function loadInspectNow({ force = false } = {}) {
    if (!alive || inspectLoading) return;
    inspectLoading = true;
    lastStartMs = Date.now();
    // Only a forced request is known to be newer than the tile it was started for: without
    // `force` the answer may be the one kept from an earlier visit.
    if (force) askedSeq = lastTile ? Number(lastTile.last_seq) || 0 : askedSeq;
    if (!inspect && view) {
      view.scrubber.setLoading();
      view.inspector.setLoading();
    }
    loadInspect(runId, pid, { force, signal: abort.signal }).then(
      (payload) => {
        if (!alive) return;
        inspectLoading = false;
        inspectError = null;
        inspect = payload;
        onInspect();
        planRefresh();
      },
      (err) => {
        if (!alive || (err && err.name === "AbortError")) return;
        inspectLoading = false;
        inspectError = err;
        if (view) showInspectError(view.scrubber, view.inspector);
        planRefresh();
      },
    );
  }

  // While the panorama runs its payload falls behind the tile; catch up without hammering.
  function planRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    if (!alive || !lastTile) return;
    const plan = refreshPlan({
      loadedSeq: inspect ? inspect.last_seq : null,
      askedSeq,
      tileSeq: lastTile.last_seq,
      final: isFinal(lastTile),
      loading: inspectLoading,
      hidden: document.hidden,
      lastStartMs,
      nowMs: Date.now(),
    });
    if (plan.load) loadInspectNow({ force: true });
    else if (plan.waitMs) refreshTimer = setTimeout(planRefresh, plan.waitMs);
  }

  function loadTruthNow({ force = false } = {}) {
    const run = currentRun();
    // Not even asked for unless the run is an evaluation run with human channels off.
    if (!alive || !run || run.kind !== "eval" || run.no_human !== true) return;
    truthAsked = true;
    loadTruth(runId, { force, signal: abort.signal }).then(
      (payload) => {
        if (!alive) return;
        truth = payload;
        if (!view) return;
        if (inspect) view.inspector.setData(inspect, { truth });
        view.inspector.setCursor(at);
        view.drawState();
      },
      (err) => {
        if (!alive || (err && err.name === "AbortError")) return;
        if (view && inspect) view.inspector.setError(err);
        else toast("The ground truth of this evaluation run could not be loaded. " + errorText(err), "warn");
      },
    );
  }

  // A panorama is scored when it is exported and the run when it ends: ask again at those moments.
  function followTruth(tile, run) {
    const key = JSON.stringify([isFinal(tile), run.state, run.results ? run.results.score_share ?? null : null]);
    if (!truthAsked) {
      truthKey = key;
      loadTruthNow();
    } else if (key !== truthKey) {
      truthKey = key;
      loadTruthNow({ force: true });
    }
  }

  // ================================================================ sync

  function sync() {
    if (!alive) return;
    const run = currentRun();
    if (!run) {
      if (runLoading) showLoading();
      else showRunError();
      return;
    }
    const tile = tileOf(run);
    if (!tile) {
      // An owned run can still be given the panorama (late additions): only say "no such
      // panorama" once the run has been read.
      if (runLoading && !hasTiles(run)) showLoading();
      else showMissing(run);
      return;
    }
    if (!view) buildView(tile, run);
    else view.update(tile, run);
    followTruth(tile, run);
    tryOpen();
    planRefresh();
  }

  // ================================================================ URL in

  function applyQuery(query) {
    if (!alive) return;
    const open = parseOpen(query.get("open"));
    if (open) {
      wantedOpen = open;
      writeAt.cancel();
      atDirty = false;
      moveTo(null);
    } else if (!atDirty) moveTo(parseAt(query.get("at")));
    const event = parseAt(query.get("event"));
    if (event !== urlEvent) {
      urlEvent = event;
      if (view) view.stream.openEvent(event);
    }
    const tab = query.get("tab") || "";
    if (tab !== urlTab) {
      urlTab = tab;
      if (view) view.inspector.setTab(tab || "turns");
    }
    if (view) {
      view.stream.setFilter(query.get("filter"));
      view.stream.setSearch(query.get("q") || "");
    }
    tryOpen();
  }

  // ================================================================ keys

  const focusSearch = () => {
    if (!view) return;
    view.stream.el.scrollIntoView({ block: "center" });
    view.stream.focusSearch();
  };
  const stepBy = (kind, direction) => { if (view) view.scrubber.step(kind, direction); };

  cleanups.push(shortcuts.register("Panorama", {
    "/": { label: "Search the reasoning stream", run: focusSearch },
    "[": { label: "Replay: start of the previous turn", run: () => stepBy("turn", -1) },
    "]": { label: "Replay: start of the next turn", run: () => stepBy("turn", 1) },
    ",": { label: "Replay: previous mark (hypotheses, human, deadline, final, error)", run: () => stepBy("mark", -1) },
    ".": { label: "Replay: next mark", run: () => stepBy("mark", 1) },
    "← or →": { label: "Replay: one event back or on (while the timeline has the focus)" },
    c: { label: "Open the cue box of this panorama (nothing is sent)", run: () => openControl("cue") },
    "1-9": { label: "Open that panorama of this run" },
  }));

  // The digits are one entry in the list above and nine keys here.
  function onDigit(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
    if (!/^[1-9]$/.test(event.key) || document.querySelector("dialog[open]")) return;
    const ids = neighbours(currentRun(), pid).ids;
    const target = ids[Number(event.key) - 1];
    if (target === undefined) return;
    event.preventDefault();
    if (target !== pid) navigate(paths.pano(runId, target));
  }
  document.addEventListener("keydown", onDigit);
  cleanups.push(() => document.removeEventListener("keydown", onDigit));

  // ================================================================ start

  cleanups.push(store.subscribe(() => sync()));

  // A run read from disk changes when its exports are rebuilt: read it again, but not per message.
  const rereadRun = debounce(() => {
    const held = store.run(runId);
    if (alive && !(held && held.owned)) loadRun({ force: true });
  }, INDEX_REFRESH_MS);
  cleanups.push(store.on("index", rereadRun));
  cleanups.push(() => rereadRun.cancel());

  const onVisible = () => { if (!document.hidden) planRefresh(); };
  document.addEventListener("visibilitychange", onVisible);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));

  loadRun();
  loadInspectNow();
  if (at !== null) wantExact();

  return {
    onQuery: applyQuery,
    unmount() {
      if (!alive) return;
      alive = false;
      writeAt.cancel();
      askExact.cancel();
      clearTimeout(refreshTimer);
      refreshTimer = null;
      abort.abort();
      if (exactAbort) exactAbort.abort();
      exactAbort = null;
      for (const off of cleanups.splice(0)) {
        try {
          off();
        } catch (err) {
          console.error("focus cleanup failed", err);
        }
      }
      destroyView();
      exactKept.clear();
    },
  };
}
