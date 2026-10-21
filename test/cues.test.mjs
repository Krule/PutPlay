import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseCues, validateCues } from "../src/putio/cues.ts";

// ---------------------------------------------------------------- builders
// Minimal EBML element builders (same conventions as test/ass-demux.test.mjs:
// 1-byte Matroska IDs always carry the marker bit; size vints get the
// marker bit for their length).

const enc = (s) => new TextEncoder().encode(s);

function be(n, len) {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = n & 0xff;
    n >>= 8;
  }
  return out;
}

function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** EBML size vint for `n` bytes (smallest length). */
function vintSize(n) {
  if (n < 0x80) return Uint8Array.of(0x80 | n);
  if (n < 0x4000) return be(0x4000 | n, 2);
  if (n < 0x200000) return be(0x200000 | n, 3);
  return be(0x10000000 | n, 4);
}

function idBytes(id) {
  // the marker bit is part of the ID value (0x1F43B675's first byte already is 0x1F)
  if (id < 0x100) return Uint8Array.of(id);
  if (id < 0x10000) return be(id, 2);
  if (id < 0x1000000) return be(id, 3);
  return be(id, 4);
}

function elem(id, ...payloads) {
  const body = concat(...payloads);
  return concat(idBytes(id), vintSize(body.length), body);
}

/** An EBML unsigned-integer element (ID + size + big-endian value). */
function intElem(id, n, len) {
  return concat(idBytes(id), vintSize(len), be(n, len));
}

// ---------------------------------------------------------------- fixture
// Layout (segStart = 0 for the validator):
//
//   Cluster 1 @ 0x000 : [1f43b675][size 2B] CRC(6) cts(4) BlockGroup
//                        cts = 50000, block: track 3, rel_ts 200 → t 50200
//   Cluster 2 @ 0x100 : same shape, cts = 60000, rel_ts 300 → t 60300
//   Cues      @ 0x200 : 2 CuePoints (the only cues in the file)
//
// The cluster size vint overstates the payload (128 B — the smallest value that
// keeps a 2-byte size vint) on purpose: nothing in the validator walks the whole
// cluster, and real Lavf63 clusters are large.

const CL1 = 0x000;
const CL2 = 0x100;
const CUES = 0x200;
const CLUSTER_SIZE = 128;

function blockGroup(track, relTs, data) {
  const block = concat(be(0x80 | track, 1), be(relTs, 2), data);
  return concat(idBytes(0xa0), vintSize(block.length + 2), idBytes(0xa1), vintSize(block.length), block);
}

function cluster(cfileOff, cts, group) {
  const body = concat(
    // optional CRC-32 element (present in every real file audited)
    idBytes(0xbf), vintSize(4), be(0x11223344, 4),
    // ClusterTimestamp (scale units)
    idBytes(0xe7), vintSize(2), be(cts, 2),
    group,
  );
  // pad body to the overstated size (0x4080 → 2-byte vint, low bits 128)
  const claimed = CLUSTER_SIZE;
  const pad = claimed - body.length;
  const full = concat(body, new Uint8Array(pad));
  const at = new Uint8Array(6 + claimed);
  at.set(concat(idBytes(0x1f43b675), vintSize(claimed)), 0);
  at.set(full, 6);
  return { body: at, total: 6 + claimed };
}

function buildFile({ corruptRels = false, cueTrack = 3, blockTrack = 3 } = {}) {
  const g1 = blockGroup(blockTrack, 200, enc("\x000,0"));
  const g2 = blockGroup(blockTrack, 300, enc("\x001,0"));
  const c1 = cluster(CL1, 50000, g1);
  const c2 = cluster(CL2, 60000, g2);

  // payload-relative offset of each 0xA0 ID: CRC(6) + cts elem(4) = 10;
  // corruptRels points the in-cluster offsets at nothing
  const rel1 = corruptRels ? 10 + 999 : 10;
  const rel2 = corruptRels ? 10 + 777 : 10;

  const cue1 = elem(
    0xbb,
    intElem(0xb3, 50200, 2),
    elem(
      0xb7,
      intElem(0xf7, cueTrack, 1),
      intElem(0xf1, CL1, 2),
      intElem(0xf0, rel1, 2),
      intElem(0xb2, 1000, 2),
    ),
  );
  const cue2 = elem(
    0xbb,
    intElem(0xb3, 60300, 2),
    elem(
      0xb7,
      intElem(0xf7, cueTrack, 1),
      intElem(0xf1, CL2, 2),
      intElem(0xf0, rel2, 2),
      intElem(0xb2, 500, 2),
    ),
  );
  const cuesBody = concat(idBytes(0xbf), vintSize(4), be(0x55667788, 4), cue1, cue2);
  const cuesElem = concat(idBytes(0x1c53bb6b), vintSize(cuesBody.length), cuesBody);

  const file = new Uint8Array(CUES + 128);
  file.set(c1.body, CL1);
  file.set(c2.body, CL2);
  file.set(cuesElem, CUES);

  return {
    file,
    cuesFileOffset: CUES,
    cuesSize: cuesBody.length,
    cuesBytes: cuesBody,
    expected: [
      { t: 50200, track: cueTrack, ccp: CL1, rel: rel1, dur: 1000 },
      { t: 60300, track: cueTrack, ccp: CL2, rel: rel2, dur: 500 },
    ],
  };
}

