// Step 4 of New run, right side (UI-SPEC 5.3): what is about to be launched, whether the machine
// is ready for it, and the one button that does it. The same panel adds panoramas to a run that
// is already going (`/new?run=<run_id>`).
//
// A launch cannot be taken back and may cost money, so it always goes through a confirmation
// that repeats the summary. One idempotency key is made when that confirmation opens and is sent
// with every attempt of that same request: a retry after a timeout never starts a second run.

import { api, errorText, newKey, runUrl } from "../../api.js";
import { confirmDialog, toast } from "../../components/shell.js";
import { badge, el, icon, replace } from "../../dom.js";
import { plural } from "../../format.js";
import {
  addPanoramasBody, addSummaryLines, canRetry, countRows, enabledTools, evalBody, launchBlockers, launchLabel,
  launchSpec, needsNoKeyConfirm, presetOf, readinessItems, summaryLines, unreadImagesText,
} from "../../logic/launch.js";
import { link, navigate, paths } from "../../router.js";
import { bullets, busyLine, errorNotice, keepFocus, notice } from "./ui.js";

// Reading and hashing a large set takes a while; past this the request is taken as lost.
const LAUNCH_TIMEOUT_MS = 180000;

const VERDICT = {
  ok: ["ok", "ok", "check"],
  warn: ["warning", "warn", "alert"],
  bad: ["problem", "bad", "x"],
  unknown: ["not checked", "dim", "question"],
};

// What the confirmation repeats from the checklist: everything that is wrong, and the warnings
// that change what the run is. A missing optional key is not worth a line in the dialog.
const CONFIRM_WARNINGS = new Set(["model", "active", "disk"]);

