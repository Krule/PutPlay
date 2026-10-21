// I4 (wiring) — the pure functions behind the row-routed raw-ASS upgrade:
//   - fetchCues      (cues.ts)      — the Cues element by file offset
//   - routeRawAss    (ass-route.ts) — validate → row 1 | row 2 | row 3
//   - mergeUpgradedCues (subs.ts)   — row 2's per-window twin replacement
// The DOM-bound glue (MediaEngine.probeRawAss, the Player's playhead drive)
// is pinned as a source contract in sub-raw.test.mjs.
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { probeHeader } from "../src/putio/probe.ts";
import { fetchCues } from "../src/putio/cues.ts";
import { routeRawAss } from "../src/putio/ass-route.ts";
import { mergeUpgradedCues } from "../src/putio/subs.ts";

const here = new URL(".", import.meta.url).pathname;
const realFile = "/tmp/kusuriya2.mkv";
const REAL_SIZE = 218_005_732; // verified bit-identical to the live put.io stream

// ---------------- EBML builders (self-contained, like the other suites) ---

const enc = (s) => new TextEncoder().encode(s);
const be = (n, len) => {
  const o = new Uint8Array(len);
  for (let i = 0; i < len; i++) o[len - 1 - i] = (n >> (8 * i)) & 0xff;
  return o;
};
const concat = (arrs) => {
  const t = arrs.reduce((a, b) => a + b.length, 0);
  const o = new Uint8Array(t);
  let k = 0;
  for (const a of arrs) {
    o.set(a, k);
    k += a.length;
  }
  return o;
};
const vintSize = (n) => (n < 0x80 ? Uint8Array.of(0x80 | n) : be(0x4000 | n, 2));
const idBytes = (id) =>
  id < 0x100 ? Uint8Array.of(id) : id < 0x10000 ? be(id, 2) : id < 0x1000000 ? be(id, 3) : be(id, 4);
const elem = (id, ...p) => {
  const pl = p.reduce((a, b) => a + b.length, 0);
  return concat([idBytes(id), vintSize(pl), ...p]);
};
const intElem = (id, n, len) => elem(id, be(n, len));
const blockBody = (track, rel, data) =>
  concat([Uint8Array.of(0x80 | track), be(rel, 2), enc(data)]);

const countingReader = (buf) => {
  const st = { reads: 0, bytes: 0 };
  const read = (s, e) => {
    const out = buf.slice(s, e + 1);
    st.reads += 1;
    st.bytes += out.length;
    return Promise.resolve(out);
  };
  return { st, read };
};

// ---------------- T1: fetchCues on the real file ---------------------------

test("fetchCues: the Cues element by file offset (real file)", { timeout: 60_000 }, (t) => {
  if (!existsSync(realFile) || statSync(realFile).size !== REAL_SIZE) return t.skip();
  const FILE = new Uint8Array(readFileSync(realFile));
  const { st, read } = countingReader(FILE);
  return probeHeader(read).then((r) => {
    assert.equal(r.cuesFileOffset, 0x0cfd2cfb, "the probe found the Cues offset");
    const before = { reads: st.reads, bytes: st.bytes };
    return fetchCues(read, r.cuesFileOffset).then((cues) => {
      // two reads: the 12 B header (ID + size vint) and the payload
      assert.equal(st.reads - before.reads, 2, "header read + payload read");
      assert.ok(
        st.bytes - before.bytes < 100_000,
        `the Cues element is small (${st.bytes - before.bytes} B)`,
      );
      const eng = cues.filter((c) => c.track === 3);
      assert.equal(eng.length, 325, "the English track is fully cued");
      for (const c of eng) {
        assert.ok(c.rel !== null, "every English cue carries an in-cluster offset");
        assert.ok(c.dur !== null, "every English cue carries a duration");
      }
      // the first English cue (verified against the real bytes)
      assert.equal(eng[0].t, 6400);
      assert.equal(eng[0].ccp, 0x5d0dc1); // + 52 = 0x5D0DF5, cluster #3's ID offset (hexdump-verified)
      assert.equal(eng[0].rel, 293943);
      assert.equal(eng[0].dur, 7130);
    });
  });
});

// ---------------- T2: routeRawAss row 1 on the real file -------------------

