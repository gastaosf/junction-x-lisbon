// Client-side router on the History API (UI-SPEC section 4, contract 6.1 + A1 + A11).
//
// Routes are matched in the order they were declared, first match wins: declare
// "/runs/:runId/stage" and "/runs/:runId/submit" before "/runs/:runId/:pid" (A.0).
// A screen module exports `mount(container, params, ctx) -> {unmount()?, onQuery?(query)}` (the
// result may be a promise). `ctx = {query, setTitle(text), params, path, hash}`. Every route change
// calls the previous screen's unmount; a change of the query string alone calls `onQuery`.
//
// Query keys are fixed by contract A1 ("URL contract"); screens read them with query() and write
// them with setQuery() so that a reload or a pasted link lands in the same place.

import { el, icon } from "./dom.js";

let routes = [];
let settings = { outlet: null, onRoute: null, setTitle: null };
let current = null; // {route, params, container, handle}
let navToken = 0; // increases with every navigation so a slow import cannot mount into a newer screen
let currentPath = null;
let lastSearch = "";
let started = false;
const queryListeners = new Set();

const enc = encodeURIComponent;

// ---------------------------------------------------------------- matching (pure)

function segmentsOf(pathname) {
  return String(pathname).split("/").filter(Boolean);
}

/** Match a pathname against the declared routes. Returns `{route, params}` or null. */
export function matchRoute(list, pathname) {
  const parts = segmentsOf(pathname);
  for (const route of list) {
    const pattern = segmentsOf(route.path);
    if (pattern.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pattern.length && ok; i += 1) {
      if (pattern[i].startsWith(":")) {
        try {
          params[pattern[i].slice(1)] = decodeURIComponent(parts[i]);
        } catch (_) {
          ok = false; // a malformed escape is not a valid id
        }
      } else ok = pattern[i] === parts[i];
    }
    if (ok) return { route, params };
  }
  return null;
}

function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== null && value !== undefined && value !== "" && value !== false) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? "?" + text : "";
}

/** Builders for the app's own URLs, with ids escaped. `query` objects use the keys of A1. */
export const paths = {
  runs: () => "/",
  newRun: (query) => "/new" + queryString(query),
  run: (runId, query) => "/runs/" + enc(runId) + queryString(query),
  pano: (runId, pid, query) => "/runs/" + enc(runId) + "/" + enc(pid) + queryString(query),
  stage: (runId, query) => "/runs/" + enc(runId) + "/stage" + queryString(query),
  submit: (runId) => "/runs/" + enc(runId) + "/submit",
  evaluation: (query) => "/eval" + queryString(query),
  settings: (section) => "/settings" + (section ? "#" + enc(section) : ""),
};

// Only the app's own paths are navigable: nothing that could be read as another origin or scheme.
function safePath(path) {
  const text = String(path ?? "");
  return text.startsWith("/") && !text.startsWith("//") && !text.startsWith("/\\") ? text : "/";
}

// ---------------------------------------------------------------- query

/** The current query string as URLSearchParams (a copy: change it with setQuery). */
export function query() {
  return new URLSearchParams(window.location.search);
}

function notifyQuery() {
  if (window.location.search === lastSearch) return;
  lastSearch = window.location.search;
  const now = query();
  if (current && current.handle && typeof current.handle.onQuery === "function") {
    try {
      current.handle.onQuery(now);
    } catch (err) {
      console.error("onQuery failed", err);
    }
  }
  for (const fn of Array.from(queryListeners)) {
    try {
      fn(now);
    } catch (err) {
      console.error("query listener failed", err);
    }
  }
}

/**
 * Change query keys in place: `setQuery({at: 120, event: null})`; null, "" and false remove a key.
 * Replaces the history entry unless `{replace: false}`. The screen's onQuery and the
 * onQueryChange listeners are called when the query actually changed.
 */
export function setQuery(changes, { replace = true } = {}) {
  const params = query();
  for (const [key, value] of Object.entries(changes || {})) {
    if (value === null || value === undefined || value === "" || value === false) params.delete(key);
    else params.set(key, String(value));
  }
  const text = params.toString();
  const search = text ? "?" + text : "";
  if (search === window.location.search) return;
  const url = window.location.pathname + search + window.location.hash;
  window.history[replace ? "replaceState" : "pushState"](null, "", url);
  notifyQuery();
}

/** Call `fn(query)` whenever the query string changes without a route change. Returns an unsubscribe. */
export function onQueryChange(fn) {
  queryListeners.add(fn);
  return () => queryListeners.delete(fn);
}

// ---------------------------------------------------------------- rendering

function scrollToHash() {
  const hash = window.location.hash;
  if (hash.length < 2) return;
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch (_) {
    // keep the raw text
  }
  const target = document.getElementById(id);
  if (target) target.scrollIntoView({ block: "start" });
}

function teardown() {
  const leaving = current;
  current = null;
  if (!leaving || !leaving.handle || typeof leaving.handle.unmount !== "function") return;
  try {
    leaving.handle.unmount();
  } catch (err) {
    console.error("unmount failed", err);
  }
}

