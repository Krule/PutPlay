// Bounded MKV header probe over a ranged reader.
//
// Shared by two features:
//   - per-track ASS style tables (from each subtitle track's CodecPrivate)
//   - file chapters (the Editions element)
//
// The probe walks top-level segment elements by ID+size, so it never buffers
// an element it doesn't need: anything that isn't Tracks / Editions is
// skipped by offset (a 5 MB embedded-font blob costs zero bytes beyond its
// ID+size header).
//
// Bounds (agreed design): first fetch 64 KB; extension fetches only at
// element boundaries; hard tripwire 1 MB total transferred; iteration cap 256
// top-level elements; first Cluster = "header over"; a window that ends where
// the next element header would be stops the walk cleanly with a partial
// result (no hang, data kept).

import { parseAssStyles, type AssStyleTable } from "./substyle";

/**
 * Matroska element IDs (the marker bit stays in the raw bytes).
 * Old-spec set as written by Lavf (e.g. TrackNumber 0xd7, CodecId 0x86,
 * BlockDuration 0x9b — NOT the RFC 9559 0xa7).
 */
export const MATROSKA = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMESTAMP_SCALE: 0x2ad7b1,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_NAME: 0x536e,
  TRACK_LANGUAGE: 0x22b59c,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  EDITIONS: 0x1043a770,
  CLUSTER: 0x1f43b675,
  CLUSTER_TIMESTAMP: 0xe7,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_DURATION: 0x9b,
  CUES: 0x1c53bb6b,
} as const;

export interface Chapter {
  /** seconds from the start of the file */
  start: number;
  /** seconds; 0 when the source gives no end (last chapter runs to EOF) */
  end: number;
  title: string;
}

/** One ASS subtitle track as the container declares it — maps put.io's
 *  converted subtitle entries back onto the Matroska track number that
 *  demuxAssTrack walks. */
export interface AssTrackInfo {
  num: number;
  name: string;
  /** RFC 3066 language code ("eng", "spa", …); "" when the file omits it */
  lang: string;
}

export interface ProbeResult {
  /** one table per ASS subtitle track, in track order (first = default) */
  styleTables: AssStyleTable[];
  /** one entry per ASS subtitle track (parallel to styleTables) */
  assTracks: AssTrackInfo[];
  /** file chapters; [] when the file has none */
  chapters: Chapter[];
}

const FIRST_WINDOW = 65536; // 64 KB
const MAX_BYTES = 1024 * 1024; // 1 MB hard tripwire
const MAX_ELEMENTS = 256;

// Editions / EditionEntry (0x45b9) / ChapterAtom (0xb6) children (RFC 9559 §5.1.7.1.4):
const EDITION_ENTRY = 0x45b9;
const CHAPTER_ATOM = 0xb6;
const CHAPTER_DISPLAY = 0x80; // master container holding ChapString (0x85) — walk into it
const CHAPTER_STRING = 0x85;
const CHAPTER_TIME_START = 0x91;
const CHAPTER_TIME_END = 0x92; // MATROSKA.CLUSTER_TIMESTAMP is the Cluster Timestamp element, not this
const CHAPTER_UID = 0x73c4;

interface Header {
  id: number;
  size: number; // -1 = unknown (open) size
  hdrLen: number;
}

/**
 * Serves byte ranges, growing lazily. Serves from already-fetched segments
 * first; only hits the reader for missing bytes, and never past maxBytes.
 * Segments are kept sorted by start (the walk is a sequential frontier, so
 * appends dominate); lookups are binary searches, not linear scans.
 */
export class BoundedReader {
  private segs: { start: number; buf: Uint8Array }[] = [];
  private transferred = 0;
  private maxBytes: number;
  private read: (start: number, end: number) => Promise<Uint8Array>;

  constructor(
    read: (start: number, end: number) => Promise<Uint8Array>,
    maxBytes: number = MAX_BYTES
  ) {
    this.read = read;
    this.maxBytes = maxBytes;
  }

