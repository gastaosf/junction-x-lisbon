// Evaluation, Compare tab (UI-SPEC 5.9 "Compare"): two result files side by side, a run or one of
// its rescore variants on each side. Replaces `eval compare`.
//
// A is the baseline and B the candidate: every delta is B minus A. Scores come from ground
// truth, so the server answers only when both sides are evaluation runs with human channels off.

import { api, errorText } from "../../api.js";
import { scatterChart } from "../../components/charts.js";
import { badge, debounce, el, icon, replace } from "../../dom.js";
import { fmtInt, plural } from "../../format.js";
import {
  DELTA_SORTS,
  DEMO_NOTE,
  GROUPS,
  compareRows,
  configLines,
  configSummary,
  deltaWinner,
  fmtDelta,
  fmtMetric,
  fmtScore,
  formatRef,
  labelBadge,
  nextSort,
  pairedView,
  parseRef,
  resultRefs,
  scatterPoints,
  scoreDomain,
  sortDeltas,
  sortRows,
} from "../../logic/evalstats.js";
import { link, paths, setQuery } from "../../router.js";
import { store } from "../../store.js";

const RUNS_URL = "/api/runs";
const enc = encodeURIComponent;
const compareUrl = (a, b) => "/api/eval/compare?a=" + enc(a) + "&b=" + enc(b);

const COLUMNS = [
  { key: "panorama_id", label: "Panorama" },
  { key: "label", label: "Label" },
  { key: "score_a", label: "Score A", right: true },
  { key: "score_b", label: "Score B", right: true },
  { key: "delta", label: "Change (B - A)", right: true, title: "Score of B minus score of A" },
];

const WINNER = {
  b: { text: "B higher", kind: "ok", icon: "chevron-up" },
  a: { text: "A higher", kind: "bad", icon: "chevron-down" },
  tie: { text: "tie", kind: "dim", icon: "minus" },
};

function specBadge(spec) {
  return badge(spec.text, spec.kind, spec.icon || undefined);
}

