// Unit tests for the player progress percentage (src/putio/progress.ts).
// Pure math — the Player binds its result to a reactive value so the bar
// track/fill actually move during playback.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { progressPct } from "../src/putio/progress.ts";

test("no usable duration (0, NaN, negative) → 0, not NaN", () => {
  assert.equal(progressPct(5, 0), 0);
  assert.equal(progressPct(5, NaN), 0);
  assert.equal(progressPct(5, -10), 0);
});

test("live stream (Infinity duration) → 0 (the bar has no meaning for live)", () => {
  assert.equal(progressPct(120, Infinity), 0);
});

test("mid-video: proportional", () => {
  assert.equal(progressPct(30, 120), 25);
  assert.ok(Math.abs(progressPct(1, 3) - 33.3333) < 0.001);
});

test("clamps to 100 at and past the end", () => {
  assert.equal(progressPct(120, 120), 100);
  assert.equal(progressPct(150, 120), 100);
});

test("negative or NaN currentTime → 0", () => {
  assert.equal(progressPct(-5, 100), 0);
  assert.equal(progressPct(NaN, 100), 0);
});
