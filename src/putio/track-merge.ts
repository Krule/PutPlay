// The audio panel's single source of truth: one row per audio stream in the
// FILE, built from three inputs —
//
//   native `audioTracks`   what the TV's pipeline exposes (undecodable codecs
//                          like DTS on webOS 6 are HIDDEN — they never appear
//                          here, which is why a file can "have" a track the
//                          old panel never showed)
//   put.io media_info      what is actually in the file (codec/language/title
//                          per stream — ffmpeg-probe shape)
//   HLS manifest renditions the per-language "via put.io stream" fallback
//                          (put.io packages each audio stream as its own
//                          EXT-X-MEDIA:TYPE=AUDIO rendition)
//
// Pure and DOM-free so it is testable in node; the engine re-runs the merge
// whenever any input changes.

import { LANGUAGES } from "./languages";

export interface NativeAudioTrack {
  enabled: boolean;
  label: string;
  lang?: string | null;
}

export interface MetaAudioStream {
  codec?: string | null;
  language?: string | null;
  title?: string | null;
  channels?: number | null;
}

export interface HlsAudioRef {
  name: string | null;
  lang: string | null;
}

export interface AudioPanelRow {
  /** Stable id: the native track it maps to ("n<i>") or the meta stream ("m<i>"). */
  key: string;
  label: string;
  /** Best-known language: 3-letter code or display name, "" when unknown. */
  lang: string;
  /** "" when unknown. */
  codec: string;
  /** Index in video.audioTracks, -1 = the webview does not expose it. */
  nativeIndex: number;
  /** Index in the HLS audio renditions, -1 = none matches. */
  hlsIndex: number;
  /** Codec the webOS 6 webview demonstrably cannot decode (DTS, TrueHD, …). */
  undecodable: boolean;
  /** True when the row exists only because of metadata (not natively switchable). */
  hlsOnly: boolean;
}

/**
 * put.io `media_info` is ffmpeg-probe shaped; this keeps only what the panel
 * needs (audio streams, codec/language/title/channels). Tolerates missing
 * fields — the merge degrades, it never throws.
 */
export function audioStreamsFromMediaInfo(
  mediaInfo: { streams?: unknown } | null | undefined
): MetaAudioStream[] {
  const raw = (mediaInfo && (mediaInfo as { streams?: unknown[] }).streams) || [];
  const out: MetaAudioStream[] = [];
  for (const s of raw as Array<Record<string, any>>) {
    if (!s || s.codec_type !== "audio") continue;
    const tags = s.tags || {};
    out.push({
      codec: s.codec_name || null,
      language: tags.language || tags.lang || null,
      title: tags.title || null,
      channels: typeof s.channels === "number" ? s.channels : null,
    });
  }
  return out;
}

/** ISO 639-1 → ISO 639-2/T for the languages that actually show up in
 *  multi-audio releases (manifests use 2-letter codes, put.io media_info
 *  uses 3-letter). */
const ISO23: Record<string, string> = {
  en: "eng", es: "spa", fr: "fre", de: "deu", it: "ita", pt: "por",
  ru: "rus", ja: "jpn", zh: "chi", ko: "kor", ar: "ara", hi: "hin",
  nl: "nld", pl: "pol", tr: "tur", sv: "swe", no: "nor", da: "dan",
  fi: "fin", cs: "cze", hu: "hun", ro: "ron", el: "ell", he: "heb",
  uk: "ukr", th: "tha", vi: "vie", id: "ind", bn: "ben", ta: "tam",
  te: "tel", mr: "mar", gu: "guj", fa: "fas", ur: "urd", sk: "slk",
  sl: "slv", sr: "srp", hr: "hrv", bs: "bos", mk: "mkd", sq: "alb",
  ca: "cat", gl: "glg", eu: "eus", et: "est", lv: "lav", lt: "lit",
  bg: "bul", ms: "msa", hy: "hye", ka: "kat", mn: "mon", ne: "npi",
  af: "afr", sw: "swa", si: "sin",
};

