/**
 * The row router for the raw-ASS subtitle upgrade.
 *
 * One container track, one decision (docs/raw-ass-upgrade.md §3):
 *   row 1 — the Cues index is fully valid → the Cues-driven batcher
 *           (ass-demux.ts) reassembles the track byte-exact up front;
 *   row 2 — the cluster offsets are valid (the in-cluster rels are not)
 *           and the file is ≤ 2 GiB → the cluster plan (ass-row2.ts) for
 *           the player's playhead-paced lazy scheduler;
 *   row 3 — everything else → nothing: the put.io conversion (SRT + the
 *           probed style table) is the final state.
 *
 * This module is pure (ranged reader in, decision out) — the DOM-bound
 * glue lives in MediaEngine.probeRawAss (media.ts) and the Player.
 */
import { validateCues, type CueEntry } from "./cues";
import { demuxAssRow1 } from "./ass-demux";
import { planRow2Clusters, type Row2Cluster } from "./ass-row2";

/** The routed outcome for one embedded track. */
export interface RawAssRoute {
  row: 1 | 2 | 3;
  trackNum: number;
  /** row 1: the reassembled .ass (FFmpeg-oracle byte-exact) */
  ass?: string;
  /** row 1: the demuxed cue count */
  cues?: number;
  /** row 2: the playhead-paced cluster plan */
  plan?: Row2Cluster[];
  /** rows 1–2: the track's CodecPrivate (the .ass header — style table +
   *  the assembleAss head for row 2's partial windows) */
  codecPrivate?: Uint8Array;
  /** rows 1–2: the segment's TimestampScale (ns per time unit) */
  scale?: number;
}

export interface RouteArgs {
  /** ranged reader (inclusive end) */
  read: (start: number, end: number) => Promise<Uint8Array>;
  /** segment payload start (the base of the +segStart rule) */
  segStart: number;
  /** TimestampScale (ns per time unit) */
  scale: number;
  /** file offset of the Cues element ID (the probe's SeekHead result) */
  cuesFileOffset: number;
  /** full file size — row 2's 2 GiB cap */
  fileSize: number;
  /** the parsed Cues (all tracks; the route filters to trackNum) */
  cues: CueEntry[];
  /** the container track number to route */
  trackNum: number;
  /** the track's CodecPrivate (the .ass header) */
  codecPrivate: Uint8Array;
}

/**
 * Validate the track's Cues with sampled tiny reads, then take the
 * matching row: row 1 demuxes up front; row 2 plans the cluster fetches;
 * row 3 is the no-op.
 */
export async function routeRawAss(a: RouteArgs): Promise<RawAssRoute> {
  const v = await validateCues({
    read: a.read,
    segStart: a.segStart,
    scale: a.scale,
    cuesFileOffset: a.cuesFileOffset,
    cues: a.cues,
    trackNum: a.trackNum,
    fileSize: a.fileSize,
  });

  if (v.row === 1) {
    const r = await demuxAssRow1({
      read: a.read,
      segStart: a.segStart,
      scale: a.scale,
      cues: a.cues,
      trackNum: a.trackNum,
      codecPrivate: a.codecPrivate,
    });
    return {
      row: 1,
      trackNum: a.trackNum,
      ass: new TextDecoder("utf-8").decode(r.ass),
      cues: r.cues,
      codecPrivate: a.codecPrivate,
      scale: a.scale,
    };
  }

  if (v.row === 2) {
    const plan = await planRow2Clusters(a.read, a.segStart, a.scale, a.cues, a.trackNum);
    return {
      row: 2,
      trackNum: a.trackNum,
      plan,
      codecPrivate: a.codecPrivate,
      scale: a.scale,
    };
  }

  return { row: 3, trackNum: a.trackNum };
}
