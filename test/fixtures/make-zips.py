#!/usr/bin/env python3
"""Reproducible ZIP fixtures for the parser tests (test/fixtures/).

Run:  python3 test/fixtures/make-zips.py
All fixtures are byte-stable (fixed mtime, no timestamps in names).
"""
import os
import struct
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
MTIME = (2020, 1, 2, 3, 4, 5)  # fixed → reproducible bytes


def png_bytes(color: bytes, size=(8, 4)) -> bytes:
    """Tiny real PNG (RGB, no filter per scanline)."""
    import zlib

    w, h = size
    row = bytes(color) * w
    raw = b"".join(b"\x00" + row for _ in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def write_zinfo(zf: zipfile.ZipFile, name: str, data: bytes, stored: bool = False):
    zi = zipfile.ZipInfo(name, date_time=MTIME)
    zi.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    zi.external_attr = 0o644 << 16
    zf.writestr(zi, data)


def main():
    os.makedirs(HERE, exist_ok=True)

    cover = png_bytes((0x2A, 0x6F, 0xB0))
    page2 = png_bytes((0x8A, 0x3D, 0x33))
    inner1 = png_bytes((0x2F, 0x8F, 0x5B))
    inner2 = png_bytes((0xC2, 0x8A, 0x2C))

    # 1. basic: nested folders, deflated + stored, real PNGs
    with zipfile.ZipFile(f"{HERE}/zip-basic.zip", "w") as zf:
        write_zinfo(zf, "cover.png", cover)
        write_zinfo(zf, "page-2.png", page2)
        write_zinfo(zf, "notes.txt", b"hello from inside the archive\n", stored=True)
        write_zinfo(zf, "sub/inner-1.png", inner1)
        write_zinfo(zf, "sub/inner-2.png", inner2)
        write_zinfo(zf, "sub/deep/deeper.txt", b"deeper\n", stored=True)

    # 2. empty archive (valid EOCD, zero entries)
    with zipfile.ZipFile(f"{HERE}/zip-empty.zip", "w"):
        pass

    # 3. unicode names (python sets the UTF-8 name flag)
    with zipfile.ZipFile(f"{HERE}/zip-unicode.zip", "w") as zf:
        write_zinfo(zf, "föto-日本語.png", cover)

    # 4. trailing junk after the EOCD (some tools append signatures)
    with zipfile.ZipFile(f"{HERE}/zip-junk.zip", "w") as zf:
        write_zinfo(zf, "a.txt", b"trailing junk test", stored=True)
    with open(f"{HERE}/zip-junk.zip", "ab") as f:
        f.write(b"\x50\x4b\x05\x06" + b"junk" * 20 + b"\x00" * 34)  # fake EOCD-ish tail

    # 5. truncated archive (no EOCD at all)
    with open(f"{HERE}/zip-truncated.zip", "wb") as f:
        f.write(b"\x50\x4b\x03\x04" + b"\x00" * 60)

    # 6. synthetic ZIP64 tail: EOCD64 locator (0x07064b50) + EOCD64 (0x06064b50)
    #    directly before the regular EOCD — the detection contract.
    eocd64 = (
        struct.pack("<I", 0x06064B50)      # signature
        + struct.pack("<Q", 44 - 12)       # size of EOCD64 record
        + struct.pack("<HH", 45, 45)       # version made by / needed
        + struct.pack("<QQ", 0, 0)         # disk numbers
        + struct.pack("<QQ", 0, 0)         # entries on disk / total
        + struct.pack("<QQ", 0, 0)         # central dir size / offset
        + struct.pack("<Q", 0)             # comment length
    )
    locator = (
        struct.pack("<I", 0x07064B50)      # signature
        + struct.pack("<I", 0)             # disk with EOCD64
        + struct.pack("<Q", 10)            # EOCD64 offset
        + struct.pack("<I", 1)             # total disks
    )
    eocd = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, 0, 0, 0, 0, 0)
    with open(f"{HERE}/zip-zip64.zip", "wb") as f:
        f.write(b"\x00" * 10 + eocd64 + locator + eocd)

    for name in sorted(os.listdir(HERE)):
        if name.endswith(".zip"):
            print(f"{name:24s} {os.path.getsize(os.path.join(HERE, name))} bytes")


if __name__ == "__main__":
    main()
