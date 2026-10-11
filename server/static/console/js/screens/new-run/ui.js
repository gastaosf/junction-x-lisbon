// Small building blocks shared by the parts of the New run screen.

import { badge, el, icon, replace } from "../../dom.js";

const NOTICE_ICON = { info: "info", ok: "check", warn: "alert", bad: "alert" };

/** An inline message with an icon. kind: "info" | "ok" | "warn" | "bad". */
export function notice(kind, ...children) {
  return el("div", { class: "notice notice-" + kind, role: kind === "bad" ? "alert" : "status" },
    icon(NOTICE_ICON[kind] || "info"),
    el("div", "nr-notice-body", children));
}

/** A failed request, shown where it failed: the message, and a way to try again. */
export function errorNotice(text, { onRetry = null, retryLabel = "Try again", extra = null } = {}) {
  return notice("bad",
    el("div", "pre", String(text)),
    onRetry || extra
      ? el("div", "row wrap nr-notice-actions",
        onRetry ? el("button", { type: "button", class: "small", onclick: onRetry }, icon("refresh"), retryLabel) : null,
        extra)
      : null);
}

export function busyLine(text) {
  return el("div", { class: "row dim nr-busy", role: "status" }, el("span", "spinner"), text);
}

const STATUS = {
  done: ["ready", "ok", "check"],
  todo: ["to do", "dim", "dot"],
  attention: ["needs you", "warn", "alert"],
  blocked: ["blocked", "bad", "x"],
  busy: ["checking", "info", "clock"],
  locked: ["locked", "dim", "lock"],
};

/**
 * The frame of one step: a numbered head, a body, and one line that says why the step is closed.
 * A closed step hides its body, so nothing in it can be reached by mouse or keyboard.
 */
export function stepCard(title) {
  const number = el("span", { class: "nr-num num", "aria-hidden": "true" });
  const status = el("span", "nr-step-status");
  const tools = el("div", "row wrap nr-step-tools");
  const lockText = el("span");
  const lock = el("div", { class: "row dim nr-step-lock", hidden: true }, icon("lock"), lockText);
  const body = el("div", "nr-step-body");
  const heading = el("h2", "nr-step-title", title);
  const root = el("section", { class: "card flush nr-step", "aria-label": title },
    el("div", "card-head nr-step-head", number, heading, status, el("span", "grow"), tools),
    lock, body);
  return {
    el: root,
    body,
    tools,
    setTitle(text) {
      heading.textContent = text;
      root.setAttribute("aria-label", text);
    },
    setNumber(n) {
      number.textContent = String(n);
    },
    /** `status` is one of done, todo, attention, blocked, busy; a closed step always reads locked. */
    setState({ open = true, reason = null, status: name = null } = {}) {
      root.classList.toggle("locked", !open);
      body.hidden = !open;
      tools.hidden = !open;
      lock.hidden = open;
      lockText.textContent = reason || "";
      const [text, kind, iconName] = STATUS[open ? name : "locked"] || [];
      replace(status, text ? badge(text, kind, iconName) : null);
    },
  };
}

/**
 * Re-render `container` with `render()` and put the keyboard focus back on the control that had
 * it. Controls that should survive carry `data-fk`, a key that is stable across renders.
 */
export function keepFocus(container, render) {
  const active = document.activeElement;
  const key = active && container.contains(active) && active.dataset ? active.dataset.fk : null;
  render();
  if (!key) return;
  for (const node of container.querySelectorAll("[data-fk]")) {
    if (node.dataset.fk === key && !node.disabled) {
      node.focus({ preventScroll: true });
      return;
    }
  }
}

/** A list of plain-text lines. */
export function bullets(lines, className = "") {
  return el("ul", "nr-list " + className, lines.map((line) => el("li", null, String(line))));
}

let uid = 0;

/** An id that is unique in the page, for wiring a label or a radio group. */
export function nextId(prefix) {
  uid += 1;
  return prefix + "-" + uid;
}