test("routeRawAss: valid Cues → row 1, byte-exact (real file)", { timeout: 120_000 }, (t) => {
  if (!existsSync(realFile) || statSync(realFile).size !== REAL_SIZE) return t.skip();
  const FILE = new Uint8Array(readFileSync(realFile));
  const { st, read } = countingReader(FILE);
  return probeHeader(read).then((r) => {
    const track = r.assTracks.find((x) => x.num === 3);
    assert.ok(track, "the English track is in the probe's track table");
    return fetchCues(read, r.cuesFileOffset).then((cues) =>
      routeRawAss({
        read,
        segStart: r.segStart,
        scale: r.scale,
        cuesFileOffset: r.cuesFileOffset,
        fileSize: REAL_SIZE,
        cues,
        trackNum: 3,
        codecPrivate: track.priv,
      }).then((route) => {
        assert.equal(route.row, 1, "the reference file's Cues are fully valid");
        assert.equal(route.cues, 325);
        assert.equal(route.scale, 1_000_000);
        const gt = readFileSync(join(here, "fixtures/kusuriya-eng-track.ass"));
        assert.ok(
          Buffer.from(route.ass, "utf-8").equals(gt),
          "row 1 reassembles byte-exact vs the FFmpeg oracle",
        );
        assert.ok(
          route.ass.includes("Dialogue: 0,0:01:43.71,0:01:44.68,overlaptop,Father,0,0,0,,Open up!"),
          "the MPV-scene line is byte-exact",
        );
        // probe + Cues + validate + row 1: well under 1 MB total
        assert.ok(st.bytes <= 1_200_000, `total transfer ${st.bytes} B`);
      }),
    );
  });
});

// ---------------- T3/T4: the row-2 and row-3 routes (synthetic) ------------

// Two minimal clusters (track 1, rel_ts 100, 500 ms duration) + a Cues
// element. Geometry: cluster payload starts 5 B after the cluster ID
// (4 B ID + 1 B size vint); a valid in-cluster landing is at rel 10
// (6 B CRC element + 4 B ClusterTimestamp element).
const cluster = (cts, ro, text) =>
  elem(
    0x1f43b675,
    concat([
      elem(0xbf, be(0x11223344, 4)), // CRC — skipped as an element
      intElem(0xe7, cts, 2),
      elem(
        0xa0,
        elem(0xa1, blockBody(1, 100, `\x00${ro},0,Default,N${ro},0,0,0,,${text}`)),
        intElem(0x9b, 500, 2),
      ),
    ]),
  );

const cA = cluster(1000, 0, "alpha");
const cB = cluster(11000, 1, "beta");
const CL_A = 0;
const CL_B = cA.length;
const CP = enc(
  "[Script Info]\r\nTitle: T\r\n\r\n" +
    "[V4+ Styles]\r\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\r\n" +
    "Style: Default,Arial,16,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\r\n" +
    "\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n\r\n",
);

test("routeRawAss: good cluster offsets + corrupt rels (≤ 2 GiB) → row 2 with the cluster plan", () => {
  const file = concat([cA, cB]);
  const { read } = countingReader(file);
  // row-2 shape: the cluster offsets are right, the in-cluster rels are not
  const cues = [
    { t: 1100, track: 1, ccp: CL_A, rel: 9999, dur: 500 },
    { t: 11100, track: 1, ccp: CL_B, rel: 9999, dur: 500 },
  ];
  return routeRawAss({
    read,
    segStart: 0,
    scale: 1_000_000,
    cuesFileOffset: CL_A,
    fileSize: file.length,
    cues,
    trackNum: 1,
    codecPrivate: CP,
  }).then((route) => {
    assert.equal(route.row, 2, "cluster-only Cues are the row-2 state");
    assert.equal(route.plan.length, 2, "one plan entry per sub-bearing cluster");
    assert.equal(route.plan[0].ccp, CL_A);
    assert.equal(route.plan[0].windowStart, 1100, "the window opens at the earliest cue time");
    assert.equal(route.plan[1].windowStart, 11100);
    assert.equal(route.scale, 1_000_000);
    assert.equal(route.codecPrivate.length, CP.length, "the header ships with the plan");
    assert.equal(route.ass, undefined, "row 2 has no full .ass up front");
  });
});

test("routeRawAss: no cues for the track → row 3", () => {
  const file = concat([cA, cB]);
  const { read } = countingReader(file);
  const cues = [{ t: 1100, track: 5, ccp: CL_A, rel: 10, dur: 500 }];
  return routeRawAss({
    read,
    segStart: 0,
    scale: 1_000_000,
    cuesFileOffset: CL_A,
    fileSize: file.length,
    cues,
    trackNum: 1,
    codecPrivate: CP,
  }).then((route) => {
    assert.equal(route.row, 3, "nothing to route when the track has no cues");
    assert.equal(route.ass, undefined);
    assert.equal(route.plan, undefined);
  });
});

