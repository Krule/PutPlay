/**
 * introdb.app — the consensus segment database (https://introdb.app).
 *
 * The strongest single source in the frozen benchmark corpus (its data
 * covers ~93–100% of the consensus labels, where TheIntroDB and AniSkip
 * each reach the 20s–90s) — but it keys on the IMDb id, which the app
 * obtains from the TMDb identity only (the live AniList schema has no
 * IMDb field on Media — a query for `idImdb` 400's the whole search). So
 * this module only takes an already-resolved id.
 *
 * API (verified live 2026-10-18):
 *   GET https://api.introdb.app/segments?imdb_id=<tt…>&season=<n>&episode=<n>   (TV)
 *   GET https://api.introdb.app/segments?imdb_id=<tt…>&is_movie=true            (movie)
 *   → 200 { intro|recap|outro|post_credits: { start_sec, end_sec, start_ms, end_ms,
 *          confidence, submission_count, updated_at } | null,
 *           no_intro|no_recap|no_outro: boolean }
 *
 * Semantics that matter:
 *   • A 200 with all-null segments is a legitimate "no data" answer — and so
 *     is a 200 with low-quality data (a bogus id answered with junk). The
 *     fusion (seglookup.fuseSegments) is what hedges quality: a lone
 *     introdb.app window stands, an agreeing cluster confirms it, a
 *     disagreeing majority outvotes it.
 *   • `outro` is the end credits → "credits". `post_credits` (bonus scenes)
 *     is NOT a skip target → dropped.
 *   • Anonymous reads are rate-limited; failures must degrade to []
 *     (the other two sources still serve).
 */

import type { Seg } from "./introdb.ts";

export function introdbAppUrl(imdbId: string, season?: number, episode?: number): string {
  let url = `https://api.introdb.app/segments?imdb_id=${imdbId}`;
  if (season !== undefined && episode !== undefined) {
    url += `&season=${season}&episode=${episode}`;
  } else {
    url += "&is_movie=true";
  }
  return url;
}

/**
 * Map one introdb.app segments response to Seg[]. Pure — the fetch lives in
 * introdbAppSegments, and the mapping is what the unit tests pin.
 */
export function parseIntrodbAppSegments(raw: unknown): Seg[] {
  const body = asRecord(raw);
  if (!body) return [];
  return [
    segment("intro", body.intro),
    segment("recap", body.recap),
    segment("credits", body.outro), // outro = the end credits
    // post_credits: deliberately not mapped — bonus scenes are not a skip target
  ].filter((s): s is Seg => s !== null);
}

function segment(type: Seg["type"], raw: unknown): Seg | null {
  const r = asRecord(raw);
  if (!r) return null; // null / absent / wrong shape → nothing
  const start = asSeconds(r.start_sec);
  if (start === null) return null;
  const end = asSeconds(r.end_sec);
  if (end !== null && end < start) return null; // inverted window = garbage
  return { type, start, end };
}

/** A non-negative finite number of seconds (the API's start_sec / end_sec). */
function asSeconds(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Fetch introdb.app segments for a resolved show. `season`/`episode` both
 * present → the TV shape; otherwise the movie shape. Any failure (network,
 * non-200, garbage body) → [] — the other sources still serve.
 */
export async function introdbAppSegments(
  imdbId: string,
  season: number | undefined,
  episode: number | undefined,
  fetchImpl?: typeof fetch
): Promise<Seg[]> {
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(introdbAppUrl(imdbId, season, episode));
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  return parseIntrodbAppSegments(body);
}
