/**
 * OUTER acceptance test — chapter list in the player info panel.
 *
 * The file chapters (from the bounded header probe, FFmpeg-parity times)
 * become a focusable row list in the info panel: time + title, select →
 * seek there and close the panel. Honest fallback: a file without
 * chapters shows no section at all — never a placeholder row.
 *
 * Pure core (info-tab.ts) is unit-tested directly; the Player wiring is
 * pinned by source assertions (the repo's convention for Svelte screens).
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "vitest";

import { buildInfoPanel, formatChapterTime } from "../src/putio/info-tab";

const PLAYER = readFileSync(new URL("../src/ui/screens/Player.svelte", import.meta.url), "utf8");

// --- time formatting (pure) -------------------------------------------------

test("formatChapterTime: seconds under a minute", () => {
  assert.equal(formatChapterTime(0), "0:00");
  assert.equal(formatChapterTime(7), "0:07");
  assert.equal(formatChapterTime(59), "0:59");
});

test("formatChapterTime: minutes:seconds under an hour", () => {
  assert.equal(formatChapterTime(90), "1:30");
  assert.equal(formatChapterTime(1350), "22:30");
  assert.equal(formatChapterTime(3599), "59:59");
});

test("formatChapterTime: hours pad the front only when present", () => {
  assert.equal(formatChapterTime(3600), "1:00:00");
  assert.equal(formatChapterTime(5040), "1:24:00");
  assert.equal(formatChapterTime(3605), "1:00:05");
});

// --- panel content (pure) ---------------------------------------------------

test("chapters become rows with formatted time + title + seek target", () => {
  const p = buildInfoPanel({
    kind: "episode",
    chapters: [
      { start: 0, title: "Intro" },
      { start: 90, title: "Episode" },
      { start: 1350, title: "Credits" },
    ],
  });
  assert.deepEqual(p.chapters, [
    { time: "0:00", title: "Intro", start: 0 },
    { time: "1:30", title: "Episode", start: 90 },
    { time: "22:30", title: "Credits", start: 1350 },
  ]);
});

test("no chapters (absent / null / empty) = no section — honest fallback", () => {
  assert.deepEqual(buildInfoPanel({ kind: "episode" }).chapters, []);
  assert.deepEqual(buildInfoPanel({ kind: "movie", chapters: null }).chapters, []);
  assert.deepEqual(buildInfoPanel({ kind: "movie", chapters: [] }).chapters, []);
});

test("a chapter with a blank title still lists (time only, no fake text)", () => {
  const p = buildInfoPanel({ kind: "movie", chapters: [{ start: 90, title: "  " }] });
  assert.deepEqual(p.chapters, [{ time: "1:30", title: "", start: 90 }]);
});

// --- Player wiring ------------------------------------------------------------

test("the info panel passes the file chapters in and renders the rows", () => {
  assert.match(PLAYER, /infoPanel\.chapters/);
  assert.match(PLAYER, /subChapters/);
});

test("selecting a chapter seeks there and closes the panel", () => {
  // the chapter row delegates to the shared seek path, which seeks and closes
  assert.match(PLAYER, /function seekToChapter/);
  const fn = PLAYER.slice(PLAYER.indexOf("function seekToChapter"));
  assert.match(fn.slice(0, 120), /seekFrom\(start\)/);
  const shared = PLAYER.slice(PLAYER.indexOf("function seekFrom"));
  assert.match(shared.slice(0, 240), /engine\?\.seek\(/);
  assert.match(shared.slice(0, 240), /closeInfo\(\)/);
});
