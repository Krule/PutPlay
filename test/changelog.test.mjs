// Gate: CHANGELOG.md must stay current with the releases. Every pushed tag
// vX.Y.Z needs a "## [X.Y.Z]" section — a release that ships without a
// changelog entry is a process violation (see the Changelog section in
// AGENTS.md for the maintenance rules this gate enforces).
// Skipped where the invariant is not checkable: no git checkout, or a
// checkout with no tags visible (CI branch pushes — the Release workflow,
// which does see the tag, is the enforcement point).
import { test } from "vitest";
import assert from "assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function latestTagVersion() {
  const tag = execSync("git tag --sort=-v:refname | head -1", { cwd: root, stdio: "pipe" }).toString().trim();
  return tag ? tag.replace(/^v/, "") : null;
}

// The invariant is only checkable where git tags are visible (a git
// checkout that knows at least one tag) — decide at collection time.
let latestVersion = null;
let gitBroken = false;
try {
  latestVersion = latestTagVersion();
} catch {
  gitBroken = true;
}

test.runIf(!gitBroken && latestVersion !== null)(
  "CHANGELOG.md has a section for the latest release tag",
  () => {
    const file = join(root, "CHANGELOG.md");
    if (!existsSync(file)) {
      assert.fail("CHANGELOG.md is missing from the repo root");
    }
    const changelog = readFileSync(file, "utf8");
    assert.ok(
      new RegExp(`^## \\[${latestVersion}\\]`, "m").test(changelog),
      `CHANGELOG.md has no "## [${latestVersion}]" section for the latest tag`
    );
  }
);
