// FEATURE: the audio panel must show EVERY audio stream in the file, not
// just the ones the webOS webview happens to expose:
//   - native `audioTracks`  → what the TV's pipeline will let us switch
//   - put.io media_info     → what is ACTUALLY in the file (codec/language/
//                             title per stream; hidden/undecodable tracks
//                             appear here but not in audioTracks)
//   - HLS manifest renditions → the "via put.io stream" fallback per language
//
// Contract (pure merge — no DOM, testable in node; see .agents/plan.md
// Layer B):
//   codecPlayableOnWebOS6(codec, channels) — true/false/null (unknown)
//   mergeAudioRows(native, meta, hls)      → stable, label-enriched rows
//   activeRowKey(rows, kind, index)        → which row is "on"
//
// Run: pnpm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const out = join(mkdtempSync(join(tmpdir(), "putio-test-")), "track-merge.cjs");
await build({
  entryPoints: ["src/putio/track-merge.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const require = createRequire(import.meta.url);
const {
  codecPlayableOnWebOS6,
  mergeAudioRows,
  activeRowKey,
  langMatches,
  audioStreamsFromMediaInfo,
} = require(out);

// ---------------- media_info extraction ----------------

const probe = (streams) => ({ format: { name: "Matroska" }, streams });
const a = (codec, language, title, channels) => ({
  codec_type: "audio",
  codec_name: codec,
  channels: channels == null ? undefined : channels,
  tags: { language, title },
});

test("audioStreamsFromMediaInfo: audio streams only, codec/language/title/channels mapped", () => {
  const out = audioStreamsFromMediaInfo(probe([
    { codec_type: "video", codec_name: "hevc" },
    a("eac3", "eng", "English"),
    a("dca", "spa", "Spanish (DTS)", 6),
    { codec_type: "subtitle", codec_name: "ass" },
  ]));
  assert.deepEqual(out, [
    { codec: "eac3", language: "eng", title: "English", channels: null },
    { codec: "dca", language: "spa", title: "Spanish (DTS)", channels: 6 },
  ]);
});

test("audioStreamsFromMediaInfo: missing/null/garbage shapes degrade to empty or partial rows", () => {
  assert.deepEqual(audioStreamsFromMediaInfo(null), []);
  assert.deepEqual(audioStreamsFromMediaInfo(undefined), []);
  assert.deepEqual(audioStreamsFromMediaInfo({ streams: null }), []);
  assert.deepEqual(audioStreamsFromMediaInfo(probe([a("aac", null, null)])), [
    { codec: "aac", language: null, title: null, channels: null },
  ]);
  assert.deepEqual(audioStreamsFromMediaInfo(probe([{ codec_type: "audio" }])), [
    { codec: null, language: null, title: null, channels: null },
  ]);
});

// ---------------- codec support (webOS 6 / C1 webview) ----------------
// Evidence: Jellyfin's webOS device profile — webOS 5/6 do not decode DTS;
// FLAC only up to 2 channels; AAC/MP3/MP2/AC3/EAC3/Opus/PCM fine.

test("codecPlayableOnWebOS6: webview-decodable codecs → true", () => {
  for (const c of ["aac", "mp3", "mp2", "ac3", "eac3", "opus", "pcm_s16le", "pcm_s24le"])
    assert.equal(codecPlayableOnWebOS6(c), true, c);
});

test("codecPlayableOnWebOS6: webOS 5/6 cannot decode DTS/TrueHD → false", () => {
  for (const c of ["dca", "dts", "dts-hd", "truehd"]) assert.equal(codecPlayableOnWebOS6(c), false, c);
});

test("codecPlayableOnWebOS6: FLAC is channel-limited (≤2ch)", () => {
  assert.equal(codecPlayableOnWebOS6("flac", 2), true);
  assert.equal(codecPlayableOnWebOS6("flac", 1), true);
  assert.equal(codecPlayableOnWebOS6("flac", 5.1), false);
  // channel count unknown → don't overclaim
  assert.equal(codecPlayableOnWebOS6("flac"), true);
});

test("codecPlayableOnWebOS6: unknown codecs → null (TV *may* decode)", () => {
  assert.equal(codecPlayableOnWebOS6(""), null);
  assert.equal(codecPlayableOnWebOS6(undefined), null);
  assert.equal(codecPlayableOnWebOS6("some_future_codec"), null);
});

// ---------------- the merge ----------------

const native = (rows = []) =>
  rows.map(([enabled, label, language]) => ({ enabled, label, lang: language || undefined }));

const meta = (streams = []) =>
  streams.map(([codec, language, title]) => ({ codec: codec || undefined, language: language || undefined, title: title || undefined }));

const hls = (rows = []) => rows.map(([lang, name]) => ({ lang: lang || null, name: name || null }));

test("merge: two native tracks + matching meta + matching HLS renditions", () => {
  const rows = mergeAudioRows(
    native([[true, "English (E-AC3)", "eng"], [false, "Spanish (AAC)", "spa"]]),
    meta([["eac3", "eng", "English"], ["aac", "spa", "Spanish"]]),
    hls([["en", "English"], ["es", "Spanish"]])
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.nativeIndex, r.undecodable, r.hlsIndex]),
    [[0, false, 0], [1, false, 1]]
  );
  // native label wins
  assert.equal(rows[0].label, "English (E-AC3)");
  assert.equal(rows[1].label, "Spanish (AAC)");
  assert.equal(rows[0].codec, "eac3");
  assert.equal(rows[1].lang, "spa");
});

test("merge: webview-HIDDEN track (DTS) still appears, flagged undecodable, HLS-linked", () => {
  const rows = mergeAudioRows(
    native([[true, "English (E-AC3)", "eng"]]), // DTS/spa is hidden by the webview
    meta([["eac3", "eng", "English"], ["dca", "spa", "Spanish (DTS)"]]),
    hls([["en", "English"], ["es", "Spanish"]])
  );
  assert.equal(rows.length, 2);
  const spa = rows[1];
  assert.equal(spa.nativeIndex, -1); // not natively switchable
  assert.equal(spa.undecodable, true); // dca on webOS 6
  assert.equal(spa.hlsIndex, 1); // reachable via the put.io stream
  assert.equal(spa.label, "Spanish (DTS)"); // meta title (no native label)
});

test("merge: no meta (fetch failed) → rows come from the native list, codec unknown", () => {
  const rows = mergeAudioRows(
    native([[true, "English (E-AC3)", "eng"], [false, "Spanish (AAC)", "spa"]]),
    meta([]),
    hls([])
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].codec, "");
  assert.equal(rows[1].undecodable, false);
  assert.equal(rows[1].hlsIndex, -1);
});

