# PutPlay

[![CI](https://github.com/Krule/PutPlay/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/Krule/PutPlay/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/Krule/PutPlay?label=latest%20release)](https://github.com/Krule/PutPlay/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Krule/PutPlay/total?label=downloads)](https://github.com/Krule/PutPlay/releases)

put.io on the big screen — original files, embedded subtitles, my remote.

> Unofficial. Not affiliated with put.io or LG.

## Why this exists

My LG C1 stopped working with app.put.io. I like tv.put.io — but I want to
stream the **original**, my file as I uploaded it. I understand the web moves
on and LG doesn't want to invest in browser updates. I just didn't like the
idea that a really good TV becomes unusable from obsolescence.

Then I remembered I used to be a software engineer, and I had Qwen 3.8 27B
to play with. A few days later, we had the first version of PutPlay.

## What it does

- Browses your put.io library and plays the file **as uploaded** (MKV/MP4) —
  with put.io MP4 and HLS as fallbacks when the original misbehaves
- Subtitles: MKV-embedded first, then your put.io subtitles (ASS/SSA and SRT)
- Audio track switching — and when the TV's player refuses a switch, it tells
  you the truth instead of pretending it worked
- Resumes where you left off; remembers your source and language preferences
- Sign-in is a device code: enter it on your phone, or scan the QR

## Controls

Pointer (Magic Remote) and 5-way both work. **OK** confirms, **Back**
cancels — double-press exits.

In the player: **blue** play/pause · **red** subtitles · **yellow** audio ·
**green** playback source.

## Installation

Download the current `.ipk` from the [releases page](https://github.com/Krule/PutPlay/releases).

- **Regular TV:** install the `.ipk` through Homebrew Channel.
- **Rooted TV (mine):** dev install straight into `appinstalld` — no Developer
  Mode needed. From a checkout, `TV_IP=<your tv> TV_USER=root pnpm deploy:tv`
  copies, installs, and verifies in about four seconds.

## Building

```sh
git clone git@github.com:Krule/PutPlay.git
cd PutPlay
npm ci
npm test        # 200+ tests, including the webOS 6 baseline gate
npm run build   # js/bundle.js + js/bundle.css
npm run package # io.put.lg_<version>_all.ipk in the repo root
```

Releases are tag-driven: push `v1.2.3` and CI builds, tests, packages
`io.put.lg_1.2.3_all.ipk`, and publishes a release named `v1.2.3` with the
`.ipk` attached. The tag is the version — it's written into `package.json`
and `appinfo.json` at build time, so the file, the app, and the release can
never disagree.

## Compatibility

Built for webOS 6 (my C1). The codebase is pinned to the webOS 6 webview —
Chromium 79 — and a test in the suite keeps it there: no flex `gap`, no
`:focus-visible` outside `@supports`, no ES2020+ APIs. The TV's browser isn't
going anywhere, so the app knows exactly where that line is and stays on
this side of it.

## Disclaimer

This project is unofficial and is not affiliated with, or endorsed by,
put.io or LG Electronics. It uses your own put.io account against the
public put.io API. Use it within put.io's terms.