const PLAYABLE_ON_WEBOS6 = [
  "aac", "mp3", "mp2", "ac3", "eac3", "opus",
  "pcm_s16le", "pcm_s24le", "pcm",
];

/**
 * Can the webOS 6 webview (C1) decode this codec natively?
 * true  = yes (evidence: Jellyfin's webOS device profile)
 * false = no — the webview hides such tracks from `audioTracks`
 * null  = unknown — the TV *may* still decode it
 */
export function codecPlayableOnWebOS6(codec: string | null | undefined, channels?: number | null): boolean | null {
  const c = (codec || "").toLowerCase().trim();
  if (!c) return null;
  if (PLAYABLE_ON_WEBOS6.indexOf(c) !== -1) return true;
  if (c === "flac") return channels == null ? true : channels <= 2;
  if (c === "dca" || c.indexOf("dts") === 0 || c === "truehd" || c === "mlp") return false;
  return null;
}

/** Canonical 3-letter code for a language hint (2-letter, 3-letter, or an
 *  English display name). "" when not recognizable. */
function canonicalLang(s: string): string {
  const t = s.toLowerCase().trim();
  if (!t) return "";
  if (ISO23[t]) return ISO23[t];
  if (/^[a-z]{3}$/.test(t)) return t;
  const hit = LANGUAGES.find((l) => l.label.toLowerCase() === t);
  return hit ? hit.code : "";
}

/** Do two language hints (code or display name, either letter width) refer to
 *  the same language? */
export function langMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const A = a.toLowerCase().trim();
  const B = b.toLowerCase().trim();
  if (!A || !B) return false;
  if (A === B) return true;
  const ca = canonicalLang(A);
  const cb = canonicalLang(B);
  return !!(ca && cb && ca === cb);
}

/** Display-name match for HLS renditions vs file metadata: exact, or one is
 *  a ≥4-char substring of the other ("Spanish" in "Spanish (DTS)"). */
function nameMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const A = (a || "").toLowerCase().trim();
  const B = (b || "").toLowerCase().trim();
  if (!A || !B) return false;
  if (A === B) return true;
  const short = A.length <= B.length ? A : B;
  const long = A.length <= B.length ? B : A;
  return short.length >= 4 && long.indexOf(short) !== -1;
}

/** "spa" → "Spanish"; ""/garbage → "". */
export function langDisplay(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.toLowerCase().trim();
  const code = ISO23[t] || (/^[a-z]{3}$/.test(t) ? t : "");
  if (code) {
    const hit = LANGUAGES.find((l) => l.code === code);
    if (hit) return hit.label;
  }
  return /^[a-z][a-z ]+$/i.test(t) ? s : "";
}

/** Which native track does this meta stream correspond to? Language match
 *  first (skipping already-taken tracks), then the ordinal position (the
 *  k-th audio stream in the file ↔ the k-th track the webview exposes). */
function matchNativeIndex(ordinal: number, m: MetaAudioStream, native: NativeAudioTrack[], used: Set<number>): number {
  for (let i = 0; i < native.length; i++) {
    if (!used.has(i) && m.language && native[i].lang && langMatches(m.language, native[i].lang)) return i;
  }
  return ordinal < native.length && !used.has(ordinal) ? ordinal : -1;
}

/**
 * Build the panel rows. Meta (media_info) is the source of truth for "what
 * is in the file" — when it is missing (fetch failed) the rows degrade to
 * the native list, and when there is no native list at all (webview exposes
 * nothing) the rows are metadata-only (HLS-only).
 */
