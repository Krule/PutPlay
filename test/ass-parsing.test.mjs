// ASS/SSA (MKV-embedded subtitles) parsing.
//
// put.io serves MKV-container softsubs via /files/{id}/subtitles with
// source "mkv" — and MKV softsubs are usually ASS/SSA, not SRT. The old
// assToCues() returned [] for all of them, which is why "subtitles when
// playing the original video are not working properly".
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { assToCues, subtitlesToCues } from "../src/putio/subs.ts";

const SAMPLE = `[Script Info]
Title: Sample MKV
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:03.00,0:00:06.00,Default,,0,0,0,,Hello from the MKV container
Dialogue: 0,0:00:07.50,0:00:10.00,Default,,0,0,0, ,{\\pos(960,500)}Two\\Nline\\hSpace
Dialogue: 0,0:00:20.00,0:00:23.00,Default,,0,0,0,,Comma, in, the text
Dialogue: 0,0:00:30.00,0:00:33.00,Default,,0,0,0,,{\\fad(200,200)}
`;

test("assToCues parses Dialogue lines into timed cues", () => {
  const cues = assToCues(SAMPLE);
  assert.equal(cues.length, 3);
  assert.deepEqual(
    [cues[0].start, cues[0].end, cues[0].text],
    [3, 6, "Hello from the MKV container"]
  );
});

test("assToCues handles hours in timestamps and centisecond fractions", () => {
  const text =
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
    "Dialogue: 0,1:02:03.45,1:02:09.99,Default,,0,0,0,,Later cue\n";
  const cues = assToCues(text);
  assert.equal(cues.length, 1);
  assert.ok(Math.abs(cues[0].start - 3723.45) < 0.001, "start 1:02:03.45");
  assert.ok(Math.abs(cues[0].end - 3729.99) < 0.001, "end 1:02:09.99");
});

test("assToCues converts \\N to newline and \\h to space, strips override tags", () => {
  const cues = assToCues(SAMPLE);
  assert.equal(cues[1].text, "Two\nline Space");
  assert.equal(cues[1].start, 7.5);
});

test("assToCues keeps commas inside the text (text is the final field)", () => {
  const cues = assToCues(SAMPLE);
  assert.equal(cues[2].text, "Comma, in, the text");
});

test("assToCues skips empty-text dialogues, comments, and non-event lines", () => {
  // the 4th dialogue in SAMPLE is tag-only (no text) — must not produce a cue
  const cues = assToCues(SAMPLE);
  assert.ok(!cues.some((c) => c.start === 30), "tag-only dialogue skipped");
  // Style:/Format:/section lines must not be mistaken for dialogues
  assert.ok(cues.every((c) => c.text.length > 0), "no empty-text cues");
});

test("assToCues works without a Format line (classic SSA / v4.00 order)", () => {
  const text =
    "[V4 Styles]\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\n" +
    "Style: Default,Arial,20,&HFFFFFF,&H000000,&H000000,&H000000,0,0,1,1,0,8,10,10,10,0,0\n" +
    "[Events]\n" +
    "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,SSA cue\n";
  const cues = assToCues(text);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "SSA cue");
});

test("assToCues returns [] for non-ASS content or garbage", () => {
  assert.deepEqual(assToCues("WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n"), []);
  assert.deepEqual(assToCues("no sections here at all"), []);
  assert.deepEqual(assToCues(""), []);
});

test("subtitlesToCues routes ass/ssa formats to the ASS parser", () => {
  const cues = subtitlesToCues(SAMPLE, "ass");
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, "Hello from the MKV container");
  const ssa = subtitlesToCues(SAMPLE, "ssa");
  assert.equal(ssa.length, 3);
});
