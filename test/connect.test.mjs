// Unit tests for the Connect/Account back decision (src/putio/connect.ts).
// BUG 6: Back did nothing on the Connect screens (they never registered a
// remote handler). Intended behavior mirrors the library-root pattern:
//   - while waiting for approval ("pending") → Back cancels the device-code
//     flow and returns to the sign-in choices (never exits the app from a
//     half-finished flow)
//   - on the choices screen → first press hints, second press within the
//     window exits (same double-press guard as the library root)
//
// The "paste a token" mode was removed (TV remotes can't type), so the
// decision depends only on the auth status.
//
// Pure decision + a pure double-press guard, testable in node.
//
// Run: pnpm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { connectBackAction, doublePress, EXIT_WINDOW } from "../src/putio/connect.ts";

// ---------------- connectBackAction ----------------

test("connectBackAction takes only the status (the paste mode is gone)", () => {
  assert.equal(connectBackAction.length, 1);
});

test("pending (QR screen) → root: double-press exit guard (user decision: there is no sign-in screen to go back to)", () => {
  assert.equal(connectBackAction("pending"), "root");
});

test("loading → ignore (nothing to go back to)", () => {
  assert.equal(connectBackAction("loading"), "ignore");
});

test("unauthed (choices screen) → root: double-press exit guard", () => {
  assert.equal(connectBackAction("unauthed"), "root");
});

// ---------------- doublePress (choices screen) ----------------

test("first press on choices screen → hint (not exit)", () => {
  const state = { lastRootBackAt: 0 };
  const r1 = doublePress(state, 1_000_000);
  assert.equal(r1, "hint");
  assert.equal(state.lastRootBackAt, 1_000_000);
});

test("second press within the window → exit", () => {
  const state = { lastRootBackAt: 0 };
  assert.equal(doublePress(state, 1_000_000), "hint");
  assert.equal(doublePress(state, 1_000_000 + EXIT_WINDOW / 2), "exit");
  assert.equal(state.lastRootBackAt, 0); // arm re-arms
});

test("second press after the window → hint again", () => {
  const state = { lastRootBackAt: 0 };
  assert.equal(doublePress(state, 1_000_000), "hint");
  assert.equal(doublePress(state, 1_000_000 + EXIT_WINDOW + 1000), "hint");
  assert.equal(state.lastRootBackAt, 1_000_000 + EXIT_WINDOW + 1000);
});

test("window constant is the documented 2s root-press guard", () => {
  assert.equal(EXIT_WINDOW, 2000);
});
