// Source gate: the engine must dispatch OK/Enter itself.
//
// The bug it guards (found on the TV): pressing OK (Enter, keyCode 13) on a
// file thumb did nothing. Native Enter activation only fires on real
// <button>/<a> elements — the library tiles are <div tabindex=0>, so the
// engine had to dispatch handlers.onOK for every focused element. The old
// switch had no `case "ok"`, leaving every screen's onOK handler (the
// libraryOkAction / playerOkAction contracts) as dead code and OK functional
// only on elements that happen to be real buttons.
//
// Run: pnpm test
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const engine = read("src/webos/remote.ts");
const connect = read("src/ui/screens/Connect.svelte");
const settings = read("src/ui/screens/Settings.svelte");
const player = read("src/ui/screens/Player.svelte");

function okCaseBlock(src) {
  const onKeyBody = src.slice(src.indexOf("private onKey("));
  const m = onKeyBody.match(/case\s+"ok"\s*:/);
  if (!m) return null;
  const block = onKeyBody.slice(m.index, onKeyBody.indexOf("break;", m.index));
  return block.replace(/\/\/[^\n]*/g, "");
}

test("engine: onKey dispatches OK as onOK (div tiles are never natively activated by Enter)", () => {
  const block = okCaseBlock(engine);
  assert.ok(block, 'onKey must handle case "ok" — without it, OK is a no-op on div focusables (file thumbs)');
  assert.ok(
    /onOK\?\.\(/.test(block),
    "the ok case must dispatch handlers.onOK — the screens' OK contracts live there"
  );
});

test("engine: the ok case preventDefaults (native Enter would double-fire real <button> focusables)", () => {
  const block = okCaseBlock(engine);
  assert.ok(block, "missing case \"ok\"");
  assert.ok(
    /preventDefault/.test(block),
    "without preventDefault a focused real <button> gets BOTH the synthetic clickActive click and the native Enter click"
  );
});

test("Connect wires onOK (OK activates the focused sign-in control)", () => {
  assert.ok(
    /onOK/.test(connect),
    "Connect must set onOK — once the engine dispatches ok with preventDefault, Enter without a handler is dead"
  );
});

test("Settings confirm row focuses the primary action (TV idiom: OK confirms, Back cancels)", () => {
  // The remote has no cancel/escape key — Back is the cancel (onBack already
  // closes the confirm). The confirm row must therefore focus its primary
  // action, not a web-style Cancel button.
  assert.ok(
    /registerAll\(\s*confirmRowEl/.test(settings),
    "the confirm row must be registered (bind ref — the row is committed after the reactive phase)"
  );
  assert.ok(
    /btn\.primary/.test(settings) && /focusEl/.test(settings),
    "the confirm row must focusEl its .btn.primary (the action being confirmed)"
  );
});

test("engine: supports a focus scope (modal trap — arrows can't exit to controls behind the scrim)", () => {
  assert.ok(
    /setFocusScope\(/.test(engine),
    "the engine must expose setFocusScope(root) — without it, D-pad arrows wander from an open panel to the controls behind its scrim"
  );
  const candidatesBody = engine.slice(engine.indexOf("private candidates("));
  assert.ok(
    /scope/.test(candidatesBody.slice(0, 500)),
    "candidates() must filter to the scope root while a panel is open"
  );
});

test("Player scopes D-pad focus to the topmost open panel", () => {
  assert.ok(
    /setFocusScope\(/.test(player),
    "Player must setFocusScope to the open panel (overlay/modals) and null otherwise — arrows would otherwise exit the panel to the cbtns behind the scrim"
  );
});
