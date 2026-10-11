// New run (UI-SPEC 5.3) at /new: choose a preset, give it panoramas, check what was parsed, set
// the options, launch. With `?run=<run_id>` the same screen adds panoramas to a run that is
// already going (steps 2 and 3 only).
//
// Rule compliance (UI-SPEC 3): nothing typed on this screen reaches the agent. The task values
// (label, capture time, Special One) come from the organisers' files; where the operator sets
// one it is a fixed choice that the server validates and logs with its provenance. Everything
// else is a harness setting.
//
// This module holds the form (in memory, across the steps) and the three server conversations
// that follow it: the launch context, the preflight of the chosen set, and the estimate of an
// evaluation run. The parts under ./new-run/ draw one step each and call back into `c`.

import { api, errorText, runUrl } from "../api.js";
import { toast } from "../components/shell.js";
import { badge, debounce, el, replace } from "../dom.js";
import {
  BUDGET_NAMES, EVAL_FIELDS, effectiveKind, effectiveLiveBudget, effectiveSettings, evalBody, hasChoices,
  launchBlockers, liveReadiness, parseLimit, prefillFromRun, preflightBody, presetOf, pruneChoices, pruneEdits,
  runIdProblem, settingsProblems, stepStates, unreadImageCount,
} from "../logic/launch.js";
import { link, paths, query as currentQuery, reload, setQuery } from "../router.js";
import { store } from "../store.js";
import { createEvalStep } from "./new-run/eval-step.js";
import { createLaunchPanel } from "./new-run/launch-panel.js";
import { createOptions } from "./new-run/options.js";
import { createPreflight } from "./new-run/preflight.js";
import { createPresets } from "./new-run/presets.js";
import { createSources } from "./new-run/sources.js";
import { busyLine, errorNotice, notice, stepCard } from "./new-run/ui.js";

// Long enough that a number being typed is not checked digit by digit.
const CHECK_DEBOUNCE_MS = 220;

const noChoices = () => ({ labels: {}, timestamps: {}, special: undefined });

