// Chrome-79 compat gate (flex `gap`).
//
// `gap` on a FLEX container is a no-op before Chromium 84. webOS 6.0 ships
// Chromium 79, so every `display:flex; gap:...` rule silently loses ALL of its
// inter-item spacing on the TV. Grid `gap` has worked since Chromium 66 and is
// fine — the gate flags flex containers only, not grid.
//
// This is the same class of silent no-op as `inset` (Chrome 87) that we already
// fixed. Run as part of `npm test` so a regression is red, not a "why is the TV
// screen empty" mystery.
import test from "node:test";
import assert from "assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// collect all CSS: the global theme + every <style> block in .svelte files
function collectCSS(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "js") continue;
      collectCSS(p, out);
      continue;
    }
    if (name.endsWith(".css")) out.push(readFileSync(p, "utf8"));
    if (name.endsWith(".svelte")) {
      const s = readFileSync(p, "utf8");
      const m = s.match(/<style[^>]*>([\s\S]*?)<\/style>/);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

/** split a stylesheet into {selector, body} rules (no nested at-rules here). */
function rules(css) {
  const res = [];
  let depth = 0, buf = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") { depth++; if (depth === 1) { buf = ""; continue; } buf += c; continue; }
    if (c === "}") {
      if (depth === 1) { res.push({ selector: buf.trim(), body: buf.slice(0) }); depth--; }
      else depth--;
      continue;
    }
    if (depth === 0) { /* comment/selector text before first brace */ }
    else buf += c;
  }
  // selectors: re-scan to pair up properly
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

function prop(body, name) {
  const m = body.match(new RegExp("(?:^|[;{\\s])" + name + "s*:(.*?)(?=[;]|$)", "s"));
  return m ? m[1].trim() : null;
}
function hasProp(body, name) {
  return new RegExp("(?:^|[;{\\s])" + name + "\\s*:", "s").test(body);
}

const cssChunks = collectCSS(join(root, "src"));
const allRules = cssChunks.flatMap(rules);

const flexWithGap = [];
for (const r of allRules) {
  const display = prop(r.body, "display");
  if (!display) continue;
  const isFlex = /(^|\s|)(inline-)?flex(\s|,|$)/.test(display) || display === "flex" || display === "inline-flex";
  if (!isFlex) continue;
  const gaps = ["gap", "row-gap", "column-gap"].filter((g) => hasProp(r.body, g));
  if (gaps.length) flexWithGap.push({ selector: r.selector, gaps, display });
}

test("no flex container uses `gap` (Chromium 84+; webOS 6 = 79)", () => {
  assert.equal(
    flexWithGap.length,
    0,
    "Flex `gap` is a silent no-op on Chromium 79 (webOS 6). Replace with per-child margins:\n" +
      flexWithGap.map((f) => `  ${f.selector} → ${f.gaps.join(", ")} (display: ${f.display})`).join("\n")
  );
});
