// ZIP parser (archive viewer v1, ZIP-only) — the pure byte-level core.
//
// An archive opened on the TV must LIST without downloading: the app fetches
// only the file's TAIL (EOCD + central directory) via a Range request, and
// this module turns those bytes into an honest entry model.
//
// Contract:
//   1. parseZip: entries with real names (UTF-8 flag), sizes, crc, method,
//      and the local-header offset; the offset must point at a real local
//      file header.
//   2. stored entries carry their exact bytes; deflated entries carry their
//      exact COMPRESSED range (inflation happens in the extract layer, with
//      pako — Chromium 79 has no DecompressionStream).
//   3. junk after the EOCD does not confuse the scanner (it must validate
//      each candidate, not just match the signature).
//   4. a truncated archive is an honest ZipError — never a silent empty list.
//   5. ZIP64 is DETECTED and flagged; v1 refuses it at the screen level.
//   6. archiveView: the entries of one path → the folder's rows (implicit
//      dirs from path segments + direct files), name-sorted, one list.
//
// Fixtures: test/fixtures/ (byte-stable; regenerate with
// `python3 test/fixtures/make-zips.py`).
//
// Run: npm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const fix = (p) => new Uint8Array(readFileSync(join(here, "fixtures", p)));

const dir = mkdtempSync(join(tmpdir(), "zipparse-"));
await build({
  entryPoints: [join(here, "..", "src/putio/zip.ts")],
  bundle: true,
  format: "cjs",
  target: "es2019",
  outfile: join(dir, "bundle.cjs"),
});
const req = createRequire(import.meta.url);
const zip = req(join(dir, "bundle.cjs"));

const byName = (m) => Object.fromEntries(m.entries.map((e) => [e.name, e]));

/* ---------------- parseZip: the basic archive ---------------- */
test("parseZip: lists every entry with name, sizes, crc and method", () => {
  const m = zip.parseZip(fix("zip-basic.zip"));
  const e = byName(m);
  assert.equal(m.entries.length, 6);
  assert.ok(!m.zip64, "zip-basic is not zip64");

  assert.equal(e["notes.txt"].method, 0, "notes.txt was written STORED");
  assert.equal(e["notes.txt"].size, 30);
  assert.equal(e["notes.txt"].compressedSize, 30, "stored: sizes are equal");
  assert.equal(e["notes.txt"].isDir, false);
  assert.ok(e["notes.txt"].crc32 > 0, "crc32 must be carried through");

  assert.equal(e["cover.png"].method, 8, "cover.png was written DEFLATEd");
  assert.equal(e["cover.png"].size, 74);
  assert.ok(e["cover.png"].compressedSize < 74, "deflated: smaller than raw");

  assert.deepEqual(
    Object.keys(e).sort(),
    ["cover.png", "notes.txt", "page-2.png", "sub/deep/deeper.txt", "sub/inner-1.png", "sub/inner-2.png"]
  );
});

test("parseZip: entry offsets point at real local file headers", () => {
  const bytes = fix("zip-basic.zip");
  const m = zip.parseZip(bytes);
  for (const e of m.entries) {
    const sig = new DataView(bytes.buffer, e.offset, 4).getUint32(0, true);
    assert.equal(sig, 0x04034b50, `offset of ${e.name} must be a local file header`);
  }
});

test("entryDataStart: local name/extra lengths decide the data start", () => {
  const bytes = fix("zip-basic.zip");
  const m = zip.parseZip(bytes);
  for (const e of m.entries) {
    const start = zip.entryDataStart(bytes, e);
    assert.ok(start > e.offset + 30, "data starts after the 30-byte local header");
    // the stored notes.txt: the first byte after dataStart must be 'h'
    if (e.name === "notes.txt") {
      assert.equal(bytes[start], 0x68, "stored data must begin with 'h' (hello)");
    }
  }
});

test("extractEntryData: stored entries come back byte-exact", () => {
  const bytes = fix("zip-basic.zip");
  const m = zip.parseZip(bytes);
  const e = byName(m)["notes.txt"];
  const out = zip.extractEntryData(bytes, e);
  assert.equal(Buffer.from(out).toString("utf8"), "hello from inside the archive\n");
});

/* ---------------- empty, unicode, junk, truncated, zip64 ---------------- */
test("parseZip: an empty archive is a valid model with zero entries", () => {
  const m = zip.parseZip(fix("zip-empty.zip"));
  assert.equal(m.entries.length, 0);
});

