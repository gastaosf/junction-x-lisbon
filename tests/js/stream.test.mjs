import test from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORIES,
  anchorAt,
  buildOffsets,
  countAfter,
  countByCategory,
  coversRange,
  createStream,
  entryLabel,
  fmtMs,
  formatFilter,
  fullLines,
  imageCaption,
  indexAt,
  indexOfSeq,
  insertDigest,
  isLongLine,
  jsonKind,
  jsonSummary,
  matchesSearch,
  metaParts,
  normaliseDigest,
  parseFilter,
  searchNeedle,
  splitMatches,
  splitToolLine,
  typeLabel,
  viewUrl,
  visibleDigests,
  windowRange,
} from "../../server/static/console/js/components/stream.js";
import { store } from "../../server/static/console/js/store.js";

const SHA = "ab".repeat(32);

function digest(seq, extra = {}) {
  return {
    seq,
    ts: "2026-10-11T10:00:00Z",
    t_rel_s: seq * 2,
    actor: "agent",
    type: "model_response",
    multiplier: 1,
    turn: 1,
    category: "reasoning",
    lines: [{ kind: "thinking", text: "line of event " + seq, truncated: false }],
    images: [],
    tool: null,
    is_error: false,
    duration_ms: null,
    crop_n: null,
    ...extra,
  };
}

// ================================================================ labels

test("typeLabel names the known event types and words the unknown ones", () => {
  assert.equal(typeLabel("model_response"), "Agent");
  assert.equal(typeLabel("tool_call"), "Tool call");
  assert.equal(typeLabel("final_submission"), "Final answer");
  assert.equal(typeLabel("some_new_type"), "Some new type");
  assert.equal(typeLabel(""), "Event");
  assert.equal(typeLabel(null), "Event");
  assert.equal(typeLabel("constructor"), "Constructor", "an inherited property is not a label");
});

test("entryLabel spells out a failure, so red is never the only sign", () => {
  assert.equal(entryLabel(digest(1, { type: "tool_result", is_error: true })), "Tool error");
  assert.equal(entryLabel(digest(1, { type: "tool_result" })), "Result");
  assert.equal(entryLabel(digest(1, { type: "model_response", is_error: true })), "Agent refusal");
  assert.equal(entryLabel(digest(1, { type: "api_error", is_error: true })), "API error");
});

test("fmtMs and metaParts", () => {
  assert.equal(fmtMs(812), "812 ms");
  assert.equal(fmtMs(3210), "3.2 s");
  assert.equal(fmtMs(42000), "42 s");
  assert.equal(fmtMs(null), "");
  assert.equal(fmtMs("abc"), "");
  assert.deepEqual(metaParts(digest(1, { turn: 4, duration_ms: 812 })), ["turn 4", "812 ms"]);
  assert.deepEqual(metaParts(digest(1, { turn: null, duration_ms: null })), []);
});

// ================================================================ digests

test("normaliseDigest keeps what it can render and refuses what has no seq", () => {
  assert.equal(normaliseDigest(null), null);
  assert.equal(normaliseDigest({ lines: [] }), null);
  assert.equal(normaliseDigest({ seq: "x" }), null);
  assert.equal(normaliseDigest({ seq: 1.5 }), null);

  const clean = normaliseDigest({
    seq: "7",
    type: "tool_result",
    category: "<img onerror=x>",
    lines: [{ kind: "x y", text: 12 }, null, { kind: "error", text: "boom", truncated: 1 }],
    images: [SHA, { sha256: SHA, yaw: 10 }, 5],
    tool: "",
    crop_n: "3",
  });
  assert.equal(clean.seq, 7);
  assert.equal(clean.category, "harness", "a class name never comes from data");
  assert.deepEqual(clean.lines, [
    { kind: "harness", text: "12", truncated: false },
    { kind: "error", text: "boom", truncated: true },
  ]);
  assert.deepEqual(clean.images, [{ sha256: SHA }, { sha256: SHA, yaw: 10 }], "legacy digests list bare sha256 strings");
  assert.equal(clean.tool, null);
  assert.equal(clean.crop_n, 3);
  assert.equal(clean.is_error, false);
});

test("insertDigest keeps the list sorted and drops a seq it already has", () => {
  const list = [];
  assert.equal(insertDigest(list, digest(2)), 0);
  assert.equal(insertDigest(list, digest(5)), 1);
  assert.equal(insertDigest(list, digest(3)), 1, "a backlog event that arrives after a live one");
  assert.equal(insertDigest(list, digest(1)), 0);
  assert.equal(insertDigest(list, digest(3)), -1);
  assert.equal(insertDigest(list, digest(5)), -1);
  assert.deepEqual(list.map((d) => d.seq), [1, 2, 3, 5]);
  assert.equal(indexOfSeq(list, 3), 2);
  assert.equal(indexOfSeq(list, 4), -1);
  assert.equal(indexOfSeq([], 1), -1);
});

