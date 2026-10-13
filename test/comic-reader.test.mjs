// Comic reader v1: the UI wiring contracts.
//
// The byte-level behaviour lives in test/zip-parse.test.mjs (parser),
// test/zip-extract.test.mjs (range + pako) and test/comic-core.test.mjs
// (ordering, direction, zoom, progress format). This file pins the wiring:
//
//   - opening a zip/cbz is a DECISION made by the App after one tail read —
//     isComicZip (>= 2 decodable images) → comic screen, else the archive
//     browser. A corrupt/zip64/encrypted file toasts and stays put.
//   - the comic screen: page display, ←/→ turn (direction-aware, no wrap),
//     OK zoom (fit → 2x → 4x) with clamped pan, Up flips the reading
//     direction (persisted per comic), Back exits, a progress bar that
//     fills from the right in RTL, the next page prefetched while the
//     current one displays, blob URLs revoked, a corrupt page gets an
//     honest error state (never a silent skip).
//   - progress + direction persist per comic (the platform store — the same
//     appData/localStorage bridge Settings uses), decoded with the honest
//     comic-progress decoder.
//   - Settings carries the global reading-direction default (ships LTR).
//   - .cbz is an entry, not a "coming soon" (it IS a zip).
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
const settings = read("src/ui/screens/Settings.svelte");
const store = read("src/store/comic.ts");
const screen = read("src/ui/screens/Comic.svelte");

/* ---------------- navigation ---------------- */

test("nav: the app can be showing the comic screen", () => {
  assert.ok(/export type AppScreen = .*"comic"/.test(nav), 'AppScreen must include "comic"');
});

/* ---------------- the App's entry decision ---------------- */

test("app: opening a zip is a decision made AFTER the tail read", () => {
  const open = bodyOf(app, "onOpenArchive", "App.svelte");
  const atRead = open.indexOf("openArchive(");
  const atBranch = open.indexOf("isComicZip(");
  const atComic = open.indexOf('"comic"');
  assert.ok(atRead >= 0, "the App must do the tail read itself (it owns the decision)");
  assert.ok(atBranch > atRead, "isComicZip must run on the parsed model, after the read");
  assert.ok(atComic > atBranch, 'only a detected comic may set the "comic" screen');
});

test("app: a failed tail read toasts and stays in the library", () => {
  const open = bodyOf(app, "onOpenArchive", "App.svelte");
  assert.ok(open.includes("catch"), "an unreadable zip (truncated/zip64/encrypted) must be caught");
  assert.ok(open.includes("toast"), "…and explained in words, not with a freeze or a silent no-op");
});

test("app: a comic resumes from the shelf (clamped), else starts at page 1 with the Settings default", () => {
  const open = bodyOf(app, "onOpenArchive", "App.svelte");
  assert.ok(open.includes("clampResume("), "a remembered page past the end of a re-scanned book must clamp");
  assert.ok(/readingDirection/.test(open), "the global default direction comes from Settings");
});

test("app: Back from the comic lands in the library and the comic state is cleared", () => {
  const back = bodyOf(app, "onComicBack", "App.svelte");
  assert.ok(back.includes('"library"'), "Back from the comic → library");
  assert.ok(back.includes("resetComic"), "the comic state must not leak into the next screen");
});

test("app: signing out clears the comic", () => {
  const appSrc = app;
  const resets = appSrc.split("resetComic(").length - 1;
  assert.ok(resets >= 2, "resetComic is called on Back AND on sign-out (like the archive)");
});

test("app: the template renders the comic screen", () => {
  assert.ok(/screen === "comic"/.test(app), "the template must have a comic block");
});

/* ---------------- the progress store ---------------- */

test("store/comic: session state + reset", () => {
  assert.ok(/export const comic = writable/.test(store), "the session state is a module store (survives screen swaps)");
  assert.ok(/export function resetComic/.test(store));
});

