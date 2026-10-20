// ASS-quality subtitle rendering — outer acceptance test.
//
// The complaint (user): "we are not doing a great job rendering subs,
// especially when it comes to ASS and position and colour". The stated goal:
// "parse ASS subtitle instructions correctly" — colours, positions and fonts
// must come from PARSING the file's instructions (style table + Dialogue
// fields + inline override tags), never from assumptions.
//
// Data paths (documented in the design):
//   T1  put.io's SRT file  — only {\anN} survives their conversion; the
//       Style: field and all other tags are dropped upstream of us.
//   T2  T1 + the file's [V4+ Styles] tables (in the first ~64 KB of the
//       MKV — the same bounded probe the chapters feature uses).
//   T3  raw ASS demuxed from the MKV (full fidelity; data path deferred,
//       but the PARSER this feature builds must already be correct against
//       it — the fixtures below are real Dialogue lines from that file).
//
// Resolution chain per property: inline override tag > Dialogue field
// (Style: list, margins) > style table > built-in default.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { subtitlesToCues } from "../src/putio/subs.ts";
import {
  parseAssColor,
  parseAssAlpha,
  parseAssStyles,
  parseAssCues,
  renderSubtitleLines,
} from "../src/putio/substyle.ts";
import { probeHeader } from "../src/putio/probe.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");

// REAL fixtures, from the user's file (Kusuriya no Hitorigoto S03E03 —
// the exact file whose MPV frame the user screenshotted):
const ASS_HEAD = read("fixtures/kusuriya-eng-ass-head.txt"); // [Script Info] + [V4+ Styles]
const ASS_SUBSET = read("fixtures/kusuriya-eng-ass-subset.txt"); // real [V4+ Styles] + real Dialogue lines
const SCENE_SRT = read("fixtures/kusuriya-scene-cues.srt"); // put.io's SRT, cues 1..12
const HEAD64K = new Uint8Array(
  readFileSync(join(here, "fixtures/kusuriya-head-64k.bin"))
);

const rangeRead = (start, end) => Promise.resolve(HEAD64K.slice(start, end + 1));

// ------------------------------------------------------------- 1. colour in
test("parseAssColor: &HAABBGGRR& is byte-order swizzled to RGB (the file's gold)", () => {
  assert.deepEqual(parseAssColor("&H007FD3F2&"), [242, 211, 127]);
});

test("parseAssColor: the 6-digit form is &HBBGGRR& with implicit alpha 0", () => {
  assert.deepEqual(parseAssColor("&HFFFFFF&"), [255, 255, 255]);
  assert.deepEqual(parseAssColor("&H000000&"), [0, 0, 0]);
  assert.deepEqual(parseAssColor("&H00FFFFFF&"), [255, 255, 255]);
});

test("parseAssAlpha: &HNN& raw alpha, 0=opaque → 255=fully transparent", () => {
  assert.equal(parseAssAlpha("&H00&"), 0);
  assert.equal(parseAssAlpha("&HFF&"), 255);
  assert.equal(parseAssAlpha("&H56&"), 86);
});

// --------------------------------------------------------- 2. style table
test("parseAssStyles: the real header is PlayRes 640x360 with the 12 English styles", () => {
  const table = parseAssStyles(ASS_HEAD);
  assert.ok(table, "the header must parse into a style table");
  assert.equal(table.info.playResX, 640);
  assert.equal(table.info.playResY, 360);
  assert.equal(table.styles.length, 12);
});

test("parseAssStyles: the 'overlaptop' style keeps its parsed colour, outline and top alignment", () => {
  const s = parseAssStyles(ASS_HEAD).styles.find((x) => x.name === "overlaptop");
  assert.ok(s, "the 'overlaptop' style must be present");
  assert.equal(s.fontname, "Trebuchet MS");
  assert.equal(s.fontsize, 24);
  assert.deepEqual(s.primary, [242, 211, 127]);
  assert.deepEqual(s.outlineColor, [0, 0, 0]);
  assert.equal(s.outlineW, 2);
  assert.equal(s.shadow, 1);
  assert.equal(s.alignment, 8);
});