test("countAfter counts the entries that arrived since a seq", () => {
  const list = [1, 2, 3, 5, 8].map((seq) => digest(seq));
  assert.equal(countAfter(list, 3), 2);
  assert.equal(countAfter(list, 4), 2);
  assert.equal(countAfter(list, 8), 0);
  assert.equal(countAfter(list, 0), 5);
  assert.equal(countAfter(list, null), 5, "nothing was seen yet");
});

// ================================================================ filter and search

test("parseFilter and formatFilter round-trip the ?filter= value", () => {
  assert.deepEqual(parseFilter("errors,tools"), ["tools", "errors"], "chip order, not URL order");
  assert.deepEqual(parseFilter(" Errors , nonsense ,"), ["errors"]);
  assert.deepEqual(parseFilter(""), []);
  assert.deepEqual(parseFilter(null), []);
  assert.deepEqual(parseFilter(new Set(["human"])), ["human"]);
  assert.deepEqual(parseFilter(CATEGORIES), [], "all six is the same as no filter");
  assert.equal(formatFilter(["errors", "tools"]), "tools,errors");
  assert.equal(formatFilter([]), "");
});

test("search looks at line text and the tool name, without regard to case", () => {
  const crop = normaliseDigest(digest(1, {
    type: "tool_call", category: "tools", tool: "view_crop",
    lines: [{ kind: "tool", text: 'view_crop {"yaw": 135}' }],
  }));
  const thought = normaliseDigest(digest(2, { lines: [{ kind: "thinking", text: "A Pastelaria sign, so Portugal." }] }));
  const failure = normaliseDigest(digest(3, { type: "api_error", category: "errors", is_error: true, lines: [{ kind: "error", text: "API error: 429" }] }));
  const all = [crop, thought, failure];

  assert.equal(searchNeedle("  PasteLaria "), "pastelaria");
  assert.equal(matchesSearch(thought, "pastelaria"), true);
  assert.equal(matchesSearch(crop, "view_crop"), true);
  assert.equal(matchesSearch(crop, "pastelaria"), false);
  assert.equal(matchesSearch(crop, ""), true);

  assert.deepEqual(visibleDigests(all, [], "").map((d) => d.seq), [1, 2, 3]);
  assert.deepEqual(visibleDigests(all, ["errors", "tools"], "").map((d) => d.seq), [1, 3]);
  assert.deepEqual(visibleDigests(all, new Set(["tools"]), "yaw").map((d) => d.seq), [1]);
  assert.deepEqual(visibleDigests(all, ["tools"], "portugal"), []);

  assert.deepEqual(countByCategory(all, ""), { all: 3, reasoning: 1, tools: 1, images: 0, human: 0, harness: 0, errors: 1 });
  assert.deepEqual(countByCategory(all, "429"), { all: 1, reasoning: 0, tools: 0, images: 0, human: 0, harness: 0, errors: 1 });
});

test("splitMatches cuts a text around the matches and loses nothing", () => {
  assert.deepEqual(splitMatches("A Pastelaria in Lisboa", "pastelaria"), [
    { text: "A ", hit: false },
    { text: "Pastelaria", hit: true },
    { text: " in Lisboa", hit: false },
  ]);
  assert.deepEqual(splitMatches("abab", "ab"), [{ text: "ab", hit: true }, { text: "ab", hit: true }]);
  assert.deepEqual(splitMatches("nothing here", "xyz"), [{ text: "nothing here", hit: false }]);
  assert.deepEqual(splitMatches("plain", ""), [{ text: "plain", hit: false }]);
  assert.deepEqual(splitMatches("", "a"), [{ text: "", hit: false }]);

  const many = splitMatches("e".repeat(1000), "e", 5);
  assert.equal(many.filter((part) => part.hit).length, 5, "the number of marks is bounded");
  assert.equal(many.map((part) => part.text).join(""), "e".repeat(1000));

  const turkish = "İstanbul İstiklal";
  assert.equal(splitMatches(turkish, "ist").map((part) => part.text).join(""), turkish);
});

// ================================================================ lines

test("isLongLine guesses what the clamp will cut", () => {
  assert.equal(isLongLine({ kind: "thinking", text: "short" }), false);
  assert.equal(isLongLine({ kind: "thinking", text: "x".repeat(300) }), true);
  assert.equal(isLongLine({ kind: "thinking", text: "a\nb\nc\nd\ne" }), true);
  assert.equal(isLongLine({ kind: "tool", text: "x".repeat(200) }), true, "monospace lines are clamped sooner");
  assert.equal(isLongLine({ kind: "thinking", text: "x".repeat(200) }), false);
});

test("splitToolLine separates the tool name from its arguments", () => {
  assert.deepEqual(splitToolLine('view_crop {"yaw": 135}'), { name: "view_crop", rest: ' {"yaw": 135}' });
  assert.deepEqual(splitToolLine("submit_locations"), { name: "submit_locations", rest: "" });
  assert.deepEqual(splitToolLine(""), { name: "", rest: "" });
});

