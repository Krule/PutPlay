// Unit tests for the picker-overlay default-focus decision
// (src/putio/picker-default.ts).
//
// When the Player opens a pick overlay (audio track, subtitles, source), the
// D-pad focus must land on the natural row: the one that is currently
// selected (so OK re-confirms the current choice and arrows explore the rest),
// else the first enabled row. Disabled rows (e.g. "put.io MP4" when
// unavailable) are never a focus target.
//
// Run: npm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const out = join(mkdtempSync(join(tmpdir(), "putio-test-")), "picker-default.cjs");
await build({
  entryPoints: ["src/putio/picker-default.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const require = createRequire(import.meta.url);
const { pickerDefaultIndex, rowFocusState } = require(out);

test("the currently selected row wins", () => {
  assert.equal(pickerDefaultIndex([{}, { selected: true }, {}]), 1);
});

test("first selected row wins when several are marked", () => {
  assert.equal(pickerDefaultIndex([{ selected: true }, { selected: true }]), 0);
});

test("no selection → first row", () => {
  assert.equal(pickerDefaultIndex([{}, {}]), 0);
});

test("disabled rows are skipped", () => {
  assert.equal(pickerDefaultIndex([{ disabled: true }, {}, {}]), 1);
  assert.equal(pickerDefaultIndex([{ disabled: true }, { disabled: true }, {}]), 2);
});

test("a selected-but-disabled row is not a target — fall back to enabled", () => {
  assert.equal(pickerDefaultIndex([{ selected: true, disabled: true }, {}]), 1);
});

test("all rows disabled → no focus target", () => {
  assert.equal(pickerDefaultIndex([{ disabled: true }, { disabled: true }]), -1);
  assert.equal(pickerDefaultIndex([]), -1);
});

test("rowFocusState reads sel/disabled state from a real element", () => {
  // minimal DOM stub: the helper only touches classList/dataset
  const el = (opts) => ({
    classList: { contains: (c) => (opts.class || "").split(" ").includes(c) },
    dataset: { focusDisabled: opts.disabled ? "true" : "" },
  });
  assert.deepEqual(
    rowFocusState(el({ class: "pick-row sel" }), "sel"),
    { selected: true, disabled: false }
  );
  assert.deepEqual(
    rowFocusState(el({ class: "pick-row", disabled: true }), "sel"),
    { selected: false, disabled: true }
  );
});
