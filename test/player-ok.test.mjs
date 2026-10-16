// Unit tests for the Player OK/press decision (src/putio/player-ok.ts).
//
// Same contract as the Library (test/library-ok.test.mjs): the common 5-way
// remote's OK key must activate the SPATIALLY FOCUSED control (a cbtn, a
// pick-row, a panel button) — and only with nothing focused does it fall
// back to the screen default, play/pause. The old handler checked the
// overlay flags only: with an overlay open it was a dead end (no row was
// focusable), and a focused control was ignored.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { playerOkAction } from "../src/putio/player-ok.ts";

test("a spatially focused control wins — OK activates it (overlay or not)", () => {
  assert.equal(playerOkAction(true), "activate-focused");
});

test("nothing focused → the screen default: toggle play/pause", () => {
  assert.equal(playerOkAction(false), "toggle-play");
});
