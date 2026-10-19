/**
 * put.io file name → show title + season/episode (pure — no DOM/webOS
 * imports, testable in node).
 *
 * The file name is the only identity the player has before the lookup, so
 * this parser decides whether a video is a resolvable EPISODE at all: a name
 * without an episode marker (a movie, a sample clip, an image) is not one,
 * and the honest answer is null — the skip-segments feature stays off for
 * it. Folder-bare names ("Season 1/01.mkv") carry no marker either; v1 only
 * parses the file name itself.
 *
 * The patterns people actually use:
 *   "Show.Name.S01E05.720p.mkv"   season + episode (the dominant form)
 *   "Show.Name.2x05.1080p.mkv"    the same, x-separated
 *   "One.Piece.E1045.720p.mp4"    episode only — anime convention, season 1
 *   "[SubsPlease] Black Clover - 171 (1080p) [7AD4AFC7].mkv"
 *                                 anime BARE number (no E/S marker) — the
 *                                 dominant anime scene form; also "Title 171"
 *                                 and "Title.171.1080p". Season 1. A bare
 *                                 1–2 digit number is NOT trusted without a
 *                                 [Group] tag — "Show 2" is a sequel, not
 *                                 an episode. Resolutions (720/1080/…),
 *                                 years (1900–2099) and decimals ("1.5")
 *                                 never count as episode numbers. Neither
 *                                 does a broken codec tail ("H 264" — the
 *                                 number is H.264, not an episode).
 *   "My.Show.(2021).S01E01.mkv"   an optional (year) tag, for disambiguation
 */

export interface EpisodeId {
  title: string;
  season: number;
  episode: number;
  /** A (year) tag in the name, for TMDb disambiguation (absent when none). */
  year?: number;
}

const EXT_RE = /\.(mkv|mp4|avi|mov|mpg|mpeg|webm|m4v|wmv|flv|ts|ogv)$/i;
/** S01E05 / S1E5 — season + episode in one marker. */
const SE_RE = /(^|[.\s_-])S(\d{1,2})\s*E(\d{1,3})(?=[.\s_-]|$)/i;
/** 2x05 — x-separated season + episode. */
const NX_RE = /(^|[.\s_-])(\d{1,2})x(\d{1,3})(?=[.\s_-]|$)/;
/** E1045 / EP07 — episode only (anime). 4 digits: One Piece is past 1000. */
const EO_RE = /(^|[.\s_-])E(?:P)?(\d{1,4})(?=[.\s_-]|$)/i;
/** (1999) / (2024) — the year tag. */
const YEAR_RE = /\((19|20)\d{2}\)/;
/** Leading anime release-group tag(s): [SubsPlease], [Crunchyroll] … */
const GROUP_LEAD_RE = /^(?:\[[^\]]{1,40}\]\s*)+/;
/** A trailing bracket/paren tag: (1080p) [7AD4AFC7] [HEVC] (UW) … */
const TAG_TAIL_RE = /[\(\[][^()\[\]]{1,40}[\)\]]\s*$/;
/** A trailing quality token: 1080p / 720 / 4k / uhd … (with its separator). */
const QUALITY_TAIL_RE = /(?:^|[.\s_-])(?:\d{3,4}p|4k|uhd|480|720|1080|1440|2160|3840)$/i;
/** A trailing scene word: the release-group tail (GPRS, Licdom …). */
const WORD_TAIL_RE = /[A-Za-z][\w-]*\s*$/;
/** The broken scene codec form at the tail: "H 264" / "X 265" — space OR
 *  dot/hyphen splits ("H.264"), plus a dangling separator left behind by
 *  the group-word strip ("…H 264-"). The number is the CODEC (H.264/
 *  H.265), never an episode: "…1990 H 264-GPRS" is a movie, not S1 E264.
 *  (The solid form "H264" is one word — WORD_TAIL_RE already peels it. */
const CODEC_TAIL_RE = /(^|[.\s_-])[hx][.\s_-]?26[45][.\s_-]*$/i;

/**
 * Case/punctuation-free form — "Black.Clover!" and "black clover" match.
 * The one normalization every title comparison (matchers, cache keys)
 * shares.
 */
export function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Collapse case and whitespace for the RAW tie — keeps the punctuation
 * normTitle discards, and that is exactly what can carry title meaning
 * ("Gintama." ≠ "Gintama°").
 */
