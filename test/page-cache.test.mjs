// Page LRU cache (page-cache.ts) — the "already read" memory the C1 asked
// for: 10 pages, evict least-recently-used, revoke evicted blobs.
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pagecache-"));
await build({
  entryPoints: [join(here, "..", "src/putio/page-cache.ts")],
  bundle: true,
  format: "cjs",
  target: "es2019",
  outfile: join(dir, "cache.cjs"),
});
const req = createRequire(import.meta.url);
const { createPageCache } = req(join(dir, "cache.cjs"));

const page = (n) => ({ url: `blob:page-${n}`, w: 100 + n, h: 200 });

test("cache: put then get returns the page; unknown key is null", () => {
  const c = createPageCache(3, () => {});
  c.put("a", page(1));
  assert.deepEqual(c.get("a"), page(1));
  assert.equal(c.get("nope"), null);
  assert.equal(c.size(), 1);
});

test("cache: eviction is LRU — at capacity the least-recently-used page is dropped", () => {
  const revoked = [];
  const c = createPageCache(3, (u) => revoked.push(u));
  c.put("a", page(1));
  c.put("b", page(2));
  c.put("c", page(3)); // full: [a, b, c]
  c.put("d", page(4)); // evicts a (the LRU)
  assert.equal(c.size(), 3);
  assert.deepEqual(revoked, ["blob:page-1"], "the evicted blob is revoked through the injected revoke");
  assert.equal(c.get("a"), null, "the evicted page is gone");
  assert.ok(c.get("b") && c.get("c") && c.get("d"), "the rest survive");
});

test("cache: a GET refreshes recency (the page you just used is the last to go)", () => {
  const revoked = [];
  const c = createPageCache(3, (u) => revoked.push(u));
  c.put("a", page(1));
  c.put("b", page(2));
  c.put("c", page(3));
  c.get("a"); // touch a → recency [b, c, a]
  c.put("d", page(4)); // evicts b now, not a
  assert.deepEqual(revoked, ["blob:page-2"]);
  assert.ok(c.get("a"), "the touched page survived");
  assert.equal(c.get("b"), null);
});

test("cache: a re-put of the same key refreshes recency without double-counting", () => {
  const revoked = [];
  const c = createPageCache(3, (u) => revoked.push(u));
  c.put("a", page(1));
  c.put("b", page(2));
  c.put("a", page(1)); // re-put → recency [b, a], size still 2
  assert.equal(c.size(), 2);
  c.put("c", page(3));
  c.put("d", page(4)); // evicts b (LRU), not a
  assert.deepEqual(revoked, ["blob:page-2"]);
  assert.ok(c.get("a"));
});

test("cache: clear revokes every held blob", () => {
  const revoked = [];
  const c = createPageCache(10, (u) => revoked.push(u));
  c.put("a", page(1));
  c.put("b", page(2));
  c.clear();
  assert.deepEqual(revoked.sort(), ["blob:page-1", "blob:page-2"]);
  assert.equal(c.size(), 0);
  assert.equal(c.get("a"), null);
});

test("cache: capacity is at least 1 (a zero/negative cap is a typo, not a leak)", () => {
  const c = createPageCache(0, () => {});
  assert.equal(c.capacity(), 1);
  c.put("a", page(1));
  c.put("b", page(2));
  assert.equal(c.size(), 1);
});

/* ---------------- in-flight page dedup (the C1's slow-RTL report) --------
 * A direction flip (or any re-prefetch) mid-flight must NOT re-fetch a
 * page that is already being read: two range requests for the same 2 MB
 * page fight for the TV's bandwidth and slow BOTH down. The deduper hands
 * out the SAME promise for a key until the request settles — then the key
 * is free (a fresh failure is allowed to retry).
 */
const dc = req(join(dir, "cache.cjs"));

test("dedup: concurrent requests for one key share ONE underlying fetch", async () => {
  const d = dc.createPageDeduper();
  let calls = 0;
  const make = () => {
    calls += 1;
    return new Promise((r) => setTimeout(() => r({ url: "blob:1", w: 1, h: 1 }), 20));
  };
  const a = d.request("k", make);
  const b = d.request("k", make); // in flight: must reuse
  assert.equal(a, b, "…same promise out");
  const v = await a;
  assert.equal(calls, 1, "exactly one underlying fetch");
  assert.equal(v.url, "blob:1");
});

test("dedup: after SETTLE the key is free (a new request may fetch again)", async () => {
  const d = dc.createPageDeduper();
  let calls = 0;
  const make = () => {
    calls += 1;
    return Promise.resolve({ url: "blob:" + calls, w: 1, h: 1 });
  };
  const v1 = await d.request("k", make);
  const v2 = await d.request("k", make);
  assert.equal(calls, 2, "settled keys don't pin");
  assert.equal(v1.url, "blob:1");
  assert.equal(v2.url, "blob:2");
});

test("dedup: a REJECTED in-flight request frees the key (the retry is allowed)", async () => {
  const d = dc.createPageDeduper();
  const state = { calls: 0 };
  const make = () => {
    state.calls += 1;
    if (state.calls === 1) return Promise.reject(new Error("first fails"));
    return Promise.resolve({ url: "blob:ok", w: 1, h: 1 });
  };
  const first = d.request("k", make);
  first.catch(() => undefined); // silence the expected rejection
  await new Promise((r) => setTimeout(r, 5));
  const second = await d.request("k", make); // must be a fresh attempt
  assert.equal(second.url, "blob:ok");
  assert.equal(state.calls, 2);
});

test("dedup: distinct keys are independent; clear() releases everything", async () => {
  const d = dc.createPageDeduper();
  let calls = 0;
  const make = () => {
    calls += 1;
    return new Promise((r) => setTimeout(() => r({ url: "blob:" + calls, w: 1, h: 1 }), 10));
  };
  const p1 = d.request("a", make);
  const p2 = d.request("b", make);
  d.clear();
  await Promise.all([p1, p2]);
  assert.equal(calls, 2);
});
