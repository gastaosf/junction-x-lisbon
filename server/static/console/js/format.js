// Formatting helpers. Pure: no DOM, no locale lookups, so the same value prints the same way on
// the operator's laptop, on the projector and under `node --test`.

const DASH = "–";

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const pad2 = (n) => String(n).padStart(2, "0");

function grouped(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Penalty multiplier: 0.76 -> "x0.76", 1 -> "x1.0". A missing value means "no penalty yet". */
export function fmtMult(m) {
  if (m === null || m === undefined) return "x1.0";
  const n = num(m);
  if (n === null) return DASH;
  return "x" + n.toFixed(3).replace(/0+$/, "").replace(/\.$/, ".0");
}

/** One coordinate with the 6 decimals the submission format uses. */
export function fmtCoord(v) {
  const n = num(v);
  return n === null ? DASH : n.toFixed(6);
}

export function fmtLatLng(lat, lng) {
  if (num(lat) === null || num(lng) === null) return DASH;
  return fmtCoord(lat) + ", " + fmtCoord(lng);
}

/** Clock for elapsed and remaining time: "07:42", and "1:07:42" from one hour up. */
export function fmtClock(s) {
  const n = num(s);
  if (n === null) return "--:--";
  const total = Math.max(0, Math.floor(n));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0 ? h + ":" + pad2(m) + ":" + pad2(sec) : pad2(m) + ":" + pad2(sec);
}

/** Short countdown for titles and chips: "0:47", "12:05". */
export function fmtCountdown(s) {
  const n = num(s);
  if (n === null) return "-:--";
  const total = Math.max(0, Math.ceil(n));
  return Math.floor(total / 60) + ":" + pad2(total % 60);
}

/** A length of time in words: "0.4 s", "42 s", "7 min 42 s", "1 h 07 min". */
export function fmtDuration(s) {
  const n = num(s);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  if (abs < 10 && !Number.isInteger(abs)) return n.toFixed(1) + " s";
  const total = Math.round(abs);
  const sign = n < 0 ? "-" : "";
  if (total < 60) return sign + total + " s";
  if (total < 3600) return sign + Math.floor(total / 60) + " min " + pad2(total % 60) + " s";
  return sign + Math.floor(total / 3600) + " h " + pad2(Math.floor((total % 3600) / 60)) + " min";
}

/** "3 s ago", "2 min ago": the age of the last event or the last contact with the server. */
export function fmtAgo(s) {
  const n = num(s);
  if (n === null) return DASH;
  const total = Math.max(0, Math.round(n));
  if (total < 60) return total + " s ago";
  if (total < 3600) return Math.floor(total / 60) + " min ago";
  return Math.floor(total / 3600) + " h ago";
}

/** Money: two decimals, three below ten cents so a single cheap turn does not read as $0.00. */
export function fmtUsd(v) {
  const n = num(v);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.1 ? 3 : 2;
  const [whole, frac] = abs.toFixed(digits).split(".");
  return (n < 0 ? "-$" : "$") + grouped(whole) + "." + frac;
}

/** Distance in metres: "85 m", "1.2 km", "1,234 km". */
export function fmtDist(m) {
  const n = num(m);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  if (Math.round(abs) < 1000) return Math.round(n) + " m";
  const km = abs / 1000;
  const sign = n < 0 ? "-" : "";
  if (km < 100) return sign + km.toFixed(1) + " km";
  return sign + grouped(String(Math.round(km))) + " km";
}

/** A share between 0 and 1 as a percentage: fmtPct(0.764) -> "76%", fmtPct(0.764, 1) -> "76.4%". */
export function fmtPct(v, digits = 0) {
  const n = num(v);
  return n === null ? DASH : (n * 100).toFixed(digits) + "%";
}

export function fmtBytes(v) {
  const n = num(v);
  if (n === null) return DASH;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.abs(n);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return (n < 0 ? "-" : "") + text + " " + units[unit];
}

// The server sends ISO strings in most places and epoch seconds in a few (event `ts`), so accept
// both; a number too large to be seconds is taken as milliseconds.
function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  let date;
  if (value instanceof Date) date = value;
  else if (typeof value === "number") date = new Date(value < 1e11 ? value * 1000 : value);
  else date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Local wall-clock time, "14:03:22". */
export function fmtTime(iso) {
  const d = toDate(iso);
  if (!d) return DASH;
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

/** Local date and time, "2026-10-11 14:03". */
export function fmtDateTime(iso) {
  const d = toDate(iso);
  if (!d) return DASH;
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/** Whole number with thousands separators: 16050 -> "16,050". */
export function fmtInt(v) {
  const n = num(v);
  if (n === null) return DASH;
  const rounded = Math.round(n);
  return (rounded < 0 ? "-" : "") + grouped(String(Math.abs(rounded)));
}

/** "1 panorama", "6 panoramas". Pass the plural when adding an "s" is wrong. */
export function plural(n, word, pluralWord) {
  const count = num(n) ?? 0;
  return fmtInt(count) + " " + (count === 1 ? word : pluralWord ?? word + "s");
}
