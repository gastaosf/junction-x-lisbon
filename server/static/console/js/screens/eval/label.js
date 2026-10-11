// Evaluation, Label tab (UI-SPEC 5.9 "Label"): confirm the Urban / non-Urban label of every
// evaluation panorama by eye, one at a time in the 360° viewer or all at once in a grid. It
// replaces `eval.build_set label`.
//
// The label is made from the picture alone: the coordinates, area and country that
// /api/eval/set also returns are never rendered here.
//
// Keys U, N, S, J, K and the arrows act at once. That is safe: a label is neither penalised nor
// irreversible (press the other key to change it), and nothing here reaches a run or the agent.

import { api, errorText } from "../../api.js";
import { createPanoViewer } from "../../components/pano-viewer.js";
import { badge, clear, el, icon, replace, syncList } from "../../dom.js";
import { plural } from "../../format.js";
import { shortcuts } from "../../keyboard.js";
import {
  FILTERS,
  LABELS,
  NON_URBAN,
  PREF_FILTER,
  PREF_VIEW,
  URBAN,
  buildQueue,
  filterCounts,
  imageSources,
  imageUrl,
  indexById,
  labelBadge,
  labelState,
  nextToDo,
  normaliseFilter,
  progressText,
  queueProgress,
  replaceEntry,
  stateBadge,
  step,
} from "../../logic/evalset.js";
import { prefs } from "../../prefs.js";
import { setQuery } from "../../router.js";
import { store } from "../../store.js";

const SET_URL = "/api/eval/set";
const BUILD_KIND = "eval_build";
const VIEWS = [
  { name: "one", label: "One at a time", icon: "image" },
  { name: "all", label: "Bulk review", icon: "grid" },
];

const labelUrl = (pid) => "/api/eval/set/" + encodeURIComponent(pid);

function specBadge(spec) {
  return badge(spec.text, spec.kind, spec.icon || undefined);
}

function keycap(text) {
  return el("kbd", null, text);
}

