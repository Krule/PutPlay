// Buffering detection (MediaEngine.onTime heuristic).
//
// The old inline condition was inverted: `currentTime < bufferedEnd - 2`
// is TRUE whenever the buffer is MORE than 2s ahead — i.e. during normal,
// healthy playback — and FALSE during a real stall. Correct semantics:
// "buffering" = the playhead has reached within 2s of the end of buffered
// data (waiting on network) — UNLESS the media is fully buffered, in which
// case reaching the buffer end is just end-of-file, not a stall.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBuffering } from "../src/putio/progress.ts";

test("healthy stream (buffer 10s ahead) → not buffering", () => {
  assert.equal(isBuffering(10, 20, 3600), false);
});

test("playhead within 2s of buffer end (stall) → buffering", () => {
  assert.equal(isBuffering(29.5, 30, 3600), true);
  assert.equal(isBuffering(30, 30, 3600), true);
});

test("nothing buffered yet → buffering", () => {
  assert.equal(isBuffering(0, 0, 3600), true);
});

test("fully-buffered file: last 2s is end-of-file, NOT buffering", () => {
  assert.equal(isBuffering(53.6, 60, 60), false);
  assert.equal(isBuffering(59.9, 60, 60), false);
});

test("fully-buffered file: mid-file → not buffering", () => {
  assert.equal(isBuffering(10, 60, 60), false);
});

test("live stream (duration Infinity): stall near buffer edge → buffering", () => {
  assert.equal(isBuffering(100.1, 100.5, Infinity), true);
  assert.equal(isBuffering(100, 110, Infinity), false);
});
