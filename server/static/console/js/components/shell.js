// The persistent shell (UI-SPEC 5.1): navigation, active-run strip, attention inbox, connection
// state, health chips, and the overlays every screen shares (toasts, confirm dialog, side panel,
// lightbox, shortcut list). It also owns the tab title, the MCQ sound and the browser
// notification (contract A6); all three are suppressed on a route declared with `shell: false`.

import { api } from "../api.js";
import { badge, el, icon, replace, syncList } from "../dom.js";
import { fmtAgo, fmtClock, fmtCountdown, fmtMult, fmtUsd } from "../format.js";
import { shortcuts } from "../keyboard.js";
import { attentionItems, mcqTitle, oldestPendingMcq } from "../logic/attention.js";
import { runTotals } from "../logic/reduce.js";
import { prefs } from "../prefs.js";
import { link, navigate, paths, setQuery } from "../router.js";
import { store } from "../store.js";

const APP_NAME = "astrolabio";

let screenTitle = "";
let suppressed = false; // true on the stage route: no sound, no notification, no MCQ in the title

// ---------------------------------------------------------------- toasts

const TOAST_MS = { info: 5000, ok: 5000, warn: 8000, error: 12000 };
const TOAST_ICON = { info: "info", ok: "check", warn: "alert", error: "x" };
const MAX_TOASTS = 5;
let toastHost = null;

// Toasts live in the browser's top layer (a manual popover) so that one raised while a confirm
// dialog is open is drawn above its backdrop instead of behind it.
function toastLayer() {
  if (toastHost) return toastHost;
  toastHost = el("div", { class: "toasts", role: "region", "aria-label": "Messages" });
  if (typeof toastHost.showPopover === "function") toastHost.setAttribute("popover", "manual");
  document.body.append(toastHost);
  return toastHost;
}

function raiseToasts() {
  const host = toastLayer();
  placeToasts();
  if (!host.hasAttribute("popover")) return;
  try {
    if (host.matches(":popover-open")) host.hidePopover();
    host.showPopover();
  } catch (_) {
    host.removeAttribute("popover"); // plain fixed positioning still shows them
  }
}

// How much of the window's bottom edge, under the toasts, is taken by a bar that stays there: one
// that is stuck to the window (a save bar), or the last row of a page that does not scroll (the
// stage's strip of buttons). Whatever scrolls can be scrolled out from under a toast; such a bar
// cannot, so the toasts sit above it.
function stuckBottom(host) {
  if (typeof document.elementsFromPoint !== "function") return 0;
  const view = { w: window.innerWidth, h: window.innerHeight };
  const scroller = document.scrollingElement || document.documentElement;
  const pageScrolls = scroller.scrollHeight > view.h + 1;
  const box = host.getBoundingClientRect();
  const left = Math.max(4, box.left + 4);
  const right = Math.min(view.w - 4, box.right - 4);
  let inset = 0;
  for (const x of [left, (left + right) / 2, right]) {
    for (const hit of document.elementsFromPoint(x, view.h - 3)) {
      if (host.contains(hit)) continue;
      for (let node = hit; node && node !== document.body && node.nodeType === 1; node = node.parentElement) {
        const rect = node.getBoundingClientRect();
        // A bar along the bottom, not a panel that fills the side of the window or the page itself.
        const bar = rect.bottom >= view.h - 1 && rect.height <= view.h * 0.4 && rect.width >= view.w * 0.5;
        if (!bar) continue;
        const position = getComputedStyle(node).position;
        if (position === "sticky" || position === "fixed" || !pageScrolls) inset = Math.max(inset, view.h - rect.top);
      }
    }
  }
  return inset;
}

function placeToasts() {
  if (!toastHost || !toastHost.children.length) return;
  const inset = stuckBottom(toastHost);
  if (inset > 0) toastHost.style.setProperty("--toast-lift", Math.ceil(inset) + "px");
  else toastHost.style.removeProperty("--toast-lift");
}

/**
 * A short message in the bottom right corner, above anything that is stuck to the bottom of the
 * window. kind: "info" | "ok" | "warn" | "error". The same message raised again while it is still
 * showing restarts its timer instead of stacking. Returns `{dismiss()}`.
 */
export function toast(message, kind = "info") {
  const level = TOAST_MS[kind] ? kind : "info";
  const text = String(message ?? "");
  const host = toastLayer();
  const signature = level + "\n" + text;
  for (const old of Array.from(host.children)) {
    if (old.dataset.signature === signature) old.remove();
  }
  let timer = null;
  const node = el("div", {
    class: "toast toast-" + level,
    role: level === "error" || level === "warn" ? "alert" : "status",
    dataset: { signature },
  });
  const dismiss = () => {
    clearTimeout(timer);
    node.remove();
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(dismiss, TOAST_MS[level]);
  };
  node.append(
    icon(TOAST_ICON[level]),
    el("div", "toast-text", text),
    el("button", { type: "button", class: "icon-btn toast-close", title: "Dismiss", "aria-label": "Dismiss", onclick: dismiss }, icon("x")),
  );
  // Reading a long error must not race its timer.
  node.addEventListener("mouseenter", () => clearTimeout(timer));
  node.addEventListener("mouseleave", arm);
  host.append(node);
  while (host.children.length > MAX_TOASTS) host.firstElementChild.remove();
  raiseToasts();
  arm();
  return { dismiss };
}

