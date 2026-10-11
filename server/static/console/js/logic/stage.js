// Decisions of the stage view (UI-SPEC 5.7) that need no DOM: which panorama is on stage, what the
// clock and the end card say, when the truth may be revealed, and how the coordinates a presenter
// types are read. Pure, so it runs under `node --test`.

import { fmtCoord, fmtLatLng } from "../format.js";

const RUNNING = new Set(["running", "awaiting_mcq"]);

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

// The server's stop texts are clauses ("hard deadline: best-so-far list used"); where the stage
// shows one on a line of its own it starts with a capital.
const sentence = (text) => (typeof text === "string" && text ? text[0].toUpperCase() + text.slice(1) : "");

// ---------------------------------------------------------------- which panorama

/**
 * The panorama the stage shows: `?pano=` when the run has it, else the Special One, else the first
 * one that is running, else the first (contract A11). Returns the tile or null.
 */
export function pickPanorama(tiles, wanted) {
  const list = Array.isArray(tiles) ? tiles : [];
  if (!list.length) return null;
  if (wanted) {
    const asked = list.find((tile) => tile.panorama_id === wanted);
    if (asked) return asked;
  }
  return list.find((tile) => tile.special)
    || list.find((tile) => tile.active !== false && RUNNING.has(tile.status))
    || list[0];
}

/** The panorama `step` places after `pid` (wrapping), for the arrow keys. Null with fewer than two. */
export function stepPanorama(tiles, pid, step) {
  const list = Array.isArray(tiles) ? tiles : [];
  if (list.length < 2) return null;
  const index = list.findIndex((tile) => tile.panorama_id === pid);
  if (index === -1) return list[0].panorama_id;
  const next = (((index + step) % list.length) + list.length) % list.length;
  return list[next].panorama_id;
}

const STATUS_WORDS = {
  pending: "waiting",
  running: "running",
  awaiting_mcq: "running",
  done: "done",
  interrupted: "interrupted",
};

/** One line per panorama for the picker: "pano_03 (Special One) · Urban · running". */
export function panoramaChoices(tiles) {
  return (Array.isArray(tiles) ? tiles : []).map((tile) => ({
    pid: tile.panorama_id,
    text: [
      tile.panorama_id + (tile.special ? " (Special One)" : ""),
      tile.label || null,
      STATUS_WORDS[tile.status] || String(tile.status || "unknown"),
    ].filter(Boolean).join(" · "),
  }));
}

// ---------------------------------------------------------------- phase and clock

/** "waiting" | "running" | "final" | "interrupted": what the stage is showing for this tile. */
export function stagePhase(tile) {
  if (!tile) return "waiting";
  if (tile.final) return "final";
  if (tile.status === "interrupted") return "interrupted";
  if (RUNNING.has(tile.status)) return "running";
  if (tile.status === "done") return "final";
  return "waiting";
}

/**
 * The clock in the header. `elapsedS` is the locally ticking elapsed time (store.elapsed).
 *   seconds   what the big figure shows: time left to the hard deadline while running, the elapsed
 *             time once final or interrupted, the whole budget while waiting; null when unknown
 *   label     the words above the figure; `note` adds what the tone means, or is ""
 *   tone      "idle" | "ok" | "soft" | "warn" | "over" | "final" | "stopped" (never the only signal:
 *             label and note say the same in words)
 *   share     0..1 of the hard deadline used; soft_share is where the soft deadline sits
 */
