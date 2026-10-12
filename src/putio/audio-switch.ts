// Audio-track switching with platform read-back.
//
// The webOS webview exposes HTMLMediaElement.audioTracks (LG documents it
// since webOS 3) but SILENTLY IGNORES `enabled` writes for some MKV files —
// the list enumerates fine, the assignment is a no-op, and the old track
// keeps playing. So a switch is only confirmed by reading the flags back
// after writing them.

export interface SwitchableAudioTrack {
  enabled: boolean;
}

/**
 * Enable `index` in `tracks` and return the index that is ACTUALLY enabled
 * afterwards (the platform may veto the write). -1 = out of range or no
 * track ended up enabled.
 */
export function applyAudioTrack(tracks: SwitchableAudioTrack[] | null, index: number): number {
  if (!tracks || index < 0 || index >= tracks.length) return -1;
  for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === index;
  for (let i = 0; i < tracks.length; i++) if (tracks[i].enabled) return i;
  return -1;
}

/* ---------------- escalation planning (the webOS 6 veto) ----------------
 *
 * When the read-back vetoes a write, the engine escalates one step at a
 * time. The PLANNING is pure (this file) so the whole decision table is
 * testable without a DOM; the EXECUTION (pausing, Luna call, the reload
 * dance) lives in MediaEngine.
 */

/** Read-only: index of the currently-enabled track (-1 = none). */
export function enabledIndexOf(tracks: SwitchableAudioTrack[] | null | undefined): number {
  if (!tracks) return -1;
  for (let i = 0; i < tracks.length; i++) if (tracks[i].enabled) return i;
  return -1;
}

export type AudioSwitchOutcome =
  | { kind: "confirmed"; index: number }
  | { kind: "next"; attempt: number }
  | { kind: "failed"; reason: string };

/** The reload dance is the last escalation step. */
export const AUDIO_SWITCH_DANCE_ATTEMPT = 3;

/**
 * Decide what happens after attempt `attempt` read back `landedIndex` while
 * trying to enable `desiredIndex`:
 *  - landed where we aimed → confirmed
 *  - vetoed, steps remain  → escalate to the next attempt
 *  - vetoed after the dance → failed (with the honest reason)
 *
 * Attempt map: 0 plain write · 1 paused write · 2 write + Luna selectTrack
 * · 3 the reload dance (see MediaEngine.runNativeSwitch).
 */
export function planAudioSwitch(
  attempt: number,
  landedIndex: number,
  desiredIndex: number
): AudioSwitchOutcome {
  if (landedIndex === desiredIndex) return { kind: "confirmed", index: desiredIndex };
  if (attempt < AUDIO_SWITCH_DANCE_ATTEMPT) return { kind: "next", attempt: attempt + 1 };
  return {
    kind: "failed",
    reason:
      "The TV's player refused this audio switch for the file. If the put.io stream offers this language, pick it there.",
  };
}
