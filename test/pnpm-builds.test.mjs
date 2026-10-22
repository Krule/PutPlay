// pnpm build-script approvals: CI installs from a clean checkout.
//
// pnpm 10+ blocks dependencies' install scripts unless they are approved —
// esbuild's postinstall places its platform binary, so it must be on the
// approval list. pnpm 11+ makes an unapproved list a HARD install error
// (ERR_PNPM_IGNORED_BUILDS) and reads the approvals from
// pnpm-workspace.yaml (the old package.json#pnpm block is no longer read).
// ec10f9d removed that package.json block, so every clean CI install died
// at "Install dependencies" (2026-10-22, both workflows, both runs).
//
// Gate: the approvals file exists and names esbuild. The artifact proof is
// CI itself — a clean checkout's install must succeed.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("pnpm-workspace.yaml approves esbuild's build script", () => {
  const p = join(root, "pnpm-workspace.yaml");
  assert.ok(
    existsSync(p),
    "pnpm-workspace.yaml is missing — pnpm 11+ reads build-script approvals " +
      "only from it (package.json#pnpm is ignored), so a clean CI install " +
      "dies with ERR_PNPM_IGNORED_BUILDS",
  );
  const txt = read("pnpm-workspace.yaml");
  const m = txt.match(/^onlyBuiltDependencies:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m);
  assert.ok(
    m,
    "onlyBuiltDependencies must be a non-empty list in pnpm-workspace.yaml",
  );
  const deps = m[1]
    .split("\n")
    .map((l) => l.replace(/^[ \t]+-[ \t]*/, "").trim())
    .filter(Boolean);
  assert.ok(
    deps.includes("esbuild"),
    "esbuild must be approved (its postinstall places the platform binary); " +
      `got: ${deps.join(", ") || "(none)"}`,
  );
});
