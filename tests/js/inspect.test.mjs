import test from "node:test";
import assert from "node:assert/strict";

import {
  TABS,
  TAB_LABELS,
  aimText,
  anglesText,
  budgetMeters,
  budgetRows,
  countUpTo,
  cropNumbers,
  defaultComparison,
  distinctAnswers,
  downloadItems,
  downloadName,
  eventAt,
  filterGallery,
  filterTools,
  flagRows,
  fmtDeg,
  fmtLatency,
  fmtMoment,
  fmtPayload,
  galleryRows,
  gallerySources,
  galleryTotals,
  imageOrigin,
  inputSummary,
  keyframeAt,
  ledgerRows,
  ledgerSummary,
  panoramaViews,
  parseOutput,
  provenanceRows,
  rankText,
  requestText,
  sourceLabel,
  sourceWords,
  staleCount,
  stopReasonText,
  tabName,
  toolDefinitionNames,
  toolIndexAt,
  toolNames,
  toolRows,
  toolsText,
  truthAllowed,
  truthChart,
  truthFor,
  truthStats,
  turnBars,
  turnIndexAt,
  turnRows,
  turnTotals,
  viewCaption,
} from "../../server/static/console/js/logic/inspect.js";

const sha = (letter) => letter.repeat(64);

// A short run in the shape of `GET /api/runs/<id>/pano/<pid>/inspect` (server/inspect.py): three
// turns, one retry, a crop, a street-level lookup, a hosted search and a failed call.
function payload() {
  return {
    run_id: "run1",
    panorama_id: "pano_1",
    last_seq: 30,
    segments: 1,
    timeline: [
      { seq: 1, t_rel_s: 0.1, segment: 1, type: "run_start", turn: null, mark: null },
      { seq: 2, t_rel_s: 0.8, segment: 1, type: "model_request", turn: 1, mark: null },
      { seq: 5, t_rel_s: 16, segment: 1, type: "candidates_update", turn: 1, mark: "candidates" },
      { seq: 20, t_rel_s: 60, segment: 1, type: "candidates_update", turn: 2, mark: "candidates" },
      { seq: 30, t_rel_s: 95.5, segment: 1, type: "final_submission", turn: 3, mark: "final" },
    ],
    keyframes: [
      { seq: 1, t_rel_s: 0.1, status: "running", hypotheses: [], provisional: [], final: null },
      { seq: 5, t_rel_s: 16, status: "running", hypotheses: [{ label: "A" }], provisional: [], final: null },
      { seq: 30, t_rel_s: 95.5, status: "done", hypotheses: [{ label: "B" }], provisional: [], final: [] },
    ],
    series: { labels: ["A", "B"], points: [], top_path: [] },
    turns: [
      {
        turn: 1, segment: 1, seq_request: 2, seq_response: 3, t_rel_s: 0.8, message_count: 1, image_count: 2,
        image_payload_chars: 2500000, images_added: 2, tokens: { input: 40000, cached: 0, output: 500, reasoning: 200 },
        latency_ms: 15200, cost_usd: 0.11, stop_reason: "tool_use", error: null, retries: [],
      },
      {
        turn: 2, segment: 1, seq_request: 10, seq_response: 12, t_rel_s: 20, message_count: 3, image_count: 4,
        image_payload_chars: 3900000, images_added: 2, tokens: { input: 42000, cached: 40000, output: 300, reasoning: 100 },
        latency_ms: 800, cost_usd: 0.01, stop_reason: "tool_use", error: null,
        retries: [{ seq: 11, t_rel_s: 21, message: "rate limited", delay_s: 2, attempt: 1, status_code: 429 }],
      },
      {
        turn: 3, segment: 1, seq_request: 25, seq_response: null, t_rel_s: 70, message_count: 5, image_count: 4,
        image_payload_chars: 3900000, images_added: 0, tokens: null, latency_ms: null, cost_usd: null,
        stop_reason: null, error: null, retries: [],
      },
    ],
    tools: [
      {
        seq_call: 4, seq_result: 6, turn: 1, segment: 1, t_rel_s: 16, tool: "view_crop", crop_n: 1,
        input: { yaw: 273, pitch: -7, fov: 20, enhance: true }, output: "View centred on yaw 273.0", is_error: false,
        duration_ms: 152, urls: [], cache_hit: null, hosted: false,
        images: [{ sha256: sha("c"), yaw: 273, pitch: -7, fov: 20, width: 682, height: 682 }],
      },
      {
        seq_call: 7, seq_result: 8, turn: 1, segment: 1, t_rel_s: 16.1, tool: "view_crop", crop_n: 2,
        input: { yaw: 400, pitch: 0, fov: 20 }, output: "yaw must be between 0 and 360", is_error: true,
        duration_ms: 1, urls: [], cache_hit: null, hosted: false, images: [],
      },
      {
        seq_call: 13, seq_result: 15, turn: 2, segment: 1, t_rel_s: 27.7, tool: "streetview_lookup", crop_n: null,
        input: { lat: 32.7549, lng: -17.056, radius_m: 250, headings: [0, 270] }, output: "Google Street View pano X",
        is_error: false, duration_ms: 1233, cache_hit: true, hosted: false,
        urls: ["https://maps.googleapis.com/maps/api/streetview?size=640x640&key=REDACTED"],
        images: [
          { sha256: sha("d"), yaw: null, pitch: null, fov: null, width: 640, height: 640, source: "google", heading: 0 },
          { sha256: sha("e"), yaw: null, pitch: null, fov: null, width: 640, height: 640, source: "google", heading: 270 },
        ],
      },
      {
        seq_call: 12, seq_result: 12, turn: 2, segment: 1, t_rel_s: 26, tool: "web_search", crop_n: null,
        input: { type: "search", query: "Bica da Cana road" }, output: null, is_error: false, duration_ms: null,
        urls: ["https://example.org/a", "https://example.org/b"], cache_hit: null, images: [], hosted: true,
      },
      {
        seq_call: 12, seq_result: 12, turn: 2, segment: 1, t_rel_s: 26, tool: "web_search", crop_n: null,
        input: { type: "search", query: "Paul da Serra fence" }, output: null, is_error: false, duration_ms: null,
        urls: [], cache_hit: null, images: [], hosted: true,
      },
      {
        seq_call: 26, seq_result: null, turn: 3, segment: 1, t_rel_s: 80, tool: "search_places", crop_n: null,
        input: { query: "Estanquinhos Madeira" }, output: null, is_error: false, duration_ms: null,
        urls: [], cache_hit: null, images: [], hosted: false,
      },
    ],
    images: [
      { n: 1, seq: 2, turn: 1, segment: 1, sha256: sha("a"), yaw: null, pitch: null, fov: null, width: 2000, height: 1000, est_tokens: 2419, payload_chars: 293512, source: "initial", seq_call: null, crop_n: null },
      { n: 2, seq: 2, turn: 1, segment: 1, sha256: sha("b"), yaw: 0, pitch: 0, fov: 90, width: 1456, height: 1456, est_tokens: 2540, payload_chars: 400000, source: "initial", seq_call: null, crop_n: null },
      { n: 3, seq: 10, turn: 2, segment: 1, sha256: sha("c"), yaw: null, pitch: null, fov: null, width: 682, height: 682, est_tokens: 581, payload_chars: 100000, source: "view_crop", seq_call: 4, crop_n: 1 },
      { n: 4, seq: 25, turn: 3, segment: 1, sha256: sha("d"), yaw: null, pitch: null, fov: null, width: null, height: null, est_tokens: null, payload_chars: null, source: "streetview_lookup", seq_call: 13, crop_n: null },
    ],
    image_budget: { count: 4, max_count: 80, payload_chars: 3900000, max_payload_chars: 24000000 },
    ledger: [],
    facts: {
      model: "gpt-x", effort: "high", git_sha: "abc123",
      budget: { effort: "high", soft_deadline_s: 600, hard_deadline_s: 840, max_turns: 30, max_spend_usd: 8 },
      flags: { allow_web: true, no_human: true, hedge: false, allow_duplicates: true, penalty_scope: "whole_list", max_mcq: 3 },
      request: { model: "gpt-x" }, system_prompt: "You are the agent.",
      tools: [{ type: "function", name: "view_crop" }, { type: "web_search" }],
      provenance: null, panorama: { panorama_id: "pano_1", filename: "pano_1.jpg" },
      label: "non-Urban", capture_timestamp: "20200610133716", special: false,
    },
  };
}

