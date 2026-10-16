// Acceptance: the TV (webOS 6 / Chromium 79) focus indicator + library grid overflow.
//
// User-visible contract this file guards:
//   1. Focus on the TV draws the soft accent GLOW — never a hard outline line
//      box. Chromium 79 has no :focus-visible, so the TV renders ONLY the
//      :focus rule (the remote calls el.focus() on every D-pad move). A
//      2px solid outline with offset renders on the TV/simulator as a harsh
//      blue rectangle floating around the active tile.
//   2. The glow (--focus-shadow) is the one focus indicator the TV keeps —
//      it must survive any focus restyle.
//   3. Activating the rightmost library tile must not summon a bottom
//      (horizontal) scrollbar: the grid tracks fit the grid content box, the
//      scaled active tile stays inside the grid's padding box, and the grid
//      clips x-overflow so no transform can ever grow one.
//
// Run: pnpm test
import test from "node:test";
import assert from "assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

/* ---------------- pure helpers (unit-tested below) ---------------- */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const themeCss = stripComments(read("src/ui/theme.css"));
const libraryStyle = styleBlock(read("src/ui/screens/Library.svelte"));
const tileStyle = styleBlock(read("src/ui/components/ItemTile.svelte"));

function styleBlock(svelteSource) {
  const m = svelteSource.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  return m ? stripComments(m[1]) : "";
}

/** the declaration value for `name` inside a rule body (null if absent) */
function decl(body, name) {
  const re = new RegExp(`(?:^|[;{\\s])${name}\\s*:(.*?)(?=[;}]|$)`, "s");
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

/** the rule whose comma-separated selector list contains `sel` exactly */
function ruleFor(css, sel) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sels = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (sels.includes(sel)) return { selector: m[1].trim(), body: m[2] };
  }
  return null;
}

/** horizontal padding (px) of a CSS `padding` shorthand value (1–4 values) */
function padX(padding) {
  const p = String(padding).trim().split(/\s+/).map((v) => parseFloat(v));
  return p.length >= 2 ? p[1] : p[0] || 0;
}

/** the largest blur radius (px) across the layers of a box-shadow value */
function maxBlur(shadow) {
  return String(shadow)
    .split(",")
    .reduce((mx, layer) => {
      // drop the color token first: rgba(77, 163, 255, 0.5) carries digits that
      // are not lengths; unitless zero offsets still count as lengths
      const geometry = layer.replace(/rgba?\([^)]*\)/g, " ").replace(/#[0-9a-fA-F]{3,8}/g, " ");
      const lens = [...geometry.matchAll(/-?(\d+(?:\.\d+)?)\s*(px)?/g)].map((m) => +m[1]);
      return Math.max(mx, lens[2] ?? 0); // offset-x offset-y BLUR [spread]
    }, 0);
}

/**
 * Grid-fit geometry, anchored to the fixed 1920px webOS canvas
 * (theme.css: 1920x1080 fixed canvas). A tile scaled by `scale` overhangs
 * its (border-box) column by colW*(scale-1)/2 on each side; the room for a
 * right-edge tile is the grid's horizontal padding plus half the centered
 * slack between tracks and content box.
 */
function gridFits({ containerW, gridPadX, cols, colW, colGap, scale }) {
  const contentW = containerW - 2 * gridPadX;
  const tracks = cols * colW + (cols - 1) * colGap;
  const slack = contentW - tracks;
  const roomPerSide = gridPadX + slack / 2;
  const scaleOver = (colW * (scale - 1)) / 2;
  return {
    contentW,
    tracks,
    slack,
    roomPerSide,
    scaleOver,
    fitsTracks: tracks <= contentW,
    fitsScale: roomPerSide >= scaleOver,
  };
}

/** effective horizontal overflow of a rule body (longhand, or the first value of the 2-value shorthand) */
function xOverflow(body) {
  const long = decl(body, "overflow-x");
  if (long) return long;
  const short = decl(body, "overflow");
  return short ? short.trim().split(/\s+/)[0] : null;
}

/* ---------------- inner-loop units (helper fixtures) ---------------- */

test("padX reads the horizontal value of 1/2/3-value padding shorthands", () => {
  assert.equal(padX("36px 56px 0"), 56);
  assert.equal(padX("8px 12px 80px"), 12);
  assert.equal(padX("28px 32px"), 32);
  assert.equal(padX("16px"), 16);
});

test("ruleFor finds a rule by exact selector and ignores non-members", () => {
  const css = ".a-x { x: 1 } .b, .c { x: 2 } .a.extra { x: 3 }";
  assert.equal(ruleFor(css, ".c").body, " x: 2 ");
  assert.equal(ruleFor(css, ".a.extra").body, " x: 3 ");
  assert.equal(ruleFor(css, ".a"), null); // not a prefix, not a superset selector
});

