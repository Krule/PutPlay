/**
 * Segment-skip decisions over REAL show data (pure — no DOM/webOS imports,
 * testable in node). The Player (which owns the per-segment offer/auto-skip
 * action), the MediaEngine (which owns the <video> and the fresh start)
 * share ONE tested rule here.
 *
 * The segments themselves (where the intro/recap/credits actually begin and
 * end) come from TheIntroDB, resolved per file by seglookup.ts — this module
 * only decides what to DO with them at a given playhead position:
 *
 *   - fresh start: land past the LEADING block — the segments that begin at
 *     the top of the media (the intro, often followed by the recap). A skip
 *     that would land past the content is dropped.
 *   - crossing: while playing, when the playhead enters a segment's window,
 *     either auto-skip to its end (Settings switch on) or offer the skip
 *     (switch off). End credits (end = null) are special: skipping them
 *     ENDS the episode (the Player runs the finish/advance flow).
 *
 * A resume is never yanked: the engine applies the fresh skip only when
 * there is NO saved position (or the user explicitly chose "start from
 * beginning"). The Player decides which case it is; the engine only seeks.
 */

import type { Seg, SegType } from "./introdb";

export type { Seg, SegType };

/** A fresh skip must leave at least this much content playable (seconds). */
export const MIN_KEEP = 30;

export interface FreshSkip {
  /** Where the fresh start lands (0 = the ordinary start). */
  target: number;
  /** The segments that were skipped ("intro + recap") — "" when none. */
  label: string;
}

/**
 * Where a fresh start puts the playhead: the END of the leading block of
 * segments (those starting at or before the running block edge). 0 = start
 * normally — no data, live / unknown duration, or the skip would land past
 * the content (less than MIN_KEEP left).
 */
export function freshSkip(segs: Seg[] | null | undefined, duration: number, live: boolean): FreshSkip {
  if (live || !duration || !Number.isFinite(duration) || !segs || !segs.length) return { target: 0, label: "" };
  let target = 0;
  const parts: string[] = [];
  for (const seg of segs) {
    if (seg.start > target) break; // sorted — the first gap ends the block
    const end = seg.end === null ? duration : seg.end;
    if (end > target) {
      target = end;
      if (parts.indexOf(seg.type) === -1) parts.push(seg.type);
    }
  }
  if (target <= 0 || duration - target < MIN_KEEP) return { target: 0, label: "" };
  return { target, label: parts.join(" + ") };
}

export type SegAction =
  | { kind: "skip"; index: number; target: number }
  | { kind: "offer"; index: number }
  | { kind: "credits"; index: number };

/**
 * The action for the playhead at t: the FIRST unconsumed segment whose
 * window contains t (start <= t < end; a null end runs to the end of the
 * media) and what to do with it — auto-skip to the end, show the offer,
 * or, for end credits, end the episode. null = nothing to do (outside
 * every window, everything consumed, live, or not playing yet).
 */
export function segAction(
  segs: Seg[] | null | undefined,
  t: number,
  duration: number,
  consumed: boolean[],
  auto: boolean,
  live: boolean
): SegAction | null {
  if (live || !segs || !segs.length) return null;
  if (!duration || !Number.isFinite(duration)) return null;
  if (!t || t <= 0) return null;
  for (let i = 0; i < segs.length; i++) {
    if (consumed[i]) continue;
    const seg = segs[i];
    if (t < seg.start) continue;
    const end = seg.end === null ? duration : seg.end;
    if (t >= end) continue;
    if (auto) {
      return seg.end === null ? { kind: "credits", index: i } : { kind: "skip", index: i, target: end };
    }
    return { kind: "offer", index: i };
  }
  return null;
}
