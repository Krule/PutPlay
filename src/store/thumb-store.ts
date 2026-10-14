/**
 * The persistent cover-thumb store: the thin localStorage wrapper over the
 * pure thumb-cache core. Module-level, like the comic progress store — the
 * grid is the only writer, and sign-out clears it (the covers are the
 * account's artwork, same rule as the shelf).
 *
 * Quota honesty (the C1's "some thumbs don't persist" report): when the
 * TV's storage is full, persisting DEGRADES — the pure core drops the
 * oldest covers until the rest fits (freshest-first). The in-memory map
 * is NEVER trimmed, so this session still serves every cover; only the
 * on-device subset shrinks. putThumb returns false only when the store
 * refuses even an empty write. Never throw into the grid.
 */
import {
  loadThumbs,
  persistThumbs,
  setThumb,
  thumbFor,
  type ThumbEntry,
  type ThumbMap,
} from "../putio/thumb-cache";

const KEY = "putplay.thumbs.v1";

let cache: ThumbMap | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null; // private-mode-class refusal: in-memory only
  }
}

/** Lazy parse + TTL prune on first read. */
function load(): ThumbMap {
  if (cache) return cache;
  const s = storage();
  cache = s ? loadThumbs(s.getItem(KEY), Date.now()) : {};
  return cache;
}

/** The fresh (not-expired) thumb for a file, or null. */
export function getThumb(fileId: number | string): ThumbEntry | null {
  return thumbFor(load(), fileId, Date.now());
}

/**
 * Store a thumb (TTL prune + cap eviction are the pure core's job; the
 * quota degrade ladder is persistThumbs'). ALWAYS updates the in-memory
 * map — a storage refusal must not make THIS session forget the cover.
 * Returns true when the cover made it onto the device (in full or in the
 * freshest subset that fits), false when storage is missing or refuses.
 */
export function putThumb(fileId: number | string, entry: ThumbEntry): boolean {
  const s = storage();
  if (!s) return false;
  const next = setThumb(load(), fileId, entry);
  cache = next; // memory first — the session never loses a cover
  try {
    const res = persistThumbs(next, (raw) => s.setItem(KEY, raw), Date.now());
    return res.persisted; // false = the store refused even a subset
  } catch {
    return false;
  }
}

/** Sign-out: the previous account's covers go with the session. */
export function clearThumbs(): void {
  cache = {};
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(KEY);
  } catch {
    /* honest no-op */
  }
}
