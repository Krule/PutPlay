/**
 * AniList GraphQL (free, no key): title → anime entries with the ids the
 * segment sources need — the INTERNAL id (the Media(id:) query's key) and
 * the MAL id (AniSkip's key). They are different namespaces: feeding the
 * MAL id to Media(id:) names a different show (live: MAL 34572 / Black
 * Clover resolved to "Touch").
 *
 * NOTE — every field in SEARCH_QUERY is live-verified against the real
 * schema: `idImdb` DOES NOT EXIST on Media (the live API answers 400
 * "Cannot query field idImdb on type Media" and the WHOLE query dies —
 * shipped once, broke every anime lookup, removed 2026-10-19). Verify any
 * added field against the live API before committing.
 *
 * Why AniList: TheIntroDB's anime coverage is thin, and the anime
 * community's skip data (AniSkip) is keyed by MyAnimeList id. AniList is
 * a free public GraphQL API — no key, CORS open — so this whole chain
 * runs with zero setup. Any failure (network, GraphQL error, garbage
 * shape) answers [] — the honest "nothing to skip", never a throw.
 */

import { normTitle, normTitleRaw } from "./titles";

export interface AnilistShow {
  /** AniList's INTERNAL id — the Media(id:) GraphQL query's key.
   *  NOT the MAL id: in Media(id:) the MAL number names a different show
   *  (live: MAL 34572 / Black Clover resolved to "Touch"). */
  id: number;
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
      id
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
    const id = m?.id;
    const malId = m?.idMal;
    const name = m?.title?.romaji || m?.title?.english;
    if (typeof id !== "number" || typeof malId !== "number" || typeof name !== "string" || !name) continue;
    const show: AnilistShow = { id, malId, title: name };
    if (typeof m?.startDate?.year === "number") show.year = m.startDate.year;
    if (typeof m?.averageScore === "number") show.score = m.averageScore;
    shows.push(show);
  }
  return shows;
}

/**
 * Choose the best anime from search results: an exact title match first,
 * then a NEAR match (either title contains the other — the "Squishy!
 * Black Clover" spin-off case). Among the candidates a year match wins —
 * and a (year) tag with no matching candidate is NO match (a wrong show's
 * timings are worse than none) — then the higher community score. Among
 * the still-tied, the raw-equal title wins (Gintama. ≠ Gintama° — see
 * pickTmdbMatch, the same rules).
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

  if (typeof year === "number") {
    const byYear = near.filter((s) => s.year === year);
    if (!byYear.length) return null;
    return rawFirst(byYear, title);
  }
  return rawFirst(near, title);
}

/** Among equally-close candidates, the raw-equal title wins; then score. */
function rawFirst(cands: AnilistShow[], title: string): AnilistShow {
  const raw = normTitleRaw(title);
  const hit = cands.find((s) => normTitleRaw(s.title) === raw);
  return hit ?? cands.reduce((best, s) => ((s.score ?? 0) > (best.score ?? 0) ? s : best));
}
