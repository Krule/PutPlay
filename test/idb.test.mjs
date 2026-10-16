// Tiny IndexedDB key-value wrapper (pure core).
//
// The thumb cache (and, later, the reader's page cache) needs durable
// key-value storage past localStorage's 16 MB webOS wall. The wrapper
// keeps ONE object store ("kv"), explicit keys, structured-cloneable
// values (Blob, string, ...), and an upgrade hook for index creation.
// Every method PROMISES and only rejects — callers decide how to
// degrade (the grid never throws).
//
// Node coverage: fake-indexeddb provides a faithful in-memory IDB
// (devDependency), so these are real behavioral tests, not source
// patterns.
//
// Run: pnpm test
import "fake-indexeddb/auto"; // sets globalThis.indexedDB for node
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "idbwrap-"));
await build({
  entryPoints: [join(here, "..", "src/putio/idb.ts")],
  bundle: true,
  format: "cjs",
  target: "es2019",
  outfile: join(dir, "bundle.cjs"),
});
const req = createRequire(import.meta.url);
const { openIdb } = req(join(dir, "bundle.cjs"));

let next = 0;
const dbName = () => `putplay-test-${next++}`;
const BLOB = () => new Blob(["cover-bytes"], { type: "image/jpeg" });

test("openIdb: resolves a handle; the upgrade hook runs on first open (index creation)", async () => {
  const name = dbName();
  let upgradeCalls = 0;
  const db = await openIdb(name, 1, (store) => {
    upgradeCalls++;
    store.createIndex("savedAt", "savedAt");
  });
  assert.equal(upgradeCalls, 1, "upgrade runs exactly once, on creation");
  assert.ok(db, "a handle is returned");
  db.close();
});

test("put + get: round-trips strings and blobs; a missing key resolves to undefined", async () => {
  const db = await openIdb(dbName(), 1);
  await db.put(101, "data:image/jpeg;base64,AAA");
  await db.put(102, BLOB());
  assert.equal(await db.get(101), "data:image/jpeg;base64,AAA");
  const blob = await db.get(102);
  assert.ok(blob instanceof Blob, "blobs come back as blobs");
  assert.equal(await blob.text(), "cover-bytes");
  assert.equal(await db.get(999), undefined, "a missing key is undefined, not null");
  db.close();
});

test("put: the same key overwrites (last write wins) and count stays honest", async () => {
  const db = await openIdb(dbName(), 1);
  await db.put(1, "first");
  await db.put(2, "second");
  assert.equal(await db.count(), 2);
  await db.put(1, "first-v2");
  assert.equal(await db.get(1), "first-v2");
  assert.equal(await db.count(), 2, "an update must not duplicate the key");
  db.close();
});

test("delete: removes the entry (get -> undefined, count decrements)", async () => {
  const db = await openIdb(dbName(), 1);
  await db.put(1, "a");
  await db.put(2, "b");
  await db.delete(1);
  assert.equal(await db.get(1), undefined);
  assert.equal(await db.get(2), "b", "the neighbour is untouched");
  assert.equal(await db.count(), 1);
  db.close();
});

test("clear: empties the store", async () => {
  const db = await openIdb(dbName(), 1);
  await db.put(1, "a");
  await db.put(2, "b");
  await db.clear();
  assert.equal(await db.count(), 0);
  assert.equal(await db.get(1), undefined);
  db.close();
});

test("reopen: the upgrade hook does NOT re-run (idempotent app startup)", async () => {
  const name = dbName();
  let calls = 0;
  const upgrade = (store) => {
    calls++;
    if (!store.indexNames.contains("savedAt")) store.createIndex("savedAt", "savedAt");
  };
  const a = await openIdb(name, 1, upgrade);
  await a.put(1, { savedAt: 1000, note: "x" });
  a.close();
  const b = await openIdb(name, 1, upgrade);
  assert.equal(calls, 1, "a same-version reopen must not re-upgrade");
  assert.equal((await b.get(1)).note, "x", "data survives the reopen");
  b.close();
});

test("firstKeyBy: the primary key of the lowest index value (oldest-first); undefined when empty", async () => {
  const db = await openIdb(dbName(), 1, (s) => s.createIndex("savedAt", "savedAt"));
  assert.equal(await db.firstKeyBy("savedAt"), undefined, "an empty store has no first key");
  await db.put(1, { savedAt: 3000 });
  await db.put(2, { savedAt: 1000 });
  await db.put(3, { savedAt: 2000 });
  assert.equal(await db.firstKeyBy("savedAt"), 2, "the OLDEST (lowest savedAt) key comes first");
  assert.equal((await db.get(2)).savedAt, 1000);
  db.close();
});

test("openIdb REJECTS (never throws synchronously) when indexedDB is unavailable", async () => {
  const real = globalThis.indexedDB;
  delete globalThis.indexedDB;
  try {
    await assert.rejects(openIdb(dbName(), 1), "a missing environment must reject, not throw");
  } finally {
    globalThis.indexedDB = real;
  }
});
