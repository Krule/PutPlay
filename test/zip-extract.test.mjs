// ZIP extract layer (archive viewer v1) — the async side of the parser.
//
// zip.ts proves the bytes are a sane ZIP from the TAIL alone. This module
// turns that into real data on a network file:
//   1. openArchive: ONE Range request for the tail (the EOCD + central
//      directory), parse, and refuse honestly — ZIP64, multi-disk, and
//      password-protected archives are named, not guessed at.
//   2. extractEntry: two small Range reads (the 30-byte local header, then
//      exactly the entry's data — the local name/extra lengths decide where
//      the data starts), a hard size cap, and pako for deflated entries
//      (Chromium 79 has no DecompressionStream).
//
// The fake fetch below is Range-capable and records every range requested —
// the tests assert the network behaviour, not just the bytes.
//
// Run: npm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "zipextract-"));
await build({
  entryPoints: [join(here, "..", "src/putio/zip-extract.ts")],
  bundle: true,
  format: "cjs",
  target: "es2019",
  outfile: join(dir, "bundle.cjs"),
});
const req = createRequire(import.meta.url);
const zx = req(join(dir, "bundle.cjs"));

/* ---------------- build a real zip in memory ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = -1;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function makeZip(entries) {
  // entries: [{ name, data (Uint8Array), method: 0|8 }]
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data =
      e.method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(e.data))) : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (2020-01-02)
    local.writeUInt32LE(crc32(e.data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no local extra
    chunks.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8); // UTF-8 flag
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc32(e.data), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // no cd extra
    cd.writeUInt16LE(0, 32); // no comment
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, cdBuf, eocd]));
}

/* ---------------- the Range-capable fake fetch ---------------- */
function rangeFetch(fileBytes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const range = (opts.headers && opts.headers.Range) || "";
    const m = range.match(/^bytes=(\d+)-(\d+)$/);
    calls.push({ url, range });
    if (!m) {
      return new Response(fileBytes, { status: 200, headers: { "Content-Length": String(fileBytes.length) } });
    }
    const start = parseInt(m[1], 10);
    const end = Math.min(parseInt(m[2], 10), fileBytes.length - 1);
    return new Response(fileBytes.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${fileBytes.length}`,
        "Content-Length": String(end - start + 1),
      },
    });
  };
  return { fetchImpl, calls };
}

const AUTH = { oauthToken: "t", downloadToken: "d" };
const FILE = { id: 15, name: "archive.zip", size: 0, content_type: "application/zip" };

const PAYLOAD = new Uint8Array(Buffer.from("deflated page pixels 0123456789", "utf8"));
const STORED = new Uint8Array(Buffer.from("plain stored text\n", "utf8"));
const zipBytes = makeZip([
  { name: "pages/p1.png", data: PAYLOAD, method: 8 },
  { name: "notes.txt", data: STORED, method: 0 },
]);
FILE.size = zipBytes.length;

function withFetch(impl) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  return () => (globalThis.fetch = prev);
}

/* ---------------- openArchive ---------------- */
test("openArchive: one Range read of the tail lists the entries", async () => {
  const rf = rangeFetch(zipBytes);
  const restore = withFetch(rf.fetchImpl);
  try {
    const model = await zx.openArchive(AUTH, FILE);
    assert.deepEqual(
      model.entries.map((e) => e.name),
      ["pages/p1.png", "notes.txt"]  // central-directory order — sorting is archiveView's job
    );
    assert.equal(rf.calls.length, 1, "listing must cost exactly one range request");
    assert.ok(rf.calls[0].range.startsWith("bytes="), "the request must be a Range request");
    const [start] = rf.calls[0].range.slice(6).split("-");
    assert.ok(start < zipBytes.length, "the tail starts before the end of the file");
  } finally {
    restore();
  }
});

test("openArchive: a non-zip file is an honest ZipError", async () => {
  const rf = rangeFetch(new Uint8Array(Buffer.from("not a zip at all, just some bytes")));
  const restore = withFetch(rf.fetchImpl);
  try {
    await assert.rejects(zx.openArchive(AUTH, FILE), (e) => e.name === "ZipError");
  } finally {
    restore();
  }
});

test("openArchive: a file without a remembered size probes the total, then reads the real tail", async () => {
  // The continue-reading shelf reopens a comic from {id, name} alone — the
  // reader only remembers what it read, not the file size. The total comes
  // from the server's Content-Range, never from a guess.
  const rf = rangeFetch(zipBytes);
  const restore = withFetch(rf.fetchImpl);
  try {
    const sizeless = { id: 15, name: "story.cbz" }; // no .size on purpose
    const model = await zx.openArchive(AUTH, sizeless);
    assert.deepEqual(
      model.entries.map((e) => e.name),
      ["pages/p1.png", "notes.txt"],
      "the entries come back fully parsed"
    );
    const ranges = rf.calls.map((c) => c.range);
    assert.ok(ranges.length >= 2, "probe + tail, at least");
    const last = ranges[ranges.length - 1].match(/^bytes=(\d+)-(\d+)$/);
    assert.ok(last, "the tail request is a real byte range (no NaN)");
    assert.equal(
      parseInt(last[2], 10),
      zipBytes.length - 1,
      "…and it ends at the file's TRUE last byte, not a remembered one"
    );
  } finally {
    restore();
  }
});

test("openArchive + extractEntry: a file bigger than the tail lists AND extracts (real-TV regression)", async () => {
  // The C1 said every comic was "Not a ZIP archive": openArchive fetched the
  // tail but parseZip compared the CD's FILE-space offset against the
  // tail-local scan position. Pad the zip past 256 KB (with every internal
  // pointer shifted, so it stays a valid archive) so file space != tail
  // space — the listing AND an extraction must both come back correct.
  const bigFile = shiftZipForPadding(zipBytes, 300 * 1024);
  const rf = rangeFetch(bigFile);
  const restore = withFetch(rf.fetchImpl);
  const BIG = { id: 15, name: "big.zip", size: bigFile.length };
  try {
    const model = await zx.openArchive(AUTH, BIG);
    assert.deepEqual(
      model.entries.map((e) => e.name),
      ["pages/p1.png", "notes.txt"],
      "a >256KB archive must list from its tail"
    );
    assert.ok(
      model.entries.every((e) => e.offset >= 300 * 1024),
      "local header offsets are FILE space (the padding is in front of the data)"
    );
    const stored = model.entries.find((e) => e.name === "notes.txt");
    const out = await zx.extractEntry(AUTH, BIG, stored);
    assert.equal(Buffer.from(out.data).toString("utf8"), "plain stored text\n");
  } finally {
    restore();
  }
});

/* ---------------- two-stage tail: probe the EOCD, fetch the CD exactly ----
 * The EOCD is 22 bytes, but a zip comment may push it up to 65 557 bytes
 * back from the end — so stage 1 fetches a 64KB window (guaranteed to hold
 * it), reads the CD pointer, and stage 2 fetches EXACTLY the central
 * directory. A flat 256KB tail was blunt (wasted bandwidth) and dishonest
 * (a zip whose index exceeds 256KB was refused as "not a ZIP").
 */
test("openArchive: a big file with a small index costs ONE 64KB request (not a flat 256KB tail)", async () => {
  // The CD always sits directly in front of the EOCD (zip layout), so any
  // index under 64 KB already sits inside the probe window — stage 2 is
  // skipped and the whole listing costs one small request.
  const bigFile = shiftZipForPadding(zipBytes, 300 * 1024);
  const rf = rangeFetch(bigFile);
  const restore = withFetch(rf.fetchImpl);
  try {
    const model = await zx.openArchive(AUTH, { id: 15, name: "big.zip", size: bigFile.length });
    assert.equal(model.entries.length, 2);
    assert.equal(rf.calls.length, 1, "probe window only — the CD fit inside it");
    const [probe] = rf.calls.map((c) => c.range.match(/^bytes=(\d+)-(\d+)$/));
    assert.equal(+probe[2], bigFile.length - 1, "the probe ends at the file end");
    const probeLen = +probe[2] - +probe[1] + 1;
    assert.ok(probeLen <= 65600, `one 64KB window (${probeLen}B), not a 256KB tail`);
    assert.ok(probeLen < 100 * 1024, "less than half the old flat fetch");
  } finally {
    restore();
  }
});

test("openArchive: a zip whose index is bigger than the probe window costs probe + exact CD (and still lists)", async () => {
  // 8000 tiny entries => a ~432KB central directory: the old 256KB tail
  // could not hold it and the only valid EOCD was rejected as "not a ZIP".
  // Two stages: the 64KB window finds the EOCD, then exactly the CD.
  const many = [];
  for (let i = 0; i < 8000; i++) {
    many.push({ name: "f" + String(i).padStart(5, "0") + ".txt", data: new Uint8Array(Buffer.from("x")), method: 0 });
  }
  const manyZip = makeZip(many);
  const rf = rangeFetch(manyZip);
  const restore = withFetch(rf.fetchImpl);
  try {
    const model = await zx.openArchive(AUTH, { id: 15, name: "many.zip", size: manyZip.length });
    assert.equal(model.entries.length, 8000, "every entry of a huge index is listed");
    assert.ok(!model.zip64);
    const ranges = rf.calls.map((c) => c.range.match(/^bytes=(\d+)-(\d+)$/));
    assert.equal(ranges.length, 2, "probe + precise CD — no third request");
    const [probe, cd] = ranges;
    assert.ok(+probe[2] - +probe[1] + 1 <= 65600, "stage 1 is the EOCD window");
    assert.ok(+cd[1] < +probe[1], "stage 2 starts BEFORE the window (the CD is bigger than the window)");
    assert.equal(+cd[2], manyZip.length - 1, "…and ends at the file end");
  } finally {
    restore();
  }
});

function shiftZipForPadding(bytes, padLen) {
  // A VALID big zip: `bytes` at the end of padLen filler, with every
  // internal pointer (EOCD cdOffset + each CD entry's local header offset)
  // shifted by padLen — as if the archive had a big chunk before its CD.
  const shifted = new Uint8Array(bytes);
  const dv = new DataView(shifted.buffer, shifted.byteOffset, shifted.byteLength);
  const eocd = shifted.length - 22; // makeZip writes no zip comment
  const cdOff = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  for (let i = 0, off = cdOff; i < count; i++, off += 46 + dv.getUint16(off + 28, true) + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true)) {
    dv.setUint32(off + 42, dv.getUint32(off + 42, true) + padLen, true);
  }
  dv.setUint32(eocd + 16, cdOff + padLen, true);
  const file = new Uint8Array(padLen + shifted.length);
  file.fill(0xaa, 0, padLen);
  file.set(shifted, padLen);
  return file;
}

/* ---------------- extractEntry ---------------- */
async function openAndFind(rf, name) {
  const restore = withFetch(rf.fetchImpl);
  try {
    const model = await zx.openArchive(AUTH, FILE);
    const entry = model.entries.find((e) => e.name === name);
    return { restore, entry };
  } catch (e) {
    restore();
    throw e;
  }
}

test("extractEntry: a deflated entry inflates byte-exact", async () => {
  const rf = rangeFetch(zipBytes);
  const { restore, entry } = await openAndFind(rf, "pages/p1.png");
  const before = rf.calls.length;
  try {
    const out = await zx.extractEntry(AUTH, FILE, entry);
    assert.equal(Buffer.from(out.data).toString("utf8"), Buffer.from(PAYLOAD).toString("utf8"));
    // exactly two range reads: the local header, then the compressed data
    assert.equal(rf.calls.length - before, 2, "header read + data read, nothing more");
  } finally {
    restore();
  }
});

test("extractEntry: a stored entry comes back raw", async () => {
  const rf = rangeFetch(zipBytes);
  const { restore, entry } = await openAndFind(rf, "notes.txt");
  try {
    const out = await zx.extractEntry(AUTH, FILE, entry);
    assert.equal(Buffer.from(out.data).toString("utf8"), "plain stored text\n");
  } finally {
    restore();
  }
});

test("extractEntry: the size cap refuses before spending the download", async () => {
  const rf = rangeFetch(zipBytes);
  const { restore, entry } = await openAndFind(rf, "notes.txt");
  try {
    const huge = { ...entry, size: zx.MAX_EXTRACT_BYTES + 1 };
    const before = rf.calls.length;
    await assert.rejects(zx.extractEntry(AUTH, FILE, huge), (e) => e.name === "ZipError");
    assert.equal(rf.calls.length, before, "no data request may go out for an over-cap entry");
  } finally {
    restore();
  }
});

test("extractEntry: unknown methods and encrypted entries are refused", async () => {
  const rf = rangeFetch(zipBytes);
  const { restore, entry } = await openAndFind(rf, "notes.txt");
  try {
    await assert.rejects(zx.extractEntry(AUTH, FILE, { ...entry, method: 9 }), (e) => e.name === "ZipError");
    await assert.rejects(zx.extractEntry(AUTH, FILE, { ...entry, encrypted: true }), (e) => e.name === "ZipError");
  } finally {
    restore();
  }
});

test("openArchive: a password-protected archive is refused as a whole", async () => {
  const enc = makeZip([{ name: "a.txt", data: STORED, method: 0 }]);
  // set the encryption bit (bit 0) on the local + central headers
  enc[6] |= 1;
  const cdStart = enc.length - 22 - (46 + 5); // one entry, 5-byte name
  enc[cdStart + 8] |= 1;
  const rf = rangeFetch(enc);
  const restore = withFetch(rf.fetchImpl);
  try {
    await assert.rejects(zx.openArchive(AUTH, FILE), (e) => e.name === "ZipError" && /password|protect/i.test(e.message));
  } finally {
    restore();
  }
});
