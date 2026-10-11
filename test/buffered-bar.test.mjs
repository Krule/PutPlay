// Buffered bar: a second layer under the progress fill showing how far
// ahead of the playhead data is already buffered (network feedback on a TV
// — no spinner, just "how much runway do I have").
//
//  - MediaEngine must publish the buffer end (seconds) in onTime state.
//  - Player renders it as .bar-buffer BEHIND .bar-fill, width from a plain
//    reactive value (Svelte style-binding rule — bare function calls in
//    bindings evaluate once and freeze).
//  - Live (duration ∞) → 0 (progressPct already returns 0 for ∞).
//
// Run: npm test
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

test("MediaEngine publishes the buffer end (seconds) in onTime state", () => {
  const media = read("src/putio/media.ts");
  assert.ok(
    /buffered:\s*bEnd/.test(media),
    "onTime must set s.buffered = bEnd (the buffer end in seconds)"
  );
  assert.ok(
    !/v\.currentTime < v\.buffered\.end/.test(media),
    "the inverted inline buffering condition must be gone"
  );
});

test("Player renders .bar-buffer behind .bar-fill with a reactive width", () => {
  const player = read("src/ui/screens/Player.svelte");
  // buffer layer must come BEFORE the fill (behind it)
  const b = player.indexOf('class="bar-buffer"');
  const f = player.indexOf('class="bar-fill"');
  assert.ok(b !== -1, "the .bar-buffer element must exist");
  assert.ok(b < f, ".bar-buffer must precede .bar-fill in the track");
  assert.ok(
    /bufferPct/.test(player) && /\$\:\s*bufferPct\s*=/.test(player),
    "the buffer width must be a plain reactive value (Svelte style-binding rule)"
  );
  assert.ok(
    /style="width:\s*\{bufferPct\}%"/.test(player),
    "the buffer layer width must bind bufferPct"
  );
  // both layers need to stack → absolute positioning on the track children
  assert.ok(/\.bar-track\s*{[^}]*position:\s*relative/.test(player), ".bar-track must be the positioning context");
  assert.ok(/\.bar-buffer\s*{[^}]*position:\s*absolute/.test(player), ".bar-buffer must be absolutely stacked");
});

test("stale bufEnd placeholder removed", () => {
  const player = read("src/ui/screens/Player.svelte");
  assert.ok(!/const bufEnd = 0/.test(player), "the old placeholder must be gone");
});
