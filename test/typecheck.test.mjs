// Type gate: the esbuild build strips types WITHOUT checking them, so TS
// errors (missing imports, wrong fields, dead locals) ship silently. This
// gate runs tsc over the pure source tree on every test run.
//
// .svelte files are not in scope (tsc can't parse them) — screen-level type
// mistakes are caught by the build + the e2e harness.
//
// Run: npm test
import { execSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

test("tsc: the pure source tree typechecks clean (no unused locals/params)", () => {
  let out = "";
  try {
    out = execSync(
      "npx tsc --noEmit --noUnusedLocals --noUnusedParameters " +
        "--target es2019 --module esnext --moduleResolution node --skipLibCheck " +
        "src/putio/*.ts src/webos/*.ts src/store/*.ts",
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (e) {
    assert.fail(`tsc reported type errors:\n${e.stdout || ""}${e.stderr || ""}${out}`);
  }
});
