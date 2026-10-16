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
//
// Run: pnpm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { scrubSeek, scrubThumbPct } from "../src/putio/scrub.ts";

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
