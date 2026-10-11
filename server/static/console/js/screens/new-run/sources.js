// Step 2 of New run (UI-SPEC 5.3): where the panoramas come from. Three ways in, one result, a
// set id: upload (drag and drop, files, a folder, a .zip), a folder on the server's own disk
// through the directory browser, or a set stored earlier.
//
// Files are sent byte for byte under their own relative path, one request per file. Nothing typed
// or chosen here reaches the agent: the task values come out of the files in step 3.

import { api, errorText } from "../../api.js";
import { confirmDialog, toast } from "../../components/shell.js";
import { badge, el, icon, replace, syncList } from "../../dom.js";
import { fmtBytes, fmtDateTime, fmtInt, fmtPct, plural } from "../../format.js";
import { ACCEPTED_SUFFIXES, setNameFromPaths, uploadPlan, uploadTotals, uploadUrl } from "../../logic/launch.js";
import { link, paths } from "../../router.js";
import { carriesFiles, filesFromDrop, filesFromInput, MAX_DROPPED_FILES } from "./files.js";
import { bullets, busyLine, errorNotice, keepFocus, nextId, stepCard } from "./ui.js";

const PARALLEL_UPLOADS = 3;
const TABS = [
  { name: "upload", label: "Upload", icon: "upload" },
  { name: "browse", label: "Folder on this machine", icon: "folder" },
  { name: "stored", label: "Stored sets", icon: "layers" },
];

const ITEM_STATE = {
  queued: ["waiting", "dim", "clock"],
  uploading: ["uploading", "info", "upload"],
  done: ["stored", "ok", "check"],
  failed: ["failed", "bad", "x"],
  stopped: ["stopped", "warn", "stop"],
  ignored: ["ignored", "dim", "minus"],
  rejected: ["not accepted", "warn", "alert"],
};