test("parseAssStyles: ASS booleans use -1 for true (the 'italics' style is italic)", () => {
  const s = parseAssStyles(ASS_HEAD).styles.find((x) => x.name === "italics");
  assert.ok(s);
  assert.ok(s.italic, "Italic=-1 must parse as italic: true");
  const d = parseAssStyles(ASS_HEAD).styles.find((x) => x.name === "Default");
  assert.ok(!d.italic, "Italic=0 must parse as not italic");
});

test("parseAssStyles: margins survive (Ep_Title: align 3, marginV 56, Times New Roman 20)", () => {
  const s = parseAssStyles(ASS_HEAD).styles.find((x) => x.name === "Ep_Title");
  assert.ok(s);
  assert.equal(s.alignment, 3);
  assert.equal(s.marginV, 56);
  assert.equal(s.fontname, "Times New Roman");
  assert.equal(s.fontsize, 20);
});

test("parseAssStyles: text without a [V4+ Styles] section → null", () => {
  assert.equal(parseAssStyles("plain srt text"), null);
  assert.equal(parseAssStyles(""), null);
});

test("parseAssStyles tolerates CRLF line endings (real MKV CodecPrivate uses CR-LF)", () => {
  const crlf = [
    "[Script Info]",
    "Title: [Erai-raws]",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "PlayResX: 640",
    "PlayResY: 360",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Trebuchet MS,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1",
  ].join("\r\n") + "\r\n";
  const t = parseAssStyles(crlf);
  assert.ok(t, "the CRLF header must still parse");
  assert.equal(t.info.playResX, 640);
  assert.equal(t.info.playResY, 360);
  assert.ok(t.info.scaledBorderAndShadow);
  assert.equal(t.styles.length, 1);
  assert.equal(t.styles[0].name, "Default");
});

test("parseAssCues tolerates CRLF line endings (the cue text must not keep a trailing CR)", () => {
  const crlf = [
    "[Script Info]",
    "PlayResX: 640",
    "PlayResY: 360",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Trebuchet MS,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:01:43.71,0:01:44.68,Default,,0,0,0,,Open up!",
  ].join("\r\n") + "\r\n";
  const cues = parseAssCues(crlf);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Open up!");
});

// ------------------------------------------------- 3. Dialogue line parsing
test("a plain Dialogue line: the 'Open up!' cue carries its Style: field (overlaptop), not a guessed colour", () => {
  const cues = parseAssCues(ASS_SUBSET);
  const c = cues.find((x) => x.text === "Open up!");
  assert.ok(c, "the real 'Open up!' line must parse");
  assert.equal(c.start, 103.71, "0:01:43.71 is h:mm:ss.cc (centiseconds)");
  assert.equal(c.end, 104.68);
  assert.equal(c.styleName, "overlaptop");
});

test("text containing commas is not split (only the first 9 commas are field separators)", () => {
  const cues = parseAssCues(ASS_SUBSET);
  const c = cues.find((x) => x.text.includes("streets"));
  assert.ok(c, "the 'White Lady?' line must parse");
  assert.ok(c.text.includes("streets, occasionally"), "the comma inside the text must survive");
});

test("\\N becomes a line break in the cue text", () => {
  const cues = parseAssCues(ASS_SUBSET);
  const c = cues.find((x) => x.text.includes("took care"));
  assert.ok(c);
  assert.ok(c.text.includes("took care \nof those things"));
});

test("italic toggles: style state + inline \\i0/\\i1 produce per-segment segments that persist across \\N", () => {
  const cues = parseAssCues(ASS_SUBSET);
  const c = cues.find((x) => x.text.includes("Plants") && x.text.includes("stronghold"));
  assert.ok(c, "the 'I read the Plants book' line must parse");
  assert.ok(Array.isArray(c.segments), "mixed-italic text must keep its segments");
  const segs = c.segments;
  assert.equal(segs[0].text, "I read the ");
  assert.ok(segs[0].italic, "the 'italics' style sets italic, so the first segment is italic");
  assert.equal(segs[1].text, "Plants");
  assert.ok(!segs[1].italic, "\\i0 switches italic off for this segment");
  assert.ok(segs[2].text.startsWith(" book "), "the rest is one segment");
  assert.ok(segs[2].italic, "\\i1 switches italic back on (state persists to end of cue)");
});

