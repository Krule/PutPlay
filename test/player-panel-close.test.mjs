// Source gate: making a selection in a player pick panel closes the panel.
//
// Issue: "Once I make a selection in a Player dialogue for Video, Audio or
// Subtitle, close the dialogue."
//
// The pick handlers used to leave the overlay open — after choosing, the
// user still had to press Back or click the scrim to get the picture back.
// Contract: every pick (source, audio row, subtitle track — including Off)
// goes through the shared closeOverlays() helper, and so does the Back key
// (one close-list, not three copies).
//
// Run: pnpm test
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");
const player = read("src/ui/screens/Player.svelte");

/** A top-level script function's body (2-space indent: the first
 *  newline-then-two-spaces-} after the header closes it — nested braces
 *  are indented deeper). */
function bodyOf(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name}() must exist in Player.svelte`);
  const end = src.indexOf("\n  }", start);
  assert.ok(end > start, `function ${name}() must be closed`);
  return src.slice(start, end);
}

test("closeOverlays: one shared helper clears all three pick panels", () => {
  const helper = bodyOf(player, "closeOverlays");
  for (const key of ["audio", "subs", "source"]) {
    assert.ok(
      new RegExp(`overlays\\.${key}\\s*=\\s*false`).test(helper),
      `closeOverlays() must clear overlays.${key}`
    );
  }
});

test("picking a playback source closes the panel", () => {
  assert.ok(
    /closeOverlays\(\)/.test(bodyOf(player, "onSourcePick")),
    "onSourcePick must closeOverlays() — the user asked: close the dialogue once a selection is made"
  );
});

test("picking an audio row closes the panel", () => {
  assert.ok(
    /closeOverlays\(\)/.test(bodyOf(player, "onAudioPick")),
    "onAudioPick must closeOverlays() (the switch result still arrives as a toast)"
  );
});

test("picking a subtitle track — or Off — closes the panel", () => {
  assert.ok(
    /closeOverlays\(\)/.test(bodyOf(player, "onSubPick")),
    "onSubPick must closeOverlays()"
  );
});

test("Back reuses the shared helper (no duplicated close-list)", () => {
  assert.ok(
    /closeOverlays\(\)/.test(bodyOf(player, "onBack")),
    "onBack must use closeOverlays() instead of a hand-rolled close-list"
  );
});

test("Player.svelte compiles (Svelte 4 parse errors are invisible to every other gate)", async () => {
  const { compile, preprocess } = await import("svelte/compiler");
  const sveltePreprocess = (await import("svelte-preprocess")).default;
  const file = join(here, "..", "src", "ui", "screens", "Player.svelte");
  const source = readFileSync(file, "utf8");
  const processed = await preprocess(source, sveltePreprocess(), { filename: file });
  assert.doesNotThrow(
    () => compile(processed.code, { generate: "dom", filename: file, css: "injected" }),
    "Player.svelte must compile"
  );
});
