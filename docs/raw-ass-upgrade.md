# Raw-ASS subtitle upgrade — design (lazy, row-routed)

Status: shipped in v1.2.3 (2026-10-22). Gates cleared: E2 (6-file Cues audit, §7) on 2026-10-21; E1's
in-page ranged fetch verified on the TV during the on-device check. Build plan §8 executed (I1–I3 +
wiring); the measured CDN transport quirks now live in `src/putio/multirange.ts`.
Supersedes the v1.2.2-staged "background demux-everything" strategy; reuses all of its machinery.

## 1. Problem & base layer

put.io's `/subtitles` API strips ASS styling from embedded tracks (only a leading
`{\an8}` survives) — embedded ASS arrives as plain SRT. Shipped (v1.2.2, staged) the
64 KB head probe extracts the container's `CodecPrivate` = the full `.ass` header +
`[V4+ Styles]`, so the overlay is **already styled** (fonts, colours, outlines,
positions) via put.io SRT + that table. The raw demux buys only what's missing:
per-cue inline effects (`\fad`, `\clip`, `\pos`, karaoke) and the file's exact
original timing/text — a **polish layer**, not the base.

FFmpeg's ass muxer is the byte-exact oracle. Ground truth:
`test/fixtures/kusuriya-eng-track.ass` (md5 `10e8749b88071123387c8947a5059ebc`,
31,337 B, 325 Dialogue lines, source file `/tmp/kusuriya2.mkv`, 218,005,732 B).

## 2. Transport reality (measured)

- **Element-level walk** (`demuxAssTrack`, staged): 411,010 sequential reads,
  798,454 B = 0.37 % of the file. Byte-cheap but **request-infeasible on a real
  CDN** — the walk has a serial frontier (each header reveals the next offset), so
  reads = strictly-sequential HTTP requests ≈ 11 h at 100 ms RTT + CDN rate-limit
  risk. **Retired from the production path; kept as reference + parity oracle.**
- **CDN** (CDN77-Turbo, s104-cdn77.put.io): CORS **reflector** — echoes any
  `Origin`, `access-control-allow-credentials: true`, `Range` in allowed headers,
  preflight 200 with `max-age: 86400` ⇒ in-page ranged `fetch` is CORS-clean (webview
  verification = gate E1). Multi-range: 200 × 5 B ranges → 206 in 0.33 s, parts in
  request order; 2,000 ranges → request too large ⇒ **batch cap ≈ 200 ranges/request**.
- **Container facts** (Kusuriya file; muxer Lavf63 quirks verified): segment payload
  starts at byte 52; `SeekPosition`/`CueClusterPosition` are segment-relative
  (**+52 rule**, compute 52 from the EBML header, never hardcode); 8-byte size vints
  are `2^56 + N` (low 32 bits = N); 553 clusters span `0x4D5987` → Cues `0xCFD2CFB`;
  all 325 English blocks are BlockGroups with `0x9B` duration (TimestampScale = 1 ms);
  block payload = `[0x00]["F0,F1,style,name,ML,MR,MV,Effect,Text"]` where F0 =
  readorder, F1 = layer; rel-ts is plain 2-byte big-endian (not a vint); lines are
  emitted in readorder, not pts order.
- **Cues in this file are FULLY VALID** (verified 2026-10-21 after the audit
  parser was fixed — an earlier "half-broken" reading was an artifact of a
  size-vs-value bug in the validator script, not of the file): 3,613 CuePoints;
  every subtitle block cued exactly once (English = 325/325, labels = true track
  numbers); video cues = 277 (keyframes only). Empirical check, all 325 English
  cues: `CueClusterPosition + 52` → cluster ID `1F 43 B6 75` (325/325);
  `cluster_payload_start + CueRelativePosition` → the block element ID itself
  (325/325 `0xA0` BlockGroups); track vint & 0x7F = label (325/325);
  `cts + rel_ts − CueTime` = 0 ms (max). **Verified Cues semantics**:
  `CueRelativePosition` is measured from the **cluster payload start** (cluster ID
  + 4 + size-vint length) and points at the block's **element ID** (`0xA0`/`0xA3`),
  not at the track vint; for `0xA0` the track vint sits behind the nested `0xA1`
  element; `CueTime`/`CueDuration` are absolute, in TimestampScale units — **row 1
  needs no cluster prefix fetch at all** (start = `tsToMs(CueTime)`, end =
  `tsToMs(CueTime + CueDuration)`). Cluster prefixes begin with an **optional
  `0xBF` CRC-32 element** (present in this file; skip as an element, never assume a
  fixed width), then `0xE7` ClusterTimestamp.