/** Byte-counting inclusive-end reader over an in-memory file. */
function countingReader(file) {
  const st = { bytes: 0, reads: 0 };
  const read = (start, end) =>
    Promise.resolve(file.slice(start, end + 1)).then((b) => {
      st.bytes += b.length;
      st.reads += 1;
      return b;
    });
  return { read, st };
}

// ---------------------------------------------------------------- parseCues

test("parseCues: decodes CuePoint/CueTrackPosition fields incl. optional CRC prefix", () => {
  const fx = buildFile();
  const cues = parseCues(fx.cuesBytes);
  assert.deepEqual(cues, fx.expected);
});

test("parseCues: missing optional fields come back null (no duration / no rel)", () => {
  const body = elem(
    0xbb,
    intElem(0xb3, 1234, 2),
    elem(0xb7, intElem(0xf7, 4, 1), intElem(0xf1, 56, 2)), // no 0xF0 rel, no 0xB2 dur
  );
  const cues = parseCues(body);
  assert.deepEqual(cues, [{ t: 1234, track: 4, ccp: 56, rel: null, dur: null }]);
});

test("parseCues: one CuePoint with several tracks → one entry per CueTrackPosition", () => {
  // real files group same-timestamp tracks under a single CuePoint (232 B, ~10 tracks)
  const body = elem(
    0xbb,
    intElem(0xb3, 7000, 2),
    elem(0xb7, intElem(0xf7, 3, 1), intElem(0xf1, 10, 2), intElem(0xf0, 20, 2), intElem(0xb2, 500, 2)),
    elem(0xb7, intElem(0xf7, 9, 1), intElem(0xf1, 10, 2), intElem(0xf0, 30, 2), intElem(0xb2, 600, 2)),
  );
  const cues = parseCues(body);
  assert.deepEqual(cues, [
    { t: 7000, track: 3, ccp: 10, rel: 20, dur: 500 },
    { t: 7000, track: 9, ccp: 10, rel: 30, dur: 600 },
  ]);
});

// ---------------------------------------------------------------- validateCues

test("validateCues: fully valid Cues → row 1 (small read budget)", async () => {
  const fx = buildFile();
  const { read, st } = countingReader(fx.file);
  const v = await validateCues({
    read,
    segStart: 0,
    scale: 1_000_000,
    cuesFileOffset: fx.cuesFileOffset,
    cues: fx.expected,
    trackNum: 3,
    fileSize: 500_000,
  });
  assert.equal(v.row, 1);
  assert.equal(v.clusterOk, v.clusterN);
  assert.ok(v.clusterN >= 2);
  assert.equal(v.landOk, v.landN);
  assert.ok(v.landN >= 2);
  assert.ok(st.reads <= 40, `read budget: ${st.reads}`);
});

test("validateCues: valid clusters but corrupted in-cluster rels → row 2 (under 2 GiB)", async () => {
  const fx = buildFile({ corruptRels: true });
  const { read, st } = countingReader(fx.file);
  const v = await validateCues({
    read,
    segStart: 0,
    scale: 1_000_000,
    cuesFileOffset: fx.cuesFileOffset,
    cues: fx.expected,
    trackNum: 3,
    fileSize: 500_000,
  });
  assert.equal(v.row, 2);
  assert.equal(v.clusterOk, v.clusterN);
  assert.ok(v.clusterN >= 2);
  assert.equal(v.landOk, 0);
  // out-of-range landing reads must not throw
  assert.ok(st.reads > 0);
});

