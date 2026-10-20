/**
 * Feature C — OUTER acceptance test: chapter markings on the progress bar.
 *
 * The user's shape (m00882): "markings on the progress bar, when hovered
 * over showing which chapter it starts". On the TV the "hover" is the
 * bar's existing preview bubble — the pointer preview (scrubHover) and the
 * D-pad-focus bubble at the playhead. So: a quiet hairline tick per chapter
 * start on the track, and when the bubble position is near a tick the
 * bubble also shows that chapter's title (and the tick highlights).
 *
 * Pure core (unit-tested below, no DOM):
 *   chapterTicks(chapters, duration) — the ticks (start, pct, title)
 *   chapterAt(chapters, t, duration) — the chapter the bubble position
 *     "belongs to" for labelling, or null
 * Wiring pins: the Player renders the ticks inside .bar-track (plain %
 * coordinates, like .bar-seg) and feeds the bubble the chapter label.
 *
 * The real Kusuriya chapters (fixture of record for chapters):
 *   0–90 Intro · 90–1350 Episode · 1350–1420 Credits · 1420–1440 Episode
 * duration 1440 s. The Scrubs file (1616433948) shows the auto-chapter
 * shape: "Chapter NN" every 300 s, NO end times — the label logic must
 * work from starts alone (ends are never consulted).
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "vitest";

import { chapterTicks, chapterAt } from "../src/putio/chapter-ticks";

const KUSURIYA = [
  { start: 0, end: 90, title: "Intro" },
  { start: 90, end: 1350, title: "Episode" },
  { start: 1350, end: 1420, title: "Credits" },
  { start: 1420, end: 1440, title: "Episode" },
];
const DUR = 1440;

// ---------------- ticks: chapter starts -> positions on the track ----------------

test("chapterTicks: the real Kusuriya chapters -> 4 ticks at the right pct", () => {
  const ticks = chapterTicks(KUSURIYA, DUR);
  assert.equal(ticks.length, 4);
  assert.deepEqual(
    ticks.map((t) => t.title),
    ["Intro", "Episode", "Credits", "Episode"]
  );
  assert.equal(ticks[0].pct, 0);
  assert.equal(ticks[1].pct, 90 / 1440 * 100); // 6.25
  assert.equal(ticks[2].pct, 1350 / 1440 * 100); // 93.75
  assert.equal(ticks[3].pct, 1420 / 1440 * 100); // 98.611…
});

test("chapterTicks: live/unknown duration -> no ticks; null/undefined -> none", () => {
  assert.deepEqual(chapterTicks(KUSURIYA, 0), []);
  assert.deepEqual(chapterTicks(KUSURIYA, Number.POSITIVE_INFINITY), []);
  assert.deepEqual(chapterTicks(null, DUR), []);
  assert.deepEqual(chapterTicks(undefined, DUR), []);
  assert.deepEqual(chapterTicks([], DUR), []);
});

test("chapterTicks: garbage starts are dropped (negative, at/past the end)", () => {
  const ticks = chapterTicks(
    [
      { start: -5, end: 90, title: "Bad" },
      { start: DUR, end: 0, title: "AtTheEnd" },
      { start: DUR + 30, end: 0, title: "Past" },
      { start: DUR - 0.1, end: 0, title: "LastFrame" },
    ],
    DUR
  );
  assert.deepEqual(
    ticks.map((t) => t.title),
    ["LastFrame"]
  );
});

test("chapterTicks: untitled chapters are still ticks (the 18-chapter movie shape) — they just have no label", () => {
  const ticks = chapterTicks(
    [
      { start: 0, end: 448.156, title: "" },
      { start: 448.156, end: 958.917, title: "" },
    ],
    7660
  );
  assert.equal(ticks.length, 2);
  assert.equal(ticks[1].pct, 448.156 / 7660 * 100);
});

// ---------------- chapterAt: which chapter the bubble position belongs to ----------------

test("chapterAt: near a titled tick -> that chapter (Kusuriya: 5 s past Credits)", () => {
  const hit = chapterAt(KUSURIYA, 1355, DUR);
  assert.ok(hit, "the credits tick is 5 s away — well inside the threshold");
  assert.equal(hit.title, "Credits");
  assert.equal(hit.index, 2); // index into the chapterTicks() list
});

test("chapterAt: far from every tick -> null (mid-Episode: no label, plain time bubble)", () => {
  assert.equal(chapterAt(KUSURIYA, 700, DUR), null);
});

test("chapterAt: threshold is max(15 s, 2% of duration) — the 2% rule on a 5000 s file", () => {
  // 2% of 5000 = 100 s
  const chs = [{ start: 1000, end: 0, title: "A" }];
  assert.ok(chapterAt(chs, 1099.9, 5000), "99.9 s away <= 100 s -> label");
  assert.equal(chapterAt(chs, 1100.1, 5000), null, "100.1 s away > 100 s -> no label");
});

test("chapterAt: the 15 s floor on a short file (2% < 15 s)", () => {
  // 2% of 600 = 12 s -> the floor (15 s) applies
  const chs = [{ start: 300, end: 0, title: "A" }];
  assert.ok(chapterAt(chs, 314, 600), "14 s away <= 15 s -> label");
  assert.equal(chapterAt(chs, 316, 600), null, "16 s away > 15 s -> no label");
});

test("chapterAt: untitled ticks never produce a label (honest: no invented titles)", () => {
  const chs = [
    { start: 0, end: 448.156, title: "" },
    { start: 448.156, end: 958.917, title: "" },
  ];
  assert.equal(chapterAt(chs, 10, 7660), null);
  assert.equal(chapterAt(chs, 448.156, 7660), null);
});

test("chapterAt: ties go to the EARLIER tick (the chapter you are inside)", () => {
  const chs = [
    { start: 100, end: 0, title: "A" },
    { start: 200, end: 0, title: "B" },
  ];
  // duration 3000 -> threshold 60 s: both ticks are 50 s away = a real tie
  const hit = chapterAt(chs, 150, 3000);
  assert.ok(hit);
  assert.equal(hit.title, "A");
  assert.equal(hit.index, 0);
});

test("chapterAt: the nearest tick wins when several are in range", () => {
  const chs = [
    { start: 100, end: 0, title: "A" },
    { start: 200, end: 0, title: "B" },
    { start: 300, end: 0, title: "C" },
  ];
  const hit = chapterAt(chs, 280, 1000);
  assert.ok(hit);
  assert.equal(hit.title, "C");
  assert.equal(hit.index, 2);
});

// ---------------- wiring: the Player renders ticks + feeds the bubble ----------------

const PLAYER = readFileSync(
  new URL("../src/ui/screens/Player.svelte", import.meta.url),
  "utf8"
);

test("the player derives the ticks from the file chapters + duration", () => {
  assert.ok(
    /import\s*{[^}]*\bchapterTicks\b[^}]*}\s*from\s*"\.\.\/\.\.\/putio\/chapter-ticks"/.test(
      PLAYER
    ),
    "chapterTicks is imported from the pure module"
  );
  assert.ok(
    /chapterTicks\(\s*fileChapters\s*,\s*duration\s*\)/.test(PLAYER),
    "ticks are derived from fileChapters + duration"
  );
  assert.ok(
    /\{#each\s+chapterTickList\s+as\s+tick[^}]*\}/.test(PLAYER),
    "each tick renders inside the bar"
  );
  assert.ok(
    /class="bar-chapter"/.test(PLAYER),
    "the tick element exists on the track"
  );
});

test("the bubble shows the chapter title when the position is near a tick", () => {
  assert.ok(
    /import\s*{[^}]*\bchapterAt\b[^}]*}\s*from\s*"\.\.\/\.\.\/putio\/chapter-ticks"/.test(
      PLAYER
    ),
    "chapterAt is imported"
  );
  assert.ok(
    /chapterAt\(\s*fileChapters\s*,/.test(PLAYER),
    "the bubble position is checked against the chapters"
  );
  assert.ok(
    /class="bubble-chap"/.test(PLAYER),
    "the bubble renders the chapter label line"
  );
});

test("the tick the bubble labels is highlighted (hot)", () => {
  assert.ok(
    /class:hot\s*=\s*\{/.test(PLAYER),
    "the matching tick gets the hot class"
  );
  assert.ok(
    /\.bar-chapter\s*\{/.test(PLAYER) && /\.bar-chapter\.hot\s*\{/.test(PLAYER),
    "CSS: base tick + hot variant"
  );
});
