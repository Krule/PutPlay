// Returning from the player must show the folder you were in — NOT the root.
//
// Issue: "Back to Library should take one to previous 'folder' in Library,
// not to root."
//
// The library store is module-level: it keeps folderId/breadcrumbs/files
// across the player round-trip. The bug was that Library.svelte's onMount
// unconditionally re-listed the ROOT, discarding the folder the user had
// been browsing. The mount decision is therefore extracted into pure,
// tested functions:
//   mountFolderId(state)    — the folder to (re)list on mount: the last
//                             folder, or root (null) if we were at root.
//   needsInitialList(state) — fetch at all, or show the cached listing
//                             instantly (returning from the player must
//                             not flash a spinner and re-fetch).
//   resetLibrary()          — a fresh login must never show the previous
//                             account's folders (the store is module-level
//                             and would otherwise survive re-auth).
//
// Run: pnpm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { get } from "svelte/store";

const out = join(mkdtempSync(join(tmpdir(), "putio-test-")), "library-restore.cjs");
await build({
  entryPoints: ["src/store/library.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const require = createRequire(import.meta.url);
const lib = require(out);

test("mountFolderId: a deep folder survives the player round-trip", () => {
  assert.equal(lib.mountFolderId({ folderId: 12345 }), 12345);
});

test("mountFolderId: at root, mount at root", () => {
  assert.equal(lib.mountFolderId({ folderId: null }), null);
});

test("needsInitialList: first launch (nothing cached) fetches the root", () => {
  assert.equal(
    lib.needsInitialList({ files: [], loading: false, error: null }),
    true
  );
});

test("needsInitialList: returning with a cached listing does NOT re-fetch (no spinner flash)", () => {
  assert.equal(
    lib.needsInitialList({ files: [{ id: 1 }], loading: false, error: null }),
    false
  );
});

test("needsInitialList: a stuck/pending or failed load fetches again", () => {
  assert.equal(
    lib.needsInitialList({ files: [], loading: true, error: null }),
    true
  );
  assert.equal(
    lib.needsInitialList({ files: [], loading: false, error: "boom" }),
    true
  );
});

test("resetLibrary: a fresh login starts at the root with no cached files", () => {
  // simulate "been browsing account A, signed out"
  lib.library.set({
    auth: null,
    loading: false,
    loadingMore: false,
    error: null,
    files: [{ id: 9, name: "A movie" }],
    cursor: null,
    hasMore: false,
    folderId: 9,
    breadcrumbs: [
      { id: null, name: "My Library" },
      { id: 9, name: "Folder" },
    ],
    sortBy: "name",
    sortDir: "asc",
    selected: null,
  });
  lib.resetLibrary();
  const s = get(lib.library);
  assert.equal(s.folderId, null);
  assert.equal(s.files.length, 0);
  assert.equal(s.breadcrumbs.length, 1);
});

const fullState = (overrides) => ({
  auth: null,
  loading: false,
  loadingMore: false,
  error: null,
  files: [],
  cursor: null,
  hasMore: false,
  folderId: null,
  breadcrumbs: [{ id: null, name: "My Library" }],
  sortBy: "name",
  sortDir: "asc",
  selected: null,
  ...overrides,
});

// buildBreadcrumbs (exported for this test): the reset-list rebuild. The
// falsy-zero bug: `if (!folderId)` treated folder id 0 as the root and
// dropped the whole crumb chain (e2e: inside "Movies" (id 0) the header
// still read just "My Library").
test("buildBreadcrumbs: folder id 0 keeps its crumb chain (falsy-zero, not root)", () => {
  lib.library.set(
    fullState({
      folderId: 0,
      breadcrumbs: [
        { id: null, name: "My Library" },
        { id: 0, name: "Movies" },
      ],
    })
  );
  const bc = lib.buildBreadcrumbs(0);
  assert.equal(bc.length, 2, "the Movies crumb must survive the reset-list rebuild");
  assert.equal(bc[1].name, "Movies");
});

test("buildBreadcrumbs: the root (null) starts a fresh chain", () => {
  lib.library.set(
    fullState({
      breadcrumbs: [
        { id: null, name: "My Library" },
        { id: 0, name: "Movies" },
      ],
    })
  );
  const bc = lib.buildBreadcrumbs(null);
  assert.equal(bc.length, 1);
  assert.equal(bc[0].id, null);
});

test("buildBreadcrumbs: a normal folder id keeps the incremental chain", () => {
  lib.library.set(
    fullState({
      folderId: 7,
      breadcrumbs: [
        { id: null, name: "My Library" },
        { id: 0, name: "Movies" },
        { id: 7, name: "Deep" },
      ],
    })
  );
  const bc = lib.buildBreadcrumbs(7);
  assert.equal(bc.length, 3);
});