test("parseZip: the UTF-8 name flag decodes real unicode names", () => {
  const m = zip.parseZip(fix("zip-unicode.zip"));
  assert.deepEqual(m.entries.map((e) => e.name), ["föto-日本語.png"]);
});

test("parseZip: junk appended after the EOCD does not win the scan", () => {
  const m = zip.parseZip(fix("zip-junk.zip"));
  assert.deepEqual(m.entries.map((e) => e.name), ["a.txt"]);
  const e = m.entries[0];
  assert.equal(e.method, 0);
  assert.equal(e.size, 18);
});

test("parseZip: a truncated archive is an honest ZipError", () => {
  assert.throws(
    () => zip.parseZip(fix("zip-truncated.zip")),
    (err) => err instanceof Error && err.constructor.name === "ZipError"
  );
});

/* ---------------- large files: the tail is NOT the whole file --------------
 * A file > 256 KB is fetched as a tail only. The EOCD's central-directory
 * offset is FILE space; the scan position is TAIL space. Mixing the two
 * coordinate systems rejects every real file over 256 KB (the C1 refused
 * every comic with "Not a ZIP archive") — while every tiny test fixture
 * (file == tail) passed.
 */
function paddedFile(padLen) {
  // A VALID big zip: zip-basic's bytes at the end of padLen filler bytes,
  // with every internal pointer (EOCD cdOffset + each CD entry's local
  // header offset) shifted by padLen — exactly as if the archive had been
  // written with a big chunk before its central directory.
  const small = new Uint8Array(readFileSync(join(here, "fixtures", "zip-basic.zip")));
  const dv = new DataView(small.buffer, small.byteOffset, small.byteLength);
  const eocd = small.length - 22; // the fixture has no zip comment
  const cdOff = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  for (let i = 0, off = cdOff; i < count; i++, off += 46 + dv.getUint16(off + 28, true) + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true)) {
    dv.setUint32(off + 42, dv.getUint32(off + 42, true) + padLen, true); // local header offset
  }
  dv.setUint32(eocd + 16, cdOff + padLen, true); // EOCD: where the CD really starts
  const file = new Uint8Array(padLen + small.length);
  file.fill(0xaa, 0, padLen); // a fill that can never forge an EOCD signature
  file.set(small, padLen);
  return file;
}

test("parseZip: a big file parsed from its tail alone (tailStart)", () => {
  const file = paddedFile(400 * 1024);
  const tailLen = 256 * 1024;
  const tail = file.slice(file.length - tailLen);
  const m = zip.parseZip(tail, file.length - tailLen);
  const mWhole = zip.parseZip(file);
  assert.deepEqual(m.entries.map((e) => e.name), mWhole.entries.map((e) => e.name));
  assert.deepEqual(m.entries.map((e) => e.offset), mWhole.entries.map((e) => e.offset),
    "entry offsets stay in FILE space — the extract layer range-reads from file start");
});

test("parseZip: the same tail parsed at the WRONG offset is still refused", () => {
  const file = paddedFile(400 * 1024);
  const tail = file.slice(file.length - 256 * 1024);
  assert.throws(
    () => zip.parseZip(tail, 0),
    (err) => err instanceof Error && err.constructor.name === "ZipError",
    "a tailStart that puts the CD outside the buffer must not silently parse"
  );
});

test("findEocdHint: the EOCD window yields the CD pointer in FILE space (small zip: the CD fits the window)", () => {
  // Stage 1 of the two-stage open: a 64KB window at the end of a big file.
  // The hint carries the EOCD's central-directory pointer (file space) —
  // for a small index it sits INSIDE the window, so the caller needs no
  // second request (the openArchive test pins that).
  const file = paddedFile(400 * 1024);
  const winStart = file.length - 65600;
  const win = file.slice(winStart);
  const hint = zip.findEocdHint(win);
  assert.ok(hint, "the EOCD inside the 64KB window is found");
  assert.equal(hint.zip64, false);
  assert.equal(hint.cdEntries, 6, "zip-basic.zip has 6 entries");
  assert.ok(hint.cdOffset >= winStart, "the small CD sits inside the window (no stage 2 needed)");
  assert.ok(hint.cdOffset + hint.cdSize <= file.length, "…and its declared range stays inside the file");
});

test("findEocdHint: garbage has no hint (never a throw)", () => {
  assert.equal(zip.findEocdHint(new Uint8Array(65600).fill(0xaa)), null);
  assert.equal(zip.findEocdHint(new Uint8Array(22)), null);
});

