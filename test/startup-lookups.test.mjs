// OUTER acceptance test: starting media must not fight its own metadata.
//
// Story (owner, 2026-10-19): since the skip/info lookups landed, starting a
// video feels slower. Playback never BLOCKS on the lookups in code — the
// cost is network contention: at the exact moment the stream is fighting
// for its first bytes, 6-10 small metadata requests (TMDb + AniList
// searches, then TheIntroDB + AniSkip + introdb.app, plus the info-tab
// details) race it over the same pipe.
//
// Contract this test pins:
//   1. initEngine (the source-load point) does NOT fire the segment or
//      info lookups — the stream's first burst is uncontested
//   2. the first-frame reactive fires them (once per file, via
//      startMeta) — by then the connection is established and the
//      lookups ride behind it; skip data landing a few seconds in is
//      still inside the engine's fresh-skip grace (media.ts
//      FRESH_LATE_GRACE), and the crossing reactive covers the rest
//   3. a stream error fires them too — a broken file never delivers its
//      first frame, but the info tab still wants its data
//   4. the lookups share ONE per-file AbortController (a bound fetchImpl
//      threads the signal through seglookup and info-data): abandoning
//      the file (a new file, or the player's unmount) aborts the
//      in-flight requests instead of letting them contend with the next
//      stream
//
// The chain itself already degrades an aborted fetch to "nothing to skip"
// (pinned in segment-skip.test.mjs), so the abort can never reject into
// the player.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/ui/screens/Player.svelte"), "utf8");

/** The region between two anchors (the end anchor must follow the start). */
function region(from, to) {
  const a = src.indexOf(from);
  assert.ok(a !== -1, `anchor found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b !== -1 && b > a, `end anchor after start: ${to}`);
  return src.slice(a, b);
}

/** `len` chars after an anchor. */
function after(anchor, len = 600) {
  const a = src.indexOf(anchor);
  assert.ok(a !== -1, `anchor found: ${anchor}`);
  return src.slice(a, a + len);
}

test("source load does not fire the metadata lookups (the stream's first burst is uncontested)", () => {
  const init = region("function initEngine() {", "function metaFetch");
  assert.ok(
    !/startSegLookup\(\)/.test(init),
    "initEngine must not call startSegLookup() — the segment lookup moves to the first frame"
  );
  assert.ok(
    !/loadInfo\(\)/.test(init),
    "initEngine must not call loadInfo() — the info load moves to the first frame"
  );
});

test("the first frame fires the lookups — once per file, behind an established stream", () => {
  const hook = region(
    "$: if (engine && duration > 0 && !paused && !buffering && !startedPlaying)",
    "// ---------------- audio panel"
  );
  assert.ok(
    /startMeta\(\)/.test(hook),
    "the first-frame reactive fires startMeta() — the deferred lookups"
  );

  const meta = region("function startMeta()", "function startSegLookup");
  assert.ok(/if \(metaStarted\) return/.test(meta), "once per file — the guard returns on the second fire");
  assert.ok(/metaStarted = true/.test(meta), "the guard sets on the first fire");
  assert.ok(
    /startSegLookup\(\)/.test(meta) && /loadInfo\(\)/.test(meta),
    "startMeta is the segment lookup plus the info load"
  );
});

test("a stream error fires the lookups too (a broken file has no first frame, but the info tab wants its data)", () => {
  const err = after("if (p.error !== undefined)", 500);
  assert.ok(
    /startMeta\(\)/.test(err),
    "the error branch fires startMeta() — the once-per-file guard makes it safe to fire from both points"
  );
});

test("abandoning the file aborts its in-flight lookups (no orphaned requests for the next stream)", () => {
  // A new file kills the previous file's session:
  const init = region("function initEngine() {", "function metaFetch");
  assert.ok(/abortMeta\(\)/.test(init), "initEngine aborts the previous file's lookup session");
  assert.ok(/metaStarted = false/.test(init), "the once-per-file guard resets per file");

  // The player's unmount kills its session:
  const down = region("onDestroy(() => {", "});");
  assert.ok(/abortMeta\(\)/.test(down), "unmount aborts the lookup session");

  // The session is one AbortController behind a bound fetch:
  const state = region("let metaCtrl", "function startMeta");
  assert.ok(/AbortController/.test(state), "one AbortController per file");
  const bound = region("function metaFetch()", "function abortMeta");
  assert.ok(/signal/.test(bound), "the bound fetch threads the session's signal into every request");

  // Both lookups take the bound fetch:
  const seg = region("function startSegLookup", "function loadInfo");
  assert.ok(
    /lookupSegments\(TMDB_KEY,\s*name,\s*metaFetch\(\),\s*segCache\)/.test(seg),
    "the segment lookup runs on the bound fetch"
  );
  const info = region("function loadInfo()", "/** Info actions:");
  assert.equal(
    (info.match(/fetchImpl:\s*metaFetch\(\)/g) || []).length,
    2,
    "both info lookups run on the bound fetch"
  );
});
