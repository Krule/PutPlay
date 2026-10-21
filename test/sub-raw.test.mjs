// T3 data path: raw ASS demuxed from the MKV stream → full-fidelity subs.
//
// Background: put.io's /subtitles conversion strips ASS styling from the
// MKV-embedded tracks (only a leading {\an8} survives). This feature demuxes
// the raw ASS track straight from the ORIGINAL stream (demuxAssTrack —
// verified byte-exact against the FFmpeg oracle in ass-demux.test.mjs) and
// feeds it into the overlay chain the sub-styling feature already proved:
//   probe (existing 64 KB head window) → per-track name/lang table →
//   map put.io's embedded entries onto Matroska track numbers →
//   demux the raw .ass on demand → parseAssCues (rich: style, segments,
//   positions) + parseAssStyles → the styled overlay.
// OpenSubtitles/folder tracks are untouched (they stay put.io's SRT).
//
// Contract (outer):
//  - probeHeader exposes `assTracks: [{num, name, lang}]` for every ASS
//    subtitle track — zero extra transfer (the Tracks element is already
//    inside the existing 64 KB head window).
//  - MediaEngine publishes `subAssTracks` and offers `loadRawAss(num)`,
//    which demuxes the track over a Range-fetch reader on streamURL —
//    non-fatal: any failure degrades to the put.io cues (null).
//  - Player maps each embedded (source "mkv") subtitle onto a Matroska
//    track and upgrades its cues in the background with the demuxed raw
//    ASS — with a coverage guard: never replace N cues with fewer than N.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { probeHeader } from "../src/putio/probe.ts";
import { demuxAssTrack } from "../src/putio/ass-demux.ts";
import { matchAssTrack, shouldUpgradeCues } from "../src/putio/subs.ts";
import { parseAssCues, parseAssStyles } from "../src/putio/substyle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (p) => readFileSync(join(here, "..", p), "utf8");

const HEAD64K = new Uint8Array(readFileSync(join(here, "fixtures/kusuriya-head-64k.bin")));
const realFile = "/tmp/kusuriya2.mkv";
const REAL_SIZE = 218_005_732; // verified bit-identical to the live put.io stream

// ---------------- T1: the probe exposes the ASS track table ---------------

test("probe: assTracks lists every ASS subtitle track with num/name/lang", () => {
  let bytes = 0;
  const rangeRead = (start, end) => {
    const out = HEAD64K.slice(start, end + 1);
    bytes += out.length;
    return Promise.resolve(out);
  };
  return probeHeader(rangeRead).then((r) => {
    assert.ok(Array.isArray(r.assTracks), "probeHeader must expose assTracks");
    assert.equal(r.assTracks.length, 10, "the Kusuriya file has 10 ASS subtitle tracks");
    const eng = r.assTracks.find((t) => t.num === 3);
    assert.ok(eng, "the English track (num 3) must be in the table");
    assert.equal(eng.name, "CR_English", "name is the container's TrackName, not the put.io label");
    assert.equal(eng.lang, "eng");
    // the file carries TWO Spanish tracks — the mapping must disambiguate by name
    assert.equal(
      r.assTracks.filter((t) => t.lang === "spa").length,
      2,
      "two spa tracks (Latin America + Spain)",
    );
    for (const t of r.assTracks) {
      assert.ok(t.num >= 1, `track entry has a number: ${JSON.stringify(t)}`);
      assert.equal(typeof t.name, "string");
      assert.equal(typeof t.lang, "string");
    }
    // The Tracks element is inside the existing 64 KB head window — the
    // track table must cost no extra transfer.
    assert.ok(bytes <= 65536, `track table stayed in the head window (${bytes} B read)`);
  });
});

// ---------------- T1b: the probe exposes the Cues offset --------------------
// The row-1 upgrade fetches the Cues element by file offset. The probe already
// walks the SeekHead (MetaSeek), so the Cues offset must come out of it —
// Cues is NOT reliably the file's last element (e.g. IETF test5 has Tags after).

test("probe: cuesFileOffset is the Cues element's file offset from SeekHead", async () => {
  const rangeRead = (start, end) => Promise.resolve(HEAD64K.slice(start, end + 1));
  const r = await probeHeader(rangeRead);
  // SeekHead entry: SeekID 1C53BB6B → SeekPosition 0x0CFD2CC7 (segment-relative);
  // file offset = value + segStart (52) = the Cues element ID's position.
  assert.equal(r.cuesFileOffset, 0x0cfd2cfb, "SeekPosition + segStart = Cues file offset");
});