export function clockState(tile, elapsedS) {
  const phase = stagePhase(tile);
  const budget = (tile && tile.budget) || {};
  const hard = num(budget.hard_deadline_s);
  const soft = num(budget.soft_deadline_s);
  const elapsed = Math.max(0, num(elapsedS) ?? 0);
  const share = hard ? Math.min(1, elapsed / hard) : null;
  const softShare = hard && soft !== null ? Math.min(1, soft / hard) : null;
  const base = { phase, hard_s: hard, elapsed_s: elapsed, share, soft_share: softShare, note: "" };

  if (phase === "final") return { ...base, seconds: elapsed, tone: "final", label: "Finished in" };
  if (phase === "interrupted") return { ...base, seconds: elapsed, tone: "stopped", label: "Interrupted after" };
  if (phase === "waiting") return { ...base, seconds: hard, tone: "idle", share: 0, label: "Waiting to start" };
  if (hard === null) return { ...base, seconds: elapsed, tone: "ok", label: "Elapsed" };

  const remaining = hard - elapsed;
  if (remaining <= 0) {
    return { ...base, seconds: 0, tone: "over", label: "Time left", note: "Deadline reached, finalising" };
  }
  // The last stretch: a minute on a long budget, a quarter of a short one.
  if (remaining <= Math.min(60, hard * 0.25)) {
    return { ...base, seconds: remaining, tone: "warn", label: "Time left", note: "Almost out of time" };
  }
  if (soft !== null && elapsed >= soft) {
    return { ...base, seconds: remaining, tone: "soft", label: "Time left", note: "Past the soft deadline, wrapping up" };
  }
  return { ...base, seconds: remaining, tone: "ok", label: "Time left" };
}

// ---------------------------------------------------------------- belief

/** The most probable hypothesis: `{index, label, probability, lat, lng, radius_m}` or null. */
export function topGuess(hypotheses) {
  let best = null;
  (Array.isArray(hypotheses) ? hypotheses : []).forEach((hyp, index) => {
    if (!hyp || num(hyp.lat) === null || num(hyp.lng) === null) return;
    const probability = num(hyp.probability) ?? 0;
    if (!best || probability > best.probability) {
      best = {
        index,
        label: typeof hyp.label === "string" ? hyp.label : "",
        probability,
        lat: hyp.lat,
        lng: hyp.lng,
        radius_m: num(hyp.radius_m),
      };
    }
  });
  return best;
}

/** Identity of a guess for "has the top hypothesis moved": about 11 m of resolution. */
export function guessKey(guess) {
  if (!guess) return null;
  return guess.lat.toFixed(4) + "," + guess.lng.toFixed(4);
}

/**
 * Map zoom that keeps a hypothesis and its uncertainty in view: a 500 m radius is a district
 * (zoom 14), each doubling of the radius is one zoom level out.
 */
export function zoomForRadius(radiusM) {
  const radius = num(radiusM);
  if (radius === null || radius <= 0) return 11;
  const zoom = Math.round(14 - Math.log2(radius / 500));
  return Math.max(4, Math.min(16, zoom));
}

/**
 * The zoom at which the whole world just fills a map pane of this size, for the minutes before the
 * agent has a hypothesis: one zoom level lower leaves empty bands around the world.
 */
export function worldZoom(widthPx, heightPx) {
  const side = Math.max(num(widthPx) ?? 0, num(heightPx) ?? 0);
  if (side <= 256) return 1;
  return Math.min(4, Math.ceil(Math.log2(side / 256)));
}

const EARTH_M = 6371008.8;
const EQUATOR_M_PER_PX = 156543.03392; // Web Mercator at zoom 0
const FRAME_LIMIT_M = 2_000_000;

/**
 * The view that shows the answer and the revealed truth together with room around them for their
 * labels: `{lat, lng, zoom}`. Null when the points are too far apart for a flat estimate (or the
 * pane has no size yet); the caller then lets the map fit them itself.
 */
export function truthFrame(points, widthPx, heightPx) {
  const list = (Array.isArray(points) ? points : []).filter((point) => point && num(point.lat) !== null && num(point.lng) !== null);
  const width = num(widthPx) ?? 0;
  const height = num(heightPx) ?? 0;
  if (!list.length || width <= 0 || height <= 0) return null;
  const lats = list.map((point) => point.lat);
  const lngs = list.map((point) => point.lng);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);
  const lat = (south + north) / 2;
  const shrink = Math.cos((lat * Math.PI) / 180);
  const acrossM = EARTH_M * shrink * (((east - west) * Math.PI) / 180);
  const upM = EARTH_M * (((north - south) * Math.PI) / 180);
  if (acrossM > FRAME_LIMIT_M || upM > FRAME_LIMIT_M || shrink < 0.2) return null;
  // The points may use this share of the pane; the rest is for the labels beside the markers.
  const fits = (spanM, px, share) => (spanM > 0 ? Math.log2((EQUATOR_M_PER_PX * shrink * px * share) / spanM) : Infinity);
  const zoom = Math.floor(Math.min(fits(acrossM, width, 0.5), fits(upM, height, 0.55)));
  return { lat, lng: (west + east) / 2, zoom: Math.max(3, Math.min(17, zoom)) };
}