export function mergeAudioRows(
  native: NativeAudioTrack[] | null | undefined,
  meta: MetaAudioStream[] | null | undefined,
  hls: HlsAudioRef[] | null | undefined
): AudioPanelRow[] {
  const nat = native || [];
  const mStreams = meta || [];
  const rends = hls || [];
  const hasMeta = mStreams.length > 0;
  const usedNative = new Set<number>();
  const usedHls = new Set<number>();
  const rows: AudioPanelRow[] = [];

  const pushRow = (
    key: string,
    nativeIndex: number,
    m: MetaAudioStream | null
  ): void => {
    const n = nativeIndex >= 0 ? nat[nativeIndex] : null;
    const code = (m && m.codec) || "";
    const lang = (m && m.language) || (n && n.lang) || "";
    const label =
      (n && n.label) ||
      (m && m.title) ||
      langDisplay(lang) ||
      "Track " + (rows.length + 1);
    let hlsIndex = -1;
    for (let i = 0; i < rends.length; i++) {
      if (usedHls.has(i)) continue;
      const r = rends[i];
      if (langMatches(lang, r.lang) || (label && r.name && nameMatches(label, r.name))) {
        hlsIndex = i;
        usedHls.add(i);
        break;
      }
    }
    rows.push({
      key,
      label,
      lang,
      codec: code,
      nativeIndex,
      hlsIndex,
      undecodable: codecPlayableOnWebOS6(code, m && m.channels) === false,
      hlsOnly: nativeIndex === -1,
    });
  };

  if (hasMeta) {
    for (let i = 0; i < mStreams.length; i++) {
      const ni = matchNativeIndex(i, mStreams[i], nat, usedNative);
      if (ni >= 0) usedNative.add(ni);
      pushRow(ni >= 0 ? "n" + ni : "m" + i, ni, mStreams[i]);
    }
    // defensive: a native track with no meta counterpart still gets a row
    for (let i = 0; i < nat.length; i++) {
      if (!usedNative.has(i)) pushRow("n" + i, i, null);
    }
  } else {
    for (let i = 0; i < nat.length; i++) pushRow("n" + i, i, null);
  }
  return rows;
}

/**
 * Which row is "on": native source → the row carrying the enabled native
 * track index; HLS source → the row carrying that rendition index.
 */
export function activeRowKey(
  rows: AudioPanelRow[],
  kind: "native" | "hls",
  index: number
): string | null {
  if (index < 0) return null;
  for (let i = 0; i < rows.length; i++) {
    if (kind === "native" && rows[i].nativeIndex === index) return rows[i].key;
    if (kind === "hls" && rows[i].hlsIndex === index) return rows[i].key;
  }
  return null;
}

/**
 * Which hls.js audio track should be enabled for `lang`? Matches by
 * language code first (2/3-letter, either side), then by the language's
 * display name against the track name ("Spanish (DTS)" counts). -1 = no
 * match: the stream keeps its default rendition.
 */
export function pickHlsAudioTrackIndex(
  tracks: { name?: string | null; lang?: string | null }[] | null | undefined,
  lang: string | null | undefined
): number {
  if (!tracks || !tracks.length || !lang) return -1;
  const want = lang.trim();
  if (!want) return -1;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (t && t.lang && langMatches(t.lang, want)) return i;
  }
  const display = langDisplay(want);
  if (display) {
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t && t.name && nameMatches(t.name, display)) return i;
    }
  }
  return -1;
}

/**
 * The row's state hint — the five states of the UX contract, in priority
 * order: `on` / `Switching…` / `on this TV` / `via put.io stream` /
 * `TV can't decode (CODEC)`. Pure: the markup just calls this.
 *
 *  - active: the row the engine confirmed as playing
 *  - switching: the escalation is running for this row
 *  - nativeIndex >= 0: the TV decodes it natively (switchable in place)
 *  - hlsIndex >= 0: only the put.io stream has it (a rendition matches)
 *  - otherwise: undecodable here and the stream has no rendition either —
 *    say so, with the codec when we know it
 */
export function panelRowHint(
  row: AudioPanelRow,
  state: { active?: boolean; switching?: boolean } = {}
): string {
  if (state.active) return "on";
  if (state.switching) return "Switching\u2026";
  if (row.nativeIndex >= 0) return "on this TV";
  if (row.hlsIndex >= 0) return "via put.io stream";
  return row.codec ? `TV can't decode (${row.codec.toUpperCase()})` : "TV can't decode";
}
