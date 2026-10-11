// Stage view (UI-SPEC 5.7): one panorama, full screen, for a projector and an audience.
//
// No shell and no penalised control: nothing on this screen reaches the agent. The only input is
// "Reveal truth", which is offered after the answer is final on a run whose human channels are
// off, and is stored as a note on the run (contract A11, A19).
//
// Everything shown comes from the store: the ticker is the server's `tile.activity` and
// `tile.last_reasoning` (A7), the clock ticks locally from `store.elapsed`.

import { api, errorText, panoUrl, runUrl } from "../api.js";
import { createMap } from "../components/map.js";
import { createPanoViewer } from "../components/pano-viewer.js";
import { toast } from "../components/shell.js";
import { badge, copyButton, el, icon, replace, statusBadge, syncList } from "../dom.js";
import { fmtAgo, fmtClock, fmtDist, fmtInt, fmtLatLng, fmtMult, fmtPct, fmtUsd } from "../format.js";
import { shortcuts } from "../keyboard.js";
import {
  clockState,
  cropView,
  endCard,
  freshCrops,
  guessKey,
  lastCropNumber,
  panoramaChoices,
  parseTruth,
  pickPanorama,
  presenterProblems,
  shownTruth,
  stagePhase,
  stepPanorama,
  tickerState,
  topGuess,
  truthAvailability,
  truthFrame,
  truthSettled,
  viewerSources,
  worldZoom,
  zoomForRadius,
} from "../logic/stage.js";
import { prefs } from "../prefs.js";
import { link, navigate, paths, setQuery } from "../router.js";
import { store } from "../store.js";

const TICK_MS = 250;
const STREET_ZOOM = 17; // "the map zooming to street level" once the answer is final
const CROP_TURN_MS = 900;
const CROP_HOLD_MS = 5000; // how long the camera stays on a crop before it widens again
const CONNECT_GRACE_MS = 4000; // a page that has only just opened is connecting, not disconnected
const PUT_TIMEOUT_MS = 15000;
const MAP_SHARE = 0.42; // the map's share of the width, and the panes' rough share of the height
const PANES_SHARE = 0.68;

// One icon per tool beside the server's sentence; decoration only, the words carry the meaning.
const TOOL_ICONS = {
  view_crop: "search",
  search_places: "search",
  overpass_query: "map",
  streetview_lookup: "image",
  satellite_tile: "layers",
  sun_position: "sun",
  update_candidates: "target",
  ask_multiple_choice: "question",
  submit_locations: "flag",
  web_search: "search",
};

function setText(node, text) {
  const value = String(text ?? "");
  if (node.textContent !== value) node.textContent = value;
}

// Rebuild a part of the page only when what it shows has changed, so hover, focus and a running
// animation survive the four renders a second.
function keyed(node, key, build) {
  if (node.dataset.sig === key) return;
  node.dataset.sig = key;
  replace(node, build());
}

function metric(caption, extraClass) {
  const cap = el("span", "stage-cap", caption);
  const figure = el("span", "stage-figure num");
  const note = el("span", "stage-note");
  const node = el("div", "stage-metric" + (extraClass ? " " + extraClass : ""), cap, figure, note);
  return { node, cap, figure, note };
}