// ---------------------------------------------------------------- tabs

test("tab names are the ?tab= values of the URL contract", () => {
  assert.deepEqual(TABS, ["turns", "tools", "images", "ledger", "facts", "truth"]);
  for (const name of TABS) assert.ok(TAB_LABELS[name], name);
});

test("tabName falls back to turns for an unknown name and for truth without truth", () => {
  assert.equal(tabName("Tools"), "tools");
  assert.equal(tabName(" ledger "), "ledger");
  assert.equal(tabName("nonsense"), "turns");
  assert.equal(tabName(null), "turns");
  assert.equal(tabName("truth"), "turns");
  assert.equal(tabName("truth", { truth: true }), "truth");
});

// ---------------------------------------------------------------- the cursor

test("countUpTo counts what had happened by the cursor; a null cursor is the live tail", () => {
  const seqs = [2, 5, 5, 9, 30];
  assert.equal(countUpTo(seqs, null), 5);
  assert.equal(countUpTo(seqs, undefined), 5);
  assert.equal(countUpTo(seqs, "abc"), 5);
  assert.equal(countUpTo(seqs, 1), 0);
  assert.equal(countUpTo(seqs, 2), 1);
  assert.equal(countUpTo(seqs, 5), 3);
  assert.equal(countUpTo(seqs, 8), 3);
  assert.equal(countUpTo(seqs, 1000), 5);
  assert.equal(countUpTo([], 4), 0);
});

test("keyframeAt returns the last keyframe at or before a seq", () => {
  const inspect = payload();
  assert.equal(keyframeAt(inspect, null).seq, 30);
  assert.equal(keyframeAt(inspect, 29).seq, 5);
  assert.equal(keyframeAt(inspect, 5).seq, 5);
  assert.equal(keyframeAt(inspect, 4).seq, 1);
  assert.equal(keyframeAt(inspect, 0), null);
  assert.equal(keyframeAt({ keyframes: [] }, null), null);
  assert.equal(keyframeAt(null, 3), null);
});

test("eventAt finds the event the scrubber is on", () => {
  const inspect = payload();
  assert.equal(eventAt(inspect, 19).type, "candidates_update");
  assert.equal(eventAt(inspect, 19).seq, 5);
  assert.equal(eventAt(inspect, null).type, "final_submission");
  assert.equal(eventAt(inspect, 0), null);
  assert.equal(eventAt({}, 3), null);
});

test("staleCount is how far the tile is ahead of the loaded payload", () => {
  assert.equal(staleCount({ last_seq: 30 }, { last_seq: 37 }), 7);
  assert.equal(staleCount({ last_seq: 30 }, { last_seq: 30 }), 0);
  assert.equal(staleCount({ last_seq: 30 }, { last_seq: 12 }), 0);
  assert.equal(staleCount({ last_seq: 30 }, null), 0);
  assert.equal(staleCount(null, { last_seq: 3 }), 0);
});

// ---------------------------------------------------------------- small formats

test("fmtLatency reads in the unit an operator would say", () => {
  assert.equal(fmtLatency(812), "812 ms");
  assert.equal(fmtLatency(3249), "3.2 s");
  assert.equal(fmtLatency(15227), "15 s");
  assert.equal(fmtLatency(72000), "1 min 12 s");
  assert.equal(fmtLatency(307000), "5 min 07 s");
  assert.equal(fmtLatency(null), "–");
  assert.equal(fmtLatency(-1), "–");
  assert.equal(fmtLatency("12"), "–");
});

test("fmtPayload counts decimal megabytes, as the 24 MB limit does", () => {
  assert.equal(fmtPayload(16257844), "16.3 MB");
  assert.equal(fmtPayload(293512), "0.29 MB");
  assert.equal(fmtPayload(24000000), "24.0 MB");
  assert.equal(fmtPayload(null), "–");
});

test("fmtDeg and fmtMoment", () => {
  assert.equal(fmtDeg(273), "273°");
  assert.equal(fmtDeg(-7.46), "-7.5°");
  assert.equal(fmtDeg(null), "–");
  assert.equal(fmtMoment(123), "02:03");
  assert.equal(fmtMoment(null), "–");
});

test("stopReasonText puts the known reasons in words and keeps the rest as logged", () => {
  assert.equal(stopReasonText("tool_use"), "called tools");
  assert.equal(stopReasonText("max_tokens"), "output limit reached");
  assert.equal(stopReasonText("something_new"), "something_new");
  assert.equal(stopReasonText(null), "");
});

// ---------------------------------------------------------------- turns

