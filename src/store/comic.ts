import { writable, get } from "svelte/store";
import { store } from "../webos/platform";
import type { PutFile } from "../putio/types";
import type { ComicModel, Direction } from "../putio/comic";
import { createPageCache, type PageCache } from "../putio/page-cache";
import {
  decodeProgress,
  encodeProgress,
  type ComicProgress,
} from "../putio/comic-progress";

/**
 * Comic-reading state, module-level — the same pattern as the library and
 * archive stores: the screen unmounts and remounts around a reading session
 * (Back to the library, a settings trip, sign-out-in), and the session must
 * survive those swaps. The App makes the comic-vs-archive decision (after one
 * tail read) and puts the result here; the screen renders it.
 */
export interface ComicState {
  file: PutFile | null;
  model: ComicModel | null;
  /** Current page, 0-based. */
  index: number;
  /** This comic's reading order (a per-comic choice, not the global default). */
  direction: Direction;
}

const INITIAL: ComicState = { file: null, model: null, index: 0, direction: "ltr" };

export const comic = writable<ComicState>({ ...INITIAL });

export function setComic(file: PutFile, model: ComicModel, index: number, direction: Direction): void {
  comic.set({ file, model, index, direction });
}

export function resetComic(): void {
  comic.set({ ...INITIAL });
}

/* ---------------- the "continue reading" shelf ----------------
 *
 * One record per comic file: last page, page count, direction, when. It
 * lives in the SAME persistent bridge Settings uses (webOS appData on the
 * TV, localStorage in the browser preview) — a reader that forgets where you
 * left off when the app restarts is not a reader.
 */
const SHELF_KEY = "putplay.comic.shelf";
/** Stored shape: file_id → encoded record (a map so upsert is O(1)). */
type ShelfMap = Record<number, string>;

export const shelf = writable<ComicProgress[]>([]);

export function shelfSorted(list: ComicProgress[]): ComicProgress[] {
  return [...list].sort((a, b) => b.updated_at - a.updated_at);
}

/** Load the shelf (idempotent per session). Corrupt records drop out — the
 *  decoder is the honesty gate, never a crash site. */
export async function loadShelf(): Promise<void> {
  const map = await store.get<ShelfMap>(SHELF_KEY, {});
  const list: ComicProgress[] = [];
  for (const key of Object.keys(map)) {
    const p = decodeProgress(map[key]);
    if (p) list.push(p);
  }
  shelf.set(shelfSorted(list));
}

async function persist(map: ShelfMap): Promise<void> {
  await store.set(SHELF_KEY, map);
}

/**
 * Record that `file` was read at `page` in `direction`. Returns the updated
 * (sorted) shelf so callers can update UI without re-reading storage. The
 * record is clamped to the book's current length: progress must never point
 * past the end of the book as it is NOW.
 */
export async function upsertProgress(
  file: PutFile,
  name: string,
  page: number,
  total: number,
  direction: Direction,
): Promise<ComicProgress[]> {
  const map = await store.get<ShelfMap>(SHELF_KEY, {});
  const p: ComicProgress = {
    file_id: file.id,
    name,
    page: Math.min(Math.max(page, 0), Math.max(total - 1, 0)),
    total: Math.max(total, 0),
    direction,
    updated_at: Date.now(),
  };
  map[file.id] = encodeProgress(p);
  await persist(map);
  const list = Object.values(map)
    .map((s) => decodeProgress(s))
    .filter((x): x is ComicProgress => x !== null);
  shelf.set(shelfSorted(list));
  return list;
}

/** Forget one comic (finished or abandoned — the shelf is "continue", not history). */
export async function forgetProgress(fileId: number): Promise<ComicProgress[]> {
  const map = await store.get<ShelfMap>(SHELF_KEY, {});
  if (fileId in map) {
    delete map[fileId];
    await persist(map);
  }
  const list = Object.values(map)
    .map((s) => decodeProgress(s))
    .filter((x): x is ComicProgress => x !== null);
  shelf.set(shelfSorted(list));
  return list;
}

/** Sign-out: the shelf is personal data; it goes with the session. */
export async function clearShelf(): Promise<void> {
  await persist({});
  shelf.set([]);
}

/** Convenience for App's entry decision: this file's remembered record, if any. */
export function progressFor(fileId: number): ComicProgress | null {
  const found = get(shelf).find((p) => p.file_id === fileId);
  return found || null;
}

/* ---------------- the page LRU cache ("already read" memory) -----------
 * Module-level: it survives screen swaps (comic → library → comic) and is
 * SHARED with the library — a comic tile's cover thumbnail is page 0 of
 * the same key space, so the thumb you saw in the grid is the blob the
 * reader loads on open. 10 pages (the C1's number), LRU. The revoke is
 * guarded: node (the tests) has no URL.revokeObjectURL, and a missing
 * revoke there is a no-op, not a leak.
 */
export const pageCache: PageCache = createPageCache(10, (url) => {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
});

/** The cache key for a page: file id + page index (stable per book). */
export const pageKey = (fileId: number, page: number): string => `${fileId}:${page}`;
