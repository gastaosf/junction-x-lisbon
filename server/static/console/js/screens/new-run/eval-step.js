// Step 2 of New run for the Evaluation preset (UI-SPEC 5.3, 5.9 "Run"). An evaluation run has no
// panoramas of its own to choose: they come from the evaluation set, so this step only says what
// would run, what it may cost and what still stands in the way, and sends the operator to the
// Evaluation screen for anything that has to be fixed in the set.
//
// Ground truth is not shown here. The run is always autonomous; the truth is used for scoring
// after it has ended.

import { el, icon, replace } from "../../dom.js";
import { fmtUsd, plural } from "../../format.js";
import { parseLimit } from "../../logic/launch.js";
import { link, paths } from "../../router.js";
import { bullets, busyLine, errorNotice, keepFocus, nextId, notice, stepCard } from "./ui.js";

export function createEvalStep(c) {
  const step = stepCard("Evaluation set");
  const content = el("div", "stack nr-eval");
  const limitId = nextId("nr-limit");
  const limitInput = el("input", {
    type: "number", class: "num nr-limit-input", id: limitId, min: "1", step: "1", inputmode: "numeric", placeholder: "all",
  });
  const limitError = el("div", { class: "field-error", hidden: true });
  const limitField = el("div", "field nr-limit",
    el("label", { class: "field-label", for: limitId }, "Limit to the first N panoramas"),
    limitInput,
    el("div", "field-help", "Leave empty to run the whole set. A short run is the cheap way to try a change."),
    limitError);
  step.body.append(limitField, content);
  let rendered = null;

  limitInput.addEventListener("input", () => {
    const raw = limitInput.value.trim();
    const value = parseLimit(raw);
    const bad = raw !== "" && value === null;
    limitError.hidden = !bad;
    limitError.textContent = bad ? "Not a whole number above 0, so the whole set would run. Correct it or clear the field." : "";
    limitField.classList.toggle("invalid", bad);
    c.setEvalLimit(value);
  });

  function render() {
    const estimate = c.estimate;
    const nodes = [];
    if (c.estimateError) {
      nodes.push(errorNotice(c.estimateError, { onRetry: () => c.reestimate(), retryLabel: "Check again" }));
    }
    if (!estimate) {
      if (!c.estimateError) nodes.push(busyLine("Reading the evaluation set…"));
      replace(content, nodes);
      return;
    }
    const blocking = estimate.blocking || [];
    nodes.push(el("div", "row wrap nr-eval-summary",
      el("span", "strong num", plural(estimate.panoramas, "panorama") + " from the evaluation set would run"),
      el("span", "grow"),
      el("span", "dim num", "Cost ceiling " + fmtUsd(estimate.cost_ceiling_usd))));
    if (blocking.length) {
      nodes.push(notice("bad",
        el("div", "strong", "This blocks the launch:"),
        bullets(blocking),
        el("div", "row wrap nr-notice-actions",
          link(paths.evaluation({ tab: "set" }), { class: "btn small", dataset: { fk: "eval:set" } }, icon("target"), "Open the evaluation set"),
          estimate.todo_labels
            ? link(paths.evaluation({ tab: "label" }), { class: "btn small", dataset: { fk: "eval:label" } }, "Label the " + plural(estimate.todo_labels, "panorama"))
            : null)));
    } else {
      nodes.push(notice("ok", "The evaluation set is ready to run."));
    }
    if (estimate.unconfirmed_labels) {
      nodes.push(notice("warn",
        plural(estimate.unconfirmed_labels, "label") + " of the panoramas that would run "
        + (estimate.unconfirmed_labels === 1 ? "is a guess that was" : "are guesses that were") + " never confirmed by eye. "
        + "The run is allowed, but a wrong label is scored with the wrong function. ",
        link(paths.evaluation({ tab: "label" }), { dataset: { fk: "eval:confirm" } }, "Confirm the labels"), "."));
    }
    nodes.push(notice("info",
      c.context && c.context.fake_model
        ? "This server runs the demo model: nothing is spent, and the scores of this run say nothing about the agent. "
        : "This run calls the model and costs money: at most " + fmtUsd(estimate.cost_ceiling_usd) + ", the sum of the spend caps. ",
      "It is always autonomous. The ground truth is only used to score the answers after the run has ended, "
      + "and the leak guards keep the agent away from the imagery the set was built from."));
    replace(content, nodes);
  }

  function update() {
    if (!c.isEval()) return;
    const estimate = c.estimate;
    let status = "busy";
    if (c.estimateError) status = "blocked";
    else if (estimate && !c.estimateLoading) status = (estimate.blocking || []).length ? "attention" : "done";
    step.setState({ open: true, status });
    if (document.activeElement !== limitInput && limitError.hidden) {
      limitInput.value = c.form.evalLimit ? String(c.form.evalLimit) : "";
    }
    content.classList.toggle("stale", Boolean(c.estimateLoading && estimate));
    const now = JSON.stringify([c.estimate, c.estimateError, Boolean(c.context && c.context.fake_model)]);
    if (now === rendered) return;
    rendered = now;
    keepFocus(content, render);
  }

  return { el: step.el, step, update, destroy() {} };
}
