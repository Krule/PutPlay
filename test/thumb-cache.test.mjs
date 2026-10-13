// Persistent cover-thumbnail cache (pure core).
//
// The library's comic tiles keep their cover thumbs on the TV after a
// session: a down-scaled data URL per file id, with a savedAt stamp.
// Entries expire after a month (the user's rule), the map is capped, and
// corrupt storage degrades to empty (the tile falls back to fetching).
//
// The pure core here is storage-agnostic (raw JSON string in/out) so it is
// node-testable; the thin localStorage wrapper lives in store/thumb-store.ts.
//
// Run: npm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "thumbcache-"));
await build({
  entryPoints: [join(here, "..", "src/putio/thumb-cache.ts")],
  bundle: true,
  format: "cjs",
  target: "es2019",
  outfile: join(dir, "bundle.cjs"),
});
const req = createRequire(import.meta.url);
const tc = req(join(dir, "bundle.cjs"));

const DAY = 24 * 3600 * 1000;
const NOW = 1_760_000_000_000; // an arbitrary fixed "now"
const entry = (savedAt, dataUrl = "data:image/jpeg;base64,AAA") => ({
  dataUrl,
  w: 480,
  h: 735,
  savedAt,
});

test("loadThumbs: null / empty / corrupt storage all mean an empty map (no throw)", () => {
  assert.deepEqual(tc.loadThumbs(null, NOW), {});
  assert.deepEqual(tc.loadThumbs("", NOW), {});
  assert.deepEqual(tc.loadThumbs("{nope", NOW), {});
  assert.deepEqual(tc.loadThumbs("[1,2]", NOW), {});
});

test("loadThumbs: parses a valid map and prunes entries older than the TTL (1 month)", () => {
  const map = {
    "1": entry(NOW - 5 * DAY),
    "2": entry(NOW - 40 * DAY), // expired (31+ days old)
    "3": entry(NOW - 1 * DAY),
  };
  const loaded = tc.loadThumbs(JSON.stringify(map), NOW);
  assert.deepEqual(Object.keys(loaded).sort(), ["1", "3"]);
  assert.equal(loaded["1"].dataUrl, "data:image/jpeg;base64,AAA");
});

test("loadThumbs: an entry exactly at the TTL boundary is kept (expires AFTER a month, not at)", () => {
  const map = { "1": entry(NOW - tc.THUMB_TTL_MS + 1000) };
  assert.deepEqual(Object.keys(tc.loadThumbs(JSON.stringify(map), NOW)), ["1"]);
});

test("thumbFor: fresh hit returns the entry; expired / missing / wrong-shape return null", () => {
  const thumbs = { "1": entry(NOW - 2 * DAY) };
  assert.equal(tc.thumbFor(thumbs, 1, NOW).dataUrl, "data:image/jpeg;base64,AAA");
  assert.equal(tc.thumbFor(thumbs, "1", NOW).dataUrl, "data:image/jpeg;base64,AAA"); // numeric id keys as strings
  assert.equal(tc.thumbFor(thumbs, 2, NOW), null);
  const stale = { "1": entry(NOW - 40 * DAY) };
  assert.equal(tc.thumbFor(stale, 1, NOW), null);
  const broken = { "1": { w: 480 } };
  assert.equal(tc.thumbFor(broken, 1, NOW), null);
});

test("setThumb: adds, updates, and persists the newest entry first (insertion recency)", () => {
  let m = tc.setThumb({}, 7, entry(NOW - 1 * DAY));
  m = tc.setThumb(m, 8, entry(NOW));
  assert.deepEqual(Object.keys(m).sort(), ["7", "8"]);
  m = tc.setThumb(m, 7, entry(NOW)); // update — must not duplicate
  assert.deepEqual(Object.keys(m).sort(), ["7", "8"]);
  assert.equal(m["7"].savedAt, NOW);
});

test("setThumb: evicts the OLDEST entry when the cap is exceeded (never a fresh one)", () => {
  let m = {};
  for (let i = 1; i <= tc.THUMB_MAX_ENTRIES; i += 1) {
    // i=40 is the oldest (furthest back); i=1 the freshest
    m = tc.setThumb(m, i, entry(NOW - i * DAY));
  }
  m = tc.setThumb(m, 999, entry(NOW));
  assert.equal(Object.keys(m).length, tc.THUMB_MAX_ENTRIES);
  assert.equal("40" in m, false, "the oldest is gone");
  assert.equal("1" in m, true, "…not the freshest old entry");
  assert.equal("999" in m, true, "the new one stays");
});

test("saveThumbs: round-trips through JSON (and the pruned map is what gets written)", () => {
  const m = tc.setThumb({}, 5, entry(NOW));
  const raw = tc.saveThumbs(m);
  assert.deepEqual(tc.loadThumbs(raw, NOW), m);
});

test("eviction + TTL compose: expired entries make room without counting against the cap", () => {
  let m = {};
  for (let i = 1; i <= tc.THUMB_MAX_ENTRIES; i += 1) {
    m = tc.setThumb(m, i, entry(NOW - (i + 35) * DAY)); // ALL expired
  }
  m = tc.loadThumbs(tc.saveThumbs(m), NOW); // prune
  assert.deepEqual(m, {});
  m = tc.setThumb(m, 42, entry(NOW));
  assert.deepEqual(Object.keys(m), ["42"]);
});
