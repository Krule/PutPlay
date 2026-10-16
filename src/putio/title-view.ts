/**
 * The player chrome's title view (pure — no DOM/webOS imports, testable in
 * node).
 *
 * The chrome shows the file's IDENTITY instead of the raw file name:
 *
 *   - an EPISODE (titles.ts found a marker) → the parsed show title as the
 *     title and "S3 · E1" as the subtitle; once the late TMDb enrichment
 *     lands a real episode title it is appended after an em-dash:
 *     "S3 · E1 — The Zone".
 *   - a non-episode file (a movie) → the file name as the title, no
 *     subtitle line at all.
 *
 * Badges, in order: LIVE (accented) only for ∞-duration streams, then the
 * source badge for the CONVERTED sources only (mp4 → MP4, hls → HLS) — the
 * original file plays itself, so it stays badge-less (mockup chrome:
 * [LIVE][HLS], docs/mockups/player-sheet.html).
 *
 * Honest fallbacks only: no parsed episode → no S/E line, no episode title
 * → no em-dash part. The parse comes from titles.ts; this module never
 * re-parses the name.
 */

import type { EpisodeId } from "./titles";
import type { SourceKind } from "./media";

export interface Badge {
  label: string;
  accent?: boolean;
}

export interface TitleView {
  title: string;
  subtitle: string;
  badges: Badge[];
}

export interface TitleViewInput {
  /** The put.io file display name — the fallback title. */
  name: string;
  /** The titles.ts parse result, or null for non-episode files (movies). */
  episode: EpisodeId | null;
  /** ∞-duration stream. */
  live: boolean;
  /** The current playback source id (media.ts SourceKind). */
  source: SourceKind;
  /** TMDb-resolved episode title (late enrichment; may be absent/null). */
  episodeName?: string | null;
}

/** The badge a converted source wears; null = the original plays itself. */
const SOURCE_BADGES: Record<SourceKind, string | null> = {
  original: null,
  mp4: "MP4",
  hls: "HLS",
};

export function buildTitleView(input: TitleViewInput): TitleView {
  const { name, episode, live, source, episodeName } = input;
  return {
    title: episode ? episode.title : name,
    subtitle: subtitleFor(episode, episodeName),
    badges: badgesFor(live, source),
  };
}

/** The "S3 · E1" line ("" for non-episode files); the TMDb episode title,
 *  when we have one, is appended after an em-dash. */
function subtitleFor(episode: EpisodeId | null, episodeName: string | null | undefined): string {
  if (!episode) return "";
  const se = `S${episode.season} · E${episode.episode}`;
  const episodeTitle = (episodeName ?? "").trim();
  return episodeTitle ? `${se} — ${episodeTitle}` : se;
}

/** LIVE first, then the converted-source badge — the original source
 *  plays itself, so it stays badge-less. */
function badgesFor(live: boolean, source: SourceKind): Badge[] {
  const badges: Badge[] = [];
  if (live) badges.push({ label: "LIVE", accent: true });
  const sourceBadge = SOURCE_BADGES[source];
  if (sourceBadge) badges.push({ label: sourceBadge });
  return badges;
}
