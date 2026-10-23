// OUTER LOOP — ASS motion engine, pinned by the Kusuriya title card.
//
// The engine is general (any cue, any \fad/\move/\t/clip combination); the
// pinned fixture is the acceptance anchor: the two title-card Dialogue lines
// of "The Apothecary Diaries" S3E3 (track 3, CR_English, verbatim from the
// file's CodecPrivate), which MPV renders as a white clip-reveal sweep of
// "The Apothecary Diaries" plus a blurred transparent ghost line whose
// "Diaries" segment is black with a soft white outline.
//
// Public path under test: parseAssCues/parseAssStyles →
// renderSubtitleLines(cues, t, table, box, scale) → RenderedLine.motionFrame
// at each sample time. The last three (synthetic) Dialogue lines extend the
// same engine path with tags the title card does not use (\move, a \t whose
// only effect is a nested \pos) so the contract is not fixture-shaped.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import {
  parseAssCues,
  parseAssStyles,
  renderSubtitleLines,
} from "../src/putio/substyle.ts";

// --- the pinned fixture -----------------------------------------------------
const FIXTURE = `[Script Info]
Title: [Erai-raws]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Times New Roman,22,&H00FFFFFF,&H000000FF,&H001F38B6,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,8,18,18,18,0
Style: Default,Trebuchet MS,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,18,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:06.40,0:00:13.53,Title,Text,0,0,0,,{\\fad(439,436)\\bord0\\clip(210,14.714,357.572,44)\\t(773,4485,\\clip(210,15,430,44))}The Apothecary Diaries
Dialogue: 1,0:00:06.40,0:00:13.53,Title,Text,0,0,0,,{\\fad(0,436)\\blur3\\1a&HFF&\\clip(210,15,211,44)\\t(400,4902,\\clip(210,15,430,44))}The Apothecary {\\bord1\\blur2\\c&H000000&\\1a&H00&\\3c&HFFFFFF&\\3a&H56&}Diaries
Dialogue: 2,0:01:00.00,0:01:05.00,Default,Text,0,0,0,,{\\fad(500,500)\\move(100,300,500,60,1000,3000)}Moving line
Dialogue: 3,0:02:00.00,0:02:04.00,Default,Text,0,0,0,,{\\pos(0,0)\\t(0,1000,\\pos(100,200))\\fad(0,0)}Static pos with nested pos
Dialogue: 4,0:03:00.00,0:03:04.00,Default,Text,0,0,0,,{\\t(0,1000,\\pos(100,200))}Nested pos only
`;

// box 1280×720 over PlayRes 640×360 → uniform scale 2
const BOX = { w: 1280, h: 720 };
const S = BOX.h / 360;
const CUES = parseAssCues(FIXTURE);
const TABLE = parseAssStyles(FIXTURE);

/** Render the cues active at absolute time t (seconds); layer order preserved. */
function linesAt(tSec) {
  const act = CUES.filter((c) => c.start <= tSec && tSec < c.end);
  return renderSubtitleLines(act, tSec, TABLE, BOX, 1);
}

const clipPx = (c) => [c.top, c.right, c.bottom, c.left].map((v) => Math.round(v * 100) / 100);

// --- cue A: white solid title, clip-reveal sweep (layer 0 → index 0) --------

test("cue A fades in over its first 439 ms", () => {
  assert.equal(linesAt(6.4).length, 2, "both title-card cues live at t=6.4s");
  const a = linesAt(6.4)[0];
  assert.equal(a.motionFrame.opacityMul, 0, "fully transparent at cue start");
  assert.ok(Math.abs(linesAt(6.62)[0].motionFrame.opacityMul - 220 / 439) < 0.002,
    `mid-fade at 220 ms → ${linesAt(6.62)[0].motionFrame.opacityMul}`);
  assert.equal(linesAt(6.839)[0].motionFrame.opacityMul, 1, "opaque once the fade-in completes");
});