  /** highest offset (exclusive) currently buffered contiguously from 0 */
  get bufferedEnd(): number {
    let end = 0;
    for (const s of this.segs) {
      if (s.start === end) end = s.start + s.buf.length;
      else if (s.start > end) break;
    }
    return end;
  }

  async fetchAt(off: number, len: number): Promise<Uint8Array> {
    if (len <= 0) return new Uint8Array(0);
    const s = this.segCovering(off, len);
    if (s) return s.buf.subarray(off - s.start, off - s.start + len);
    if (this.transferred + len > this.maxBytes) return new Uint8Array(0);
    const buf = await this.read(off, off + len - 1);
    if (buf.length > 0) {
      this.addSeg(off, buf);
      this.transferred += buf.length;
    }
    return buf;
  }

  /** the segment fully covering [off, off+len), if any */
  private segCovering(off: number, len: number): { start: number; buf: Uint8Array } | null {
    const segs = this.segs;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start > off) hi = mid - 1;
      else lo = mid + 1;
    }
    const s = segs[lo - 1]; // rightmost segment with start <= off
    if (s && off + len <= s.start + s.buf.length) return s;
    return null;
  }

  private addSeg(start: number, buf: Uint8Array): void {
    const segs = this.segs;
    if (segs.length === 0 || start > segs[segs.length - 1].start) {
      segs.push({ start, buf }); // sequential frontier: the common case
      return;
    }
    let lo = 0;
    let hi = segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= start) lo = mid + 1;
      else hi = mid;
    }
    segs.splice(lo, 0, { start, buf }); // out-of-order fetch: keep the sort invariant
  }
}

/** vint length: 8 − index of the highest set bit (0x80→1, 0x40→2, 0x01→8) */
function vintLen(first: number, max: number): number {
  for (let p = 7; p >= 0; p--) {
    if (first & (1 << p)) return Math.min(8 - p, max);
  }
  return 0; // first byte 0x00 — invalid
}

/** value bits kept in the first byte of a vint of the given length */
function vintMask(len: number): number {
  return (1 << (8 - len)) - 1;
}

export async function readElementHeader(r: BoundedReader, pos: number): Promise<Header | null> {
  const first = await r.fetchAt(pos, 1);
  if (first.length < 1 || first[0] === 0x00 || first[0] === 0xff) return null;
  const idLen = vintLen(first[0], 4);
  if (!idLen) return null;
  const idBuf = await r.fetchAt(pos, idLen);
  if (idBuf.length < idLen) return null;
  let id = 0;
  for (const b of idBuf) id = (id << 8) | b;

  const s0 = await r.fetchAt(pos + idLen, 1);
  if (s0.length < 1 || s0[0] === 0x00) return null;
  const sizeLen = vintLen(s0[0], 8);
  if (!sizeLen) return null;
  const szBuf = await r.fetchAt(pos + idLen, sizeLen);
  if (szBuf.length < sizeLen) return null;
  const mask = vintMask(sizeLen);
  let size = szBuf[0] & mask;
  for (let i = 1; i < sizeLen; i++) size = (size << 8) | szBuf[i];
  // unknown (open) size: every value bit set
  let unknown = true;
  for (let i = 0; i < sizeLen; i++) {
    const bits = i === 0 ? mask : 0xff;
    if ((szBuf[i] & bits) !== bits) {
      unknown = false;
      break;
    }
  }
  return { id, size: unknown ? -1 : size, hdrLen: idLen + sizeLen };
}

/** Matroska integers are plain big-endian, not vints */
export async function readInt(r: BoundedReader, off: number, len: number): Promise<number> {
  const b = await r.fetchAt(off, len);
  let v = 0;
  for (const byte of b) v = v * 256 + byte; // *256, not <<8: `<<` truncates to 32 bits
  return v;
}

