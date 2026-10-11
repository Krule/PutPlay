// Out-of-band (device-code) sign-in poll planner.
//
// The old loop polled every 3s forever and swallowed every error — including
// 429s — at the same cadence, which hammered the put.io auth endpoint
// (a TV left on the sign-in screen = ~2,880 requests/day). The poll must be
// bounded: codes expire, rate-limits must stop it, and network errors must
// back off.

/** OOB codes are short-lived; polling past this is pure noise. */
export const OOB_CODE_TTL_MS = 5 * 60 * 1000;

export type PollStep =
  | { action: "poll"; delayMs: number }
  | { action: "stop"; reason: "code-expired" | "rate-limited" };

/** Backoff for consecutive non-429 errors (offline TV, put.io blip): 3s → 15s cap. */
const ERROR_BACKOFF_MS = [3000, 5000, 8000, 15000];

/**
 * Decide the next step of the approval poll.
 * Order of checks matters: expiry first (a dead code must not be polled even
 * if the endpoint is healthy), then 429 (stop — manual retry with a fresh
 * code), then error backoff.
 */
export function nextPollStep(opts: {
  elapsedMs: number;
  consecutiveErrors: number;
  lastErrorWas429: boolean;
}): PollStep {
  if (opts.elapsedMs >= OOB_CODE_TTL_MS) return { action: "stop", reason: "code-expired" };
  if (opts.lastErrorWas429) return { action: "stop", reason: "rate-limited" };
  const i = Math.min(opts.consecutiveErrors, ERROR_BACKOFF_MS.length - 1);
  return { action: "poll", delayMs: opts.consecutiveErrors === 0 ? 3000 : ERROR_BACKOFF_MS[i] };
}
