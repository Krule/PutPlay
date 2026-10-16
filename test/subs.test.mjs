// Unit tests for the pure subtitle parser (src/putio/subs.ts).
// Run: pnpm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { vttToCues, cueAt, subtitlesToCues } from "../src/putio/subs.ts";

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