export async function readString(r: BoundedReader, off: number, len: number): Promise<string> {
  const b = await r.fetchAt(off, len);
  return new TextDecoder("utf-8").decode(b);
}

/**
 * Walk the direct children of [start, end). Stops (without error) when the
 * data ends or an element cannot be bounded inside the window.
 */
export async function walkChildren(
  r: BoundedReader,
  start: number,
  end: number,
  onElement: (h: Header, payloadStart: number) => Promise<void>,
  maxElements: number = MAX_ELEMENTS
): Promise<void> {
  let pos = start;
  for (let i = 0; i < maxElements; i++) {
    if (pos >= end) return;
    const h = await readElementHeader(r, pos);
    if (!h) return;
    const payloadStart = pos + h.hdrLen;
    if (h.size < 0 || payloadStart + h.size > end) return;
    await onElement(h, payloadStart);
    pos = payloadStart + h.size;
  }
}

/**
 * Top-level walk from the start of the file to the Segment (skips the EBML
 * header element). Returns the Segment payload start, or -1 when it is not
 * within the buffered window.
 */
export async function findSegmentStart(r: BoundedReader): Promise<number> {
  let pos = 0;
  for (let i = 0; i < 8; i++) {
    if (pos >= r.bufferedEnd) break;
    const h = await readElementHeader(r, pos);
    if (!h) break;
    if (h.id === MATROSKA.SEGMENT) return pos + h.hdrLen;
    if (h.size < 0 || pos + h.hdrLen + h.size > r.bufferedEnd) break;
    pos += h.hdrLen + h.size;
  }
  return -1;
}

/**
 * Walk a Segment's top-level elements by header, skipping payloads by
 * offset. Stops (without error) when the data ends, an element is open-sized,
 * or the callback returns true. If the reader's window ends where the next
 * header would be, one boundary fetch is made; empty data there stops the
 * walk cleanly with a partial result.
 */
export async function walkSegmentTop(
  r: BoundedReader,
  segStart: number,
  onElement: (h: Header, payloadStart: number, payloadEnd: number) => Promise<boolean>,
  maxElements: number = MAX_ELEMENTS
): Promise<void> {
  let pos = segStart;
  for (let i = 0; i < maxElements; i++) {
    if (pos >= r.bufferedEnd) {
      // Window edge: one boundary fetch for the next header. Empty data
      // there stops the walk cleanly with a partial result. (The fetch does
      // not extend bufferedEnd — it is not contiguous from 0 — so fall
      // through to the header read, which is served from the peek.)
      if (!(await r.fetchAt(pos, 16)).length) return;
    }
    const h = await readElementHeader(r, pos);
    if (!h) return;
    if (h.size < 0) return; // open-size child: cannot bound it, cannot skip it
    const payloadStart = pos + h.hdrLen;
    const payloadEnd = payloadStart + h.size;
    if (await onElement(h, payloadStart, payloadEnd)) return;
    pos = payloadEnd;
  }
}

async function collectTrackTables(
  r: BoundedReader,
  start: number,
  end: number
): Promise<{ tables: AssStyleTable[]; tracks: AssTrackInfo[] }> {
  const tables: AssStyleTable[] = [];
  const tracks: AssTrackInfo[] = [];
  await walkChildren(r, start, end, async (h, p) => {
    if (h.id !== MATROSKA.TRACK_ENTRY) return;
    let codecId = "";
    let num = 0;
    let name = "";
    let lang = "";
    let priv: Uint8Array | null = null;
    await walkChildren(r, p, p + h.size, async (c, cp) => {
      if (c.id === MATROSKA.CODEC_ID) codecId = await readString(r, cp, c.size);
      else if (c.id === MATROSKA.TRACK_NUMBER) num = await readInt(r, cp, c.size);
      else if (c.id === MATROSKA.TRACK_NAME && !name) name = await readString(r, cp, c.size);
      else if (c.id === MATROSKA.TRACK_LANGUAGE && !lang) lang = await readString(r, cp, c.size);
      else if (c.id === MATROSKA.CODEC_PRIVATE && !priv) priv = await r.fetchAt(cp, c.size);
    });
    // CFA can't see the closure's assignments — take the values through
    // explicitly-typed locals so the checks below are honest
    const codecIdStr: string = codecId;
    const privData = priv as Uint8Array | null;
    if (!codecIdStr.startsWith("S_TEXT") || !privData || !privData.length) return;
    const text = new TextDecoder("utf-8").decode(privData);
    if (!text.includes("[Script Info]")) return;
    const table = parseAssStyles(text);
    if (table) {
      tables.push(table);
      tracks.push({ num, name, lang });
    }
  });
  return { tables, tracks };
}