test("cue A holds opaque, then fades out over its last 436 ms", () => {
  assert.equal(linesAt(10.0)[0].motionFrame.opacityMul, 1);
  assert.equal(linesAt(13.094)[0].motionFrame.opacityMul, 1, "fade-out starts exactly at end−436 ms");
  assert.ok(Math.abs(linesAt(13.312)[0].motionFrame.opacityMul - 0.5) < 0.002, "half-faded at end−218 ms");
  assert.ok(linesAt(13.5299)[0].motionFrame.opacityMul < 0.01, "fade ~99.98% done 0.1 ms before the end");
});

test("cue A's clip window is static before its \\t, then sweeps right", () => {
  // PlayRes rect (210,14.714,357.572,44) — libass truncates clip coordinates
  // to ints (argtoi32): (210,14,357,44) → box px: top y1·S, left x1·S,
  // right (640−x2)·S, bottom (360−y2)·S
  const before = linesAt(6.5)[0].motionFrame.clip;
  assert.deepEqual(clipPx(before), [14 * S, (640 - 357) * S, (360 - 44) * S, 210 * S],
    "untouched truncated window before the \\t starts at 773 ms");
  const mid = linesAt(6.4 + 2.629)[0].motionFrame.clip; // \\t(773,4485) midpoint, f=0.5
  assert.ok(Math.abs(mid.right - (640 - (357 + (430 - 357) / 2)) * S) < 0.01,
    `clip right edge lerps: ${mid.right}`);
  assert.ok(Math.abs(mid.top - 14.5 * S) < 0.01, `top lerps 14→15: ${mid.top}`);
  const done = linesAt(10.885)[0].motionFrame.clip; // \\t end at 4485 ms
  assert.ok(Math.abs(done.right - (640 - 430) * S) < 0.01, "window fully open at \\t end");
  assert.ok(Math.abs(done.top - 15 * S) < 0.01, "top settles on 15, not 14.714");
  assert.deepEqual(clipPx(linesAt(13.0)[0].motionFrame.clip), clipPx(done),
    "the window holds after the \\t completes");
});

// --- cue B: blurred ghost line; "Diaries" segment (layer 1 → index 1) -------

test("cue B has no fade-in, fades out over its last 436 ms", () => {
  assert.equal(linesAt(6.4)[1].motionFrame.opacityMul, 1, "\\fad(0,·) → visible from frame one");
  assert.ok(Math.abs(linesAt(13.312)[1].motionFrame.opacityMul - 0.5) < 0.002);
  assert.ok(linesAt(13.5299)[1].motionFrame.opacityMul < 0.01);
});

test("cue B's clip starts as a 1-px sliver and opens with its own \\t window", () => {
  const t0 = linesAt(6.5)[1].motionFrame.clip; // before 400 ms
  assert.ok(Math.abs(t0.right - (640 - 211) * S) < 0.01, "sliver: x2 still 211");
  const mid = linesAt(6.4 + 2.651)[1].motionFrame.clip; // \\t(400,4902) midpoint
  assert.ok(Math.abs(mid.right - (640 - (211 + (430 - 211) / 2)) * S) < 0.01,
    `mid-sweep right edge: ${mid.right}`);
  assert.ok(Math.abs(linesAt(11.302)[1].motionFrame.clip.right - (640 - 430) * S) < 0.01,
    "fully open at \\t end (4902 ms)");
});

// libass's \\blur R is a Gaussian RADIUS, and its kernel is scaled by
// 2/sqrt(ln 256) (ass_render.c blur_radius_scale) — CSS blur() takes the
// standard deviation, so the rendered value is R x 0.8493, not R.
const BLUR_SIGMA = 2 / Math.sqrt(Math.log(256));

test("cue B's blur is per segment (ghost \\blur3, Diaries \\blur2)", () => {
  const b = linesAt(6.4)[1];
  assert.equal(b.blurPx, 0, "no single line-level filter when the segments differ");
  assert.ok(Math.abs(b.segments[0].blurPx - 3 * S * BLUR_SIGMA) < 0.01, "ghost text keeps \\blur3 as a sigma");
  assert.ok(Math.abs(b.segments[1].blurPx - 2 * S * BLUR_SIGMA) < 0.01, "Diaries gets its \\blur2 as a sigma");
  assert.equal(linesAt(6.4)[0].blurPx, 0, "cue A carries no \\blur");
});

