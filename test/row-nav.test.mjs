// Row-local D-pad navigation for the player chrome.
//
// The user's model (LG remote, 2026-10-17): left/right moves to the
// ADJACENT key inside the row. At the END of a row the move goes to the
// scrub bar — except at the user's dead ends:
//   ICON row      [source][audio][subs][speed]
//                  left end (source)  → dead end   right end (speed)  → scrub bar
//   TRANSPORT row [rewind][play][forward]
//                  left end (rewind) → scrub bar   right end (forward) → dead end
//
// The spatial engine can't express this: it normalizes a candidate's
// distance by the candidate's WIDTH, so the wide centered scrub bar
// (x≈640, ~864px wide) beats the adjacent icon (right of the bar's
// center) and transport (left of it) keys in the toward-center
// direction — "left anywhere on the icon row jumps to the bar",
// "right from forward jumps to the bar". The Player therefore CONSUMES
// left/right for these rows and asks rowStep.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { rowOf, rowStep, isRowKey } from "../src/ui/row-nav.ts";

test("icon row: left/right moves to the adjacent key", () => {
  assert.equal(rowStep("source", "right"), "audio");
  assert.equal(rowStep("audio", "right"), "subs");
  assert.equal(rowStep("subs", "right"), "speed");
  assert.equal(rowStep("audio", "left"), "source");
  assert.equal(rowStep("subs", "left"), "audio");
  assert.equal(rowStep("speed", "left"), "subs");
});

test("transport row: left/right moves to the adjacent key", () => {
  assert.equal(rowStep("rewind", "right"), "play");
  assert.equal(rowStep("play", "right"), "forward");
  assert.equal(rowStep("play", "left"), "rewind");
  assert.equal(rowStep("forward", "left"), "play");
});

test("live ends go to the scrub bar (speed → right, rewind → left)", () => {
  assert.equal(rowStep("speed", "right"), "scrub");
  assert.equal(rowStep("rewind", "left"), "scrub");
});

test("the user's dead ends answer null (a CONSUMED no-op — nothing moves)", () => {
  assert.equal(rowStep("source", "left"), null);
  assert.equal(rowStep("forward", "right"), null);
});

test("membership: only the row keys are row keys (the scrub bar and the skip pill are not)", () => {
  assert.deepEqual(rowOf("source"), ["source", "audio", "subs", "speed"]);
  assert.deepEqual(rowOf("forward"), ["rewind", "play", "forward"]);
  assert.equal(isRowKey("scrub"), false, "the bar is the TARGET of a row step, not a row key");
  assert.equal(isRowKey("skip"), false, "the segment-skip pill is a floating control");
  assert.equal(isRowKey("info"), false);
  assert.equal(rowStep("scrub", "left"), null, "a non-row key is the engine's business");
});
