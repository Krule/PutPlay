// Comic reader — the pure decision core (comic.ts + comic-progress.ts).
//
// A comic on the TV is a ZIP/CBZ of page images. The reader must:
//   1. order pages the way a human reads them — case-insensitive NATURAL
//      sort (2 before 10; COVER before "page 01 of 40"), folder-first;
//   2. detect comics by content (>= 2 decodable images), not by name —
//      ComicInfo.xml and any other non-image is simply not a page;
//   3. turn pages direction-aware (manga reads right-to-left) with an
//      honest stop at either end;
//   4. zoom in RELATIVE steps (fit -> 2x -> 4x) so a 675-px web scan and a
//      2138-px HQ scan behave identically, with pan clamped to the image;
//   5. remember progress per comic (encode/decode must never throw on
//      corrupt storage — a reader that crashes on a bad JSON string is
//      a reader that can't be trusted with the user's library).
//
// Fixtures: test/fixtures/ (byte-stable; `python3 test/fixtures/make-zips.py`):
//   comic-manga-style.zip   flat, zero-padded pNNN, long names, one spread
//   comic-western-style.zip subfolder, COVER + "page NN of N", ComicInfo.xml
//   comic-natural.zip       the 1..12 lexicographic trap
//   comic-undecodable.zip   junk bytes under a decodable name (D8)
//
// Run: npm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const fix = (p) => new Uint8Array(readFileSync(join(here, "fixtures", p)));

const dir = mkdtempSync(join(tmpdir(), "comiccore-"));
await build({
  entryPoints: [join(here, "..", "src/putio/comic.ts")],
  bundle: true,
  format: "cjs",
  target: "es2019",
  outfile: join(dir, "comic.cjs"),
});
await build({
  entryPoints: [join(here, "..", "src/putio/comic-progress.ts")],
  bundle: true,
  format: "cjs",
  target: "es2019",
  outfile: join(dir, "progress.cjs"),
});
await build({
  entryPoints: [join(here, "..", "src/putio/zip.ts")],
  bundle: true,
  format: "cjs",
  target: "es2019",
  outfile: join(dir, "zip.cjs"),
});
const req = createRequire(import.meta.url);
const comic = req(join(dir, "comic.cjs"));
const progress = req(join(dir, "progress.cjs"));
const zip = req(join(dir, "zip.cjs"));

// A synthetic ZipEntry with the exact shape of zip.ts (tests that build
// models from in-memory entries, not fixture bytes).
const E = (name, size = 100, isDir = false) => ({
  name,
  isDir,
  method: 8,
  size,
  compressedSize: size,
  crc32: 0,
  offset: 0,
  flags: 0,
  encrypted: false,
});

const loadModel = (file) => {
  // parse the fixture with the SHIPPED parser, then build the comic model —
  // the two layers must agree on real bytes.
  return comic.buildComicModel(zip.parseZip(fix(file)).entries);
};

/* ---------------- naturalCompare ---------------- */

test("naturalCompare: digits compare as numbers (2 before 10)", () => {
  assert.ok(comic.naturalCompare("p2.png", "p10.png") < 0);
  assert.ok(comic.naturalCompare("p10.png", "p2.png") > 0);
});

test("naturalCompare: case-insensitive, embedded numbers", () => {
  assert.ok(comic.naturalCompare("PAGE 02 OF 40.JPG", "page 10 of 40.jpg") < 0);
  assert.equal(comic.naturalCompare("Cover.JPG", "cover.jpg"), 0);
});

test("naturalCompare: the reference-file orderings hold", () => {
  // Preacher: COVER before the paged run
  assert.ok(comic.naturalCompare("Cover.JPG", "page 01 of 40.jpg") < 0);
  // Mushoku: p001 < p002-003 (spread) < p004
  assert.ok(comic.naturalCompare("p001", "p002-003") < 0);
  assert.ok(comic.naturalCompare("p002-003", "p004") < 0);
});

test("naturalCompare: a token prefix sorts first (p2 before p2a)", () => {
  assert.ok(comic.naturalCompare("p2.png", "p2a.png") < 0);
});

/* ---------------- buildComicModel ---------------- */