test("fullLines rebuilds the unclipped lines of an event from its envelope", () => {
  const long = "word ".repeat(3000);
  const response = {
    seq: 4,
    type: "model_response",
    data: {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: long },
        { type: "text", text: "   " },
        { type: "text", text: "I will zoom in." },
        { type: "tool_use", name: "view_crop", input: { yaw: 135, fov: 40 } },
        { type: "server_tool_use", name: "web_search", input: { type: "search", query: "pastelaria", url: "" } },
      ],
    },
  };
  const responseDigest = normaliseDigest(digest(4, {
    lines: [
      { kind: "thinking", text: long.slice(0, 7999) + "…", truncated: true },
      { kind: "text", text: "I will zoom in." },
      { kind: "tool", text: 'view_crop {"yaw": 135, "fov": 40}' },
      { kind: "tool", text: 'web_search search "pastelaria"' },
    ],
  }));
  const lines = fullLines(response, responseDigest);
  assert.equal(lines.length, 4, "the blank text block makes no line, as on the server");
  assert.equal(lines[0].text, long);
  assert.equal(lines[0].kind, "thinking");
  assert.equal(lines[0].truncated, false);
  assert.equal(lines[2].text, 'view_crop {\n  "yaw": 135,\n  "fov": 40\n}');
  assert.equal(lines[3].text, 'web_search search "pastelaria"');

  const output = "row\n".repeat(500);
  const result = { seq: 9, type: "tool_result", data: { name: "overpass_query", duration_ms: 812.4, is_error: false, output } };
  const resultDigest = normaliseDigest(digest(9, { type: "tool_result", lines: [{ kind: "result", text: "overpass_query (812 ms): row…", truncated: true }] }));
  assert.deepEqual(fullLines(result, resultDigest), [{ kind: "result", text: "overpass_query (812 ms): " + output, truncated: false }]);

  const call = { seq: 8, type: "tool_call", data: { name: "search_places", input: { query: "x" } } };
  const callDigest = normaliseDigest(digest(8, { type: "tool_call", lines: [{ kind: "tool", text: "search_places {…", truncated: true }] }));
  assert.equal(fullLines(call, callDigest)[0].text, 'search_places {\n  "query": "x"\n}');

  const asked = { seq: 3, type: "mcq_asked", data: { question: "Which square?", options: ["A", "B"] } };
  const askedDigest = normaliseDigest(digest(3, { type: "mcq_asked", lines: [{ kind: "human", text: "MCQ: …", truncated: true }] }));
  assert.equal(fullLines(asked, askedDigest)[0].text, "MCQ: Which square? [A | B]");
});

test("fullLines gives up rather than guess when the envelope does not match the digest", () => {
  const twoLines = normaliseDigest(digest(1, { lines: [{ kind: "text", text: "a" }, { kind: "text", text: "b" }] }));
  assert.equal(fullLines({ type: "model_response", data: { content: "only one" } }, twoLines), null);
  assert.equal(fullLines({ type: "candidates_update", data: {} }, twoLines), null, "a type whose lines are never clipped");
  assert.equal(fullLines(null, twoLines), null);
});

// ================================================================ images

test("viewUrl only builds a URL from a sha256, against the app's own endpoint", () => {
  assert.equal(viewUrl("run 1", "pano/2", SHA), "/api/runs/run%201/pano/pano%2F2/views/" + SHA);
  assert.equal(viewUrl("r", "p", "https://example.org/x.jpg"), null);
  assert.equal(viewUrl("r", "p", "../../image"), null);
  assert.equal(viewUrl("r", "p", SHA.toUpperCase()), null);
  assert.equal(viewUrl("r", "p", SHA + "0"), null);
  assert.equal(viewUrl("r", "p", null), null);
});

test("imageCaption lists what is known about a view", () => {
  assert.equal(
    imageCaption({ sha256: SHA, crop_n: 3, yaw: 135, pitch: -5.26, fov: 60, width: 1024, height: 768 }),
    "crop 3 · yaw 135° · pitch -5.3° · FOV 60° · 1024 × 768 px",
  );
  assert.equal(imageCaption({ sha256: SHA, yaw: 0, pitch: 0, fov: 90, crop_n: null }), "yaw 0° · pitch 0° · FOV 90°");
  assert.equal(imageCaption({ sha256: SHA, yaw: null, pitch: null, fov: null }), "view abababab");
});

// ================================================================ windowing

test("buildOffsets and indexAt", () => {
  const offsets = buildOffsets([10, 20, 30]);
  assert.deepEqual(Array.from(offsets), [0, 10, 30, 60]);
  assert.equal(indexAt(offsets, 0), 0);
  assert.equal(indexAt(offsets, 9.9), 0);
  assert.equal(indexAt(offsets, 10), 1, "a position on a boundary belongs to the entry that starts there");
  assert.equal(indexAt(offsets, 29), 1);
  assert.equal(indexAt(offsets, 59), 2);
  assert.equal(indexAt(offsets, -50), 0, "clamped at the top");
  assert.equal(indexAt(offsets, 5000), 2, "clamped at the bottom");
  assert.equal(indexAt(buildOffsets([]), 0), -1);
});

