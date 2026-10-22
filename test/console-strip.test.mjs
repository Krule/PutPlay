// Console hygiene: the packaged app must not log.
//
// The raw-ASS work left TEMP-DIAG console diagnostics in five source files,
// and the app ships hls.js (21 console.* calls inside its dist bundle). A
// TV user must never see developer chatter:
//
//  - SOURCE: no TEMP-DIAG marker may survive. Each marker is a promise —
//    "remove after the on-device check" — and the check is done (2026-10-22,
//    on-device multipart confirmed), so a surviving marker is broken
//    hygiene, not pending work.
//  - CONFIG: the production build (vite build without --watch — exactly the
//    NODE_ENV "production" condition) drops console.* and debugger via
//    esbuild, so the ipk carries none of them, ours or the libraries'.
//    `pnpm dev` and `build --watch` keep the logs — that is where they
//    serve their purpose.
//  - ARTIFACT: the real production bundle contains no console calls
//    (pattern/config tests can drift from what esbuild actually does;
//    the artifact is the contract).
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";
import { withFreshBuild } from "./shims/build-fresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/** Every source file under src/, root-relative (the only code that reaches the bundle). */
function srcFiles(dir = join(root, "src"), out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) srcFiles(p, out);
    else if (/\.(ts|svelte|mjs|js|css)$/.test(e.name)) out.push(p.slice(root.length + 1));
  }
  return out;
}

test("src/ carries no TEMP-DIAG markers (the on-device check is done — delete the log each one annotates)", () => {
  const bad = [];
  for (const p of srcFiles()) {
    const lines = read(p).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("TEMP-DIAG")) bad.push(`${p}:${i + 1}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    "TEMP-DIAG means 'remove after the on-device check' — delete the diagnostic it annotates (keep a persistent console.error on a failure path only):\n" +
      bad.join("\n")
  );
});

test("vite.config.mts drops console+debugger for the production build only", () => {
  const cfg = read("vite.config.mts");
  const line = cfg.split("\n").find((l) => /esbuild\s*:/.test(l)) ?? "";
  assert.ok(
    line,
    "an esbuild option must be configured (on one line — this gate reads the line, keep it that way)"
  );
  assert.ok(
    /isBuild\s*&&\s*!isWatch/.test(line),
    "the drop must be behind the production condition (isBuild && !isWatch) — dev and build --watch keep their logs"
  );
  assert.ok(/drop/.test(line), "console/debugger must be dropped");
  assert.ok(
    /"console"/.test(line) && /"debugger"/.test(line),
    "drop both console and debugger"
  );
});

test("RUNTIME: the production bundle carries no console calls (ours or the libraries')", { timeout: 180_000 }, () => {
  return withFreshBuild(root, () => {
    const bundle = read("js/bundle.js");
    const hits = [...new Set([...bundle.matchAll(/\bconsole\.[a-zA-Z_$][\w$]*\s*\(/g)].map((m) => m[0]))];
    assert.deepEqual(
      hits,
      [],
      `js/bundle.js ships console calls: ${hits.join(", ")} — the production build must drop them (esbuild drop in vite.config.mts)`
    );
  });
});
