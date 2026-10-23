// INNER LOOP — parsing override tags into a MotionSpec (src/putio/substyle.ts).
//
// Fixture-free unit tests: each builds a minimal ASS doc with one Dialogue
// line carrying the tag combination under test. The rules being pinned are
// libass's (ass_parse.c):
//  • \clip coordinates truncate to ints (argtoi32)
//  • \t argument-count: 2 numbers = t1, t2; 1 = ACCEL over the whole cue;
//    none = whole cue linear; 3 = t1, t2, accel; >3 numbers = no-op
//  • \pos / \move: first in text order owns the position (both directions);
//    a \pos inside a \t is a plain first-wins \pos (libass never tweens \pos)
//  • \fad: first \fad wins (PARSED_FADE)
//  • \t-clip with no static \clip: the from-window is the full PlayRes rect
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import { parseAssCues } from "../src/putio/substyle.ts";

const STYLE = `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Title,Times New Roman,22,&H00FFFFFF,&H000000FF,&H001F38B6,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,8,18,18,18,0`;

const doc = (dialogue) => `[Script Info]
PlayResX: 640
PlayResY: 360

[V4+ Styles]
${STYLE}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogue}
`;

const cueWith = (text) => {
  const cues = parseAssCues(doc(`Dialogue: 0,0:00:06.40,0:00:13.53,Title,Text,0,0,0,,${text}Hello`));
  assert.equal(cues.length, 1, "one cue parsed");
  return cues[0];
};

// --- \fad -------------------------------------------------------------------

test("\\fad(i, o) → motion.fad", () => {
  const c = cueWith("{\\fad(439,436)}");
  assert.deepEqual(c.motion?.fad, { in: 439, out: 436 });
});

test("\\fad(i) — one argument: a no-op (libass only honours the 2-arg form)", () => {
  const c = cueWith("{\\fad(439)}");
  assert.equal(c.motion, undefined);
});

test("first \\fad wins, later ones are ignored (libass PARSED_FADE)", () => {
  const c = cueWith("{\\fad(100,100)\\fad(200,200)}");
  assert.deepEqual(c.motion?.fad, { in: 100, out: 100 });
});

// --- \clip -------------------------------------------------------------------

test("\\clip coordinates truncate to ints (libass argtoi32)", () => {
  const c = cueWith("{\\clip(210,14.714,357.572,44)}");
  assert.deepEqual(c.motion?.clip, [210, 14, 357, 44]);
});

// --- \t ----------------------------------------------------------------------

test("\\t(t1, t2, \\clip(…)) with a static \\clip before it", () => {
  const c = cueWith("{\\clip(210,14,357,44)\\t(773,4485,\\clip(210,15,430,44))}");
  assert.deepEqual(c.motion?.clip, [210, 14, 357, 44]);
  assert.deepEqual(c.motion?.ts, [{ t1: 773, t2: 4485, accel: 1, clip: [210, 15, 430, 44] }]);
});

test("\\t-clip with no static \\clip: the from-window is the full PlayRes rect", () => {
  const c = cueWith("{\\t(400,4902,\\clip(210,15,430,44))}");
  assert.deepEqual(c.motion?.clip, [0, 0, 640, 360], "injected full-rect base");
  assert.deepEqual(c.motion?.ts, [{ t1: 400, t2: 4902, accel: 1, clip: [210, 15, 430, 44] }]);
});

test("\\t(accel, \\clip(…)) — one number is an exponent over the whole cue", () => {
  const c = cueWith("{\\clip(0,0,100,100)\\t(2,\\clip(0,0,300,100))}");
  assert.deepEqual(c.motion?.ts, [{ t1: 0, t2: 0, accel: 2, clip: [0, 0, 300, 100] }]);
});

test("\\t(\\clip(…)) — no numbers: whole cue, linear", () => {
  const c = cueWith("{\\clip(0,0,100,100)\\t(\\clip(0,0,300,100))}");
  assert.deepEqual(c.motion?.ts, [{ t1: 0, t2: 0, accel: 1, clip: [0, 0, 300, 100] }]);
});

test("\\t(t1, t2, accel, \\clip(…)) — three numbers", () => {
  const c = cueWith("{\\clip(0,0,0,100)\\t(1000,2000,0.5,\\clip(0,0,200,100))}");
  assert.deepEqual(c.motion?.ts, [{ t1: 1000, t2: 2000, accel: 0.5, clip: [0, 0, 200, 100] }]);
});

test("\\t with more than 3 numbers is a no-op (libass skips the whole \\t)", () => {
  const c = cueWith("{\\clip(0,0,100,100)\\t(1,2,3,4,\\clip(0,0,200,100))}");
  assert.deepEqual(c.motion?.ts, [], "no \\t block at all — only the static clip");
  assert.deepEqual(c.motion?.clip, [0, 0, 100, 100], "the static clip still parsed");
});

