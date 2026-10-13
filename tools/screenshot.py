#!/usr/bin/env python3
"""
Take headless screenshots of the running game to check visual changes.

Setup (once):  pip install -r tools/requirements.txt && python3 -m playwright install chromium
Usage:         python3 server.py &                       # the game must be running
               python3 tools/screenshot.py                # all views -> ./screenshots/
               python3 tools/screenshot.py davis paris    # only some views
               python3 tools/screenshot.py --out docs/images --software

Prints browser console errors and exits non-zero if the page throws.
"""
import argparse
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# Hardware WebGL in headless Chromium (Linux + NVIDIA/Mesa). SwiftShader works
# everywhere but is too slow for this scene unless you are patient.
GPU_ARGS = ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"]
SOFTWARE_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]

# Stand near the corner of streets `a` and `b`, on street `a`, and frame the camera.
HELPERS = """() => {
window.__corner = (a, b, o = {}) => {
  const { along = -14, side = 2.0, turn = -0.35, pitch = 0.12, dist = 4.5 } = o;
  const js = [...game.world.chunks.values()].flatMap((c) => c.junctions);
  const j = js.find((j) => { const n = new Set(j.carArms.map((x) => x.road.n)); return n.has(a) && n.has(b); });
  if (!j) throw new Error(`no intersection ${a} & ${b}`);
  const arm = j.carArms.find((x) => x.road.n === a);
  const nb = arm.road.p[arm.vi + 1] || arm.road.p[arm.vi - 1];
  const l = Math.hypot(nb[0] - j.x, nb[1] - j.z), tx = (nb[0] - j.x) / l, tz = (nb[1] - j.z) / l;
  const off = arm.road.hw + side;
  const yaw = Math.atan2(-tx, -tz);
  game.teleport(j.x + tx * along - tz * off, j.z + tz * along + tx * off, yaw);
  game.setView(yaw + turn, pitch, dist);
};
}"""

# name: (URL query, setup script)
VIEWS = {
    "davis": ("test", ""),
    "signs": ("test", "game.labels.setMode('signs'); __corner('B Street', '3rd Street');"),
    "paris": ("test&at=48.85745,2.36154", ""),
    "tokyo": ("test&at=35.65950,139.70040", ""),
    "nyc": ("test&at=40.75440,-73.98480", ""),
    "overview": ("test", "game.setView(game.player.camYaw + 0.6, 1.0, 10);"),
    "map": ("test", "game.openMap(true);"),
    "globe": ("globe", ""),
}


def shoot(pw, url, name, query, setup, out, args, wait_ms):
    errors = []
    # A fresh browser per view: after many screenshots in one session Chromium's
    # screenshot call can hang even though the page keeps rendering.
    browser = pw.chromium.launch(args=args)
    page = browser.new_page(viewport={"width": 1280, "height": 760})
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None)
    t0 = time.time()
    page.goto(f"{url}/?{query}")
    page.wait_for_function("window.game && window.game.ready", timeout=420_000)
    page.evaluate(HELPERS)
    if setup:
        page.evaluate(setup)
    page.wait_for_timeout(wait_ms)
    path = out / f"{name}.png"
    page.screenshot(path=str(path))
    browser.close()
    print(f"{name:9s} -> {path} ({time.time() - t0:.1f}s)")
    return errors


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("views", nargs="*", help=f"views to capture (default: all): {', '.join(VIEWS)}")
    ap.add_argument("--url", default="http://localhost:8080")
    ap.add_argument("--out", default="screenshots", type=Path)
    ap.add_argument("--software", action="store_true", help="use SwiftShader instead of the GPU")
    ap.add_argument("--wait", type=int, default=3000, help="ms to wait after setup before capturing")
    opts = ap.parse_args()

    unknown = [v for v in opts.views if v not in VIEWS]
    if unknown:
        ap.error(f"unknown view(s): {', '.join(unknown)}")
    opts.out.mkdir(parents=True, exist_ok=True)
    args = SOFTWARE_ARGS if opts.software else GPU_ARGS

    problems = []
    with sync_playwright() as pw:
        for name in opts.views or VIEWS:
            query, setup = VIEWS[name]
            problems += [f"[{name}] {e}" for e in shoot(pw, opts.url, name, query, setup, opts.out, args, opts.wait)]
    for p in problems:
        print(p)
    sys.exit(1 if any("pageerror" in p for p in problems) else 0)


if __name__ == "__main__":
    main()
