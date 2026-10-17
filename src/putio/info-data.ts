/**
 * The player's Info tab data layer — per file: synopsis, rating (0–10),
 * genres, air-date (episodes) / runtime (movies), and a thumbnail URL.
 *
 * Sources (every one honest fallback — any network/HTTP/shape failure
 * answers null, never a throw, never a block):
 *   TV episodes → TMDb (the baked-in key): tmdbSearchTv + pickTmdbMatch
 *     (tmdb.ts, reused) → /3/tv/{id} (show: rating, genres, backdrop) +
 *     /3/tv/{id}/season/{s}/episode/{e} (episode: synopsis, air-date,
 *     still). The episode's overview WINS for the synopsis; the show fills
 *     rating/genres and its backdrop covers for a missing still.
 *   Anime       → the AniList fallback (keyless): the TMDb chain answers
 *     nothing for many anime (an empty search, or a weak non-empty set the
 *     matcher rightly rejects) — so on ANY TMDb miss this module resolves
 *     the title ITSELF: anilistSearchAnime + pickAnilistMatch → ONE
 *     Media(id:) GraphQL query for the SHOW-LEVEL data — synopsis (HTML →
 *     plain text), rating (AniList's averageScore 0–100 → 0–10), genres,
 *     cover. No episode still, no air-date, no runtime. A western show
 *     matches no ANIME search — the fallback is a no-op there.
 *   Movies      → TMDb through the query LADDER (movieQueryStages): TMDb's
 *     movie search is near-exact, so a re-formed query (space year → year
 *     param, year re-joined to the title, group tail dropped) is tried
 *     when a search comes back empty → the SAME match rules as
 *     pickTmdbMatch → /3/movie/{id}; the runtime (minutes) is the
 *     details-row part instead of an air-date.
 *
 * Caching is per logical key through the InfoCache interface (info-cache.ts
 * fulfils it with IndexedDB — the seg-cache pattern; tests with a Map):
 * tv:{id} / ep:{id}:{s}:{e} / mv:{id} / al:{id} — read before the network,
 * write after success, a hit skips that request, a cache failure degrades
 * to a miss (a put failure is ignored).
 *
 * The output feeds the Info panel (InfoPanelInput, info-tab.ts): airDate
 * and runtime arrive PRE-FORMATTED ("May 12, 2021", "2h 04m") — the panel
 * never formats, it only picks which fields the row shows. Two fields feed
 * the TITLE VIEW (title-view.ts) instead: episodeTitle (the episode's
 * em-dash part) and showTitle (the canonical title that replaces the
 * filename-derived one).
 */

import { TMDB_KEY } from "./tmdb-key";
import { anilistSearchAnime, pickAnilistMatch, type AnilistShow } from "./anilist";
import {
  movieQueryStages,
  pickTmdbMatch,
  tmdbSearchMovie,
  tmdbSearchTv,
} from "./tmdb";

// the movie query ladder lives with its search client (tmdb.ts) — re-exported
// so existing importers (the Info tab's test, anything else) keep working
export { movieQueryStages } from "./tmdb";
export type { MovieQueryStage } from "./tmdb";

const TMDB_API = "https://api.themoviedb.org";
const TMDB_IMAGES = "https://image.tmdb.org";
const ANILIST_GRAPHQL = "https://graphql.anilist.co";

// ---------------------------------------------------------------------------
// Pure formatters (the panel shows pre-formatted strings — they are pinned
// in test/info-data.test.mjs and never drift with the TV's clock zone).
// ---------------------------------------------------------------------------

/**
 * A TMDb image path → the w780 URL (a 384×216 panel thumb at 2×):
 * https://image.tmdb.org/t/p/w780<path>. A path must start with "/" —
 * null/""/anything else → null (the panel omits the thumb, never fakes one).
 */