## 3. The ladder (design)

| Row | Qualification (validator §4) | Action | Requests | Bytes |
|---|---|---|---|---|
| **1** | Cues fully valid (cluster **and** block landing) | batch-range the sub-blocks, swap in at once | ~2 (325 cues) – ~17 (2000) | O(cues): 80 KB – ~1 MB, **flat — no size cap** |
| **2** | cluster offsets valid, in-cluster garbage | **lazy** sub-cluster fetch, playhead-paced | ~220 (218 MB file) – ~1,900 (2 GiB) | f·F, f≈0.4–0.7 → ≤ ~0.8–1.4 GB **only because file ≤ 2 GiB** |
| **3** | no Cues / clusters unvalidated / file > 2 GiB | nothing extra — base layer stands | 0 | 0 |

**Base layer (always, shipped v1.2.2):** put.io SRT cues + CodecPrivate style table,
0 extra bytes. It is both the instant base and, in row 2, **the index** (its cue
times say which clusters contain subtitle data). Routing is per put.io track:
each track is routed independently through its own Cues label (§4c).

### Row 1 — fully valid Cues

- Fetch: multi-range, ≤200 ranges/request. Per cue: one range
  `[cluster_payload_start + rel, cluster_payload_start + rel + 1024]` (1 KB margin
  — Cues carry duration in *time*, not bytes; the block's own size vint terminates
  the payload; a rare >1 KB block gets one follow-up range).
- No cluster prefixes needed: `start = tsToMs(CueTime)`, `end = tsToMs(CueTime +
  CueDuration)` (verified 0 ms error across all 325 cues of the reference file).
- Parse with the existing `parseAssBlock`/`assembleAss` (byte-exact parity with the
  oracle is what `test/ass-demux.test.mjs` pins) — block layout: `0xA0`{`0xA1`
  [track vint][2B rel-ts][payload]} + `0x9B` duration, or `0xA3`[track vint][2B
  rel-ts][payload]; strip the one leading `0x00`.
- Merge: full replacement, guarded by `shouldUpgradeCues` (fresh ≥ existing).
- Scale: 2000 cues / 50 GB / 2 h → ~17 requests, ~0.5–1 MB. **Flat at any file size.**

### Row 2 — validated cluster offsets, file ≤ 2 GiB

- **Prune** (free): a cluster is fetchable-iff a put.io SRT cue time falls inside
  its `CueTime` window → ~220 of 553 clusters for the 218 MB file.
- **Scheduler** (in `Player.svelte`, which owns `currentTime`): when the playhead
  is within L s of a pruned window → one ranged fetch of the whole cluster
  (~500–660 KB avg) → `collectClusterEvents(r, start, end, scale, trackNum)`
  (local CPU, already built + unit-tested) → per-window merge → **discard the
  bytes** (keep parsed cues). One cluster fetch upgrades **every** mapped track
  sharing it (eng+ger free).
- **Throttle:** cap the background queue at ~1–2 Mbps (tunable). If the queue
  trails, it simply degrades to the base layer — the failure mode is *the shipped
  state*, never a broken overlay.