test("merge: no native list at all → meta rows, all HLS-only", () => {
  const rows = mergeAudioRows(
    native([]),
    meta([["eac3", "eng", "English"], ["dca", "spa", "Spanish"]]),
    hls([["en", "English"], ["es", "Spanish"]])
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.nativeIndex, r.hlsIndex, r.undecodable]),
    [[-1, 0, false], [-1, 1, true]]
  );
});

test("merge: single-track file → exactly one row (no phantom duplicates)", () => {
  const rows = mergeAudioRows(
    native([[true, "", "eng"]]),
    meta([["aac", "eng", ""]]),
    hls([])
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nativeIndex, 0);
  assert.equal(rows[0].label, "English"); // language name when label+title empty
});

test("merge: label fallback order — native label > meta title > language > Track N", () => {
  const rows = mergeAudioRows(
    native([[true, "Native Label", "eng"]]),
    meta([["aac", "eng", "Meta Title"]]),
    hls([])
  );
  assert.equal(rows[0].label, "Native Label");
  const rows2 = mergeAudioRows(native([]), meta([["dca", "spa", ""]]), hls([]));
  assert.equal(rows2[0].label, "Spanish"); // 3-letter code → display name
  const rows3 = mergeAudioRows(native([]), meta([["dca", "", ""]]), hls([]));
  assert.equal(rows3[0].label, "Track 1");
});

test("merge: HLS matching is language-based (3-letter meta vs 2-letter manifest) and name-based", () => {
  // meta says "spa" (ISO 639-2/T), manifest says "es" (ISO 639-1)
  const rows = mergeAudioRows(
    native([]),
    meta([["aac", "spa", "Spanish"]]),
    hls([["en", "English"], ["es", "Spanish"]])
  );
  assert.equal(rows[0].hlsIndex, 1);
  // and by display name when codes are absent
  const rows2 = mergeAudioRows(
    native([]),
    meta([["aac", "", "Commentary"]]),
    hls([["en", "Director's Commentary"]])
  );
  // name "Director's Commentary" vs title "Commentary" — substring match
  assert.equal(rows2[0].hlsIndex, 0);
});

test("merge: language preference match helper honors 2/3-letter codes and names", () => {
  assert.equal(langMatches("eng", "en"), true);
  assert.equal(langMatches("en", "eng"), true);
  assert.equal(langMatches("spa", "es"), true);
  assert.equal(langMatches("deu", "de"), true);
  assert.equal(langMatches("English", "eng"), true);
  assert.equal(langMatches("eng", "spa"), false);
  assert.equal(langMatches("", "eng"), false);
  assert.equal(langMatches(null, "eng"), false);
});

// ---------------- active row key ----------------

