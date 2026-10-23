// The subtitle outline ring — the canvas primitive the Player uses for the
// libass outline bitmap.
//
// libass paints each line's outline as a RING: blur(dilate(glyph, w)) −
// blur(glyph) — the glyph core stays transparent (the cue below shows
// through), only the outer w band carries the outline colour. No CSS
// primitive produces that: a centred -webkit-text-stroke leaks its inner
// half over the core, 8-way text-shadow and zero-offset drop-shadow fill the
// interior, alpha mix-blend-mode is unsupported in this Chrome family, and
// foreignObject text inside <mask> never renders. Canvas 2D can: strokeText
// (centred 2×w) → destination-out fillText punches the core → blur.
//
// This module is pure: the canvas + context are injected, so the draw order
// is testable in node without a DOM. Each segment is drawn to its own strip
// (its own σ), then the strips are composited onto the line's canvas.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { ringFont, ringMargin, drawRing } from "../src/ui/subring.ts";

const FAMIL = '"Times New Roman", sans-serif';

function mockCtx(rec, widths) {
  return {
    font: "",
    filter: "none",
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    globalCompositeOperation: "source-over",
    textBaseline: "",
    save() {
      rec.push(["save"]);
    },
    restore() {
      rec.push(["restore"]);
    },
    scale(s) {
      rec.push(["scale", s]);
    },
    measureText(t) {
      return { width: widths.get(t) ?? 10 };
    },
    strokeText(t, x, y) {
      rec.push(["strokeText", t, x, y, this.filter, this.lineWidth, this.strokeStyle, this.globalCompositeOperation]);
    },
    fillText(t, x, y) {
      rec.push(["fillText", t, x, y, this.globalCompositeOperation, this.filter]);
    },
    drawImage(src, x, y, w, h) {
      rec.push(["drawImage", x, y, w, h]);
    },
  };
}

function mockFactory(rec, made) {
  return (w, h) => {
    made.push([w, h]);
    return { width: w, height: h, getContext: () => mockCtx(rec, new Map()) };
  };
}

const SEGS = [
  { text: "The Apothecary ", outlinePx: 4, color: "rgb(182, 56, 31)", blurPx: 5.1, bold: true, italic: false },
  { text: "Diaries", outlinePx: 2, color: "rgba(255, 255, 255, 0.663)", blurPx: 3.4, bold: true, italic: false },
];
const WIDTHS = new Map([
  ["The Apothecary ", 100],
  ["Diaries", 60],
]);

test("ringFont: weight + italic + size + family in canvas font order", () => {
  assert.equal(ringFont({ bold: true, italic: false }, FAMIL, 44), `700 44px ${FAMIL}`);
  assert.equal(ringFont({ bold: true, italic: true }, FAMIL, 44), `italic 700 44px ${FAMIL}`);
  assert.equal(ringFont({ bold: false, italic: false }, FAMIL, 44), `400 44px ${FAMIL}`);
});

test("ringMargin: the widest segment's outline + blur, rounded up, plus AA slack", () => {
  assert.equal(ringMargin(SEGS), Math.ceil(4 + 5.1) + 1, "worst segment (4+5.1), rounded up, +1 AA slack");
  assert.equal(ringMargin([{ outlinePx: 1, blurPx: 0 }]), 1 + 0 + 1);
});

test("drawRing: stroke → punch, in libass order, per segment strip", () => {
  const rec = [];
  const made = [];
  const canvas = { width: 0, height: 0 };
  drawRing(
    canvas,
    mockCtx(rec, WIDTHS),
    {
      segments: SEGS,
      family: FAMIL,
      fontSizePx: 44,
      lineBoxPx: 61.6,
      baselinePx: 30,
      textWidthPx: 160,
      dpr: 1,
      makeCanvas: mockFactory(rec, made),
    },
  );
  const m = Math.ceil(4 + 5.1) + 1; // 11
  assert.equal(canvas.width, 160 + 2 * m);
  assert.equal(canvas.height, Math.ceil(61.6) + 2 * m);
  // two strips, each css-sized (dpr 1)
  assert.equal(made.length, 2);
  assert.deepEqual(made[0], [100 + 2 * m, Math.ceil(61.6) + 2 * m]);
  assert.deepEqual(made[1], [60 + 2 * m, Math.ceil(61.6) + 2 * m]);
  const strokes = rec.filter((c) => c[0] === "strokeText");
  const fills = rec.filter((c) => c[0] === "fillText");
  assert.equal(strokes.length, 2);
  assert.equal(fills.length, 2);
  // segment 1
  const [s0, st, sx, sy, sfilter, slw, scol, sgco] = strokes[0];
  assert.equal(st, "The Apothecary ");
  assert.equal(sx, m); // the segment starts at the strip's left margin
  assert.equal(sy, 30); // the measured baseline (strip top = line-box top)
  assert.equal(sfilter, "blur(5.1px)");
  assert.equal(slw, 8); // centred 2×w
  assert.equal(scol, "rgb(182, 56, 31)");
  assert.equal(sgco, "source-over"); // never stroke while punching
  // segment 2 — its own width and sigma, after the first's measured width
  const [s1, st1, sx1, , sfilter1, slw1, scol1] = strokes[1];
  assert.equal(st1, "Diaries");
  assert.equal(sx1, m); // strip-local origin (the cum offset is the strip's PLACEMENT)
  assert.equal(sfilter1, "blur(3.4px)");
  assert.equal(slw1, 4);
  assert.equal(scol1, "rgba(255, 255, 255, 0.663)");
  // the punches: same geometry as the strokes, destination-out, blurred
  fills.forEach((f, i) => {
    const [, ft, fx, fy, fgco, ffilter] = f;
    const s = strokes[i];
    assert.equal(ft, s[1]);
    assert.equal(fx, s[2]);
    assert.equal(fy, s[3]);
    assert.equal(fgco, "destination-out");
    assert.equal(ffilter, s[4]); // blur(glyph), not just blur(dilate)
  });
  // strip placement on the line canvas: at the cumulated css offsets
  const draws = rec.filter((c) => c[0] === "drawImage");
  assert.equal(draws.length, 2);
  assert.deepEqual(draws[0], ["drawImage", 0, 0, 100 + 2 * m, Math.ceil(61.6) + 2 * m]);
  assert.deepEqual(draws[1], ["drawImage", 100, 0, 60 + 2 * m, Math.ceil(61.6) + 2 * m]);
});

