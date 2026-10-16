// Cover thumbnails (library tiles): the in-memory LRU rung + the persistent
// localStorage rung (1-month expiry, capped, quota-honest).
//
// The tile's cover is page 0 of the READING order — the same bytes the
// reader loads, so the thumb you saw in the grid is the blob the reader
// opens. The down-scaled JPEG data URL survives app restarts on the TV;
// sign-out clears the account's artwork.
//
// Run: pnpm test
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const tile = read("src/ui/components/ItemTile.svelte");
const app = read("src/ui/App.svelte");

/* ---------------- cover thumbnails (library tiles, v1.1) -------------------
 * The user's ask: "what about using cover, if found, as thumb?" The cover
 * is page 0 — fetched by the tile with the same range-read path, cached in
 * the page LRU under pageKey(id, 0), so the thumb you saw in the grid is
 * the blob the reader loads on open. No cover / failure → the 📖 glyph
 * (honest fallback, never an empty thumb). `tile` is read above (line ~226).
 */

test("tile: a .cbz tile loads its cover (openArchive -> model -> first page -> cache)", () => {
  assert.ok(/openArchive\(/.test(tile), "the tile pays the two-stage open itself (it owns the preview)");
  assert.ok(/buildComicModel\(/.test(tile), "…and takes the cover from the READING order (pages[0]), not the raw entry list");
  assert.ok(/extractEntry\(/.test(tile), "the cover bytes come through the range-read + inflate path");
  assert.ok(/pageKey\(.*id.*,\s*0\)/.test(tile), "…cached under page 0 — the reader's first sheet is then a cache hit");
  assert.ok(/pageCache\.put\(/.test(tile), "…and the tile hands the blob to the LRU (which owns it — eviction revokes)");
});

test("tile: a cover that fails falls back to the glyph (an empty thumb is a lie)", () => {
  assert.ok(/coverState = "failed"/.test(tile) || /coverFailed/.test(tile), "the failure state exists and is honest");
  assert.ok(/📖/.test(tile), "…and the 📖 glyph remains the fallback behind it");
});

test("tile: the probe comes from the shared img-probe (not a third copy of withDims)", () => {
  assert.ok(/img-probe/.test(tile), "the dimension probe is the shared module");
});

/* ---------------- persistent thumbs (IndexedDB, 1-month expiry, 2000 cap) ---
 * "Thumbs need to be cached locally, expired after a month." The tile's
 * cover becomes a down-scaled JPEG BLOB persisted in IndexedDB under the
 * file id (the 16 MB localStorage wall was quietly evicting covers on
 * bigger libraries); the next launch shows it with ZERO network. An IDB
 * refusal = memory-only session (honest). Sign-out clears the account's
 * artwork.
 */
const thumbStore = read("src/store/thumb-store.ts");

test("thumb store: the persistent rung is IndexedDB (past the 16 MB localStorage wall)", () => {
  assert.ok(/putio\/idb/.test(thumbStore), "the store sits on the IDB wrapper");
  assert.ok(!/localStorage\.(get|set|remove)Item/.test(thumbStore), "no localStorage access — that's the wall the covers used to hit");
  assert.ok(/THUMB_TTL_MS/.test(thumbStore) && /THUMB_MAX_ENTRIES/.test(thumbStore), "TTL + cap rules live with the store");
  assert.ok(/firstKeyBy\(/.test(thumbStore), "cap eviction walks the savedAt index (oldest first)");
  assert.ok(/dbFailed/.test(thumbStore), "an IDB refusal degrades to memory-only (never thrown)");
});

test("tile: the PERSISTENT thumb is consulted FIRST (a saved cover costs zero network)", () => {
  const lc = tile.slice(tile.search("function loadCover"), tile.search("function loadCover") + 2600);
  const atPersist = lc.indexOf("getThumb(");
  const atMemory = lc.indexOf("pageCache.get(");
  assert.ok(atPersist >= 0, "…it reads the persistent store");
  assert.ok(atMemory >= 0, "…then the in-memory page cache");
  assert.ok(atPersist < atMemory, "…in that order (the persistent hit ends the work)");
});

test("tile: a fetched cover is down-scaled to a JPEG blob and persisted", () => {
  assert.ok(!/toDataURL/.test(tile), "no data URLs (base64 bloat was the old path)");
  assert.ok(/toBlob\(/.test(tile), "down-scale = JPEG blob (canvas.toBlob)");
  assert.ok(/putThumb\(/.test(tile), "…and lands in the persistent store");
});

test("tile: storage refusing (quota) is a quiet fallback — the cover still shows", () => {
  assert.ok(/putThumb\(/.test(tile));
  const lc = tile.slice(tile.search("function showDownscaled") >= 0 ? tile.search("function showDownscaled") : tile.search("function loadCover"), tile.length);
  assert.ok(!/throw/.test(lc), "…never thrown into the grid");
});

test("app: signing out clears the persistent thumbs (the account's artwork)", () => {
  assert.ok(/clearThumbs\(\)/.test(app), "the unauthed handler clears the thumb store");
});

test("tile: a cached cover that won't decode is RE-FETCHED from the network (stale bytes are not truth)", () => {
  const sdc = tile.slice(tile.search("function showDownscaled"), tile.search("function showDownscaled") + 1600);
  assert.ok(/loadCover\(true\)/.test(sdc), "the onerror path re-enters loadCover with forceNetwork");
  assert.ok(/forceNetwork/.test(tile), "…and loadCover has the escape hatch (skip the stale LRU rung)");
});
