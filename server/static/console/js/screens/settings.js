// The Settings screen (UI-SPEC 5.10): keys, defaults for new runs, organiser answers, directories,
// health, LAN access and the preferences of this browser.
//
// Nothing on this page reaches a run that has started or the agent: a saved default applies to the
// next launch, a key to the next client built, a directory and the LAN switch to the next start of
// the server. Stored keys never come back from the server; a key typed here lives only in its
// password field until it is saved, and is cleared after.
//
// The screen is not remounted when the server restarts (main.js), so it loads its data again
// itself and keeps whatever the operator was typing: unsaved form content lives in `kept`, apart
// from the server's payload, and is only ever dropped by a successful save or by "Discard".

import { api, errorText, newKey } from "../api.js";
import { confirmDialog, toast } from "../components/shell.js";
import { badge, copyText, debounce, el, icon, replace } from "../dom.js";
import { fmtBytes, fmtDateTime, fmtDuration, fmtInt, fmtTime, plural } from "../format.js";
import {
  KEY_INFO,
  KEY_NAMES,
  NOTE_MAX,
  SECTIONS,
  addRoot,
  answerControl,
  answerEffect,
  buildAnswersBody,
  buildDefaultsBody,
  buildPathsBody,
  canReset,
  checkKeyValue,
  controlKind,
  diskRows,
  editableRoots,
  fieldBlocks,
  groupFields,
  healthSummary,
  isDirty,
  isSetsRoot,
  keyStatus,
  keyTestLines,
  lanState,
  latencyWords,
  maskJoinUrl,
  notificationState,
  problemsByField,
  readPath,
  resetScope,
  restartWords,
  sameValue,
  sectionAt,
  sectionFromHash,
  serviceStatus,
  toRaw,
  topKey,
  windowStats,
} from "../logic/settings.js";
import { prefs } from "../prefs.js";
import { link, paths } from "../router.js";
import { store } from "../store.js";

const SETTINGS_URL = "/api/settings";
const HEALTH_URL = "/api/health";
const CACHE_CLEAR_URL = "/api/cache/clear";
const keyUrl = (name, rest = "") => SETTINGS_URL + "/keys/" + encodeURIComponent(name) + rest;

const REQUEST_MS = 20000;
// Every service is probed with a 6 s limit, and a key test may wait for two model requests.
const HEALTH_MS = 45000;
const KEY_TEST_MS = 45000;
const RESTART_COMMAND = "uv run python cli.py serve";

// Unsaved form content outlives the screen: leaving Settings and coming back, or a remount, must
// not throw away what the operator typed. A key value is never kept here.
const kept = {
  defaults: new Map(), // field key -> what its control holds
  resets: new Set(), // top-level default keys to forget on save
  answers: new Map(), // "Q1" -> {value?, note?}
  paths: {}, // {runs_dir?, cache_dir?, roots?}
};

const NOTICE_ICON = { info: "info", ok: "check", warn: "alert", bad: "alert" };
const sameRaw = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isAbort = (err) => Boolean(err && err.name === "AbortError");

function notice(kind, ...children) {
  return el("div", { class: "notice notice-" + kind, role: kind === "bad" ? "alert" : null },
    icon(NOTICE_ICON[kind] || "info"), el("div", "grow stack tight", ...children));
}

function failure(err, what, retry) {
  return notice("bad",
    el("div", "strong", what),
    el("div", "pre", errorText(err)),
    retry ? el("div", null, el("button", { type: "button", class: "small", onclick: retry }, icon("refresh"), "Try again")) : null);
}

// el() skips a false value, and the `spellcheck` property reads the string "false" as true.
function plain(input) {
  input.setAttribute("spellcheck", "false");
  return input;
}

function waitLine(text) {
  return el("p", "dim row tight settings-wait-line", el("span", "spinner"), el("span", null, text));
}

/** A button that can show it is working. `setDisabled(true, why)` says why in its tooltip. */
function actionButton({ label, iconName, cls, title, type = "button", onclick }) {
  const mark = el("span", "settings-btn-mark", iconName ? icon(iconName) : null);
  const text = el("span", null, label);
  const node = el("button", { type, class: cls || null, title: title || null, onclick: onclick || null }, mark, text);
  let busy = false;
  let off = false;
  const sync = () => { node.disabled = busy || off; };
  return {
    node,
    get busy() { return busy; },
    setBusy(on) {
      busy = Boolean(on);
      replace(mark, busy ? el("span", "spinner") : iconName ? icon(iconName) : null);
      sync();
    },
    setDisabled(on, why) {
      off = Boolean(on);
      node.title = off && why ? why : title || "";
      sync();
    },
    setLabel(value) { text.textContent = value; },
  };
}

function stat(row) {
  const kinds = { warn: " is-warn", bad: " is-bad" };
  const mark = row.kind === "bad" ? icon("alert") : row.kind === "warn" ? icon("alert") : null;
  return el("div", { class: "settings-stat" + (kinds[row.kind] || ""), dataset: { key: row.key } },
    el("div", "settings-stat-label caps dim", row.label),
    el("div", "settings-stat-value num", mark, el("span", null, row.value)),
    el("div", "settings-stat-help small dim", row.help));
}

/** A row of joined buttons, one pressed. `set(value)` moves the pressed mark without rebuilding. */
function segmented(label, options, onPick) {
  const node = el("div", { class: "btn-group", role: "group", "aria-label": label });
  const buttons = options.map((option) => {
    const button = el("button", {
      type: "button",
      "aria-pressed": "false",
      title: option.title || null,
      onclick: () => onPick(option.value),
    }, option.icon ? icon(option.icon) : null, option.label);
    node.append(button);
    return { value: option.value, button };
  });
  return {
    node,
    set(value) {
      for (const item of buttons) item.button.setAttribute("aria-pressed", item.value === value ? "true" : "false");
    },
  };
}

/** A switch with its state in words. `set(on, disabled)` updates it in place, keeping the focus. */
function toggleSwitch(id, label, onChange) {
  const input = el("input", { type: "checkbox", id, role: "switch", "aria-label": label });
  const word = el("span", "settings-switch-word");
  input.addEventListener("change", () => onChange(input.checked));
  return {
    node: el("label", "switch", input, el("span", "switch-track"), word),
    set(on, disabled = false) {
      input.checked = Boolean(on);
      input.disabled = Boolean(disabled);
      word.textContent = on ? "On" : "Off";
    },
  };
}

