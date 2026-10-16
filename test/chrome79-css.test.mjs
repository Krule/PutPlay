// Chrome-79 (webOS 6) CSS compatibility gate.
//
// webOS 6.0 ships Chromium 79. Anything newer is either a hard parse failure
// or — worse — a SILENT NO-OP on the TV (flex `gap`, `inset`, ...), which
// reads on the device as "layout broken" with no console error. This gate
// scans the global theme + every <style> block:
//   1. no flex container uses `gap` (Chromium 84+; grid gap is fine — 66+)
//   2. no post-79 properties/units/selectors/color functions
//   3. :focus-visible rules (Chrome 86+, kept for desktop parity) must live
//      inside @supports selector(:focus-visible) and never share a selector
//      list with other selectors — an unknown pseudo-class anywhere in a
//      selector list invalidates the WHOLE rule, which would kill the
//      :focus outline on the TV.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// collect {file, css} for the global theme + every <style> block
function collectCSS(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "js") continue;
      collectCSS(p, out);
      continue;
    }
    if (name.endsWith(".css")) out.push({ file: p, css: readFileSync(p, "utf8") });
    if (name.endsWith(".svelte")) {
      const s = readFileSync(p, "utf8");
      const m = s.match(/<style[^>]*>([\s\S]*?)<\/style>/);
      if (m) out.push({ file: p, css: m[1] });
    }
  }
  return out;
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** pair up top-level rules: {selector, body, start} (start = selector index) */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim(), body: m[2], start: m.index });
  return out;
}

function prop(body, name) {
  const m = body.match(new RegExp("(?:^|[;{\\s])" + name + "\\s*:(.*?)(?=[;]|$)", "s"));
  return m ? m[1].trim() : null;
}
function hasProp(body, name) {
  return new RegExp("(?:^|[;{\\s])" + name + "\\s*:", "s").test(body);
}

/** index ranges of @supports selector(:focus-visible) blocks */
function fvSupportsRanges(css) {
  const ranges = [];
  const re = /@supports\s+selector\(\s*:focus-visible\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let j = re.lastIndex;
    while (j < css.length && depth) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    ranges.push([m.index, j]);
  }
  return ranges;
}

const sheets = collectCSS(join(root, "src"));

/* ---------------- 1. flex gap (Chromium 84+) ---------------- */

test("no flex container uses `gap` (Chromium 84+; webOS 6 = 79)", () => {
  const bad = [];
  for (const { file, css } of sheets) {
    for (const r of rules(css)) {
      const display = prop(r.body, "display");
      if (!display) continue;
      if (!/inline-?flex/.test(display)) continue;
      const gaps = ["gap", "row-gap", "column-gap"].filter((g) => hasProp(r.body, g));
      if (gaps.length) bad.push(`${file} → ${r.selector} uses ${gaps.join(", ")}`);
    }
  }
  assert.equal(
    bad.length,
    0,
    "Flex `gap` is a silent no-op on Chromium 79 (webOS 6). Use per-child margins instead:\n" + bad.join("\n")
  );
});

/* ---------------- 2. post-79 tokens ---------------- */

