// In-player subtitle size (issue: "There needs to be an option to select
// subtitle size directly on the player").
//
// The scale itself (subScale, 0.8–2.0) already existed in the config and was
// applied to the DOM-overlay subtitles in the Player — but the option list
// was a PRIVATE const in Settings.svelte and the Player had no control.
// Contract:
//   1. the 4-step ladder lives in the pure config module (shared, DRY);
//   2. every option is inside the stored clamp — a value outside it would be
//      silently re-clamped on the next load and the panel would show the
//      wrong row selected;
//   3. the Player's subtitle panel offers the ladder and persists a pick
//      to the config store;
//   4. the HLS ::cue rendering follows the scale via a CSS variable on the
//      video element (it used to be a fixed 30px);
//   5. Settings reuses the shared ladder (no private copy).
//
// Run: pnpm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SUB_SCALE_OPTIONS, DEFAULT_CONFIG } from "../src/putio/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

function bodyOf(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name}() must exist in Player.svelte`);
  const end = src.indexOf("\n  }", start);
  assert.ok(end > start, `function ${name}() must be closed`);
  return src.slice(start, end);
}

test("SUB_SCALE_OPTIONS: the shared 4-step ladder (Small/Default/Large/XL)", () => {
  assert.ok(Array.isArray(SUB_SCALE_OPTIONS), "config.ts must export SUB_SCALE_OPTIONS");
  assert.deepEqual(
    SUB_SCALE_OPTIONS.map((o) => o.v),
    [0.8, 1, 1.35, 1.8]
  );
  assert.ok(
    SUB_SCALE_OPTIONS.every((o) => typeof o.label === "string" && o.label.length > 0),
    "every step needs a label"
  );
});

test("every option is inside the stored clamp", () => {
  for (const o of SUB_SCALE_OPTIONS) {
    assert.ok(
      o.v >= DEFAULT_CONFIG.subScaleMin && o.v <= DEFAULT_CONFIG.subScaleMax,
      `scale ${o.v} would be re-clamped on the next load (clamp is ${DEFAULT_CONFIG.subScaleMin}–${DEFAULT_CONFIG.subScaleMax})`
    );
  }
});

const player = read("src/ui/screens/Player.svelte");

test("Player subtitle panel offers the shared size ladder", () => {
  assert.ok(
    /SUB_SCALE_OPTIONS/.test(player),
    "the Player must render the shared SUB_SCALE_OPTIONS (not a private copy)"
  );
  assert.ok(
    /function pickSubScale\(/.test(player),
    "a size row must go through pickSubScale()"
  );
});

test("picking a size persists it to the config store", () => {
  const body = bodyOf(player, "pickSubScale");
  assert.ok(
    /config\.update\(/.test(body) && /subScale/.test(body),
    "pickSubScale must write subScale through config.update"
  );
  assert.ok(
    /saveConfig\(\)/.test(body),
    "pickSubScale must persist (saveConfig) — the size must survive a reboot like every other setting"
  );
});

test("the HLS ::cue rendering follows the scale (CSS variable on the video element)", () => {
  assert.ok(
    /font-size:\s*var\(--cue-size/.test(player),
    "the video::cue rule must use var(--cue-size, 30px), not a fixed 30px"
  );
  assert.ok(
    /--cue-size/.test(player) && /subFontSize/.test(player),
    "the video element must carry the --cue-size variable driven by subFontSize"
  );
});

test("Settings reuses the shared ladder (no private copy)", () => {
  const settings = read("src/ui/screens/Settings.svelte");
  assert.ok(
    !/const SCALE_OPTIONS/.test(settings),
    "the private SCALE_OPTIONS const must be gone"
  );
  assert.ok(
    /SUB_SCALE_OPTIONS/.test(settings),
    "Settings must render the shared SUB_SCALE_OPTIONS"
  );
});
