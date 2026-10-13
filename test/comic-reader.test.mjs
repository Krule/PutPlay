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
//   - NO direction in Settings (removed 2026-10-13): the reader's Up-key legend is the control.
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

test("app: a comic resumes from the saved page (clamped), else starts at page 1, LTR (direction lives in the reader now, not Settings)", () => {
  const open = bodyOf(app, "onOpenArchive", "App.svelte");
  assert.ok(open.includes("clampResume("), "a remembered page past the end of a re-scanned book must clamp");
  assert.ok(!/readingDirection/.test(open), "no Settings default — a never-flipped comic is LTR");
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

test("comic screen: the book is read in SHEETS — cover alone, uniform pages paired, wide pages alone", () => {
  assert.ok(screen.includes("buildSheets("), "sheets are built from the model (the pure core decides pairing)");
  assert.ok(screen.includes("sheetForPage("), "a saved PAGE maps back to its sheet on resume");
});

test("comic screen: the sheet is CENTER-anchored (a contained sheet sits in the middle, not the right bezel)", () => {
  // left = (viewW - wPx)/2 + panX, panX symmetric in [-maxX, +maxX]. The old
  // edge-anchored (viewW - wPx) + panX pushed a fit page to the right edge —
  // the C1's Preacher screenshot.
  assert.ok(
    /leftPx\s*=\s*\(viewW\s*-\s*wPx\)\s*\/\s*2\s*\+\s*panX/.test(screen),
    "horizontal position is centered offset + symmetric pan"
  );
  assert.ok(
    /topPx\s*=\s*\(viewH\s*-\s*hPx\)\s*\/\s*2\s*\+\s*panY/.test(screen),
    "…and vertically"
  );
});

test("comic screen: an RTL pair renders the earlier page on the RIGHT (manga order)", () => {
  assert.ok(/class:rtl/.test(screen), "the pair container flips its row in rtl");
  assert.ok(/row-reverse/.test(screen), "…by reversing the row, not by reordering the data");
});

test("comic screen: a persistent legend tells the user Up flips the direction", () => {
  // The user removed the Settings choice — the in-reader legend is the only
  // place the control is discoverable. It must be OUTSIDE the auto-hiding
  // caption block (a legend that disappears is not a legend).
  const legend = screen.match(/class="legend"[\s\S]{0,400}/);
  assert.ok(legend, "a .legend element exists");
  assert.ok(/flip/i.test(screen.slice(screen.search(/class="legend"/), screen.search(/class="legend"/) + 400)), "…and it says the Up key flips");
  assert.ok(!/captionVisible/.test(screen.slice(screen.search(/class="legend"/) - 400, screen.search(/class="legend"/))), "the legend is not gated by the caption's auto-hide");
});

test("comic screen: the caption labels a pair as a range (2–3 of 13)", () => {
  assert.ok(screen.includes("sheetPageLabel("), "the caption goes through the pure labeler");
});

test("comic screen: turning steps SHEETS (direction decides which arrow is forward)", () => {
  const stepFn = bodyOf(screen, "step", "Comic.svelte");
  assert.ok(/sheetIdx/.test(stepFn), "navigation moves sheet to sheet");
  assert.ok(/dir/.test(stepFn) && /(right|left)/.test(stepFn), "the arrow-to-forward mapping is direction-aware");
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
  assert.ok(
    onUp.includes("saveProgress(") && screen.includes("upsertProgress("),
    "the choice persists for THIS comic via the single upsert entry point"
  );
});

test("comic screen: the next SHEET is prefetched while the current one displays", () => {
  const pre = bodyOf(screen, "prefetch", "Comic.svelte");
  assert.ok(/sheet/.test(pre), "prefetch follows the sheet (its 1–2 pages), direction-aware");
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

test("settings: NO reading direction (user removed it — the Up-key legend in the reader is the control)", () => {
  assert.ok(!/readingDirection/.test(settings), "the direction card is gone from Settings");
  assert.ok(!/rtl/i.test(settings), "…and so is any RTL choice surface");
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

test("library: NO continue-reading shelf (user removed it 2026-10-13 — it belongs on a future Home screen, alongside video continue, not in the file grid)", () => {
  assert.ok(
    !/Continue reading/i.test(lib),
    "the shelf section must be gone from the library"
  );
  assert.ok(
    !/shelf-row|shelfRows/.test(lib),
    "…and so must its rows, state, and wiring"
  );
});

test("app: the position store is still loaded (reopening a comic resumes from the saved page — the shelf UI is gone, the memory is not)", () => {
  assert.ok(
    /loadShelf\(\)/.test(app),
    "progress loads on boot so progressFor can resume a comic"
  );
});