- **Cap:** `file.size ≤ 2 GiB`, measurable up front (put.io file metadata; also
  derivable from the probe's segment-size vint low bits). 2 GiB keeps worst-case
  background ≤ ~1.4 GB ≈ ≤0.8× playback bytes and lands exactly on the content
  boundary (episodes/1080p rips under; 4K rips over — those still get row 1 if
  their Cues are valid).
- **Merge:** per-window — cues from a landed cluster replace base-layer cues whose
  times fall in that cluster's window (new rule; `shouldUpgradeCues` stays for row 1).
- **Seek:** binary-search the cluster map; forward seeks fetch ~1 cluster (base
  layer covers the gap); backward seeks are instant (cues cached).

## 4. Validator (decides the row; ~40 tiny reads, one-time, background)

Inputs: Cues offset from the **SeekHead** (in the 64 KB head we already fetch;
tail-scan fallback if absent), Cues payload (one bounded range, ~100 KB), the
track table (`probe.assTracks`), and the put.io SRT cue times for mapped tracks.

1. **Cluster check** — for ~10 unique `CueClusterPosition`s: fetch 4 B at
   `value + 52`, expect `1F 43 B6 75`. Pass ⇒ row 2 eligible.
2. **Block check** — for ~5–8 cues: fetch ~12 B at `cluster_payload_start + rel`
   (payload start = `ccp + 52 + 4 + len(size vint)`): first byte `0xA0` (then inner
   `0xA1`, track vint behind it) or `0xA3` (track vint directly); track vint & 0x7F
   = label; `cts + rel_ts ≈ CueTime` (cts from the cluster prefix, CRC element
   skipped properly). Pass ⇒ row 1 eligible.
3. **Label→track** — the sampled block's track vint *is* the real track number;
   vint = label ⇒ label IS the container track number (language known from the
   probe's track table — no correlation needed; this held on all six audited
   files). vint ≠ label ⇒ **demote to row 3** for that track (safe default;
   an SRT-time-correlation resolver for shifted labels is a possible later
   refinement, out of I1 scope).

Verdict per track: all pass → **row 1**; cluster passes, block fails → **row 2**
(if ≤2 GiB, else row 3); else → **row 3**. Demotion is one-way (1→2→3).

## 5. Cost model (scaling laws)

- **Requests ∝ duration** for rows 1–2 (cluster count cancels against batching /
  pacing): 2 h / 50 GB → ~17 (row 1) or ~1,350 (row 2) — manageable at any scale.
- **Bytes: row 1 is O(cues)** (flat); row 2 is **f·F** with f≈0.4–0.7, and the
  cluster count cancels: `(f·N_cl) × (F/N_cl) = f·F` — robust to muxer cadence.
  2 GiB cap ⇒ ≤ ~1.4 GB; 50 GB uncapped would be ~20–35 GB (why the cap exists).
- Element walk is O(F) in **requests** (~100 M at 50 GB) — dead; never element-walk
  a live stream.
- Bottleneck flips with size: small files request-limited, big files
  bandwidth-limited. "Always full ASS" dies at scale — the base layer is the floor,
  and at 50 GB with bad Cues the right answer is row 3 (or row 1 if Cues are valid:
  0.5 MB vs ~half the file, a ~40,000–70,000× gap that grows with size).

## 6. What gets retired (in the follow-up commit)

- `Player.svelte` `scheduleRawAssUpgrade`/`upgradeSub` unconditional
  demux-everything trigger → replaced by validator-routed rows 1/2 (trigger point,
  staleness guards, live `activeSub` swap, per-track style table: all reused).
- `loadRawAss` / `demuxAssTrack` production calls (functions + their byte-exact
  outer test **stay** as the parity oracle).
- `test/sub-raw.test.mjs` T3/T4 source-regexes → re-pin to the new scheduler.
- CHANGELOG `[Unreleased]` sentence → reword to the row-routed behaviour
  (valid-Cues files: a couple of tiny requests; cluster-validated ≤2 GiB: paced to
  playback; otherwise the styled SRT stands). Fixed before any tag.

## 7. Evidence gates (before build; no app code)

- **E1 — on-device smoke test** (10 lines, one TV session, critical path: rows 1–2
  both ride on in-page ranged fetch):
  `fetch(streamURL, {headers:{Range:"bytes=0-65535"}})` → log status + first bytes
  (expect 206 + `1A 45 DF A3`). Plus the MSE north-star probe:
  `MediaSource.isTypeSupported` for `video/mp4; codecs="avc1.42E01E,mp4a.40.2"`
  (control, expect true), `video/webm; codecs="vp9,opus"` (control),
  `video/mp4; codecs="av01.0.05M.08,mp4a.40.2"` and
  `video/webm; codecs="av01.0.05M.08,opus"` (expect false on this webview — AV1
  MSE is the gate on the future zero-byte tap). If the in-page fetch fails, rows
  1–2 die and the already-shipped base layer stands — pure de-risking either way.
- **E2 — 6-file Cues audit — DONE 2026-10-21.** All six files (1615911660,
  1614058473, 1617596622, 1618364461, 1618364460, 1615182727): cluster offsets
  12/12, block landing 40/40, label = true track number, `|block-start − CueTime|`
  max 0 ms. Cues counts 1,192–37,266. **No file is half-broken** — row 2 is a
  safety net for a pattern absent from this sample (its I1 fixture is synthetic).
  ASS tracks exist only in the three fansub rips (1618364461: 9 tracks, up to 453
  cues; 1618364460: 10 tracks; 1615182727: 1 track, 151 cues — H.264, the
  MSE-tap candidate) → all **row 1** (max ~3 requests / ~60 KB each). The other
  three (4K HEVC rips, S_TEXT/UTF8 and PGS subs) have no ASS to upgrade — base
  layer is the final state there. Consequence: the validator still ships (cheap
  insurance, and the row-1 precondition), but row 1 is the shipping path.
  Note: S_TEXT/UTF8 cues are equally valid — the row-1 transport is
  codec-agnostic (future: embedded UTF8 fetch could replace put.io-converted SRT
  byte-for-byte too; not in scope).

## 8. Build plan (TDD, after E1/E2)

- **I1 validator — DONE** (`cues.ts`, 9 tests): `parseCues` (one
  `CueEntry` per CuePoint × CueTrackPosition) + `validateCues` → row 1/2/3
  (cluster header sample ×12, block-landing sample ×8, label-vs-vint check,
  2 GiB cap). Real file: row 1, 35 reads.
- **I2 row 1 batcher — DONE** (`ass-demux.ts: demuxAssRow1`, 4 tests):
  two phases — 12 B per unique cluster (size vint), then one windowed
  fetch per cue (1 KB margin, size vint terminates, one follow-up if
  exceeded); times from CueTime/CueDuration. Real file: 325 cues,
  492,626 B (0.23 %), 584 reads, byte-exact vs the oracle.
- **I3 row 2 scheduler — DONE** (`ass-row2.ts`, 6 tests):
  `planRow2Clusters` (one 12 B read per unique sub-bearing cluster, sorted
  by earliest cue) + `createLazyScheduler` (lookahead L, concurrency
  throttle, per-cluster fetch → local walk → merge, discard bytes, failed
  clusters skipped, backward seeks free). Integration: real 218 MB file,
  fake playhead 0→end → 325 cues byte-exact vs the oracle at 145,040,459 B
  (66.5 %) in 441 reads.
- **I4 wiring** — validator on subtitle-list arrival → route; retire `upgradeSub`;
  re-pin T3/T4 regexes; CHANGELOG reword. Outer pins: row 1 ≤ ~1 MB + ~17
  requests; row 2 ≤ ~150 MB across a full fake watch of the 218 MB file.

## 9. Open questions

- L (lookahead seconds) and the throttle constant — pick from E1/E2 link data.
- Row 2 default: auto-on for ≤2 GiB vs. a user setting (leaning auto-on:
  self-throttling, degrades to the base layer).
- Multi-track queue sharing details (one fetch serves all mapped tracks in the
  window — dedupe by cluster offset in the scheduler).
- MSE tap = separate future milestone (zero extra bytes), gated by E1's AV1
  probe; H.264 files (e.g. 1615182727) would be the first candidate.