test("turnRows carries the request, the tokens and what belongs to the turn", () => {
  const rows = turnRows(payload());
  assert.equal(rows.length, 3);
  const [one, two, three] = rows;
  assert.deepEqual([one.turn, one.seq, one.seqResponse, one.messages, one.images, one.imagesAdded], [1, 2, 3, 1, 2, 2]);
  assert.deepEqual(one.tokens, { input: 40000, cached: 0, output: 500, reasoning: 200 });
  assert.equal(one.calls, 2);
  assert.equal(one.views, 2);
  assert.equal(one.pending, false);
  assert.equal(two.calls, 3);
  assert.equal(two.retries.length, 1);
  assert.deepEqual(two.retries[0], { seq: 11, t_rel_s: 21, message: "rate limited", delayS: 2, attempt: 1, statusCode: 429 });
  assert.equal(three.tokens, null);
  assert.equal(three.pending, true);
  assert.equal(three.calls, 1);
  assert.notEqual(one.key, two.key);
});

test("turnRows survives a damaged payload and marks a new conversation", () => {
  assert.deepEqual(turnRows(null), []);
  assert.deepEqual(turnRows({ turns: "no" }), []);
  const rows = turnRows({
    turns: [
      { turn: 1, segment: 1, seq_request: 2, seq_response: 3, tokens: { input: 5 }, error: null },
      { turn: 2, segment: 1, seq_request: 6, seq_response: null, error: "HTTP 500" },
      { turn: 1, segment: 2, seq_request: 20, seq_response: 21, tokens: {}, retries: [{}] },
    ],
  });
  assert.equal(rows[0].tokens.cached, 0);
  assert.equal(rows[1].error, "HTTP 500");
  assert.equal(rows[1].pending, false);
  assert.equal(rows[2].newSegment, true);
  assert.equal(rows[0].newSegment, false);
  assert.notEqual(rows[0].key, rows[2].key);
  assert.equal(rows[2].retries[0].message, "the request failed");
});

test("turnTotals sums the answered turns and names the dearest and slowest", () => {
  const rows = turnRows(payload());
  const totals = turnTotals(rows);
  assert.equal(totals.turns, 3);
  assert.equal(totals.answered, 2);
  assert.equal(totals.input, 82000);
  assert.equal(totals.cached, 40000);
  assert.equal(totals.output, 800);
  assert.equal(totals.reasoning, 300);
  assert.ok(Math.abs(totals.costUsd - 0.12) < 1e-9);
  assert.equal(totals.latencyMs, 16000);
  assert.equal(totals.meanLatencyMs, 8000);
  assert.equal(totals.retries, 1);
  assert.equal(totals.errors, 0);
  assert.equal(totals.slowest, 0);
  assert.equal(totals.dearest, 0);
  assert.ok(Math.abs(totals.cachedShare - 40000 / 82000) < 1e-9);
  const none = turnTotals([]);
  assert.equal(none.turns, 0);
  assert.equal(none.cachedShare, null);
  assert.equal(none.meanLatencyMs, null);
});

test("turnIndexAt is the turn in progress at the cursor", () => {
  const rows = turnRows(payload());
  assert.equal(turnIndexAt(rows, null), 2);
  assert.equal(turnIndexAt(rows, 1), -1);
  assert.equal(turnIndexAt(rows, 2), 0);
  assert.equal(turnIndexAt(rows, 9), 0);
  assert.equal(turnIndexAt(rows, 10), 1);
  assert.equal(turnIndexAt(rows, 99), 2);
});

test("turnBars gives cost and latency in seconds, and tells conversations apart", () => {
  const bars = turnBars(turnRows(payload()));
  assert.deepEqual(bars[0], { label: "1", value: 0.11, value2: 15.2 });
  assert.deepEqual(bars[2], { label: "3", value: 0, value2: 0 });
  assert.deepEqual(turnBars([]), []);
  const retried = turnBars(turnRows({ turns: [{ turn: 1, segment: 1, seq_request: 1 }, { turn: 1, segment: 2, seq_request: 9 }] }));
  assert.deepEqual(retried.map((bar) => bar.label), ["1.1", "2.1"]);
});

test("requestText says what one request carried", () => {
  const rows = turnRows(payload());
  assert.equal(requestText(rows[0]), "1 message, 2 images (2 new), 2.50 MB");
  assert.equal(requestText(rows[2]), "5 messages, 4 images, 3.90 MB");
  assert.equal(requestText({ messages: null, images: null, payloadChars: null }), "–");
});

// ---------------------------------------------------------------- tools

test("inputSummary writes one line per kind of call", () => {
  assert.equal(inputSummary("view_crop", { yaw: 273, pitch: -7, fov: 20, enhance: true }), "yaw 273°, pitch -7°, fov 20°");
  assert.equal(inputSummary("search_places", { query: "Bica da Cana Madeira" }), "Bica da Cana Madeira");
  assert.equal(inputSummary("satellite_tile", { lat: 32.7556, lng: -17.056, zoom: 17 }), "32.755600, -17.056000, zoom 17");
  assert.equal(inputSummary("streetview_lookup", { lat: 1, lng: 2, radius_m: 250, headings: [0, 270] }), "1.000000, 2.000000, within 250 m, headings 0, 270");
  assert.equal(inputSummary("update_candidates", { hypotheses: [{ label: "A", probability: 0.2 }, { label: "B", probability: 0.7 }] }), "2 hypotheses: B");
  assert.equal(inputSummary("ask_multiple_choice", { question: "Which square?" }), "Which square?");
  assert.equal(inputSummary("unknown_tool", { a: 1 }), '{"a":1}');
  assert.equal(inputSummary("unknown_tool", null), "");
  assert.equal(inputSummary("unknown_tool", "plain   text"), "plain text");
  assert.equal(inputSummary("search_places", { query: "x".repeat(400) }).length, 160);
});

test("toolRows keeps every call apart, hosted searches included", () => {
  const rows = toolRows(payload());
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((row) => row.key)).size, 6);
  const crop = rows[0];
  assert.equal(crop.tool, "view_crop");
  assert.equal(crop.cropN, 1);
  assert.equal(crop.comparable, false);
  assert.equal(crop.pending, false);
  assert.equal(crop.summary, "yaw 273°, pitch -7°, fov 20°");
  assert.equal(rows[1].isError, true);
  // in the order the calls were made, whatever order the payload lists them in
  assert.deepEqual(rows.map((row) => row.seq), [4, 7, 12, 12, 13, 26]);
  assert.deepEqual(rows.map((row) => row.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(rows[2].hosted, true);
  assert.equal(rows[2].summary, "Bica da Cana road");
  assert.equal(rows[3].summary, "Paul da Serra fence");
  const street = rows[4];
  assert.equal(street.comparable, true);
  assert.equal(street.cacheHit, true);
  assert.equal(street.images.length, 2);
  assert.equal(street.cropN, null);
  assert.equal(rows[5].pending, true);
  assert.deepEqual(toolRows(null), []);
  assert.deepEqual(toolRows({ tools: [null, "x"] }), []);
});