test("windowRange renders a short list whole", () => {
  const offsets = buildOffsets(new Array(300).fill(40));
  assert.deepEqual(windowRange(offsets, 5000, 300, { overscan: 100, minCount: 300 }), { start: 0, end: 300, padTop: 0, padBottom: 0 });
  assert.deepEqual(windowRange(buildOffsets([]), 0, 300, { minCount: 300 }), { start: 0, end: 0, padTop: 0, padBottom: 0 });
});

test("windowRange renders the viewport plus the overscan and pads the rest", () => {
  const offsets = buildOffsets(new Array(1000).fill(40)); // 40000 px
  const range = windowRange(offsets, 20000, 400, { overscan: 200, minCount: 300 });
  assert.deepEqual(range, { start: 495, end: 516, padTop: 19800, padBottom: 40000 - 20640 });

  const top = windowRange(offsets, 0, 400, { overscan: 200, minCount: 300 });
  assert.equal(top.start, 0);
  assert.equal(top.padTop, 0);
  assert.equal(top.end, 16);

  const bottom = windowRange(offsets, 39600, 400, { overscan: 200, minCount: 300 });
  assert.equal(bottom.end, 1000);
  assert.equal(bottom.padBottom, 0);
  assert.equal(bottom.start, 985);

  // A scroll position past the end (the real list was taller than the estimate) shows the tail.
  assert.deepEqual(windowRange(offsets, 99999, 400, { overscan: 200, minCount: 300 }), bottom);
  // No minCount: even a short list is windowed.
  assert.equal(windowRange(buildOffsets(new Array(50).fill(40)), 0, 100).end, 3);
});

test("windowRange: the pads and the rendered entries always add up to the whole list", () => {
  // Uneven heights, as in a real stream: clamped text, thumbnails, expanded entries.
  const heights = Array.from({ length: 2000 }, (_, i) => 30 + ((i * 37) % 11) * 17 + (i % 97 === 0 ? 900 : 0));
  const offsets = buildOffsets(heights);
  const total = offsets[heights.length];
  const viewport = 330;
  const overscan = 400;
  for (let scrollTop = 0; scrollTop <= total; scrollTop += 777) {
    const range = windowRange(offsets, scrollTop, viewport, { overscan, minCount: 300 });
    const rendered = heights.slice(range.start, range.end).reduce((sum, h) => sum + h, 0);
    assert.ok(Math.abs(range.padTop + rendered + range.padBottom - total) < 1e-6, "scrollTop " + scrollTop);
    const top = Math.min(scrollTop, total - viewport);
    assert.ok(range.padTop <= Math.max(0, top - overscan) + 1e-6, "covers the overscan above at " + scrollTop);
    assert.ok(range.padTop + rendered >= Math.min(total, top + viewport + overscan) - 1e-6, "covers the overscan below at " + scrollTop);
    assert.ok(range.end - range.start < 80, "a window, not the list (" + (range.end - range.start) + " entries)");
  }
});

test("coversRange", () => {
  assert.equal(coversRange({ start: 10, end: 50 }, { start: 12, end: 40 }), true);
  assert.equal(coversRange({ start: 10, end: 50 }, { start: 10, end: 50 }), true);
  assert.equal(coversRange({ start: 10, end: 50 }, { start: 9, end: 40 }), false);
  assert.equal(coversRange({ start: 10, end: 50 }, { start: 12, end: 51 }), false);
  assert.equal(coversRange({ start: 0, end: 0 }, { start: 0, end: 0 }), true, "an empty list needs nothing");
});

test("anchorAt: restoring the anchor keeps the same entry under the top edge", () => {
  const heights = new Array(100).fill(50);
  const before = buildOffsets(heights);
  const anchor = anchorAt(before, 2030);
  assert.deepEqual(anchor, { index: 40, offset: 30 });
  assert.equal(anchorAt(buildOffsets([]), 0), null);

  // Three entries above turn out taller than estimated, one shorter; one below changes too.
  heights[3] = 180;
  heights[17] = 75;
  heights[39] = 20;
  heights[60] = 400;
  const after = buildOffsets(heights);
  const restored = after[anchor.index] + anchor.offset;
  assert.equal(restored - 2030, 130 + 25 - 30, "the scroll position moves by exactly what changed above");
  assert.deepEqual(anchorAt(after, restored), anchor);
});

// ================================================================ JSON tree

test("jsonKind and jsonSummary", () => {
  assert.equal(jsonKind(null), "null");
  assert.equal(jsonKind(undefined), "null");
  assert.equal(jsonKind([]), "array");
  assert.equal(jsonKind({}), "object");
  assert.equal(jsonKind("x"), "string");
  assert.equal(jsonKind(1.5), "number");
  assert.equal(jsonKind(false), "boolean");
  assert.equal(jsonSummary([1, 2, 3]), "[3 items]");
  assert.equal(jsonSummary([1]), "[1 item]");
  assert.equal(jsonSummary({ a: 1 }), "{1 key}");
  assert.equal(jsonSummary({ a: 1, b: 2 }), "{2 keys}");
});

