// OUTER acceptance test: the TV player redesign (full-screen chrome).
//
// The locked design (the mockup is the visual reference —
// docs/mockups/player-sheet.html): the chrome is ONE bottom-anchored surface
// with three rows —
//   1. TITLE ROW: the file's IDENTITY (buildTitleView: show title, S/E
//      subtitle, episode-name enrichment, LIVE/source badges) on the left,
//      the trailing ICON buttons on the right (source / audio / CC / speed)
//      — ABOVE the bar, icon-only, with a name+value tip that appears
//      while the icon is focused.
//   2. SCRUB ROW: the focusable scrubber — an 80px hit area whose track
//      keeps 20px off the hit-area ends, so the focus outline (hugging the
//      hit-area edge) never touches the line. D-pad ←/→ while it is
//      focused is a REAL seek of ±10s (scrubSeek, clamped); the thumb
//      grows 16→24 and a time bubble appears while focused.
//   3. TRANSPORT ROW: transport only (−10s / play-pause / +30s).
// Menus (source / audio / CC / speed) float above the chrome: no dim, no
// visible surface, the opener icon stays active, arrows are trapped
// inside; Back closes and restores the opener, and a click anywhere else
// (a transparent full-surface catcher) dismisses the menu. The info panel
// (D-pad DOWN from the transport row) says what the title view can't —
// synopsis, details, actions (Play from beginning / Up next) — and Back
// closes it and restores the transport. The contextual skip PILL (at the
// bar's right end, above the scrub line, visible with the chrome hidden)
// replaces the old
// center offer modal: OK skips, Back plays through, it settles once.
// The chrome hides 4s after the last activity unless PINNED (paused,
// error, a menu open, or the info open — surfaceVisibility); the
// buffering spinner never shows while paused, and the center pause-echo
// never shows on error.
//
// This gate pins the contract at the source level (house style — the
// geometry is the design; the pure decisions live in the tested modules:
// title-view, scrub, ctx-pill, player-surface, info-tab, upnext).
//
// Run: pnpm test

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");
const player = read("src/ui/screens/Player.svelte");

/** The chrome's <style> block (the Player's own, not the global theme). */
function css() {
  return player.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
}

/** A CSS rule's body by selector (unique literal match). */
function rule(sel) {
  const idx = css().indexOf(sel);
  assert.ok(idx >= 0, `a "${sel}" CSS rule must exist in the chrome`);
  const open = css().indexOf("{", idx);
  const close = css().indexOf("}", open);
  return css().slice(open + 1, close);
}

/** A slice of the markup between two unique literals (start inclusive). */
function between(a, b) {
  const i = player.indexOf(a);
  const j = player.indexOf(b, i + a.length);
  assert.ok(i >= 0 && j > i, `markup between "${a.slice(0, 30)}" and "${b.slice(0, 30)}" must exist`);
  return player.slice(i, j);
}

