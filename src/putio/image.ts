import { streamURL, type Auth } from "./api";

/**
 * Image-viewer decisions (pure).
 *
 * The TV's webview (webOS 6 / Chromium 79) decodes a fixed set of raster
 * image formats. The app only OPENS what it can prove it displays — HEIC/HEIF
 * and SVG fall through to the honest "can't display" toast, same as archives.
 */

/** Raster formats Chromium 79 decodes in an <img>. Order = display order. */
export const DISPLAYABLE_IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];

const DECODABLE_EXT_RE = new RegExp(
  "\\." + DISPLAYABLE_IMAGE_EXTS.join("|") + "$",
  "i"
);

/** The put.io fields the decisions read (a subset of PutFile). */
export interface ImageFileEntry {
  id: number;
  name?: string;
  content_type?: string | null;
  is_folder?: number | boolean;
  size?: number;
}

/**
 * Is this put.io entry an image the TV can display?
 * content_type wins when present (`image/*` AND a decodable extension —
 * `image/heic` must stay closed); otherwise the extension decides.
 */
export function isImageFile(f: ImageFileEntry): boolean {
  if (f.is_folder) return false;
  const name = f.name || "";
  const ct = (f.content_type || "").toLowerCase();
  if (ct) {
    return ct.startsWith("image/") && DECODABLE_EXT_RE.test(name);
  }
  return DECODABLE_EXT_RE.test(name);
}



/**
 * One thing the image viewer can show. `load` is what makes the library and
 * the archive viewers share one screen: library targets resolve to the
 * signed stream URL, archive targets extract the entry and resolve to a
 * blob URL. Returning a Promise keeps both on one shape.
 */
export interface ViewerTarget {
  name: string;
  size: number;
  load: () => Promise<string>;
}

/**
 * Browse the viewer's target list (the shared primitive for both contexts).
 * @param dir -1 = previous, +1 = next.
 * @returns the next index, or null at either end (no wrap) / when `at` is
 *          outside the list (nothing honest to navigate to).
 */
export function stepIndex(at: number, count: number, dir: -1 | 1): number | null {
  if (at < 0 || at >= count) return null;
  const next = at + dir;
  return next < 0 || next >= count ? null : next;
}

/**
 * The folder's decodable images as viewer targets, in listing order.
 * (The viewer itself stays agnostic: it only knows targets.)
 */
export function buildLibraryTargets(
  files: ImageFileEntry[],
  auth: Auth
): ViewerTarget[] {
  return files
    .filter(isImageFile)
    .map((f) => ({
      name: f.name || "",
      size: f.size || 0,
      load: () => Promise.resolve(streamURL(auth, f.id)),
    }));
}
