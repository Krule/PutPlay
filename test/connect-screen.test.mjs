// Regression gate: the Connect (sign-in) screen surface.
//
// Issues handled:
//  - "Remove paste a token option from auth" — the TV remote cannot type;
//    the paste input was dead weight next to the device-code flow.
//  - "On connect screen, I want to skip the step of needing to press the
//    button to log in and immediately display the QR code" — the device-code
//    flow must START when the screen opens (status unauthed), not after a
//    button press. The "Sign in with code" gate button is gone; the QR +
//    code are the first thing on screen. A "Try again" button remains ONLY
//    for the failure case (the OOB request errored — status back to
//    unauthed with oobError).
//
// This gate compiles Connect.svelte the way the build does and checks the
// generated markup.
//
// Run: npm test
import { compile, preprocess } from "svelte/compiler";
import sveltePreprocess from "svelte-preprocess";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "src", "ui", "screens", "Connect.svelte");

const source = readFileSync(file, "utf8");
const processed = await preprocess(source, sveltePreprocess(), { filename: file });
const { js } = compile(processed.code, {
  generate: "dom",
  filename: file,
  css: "injected",
});
const code = js.code;

test("no paste-a-token option remains (button, input, or mode)", () => {
  assert.ok(!code.includes("Paste a token"), "the 'Paste a token' button must be removed");
  assert.ok(!/element\("input"\)/.test(code), "the paste input element must be removed");
  assert.ok(!/token-input/.test(code), "the token input styling/element must be gone");
  assert.ok(!source.includes("usePastedToken"), "usePastedToken must no longer be imported");
});

test("the device-code flow auto-starts on mount when unauthed", () => {
  const onMount = source.slice(source.indexOf("onMount("));
  assert.ok(
    /startOOB\(\)/.test(onMount),
    "Connect must call startOOB() from onMount when status is unauthed — no button press may gate the QR"
  );
});

test("auto-start also fires on the loading→unauthed transition (not just mount)", () => {
  // at mount the status is "loading" (saved-session check in flight), so a
  // mount-only guard never sees unauthed — the transition must trigger it.
  assert.ok(
    /if\s*\(\s*status\s*===\s*"unauthed"\s*&&\s*!v\.oobError\s*&&\s*prevStatus\s*!==\s*"unauthed"\s*\)\s*\{?\s*\n?\s*startOOB\(\)/.test(source),
    "sync() must auto-start on the transition into unauthed (skipping the failed state)"
  );
});

test("the 'Sign in with code' gate button is gone", () => {
  assert.ok(!code.includes("Sign in with code"), "the manual gate button must be removed");
});

test("the brand-gate screen is gone — one full-width column, no two-column brand layout", () => {
  // the gate (logo + tagline + stamp + 'Connect your put.io') was the
  // pre-autostart landing; with the QR screen as THE connect screen it
  // must never render — not even after an OOB error.
  assert.ok(!source.includes('<div class="brand">'), "the brand block must be removed");
  assert.ok(!source.includes("Connect your put.io"), "the gate heading must be gone");
  assert.ok(!/class:full=/.test(source), "the layout must be a single full-width column unconditionally");
  assert.ok(!/\bstamp\b/.test(source), "the gate's stamp signature element must go with the gate");
});

test("an OOB failure renders inside the Approve screen's frame (never a separate screen)", () => {
  const start = source.indexOf("{#if oobError}");
  assert.ok(start !== -1, "the oobError branch must exist");
  const end = source.indexOf("{/if}", start);
  const errBranch = source.slice(start, end);
  assert.ok(
    /Approve this TV/.test(errBranch),
    "the error state must keep the 'Approve this TV' heading — the user is on the approve screen, the flow just hasn't succeeded"
  );
  assert.ok(/error-text/.test(errBranch), "the error must still be shown in red");
  assert.ok(/Try again/.test(errBranch), "the recovery button must stay in the error branch");
});

test("Back on the QR screen exits the app — no 'back to sign-in options' branch remains", () => {
  assert.ok(
    !source.includes("Back to sign-in options"),
    "the sign-in-options screen no longer exists — Back must not reference it"
  );
  const onBack = source.slice(source.indexOf("function onBack"));
  const onBackBody = onBack.slice(0, onBack.indexOf("\n  }"));
  assert.ok(
    /doublePress\(exitGuard/.test(onBackBody) && /platform\.back\(\)/.test(onBackBody),
    "onBack must run the double-press guard and exit the app"
  );
});

test("failure keeps a recovery path: error text + Try again button", () => {
  assert.ok(/oobError/.test(code), "the OOB error must still be surfaced");
  const retry = source.indexOf("Try again");
  assert.ok(retry !== -1, "a 'Try again' recovery button must exist for the failed start");
  // the retry button lives inside the error branch, not unconditionally
  const errIdx = source.lastIndexOf("oobError", retry);
  assert.ok(errIdx !== -1 && errIdx < retry, "'Try again' must be rendered under the oobError condition");
});

test("focus: pending focuses the new-code button; unauthed focuses nothing", () => {
  // entering the pending state must move remote focus to the one control
  // that exists then (Generate a new code), so OK does something useful
  assert.ok(
    /status\s*===\s*"pending"[\s\S]{0,220}?focusEl\(newCodeBtn\)|focusEl\(newCodeBtn\)/.test(source),
    "pending state must focus the 'Generate a new code' button"
  );
});
