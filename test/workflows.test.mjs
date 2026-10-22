// CI pnpm pin: the workflows must name the pnpm major for action-setup@v4.
//
// pnpm/action-setup@v4 with no `version:` input reads the `packageManager`
// field of package.json. That field was deliberately removed (55af013,
// "unpin packageManager" — the repo runs pnpm 12, lockfile v10), so an
// action-setup step without an explicit version dies with
// "No pnpm version is specified." — which took CI AND the release
// workflow down on every push 2026-10-21..22 (the v1.2.2 release had run
// the day before the unpin, which is why it shipped fine).
//
// Gate: every workflow that installs pnpm must carry a `version:` input on
// that step — the same step-local pattern the console-strip gate applies to
// vite.config.mts.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/** The lines of one workflow step, from its `- uses:` to the next step. */
function stepLines(lines, idx) {
  const out = [lines[idx]];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\s*- uses:/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

test("every workflow pins a pnpm version on its action-setup step", () => {
  const files = readdirSync(join(root, ".github", "workflows")).filter((f) =>
    f.endsWith(".yml") || f.endsWith(".yaml"),
  );
  assert.ok(files.length, "expected at least one workflow in .github/workflows/");
  const offenders = [];
  for (const f of files) {
    const lines = read(join(".github", "workflows", f)).split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("pnpm/action-setup")) return;
      if (!stepLines(lines, i).some((l) => /^\s+version:/.test(l))) {
        offenders.push(`${f}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "pnpm/action-setup without a `version:` input falls back to package.json's " +
      "packageManager field — which this repo no longer carries. Give the step " +
      "`with: version: 12` (the toolchain major):\n" + offenders.join("\n"),
  );
});
