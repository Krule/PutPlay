/**
 * Playback progress as a percentage for the player bar.
 *
 * Pure so the math is unit-testable. The Player MUST bind the result to a
 * reactive value (`$: barPct = progressPct(currentTime, duration)`) — Svelte
 * only tracks plain identifiers in style bindings; a bare function call like
 * `{pct()}` is evaluated once in the create phase and frozen for the life of
 * the component (the invisible-bar bug).
 */
export function progressPct(currentTime: number, duration: number): number {
  // !(duration > 0) covers 0, NaN and negatives; isFinite excludes live (∞)
  if (!(duration > 0) || !isFinite(duration)) return 0;
  const t = Math.max(0, currentTime || 0);
  return Math.min(100, (t / duration) * 100);
}


/**
 * Is the playhead waiting on the network ("buffering")?
 *
 * Correct semantics: buffering = the playhead is within the last 2s of
 * buffered data (a stall) — UNLESS the media is fully buffered, where
 * reaching the buffer end is just end-of-file, not a stall. The old inline
 * condition in MediaEngine was inverted (it flagged *healthy* playback as
 * buffering), which broke anything gating on !buffering.
 */
export function isBuffering(currentTime: number, bufferedEnd: number, duration: number): boolean {
  // Fully buffered (buffer end reached the end of the file) → never "waiting".
  if (duration > 0 && isFinite(duration) && bufferedEnd >= duration - 0.5) return false;
  // No buffer yet → waiting by definition.
  if (bufferedEnd === 0) return true;
  return currentTime >= bufferedEnd - 2;
}
