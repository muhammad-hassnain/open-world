#!/usr/bin/env python3
"""
Development server for the game.

Serves the static site (index.html, js/, data/, assets/) on all interfaces so other
devices on your network or tailnet can play. All map data is loaded by the browser:
OpenFreeMap tiles for the whole world, plus pre-built detail files in data/detail/
(see tools/build_detail.py). Only the Python standard library is used.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import gzip
import mimetypes
import os
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parent
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8080"))
PUBLIC_DIRS = ("js", "data", "assets")

mimetypes.add_type("text/javascript", ".js")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.address_string()}] {fmt % args}\n")

    def do_GET(self):
        path = urllib.parse.unquote(self.path.split("?", 1)[0])
        rel = "index.html" if path == "/" else path.lstrip("/")
        target = (ROOT / rel).resolve()
        allowed = rel == "index.html" or rel.split("/", 1)[0] in PUBLIC_DIRS
        if not allowed or ROOT not in target.parents or not target.is_file():
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        body = target.read_bytes()
        gz = "gzip" in (self.headers.get("Accept-Encoding") or "") and (ctype.startswith("text/") or ctype == "application/json")
        if gz:
            body = gzip.compress(body, compresslevel=6)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"open-world on http://localhost:{PORT}", flush=True)
    try:
        import subprocess
        ip = subprocess.check_output(["tailscale", "ip", "-4"], text=True, stderr=subprocess.DEVNULL).split()[0]
        print(f"  tailnet: http://{ip}:{PORT}", flush=True)
    except Exception:
        pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.server_close()


if __name__ == "__main__":
    main()
