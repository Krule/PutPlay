#!/usr/bin/env python3
"""e2e static server WITH HTTP Range support (serves the repo root).

`python3 -m http.server` has no Range support — it always answers 200 with
the whole file. WebKit (Safari) strictly requires 206 responses to stream
and seek progressive media, so on the plain server a video "fully downloads
before playing" while Firefox (lenient) streams fine. The real put.io
/stream endpoint honours Range, so the app itself is unaffected — this
server fixes the harness so local browsers match the real thing.

Run:
    python3 test/e2e/serve.py [port]     # default 8642
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))  # test/e2e
ROOT = os.path.dirname(os.path.dirname(HERE))      # repo root

class RangeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_response(self, code, message=None):
        # no-store: the harness rebuilds the bundle in place; a heuristic
        # browser cache (no Cache-Control from SimpleHTTPRequestHandler)
        # otherwise serves stale CSS/JS across reloads
        super().send_response(code, message)
        self.send_header("Cache-Control", "no-store")

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()
        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()
        try:
            spec = range_header.split("=", 1)[1] if "=" in range_header else ""
            start_s, _, end_s = spec.partition("-")
            size = os.path.getsize(path)
            if not start_s:
                # suffix form: bytes=-N → the last N bytes
                n = int(end_s) if end_s else size
                start, end = max(0, size - n), size - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else size - 1
            end = min(end, size - 1)
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.end_headers()
                return None
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.send_header("Content-Length", str(length))
            self.end_headers()
            if self.command == "HEAD":
                return None
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            return None
        except (ValueError, OSError):
            return super().send_head()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8642
    print("serving %s at http://localhost:%d (Range-capable)" % (ROOT, port))
    ThreadingHTTPServer(("127.0.0.1", port), RangeHandler).serve_forever()
