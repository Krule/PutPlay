// Raw ASS demux over HTTP Range (T3).
//
// Reassembles an embedded Matroska ASS subtitle track byte-exactly as
// FFmpeg n9.0.2's `libavformat/assenc.c` muxer does, by walking Clusters
// (the Cues index in this file is unreliable — see test/ass-demux.test.mjs)
// and fetching only the bytes needed through a ranged reader.
//
// Parity reference: /tmp/oracle_eng.ass, produced by
//   ffmpeg -i kusuriya2.mkv -map 0:s:0 -c copy -f ass eng_track.ass
// (md5 10e8749b88071123387c8947a5059ebc).

import {
  BoundedReader,
  MATROSKA,
  findSegmentStart,
  readInt,
  readString,
  walkChildren,
  walkSegmentTop,
} from "./probe";

const HEAD_WINDOW = 65536; // first fetch: 64 KB
const HEAD_MAX_BYTES = 1024 * 1024; // head-region tripwire: 1 MB
const DEMUX_MAX_BYTES = 8 * 1024 * 1024; // demux tripwire: 8 MB
const MAX_CLUSTERS = 4096; // walk cap for segment-level elements (real file: ~553 clusters)
const MAX_CLUSTER_ELEMENTS = 1024; // walk cap per cluster (a real cluster holds ~374 elements)

// ---------------- the segment head walk ----------------

/** One entry of the segment's track table, in file order. */
export interface DemuxTrackInfo {
  /** Matroska TrackNumber (0xd7) */
  num: number;
  /** CodecID string, e.g. "S_TEXT/ASS" */
  codecId: string;
  /** CodecPrivate bytes (empty when the track has none) */
  priv: Uint8Array;
}

/**
 * Everything the demuxer needs from the segment head:
 *   - segStart: the Segment payload start — the offset all segment-relative
 *     positions (SeekHead, Cues) are measured from
 *   - scale: TimestampScale (ns per timestamp unit; 1_000_000 ⇒ ms)
 *   - tracks: every track entry with a number (subtitle CPs included)
 *   - firstClusterOffset: the first Cluster element's ID offset, or -1 when the
 *     window ends before any cluster (clean partial stop)
 */
export interface AssHead {
  segStart: number;
  scale: number;
  tracks: DemuxTrackInfo[];
  firstClusterOffset: number;
}

function emptyAssHead(): AssHead {
  return { segStart: -1, scale: 1_000_000, tracks: [], firstClusterOffset: -1 };
}

/** The head walk over an already-windowed reader (see readAssHead). */
async function readAssHeadFrom(r: BoundedReader): Promise<AssHead> {
  const out = emptyAssHead();
  out.segStart = await findSegmentStart(r);
  if (out.segStart < 0) return out;

  // Walk the Segment's top-level elements; skip everything but
  // Info / Tracks / the first Cluster by offset.
  await walkSegmentTop(r, out.segStart, async (h, p, pe) => {
    if (h.id === MATROSKA.INFO) {
      await walkChildren(r, p, pe, async (c, cp) => {
        if (c.id === MATROSKA.TIMESTAMP_SCALE) out.scale = await readInt(r, cp, c.size);
      });
    } else if (h.id === MATROSKA.TRACKS) {
      out.tracks = await collectTracks(r, p, pe);
    } else if (h.id === MATROSKA.CLUSTER) {
      out.firstClusterOffset = p - h.hdrLen; // ID offset: walkSegmentTop's entry point
      return true;
    }
    return false;
  });
  return out;
}

/**
 * Read the segment head (Segment start, TimestampScale, track table, first
 * Cluster offset) through a ranged reader: one 64 KB fetch, then header-only
 * walks — payloads of uninteresting elements (Chapters, embedded fonts) cost
 * zero bytes. Stops cleanly with a partial result when the data ends.
 */
export async function readAssHead(
  read: (start: number, end: number) => Promise<Uint8Array>
): Promise<AssHead> {
  const r = new BoundedReader(read, HEAD_MAX_BYTES);
  const first = await r.fetchAt(0, HEAD_WINDOW);
  if (!first.length) return emptyAssHead();
  return readAssHeadFrom(r);
}

