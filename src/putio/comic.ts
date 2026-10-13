/**
 * Comic-reader decisions (pure).
 *
 * A comic on the TV is a ZIP/CBZ of page images. This module owns every
 * decision the reader makes about SEQUENCING and GEOMETRY — it never touches
 * the network (that is zip-extract's job) and never touches the DOM (that is
 * Comic.svelte's job).
 *
 * The two reference files that shaped these rules (see .agents/plan.md §0):
 *   - a 351 MB HQ manga, 2138-px pages, flat, zero-padded `pNNN` names;
 *   - a 6 MB low-res Western issue, 675-px pages, in a subfolder,
 *     `COVER` + `page NN of N` names, with a ComicInfo.xml.
 * Everything here must hold at both ends of that range.
 */
import type { ZipEntry } from "./zip";
import { isDecodableImageName } from "./image";

export type Direction = "ltr" | "rtl";
export type TurnDir = "left" | "right";
export type ZoomLevel = "fit" | "2x" | "4x";

/** One page of the book: where it lives, what it's called, how big it is. */
export interface ComicPage {
  /** Full entry path (unique within the archive). */
  path: string;
  /** Folder path with trailing slash; "" at the root. */
  folder: string;
  /** File name without the folder. */
  base: string;
  /** Uncompressed size in bytes (the caption's `· 1.8 MB`). */
  size: number;
  /** The parsed ZIP entry — the extract layer works from this. */
  entry: ZipEntry;
}

export interface ComicModel {
  /** Pages in reading order. */
  pages: ComicPage[];
}

/**
 * Split a name into the runs a human reads: digits as numbers, everything
 * else as (lowercased) text. `page 02 of 40` → ["page ", 2, " of ", 40].
 */
function tokens(s: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /\d+|[^\d]+/g;
  let m: RegExpExecArray | null;
  const src = s.toLowerCase();
  while ((m = re.exec(src)) !== null) {
    out.push(/^\d+$/.test(m[0]) ? parseInt(m[0], 10) : m[0]);
  }
  return out;
}

/**
 * Case-insensitive natural order: `2` before `10`, `COVER` before
 * `page 01 of 40`, `p001` < `p002-003` < `p004`. Plain string comparison
 * would read a 12-page issue as 1, 10, 11, 12, 2, 3 — a reader that does
 * that has no business near a book.
 */
export function naturalCompare(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return ta.length - tb.length;
}

/** Is this ZIP entry a page the TV can display? (Directories and everything
 *  that is not a decodable raster — XML, text, HEIC — are not pages.) */
export function isImageEntry(e: ZipEntry): boolean {
  return !e.isDir && isDecodableImageName(e.name);
}

/**
 * The book: every decodable image in the archive, in reading order —
 * root-level pages first (a root cover reads before a subfolder), then
 * folder by folder, each folder natural-sorted.
 */
export function buildComicModel(entries: ZipEntry[]): ComicModel {
  const pages: ComicPage[] = entries
    .filter(isImageEntry)
    .map((e) => {
      const slash = e.name.lastIndexOf("/");
      return {
        path: e.name,
        folder: slash < 0 ? "" : e.name.slice(0, slash + 1),
        base: slash < 0 ? e.name : e.name.slice(slash + 1),
        size: e.size,
        entry: e,
      };
    });
  pages.sort(
    (a, b) => naturalCompare(a.folder, b.folder) || naturalCompare(a.base, b.base),
  );
  return { pages };
}

/** A comic is what it reads like: at least two displayable pages. */
export function isComicZip(entries: ZipEntry[]): boolean {
  let n = 0;
  for (const e of entries) if (isImageEntry(e) && ++n >= 2) return true;
  return false;
}

/**
 * Turn the page. `dir` is the physical key; `direction` is the book's
 * reading order — in an RTL book the LEFT key goes forward. No wrap:
 * stepping past either end of the book goes nowhere (the honest stop).
 */
export function stepPage(
  at: number,
  count: number,
  dir: TurnDir,
  direction: Direction,
): number | null {
  if (count <= 0) return null;
  const forward = (direction === "ltr") === (dir === "right");
  const next = forward ? at + 1 : at - 1;
  return next >= 0 && next < count ? next : null;
}

