// DOM helpers for the console. No framework: nodes are built with el() and updated in place.
//
// Every string that originates from the model, the operator, a log, a tool result or a file name
// goes in as a text node. Nothing here parses HTML, and el() refuses the properties that would.

const SVG_NS = "http://www.w3.org/2000/svg";

// Setting these from data would parse markup (or load a document) in the console's own origin.
const FORBIDDEN = new Set(["innerHTML", "outerHTML", "srcdoc", "html"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function setClass(node, value) {
  const names = Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value);
  node.setAttribute("class", names);
}

function setStyle(node, value) {
  if (typeof value === "string") {
    node.setAttribute("style", value);
    return;
  }
  for (const [prop, v] of Object.entries(value)) {
    if (v === null || v === undefined || v === false) continue;
    if (prop.startsWith("--") || prop.includes("-")) node.style.setProperty(prop, String(v));
    else node.style[prop] = v;
  }
}

function setOther(node, key, value) {
  const asAttribute = key.includes("-") || key === "role" || !(key in node);
  if (!asAttribute) {
    try {
      node[key] = value;
      return;
    } catch (_) {
      // Read-only properties (input.list, input.form) fall through to the attribute.
    }
  }
  node.setAttribute(key, value === true ? "" : String(value));
}

function applyAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (FORBIDDEN.has(key)) throw new Error("el(): '" + key + "' is not allowed; build nodes instead");
    if (key === "class" || key === "className") setClass(node, value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") {
      for (const [name, v] of Object.entries(value)) {
        if (v !== null && v !== undefined && v !== false) node.dataset[name] = String(v);
      }
    } else if (key === "style") setStyle(node, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else setOther(node, key, value);
  }
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else if (typeof child === "object" && typeof child.nodeType === "number") node.append(child);
    else node.append(document.createTextNode(String(child)));
  }
}

/**
 * Build an element.
 *   el("div", "card", child, ...)                       a string in place of attrs is a class name
 *   el("button", {class: "primary", onclick: fn, disabled: busy}, "Launch")
 * attrs: `class` (string or array), `text`, `title`, `dataset` {..}, `style` {..}, `on<event>`
 * handlers, anything else as a property or attribute; false / null / undefined are skipped.
 * Children: nodes, strings and numbers (text nodes), arrays; null / false are skipped.
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (typeof attrs === "string") node.className = attrs;
  else if (isPlainObject(attrs)) applyAttrs(node, attrs);
  else children.unshift(attrs); // a node, an array or nothing: the second argument is a child
  appendChildren(node, children);
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Replace the children of `node`; same child rules as el(). */
export function replace(node, ...children) {
  const holder = document.createDocumentFragment();
  appendChildren(holder, children);
  node.replaceChildren(holder);
  return node;
}

// ---------------------------------------------------------------- icons

// 24 x 24, stroke only, drawn for this console. One path string per icon keeps them inspectable.
const CIRCLE = "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20";
const ICONS = {
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
  alert: "M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  clock: CIRCLE + "M12 6v6l4 2",
  play: "M6 4l13 8-13 8V4z",
  stop: "M6 6h12v12H6z",
  pause: "M7 5v14M17 5v14",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  copy: "M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  map: "M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4zM8 2v16M16 6v16",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6",
  search: "M11 3a8 8 0 1 0 0 16a8 8 0 1 0 0-16M21 21l-4.35-4.35",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-up": "M18 15l-6-6-6 6",
  "chevron-right": "M9 18l6-6-6-6",
  "chevron-left": "M15 18l-6-6 6-6",
  "arrow-right": "M5 12h14M13 6l6 6-6 6",
  "arrow-left": "M19 12H5M11 6l-6 6 6 6",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3",
  refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15",
  trash: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  settings: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  flag: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2-6.2 3.2L7 14.2 2 9.3l6.9-1L12 2z",
  wifi: "M5 12.6a11 11 0 0 1 14 0M1.4 9a16 16 0 0 1 21.2 0M8.5 16.1a6 6 0 0 1 7 0M12 20h.01",
  "wifi-off": "M1 1l22 22M16.7 11.1a11 11 0 0 1 2.3 1.5M5 12.6a11 11 0 0 1 5.2-2.4M10.7 5.1A16 16 0 0 1 22.6 9M1.4 9a16 16 0 0 1 4.3-2.7M8.5 16.1a6 6 0 0 1 7 0M12 20h.01",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  "bell-off": "M13.7 21a2 2 0 0 1-3.4 0M18.6 13a17.9 17.9 0 0 1-.6-5 6 6 0 0 0-9.3-5M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M1 1l22 22",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z",
  volume: "M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
  "volume-off": "M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  collapse: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  target: CIRCLE + "M12 6a6 6 0 1 0 0 12a6 6 0 1 0 0-12M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4",
  layers: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  info: CIRCLE + "M12 16v-4M12 8h.01",
  lock: "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4",
  key: "M21 2l-2 2M11.4 11.6a5.5 5.5 0 1 1-7.8 7.8a5.5 5.5 0 0 1 7.8-7.8zM11.4 11.6L15.5 7.5M15.5 7.5l3 3L22 7l-3-3M15.5 7.5L19 4",
  folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  file: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7",
  image: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8.5 7a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3M21 15l-5-5L5 21",
  sun: "M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  question: CIRCLE + "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01",
  keyboard: "M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10",
  dot: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6",
};

