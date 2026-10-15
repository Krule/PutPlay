# Changelog

All notable changes to PutPlay are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/1.1.0/); versions follow the git tag (`vX.Y.Z`).
Maintenance rules live in [AGENTS.md](AGENTS.md) → "Changelog Maintenance".

## [Unreleased]

### Changed
- Comic covers now persist for up to 2,000 files across sessions: the
  cover store moved from the browser's 16 MB localStorage limit to
  IndexedDB, so bigger libraries stop re-downloading covers on every
  open. Covers expire after a month as before, and signing out still
  clears the account's artwork.

## [1.1.2] - 2026-10-15

### Fixed
- The version line in Settings now reads clean on store builds: two
  things made every pipeline build look modified — tracked helper files
  under node_modules, and the pipeline's own version update (tag →
  manifests) being counted as a local change. v1.1.2 is the first
  release stamped clean.
- The docked video's size button (make it mini / restore to full) is
  reachable with the D-pad in both mini and micro now: after a size
  change the button was recreated in place and the focus scan never saw
  the new one, so the walk jumped over it.
- On the comic and picture readers, the music row's "Restore to strip"
  button is dimmed and skipped by the D-pad: restoring the strip there
  did nothing (the strip would cover the page), and it quietly changed
  what the music looks like back in the library.
- While the corner's focus is on the player (music row or docked
  video), Left/Right no longer turn the comic page: while focused, the
  corner owns the arrows (walk its buttons, release at its edge) and
  the page stays put. Without focus, the page owns the arrows — and
  the flicker fix from the previous round stays in place.
- While reading, page-turning no longer makes the corner's focus flicker
  on and off on every Left/Right/Up press: a press with no focus no
  longer pulls the corner in (it was the only thing the arrows could
  land on). The corner is entered on purpose — Down, or the pointer —
  and Left/Right then hand it back immediately.
- Pressing Down to switch focus off the corner (music row or docked
  video) now actually turns it back down on the TV: releasing focus also
  hands back the DOM focus, which was keeping the corner at full opacity
  with a focused-looking button even though the spatial focus was gone.
  Same for the release when you walk off the corner's edge.
- While reading, the corner (the music row, or a docked video in mini/
  micro) no longer holds the arrows: walking off its edge releases the
  focus, and Down — a dead key at fit size — now switches focus between
  the page and the corner. That is the deliberate in and out of the
  corner; the magic remote's pointer works as before.
- Enter on a focused corner control now does the control's job from the
  comic reader: the docked video's buttons used to do nothing on Enter,
  and the music row's zoomed the page instead.
- The docked video's micro (the icon row) now recedes to 25% opacity
  over comics and pictures, like the music row, and brightens when you
  focus it. The mini keeps the video fully visible.

## [1.1.1] - 2026-10-14

### Added
- Docked video player: pressing Back in the full player no longer stops the
  film — it docks to a small window over your library and keeps playing.
  Back (or the restore button) brings it back to full exactly where you were;
  a shrink button folds it to an icon row that plays audio only; and ✕ stops
  it, saving the position so the video reopens where you left off.
- Videos advance on their own: when one ends, the next video in the same
  folder starts. Turn it off in Settings → Playback ("Play next in folder",
  on by default).
- The now-playing strip gets the same ladder: a collapse button folds it
  to an icon row in the corner (and back). While you're reading a comic or
  looking at a picture, the music presents as that small corner row on its
  own — it no longer covers the page.

### Fixed
- While reading a comic or image with a video docked: the D-pad no longer
  wanders into the dock's buttons (they showed a focus ring but Enter did
  nothing there). The dock stays clickable with the magic remote — its
  buttons just can't steal the reader's arrows any more, and a mouse click
  on them no longer leaves a stray focus ring behind.
- Back works again from the reader after you have driven the docked video
  (restore-to-full, close, …): the reader now takes the remote's handlers
  back whenever the video leaves full, instead of being stranded on the
  player's stale ones.
- The docked video's mini window sits in the bottom-right corner again
  (it was pinned top-left), and micro no longer paints the whole screen
  black — it folds to just the icon row in that same corner.
- Back works again after restoring the docked player to full (one
  restore→Back cycle used to leave it dead).
- The player rendered off-screen on the TV (a bottom strip instead of the
  full screen): the build's CSS minifier was folding top/right/bottom/left
  into the `inset` shorthand, which the TV's Chromium 79 silently ignores.
  The build now targets the TV's Chromium (build/options.mjs) and the test
  suite re-minifies the stylesheet with that target — any shorthand the TV
  can't read fails the build. This was the real cause of the first
  positioning round as well.
- The music row's controls work from the comic reader now (restore, play,
  next — the reader's D-pad scope includes the corner row, and the library
  stays out of reach), and while reading the row recedes to 25% opacity,
  brightening when you focus it.

## [1.1.0] - 2026-10-14

