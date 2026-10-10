/**
 * Playback preference decisions (pure — no DOM/webOS imports, testable in
 * node). The Svelte store lives in src/store/config.ts and wraps these.
 *
 *  - source: which stream to start from (original / put.io mp4 / hls)
 *  - audioLang / subtitleLang: preferred language code or display name
 *    ("" = no preference); they steer auto-selection of tracks
 *  - subScale: DOM-overlay subtitle font scale (1 = default)
 */

export interface ConfigState {
  source: "original" | "mp4" | "hls";
  audioLang: string;
  subtitleLang: string;
  subScale: number;
}

export const DEFAULT_CONFIG: ConfigState & { subScaleMin: number; subScaleMax: number } = {
  source: "original",
  audioLang: "",
  subtitleLang: "",
  subScale: 1,
  subScaleMin: 0.8,
  subScaleMax: 2,
};

const SOURCE_KINDS = ["original", "mp4", "hls"] as const;

/** Merge user input onto defaults, coercing to the stored shape. */
export function normalizeConfig(partial: Partial<ConfigState> | null | undefined): ConfigState {
  const d = DEFAULT_CONFIG;
  const p = partial || {};
  const source = (SOURCE_KINDS as readonly string[]).includes(p.source || "")
    ? (p.source as ConfigState["source"])
    : d.source;
  const scale = typeof p.subScale === "number" && !isNaN(p.subScale) ? p.subScale : d.subScale;
  return {
    source,
    audioLang: (p.audioLang ?? "").trim(),
    subtitleLang: (p.subtitleLang ?? "").trim(),
    subScale: Math.min(d.subScaleMax, Math.max(d.subScaleMin, scale)),
  };
}

/** Does a track's language satisfy the preference? "" / null = no preference. */
export function matchLang(
  track: { lang?: string | null; code?: string | null } | null | undefined,
  preferred: string | null | undefined
): boolean {
  if (!preferred) return true;
  if (!track) return false;
  const want = preferred.toLowerCase();
  const code = (track.code || track.lang || "").toLowerCase();
  const label = (track.lang || "").toLowerCase();
  return code === want || label === want;
}

/**
 * Pick the audio track index honoring the preference: first track whose
 * language matches, else the first track (still play something).
 */
export function pickAudioTrack(
  tracks: { lang?: string | null; code?: string | null }[],
  preferred: string | null | undefined
): number {
  if (!tracks.length) return 0;
  if (preferred) {
    for (let i = 0; i < tracks.length; i++) {
      if (matchLang(tracks[i], preferred)) return i;
    }
  }
  return 0;
}

/**
 * Preference-driven subtitle pick at load time: the first cue-bearing track
 * in the preferred language, else -1 (off).
 */
export function pickSubtitleTrack(
  tracks: { language?: string; languageCode?: string; cues?: unknown[] }[],
  preferred: string | null | undefined
): number {
  if (!preferred || !tracks.length) return -1;
  const want = preferred.toLowerCase();
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t || !t.cues || t.cues.length === 0) continue;
    const code = (t.languageCode || "").toLowerCase();
    const name = (t.language || "").toLowerCase();
    if (code === want || name === want) return i;
  }
  return -1;
}
