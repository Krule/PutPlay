// Stream buffering (issue: "a better, larger stream buffer for the original
// stream — the current one suffers from interruptions").
//
// Two halves:
//   1. The HLS source IS engine-controlled (hls.js) — its buffer must be
//      deep: a TV viewer sits still, so start-latency trades freely for
//      immunity to network dips. (Source gate on the hls.js config.)
//   2. The NATIVE original stream's buffer belongs to the webview — no
//      HTML5 API grows it. What the app CAN do is count mid-playback
//      stalls and, after a threshold, say so once per file and point at
//      the smoother engine-buffered stream. The decision is pure
//      (shouldAdviseSmootherSource in putio/stall.ts).
//
// Run: pnpm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const out = join(mkdtempSync(join(tmpdir(), "putio-test-")), "stall.cjs");
await build({
  entryPoints: ["src/putio/stall.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const require = createRequire(import.meta.url);
const { STALL_ADVISORY_THRESHOLD, shouldAdviseSmootherSource } = require(out);

test("no advisory below the threshold", () => {
  assert.equal(
    shouldAdviseSmootherSource({ source: "original", stalls: STALL_ADVISORY_THRESHOLD - 1, advised: false }),
    false
  );
});

test("at the threshold, the original advises the smoother stream", () => {
  assert.equal(
    shouldAdviseSmootherSource({ source: "original", stalls: STALL_ADVISORY_THRESHOLD, advised: false }),
    true
  );
});

test("never advises for engine-buffered sources (mp4/hls already ARE the advice)", () => {
  assert.equal(
    shouldAdviseSmootherSource({ source: "mp4", stalls: 10, advised: false }),
    false
  );
  assert.equal(
    shouldAdviseSmootherSource({ source: "hls", stalls: 10, advised: false }),
    false
  );
});

test("the advice is once per file — never a nag loop", () => {
  assert.equal(
    shouldAdviseSmootherSource({ source: "original", stalls: 99, advised: true }),
    false
  );
});

const media = read("src/putio/media.ts");

test("HLS source runs a deep buffer (60s target / 90s ceiling)", () => {
  assert.ok(
    /maxBufferLength:\s*60/.test(media),
    "hls.js maxBufferLength must be 60 (was 30 — the reported interruptions)"
  );
  assert.ok(
    /maxMaxBufferLength:\s*90/.test(media),
    "hls.js maxMaxBufferLength must be 90 so the buffer can actually grow past the 60s auto-cap"
  );
});

test("the engine counts mid-playback stalls and reports them in state", () => {
  assert.ok(
    /private stalls/.test(media),
    "MediaEngine must keep a per-source stall counter"
  );
  assert.ok(
    /stalls\?:\s*number/.test(media),
    "MediaState must expose stalls so the Player can drive the advisory"
  );
});

const player = read("src/ui/screens/Player.svelte");

test("the Player drives the advisory through the pure decision (toast once)", () => {
  assert.ok(
    /shouldAdviseSmootherSource\(/.test(player),
    "the stall advisory must go through the pure, tested shouldAdviseSmootherSource"
  );
  assert.ok(
    /stallAdvised\s*=\s*true/.test(player),
    "the Player must latch the advice (once per file)"
  );
});