export function tmdbImageUrl(path: string | null | undefined, size: "w780" = "w780"): string | null {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  return `${TMDB_IMAGES}/t/p/${size}${path}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2021-05-12" → "May 12, 2021". Parsed as a calendar date — no timezone
 * math (a TV's clock zone must not shift the aired date). An impossible
 * date, garbage, or null → null.
 */
export function formatAirDate(iso: string | null | undefined): string | null {
  if (typeof iso !== "string") return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** Days in the (year, month) calendar month. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Minutes → the details-row form: 124 → "2h 04m", 45 → "45m". 0, negative,
 * and NaN mean "no runtime" → null (the panel omits it).
 */
export function formatRuntime(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 1) return null;
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  return `${h}h ${String(total % 60).padStart(2, "0")}m`;
}

/** The named entity vocabulary: the base six plus the typographic set
 *  — the live AniList description mix (a 400-title scan: &mdash;, &ndash;
 *  and &rsquo; are the ones that actually appear). */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  laquo: "\u00ab",
  raquo: "\u00bb",
  middot: "\u00b7",
};

/**
 * One entity reference (the text between & and ;) → its character: the
 * named vocabulary first, then the numeric forms (&#8217; decimal,
 * &#x2019; hex) via codepoint. Unknown names and out-of-range codepoints
 * survive as-is — the decoder never invents text and never throws.
 */
function decodeEntity(ref: string): string {
  const named = NAMED_ENTITIES[ref];
  if (named) return named;
  if (ref.startsWith("#")) {
    const code =
      ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
      try {
        return String.fromCodePoint(code);
      } catch {
        // a surrogate half — not a character
      }
    }
  }
  return `&${ref};`;
}

/**
 * HTML → plain text for the panel: tags removed, entities decoded (named
 * vocabulary + numeric references, one pass — a double-escaped &amp;#8217;
 * decodes once, to &#8217;), surrounding whitespace trimmed. An empty
 * result → null (the panel omits the synopsis, never shows a placeholder).
 */
export function stripHtml(html: string | null | undefined): string | null {
  if (typeof html !== "string") return null;
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (_m, ref) =>
      decodeEntity(ref)
    );
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * AniList's 0–100 community score → the panel's 0–10 (85 → 8.5). Out of
 * range or null → null.
 */
export function normalizeAnilistScore(score: number | null | undefined): number | null {
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) return null;
  return score / 10;
}

// ---------------------------------------------------------------------------
// The networked lookups
// ---------------------------------------------------------------------------

export interface InfoData {
  synopsis: string | null;
  rating: number | null; // 0–10
  genres: string[] | null; // display names, [] → null
  airDate: string | null; // PRE-FORMATTED (formatAirDate)
  runtime: string | null; // PRE-FORMATTED (formatRuntime) — movies only
  thumbUrl: string | null;
  /** The episode's TMDb name — the title-view enrichment (e.g. "One
   *  Minute"). TMDb TV episodes only: null for anime (show-level) and
   *  movies. */
  episodeTitle: string | null;
  /** The canonical show/movie title from the source (TMDb's name/title,
   *  AniList's romaji) — the title view REPLACES its filename-derived
   *  title with it. Null when the lookup found nothing. */
  showTitle: string | null;
}

/** The cache contract the app fulfils with IndexedDB (info-cache.ts) and
 *  the tests with a Map. */
export interface InfoCache {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

type Detail = Record<string, unknown>;

/** Guard to a plain object (the cached / fetched detail shape). */
function asRecord(v: unknown): Detail | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Detail) : null;
}

/** Guard to a non-empty string. */
function asText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Guard to a finite number. */
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** TMDb genres [{name}] → display names; [] → null (the row omits them). */
function genreNames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const names: string[] = [];
  for (const g of v) {
    const n = asRecord(g)?.name;
    if (typeof n === "string") names.push(n);
  }
  return names.length ? names : null;
}

/** AniList genres (string[]) → the list; [] → null. */
function genreList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const names = v.filter((g): g is string => typeof g === "string");
  return names.length ? names : null;
}

/**
 * A logical key's detail, read-before-network: a cache hit skips the
 * request; a miss fetches and writes after success. A cache throw is a
 * miss, a put failure is ignored (the seg-cache posture: the network layer
 * never rejects into the player).
 */
async function cachedDetail(
  cache: InfoCache | undefined,
  key: string,
  fetchDetail: () => Promise<Detail | null>
): Promise<Detail | null> {
  if (cache) {
    try {
      const hit = await cache.get(key);
      if (hit && typeof hit === "object" && !Array.isArray(hit)) return hit as Detail;
    } catch {
      // a broken cache is a miss, not an error
    }
  }
  const fresh = await fetchDetail();
  if (fresh && cache) {
    try {
      await cache.put(key, fresh);
    } catch {
      // a put failure never blocks the panel
    }
  }
  return fresh;
}

/** One TMDb detail GET (Bearer key); a non-OK or garbage answer is null. */
async function tmdbDetail(doFetch: typeof fetch, path: string): Promise<Detail | null> {
  try {
    const res = await doFetch(`${TMDB_API}${path}`, {
      headers: { Authorization: `Bearer ${TMDB_KEY}` },
    });
    if (!res.ok) return null;
    return asRecord(await res.json());
  } catch {
    return null;
  }
}

// THE REAL AniList SCHEMA FIELD IS `averageScore` (0–100). A bare `score`
// field does not exist on Media — the API answers 400 "Cannot query field
// score on type Media" and the whole fallback died silently (verified
// live). The search query in anilist.ts already uses averageScore.
const ANILIST_MEDIA_QUERY = `
query MediaInfo($id: Int!) {
  Media(id: $id) {
    averageScore
    genres
    description
    title { romaji english }
    coverImage { large }
  }
}`;

/** One keyless AniList Media(id:) query; `internalId` is AniList's
 *  internal id (NOT the MAL id — see AnilistShow.id). A non-OK / GraphQL /
 *  shape failure is null. */
async function anilistMedia(internalId: number, doFetch: typeof fetch): Promise<Detail | null> {
  let res: Response;
  try {
    res = await doFetch(ANILIST_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: ANILIST_MEDIA_QUERY, variables: { id: internalId } }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  const root = asRecord(json);
  const data = root ? asRecord(root.data) : null;
  return data ? asRecord(data.Media) : null;
}

/** The anime path: show-level data only — no episode still, no air-date,
 *  no runtime. */
async function anilistShowInfo(
  anime: AnilistShow,
  cache: InfoCache | undefined,
  doFetch: typeof fetch
): Promise<InfoData | null> {
  const media = await cachedDetail(cache, `al:${anime.id}`, () => anilistMedia(anime.id, doFetch));
  if (!media) return null;
  const alTitle = asRecord(media.title);
  return {
    synopsis: stripHtml(typeof media.description === "string" ? media.description : null),
    rating: normalizeAnilistScore(asNumber(media.averageScore)),
    genres: genreList(media.genres),
    airDate: null,
    runtime: null,
    thumbUrl: asText(asRecord(media.coverImage)?.large),
    episodeTitle: null, // AniList Media is show-level only
    showTitle: asText(alTitle?.romaji) ?? asText(alTitle?.english), // romaji, english as fallback
  };
}

/**
 * The Info data for one EPISODE file: the TMDb chain first (it carries
 * the richer data — episode still, air date, episode title), and when it
 * answers nothing, the keyless AniList fallback — the ANIME case. TMDb's
 * TV search often answers a weak non-empty set for an anime (or nothing
 * at all), and AniList is the anime community's database, so the
 * fallback runs on ANY TMDb miss, resolved here (search → pick → ONE
 * Media query). No data anywhere / any failure → null (never throws).
 * The caller passes the parsed title and nothing else — the module owns
 * its fallbacks.
 */
export async function lookupEpisodeInfo(args: {
  title: string;
  year?: number;
  season: number;
  episode: number;
  fetchImpl?: typeof fetch;
  cache?: InfoCache;
}): Promise<InfoData | null> {
  const doFetch = args.fetchImpl || fetch;
  const tmdb = TMDB_KEY ? await tmdbEpisodeInfo(args, doFetch, args.cache) : null;
  if (tmdb) return tmdb;
  return anilistEpisodeFallback(args.title, args.year, args.cache, doFetch);
}

/** The TMDb chain: search → show detail → episode detail (the episode's
 *  overview wins for the synopsis; the episode's still falls back to the
 *  show's backdrop). Any failure → null. */
async function tmdbEpisodeInfo(
  args: { title: string; year?: number; season: number; episode: number },
  doFetch: typeof fetch,
  cache: InfoCache | undefined
): Promise<InfoData | null> {
  const results = await tmdbSearchTv(TMDB_KEY, args.title, args.year, doFetch);
  const show = results ? pickTmdbMatch(results, args.title, args.year) : null;
  if (!show) return null;

  const showDetail = await cachedDetail(cache, `tv:${show.id}`, () =>
    tmdbDetail(doFetch, `/3/tv/${show.id}`)
  );
  if (!showDetail) return null;

  const epDetail = await cachedDetail(cache, `ep:${show.id}:${args.season}:${args.episode}`, () =>
    tmdbDetail(doFetch, `/3/tv/${show.id}/season/${args.season}/episode/${args.episode}`)
  );
  if (!epDetail) return null;

  const airDate = typeof epDetail.air_date === "string" ? formatAirDate(epDetail.air_date) : null;
  return {
    synopsis: asText(epDetail.overview) ?? asText(showDetail.overview),
    rating: asNumber(showDetail.vote_average),
    genres: genreNames(showDetail.genres),
    airDate,
    runtime: null,
    thumbUrl: tmdbImageUrl(asText(epDetail.still_path) ?? asText(showDetail.backdrop_path)),
    episodeTitle: asText(epDetail.name),
    showTitle: asText(showDetail.name), // the canonical show name
  };
}

/** The AniList fallback (keyless): resolve the title against the anime
 *  database — search → pick (exact/near, year, then score) → ONE
 *  Media(id:) query for the show-level data. Nothing found → null. A
 *  western show simply does not match an ANIME search — the fallback is
 *  a no-op there. */
async function anilistEpisodeFallback(
  title: string,
  year: number | undefined,
  cache: InfoCache | undefined,
  doFetch: typeof fetch
): Promise<InfoData | null> {
  const shows = await anilistSearchAnime(title, year, doFetch);
  const anime = pickAnilistMatch(shows, title, year);
  if (!anime) return null;
  return anilistShowInfo(anime, cache, doFetch);
}

/**
 * The Info data for one MOVIE file: the query ladder (movieQueryStages)
 * against TMDb — a stage is retried only when its search came back EMPTY;
 * a non-empty set ends the walk (matched or rejected) → the same match
 * rules as the TV chain → the movie detail. No key / no match / any
 * failure → null (zero network without a key).
 */
export async function lookupMovieInfo(args: {
  name: string;
  year?: number;
  fetchImpl?: typeof fetch;
  cache?: InfoCache;
}): Promise<InfoData | null> {
  if (!TMDB_KEY) return null;
  const doFetch = args.fetchImpl || fetch;

  for (const stage of movieQueryStages(args.name, args.year)) {
    const results = await tmdbSearchMovie(TMDB_KEY, stage.title, stage.year, doFetch);
    // empty OR a fetch failure (a 500 on one query does not doom the next)
    // — a re-formed query may still hit; the ladder is bounded
    if (results === null || results.length === 0) continue;
    const show = pickTmdbMatch(results, stage.title, stage.year);
    if (!show) return null; // results but nothing close — the honest null
    const detail = await cachedDetail(args.cache, `mv:${show.id}`, () =>
      tmdbDetail(doFetch, `/3/movie/${show.id}`)
    );
    if (!detail) return null;
    return {
      synopsis: asText(detail.overview),
      rating: asNumber(detail.vote_average),
      genres: genreNames(detail.genres),
      airDate: null,
      runtime: formatRuntime(asNumber(detail.runtime)),
      thumbUrl: tmdbImageUrl(asText(detail.backdrop_path)),
      episodeTitle: null, // movies have no episode title
      showTitle: asText(detail.title), // the canonical movie title
    };
  }
  return null;
}
