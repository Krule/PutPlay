// Regression gate: the Connect (sign-in) screen surface.
//
// Issues handled:
//  - "Remove paste a token option from auth" — the TV remote cannot type;
//    the paste input was dead weight next to the device-code flow.
//  - "Sign in with code must be on the right side when the Connect page is
//    opened instead of behind the button" — with the paste option gone it is
//    the SOLE action: centred in the right-hand form column (the brand owns
//    the left), first in DOM order (the remote's initial focus lands on it),
//    and nothing rendered over it.
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

test("exactly two focusable actions remain: sign-in code + generate-new-code", () => {
  const n = (code.match(/attr\([^,]+,\s*"data-focus"/g) || []).length;
  assert.equal(
    n,
    2,
    `expected exactly 2 data-focus elements on the Connect screen (Sign in with code + Generate a new code), found ${n}`
  );
});

test("'Sign in with code' is first in DOM order and sits after the brand (right column)", () => {
  // DOM order == template order in the source (Svelte hoists block create
  // functions in the compiled JS in a different order — check the source).
  const iSign = source.indexOf("Sign in with code");
  const iNewCode = source.indexOf("Generate a new code");
  const iBrand = source.indexOf('class="brand"');
  assert.ok(iSign !== -1, "the 'Sign in with code' button must exist");
  assert.ok(iSign < iNewCode, "sign-in must precede the pending-state button in DOM order (initial remote focus)");
  assert.ok(iBrand !== -1 && iBrand < iSign, "the brand (left column) must precede the sign-in button (right form column)");
});
