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

/**
 * ASS/SSA → cues. MKV-embedded softsubs (put.io `source: "mkv"`) are usually
 * ASS/SSA, so without this the original-source path had no renderable cues.
 *
 * We read only the `[Events]` section, learn the column layout from its
 * `Format:` line (falling back to the standard 10-column order when absent,
 * e.g. classic SSA), and treat everything from the `Text` column onward as
 * the cue body — that is what keeps commas inside the text intact. Override
 * blocks `{\…}` are stripped and `\N`/`\n`/`\h` become newline/space.
 */
export function assToCues(ass: string): SubtitleCue[] {
  const text = (ass || "").replace(/^\ufeff/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events = text.match(/\[Events\][\s\S]*?(?=\n\[[^\]]+\]|$)/i);
  if (!events) return [];
  const section = events[0];

  // Column layout from the section's own Format: line; standard order otherwise.
  let startIdx = 1;
  let endIdx = 2;
  let textStart = 9; // Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
  const fmt = section.match(/^\s*Format:\s*(.+)$/im);
  if (fmt) {
    const cols = fmt[1].split(",").map((c) => c.trim().toLowerCase());
    const si = cols.indexOf("start");
    const ei = cols.indexOf("end");
    const ti = cols.indexOf("text");
    if (si !== -1) startIdx = si;
    if (ei !== -1) endIdx = ei;
    if (ti !== -1) textStart = ti;
  }

  const cues: SubtitleCue[] = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^\s*Dialogue:\s*(.*)$/i);
    if (!m) continue;
    const parts = m[1].split(",");
    if (parts.length <= textStart) continue;
    const start = parseTime(parts[startIdx]);
    const end = parseTime(parts[endIdx]);
    if (start < 0 || end <= start) continue;
    const clean = cleanAssText(parts.slice(textStart).join(","));
    if (!clean) continue;
    cues.push({ start, end, text: clean });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** Strip ASS override blocks + text escapes into plain renderable text. */
function cleanAssText(raw: string): string {
  let t = raw;
  t = t.replace(/\{[^{}]*\}/g, ""); // override blocks: {\\pos(…)}, {\\fad(…)} — before escapes
  t = t.replace(/\\N/gi, "\n"); // \\N / \\n → newline
  t = t.replace(/\\H/gi, " "); // \\h → space
  t = t.replace(/\\/g, ""); // stray backslashes → drop
  const lines = t
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim());
  return lines.filter((l) => l.length > 0).join("\n").trim();
}

/**
 * Identify what a subtitle file ACTUALLY is, by its content — not the
 * declared format: ASS/SSA content (the `[Script Info]` header) ships in
 * files named .srt all the time, and put.io declares the format from the
 * file name, so "srt" content can be an ASS script. The header is checked
 * in the first lines only (an SRT cue mentioning "[Script Info]" mid-file
 * is not an ASS script). WEBVTT header → vtt; anything else → srt (the
 * block grammar both SRT and put.io's converted files share).
 */
export function detectSubtitleFormat(content: string): "vtt" | "srt" | "ass" {
  const text = (content || "").replace(/^\ufeff/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const head = text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(0, 40)
    .join("\n");
  if (/\[\s*Script\s+Info\s*\]/i.test(head)) return "ass";
  if (/^\s*WEBVTT/i.test(text)) return "vtt";
  return "srt";
}

/**
 * Format content (srt/vtt/ass/…) → cues. The CONTENT decides the parser:
 * a file declared "srt" that is actually an ASS script must still parse
 * (see detectSubtitleFormat); the declared format only decides what an
 * unidentifiable body gets.
 */
export function subtitlesToCues(content: string, format: string): SubtitleCue[] {
  const detected = detectSubtitleFormat(content);
  if (detected === "ass") return assToCues(content);
  const f = (format || "").toLowerCase();
  if (detected === "vtt" || f === "vtt") {
    // VTT and SRT share the block grammar once the header is normalised
    return vttToCues(content.trimStart());
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
 * Rank subtitle sources for presentation: tracks embedded in the MKV
 * container come first (they belong to the video), then folder uploads,
 * then OpenSubtitles suggestions. Stable within a group.
 */
export function orderSubtitleSources<T extends { source?: string | null }>(
  subs: T[]
): T[] {
  const rank = (s: T): number => {
    const src = (s.source || "").toLowerCase();
    if (src === "mkv") return 0;
    if (src === "folder") return 1;
    if (src === "opensubtitles") return 2;
    return 3;
  };
  return subs
    .map((s, i) => [s, i] as const)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map((p) => p[0]);
}

/**
 * BUG 4: put.io returns OpenSubtitles *suggestions* for files that have no
 * real subtitles. Suggestion sources are labelled in the UI so the user can
 * tell them apart from subs that actually belong to the video. MKV-embedded
 * tracks get the opposite label — they ARE the video's own subtitles.
 */
export function subtitleSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  if (/mkv/i.test(source)) return "Embedded";
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

/**
 * The languages the subtitle SEARCH is asked for: the union of the language
 * the user set in the APP (config.subtitleLang) and the put.io web account's
 * subtitle languages. The query used to send the account list alone, so a
 * preference set only in the app was never requested — and the selection
 * step (which does honour it) then had nothing to pick. Rules: trim + drop
 * empties, dedupe case-insensitively keeping the account list's order, the
 * app preference goes first when it is not already there.
 */
export function unionSubtitleLanguages(preferred: string, accountLangs: string[]): string[] {
  const cleaned = (accountLangs || [])
    .map((l) => (l || "").trim())
    .filter((l) => l !== "");
  const want = (preferred || "").trim();
  if (!want) return cleaned;
  if (cleaned.some((l) => l.toLowerCase() === want.toLowerCase())) return cleaned;
  return [want, ...cleaned];
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
    // The CONTENT decides: an ASS script (whatever the file is named)
    // cannot be fed to a native <track> as a pseudo-VTT — the overlay owns it.
    if (detectSubtitleFormat(text) === "ass") return { cues, blobURL: undefined };
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