test("mid-line colour override: the 'Diaries' segment is black, invisible fill, white 86-alpha shadow", () => {
  const cues = parseAssCues(ASS_SUBSET);
  const c = cues.find(
    (x) => x.text === "The Apothecary Diaries" && x.segments && x.segments.length > 1
  );
  assert.ok(c, "the two-segment title line must parse");
  const diaries = c.segments[1];
  assert.equal(diaries.text, "Diaries");
  assert.deepEqual(diaries.color, [0, 0, 0], "\\c&H000000& overrides the style's white");
  assert.equal(diaries.alpha, 0, "\\1a&H00& = opaque fill");
  assert.equal(diaries.outlineW, 1, "\\bord1 overrides the style's outline 2");
  assert.deepEqual(diaries.shadowColor, [255, 255, 255], "\\3c&HFFFFFF&");
  assert.equal(diaries.shadowAlpha, 86, "\\3a&H56&");
  // the first segment kept the style's alpha override from its own block
  assert.equal(c.segments[0].alpha, 255, "\\1a&HFF& from the leading block applies to 'The Apothecary '");
});

test("unknown motion tags (\\fad \\blur \\clip \\t \\frx \\fry \\fax) parse away without breaking the cue", () => {
  const cues = parseAssCues(ASS_SUBSET);
  const c = cues.find((x) => x.text === "White Lady" && x.styleName === "sign_20473_197_White_Lady");
  assert.ok(c, "the rotated-sign line must still parse");
  assert.equal(c.text, "White Lady");
});

test("\\pos(x,y) lands on the cue in PlayRes units; \\fs overrides the style size", () => {
  const cues = parseAssCues(ASS_SUBSET);
  const c = cues.find((x) => x.text === "Insects: Vol. Two");
  assert.ok(c);
  assert.deepEqual(c.pos, { x: 283, y: 106 });
  assert.equal(c.fontSize, 12, "\\fs12 inline overrides the style's 8");
});

test("layered cues at the same timestamp both survive (the title card is layer 0 + layer 1)", () => {
  const cues = parseAssCues(ASS_SUBSET);
  const atTitle = cues.filter((x) => x.start === 6.4);
  assert.ok(atTitle.length >= 2, "both title-card layers must parse");
  const layers = atTitle.map((x) => x.layer).sort();
  assert.deepEqual(layers, [0, 1]);
});

// ------------------------------------------------- 4. rendered lines (THE core)
const BOX = { w: 1920, h: 1080 };
const ASS_CUES = parseAssCues(ASS_SUBSET);
const TABLE = parseAssStyles(ASS_HEAD);
const assAt = (t) => ASS_CUES.filter((c) => t >= c.start && t <= c.end);

test("the MPV scene (raw-ASS path): both top lines render from their PARSED styles — gold 'Open up!', white reply, outlined, Trebuchet 72px at 1080p", () => {
  const table = parseAssStyles(ASS_HEAD);
  const lines = renderSubtitleLines(assAt(103.8), 103.8, table, BOX, 1);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.text), ["Open up!", "What's going on? It's so early."]);
  const [gold, white] = lines;
  assert.deepEqual(gold.color, "rgb(242, 211, 127)", "resolved via Style: overlaptop → PrimaryColour — parsed, not assumed");
  assert.deepEqual(white.color, "rgb(255, 255, 255)", "resolved via Style: top");
  for (const l of lines) {
    assert.equal(l.align, 8, "top-centre, as the styles say");
    assert.equal(l.fontFamily, "Trebuchet MS");
    assert.equal(l.fontSizePx, 72, "24 on PlayRes 360 → 72 on 1080p");
    assert.equal(l.outlinePx, 6, "outline 2 scaled 3x");
    assert.equal(l.shadowPx, 3, "shadow 1 scaled 3x");
    assert.equal(l.outlineColor, "rgb(0, 0, 0)");
  }
});

