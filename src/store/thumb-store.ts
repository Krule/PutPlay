/**
 * The persistent comic-cover store (IndexedDB).
 *
 * Why IndexedDB: webOS caps localStorage at 16 MB per origin, which
 * quietly evicted covers on bigger libraries (the old 24-entry cap was
 * a patch for that wall). IndexedDB lives in the app-storage world:
 * 2000 covers of ~40 KB blobs is a drop in it.
 *
 * Rules (unchanged from the localStorage era):
 *  - a cover EXPIRES after a month (checked on read; expired entries
 *    are pruned there, so storage never hoards dead artwork);
 *  - the store is capped (2000) — the OLDEST by savedAt yields;
 *  - sign-out clears the store (covers are the account's artwork, same
 *    rule as the shelf).
 *
 * Failure posture: the store NEVER rejects into the grid. A missing or
 * refusing IDB degrades to an in-memory session — covers still display,
 * they just won't persist. putThumb resolves false on a storage refusal
 * (true otherwise, or when memory-only).
 */
import { openIdb, type IdbHandle } from "../putio/idb";

export const THUMB_TTL_MS = 30 * 24 * 3600 * 1000;
export const THUMB_MAX_ENTRIES = 2000;
export const THUMB_DB_NAME = "putplay.thumbs";
const DB_VERSION = 1;
const SAVED_AT_INDEX = "savedAt";

export interface ThumbEntry {
  /** The down-scaled cover (JPEG blob — no base64 bloat). */
  blob: Blob;
  w: number;
  h: number;
  /** Epoch ms; the TTL and the eviction order both read it. */
  savedAt: number;
}

let db: IdbHandle | null = null;
let dbFailed = false;
/** Covers viewed THIS session — memory serves even when storage doesn't. */
const memory = new Map<string, ThumbEntry>();

/**
 * Test seam: drop the connection and the session memory so a test can
 * start from a clean slate (and recover from the IDB-failure test).
 */
export function __resetForTests(): void {
  db?.close();
  db = null;
  dbFailed = false;
  memory.clear();
}

/** Open (creating if needed); a refusal means memory-only for the session. */
function connect(): Promise<IdbHandle | null> {
  if (db) return Promise.resolve(db);
  if (dbFailed) return Promise.resolve(null);
  return openIdb(THUMB_DB_NAME, DB_VERSION, (store) => {
    if (!store.indexNames.contains(SAVED_AT_INDEX)) store.createIndex(SAVED_AT_INDEX, SAVED_AT_INDEX);
  })
    .then((handle) => {
      db = handle;
      return handle;
    })
    .catch(() => {
      dbFailed = true; // honest degradation: this session is memory-only
      return null;
    });
}

const keyOf = (fileId: number | string) => String(fileId);
const isFresh = (e: ThumbEntry, now: number) => now - e.savedAt < THUMB_TTL_MS;

/**
 * The fresh cover for a file, or undefined. An expired entry is a miss
 * and gets pruned from the store on the way out.
 */
export function getThumb(fileId: number | string): Promise<ThumbEntry | undefined> {
  const key = keyOf(fileId);
  const now = Date.now();
  const mem = memory.get(key);
  if (mem) {
    if (isFresh(mem, now)) return Promise.resolve(mem);
    memory.delete(key); // expired even in memory
  }
  return connect().then(async (handle) => {
    if (!handle) return undefined;
    try {
      const entry = (await handle.get<ThumbEntry>(key)) ?? undefined;
      if (!entry) return undefined;
      if (!isFresh(entry, now)) {
        await handle.delete(key); // prune on read
        return undefined;
      }
      memory.set(key, entry);
      return entry;
    } catch {
      return undefined; // a torn read is a miss, never a throw
    }
  });
}

/**
 * Persist a cover. ALWAYS updates session memory first — a storage
 * refusal must not make THIS session forget the cover. Resolves true
 * when the cover is on device (or memory-only), false when storage was
 * refused.
 */
export function putThumb(fileId: number | string, entry: ThumbEntry): Promise<boolean> {
  memory.set(keyOf(fileId), entry);
  return connect()
    .then(async (handle) => {
      if (!handle) return false;
      await handle.put(keyOf(fileId), entry);
      await evictOverCap(handle);
      return true;
    })
    .catch(() => false);
}

/** Keep the store at or under the cap: the oldest cover yields. */
async function evictOverCap(handle: IdbHandle): Promise<void> {
  for (;;) {
    if ((await handle.count()) <= THUMB_MAX_ENTRIES) return;
    const oldest = await handle.firstKeyBy(SAVED_AT_INDEX);
    if (oldest === undefined) return; // concurrent deletion; re-count
    await handle.delete(oldest);
  }
}

/** Sign-out: the previous account's covers go with the session. */
export function clearThumbs(): Promise<void> {
  memory.clear();
  return connect()
    .then((handle) => (handle ? handle.clear() : Promise.resolve()))
    .catch(() => undefined);
}
