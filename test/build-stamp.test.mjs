// Build stamp: the bundle must identify the commit that built it.
//
// Rationale: the webOS-visible version (appinfo.json) stays clean X.Y.Z —
// that's what the OS compares for updates and what the ipk filename uses.
// The git commit is diagnostic info ("which build is on the TV?") and
// belongs in the Account screen, injected at build time via a define.
//
// Contract:
//  - the vite build injects __BUILD__ = { version, sha, dirty } from git;
//    the stamp logic lives in build/build-stamp.mjs (behavior-tested below,
//    in a scratch git repo — the real worktree is never mutated)
//  - the REAL production build must contain the current short sha (runtime
//    proof, not a pattern) and no leftover __BUILD__ identifier
//  - the minified ARTIFACT css (js/bundle.css — the sheet the TV loads)
//    must stay Chrome-79 safe: the minifier may not fold longhands into
//    shorthands the TV silently ignores (see chrome79-css.test.mjs §4)
//  - build-info.ts guards with typeof (null outside a built context)
//  - Settings shows the stamp
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";
import { tmpdir } from "node:os";
import { gitBuildStamp, buildStamp } from "../build/build-stamp.mjs";
import { withBuildLock } from "./shims/build-lock.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("build-info.ts: null outside a built context (typeof guard, no ReferenceError)", async () => {
  const mod = await import("../src/ui/build-info.ts");
  assert.equal(mod.BUILD_INFO, null);
});

/* ---------------- stamp logic (build/build-stamp.mjs) ---------------- */

/** A scratch git repo holding the three file kinds the dirty check must
 *  reason about: the two version manifests + a real source file. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "stamp-"));
  const git = (args) => execSync(`git ${args}`, { cwd: dir, stdio: "pipe" });
  git("init -q");
  git("config user.email test@example.com");
  git("config user.name Test");
  // the machine's git config signs commits (1Password agent) — the scratch
  // fixture must not, or every commit here needs biometric approval
  git("config commit.gpgsign false");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
  writeFileSync(join(dir, "appinfo.json"), JSON.stringify({ version: "9.9.9" }));
  writeFileSync(join(dir, "src.txt"), "app\n");
  git("add -A");
  git("commit -qm init");
  return { dir, git };
}

test("gitBuildStamp: a clean tree is not dirty and carries the current short sha", () => {
  const { dir, git } = scratchRepo();
  try {
    const sha = git("rev-parse --short HEAD").toString().trim();
    const stamp = gitBuildStamp(dir);
    assert.equal(stamp.sha, sha, "the sha must come from git, not be hardcoded");
    assert.equal(stamp.dirty, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitBuildStamp: the release pipeline's version write is NOT dirty (the two manifests)", () => {
  // The pipeline applies the tag's version to package.json + appinfo.json
  // BEFORE building (build/release-version.mjs — the tag carries the
  // version, the manifests at that commit hold the old one). If the
  // stamp's git-status check counted that intentional write, EVERY store
  // build would read "(dirty)" on the TV regardless of tree hygiene —
  // v1.1.2 shipped with dirty:!0 for exactly this reason.
  const { dir } = scratchRepo();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.10.0" }));
    writeFileSync(join(dir, "appinfo.json"), JSON.stringify({ version: "9.10.0" }));
    assert.equal(
      gitBuildStamp(dir).dirty,
      false,
      "the two version manifests must not count as dirt"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitBuildStamp: any other modified file IS dirty (the dirty flag must come from the worktree)", () => {
  const { dir } = scratchRepo();
  try {
    writeFileSync(join(dir, "src.txt"), "app\nchanged\n");
    assert.equal(gitBuildStamp(dir).dirty, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitBuildStamp: untracked files count as dirty", () => {
  const { dir } = scratchRepo();
  try {
    writeFileSync(join(dir, "stray.txt"), "wip\n");
    assert.equal(gitBuildStamp(dir).dirty, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitBuildStamp: outside a git checkout the stamp is null, never a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "stamp-nogit-"));
  try {
    assert.deepEqual(gitBuildStamp(dir), { sha: null, dirty: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildStamp: version comes from the checkout's package.json, git fields from the tree", () => {
  const { dir, git } = scratchRepo();
  try {
    const stamp = buildStamp(dir);
    assert.equal(stamp.version, "9.9.9");
    assert.equal(stamp.sha, git("rev-parse --short HEAD").toString().trim());
    assert.equal(stamp.dirty, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- the vite config (contract, pattern-level) ---------------- */

test("vite.config.mts injects the git build stamp via define", () => {
  const cfg = read("vite.config.mts");
  assert.ok(/["']?__BUILD__["']?\s*:/.test(cfg), "a __BUILD__ define must exist");
  assert.ok(
    /buildStamp/.test(cfg) && /build-stamp\.mjs/.test(cfg),
    "the stamp must come from build/build-stamp.mjs (git, not hardcoded)"
  );
});

test("vite.config.mts targets the TV's Chromium via build/options.mjs", () => {
  // The chrome79 invariant (build/options.mjs): the minifier must not fold
  // longhands into shorthands Chromium 79 can't read. The target is a
  // single source of truth — the config must CONSUME it, not hardcode it
  // (a hardcoded 'chrome79' in the config would survive someone raising
  // options.mjs without raising the build).
  const cfg = read("vite.config.mts");
  assert.ok(
    /browserTarget/.test(cfg) && /options\.mjs/.test(cfg),
    "the target must be imported from build/options.mjs"
  );
  assert.ok(/target\s*:\s*browserTarget/.test(cfg), "build.target must be the shared browserTarget");
});

/* ---------------- runtime proof (the real build) ---------------- */

test("Settings shows the build stamp (version + sha + dirty marker)", () => {
  const settings = read("src/ui/screens/Settings.svelte");
  assert.ok(/BUILD_INFO/.test(settings), "Settings must consume BUILD_INFO");
  assert.ok(/dirty/.test(settings), "a dirty build must be marked as such");
});

test("RUNTIME: the real vite build carries this checkout's sha and Chrome-79-safe artifact CSS", { timeout: 180_000 }, () => {
  const sha = execSync("git rev-parse --short HEAD", { cwd: root, stdio: "pipe" }).toString().trim();
  return withBuildLock(async () => {
    execSync("pnpm exec vite build", { cwd: root, stdio: "pipe", timeout: 120_000 });
    const bundle = read("js/bundle.js");
    assert.ok(bundle.includes(sha), `bundle must carry the build sha ${sha} (which-build-is-this answer)`);
    assert.ok(!bundle.includes("__BUILD__"), "the __BUILD__ identifier must be compiled out (replaced by define)");
    assert.ok(existsSync(join(root, "js", "bundle.js")), "build produced js/bundle.js");

    // Artifact CSS: source-clean ≠ artifact-safe. The minified bundle.css
    // is the sheet index.html loads on the TV — it must stay longhand.
    const css = read("js/bundle.css");
    const merged = [...new Set([...css.matchAll(/(^|[;{])(inset|size)\s*:/g)].map((m) => m[2]))];
    assert.equal(
      merged.length,
      0,
      `js/bundle.css contains shorthands Chromium 79 can't read: ${merged.join(", ")} — point the build target at the TV (build/options.mjs)`
    );
  });
});
