/**
 * The per-file segment lookup, orchestrated:
 *
 *   put.io file name
 *     → parseEpisode (titles.ts)         "Breaking.Bad.S01E01.720p.mkv"
 *     → PHASE 1, the IDENTITIES (parallel):
 *         TMDb search + pickTmdbMatch  → the TMDb id (+ its IMDb id)
 *         AniList search + pickAnilistMatch → the MAL id (+ its IMDb id)
 *            (no key needed; season-1 files only, because MAL/AniSkip
 *            episodes number continuously and an SxxEyy season-2 number
 *            can't be mapped)
 *     → PHASE 2, the DATA (parallel), one fetch per source that has an id:
 *         A. TheIntroDB  (TMDb id)   introdbMedia — the episode's windows
 *         B. AniSkip     (MAL id)    aniskipSegments + aniskipSegmentsV1 —
 *            both community databases in parallel (v2 wins per section,
 *            v1 fills the gaps; each covers different series)
 *         C. introdb.app (IMDb id)   introdbAppSegments — the consensus DB
 *            (the strongest single source measured in the corpus; the id
 *            comes from whichever identity found one — TMDb first, so it
 *            works even without a TMDb key). Exactly ONE call: a show has
 *            one IMDb id, so the anime side never refetches it.
 *     → fuseSegments (the consensus merge, see below)
 *
 *   A name without a STRICT episode marker falls back to the relaxed bare
 *   parse (parseBareEpisode — the scene-bare "Title - 01 [1080p][HASH]"
 *   form, season 1). It still takes the episode chain, but the identity
 *   search is the gate: the title must actually match a show, or nothing
 *   is fetched and nothing is returned.
 *
 *   Only a name with NO usable episode number at all is a movie:
 *   parseMovieName → the
 *   TMDb movie query ladder (movieQueryStages + tmdbSearchMovie, the same
 *   walk the Info tab's movie search runs) → pickTmdbMatch → the film's
 *   MOVIE-level data: TheIntroDB media (no season/episode) + introdb.app
 *   with is_movie=true, fused the same way. The anime chain never runs on
 *   a marker-less name.
 *
 *   fuseSegments: per section type, a source measured alone is trusted
 *   outright (it may know a second OP or a long recap no one else timed);
 *   when several sources report the type, their windows are clustered by
 *   start (within FUSE_WINDOW_S they measured the same OP/ED) and the
 *   consensus cluster — most members, ties to the higher-priority source
 *   (TheIntroDB > AniSkip > introdb.app) — wins with ONE window, carried
 *   by that cluster's highest-priority member. One window per type is the
 *   domain truth (one OP, one ED): sources disagreeing past the window
 *   would otherwise double-skip the content.
 *
 * The Player runs this ONCE per file (async, non-blocking: playback
 * starts immediately; if the data lands while the playhead is still near
 * the top, the engine applies the fresh skip late — see media.ts). Every
 * step degrades to "nothing to skip": no key, no parseable name, no
 * match, no id, no data, any network failure — all answer [], never a
 * throw. A source failing never sinks the others (the data fetches are
 * independent).
 *
 * CACHING IS SUSPENDED while the feature settles: every play re-looks-up
 * from the live sources. The `cache` parameter is accepted but ignored —
 * to restore, read before the lookups and `put` the merged result after
 * (the `SegCacheEntry` shape and the store in seg-cache.ts are unchanged).
 */

import type { Seg } from "./introdb";
import { introdbMedia } from "./introdb";
import { introdbAppSegments } from "./introdb-app";
import { parseBareEpisode, parseEpisode, parseMovieName } from "./titles";
import type { TmdbShow } from "./tmdb";
import { movieQueryStages, pickTmdbMatch, tmdbSearchMovie, tmdbSearchTv } from "./tmdb";
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
 * The anime data: AniSkip's two community databases (v2 current + v1
 * legacy), fetched in parallel: finished series often live only in the
 * legacy DB and vice versa — v2 wins per section type, v1 fills the gaps.
 */
