// Boot of the console: theme, shell, route table, event stream.
//
// Screens are loaded on demand from js/screens/<name>.js and export
// `mount(container, params, ctx) -> {unmount()?, onQuery?(query)}`.

import { errorText } from "./api.js";
import { mountShell, setDocumentTitle, toast } from "./components/shell.js";
import { prefs } from "./prefs.js";
import { currentRoute, defineRoutes, reload, startRouter } from "./router.js";
import { store } from "./store.js";

const screen = (name) => () => import("./screens/" + name + ".js");

// First match wins, so the fixed third segments ("stage", "submit") come before ":pid" (A.0).
const ROUTES = [
  { path: "/", name: "runs", load: screen("runs") },
  { path: "/new", name: "new-run", load: screen("new-run") },
  { path: "/eval", name: "eval", load: screen("eval") },
  { path: "/settings", name: "settings", load: screen("settings") },
  { path: "/runs/:runId", name: "dashboard", load: screen("dashboard") },
  { path: "/runs/:runId/stage", name: "stage", load: screen("stage"), shell: false },
  { path: "/runs/:runId/submit", name: "submission", load: screen("submission") },
  { path: "/runs/:runId/:pid", name: "focus", load: screen("focus") },
];

let onStage = false;

// The stage view follows its own theme setting (UI-SPEC 7): a dark console next to a bright
// projector image, or the other way round.
function applyTheme() {
  const theme = prefs.get(onStage ? "stageTheme" : "theme");
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

// Nothing silent: an error that no screen caught still reaches the operator.
function reportStray(reason) {
  if (reason && reason.name === "AbortError") return;
  console.error(reason);
  toast("Something went wrong in the page: " + errorText(reason), "error");
}

// Screens that are mostly a form the operator is filling in: remounting would throw the input away.
const KEEP_ON_RESTART = new Set(["new-run", "settings"]);

// After a server restart nothing a screen loaded can be trusted (a run it showed as live is now
// interrupted, its jobs are gone), so the current screen is mounted again from the new state.
function onServerRestart() {
  const route = currentRoute();
  if (route && !KEEP_ON_RESTART.has(route.name)) reload();
}

function boot() {
  applyTheme();
  prefs.onChange("theme", applyTheme);
  prefs.onChange("stageTheme", applyTheme);

  const shell = mountShell(document.getElementById("app"));
  defineRoutes(ROUTES);
  store.on("snapshot", ({ bootChanged }) => { if (bootChanged) onServerRestart(); });
  store.connect();

  window.addEventListener("unhandledrejection", (event) => reportStray(event.reason));
  window.addEventListener("error", (event) => { if (event.error) reportStray(event.error); });

  startRouter({
    outlet: shell.outlet,
    setTitle: setDocumentTitle,
    onRoute: ({ route, path }) => {
      onStage = Boolean(route && route.name === "stage");
      shell.setRoute({ path, shell: !route || route.shell !== false });
      applyTheme();
    },
  });
}

boot();
