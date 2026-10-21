// Row 2 (docs/raw-ass-upgrade.md §3): the Cues' cluster offsets are
// validated but their in-cluster rels are not (and the file is ≤ 2 GiB).
//
// The cluster offsets tell us exactly which clusters hold the target
// track, so the plan is built up front (one 12 B header read per unique
// cluster) and each cluster is then fetched lazily, whole, when the
// playhead comes within the lookahead of the cluster's earliest cue. The
// cluster is walked locally for the target track's blocks (the A/V bytes
// are read and discarded with it) and the parsed cues merge into the
// growing cue set. Put.io's SRT + style table keep rendering underneath;
// this is the fidelity upgrade, paid only for the time actually watched.

import { BoundedReader, MATROSKA, vintLenAt, vintValue } from "./probe";
import type { CueEntry } from "./cues";
import { collectClusterEvents, tsToMs, type AssEvent } from "./ass-demux";

/** One sub-bearing cluster, ready for the scheduler. */
export interface Row2Cluster {
  /** segment-relative CueClusterPosition */
  ccp: number;
  /** file offset of the cluster element's ID */
  offset: number;
  /** cluster payload size (the size vint) */
  size: number;
  /** file offset of the cluster payload (ID + size vint skipped) */
  payloadStart: number;
  /** earliest cue time in this cluster, ms */
  windowStart: number;
}

/**
 * Build the cluster plan from validated Cues: one entry per unique cluster
 * holding a cue of the target track (other tracks are pruned), sorted by
 * the earliest cue. Each entry costs one 12 B read (cluster ID + size
 * vint); the cluster's payload is never read here.
 */
export async function planRow2Clusters(
  read: (start: number, end: number) => Promise<Uint8Array>,
  segStart: number,
  scale: number,
  cues: CueEntry[],
  trackNum: number
): Promise<Row2Cluster[]> {
  const windowByCcp = new Map<number, number>(); // ccp → earliest cue time (scale units)
  for (const c of cues) {
    if (c.track !== trackNum) continue;
    const prev = windowByCcp.get(c.ccp);
    if (prev === undefined || c.t < prev) windowByCcp.set(c.ccp, c.t);
  }
  const cid = MATROSKA.CLUSTER;
  const out: Row2Cluster[] = [];
  for (const [ccp, t] of windowByCcp) {
    const offset = ccp + segStart;
    const hdr = await read(offset, offset + 11); // ID (4 B) + size vint (≤4 B) + slack
    if (
      hdr.length < 5 ||
      hdr[0] !== ((cid >>> 24) & 0xff) ||
      hdr[1] !== ((cid >>> 16) & 0xff) ||
      hdr[2] !== ((cid >>> 8) & 0xff) ||
      hdr[3] !== (cid & 0xff)
    ) {
      throw new Error(`ass-row2: not a cluster @ ${offset}`);
    }
    const vln = vintLenAt(hdr, 4);
    if (vln === 0) throw new Error(`ass-row2: bad cluster size @ ${offset}`);
    out.push({
      ccp,
      offset,
      payloadStart: offset + 4 + vln,
      size: vintValue(hdr, 4, vln),
      windowStart: tsToMs(t, scale),
    });
  }
  out.sort((a, b) => a.windowStart - b.windowStart);
  return out;
}

/** The lazy row-2 upgrade: clusters fetch as the playhead approaches. */
export interface Row2Scheduler {
  /** Feed the current playhead position; clusters due within the lookahead start fetching. */
  onPlayhead(tMs: number): void;
  /** Wait until no cluster that is due at the last playhead position is in flight. */
  settle(): Promise<void>;
  /** True once every planned cluster has been merged or failed. */
  isDone(): boolean;
  /** The target track's events, in cluster-merge order (assembleAss sorts by readorder). */
  events(): AssEvent[];
  /** Clusters that failed to fetch (skipped — non-fatal, the base layer keeps rendering). */
  failed(): number;
}

export interface Row2SchedulerArgs {
  read: (start: number, end: number) => Promise<Uint8Array>;
  scale: number;
  plan: Row2Cluster[];
  trackNum: number;
  /** Fetch a cluster when the playhead is within this many ms of its earliest cue. */
  lookaheadMs: number;
  /** Max concurrent cluster fetches (default 1 — the throttle). */
  concurrency?: number;
}

export function createLazyScheduler(args: Row2SchedulerArgs): Row2Scheduler {
  const { read, scale, plan, trackNum, lookaheadMs } = args;
  const concurrency = args.concurrency ?? 1;
  const events: AssEvent[] = [];
  const settled = new Set<number>(); // ccp → merged or failed
  const inflight = new Set<Promise<void>>();
  let lastT = Number.NEGATIVE_INFINITY;
  let failures = 0;

  async function fetchCluster(c: Row2Cluster): Promise<void> {
    try {
      const buf = await read(c.payloadStart, c.payloadStart + c.size - 1);
      if (buf.length < c.size) throw new Error("short cluster payload");
      // Walk the cluster locally: a BoundedReader over the payload, in the
      // file's coordinate space, so the shared cluster walk is unchanged.
      const base = c.payloadStart;
      const local = new BoundedReader(
        (s, e) => Promise.resolve(buf.subarray(s - base, e - base + 1)),
        c.size + 64
      );
      const evs = await collectClusterEvents(local, base, base + c.size, scale, trackNum);
      events.push(...evs);
    } catch {
      failures += 1; // one bad cluster is skipped — never fatal
    } finally {
      settled.add(c.ccp);
    }
  }

  function startDue(): void {
    for (const c of plan) {
      if (inflight.size >= concurrency) return;
      if (settled.has(c.ccp)) continue;
      if (c.windowStart > lastT + lookaheadMs) continue;
      // The promise removes itself when settled; the self-reference routes
      // through `self` so definite-assignment analysis can see it.
      const self: { p?: Promise<void> } = {};
      self.p = fetchCluster(c).finally(() => {
        if (self.p !== undefined) inflight.delete(self.p);
      });
      inflight.add(self.p);
    }
  }

  return {
    onPlayhead(tMs) {
      lastT = tMs;
      startDue();
    },
    async settle() {
      for (;;) {
        startDue();
        if (inflight.size === 0) return;
        // The wrappers never reject (fetchCluster swallows its errors).
        await Promise.all([...inflight]);
      }
    },
    isDone: () => settled.size === plan.length,
    events: () => events,
    failed: () => failures,
  };
}
