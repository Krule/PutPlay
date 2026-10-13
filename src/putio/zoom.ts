/**
 * Zoom + pan math for full-bleed image display (pure).
 *
 * Shared by the comic reader (a sheet of 1–2 pages) and the image viewer
 * (a single image): the ladder, the scale, the symmetric pan bounds, and
 * the D-pad step all behave identically either way, so a 675-px scan and a
 * 2138-px scan — and a single image and a spread — feel the same.
 */

/** The relative zoom ladder: each step doubles the image's OWN fit scale. */
export type ZoomLevel = "fit" | "2x" | "4x";

export function cycleZoom(at: ZoomLevel): ZoomLevel {
  return at === "fit" ? "2x" : at === "2x" ? "4x" : "fit";
}

/**
 * Absolute scale for a level. Fit is plain `contain` — min of the two
 * axes — so a low-res scan is upscaled to fill the screen exactly; 2x/4x
 * multiply THAT fit, which is what makes the ladder feel identical across
 * resolutions.
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
 * How far a zoomed image can be panned in each axis. A contained image
 * (at its fit scale) pans nowhere — pan exists only above fit. The
 * epsilon absorbs float drift so "exactly fills the view" is 0, not 1e-13.
 */
export function panBounds(
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
  scale: number,
): { maxX: number; maxY: number } {
  // CENTER-anchored: the image renders at (view - px)/2 + pan, so the pan
  // range is symmetric — ±half of the overflow. (Edge-anchoring pushed a
  // contained image to the right bezel: the C1's Preacher screenshot.)
  return {
    maxX: Math.max(0, (imgW * scale - viewW) / 2 - 1e-9),
    maxY: Math.max(0, (imgH * scale - viewH) / 2 - 1e-9),
  };
}

/**
 * One D-pad step of zoomed pan, TV convention (C1 feedback 2026-10-13:
 * the drag-style mapping was INVERTED — "up went down, left went right").
 * The arrow names the direction you want to LOOK: Up moves the view toward
 * the TOP of the image (the image slides down on screen), Left reveals the
 * left. Pan is in screen coordinates (positive = image shifted down/right),
 * so up/left add, down/right subtract — clamped to the symmetric bounds.
 */
export function nudge(pan: number, max: number, d: "up" | "down" | "left" | "right", step: number): number {
  const delta = d === "up" || d === "left" ? step : -step;
  return Math.min(max, Math.max(-max, pan + delta));
}