function failurePanel(err) {
  const message = err && err.message ? String(err.message) : String(err);
  const stack = err && err.stack ? String(err.stack) : "";
  return el("div", "card screen-error",
    el("h2", "card-title row", icon("alert"), "This screen failed to load"),
    el("p", "dim", "The rest of the console keeps working. The error was:"),
    el("pre", "error-text", message),
    stack && stack !== message ? el("details", null, el("summary", null, "Technical detail"), el("pre", "error-text dim", stack)) : null,
    el("div", "row",
      el("button", { type: "button", class: "primary", onclick: () => reload() }, icon("refresh"), "Try again"),
      el("button", { type: "button", onclick: () => window.location.reload() }, "Reload the page"),
      link("/", { class: "btn" }, "Back to runs")));
}

function notFoundPanel(pathname) {
  return el("div", "card screen-error",
    el("h2", "card-title row", icon("question"), "No such page"),
    el("p", null, "Nothing in the console lives at ", el("code", null, pathname), "."),
    el("div", "row", link("/", { class: "btn primary" }, "Go to runs")));
}

async function render() {
  navToken += 1;
  const token = navToken;
  teardown();

  const pathname = window.location.pathname;
  currentPath = pathname;
  lastSearch = window.location.search;
  const found = matchRoute(routes, pathname);
  const name = found && found.route.name ? " screen-" + found.route.name : "";
  // A fresh container per navigation: a screen that is still loading when the operator moves on
  // can only ever write into a node that is no longer in the page.
  const container = el("div", "screen" + name);
  settings.outlet.replaceChildren(container);
  window.scrollTo(0, 0);
  if (settings.setTitle) settings.setTitle("");
  if (settings.onRoute) {
    settings.onRoute({ route: found ? found.route : null, params: found ? found.params : {}, path: pathname });
  }
  if (!found) {
    container.append(notFoundPanel(pathname));
    return;
  }

  current = { route: found.route, params: found.params, container, handle: null };
  const mine = current;
  const loading = setTimeout(() => {
    if (token === navToken && !container.firstChild) container.append(el("p", "screen-loading dim", "Loading…"));
  }, 200);
  const ctx = {
    query: query(),
    setTitle: (text) => { if (token === navToken && settings.setTitle) settings.setTitle(text); },
    params: found.params,
    path: pathname,
    hash: window.location.hash.slice(1),
  };
  try {
    const module = await found.route.load();
    if (token !== navToken) return;
    if (!module || typeof module.mount !== "function") throw new Error("the screen module does not export mount()");
    clearTimeout(loading);
    container.replaceChildren();
    const handle = await module.mount(container, found.params, ctx);
    if (token !== navToken) {
      // The operator left while the screen was mounting: undo it straight away.
      if (handle && typeof handle.unmount === "function") handle.unmount();
      return;
    }
    mine.handle = handle || null;
    scrollToHash();
  } catch (err) {
    clearTimeout(loading);
    if (token !== navToken) return;
    console.error("screen failed to load", err);
    container.replaceChildren(failurePanel(err));
  }
}

/** Mount the current route again (the "Try again" of the failure panel). */
export function reload() {
  if (started) render();
}

function onPopState() {
  if (window.location.pathname !== currentPath) render();
  else {
    notifyQuery();
    scrollToHash();
  }
}

// ---------------------------------------------------------------- public API

/**
 * Declare the route table: `[{path: "/runs/:runId/:pid", load: () => import(...), name?, shell?}]`.
 * `shell: false` marks a route that hides the shell (the stage view); `name` becomes the class
 * `screen-<name>` on the screen container.
 */
export function defineRoutes(list) {
  routes = list.slice();
}

/**
 * Start routing into `outlet`. `onRoute({route, params, path})` runs on every route change before
 * the screen loads; `setTitle(text)` receives the screen's title (reset to "" on each change).
 */
export function startRouter({ outlet, onRoute = null, setTitle = null }) {
  settings = { outlet, onRoute, setTitle };
  if (!started) {
    started = true;
    window.addEventListener("popstate", onPopState);
  }
  return render();
}

/** Go to a path of the app ("/runs/x?density=board"). `{replace: true}` does not add a history entry. */
export function navigate(path, { replace = false } = {}) {
  const url = new URL(safePath(path), window.location.origin);
  const here = window.location;
  const samePath = url.pathname === here.pathname;
  const sameAll = samePath && url.search === here.search && url.hash === here.hash;
  if (!sameAll) {
    window.history[replace ? "replaceState" : "pushState"](null, "", url.pathname + url.search + url.hash);
  }
  if (!started) return;
  if (samePath && currentPath === url.pathname) {
    notifyQuery();
    scrollToHash();
  } else render();
}

/**
 * An <a> that navigates inside the app. `link(path, ...children)`; as with el(), a plain object
 * as the first child is its attributes (`link(path, {class: "btn"}, "Open")`). Modified clicks
 * (new tab, new window) keep the browser's behaviour.
 */
export function link(path, ...children) {
  const [first, ...rest] = children;
  const hasAttrs = first !== null && typeof first === "object" && !Array.isArray(first) && typeof first.nodeType !== "number";
  // el() reads a string in second place as a class name; here every string is a child.
  const anchor = hasAttrs ? el("a", first, ...rest) : el("a", null, ...children);
  anchor.setAttribute("href", safePath(path));
  anchor.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(anchor.getAttribute("href"));
  });
  return anchor;
}

/** The route that is mounted now: `{name, path, params}` or null. */
export function currentRoute() {
  if (!current) return null;
  return { name: current.route.name || null, path: current.route.path, params: current.params };
}
