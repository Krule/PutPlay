// Regression gate: the player progress bar's .bar-fill must stay alive.
//
// The reported bug: .bar-fill was invisible because the template bound
//   style="width: {pct()}%"
// Svelte's dependency tracking does NOT look inside a function body — the
// expression's only tracked identifier is `pct` itself, which never changes.
// The compiled output therefore sets the width exactly ONCE (create phase)
// and never again: the bar is frozen at its mount-time value (0%) for the
// whole playback, while the time labels (plain bindings) update fine.
//
// This gate compiles Player.svelte the same way the build does and asserts
// the width style is re-applied in the fragment's UPDATE function (p()),
// which only happens when the template binds a plain reactive value.
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
const file = join(here, "..", "src", "ui", "screens", "Player.svelte");

const source = readFileSync(file, "utf8");
const processed = await preprocess(source, sveltePreprocess(), { filename: file });
const { js } = compile(processed.code, {
  generate: "dom",
  filename: file,
  css: "injected",
});
const code = js.code;

test("bar-fill width is re-applied in the update phase (not frozen at mount)", () => {
  const widthSets = code.match(/set_style\([^,]+,\s*"width"/g) || [];
  assert.ok(
    widthSets.length >= 2,
    `expected set_style(..., "width") in BOTH create and update phases — found ${widthSets.length}. ` +
      "A style bound through a bare function call only runs at create, freezing the bar at 0%."
  );
});

test("bar-fill width binds a plain reactive value, not a function call", () => {
  const m = source.match(/class="bar-fill"[^>]*style="width:\s*\{([^}]*)\}%"/);
  assert.ok(m, "bar-fill width style binding not found in Player.svelte");
  const expr = m[1].trim();
  assert.match(
    expr,
    /^[a-zA-Z_$][\w$]*$/,
    `bar-fill width must bind a plain reactive identifier (Svelte tracks those); got "${expr}". ` +
      "Function calls are invisible to Svelte dependency tracking."
  );
});
