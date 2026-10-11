// The pure half of router.js (matching and URL building) and prefs.js on its in-memory fallback.
import test from "node:test";
import assert from "node:assert/strict";

import { matchRoute, paths } from "../../server/static/console/js/router.js";
import { DEFAULTS, prefs } from "../../server/static/console/js/prefs.js";

// The table of main.js, in its order.
const ROUTES = [
  { path: "/", name: "runs" },
  { path: "/new", name: "new-run" },
  { path: "/eval", name: "eval" },
  { path: "/settings", name: "settings" },
  { path: "/runs/:runId", name: "dashboard" },
  { path: "/runs/:runId/stage", name: "stage", shell: false },
  { path: "/runs/:runId/submit", name: "submission" },
  { path: "/runs/:runId/:pid", name: "focus" },
];
const name = (pathname) => { const found = matchRoute(ROUTES, pathname); return found ? found.route.name : null; };

test("every route of UI-SPEC 4 matches its screen", () => {
  assert.equal(name("/"), "runs");
  assert.equal(name("/new"), "new-run");
  assert.equal(name("/eval"), "eval");
  assert.equal(name("/settings"), "settings");
  assert.equal(name("/runs/20261010T174153Z"), "dashboard");
  assert.equal(name("/runs/r1/stage"), "stage");
  assert.equal(name("/runs/r1/submit"), "submission");
  assert.equal(name("/runs/r1/pano_3"), "focus");
  assert.equal(name("/runs/r1/"), "dashboard", "a trailing slash is the same page");
  assert.equal(name("/runs"), null);
  assert.equal(name("/runs/r1/p1/extra"), null);
  assert.equal(name("/nowhere"), null);
});

test("stage and submit win over a panorama id, and ids are decoded", () => {
  assert.deepEqual(matchRoute(ROUTES, "/runs/r1/stage").params, { runId: "r1" });
  assert.deepEqual(matchRoute(ROUTES, "/runs/run%20%231/pano%201%2Fa").params, { runId: "run #1", pid: "pano 1/a" });
  assert.equal(matchRoute(ROUTES, "/runs/%E0%A4%A/p"), null, "a malformed escape is not an id");
});

test("paths builds the app's URLs with ids escaped and empty query keys left out", () => {
  assert.equal(paths.runs(), "/");
  assert.equal(paths.run("run #1"), "/runs/run%20%231");
  assert.equal(paths.run("r1", { density: "board", sort: null, pano: "" }), "/runs/r1?density=board");
  assert.equal(paths.pano("r1", "pano 1/a", { at: 120, open: false }), "/runs/r1/pano%201%2Fa?at=120");
  assert.equal(paths.stage("r1", { pano: "p2" }), "/runs/r1/stage?pano=p2");
  assert.equal(paths.submit("r1"), "/runs/r1/submit");
  assert.equal(paths.newRun({ preset: "eval", limit: 1 }), "/new?preset=eval&limit=1");
  assert.equal(paths.evaluation({ tab: "compare", a: "r1", b: "r2:hedge" }), "/eval?tab=compare&a=r1&b=r2%3Ahedge");
  assert.equal(paths.settings("health"), "/settings#health");
  assert.equal(paths.settings(), "/settings");
  // Every built path matches the route it is meant for.
  assert.equal(name(new URL(paths.pano("run #1", "a b"), "http://x").pathname), "focus");
});

test("prefs: defaults, set, remove and change listeners", () => {
  assert.equal(prefs.get("theme"), DEFAULTS.theme);
  assert.equal(prefs.get("density"), "tiles");
  assert.equal(prefs.get("cueDraft:r1:p1", ""), "", "an unknown key gives the caller's fallback");
  const seen = [];
  const off = prefs.onChange("theme", (value, key) => seen.push(key + "=" + value));
  prefs.set("theme", "light");
  assert.equal(prefs.get("theme"), "light");
  prefs.remove("theme");
  assert.equal(prefs.get("theme"), "dark");
  off();
  prefs.set("theme", "light");
  prefs.set("theme", null);
  assert.deepEqual(seen, ["theme=light", "theme=dark"]);

  prefs.set("cueDraft:r1:p1", "narrow street, tram rails");
  assert.equal(prefs.get("cueDraft:r1:p1", ""), "narrow street, tram rails");
  prefs.set("cueDraft:r1:p1", null);
  assert.equal(prefs.get("cueDraft:r1:p1", ""), "");
  prefs.set("sound", false);
  assert.equal(prefs.get("sound"), false, "a stored false is not replaced by the default");
  prefs.remove("sound");
});
