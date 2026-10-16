// A cross-process lock for gate tests that run the REAL build. Vitest runs
// test files in parallel workers; build-stamp.test.mjs and package.test.mjs
// both rebuild js/ (and the packaging gate hashes js/ mid-sequence), so two
// concurrent builds would stage each other's output and the byte-identity
// compare would flake. A directory lock (mkdir is atomic) serializes them.
//
// The lock lives in the OS temp dir, never the repo. A crashed builder can
// leak it; callers time out (with a loud error) instead of hanging.
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "putio-build-lock");

export async function withBuildLock(fn, { timeoutMs = 180_000 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timed out waiting for the build lock after ${timeoutMs} ms — another gate test is still building (stale lock at ${LOCK}?)`
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}