// ---------------------------------------------------------------- crops

/** Crops the viewer has not flashed yet (numbers above `seenN`), oldest first. */
export function freshCrops(crops, seenN) {
  return (Array.isArray(crops) ? crops : [])
    .filter((crop) => crop && num(crop.n) !== null && crop.n > seenN)
    .sort((a, b) => a.n - b.n);
}

export function lastCropNumber(crops) {
  return (Array.isArray(crops) ? crops : []).reduce((max, crop) => (crop && num(crop.n) !== null ? Math.max(max, crop.n) : max), 0);
}

/** Where the camera turns to show a crop: centred on it, wide enough to see what surrounds it. */
export function cropView(crop) {
  const fov = num(crop.fov) ?? 40;
  return { yaw: num(crop.yaw) ?? 0, pitch: num(crop.pitch) ?? 0, fov: Math.max(55, Math.min(100, fov * 2.4)) };
}

/** Image sources for the viewer, smallest first; `urlFor(width | "full")` builds each API path. */
export function viewerSources(tile, urlFor) {
  const full = tile && tile.image ? num(tile.image.width) : null;
  const sources = [1024, 2048, 4096]
    .filter((width) => full === null || width < full)
    .map((width) => ({ width, url: urlFor(width) }));
  if (full !== null) sources.push({ width: full, url: urlFor("full") });
  return sources;
}

// ---------------------------------------------------------------- ticker

const ACTIVITY_FALLBACK = {
  waiting: "Waiting to start",
  running: "Working",
  final: "Finished",
  interrupted: "Stopped before it finished",
};

/**
 * The ticker line. The sentence is the server's (`tile.activity`, contract A7); the stage only
 * supplies a neutral stand-in when the field is missing.
 */
export function activityLine(tile) {
  const activity = tile && tile.activity;
  if (activity && typeof activity.text === "string" && activity.text.trim()) {
    return { text: activity.text, tool: activity.tool || null, seq: activity.seq ?? null, fallback: false };
  }
  return { text: ACTIVITY_FALLBACK[stagePhase(tile)], tool: null, seq: null, fallback: true };
}

export function reasoningText(tile) {
  const last = tile && tile.last_reasoning;
  return last && typeof last.text === "string" ? last.text.trim() : "";
}

/**
 * What the bottom of the stage says while there is no final answer:
 * `{headline, tool, seq, caption, body, asking}`. `asking` is true while the operator console has
 * a question open; the stage says so and shows nothing of the question (UI-SPEC 3).
 */
export function tickerState(tile) {
  const phase = stagePhase(tile);
  if (phase === "interrupted") {
    return {
      headline: "Interrupted before it finished",
      tool: null,
      seq: null,
      caption: "What happened",
      body: sentence(tile && tile.stop_text),
      asking: false,
    };
  }
  const line = activityLine(tile);
  return {
    headline: line.text,
    tool: line.tool,
    seq: line.seq,
    caption: "Latest reasoning",
    body: reasoningText(tile),
    asking: phase === "running" && Boolean(tile && tile.pending_mcq),
  };
}

// ---------------------------------------------------------------- the end card

/**
 * A ranked list with runs of the same point folded: `[{count, lat, lng, first_rank, last_rank}]`.
 * Only neighbours are folded, because the rank of an entry is part of the answer.
 */