// ================================================================ the component, on a minimal fake DOM
//
// Not a test of browser layout: every entry is 50 px tall and the scroller 300 px. It checks the
// behaviour that needs no browser: what is loaded and when, what is in the DOM for a scroll
// position, what the operator is told, and what the callbacks receive. There is no
// ResizeObserver here, so the stream measures its entries itself; an entry that was never
// rendered counts as 60 px (the stream's estimate without a computed font size).

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get isConnected() {
    for (let node = this; node; node = node.parentNode) if (node === globalThis.document.documentElement) return true;
    return false;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(text) { super(3); this.data = String(text); }
  get textContent() { return this.data; }
}

class FakeElement extends FakeNode {
  constructor(tagName, nodeType = 1) {
    super(nodeType);
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty(key, value) { this[key] = value; } };
    for (const [key, value] of Object.entries({ hidden: false, title: "", disabled: false, value: "", type: "", open: false, src: "", alt: "" })) this[key] = value;
    const names = () => (this.attributes.get("class") || "").split(/\s+/).filter(Boolean);
    this.classList = {
      contains: (name) => names().includes(name),
      add: (...added) => this.attributes.set("class", Array.from(new Set([...names(), ...added])).join(" ")),
      remove: (...removed) => this.attributes.set("class", names().filter((name) => !removed.includes(name)).join(" ")),
      toggle: (name, force) => {
        const want = force === undefined ? !names().includes(name) : Boolean(force);
        if (want) this.classList.add(name);
        else this.classList.remove(name);
        return want;
      },
    };
  }
  get className() { return this.attributes.get("class") || ""; }
  set className(value) { this.attributes.set("class", String(value)); }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.has(key) ? this.attributes.get(key) : null; }
  adopt(node) {
    if (node.nodeType === 11) return node.childNodes.splice(0).map((child) => { child.parentNode = this; return child; });
    node.remove();
    node.parentNode = this;
    return [node];
  }
  append(...nodes) {
    for (const node of nodes) this.childNodes.push(...this.adopt(typeof node === "object" ? node : new FakeText(node)));
  }
  replaceChildren(...nodes) {
    for (const old of this.childNodes.splice(0)) old.parentNode = null;
    this.append(...nodes);
  }
  insertBefore(node, reference) {
    const adopted = this.adopt(node);
    const at = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    this.childNodes.splice(at, 0, ...adopted);
    return node;
  }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value) { this.replaceChildren(new FakeText(value)); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const held = this.listeners.get(type) || [];
    if (held.includes(fn)) held.splice(held.indexOf(fn), 1);
  }
  dispatch(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, target: this, stopPropagation() {}, preventDefault() {}, ...event });
  }
  click() { this.dispatch("click"); }
  focus() {}
  blur() {}
  select() {}
  getBoundingClientRect() { return { height: this.classList.contains("stream-entry") ? 50 : 0 }; }
  all(className) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.classList.contains(className)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  one(className) { return this.all(className)[0] || null; }
}

function installFakeDom() {
  const documentElement = new FakeElement("html");
  const body = new FakeElement("body");
  documentElement.append(body);
  globalThis.document = {
    documentElement,
    body,
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(text),
    createDocumentFragment: () => new FakeElement("#fragment", 11),
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  return body;
}

// A 300 px viewport over 50 px entries: enough layout for the windowing to work with.
function fakeLayout(root) {
  const scroller = root.one("stream-scroll");
  const [padTop, padBottom] = scroller.all("stream-pad");
  const list = scroller.one("stream-list");
  let top = 0;
  Object.defineProperty(scroller, "clientHeight", { get: () => 300 });
  Object.defineProperty(scroller, "scrollHeight", {
    get: () => parseFloat(padTop.style.height || 0) + list.children.length * 50 + parseFloat(padBottom.style.height || 0),
  });
  Object.defineProperty(scroller, "scrollTop", {
    get: () => top,
    set: (value) => { top = Math.max(0, Math.min(value, scroller.scrollHeight - 300)); },
  });
  return {
    scroller,
    seqs: () => list.children.map((node) => Number(node.dataset.seq)),
    // Where the top of a rendered entry is, in the scroller's coordinates.
    topOf: (seq) => parseFloat(padTop.style.height || 0) + list.children.findIndex((node) => Number(node.dataset.seq) === seq) * 50,
    scrollTo(value) {
      scroller.scrollTop = value;
      scroller.dispatch("scroll");
    },
  };
}

// The events endpoint of one panorama, backed by an array the test appends to.
function fakeServer(log, envelopes = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const query = new URL(url, "http://127.0.0.1:8000").searchParams;
    let events;
    if (query.get("full") === "1") events = envelopes[query.get("seq")] ? [envelopes[query.get("seq")]] : [];
    else events = log.filter((event) => event.seq > Number(query.get("after") || 0));
    return { ok: true, status: 200, text: async () => JSON.stringify({ events }) };
  };
  return calls;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
const live = (pid, event) => store.emit("pano", { kind: "pano", run_id: "run1", panorama_id: pid, event, tile: {} });

test("stream: loads its backlog, de-duplicates live events, repairs a gap and unsubscribes", async () => {
  const body = installFakeDom();
  const log = [1, 2, 3, 4, 5].map((seq) => digest(seq));
  const calls = fakeServer(log);
  const stream = createStream(body, { runId: "run1", pid: "p1" });
  fakeLayout(stream.el);
  await settle();
  assert.deepEqual(calls, ["/api/runs/run1/pano/p1/events?after=0"]);
  assert.equal(stream.getState().total, 5);

  live("p1", digest(5)); // already loaded
  live("p2", digest(6)); // another panorama of the run
  live("p1", null); // a tile update without an event
  await settle();
  assert.equal(stream.getState().total, 5);

  log.push(digest(6));
  live("p1", digest(6));
  await settle();
  assert.equal(stream.getState().total, 6);
  assert.equal(calls.length, 1, "the next seq in order needs no request");

  log.push(digest(7), digest(8), digest(9));
  live("p1", digest(9)); // 7 and 8 were missed while the stream was down
  await settle();
  assert.equal(calls[1], "/api/runs/run1/pano/p1/events?after=6", "asks from the last complete seq, not from the newest");
  assert.equal(stream.getState().total, 9);
  assert.equal(stream.getState().lastSeq, 9);

  log.push(digest(10));
  store.emit("snapshot", { bootChanged: false, fromStream: true }); // a reconnect
  await settle();
  assert.equal(calls[2], "/api/runs/run1/pano/p1/events?after=9");
  assert.equal(stream.getState().total, 10);

  stream.destroy();
  assert.equal(body.all("stream").length, 0);
  log.push(digest(11));
  live("p1", digest(12));
  store.emit("snapshot", { bootChanged: false, fromStream: true });
  await settle();
  assert.equal(calls.length, 3, "nothing is requested after destroy()");
});

test("stream: a failed load says what happened and offers a retry", async () => {
  const body = installFakeDom();
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ detail: { message: "Unknown panorama. Open the run again." } }) });
  const stream = createStream(body, { runId: "run1", pid: "gone" });
  fakeLayout(stream.el);
  await settle();
  const empty = stream.el.one("stream-empty");
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /Could not load the events\. Unknown panorama\. Open the run again\./);
  assert.match(stream.getState().error, /Unknown panorama/);

  fakeServer([digest(1)]);
  empty.children.find((node) => node.tagName === "BUTTON").click();
  await settle();
  assert.equal(stream.getState().total, 1);
  assert.equal(stream.getState().error, null);
  assert.equal(empty.hidden, true);
  stream.destroy();
});