test("toolRows drops what is not a URL string or an image with a hash", () => {
  const [row] = toolRows({ tools: [{ seq_call: 3, tool: "satellite_tile", urls: ["https://a", 7, ""], images: [{ sha256: sha("f") }, { nope: 1 }, null] }] });
  assert.deepEqual(row.urls, ["https://a"]);
  assert.equal(row.images.length, 1);
  assert.equal(row.comparable, true);
});

test("toolNames lists the tools by use", () => {
  assert.deepEqual(toolNames(toolRows(payload())), [
    { name: "view_crop", count: 2 },
    { name: "web_search", count: 2 },
    { name: "search_places", count: 1 },
    { name: "streetview_lookup", count: 1 },
  ]);
});

test("filterTools narrows by tool, turn, words, errors and cache hits", () => {
  const rows = toolRows(payload());
  assert.equal(filterTools(rows).length, 6);
  assert.equal(filterTools(rows, { tool: "view_crop" }).length, 2);
  assert.equal(filterTools(rows, { turn: rows[2].turnKey }).length, 3);
  assert.deepEqual(filterTools(rows, { turn: rows[2].turnKey }).map((row) => row.tool), ["web_search", "web_search", "streetview_lookup"]);
  assert.equal(filterTools(rows, { errors: true }).length, 1);
  assert.equal(filterTools(rows, { cached: true }).length, 1);
  assert.equal(filterTools(rows, { text: "estanquinhos" })[0].tool, "search_places");
  assert.equal(filterTools(rows, { text: "googleapis streetview" }).length, 1);
  assert.equal(filterTools(rows, { text: "PAUL  serra" }).length, 1);
  assert.equal(filterTools(rows, { text: "between 0 and 360" }).length, 1);
  assert.equal(filterTools(rows, { text: "no such words" }).length, 0);
  assert.equal(filterTools(rows, { tool: "view_crop", errors: true, text: "yaw" }).length, 1);
});

test("toolIndexAt is the last call made by the cursor", () => {
  const rows = toolRows(payload());
  assert.equal(toolIndexAt(rows, null), 5);
  assert.equal(toolIndexAt(rows, 3), -1);
  assert.equal(toolIndexAt(rows, 4), 0);
  assert.equal(toolIndexAt(rows, 12), 3);
});

test("parseOutput draws JSON as a tree and text as text", () => {
  assert.deepEqual(parseOutput(null), { kind: "none" });
  assert.deepEqual(parseOutput("   "), { kind: "none" });
  assert.deepEqual(parseOutput("null"), { kind: "none" });
  assert.deepEqual(parseOutput({ a: 1 }), { kind: "json", value: { a: 1 } });
  assert.deepEqual(parseOutput('{"elements": [1, 2]}'), { kind: "json", value: { elements: [1, 2] } });
  assert.deepEqual(parseOutput("[1]"), { kind: "json", value: [1] });
  assert.deepEqual(parseOutput('"quoted text"'), { kind: "text", text: "quoted text", clipped: false });
  assert.deepEqual(parseOutput("View centred on yaw 273.0"), { kind: "text", text: "View centred on yaw 273.0", clipped: false });
  assert.deepEqual(parseOutput("42"), { kind: "text", text: "42", clipped: false });
  assert.deepEqual(parseOutput(7), { kind: "text", text: "7", clipped: false });
});

test("parseOutput recovers a string the log cut short, escapes included", () => {
  assert.deepEqual(parseOutput('"a long answer that was cu…'), { kind: "text", text: "a long answer that was cu…", clipped: true });
  assert.deepEqual(parseOutput('"line one\\nline tw…'), { kind: "text", text: "line one\nline tw…", clipped: true });
  assert.deepEqual(parseOutput('"ends in a slash\\…'), { kind: "text", text: "ends in a slash…", clipped: true });
  assert.deepEqual(parseOutput('"half an escape \\u00…'), { kind: "text", text: "half an escape …", clipped: true });
  // cut JSON that is not a string stays as the text the log holds
  const cut = parseOutput('{"elements": [{"id": 1}, {"id…');
  assert.equal(cut.kind, "text");
  assert.equal(cut.clipped, true);
  assert.equal(parseOutput("plain text that ends…").clipped, true);
});

// ---------------------------------------------------------------- crops and views

test("cropNumbers takes the payload's numbers and lets a tile that is ahead add its own", () => {
  const inspect = payload();
  assert.deepEqual([...cropNumbers(inspect, null)], [[4, 1], [7, 2]]);
  const ahead = cropNumbers(inspect, { crops: [{ n: 1, seq_call: 4 }, { n: 3, seq_call: 40 }] });
  assert.equal(ahead.get(40), 3);
  assert.equal(ahead.get(7), 2);
});

test("cropNumbers rebuilds the numbering for a payload without it: failed crops keep their number", () => {
  const inspect = payload();
  for (const tool of inspect.tools) delete tool.crop_n;
  inspect.tools.push({ seq_call: 28, tool: "view_crop", is_error: false, images: [{ sha256: sha("9") }] });
  const numbers = cropNumbers(inspect, null);
  assert.equal(numbers.get(4), 1);
  assert.equal(numbers.has(7), false); // the failed crop has no footprint, but used number 2
  assert.equal(numbers.get(28), 3);
});

test("galleryRows fills in what only the tool call knows", () => {
  const rows = galleryRows(payload(), null);
  assert.equal(rows.length, 4);
  assert.deepEqual([rows[0].n, rows[0].source, rows[0].sourceText, rows[0].cropN], [1, "initial", "initial view", null]);
  const crop = rows[2];
  assert.deepEqual([crop.yaw, crop.pitch, crop.fov, crop.cropN, crop.estTokens], [273, -7, 20, 1, 581]);
  const street = rows[3];
  assert.deepEqual([street.width, street.height], [640, 640]);
  assert.equal(street.origin, "Google Street View, heading 0°");
  assert.equal(street.estTokens, null);
  assert.equal(new Set(rows.map((row) => row.key)).size, 4);
  assert.deepEqual(galleryRows({ images: [{ nope: true }, null] }, null), []);
  assert.deepEqual(galleryRows(null, null), []);
});

