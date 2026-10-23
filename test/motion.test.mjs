// INNER LOOP — the pure ASS motion evaluator (src/putio/motion.ts).
//
// All values are in PlayRes units; the renderer scales the frame to the
// video box. `relMs` = time since cue start, `durMs` = cue duration.
//
// Semantics are libass's (MPV's), verified against ass_parse.c:
//  • \fad(i, o) — piecewise: transparent → opaque over the first i ms,
//    opaque until end−o, → transparent over the last o ms. In overlapping
//    windows the fade-IN branch wins (branch order), the ramps do not mix.
//  • \clip(x1, y1, x2, y2) — a static window; \t blocks animate it with
//    pwr interpolation from the current (accumulated) window.
//  • \move(x1, y1, x2, y2 [, t1, t2]) — linear move; default whole cue.
//    The first \pos or \move in text order owns the position (the parser
//    resolves this — the evaluator sees exactly one of spec.pos/spec.move).
//  • \t — VSFilter argument-count rules: two leading numbers = t1, t2
//    (linear); one leading number = ACCEL exponent over the whole cue;
//    none = whole cue, linear; three = t1, t2, accel. k = pow(f, accel).
//    \pos is NOT animatable in libass (issue #886) — a \pos inside \t is
//    a plain first-wins \pos, resolved by the parser into spec.pos.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import { evalMotion, anyMotionActive } from "../src/putio/motion.ts";

const A = {
  fad: { in: 439, out: 436 },
  clip: [210, 14, 357, 44], // libass truncates \clip coordinates to ints
  ts: [{ t1: 773, t2: 4485, clip: [210, 15, 430, 44] }],
};
const DUR_A = 7130;

const close = (a, b, eps = 0.001) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// --- \fad -------------------------------------------------------------------

test("fad(439, 436): transparent at the start, ramping over 439 ms", () => {
  assert.equal(evalMotion(A, 0, DUR_A).opacityMul, 0);
  close(evalMotion(A, 220, DUR_A).opacityMul, 220 / 439, 0.002);
  close(evalMotion(A, 439, DUR_A).opacityMul, 1);
});

test("fad(439, 436): holds opaque, ramps down over the last 436 ms", () => {
  close(evalMotion(A, 6694, DUR_A).opacityMul, 1, 0.002); // end − 436
  close(evalMotion(A, 6912, DUR_A).opacityMul, 0.5, 0.002);
  close(evalMotion(A, DUR_A, DUR_A).opacityMul, 0, 0.0001);
});

test("fad(0, o): no fade-in; fade-out only", () => {
  const B = { fad: { in: 0, out: 436 }, ts: [] };
  assert.equal(evalMotion(B, 0, DUR_A).opacityMul, 1);
  close(evalMotion(B, 6912, DUR_A).opacityMul, 0.5, 0.002);
});

test("no fad and fad(0,0) are opacity no-ops", () => {
  assert.equal(evalMotion({ ts: [] }, 123, 4000).opacityMul, 1);
  assert.equal(evalMotion({ fad: { in: 0, out: 0 }, ts: [] }, 0, 4000).opacityMul, 1);
  assert.equal(evalMotion({ fad: { in: 0, out: 0 }, ts: [] }, 3999, 4000).opacityMul, 1);
});

test("overlapping \\fad windows: the fade-in branch wins (libass branch order)", () => {
  const F = { fad: { in: 1000, out: 1000 }, ts: [] };
  close(evalMotion(F, 250, 1000).opacityMul, 0.25, 0.002);
  close(evalMotion(F, 500, 1000).opacityMul, 0.5, 0.002);
  // past (end − out): a min()-model would dip back down — libass keeps the
  // fade-in branch (still below t2 = in) and stays rising
  close(evalMotion(F, 750, 1000).opacityMul, 0.75, 0.002);
  close(evalMotion(F, 1000, 1000).opacityMul, 0, 0.0001);
});

// --- \clip + \t-clip ----------------------------------------------------------

test("a static clip with no \\t holds for the whole cue", () => {
  const C = { clip: [210, 15, 430, 44], ts: [] };
  assert.deepEqual(evalMotion(C, 0, 4000).clip, [210, 15, 430, 44]);
  assert.deepEqual(evalMotion(C, 3999, 4000).clip, [210, 15, 430, 44]);
});

test("\\t-clip holds the from window before t1, lerps inside, holds after t2", () => {
  const before = evalMotion(A, 772, DUR_A).clip;
  assert.deepEqual(before, A.clip, "untouched 1 ms before the window opens");
  const mid = evalMotion(A, 2629, DUR_A).clip; // f = 0.5
  assert.deepEqual(mid, [210, 14.5, 393.5, 44]);
  const done = evalMotion(A, 4485, DUR_A).clip;
  assert.deepEqual(done, [210, 15, 430, 44], "fully open at t2");
  assert.deepEqual(evalMotion(A, 7129, DUR_A).clip, [210, 15, 430, 44], "held after t2");
});

test("\\t with no times spans the whole cue", () => {
  const C = { clip: [0, 0, 100, 100], ts: [{ clip: [0, 0, 300, 100] }] };
  close(evalMotion(C, 0, 1000).clip[2], 100, 0.0001); // holds the from value at t=0
  close(evalMotion(C, 500, 1000).clip[2], 200, 0.001);
  assert.deepEqual(evalMotion(C, 1000, 1000).clip, [0, 0, 300, 100]);
});