async function collectChapters(r: BoundedReader, start: number, end: number): Promise<Chapter[]> {
  const out: Chapter[] = [];
  await walkChildren(r, start, end, async (h, p) => {
    if (h.id !== EDITION_ENTRY) return;
    await walkChildren(r, p, p + h.size, async (a, ap) => {
      if (a.id !== CHAPTER_ATOM) return;
      let title = "";
      let uid = 0;
      let t0 = -1;
      let t1 = -1;
      await walkChildren(r, ap, ap + a.size, async (c, cp) => {
        if (c.id === CHAPTER_TIME_START) t0 = await readInt(r, cp, c.size);
        else if (c.id === CHAPTER_TIME_END) t1 = await readInt(r, cp, c.size);
        else if (c.id === CHAPTER_UID) uid = await readInt(r, cp, c.size);
        else if (c.id === CHAPTER_DISPLAY && !title) {
          // RFC 9559: ChapString is nested inside ChapterDisplay (may be multilingual — first wins)
          await walkChildren(r, cp, cp + c.size, async (d, dp) => {
            if (d.id === CHAPTER_STRING) title = await readString(r, dp, d.size);
          });
        }
      });
      // FFmpeg parity (libavformat/matroskadec.c): a chapter needs a start
      // time and a UID, and its timebase is a fixed 1/1e9 — the file's
      // TimestampScale is deliberately NOT applied (that's what MPV does).
      if (t0 < 0 || !uid) return;
      out.push({ start: t0 / 1e9, end: t1 >= 0 ? t1 / 1e9 : 0, title });
    });
  });
  return out;
}

export async function probeHeader(
  read: (start: number, end: number) => Promise<Uint8Array>
): Promise<ProbeResult> {
  const r = new BoundedReader(read);
  const first = await r.fetchAt(0, FIRST_WINDOW);
  if (!first.length) return { styleTables: [], assTracks: [], chapters: [] };

  const styleTables: AssStyleTable[] = [];
  const assTracks: AssTrackInfo[] = [];
  const chapters: Chapter[] = [];
  const segStart = await findSegmentStart(r);
  if (segStart < 0) return { styleTables, assTracks, chapters };

  await walkSegmentTop(r, segStart, async (h, payloadStart, payloadEnd) => {
    if (h.id === MATROSKA.TRACKS || h.id === MATROSKA.EDITIONS) {
      if (payloadEnd > r.bufferedEnd) await r.fetchAt(payloadStart, h.size);
      if (payloadEnd <= r.bufferedEnd) {
        if (h.id === MATROSKA.TRACKS) {
          const t = await collectTrackTables(r, payloadStart, payloadEnd);
          styleTables.push(...t.tables);
          assTracks.push(...t.tracks);
        } else {
          chapters.push(...(await collectChapters(r, payloadStart, payloadEnd)));
        }
      }
      return false;
    }
    if (h.id === MATROSKA.CLUSTER) return true; // header region over
    return false; // anything else (SeekHead, Void, Cues, Tags, …): skip by offset
  });
  return { styleTables, assTracks, chapters };
}