test("gallery sources, filter and totals", () => {
  const rows = galleryRows(payload(), null);
  assert.deepEqual(gallerySources(rows), [
    { source: "initial", label: "initial view", count: 2 },
    { source: "view_crop", label: "crop", count: 1 },
    { source: "streetview_lookup", label: "street-level", count: 1 },
  ]);
  assert.equal(filterGallery(rows, { source: "initial" }).length, 2);
  assert.equal(filterGallery(rows, { turn: rows[2].turnKey }).length, 1);
  assert.equal(filterGallery(rows, { source: "initial", turn: rows[2].turnKey }).length, 0);
  assert.deepEqual(galleryTotals(rows), { count: 4, tokens: 2419 + 2540 + 581, chars: 793512, unknownTokens: 1 });
  assert.equal(sourceLabel("satellite_tile"), "satellite");
  assert.equal(sourceLabel("some_new_tool"), "some_new_tool");
  assert.equal(sourceLabel(""), "view");
});

test("viewCaption is the lightbox caption", () => {
  const rows = galleryRows(payload(), null);
  assert.equal(viewCaption(rows[2]), "#3 · crop 1 · yaw 273° · pitch -7° · FOV 20° · 682 × 682 px · about 581 tokens");
  assert.equal(viewCaption(rows[0]), "#1 · initial view · 2000 × 1000 px · about 2,419 tokens");
  assert.equal(viewCaption(rows[3]), "#4 · street-level · Google Street View, heading 0° · 640 × 640 px");
});

test("anglesText and aimText say where a view points", () => {
  const rows = galleryRows(payload(), null);
  assert.equal(anglesText(rows[2]), "yaw 273° · pitch -7° · FOV 20°");
  assert.equal(anglesText(rows[0]), "");
  assert.equal(aimText(rows[2]), "yaw 273° · pitch -7° · FOV 20°");
  assert.equal(aimText(rows[0]), "the whole panorama, no angles");
  assert.equal(aimText(rows[3]), "Google Street View, heading 0°");
  assert.equal(aimText({ yaw: null, pitch: null, fov: null, origin: "", source: "satellite_tile" }), "angles not recorded");
});

test("imageOrigin names where a returned image came from", () => {
  assert.equal(imageOrigin({ source: "esri_world_imagery" }), "Esri World Imagery");
  assert.equal(imageOrigin({ source: "mapillary", heading: 244.6 }), "Mapillary, heading 244.6°");
  assert.equal(imageOrigin({ source: "other" }), "other");
  assert.equal(imageOrigin({}), "");
  assert.equal(imageOrigin(null), "");
});

test("panoramaViews lists the overview and every successful crop", () => {
  const views = panoramaViews(payload(), null);
  assert.deepEqual(views.map((view) => view.key), ["i1", "i2", "c4"]);
  assert.equal(views[0].label, "Overview (2000 × 1000 px)");
  assert.equal(views[1].label, "Initial view 2 (1456 × 1456 px)");
  assert.equal(views[2].label, "Crop 1: yaw 273°, pitch -7°, FOV 20°");
  assert.equal(views[2].cropN, 1);
  assert.deepEqual(panoramaViews(null, null), []);
});

test("defaultComparison picks the crop requested just before the call", () => {
  const inspect = payload();
  inspect.tools.push({
    seq_call: 22, seq_result: 23, turn: 2, tool: "view_crop", crop_n: 3, is_error: false,
    images: [{ sha256: sha("7"), yaw: 10, pitch: 0, fov: 30, width: 500, height: 500 }],
  });
  const views = panoramaViews(inspect, null);
  assert.equal(defaultComparison(views, { seq: 13 }).key, "c4");
  assert.equal(defaultComparison(views, { seq: 26 }).key, "c22");
  // a lookup made before any crop gets the first crop; no crop at all, the overview
  assert.equal(defaultComparison(views, { seq: 3 }).key, "c4");
  assert.equal(defaultComparison(views.filter((view) => view.kind === "initial"), { seq: 13 }).key, "i1");
  assert.equal(defaultComparison([], { seq: 13 }), null);
});

// ---------------------------------------------------------------- image budget

test("budgetMeters reports images of 80 and megabytes of 24", () => {
  const [count, bytes] = budgetMeters({ count: 74, max_count: 80, payload_chars: 16257844, max_payload_chars: 24000000 });
  assert.equal(count.text, "74 of 80");
  assert.equal(count.level, "warn");
  assert.equal(count.state, "near the limit");
  assert.equal(count.percent, "92%");
  assert.ok(Math.abs(count.share - 0.925) < 1e-9);
  assert.equal(bytes.text, "16.3 of 24 MB");
  assert.equal(bytes.level, "ok");
  assert.equal(bytes.state, "within the limit");
});

test("budgetMeters at the limit, and with nothing known", () => {
  const [full] = budgetMeters({ count: 85, max_count: 80, payload_chars: 0, max_payload_chars: 24000000 });
  assert.equal(full.level, "bad");
  assert.equal(full.share, 1);
  assert.match(full.state, /^at the limit/);
  assert.equal(full.percent, "100%");
  // just short of the limit never reads as 100%
  const [, nearly] = budgetMeters({ count: 1, max_count: 80, payload_chars: 23900000, max_payload_chars: 24000000 });
  assert.equal(nearly.percent, "99%");
  assert.equal(nearly.level, "warn");
  assert.equal(budgetMeters({ count: 40, max_count: 80 })[0].percent, "50%");
  const [count, bytes] = budgetMeters(null);
  assert.equal(count.text, "0");
  assert.equal(count.share, null);
  assert.equal(count.percent, "");
  assert.equal(count.level, "ok");
  assert.equal(bytes.text, "0.0 MB");
});

// ---------------------------------------------------------------- penalty ledger

const LEDGER = [
  { seq: 18, ts: "2026-10-10T21:10:20.708Z", t_rel_s: 7.274, kind: "mcq", before: 1.0, after: 0.95 },
  { seq: 19, ts: "2026-10-10T21:10:36.761Z", t_rel_s: 23.326, kind: "cue", before: 0.95, after: 0.76 },
  { seq: 40, ts: "2026-10-10T21:12:00.000Z", t_rel_s: 110, kind: "geocode", before: 0.76, after: 0.38 },
];

