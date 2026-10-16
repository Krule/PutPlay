// Unit tests for the subtitle-listing decision (src/putio/subs.ts — added fns).
// BUG 4: for a video with no real subtitles, the put.io /files/{id}/subtitles
// endpoint returns OpenSubtitles *suggestions* (several English + German
// matches for "Armin") and the player auto-selected the first one, so the user
// saw "real" subtitles that don't belong to the video.
//
// Decisions extracted as pure functions:
//   subtitleSourceLabel(source) — display tag ("OpenSubtitles" suggestions
//     are labelled, uploaded/embedded are not).
//   pickSubtitleDefault(tracks, preferredLangs) — which track to auto-select:
//     only one whose language matches the user's preference, and only if it
//     actually has cues. Never auto-select an arbitrary OpenSubtitles match
//     in another language → returns -1 (off).
//
// Run: pnpm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { subtitleSourceLabel, pickSubtitleDefault } from "../src/putio/subs.ts";

const T = (i, lang, code, source, cueCount) => ({
  id: String(i),
  language: lang,
  languageCode: code,
  source: source || "",
  name: `s${i}`,
  url: `u${i}`,
  format: "srt",
  cues: Array.from({ length: cueCount }, () => ({ start: 0, end: 1, text: "x" })),
});

// ---------------- subtitleSourceLabel ----------------

test("OpenSubtitles suggestions are labelled as such", () => {
  assert.equal(subtitleSourceLabel("OpenSubtitles"), "OpenSubtitles");
  assert.equal(subtitleSourceLabel("opensubtitles.org"), "OpenSubtitles");
});

test("user-uploaded / embedded subs get no external label", () => {
  assert.equal(subtitleSourceLabel("upload"), null);
  assert.equal(subtitleSourceLabel("uploaded"), null);
  assert.equal(subtitleSourceLabel(""), null);
  assert.equal(subtitleSourceLabel(null), null);
  assert.equal(subtitleSourceLabel("embed"), null);
});

// ---------------- pickSubtitleDefault ----------------

test("no tracks → -1 (off)", () => {
  assert.equal(pickSubtitleDefault([], ["eng"]), -1);
});

test("the Armin regression: only foreign-language OpenSubtitles matches → OFF, nothing bogus selected", () => {
  // What put.io returns for the Armin video: 14 English-ish + German matches,
  // but the video has no subtitles and the user's preference is English.
  const tracks = [T(0, "German", "ger", "OpenSubtitles", 12), T(1, "German", "ger", "OpenSubtitles", 8)];
  assert.equal(pickSubtitleDefault(tracks, ["eng"]), -1);
});

test("a track in the preferred language with cues → auto-selected", () => {
  const tracks = [T(0, "German", "ger", "OpenSubtitles", 12), T(1, "English", "eng", "OpenSubtitles", 30)];
  assert.equal(pickSubtitleDefault(tracks, ["eng"]), 1);
});

test("language match prefers the language_code over the display name", () => {
  const tracks = [T(0, "English (US)", "eng", "OpenSubtitles", 30)];
  assert.equal(pickSubtitleDefault(tracks, ["eng"]), 0);
  assert.equal(pickSubtitleDefault(tracks, ["deu"]), -1);
});

test("multiple preferred languages: first track whose language is in the list wins", () => {
  const tracks = [
    T(0, "French", "fra", "OpenSubtitles", 10),
    T(1, "English", "eng", "OpenSubtitles", 20),
    T(2, "German", "deu", "OpenSubtitles", 15),
  ];
  // preference order doesn't beat track order — the first in-list track is taken
  assert.equal(pickSubtitleDefault(tracks, ["deu", "eng"]), 1);
  // fra is not wanted, eng is the first wanted track with cues
  assert.equal(pickSubtitleDefault(tracks, ["eng"]), 1);
  // deu alone → the German track
  assert.equal(pickSubtitleDefault(tracks, ["deu"]), 2);
});

test("a matching track with NO cues is skipped", () => {
  const tracks = [T(0, "English", "eng", "OpenSubtitles", 0), T(1, "English", "eng", "OpenSubtitles", 5)];
  assert.equal(pickSubtitleDefault(tracks, ["eng"]), 1);
});

test("no preference set → nothing auto-selected (safer than guessing)", () => {
  const tracks = [T(0, "English", "eng", "OpenSubtitles", 30)];
  assert.equal(pickSubtitleDefault(tracks, []), -1);
});
