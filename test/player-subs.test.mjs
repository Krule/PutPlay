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

test("sub outline ring: canvas dilate−punch (libass outline bitmap = a ring)", () => {
  const player = read("src/ui/screens/Player.svelte");
  const subring = read("src/ui/subring.ts");
  // No blend modes: this Chrome family (and the TV's) supports NO alpha /
  // porter-duff mix-blend-mode, and foreignObject text inside an SVG <mask>
  // never renders here (verified by pixel-identical masked/unmasked A/B).
  assert.ok(!/mix-blend-mode/.test(player), "no mix-blend-mode anywhere (unsupported)");
  assert.ok(!/<mask[\s>]/.test(player), "the dead SVG-mask ring is gone");
  assert.ok(!/foreignObject/.test(player), "the dead SVG-mask ring is gone (no foreignObject)");
  assert.ok(!/stroke-punch|stroke-svg|stroke-m\b/.test(player), "no trace of the punch/mask attempt remains");
  // The ring is a canvas the Player appends to the stroke layer, drawn after
  // every DOM commit (the sizer must exist to measure the baseline).
  assert.ok(/afterUpdate/.test(player), "the ring is painted in an afterUpdate hook");
  assert.ok(/subs-ring/.test(player), "the stroke layer hosts a .subs-ring canvas");
  assert.ok(/from "..\/..\/ui\/subring"/.test(player), "the Player imports the ring module");
  // The sizer span still defines the line box; it is hidden.
  assert.ok(/class="stroke-sizer"/.test(player), "the stroke layer must carry a stroke-sizer span (in-flow, defines the line box)");
  const sizer = player.match(/\.stroke-sizer\s*\{[^}]*\}/);
  assert.ok(sizer, "the .stroke-sizer rule must exist");
  assert.ok(/visibility:\s*hidden/.test(sizer[0]), "the sizer must be visibility:hidden (layout only)");
  const ring = player.match(/\.subs-ring\s*\{[^}]*\}/);
  assert.ok(ring, "the .subs-ring rule must exist");
  assert.ok(/position:\s*absolute/.test(ring[0]), "the ring canvas overlays the line (position:absolute)");
  // The module does the libass math: a centred 2×w stroke, punched with
  // destination-out, blurred per segment.
  assert.ok(/destination-out/.test(subring), "the punch must use globalCompositeOperation destination-out");
  assert.ok(/strokeText/.test(subring) && /fillText/.test(subring), "the ring is strokeText + fillText");
  assert.ok(/blur\(/.test(subring) || /filter/.test(subring), "the ring is blurred with the \blur sigma");
  // The centred-stroke span style survives ONLY as the multi-line fallback.
  assert.ok(/-webkit-text-stroke:\$\{/.test(player), "the centred-stroke fallback keeps -webkit-text-stroke");
});

test("chrome auto-hide: pointer movement wakes, playback start schedules the hide", () => {  const player = read("src/ui/screens/Player.svelte");
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

test("sub anchor: the player probes the half-leading and passes it as metrics", () => {
  const player = read("src/ui/screens/Player.svelte");
  // A metrics object for the renderer's SubMetrics hook…
  assert.ok(
    /halfLeadingPx\s*:/.test(player),
    "the player must supply a SubMetrics.halfLeadingPx probe"
  );
  assert.ok(
    /offsetHeight/.test(player) && /createElement/.test(player),
    "the probe must measure the font's natural line height in a hidden DOM node"
  );
  assert.ok(
    /new Map(<[^>]+>)?\(\)/.test(player),
    "probe results must be cached per (family, size)"
  );
  // …and BOTH render sites pass it (the timeupdate render and the motion tick).
  assert.ok(
    /renderSubtitleLines\(\s*act,\s*currentTime,\s*styleTable,\s*box,\s*subScale,\s*\w+\)/.test(player),
    "the timeupdate render must pass the metrics"
  );
  assert.ok(
    /renderSubtitleLines\(\s*act,\s*t,\s*styleTable,\s*box,\s*subScale,\s*\w+\)/.test(player),
    "the motion tick render must pass the metrics"
  );
  // The probe must resolve the SAME chain the DOM line renders with, or the
  // half-leading of a different font gets measured.
  assert.ok(
    /subFontChain\(family\)/.test(player),
    "the probe must use the subFontChain(family) string"
  );
});

// The ring's segment list must come from a PURE function (ringSegments), not
// inline glue: the segment-less case (no styling overrides, but the STYLE
// carries an outline) crashed the player on the TV — line.segments[0] was
// undefined. A pure function is unit-testable for both shapes.
test("sub ring: paintRings builds its segments with ringSegments (no inline map glue)", () => {
  const { readFileSync } = require("node:fs");
  const { join, dirname } = require("node:path");
  const { fileURLToPath } = require("node:url");
  const player = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "screens", "Player.svelte"),
    "utf8"
  );
  assert.ok(
    /ringSegments\(line\)/.test(player),
    "paintRings must map the line's segments through ringSegments(line)"
  );
  assert.ok(
    !/line\.segments\.map/.test(player),
    "no inline line.segments.map glue left in paintRings (the crash site)"
  );
});