// ---------------------------------------------------------------- confirm dialog

const OK_CLASS = { default: "primary", danger: "danger", penalty: "penalty" };
const DEFAULT_LOCK = "This action is no longer available.";
const SWALLOW_MS = 500; // the time a double click may take
const SWALLOW_PX = 24;
let dialogCount = 0;

// A double click on a dialog button closes the dialog with its first click; the second would
// land on whatever was under the button (a board row, a link, another control). For a moment
// after the dialog closes, clicks at that spot go nowhere.
function swallowClicksAt(x, y) {
  const until = Date.now() + SWALLOW_MS;
  const types = ["click", "dblclick", "auxclick"];
  const stop = (event) => {
    if (Date.now() > until) {
      off();
      return;
    }
    if (Math.abs(event.clientX - x) > SWALLOW_PX || Math.abs(event.clientY - y) > SWALLOW_PX) return;
    event.stopPropagation();
    event.preventDefault();
  };
  const off = () => { for (const type of types) window.removeEventListener(type, stop, true); };
  for (const type of types) window.addEventListener(type, stop, true);
  setTimeout(off, SWALLOW_MS);
}

function multiplierChange(before, after) {
  const show = (value) => (typeof value === "number" ? fmtMult(value) : String(value));
  return el("div", "mult-change",
    el("div", "mult-change-side", el("span", "caps dim", "Multiplier now"), el("span", "num mult-from", show(before))),
    icon("arrow-right"),
    el("div", "mult-change-side", el("span", "caps dim", "After"), el("span", "num mult-to", show(after))));
}

/**
 * Ask before an action. Resolves true when confirmed, false otherwise.
 *   tone: "default" | "danger" | "penalty" (penalised human channels only)
 *   before / after: the multiplier now and after the action; shown when both are given
 *   typeToConfirm: text the operator must type before the OK button works (deleting a run)
 *   lockMessage: the text lock() shows when it is called without one
 *   focus: "cancel" opens with Cancel focused, so that Enter does not confirm (an action that
 *     costs money or cannot be undone). The danger and penalty tones always open on Cancel; the
 *     default tone opens on OK unless this says otherwise.
 * A held-down Enter or Space never presses a button of the dialog, and the second click of a
 * double click on a button does not reach the page under it.
 * While the dialog is open it is available as `confirmDialog.current` (`{lock(message), close(),
 * options}`); the returned promise has the same `lock`. A locked dialog can only be closed:
 * used when another tab sends the same penalised action first (A3).
 */
