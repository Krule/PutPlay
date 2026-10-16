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
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import { applyAudioTrack, planAudioSwitch } from "../src/putio/audio-switch.ts";
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

// ---------------- escalation planner (the webOS 6 veto workaround) ----------------
//
// The webview vetoes `enabled` writes on some MKV files (read-back reveals
// the old track). The planner decides the next escalation step from the
// attempt number and the read-back; the MediaEngine executes each step:
//   0 plain write   1 paused write   2 write + Luna selectTrack
//   3 the "reload dance" (pause → strip src → load → re-set src → re-write
//     at loadedmetadata → seek back → resume — proven on webOS TVs in
//     kieranbrown/stremio-webos)
// Pure: no DOM, so the whole escalation is table-testable here.

test("planAudioSwitch: attempt 0 lands → confirmed, no escalation", () => {
  assert.deepEqual(planAudioSwitch(0, 1, 1), { kind: "confirmed", index: 1 });
});

test("planAudioSwitch: vetoed write escalates step by step (0→1→2→3)", () => {
  assert.deepEqual(planAudioSwitch(0, 0, 1), { kind: "next", attempt: 1 });
  assert.deepEqual(planAudioSwitch(1, 0, 1), { kind: "next", attempt: 2 });
  assert.deepEqual(planAudioSwitch(2, 0, 1), { kind: "next", attempt: 3 });
});

test("planAudioSwitch: an intermediate attempt may land (paused write) → confirmed there", () => {
  assert.deepEqual(planAudioSwitch(1, 2, 2), { kind: "confirmed", index: 2 });
});

test("planAudioSwitch: dance is the last resort — veto after it fails with a reason", () => {
  const r = planAudioSwitch(3, 0, 1);
  assert.equal(r.kind, "failed");
  assert.ok(typeof r.reason === "string" && r.reason.length > 0);
});

test("planAudioSwitch: nothing enabled after a write (read-back -1) is treated as vetoed", () => {
  assert.deepEqual(planAudioSwitch(0, -1, 0), { kind: "next", attempt: 1 });
  const r = planAudioSwitch(3, -1, 0);
  assert.equal(r.kind, "failed");
});

test("planAudioSwitch: out-of-range attempts fail (no infinite loop)", () => {
  const r = planAudioSwitch(7, 0, 1);
  assert.equal(r.kind, "failed");
});

test("MediaEngine drives the escalation (planner + dance in the native path)", () => {
  const media = read("src/putio/media.ts");
  const setAudioTrack = media.slice(media.indexOf("setAudioTrack(index:"));
  assert.ok(
    /planAudioSwitch\(/.test(setAudioTrack),
    "the native switch must be driven by planAudioSwitch (not a single write)"
  );
  assert.ok(
    /removeAttribute\(\s*"src"\s*\)/.test(setAudioTrack),
    "the reload dance must strip src (the webview re-evaluates tracks only on a full reload)"
  );
  assert.ok(
    /audioSwitching/.test(setAudioTrack),
    "the escalation must publish audioSwitching so the panel shows 'Switching…'"
  );
});

// ---------------- preferred language: once per source load ----------------
//
// The Player honored the preferred audio language on EVERY audioTracks sync.
// A confirmed switch fires a `change` event → sync → and the preference
// (with no configured language, pickAudioTrack falls back to index 0)
// re-enabled English, silently REVERTING the user's explicit pick. The
// e2e caught it: pick Spanish → dance confirmed → toast "Audio: English".
// The preference must apply exactly once per source load.

test("Player: the preference is owned by the ENGINE (setAudioPreference), not re-implemented per sync", () => {
  // the old per-sync block consumed its once-flag on the EMPTY first track
  // sync (src set → bindTrackEvents fires before the pipeline exposes
  // tracks), so the preference was never applied — the reported bug. The
  // engine applies it to the first REAL list (and escalates like a pick);
  // the Player only mirrors the setting + reacts to the terminal state.
  const player = read("src/ui/screens/Player.svelte");
  const fn = player.match(/function applyEngineState[\s\S]*?\n  \}/)[0];
  assert.ok(
    !/pickAudioTrack\(audioTracks, preferredAudioLang\)/.test(fn),
    "applyEngineState must not re-pick the preference per sync (the once-flag race)"
  );
  const init = player.match(/function initEngine[\s\S]*?\n  \}/)[0];
  assert.ok(
    /engine\.setAudioPreference\(cfg\?\.audioLang/.test(init) ||
      /setAudioPreference\(cfg\?\.audioLang/.test(init),
    "initEngine must mirror the configured language into the engine"
  );
  assert.ok(
    /config\.subscribe\(\(v\) =>[^)]*\)\s*\{[^}]*setAudioPreference|setAudioPreference\(v\.audioLang/.test(player),
    "config changes must reach the engine (setting while idle/playing)"
  );
});

test("Player: a preference refusal can trigger auto-hls (row via audioPickIndex)", () => {
  // the user's exact configuration: preferred language + "use the put.io
  // stream". A refused PREFERENCE pick (no pendingAudioPick) must still
  // resolve its row via audioPickIndex, or the auto-hls setting is dead.
  const player = read("src/ui/screens/Player.svelte");
  const fn = player.match(/function applyEngineState[\s\S]*?\n  \}/)[0];
  assert.ok(
    /audioPickIndex/.test(fn),
    "the failure branch must resolve the preference row via p.audioPickIndex"
  );
});

test("Player: an engine error is toasted (explained), not just flashed in the panel", () => {
  // the fallback's setSource clears `error` from the panel a moment after
  // it appears — a silent source bounce reads as "refuses to play". The
  // error branch must toast the (now descriptive) message.
  const player = read("src/ui/screens/Player.svelte");
  const m = player.match(/function applyEngineState[\s\S]*?\n  \}/);
  assert.ok(m, "applyEngineState must exist");
  const i = m[0].indexOf("if (p.error !== undefined)");
  assert.ok(i >= 0, "the p.error branch must exist");
  const branch = m[0].slice(i, i + 400);
  assert.ok(
    /platform\.toast\(p\.error\)/.test(branch),
    "a non-null engine error must be toasted"
  );
});

test("Player: a pick is confirmed only by the terminal patch, not a mid-switch sync", () => {
  // the dance re-binds the track list mid-escalation; that sync emits
  // audioTrack for the CURRENT track while the pick is still pending.
  // Treating it as confirmation toasted the wrong track ("Audio: English"
  // for a Spanish pick) and cleared the pending pick. The confirm branch
  // must be guarded by !audioSwitching (the terminal patch clears it).
  const player = read("src/ui/screens/Player.svelte");
  const m = player.match(/function applyEngineState[\s\S]*?\n  \}/);
  assert.ok(m, "applyEngineState must exist");
  const block = m[0];
  const i = block.indexOf("} else if (p.audioTrack !== undefined)");
  assert.ok(i >= 0, "the audioTrack branch must exist");
  const branch = block.slice(i);
  assert.ok(
    /!audioSwitching/.test(branch),
    "the confirm (toast + pending clear) must be guarded by !audioSwitching"
  );
});
