/**
 * The contextual skip pill (pure — no DOM/webOS imports, testable in node):
 * the small "Skip intro" offer at the bar's right end (above the track
 * line) the full-screen Player shows
 * when the playhead crosses a known section window (intro / recap / end
 * credits) and the auto-skip switch is OFF.
 *
 * The window logic is SHARED with the engine via segAction (segments.ts) —
 * the same rule the auto-skip path uses; this module only adds the pill's
 * visibility gates and the offer's display shape. The Player owns the rest:
 * it marks the returned index consumed on settle ("settled once") and runs
 * the finish/advance flow for credits (it needs only index + label there).
 */

import { segAction } from "./segments";
import type { Seg, SegType } from "./segments";

/** The player's dock modes (Player.svelte: export let mode). */
export type PillMode = "full" | "mini" | "micro";

export interface PillInput {
  /** The episode's section data (seglookup), or null/undefined when none. */
  segs: Seg[] | null | undefined;
  /** The playhead, seconds. */
  time: number;
  /** The media duration, seconds (0 / Infinity / NaN = live, unknown). */
  duration: number;
  /** Per-segment "settled once" flags (same order as segs). */
  consumed: boolean[];
  /** The Player's mode — the pill is a full-screen-only affordance. */
  mode: PillMode;
  /** The Settings "skip segments" switch (auto-skip). */
  autoSkip: boolean;
  /** True when any menu/panel is open over the video. */
  panelOpen: boolean;
}

export interface Pill {
  /** "Skip intro" / "Skip recap" / "Skip credits". */
  label: string;
  /** The segment index (the Player marks it consumed on settle). */
  index: number;
  /** Where skipping lands: seg.end ?? duration (credits run to the end). */
  target: number;
}

/** The pill's text per section type (introdb.ts's SegType). */
const PILL_LABEL: Record<SegType, string> = {
  intro: "Skip intro",
  recap: "Skip recap",
  credits: "Skip credits",
};

/**
 * The pill to show at the playhead, or null (the pill stays hidden).
 *
 * null when auto-skip is ON (the engine skips on its own), docked
 * (mini/micro), a panel is open, or segAction finds nothing to offer
 * (outside every window, every window consumed, not playing yet, or
 * live / unknown duration — segAction's duration guard answers that).
 */
export function pillState(input: PillInput): Pill | null {
  const { segs, time, duration, consumed, mode, autoSkip, panelOpen } = input;
  if (autoSkip || mode !== "full" || panelOpen) return null;
  // No separate live input: live media has no finite duration, and
  // segAction's duration guard already answers null for it.
  const action = segAction(segs, time, duration, consumed, /* auto */ false, /* live */ false);
  if (!action || action.kind !== "offer" || !segs) return null;
  const seg = segs[action.index];
  return { label: PILL_LABEL[seg.type], index: action.index, target: seg.end ?? duration };
}