test("buildComicModel: the manga-style fixture reads p000..p010 in order", () => {
  const m = loadModel("comic-manga-style.zip");
  assert.equal(m.pages.length, 10);
  const bases = m.pages.map((p) => p.base);
  assert.deepEqual(bases, [
    "Tensei - v01 - p000 [Cover] [danke] {HQ}.png",
    "Tensei - v01 - p001 [danke] {HQ}.png",
    "Tensei - v01 - p002-003 [danke] {HQ}.png",
    "Tensei - v01 - p004 [danke] {HQ}.png",
    "Tensei - v01 - p005 [danke] {HQ}.png",
    "Tensei - v01 - p006 [danke] {HQ}.png",
    "Tensei - v01 - p007 [danke] {HQ}.png",
    "Tensei - v01 - p008 [danke] {HQ}.png",
    "Tensei - v01 - p009 [danke] {HQ}.png",
    "Tensei - v01 - p010 [Cover] [danke] {HQ}.png",
  ]);
  assert.equal(m.pages[0].folder, "", "manga-style is flat");
  assert.ok(m.pages[0].size > 0, "pages carry their real size");
});

test("buildComicModel: the western-style fixture — COVER first, subfolder, XML excluded", () => {
  const m = loadModel("comic-western-style.zip");
  assert.equal(m.pages.length, 12, "12 images; ComicInfo.xml is not a page");
  assert.equal(m.pages[0].base, "Preacher - Issue 01 - COVER.png");
  assert.equal(m.pages[1].base, "Preacher - Issue 01 - page 01 of 11.png");
  assert.equal(m.pages[11].base, "Preacher - Issue 01 - page 11 of 11.png");
  assert.ok(m.pages.every((p) => p.folder === "Preacher - Issue 01/"), "recursive collection");
});

test("buildComicModel: the 1..12 trap reads 1,2,...,12 (not lexicographic)", () => {
  const m = loadModel("comic-natural.zip");
  assert.deepEqual(m.pages.map((p) => p.base),
    ["1.png", "2.png", "3.png", "4.png", "5.png", "6.png", "7.png",
     "8.png", "9.png", "10.png", "11.png", "12.png"]);
});

test("buildComicModel: a corrupt page stays in the model (D8: the error is the screen's job)", () => {
  const m = loadModel("comic-undecodable.zip");
  assert.equal(m.pages.length, 3, "2.png is a decodable NAME; its junk bytes are a load failure, not a model failure");
  assert.equal(m.pages[1].base, "2.png");
});

test("buildComicModel: HEIC and non-images never become pages", () => {
  const m = comic.buildComicModel([
    E("a.png"), E("b.heic"), E("c.heif"), E("d.txt"), E("e.svg"),
    E("sub/", 0, true), E("sub/f.jpg"),
  ]);
  assert.deepEqual(m.pages.map((p) => p.base), ["a.png", "f.jpg"]);
});

test("buildComicModel: folder-first (root before subfolders — a root cover reads first), then natural within", () => {
  const m = comic.buildComicModel([
    E("b/1.png"), E("a/10.png"), E("a/2.png"), E("z.png"),
  ]);
  assert.deepEqual(m.pages.map((p) => p.path), ["z.png", "a/2.png", "a/10.png", "b/1.png"]);
});

test("buildComicModel: empty entries → zero pages", () => {
  assert.equal(comic.buildComicModel([]).pages.length, 0);
});

/* ---------------- isComicZip ---------------- */

test("isComicZip: needs at least two decodable images", () => {
  assert.equal(comic.isComicZip([E("a.txt")]), false);
  assert.equal(comic.isComicZip([E("a.png")]), false, "one image is a picture, not a comic");
  assert.equal(comic.isComicZip([E("a.png"), E("b.jpg")]), true);
});

test("isComicZip: non-image clutter does not break detection", () => {
  assert.equal(
    comic.isComicZip([E("a.png"), E("b.jpg"), E("ComicInfo.xml"), E("sub/", 0, true)]),
    true);
});

/* ---------------- stepPage (direction-aware, no wrap) ---------------- */

test("stepPage: LTR — right turns forward, left turns back", () => {
  assert.equal(comic.stepPage(1, 5, "right", "ltr"), 2);
  assert.equal(comic.stepPage(1, 5, "left", "ltr"), 0);
});

