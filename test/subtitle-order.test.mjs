// Subtitle source ordering + labelling.
//
// put.io's /files/{id}/subtitles `source` enum is: "mkv" | "folder" |
// "opensubtitles". The user wants the MKV-container embedded tracks offered
// FIRST (they belong to the video), then folder uploads, then
// OpenSubtitles suggestions last. Auto-selection (pickSubtitleDefault)
// scans the list in order, so ordering is what makes embedded win.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderSubtitleSources,
  subtitleSourceLabel,
  pickSubtitleDefault,
} from "../src/putio/subs.ts";

const CODE = { English: "eng", French: "fra" };
const sub = (key, source, language = "English", cues = 3) => ({
  key,
  source,
  language,
  language_code: CODE[language] || "eng",
  name: `${key}.${source === "mkv" ? "ass" : "srt"}`,
  url: `https://x/${key}`,
  format: "srt",
  cues: Array.from({ length: cues }, (_, i) => ({ start: i, end: i + 1, text: `c${i}` })),
});

test("orderSubtitleSources: mkv first, then folder, then opensubtitles", () => {
  const list = [
    sub("os1", "opensubtitles"),
    sub("mk1", "mkv"),
    sub("fo1", "folder"),
    sub("os2", "opensubtitles"),
  ];
  const ordered = orderSubtitleSources(list);
  assert.deepEqual(
    ordered.map((s) => s.key),
    ["mk1", "fo1", "os1", "os2"]
  );
});

test("orderSubtitleSources is stable within a group and does not mutate input", () => {
  const list = [
    sub("a", "opensubtitles"),
    sub("b", "mkv"),
    sub("c", "opensubtitles"),
    sub("d", "mkv"),
  ];
  const snapshot = list.map((s) => s.key);
  const ordered = orderSubtitleSources(list);
  assert.deepEqual(ordered.map((s) => s.key), ["b", "d", "a", "c"]);
  assert.deepEqual(list.map((s) => s.key), snapshot, "input order preserved");
});

test("orderSubtitleSources: unknown/null sources sort last, stable", () => {
  const list = [
    { key: "x", source: null },
    { key: "mk", source: "mkv" },
    { key: "y", source: "upload" },
  ];
  const ordered = orderSubtitleSources(list);
  assert.deepEqual(ordered.map((s) => s.key), ["mk", "x", "y"]);
});

test("subtitleSourceLabel: mkv → 'Embedded', opensubtitles → 'OpenSubtitles', others null", () => {
  assert.equal(subtitleSourceLabel("mkv"), "Embedded");
  assert.equal(subtitleSourceLabel("MKV"), "Embedded");
  assert.equal(subtitleSourceLabel("opensubtitles"), "OpenSubtitles");
  assert.equal(subtitleSourceLabel("folder"), null);
  assert.equal(subtitleSourceLabel(null), null);
  assert.equal(subtitleSourceLabel(undefined), null);
});

// ensureSubtitles maps API items → the in-app shape pickSubtitleDefault consumes
const toLoaded = (s) => ({ language: s.language, languageCode: s.language_code, cues: s.cues });

test("auto-select prefers the embedded MKV track over an OpenSubtitles suggestion", () => {
  const api = orderSubtitleSources([
    sub("os", "opensubtitles", "English"),
    sub("mk", "mkv", "English"),
  ]);
  const idx = pickSubtitleDefault(api.map(toLoaded), ["eng"]);
  assert.equal(idx, 0, "embedded track is index 0 after ordering");
  assert.equal(api[idx].source, "mkv");
});

test("auto-select still respects language: no match → off (-1)", () => {
  const api = orderSubtitleSources([sub("mk", "mkv", "French", 3)]);
  assert.equal(pickSubtitleDefault(api.map(toLoaded), ["eng"]), -1);
});
