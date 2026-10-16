// Player subtitle wiring: MKV-embedded first + native cue styling.
//
//  - The put.io subtitle list must be ordered with orderSubtitleSources
//    BEFORE it is rendered/autoselected (embedded MKV tracks first).
//  - Native textTracks (HLS source) render with the browser's default cue
//    styling — an opaque black box. video::cue overrides it to a
//    transparent, shadowed, app-font caption (Chrome 79 supports ::cue).
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

test("Player styles native cues (video::cue) with a transparent background", () => {
  const player = read("src/ui/screens/Player.svelte");
  const m = player.match(/video\s*::cue[\s\S]{0,20}?\{([^}]*)\}/i);
  assert.ok(m, "Player.svelte must contain a video::cue rule");
  assert.ok(
    /background(-color)?\s*:\s*transparent/i.test(m[1]),
    "video::cue must use a transparent background (no black box)"
  );
  assert.ok(/text-shadow/i.test(m[1]), "video::cue needs a shadow for readability over video");
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
    /<div class="player"[^>]*on:mousemove=\{wake\}/.test(player),
    "the player root must wake the UI on pointer movement (Magic Remote)"
  );
  assert.ok(
    /startedPlaying/.test(player),
    "a one-shot flag must schedule the first auto-hide when playback starts"
  );
  assert.ok(
    /controlsPinned/.test(player),
    "the pinned-state rule must be shared by the visibility class and the hide timer"
  );
});
