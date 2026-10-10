import test from "node:test";
import assert from "assert/strict";
import { createRequire } from "module";
import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "putio-test-"));
const bundle = path.join(tmp, "fmt.cjs");
execSync(
  `npx esbuild ${path.join(here, "..", "src", "putio", "api.ts")} --bundle --format=cjs --platform=node --external:hls.js --external:webostvjs/webOSTV --outfile=${bundle}`,
  { cwd: path.join(here, ".."), stdio: "pipe" }
);
const require = createRequire(import.meta.url);
const { fmtBytes, fmtTime } = require(bundle);

// clean up the temp bundle (lives in the OS temp dir, never the repo)
test("teardown: remove temp bundle", () =>
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
);

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
