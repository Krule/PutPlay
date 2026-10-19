# Screenshot demo content — sources and licenses

The screenshots in `docs/screenshots/` are taken from the real app running
against a small fake put.io API (`docs/shots/fake-docs-api.js`) whose
"library" is the open-content set below. No personal files, no real
put.io account data appear anywhere.

| Asset | Source | License |
| --- | --- | --- |
| Krazy Kat newspaper strips, 1918–1924 (`src/comic/`) | [Wikimedia Commons](https://commons.wikimedia.org) — files by George Herriman's strips in *The New York World*, *Los Angeles Examiner*, etc. | Public domain (published 1918–1924, US) |
| *The Starry Night* (1889) (`src/img/starry-night-1889.jpg`) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:VanGogh-starry_night.jpg) | Public domain (Van Gogh d. 1890) |
| *Starry Night Over the Rhone* (1888) (`src/img/starry-rhone-1888.jpg`) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Starry_Night_Over_the_Rhone.jpg) | Public domain (Van Gogh d. 1890) |
| *Maple Leaf Rag* (1925 recording, Albert Brunies Halfway House Orch.) (`src/music/`) | [archive.org](https://archive.org/details/1925-USA-Archives-1925-09-25-Albert-Brunies-Halfway-House-Orch-Maple-Leaf-Rag) | Public domain in the US (recording predates 1928); composition by Scott Joplin is also public domain |
| *Steamboat Willie* (1928) clip, 60 s (`src/video/`, played in the player shot) | [archive.org](https://archive.org/details/steamboat-willie-1928) — scanned restoration of the 1928 release, re-encoded to 480p H.264 for the fixture | Public domain in the US (entered 2019); the 1928 film predates every modern copyright term |
| *The General* (1926), *Nosferatu* (1922) (video tile names only — the files are never played or shown in the shots) | public-domain silent films | Public domain (published 1926 / 1922, US) |
| Player screen frame (`player.png`) | *Steamboat Willie* (1928), see above | Public domain |

## Re-taking the screenshots

```sh
python3 docs/shots/make-fixtures.py          # (re)build the demo archives
python3 -m http.server 8642                   # repo root
# in a browser harness (e.g. agent-browser, 1920x1080):
#   open http://localhost:8642/test/e2e/docs-shots.html?seedtoken
```

`test/e2e/docs-shots.html` is a copy of `index.html` that loads the fake
API with a plain script tag before the app bundle — the same pattern as
`test/e2e/music-e2e.html`. Use it instead of `--init-script
docs/shots/fake-docs-api.js`: the init-script flag of the agent-browser CLI
as of this writing leaves the tab at `about:blank`, while the script-tag
page is daemon-agnostic and works in a plain browser too (append
`?seedtoken` to the URL — the fake seeds the saved token only when it is
there).

The fake API serves the fixtures under `docs/shots/fixtures/` and rewrites
stream URLs the way `test/e2e/fake-api.js` does — see its header for the
pattern.
