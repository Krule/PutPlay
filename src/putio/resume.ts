/**
 * Resume-from-position decisions, extracted as pure functions so the Player
 * (which owns the resume prompt UI) and the MediaEngine (which owns the
 * <video>) can share one tested rule.
 *
 * BUG 1 root cause: the engine auto-applied resume on `loadedmetadata`
 * (seek to start_from-5) *before* the user had chosen, and the prompt's
 * buttons sought on a video whose duration was still 0 (a no-op in the
 * webview). Fix: the engine never auto-applies when the Player shows a
 * prompt; the Player computes the target here and applies it through
 * engine.applyInitialSeek once metadata exists.
 */

/** Saved positions smaller than this are treated as "no real position". */
export const RESUME_MIN = 30;
/** Auto-resume only makes sense when we're still near the start of the file. */
export const NEAR_START_MAX = 60;
/** Give the viewer a few seconds of context before the saved mark. */
export const RESUME_LEAD = 5;

export type ResumeChoice = "resume" | "beginning";

export interface ResumeContext {
  /** Where the <video> currently sits (0 until metadata). */
  currentTime: number;
  /** 0 until metadata has loaded. */
  duration: number;
}

export interface ResumeTarget {
  /** Seconds to seek to. */
  time: number;
  /**
   * true = the seek can apply now (target > 0 works even pre-metadata);
   * false = must wait for `loadedmetadata` (seeking to 0 before metadata
   * is silently dropped by the webview).
   */
  applyNow: boolean;
}

/** Is there a saved position worth prompting about? */
export function shouldShowResumePrompt(startFrom: number | null | undefined): boolean {
  return !!startFrom && startFrom > RESUME_MIN;
}

/**
 * Where to put the playhead for the user's choice.
 *  - "resume": from-lead, clamped at 0; applies immediately only if > 0
 *    and we're still near the start (a mid-file "resume" is meaningless).
 *  - "beginning": 0; always waits for metadata.
 */
export function initialSeekTarget(
  startFrom: number,
  choice: ResumeChoice,
  ctx: ResumeContext
): ResumeTarget {
  if (choice === "beginning") {
    return { time: 0, applyNow: false };
  }
  // resume
  const time = Math.max(0, startFrom - RESUME_LEAD);
  const nearStart = ctx.currentTime < NEAR_START_MAX;
  return { time, applyNow: time > 0 && nearStart };
}
