// Evaluation, Results tab (UI-SPEC 5.9 "Results" and "Rescore"): the scores of one evaluation
// run or of one of its rescore variants, per group and per panorama, the truth against the
// answer on a map, and the offline rescore that replaces `eval rescore`.
//
// This tab shows ground truth. The server serves it only for an evaluation run whose human
// channels were off (contract A19), and the page checks the run again before it draws anything.
// Nothing here reaches a run or the agent: a rescore re-allocates logged hypotheses on disk.

import { ApiError, api, errorText, newKey, runUrl } from "../../api.js";
import { histogram, scatterChart } from "../../components/charts.js";
import { createMap } from "../../components/map.js";
import { confirmDialog, toast } from "../../components/shell.js";
import { badge, clear, copyButton, debounce, el, icon, replace, statusBadge } from "../../dom.js";
import { fmtClock, fmtDist, fmtDuration, fmtInt, fmtLatLng, fmtMult, fmtPct, fmtUsd, plural } from "../../format.js";
import {
  ALLOCATIONS,
  DEMO_NOTE,
  GROUPS,
  bandCounts,
  bandInfo,
  canReuseKey,
  configLines,
  costScorePoints,
  distanceGroups,
  evalRuns,
  fmtDelta,
  fmtMetric,
  fmtScore,
  fmtTheta,
  focusView,
  formatRef,
  groupSummary,
  isDemo,
  labelBadge,
  latestWithResults,
  mapLines,
  mapMarkers,
  mergeRows,
  metricInfo,
  nextSort,
  originBadge,
  readRescoreForm,
  sortRows,
  truthVisible,
  variantRows,
  variantText,
} from "../../logic/evalstats.js";
import { link, paths, setQuery } from "../../router.js";
import { store } from "../../store.js";

const RUNS_URL = "/api/runs";
const enc = encodeURIComponent;
const tagQuery = (tag) => (tag ? "?tag=" + enc(tag) : "");
const resultsUrl = (runId, tag) => runUrl(runId, "/results" + tagQuery(tag));
const truthUrl = (runId, tag) => "/api/eval/runs/" + enc(runId) + "/truth" + tagQuery(tag);
const rescoreUrl = (runId) => runUrl(runId, "/rescore");

const SUMMARY_COLUMNS = [
  "n", "mean_score", "score_share_of_max", "median_rank1_distance_m", "mean_rank1_distance_m",
  "within_100m", "within_1km", "within_10km", "mean_cost_usd", "total_cost_usd", "mean_time_s",
];

const COLUMNS = [
  { key: "panorama_id", label: "Panorama" },
  { key: "label", label: "Label" },
  { key: "rank1_distance_m", label: "Rank-1", right: true, title: "Distance of the first entry to the truth, and its band" },
  { key: "best_distance_m", label: "Best", right: true, title: "Distance of the closest of the ten entries" },
  { key: "theta", label: "Theta", right: true, title: "Theta of the first entry: 0 is nothing, 2 is on the spot" },
  { key: "score", label: "Score", right: true },
  { key: "share", label: "Share", right: true, title: "Score as a share of the maximum for this panorama" },
  { key: "multiplier", label: "Mult.", right: true, title: "Penalty multiplier of the answer" },
  { key: "origin", label: "Origin", title: "Where the final answer came from" },
  { key: "plan", label: "Plan", title: "How the allocator spread the ten entries" },
  { key: "n_hypotheses", label: "Hyp.", right: true, title: "Hypotheses behind the answer" },
  { key: "cost_usd", label: "Cost", right: true },
  { key: "time_s", label: "Time", right: true, title: "Wall time, minutes and seconds" },
  { key: "turns", label: "Turns", right: true },
  { key: "stop", label: "Stop reason" },
];

function specBadge(spec) {
  return badge(spec.text, spec.kind, spec.icon || undefined);
}

function demoBadge() {
  const node = badge("DEMO", "warn", "alert");
  node.title = DEMO_NOTE;
  return node;
}

function specialBadge() {
  const node = badge("x3", "special", "star");
  node.title = "The Special One: its score counts three times";
  return node;
}

function errorNotice(title, err, ...actions) {
  return el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
    el("div", "stack tight grow", el("strong", null, title), el("span", "pre", errorText(err))),
    actions);
}

