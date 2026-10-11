// Map of one panorama's hypotheses and answers: a thin wrapper around the vendored Leaflet
// (classic script, window.L). The Leaflet map is only created when its container is on screen and
// has a size, so a dashboard of many tiles pays for the visible ones only.
//
// Offline is a first-class state: a coordinate grid is drawn under the tiles and is what remains
// when they do not load. Without Leaflet itself the wrapper says so and every method is a no-op.
//
// Labels, evidence and marker text can be model text: they reach the page as text nodes only,
// and Leaflet is always handed DOM nodes, never HTML strings.

const SVG_NS = "http://www.w3.org/2000/svg";
const getLeaflet = () => (typeof window !== "undefined" ? window.L : undefined);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hasPoint = (p) => !!p && isNum(p.lat) && isNum(p.lng);

// ---------------------------------------------------------------- pure helpers (tested under node)

// Longitude wrapped into [-180, 180]: a click on a repeated copy of the world is the same place.
export function normalizeLng(lng) {
  if (!isNum(lng)) return lng;
  if (lng >= -180 && lng <= 180) return lng;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

// What the geocode pin reports: latitude clamped, longitude wrapped, both at the 6 decimals of
// the submission format.
export function normalizePoint(point) {
  return {
    lat: Number(clamp(point.lat, -90, 90).toFixed(6)),
    lng: Number(normalizeLng(point.lng).toFixed(6)),
  };
}

const fmtCoord = (v) => Number(v).toFixed(6);
const fmtLatLng = (lat, lng) => fmtCoord(lat) + ", " + fmtCoord(lng);

function fmtMeters(m) {
  if (!isNum(m)) return "";
  if (m < 1000) return Math.round(m) + " m";
  return (m < 100000 ? (m / 1000).toFixed(1) : String(Math.round(m / 1000))) + " km";
}

// Marker radius in pixels. The AREA is proportional to the probability (radius ~ sqrt), which is
// what the eye compares; below about 3% the floor keeps the marker visible and clickable.
export const HYPOTHESIS_MAX_RADIUS = 16;
export const HYPOTHESIS_MIN_RADIUS = 3;
export function hypothesisRadius(probability) {
  const p = clamp(isNum(probability) ? probability : 0, 0, 1);
  return Math.max(HYPOTHESIS_MIN_RADIUS, HYPOTHESIS_MAX_RADIUS * Math.sqrt(p));
}

export function haversineM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
}

// "1–4, 7" for [1, 2, 3, 4, 7].
export function rankRanges(ranks) {
  const sorted = [...new Set((ranks || []).filter(isNum))].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(i === j ? String(sorted[i]) : sorted[i] + "–" + sorted[j]);
    i = j;
  }
  return parts.join(", ");
}