### Added
- Music playback: open a music file in the library and it plays under a
  slim now-playing strip — browse folders, open pictures, and read comics
  while it keeps running. Prev/next walk the folder's tracks, a finished
  track advances on its own, and the TV remote's play/pause/stop and
  rewind keys drive it. The TV's own decoder is the judge: a format it
  can't play is said so directly and remembered, so the same file never
  gets retried blindly.
- Comic reader: open a .cbz from the library and it reads like a book —
  the put.io file is never downloaded, only the pages you look at (range
  reads + in-memory inflate, verified on a 351 MB scan: zero full-file
  traffic). Pages sort like a print run (cover first, 2 before 10), Up
  flips the reading direction (persisted per comic, so a manga stays a
  manga), Back remembers your page and the book opens back where you
  left it. OK steps fit → 2× → 4× relative to the page's own fit — a
  675-px and a 2138-px scan feel identical — and the arrows pan when
  zoomed. CBR stays an honest "can't open"; a single-picture zip still
  goes to the archive viewer.
- Spread mode: the reader works in SHEETS, not single pages — the cover
  alone, then uniform pages side by side, and any wide page (a real
  spread) on its own. A portrait page on a 16:9 screen used to be a
  sliver in a black sea; now it fills the glass. RTL books render the
  pair right-to-left (the earlier page on the right). A legend in the
  reader always says which direction you're in and how to flip it.
- Image viewer zoom: pictures get the reader's proven interaction — OK
  steps fit → 2× → 4×, the arrows pan when zoomed, browsing resets to
  fit. The zoom math now lives in one shared module (putio/zoom.ts), so
  a picture and a spread behave exactly the same.
- Reader page cache: the ten most recently read pages stay cached (LRU,
  blob revocation on eviction) and survive screen switches — back to the
  grid, re-open the book, every read page is instant. The prefetch
  follows the direction you're HEADING: turning back reads behind you,
  so a back-traversal after a forward one costs no network at all.
