/**
 * ZIP extract layer — the async side of the pure parser (zip.ts).
 *
 * Listing costs TWO small Range requests at most: a 64 KB window that is
 * guaranteed to contain the EOCD (a zip comment may push it up to 65 557
 * bytes back from the end), then EXACTLY the central directory the EOCD
 * points at — never a flat 256 KB tail, and never more than the index
 * weighs. Opening a file costs two small ones: the 30-byte local header
 * (its name/extra lengths decide where the data starts — they can differ
 * from the central directory's), then exactly the entry's bytes. Deflated
 * entries inflate with pako (Chromium 79 has no DecompressionStream).
 *
 * Everything that is not provably openable is refused by name: ZIP64,
 * password-protected archives, unknown compression methods, and entries
 * above the size cap (the TV's webview memory is not a hard drive).
 */
import { inflateRaw } from "pako";
import { streamURL, type Auth } from "./api";
import {
  parseZip,
  findEocdHint,
  localDataStart,
  ZipError,
  type ZipModel,
  type ZipEntry,
} from "./zip";
import type { PutFile } from "./types";

/** Stage 1: the EOCD window. 22 (EOCD) + 65 535 (max zip comment) + slack. */
export const EOCD_WINDOW = 65600;
/** A central directory beyond this is a pathological index for a TV webview. */
const MAX_CD_BYTES = 8 * 1024 * 1024;
/** One entry may not inflate to more than this — the webview's memory says no. */
export const MAX_EXTRACT_BYTES = 64 * 1024 * 1024;

export interface Extracted {
  data: Uint8Array;
  mime: string;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  txt: "text/plain",
  md: "text/markdown",
};

export function mimeFor(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/** A Range GET; a server that answers 200 (range ignored) is sliced client-side. */
async function rangeBytes(url: string, start: number, end: number): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok) {
    throw new ZipError("http", `The server refused the download (HTTP ${res.status}).`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return res.status === 206 ? buf : buf.slice(start, end + 1);
}

/**
 * A file's true total size, from the server itself: request one byte and
 * read the denominator of the Content-Range ("bytes 0-0/3469"). Used when
 * the caller has no remembered size (the continue-reading shelf reopens a
 * comic from id + name alone). A server that cannot do Range cannot do this
 * product at all — the refusal is the correct behaviour.
 */
async function streamTotalSize(url: string): Promise<number> {
  const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
  if (!res.ok) {
    throw new ZipError("http", `The server refused the download (HTTP ${res.status}).`);
  }
  const m = (res.headers.get("Content-Range") || "").match(/\/(\d+)\s*$/);
  const total = m ? parseInt(m[1], 10) : NaN;
  if (!Number.isFinite(total) || total < 22) {
    throw new ZipError("no-eocd", "Not a ZIP archive — the end-of-central-directory record was not found.");
  }
  return total;
}

/**
 * Open an archive for browsing — two precise stages, never a flat tail:
 * 1. fetch the EOCD window (last 64 KB; the whole file when smaller),
 * 2. read the EOCD's central-directory pointer and fetch EXACTLY that range
 *    (unless it already sits inside the window — small zips cost one request).
 * Refuses what v1 cannot honestly browse: ZIP64, encrypted, a CD that runs
 * past the end of the file, and indexes bigger than MAX_CD_BYTES.
 */
export async function openArchive(auth: Auth, file: PutFile): Promise<ZipModel> {
  const url = streamURL(auth, file.id);
  let size = typeof file.size === "number" && Number.isFinite(file.size) && file.size > 0 ? file.size : NaN;
  if (!Number.isFinite(size)) {
    size = await streamTotalSize(url); // a caller without a remembered size asks — never guess
  }

  // Stage 1: the EOCD window (a zip comment may push the 22-byte EOCD up to
  // 65 557 bytes back from the end, so 64 KB + slack is the guaranteed window).
  const probeStart = Math.max(0, size - EOCD_WINDOW);
  const probe = await rangeBytes(url, probeStart, size - 1);
  const hint = findEocdHint(probe);
  if (!hint) {
    throw new ZipError("no-eocd", "Not a ZIP archive — the end-of-central-directory record was not found.");
  }
  if (hint.zip64) {
    throw new ZipError("zip64", "This archive uses ZIP64 (very large) — browsing it isn't supported yet.");
  }

  // Stage 2: exactly the central directory the EOCD points at.
  const cdFitsProbe = hint.cdOffset >= probeStart && hint.cdOffset + hint.cdSize <= probeStart + probe.length;
  let model: ZipModel;
  if (cdFitsProbe) {
    model = parseZip(probe, probeStart);
  } else {
    if (hint.cdOffset + hint.cdSize > size) {
      throw new ZipError("no-eocd", "Not a ZIP archive — its central directory runs past the end of the file.");
    }
    if (hint.cdSize > MAX_CD_BYTES) {
      throw new ZipError("too-large", "This archive has too many entries to browse on the TV.");
    }
    const cd = await rangeBytes(url, hint.cdOffset, size - 1);
    model = parseZip(cd, hint.cdOffset); // cdOffset: the fetch's position in the file
  }

  if (model.entries.some((e) => e.encrypted)) {
    throw new ZipError("encrypted", "This archive is password-protected — PutPlay can't open it.");
  }
  return model;
}

/**
 * Extract ONE entry to bytes (and its mime). Refuses, in order, before any
 * network spend: encryption, unknown methods, the size cap — so a
 * 500-megabyte file never starts downloading.
 */
export async function extractEntry(auth: Auth, file: PutFile, e: ZipEntry): Promise<Extracted> {
  if (e.encrypted) throw new ZipError("encrypted", "This file inside the archive is password-protected.");
  if (e.method !== 0 && e.method !== 8) {
    throw new ZipError("bad-method", `"${e.name}" uses an unsupported compression (${e.method}).`);
  }
  if (e.size > MAX_EXTRACT_BYTES) {
    throw new ZipError("too-large", `"${e.name}" is too big to open here (the TV's memory isn't a hard drive).`);
  }

  const url = streamURL(auth, file.id);
  const header = await rangeBytes(url, e.offset, e.offset + 29);
  const dataStart = e.offset + localDataStart(header);
  const data = await rangeBytes(url, dataStart, dataStart + e.compressedSize - 1);
  if (data.length !== e.compressedSize) {
    throw new ZipError("bad-range", `The server sent the wrong byte range for ${e.name}.`);
  }
  const out = e.method === 8 ? inflateRaw(data) : data;
  if (out.length !== e.size) {
    throw new ZipError("bad-size", `${e.name} didn't decompress to the expected size.`);
  }
  return { data: out, mime: mimeFor(e.name) };
}
