// Unit tests for the D-pad scrubber decisions (src/putio/scrub.ts).
//
// On the TV, ←/→ on the D-pad is a REAL seek: the playhead jumps ±step
// seconds from where it sits. The scrubber row (fill bar, thumb, time
// bubble) is rendered from the same two decisions, so the rules are
// extracted as pure functions testable in node:
//   scrubSeek(t, dur, dir, step) — where the ←/→ press lands, clamped to
//     [0, dur]. Live/unknown duration (0, negative, non-finite) is a
//     guard, not a feature: no seek — the row renders LIVE instead of a
//     bar.
//   scrubThumbPct(t, dur) — playhead percentage 0..100 for the fill and
//     thumb, 0 when the duration is unknown/live.
//   segSpans(segs, dur) — where each skippable segment sits on the bar,
//     as percentage spans {left, width} for the .bar-seg overlays; [] when
//     the duration is unknown/live (no bar to mark).
//
// Run: pnpm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { scrubSeek, scrubThumbPct, segSpans, barTrackFraction, trackLeftCss } from "../src/putio/scrub.ts";

const DUR = 7200; // two-hour episode
const STEP = 10;

// ---------------- scrubSeek ----------------

test("right seek moves the playhead +step from the current time", () => {
  assert.equal(scrubSeek(100, DUR, 1, STEP), 110);
});

test("left seek moves the playhead -step from the current time", () => {
  assert.equal(scrubSeek(100, DUR, -1, STEP), 90);
});

test("left-of-step seeks clamp at 0", () => {
  assert.equal(scrubSeek(3, DUR, -1, STEP), 0);
  assert.equal(scrubSeek(0, DUR, -1, STEP), 0);
});

test("right-of-end seeks clamp at duration", () => {
  assert.equal(scrubSeek(7198, DUR, 1, STEP), DUR);
  assert.equal(scrubSeek(DUR, DUR, 1, STEP), DUR);
});

test("fractional times stay fractional", () => {
  assert.equal(scrubSeek(10.5, DUR, 1, STEP), 20.5);
});

test("not started yet (t = 0): a right seek lands on the step", () => {
  assert.equal(scrubSeek(0, DUR, 1, STEP), STEP);
});

test("negative t is treated as 0 for the math (still clamps correctly)", () => {
  assert.equal(scrubSeek(-5, DUR, 1, STEP), STEP); // 0 + 10, not -5 + 10
  assert.equal(scrubSeek(-5, DUR, -1, STEP), 0);
});

test("live/unknown duration (0): no seek — t returned unchanged", () => {
  assert.equal(scrubSeek(100, 0, 1, STEP), 100);
  assert.equal(scrubSeek(100, 0, -1, STEP), 100);
});

test("negative duration: no seek — t returned unchanged", () => {
  assert.equal(scrubSeek(100, -5, 1, STEP), 100);
});

test("non-finite duration (NaN, Infinity): no seek — t returned unchanged", () => {
  assert.equal(scrubSeek(100, NaN, 1, STEP), 100);
  assert.equal(scrubSeek(100, Infinity, 1, STEP), 100);
});

// ---------------- scrubThumbPct ----------------

test("playhead at the start → 0", () => {
  assert.equal(scrubThumbPct(0, DUR), 0);
});

test("playhead at the end → 100", () => {
  assert.equal(scrubThumbPct(DUR, DUR), 100);
});

test("playhead halfway → 50", () => {
  assert.equal(scrubThumbPct(3600, DUR), 50);
});

test("overshot playhead is clamped into [0, 100]", () => {
  assert.equal(scrubThumbPct(8000, DUR), 100);
  assert.equal(scrubThumbPct(-5, DUR), 0);
});

test("live/unknown duration (0, negative, non-finite) → 0", () => {
  assert.equal(scrubThumbPct(100, 0), 0);
  assert.equal(scrubThumbPct(100, -1), 0);
  assert.equal(scrubThumbPct(100, NaN), 0);
  assert.equal(scrubThumbPct(100, Infinity), 0);
});