export function collapseEntries(entries) {
  const groups = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || num(entry.lat) === null || num(entry.lng) === null) continue;
    const rank = num(entry.rank) ?? (groups.length ? groups[groups.length - 1].last_rank + 1 : 1);
    const last = groups[groups.length - 1];
    if (last && fmtCoord(last.lat) === fmtCoord(entry.lat) && fmtCoord(last.lng) === fmtCoord(entry.lng)) {
      last.count += 1;
      last.last_rank = rank;
    } else groups.push({ count: 1, lat: entry.lat, lng: entry.lng, first_rank: rank, last_rank: rank });
  }
  return groups;
}

/** The list as the brief writes it: ["10 x 38.716900, -9.139900"]. */
export function listLines(entries) {
  return collapseEntries(entries).map((group) => group.count + " x " + fmtLatLng(group.lat, group.lng));
}

const ORIGIN_WORDS = {
  agent: "Submitted by the agent",
  harness_fallback: "Fallback answer from the harness",
  human_geocode: "Set by the operator's geocode",
};

/**
 * What the stage shows once a panorama is final, or null before that.
 * `{point: {lat, lng}, point_text, groups, lines, entries, elapsed_s, turns, origin_text, fallback,
 *   stop_text, multiplier}`
 */
export function endCard(tile) {
  if (!tile || !Array.isArray(tile.final) || !tile.final.length) return null;
  const groups = collapseEntries(tile.final);
  if (!groups.length) return null;
  const first = groups[0];
  const multiplier = tile.penalty && num(tile.penalty.multiplier) !== null ? tile.penalty.multiplier : 1;
  return {
    point: { lat: first.lat, lng: first.lng },
    point_text: fmtLatLng(first.lat, first.lng),
    groups,
    lines: groups.map((group) => group.count + " x " + fmtLatLng(group.lat, group.lng)),
    entries: tile.final.length,
    elapsed_s: num(tile.elapsed_s) ?? 0,
    turns: num(tile.turns) ?? 0,
    origin_text: ORIGIN_WORDS[tile.origin] || "Final answer",
    fallback: tile.origin === "harness_fallback",
    stop_text: typeof tile.stop_text === "string" ? tile.stop_text : "",
    multiplier,
  };
}

// ---------------------------------------------------------------- reveal truth

/**
 * Whether the presenter may reveal the truth for this panorama, and the reason when not
 * (UI-SPEC 5.7, contract A19: never beside a human channel, never before the answer is final).
 */
export function truthAvailability(run, tile) {
  if (!run || !tile) return { available: false, reason: "No panorama is on stage." };
  const penalties = (run.totals && run.totals.penalties) || {};
  const charged = Object.values(penalties).reduce((sum, value) => sum + (Number(value) || 0), 0);
  if (!run.no_human || charged > 0) {
    return {
      available: false,
      reason: "Reveal truth is off for this run: its human channels are on, and the true location must never be on screen beside a control that reaches the agent.",
    };
  }
  if (!tile.final) {
    if (tile.status === "interrupted") {
      return {
        available: false,
        reason: "Reveal truth is not available: this panorama was interrupted before it had a final answer. Rebuild the exports on the Submission page first.",
      };
    }
    if (RUNNING.has(tile.status)) {
      return { available: false, reason: "Reveal truth is not available while the panorama is running. It opens once the answer is final." };
    }
    return { available: false, reason: "Reveal truth opens once this panorama has run and its answer is final." };
  }
  return { available: true, reason: "" };
}

const sameSpot = (a, b) => Boolean(a && b) && fmtCoord(a.lat) === fmtCoord(b.lat) && fmtCoord(a.lng) === fmtCoord(b.lng);

/**
 * The revealed truth to draw: `{lat, lng, distance_m, theta, score, max_score, share}` or null.
 * `stored` is `run.stage_truth[pid]`; `sent` is what this tab just got back from the PUT, which
 * wins until the stream has delivered the same coordinates.
 */
