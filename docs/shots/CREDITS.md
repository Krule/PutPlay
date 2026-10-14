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
| *Big Buck Bunny*, *Sintel*, *Tears of Steel* (video tile names only — the files are never played or shown in the shots) | [Blender Foundation](https://studio.blender.org) | CC-BY 3.0 |
| Player screen frame (`player.png`) | *Big Buck Bunny*, Blender Foundation | CC-BY 3.0 |

## Re-taking the screenshots

```sh
python3 docs/shots/make-fixtures.py          # (re)build the demo archives
python3 -m http.server 8642                   # repo root
# in a browser harness (e.g. agent-browser, 1920x1080):
#   open http://localhost:8642/?seedtoken with --init-script docs/shots/fake-docs-api.js
```

The fake API serves the fixtures under `docs/shots/fixtures/` and rewrites
stream URLs the way `test/e2e/fake-api.js` does — see its header for the
pattern.