// The ten entries of a list as distinct points with the ranks that share each one.
export function groupEntries(entries) {
  const groups = [];
  const byKey = new Map();
  (entries || []).forEach((entry, index) => {
    if (!hasPoint(entry)) return;
    const key = fmtLatLng(entry.lat, entry.lng);
    let group = byKey.get(key);
    if (!group) {
      group = { lat: entry.lat, lng: entry.lng, ranks: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.ranks.push(isNum(entry.rank) ? entry.rank : index + 1);
  });
  for (const group of groups) group.label = rankRanges(group.ranks);
  return groups;
}

// Web Mercator, in pixels of the whole world at a zoom level.
const MAX_MERCATOR_LAT = 85.0511287798;
export function mercatorX(lng, zoom, size = 256) {
  return ((lng + 180) / 360) * size * 2 ** zoom;
}
export function mercatorY(lat, zoom, size = 256) {
  // Beyond this latitude the projection runs off the square world.
  const sin = Math.sin((clamp(lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT) * Math.PI) / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size * 2 ** zoom;
}
export function lngFromX(x, zoom, size = 256) {
  return (x / (size * 2 ** zoom)) * 360 - 180;
}
export function latFromY(y, zoom, size = 256) {
  const n = Math.PI - (2 * Math.PI * y) / (size * 2 ** zoom);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

// Spacing of the graticule in degrees: the smallest round step that keeps lines at least about
// 110 px apart at the equator.
const GRID_STEPS = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 45, 90];
export function gridStep(zoom, size = 256) {
  const wanted = (110 * 360) / (size * 2 ** zoom);
  return GRID_STEPS.find((step) => step >= wanted) || 90;
}

export function formatDegrees(value, step, axis) {
  const decimals = step >= 1 ? 0 : Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  const v = axis === "lng" ? normalizeLng(value) : value;
  const text = Math.abs(v).toFixed(decimals);
  if (Number(text) === 0) return "0°";
  const suffix = axis === "lng" ? (v < 0 ? "W" : "E") : (v < 0 ? "S" : "N");
  return text + "°" + suffix;
}

// The graticule lines that cross one tile: [{axis: "lat"|"lng", value, px}] with px measured from
// the tile's left (meridians) or top (parallels) edge.
export function gridTileLines(coords, size = 256) {
  const { x, y, z } = coords;
  const step = gridStep(z, size);
  const west = lngFromX(x * size, z, size);
  const east = lngFromX((x + 1) * size, z, size);
  const north = latFromY(y * size, z, size);
  const south = latFromY((y + 1) * size, z, size);
  const lines = [];
  const snap = (k) => Number((k * step).toFixed(6));
  for (let k = Math.ceil(west / step - 1e-9); snap(k) <= east + 1e-9; k += 1) {
    lines.push({ axis: "lng", value: snap(k), px: mercatorX(snap(k), z, size) - x * size });
  }
  for (let k = Math.ceil(south / step - 1e-9); snap(k) <= north + 1e-9; k += 1) {
    if (Math.abs(snap(k)) > 85) continue;
    lines.push({ axis: "lat", value: snap(k), px: mercatorY(snap(k), z, size) - y * size });
  }
  return { step, lines };
}

// Identity of a set of points for "did the data change since the last fit". Five decimals is
// about a metre: a re-sent, unchanged list never triggers a re-fit.
export function fitSignature(points) {
  return (points || []).filter(hasPoint).map((p) => p.lat.toFixed(5) + "," + p.lng.toFixed(5)).join(";");
}

// ---------------------------------------------------------------- tile sources

// OpenStreetMap asks web pages for a Referer, and the console answers every page with
// "Referrer-Policy: no-referrer"; the tile images therefore opt in to sending the bare origin
// (http://127.0.0.1:8000/), which carries nothing about the run.
// `fallback` is the same service under its older subdomain names: it is tried once when the
// first address yields nothing at all (a content-security policy written for *.tile.openstreetmap.org
// blocks the bare host).
// The attributions are plain text on purpose: the console links to no external map (decision U2).
const TILE_SOURCES = {
  street: {
    label: "Street",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    fallback: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: { maxZoom: 19, subdomains: "abc", referrerPolicy: "origin", attribution: "© OpenStreetMap contributors" },
  },
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    fallback: null,
    // Beyond zoom 18 the service answers with placeholder tiles in many places: upscale instead.
    options: { maxZoom: 19, maxNativeZoom: 18, attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community" },
  },
};
// Two failures in a row with no success between them: a small map may only ask for two tiles.
const TILE_ERRORS_BEFORE_NOTE = 2;

const MARKER_KINDS = ["truth", "answer", "eval", "option"];
const LINE_BANDS = ["100m", "1km", "10km", "far"];
// Vector panes sit between Leaflet's overlay (400) and marker (600) panes; icon panes above 600
// and below the tooltips (650). The order is what is drawn over what.
const PANES = { rings: 405, clusters: 410, lines: 420, path: 425, hyps: 430, entries: 610, markers: 615, answer: 620, truth: 625, pin: 640 };
const paneName = (key) => "geomap-" + key;

// ---------------------------------------------------------------- DOM helpers

function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// Static icons authored here; nothing dynamic ever goes through this.
function svgIcon(shapes, viewBox = "0 0 16 16") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attributes] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const name of Object.keys(attributes)) node.setAttribute(name, attributes[name]);
    svg.append(node);
  }
  return svg;
}