test("parseZip: the real Preacher #01 tail from put.io's CDN (TV regression)", () => {
  // 256 KB tail of 'Preacher - Issue 01.cbz' (6,148,002 B) as served by
  // s87-cdn77.put.io on 2026-10-13 — the exact bytes the C1 rejected with
  // "Not a ZIP archive — the end-of-central-directory record was not found."
  const tail = fix("preacher01-tail.bin");
  const m = zip.parseZip(tail, 6148002 - tail.length);
  assert.equal(m.entries.length, 43);
  assert.equal(m.zip64, false);
  const names = m.entries.map((e) => e.name);
  assert.ok(names.some((n) => n.endsWith("ComicInfo.xml")), "ComicInfo.xml is listed");
  assert.ok(
    names.filter((n) => /\.(jpg|png)$/i.test(n)).length >= 41,
    "the pages are listed (41 = COVER + 40)"
  );
});

test("parseZip: a ZIP64 tail is flagged (v1 refuses at the screen)", () => {
  const m = zip.parseZip(fix("zip-zip64.zip"));
  assert.ok(m.zip64, "the EOCD64 locator must set the zip64 flag");
});

/* ---------------- archiveView: entries → one folder's rows ---------------- */
test("archiveView: root shows implicit dirs and files, name-sorted", () => {
  const m = zip.parseZip(fix("zip-basic.zip"));
  const rows = zip.archiveView(m.entries, "");
  assert.deepEqual(
    rows.map((r) => [r.name, r.isDir]),
    [["cover.png", false], ["notes.txt", false], ["page-2.png", false], ["sub", true]]
  );
  const notes = rows.find((r) => r.name === "notes.txt");
  assert.equal(notes.size, 30);
});

test("archiveView: subfolders resolve; deep paths work", () => {
  const m = zip.parseZip(fix("zip-basic.zip"));
  const sub = zip.archiveView(m.entries, "sub/");
  assert.deepEqual(
    sub.map((r) => [r.name, r.isDir]),
    [["deep", true], ["inner-1.png", false], ["inner-2.png", false]]
  );
  const deep = zip.archiveView(m.entries, "sub/deep/");
  assert.deepEqual(deep.map((r) => [r.name, r.isDir]), [["deeper.txt", false]]);
});

test("archiveView: an empty path has no rows", () => {
  const m = zip.parseZip(fix("zip-basic.zip"));
  assert.deepEqual(zip.archiveView(m.entries, "nope/"), []);
});

/* ---------------- parentPath: the archive's back stack ---------------- */
test("parentPath: pops one archive folder level", () => {
  assert.equal(zip.archiveParentPath("sub/deep/"), "sub/");
  assert.equal(zip.archiveParentPath("sub/"), "");
  assert.equal(zip.archiveParentPath(""), "");
});

/* ---------------- entry geometry (one-read extraction, v1.1) -------------
 * The CD already knows each entry's name/extra lengths — the extract layer
 * needs them to read header+data in ONE range request (the C1's 2 MB pages
 * were paying TWO round trips each: 30-byte header, then data).
 */
test("entries expose the CD's name/extra lengths (extractEntry's one-read geometry)", () => {
  // build a minimal CD via the same fixture style: parse a tiny zip
  const z = req(join(dir, "bundle.cjs"));
  const made = makeMiniZip([["a/b.png", 1234], ["c.png", 77]]);
  const model = z.parseZip(new Uint8Array(made), 0);
  const [e1, e2] = model.entries;
  assert.equal(e1.nameLen, 7, "a/b.png is 7 bytes");
  assert.equal(e1.extraLen, 0);
  assert.equal(e2.nameLen, 5, "c.png is 5 bytes");
});

function makeMiniZip(spec) {
  // spec: [name, compressedSize][] — deflate-0 stored bytes (content irrelevant)
  const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
  const crc = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunks = []; const central = []; let off = 0;
  for (const [name, size] of spec) {
    const nm = Buffer.from(name, "utf8");
    const data = new Uint8Array(size);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt32LE(crc(data), 14);
    local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nm.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nm, Buffer.from(data));
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc(data), 16); cd.writeUInt32LE(size, 20); cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(off, 42);
    central.push(cd, nm);
    off += 30 + nm.length + size;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(spec.length, 8); eocd.writeUInt16LE(spec.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}