test("routeRawAss: untrusted labels (block track ≠ cue label) → row 3", () => {
  const file = concat([cA, cB]);
  const { read } = countingReader(file);
  // the landing is VALID (rel 10 → the track-1 block, time exact) but the
  // cue is LABELED track 5 — the labels cannot be trusted, so the cluster
  // selection (which uses the same labels) is poisoned too
  const cues = [{ t: 1100, track: 5, ccp: CL_A, rel: 10, dur: 500 }];
  return routeRawAss({
    read,
    segStart: 0,
    scale: 1_000_000,
    cuesFileOffset: CL_A,
    fileSize: file.length,
    cues,
    trackNum: 5,
    codecPrivate: CP,
  }).then((route) => {
    assert.equal(route.row, 3, "a landed-but-mislabeled block demotes the whole file");
  });
});

test("routeRawAss: corrupt rels + file over 2 GiB → row 3", () => {
  const file = concat([cA, cB]);
  const { read } = countingReader(file);
  const cues = [
    { t: 1100, track: 1, ccp: CL_A, rel: 9999, dur: 500 },
    { t: 11100, track: 1, ccp: CL_B, rel: 9999, dur: 500 },
  ];
  return routeRawAss({
    read,
    segStart: 0,
    scale: 1_000_000,
    cuesFileOffset: CL_A,
    fileSize: 2 * 1024 ** 3 + 1, // past the row-2 cap
    cues,
    trackNum: 1,
    codecPrivate: CP,
  }).then((route) => {
    assert.equal(route.row, 3, "row 2 is size-capped at 2 GiB (bandwidth, not correctness)");
  });
});

// ---------------- T5: mergeUpgradedCues (row 2's per-window merge) ---------

test("mergeUpgradedCues: an upgraded cue replaces its put.io twin; the rest stand", () => {
  const base = [
    { start: 1.0, end: 2.0, text: "plain one" },
    { start: 10.0, end: 11.0, text: "plain ten" },
  ];
  const up = [{ start: 1.0, end: 2.0, text: "styled one", styleName: "overlaptop" }];
  const out = mergeUpgradedCues(base, up);
  assert.equal(out.length, 2, "one replaced twin + one untouched base cue");
  assert.ok(out.some((c) => c.text === "styled one"), "the upgraded cue is in");
  assert.ok(out.some((c) => c.text === "plain ten"), "the non-matching base cue stands");
  assert.ok(
    !out.some((c) => c.text === "plain one"),
    "the replaced twin must not render twice (stacked text)",
  );
});

test("mergeUpgradedCues: the match is time-anchored within 50 ms, one twin per upgraded cue", () => {
  // 40 ms apart — inside the tolerance: replaced
  let out = mergeUpgradedCues(
    [{ start: 1.0, end: 2.0, text: "a" }],
    [{ start: 1.04, end: 2.04, text: "A" }],
  );
  assert.equal(out.length, 1, "within 50 ms the twins match");
  // 60 ms apart — outside: both stand
  out = mergeUpgradedCues(
    [{ start: 1.0, end: 2.0, text: "a" }],
    [{ start: 1.06, end: 2.06, text: "A" }],
  );
  assert.equal(out.length, 2, "outside 50 ms nothing is replaced");
  // a bilingual pair (same start, different ends): 2↔2, no cross-eating
  out = mergeUpgradedCues(
    [
      { start: 5.0, end: 6.0, text: "romaji" },
      { start: 5.0, end: 7.5, text: "trans" },
    ],
    [
      { start: 5.0, end: 6.0, text: "R" },
      { start: 5.0, end: 7.5, text: "T" },
    ],
  );
  assert.equal(out.length, 2, "each upgraded cue consumes exactly one twin");
  assert.ok(out.some((c) => c.text === "R") && out.some((c) => c.text === "T"));
});

test("mergeUpgradedCues: re-merging a growing set is stable", () => {
  const base = [
    { start: 1.0, end: 2.0, text: "a" },
    { start: 3.0, end: 4.0, text: "b" },
    { start: 5.0, end: 6.0, text: "c" },
  ];
  const m1 = mergeUpgradedCues(base, [{ start: 1.0, end: 2.0, text: "A" }]);
  const m2 = mergeUpgradedCues(m1, [
    { start: 1.0, end: 2.0, text: "A" },
    { start: 3.0, end: 4.0, text: "B" },
  ]);
  assert.equal(m2.length, 3, "still one cue per time slot after the second window lands");
  assert.ok(
    m2.some((c) => c.text === "A") && m2.some((c) => c.text === "B") && m2.some((c) => c.text === "c"),
  );
});