async function aniskipAnime(malId: number, episode: number, doFetch: typeof fetch): Promise<Seg[]> {
  const [current, legacy] = await Promise.all([
    aniskipSegments(malId, episode, doFetch),
    aniskipSegmentsV1(malId, episode, doFetch),
  ]);
  return mergeSegments(current, legacy);
}

/**
 * One source's contribution to the fusion. `source` is the priority key
 * (TheIntroDB > AniSkip > introdb.app — the app's primary measured source
 * first, then the community DB, then the consensus DB).
 */
export interface SourceData {
  source: string;
  segs: Seg[];
}

/** Windows whose starts lie within this many seconds measured the same OP/ED. */
const FUSE_WINDOW_S = 5;

const SOURCE_PRIORITY: Record<string, number> = { theintrodb: 0, aniskip: 1, introdb_app: 2 };
function priority(source: string): number {
  return SOURCE_PRIORITY[source] ?? 3;
}

/**
 * The consensus merge across sources (pure).
 *
 * Per section type:
 *   • nobody reported it → nothing;
 *   • exactly ONE source reported it → its entries pass through AS-IS
 *     (it may have timed a second OP or a long recap no one else knows);
 *   • several sources reported it → their windows cluster by start
 *     (within FUSE_WINDOW_S = the same OP/ED); the consensus cluster —
 *     most members, ties to the cluster holding the higher-priority
 *     source, further ties to the earliest — wins, and ONE window comes
 *     out of it, carried by the cluster's highest-priority member.
 * One window per type is the domain truth (one OP, one ED per episode);
 * sources disagreeing past the window would otherwise double-skip.
 * Output sorted by start.
 */
export function fuseSegments(sources: SourceData[]): Seg[] {
  const out: Seg[] = [];
  for (const type of ["intro", "recap", "credits"] as const) {
    const reporting = sources
      .map((s) => ({ source: s.source, segs: s.segs.filter((x) => x.type === type) }))
      .filter((s) => s.segs.length > 0);
    if (reporting.length === 0) continue;
    if (reporting.length === 1) {
      out.push(...reporting[0].segs);
      continue;
    }
    const winner = consensusWindow(reporting.flatMap((s) => s.segs.map((seg) => ({ seg, source: s.source }))));
    if (winner) out.push({ ...winner.seg });
  }
  return out.sort((a, b) => a.start - b.start);
}

interface Member {
  seg: Seg;
  source: string;
}
interface Cluster {
  seed: number;
  members: Member[];
  best: Member; // the highest-priority member (ties → the earliest seen)
}

function consensusWindow(members: Member[]): Member | null {
  if (!members.length) return null;
  const clusters: Cluster[] = [];
  for (const m of members) {
    const cluster = clusters.find((c) => Math.abs(c.seed - m.seg.start) <= FUSE_WINDOW_S);
    if (!cluster) {
      clusters.push({ seed: m.seg.start, members: [m], best: m });
    } else {
      cluster.members.push(m);
      if (priority(m.source) < priority(cluster.best.source)) cluster.best = m;
    }
  }
  let winner = clusters[0];
  for (const c of clusters.slice(1)) {
    if (beats(c, winner)) winner = c;
  }
  return winner.best;
}

function beats(a: Cluster, b: Cluster): boolean {
  if (a.members.length !== b.members.length) return a.members.length > b.members.length;
  const pa = priority(a.best.source);
  const pb = priority(b.best.source);
  if (pa !== pb) return pa < pb;
  return a.seed < b.seed;
}

