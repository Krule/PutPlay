// Unit tests for the modal side-click decision (src/putio/overlay.ts).
// BUG 2: clicking the dim area around a modal should dismiss it with NO action
// taken. The Player's center-panel is a full-screen scrim; a click inside the
// panel must not count as "outside".
//
// Pure geometry, testable in node (no DOM needed): the click is dismissed iff
// it falls on the scrim and outside the panel rect.
//
// Run: pnpm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { isOutsideClick } from "../src/putio/overlay.ts";

// A 620×400 panel centered in a 1920×1080 stage.
const panel = { left: (1920 - 620) / 2, top: (1080 - 400) / 2, width: 620, height: 400 };
const click = (x, y) => ({ clientX: x, clientY: y });

test("click on the dim area to the left of the panel → outside (dismiss)", () => {
  assert.equal(isOutsideClick(click(100, 540), panel), true);
});

test("click in the far corner of the scrim → outside (dismiss)", () => {
  assert.equal(isOutsideClick(click(1890, 1070), panel), true);
});

test("click dead-center of the panel → inside (no dismiss)", () => {
  const cx = panel.left + panel.width / 2;
  const cy = panel.top + panel.height / 2;
  assert.equal(isOutsideClick(click(cx, cy), panel), false);
});

test("click just inside the panel edge (1px in) → inside (no dismiss)", () => {
  assert.equal(isOutsideClick(click(panel.left + 1, panel.top + 1), panel), false);
});

test("click just outside the panel edge (1px out) → outside (dismiss)", () => {
  assert.equal(isOutsideClick(click(panel.left - 1, panel.top + 10), panel), true);
  assert.equal(isOutsideClick(click(panel.left + panel.width + 1, panel.top + 10), panel), true);
});

test("click exactly on the panel border counts as inside (lenient: no accidental dismiss)", () => {
  assert.equal(isOutsideClick(click(panel.left, panel.top), panel), false);
  assert.equal(isOutsideClick(click(panel.left + panel.width, panel.top + panel.height), panel), false);
});

test("null/zero panel rect → any click is outside (dismiss)", () => {
  assert.equal(isOutsideClick(click(5, 5), null), true);
  assert.equal(isOutsideClick(click(5, 5), { left: 0, top: 0, width: 0, height: 0 }), true);
});
