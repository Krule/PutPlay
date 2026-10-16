// The persistent comic-cover store (IndexedDB-backed).
//
// The 16 MB localStorage wall meant the old 24-entry cap — bigger
// libraries had their covers evicted on every launch. IndexedDB lives in
// the app-storage world: the cap is 2000 entries, values are cover
// BLOBS (no base64 bloat), and eviction walks a savedAt index (oldest
// first). The 30-day TTL and the sign-out clear keep their rules.
//
// The store NEVER rejects into the grid: an IDB failure degrades to an
// in-memory session (covers still display; they just won't persist).
//
// Node coverage: fake-indexeddb (a faithful in-memory IDB), so these are
// real behavioral tests.
//
// Run: pnpm test
import "fake-indexeddb/auto";
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "thumbstore-"));
await build({
  entryPoints: [join(here, "..", "src/store/thumb-store.ts")],
  bundle: true,
  format: "cjs",
  target: "es2019",
  outfile: join(dir, "store.cjs"),
});
await build({
  entryPoints: [join(here, "..", "src/putio/idb.ts")],
  bundle: true,
  format: "cjs",
  target: "es2019",
  outfile: join(dir, "idb.cjs"),
});
const req = createRequire(import.meta.url);
const { openIdb } = req(join(dir, "idb.cjs"));
const {
  getThumb,
  putThumb,
  clearThumbs,
  THUMB_TTL_MS,
  THUMB_MAX_ENTRIES,
  THUMB_DB_NAME,
  __resetForTests,
} = req(join(dir, "store.cjs"));

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
const entry = (savedAt = NOW, note = "cover") => ({
  blob: new Blob([note]),
  w: 480,
  h: 735,
  savedAt,
});

/** Every test starts from a clean store + empty session memory. */
async function fresh() {
  __resetForTests();
  await clearThumbs();
  __resetForTests(); // drop the connection the clear opened
}

test("the cap is 2000 and the TTL is a month (the user's rules)", () => {
  assert.equal(THUMB_MAX_ENTRIES, 2000);
  assert.equal(THUMB_TTL_MS, 30 * DAY);
});

test("put then get: a fresh cover round-trips (blob bytes, dimensions, stamp)", async () => {
  await fresh();
  const storedAt = NOW - DAY;
  await putThumb(101, entry(storedAt, "alpha-cover"));
  const got = await getThumb(101);
  assert.equal(await got.blob.text(), "alpha-cover");
  assert.equal(got.w, 480);
  assert.equal(got.savedAt, storedAt, "the stamp survives verbatim");
  // the entry is really in IDB, not only in the session map
  const h = await openIdb(THUMB_DB_NAME, 1);
  assert.equal(await h.count(), 1);
  h.close();
});

test("get: a missing cover resolves to undefined (no throw)", async () => {
  await fresh();
  assert.equal(await getThumb(999), undefined);
});

test("get: an entry exactly at the TTL is expired — and pruned from the store on read", async () => {
  await fresh();
  await putThumb(1, entry(NOW - THUMB_TTL_MS, "ancient"));
  assert.equal(await getThumb(1), undefined, "age >= TTL is expired");
  const h = await openIdb(THUMB_DB_NAME, 1);
  assert.equal(await h.count(), 0, "the expired entry was deleted, not just skipped");
  h.close();
});

test("cap: 2001 covers -> the OLDEST by savedAt yields; the freshest 2000 stay", async () => {
  await fresh();
  for (let i = 1; i <= THUMB_MAX_ENTRIES + 1; i += 1) {
    // i=1 is the oldest (lowest savedAt); i=2001 the freshest
    await putThumb(i, entry(NOW - (THUMB_MAX_ENTRIES + 1 - i) * DAY, `c${i}`));
  }
  const h = await openIdb(THUMB_DB_NAME, 1);
  assert.equal(await h.count(), THUMB_MAX_ENTRIES, "the cap holds");
  // (the store keys by String(fileId) — IDB treats 1 and "1" as different keys)
  assert.equal(await h.get(String(1)), undefined, "the oldest cover is evicted");
  assert.ok(await h.get(String(THUMB_MAX_ENTRIES)), "…not a recent one");
  assert.ok(await h.get(String(THUMB_MAX_ENTRIES + 1)), "…nor the freshest");
  h.close();
});

test("clear: the store AND the session memory go (sign-out)", async () => {
  await fresh();
  await putThumb(1, entry());
  await clearThumbs();
  assert.equal(await getThumb(1), undefined);
  const h = await openIdb(THUMB_DB_NAME, 1);
  assert.equal(await h.count(), 0);
  h.close();
});

test("session memory outlives storage: a wiped store still serves THIS session", async () => {
  await fresh();
  await putThumb(7, entry(NOW - DAY, "kept"));
  // wipe the storage behind the store's back (another connection)
  const h = await openIdb(THUMB_DB_NAME, 1);
  await h.clear();
  h.close();
  const got = await getThumb(7);
  assert.equal(await got.blob.text(), "kept", "memory serves the session even when storage is gone");
});

test("ItemTile: covers are blobs with a disciplined object-URL lifecycle", () => {
  const src = readFileSync(join(here, "..", "src/ui/components/ItemTile.svelte"), "utf8");
  assert.ok(!/toDataURL/.test(src), "the down-scale must produce a blob (toDataURL is the base64 wall)");
  assert.ok(/toBlob\(/.test(src), "canvas.toBlob is the down-scale encoder");
  assert.ok(/createObjectURL/.test(src), "the displayed cover is an object URL");
  assert.match(
    src,
    /onDestroy\(\(\) => \{[\s\S]{0,300}?revokeObjectURL/s,
    "the object URL must be revoked on tile unmount (no leak over a long session)"
  );
  assert.ok(/getThumb\(file\.id\)/.test(src), "the first cover rung must consult the IDB store");
  assert.match(src, /putThumb\(file\.id,\s*\{[^}]*blob/s, "the persisted entry carries the blob");
});

/** Last: it disables the IDB global and restores it in finally. */
test("IDB failure: put resolves false (memory kept), get serves memory — never rejects", async () => {
  const real = globalThis.indexedDB;
  globalThis.indexedDB = { open() { throw new Error("no idb"); } };
  await fresh();
  try {
    const ok = await putThumb(1, entry());
    assert.equal(ok, false, "a storage refusal is a false, not a throw");
    const got = await getThumb(1);
    assert.equal(await got.blob.text(), "cover", "the session still displays the cover");
  } finally {
    globalThis.indexedDB = real;
    __resetForTests();
  }
});
