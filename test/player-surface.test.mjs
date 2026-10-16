// Unit tests for the full-mode player surface (chrome) decision
// (src/putio/player-surface.ts).
//
// The screen owns the 4-second auto-hide timer; this module is only the
// pure decision, evaluated per tick:
//   surfaceVisibility({paused, buffering, error, menuOpen, infoOpen})
//     → { pinned, spinner, pauseEcho }
//
// Contract (acceptance A5/A6 + the locked wake/hide rules, §2.8):
//   pinned    = paused || error || menuOpen || infoOpen
//     — while pinned the 4s auto-hide timer must not run (the screen obeys).
//   spinner   = buffering && !paused
//     — the buffering spinner shows while buffering, but NEVER while paused:
//       a paused video is not buffering (A6).
//   pauseEcho = paused && !error
//     — the center play-echo appears on pause (A5); an error owns the
//       center, so no echo in that state.
//
// menuOpen = one of the floating menus (source/audio/subtitles/speed) is
// open; infoOpen = the info panel is open.
//
// It is a decision function, not a timer: no Date, no setTimeout, no side
// effects — testable in plain node.
//
// Run: pnpm vitest run test/player-surface.test.mjs

import { test } from "vitest";
import assert from "node:assert/strict";
import { surfaceVisibility } from "../src/putio/player-surface.ts";

// All flags off unless the test says otherwise.
function surface(over = {}) {
  return surfaceVisibility({
    paused: false,
    buffering: false,
    error: false,
    menuOpen: false,
    infoOpen: false,
    ...over,
  });
}

// ---------------- pinned ----------------

test("plain playback → nothing pinned, nothing shown (auto-hide timer runs)", () => {
  assert.deepEqual(surface(), { pinned: false, spinner: false, pauseEcho: false });
});

test("paused pins the chrome (the auto-hide timer stops) and shows the echo", () => {
  assert.deepEqual(surface({ paused: true }), { pinned: true, spinner: false, pauseEcho: true });
});

test("error pins the chrome — and owns the center: no echo, no spinner", () => {
  assert.deepEqual(surface({ error: true }), { pinned: true, spinner: false, pauseEcho: false });
});

test("an open menu pins the chrome — the user picks with the chrome up", () => {
  assert.deepEqual(surface({ menuOpen: true }), { pinned: true, spinner: false, pauseEcho: false });
});

test("an open info panel pins the chrome", () => {
  assert.deepEqual(surface({ infoOpen: true }), { pinned: true, spinner: false, pauseEcho: false });
});

test("buffering alone does not pin — the spinner is the whole response", () => {
  assert.deepEqual(surface({ buffering: true }), { pinned: false, spinner: true, pauseEcho: false });
});

// ---------------- combinations ----------------

test("paused + buffering → pause wins: no spinner (a paused video is not buffering)", () => {
  assert.deepEqual(surface({ paused: true, buffering: true }), { pinned: true, spinner: false, pauseEcho: true });
});

test("paused + error → the error owns the center: the pause echo is suppressed", () => {
  assert.deepEqual(surface({ paused: true, error: true }), { pinned: true, spinner: false, pauseEcho: false });
});