// minimal synthetic head: EBML + Segment + SeekHead (one non-Cues entry) + empty Tracks
const be32 = (n, len) => {
  const o = new Uint8Array(len);
  for (let i = 0; i < len; i++) o[len - 1 - i] = (n >> (8 * i)) & 0xff;
  return o;
};
const vintSize32 = (n) => (n < 0x80 ? Uint8Array.of(0x80 | n) : be32(0x4000 | n, 2));
const idBytes32 = (id) =>
  id < 0x100 ? Uint8Array.of(id) : id < 0x10000 ? be32(id, 2) : id < 0x1000000 ? be32(id, 3) : be32(id, 4);
const concat32 = (arrs) => {
  const t = arrs.reduce((a, b) => a + b.length, 0);
  const o = new Uint8Array(t);
  let k = 0;
  for (const a of arrs) {
    o.set(a, k);
    k += a.length;
  }
  return o;
};
const elem32 = (id, ...p) => {
  const pl = p.reduce((a, b) => a + b.length, 0);
  return concat32([idBytes32(id), vintSize32(pl), ...p]);
};

test("probe: cuesFileOffset is null when SeekHead has no Cues entry", async () => {
  const seek = elem32(0x4dbb, elem32(0x53ab, be32(0x1654ae6b, 4)), elem32(0x53ac, be32(0x30, 2)));
  const seekHead = elem32(0x114d9b74, seek);
  const segment = elem32(0x18538067, seekHead, elem32(0x1654ae6b));
  const ebml = elem32(0x1a45dfa3, Uint8Array.of(0));
  const buf = concat32([ebml, segment]);
  const rangeRead = (start, end) => Promise.resolve(buf.slice(start, end + 1));
  const r = await probeHeader(rangeRead);
  assert.equal(r.cuesFileOffset, null, "no Cues seek entry → null (caller falls back)");
  assert.equal(r.assTracks.length, 0, "empty Tracks → empty assTracks");
});

// ---------------- T3: MediaEngine wiring (source contract) ----------------

// ---------------- I2: the track mapping (pure) -----------------------------
// put.io exposes only SOME embedded tracks as converted .srt files, and its
// `name` is the converted file's filename ("…-eng.srt") — never the
// container's TrackName ("CR_English"). So language_code is the key, and the
// name is only a hint for same-language ties. Ambiguous → null → the caller
// keeps the put.io file (never a wrong-language swap).

const TRACKS_REAL = [
  { num: 3, name: "CR_English", lang: "eng" },
  { num: 4, name: "CR_Portuguese(Brazil)", lang: "por" },
  { num: 5, name: "CR_Spanish(Latin_America)", lang: "spa" },
  { num: 6, name: "CR_Spanish", lang: "spa" },
  { num: 7, name: "CR_Arabic", lang: "ara" },
  { num: 8, name: "CR_French", lang: "fre" },
  { num: 9, name: "CR_German", lang: "ger" },
  { num: 10, name: "CR_Italian", lang: "ita" },
  { num: 11, name: "CR_Russian", lang: "rus" },
  { num: 12, name: "CR_Polish", lang: "pol" },
];

test("matchAssTrack: unique language maps straight to the track", () => {
  // the real put.io entries for this file (converted-file names, source mkv)
  assert.equal(
    matchAssTrack(
      { languageCode: "eng", name: "[Onalrie] Kusuriya no Hitorigoto - S03E03 [1080p WEBRip AV1]-eng.srt" },
      TRACKS_REAL,
    ),
    3,
  );
  assert.equal(matchAssTrack({ languageCode: "ger", name: "…-ger.srt" }, TRACKS_REAL), 9);
});

test("matchAssTrack: same-language tie without a name hint is null (keep the put.io file)", () => {
  assert.equal(
    matchAssTrack({ languageCode: "spa", name: "…-spa.srt" }, TRACKS_REAL),
    null,
    "two spa tracks, no disambiguating name → never guess",
  );
});

test("matchAssTrack: a same-language tie resolves when the entry names the track", () => {
  const tracks = [
    { num: 5, name: "Spanish(LatAm)", lang: "spa" },
    { num: 6, name: "Spanish", lang: "spa" },
  ];
  assert.equal(matchAssTrack({ languageCode: "spa", name: "show-Spanish(LatAm)-subs.srt" }, tracks), 5);
  assert.equal(matchAssTrack({ languageCode: "spa", name: "show-plain.srt" }, tracks), null);
});

