/**
 * TMDb — resolving a show's TITLE (parsed out of the put.io file name) to a
 * TMDb id, the key TheIntroDB is organized by. TMDb requires an API key:
 * the app's is baked in at build time (tmdb-key.ts — a TV has no viable
 * keyboard for it); with an empty key this chain is off.
 *
 * The networked part (tmdbSearchTv) is a thin /3/search/tv client; the PURE
 * part (pickTmdbMatch) decides which result is THE show — a normalization
 * game, because file names are messy ("breaking bad", "BREAKING  BAD!",
 * "Breaking Bad S01E01.720p") and the search returns near-misses. A match
 * we are not sure about is NO match: a wrong episode's timings are worse
 * than no timings, so the feature stays off rather than skips wrongly.
 */

import { normTitle } from "./titles";

export interface TmdbShow {
  id: number;
  name: string;
  first_air_date?: string;
  popularity?: number;
}

const API_BASE = "https://api.themoviedb.org";

/**
 * Search TMDb for a TV show by title. Returns the result list (guarded to a
 * stable shape), or null on any failure (no key, network, HTTP, shape).
 */
export async function tmdbSearchTv(
  key: string,
  title: string,
  year?: number,
  fetchImpl?: typeof fetch
): Promise<TmdbShow[] | null> {
  if (!key || !title) return null;
  const doFetch = fetchImpl || fetch;
  const q = new URLSearchParams({ query: title, language: "en-US" });
  if (typeof year === "number" && year >= 1000 && year <= 9999) {
    q.set("first_air_date_year", String(year));
  }
  try {
    const res = await doFetch(`${API_BASE}/3/search/tv?${q.toString()}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    if (typeof json !== "object" || json === null) return null;
    const results = (json as Record<string, unknown>).results;
    if (!Array.isArray(results)) return null;
    const out: TmdbShow[] = [];
    for (const item of results) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      if (typeof r.id !== "number" || typeof r.name !== "string") continue;
      out.push({
        id: r.id,
        name: r.name,
        first_air_date: typeof r.first_air_date === "string" ? r.first_air_date : undefined,
        popularity: typeof r.popularity === "number" ? r.popularity : undefined,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Pick the result that is the show the file name points at.
 *   1. an EXACT normalized name match wins outright
 *   2. otherwise a NEAR match (the query inside the name, or the name
 *      inside the query) — the "… Season 2" spin-off case
 *   3. among the candidates, a (year) tag decides first, then popularity
 * Nothing close → null: no match is the honest answer.
 */
export function pickTmdbMatch(
  results: TmdbShow[] | null,
  title: string,
  year?: number
): TmdbShow | null {
  if (!results || !results.length || !title) return null;
  const q = normTitle(title);
  if (!q) return null;

  const exact = results.filter((r) => normTitle(r.name) === q);
  const cands = exact.length ? exact : results.filter((r) => {
    const n = normTitle(r.name);
    return n.includes(q) || (q.length >= 6 && n.length >= 6 && q.includes(n));
  });
  if (!cands.length) return null;

  if (typeof year === "number") {
    const byYear = cands.filter((r) => (r.first_air_date || "").startsWith(String(year)));
    if (byYear.length) return mostPopular(byYear);
  }
  return mostPopular(cands);
}

function mostPopular(cands: TmdbShow[]): TmdbShow {
  return cands.reduce((a, b) => ((b.popularity ?? 0) > (a.popularity ?? 0) ? b : a));
}
