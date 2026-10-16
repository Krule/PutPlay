/**
 * AniList GraphQL (free, no key): title → anime entries with MAL ids.
 *
 * Why AniList: TheIntroDB's anime coverage is thin, and the anime
 * community's skip data (AniSkip) is keyed by MyAnimeList id. AniList is
 * a free public GraphQL API — no key, CORS open — so this whole chain
 * runs with zero setup. Any failure (network, GraphQL error, garbage
 * shape) answers [] — the honest "nothing to skip", never a throw.
 */

import { normTitle } from "./titles";

export interface AnilistShow {
  /** The MyAnimeList id — AniSkip's key. */
  malId: number;
  /** Romaji title (the english name as fallback). */
  title: string;
  /** First-air year, for disambiguation (absent when unknown). */
  year?: number;
  /** Community score — the popularity proxy (absent when unrated). */
  score?: number;
}

const GRAPHQL_URL = "https://graphql.anilist.co";

const SEARCH_QUERY = `
query SearchMedia($q: String!, $y: Int) {
  Page(perPage: 10) {
    media(search: $q, type: ANIME, sort: POPULARITY_DESC, isAdult: false, seasonYear: $y) {
      idMal
      title { romaji english }
      averageScore
      startDate { year }
    }
  }
}`;

/** Search anime by title. `year` (a (year) tag from the file name) narrows
 *  the search server-side; omitted when absent. */
export async function anilistSearchAnime(
  title: string,
  year?: number,
  fetchImpl?: typeof fetch
): Promise<AnilistShow[]> {
  const doFetch = fetchImpl || fetch;
  let res: Response;
  try {
    res = await doFetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: SEARCH_QUERY,
        variables: { q: title, y: year ?? null },
      }),
    });
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return [];
  }
  const media = (data as any)?.data?.Page?.media;
  if (!Array.isArray(media)) return [];
  const shows: AnilistShow[] = [];
  for (const m of media) {
    const malId = m?.idMal;
    const name = m?.title?.romaji || m?.title?.english;
    if (typeof malId !== "number" || typeof name !== "string" || !name) continue;
    const show: AnilistShow = { malId, title: name };
    if (typeof m?.startDate?.year === "number") show.year = m.startDate.year;
    if (typeof m?.averageScore === "number") show.score = m.averageScore;
    shows.push(show);
  }
  return shows;
}

/**
 * Choose the best anime from search results: an exact title match first,
 * then a NEAR match (either title contains the other — the "Squishy!
 * Black Clover" spin-off case). Among the candidates a year match wins,
 * then the higher community score.
 */
export function pickAnilistMatch(
  results: AnilistShow[],
  title: string,
  year?: number
): AnilistShow | null {
  if (!results.length) return null;
  const want = normTitle(title);
  if (!want) return null;

  const exact = results.filter((s) => normTitle(s.title) === want);
  const near = exact.length
    ? exact
    : results.filter((s) => {
        const n = normTitle(s.title);
        return n.includes(want) || want.includes(n);
      });
  if (!near.length) return null;

  const byYear = year ? near.filter((s) => s.year === year) : null;
  const candidates = byYear && byYear.length ? byYear : near;
  return candidates.reduce((best, s) => ((s.score ?? 0) > (best.score ?? 0) ? s : best));
}