async function collectTracks(
  r: BoundedReader,
  start: number,
  end: number
): Promise<DemuxTrackInfo[]> {
  const out: DemuxTrackInfo[] = [];
  await walkChildren(r, start, end, async (h, p) => {
    if (h.id !== MATROSKA.TRACK_ENTRY) return;
    let num = -1;
    let codecId = "";
    let priv: Uint8Array = new Uint8Array(0);
    await walkChildren(r, p, p + h.size, async (c, cp) => {
      if (c.id === MATROSKA.TRACK_NUMBER) num = await readInt(r, cp, c.size);
      else if (c.id === MATROSKA.CODEC_ID) codecId = await readString(r, cp, c.size);
      else if (c.id === MATROSKA.CODEC_PRIVATE) priv = await r.fetchAt(cp, c.size);
    });
    if (num >= 0) out.push({ num, codecId, priv });
  });
  return out;
}

// ---------------- the FFmpeg ass-muxer parity layer ----------------

/**
 * Matroska timestamp (ms, TimestampScale-normalized) → ASS time
 * `h:mm:ss.cc` — assenc.c: centisecond values via truncating rescale
 * (av_rescale_q default rounding), hour unpadded `%d`, mm/ss/cc `%02d`,
 * anything past 9 hours clamped to 9:59:59.99.
 */