export function normTitleRaw(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** A season longer than this is a special case, not a season. */
const SEASON_MAX = 60;
/** The SxxEyy / NxNy form's episode cap (the episode-only form allows more). */
const SE_EP_MAX = 999;
/** Episode-only names run as long as One Piece. */
const EO_EP_MAX = 5000;
/** Resolutions — a trailing number with one of these values is a tag, not
 *  an episode. */
const RESOLUTIONS = new Set([480, 720, 1080, 1440, 2160, 3840]);

export function parseEpisode(name: string): EpisodeId | null {
  const base = name.replace(EXT_RE, "").trim();
  if (!base) return null;

  const yearMatch = base.match(YEAR_RE);
  const year = yearMatch ? parseInt(yearMatch[0].slice(1, -1), 10) : undefined;

  const se = base.match(SE_RE);
  const nx = se ? null : base.match(NX_RE);
  const eo = se || nx ? null : base.match(EO_RE);
  const bare = !se && !nx && !eo ? bareNumber(base) : null;
  if (!se && !nx && !eo && !bare) return null; // no episode marker — not an episode

  let season: number;
  let episode: number;
  let titleEnd: number; // the title is everything BEFORE this offset
  if (se || nx) {
    const m = se || nx;
    if (m[1] === "") return null; // no title before the marker
    titleEnd = m.index;
    season = parseInt(m[2], 10);
    episode = parseInt(m[3], 10);
    if (!inRange(season, 1, SEASON_MAX) || !inRange(episode, 1, SE_EP_MAX)) return null;
  } else if (eo) {
    if (eo[1] === "") return null;
    titleEnd = eo.index;
    season = 1;
    episode = parseInt(eo[2], 10);
    if (!inRange(episode, 1, EO_EP_MAX)) return null;
  } else {
    // the anime bare number ("Title - 171"); its guards live in bareNumber
    titleEnd = bare.titleEnd;
    season = 1;
    episode = bare.episode;
    if (!inRange(episode, 1, EO_EP_MAX)) return null;
  }

  const title = titleOf(base.slice(0, titleEnd));
  if (!title) return null;
  return year ? { title, season, episode, year } : { title, season, episode };
}

/**
 * The anime-style bare episode number: the LAST number in the name, after
 * the trailing tags are peeled — "…Title - 171", "…Title 171",
 * "…Title.171". A number that is a resolution (720/1080/…), a year
 * (1900–2099), the tail of a decimal ("1.5"), or the half of a broken
 * codec token ("H 264" / "X 265" — peeled off the tail, never a
 * candidate) is not an episode; a 1–2 digit number is not trusted without
 * a [Group] tag (sequel risk — "Show 2"). Returns null when the name
 * carries no usable bare number.
 */
/**
 * Peel the scene junk off the END of the name, one known token at a time
 * (bracket tags, quality, the broken codec form, group words) — scene junk
 * stacks ("…171 (1080p) [7AD4AFC7] GPRS") — until nothing known is left.
 * The number that survives at the tail is then judged by the bare-
 * episode parsers. Stripping is tail-only, so prefix offsets are stable.
 */
function peelTail(base: string): string {
  let t = base;
  let changed = true;
  while (changed) {
    changed = false;
    while (TAG_TAIL_RE.test(t)) {
      t = t.replace(TAG_TAIL_RE, "");
      changed = true;
    }
    if (QUALITY_TAIL_RE.test(t)) {
      t = t.replace(QUALITY_TAIL_RE, "");
      changed = true;
    }
    if (CODEC_TAIL_RE.test(t)) {
      t = t.replace(CODEC_TAIL_RE, "");
      changed = true;
    }
    if (WORD_TAIL_RE.test(t)) {
      t = t.replace(WORD_TAIL_RE, "");
      changed = true;
    }
  }
  return t.replace(/[.\s_-]+$/, "").trim();
}

function bareNumber(base: string): { episode: number; titleEnd: number } | null {
  const hadGroup = GROUP_LEAD_RE.test(base);
  const t = peelTail(base);
  const m = t.match(/(^|[.\s_-])(\d{1,4})$/);
  if (!m) return null; // nothing number-shaped left at the end
  const episode = parseInt(m[2], 10);
  if (RESOLUTIONS.has(episode)) return null;
  if (episode >= 1900 && episode <= 2099) return null;
  if (m[1] === "." && /\d/.test(t.charAt(m.index - 1) || "")) return null; // "1.5"
  if (episode <= 99 && !hadGroup) return null;
  return { episode, titleEnd: m.index };
}

/**
 * The RELAXED bare episode — the scene-bare form "Title - 01 [1080p][HASH]":
 * a 1–2 digit tail number the strict parser refuses without a LEADING group
 * tag. Here the number is an episode when it is ZERO-PADDED (a sequel is
 * never "Show 02") or DASH-SEPARATED (the "- NN" anime pattern; a sequel
 * is "Show 2", never "Show - 2"). The parse alone decides NOTHING: the
 * caller (the segment lookup) must still resolve the title to a real show,
 * and a name whose title matches nothing gets no segments. Used ONLY by
 * the segment lookup — parseEpisode (title view, info tab) stays strict.
 */
export function parseBareEpisode(
  name: string
): { title: string; season: number; episode: number; year?: number } | null {
  const base = name.replace(EXT_RE, "").trim();
  if (!base) return null;
  const t = peelTail(base);
  const m = t.match(/(^|[.\s_-])(\d{1,2})$/);
  if (!m) return null; // nothing 1–2 digit-shaped left at the end
  const episode = parseInt(m[2], 10);
  if (RESOLUTIONS.has(episode)) return null;
  if (episode >= 1900 && episode <= 2099) return null;
  if (m[1] === "." && /\d/.test(t.charAt(m.index - 1) || "")) return null; // "1.5"
  const zeroPadded = m[2].length === 2 && m[2].charAt(0) === "0";
  const dashSeparated = t.slice(0, m.index).endsWith("-");
  if (!zeroPadded && !dashSeparated) return null; // "Show 2" — sequel risk
  const title = titleOf(base.slice(0, m.index));
  if (!title) return null; // no title before the number
  return { title, season: 1, episode };
}

/** Inclusive integer range check (out-of-range numbers are garbage, not an episode). */
function inRange(n: number, lo: number, hi: number): boolean {
  return n >= lo && n <= hi;
}

export interface MovieId {
  title: string;
  /** A year tag in the name (paren or dot-separated) — for TMDb
   *  disambiguation (absent when none). */
  year?: number;
}

/** Codec/source words that ride after the title in a release name — the
 *  KNOWN junk vocabulary. Only these words are stripped from the tail;
 *  an unknown trailing word survives (it may be the title: "Web (1995)").
 *
 * This list OVERLAPS JUNK_TOKEN_RE on purpose: the movie tail loop peels
 * known junk so a DOT-separated trailing year becomes visible
 * ("Movie.2020.x264.1080p" — the year is under the junk); JUNK_TOKEN_RE
 * cleans the same tags when they sit in the middle of the name. Two jobs,
 * two passes. */
const SCENE_WORD_RE =
  /\b(?:x264|x265|h264|h265|hevc|avc|remux|web-?dl|web-?rip|bluray|blu-ray|brrip|dvdrip|hdtv|uhd|4k|proper|re-?encod\w*|internal|multi|10bit)\s*$/i;

/**
 * Scene junk that rides ANYWHERE in a release name, not just the tail.
 *
 * Real names stack codec/source/audio/language tags between the title and
 * the group tail — "Kindergarten Cop 1990 1080p AMZN WEB-DL DDP2 0 H
 * 264-GPRS". TMDb's search answers 0 results for a junk-laden query
 * (verified live), so the title that becomes the query must be clean.
 *
 * The vocabulary is deliberately narrow — only tokens that would never
 * stand alone as a title word. "web" alone is NOT junk ("Web (1995)" is a
 * movie); "10" alone is NOT junk ("10 Cloverfield Lane") — only the
 * compound/phrase forms ("web-dl", "10 bit", "5.1") count. An unknown word
 * (a release group: "Licdom", "GPRS") survives; the lookup's query ladder
 * drops it as a last resort (stripping an unknown word here could eat a
 * real title word — the "Inception" bug).
 */
const JUNK_TOKEN_RE = new RegExp(
  [
    // resolutions
    "\\b\\d{3,4}p\\b",
    "\\b(?:480|720|1080|1440|2160|3840)\\b",
    "\\b4k\\b",
    "\\buhd\\b",
    // codecs — incl. broken scene forms: "H 264", "264-GPRS", "x264-GOP"
    "\\b[hx]\\s?26[45](?:-\\w+)?\\b",
    "\\b26[45]-\\w+\\b",
    "\\bhevc\\b",
    "\\bavc\\b",
    "\\bav1\\b",
    "\\bvp9\\b",
    // sources
    "\\bweb-?dl\\b",
    "\\bweb-?rip\\b",
    "\\bwebdl\\b",
    "\\bremux\\b",
    "\\bbluray\\b",
    "\\bblu-ray\\b",
    "\\bbrrip\\b",
    "\\bdvdrip\\b",
    "\\bhdtv\\b",
    "\\bamzn\\b",
    "\\bamz\\b",
    // audio
    "\\bac3\\b",
    "\\beac3\\b",
    "\\baac\\b",
    "\\bdts\\b",
    "\\btruehd\\b",
    "\\bflac\\b",
    "\\bmp3\\b",
    "\\bddp(?:\\s?\\d){0,2}\\b",
    "\\batmos\\b",
    "\\bdolby\\b",
    "\\bdv\\b",
    "\\bvision\\b",
    "\\bhdr10\\+?\\b",
    "\\bhdr\\b",
    "\\bsdr\\b",
    // channel counts: "5.1", "2.0", "7.1" — and their space-split forms
    // ("5 1"): the dot→space pass runs before this one. A bare decimal
    // like "1.5" is not a channel count.
    "\\b(?:2|5|7)[.\\s]\\d\\b",
    // language / subtitle tags
    "\\beng\\b",
    "\\bita\\b",
    "\\b(?:subs?)\\b",
    // quality flags
    "\\bproper\\b",
    "\\binternal\\b",
    "\\bmulti\\b",
    "\\b10bit\\b",
    "\\b8bit\\b",
    "\\b10\\s+bit\\b",
  ].join("|"),
  "gi" // global — a name stacks many tags; replace() must clear all of them
);

/**
 * The MOVIE half of the name identity: a name with NO episode marker
 * still needs a query for the Info tab's TMDb movie search — this gives
 * the movie title, plus a year when the name carries one.
 *
 * Same tail-cleaning spirit as the episode parser, but the tail is
 * stripped ITERATIVELY (scene junk can be stacked: "…1080p BluRay x264").
 * Year rules: a (19xx/20xx) PAREN year always wins; otherwise a
 * DOT-separated trailing year (1900–2099) — the common "Title.2010.1080p"
 * form. A SPACE-separated trailing year is kept in the title (it may be
 * part of the name).
 *
 * Known ambiguity (documented): "Blade.Runner.2049" — 2049 is inside the
 * year range but is part of the title. The year is stripped anyway; the
 * lookup degrades gracefully (the name search still runs, the exact-name
 * matcher decides). A name left with no title (numbers, scene words,
 * empty) is not a movie either — null.
 */
export function parseMovieName(name: string): MovieId | null {
  const base = name.replace(EXT_RE, "").trim();
  if (!base) return null;

  const yearMatch = base.match(YEAR_RE);
  const year = yearMatch ? parseInt(yearMatch[0].slice(1, -1), 10) : undefined;

  let t = base.replace(GROUP_LEAD_RE, "").replace(YEAR_RE, " ");
  let changed = true;
  while (changed) {
    changed = false;
    // a strip can leave a dangling separator — trim it so the NEXT token
    // is at the true tail (".Movie.720p." must see the 720p)
    t = t.replace(/[.\s_-]+$/, "").trim();
    if (TAG_TAIL_RE.test(t)) {
      t = t.replace(TAG_TAIL_RE, "").trim();
      changed = true;
    } else if (QUALITY_TAIL_RE.test(t)) {
      t = t.replace(QUALITY_TAIL_RE, "").trim();
      changed = true;
    } else if (SCENE_WORD_RE.test(t)) {
      t = t.replace(SCENE_WORD_RE, "").trim();
      changed = true;
    }
    // NOTE: no generic trailing-word strip — after the known junk is gone
    // the last word is TITLE (the "Inception" bug), and the known-word
    // list above is the junk vocabulary. An unknown trailing word survives
    // into the title; the fuzzy TMDb search copes.
  }

  // dot-separated trailing year (only when the paren form did not win)
  let dotYear: number | undefined;
  if (!year) {
    const dm = t.match(/(^|[._-])((19|20)\d{2})$/);
    if (dm) {
      dotYear = parseInt(dm[2], 10);
      t = t.slice(0, dm.index);
    }
  }

  const title = titleOf(t);
  if (!title) return null;
  const finalYear = year !== undefined ? year : dotYear;
  return finalYear !== undefined ? { title, year: finalYear } : { title };
}

/** The text before the marker, normalized: release-group tag(s) and the
 *  year tag gone, dots/underscores as spaces, a stray "Season N" word
 *  dropped (the marker carried it), edge separators trimmed, whitespace
 *  collapsed. A name that is nothing but a number is no title. */
function titleOf(raw: string): string {
  let t = raw.replace(YEAR_RE, " ").trim();
  t = t.replace(GROUP_LEAD_RE, ""); // leading [Group] tag(s)
  t = t.replace(/\bseason\s*\d{1,2}\b/i, " ");
  t = t.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  // scene junk anywhere (codec/source/audio/language tags between the
  // title and the group tail) — the query must be the clean title
  t = t.replace(JUNK_TOKEN_RE, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^[\s._-]+|[\s._-]+$/g, "");
  if (!t || /^\d{1,4}$/.test(t.replace(/\s+/g, ""))) return "";
  return t;
}