test("\\t with numbers but no tag argument is a no-op", () => {
  const c = cueWith("{\\t(1000)}");
  assert.equal(c.motion, undefined, "nothing motion-shaped at all");
});

test("sequential \\t-clip blocks are kept in text order", () => {
  const c = cueWith("{\\clip(0,0,100,100)\\t(0,1000,\\clip(0,0,200,100))\\t(1000,2000,\\clip(0,0,300,100))}");
  assert.deepEqual(c.motion?.ts, [
    { t1: 0, t2: 1000, accel: 1, clip: [0, 0, 200, 100] },
    { t1: 1000, t2: 2000, accel: 1, clip: [0, 0, 300, 100] },
  ]);
});

// --- \pos / \move: first in text order owns the position ----------------------

test("\\pos: first wins", () => {
  const c = cueWith("{\\pos(10,20)\\pos(30,40)}");
  assert.deepEqual(c.pos, { x: 10, y: 20 });
  assert.deepEqual(c.motion?.pos, { x: 10, y: 20 });
});

test("\\pos before \\move: the \\pos wins, no move", () => {
  const c = cueWith("{\\pos(10,20)\\move(0,0,50,50)}");
  assert.deepEqual(c.pos, { x: 10, y: 20 });
  assert.equal(c.motion?.move, undefined);
});

test("\\move before \\pos: the \\move wins, no static pos", () => {
  const c = cueWith("{\\move(0,0,50,50,1000,2000)\\pos(10,20)}");
  assert.equal(c.pos, undefined);
  assert.deepEqual(c.motion?.move, { x1: 0, y1: 0, x2: 50, y2: 50, t1: 1000, t2: 2000 });
});

test("\\move without times: whole-cue move", () => {
  const c = cueWith("{\\move(0,0,50,50)}");
  assert.deepEqual(c.motion?.move, { x1: 0, y1: 0, x2: 50, y2: 50, t1: 0, t2: 0 });
});

test("\\move with t1 > t2: the times swap", () => {
  const c = cueWith("{\\move(0,0,50,50,2000,1000)}");
  assert.deepEqual(c.motion?.move, { x1: 0, y1: 0, x2: 50, y2: 50, t1: 1000, t2: 2000 });
});

test("\\t containing \\pos: a plain first-wins \\pos (libass never tweens \\pos)", () => {
  const c = cueWith("{\\t(0,1000,\\pos(100,200))}");
  assert.deepEqual(c.pos, { x: 100, y: 200 });
  assert.deepEqual(c.motion?.pos, { x: 100, y: 200 });
  assert.deepEqual(c.motion?.ts, [{ t1: 0, t2: 1000, accel: 1 }], "empty t-block: no clip target, but libass clears collision detection on any \\t");
});

test("static \\pos before \\t(…\\pos(…)): the outer \\pos wins", () => {
  const c = cueWith("{\\pos(5,5)\\t(0,1000,\\pos(100,200))}");
  assert.deepEqual(c.pos, { x: 5, y: 5 });
});

// --- \blur + no-motion ---------------------------------------------------------

test("\\blur → motion.blur (last wins)", () => {
  const c = cueWith("{\\blur3\\blur1.5}");
  assert.equal(c.motion?.blur, 1.5);
});

test("\\blur is captured per segment from the cumulative state", () => {
  // libass applies each glyph's blur from the state at that point: the ghost
  // text before the second block gets 3, the "hollow" text after it gets 2
  const c = cueWith("{\\blur3}ghost {\\blur2}hollow");
  assert.equal(c.segments?.[0].blur, 3);
  assert.equal(c.segments?.[1].blur, 2);
});

test("a segment with no \\blur tag keeps the cumulative value", () => {
  const c = cueWith("{\\blur2.5}one two");
  assert.equal(c.segments?.length, 1);
  assert.equal(c.segments?.[0].blur, 2.5);
});

test("a plain dialogue has no motion", () => {
  const c = cueWith("{}");
  assert.equal(c.motion, undefined);
  assert.equal(c.pos, undefined);
});

// --- coexistence with styling tags ----------------------------------------------

test("styling tags and motion tags in one block both parse", () => {
  const c = cueWith("{\\fad(439,436)\\bord0\\clip(210,14,357,44)\\1a&HFF&}");
  assert.deepEqual(c.motion?.fad, { in: 439, out: 436 });
  assert.deepEqual(c.motion?.clip, [210, 14, 357, 44]);
  const seg = c.segments?.[0];
  assert.equal(seg?.outlineW, 0, "styling still applied");
  assert.equal(seg?.alpha, 255, "\\1a&HFF& still parsed");
});
