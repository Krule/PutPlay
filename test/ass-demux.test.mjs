// Outer acceptance test: raw ASS demux over HTTP Range (T3).
//
// Demuxes the embedded English ASS track (Matroska track 3) from the REAL
// 218 MB file through a byte-counting ranged reader, reassembles the .ass,
// and pins byte-exact parity with the FFmpeg 9.0.2 oracle:
//     ffmpeg -i kusuriya2.mkv -map 0:s:0 -c copy -f ass eng_track.ass
//
// Ground truth fixture (committed): fixtures/kusuriya-eng-track.ass
//   md5 10e8749b88071123387c8947a5059ebc, 31,337 B, 325 Dialogue lines.
//
// The full file is NOT committed (218 MB); the test skips when the local
// copy is absent or its size changed.

import { test, assert } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { demuxAssTrack, fmtAssTime, parseAssBlock, assembleAss, readAssHead, collectClusterEvents, demuxAssRow1 } from "../src/putio/ass-demux.ts";
import { BoundedReader, readElementHeader } from "../src/putio/probe.ts";
import { parseCues, validateCues } from "../src/putio/cues.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MKV = "/tmp/kusuriya2.mkv";
const FILE_SIZE = 218_005_732;
const MAX_TRANSFER = Math.floor(FILE_SIZE * 0.10); // the 10 % budget: 21,800,573 B
const PIN_LINE =
  "Dialogue: 0,0:01:43.71,0:01:44.68,overlaptop,Father,0,0,0,,Open up!";
const enc = (s) => new TextEncoder().encode(s);

const ok =
  existsSync(MKV) &&
  (() => {
    try {
      return statSync(MKV).size === FILE_SIZE;
    } catch {
      return false;
    }
  })();
const t = ok ? test : test.skip;

// ---------------- unit: the FFmpeg ass-muxer parity layer ----------------
// Byte-exact reference: FFmpeg n9.0.2 `libavformat/assenc.c` write_packet +
// purge_dialogues, verified against the 218 MB Kusuriya file (the fixture).

test("fmtAssTime: h:mm:ss.cc, hour unpadded, mm/ss/cc zero-padded (assenc.c)", () => {
  assert.equal(fmtAssTime(0), "0:00:00.00");
  assert.equal(fmtAssTime(6400), "0:00:06.40");
  assert.equal(fmtAssTime(13530), "0:00:13.53");
  assert.equal(fmtAssTime(103710), "0:01:43.71");
  assert.equal(fmtAssTime(104680), "0:01:44.68");
  assert.equal(fmtAssTime(3600000), "1:00:00.00");
  // assenc.c clamps anything past 9h to 9:59:59.99
  assert.equal(fmtAssTime(37000000), "9:59:59.99");
});

test("parseAssBlock: strip one leading 0x00; f0 = readorder, f1 = layer, rest verbatim", () => {
  const ev = parseAssBlock(
    enc("\x000,0,Title,Text,0,0,0,,{\\fad(439,436)}The Apothecary Diaries"),
    6400,
    13530
  );
  assert.equal(ev.ro, 0);
  assert.equal(ev.layer, "0");
  assert.equal(ev.startMs, 6400);
  assert.equal(ev.endMs, 13530);
  assert.equal(ev.rest, "Title,Text,0,0,0,,{\\fad(439,436)}The Apothecary Diaries");

  // the file's real counter-example: f0 = 2 but the LAYER is f1 = 0
  const ev2 = parseAssBlock(enc("\x002,0,Fiction_Disclaimer,Text,0,0,0,,x"), 90400, 93410);
  assert.equal(ev2.ro, 2);
  assert.equal(ev2.layer, "0");
  assert.equal(ev2.rest, "Fiction_Disclaimer,Text,0,0,0,,x");
});

test("assembleAss: CRLF→LF header, lines sorted by readorder (NOT start), one trailing blank line", () => {
  const cp = enc(
    "[Script Info]\r\nTitle: T\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n\r\n"
  );
  // arrival order differs from readorder order: the ro=0 cue starts LATER
  const events = [
    parseAssBlock(enc("\x001,0,Default,A,0,0,0,,second"), 50000, 52000),
    parseAssBlock(enc("\x000,0,Default,A,0,0,0,,first"), 100000, 102000),
  ];
  const out = new TextDecoder().decode(assembleAss(cp, events));
  assert.equal(
    out,
    "[Script Info]\nTitle: T\n\n[Events]\n"
      + "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
      + "Dialogue: 0,0:01:40.00,0:01:42.00,Default,A,0,0,0,,first\n"
      + "Dialogue: 0,0:00:50.00,0:00:52.00,Default,A,0,0,0,,second\n"
      + "\n"
  );
});

