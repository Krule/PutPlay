// The multipart/byteranges reader for the Cues-driven row-1 batcher.
//
// The Put.io CDN (CDN77) answers a single GET with a multi-valued
// `Range: bytes=a-b,c-d` header with HTTP 206 and a `multipart/byteranges`
// body — one part per requested range, each part carrying its own
// `Content-Range: bytes a-b/TOTAL` header. Verified on-device against the
// real stream (curl --http2, 2026-10-21). This collapses the row-1
// demuxer's ~500 sequential 12 B / 1 KB range reads (≈3 min at TV RTT)
// into a handful of batched requests.
//
// Both functions here are PURE (bytes in, bytes out) so they are unit-tested
// against synthetic bodies, as is the fetch + fallback glue (multiRangeReader).

import { test, assert, vi } from "vitest";
import {
  buildRangeHeader,
  parseByteRanges,
  multiRangeReader,
  multiRangeUsable,
  chunkRanges,
  MAX_HEADER_BYTES,
} from "../src/putio/multirange.ts";

const enc = (s) => new TextEncoder().encode(s);

/** Concatenate an array of (Uint8Array | string) into one Uint8Array. */
function bytesOf(...parts) {
  const bufs = parts.map((p) => (typeof p === "string" ? enc(p) : p));
  const total = bufs.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of bufs) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

/** Build a minimal valid multipart/byteranges body (CRLF line endings). */
function multipart(boundary, parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(enc(`--${boundary}\r\n`));
    chunks.push(enc(`Content-Range: bytes ${p.start}-${p.end}/${p.total}\r\n`));
    chunks.push(enc("Content-Type: video/webm\r\n"));
    chunks.push(enc("\r\n"));
    chunks.push(p.data); // raw binary payload
    chunks.push(enc("\r\n"));
  }
  chunks.push(enc(`--${boundary}--\r\n`));
  return bytesOf(...chunks);
}

// ---------------- buildRangeHeader ----------------

test("buildRangeHeader: single range", () => {
  assert.equal(buildRangeHeader([[5, 9]]), "bytes=5-9");
});

test("buildRangeHeader: multiple ranges, inclusive, order-preserving", () => {
  assert.equal(buildRangeHeader([[0, 1023], [5000, 6023]]), "bytes=0-1023,5000-6023");
});

test("buildRangeHeader: many ranges", () => {
  assert.equal(buildRangeHeader([[0, 11], [100, 111], [200, 211]]), "bytes=0-11,100-111,200-211");
});

// ---------------- parseByteRanges ----------------

test("parseByteRanges: two parts, exact bytes and Content-Range", () => {
  const body = multipart("TESTBND", [
    { start: 0, end: 3, total: 100, data: bytesOf([1, 2, 3, 4]) },
    { start: 10, end: 13, total: 100, data: bytesOf([10, 11, 12, 13]) },
  ]);
  const parts = parseByteRanges(body, "multipart/byteranges; boundary=TESTBND");
  assert.equal(parts.length, 2);
  assert.equal(parts[0].start, 0);
  assert.equal(parts[0].end, 3);
  assert.deepEqual([...parts[0].bytes], [1, 2, 3, 4]);
  assert.equal(parts[1].start, 10);
  assert.equal(parts[1].end, 13);
  assert.deepEqual([...parts[1].bytes], [10, 11, 12, 13]);
});

