// Page LRU cache — the comic reader's "already read" memory (v1.1, C1
// feedback: "the pages we already read should stay cached, eviction
// policy, 10 pages").
//
// A page costs TWO range reads to fetch (local header + data) plus an
// inflate + a decode. Once shown, it stays a blob in this cache until
// the eviction policy drops it — turning back (or forward to a recently
// read sheet) is then a cache hit: no network, no spinner.
//
// The instance is MODULE-level (store/comic.ts owns it) so it survives
// screen swaps (comic → library → comic) within a session, and it is
// shared with the library: a comic tile's COVER thumbnail is page 0 of
// the same key space — the thumb you see in the grid is the blob the
// reader loads on open.
//
// Memory honesty: every evicted (or cleared) blob URL is revoked through
// the injected `revoke` — the TV's webview memory is not a hard drive.
// Worst case at the 10-page cap: 10 × largest page (Mushoku: ~66 MB of
// blobs; decoded bitmaps are freed by the browser when the <img> leaves
// the DOM, and re-decoding from a held blob is local and fast).

export interface CachedPage {
  /** A blob: URL the cache OWNS (it will be revoked on eviction/clear). */
  url: string;
  w: number;
  h: number;
}

export interface PageCache {
  /** The cached page, or null. A hit refreshes recency (LRU). */
  get(key: string): CachedPage | null;
  /** Store a page (it becomes the most recent). When over capacity the
   *  least-recently-used page is evicted — its blob revoked via the
   *  injected revoke. */
  put(key: string, page: CachedPage): void;
  size(): number;
  capacity(): number;
  /** Revoke every held blob and forget them all (sign-out, app exit). */
  clear(): void;
}

export function createPageCache(maxPages: number, revoke: (url: string) => void): PageCache {
  // Map insertion order IS the recency order (delete+set on every touch).
  const entries = new Map<string, CachedPage>();
  const cap = Math.max(1, maxPages);

  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      entries.delete(key); // a hit is a page in play again — refresh it
      entries.set(key, hit);
      return hit;
    },

    put(key, page) {
      entries.delete(key); // a re-put refreshes without double-counting
      while (entries.size >= cap) {
        const oldestKey = entries.keys().next().value as string;
        const evicted = entries.get(oldestKey);
        entries.delete(oldestKey);
        if (evicted) revoke(evicted.url);
      }
      entries.set(key, page);
    },

    size() {
      return entries.size;
    },

    capacity() {
      return cap;
    },

    clear() {
      entries.forEach((p) => revoke(p.url));
      entries.clear();
    },
  };
}

/* ---------------- in-flight page dedup -----------------------------------
 *
 * The prefetch and a turn (or a direction flip mid-flight) can both ask
 * for the SAME page while its range read is still in progress. Without
 * dedup that is two parallel fetches of the same 2 MB page fighting for
 * the TV's bandwidth — the C1's slow-reading report. The deduper hands
 * out the SAME promise for a key until the request SETTLES (success or
 * failure); then the key is free, so a failed page can genuinely retry.
 */
export interface PageDeduper<T> {
  /** The in-flight promise for this key, or a fresh `make()` if none. */
  request(key: string, make: () => Promise<T>): Promise<T>;
  /** Release every in-flight key (screen teardown; the promises finish
   *  on their own — this only stops NEW callers from joining them). */
  clear(): void;
}

export function createPageDeduper<T>(): PageDeduper<T> {
  const inflight = new Map<string, Promise<T>>();

  function request(key: string, make: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing; // join it — one fetch, many readers
    const p = make();
    inflight.set(key, p);
    // settle (either way) frees the key; a rejection is not a pin
    p.then(
      () => {
        if (inflight.get(key) === p) inflight.delete(key);
      },
      () => {
        if (inflight.get(key) === p) inflight.delete(key);
      },
    );
    return p;
  }

  function clear(): void {
    inflight.clear();
  }

  return { request, clear };
}