const ICONS = {
  fit: () => svgIcon([
    ["circle", { cx: 8, cy: 8, r: 3.2, fill: "none", stroke: "currentColor", "stroke-width": 1.5 }],
    ["path", { d: "M8 1v3M8 12v3M1 8h3M12 8h3", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round" }],
  ]),
  check: () => svgIcon([["path", { d: "M3.5 8.5l3 3 6-7", fill: "none", stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" }]]),
  star: () => svgIcon([["path", { d: "M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z" }]]),
  pin: () => svgIcon([
    ["path", { d: "M8 15.2S2.8 9.9 2.8 6.2a5.2 5.2 0 0 1 10.4 0C13.2 9.9 8 15.2 8 15.2z" }],
    ["circle", { cx: 8, cy: 6.2, r: 1.9, class: "geomap-pin-eye" }],
  ]),
};

// ---------------------------------------------------------------- coordinate grid layer

function readGridColours(root) {
  const style = getComputedStyle(root);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    line: read("--geomap-grid-line", "#8492a3"),
    label: read("--geomap-grid-label", "#8492a3"),
    halo: read("--geomap-bg", "#10151b"),
  };
}

function drawGridTile(canvas, coords, size, colours) {
  const ratio = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  canvas.width = Math.round(size * ratio);
  canvas.height = Math.round(size * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  const { step, lines } = gridTileLines(coords, size);
  ctx.strokeStyle = colours.line;
  ctx.lineWidth = 1;
  // The lines stay faint; the labels carry the information.
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  for (const line of lines) {
    // Half-pixel offsets keep one-pixel lines crisp.
    const p = Math.round(line.px) + 0.5;
    if (line.axis === "lng") { ctx.moveTo(p, 0); ctx.lineTo(p, size); }
    else { ctx.moveTo(0, p); ctx.lineTo(size, p); }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  // One label per line and tile: meridians along the top edge, parallels along the left one.
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeStyle = colours.halo;
  ctx.fillStyle = colours.label;
  const write = (text, x, y) => { ctx.strokeText(text, x, y); ctx.fillText(text, x, y); };
  for (const line of lines) {
    if (line.px < 0 || line.px > size - 1) continue;
    const text = formatDegrees(line.value, step, line.axis);
    // A label never leaves its tile (the canvas would cut it): beside the edge it flips to the
    // other side of its line.
    if (line.axis === "lng") {
      const width = ctx.measureText(text).width;
      write(text, line.px + 4 + width > size ? line.px - 4 - width : line.px + 4, 12);
    } else {
      write(text, 4, line.px > 30 ? line.px - 4 : line.px + 13);
    }
  }
}

let GridLayerClass = null;
function createGridLayer(L, colours) {
  if (!GridLayerClass) {
    GridLayerClass = L.GridLayer.extend({
      createTile(coords) {
        const canvas = document.createElement("canvas");
        drawGridTile(canvas, coords, this.getTileSize().x, this.options.colours());
        return canvas;
      },
    });
  }
  // zIndex 0 keeps it under the imagery, which covers it wherever a tile did load.
  return new GridLayerClass({ zIndex: 0, updateWhenZooming: false, keepBuffer: 1, className: "geomap-gridlayer", colours });
}

// ---------------------------------------------------------------- no Leaflet

const NOOP_PIN = { get: () => null, clear() {}, set() {}, remove() {} };

function unavailableMap(root) {
  root.classList.add("is-unavailable");
  root.replaceChildren(h("div", "geomap-unavailable", "map unavailable"));
  const noop = () => {};
  return {
    setHypotheses: noop, highlightHypothesis: noop, setAnswer: noop, setEntries: noop, setClusters: noop,
    setTruth: noop, setPath: noop, setMarkers: noop, setLines: noop, fit: noop, flyTo: noop, setLayer: noop,
    enablePin: () => NOOP_PIN, invalidate: noop,
    destroy() { root.remove(); },
    el: root,
    available: false,
  };
}

// ---------------------------------------------------------------- createMap

// createMap(container, {interactive: true, layer: "street"|"satellite", scale: true,
//                       controls?: bool (default: interactive), wheel?: "focus"|true|false}) -> map
export function createMap(container, options = {}) {
  const opts = { interactive: true, layer: "street", scale: true, wheel: "focus", ...options };
  const interactive = opts.interactive !== false;
  const root = h("div", "geomap");
  container.append(root);
  const L = getLeaflet();
  if (!L || typeof L.map !== "function") return unavailableMap(root);

  const canvas = h("div", "geomap-canvas");
  const note = h("div", "geomap-note", "map tiles unavailable: coordinate grid");
  note.hidden = true;
  const hint = h("div", "geomap-hint", "Click the map to place the pin; drag it to adjust.");
  hint.hidden = true;
  root.append(canvas, note, hint);

  // Everything the map shows is kept here, so data set before the Leaflet map exists (or while
  // the tile is off screen) is drawn when it is created.
  const data = {
    hypotheses: [], onHover: null, highlight: null,
    answer: null, final: false, entries: [],
    clusters: [], truth: null, truthLines: [], path: [],
    markers: [], markerOptions: {}, lines: [],
  };
  let map = null;
  let groups = null;
  let tiles = null;
  let grid = null;
  let gridColours = null;
  let layerName = opts.layer === "satellite" ? "satellite" : "street";
  let hypLayers = new Map();
  let hovered = null;
  let pin = null;
  let destroyed = false;
  let visible = typeof IntersectionObserver !== "function";
  let pendingFit = null;
  let pendingView = null;
  // View bookkeeping, so that fit() never fights the operator (see fit below).
  let lastFitSig = null;
  let viewMode = null;
  let userMoved = false;
  let programmatic = 0;
  let programmaticUntil = 0;
  let invalidateFrame = 0;
  const tileStats = { loaded: 0, errors: 0, triedFallback: false };

  // ---- tools: layer switch and "fit to hypotheses" (plain buttons beside the map, so a click on
  // them can never reach the map and place a pin)

  const tools = h("div", "geomap-tools");
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "Map view");
  const layerButtons = {};
  const layerSwitch = h("div", "geomap-switch");
  for (const name of Object.keys(TILE_SOURCES)) {
    const button = h("button", "geomap-btn", TILE_SOURCES[name].label);
    button.type = "button";
    button.addEventListener("click", () => setLayer(name));
    layerButtons[name] = button;
    layerSwitch.append(button);
  }
  const fitButton = h("button", "geomap-btn geomap-fit");
  fitButton.type = "button";
  fitButton.title = "Fit to hypotheses";
  fitButton.setAttribute("aria-label", "Fit to hypotheses");
  fitButton.append(ICONS.fit(), h("span", "geomap-fit-text", "Fit"));
  fitButton.addEventListener("click", () => fit({ force: true }));
  tools.append(layerSwitch, fitButton);
  tools.hidden = !(opts.controls === undefined ? interactive : opts.controls);
  root.append(tools);

  function markLayerButtons() {
    for (const name of Object.keys(layerButtons)) {
      layerButtons[name].setAttribute("aria-pressed", name === layerName ? "true" : "false");
    }
  }
  markLayerButtons();

  // ---- tiles

  function showNote(on) {
    note.hidden = !on;
    root.classList.toggle("is-offline", on);
  }

  function watchTiles(name, layer) {
    layer.on("tileload", () => {
      if (name !== layerName) return;
      tileStats.loaded += 1;
      tileStats.errors = 0;
      showNote(false);
    });
    layer.on("tileerror", (event) => {
      // A failed image would cover the grid with a broken-image box.
      if (event.tile) event.tile.style.visibility = "hidden";
      if (name !== layerName) return;
      tileStats.errors += 1;
      if (tileStats.errors < TILE_ERRORS_BEFORE_NOTE) return;
      const source = TILE_SOURCES[name];
      if (source.fallback && !tileStats.triedFallback && tileStats.loaded === 0) {
        tileStats.triedFallback = true;
        tileStats.errors = 0;
        layer.setUrl(source.fallback);
        return;
      }
      showNote(true);
    });
  }

  function applyLayer() {
    markLayerButtons();
    if (!map) return;
    tileStats.loaded = 0;
    tileStats.errors = 0;
    showNote(false);
    for (const name of Object.keys(tiles)) {
      if (name === layerName) tiles[name].addTo(map);
      else tiles[name].remove();
    }
    root.classList.toggle("is-satellite", layerName === "satellite");
  }

  function setLayer(name) {
    if (!TILE_SOURCES[name] || name === layerName) return;
    layerName = name;
    applyLayer();
  }

  // Back online: ask for the tiles again instead of waiting for the next pan.
  const onOnline = () => { if (map && tiles) tiles[layerName].redraw(); };

  function refreshGridColours() {
    const next = readGridColours(root);
    const changed = !gridColours || next.line !== gridColours.line || next.label !== gridColours.label || next.halo !== gridColours.halo;
    gridColours = next;
    if (changed && grid) grid.redraw();
  }

  // ---- drawing

  const tipNode = (text, cls) => h("span", cls || "", text);

  function labelledIcon(kind, text, glyph) {
    const box = h("div", "geomap-pt geomap-pt-" + kind);
    const mark = h("span", "geomap-pt-glyph");
    if (glyph) mark.append(glyph);
    box.append(mark);
    const label = text ? h("span", "geomap-pt-label", text) : null;
    if (label) box.append(label);
    // A zero-size icon box: the glyph centres itself on the point in CSS, whatever the label width.
    return { icon: L.divIcon({ className: "geomap-icon", html: box, iconSize: [0, 0] }), label };
  }

  function hypothesisPopup(hyp, probability) {
    const box = h("div", "geomap-pop");
    box.append(h("div", "geomap-pop-title", hyp.label || "(unnamed)"));
    const meta = [Math.round(probability * 100) + "%"];
    if (hyp.radius_m > 0) meta.push("±" + fmtMeters(hyp.radius_m));
    box.append(h("div", "geomap-pop-meta", meta.join("  ·  ")));
    if (hyp.evidence) box.append(h("div", "geomap-pop-text", hyp.evidence));
    box.append(h("div", "geomap-pop-coord", fmtLatLng(hyp.lat, hyp.lng)));
    return box;
  }

  function applyHighlight() {
    const index = hovered !== null ? hovered : data.highlight;
    for (const [i, layers] of hypLayers) {
      const on = i === index;
      for (const layer of [layers.marker, layers.ring]) {
        const node = layer && layer.getElement && layer.getElement();
        if (node) node.classList.toggle("is-highlight", on);
      }
      if (on) layers.marker.bringToFront();
    }
  }

  function hover(index) {
    hovered = index;
    applyHighlight();
    if (typeof data.onHover === "function") data.onHover(index);
  }

  function drawHypotheses() {
    groups.hyps.clearLayers();
    groups.rings.clearLayers();
    hypLayers = new Map();
    // Largest first, so a small marker inside a big one stays on top and reachable.
    const order = data.hypotheses.map((hyp, index) => ({ hyp, index })).filter(({ hyp }) => hasPoint(hyp))
      .sort((a, b) => (b.hyp.probability || 0) - (a.hyp.probability || 0));
    for (const { hyp, index } of order) {
      const at = [hyp.lat, hyp.lng];
      const probability = clamp(isNum(hyp.probability) ? hyp.probability : 0, 0, 1);
      const radius = hypothesisRadius(probability);
      let ring = null;
      if (hyp.radius_m > 0) {
        ring = L.circle(at, { radius: hyp.radius_m, pane: paneName("rings"), className: "geomap-ring", weight: 1, fillOpacity: 0.07, interactive: false });
        ring.addTo(groups.rings);
      }
      const marker = L.circleMarker(at, { radius, pane: paneName("hyps"), className: "geomap-hyp", weight: 2, fillOpacity: 0.45, interactive });
      marker.bindTooltip(tipNode(Math.round(probability * 100) + "%"), { permanent: true, direction: "right", className: "geomap-tip", offset: [radius + 3, 0] });
      if (interactive) {
        marker.bindPopup(() => hypothesisPopup(hyp, probability), { className: "geomap-popup", maxWidth: 280, autoPanPadding: [16, 16] });
        // A layer with a popup keeps its click from the map, and a hypothesis is exactly where
        // the operator is likely to aim the geocode pin.
        marker.on("click", (event) => { if (pin) placePin(event.latlng); });
        marker.on("mouseover", () => hover(index));
        marker.on("mouseout", () => hover(null));
      }
      marker.addTo(groups.hyps);
      hypLayers.set(index, { marker, ring });
    }
    hovered = null;
    applyHighlight();
  }

  // The chosen point and, for a hedged list, the other distinct entries with their ranks.
  function drawAnswer() {
    groups.answer.clearLayers();
    groups.entries.clearLayers();
    const state = data.final ? "final" : "provisional";
    const distinct = groupEntries(data.entries);
    const answerKey = hasPoint(data.answer) ? fmtLatLng(data.answer.lat, data.answer.lng) : null;
    for (const group of distinct) {
      // The answer marker already stands here and carries these ranks in its label.
      if (fmtLatLng(group.lat, group.lng) === answerKey) continue;
      const { icon } = labelledIcon("entry is-" + state, "#" + group.label, null);
      L.marker([group.lat, group.lng], { icon, pane: paneName("entries"), interactive: false, keyboard: false }).addTo(groups.entries);
    }
    if (!answerKey) return;
    const own = distinct.find((group) => fmtLatLng(group.lat, group.lng) === answerKey);
    const text = state.toUpperCase() + " #" + (own ? own.label : "1");
    // Amber diamond while provisional, green diamond with a tick once final: shape and word as
    // well as colour.
    const { icon } = labelledIcon("answer is-" + state, text, data.final ? ICONS.check() : null);
    L.marker([data.answer.lat, data.answer.lng], { icon, pane: paneName("answer"), interactive: false, keyboard: false }).addTo(groups.answer);
  }

  function drawClusters() {
    groups.clusters.clearLayers();
    for (const cluster of data.clusters) {
      // A cluster of one is the hypothesis itself and needs no second outline.
      if (!hasPoint(cluster) || !(cluster.members > 1)) continue;
      const ringRadius = hypothesisRadius(cluster.probability) + 7;
      const layer = L.circleMarker([cluster.lat, cluster.lng], { radius: ringRadius, pane: paneName("clusters"), className: "geomap-cluster", weight: 1.5, fillOpacity: 0 });
      const share = isNum(cluster.probability) ? "  ·  " + Math.round(cluster.probability * 100) + "%" : "";
      layer.bindTooltip(tipNode("cluster of " + cluster.members + " hypotheses" + share), { className: "geomap-tip", sticky: true });
      layer.addTo(groups.clusters);
    }
  }

  function addLine(group, from, to, cls, label, permanent) {
    const layer = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], { pane: paneName("lines"), className: "geomap-line " + cls, weight: 2 });
    if (label) layer.bindTooltip(tipNode(label), { className: "geomap-tip", sticky: !permanent, permanent: !!permanent, direction: "center" });
    layer.addTo(group);
  }

  function drawTruth() {
    groups.truth.clearLayers();
    groups.truthLines.clearLayers();
    if (!hasPoint(data.truth)) return;
    groupEntries(data.truthLines).forEach((group, i) => {
      // The distance to the best-ranked answer is always shown; the others on hover.
      const distance = fmtMeters(haversineM(group, data.truth));
      addLine(groups.truthLines, group, data.truth, "geomap-line-truth", i === 0 ? distance : "#" + group.label + "  ·  " + distance, i === 0);
    });
    const { icon } = labelledIcon("truth", "TRUTH", ICONS.star());
    L.marker([data.truth.lat, data.truth.lng], { icon, pane: paneName("truth"), interactive: false, keyboard: false }).addTo(groups.truth);
  }

  function drawLines() {
    groups.lines.clearLayers();
    for (const line of data.lines) {
      if (!line || !hasPoint(line.from) || !hasPoint(line.to)) continue;
      const band = LINE_BANDS.includes(line.band) ? " geomap-band-" + line.band : "";
      addLine(groups.lines, line.from, line.to, "geomap-line-pair" + band, line.label ? String(line.label) : fmtMeters(haversineM(line.from, line.to)), false);
    }
  }

  function drawPath() {
    groups.path.clearLayers();
    const points = [];
    for (const point of data.path) {
      if (!hasPoint(point)) continue;
      const last = points[points.length - 1];
      if (last && last[0] === point.lat && last[1] === point.lng) continue;
      points.push([point.lat, point.lng]);
    }
    if (points.length < 2) return;
    L.polyline(points, { pane: paneName("path"), className: "geomap-path", weight: 2, interactive: false }).addTo(groups.path);
    points.forEach((at, i) => {
      const dot = L.circleMarker(at, { radius: i === points.length - 1 ? 4 : 2.5, pane: paneName("path"), className: "geomap-path-dot", weight: 1, fillOpacity: 1 });
      dot.bindTooltip(tipNode("top point " + (i + 1) + " of " + points.length), { className: "geomap-tip" });
      dot.addTo(groups.path);
    });
  }

  function drawMarkers() {
    groups.markers.clearLayers();
    const list = data.markers.filter(hasPoint);
    const onClick = typeof data.markerOptions.onClick === "function" ? data.markerOptions.onClick : null;
    list.forEach((item) => {
      const kind = MARKER_KINDS.includes(item.kind) ? item.kind : "eval";
      const text = item.label === undefined || item.label === null ? "" : String(item.label);
      // Many labels at once are unreadable: beyond a dozen they appear on hover instead.
      const permanent = item.permanent === undefined ? list.length <= 12 : !!item.permanent;
      const glyph = kind === "truth" ? ICONS.star() : kind === "answer" ? ICONS.check() : null;
      // Markers of kind "answer" show finished answers (evaluation results): the final style.
      const { icon } = labelledIcon(kind === "answer" ? "answer is-final" : kind, permanent ? text : "", glyph);
      const needsHover = !!text && !permanent;
      const marker = L.marker([item.lat, item.lng], { icon, pane: paneName("markers"), interactive: needsHover || !!onClick, keyboard: false });
      if (needsHover) marker.bindTooltip(tipNode(text), { className: "geomap-tip", direction: "top", offset: [0, -8] });
      if (onClick) marker.on("click", () => onClick(item, data.markers.indexOf(item)));
      marker.addTo(groups.markers);
    });
  }

  // ---- pin (the last-resort geocode: the one penalised thing on the map)

  function reportPin(latlng) {
    pin.point = normalizePoint(latlng);
    if (pin.label) pin.label.textContent = fmtLatLng(pin.point.lat, pin.point.lng);
    if (pin.onChange) pin.onChange({ ...pin.point });
  }

  function placePin(latlng) {
    if (!pin) return;
    if (map && !pin.marker) {
      const made = labelledIcon("pin", "", ICONS.pin());
      pin.label = h("span", "geomap-pt-label");
      made.icon.options.html.append(pin.label);
      pin.marker = L.marker(latlng, { icon: made.icon, pane: paneName("pin"), draggable: true, keyboard: false, autoPan: true });
      pin.marker.on("drag", () => reportPin(pin.marker.getLatLng()));
      pin.marker.on("dragend", () => reportPin(pin.marker.getLatLng()));
      pin.marker.addTo(map);
    } else if (pin.marker) {
      pin.marker.setLatLng(latlng);
    }
    reportPin(latlng);
  }

  function removePinMarker() {
    if (pin && pin.marker) pin.marker.remove();
    if (pin) { pin.marker = null; pin.label = null; pin.point = null; }
  }

  // clear() is the only way out of pin mode in the fixed API, so it both removes the pin and
  // stops listening for clicks. remove() only takes the pin off the map (still armed).
  function disablePin() {
    removePinMarker();
    pin = null;
    hint.hidden = true;
    root.classList.remove("is-pinning");
  }

  function enablePin(pinOptions) {
    disablePin();
    const session = { onChange: pinOptions && typeof pinOptions.onChange === "function" ? pinOptions.onChange : null, point: null, marker: null, label: null };
    pin = session;
    hint.hidden = false;
    root.classList.add("is-pinning");
    if (map) map.closePopup();
    const live = () => pin === session;
    return {
      get: () => (live() && session.point ? { ...session.point } : null),
      clear() { if (live()) disablePin(); },
      remove() { if (live()) removePinMarker(); },
      // Placed on the main copy of the world, where the view is.
      set(latlng) { if (live() && hasPoint(latlng)) placePin(normalizePoint(latlng)); },
    };
  }

  // ---- view

  function fitTargets() {
    const points = [...data.hypotheses, data.answer, ...data.entries, ...data.clusters, data.truth, ...data.truthLines, ...data.path, ...data.markers];
    for (const line of data.lines) if (line) points.push(line.from, line.to);
    return points.filter(hasPoint);
  }

  // Runs a view change that must not be mistaken for the operator moving the map. An animated
  // change starts its zoom a frame later, hence the time window as well as the counter.
  function moveMap(run, animatedMs) {
    programmatic += 1;
    if (animatedMs) programmaticUntil = performance.now() + animatedMs;
    try { run(); } finally { programmatic -= 1; }
  }

  function markStale(on) {
    fitButton.classList.toggle("is-stale", on);
    fitButton.title = on ? "The data moved on: fit to hypotheses" : "Fit to hypotheses";
  }

  // fit() is safe to call after every state update. It only moves the map when the points have
  // changed since the last fit, never while a pin is being placed, and not after the operator
  // has panned or zoomed by hand: then the Fit button lights up and the view waits for a click.
  // fit({force: true}) (the button) always fits.
  function fit(fitOptions = {}) {
    if (destroyed) return;
    if (!map) {
      pendingFit = { animate: !!fitOptions.animate, force: !!fitOptions.force || !!(pendingFit && pendingFit.force) };
      pendingView = null;
      return;
    }
    const points = fitTargets();
    if (!points.length) return;
    const sig = fitSignature(points);
    if (!fitOptions.force) {
      if (pin) return;
      if (sig === lastFitSig) return;
      if (userMoved) { markStale(true); return; }
    }
    lastFitSig = sig;
    viewMode = "fit";
    userMoved = false;
    markStale(false);
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    // Uncertainty rings belong in the picture too.
    for (const hyp of data.hypotheses) {
      if (hasPoint(hyp) && hyp.radius_m > 0) bounds.extend(L.latLng(hyp.lat, hyp.lng).toBounds(2 * hyp.radius_m));
    }
    const animate = !!fitOptions.animate && !reducedMotion();
    moveMap(() => map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16, animate }), animate ? 1200 : 0);
  }

  function flyTo(lat, lng, zoom) {
    if (destroyed || !isNum(lat) || !isNum(lng)) return;
    if (!map) { pendingView = { lat, lng, zoom }; pendingFit = null; return; }
    const target = isNum(zoom) ? zoom : Math.max(map.getZoom(), 12);
    viewMode = "fly";
    userMoved = false;
    markStale(false);
    if (reducedMotion()) moveMap(() => map.setView([lat, lng], target, { animate: false }), 0);
    else moveMap(() => map.flyTo([lat, lng], target, { duration: 1.6 }), 2400);
  }

  const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // A map that has never been positioned fits itself once when its first points arrive, so a
  // caller that only sets data still gets a useful view. Deferred to the end of the tick so the
  // hypotheses, answer and truth set together are fitted together.
  let firstFitQueued = false;
  function queueFirstFit() {
    if (firstFitQueued || lastFitSig !== null || viewMode || pendingView) return;
    firstFitQueued = true;
    Promise.resolve().then(() => {
      firstFitQueued = false;
      if (!destroyed && lastFitSig === null && !viewMode && !pendingView && !pendingFit) fit();
    });
  }

  function changed(draw) {
    if (destroyed) return;
    if (map) draw();
    queueFirstFit();
  }

  // ---- building the Leaflet map (lazily)

  function build() {
    map = L.map(canvas, {
      zoomControl: false,
      attributionControl: false,
      worldCopyJump: true,
      minZoom: 1,
      maxZoom: 19,
      dragging: interactive,
      touchZoom: interactive,
      doubleClickZoom: interactive,
      boxZoom: interactive,
      keyboard: interactive,
      // In a scrolling dashboard the wheel belongs to the page until the map has been pressed.
      scrollWheelZoom: interactive && opts.wheel === true,
    });
    map.setView([25, 0], 1, { animate: false });
    if (interactive) L.control.zoom({ position: "topleft" }).addTo(map);
    if (opts.scale !== false) L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);
    L.control.attribution({ prefix: false, position: "bottomright" }).addTo(map);

    gridColours = readGridColours(root);
    grid = createGridLayer(L, () => gridColours).addTo(map);
    tiles = {};
    for (const name of Object.keys(TILE_SOURCES)) {
      tiles[name] = L.tileLayer(TILE_SOURCES[name].url, { ...TILE_SOURCES[name].options, zIndex: 1 });
      watchTiles(name, tiles[name]);
    }
    applyLayer();

    for (const key of Object.keys(PANES)) map.createPane(paneName(key)).style.zIndex = String(PANES[key]);
    groups = {};
    for (const key of ["rings", "clusters", "lines", "truthLines", "path", "hyps", "entries", "markers", "answer", "truth"]) {
      groups[key] = L.layerGroup().addTo(map);
    }

    map.on("dragstart", () => { userMoved = true; });
    map.on("zoomstart", () => {
      if (programmatic === 0 && performance.now() > programmaticUntil) userMoved = true;
    });
    map.on("click", (event) => { if (pin) placePin(event.latlng); });
    // While the pin is being placed a click means "here", not "tell me about this hypothesis".
    map.on("popupopen", () => { if (pin) map.closePopup(); });
    if (interactive && opts.wheel === "focus") {
      canvas.addEventListener("pointerdown", () => map.scrollWheelZoom.enable());
      canvas.addEventListener("pointerleave", () => map.scrollWheelZoom.disable());
    }

    drawHypotheses();
    drawAnswer();
    drawClusters();
    drawTruth();
    drawLines();
    drawPath();
    drawMarkers();
    if (pin && pin.point) placePin(pin.point);

    if (pendingView) {
      const view = pendingView;
      pendingView = null;
      viewMode = "fly";
      moveMap(() => map.setView([view.lat, view.lng], isNum(view.zoom) ? view.zoom : 12, { animate: false }), 0);
    } else {
      const queued = pendingFit || {};
      pendingFit = null;
      fit({ force: !!queued.force });
    }
  }

  function tryBuild() {
    if (map || destroyed || !visible) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;
    try {
      build();
      // Built once; from here on only the size matters.
      if (intersection) intersection.disconnect();
    } catch (error) {
      // A broken map must not take the tile down with it: fall back to the plain notice.
      if (typeof console !== "undefined") console.error("map: could not create the Leaflet map", error);
      destroyed = true;
      disconnect();
      if (map) { try { map.remove(); } catch (_) { /* half-built */ } map = null; }
      unavailableMap(root);
    }
  }

  function invalidate() {
    if (destroyed) return;
    if (!map) { tryBuild(); return; }
    const before = map.getSize();
    map.invalidateSize({ animate: false });
    refreshGridColours();
    // A view that was following the data keeps doing so after the layout changed.
    if (viewMode === "fit" && !userMoved && !pin && !before.equals(map.getSize())) fit({ force: true });
  }

  function scheduleInvalidate() {
    if (invalidateFrame) return;
    invalidateFrame = requestAnimationFrame(() => { invalidateFrame = 0; invalidate(); });
  }

  const intersection = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) tryBuild();
    }, { rootMargin: "200px" })
    : null;
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => (map ? scheduleInvalidate() : tryBuild())) : null;
  // The grid is drawn on canvas and cannot follow CSS variables by itself.
  const theme = typeof MutationObserver === "function" ? new MutationObserver(() => { if (map) refreshGridColours(); }) : null;
  if (intersection) intersection.observe(root);
  if (resize) resize.observe(root);
  if (theme) theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
  window.addEventListener("online", onOnline);
  if (!resize) window.addEventListener("resize", scheduleInvalidate);
  tryBuild();

  function disconnect() {
    if (intersection) intersection.disconnect();
    if (resize) resize.disconnect();
    if (theme) theme.disconnect();
    window.removeEventListener("online", onOnline);
    window.removeEventListener("resize", scheduleInvalidate);
    if (invalidateFrame) cancelAnimationFrame(invalidateFrame);
  }

  const list = (value) => (Array.isArray(value) ? value : []);

  return {
    // hyps: [{lat, lng, probability, radius_m, label, evidence}]; onHover(index|null) gets the
    // index in this array.
    setHypotheses(hyps, hypOptions = {}) {
      data.hypotheses = list(hyps);
      data.onHover = (hypOptions && hypOptions.onHover) || null;
      changed(drawHypotheses);
    },
    highlightHypothesis(index) {
      data.highlight = isNum(index) ? index : null;
      if (map) applyHighlight();
    },
    setAnswer(entry, answerOptions = {}) {
      data.answer = hasPoint(entry) ? entry : null;
      data.final = !!(answerOptions && answerOptions.final);
      changed(drawAnswer);
    },
    setEntries(entries) {
      data.entries = list(entries);
      changed(drawAnswer);
    },
    // points: [{lat, lng, probability, members}] (TileState.cluster_points).
    setClusters(points) {
      data.clusters = list(points);
      changed(drawClusters);
    },
    setTruth(point, truthOptions = {}) {
      data.truth = hasPoint(point) ? point : null;
      data.truthLines = list(truthOptions && truthOptions.lines);
      changed(drawTruth);
    },
    setPath(points) {
      data.path = list(points);
      changed(drawPath);
    },
    // markers: [{lat, lng, label, kind: "truth"|"answer"|"eval"|"option", permanent?}];
    // options.onClick(marker, index).
    setMarkers(markers, markerOptions = {}) {
      data.markers = list(markers);
      data.markerOptions = markerOptions || {};
      changed(drawMarkers);
    },
    // lines: [{from: {lat, lng}, to: {lat, lng}, band?: "100m"|"1km"|"10km"|"far", label?}].
    setLines(lines) {
      data.lines = list(lines);
      changed(drawLines);
    },
    fit,
    flyTo,
    setLayer,
    enablePin,
    invalidate,
    destroy() {
      if (destroyed) { root.remove(); return; }
      destroyed = true;
      disconnect();
      if (map) map.remove();
      map = null;
      root.remove();
    },
    el: root,
    available: true,
  };
}
