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

test("every pnpm global-install step puts pnpm's global bin dir on PATH", () => {
  // pnpm 12 hard-errors (ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH) when a
  // `pnpm add -g` runs with the global bin dir off PATH — pnpm 10 only
  // warned, so this died the moment CI ran on the pnpm 12 line (2026-10-22,
  // the "Install ares" step, both workflows). The bin dir is
  // $PNPM_HOME/bin (pnpm/action-setup sets PNPM_HOME), and the export must
  // also land on GITHUB_PATH so LATER steps (Package ipk runs ares-package)
  // find the binary — a plain export dies with the step.
  const files = readdirSync(join(root, ".github", "workflows")).filter((f) =>
    f.endsWith(".yml") || f.endsWith(".yaml"),
  );
  const offenders = [];
  for (const f of files) {
    const text = read(join(".github", "workflows", f));
    const lines = text.split("\n");
    // A step block runs from a 6-space `- name:`/`- uses:` to the next one.
    const starts = lines
      .map((l, i) => (/^ {6}- (name|uses):/.test(l) ? i : -1))
      .filter((i) => i >= 0);
    starts.forEach((s, k) => {
      const e = k + 1 < starts.length ? starts[k + 1] : lines.length;
      const block = lines.slice(s, e);
      const addIdx = block.findIndex((l) => l.includes("pnpm add -g"));
      if (addIdx === -1) return;
      const exportIdx = block.findIndex(
        (l) => l.includes("export PATH=") && l.includes("$PNPM_HOME/bin"),
      );
      const githubPathIdx = block.findIndex(
        (l) =>
          l.includes("$GITHUB_PATH") && l.includes("$PNPM_HOME/bin"),
      );
      if (exportIdx === -1 || exportIdx >= addIdx) {
        offenders.push(
          `${f}:${s + 1} — export PATH=\"$PNPM_HOME/bin:$PATH" is missing or comes after the pnpm add -g line`,
        );
      }
      if (githubPathIdx === -1) {
        offenders.push(
          `${f}:${s + 1} — the global bin dir must be appended to $GITHUB_PATH so later steps find the installed binary`,
        );
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "pnpm 12 refuses a global install while its bin dir is off PATH (pnpm 10 only warned):\n" + offenders.join("\n"),
  );
});

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