test("parseByteRanges: payload bytes are exact (length matches the range)", () => {
  const data = bytesOf([0, 1, 2, 3, 4, 5, 6, 7]); // 8 bytes
  const body = multipart("B", [{ start: 100, end: 107, total: 1000, data }]);
  const parts = parseByteRanges(body, "multipart/byteranges; boundary=B");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].bytes.length, 8);
  assert.deepEqual([...parts[0].bytes], [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("parseByteRanges: payload containing CRLF is not mis-split", () => {
  // A block window can contain 0x0d 0x0a bytes; the part boundary is the
  // unique `--boundary` marker, and the header/payload split is the FIRST
  // blank line, so an embedded CRLF in the payload must survive.
  const data = bytesOf([0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x0a, 0x43]); // "A\r\nB\r\nC"
  const body = multipart("BND2", [{ start: 0, end: 6, total: 50, data }]);
  const parts = parseByteRanges(body, 'multipart/byteranges; boundary="BND2"');
  assert.equal(parts.length, 1);
  assert.deepEqual([...parts[0].bytes], [0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x0a, 0x43]);
});

test("parseByteRanges: quoted boundary in Content-Type", () => {
  const body = multipart("Q1", [{ start: 0, end: 1, total: 9, data: bytesOf([9, 9]) }]);
  const parts = parseByteRanges(body, 'multipart/byteranges; boundary="Q1"');
  assert.equal(parts.length, 1);
  assert.deepEqual([...parts[0].bytes], [9, 9]);
});

test("parseByteRanges: parts are matched by Content-Range, not body order", () => {
  // The CDN may return parts in any order; the caller maps by `start`.
  const body = multipart("ORD", [
    { start: 100, end: 101, total: 1000, data: bytesOf([0xaa, 0xbb]) },
    { start: 0, end: 1, total: 1000, data: bytesOf([0x01, 0x02]) },
  ]);
  const parts = parseByteRanges(body, "multipart/byteranges; boundary=ORD");
  assert.equal(parts.length, 2);
  const byStart = new Map(parts.map((p) => [p.start, p]));
  assert.deepEqual([...byStart.get(0).bytes], [0x01, 0x02]);
  assert.deepEqual([...byStart.get(100).bytes], [0xaa, 0xbb]);
});

test("parseByteRanges: no boundary in Content-Type → empty", () => {
  assert.deepEqual(parseByteRanges(bytesOf("whatever"), "video/x-matroska"), []);
});

test("parseByteRanges: single-range 206 (not multipart) → empty", () => {
  // A bare `Content-Range` with a `video/*` Content-Type is a single-range
  // response, not multipart — the parser must not invent parts.
  const body = bytesOf("hello");
  assert.deepEqual(parseByteRanges(body, "video/x-matroska"), []);
});

// ---------------- multiRangeReader (fetch glue + fallback) ----------------
//
// The demuxer's `readRanges` transport: one multipart/byteranges request per
// ≤ MAX_RANGES_PER_REQUEST ranges, transparently falling back to the
// single-range reader whenever the server does not honour multi-range.

function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, range: init && init.headers ? init.headers.Range : null });
    return responder(calls.length, init);
  };
  return { calls, fn };
}

const response = (body, contentType, ok = true, status = 200) => ({
  ok,
  status,
  headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
  arrayBuffer: async () => body.slice().buffer,
});

/** Marker payload for [s, e]: every byte = s % 251 (proves which part came back). */
const marker = (s, e) => {
  const out = new Uint8Array(e - s + 1);
  out.fill(s % 251);
  return out;
};

