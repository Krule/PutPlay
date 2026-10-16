/**
 * D-pad scrubber decisions for the TV player, extracted as pure functions
 * so the Player (which owns the scrubber row: fill bar, thumb, time
 * bubble) can apply one tested rule. No DOM/webOS imports — testable in
 * node.
 *
 * The locked design:
 *   - ←/→ on the D-pad is a REAL seek of ±step seconds from the current
 *     time, clamped to [0, dur].
 *   - A live/unknown duration (0, negative, non-finite) means there is no
 *     bar to scrub — the row renders LIVE instead. So an unknown duration
 *     is a guard (no seek / 0%), not a feature.
 */

export type ScrubDir = -1 | 1;

/** True when the duration is a real, seekable end of file. */
function seekableDuration(dur: number): boolean {
  return Number.isFinite(dur) && dur > 0;
}

/** Clamp a value into [0, hi]. */
function clamp(v: number, hi: number): number {
  return Math.min(hi, Math.max(0, v));
}

/**
 * Where a D-pad ←/→ press lands: t ± step, clamped so the result is never
 * < 0 and never > dur. Unknown/live duration → t unchanged (no seek).
 * A not-yet-started playhead (t <= 0) counts as 0 for the math.
 */
export function scrubSeek(t: number, dur: number, dir: ScrubDir, step: number): number {
  if (!seekableDuration(dur)) return t;
  const from = t <= 0 ? 0 : t;
  const landed = from + dir * step;
  return clamp(landed, dur);
}

/**
 * Playhead percentage 0..100 for the fill/thumb/bubble, clamped to
 * [0, 100]. Unknown/live duration → 0 (nothing to show).
 */
export function scrubThumbPct(t: number, dur: number): number {
  if (!seekableDuration(dur)) return 0;
  const pct = (t / dur) * 100;
  return clamp(pct, 100);
}