test("assembleAss: equal readorders keep arrival order (FFmpeg insert_dialogue is stable)", () => {
  const cp = enc("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n\n");
  const events = [
    parseAssBlock(enc("\x005,1,Default,A,0,0,0,,a"), 1000, 2000),
    parseAssBlock(enc("\x005,0,Default,A,0,0,0,,b"), 3000, 4000),
  ];
  const out = new TextDecoder().decode(assembleAss(cp, events));
  assert.ok(out.indexOf(",a\n") < out.indexOf(",b\n"), "stable order for duplicate readorders");
});

// ---------------- unit: the cluster walk ----------------
// Synthetic MKV: two clusters mixing SimpleBlock and BlockGroup, a
// non-target track block, and a Cues terminator after the clusters.

const be = (n, len) => {
  const b = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    b[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return b;
};
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const vintSize = (v) =>
  v < 0x80 ? Uint8Array.of(0x80 | v) : Uint8Array.of(0x40 | (v >> 8), v & 0xff);
const idBytes = (id) =>
  // marker bits are part of the ID constants (0x80/0x40/0x20/0x10 leading nibble)
  id < 0x100
    ? Uint8Array.of(id)
    : id < 0x10000
      ? Uint8Array.of((id >> 8) & 0xff, id & 0xff)
      : id < 0x1000000
        ? Uint8Array.of((id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff)
        : Uint8Array.of((id >> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff);
const elem = (id, ...payloads) => {
  const p = concat(payloads);
  return concat([idBytes(id), vintSize(p.length), p]);
};
const blockBody = (track, rel, data) => concat([Uint8Array.of(0x80 | track), be(rel, 2), enc(data)]);

const SYNTH_CP =
  "[Script Info]\r\nTitle: T\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n\r\n";
const SYNTH = concat([
  elem(0x1a45dfa3,
    elem(0x4286, Uint8Array.of(1)),
    elem(0x42f7, Uint8Array.of(1)),
    elem(0x4282, Uint8Array.of(4)),
    elem(0x42f3, enc("matroska")),
  ),
  elem(0x18538067,
    elem(0x1549a966, elem(0x2ad7b1, be(1_000_000, 4))),
    elem(0x1654ae6b,
      elem(0xae,
        elem(0xd7, Uint8Array.of(1)),
        elem(0x83, Uint8Array.of(0x11)),
        elem(0x86, enc("S_TEXT/ASS")),
        elem(0x63a2, enc(SYNTH_CP)),
      ),
    ),
    elem(0x1f43b675, // cluster 1: cts 1000
      elem(0xbf, be(0xdeadbeef, 4)),
      elem(0xe7, be(1000, 2)),
      elem(0xa3, blockBody(1, 500, "\x000,0,Default,A,0,0,0,,hello")), // SimpleBlock: no duration
      elem(0xa0,
        elem(0xa1, blockBody(1, 1500, "\x001,0,Default,A,0,0,0,,world")),
        elem(0x9b, be(2000, 2)),
      ),
    ),
    elem(0x1f43b675, // cluster 2: cts 2000
      elem(0xbf, be(0, 4)),
      elem(0xe7, be(2000, 2)),
      elem(0xa0,
        elem(0xa1, blockBody(2, 0, "\x009,0,Other,Track,0,0,0,,skip me")),
        elem(0x9b, be(10, 1)),
      ),
      elem(0xa0,
        elem(0xa1, blockBody(1, 300, "\x002,1,Default,A,0,0,0,,bye")),
        elem(0x9b, be(1000, 2)),
      ),
    ),
    elem(0x1c53bb6b, be(0, 4)), // Cues: the terminator
  ),
]);

const clusterIdOffsets = (buf) => {
  const out = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x1f && buf[i + 1] === 0x43 && buf[i + 2] === 0xb6 && buf[i + 3] === 0x75) out.push(i);
  }
  return out;
};

test("collectClusterEvents: start = cts + rel, end = start + BlockDuration, SimpleBlock has no duration, other tracks skipped", async () => {
  const r = new BoundedReader((s, e) => Promise.resolve(SYNTH.slice(s, e + 1)));
  const offs = clusterIdOffsets(SYNTH);
  assert.equal(offs.length, 2, "the fixture has exactly two clusters");

  const h1 = await readElementHeader(r, offs[0]);
  assert.ok(h1 && h1.size >= 0);
  const ev1 = await collectClusterEvents(r, offs[0] + h1.hdrLen, offs[0] + h1.hdrLen + h1.size, 1_000_000, 1);
  assert.equal(ev1.length, 2);
  assert.deepEqual(
    ev1.map((e) => [e.ro, e.startMs, e.endMs, e.rest]),
    [[0, 1500, 1500, "Default,A,0,0,0,,hello"], [1, 2500, 4500, "Default,A,0,0,0,,world"]],
    "SimpleBlock (no duration) → end = start; BlockGroup end = start + 2000"
  );

  const h2 = await readElementHeader(r, offs[1]);
  const ev2 = await collectClusterEvents(r, offs[1] + h2.hdrLen, offs[1] + h2.hdrLen + h2.size, 1_000_000, 1);
  assert.equal(ev2.length, 1, "the track-2 block must be skipped");
  assert.deepEqual(
    ev2.map((e) => [e.ro, e.layer, e.startMs, e.endMs, e.rest]),
    [[2, "1", 2300, 3300, "Default,A,0,0,0,,bye"]]
  );
});

// ---------------- unit: the segment head walk ----------------
// Fixture: the real 64 KB head of the Kusuriya MKV (EBML + Segment through
// mid-Chapters, with all the Lavf63 quirks: 8-byte size vints, 0xBF CRC
// elements, 0xD7 TrackNumber).

test("readAssHead: segment start, TimestampScale, track table, no cluster in a 64 KB window", async () => {
  const HEAD64K = new Uint8Array(readFileSync(join(here, "fixtures/kusuriya-head-64k.bin")));
  const rangeRead = (start, end) => Promise.resolve(HEAD64K.slice(start, end + 1));

  const head = await readAssHead(rangeRead);

  // Segment payload starts at 52: EBML(40) + Segment id(4) + 8-byte size vint
  assert.equal(head.segStart, 52);
  // TimestampScale = 1,000,000 ns ⇒ timestamps are in ms
  assert.equal(head.scale, 1_000_000);
  // the English track (Matroska track 3): S_TEXT/ASS with its 1,976 B CodecPrivate
  const eng = head.tracks.find((t) => t.num === 3);
  assert.ok(eng, "track 3 must be in the track table");
  assert.equal(eng.codecId, "S_TEXT/ASS");
  assert.equal(eng.priv.length, 1976);
  // the window ends mid-Chapters (5 MB element) — no cluster is reachable,
  // and the walk must stop cleanly at the window edge
  assert.equal(head.firstClusterOffset, -1);
});

t("ass demux: the English track reassembles byte-exact with ≤10 % transfer", async () => {
  const buf = new Uint8Array(readFileSync(MKV));
  let transferred = 0;
  let calls = 0;
  const read = async (start, end) => {
    // probe.ts convention: end is INCLUSIVE
    const n = end - start + 1;
    if (start < 0 || end >= FILE_SIZE || n <= 0) throw new Error(`bad range ${start}..${end}`);
    transferred += n;
    calls += 1;
    return buf.subarray(start, end + 1);
  };

  const result = await demuxAssTrack(read, 3);

  // 325 cues
  assert.equal(result.cues, 325, "the English track has 325 cues");

  // the MPV-scene pin line, byte-exact
  const text = new TextDecoder("utf-8").decode(result.ass);
  assert.ok(
    text.includes(PIN_LINE + "\n"),
    "the 1:43.71 'Open up!' line must be byte-exact"
  );

  // full-file byte-exact against the FFmpeg oracle
  const expected = new Uint8Array(readFileSync(join(here, "fixtures/kusuriya-eng-track.ass")));
  assert.equal(result.ass.length, expected.length, `ass size ${result.ass.length} != ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(result.ass[i], expected[i], `byte mismatch @ ${i}`);
  }

  // transfer budget: at most 10 % of the file
  assert.ok(
    transferred <= MAX_TRANSFER,
    `transferred ${transferred} B > ${MAX_TRANSFER} B (10 % of file)`
  );
  console.log(`ass-demux: transferred ${transferred} B (${((100 * transferred) / FILE_SIZE).toFixed(2)} %) in ${calls} reads`);
});

// ---------------- unit: the row-1 batcher (Cues-driven) ----------------
// demuxAssRow1 fetches only what the (validated) Cues name: a 12 B read per
// unique cluster (its size-vint length) and one small range per cue. Times
// come from CueTime/CueDuration — no cluster prefixes needed.

const cuePoint = (tMs, track, ccp, rel, dur) =>
  elem(0xbb,
    elem(0xb3, be(tMs, 2)),
    elem(0xb7,
      elem(0xf7, Uint8Array.of(track)),
      elem(0xf1, be(ccp, 2)),
      elem(0xf0, be(rel, 1)),
      elem(0xb2, be(dur, 2)),
    ),
  );
const cuesEl = (...points) => elem(0x1c53bb6b, elem(0xbf, be(0x11223344, 4)), ...points);
const cuesPayload = (el) => el.slice(el[4] & 0x80 ? 5 : 6);

const r1ClusterA = elem(0x1f43b675,
  elem(0xbf, be(0xdeadbeef, 4)),
  elem(0xe7, be(1000, 2)),
  elem(0xa0,
    elem(0xa1, blockBody(1, 200, "\x000,0,Default,N1,0,0,0,,hello")),
    elem(0x9b, be(900, 2)),
  ),
);
const r1ClusterB = elem(0x1f43b675,
  elem(0xbf, be(0, 4)),
  elem(0xe7, be(2000, 2)),
  elem(0xa0,
    elem(0xa1, blockBody(1, 300, "\x001,1,Default,N2,0,0,0,,bye")),
    elem(0x9b, be(900, 2)),
  ),
);
const r1Cues = cuesEl(
  cuePoint(1200, 1, 0, 10, 500),
  cuePoint(2300, 1, r1ClusterA.length, 10, 700),
);
const R1 = concat([r1ClusterA, r1ClusterB, r1Cues]);

const countingReader = (buf) => {
  const st = { reads: 0, bytes: 0 };
  const read = async (s, e) => {
    st.reads += 1;
    st.bytes += e - s + 1;
    return buf.subarray(s, e + 1);
  };
  return { st, read };
};

test("demuxAssRow1: block fetches from Cues; times from CueTime/CueDuration; byte-exact", async () => {
  const { st, read } = countingReader(R1);
  const cues = parseCues(cuesPayload(r1Cues));
  assert.equal(cues.length, 2);

  const res = await demuxAssRow1({ read, segStart: 0, scale: 1_000_000, cues, trackNum: 1, codecPrivate: enc(SYNTH_CP) });
  assert.equal(res.cues, 2);

  const l1 = "Dialogue: 0,0:00:01.20,0:00:01.70,Default,N1,0,0,0,,hello";
  const l2 = "Dialogue: 1,0:00:02.30,0:00:03.00,Default,N2,0,0,0,,bye";
  const expected = Buffer.from(
    SYNTH_CP.replace(/\r\n/g, "\n").slice(0, -1) + l1 + "\n" + l2 + "\n" + "\n"
  );
  assert.ok(Buffer.compare(Buffer.from(res.ass), expected) === 0, "byte-exact .ass");
  assert.equal(st.reads, 4, "2 cluster-header reads + 2 block reads");
  assert.ok(st.bytes <= 2200, `bytes ${st.bytes}`);
});

test("demuxAssRow1: SimpleBlock (0xA3) targets parse like BlockGroups", async () => {
  const cluster = elem(0x1f43b675,
    elem(0xbf, be(0, 4)),
    elem(0xe7, be(5000, 2)),
    elem(0xa3, blockBody(1, 100, "\x000,0,Default,S,0,0,0,,simple")),
  );
  const cues = cuesEl(cuePoint(5100, 1, 0, 10, 400));
  const { st, read } = countingReader(concat([cluster, cues]));

  const res = await demuxAssRow1({ read, segStart: 0, scale: 1_000_000, cues: parseCues(cuesPayload(cues)), trackNum: 1, codecPrivate: enc(SYNTH_CP) });
  assert.equal(res.cues, 1);

  const l = "Dialogue: 0,0:00:05.10,0:00:05.50,Default,S,0,0,0,,simple";
  const expected = Buffer.from(SYNTH_CP.replace(/\r\n/g, "\n").slice(0, -1) + l + "\n" + "\n");
  assert.ok(Buffer.compare(Buffer.from(res.ass), expected) === 0, "byte-exact .ass");
  assert.equal(st.reads, 2, "1 cluster-header read + 1 block read");
});

test("demuxAssRow1: a block longer than the 1 KB window triggers one follow-up read", async () => {
  const text = "x".repeat(1500);
  const cluster = elem(0x1f43b675,
    elem(0xbf, be(0, 4)),
    elem(0xe7, be(1000, 2)),
    elem(0xa0,
      elem(0xa1, blockBody(1, 100, "\x000,0,Default,B,0,0,0,," + text)),
      elem(0x9b, be(300, 2)),
    ),
  );
  const cues = cuesEl(cuePoint(1100, 1, 0, 10, 300));
  const { st, read } = countingReader(concat([cluster, cues]));

  const res = await demuxAssRow1({ read, segStart: 0, scale: 1_000_000, cues: parseCues(cuesPayload(cues)), trackNum: 1, codecPrivate: enc(SYNTH_CP) });
  assert.equal(res.cues, 1);

  const l = "Dialogue: 0,0:00:01.10,0:00:01.40,Default,B,0,0,0,," + text;
  const expected = Buffer.from(SYNTH_CP.replace(/\r\n/g, "\n").slice(0, -1) + l + "\n" + "\n");
  assert.ok(Buffer.compare(Buffer.from(res.ass), expected) === 0, "byte-exact .ass");
  assert.equal(st.reads, 3, "header + first window + one follow-up");
});

// vint helpers for the real-file test (same shape as test/cues.test.mjs)
function vintLenAt(buf, off) {
  const b = buf[off];
  return b & 0x80 ? 1 : b & 0x40 ? 2 : b & 0x20 ? 3 : b & 0x10 ? 4 : 0;
}
function vintValue(buf, off, len) {
  let v = buf[off] & ((1 << (8 - len)) - 1);
  for (let k = 1; k < len; k++) v = v * 256 + buf[off + k];
  return len === 8 ? v & 0xffffffff : v;
}
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
async function readCuesPayload(read, off) {
  const hdr = await read(off, off + 11);
  const sln = vintLenAt(hdr, 4);
  const size = sln < 8 ? vintValue(hdr, 4, sln) : vintValue(hdr, 4, sln) & 0xffffffff;
  return read(off + 4 + sln, off + 4 + sln + size - 1);
}

t("demuxAssRow1: real file — byte-exact at oracle parity, ≤ 1 MB transferred", { timeout: 30_000 }, async () => {
  const buf = new Uint8Array(readFileSync(MKV));
  const { st, read } = countingReader(buf);

  const head = await readAssHead(read);
  const cuesOff = head.cuesFileOffset ?? findCuesId(buf);
  assert.ok(cuesOff > 0, "the Cues element must be locatable");
  const cues = (await parseCues(await readCuesPayload(read, cuesOff))).filter((c) => c.track === 3);
  assert.equal(cues.length, 325);

  const v = await validateCues({ read, segStart: head.segStart, scale: head.scale, cuesFileOffset: cuesOff, cues, trackNum: 3, fileSize: FILE_SIZE });
  assert.equal(v.row, 1, `expected row 1, got ${v.row} (clusters ${v.clusterOk}/${v.clusterN}, landings ${v.landOk}/${v.landN})`);

  const track = head.tracks.find((tr) => tr.num === 3);
  const res = await demuxAssRow1({ read, segStart: head.segStart, scale: head.scale, cues, trackNum: 3, codecPrivate: track.priv });

  const expected = readFileSync(join(here, "fixtures/kusuriya-eng-track.ass"));
  assert.equal(res.cues, 325);
  assert.ok(Buffer.compare(Buffer.from(res.ass), expected) === 0, "byte-exact vs the FFmpeg oracle");
  assert.ok(st.bytes <= 1_000_000, `transferred ${st.bytes} B > 1 MB`);
  console.log(`row1: ${res.cues} cues, ${st.bytes} B (${((100 * st.bytes) / FILE_SIZE).toFixed(2)} %) in ${st.reads} reads`);
});

t("ass demux: the reader is only ever asked for ranges inside the file", async () => {
  const buf = new Uint8Array(readFileSync(MKV));
  const seen = [];
  const read = async (start, end) => {
    seen.push([start, end]);
    return buf.subarray(start, end + 1);
  };
  await demuxAssTrack(read, 3);
  assert.ok(seen.length > 0, "the demuxer must use the ranged reader");
  for (const [s, e] of seen) {
    assert.ok(s >= 0 && e < FILE_SIZE, `range ${s}..${e} outside the file`);
  }
});