test("drawRing: a zero-outline segment draws no strip but keeps its width in the offsets", () => {
  const rec = [];
  const canvas = { width: 0, height: 0 };
  const segs = [
    { text: "Plain ", outlinePx: 0, color: "#fff", blurPx: 0, bold: false, italic: false },
    { text: "Outlined", outlinePx: 2, color: "#f00", blurPx: 1.7, bold: false, italic: false },
  ];
  const widths = new Map([
    ["Plain ", 30],
    ["Outlined", 60],
  ]);
  drawRing(
    canvas,
    mockCtx(rec, widths),
    {
      segments: segs,
      family: FAMIL,
      fontSizePx: 44,
      lineBoxPx: 61.6,
      baselinePx: 30,
      textWidthPx: 90,
      dpr: 1,
      makeCanvas: mockFactory(rec, []),
    },
  );
  const strokes = rec.filter((c) => c[0] === "strokeText");
  assert.equal(strokes.length, 1, "no strip for the zero-outline segment");
  assert.equal(strokes[0][1], "Outlined");
  const draws = rec.filter((c) => c[0] === "drawImage");
  const m = Math.ceil(2 + 1.7) + 1;
  // the strip lands AFTER the plain segment's measured width (30)
  assert.deepEqual(draws[0], ["drawImage", 30, 0, 60 + 2 * m, Math.ceil(61.6) + 2 * m]);
});

test("drawRing: dpr scales the backing store, geometry stays in css px", () => {
  const rec = [];
  const made = [];
  const canvas = { width: 0, height: 0 };
  const segs = [{ text: "Hi", outlinePx: 2, color: "#f00", blurPx: 1.7, bold: false, italic: false }];
  drawRing(
    canvas,
    mockCtx(rec, new Map([["Hi", 20]])),
    {
      segments: segs,
      family: FAMIL,
      fontSizePx: 44,
      lineBoxPx: 61.6,
      baselinePx: 30,
      textWidthPx: 20,
      dpr: 2,
      makeCanvas: mockFactory(rec, made),
    },
  );
  const m = Math.ceil(2 + 1.7) + 1;
  const cssW = 20 + 2 * m;
  const cssH = Math.ceil(61.6) + 2 * m;
  assert.equal(canvas.width, cssW * 2);
  assert.equal(canvas.height, cssH * 2);
  assert.equal(made[0][0], cssW * 2, "strip backing store is device px");
  assert.ok(rec.some((c) => c[0] === "scale" && c[1] === 2), "the main ctx is scaled by dpr");
  const draws = rec.filter((c) => c[0] === "drawImage");
  assert.deepEqual(draws[0], ["drawImage", 0, 0, cssW, cssH], "strips blit at css size (the ctx scale does the rest)");
});

// Segment-less lines: a cue with no styling overrides has segments: [] but
// the STYLE can still carry an outline (hasStroke is true). The ring needs a
// single whole-line segment with the line-level values — and the line-level
// bold/italic, or the ring text gets a different weight than the fill layer
// and the punch misaligns.
const { ringSegments } = await import("../src/ui/subring.ts");

test("ringSegments: a segment-less line becomes one whole-line segment", () => {
  const segs = ringSegments({
    text: "plain styled cue",
    segments: [],
    outlinePx: 4,
    outlineColor: "rgb(182, 56, 31)",
    blurPx: 5.1,
    bold: true,
    italic: false,
  });
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], {
    text: "plain styled cue",
    outlinePx: 4,
    color: "rgb(182, 56, 31)",
    blurPx: 5.1,
    bold: true,
    italic: false,
  });
});

test("ringSegments: styled lines keep their segments with line-level fallbacks", () => {
  const segs = ringSegments({
    text: "ghost Diaries",
    segments: [
      { text: "ghost ", bold: true, italic: false },
      { text: "Diaries", bold: true, italic: false, outlinePx: 2, outlineColor: "rgba(255, 255, 255, 0.663)", blurPx: 3.4 },
    ],
    outlinePx: 4,
    outlineColor: "rgb(182, 56, 31)",
    blurPx: 5.1,
    bold: true,
    italic: false,
  });
  assert.equal(segs.length, 2);
  assert.equal(segs[0].color, "rgb(182, 56, 31)"); // line fallback
  assert.equal(segs[0].blurPx, 5.1);
  assert.equal(segs[1].color, "rgba(255, 255, 255, 0.663)");
  assert.equal(segs[1].outlinePx, 2);
  assert.equal(segs[1].blurPx, 3.4);
});