test("validateCues: corrupted rels + file > 2 GiB → row 3 (cap demotes)", async () => {
  const fx = buildFile({ corruptRels: true });
  const { read } = countingReader(fx.file);
  const v = await validateCues({
    read,
    segStart: 0,
    scale: 1_000_000,
    cuesFileOffset: fx.cuesFileOffset,
    cues: fx.expected,
    trackNum: 3,
    fileSize: 2 * 1024 ** 3 + 1,
  });
  assert.equal(v.row, 3);
});

test("validateCues: no Cues at all → row 3 with zero reads", async () => {
  const fx = buildFile();
  const { read, st } = countingReader(fx.file);
  const v = await validateCues({
    read,
    segStart: 0,
    scale: 1_000_000,
    cuesFileOffset: null,
    cues: [],
    trackNum: 3,
    fileSize: 500_000,
  });
  assert.equal(v.row, 3);
  assert.equal(st.reads, 0);
});

test("validateCues: block track vint ≠ cue label → row 3 (no correlation resolver yet)", async () => {
  // label IS our track (3); the block actually belongs to track 5 → the Cues
  // labels cannot be trusted for cluster selection either → row 3, not row 2
  const fx = buildFile({ cueTrack: 3, blockTrack: 5 });
  const { read } = countingReader(fx.file);
  const v = await validateCues({
    read,
    segStart: 0,
    scale: 1_000_000,
    cuesFileOffset: fx.cuesFileOffset,
    cues: fx.expected,
    trackNum: 3,
    fileSize: 500_000,
  });
  assert.equal(v.row, 3);
});

// ---------------------------------------------------------------- real file

const REAL_MKV = "/tmp/kusuriya2.mkv";
const REAL_SIZE = 218_005_732;

/** Size-vint length at `off` (marker bit; 0 = invalid) — test-side twin of cues.ts. */
function vintLenAt(buf, off) {
  const b = buf[off];
  return b & 0x80 ? 1 : b & 0x40 ? 2 : b & 0x20 ? 3 : b & 0x10 ? 4 : 0;
}

/** Size-vint value at `off` (marker bit stripped; 8-byte vint → low 32 bits). */
function vintValue(buf, off, len) {
  let v = buf[off] & ((1 << (8 - len)) - 1);
  for (let k = 1; k < len; k++) v = v * 256 + buf[off + k];
  return len === 8 ? v & 0xffffffff : v;
}

/** Find the Cues element ID (1C 53 BB 6B) in the tail; it is the file's last element, so the size vint must end at EOF. */
function findCuesId(buf) {
  const start = Math.max(0, buf.length - 1_048_576);
  for (let i = start; i + 8 <= buf.length; i++) {
    if (!(buf[i] === 0x1c && buf[i + 1] === 0x53 && buf[i + 2] === 0xbb && buf[i + 3] === 0x6b)) continue;
    const sln = vintLenAt(buf, i + 4);
    if (!sln || i + 4 + sln > buf.length) continue;
    const size = vintValue(buf, i + 4, sln);
    if (i + 4 + sln + size === buf.length) return i;
  }
  return -1;
}

test("validateCues: real reference file's Cues → row 1 (skipIf absent)", { timeout: 30_000 }, async (t) => {
  let buf;
  try {
    buf = new Uint8Array(readFileSync(REAL_MKV));
  } catch {
    t.skip();
    return;
  }
  if (buf.length !== REAL_SIZE) {
    t.skip();
    return;
  }

  // the probe found the Segment payload start at 52 (EBML header 40 B + Segment ID + 8 B size)
  const segStart = 52;
  const cuesId = findCuesId(buf);
  assert.ok(cuesId >= 0, "Cues element present");
  // Cues size vint (3 bytes here) → payload bytes
  const sln = vintLenAt(buf, cuesId + 4);
  const size = vintValue(buf, cuesId + 4, sln);
  const cuesPayload = buf.slice(cuesId + 4 + sln, cuesId + 4 + sln + size);

  const cues = parseCues(cuesPayload);
  const eng = cues.filter((c) => c.track === 3);
  assert.equal(eng.length, 325);
  assert.ok(eng.every((c) => c.rel !== null && c.dur !== null), "English cues carry rel + dur");

  const { read, st } = countingReader(buf);
  const v = await validateCues({
    read,
    segStart,
    scale: 1_000_000,
    cuesFileOffset: cuesId,
    cues,
    trackNum: 3,
    fileSize: buf.length,
  });
  assert.equal(v.row, 1);
  assert.equal(v.clusterOk, v.clusterN);
  assert.equal(v.landOk, v.landN);
  // 12 cluster headers + 8 landings × (header + block + cts prefix) ≈ 35 tiny reads
  assert.ok(st.reads <= 40, `read budget: ${st.reads}`);
});