/** The global theme, comments stripped (tokens + the shared chrome pieces). */
const theme = read("src/ui/theme.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** A theme.css rule's body by selector (unique literal match). */
function themeRule(sel) {
  const idx = theme.indexOf(sel);
  assert.ok(idx >= 0, `a "${sel}" rule must exist in theme.css`);
  const open = theme.indexOf("{", idx);
  const close = theme.indexOf("}", open);
  return theme.slice(open + 1, close);
}

test("Player.svelte compiles (Svelte 4 parse errors are invisible to every other gate)", async () => {
  const { compile, preprocess } = await import("svelte/compiler");
  const sveltePreprocess = (await import("svelte-preprocess")).default;
  const file = join(here, "..", "src", "ui", "screens", "Player.svelte");
  const source = readFileSync(file, "utf8");
  const processed = await preprocess(source, sveltePreprocess(), { filename: file });
  assert.doesNotThrow(
    () => compile(processed.code, { generate: "dom", filename: file, css: "injected" }),
    "Player.svelte must compile"
  );
});

// The focus-state rules are written against [data-state="active"], an
// attribute the remote engine sets at RUNTIME (it never appears in the
// markup). The Svelte 4 compiler SILENTLY DROPS any selector that
// references an attribute absent from the markup — so these rules must be
// :global() (the classes are player-unique, so nothing leaks), and this
// gate fails if a future edit re-introduces the drop (dead focus rings,
// dead bubble, no thumb growth — invisible to every source-text gate).
test("the runtime focus-state CSS survives Svelte compilation (no silent drop)", async () => {
  const { compile, preprocess } = await import("svelte/compiler");
  const sveltePreprocess = (await import("svelte-preprocess")).default;
  const file = join(here, "..", "src", "ui", "screens", "Player.svelte");
  const source = readFileSync(file, "utf8");
  const processed = await preprocess(source, sveltePreprocess(), { filename: file });
  const { css } = compile(processed.code, { generate: "dom", filename: file, css: "injected" });
  const emitted = css.code;
  for (const [selector, name] of [
    [".icbtn[data-state=\"active\"]", "icon focus glow"],
    [".bar[data-state=\"active\"]", "scrubber focus ring"],
    [".bar[data-state=\"active\"] .thumb", "scrubber thumb growth"],
    [".bar[data-state=\"active\"] .bubble", "scrubber time bubble"],
    [".tbtn[data-state=\"active\"]", "transport focus glow"],
    [".abtn[data-state=\"active\"]", "info action focus glow"],
    [".pill[data-state=\"active\"]", "pill focus glow"],
    [".menu .row[data-state=\"active\"]", "menu row focus"],
  ]) {
    assert.ok(emitted.includes(selector), `the emitted CSS must keep the ${name} rule (${selector})`);
  }
});

/* ---------------- title view + trailing icons ---------------- */

test("the chrome shows the file's IDENTITY (buildTitleView), not the raw name", () => {
  assert.ok(
    /buildTitleView\(/.test(player),
    "the title row must come from buildTitleView (tested in title-view.test.mjs)"
  );
  assert.ok(
    /\{\s*tv\.title\s*\}/.test(player),
    "the chrome title must render the title view's title"
  );
  assert.ok(
    /showTitle:\s*infoData\?\.showTitle/.test(player),
    "the late canonical title (infoData) must feed buildTitleView's showTitle"
  );
  assert.ok(
    /class:accent=\{b\.accent\}/.test(player),
    "badges (LIVE accented) must render from the title view's badge list"
  );
});

test("the subtitle line renders only when the title view has one", () => {
  assert.ok(
    /\{#if\s+tv\.subtitle\}/.test(player),
    "movies have no subtitle line (A8) — the {#if tv.subtitle} gate"
  );
});

test("the trailing icon row: source / audio / CC / speed, icon-only", () => {
  const titleRow = between('class="title-row"', 'class="scrub-row"');
  for (const ctl of ["source", "audio", "subs", "speed"]) {
    assert.ok(
      titleRow.includes(`data-ctl="${ctl}"`) && titleRow.includes("icbtn"),
      `the ${ctl} icon button (data-ctl="${ctl}") must be an icbtn on the title row`
    );
  }
  assert.ok(
    !/class="cbtn"/.test(player),
    "the old text cbtns are gone — full mode is icon-only (the ≥24px text rule)"
  );
});

test("speed is VOD-only (absent on live) and stateful (shows the current rate)", () => {
  const titleRow = between('class="title-row"', 'class="scrub-row"');
  assert.ok(
    /\{#if\s+!live\}[\s\S]*?data-ctl="speed"[\s\S]*?\{\/if\}/.test(titleRow),
    "the speed button must be inside {#if !live} (live has no rate)"
  );
  assert.ok(
    /class="rate">\{speedLabel\}/.test(titleRow),
    "the speed icon is a STATEFUL glyph — it shows the current rate"
  );
});

test("the transport row is transport only (−10 / play-pause / +30)", () => {
  const transport = between('class="transport-row"', "\n  <!--");
  const ctls = [...transport.matchAll(/data-ctl="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(ctls)].sort(),
    ["forward", "play", "rewind"],
    "exactly the three transport controls, no pick buttons in this row"
  );
});

/* ---------------- the focusable scrubber ---------------- */

test("the scrubber is a focusable control (data-focus, data-ctl=scrub)", () => {
  assert.ok(
    /data-ctl="scrub"/.test(player),
    "the bar carries data-ctl=scrub (the keymap's hook)"
  );
  const scrubRow = between('class="scrub-row"', 'class="transport-row"');
  assert.ok(
    /data-focus/.test(scrubRow),
    "the scrub row's bar must be a remote control (data-focus)"
  );
});

test("D-pad ←/→ on the focused bar is a real ±10s seek (scrubSeek), consumed", () => {
  assert.ok(
    /scrubSeek\(/.test(player),
    "the seek must go through scrubSeek (the tested clamp rule)"
  );
  assert.ok(
    /scrubThumbPct\(/.test(player),
    "the fill/thumb/bubble percent must come from scrubThumbPct"
  );
  const nav = player.slice(player.indexOf("onNavigate"));
  assert.ok(
    nav.length > 0 && /scrub/.test(nav) && /return\s+true/.test(nav),
    "onNavigate must CONSUME ←/→ while the bar is focused (return true — no spatial move)"
  );
  assert.ok(
    !/onScrubKey/.test(player),
    "the old GLOBAL left/right-seek handler is gone (seeking is a focused-bar behavior)"
  );
});

test("the scrubber geometry: 80px hit area, 20px track inset, ring at the edge", () => {
  const bar = rule(".bar {");
  assert.ok(/height:\s*80px/.test(bar), "hit area is 80px tall");
  assert.ok(/border-radius:\s*40px/.test(bar), "hit area is fully rounded (40px)");
  const track = rule(".bar-track {");
  assert.ok(
    /left:\s*20px/.test(track) && /right:\s*20px/.test(track),
    "the track keeps 20px off BOTH hit-area ends"
  );
  // :global() is required — Svelte drops [data-state] selectors (runtime attr)
  const ring = rule(':global(.bar[data-state="active"]) {');
  assert.ok(
    /inset\s+0\s+0\s+0\s+2px/.test(ring),
    "the focus ring is a 2px INSET shadow on the hit-area edge (it never crosses the line)"
  );
  const thumb = rule(".thumb {");
  assert.ok(/width:\s*16px/.test(thumb), "the thumb is 16px at rest");
  const thumbActive = rule(':global(.bar[data-state="active"] .thumb) {');
  assert.ok(/24px/.test(thumbActive), "the focused thumb grows to 24px");
});

test("the time bubble shows while the bar is focused", () => {
  assert.ok(/class="bubble"/.test(player), "the bubble element exists");
  assert.ok(
    /:global\(\.bar\[data-state="active"\] \.bubble\)[^{]*\{[^}]*display:\s*block/.test(css()),
    "the bubble appears (display:block) while the bar is focused"
  );
});

/* ---------------- non-modal menus + speed ---------------- */

test("the pick panels are floating menus (no visible scrim, no dim)", () => {
  for (const kind of ["source", "audio", "subs", "speed"]) {
    assert.ok(
      new RegExp(`class="menu ${kind}"`).test(player),
      `the ${kind} panel must be a floating .menu.${kind}`
    );
  }
  const centers = (player.match(/class="center-panel"/g) || []).length;
  assert.equal(
    centers,
    1,
    "exactly ONE center panel remains (the error modal) — the pick panels are non-modal"
  );
});

test("the menu geometry: right 72px, 24px above the chrome (bottom 419px)", () => {
  const menu = rule(".menu {");
  assert.ok(/right:\s*72px/.test(menu), "the menu aligns above the trailing icon group");
  assert.ok(/bottom:\s*419px/.test(menu), "the menu floats 24px above the chrome top");
  assert.ok(/width:\s*640px/.test(rule(".menu.source {")), "the source menu is 640px");
  assert.ok(/width:\s*480px/.test(rule(".menu.speed {")), "the speed menu is 480px");
});

test("a side-click (magic-remote click away from the panel) dismisses the open pick menu", () => {
  // The four pick menus are click-modal: a transparent full-surface catcher
  // sits above the chrome, below the menu — a click that lands on it missed
  // the panel and every control, so it closes the menu. NO visible scrim, NO
  // dim (the video keeps playing behind), and the color keys / D-pad are key
  // events, unaffected by the catcher.
  const open = '{#if overlays.source || overlays.audio || overlays.subs || overlays.speed}';
  const i = player.indexOf(open);
  assert.ok(i >= 0, "a single any-menu-open condition exists");
  assert.ok(
    /class="menu-scrim"[^>]*on:click=\{closeOverlays\}/.test(player.slice(i, i + 400)),
    "the menu-scrim renders whenever any pick menu is open, and its click closes the overlays"
  );
  const scrim = rule(".menu-scrim {");
  assert.ok(
    /position:\s*absolute/.test(scrim) &&
      /top:\s*0/.test(scrim) &&
      /right:\s*0/.test(scrim) &&
      /bottom:\s*0/.test(scrim) &&
      /left:\s*0/.test(scrim),
    "the catcher spans the whole player surface (top/right/bottom/left 0)"
  );
  assert.ok(/background:\s*transparent/.test(scrim), "it is invisible — no dim, no surface");
  assert.ok(
    /z-index:\s*25/.test(scrim) && /z-index:\s*30/.test(rule(".menu {")),
    "z 25: above the chrome (20), below the menu (30) — the panel stays clickable"
  );
});

test("the color legend spreads the keys a bit (dot–label and key–key air)", () => {
  const dot = themeRule(".color-legend .dot {");
  assert.ok(
    /margin-right:\s*10px/.test(dot),
    "the dot breathes from its label (margin-right 10px — flex gap is Chrome 84+, TV is 79)"
  );
  const cl = themeRule(".color-legend .cl + .cl {");
  assert.ok(
    /margin-left:\s*28px/.test(cl),
    "adjacent keys are spread (margin-left 28px) — the cramped \"●Source●Audio\" row is gone"
  );
});

test("the speed menu is the locked rate list and drives engine.setSpeed", () => {
  assert.ok(
    /0\.5,\s*0\.75,\s*1,\s*1\.25,\s*1\.5,\s*2/.test(player),
    "the rate options are exactly 0.5 / 0.75 / 1 / 1.25 / 1.5 / 2"
  );
  assert.ok(
    /engine\??\.setSpeed\(/.test(player),
    "a picked rate goes through MediaEngine.setSpeed"
  );
  assert.ok(
    /setSpeed\(speed\)/.test(player),
    "the per-file engine re-applies the session's rate (speed survives a file swap)"
  );
});

test("menus trap focus; the opener stays active; Back restores it", () => {
  const scope = player.slice(player.indexOf("setFocusScope"));
  for (const kind of ["source", "audio", "subs", "speed"]) {
    assert.ok(
      scope.slice(0, 400).includes(`${kind}PanelEl`),
      `the open ${kind} menu must be in the focus-scope list (arrows stay inside)`
    );
  }
  assert.ok(
    /class:sel=\{overlays\.source\}/.test(player),
    "the opener icon stays active (.sel) while its menu is open"
  );
  const onBack = player.slice(player.indexOf("function onBack"));
  assert.ok(
    /closeOverlays\(\)/.test(onBack.slice(0, 1500)),
    "Back closes an open menu (panelFocus restores the opener's focus)"
  );
});

/* ---------------- the info panel ---------------- */

test("the info panel content comes from buildInfoPanel + upNext", () => {
  assert.ok(/buildInfoPanel\(/.test(player), "the panel content must come from buildInfoPanel (tested)");
  assert.ok(/upNext\(/.test(player), "Up next is pure queue resolution (upNext — tested, no network)");
});

test("D-pad down from the transport row opens the info panel (focus → first action)", () => {
  const nav = player.slice(player.indexOf("onNavigate"));
  assert.ok(
    nav.length > 0 && /openInfo\(\)/.test(nav),
    "down from the transport must openInfo()"
  );
});

test("the info panel: thumb, clamped synopsis, details row, actions", () => {
  assert.ok(/class="info-thumb"/.test(player), "the panel carries the thumb (384×216)");
  assert.ok(/class="info-syn"/.test(player), "the synopsis is the clamped block");
  assert.ok(/class="info-details"/.test(player), "the details row (rating·genres·air-date) exists");
  assert.ok(/class="info-actions"/.test(player), "the actions row exists");
  assert.ok(/class="abtn"/.test(player), "actions are the .abtn pills");
});

test("info actions: Play from beginning = seek 0; Up next = advance", () => {
  const body = player.slice(player.indexOf("function playFromBeginning"));
  assert.ok(
    body.length > 0 && /engine\??\.seek\(0\)/.test(body.slice(0, 400)),
    "Play from beginning is a SEEK TO 0 (L1) — no fresh-target re-derivation"
  );
  const up = player.slice(player.indexOf("function playUpNext"));
  assert.ok(
    up.length > 0 && /advanceVideo\(\)/.test(up.slice(0, 400)),
    "Up next plays the queue's next file (advanceVideo — the same path as auto-next)"
  );
});

test("Back closes the info panel (menu → info → pill → dock chain)", () => {
  const onBack = player.slice(player.indexOf("function onBack"));
  assert.ok(
    /infoOpen/.test(onBack.slice(0, 1500)) && /closeInfo\(\)/.test(onBack.slice(0, 1500)),
    "Back on the info panel closes it (restoring the transport)"
  );
});

test("the info geometry: full-width minus the chrome gutters, above the chrome", () => {
  const info = rule(".info {");
  assert.ok(/left:\s*72px/.test(info) && /right:\s*72px/.test(info), "left/right 72px");
  assert.ok(/bottom:\s*419px/.test(info), "bottom 419px (24px above the chrome)");
  const thumb = rule(".info-thumb {");
  assert.ok(
    /width:\s*384px/.test(thumb) && /height:\s*216px/.test(thumb),
    "the thumb is 384×216"
  );
  assert.ok(
    /object-fit:\s*contain/.test(thumb),
    "the artwork keeps its native aspect ratio (contain) — a 2:3 poster must not be stretched into the 16:9 box"
  );
});

test("the info data is fetched async and swaps in late (never blocks the first frame)", () => {
  assert.ok(/lookupEpisodeInfo\(/.test(player), "episodes: the TMDb episode/show data path");
  assert.ok(/lookupMovieInfo\(/.test(player), "movies: the TMDb movie search+detail path");
  assert.ok(
    /\.then\([\s\S]{0,200}?infoData\s*=/.test(player),
    "the data lands in a reactive late (infoData = … in a .then) — the panel re-renders on arrival"
  );
});

/* ---------------- the bar's segment overlays (skippable segments) ---------------- */

test("the bar shows the skippable segments as subtle overlays (segSpans → .bar-seg)", () => {
  assert.ok(
    /segSpans\(/.test(player),
    "the overlay positions come from segSpans (the tested decision)"
  );
  const track = between('<div class="bar-track">', '<div class="bubble"');
  assert.ok(
    /class="bar-seg"/.test(track),
    "each segment renders as a .bar-seg span inside the track"
  );
  assert.ok(
    track.indexOf('class="bar-seg"') < track.indexOf('class="bar-fill"'),
    "the .bar-seg spans sit BELOW the fill (played segments stay marked; the fill never fights them)"
  );
  const segRule = rule(".bar-seg {");
  assert.ok(
    /background:\s*rgba\(245,\s*184,\s*79,\s*0\.3/.test(segRule),
    "the segment tint borrows the warn yellow (the subs-key hue) — a hue distinct from the blue progress, so the skippable region reads as its own thing on the track"
  );
});

/* ---------------- the contextual skip button (replaces the offer modal, then the bar-end pill) ---------------- */

test("the skip offer is a BUTTON above the title row — the player's button material, larger, with text", () => {
  assert.ok(/pillState\(/.test(player), "the offer decision comes from pillState (tested)");
  assert.ok(/class="pill"/.test(player), "the offer element exists");
  assert.ok(!/seg-panel|segPanelEl/.test(player), "the old center offer modal (seg panel) is gone");
  const pillRule = rule(".pill {");
  // Above the first chrome row (the title row), right edge on the speed
  // button's edge. From the screen bottom: 64 (pad) + 72 (transport) + 22
  // (gap) + 80 (scrub) + 22 (gap) = 260 (the title row's floor); the
  // tallest row (title 48px + subtitle 26px + 6px margin, at 1.2 leading)
  // ≈ 95 → its top edge is 355; + 22 gap → bottom 377. An 80px button
  // spans 377–457 — taller than the 64px icons and the 72px play.
  // right 72 = the controls' right padding, where the title row's right
  // edge (and the speed button, its rightmost icon) ends.
  assert.ok(
    /right:\s*72px/.test(pillRule) &&
      /bottom:\s*377px/.test(pillRule) &&
      /height:\s*80px/.test(pillRule) &&
      !/left:\s*50%/.test(pillRule),
    "above the title row (bottom 377px), 80px tall, right-aligned (right 72px — the speed button's right edge)"
  );
  assert.ok(
    /background:\s*rgba\(255,\s*255,\s*255,\s*0\.1\)/.test(pillRule) &&
      /border:\s*0/.test(pillRule),
    "the player's button material (rgba(255,255,255,0.1), no border) — same family as the transport buttons"
  );
  assert.ok(
    !/right:\s*208px/.test(pillRule) && !/var\(--accent-dim-solid\)/.test(pillRule),
    "not the old bar-end pill: no bar-right offset, no accent material"
  );
  const activeRule = rule(":global(.pill[data-state=\"active\"]) {");
  assert.ok(
    /box-shadow:\s*var\(--focus-shadow\)/.test(activeRule) &&
      /transform:\s*scale\(1\.06\)/.test(activeRule) &&
      /background:\s*rgba\(255,\s*255,\s*255,\s*0\.16\)/.test(activeRule),
    "the focus state is the player's button triad (glow + scale 1.06 + the lighter material)"
  );
  const labelRule = rule(".pill-label {");
  assert.ok(/font-size:\s*30px/.test(labelRule), "the label is TV-scale (30px — the user's 'with text, just larger')");
  const svgRule = rule(".pill svg {");
  assert.ok(/width:\s*32px/.test(svgRule), "the icon is 32px (the play icon's size) — a button with text, not a pill");
});

test("the offer is FOCUSED the moment it lands (OK = the instant skip) — and when it vanishes still focused, the transport gets it back", () => {
  assert.ok(
    /registerAll\(\s*pillEl\s*\)[\s\S]{0,200}?remote\.focusEl\(\s*pillEl\s*\)/.test(player),
    "registration is immediately followed by focusEl(pillEl) — focus lands as soon as the section is detected, so OK alone skips"
  );
  const restore = player.match(
    /if\s*\(\s*!\s*pillEl\s*&&\s*pillHadFocus\s*\)[\s\S]{0,160}?restoreIfStale\(\s*ctlEl\(\s*"play"\s*\)\s*\)/
  );
  assert.ok(
    restore,
    "a vanished button that still held focus restores the transport (a detached active would make the next press edge-pick)"
  );
});

test("pill OK = skip; Back = play through (settled once)", () => {
  assert.ok(
    /skipSegNow\(pill\.index\)/.test(player),
    "OK (click) on the pill skips the section"
  );
  const onBack = player.slice(player.indexOf("function onBack"));
  assert.ok(
    /playSegThrough\(pill\.index\)/.test(onBack.slice(0, 1500)),
    "Back while the pill is up settles the section (play through)"
  );
});

test("the pill is exempt from the chrome auto-hide (visible with the chrome hidden)", () => {
  const i = player.indexOf("{#if pill}");
  assert.ok(i >= 0, "the pill block must exist");
  const block = player.slice(i, player.indexOf("{/if}", i));
  assert.ok(
    !/showControls/.test(block),
    "the pill's visibility must not be gated on showControls (it shows with the chrome hidden)"
  );
});

/* ---------------- surface state (pin / spinner / pause-echo) ---------------- */

test("the chrome state comes from surfaceVisibility (pinned / spinner / pause-echo)", () => {
  assert.ok(/surfaceVisibility\(/.test(player), "the state decision comes from surfaceVisibility (tested)");
  assert.ok(!/controlsPinned/.test(player), "the old controlsPinned is replaced");
  assert.ok(
    /surface\.pinned/.test(player),
    "the 4s auto-hide obeys surface.pinned (paused ∨ error ∨ menu ∨ info)"
  );
  assert.ok(
    /surface\.spinner/.test(player) && /surface\.pauseEcho/.test(player),
    "the buffering spinner and the center pause-echo render from the surface state"
  );
});

/* ---------------- the full-mode type scale (≥24px) + icon style ---------------- */

test("the full-mode chrome text never drops below 24px", () => {
  const sizes = {
    ".title {": 48,
    ".subtitle {": 26,
    ".time {": 28,
    ".badge {": 24,
    ".rate {": 24,
    ".tip {": 24,
    ".menu-title {": 32,
    ".menu .row .label {": 28,
    ".info-syn {": 26,
    ".info-details {": 24,
    ".abtn {": 24,
  };
  for (const [sel, px] of Object.entries(sizes)) {
    const body = rule(sel);
    assert.ok(
      new RegExp(`font-size:\\s*${px}px`).test(body),
      `${sel} must be ${px}px (the locked TV scale — nothing in the chrome below 24px)`
    );
  }
});

test("the chrome uses SVG icons — no Unicode glyph icons in full mode", () => {
  const chrome = player.slice(player.indexOf('class="controls"'), player.indexOf('class="color-legend'));
  assert.ok(!/class="ico"/.test(chrome), "the .ico glyph spans are gone from the chrome");
  assert.ok(/<svg/.test(chrome), "the chrome icons are SVG");
  assert.ok(/class="color-legend[^"]*"/.test(player), "the physical-key color legend is kept");
});

/* ---------------- full-mode focus scope (the closed-walk contract) ---------------- */

// The Player overlays a background screen that STAYS MOUNTED by design
// (Back from full docks, it does not leave). While the video covers that
// screen, its tiles are still DOM-visible — and without a scope they are
// D-pad candidates: walking down from the chrome drops focus into the
// invisible library (the ring "swallows" into the video). The locked
// keymap (§2.9) is a closed walk on the player's own surface (transport →
// up → scrubber; down from transport → info; pill at the bar's right end), so full
// mode must scope the graph to the player root, and opening the player
// must take the remote from the covered background.

test("full mode: the D-pad graph is scoped to the player root (the covered background is unreachable)", () => {
  assert.ok(
    /\(mode\s*===\s*"full"\s*\?\s*playerRootEl\s*:\s*null\)/.test(player),
    "the focus scope must include the player root while in full mode (and release it when docked)"
  );
});

test("full mode: opening the player takes focus to the transport (the background focus is invisible)", () => {
  assert.ok(
    /if\s*\(mode\s*===\s*"full"\)\s*remote\.focusEl\(ctlEl\("play"\)\)/.test(player),
    "full mode must focus the play button on mount (the covered background keeps no remote)"
  );
});

// The plan's walk (transport → up → scrubber → down → transport) is a
// closed vertical corridor. It CANNOT be left to pure spatial movement:
// the transport buttons sit at the bottom-LEFT (x≈154–340) while the bar's
// center is at the screen's middle (x≈640) — outside the engine's
// ±95% column band, so "up from transport" finds nothing spatially (and
// "down from the bar" would guess the wrong button by column distance).
// The onNavigate handler consumes both directions explicitly.

test("up from the transport row focuses the scrubber (consumed — the spatial band can't reach it)", () => {
  assert.ok(
    /dir\s*===\s*"up"\s*&&\s*\(ctl\s*===\s*"rewind"\s*\|\|\s*ctl\s*===\s*"play"\s*\|\|\s*ctl\s*===\s*"forward"\)[\s\S]{0,120}?remote\.focusEl\(ctlEl\("scrub"\)\)/.test(player),
    "up from rewind/play/forward must consume the press and focus the scrubber"
  );
});

test("down from the scrubber returns to the transport's play button (the corridor is symmetric)", () => {
  assert.ok(
    /dir\s*===\s*"down"\s*&&\s*ctl\s*===\s*"scrub"[\s\S]{0,120}?remote\.focusEl\(ctlEl\("play"\)\)/.test(player),
    "down from the scrubber must consume the press and focus the play button"
  );
});

// The subs menu's panel class ("menu subs") must not share the CUE
// OVERLAY's class. The old overlay was a bare ".subs" (screen-centered,
// opacity toggled by ".show") — those rules leaked into ".menu.subs":
// the panel rendered centered AND at opacity 0 (invisible). On the TV
// the user opened the subs menu and saw nothing — "subtitle selection
// not working" (and the focus moved inside a panel they couldn't see —
// "focus is a bit weird"). The overlay gets a dedicated class; no bare
// ".subs" selector may survive.

test("the cue overlay and the subs menu don't share a class (the menu must stay visible and right-anchored)", () => {
  assert.ok(
    /<div class="subs-cues"/.test(player),
    "the cue overlay must carry its own dedicated class (subs-cues)"
  );
  // Check the RULES, not the prose — comments may quote the old name.
  const rules = css().replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/(?<![\w.-])\.subs(?![\w-])/.test(rules),
    "no bare '.subs' selector may remain in the rules (it matches .menu.subs and kills its opacity/positioning)"
  );
  assert.ok(
    /\.subs-cues\s*\{/.test(rules),
    "the cue overlay's positioning lives on .subs-cues"
  );
});

// A bilingual subtitle ships EVERY line twice: as overlapping cue pairs
// with identical timestamps (romaji + translation). cueAt returned a
// single cue, so one language of every pair was invisible — and the raw
// ASS tags put.io left behind ("{\\an8}…") printed on screen. The overlay
// must take EVERY active cue and stack the distinct lines.

test("the overlay stacks every active cue (bilingual pairs show both lines, ASS leftovers stripped)", () => {
  assert.ok(
    /cuesAt\(/.test(player),
    "the overlay must query every active cue (cuesAt), not a single one"
  );
  assert.ok(
    !/(?<![\w.])cueAt\(/.test(player.replace(/cuesAt\(/g, "")),
    "no bare cueAt may remain on the overlay path"
  );
  assert.ok(
    /join\(["']\\n["']\)/.test(player),
    "stacked lines join with a real newline (the overlay is pre-wrap)"
  );
});

// The subs menu can grow taller than the space above the chrome (N track
// rows + the text-size section — ~970px with just 2 tracks, vs 661px of
// 1080p headroom between the screen top and the 419px anchor). Its rows
// used to render ABOVE the top of the screen, the focused row included.
// The panel is capped at the viewport headroom and scrolls; the remote
// engine already scrollIntoView's the focused element (setActive), so the
// focused row is always visible without a scroll key.

test("a tall menu scrolls within the headroom above the chrome (rows never render off the top of the screen)", () => {
  const body = rule(".menu {");
  assert.ok(
    /max-height:\s*calc\(100vh - 443px\)/.test(body),
    ".menu must cap its height at the headroom (443 = 24px top margin + 419px anchor)"
  );
  assert.ok(
    /overflow-y:\s*auto/.test(body),
    ".menu must scroll (the engine scrollIntoView's the focused row)"
  );
});

// ---------------------------------------------------------------------------
// COLOR KEYS — the user's mapping (LG remote, 2026-10-17):
//   RED = playback source, GREEN = audio track, YELLOW = subtitles,
//   BLUE = play/pause (unchanged). The legend dots follow the mapping
//   (c1=--accent blue, c2=--ok green, c3=--warn yellow, c4=--danger red).
// ---------------------------------------------------------------------------

function onColorBody() {
  const m = player.match(/function onColor\([\s\S]*?\n  \}/);
  assert.ok(m, "onColor is there");
  return m[0];
}

/** One color branch: from its `if (c === "<c>")` to the NEXT branch —
 *  gates must match inside their own branch, never across blocks. */
function colorBranch(c) {
  const b = onColorBody();
  const start = b.indexOf(`c === "${c}"`);
  assert.ok(start >= 0, `the ${c} branch exists`);
  const next = b.indexOf("if (c ===", start + 1);
  return next === -1 ? b.slice(start) : b.slice(start, next);
}

test("red = playback source, green = audio track (the requested remap)", () => {
  assert.ok(/toggleOverlay\("source"\)/.test(colorBranch("red")), "red opens the source list");
  assert.ok(!/toggleOverlay\("subs"\)/.test(colorBranch("red")), "red no longer opens subs");
  assert.ok(/toggleOverlay\("audio"\)/.test(colorBranch("green")), "green opens the audio list");
  assert.ok(!/toggleOverlay\("source"\)/.test(colorBranch("green")), "green no longer opens source");
});

test("yellow = subtitles (opening triggers the subtitle load), blue = play/pause (unchanged)", () => {
  const y = colorBranch("yellow");
  assert.ok(/toggleOverlay\("subs"\)/.test(y), "yellow opens the subs list");
  assert.ok(/ensureSubtitles\(\)/.test(y), "opening subs starts the subtitle load if needed");
  assert.ok(/togglePlayPause\(\)/.test(colorBranch("blue")), "blue keeps play/pause");
});

test("the legend shows the requested mapping (red=source, green=audio, yellow=subs, blue=play)", () => {
  const rows = {};
  for (const m of player.matchAll(/<span class="dot (c\d)"><\/span>([A-Za-z]+)/g)) rows[m[1]] = m[2];
  assert.equal(rows.c4, "Source", "red dot → Source");
  assert.equal(rows.c2, "Audio", "green dot → Audio");
  assert.equal(rows.c3, "Subs", "yellow dot → Subs");
  assert.equal(rows.c1, "Play", "blue dot → Play");
});

// ---------------------------------------------------------------------------
// D-PAD ROW NAVIGATION — left/right on the icon row (source/audio/subs/
// speed) and the transport row (rewind/play/forward) is ROW-LOCAL and
// CONSUMED: adjacency inside the row, the scrub bar at the live end, a
// no-op at the dead ends. The spatial engine's wide-bar geometry gets
// both wrong (test/row-nav.test.mjs pins the rule itself).
// ---------------------------------------------------------------------------

test("left/right on the icon/transport rows is consumed by the row rule (the spatial engine must not run)", () => {
  const m = player.match(/onNavigate: \(dir\) => \{([\s\S]*?)\n      \},/);
  assert.ok(m, "onNavigate is there");
  const b = m[1];
  assert.ok(/isRowKey/.test(b), "the row membership is checked");
  assert.ok(/rowStep\(/.test(b), "…and the target comes from the pure rowStep");
  const from = b.indexOf("rowStep(");
  assert.ok(/return true/.test(b.slice(from)), "the move is consumed (true) — including the dead ends, so the engine never re-runs");
});

test("the row rule imports the pure module (no inline geometry in the handler)", () => {
  assert.ok(/from "\.\.\/row-nav"/.test(player), "row-nav is imported");
  assert.ok(!/ICON_ROW|TRANSPORT_ROW/.test(player), "the row constants stay in the pure module");
});
