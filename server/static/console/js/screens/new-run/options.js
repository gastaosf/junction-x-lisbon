// Step 4 of New run, left side (UI-SPEC 5.3): the settings of the run. A preset fills every
// field, so the default view is one summary line; "Advanced" opens the fields themselves, with
// what the preset locks shown locked and explained.
//
// Every control here is a harness control: it changes budgets, tools and bookkeeping, and none of
// its text is sent to the agent. What the agent is told is shown read-only at the bottom, from
// GET /api/prompt.

import { api, errorText } from "../../api.js";
import { badge, copyButton, debounce, el, icon, replace } from "../../dom.js";
import { fmtDuration, fmtInt } from "../../format.js";
import {
  BUDGET_KEYS, BUDGET_NAMES, CUSTOM_KINDS, EFFORTS, IMAGE_DETAILS, MAX_CONCURRENCY, MAX_MCQ_LIMIT,
  MAX_OUTPUT_TOKENS, PENALTY_SCOPES, changedFields, lockReason, optionsSummary, parseNumber, presetOf, promptQuery,
} from "../../logic/launch.js";
import { link, paths } from "../../router.js";
import { busyLine, errorNotice, nextId, notice } from "./ui.js";

const BUDGET_LABEL = { standard: "Standard", special: "Special One", live: "Live" };
const BUDGET_COLUMN = {
  effort: "Effort",
  soft_deadline_s: "Soft deadline (s)",
  hard_deadline_s: "Hard deadline (s)",
  max_turns: "Max turns",
  max_spend_usd: "Spend cap (USD)",
};
const SCOPE_TEXT = {
  whole_list: "Whole list (the working assumption, Q2)",
  subsequent: "Only entries made after the interaction",
};
const DETAIL_TEXT = { low: "low", high: "high", original: "original (full resolution)", auto: "auto" };

