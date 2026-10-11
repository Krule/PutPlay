// ISSUE: "I can set my source preference in Settings and it's respected in
// the Player, but not displayed in the Player source selection as selected.
// I see HLS playing … but 'Playback source' displays 'Original'."
//
// Root cause: the engine only notifies the Player of a source change via the
// onSourceChange callback, which the initial entry-time setSource SKIPS
// (silent=true, so the overlay doesn't pop on entry). The Player's `source`
// state therefore stays at its initial "original" and the picker always
// marks Original.
//
// Fix contract:
//  - MediaEngine.setSource must publish `source: kind` in its onState payload
//    (the Player already syncs `p.source` from state).
//  - Player.onState must keep syncing source from state.
//
// Run: npm test
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

test("MediaEngine.setSource publishes the source in its onState payload", () => {
  const media = read("src/putio/media.ts");
  const setSource = media.slice(media.indexOf("setSource(kind:"));
  assert.ok(
    /onState\(\s*\{[^}]*source:\s*kind/.test(setSource),
    "setSource must include `source: kind` in an onState payload so silent (entry-time) switches reach the Player"
  );
});

test("Player still syncs source from the engine state payload", () => {
  const player = read("src/ui/screens/Player.svelte");
  assert.ok(
    /if\s*\(\s*p\.source\s*!==\s*undefined\s*\)\s*source\s*=\s*p\.source/.test(player),
    "Player.onState must keep syncing source from state"
  );
});
