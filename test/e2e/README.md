# e2e harness — run the real app offline in a desktop browser

Repro/verification harness for the full user journey without a TV or a real
put.io account. The app's production code runs unmodified; only the network
is faked.

## Run

```bash
npm run build
python3 -m http.server 8642          # serve the repo root
agent-browser open "http://localhost:8642/?seedtoken" \
  --init-script test/e2e/fake-api.js
```

## Flows

- `/?seedtoken` — seeds a fake saved token → **library + player** verification
  (the fake file list has one folder + 8 videos; every stream URL is rewritten
  to `test/e2e/testvid.mp4`, a 60 s clip generated with ffmpeg).
- `/` (no param) — unauthenticated → **Connect screen** verification. The
  OOB endpoints are faked: the device-code flow auto-starts on arrival and
  lands on the pending screen with code `TEST1234`; the poll never approves,
  so it stays in "waiting".

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