export function mount(container, params, ctx) {
  ctx.setTitle("Settings");

  const abort = new AbortController();
  const signal = abort.signal;
  const cleanups = [];
  let alive = true;
  let ownDialog = false; // a confirm dialog of this screen is open

  const state = {
    payload: null,
    loadError: null, // the settings could not be loaded at all
    staleError: null, // a later refresh failed; the page shows what it had
    health: null,
    healthError: null,
    healthLoading: false,
  };
  let settingsSeq = 0;
  let healthSeq = 0;

  async function ask(options) {
    ownDialog = true;
    try {
      return await confirmDialog(options);
    } finally {
      ownDialog = false;
    }
  }

  // ------------------------------------------------------------ page frame

  const topNotices = el("div", "stack settings-top");
  const navList = el("ul", "settings-nav-list");
  const nav = el("nav", { class: "settings-nav", "aria-label": "Sections of the settings" }, navList);
  const main = el("div", "settings-main");
  container.append(
    el("div", "page-head",
      el("h1", "page-title", "Settings"),
      el("span", "dim", "Nothing here changes a run that has started: a run keeps the configuration it was launched with.")),
    topNotices,
    el("div", "settings-layout", nav, main));

  function frame(id, title) {
    const marks = el("span", "row tight wrap settings-head-marks");
    const tools = el("span", "row tight wrap");
    const wait = el("div", "settings-wait");
    const content = el("div", { class: "stack loose settings-content", hidden: true });
    const body = el("div", "card-body", wait, content);
    const node = el("section", { class: "card flush settings-section", id, "aria-labelledby": id + "-title" },
      el("div", "card-head", el("h2", { class: "card-title", id: id + "-title" }, title), marks, el("span", "grow"), tools),
      body);
    return {
      id, node, marks, tools, content,
      // Before the first data: a loading line, or why there is none and a way to retry.
      showWait(text, problem) {
        wait.hidden = false;
        content.hidden = true;
        if (problem) replace(wait, failure(problem.error, problem.what, problem.retry));
        else if (problem === undefined && state.loadError) {
          // The reason is shown once, at the top of the page, not in every section.
          replace(wait, el("p", "row tight wrap settings-wait-line",
            icon("alert"), el("span", null, "Not loaded: the settings could not be read. The reason is at the top of this page."),
            el("button", { type: "button", class: "small", onclick: () => loadSettings() }, icon("refresh"), "Try again")));
        } else replace(wait, waitLine(text));
      },
      showContent() {
        wait.hidden = true;
        content.hidden = false;
      },
    };
  }

  function saveBar({ saveLabel, idle, onSave, onDiscard }) {
    const text = el("span", { class: "grow settings-savebar-text", "aria-live": "polite" });
    const discard = actionButton({ label: "Discard changes", cls: "ghost", onclick: onDiscard });
    const save = actionButton({ label: saveLabel, iconName: "check", cls: "primary", onclick: onSave });
    // The buttons lead: toasts appear over the right end of a bar that sticks to the window's bottom.
    const node = el("div", "card-foot settings-savebar", save.node, discard.node, text);
    return {
      node, save, discard,
      /** `names`: what is unsaved; `invalid`: something marked must be fixed; `lock`: why saving is off. */
      set({ names = [], invalid = false, lock = null }) {
        const count = names.length;
        node.classList.toggle("is-dirty", count > 0);
        if (lock) replace(text, icon("lock"), " ", lock);
        else if (!count) replace(text, el("span", "dim", idle));
        else {
          const shown = names.slice(0, 4).join(", ") + (count > 4 ? " and " + (count - 4) + " more" : "");
          replace(text,
            el("span", "strong", plural(count, "change") + " not saved: "), shown,
            invalid ? el("span", "bad-text", " Fix the marked " + (count === 1 ? "field" : "fields") + " first.") : null);
        }
        save.setDisabled(Boolean(lock) || count === 0, lock || (count === 0 ? "Nothing to save" : ""));
        discard.setDisabled(count === 0, count === 0 ? "Nothing to discard" : "");
      },
    };
  }

  /** The reason keys and directories are locked, or null. Both follow `keys_editable` (A23, A25). */
  function lanLock() {
    const p = state.payload;
    if (!p || p.keys_editable !== false) return null;
    const now = lanState(p).state;
    if (now === "pending_off") return "LAN access was switched off, but stays in force until the server is restarted";
    return now === "pending_on" ? "LAN access has been switched on" : "LAN access is on";
  }

  // ------------------------------------------------------------ keys

  function keysSection() {
    const f = frame("keys", "Keys");
    const notes = el("div", "stack");
    const list = el("div", "settings-keys");
    const where = el("p", "small dim");
    f.content.append(notes, list, where);
    const rows = new Map();

    function showError(row, text) {
      row.error.hidden = !text;
      row.error.textContent = text || "";
      row.field.classList.toggle("invalid", Boolean(text));
    }

    function build(name) {
      const info = KEY_INFO[name];
      const inputId = "settings-key-" + name;
      const input = plain(el("input", {
        type: "password",
        id: inputId,
        class: "mono grow settings-key-input",
        // Not a login: keep password managers from filling or offering to store it.
        autocomplete: "new-password",
        autocapitalize: "off",
        placeholder: "Paste a new value",
        "aria-describedby": inputId + "-help",
      }));
      const save = actionButton({ label: "Save", iconName: "key", cls: "primary", type: "submit" });
      const test = actionButton({ label: "Test", iconName: "play", onclick: () => testKey(name) });
      const row = {
        name, input, save, test,
        status: el("span", "row tight wrap"),
        label: el("label", { class: "field-label", for: inputId }),
        error: el("div", { class: "field-error pre", role: "alert", hidden: true }),
        result: el("div", { class: "stack tight settings-key-result", "aria-live": "polite" }),
        field: null,
        node: null,
      };
      row.field = el("div", "field",
        row.label,
        el("div", "row", input, save.node, test.node),
        el("div", { class: "field-help", id: inputId + "-help" },
          "Write-only: what you type is sent once and never shown again. " + info.testNote),
        row.error);
      row.node = el("div", { class: "settings-key", dataset: { key: name } },
        el("div", "row wrap", el("code", "settings-key-name", name), row.status),
        el("p", "small dim", info.purpose),
        el("form", { class: "settings-key-form", autocomplete: "off", onsubmit: (event) => { event.preventDefault(); saveKey(name); } }, row.field),
        row.result);
      input.addEventListener("input", () => showError(row, null));
      return row;
    }

    async function saveKey(name) {
      const row = rows.get(name);
      const p = state.payload;
      if (!row || !p || row.save.busy || lanLock()) return;
      const value = row.input.value.trim();
      const problem = checkKeyValue(value);
      if (problem) {
        showError(row, problem);
        row.input.focus();
        return;
      }
      showError(row, null);
      const entry = (p.keys && p.keys[name]) || {};
      const file = (p.paths && p.paths.env_file) || ".env";
      if (entry.set) {
        // The old value cannot be read back from anywhere in the console.
        const ok = await ask({
          title: "Replace " + name + "?",
          body: el("div", "stack tight",
            el("p", null, "The stored key" + (entry.last4 ? " ending in " + entry.last4 : "") + " is overwritten in ",
              el("code", null, file), ". It cannot be recovered from this page."),
            el("p", "dim", "Runs launched from now on use the new key. A run that is already going keeps the key it was started with.")),
          okLabel: "Replace key",
          tone: "danger",
        });
        if (!ok || !alive) return;
      }
      row.save.setBusy(true);
      row.input.disabled = true;
      try {
        const out = await api.put(keyUrl(name), { value }, { signal, timeoutMs: REQUEST_MS });
        if (!alive) return;
        row.input.value = "";
        if (state.payload) {
          const keys = { ...state.payload.keys, [name]: { ...entry, set: out.set !== false, last4: out.last4 ?? null } };
          state.payload = { ...state.payload, keys };
        }
        replace(row.result, el("div", "small dim", "Saved at " + fmtTime(new Date()) + ". Not tested since: use Test to check it."));
        toast(name + " saved. Runs launched from now on use it.", "ok");
        renderAll();
        loadSettings({ quiet: true });
      } catch (err) {
        if (isAbort(err) || !alive) return;
        showError(row, "Not saved. " + errorText(err));
      } finally {
        if (alive) {
          row.save.setBusy(false);
          row.input.disabled = Boolean(lanLock());
        }
      }
    }

    async function testKey(name) {
      const row = rows.get(name);
      if (!row || row.test.busy || lanLock()) return;
      const typed = row.input.value !== "";
      row.test.setBusy(true);
      replace(row.result, waitLine("Testing the stored key…"));
      try {
        const out = await api.post(keyUrl(name, "/test"), undefined, { signal, timeoutMs: KEY_TEST_MS });
        if (!alive) return;
        const lines = keyTestLines(out).map((line) =>
          el("div", "row tight top settings-test-line is-" + line.kind, icon(line.icon), el("span", "wrap-any", line.text)));
        replace(row.result,
          el("div", "small dim", "Tested at " + fmtTime(new Date()) + ":"),
          lines,
          typed ? el("div", "small dim", "This tested the stored key, not the value typed above. Save it first to test the new one.") : null);
      } catch (err) {
        if (isAbort(err) || !alive) return;
        replace(row.result, failure(err, "The test could not be run.", () => testKey(name)));
      } finally {
        if (alive) row.test.setBusy(false);
      }
    }

    function render() {
      const p = state.payload;
      if (!p) {
        f.showWait("Loading the keys…");
        return;
      }
      f.showContent();
      const lock = lanLock();
      const chips = store.state.health || {};
      replace(notes,
        lock ? notice("warn",
          el("div", "strong", "Keys cannot be changed or tested from the browser: " + lock + "."),
          el("div", null, "A browser on another machine must not be able to read or replace them. Edit ",
            el("code", null, (p.paths && p.paths.env_file) || ".env"),
            " on the server's machine, or switch LAN access off and restart the server.")) : null,
        chips.fake_model ? notice("info",
          el("div", "strong", "This server uses the built-in demo model."),
          el("div", null, "Runs do not call OpenAI and their answers are made up, whatever key is set here. Restart the server without ASTROLABIO_FAKE_MODEL for a real run.")) : null);
      for (const name of KEY_NAMES) {
        if (!rows.has(name)) {
          rows.set(name, build(name));
          list.append(rows.get(name).node);
        }
        const row = rows.get(name);
        const entry = (p.keys && p.keys[name]) || {};
        const status = keyStatus(name, entry);
        const checked = name === "OPENAI_API_KEY" && entry.set && chips.openai ? chips.openai.ok : null;
        replace(row.status,
          badge(status.text, status.kind, status.icon),
          checked === true ? badge("last check: working", "ok", "check") : null,
          checked === false ? badge("last check: failed", "bad", "alert") : null);
        row.label.textContent = (entry.set ? "Replace " : "Set ") + name;
        row.save.setLabel(entry.set ? "Replace" : "Save");
        row.input.disabled = Boolean(lock) || row.save.busy;
        row.save.setDisabled(Boolean(lock), lock ? "Locked: " + lock : "");
        row.test.setDisabled(Boolean(lock) || !entry.set, lock ? "Locked: " + lock : !entry.set ? "Nothing to test: the key is not set" : "");
      }
      replace(where, "Saving writes one line of ", el("code", null, (p.paths && p.paths.env_file) || ".env"),
        " and updates the running server. The page receives only whether a key is set, and the last four characters of the OpenAI key.");
      const openai = (p.keys && p.keys.OPENAI_API_KEY) || {};
      replace(f.marks, openai.set ? null : badge("OpenAI key missing", "bad", "x"));
    }

    return {
      id: f.id, node: f.node, render,
      mark() {
        const p = state.payload;
        if (!p) return null;
        return p.keys && p.keys.OPENAI_API_KEY && p.keys.OPENAI_API_KEY.set ? null : badge("missing", "bad", "x");
      },
      unsaved: () => 0,
      // A typed key must not stay in a detached field.
      dispose() { for (const row of rows.values()) row.input.value = ""; },
    };
  }

  // ------------------------------------------------------------ defaults for new runs

  function defaultsSection() {
    const f = frame("defaults", "Defaults for new runs");
    const groups = el("div", "stack loose");
    const problem = el("div", { hidden: true });
    f.content.append(
      el("p", "dim", "These fill the New run form. They apply to runs launched from now on; a run that has started keeps the settings it was launched with, because its prompt and tool list must not change under it."),
      groups, problem);
    const bar = saveBar({ saveLabel: "Save defaults", idle: "No unsaved changes.", onSave: save, onDiscard: discard });
    f.node.append(bar.node);

    let rows = new Map(); // field key -> row
    let signature = null;
    let serverErrors = {};
    let saving = false;

    const fields = () => (state.payload && state.payload.fields) || [];
    const defaults = () => (state.payload && state.payload.defaults) || {};
    const overridden = () => (state.payload && state.payload.overridden) || [];
    const plan = () => buildDefaultsBody(fields(), defaults(), kept.defaults, kept.resets);

    function changed(field, row) {
      const raw = row.read();
      if (isDirty(field, readPath(defaults(), field.key), raw)) kept.defaults.set(field.key, raw);
      else kept.defaults.delete(field.key);
      delete serverErrors[field.key];
      refresh();
      renderNav();
    }

    function buildControl(field, id, helpId, onChange) {
      const kind = controlKind(field);
      if (kind === "bool") {
        const input = el("input", { type: "checkbox", id, role: "switch", "aria-describedby": helpId, onchange: onChange });
        const word = el("span", "settings-switch-word");
        return {
          node: el("label", "switch", input, el("span", "switch-track"), word),
          read: () => input.checked,
          write: (raw) => { input.checked = raw === true; },
          paint: () => { word.textContent = input.checked ? "On" : "Off"; },
          disable: (on) => { input.disabled = on; },
          focus: () => input.focus(),
        };
      }
      if (kind === "tools") {
        const boxes = (field.choices || []).map((name) => {
          const box = el("input", { type: "checkbox", value: String(name), onchange: onChange });
          return { name: String(name), box, node: el("label", "check", box, el("code", null, String(name))) };
        });
        return {
          node: el("div", { class: "settings-tools", role: "group", "aria-labelledby": id + "-label", "aria-describedby": helpId },
            boxes.length ? boxes.map((item) => item.node) : el("span", "dim", "No tool can be switched off.")),
          read: () => boxes.filter((item) => item.box.checked).map((item) => item.name).sort(),
          write: (raw) => { for (const item of boxes) item.box.checked = Array.isArray(raw) && raw.includes(item.name); },
          paint: () => {},
          disable: (on) => { for (const item of boxes) item.box.disabled = on; },
          focus: () => { if (boxes[0]) boxes[0].box.focus(); },
        };
      }
      if (kind === "choice") {
        const select = el("select", { id, "aria-describedby": helpId, onchange: onChange },
          (field.choices || []).map((choice) => el("option", { value: String(choice) }, String(choice))));
        return {
          node: select,
          read: () => select.value,
          write: (raw) => {
            const value = String(raw ?? "");
            // A saved value the server no longer offers stays visible instead of silently becoming the first choice.
            if (!Array.from(select.options).some((option) => option.value === value)) {
              select.append(el("option", { value }, value === "" ? "(not set)" : value + " (not offered any more)"));
            }
            select.value = value;
          },
          paint: () => {},
          disable: (on) => { select.disabled = on; },
          focus: () => select.focus(),
        };
      }
      const numeric = kind === "int" || kind === "number";
      // Text, not type=number: a wheel over a focused number field changes it without anyone noticing.
      const input = plain(el("input", {
        type: "text",
        id,
        class: numeric ? "num settings-number" : "settings-text",
        inputmode: kind === "int" ? "numeric" : kind === "number" ? "decimal" : null,
        // Room to go over the limit, so a long paste is reported instead of silently cut.
        maxlength: !numeric && typeof field.max_length === "number" ? field.max_length + 20 : null,
        autocomplete: "off",
        "aria-describedby": helpId,
        oninput: onChange,
      }));
      const unit = field.unit ? el("span", "settings-unit dim small") : null;
      return {
        node: unit ? el("div", "row tight", input, unit) : input,
        read: () => input.value,
        write: (raw) => { input.value = String(raw ?? ""); },
        paint: () => {
          if (!unit) return;
          const n = Number(input.value);
          const long = field.unit === "s" && input.value.trim() !== "" && Number.isFinite(n) && n >= 60;
          unit.textContent = field.unit + (long ? " = " + fmtDuration(n) : "");
        },
        disable: (on) => { input.disabled = on; },
        focus: () => input.focus(),
      };
    }

    function buildField(field) {
      const id = "settings-default-" + String(field.key).replace(/[^\w-]/g, "-");
      const helpId = id + "-help";
      const row = { field };
      const control = buildControl(field, id, helpId, () => changed(field, row));
      const isGroup = controlKind(field) === "tools";
      const bounds = [];
      if (typeof field.min === "number") bounds.push("from " + field.min);
      if (typeof field.max === "number") bounds.push("to " + field.max);
      Object.assign(row, control, {
        marks: el("span", "row tight settings-field-marks"),
        error: el("div", { class: "field-error", role: "alert", hidden: true }),
        reset: el("div", { class: "row tight wrap small settings-field-reset", hidden: true }),
      });
      row.node = el("div", { class: "field settings-field" + (isGroup ? " is-wide" : ""), dataset: { key: field.key } },
        el("div", "row tight spread",
          isGroup
            ? el("span", { class: "field-label", id: id + "-label" }, field.label)
            : el("label", { class: "field-label", for: id }, field.label),
          row.marks),
        control.node,
        el("div", { class: "field-help", id: helpId }, field.help || "", bounds.length ? " Allowed: " + bounds.join(" ") + "." : ""),
        row.error,
        row.reset);
      return row;
    }

    function build() {
      rows = new Map();
      const nodes = [];
      for (const group of groupFields(fields())) {
        const blocks = fieldBlocks(group.fields).map((block) => {
          const grid = el("div", "settings-fields" + (block.prefix ? " is-budget" : ""));
          for (const field of block.fields) {
            const row = buildField(field);
            rows.set(field.key, row);
            grid.append(row.node);
          }
          return grid;
        });
        nodes.push(el("section", { class: "stack settings-group", "aria-label": group.group },
          el("h3", "section-title", group.group), blocks));
      }
      replace(groups, nodes.length ? nodes : el("div", "empty", el("div", "empty-title", "The server lists no setting"),
        el("div", null, "Nothing can be saved as a default here. Reload the page; if this stays empty the server is older than this page.")));
    }

    function stageReset(field) {
      kept.resets.add(topKey(field.key));
      for (const other of resetScope(field, fields())) {
        kept.defaults.delete(other.key);
        delete serverErrors[other.key];
      }
      refresh({ write: true });
      renderNav();
    }

    function undoReset(field) {
      kept.resets.delete(topKey(field.key));
      refresh({ write: true });
      renderNav();
    }

    /** Bring every field in line with the payload and the drafts. `write` also sets the controls. */
    function refresh({ write = false } = {}) {
      const now = plan();
      const saved = defaults();
      const marked = overridden();
      for (const [key, row] of rows) {
        const field = row.field;
        const top = topKey(key);
        const resetting = kept.resets.has(top);
        const dirty = kept.defaults.has(key);
        if (write) {
          const raw = dirty ? kept.defaults.get(key) : toRaw(field, readPath(saved, key));
          // Only touch a control whose content really differs: rewriting moves the caret.
          if (!sameRaw(row.read(), raw)) row.write(raw);
        }
        row.paint();
        row.disable(resetting || saving);
        const error = now.errors[key] || (serverErrors[key] || []).join(" ") || null;
        row.error.hidden = !error;
        row.error.textContent = error || "";
        row.node.classList.toggle("invalid", Boolean(error));
        row.node.classList.toggle("is-changed", dirty || resetting);
        replace(row.marks,
          resetting ? badge("reset on save", "warn", "refresh") : dirty ? badge("changed", "warn", "dot") : null);
        const scope = resetScope(field, fields());
        const whole = scope.length > 1 ? " (the whole " + top + " budget: " + plural(scope.length, "field") + ")" : "";
        // A budget is reset as one: its button sits on the first of its fields in each group.
        const lead = scope.find((other) => other.group === field.group);
        const leads = scope.length <= 1 || Boolean(lead && lead.key === key);
        if (resetting) {
          row.reset.hidden = false;
          replace(row.reset,
            el("span", "dim", leads ? "Returns to the built-in value when saved" + whole + "." : "Returns to built-in with the " + top + " budget."),
            leads ? el("button", { type: "button", class: "ghost small", onclick: () => undoReset(field) }, "Undo") : null);
        } else if (canReset(field, marked)) {
          row.reset.hidden = false;
          replace(row.reset,
            el("span", "dim", leads ? "Saved here." : "Saved here with the " + top + " budget."),
            leads ? el("button", {
              type: "button",
              class: "ghost small",
              title: "Forget the saved value" + whole + ". The field then follows the server's own configuration again. Applied when you save.",
              disabled: saving,
              onclick: () => stageReset(field),
            }, icon("refresh"), scope.length > 1 ? "Reset " + top + " budget to built-in" : "Reset to built-in") : null);
        } else {
          row.reset.hidden = true;
          replace(row.reset);
        }
      }
      const labels = now.changed.map((key) => rows.get(key).field.label)
        .concat(Object.keys(now.errors).filter((key) => !now.changed.includes(key) && rows.has(key)).map((key) => rows.get(key).field.label))
        .concat(now.resets.map((top) => top + " (reset)"));
      bar.set({ names: labels, invalid: Object.keys(now.errors).length > 0 });
      bar.save.setBusy(saving);
    }

    async function discard() {
      const count = unsaved();
      if (!count) return;
      const ok = await ask({
        title: "Discard " + plural(count, "unsaved change") + "?",
        body: "The form goes back to the saved defaults. Nothing is sent to the server.",
        okLabel: "Discard",
      });
      if (!ok || !alive) return;
      kept.defaults.clear();
      kept.resets.clear();
      serverErrors = {};
      problem.hidden = true;
      refresh({ write: true });
      renderNav();
    }

    async function save() {
      if (saving || !state.payload) return;
      const now = plan();
      const invalid = Object.keys(now.errors);
      if (invalid.length) {
        refresh();
        const first = rows.get(invalid[0]);
        if (first) first.focus();
        return;
      }
      if (!now.body) return;
      const sent = new Map(now.changed.map((key) => [key, JSON.stringify(kept.defaults.get(key))]));
      saving = true;
      problem.hidden = true;
      refresh();
      try {
        const out = await api.put(SETTINGS_URL, { defaults: now.body }, { signal, timeoutMs: REQUEST_MS });
        if (!alive) return;
        // A field edited again while the request was on its way stays a draft.
        for (const [key, raw] of sent) {
          if (JSON.stringify(kept.defaults.get(key)) === raw) kept.defaults.delete(key);
        }
        for (const top of now.resets) kept.resets.delete(top);
        serverErrors = {};
        saving = false;
        adopt(out);
        toast("Defaults saved. They apply to runs launched from now on.", "ok");
      } catch (err) {
        saving = false;
        if (isAbort(err) || !alive) return;
        const sorted = problemsByField(err.problems, Array.from(rows.keys()));
        serverErrors = sorted.byKey;
        const placed = Object.keys(sorted.byKey).length > 0 && sorted.rest.length === 0;
        problem.hidden = false;
        replace(problem, placed
          ? notice("bad", el("div", "strong", "The defaults were not saved."), el("div", null, "The server refused the marked fields. Correct them and save again."))
          : failure(err, "The defaults were not saved.", null));
        refresh();
      }
    }

    function unsaved() {
      const now = plan();
      return now.changed.length + now.resets.length + Object.keys(now.errors).filter((key) => !now.changed.includes(key)).length;
    }

    function render() {
      const p = state.payload;
      bar.node.hidden = !p;
      if (!p) {
        f.showWait("Loading the defaults…");
        return;
      }
      f.showContent();
      const next = JSON.stringify(p.fields || []);
      if (next !== signature) {
        signature = next;
        build();
      }
      // Drafts the payload has caught up with (saved from another tab), or for fields that are gone.
      for (const [key, raw] of Array.from(kept.defaults)) {
        const row = rows.get(key);
        if (!row || !isDirty(row.field, readPath(p.defaults || {}, key), raw)) kept.defaults.delete(key);
      }
      for (const top of Array.from(kept.resets)) {
        if (!(p.overridden || []).includes(top)) kept.resets.delete(top);
      }
      refresh({ write: true });
      const count = (p.overridden || []).length;
      replace(f.marks, count ? badge(plural(count, "value") + " saved here", "dim", "info") : badge("all built-in", "dim", "info"));
    }

    return {
      id: f.id, node: f.node, render, unsaved,
      mark() {
        const count = state.payload ? unsaved() : 0;
        return count ? badge(count + " unsaved", "warn", "dot") : null;
      },
      dispose() {},
    };
  }

  // ------------------------------------------------------------ organiser answers

  function organiserSection() {
    const f = frame("organiser", "Organiser answers");
    const list = el("div", "settings-answers");
    const problem = el("div", { hidden: true });
    f.content.append(
      el("p", "dim", "The open questions to the organisers (Q1 to Q12), what the agent assumes until they answer, and what they said. Changing an answer changes the default for new runs only; the note is for the team and reaches no run."),
      list, problem);
    const bar = saveBar({ saveLabel: "Save answers", idle: "No unsaved changes.", onSave: save, onDiscard: discard });
    f.node.append(bar.node);

    let rows = new Map();
    let signature = null;
    let serverErrors = {};
    let saving = false;

    const answers = () => (state.payload && state.payload.organiser_answers) || [];
    const fields = () => (state.payload && state.payload.fields) || [];
    const plan = () => buildAnswersBody(answers(), kept.answers);

    function setDraft(answer, part, value) {
      const draft = { ...(kept.answers.get(answer.id) || {}) };
      if (part === "value") {
        if (sameValue(value, answer.value)) delete draft.value;
        else draft.value = value;
      } else if (value.trim() === String(answer.note || "")) delete draft.note;
      else draft.note = value;
      if (Object.keys(draft).length) kept.answers.set(answer.id, draft);
      else kept.answers.delete(answer.id);
      delete serverErrors[answer.id];
      refresh();
      renderNav();
    }

    function buildAnswer(answer) {
      const id = "settings-answer-" + answer.id;
      const control = answerControl(answer, fields());
      const row = { id: answer.id, control, input: null, word: null };
      const current = () => answers().find((item) => item.id === answer.id) || answer;
      let answerNode;
      if (control.kind === "bool") {
        row.input = el("input", { type: "checkbox", id: id + "-value", role: "switch", onchange: () => setDraft(current(), "value", row.input.checked) });
        row.word = el("span", "settings-switch-word");
        answerNode = el("div", "field",
          el("label", { class: "field-label", for: id + "-value" }, control.field.label),
          el("label", "switch", row.input, el("span", "switch-track"), row.word));
      } else if (control.kind === "choice") {
        row.input = el("select", { id: id + "-value", onchange: () => setDraft(current(), "value", row.input.value) },
          control.choices.map((choice) => el("option", { value: choice }, choice)));
        answerNode = el("div", "field",
          el("label", { class: "field-label", for: id + "-value" }, control.field.label), row.input);
      } else if (control.kind === "fixed") {
        answerNode = el("div", "field",
          el("span", "field-label", "Answer in force"),
          el("span", null, answer.setting === "clock_start" ? "The clock starts at launch." : String(answer.value ?? "–")));
      } else {
        answerNode = el("div", "field",
          el("span", "field-label", "Answer in force"),
          el("span", "dim", "No switch: the default stands."));
      }
      row.note = el("textarea", {
        id: id + "-note",
        class: "settings-note",
        rows: 2,
        maxlength: NOTE_MAX + 200,
        placeholder: "What the organisers said, who said it, and when",
        "aria-describedby": id + "-noted",
        oninput: () => setDraft(current(), "note", row.note.value),
      });
      row.noted = el("div", { class: "field-help", id: id + "-noted" });
      row.marks = el("span", "row tight");
      row.error = el("div", { class: "field-error", role: "alert", hidden: true });
      row.node = el("article", { class: "settings-answer", dataset: { key: answer.id }, "aria-labelledby": id + "-q" },
        el("div", "stack tight settings-answer-q",
          el("div", "row tight top", badge(answer.id, "info"), el("h3", { class: "grow settings-answer-question", id: id + "-q" }, answer.question), row.marks),
          el("dl", "kv small",
            el("dt", null, "Assumed until answered"), el("dd", null, answer.default || "–"),
            el("dt", null, "Where it acts"), el("dd", null, answer.control || "–"),
            el("dt", null, "What an answer changes"), el("dd", null, answerEffect(answer, fields())))),
        el("div", "stack tight settings-answer-a",
          answerNode,
          el("div", "field",
            el("label", { class: "field-label", for: id + "-note" }, "Note"),
            row.note, row.noted),
          row.error));
      return row;
    }

    function build() {
      rows = new Map();
      const nodes = answers().map((answer) => {
        const row = buildAnswer(answer);
        rows.set(answer.id, row);
        return row.node;
      });
      replace(list, nodes.length ? nodes : el("div", "empty", el("div", "empty-title", "No organiser question is listed"),
        el("div", null, "The server sent an empty table. Reload the page.")));
    }

    function refresh({ write = false } = {}) {
      const now = plan();
      for (const answer of answers()) {
        const row = rows.get(answer.id);
        if (!row) continue;
        const draft = kept.answers.get(answer.id) || {};
        if (write) {
          if (row.control.kind === "bool") {
            const want = (draft.value !== undefined ? draft.value : answer.value) === true;
            if (row.input.checked !== want) row.input.checked = want;
          } else if (row.control.kind === "choice") {
            const want = String(draft.value !== undefined ? draft.value : answer.value ?? "");
            if (!Array.from(row.input.options).some((option) => option.value === want)) {
              row.input.append(el("option", { value: want }, want === "" ? "(not set)" : want + " (not offered any more)"));
            }
            if (row.input.value !== want) row.input.value = want;
          }
          const text = typeof draft.note === "string" ? draft.note : String(answer.note || "");
          if (row.note.value !== text) row.note.value = text;
        }
        if (row.word) row.word.textContent = row.input.checked ? "On" : "Off";
        if (row.input) row.input.disabled = saving;
        row.note.disabled = saving;
        const dirty = now.changed.includes(answer.id) || Boolean(now.errors[answer.id]);
        row.node.classList.toggle("is-changed", dirty);
        replace(row.marks, dirty ? badge("changed", "warn", "dot") : null);
        const length = row.note.value.trim().length;
        replace(row.noted,
          answer.noted_at ? "Note last saved " + fmtDateTime(answer.noted_at) + "." : "No note saved yet.",
          length > NOTE_MAX * 0.8 ? el("span", "num", " " + fmtInt(length) + " of " + fmtInt(NOTE_MAX) + " characters.") : null);
        const error = now.errors[answer.id] || (serverErrors[answer.id] || []).join(" ") || null;
        row.error.hidden = !error;
        row.error.textContent = error || "";
        row.node.classList.toggle("invalid", Boolean(error));
      }
      const names = Array.from(new Set(now.changed.concat(Object.keys(now.errors))));
      bar.set({ names, invalid: Object.keys(now.errors).length > 0 });
      bar.save.setBusy(saving);
    }

    async function discard() {
      const count = unsaved();
      if (!count) return;
      const ok = await ask({
        title: "Discard " + plural(count, "unsaved answer") + "?",
        body: "Answers and notes go back to what is saved. Nothing is sent to the server.",
        okLabel: "Discard",
      });
      if (!ok || !alive) return;
      kept.answers.clear();
      serverErrors = {};
      problem.hidden = true;
      refresh({ write: true });
      renderNav();
    }

    async function save() {
      if (saving || !state.payload) return;
      const now = plan();
      if (Object.keys(now.errors).length) {
        refresh();
        const first = rows.get(Object.keys(now.errors)[0]);
        if (first) first.note.focus();
        return;
      }
      if (!now.items.length) return;
      const sent = new Map(now.changed.map((id) => [id, JSON.stringify(kept.answers.get(id))]));
      const values = now.items.filter((item) => "value" in item).length;
      saving = true;
      problem.hidden = true;
      refresh();
      try {
        const out = await api.put(SETTINGS_URL, { organiser_answers: now.items }, { signal, timeoutMs: REQUEST_MS });
        if (!alive) return;
        for (const [id, raw] of sent) {
          if (JSON.stringify(kept.answers.get(id)) === raw) kept.answers.delete(id);
        }
        serverErrors = {};
        saving = false;
        adopt(out);
        toast(values
          ? "Organiser answers saved. The changed defaults apply to runs launched from now on."
          : "Notes saved.", "ok");
      } catch (err) {
        saving = false;
        if (isAbort(err) || !alive) return;
        const sorted = problemsByField(err.problems, Array.from(rows.keys()));
        serverErrors = sorted.byKey;
        const placed = Object.keys(sorted.byKey).length > 0 && sorted.rest.length === 0;
        problem.hidden = false;
        replace(problem, placed
          ? notice("bad", el("div", "strong", "The answers were not saved."), el("div", null, "The server refused the marked questions. Correct them and save again."))
          : failure(err, "The answers were not saved.", null));
        refresh();
      }
    }

    function unsaved() {
      const now = plan();
      return new Set(now.changed.concat(Object.keys(now.errors))).size;
    }

    function render() {
      const p = state.payload;
      bar.node.hidden = !p;
      if (!p) {
        f.showWait("Loading the organiser answers…");
        return;
      }
      f.showContent();
      // The questions and the controls they need; values and notes are refreshed in place.
      const next = JSON.stringify([answers().map((a) => [a.id, a.question, a.default, a.control, a.setting]),
        answers().map((a) => answerControl(a, fields()))]);
      if (next !== signature) {
        signature = next;
        build();
      }
      for (const [id, draft] of Array.from(kept.answers)) {
        const answer = answers().find((item) => item.id === id);
        if (!answer) {
          kept.answers.delete(id);
          continue;
        }
        const left = { ...draft };
        if (left.value !== undefined && sameValue(left.value, answer.value)) delete left.value;
        if (typeof left.note === "string" && left.note.trim() === String(answer.note || "")) delete left.note;
        if (Object.keys(left).length) kept.answers.set(id, left);
        else kept.answers.delete(id);
      }
      refresh({ write: true });
      const noted = answers().filter((answer) => answer.note).length;
      replace(f.marks, badge(noted + " of " + answers().length + " with a note", "dim", "info"));
    }

    return {
      id: f.id, node: f.node, render, unsaved,
      mark() {
        const count = state.payload ? unsaved() : 0;
        return count ? badge(count + " unsaved", "warn", "dot") : null;
      },
      dispose() {},
    };
  }

  // ------------------------------------------------------------ directories

  function pathsSection() {
    const f = frame("paths", "Directories");
    const lockNote = el("div", { hidden: true });
    const dirs = el("div", "settings-dirs");
    const fixed = el("dl", "kv");
    const rootsBox = el("div", "stack tight");
    const problem = el("div", { hidden: true });
    f.content.append(
      el("p", "dim", "Where the server keeps its files. A change is saved now and used from the next start of the server; the running server and its runs stay where they are."),
      lockNote, dirs, fixed,
      el("div", "stack tight",
        el("h3", "section-title", "Folders the console may read panoramas from"),
        el("p", "dim small", "The folder browser of New run, and a set given as a path, are confined to these and what lies inside them. Uploads do not need them."),
        rootsBox),
      problem);
    const bar = saveBar({ saveLabel: "Save directories", idle: "No unsaved changes.", onSave: save, onDiscard: discard });
    f.node.append(bar.node);

    const DIRS = [
      { key: "runs_dir", label: "Runs directory", env: "RUNS_DIR", help: "One folder per run: logs, exports, images." },
      { key: "cache_dir", label: "Cache directory", env: "CACHE_DIR", help: "Cached lookups and panorama previews." },
    ];
    const rows = new Map();
    let serverErrors = {};
    let rootError = null;
    let saving = false;
    let built = false;
    const addInput = plain(el("input", {
      type: "text", id: "settings-root-add", class: "mono grow", autocomplete: "off",
      placeholder: "/Volumes/USB or ~/Pictures/panoramas",
      onkeydown: (event) => { if (event.key === "Enter") { event.preventDefault(); add(); } },
      oninput: () => { if (rootError) { rootError = null; rootProblem.hidden = true; } },
    }));
    const rootProblem = el("div", { class: "field-error", role: "alert", hidden: true });

    const p = () => state.payload.paths || {};
    const plan = () => buildPathsBody(p(), kept.paths);
    const rootList = () => (Array.isArray(kept.paths.roots) ? kept.paths.roots : editableRoots(p().allowed_roots, p().data_dir));

    function build() {
      built = true;
      for (const dir of DIRS) {
        const id = "settings-path-" + dir.key;
        const row = {
          dir,
          now: el("code", "wrap-any"),
          marks: el("span", "row tight"),
          input: plain(el("input", {
            type: "text", id, class: "mono", autocomplete: "off",
            "aria-describedby": id + "-help",
            oninput: () => {
              const saved = (p().saved && p().saved[dir.key]) || "";
              if (row.input.value.trim() === saved) delete kept.paths[dir.key];
              else kept.paths[dir.key] = row.input.value;
              delete serverErrors["paths." + dir.key];
              refresh();
              renderNav();
            },
          })),
          help: el("div", { class: "field-help", id: id + "-help" }),
          error: el("div", { class: "field-error", role: "alert", hidden: true }),
        };
        row.node = el("div", { class: "field settings-dir", dataset: { key: dir.key } },
          el("div", "row tight spread", el("label", { class: "field-label", for: id }, dir.label + ", from the next start"), row.marks),
          row.input, row.help, row.error,
          el("div", "small", el("span", "dim", "In use now: "), row.now));
        rows.set(dir.key, row);
        dirs.append(row.node);
      }
    }

    function add() {
      const out = addRoot(rootList(), addInput.value);
      rootError = out.error;
      if (!out.error) {
        kept.paths.roots = out.list;
        addInput.value = "";
        delete serverErrors["paths.allowed_roots"];
      }
      refresh();
      renderNav();
    }

    function remove(root) {
      kept.paths.roots = rootList().filter((item) => item !== root);
      delete serverErrors[root];
      refresh();
      renderNav();
    }

    function renderRoots() {
      const lock = lanLock();
      const data = p().data_dir;
      const always = (p().allowed_roots || []).filter((root) => isSetsRoot(root, data));
      if (kept.paths.roots === null) {
        replace(rootsBox,
          notice("warn",
            el("div", null, "On save the list goes back to the usual places: Downloads, Desktop and removable volumes, where they exist."),
            el("div", null, el("button", { type: "button", class: "small", onclick: () => { delete kept.paths.roots; refresh(); renderNav(); } }, "Undo"))));
        return;
      }
      const list = rootList();
      const items = always.map((root) => el("li", "row tight settings-root",
        icon("lock"), el("code", "grow wrap-any", root), badge("always allowed: uploaded sets", "dim", "lock")));
      for (const root of list) {
        const errors = serverErrors[root] || [];
        items.push(el("li", "settings-root" + (errors.length ? " invalid" : ""),
          el("div", "row tight",
            icon("folder"), el("code", "grow wrap-any", root),
            el("button", {
              type: "button", class: "icon-btn small", title: "Remove " + root, "aria-label": "Remove " + root,
              disabled: Boolean(lock) || saving, onclick: () => remove(root),
            }, icon("x"))),
          errors.length ? el("div", { class: "field-error", role: "alert" }, errors.join(" ")) : null));
      }
      if (!list.length) {
        items.push(el("li", "dim small", "No other folder: the folder browser shows only uploaded sets, and sets can only be uploaded."));
      }
      addInput.disabled = Boolean(lock) || saving;
      const general = (serverErrors["paths.allowed_roots"] || []).join(" ");
      replace(rootsBox,
        el("ul", "settings-roots", items),
        el("div", "field",
          el("label", { class: "field-label", for: "settings-root-add" }, "Add a folder"),
          el("div", "row",
            addInput,
            el("button", { type: "button", disabled: Boolean(lock) || saving, onclick: add }, icon("plus"), "Add"),
            el("button", {
              type: "button", class: "ghost", disabled: Boolean(lock) || saving,
              title: "Forget this list and use Downloads, Desktop and removable volumes. Applied when you save.",
              onclick: () => { kept.paths.roots = null; rootError = null; refresh(); renderNav(); },
            }, icon("refresh"), "Use the usual places")),
          el("div", "field-help", "An absolute path that exists on the server's machine. Not the home folder itself, and not a folder that holds runs, settings or evaluation data: the server refuses those."),
          rootProblem));
      rootProblem.hidden = !(rootError || general);
      rootProblem.textContent = rootError || general || "";
    }

    function refresh({ write = false } = {}) {
      const lock = lanLock();
      const now = plan();
      const waiting = state.payload.restart_required || [];
      for (const [key, row] of rows) {
        const saved = (p().saved && p().saved[key]) || "";
        if (write) {
          const text = typeof kept.paths[key] === "string" ? kept.paths[key] : saved;
          if (row.input.value !== text) row.input.value = text;
        }
        row.input.disabled = Boolean(lock) || saving;
        row.input.placeholder = "Follows " + row.dir.env + " or the built-in folder";
        row.now.textContent = p()[key] || "–";
        const dirty = now.changed.includes(key);
        row.node.classList.toggle("is-changed", dirty);
        replace(row.marks,
          dirty ? badge("changed", "warn", "dot") : waiting.includes(key) ? badge("restart needed", "warn", "refresh") : null);
        row.help.textContent = row.dir.help + " Leave empty to follow the environment variable " + row.dir.env + ". Existing files are not moved.";
        const error = (serverErrors["paths." + key] || []).join(" ") || null;
        row.error.hidden = !error;
        row.error.textContent = error || "";
        row.node.classList.toggle("invalid", Boolean(error));
      }
      renderRoots();
      const words = { runs_dir: "runs directory", cache_dir: "cache directory", allowed_roots: "folders" };
      bar.set({ names: now.changed.map((key) => words[key]), lock: lock ? "Locked: " + lock + "." : null });
      bar.save.setBusy(saving);
    }

    async function discard() {
      if (!plan().changed.length) return;
      const ok = await ask({
        title: "Discard the unsaved directory changes?",
        body: "The fields and the folder list go back to what is saved. Nothing is sent to the server.",
        okLabel: "Discard",
      });
      if (!ok || !alive) return;
      kept.paths = {};
      serverErrors = {};
      rootError = null;
      problem.hidden = true;
      refresh({ write: true });
      renderNav();
    }

    async function save() {
      if (saving || !state.payload || lanLock()) return;
      const now = plan();
      if (!now.body) return;
      const sent = JSON.stringify(kept.paths);
      saving = true;
      problem.hidden = true;
      refresh();
      try {
        const out = await api.put(SETTINGS_URL, { paths: now.body }, { signal, timeoutMs: REQUEST_MS });
        if (!alive) return;
        if (JSON.stringify(kept.paths) === sent) kept.paths = {};
        serverErrors = {};
        saving = false;
        const needs = (out.restart_required || []).filter((key) => key !== "lan");
        adopt(out);
        toast(needs.length
          ? "Directories saved. Restart the server to start using " + restartWords(needs) + "."
          : "Directories saved.", needs.length ? "warn" : "ok");
      } catch (err) {
        saving = false;
        if (isAbort(err) || !alive) return;
        const known = ["paths.runs_dir", "paths.cache_dir", "paths.allowed_roots"].concat(rootList());
        const sorted = problemsByField(err.problems, known);
        serverErrors = sorted.byKey;
        const placed = Object.keys(sorted.byKey).length > 0 && sorted.rest.length === 0;
        problem.hidden = false;
        replace(problem, placed
          ? notice("bad", el("div", "strong", "The directories were not saved."), el("div", null, "The server refused the marked entries. Correct them and save again."))
          : failure(err, "The directories were not saved.", null));
        refresh();
      }
    }

    function render() {
      bar.node.hidden = !state.payload;
      if (!state.payload) {
        f.showWait("Loading the directories…");
        return;
      }
      f.showContent();
      if (!built) build();
      const lock = lanLock();
      lockNote.hidden = !lock;
      if (lock) {
        replace(lockNote, notice("warn",
          el("div", "strong", "Directories cannot be changed: " + lock + "."),
          el("div", null, "A browser on another machine must not be able to widen what the server's disk shows. Switch LAN access off, restart the server, then change them here.")));
      }
      // Drafts the payload has caught up with.
      for (const dir of DIRS) {
        const saved = (p().saved && p().saved[dir.key]) || "";
        if (typeof kept.paths[dir.key] === "string" && kept.paths[dir.key].trim() === saved) delete kept.paths[dir.key];
      }
      if (Array.isArray(kept.paths.roots) && sameRaw(kept.paths.roots, editableRoots(p().allowed_roots, p().data_dir))) delete kept.paths.roots;
      replace(fixed,
        el("dt", null, "Data directory"),
        el("dd", null, el("code", null, p().data_dir || "–"),
          el("div", "small dim", "Uploaded sets and these settings. Fixed while the server runs: set ASTROLABIO_DATA_DIR before starting it to use another.")),
        el("dt", null, "Keys file"),
        el("dd", null, el("code", null, p().env_file || "–"),
          el("div", "small dim", "Where the Keys section writes.")));
      refresh({ write: true });
      const waiting = (state.payload.restart_required || []).filter((key) => key !== "lan");
      replace(f.marks, waiting.length ? badge("restart needed", "warn", "refresh") : null);
    }

    return {
      id: f.id, node: f.node, render,
      unsaved: () => (state.payload ? plan().changed.length : 0),
      mark() {
        if (!state.payload) return null;
        const count = plan().changed.length;
        if (count) return badge(count + " unsaved", "warn", "dot");
        return (state.payload.restart_required || []).some((key) => key !== "lan") ? badge("restart", "warn", "refresh") : null;
      },
      dispose() {},
    };
  }

  // ------------------------------------------------------------ health

  function healthSection() {
    const f = frame("health", "Health");
    const again = actionButton({
      label: "Check again", iconName: "refresh",
      title: "Probe every service now. Each probe is one small request.",
      onclick: () => loadHealth(true),
    });
    const when = el("span", "small dim num");
    f.tools.append(when, again.node);
    const problem = el("div", { hidden: true });
    const services = el("div", "table-wrap");
    const windowBox = el("div", "stack tight");
    const diskBox = el("div", "stack tight");
    const versionBox = el("div", "stack tight");
    const cacheProblem = el("div", { hidden: true });
    f.content.append(problem, services, windowBox, diskBox, cacheProblem, versionBox);
    const clear = actionButton({ label: "Clear HTTP cache", iconName: "trash", cls: "danger", onclick: askClear });

    async function askClear() {
      if (clear.busy) return;
      // One key for this confirmation, so a retry after a timeout cannot clear twice.
      const key = newKey();
      const size = state.health && state.health.disk ? fmtBytes(state.health.disk.cache_bytes) : "all of it";
      const ok = await ask({
        title: "Clear the HTTP cache?",
        body: el("div", "stack tight",
          el("p", null, el("span", "strong", "Lost: "),
            "every cached answer of geocoding, OpenStreetMap, street-level and satellite lookups (" + size + "). The next tool call that needs one fetches it again, which is slower and counts against the services' rate limits."),
          el("p", null, el("span", "strong", "Kept: "),
            "runs with their logs and exports, uploaded sets, panorama previews, settings and keys."),
          el("p", "dim", "Safe while a run is going: a lookup that was cached is simply fetched again.")),
        okLabel: "Clear cache",
        tone: "danger",
      });
      if (!ok || !alive) return;
      runClear(key);
    }

    async function runClear(key) {
      clear.setBusy(true);
      cacheProblem.hidden = true;
      try {
        const out = await api.post(CACHE_CLEAR_URL, { confirm: true }, { key, signal, timeoutMs: 60000 });
        if (!alive) return;
        toast("HTTP cache cleared: " + fmtBytes(out.removed_bytes) + " freed. Cached lookups will be fetched again when needed.", "ok");
        loadHealth(false);
      } catch (err) {
        if (isAbort(err) || !alive) return;
        cacheProblem.hidden = false;
        replace(cacheProblem, failure(err, "The HTTP cache was not cleared.", () => runClear(key)));
      } finally {
        if (alive) clear.setBusy(false);
      }
    }

    function serviceRow(service) {
      const status = serviceStatus(service);
      return el("tr", { dataset: { key: service.name } },
        el("td", "top", el("div", "strong", service.name), el("div", "xsmall dim mono wrap-any", service.url || "")),
        el("td", "top nowrap", badge(status.text, status.kind, status.icon)),
        el("td", "top r num nowrap", latencyWords(service.latency_ms)),
        el("td", "top wrap-any", service.detail || ""));
    }

    function render() {
      const h = state.health;
      again.setBusy(state.healthLoading);
      if (!h) {
        f.showWait("Checking the services. Each one is asked once; this can take a few seconds…",
          state.healthError && !state.healthLoading
            ? { error: state.healthError, what: "The health check could not be run.", retry: () => loadHealth(true) }
            : null);
        replace(f.marks);
        when.textContent = "";
        return;
      }
      f.showContent();
      problem.hidden = !state.healthError;
      if (state.healthError) {
        replace(problem, failure(state.healthError, "The last check failed. The numbers below are from " + fmtTime(h.checked_at) + ".", () => loadHealth(true)));
      }
      const summary = healthSummary(h.services);
      replace(f.marks, badge(summary.text, summary.kind, summary.icon));
      when.textContent = h.checked_at ? "Checked at " + fmtTime(h.checked_at) : "";
      services.classList.toggle("is-stale", state.healthLoading);
      const rows = (h.services || []).map(serviceRow);
      replace(services, el("table", "table compact settings-services",
        el("thead", null, el("tr", null,
          el("th", { scope: "col" }, "Service"), el("th", { scope: "col" }, "Status"),
          el("th", { scope: "col", class: "r" }, "Latency"), el("th", { scope: "col" }, "Detail"))),
        el("tbody", null, rows.length ? rows : el("tr", null, el("td", { colSpan: 4, class: "dim" }, "The server probed no service.")))));
      const minutes = (h.window && h.window.minutes) || 15;
      replace(windowBox,
        el("h3", "section-title", "Model API, last " + minutes + " minutes"),
        el("div", "settings-stats", windowStats(h.window).map(stat)),
        el("p", "small dim", "Counted from the runs this server is working on. All dashes means no run was active in that time."));
      replace(diskBox,
        el("h3", "section-title", "Disk"),
        el("div", "settings-stats", diskRows(h.disk).map(stat)),
        el("div", "row wrap", clear.node,
          el("span", "small dim grow", "Removes only the cached lookups; they are fetched again when a tool needs them. Runs, sets, previews, settings and keys stay.")));
      const v = h.version || {};
      replace(versionBox,
        el("h3", "section-title", "Version"),
        el("dl", "kv",
          el("dt", null, "Code (git)"), el("dd", "mono", v.git_sha || "–"),
          el("dt", null, "Model for new runs"), el("dd", "mono", v.model || "–"),
          el("dt", null, "SDK"), el("dd", "mono", v.sdk || "–"),
          el("dt", null, "Python"), el("dd", "mono", v.python || "–")));
    }

    return {
      id: f.id, node: f.node, render,
      unsaved: () => 0,
      mark() {
        const h = state.health;
        if (!h) return state.healthError ? badge("check failed", "bad", "alert") : null;
        const failing = (h.services || []).filter((service) => !service.ok).length;
        return failing ? badge(failing + " failing", "bad", "alert") : null;
      },
      dispose() {},
    };
  }

  // ------------------------------------------------------------ LAN access

  function lanSection() {
    const f = frame("lan", "LAN access");
    const stateBox = el("div", "stack tight");
    const joinBox = el("div", "stack tight");
    const problem = el("div", { hidden: true });
    const input = el("input", { type: "checkbox", id: "settings-lan-switch", role: "switch", "aria-describedby": "settings-lan-help" });
    const word = el("span", "settings-switch-word");
    let saving = false;
    let revealed = false;
    f.content.append(
      el("div", "stack tight",
        el("p", null, "By default the server answers only this machine (127.0.0.1). With LAN access on, a second laptop on the same network can open the console, so one person can watch the dashboard while another answers questions."),
        el("p", null, el("span", "strong", "The risk: "),
          "anyone on that network who has the address with its token can do everything this page can, including launching runs that cost money, sending penalised cues and answers, and deleting runs. Use it only on a network you trust, and switch it off afterwards.")),
      el("div", "field",
        el("label", { class: "field-label", for: "settings-lan-switch" }, "Allow other machines on this network"),
        el("label", "switch", input, el("span", "switch-track"), word),
        el("div", { class: "field-help", id: "settings-lan-help" }, "Takes effect at the next start of the server, in both directions. You are asked to confirm.")),
      stateBox, joinBox, problem,
      el("div", "stack tight",
        el("h3", "section-title", "While it is on"),
        el("ul", "settings-plain-list",
          el("li", null, "Every request needs the token. The other device gets it by opening the address shown above once."),
          el("li", null, "Keys cannot be changed or tested from any browser, and the directories above are locked."),
          el("li", null, "The folder browser and sets given as a path are off. Uploading panoramas still works."),
          el("li", null, "This switch can only be changed in a browser on the server's own machine."))));

    input.addEventListener("change", () => {
      const want = input.checked;
      // The switch shows what is saved; it only moves once the server has said yes.
      input.checked = !want;
      toggle(want);
    });

    async function toggle(enabled) {
      if (saving || !state.payload) return;
      const ok = await ask(enabled ? {
        title: "Switch LAN access on?",
        body: el("div", "stack tight",
          el("p", null, "From the next start the server listens on this machine's network address, not only on 127.0.0.1. A new token is made now."),
          el("p", null, "Anyone on the network with the address and its token can launch runs, send penalised cues and answers, and delete runs."),
          el("p", "dim", "From now on keys cannot be changed or tested from a browser, directories are locked, and the folder browser is off.")),
        okLabel: "Switch on",
        tone: "danger",
      } : {
        title: "Switch LAN access off?",
        body: el("div", "stack tight",
          el("p", null, "The token is forgotten now, so the address given to other devices stops working once the server is restarted."),
          el("p", "dim", "Until that restart the running server still accepts the old token, and keys and directories stay locked.")),
        okLabel: "Switch off",
      });
      if (!ok || !alive) return;
      saving = true;
      problem.hidden = true;
      render();
      try {
        const out = await api.put(SETTINGS_URL, { lan: { enabled } }, { signal, timeoutMs: REQUEST_MS });
        if (!alive) return;
        saving = false;
        revealed = false;
        adopt(out);
        const pending = (out.restart_required || []).includes("lan");
        toast("LAN access is switched " + (enabled ? "on" : "off") + (pending ? ". Restart the server for it to take effect." : "."), pending ? "warn" : "ok");
      } catch (err) {
        saving = false;
        if (isAbort(err) || !alive) return;
        problem.hidden = false;
        replace(problem, failure(err, "LAN access was not changed.", () => toggle(enabled)));
        render();
      }
    }

    function render() {
      const p = state.payload;
      if (!p) {
        f.showWait("Loading the LAN setting…");
        return;
      }
      f.showContent();
      const lan = p.lan || {};
      const now = lanState(p);
      if (input.checked !== Boolean(lan.enabled)) input.checked = Boolean(lan.enabled);
      input.disabled = saving;
      word.textContent = saving ? "Saving…" : lan.enabled ? "On" : "Off";
      replace(f.marks, badge("LAN access " + now.text, now.kind, now.icon));
      const pending = now.state === "pending_on" || now.state === "pending_off";
      replace(stateBox,
        notice(now.state === "off" ? "ok" : "warn",
          el("div", "strong", "LAN access is " + now.text + "."),
          el("div", null, now.detail),
          pending ? el("div", null, "To apply it, stop the server with Ctrl-C in its terminal and start it again with ", el("code", null, RESTART_COMMAND), ".") : null));
      if (!lan.enabled) {
        replace(joinBox, lan.address
          ? el("p", "small dim", "This machine's address on the network is ", el("code", null, lan.address), ". The address to open, with its token, appears here once LAN access is on.")
          : el("p", "small dim", "This machine has no network address at the moment. Connect it to the network before switching LAN access on."));
        return;
      }
      if (!lan.join_url) {
        replace(joinBox, notice("info",
          el("div", null, lan.address
            ? "The address with its token is shown only in a browser on the server's own machine. Ask the operator there for it."
            : "The server found no network address for this machine, so there is no address to hand out. Connect it to the network and reload this page.")));
        return;
      }
      const shown = revealed ? lan.join_url : maskJoinUrl(lan.join_url);
      replace(joinBox,
        el("h3", "section-title", "Open this on the other device"),
        el("div", "row wrap settings-join",
          el("code", "grow wrap-any settings-join-url", shown),
          el("button", {
            type: "button", class: "small", "aria-pressed": revealed ? "true" : "false",
            title: revealed ? "Hide the token again" : "Show the whole address. Anyone who can see the screen can then read the token.",
            onclick: () => { revealed = !revealed; render(); },
          }, icon("eye"), revealed ? "Hide token" : "Show token"),
          el("button", {
            type: "button", class: "small", title: "Copy the whole address, token included",
            onclick: async () => {
              const ok = await copyText(lan.join_url);
              if (!alive) return;
              toast(ok ? "Address copied, token included. Paste it on the other device." : "Copying failed. Use Show token and type the address on the other device.", ok ? "ok" : "warn");
            },
          }, icon("copy"), "Copy address")),
        el("p", "small dim",
          now.state === "pending_on" ? "It works after the restart. " : "",
          "Opening it once stores the token on that device; after that the plain address is enough. The token is kept out of every other answer of the server. Switching LAN access off and on again makes a new one."));
    }

    return {
      id: f.id, node: f.node, render,
      unsaved: () => 0,
      mark() {
        if (!state.payload) return null;
        const now = lanState(state.payload);
        return now.state === "off" ? null : badge(now.state === "on" ? "on" : "restart", "warn", now.icon);
      },
      dispose() {},
    };
  }

  // ------------------------------------------------------------ this browser

  function browserSection() {
    const f = frame("browser", "This browser");
    const body = el("div", "settings-prefs");
    f.content.append(
      el("p", "dim", "Kept in this browser only. Nothing here is sent to the server or reaches the agent."),
      body);
    f.showContent();

    const permission = () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

    // Asking for the permission is the browser's own prompt, so it only ever follows this click.
    async function setNotifications(on) {
      if (!on) {
        prefs.set("notifications", false);
        return;
      }
      let granted = permission();
      if (granted === "default") {
        try {
          granted = await Notification.requestPermission();
        } catch (_) {
          granted = "denied";
        }
      }
      if (!alive) return;
      if (granted === "granted") prefs.set("notifications", true);
      else {
        prefs.set("notifications", false);
        toast(notificationState(granted, false).text, "warn");
      }
      render();
    }

    function pref(label, control, help) {
      const text = el("div", "small dim", help);
      body.append(el("div", "settings-pref",
        el("div", "settings-pref-label", el("div", "strong", label), text),
        el("div", "settings-pref-control", control.node)));
      return text;
    }

    const THEMES = [{ value: "dark", label: "Dark", icon: "moon" }, { value: "light", label: "Light", icon: "sun" }];
    const DENSITIES = [
      { value: "board", label: "Board", icon: "list", title: "One row per panorama: for many panoramas on one screen" },
      { value: "tiles", label: "Tiles", icon: "grid", title: "One tile per panorama: for the scoring run" },
      { value: "focus", label: "Focus", icon: "expand", title: "One panorama full width, the others in a side rail" },
    ];

    const theme = segmented("Theme", THEMES, (value) => prefs.set("theme", value));
    const stageTheme = segmented("Stage view theme", THEMES, (value) => prefs.set("stageTheme", value));
    const sound = toggleSwitch("settings-pref-sound", "Sound for a question", (on) => prefs.set("sound", on));
    const notifications = toggleSwitch("settings-pref-notifications", "Notification for a question", setNotifications);
    const density = segmented("Dashboard density", DENSITIES, (value) => prefs.set("density", value));
    pref("Theme", theme, "For every screen except the stage view.");
    pref("Stage view theme", stageTheme, "The projector view follows its own setting, so it can be light while the console stays dark.");
    pref("Sound for a question", sound, "A short two-note chime when the agent asks a multiple-choice question. Never played in the stage view.");
    const notificationHelp = pref("Notification for a question", notifications, "");
    pref("Dashboard density", density, "How a run dashboard opens when its address does not say. Board, tiles and focus can still be switched on the dashboard itself.");

    function render() {
      const notes = notificationState(permission(), Boolean(prefs.get("notifications")));
      theme.set(prefs.get("theme") === "light" ? "light" : "dark");
      stageTheme.set(prefs.get("stageTheme") === "light" ? "light" : "dark");
      sound.set(Boolean(prefs.get("sound")));
      notifications.set(notes.on, !notes.canToggle);
      notificationHelp.textContent = notes.text;
      density.set(prefs.get("density"));
    }

    for (const key of ["theme", "stageTheme", "sound", "notifications", "density"]) {
      cleanups.push(prefs.onChange(key, () => { if (alive) render(); }));
    }
    return { id: f.id, node: f.node, render, unsaved: () => 0, mark: () => null, dispose() {} };
  }

  // ------------------------------------------------------------ assembling

  const sections = [
    keysSection(), defaultsSection(), organiserSection(), pathsSection(), healthSection(), lanSection(), browserSection(),
  ];
  const byId = new Map(sections.map((section) => [section.id, section]));
  const navItems = new Map();

  for (const meta of SECTIONS) {
    const section = byId.get(meta.id);
    main.append(section.node);
    const mark = el("span", "settings-nav-mark");
    const anchor = link(paths.settings(meta.id), { class: "settings-nav-link" }, el("span", "grow", meta.label), mark);
    // The router's own handler (registered first) has already scrolled when this one runs.
    anchor.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      pin(meta.id);
    });
    navItems.set(meta.id, { anchor, mark });
    navList.append(el("li", null, anchor));
  }

  function renderNav() {
    for (const [id, item] of navItems) replace(item.mark, byId.get(id).mark());
  }

  function renderTop() {
    const p = state.payload;
    const nodes = [];
    if (state.loadError && !p) {
      nodes.push(failure(state.loadError, "The settings could not be loaded.", () => loadSettings()));
    }
    if (state.staleError && p) {
      nodes.push(failure(state.staleError, "The settings could not be refreshed. The page shows what it loaded before.", () => loadSettings({ quiet: true })));
    }
    const waiting = (p && p.restart_required) || [];
    if (waiting.length) {
      const active = store.activeRuns().length;
      nodes.push(notice("warn",
        el("div", "strong", "Restart the server to apply: " + restartWords(waiting) + "."),
        el("div", null, "Stop it with Ctrl-C in its terminal, then start it again with ", el("code", null, RESTART_COMMAND), ". Stopping finalises and exports every active run first."),
        active ? el("div", "strong", plural(active, "run") + " " + (active === 1 ? "is" : "are") + " active now: a restart ends " + (active === 1 ? "it" : "them") + " on the best answers so far. Wait for the run to finish.") : null));
    }
    replace(topNotices, nodes);
  }

  function renderAll() {
    if (!alive) return;
    renderTop();
    for (const section of sections) section.render();
    renderNav();
    settle();
  }

  /** Take a settings payload returned by a save as the new truth. */
  function adopt(payload) {
    settingsSeq += 1; // a refresh still on its way is older than this
    state.payload = payload;
    state.loadError = null;
    state.staleError = null;
    renderAll();
  }

  async function loadSettings({ quiet = false } = {}) {
    settingsSeq += 1;
    const seq = settingsSeq;
    if (!quiet && !state.payload) {
      state.loadError = null;
      renderAll();
    }
    try {
      const out = await api.get(SETTINGS_URL, { signal, timeoutMs: REQUEST_MS });
      if (!alive || seq !== settingsSeq) return;
      state.payload = out;
      state.loadError = null;
      state.staleError = null;
    } catch (err) {
      if (isAbort(err) || !alive || seq !== settingsSeq) return;
      if (state.payload) state.staleError = err;
      else state.loadError = err;
    }
    renderAll();
  }

  async function loadHealth(refresh) {
    healthSeq += 1;
    const seq = healthSeq;
    state.healthLoading = true;
    byId.get("health").render();
    try {
      const out = await api.get(HEALTH_URL + (refresh ? "?refresh=1" : ""), { signal, timeoutMs: HEALTH_MS });
      if (!alive || seq !== healthSeq) return;
      state.health = out;
      state.healthError = null;
    } catch (err) {
      if (isAbort(err) || !alive || seq !== healthSeq) return;
      state.healthError = err;
    }
    state.healthLoading = false;
    byId.get("health").render();
    renderNav();
    settle();
  }

  // ------------------------------------------------------------ section in view, hash

  let pinned = null; // {id, y}: the section the operator asked for, until they scroll away from it
  let active = null;
  let frameId = 0;
  let hashReady = false; // the first scroll position is the router's, not the operator's
  let scrolled = false; // a scroll or resize event is waiting for spy()

  function setActive(id) {
    if (id === active) return;
    active = id;
    for (const [key, item] of navItems) {
      if (key === id) item.anchor.setAttribute("aria-current", "true");
      else item.anchor.removeAttribute("aria-current");
    }
  }

  function pin(id) {
    pinned = { id, y: window.scrollY };
    setActive(id);
  }

  // Content that arrives later (the payload, the health table) moves the sections below it. As
  // long as the operator has not scrolled, keep the section they asked for at the top.
  function settle() {
    const target = pinned ? byId.get(pinned.id) : null;
    if (!target || Math.abs(window.scrollY - pinned.y) > 2) {
      // Nothing to hold in place, but the sections have moved under the reading line.
      pinned = null;
      if (!frameId) frameId = requestAnimationFrame(spy);
      return;
    }
    target.node.scrollIntoView({ block: "start" });
    pinned.y = window.scrollY;
  }

  function spy() {
    frameId = 0;
    const byOperator = scrolled;
    scrolled = false;
    if (!alive) return;
    if (pinned && Math.abs(window.scrollY - pinned.y) <= 2) {
      setActive(pinned.id);
      return;
    }
    pinned = null;
    const root = document.documentElement;
    const shell = parseFloat(getComputedStyle(root).getPropertyValue("--shell-h")) || 0;
    const tops = sections.map((section) => ({ id: section.id, top: section.node.getBoundingClientRect().top }));
    // The last sections are short and can never reach the top of the window: at the end of the
    // page the last one is the one being read.
    const atStart = window.scrollY <= 2;
    const atEnd = !atStart && window.innerHeight + window.scrollY >= root.scrollHeight - 2;
    let id = sectionAt(tops, shell + (window.innerHeight - shell) * 0.3);
    if (atStart) id = tops[0].id;
    else if (atEnd) id = tops[tops.length - 1].id;
    setActive(id);
    // A reload or a pasted link lands in the section being read. Only the operator's own
    // scrolling writes the address: content arriving must not.
    if (byOperator && hashReady && id && window.location.hash.slice(1) !== id) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + "#" + id);
    }
  }

  function onScroll() {
    scrolled = true;
    if (!frameId) frameId = requestAnimationFrame(spy);
  }

  function onHistory() {
    const id = sectionFromHash(window.location.hash);
    if (id) pin(id);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  window.addEventListener("popstate", onHistory);
  window.addEventListener("hashchange", onHistory);
  cleanups.push(() => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    window.removeEventListener("popstate", onHistory);
    window.removeEventListener("hashchange", onHistory);
    if (frameId) cancelAnimationFrame(frameId);
  });

  const unsavedTotal = () => sections.reduce((sum, section) => sum + section.unsaved(), 0);

  // A reload of the tab is the one way to lose a draft: let the browser ask first.
  function onBeforeUnload(event) {
    if (!state.payload || unsavedTotal() === 0) return;
    event.preventDefault();
    event.returnValue = "";
  }
  window.addEventListener("beforeunload", onBeforeUnload);
  cleanups.push(() => window.removeEventListener("beforeunload", onBeforeUnload));

  // ------------------------------------------------------------ live state

  const refreshSoon = debounce(() => { if (alive) loadSettings({ quiet: true }); }, 400);
  cleanups.push(() => refreshSoon.cancel());

  cleanups.push(store.on("snapshot", ({ bootChanged }) => {
    if (!alive || !bootChanged) return;
    // Another server process: its settings, its restart list and its health are all new. The
    // drafts are not part of the payload, so what the operator typed stays.
    // The shell announces the restart itself; this only adds what it cannot know.
    if (state.payload && unsavedTotal() > 0) toast("Your unsaved changes on Settings were kept through the server restart.", "info");
    loadSettings({ quiet: true });
    loadHealth(false);
  }));
  // A key saved or LAN switched in another tab arrives as a change of the health chips.
  cleanups.push(store.on("health", () => { if (alive) refreshSoon(); }));
  cleanups.push(store.on("connection", ({ connected }) => {
    if (!alive || !connected) return;
    if (state.loadError || state.staleError) loadSettings({ quiet: Boolean(state.payload) });
    if (state.healthError && !state.healthLoading) loadHealth(false);
  }));
  let lastActive = store.activeRuns().length;
  cleanups.push(store.subscribe(() => {
    if (!alive) return;
    const now = store.activeRuns().length;
    if (now === lastActive) return;
    lastActive = now;
    renderTop();
  }));

  // First paint: every section says it is loading; the hash the router scrolls to is pinned so
  // the content that arrives does not push it away.
  renderAll();
  const wanted = sectionFromHash(ctx.hash || window.location.hash);
  requestAnimationFrame(() => {
    if (!alive) return;
    if (wanted) {
      pin(wanted);
      settle();
    } else spy();
    hashReady = true;
  });
  loadSettings();
  loadHealth(false);

  return {
    unmount() {
      if (!alive) return;
      const left = state.payload ? unsavedTotal() : 0;
      alive = false;
      abort.abort();
      for (const off of cleanups.splice(0)) {
        try {
          off();
        } catch (err) {
          console.error("settings cleanup failed", err);
        }
      }
      for (const section of sections) section.dispose();
      if (ownDialog && confirmDialog.current) confirmDialog.current.close();
      if (left) {
        toast("Settings has " + plural(left, "unsaved change") + ". They are kept until this tab is reloaded: open Settings again to save or discard them.", "warn");
      }
    },
    onQuery() {},
  };
}