test("gridFits flags the 24px-gap grid (the bug) and passes the 20px-gap grid (the fix)", () => {
  // 1920 canvas, .library padX 56 → grid box 1808px, grid padX 12, 7 × 236px columns
  const base = { containerW: 1808, gridPadX: 12, cols: 7, colW: 236, scale: 1.06 };
  const buggy = gridFits({ ...base, colGap: 24 });
  assert.equal(buggy.tracks, 1796);
  assert.equal(buggy.contentW, 1784);
  assert.equal(buggy.fitsTracks, false, "1796px of tracks overflow the 1784px content box");
  const fixed = gridFits({ ...base, colGap: 20 });
  assert.equal(fixed.fitsTracks, true);
  assert.ok(fixed.fitsScale, "18px room per side must cover the 7.08px scaled overhang");
});

test("maxBlur picks the blur, not the spread, of each shadow layer", () => {
  assert.equal(maxBlur("0 0 0 6px rgba(77, 163, 255, 0.22), 0 0 24px rgba(77, 163, 255, 0.5)"), 24);
  assert.equal(maxBlur("0 2px 8px rgba(0, 0, 0, 0.35)"), 8);
});

/* ---------------- acceptance (outer) ---------------- */

const gridRule = ruleFor(libraryStyle, ".grid");
const libraryRule = ruleFor(libraryStyle, ".library");
const tileActive = ruleFor(tileStyle, '.tile[data-state="active"]');

function parsedGrid() {
  assert.ok(gridRule, "the .grid rule must exist in Library.svelte");
  const template = decl(gridRule.body, "grid-template-columns") || "";
  const m = template.match(/repeat\(\s*(\d+)\s*,\s*([\d.]+)px\s*\)/);
  assert.ok(m, `grid-template-columns must be repeat(N, Wpx), got: ${template}`);
  const gap = (decl(gridRule.body, "gap") || "").trim().split(/\s+/).map(parseFloat);
  // the tile's DECLARED scale is the conservative bound: Svelte prunes the
  // scoped data-state rule at compile time, so the theme's 1.05 wins in the
  // live cascade — fitting at 1.06 fits at 1.05
  const scale = parseFloat((decl(tileActive.body, "transform") || "").match(/scale\(([\d.]+)\)/)[1]);
  return gridFits({
    containerW: 1920 - 2 * padX(decl(libraryRule.body, "padding")),
    gridPadX: padX(decl(gridRule.body, "padding")),
    cols: +m[1],
    colW: +m[2],
    colGap: gap.length === 2 ? gap[1] : gap[0],
    scale,
  });
}

test("TV focus draws the soft glow, not a hard outline box (Chromium 79 :focus path)", () => {
  const rule = ruleFor(themeCss, "[data-focus]:focus");
  assert.ok(rule, "the :focus rule for [data-focus] controls must exist — it is the ONLY focus path on webOS 6 (Chromium 79 has no :focus-visible)");
  const outline = decl(rule.body, "outline");
  assert.ok(
    outline === null || /^none$/i.test(outline),
    `the TV :focus rule must not draw a hard outline box (outline: ${outline}) — it renders as a harsh blue line box on the TV/simulator; the glow is the indicator`
  );
  assert.equal(
    decl(rule.body, "box-shadow"),
    "var(--focus-shadow)",
    "the TV :focus rule must keep the glow: box-shadow: var(--focus-shadow)"
  );
});

test("the glow survives as the TV's one focus indicator (--focus-shadow is a soft accent halo)", () => {
  const glow = decl(ruleFor(themeCss, ":root").body, "--focus-shadow");
  assert.ok(glow, "the --focus-shadow token must exist in :root");
  assert.match(glow, /rgba\(\s*77\s*,\s*163\s*,\s*255/, "the glow must be the accent halo");
  assert.ok(maxBlur(glow) >= 16, `the glow needs a soft blur layer ≥16px (max blur: ${maxBlur(glow)}px)`);
});

test("library grid columns fit the grid content box (no baseline horizontal overflow)", () => {
  const g = parsedGrid();
  assert.ok(
    g.fitsTracks,
    `${g.tracks}px of tracks exceed the grid content box (${g.contentW}px) — the grid overflows horizontally at rest and preps the bottom scrollbar`
  );
});

test("the active (scaled) rightmost tile stays inside the grid clip — no scrollbar when the last item is active", () => {
  const g = parsedGrid();
  assert.ok(
    g.fitsTracks && g.fitsScale,
    `scaled tile overhangs ${g.scaleOver}px per side but the edge tile has only ${g.roomPerSide}px to the clip (tracks ${g.tracks}/${g.contentW}px, slack ${g.slack}px)`
  );
});

test("library grid clips horizontal overflow — a bottom scrollbar can never appear", () => {
  assert.ok(gridRule, "the .grid rule must exist in Library.svelte");
  const ox = xOverflow(gridRule.body);
  assert.equal(
    ox,
    "hidden",
    `the grid must declare overflow-x: hidden (got: ${ox ?? "none"}) — transformed (scaled) focus targets otherwise grow scrollable x-overflow and summon a bottom scrollbar on the TV`
  );
});