test("stepPage: honest stops at both ends (no wrap, LTR)", () => {
  assert.equal(comic.stepPage(0, 5, "left", "ltr"), null);
  assert.equal(comic.stepPage(4, 5, "right", "ltr"), null);
});

test("stepPage: RTL — left turns forward, right turns back (manga)", () => {
  assert.equal(comic.stepPage(1, 5, "left", "rtl"), 2);
  assert.equal(comic.stepPage(1, 5, "right", "rtl"), 0);
  assert.equal(comic.stepPage(0, 5, "right", "rtl"), null, "the LTR start is the RTL end");
  assert.equal(comic.stepPage(4, 5, "left", "rtl"), null);
});

test("stepPage: an empty book goes nowhere", () => {
  assert.equal(comic.stepPage(0, 0, "right", "ltr"), null);
  assert.equal(comic.stepPage(0, 0, "left", "rtl"), null);
});

/* ---------------- zoom (relative ladder + pan bounds) ---------------- */

test("cycleZoom: fit → 2x → 4x → fit", () => {
  assert.equal(comic.cycleZoom("fit"), "2x");
  assert.equal(comic.cycleZoom("2x"), "4x");
  assert.equal(comic.cycleZoom("4x"), "fit");
});

test("zoomScale: fit is contain (min of the two axes)", () => {
  // Mushoku page 2138×3056 on 1920×1080
  assert.ok(Math.abs(comic.zoomScale("fit", 2138, 3056, 1920, 1080) - 1080 / 3056) < 1e-9);
  // Preacher page 675×1040 — fit UPSCALES (the screen is bigger than the scan)
  assert.ok(Math.abs(comic.zoomScale("fit", 675, 1040, 1920, 1080) - 1080 / 1040) < 1e-9);
});

test("zoomScale: 2x and 4x are exact multiples of the page's own fit", () => {
  const fit = comic.zoomScale("fit", 2138, 3056, 1920, 1080);
  assert.ok(Math.abs(comic.zoomScale("2x", 2138, 3056, 1920, 1080) - fit * 2) < 1e-9);
  assert.ok(Math.abs(comic.zoomScale("4x", 2138, 3056, 1920, 1080) - fit * 4) < 1e-9);
});

test("panBounds: no pan when the image fits the view", () => {
  assert.deepEqual(comic.panBounds(100, 50, 1920, 1080, 0.5), { maxX: 0, maxY: 0 });
});

test("panBounds: clamped to the image at every zoom level (center-anchored: symmetric half-range)", () => {
  // The sheet starts CENTERED: left = (viewW - wPx)/2 + panX, so the pan
  // range is symmetric — ±half of the overflow. (The old edge-anchored
  // full-range model pushed a contained sheet to the screen's right edge:
  // the C1 screenshot showed a Preacher page hugging the right bezel.)
  const b = comic.panBounds(2138, 3056, 1920, 1080, 1.5);
  assert.ok(Math.abs(b.maxX - (2138 * 1.5 - 1920) / 2) < 1e-6, "max pan = half the horizontal overflow");
  assert.ok(Math.abs(b.maxY - (3056 * 1.5 - 1080) / 2) < 1e-6, "both axes overflow at 1.5x");
});

test("panBounds: a tall, width-limited page at 2x pans vertically, not horizontally", () => {
  // 800×3000: fit = 1080/3000 = 0.36 → displayed 288×1080; 2x → 576×2160.
  const b = comic.panBounds(800, 3000, 1920, 1080, comic.zoomScale("2x", 800, 3000, 1920, 1080));
  assert.equal(b.maxX, 0);
  assert.ok(b.maxY > 0);
});

test("panBounds: a low-res page whose fit upscales pans both axes at 4x", () => {
  // 675×1040: fit upscaling (1080/1040) makes the displayed 701×1080; at 4x
  // it is 2804×4320 — past the view on both axes.
  const b = comic.panBounds(675, 1040, 1920, 1080, comic.zoomScale("4x", 675, 1040, 1920, 1080));
  assert.ok(b.maxX > 0);
  assert.ok(b.maxY > 0);
});

