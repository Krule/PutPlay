/**
 * TheIntroDB (theintrodb.org) — the community database of intro / recap /
 * credits / preview timestamps. The networked part is a thin client (no auth
 * needed to READ); the PURE part is parseSegments,
 * which normalizes the API's raw {start_ms, end_ms} shape into the app's
 * own Seg model so the engine and Player never see raw API data.
 *
 * API v4 (theintrodb.org/openapi.yaml — the spec is the source of truth):
 * TVDB is the identity — every RESPONSE is keyed by tvdb_id and tmdb_id no
 * longer appears in a body. We still ADDRESS a media by tmdb_id (the app
 * resolves shows through TMDb): v4 accepts tmdb_id as a query param and
 * resolves it server-side. A media with no submissions answers with an
 * episode list (MediaEpisodeListResponse) instead of a 404 — no segment
 * arrays, so parseSegments degrades to [] as usual. The frozen v2/v3
 * GET /media surfaces are being retired by the maintainer; v4 is the only
 * surface under active development (Krule/PutPlay#1).
 *
 * Raw → normalized rules (the contract parseSegments's tests pin):
 *   - times are MILLISECONDS in the API, SECONDS in the app
 *   - start_ms: null → 0 (the segment starts at the beginning)
 *   - end_ms:   null → null (the segment runs to the end of the media —
 *     end credits). null end is meaningful and must survive as null.
 *   - "preview" (next-episode teasers) is OUT of scope and dropped
 *   - a segment is an array that can hold MORE THAN ONE entry (some
 *     episodes have two recaps) — all are kept, ordered by start
 *   - garbage (wrong type, end before start, negative, non-numeric)
 *     yields NOTHING — never a throw, never a fake segment
 */

export type SegType = "intro" | "recap" | "credits";
export interface Seg {
  type: SegType;
  /** Seconds from the start of the media. */
  start: number;
  /** Seconds from the start, or null = to the end of the media. */
  end: number | null;
}

const API_BASE = "https://api.theintrodb.org/v4";
/** The only segment types the feature acts on (preview is dropped). */
const SEG_TYPES: SegType[] = ["intro", "recap", "credits"];

/** Normalize one raw {start_ms, end_ms} entry, or null when it is garbage. */
function parseEntry(raw: unknown, type: SegType): Seg | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const start = segStart(e.start_ms);
  if (start === null) return null;
  let end: number | null;
  if (e.end_ms === null || e.end_ms === undefined) {
    end = null; // to the end of the media (credits)
  } else {
    end = msToSec(e.end_ms);
    if (end === null) return null;
  }
  if (end !== null && end < start) return null;
  return { type, start, end };
}

/** null → 0 (start at the beginning); a finite number → seconds; else null. */
function segStart(v: unknown): number | null {
  if (v === null || v === undefined) return 0;
  return msToSec(v);
}

function msToSec(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v / 1000;
}

/** Normalize a raw TheIntroDB media object into ordered Seg[]. */
export function parseSegments(raw: unknown): Seg[] {
  if (typeof raw !== "object" || raw === null) return [];
  const obj = raw as Record<string, unknown>;
  const out: Seg[] = [];
  for (const type of SEG_TYPES) {
    const arr = obj[type];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const seg = parseEntry(item, type);
      if (seg) out.push(seg);
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Fetch the segments for one TMDb show (movie) or episode (tv). Public — no
 * auth. Any failure (network, HTTP, JSON, shape) degrades to [] : the honest
 * "nothing to skip" answer, never a throw.
 */
export async function introdbMedia(
  tmdbId: number,
  season?: number,
  episode?: number,
  fetchImpl?: typeof fetch
): Promise<Seg[]> {
  const doFetch = fetchImpl || fetch;
  let url = `${API_BASE}/media?tmdb_id=${tmdbId}`;
  if (typeof season === "number" && typeof episode === "number") {
    url += `&season=${season}&episode=${episode}`;
  }
  try {
    const res = await doFetch(url);
    if (!res.ok) return [];
    const raw: unknown = await res.json();
    return parseSegments(raw);
  } catch {
    return [];
  }
}
