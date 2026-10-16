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
 *                                 never count as episode numbers.
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
/** Trailing scene words after the number: WEB-DL, REMUX, x264 … */
const WORD_TAIL_RE = /[A-Za-z][\w-]*\s*$/;

/**
 * Case/punctuation-free form — "Black.Clover!" and "black clover" match.
 * The one normalization every title comparison (matchers, cache keys)
 * shares.
 */
export function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
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
 * the trailing tags are gone — "…Title - 171", "…Title 171", "…Title.171".
 * A number that is a resolution (720/1080/…), a year (1900–2099), or the
 * tail of a decimal ("1.5") is not an episode; a 1–2 digit number is not
 * trusted without a [Group] tag (sequel risk — "Show 2"). Returns null when
 * the name carries no usable bare number.
 */
function bareNumber(base: string): { episode: number; titleEnd: number } | null {
  const hadGroup = GROUP_LEAD_RE.test(base);
  let t = base;
  while (TAG_TAIL_RE.test(t)) t = t.replace(TAG_TAIL_RE, "");
  t = t.replace(QUALITY_TAIL_RE, "").replace(WORD_TAIL_RE, "");
  t = t.replace(/[.\s_-]+$/, "").trim();
  const m = t.match(/(^|[.\s_-])(\d{1,4})$/);
  if (!m) return null; // nothing number-shaped left at the end
  const episode = parseInt(m[2], 10);
  if (RESOLUTIONS.has(episode)) return null;
  if (episode >= 1900 && episode <= 2099) return null;
  if (m[1] === "." && /\d/.test(t.charAt(m.index - 1) || "")) return null; // "1.5"
  if (episode <= 99 && !hadGroup) return null;
  return { episode, titleEnd: m.index };
}

/** Inclusive integer range check (out-of-range numbers are garbage, not an episode). */
function inRange(n: number, lo: number, hi: number): boolean {
  return n >= lo && n <= hi;
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
  t = t.replace(/^[\s._-]+|[\s._-]+$/g, "");
  if (!t || /^\d{1,4}$/.test(t.replace(/\s+/g, ""))) return "";
  return t;
}
