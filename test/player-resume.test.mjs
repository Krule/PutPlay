// OUTER acceptance test (P1, locked decision L1): PURE AUTO-RESUME.
//
// The resume prompt ("You left this at … / Resume / Start from beginning")
// is gone. The HIG says avoid asking people if they want to resume — the
// player simply starts where the viewer left off (the engine's existing
// auto-resume path, the one queue files already use), and "start from
// beginning" is a seek to 0 on the (now focusable) scrubber.
//
// The contract this gate pins:
//   1. Player.svelte compiles (Svelte 4).
//   2. NO prompt element in the DOM: the player source carries no
//      resumePrompt state, no prompt modal markup, and no prompt strings.
//   3. The engine is NEVER told to suppress its auto-resume (the
//      suppressAutoResume option and its use are removed).
//   4. The pure module keeps ONE decision — the auto-resume target
//      (saved position > RESUME_MIN, near the start → saved-lead) — and the
//      prompt-era choice functions are gone.
//
// Run: pnpm test
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";
import * as resume from "../src/putio/resume.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");
const player = read("src/ui/screens/Player.svelte");
const engine = read("src/putio/media.ts");

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

test("no resume prompt in the DOM — the state is gone from Player.svelte", () => {
  assert.ok(!/resumePrompt/.test(player), "the resumePrompt state must be removed (L1: no prompt)");
});

test("no prompt modal markup or strings in Player.svelte", () => {
  for (const s of ["You left this at", "Resume from", "Start from beginning", "skipResume"]) {
    assert.ok(!player.includes(s), `Player.svelte must not contain the prompt string/handler: ${s}`);
  }
});

test("the prompt-era engine machinery is gone (suppression, prompt-driven seek, choice lock)", () => {
  assert.ok(!player.includes("suppressAutoResume"), "Player.svelte must not pass suppressAutoResume");
  assert.ok(!engine.includes("suppressAutoResume"), "media.ts must not keep the suppression option");
  assert.ok(!engine.includes("applyInitialSeek"), "media.ts must not keep the prompt's seek path");
  assert.ok(!engine.includes("resumeLocked"), "media.ts must not keep the choice lock");
  assert.ok(!engine.includes("startFromBeginning"), "media.ts must not keep the content-start choice flag");
});

test("the prompt is out of Back: onBack has no resume branch", () => {
  const start = player.indexOf("function onBack(");
  assert.ok(start >= 0, "onBack must exist");
  const body = player.slice(start, player.indexOf("\n  }", start));
  assert.ok(!body.includes("resume"), "onBack must not special-case any resume prompt state");
});

test("resume.ts keeps the auto decision, drops the prompt-era choice functions", () => {
  assert.equal(typeof resume.autoResumeTarget, "function", "autoResumeTarget must exist (the engine's one rule)");
  for (const gone of ["shouldShowResumePrompt", "initialSeekTarget"]) {
    assert.equal(typeof resume[gone], "undefined", `${gone} must be removed (L1)`);
  }
});

test("autoResumeTarget: the whole pure rule (saved > RESUME_MIN, near start → saved-lead)", () => {
  const { RESUME_MIN, NEAR_START_MAX, RESUME_LEAD } = resume;
  assert.equal(RESUME_MIN, 30);
  assert.equal(NEAR_START_MAX, 60);
  assert.equal(RESUME_LEAD, 5);
  // no saved position → no resume
  assert.equal(resume.autoResumeTarget(0, 0), null);
  assert.equal(resume.autoResumeTarget(null, 0), null);
  assert.equal(resume.autoResumeTarget(undefined, 0), null);
  // trivially small saved position → no resume
  assert.equal(resume.autoResumeTarget(RESUME_MIN, 0), null);
  assert.equal(resume.autoResumeTarget(1, 0), null);
  // a real saved position, near the start → saved minus the lead
  assert.deepEqual(resume.autoResumeTarget(120, 3), { time: 120 - RESUME_LEAD });
  assert.deepEqual(resume.autoResumeTarget(RESUME_MIN + 1, 0), { time: RESUME_MIN + 1 - RESUME_LEAD });
  // not near the start (mid-file open) → no auto-resume
  assert.equal(resume.autoResumeTarget(120, NEAR_START_MAX), null);
  assert.equal(resume.autoResumeTarget(120, 600), null);
});