export const ICON_NAMES = Object.keys(ICONS);

/**
 * An inline SVG icon from the built-in set. Sized by the surrounding font (CSS `.icon`) unless
 * `size` (px) is given. Decorative: the text beside it carries the meaning.
 */
export function icon(name, { size } = {}) {
  const known = Object.prototype.hasOwnProperty.call(ICONS, name);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon icon-" + (known ? name : "dot"));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (size) {
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.style.width = size + "px";
    svg.style.height = size + "px";
  }
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", known ? ICONS[name] : ICONS.dot);
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------- badges

const BADGE_KINDS = new Set([
  "ok", "warn", "bad", "info", "dim", "special", "penalty", "urban", "nonurban",
  "running", "awaiting_mcq", "done", "pending", "queued", "interrupted", "invalid", "finished",
]);

/** A pill. `kind` picks the colour; pass `iconName` whenever the badge reports a status. */
export function badge(text, kind = "dim", iconName) {
  const safeKind = BADGE_KINDS.has(kind) ? kind : "dim";
  const node = el("span", "badge badge-" + safeKind);
  if (iconName) node.append(icon(iconName));
  node.append(el("span", "badge-text", String(text)));
  return node;
}

// Status is never colour alone: every status has its own word and its own icon.
const STATUS = {
  pending: { text: "pending", icon: "clock" },
  queued: { text: "queued", icon: "clock" },
  running: { text: "running", icon: "play" },
  awaiting_mcq: { text: "awaiting MCQ", icon: "question" },
  done: { text: "done", icon: "check" },
  finished: { text: "finished", icon: "check" },
  interrupted: { text: "interrupted", icon: "alert" },
  invalid: { text: "invalid", icon: "x" },
};

/** Badge for a tile status or a run state. */
export function statusBadge(status) {
  const known = STATUS[status];
  if (!known) return badge(String(status ?? "unknown"), "dim", "info");
  const node = badge(known.text, status, known.icon);
  node.dataset.status = status;
  return node;
}

// ---------------------------------------------------------------- clipboard, timing

function copyViaSelection(text) {
  const area = el("textarea", { value: text, readonly: true, class: "sr-only", "aria-hidden": "true" });
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (_) {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Copy text to the clipboard. Resolves true on success; never rejects. */
export async function copyText(text) {
  const value = String(text ?? "");
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) {
    // Permission denied or the document lost focus: try the selection fallback.
  }
  return copyViaSelection(value);
}

/**
 * A small "copy" button. `source` is the text or a function returning it at click time
 * (coordinates are the hand-off to a second device, so this is used all over the tiles).
 */
export function copyButton(source, { label = "", title = "Copy" } = {}) {
  const mark = el("span", "copy-mark", icon("copy"));
  const button = el("button", { class: "icon-btn copy-btn", type: "button", title, "aria-label": title }, mark, label || null);
  let timer = null;
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const ok = await copyText(typeof source === "function" ? source() : source);
    replace(mark, icon(ok ? "check" : "x"));
    button.classList.toggle("copied", ok);
    clearTimeout(timer);
    timer = setTimeout(() => {
      replace(mark, icon("copy"));
      button.classList.remove("copied");
    }, 1400);
  });
  return button;
}

/** Call `fn` once the calls have stopped for `ms`. The result has `.cancel()` and `.flush()`. */
export function debounce(fn, ms) {
  let timer = null;
  let pending = null;
  const run = () => {
    timer = null;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const debounced = (...args) => {
    pending = args;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    pending = null;
  };
  debounced.flush = () => {
    clearTimeout(timer);
    run();
  };
  return debounced;
}

/**
 * Keyed list update: reuse the node of every item that is still there, so hover, focus and scroll
 * survive a re-render that happens every second. `create(item)` builds a node, `update(node, item)`
 * refreshes it.
 */
export function syncList(container, items, keyOf, create, update) {
  const held = new Map();
  for (const child of Array.from(container.children)) held.set(child.dataset.key, child);
  let previous = null;
  for (const item of items) {
    const key = String(keyOf(item));
    let node = held.get(key);
    if (node) held.delete(key);
    else {
      node = create(item);
      node.dataset.key = key;
    }
    if (update) update(node, item);
    const wanted = previous ? previous.nextSibling : container.firstChild;
    if (node !== wanted) container.insertBefore(node, wanted);
    previous = node;
  }
  for (const node of held.values()) node.remove();
}
