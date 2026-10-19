#!/usr/bin/env python3
"""Deterministic demo fixtures for the docs screenshots (docs/shots).

Run:  python3 docs/shots/make-fixtures.py

Sources (all open content, see CREDITS.md):
  - Krazy Kat newspaper strips, 1918-1924 (public domain, Wikimedia Commons)
  - Van Gogh, The Starry Night (1889, MoMA scan) + Starry Night Over the
    Rhone (1888) — public domain, Wikimedia Commons
  - Maple Leaf Rag, Albert Brunies Halfway House Orch. (1925 recording —
    pre-1928, public domain in the US, archive.org)

All archives get a fixed mtime so the bytes are reproducible.
"""
import os
import shutil
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
OUT = os.path.join(HERE, "fixtures")
MTIME = (2020, 1, 2, 3, 4, 5)  # fixed -> reproducible bytes


def copy(name: str) -> None:
    dst = os.path.join(OUT, os.path.basename(name))
    shutil.copyfile(os.path.join(SRC, name), dst)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)

    # THE COMIC: five Krazy Kat strips, 1918-1924. The first file is the
    # cover (reading order = sorted names); pages 2-5 make two spreads.
    comic = os.path.join(OUT, "krazy-kat-1918-1924.cbz")
    with zipfile.ZipFile(comic, "w", zipfile.ZIP_DEFLATED) as z:
        for n in sorted(os.listdir(os.path.join(SRC, "comic"))):
            if n.endswith(".jpg"):
                zi = zipfile.ZipInfo("Krazy Kat/" + n, date_time=MTIME)
                zi.compress_type = zipfile.ZIP_DEFLATED
                with open(os.path.join(SRC, "comic", n), "rb") as f:
                    z.writestr(zi, f.read())

    # THE ARCHIVE: one image (so the app's entry decision sends it to the
    # archive viewer, not the comic reader) + a small text note.
    gallery = os.path.join(OUT, "gallery.zip")
    with zipfile.ZipFile(gallery, "w", zipfile.ZIP_DEFLATED) as z:
        zi = zipfile.ZipInfo("starry-rhone-1888.jpg", date_time=MTIME)
        zi.compress_type = zipfile.ZIP_DEFLATED
        with open(os.path.join(SRC, "img", "starry-rhone-1888.jpg"), "rb") as f:
            z.writestr(zi, f.read())
        note = (
            "Gallery\n"
            "========\n\n"
            "The Starry Night Over the Rhone (1888), Vincent van Gogh.\n"
            "Public domain (the artist died in 1890).\n\n"
            "Scanned via Wikimedia Commons. PutPlay opens the archive with\n"
            "range reads only - the file itself stays on put.io.\n"
        )
        zi = zipfile.ZipInfo("readme.txt", date_time=MTIME)
        z.writestr(zi, note)
        credits = (
            "Credits\n"
            "=======\n\n"
            "The artwork in this archive is public domain.\n"
            "See the PutPlay repository (docs/shots/CREDITS.md) for the\n"
            "full source and license list behind the demo content.\n"
        )
        zi = zipfile.ZipInfo("credits.txt", date_time=MTIME)
        z.writestr(zi, credits)

    # LOOSE IMAGES (the "Paintings" folder: image-viewer browsing targets)
    copy("img/starry-night-1889.jpg")
    copy("img/starry-rhone-1888.jpg")

    # MUSIC (the now-playing strip)
    copy("music/maple-leaf-rag-1925.mp3")

    # VIDEO (the player shot): a 60-second clip of *Steamboat Willie* (1928)
    # — public domain in the US since 2019. The source clip (480p H.264,
    # re-encoded from the archive.org scan) lives in src/video/ so the
    # fixture stays reproducible; see CREDITS.md.
    copy("video/steamboat-willie-1928.mp4")

    # QR (the connect shot): encodes https://app.put.io/link?code=TEST1234 —
    # the exact code the fake API's OOB endpoint answers with, so the QR
    # and the code on screen always agree.
    copy("qr-test1234.png")

    for n in sorted(os.listdir(OUT)):
        print(f"{n}  {os.path.getsize(os.path.join(OUT, n)) // 1024} KB")


if __name__ == "__main__":
    main()