export function createLaunchPanel(c) {
  const root = el("aside", { class: "stack nr-launch", "aria-label": "Launch" });
  let destroyed = false;
  let rendered = null;
  let launching = false;
  let failure = null; // {text, retry: bool}: the last attempt that did not go through
  let pending = null; // {key, url, body, add}: the request of the confirmation that is open or unanswered
  let dialog = null;
  const abort = new AbortController();

  // ------------------------------------------------------------ what is shown

  function view() {
    const add = c.mode === "add";
    const evalMode = c.isEval();
    const context = c.context;
    const ready = Boolean(context && (add || c.form.preset));
    const fake = Boolean((context && context.fake_model) || (add && c.addRun && c.addRun.fake_model));
    const readiness = c.readiness();
    const items = readiness
      ? readinessItems({ readiness, health: c.health(), fakeModel: fake, ownRunId: add ? c.form.addRunId : null })
      : [];
    const noKey = !add && needsNoKeyConfirm(readiness, fake);
    const rows = c.preflight ? c.preflight.rows || [] : [];
    const settings = !add && ready ? c.settings() : null;
    let lines = [];
    if (add) {
      lines = addSummaryLines({ run: c.addRun, rows, ceilingUsd: c.preflight ? c.preflight.cost_ceiling_usd : null });
    } else if (settings) {
      lines = summaryLines({
        context, preset: c.form.preset, kind: c.kind(), settings, liveBudget: c.liveBudget(), rows,
        ceilingUsd: c.preflight ? c.preflight.cost_ceiling_usd : null,
        estimates: context.estimates, runId: c.form.runId, evalMode, estimate: c.estimate,
      });
    }
    const blockers = launchBlockers({
      mode: c.mode, context, preset: c.form.preset, kind: add ? null : (ready ? c.kind() : null),
      setId: c.form.setId, uploading: c.uploading,
      preflight: c.preflight, preflightLoading: c.preflightLoading, preflightError: c.preflightError,
      estimate: c.estimate, estimateLoading: c.estimateLoading, estimateError: c.estimateError,
      problems: add || !ready ? [] : c.problems(), runIdError: add ? null : c.runIdError(),
      fakeModel: fake, launching, addRun: c.addRun,
    });
    if (failure && failure.retry && !launching) {
      blockers.unshift("A launch request has no answer yet. Send it again, or dismiss it after checking the Runs list.");
    }
    let sent = null;
    if (settings) {
      const effort = evalMode && c.form.evalEffort
        ? c.form.evalEffort + " for every panorama"
        : c.liveBudget()
          ? settings.live.effort + " (live budget)"
          : settings.standard.effort + ", Special One " + settings.special.effort;
      sent = {
        model: fake ? "demo model (scripted, no API call)" : String(settings.model),
        effort,
        tools: enabledTools(context.tools, settings),
        total: (context.tools || []).length,
      };
    }
    return {
      add, evalMode, ready, fake, noKey, items, lines, blockers, sent,
      label: launchLabel({ mode: c.mode, context, preset: c.form.preset, noKey, count: countRows(rows).total }),
      contextLoading: c.contextLoading, contextError: c.contextError,
      addRunError: c.addRunError, launching, failure,
    };
  }

  // ------------------------------------------------------------ sending

  function request(v) {
    const rows = c.preflight ? c.preflight.rows || [] : [];
    const resolved = { ...c.resolved(), confirmNoKey: v.noKey };
    if (v.add) return { url: runUrl(c.form.addRunId, "/panoramas"), body: addPanoramasBody(resolved, rows) };
    if (v.evalMode) return { url: "/api/eval/runs", body: evalBody(resolved, { launch: true }) };
    return { url: "/api/runs", body: launchSpec(resolved, rows, c.preflight ? c.preflight.preflight_token : null) };
  }

  function confirmBody(v) {
    const concerns = v.items
      .filter((item) => !(v.noKey && item.id === "openai"))
      .filter((item) => item.verdict === "bad" || (item.verdict === "warn" && CONFIRM_WARNINGS.has(item.id)))
      .map((item) => item.label + ": " + item.text);
    const unread = unreadImagesText(c.unreadImages());
    if (unread) concerns.unshift(unread);
    const preset = presetOf(c.context, c.form.preset);
    let closing = "Launching freezes these settings into the run. Nothing about a panorama's task can change afterwards.";
    if (v.add) closing = "Each new panorama starts as soon as a slot is free. Its task cannot change once it is added.";
    else if (c.kind() === "scoring") closing += " A scoring run cannot be deleted from the console.";
    else if (preset && c.form.preset === "live") closing += " The stage view opens when the run starts.";
    return el("div", "stack nr-confirm",
      el("dl", "kv", v.lines.map(([name, value]) => [el("dt", null, name), el("dd", null, value)])),
      v.noKey
        ? notice("bad", "There is no OpenAI key on this server. The agent cannot run: every panorama ends with the "
          + "harness fallback answer. Set the key in Settings first unless that is what you want.")
        : null,
      concerns.length ? notice("warn", el("div", "strong", "Before you confirm:"), bullets(concerns)) : null,
      el("div", "small dim", closing));
  }

  async function ask() {
    const v = view();
    if (v.blockers.length || launching || dialog) return;
    const made = request(v);
    // One key per confirmation; every attempt of this request reuses it.
    const mine = { key: newKey(), url: made.url, body: made.body, add: v.add };
    dialog = confirmDialog({
      title: v.add
        ? "Add " + plural(countRows(c.preflight ? c.preflight.rows : []).total, "panorama") + " to run " + c.form.addRunId + "?"
        : v.noKey ? "Launch without an OpenAI key?" : "Launch this run?",
      body: confirmBody(v),
      okLabel: v.label,
      cancelLabel: "Not yet",
      tone: v.noKey ? "danger" : "default",
    });
    const ok = await dialog;
    dialog = null;
    if (!ok || destroyed) return;
    pending = mine;
    send();
  }

  async function send() {
    if (!pending || launching || destroyed) return;
    const mine = pending;
    launching = true;
    failure = null;
    update();
    try {
      const result = await api.post(mine.url, mine.body, { key: mine.key, signal: abort.signal, timeoutMs: LAUNCH_TIMEOUT_MS });
      if (destroyed) return;
      pending = null;
      c.launched();
      if (mine.add) {
        const added = (result && result.added) || [];
        const skipped = (result && result.skipped) || [];
        toast(
          plural(added.length, "panorama") + " added to run " + c.form.addRunId + "."
          + (skipped.length ? " " + plural(skipped.length, "file") + " already in the run " + (skipped.length === 1 ? "was" : "were") + " skipped." : ""),
          added.length ? "ok" : "warn");
        navigate(paths.run(c.form.addRunId));
        return;
      }
      const url = result && typeof result.url === "string" ? result.url : paths.run(result.run_id);
      navigate(url);
    } catch (err) {
      if (destroyed || (err && err.name === "AbortError")) return;
      launching = false;
      const retry = canRetry(err);
      failure = { text: errorText(err), retry };
      if (!retry) {
        // A refusal: the form has to change, and a changed request needs a key of its own.
        pending = null;
        c.refused(err);
      }
      update();
    }
  }

  function dismiss() {
    pending = null;
    failure = null;
    update();
  }

  // ------------------------------------------------------------ rendering

  function readinessList(v) {
    if (!v.items.length) {
      if (v.contextError) return errorNotice("The readiness check could not be loaded: " + v.contextError, { onRetry: () => c.reloadContext() });
      return busyLine("Checking readiness…");
    }
    return el("ul", "nr-ready", v.items.map((item) => {
      const [text, kind, iconName] = VERDICT[item.verdict] || VERDICT.unknown;
      return el("li", "nr-ready-item",
        badge(text, kind, iconName),
        el("div", "nr-ready-text",
          el("span", "strong", item.label), " ",
          el("span", item.verdict === "ok" ? "dim" : null, item.text),
          item.section ? [" ", link(paths.settings(item.section), { class: "small", dataset: { fk: "ready:" + item.id } }, "Settings")] : null,
          (item.runs || []).length
            ? el("span", "small", " Open: ", item.runs.map((id, index) => [index ? ", " : null, link(paths.run(id), { class: "mono", dataset: { fk: "run:" + id } }, id)]))
            : null));
    }));
  }

  function render(v) {
    const nodes = [];
    nodes.push(el("h3", "section-title", v.add ? "What will be added" : "What will be launched"));
    if (v.addRunError) nodes.push(errorNotice(v.addRunError, { onRetry: () => c.reloadAddRun() }));
    if (v.lines.length) {
      nodes.push(el("dl", "kv nr-kv", v.lines.map(([name, value]) => [el("dt", null, name), el("dd", null, value)])));
    } else if (!v.add) nodes.push(el("div", "dim", "Choose a preset to see the summary."));

    if (v.sent) {
      nodes.push(el("h3", "section-title", "What will be sent to the model"));
      nodes.push(el("div", "stack tight nr-sent",
        el("div", null, el("span", "dim", "Model "), el("span", "mono", v.sent.model)),
        el("div", null, el("span", "dim", "Effort "), v.sent.effort),
        el("div", null, el("span", "dim", "Tools (" + v.sent.tools.length + " of " + v.sent.total + ") "),
          v.sent.tools.map((name) => el("span", "chip mono nr-tool-chip", name))),
        el("div", null,
          el("button", { type: "button", class: "small ghost", dataset: { fk: "prompt" }, onclick: () => c.openPrompt() },
            icon("eye"), "Read the system prompt"))));
    }

    nodes.push(el("div", "row spread",
      el("h3", "section-title", "Readiness"),
      el("button", {
        type: "button", class: "small ghost", disabled: v.contextLoading, dataset: { fk: "ready:reload" },
        title: "Ask the server again for keys, internet, disk and active runs",
        onclick: () => c.reloadContext(),
      }, v.contextLoading ? el("span", "spinner") : icon("refresh"), "Check again")));
    nodes.push(readinessList(v));

    if (v.fake) {
      nodes.push(notice("warn",
        el("div", "strong", "Demo model"),
        "This server was started with ASTROLABIO_FAKE_MODEL. The run is answered by a script: no OpenAI call is made, "
        + "nothing is spent and the answers are not real. Do not submit them."));
    }
    // The button, and what went wrong with it, stay in view below the part that scrolls.
    const disabled = v.blockers.length > 0 || v.launching;
    const failed = !v.failure ? null : errorNotice(v.failure.text, v.failure.retry
        ? {
          onRetry: send,
          retryLabel: "Send again",
          extra: [
            el("button", { type: "button", class: "small ghost", dataset: { fk: "dismiss" }, onclick: dismiss }, "Dismiss"),
            link(paths.runs(), { class: "small", dataset: { fk: "runs" } }, "Open the Runs list"),
            el("div", "small", "The server may have received the request. Sending it again is safe: the same launch is never started twice."),
          ],
        }
        : {});

    const go = (el("div", "stack tight nr-go",
      failed,
      el("button", {
        type: "button", class: (v.noKey ? "danger" : "primary") + " nr-go-btn", disabled, dataset: { fk: "go" },
        onclick: ask,
      }, v.launching ? el("span", "spinner") : icon(v.add ? "plus" : "play"), v.launching ? (v.add ? "Adding…" : "Launching…") : v.label),
      v.noKey && !disabled
        ? el("div", "small bad-text", "No OpenAI key: the next step asks you to confirm a run that can only produce fallback answers.")
        : null,
      v.blockers.length && !v.launching
        ? el("div", { class: "nr-blockers", role: "status" },
          el("div", "small strong", v.add ? "Not ready to add:" : "Not ready to launch:"),
          el("ul", "nr-list small", v.blockers.map((text) => el("li", null, text))))
        : !v.launching
          ? el("div", "small dim", "You are asked to confirm before anything starts.")
          : null));
    replace(root, el("div", "stack nr-launch-info", nodes), go);
  }

  function update() {
    if (destroyed) return;
    const v = view();
    const now = JSON.stringify(v);
    if (now === rendered) return;
    rendered = now;
    keepFocus(root, () => render(v));
  }

  return {
    el: root,
    update,
    isLaunching: () => launching,
    destroy() {
      destroyed = true;
      abort.abort();
      // The promise of an open confirmation resolves false; nothing is sent after this.
      if (dialog && confirmDialog.current) confirmDialog.current.close();
    },
  };
}
