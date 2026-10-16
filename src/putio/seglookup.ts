/**
 * The per-file segment lookup, orchestrated:
 *
 *   put.io file name
 *     → parseEpisode (titles.ts)         "Breaking.Bad.S01E01.720p.mkv"
 *     → TWO SOURCES, in parallel:
 *         A. tmdbSearchTv + pickTmdbMatch → introdbMedia
 *            (TheIntroDB, keyed by TMDb id — needs the baked-in key)
 *         B. anilistSearchAnime + pickAnilistMatch → aniskipSegments + aniskipSegmentsV1
 *            (AniSkip, keyed by MAL id — no key; season-1 files only,
 *            because MAL/AniSkip episodes number continuously and an
 *            SxxEyy season-2 number can't be mapped. BOTH AniSkip databases
 *            are queried — v2 current + v1 legacy; v2 wins per section,
 *            v1 fills the gaps, since each DB covers different series.)
 *     → mergeSegments (TheIntroDB wins per section type)
 *
 * The Player runs this ONCE per file (async, non-blocking: playback
 * starts immediately; if the data lands while the playhead is still near
 * the top, the engine applies the fresh skip late — see media.ts). Every
 * step degrades to "nothing to skip": no key, no episode marker, no
 * match, no data, any network failure — all answer [], never a throw.
 *
 * CACHING IS SUSPENDED while the feature settles: every play re-looks-up
 * from the live sources. The `cache` parameter is accepted but ignored —
 * to restore, read before the lookups and `put` the merged result after
 * (the `SegCacheEntry` shape and the store in seg-cache.ts are unchanged).
 */

import type { Seg } from "./introdb";
import { introdbMedia } from "./introdb";
import { parseEpisode } from "./titles";
import type { TmdbShow } from "./tmdb";
import { pickTmdbMatch, tmdbSearchTv } from "./tmdb";
import { anilistSearchAnime, pickAnilistMatch } from "./anilist";
import { aniskipSegments, aniskipSegmentsV1 } from "./aniskip";

/** The cache contract the app fulfils with IndexedDB (tests with a Map).
 *  The ids are informational (old entries lack malId). */
export interface SegCacheEntry {
  tmdbId: number | null;
  malId?: number | null;
  segs: Seg[];
  /** When the entry was written (ms). */
  at: number;
}
export interface SegCache {
  get(key: string): Promise<SegCacheEntry | undefined>;
  put(key: string, value: SegCacheEntry): Promise<void>;
}

/**
 * The TheIntroDB chain: TMDb title search (the baked-in key) → the
 * episode's intro/recap/credits windows.
 */
async function resolveTmdbChain(
  title: string,
  season: number,
  episode: number,
  year: number | undefined,
  tmdbKey: string,
  doFetch: typeof fetch
): Promise<{ segs: Seg[]; tmdbId: number | null }> {
  const results = await tmdbSearchTv(tmdbKey, title, year, doFetch);
  const show: TmdbShow | null = results ? pickTmdbMatch(results, title, year) : null;
  const segs = show ? await introdbMedia(show.id, season, episode, doFetch) : [];
  return { segs, tmdbId: show ? show.id : null };
}

/**
 * The anime chain: AniList title search (no key) → the MAL id → AniSkip's
 * community op/ed/recap intervals for that episode. Both AniSkip databases
 * are queried (v2 current + v1 legacy, in parallel): finished series often
 * live only in the legacy DB and vice versa — v2 wins per section type,
 * v1 fills the gaps.
 */
async function resolveAniChain(
  title: string,
  episode: number,
  year: number | undefined,
  doFetch: typeof fetch
): Promise<{ segs: Seg[]; malId: number | null }> {
  const results = await anilistSearchAnime(title, year, doFetch);
  const show = results ? pickAnilistMatch(results, title, year) : null;
  if (!show) return { segs: [], malId: null };
  const [current, legacy] = await Promise.all([
    aniskipSegments(show.malId, episode, doFetch),
    aniskipSegmentsV1(show.malId, episode, doFetch),
  ]);
  return { segs: mergeSegments(current, legacy), malId: show.malId };
}

/**
 * Merge the two sources into one ordered segment list: TheIntroDB wins
 * per section type (it measures the real file's show data), AniSkip fills
 * the types TheIntroDB lacks. Sorted by start.
 */
export function mergeSegments(primary: Seg[], secondary: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const type of ["intro", "recap", "credits"] as const) {
    const primaryOf = primary.filter((s) => s.type === type);
    out.push(...(primaryOf.length ? primaryOf : secondary.filter((s) => s.type === type)));
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Resolve the skip segments for one put.io file. `fetchImpl` and `cache`
 * are injectable so the whole chain runs in node against canned responses.
 */
export async function lookupSegments(
  tmdbKey: string,
  name: string,
  fetchImpl?: typeof fetch,
  /** Accepted but IGNORED while caching is suspended (see file header). */
  _cache?: SegCache
): Promise<Seg[]> {
  const ep = parseEpisode(name);
  if (!ep) return [];

  const doFetch = fetchImpl || fetch;

  const [tidb, anime] = await Promise.all([
    tmdbKey
      ? resolveTmdbChain(ep.title, ep.season, ep.episode, ep.year, tmdbKey, doFetch)
      : Promise.resolve({ segs: [] as Seg[], tmdbId: null }),
    ep.season === 1
      ? resolveAniChain(ep.title, ep.episode, ep.year, doFetch)
      : Promise.resolve({ segs: [] as Seg[], malId: null }),
  ]);

  return mergeSegments(tidb.segs, anime.segs);
}
