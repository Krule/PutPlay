/**
 * The persistent cover-thumb store: the thin localStorage wrapper over the
 * pure thumb-cache core. Module-level, like the comic progress store — the
 * grid is the only writer, and sign-out clears it (the covers are the
 * account's artwork, same rule as the shelf).
 *
 * Quota honesty: putThumb returns false when the TV's storage refuses
 * (QuotaExceededError) — the tile still displays the cover from memory;
 * it just won't survive the next launch. Never throw into the grid.
 */
import {
  loadThumbs,
  saveThumbs,
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
 * Store a thumb (TTL prune + cap eviction are the pure core's job).
 * Returns false when storage is missing or refuses the write — the caller
 * must treat that as "displayed, not persisted", not as an error.
 */
export function putThumb(fileId: number | string, entry: ThumbEntry): boolean {
  const s = storage();
  if (!s) return false;
  const next = setThumb(load(), fileId, entry);
  try {
    s.setItem(KEY, saveThumbs(next));
    cache = next;
    return true;
  } catch {
    return false; // quota: the in-memory map keeps serving THIS session
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
