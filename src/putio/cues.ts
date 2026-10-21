/**
 * Cues (the Matroska tail index) — parsing + validation for the raw-ASS
 * upgrade (docs/raw-ass-upgrade.md, rows 1–2).
 *
 * A CuePoint (0xBB) says: "track N has a block at time T in the cluster at
 * (segment-relative) offset CCP, at in-cluster offset REL (from the cluster's
 * PAYLOAD start, pointing at the block's element ID 0xA0/0xA3), lasting DUR."
 *
 * `validateCues` settles which upgrade row a file earns with ~10–20 tiny
 * reads:
 *   row 1 — clusters AND in-cluster rels verified → batch-range the blocks
 *   row 2 — clusters verified, rels untrustworthy, file ≤ 2 GiB → lazy sub-cluster fetch
 *   row 3 — anything else → base layer only
 */

import { vintLenAt, vintValue } from "./probe";

// ------------------------------------------------------------------- types

export interface CueEntry {
  /** CueTime — absolute, TimestampScale units */
  t: number;
  /** CueTrackNumber — the container track number (verified = the block's track vint) */
  track: number;
  /** CueClusterPosition — SEGMENT-relative; file offset = + segStart */
  ccp: number;
  /** CueRelativePosition — from the cluster payload start, at the block element ID; null when absent */
  rel: number | null;
  /** CueDuration — TimestampScale units; null when absent */
  dur: number | null;
}

export interface CueValidation {
  row: 1 | 2 | 3;
  /** sampled clusters that carried a real Cluster ID (1F 43 B6 75) */
  clusterOk: number;
  clusterN: number;
  /** sampled blocks that landed on a well-formed block of the cue's track at the cue's time */
  landOk: number;
  landN: number;
}

export interface ValidateArgs {
  /** inclusive-end reader: read(start, end) → bytes[start..end] */
  read: (start: number, end: number) => Promise<Uint8Array>;
  /** file offset where the Segment payload starts (the "+52" rule) */
  segStart: number;
  /** TimestampScale (ns per time unit) — reserved for ms conversion */
  scale: number;
  /** file offset of the Cues element ID, or null when the file has no Cues */
  cuesFileOffset: number | null;
  cues: CueEntry[];
  /** the container track number to validate (one put.io embedded track) */
  trackNum: number;
  /** full file size — row 2's 2 GiB cap */
  fileSize: number;
}

// row 2's cap: below it, a lazy sub-cluster fetch stays a good-citizen background cost
const ROW2_MAX_BYTES = 2 * 1024 ** 3;
// sampling — the audit used the same spreads on real files
const CLUSTER_SAMPLE = 12;
const LAND_SAMPLE = 8;
// read windows (the reader is inclusive-end: read(off, off + BYTES - 1))
const CLUSTER_HDR_BYTES = 12; // 4 B Cluster ID + a size vint up to 8 B
const BLOCK_HDR_BYTES = 12; // 0xA0/0xA3 ID + header + track vint + 2 B rel ts
const CTS_PREFIX_BYTES = 48; // optional 0xBF CRC element + the 0xE7 cts element
// |cts + rel_ts − CueTime| tolerance, in TimestampScale units
const TIME_TOLERANCE = 1;

// ----------------------------------------------------------------- byte util

/** Element ID at `off`: 1–4 bytes, the length is the marker bit. The marker
 *  stays PART of the returned ID value (codebase convention — e.g. the 4-byte
 *  Cluster ID is 0x1F43B675, marker bit included). null = not an ID. */
function readId(buf: Uint8Array, off: number): { id: number; len: number } | null {
  if (off >= buf.length) return null;
  const b = buf[off];
  if (b & 0x80) return { id: b, len: 1 };
  if (b & 0x40) {
    if (off + 1 >= buf.length) return null;
    return { id: 0x4000 | ((b & 0x3f) << 8) | buf[off + 1], len: 2 };
  }
  if (b & 0x20) {
    if (off + 2 >= buf.length) return null;
    return { id: 0x200000 | ((b & 0x1f) << 16) | (buf[off + 1] << 8) | buf[off + 2], len: 3 };
  }
  if (b & 0x10) {
    if (off + 3 >= buf.length) return null;
    return {
      id: 0x10000000 | ((b & 0x0f) << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3],
      len: 4,
    };
  }
  return null;
}

/** Big-endian unsigned int (value fields; floats are exact to 2^53). */
function intOf(buf: Uint8Array, off: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[off + i];
  return v;
}

/** Evenly-spread sample of at most `n` items (order-preserving). */
function sampleEvenly<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor((i * xs.length) / n)]);
  return out;
}

// --------------------------------------------------------------- parseCues

/**
 * Decode a Cues element PAYLOAD (the bytes after the Cues ID + size vint)
 * into CueEntry[] — one entry per (CuePoint × CueTrackPosition): a CuePoint may
 * carry several tracks' positions for the same timestamp. Unknown elements
 * (e.g. the leading 0xBF CRC) are skipped.
 */