test("stroke layer: only outlined lines carry hasStroke", () => {
  assert.equal(linesAt(6.4)[0].hasStroke, false, "cue A is \\bord0 — no stroke layer");
  assert.equal(linesAt(6.4)[1].hasStroke, true, "cue B has the Title style's outline 2");
});

test("the 'Diaries' segment stays visible while the line's other half is transparent", () => {
  // \\1a&HFF& on the line makes "The Apothecary " invisible; the Diaries
  // segment resets \\1a&H00& — the element opacity must not zero the second
  // half (MPV shows black 'Diaries' with a soft white outline).
  const b = linesAt(9.0)[1];
  assert.ok(b.segments.length >= 2, `expected two segments, got ${b.segments.length}`);
  const apothecary = b.segments[0];
  const diaries = b.segments.find((s) => s.text.includes("Diaries"));
  assert.ok(diaries, "Diaries segment present");
  assert.equal(apothecary.opacity, 0, "transparent half of the ghost");
  assert.equal(diaries.opacity, 1, "opaque Diaries");
  assert.equal(diaries.color, "rgb(0, 0, 0)", "black primary (\\c&H000000&)");
  assert.equal(b.opacity, 1,
    "the line's element opacity stays 1 — per-segment alpha carries the visibility");
});

// --- general contract: \\move and \\t animating \\pos ------------------------

test("\\move animates the line's position between its own t1/t2, holding at the ends", () => {
  const l0 = linesAt(60.0)[0]; // cue start: before t1 (1000 ms)
  assert.ok(l0.motionFrame.pos, "\\move implies a per-frame position");
  assert.equal(l0.motionFrame.pos.xPx, 100 * S);
  assert.equal(l0.motionFrame.pos.yPx, 300 * S);
  const lMid = linesAt(60 + 2.0)[0]; // mid of [1000, 3000] → rel 2000 ms
  assert.equal(lMid.motionFrame.pos.xPx, (100 + (500 - 100) / 2) * S);
  assert.equal(lMid.motionFrame.pos.yPx, (300 + (60 - 300) / 2) * S);
  const lEnd = linesAt(60 + 4)[0]; // after t2 (3000 ms)
  assert.equal(lEnd.motionFrame.pos.xPx, 500 * S);
  assert.equal(lEnd.motionFrame.pos.yPx, 60 * S);
});

test("a \\t containing \\pos does not tween: libass keeps the first \\pos static", () => {
  // libass never interpolates \pos — the first \pos/\move in text order owns
  // the position for the whole cue (verified against libass 0.17.5).
  for (const t of [120.0, 120.5, 121.5]) {
    const l = linesAt(t)[0];
    assert.equal(l.motionFrame.pos.xPx, 0, `x stays 0 at rel ${t - 120}s`);
    assert.equal(l.motionFrame.pos.yPx, 0, `y stays 0 at rel ${t - 120}s`);
  }
});

test("a \\t with only a nested \\pos: that \pos is the first, so it is static too", () => {
  for (const t of [180.0, 180.5, 181.5]) {
    const l = linesAt(t)[0];
    assert.equal(l.motionFrame.pos.xPx, 100 * S);
    assert.equal(l.motionFrame.pos.yPx, 200 * S);
  }
});

test("\\t's target values are clamped to their windows (no negative progress)", () => {
  // before the \\t window the FROM value holds — checked on cue A above via
  // the untouched clip; here the move cue before its t1 keeps (100, 300)·S
  const l = linesAt(60 + 0.2)[0];
  assert.equal(l.motionFrame.pos.xPx, 100 * S);
  assert.equal(l.motionFrame.pos.yPx, 300 * S);
});

test("fades with zero duration are no-ops (\\fad(0,0))", () => {
  assert.equal(linesAt(120.0)[0].motionFrame.opacityMul, 1);
  assert.equal(linesAt(123.99)[0].motionFrame.opacityMul, 1);
});