test("ledgerRows gives each charge its factor and the running product", () => {
  const rows = ledgerRows(LEDGER);
  assert.deepEqual(rows.map((row) => row.label), ["MCQ asked", "Cue", "Last-resort geocode"]);
  assert.deepEqual(rows.map((row) => row.factor), [0.95, 0.8, 0.5]);
  assert.deepEqual(rows.map((row) => row.after), [0.95, 0.76, 0.38]);
  assert.equal(rows[0].product, "0.95 MCQ = x0.95");
  assert.equal(rows[1].product, "0.95 MCQ x 0.8 cue = x0.76");
  assert.equal(rows[2].product, "0.95 MCQ x 0.8 cue x 0.5 geocode = x0.38");
  assert.equal(new Set(rows.map((row) => row.key)).size, 3);
});

test("ledgerRows accepts a damaged ledger", () => {
  assert.deepEqual(ledgerRows(null), []);
  const rows = ledgerRows([null, { kind: "bonus", before: 0, after: 0.5 }, { seq: 4 }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, "bonus");
  assert.equal(rows[0].factor, null);
  assert.equal(rows[1].label, "charge");
  assert.equal(rows[1].after, null);
});

test("ledgerSummary writes the multiplier out, now and at the cursor", () => {
  const rows = ledgerRows(LEDGER);
  assert.deepEqual(ledgerSummary([], null), { count: 0, multiplier: 1, text: "No penalties: x1.0" });
  assert.deepEqual(ledgerSummary(rows, null), { count: 3, multiplier: 0.38, text: "x0.38 = 0.95 MCQ x 0.8 cue x 0.5 geocode" });
  assert.deepEqual(ledgerSummary(rows, 19), { count: 2, multiplier: 0.76, text: "x0.76 = 0.95 MCQ x 0.8 cue" });
  assert.deepEqual(ledgerSummary(rows, 17), { count: 0, multiplier: 1, text: "No penalties: x1.0" });
});

// ---------------------------------------------------------------- run facts

test("flagRows puts the flags in words and keeps unknown ones", () => {
  const rows = flagRows({ ...payload().facts.flags, disabled_tools: ["web_search", "overpass_query"], new_flag: { a: 1 } });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey.allow_web, "on");
  assert.equal(byKey.no_human, "off: autonomous");
  assert.equal(byKey.hedge, "off: best point repeated");
  assert.equal(byKey.allow_duplicates, "allowed");
  assert.equal(byKey.penalty_scope, "whole_list");
  assert.equal(byKey.max_mcq, "3");
  assert.equal(byKey.disabled_tools, "web_search, overpass_query");
  assert.equal(byKey.new_flag, '{"a":1}');
  assert.equal(flagRows({ no_human: false })[0].value, "on: MCQ, cue and geocode available");
  assert.deepEqual(flagRows(null), []);
});

test("budgetRows writes the budget of the panorama", () => {
  assert.deepEqual(budgetRows(payload().facts.budget).map((row) => row.label + " " + row.value), [
    "Effort high", "Soft deadline 10:00", "Hard deadline 14:00", "Turn limit 30", "Spend cap $8.00",
  ]);
  assert.deepEqual(budgetRows(null), []);
});

test("provenanceRows says where label, timestamp and Special One came from", () => {
  const facts = {
    ...payload().facts,
    label: "Urban",
    capture_timestamp: null,
    special: true,
    provenance: {
      filename: "street_a.jpg",
      label: { value: "Urban", source: "folder", parsed: "Urban" },
      timestamp: { value: null, source: "none", parsed: null },
      special: { value: true, source: "operator", parsed: false },
    },
  };
  const [label, timestamp, special] = provenanceRows(facts);
  assert.deepEqual([label.value, label.source, label.recorded, label.parsed], ["Urban", "taken from the directory name", true, null]);
  assert.deepEqual([timestamp.value, timestamp.source], ["none", "not found in the files"]);
  assert.deepEqual([special.value, special.source, special.parsed], ["yes: score x3", "set by the operator before launch", "no"]);
});

test("provenanceRows shows the logged values when a command-line run recorded no source", () => {
  const [label, timestamp, special] = provenanceRows(payload().facts);
  assert.deepEqual([label.value, label.source, label.recorded], ["non-Urban", "not recorded", false]);
  assert.equal(timestamp.value, "20200610133716");
  assert.equal(special.value, "no");
  assert.equal(provenanceRows(null).length, 3);
});

test("sourceWords knows every source the loader writes", () => {
  for (const source of ["folder", "filename", "sidecar", "manifest", "operator", "operator_bulk", "default", "none"]) {
    assert.notEqual(sourceWords(source), source, source);
  }
  assert.equal(sourceWords("something_else"), "something_else");
  assert.equal(sourceWords(null), "not recorded");
});

test("toolsText is the logged list, and toolDefinitionNames its names", () => {
  const facts = payload().facts;
  assert.deepEqual(JSON.parse(toolsText(facts)), facts.tools);
  assert.deepEqual(toolDefinitionNames(facts), ["view_crop", "web_search"]);
  assert.deepEqual(toolDefinitionNames({ tools: [{ function: { name: "nested" } }, null] }), ["nested"]);
  assert.equal(toolsText({ tools: null }), "");
  assert.equal(toolsText(null), "");
});

// ---------------------------------------------------------------- downloads

test("downloadItems are the app's own three endpoints", () => {
  const items = downloadItems("run 1", "pano/1", payload());
  assert.deepEqual(items.map((item) => item.what), ["export", "events", "images"]);
  assert.deepEqual(items.map((item) => item.href), [
    "/api/runs/run%201/pano/pano%2F1/download?what=export",
    "/api/runs/run%201/pano/pano%2F1/download?what=events",
    "/api/runs/run%201/pano/pano%2F1/download?what=images",
  ]);
  assert.ok(items.every((item) => item.disabled === null));
  assert.ok(items.every((item) => item.href.startsWith("/api/")));
});

test("downloadItems says why a file cannot exist yet", () => {
  const items = downloadItems("run1", "pano_1", { timeline: [], images: [] });
  assert.equal(items[0].disabled, null);
  assert.match(items[1].disabled, /event log/);
  assert.match(items[2].disabled, /no images/);
  // nothing loaded yet: nothing is known, so nothing is refused
  assert.ok(downloadItems("run1", "pano_1", null).every((item) => item.disabled === null));
});