export function parseCues(bytes: Uint8Array): CueEntry[] {
  const out: CueEntry[] = [];

  for (const p of cuePoints(bytes)) {
    let t = 0;
    for (const c of children(bytes, p[0], p[1])) {
      if (c.id === 0xb3) t = intOf(bytes, c.pos, c.size);
      else if (c.id === 0xb7) {
        let track = 0;
        let ccp = 0;
        let rel: number | null = null;
        let dur: number | null = null;
        for (const f of children(bytes, c.pos, c.size)) {
          if (f.id === 0xf7) track = intOf(bytes, f.pos, f.size);
          else if (f.id === 0xf1) ccp = intOf(bytes, f.pos, f.size);
          else if (f.id === 0xf0) rel = intOf(bytes, f.pos, f.size);
          else if (f.id === 0xb2) dur = intOf(bytes, f.pos, f.size);
        }
        out.push({ t, track, ccp, rel, dur });
      }
    }
  }
  return out;
}

/**
 * Fetch + parse the Cues element at its file offset (the ID 1C53BB6B
 * position the probe's SeekHead walk reports): one 12 B header read
 * (ID + size vint) and one payload read — the element itself is small
 * (~87 KB on the 218 MB reference file). [] when the offset is stale or
 * the bytes are not the Cues element (the caller routes to row 3).
 */
export async function fetchCues(
  read: (start: number, end: number) => Promise<Uint8Array>,
  cuesFileOffset: number,
): Promise<CueEntry[]> {
  const hdr = await read(cuesFileOffset, cuesFileOffset + 11);
  const id = readId(hdr, 0);
  if (!id || id.id !== 0x1c53bb6b) return [];
  const sln = vintLenAt(hdr, id.len);
  if (!sln || id.len + sln > hdr.length) return [];
  const size = vintValue(hdr, id.len, sln);
  const payload = await read(
    cuesFileOffset + id.len + sln,
    cuesFileOffset + id.len + sln + size - 1,
  );
  return parseCues(payload);
}

/** The CuePoint (0xBB) elements in a Cues payload: [payloadStart, payloadSize]. */
function cuePoints(bytes: Uint8Array): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (const e of children(bytes, 0, bytes.length)) {
    if (e.id === 0xbb) found.push([e.pos, e.size]);
  }
  return found;
}

/** Direct children of an element payload; stops at the first malformed ID. */
function children(
  bytes: Uint8Array,
  start: number,
  size: number,
): Array<{ id: number; pos: number; size: number }> {
  const out: Array<{ id: number; pos: number; size: number }> = [];
  const end = start + size;
  let i = start;
  while (i + 2 <= end) {
    const id = readId(bytes, i);
    if (!id) return out;
    i += id.len;
    const sln = vintLenAt(bytes, i);
    if (!sln || i + sln > end) return out;
    const s = vintValue(bytes, i, sln);
    const pos = i + sln;
    if (pos + s > end) return out;
    out.push({ id: id.id, pos, size: s });
    i = pos + s;
  }
  return out;
}

// ------------------------------------------------------------- validateCues

type LandOutcome = "ok" | "badRel" | "badLabel";

/**
 * Settle the upgrade row for one container track with sampled tiny reads.
 *
 * cluster check: 12 B at ccp+segStart → must be a Cluster ID (1F 43 B6 75)
 * landing check:  12 B at the claimed block → must be a 0xA0/0xA3 of the cue's
 *                 track whose cts+rel_ts equals the cue's time; plus the cluster
 *                 prefix (after an optional 0xBF CRC) for the cts
 *
 * A block that lands but belongs to another track (badLabel) poisons row 2 as
 * well — row 2 picks its clusters from the same labels. A block that does not
 * land (badRel) does not: that is exactly the half-broken state row 2 exists for.
 */
export async function validateCues(a: ValidateArgs): Promise<CueValidation> {
  const none: CueValidation = { row: 3, clusterOk: 0, clusterN: 0, landOk: 0, landN: 0 };
  if (a.cuesFileOffset === null) return none;

  const trackCues = a.cues.filter((c) => c.track === a.trackNum);
  if (trackCues.length === 0) return none;

  // ccp → cluster size-vint length (the landing offset needs it)
  const ccpVln = new Map<number, number>();
  const clusters = await checkClusters(a, trackCues, ccpVln);
  const landings = await checkLandings(a, trackCues, ccpVln);

  const row: 1 | 2 | 3 =
    clusters.ok === clusters.n && landings.ok === landings.n
      ? 1
      : clusters.ok === clusters.n && landings.badLabel === 0 && a.fileSize <= ROW2_MAX_BYTES
        ? 2
        : 3;

  return {
    row,
    clusterOk: clusters.ok,
    clusterN: clusters.n,
    landOk: landings.ok,
    landN: landings.n,
  };
}

