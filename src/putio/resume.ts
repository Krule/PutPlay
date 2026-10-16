/**
 * Auto-resume decision, extracted as a pure function so the MediaEngine
 * (which owns the <video> and fetches the saved position) and the tests
 * share one tested rule.
 *
 * Locked decision L1: PURE AUTO-RESUME. There is no prompt and no choice —
 * the player starts where the viewer left off (HIG: avoid asking people if
 * they want to resume), and "start from beginning" is a seek to 0 on the
 * scrubber. The engine's only question is WHERE to seek when a file opens.
 *
 * (The prompt-era choice functions — shouldShowResumePrompt /
 * initialSeekTarget — are gone with the prompt; the engine's
 * applyInitialSeek path was removed with them.)
 */

/** Saved positions smaller than this are treated as "no real position". */
export const RESUME_MIN = 30;
/** Auto-resume only makes sense when we're still near the start of the file. */
export const NEAR_START_MAX = 60;
/** Give the viewer a few seconds of context before the saved mark. */
export const RESUME_LEAD = 5;

/**
 * Where a file OPEN lands when it carries a saved position.
 *
 *   - a real saved position (> RESUME_MIN) while the playhead is still
 *     near the start (the file is being opened, not replayed mid-file) →
 *     { time: saved - RESUME_LEAD } (the defensive 0-clamp is unreachable:
 *     saved > RESUME_MIN keeps saved-lead positive)
 *   - no saved position, a trivial one, or a mid-file position → null
 *     (start at 0 / start normally)
 */
export function autoResumeTarget(
  startFrom: number | null | undefined,
  currentTime: number
): { time: number } | null {
  if (!startFrom || startFrom <= RESUME_MIN) return null;
  if ((currentTime || 0) >= NEAR_START_MAX) return null;
  return { time: Math.max(0, startFrom - RESUME_LEAD) };
}
