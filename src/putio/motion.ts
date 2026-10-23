// Pure per-frame ASS motion evaluation — the heart of the subtitle motion
// engine. Everything here is stateless: give it a cue's motion spec, the time
// since cue start, and the cue duration, and it returns the per-frame state
// in PlayRes units. The renderer (substyle.ts) scales that to the video box.
//
// Semantics follow libass (MPV's engine), verified against ass_parse.c:
//  • \fad(i, o) — piecewise: transparent at the start → opaque over the
//    first i ms, opaque until end−o, → transparent over the last o ms. 0
//    disables that ramp. In overlapping windows the fade-IN branch wins
//    (libass's if-chain order) — the ramps never mix.
//  • \clip(x1, y1, x2, y2) — a static window; \t blocks animate it with
//    pwr interpolation from the current (accumulated) window. (libass
//    truncates \clip coordinates to ints — the parser does that; it also
//    injects the full PlayRes rect as the from-window when a \t-clip has
//    no static \clip, matching libass's initial clip state.)
//  • \move(x1, y1, x2, y2 [, t1, t2]) — linear move; t1/t2 default to the
//    whole cue.
//  • \t([t1, t2[, accel],] …) — a transition window relative to cue start.
//    VSFilter argument-count rules (the tag argument is always last): two
//    leading numbers = t1, t2, linear; ONE leading number = an accel
//    exponent over the whole cue; none = whole cue, linear; three = t1,
//    t2, accel. k = pow(progress, accel); t2 = 0 means the whole cue.
//  • \pos is NOT animatable in libass (issue #886, open). The first \pos
//    or \move in text order owns the position (both directions); the
//    parser resolves that first-wins into exactly one of spec.pos /
//    spec.move. A \pos inside a \t is therefore just a plain \pos.

export type ClipRect = [number, number, number, number];

export interface MoveSpec {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** relative to cue start, ms; default (0, dur) */
  t1?: number;
  t2?: number;
}

export interface TBlock {
  /** relative to cue start, ms; omitted → whole cue */
  t1?: number;
  /** relative to cue start, ms; 0 or omitted → whole cue */
  t2?: number;
  /** easing exponent (one-leading-number \t form); default 1 */
  accel?: number;
  clip?: ClipRect;
}

export interface MotionSpec {
  fad?: { in: number; out: number };
  /** static \clip window, PlayRes (ints — see header) */
  clip?: ClipRect;
  /**
   * static \pos, PlayRes — the first \pos in text order (including one
   * inside a \t); libass never tweens \pos. Mutually exclusive with move.
   */
  pos?: { x: number; y: number };
  /** first \move in text order, if no earlier \pos claimed the position */
  move?: MoveSpec;
  /** \blur, PlayRes units */
  blur?: number;
  /** \t blocks with \clip targets, in text order */
  ts: TBlock[];
}

export interface MotionFrame {
  /** 0…1 — multiplies the line's element opacity */
  opacityMul: number;
  /** current clip window, PlayRes */
  clip?: ClipRect;
  /** current position, PlayRes (from \move, or the static \pos) */
  pos?: { x: number; y: number };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const lerp = (from: number, to: number, f: number): number => from + (to - from) * f;

/** Linear progress of a \t/\move window: 0 before t1, 1 after t2, clamped inside. */
function progress(t1: number, t2: number, relMs: number): number {
  const span = t2 - t1;
  if (span <= 0) return relMs >= t2 ? 1 : 0;
  return clamp01((relMs - t1) / span);
}

/** libass interpolate_alpha for \fad(i, o), returned as 0…1 opacity. */
function fadeOpacity(spec: MotionSpec, relMs: number, durMs: number): number {
  const fad = spec.fad;
  if (!fad) return 1;
  const t2 = fad.in;
  const t3 = durMs - fad.out;
  const t4 = durMs;
  // libass branch order: the fade-in branch owns overlaps.
  // (relMs < t2 with t2 = 0 is unreachable, so no divide-by-zero is either.)
  let alpha: number;
  if (relMs < 0) alpha = 255;
  else if (relMs < t2) alpha = 255 * (1 - relMs / t2);
  else if (relMs < t3) alpha = 0;
  else if (relMs < t4) alpha = 255 * ((relMs - t3) / (t4 - t3));
  else alpha = 255;
  return 1 - alpha / 255;
}

/** Eased progress for a \t block: k = pow(f, accel), guarded at the ends. */
function eased(block: TBlock, t1: number, t2: number, relMs: number): number {
  const f = progress(t1, t2, relMs);
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  return Math.pow(f, block.accel ?? 1);
}

/** Resolve a \t/\move window: t1 defaults to 0, t2 0/omitted = whole cue (libass). */
function resolveWindow(t1: number | undefined, t2: number | undefined, durMs: number): [number, number] {
  return [t1 ?? 0, t2 || durMs];
}

function clipAt(spec: MotionSpec, relMs: number, durMs: number): ClipRect | undefined {
  let rect = spec.clip;
  for (const block of spec.ts) {
    if (!block.clip) continue;
    if (!rect) rect = block.clip; // defensive: the parser injects the from-rect
    const [t1, t2] = resolveWindow(block.t1, block.t2, durMs);
    const k = eased(block, t1, t2, relMs);
    rect = [
      lerp(rect[0], block.clip[0], k),
      lerp(rect[1], block.clip[1], k),
      lerp(rect[2], block.clip[2], k),
      lerp(rect[3], block.clip[3], k),
    ];
  }
  return rect;
}

function moveAt(move: MoveSpec, relMs: number, durMs: number): { x: number; y: number } {
  const [t1, t2] = resolveWindow(move.t1, move.t2, durMs);
  const f = progress(t1, t2, relMs);
  return { x: lerp(move.x1, move.x2, f), y: lerp(move.y1, move.y2, f) };
}

/** \move animates; \pos is static (libass never tweens \pos). */
function positionAt(spec: MotionSpec, relMs: number, durMs: number): { x: number; y: number } | undefined {
  return spec.move ? moveAt(spec.move, relMs, durMs) : spec.pos;
}

export function evalMotion(spec: MotionSpec, relMs: number, durMs: number): MotionFrame {
  const frame: MotionFrame = { opacityMul: fadeOpacity(spec, relMs, durMs) };
  const clip = clipAt(spec, relMs, durMs);
  if (clip) frame.clip = clip;
  const pos = positionAt(spec, relMs, durMs);
  if (pos) frame.pos = pos;
  return frame;
}

/**
 * The rAF driver's run/stop condition: is any motion-tagged cue on screen at
 * `t` (seconds)? While true, the renderer must re-evaluate every frame — a
 * \fad/\clip/\move cue is a different picture on every tick. Cue windows are
 * short and the evaluator is cheap, so the rule stays simple: any motion spec
 * on an active cue drives the loop.
 */
export function anyMotionActive(
  cues: { start: number; end: number; motion?: MotionSpec }[],
  t: number
): boolean {
  return cues.some((c) => !!c.motion && c.start <= t && t < c.end);
}