test("the SRT path (T2): put.io lost the Style: field — an \\an8 cue maps to the FIRST align-8 style (documented loss)", () => {
  const table = parseAssStyles(ASS_HEAD);
  const srtCues = subtitlesToCues(SCENE_SRT, "srt").filter(
    (c) => 103.8 >= c.start && 103.8 <= c.end
  );
  const lines = renderSubtitleLines(srtCues, 103.8, table, BOX, 1);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.equal(l.align, 8, "the \\an8 position must survive the SRT path");
    assert.equal(l.color, "rgb(255, 255, 255)", "first align-8 style is 'top' (white)");
  }
});

test("\\pos scales PlayRes → video box: (283,106) on 640x360 → (849,318) px on 1920x1080", () => {
  const table = parseAssStyles(ASS_HEAD);
  const lines = renderSubtitleLines(assAt(936.0), 936.0, table, BOX, 1);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].pos, { xPx: 849, yPx: 318 });
  assert.equal(lines[0].fontSizePx, 36, "the \\fs12 override, scaled 3x");
});

test("the user's subtitle-size setting scales rendered lines (1.5x → 108px for the 24px Default style)", () => {
  const table = parseAssStyles(ASS_HEAD);
  const lines = renderSubtitleLines(assAt(853.0), 853.0, table, BOX, 1.5);
  // the Default-style cue at 14:12.72–14:13.87 (The "White Lady".)
  assert.equal(lines.length, 1);
  assert.equal(lines[0].fontSizePx, 108); // 24 * 3 (box) * 1.5 (user)
});

test("per-segment styling reaches the descriptor (italic 'She' inside a Default line)", () => {
  const table = parseAssStyles(ASS_HEAD);
  const lines = renderSubtitleLines(assAt(1097.6), 1097.6, table, BOX, 1);
  assert.equal(lines.length, 1);
  const segs = lines[0].segments;
  const she = segs.find((s) => s.text === "She");
  assert.ok(she, "the italic 'She' segment must survive to the render descriptors");
  assert.ok(she.italic);
});

test("no style table (probe failed / non-MKV source): cues still render with defaults, never throw", () => {
  const lines = renderSubtitleLines(assAt(103.8), 103.8, null, BOX, 1);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].align, 8, "the parsed alignment survives without a table");
  assert.ok(/rgb\(/.test(lines[0].color));
});

// ------------------------------------- 4b. collision stacking (the MPV scene)
// Two cues starting at the same instant share the same top-centre anchor.
// libass (and the browser's native cue renderer) pushes the second one down
// one line so both stay readable — the MPV frame shows gold over white, not
// gold inside white. The renderer must do the same.
test("stacking: simultaneous top-centre cues stack like MPV (gold over white, no overlap)", () => {
  const lines = renderSubtitleLines(assAt(103.8), 103.8, TABLE, BOX, 1);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "Open up!", "file order: the gold cue is first → it sits on top");
  assert.equal(lines[0].yOffsetPx, 0, "the first live cue in a cell sits at the anchor");
  assert.ok(lines[1].yOffsetPx > 0, "the second simultaneous cue is pushed down");
  // "Open up!" is one line at 72px (24pt × 3 boxScale) → one line of space ≈ 72 × 1.4
  assert.ok(Math.abs(lines[1].yOffsetPx - 100.8) < 0.1, `≈ one line of space, got ${lines[1].yOffsetPx}`);
});

test("stacking: a cue that does not overlap in time gets no offset", () => {
  const a = { start: 100, end: 101, text: "A", align: 8, fontSize: 40 };
  const b = { start: 102, end: 103, text: "B", align: 8, fontSize: 40 };
  const lines = renderSubtitleLines([a, b], 100.5, null, BOX, 1);
  assert.deepEqual(lines.map((l) => l.yOffsetPx), [0, 0]);
});