/**
 * Merge two segment lists into one ordered list: the primary's entries win
 * per section type, the secondary fills the types the primary lacks.
 * Sorted by start. (Used for AniSkip's two community databases.)
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
  const doFetch = fetchImpl || fetch;

  // The strict marker first; the scene-bare "Title - 01" form is the
  // fallback (season 1) — gated by the identity search below: if the
  // title matches no show, no source is fetched and nothing is returned.
  const ep = parseEpisode(name) ?? parseBareEpisode(name);
  if (ep) return lookupEpisode(ep.title, ep.season, ep.episode, ep.year, tmdbKey, doFetch);

  // no usable episode number → a movie (or an unparseable name): the movie chain.
  // No key = zero network, same honesty as the episode chains.
  const mv = parseMovieName(name);
  if (!mv || !mv.title || !tmdbKey) return [];
  return lookupMovie(mv.title, mv.year, tmdbKey, doFetch);
}

/**
 * The episode chain in two phases: first the identities (TMDb + AniList,
 * parallel — independent), then the data (TheIntroDB + AniSkip +
 * introdb.app, parallel — each fails to [] on its own, so one source's
 * network trouble never sinks the others), then the fusion.
 */
async function lookupEpisode(
  title: string,
  season: number,
  episode: number,
  year: number | undefined,
  tmdbKey: string,
  doFetch: typeof fetch
): Promise<Seg[]> {
  const [tmdbResults, aniResults] = await Promise.all([
    tmdbKey ? tmdbSearchTv(tmdbKey, title, year, doFetch) : Promise.resolve(null),
    season === 1 ? anilistSearchAnime(title, year, doFetch) : Promise.resolve(null),
  ]);
  const tmdbShow: TmdbShow | null = tmdbResults ? pickTmdbMatch(tmdbResults, title, year) : null;
  const aniShow = aniResults ? pickAnilistMatch(aniResults, title, year) : null;

  // One IMDb id per show: the TMDb identity's id wins, the anime side's
  // fills in when the TMDb chain is off — exactly one introdb.app call.
  const imdbId = tmdbShow?.imdbId ?? aniShow?.imdbId;
  const [tidb, anime, idba] = await Promise.all([
    tmdbShow ? introdbMedia(tmdbShow.id, season, episode, doFetch) : Promise.resolve([] as Seg[]),
    aniShow ? aniskipAnime(aniShow.malId, episode, doFetch) : Promise.resolve([] as Seg[]),
    imdbId ? introdbAppSegments(imdbId, season, episode, doFetch) : Promise.resolve([] as Seg[]),
  ]);
  return fuseSegments([
    { source: "theintrodb", segs: tidb },
    { source: "aniskip", segs: anime },
    { source: "introdb_app", segs: idba },
  ]);
}

/**
 * The movie chain: the TMDb movie query ladder (the same walk the Info
 * tab's movie search runs) → the film's MOVIE-level data (TheIntroDB +
 * introdb.app with is_movie=true), fused. A stage is retried only when
 * its search came back EMPTY; a non-empty set ends the walk (matched or
 * rejected): a rejected set is the honest "no such movie", and dropping
 * further risks a containment false-match.
 */
async function lookupMovie(
  title: string,
  year: number | undefined,
  tmdbKey: string,
  doFetch: typeof fetch
): Promise<Seg[]> {
  for (const stage of movieQueryStages(title, year)) {
    const results = await tmdbSearchMovie(tmdbKey, stage.title, stage.year, doFetch);
    // empty OR a fetch failure (a 500 on one query does not doom the next)
    // — a re-formed query may still hit; the ladder is bounded
    if (results === null || results.length === 0) continue;
    const show: TmdbShow | null = pickTmdbMatch(results, stage.title, stage.year);
    if (!show) return []; // nothing close — the honest no-match
    const [tidb, idba] = await Promise.all([
      introdbMedia(show.id, undefined, undefined, doFetch),
      show.imdbId ? introdbAppSegments(show.imdbId, undefined, undefined, doFetch) : Promise.resolve([] as Seg[]),
    ]);
    return fuseSegments([
      { source: "theintrodb", segs: tidb },
      { source: "introdb_app", segs: idba },
    ]);
  }
  return [];
}