test("panBounds: at the fit scale, a contained image never pans", () => {
  for (const [w, h] of [[2138, 3056], [675, 1040], [4290, 3056], [100, 8000]]) {
    const fit = comic.zoomScale("fit", w, h, 1920, 1080);
    assert.deepEqual(comic.panBounds(w, h, 1920, 1080, fit), { maxX: 0, maxY: 0 }, `fit of ${w}×${h}`);
  }
});

/* ---------------- progress (per-comic position + direction) ---------------- */

const P = { file_id: 16, name: "story.cbz", page: 7, total: 13, direction: "rtl", updated_at: 1700000000000 };

test("progress: encode/decode round-trip", () => {
  const decoded = progress.decodeProgress(progress.encodeProgress(P));
  assert.deepEqual(decoded, P);
});

test("progress: decode is honest about garbage — null, never a throw", () => {
  for (const bad of [null, undefined, "", "not json", "{}", "[1,2]",
    JSON.stringify({ ...P, direction: "sideways" }),
    JSON.stringify({ ...P, page: -1 }),
    JSON.stringify({ ...P, page: P.total }),       // page is 0-based: total is out of range
    JSON.stringify({ ...P, file_id: "sixteen" }),
    JSON.stringify({ ...P, total: 0 })]) {
    assert.equal(progress.decodeProgress(bad), null, String(JSON.stringify(bad) ?? bad).slice(0, 60));
  }
});

test("progress: clampResume — a remembered page survives a shorter book", () => {
  assert.equal(progress.clampResume(5, 10), 5);
  assert.equal(progress.clampResume(25, 10), 9, "the book shrank: the last page is the honest answer");
  assert.equal(progress.clampResume(-3, 10), 0);
  assert.equal(progress.clampResume(0, 0), 0, "an empty book has no page, and that is fine");
});

/* ---------------- sheets (spread mode, v1.1 TV feedback 2026-10-13) ------------
 * A 675px portrait page fit to 16:9 is a sliver in a black sea — the user
 * reads a comic in TWO-PAGE SHEETS: the cover (first page) alone, then
 * consecutive uniform pages side by side, and any WIDE page (a pre-scanned
 * spread, or one of the occasional odd-shaped pages) alone. Width is
 * decided by UNCOMPRESSED SIZE against the book's median — no per-page
 * dimension fetches at open, and the real data says it works:
 *   Preacher #01: 41 uniform pages -> 0 wide  -> 1 + 20 pair-sheets
 *   Mushoku v01 : 178 pages        -> 4 wide  -> exactly the named spreads
 */
function realSizes(fixture, totalBytes) {
  const tail = new Uint8Array(readFileSync(join(here, "fixtures", fixture)));
  const m = zip.parseZip(tail, totalBytes - tail.length);
  return m.entries
    .filter((e) => !e.name.endsWith("/") && /\.(jpg|jpeg|png)$/i.test(e.name))
    .map((e) => e.size);
}

const PREACHER = realSizes("preacher01-tail.bin", 6148002);
const S = (...pages) => ({ pages });
const MUSHOKU = realSizes("mushoku01-tail.bin", 350896678);

test("sheets: a uniform western comic (Preacher shape) is cover + pairs", () => {
  assert.equal(PREACHER.length, 41, "the real book has 41 pages");
  const sheets = comic.buildSheets(PREACHER.length, PREACHER);
  assert.equal(sheets.length, 21, "1 cover sheet + 20 pair sheets");
  assert.deepEqual(sheets[0], S(0), "the cover (first page) is always alone");
  assert.deepEqual(sheets[1], S(1, 2));
  assert.deepEqual(sheets[20], S(39, 40));
  const flat = sheets.flatMap((s) => s.pages);
  assert.deepEqual(flat, PREACHER.map((_, i) => i), "every page lands in exactly one sheet, in order");
});

