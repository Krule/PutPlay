export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

/**
 * Parse WebVTT (and SRT, which is WEBVTT minus the header) into a sorted list
 * of cues. Pure + synchronous — safe to run in a worker later if needed.
 * Tolerates: missing WEBVTT header, comma ms in SRT, NOTE/STYLE/REGION blocks,
 * inline positioning tags, and cue identifiers.
 */
export function vttToCues(text: string): SubtitleCue[] {
  let cleaned = text.replace(/^\ufeff/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // normalise to a header-less cue list (VTT header + SRT are the same grammar)
  if (!/^WEBVTT/i.test(cleaned)) cleaned = "WEBVTT\n\n" + cleaned;
  // strip only the header line + meta lines (a cue ID may sit between header and first cue)
  cleaned = cleaned.replace(/^WEBVTT[ \t]*\n?/, "").replace(/^(?:Kind|Language|PlayerOffset):[^\n]*\n/gm, "");
  const blocks = cleaned.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    const firstLine = block.split("\n")[0];
    if (/^(NOTE|STYLE|REGION)\b/i.test(firstLine)) continue;
    const lines = block.split("\n");
    let ti = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("-->")) { ti = i; break; }
    }
    if (ti === -1) continue;
    const parts = lines[ti].split("-->").map((p) => p.trim().split(/\s+/)[0]);
    if (parts.length < 2) continue;
    const s = parseTime(parts[0]);
    const e = parseTime(parts[1]);
    if (s < 0 || e <= s) continue;
    const body = lines.slice(ti + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (!body) continue;
    cues.push({ start: s, end: e, text: body });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** "H:MM:SS.mmm" (VTT/SRT) or "MM:SS.mmm" → seconds. Comma ms (SRT) accepted. */
function parseTime(s: string): number {
  const m = s.trim().match(/^(?:(\d{1,4}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return -1;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const frac = m[4] ? parseInt(m[4].padEnd(3, "0"), 10) / 1000 : 0;
  if (min > 59 || sec > 59) return -1;
  return h * 3600 + min * 60 + sec + frac;
}

/** The cue active at time t, or null. Binary search over sorted cues. */
export function cueAt(cues: SubtitleCue[], t: number): SubtitleCue | null {
  if (!cues.length) return null;
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid];
    if (t < c.start) hi = mid - 1;
    else if (t > c.end) lo = mid + 1;
    else return c;
  }
  return null;
}

/** ASS/SSA → no renderable cues (styling isn't convertible); we show none. */
export function assToCues(_ass: string): SubtitleCue[] {
  return [];
}

/** Format content (srt/vtt/ass/…) + text → cues, using the right parser. */
export function subtitlesToCues(content: string, format: string): SubtitleCue[] {
  const f = (format || "").toLowerCase();
  if (f === "ass" || f === "ssa") return assToCues(content);
  const trimmed = content.trimStart();
  if (trimmed.startsWith("WEBVTT") || f === "vtt") {
    // VTT and SRT share the block grammar once the header is normalised
    return vttToCues(trimmed);
  }
  // srt / sub / unknown → treat as SRT blocks
  return vttToCues("WEBVTT\n\n" + content);
}

export interface LoadedSubtitle {
  id: string;
  language: string;
  languageCode: string;
  name: string;
  url: string;
  format: string;
  /** Where put.io says this subtitle came from ("OpenSubtitles", "upload", …). */
  source?: string;
  blobURL?: string; // created after conversion
  cues?: SubtitleCue[]; // parsed for the self-rendered overlay
}

/**
 * BUG 4: put.io returns OpenSubtitles *suggestions* for files that have no
 * real subtitles. Suggestion sources are labelled in the UI so the user can
 * tell them apart from subs that actually belong to the video.
 */
export function subtitleSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  if (/opensubtitles/i.test(source)) return "OpenSubtitles";
  return null;
}

/**
 * Which subtitle track to select automatically: only one whose language
 * matches the user's preference *and* which actually parsed into cues. An
 * arbitrary OpenSubtitles match in another language is never auto-selected
 * (that's the "bogus subtitles" bug); when nothing matches, subs start off.
 */
export function pickSubtitleDefault(
  tracks: { language: string; languageCode: string; cues?: SubtitleCue[] }[],
  preferredLangs: string[]
): number {
  if (!tracks.length || !preferredLangs.length) return -1;
  const wanted = preferredLangs.map((l) => l.toLowerCase());
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t || !t.cues || t.cues.length === 0) continue;
    const code = (t.languageCode || "").toLowerCase();
    const name = (t.language || "").toLowerCase();
    if (wanted.includes(code) || wanted.includes(name)) return i;
  }
  return -1;
}

export interface SubtitleSource {
  cues: SubtitleCue[];
  blobURL?: string; // best-effort native <track> fallback
}

/**
 * Fetch a put.io subtitle file and parse it.
 *  - cues: for the self-rendered overlay (primary — the webview's native
 *    <track src> is unreliable for cross-origin/progressive sources).
 *  - blobURL: a WebVTT blob kept for environments where a native track works.
 */
export async function loadSubtitle(
  contentUrl: string,
  format: string
): Promise<SubtitleSource | null> {
  try {
    const res = await fetch(contentUrl);
    if (!res.ok) return null;
    const text = await res.text();
    const cues = subtitlesToCues(text, format);
    let blobURL: string | undefined;
    try {
      // SRT → VTT for the native-track fallback; keep raw text otherwise
      const vtt = text.trimStart().startsWith("WEBVTT")
        ? text
        : "WEBVTT\n\n" + (format && format.toLowerCase() !== "vtt" ? text.replace(/^WEBVTT/i, "") : text);
      blobURL = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    } catch {
      blobURL = undefined;
    }
    return { cues, blobURL };
  } catch {
    return null;
  }
}
