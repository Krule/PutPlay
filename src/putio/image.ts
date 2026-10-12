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
 * Browse a folder's images in listing order (non-images skipped).
 * @param dir -1 = previous, +1 = next.
 * @returns the id to show, or null at either end (no wrap) / when the current
 *          file is not an image in the list (nothing honest to navigate to).
 */
export function nextImageId(
  files: ImageFileEntry[],
  currentId: number,
  dir: -1 | 1
): number | null {
  const ids = files.filter(isImageFile).map((f) => f.id);
  const at = ids.indexOf(currentId);
  if (at === -1) return null;
  const next = ids[at + dir];
  return next === undefined ? null : next;
}
