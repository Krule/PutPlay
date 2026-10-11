# Changelog

All notable changes to PutPlay are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/1.1.0/); versions follow the git tag (`vX.Y.Z`).
Maintenance rules live in [AGENTS.md](AGENTS.md) → "Changelog Maintenance".

## [Unreleased]

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
