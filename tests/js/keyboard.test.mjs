// keyboard.js without a DOM: handle() is given plain objects that look like keydown events.
import test from "node:test";
import assert from "node:assert/strict";

import { isTyping, keyName, shortcuts } from "../../server/static/console/js/keyboard.js";

const press = (key, extra = {}) => shortcuts.handle({ key, target: { tagName: "BODY" }, preventDefault() {}, ...extra });

// Each test registers its own scopes and removes them again: the registry is one per page.
function scope(t, name, bindings, options) {
  const off = shortcuts.register(name, bindings, options);
  t.after(off);
  return off;
}

test("a single key and a two-key sequence", (t) => {
  const ran = [];
  scope(t, "Global", {
    "g r": { label: "Runs", run: () => ran.push("runs") },
    "g s": { label: "Settings", run: () => ran.push("settings") },
    m: { label: "MCQ", run: () => ran.push("mcq") },
  });
  assert.equal(press("m"), true);
  assert.equal(press("g"), true, "the first key of a sequence is taken");
  assert.equal(press("s"), true);
  assert.equal(press("s"), false, "without its prefix the second key means nothing");
  assert.equal(press("G"), true, "letters are matched in lower case");
  assert.equal(press("r"), true);
  assert.deepEqual(ran, ["mcq", "settings", "runs"]);
});

test("keys are left alone while typing, with a modifier, or when already handled", (t) => {
  const ran = [];
  scope(t, "Global", { m: { label: "MCQ", run: () => ran.push("m") } });
  assert.equal(press("m", { target: { tagName: "TEXTAREA" } }), false);
  assert.equal(press("m", { target: { tagName: "INPUT", type: "text" } }), false);
  assert.equal(press("m", { target: { tagName: "INPUT", type: "checkbox" } }), true, "a checkbox is not a text field");
  assert.equal(press("m", { ctrlKey: true }), false);
  assert.equal(press("m", { metaKey: true }), false);
  assert.equal(press("m", { defaultPrevented: true }), false);
  assert.equal(press("Shift"), false);
  assert.deepEqual(ran, ["m"]);
  assert.equal(isTyping({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(keyName({ key: " " }), "Space");
});

test("a later scope overrides a key, unless the key is reserved", (t) => {
  const ran = [];
  scope(t, "Go to", {
    "g s": { label: "Settings", run: () => ran.push("settings") },
    "?": { label: "Shortcuts", run: () => ran.push("help") },
  }, { reserved: true });
  scope(t, "Anywhere", { m: { label: "Oldest MCQ", run: () => ran.push("global m") } });
  scope(t, "Run dashboard", {
    "g s": { label: "Submission (instead of Settings)", run: () => ran.push("submission") },
    m: { label: "Question in its tile", run: () => ran.push("screen m") },
    f: { label: "Focus density", run: () => ran.push("f") },
  });

  press("g"); press("s");
  press("m");
  press("?");
  assert.deepEqual(ran, ["settings", "screen m", "help"], "g s means Settings on every screen; m may be refined by a screen");

  const listed = shortcuts.list().map((row) => row.scope + ": " + row.key);
  assert.ok(listed.includes("Go to: g s"));
  assert.ok(!listed.includes("Run dashboard: g s"), "a binding that cannot run is not listed");
  assert.ok(listed.includes("Run dashboard: m"));
  assert.ok(listed.includes("Run dashboard: f"));
});

test("a scope that is switched off does nothing and is not listed (navigation on the stage view)", (t) => {
  const ran = [];
  let onStage = false;
  scope(t, "Go to", {
    "g r": { label: "Runs", run: () => ran.push("runs") },
    "g e": { label: "Evaluation", run: () => ran.push("eval") },
  }, { reserved: true, when: () => !onStage });
  scope(t, "Anywhere", { m: { label: "Oldest MCQ", run: () => ran.push("m") } }, { when: () => !onStage });
  scope(t, "Stage", {
    r: { label: "Reveal truth", run: () => ran.push("reveal") },
    Escape: { label: "Back to the dashboard", run: () => ran.push("leave") },
  });

  onStage = true;
  assert.equal(press("m"), false);
  assert.equal(press("g"), false, "no sequence starts with g on the stage");
  assert.equal(press("e"), false);
  press("g"); press("r");
  assert.deepEqual(ran, ["reveal"], "r is the stage's own key");
  press("Escape");
  assert.deepEqual(ran, ["reveal", "leave"]);
  assert.deepEqual([...new Set(shortcuts.list().map((row) => row.scope))], ["Stage"]);

  onStage = false;
  press("g"); press("r");
  press("m");
  assert.deepEqual(ran, ["reveal", "leave", "runs", "m"]);
});

test("a binding's own `when`, and a listed binding without `run`", (t) => {
  const ran = [];
  let open = false;
  scope(t, "Shell", { Escape: { label: "Close the inbox", when: () => open, run: () => ran.push("close") } });
  scope(t, "Question panel", { "a-d then Enter": { label: "Choose an option, then send it" } });
  assert.equal(press("Escape"), false);
  open = true;
  assert.equal(press("Escape"), true);
  assert.equal(press("a"), false, "a binding without run is only listed");
  assert.ok(shortcuts.list().some((row) => row.key === "a-d then Enter"));
  assert.deepEqual(ran, ["close"]);
});

test("removing a scope removes its keys", (t) => {
  const ran = [];
  const off = shortcuts.register("Screen", { f: { label: "f", run: () => ran.push("f") } });
  press("f");
  off();
  assert.equal(press("f"), false);
  assert.deepEqual(ran, ["f"]);
  assert.equal(shortcuts.list().some((row) => row.scope === "Screen"), false);
  t.diagnostic("registry left with " + shortcuts.list().length + " rows");
});