test("sequential \\t-clip blocks chain from the previous block's value", () => {
  const C = {
    clip: [0, 0, 100, 100],
    ts: [
      { t1: 0, t2: 1000, clip: [0, 0, 200, 100] },
      { t1: 1000, t2: 2000, clip: [0, 0, 300, 100] },
    ],
  };
  close(evalMotion(C, 500, 2500).clip[2], 150, 0.001);
  close(evalMotion(C, 1500, 2500).clip[2], 250, 0.001);
  close(evalMotion(C, 2500, 2500).clip[2], 300, 0.0001);
});

test("\\t easing: one leading number is an accel exponent (k = f^accel)", () => {
  const C = {
    clip: [0, 0, 100, 100],
    // \t(2, \\clip(…)) → whole cue, accel 2
    ts: [{ t1: 0, t2: 0, accel: 2, clip: [0, 0, 300, 100] }],
  };
  close(evalMotion(C, 500, 1000).clip[2], 100 + 200 * 0.25, 0.001); // f=0.5 → k=0.25
  close(evalMotion(C, 750, 1000).clip[2], 100 + 200 * 0.5625, 0.001); // f=0.75 → k=0.5625
  assert.deepEqual(evalMotion(C, 1000, 1000).clip, [0, 0, 300, 100]);
});

test("\\t easing: three leading numbers are t1, t2, accel", () => {
  const C = {
    clip: [0, 0, 0, 100],
    ts: [{ t1: 1000, t2: 2000, accel: 2, clip: [0, 0, 200, 100] }],
  };
  close(evalMotion(C, 500, 2500).clip[2], 0, 0.0001); // before t1
  close(evalMotion(C, 1250, 2500).clip[2], 0 + 200 * 0.0625, 0.001); // f=0.25 → k=0.0625
  close(evalMotion(C, 1500, 2500).clip[2], 50, 0.001); // f=0.5 → k=0.25 → 200·0.25
  close(evalMotion(C, 2500, 2500).clip[2], 200, 0.0001);
});

// --- position: \move (animated) vs \pos (static, first wins) ------------------

const MOVE = {
  move: { x1: 100, y1: 300, x2: 500, y2: 60, t1: 1000, t2: 3000 },
  ts: [],
};

test("\\move with t1/t2: holds at (x1,y1) before, lerps inside, holds at (x2,y2) after", () => {
  assert.deepEqual(evalMotion(MOVE, 0, 5000).pos, { x: 100, y: 300 });
  assert.deepEqual(evalMotion(MOVE, 999, 5000).pos, { x: 100, y: 300 });
  close(evalMotion(MOVE, 2000, 5000).pos.x, 300, 0.001); // f = 0.5
  close(evalMotion(MOVE, 2000, 5000).pos.y, 180, 0.001);
  assert.deepEqual(evalMotion(MOVE, 3000, 5000).pos, { x: 500, y: 60 });
  assert.deepEqual(evalMotion(MOVE, 4999, 5000).pos, { x: 500, y: 60 });
});

test("\\move without times spans the whole cue", () => {
  const M = { move: { x1: 0, y1: 0, x2: 100, y2: 200 }, ts: [] };
  assert.deepEqual(evalMotion(M, 0, 1000).pos, { x: 0, y: 0 });
  close(evalMotion(M, 250, 1000).pos.x, 25, 0.001);
  close(evalMotion(M, 250, 1000).pos.y, 50, 0.001);
  assert.deepEqual(evalMotion(M, 1000, 1000).pos, { x: 100, y: 200 });
});

test("a static \\pos holds for the whole cue (libass never tweens \\pos)", () => {
  const T = { pos: { x: 100, y: 200 }, ts: [] };
  assert.deepEqual(evalMotion(T, 0, 4000).pos, { x: 100, y: 200 });
  assert.deepEqual(evalMotion(T, 2000, 4000).pos, { x: 100, y: 200 });
  assert.deepEqual(evalMotion(T, 3999, 4000).pos, { x: 100, y: 200 });
});

test("no position source → no pos", () => {
  assert.equal(evalMotion({ ts: [] }, 500, 4000).pos, undefined);
});

test("the exact cue ends are fully faded (FP-safe boundary)", () => {
  const F = { fad: { in: 439, out: 436 }, ts: [] };
  assert.equal(evalMotion(F, 0, 7130).opacityMul, 0, "exact cue start: fade-in at 0%");
  assert.equal(evalMotion(F, 7130, 7130).opacityMul, 0, "exact cue end: fade-out complete");
  assert.equal(evalMotion(F, 7180, 7130).opacityMul, 0, "past the end stays faded");
});

test("anyMotionActive: true only while a motion-tagged cue is on screen", () => {
  const M = { fad: { in: 100, out: 100 }, ts: [] };
  const cues = [
    { start: 10, end: 20, motion: M },
    { start: 12, end: 15 }, // no motion
    { start: 30, end: 40, motion: M },
  ];
  assert.equal(anyMotionActive(cues, 9.99), false, "before the first motion cue");
  assert.equal(anyMotionActive(cues, 10), true, "the cue's start is active");
  assert.equal(anyMotionActive(cues, 15.5), true, "mid-cue");
  assert.equal(anyMotionActive(cues, 20), false, "the cue's end is not active");
  assert.equal(anyMotionActive(cues, 35), true, "second motion cue");
  assert.equal(anyMotionActive(cues, 40.01), false, "after the last");
  assert.equal(anyMotionActive([], 5), false, "no cues");
});