export function confirmDialog(options) {
  const {
    title, body, okLabel = "Confirm", cancelLabel = "Cancel", tone = "default",
    before, after, typeToConfirm, lockMessage, focus,
  } = options;
  if (confirmDialog.current) confirmDialog.current.close();

  dialogCount += 1;
  const titleId = "confirm-title-" + dialogCount;
  const kind = OK_CLASS[tone] ? tone : "default";
  const okButton = el("button", { type: "button", class: OK_CLASS[kind] + " dialog-ok" }, okLabel);
  const cancelButton = el("button", { type: "button", class: "dialog-cancel" }, cancelLabel);
  const lockLine = el("div", { class: "dialog-lock", role: "alert", hidden: true });
  let locked = false;
  let typed = null;

  const dialog = el("dialog", { class: "dialog dialog-confirm tone-" + kind, "aria-labelledby": titleId });
  dialog.append(el("h2", { class: "dialog-title", id: titleId },
    el("span", "dialog-title-text", String(title ?? "")),
    kind === "penalty" ? badge("penalised", "penalty", "alert") : null));
  if (body !== undefined && body !== null && body !== "") {
    dialog.append(el("div", "dialog-body" + (typeof body === "string" ? " pre" : ""), body));
  }
  if (before !== undefined && before !== null && after !== undefined && after !== null) {
    dialog.append(multiplierChange(before, after));
  }
  if (typeToConfirm) {
    // A harness-only control: what is typed here is compared in the browser and goes nowhere.
    typed = el("input", { type: "text", class: "mono", autocomplete: "off", "aria-label": "Type to confirm" });
    typed.setAttribute("spellcheck", "false");
    dialog.append(el("label", "field",
      el("span", "field-label", "Type ", el("code", null, String(typeToConfirm)), " to confirm"), typed));
  }
  dialog.append(lockLine, el("div", "dialog-actions", cancelButton, okButton));

  const typedOk = () => !typed || typed.value === String(typeToConfirm);
  const refresh = () => { okButton.disabled = locked || !typedOk(); };

  let settle = null;
  const promise = new Promise((resolve) => { settle = resolve; });
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (confirmDialog.current === handle) confirmDialog.current = null;
    if (dialog.open) dialog.close();
    dialog.remove();
    settle(value);
  };
  const lock = (message) => {
    locked = true;
    replace(lockLine, icon("lock"), el("span", null, String(message || lockMessage || DEFAULT_LOCK)));
    lockLine.hidden = false;
    cancelButton.textContent = "Close";
    refresh();
    cancelButton.focus();
  };
  const handle = { lock, close: () => finish(false), options, element: dialog };

  // `detail` is 0 for a click made with the keyboard: only a pointer can double click.
  const guard = (event) => { if (event.detail > 0) swallowClicksAt(event.clientX, event.clientY); };
  okButton.addEventListener("click", (event) => {
    if (locked || !typedOk()) return;
    guard(event);
    finish(true);
  });
  cancelButton.addEventListener("click", (event) => {
    guard(event);
    finish(false);
  });
  if (typed) typed.addEventListener("input", refresh);
  // The key that opened the dialog, still held down, must not also answer it.
  dialog.addEventListener("keydown", (event) => {
    if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); }); // Esc
  dialog.addEventListener("close", () => finish(false));

  document.body.append(dialog);
  confirmDialog.current = handle;
  refresh();
  dialog.showModal();
  // Enter must never confirm a penalty or a deletion by accident: those open on Cancel, and so
  // does any dialog whose caller asks for it.
  if (typed) typed.focus();
  else if (kind === "default" && focus !== "cancel") okButton.focus();
  else cancelButton.focus();

  promise.lock = lock;
  return promise;
}
confirmDialog.current = null;

// ---------------------------------------------------------------- side panel

let panel = null; // {element, onClose}

/**
 * A panel on the right edge for detail that should not take the operator away from the screen
 * (the full JSON of an event). One at a time: open() replaces the previous panel, whose `onClose`
 * runs first so its owner can drop its "open" mark; `onClose` also runs when the panel is closed
 * by the operator or by sidePanel.close().
 */
export const sidePanel = {
  open({ title, body, wide = false, onClose = null }) {
    const previous = panel;
    panel = null;
    if (previous) {
      previous.element.remove();
      if (previous.onClose) previous.onClose();
    }
    const element = el("aside", { class: "side-panel" + (wide ? " wide" : ""), "aria-label": String(title ?? "Detail") },
      el("header", "side-panel-head",
        el("h2", "side-panel-title", String(title ?? "")),
        el("button", { type: "button", class: "icon-btn", title: "Close (Esc)", "aria-label": "Close", onclick: () => sidePanel.close() }, icon("x"))),
      el("div", "side-panel-body", body));
    document.body.append(element);
    panel = { element, onClose };
    return { close: () => sidePanel.close() };
  },

  close() {
    if (!panel) return;
    const closing = panel;
    panel = null;
    closing.element.remove();
    if (closing.onClose) closing.onClose();
  },

  // On a route change the screen that opened the panel is already gone; calling its onClose
  // would let it edit the URL of the screen that replaced it.
  drop() {
    if (!panel) return;
    panel.element.remove();
    panel = null;
  },

  isOpen() {
    return panel !== null;
  },
};

// ---------------------------------------------------------------- lightbox

// Images come from the app's own endpoints (or a blob the page made). Anything else is refused,
// so a URL found in model output can never be loaded by passing it here (A30).
function safeImageSrc(src) {
  const text = String(src ?? "");
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  if (text.startsWith("blob:") || text.startsWith("data:image/")) return text;
  return null;
}

