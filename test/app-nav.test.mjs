// Chrome-agnostic source gate: the App's nav subscription must be
// EDGE-triggered through the tested routeNav decision.
//
// The bug it guards: level-triggered conditions (`navToSettings > 0`) over
// monotonic counters re-fire on every store update; combined with two
// sequential ifs reading a screen the first just assigned, they revert every
// navigation after the first round-trip (the .acct "does nothing" bug).
//
// Run: npm test
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "ui", "App.svelte"), "utf8");

test("App routes nav signals through the pure routeNav decision", () => {
  assert.ok(
    /routeNav\(/.test(src),
    "App.svelte must call routeNav(prev, next, screen) — the routing decision is a unit-tested pure function"
  );
});

test("no level-triggered counter conditions remain in App.svelte", () => {
  assert.ok(
    !/navToSettings\s*>\s*0/.test(src),
    "level-triggered `navToSettings > 0` must be gone — monotonic counters make it re-fire forever"
  );
  assert.ok(
    !/navToLibrary\s*>\s*0/.test(src),
    "level-triggered `navToLibrary > 0` must be gone — it reverted every settings entry after the first round-trip"
  );
});
