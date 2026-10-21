# Raw-ASS subtitle upgrade — design (lazy, row-routed)

Status: design converged 2026-10-21. Awaiting evidence gates E1/E2 (§7). Build plan §8.
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
- **Cues in this file are half-broken** (the warning case): cluster offsets valid
  (all 323 verified), in-cluster `CueRelativePosition` garbage (lands 32–1,865 B
  past the real block), track labels shifted (English cues labeled track 12),
  323/325 entries. **Never trust an index that isn't validated.**

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
  `[claimed_offset, claimed_offset + 1024]` (1 KB margin — Cues carry duration in
  *time*, not bytes; the block's own size vint terminates the payload; a rare
  >1 KB block gets one follow-up range).
- Include the unique cluster prefixes (`0xE7` cts) in the same batches
  (start = cts + rel_ts; ~220–1,400 prefixes at these sizes).
- Parse with the existing `parseAssBlock`/`assembleAss` (byte-exact parity with the
  oracle is what `test/ass-demux.test.mjs` pins).
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
2. **Block check** — for ~5–8 cues: fetch ~10 B at `cluster + rel`: first byte
   `0x80|track`, rel-ts parseable, and `cts + rel_ts ≈ CueTime` (± small ε).
   Pass ⇒ row 1 eligible.
3. **Label→track / label→language** — the sampled block's first byte *is* the real
   track vint; correlate each candidate label's cue times against each put.io
   entry's SRT times (already in memory) to bind label → language → container
   track. Robust to shifted labels (Kusuriya: English cues labeled "12").

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
- **E2 — 6-file Cues audit** (finish `cuescheck.py`: HEAD must follow the 302 to
  the CDN; fix the TNUM/TimestampScale parse — hexdump ground truth recorded in
  session b29): files 1615911660, 1614058473, 1617596622, 1618364461, 1618364460,
  1615182727. Answer: **which row does each real file land in** — where the mass is.
  (1614058473 is a Blu-ray rip with 13 PGS tracks — expect no ASS upgrade path at
  all; 1615182727 is H.264 — the MSE-tap candidate.)

## 8. Build plan (TDD, after E1/E2)

- **I1 validator** — RED: synthetic MKV fixtures with (a) fully-valid Cues
  (ffmpeg-muxed `.ass` → valid Cues; row-1 oracle = the same ffmpeg file),
  (b) Kusuriya-style half-broken Cues, (c) no Cues → assert row verdicts 1/2/3.
- **I2 row 1 batcher** — RED: valid-Cues fixture → batched ranges ≤200, 1 KB
  margin, cluster prefixes; assembled cues byte-identical to the oracle track.
- **I3 row 2 scheduler** — RED: prune rule + fake-playhead state machine
  (lookahead L, throttle, discard-after-merge, per-window merge, seek);
  integration: real 218 MB file, fake playhead → final cue set == oracle cues.
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
