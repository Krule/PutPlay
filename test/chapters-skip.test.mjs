// OUTER acceptance test — feature B: file chapters become skip segments.
//
// The file's OWN chapters (MKV Editions, already parsed by probeHeader and
// published on the engine as subChapters) are the most authoritative skip
// data there is: the uploader drew the intro/credits boundaries for THIS
// file. They must feed the existing skip engine (progress-bar marks,
// D-pad skip, fresh-start skip), winning over the per-episode database
// (TheIntroDB/consensus) type by type — the database fills the types the
// file has no chapter for.
//
// Real fixture: file 1618364460 (Kusuriya no Hitorigoto S03E03) —
// 4 chapters parsed from its MKV header:
//   [00:00–01:30] Intro, [01:30–22:30] Episode,
//   [22:30–23:40] Credits, [23:40–24:00] Episode
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chapterTitleToSegType,
  chaptersToSegs,
  mergeChapterSegs,
} from "../src/putio/chapter-segs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");

/** The real chapters of the Kusuriya file (seconds; end 0 = no end). */
const KUSURIYA_CHAPTERS = [
  { start: 0, end: 90, title: "Intro" },
  { start: 90, end: 1350, title: "Episode" },
  { start: 1350, end: 1420, title: "Credits" },
  { start: 1420, end: 1440, title: "Episode" },
];

// ---------------- title normalization ----------------

test("chapter titles: intro/opening variants map to intro", () => {
  assert.equal(chapterTitleToSegType("Intro"), "intro");
  assert.equal(chapterTitleToSegType("INTRO"), "intro");
  assert.equal(chapterTitleToSegType("  (Intro)  "), "intro");
  assert.equal(chapterTitleToSegType("Opening"), "intro");
});

test("chapter titles: recap maps to recap", () => {
  assert.equal(chapterTitleToSegType("Recap"), "recap");
  assert.equal(chapterTitleToSegType("PREVIEW/RECAP"), "recap");
});

test("chapter titles: credits/ending/outro variants map to credits", () => {
  assert.equal(chapterTitleToSegType("Credits"), "credits");
  assert.equal(chapterTitleToSegType("CREDITS"), "credits");
  assert.equal(chapterTitleToSegType("Ending"), "credits");
  assert.equal(chapterTitleToSegType("Outro"), "credits");
  assert.equal(chapterTitleToSegType("End Credits"), "credits");
});

test("chapter titles: content chapters are NOT skip segments", () => {
  assert.equal(chapterTitleToSegType("Episode"), null);
  assert.equal(chapterTitleToSegType("Episode 3"), null);
  assert.equal(chapterTitleToSegType(""), null);
  assert.equal(chapterTitleToSegType("Intermission"), null);
  assert.equal(chapterTitleToSegType("Part 1"), null);
});

// ---------------- chapters -> segs ----------------

test("the real Kusuriya chapters yield intro + credits (Episode dropped)", () => {
  const segs = chaptersToSegs(KUSURIYA_CHAPTERS);
  assert.deepEqual(segs, [
    { type: "intro", start: 0, end: 90 },
    { type: "credits", start: 1350, end: 1420 },
  ]);
});

test("a chapter with no end (end 0) runs to the end of the media", () => {
  const segs = chaptersToSegs([{ start: 1350, end: 0, title: "Credits" }]);
  assert.deepEqual(segs, [{ type: "credits", start: 1350, end: null }]);
});

test("malformed chapters (end before start, negative) are dropped", () => {
  const segs = chaptersToSegs([
    { start: 100, end: 50, title: "Intro" },
    { start: -5, end: 90, title: "Credits" },
    { start: 0, end: 60, title: "Intro" },
  ]);
  assert.deepEqual(segs, [{ type: "intro", start: 0, end: 60 }]);
});

test("no recognized chapters -> empty (the database stays in charge)", () => {
  assert.deepEqual(chaptersToSegs([]), []);
  assert.deepEqual(
    chaptersToSegs([{ start: 0, end: 1440, title: "Episode" }]),
    []
  );
});

// ---------------- merge: file chapters win, DB fills the gaps ----------------

test("file intro+credits beat the database's intro+credits; DB recap survives", () => {
  const fileSegs = chaptersToSegs(KUSURIYA_CHAPTERS);
  const dbSegs = [
    { type: "intro", start: 10, end: 55 },
    { type: "recap", start: 55, end: 85 },
    { type: "credits", start: 1355, end: 1415 },
  ];
  assert.deepEqual(mergeChapterSegs(fileSegs, dbSegs), [
    { type: "intro", start: 0, end: 90 },
    { type: "recap", start: 55, end: 85 },
    { type: "credits", start: 1350, end: 1420 },
  ]);
});

test("no file chapters -> the database list passes through untouched", () => {
  const dbSegs = [
    { type: "intro", start: 10, end: 55 },
    { type: "credits", start: 1355, end: null },
  ];
  assert.deepEqual(mergeChapterSegs([], dbSegs), dbSegs);
});

test("file covers only one type -> that type is replaced, the rest stays", () => {
  const fileSegs = chaptersToSegs([{ start: 0, end: 90, title: "Intro" }]);
  const dbSegs = [
    { type: "intro", start: 12, end: 58 },
    { type: "credits", start: 1360, end: 1420 },
  ];
  assert.deepEqual(mergeChapterSegs(fileSegs, dbSegs), [
    { type: "intro", start: 0, end: 90 },
    { type: "credits", start: 1360, end: 1420 },
  ]);
});

test("the merged list is sorted by start (freshSkip walks it in order)", () => {
  const fileSegs = [{ type: "credits", start: 100, end: 130 }];
  const dbSegs = [{ type: "intro", start: 0, end: 40 }];
  assert.deepEqual(mergeChapterSegs(fileSegs, dbSegs), [
    { type: "intro", start: 0, end: 40 },
    { type: "credits", start: 100, end: 130 },
  ]);
});

// ---------------- wiring ----------------

test("the player feeds the file chapters through the merge into the skip engine", () => {
  const player = read("../src/ui/screens/Player.svelte");
  assert.ok(
    /chaptersToSegs/.test(player),
    "the Player must convert engine.subChapters to segs"
  );
  assert.ok(
    /mergeChapterSegs/.test(player),
    "the merged list (file wins per type) is what the engine gets"
  );
  assert.ok(
    /p\.subChapters/.test(player),
    "late probe results re-merge (the probe and the DB lookup race)"
  );
});

test("the engine already publishes the parsed chapters (feature A)", () => {
  const media = read("../src/putio/media.ts");
  assert.ok(
    /subChapters/.test(media),
    "probeHeader's chapters must reach the Player on engine state"
  );
});