test("activeRowKey: native source → the row holding the enabled native track", () => {
  const rows = mergeAudioRows(
    native([[false, "English (E-AC3)", "eng"], [true, "Spanish (AAC)", "spa"]]),
    meta([["eac3", "eng", "English"], ["aac", "spa", "Spanish"]]),
    hls([])
  );
  assert.equal(activeRowKey(rows, "native", 1), rows[1].key);
  assert.equal(activeRowKey(rows, "native", 0), rows[0].key);
  assert.equal(activeRowKey(rows, "native", 7), null);
});

test("activeRowKey: HLS source → the row holding that rendition", () => {
  const rows = mergeAudioRows(
    native([[true, "English (E-AC3)", "eng"]]),
    meta([["eac3", "eng", "English"], ["dca", "spa", "Spanish"]]),
    hls([["en", "English"], ["es", "Spanish"]])
  );
  assert.equal(activeRowKey(rows, "hls", 1), rows[1].key);
  assert.equal(activeRowKey(rows, "hls", 0), rows[0].key);
});

// ---------------- HLS runtime selection (Phase 4) ----------------
//
// When the user's pick leaves for the put.io stream (or a source switch
// enters HLS), the stream must come back with THAT language on — not the
// manifest default. pickHlsAudioTrackIndex matches a language against
// hls.js's live audioTracks list.

const { pickHlsAudioTrackIndex } = (() => {
  // re-require so the new export is visible even if added later
  return require(out);
})();

test("pickHlsAudioTrackIndex: matches by 2/3-letter language code (either side)", () => {
  const tracks = [
    { name: "English", lang: "en" },
    { name: "Spanish", lang: "es" },
  ];
  assert.equal(pickHlsAudioTrackIndex(tracks, "es"), 1);
  assert.equal(pickHlsAudioTrackIndex(tracks, "spa"), 1);
  assert.equal(pickHlsAudioTrackIndex(tracks, "eng"), 0);
});

test("pickHlsAudioTrackIndex: matches a display name against the track name", () => {
  const tracks = [{ name: "English" }, { name: "Spanish" }];
  assert.equal(pickHlsAudioTrackIndex(tracks, "es"), 1);
  assert.equal(pickHlsAudioTrackIndex(tracks, "French"), -1);
});

test("pickHlsAudioTrackIndex: handles suffixed track names (e.g. 'Spanish (DTS)')", () => {
  const tracks = [{ name: "English (E-AC3)" }, { name: "Spanish (DTS)" }];
  assert.equal(pickHlsAudioTrackIndex(tracks, "es"), 1);
  assert.equal(pickHlsAudioTrackIndex(tracks, "en"), 0);
});

test("pickHlsAudioTrackIndex: no match / empty / null → -1 (keep the default)", () => {
  const tracks = [{ name: "French", lang: "fr" }];
  assert.equal(pickHlsAudioTrackIndex(tracks, "es"), -1);
  assert.equal(pickHlsAudioTrackIndex([], "es"), -1);
  assert.equal(pickHlsAudioTrackIndex(null, "es"), -1);
  assert.equal(pickHlsAudioTrackIndex(tracks, ""), -1);
  assert.equal(pickHlsAudioTrackIndex(tracks, undefined), -1);
});

// ---------------- panel row state hints (Phase 5) ----------------
//
// One pure function owns the row's state hint — the five states from the
// UX contract: on / Switching… / on this TV / via put.io stream /
// TV can't decode (CODEC). No inline ternary ladders in the markup.

const row5 = (o = {}) => ({
  key: "x",
  label: "Label",
  lang: "es",
  codec: "dts",
  nativeIndex: -1,
  hlsIndex: -1,
  undecodable: true,
  hlsOnly: true,
  ...o,
});

test("panelRowHint: the five row states", () => {
  const { panelRowHint } = require(out);
  assert.equal(panelRowHint(row5(), { active: true }), "on");
  assert.equal(panelRowHint(row5(), { switching: true }), "Switching\u2026");
  assert.equal(panelRowHint(row5({ nativeIndex: 0, undecodable: false }), {}), "on this TV");
  assert.equal(panelRowHint(row5({ hlsIndex: 1 }), {}), "via put.io stream");
  assert.equal(panelRowHint(row5({ codec: "dts" }), {}), "TV can't decode (DTS)");
  assert.equal(panelRowHint(row5({ codec: "" }), {}), "TV can't decode");
});

test("panelRowHint: active beats switching, switching beats the rest", () => {
  const { panelRowHint } = require(out);
  assert.equal(panelRowHint(row5({ nativeIndex: 0 }), { active: true, switching: true }), "on");
  assert.equal(panelRowHint(row5({ nativeIndex: 0, codec: "aac" }), { switching: true }), "Switching\u2026");
});

test("panelRowHint: an undecodable row WITH a stream rendition offers the stream", () => {
  const { panelRowHint } = require(out);
  const r = row5({ hlsIndex: 0, undecodable: true });
  assert.equal(panelRowHint(r, {}), "via put.io stream");
});
