/**
 * ZIP parser — the pure byte-level core of the archive viewer.
 *
 * An archive opened on the TV must LIST without downloading: the app fetches
 * only the file's TAIL (EOCD + central directory) via a Range request, and
 * this module turns those bytes into an honest entry model. No imports —
 * the async side (range fetch + pako inflate + size cap) lives in
 * zip-extract.ts so this file stays unit-testable against raw fixtures.
 *
 * Scope (v1): single-disk ZIP. ZIP64 is DETECTED and flagged; the screen
 * refuses it honestly. Encryption is not supported (entries are listed, but
 * a password-protected archive must be refused — the screen checks the flag).
 */

export interface ZipEntry {
  /** Entry path with forward slashes; directories end with "/". */
  name: string;
  isDir: boolean;
  /** 0 = stored, 8 = deflate. Anything else the extract layer must refuse. */
  method: number;
  /** Uncompressed size (bytes). */
  size: number;
  compressedSize: number;
  crc32: number;
  /** Offset of the LOCAL file header (not the data — see entryDataStart). */
  offset: number;
  /** General-purpose bit flags (bit 11 = UTF-8 name, bit 0 = encrypted). */
  flags: number;
  encrypted: boolean;
}

export interface ZipModel {
  entries: ZipEntry[];
  /** True when a ZIP64 structure was detected — v1 must refuse to browse. */
  zip64: boolean;
}

export class ZipError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ZipError";
  }
}