test("stream: a short list is in the DOM whole; a long one is a window that follows the tail", async () => {
  const body = installFakeDom();
  const short = createStream(body, { runId: "run1", pid: "p1", live: false });
  const shortView = fakeLayout(short.el);
  short.reset(Array.from({ length: 120 }, (_, i) => digest(i + 1)));
  await settle();
  assert.equal(shortView.seqs().length, 120);
  short.destroy();

  const stream = createStream(body, { runId: "run1", pid: "p1", live: false });
  const view = fakeLayout(stream.el);
  stream.reset(Array.from({ length: 1000 }, (_, i) => digest(i + 1)));
  await settle();
  await settle();
  let seqs = view.seqs();
  assert.ok(seqs.length > 6 && seqs.length < 60, "a window of the 1000 entries, got " + seqs.length);
  assert.equal(seqs[seqs.length - 1], 1000, "the tail is rendered");
  assert.equal(view.scroller.scrollTop, view.scroller.scrollHeight - 300, "pinned to the bottom");
  assert.ok(view.scroller.scrollHeight > 300 * 50, "the pad stands in for the entries that are not rendered");
  assert.equal(stream.getState().following, true);
  assert.equal(stream.el.one("stream-jump").hidden, true);

  stream.append(digest(1001));
  await settle();
  seqs = view.seqs();
  assert.equal(seqs[seqs.length - 1], 1001, "still following");
  assert.equal(view.scroller.scrollTop, view.scroller.scrollHeight - 300);
  stream.destroy();
});

test("stream: scrolling up stops the follow, keeps the place and counts what arrives", async () => {
  const body = installFakeDom();
  const stream = createStream(body, { runId: "run1", pid: "p1", live: false });
  const view = fakeLayout(stream.el);
  stream.reset(Array.from({ length: 1000 }, (_, i) => digest(i + 1)));
  await settle();
  await settle();

  // 20000 px down a list of unmeasured 60 px entries: 20 px into the 334th.
  view.scrollTo(20000);
  await settle();
  await settle();
  assert.equal(stream.getState().following, false);
  assert.ok(view.seqs().includes(334), "the entry at the top of the viewport is rendered");
  assert.ok(view.seqs().includes(330), "and some above it, for the overscan");
  assert.ok(!view.seqs().includes(1000), "the tail is no longer in the DOM");
  // The entries rendered above it turned out 10 px shorter each than their pad; the scroll
  // position followed, so the same 20 px of the same entry are still under the top edge.
  assert.equal(view.scroller.scrollTop - view.topOf(334), 20);
  assert.ok(view.scroller.scrollTop < 20000);
  const jump = stream.el.one("stream-jump");
  assert.equal(jump.hidden, false);
  assert.equal(jump.one("stream-jump-count").hidden, true, "nothing new yet");

  stream.append([digest(1001), digest(1002), digest(1003)]);
  stream.append(digest(1003));
  await settle();
  assert.equal(view.scroller.scrollTop - view.topOf(334), 20, "new entries do not move the operator");
  assert.ok(!view.seqs().includes(1003), "and are not rendered while they are out of sight");
  assert.equal(stream.getState().unseen, 3);
  assert.equal(jump.one("stream-jump-count").hidden, false);
  assert.equal(jump.one("stream-jump-count").textContent, "3 new");

  jump.click();
  await settle();
  assert.equal(stream.getState().following, true);
  assert.equal(stream.getState().unseen, 0);
  assert.equal(view.seqs().pop(), 1003);
  assert.equal(jump.hidden, true);
  stream.destroy();
});

