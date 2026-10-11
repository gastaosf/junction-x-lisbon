// Evaluation, Set tab (UI-SPEC 5.9 "Set"): the state of the evaluation set, where its panoramas
// are, the entries, and the build job that replaces `eval.build_set build`.
//
// This tab shows ground-truth coordinates: it is the evaluation set itself, served by
// /api/eval/set only. Nothing here reaches a run or the agent.

import { api, errorText, newKey } from "../../api.js";
import { createMap } from "../../components/map.js";
import { confirmDialog, toast } from "../../components/shell.js";
import { badge, clear, copyButton, el, icon, replace, statusBadge } from "../../dom.js";
import { fmtCoord, fmtDateTime, fmtInt, fmtLatLng, fmtPct, plural } from "../../format.js";
import {
  BUILD_FIELDS,
  PREF_FILTER,
  breakdown,
  buildBlockedReason,
  canReuseKey,
  fmtStamp,
  hasPoint,
  jobView,
  labelBadge,
  labelState,
  nextSort,
  readBuildForm,
  replaceLossLines,
  sortEntries,
  stateBadge,
} from "../../logic/evalset.js";
import { prefs } from "../../prefs.js";
import { link, paths } from "../../router.js";
import { store } from "../../store.js";

const SET_URL = "/api/eval/set";
const BUILD_URL = "/api/eval/set/build";
const BUILD_KIND = "eval_build";

const COLUMNS = [
  { key: "panorama_id", label: "Panorama" },
  { key: "label", label: "Label" },
  { key: "state", label: "State" },
  { key: "area", label: "Area" },
  { key: "country", label: "Country" },
  { key: "kind", label: "Kind" },
  { key: "timestamp", label: "Captured" },
  { key: "lat", label: "Latitude", right: true },
  { key: "lng", label: "Longitude", right: true },
];

const BUILD_HELP = {
  count: "How many panoramas to collect, 1 to 50.",
  seed: "The same seed and the same search results give the same set.",
  per_area_limit: "How many images to ask Mapillary for in each area.",
};

function specBadge(spec) {
  return badge(spec.text, spec.kind, spec.icon || undefined);
}