/** Show one image full screen. `caption` is text or a node (yaw, pitch, FOV). Returns `{close()}`. */
export function lightbox({ src, caption }) {
  const safe = safeImageSrc(src);
  if (!safe) return { close() {} };
  const dialog = el("dialog", { class: "lightbox", "aria-label": "Image" });
  const close = () => {
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  const image = el("img", { class: "lightbox-image", alt: typeof caption === "string" ? caption : "" });
  image.src = safe;
  dialog.append(
    el("button", { type: "button", class: "icon-btn lightbox-close", title: "Close (Esc)", "aria-label": "Close", onclick: close }, icon("x")),
    image,
    caption ? el("div", "lightbox-caption", caption) : null,
  );
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return { close };
}

// ---------------------------------------------------------------- shortcut list

const JOINERS = new Set(["then", "or", "to"]);

function keyCaps(binding) {
  const tokens = String(binding).trim().split(/\s+/);
  const plainSequence = tokens.length === 2 && !tokens.some((t) => JOINERS.has(t));
  const nodes = [];
  tokens.forEach((token, index) => {
    if (index > 0) nodes.push(plainSequence ? " then " : " ");
    nodes.push(JOINERS.has(token) ? token : el("kbd", null, token));
  });
  return nodes;
}

/** The "?" dialog: every registered shortcut, grouped by the scope that registered it. */
export function showShortcuts() {
  if (document.querySelector("dialog.dialog-shortcuts")) return;
  const groups = new Map();
  for (const row of shortcuts.list()) {
    if (!groups.has(row.scope)) groups.set(row.scope, new Map());
    groups.get(row.scope).set(row.key, row.label);
  }
  const dialog = el("dialog", { class: "dialog dialog-shortcuts", "aria-label": "Keyboard shortcuts" });
  const close = () => {
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  dialog.append(el("h2", "dialog-title", el("span", "dialog-title-text", "Keyboard shortcuts")));
  const body = el("div", "dialog-body shortcut-groups");
  for (const [scope, rows] of groups) {
    const list = el("dl", "kv shortcut-list");
    for (const [key, label] of rows) list.append(el("dt", null, keyCaps(key)), el("dd", null, label));
    body.append(el("section", null, el("h3", "caps dim", scope), list));
  }
  dialog.append(body,
    el("p", "dim small", "No single key sends a cue, an answer or a geocode, or finalises, stops or deletes anything."),
    el("div", "dialog-actions", el("button", { type: "button", class: "primary", onclick: close }, "Close")));
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// ---------------------------------------------------------------- tab title

// "Run abc · astrolabio"; while a question waits, "(1) MCQ 0:47 · astrolabio" (UI-SPEC 5.1).
const TITLE_JOIN = " \u00b7 ";

function refreshTitle() {
  const base = screenTitle ? screenTitle + TITLE_JOIN + APP_NAME : APP_NAME;
  const pending = suppressed ? null : mcqTitle(store.state, Date.now());
  const title = pending ? pending + TITLE_JOIN + APP_NAME : base;
  if (document.title !== title) document.title = title;
}

/** Set the screen's part of the tab title. A pending MCQ takes the title over until it is gone. */
export function setDocumentTitle(text) {
  screenTitle = text ? String(text) : "";
  refreshTitle();
}

// ---------------------------------------------------------------- sound and notification

let audio = null;

// Browsers only start audio after a user gesture, so the context is created on the first click or
// key press and stays running from then on.
function unlockAudio() {
  if (!prefs.get("sound")) return;
  if (!audio) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    try {
      audio = new Context();
    } catch (_) {
      audio = null;
      return;
    }
  }
  if (audio.state === "suspended") audio.resume().catch(() => {});
}

// Two rising notes, synthesised: no audio file to ship or to fail loading at the venue.
function playChime() {
  if (!audio || audio.state !== "running") return false;
  const start = audio.currentTime + 0.02;
  [[0, 880], [0.17, 1174.66]].forEach(([offset, frequency]) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.22, start + offset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.3);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.32);
  });
  return true;
}

// With several tabs open, only one should beep for a question. First tab to write the key wins.
function claimAlert(id) {
  const key = "astrolabio:mcqAlert:" + id;
  try {
    if (window.localStorage.getItem(key)) return false;
    window.localStorage.setItem(key, String(Date.now()));
  } catch (_) {
    // No storage: every tab beeps, which is the safe side.
  }
  return true;
}

function releaseAlert(id) {
  try {
    window.localStorage.removeItem("astrolabio:mcqAlert:" + id);
  } catch (_) {
    // nothing to release
  }
}

function notifyMcq(item) {
  if (!prefs.get("notifications") || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  if (!document.hidden && document.hasFocus()) return; // the operator is already looking at the page
  try {
    const note = new Notification("MCQ waiting: " + item.panorama_id, {
      body: item.question || item.text,
      tag: item.id, // the same question raised by another tab replaces this one
    });
    note.onclick = () => {
      window.focus();
      navigate(item.href);
      note.close();
    };
  } catch (_) {
    // Notifications need a secure context; the title and the inbox still show the question.
  }
}

const seenMcqs = new Set();

// Called on every raw stream message, so it also runs in a hidden tab.
function checkNewMcqs() {
  const pending = attentionItems(store.state, Date.now()).filter((item) => item.kind === "mcq");
  const live = new Set(pending.map((item) => item.id));
  for (const id of Array.from(seenMcqs)) {
    if (live.has(id)) continue;
    seenMcqs.delete(id);
    releaseAlert(id);
  }
  for (const item of pending) {
    if (seenMcqs.has(item.id)) continue;
    seenMcqs.add(item.id);
    if (suppressed) continue;
    if (prefs.get("sound") && audio && audio.state === "running" && claimAlert(item.id)) playChime();
    notifyMcq(item);
  }
}

async function toggleNotifications() {
  if (prefs.get("notifications")) {
    prefs.set("notifications", false);
    return;
  }
  if (typeof Notification === "undefined") {
    toast("This browser cannot show notifications. The tab title and the inbox still announce a question.", "warn");
    return;
  }
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch (_) {
      permission = "denied";
    }
  }
  if (permission !== "granted") {
    toast("Notifications are blocked for this site. Allow them in the browser's site settings, then switch this on again.", "warn");
    return;
  }
  prefs.set("notifications", true);
}