test("downloadName matches the names the server gives the files", () => {
  assert.equal(downloadName("run1", "pano_1", "export"), "pano_1.json");
  assert.equal(downloadName("run1", "pano_1", "events"), "pano_1.events.jsonl");
  assert.equal(downloadName("run1", "pano_1", "images"), "run1_pano_1_images.zip");
  assert.equal(downloadName("run1", "../x y", "export"), ".._x_y.json");
});

// ---------------------------------------------------------------- ground truth

const TRUTH = {
  run_id: "run1",
  tag: "",
  panoramas: {
    pano_1: {
      lat: 32.765, lng: -17.0818, label: "non-Urban",
      entries: [
        ...[1, 2, 3, 4, 5, 6].map((rank) => ({ rank, lat: 32.76498, lng: -17.08182, distance_m: 9.1, theta: 2.0 })),
        ...[7, 8, 9].map((rank) => ({ rank, lat: 32.8, lng: -17.1, distance_m: 4200, theta: 1.408451 })),
        { rank: 10, lat: 32.76498, lng: -17.08182, distance_m: 9.1, theta: 2.0 },
      ],
      rank1_distance_m: 9.1, score: 15000.5, max_score: 16050.52, share: 0.934581, band: "100m",
      top_distance_series: [
        { seq: 5, t_rel_s: 16, distance_m: 1703.1 },
        { seq: 20, t_rel_s: 60, distance_m: 310.4 },
        { seq: 29, t_rel_s: 95, distance_m: 9.1 },
      ],
    },
  },
};

test("truthAllowed refuses truth beside a human channel", () => {
  assert.equal(truthAllowed({ kind: "eval", no_human: true }, { human_enabled: false }), true);
  assert.equal(truthAllowed({ kind: "eval", no_human: false }, null), false);
  assert.equal(truthAllowed({ kind: "eval", no_human: true }, { human_enabled: true }), false);
  assert.equal(truthAllowed({ kind: "scoring", no_human: true }, null), false);
  assert.equal(truthAllowed({ kind: "training", no_human: true }, null), false);
  // nothing known about the run: the server's answer stands
  assert.equal(truthAllowed(null, null), true);
});

test("truthFor picks this panorama's entry", () => {
  assert.equal(truthFor(TRUTH, "pano_1").label, "non-Urban");
  assert.equal(truthFor(TRUTH, "pano_2"), null);
  assert.equal(truthFor(null, "pano_1"), null);
  assert.equal(truthFor({ lat: 1, lng: 2 }, "pano_1").lat, 1);
  assert.equal(truthFor({ panoramas: { pano_1: "broken" } }, "pano_1"), null);
});

test("rankText folds runs of ranks", () => {
  assert.equal(rankText([1, 2, 3, 7]), "1–3, 7");
  assert.equal(rankText([10, 1, 2, 3, 4, 5, 6]), "1–6, 10");
  assert.equal(rankText([4]), "4");
  assert.equal(rankText([2, 2, 3]), "2–3");
  assert.equal(rankText([]), "");
});

test("distinctAnswers collapses the list to its points", () => {
  const answers = distinctAnswers(TRUTH.panoramas.pano_1.entries);
  assert.equal(answers.length, 2);
  assert.deepEqual([answers[0].rankText, answers[0].distanceM, answers[0].theta], ["1–6, 10", 9.1, 2]);
  assert.deepEqual([answers[1].rankText, answers[1].distanceM], ["7–9", 4200]);
  assert.deepEqual(distinctAnswers(null), []);
  assert.deepEqual(distinctAnswers([{ lat: "x", lng: 1 }, null]), []);
});

test("truthStats are the headline numbers", () => {
  const stats = truthStats(TRUTH.panoramas.pano_1);
  assert.equal(stats.rank1DistanceM, 9.1);
  assert.equal(stats.score, 15000.5);
  assert.equal(stats.maxScore, 16050.52);
  assert.equal(stats.share, 0.934581);
  assert.equal(stats.bandText, "within 100 m");
  assert.equal(stats.distinct, 2);
  assert.equal(stats.entries, 10);
  assert.equal(stats.nearest.rankText, "1–6, 10");
  const none = truthStats(null);
  assert.equal(none.rank1DistanceM, null);
  assert.equal(none.nearest, null);
  assert.equal(none.entries, 0);
});

test("truthChart plots distance against run time and maps the cursor both ways", () => {
  const plan = truthChart(TRUTH.panoramas.pano_1, payload());
  assert.equal(plan.axis, "time");
  assert.deepEqual(plan.points, [[16, 1703.1], [60, 310.4], [95, 9.1]]);
  assert.equal(plan.log, true);
  // the cursor sits at the time of the event it is on
  assert.equal(plan.xAt(20), 60);
  assert.equal(plan.xAt(25), 60);
  assert.equal(plan.xAt(30), 95.5);
  assert.equal(plan.xAt(null), null);
  assert.equal(plan.seqAt(58), 20);
  assert.equal(plan.seqAt(0), 5);
  assert.equal(plan.seqAt(null), null);
});

test("truthChart falls back to the event number after a retry reset the clock", () => {
  const entry = { top_distance_series: [{ seq: 5, t_rel_s: 50, distance_m: 900 }, { seq: 40, t_rel_s: 3, distance_m: 700 }] };
  const plan = truthChart(entry, { ...payload(), segments: 2 });
  assert.equal(plan.axis, "seq");
  assert.deepEqual(plan.points, [[5, 900], [40, 700]]);
  assert.equal(plan.log, false);
  assert.equal(plan.xAt(12), 12);
  assert.equal(plan.seqAt(30), 40);
});

test("truthChart with no hypotheses has nothing to draw", () => {
  const plan = truthChart({ top_distance_series: [] }, payload());
  assert.deepEqual(plan.points, []);
  assert.equal(plan.xAt(5), null);
  assert.equal(plan.seqAt(5), null);
  assert.deepEqual(truthChart(null, null).points, []);
});

// ---------------------------------------------------------------- screens/focus/data.js

// The loader of the payload has no DOM in it, so it is exercised here with a stand-in fetch.
const data = await import("../../server/static/console/js/screens/focus/data.js");