export interface ArchiveRow {
  /** Base name (no path). */
  name: string;
  isDir: boolean;
  size: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const MAX_COMMENT = 0xffff;
const EOCDFIELD_MAX = 0xffffffff;

function u32(dv: DataView, at: number): number {
  return dv.getUint32(at, true);
}
function u16(dv: DataView, at: number): number {
  return dv.getUint16(at, true);
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  // non-fatal decoders never throw — malformed bytes degrade, they don't kill the listing
  return utf8 ? new TextDecoder("utf-8").decode(bytes) : new TextDecoder("latin1").decode(bytes);
}

interface EocdFields {
  /** CD start in FILE space (as the EOCD declares it). */
  cdOffset: number;
  cdSize: number;
  cdEntries: number;
  zip64: boolean;
}

/**
 * The EOCD's raw fields at a TAIL offset (signature already matched).
 * Null when the candidate's comment runs past the buffer end or it is a
 * multi-disk archive (neither is browseable in v1). No central-directory
 * bytes are read — that is the point: the CD may lie before the fetched
 * window (see findEocdHint).
 */
function eocdFieldsAt(dv: DataView, at: number, len: number): EocdFields | null {
  const commentLen = u16(dv, at + 20);
  if (at + 22 + commentLen > len) return null;
  if (u16(dv, at + 4) !== 0 || u16(dv, at + 6) !== 0) return null; // multi-disk: not v1

  const cdOffset = u32(dv, at + 16);
  const cdSize = u32(dv, at + 12);
  const cdEntries = u16(dv, at + 10);
  const zip64 =
    at >= 20 && u32(dv, at - 20) === EOCD64_LOCATOR_SIG
      ? true
      : cdOffset === EOCDFIELD_MAX || cdSize === EOCDFIELD_MAX || cdEntries === 0xffff;
  return { cdOffset, cdSize, cdEntries, zip64 };
}

/**
 * Validate ONE EOCD candidate (signature already matched at `at`, a TAIL
 * offset): its comment must fit to the end of the buffer, it must be
 * single-disk, and its central directory must start with the CD signature,
 * end at/before the EOCD, and have room for every entry it claims. ZIP64
 * candidates are reported as such (the caller refuses to browse them in v1).
 *
 * Coordinate spaces: the EOCD declares cdOffset in FILE space, but `at` and
 * everything readable through `dv` is TAIL space. `tailStart` (where the
 * tail begins in the file) is the conversion. For small files the tail IS
 * the file (tailStart 0) and both spaces coincide — which is why this bug
 * was invisible on every fixture until a real >256 KB comic hit the C1.
 */
function candidateAt(dv: DataView, at: number, len: number, tailStart: number): EocdFields | null {
  const f = eocdFieldsAt(dv, at, len);
  if (!f) return null;
  if (f.zip64) return f;

  const cdLocal = f.cdOffset - tailStart;
  // file-space sanity: the CD ends at/before the EOCD…
  if (f.cdOffset + f.cdSize > tailStart + at + 22) return null;
  // …and it must be WHOLLY inside the fetched tail…
  if (cdLocal < 0 || cdLocal + f.cdSize > at + 22) return null;
  // …and it must look like a central directory of the size it claims.
  if (f.cdEntries > 0 && (u32(dv, cdLocal) !== CD_SIG || f.cdSize < f.cdEntries * 46)) return null;
  if (f.cdEntries === 0 && f.cdSize !== 0) return null;
  return f;
}

export interface EocdHint {
  /** CD start in FILE space, as the EOCD declares it. */
  cdOffset: number;
  cdSize: number;
  cdEntries: number;
  zip64: boolean;
}

/**
 * Stage 1 of the two-stage open: find the EOCD in a window (the last 64 KB,
 * or the whole file) and return its central-directory pointer — WITHOUT
 * reading the CD bytes, which may lie before the window. Null when the
 * window holds no valid EOCD (not a zip, or truncated). The caller fetches
 * exactly [cdOffset, end) as stage 2 and hands that to parseZip.
 */
export function findEocdHint(tail: Uint8Array): EocdHint | null {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const from = Math.max(0, tail.length - 22 - MAX_COMMENT);
  for (let i = tail.length - 22; i >= from; i--) {
    if (u32(dv, i) !== EOCD_SIG) continue;
    const f = eocdFieldsAt(dv, i, tail.length);
    if (!f) continue;
    return { cdOffset: f.cdOffset, cdSize: f.cdSize, cdEntries: f.cdEntries, zip64: f.zip64 };
  }
  return null;
}

/**
 * Parse the archive from its TAIL (the last bytes of the file; the whole
 * file when it is smaller than the tail). `tailStart` is where the tail
 * begins inside the file — required for any file bigger than the tail, or
 * the CD's file-space offsets land outside the buffer (and the valid EOCD
 * gets rejected as "not a ZIP"). The EOCD is found by a validated backward
 * scan — matching the signature alone is not enough, tools append junk
 * after the real EOCD, so every candidate must pass candidateAt().
 */
export function parseZip(tail: Uint8Array, tailStart: number = 0): ZipModel {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const from = Math.max(0, tail.length - 22 - MAX_COMMENT);

  for (let i = tail.length - 22; i >= from; i--) {
    if (u32(dv, i) !== EOCD_SIG) continue;
    const c = candidateAt(dv, i, tail.length, tailStart);
    if (!c) continue;
    if (c.zip64) return { entries: [], zip64: true };
    return {
      entries: parseCentralDirectory(dv, c.cdOffset - tailStart, c.cdEntries),
      zip64: false,
    };
  }

  throw new ZipError("no-eocd", "Not a ZIP archive — the end-of-central-directory record was not found.");
}

function parseCentralDirectory(dv: DataView, cdOffset: number, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let off = cdOffset;
  for (let n = 0; n < count; n++) {
    if (u32(dv, off) !== CD_SIG) throw new ZipError("bad-cd", "Corrupt central directory.");
    const flags = u16(dv, off + 8);
    const method = u16(dv, off + 10);
    const crc32 = u32(dv, off + 16);
    const compressedSize = u32(dv, off + 20);
    const size = u32(dv, off + 24);
    const nameLen = u16(dv, off + 28);
    const extraLen = u16(dv, off + 30);
    const commentLen = u16(dv, off + 32);
    const offset = u32(dv, off + 42);
    const nameStart = off + 46;
    const name = decodeName(new Uint8Array(dv.buffer, dv.byteOffset + nameStart, nameLen), (flags & 0x800) !== 0);
    entries.push({
      name,
      isDir: name.endsWith("/"),
      method,
      size,
      compressedSize,
      crc32,
      offset,
      flags,
      encrypted: (flags & 0x0001) !== 0,
    });
    off = nameStart + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Where the data starts, given the entry's LOCAL file header (30+ bytes,
 * starting at the signature). The local name/extra lengths decide — they
 * can differ from the central directory's.
 */
export function localDataStart(local: Uint8Array): number {
  const dv = new DataView(local.buffer, local.byteOffset, local.byteLength);
  if (local.length < 30 || u32(dv, 0) !== LOCAL_SIG) {
    throw new ZipError("bad-local", "Local file header is missing or corrupt.");
  }
  return 30 + u16(dv, 26) + u16(dv, 28);
}

/** Absolute data start inside a buffer that contains the whole file tail. */
export function entryDataStart(tail: Uint8Array, e: ZipEntry): number {
  if (e.offset + 30 > tail.length) {
    throw new ZipError("bad-local", `Local file header missing for ${e.name}.`);
  }
  return e.offset + localDataStart(tail.slice(e.offset, e.offset + 30));
}

/**
 * The entry's bytes as stored in the archive: raw for stored entries,
 * COMPRESSED for deflated ones (the extract layer inflates with pako).
 * `tail` must contain the entry's range (offset .. dataStart+compressedSize).
 */
export function extractEntryData(tail: Uint8Array, e: ZipEntry): Uint8Array {
  const start = entryDataStart(tail, e);
  const end = start + e.compressedSize;
  if (end > tail.length) throw new ZipError("truncated-entry", `Data of ${e.name} runs past the fetched range.`);
  return tail.slice(start, end);
}

/**
 * The rows of ONE folder inside the archive: the direct files plus the
 * implicit directory segments (paths imply folders that were never written
 * as entries), one list, case-insensitive name order — the library's feel.
 * `path` is "" at the archive root and ends with "/" below it.
 */
export function archiveView(entries: ZipEntry[], path: string): ArchiveRow[] {
  const rows: ArchiveRow[] = [];
  const dirNames = new Set<string>();
  for (const e of entries) {
    if (e.isDir || !e.name.startsWith(path)) continue;
    const rest = e.name.slice(path.length);
    const slash = rest.indexOf("/");
    if (slash === -1) rows.push({ name: rest, isDir: false, size: e.size });
    else dirNames.add(rest.slice(0, slash));
  }
  dirNames.forEach((d) => rows.push({ name: d, isDir: true, size: 0 }));
  rows.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return rows;
}

/**
 * The archive's Back key, in one line: the parent of the current path.
 * "" is the archive root — the screen leaves the archive from there.
 */
export function archiveParentPath(path: string): string {
  if (path === "") return "";
  const body = path.endsWith("/") ? path.slice(0, -1) : path;
  const at = body.lastIndexOf("/");
  return at > 0 ? body.slice(0, at + 1) : "";
}