test("store/comic: the shelf persists via the platform store and decodes honestly", () => {
  assert.ok(/"putplay\.comic[^"]*"/.test(store), "a comic-scoped key in the persistent store");
  assert.ok(/store\.get</.test(store) && /store\.set\(/.test(store), "the appData/localStorage bridge (Settings' bridge)");
  assert.ok(store.includes("decodeProgress("), "corrupt stored progress is null, never a throw");
  assert.ok(/export (async )?function upsertProgress/.test(store), "one upsert entry point (page/direction/updated_at)");
});

/* ---------------- the reading screen ---------------- */

test("comic screen: turning uses the direction-aware, no-wrap stepper", () => {
  assert.ok(screen.includes("stepPage("), "←/→ must go through stepPage (manga-aware, honest stops)");
});

test("comic screen: OK cycles the relative zoom ladder", () => {
  assert.ok(screen.includes("cycleZoom("), "OK must cycle fit → 2x → 4x");
  assert.ok(screen.includes("zoomScale("), "the scale is the page's OWN fit, multiplied");
});

test("comic screen: panning is clamped to the image", () => {
  assert.ok(screen.includes("panBounds("), "a zoomed page must never reveal the wall behind it");
});

test("comic screen: Up flips the direction and the flip is remembered per comic", () => {
  const onUp = bodyOf(screen, "flipDirection", "Comic.svelte");
  assert.ok(/rtl/.test(onUp) && /ltr/.test(onUp), "the flip exchanges ltr and rtl");
  assert.ok(onUp.includes("upsertProgress("), "the choice persists for THIS comic (not the global default)");
});

test("comic screen: the next page is prefetched while the current one displays", () => {
  const pre = bodyOf(screen, "prefetch", "Comic.svelte");
  assert.ok(pre.includes("stepPage("), "prefetch must know the direction to fetch the RIGHT next page");
  assert.ok(pre.includes("pageData("), "prefetch is a real extraction, not a lie");
  assert.ok(screen.includes("extractEntry("), "…and the extraction is the range-read + inflate path");
});

test("comic screen: a page that fails to load is an honest error, and the next key moves on", () => {
  assert.ok(screen.includes('"error"'), "a corrupt page shows its error state (D8)");
  const onImgErr = bodyOf(screen, "onImgError", "Comic.svelte");
  assert.ok(onImgErr.includes('"error"'), "the <img> error event lands in the error state");
});

test("comic screen: blob URLs are revoked (the memory honesty)", () => {
  assert.ok(screen.includes("revokeObjectURL"), "extracted pages are blobs; dead blobs are revoked");
});

test("comic screen: the progress bar is direction-aware and the caption counts pages", () => {
  assert.ok(/progress/i.test(screen), "a reader shows where you are in the book");
  assert.ok(/of |\/\s*\{/.test(screen), "the caption says n of m");
});

test("comic screen: Back leaves (the position is already saved)", () => {
  assert.ok(screen.includes('dispatch("back")') || screen.includes('dispatch("back"'), "Back exits; no confirm prompt (D10)");
});

test("comic screen: the session hydrates from the comic store (App made the decision)", () => {
  // get-on-mount idiom: a `let session = $comic` is NOT reactive (the store
  // updates the $-binding, not the plain variable) and Svelte compiles
  // statements that depend on a never-reassigned local into one-shot init —
  // the caption froze at "1 of 13" while the shelf kept advancing.
  assert.ok(
    /get\(comic\)/.test(screen) && !/let session = \$comic/.test(screen),
    "session state is read from get(comic) once, then kept as local state"
  );
});

/* ---------------- settings + library entry ---------------- */

test("settings: the global reading direction (ships LTR)", () => {
  assert.ok(settings.includes("readingDirection"), "Settings carries the default direction");
  assert.ok(/rtl/i.test(settings), "…and offers RTL (manga)");
  assert.ok(settings.includes("saveConfig"), "…and persists it like every other setting");
});

test("library: .cbz opens like .zip (a CBZ IS a zip)", () => {
  const open = bodyOf(lib, "onOpenFile", "Library.svelte");
  assert.ok(/\.cbz/i.test(open), "a .cbz file must reach the open-archive branch");
  const atCbz = open.search(/\.cbz/i);
  const atToast = open.indexOf("coming soon");
  assert.ok(atCbz >= 0 && atToast > atCbz, ".cbz is offered NOW — 'coming soon' is for rar/7z only");
});

/* ---------------- phase 4: shelf + glyph + honest CBR refusal ---------- */

const tile = read("src/ui/components/ItemTile.svelte");

test("library: a CBZ tile wears the book glyph (not the clip)", () => {
  assert.ok(/\\.cbz\$/i.test(tile) && /📖/.test(tile), "ItemTile renders 📖 for .cbz names");
  const atBook = tile.search(/📖/);
  const atClip = tile.search(/🗜/);
  assert.ok(atBook >= 0 && atClip > atBook, "the book branch comes BEFORE the generic archive clip");
});

test("library: a CBR (RAR comic) gets an honest refusal, not a crash or a silent no-op", () => {
  const open = bodyOf(lib, "onOpenFile", "Library.svelte");
  assert.ok(/cbr/i.test(open), "a .cbr name is matched");
  const atCbr = open.search(/cbr/i);
  const atArchiveBranch = open.search(/open-archive/);
  assert.ok(
    atCbr >= 0 && atCbr < atArchiveBranch,
    ".cbr is refused BEFORE it can reach the open-archive branch"
  );
  assert.ok(/CBZ only|CBZ-only|only CBZ/i.test(open), "the refusal says what IS supported");
});

test("library: the continue-reading shelf lists saved positions and reopens them", () => {
  assert.ok(/shelf/.test(lib), "Library reads the comic shelf store");
  assert.ok(/Continue reading/i.test(lib), "the shelf has a real name (not 'recent', not an eyebrow)");
  const shelfBlock = lib.slice(lib.search(/Continue reading/i), lib.search(/Continue reading/i) + 800);
  assert.ok(
    /\{\s*\w+\.?\w*\s*\+\s*1\s*\} of \{\s*\w+\.?\w*\s*\}/.test(shelfBlock),
    "a row shows its position (N of M)"
  );
  // tapping a shelf row opens that comic (resume) — the row needs no live
  // PutFile: the reader only uses id + name
  assert.ok(
    /open-archive/.test(lib.slice(lib.search(/shelf/), lib.search(/shelf/) + 3000)),
    "a shelf tap dispatches open-archive with the stored id + name"
  );
});

test("library: the shelf only shows at the root (a subfolder lists that folder)", () => {
  const idx = lib.search(/Continue reading/i);
  const guard = lib.slice(Math.max(0, idx - 600), idx);
  assert.ok(
    /folderId === null|atRoot|isRoot/.test(guard),
    "the shelf section is guarded to the library root"
  );
});
