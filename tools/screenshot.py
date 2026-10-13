#!/usr/bin/env python3
"""
Take headless screenshots of the running game to check visual changes.

Setup (once):  pip install -r tools/requirements.txt && python3 -m playwright install chromium
Usage:         python3 serve.py &                       # the game must be running
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
// Look at the nearest bridge from the side.
window.__bridge = (o = {}) => {
  const p0 = game.player;
  let best = null;
  for (const c of game.world.chunks.values()) for (const r of c.roads) {
    if (!r.br || !r.ez || r.kind !== 'car') continue;
    const m = r.p[Math.floor(r.p.length / 2)];
    const d = Math.hypot(m[0] - p0.x, m[1] - p0.z);
    if (!best || d < best.d) best = { d, r, m };
  }
  if (!best) throw new Error('no bridge nearby');
  const { r, m } = best, a = r.p[0], b = r.p[r.p.length - 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const tx = (b[0] - a[0]) / l, tz = (b[1] - a[1]) / l, off = o.off ?? 45;
  const x = m[0] - tz * off, z = m[1] + tx * off;
  game.teleport(x, z, 0);
  const yaw = Math.atan2(-(m[0] - x), -(m[1] - z));
  game.setView(yaw, o.pitch ?? 0.12, o.dist ?? 6);
};
// Stand on the nearest road of a type (e.g. 'motorway'), looking along it.
window.__road = (type, o = {}) => {
  const { pitch = 0.35, dist = 9, turn = 0, back = 0 } = o;
  const p0 = game.player;
  let best = null;
  for (const c of game.world.chunks.values()) for (const r of c.carRoads) {
    if (r.t !== type) continue;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1], l = Math.hypot(bx - ax, bz - az);
      if (l < 30) continue;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2, d = Math.hypot(mx - p0.x, mz - p0.z);
      if (!best || d < best.d) best = { d, mx, mz, tx: (bx - ax) / l, tz: (bz - az) / l };
    }
  }
  if (!best) throw new Error(`no ${type} nearby`);
  const yaw = Math.atan2(-best.tx, -best.tz);
  game.teleport(best.mx - best.tx * back, best.mz - best.tz * back, yaw);
  game.setView(yaw + turn, pitch, dist);
};
// Stand on a freeway, 120 m before the nearest guide sign, looking at it.
window.__sign = (o = {}) => {
  const p0 = game.player;
  let best = null;
  for (const c of game.world.chunks.values()) for (const s of c.signs || []) {
    if (o.kind && s.k !== o.kind) continue;
    if (o.fast && !(s.fast && s.k === 'guide')) continue;
    const d = Math.hypot(s.x - p0.x, s.z - p0.z);
    if (!best || d < best.d) best = { d, s };
  }
  if (!best) throw new Error('no sign nearby');
  const s = best.s, back = o.back ?? 110, yaw = Math.atan2(-s.dx, -s.dz);
  game.teleport(s.x - s.dx * back, s.z - s.dz * back, yaw);
  game.setView(yaw, o.pitch ?? 0.05, o.dist ?? 6);
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
    "freeway": ("test&at=38.5435,-121.7375", "__road('motorway');"),
    "autobahn": ("test&at=52.5003,13.2829", "__road('motorway');"),
    "overpass": ("test&at=38.5435,-121.7375", "__bridge();"),
    "nav": ("test&at=38.4088,-121.3716", "game.nav.start(game.world.frame, game.player.pos.x, game.player.pos.z, { lat: 38.5449, lon: -121.7405, name: 'Davis' }); await new Promise((r) => setTimeout(r, 4000));"),
    "gantry": ("test&at=38.5650,-121.5230", "game.atmo.setTimeMode('day'); __sign({ fast: true, back: 45, pitch: -0.12, dist: 4 });"),
    "shield": ("test&at=38.5650,-121.5230", "game.atmo.setTimeMode('day'); __sign({ kind: 'route', back: 30 });"),
    "seine": ("test&at=48.8590,2.3425", "game.atmo.setTimeMode('day'); game.teleport(90, 150, 1.4); game.setView(1.4, 0.1, 7);"),
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
        page.evaluate(f"async () => {{ {setup} }}")
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
