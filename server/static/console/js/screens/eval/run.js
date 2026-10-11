// Evaluation, Run tab (UI-SPEC 5.9 "Run"): launch an evaluation run, and the list of the
// evaluation runs on disk. Replaces `eval run`.
//
// An evaluation run is always autonomous: nothing on this tab reaches the agent except the
// settings a run is launched with (effort, hedge, web, tools), which say nothing about a place.

import { api, errorText, newKey } from "../../api.js";
import { confirmDialog, toast } from "../../components/shell.js";
import { badge, clear, debounce, el, icon, replace, statusBadge } from "../../dom.js";
import { fmtDateTime, fmtDist, fmtDuration, fmtInt, fmtPct, fmtUsd, plural } from "../../format.js";
import {
  DEMO_NOTE,
  EFFORTS,
  MAX_CONCURRENCY,
  canReuseKey,
  defaultEffortText,
  evalRuns,
  initialRunForm,
  launchState,
  overlayLive,
  pastEstimate,
  readRunForm,
  runListView,
  toggleTool,
  toolSwitches,
} from "../../logic/evalstats.js";
import { link, navigate, paths } from "../../router.js";
import { store } from "../../store.js";

const CONTEXT_URL = "/api/launch/context";
const ESTIMATE_URL = "/api/eval/runs/estimate";
const LAUNCH_URL = "/api/eval/runs";
const RUNS_URL = "/api/runs";

function demoBadge() {
  const node = badge("DEMO", "warn", "alert");
  node.title = DEMO_NOTE;
  return node;
}