function toggleSound() {
  const on = !prefs.get("sound");
  prefs.set("sound", on);
  if (!on) return;
  unlockAudio();
  // Let the operator hear what a question will sound like.
  setTimeout(playChime, 60);
}

// ---------------------------------------------------------------- shell pieces

const NAV = [
  { label: "Runs", path: "/", keys: "g r", match: (p) => p === "/" || p.startsWith("/runs") },
  { label: "New run", path: "/new", keys: "g n", match: (p) => p.startsWith("/new") },
  { label: "Evaluation", path: "/eval", keys: "g e", match: (p) => p.startsWith("/eval") },
  { label: "Settings", path: "/settings", keys: "g s", match: (p) => p.startsWith("/settings") },
];

const INBOX_ICON = {
  mcq: "question", window: "clock", api: "wifi-off", export: "file",
  fallback: "flag", spend: "alert", no_hypothesis: "target",
};

function toggleButton(title, onclick) {
  return el("button", { type: "button", class: "icon-btn shell-toggle", title, "aria-label": title, onclick });
}

function buildNav() {
  const items = NAV.map((entry) => {
    const anchor = link(entry.path, { class: "nav-link", title: entry.label + " (" + entry.keys + ")" }, entry.label);
    return { entry, anchor };
  });
  const node = el("nav", { class: "shell-nav", "aria-label": "Main" }, items.map((item) => item.anchor));
  const setPath = (path) => {
    for (const { entry, anchor } of items) {
      const active = entry.match(path);
      anchor.classList.toggle("active", active);
      if (active) anchor.setAttribute("aria-current", "page");
      else anchor.removeAttribute("aria-current");
    }
  };
  return { node, setPath };
}

// One chip per active run: clock, done/total, spend, lowest multiplier.
const chipParts = new WeakMap();

function createRunChip(run) {
  const p = {
    id: el("span", "run-chip-id"),
    clock: el("span", { class: "num", title: "Run clock" }),
    done: el("span", { class: "num", title: "Panoramas final / total" }),
    spend: el("span", { class: "num", title: "Spend so far" }),
    mult: el("span", { class: "num run-chip-mult", title: "Lowest multiplier in this run" }),
    mcq: badge("MCQ", "awaiting_mcq", "question"),
  };
  const chip = link(paths.run(run.run_id), { class: "run-chip" },
    p.id, el("span", "run-chip-item", icon("clock"), p.clock), p.done, p.spend, p.mult, p.mcq);
  chipParts.set(chip, p);
  return chip;
}

function updateRunChip(chip, run) {
  const p = chipParts.get(chip);
  const totals = runTotals(run);
  p.id.textContent = run.run_id;
  p.clock.textContent = fmtClock(store.runElapsed(run));
  p.done.textContent = totals.done + "/" + totals.total + " final";
  p.spend.textContent = fmtUsd(totals.spend_usd);
  p.mult.textContent = fmtMult(totals.lowest_multiplier);
  p.mult.classList.toggle("cut", totals.lowest_multiplier < 1);
  p.mcq.hidden = totals.pending_mcqs === 0;
  chip.title = "Open " + run.run_id + " (" + (run.kind || "run") + ", " + (run.mode || "") + ")";
}

function buildStrip() {
  const list = el("div", "run-strip-list");
  const node = el("div", { class: "run-strip", hidden: true }, el("span", "caps dim", "Active"), list);
  const render = () => {
    const runs = store.activeRuns();
    node.hidden = runs.length === 0;
    syncList(list, runs, (run) => run.run_id, createRunChip, updateRunChip);
  };
  return { node, render };
}

const inboxParts = new WeakMap();

function createInboxItem(item, close) {
  const p = {
    title: el("span", "inbox-title"),
    where: el("span", "inbox-where dim"),
    detail: el("span", "inbox-detail dim clamp-2"),
    time: el("span", "inbox-time num"),
  };
  p.anchor = link(item.href, { class: "inbox-item inbox-" + item.kind },
    icon(INBOX_ICON[item.kind] || "info"),
    el("span", "inbox-main", el("span", "inbox-line", p.title, item.special ? badge("Special One", "special", "star") : null), p.where, p.detail),
    p.time);
  p.anchor.addEventListener("click", close);
  const row = el("li", null, p.anchor);
  inboxParts.set(row, p);
  return row;
}

