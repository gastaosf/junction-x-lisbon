// The Runs screen, the landing page (UI-SPEC 5.2): every run on disk and in memory, what state it
// is in and what to do next with it.
//
// Rows come from GET /api/runs and are fetched again when the stream says the index changed. Runs
// this server holds are laid over that list from the store, so their numbers move without a
// request. Nothing on this screen reaches the agent: every control is navigation, a read, or the
// deletion of a run directory.

import { ApiError, api, errorText, runUrl } from "../api.js";
import { confirmDialog, toast } from "../components/shell.js";
import { badge, debounce, el, icon, replace, statusBadge } from "../dom.js";
import { fmtClock, fmtDateTime, fmtDist, fmtMult, fmtPct, fmtTime, fmtUsd, plural } from "../format.js";
import { shortcuts } from "../keyboard.js";
import {
  KINDS,
  STATES,
  describeKind,
  exportOutcome,
  exportingRuns,
  filterCounts,
  filterRows,
  groupRows,
  isFiltered,
  kindLabel,
  mergeRows,
  modeInfo,
  parseView,
  penaltyParts,
  rowActions,
  rowNote,
  rowSeconds,
  sortRows,
  stateInfo,
  stateLabel,
  summaryText,
  toggleSort,
  truthVisible,
  viewQuery,
} from "../logic/runs.js";
import { link, navigate, paths, setQuery } from "../router.js";
import { store } from "../store.js";

const RUNS_URL = "/api/runs";
const LOAD_TIMEOUT_MS = 30000; // the first scan folds every log on disk
const STORE_RENDER_MS = 400; // a busy run changes the store many times a second; the list need not
const QUERY_DEBOUNCE_MS = 250;
const REVOKE_MS = 10000;

const COLUMNS = [
  { key: "run", label: "Run", sort: "run" },
  { key: "mode", label: "Mode" },
  { key: "state", label: "State", sort: "state" },
  { key: "panoramas", label: "Panoramas", sort: "panoramas", right: true, title: "Panoramas with a final answer, out of all in the run" },
  { key: "spend", label: "Spend", sort: "spend", right: true, title: "Model cost of the run so far" },
  { key: "multiplier", label: "Multiplier", sort: "multiplier", right: true, title: "Lowest penalty multiplier of any panorama, and the penalties used" },
  { key: "time", label: "Wall time", sort: "time", right: true },
  { key: "score", label: "Score", sort: "score", right: true, title: "Share of the maximum score, and the median distance of the first answer. Evaluation runs only." },
  { key: "created", label: "Created", sort: "created" },
  { key: "actions", label: "Actions", srOnly: true },
];

const NOTE_ICON = { info: "info", warn: "alert", bad: "alert" };

const sigOf = (...parts) => JSON.stringify(parts);