export function mountTab(container, ctx) {
  let unmounted = false;
  const offs = [];

  let context = null; // GET /api/launch/context
  let contextError = null;
  let contextLoading = false;
  let form = initialRunForm(null);

  let estimate = null; // the answer of /estimate for `estimatedFor`
  let estimatedFor = null; // JSON of the body the estimate was made for
  let estimateError = null;
  let estimating = false;
  let estimateAbort = null;

  let launching = false;
  let launchError = null;
  let lastAttempt = null; // {bodyJson, key, status}: see canReuseKey
  let dialog = null; // the confirm dialog this tab opened, to close it on unmount

  let runs = null; // RunRows of kind eval
  let runsError = null;
  let runsLoading = false;
  let runsAbort = null;
  let runsShown = ""; // what the table was last drawn from, so a store tick does not redraw it

  // ------------------------------------------------------------ skeleton

  const contextHost = el("div", "stack eval-run-context");
  const fields = buildForm();
  const launch = buildLaunch();
  const runsHost = el("div", "stack eval-run-list");
  const refreshRuns = el("button", {
    type: "button", class: "ghost small", title: "Read the runs from disk again", onclick: () => loadRuns(),
  }, icon("refresh"), "Refresh");

  container.append(
    el("div", "stack loose",
      el("div", "stack",
        el("div", "row spread eval-tab-head", el("h2", "eval-tab-title", "Run an evaluation")),
        el("p", "dim eval-run-intro",
          "Runs the agent over the evaluation set with the human channels off and scores every answer against ",
          "the known coordinates when the run ends. Progress is on the run's dashboard."),
        contextHost),
      el("div", "eval-run-grid", fields.node, launch.node),
      el("section", { class: "stack", "aria-labelledby": "eval-run-list-title" },
        el("div", "row spread eval-tab-head",
          el("h2", { class: "eval-tab-title", id: "eval-run-list-title" }, "Evaluation runs"),
          refreshRuns),
        runsHost)));

  // ------------------------------------------------------------ the form

  // Built once and updated in place: an estimate arriving must not take the caret away.
  function buildForm() {
    const effort = el("select", { id: "eval-run-effort", onchange: () => change({ effort: effort.value }) });
    const hedge = el("input", { type: "checkbox", onchange: () => change({ hedge: hedge.checked }) });
    const web = el("input", { type: "checkbox", onchange: () => change({ web: web.checked }) });
    const limit = el("input", {
      type: "number", inputmode: "numeric", min: "1", step: "1", class: "num", placeholder: "all",
      oninput: () => change({ limit: limit.value }),
    });
    const concurrency = el("input", {
      type: "number", inputmode: "numeric", min: "1", max: String(MAX_CONCURRENCY), step: "1", class: "num",
      oninput: () => change({ concurrency: concurrency.value }),
    });
    const runId = el("input", {
      type: "text", class: "mono", autocomplete: "off", spellcheck: false, placeholder: "generated",
      oninput: () => change({ runId: runId.value }),
    });
    const errors = {
      limit: el("span", { class: "field-error", role: "alert" }),
      concurrency: el("span", { class: "field-error", role: "alert" }),
      runId: el("span", { class: "field-error", role: "alert" }),
    };
    const wraps = {
      limit: el("label", "field", el("span", "field-label", "Limit to the first N panoramas"), limit,
        el("span", "field-help", "Empty runs the whole set, in manifest order."), errors.limit),
      concurrency: el("label", "field", el("span", "field-label", "Concurrency"), concurrency,
        el("span", "field-help", "Panoramas in parallel, 1 to " + MAX_CONCURRENCY + "."), errors.concurrency),
      runId: el("label", "field", el("span", "field-label", "Run id"), runId,
        el("span", "field-help", "Empty uses the UTC time. An evaluation run needs a directory of its own."), errors.runId),
    };
    const tools = el("div", { class: "eval-run-tools", role: "group", "aria-labelledby": "eval-run-tools-title" });
    const toolsNote = el("span", "dim small");
    const node = el("section", { class: "card stack eval-run-form", "aria-labelledby": "eval-run-form-title" },
      el("h3", { class: "card-title", id: "eval-run-form-title" }, "Configuration"),
      el("div", "eval-run-fields",
        el("label", "field", el("span", "field-label", "Effort"), effort,
          el("span", "field-help", "Overrides the effort of every panorama's budget.")),
        wraps.limit, wraps.concurrency, wraps.runId),
      el("div", "eval-run-switches",
        el("div", "stack tight",
          el("label", "check", hedge, el("span", "strong", "Hedge")),
          el("span", "field-help", "Split the ten entries between the top two hypotheses when they are close.")),
        el("div", "stack tight",
          el("label", "check", web, el("span", "strong", "Web")),
          el("span", "field-help", "Off switches every external tool off (organiser question Q1)."))),
      el("div", "stack tight",
        el("div", "row wrap", el("h4", { class: "section-title", id: "eval-run-tools-title" }, "Tools"), toolsNote),
        el("p", "field-help", "Untick a tool to run without it and see what it is worth. The two tools of the answer path stay on."),
        tools),
      el("div", "notice notice-info eval-run-fixed", icon("lock"),
        el("div", null,
          el("strong", null, "Human channels: off. "),
          "MCQ, cue and geocode are disabled for an evaluation run and cannot be switched on here.")));
    return { node, effort, hedge, web, limit, concurrency, runId, errors, wraps, tools, toolsNote, toolBoxes: new Map() };
  }

  function change(values) {
    form = { ...form, ...values };
    launchError = null;
    renderForm();
    // The estimate on screen is for another form now: hold the launch until the new one is in.
    estimating = true;
    renderLaunch();
    requestEstimate();
  }

  function renderForm() {
    const ready = Boolean(context);
    const locked = !ready || launching;
    const f = fields;
    if (f.effort.options.length !== EFFORTS.length + 1 || f.effort.options[0].textContent !== defaultEffortText(context)) {
      replace(f.effort,
        el("option", { value: "" }, defaultEffortText(context)),
        EFFORTS.map((name) => el("option", { value: name }, name)));
    }
    f.effort.value = form.effort;
    f.effort.disabled = locked;
    f.hedge.checked = form.hedge;
    f.hedge.disabled = locked;
    f.web.checked = form.web;
    f.web.disabled = locked;
    // Never write back into the field the operator is typing in.
    for (const [key, input] of [["limit", f.limit], ["concurrency", f.concurrency], ["runId", f.runId]]) {
      if (document.activeElement !== input && input.value !== form[key]) input.value = form[key];
      input.disabled = locked;
    }
    const { errors } = readRunForm(form, context ? context.tools : null);
    for (const key of Object.keys(f.errors)) {
      f.wraps[key].classList.toggle("invalid", Boolean(errors[key]));
      f.errors[key].textContent = errors[key] || "";
    }
    renderTools(locked);
  }

  function renderTools(locked) {
    const f = fields;
    const switches = toolSwitches(context ? context.tools : [], form);
    if (!switches.length) {
      f.toolBoxes.clear();
      replace(f.tools, el("span", "dim small", context ? "The server lists no tool." : "Waiting for the tool list."));
      f.toolsNote.textContent = "";
      return;
    }
    if (f.toolBoxes.size !== switches.length || switches.some((item) => !f.toolBoxes.has(item.name))) {
      f.toolBoxes.clear();
      replace(f.tools, switches.map((item) => {
        const box = el("input", {
          type: "checkbox",
          onchange: () => change({ toolsOff: toggleTool(form.toolsOff, item.name, box.checked) }),
        });
        const note = el("span", "field-help eval-run-tool-note");
        const lock = el("span", { class: "eval-run-tool-lock", hidden: true }, icon("lock"));
        f.toolBoxes.set(item.name, { box, note, lock });
        return el("div", "eval-run-tool", el("label", "check", box, el("span", "mono", item.name), lock), note);
      }));
    }
    let off = 0;
    for (const item of switches) {
      const parts = f.toolBoxes.get(item.name);
      parts.box.checked = item.on;
      parts.box.disabled = item.locked || locked;
      parts.lock.hidden = !item.locked;
      parts.note.textContent = item.note;
      if (!item.on) off += 1;
    }
    f.toolsNote.textContent = off ? plural(off, "tool") + " off" : "all on";
  }

  // ------------------------------------------------------------ launch context

  async function loadContext() {
    contextLoading = true;
    renderContext();
    try {
      const next = await api.get(CONTEXT_URL);
      if (unmounted) return;
      const first = !context;
      context = next;
      contextError = null;
      if (first) form = initialRunForm(context);
    } catch (err) {
      if (unmounted) return;
      contextError = err;
    } finally {
      contextLoading = false;
      if (!unmounted) {
        renderContext();
        renderForm();
        renderLaunch();
        if (context) estimateNow();
      }
    }
  }

  function renderContext() {
    const items = [];
    if (contextError) {
      items.push(el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight grow",
          el("strong", null, context
            ? "The launch settings could not be read again. What is shown may be out of date."
            : "The launch settings could not be read, so a run cannot be configured."),
          el("span", "pre", errorText(contextError))),
        el("button", { type: "button", class: "small", onclick: () => loadContext() }, icon("refresh"), "Try again")));
    } else if (contextLoading && !context) {
      items.push(el("p", "dim row", el("span", "spinner"), "Reading the launch settings…"));
    }
    if (context && context.fake_model) {
      items.push(el("div", "notice notice-warn", icon("alert"),
        el("div", null,
          el("strong", null, "The scripted demo model is active. "),
          "A run launched now calls no API and costs nothing. Its answers are scripted, so it is marked DEMO and its numbers are not meaningful.")));
    }
    replace(contextHost, items);
  }

  // ------------------------------------------------------------ estimate

  const requestEstimate = debounce(() => estimateNow(), 250);

  async function estimateNow() {
    requestEstimate.cancel();
    if (estimateAbort) estimateAbort.abort();
    estimateAbort = null;
    if (unmounted || !context) return;
    const { body, errors } = readRunForm(form, context.tools);
    if (Object.keys(errors).length) {
      estimating = false;
      estimate = null;
      estimatedFor = null;
      estimateError = null;
      renderLaunch();
      return;
    }
    const abort = new AbortController();
    estimateAbort = abort;
    estimating = true;
    renderLaunch();
    const bodyJson = JSON.stringify(body);
    try {
      // No side effect, so no idempotency key: every call is a fresh question.
      const answer = await api.post(ESTIMATE_URL, body, { key: false, signal: abort.signal, timeoutMs: 20000 });
      if (unmounted || estimateAbort !== abort) return;
      estimate = answer;
      estimatedFor = bodyJson;
      estimateError = null;
    } catch (err) {
      if (unmounted || estimateAbort !== abort || (err && err.name === "AbortError")) return;
      estimate = null;
      estimatedFor = null;
      estimateError = err;
    }
    if (estimateAbort === abort) {
      estimateAbort = null;
      estimating = false;
      renderLaunch();
    }
  }

  // ------------------------------------------------------------ launch panel

  function buildLaunch() {
    const numbers = el("div", "eval-run-numbers");
    const notes = el("div", "stack tight eval-run-notes");
    const reasons = el("div", { class: "stack tight eval-run-reasons", role: "status" });
    const go = el("button", { type: "button", class: "primary eval-run-go", onclick: () => startLaunch() });
    const errorHost = el("div", "eval-run-error");
    const node = el("section", { class: "card stack eval-run-launch", "aria-labelledby": "eval-run-launch-title" },
      el("h3", { class: "card-title", id: "eval-run-launch-title" }, "Before you launch"),
      numbers, notes, reasons,
      el("div", "row wrap", go),
      errorHost);
    return { node, numbers, notes, reasons, go, errorHost };
  }

  function currentRequest() {
    const { body, errors } = readRunForm(form, context ? context.tools : null);
    const fresh = estimatedFor === JSON.stringify(body) && !estimating;
    const state = launchState({
      context,
      contextError,
      estimate: fresh ? estimate : null,
      estimateError: estimating ? null : estimateError,
      estimating: estimating || !fresh,
      errors,
      launching,
    });
    return { body, errors, state, fresh };
  }

  function kpi(value, label, help) {
    return el("div", "eval-kpi",
      el("div", "eval-kpi-value num", value),
      el("div", "eval-kpi-label caps dim", label),
      help ? el("div", "dim small", help) : null);
  }

  function renderLaunch() {
    if (unmounted) return;
    const { state, fresh } = currentRequest();
    const shown = fresh ? estimate : null;
    const fake = Boolean(context && context.fake_model);
    const waiting = el("span", "row tight dim", el("span", "spinner"), "checking");

    replace(launch.numbers,
      kpi(shown ? fmtInt(shown.panoramas) : estimating ? waiting : "–", shown && shown.panoramas === 1 ? "panorama" : "panoramas",
        "of the evaluation set, in manifest order"),
      kpi(shown ? fmtUsd(shown.cost_ceiling_usd) : estimating ? waiting.cloneNode(true) : "–", "cost ceiling",
        fake ? "the sum of the spend caps; the demo model spends nothing" : "the most this run can cost: the sum of the spend caps"));

    const notes = [];
    if (context && !fake) {
      notes.push(el("div", "notice notice-warn", icon("alert"),
        el("div", null,
          el("strong", null, "This run costs money. "),
          "Every panorama calls the model until it answers or reaches its spend cap. The ceiling above is the most it can cost.")));
    }
    const past = shown ? pastEstimate(context && context.estimates, shown.panoramas) : null;
    if (past) {
      notes.push(el("p", "dim small",
        "Past evaluation runs cost " + fmtUsd(past.per_panorama_usd) + " per panorama on average (" + plural(past.runs, "run") + "), which would make this one about ",
        el("span", "num strong", fmtUsd(past.usd)), "."));
    }
    if (shown && shown.unconfirmed_labels > 0 && !shown.todo_labels) {
      notes.push(el("div", "notice notice-info", icon("info"),
        el("div", "stack tight grow",
          el("span", null,
            plural(shown.unconfirmed_labels, "label") + " of these " + (shown.unconfirmed_labels === 1 ? "is a guess" : "are guesses") +
            " nobody has confirmed. The run can start, but a wrong guess scores that panorama on the wrong distance scale."),
          el("div", "row", el("button", { type: "button", class: "small", onclick: () => ctx.setTab("label") }, "Review labels")))));
    }
    if (state.noKey) {
      notes.push(el("div", { class: "notice notice-bad", role: "alert" }, icon("key"),
        el("div", "stack tight grow",
          el("span", null,
            el("strong", null, "There is no OpenAI key. "),
            "Every panorama would get the fallback answer, so the results would say nothing about the agent."),
          el("div", "row", link(paths.settings("keys"), { class: "btn small" }, icon("settings"), "Open Settings, Keys")))));
    }
    replace(launch.notes, notes);

    const lines = [];
    if (estimateError && !estimating) {
      lines.push(el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight grow",
          el("strong", null, estimateError.status === 422
            ? "The server does not accept these settings."
            : "The evaluation set could not be checked."),
          el("span", "pre", errorText(estimateError))),
        el("button", { type: "button", class: "small", onclick: () => estimateNow() }, icon("refresh"), "Check again")));
    } else if (shown && Array.isArray(shown.blocking) && shown.blocking.length) {
      // The panel is narrow: the way out goes under the reasons, not beside them.
      lines.push(el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight grow",
          el("strong", null, "This run would be refused:"),
          el("ul", "eval-run-blocking", shown.blocking.map((line) => el("li", null, String(line)))),
          el("div", "row",
            state.needsLabels
              ? el("button", { type: "button", class: "small primary", onclick: () => ctx.setTab("label") }, "Label them")
              : el("button", { type: "button", class: "small", onclick: () => ctx.setTab("set") }, "Open the Set tab")))));
    } else if (state.reasons.length && !launching) {
      lines.push(el("span", "dim small", state.reasons.join(" ")));
    }
    replace(launch.reasons, lines);

    launch.go.disabled = state.blocked;
    launch.go.classList.toggle("danger", state.noKey);
    launch.go.classList.toggle("primary", !state.noKey);
    replace(launch.go, launching ? el("span", "spinner") : icon("play"), state.label + (launching ? "…" : ""));

    if (launchError) {
      const err = launchError;
      const actions = [];
      if (err.code === "todo_labels") {
        actions.push(el("button", { type: "button", class: "small primary", onclick: () => ctx.setTab("label") }, "Label them"));
      } else if (err.code === "openai_key_missing") {
        actions.push(link(paths.settings("keys"), { class: "btn small" }, icon("settings"), "Open Settings, Keys"));
      } else if (err.status === 0 || err.status >= 500) {
        // The same request again with the same key: it was confirmed, and it can only start once.
        actions.push(el("button", { type: "button", class: "small", onclick: () => startLaunch({ confirmed: true }) },
          icon("refresh"), "Try again"));
      }
      replace(launch.errorHost, el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight grow", el("strong", null, "The run did not start."), el("span", "pre", errorText(err))),
        actions));
    } else clear(launch.errorHost);
  }

  function confirmBody(request, shown) {
    const fake = Boolean(context && context.fake_model);
    const model = context && context.defaults && context.defaults.model ? String(context.defaults.model) : "the model";
    const lines = [
      el("p", null,
        "This starts " + plural(shown.panoramas, "panorama") + " of the evaluation set" +
        (request.effort ? " at effort " + request.effort : "") + ", " + request.concurrency + " at a time, with the human channels off."),
    ];
    if (fake) {
      lines.push(el("p", null, "The scripted demo model answers: no API is called and nothing is spent. The run is marked DEMO and its numbers are not meaningful."));
    } else if (request.confirm_no_key) {
      lines.push(el("p", "bad-text strong", "There is no OpenAI key: every panorama gets the fallback answer."));
    } else {
      lines.push(el("p", null,
        "It calls " + model + " and costs money: at most ",
        el("strong", "num", fmtUsd(shown.cost_ceiling_usd)), " (the sum of the spend caps)."));
    }
    if (shown.unconfirmed_labels > 0) {
      lines.push(el("p", "dim", plural(shown.unconfirmed_labels, "label") + " of these " +
        (shown.unconfirmed_labels === 1 ? "is an unconfirmed guess." : "are unconfirmed guesses.")));
    }
    lines.push(el("p", "dim", "Results are computed when the run ends. You can watch it on its dashboard and stop it there."));
    return el("div", "stack", lines);
  }

  async function startLaunch({ confirmed = false } = {}) {
    if (launching || unmounted) return;
    const { body, state, fresh } = currentRequest();
    if (state.blocked || !fresh || !estimate) return;
    const shown = estimate;
    const request = state.noKey ? { ...body, confirm_no_key: true } : body;
    const bodyJson = JSON.stringify(request);
    // One key per attempt at this exact run, made when the confirmation opens. A retry after a
    // timeout sends it again, so the run can only start once.
    const reuse = canReuseKey(lastAttempt, bodyJson);
    const key = reuse ? lastAttempt.key : newKey();
    if (!(confirmed && reuse)) {
      const asking = confirmDialog({
        title: state.noKey ? "Launch without an OpenAI key?" : "Launch this evaluation run?",
        body: confirmBody(request, shown),
        okLabel: state.noKey ? "Launch anyway" : "Launch",
        cancelLabel: "Cancel",
        tone: state.noKey ? "danger" : "default",
      });
      dialog = confirmDialog.current;
      const ok = await asking;
      dialog = null;
      if (!ok || unmounted) return;
    }
    launching = true;
    launchError = null;
    renderForm();
    renderLaunch();
    try {
      const answer = await api.post(LAUNCH_URL, request, { key, timeoutMs: 60000 });
      lastAttempt = null;
      if (unmounted) return;
      toast("Evaluation run " + answer.run_id + " started. Results are computed when it ends.", "ok");
      navigate(paths.run(answer.run_id));
    } catch (err) {
      if (unmounted) return;
      lastAttempt = { bodyJson, key, status: err && typeof err.status === "number" ? err.status : 0 };
      launchError = err;
      // The page's picture was out of date: a label went back to TODO, a key was removed, the
      // run id was taken. Read it again so the reasons on screen are the server's.
      if (err && err.code === "openai_key_missing") loadContext();
      else if (err && (err.status === 409 || err.status === 422)) estimateNow();
    } finally {
      launching = false;
      if (!unmounted) {
        renderForm();
        renderLaunch();
      }
    }
  }

  // ------------------------------------------------------------ the runs list

  async function loadRuns({ quiet = false } = {}) {
    if (runsAbort) runsAbort.abort();
    const abort = new AbortController();
    runsAbort = abort;
    runsLoading = true;
    if (!quiet) renderRuns(true);
    try {
      const answer = await api.get(RUNS_URL, { signal: abort.signal });
      if (unmounted || runsAbort !== abort) return;
      runs = evalRuns(answer && answer.runs);
      runsError = null;
    } catch (err) {
      if (unmounted || runsAbort !== abort || (err && err.name === "AbortError")) return;
      runsError = err;
    }
    if (runsAbort === abort) {
      runsAbort = null;
      runsLoading = false;
      renderRuns(true);
    }
  }

  function demoNumber(text, fake) {
    if (!fake) return text;
    return el("span", { class: "eval-demo-num", title: DEMO_NOTE }, text, " ", el("span", "eval-demo-mark", "demo"));
  }

  function runRow(row) {
    const view = runListView(row);
    const open = () => {
      if (view.target === "dashboard") navigate(paths.run(view.run_id));
      else ctx.setTab("results", { run: view.run_id, tag: null, pano: null });
    };
    const stop = (event) => event.stopPropagation();
    const config = [view.model, view.effort ? "effort " + view.effort : null].filter(Boolean).join(", ");
    let score;
    let distance;
    if (view.has_results) {
      score = demoNumber(fmtPct(view.score_share, 1), view.fake);
      distance = demoNumber(fmtDist(view.median_rank1_m), view.fake);
    } else {
      score = el("span", "dim", view.active ? "when it ends" : "not scored");
      distance = el("span", "dim", "–");
    }
    return el("tr", {
      class: "clickable",
      title: view.target === "dashboard" ? "Open the dashboard of this run" : "Open the results of this run",
      onclick: open,
    },
      el("td", null,
        el("div", "row tight wrap",
          el("span", "mono", view.run_id),
          view.fake ? demoBadge() : null,
          view.variants ? el("span", { class: "chip", title: "Rescore variants saved beside the original" }, plural(view.variants, "variant")) : null)),
      el("td", null, statusBadge(view.state)),
      el("td", "r num", view.done === null || view.total === null ? "–" : view.done + "/" + view.total),
      el("td", "eval-run-config", config || "–"),
      el("td", "r num", score),
      el("td", "r num", distance),
      el("td", "r num", fmtUsd(view.spend_usd)),
      el("td", "r num", view.wall_time_s === null ? "–" : fmtDuration(view.wall_time_s)),
      el("td", "num nowrap", fmtDateTime(view.created_at)),
      el("td", { class: "eval-run-actions", onclick: stop },
        el("div", "row tight",
          view.active
            ? link(paths.run(view.run_id), { class: "btn small primary" }, icon("eye"), "Dashboard")
            : el("button", {
              type: "button", class: "small" + (view.has_results ? " primary" : ""),
              onclick: () => ctx.setTab("results", { run: view.run_id, tag: null, pano: null }),
            }, "Results"),
          view.has_results
            ? el("button", {
              type: "button", class: "small", title: "Compare this run with another one or with one of its variants",
              onclick: () => ctx.setTab("compare", { a: view.run_id, b: null, pano: null }),
            }, "Compare")
            : null,
          // A scored run's dashboard is one click further, from its results; this keeps the row short.
          view.active || view.has_results ? null : link(paths.run(view.run_id), { class: "btn small ghost" }, "Dashboard"))));
  }

  function renderRuns(force = false) {
    if (unmounted) return;
    refreshRuns.disabled = runsLoading;
    const rows = runs ? overlayLive(runs, store.state.runs) : null;
    const signature = JSON.stringify([runsLoading && !runs, runsError ? errorText(runsError) : null, rows && rows.map(runListView)]);
    if (!force && signature === runsShown) return;
    runsShown = signature;
    const items = [];
    if (runsError) {
      items.push(el("div", { class: "notice notice-bad", role: "alert" }, icon("alert"),
        el("div", "stack tight grow",
          el("strong", null, rows ? "The runs could not be read again. The list may be out of date." : "The runs could not be read."),
          el("span", "pre", errorText(runsError))),
        el("button", { type: "button", class: "small", onclick: () => loadRuns() }, icon("refresh"), "Try again")));
    }
    if (!rows) {
      if (!runsError) items.push(el("p", "dim row", el("span", "spinner"), "Reading the runs…"));
    } else if (!rows.length) {
      items.push(el("div", "empty panel",
        icon("list", { size: 28 }),
        el("div", "empty-title", "No evaluation run yet"),
        el("p", null, "Launch one above. When it ends, its score and distances appear here and open its results.")));
    } else {
      items.push(el("div", "table-wrap",
        el("table", "table eval-run-table",
          el("thead", null, el("tr", null,
            el("th", { scope: "col" }, "Run"),
            el("th", { scope: "col" }, "State"),
            el("th", { scope: "col", class: "r" }, "Panoramas"),
            el("th", { scope: "col" }, "Configuration"),
            el("th", { scope: "col", class: "r", title: "Total score as a share of the maximum" }, "Score share"),
            el("th", { scope: "col", class: "r", title: "Median distance of the first entry to the truth" }, "Median rank-1"),
            el("th", { scope: "col", class: "r" }, "Spend"),
            el("th", { scope: "col", class: "r" }, "Time"),
            el("th", { scope: "col" }, "Started"),
            el("th", { scope: "col" }, el("span", "sr-only", "Actions")))),
          el("tbody", null, rows.map(runRow)))));
      if (rows.some((row) => row.fake_model)) {
        items.push(el("p", "dim small row tight", demoBadge(), "marks a run answered by the scripted demo model. Its numbers are not meaningful."));
      }
    }
    replace(runsHost, items);
  }

  // The index changes when a run starts, ends, is scored, rescored or deleted.
  const reloadRuns = debounce(() => { if (!unmounted) loadRuns({ quiet: true }); }, 400);
  offs.push(store.on("index", reloadRuns));
  // A run this server owns reports its progress on the stream between two index messages.
  offs.push(store.subscribe(() => renderRuns()));

  renderContext();
  renderForm();
  renderLaunch();
  renderRuns(true);
  loadContext();
  loadRuns();

  return {
    unmount() {
      unmounted = true;
      requestEstimate.cancel();
      reloadRuns.cancel();
      if (estimateAbort) estimateAbort.abort();
      if (runsAbort) runsAbort.abort();
      for (const off of offs) off();
      if (dialog && confirmDialog.current === dialog) dialog.close();
      fields.toolBoxes.clear();
    },
    onQuery() {},
  };
}