function updateInboxItem(row, item) {
  const p = inboxParts.get(row);
  p.title.textContent = item.title;
  p.where.textContent = (item.panorama_id ? item.panorama_id + " · " : "") + item.run_id;
  const detail = item.kind === "mcq" ? item.question : item.detail;
  p.detail.textContent = detail || "";
  p.detail.hidden = !detail;
  p.time.textContent = item.seconds_left === null ? "" : fmtCountdown(item.seconds_left);
  p.anchor.title = item.text;
}

function buildInbox() {
  const count = el("span", { class: "inbox-count num", "aria-hidden": "true" });
  // The time left on the most urgent question, readable from any screen without opening the list.
  const mcqLeft = el("span", { class: "inbox-mcq-left num", "aria-hidden": "true", hidden: true });
  const button = el("button", {
    type: "button", class: "inbox-btn", "aria-haspopup": "true", "aria-expanded": "false",
  }, icon("inbox"), el("span", null, "Inbox"), count, mcqLeft);
  const list = el("ul", "inbox-list");
  const empty = el("div", "inbox-empty dim", icon("check"), "Nothing needs you right now.");
  const heading = el("div", "inbox-head caps dim", "Needs a human, most urgent first");
  const dropdown = el("div", { class: "inbox-panel", hidden: true }, heading, list, empty);
  const node = el("div", "inbox", button, dropdown);

  const setOpen = (open) => {
    dropdown.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  const close = () => setOpen(false);
  button.addEventListener("click", () => setOpen(dropdown.hidden));
  document.addEventListener("pointerdown", (event) => {
    if (!dropdown.hidden && !node.contains(event.target)) close();
  });

  const render = (items) => {
    const question = items.find((item) => item.kind === "mcq") || null; // sorted: the most urgent one
    const urgent = question !== null;
    count.textContent = String(items.length);
    count.hidden = items.length === 0;
    const left = urgent && question.seconds_left !== null ? fmtCountdown(question.seconds_left) : "";
    mcqLeft.textContent = urgent ? "MCQ" + (left ? " " + left : "") : "";
    mcqLeft.hidden = !urgent;
    button.classList.toggle("has-items", items.length > 0);
    button.classList.toggle("urgent", urgent);
    const summary = items.length === 0 ? "nothing waiting" : items.length + " waiting" + (urgent ? ", a question is pending" : "");
    button.title = "Attention inbox: " + summary;
    button.setAttribute("aria-label", "Attention inbox, " + summary);
    empty.hidden = items.length > 0;
    heading.hidden = items.length === 0;
    syncList(list, items, (item) => item.id, (item) => createInboxItem(item, close), updateInboxItem);
  };
  return { node, render, close, isOpen: () => !dropdown.hidden };
}

// OpenAI, Google, Mapillary, internet (UI-SPEC 5.1). Red when missing or failing; the word says
// which, so the state is never colour alone. The key chips open Settings at the keys, the
// internet chip at the reachability table.
function chipStates(health) {
  if (!health) {
    return ["OpenAI", "Google", "Mapillary", "Internet"].map((name) => ({
      name, state: "unknown", word: healthCheck, section: name === "Internet" ? "health" : "keys", tip: name + ": not checked yet",
    }));
  }
  const key = (name, value, what) => {
    const chip = { name, section: "keys" };
    if (!value || !value.present) return { ...chip, state: "bad", word: "missing", tip: what + " is not set. Open Settings to add it." };
    if (value.ok === false) return { ...chip, state: "bad", word: "failing", tip: what + " is set but the last check failed. Open Settings to test it." };
    if (value.ok === true) return { ...chip, state: "ok", word: "ok", tip: what + " is set and answering." };
    return { ...chip, state: "ok", word: "set", tip: what + " is set." };
  };
  const net = health.internet || {};
  const internet = { name: "Internet", section: "health" };
  if (net.ok === false) Object.assign(internet, { state: "bad", word: "offline", tip: "The server cannot reach the internet: model calls and lookups will fail. Open Settings to see what was tried." });
  else if (net.ok === true) Object.assign(internet, { state: "ok", word: "ok", tip: "The server can reach the internet." });
  else Object.assign(internet, { state: "unknown", word: healthCheck, tip: "Internet reachability has not been checked yet. Open Settings to check it." });
  return [
    key("OpenAI", health.openai, "OPENAI_API_KEY"),
    key("Google", health.google, "GOOGLE_MAPS_API_KEY"),
    key("Mapillary", health.mapillary, "MAPILLARY_TOKEN"),
    internet,
  ];
}

const HEALTH_ICON = { ok: "check", bad: "x", unknown: "question" };

function buildHealth() {
  const node = el("div", { class: "health-chips", role: "group", "aria-label": "Health" });
  let signature = "";
  const render = (health) => {
    const states = chipStates(health);
    const lan = Boolean(health && health.lan);
    const next = JSON.stringify([states, lan]);
    if (next === signature) return; // rebuilt only on a change, so focus and hover survive
    signature = next;
    replace(node, states.map((chip) => link(paths.settings(chip.section), {
      class: "health-chip is-" + chip.state, title: chip.tip, "aria-label": chip.name + ": " + chip.word,
    }, icon(HEALTH_ICON[chip.state]), el("span", null, chip.name), chip.state === "ok" ? null : el("span", "health-word", chip.word))),
    lan ? link(paths.settings("lan"), { class: "health-chip is-unknown", title: "LAN access is on: other machines with the token can open this console." }, icon("wifi"), "LAN") : null);
  };
  return { node, render };
}

function buildConnection() {
  const node = el("span", { class: "conn", role: "status" });
  let shown = null;
  const render = (state) => {
    const mode = state.connected ? "up" : state.everConnected ? "down" : "connecting";
    if (mode === shown) return;
    shown = mode;
    node.className = "conn conn-" + mode;
    const text = { up: "live", down: "offline", connecting: "connecting" }[mode];
    node.title = { up: "Event stream connected", down: "Event stream disconnected", connecting: "Connecting to the event stream" }[mode];
    replace(node, icon(mode === "up" ? "wifi" : "wifi-off"), el("span", null, text));
  };
  return { node, render };
}

function buildBanners() {
  const fake = el("div", { class: "banner banner-fake", role: "status", hidden: true },
    icon("alert"), el("strong", null, "FAKE MODEL"),
    el("span", null, "This server answers with the scripted demo model. Nothing here is a real result and none of it may be submitted."));
  const offlineText = el("span");
  const offline = el("div", { class: "banner banner-offline", role: "alert", hidden: true },
    icon("wifi-off"), el("strong", null, "Event stream disconnected"), offlineText);
  const node = el("div", "shell-banners", fake, offline);
  const mountedAt = Date.now();
  const render = (state) => {
    fake.hidden = !(state.health && state.health.fake_model);
    // Do not flash the banner during the first moments of a page load.
    const down = !state.connected && (state.everConnected || Date.now() - mountedAt > 2500);
    offline.hidden = !down;
    if (!down) return;
    const age = state.lastContactMs ? "Showing the state of " + fmtAgo((Date.now() - state.lastContactMs) / 1000) + "; " : "No state received yet; ";
    offlineText.textContent = age + "retrying. Controls that charge a penalty are disabled until the stream is back.";
  };
  return { node, render };
}

function themeButton() {
  const button = toggleButton("", () => prefs.set("theme", prefs.get("theme") === "light" ? "dark" : "light"));
  const render = () => {
    const light = prefs.get("theme") === "light";
    const title = light ? "Switch to the dark theme" : "Switch to the light theme";
    button.title = title;
    button.setAttribute("aria-label", title);
    replace(button, icon(light ? "moon" : "sun"));
  };
  prefs.onChange("theme", render);
  render();
  return button;
}

function prefButton(key, onIcon, offIcon, name, onclick) {
  const button = toggleButton("", onclick);
  const render = () => {
    const on = Boolean(prefs.get(key));
    const title = name + ": " + (on ? "on" : "off");
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-pressed", String(on));
    replace(button, icon(on ? onIcon : offIcon));
  };
  prefs.onChange(key, render);
  render();
  return button;
}

function jumpToMcq() {
  const pending = oldestPendingMcq(store.state, Date.now());
  if (!pending) {
    toast("No question is waiting.", "info");
    return;
  }
  // Already on that panorama with the question opened once: say "open" again, so the screen
  // scrolls back to the panel instead of doing nothing.
  const here = window.location.pathname + window.location.search;
  if (here === pending.href) setQuery({ open: null });
  navigate(pending.href);
}

// The snapshot only says whether the keys are set. Whether the internet and the OpenAI key
// answer is found out by GET /api/health, which the server otherwise runs only when the Settings
// screen asks: one request when the page loads fills the chips. Never polled; the result comes
// back on the stream as a `health` message, for every tab.
let healthAsked = false;
let healthCheck = "checking"; // the word on a chip whose state is not known: "checking", then "unknown"

function healthUnknown(health) {
  if (!health) return true;
  if (!health.internet || typeof health.internet.ok !== "boolean") return true;
  return Boolean(health.openai && health.openai.present && typeof health.openai.ok !== "boolean");
}

function fillHealthOnce(onSettled) {
  if (healthAsked) return;
  healthAsked = true;
  const settle = () => {
    healthCheck = "unknown";
    onSettled();
  };
  store.ready.then(() => {
    if (!healthUnknown(store.state.health)) return settle();
    // A failed check leaves the chips on "unknown"; the Settings screen shows why.
    return api.get("/api/health", { timeoutMs: 20000 }).then(settle, settle);
  });
}

/**
 * Build the shell into `root`. Returns `{outlet, setRoute({path, shell})}`: screens mount into
 * `outlet`; setRoute marks the active nav entry and hides the shell for a `shell: false` route.
 */
export function mountShell(root) {
  const nav = buildNav();
  const strip = buildStrip();
  const inbox = buildInbox();
  const health = buildHealth();
  const connection = buildConnection();
  const banners = buildBanners();

  const bar = el("header", "shell-bar",
    link("/", { class: "brand", title: "astrolabio console" }, icon("target"), el("span", null, APP_NAME)),
    nav.node,
    el("span", "grow"),
    health.node,
    inbox.node,
    el("div", "shell-tools",
      prefButton("sound", "volume", "volume-off", "Sound when a question arrives", toggleSound),
      prefButton("notifications", "bell", "bell-off", "Browser notification when a question arrives", toggleNotifications),
      themeButton(),
      el("button", { type: "button", class: "icon-btn shell-toggle", title: "Keyboard shortcuts (?)", "aria-label": "Keyboard shortcuts", onclick: showShortcuts }, icon("keyboard"))),
    connection.node);
  const top = el("div", "shell-top", bar, strip.node, banners.node);
  const outlet = el("main", { class: "outlet", id: "outlet" });
  root.classList.add("app");
  root.replaceChildren(top, outlet);

  const render = () => {
    const state = store.state;
    // CSS backstop for UI-SPEC 5.1 (see base.css): no penalised button is clickable while down.
    document.documentElement.classList.toggle("stream-down", !state.connected);
    strip.render();
    inbox.render(attentionItems(state, Date.now()));
    health.render(state.health);
    connection.render(state);
    banners.render(state);
    refreshTitle();
    placeToasts(); // a bar that sticks to the window bottom may have come or gone
  };
  const onData = () => {
    checkNewMcqs();
    refreshTitle();
  };
  store.subscribe(render);
  for (const kind of ["snapshot", "pano", "run", "ping"]) store.on(kind, onData);
  store.on("connection", ({ connected }) => {
    render();
    // A penalty must not be confirmed against state that may be stale.
    const open = confirmDialog.current;
    if (!connected && open && open.options.tone === "penalty") {
      open.lock("The event stream dropped, so this page may be out of date. Close this and try again once it is back.");
    }
  });
  store.on("snapshot", ({ bootChanged }) => {
    if (bootChanged) toast("The server was restarted. The page reloaded its state; runs that were active are now marked interrupted.", "warn");
  });
  setInterval(render, 1000); // clocks and countdowns tick locally between messages
  render();

  // Screens position sticky headers under the shell with var(--shell-h).
  const publishHeight = () => {
    const height = root.classList.contains("no-shell") ? 0 : top.offsetHeight;
    document.documentElement.style.setProperty("--shell-h", height + "px");
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(publishHeight).observe(top);
  publishHeight();

  document.addEventListener("pointerdown", unlockAudio, { capture: true });
  document.addEventListener("keydown", unlockAudio, { capture: true });

  // UI-SPEC 7. The four "g" keys and "?" are reserved: they mean the same on every screen. On
  // the stage view (no shell) nothing here may take the projector away from the stage, so the
  // keys that navigate are off there and only the stage's own keys leave it.
  shortcuts.register("Go to", {
    "g r": { label: "Runs", run: () => navigate(paths.runs()) },
    "g n": { label: "New run", run: () => navigate(paths.newRun()) },
    "g e": { label: "Evaluation", run: () => navigate(paths.evaluation()) },
    "g s": { label: "Settings", run: () => navigate(paths.settings()) },
  }, { reserved: true, when: () => !suppressed });
  shortcuts.register("Anywhere", {
    m: { label: "Jump to the oldest pending MCQ (opens its panel; sends nothing)", run: jumpToMcq },
  }, { when: () => !suppressed });
  shortcuts.register("Help", {
    "?": { label: "Show this list of shortcuts", run: showShortcuts },
  }, { reserved: true });
  shortcuts.register("Shell", {
    Escape: {
      label: "Close the inbox or the side panel",
      when: () => inbox.isOpen() || sidePanel.isOpen(),
      run: () => {
        if (inbox.isOpen()) inbox.close();
        else sidePanel.close();
      },
    },
  });
  fillHealthOnce(() => render());

  const setRoute = ({ path, shell = true }) => {
    suppressed = !shell;
    root.classList.toggle("no-shell", !shell);
    nav.setPath(path);
    inbox.close();
    sidePanel.drop();
    publishHeight();
    refreshTitle();
  };
  return { outlet, setRoute };
}
