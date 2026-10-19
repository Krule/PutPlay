// Unit tests for the pure subtitle parser (src/putio/subs.ts).
// Run: pnpm test


import { test } from "vitest";
import assert from "node:assert/strict";
import { vttToCues, cueAt, subtitlesToCues, detectSubtitleFormat, loadSubtitle } from "../src/putio/subs.ts";

// ---------------- vttToCues ----------------

test("SRT: basic cues with comma milliseconds", () => {
  const srt = [
    "1",
    "00:00:06,000 --> 00:00:12,074",
    "Advertise your product",
    "",
    "2",
    "00:01:02,004 --> 00:01:05,004",
    "Directed by: Kim Han Min",
    "",
  ].join("\n");
  const cues = vttToCues(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 6);
  assert.equal(cues[0].end, 12.074);
  assert.equal(cues[0].text, "Advertise your product");
  assert.equal(cues[1].start, 62.004);
  assert.equal(cues[1].end, 65.004);
});

test("VTT: dot milliseconds, cue identifiers, inline tags", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:10.000 position:10%",
    "<b>Hello</b> <i>World</i>",
    "",
    "7",
    "01:02:03.450 --> 01:02:04.500",
    "second line here",
  ].join("\n");
  const cues = vttToCues(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].text, "Hello World");
  assert.equal(cues[1].start, 3723.45);
  assert.equal(cues[1].end, 3724.5);
  assert.equal(cues[1].text, "second line here");
});

test("short MM:SS timestamps", () => {
  const vtt = "WEBVTT\n\n01:30.500 --> 01:35.000\nmm:ss cue\n";
  const cues = vttToCues(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 90.5);
  assert.equal(cues[0].end, 95);
});

test("CRLF line endings + BOM", () => {
  const srt = "\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\ncrlf\r\n\r\n";
  const cues = vttToCues(srt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "crlf");
});

test("NOTE / STYLE blocks are skipped", () => {
  const vtt = [
    "WEBVTT",
    "",
    "NOTE this is a note",
    "still a note",
    "",
    "STYLE",
    "::cue { color: red }",
    "",
    "00:00:01.000 --> 00:00:02.000",
    "real cue",
  ].join("\n");
  const cues = vttToCues(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "real cue");
});

test("invalid / malformed cues are dropped, valid ones kept", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:10.000 --> 00:00:05.000",
    "inverted should drop",
    "",
    "garbage no timing here",
    "",
    "00:00:01.000 --> 00:00:02.000",
    "good cue",
  ].join("\n");
  const cues = vttToCues(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "good cue");
});

test("multi-line cue text is preserved", () => {
  const srt = "1\n00:00:01,000 --> 00:00:03,000\nline one\nline two\n";
  const cues = vttToCues(srt);
  assert.equal(cues[0].text, "line one\nline two");
});

// ---------------- cueAt ----------------

test("cueAt: finds the active cue by binary search", () => {
  const cues = vttToCues("WEBVTT\n\n00:00:01.000 --> 00:00:05.000\na\n\n00:00:10.000 --> 00:00:14.000\nb\n\n01:00:00.000 --> 01:00:05.000\nc\n");
  assert.equal(cueAt(cues, 3).text, "a");
  assert.equal(cueAt(cues, 12).text, "b");
  assert.equal(cueAt(cues, 3601).text, "c");
  assert.equal(cueAt(cues, 7), null); // gap
  assert.equal(cueAt([], 10), null);
  assert.equal(cueAt(cues, 0.5), null); // before first
});

// ---------------- subtitlesToCues (format routing) ----------------

test("subtitlesToCues: SRT without header still parses", () => {
  const srt = "1\n00:00:06,000 --> 00:00:12,074\nAdvertise here\n";
  const cues = subtitlesToCues(srt, "srt");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Advertise here");
});

test("subtitlesToCues: ASS/SSA yields no cues (styling not convertible)", () => {
  assert.deepEqual(subtitlesToCues("[Events]\\Dialogue: 0,0:00:01.00,0:00:02.00,,0,0,0,,hi", "ass"), []);
  assert.deepEqual(subtitlesToCues("[Events]", "ssa"), []);
});

test("subtitlesToCues: unknown format with WEBVTT content parses", () => {
  const cues = subtitlesToCues("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx\n", "");
  assert.equal(cues.length, 1);
});

// ---------------- detectSubtitleFormat + content-first routing ----------------
// ASS (Advanced SubStation Alpha) content is often shipped in a file named
// .srt — put.io then declares format "srt" and the VTT parser sees no
// "-->" in the Dialogue lines: zero or garbage cues. The CONTENT decides
// the parser; the declared format is only a hint.

const ASS_SAMPLE = [
  "[Script Info]",
  "Title: Frieren Fansub",
  "ScriptType: v4.00+",
  "WrapStyle: 0",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Default,M PLUS Rounded 1c,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:10.00,0:00:15.00,Default,,0,0,0,,Hello {\\pos(320,20)} world",
  "Dialogue: 0,0:00:20.50,0:00:25.00,Default,,0,0,0,,Line one\\NLine two, with commas",
  "Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,,not a cue",
].join("\n");

test("detect: an ASS file (the [Script Info] header) is recognised", () => {
  assert.equal(detectSubtitleFormat(ASS_SAMPLE), "ass");
});

test("detect: classic SSA (ScriptType v4.00) is the same family", () => {
  const ssa = ASS_SAMPLE.replace("ScriptType: v4.00+", "ScriptType: v4.00");
  assert.equal(detectSubtitleFormat(ssa), "ass");
});

test("detect: VTT and SRT are not misread as ASS", () => {
  assert.equal(detectSubtitleFormat("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx\n"), "vtt");
  assert.equal(detectSubtitleFormat("1\n00:00:06,000 --> 00:00:12,074\nAdvertise here\n"), "srt");
});

test("the mislabel: ASS content declared as .srt still parses (content wins)", () => {
  const cues = subtitlesToCues(ASS_SAMPLE, "srt");
  assert.deepEqual(cues, [
    { start: 10, end: 15, text: "Hello world" },
    { start: 20.5, end: 25, text: "Line one\nLine two, with commas" },
  ]);
});

test("declared-ass content that is really SRT still parses (the reverse mislabel)", () => {
  const cues = subtitlesToCues("1\n00:00:06,000 --> 00:00:12,074\nAdvertise here\n", "ass");
  assert.deepEqual(cues, [{ start: 6, end: 12.074, text: "Advertise here" }]);
});

test("loadSubtitle: an ASS file (any declared format) parses to cues and ships no pseudo-VTT blob", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => ASS_SAMPLE });
  try {
    const src = await loadSubtitle("https://example.test/sub.srt", "srt");
    assert.ok(src, "the subtitle must load");
    assert.equal(src.cues.length, 2);
    assert.equal(src.cues[1].text, "Line one\nLine two, with commas");
    assert.equal(src.blobURL, undefined, "native <track> cannot render ASS — no garbage pseudo-VTT");
  } finally {
    globalThis.fetch = realFetch;
  }
});
