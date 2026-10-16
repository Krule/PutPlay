# e2e harness — run the real app offline in a desktop browser

Repro/verification harness for the full user journey without a TV or a real
put.io account. The app's production code runs unmodified; only the network
is faked.

## Run

```bash
pnpm run build
python3 test/e2e/serve.py            # Range-capable static server, port 8642
agent-browser open "http://localhost:8642/?seedtoken" \
  --init-script test/e2e/fake-api.js
```

**Use `test/e2e/serve.py`, not `python3 -m http.server`**: the stdlib server
has no Range support (always 200, whole file), and WebKit strictly requires
206 responses to stream and seek progressive media — on the plain server a
video downloads fully before playing (Firefox is lenient and hides it). The
real put.io /stream endpoint honours Range, so the app itself is unaffected;
`serve.py` makes the harness match.

## Flows

- `/?seedtoken` — seeds a fake saved token → **library + player** verification
  (the fake file list has one folder + 8 videos; every stream URL is rewritten
  to `test/e2e/testvid.mp4`, a 60 s clip generated with ffmpeg).
- `/` (no param) — unauthenticated → **Connect screen** verification. The
  OOB endpoints are faked: the device-code flow auto-starts on arrival and
  lands on the pending screen with code `TEST1234`; the poll never approves,
  so it stays in "waiting".
- `/test/e2e/music-e2e.html?seedtoken` — **music + docked-video flow**: 2 MP4
  videos, 3 FLAC tracks + a Music folder (3 tracks + cover.jpg) + a
  story.cbz. The fake is inlined via a plain script tag (daemon-agnostic —
  no `--init-script` needed, and it works in Safari). Streams rewrite to
  `testvid.mp4` (it carries real audio); the cover rewrites to a local PNG.
  Verifications: the now-playing strip (states + queue controls), the
  docked video (Back from full docks to mini — it keeps playing; micro is
  icons-only; restore/close), and the focus trap (strip/dock buttons
  unreachable from the D-pad on the comic/image screens).

## Verifications covered

- Connect: no paste-a-token option; no sign-in gate (QR auto-starts); an OOB
  failure renders inside the Approve screen's frame (error + Try again);
  Back on the QR screen runs the double-press exit guard (hint → exit, no
  cancel — the bounded flow self-terminates in the background).
- Library: `.acct` → Settings → Back → `.acct` round-trip repeats cleanly;
  D-pad (ArrowUp/Right + Enter) reaches and activates the header button.
- Player: `.bar-fill` width tracks `currentTime` during playback.

`testvid.mp4` is a generated asset (testsrc + sine, 60 s, ~900 kB):

```bash
ffmpeg -f lavfi -i testsrc=duration=60:size=640x360:rate=24 \
  -f lavfi -i sine=frequency=440:duration=60 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest testvid.mp4
```