export function mountTab(container, ctx) {
  let unmounted = false;
  const offs = [];

  let runId = ctx.query.get("run") || "";
  let tag = ctx.query.get("tag") || "";
  let selected = ctx.query.get("pano") || null;

  let index = null; // evaluation RunRows, for the run picker
  let indexError = null;
  let indexAbort = null;

  let data = null; // {runId, tag, payload, truth, truthError, rows}
  let runInfo = null; // RunState of `runId`, when it could be read
  let error = null; // the results request failed
  let loading = false;
  let loadAbort = null;

  let sort = { key: null, dir: "asc" };
  let focusedFor = ""; // the run, variant and panorama the map was last moved for
  let map = null;
  let distanceChart = null;
  let costChart = null;
  const rowNodes = new Map(); // panorama id -> <tr>

  const rescoreForm = { allocation: "hedge", distinct: false, tag: "" };
  let rescoring = false;
  let rescoreError = null;
  let lastAttempt = null; // {bodyJson, key, status}: see canReuseKey
  let dialog = null; // the confirm dialog this tab opened, to close it on unmount
  let scoringNow = false;

  // ------------------------------------------------------------ skeleton

  const runSelect = el("select", {
    id: "eval-res-run", class: "mono eval-res-pick",
    onchange: () => setQuery({ run: runSelect.value || null, tag: null, pano: null }, { replace: false }),
  });
  const tagSelect = el("select", {
    id: "eval-res-tag", class: "eval-res-pick",
    onchange: () => setQuery({ tag: tagSelect.value || null }, { replace: false }),
  });
  const headBadges = el("div", "row tight wrap");
  const headActions = el("div", "row tight wrap");
  const statusHost = el("div", "stack eval-res-status");

  const demoHost = el("div", "eval-res-demo");
  const kpiHost = el("div", "eval-kpis");
  const summaryHost = el("div", "eval-res-summary");
  const mapHost = el("div", "eval-res-map");
  const legendHost = el("div", "row wrap eval-res-legend");
  const mapNote = el("div", "eval-res-mapnote");
  const selectedHost = el("div", "eval-res-selected");
  const distanceHost = el("div", "eval-chart");
  const costHost = el("div", "eval-chart");
  const tableHost = el("div", "stack eval-res-table-host");
  const variantsHost = el("div", "stack");
  const rescore = buildRescore();
  const configHost = el("div", "stack");

  const body = el("div", { class: "stack loose eval-res-body", hidden: true },
    demoHost,
    kpiHost,
    el("section", { class: "card stack", "aria-labelledby": "eval-res-summary-title" },
      el("h3", { class: "card-title", id: "eval-res-summary-title" }, "By label"),
      summaryHost),
    el("div", "eval-res-overview",
      el("section", { class: "card flush eval-res-map-card", "aria-label": "Map of truth against answer" },
        el("div", "card-head", el("h3", "card-title", "Truth against answer"), el("span", "grow"),
          el("span", "dim small", "A star is the truth, a tick the first entry. Click one to select its panorama.")),
        mapHost,
        el("div", "card-foot", legendHost, mapNote, selectedHost)),
      el("div", "stack eval-res-charts",
        el("section", { class: "card stack tight", "aria-label": "Distribution of rank-1 distance by label" },
          el("h3", "card-title", "Rank-1 distance"),
          el("p", "dim small", "How far the first entry was from the truth, on a log axis. An answer on the spot is drawn at 1 m."),
          distanceHost),
        el("section", { class: "card stack tight", "aria-label": "Score against cost" },
          el("h3", "card-title", "Score against cost"),
          el("p", "dim small", "One point per panorama. Click a point to select its panorama."),
          costHost))),
    tableHost,
    el("div", "eval-res-lower",
      el("section", { class: "card stack", "aria-labelledby": "eval-res-variants-title" },
        el("h3", { class: "card-title", id: "eval-res-variants-title" }, "Variants"),
        variantsHost),
      rescore.node),
    el("section", { class: "card stack", "aria-labelledby": "eval-res-config-title" },
      el("h3", { class: "card-title", id: "eval-res-config-title" }, "Configuration"),
      configHost));

  container.append(
    el("div", "stack loose",
      el("div", "stack",
        el("div", "row wrap eval-tab-head eval-res-head",
          el("h2", "eval-tab-title", "Results"),
          el("label", { class: "row tight", for: "eval-res-run" }, el("span", "dim small", "Run")), runSelect,
          el("label", { class: "row tight", for: "eval-res-tag" }, el("span", "dim small", "Variant")), tagSelect,
          headBadges, el("span", "grow"), headActions),
        statusHost),
      body));

  // ------------------------------------------------------------ the runs index (picker)

  async function loadIndex() {
    if (indexAbort) indexAbort.abort();
    const abort = new AbortController();
    indexAbort = abort;
    try {
      const answer = await api.get(RUNS_URL, { signal: abort.signal });
      if (unmounted || indexAbort !== abort) return;
      index = evalRuns(answer && answer.runs);
      indexError = null;
    } catch (err) {
      if (unmounted || indexAbort !== abort || (err && err.name === "AbortError")) return;
      indexError = err;
    }
    if (indexAbort !== abort) return;
    indexAbort = null;
    if (!runId && index && index.length) {
      // Nothing asked for: the newest run that has results, else the newest evaluation run.
      const pick = latestWithResults(index) || index[0];
      setQuery({ run: pick.run_id }, { replace: true });
      return; // the query change lands in onQuery, which loads and renders
    }
    render();
  }

  function indexRow() {
    return index ? index.find((row) => row.run_id === runId) || null : null;
  }

  // ------------------------------------------------------------ loading one run's results

  async function load({ quiet = false } = {}) {
    if (loadAbort) loadAbort.abort();
    loadAbort = null;
    if (!runId) {
      data = null;
      runInfo = null;
      error = null;
      loading = false;
      render();
      return;
    }
    const abort = new AbortController();
    loadAbort = abort;
    const want = { runId, tag };
    loading = true;
    if (!quiet) {
      if (data && (data.runId !== want.runId || data.tag !== want.tag)) data = null;
      error = null;
      render();
    }
    const [results, truth, run, original] = await Promise.allSettled([
      api.get(resultsUrl(want.runId, want.tag), { signal: abort.signal }),
      api.get(truthUrl(want.runId, want.tag), { signal: abort.signal }),
      store.loadRun(want.runId),
      // A variant's answer does not carry the original's numbers, which the variants list
      // measures every variant against.
      want.tag ? api.get(resultsUrl(want.runId, ""), { signal: abort.signal }) : Promise.resolve(null),
    ]);
    if (unmounted || loadAbort !== abort) return;
    loadAbort = null;
    loading = false;
    runInfo = run.status === "fulfilled" ? run.value : null;
    if (results.status === "rejected") {
      error = results.reason;
      // A quiet re-read that failed keeps what is on screen and says so.
      if (!(quiet && data && data.runId === want.runId && data.tag === want.tag)) data = null;
    } else if (runInfo && !truthVisible(runInfo)) {
      // The server gates this already; the page does not draw truth for such a run either way.
      error = new Error("Scores, distances and ground truth are shown only for an evaluation run whose human channels were off.");
      data = null;
    } else {
      error = null;
      const truthDoc = truth.status === "fulfilled" ? truth.value : null;
      data = {
        runId: want.runId,
        tag: want.tag,
        payload: results.value,
        truth: truthDoc,
        truthError: truth.status === "rejected" ? truth.reason : null,
        original: original.status === "fulfilled" && original.value ? original.value.results : null,
        rows: mergeRows(results.value && results.value.results, truthDoc, runInfo && runInfo.panoramas),
      };
    }
    render();
    // A link with `?pano=` lands on that panorama. A quiet re-read leaves the map where it is.
    const key = want.runId + "|" + want.tag + "|" + (selected || "");
    if (data && selected && selectedRow() && focusedFor !== key) focusMap();
    focusedFor = key;
  }

  // ------------------------------------------------------------ rendering: head and status

  function render() {
    if (unmounted) return;
    renderHead();
    renderStatus();
    const shown = Boolean(data) && data.runId === runId && data.tag === tag;
    body.hidden = !shown;
    if (shown) renderBody();
  }

  function renderHead() {
    const rows = index || [];
    const options = rows.map((row) => ({
      value: row.run_id,
      text: row.run_id + (row.fake_model ? " (demo)" : "") + (row.results ? "" : row.active ? " (running)" : " (not scored)"),
    }));
    if (runId && !options.some((option) => option.value === runId)) options.unshift({ value: runId, text: runId });
    if (!runId) options.unshift({ value: "", text: options.length ? "Choose a run" : "No evaluation run" });
    replace(runSelect, options.map((option) => el("option", { value: option.value }, option.text)));
    runSelect.value = runId;
    runSelect.disabled = options.length < 2 && Boolean(runId);

    const variants = data && data.runId === runId && Array.isArray(data.payload.variants)
      ? data.payload.variants.map((variant) => String(variant.tag))
      : (indexRow() && indexRow().results && Array.isArray(indexRow().results.variants) ? indexRow().results.variants.map(String) : []);
    const tags = variants.slice();
    if (tag && !tags.includes(tag)) tags.push(tag);
    replace(tagSelect,
      el("option", { value: "" }, "Original (as the run answered)"),
      tags.map((name) => el("option", { value: name }, name)));
    tagSelect.value = tag;
    tagSelect.disabled = !runId || !tags.length;

    const row = runInfo && runInfo.run_id === runId ? runInfo : indexRow();
    const demo = isDemo(row, data && data.runId === runId ? data.payload.config : null);
    replace(headBadges,
      row && row.state ? statusBadge(row.state) : null,
      demo ? demoBadge() : null);

    const refresh = el("button", {
      type: "button", class: "ghost small", title: "Read the results from disk again", disabled: loading || !runId,
      onclick: () => { load(); loadIndex(); },
    }, icon("refresh"), "Refresh");
    replace(headActions,
      runId && data
        ? el("button", {
          type: "button", class: "small", title: "Compare this result file with another one",
          onclick: () => ctx.setTab("compare", { a: formatRef(runId, tag), b: null, pano: null }),
        }, "Compare with…")
        : null,
      runId ? link(paths.run(runId), { class: "btn small" }, icon("eye"), "Dashboard") : null,
      refresh);
  }

  function liveProgress() {
    const run = store.run(runId) || runInfo || indexRow();
    const totals = run && run.totals;
    if (!totals || typeof totals.done !== "number" || typeof totals.total !== "number") return "";
    return totals.done + " of " + plural(totals.total, "panorama") + (totals.done === 1 ? " is done." : " are done.");
  }

  function runIsActive() {
    const run = store.run(runId) || runInfo || indexRow();
    return Boolean(run && (run.active || run.state === "queued" || run.state === "running"));
  }

  function renderStatus() {
    const items = [];
    if (!runId) {
      if (indexError) {
        items.push(errorNotice("The runs could not be read, so there is nothing to choose from.", indexError,
          el("button", { type: "button", class: "small", onclick: () => loadIndex() }, icon("refresh"), "Try again")));
      } else if (!index) {
        items.push(el("p", "dim row", el("span", "spinner"), "Looking for evaluation runs…"));
      } else {
        items.push(el("div", "empty panel",
          icon("list", { size: 28 }),
          el("div", "empty-title", "No evaluation run yet"),
          el("p", null, "Results appear here when an evaluation run has ended. Launch one on the Run tab."),
          el("div", "row", el("button", { type: "button", class: "primary", onclick: () => ctx.setTab("run") }, "Go to the Run tab"))));
      }
    } else if (loading && !data) {
      items.push(el("p", "dim row", el("span", "spinner"), "Reading the results of " + runId + "…"));
    } else if (error) {
      const again = el("button", { type: "button", class: "small", onclick: () => load() }, icon("refresh"), "Try again");
      if (data) {
        items.push(errorNotice("The results could not be read again. What is shown may be out of date.", error, again));
      } else if (error.code === "no_results" && tag) {
        items.push(el("div", { class: "notice notice-warn", role: "alert" }, icon("alert"),
          el("div", "grow", el("strong", null, "Run " + runId + " has no variant named " + tag + ". "),
            "It may have been deleted, or the link was mistyped."),
          el("button", { type: "button", class: "small primary", onclick: () => setQuery({ tag: null }) }, "Show the original")));
      } else if (error.code === "no_results" && runIsActive()) {
        items.push(el("div", { class: "notice notice-info", role: "status" }, icon("clock"),
          el("div", "grow",
            el("strong", null, "Run " + runId + " is still going. "),
            liveProgress(), " Results are computed when it ends, and this page shows them then."),
          link(paths.run(runId), { class: "btn small primary" }, icon("eye"), "Open the dashboard")));
      } else if (error.code === "no_results") {
        items.push(el("div", { class: "notice notice-warn", role: "alert" }, icon("alert"),
          el("div", "stack tight grow",
            el("strong", null, "Run " + runId + " has not been scored."),
            el("span", null,
              "That happens when a run was interrupted and its exports were rebuilt afterwards. Scoring it now reads the exports on disk ",
              "and compares them with the evaluation set: no model call, no cost, a few seconds.")),
          el("button", { type: "button", class: "small primary", disabled: scoringNow, onclick: () => scoreNow() },
            scoringNow ? el("span", "spinner") : icon("play"), scoringNow ? "Scoring…" : "Score it now")));
      } else if (error.code === "no_exports") {
        items.push(errorNotice("Run " + runId + " has nothing to score.", error,
          link(paths.submit(runId), { class: "btn small" }, "Open its submission page to rebuild the exports"), again));
      } else {
        // A refusal (403) is the answer, not a failure: asking again changes nothing.
        items.push(errorNotice("The results of " + runId + " could not be shown.", error,
          error.status === 403 || !(error instanceof ApiError) ? null : again));
      }
    }
    replace(statusHost, items);
  }

  // A run found without results.json (interrupted, then rebuilt): contract A10 lets the rescore
  // endpoint write it, with the empty tag and no re-allocation.
  async function scoreNow() {
    if (scoringNow || unmounted || !runId) return;
    const target = runId;
    scoringNow = true;
    renderStatus();
    try {
      await api.post(rescoreUrl(target), { hedge: null, duplicates: true, tag: "" }, { key: newKey(), timeoutMs: 120000 });
      if (unmounted) return;
      toast("Run " + target + " is scored.", "ok");
    } catch (err) {
      if (unmounted) return;
      if (target === runId) error = err;
      toast("Run " + target + " could not be scored: " + errorText(err), "error");
    } finally {
      scoringNow = false;
    }
    if (unmounted || target !== runId) return;
    if (error && error.code !== "no_results") renderStatus();
    else load();
  }

  // ------------------------------------------------------------ rendering: the results

  function kpi(value, label, help) {
    return el("div", "eval-kpi",
      el("div", "eval-kpi-value num", value),
      el("div", "eval-kpi-label caps dim", label),
      help ? el("div", "dim small", help) : null);
  }

  function renderBody() {
    const { payload, rows } = data;
    const results = payload.results || {};
    const demo = isDemo(payload.config, results.config, runInfo, indexRow());
    body.classList.toggle("eval-is-demo", demo);

    replace(demoHost, demo
      ? el("div", { class: "notice notice-warn", role: "note" }, icon("alert"),
        el("div", null, el("strong", null, "DEMO run. "), DEMO_NOTE))
      : null);

    const all = groupSummary(results, "all");
    replace(kpiHost,
      kpi(fmtScore(all.total_score), "total score", "mean " + fmtScore(all.mean_score) + " over " + plural(all.n, "panorama")),
      kpi(fmtPct(all.score_share_of_max, 1), "share of maximum", "of what these panoramas could score"),
      kpi(fmtDist(all.median_rank1_distance_m), "median rank-1 distance", "mean " + fmtDist(all.mean_rank1_distance_m)),
      el("div", "eval-kpi",
        el("div", "eval-kpi-triple",
          ["within_100m", "within_1km", "within_10km"].map((key) => el("div", "stack tight",
            el("div", "eval-kpi-value num", fmtPct(all[key])),
            el("div", "dim small", metricInfo(key).label.toLowerCase())))),
        el("div", "eval-kpi-label caps dim", "first entry close enough")),
      kpi(fmtUsd(all.total_cost_usd), "cost", "mean " + fmtUsd(all.mean_cost_usd) + " per panorama"),
      kpi(fmtDuration(all.mean_time_s), "mean time", "median " + fmtDuration(all.median_time_s)));

    replace(summaryHost,
      el("div", "table-wrap",
        el("table", "table compact eval-res-summary-table",
          el("thead", null, el("tr", null,
            el("th", { scope: "col" }, "Group"),
            SUMMARY_COLUMNS.map((key) => el("th", { scope: "col", class: "r", title: metricInfo(key).label }, metricInfo(key).short)))),
          el("tbody", null, GROUPS.map((group) => {
            const summary = groupSummary(results, group);
            return el("tr", null,
              el("th", { scope: "row" }, group === "all" ? "All" : specBadge(labelBadge(group))),
              SUMMARY_COLUMNS.map((key) => el("td", "r num", fmtMetric(metricInfo(key).type, summary[key]))));
          })))));

    renderMap();
    renderCharts();
    renderTable();
    renderVariants();
    renderRescore();
    renderConfig();
  }

  function selectedRow() {
    return data && selected ? data.rows.find((row) => row.panorama_id === selected) || null : null;
  }

  function pick(pid) {
    setQuery({ pano: pid && pid !== selected ? pid : null });
  }

  function renderMap() {
    const rows = data.rows;
    const chosen = selectedRow();
    const chosenId = chosen ? chosen.panorama_id : null;
    if (!map) map = createMap(mapHost, { interactive: true });
    map.setLines(mapLines(rows, chosenId));
    map.setMarkers(mapMarkers(rows, chosenId), { onClick: (marker) => pick(marker.pid) });
    // The selected panorama in full: its truth, every distinct entry, and a line from each.
    if (chosen && chosen.truth) {
      map.setEntries(chosen.entries);
      map.setAnswer(chosen.entries[0] || null, { final: true });
      map.setTruth(chosen.truth, { lines: chosen.entries });
    } else {
      map.setEntries([]);
      map.setAnswer(null);
      map.setTruth(null);
    }

    replace(legendHost, bandCounts(rows).map((band) => el("span", { class: "eval-band", title: "First entry " + band.label + " of the truth" },
      el("span", { class: "eval-band-line eval-band-" + band.key, "aria-hidden": "true" }),
      specBadge({ text: band.label, kind: band.kind, icon: band.icon }),
      el("span", "num strong", String(band.n)))));

    const drawn = rows.filter((row) => row.truth && row.answer).length;
    if (data.truthError) {
      replace(mapNote, errorNotice("The truth and the answers could not be read, so the map is empty.", data.truthError,
        el("button", { type: "button", class: "small", onclick: () => load() }, icon("refresh"), "Try again")));
    } else if (drawn < rows.length) {
      replace(mapNote, el("span", "dim small",
        plural(rows.length - drawn, "panorama") + " of " + rows.length + " cannot be drawn: no answer, or no truth in the evaluation set as it is now."));
    } else clear(mapNote);

    if (chosen) {
      const first = chosen.entries[0] || null;
      replace(selectedHost, el("div", "panel eval-res-chosen",
        el("div", "row wrap",
          el("span", "mono strong", chosen.panorama_id),
          specBadge(labelBadge(chosen.label)),
          chosen.special ? badge("Special One", "special", "star") : null,
          specBadge({ text: bandInfo(chosen.band).label, kind: bandInfo(chosen.band).kind, icon: bandInfo(chosen.band).icon }),
          el("span", "grow"),
          link(paths.pano(runId, chosen.panorama_id, { tab: "truth" }), { class: "btn small primary" }, icon("play"), "Open replay"),
          el("button", { type: "button", class: "small ghost", onclick: () => pick(null) }, icon("x"), "Clear selection")),
        el("dl", "kv eval-res-chosen-facts",
          el("dt", null, "Truth"),
          el("dd", "row tight", el("span", "mono", chosen.truth ? fmtLatLng(chosen.truth.lat, chosen.truth.lng) : "–"),
            chosen.truth ? copyButton(() => fmtLatLng(chosen.truth.lat, chosen.truth.lng), { title: "Copy the truth coordinates" }) : null),
          el("dt", null, "First entry"),
          el("dd", "row tight", el("span", "mono", first ? fmtLatLng(first.lat, first.lng) : "–"),
            first ? copyButton(() => fmtLatLng(first.lat, first.lng), { title: "Copy the answer coordinates" }) : null),
          el("dt", null, "Distance"),
          el("dd", "num", fmtDist(chosen.rank1_distance_m) + " (best of ten: " + fmtDist(chosen.best_distance_m) + ", " +
            plural(chosen.distinct, "distinct point") + ")"),
          el("dt", null, "Score"),
          el("dd", "num", fmtScore(chosen.score) + " of " + fmtScore(chosen.max_score) + " (" + fmtPct(chosen.share, 1) + "), theta " + fmtTheta(chosen.theta)))));
    } else clear(selectedHost);
  }

  function focusMap() {
    if (!map || !data) return;
    const chosen = selectedRow();
    if (!chosen) {
      map.fit({ force: true });
      return;
    }
    const view = focusView(chosen.truth, chosen.answer, mapHost.clientWidth || 600);
    if (view) map.flyTo(view.lat, view.lng, view.zoom);
  }

  function renderCharts() {
    const rows = data.rows;
    const distances = {
      groups: distanceGroups(rows),
      log: true,
      x: { label: "rank-1 distance", format: fmtDist },
      y: { label: "panoramas" },
      marks: [{ x: 100, label: "100 m" }, { x: 1000, label: "1 km" }, { x: 10000, label: "10 km" }],
      empty: "No panorama has an answer to measure.",
    };
    if (distanceChart) distanceChart.update(distances);
    else distanceChart = histogram(distanceHost, distances);

    const costs = {
      points: costScorePoints(rows),
      x: { label: "cost", format: fmtUsd },
      y: { label: "score", format: fmtInt, min: 0 },
      onPick: (point) => pick(point.pid),
      empty: "No panorama has both a cost and a score.",
    };
    if (costChart) costChart.update(costs);
    else costChart = scatterChart(costHost, costs);
  }

  // ------------------------------------------------------------ per-panorama table

  function resultRow(row) {
    const pid = row.panorama_id;
    const band = bandInfo(row.band);
    const on = pid === selected;
    const replay = paths.pano(runId, pid, { tab: "truth" });
    const stop = (event) => event.stopPropagation();
    const node = el("tr", {
      class: "clickable" + (on ? " selected" : ""),
      title: "Click to show this panorama on the map",
      onclick: () => pick(pid),
    },
      el("td", { onclick: stop },
        el("div", "row tight",
          el("button", {
            type: "button", class: "icon-btn eval-res-show", "aria-pressed": on ? "true" : "false",
            title: on ? "Clear the selection" : "Show on the map", "aria-label": (on ? "Clear the selection of " : "Show ") + pid + (on ? "" : " on the map"),
            onclick: () => pick(pid),
          }, icon("target")),
          link(replay, { class: "mono eval-res-pid", title: "Open the replay of " + pid }, pid),
          row.special ? specialBadge() : null)),
      el("td", null, specBadge(labelBadge(row.label))),
      el("td", "r num nowrap",
        fmtDist(row.rank1_distance_m), " ",
        el("span", { class: "eval-band-tag eval-band-tag-" + band.key, title: "First entry " + band.label + " of the truth" }, band.short)),
      el("td", "r num", fmtDist(row.best_distance_m)),
      el("td", "r num", fmtTheta(row.theta)),
      el("td", "r num", fmtScore(row.score)),
      el("td", "r num", fmtPct(row.share, 1)),
      el("td", "r mono", row.multiplier === null ? "–" : fmtMult(row.multiplier)),
      el("td", null, specBadge(originBadge(row.origin))),
      el("td", "mono nowrap", row.plan || "–"),
      el("td", "r num", row.n_hypotheses === null ? "–" : fmtInt(row.n_hypotheses)),
      el("td", "r num", fmtUsd(row.cost_usd)),
      el("td", { class: "r num nowrap", title: row.time_s === null ? null : fmtDuration(row.time_s) }, row.time_s === null ? "–" : fmtClock(row.time_s)),
      el("td", "r num", row.turns === null ? "–" : fmtInt(row.turns)),
      el("td", { class: "eval-res-stop", title: row.stop_reason || null }, row.stop_text || row.stop_reason || "–"));
    rowNodes.set(pid, node);
    return node;
  }

  function sortBy(key, refocus) {
    sort = nextSort(sort, key);
    renderTable();
    if (!refocus) return;
    const header = tableHost.querySelector("th[data-key=\"" + key + "\"]");
    if (header) header.focus();
  }

  function renderTable() {
    rowNodes.clear();
    const rows = sortRows(data.rows, sort);
    const sorted = sort.key ? COLUMNS.find((column) => column.key === sort.key) : null;
    const head = el("tr", null,
      COLUMNS.map((column) => el("th", {
        class: "sortable" + (column.right ? " r" : ""),
        scope: "col",
        tabindex: "0",
        title: column.title || null,
        "aria-sort": sort.key !== column.key ? "none" : sort.dir === "desc" ? "descending" : "ascending",
        dataset: { key: column.key },
        onclick: () => sortBy(column.key, false),
        onkeydown: (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          sortBy(column.key, true);
        },
      }, column.label)));
    replace(tableHost,
      el("div", "row spread wrap",
        el("h2", "eval-tab-title", "Per panorama"),
        el("span", "dim small", sorted
          ? "Sorted by " + sorted.label.toLowerCase() + ". A third click on the header returns to the order of the results file."
          : plural(rows.length, "panorama") + ". Click a header to sort, a row to select it on the map, an id to open its replay.")),
      !data.truth && data.truthError
        ? el("p", "dim small", "Theta comes with the truth, which could not be read: the column is empty.")
        : null,
      !runInfo ? el("p", "dim small", "The run's own state could not be read, so the stop reasons are missing.") : null,
      rows.length
        ? el("div", "table-wrap",
          el("table", "table compact eval-res-table",
            el("thead", null, head),
            el("tbody", null, rows.map(resultRow))))
        : el("div", "empty panel",
          el("div", "empty-title", "No panorama was scored"),
          el("p", null, "The results file lists none. Rescore the run below to write it again.")));
  }

  function applySelection({ scroll = false } = {}) {
    if (!data) return;
    for (const [pid, node] of rowNodes) {
      const on = pid === selected;
      node.classList.toggle("selected", on);
      const button = node.querySelector(".eval-res-show");
      if (button) {
        button.setAttribute("aria-pressed", on ? "true" : "false");
        button.title = on ? "Clear the selection" : "Show on the map";
      }
    }
    renderMap();
    focusMap();
    focusedFor = runId + "|" + tag + "|" + (selected || "");
    const node = selected ? rowNodes.get(selected) : null;
    if (scroll && node) node.scrollIntoView({ block: "nearest" });
  }

  // ------------------------------------------------------------ variants and rescore

  function renderVariants() {
    const rows = variantRows(data.payload, tag, data.original);
    const demo = body.classList.contains("eval-is-demo");
    replace(variantsHost,
      el("p", "dim small",
        "The original is the run as it answered. A variant is the same run scored again offline with another allocation, saved beside it as ",
        el("code", null, "results.<tag>.json"), "."),
      el("div", "table-wrap",
        el("table", "table compact eval-res-variants",
          el("thead", null, el("tr", null,
            el("th", { scope: "col" }, "Result file"),
            el("th", { scope: "col" }, "Allocation"),
            el("th", { scope: "col", class: "r" }, "Mean score"),
            el("th", { scope: "col", class: "r" }, "Share of max"),
            el("th", { scope: "col", class: "r", title: "Share of maximum against the original, in percentage points" }, "Against original"),
            el("th", { scope: "col", class: "r" }, "Median rank-1"),
            el("th", { scope: "col" }, el("span", "sr-only", "Actions")))),
          el("tbody", null, rows.map((row) => {
            // The original's own numbers are only in the payload when it is the one on screen.
            const known = row.score_share !== null || row.mean_score !== null;
            return el("tr", row.current ? "selected" : null,
              el("td", null, el("div", "row tight",
                el("span", row.tag ? "mono" : "strong", row.label),
                row.current ? badge("shown", "info", "eye") : null,
                demo ? demoBadge() : null)),
              el("td", "eval-res-alloc", row.text),
              el("td", "r num", known ? fmtScore(row.mean_score) : "–"),
              el("td", "r num", known ? fmtPct(row.score_share, 1) : "–"),
              el("td", "r num", row.tag ? fmtDelta("share", row.share_delta) : "–"),
              el("td", "r num", known ? fmtDist(row.median_rank1_m) : "–"),
              el("td", null, el("div", "row tight",
                row.current ? null : el("button", {
                  type: "button", class: "small", onclick: () => setQuery({ tag: row.tag || null }, { replace: false }),
                }, "Show"),
                row.tag ? el("button", {
                  type: "button", class: "small", title: "Compare the original with this variant",
                  onclick: () => ctx.setTab("compare", { a: runId, b: formatRef(runId, row.tag), pano: null }),
                }, "Compare") : null)));
          })))),
      rows.length === 1
        ? el("p", "dim small", "No variant yet. Rescore the run to see what another allocation would have scored.")
        : null);
  }

  function buildRescore() {
    const radios = new Map();
    const group = el("div", { class: "stack tight", role: "radiogroup", "aria-labelledby": "eval-res-alloc-title" },
      ALLOCATIONS.map((choice) => {
        const input = el("input", {
          type: "radio", name: "eval-res-allocation", value: choice.value,
          onchange: () => { rescoreForm.allocation = choice.value; rescoreError = null; renderRescore(); },
        });
        radios.set(choice.value, input);
        return el("div", "stack tight",
          el("label", "check", input, el("span", "strong", choice.label)),
          el("span", "field-help eval-res-indent", choice.help));
      }));
    const distinct = el("input", {
      type: "checkbox", onchange: () => { rescoreForm.distinct = distinct.checked; rescoreError = null; renderRescore(); },
    });
    const distinctHelp = el("span", "field-help eval-res-indent");
    const tagInput = el("input", {
      type: "text", class: "mono", autocomplete: "off", spellcheck: false, maxlength: "32",
      oninput: () => { rescoreForm.tag = tagInput.value; rescoreError = null; renderRescore(); },
    });
    const tagError = el("span", { class: "field-error", role: "alert" });
    const tagField = el("label", "field eval-res-tagfield",
      el("span", "field-label", "Variant name"), tagInput,
      el("span", "field-help", "Empty uses the name shown, as the command line does."), tagError);
    const go = el("button", { type: "button", class: "primary", onclick: () => startRescore() });
    const reason = el("span", { class: "dim small", role: "status" });
    const errorHost = el("div", "eval-res-rescore-error");
    const node = el("section", { class: "card stack eval-res-rescore", "aria-labelledby": "eval-res-rescore-title" },
      el("h3", { class: "card-title", id: "eval-res-rescore-title" }, "Rescore offline"),
      el("div", "notice notice-info", icon("info"),
        el("div", null,
          el("strong", null, "No model call, no cost. "),
          "The hypotheses the agent logged are allocated again on this machine and scored against the same truth. It takes a few seconds.")),
      el("h4", { class: "section-title", id: "eval-res-alloc-title" }, "Allocation"),
      group,
      el("div", "stack tight",
        el("label", "check", distinct, el("span", "strong", "Distinct points only")),
        distinctHelp),
      tagField,
      el("div", "row wrap", go, reason),
      errorHost);
    return { node, radios, distinct, distinctHelp, tagInput, tagError, tagField, go, reason, errorHost };
  }

  function renderRescore() {
    const r = rescore;
    const keep = rescoreForm.allocation === "keep";
    for (const [value, input] of r.radios) {
      input.checked = value === rescoreForm.allocation;
      input.disabled = rescoring;
    }
    r.distinct.checked = !keep && rescoreForm.distinct;
    r.distinct.disabled = keep || rescoring;
    r.distinctHelp.textContent = keep
      ? "Not with \"Keep the answers\": distinct points need a re-allocation."
      : "No two of the ten entries on the same spot (organiser question Q3).";
    const { tag: target, error: tagProblem } = readRescoreForm(rescoreForm);
    if (document.activeElement !== r.tagInput && r.tagInput.value !== rescoreForm.tag) r.tagInput.value = rescoreForm.tag;
    r.tagInput.placeholder = readRescoreForm({ ...rescoreForm, tag: "" }).tag;
    r.tagInput.disabled = rescoring;
    r.tagField.classList.toggle("invalid", Boolean(tagProblem));
    r.tagError.textContent = tagProblem || "";

    const active = runIsActive();
    const exists = data && Array.isArray(data.payload.variants) && data.payload.variants.some((variant) => variant.tag === target);
    r.go.disabled = rescoring || Boolean(tagProblem) || active || !data;
    replace(r.go, rescoring ? el("span", "spinner") : icon("refresh"), rescoring ? "Rescoring…" : "Rescore offline");
    r.reason.textContent = rescoring ? ""
      : active ? "The run is still going. Rescore it when it has ended."
        : tagProblem ? "Correct the variant name first."
          : "Writes the variant " + target + (exists ? ", replacing the one that exists." : ".");

    if (rescoreError) {
      const err = rescoreError;
      const retry = err.status === 0 || err.status >= 500
        ? el("button", { type: "button", class: "small", onclick: () => startRescore({ confirmed: true }) }, icon("refresh"), "Try again")
        : null;
      replace(r.errorHost, errorNotice("The rescore did not happen.", err, retry));
    } else clear(r.errorHost);
  }

  async function startRescore({ confirmed = false } = {}) {
    if (rescoring || unmounted || !data) return;
    const target = runId;
    const { body: request, tag: variant, error: tagProblem } = readRescoreForm(rescoreForm);
    if (tagProblem) return;
    const bodyJson = JSON.stringify([target, request]);
    // A retry of the same request after the server could not be reached reuses the key; a new
    // click is a new rescore and gets a new one, or the server would answer with the old result.
    const reuse = canReuseKey(lastAttempt, bodyJson);
    const key = reuse ? lastAttempt.key : newKey();
    const exists = (data.payload.variants || []).some((item) => item.tag === variant);
    if (exists && !(confirmed && reuse)) {
      const asking = confirmDialog({
        title: "Replace the variant " + variant + "?",
        body: "Run " + target + " already has a variant named " + variant + ". Rescoring writes it again with the allocation chosen here. The original results are not touched.",
        okLabel: "Replace it",
        cancelLabel: "Keep it",
      });
      dialog = confirmDialog.current;
      const ok = await asking;
      dialog = null;
      if (!ok || unmounted) return;
    }
    rescoring = true;
    rescoreError = null;
    renderRescore();
    try {
      const answer = await api.post(rescoreUrl(target), request, { key, timeoutMs: 120000 });
      lastAttempt = null;
      if (unmounted) return;
      const written = (answer && answer.tag) || variant;
      const share = answer && answer.results && answer.results.summary && answer.results.summary.all
        ? answer.results.summary.all.score_share_of_max : null;
      toast("Variant " + written + " of " + target + " is written" + (typeof share === "number" ? ": " + fmtPct(share, 1) + " of the maximum." : "."), "ok");
      rescoreForm.tag = "";
      if (target !== runId) return;
      if (written === tag) load({ quiet: true });
      else setQuery({ tag: written }, { replace: false });
    } catch (err) {
      if (unmounted) return;
      lastAttempt = { bodyJson, key, status: err && typeof err.status === "number" ? err.status : 0 };
      rescoreError = err;
    } finally {
      rescoring = false;
      if (!unmounted) renderRescore();
    }
  }

  function kv(lines) {
    return el("dl", "kv", lines.map(([name, value]) => [el("dt", null, name), el("dd", null, String(value))]));
  }

  function renderConfig() {
    const { payload } = data;
    const variantConfig = tag && payload.results ? payload.results.config : null;
    replace(configHost,
      el("p", "dim small", "What produced the answers. A variant keeps the run's answers and changes only how the ten entries are allocated."),
      el("div", "eval-res-config",
        el("div", "stack tight", el("h4", "section-title", "The run"), kv(configLines(payload.config))),
        variantConfig
          ? el("div", "stack tight", el("h4", "section-title", "This variant: " + variantText(variantConfig)), kv(configLines(variantConfig)))
          : null));
  }

  // ------------------------------------------------------------ live updates

  // The index changes when a run ends, is scored, rescored or deleted: read both again, quietly.
  const reload = debounce(() => {
    if (unmounted) return;
    loadIndex();
    if (runId && !rescoring && !scoringNow) load({ quiet: Boolean(data) });
  }, 500);
  offs.push(store.on("index", reload));
  // While the run is still going, the "3 of 6 are done" line follows the stream.
  offs.push(store.subscribe(() => {
    if (!unmounted && runId && !data && error && error.code === "no_results") renderStatus();
  }));

  render();
  renderRescore();
  loadIndex();
  if (runId) load();

  return {
    unmount() {
      unmounted = true;
      reload.cancel();
      if (loadAbort) loadAbort.abort();
      if (indexAbort) indexAbort.abort();
      for (const off of offs) off();
      if (dialog && confirmDialog.current === dialog) dialog.close();
      if (map) map.destroy();
      if (distanceChart) distanceChart.destroy();
      if (costChart) costChart.destroy();
      map = null;
      distanceChart = null;
      costChart = null;
      rowNodes.clear();
    },
    onQuery(query) {
      const nextRun = query.get("run") || "";
      const nextTag = query.get("tag") || "";
      const nextPano = query.get("pano") || null;
      if (nextRun !== runId || nextTag !== tag) {
        const sameRun = nextRun === runId;
        runId = nextRun;
        tag = nextTag;
        selected = nextPano;
        rescoreError = null;
        if (!sameRun) runInfo = null;
        if (!runId) {
          data = null;
          error = null;
          loadIndex();
          render();
          return;
        }
        load();
      } else if (nextPano !== selected) {
        selected = nextPano;
        applySelection({ scroll: true });
      }
    },
  };
}
