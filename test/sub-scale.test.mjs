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
//   4. there is NO native ::cue rendering path — HLS subtitles travel the
//      same DOM overlay as every source (m00906: one pipeline, one rule);
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
    [0.65, 0.8, 1, 1.35]
  );
  // m00887: the ASS-aware renderer renders at the file's author size, which
  // made the old 1.0 default "huge" on 1080p files — the previous "Small"
  // step (0.8) is now the out-of-the-box size and is labelled Default.
  // m01502: the ladder gains a real Small (0.65, one step below Default at
  // the ladder's ~1.25 ratio) and drops the XXL — the user does not need
  // anything bigger than XL.
  assert.deepEqual(
    SUB_SCALE_OPTIONS.map((o) => o.label),
    ["Small", "Default", "Large", "XL"]
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

test("there is no native ::cue path — the overlay is the only rendering path (m00906)", () => {
  // The old contract pinned `font-size: var(--cue-size, 30px)` inside
  // video::cue; that path rendered HLS subs at a different size/position
  // than every other source and printed the {an8} artifact. It is gone.
  assert.ok(
    !/video::cue/.test(player),
    "HLS subtitles go through the DOM overlay — no ::cue rule may remain"
  );
  assert.ok(
    !/--cue-size/.test(player),
    "the --cue-size variable on the video element is gone"
  );
});

test("Settings no longer offers a Subtitle size card — the player's pick is the setting", () => {
  // m00758: the card duplicated the in-player control; the last pick made
  // in the player IS the default (pickSubScale already persists subScale).
  const settings = read("src/ui/screens/Settings.svelte");
  assert.ok(
    !/Subtitle size/i.test(settings),
    "the Subtitle size card must be gone from Settings"
  );
  assert.ok(
    !/SUB_SCALE_OPTIONS/.test(settings) && !/cfgScale/.test(settings),
    "Settings must not reference the ladder or a scale state anymore"
  );
});

test("saving Settings keeps the player's last subtitle pick", () => {
  // persist() used to re-stamp subScale from the card with a full
  // config.set({...}) — once the card is gone that would silently reset
  // the player's pick. It must fold the current config in instead.
  const settings = read("src/ui/screens/Settings.svelte");
  const body = bodyOf(settings, "persist");
  assert.ok(
    /\.\.\.c/.test(body),
    "persist() must spread the current config (player-owned keys survive)"
  );
  assert.ok(
    !/subScale:/.test(body) && !/audioFallback:/.test(body),
    "persist() must not re-stamp the player-owned subScale or the removed audioFallback"
  );
});
