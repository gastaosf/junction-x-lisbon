// Step 3 of New run (UI-SPEC 5.3): the preflight table, the replacement for what the CLI prints
// before a launch. One row per panorama with what the files say and where each value came from.
//
// Rule compliance (UI-SPEC 3, contract A18): the only things the operator can set here are the
// three task values the organisers' files carry, each as a fixed choice: Urban / non-Urban, a
// date and time, one radio button. There is no text field and no way to rename a panorama. The
// server validates every choice again and writes its provenance to the log.

import { createPanoViewer } from "../../components/pano-viewer.js";
import { confirmDialog } from "../../components/shell.js";
import { badge, el, icon, replace } from "../../dom.js";
import { fmtBytes, fmtDuration, fmtUsd, plural } from "../../format.js";
import {
  LABELS, countRows, formatTimestamp, setImageUrl, sourceText, timestampFromInput, unlabelledRows, unreadImagesText,
} from "../../logic/launch.js";
import { bullets, busyLine, errorNotice, keepFocus, nextId, notice, stepCard } from "./ui.js";

const LABEL_KIND = { Urban: "urban", "non-Urban": "nonurban" };
const VIEW_WIDTHS = [1024, 2048, 4096];

export function createPreflight(c) {
  const step = stepCard("Check what was parsed");
  const content = el("div", "stack nr-preflight");
  step.body.append(content);
  const recheck = el("button", { type: "button", class: "small", onclick: () => c.recheck() }, icon("refresh"), "Check again");
  const working = el("span", { class: "row tight dim small", hidden: true }, el("span", "spinner"), "Checking…");
  step.tools.append(working, recheck);

  const radioName = nextId("nr-special");
  const stampDrafts = new Map(); // rel_path -> what is typed in its date-time field
  let viewer = null; // {dialog, instance}
  let destroyed = false;
  let rendered = null; // signature of what the table shows

  // ------------------------------------------------------------ full-screen look at one panorama

  function closeViewer() {
    if (!viewer) return;
    const open = viewer;
    viewer = null;
    try {
      open.instance.destroy();
    } catch (_) {
      // The viewer already tore itself down.
    }
    if (open.dialog.open) open.dialog.close();
    open.dialog.remove();
  }

  function openViewer(row) {
    closeViewer();
    const stage = el("div", "nr-viewer-stage");
    const dialog = el("dialog", { class: "nr-viewer", "aria-label": "Panorama " + row.panorama_id });
    dialog.append(
      el("div", "row nr-viewer-head",
        el("span", "mono strong", row.panorama_id),
        el("span", "mono small wrap-any nr-viewer-file", row.rel_path),
        row.label ? badge(row.label, LABEL_KIND[row.label] || "dim") : badge("no label", "warn", "alert"),
        row.special ? badge("Special One", "special", "star") : null,
        el("span", "grow"),
        el("span", "small nr-viewer-hint", "Drag to look around. This is the image the agent will get."),
        el("button", { type: "button", class: "icon-btn", title: "Close (Esc)", "aria-label": "Close", onclick: closeViewer }, icon("x"))),
      stage);
    dialog.addEventListener("close", closeViewer);
    document.body.append(dialog);
    dialog.showModal();
    const instance = createPanoViewer(stage, {
      sources: VIEW_WIDTHS.map((width) => ({ width, url: setImageUrl(c.form.setId, row.rel_path, width) })),
      mode: "360",
      label: "Panorama " + row.panorama_id,
    });
    viewer = { dialog, instance };
  }

  // ------------------------------------------------------------ cells

  function thumbCell(row) {
    const image = el("img", { class: "nr-thumb-img", alt: "", loading: "lazy", decoding: "async", width: 160, height: 80 });
    image.src = setImageUrl(c.form.setId, row.rel_path, 320);
    image.addEventListener("error", () => image.classList.add("broken"));
    return el("td", "nr-thumb",
      el("button", {
        type: "button", class: "nr-thumb-btn", title: "Open " + row.filename + " full screen",
        "aria-label": "Open panorama " + row.panorama_id + " full screen",
        dataset: { fk: "thumb:" + row.rel_path },
        onclick: () => openViewer(row),
      }, image, el("span", "nr-thumb-zoom", icon("expand"))));
  }

  function identityCell(row) {
    const size = row.width && row.height ? row.width + " x " + row.height : "size unknown";
    return el("td", "nr-identity",
      el("div", "mono strong wrap-any", row.panorama_id),
      el("div", "mono small dim wrap-any", row.rel_path),
      el("div", "small dim num", fmtBytes(row.size_bytes) + " · " + size),
      row.image_warning ? el("div", "small warn-text row tight top", icon("alert"), el("span", null, row.image_warning)) : null);
  }

  async function changeLabel(row) {
    const other = LABELS.find((label) => label !== row.label);
    const ok = await confirmDialog({
      title: "Override the label of " + row.panorama_id + "?",
      body: "The files say " + row.parsed.label + " (" + sourceText(row.sources.label) + "). "
        + "A wrong label changes the scoring function, the allocator and the fallback point without any error. "
        + "The override is written to the log as set by the operator.",
      okLabel: "Set it to " + other,
      cancelLabel: "Keep " + row.parsed.label,
    });
    if (ok && !destroyed) c.setLabel(row.rel_path, other);
  }

  function labelCell(row) {
    const parsed = row.parsed ? row.parsed.label : null;
    const source = row.sources ? row.sources.label : "none";
    const locked = Boolean(row.duplicate);
    if (!parsed) {
      // No label in the files: a required choice between the two words, nothing else.
      const bulk = source === "operator_bulk";
      return el("td", "nr-label",
        el("div", { class: "btn-group", role: "group", "aria-label": "Label of " + row.panorama_id },
          LABELS.map((label) => el("button", {
            type: "button", class: "small", disabled: locked,
            "aria-pressed": row.label === label && !bulk ? "true" : "false",
            dataset: { fk: "label:" + row.rel_path + ":" + label },
            onclick: () => c.setLabel(row.rel_path, row.label === label && !bulk ? null : label),
          }, label))),
        row.label
          ? el("div", "small dim", bulk ? ["Now ", el("span", "strong", row.label), ": ", sourceText(source), "."] : sourceText(source) + ".")
          : el("div", "small warn-text row tight", icon("alert"), "Required: not found in the files."));
    }
    const overridden = source === "operator";
    return el("td", "nr-label",
      el("div", "row tight wrap",
        badge(row.label, LABEL_KIND[row.label] || "dim"),
        overridden
          ? el("button", {
            type: "button", class: "small ghost", disabled: locked, dataset: { fk: "label:" + row.rel_path + ":undo" },
            onclick: () => c.setLabel(row.rel_path, null),
          }, "Undo")
          : el("button", {
            type: "button", class: "small ghost", disabled: locked, dataset: { fk: "label:" + row.rel_path + ":change" },
            title: "Override what the files say (asks first)",
            onclick: () => changeLabel(row),
          }, "Change")),
      el("div", "small " + (overridden ? "warn-text" : "dim"),
        overridden ? "Set here by the operator. The files say " + parsed + "." : sourceText(source) + "."));
  }

  function timestampCell(row) {
    const parsed = row.parsed ? row.parsed.timestamp : null;
    const source = row.sources ? row.sources.timestamp : "none";
    if (row.timestamp) {
      const mine = source === "operator" && !parsed;
      return el("td", "nr-stamp",
        el("div", "num nowrap", formatTimestamp(row.timestamp)),
        el("div", "small dim", sourceText(source) + "."),
        mine
          ? el("button", {
            type: "button", class: "small ghost", disabled: Boolean(row.duplicate), dataset: { fk: "stamp:" + row.rel_path + ":remove" },
            onclick: () => {
              stampDrafts.delete(row.rel_path);
              c.setTimestamp(row.rel_path, null);
            },
          }, "Remove")
          : null);
    }
    const input = el("input", {
      type: "datetime-local", step: "1", class: "nr-stamp-input", disabled: Boolean(row.duplicate),
      "aria-label": "Capture date and time of " + row.panorama_id,
      dataset: { fk: "stamp:" + row.rel_path + ":input" },
    });
    input.value = stampDrafts.get(row.rel_path) || "";
    const set = el("button", {
      type: "button", class: "small", disabled: true, dataset: { fk: "stamp:" + row.rel_path + ":set" },
      onclick: () => {
        const value = timestampFromInput(input.value);
        if (value) c.setTimestamp(row.rel_path, value);
      },
    }, "Set");
    const sync = () => {
      stampDrafts.set(row.rel_path, input.value);
      set.disabled = !timestampFromInput(input.value) || Boolean(row.duplicate);
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
    sync();
    return el("td", "nr-stamp",
      el("div", "small warn-text row tight top", icon("alert"), el("span", null, "None: sun_position will be unavailable.")),
      el("div", "row tight nr-stamp-set", input, set));
  }

  function specialCell(row, runHasSpecial) {
    const reason = row.duplicate
      ? "Already in the run."
      : runHasSpecial ? "This run already has its Special One." : null;
    const radio = el("input", {
      type: "radio", name: radioName, checked: Boolean(row.special), disabled: Boolean(reason),
      "aria-label": row.panorama_id + " is the Special One",
      dataset: { fk: "special:" + row.rel_path },
      onchange: () => c.setSpecial(row.rel_path),
    });
    return el("td", "nr-special" + (row.special ? " on" : ""),
      el("label", { class: "check", title: reason },
        radio,
        row.special ? badge("Special One", "special", "star") : el("span", "sr-only", "Special One")),
      row.special && row.sources && row.sources.special !== "none"
        ? el("div", "small dim", sourceText(row.sources.special) + ".")
        : null);
  }

  function budgetCell(row) {
    const b = row.budget || {};
    return el("td", "nr-budget small num",
      el("div", null, "effort ", el("span", "strong", String(b.effort ?? "–")), " · " + plural(b.max_turns ?? 0, "turn")),
      el("div", "dim", "soft " + fmtDuration(b.soft_deadline_s) + " · hard " + fmtDuration(b.hard_deadline_s)),
      el("div", "dim", "spend cap " + fmtUsd(b.max_spend_usd)));
  }

  function noteCell(row) {
    return el("td", "nr-notes small",
      row.duplicate ? el("div", "row tight top", badge("skipped", "dim", "minus"), el("span", "dim", "The same image is already in the run.")) : null,
      !row.duplicate && row.collides
        ? el("div", "warn-text", "A panorama with this name is already in the run: this one is added as " + row.panorama_id + ".")
        : null);
  }

  // ------------------------------------------------------------ the bulk label

  function bulkBox(rows) {
    const missing = unlabelledRows(rows);
    if (!missing.length && !c.form.bulkOn) return null;
    const group = nextId("nr-bulk");
    const tick = el("input", {
      type: "checkbox", checked: c.form.bulkOn, dataset: { fk: "bulk:on" },
      onchange: () => c.setBulk(tick.checked, c.form.bulkLabel),
    });
    return el("div", "nr-bulk sunk",
      el("label", "check", tick,
        el("span", null, "Give all " + plural(missing.length, "panorama") + " without a label the same label")),
      el("div", { class: "row wrap", role: "radiogroup", "aria-label": "Label for every unlabelled panorama" },
        LABELS.map((label) => el("label", "check",
          el("input", {
            type: "radio", name: group, checked: c.form.bulkOn && c.form.bulkLabel === label, disabled: !c.form.bulkOn,
            dataset: { fk: "bulk:" + label },
            onchange: () => c.setBulk(true, label),
          }),
          label))),
      el("div", "small warn-text",
        "Tick this only when you know it is true for every one of them. A wrong label silently changes the scoring "
        + "function, the allocator and the fallback point. Each label is logged as set by the operator for all unlabelled panoramas."));
  }

  // ------------------------------------------------------------ table

  function table(data) {
    const rows = data.rows || [];
    const blockedIds = new Set((data.blocking || []).flatMap((item) => item.panorama_ids || []));
    const runHasSpecial = Boolean(c.addRun && c.addRun.special_present);
    const anySpecial = rows.some((row) => row.special);
    const none = el("input", {
      type: "radio", name: radioName, checked: !anySpecial, disabled: runHasSpecial && !anySpecial,
      dataset: { fk: "special:none" },
      onchange: () => c.setSpecial(null),
    });
    return [
      el("div", "table-wrap nr-table-wrap",
        el("table", "table nr-table",
          el("thead", null, el("tr", null,
            el("th", null, "Image"),
            el("th", null, "Panorama"),
            el("th", null, "Label"),
            el("th", null, "Capture time"),
            el("th", null, "Special One"),
            el("th", null, "Budget"),
            el("th", null, ""))),
          el("tbody", null, rows.map((row) => el("tr", {
            class: [blockedIds.has(row.panorama_id) && "nr-row-blocked", row.duplicate && "nr-row-skipped", row.special && "nr-row-special"],
          },
          thumbCell(row), identityCell(row), labelCell(row), timestampCell(row),
          specialCell(row, runHasSpecial), budgetCell(row), noteCell(row)))))),
      el("div", "row wrap nr-special-none",
        el("label", "check", none, "No Special One"),
        el("span", "dim small",
          runHasSpecial
            ? "This run already has its Special One, so none can be added."
            : "The Special One counts three times and gets the larger budget. Exactly one is needed for a scoring run.")),
    ];
  }

  function signature() {
    return [
      c.preflightVersion, c.preflightLoading, c.preflightError, c.uploading, c.form.setId,
      c.form.bulkOn, c.form.bulkLabel, c.addRun ? c.addRun.special_present : null, c.unreadImages(),
    ].join("|");
  }

  function render() {
    const data = c.preflight;
    const nodes = [];
    if (c.preflightError) {
      nodes.push(errorNotice(c.preflightError, {
        onRetry: () => c.recheck(),
        retryLabel: "Check again",
        extra: el("button", { type: "button", class: "small", onclick: () => c.clearSet() }, "Choose other panoramas"),
      }));
    }
    if (!data) {
      if (!c.preflightError) {
        nodes.push(busyLine(c.uploading ? "Uploading. The table appears when the files are stored." : "Reading the panoramas…"));
      }
      replace(content, nodes);
      return;
    }
    const counts = countRows(data.rows);
    nodes.push(el("div", "row wrap nr-preflight-summary",
      el("span", "strong", data.summary || ""),
      counts.skipped ? el("span", "dim", "· " + counts.skipped + " already in the run, skipped") : null,
      el("span", "grow"),
      el("span", "dim num", "Cost ceiling " + fmtUsd(data.cost_ceiling_usd))));
    if ((data.blocking || []).length) {
      nodes.push(notice("bad",
        el("div", "strong", c.mode === "add" ? "This blocks adding them:" : "This blocks the launch:"),
        bullets(data.blocking.map((item) => item.text))));
    } else if ((data.rows || []).length) {
      nodes.push(notice("ok", (c.mode === "add" ? "Nothing blocks adding them." : "Nothing blocks the launch.")
        + " Check each row by eye: the label picks the scoring function."));
    }
    const unread = unreadImagesText(c.unreadImages());
    if (unread) nodes.push(notice("bad", el("div", "strong", "Some uploaded images are left out"), unread));
    if ((data.warnings || []).length) {
      nodes.push(notice("warn",
        el("div", "strong", plural(data.warnings.length, "warning") + " from reading the files:"),
        bullets(data.warnings, "nr-warnings")));
    }
    const bulk = bulkBox(data.rows);
    if (bulk) nodes.push(bulk);
    if ((data.rows || []).length) nodes.push(...table(data));
    else {
      nodes.push(el("div", "empty",
        el("div", "empty-title", "No panorama in this set"),
        "Add .jpg, .jpeg or .png files in step 2, or choose other panoramas."));
    }
    if ((data.ignored || []).length) {
      nodes.push(el("details", "nr-ignored",
        el("summary", null, plural(data.ignored.length, "file") + " ignored"),
        el("div", "small dim", "Hidden files, and files that are not an image, a manifest or a sidecar, are never run:"),
        bullets(data.ignored, "mono small")));
    }
    replace(content, nodes);
  }

  function update() {
    if (destroyed) return;
    const state = c.steps().preflight;
    const data = c.preflight;
    let status = "todo";
    if (c.preflightError) status = "blocked";
    else if (!data || c.preflightLoading) status = "busy";
    else if (!data.ready) status = "attention";
    else status = "done";
    step.setState({ open: state.open, reason: state.reason, status });
    working.hidden = !c.preflightLoading || !data;
    recheck.disabled = c.preflightLoading || !c.form.setId;
    content.classList.toggle("stale", Boolean(c.preflightLoading && data));
    if (!state.open) return;
    const now = signature();
    if (now === rendered) return;
    rendered = now;
    keepFocus(content, render);
  }

  return {
    el: step.el,
    step,
    update,
    /** A new set: nothing typed for the old one applies. */
    reset() {
      stampDrafts.clear();
      rendered = null;
    },
    destroy() {
      destroyed = true;
      closeViewer();
    },
  };
}
