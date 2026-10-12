/**
 * Stall advisory (pure — no DOM/webOS imports, testable in node).
 *
 * The NATIVE original stream's buffer belongs to the webview — no HTML5 API
 * grows it — so the app cannot fix the buffer, but it must not sit silently
 * either: after enough mid-playback stalls it says so ONCE per file and
 * points at the smoother, engine-buffered put.io stream. The mp4/hls sources
 * ARE that advice (hls.js buffers under the app's control) — never advise
 * for them.
 *
 * "Stall" is the engine's count of waiting events that happened DURING
 * playback (after the first frame) — see MediaEngine.onWait.
 */
export const STALL_ADVISORY_THRESHOLD = 3;

export function shouldAdviseSmootherSource(args: {
  source: "original" | "mp4" | "hls";
  stalls: number;
  advised: boolean;
}): boolean {
  if (args.advised) return false; // once per file — never a nag loop
  if (args.source !== "original") return false;
  return args.stalls >= STALL_ADVISORY_THRESHOLD;
}
