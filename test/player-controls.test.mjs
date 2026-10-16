// Player control-bar auto-hide: the bar stays visible ("pinned") whenever
// hiding would leave the user without feedback — paused, error, or an
// overlay panel open. Otherwise it auto-hides ~4s after the last
// pointer/D-pad activity, and again when playback first starts.
//
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { controlsPinned } from "../src/putio/player-controls.ts";

test("playing with nothing open → not pinned (auto-hide allowed)", () => {
  assert.equal(controlsPinned({ paused: false, error: false, panelOpen: false }), false);
});

test("paused → pinned (the user is deciding; hiding hides their choices)", () => {
  assert.equal(controlsPinned({ paused: true, error: false, panelOpen: false }), true);
});

test("error → pinned (the error state must stay visible)", () => {
  assert.equal(controlsPinned({ paused: false, error: true, panelOpen: false }), true);
});

test("overlay panel open → pinned (audio/subs/source panels ride on the bar)", () => {
  assert.equal(controlsPinned({ paused: false, error: false, panelOpen: true }), true);
});

test("any combination of pinned reasons → pinned", () => {
  assert.equal(controlsPinned({ paused: true, error: true, panelOpen: true }), true);
});