export function createSources(c) {
  const step = stepCard("Panoramas");
  const selected = el("div", "nr-selected");
  const tablist = el("div", { class: "tabs", role: "tablist", "aria-label": "Where the panoramas come from" });
  const panel = el("div", { class: "nr-source-panel", role: "tabpanel" });
  step.body.append(selected, tablist, panel);

  const abort = new AbortController();
  let destroyed = false;
  let shownTab = null;
  let expanded = false; // the operator asked to see the sources although a set is chosen

  // ------------------------------------------------------------ upload

  const queue = []; // {id, original, path, file, size, action, state, loaded, error, code, note, setId}
  let nextItem = 0;
  let running = 0;
  let creating = null; // the POST /api/sets that makes this session's upload set
  let reading = false; // a dropped folder is being walked
  let frame = null;

  const dropzone = el("div", { class: "nr-drop", tabindex: "-1" });
  const fileInput = el("input", { type: "file", multiple: true, class: "sr-only", tabindex: "-1", "aria-hidden": "true" });
  fileInput.setAttribute("accept", ACCEPTED_SUFFIXES.join(","));
  const folderInput = el("input", { type: "file", multiple: true, class: "sr-only", tabindex: "-1", "aria-hidden": "true" });
  folderInput.setAttribute("webkitdirectory", "");
  const uploadTarget = el("div", "small dim nr-upload-target");
  const overall = el("div", { class: "nr-overall", hidden: true });
  const overallFill = el("div", "progress-fill");
  const overallText = el("span", "small num");
  const overallTools = el("span", "row tight");
  overall.append(
    el("div", { class: "progress", role: "progressbar", "aria-label": "Upload progress", "aria-valuemin": "0", "aria-valuemax": "100" }, overallFill),
    el("div", "row spread wrap", overallText, overallTools));
  const list = el("ul", { class: "nr-uploads", "aria-label": "Files" });

  dropzone.append(
    icon("upload", { size: 28 }),
    el("div", "nr-drop-title", "Drop panoramas here"),
    el("div", "dim small",
      "Images (.jpg, .jpeg, .png), a manifest (.csv, .tsv, .txt, .json), sidecar files, a folder or a .zip. ",
      "A folder keeps its Urban/ and non-Urban/ sub-folders, which is where the labels are read from."),
    el("div", "row wrap nr-drop-actions",
      el("button", { type: "button", class: "primary", onclick: () => fileInput.click() }, icon("file"), "Choose files"),
      el("button", { type: "button", onclick: () => folderInput.click() }, icon("folder"), "Choose a folder")),
    fileInput, folderInput);

  fileInput.addEventListener("change", () => {
    addFiles(filesFromInput(fileInput));
    fileInput.value = "";
  });
  folderInput.addEventListener("change", () => {
    addFiles(filesFromInput(folderInput));
    folderInput.value = "";
  });

  const uploadPane = el("div", "stack nr-upload-pane", dropzone, uploadTarget, overall, list);

  function uploadSetId() {
    const info = c.form.setInfo;
    return c.form.setId && info && info.kind === "upload" ? c.form.setId : null;
  }

  // One upload set per visit: files dropped later join it, until the operator starts another.
  function ensureTarget(name) {
    const current = uploadSetId();
    if (current) return Promise.resolve(current);
    if (!creating) {
      creating = api.post("/api/sets", name ? { name } : {}, { signal: abort.signal })
        .then((set) => {
          c.adoptSet(set);
          return set.set_id;
        })
        .finally(() => { creating = null; });
    }
    return creating;
  }

  function isUploading() {
    return reading || running > 0 || queue.some((item) => item.state === "queued");
  }

  async function addFiles(entries) {
    if (destroyed || !entries.length) return;
    const items = entries.map(({ file, path }) => {
      const plan = uploadPlan(path, file.size);
      nextItem += 1;
      return {
        id: nextItem, original: path, path: plan.path || path, file, size: file.size, action: plan.action,
        state: plan.action === "upload" ? "queued" : plan.action === "ignore" ? "ignored" : "rejected",
        loaded: 0, error: null, code: null, setId: null,
        note: plan.action === "upload" ? (plan.trimmed ? "Stored as " + plan.path + " (outer folders dropped)." : null) : plan.reason,
      };
    });
    queue.push(...items);
    if (entries.length >= MAX_DROPPED_FILES) {
      toast("Only the first " + MAX_DROPPED_FILES + " files were taken. Drop the folder that holds just this set.", "warn");
    }
    const sending = items.filter((item) => item.action === "upload");
    renderQueue();
    if (!sending.length) {
      toast("None of those files can be used. See the list for the reason next to each.", "warn");
      return;
    }
    c.setUploading(true);
    try {
      const setId = await ensureTarget(setNameFromPaths(entries.map((entry) => entry.path)));
      for (const item of sending) item.setId = setId;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      for (const item of sending) {
        item.state = "failed";
        item.error = "No set could be created for these files: " + errorText(err);
      }
      settle();
      return;
    }
    pump();
  }

  function pump() {
    while (!destroyed && running < PARALLEL_UPLOADS) {
      const item = queue.find((candidate) => candidate.state === "queued" && candidate.setId);
      if (!item) break;
      running += 1;
      item.state = "uploading";
      item.error = null;
      api.upload(uploadUrl(item.setId, item.path), item.file, {
        signal: abort.signal,
        onProgress: (loaded) => {
          item.loaded = loaded;
          scheduleRender();
        },
      }).then((result) => {
        const stored = (result && result.stored) || [];
        const ignored = (result && result.ignored) || [];
        item.state = "done";
        item.loaded = item.size;
        if (item.path.toLowerCase().endsWith(".zip")) {
          item.note = "Unpacked: " + plural(stored.length, "file") + " stored"
            + (ignored.length ? ", " + ignored.length + " ignored (" + ignored.slice(0, 5).join(", ") + (ignored.length > 5 ? ", …" : "") + ")" : "") + ".";
        } else if (!stored.length && ignored.length) {
          item.state = "ignored";
          item.note = "Ignored by the server.";
        } else if (ignored.length) {
          item.note = "Stored, but it cannot be opened as an image, so it will not be run.";
        } else if (!stored.length) {
          item.note = "Already in the set: the same bytes were stored before.";
        }
      }).catch((err) => {
        if (err && err.name === "AbortError") {
          item.state = "stopped";
          item.error = "Stopped before it was sent.";
          return;
        }
        item.state = "failed";
        item.error = errorText(err);
        item.code = err && err.code;
      }).finally(() => {
        running -= 1;
        if (destroyed) return;
        scheduleRender();
        pump();
        if (running === 0 && !queue.some((candidate) => candidate.state === "queued")) settle();
      });
    }
  }

  // The queue has drained: hand the set to the preflight if anything landed in it.
  function settle() {
    renderQueue();
    c.setUploading(false);
    const landed = queue.some((item) => item.state === "done" && !item.announced);
    for (const item of queue) if (item.state === "done") item.announced = true;
    const failed = queue.filter((item) => item.state === "failed" && !item.warned);
    for (const item of failed) item.warned = true;
    if (failed.length) {
      toast(plural(failed.length, "file") + " could not be uploaded. The reason is next to each; nothing was stored for them.", "error");
    }
    if (landed && uploadSetId()) c.filesStored(uploadSetId());
    loadSets();
  }

  function retryFailed() {
    const again = queue.filter((item) => item.state === "failed" || item.state === "stopped");
    if (!again.length) return;
    for (const item of again) {
      item.state = "queued";
      item.loaded = 0;
      item.error = null;
      item.warned = false;
    }
    c.setUploading(true);
    renderQueue();
    ensureTarget(null).then((setId) => {
      for (const item of again) item.setId = setId;
      pump();
    }).catch((err) => {
      if (err && err.name === "AbortError") return;
      for (const item of again) {
        item.state = "failed";
        item.error = "No set could be created for these files: " + errorText(err);
      }
      settle();
    });
  }

  function clearFinished() {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].state !== "queued" && queue[i].state !== "uploading") queue.splice(i, 1);
    }
    renderQueue();
  }

  function scheduleRender() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      renderQueue();
    });
  }

  function createRow() {
    const row = el("li", "nr-upload-row");
    row.append(
      el("div", "nr-upload-name",
        el("div", "mono wrap-any nr-upload-path"),
        el("div", "small nr-upload-note")),
      el("span", "num small dim nr-upload-size"),
      el("div", { class: "progress", "aria-hidden": "true" }, el("div", "progress-fill")),
      el("span", "nr-upload-state"));
    return row;
  }

  function updateRow(row, item) {
    row.querySelector(".nr-upload-path").textContent = item.path;
    const note = row.querySelector(".nr-upload-note");
    const text = item.error || item.note || "";
    note.textContent = text;
    note.hidden = !text;
    note.className = "small nr-upload-note pre " + (item.state === "failed" ? "bad-text" : item.state === "rejected" || item.state === "stopped" ? "warn-text" : "dim");
    row.querySelector(".nr-upload-size").textContent = fmtBytes(item.size);
    const fill = row.querySelector(".progress-fill");
    const share = item.state === "done" ? 1 : item.size > 0 ? Math.min(1, item.loaded / item.size) : 0;
    fill.style.width = (item.action === "upload" ? share * 100 : 0) + "%";
    fill.className = "progress-fill" + (item.state === "done" ? " ok" : item.state === "failed" ? " bad" : "");
    row.querySelector(".progress").style.visibility = item.action === "upload" ? "visible" : "hidden";
    const slot = row.querySelector(".nr-upload-state");
    if (slot.dataset.state !== item.state) {
      slot.dataset.state = item.state;
      const [label, kind, iconName] = ITEM_STATE[item.state] || ITEM_STATE.queued;
      replace(slot, badge(label, kind, iconName));
    }
  }

  function renderQueue() {
    if (destroyed) return;
    const totals = uploadTotals(queue);
    const busy = isUploading();
    overall.hidden = queue.length === 0;
    overallFill.style.width = (totals.share * 100).toFixed(1) + "%";
    overallFill.className = "progress-fill" + (!busy && totals.failed ? " warn" : !busy && totals.files ? " ok" : "");
    overallFill.parentNode.setAttribute("aria-valuenow", String(Math.round(totals.share * 100)));
    const parts = [];
    if (totals.files) {
      parts.push(totals.done + " of " + plural(totals.files, "file") + " stored");
      parts.push(fmtBytes(totals.sent) + " of " + fmtBytes(totals.bytes) + " (" + fmtPct(totals.share) + ")");
    }
    if (totals.failed) parts.push(totals.failed + " failed");
    if (totals.skipped) parts.push(totals.skipped + " not sent");
    overallText.textContent = (reading ? "Reading the folder… " : "") + parts.join(" · ");
    const canRetry = !busy && queue.some((item) => item.state === "failed" || item.state === "stopped");
    replace(overallTools,
      canRetry ? el("button", { type: "button", class: "small", onclick: retryFailed }, icon("refresh"), "Retry failed uploads") : null,
      !busy && queue.length ? el("button", { type: "button", class: "small ghost", onclick: clearFinished }, "Clear the list") : null);
    syncList(list, queue, (item) => item.id, createRow, updateRow);

    const target = uploadSetId();
    // Once files are on their way the list matters more than the invitation to drop them.
    dropzone.classList.toggle("compact", queue.length > 0 || Boolean(target));
    const frozen = queue.some((item) => item.code === "set_in_use");
    replace(uploadTarget,
      target
        ? ["Files are added to the set ", el("span", "strong", (c.form.setInfo && c.form.setInfo.name) || target), ". "]
        : "A new set is created for the files you add. Every upload is kept as a stored set and can be reused. ",
      target
        ? el("button", {
          type: "button", class: "small ghost", disabled: busy,
          title: busy ? "Wait for the upload to finish." : "The next files go into a new set; this one stays under Stored sets.",
          onclick: () => c.clearSet(),
        }, icon("plus"), "Start a new set")
        : null,
      frozen
        ? el("div", "warn-text", "A run was launched from that set, so it can no longer change. Start a new set, then retry the failed uploads.")
        : null);
  }

  async function onDrop(event) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dropzone.classList.remove("over");
    const state = c.steps().panoramas;
    if (c.isEval()) {
      toast("An evaluation run takes its panoramas from the evaluation set. Choose another preset to upload files.", "warn");
      return;
    }
    if (!state.open) {
      toast(state.reason + " Then drop the files again.", "warn");
      return;
    }
    expanded = true;
    selectTab("upload");
    reading = true;
    update();
    let entries = [];
    try {
      entries = await filesFromDrop(event.dataTransfer);
    } catch (err) {
      toast("The dropped folder could not be read: " + errorText(err) + " Use Choose a folder instead.", "error");
    }
    reading = false;
    if (destroyed) return;
    renderQueue();
    if (entries.length) addFiles(entries);
  }

  // A file dropped anywhere on the page is taken as an upload. Without this the browser would
  // open the image in place of the console and the form would be gone.
  const onDragOver = (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dropzone.classList.add("over");
  };
  const onDragLeave = (event) => {
    if (!event.relatedTarget) dropzone.classList.remove("over");
  };
  // Leaving the page mid-upload loses the files that were not sent yet.
  const onBeforeUnload = (event) => {
    if (!isUploading()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
  window.addEventListener("beforeunload", onBeforeUnload);

  // ------------------------------------------------------------ directory browser

  const fs = { data: null, loading: false, error: null, creating: false, token: 0 };
  const browsePane = el("div", "stack nr-fs");
  const pathId = nextId("nr-path");
  const pathInput = el("input", { type: "text", class: "mono grow", id: pathId, autocomplete: "off", placeholder: "/Volumes/USB/panoramas" });
  pathInput.setAttribute("spellcheck", "false");

  async function browse(path) {
    fs.token += 1;
    const token = fs.token;
    fs.loading = true;
    fs.error = null;
    renderBrowser();
    try {
      const data = await api.get("/api/fs" + (path ? "?path=" + encodeURIComponent(path) : ""), { signal: abort.signal });
      if (token !== fs.token) return;
      fs.data = data;
      pathInput.value = data.path || "";
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (token !== fs.token) return;
      fs.error = errorText(err);
    }
    fs.loading = false;
    renderBrowser();
  }

  async function usePath(path) {
    if (fs.creating) return;
    // A folder already referenced keeps its set: no second entry for the same directory.
    const known = (sets.list || []).find((set) => set.kind === "path" && set.path === path);
    if (known) {
      c.chooseSet(known.set_id, known);
      return;
    }
    fs.creating = true;
    fs.error = null;
    renderBrowser();
    try {
      const set = await api.post("/api/sets", { path }, { signal: abort.signal });
      fs.creating = false;
      c.chooseSet(set.set_id, set);
      loadSets();
    } catch (err) {
      fs.creating = false;
      if (err && err.name === "AbortError") return;
      fs.error = errorText(err);
    }
    renderBrowser();
  }

  function renderBrowser() {
    if (destroyed || shownTab !== "browse") return;
    const data = fs.data;
    const roots = (data && data.roots) || [];
    const entries = (data && data.entries) || [];
    const here = entries.filter((entry) => !entry.dir).length;
    const below = entries.filter((entry) => entry.dir).reduce((sum, entry) => sum + (entry.images || 0), 0);
    const atRoots = Boolean(data) && !data.path;

    const rows = entries.map((entry) => el("tr", null,
      el("td", null, entry.dir
        ? el("button", { type: "button", class: "ghost nr-fs-entry", onclick: () => browse(entry.path) },
          icon("folder"), el("span", "mono wrap-any", entry.name))
        : el("span", "row tight nr-fs-entry", icon("image"), el("span", "mono wrap-any", entry.name))),
      el("td", "r num", entry.dir ? fmtInt(entry.images || 0) : ""),
      el("td", "r", entry.dir && !entry.images
        ? null
        : el("button", {
          type: "button", class: "small", disabled: fs.creating,
          onclick: () => usePath(entry.path),
        }, entry.dir ? "Use this folder" : "Use only this image"))));

    replace(browsePane,
      el("p", "dim small",
        "The server reads the folder where it is: nothing is copied, so a USB stick must stay in until the run has ended. ",
        "Only the folders below can be opened. ",
        link(paths.settings("defaults"), "Change the allowed folders in Settings"), "."),
      el("form", {
        class: "row nr-fs-form",
        onsubmit: (event) => {
          event.preventDefault();
          if (pathInput.value.trim()) browse(pathInput.value.trim());
        },
      },
      el("label", { class: "field-label", for: pathId }, "Path on the server"),
      pathInput,
      el("button", { type: "submit" }, "Open")),
      roots.length
        ? el("div", "row wrap nr-fs-roots",
          el("span", "dim small", "Allowed folders:"),
          roots.map((root) => el("button", { type: "button", class: "small", title: "Open " + root, onclick: () => browse(root) },
            icon("folder"), el("span", "mono", root))))
        : null,
      fs.error ? errorNotice(fs.error, { onRetry: () => browse(data && data.path) }) : null,
      fs.loading && !data ? busyLine("Reading the folder…") : null,
      data
        ? el("div", "row wrap nr-fs-bar",
          el("button", {
            type: "button", class: "small", disabled: atRoots || fs.loading,
            title: atRoots ? "This is the list of allowed folders." : "Go up one folder",
            onclick: () => browse(data.parent),
          }, icon("chevron-up"), "Up"),
          el("span", "mono wrap-any grow", data.path || "Allowed folders"),
          fs.loading ? el("span", "spinner") : null,
          data.path
            ? el("button", {
              type: "button", class: "primary", disabled: fs.creating || here + below === 0,
              title: here + below === 0 ? "There is no image in this folder or in the folders directly inside it." : null,
              onclick: () => usePath(data.path),
            }, icon("check"), fs.creating ? "Reading…" : "Use this folder (" + plural(here + below, "image") + ")")
            : null)
        : null,
      data && entries.length
        ? el("div", "table-wrap nr-fs-table",
          el("table", "table compact",
            el("thead", null, el("tr", null, el("th", null, "Name"), el("th", "r", "Images"), el("th", "r", ""))),
            el("tbody", null, rows)))
        : null,
      data && !entries.length && !fs.loading
        ? el("div", "empty", el("div", "empty-title", "Nothing to show here"),
          "This folder has no sub-folder and no .jpg, .jpeg or .png image. Hidden files are not listed.")
        : null);
  }

  // ------------------------------------------------------------ stored sets

  const sets = { list: null, loading: false, error: null, token: 0, details: new Map(), deleting: null };
  const storedPane = el("div", "stack nr-stored");

  async function loadSets() {
    if (destroyed) return;
    sets.token += 1;
    const token = sets.token;
    sets.loading = true;
    renderStored();
    try {
      const data = await api.get("/api/sets", { signal: abort.signal });
      if (token !== sets.token) return;
      sets.list = (data && data.sets) || [];
      sets.error = null;
      // The selected set may have come from the URL: now its name is known.
      const mine = sets.list.find((set) => set.set_id === c.form.setId);
      if (mine) c.describeSet(mine);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (token !== sets.token) return;
      sets.error = errorText(err);
    }
    sets.loading = false;
    renderStored();
    renderSelected();
  }

  async function toggleDetails(set) {
    if (sets.details.has(set.set_id)) {
      sets.details.delete(set.set_id);
      renderStored();
      return;
    }
    sets.details.set(set.set_id, { loading: true });
    renderStored();
    try {
      const data = await api.get("/api/sets/" + encodeURIComponent(set.set_id), { signal: abort.signal });
      if (sets.details.has(set.set_id)) sets.details.set(set.set_id, { data });
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (sets.details.has(set.set_id)) sets.details.set(set.set_id, { error: errorText(err) });
    }
    renderStored();
  }

  async function deleteSet(set) {
    const upload = set.kind === "upload";
    const ok = await confirmDialog({
      title: upload ? "Delete this set?" : "Forget this folder?",
      body: upload
        ? "The " + plural(set.files || 0, "uploaded file") + " of \"" + set.name + "\" are removed from the server. This cannot be undone. A set that a run was launched from cannot be deleted."
        : "The console forgets \"" + set.name + "\". Nothing on the disk is deleted.",
      okLabel: upload ? "Delete the set" : "Forget the folder",
      tone: "danger",
    });
    if (!ok || destroyed) return;
    sets.deleting = set.set_id;
    renderStored();
    try {
      await api.del("/api/sets/" + encodeURIComponent(set.set_id));
      if (c.form.setId === set.set_id) c.clearSet();
      toast(upload ? "Set deleted." : "Folder forgotten.", "ok");
    } catch (err) {
      toast("The set was not deleted: " + errorText(err), "error");
    }
    sets.deleting = null;
    loadSets();
  }

  function detailRow(set) {
    const detail = sets.details.get(set.set_id);
    if (!detail) return null;
    let content;
    if (detail.loading) content = busyLine("Reading the set…");
    else if (detail.error) content = errorNotice(detail.error);
    else {
      const data = detail.data || {};
      content = el("div", "stack tight",
        el("div", null, el("span", "strong", data.summary || "no panoramas")),
        (data.blocking || []).length ? el("div", "warn-text small", "Needs a choice before launch:", bullets(data.blocking.map((item) => item.text))) : null,
        (data.warnings || []).length ? el("div", "dim small", plural(data.warnings.length, "warning") + ":", bullets(data.warnings.slice(0, 6))) : null,
        (data.ignored || []).length ? el("div", "dim small", plural(data.ignored.length, "ignored file") + ": " + data.ignored.slice(0, 8).join(", ")) : null);
    }
    return el("tr", "nr-set-detail", el("td", { colSpan: 6 }, content));
  }

  function renderStored() {
    if (destroyed || shownTab !== "stored") return;
    const rows = [];
    for (const set of sets.list || []) {
      const mine = set.set_id === c.form.setId;
      rows.push(el("tr", mine ? "selected" : null,
        el("td", null,
          el("div", "strong wrap-any", set.name || set.set_id),
          set.path ? el("div", "mono small dim wrap-any", set.path) : null),
        el("td", null, set.kind === "path" ? badge("folder on disk", "dim", "folder") : badge("upload", "dim", "upload")),
        el("td", "r num", fmtInt(set.panoramas || 0)),
        el("td", "r num", fmtInt(set.files || 0)),
        el("td", "num nowrap", fmtDateTime(set.created_at)),
        el("td", "r",
          el("div", "row tight nr-set-actions",
            mine
              ? badge("selected", "ok", "check")
              : el("button", { type: "button", class: "small primary", onclick: () => c.chooseSet(set.set_id, set) }, "Use"),
            el("button", {
              type: "button", class: "small", "aria-expanded": sets.details.has(set.set_id) ? "true" : "false",
              onclick: () => toggleDetails(set),
            }, "Details"),
            el("button", {
              type: "button", class: "icon-btn", disabled: sets.deleting === set.set_id,
              title: set.kind === "upload" ? "Delete this set" : "Forget this folder",
              "aria-label": (set.kind === "upload" ? "Delete set " : "Forget folder ") + (set.name || set.set_id),
              onclick: () => deleteSet(set),
            }, icon("trash"))))));
      const detail = detailRow(set);
      if (detail) rows.push(detail);
    }
    replace(storedPane,
      el("div", "row spread",
        el("span", "dim small", "Every upload and every folder used before. Choosing one changes nothing in it."),
        el("button", { type: "button", class: "small", disabled: sets.loading, onclick: loadSets }, icon("refresh"), "Refresh")),
      sets.error ? errorNotice(sets.error, { onRetry: loadSets }) : null,
      sets.loading && !sets.list ? busyLine("Loading the stored sets…") : null,
      sets.list && !sets.list.length
        ? el("div", "empty", el("div", "empty-title", "No stored set yet"),
          "Upload panoramas or choose a folder: it is kept here and can be run again.")
        : null,
      sets.list && sets.list.length
        ? el("div", "table-wrap",
          el("table", "table compact",
            el("thead", null, el("tr", null,
              el("th", null, "Set"), el("th", null, "Kind"), el("th", "r", "Panoramas"), el("th", "r", "Files"),
              el("th", null, "Created"), el("th", "r", ""))),
            el("tbody", null, rows)))
        : null);
  }

  // ------------------------------------------------------------ frame

  const buttons = new Map();
  for (const tab of TABS) {
    const button = el("button", { type: "button", class: "tab", role: "tab", onclick: () => selectTab(tab.name) }, icon(tab.icon), tab.label);
    buttons.set(tab.name, button);
    tablist.append(button);
  }

  function selectTab(name) {
    const known = TABS.some((tab) => tab.name === name) ? name : "upload";
    c.form.sourceTab = known;
    if (shownTab === known) return;
    shownTab = known;
    for (const [tab, button] of buttons) button.setAttribute("aria-selected", tab === known ? "true" : "false");
    if (known === "upload") {
      replace(panel, uploadPane);
      renderQueue();
    } else if (known === "browse") {
      replace(panel, browsePane);
      renderBrowser();
      if (!fs.data && !fs.loading) browse(null);
    } else {
      replace(panel, storedPane);
      renderStored();
      if (!sets.list && !sets.loading) loadSets();
    }
  }

  // With a set chosen the three ways in fold away, so the table of step 3 is what the operator
  // sees next. They stay open while something is uploading or a file needs a look.
  function panelOpen() {
    if (!c.form.setId || expanded || isUploading()) return true;
    return queue.some((item) => item.state === "failed" || item.state === "stopped" || item.state === "rejected");
  }

  // What this visit's uploads came to, for the folded line: "6 files stored, 1 hidden file ignored".
  function queueText() {
    const stored = queue.filter((item) => item.state === "done").length;
    const ignored = queue.filter((item) => item.state === "ignored").length;
    if (!stored && !ignored) return "";
    return [
      stored ? plural(stored, "file") + " stored" : null,
      ignored ? plural(ignored, "hidden file") + " ignored" : null,
    ].filter(Boolean).join(", ");
  }

  function renderSelected() {
    if (destroyed) return;
    const info = c.form.setInfo;
    if (!c.form.setId) {
      replace(selected, null);
      return;
    }
    const what = info
      ? (info.kind === "path" ? "folder " : "upload set ") + (info.name || c.form.setId)
      : "set " + c.form.setId;
    const upload = !info || info.kind === "upload";
    keepFocus(selected, () => replace(selected, el("div", "row wrap nr-selected-line",
      badge("selected", "ok", "check"),
      el("span", "strong wrap-any", what),
      info && info.path ? el("span", "mono small dim wrap-any", info.path) : null,
      !panelOpen() && queueText() ? el("span", "small dim num", queueText()) : null,
      el("span", "grow"),
      panelOpen()
        ? (expanded && !isUploading()
          ? el("button", { type: "button", class: "small ghost", dataset: { fk: "set:fold" }, onclick: () => { expanded = false; update(); } }, icon("chevron-up"), "Hide")
          : null)
        : el("button", {
          type: "button", class: "small ghost", dataset: { fk: "set:fold" },
          title: upload ? "Drop or choose more files for this set, or look at the stored sets." : "Look at the folder browser and the stored sets.",
          onclick: () => { expanded = true; update(); },
        }, icon("chevron-down"), upload ? (queue.length ? "Show uploads, add files" : "Add files") : "Show sources"),
      el("button", {
        type: "button", class: "small", disabled: isUploading(),
        title: isUploading() ? "Wait for the upload to finish." : "Take other panoramas; this set stays stored.",
        dataset: { fk: "set:other" },
        onclick: () => c.clearSet(),
      }, "Choose other panoramas"))));
  }

  function update() {
    if (destroyed) return;
    const state = c.steps().panoramas;
    step.setState({
      open: state.open,
      reason: state.reason,
      status: isUploading() ? "busy" : !c.form.setId ? "todo" : c.preflightError && !c.preflight ? "attention" : "done",
    });
    if (!c.form.setId) expanded = false;
    renderSelected();
    if (!state.open) return;
    const open = panelOpen();
    tablist.hidden = !open;
    panel.hidden = !open;
    if (!shownTab) selectTab(c.form.sourceTab || "upload");
    else if (shownTab === "upload") renderQueue();
    else if (shownTab === "stored") renderStored();
  }

  return {
    el: step.el,
    step,
    update,
    isUploading,
    reloadSets: loadSets,
    // After a server restart the browser's listing and the stored sets may both have changed.
    refresh() {
      if (shownTab === "browse") browse(fs.data && fs.data.path);
      loadSets();
    },
    destroy() {
      if (destroyed) return;
      const stopped = isUploading();
      destroyed = true;
      abort.abort();
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (stopped) {
        toast("The upload was stopped because you left the page. The files already sent are kept under Stored sets on the New run screen.", "warn");
      }
    },
  };
}