test("matchAssTrack: unknown language, missing code, or no tracks are all null", () => {
  assert.equal(matchAssTrack({ languageCode: "jpn", name: "x.srt" }, TRACKS_REAL), null);
  assert.equal(matchAssTrack({ name: "x.srt" }, TRACKS_REAL), null);
  assert.equal(matchAssTrack({ languageCode: "eng" }, []), null);
});

test("shouldUpgradeCues: the raw-ASS upgrade never loses cue coverage", () => {
  assert.equal(shouldUpgradeCues(325, 325), true, "same coverage → the styling wins");
  assert.equal(shouldUpgradeCues(325, 324), false, "fewer fresh cues → keep the fallback");
  assert.equal(shouldUpgradeCues(325, 326), true);
  assert.equal(shouldUpgradeCues(0, 325), true, "no fallback cues → any demux wins");
  assert.equal(shouldUpgradeCues(0, 0), false, "an empty demux is no upgrade");
});

test("MediaEngine: publishes subAssTracks from the probe and offers loadRawAss", () => {
  const media = readSrc("src/putio/media.ts");
  assert.ok(/subAssTracks/.test(media), "MediaEngine state must carry subAssTracks");
  assert.ok(
    /onState\(\s*\{[^}]*subAssTracks/.test(media),
    "the probe result's track table must be published via onState"
  );
  const raw = media.slice(media.indexOf("loadRawAss("));
  assert.ok(raw.length > 0, "MediaEngine must offer loadRawAss(trackNum)");
  assert.ok(
    /demuxAssTrack\(/.test(raw),
    "loadRawAss must demux via demuxAssTrack (the byte-exact cluster walk)"
  );
  assert.ok(
    /rangeReader\(\)/.test(raw),
    "loadRawAss must read through the engine's stream range reader"
  );
  const reader = media.slice(media.indexOf("rangeReader():"));
  assert.ok(
    /Range/.test(reader) && /streamURL\(/.test(reader),
    "the range reader must issue Range requests on streamURL"
  );
});

// ---------------- T4: Player wiring (source contract) ---------------------

test("Player: maps embedded subs onto tracks and upgrades with raw ASS", () => {
  const player = readSrc("src/ui/screens/Player.svelte");
  assert.ok(
    /subAssTracks\s*=\s*p\.subAssTracks/.test(player),
    "the Player must sync subAssTracks from the engine state"
  );
  assert.ok(
    /matchAssTrack\(/.test(player),
    "embedded (source mkv) subs must be matched onto Matroska tracks"
  );
  assert.ok(
    /loadRawAss\(/.test(player),
    "the Player must request the raw ASS demux for matched tracks"
  );
  assert.ok(
    /parseAssCues\(/.test(player),
    "the demuxed .ass must be parsed into rich cues (parseAssCues), not stripped"
  );
  assert.ok(
    /shouldUpgradeCues\(/.test(player),
    "the cue upgrade must be coverage-guarded (never fewer cues than the fallback)"
  );
});

// ---------------- T5: full data chain on the real file --------------------

test("data chain: demuxed ASS → rich cues with the file's own styling", { timeout: 120_000 }, () => {
  if (!existsSync(realFile) || statSync(realFile).size !== REAL_SIZE) {
    return Promise.resolve(); // the ground-truth file is not on this machine
  }
  const buf = readFileSync(realFile);
  const rangeRead = (start, end) => Promise.resolve(buf.slice(start, end + 1));
  return demuxAssTrack(rangeRead, 3).then(({ ass }) => {
    const text = new TextDecoder().decode(ass);
    const table = parseAssStyles(text);
    assert.ok(table, "the demuxed .ass carries the file's own [V4+ Styles]");
    assert.ok(table.styles.length >= 10, "real style table (10+ styles), not a stub");
    const cues = parseAssCues(text);
    assert.equal(cues.length, 325, "all 325 cues parsed from the demuxed track");

    // The MPV-scene line: style, times and text intact end to end.
    const pin = cues.find((c) => c.text.includes("Open up!"));
    assert.ok(pin, "the 0:01:43.71 'Open up!' cue must survive the chain");
    assert.equal(pin.styleName, "overlaptop");
    assert.equal(pin.start, 103.71);
    assert.equal(pin.end, 104.68);

    // The title card keeps its dedicated style + inline effects.
    const first = cues[0];
    assert.equal(first.styleName, "Title");
    assert.equal(first.start, 6.4);
    assert.ok(first.segments && first.segments.length > 0, "inline override tags are parsed");
  });
});
