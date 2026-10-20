// Player subtitle wiring: MKV-embedded first + one overlay for every source.
//
//  - The put.io subtitle list must be ordered with orderSubtitleSources
//    BEFORE it is rendered/autoselected (embedded MKV tracks first).
//  - Every source (original, put.io MP4, HLS) renders through the DOM
//    overlay — the native textTracks/::cue path was removed (m00906): it
//    gave HLS subtitles a different size/position and printed the {an8}
//    artifact literally.
//
// Run: pnpm test
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

test("Player orders the put.io subtitle list with orderSubtitleSources", () => {
  const player = read("src/ui/screens/Player.svelte");
  assert.ok(/orderSubtitleSources/.test(player), "Player.svelte must use orderSubtitleSources");
  assert.ok(
    /orderSubtitleSources\(\s*(res\.subtitles|subtitles)\b/.test(player),
    "the API subtitle array must be passed through orderSubtitleSources"
  );
});

test("Player no longer styles native cues — the overlay owns all subtitle rendering (m00906)", () => {
  const player = read("src/ui/screens/Player.svelte");
  assert.ok(!/video\s*::cue/.test(player), "the native cue path is gone — no ::cue styling may remain");
  assert.ok(!/--cue-size/.test(player), "the native-path size variable is gone (the overlay computes its own size)");
});

test("stale 'try the HLS source' hint removed (embedded subs now work on original)", () => {
  const player = read("src/ui/screens/Player.svelte");
  assert.ok(!/Try the <button class="link" on:click=\{\(\) => onSourcePick\("hls"\)\}>HLS<\/button>/.test(player));
  assert.ok(!/often have embedded tracks/.test(player), "stale HLS-hint copy must go");
});

test("fullscreen button removed (the player IS the full screen on a TV)", () => {
  const player = read("src/ui/screens/Player.svelte");
  assert.ok(!/data-ctl="fullscreen"/.test(player), "the fullscreen cbtn must be gone");
  assert.ok(!/toggleFullscreen/.test(player), "no fullscreen calls remain in the Player");
  const platform = read("src/webos/platform.ts");
  assert.ok(!/toggleFullscreen/.test(platform), "platform.toggleFullscreen is dead code — removed");
});

test("chrome auto-hide: pointer movement wakes, playback start schedules the hide", () => {
  const player = read("src/ui/screens/Player.svelte");
  assert.ok(
    /<div[^>]*class="player"[^>]*on:mousemove=\{wake\}/.test(player),
    "the player root must wake the UI on pointer movement (Magic Remote)"
  );
  assert.ok(
    /startedPlaying/.test(player),
    "a one-shot flag must schedule the first auto-hide when playback starts"
  );
  assert.ok(
    /surfaceVisibility/.test(player) && /\$\:\s*pinned\s*=\s*surface\.pinned/.test(player),
    "the pinned-state rule (surfaceVisibility) must be shared by the visibility class and the hide timer"
  );
});
