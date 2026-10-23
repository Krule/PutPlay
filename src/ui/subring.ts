// The subtitle outline ring — the canvas primitive the Player uses for the
// libass outline bitmap.
//
// libass paints each line's outline as a RING: blur(dilate(glyph, w)) −
// blur(glyph). The glyph core stays transparent (the cue beneath shows
// through), only the outer w band carries the outline colour. No CSS
// primitive produces that: a centred -webkit-text-stroke leaks its inner
// half over the core; 8-way text-shadow and zero-offset drop-shadow fill the
// interior; alpha mix-blend-mode is unsupported in this Chrome family; and
// foreignObject text inside an SVG <mask> never renders here (verified by
// pixel-identical masked/unmasked A/B). Canvas 2D does it: strokeText with a
// centred 2×w line, then a destination-out fillText punches the core, all
// blurred by the \blur sigma.
//
// Each segment is drawn to its own strip (its own sigma and colour) and the
// strips are blitted onto the line's canvas at their cumulated x offsets.
// The module is pure: the canvas and context are injected, so the draw order
// is unit-testable in node without a DOM.
//
// v1 gap: multi-line cues keep the centred-stroke fallback — canvas text
// does not wrap (documented in the Player).

export interface RingSegment {
  text: string;
  /** The outline band in css px (half the centred stroke width). */
  outlinePx: number;
  /** CSS colour of the outline band. */
  color: string;
  /** The \blur sigma in css px. */
  blurPx: number;
  bold: boolean;
  italic: boolean;
}

export interface RingOpts {
  segments: RingSegment[];
  /** The full CSS font-family chain of the line. */
  family: string;
  fontSizePx: number;
  /** The line box height (line-height) in css px. */
  lineBoxPx: number;
  /** The baseline, measured from the line box top, in css px. */
  baselinePx: number;
  /** The rendered text width (the sizer's offsetWidth) in css px. */
  textWidthPx: number;
  dpr: number;
  makeCanvas: (w: number, h: number) => HTMLCanvasElement;
}

export interface RingMeasure {
  /** The css width of the finished canvas. */
  w: number;
  /** The css height of the finished canvas. */
  h: number;
  /** The css margin around the line box the canvas carries. */
  m: number;
}

/** The canvas font string for a segment: [italic] <weight> <size>px <family>. */
export function ringFont(
  seg: { bold: boolean; italic: boolean },
  family: string,
  sizePx: number,
): string {
  const weight = seg.bold ? "700" : "400";
  return `${seg.italic ? "italic " : ""}${weight} ${sizePx}px ${family}`;
}

/**
 * The margin the canvas must carry around the line box: the widest segment's
 * outline + blur, rounded up, plus 1 px of anti-aliasing slack.
 */
export function ringMargin(segments: { outlinePx: number; blurPx: number }[]): number {
  const worst = Math.max(0, ...segments.map((s) => s.outlinePx + s.blurPx));
  return Math.ceil(worst) + 1;
}

/** The css size of the canvas drawRing produces for these opts. */
export function ringSize(opts: {
  segments: { outlinePx: number; blurPx: number }[];
  lineBoxPx: number;
  textWidthPx: number;
}): RingMeasure {
  const m = ringMargin(opts.segments);
  return {
    w: opts.textWidthPx + 2 * m,
    h: Math.ceil(opts.lineBoxPx) + 2 * m,
    m,
  };
}

/**
 * Paint the ring onto `canvas` (backing store = css × dpr, ctx already the
 * 2d context). Geometry is in css px; the ctx is scaled by dpr first.
 */
export function drawRing(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  opts: RingOpts,
): void {
  const m = ringMargin(opts.segments);
  const cssH = Math.ceil(opts.lineBoxPx) + 2 * m;
  canvas.width = Math.ceil((opts.textWidthPx + 2 * m) * opts.dpr);
  canvas.height = Math.ceil(cssH * opts.dpr);
  ctx.save();
  ctx.scale(opts.dpr, opts.dpr);
  ctx.textBaseline = "alphabetic";

  let cum = 0;
  for (const seg of opts.segments) {
    const font = ringFont(seg, opts.family, opts.fontSizePx);
    ctx.font = font;
    const segW = ctx.measureText(seg.text).width;
    // A segment without outline (a \bord0 span inside an outlined line) has
    // no ring — but its width still counts toward the next segment's offset.
    if (seg.outlinePx <= 0) {
      cum += segW;
      continue;
    }
    const stripCssW = segW + 2 * m;

    const strip = opts.makeCanvas(Math.ceil(stripCssW * opts.dpr), Math.ceil(cssH * opts.dpr));
    const sctx = strip.getContext("2d") as CanvasRenderingContext2D;
    sctx.scale(opts.dpr, opts.dpr);
    sctx.textBaseline = "alphabetic";
    sctx.font = font;
    // The libass order: blur(dilate) first, then the blurred glyph punches
    // the core out — both at the segment's own sigma. The canvas carries m
    // px of margin ABOVE the line box (it is placed at top:-m), so the
    // baseline — measured from the line-box top — lands at m + baselinePx.
    sctx.filter = `blur(${seg.blurPx}px)`;
    sctx.lineWidth = seg.outlinePx * 2;
    sctx.strokeStyle = seg.color;
    sctx.strokeText(seg.text, m, m + opts.baselinePx);
    sctx.globalCompositeOperation = "destination-out";
    sctx.fillStyle = "#000";
    sctx.fillText(seg.text, m, m + opts.baselinePx);
    sctx.globalCompositeOperation = "source-over";

    ctx.drawImage(strip, cum, 0, stripCssW, cssH);
    cum += segW;
  }
  ctx.restore();
}

/**
 * A rendered line's ring-relevant fields, structurally typed so this module
 * stays free of substyle imports.
 */
export interface RingLine {
  text: string;
  segments: Array<{
    text: string;
    bold?: boolean;
    italic?: boolean;
    outlinePx?: number;
    outlineColor?: string;
    blurPx?: number;
  }>;
  outlinePx: number;
  outlineColor: string;
  blurPx: number;
  bold?: boolean;
  italic?: boolean;
}

/**
 * The ring's segment list. A cue with NO styling overrides has an empty
 * segments array — the text lives on the line itself, and the STYLE can
 * still carry an outline (hasStroke is true). Inlining this mapping in the
 * player made that case crash (line.segments[0] → undefined); as a pure
 * function both shapes are unit-tested. The segment-less line becomes ONE
 * whole-line segment carrying the line-level outline/blur and the line's
 * bold/italic — the ring text must use the exact same font as the fill
 * layer or the punch misaligns.
 */
export function ringSegments(line: RingLine): RingSegment[] {
  if (line.segments.length) {
    return line.segments.map((s) => ({
      text: s.text,
      outlinePx: s.outlinePx ?? line.outlinePx,
      color: s.outlineColor ?? line.outlineColor,
      blurPx: s.blurPx ?? line.blurPx,
      bold: !!s.bold,
      italic: !!s.italic,
    }));
  }
  return [
    {
      text: line.text,
      outlinePx: line.outlinePx,
      color: line.outlineColor,
      blurPx: line.blurPx,
      bold: !!line.bold,
      italic: !!line.italic,
    },
  ];
}
