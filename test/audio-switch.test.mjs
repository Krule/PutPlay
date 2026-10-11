// ISSUE: MKV with Italian + English audio — selecting "English" toasted
// "Audio: English" but the Italian track kept playing.
//
// Root cause: the engine set `audioTrack.enabled = true` and reported success
// WITHOUT reading the state back. The webOS webview silently ignores the
// assignment for some MKV files (the API is present and enumerated the
// tracks — it just refuses the switch), so the optimistic toast was a lie.
//
// Fix contract:
//  - audio-switch.ts: pure applyAudioTrack(list, index) sets the flags and
//    READS BACK which index is actually enabled (the platform can veto).
//  - MediaEngine.setAudioTrack (native path) uses the read-back and reports
//    audioSwitchFailed when the webview refused.
//  - Player toasts the choice ONLY after the engine confirms it; on refusal
//    it says so and points at the HLS source (hls.js switching works).
//
// Run: npm test
import test from "node:test";
import assert from "assert/strict";
import { applyAudioTrack } from "../src/putio/audio-switch.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

/** A track the platform refuses to change: the enabled setter is a no-op. */
function stubbornTrack(initial) {
  return {
    _e: initial,
    get enabled() { return this._e; },
    set enabled(v) { /* webview vetoes the write */ },
  };
}

test("applyAudioTrack: cooperative platform — switch lands, read-back confirms", () => {
  const tracks = [
    { enabled: true, label: "ITA" },
    { enabled: false, label: "ENG" },
  ];
  const actual = applyAudioTrack(tracks, 1);
  assert.equal(actual, 1);
  assert.deepEqual(
    tracks.map((t) => t.enabled),
    [false, true]
  );
});

test("applyAudioTrack: platform that vetoes the write — reports the track that IS enabled", () => {
  const tracks = [stubbornTrack(true), stubbornTrack(false)];
  const actual = applyAudioTrack(tracks, 1);
  // the write was ignored — the read-back must reveal ITA (0) is still on
  assert.equal(actual, 0);
});

test("applyAudioTrack: veto with nothing enabled — -1", () => {
  const tracks = [stubbornTrack(false), stubbornTrack(false)];
  assert.equal(applyAudioTrack(tracks, 1), -1);
});

test("applyAudioTrack: out of range — -1, list untouched", () => {
  const tracks = [{ enabled: true }, { enabled: false }];
  assert.equal(applyAudioTrack(tracks, 5), -1);
  assert.deepEqual(
    tracks.map((t) => t.enabled),
    [true, false]
  );
  assert.equal(applyAudioTrack(null, 0), -1);
});

test("MediaEngine.setAudioTrack uses the read-back and reports refusal", () => {
  const media = read("src/putio/media.ts");
  const setAudioTrack = media.slice(media.indexOf("setAudioTrack(index:"));
  assert.ok(
    /applyAudioTrack\(/.test(setAudioTrack),
    "setAudioTrack must use the applyAudioTrack read-back (no blind enabled assignment)"
  );
  assert.ok(
    /audioSwitchFailed/.test(setAudioTrack),
    "setAudioTrack must report audioSwitchFailed when the webview vetoes the switch"
  );
});

test("Player confirms audio picks via engine state, not optimistically", () => {
  const player = read("src/ui/screens/Player.svelte");
  const m = player.match(/function onAudioPick[\s\S]*?\n  \}/);
  assert.ok(m, "onAudioPick function must exist");
  const onAudioPick = m[0];
  assert.ok(
    !/platform\.toast/.test(onAudioPick),
    "onAudioPick must not toast the choice itself — the toast must come from the engine's confirmed state"
  );
  assert.ok(
    /pendingAudioPick/.test(onAudioPick),
    "onAudioPick must record the pending pick for the engine to confirm"
  );
  assert.ok(
    /audioSwitchFailed/.test(player),
    "Player must handle the engine's audioSwitchFailed state (truthful refusal message)"
  );
});
