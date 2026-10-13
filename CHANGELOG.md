# Changelog

All notable changes to PutPlay are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/1.1.0/); versions follow the git tag (`vX.Y.Z`).
Maintenance rules live in [AGENTS.md](AGENTS.md) → "Changelog Maintenance".

## [Unreleased]

### Changed
- Sign-in on app launch now completes with a single account check instead of
  two — the app started by validating the saved token and then fetching the
  account info, which is the same put.io endpoint called twice. Startup makes
  one fewer round-trip, which is most noticeable on slow connections.

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
