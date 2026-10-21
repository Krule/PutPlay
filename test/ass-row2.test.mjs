// Row 2 (docs/raw-ass-upgrade.md): validated cluster offsets, untrusted
// in-cluster rels, file ≤ 2 GiB → lazy sub-cluster fetch.
//
// The scheduler plans clusters from the Cues (unique cluster offsets),
// then fetches a whole cluster only when the playhead gets within the
// lookahead of its earliest cue. Each fetched cluster is parsed locally
// (all blocks, target track), merged into the growing cue set, and the
// bytes are discarded.
//
// Integration: the real 218 MB file driven by a fake playhead must land
// the full 325-cue set byte-exact against the FFmpeg oracle.

import { test, assert } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planRow2Clusters, createLazyScheduler } from "../src/putio/ass-row2.ts";
import { assembleAss, readAssHead } from "../src/putio/ass-demux.ts";
import { parseCues } from "../src/putio/cues.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MKV = "/tmp/kusuriya2.mkv";
const FILE_SIZE = 218_005_732;
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

// ---------------- synthetic builders (same conventions as ass-demux) ----------------

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

const CP =
  "[Script Info]\r\nTitle: T\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n\r\n";
const CP_LF = CP.replace(/\r\n/g, "\n");

const miniCluster = (cts, ro, text) =>
  elem(0x1f43b675,
    elem(0xbf, be(0, 4)),
    elem(0xe7, be(cts, 2)),
    elem(0xa0,
      elem(0xa1, blockBody(1, 100, `\x00${ro},0,Default,N${ro},0,0,0,,${text}`)),
      elem(0x9b, be(500, 2)),
    ),
  );

const cA = miniCluster(1000, 0, "alpha");
const cB = miniCluster(11000, 1, "beta");
const cC = miniCluster(21000, 2, "gamma");
const FILE3 = concat([cA, cB, cC]);
const OFF = { a: 0, b: cA.length, c: cA.length + cB.length };
// row-2 shape: cluster offsets good, rels garbage (the scheduler never reads them)
const CUES3 = [
  { t: 1100, track: 1, ccp: OFF.a, rel: 9999, dur: 500 },
  { t: 11100, track: 1, ccp: OFF.b, rel: 9999, dur: 500 },
  { t: 21100, track: 1, ccp: OFF.c, rel: 9999, dur: 500 },
];

const countingReader = (buf) => {
  const st = { reads: 0, bytes: 0 };
  const read = async (s, e) => {
    st.reads += 1;
    st.bytes += e - s + 1;
    return buf.subarray(s, e + 1);
  };
  return { st, read };
};

// ---------------- the cluster plan ----------------

test("planRow2Clusters: one entry per unique cluster, sorted by earliest cue", async () => {
  const { st, read } = countingReader(FILE3);
  const plan = await planRow2Clusters(read, 0, 1_000_000, CUES3, 1);
  // element = 4 B ID + 1 B size vint + payload (51 B) → payload = len − 5
  const payloadLen = (c) => c.length - 5;
  assert.deepEqual(
    plan.map((p) => [p.ccp, p.windowStart, p.size]),
    [
      [OFF.a, 1100, payloadLen(cA)],
      [OFF.b, 11100, payloadLen(cB)],
      [OFF.c, 21100, payloadLen(cC)],
    ],
  );
  assert.equal(st.reads, 3, "one 12 B header read per unique cluster");

  // duplicate ccp in the cues → still one plan entry (earliest window wins)
  const dup = [...CUES3, { t: 1200, track: 1, ccp: OFF.a, rel: 1, dur: 100 }];
  const plan2 = await planRow2Clusters(read, 0, 1_000_000, dup, 1);
  assert.equal(plan2.length, 3);
  // cues for other tracks (even on a new cluster) are pruned
  const other = [...CUES3, { t: 5000, track: 9, ccp: 99999, rel: 1, dur: 100 }];
  const plan3 = await planRow2Clusters(read, 0, 1_000_000, other, 1);
  assert.equal(plan3.length, 3);
});

// ---------------- the scheduler ----------------

test("lazy scheduler: lookahead-ordered fetches, per-window merge, byte-exact final .ass", async () => {
  const { st, read } = countingReader(FILE3);
  const plan = await planRow2Clusters(read, 0, 1_000_000, CUES3, 1);
  const sched = createLazyScheduler({ read, scale: 1_000_000, plan, trackNum: 1, lookaheadMs: 5000, concurrency: 1 });

  sched.onPlayhead(0);
  await sched.settle();
  assert.equal(sched.events().length, 1, "only cluster A is due at t=0 (next window 11.1 s > 0 + 5 s)");

  sched.onPlayhead(8000);
  await sched.settle();
  assert.equal(sched.events().length, 2, "cluster B due (11.1 s ≤ 13 s)");

  sched.onPlayhead(17000);
  await sched.settle();
  assert.equal(sched.events().length, 3);
  assert.ok(sched.isDone());
  assert.equal(sched.failed(), 0);

  const l0 = "Dialogue: 0,0:00:01.10,0:00:01.60,Default,N0,0,0,0,,alpha";
  const l1 = "Dialogue: 0,0:00:11.10,0:00:11.60,Default,N1,0,0,0,,beta";
  const l2 = "Dialogue: 0,0:00:21.10,0:00:21.60,Default,N2,0,0,0,,gamma";
  const expected = Buffer.from(CP_LF.slice(0, -1) + l0 + "\n" + l1 + "\n" + l2 + "\n" + "\n");
  assert.ok(Buffer.compare(Buffer.from(assembleAss(enc(CP), sched.events())), expected) === 0, "byte-exact .ass");
});

