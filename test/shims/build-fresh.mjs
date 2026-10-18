// Build-once-per-tree-state for the gate tests that run a REAL production
// build (build-stamp, package).
//
// Both gates need a production build of the CURRENT tree, and the build lock
// (build-lock.mjs) only serializes them — it doesn't share. So a cold suite
// run paid for the build three times (build-stamp once, package twice — one
// per test). This shim adds the sharing: the first build for a given tree
// state is the only build, in this run or the next, until the tree changes.
//
// A cached build is legitimate here, not a shortcut: the key is a hash of
// the tree's CONTENT (short sha + `git diff HEAD` + every untracked
// non-ignored file's content). A matching key means vite's inputs are
// byte-identical, so the js/ on disk IS the output this tree would build.
// Any edit — tracked or untracked — changes the key and forces a rebuild.
// A fresh checkout has no state file and always builds.
//
// The state file lives in the OS temp dir (like the lock), never in the
// repo: js/ is staged into the ipk verbatim, so nothing test-only may sit
// inside it.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { withBuildLock } from "./build-lock.mjs";

/**
 * A hash of the tree's CONTENT at `root`: the short HEAD sha, the full
 * `git diff HEAD`, and the path+content of every untracked (non-ignored)
 * file. Deterministic for an unchanged tree; any edit changes it.
 */
export function treeKey(root) {
  const out = (cmd) => execSync(cmd, { cwd: root, stdio: "pipe" }).toString();
  const sha = out("git rev-parse --short HEAD").trim();
  const diff = out("git diff HEAD");
  const untracked = out("git status --porcelain")
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim().replace(/^"(.*)"$/, "$1"))
    .sort();
  // git reports a wholly-untracked directory as "?? dir/" — expand it to its
  // files, the way git would track them
  const files = [];
  for (const f of untracked) {
    if (f.endsWith("/")) {
      const walk = (dir, prefix) => {
        for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const p = prefix + e.name;
          if (e.isDirectory()) walk(join(dir, e.name), p + "/");
          else if (e.isFile()) files.push(p);
        }
      };
      walk(join(root, f), f);
    } else {
      files.push(f);
    }
  }
  files.sort();
  const h = createHash("sha256");
  h.update(sha);
  h.update("\0");
  h.update(diff);
  for (const f of files) {
    h.update("\0");
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(root, f)));
  }
  return h.digest("hex");
}

/** Where the build-state file for a repo root lives (OS temp dir, keyed by root). */
export function stateFile(root) {
  const rootKey = createHash("sha256").update(root).digest("hex").slice(0, 10);
  return join(tmpdir(), `putio-build-state-${rootKey}.json`);
}

/**
 * Run fn with js/ guaranteed FRESH for the current tree state.
 *
 * Under the build lock (so no other gate test can republish js/ mid-fn):
 * compute the tree key, and if a build for exactly this key already exists
 * (state file matches AND both artifacts are on disk), skip the build —
 * otherwise run `build` (default: the real vite build) and record the key.
 * Then run fn.
 *
 * @param {string} root  the repo root the artifacts live in
 * @param {() => any} fn  runs with js/ fresh; its return is withFreshBuild's
 * @param {{ build?: string, timeoutMs?: number }} [opts]  build command
 *   override (unit tests use a fake), lock wait timeout
 */
export async function withFreshBuild(root, fn, { build = "pnpm exec vite build", timeoutMs = 180_000 } = {}) {
  return withBuildLock(
    async () => {
      const key = treeKey(root);
      const st = stateFile(root);
      const artifacts = [join(root, "js", "bundle.js"), join(root, "js", "bundle.css")];
      const fresh =
        existsSync(st) &&
        artifacts.every((p) => existsSync(p)) &&
        JSON.parse(readFileSync(st, "utf8")).key === key;
      if (!fresh) {
        execSync(build, { cwd: root, stdio: "pipe", timeout: 120_000 });
        writeFileSync(st, JSON.stringify({ key, at: new Date().toISOString() }));
      }
      return fn();
    },
    { timeoutMs }
  );
}
