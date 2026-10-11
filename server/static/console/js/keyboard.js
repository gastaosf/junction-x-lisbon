// Keyboard shortcuts (UI-SPEC section 7) as a registry of scopes.
//
//   const off = shortcuts.register("Dashboard", {
//     "f": {label: "Toggle focus density", run: () => ...},
//     "g r": {label: "Go to Runs", run: () => navigate("/")},       // a two-key sequence
//     "a-d then Enter": {label: "Choose and send an MCQ option"},   // no `run`: listed, not handled here
//   });
//
// The shell registers the keys of the UI-SPEC table that belong to no screen ("g r", "?") as a
// `reserved` scope: a screen cannot take them over, so they mean the same thing on every screen.
// A scope can also be given `when()`: while it answers false its keys do nothing and are not
// listed (the navigation keys on the stage view).
//
// Rule for everyone who registers a key: NO SINGLE KEY MAY TRIGGER A PENALISED OR IRREVERSIBLE
// ACTION. A shortcut may open, focus or select; sending a cue, an MCQ answer or a geocode, and
// finalising, stopping or deleting always needs a deliberate second step (Enter on a chosen option,
// a confirm dialog).

const SEQUENCE_MS = 1200; // time allowed between the two keys of "g r"
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Process"]);
const NON_TEXT_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "file", "color"]);

/** The name a binding uses for this key event: letters are lower case, the rest as `event.key`. */
export function keyName(event) {
  const key = event.key;
  if (!key || MODIFIERS.has(key)) return null;
  if (key === " ") return "Space";
  return key.length === 1 ? key.toLowerCase() : key;
}

function normalise(binding) {
  return binding.trim().split(/\s+/).map((part) => (part.length === 1 ? part.toLowerCase() : part)).join(" ");
}

/** True when the event comes from a control the operator is typing in. */
export function isTyping(target) {
  if (!target || !target.tagName) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUT_TYPES.has(String(target.type || "text").toLowerCase());
  return false;
}

class Shortcuts {
  constructor() {
    this.scopes = []; // later scopes win: a screen can override a global key while it is mounted
    this.prefix = null;
    this.prefixTimer = null;
    this.attached = false;
  }

  /**
   * Register the bindings of one scope (a screen, a component, "Global").
   * `bindings` maps a key ("c", "/", "Escape", "ArrowLeft") or a two-key sequence ("g r") to
   * `{label, run(event)?, when()?, inDialog?}`. Options: `reserved` (no other scope can override
   * these keys) and `when()` (the whole scope is off while it returns false). Returns a function
   * that removes the scope.
   */
  register(scopeName, bindings, { reserved = false, when = null } = {}) {
    const scope = { name: scopeName, bindings: new Map(), reserved: Boolean(reserved), when };
    for (const [key, spec] of Object.entries(bindings || {})) {
      if (spec) scope.bindings.set(normalise(key), { key, ...spec });
    }
    this.scopes.push(scope);
    this.attach();
    return () => {
      const index = this.scopes.indexOf(scope);
      if (index !== -1) this.scopes.splice(index, 1);
    };
  }

  isOn(scope) {
    return !scope.when || Boolean(scope.when());
  }

  // Is this combination held by a reserved scope that is on right now?
  reservedBy(combo, except) {
    return this.scopes.some((scope) => scope !== except && scope.reserved && this.isOn(scope) && scope.bindings.has(combo));
  }

  /**
   * Every binding that works right now, for the "?" list: [{scope, key, label}], global scopes
   * first. A scope that is off is left out, and so is a screen's binding for a reserved key.
   */
  list() {
    const rows = [];
    for (const scope of this.scopes) {
      if (!this.isOn(scope)) continue;
      for (const [combo, spec] of scope.bindings) {
        if (!scope.reserved && this.reservedBy(combo, scope)) continue;
        rows.push({ scope: scope.name, key: spec.key, label: spec.label || "" });
      }
    }
    return rows;
  }

  attach() {
    if (this.attached || typeof document === "undefined") return;
    this.attached = true;
    document.addEventListener("keydown", (event) => this.handle(event));
  }

  usable(scope, combo, inDialog) {
    if (!this.isOn(scope)) return null;
    const spec = scope.bindings.get(combo);
    if (!spec || typeof spec.run !== "function") return null;
    if (inDialog && !spec.inDialog) return null;
    if (spec.when && !spec.when()) return null;
    return spec;
  }

  // Reserved scopes first, then the latest scope that has the key.
  find(combo, inDialog) {
    for (const reserved of [true, false]) {
      for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
        if (this.scopes[i].reserved !== reserved) continue;
        const spec = this.usable(this.scopes[i], combo, inDialog);
        if (spec) return spec;
      }
    }
    return null;
  }

  startsSequence(key) {
    const lead = key + " ";
    return this.scopes.some((scope) => this.isOn(scope) && [...scope.bindings.keys()].some((combo) => combo.startsWith(lead)));
  }

  clearPrefix() {
    clearTimeout(this.prefixTimer);
    this.prefix = null;
  }

  /** Handle one keydown. Returns true when a binding ran or a sequence started. */
  handle(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (isTyping(event.target)) return false;
    const key = keyName(event);
    if (!key) return false;
    // A modal dialog owns the keyboard: only bindings that ask for it run underneath.
    const inDialog = typeof document !== "undefined" && Boolean(document.querySelector("dialog[open]"));

    if (this.prefix) {
      const spec = this.find(this.prefix + " " + key, inDialog);
      this.clearPrefix();
      if (spec) return this.run(spec, event);
    }
    const spec = this.find(key, inDialog);
    if (spec) return this.run(spec, event);
    if (!inDialog && this.startsSequence(key)) {
      this.prefix = key;
      this.prefixTimer = setTimeout(() => this.clearPrefix(), SEQUENCE_MS);
      return true;
    }
    return false;
  }

  run(spec, event) {
    if (typeof event.preventDefault === "function") event.preventDefault();
    try {
      spec.run(event);
    } catch (err) {
      console.error("shortcut '" + spec.key + "' failed", err);
    }
    return true;
  }
}

export const shortcuts = new Shortcuts();