test("multiRangeReader: one multipart response serves every range in one fetch", async () => {
  const body = multipart("B", [
    { start: 0, end: 1023, total: 9999, data: marker(0, 1023) },
    { start: 5000, end: 6023, total: 9999, data: marker(5000, 6023) },
  ]);
  const { calls, fn } = mockFetch(() => response(body, "multipart/byteranges; boundary=B", true, 206));
  vi.stubGlobal("fetch", fn);
  try {
    const singleCalls = [];
    const single = async (s, e) => {
      singleCalls.push([s, e]);
      return marker(s, e);
    };
    const parts = await multiRangeReader("https://cdn/stream", single)([[0, 1023], [5000, 6023]]);
    assert.equal(calls.length, 1, "one fetch");
    assert.equal(calls[0].range, "bytes=0-1023,5000-6023");
    assert.equal(parts.length, 2);
    assert.equal(parts[0].length, 1024);
    assert.equal(parts[0][0], 0);
    assert.equal(parts[1].length, 1024);
    assert.equal(parts[1][0], 5000 % 251);
    assert.equal(singleCalls.length, 0, "no fallback when the multipart is complete");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("multiRangeReader: large sets are chunked by HEADER SIZE, results stay in order", async () => {
  const ranges = Array.from({ length: 300 }, (_, i) => [i * 100, i * 100 + 99]);
  const { calls, fn } = mockFetch((_n, init) => {
    const req = init.headers.Range.slice("bytes=".length).split(",").map((r) => {
      const [a, b] = r.split("-").map(Number);
      return { start: a, end: b, total: 999999, data: marker(a, b) };
    });
    return response(multipart("B", req), "multipart/byteranges; boundary=B", true, 206);
  });
  vi.stubGlobal("fetch", fn);
  try {
    let singleCalls = 0;
    const rr = multiRangeReader("https://cdn/stream", async (s, e) => {
      singleCalls += 1;
      return marker(s, e);
    });
    const parts = await rr(ranges);
    // 300 ranges × 14 header chars + 6 = 4,206 B → ONE fetch under the 7 KB cap
    assert.equal(calls.length, 1, `300 ranges fit ${MAX_HEADER_BYTES} B of header → 1 fetch`);
    assert.equal(calls[0].range.split(",").length, 300);
    assert.equal(singleCalls, 0);
    assert.equal(parts.length, 300);
    for (let i = 0; i < 300; i++) {
      const [s, e] = ranges[i];
      assert.equal(parts[i].length, e - s + 1);
      assert.equal(parts[i][0], s % 251, `part ${i} must come from range start ${s}`);
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

test("multiRangeReader: a non-multipart 206 falls back to the single-range reader", async () => {
  const { calls, fn } = mockFetch(() => response(marker(0, 1023), "video/webm", true, 206));
  vi.stubGlobal("fetch", fn);
  try {
    const singleCalls = [];
    const rr = multiRangeReader("https://cdn/stream", async (s, e) => {
      singleCalls.push([s, e]);
      return marker(s, e);
    });
    const parts = await rr([[0, 1023], [5000, 6023]]);
    assert.equal(calls.length, 1, "one multipart attempt, then fallback");
    assert.deepEqual(singleCalls, [[0, 1023], [5000, 6023]]);
    assert.equal(parts[1][0], 5000 % 251);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("multiRangeReader: a multipart response missing one part falls back for everything", async () => {
  const body = multipart("B", [{ start: 0, end: 1023, total: 9999, data: marker(0, 1023) }]);
  const { calls, fn } = mockFetch(() => response(body, "multipart/byteranges; boundary=B", true, 206));
  vi.stubGlobal("fetch", fn);
  try {
    const singleCalls = [];
    const rr = multiRangeReader("https://cdn/stream", async (s, e) => {
      singleCalls.push([s, e]);
      return marker(s, e);
    });
    const parts = await rr([[0, 1023], [5000, 6023]]);
    assert.equal(calls.length, 1);
    assert.deepEqual(singleCalls, [[0, 1023], [5000, 6023]], "no mixing: the whole chunk retries sequentially");
    assert.equal(parts[0][0], 0);
    assert.equal(parts[1][0], 5000 % 251);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("multiRangeReader: a non-2xx multi-range response falls back instead of throwing", async () => {
  const { calls, fn } = mockFetch(() => response(new Uint8Array(0), "text/plain", false, 500));
  vi.stubGlobal("fetch", fn);
  try {
    const singleCalls = [];
    const rr = multiRangeReader("https://cdn/stream", async (s, e) => {
      singleCalls.push([s, e]);
      return marker(s, e);
    });
    const parts = await rr([[0, 1023], [5000, 6023]]);
    assert.equal(calls.length, 1);
    assert.deepEqual(singleCalls, [[0, 1023], [5000, 6023]]);
    assert.equal(parts[1].length, 1024);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("multiRangeReader: throws when the fallback reader fails", async () => {
  const { fn } = mockFetch(() => response(new Uint8Array(0), "text/plain", false, 500));
  vi.stubGlobal("fetch", fn);
  try {
    const rr = multiRangeReader("https://cdn/stream", async () => {
      throw new Error("nope");
    });
    let threw = null;
    try {
      await rr([[0, 9]]);
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, "must reject when the fallback reader fails");
    assert.match(String(threw && threw.message), /nope/);
  } finally {
    vi.unstubAllGlobals();
  }
});

// ---------------- the Put.io-CDN quirks (measured 2026-10-21/22) ----------------
//
// (a) multipart bodies labelled with the FILE's own content-type — the
//     boundary must be recovered from the body, not the header;
// (b) some edges ignore a multi-valued Range and stream the WHOLE file —
//     detectable before the body is read (status / Content-Length), and
//     must never be consumed (218 MB per batch attempt);
// (c) the Range header is limited to ~8 KB — chunk by header bytes, not count.

const dec = new TextDecoder();

/** Multipart body whose Content-Type header does NOT carry the boundary. */
function mislabeledMultipart(parts) {
  return {
    body: multipart("83c9cc6eeea5beff2f68ffe95b18c2c5473cd73e", parts),
    contentType: "video/x-matroska",
  };
}

function response2(body, contentType, { ok = true, status = 200, contentLength = null } = {}) {
  const hdrs = {};
  if (contentType !== null) hdrs["content-type"] = contentType;
  if (contentLength !== null) hdrs["content-length"] = String(contentLength);
  return {
    ok,
    status,
    headers: { get: (k) => hdrs[k.toLowerCase()] ?? null },
    arrayBuffer: async () => body.slice().buffer,
    body: { cancel: async () => {} },
  };
}

test("parseByteRanges: boundary is sniffed from the body when the header mislabels it", () => {
  const { body, contentType } = mislabeledMultipart([
    { start: 0, end: 3, total: 100, data: bytesOf([1, 2, 3, 4]) },
    { start: 10, end: 13, total: 100, data: bytesOf([10, 11, 12, 13]) },
  ]);
  const parts = parseByteRanges(body, contentType);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].start, 0);
  assert.deepEqual([...parts[0].bytes], [1, 2, 3, 4]);
  assert.equal(parts[1].start, 10);
  assert.deepEqual([...parts[1].bytes], [10, 11, 12, 13]);
});

test("parseByteRanges: body that merely starts with '--' but has no Content-Range line → empty", () => {
  // The sniff must verify the line AFTER the boundary marker, not just the prefix.
  const body = bytesOf("--NOTABND\r\r\nwhatever");
  assert.deepEqual(parseByteRanges(body, "video/x-matroska"), []);
});

// ---------------- multiRangeUsable (the whole-file guard) ----------------

test("multiRangeUsable: spec-compliant multipart 206 → usable", () => {
  assert.equal(multiRangeUsable(206, "multipart/byteranges; boundary=B", 5000, 2048, 2, 1_000_000), true);
});

test("multiRangeUsable: whole-file response (CL >= fileSize) → never consume", () => {
  assert.equal(multiRangeUsable(206, "video/x-matroska", 218_005_732, 132_608, 128, 218_005_732), false);
  assert.equal(multiRangeUsable(206, "video/x-matroska", null, 132_608, 128, 0), true, "fileSize 0 = unknown → guard off, sniffing decides");
});

test("multiRangeUsable: first-range-only 206 (small CL) → usable (sniffing will find 0 parts → fallback)", () => {
  assert.equal(multiRangeUsable(206, "video/x-matroska", 1036, 132_608, 128, 218_005_732), true);
});

test("multiRangeUsable: oversized but plausible multipart (CL within overhead budget) → usable", () => {
  // 128 parts × (1036 payload + ~138 measured overhead) ≈ 150 KB
  assert.equal(multiRangeUsable(206, "video/x-matroska", 150_000, 132_608, 128, 218_005_732), true);
  assert.equal(multiRangeUsable(206, "video/x-matroska", 999_999, 132_608, 128, 218_005_732), false, "well above overhead budget → suspicious");
});

test("multiRangeUsable: non-206 → never usable", () => {
  assert.equal(multiRangeUsable(200, "video/x-matroska", 218_005_732, 132_608, 128, 218_005_732), false);
  assert.equal(multiRangeUsable(500, "text/plain", null, 20, 1, 1000), false);
});

// ---------------- chunkRanges (header-size chunking) ----------------

test("chunkRanges: sizes chunks so the Range header stays under the cap", () => {
  const ranges = Array.from({ length: 700 }, (_, i) => [1_000_000 + i, 1_000_000 + i + 9]);
  const chunks = chunkRanges(ranges);
  const sizes = chunks.map((c) => c.length);
  const cap = Math.floor((MAX_HEADER_BYTES - 6) / 16); // "1000000-1000009,"
  assert.equal(sizes[0], cap, "first chunk fills the header to the cap");
  assert.equal(chunks.reduce((n, c) => n + c.length, 0), 700);
  assert.ok(buildRangeHeader(chunks[0]).length <= MAX_HEADER_BYTES);
  for (const c of chunks) assert.ok(buildRangeHeader(c).length <= MAX_HEADER_BYTES);
  // order-preserving flattening
  assert.deepEqual(chunks.flat(), ranges);
});

test("chunkRanges: empty → empty; a single 11-digit-offset range always fits in one chunk", () => {
  assert.deepEqual(chunkRanges([]), []);
  assert.deepEqual(chunkRanges([[100_000_000_000, 100_000_000_127]]), [[[100_000_000_000, 100_000_000_127]]]);
});

test("multiRangeReader: a mislabelled multipart body (boundary only in the body) is parsed, not fallen back", async () => {
  const { body, contentType } = mislabeledMultipart([
    { start: 0, end: 1023, total: 999999, data: marker(0, 1023) },
    { start: 5000, end: 6023, total: 999999, data: marker(5000, 6023) },
  ]);
  const { calls, fn } = mockFetch(() =>
    response2(body, contentType, { status: 206, contentLength: body.length }),
  );
  vi.stubGlobal("fetch", fn);
  try {
    let singleCalls = 0;
    const rr = multiRangeReader("https://cdn/stream", async (s, e) => {
      singleCalls += 1;
      return marker(s, e);
    });
    const parts = await rr([[0, 1023], [5000, 6023]]);
    assert.equal(calls.length, 1);
    assert.equal(singleCalls, 0, "body-boundary sniffing must accept the mislabelled multipart");
    assert.equal(parts[0].length, 1024);
    assert.equal(parts[0][0], 0);
    assert.equal(parts[1][0], 5000 % 251);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("multiRangeReader: a whole-file response is NOT consumed (body.cancel) and falls back", async () => {
  let cancelled = false;
  const fullFile = new Uint8Array(1_000_000);
  const res = {
    ok: true,
    status: 206,
    headers: {
      get: (k) =>
        k.toLowerCase() === "content-type"
          ? "video/x-matroska"
          : k.toLowerCase() === "content-length"
            ? String(fullFile.length)
            : null,
    },
    arrayBuffer: async () => {
      throw new Error("must not download the whole file");
    },
    body: { cancel: async () => { cancelled = true; } },
  };
  const { calls, fn } = mockFetch(() => res);
  vi.stubGlobal("fetch", fn);
  try {
    const singleCalls = [];
    const rr = multiRangeReader("https://cdn/stream", async (s, e) => {
      singleCalls.push([s, e]);
      return marker(s, e);
    }, 1_000_000);
    const parts = await rr([[0, 1023], [5000, 6023]]);
    assert.equal(calls.length, 1);
    assert.equal(cancelled, true, "the whole-file body must be cancelled, not read");
    assert.deepEqual(singleCalls, [[0, 1023], [5000, 6023]]);
    assert.equal(parts[1][0], 5000 % 251);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("multiRangeReader: zero ranges → zero fetches", async () => {
  const { calls, fn } = mockFetch(() => response(new Uint8Array(0), "video/webm", true, 206));
  vi.stubGlobal("fetch", fn);
  try {
    const parts = await multiRangeReader("https://cdn/stream", async () => new Uint8Array(0))([]);
    assert.deepEqual(parts, []);
    assert.equal(calls.length, 0);
  } finally {
    vi.unstubAllGlobals();
  }
});
