// ISSUE: "Language selection in Settings should be a dropdown containing
// all languages instead of text input fields."
//
// TV remotes cannot type — the free-text language inputs were nearly
// unusable. Contract:
//  - src/putio/languages.ts exports a comprehensive language list in the
//    SAME 3-letter code format the app already matches against
//    (config.audioLang/subtitleLang, put.io language_code: "eng", "deu").
//  - Settings replaces both text inputs with field buttons that open a
//    LangPicker overlay (scrollable row list, focus-trapped, current value
//    preselected, blank row for "none").
//  - Back closes the picker (TV idiom) and focus returns to the field.
//
// Run: pnpm test
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

test("languages.ts exports a comprehensive 3-letter-code list", async () => {
  const { LANGUAGES } = await import("../src/putio/languages.ts");
  assert.ok(Array.isArray(LANGUAGES), "LANGUAGES must be an array");
  assert.ok(LANGUAGES.length >= 100, `expected a comprehensive list (>=100), got ${LANGUAGES.length}`);
  const codes = new Set();
  for (const l of LANGUAGES) {
    assert.match(l.code, /^[a-z]{3}$/, `code "${l.code}" must be 3 letters (the format the app matches against)`);
    assert.ok(l.label && l.label.length > 1, `label missing for ${l.code}`);
    assert.ok(!codes.has(l.code), `duplicate code ${l.code}`);
    codes.add(l.code);
  }
  const by = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.label]));
  for (const c of ["eng", "deu", "fra", "spa", "ita", "por", "rus", "jpn", "chi", "kor"]) {
    assert.ok(by[c], `the list must include ${c}`);
  }
  assert.equal(by.eng, "English");
});

test("LangPicker component: focus-trapped overlay with preselected row", () => {
  const p = "src/ui/components/LangPicker.svelte";
  assert.ok(existsSync(join(here, "..", p)), "src/ui/components/LangPicker.svelte must exist");
  const s = read(p);
  assert.ok(/setFocusScope/.test(s), "the picker must trap remote focus (setFocusScope) while open");
  assert.ok(/onDestroy|onMount[\s\S]{0,400}?setFocusScope\(null\)/.test(s) || /setFocusScope\(null\)/.test(s),
    "the picker must release the focus scope when it closes");
  assert.ok(/registerAll|data-focus/.test(s), "picker rows must be registered focusable");
  assert.ok(/pickerDefaultIndex|rowFocusState/.test(s), "the picker must focus the currently-selected row (reuse the picker-default helpers)");
  assert.ok(/class:sel=/.test(s), "the selected row must be marked");
});

test("Settings: language text inputs replaced by picker field buttons", () => {
  const s = read("src/ui/screens/Settings.svelte");
  assert.ok(!/text-input[\s\S]{0,200}?cfgAudio|text-input[\s\S]{0,200}?cfgSub/.test(s),
    "no free-text input may remain for the language preferences");
  assert.ok(/from "\.\.\/\.\.\/putio\/languages"/.test(s), "Settings must import the language list");
  assert.ok(/LangPicker/.test(s), "Settings must use the LangPicker overlay");
  // both preferences open a picker
  const audioOpen = /langPicker\s*=\s*"audio"/.test(s);
  const subOpen = /langPicker\s*=\s*"sub"/.test(s);
  assert.ok(audioOpen && subOpen, "both the audio and subtitle fields must open the picker");
  // Back closes an open picker before persisting/navigating
  const onBack = s.slice(s.indexOf("function onBack"));
  assert.ok(/langPicker/.test(onBack), "onBack must close an open language picker");
});
