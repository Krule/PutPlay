// Unit tests for the resume prompt decision (src/putio/resume.ts).
// BUG 1: "Start from beginning" used to resume from the last saved position
// because the engine auto-applied resume (seek to from-5) before the user
// could choose, and the prompt's seeks were no-ops while duration was 0.
//
// The decision is extracted as a pure function so it is testable in node:
//   shouldShowResumePrompt(startFrom) — is there a real saved position?
//   initialSeekTarget(startFrom, choice) — where to put the playhead, and
//     whether it may apply immediately (t>0) or must wait for metadata (t=0).
//
// Run: pnpm test

import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const out = join(mkdtempSync(join(tmpdir(), "putio-test-")), "resume.cjs");
await build({
  entryPoints: ["src/putio/resume.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const require = createRequire(import.meta.url);
const { shouldShowResumePrompt, initialSeekTarget, RESUME_MIN, NEAR_START_MAX } = require(out);

// ---------------- shouldShowResumePrompt ----------------

test("no saved position (0) → no prompt", () => {
  assert.equal(shouldShowResumePrompt(0), false);
  assert.equal(shouldShowResumePrompt(null), false);
  assert.equal(shouldShowResumePrompt(undefined), false);
});

test("trivially small saved position → no prompt (nothing to skip past)", () => {
  assert.equal(shouldShowResumePrompt(5), false);
  assert.equal(shouldShowResumePrompt(29.5), false);
});

test("real saved position (> RESUME_MIN) → prompt", () => {
  assert.equal(shouldShowResumePrompt(RESUME_MIN + 1), true);
  assert.equal(shouldShowResumePrompt(120), true);
  assert.equal(shouldShowResumePrompt(7123.4), true);
});

// ---------------- initialSeekTarget ----------------

test("'resume' choice seeks to saved-5 immediately when we're still near the start", () => {
  const t = initialSeekTarget(120, "resume", { currentTime: 3, duration: 0 });
  assert.equal(t.time, 115); // 120 - 5
  assert.equal(t.applyNow, true); // t > 0, valid even before metadata
});

test("'resume' choice is clamped at 0 for tiny saved positions", () => {
  const t = initialSeekTarget(3, "resume", { currentTime: 1, duration: 7200 });
  assert.equal(t.time, 0);
  assert.equal(t.applyNow, false);
});

test("'beginning' choice targets 0 — even if we're already sitting at from-5", () => {
  // The regression: user is at 115 (auto-resumed) and presses "Start from beginning".
  const t = initialSeekTarget(120, "beginning", { currentTime: 115, duration: 0 });
  assert.equal(t.time, 0);
  assert.equal(t.applyNow, false); // 0 seeks need metadata first
});

test("'beginning' choice works after metadata loaded too", () => {
  const t = initialSeekTarget(120, "beginning", { currentTime: 5, duration: 7200 });
  assert.equal(t.time, 0);
  assert.equal(t.applyNow, false);
});

test("resume target is deferred when metadata is missing and target is 0", () => {
  const t = initialSeekTarget(5, "resume", { currentTime: 0, duration: 0 });
  assert.equal(t.time, 0);
  assert.equal(t.applyNow, false);
});
