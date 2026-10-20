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
// Run: pnpm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig, matchLang, pickAudioTrack, pickSubtitleTrack, SUB_SCALE_OPTIONS } from "../src/putio/config.ts";
// (module under test: src/putio/config.ts — pure decisions; the Svelte
//  store in src/store/config.ts wraps it)

// ---------------- normalizeConfig ----------------

test("normalizeConfig: empty input → full defaults", () => {
  const c = normalizeConfig({});
  assert.equal(c.source, "original");
  assert.equal(c.audioLang, "");
  assert.equal(c.subtitleLang, "");
  // m00887/m00906: the ASS-aware renderer renders at the file's author size
  // (24pt × 3 on 1080p = 72px at scale 1) — the user judged that "huge" and
  // the previous "Small" (0.8 → 57.6px) "just right": that step IS the default now.
  assert.equal(c.subScale, 0.8);
});

test("DEFAULT_CONFIG.subScale sits on the ladder (the selected row matches the stored value)", () => {
  assert.ok(
    SUB_SCALE_OPTIONS.some((o) => o.v === DEFAULT_CONFIG.subScale),
    "a default that is not a ladder step would show no selected row in the panel"
  );
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

// ---------------- audioFallback REMOVED (m00758) ----------------
//
// The "if the original can't switch audio" setting is gone — a refused
// native switch now ALWAYS falls back to the put.io rendition (the old
// "auto-hls" choice, position preserved). Stale saves may still carry the
// key; normalizeConfig must drop it so it can't leak into the state.

test("normalizeConfig: the removed audioFallback key is dropped (stale saves)", () => {
  assert.equal(normalizeConfig({ audioFallback: "auto-hls" }).audioFallback, undefined);
  assert.equal(normalizeConfig(null).audioFallback, undefined);
});

test("pickAudioTrack: a preference matching NO track is -1 (no silent track-0 force)", () => {
  // the old fallback (0) made a non-matching preference switch to track 0 —
  // a switch nobody asked for. -1 = "play the file's own default".
  const tracks = [{ lang: "eng" }, { lang: "ita" }];
  assert.equal(pickAudioTrack(tracks, "spa"), -1);
  // an empty preference still means "first track" (the webview default)
  assert.equal(pickAudioTrack(tracks, ""), 0);
  // a match still wins
  assert.equal(pickAudioTrack(tracks, "ita"), 1);
});

// ---------------- label matching (EAAAO regression, round 5) ----------------
//
// The real EAAAO MKV (ffprobe): audio streams carry language "ita"/"eng"
// AND titles "Italiano AC-3 5.1" / "English AC-3 5.1". The TV webview does
// not reliably expose the 3-letter code (empty or 2-letter "en" observed as
// a real possibility) — matching on the code field alone then SILENTLY
// misses, and a configured preference does nothing (no pick, no toast,
// no auto-hls — "it just plays Italian"). The track's LABEL (the MKV
// title, which the webview does expose) must participate in the match.

test("matchLang: an empty language code still matches via the track label", () => {
  // the EAAAO case: webview exposes no code, but the title is real
  assert.ok(matchLang({ lang: "", label: "English AC-3 5.1" }, "eng"));
  assert.ok(matchLang({ lang: "", label: "Italiano AC-3 5.1" }, "ita"));
  assert.ok(!matchLang({ lang: "", label: "English AC-3 5.1" }, "ita"));
});

test("matchLang: a 2-letter webview code matches the 3-letter preference via the label", () => {
  // webview normalizes "eng" → "en"; the code comparison misses, the label saves it
  assert.ok(matchLang({ lang: "en", label: "English AC-3 5.1" }, "eng"));
  assert.ok(matchLang({ lang: "it", label: "Italiano AC-3 5.1" }, "ita"));
  assert.ok(!matchLang({ lang: "en", label: "English AC-3 5.1" }, "spa"));
});

test("matchLang: a display-name preference matches the label", () => {
  // if the stored preference is a display name ("english" / "English")
  assert.ok(matchLang({ lang: "eng", label: "English AC-3 5.1" }, "English"));
  assert.ok(matchLang({ lang: "eng", label: "English" }, "english"));
  assert.ok(matchLang({ lang: "eng", label: "English" }, "eng"));
  assert.ok(!matchLang({ lang: "spa", label: "Spanish (DTS)" }, "english"));
});

test("pickAudioTrack: EAAAO exposure variants all resolve to the English track", () => {
  const mk = (itaLang, engLang) => [
    { lang: itaLang, label: "Italiano AC-3 5.1" },
    { lang: engLang, label: "English AC-3 5.1" },
  ];
  assert.equal(pickAudioTrack(mk("ita", "eng"), "eng"), 1); // tag-correct
  assert.equal(pickAudioTrack(mk("", ""), "eng"), 1);       // no codes at all
  assert.equal(pickAudioTrack(mk("it", "en"), "eng"), 1);   // 2-letter codes
  assert.equal(pickAudioTrack(mk("ita", "eng"), "ita"), 0); // the other lang
  assert.equal(pickAudioTrack(mk("ita", "eng"), "fre"), -1); // absent language
});

// ---------------- skip segments (intro / recap / credits, from show data) ----------------
//
// One switch (skipSegments): ON = auto-skip at the episode's real segment
// boundaries (TheIntroDB), OFF = the player offers the skip per section.
// The TMDb key that resolves title → TMDb id is BAKED INTO THE APP at build
// time (src/putio/tmdb-key.ts) — a TV has no viable keyboard for it — so
// the user config carries only the switch. Garbage from a hand-edited
// install coerces to the default — never a half-configured skip.

test("normalizeConfig: the segment switch defaults ON and is the ONLY segment setting", () => {
  const c = normalizeConfig({});
  assert.equal(c.skipSegments, true, "auto-skip is the headline");
  assert.ok(!("tmdbKey" in c), "the key is not user config (it is embedded)");
});

test("normalizeConfig: segment settings pass through when valid", () => {
  const c = normalizeConfig({ skipSegments: false });
  assert.equal(c.skipSegments, false);
  // a stale install's saved key is dropped, not carried along
  assert.ok(!("tmdbKey" in normalizeConfig({ skipSegments: true, tmdbKey: "stale" })));
});

test("normalizeConfig: a non-boolean switch falls back to the default", () => {
  assert.equal(normalizeConfig({ skipSegments: "yes" }).skipSegments, true);
  assert.equal(normalizeConfig({ skipSegments: 0 }).skipSegments, true);
});

// ---------------- readingDirection: REMOVED (2026-10-13, TV feedback) ----------------
//
// The user doesn't want a direction choice in Settings — the reader's
// Up-key legend is the control, the direction is per-comic (the progress
// store), and a never-flipped comic is LTR. normalizeConfig must not
// resurrect the field from an older install's saved config.

test("normalizeConfig: readingDirection is gone (it was removed from the settings UI)", () => {
  const fresh = normalizeConfig({});
  assert.ok(!("readingDirection" in fresh), "the shape no longer carries it");
  const oldInstall = normalizeConfig({ readingDirection: "rtl" });
  assert.ok(!("readingDirection" in oldInstall), "…and a stale saved value is dropped, not resurrected");
});