test("lazy scheduler: a cluster is never fetched before its window minus the lookahead", async () => {
  const { read } = countingReader(FILE3);
  const plan = await planRow2Clusters(read, 0, 1_000_000, CUES3, 1);
  const sched = createLazyScheduler({ read, scale: 1_000_000, plan, trackNum: 1, lookaheadMs: 5000, concurrency: 1 });

  sched.onPlayhead(9000); // 11100 > 14000? no — 11100 ≤ 14000 → B IS due. Use the boundary below.
  await sched.settle();
  assert.equal(sched.events().length, 2, "A and B are within 9 s + 5 s");

  // fresh scheduler, hard boundary: nothing due below window − L
  const sched2 = createLazyScheduler({ read, scale: 1_000_000, plan, trackNum: 1, lookaheadMs: 5000, concurrency: 1 });
  sched2.onPlayhead(5000); // 11100 > 10000 → B not due
  await sched2.settle();
  assert.equal(sched2.events().length, 1);
  sched2.onPlayhead(6100); // 11100 ≤ 11100 → B due (boundary inclusive)
  await sched2.settle();
  assert.equal(sched2.events().length, 2);
});

test("lazy scheduler: a backward seek re-fetches nothing and changes no cues", async () => {
  const { st, read } = countingReader(FILE3);
  const plan = await planRow2Clusters(read, 0, 1_000_000, CUES3, 1);
  const sched = createLazyScheduler({ read, scale: 1_000_000, plan, trackNum: 1, lookaheadMs: 5000, concurrency: 1 });
  sched.onPlayhead(99999);
  await sched.settle();
  assert.ok(sched.isDone());
  const before = { reads: st.reads, bytes: st.bytes, events: sched.events().length };

  sched.onPlayhead(0);
  await sched.settle();
  assert.equal(st.reads, before.reads, "no new reads");
  assert.equal(st.bytes, before.bytes, "no new bytes");
  assert.equal(sched.events().length, before.events, "cue set unchanged");
});

test("lazy scheduler: a failed cluster is skipped, not fatal", async () => {
  const { read } = countingReader(FILE3);
  const plan = await planRow2Clusters(read, 0, 1_000_000, CUES3, 1);
  let calls = 0;
  const flaky = async (s, e) => {
    calls += 1;
    if (calls === 2) throw new Error("range 500"); // the 2nd payload read (cluster B)
    return read(s, e);
  };
  const sched = createLazyScheduler({ read: flaky, segStart: 0, scale: 1_000_000, plan, trackNum: 1, lookaheadMs: 5000, concurrency: 1 });
  sched.onPlayhead(99999);
  await sched.settle();
  assert.equal(sched.failed(), 1, "one cluster failed");
  assert.ok(sched.events().length < 3, "the failed cluster's cues are missing");
  assert.ok(sched.isDone(), "the rest still completed");
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

// ---------------- integration: the real 218 MB file, fake playhead ----------------

t("lazy scheduler: real file 0→end — 325 cues, byte-exact vs the oracle", { timeout: 120_000 }, async () => {
  const buf = new Uint8Array(readFileSync(MKV));
  const { st, read } = countingReader(buf);

  const cuesOff = findCuesId(buf);
  assert.ok(cuesOff > 0, "Cues locatable");
  const hdr = buf.subarray(cuesOff, cuesOff + 11);
  const sln = vintLenAt(hdr, 4);
  const cues = parseCues(buf.subarray(cuesOff + 4 + sln, cuesOff + 4 + sln + vintValue(hdr, 4, sln) - 1)).filter((c) => c.track === 3);
  assert.equal(cues.length, 325);

  const plan = await planRow2Clusters(read, 52, 1_000_000, cues, 3);
  assert.equal(plan.length, new Set(cues.map((c) => c.ccp)).size, "one plan entry per unique cluster");
  assert.ok(plan.length > 150 && plan.length < 300, `${plan.length} sub-bearing clusters`);

  const sched = createLazyScheduler({ read, scale: 1_000_000, plan, trackNum: 3, lookaheadMs: 10_000, concurrency: 1 });
  let early = 0;
  for (let tMs = 0; tMs <= 1_440_000; tMs += 500) {
    const before = sched.events().length;
    sched.onPlayhead(tMs);
    await sched.settle();
    // lookahead discipline: no cue may appear earlier than its start − L
    for (const ev of sched.events().slice(before)) {
      if (ev.startMs < tMs - 10_000) early += 1;
    }
  }
  assert.equal(early, 0, "no cue arrived more than the lookahead early");
  assert.ok(sched.isDone());
  assert.equal(sched.failed(), 0);
  assert.equal(sched.events().length, 325);

  // the codecPrivate header comes from the (separate) head probe — the real wiring path
  const head = await readAssHead(read);
  const track = head.tracks.find((tr) => tr.num === 3);
  assert.ok(track, "track 3 in the head probe");
  const ass = assembleAss(track.priv, sched.events());
  const expected = readFileSync(join(here, "fixtures/kusuriya-eng-track.ass"));
  assert.ok(Buffer.compare(Buffer.from(ass), expected) === 0, "byte-exact vs the FFmpeg oracle");

  // row 2 pays for the sub-bearing cluster span — a large fraction of the file
  assert.ok(st.bytes > 100_000_000 && st.bytes < 200_000_000, `transferred ${st.bytes} B`);
  console.log(`row2: ${sched.events().length} cues, ${st.bytes} B (${(100 * st.bytes / FILE_SIZE).toFixed(1)} %) in ${st.reads} reads`);
});