export function mount(container, params, ctx) {
  let alive = true;
  const abort = new AbortController();
  const addRunId = ctx.query.get("run") || null;
  const fromRunId = addRunId ? null : ctx.query.get("from") || null;

  const c = {
    mode: addRunId ? "add" : "new",
    context: null,
    contextVersion: 0,
    contextLoading: false,
    contextError: null,
    form: {
      preset: null, setId: null, setInfo: null, sourceTab: "upload",
      choices: noChoices(), bulkOn: false, bulkLabel: null,
      edits: {}, liveBudget: undefined, kind: null, runId: "",
      advancedOpen: false, evalEffort: null, evalLimit: null, addRunId,
    },
    formVersion: 0,
    preflight: null,
    preflightVersion: 0,
    preflightLoading: false,
    preflightError: null,
    uploading: false,
    addRun: null,
    addRunError: null,
    estimate: null,
    estimateLoading: false,
    estimateError: null,
  };

  let urlReady = false; // the query string has been read: from here on the form writes it
  let launched = false;
  let prefill = null; // {runId, state: "loading" | "done" | "failed", text}
  let prefillSet = null; // a set taken from the duplicated run: it may be gone by now
  const uploadedHere = new Set(); // sets created by an upload during this visit

  ctx.setTitle(addRunId ? "Add panoramas · " + addRunId : "New run");

  // ---------------------------------------------------------------- derived values

  c.isEval = () => c.mode !== "add" && c.form.preset === "eval";
  c.settings = () => effectiveSettings(c.context, c.form.preset, c.form.edits);
  c.liveBudget = () => effectiveLiveBudget(c.context, c.form.preset, c.form.liveBudget);
  c.kind = () => effectiveKind(c.context, c.form.preset, c.form.kind);
  c.runIdError = () => runIdProblem(c.form.runId);
  c.problems = () => {
    const all = settingsProblems(c.settings(), c.context);
    // An evaluation run sends only a few fields; the rest is the saved defaults, not this form.
    return c.isEval() ? all.filter((problem) => EVAL_FIELDS.includes(problem.field)) : all;
  };
  c.resolved = () => ({ ...c.form, settings: c.settings(), liveBudget: c.liveBudget(), kind: c.kind() });
  c.steps = () => stepStates({
    mode: c.mode, preset: c.form.preset, setId: c.form.setId, preflight: c.preflight,
    preflightError: c.preflightError, uploading: c.uploading,
  });
  c.health = () => store.state.health;
  c.readiness = () => liveReadiness(
    c.context ? c.context.readiness : null,
    store.state.health,
    store.state.everConnected ? store.activeRuns().map((run) => run.run_id) : null,
  );

  // ---------------------------------------------------------------- preflight (A4)

  let filesVersion = 0; // goes up when the set, or the files in it, change
  let rowsVersion = -1; // the filesVersion the rows of c.preflight were read at
  let wantedPreflight = null; // signature of the request the form needs answered
  let preflightToken = 0;
  let preflightAbort = null;

  function budgetsValid() {
    return !c.problems().some((problem) => BUDGET_NAMES.includes(problem.field.split(".")[0]));
  }

  /**
   * The preflight request for the form as it is, or null when there is nothing to ask. The
   * operator's choices are keyed by the panorama ids of the last answer; when the files changed
   * since then those ids may have moved, so the first request goes without the choices
   * (`complete: false`) and a second one follows with the ids it returned.
   */
  function preflightRequest() {
    if (!c.form.setId || c.isEval() || c.uploading) return null;
    if (c.mode !== "add" && (!c.context || !c.form.preset || !budgetsValid())) return null;
    const fresh = Boolean(c.preflight) && rowsVersion === filesVersion;
    const body = preflightBody(c.resolved(), fresh ? c.preflight.rows : []);
    return {
      body,
      complete: fresh || !hasChoices(c.form.choices),
      signature: JSON.stringify([c.form.setId, filesVersion, fresh, body]),
    };
  }

  async function sendPreflight() {
    if (!alive) return;
    const request = preflightRequest();
    if (!request) {
      c.preflightLoading = false;
      update();
      return;
    }
    wantedPreflight = request.signature;
    preflightToken += 1;
    const token = preflightToken;
    const version = filesVersion;
    const setId = c.form.setId;
    if (preflightAbort) preflightAbort.abort();
    preflightAbort = new AbortController();
    c.preflightLoading = true;
    let data;
    try {
      // Changes nothing on the server, so it carries no idempotency key (A4).
      data = await api.post("/api/sets/" + encodeURIComponent(setId) + "/preflight", request.body, {
        key: false, signal: preflightAbort.signal,
      });
    } catch (err) {
      if (!alive || token !== preflightToken || (err && err.name === "AbortError")) return;
      if (err && err.status === 404 && prefillSet === setId) {
        // The run that is being duplicated was launched from a set that has since been deleted.
        prefillSet = null;
        toast("The panoramas of the run you are duplicating are no longer stored. Choose them again in step 2.", "warn");
        selectSet(null, null);
        return;
      }
      c.preflightError = errorText(err);
      c.preflightVersion += 1;
      // Whatever ids the choices were keyed by are not to be trusted after a refusal. The same
      // question is not asked again by itself: "Check again", or a change to the form, does that.
      rowsVersion = -1;
      const again = preflightRequest();
      wantedPreflight = again ? again.signature : null;
      c.preflightLoading = false;
      update();
      return;
    }
    if (!alive || token !== preflightToken) return;
    c.preflight = data;
    c.preflightVersion += 1;
    c.preflightError = null;
    rowsVersion = version;
    prefillSet = null;
    c.form.choices = pruneChoices(data.rows, c.form.choices);
    if (!c.form.setInfo && data.name) c.form.setInfo = { set_id: setId, name: data.name, kind: data.kind, path: null };
    // Settled only when the form would ask the very same thing again. Otherwise (the choices
    // were held back, or the form moved on while the server was answering) ask once more.
    const next = preflightRequest();
    const settled = Boolean(next) && JSON.stringify(next.body) === JSON.stringify(request.body);
    wantedPreflight = settled ? next.signature : "";
    c.preflightLoading = !settled;
    update();
  }
  const sendPreflightSoon = debounce(sendPreflight, CHECK_DEBOUNCE_MS);

  function syncPreflight() {
    const request = preflightRequest();
    const signature = request ? request.signature : null;
    if (signature === wantedPreflight) return;
    wantedPreflight = signature;
    if (!request) {
      sendPreflightSoon.cancel();
      preflightToken += 1;
      if (preflightAbort) preflightAbort.abort();
      c.preflightLoading = false;
      if (!c.form.setId || c.isEval()) {
        c.preflight = null;
        c.preflightError = null;
      }
      return;
    }
    // Loading from this moment: the launch must not go out on an answer to an older question.
    c.preflightLoading = true;
    sendPreflightSoon();
  }

  c.recheck = () => {
    wantedPreflight = null;
    c.preflightError = null;
    update();
  };

  // ---------------------------------------------------------------- evaluation estimate (A5)

  let wantedEstimate = null;
  let estimateToken = 0;

  function estimateRequest() {
    if (!c.isEval() || !c.context || c.problems().length || c.runIdError()) return null;
    return evalBody(c.resolved());
  }

  async function sendEstimate() {
    if (!alive) return;
    const body = estimateRequest();
    if (!body) {
      c.estimateLoading = false;
      update();
      return;
    }
    wantedEstimate = JSON.stringify(body);
    estimateToken += 1;
    const token = estimateToken;
    c.estimateLoading = true;
    try {
      const data = await api.post("/api/eval/runs/estimate", body, { key: false, signal: abort.signal });
      if (!alive || token !== estimateToken) return;
      c.estimate = data;
      c.estimateError = null;
    } catch (err) {
      if (!alive || token !== estimateToken || (err && err.name === "AbortError")) return;
      c.estimateError = errorText(err);
    }
    c.estimateLoading = false;
    update();
  }
  const sendEstimateSoon = debounce(sendEstimate, CHECK_DEBOUNCE_MS);

  function syncEstimate() {
    if (!c.isEval()) {
      if (wantedEstimate !== null) {
        wantedEstimate = null;
        estimateToken += 1;
        sendEstimateSoon.cancel();
        c.estimate = null;
        c.estimateError = null;
        c.estimateLoading = false;
      }
      return;
    }
    const body = estimateRequest();
    if (!body) return; // a field is being corrected: the last answer stays, the launch is blocked by the field
    const signature = JSON.stringify(body);
    if (signature === wantedEstimate) return;
    wantedEstimate = signature;
    c.estimateLoading = true;
    sendEstimateSoon();
  }

  c.reestimate = () => {
    wantedEstimate = "";
    c.estimateError = null;
    update();
  };

  // ---------------------------------------------------------------- the form

  function selectSet(setId, info) {
    if (c.form.setId === setId) {
      if (info) c.form.setInfo = info;
      update();
      return;
    }
    c.form.setId = setId;
    c.form.setInfo = info || null;
    c.form.choices = noChoices();
    c.form.bulkOn = false;
    c.form.bulkLabel = null;
    c.preflight = null;
    c.preflightError = null;
    c.preflightVersion += 1;
    filesVersion += 1;
    rowsVersion = -1;
    preflightPart.reset();
    update();
  }

  c.adoptSet = (set) => {
    uploadedHere.add(set.set_id);
    selectSet(set.set_id, set);
  };
  c.chooseSet = (setId, set) => selectSet(setId, set || null);
  c.clearSet = () => selectSet(null, null);
  c.describeSet = (set) => {
    const before = c.form.setInfo;
    c.form.setInfo = set;
    // The stored-file counts feed the "images not read" warning of step 3.
    if (!before || before.panoramas !== set.panoramas || before.name !== set.name || before.kind !== set.kind) update();
  };
  c.unreadImages = () => unreadImageCount(c.form.setInfo, c.preflight);
  c.filesStored = (setId) => {
    if (setId !== c.form.setId) return;
    filesVersion += 1;
    update();
  };
  c.setUploading = (flag) => {
    if (c.uploading === Boolean(flag)) return;
    c.uploading = Boolean(flag);
    update();
  };

  c.setLabel = (relPath, label) => {
    const labels = { ...c.form.choices.labels };
    if (label) labels[relPath] = label;
    else delete labels[relPath];
    c.form.choices = { ...c.form.choices, labels };
    update();
  };
  c.setTimestamp = (relPath, timestamp) => {
    const timestamps = { ...c.form.choices.timestamps };
    if (timestamp) timestamps[relPath] = timestamp;
    else delete timestamps[relPath];
    c.form.choices = { ...c.form.choices, timestamps };
    update();
  };
  // A path makes that panorama the Special One; null says "none", against the files if need be.
  c.setSpecial = (relPath) => {
    c.form.choices = { ...c.form.choices, special: relPath };
    update();
  };
  c.setBulk = (on, label) => {
    c.form.bulkOn = Boolean(on);
    c.form.bulkLabel = label || null;
    update();
  };

  function setPreset(name, { announce = true } = {}) {
    if (!presetOf(c.context, name) || name === c.form.preset) return;
    const dropped = Object.keys(c.form.edits).length > 0 || c.form.liveBudget !== undefined || c.form.kind || c.form.evalEffort;
    c.form.preset = name;
    c.form.edits = {};
    c.form.liveBudget = undefined;
    c.form.kind = null;
    c.form.evalEffort = null;
    c.formVersion += 1;
    if (dropped && announce) {
      toast("The settings you had changed were set back to what the " + presetOf(c.context, name).label + " preset gives.", "info");
    }
    update();
  }
  c.setPreset = (name) => setPreset(name);

  c.edit = (key, value) => {
    c.form.edits = pruneEdits(c.context, c.form.preset, { ...c.form.edits, [key]: value });
    update();
  };
  c.editBudget = (name, key, value) => {
    const budget = { ...(c.form.edits[name] || {}), [key]: value };
    c.form.edits = pruneEdits(c.context, c.form.preset, { ...c.form.edits, [name]: budget });
    update();
  };
  c.toggleTool = (name, on) => {
    const off = new Set(c.settings().disabled_tools || []);
    if (on) off.delete(name);
    else off.add(name);
    c.edit("disabled_tools", (c.context.tools || []).map((tool) => tool.name).filter((tool) => off.has(tool)));
  };
  c.setRunId = (value) => {
    c.form.runId = value;
    update();
  };
  c.setKind = (value) => {
    c.form.kind = value;
    update();
  };
  c.setLiveBudget = (on) => {
    const preset = presetOf(c.context, c.form.preset);
    c.form.liveBudget = preset && Boolean(preset.live_budget) === Boolean(on) ? undefined : Boolean(on);
    update();
  };
  c.setEvalEffort = (value) => {
    c.form.evalEffort = value || null;
    update();
  };
  c.setEvalLimit = (value) => {
    c.form.evalLimit = value || null;
    update();
  };
  c.resetEdits = () => {
    c.form.edits = {};
    c.form.liveBudget = undefined;
    c.form.kind = null;
    c.form.evalEffort = null;
    c.formVersion += 1;
    update();
  };

  c.openPrompt = () => optionsPart.openPrompt();
  c.launched = () => { launched = true; };
  // The server said no: what it judged may have changed since the page last asked.
  c.refused = (err) => {
    if (err && (err.code === "openai_key_missing" || err.code === "fake_model_active")) loadContext();
    if (c.isEval()) c.reestimate();
    else c.recheck();
  };

  // ---------------------------------------------------------------- loading

  let contextToken = 0;

  async function loadContext() {
    contextToken += 1;
    const token = contextToken;
    c.contextLoading = true;
    c.contextError = null;
    update();
    try {
      const context = await api.get("/api/launch/context", { signal: abort.signal });
      if (!alive || token !== contextToken) return;
      c.context = context;
      c.contextVersion += 1;
      if (c.form.preset && !presetOf(context, c.form.preset)) c.form.preset = null;
    } catch (err) {
      if (!alive || token !== contextToken || (err && err.name === "AbortError")) return;
      c.contextError = errorText(err);
    }
    c.contextLoading = false;
    if (c.context && !urlReady) await readQuery();
    if (alive) update();
  }
  c.reloadContext = loadContext;

  async function loadAddRun() {
    c.addRunError = null;
    try {
      const run = await store.loadRun(addRunId, { force: true });
      if (!alive) return;
      c.addRun = run;
    } catch (err) {
      if (!alive || (err && err.name === "AbortError")) return;
      c.addRunError = "Run " + addRunId + " could not be read: " + errorText(err);
    }
    update();
  }
  c.reloadAddRun = loadAddRun;

  async function applyPrefill(wantedPreset) {
    prefill = { runId: fromRunId, state: "loading", text: "" };
    renderHead();
    try {
      const run = await api.get(runUrl(fromRunId), { signal: abort.signal });
      if (!alive) return null;
      const filled = prefillFromRun(c.context, run, wantedPreset);
      if (!filled) {
        prefill = { runId: fromRunId, state: "failed", text: "Its settings cannot be copied. The form starts from the saved defaults." };
        return null;
      }
      c.form.preset = filled.preset;
      c.form.edits = filled.edits;
      c.form.liveBudget = filled.liveBudget;
      c.form.kind = filled.kind;
      c.form.evalEffort = filled.evalEffort;
      c.form.evalLimit = filled.evalLimit;
      c.form.advancedOpen = Object.keys(filled.edits).length > 0;
      c.formVersion += 1;
      const changed = Object.keys(filled.edits).length;
      prefill = {
        runId: fromRunId, state: "done",
        text: "Preset " + presetOf(c.context, filled.preset).label + (changed
          ? ", with " + changed + " setting" + (changed === 1 ? "" : "s") + " that differ" + (changed === 1 ? "s" : "") + " from it. Check them in the last step."
          : ", exactly as the preset gives it.")
          + " The run id is new. Labels, capture times and the Special One are read again from the files: choices made in that run's table are not copied.",
      };
      return filled;
    } catch (err) {
      if (!alive || (err && err.name === "AbortError")) return null;
      prefill = { runId: fromRunId, state: "failed", text: errorText(err) + " The form starts from the saved defaults." };
      return null;
    }
  }

  // The query string is read once, when the launch context is known (A1).
  async function readQuery() {
    const q = currentQuery();
    const wantedSet = q.get("set") || null;
    if (c.mode === "add") {
      urlReady = true;
      if (wantedSet) {
        selectSet(wantedSet, null);
        sources.reloadSets();
      }
      return;
    }
    const wantedPreset = q.get("preset");
    const known = wantedPreset && presetOf(c.context, wantedPreset) ? wantedPreset : null;
    if (wantedPreset && !known) toast("There is no preset called \"" + wantedPreset + "\". Choose one in step 1.", "warn");
    let filled = null;
    if (fromRunId) filled = await applyPrefill(known);
    if (!alive) return;
    if (!filled && known) c.form.preset = known;
    const limit = parseLimit(q.get("limit"));
    if (limit) c.form.evalLimit = limit;
    urlReady = true;
    const setId = wantedSet || (filled && filled.setId) || null;
    if (setId && c.form.preset !== "eval") {
      if (!wantedSet) prefillSet = setId;
      selectSet(setId, null);
      sources.reloadSets();
    }
  }

  function syncUrl() {
    if (!urlReady || !alive) return;
    if (c.mode === "add") setQuery({ set: c.form.setId });
    else {
      setQuery({
        preset: c.form.preset,
        set: c.isEval() ? null : c.form.setId,
        limit: c.isEval() ? c.form.evalLimit : null,
      });
    }
  }

  // ---------------------------------------------------------------- page

  const head = el("div", "stack nr-head");
  const presetsPart = createPresets(c);
  const sources = createSources(c);
  const preflightPart = createPreflight(c);
  const evalPart = createEvalStep(c);
  const optionsPart = createOptions(c);
  const launchPart = createLaunchPanel(c);
  const finalStep = stepCard(c.mode === "add" ? "Add to the run" : "Settings and launch");
  finalStep.body.append(c.mode === "add"
    ? el("div", "nr-final nr-final-add", launchPart.el)
    : el("div", "nr-final", optionsPart.el, launchPart.el));
  const steps = el("div", "stack loose nr-steps",
    c.mode === "add" ? null : presetsPart.el, sources.el, preflightPart.el, evalPart.el, finalStep.el);
  replace(container, el("div", "stack loose nr", head, steps));

  let headSeen = null;

  function renderHead() {
    if (!alive) return;
    const add = c.mode === "add";
    const run = c.addRun;
    const now = JSON.stringify([
      run ? [run.kind, run.no_human] : null, Boolean(c.context), Boolean(c.context && c.context.fake_model),
      prefill, c.contextLoading, c.contextError,
    ]);
    if (now === headSeen) return;
    headSeen = now;
    replace(head,
      el("div", "page-head",
        el("h1", "page-title", add ? "Add panoramas" : "New run"),
        add
          ? el("span", "row tight wrap",
            el("span", "dim", "to run"),
            link(paths.run(addRunId), { class: "mono strong" }, addRunId),
            run ? badge(run.kind, "dim") : null,
            run ? badge(run.no_human ? "AUTONOMOUS" : "ASSISTED", "info") : null)
          : el("span", "dim", "Preset, panoramas, check, launch. Nothing typed here is sent to the agent.")),
      add
        ? notice("info",
          "The new panoramas join the run with its frozen settings and start as soon as a slot is free. "
          + "Panoramas already in the run cannot be changed here, and a file that is already in it is skipped.")
        : null,
      prefill && prefill.state === "loading" ? busyLine("Copying the settings of run " + prefill.runId + "…") : null,
      prefill && prefill.state === "done"
        ? notice("info", "Settings copied from run ", link(paths.run(prefill.runId), { class: "mono" }, prefill.runId), ". ", prefill.text)
        : null,
      prefill && prefill.state === "failed"
        ? notice("warn", "Run ", el("span", "mono", prefill.runId), " could not be duplicated. ", prefill.text)
        : null,
      !c.context && c.contextLoading ? busyLine("Loading presets and defaults…") : null,
      !c.context && c.contextError
        ? errorNotice("The presets and defaults could not be loaded: " + c.contextError, { onRetry: loadContext })
        : null);
  }

  function update() {
    if (!alive) return;
    syncPreflight();
    syncEstimate();
    syncUrl();
    renderHead();

    const add = c.mode === "add";
    const evalMode = c.isEval();
    // Without the launch context there is no preset to choose and nothing to check against.
    steps.hidden = !add && !c.context;
    sources.el.hidden = evalMode;
    preflightPart.el.hidden = evalMode;
    evalPart.el.hidden = !evalMode;
    let number = 0;
    for (const part of [add ? null : presetsPart, evalMode ? null : sources, evalMode ? null : preflightPart, evalMode ? evalPart : null]) {
      if (!part) continue;
      number += 1;
      part.step.setNumber(number);
    }
    finalStep.setNumber(number + 1);

    presetsPart.update();
    if (!evalMode) {
      sources.update();
      preflightPart.update();
    } else evalPart.update();
    optionsPart.update();
    launchPart.update();

    const state = c.steps().options;
    let status = "todo";
    if (state.open) {
      const blockers = launchBlockers({
        mode: c.mode, context: c.context, preset: c.form.preset, kind: !add && c.context && c.form.preset ? c.kind() : null,
        setId: c.form.setId, uploading: c.uploading, preflight: c.preflight, preflightLoading: c.preflightLoading,
        preflightError: c.preflightError, estimate: c.estimate, estimateLoading: c.estimateLoading,
        estimateError: c.estimateError, problems: add || !c.form.preset ? [] : c.problems(),
        runIdError: add ? null : c.runIdError(), fakeModel: Boolean(c.context && c.context.fake_model),
        launching: false, addRun: c.addRun,
      });
      status = blockers.length ? "attention" : "done";
    }
    finalStep.setState({ open: state.open, reason: state.reason, status });
  }

  // ---------------------------------------------------------------- outside events

  // Only what this screen draws from the stream: health chips, active runs, the run being added to.
  let streamSeen = "";
  const offStore = store.subscribe(() => {
    if (!alive) return;
    if (addRunId) {
      const live = store.run(addRunId);
      if (live) c.addRun = live;
    }
    const run = c.addRun;
    const now = JSON.stringify([
      store.state.health, store.activeRuns().map((item) => item.run_id),
      run ? [run.state, run.owned, run.kind, run.special_present, run.totals && run.totals.total, run.totals && run.totals.done] : null,
    ]);
    if (now === streamSeen) return;
    streamSeen = now;
    update();
  });

  // The form is kept across a server restart (main.js does not remount this screen); what the
  // server told us before is not.
  const offSnapshot = store.on("snapshot", ({ bootChanged }) => {
    if (!alive || !bootChanged) return;
    toast("The server restarted. Your form is kept; readiness and the panorama check are being refreshed.", "info");
    loadContext();
    sources.refresh();
    if (addRunId) loadAddRun();
    if (c.isEval()) c.reestimate();
    else c.recheck();
  });

  // Reloading or closing the tab keeps the uploaded set (it is stored), but not the choices made
  // in the table. Uploads still in flight are guarded by the sources part itself.
  const onBeforeUnload = (event) => {
    if (launched || !c.form.setId || !uploadedHere.has(c.form.setId)) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  if (addRunId) {
    // Adding to a run does not wait for the launch context: only the readiness list needs it.
    readQuery();
    loadAddRun();
  }
  loadContext();

  return {
    unmount() {
      alive = false;
      abort.abort();
      if (preflightAbort) preflightAbort.abort();
      sendPreflightSoon.cancel();
      sendEstimateSoon.cancel();
      offStore();
      offSnapshot();
      window.removeEventListener("beforeunload", onBeforeUnload);
      launchPart.destroy();
      optionsPart.destroy();
      evalPart.destroy();
      preflightPart.destroy();
      sources.destroy();
      presetsPart.destroy();
    },
    onQuery(query) {
      if (!alive) return;
      const run = query.get("run") || null;
      const from = query.get("from") || null;
      // Another run to add to, or to copy from, is another form: start it clean.
      if (run !== addRunId || (!addRunId && from && from !== fromRunId)) {
        queueMicrotask(() => { if (alive) reload(); });
        return;
      }
      if (!urlReady) return;
      const preset = query.get("preset");
      if (c.mode !== "add" && preset && preset !== c.form.preset) setPreset(preset, { announce: false });
      const set = query.get("set");
      if (set && set !== c.form.setId && !c.isEval() && !c.uploading) {
        selectSet(set, null);
        sources.reloadSets();
      }
      const limit = parseLimit(query.get("limit"));
      if (c.isEval() && limit && limit !== c.form.evalLimit) c.form.evalLimit = limit;
      // Whatever the new query left out is written back, so the URL keeps describing the form.
      update();
    },
  };
}
