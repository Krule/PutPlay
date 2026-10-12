/**
 * ZIP extract layer — the async side of the pure parser (zip.ts).
 *
 * Listing costs ONE Range request (the file's tail). Opening a file costs
 * two small ones: the 30-byte local header (its name/extra lengths decide
 * where the data starts — they can differ from the central directory's),
 * then exactly the entry's bytes. Deflated entries inflate with pako
 * (Chromium 79 has no DecompressionStream).
 *
 * Everything that is not provably openable is refused by name: ZIP64,
 * password-protected archives, unknown compression methods, and entries
 * above the size cap (the TV's webview memory is not a hard drive).
 */
import { inflateRaw } from "pako";
import { streamURL, type Auth } from "./api";
import {
  parseZip,
  localDataStart,
  ZipError,
  type ZipModel,
  type ZipEntry,
} from "./zip";
import type { PutFile } from "./types";

/** How much of the tail we fetch for the EOCD + central directory. */
export const TAIL_BYTES = 256 * 1024;
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
 * Open an archive for browsing: fetch the tail, parse it, and refuse the
 * archives v1 cannot honestly browse (ZIP64, encrypted, multi-disk — the
 * parser already rejects the last).
 */
export async function openArchive(auth: Auth, file: PutFile): Promise<ZipModel> {
  const url = streamURL(auth, file.id);
  const start = Math.max(0, file.size - TAIL_BYTES);
  const tail = await rangeBytes(url, start, Math.max(0, file.size - 1));
  const model = parseZip(tail);
  if (model.zip64) {
    throw new ZipError("zip64", "This archive uses ZIP64 (very large) — browsing it isn't supported yet.");
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
