// Buffering (the spinner) semantics — EVENT-DRIVEN.
//
// The old design recomputed "buffering" from buffer geometry on EVERY
// timeupdate tick (isBuffering: "within 2s of the buffer end"). On a
// just-in-time-buffered HLS stream — the buffer hugs the playhead, the
// normal put.io 1080p case on a TV connection — that geometry is true
// almost always, so the spinner spun continuously although playback was
// perfectly smooth (user-reported on the LG C1, 2026-10-17).
//
// Correct semantics: the spinner mirrors a real STALL — the browser's own
// waiting/playing events. A tight buffer that never stops playback never
// fires 'waiting' → no spinner. A real stall fires 'waiting' → spinner
// until 'playing'. A one-way ratchet in onTime (the playhead is visibly
// advancing) clears a stuck state in case a 'playing' event is ever
// missed. The ratchet only CLEARS — events set the truth.
//
// The engine has no unit event harness (it binds to a real <video>), so
// this contract is pinned by source gates — the same house pattern the
// Player.svelte rules use.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");
const mediaSrc = read("src/putio/media.ts");
const progressSrc = read("src/putio/progress.ts");
/** The body of a `private <name> = () => { … };` engine method. */
const fnBody = (name) => {
  const m = mediaSrc.match(new RegExp(`private ${name} = \\(\\) => \\{([\\s\\S]*?)\\n  \\};`));
  assert.ok(m, `the ${name} method is there`);
  return m[1];
};

test("the playhead tick never computes buffering from buffer geometry again", () => {
  assert.ok(
    !/isBuffering/.test(mediaSrc),
    "media.ts must not reference the geometry heuristic (it spun the spinner on healthy just-in-time streams)"
  );
});

test("the geometry heuristic is deleted from progress.ts (dead code after the event-driven fix)", () => {
  // the declaration is gone (a historical comment may name it — that is
  // documentation, not code)
  assert.ok(!/export function isBuffering/.test(progressSrc), "the function is deleted, not just unused");
  assert.ok(/export function progressPct/.test(progressSrc), "progressPct (the bar) is untouched");
});

test("the stall events own the truth: waiting → buffering, playing → clears it", () => {
  assert.ok(/buffering: true/.test(fnBody("onWait")), "a waiting event asserts buffering");
  assert.ok(/buffering: false/.test(fnBody("onPlaying")), "a playing event clears it");
});

test("a load starts buffered and a seek re-asserts buffering (the spinner during load/seek)", () => {
  assert.ok(
    /onState\(\{\s*error: null, buffering: true/.test(mediaSrc),
    "the load path starts the spinner"
  );
  assert.ok(/onState\(\{\s*buffering: true\s*\}\)/.test(mediaSrc), "the seek path re-asserts it");
});

test("the ratchet: an advancing playhead clears a stuck buffering (one-way — it never sets true)", () => {
  const body = fnBody("onTime");
  assert.ok(/advancing/.test(body), "the ratchet exists in onTime");
  assert.ok(/s\.buffering = false/.test(body), "…and it only clears (conditional assignment)");
  assert.ok(!/buffering: true/.test(body), "…and never asserts true — the stall events own that");
  assert.ok(
    /v\.paused/.test(body) && /v\.seeking/.test(body),
    "advancing means playing, not paused and not mid-seek"
  );
});