test("sheets: Mushoku's real sizes isolate exactly the 4 scanned spreads", () => {
  const tail = new Uint8Array(readFileSync(join(here, "fixtures", "mushoku01-tail.bin")));
  const m = zip.parseZip(tail, 350896678 - tail.length);
  const img = m.entries.filter((e) => !e.name.endsWith("/") && /\.(jpg|jpeg|png)$/i.test(e.name));
  // The scan's own naming marks a spread as pNNN-MMM (two page numbers):
  // the size heuristic must find exactly those, and nothing else.
  const namedWide = [];
  img.forEach((e, i) => {
    if (/p\d{3}-\d{3}/.test(e.name)) namedWide.push(i);
  });
  assert.equal(namedWide.length, 4, "the book has 4 named spreads");

  const sheets = comic.buildSheets(MUSHOKU.length, MUSHOKU);
  const solo = sheets.filter((s) => s.pages.length === 1).map((s) => s.pages[0]);

  // The hard invariants — the user's rule: spreads alone, never paired.
  assert.ok(namedWide.every((i) => solo.includes(i)), "every scanned spread is a solo sheet");
  assert.ok(solo.includes(0), "the cover is alone");
  assert.ok(
    sheets.every((s) => s.pages.length === 1 || !s.pages.some((p) => namedWide.includes(p))),
    "no sheet ever contains a wide page with a neighbour"
  );
  // …and the solos are structurally bounded: cover + spreads + a page that
  // happens to sit directly before a spread (its partner IS the spread).
  const allowedSolo = new Set([0, ...namedWide]);
  namedWide.forEach((w) => allowedSolo.add(w - 1));
  assert.ok(solo.every((i) => allowedSolo.has(i)), `solos are only the allowed ones (${solo})`);
  assert.deepEqual(
    sheets.flatMap((s) => s.pages),
    MUSHOKU.map((_, i) => i),
    "every page lands in exactly one sheet, in order"
  );
});

test("sheets: a wide page after the cover stands alone; the pages around it pair", () => {
  const n = 1000;
  const sizes = [n, n, 10 * n, n, n, 10 * n, n, n];
  assert.deepEqual(comic.buildSheets(8, sizes), [S(0), S(1), S(2), S(3, 4), S(5), S(6, 7)]);
});

test("sheets: a normal page sitting next to a wide one is alone (never paired with a spread)", () => {
  const n = 1000;
  assert.deepEqual(comic.buildSheets(5, [n, n, 10 * n, n, n]), [S(0), S(1), S(2), S(3, 4)]);
});

test("sheets: counts — 1, 2, 3, and an odd tail", () => {
  assert.deepEqual(comic.buildSheets(1, [1]), [S(0)]);
  assert.deepEqual(comic.buildSheets(2, [1, 1]), [S(0), S(1)]);
  assert.deepEqual(comic.buildSheets(3, [1, 1, 1]), [S(0), S(1, 2)]);
  assert.deepEqual(comic.buildSheets(5, [1, 1, 1, 1, 1]), [S(0), S(1, 2), S(3, 4)]);
});

test("sheets: uniformity is relative — all-equal is a normal book, and one big page is the odd one out", () => {
  const n = 1000;
  assert.deepEqual(comic.buildSheets(4, [n, n, n, n]), [S(0), S(1, 2), S(3)], "all-equal: ordinary pairing");
  assert.deepEqual(comic.buildSheets(4, [n, n, 10 * n, n]), [S(0), S(1), S(2), S(3)], "the big page and its neighbour stand alone");
});

test("sheetForPage: a page maps to its sheet (either member of a pair finds it)", () => {
  const sheets = comic.buildSheets(5, [1, 1, 1, 1, 1]);
  assert.equal(comic.sheetForPage(sheets, 0), 0);
  assert.equal(comic.sheetForPage(sheets, 1), 1);
  assert.equal(comic.sheetForPage(sheets, 2), 1, "the second member of a pair is the same sheet");
  assert.equal(comic.sheetForPage(sheets, 4), 2);
});

test("sheetPageLabel: solo is a number, a pair is a 1-based en-dash range", () => {
  const sheets = comic.buildSheets(6, [1, 1, 1, 1, 1, 1]);
  assert.equal(comic.sheetPageLabel(sheets[0], 6), "1");
  assert.equal(comic.sheetPageLabel(sheets[1], 6), "2\u20133");
  assert.equal(comic.sheetPageLabel(sheets[2], 6), "4\u20135");
});
