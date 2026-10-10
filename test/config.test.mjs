// Unit tests for playback preferences (src/store/config.ts — pure helpers).
// FEATURE: the Config page lets the user pick a default source, preferred
// audio language, and preferred subtitle language (plus subtitle display
// size); the Player must honor them. The matching decisions are pure and
// live in config.ts so they are testable in node.
//
//   matchLang(trackLang, preferred) — does a track's language satisfy the
//     preference? (by code or display name, case-insensitive)
//   pickAudioTrack(tracks, preferred) — index of the first track matching
//     the preferred audio language, else the currently-enabled/first track.
//   pickSubtitleTrack(tracks, preferred) — like the subs default, but this
//     is the preference-driven pick used at source-load time.
//   normalizeConfig(partial) — merge user input onto defaults, coercing to
//     the stored shape (source kind, non-negative size, sane language).
//
// Run: npm test

import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const out = join(mkdtempSync(join(tmpdir(), "putio-test-")), "config.cjs");
await build({
  entryPoints: ["src/putio/config.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const require = createRequire(import.meta.url);
const { DEFAULT_CONFIG, normalizeConfig, matchLang, pickAudioTrack, pickSubtitleTrack } = require(out);
// (module under test: src/putio/config.ts — pure decisions; the Svelte
//  store in src/store/config.ts wraps it)

// ---------------- normalizeConfig ----------------

test("normalizeConfig: empty input → full defaults", () => {
  const c = normalizeConfig({});
  assert.equal(c.source, "original");
  assert.equal(c.audioLang, "");
  assert.equal(c.subtitleLang, "");
  assert.equal(c.subScale, 1);
});

test("normalizeConfig: valid source values pass through", () => {
  for (const s of ["original", "mp4", "hls"]) {
    assert.equal(normalizeConfig({ source: s }).source, s);
  }
});

test("normalizeConfig: unknown source falls back to default", () => {
  assert.equal(normalizeConfig({ source: "dolby" }).source, "original");
});

test("normalizeConfig: languages are trimmed; garbage is kept as-given (display string)", () => {
  assert.equal(normalizeConfig({ audioLang: "  eng " }).audioLang, "eng");
  assert.equal(normalizeConfig({ subtitleLang: "German" }).subtitleLang, "German");
});

test("normalizeConfig: subScale is clamped to the supported range", () => {
  assert.equal(normalizeConfig({ subScale: 0 }).subScale, DEFAULT_CONFIG.subScaleMin);
  assert.equal(normalizeConfig({ subScale: 9 }).subScale, DEFAULT_CONFIG.subScaleMax);
  assert.equal(normalizeConfig({ subScale: 1.6 }).subScale, 1.6);
  assert.equal(normalizeConfig({ subScale: "weird" }).subScale, DEFAULT_CONFIG.subScale);
});

// ---------------- matchLang ----------------

const trk = (lang, code) => ({ lang, code: code || lang.toLowerCase().slice(0, 3), label: lang });

test("matchLang: exact code match", () => {
  assert.equal(matchLang(trk("English", "eng"), "eng"), true);
});

test("matchLang: case-insensitive display-name match", () => {
  assert.equal(matchLang(trk("English", "eng"), "ENGLISH"), true);
  assert.equal(matchLang(trk("English", "eng"), "english"), true);
});

test("matchLang: empty preference matches everything (no preference = don't filter)", () => {
  assert.equal(matchLang(trk("German", "ger"), ""), true);
  assert.equal(matchLang(trk("German", "ger"), null), true);
});

test("matchLang: non-matching → false", () => {
  assert.equal(matchLang(trk("German", "ger"), "eng"), false);
});

// ---------------- pickAudioTrack ----------------

test("pickAudioTrack: no preference → first track (index 0)", () => {
  const tracks = [trk("German"), trk("English", "eng")];
  assert.equal(pickAudioTrack(tracks, ""), 0);
  assert.equal(pickAudioTrack(tracks, null), 0);
});

test("pickAudioTrack: preference matches the 2nd track → 2nd", () => {
  const tracks = [trk("German", "ger"), trk("English", "eng")];
  assert.equal(pickAudioTrack(tracks, "eng"), 1);
});

test("pickAudioTrack: no match → fall back to first (still play something)", () => {
  const tracks = [trk("German", "ger")];
  assert.equal(pickAudioTrack(tracks, "eng"), 0);
});

test("pickAudioTrack: empty track list → 0", () => {
  assert.equal(pickAudioTrack([], "eng"), 0);
});

// ---------------- pickSubtitleTrack ----------------

test("pickSubtitleTrack: no preference → off (-1)", () => {
  const tracks = [{ language: "English", languageCode: "eng", cues: [1] }];
  assert.equal(pickSubtitleTrack(tracks, ""), -1);
});

test("pickSubtitleTrack: preference picks the matching cue-bearing track", () => {
  const tracks = [
    { language: "German", languageCode: "ger", cues: [1, 2] },
    { language: "English", languageCode: "eng", cues: [1, 2, 3] },
  ];
  assert.equal(pickSubtitleTrack(tracks, "eng"), 1);
});

test("pickSubtitleTrack: preference matches but that track has no cues → off", () => {
  const tracks = [
    { language: "English", languageCode: "eng", cues: [] },
    { language: "German", languageCode: "ger", cues: [1] },
  ];
  assert.equal(pickSubtitleTrack(tracks, "eng"), -1);
});