export function createOptions(c) {
  const root = el("div", "stack nr-options");
  const summary = el("div", "nr-summary-line");
  const changed = el("div", "row wrap small nr-changed");
  const advanced = el("details", "nr-advanced");
  const groups = el("div", "nr-groups");
  advanced.append(el("summary", null, "Advanced: every setting"), groups);
  advanced.addEventListener("toggle", () => { c.form.advancedOpen = advanced.open; });

  const promptBody = el("div", "stack nr-prompt-body");
  const promptPanel = el("details", "nr-prompt");
  promptPanel.append(el("summary", null, "What the agent will be told (read-only)"), promptBody);
  root.append(summary, changed, advanced, promptPanel);

  const abort = new AbortController();
  let destroyed = false;
  let built = null; // signature of the form that is on screen
  let fields = new Map(); // key -> {sync(settings), control, lock, error, wrap}

  // ------------------------------------------------------------ field builders

  function register(key, control, wrap, sync) {
    const error = el("div", { class: "field-error", hidden: true });
    const lockText = el("span");
    const lock = el("div", { class: "field-help row tight top nr-lock", hidden: true }, icon("lock"), lockText);
    wrap.append(lock, error);
    fields.set(key, { control, wrap, sync, error, lock, lockText });
  }

  function fieldWrap(key, labelText, control, help) {
    const id = nextId("nr-f");
    control.id = id;
    const wrap = el("div", "field nr-field",
      el("label", { class: "field-label", for: id }, labelText),
      control,
      help ? el("div", "field-help", help) : null);
    return wrap;
  }

  function numberField(key, labelText, { help = null, min = null, max = null, step = "1", integer = true, onEdit } = {}) {
    const input = el("input", { type: "number", class: "num", step, inputmode: integer ? "numeric" : "decimal" });
    if (min !== null) input.min = String(min);
    if (max !== null) input.max = String(max);
    input.addEventListener("input", () => (onEdit || ((value) => c.edit(key, value)))(parseNumber(input.value, { integer })));
    const wrap = fieldWrap(key, labelText, input, help);
    register(key, input, wrap, (settings) => {
      if (document.activeElement !== input) input.value = Number.isFinite(settings[key]) ? String(settings[key]) : "";
    });
    return wrap;
  }

  function selectField(key, labelText, choices, { help = null, onEdit = null, read = null } = {}) {
    const select = el("select", null, choices.map(([value, text]) => el("option", { value }, text)));
    select.addEventListener("change", () => (onEdit || ((value) => c.edit(key, value)))(select.value));
    const wrap = fieldWrap(key, labelText, select, help);
    register(key, select, wrap, (settings) => { select.value = String(read ? read(settings) : settings[key]); });
    return wrap;
  }

  function textField(key, labelText, { help = null, mono = false, placeholder = null, onEdit, read } = {}) {
    const input = el("input", { type: "text", class: mono ? "mono" : null, autocomplete: "off", placeholder });
    input.setAttribute("spellcheck", "false");
    input.addEventListener("input", () => onEdit(input.value));
    const wrap = fieldWrap(key, labelText, input, help);
    register(key, input, wrap, (settings) => {
      if (document.activeElement !== input) input.value = read(settings);
    });
    return wrap;
  }

  function switchField(key, labelText, { help = null, read, onEdit } = {}) {
    const input = el("input", { type: "checkbox" });
    input.addEventListener("change", () => onEdit(input.checked));
    const wrap = el("div", "field nr-field nr-switch-field",
      el("label", "switch", input, el("span", "switch-track"), el("span", "nr-switch-text", labelText)),
      help ? el("div", "field-help", help) : null);
    register(key, input, wrap, (settings) => { input.checked = Boolean(read(settings)); });
    return wrap;
  }

  function group(title, ...children) {
    return el("fieldset", "nr-group", el("legend", "section-title", title), children);
  }

  // ------------------------------------------------------------ groups

  function runGroup(evalMode) {
    const preset = presetOf(c.context, c.form.preset);
    const nodes = [
      textField("run_id", "Run id", {
        mono: true,
        placeholder: "UTC timestamp, made at launch",
        help: evalMode
          ? "Leave empty for a UTC timestamp. An evaluation run needs a directory of its own, so an existing id is refused."
          : "Leave empty for a UTC timestamp. If the id already exists, its logs are appended to and the penalties already charged carry over. The id of a run that is still going is refused.",
        onEdit: (value) => c.setRunId(value.trim()),
        read: () => c.form.runId || "",
      }),
    ];
    if (!evalMode) {
      nodes.push(selectField("kind", "Kind", CUSTOM_KINDS.map((kind) => [kind, kind]), {
        help: "Decides where the run is listed and whether it can be deleted (a scoring run cannot).",
        onEdit: (value) => c.setKind(value),
        read: () => c.kind() || (preset && preset.kind) || "training",
      }));
      nodes.push(textField("team", "Team name", {
        help: "Written into the exported files. Never sent to the agent.",
        onEdit: (value) => c.edit("team", value),
        read: (settings) => String(settings.team ?? ""),
      }));
    }
    return group("Run", nodes);
  }

  function autonomyGroup() {
    return group("Autonomy",
      switchField("no_human", "Human channels (MCQ, cue, geocode)", {
        help: "On: the three penalised operator inputs are available during the run. Off: the run is autonomous and they do not exist.",
        read: (settings) => !settings.no_human,
        onEdit: (on) => c.edit("no_human", !on),
      }),
      switchField("mcq_allowed", "Questions allowed at start", {
        help: "Whether the agent may ask a multiple-choice question from the first turn. It can be switched per panorama during the run.",
        read: (settings) => settings.mcq_allowed,
        onEdit: (on) => c.edit("mcq_allowed", on),
      }),
      numberField("max_mcq", "Max MCQs per panorama", { min: 0, max: MAX_MCQ_LIMIT, help: "0 to " + MAX_MCQ_LIMIT + ". The rules allow three; each one asked costs x0.95." }));
  }

  function modelGroup() {
    const models = (c.context.models || []).map((name) => [name, name]);
    return group("Model",
      selectField("model", "Model", models, {
        help: c.context.fake_model ? "Not used: this server answers with the demo model." : "Prices and the spend cap follow the model.",
      }),
      numberField("max_tokens", "Max output tokens", { min: 1, max: MAX_OUTPUT_TOKENS, step: "1000" }),
      selectField("image_detail", "Image detail", IMAGE_DETAILS.map((value) => [value, DETAIL_TEXT[value] || value])));
  }

  function budgetGroup() {
    const head = el("tr", null, el("th", null, "Budget"), BUDGET_KEYS.map((key) => el("th", null, BUDGET_COLUMN[key])));
    const rows = BUDGET_NAMES.map((name) => {
      const use = el("div", "small dim");
      const cells = BUDGET_KEYS.map((key) => {
        const fieldKey = name + "." + key;
        const label = BUDGET_LABEL[name] + ": " + BUDGET_COLUMN[key];
        let control;
        if (key === "effort") {
          control = el("select", { "aria-label": label }, EFFORTS.map((value) => el("option", { value }, value)));
          control.addEventListener("change", () => c.editBudget(name, key, control.value));
        } else {
          const integer = key === "max_turns";
          control = el("input", { type: "number", class: "num", min: integer ? "1" : "0", step: integer ? "1" : "any", "aria-label": label });
          control.addEventListener("input", () => c.editBudget(name, key, parseNumber(control.value, { integer })));
        }
        const cell = el("td", null, control);
        const sync = (settings) => {
          const value = (settings[name] || {})[key];
          if (key === "effort") control.value = String(value);
          else if (document.activeElement !== control) control.value = Number.isFinite(value) ? String(value) : "";
        };
        fields.set(fieldKey, { control, wrap: cell, sync, error: null, lock: null, lockText: null });
        return cell;
      });
      fields.set("budget-use:" + name, { control: null, wrap: use, sync: () => {}, error: null, lock: null, lockText: null });
      return el("tr", null, el("th", { scope: "row" }, BUDGET_LABEL[name], use), cells);
    });
    const errors = el("div", { class: "field-error", hidden: true });
    fields.set("budget-errors", { control: null, wrap: errors, sync: () => {}, error: errors, lock: null, lockText: null });
    return el("fieldset", "nr-group nr-group-wide",
      el("legend", "section-title", "Budgets"),
      el("div", "scroll-x", el("table", "table compact nr-budgets", el("thead", null, head), el("tbody", null, rows))),
      errors,
      el("div", "field-help",
        "At the soft deadline the agent is told to commit; at the hard deadline its best answer so far is used. ",
        "The spend caps add up to the cost ceiling."),
      switchField("live_budget", "Use the live budget for every panorama", {
        help: "The short budget of the on-stage panorama, in place of the standard and Special One budgets.",
        read: () => c.liveBudget(),
        onEdit: (on) => c.setLiveBudget(on),
      }));
  }

  function toolsGroup() {
    const list = el("div", "nr-tools");
    for (const tool of c.context.tools || []) {
      const key = "tool:" + tool.name;
      const input = el("input", { type: "checkbox" });
      input.addEventListener("change", () => c.toggleTool(tool.name, input.checked));
      const wrap = el("div", "nr-tool",
        el("label", "switch", input, el("span", "switch-track"), el("span", "mono", tool.name)),
        tool.protected ? badge("required", "dim", "lock") : null,
        tool.web ? badge("web", "dim", "wifi") : null);
      register(key, input, wrap, (settings) => {
        const off = (settings.disabled_tools || []).includes(tool.name) || (tool.web && settings.allow_web === false);
        input.checked = !off;
      });
      list.append(wrap);
    }
    const errors = el("div", { class: "field-error", hidden: true });
    fields.set("disabled_tools", { control: null, wrap: errors, sync: () => {}, error: errors, lock: null, lockText: null });
    return el("fieldset", "nr-group nr-group-wide",
      el("legend", "section-title", "Tools"),
      switchField("allow_web", "Web access (Q1)", {
        help: "Off: web search, geocoding, street-level and satellite lookups are all removed from the agent's tools.",
        read: (settings) => settings.allow_web !== false,
        onEdit: (on) => c.edit("allow_web", on),
      }),
      el("div", "field-label", "Tools offered to the agent (switch one off for an ablation)"),
      list, errors);
  }

  function answerGroup(evalMode) {
    const nodes = [
      switchField("hedge", "Hedge", {
        help: "Split the ten entries between the top two hypotheses when they are close. Off: the best point is repeated.",
        read: (settings) => settings.hedge,
        onEdit: (on) => c.edit("hedge", on),
      }),
    ];
    if (!evalMode) {
      nodes.push(switchField("allow_duplicates", "Allow duplicates (Q3)", {
        help: "Exact duplicate coordinates may fill several ranks.",
        read: (settings) => settings.allow_duplicates,
        onEdit: (on) => c.edit("allow_duplicates", on),
      }));
      nodes.push(selectField("penalty_scope", "Penalty scope (Q2)", PENALTY_SCOPES.map((value) => [value, SCOPE_TEXT[value] || value])));
    }
    return group("Answer", nodes);
  }

  function orchestrationGroup(evalMode) {
    const hint = el("span");
    const nodes = [numberField("concurrency", "Panoramas in parallel", { min: 1, max: MAX_CONCURRENCY })];
    if (!evalMode) {
      nodes.push(numberField("global_watchdog_s", "Global watchdog (s)", {
        min: 1, integer: false, step: "any",
        help: ["Every panorama still running is finalised after this long. ", hint],
      }));
      fields.set("watchdog-hint", {
        control: null, wrap: hint, error: null, lock: null, lockText: null,
        sync: (settings) => {
          hint.textContent = Number.isFinite(settings.global_watchdog_s) && settings.global_watchdog_s > 0
            ? "Now " + fmtDuration(settings.global_watchdog_s) + "."
            : "";
        },
      });
    }
    return group("Orchestration", nodes);
  }

  function exportGroup() {
    return group("Export",
      switchField("embed_images", "Embed images in the exported logs (Q4)", {
        help: "Larger files that stand on their own. Exports can be rebuilt either way later.",
        read: (settings) => settings.embed_images,
        onEdit: (on) => c.edit("embed_images", on),
      }));
  }

  function evalEffortGroup() {
    const base = c.settings();
    const choices = [["", "Saved default (" + base.standard.effort + ", Special One " + base.special.effort + ")"]]
      .concat(EFFORTS.map((value) => [value, value]));
    return group("Model",
      selectField("eval_effort", "Effort", choices, {
        help: "One effort for every panorama of the run. Model, budgets and the watchdog come from the saved defaults.",
        onEdit: (value) => c.setEvalEffort(value || null),
        read: () => c.form.evalEffort || "",
      }));
  }

  function build() {
    fields = new Map();
    const evalMode = c.isEval();
    if (evalMode) {
      replace(groups,
        runGroup(true), evalEffortGroup(), answerGroup(true), orchestrationGroup(true), toolsGroup(),
        notice("info",
          "An evaluation run changes only what is shown here. Everything else is the saved defaults: ",
          link(paths.settings("defaults"), "edit them in Settings"), "."));
    } else {
      replace(groups,
        runGroup(false), autonomyGroup(), modelGroup(), answerGroup(false), orchestrationGroup(false), exportGroup(),
        budgetGroup(), toolsGroup());
    }
    advanced.open = Boolean(c.form.advancedOpen) || c.form.preset === "custom";
  }

  // ------------------------------------------------------------ keeping it in step

  function syncFields() {
    const settings = c.settings();
    const live = c.liveBudget();
    const problems = new Map();
    for (const problem of c.problems()) {
      if (!problems.has(problem.field)) problems.set(problem.field, problem.text);
    }
    const runIdError = c.runIdError();
    if (runIdError) problems.set("run_id", runIdError);

    const budgetErrors = [];
    for (const [key, field] of fields) {
      field.sync(settings);
      if (!field.control) continue;
      const reason = lockReason(key, { context: c.context, preset: c.form.preset, settings });
      field.control.disabled = Boolean(reason);
      if (key.startsWith("tool:")) {
        // Ten lock lines under ten switches would bury the list: the badge and the tooltip say it.
        field.lock.hidden = true;
        field.wrap.title = reason || "";
      } else if (field.lock) {
        field.lock.hidden = !reason;
        field.lockText.textContent = reason || "";
      } else if (reason) field.control.title = reason;
      const text = problems.get(key) || null;
      if (text) field.control.setAttribute("aria-invalid", "true");
      else field.control.removeAttribute("aria-invalid");
      if (field.error) {
        field.error.hidden = !text;
        field.error.textContent = text || "";
        field.wrap.classList.toggle("invalid", Boolean(text));
      } else if (text) {
        const [name, part] = key.split(".");
        budgetErrors.push((BUDGET_LABEL[name] || name) + ", " + (BUDGET_COLUMN[part] || part).toLowerCase() + ": " + text);
      }
    }
    for (const name of BUDGET_NAMES) {
      const use = fields.get("budget-use:" + name);
      if (!use) continue;
      const used = live ? name === "live" : name !== "live";
      use.wrap.textContent = used
        ? (name === "live" ? "every panorama" : name === "special" ? "the Special One" : "every other panorama")
        : "not used by this run";
    }
    const budgetSlot = fields.get("budget-errors");
    if (budgetSlot) {
      budgetSlot.error.hidden = !budgetErrors.length;
      budgetSlot.error.textContent = budgetErrors.join(" ");
    }
    const toolSlot = fields.get("disabled_tools");
    if (toolSlot) {
      const text = problems.get("disabled_tools") || null;
      toolSlot.error.hidden = !text;
      toolSlot.error.textContent = text || "";
    }
  }

  function renderSummary() {
    const settings = c.settings();
    const evalMode = c.isEval();
    const parts = optionsSummary(settings, { tools: c.context.tools, liveBudget: c.liveBudget(), evalMode });
    if (evalMode && c.form.evalEffort) parts[1] = "effort " + c.form.evalEffort + " for every panorama";
    replace(summary, parts.map((part, index) => [index ? el("span", "dim", " · ") : null, el("span", index ? null : "strong", part)]));
    const fieldsChanged = changedFields(c.context, c.form.preset, c.form.edits);
    const count = fieldsChanged.length + (evalMode && c.form.evalEffort ? 1 : 0);
    const preset = presetOf(c.context, c.form.preset);
    replace(changed,
      count
        ? [
          badge(count + " changed", "info", "settings"),
          el("span", "dim", "from the " + ((preset && preset.label) || "preset") + " preset" + (fieldsChanged.length ? ": " + fieldsChanged.join(", ") : "") + "."),
          el("button", { type: "button", class: "small ghost", onclick: () => c.resetEdits() }, icon("refresh"), "Back to the preset"),
        ]
        : el("span", "dim", "Exactly as the " + ((preset && preset.label) || "") + " preset and the saved defaults give them."));
  }

  // ------------------------------------------------------------ what the agent will be told

  const prompt = { query: null, data: null, loading: false, error: null, token: 0 };

  async function loadPrompt() {
    if (destroyed || !promptPanel.open || !c.context || !c.form.preset) return;
    const query = promptQuery(c.settings());
    if (query === prompt.query && (prompt.data || prompt.loading)) return;
    prompt.query = query;
    prompt.token += 1;
    const token = prompt.token;
    prompt.loading = true;
    prompt.error = null;
    renderPrompt();
    try {
      const data = await api.get("/api/prompt?" + query, { signal: abort.signal });
      if (token !== prompt.token) return;
      prompt.data = data;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (token !== prompt.token) return;
      prompt.error = errorText(err);
      prompt.data = null;
    }
    prompt.loading = false;
    renderPrompt();
  }
  const loadPromptSoon = debounce(loadPrompt, 400);
  promptPanel.addEventListener("toggle", () => { if (promptPanel.open) loadPrompt(); });

  function toolName(tool) {
    return String((tool && (tool.name || tool.type)) || "tool");
  }

  function renderPrompt() {
    if (destroyed) return;
    const data = prompt.data;
    const text = data ? String(data.system_prompt || "") : "";
    const tools = data ? data.tools || [] : [];
    replace(promptBody,
      notice("info",
        "Read-only. This is the system prompt and the tool list a run with these settings sends, exactly. ",
        "Nothing on this page adds to it: after launch the only words from the team that can reach the agent are a cue, ",
        "an MCQ answer and a geocoded place, each sent from the run's own screen and each penalised."),
      prompt.error ? errorNotice(prompt.error, { onRetry: () => { prompt.query = null; loadPrompt(); } }) : null,
      prompt.loading ? busyLine("Loading the prompt for these settings…") : null,
      data
        ? [
          el("div", "row wrap",
            el("span", "section-title", "System prompt"),
            el("span", "dim small num", fmtInt(text.length) + " characters"),
            copyButton(text, { title: "Copy the system prompt" })),
          el("pre", { class: "code-block nr-prompt-text", tabindex: "0" }, text),
          el("div", "section-title", "Tools (" + tools.length + ")"),
          el("ul", "nr-prompt-tools", tools.map((tool) => el("li", null,
            el("span", "mono strong", toolName(tool)),
            tool.description ? el("div", "small dim", String(tool.description)) : null))),
        ]
        : null);
  }

  function update() {
    if (destroyed || !c.context || !c.form.preset || c.mode === "add") return;
    const signature = [c.contextVersion, c.form.preset, c.isEval(), c.formVersion].join("|");
    if (signature !== built) {
      built = signature;
      build();
    }
    syncFields();
    renderSummary();
    if (promptPanel.open) loadPromptSoon();
  }

  return {
    el: root,
    update,
    /** Open the read-only prompt and bring it into view (the link in the launch panel). */
    openPrompt() {
      promptPanel.open = true;
      loadPrompt();
      promptPanel.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    destroy() {
      destroyed = true;
      loadPromptSoon.cancel();
      abort.abort();
    },
  };
}
