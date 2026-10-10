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
