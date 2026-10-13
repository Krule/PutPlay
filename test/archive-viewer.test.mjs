// Archive viewer v1 (ZIP-only): the UI wiring contracts.
//
// The byte-level behaviour lives in test/zip-parse.test.mjs (pure parser)
// and test/zip-extract.test.mjs (range fetch + pako). This file pins the
// wiring: the library's zip branch, the App's archive screen, and the
// Archive screen's honest states + back stack + hand-off to the (now
// target-based) image viewer.
//
// Scope held in the tests:
//   - .zip opens; other archives keep the "coming soon" toast
//   - ZIP64 / encrypted / corrupt reach the user as words, not a freeze
//   - images inside open in the shared viewer (ViewerTargets with a
//     blob-URL load); non-images get an honest toast (no text preview in v1)
//   - Back pops one archive folder first, then leaves the archive
//   - the e2e fake serves the zip with Range support (the parser depends on it)
//
// Run: npm test
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

/** Top-level script function body (same convention as the other contract tests). */
function bodyOf(src, name, label) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name}() must exist in ${label}`);
  const end = src.indexOf("\n  }", start);
  assert.ok(end > start, `function ${name}() must be closed in ${label}`);
  return src.slice(start, end);
}

const nav = read("src/store/nav.ts");
const lib = read("src/ui/screens/Library.svelte");
const app = read("src/ui/App.svelte");
const archive = read("src/ui/screens/Archive.svelte");
const fake = read("test/e2e/fake-api.js");

test("nav: the app can be showing the archive screen", () => {
  assert.ok(/export type AppScreen = .*"archive"/.test(nav), 'AppScreen must include "archive"');
});

test("library: .zip files open the archive; other archives keep the toast", () => {
  const open = bodyOf(lib, "onOpenFile", "Library.svelte");
  const atZip = open.indexOf("open-archive");
  const atToast = open.indexOf("coming soon");
  assert.ok(atZip >= 0, "a .zip file must dispatch open-archive");
  assert.ok(
    atZip < atToast,
    "the zip branch must come before the 'coming soon' toast (zips are open NOW, rar/7z are not)"
  );
  assert.ok(
    /\\\.zip/i.test(open) && /cbz/i.test(open),
    ".zip AND .cbz are offered (a CBZ is a zip; the App branches comics off it)"
  );
});

test("app: the archive screen is entered and left like the others", () => {
  assert.ok(/import Archive from ".\/screens\/Archive.svelte"/.test(app));
  assert.ok(/screen === "archive"/.test(app), "App must render the archive screen");
  const open = bodyOf(app, "onOpenArchive", "App.svelte");
  assert.ok(/screen = "archive"/.test(open), "onOpenArchive must set screen = archive");
  assert.ok(/pushBackLevel\(\)/.test(open), "entering the archive must protect the level");
  const back = bodyOf(app, "onGlobalBack", "App.svelte");
  assert.ok(
    /screen === "archive"/.test(back) && /screen = "library"/.test(back),
    "the app-level back path must return from the archive to the library"
  );
});

test("archive: honest loading and error states (the ZipError message is the message)", () => {
  assert.ok(
    /openArchive\(/.test(archive),
    "the archive must open through the range-fetch layer (one tail read)"
  );
  assert.ok(
    /archiveView\(/.test(archive),
    "the rows must come from the pure archiveView decision"
  );
  assert.ok(/spinner|Loading/i.test(archive), "a loading state is required (the tail read is network time)");
  assert.ok(
    /ZipError|\.message/.test(archive),
    "the error state must show the honest reason (zip64 / encrypted / corrupt), not a generic failure"
  );
});

test("archive: Back pops one folder level, then leaves the archive", () => {
  const back = bodyOf(archive, "onBack", "Archive.svelte");
  assert.ok(
    /archiveParentPath/.test(back),
    "inside a subfolder, Back must pop one level (the pure path decision)"
  );
  assert.ok(
    /dispatch\("back"\)/.test(back),
    "at the archive root, Back must dispatch back to the App"
  );
});

test("archive: images hand off to the viewer as blob-URL targets; the rest get a toast", () => {
  assert.ok(
    /extractEntry\(/.test(archive),
    "opening an image must extract through the tested extract layer"
  );
  assert.ok(
    /URL\.createObjectURL/.test(archive),
    "extracted bytes become a blob URL for the shared viewer"
  );
  assert.ok(
    /isImageFile/.test(archive),
    "only provably decodable images are offered inside the archive"
  );
  assert.ok(
    /toast/.test(archive),
    "non-image entries (text, video-in-zip) must get an honest toast, not a blank"
  );
});

test("archive: rows reach the handler as ItemTile's PutFile shape (is_folder)", () => {
  // ItemTile hands back the pseudo-file it rendered (id -1, is_folder) —
  // not the ArchiveRow. A handler reading isDir would silently treat
  // folders as files (the e2e caught this: clicking a folder toasted).
  const openRow = bodyOf(archive, "openRow", "Archive.svelte");
  assert.ok(
    /putioIsFolder|is_folder/.test(openRow),
    "openRow must test the folder-ness through the PutFile shape (is_folder), not the row model"
  );
  assert.ok(
    !/row\.isDir|f\.isDir/.test(openRow),
    "openRow must not read isDir — ItemTile never sends it"
  );
});

test("archive: no stale remote handlers leak (BUG 5 contract)", () => {
  assert.ok(/setHandlers\(\{/.test(archive));
  assert.ok(/clearHandlers\(\)/.test(archive), "handlers must be cleared on unmount");
});

test("e2e fake: a NON-comic zip with Range support on /stream (the archive screen's entry)", () => {
  // A zip with >= 2 decodable images is a comic (the App decides after the
  // tail read) — so the archive e2e needs a zip with at most ONE image.
  assert.ok(
    /archive\.zip/.test(fake),
    "the fake library must list a plain archive (the e2e opens it)"
  );
  assert.ok(
    /Range/.test(fake),
    "the fake /stream handler must honour Range requests (the parser lives on it)"
  );
});
