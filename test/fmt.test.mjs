import { test } from "vitest";
import assert from "assert/strict";
import { fmtBytes, fmtTime } from "../src/putio/api.ts";

test("fmtBytes: B -> KB -> MB -> GB -> TB", () => {
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(1024 * 1024 * 1024), "1 GB");
  assert.equal(fmtBytes(1024 * 1024 * 1024 * 1024), "1 TB");
  assert.equal(fmtBytes(5 * 1024 * 1024), "5 MB");
});

test("fmtBytes: 29249681591 = ~29 GB (not 27895 MB)", () => {
  const out = fmtBytes(29249681591);
  assert.match(out, /GB/, `got ${out}`);
  const n = parseFloat(out);
  assert.ok(n > 27 && n < 31, `magnitude wrong: ${out}`);
});

test("fmtBytes: null/NaN -> empty", () => {
  assert.equal(fmtBytes(null), "");
  assert.equal(fmtBytes(NaN), "");
});

test("fmtTime: 7325s -> 2:02:05", () => {
  assert.equal(fmtTime(7325), "2:02:05");
  assert.equal(fmtTime(65), "1:05");
});