export function fmtAssTime(ms: number): string {
  if (ms < 0) ms = 0;
  const cc = Math.floor((ms % 1000) / 10);
  const ss = Math.floor(ms / 1000) % 60;
  const mm = Math.floor(ms / 60000) % 60;
  let hh = Math.floor(ms / 3600000);
  if (hh > 9) return "9:59:59.99";
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cc).padStart(2, "0")}`;
}

/**
 * Parsed subtitle block data (after the [track vint][rel ts] header,
 * with ONE leading 0x00 stripped like FFmpeg does).
 * Layout: `f0,f1,style,name,ML,MR,MV,Effect,Text` — f0 is the READORDER
 * (FFmpeg caches lines and emits them in readorder sequence), f1 is the
 * ASS layer.
 */
export interface AssEvent {
  ro: number;
  layer: string;
  startMs: number;
  endMs: number;
  rest: string;
}

/**
 * Parse the payload of one subtitle block: strip one leading 0x00, split
 * `readorder,layer,<rest>` on the first two commas.
 */
export function parseAssBlock(
  payload: Uint8Array,
  startMs: number,
  endMs: number
): AssEvent {
  const text = new TextDecoder("utf-8").decode(
    payload[0] === 0 ? payload.subarray(1) : payload
  );
  const c1 = text.indexOf(",");
  const c2 = c1 < 0 ? -1 : text.indexOf(",", c1 + 1);
  const ro = Number(text.slice(0, c1 < 0 ? text.length : c1));
  const layerField = c2 < 0 ? "" : text.slice(c1 + 1, c2);
  return {
    ro,
    layer: String(Math.trunc(Number(layerField) || 0)),
    startMs,
    endMs,
    rest: c2 < 0 ? text : text.slice(c2 + 1),
  };
}

/**
 * Reassemble the .ass exactly as assenc.c does:
 *   - the CodecPrivate header, line endings normalized CRLF→LF, up to and
 *     including the Format line's newline (ffio_write_lines ... NULL);
 *   - the Dialogue lines in READORDER (stable for duplicates) —
 *     `Dialogue: <layer>,<start>,<end>,<rest>\n`;
 *   - the CodecPrivate trailer (the blank line after Format) → one final
 *     "\n" after the last dialogue.
 */
export function assembleAss(codecPrivate: Uint8Array, events: AssEvent[]): Uint8Array {
  const cp = new TextDecoder("utf-8").decode(codecPrivate).replace(/\r\n/g, "\n");
  const lines = events
    .slice()
    .sort((a, b) => a.ro - b.ro) // Array.sort is stable: equal ro keeps arrival order
    .map(
      (e) =>
        `Dialogue: ${e.layer},${fmtAssTime(e.startMs)},${fmtAssTime(e.endMs)},${e.rest}`
    );
  const body =
    (cp.length > 0 ? cp.slice(0, -1) : "") +
    (lines.length > 0 ? lines.join("\n") + "\n" : "");
  return new TextEncoder().encode(body + "\n");
}

// ---------------- the cluster walk ----------------

/** TimestampScale (ns per unit) → ms */
function tsToMs(v: number, scale: number): number {
  return Math.round((v * scale) / 1_000_000);
}

interface BlockHead {
  track: number;
  relTs: number;
}

/**
 * Read one SimpleBlock/Block's 3-byte header: [track vint 1B][rel ts 2B
 * big-endian]. The relative timestamp is a plain integer (not a vint) in
 * files Lavf writes. Returns null when the payload is shorter than the
 * header. (The block's data is fetched separately — only for the target
 * track — so the walk never touches the A/V payloads.)
 */
async function readBlockHead(
  r: BoundedReader,
  payloadStart: number
): Promise<BlockHead | null> {
  const head = await r.fetchAt(payloadStart, 3);
  if (head.length < 3 || !(head[0] & 0x80)) return null; // track vint sets the marker bit
  return { track: head[0] & 0x7f, relTs: head[1] * 256 + head[2] };
}

/**
 * Walk one Cluster's payload and return the target track's subtitle events
 * in arrival order. The ClusterTimestamp (0xe7) anchors every block's
 * relative timestamp; a BlockGroup (0xa0) contributes its BlockDuration
 * (0x9b, in TimestampScale units) — a bare SimpleBlock (0xa3) carries no
 * duration in the format, so its end falls back to its start (the reference
 * file always uses BlockGroup for subtitles).
 */
export async function collectClusterEvents(
  r: BoundedReader,
  clusterStart: number,
  clusterEnd: number,
  scale: number,
  trackNum: number
): Promise<AssEvent[]> {
  const out: AssEvent[] = [];
  let cts = 0;
  await walkChildren(r, clusterStart, clusterEnd, async (h, p) => {
    if (h.id === MATROSKA.CLUSTER_TIMESTAMP) {
      cts = await readInt(r, p, h.size);
      return;
    }
    // A block lives in one of two containers: a bare SimpleBlock (the element
    // itself) or a BlockGroup (the nested Block 0xa1 child, which also holds
    // the BlockDuration 0x9b). Anything else is skipped.
    let blockStart = -1;
    let blockSize = 0;
    let dur = 0;
    if (h.id === MATROSKA.BLOCK_GROUP) {
      await walkChildren(r, p, p + h.size, async (c, cp) => {
        if (c.id === MATROSKA.BLOCK) {
          blockStart = cp;
          blockSize = c.size;
        } else if (c.id === MATROSKA.BLOCK_DURATION) dur = await readInt(r, cp, c.size);
      });
      if (blockStart < 0) return;
    } else if (h.id === MATROSKA.SIMPLE_BLOCK) {
      blockStart = p;
      blockSize = h.size;
    } else {
      return;
    }
    const head = await readBlockHead(r, blockStart);
    if (!head || head.track !== trackNum) return; // A/V blocks: header only, data untouched
    const data = await r.fetchAt(blockStart + 3, blockSize - 3);
    const startMs = tsToMs(cts + head.relTs, scale);
    out.push(parseAssBlock(data, startMs, tsToMs(cts + head.relTs + dur, scale)));
  }, MAX_CLUSTER_ELEMENTS);
  return out;
}

// ---------------- the demux ----------------

/** The reassembled track: .ass bytes + cue count. */
export interface DemuxResult {
  ass: Uint8Array;
  cues: number;
}

/**
 * Demux one embedded ASS subtitle track (by Matroska TrackNumber) from a
 * ranged reader and reassemble the .ass byte-exact per assenc.c.
 *
 * Bytes touched: the 64 KB head window, the headers of every segment element
 * from the first Cluster to the Cues index (skipping payloads by offset),
 * and the payload of the target track's blocks only.
 */
export async function demuxAssTrack(
  read: (start: number, end: number) => Promise<Uint8Array>,
  trackNum: number
): Promise<DemuxResult> {
  const r = new BoundedReader(read, DEMUX_MAX_BYTES);
  const first = await r.fetchAt(0, HEAD_WINDOW);
  if (!first.length) throw new Error("ass-demux: the reader returned no data");

  const head = await readAssHeadFrom(r);
  const track = head.tracks.find((t) => t.num === trackNum);
  if (!track) throw new Error(`ass-demux: track ${trackNum} not found in the segment`);
  if (head.firstClusterOffset < 0) throw new Error("ass-demux: no cluster is reachable in the file");

  // Walk the Clusters by header; the Cues index (or any other segment
  // element) ends the walk. Only the target track's block payloads are read.
  const events: AssEvent[] = [];
  await walkSegmentTop(
    r,
    head.firstClusterOffset,
    async (h, p, pe) => {
      if (h.id !== MATROSKA.CLUSTER) return true;
      events.push(...(await collectClusterEvents(r, p, pe, head.scale, trackNum)));
      return false;
    },
    MAX_CLUSTERS
  );
  return { ass: assembleAss(track.priv, events), cues: events.length };
}