/** The relative zoom ladder: each step doubles the page's own fit scale. */
export function cycleZoom(at: ZoomLevel): ZoomLevel {
  return at === "fit" ? "2x" : at === "2x" ? "4x" : "fit";
}

/**
 * Absolute scale (CSS `transform: scale()`) for a level. Fit is plain
 * `contain` — min of the two axes — so a low-res scan is upscaled to fill
 * the screen exactly like the image viewer does; 2x/4x multiply THAT fit,
 * which is what makes the ladder feel identical on 675-px and 2138-px pages.
 */
export function zoomScale(
  level: ZoomLevel,
  pageW: number,
  pageH: number,
  viewW: number,
  viewH: number,
): number {
  const fit = Math.min(viewW / pageW, viewH / pageH);
  return level === "fit" ? fit : level === "2x" ? fit * 2 : fit * 4;
}

/**
 * How far a zoomed image can be dragged in each axis. A contained image
 * (at its fit scale) pans nowhere — pan exists only above fit. The epsilon
 * absorbs float drift so "exactly fills the view" is 0, not 1e-13.
 */
export function panBounds(
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
  scale: number,
): { maxX: number; maxY: number } {
  // CENTER-anchored: the sheet renders at (view - sheetPx)/2 + pan, so the
  // pan range is symmetric — ±half of the overflow. (Edge-anchoring pushed
  // a contained sheet to the right bezel: the C1's Preacher screenshot.)
  return {
    maxX: Math.max(0, (imgW * scale - viewW) / 2 - 1e-9),
    maxY: Math.max(0, (imgH * scale - viewH) / 2 - 1e-9),
  };
}

/* ---------------- sheets: spread mode (v1.1) ----------------
 *
 * A single portrait page fit to 16:9 is a sliver in a black sea. The
 * reader works in SHEETS: the cover (first page) alone, then consecutive
 * uniform pages side by side (a spread), and any WIDE page — a
 * pre-scanned spread, or one of the occasional odd-shaped pages — alone.
 * "Wide" is decided by uncompressed size against the book's MEDIAN page
 * size (the data already in the central directory): no per-page dimension
 * fetches at open. Real data: Preacher #01 → 0 wide (1 + 20 pairs);
 * Mushoku v01 → exactly 4 wide, all of them the scanned spreads.
 */

export interface Sheet {
  /** Page indices (0-based) in reading order; 1 (cover/odd) or 2 (spread). */
  pages: number[];
}

/** A page is wide when it weighs ≥ 1.6× the book's median page. */
const WIDE_RATIO = 1.6;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function buildSheets(pageCount: number, sizes: number[]): Sheet[] {
  const n = Math.min(pageCount, sizes.length);
  if (n <= 0) return [];
  const wideAt = median(sizes.slice(0, n)) * WIDE_RATIO;
  const isWide = (i: number): boolean => wideAt > 0 && sizes[i] >= wideAt;

  const sheets: Sheet[] = [{ pages: [0] }]; // the cover is always alone
  let i = 1;
  while (i < n) {
    if (isWide(i)) {
      sheets.push({ pages: [i] }); // a spread (or odd-shaped page) stands alone
      i += 1;
    } else if (i + 1 < n && !isWide(i + 1)) {
      sheets.push({ pages: [i, i + 1] }); // a normal spread: two uniform pages
      i += 2;
    } else {
      sheets.push({ pages: [i] }); // a normal page next to a wide one (or the last)
      i += 1;
    }
  }
  return sheets;
}

/** Which sheet shows page `page` (either member of a pair finds it). */
export function sheetForPage(sheets: Sheet[], page: number): number {
  for (let s = 0; s < sheets.length; s++) {
    if (sheets[s].pages.indexOf(page) >= 0) return s;
  }
  return Math.max(0, sheets.length - 1); // out of range: the last sheet, honestly
}

/** "1", "2–3" (1-based; a pair is an en-dash range) — the caption's "of N" is the screen's. */
export function sheetPageLabel(sheet: Sheet, _total: number): string {
  if (sheet.pages.length === 1) return String(sheet.pages[0] + 1);
  return sheet.pages[0] + 1 + "\u2013" + (sheet.pages[1] + 1);
}
