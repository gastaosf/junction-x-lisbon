// Step 1 of New run (UI-SPEC 5.3): the preset. One card per preset the server offers, with what
// it sets and locks read from the launch context, so a card never promises what a launch would
// not do. Choosing one is a radio button: arrow keys move, nothing is launched from here.

import { el, icon, replace } from "../../dom.js";
import { presetFacts, presetNames, presetOf } from "../../logic/launch.js";
import { nextId, stepCard } from "./ui.js";

const PRESET_ICON = { autonomous: "layers", scoring: "flag", live: "play", eval: "target", custom: "settings" };

export function createPresets(c) {
  const step = stepCard("Preset");
  const grid = el("div", { class: "nr-presets", role: "radiogroup", "aria-label": "Preset" });
  step.body.append(grid);
  const group = nextId("nr-preset");
  let built = null; // the context version the cards were built from
  let cards = new Map(); // name -> {root, input}

  function refused(name) {
    const preset = presetOf(c.context, name);
    return Boolean(c.context.fake_model) && (name === "scoring" || name === "live" || preset.kind === "scoring" || preset.kind === "live");
  }

  function build() {
    cards = new Map();
    replace(grid, presetNames(c.context).map((name) => {
      const preset = presetOf(c.context, name);
      const input = el("input", {
        type: "radio", name: group, value: name, class: "nr-preset-input",
        onchange: () => { if (input.checked) c.setPreset(name); },
      });
      const root = el("label", "nr-preset",
        el("div", "row tight nr-preset-head",
          input,
          icon(PRESET_ICON[name] || "dot"),
          el("span", "strong nr-preset-name", preset.label || name)),
        el("div", "small dim nr-preset-text", preset.description || ""),
        el("dl", "nr-preset-facts", presetFacts(c.context, name).map((fact) => [
          el("dt", null, fact.label),
          el("dd", null, fact.value),
        ])),
        refused(name)
          ? el("div", "row tight top small warn-text", icon("alert"), el("span", null, "Refused while the demo model is active."))
          : null);
      cards.set(name, { root, input });
      return root;
    }));
  }

  function update() {
    if (!c.context || c.mode === "add") return;
    if (built !== c.contextVersion) {
      built = c.contextVersion;
      build();
    }
    for (const [name, card] of cards) {
      const on = c.form.preset === name;
      card.input.checked = on;
      card.root.classList.toggle("on", on);
    }
    step.setState({ open: true, status: c.form.preset ? "done" : "todo" });
  }

  return { el: step.el, step, update, destroy() {} };
}