// A fetch that answers when told to, and rejects like the real one when its request is aborted.
function fakeServer() {
  const server = { calls: [], pending: [] };
  server.fetch = (url, init = {}) => {
    server.calls.push(String(url));
    return new Promise((resolve, reject) => {
      if (init.signal) {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }
      server.pending.push((body, status = 200) => resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
    });
  };
  server.answer = (body, status) => server.pending.shift()(body, status);
  return server;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

async function withServer(run) {
  const real = globalThis.fetch;
  const server = fakeServer();
  globalThis.fetch = server.fetch;
  data.forgetInspect();
  try {
    await run(server);
  } finally {
    globalThis.fetch = real;
    data.forgetInspect();
  }
}

test("loadInspect shares a request in flight and keeps the last answer", async () => {
  await withServer(async (server) => {
    const first = data.loadInspect("run 1", "pano_1");
    const second = data.loadInspect("run 1", "pano_1");
    await tick();
    assert.deepEqual(server.calls, ["/api/runs/run%201/pano/pano_1/inspect"]);
    assert.equal(data.cachedInspect("run 1", "pano_1"), null);
    server.answer({ last_seq: 5, keyframes: [{ seq: 2 }] });
    assert.equal((await first).last_seq, 5);
    assert.equal(await second, await first);
    assert.equal((await data.loadInspect("run 1", "pano_1")).last_seq, 5);
    assert.equal(data.cachedInspect("run 1", "pano_1").last_seq, 5);
    assert.equal(server.calls.length, 1);
    // another panorama is another request
    const other = data.loadInspect("run 1", "pano_2");
    await tick();
    server.answer({ last_seq: 1 });
    assert.equal((await other).last_seq, 1);
    assert.equal(server.calls.length, 2);
    assert.equal(data.keyframeAt(await first, null).seq, 2);
  });
});

test("loadInspect with force fetches again, after the request already in flight", async () => {
  await withServer(async (server) => {
    const stale = data.loadInspect("run1", "pano_1");
    await tick();
    const forced = data.loadInspect("run1", "pano_1", { force: true });
    const forcedToo = data.loadInspect("run1", "pano_1", { force: true });
    await tick();
    assert.equal(server.calls.length, 1); // the forced reload waits its turn
    server.answer({ last_seq: 5 });
    await tick();
    assert.equal(server.calls.length, 2);
    server.answer({ last_seq: 9 });
    assert.equal((await stale).last_seq, 5);
    assert.equal((await forced).last_seq, 9);
    assert.equal((await forcedToo).last_seq, 9);
    assert.equal(server.calls.length, 2);
    assert.equal((await data.loadInspect("run1", "pano_1")).last_seq, 9);
  });
});

test("loadInspect: a caller that leaves does not take the others with it", async () => {
  await withServer(async (server) => {
    const leaving = new AbortController();
    const left = data.loadInspect("run1", "pano_1", { signal: leaving.signal });
    const stays = data.loadInspect("run1", "pano_1");
    await tick();
    leaving.abort();
    await assert.rejects(left, { name: "AbortError" });
    server.answer({ last_seq: 3 });
    assert.equal((await stays).last_seq, 3);
    assert.equal(server.calls.length, 1);
  });
});

test("loadInspect: after the last caller left, the next one gets a request of its own", async () => {
  await withServer(async (server) => {
    const leaving = new AbortController();
    const left = data.loadInspect("run1", "pano_1", { signal: leaving.signal });
    await tick();
    leaving.abort();
    // same tick as the abort, as on a remount of the screen
    const again = data.loadInspect("run1", "pano_1");
    await assert.rejects(left, { name: "AbortError" });
    await tick();
    assert.equal(server.calls.length, 2);
    server.pending.pop()({ last_seq: 7 });
    assert.equal((await again).last_seq, 7);
    const dead = new AbortController();
    dead.abort();
    await assert.rejects(data.loadInspect("run1", "pano_9", { signal: dead.signal }), { name: "AbortError" });
    assert.equal(server.calls.length, 2);
  });
});

test("loadInspect reports a refusal and does not keep it", async () => {
  await withServer(async (server) => {
    const failed = data.loadInspect("run1", "nope");
    await tick();
    server.answer({ detail: { message: "Run run1 has no panorama nope.", code: "unknown_panorama" } }, 404);
    await assert.rejects(failed, (error) => error.status === 404 && /no panorama nope/.test(error.message));
    const retry = data.loadInspect("run1", "nope");
    await tick();
    assert.equal(server.calls.length, 2);
    server.answer([1, 2, 3]); // not a payload
    await assert.rejects(retry, /cannot read/);
  });
});

test("loadTruth resolves null when truth is not available, and rejects on a real failure", async () => {
  await withServer(async (server) => {
    const refused = data.loadTruth("run1");
    await tick();
    assert.deepEqual(server.calls, ["/api/eval/runs/run1/truth"]);
    server.answer({ detail: { message: "Scores are shown only for an evaluation run.", code: "truth_not_allowed" } }, 403);
    assert.equal(await refused, null);
    const unknown = data.loadTruth("run2");
    await tick();
    server.answer({ detail: "Not Found" }, 404);
    assert.equal(await unknown, null);
    const broken = data.loadTruth("run3");
    await tick();
    server.answer({ detail: { message: "The manifest could not be read." } }, 500);
    await assert.rejects(broken, /manifest could not be read/);
    const good = data.loadTruth("run4");
    await tick();
    server.answer(TRUTH);
    assert.equal((await good).panoramas.pano_1.band, "100m");
    // reused for a short while, asked again on force
    assert.equal(await data.loadTruth("run4"), await good);
    assert.equal(server.calls.length, 4);
    const forced = data.loadTruth("run4", { force: true });
    await tick();
    assert.equal(server.calls.length, 5);
    server.answer({ nothing: true });
    assert.equal(await forced, null);
  });
});

test("fetchDownload hands over the file, or the server's reason", async () => {
  await withServer(async (server) => {
    const file = data.fetchDownload("run1", "pano_1", "events");
    await tick();
    assert.deepEqual(server.calls, ["/api/runs/run1/pano/pano_1/download?what=events"]);
    server.answer({ seq: 1 });
    const saved = await file;
    assert.equal(saved.filename, "pano_1.events.jsonl");
    assert.equal(await saved.blob.text(), '{"seq":1}');
    const refused = data.fetchDownload("run1", "pano_1", "export");
    await tick();
    server.answer({ detail: { message: "No export has been written for pano_1 yet. Use Rebuild exports on run run1, then download again.", code: "no_export", action: "rebuild" } }, 404);
    await assert.rejects(refused, (error) => error.status === 404 && error.code === "no_export" && /Rebuild exports/.test(error.message));
  });
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  try {
    await assert.rejects(data.fetchDownload("run1", "pano_1", "images"), (error) => error.status === 0 && /Cannot reach the server/.test(error.message));
  } finally {
    globalThis.fetch = real;
  }
});