export function shownTruth(run, tile, sent) {
  if (!run || !tile || !tile.final || !run.no_human) return null;
  const stored = run.stage_truth && tile.panorama_id ? run.stage_truth[tile.panorama_id] : null;
  const usable = (note) => note && num(note.lat) !== null && num(note.lng) !== null;
  if (usable(sent) && !(usable(stored) && sameSpot(stored, sent))) return sent;
  return usable(stored) ? stored : null;
}

/** True once the stored note matches what this tab sent, so the local copy can be dropped. */
export function truthSettled(run, pid, sent) {
  const stored = run && run.stage_truth ? run.stage_truth[pid] : null;
  return sameSpot(stored, sent);
}

// ---- reading what the presenter typed

const EXAMPLE = "38.7169, -9.1399";
const fail = (problem) => ({ ok: false, problem });

function inRange(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail("That does not read as two numbers. Type them like " + EXAMPLE + ".");
  if (Math.abs(lat) > 90) {
    return fail("The latitude comes first and must be between -90 and 90; this reads as " + trim(lat) + ". If the longitude was given first, swap the two.");
  }
  if (Math.abs(lng) > 180) return fail("The longitude must be between -180 and 180; this reads as " + trim(lng) + ".");
  const point = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
  return { ok: true, ...point, text: fmtLatLng(point.lat, point.lng) };
}

const trim = (value) => String(Number(value.toFixed(6)));

// "38° 43' 0.8"" as degrees: the parts after the first are minutes and seconds.
function fromParts(parts) {
  const [deg, min = 0, sec = 0] = parts;
  if (min >= 60 || sec >= 60) return NaN;
  return deg + min / 60 + sec / 3600;
}

function withHemispheres(text) {
  if (/[-+]/.test(text)) return fail("Use either a minus sign or the letters N, S, E, W, not both.");
  const tokens = text.match(/[NSEW]|\d+(?:[.,]\d+)?/gi) || [];
  const letters = tokens.filter((token) => /[NSEW]/i.test(token));
  if (letters.length !== 2) return fail("With compass letters there must be one for each number, like 38.7169 N, 9.1399 W.");
  const leading = /[NSEW]/i.test(tokens[0]);
  const chunks = [];
  let current = leading ? null : { letter: null, parts: [] };
  for (const token of tokens) {
    if (/[NSEW]/i.test(token)) {
      if (leading) {
        current = { letter: token.toUpperCase(), parts: [] };
        chunks.push(current);
      } else {
        current.letter = token.toUpperCase();
        chunks.push(current);
        current = { letter: null, parts: [] };
      }
    } else if (current) current.parts.push(Number(token.replace(",", ".")));
  }
  if (!leading && current.parts.length) return fail("A number has no compass letter. Write them like 38.7169 N, 9.1399 W.");
  if (chunks.some((chunk) => chunk.parts.length < 1 || chunk.parts.length > 3)) {
    return fail("Each coordinate needs degrees, and at most minutes and seconds, like 38° 43' 0.8\" N.");
  }
  const lat = chunks.find((chunk) => chunk.letter === "N" || chunk.letter === "S");
  const lng = chunks.find((chunk) => chunk.letter === "E" || chunk.letter === "W");
  if (!lat || !lng) return fail("One coordinate must be N or S and the other E or W.");
  return inRange(
    fromParts(lat.parts) * (lat.letter === "S" ? -1 : 1),
    fromParts(lng.parts) * (lng.letter === "W" ? -1 : 1),
  );
}

// Signed degrees, minutes and seconds without compass letters: -9° 8' 23.6" is -(9 + 8/60 + ...).
function signedParts(tokens) {
  const negative = tokens[0].startsWith("-");
  const value = fromParts(tokens.map((token) => Math.abs(Number(token))));
  return negative ? -value : value;
}

/**
 * Read the coordinates a presenter typed or pasted. Accepts "38.7169, -9.1399", a space or a
 * semicolon as the separator, decimal commas ("38,7169; -9,1399"), "lat 38.7169 lng -9.1399",
 * compass letters ("38.7169 N 9.1399 W") and degrees, minutes, seconds ("38°43'0.8"N 9°8'23.6"W").
 * Returns `{ok: true, lat, lng, text}` (6 decimals) or `{ok: false, problem}` in plain words.
 */