- Comic cover thumbs: a .cbz tile shows its cover (page 0 of the reading
  order) instead of a bare glyph. The cover is a down-scaled JPEG saved
  locally — a saved thumb costs zero network on the next launch. Thumbs
  expire after a month, the store is capped, storage that refuses is a
  quiet fallback (the thumb still shows, it just won't persist), and
  sign-out clears the previous account's artwork. A cover that can't be
  fetched falls back to the glyph — never an empty tile.

### Changed
- One engine, one output: starting a video stops the music, and starting
  the music stops the video — the TV has one sound path, and the app
  doesn't fight over it.
- Sign-in on app launch now completes with a single account check instead
  of two — the app started by validating the saved token and then
  fetching the account info, which is the same put.io endpoint called
  twice. Startup makes one fewer round-trip, which is most noticeable on
  slow connections.
- Opening an archive is two-stage: a 64 KB probe finds the index
  (central directory) location first, and the index itself is fetched
  exactly — never a flat 256 KB chunk. Small archives open in one
  request; huge ones pay only for their index.
- OLED screensaver opt-in: the app declares itself a still-image app with
  the 30-minute, key-reset timeout (webOS `screenSaverProperties` type 2)
  — a page you keep turning stays at full brightness, and the display only
  goes dark after a half hour away. (A TV-level power-off dragged in by a
  connected device — SimpLink/CEC, or an energy-saving timer — is a TV
  setting; no app API can reach it.)

### Fixed
- Reading a big comic stalled between pages. Three measured causes, all on
  the fetch path: the next sheet was only fetched AFTER the current one
  finished (so on 2 MB pages it never finished in time), every page paid
  for TWO round trips (a 30-byte header read, then the data), and a
  direction flip mid-prefetch double-fetched the same page. The next sheet
  now starts downloading the moment a load begins, each page arrives in a
  single range read (one exact fallback read only when a non-conforming
  local header disagrees with the index), and in-flight requests are
  deduplicated. Bench: the slowest turn 3.0 s → 1.5 s, every other turn
  ~20 ms, requests per book halved.
- Cover thumbs: once the TV's local storage filled up, later covers
  silently stopped persisting — and the app then forgot what it had cached
  too. Persisting now degrades instead: the oldest covers yield until the
  rest fits (freshest-first), and the in-memory map is never trimmed, so
  the session still shows every cover. A cached cover that won't decode is
  re-fetched from the network instead of showing broken pixels.
- Archives with a central directory larger than 256 KB were refused as
  "not a ZIP" (the tail chunk missed the index). The two-stage open
  reads the index wherever it is — verified on an 8000-entry archive.
- Zoomed pan was inverted on the C1 ("up went down, left went right"): it
  used drag-style movement, but a TV D-pad names where you want to LOOK.
  Up now reveals the top, Left the left — in the comic reader and the
  image viewer.
- A turn happened before the page's bytes arrived, so pressing Back
  during a slow load lost the turn. The position is persisted when the
  turn happens, not when the load finishes.
- A superseded image load leaked its blob URL in the image viewer; it is
  revoked now.

## [1.0.4] - 2026-10-13

### Added
- Archive viewer: open a ZIP from the library and it browses like a folder
  — put.io's file is never downloaded, just its index (one range read of
  the tail). Drill into folders, and pictures inside open in the image
  viewer (Left/Right steps through the folder's pictures). Back pops one
  folder at a time, then leaves the archive with the library exactly where
  you left it. RAR/7z stay "coming soon"; ZIP64 and password-protected
  archives are refused by name, not by freeze. This is also the foundation
  for CBZ/CBR comics later.
- Image viewer: open a picture from the library (JPEG / PNG / GIF / WebP /
  BMP) and it fills the screen. Left and Right step through the folder's
  pictures; Back drops you straight back into the folder you opened it from.
  HEIC/HEIF are not offered — the TV's browser can't decode them — and a
  picture that fails to load says so, with a Try again.

## [1.0.3] - 2026-10-12

### Added
- Subtitle size selection right on the player: Small / Default / Large / XL in
  the Subtitles panel. It applies to both the on-screen subtitles and the
  stream's embedded captions, and it is saved like every other setting.
- If the original stream keeps stalling on your connection, the player now
  says so (once per file) and points at the smoother put.io MP4 stream. The
  TV's buffer for the original file is fixed by the webOS webview — the app
  can't grow it, but it no longer sits silent about it.
- The HLS source now runs a much deeper buffer (60s target, 90s ceiling —
  was 30s) to ride out network dips.

### Fixed
- Library focus on the TV is now the soft glow only — the harsh blue box that
  wrapped the focused tile is gone (the desktop keyboard indicator is
  unchanged). Navigating to the rightmost tile — or the last item — no longer
  summons a bottom horizontal scrollbar in the grid.
- Leaving playback returns you to the folder you were browsing — not the
  library root.
- The Video / Audio / Subtitles panels now close as soon as you make a
  selection.
- A folder whose id happens to be 0 (and its breadcrumb trail) was treated as
  the library root: opening it showed the root's contents. The e2e fixture
  now models real folders, which is what caught it.
- Playback no longer stops when the TV's volume is changed. The app never
  sees the volume keys (they are the system's), but the webview can pause
  the video element on its own when the system volume changes — and the app
  used to just sit there showing the pause icon. A pause nobody requested is
  now resumed automatically; a pause you asked for (blue key) still sticks.

## [1.0.2] - 2026-10-12

### Added
- The audio panel lists every audio track in the file: the file's real metadata
  (titles, languages, codecs) is merged with the TV player's track list, so a
  track the webview hides is still visible — and selectable via the put.io
  stream when that's the only way to play it.
- Each audio row shows an honest state (switching, via the put.io stream, or
  "the TV can't decode this codec") instead of a silent no-op.
- New setting, "If the original can't switch audio": ask (the put.io option
  appears in the panel) or use the put.io stream automatically.
- If the preferred audio language isn't in the file, the app says so and lists
  what the file does have.

### Fixed
- Multi-audio MKV: a track pick the TV's player silently vetoes now escalates
  (a retry, then a source reload the webview accepts) and is only reported as
  failed when it truly couldn't switch.
- The preferred audio language is now honored when a file opens. It was
  previously ignored on files where the webview reports no track language or
  title — the common case for MKV (e.g. 4K HEVC rips), where the setting
  appeared to do nothing.
- A mid-switch track sync no longer fired a wrong "Audio: …" toast for a
  different track.
- An undecodable source (error code 4 — 10-bit HEVC / Dolby Vision is the
  usual suspect) now explains why before falling back to the put.io MP4.
- Opening one player panel now closes the others; stacked overlays could trap
  the D-pad focus on the hidden panel.

## [1.0.1] - 2026-10-11

### Added
- Homebrew Channel detail page: a full description (what it does + screenshots of sign-in,
  library, and player — every screenshot captured from the offline mock data, never from a
  live account) served via `fullDescriptionUrl`, plus a one-line `appDescription`.
- `CHANGELOG.md` with agent maintenance rules (AGENTS.md) and a test gate: a release tag
  without a changelog section fails the suite.

### Fixed
- Sign-in logo missing on every installed app (Homebrew Channel or dev install): `icon.svg`
  was never staged into the `.ipk` — the dev simulator masked it by serving the repo root.
  Now staged, and gated by the packaging test.

## [1.0.0] - 2026-10-11

### Added
- Initial release.
- Browses your put.io library and plays the file **as uploaded** (MKV/MP4), with put.io
  MP4 and HLS as automatic fallbacks when the original misbehaves.
- Subtitles (MKV-embedded first, then put.io ASS/SSA/SRT) and audio track switching — with
  honest failure reporting when the TV's player vetoes a switch.
- Resume playback; remembers your source and language preferences.
- Device-code sign-in: enter the code on your phone, or scan the QR.
- Pointer (Magic Remote) and 5-way controls; in the player, blue play/pause, red subtitles,
  yellow audio, green playback source.
- Install via Homebrew Channel (self-updating `repo.json`) or dev install on a rooted TV.
