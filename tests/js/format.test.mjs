import test from "node:test";
import assert from "node:assert/strict";

import {
  fmtAgo,
  fmtBytes,
  fmtClock,
  fmtCoord,
  fmtCountdown,
  fmtDateTime,
  fmtDist,
  fmtDuration,
  fmtInt,
  fmtLatLng,
  fmtMult,
  fmtPct,
  fmtTime,
  fmtUsd,
  plural,
} from "../../server/static/console/js/format.js";

const DASH = "–";

test("fmtMult", () => {
  assert.equal(fmtMult(1), "x1.0");
  assert.equal(fmtMult(0.76), "x0.76");
  assert.equal(fmtMult(0.8), "x0.8");
  assert.equal(fmtMult(0.95), "x0.95");
  assert.equal(fmtMult(0.5), "x0.5");
  assert.equal(fmtMult(0.722), "x0.722");
  assert.equal(fmtMult(0.8 * 0.95 * 0.95), "x0.722");
  assert.equal(fmtMult(null), "x1.0", "no ledger yet means no penalty");
  assert.equal(fmtMult(undefined), "x1.0");
  assert.equal(fmtMult("abc"), DASH);
});

test("fmtCoord and fmtLatLng use 6 decimals", () => {
  assert.equal(fmtCoord(38.7169), "38.716900");
  assert.equal(fmtCoord(-9.1399001234), "-9.139900");
  assert.equal(fmtCoord(null), DASH);
  assert.equal(fmtLatLng(38.7169, -9.1399), "38.716900, -9.139900");
  assert.equal(fmtLatLng(0, 0), "0.000000, 0.000000");
  assert.equal(fmtLatLng(null, 1), DASH);
});

test("fmtClock", () => {
  assert.equal(fmtClock(0), "00:00");
  assert.equal(fmtClock(462), "07:42");
  assert.equal(fmtClock(462.9), "07:42");
  assert.equal(fmtClock(3599), "59:59");
  assert.equal(fmtClock(4062), "1:07:42");
  assert.equal(fmtClock(-5), "00:00");
  assert.equal(fmtClock(null), "--:--");
});

test("fmtCountdown rounds up so it never shows 0:00 while time remains", () => {
  assert.equal(fmtCountdown(47), "0:47");
  assert.equal(fmtCountdown(46.2), "0:47");
  assert.equal(fmtCountdown(252), "4:12");
  assert.equal(fmtCountdown(0), "0:00");
  assert.equal(fmtCountdown(-3), "0:00");
  assert.equal(fmtCountdown(undefined), "-:--");
});

test("fmtDuration", () => {
  assert.equal(fmtDuration(0.42), "0.4 s");
  assert.equal(fmtDuration(4.25), "4.3 s");
  assert.equal(fmtDuration(4), "4 s");
  assert.equal(fmtDuration(42), "42 s");
  assert.equal(fmtDuration(59.6), "1 min 00 s");
  assert.equal(fmtDuration(462), "7 min 42 s");
  assert.equal(fmtDuration(3720), "1 h 02 min");
  assert.equal(fmtDuration(null), DASH);
});

test("fmtAgo", () => {
  assert.equal(fmtAgo(3.2), "3 s ago");
  assert.equal(fmtAgo(125), "2 min ago");
  assert.equal(fmtAgo(7300), "2 h ago");
  assert.equal(fmtAgo(-1), "0 s ago");
  assert.equal(fmtAgo(null), DASH);
});

test("fmtUsd", () => {
  assert.equal(fmtUsd(0), "$0.00");
  assert.equal(fmtUsd(0.004), "$0.004");
  assert.equal(fmtUsd(0.42), "$0.42");
  assert.equal(fmtUsd(12.3), "$12.30");
  assert.equal(fmtUsd(1234.5), "$1,234.50");
  assert.equal(fmtUsd(-2), "-$2.00");
  assert.equal(fmtUsd(undefined), DASH);
});

test("fmtDist", () => {
  assert.equal(fmtDist(0), "0 m");
  assert.equal(fmtDist(85.4), "85 m");
  assert.equal(fmtDist(999.6), "1.0 km");
  assert.equal(fmtDist(1234), "1.2 km");
  assert.equal(fmtDist(25_400), "25.4 km");
  assert.equal(fmtDist(1_234_567), "1,235 km");
  assert.equal(fmtDist(null), DASH);
});

test("fmtPct takes a share between 0 and 1", () => {
  assert.equal(fmtPct(0.764), "76%");
  assert.equal(fmtPct(0.764, 1), "76.4%");
  assert.equal(fmtPct(1), "100%");
  assert.equal(fmtPct(0), "0%");
  assert.equal(fmtPct(null), DASH);
});

test("fmtBytes", () => {
  assert.equal(fmtBytes(0), "0 B");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(1536), "1.5 KB");
  assert.equal(fmtBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(fmtBytes(340 * 1024 * 1024), "340 MB");
  assert.equal(fmtBytes(3.2 * 1024 ** 3), "3.2 GB");
  assert.equal(fmtBytes(""), DASH);
});

test("fmtTime and fmtDateTime print local time", () => {
  const date = new Date(2026, 9, 11, 14, 3, 22);
  assert.equal(fmtTime(date), "14:03:22");
  assert.equal(fmtTime(date.toISOString()), "14:03:22");
  assert.equal(fmtTime(date.getTime()), "14:03:22", "epoch milliseconds");
  assert.equal(fmtTime(date.getTime() / 1000), "14:03:22", "epoch seconds");
  assert.equal(fmtDateTime(date.toISOString()), "2026-10-11 14:03");
  assert.equal(fmtTime("not a date"), DASH);
  assert.equal(fmtTime(null), DASH);
  assert.equal(fmtDateTime(undefined), DASH);
});

test("fmtInt", () => {
  assert.equal(fmtInt(0), "0");
  assert.equal(fmtInt(999), "999");
  assert.equal(fmtInt(16050), "16,050");
  assert.equal(fmtInt(1234567.6), "1,234,568");
  assert.equal(fmtInt(-1200), "-1,200");
  assert.equal(fmtInt(null), DASH);
});

test("plural", () => {
  assert.equal(plural(1, "panorama"), "1 panorama");
  assert.equal(plural(6, "panorama"), "6 panoramas");
  assert.equal(plural(0, "cue"), "0 cues");
  assert.equal(plural(2, "retry", "retries"), "2 retries");
  assert.equal(plural(1500, "event"), "1,500 events");
});
