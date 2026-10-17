/**
 * The app's InfoCache for info-data — IndexedDB-backed (the seg-cache's
 * pattern: a module-level lazy connection, honest memory-only degradation
 * when storage is refused, never a throw). The same file re-opened in the
 * player's Info tab costs zero network.
 */

import { openIdb, type IdbHandle } from "./idb";
import type { InfoCache } from "./info-data";

const DB_NAME = "putplay.infocache";
const DB_VERSION = 1;

let db: IdbHandle | null = null;
let dbFailed = false;
/** Lookups resolved THIS session — memory serves even when storage doesn't. */
const memory = new Map<string, unknown>();

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

export const infoCache: InfoCache = {
  get(key) {
    const mem = memory.get(key);
    if (mem !== undefined) return Promise.resolve(mem);
    return connect().then((h) => (h ? h.get<unknown>(key) : Promise.resolve(undefined)));
  },
  put(key, value) {
    memory.set(key, value);
    return connect().then((h) => (h ? h.put(key, value).catch(() => {}) : Promise.resolve()));
  },
};