export function parseTruth(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return fail("Type the latitude and the longitude, like " + EXAMPLE + ".");
  if (raw.length > 120) return fail("That is too long for a pair of coordinates. Type them like " + EXAMPLE + ".");

  let text = raw
    .replace(/−/g, "-")
    // A dash typed for a minus sign sits right before its digit; one with a space after is a separator.
    .replace(/[‒–—](?=\d)/g, "-")
    .replace(/[‒–—]/g, " ")
    .replace(/[′’ʹ´]/g, "'")
    .replace(/[″”ʺ]|''/g, '"')
    .replace(/[º˚]/g, "°")
    .replace(/\bdeg(?:rees?)?\b\.?/gi, "°");

  const latAt = text.search(/\blat(?:itude)?\b/i);
  const lngAt = text.search(/\b(?:lng|lon|long|longitude)\b/i);
  const lngFirst = latAt >= 0 && lngAt >= 0 && lngAt < latAt;
  text = text
    .replace(/\b(?:latitude|longitude|lat|lng|long|lon)\b\.?\s*[:=]?/gi, " ")
    .replace(/[()[\]{}]/g, " ")
    .trim()
    .replace(/[.,;]+$/, "")
    .trim();

  if (/[^\d\s.,;:+\-°'"NSEW]/i.test(text)) {
    return fail("That does not read as coordinates. Type two numbers, latitude first, like " + EXAMPLE + ".");
  }
  if (/[NSEW]/i.test(text)) return withHemispheres(text);

  let lat;
  let lng;
  if (/[°'"]/.test(text)) {
    const tokens = text.match(/[-+]?\d+(?:\.\d+)?/g) || [];
    if (tokens.length !== 2 && tokens.length !== 4 && tokens.length !== 6) {
      return fail("That does not read as two coordinates. Type them like " + EXAMPLE + " or 38° 43' 0.8\" N, 9° 8' 23.6\" W.");
    }
    const half = tokens.length / 2;
    lat = signedParts(tokens.slice(0, half));
    lng = signedParts(tokens.slice(half));
  } else {
    // Two numbers that both have decimals: the separator between them can be a comma even when
    // the decimal mark is a comma too ("38,7169, -9,1399").
    const pair = text.match(/^([-+]?\d+)[.,](\d+)\s*[,;\s]\s*([-+]?\d+)[.,](\d+)$/);
    if (pair) {
      lat = Number(pair[1] + "." + pair[2]);
      lng = Number(pair[3] + "." + pair[4]);
    } else {
      const tokens = text.match(/[-+]?\d+(?:\.\d+)?/g) || [];
      if (tokens.length !== 2) {
        const found = tokens.length === 1 ? "only one number" : tokens.length + " numbers";
        return fail("Two numbers are needed, latitude then longitude, and this has " + found + ". Type them like " + EXAMPLE + ".");
      }
      lat = Number(tokens[0]);
      lng = Number(tokens[1]);
    }
  }
  return lngFirst ? inRange(lng, lat) : inRange(lat, lng);
}

// ---------------------------------------------------------------- presenter overlay

/** Problems worth the presenter's eye, in plain words; empty when there is nothing wrong. */
export function presenterProblems(run, tile, { connected = true } = {}) {
  const problems = [];
  if (!connected) problems.push("The connection to the server is down. The screen shows the last state it received.");
  if (run && run.fake_model) problems.push("Scripted demo model: these are not real answers.");
  if (tile) {
    if (tile.api_trouble) problems.push(sentence(tile.api_trouble_text) || "The model API is failing; the harness is retrying.");
    if (tile.status === "interrupted") problems.push(sentence(tile.stop_text) || "This panorama was interrupted.");
    if (tile.origin === "harness_fallback") problems.push("The answer is the harness fallback" + (tile.stop_text ? ": " + tile.stop_text : "."));
    if (tile.export_problems) problems.push("Export problem: " + tile.export_problems);
  }
  return problems;
}
