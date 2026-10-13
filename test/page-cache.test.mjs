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
