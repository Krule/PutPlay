// Regression gate: the Connect (sign-in) screen surface.
//
// Layout — Apple-Music-style split frame:
//  - left: brand frame — PutPlay logo + large "Sign in to put.io" copy.
//    It is a FRAME, not a gate: the device-code flow must AUTO-START so the
//    QR is on screen without any button press.
//  - right: the mechanism — dominant QR card + device code + link hint,
//    or its failure (error + Try again), or a loading spinner.
//
// Issues handled (carried over):
//  - "Remove paste a token option from auth" — the TV remote cannot type;
//    the paste input was dead weight next to the device-code flow.
//  - "immediately display the QR code" — the flow starts when the screen
//    opens (status unauthed), including the loading→unauthed transition.
//  - Back on this screen runs the double-press exit guard (no options
//    screen to go back to).
//
// This gate compiles Connect.svelte the way the build does and checks the
// generated markup.
//
// Run: pnpm test
import { compile, preprocess } from "svelte/compiler";
import sveltePreprocess from "svelte-preprocess";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
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

test("the brand frame is a frame, not a gate: two columns, logo + 'Sign in to put.io'", () => {
  // two-column split: brand left, mechanism right
  assert.ok(
    /grid-template-columns:\s*1fr 1fr/.test(source),
    "the connect screen must be a 1fr 1fr split (brand side | mechanism side)"
  );
  assert.ok(source.includes('class="brand-side"'), "the brand side must exist");
  assert.ok(/src="icon\.svg"/.test(source), "the brand side must render the PutPlay logo (icon.svg)");
  assert.ok(/class="brand-copy"/.test(source) && /Sign in to/.test(source),
    "the brand side must carry the large 'Sign in to' display copy");
  // the old gate's identity is gone — the frame must never ask the user to
  // press a button before the QR appears
  assert.ok(!source.includes("Connect your put.io"), "the gate heading must be gone");
  assert.ok(!/\bstamp\b/.test(source), "the gate's stamp signature element must go with the gate");
});

test("the mechanism side is QR-dominant: 320px QR card, then code + link hint", () => {
  assert.ok(source.includes('class="qr-card"'), "the pending frame must carry a QR card");
  assert.ok(
    /qr-card img\s*{[^}]*width:\s*320px/.test(source),
    "the QR must be the dominant element (320px, up from 220px)"
  );
  assert.ok(
    /code-num[^{]*{[^}]*tabular-nums/.test(source),
    "the device code must stay a tabular-numeral datum"
  );
  assert.ok(/app\.put\.io\/link|LINK_URL/.test(source), "the manual-entry hint must keep the app.put.io/link destination");
});

test("an OOB failure renders in the frame's right panel — the old 'Approve this TV' heading is gone", () => {
  const start = source.indexOf("{#if oobError}");
  assert.ok(start !== -1, "the oobError branch must exist");
  const end = source.indexOf("{/if}", start);
  const errBranch = source.slice(start, end);
  assert.ok(/error-text/.test(errBranch), "the error must still be shown in red");
  assert.ok(/Try again/.test(errBranch), "the recovery button must stay in the error branch");
  assert.ok(!source.includes("Approve this TV"),
    "'Approve this TV' is replaced by the brand frame's 'Sign in to put.io' copy");
});

test("loading and starting frames live in the mechanism side (brand frame is constant)", () => {
  const mechIdx = source.indexOf('class="mech-side"');
  assert.ok(mechIdx !== -1, "the mechanism side must exist");
  const loadingIdx = source.indexOf("Checking for a saved session");
  const startingIdx = source.indexOf("Starting sign-in");
  assert.ok(loadingIdx > mechIdx, "the loading frame must render inside the mechanism side");
  assert.ok(startingIdx > mechIdx, "the starting frame must render inside the mechanism side");
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