// The zip is fetched rather than linked so that a refusal (a failed check, a demo run) is shown as
// a sentence on this page instead of a failed download.
async function fetchZip(runId, signal) {
  let response;
  try {
    response = await fetch(runUrl(runId, "/download"), {
      headers: { Accept: "application/zip, application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0, { message: "Cannot reach the server. Check that `cli.py serve` is still running, then retry." });
  }
  if (response.ok) return response.blob();
  let detail = null;
  try {
    detail = (await response.json()).detail;
  } catch (_) {
    detail = null; // not JSON: the status alone has to do
  }
  const fields = detail && typeof detail === "object" ? detail : { message: typeof detail === "string" ? detail : null };
  throw new ApiError(response.status, {
    message: fields.message || "The server refused the download (" + response.status + ").",
    detail,
    action: fields.action,
    problems: fields.problems,
    code: fields.code,
  });
}

function welcome(fakeModel) {
  return el("div", "card runs-welcome",
    el("div", "empty",
      el("div", "empty-title", "No runs yet"),
      el("p", "runs-welcome-text",
        "This console runs the panorama localisation agent from start to finish. Load a set of panoramas, check "
        + "what was parsed, launch a run and watch every panorama while the agent works. During an assisted run it "
        + "is also where the three penalised human channels are used, and afterwards where the submission is "
        + "validated and downloaded. Every run is kept on disk and listed on this page, so it can be reopened, "
        + "replayed step by step, exported again or deleted."),
      el("div", "row wrap runs-welcome-actions",
        link(paths.newRun(), { class: "btn primary" }, icon("plus"), "New run"),
        link(paths.newRun({ preset: "eval", limit: 1 }), { class: "btn" }, icon("target"), "Try it on an evaluation panorama")),
      el("p", "small runs-welcome-text",
        "The second button opens the launch form with the Evaluation preset and one panorama. Nothing starts and "
        + "nothing is spent until you launch it there."),
      fakeModel
        ? el("p", "small runs-welcome-text", "The demo model is active on this server: runs cost nothing and their answers are not real.")
        : null));
}

export function mount(container, params, ctx) {
  let alive = true;
  let view = parseView(ctx.query);
  let fetched = null; // RunRow[] of the last good GET; null until the first answer
  let fetchedAt = null;
  let fetchError = null;
  let loading = false;
  let again = false;
  let controller = null;
  let dialog = null; // {runId, handle, locked}: the delete confirmation that is open
  let storeTimer = null;
  let currentRows = new Map(); // run_id -> row, as last rendered
  const hidden = new Set(); // ids deleted here, until a list fetched after the deletion says so too
  const busy = new Map(); // run_id -> "delete" | "download" | "replay" | "rebuild"
  const jobWatches = new Map(); // job id -> stop(): export jobs started from this page
  const rowErrors = new Map(); // run_id -> text of the last failed action on that row
  const bodies = new Map(); // key -> {body, update(item), tick(nowMs)}
  const revokes = new Map(); // timer -> object URL of a download that was just handed to the browser
  const downloads = new AbortController();

  ctx.setTitle("Runs");

  // ---------------------------------------------------------------- skeleton

  const summary = el("span", "dim num runs-summary");
  const updated = el("span", "dim xsmall num runs-updated");
  const refreshMark = el("span", "runs-refresh-mark", icon("refresh"));
  const refreshButton = el("button", {
    type: "button", class: "icon-btn", title: "Refresh the list", "aria-label": "Refresh the list",
    onclick: () => load(),
  }, refreshMark);

  const search = el("input", {
    type: "search", class: "runs-search-input", placeholder: "Search by run id", autocomplete: "off",
    "aria-label": "Search runs by id", value: view.q,
  });
  search.setAttribute("spellcheck", "false");
  const pushQuery = debounce(() => setQuery(viewQuery(view)), QUERY_DEBOUNCE_MS);
  search.addEventListener("input", () => {
    view = { ...view, q: search.value };
    render();
    pushQuery();
  });

  function setView(changes) {
    view = { ...view, ...changes };
    pushQuery.cancel();
    setQuery(viewQuery(view));
    render();
  }

  function filterGroup(name, label, options) {
    const buttons = new Map();
    const group = el("div", { class: "btn-group", role: "group", "aria-label": "Filter by " + label.toLowerCase() });
    for (const [value, text] of options) {
      const count = el("span", "num runs-count");
      const button = el("button", {
        type: "button", class: "small", "aria-pressed": "false", onclick: () => setView({ [name]: value }),
      }, text, count);
      buttons.set(value, { button, count });
      group.append(button);
    }
    return { node: el("div", "runs-filter", el("span", "caps dim", label), group), buttons };
  }

  const kindFilter = filterGroup("kind", "Kind", [["all", "All"], ...KINDS.map((kind) => [kind, kindLabel(kind)])]);
  const stateFilter = filterGroup("state", "State", [["all", "All"], ...STATES.map((state) => [state, stateLabel(state)])]);
  const clearButton = el("button", {
    type: "button", class: "small ghost", hidden: true,
    onclick: () => {
      search.value = "";
      setView({ kind: "all", state: "all", q: "" });
    },
  }, icon("x"), "Clear filters");
  const filters = el("div", "runs-filters",
    el("label", "runs-search", icon("search"), search),
    kindFilter.node, stateFilter.node, clearButton);

  const status = el("div", "runs-status");

  const headCells = new Map();
  const headRow = el("tr");
  for (const column of COLUMNS) {
    const th = el("th", { scope: "col", class: [column.right && "r", column.sort && "sortable", "runs-h-" + column.key], title: column.title });
    if (column.sort) {
      // A real button, so the sort is reachable from the keyboard; its click bubbles to the cell.
      th.append(el("button", { type: "button", class: "runs-sort" }, column.label));
      th.addEventListener("click", () => setView(toggleSort(view, column.sort)));
    } else th.append(column.srOnly ? el("span", "sr-only", column.label) : column.label);
    headCells.set(column.key, th);
    headRow.append(th);
  }
  const thead = el("thead", null, headRow);
  const table = el("table", "table sticky runs-table", el("caption", "sr-only", "Every run, active runs first"), thead);
  const tableWrap = el("div", { class: "table-wrap runs-table-wrap", hidden: true }, table);

  const empty = el("div", { class: "runs-empty", hidden: true });
  const legacy = el("p", { class: "dim small runs-legacy", hidden: true },
    "The previous operator page still works for the newest run this server holds. ",
    // Plain same-origin navigation: /legacy is served by the app itself, outside the router.
    el("a", { href: "/legacy" }, "Open the old page"));

  container.append(
    el("div", "page-head",
      el("h1", "page-title", "Runs"),
      summary,
      el("span", "grow"),
      updated,
      refreshButton,
      link(paths.newRun(), { class: "btn primary" }, icon("plus"), "New run")),
    filters, status, tableWrap, empty, legacy);

  // ---------------------------------------------------------------- loading

  async function load() {
    if (!alive) return;
    if (loading) {
      again = true; // something changed while a request was out: ask once more when it is back
      return;
    }
    loading = true;
    again = false;
    renderStatus();
    const hiddenBefore = Array.from(hidden);
    controller = new AbortController();
    try {
      const data = await api.get(RUNS_URL, { signal: controller.signal, timeoutMs: LOAD_TIMEOUT_MS });
      if (!alive) return;
      fetched = data && Array.isArray(data.runs) ? data.runs : [];
      fetchedAt = Date.now();
      fetchError = null;
      for (const id of hiddenBefore) hidden.delete(id);
    } catch (err) {
      if (!alive || (err && err.name === "AbortError")) return;
      fetchError = err;
    } finally {
      loading = false;
      if (alive) {
        render();
        if (again) load();
      }
    }
  }

  // ---------------------------------------------------------------- row actions

  function setBusy(runId, what) {
    if (what) busy.set(runId, what);
    else busy.delete(runId);
    if (alive) render();
  }

  function fail(runId, lead, err) {
    const text = lead + " " + errorText(err);
    rowErrors.set(runId, text);
    toast(text, "error");
  }

  async function replay(runId) {
    if (busy.has(runId)) return;
    rowErrors.delete(runId);
    setBusy(runId, "replay");
    try {
      const run = await store.loadRun(runId);
      if (!alive) return;
      const first = (run.panoramas || [])[0];
      if (!first) {
        toast("Run " + runId + " has no panorama to replay.", "warn");
        return;
      }
      navigate(paths.pano(runId, first.panorama_id));
    } catch (err) {
      if (alive) fail(runId, "Could not open run " + runId + " for replay.", err);
    } finally {
      setBusy(runId, null);
    }
  }

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

  async function download(runId) {
    if (busy.has(runId)) return;
    rowErrors.delete(runId);
    setBusy(runId, "download");
    try {
      const blob = await fetchZip(runId, downloads.signal);
      if (!alive) return;
      saveBlob(blob, runId + "_submission.zip");
      toast("The submission zip of run " + runId + " was downloaded.", "ok");
    } catch (err) {
      if (!alive || (err && err.name === "AbortError")) return;
      fail(runId, "Could not download the zip of run " + runId + ".", err);
    } finally {
      setBusy(runId, null);
    }
  }

  // The job is watched to its end so that the outcome is said in words; the spinner on the row
  // comes from the store's jobs, so it also shows for a rebuild started on another screen or tab.
  function followExport(runId, jobId) {
    if (jobWatches.has(jobId)) return;
    let off = null;
    let over = false;
    const stop = () => {
      over = true;
      jobWatches.delete(jobId);
      if (off) off();
    };
    jobWatches.set(jobId, stop);
    off = store.watchJob(jobId, (job) => {
      if (over || !alive) return;
      const outcome = exportOutcome(runId, job);
      if (!outcome) return;
      stop();
      if (outcome.tone === "error") rowErrors.set(runId, outcome.text);
      toast(outcome.text, outcome.tone);
      load();
    });
    if (over) off(); // the job was already finished: the watcher fired before `off` existed
  }

  async function rebuild(runId) {
    if (busy.has(runId)) return;
    rowErrors.delete(runId);
    setBusy(runId, "rebuild");
    try {
      const data = await api.post(runUrl(runId, "/export"), {});
      if (!alive) return;
      const job = data && data.job;
      if (job && job.id) followExport(runId, job.id);
      else load();
    } catch (err) {
      if (alive) fail(runId, "Could not rebuild the exports of run " + runId + ".", err);
    } finally {
      setBusy(runId, null);
    }
  }

  function deleteBody(row) {
    const totals = row.totals || {};
    const holds = totals.total
      ? "the event logs, the images the agent looked at and the exported answers of " + plural(totals.total, "panorama")
      : "whatever files are in it (no panorama could be read from them)";
    return el("div", "stack",
      el("p", null, "This removes the run directory from disk: " + holds + ". It cannot be undone."),
      row.submitted_at
        ? el("div", "notice notice-warn", icon("alert"),
          el("span", null, "This run is marked as submitted (" + fmtDateTime(row.submitted_at) + "). Keep a copy of the files you handed in."))
        : null,
      el("p", "dim small", describeKind(row) + ", created " + fmtDateTime(row.created_at) + ", " + fmtUsd(totals.spend_usd) + " spent."));
  }

  async function askDelete(runId) {
    const row = currentRows.get(runId);
    if (!row || busy.has(runId)) return;
    const promise = confirmDialog({
      title: "Delete run " + runId + "?",
      body: deleteBody(row),
      okLabel: "Delete run",
      tone: "danger",
      typeToConfirm: runId,
    });
    const mine = { runId, handle: confirmDialog.current, locked: false };
    dialog = mine;
    const confirmed = await promise;
    if (dialog === mine) dialog = null;
    if (!confirmed || !alive) return;

    rowErrors.delete(runId);
    setBusy(runId, "delete");
    try {
      await api.del(runUrl(runId), { confirm: runId });
      hidden.add(runId);
      toast("Run " + runId + " was deleted.", "ok");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Deleted in another tab between the confirmation and the request: the outcome is the same.
        hidden.add(runId);
        toast("Run " + runId + " was already gone.", "info");
      } else if (alive) fail(runId, "Could not delete run " + runId + ".", err);
    } finally {
      setBusy(runId, null);
      load();
    }
  }

  // The run under an open confirmation changed in another tab: the dialog must not delete blind.
  function watchDialog(models) {
    if (!dialog || dialog.locked || !dialog.handle) return;
    const model = models.get(dialog.runId);
    const reason = model ? model.actions.delete : "This run is no longer in the list. It may have been deleted in another tab.";
    if (!reason) return;
    dialog.locked = true;
    dialog.handle.lock(reason);
  }

  // ---------------------------------------------------------------- one row

  // An action that cannot be used stays focusable and says why when it is pressed: a greyed-out
  // button with a hover title would tell a keyboard user nothing.
  function action({ name, label, short = name, iconName, href, run, reason, working, danger }) {
    const classes = ["small", "runs-act", danger && "runs-act-danger"];
    const content = [working ? el("span", "spinner") : icon(iconName), el("span", "runs-act-label", short)];
    if (reason) {
      const text = name + " is not available. " + reason;
      return el("button", {
        type: "button", class: classes, "aria-disabled": "true", title: text, "aria-label": text,
        onclick: () => toast(text, "info"),
      }, content);
    }
    if (href) return link(href, { class: ["btn", ...classes], title: label, "aria-label": label }, content);
    return el("button", { type: "button", class: classes, title: label, "aria-label": label, disabled: working, onclick: run }, content);
  }

  function drawActions(model) {
    const { row, actions, exporting } = model;
    const id = row.run_id;
    const working = busy.get(id) || null;
    return el("div", "row tight runs-actions",
      link(paths.run(id), { class: "btn small runs-open" }, "Open"),
      action({ name: "Submission", label: "Submission: validate, freeze and download", iconName: "list", href: paths.submit(id) }),
      action({
        name: "Replay", label: "Replay the first panorama step by step", iconName: "play",
        run: () => replay(id), reason: actions.replay, working: working === "replay",
      }),
      action({
        name: "Rebuild exports", label: exporting ? "The exports are being rebuilt" : "Rebuild the exports from the logs",
        short: "Rebuild", iconName: "refresh",
        run: () => rebuild(id), reason: actions.rebuild, working: working === "rebuild" || exporting,
      }),
      action({
        name: "Download", label: "Download the submission zip", short: "Zip", iconName: "download",
        run: () => download(id), reason: actions.download, working: working === "download",
      }),
      action({
        name: "Duplicate", label: "Duplicate settings into a new run", iconName: "copy",
        href: paths.newRun({ from: id }), reason: actions.duplicate,
      }),
      action({
        name: "Delete", label: "Delete this run", iconName: "trash", danger: true,
        run: () => askDelete(id), reason: actions.delete, working: working === "delete",
      }));
  }

  function drawNote(model) {
    const { row, note, error } = model;
    const parts = [];
    if (note) {
      let button = null;
      if (note.action === "recover") {
        button = link(paths.submit(row.run_id), { class: "btn small primary" }, icon("refresh"), "Recover and export");
      } else if (note.action === "submission") {
        button = link(paths.submit(row.run_id), { class: "btn small" }, icon("list"), "Open Submission");
      }
      parts.push(el("div", "notice runs-note notice-" + note.tone,
        icon(NOTE_ICON[note.tone] || "info"),
        el("div", "grow",
          el("div", null, note.text),
          note.problems.length
            ? el("ul", "runs-problems", note.problems.map((line) => el("li", "wrap-any", line)),
              note.more ? el("li", "dim", "and " + note.more + " more") : null)
            : null),
        button));
    }
    if (error) {
      parts.push(el("div", { class: "notice notice-bad runs-note", role: "alert" },
        icon("alert"),
        el("div", "grow pre", error),
        el("button", {
          type: "button", class: "small ghost",
          onclick: () => {
            rowErrors.delete(row.run_id);
            render();
          },
        }, "Dismiss")));
    }
    return parts;
  }

  function createRow() {
    const cells = {};
    const main = el("tr", "runs-row");
    for (const column of COLUMNS) {
      const td = el("td", { class: ["runs-c-" + column.key, column.right && "r"] });
      cells[column.key] = { td, sig: null };
      main.append(td);
    }
    const noteCell = el("td", { colSpan: COLUMNS.length });
    const noteRow = el("tr", { class: "runs-note-row", hidden: true }, noteCell);
    const body = el("tbody", "runs-body", main, noteRow);
    const clock = el("span", "num");
    cells.time.td.append(clock);
    let noteSig = null;
    let shownRow = null;

    function paint(key, sig, draw) {
      const cell = cells[key];
      if (cell.sig === sig) return;
      cell.sig = sig;
      replace(cell.td, draw());
    }

    function tick(nowMs) {
      if (!shownRow) return;
      const seconds = rowSeconds(shownRow, nowMs);
      const text = seconds === null ? "–" : fmtClock(seconds);
      if (clock.textContent !== text) clock.textContent = text;
    }

    function update(model, nowMs) {
      const { row, info, actions } = model;
      const id = row.run_id;
      const totals = row.totals || {};
      shownRow = row;
      main.dataset.state = row.state || "";
      main.classList.toggle("runs-active", Boolean(row.active));

      paint("run", sigOf(id, row.fake_model, row.submitted_at, row.kind, row.preset, row.model), () => {
        const demo = row.fake_model ? badge("DEMO", "warn", "info") : null;
        if (demo) demo.title = "Made by the scripted demo model: these answers are not real.";
        const submitted = row.submitted_at ? badge("submitted", "ok", "check") : null;
        if (submitted) submitted.title = "Marked as submitted at " + fmtDateTime(row.submitted_at);
        return [
          el("div", "row wrap tight",
            link(paths.run(id), { class: "mono strong runs-id", title: "Open the dashboard of this run" }, id),
            demo, submitted),
          el("div", "dim xsmall", describeKind(row), row.model ? [" · ", el("span", "nowrap", row.model)] : null),
        ];
      });

      const mode = modeInfo(row);
      paint("mode", sigOf(mode.text), () => {
        const node = badge(mode.text, mode.kind, mode.icon);
        node.title = mode.title;
        return node;
      });

      const waiting = row.active ? row.pending_mcqs || 0 : 0;
      paint("state", sigOf(info, waiting), () => [
        statusBadge(info.status),
        info.detail ? el("div", { class: ["xsmall", "runs-detail", info.tone ? info.tone + "-text" : "dim"] }, info.detail) : null,
        waiting
          ? el("div", "runs-detail", link(paths.run(id), { title: "Open the dashboard to answer" },
            badge(plural(waiting, "MCQ") + " waiting", "awaiting_mcq", "question")))
          : null,
      ]);

      const done = totals.done ?? 0;
      const total = totals.total ?? 0;
      paint("panoramas", sigOf(done, total, row.special_present, row.active), () => {
        const star = row.special_present
          ? el("span", { class: "runs-special", title: "The Special One is in this run" }, icon("star"), el("span", "sr-only", "Special One present"))
          : null;
        const bar = row.active && total
          ? el("div", "progress runs-progress", el("div", { class: "progress-fill", style: { width: Math.round((done / total) * 100) + "%" } }))
          : null;
        return [el("div", "row tight runs-count-line", star, el("span", "num", done + "/" + total)), bar];
      });

      paint("spend", sigOf(fmtUsd(totals.spend_usd), row.active && totals.spend_cap_usd), () => {
        const node = el("span", "num", fmtUsd(totals.spend_usd));
        if (row.active && totals.spend_cap_usd) node.title = "Spend cap of this run: " + fmtUsd(totals.spend_cap_usd);
        return node;
      });

      const multiplier = fmtMult(totals.lowest_multiplier);
      const penalties = penaltyParts(totals.penalties);
      paint("multiplier", sigOf(multiplier, penalties), () => [
        el("div", "mono", multiplier),
        // Each kind stays whole; three of them break onto a second line instead of widening the table.
        el("div", "dim xsmall runs-penalties", penalties.length
          ? penalties.map((part, index) => [index ? ", " : null, el("span", "nowrap", part)])
          : "no penalties"),
      ]);

      clock.title = row.active ? "Time on the run clock, counting" : "From the first event of the run to its last";
      tick(nowMs);

      const scored = truthVisible(row);
      paint("score", sigOf(scored, scored && row.results.score_share, scored && row.results.median_rank1_m), () => {
        if (!scored) {
          return el("span", { class: "dim", title: row.kind === "eval" ? "Not scored yet" : "Only evaluation runs have ground truth" }, "–");
        }
        return [
          el("div", "num strong", link(paths.evaluation({ tab: "results", run: id }), { title: "Open the results of this evaluation run" },
            fmtPct(row.results.score_share, 1))),
          el("div", "dim xsmall num", "median " + fmtDist(row.results.median_rank1_m)),
        ];
      });

      paint("created", sigOf(row.created_at), () => {
        const [date, time] = fmtDateTime(row.created_at).split(" ");
        return el("div", { class: "num", title: String(row.created_at || "") },
          el("div", null, date), time ? el("div", "dim xsmall", time) : null);
      });

      paint("actions", sigOf(actions, busy.get(id) || null, model.exporting), () => drawActions(model));

      const sig = sigOf(model.note, model.error, id);
      if (sig !== noteSig) {
        noteSig = sig;
        const parts = drawNote(model);
        noteRow.hidden = parts.length === 0;
        replace(noteCell, parts);
      }
    }

    return { body, update, tick };
  }

  function createSeparator() {
    const label = el("span");
    const count = el("span", "num dim");
    const body = el("tbody", "runs-sep", el("tr", null, el("th", { colSpan: COLUMNS.length, scope: "rowgroup" }, label, " ", count)));
    return {
      body,
      update(item) {
        label.textContent = item.label;
        count.textContent = String(item.count);
      },
      tick() {},
    };
  }

  // Keyed update of the table bodies: a row that is still there keeps its nodes, so focus and
  // hover survive a list that redraws while a run is going.
  function syncBodies(items, nowMs) {
    let previous = thead;
    const seen = new Set();
    for (const item of items) {
      let entry = bodies.get(item.key);
      if (!entry) {
        entry = item.separator ? createSeparator() : createRow();
        bodies.set(item.key, entry);
      }
      entry.update(item.separator ? item : item.model, nowMs);
      if (previous.nextSibling !== entry.body) table.insertBefore(entry.body, previous.nextSibling);
      previous = entry.body;
      seen.add(item.key);
    }
    for (const [key, entry] of bodies) {
      if (seen.has(key)) continue;
      entry.body.remove();
      bodies.delete(key);
    }
  }

  // ---------------------------------------------------------------- rendering

  function renderStatus() {
    replace(refreshMark, loading ? el("span", "spinner") : icon("refresh"));
    refreshButton.disabled = loading;
    updated.textContent = fetchedAt ? "Updated " + fmtTime(fetchedAt) : "";
    const parts = [];
    if (fetchError) {
      const lead = fetched === null
        ? "The runs on disk could not be listed."
        : "The list could not be refreshed; it shows what was loaded at " + fmtTime(fetchedAt) + ".";
      parts.push(el("div", { class: "notice notice-bad", role: "alert" },
        icon("alert"),
        el("div", "grow", el("div", "strong", lead), el("div", "pre", errorText(fetchError))),
        el("button", { type: "button", class: "small", disabled: loading, onclick: () => load() }, icon("refresh"), "Try again")));
    } else if (fetched === null) {
      parts.push(el("div", { class: "notice", role: "status" }, el("span", "spinner"), el("span", null, "Loading the runs on disk…")));
    }
    replace(status, parts);
  }

  function renderFilters(counts) {
    for (const [filter, key] of [[kindFilter, "kind"], [stateFilter, "state"]]) {
      for (const [value, { button, count }] of filter.buttons) {
        button.setAttribute("aria-pressed", String(view[key] === value));
        count.textContent = String(counts[key][value] ?? 0);
      }
    }
    clearButton.hidden = !isFiltered(view);
    if (search.value !== view.q && document.activeElement !== search) search.value = view.q;
  }

  function renderEmpty(all, shown) {
    if (shown.length) {
      empty.hidden = true;
      empty.dataset.kind = "";
      return;
    }
    empty.hidden = false;
    // Until the first answer nobody knows whether there are runs: the loading line speaks for now.
    const kind = all.length ? "filtered" : fetched === null ? "waiting" : "first";
    const fake = Boolean(store.state.health && store.state.health.fake_model);
    const sig = kind + (kind === "first" && fake ? ":demo" : "");
    if (empty.dataset.kind === sig) return;
    empty.dataset.kind = sig;
    if (kind === "first") replace(empty, welcome(fake));
    else if (kind === "filtered") {
      replace(empty, el("div", "card", el("div", "empty",
        el("div", "empty-title", "No run matches these filters"),
        el("p", null, "Runs exist, but none has this kind, state and id together."),
        el("button", {
          type: "button",
          onclick: () => {
            search.value = "";
            setView({ kind: "all", state: "all", q: "" });
          },
        }, icon("x"), "Clear filters"))));
    } else replace(empty);
  }

  function render() {
    if (!alive) return;
    const now = Date.now();
    const liveRuns = Array.from(store.state.runs.values());
    const all = mergeRows(fetched, liveRuns, hidden);
    const shown = sortRows(filterRows(all, view), view, now);
    const groups = groupRows(shown);
    const exporting = exportingRuns(store.state.jobs.values());

    currentRows = new Map(all.map((row) => [row.run_id, row]));
    const models = new Map();
    const modelOf = (row) => {
      const model = {
        row,
        info: stateInfo(row),
        note: rowNote(row),
        actions: rowActions(row, { exportJob: exporting.has(row.run_id) }),
        exporting: exporting.has(row.run_id),
        error: rowErrors.get(row.run_id) || null,
      };
      models.set(row.run_id, model);
      return model;
    };
    for (const row of all) modelOf(row);
    // An error belongs to a row; when the row has gone there is nothing left to show it on.
    for (const id of Array.from(rowErrors.keys())) if (!currentRows.has(id)) rowErrors.delete(id);

    const items = [];
    const both = groups.active.length > 0 && groups.rest.length > 0;
    if (both) items.push({ key: "sep:active", separator: true, label: "Active now", count: groups.active.length });
    for (const row of groups.active) items.push({ key: "run:" + row.run_id, model: models.get(row.run_id) });
    if (both) items.push({ key: "sep:rest", separator: true, label: "Earlier", count: groups.rest.length });
    for (const row of groups.rest) items.push({ key: "run:" + row.run_id, model: models.get(row.run_id) });

    summary.textContent = summaryText(all, shown);
    renderStatus();
    renderFilters(filterCounts(all, view));
    for (const [key, th] of headCells) {
      const column = COLUMNS.find((c) => c.key === key);
      if (!column.sort) continue;
      if (view.sort === column.sort) th.setAttribute("aria-sort", view.dir === "asc" ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    }
    filters.hidden = all.length === 0;
    tableWrap.hidden = shown.length === 0;
    syncBodies(items, now);
    renderEmpty(all, shown);
    // /legacy only answers for a run this server holds that is not an evaluation run.
    legacy.hidden = !liveRuns.some((run) => run.owned !== false && run.kind !== "eval");
    watchDialog(models);
  }

  // ---------------------------------------------------------------- wiring

  const offs = [
    store.subscribe(() => {
      if (storeTimer !== null) return;
      storeTimer = setTimeout(() => {
        storeTimer = null;
        render();
      }, STORE_RENDER_MS);
    }),
    store.on("index", () => load()),
    store.on("run", (msg) => { if (msg && msg.removed) load(); }),
    // A reconnect may have missed an index message. Polled snapshots (stream down) are skipped:
    // they arrive every few seconds and say nothing about the runs on disk.
    store.on("snapshot", (info) => { if (info && info.fromStream) load(); }),
    shortcuts.register("Runs", {
      "/": { label: "Search runs by id", run: () => { search.focus(); search.select(); } },
    }),
  ];
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const entry of bodies.values()) entry.tick(now);
  }, 1000);

  render();
  load();

  return {
    unmount() {
      alive = false;
      for (const off of offs) off();
      clearInterval(ticker);
      clearTimeout(storeTimer);
      storeTimer = null;
      pushQuery.cancel();
      if (controller) controller.abort();
      downloads.abort();
      for (const stop of Array.from(jobWatches.values())) stop();
      for (const [timer, url] of revokes) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      revokes.clear();
      if (dialog && dialog.handle && confirmDialog.current === dialog.handle) dialog.handle.close();
      dialog = null;
      bodies.clear();
    },
    onQuery(query) {
      const next = parseView(query);
      // Our own setQuery comes back here; only a real change (back button, pasted link) is adopted.
      if (sigOf(viewQuery(next)) === sigOf(viewQuery(view))) return;
      view = next;
      search.value = view.q;
      render();
    },
  };
}
