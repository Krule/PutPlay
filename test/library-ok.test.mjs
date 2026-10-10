// Unit tests for the Library OK/press decision (src/putio/library-ok.ts).
//
// The library must behave identically for both remotes: a Magic-Remote
// pointer click already hits the focused element's own handler; the common
// 5-way remote's OK key must activate the SPATIALLY FOCUSED control — not
// whatever tile happened to be selected last. (The old handler re-opened
// `library.selected` on every OK, so pressing OK on the .acct header button
// did nothing or replayed the last file.)
//
// Run: npm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const out = join(mkdtempSync(join(tmpdir(), "putio-test-")), "library-ok.cjs");
await build({
  entryPoints: ["src/putio/library-ok.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const require = createRequire(import.meta.url);
const { libraryOkAction } = require(out);

test("a spatially focused control always wins — OK activates it", () => {
  assert.equal(libraryOkAction(true, true), "activate-focused");
  assert.equal(libraryOkAction(true, false), "activate-focused");
});

test("no focused control → fall back to the last selected item", () => {
  assert.equal(libraryOkAction(false, true), "open-selected");
});

test("nothing focused, nothing selected → no-op", () => {
  assert.equal(libraryOkAction(false, false), "none");
});