// ---------------- segSpans ----------------
// The bar's skippable-segment overlays render from these spans (the Player
// owns no span math of its own). Spans are percentages of the bar, in input
// order. DUR 7200 with quarter-aligned windows keeps every expected value
// exactly representable in binary (no float-noise assertions).

const INTRO = { type: "intro", start: 1800, end: 2700 }; // 25% – 37.5%
const CREDITS = { type: "credits", start: 6840, end: null }; // 95% – end

test("no segments → no spans", () => {
  assert.deepEqual(segSpans([], DUR), []);
});

test("live/unknown duration (0, negative, non-finite) → no spans (no bar to mark)", () => {
  assert.deepEqual(segSpans([INTRO], 0), []);
  assert.deepEqual(segSpans([INTRO], -1), []);
  assert.deepEqual(segSpans([INTRO], NaN), []);
  assert.deepEqual(segSpans([INTRO], Infinity), []);
});

test("a mid-file segment maps to its percentage span", () => {
  assert.deepEqual(segSpans([INTRO], DUR), [{ left: 25, width: 12.5 }]);
});

test("a credits segment (end: null) runs to the end of the bar", () => {
  assert.deepEqual(segSpans([CREDITS], DUR), [{ left: 95, width: 5 }]);
});

test("multiple spans keep the input order", () => {
  assert.deepEqual(segSpans([INTRO, CREDITS], DUR), [
    { left: 25, width: 12.5 },
    { left: 95, width: 5 },
  ]);
});

test("a segment starting at the duration is not visible (dropped)", () => {
  assert.deepEqual(segSpans([{ type: "intro", start: DUR, end: DUR + 60 }], DUR), []);
});

test("a segment starting past the duration is bad data (dropped)", () => {
  assert.deepEqual(segSpans([{ type: "intro", start: DUR + 5, end: null }], DUR), []);
});

test("a negative start clamps to the bar's left edge", () => {
  assert.deepEqual(segSpans([{ type: "intro", start: -30, end: 90 }], DUR), [
    { left: 0, width: 1.25 },
  ]);
});

test("a zero-length segment is not visible (dropped)", () => {
  assert.deepEqual(segSpans([{ type: "intro", start: 1800, end: 1800 }], DUR), []);
});

// ---------------- barTrackFraction ----------------
// The pointer (Magic Remote / mouse) position on the bar's hit area, as a
// fraction of the VISIBLE track — the track is inset 20px from each end of
// the (much taller) hit area. Click-seek and the hover preview must agree
// on the same geometry, so both call this one function.

const B_LEFT = 100;
const B_WIDTH = 900; // visible track spans 120..980 (860px), hit area 100..1000

test("a pointer position maps to its fraction of the visible track (20px inset)", () => {
  assert.ok(Math.abs(barTrackFraction(550, B_LEFT, B_WIDTH) - 0.5) < 1e-9, "dead center of the track is 0.5");
  assert.equal(barTrackFraction(120, B_LEFT, B_WIDTH), 0, "the track's left edge is 0");
  assert.equal(barTrackFraction(980, B_LEFT, B_WIDTH), 1, "the track's right edge is 1");
});

test("a pointer outside the hit area clamps to the track ends", () => {
  assert.equal(barTrackFraction(0, B_LEFT, B_WIDTH), 0);
  assert.equal(barTrackFraction(5000, B_LEFT, B_WIDTH), 1);
});

test("a hit area narrower than the track insets is an honest zero (no division into nothing)", () => {
  assert.equal(barTrackFraction(20, B_LEFT, 40), 0);
  assert.equal(barTrackFraction(20, B_LEFT, 39), 0);
});

test("trackLeftCss places a point of the visible track (the inverse of barTrackFraction's geometry)", () => {
  assert.equal(trackLeftCss(0), "calc(20px + (100% - 40px) * 0)", "the track's left edge is the 20px inset");
  assert.equal(trackLeftCss(100), "calc(20px + (100% - 40px) * 1)", "the track's right edge is the full inset span");
  assert.equal(trackLeftCss(50), "calc(20px + (100% - 40px) * 0.5)", "the middle is half of (100% − 40px) past the inset");
});
