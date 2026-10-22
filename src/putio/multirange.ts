/**
 * multipart/byteranges support for the Cues-driven row-1 batcher.
 *
 * The Put.io CDN (CDN77) answers a multi-valued `Range: bytes=a-b,c-d`
 * request with HTTP 206 + a multipart body — one part per requested range,
 * each part carrying its own `Content-Range: bytes a-b/TOTAL` header.
 * Batching the row-1 demuxer's ~500 sequential range reads into a handful
 * of these collapses ~3 min of TV-RTT wall time to ~1–2 s.
 *
 * CDN quirks handled here (all measured on the put.io CDN, 2026-10-21):
 *  - the response is LABELLED WITH THE FILE'S CONTENT TYPE
 *    (`video/x-matroska`), not `multipart/byteranges` → the boundary is
 *    detected from the body's first two lines when the header lacks one;
 *  - some edges IGNORE the multi-valued Range header and return the whole
 *    file → `multiRangeUsable` vets status/content-length BEFORE the body
 *    is downloaded, then the single-range fallback runs (never consuming
 *    the file);
 *  - the Range header value is capped at 8192 bytes on the CDN (8158 OK,
 *    8194 → 431) → requests are chunked to ≤ MAX_HEADER_BYTES of header.
 *
 * Both functions are PURE (bytes in, bytes out). The fetch + fallback glue
 * lives in media.ts (the only place that knows the stream URL).
 */

export interface ByteRangePart {
  /** the range's start offset (inclusive) */
  start: number;
  /** the range's end offset (inclusive) */
  end: number;
  /** the payload bytes (end - start + 1 long) */
  bytes: Uint8Array;
}

/**
 * `[[0,1023],[5000,6023]]` → `"bytes=0-1023,5000-6023"` (inclusive,
 * order-preserving — the caller owns dedup/overlap policy).
 */
export function buildRangeHeader(ranges: Array<[number, number]>): string {
  return "bytes=" + ranges.map(([s, e]) => `${s}-${e}`).join(",");
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

/** All start indices where `needle` occurs in `haystack` (non-overlapping). */
function findAll(haystack: Uint8Array, needle: Uint8Array): number[] {
  const out: number[] = [];
  if (!needle.length || haystack.length < needle.length) return out;
  let i = 0;
  outer: while (i <= haystack.length - needle.length) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        i++;
        continue outer;
      }
    }
    out.push(i);
    i += needle.length;
  }
  return out;
}

function extractBoundary(contentType: string): string | null {
  const m = contentType.match(/boundary="?([^";]+)"?/i);
  return m ? m[1] : null;
}

/**
 * Detect the multipart boundary from the body itself: the first line must
 * be `--<boundary>` and the second a `Content-Range: bytes …` header. The
 * Put.io CDN labels multipart replies with the file's content type
 * (`video/x-matroska`), so the header carries no boundary to extract.
 */
function detectBoundaryFromBody(buf: Uint8Array): string | null {
  const nl = findAll(buf, enc.encode("\n"));
  if (nl.length < 2) return null;
  let line1 = dec.decode(buf.subarray(0, nl[0]));
  while (line1.endsWith("\r")) line1 = line1.slice(0, -1);
  if (!line1.startsWith("--") || line1.length < 3) return null;
  let line2 = dec.decode(buf.subarray(nl[0] + 1, nl[1]));
  while (line2.endsWith("\r")) line2 = line2.slice(0, -1);
  return /^Content-Range:\s*bytes\s+\d+-\d+\s*\//i.test(line2) ? line1.slice(2) : null;
}

/**
 * Index just past the blank line that separates a part's headers from its
 * payload (CRLFCRLF first, LFLF as a fallback); -1 when the part has no
 * header block.
 */
function headerEnd(part: Uint8Array): number {
  const crlf = findAll(part, enc.encode("\r\n\r\n"))[0];
  if (crlf !== undefined) return crlf + 4;
  const lf = findAll(part, enc.encode("\n\n"))[0];
  if (lf !== undefined) return lf + 2;
  return -1;
}

/**
 * Parse a `multipart/byteranges` body into its parts, keyed by the
 * `Content-Range` each part declares (NOT by body position — the CDN may
 * return parts in any order). Returns [] for non-multipart responses
 * (a single-range 206, a plain 200, a 416).
 */
export function parseByteRanges(
  buf: Uint8Array,
  contentType: string
): ByteRangePart[] {
  const boundary = extractBoundary(contentType) ?? detectBoundaryFromBody(buf);
  if (!boundary) return [];
  const delim = enc.encode("--" + boundary);
  const positions = findAll(buf, delim);
  // N parts ⇒ N+1 delimiters (leading + N-1 interior + the `--` terminator);
  // a single-range multipart reply has exactly 2 delimiters.
  if (positions.length < 2) return [];
  const parts: ByteRangePart[] = [];
  for (let i = 0; i < positions.length - 1; i++) {
    let pStart = positions[i] + delim.length;
    // skip the line terminator after the boundary (CRLF or bare LF)
    if (buf[pStart] === 0x0d && buf[pStart + 1] === 0x0a) pStart += 2;
    else if (buf[pStart] === 0x0a) pStart += 1;
    // trim the line terminator preceding the next boundary
    let pEnd = positions[i + 1];
    if (buf[pEnd - 1] === 0x0a) {
      pEnd -= 1;
      if (pEnd > pStart && buf[pEnd - 1] === 0x0d) pEnd -= 1;
    }
    const sep = headerEnd(buf.subarray(pStart, pEnd));
    if (sep < 0) continue;
    const head = dec.decode(buf.subarray(pStart, pStart + sep));
    const m = head.match(/Content-Range:\s*bytes\s+(\d+)-(\d+)\s*\/\s*\d+/i);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    const payload = buf.subarray(pStart + sep, pEnd);
    if (payload.length !== end - start + 1) continue; // defensive: truncated part
    parts.push({ start, end, bytes: new Uint8Array(payload) });
  }
  return parts;
}

