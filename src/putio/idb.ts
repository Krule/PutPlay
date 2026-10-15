/**
 * A tiny IndexedDB key-value wrapper.
 *
 * Why: webOS caps localStorage at 16 MB per origin, which quietly
 * evicted comic covers on bigger libraries (the old 24-entry cap was a
 * patch for that wall). IndexedDB lives in the app-storage world and is
 * the durable home for cover blobs — and, later, the reader's page
 * cache.
 *
 * Shape: ONE object store ("kv"), explicit keys, structured-cloneable
 * values (Blob, string, plain objects). An upgrade hook creates indexes
 * on first open / version bump only. Every method PROMISES and only
 * rejects — callers decide how to degrade (the grid never throws).
 */

const STORE = "kv";

export interface IdbHandle {
  /** Write (or overwrite) one entry. Resolves when committed. */
  put(key: IDBValidKey, value: unknown): Promise<void>;
  /** Read one entry; a missing key resolves to undefined. */
  get<T>(key: IDBValidKey): Promise<T | undefined>;
  /** Delete one entry (a missing key is a no-op). */
  delete(key: IDBValidKey): Promise<void>;
  /** Number of entries in the store. */
  count(): Promise<number>;
  /**
   * Primary key of the LOWEST value in the named index (a range-less
   * cursor walks the index in order; take the first entry) — "give me
   * the oldest key" for a savedAt-style index. Undefined when empty.
   */
  firstKeyBy(indexName: string): Promise<IDBValidKey | undefined>;
  /** Empty the store (sign-out: the previous account's covers go). */
  clear(): Promise<void>;
  /** Close the connection (app teardown). */
  close(): void;
}

/** Resolve on a single request's success. */
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Resolve when the whole transaction commits (write durability). */
function committed(txn: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    txn.oncomplete = () => resolve();
    txn.onerror = () => reject(txn.error);
    txn.onabort = () => reject(txn.error ?? new Error("transaction aborted"));
  });
}

/**
 * Open (creating if needed) the named database. `upgrade` runs in the
 * onupgradeneeded context — create indexes there; it runs exactly once
 * per version, never on a same-version reopen.
 */
export function openIdb(
  name: string,
  version: number,
  upgrade?: (store: IDBObjectStore) => void
): Promise<IdbHandle> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name, version);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.objectStoreNames.contains(STORE)
        ? db.transaction(STORE, "readwrite").objectStore(STORE)
        : db.createObjectStore(STORE);
      upgrade?.(store);
    };
    req.onsuccess = () => {
      const db = req.result;
      const ro = () => db.transaction(STORE, "readonly").objectStore(STORE);
      // one readwrite transaction per mutation, resolved on commit
      const write = (fn: (store: IDBObjectStore) => void) => {
        const txn = db.transaction(STORE, "readwrite");
        fn(txn.objectStore(STORE));
        return committed(txn);
      };
      resolve({
        put: (key, value) => write((s) => s.put(value, key)),
        get: (key) => request(ro().get(key)),
        delete: (key) => write((s) => s.delete(key)),
        count: () => request(ro().count()),
        firstKeyBy: (indexName) =>
          new Promise((resolve, reject) => {
            // a range-less cursor walks the index in order — the first
            // entry is the lowest value (no minKey constant: it isn't in
            // the Chrome 79 type surface)
            const req = ro().index(indexName).openCursor();
            req.onsuccess = () => resolve(req.result ? req.result.primaryKey : undefined);
            req.onerror = () => reject(req.error);
          }),
        clear: () => write((s) => s.clear()),
        close: () => db.close(),
      });
    };
    req.onerror = () => reject(req.error);
  });
}
