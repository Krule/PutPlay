// Unit tests for the App's nav routing decision (routeNav in src/store/nav.ts).
//
// Regression: the .acct button stopped working after a Settings round-trip.
// Root cause: the App's subscription was LEVEL-triggered (`navToSettings > 0`).
// The counters are monotonic and never reset, so after the first round-trip
// `navToLibrary` is permanently >= 1 — and both ifs ran in one callback, the
// second reading the screen the first had JUST assigned, instantly reverting
// every subsequent entry into Settings.
//
// Contract: routeNav is EDGE-triggered (reacts to prev→next increments) and
// evaluates both decisions against the INCOMING screen.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { routeNav } from "../src/store/nav.ts";

const state = (backLevel, navToSettings, navToLibrary) => ({ backLevel, navToSettings, navToLibrary });

test("first entry into settings routes library → settings", () => {
  assert.equal(
    routeNav(state(0, 0, 0), state(0, 1, 0), "library"),
    "settings"
  );
});

test("back from settings routes settings → library", () => {
  assert.equal(
    routeNav(state(0, 1, 0), state(0, 1, 1), "settings"),
    "library"
  );
});

test("the .acct regression: SECOND entry into settings must stick", () => {
  // first round trip
  let s = "library";
  s = routeNav(state(0, 0, 0), state(0, 1, 0), s); // .acct
  assert.equal(s, "settings");
  s = routeNav(state(0, 1, 0), state(0, 1, 1), s); // Back
  assert.equal(s, "library");
  // second .acct click — the reported bug: level-triggered logic reverted this
  s = routeNav(state(0, 1, 1), state(0, 2, 1), s);
  assert.equal(s, "settings");
  // and back again, third entry — must keep working
  s = routeNav(state(0, 2, 1), state(0, 2, 2), s);
  assert.equal(s, "library");
  s = routeNav(state(0, 2, 2), state(0, 3, 2), s);
  assert.equal(s, "settings");
});

test("no counter change → screen unchanged", () => {
  assert.equal(routeNav(state(1, 2, 1), state(1, 2, 1), "library"), "library");
  assert.equal(routeNav(state(1, 2, 1), state(1, 2, 1), "settings"), "settings");
  assert.equal(routeNav(state(1, 2, 1), state(1, 2, 1), "player"), "player");
});

test("settings request only routes FROM the library", () => {
  assert.equal(routeNav(state(0, 0, 0), state(0, 1, 0), "player"), "player");
  assert.equal(routeNav(state(0, 0, 0), state(0, 1, 0), "connect"), "connect");
  assert.equal(routeNav(state(0, 0, 0), state(0, 1, 0), "settings"), "settings");
});

test("library request only routes FROM settings", () => {
  assert.equal(routeNav(state(0, 1, 0), state(0, 1, 1), "library"), "library");
  assert.equal(routeNav(state(0, 1, 0), state(0, 1, 1), "player"), "player");
  assert.equal(routeNav(state(0, 1, 0), state(0, 1, 1), "connect"), "connect");
});

test("backLevel changes never route", () => {
  assert.equal(routeNav(state(0, 1, 1), state(5, 1, 1), "library"), "library");
  assert.equal(routeNav(state(0, 1, 1), state(5, 1, 1), "settings"), "settings");
});