export function mountTab(container, ctx) {
  let set = null; // the last GET /api/eval/set
  let loadError = null;
  let loading = false;
  let loadAbort = null;
  let sort = { key: null, dir: "asc" };
  let selected = null; // panorama id highlighted in the table
  let map = null;
  let unmounted = false;

  const form = { replace: false };
  for (const [key, field] of Object.entries(BUILD_FIELDS)) form[key] = String(field.fallback);
  let starting = false;
  let buildError = null;
  let lastAttempt = null; // {bodyJson, key, status}: see canReuseKey
  let job = null;
  let watchedJobId = null;
  let stopWatching = null;
  let sawActive = false; // this tab saw the job while it ran, so its end is news
  let logTouched = false; // the operator opened or closed the log: leave it as they left it
  let jobPanel = null; // nodes of the job panel, updated in place so a selection in the log survives

  const rows = new Map(); // panorama id -> <tr>
  const offs = [];

  // ------------------------------------------------------------ skeleton

  const refreshButton = el("button", { type: "button", class: "ghost small", title: "Read the set from disk again", onclick: () => load() },
    icon("refresh"), "Refresh");
  const status = el("div", "stack eval-set-status");
  const notices = el("div", "stack eval-set-notices");
  const summary = el("div", "eval-stats");
  const mapHost = el("div", "eval-set-map");
  const mapNote = el("span", "dim small");
  const breakdownHost = el("div", "eval-breakdowns");
  const overview = el("div", "eval-set-overview",
    el("section", { class: "card flush eval-map-card", "aria-label": "Map of the evaluation panoramas" },
      el("div", "card-head", el("h3", "card-title", "Where they are"), el("span", "grow"), mapNote),
      mapHost),
    el("section", { class: "card", "aria-label": "Split by country and kind of place" }, breakdownHost));
  const tableHost = el("div", "stack eval-entries");
  const body = el("div", "stack loose eval-set-body", notices, summary, overview, tableHost);
  const build = buildCard();

  container.append(
    el("div", "stack loose",
      el("div", "stack",
        el("div", "row spread eval-tab-head", el("h2", "eval-tab-title", "Evaluation set"), refreshButton),
        status),
      body,
      build.node));

  // ------------------------------------------------------------ loading

  async function load({ quiet = false } = {}) {
    if (loadAbort) loadAbort.abort();
    const abort = new AbortController();
    loadAbort = abort;
    loading = true;
    if (!quiet) renderStatus();
    try {
      const next = await api.get(SET_URL, { signal: abort.signal });
      if (unmounted || loadAbort !== abort) return;
      set = { ...next, entries: Array.isArray(next.entries) ? next.entries : [] };
      loadError = null;
      if (selected && !set.entries.some((entry) => entry.panorama_id === selected)) selected = null;
      // A build that is running, or else the last one this server ran: found again after a reload.
      watchJob(set.build_job_id || set.last_build_job_id || watchedJobId, null, false);
    } catch (err) {
      if (unmounted || loadAbort !== abort || (err && err.name === "AbortError")) return;
      loadError = err;
    } finally {
      if (loadAbort === abort) {
        loading = false;
        loadAbort = null;
        render();
      }
    }
  }

  // ------------------------------------------------------------ rendering

  function render() {
    if (unmounted) return;
    renderStatus();
    body.hidden = !set;
    if (set) {
      const any = set.entries.length > 0;
      summary.hidden = !any;
      overview.hidden = !any;
      tableHost.hidden = !any;
      renderNotices();
      if (any) {
        renderSummary();
        renderMap();
        renderBreakdowns();
        renderTable();
      }
    }
    renderBuild();
  }

  function renderStatus() {
    refreshButton.disabled = loading;
    if (loadError) {
      replace(status, el("div", { class: "notice notice-bad", role: "alert" },
        icon("alert"),
        el("div", "stack tight grow",
          el("strong", null, set
            ? "The evaluation set could not be read again. What is shown may be out of date."
            : "The evaluation set could not be read."),
          el("span", "pre", errorText(loadError))),
        el("button", { type: "button", class: "small", onclick: () => load() }, icon("refresh"), "Try again")));
    } else if (loading && !set) {
      replace(status, el("p", "dim row", el("span", "spinner"), "Reading the evaluation set…"));
    } else clear(status);
  }

  function goLabel(pano, filter) {
    // The filter of the labelling tool is a preference of this browser, not part of the URL (A1).
    if (filter) prefs.set(PREF_FILTER, filter);
    ctx.setTab("label", { pano: pano || null });
  }

  function renderNotices() {
    const items = [];
    if (set.problem) {
      items.push(el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight", el("strong", null, "The manifest cannot be read."), el("span", "pre", String(set.problem)))));
    }
    if (!set.exists) {
      items.push(el("div", "empty panel",
        icon("image", { size: 28 }),
        el("div", "empty-title", "There is no evaluation set yet"),
        el("p", null, "Build one below. It collects 360° panoramas with known coordinates, which is what evaluation runs are scored against."),
        el("p", { class: "dim small mono wrap-any", title: "The evaluation data directory" }, String(set.data_dir || ""))));
    } else if (!set.entries.length && !set.problem) {
      items.push(el("div", "empty panel",
        el("div", "empty-title", "The evaluation set is empty"),
        el("p", null, "The manifest lists no panorama. Build the set again below, with \"Replace the existing set\" ticked.")));
    }
    const leaking = set.leaking || [];
    if (leaking.length) {
      items.push(el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight grow",
          el("strong", null, plural(leaking.length, "panorama") + " of this set " + (leaking.length === 1 ? "leaks its" : "leak their") + " source."),
          el("span", null,
            "Ids of the form ", el("code", null, "mly_<image id>"),
            " are shown to the agent and name the Mapillary image, so a run on this set can look the answer up. ",
            "The set was built before that was closed. Build it again: the new ids say nothing.")),
        el("button", { type: "button", class: "small", onclick: () => proposeRebuild() }, icon("refresh"), "Rebuild the set")));
    }
    const missing = set.missing || [];
    if (missing.length) {
      items.push(el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight",
          el("strong", null, "The image " + (missing.length === 1 ? "file of 1 panorama is" : "files of " + missing.length + " panoramas are") + " missing from the set directory."),
          el("span", "mono small wrap-any", missing.join(", ")),
          el("span", null, "A run on these cannot start. Build the set again."))));
    }
    if (set.entries.length) {
      if (set.todo) {
        items.push(el("div", "notice notice-warn", icon("alert"),
          el("div", "grow",
            el("strong", null, plural(set.todo, "panorama") + (set.todo === 1 ? " has" : " have") + " no Urban / non-Urban label. "),
            "An evaluation run refuses to start until every panorama has one."),
          el("button", { type: "button", class: "small primary", onclick: () => goLabel(null, "todo") }, "Label them")));
      } else if (set.unconfirmed) {
        items.push(el("div", "notice notice-info", icon("info"),
          el("div", "grow",
            el("strong", null, plural(set.unconfirmed, "label") + (set.unconfirmed === 1 ? " is a guess" : " are guesses") + " nobody has confirmed. "),
            "Runs can start, but a wrong guess scores that panorama on the wrong distance scale."),
          el("button", { type: "button", class: "small", onclick: () => goLabel(null, "unconfirmed") }, "Review them")));
      } else {
        items.push(el("div", "notice notice-ok", icon("check"), el("div", null, "Every label of the set is confirmed by hand.")));
      }
    }
    replace(notices, items);
  }

  function stat(value, label, extra) {
    return el("div", "eval-stat",
      el("div", "eval-stat-value num", value),
      el("div", "eval-stat-label caps dim", label),
      extra || null);
  }

  function renderSummary() {
    const total = set.entries.length;
    const share = (n) => (total ? (100 * (Number(n) || 0)) / total + "%" : "0%");
    const byLabel = set.by_label || {};
    const bar = el("div", {
      class: "eval-labelbar", role: "img",
      "aria-label": set.confirmed + " confirmed, " + set.unconfirmed + " not confirmed, " + set.todo + " without a label",
    },
      el("span", { class: "eval-labelbar-seg is-confirmed", style: { width: share(set.confirmed) } }),
      el("span", { class: "eval-labelbar-seg is-unconfirmed", style: { width: share(set.unconfirmed) } }),
      el("span", { class: "eval-labelbar-seg is-todo", style: { width: share(set.todo) } }));
    replace(summary,
      el("section", { class: "card eval-stat-card", "aria-label": "Size of the set" },
        stat(fmtInt(total), total === 1 ? "panorama" : "panoramas"),
        el("div", { class: "dim small mono wrap-any", title: "The evaluation data directory" }, String(set.data_dir || ""))),
      el("section", { class: "card eval-stat-card", "aria-label": "Label review" },
        el("div", "eval-stat-row",
          stat(fmtInt(set.confirmed), "confirmed", specBadge(stateBadge("confirmed"))),
          stat(fmtInt(set.unconfirmed), "not confirmed", specBadge(stateBadge("unconfirmed"))),
          stat(fmtInt(set.todo), "to do", specBadge(stateBadge("todo")))),
        bar),
      el("section", { class: "card eval-stat-card", "aria-label": "Split by label" },
        el("div", "eval-stat-row",
          stat(fmtInt(byLabel.Urban || 0), "Urban", specBadge(labelBadge("Urban"))),
          stat(fmtInt(byLabel["non-Urban"] || 0), "non-Urban", specBadge(labelBadge("non-Urban"))),
          stat(fmtInt(byLabel.TODO || 0), "no label", specBadge(labelBadge("TODO")))),
        el("div", "dim small", "The label picks the scoring scale: street scale for Urban, region scale for non-Urban.")));
  }

  function renderMap() {
    const points = set.entries.filter(hasPoint);
    if (!map) map = createMap(mapHost, { interactive: true });
    map.setMarkers(points.map((entry) => ({
      lat: Number(entry.lat),
      lng: Number(entry.lng),
      label: [entry.area || entry.panorama_id, entry.label].filter(Boolean).join(" · "),
      kind: "eval",
      pid: entry.panorama_id,
    })), { onClick: (marker) => select(marker.pid, { scroll: true }) });
    map.fit();
    mapNote.textContent = points.length ? "Click a marker to find its row." : "No panorama has coordinates.";
  }

  function breakdownTable(title, counts) {
    const list = breakdown(counts);
    return el("div", "stack tight eval-breakdown",
      el("h3", "section-title", title),
      list.length
        ? el("table", "table compact",
          el("tbody", null, list.map((row) => el("tr", null,
            el("td", "eval-breakdown-name", row.name),
            el("td", "r", fmtInt(row.n)),
            el("td", "r dim", fmtPct(row.share)),
            el("td", "eval-breakdown-bar",
              el("div", "progress", el("div", { class: "progress-fill", style: { width: 100 * row.share + "%" } })))))))
        : el("p", "dim small", "Nothing to count."));
  }

  function renderBreakdowns() {
    replace(breakdownHost,
      breakdownTable("By country", set.by_country),
      breakdownTable("By kind of place", set.by_kind));
  }

  function select(pid, { scroll = false, fly = false } = {}) {
    selected = pid;
    for (const [id, row] of rows) row.classList.toggle("selected", id === pid);
    const row = rows.get(pid);
    if (scroll && row) row.scrollIntoView({ block: "nearest" });
    if (fly && map && set) {
      const entry = set.entries.find((item) => item.panorama_id === pid);
      if (entry && hasPoint(entry)) map.flyTo(Number(entry.lat), Number(entry.lng), 13);
    }
  }

  function entryRow(entry, leaking, missing) {
    const pid = entry.panorama_id;
    const has = hasPoint(entry);
    const row = el("tr", { class: "clickable" + (pid === selected ? " selected" : ""), onclick: () => select(pid, { fly: true }) },
      el("td", null,
        el("div", "row tight wrap",
          el("span", "mono", pid),
          leaking.has(pid) ? badge("leaks its source", "bad", "alert") : null,
          missing.has(pid) ? badge("image missing", "bad", "x") : null)),
      el("td", null, specBadge(labelBadge(entry.label))),
      el("td", null, specBadge(stateBadge(labelState(entry)))),
      el("td", "wrap-any", entry.area || "–"),
      el("td", null, entry.country || "–"),
      el("td", null, entry.kind || "–"),
      el("td", "num nowrap", fmtStamp(entry.timestamp)),
      el("td", "r mono", has ? fmtCoord(entry.lat) : "–"),
      el("td", "r mono", has ? fmtCoord(entry.lng) : "–"),
      el("td", "eval-entry-actions",
        el("div", "row tight",
          has ? copyButton(() => fmtLatLng(entry.lat, entry.lng), { title: "Copy the coordinates" }) : null,
          has
            ? el("button", {
              type: "button", class: "icon-btn", title: "Show on the map", "aria-label": "Show " + pid + " on the map",
              onclick: (event) => {
                event.stopPropagation();
                select(pid, { fly: true });
                mapHost.scrollIntoView({ block: "nearest" });
              },
            }, icon("target"))
            : null,
          el("button", {
            type: "button", class: "small", title: "Open this panorama in the labelling tool",
            onclick: (event) => { event.stopPropagation(); goLabel(pid, "all"); },
          }, "Label"))));
    rows.set(pid, row);
    return row;
  }

  function sortBy(key, refocus) {
    sort = nextSort(sort, key);
    renderTable();
    if (!refocus) return;
    const header = tableHost.querySelector("th[data-key=\"" + key + "\"]");
    if (header) header.focus();
  }

  function renderTable() {
    rows.clear();
    const leaking = new Set(set.leaking || []);
    const missing = new Set(set.missing || []);
    const head = el("tr", null,
      COLUMNS.map((column) => el("th", {
        class: "sortable" + (column.right ? " r" : ""),
        scope: "col",
        tabindex: "0",
        "aria-sort": sort.key !== column.key ? "none" : sort.dir === "desc" ? "descending" : "ascending",
        dataset: { key: column.key },
        onclick: () => sortBy(column.key, false),
        onkeydown: (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          sortBy(column.key, true);
        },
      }, column.label)),
      el("th", { scope: "col" }, el("span", "sr-only", "Actions")));
    replace(tableHost,
      el("div", "row spread wrap eval-entries-head",
        el("h2", "eval-tab-title", "Entries"),
        el("span", "dim small", sort.key
          ? "Sorted by " + COLUMNS.find((column) => column.key === sort.key).label.toLowerCase() + ". A third click on the header returns to the manifest order."
          : "In manifest order, which is the order a run takes them in.")),
      el("div", "table-wrap",
        el("table", "table eval-entries-table",
          el("thead", null, head),
          el("tbody", null, sortEntries(set.entries, sort).map((entry) => entryRow(entry, leaking, missing))))));
  }

  // ------------------------------------------------------------ build form

  // The form's controls are built once and updated in place: the set is read again behind the
  // operator's back (a job ended, a key was saved) and that must not take the caret away.
  function buildCard() {
    const inputs = {};
    const fields = {};
    const errorLines = {};
    for (const [key, field] of Object.entries(BUILD_FIELDS)) {
      const input = el("input", {
        type: "number", inputmode: "numeric", step: "1", min: String(field.min), max: String(field.max),
        value: form[key], class: "num eval-build-number",
        oninput: () => { form[key] = input.value; renderBuild(); },
      });
      inputs[key] = input;
      errorLines[key] = el("span", { class: "field-error", role: "alert" });
      fields[key] = el("label", "field", el("span", "field-label", field.label), input,
        el("span", "field-help", BUILD_HELP[key]), errorLines[key]);
    }
    const replaceBox = el("input", { type: "checkbox", onchange: () => { form.replace = replaceBox.checked; renderBuild(); } });
    const replaceHelp = el("span", "field-help");
    const tokenHost = el("div", "eval-build-token");
    const go = el("button", { type: "button", class: "primary eval-build-go", onclick: () => startBuild() });
    const reason = el("span", { class: "dim small eval-build-reason", role: "status" });
    const errorHost = el("div", "eval-build-error");
    const jobHost = el("div", "eval-job-host");
    const node = el("section", { class: "card stack eval-build", id: "eval-build", "aria-labelledby": "eval-build-title" },
      el("div", "stack tight",
        el("h2", { class: "card-title", id: "eval-build-title" }, "Build set"),
        el("p", "dim eval-build-intro",
          "Searches Mapillary for 360° panoramas with known coordinates in the built-in areas of Portugal, Spain and France, ",
          "samples them across cities, towns, villages, countryside and tracks, and downloads the images. ",
          "Labels start as guesses from the kind of place: confirm them on the Label tab before a run.")),
      tokenHost,
      el("div", "eval-build-form",
        fields.count, fields.seed, fields.per_area_limit,
        el("div", "field eval-build-replace",
          el("span", "field-label", "Existing set"),
          el("label", "check", replaceBox, "Replace the existing set"),
          replaceHelp)),
      el("div", "row wrap", go, reason),
      errorHost,
      jobHost);
    return { node, inputs, fields, errorLines, replaceBox, replaceHelp, tokenHost, go, reason, errorHost, jobHost };
  }

  function renderBuild() {
    const exists = Boolean(set && set.exists);
    if (!exists) form.replace = false;
    const { errors } = readBuildForm(form);
    for (const key of Object.keys(BUILD_FIELDS)) {
      build.inputs[key].disabled = starting;
      build.fields[key].classList.toggle("invalid", Boolean(errors[key]));
      build.errorLines[key].textContent = errors[key] || "";
    }
    build.replaceBox.checked = form.replace;
    build.replaceBox.disabled = !exists || starting;
    build.replaceHelp.textContent = exists
      ? "Asks for confirmation: labels confirmed by hand are lost."
      : "There is no set to replace.";

    if (set && !set.mapillary_token) {
      if (!build.tokenHost.firstChild) {
        build.tokenHost.append(el("div", "notice notice-warn", icon("key"),
          el("div", "grow",
            el("strong", null, "MAPILLARY_TOKEN is not set. "),
            "The panoramas come from Mapillary, so a build cannot start without it. A client token is free: ",
            "create one in the Mapillary developer dashboard, then save it under Settings, Keys."),
          link(paths.settings("keys"), { class: "btn small" }, icon("settings"), "Open Settings, Keys")));
      }
    } else clear(build.tokenHost);

    const view = jobView(job);
    const blocked = buildBlockedReason({ set, form, jobActive: Boolean(view && view.active) });
    build.go.disabled = Boolean(blocked) || starting;
    replace(build.go,
      starting ? el("span", "spinner") : icon("download"),
      starting ? "Starting…" : form.replace ? "Replace and build" : "Build set");
    build.reason.textContent = starting ? "" : blocked || "";

    if (buildError) {
      const err = buildError;
      const actions = [];
      if (err.code === "mapillary_token_missing") {
        actions.push(link(paths.settings("keys"), { class: "btn small" }, icon("settings"), "Open Settings, Keys"));
      } else if (err.status === 0 || err.status >= 500) {
        // The same request again, with the same key: the confirmation was already given for it.
        actions.push(el("button", { type: "button", class: "small", onclick: () => startBuild({ confirmed: true }) },
          icon("refresh"), "Try again"));
      }
      replace(build.errorHost, el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight grow", el("strong", null, "The build did not start."), el("span", "pre", errorText(err))),
        actions));
    } else clear(build.errorHost);
    renderJob();
  }

  function proposeRebuild() {
    if (set && set.exists) form.replace = true;
    renderBuild();
    build.node.scrollIntoView({ block: "start" });
    build.go.focus();
  }

  async function startBuild({ confirmed = false } = {}) {
    if (starting) return;
    const { body: request, errors } = readBuildForm(form);
    if (Object.keys(errors).length) return;
    const bodyJson = JSON.stringify(request);
    // One key per attempt at this exact build, made when the confirmation opens. A retry after
    // a timeout sends it again, so the build can only start once.
    const reuse = canReuseKey(lastAttempt, bodyJson);
    const key = reuse ? lastAttempt.key : newKey();
    // "Try again" skips the question only for the request that was confirmed: a form changed
    // since then is another build and is asked about again.
    if (request.replace && set && set.exists && !(confirmed && reuse)) {
      const ok = await confirmDialog({
        title: "Replace the evaluation set?",
        body: el("div", "stack", replaceLossLines(set).map((line) => el("p", null, line))),
        okLabel: "Replace and build",
        cancelLabel: "Keep the set",
        tone: "danger",
      });
      if (!ok || unmounted) return;
    }
    starting = true;
    buildError = null;
    renderBuild();
    try {
      const answer = await api.post(BUILD_URL, request, { key, timeoutMs: 30000 });
      lastAttempt = null;
      if (unmounted) return;
      if (answer && answer.job) watchJob(answer.job.id, answer.job, true);
    } catch (err) {
      if (unmounted) return;
      lastAttempt = { bodyJson, key, status: err && typeof err.status === "number" ? err.status : 0 };
      buildError = err;
      // The page's picture was out of date (a set appeared, the token went, a build is running).
      if (err && err.status === 409) load({ quiet: true });
    } finally {
      starting = false;
      if (!unmounted) renderBuild();
    }
  }

  // ------------------------------------------------------------ build job

  function watchJob(id, known, active) {
    if (!id || unmounted || id === watchedJobId) return;
    if (stopWatching) stopWatching();
    watchedJobId = id;
    job = known || null;
    sawActive = Boolean(active);
    logTouched = false;
    clear(build.jobHost);
    jobPanel = null;
    stopWatching = store.watchJob(id, onJob);
  }

  function onJob(next) {
    if (unmounted || !next || next.id !== watchedJobId) return;
    job = next;
    const view = jobView(job);
    if (view.active) sawActive = true;
    const ended = !view.active && sawActive;
    renderBuild();
    if (!ended) return;
    sawActive = false;
    if (view.failed) toast("The evaluation set build failed: " + (job.error || "read the log on the Set tab") + ".", "error");
    else toast("The evaluation set is built. Review its labels on the Label tab before a run.", "ok");
    load({ quiet: true });
  }

  function makeJobPanel() {
    const title = el("h3", "eval-job-title");
    const state = el("span", "eval-job-state");
    const times = el("span", "dim small num");
    const fill = el("div", "progress-fill");
    const bar = el("div", { class: "progress", role: "progressbar", "aria-label": "Build progress", "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
    const counts = el("span", "num strong");
    const text = el("span", "dim wrap-any");
    const outcome = el("div", "eval-job-outcome");
    const summaryLine = el("summary");
    const log = el("pre", { class: "code-block eval-job-log", tabindex: "0", "aria-label": "Build log" });
    const empty = el("p", "dim small", "Nothing logged yet.");
    const details = el("details", "eval-job-details", summaryLine, log, empty);
    summaryLine.addEventListener("click", () => { logTouched = true; });
    details.addEventListener("toggle", () => { if (details.open) log.scrollTop = log.scrollHeight; });
    const node = el("section", { class: "panel stack eval-job", "aria-label": "Build job" },
      el("div", "row wrap", title, state, el("span", "grow"), times),
      bar,
      el("div", "row wrap eval-job-line", counts, text),
      outcome,
      details);
    build.jobHost.append(node);
    return { title, state, times, fill, bar, counts, text, outcome, summaryLine, log, empty, details, shown: null };
  }

  function renderJob() {
    const view = jobView(job);
    if (!view) return;
    if (!jobPanel) jobPanel = makeJobPanel();
    const p = jobPanel;
    const lines = Array.isArray(job.log) ? job.log : [];
    const result = job.result && typeof job.result === "object" ? job.result : null;

    p.title.textContent = view.active ? "Build in progress" : "Last build";
    replace(p.state, view.failed ? badge("failed", "bad", "x") : statusBadge(view.state));
    p.times.textContent = "started " + fmtDateTime(job.created_at) + (job.finished_at ? ", ended " + fmtDateTime(job.finished_at) : "");
    p.bar.classList.toggle("indeterminate", view.active && view.fraction === null);
    if (view.fraction === null) p.bar.removeAttribute("aria-valuenow");
    else p.bar.setAttribute("aria-valuenow", String(Math.round(100 * view.fraction)));
    p.fill.className = "progress-fill" + (view.failed ? " bad" : view.state === "done" ? " ok" : "");
    p.fill.style.width = view.fraction === null ? "" : 100 * view.fraction + "%";
    p.counts.textContent = view.counts;
    p.text.textContent = view.text || (view.active ? "Waiting for the first report…" : "");

    // The outcome is rebuilt only when the job changes state, so its button keeps the focus.
    const signature = view.state + "|" + (job.error || "") + "|" + JSON.stringify(result);
    if (p.shown !== signature) {
      p.shown = signature;
      if (view.failed) {
        replace(p.outcome, el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
          el("div", "stack tight",
            el("strong", null, "The build failed. An existing set was left as it was."),
            el("span", "pre", String(job.error || "No reason was recorded. Read the log below.")),
            el("span", null, "Check the internet connection and the Mapillary token, then build again."))));
      } else if (view.state === "done" && result) {
        const short = Number(result.requested) > Number(result.count);
        replace(p.outcome, el("div", "notice notice-ok", icon("check"),
          el("div", "grow",
            "Wrote " + plural(result.count, "panorama") +
            (short ? " of the " + fmtInt(result.requested) + " asked for (no more were available)" : "") + ". " +
            (Number(result.todo) ? plural(result.todo, "label") + (Number(result.todo) === 1 ? " is" : " are") + " still to do, and none " : "None ") +
            "is confirmed yet."),
          el("button", { type: "button", class: "small primary", onclick: () => goLabel(null, "unconfirmed") }, "Review the labels")));
      } else clear(p.outcome);
    }

    p.summaryLine.textContent = "Log (" + plural(lines.length, "line") + (lines.length >= 200 ? ", the last 200" : "") + ")";
    // Keep following the log unless the operator scrolled up to read something.
    const follow = p.log.scrollHeight - p.log.scrollTop - p.log.clientHeight < 24;
    const textNow = lines.join("\n");
    if (p.log.textContent !== textNow) p.log.textContent = textNow;
    p.log.hidden = !lines.length;
    p.empty.hidden = Boolean(lines.length);
    if (!logTouched) p.details.open = view.active || view.failed;
    if (follow) p.log.scrollTop = p.log.scrollHeight;
  }

  // A build started from another tab or another laptop shows up here as well.
  offs.push(store.on("job", (message) => {
    const other = message && message.job;
    if (!other || other.kind !== BUILD_KIND || other.id === watchedJobId) return;
    if (jobView(other).active) watchJob(other.id, other, true);
  }));
  // A key saved in Settings (in another tab) changes whether a build can start.
  offs.push(store.on("health", (message) => {
    const chip = message && message.health && message.health.mapillary;
    if (!set || !chip || Boolean(chip.present) === Boolean(set.mapillary_token)) return;
    set = { ...set, mapillary_token: Boolean(chip.present) };
    renderBuild();
  }));

  render();
  load();

  return {
    unmount() {
      unmounted = true;
      if (loadAbort) loadAbort.abort();
      if (stopWatching) stopWatching();
      for (const off of offs) off();
      if (map) map.destroy();
      map = null;
      rows.clear();
    },
    onQuery() {},
  };
}
