/**
 * Persistent cover-thumbnail cache (pure core).
 *
 * The library's comic tiles keep their cover thumbs on the TV across
 * sessions: one down-scaled data URL per file id, stamped with savedAt.
 *
 * The rules (user request, 2026-10):
 *   - entries EXPIRE after a month (THUMB_TTL_MS) — pruned on every load;
 *   - the map is capped (THUMB_MAX_ENTRIES) — the oldest yields to the new;
 *   - corrupt storage is an empty map, never a crash (the tile simply
 *     re-fetches its cover);
 *   - an id-keyed map: the tile is the only writer, the file id the only key.
 *
 * Storage-agnostic on purpose: raw JSON string in, JSON string out — the
 * thin localStorage wrapper (with its quota handling) is store/thumb-store.ts.
 */

export interface ThumbEntry {
  /** Down-scaled cover as a data: URL (JPEG, ~480px wide). */
  dataUrl: string;
  /** Down-scaled width (informational; the <img> sizes itself). */
  w: number;
  /** Down-scaled height (informational). */
  h: number;
  /** Epoch ms when the entry was written. The expiry clock. */
  savedAt: number;
}

/** file-id (as a string) -> entry. */
export type ThumbMap = Record<string, ThumbEntry>;

/** One month, in ms. A thumb older than this is stale art — gone. */
export const THUMB_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * The map's cap. At ~50–150 KB per down-scaled JPEG, 40 entries stay well
 * inside a 5 MB localStorage while covering a full season of comics.
 */
export const THUMB_MAX_ENTRIES = 40;

/** Is this entry's shape intact? (Corrupt maps are dropped wholesale.) */
function isEntry(v: unknown): v is ThumbEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.dataUrl === "string" &&
    e.dataUrl.indexOf("data:image") === 0 &&
    typeof e.savedAt === "number"
  );
}

/**
 * Parse a stored map and prune every expired entry. null / empty / corrupt
 * input is `{}` — the honest floor. `now` is injected for testability.
 */
export function loadThumbs(raw: string | null, now: number): ThumbMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: ThumbMap = {};
  for (const [id, e] of Object.entries(parsed as Record<string, unknown>)) {
    if (isEntry(e) && now - e.savedAt < THUMB_TTL_MS) out[id] = e;
  }
  return out;
}

/** A fresh entry for this file, or null (missing, expired, or corrupt). */
export function thumbFor(
  thumbs: ThumbMap,
  fileId: number | string,
  now: number,
): ThumbEntry | null {
  const e = thumbs[String(fileId)];
  if (!e || !isEntry(e) || now - e.savedAt >= THUMB_TTL_MS) return null;
  return e;
}

/**
 * Set (or update) one entry and enforce the cap: over THUMB_MAX_ENTRIES,
 * the entry with the oldest savedAt is evicted. Returns the new map —
 * the caller persists it (and handles quota errors).
 */
export function setThumb(
  thumbs: ThumbMap,
  fileId: number | string,
  entry: ThumbEntry,
): ThumbMap {
  const id = String(fileId);
  const out: ThumbMap = { ...thumbs, [id]: entry };
  const over = Object.keys(out).length - THUMB_MAX_ENTRIES;
  if (over > 0) {
    // oldest first; the id we just wrote is never the oldest candidate
    // (a caller re-writing the same id keeps its place, which is fine —
    // eviction only fires when the map is FULL of other books)
    const ranked = Object.entries(out).sort((a, b) => a[1].savedAt - b[1].savedAt);
    for (let i = 0; i < over; i += 1) delete out[ranked[i][0]];
  }
  return out;
}

/** Serialize for storage. */
export function saveThumbs(thumbs: ThumbMap): string {
  return JSON.stringify(thumbs);
}
