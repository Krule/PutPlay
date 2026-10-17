// Source gate: Player + Settings controls must be handed to the remote
// engine, and the engine must be safe for re-registered/detached DOM.
//
// The bug this guards: both screens put `data-focus` in their markup but
// never called remote.register() — the engine's candidate scan only sees
// explicitly registered elements, so on the common 5-way remote the D-pad
// found zero targets (dead arrows), focusFirst() was a no-op, and OK's
// clickActive() had nothing to click. Pointer clicks still worked, which is
// why it only bites on the 5-way remote.
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
const settings = read("src/ui/screens/Settings.svelte");
const engine = read("src/webos/remote.ts");

test("Player registers its control row with the remote engine", () => {
  assert.ok(
    /registerAll\(\s*controlsEl/.test(player),
    "the .controls row (cbtns) must be registered via remote.registerAll(controlsEl)"
  );
});

test("Player routes every overlay/modal surface through the shared panelFocus lifecycle", () => {
  // leavePanelEl is gone on purpose: Back no longer "leaves" — it docks
  // (lossless), and the only stop is the dock's ✕ (plan §9.1).
  // resumePanelEl is gone with the resume prompt (L1: pure auto-resume).
  // segPanelEl is gone with the TV redesign: the center skip-offer modal is
  // now a bottom-right pill (pillState) with no focus lifecycle of its own.
  for (const panel of ["sourcePanelEl", "audioPanelEl", "subsPanelEl", "speedPanelEl", "infoPanelEl", "errPanelEl"]) {
    assert.ok(
      new RegExp(`panelFocus\\(\\s*${panel}`).test(player),
      `${panel} must go through panelFocus() (registerAll + default focus + close-restore) — pick-rows/panel buttons are dead on the 5-way remote otherwise`
    );
  }
  assert.ok(
    /function panelFocus\(/.test(player) && /remote\.registerAll\(el\)/.test(player),
    "panelFocus() must register the panel's rows with the remote engine"
  );
});

test("Player routes OK through the tested playerOkAction decision", () => {
  assert.ok(
    /playerOkAction\(/.test(player),
    "OK must go through playerOkAction(!!activeEl) — the pure, unit-tested contract"
  );
});

test("Player overlays focus their default pick-row via pickerDefaultIndex", () => {
  assert.ok(
    /pickerDefaultIndex\(/.test(player),
    "overlay open must move D-pad focus to pickerDefaultIndex(rows) — the selected row"
  );
});

test("Settings registers its controls (chips, inputs, buttons) with the engine", () => {
  assert.ok(
    /registerAll\(\s*settingsEl/.test(settings),
    "Settings chips/inputs/buttons must be registered via remote.registerAll — they were data-focus markup only"
  );
});

test("engine: register() is idempotent (no duplicate click listeners on re-register)", () => {
  // focusEl() calls register() on already-registered elements; without a
  // guard every focusEl leaks another click listener.
  assert.ok(
    /if\s*\(\s*(!\s*)?this\.registered\.has\(el\)/.test(engine) ||
      /const\s+fresh\s*=\s*!\s*this\.registered\.has\(el\)/.test(engine),
    "register() must check this.registered.has(el) before attaching its click listener"
  );
});

test("engine: candidates() prunes detached elements (lazy GC)", () => {
  // {#if}/{#each} surfaces recreate their DOM on every open; without a prune
  // the registered set grows one dead copy of each overlay per open, forever.
  const candidatesBody = engine.slice(engine.indexOf("private candidates("));
  assert.ok(
    candidatesBody.length > 0 && /isConnected/.test(candidatesBody.slice(0, 400)),
    "candidates() must drop registered elements whose isConnected is false"
  );
});

test("engine: registerAll() scans a surface's [data-focus] children once per node", () => {
  assert.ok(
    /registerAll\(/.test(engine),
    "the engine must expose registerAll(root) — idempotent per-node registration for Svelte surfaces"
  );
  assert.ok(
    /__reg/.test(engine),
    "registerAll must mark nodes (__reg) so re-scans after async content arrival don't double-register"
  );
});

test("engine: clickActive() never clicks a detached (stale) element", () => {
  // OK with a stale active (its surface was just swapped) used to synthesize
  // a click on the dead node — firing a stale handler (e.g. re-opening an old
  // library tile). A stale active must blur, not click.
  const clickActiveBody = engine.slice(engine.indexOf("clickActive("));
  assert.ok(
    clickActiveBody.length > 0 && /isConnected/.test(clickActiveBody.slice(0, 300)),
    "clickActive() must check isConnected before activating"
  );
});

test("Settings.svelte compiles (Svelte 4: no bare return inside $: blocks)", async () => {
  const { compile, preprocess } = await import("svelte/compiler");
  const sveltePreprocess = (await import("svelte-preprocess")).default;
  const file = join(here, "..", "src", "ui", "screens", "Settings.svelte");
  const source = readFileSync(file, "utf8");
  const processed = await preprocess(source, sveltePreprocess(), { filename: file });
  assert.doesNotThrow(
    () => compile(processed.code, { generate: "dom", filename: file, css: "injected" }),
    "Settings.svelte must compile — a parse error there (e.g. `return` in a $: block) is invisible to every other gate"
  );
});

test("Player: opening one panel closes the others (no stacked overlays)", () => {
  // green (source) then yellow (audio) must not leave both panels open at
  // once — two stacked .center-panels break D-pad focus and make the
  // top panel's rows unreachable (caught while driving the audio e2e:
  // a stale ref clicked the hidden source panel underneath)
  const player = read("src/ui/screens/Player.svelte");
  assert.ok(
    /function toggleOverlay/.test(player),
    "Player must centralize panel toggling in one sibling-closing helper"
  );
  const helper = player.slice(player.indexOf("function toggleOverlay"));
  assert.ok(
    /overlays\.audio\s*=\s*false/.test(helper) && /overlays\.source\s*=\s*false/.test(helper),
    "toggleOverlay must close the sibling overlays before opening one"
  );
  assert.ok(
    !/on:click=\{\(\) => \(overlays\.audio = !overlays\.audio\)\}/.test(player),
    "the audio button must use toggleOverlay, not a raw toggle"
  );
});

test("Player: a source change never force-opens the source panel", () => {
  // onSourceChange used to set overlays.source = true unconditionally — so
  // picking "Spanish (DTS) via put.io stream" from the AUDIO panel (which
  // switches to HLS) popped the source panel over the audio panel and stole
  // D-pad focus mid-interaction. A switch must only keep the panel open if
  // the user is already in it.
  const player = read("src/ui/screens/Player.svelte");
  const m = player.match(/onSourceChange:\s*\(s\) => \{[\s\S]*?\n      \},/);
  assert.ok(m, "onSourceChange handler must exist");
  assert.ok(
    !/overlays\.source\s*=\s*true/.test(m[0]),
    "onSourceChange must not force overlays.source = true"
  );
});
