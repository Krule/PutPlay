// Build stamp: the bundle must identify the commit that built it.
//
// Rationale: the webOS-visible version (appinfo.json) stays clean X.Y.Z —
// that's what the OS compares for updates and what the ipk filename uses.
// The git commit is diagnostic info ("which build is on the TV?") and
// belongs in the Account screen, injected at build time via esbuild define.
//
// Contract:
//  - esbuild injects __BUILD__ = { version, sha, dirty } from git
//  - the REAL production build must contain the current short sha (runtime
//    proof, not a pattern) and no leftover __BUILD__ identifier
//  - build-info.ts guards with typeof (null outside a built context)
//  - Settings shows the stamp
//
// Run: npm test
import test from "node:test";
import assert from "assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("build-info.ts: null outside a built context (typeof guard, no ReferenceError)", async () => {
  const mod = await import("../src/ui/build-info.ts");
  assert.equal(mod.BUILD_INFO, null);
});

test("esbuild.mjs injects the git build stamp via define", () => {
  const esbuild = read("build/esbuild.mjs");
  assert.ok(/"__BUILD__"\s*:\s*JSON\.stringify/.test(esbuild), "a __BUILD__ define must exist");
  assert.ok(/git rev-parse --short HEAD/.test(esbuild), "the sha must come from git, not be hardcoded");
  assert.ok(/git status --porcelain/.test(esbuild), "the dirty flag must come from the worktree");
});

test("Settings shows the build stamp (version + sha + dirty marker)", () => {
  const settings = read("src/ui/screens/Settings.svelte");
  assert.ok(/BUILD_INFO/.test(settings), "Settings must consume BUILD_INFO");
  assert.ok(/dirty/.test(settings), "a dirty build must be marked as such");
});

test("RUNTIME: the real production build contains this checkout's short sha", { timeout: 60_000 }, () => {
  const sha = execSync("git rev-parse --short HEAD", { cwd: root, stdio: "pipe" }).toString().trim();
  execSync("node build/esbuild.mjs", { cwd: root, stdio: "pipe" });
  const bundle = read("js/bundle.js");
  assert.ok(bundle.includes(sha), `bundle must carry the build sha ${sha} (which-build-is-this answer)`);
  assert.ok(!bundle.includes("__BUILD__"), "the __BUILD__ identifier must be compiled out (replaced by define)");
  assert.ok(existsSync(join(root, "js", "bundle.js")), "build produced js/bundle.js");
});