test("stream: scrollToSeq brings an entry into the window and marks it", async () => {
  const body = installFakeDom();
  const stream = createStream(body, { runId: "run1", pid: "p1", live: false });
  const view = fakeLayout(stream.el);
  stream.reset(Array.from({ length: 1000 }, (_, i) => digest(i + 1)));
  await settle();

  assert.equal(stream.scrollToSeq(500), true);
  assert.ok(view.seqs().includes(500));
  const target = stream.el.all("stream-entry").find((node) => node.dataset.seq === "500");
  assert.equal(target.classList.contains("is-target"), true);
  assert.equal(stream.getState().following, false);
  await settle();
  await settle();
  assert.ok(view.seqs().some((seq) => seq < 500), "entries above the target are rendered for the overscan");
  assert.equal(view.scroller.scrollTop - view.topOf(500), -8, "the target sits just below the top edge");
  assert.equal(stream.scrollToSeq(5000), false, "no such entry");
  assert.equal(stream.scrollToSeq(null), false);
  assert.equal(target.classList.contains("is-target"), false, "scrollToSeq(null) removes the mark");
  stream.destroy();
});

test("stream: filters and search change what is shown; callbacks fire only for the operator", async () => {
  const body = installFakeDom();
  const changes = [];
  const stream = createStream(body, { runId: "run1", pid: "p1", live: false, filter: "errors", onChange: (state) => changes.push(state) });
  fakeLayout(stream.el);
  stream.reset([
    digest(1),
    digest(2, { type: "tool_call", category: "tools", tool: "view_crop", lines: [{ kind: "tool", text: 'view_crop {"yaw": 135}' }] }),
    digest(3, { type: "api_error", category: "errors", is_error: true, lines: [{ kind: "error", text: "API error: 429 Pastelaria" }] }),
    digest(4, { lines: [{ kind: "thinking", text: "The sign says Pastelaria." }] }),
  ]);
  await settle();
  assert.deepEqual(stream.getState().filter, ["errors"], "the initial filter comes from the options");
  assert.equal(stream.getState().shown, 1);
  assert.equal(stream.getState().total, 4);

  stream.setFilter(null);
  stream.setSearch("pastelaria");
  await settle();
  assert.equal(stream.getState().shown, 2);
  assert.deepEqual(stream.getState().counts, { all: 2, reasoning: 1, tools: 0, images: 0, human: 0, harness: 0, errors: 1 });
  assert.equal(stream.el.all("stream-mark").length, 2, "matches are highlighted in the rendered lines");
  assert.equal(stream.el.one("stream-search-count").textContent, "2 of 4");
  assert.deepEqual(changes, [], "setFilter and setSearch are silent");

  const chip = stream.el.all("stream-chip").find((node) => node.classList.contains("cat-errors"));
  chip.click();
  await settle();
  assert.deepEqual(changes, [{ filter: ["errors"], search: "pastelaria" }]);
  assert.equal(chip.getAttribute("aria-pressed"), "true");
  assert.equal(stream.getState().shown, 1);

  stream.setSearch("no such text");
  await settle();
  const empty = stream.el.one("stream-empty");
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /No entry matches/);
  empty.children.find((node) => node.tagName === "BUTTON").click(); // "Show everything"
  await settle();
  assert.equal(stream.getState().shown, 4);
  assert.deepEqual(changes[1], { filter: [], search: "" });
  stream.destroy();
});