export function mount(container, params, ctx) {
  const runId = params.runId;
  const mountedAt = Date.now();
  const abort = new AbortController();
  const cleanup = []; // everything unmount has to undo
  let dead = false;
  let lastGood = null; // the last RunState that carried its panoramas
  let loadError = null;
  let loading = true;
  let pid = null;
  let wanted = ctx.query.get("pano");
  let view = null; // the viewer and map of the panorama on stage
  let presenterOpen = false;
  let truthDialog = null;
  let weWentFullscreen = false;
  const sentTruth = new Map(); // pid -> what this tab just revealed, until the stream confirms it

  // ---------------------------------------------------------------- skeleton

  const name = el("span", "stage-name");
  const badges = el("span", "stage-badges");
  const clock = metric("Time left", "stage-clock");
  const turns = metric("Turn", "stage-turns");
  const guessCap = el("span", "stage-cap", "Top guess");
  const guessLabel = el("span", "stage-guess-label");
  const guessShare = el("span", "stage-guess-share num");
  const guessCoords = el("span", "stage-guess-coords mono");
  const guess = el("div", "stage-metric stage-guess", guessCap, el("div", "stage-guess-line", guessShare, guessLabel), guessCoords);
  const header = el("header", "stage-top",
    el("div", "stage-ident", el("span", "stage-cap", "Panorama"), name, badges),
    clock.node, turns.node, guess);

  const barFill = el("div", "stage-bar-fill");
  const barSoft = el("div", { class: "stage-bar-soft", title: "Soft deadline" });
  const bar = el("div", { class: "stage-bar", role: "presentation" }, barFill, barSoft);

  const viewerHost = el("section", { class: "stage-viewer", "aria-label": "The panorama the agent is looking at" });
  const mapHost = el("section", { class: "stage-map", "aria-label": "Map of the agent's hypotheses" });
  const lost = el("div", { class: "stage-lost", role: "status", hidden: true });
  const panes = el("main", "stage-panes", viewerHost, mapHost, lost);

  const foot = el("footer", "stage-foot");
  const presenter = el("aside", { class: "stage-presenter panel", "aria-label": "Presenter overlay", hidden: true });
  const wait = el("div", "stage-wait");

  // The presenter's own controls sit in a slim strip under everything the audience reads.
  const picker = el("select", { class: "stage-picker", "aria-label": "Panorama on stage", onchange: () => choose(picker.value) });
  const prevButton = el("button", { type: "button", class: "icon-btn small", title: "Previous panorama (Left arrow)", "aria-label": "Previous panorama", onclick: () => step(-1) }, icon("chevron-left"));
  const nextButton = el("button", { type: "button", class: "icon-btn small", title: "Next panorama (Right arrow)", "aria-label": "Next panorama", onclick: () => step(1) }, icon("chevron-right"));
  const pickerGroup = el("div", { class: "stage-pick row tight", hidden: true }, prevButton, picker, nextButton);
  const layerButton = el("button", { type: "button", class: "ghost small", title: "Street map or satellite imagery (S)", onclick: toggleLayer }, icon("layers"), "Satellite");
  const themeButton = el("button", { type: "button", class: "ghost small", title: "Light or dark stage (T)", onclick: toggleTheme });
  const revealButton = el("button", { type: "button", class: "ghost small stage-reveal-tool", onclick: openTruthDialog }, icon("star"), "Reveal truth");
  const presenterButton = el("button", { type: "button", class: "ghost small", title: "Status, spend and errors (P)", onclick: togglePresenter }, icon("info"), "Presenter");
  const fullButton = el("button", { type: "button", class: "ghost small", title: "Full screen (F)", onclick: toggleFullscreen });
  const runNote = el("span", "stage-run row tight");
  const strip = el("div", "stage-strip",
    runNote,
    el("span", "stage-keys dim", el("kbd", null, "P"), " presenter ", el("kbd", null, "F"), " full screen ", el("kbd", null, "Esc"), " dashboard"),
    el("span", "grow"),
    el("div", { class: "stage-tools row tight", role: "group", "aria-label": "Stage controls" },
      pickerGroup, revealButton, layerButton, themeButton, presenterButton, fullButton,
      link(paths.run(runId), { class: "btn ghost small", title: "Back to the run dashboard (Esc)" }, icon("arrow-left"), "Dashboard")));

  const root = el("div", "stage", header, bar, panes, foot, strip, presenter, wait);
  container.replaceChildren(root);

  // ---------------------------------------------------------------- state

  function currentRun() {
    const held = store.run(runId);
    if (held && (held.panoramas || []).length) {
      lastGood = held;
      return held;
    }
    // A `run` message for a run the server does not hold in memory arrives without tiles: keep
    // the tiles we loaded and take the newer run fields (stage_truth) from the message.
    if (held && lastGood) return { ...lastGood, ...held, panoramas: lastGood.panoramas };
    return held || lastGood;
  }

  const tilesOf = (run) => (run && run.panoramas) || [];
  const currentTile = (run) => tilesOf(run).find((tile) => tile.panorama_id === pid) || null;

  function load({ force = false } = {}) {
    loading = !currentRun();
    store.loadRun(runId, { force }).then((run) => {
      // After a `run` message for a run this server does not hold in memory, the store keeps that
      // run without its panoramas and answers loadRun from it: ask the server for the whole run.
      if (run && !(run.panoramas || []).length) return api.get(runUrl(runId), { signal: abort.signal });
      return run;
    }).then((run) => {
      if (dead) return;
      loading = false;
      loadError = null;
      if (run && (run.panoramas || []).length) lastGood = run;
      render();
    }).catch((err) => {
      if (dead) return;
      loading = false;
      // A refresh that fails must not take down a screen that is already showing the run.
      loadError = currentRun() ? null : err;
      render();
    });
  }

  // ---------------------------------------------------------------- choosing the panorama

  function choose(nextPid) {
    if (!nextPid || nextPid === pid) return;
    wanted = nextPid;
    setQuery({ pano: nextPid });
    render();
  }

  function step(delta) {
    choose(stepPanorama(tilesOf(currentRun()), pid, delta));
  }

  function resolvePanorama(run) {
    const tiles = tilesOf(run);
    const held = pid ? tiles.find((tile) => tile.panorama_id === pid) : null;
    // The choice is kept once made: the default ("the first running one") must not carry the
    // stage away to another panorama when this one finishes.
    if (held && (!wanted || wanted === pid)) return held;
    const picked = pickPanorama(tiles, wanted);
    if (!picked) return null;
    if (wanted && picked.panorama_id !== wanted) {
      toast("Panorama " + wanted + " is not in this run. Showing " + picked.panorama_id + " instead.", "warn");
    }
    wanted = picked.panorama_id;
    if (picked.panorama_id !== pid) {
      pid = picked.panorama_id;
      openView(picked);
      ctx.setTitle("Stage · " + pid);
      closeTruthDialog();
    }
    // A reload or a pasted link lands on the same panorama (contract A1).
    setQuery({ pano: pid });
    return picked;
  }

  // ---------------------------------------------------------------- viewer and map

  function closeView() {
    if (!view) return;
    clearTimeout(view.relax);
    view.offTouch.abort();
    view.viewer.destroy();
    view.map.destroy();
    view = null;
  }

  function openView(tile) {
    closeView();
    const viewer = createPanoViewer(viewerHost, {
      sources: viewerSources(tile, (width) => panoUrl(runId, tile.panorama_id, "/image?w=" + width)),
      controls: false,
      autoPan: true,
      label: "Panorama " + tile.panorama_id + ". Drag to look around.",
    });
    const map = createMap(mapHost, { wheel: true, controls: false, layer: prefs.get("stageLayer", "street") });
    // Until there is a point to show, the whole world, filling the pane. The pane may still be
    // hidden behind the loading message here, so its size is taken from the window (see stage.css).
    if (!topGuess(tile.hypotheses) && !(tile.final || tile.provisional || []).length) {
      map.flyTo(25, 10, worldZoom(window.innerWidth * MAP_SHARE, window.innerHeight * PANES_SHARE));
    }
    const offTouch = new AbortController();
    view = {
      pid: tile.panorama_id, viewer, map, offTouch,
      // Crops that exist when the stage opens are history: only new ones flash.
      seenCrop: lastCropNumber(tile.crops),
      touched: false, relax: null, first: true, sig: null,
      guess: null, truth: null, finalKey: null,
    };
    // "Auto-panning slowly until touched": after that the camera belongs to the presenter.
    const taken = () => { if (view && view.viewer === viewer) view.touched = true; };
    for (const type of ["pointerdown", "wheel", "keydown"]) {
      viewer.el.addEventListener(type, taken, { capture: true, passive: true, signal: offTouch.signal });
    }
  }

  function syncViewer(tile) {
    const crops = tile.crops || [];
    view.viewer.setCrops(crops);
    const last = lastCropNumber(crops);
    // A retry starts the crop numbers again.
    if (last < view.seenCrop) view.seenCrop = last;
    const fresh = freshCrops(crops, view.seenCrop);
    if (!fresh.length) return;
    view.seenCrop = last;
    for (const crop of fresh) view.viewer.flashCrop(crop.n);
    if (view.touched) return;
    // Turn to where the agent is looking so the footprint flashes on screen, then widen again.
    const viewer = view.viewer;
    viewer.lookAt(cropView(fresh[fresh.length - 1]), { animate: true, duration: CROP_TURN_MS });
    clearTimeout(view.relax);
    view.relax = setTimeout(() => {
      if (view && view.viewer === viewer && !view.touched) viewer.lookAt({ pitch: 0, fov: 100 }, { animate: true, duration: 1500 });
    }, CROP_HOLD_MS);
  }

  function syncMap(tile, truth) {
    const map = view.map;
    const final = Boolean(tile.final);
    const entries = tile.final || tile.provisional || [];
    const truthKey = truth ? fmtLatLng(truth.lat, truth.lng) : null;
    // Once the truth is drawn the picture is the answer against it; the other hypotheses would
    // only pull the frame away.
    map.setHypotheses(truthKey ? [] : tile.hypotheses || []);
    map.setEntries(entries);
    // Once final the answer is the first entry of the list, whoever set it (a geocode replaces the
    // allocator's choice); before that, the point the allocator would repeat.
    map.setAnswer((final ? entries[0] : tile.chosen || entries[0]) || null, { final });
    if (truthKey !== view.truth) map.setTruth(truth ? { lat: truth.lat, lng: truth.lng } : null, { lines: tile.final || [] });

    const top = topGuess(tile.hypotheses);
    const key = guessKey(top);
    // The final point can still move once: a last-resort geocode replaces the list after final.
    const finalKey = final && entries.length ? fmtLatLng(entries[0].lat, entries[0].lng) : null;
    if (truthKey) {
      if (truthKey !== view.truth || finalKey !== view.finalKey) {
        const frame = truthFrame([...entries, truth], mapHost.clientWidth, mapHost.clientHeight);
        if (frame) map.flyTo(frame.lat, frame.lng, frame.zoom);
        else map.fit({ force: true, animate: !view.first });
      }
    } else if (finalKey) {
      if (finalKey !== view.finalKey || view.truth) map.flyTo(entries[0].lat, entries[0].lng, STREET_ZOOM);
    } else if (key && key !== view.guess) {
      map.flyTo(top.lat, top.lng, zoomForRadius(top.radius_m));
    }
    view.guess = key;
    view.truth = truthKey;
    view.finalKey = finalKey;
  }

  function syncView(tile, truth) {
    const sig = [tile.last_seq, (tile.crops || []).length, (tile.hypotheses || []).length, tile.final ? 1 : 0,
      truth ? fmtLatLng(truth.lat, truth.lng) : ""].join("|");
    if (sig === view.sig) return;
    view.sig = sig;
    syncViewer(tile);
    syncMap(tile, truth);
    view.first = false;
  }

  // ---------------------------------------------------------------- header

  function renderHeader(run, tile) {
    setText(name, tile.panorama_id);
    // A question waiting for the operator is not this screen's business: the audience sees
    // "running", and the note in the ticker says the console has a question open.
    const status = tile.status === "awaiting_mcq" ? "running" : tile.status;
    keyed(badges, [tile.special, tile.label, status].join("|"), () => [
      tile.special ? badge("Special One", "special", "star") : null,
      tile.label ? badge(tile.label, tile.label === "Urban" ? "urban" : "nonurban") : null,
      statusBadge(status),
    ]);

    setText(turns.figure, fmtInt(tile.turns || 0));
    const maxTurns = tile.budget && tile.budget.max_turns;
    setText(turns.note, maxTurns ? "of " + fmtInt(maxTurns) : "");

    const top = topGuess(tile.hypotheses);
    guess.classList.toggle("is-empty", !top);
    if (top) {
      setText(guessShare, fmtPct(top.probability));
      setText(guessLabel, top.label || "Unnamed place");
      setText(guessCoords, fmtLatLng(top.lat, top.lng));
    } else {
      setText(guessShare, "");
      setText(guessLabel, stagePhase(tile) === "final" ? "No hypothesis was recorded" : "No hypothesis yet");
      setText(guessCoords, "");
    }
  }

  function renderClock(tile) {
    const state = clockState(tile, store.elapsed(tile));
    setText(clock.cap, state.label);
    setText(clock.figure, state.seconds === null ? "--:--" : fmtClock(state.phase === "running" && state.hard_s !== null ? Math.ceil(state.seconds) : state.seconds));
    setText(clock.note, state.note);
    clock.node.dataset.tone = state.tone;
    bar.dataset.tone = state.tone;
    bar.hidden = state.share === null;
    barFill.style.width = ((state.share ?? 0) * 100).toFixed(2) + "%";
    barSoft.hidden = state.soft_share === null || state.soft_share >= 1;
    if (state.soft_share !== null) barSoft.style.left = (state.soft_share * 100).toFixed(2) + "%";
  }

  // ---------------------------------------------------------------- bottom: ticker or end card

  function tickerNodes() {
    const mark = el("span", "stage-activity-icon");
    const headline = el("span", "stage-activity-text");
    const asking = el("div", { class: "stage-asking", hidden: true }, icon("question"),
      el("span", null, "The operator console has a question open for this panorama."));
    const caption = el("span", "stage-cap");
    const body = el("p", "stage-reasoning-text");
    const node = el("div", "stage-ticker",
      el("div", { class: "stage-activity", role: "status", "aria-live": "polite" }, mark, headline),
      asking,
      el("div", "stage-reasoning", caption, body));
    return { node, mark, headline, asking, caption, body };
  }

  let ticker = null;

  function renderTicker(tile) {
    if (!ticker || foot.firstChild !== ticker.node) {
      ticker = tickerNodes();
      foot.dataset.sig = "";
      replace(foot, ticker.node);
    }
    const state = tickerState(tile);
    const changed = ticker.headline.textContent !== state.headline;
    setText(ticker.headline, state.headline);
    keyed(ticker.mark, state.tool || "none", () => icon(TOOL_ICONS[state.tool] || "dot"));
    if (changed) {
      // Restart the entrance animation so a new activity is noticed from the back of the room.
      ticker.headline.classList.remove("is-new");
      void ticker.headline.offsetWidth;
      ticker.headline.classList.add("is-new");
    }
    ticker.asking.hidden = !state.asking;
    ticker.node.classList.toggle("is-asking", state.asking);
    setText(ticker.caption, state.caption);
    setText(ticker.body, state.body || (state.caption === "Latest reasoning" ? "Nothing yet." : ""));
    ticker.body.classList.toggle("dim", !state.body);
  }

  function truthBlock(run, tile, truth) {
    if (truth) {
      return el("section", "stage-end-truth is-revealed",
        el("div", "stage-end-pair",
          el("div", "stage-metric", el("span", "stage-cap", "Distance to truth"), el("span", "stage-figure num", fmtDist(truth.distance_m))),
          el("div", "stage-metric", el("span", "stage-cap", "Score"),
            el("span", "stage-figure num", fmtInt(truth.score)),
            el("span", "stage-note num", "of " + fmtInt(truth.max_score) + " · " + fmtPct(truth.share)))),
        el("div", "stage-end-truth-foot row wrap",
          el("span", "mono", icon("star"), " True location " + fmtLatLng(truth.lat, truth.lng)),
          el("button", { type: "button", class: "ghost small", title: "Change the coordinates of the true location (R)", onclick: openTruthDialog }, "Change")));
    }
    const state = truthAvailability(run, tile);
    if (state.available) {
      return el("section", "stage-end-truth",
        el("span", "stage-cap", "True location"),
        el("button", { type: "button", class: "primary stage-reveal", onclick: openTruthDialog }, icon("star"), "Reveal truth"),
        el("p", "stage-note", "Enter the coordinates the organisers announce to draw the distance and the score."));
    }
    return el("section", "stage-end-truth",
      el("span", "stage-cap", "True location"),
      el("p", "stage-note stage-unavailable", icon("lock"), el("span", null, state.reason)));
  }

  function renderEnd(run, tile, card, truth) {
    ticker = null;
    const truthSig = truth ? [truth.lat, truth.lng, truth.distance_m, truth.score, truth.max_score, truth.share].join(",") : truthAvailability(run, tile).reason;
    const sig = ["end", tile.panorama_id, card.lines.join(";"), card.origin_text, card.stop_text, card.multiplier, truthSig, tile.last_reasoning ? tile.last_reasoning.seq : ""].join("|");
    keyed(foot, sig, () => {
      const reasoning = tile.last_reasoning && tile.last_reasoning.text ? tile.last_reasoning.text.trim() : "";
      return el("div", "stage-end",
        el("section", "stage-end-answer",
          el("div", "row tight wrap",
            el("span", "stage-cap", "Final answer"),
            card.fallback ? badge("fallback", "warn", "alert") : badge(tile.origin === "human_geocode" ? "operator geocode" : "agent", "ok", "check")),
          el("div", "stage-end-point",
            el("span", "mono", card.point_text),
            copyButton(card.point_text, { title: "Copy the coordinates" })),
          el("ul", { class: "stage-end-list mono" + (card.lines.length > 3 ? " is-long" : ""), "aria-label": "The submitted list" }, card.lines.map((line) => el("li", null, line))),
          el("p", "stage-note",
            card.origin_text + (card.stop_text ? ": " + card.stop_text : "") + "." +
            (card.multiplier < 1 ? " Multiplier " + fmtMult(card.multiplier) + "." : ""))),
        el("section", "stage-end-why",
          el("span", "stage-cap", "Latest reasoning"),
          el("p", "stage-reasoning-text" + (reasoning ? "" : " dim"), reasoning || "No reasoning summary was recorded.")),
        truthBlock(run, tile, truth));
    });
  }

  // ---------------------------------------------------------------- reveal truth

  function closeTruthDialog() {
    if (!truthDialog) return;
    const dialog = truthDialog;
    truthDialog = null;
    if (dialog.open) dialog.close();
    dialog.remove();
  }

  function openTruthDialog() {
    const run = currentRun();
    const tile = currentTile(run);
    const state = truthAvailability(run, tile);
    if (!state.available) {
      toast(state.reason, "info");
      return;
    }
    closeTruthDialog();
    const targetPid = tile.panorama_id;
    const known = shownTruth(run, tile, sentTruth.get(targetPid));
    const input = el("input", {
      type: "text", class: "stage-truth-input mono", name: "coordinates", autocomplete: "off",
      inputmode: "text", maxlength: 120, placeholder: "38.7169, -9.1399", value: known ? fmtLatLng(known.lat, known.lng) : "",
    });
    input.spellcheck = false; // el() skips a false value, and coordinates are not prose
    const reading = el("div", { class: "stage-truth-reading", "aria-live": "polite" });
    const failure = el("div", { class: "field-error pre", role: "alert", hidden: true });
    const ok = el("button", { type: "submit", class: "primary", disabled: true }, "Reveal");
    const cancel = el("button", { type: "button", onclick: closeTruthDialog }, "Cancel");
    let busy = false;

    const read = () => {
      const parsed = parseTruth(input.value);
      if (parsed.ok) replace(reading, icon("check"), el("span", null, "Reads as ", el("strong", "mono", parsed.text), "  (latitude, longitude)"));
      else replace(reading, input.value.trim() ? icon("alert") : icon("info"), el("span", null, parsed.problem));
      reading.classList.toggle("is-ok", parsed.ok);
      ok.disabled = busy || !parsed.ok;
      return parsed;
    };

    const send = async (event) => {
      event.preventDefault();
      const parsed = read();
      if (busy || !parsed.ok) return;
      busy = true;
      ok.disabled = true;
      input.readOnly = true;
      failure.hidden = true;
      replace(ok, el("span", "spinner"), "Revealing");
      try {
        const out = await api.put(runUrl(runId, "/stage_truth"),
          { panorama_id: targetPid, lat: parsed.lat, lng: parsed.lng },
          { signal: abort.signal, timeoutMs: PUT_TIMEOUT_MS });
        if (dead) return;
        sentTruth.set(targetPid, {
          lat: parsed.lat, lng: parsed.lng, distance_m: out.distance_m, theta: out.theta,
          score: out.score, max_score: out.max_score, share: out.share,
        });
        closeTruthDialog();
        render();
        // A run read from disk is not on the stream: fetch the stored note so a reload agrees.
        const held = currentRun();
        if (held && !held.owned) load({ force: true });
      } catch (err) {
        if (dead || (err && err.name === "AbortError")) return;
        busy = false;
        input.readOnly = false;
        replace(ok, "Reveal");
        // The text stays in the box: correct it or try again.
        setText(failure, errorText(err));
        failure.hidden = false;
        read();
        input.focus();
      }
    };

    const titleId = "stage-truth-title";
    const dialog = el("dialog", { class: "dialog stage-truth", "aria-labelledby": titleId },
      el("form", { class: "stack", onsubmit: send, novalidate: true },
        el("h2", { class: "dialog-title", id: titleId }, "Reveal the true location"),
        el("div", "dialog-body stack",
          el("p", null, "Type or paste the coordinates the organisers announce for ", el("strong", null, targetPid), ", latitude first."),
          el("label", "field", el("span", "field-label", "Coordinates"), input),
          reading,
          failure,
          el("p", "dim small", "This is kept as a note on the run. It is not written to the interaction log and nothing is sent to the agent.")),
        el("div", "dialog-actions", cancel, ok)));
    dialog.addEventListener("close", () => { if (truthDialog === dialog) closeTruthDialog(); });
    input.addEventListener("input", () => { failure.hidden = true; read(); });
    truthDialog = dialog;
    root.append(dialog);
    read();
    dialog.showModal();
    input.focus();
    input.select();
  }

  // ---------------------------------------------------------------- presenter overlay, strip

  function row(term, ...value) {
    return [el("dt", "dim", term), el("dd", null, ...value)];
  }

  function renderPresenter(run, tile) {
    presenter.hidden = !presenterOpen;
    presenterButton.setAttribute("aria-pressed", presenterOpen ? "true" : "false");
    if (!presenterOpen) return;
    const connected = store.state.connected;
    const budget = tile.budget || {};
    const problems = presenterProblems(run, tile, { connected });
    const reveal = truthAvailability(run, tile);
    const sinceContact = store.state.lastContactMs ? fmtAgo((Date.now() - store.state.lastContactMs) / 1000) : "never";
    const sig = [run.state, tile.status, tile.turns, tile.spend_usd, run.totals && run.totals.spend_usd, tile.ledger_text,
      tile.model, tile.effort, connected ? "live" : sinceContact, reveal.reason, problems.join("\n")].join("|");
    keyed(presenter, sig, () => [
      el("h2", "stage-presenter-title row spread",
        el("span", null, "Presenter"),
        el("button", { type: "button", class: "icon-btn small", title: "Close (P)", "aria-label": "Close the presenter overlay", onclick: togglePresenter }, icon("x"))),
      el("dl", "kv",
        row("Run", el("span", "mono wrap-any", run.run_id), " ", statusBadge(run.state)),
        row("Panorama", el("span", "mono wrap-any", tile.panorama_id), " ", statusBadge(tile.status)),
        row("Model", [tile.model, tile.effort ? tile.effort + " effort" : null].filter(Boolean).join(" · ") || "unknown"),
        row("Turns", el("span", "num", fmtInt(tile.turns || 0) + (budget.max_turns ? " of " + fmtInt(budget.max_turns) : ""))),
        row("Spend", el("span", "num", fmtUsd(tile.spend_usd || 0) + (budget.max_spend_usd ? " of " + fmtUsd(budget.max_spend_usd) : "")),
          run.totals ? el("span", "dim num", "  ·  run " + fmtUsd(run.totals.spend_usd || 0)) : null),
        row("Multiplier", el("span", "num", tile.ledger_text || fmtMult(tile.penalty && tile.penalty.multiplier))),
        row("Stream", connected ? badge("live", "ok", "wifi") : badge("down", "warn", "wifi-off"),
          connected ? null : el("span", "dim num", "  last contact " + sinceContact)),
        row("Reveal truth", reveal.available ? "Available. Press R, or use the Reveal truth button below the map." : reveal.reason)),
      el("div", "stage-presenter-errors",
        el("span", "caps dim", "Errors"),
        problems.length
          ? el("ul", null, problems.map((line) => el("li", null, icon("alert"), el("span", null, line))))
          : el("p", "row tight", icon("check"), el("span", null, "None."))),
    ]);
  }

  function renderStrip(run, tiles) {
    keyed(runNote, [run.run_id, run.kind, run.fake_model].join("|"), () => [
      el("span", "dim", "astrolabio"),
      el("span", "mono", run.run_id),
      run.kind ? badge(run.kind, "dim") : null,
      run.fake_model ? badge("demo model, not real answers", "warn", "alert") : null,
    ]);
    pickerGroup.hidden = tiles.length < 2;
    syncList(picker, panoramaChoices(tiles), (choice) => choice.pid,
      (choice) => el("option", { value: choice.pid }),
      (node, choice) => setText(node, choice.text));
    if (picker.value !== pid && document.activeElement !== picker) picker.value = pid;
  }

  // The tools that act on the panorama on stage. Before the end card takes over, Reveal truth is
  // shown here although it cannot be used yet, and says why: a real `disabled` would hide the
  // reason from the keyboard and the pointer.
  function renderTools(run, tile, card) {
    for (const node of [layerButton, presenterButton]) node.hidden = !tile;
    revealButton.hidden = !tile || Boolean(card);
    if (!tile) return;
    const reveal = truthAvailability(run, tile);
    revealButton.setAttribute("aria-disabled", reveal.available ? "false" : "true");
    revealButton.title = reveal.available ? "Enter the coordinates the organisers announce (R)" : reveal.reason;
  }

  function renderLost() {
    const state = store.state;
    const down = !state.connected && (state.everConnected || Date.now() - mountedAt > CONNECT_GRACE_MS);
    lost.hidden = !down;
    if (!down) return;
    keyed(lost, state.everConnected ? "lost" : "never", () => [
      icon("wifi-off"),
      el("span", null, state.everConnected
        ? "Connection lost. This is the last state received; reconnecting."
        : "No connection to the server yet. Retrying."),
    ]);
  }

  // ---------------------------------------------------------------- buttons with state

  function renderButtons() {
    const light = prefs.get("stageTheme") === "light";
    keyed(themeButton, light ? "light" : "dark", () => [icon(light ? "moon" : "sun"), light ? "Dark" : "Light"]);
    themeButton.setAttribute("aria-label", light ? "Switch the stage to the dark theme" : "Switch the stage to the light theme");
    const satellite = prefs.get("stageLayer", "street") === "satellite";
    layerButton.setAttribute("aria-pressed", satellite ? "true" : "false");
    const full = Boolean(document.fullscreenElement);
    keyed(fullButton, full ? "full" : "window", () => [icon(full ? "collapse" : "expand"), full ? "Leave full screen" : "Full screen"]);
  }

  function toggleTheme() {
    prefs.set("stageTheme", prefs.get("stageTheme") === "light" ? "dark" : "light");
  }

  function toggleLayer() {
    const next = prefs.get("stageLayer", "street") === "satellite" ? "street" : "satellite";
    prefs.set("stageLayer", next);
  }

  function applyLayer() {
    if (view) view.map.setLayer(prefs.get("stageLayer", "street") === "satellite" ? "satellite" : "street");
    renderButtons();
  }

  function togglePresenter() {
    presenterOpen = !presenterOpen;
    render();
  }

  function toggleFullscreen() {
    const doc = document;
    if (doc.fullscreenElement) {
      weWentFullscreen = false;
      Promise.resolve(doc.exitFullscreen()).catch(() => {});
      return;
    }
    const target = doc.documentElement;
    if (typeof target.requestFullscreen !== "function") {
      toast("This browser cannot go full screen from the page. Use the browser's own full-screen command.", "warn");
      return;
    }
    weWentFullscreen = true;
    Promise.resolve(target.requestFullscreen()).catch(() => {
      weWentFullscreen = false;
      toast("The browser refused full screen. Use the browser's own full-screen command.", "warn");
    });
  }

  // ---------------------------------------------------------------- render

  function showWait(children) {
    for (const node of [header, bar, panes, foot]) node.hidden = Boolean(children);
    wait.hidden = !children;
    if (children) keyed(wait, children.key, children.build);
    else wait.dataset.sig = "";
  }

  function render() {
    if (dead) return;
    renderButtons();
    const run = currentRun();
    if (!run) {
      closeView();
      pid = null;
      presenter.hidden = true;
      runNote.replaceChildren();
      runNote.dataset.sig = "";
      pickerGroup.hidden = true;
      renderTools(null, null, null);
      if (loadError) {
        const text = errorText(loadError);
        showWait({
          key: "error|" + text,
          build: () => el("div", "stage-wait-box",
            el("div", "notice notice-bad", icon("alert"),
              el("div", "stack tight", el("strong", null, "This run could not be loaded."), el("span", "pre", text))),
            el("div", "row",
              el("button", { type: "button", class: "primary", onclick: () => { loadError = null; load({ force: true }); render(); } }, icon("refresh"), "Try again"),
              link(paths.runs(), { class: "btn" }, "Back to runs"))),
        });
      } else {
        showWait({ key: "loading", build: () => el("div", "stage-wait-box row", el("span", "spinner"), el("span", null, loading ? "Loading the run." : "Waiting for the run.")) });
      }
      renderLost();
      return;
    }

    const tiles = tilesOf(run);
    const tile = resolvePanorama(run);
    if (!tile) {
      closeView();
      pid = null;
      presenter.hidden = true;
      renderStrip(run, tiles);
      renderTools(run, null, null);
      showWait({
        key: "empty",
        build: () => el("div", "stage-wait-box empty",
          el("div", "empty-title", "This run has no panoramas yet."),
          el("p", null, "The stage fills in as soon as the run has one. Nothing needs doing here."),
          link(paths.run(runId), { class: "btn" }, icon("arrow-left"), "Back to the dashboard")),
      });
      renderLost();
      return;
    }

    showWait(null);
    const sent = sentTruth.get(pid);
    if (sent && truthSettled(run, pid, sent)) sentTruth.delete(pid);
    const truth = shownTruth(run, tile, sentTruth.get(pid));

    const card = endCard(tile);
    renderStrip(run, tiles);
    renderTools(run, tile, card);
    renderHeader(run, tile);
    renderClock(tile);
    syncView(tile, truth);
    if (card) renderEnd(run, tile, card, truth);
    else renderTicker(tile);
    root.dataset.phase = stagePhase(tile);
    renderPresenter(run, tile);
    renderLost();
    // The truth may only be typed while it may be revealed (another tab, a retry).
    if (truthDialog && !truthAvailability(run, tile).available) closeTruthDialog();
  }

  function tick() {
    if (dead) return;
    const run = currentRun();
    const tile = run ? currentTile(run) : null;
    if (tile) {
      renderClock(tile);
      if (presenterOpen) renderPresenter(run, tile);
    }
    renderLost();
  }

  // ---------------------------------------------------------------- wiring

  cleanup.push(store.subscribe(render));
  cleanup.push(store.on("connection", render));
  // A run read from disk is refreshed when the runs index changes (it is not on the stream).
  cleanup.push(store.on("index", () => {
    const run = currentRun();
    if (run && !run.owned) load({ force: true });
  }));
  cleanup.push(prefs.onChange("stageTheme", renderButtons));
  cleanup.push(prefs.onChange("stageLayer", applyLayer));
  const onFullscreen = () => renderButtons();
  document.addEventListener("fullscreenchange", onFullscreen);
  cleanup.push(() => document.removeEventListener("fullscreenchange", onFullscreen));
  const timer = setInterval(tick, TICK_MS);
  cleanup.push(() => clearInterval(timer));

  // None of these keys sends anything: they change what the projector shows, or open a dialog.
  cleanup.push(shortcuts.register("Stage", {
    p: { label: "Show or hide the presenter overlay (status, spend, errors)", run: togglePresenter },
    f: { label: "Enter or leave full screen", run: toggleFullscreen },
    Escape: { label: "Back to the run dashboard", run: () => navigate(paths.run(runId)) },
    ArrowLeft: { label: "Previous panorama", when: () => tilesOf(currentRun()).length > 1, run: () => step(-1) },
    ArrowRight: { label: "Next panorama", when: () => tilesOf(currentRun()).length > 1, run: () => step(1) },
    s: { label: "Street map or satellite imagery", run: toggleLayer },
    t: { label: "Light or dark stage", run: toggleTheme },
    r: { label: "Open Reveal truth (after the final answer; asks for the coordinates)", run: openTruthDialog },
  }));

  ctx.setTitle("Stage");
  render();
  load();

  return {
    unmount() {
      if (dead) return;
      dead = true;
      abort.abort();
      for (const off of cleanup.splice(0)) off();
      closeTruthDialog();
      closeView();
      if (weWentFullscreen && document.fullscreenElement) Promise.resolve(document.exitFullscreen()).catch(() => {});
      root.remove();
    },
    onQuery(query) {
      const asked = query.get("pano");
      if (!asked || asked === pid) return;
      wanted = asked;
      render();
    },
  };
}
