/**
 * AniSkip (api.aniskip.com — open, no auth): MAL id + episode → the
 * community-measured skip intervals. Live data: new episodes are covered
 * as they air.
 *
 * The service runs TWO databases:
 *   - v2 (current): what the browser extension submits today.
 *   - v1 (legacy): the pre-migration DB — finished series like Black
 *     Clover are covered 170/170 there while v2 has holes, and vice
 *     versa. Both are queried per episode; v2 wins per section type,
 *     v1 fills what v2 lacks (the merge happens in seglookup.ts).
 *
 * v2 requires `types` AND `episodeLength`; its ending END is derived from
 * that length, so the ending maps to credits with end=null (the true
 * length is unknown before playback, and our credits action ends the
 * episode anyway). v1 takes only `types` (the proven CLI call) and
 * speaks snake_case. A start-only intro/recap is dropped — skipping to
 * "somewhere after the opening" is a guess. Any failure (404 = no data,
 * network, garbage shape) answers [] — never a throw.
 */

import type { Seg } from "./introdb";

const API = "https://api.aniskip.com";
const TYPES = "types=op&types=ed&types=mixed-op&types=mixed-ed&types=recap";
/** Required by v2; it feeds only the ending's end time, which is
 *  discarded (see above) — a typical anime episode length stands in. */
const PLACEHOLDER_LENGTH = 2700;

/** The current (v2) DB: camelCase fields, `types` + `episodeLength`. */
export async function aniskipSegments(
  malId: number,
  episode: number,
  fetchImpl?: typeof fetch
): Promise<Seg[]> {
  return parseResults(await fetchJson(fetchImpl,
    `${API}/v2/skip-times/${malId}/${episode}?${TYPES}&episodeLength=${PLACEHOLDER_LENGTH}`),
    (r) => [typeOf(r?.skipType), r?.interval?.startTime, r?.interval?.endTime] as const);
}

/** The legacy (v1) DB: snake_case fields, `types` only. */
export async function aniskipSegmentsV1(
  malId: number,
  episode: number,
  fetchImpl?: typeof fetch
): Promise<Seg[]> {
  return parseResults(await fetchJson(fetchImpl,
    `${API}/v1/skip-times/${malId}/${episode}?types=op&types=ed`),
    (r) => [typeOf(r?.skip_type), r?.interval?.start_time, r?.interval?.end_time] as const);
}

/** The shared response shape: { found, results: [{ interval, skipType }] }
 *  (field names differ between versions — the caller picks them). */
function parseResults(raw: unknown, pick: (r: any) => readonly [Seg["type"] | null, unknown, unknown]): Seg[] {
  const results = (raw as any)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((r) => mapInterval(...pick(r)))
    .filter((s: Seg | null): s is Seg => s !== null);
}

/** One interval → the app's segment shape, or null when it's not an
 *  honest skip window (missing/bad start, start-only intro/recap). */
function mapInterval(type: Seg["type"] | null, st: unknown, en: unknown): Seg | null {
  if (type === null) return null;
  if (typeof st !== "number" || !Number.isFinite(st) || st < 0) return null;
  if (type === "credits") return { type, start: st, end: null };
  if (typeof en === "number" && Number.isFinite(en) && en > st) return { type, start: st, end: en };
  return null;
}

function typeOf(skipType: unknown): Seg["type"] | null {
  if (skipType === "op" || skipType === "mixed-op") return "intro";
  if (skipType === "recap") return "recap";
  if (skipType === "ed" || skipType === "mixed-ed") return "credits";
  return null;
}

/** Fetch + JSON-parse with the shared "never a throw" contract. */
async function fetchJson(fetchImpl: typeof fetch | undefined, url: string): Promise<unknown> {
  const doFetch = fetchImpl || fetch;
  let res: Response;
  try {
    res = await doFetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}
