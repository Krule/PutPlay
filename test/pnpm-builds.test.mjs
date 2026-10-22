// pnpm build-script approvals: CI installs from a clean checkout.
//
// pnpm 12 blocks dependencies' install scripts unless they are approved —
// esbuild's postinstall places its platform binary (svelte-preprocess runs
// a notice script), so both must be approved. pnpm 12 makes unapproved
// builds a HARD install error (ERR_PNPM_IGNORED_BUILDS) and reads the
// approvals from the `allowBuilds` map in pnpm-workspace.yaml (written by
// `pnpm approve-builds`; the older `onlyBuiltDependencies` list and the
// package.json#pnpm block are no longer honoured — that stale config is
// exactly what killed every clean CI install on 2026-10-22 after ec10f9d
// removed the old package.json block).
//
// Gate: pnpm-workspace.yaml exists and approves esbuild + svelte-preprocess
// via `allowBuilds`. The artifact proof is CI itself — a clean checkout's
// install must succeed.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

test("pnpm-workspace.yaml approves the build scripts (pnpm 12 allowBuilds)", () => {
  const rel = "pnpm-workspace.yaml";
  assert.ok(
    existsSync(join(root, rel)),
    "pnpm-workspace.yaml is missing — pnpm 12 reads build-script approvals " +
      "only from it (package.json#pnpm is ignored), so a clean CI install " +
      "dies with ERR_PNPM_IGNORED_BUILDS",
  );
  const txt = readFileSync(join(root, rel), "utf8");
  const m = txt.match(/^allowBuilds:[ \t]*\n((?:[ \t]+\S+:[ \t]*(?:true|false)[ \t]*\n?)+)/m);
  assert.ok(
    m,
    "pnpm 12 approvals must be an `allowBuilds` map in pnpm-workspace.yaml " +
      "(run `pnpm approve-builds`); the legacy onlyBuiltDependencies list is " +
      "not honoured",
  );
  const allowed = new Set(
    m[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .filter((l) => /:\s*true\s*$/.test(l))
      .map((l) => l.split(":")[0].trim()),
  );
  for (const dep of ["esbuild", "svelte-preprocess"]) {
    assert.ok(
      allowed.has(dep),
      `${dep} must be approved in allowBuilds (its install script is required); ` +
        `approved: ${[...allowed].join(", ") || "(none)"}`,
    );
  }
});