/** Sample the clusters the track's cues point at; count how many carry a real Cluster ID. */
async function checkClusters(
  a: ValidateArgs,
  trackCues: CueEntry[],
  ccpVln: Map<number, number>,
): Promise<{ ok: number; n: number }> {
  const ccps = sampleEvenly(uniqueCcps(trackCues), CLUSTER_SAMPLE);
  let ok = 0;
  for (const ccp of ccps) {
    const vln = await safe(() => clusterHeaderVln(a, ccp));
    if (vln !== null) {
      ok++;
      ccpVln.set(ccp, vln);
    }
  }
  return { ok, n: ccps.length };
}

/** Sample the track's cues; classify each claimed block's landing. */
async function checkLandings(
  a: ValidateArgs,
  trackCues: CueEntry[],
  ccpVln: Map<number, number>,
): Promise<{ ok: number; n: number; badLabel: number }> {
  const cues = sampleEvenly(trackCues, LAND_SAMPLE);
  let ok = 0;
  let badLabel = 0;
  for (const cue of cues) {
    let vln = ccpVln.get(cue.ccp);
    if (vln === undefined) {
      const v = await safe(() => clusterHeaderVln(a, cue.ccp));
      if (v !== null) {
        vln = v;
        ccpVln.set(cue.ccp, v);
      }
    }
    // a read that fails (e.g. the offset is past EOF) is evidence failure, not a crash
    const r = vln === undefined ? "badRel" : await safe(() => checkLanding(a, cue, vln));
    if (r === "ok") ok++;
    else if (r === "badLabel") badLabel++;
  }
  return { ok, n: cues.length, badLabel };
}

/** Run a check, mapping a failed read to `null` (the caller treats it as a miss). */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function uniqueCcps(cues: CueEntry[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const c of cues) {
    if (!seen.has(c.ccp)) {
      seen.add(c.ccp);
      out.push(c.ccp);
    }
  }
  return out;
}

/**
 * Read the cluster header at ccp. Returns the size-vint length when it carries
 * a Cluster ID (1F 43 B6 75), else null. 12 B covers the ID + a vint up to 4 B.
 */
async function clusterHeaderVln(a: ValidateArgs, ccp: number): Promise<number | null> {
  const off = ccp + a.segStart;
  const h = await a.read(off, Math.min(off + CLUSTER_HDR_BYTES - 1, a.fileSize - 1));
  if (h.length < 5) return null;
  if (h[0] !== 0x1f || h[1] !== 0x43 || h[2] !== 0xb6 || h[3] !== 0x75) return null;
  const vln = vintLenAt(h, 4);
  if (!vln) return null;
  return off + 4 + vln <= a.fileSize ? vln : null;
}

/** Land one cue's claimed block; classify ok / badRel / badLabel. */
async function checkLanding(a: ValidateArgs, cue: CueEntry, vln: number): Promise<LandOutcome> {
  if (cue.rel === null) return "badRel";
  const boff = cue.ccp + a.segStart + 4 + vln + cue.rel;
  const h = await a.read(boff, Math.min(boff + BLOCK_HDR_BYTES - 1, a.fileSize - 1));
  const block = parseBlockHead(h);
  if (!block) return "badRel";
  if (block.track !== cue.track) return "badLabel";
  const cts = await clusterCts(a, cue.ccp, vln);
  if (cts === null) return "badRel";
  return Math.abs(cts + block.relTs - cue.t) <= TIME_TOLERANCE ? "ok" : "badRel";
}

/** The cluster's ClusterTimestamp (after an optional 0xBF CRC element), or null. */
async function clusterCts(a: ValidateArgs, ccp: number, vln: number): Promise<number | null> {
  const pstart = ccp + a.segStart + 4 + vln;
  const pre = await a.read(pstart, Math.min(pstart + CTS_PREFIX_BYTES - 1, a.fileSize - 1));
  let i = 0;
  if (pre.length > 0 && pre[0] === 0xbf) {
    const sln = vintLenAt(pre, 1);
    if (!sln) return null;
    i = 1 + sln + vintValue(pre, 1, sln);
  }
  if (i + 2 > pre.length || pre[i] !== 0xe7) return null;
  const sln = vintLenAt(pre, i + 1);
  if (!sln || i + 1 + sln > pre.length) return null;
  const vlen = vintValue(pre, i + 1, sln);
  if (i + 1 + sln + vlen > pre.length) return null;
  return intOf(pre, i + 1 + sln, vlen);
}

/** 0xA0 (nested 0xA1) or 0xA3 block header; null when malformed. */
function parseBlockHead(h: Uint8Array): { track: number; relTs: number } | null {
  let tp: number; // offset of the track vint
  if (h[0] === 0xa0) {
    const gl = vintLenAt(h, 1);
    if (!gl || h[1 + gl] !== 0xa1) return null;
    const bl = vintLenAt(h, 2 + gl);
    if (!bl) return null;
    tp = 1 + gl + 1 + bl;
  } else if (h[0] === 0xa3) {
    const gl = vintLenAt(h, 1);
    if (!gl) return null;
    tp = 1 + gl;
  } else {
    return null;
  }
  if (tp + 2 >= h.length) return null;
  return { track: h[tp] & 0x7f, relTs: h[tp + 1] * 256 + h[tp + 2] };
}