const BANNED = [
  { re: /\boklch\(|\boklab\(/, why: "oklch()/oklab() need Chrome 111" },
  { re: /\bcolor-mix\(/, why: "color-mix() needs Chrome 111" },
  { re: /\blight-dark\(/, why: "light-dark() needs Chrome 115" },
  { re: /\blab\(|\blch\(/, why: "lab()/lch() need Chrome 111" },
  { re: /\baspect-ratio\s*:/, why: "aspect-ratio needs Chrome 88" },
  { re: /\b(?:dvh|dvw|svh|svw|lvh|lvw)\b/, why: "v*-relative units need Chrome 108" },
  { re: /:is\(|:where\(/, why: ":is()/ :where() need Chrome 88" },
  { re: /:has\(/, why: ":has() needs Chrome 105" },
  { re: /::marker/, why: "::marker needs Chrome 89" },
  { re: /@property\b/, why: "@property needs Chrome 85" },
  { re: /@layer\b/, why: "@layer needs Chrome 99" },
  { re: /text-wrap\s*:/, why: "text-wrap needs Chrome 112" },
  { re: /\binset\s*:/, why: "inset shorthand needs Chrome 87 (use top/right/bottom/left)" },
  { re: /(?<!-webkit-)appearance\s*:/, why: "unprefixed appearance needs Chrome 84 (use -webkit-appearance)" },
  { re: /\bzoom\s*:/, why: "zoom property needs Chrome 128" },
  { re: /target-counter/, why: "target-counter() needs Chrome 80" },
  { re: /scrollbar-gutter/, why: "scrollbar-gutter needs Chrome 94" },
  { re: /accent-color\s*:/, why: "accent-color needs Chrome 93" },
  { re: /text-underline-position/, why: "text-underline-position needs Chrome 87" },
  { re: /:read-only|:read-write/, why: ":read-only / :read-write need Chrome 80" },
  { re: /container-name|container-type/, why: "container queries need Chrome 105" },
];

for (const { re, why } of BANNED) {
  test(`no ${why}`, () => {
    const bad = [];
    for (const { file, css } of sheets) {
      const clean = stripComments(css);
      let m;
      const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      while ((m = r.exec(clean))) bad.push(`${file} → "${m[0].trim()}"`);
    }
    assert.equal(bad.length, 0, `${why}:\n` + bad.join("\n"));
  });
}

/* ---------------- 3. :focus-visible isolation ---------------- */

test(":focus-visible rules are desktop-only (in @supports, never mixed)", () => {
  const bad = [];
  for (const { file, css } of sheets) {
    const clean = stripComments(css);
    const ranges = fvSupportsRanges(clean);
    for (const r of rules(clean)) {
      if (!r.selector.includes(":focus-visible")) continue;
      const inSupports = ranges.some(([a, b]) => r.start >= a && r.start <= b);
      if (!inSupports) {
        bad.push(`${file} → "${r.selector}" is not inside @supports selector(:focus-visible)`);
        continue;
      }
      // every comma-separated selector in the rule must be a :focus-visible
      // selector — mixing with plain selectors poisons the whole rule on 79
      const mixed = r.selector
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !s.includes(":focus-visible"));
      if (mixed.length) bad.push(`${file} → mixes :focus-visible with ${mixed.join(", ")}`);
    }
  }
  assert.equal(
    bad.length,
    0,
    "A selector list containing an unknown pseudo-class is discarded ENTIRELY on Chromium 79:\n" + bad.join("\n")
  );
});

/* ---------------- 4. the built artifact (minifier shorthand merges) ---------------- */
// Source-clean ≠ artifact-safe: esbuild's CSS MINIFIER folds longhands into
// shorthands when the target knows them (top/right/bottom/left → `inset`,
// Chrome 87+). Chromium 79 silently ignores `inset` — every inset vanishes
// and the layout breaks with no console error. That exact bug shipped
// twice (the player rendered off-screen on the TV while every desktop test
// passed). The build must target the TV's Chromium, and the minified output
// must stay longhand.
const { transform } = await import("esbuild");
const { browserTarget } = await import("../build/options.mjs");

test("minified CSS stays Chrome-79 safe (no shorthand the TV can't read)", async () => {
  const bad = [];
  for (const { file, css } of sheets) {
    if (!file.endsWith(".css")) continue; // only global sheets go through esbuild's CSS minifier
    const out = await transform(css, { loader: "css", minify: true, target: browserTarget });
    const merged = [...new Set([...out.code.matchAll(/(^|[;{])(inset|size)\s*:/g)].map((m) => m[2]))];
    if (merged.length) bad.push(`${file} → minifier emitted ${merged.join(", ")} (Chrome 87+/108+)`);
  }
  assert.equal(
    bad.length,
    0,
    "The minifier folded longhands into shorthands Chromium 79 can't parse — the TV silently drops the declarations. Point the build target at the TV (build/options.mjs):\n" +
      bad.join("\n")
  );
});
