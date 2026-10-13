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
  return {
    maxX: Math.max(0, imgW * scale - viewW - 1e-9),
    maxY: Math.max(0, imgH * scale - viewH - 1e-9),
  };
}