test("stream: More fetches the full event for a clipped line; an entry opens its JSON in the side panel", async () => {
  const body = installFakeDom();
  const long = "detail ".repeat(200);
  const envelope = { seq: 7, ts: "2026-10-11T10:00:14Z", t_rel_s: 14, actor: "tool", type: "tool_result", penalty_state: { multiplier: 0.95 }, data: { name: "search_places", duration_ms: 40, output: long } };
  const calls = fakeServer([], { 7: envelope });
  const opened = [];
  const stream = createStream(body, { runId: "run1", pid: "p1", live: false, onOpenEvent: (seq) => opened.push(seq) });
  fakeLayout(stream.el);
  stream.reset([digest(7, { type: "tool_result", category: "tools", tool: "search_places", duration_ms: 40, lines: [{ kind: "result", text: "search_places (40 ms): detail…", truncated: true }] })]);
  await settle();

  const entry = stream.el.one("stream-entry");
  const toggle = entry.one("stream-toggle");
  assert.equal(toggle.hidden, false, "a clipped line can always be expanded");
  toggle.click();
  await settle();
  assert.deepEqual(calls, ["/api/runs/run1/pano/p1/events?seq=7&full=1"]);
  assert.equal(entry.classList.contains("is-expanded"), true);
  assert.equal(entry.one("stream-line").textContent, "search_places (40 ms): " + long);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  entry.one("stream-open").click();
  await settle();
  assert.deepEqual(opened, [7]);
  assert.equal(calls.length, 1, "the envelope is fetched once for both uses");
  const panel = body.one("side-panel");
  assert.ok(panel, "the shell side panel is open");
  assert.match(panel.textContent, /Event #7 · Result/);
  assert.match(panel.textContent, /penalty_state:/);
  assert.match(panel.textContent, /x0\.95/);
  assert.equal(entry.classList.contains("is-open"), true);
  assert.equal(stream.getState().openSeq, 7);

  stream.openEvent(null);
  assert.equal(body.one("side-panel"), null);
  assert.deepEqual(opened, [7], "closing from code does not call onOpenEvent");
  assert.equal(entry.classList.contains("is-open"), false);

  stream.openEvent(7);
  assert.ok(body.one("side-panel"));
  body.one("side-panel").all("icon-btn")[0].click(); // the panel's own close button
  assert.deepEqual(opened, [7, null], "the operator closing the panel is reported");
  stream.destroy();
});

test("stream: thumbnails use the checked view URL, and a crop entry reports its number on hover", async () => {
  const body = installFakeDom();
  const hovered = [];
  const picked = [];
  const stream = createStream(body, {
    runId: "run1",
    pid: "p1",
    live: false,
    onCropHover: (n) => hovered.push(n),
    onImage: (image) => { picked.push(image.crop_n); return false; },
  });
  fakeLayout(stream.el);
  stream.reset([
    digest(1, { type: "tool_call", category: "tools", tool: "view_crop", crop_n: 2, lines: [{ kind: "tool", text: 'view_crop {"yaw": 135}' }] }),
    digest(2, {
      type: "tool_result", category: "images", tool: "view_crop", crop_n: 2,
      images: [{ sha256: SHA, yaw: 135, pitch: 0, fov: 40, width: 1024, height: 768, crop_n: 2 }, { sha256: "javascript:alert(1)" }],
    }),
  ]);
  await settle();

  const [call, result] = stream.el.all("stream-entry");
  const thumbs = result.all("stream-thumb");
  assert.equal(thumbs.length, 1, "an image id that is not a sha256 is not rendered");
  assert.equal(thumbs[0].one("stream-thumb-img").src, "/api/runs/run1/pano/p1/views/" + SHA);
  assert.equal(thumbs[0].title, "crop 2 · yaw 135° · pitch 0° · FOV 40° · 1024 × 768 px (click to enlarge)");
  thumbs[0].click();
  assert.deepEqual(picked, [2]);
  assert.equal(body.all("lightbox").length, 0, "onImage returning false keeps the lightbox closed");

  call.dispatch("mouseenter");
  call.dispatch("mouseleave");
  assert.deepEqual(hovered, [2, null]);

  stream.highlightCrop(2);
  assert.equal(call.classList.contains("is-hot"), true);
  assert.equal(result.classList.contains("is-hot"), true);
  stream.highlightCrop(null);
  assert.equal(call.classList.contains("is-hot"), false);

  stream.setCursor(1);
  assert.equal(result.classList.contains("is-future"), true);
  assert.equal(call.classList.contains("is-future"), false);
  stream.destroy();
});

test("stream: an event link opened cold shows the JSON at once and scrolls there when the backlog arrives", async () => {
  const body = installFakeDom();
  const log = Array.from({ length: 600 }, (_, i) => digest(i + 1));
  const calls = fakeServer(log, { 250: { seq: 250, type: "model_response", data: { content: "x" } } });
  const opened = [];
  const stream = createStream(body, { runId: "run1", pid: "p1", onOpenEvent: (seq) => opened.push(seq) });
  const view = fakeLayout(stream.el);
  stream.openEvent(250); // what the focus screen does for `?event=250`
  assert.ok(body.one("side-panel"), "the panel does not wait for the list");
  assert.equal(stream.getState().total, 0);
  await settle();
  await settle();
  assert.deepEqual(calls.slice().sort(), ["/api/runs/run1/pano/p1/events?after=0", "/api/runs/run1/pano/p1/events?seq=250&full=1"]);
  assert.ok(view.seqs().includes(250), "the entry is in the window");
  assert.equal(view.scroller.scrollTop - view.topOf(250), -8);
  const target = stream.el.all("stream-entry").find((node) => node.dataset.seq === "250");
  assert.equal(target.classList.contains("is-target"), true);
  assert.equal(target.classList.contains("is-open"), true);
  assert.equal(stream.getState().following, false);
  assert.deepEqual(opened, [], "opening from code is not reported back");

  stream.destroy();
  assert.equal(body.one("side-panel"), null, "destroy() closes the panel it opened");
  assert.deepEqual(opened, []);
});