function demoBadge() {
  const node = badge("DEMO", "warn", "alert");
  node.title = DEMO_NOTE;
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

  let a = ctx.query.get("a") || "";
  let b = ctx.query.get("b") || "";
  let selected = ctx.query.get("pano") || null;

  let refs = null; // every result file that can be compared, from the runs index
  let refsError = null;
  let refsAbort = null;

  let data = null; // {a, b, answer}: the comparison of the pair on screen
  let error = null;
  let loading = false;
  let loadAbort = null;

  let sort = { key: null, dir: "asc" }; // null: the largest change first
  let chart = null;
  const rowNodes = new Map(); // panorama id -> <tr>

  // ------------------------------------------------------------ skeleton

  const selectA = el("select", { id: "eval-cmp-a", class: "mono eval-cmp-pick", onchange: () => choose({ a: selectA.value }) });
  const selectB = el("select", { id: "eval-cmp-b", class: "mono eval-cmp-pick", onchange: () => choose({ b: selectB.value }) });
  const swap = el("button", {
    type: "button", class: "small", title: "Swap the two sides", onclick: () => choose({ a: b, b: a }),
  }, icon("refresh"), "Swap");
  const refresh = el("button", {
    type: "button", class: "ghost small", title: "Read both result files again",
    onclick: () => { loadRefs(); load(); },
  }, icon("refresh"), "Refresh");
  const statusHost = el("div", "stack eval-cmp-status");

  const demoHost = el("div", "eval-cmp-demo");
  const sidesHost = el("div", "eval-cmp-sides");
  const pairedHost = el("div", "stack");
  const groupsHost = el("div", "stack");
  const chartHost = el("div", "eval-chart eval-cmp-chart");
  const tableHost = el("div", "stack eval-cmp-table-host");

  const body = el("div", { class: "stack loose eval-cmp-body", hidden: true },
    demoHost,
    sidesHost,
    el("section", { class: "card stack", "aria-labelledby": "eval-cmp-paired-title" },
      el("h3", { class: "card-title", id: "eval-cmp-paired-title" }, "Paired comparison"),
      pairedHost),
    el("section", { class: "card stack", "aria-labelledby": "eval-cmp-groups-title" },
      el("h3", { class: "card-title", id: "eval-cmp-groups-title" }, "By label, side by side"),
      groupsHost),
    el("div", "eval-cmp-lower",
      el("section", { class: "card stack tight", "aria-label": "Score of A against score of B, per panorama" },
        el("h3", "card-title", "Score A against score B"),
        el("p", "dim small",
          "One point per panorama both sides hold. Both axes share one scale, so a point above the diagonal scored higher in B and a point below it scored higher in A. Click a point to find its row."),
        chartHost),
      tableHost));

  container.append(
    el("div", "stack loose",
      el("div", "stack",
        el("div", "row wrap eval-tab-head eval-cmp-head",
          el("h2", "eval-tab-title", "Compare"),
          el("label", { class: "row tight", for: "eval-cmp-a" }, badge("A", "info"), el("span", "dim small", "baseline")), selectA,
          swap,
          el("label", { class: "row tight", for: "eval-cmp-b" }, badge("B", "info"), el("span", "dim small", "candidate")), selectB,
          el("span", "grow"), refresh),
        el("p", "dim eval-cmp-intro",
          "Pick two result files: two runs, or a run and one of its rescore variants. Every change is B minus A."),
        statusHost),
      body));

  function choose(changes) {
    setQuery({ ...changes, pano: null }, { replace: false });
  }

  // ------------------------------------------------------------ the result files to choose from

  async function loadRefs() {
    if (refsAbort) refsAbort.abort();
    const abort = new AbortController();
    refsAbort = abort;
    try {
      const answer = await api.get(RUNS_URL, { signal: abort.signal });
      if (unmounted || refsAbort !== abort) return;
      refs = resultRefs(answer && answer.runs);
      refsError = null;
    } catch (err) {
      if (unmounted || refsAbort !== abort || (err && err.name === "AbortError")) return;
      refsError = err;
    }
    if (refsAbort !== abort) return;
    refsAbort = null;
    renderHead();
    renderStatus();
  }

  function fill(select, value, other) {
    const options = (refs || []).map((item) => ({ value: item.ref, text: item.label }));
    if (value && !options.some((option) => option.value === value)) options.unshift({ value, text: value });
    replace(select,
      el("option", { value: "" }, refs || value ? "Choose a result file" : "Reading the runs…"),
      options.map((option) => el("option", { value: option.value }, option.text + (option.value === other ? " (the other side)" : ""))));
    select.value = value;
  }

  function renderHead() {
    fill(selectA, a, b);
    fill(selectB, b, a);
    swap.disabled = !a && !b;
    refresh.disabled = loading;
  }

  // ------------------------------------------------------------ loading the comparison

  async function load() {
    if (loadAbort) loadAbort.abort();
    loadAbort = null;
    const want = { a, b };
    if (!a || !b || !parseRef(a) || !parseRef(b)) {
      data = null;
      error = null;
      loading = false;
      render();
      return;
    }
    const abort = new AbortController();
    loadAbort = abort;
    loading = true;
    if (data && (data.a !== want.a || data.b !== want.b)) data = null;
    error = null;
    render();
    try {
      const answer = await api.get(compareUrl(want.a, want.b), { signal: abort.signal });
      if (unmounted || loadAbort !== abort) return;
      data = { a: want.a, b: want.b, answer };
      error = null;
    } catch (err) {
      if (unmounted || loadAbort !== abort || (err && err.name === "AbortError")) return;
      error = err;
      data = null;
    }
    loadAbort = null;
    loading = false;
    render();
    if (selected && rowNodes.has(selected)) rowNodes.get(selected).scrollIntoView({ block: "nearest" });
  }

  // ------------------------------------------------------------ rendering

  function render() {
    if (unmounted) return;
    renderHead();
    renderStatus();
    const shown = Boolean(data) && data.a === a && data.b === b;
    body.hidden = !shown;
    if (shown) renderBody();
  }

  function renderStatus() {
    const items = [];
    if (refsError) {
      items.push(errorNotice("The runs could not be read, so the lists above may be incomplete.", refsError,
        el("button", { type: "button", class: "small", onclick: () => loadRefs() }, icon("refresh"), "Try again")));
    }
    const badRef = [["A", a], ["B", b]].find(([, ref]) => ref && !parseRef(ref));
    if (badRef) {
      items.push(el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", null,
          el("strong", null, "Side " + badRef[0] + " does not name a result file. "),
          "It must be a run id, or a run id and a variant joined by a colon. Choose one from the list above.")));
    } else if (!a || !b) {
      if (refs && refs.length < 2 && !refsError) {
        items.push(el("div", "empty panel",
          icon("layers", { size: 28 }),
          el("div", "empty-title", refs.length ? "Only one result file so far" : "No result file yet"),
          el("p", null, refs.length
            ? "A comparison needs two. Run another configuration, or rescore the run you have to make a variant of it."
            : "A comparison needs two result files. They are written when an evaluation run ends."),
          el("div", "row",
            el("button", { type: "button", class: "primary", onclick: () => ctx.setTab("run") }, "Go to the Run tab"),
            refs.length
              ? el("button", { type: "button", onclick: () => ctx.setTab("results", { run: refs[0].run_id, tag: null, pano: null }) }, "Rescore " + refs[0].run_id)
              : null)));
      } else if (refs) {
        items.push(el("div", "notice notice-info", icon("info"),
          el("div", null, !a && !b
            ? "Choose the baseline (A) and the candidate (B) above."
            : "Choose side " + (a ? "B, the candidate," : "A, the baseline,") + " above.")));
      } else if (!refsError) {
        items.push(el("p", "dim row", el("span", "spinner"), "Looking for result files…"));
      }
    } else if (loading && !data) {
      items.push(el("p", "dim row", el("span", "spinner"), "Comparing " + a + " with " + b + "…"));
    } else if (error) {
      const again = el("button", { type: "button", class: "small", onclick: () => load() }, icon("refresh"), "Try again");
      const title = error.code === "fake_model_mismatch" ? "These two cannot be compared."
        : error.code === "no_results" ? "One side has no results."
          : error.code === "truth_not_allowed" ? "One side is not an evaluation run that may be scored."
            : "The comparison could not be made.";
      items.push(errorNotice(title, error, error.status === 0 || error.status >= 500 ? again : null));
    } else if (data && a === b) {
      items.push(el("div", "notice notice-info", icon("info"),
        el("div", null, "Both sides are the same result file, so every change is zero. Choose another file for one side.")));
    }
    replace(statusHost, items);
  }

  function kpi(value, label, help) {
    return el("div", "eval-kpi",
      el("div", "eval-kpi-value num", value),
      el("div", "eval-kpi-label caps dim", label),
      help ? el("div", "dim small", help) : null);
  }

  function sideCard(letter, side) {
    const s = side || {};
    const runId = String(s.run_id || "");
    const tag = String(s.tag || "");
    return el("section", { class: "card stack tight eval-cmp-side", "aria-label": "Side " + letter },
      el("div", "row wrap",
        badge(letter, "info"),
        el("span", "mono strong wrap-any", formatRef(runId, tag)),
        s.fake_model ? demoBadge() : null,
        el("span", "grow"),
        el("button", {
          type: "button", class: "small", onclick: () => ctx.setTab("results", { run: runId, tag: tag || null, pano: null }),
        }, "Open results")),
      el("div", "dim", (tag ? "Variant of " + runId + ": " : "") + configSummary(s.config)),
      el("details", "eval-cmp-config",
        el("summary", null, "Configuration"),
        el("dl", "kv", configLines(s.config).map(([name, value]) => [el("dt", null, name), el("dd", null, String(value))]))));
  }

  function verdictMark(verdict) {
    if (verdict === "better") return el("span", { class: "eval-delta-mark ok-text", title: "Better in B" }, icon("check"), el("span", "sr-only", " better in B"));
    if (verdict === "worse") return el("span", { class: "eval-delta-mark bad-text", title: "Worse in B" }, icon("x"), el("span", "sr-only", " worse in B"));
    return el("span", { class: "eval-delta-mark", "aria-hidden": "true" });
  }

  function renderBody() {
    const answer = data.answer || {};
    const sideA = answer.a || {};
    const sideB = answer.b || {};
    const demo = Boolean(sideA.fake_model || sideB.fake_model);
    body.classList.toggle("eval-is-demo", demo);
    replace(demoHost, demo
      ? el("div", { class: "notice notice-warn", role: "note" }, icon("alert"),
        el("div", null, el("strong", null, "DEMO runs. "), DEMO_NOTE))
      : null);

    replace(sidesHost, sideCard("A", sideA), sideCard("B", sideB));

    const comparison = answer.comparison || {};
    const paired = pairedView(comparison.paired);
    const part = (count) => (paired.n ? (100 * count) / paired.n + "%" : "0%");
    replace(pairedHost,
      el("div", "eval-kpis eval-cmp-kpis",
        kpi(String(paired.b_better), "B higher", "panoramas where B scored more"),
        kpi(String(paired.a_better), "A higher", "panoramas where A scored more"),
        kpi(String(paired.ties), paired.ties === 1 ? "tie" : "ties", "the same score on both sides"),
        kpi(fmtDelta("score", paired.mean_delta), "mean score change", "B minus A, per panorama both hold")),
      paired.n
        ? el("div", {
          class: "eval-cmp-bar", role: "img",
          "aria-label": "B higher on " + paired.b_better + ", ties " + paired.ties + ", A higher on " + paired.a_better,
        },
          el("span", { class: "eval-cmp-bar-seg is-b", style: { width: part(paired.b_better) } }),
          el("span", { class: "eval-cmp-bar-seg is-tie", style: { width: part(paired.ties) } }),
          el("span", { class: "eval-cmp-bar-seg is-a", style: { width: part(paired.a_better) } }))
        : null,
      el("p", null, paired.text));

    const metrics = compareRows(comparison.groups);
    replace(groupsHost,
      el("p", "dim small row tight wrap",
        "Change is B minus A. ",
        el("span", "row tight ok-text", icon("check"), "better in B"),
        el("span", "row tight bad-text", icon("x"), "worse in B"),
        "Shares change in percentage points (pts)."),
      el("div", "table-wrap",
        el("table", "table compact eval-cmp-groups",
          el("thead", null,
            el("tr", null,
              el("th", { scope: "col", rowspan: "2" }, "Metric"),
              GROUPS.map((group) => el("th", { scope: "colgroup", colspan: "3", class: "eval-cmp-grouphead" },
                group === "all" ? "All" : specBadge(labelBadge(group))))),
            el("tr", null, GROUPS.map(() => [
              el("th", { scope: "col", class: "r eval-cmp-first" }, "A"),
              el("th", { scope: "col", class: "r" }, "B"),
              el("th", { scope: "col", class: "r" }, "Change"),
            ]))),
          el("tbody", null, metrics.map((metric) => el("tr", null,
            el("th", { scope: "row" }, metric.label),
            GROUPS.map((group) => {
              const cell = metric.cells[group];
              return [
                el("td", "r num eval-cmp-first", fmtMetric(metric.type, cell.a)),
                el("td", "r num", fmtMetric(metric.type, cell.b)),
                el("td", "r num nowrap", fmtDelta(metric.type, cell.delta), verdictMark(cell.verdict)),
              ];
            })))))));

    const panoramas = Array.isArray(answer.panoramas) ? answer.panoramas : [];
    const domain = scoreDomain(panoramas);
    const points = {
      points: scatterPoints(panoramas),
      x: { label: "score A", format: fmtInt, min: domain[0], max: domain[1] },
      y: { label: "score B", format: fmtInt, min: domain[0], max: domain[1] },
      onPick: (point) => setQuery({ pano: point.pid }),
      empty: "The two sides share no panorama.",
    };
    if (chart) chart.update(points);
    else chart = scatterChart(chartHost, points);

    renderTable();
  }

  function sortBy(key, refocus) {
    sort = nextSort(sort, key);
    renderTable();
    if (!refocus) return;
    const header = tableHost.querySelector("th[data-key=\"" + key + "\"]");
    if (header) header.focus();
  }

  function deltaRow(row, sides) {
    const pid = String(row.panorama_id);
    const winner = deltaWinner(row);
    const mark = winner === "unpaired"
      ? badge(row.score_a === null || row.score_a === undefined ? "only in B" : "only in A", "dim", "info")
      : specBadge(WINNER[winner]);
    const replay = (side) => paths.pano(side.run_id, pid, { tab: "truth" });
    const inA = row.score_a !== null && row.score_a !== undefined;
    const inB = row.score_b !== null && row.score_b !== undefined;
    const sameRun = sides.a.run_id === sides.b.run_id;
    const links = sameRun
      ? [link(replay(sides.a), { class: "btn small", title: "Both sides are the same run: one replay" }, "Replay")]
      : [
        inA ? link(replay(sides.a), { class: "btn small" }, "Replay A") : null,
        inB ? link(replay(sides.b), { class: "btn small" }, "Replay B") : null,
      ];
    const node = el("tr", {
      class: "clickable" + (pid === selected ? " selected" : ""),
      onclick: () => setQuery({ pano: pid === selected ? null : pid }),
    },
      el("td", null, el("span", "mono", pid)),
      el("td", null, specBadge(labelBadge(row.label))),
      el("td", "r num", fmtScore(row.score_a)),
      el("td", "r num", fmtScore(row.score_b)),
      el("td", "r num nowrap", el("span", "eval-cmp-change", fmtDelta("score", row.delta)), " ", mark),
      el("td", { class: "eval-cmp-actions", onclick: (event) => event.stopPropagation() }, el("div", "row tight", links)));
    rowNodes.set(pid, node);
    return node;
  }

  function renderTable() {
    rowNodes.clear();
    const answer = data.answer || {};
    const sides = { a: answer.a || {}, b: answer.b || {} };
    const all = Array.isArray(answer.panoramas) ? answer.panoramas : [];
    const rows = sort.key ? sortRows(all, sort, DELTA_SORTS) : sortDeltas(all);
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
      }, column.label)),
      el("th", { scope: "col" }, el("span", "sr-only", "Replays")));
    replace(tableHost,
      el("div", "row spread wrap",
        el("h2", "eval-tab-title", "Per panorama"),
        el("span", "dim small", sorted
          ? "Sorted by " + sorted.label.toLowerCase() + ". A third click on the header returns to the largest change first."
          : plural(rows.length, "panorama") + ", the largest change first.")),
      rows.length
        ? el("div", "table-wrap",
          el("table", "table compact eval-cmp-table",
            el("thead", null, head),
            el("tbody", null, rows.map((row) => deltaRow(row, sides)))))
        : el("div", "empty panel",
          el("div", "empty-title", "No panorama on either side"),
          el("p", null, "Both result files are empty.")));
  }

  function applySelection() {
    for (const [pid, node] of rowNodes) node.classList.toggle("selected", pid === selected);
    const node = selected ? rowNodes.get(selected) : null;
    if (node) node.scrollIntoView({ block: "nearest" });
  }

  // A rescore or a finished run adds a result file to choose from.
  const reloadRefs = debounce(() => { if (!unmounted) loadRefs(); }, 500);
  offs.push(store.on("index", reloadRefs));

  render();
  loadRefs();
  load();

  return {
    unmount() {
      unmounted = true;
      reloadRefs.cancel();
      if (loadAbort) loadAbort.abort();
      if (refsAbort) refsAbort.abort();
      for (const off of offs) off();
      if (chart) chart.destroy();
      chart = null;
      rowNodes.clear();
    },
    onQuery(query) {
      const nextA = query.get("a") || "";
      const nextB = query.get("b") || "";
      const nextPano = query.get("pano") || null;
      if (nextA !== a || nextB !== b) {
        a = nextA;
        b = nextB;
        selected = nextPano;
        load();
      } else if (nextPano !== selected) {
        selected = nextPano;
        applySelection();
      }
    },
  };
}
