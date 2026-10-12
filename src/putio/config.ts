/**
 * Playback preference decisions (pure — no DOM/webOS imports, testable in
 * node). The Svelte store lives in src/store/config.ts and wraps these.
 *
 *  - source: which stream to start from (original / put.io mp4 / hls)
 *  - audioLang / subtitleLang: preferred language code or display name
 *    ("" = no preference); they steer auto-selection of tracks
 *  - subScale: DOM-overlay subtitle font scale (1 = default)
 *  - audioFallback: what to do when the original file can't switch audio
 *    ("ask" = honest refusal + the row offers the put.io stream;
 *    "auto-hls" = go straight to the put.io rendition of the chosen language)
 */

export interface ConfigState {
  source: "original" | "mp4" | "hls";
  audioLang: string;
  subtitleLang: string;
  subScale: number;
  audioFallback: "ask" | "auto-hls";
}

export const DEFAULT_CONFIG: ConfigState & { subScaleMin: number; subScaleMax: number } = {
  source: "original",
  audioLang: "",
  subtitleLang: "",
  subScale: 1,
  audioFallback: "ask",
  subScaleMin: 0.8,
  subScaleMax: 2,
};

/**
 * The subtitle size ladder — the single shared source for the Settings
 * chips and the in-player subtitle panel (issue: size selection directly on
 * the player). Every value must stay inside subScaleMin/Max: a value outside
 * the clamp would be silently re-clamped on the next load and the UI would
 * show the wrong row selected.
 */
export const SUB_SCALE_OPTIONS: { v: number; label: string }[] = [
  { v: 0.8, label: "Small" },
  { v: 1, label: "Default" },
  { v: 1.35, label: "Large" },
  { v: 1.8, label: "XL" },
];

const SOURCE_KINDS = ["original", "mp4", "hls"] as const;
const AUDIO_FALLBACKS = ["ask", "auto-hls"] as const;

/** Merge user input onto defaults, coercing to the stored shape. */
export function normalizeConfig(partial: Partial<ConfigState> | null | undefined): ConfigState {
  const d = DEFAULT_CONFIG;
  const p = partial || {};
  const source = (SOURCE_KINDS as readonly string[]).includes(p.source || "")
    ? (p.source as ConfigState["source"])
    : d.source;
  const scale = typeof p.subScale === "number" && !isNaN(p.subScale) ? p.subScale : d.subScale;
  const audioFallback = (AUDIO_FALLBACKS as readonly string[]).includes(p.audioFallback || "")
    ? (p.audioFallback as ConfigState["audioFallback"])
    : d.audioFallback;
  return {
    source,
    audioLang: (p.audioLang ?? "").trim(),
    subtitleLang: (p.subtitleLang ?? "").trim(),
    subScale: Math.min(d.subScaleMax, Math.max(d.subScaleMin, scale)),
    audioFallback,
  };
}

/** Does a track's language satisfy the preference? "" / null = no preference. */
export function matchLang(
  track: { lang?: string | null; code?: string | null; label?: string | null } | null | undefined,
  preferred: string | null | undefined
): boolean {
  if (!preferred) return true;
  if (!track) return false;
  const want = preferred.toLowerCase().trim();
  if (!want) return true;
  const code = (track.code || track.lang || "").toLowerCase().trim();
  // 1) exact ISO code match (the form both sides normally use)
  if (code && code === want) return true;
  // 2) label/title match: the webview exposes the MKV track title
  //    ("English AC-3 5.1") even when the language code comes through
  //    empty or 2-letter — the EAAAO regression where code-only matching
  //    silently missed and a configured preference did nothing
  const label = (track.label || "").toLowerCase();
  if (label && (label === want || label.indexOf(want) !== -1)) return true;
  return false;
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
    // a preference that matches NO track must not force track 0 (a switch
    // nobody asked for) — -1 = play the file's own default track
    return -1;
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