test("stacking: different anchor cells never offset each other", () => {
  const a = { start: 100, end: 102, text: "A", align: 8, fontSize: 40 };
  const b = { start: 100, end: 102, text: "B", align: 2, fontSize: 40 };
  const lines = renderSubtitleLines([a, b], 100.5, null, BOX, 1);
  assert.deepEqual(lines.map((l) => l.yOffsetPx), [0, 0]);
});

test("stacking: bottom-anchored cues push UP (negative offset)", () => {
  const a = { start: 100, end: 102, text: "A", align: 2, fontSize: 40 };
  const b = { start: 100, end: 102, text: "B", align: 2, fontSize: 40 };
  const lines = renderSubtitleLines([a, b], 100.5, null, BOX, 1);
  assert.equal(lines[0].yOffsetPx, 0);
  assert.ok(lines[1].yOffsetPx < 0, "the second bottom cue moves up, not down");
  // 40 PlayRes units × 3.75 boxScale (no table → 288 default) = 150px → one line of space = 150 × 1.4
  assert.ok(Math.abs(Math.abs(lines[1].yOffsetPx) - 210) < 0.1, `one line of space, got ${lines[1].yOffsetPx}`);
});

test("stacking: a two-line cue reserves two lines of space for the next", () => {
  const a = { start: 100, end: 102, text: "line one\nline two", align: 8, fontSize: 40 };
  const b = { start: 100, end: 102, text: "C", align: 8, fontSize: 40 };
  const lines = renderSubtitleLines([a, b], 100.5, null, BOX, 1);
  assert.ok(Math.abs(lines[1].yOffsetPx - 420) < 0.1, `150 × 1.4 × 2 lines, got ${lines[1].yOffsetPx}`);
});

// ------------------------------------------------- 5. the bounded header probe
test("probeHeader: the real 64 KB header yields the 10 per-track ASS style tables", async () => {
  const result = await probeHeader(rangeRead);
  assert.ok(Array.isArray(result.styleTables));
  assert.equal(result.styleTables.length, 10, "the file has 10 ASS subtitle tracks");
  const eng = result.styleTables[0];
  const gold = eng.styles.find((s) => s.name === "overlaptop");
  assert.ok(gold, "the English track's gold style must be in the probed tables");
  assert.deepEqual(gold.primary, [242, 211, 127]);
  assert.equal(eng.info.playResX, 640);
  assert.equal(result.chapters.length, 4, "the file has 4 chapters");
  assert.deepEqual(
    result.chapters.map((c) => [c.start, c.end, c.title]),
    [
      [0, 90, "Intro"],
      [90, 1350, "Episode"],
      [1350, 1420, "Credits"],
      [1420, 1440, "Episode"],
    ],
    "chapter times are scaled ticks → seconds, titles from ChapterDisplay"
  );
});

test("probeHeader: stops cleanly when the window ends mid-Attachments (no hang, data kept)", async () => {
  const result = await probeHeader(rangeRead);
  assert.ok(result, "a partial probe still returns a result");
});

// ------------------------------------------------- 6. Player / engine wiring
test("the overlay renders per line from renderSubtitleLines (the flat blob is gone)", () => {
  const player = read("../src/ui/screens/Player.svelte");
  assert.ok(/renderSubtitleLines/.test(player), "the Player must consume the render descriptors");
  assert.ok(
    /{#each[^}]*[Ll]ines[^}]*}[\s\S]{0,400}?style=/.test(player),
    "each rendered line needs its own style binding"
  );
  assert.ok(
    !/class="subs-cues"[\s\S]{0,80?}\{subText\}/.test(player),
    "the old single flat subText div must be gone"
  );
});

test("the engine runs the header probe on the original stream", () => {
  const media = read("../src/putio/media.ts");
  assert.ok(/probeHeader/.test(media), "MediaEngine must call probeHeader");
});
