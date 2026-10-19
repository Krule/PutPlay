// Magic Remote hover: on an LG TV the Magic Remote's pointer is a real
// mouse, so every clickable element needs a :hover state — and hover is a
// DIFFERENT indicator from focus. Focus is the D-pad's active element
// (scale + border + accent glow); hover is the pointer resting on an
// element (a brightness lift — "about to be pressed", never claiming to
// be the active element).
//
// The scrubber's hover is its own signature: while the pointer is on the
// bar, the time bubble follows the POINTER and shows the time at the
// pointer position — a preview before the seek. The D-pad focus bubble
// (ring + grown thumb) stays at the PLAYHEAD showing the current time.
//
// Run: pnpm test
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const theme = readFileSync(join(here, "..", "src", "ui", "theme.css"), "utf8");
const player = readFileSync(join(here, "..", "src", "ui", "screens", "Player.svelte"), "utf8");

/** The {…} body of the rule whose selector region contains `needle`. */
function ruleBodyOf(css, needle) {
  const i = css.indexOf(needle);
  assert.ok(i >= 0, `a rule mentioning ${needle} exists`);
  const j = css.indexOf("{", i);
  const k = css.indexOf("}", j);
  assert.ok(j >= 0 && k > j, `rule for ${needle} has a body`);
  return { selector: css.slice(css.lastIndexOf("}", i), j), body: css.slice(j, k + 1) };
}

/** Text between two anchors (end anchor searched past the start). */
function region(src, from, to) {
  const a = src.indexOf(from);
  const b = a >= 0 ? src.indexOf(to, a + from.length) : -1;
  assert.ok(a >= 0 && b > a, `anchors: "${from.slice(0, 48)}…" … "${to.slice(0, 48)}…"`);
  return src.slice(a, b);
}

test("the pointer hover state lifts every clickable — its own indicator, not the focus treatment", () => {
  const { selector, body } = ruleBodyOf(theme, ":hover");
  assert.match(selector, /\[data-focus\]:hover/, "custom focus targets (rows, tiles, panels)");
  assert.match(selector, /button:hover/, "plain buttons");
  assert.match(selector, /a:hover/, "links");
  assert.match(body, /filter:\s*brightness\(/, "the lift is a brightness filter — one rule, any background");
  assert.doesNotMatch(
    body,
    /--focus-shadow|scale\(/,
    "hover must NOT reuse the focus language (glow/scale) — different input, different indicator",
  );
});

test("the hover lift animates with the focus transitions (no pop)", () => {
  const t = ruleBodyOf(theme, "[data-focus] {");
  assert.match(t.body, /transition:[^;]*filter/, "filter is in the [data-focus] transition list");
});

test("the scrubber bar watches the pointer (move previews, leave hides)", () => {
  const bar = region(player, "<div class=\"bar\" data-focus", "<div class=\"bubble\"");
  assert.match(bar, /on:mousemove={onBarMove}/);
  assert.match(bar, /on:mouseleave={onBarLeave}/);
});

test("the bubble follows the pointer while hovered; the D-pad focus bubble keeps the playhead", () => {
  const bubble = region(player, "<div class=\"bubble\"", "</div>");
  assert.match(bubble, /scrubHover/, "left/time switch to the pointer state while it is over the bar");
  const hover = ruleBodyOf(player, ":global(.bar:hover .bubble)");
  assert.match(hover.body, /display:\s*block/);
  assert.doesNotMatch(hover.body, /box-shadow/, "the hover indicator is the bubble — the ring belongs to D-pad focus");
});

test("click-seek and hover-preview share one track mapping (the 20px inset, defined once)", () => {
  assert.match(player, /import \{[^}]*barTrackFraction[^}]*\} from "\.\.\/\.\.\/putio\/scrub/);
  const click = region(player, "function onBarClick", "function ");
  assert.match(click, /barTrackFraction/, "the click seek uses the shared mapping");
  const move = region(player, "function onBarMove", "function onBarLeave");
  assert.match(move, /barTrackFraction/, "the hover preview uses the same mapping");
  assert.match(move, /scrubHover = \{ pct: [^,]+, time: [^}]+\}/, "the preview stores pointer percent + pointer time");
});

test("a new file clears a stale hover preview", () => {
  const init = region(player, "function initEngine() {", "function metaFetch");
  assert.match(init, /scrubHover = null/, "the old file's preview must not survive the file change");
});
