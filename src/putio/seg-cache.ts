/**
 * The app's SegCache for seglookup — IndexedDB-backed (the thumb-store's
 * pattern: a module-level connection, honest memory-only degradation when
 * storage is refused). The same episode re-played costs zero network.
 *
 * The policy (TTL, non-empty-only writes) lives in seglookup.ts — this
 * store is a dumb, never-throwing key/value box.
 */

import { openIdb, type IdbHandle } from "./idb";
import type { SegCache, SegCacheEntry } from "./seglookup";

const DB_NAME = "putplay.segcache";
const DB_VERSION = 1;

let db: IdbHandle | null = null;
let dbFailed = false;
/** Lookups resolved THIS session — memory serves even when storage doesn't. */
const memory = new Map<string, SegCacheEntry>();

/** Open (creating if needed); a refusal means memory-only for the session. */
function connect(): Promise<IdbHandle | null> {
  if (db) return Promise.resolve(db);
  if (dbFailed) return Promise.resolve(null);
  return openIdb(DB_NAME, DB_VERSION)
    .then((handle) => {
      db = handle;
      return handle;
    })
    .catch(() => {
      dbFailed = true;
      return null;
    });
}

export const segCache: SegCache = {
  get(key) {
    const mem = memory.get(key);
    if (mem) return Promise.resolve(mem);
    return connect().then((h) => (h ? h.get<SegCacheEntry>(key) : Promise.resolve(undefined)));
  },
  put(key, value) {
    memory.set(key, value);
    return connect().then((h) => (h ? h.put(key, value).catch(() => {}) : Promise.resolve()));
  },
};
