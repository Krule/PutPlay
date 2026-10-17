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
 * TMDb movie search — the movie flavor of tmdbSearchTv (the name field may
 * be `title`, the year filter is `primary_release_year`). The results are
 * mapped onto TmdbShow so the match rules (pickTmdbMatch) apply unchanged.
 * null on any failure (no key, network, HTTP, shape).
 */
export async function tmdbSearchMovie(
  key: string,
  name: string,
  year?: number,
  fetchImpl?: typeof fetch
): Promise<TmdbShow[] | null> {
  if (!key || !name) return null;
  const doFetch = fetchImpl || fetch;
  const q = new URLSearchParams({ query: name, language: "en-US" });
  if (typeof year === "number" && year >= 1000 && year <= 9999) {
    q.set("primary_release_year", String(year));
  }
  try {
    const res = await doFetch(`${API_BASE}/3/search/movie?${q.toString()}`, {
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
      if (typeof r.id !== "number") continue;
      const rawName = typeof r.title === "string" ? r.title : r.name;
      if (typeof rawName !== "string" || rawName === "") continue;
      out.push({
        id: r.id,
        name: rawName,
        first_air_date: typeof r.release_date === "string" ? r.release_date : undefined,
        popularity: typeof r.popularity === "number" ? r.popularity : undefined,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** One search attempt of the movie query ladder. */
export interface MovieQueryStage {
  title: string;
  year?: number;
}

/**
 * The movie search ladder, in priority order. TMDb's movie search is
 * near-exact: ANY extra token answers 0 results (verified live —
 * "Kindergarten Cop 1990" → 0, "Kindergarten Cop" y=1990 → 1; "Blade
 * Runner" y=2049 → 0, "Blade Runner 2049" → 1, because the 2049 film's
 * primary_release_year is 2017). The parser already strips the known
 * scene junk; what survives is at most a trailing SPACE year (kept — it
 * may be the title) and an unknown group tail ("Licdom"). The ladder
 * re-forms the query:
 *   1. as parsed
 *   2. last word dropped — the group tail; when that word is a 4-digit
 *      year it moves to the year param instead
 *   3. (a) the shortened title's trailing space year moved to the param
 *      (stacked tail: "…Movie 2020 Group") — or (b) the year re-joined
 *      to the full title with no param (the year was part of the name)
 * Bounded to 4 distinct stages. The WALK (lookupMovieInfo, the segment
 * movie chain) stops at the first NON-EMPTY result set — matched or
 * rejected: dropping further risks a containment false-match, and a
 * rejected non-empty set is the honest "no such movie".
 */
export function movieQueryStages(title: string, year?: number): MovieQueryStage[] {
  const t = title.trim();
  const stages: MovieQueryStage[] = [];
  const seen = new Set<string>();
  const push = (stageTitle: string, stageYear: number | undefined) => {
    if (!stageTitle || stages.length >= 4) return;
    const key = `${stageTitle}\u0000${stageYear ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    stages.push(stageYear === undefined ? { title: stageTitle } : { title: stageTitle, year: stageYear });
  };

  const YEAR_TOKEN_RE = /^((19|20)\d{2})$/;
  push(t, year);

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const dropped = words[words.length - 1];
    const shortened = words.slice(0, -1).join(" ");
    const droppedYear = YEAR_TOKEN_RE.exec(dropped);
    push(shortened, year ?? (droppedYear ? parseInt(droppedYear[1], 10) : undefined));
    // stacked tail: the shortened title still ends with a space year
    if (year === undefined) {
      const sw = shortened.split(/\s+/).filter(Boolean);
      const tailYear = YEAR_TOKEN_RE.exec(sw[sw.length - 1]);
      if (sw.length >= 2 && tailYear) push(sw.slice(0, -1).join(" "), parseInt(tailYear[1], 10));
    }
  }
  // the year may be part of the title (Blade Runner 2049)
  if (typeof year === "number") push(`${t} ${year}`, undefined);
  return stages;
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