/**
 * Cap on the Range header's VALUE bytes. The put.io CDN answers 431 above
 * 8192 bytes (8158 OK / 8194 FAIL, measured 2026-10-21); 7000 leaves margin
 * for the "Range: " prefix and browser-added framing.
 */
export const MAX_HEADER_BYTES = 7000;

/**
 * Split ranges into chunks whose `buildRangeHeader` fits under `cap`.
 * Greedy, order-preserving; a single range always fits (worst case ~30
 * chars, far below any cap).
 */
export function chunkRanges(
  ranges: Array<[number, number]>,
  cap: number = MAX_HEADER_BYTES,
): Array<Array<[number, number]>> {
  const chunks: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  let len = 6; // "bytes="
  for (const r of ranges) {
    const rangeLen = `${r[0]}-${r[1]}`.length;
    if (cur.length > 0 && len + 1 + rangeLen > cap) {
      chunks.push(cur);
      cur = [];
      len = 6;
    }
    cur.push(r);
    len += rangeLen + (cur.length > 1 ? 1 : 0);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Vet a multi-range response BEFORE its body is downloaded. The put.io CDN
 * sometimes ignores the multi-valued Range header and returns the WHOLE
 * file — consuming that body would waste the entire file's bandwidth.
 * `fileSize` 0 = unknown → the guard is off and body sniffing decides.
 * A small single-range 206 (first range only) passes: it is cheap to
 * consume, and the missing-parts check triggers the fallback.
 */
export function multiRangeUsable(
  status: number,
  contentType: string,
  contentLength: number | null,
  requestedTotal: number,
  partCount: number,
  fileSize: number,
): boolean {
  if (status !== 206) return false;
  if (contentType.includes("multipart/byteranges")) return true;
  if (fileSize === 0 || contentLength === null) return true; // sniff decides
  if (contentLength >= fileSize) return false; // the whole file came back
  // multipart overhead budget: ~140 B per part (measured 137.8) + 1 KB slack
  return contentLength <= requestedTotal + partCount * 300 + 1024;
}

/**
 * The row-1 batcher's readRanges transport: serves many ranges in multipart
 * round trips (chunked to MAX_HEADER_BYTES of Range header per request),
 * transparently falling back to the single-range reader whenever the server
 * does not honour multi-range (non-2xx, a whole-file response, or a missing
 * part). Returns one byte string per requested range, in request order.
 */
export function multiRangeReader(
  url: string,
  single: (start: number, end: number) => Promise<Uint8Array>,
  fileSize = 0,
): (ranges: Array<[number, number]>) => Promise<Uint8Array[]> {
  const fallback = (chunk: Array<[number, number]>): Promise<Uint8Array[]> =>
    Promise.all(chunk.map(([s, e]) => single(s, e)));

  const fetchChunk = async (chunk: Array<[number, number]>): Promise<Uint8Array[]> => {
    const requestedTotal = chunk.reduce((n, [s, e]) => n + (e - s + 1), 0);
    const byStart = new Map<number, Uint8Array>();
    let status = 0;
    let ctype = "";
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers: { Range: buildRangeHeader(chunk) } });
      status = res.status;
      ctype = res.headers.get("content-type") ?? "";
      const cl = res.headers.get("content-length");
      if (
        multiRangeUsable(
          res.status,
          ctype,
          cl === null ? null : Number(cl),
          requestedTotal,
          chunk.length,
          fileSize,
        )
      ) {
        for (const p of parseByteRanges(new Uint8Array(await res.arrayBuffer()), ctype)) {
          if (!byStart.has(p.start)) byStart.set(p.start, p.bytes);
        }
      } else {
        // whole-file (or other unusable) response: do NOT download the body
        try {
          await res.body?.cancel();
        } catch {
          /* body already consumed */
        }
      }
    } catch {
      // network failure on the multipart attempt → sequential fallback below
    }
    if (!chunk.every(([s]) => byStart.has(s))) {
      // TEMP-DIAG (remove after the on-device check)
      console.log(
        "[rawass] multi-range FALLBACK:",
        chunk.length,
        "ranges; status=",
        status,
        "ctype=",
        ctype || "(none)",
        "got=",
        byStart.size,
      );
      return fallback(chunk);
    }
    // TEMP-DIAG (remove after the on-device check)
    console.log("[rawass] multi-range OK:", chunk.length, "ranges in", Date.now() - t0, "ms");
    return chunk.map(([s]) => byStart.get(s)!);
  };

  return async (ranges) => {
    const out: Uint8Array[] = new Array(ranges.length);
    let i = 0;
    for (const chunk of chunkRanges(ranges)) {
      const got = await fetchChunk(chunk);
      for (let k = 0; k < chunk.length; k++) out[i + k] = got[k];
      i += chunk.length;
    }
    return out;
  };
}
