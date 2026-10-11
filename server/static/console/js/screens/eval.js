// Evaluation screen (UI-SPEC 5.9): the shell and its tab bar. Each tab is a module of its own
// under ./eval/, loaded on first use:
//
//   mountTab(container, ctx) -> {unmount()?, onQuery?(query)}      (the result may be a promise)
//   ctx = {query, setTitle(text), setTab(name, extraQuery?)}
//
// The tab is the `?tab=` of contract A1 (`set | label | run | results | compare`); the other keys
// of that URL (`run`, `tag`, `a`, `b`, `pano`) belong to the tabs and are left alone here, so
// coming back to a tab finds it where it was left.

import { errorText } from "../api.js";
import { clear, el, icon } from "../dom.js";
import { TABS, tabOf } from "../logic/evalset.js";
import { setQuery } from "../router.js";

export function mount(container, _params, ctx) {
  let token = 0; // increases with every tab change, so a slow import cannot mount into a newer tab
  let current = null; // {name, handle}
  const retries = new Map(); // tab name -> failed loads so far
  let unmounted = false;

  const buttons = new Map();
  const tablist = el("div", { class: "tabs eval-tabs", role: "tablist", "aria-label": "Evaluation" });
  for (const tab of TABS) {
    const button = el("button", {
      type: "button",
      class: "tab",
      role: "tab",
      id: "eval-tab-" + tab.name,
      "aria-controls": "eval-panel",
      onclick: () => setTab(tab.name),
    }, tab.label);
    buttons.set(tab.name, button);
    tablist.append(button);
  }
  // The usual keys of a tab list: the arrows move along it, Home and End jump to its ends.
  tablist.addEventListener("keydown", (event) => {
    const names = TABS.map((tab) => tab.name);
    const at = names.indexOf(current ? current.name : "set");
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: names.length - 1 }[event.key];
    if (to === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const name = names[(to + names.length) % names.length];
    setTab(name);
    buttons.get(name).focus();
  });

  const panel = el("div", { class: "eval-panel", id: "eval-panel", role: "tabpanel" });

  container.append(
    el("div", "page-head",
      el("h1", "page-title", "Evaluation")),
    // The leak guard, stated where every tab can see it (UI-SPEC 3, "Ground truth never meets a
    // human channel").
    el("div", { class: "notice notice-info eval-guard", role: "note" },
      icon("lock"),
      el("div", null,
        el("strong", null, "Evaluation panoramas carry ground truth. "),
        "An evaluation run is therefore always autonomous: the MCQ, cue and geocode channels are off for it. ",
        "Truth, distance and score are shown only for those runs, never for a run a human could steer.")),
    tablist,
    panel);

  function setTab(name, extraQuery) {
    // A new history entry: Back returns to the tab the operator came from.
    setQuery({ ...(extraQuery || {}), tab: name === "set" ? null : name }, { replace: false });
    // setQuery says nothing when the URL did not change (the tab is already open).
    if (current && current.name === name && current.failed) show(name);
  }

  function release() {
    const leaving = current;
    current = null;
    if (!leaving || !leaving.handle || typeof leaving.handle.unmount !== "function") return;
    try {
      leaving.handle.unmount();
    } catch (err) {
      console.error("tab unmount failed", err);
    }
  }

  function failure(name, err) {
    const label = TABS.find((tab) => tab.name === name).label;
    const stack = err && err.stack ? String(err.stack) : "";
    const message = errorText(err);
    return el("div", { class: "card eval-tab-error stack", role: "alert" },
      el("h2", "card-title row", icon("alert"), "The " + label + " tab failed to load"),
      el("p", null,
        "The other tabs keep working. Try again; if it fails again, check that the server is still running and reload the page. ",
        "The error was:"),
      el("pre", "code-block", message),
      stack && stack !== message
        ? el("details", null, el("summary", null, "Technical detail"), el("pre", "code-block dim", stack))
        : null,
      el("div", "row",
        el("button", { type: "button", class: "primary", onclick: () => show(name) }, icon("refresh"), "Try again")));
  }

  async function show(name) {
    token += 1;
    const mine = token;
    release();
    for (const [tabName, button] of buttons) {
      const selected = tabName === name;
      button.setAttribute("aria-selected", selected ? "true" : "false");
      button.tabIndex = selected ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", "eval-tab-" + name);
    const label = TABS.find((tab) => tab.name === name).label;
    ctx.setTitle("Evaluation: " + label);

    // A fresh node per tab: whatever a tab that is still loading does, it does to a node that
    // is no longer on the page.
    const body = el("div", "eval-tab eval-tab-" + name);
    clear(panel).append(body);
    const loading = setTimeout(() => {
      if (mine === token && !body.firstChild) body.append(el("p", "dim row", el("span", "spinner"), "Loading…"));
    }, 200);
    const entry = { name, handle: null, failed: false };
    current = entry;
    const tabCtx = {
      query: new URLSearchParams(window.location.search),
      setTitle: (text) => {
        if (mine === token) ctx.setTitle(text ? String(text) : "Evaluation: " + label);
      },
      setTab,
    };
    try {
      // A browser may remember a module that failed to load and fail it again without asking
      // the server; a retry asks under a new URL. The modules it imports keep their own URLs,
      // so the store, the router and the rest stay the single instances they are.
      const failed = retries.get(name) || 0;
      const module = await import("./eval/" + name + ".js" + (failed ? "?retry=" + failed : ""));
      if (mine !== token || unmounted) return;
      if (!module || typeof module.mountTab !== "function") throw new Error("the tab module does not export mountTab()");
      clearTimeout(loading);
      clear(body);
      const handle = await module.mountTab(body, tabCtx);
      if (mine !== token || unmounted) {
        if (handle && typeof handle.unmount === "function") handle.unmount();
        return;
      }
      entry.handle = handle || null;
    } catch (err) {
      clearTimeout(loading);
      if (mine !== token || unmounted) return;
      console.error("evaluation tab '" + name + "' failed", err);
      retries.set(name, (retries.get(name) || 0) + 1);
      entry.failed = true;
      clear(body).append(failure(name, err));
    }
  }

  show(tabOf(ctx.query.get("tab")));

  return {
    unmount() {
      unmounted = true;
      token += 1;
      release();
    },
    onQuery(query) {
      const name = tabOf(query.get("tab"));
      if (!current || current.name !== name) {
        show(name);
        return;
      }
      if (current.handle && typeof current.handle.onQuery === "function") {
        try {
          current.handle.onQuery(query);
        } catch (err) {
          console.error("tab onQuery failed", err);
        }
      }
    },
  };
}
