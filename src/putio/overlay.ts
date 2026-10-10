/**
 * Modal side-click decision (pure geometry — no DOM required, testable in
 * node). BUG 2: clicking the dim area around a modal must dismiss it with no
 * action taken. The click is "outside" iff it lands on the scrim and outside
 * the panel's bounding box (borders count as inside — lenient, so a click
 * on the panel's edge never accidentally dismisses it).
 */

export interface ClickLike {
  clientX: number;
  clientY: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function isOutsideClick(
  click: Pick<ClickLike, "clientX" | "clientY">,
  panel: Rect | null | undefined
): boolean {
  if (!panel || panel.width <= 0 || panel.height <= 0) return true;
  const { clientX, clientY } = click;
  const inside =
    clientX >= panel.left &&
    clientX <= panel.left + panel.width &&
    clientY >= panel.top &&
    clientY <= panel.top + panel.height;
  return !inside;
}

/** Convenience for HTMLElements (browser only). */
export function clickIsOutsideClickTarget(
  e: { clientX: number; clientY: number; target: EventTarget | null; currentTarget: EventTarget | null },
  panelEl: Element | null | undefined
): boolean {
  if (!panelEl) return true;
  // a click that started on the panel (or its children) is never "outside",
  // even if it technically landed on a 1px boundary
  if (panelEl.contains(e.target as Node)) return false;
  const r = panelEl.getBoundingClientRect();
  return isOutsideClick(e, { left: r.left, top: r.top, width: r.width, height: r.height });
}
