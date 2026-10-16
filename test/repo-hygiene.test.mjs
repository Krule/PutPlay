// Repo hygiene: nothing under node_modules/ may be TRACKED.
//
// The bug this guards: a tracked node_modules file that pnpm recreates
// differently on a fresh checkout (e.g. .bin shims: committed as regular
// files, recreated as symlinks) makes `git status --porcelain` non-empty
// after `pnpm install` — so the build stamp, and therefore EVERY official .ipk
// from the release pipeline, reads "(dirty)" even though the code is
// exactly the release commit. .gitignore already covers node_modules/,
// but gitignore cannot untrack a file committed before the rule existed.
//
// Run: pnpm test
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("no file under node_modules/ is tracked (a fresh pnpm install must not dirty the tree)", () => {
  const tracked = execSync("git ls-files", { cwd: root, stdio: "pipe" })
    .toString()
    .split("\n")
    .filter(Boolean);
  const bad = tracked.filter((p) => p === "node_modules" || p.startsWith("node_modules/"));
  assert.deepEqual(
    bad,
    [],
    "These node_modules files are tracked — untrack with `git rm --cached` (gitignore already covers the directory):\n" +
      bad.join("\n")
  );
});
