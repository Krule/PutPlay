/**
 * Build stamp: which commit (and whether the tree was dirty) produced
 * this bundle. Shown on the Account screen; not part of the webOS version.
 *
 * Consumed by vite.config.mts, which injects it as the __BUILD__ define
 * at build time. Kept out of the config on purpose: it shells out to git
 * and is behavior-tested in test/build-stamp.test.mjs.
 */
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * The release pipeline intentionally rewrites these two manifests from
 * the tag (build/release-version.mjs) BEFORE the build — the tag carries
 * the new version, the manifests at that commit hold the old one. That
 * write is part of a clean release, not local dirt.
 */
export const VERSION_MANIFESTS = new Set(["package.json", "appinfo.json"]);

export function gitBuildStamp(cwd = repoRoot()) {
  try {
    const sha = execSync("git rev-parse --short HEAD", { cwd, stdio: "pipe" }).toString().trim();
    const status = execSync("git status --porcelain", { cwd, stdio: "pipe" }).toString();
    const dirty = status
      .split("\n")
      .map((line) => line.slice(3)) // "XY <path>" -> path
      .filter((path) => path.length > 0 && !VERSION_MANIFESTS.has(path))
      .length > 0;
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: false }; // not a git checkout (e.g. a dist zip)
  }
}

export function buildStamp(cwd = repoRoot()) {
  const version = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version;
  return { version, ...gitBuildStamp(cwd) };
}
