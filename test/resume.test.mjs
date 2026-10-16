// Unit tests for the auto-resume decision (src/putio/resume.ts).
//
// Locked decision L1: PURE AUTO-RESUME. There is no prompt and no choice —
// reopening a file with a saved position simply starts where the viewer
// left off, and "start from beginning" is a seek to 0 on the scrubber.
//
// The engine's ONE rule lives here as a pure function so it is testable in
// node and shared (the MediaEngine fetches the saved position and applies
// the seek; this module only decides where):
//   autoResumeTarget(startFrom, currentTime)
//     — a real saved position (> RESUME_MIN) with the playhead still near
//       the start (the file is being OPENED, not replayed) → seek to
//       saved-lead, clamped at 0. Otherwise: no auto-resume (null).
//
// Run: pnpm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { autoResumeTarget, RESUME_MIN, NEAR_START_MAX, RESUME_LEAD } from "../src/putio/resume.ts";

test("constants: the rule's three thresholds are the locked values", () => {
  assert.equal(RESUME_MIN, 30); // smaller saved positions are "no real position"
  assert.equal(NEAR_START_MAX, 60); // auto-resume only while still near the start
  assert.equal(RESUME_LEAD, 5); // a few seconds of context before the saved mark
});

test("no saved position → no auto-resume", () => {
  assert.equal(autoResumeTarget(0, 0), null);
  assert.equal(autoResumeTarget(null, 0), null);
  assert.equal(autoResumeTarget(undefined, 0), null);
});

test("trivially small saved position → no auto-resume (nothing to skip past)", () => {
  assert.equal(autoResumeTarget(5, 0), null);
  assert.equal(autoResumeTarget(RESUME_MIN, 0), null); // 30 itself is not "real"
});

test("a real saved position, file still near the start → seek to saved minus the lead", () => {
  assert.deepEqual(autoResumeTarget(120, 0), { time: 120 - RESUME_LEAD });
  assert.deepEqual(autoResumeTarget(120, 3), { time: 115 });
  // the smallest "real" position lands at saved-lead — the 0-clamp in the
  // implementation is defensive (from > RESUME_MIN keeps saved-lead positive)
  assert.deepEqual(autoResumeTarget(RESUME_MIN + 1, 0), { time: RESUME_MIN + 1 - RESUME_LEAD });
});

test("not near the start (a mid-file replay) → no auto-resume", () => {
  assert.equal(autoResumeTarget(120, NEAR_START_MAX), null); // 60 itself is "not near"
  assert.equal(autoResumeTarget(120, 600), null);
});