export function mountTab(container, ctx) {
  let set = null;
  let entries = [];
  let byId = new Map();
  let missing = new Set();
  let loadError = null;
  let loading = false;
  let loadAbort = null;
  let unmounted = false;

  let filter = normaliseFilter(prefs.get(PREF_FILTER, "unconfirmed"));
  let view = prefs.get(PREF_VIEW, "one") === "all" ? "all" : "one";
  let queue = [];
  let currentId = null;
  let wantedPano = ctx.query.get("pano"); // the panorama the URL names, until it has been honoured
  let strayPano = null; // a `?pano=` that is not in the set, to say so once

  const saving = new Map(); // panorama id -> the label being saved
  const failures = new Map(); // panorama id -> the error of its last save
  let lastSaved = null; // {pid, label}: what the previous key press did
  let buildActive = false;
  let stopBuildWatch = null;
  let watchedBuildId = null;

  let viewer = null;
  let viewerPid = null;
  let preload = null;
  const requests = new AbortController(); // every label save, cancelled on unmount
  const cardParts = new WeakMap(); // grid card -> its nodes
  const offs = [];

  // ------------------------------------------------------------ skeleton

  const viewButtons = new Map();
  const viewGroup = el("div", { class: "btn-group", role: "group", "aria-label": "How to review" },
    VIEWS.map((item) => {
      const button = el("button", { type: "button", class: "small", onclick: () => setView(item.name) }, icon(item.icon), item.label);
      viewButtons.set(item.name, button);
      return button;
    }));
  const filterButtons = new Map();
  const filterGroup = el("div", { class: "btn-group", role: "group", "aria-label": "Which panoramas to walk through" },
    FILTERS.map((item) => {
      const count = el("span", "num dim");
      const button = el("button", { type: "button", class: "small", onclick: () => setFilter(item.name) }, item.label, count);
      filterButtons.set(item.name, { button, count });
      return button;
    }));
  const refreshButton = el("button", { type: "button", class: "ghost small", title: "Read the set from disk again", onclick: () => load() },
    icon("refresh"), "Refresh");

  const status = el("div", "stack eval-label-status");
  const emptyHost = el("div", "eval-label-empty");

  // one at a time
  const viewerHost = el("div", "eval-label-viewer");
  const viewerProblem = el("div", "eval-label-noimage");
  const progressLine = el("div", { class: "eval-label-progress num", role: "status" });
  const progressFill = el("div", "progress-fill ok");
  const progressBar = el("div", { class: "progress", role: "progressbar", "aria-label": "Labels confirmed in this list", "aria-valuemin": "0", "aria-valuemax": "100" }, progressFill);
  const currentLine = el("div", "stack tight eval-label-current");
  const labelButtons = new Map();
  for (const [label, key] of [[URBAN, "U"], [NON_URBAN, "N"]]) {
    const mark = el("span", "eval-label-mark");
    const button = el("button", { type: "button", class: "eval-label-choice", onclick: () => labelCurrent(label) },
      el("span", "eval-label-choice-text", label), mark, keycap(key));
    labelButtons.set(label, { button, mark });
  }
  const skipButton = el("button", { type: "button", title: "Leave this one as it is and go to the next one that is not confirmed", onclick: () => skip() },
    "Skip", keycap("S"));
  const prevButton = el("button", { type: "button", title: "Previous panorama (K or left arrow)", onclick: () => move(-1) },
    icon("arrow-left"), "Previous", keycap("K"));
  const nextButton = el("button", { type: "button", title: "Next panorama (J or right arrow)", onclick: () => move(1) },
    "Next", keycap("J"), icon("arrow-right"));
  const savedLine = el("div", { class: "eval-label-saved small", role: "status" });
  const failureHost = el("div", "eval-label-failure");
  const doneHost = el("div", "eval-label-done");
  const side = el("aside", { class: "card stack eval-label-side", "aria-label": "Label this panorama" },
    el("div", "stack tight", progressLine, progressBar),
    currentLine,
    el("div", "stack tight eval-label-choices", labelButtons.get(URBAN).button, labelButtons.get(NON_URBAN).button, skipButton),
    el("div", "row eval-label-nav", prevButton, nextButton),
    savedLine,
    failureHost,
    doneHost,
    el("p", "dim small eval-label-help",
      "The label picks the scoring scale: street scale for Urban, region scale for non-Urban. ",
      "Coordinates and place names are hidden here, so the label comes from the picture alone."),
    el("p", "dim small eval-label-help",
      "The arrow keys move between panoramas. While the picture has the keyboard they turn the view instead: ",
      keycap("J"), " and ", keycap("K"), " always move."));
  const one = el("div", "eval-label-one", el("div", "eval-label-stage", viewerHost, viewerProblem), side);

  // all at once
  const grid = el("div", "eval-bulk");
  const all = el("div", "stack eval-label-all",
    el("p", "dim small", "Each picture is the whole panorama, flattened. Open one to look around it. Coordinates and place names are hidden here."),
    grid);

  container.append(
    el("div", "stack",
      el("div", "row wrap eval-tab-head",
        el("h2", "eval-tab-title", "Label the set"),
        el("span", "grow"),
        viewGroup, filterGroup, refreshButton),
      status, emptyHost, one, all));

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
      set = next;
      loadError = null;
      entries = Array.isArray(next.entries) ? next.entries : [];
      byId = indexById(entries);
      missing = new Set(next.missing || []);
      for (const pid of Array.from(failures.keys())) if (!byId.has(pid)) failures.delete(pid);
      watchBuild(next.build_job_id || null);
      rebuildQueue();
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

  // The queue is fixed here and not while labelling: see buildQueue.
  function rebuildQueue() {
    let keep = currentId && byId.has(currentId) ? currentId : null;
    if (wantedPano) {
      if (byId.has(wantedPano)) keep = wantedPano;
      else strayPano = wantedPano;
      wantedPano = null;
    }
    queue = buildQueue(entries, filter, keep);
    const first = keep || nextToDo(queue, byId, null) || queue[0] || null;
    setCurrent(first, { replaceUrl: true });
  }

  function setCurrent(pid, { replaceUrl = true } = {}) {
    currentId = pid;
    // In the grid there is no "current" panorama, so the URL keeps whatever it named.
    if (view === "one" || pid === null) setQuery({ pano: pid }, { replace: replaceUrl });
  }

  // ------------------------------------------------------------ actions

  function setFilter(name) {
    if (name === filter) return;
    filter = name;
    prefs.set(PREF_FILTER, name);
    const keep = currentId;
    queue = buildQueue(entries, filter, null);
    setCurrent(queue.includes(keep) ? keep : nextToDo(queue, byId, null) || queue[0] || null);
    lastSaved = null;
    render();
  }

  function setView(name) {
    if (name === view) return;
    view = name;
    prefs.set(PREF_VIEW, name);
    if (view === "one" && currentId) setQuery({ pano: currentId });
    render();
  }

  function open(pid) {
    view = "one";
    prefs.set(PREF_VIEW, "one");
    go(pid);
    viewerHost.scrollIntoView({ block: "nearest" });
  }

  function go(pid) {
    if (!pid || !byId.has(pid)) return;
    if (!queue.includes(pid)) queue = buildQueue(entries, filter, pid);
    setCurrent(pid);
    render();
  }

  function move(delta) {
    const next = step(queue, currentId, delta);
    if (next) go(next);
  }

  function skip() {
    const next = nextToDo(queue, byId, currentId);
    if (next) go(next);
  }

  function labelsLocked() {
    return buildActive;
  }

  function labelCurrent(label) {
    if (view !== "one" || !currentId) return;
    saveLabel(currentId, label, { advance: true });
  }

  async function saveLabel(pid, label, { advance = false } = {}) {
    // One save per panorama at a time; a second key press while it is on its way is dropped
    // rather than queued, so a held key cannot run ahead of what the operator has seen.
    if (saving.has(pid) || labelsLocked() || !byId.has(pid)) return;
    if (advance && saving.size) return;
    saving.set(pid, label);
    failures.delete(pid);
    render();
    try {
      const answer = await api.patch(labelUrl(pid), { label }, { signal: requests.signal, timeoutMs: 15000 });
      if (unmounted) return;
      const entry = answer && answer.entry ? answer.entry : { panorama_id: pid, label, label_confirmed: true };
      entries = replaceEntry(entries, entry);
      byId = indexById(entries);
      if (answer && answer.counts && set) set = { ...set, ...answer.counts };
      lastSaved = { pid, label: entry.label };
      saving.delete(pid);
      if (advance && currentId === pid && view === "one") {
        const next = nextToDo(queue, byId, pid);
        if (next) setCurrent(next);
      }
    } catch (err) {
      if (unmounted || (err && err.name === "AbortError")) return;
      saving.delete(pid);
      failures.set(pid, err);
      // A build or an evaluation run got in the way, or the set was replaced from another tab:
      // the set as we hold it is out of date.
      if (err && (err.status === 409 || err.status === 404)) load({ quiet: true });
    }
    render();
  }

  // ------------------------------------------------------------ build in progress

  function watchBuild(id) {
    if (id === watchedBuildId) return;
    if (stopBuildWatch) stopBuildWatch();
    stopBuildWatch = null;
    watchedBuildId = id;
    buildActive = Boolean(id);
    if (!id) return;
    const stop = store.watchJob(id, (job) => {
      if (unmounted || watchedBuildId !== id) return;
      if (job.state === "queued" || job.state === "running") return;
      watchedBuildId = null;
      buildActive = false;
      // The build wrote a new manifest (or failed and left the old one): read it again. Not
      // from inside the load that started this watch, which has to finish first.
      setTimeout(() => {
        stop();
        if (!unmounted) load({ quiet: true });
      }, 0);
    });
    stopBuildWatch = stop;
  }

  offs.push(store.on("job", (message) => {
    const job = message && message.job;
    if (!job || job.kind !== BUILD_KIND) return;
    if (job.state === "queued" || job.state === "running") {
      watchBuild(job.id);
      render();
    }
  }));

  // ------------------------------------------------------------ rendering

  function render() {
    if (unmounted) return;
    renderStatus();
    renderHead();
    const ready = Boolean(set) && entries.length > 0 && queue.length > 0;
    renderEmpty();
    one.hidden = !(ready && view === "one");
    all.hidden = !(ready && view === "all");
    if (ready && view === "one") renderOne();
    else dropViewer();
    if (ready && view === "all") renderAll();
    else clear(grid);
  }

  function renderHead() {
    const counts = filterCounts(entries);
    for (const [name, { button, count }] of filterButtons) {
      button.setAttribute("aria-pressed", name === filter ? "true" : "false");
      button.disabled = !set;
      count.textContent = set ? String(counts[name]) : "";
    }
    for (const [name, button] of viewButtons) {
      button.setAttribute("aria-pressed", name === view ? "true" : "false");
      button.disabled = !set;
    }
    refreshButton.disabled = loading;
  }

  function renderStatus() {
    const items = [];
    if (loadError) {
      items.push(el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight grow",
          el("strong", null, set
            ? "The evaluation set could not be read again. What is shown may be out of date."
            : "The evaluation set could not be read."),
          el("span", "pre", errorText(loadError))),
        el("button", { type: "button", class: "small", onclick: () => load() }, icon("refresh"), "Try again")));
    } else if (loading && !set) {
      items.push(el("p", "dim row", el("span", "spinner"), "Reading the evaluation set…"));
    }
    if (set && set.problem) {
      items.push(el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight", el("strong", null, "The manifest cannot be read."), el("span", "pre", String(set.problem)))));
    }
    if (buildActive) {
      items.push(el("div", "notice notice-warn", icon("clock"),
        el("div", "grow",
          el("strong", null, "The evaluation set is being built. "),
          "Labels cannot be saved until the build has ended. This tab reads the new set by itself then."),
        el("button", { type: "button", class: "small", onclick: () => ctx.setTab("set") }, "Watch the build")));
    }
    if (strayPano) {
      const gone = strayPano;
      items.push(el("div", "notice notice-warn", icon("alert"),
        el("div", "grow", "The link named panorama ", el("code", null, gone), ", which is not in the evaluation set. ",
          currentId ? "Showing another one instead." : ""),
        el("button", { type: "button", class: "icon-btn", title: "Dismiss", "aria-label": "Dismiss", onclick: () => { strayPano = null; renderStatus(); } }, icon("x"))));
    }
    replace(status, items);
  }

  function renderEmpty() {
    if (!set) {
      clear(emptyHost);
      return;
    }
    if (!entries.length) {
      replace(emptyHost, el("div", "empty panel",
        icon("image", { size: 28 }),
        el("div", "empty-title", set.exists ? "The evaluation set is empty" : "There is no evaluation set yet"),
        el("p", null, "There is nothing to label. Build the set on the Set tab first."),
        el("button", { type: "button", class: "primary", onclick: () => ctx.setTab("set") }, "Go to the Set tab")));
    } else if (!queue.length) {
      const name = FILTERS.find((item) => item.name === filter).label;
      replace(emptyHost, el("div", "empty panel",
        icon("check", { size: 28 }),
        el("div", "empty-title", filter === "todo" ? "No panorama is without a label" : "Every label is confirmed"),
        el("p", null, "Nothing is left under \"" + name + "\". " +
          (filter === "todo" ? "Evaluation runs can start. Guessed labels can still be reviewed." : "The set is ready for an evaluation run.")),
        el("div", "row wrap",
          el("button", { type: "button", onclick: () => setFilter(filter === "todo" ? "unconfirmed" : "all") },
            filter === "todo" ? "Review the labels not confirmed" : "Show all " + plural(entries.length, "panorama")),
          el("button", { type: "button", class: "primary", onclick: () => ctx.setTab("run") }, "Go to the Run tab"))));
    } else clear(emptyHost);
  }

  function dropViewer() {
    if (viewer) viewer.destroy();
    viewer = null;
    viewerPid = null;
    preload = null;
  }

  function showPanorama(pid) {
    const gone = missing.has(pid);
    viewerHost.hidden = gone;
    viewerProblem.hidden = !gone;
    if (gone) {
      dropViewer();
      replace(viewerProblem, el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight",
          el("strong", null, "The image file of this panorama is missing from the set directory."),
          el("span", null, "It cannot be labelled by eye, and a run on it cannot start. Build the set again on the Set tab."))));
      return;
    }
    if (viewerPid === pid && viewer) return;
    const sources = imageSources(pid);
    if (!viewer) {
      viewer = createPanoViewer(viewerHost, { sources, mode: "360", ruler: false, controls: true, label: "Evaluation panorama, drag to look around" });
    } else {
      // The same viewer for every panorama: a new one each time would run out of WebGL contexts.
      viewer.setSources(sources);
      viewer.reset({ animate: false });
    }
    viewerPid = pid;
    // Fetch the next picture while this one is being looked at, so U and N feel instant.
    const next = nextToDo(queue, byId, pid) || step(queue, pid, 1);
    if (next && !missing.has(next) && typeof Image === "function") {
      preload = new Image();
      preload.src = imageUrl(next, imageSources(next)[0].width);
    }
  }

  function renderOne() {
    const entry = byId.get(currentId);
    if (!entry) return;
    showPanorama(currentId);

    const progress = queueProgress(queue, byId, currentId);
    progressLine.textContent = progressText(progress);
    const share = progress.total ? (progress.total - progress.toDo) / progress.total : 0;
    progressFill.style.width = 100 * share + "%";
    progressBar.setAttribute("aria-valuenow", String(Math.round(100 * share)));

    const state = labelState(entry);
    replace(currentLine,
      el("div", "mono small wrap-any", entry.panorama_id),
      el("div", "row tight wrap", specBadge(labelBadge(entry.label)), specBadge(stateBadge(state))));

    const pending = saving.get(currentId);
    const locked = labelsLocked();
    const busy = saving.size > 0;
    for (const [label, { button, mark }] of labelButtons) {
      const confirmed = state === "confirmed" && entry.label === label;
      const guessed = state === "unconfirmed" && entry.label === label;
      button.disabled = locked || busy;
      button.setAttribute("aria-pressed", confirmed ? "true" : "false");
      button.classList.toggle("is-guess", guessed);
      button.title = locked
        ? "Labels cannot be saved while the set is being built."
        : confirmed ? "Confirmed as " + label + ". Press again to keep it and move on." : "Label " + label + " and go to the next one";
      if (pending === label) replace(mark, el("span", "spinner"), "saving");
      else if (confirmed) replace(mark, icon("check"), "confirmed");
      else if (guessed) replace(mark, "the guess");
      else clear(mark);
    }
    const further = nextToDo(queue, byId, currentId);
    skipButton.disabled = busy || !further;
    prevButton.disabled = !step(queue, currentId, -1);
    nextButton.disabled = !step(queue, currentId, 1);

    if (lastSaved && byId.has(lastSaved.pid)) {
      const saved = lastSaved;
      replace(savedLine,
        icon("check"),
        el("span", "grow wrap-any", "Saved ", el("span", "mono", saved.pid), " as " + saved.label + "."),
        saved.pid !== currentId
          ? el("button", { type: "button", class: "ghost small", onclick: () => go(saved.pid) }, "Go back to it")
          : null);
      savedLine.hidden = false;
    } else {
      clear(savedLine);
      savedLine.hidden = true;
    }

    const failed = failures.get(currentId);
    if (failed) {
      replace(failureHost, el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight",
          el("strong", null, "The label was not saved."),
          el("span", "pre", errorText(failed)),
          el("span", null, "This panorama is still the one shown. Press the key again to retry."))));
    } else clear(failureHost);

    if (!progress.toDo) {
      if (!doneHost.firstChild) {
        doneHost.append(el("div", "notice notice-ok", icon("check"),
          el("div", "stack tight",
            el("strong", null, "Every label in this list is confirmed."),
            el("span", null, "You can still step through and change one."),
            el("div", "row wrap",
              el("button", { type: "button", class: "small primary", onclick: () => ctx.setTab("run") }, "Go to the Run tab")))));
      }
    } else clear(doneHost);
  }

  function bulkCard(entry) {
    const pid = entry.panorama_id;
    const thumb = el("button", { type: "button", class: "eval-bulk-thumb", title: "Open in the 360° viewer", "aria-label": "Open " + pid + " in the 360° viewer", onclick: () => open(pid) });
    const head = el("div", "row tight wrap eval-bulk-head");
    const buttons = new Map();
    const group = el("div", { class: "btn-group eval-bulk-choices", role: "group", "aria-label": "Label of " + pid },
      LABELS.map((label) => {
        const button = el("button", { type: "button", class: "small", onclick: () => saveLabel(pid, label) });
        buttons.set(label, button);
        return button;
      }));
    const problem = el("div", { class: "field-error small pre", role: "alert" });
    const card = el("article", "panel eval-bulk-card", thumb, el("div", "stack tight eval-bulk-body", head, group, problem));
    cardParts.set(card, { thumb, head, buttons, problem, image: null });
    return card;
  }

  function updateBulkCard(card, entry) {
    const pid = entry.panorama_id;
    const parts = cardParts.get(card);
    const { thumb, head, buttons, problem } = parts;
    const gone = missing.has(pid);
    if (parts.image !== (gone ? "missing" : "shown")) {
      parts.image = gone ? "missing" : "shown";
      if (gone) replace(thumb, el("span", "eval-bulk-noimage", icon("alert"), "image file missing"));
      else {
        // `loading` goes first: set after `src`, the fetch would already be on its way.
        const image = el("img", {
          loading: "lazy", decoding: "async", width: "320", height: "160",
          alt: "Evaluation panorama " + pid + ", flattened",
          onerror: () => replace(thumb, el("span", "eval-bulk-noimage", icon("alert"), "the image could not be loaded")),
          sizes: "24rem",
          srcset: imageUrl(pid, 320) + " 320w, " + imageUrl(pid, 1024) + " 1024w",
          src: imageUrl(pid, 320),
        });
        replace(thumb, image);
      }
    }
    const state = labelState(entry);
    replace(head,
      el("span", { class: "mono small grow clamp-1", title: pid }, pid),
      specBadge(stateBadge(state)));
    const pending = saving.get(pid);
    for (const [label, button] of buttons) {
      const confirmed = state === "confirmed" && entry.label === label;
      const guessed = state === "unconfirmed" && entry.label === label;
      button.disabled = labelsLocked() || saving.has(pid);
      button.setAttribute("aria-pressed", confirmed ? "true" : "false");
      button.classList.toggle("is-guess", guessed);
      replace(button,
        pending === label ? el("span", "spinner") : confirmed ? icon("check") : null,
        label,
        guessed ? el("span", "dim", "(guess)") : null);
    }
    const failed = failures.get(pid);
    problem.textContent = failed ? "Not saved. " + errorText(failed) : "";
    problem.hidden = !failed;
  }

  function renderAll() {
    const list = queue.map((pid) => byId.get(pid)).filter(Boolean);
    syncList(grid, list, (entry) => entry.panorama_id, bulkCard, updateBulkCard);
  }

  // ------------------------------------------------------------ keys

  const single = () => view === "one" && Boolean(currentId) && !one.hidden;
  // A key held down repeats: it must not label the panoramas that follow, which nobody has seen.
  const once = (fn) => (event) => { if (!event || !event.repeat) fn(); };
  offs.push(shortcuts.register("Evaluation: label", {
    u: { label: "Label Urban and go to the next one", when: single, run: once(() => labelCurrent(URBAN)) },
    n: { label: "Label non-Urban and go to the next one", when: single, run: once(() => labelCurrent(NON_URBAN)) },
    s: { label: "Skip to the next one that is not confirmed", when: single, run: once(() => skip()) },
    j: { label: "Next panorama", when: single, run: () => move(1) },
    k: { label: "Previous panorama", when: single, run: () => move(-1) },
    ArrowRight: { label: "Next panorama (J when the picture has the keyboard)", when: single, run: () => move(1) },
    ArrowLeft: { label: "Previous panorama (K when the picture has the keyboard)", when: single, run: () => move(-1) },
  }));

  render();
  load();

  return {
    unmount() {
      unmounted = true;
      if (loadAbort) loadAbort.abort();
      requests.abort();
      if (stopBuildWatch) stopBuildWatch();
      for (const off of offs) off();
      dropViewer();
    },
    onQuery(query) {
      // Back, Forward or an edited address bar: follow the panorama the URL names.
      const pid = query.get("pano");
      if (!pid || pid === currentId) return;
      if (!set) {
        wantedPano = pid;
        return;
      }
      if (byId.has(pid)) go(pid);
      else {
        strayPano = pid;
        setCurrent(currentId);
        renderStatus();
      }
    },
  };
}
