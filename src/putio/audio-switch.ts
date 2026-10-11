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
