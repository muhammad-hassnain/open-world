#!/usr/bin/env python3
"""Measure real presented frame intervals and inspect a full game scene.

Start python3 serve.py first. Example:
  python3 tools/check_rendering.py davis --channel chrome --min-fps 40
  python3 tools/check_rendering.py paris --channel chrome --night
Uses the same Playwright/Pillow environment as screenshot.py. Run one browser at a time.
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

MEASURE = r"""duration => new Promise(resolve => {
  let start, last; const times = [];
  function tick(t) {
    if (last !== undefined) times.push(t - last); else start = t;
    last = t;
    if (t - start < duration) { requestAnimationFrame(tick); return; }
    const elapsed = times.reduce((a, b) => a + b, 0), sorted = [...times].sort((a, b) => a - b);
    const geometries = new Set(), textures = new Set(); let geometryBytes = 0, textureBytes = 0;
    game.scene.traverse(o => {
      const g = o.geometry;
      if (g && !geometries.has(g)) {
        geometries.add(g);
        for (const a of Object.values(g.attributes)) geometryBytes += a.array.byteLength;
        geometryBytes += g.index?.array.byteLength || 0;
      }
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) {
        for (const texture of Object.values(m)) if (texture?.isTexture && !textures.has(texture)) {
          textures.add(texture); const image = texture.image;
          if (image?.width) textureBytes += image.width * image.height * 4 * (texture.generateMipmaps ? 4 / 3 : 1);
        }
      }
    });
    const gl = game.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    resolve({ fps: times.length * 1000 / elapsed, medianMS: sorted[Math.floor(sorted.length * .5)],
      p95MS: sorted[Math.floor(sorted.length * .95)], framesOver50MS: times.filter(t => t > 50.5).length,
      pixelRatio: game.renderer.getPixelRatio(), quality: game.quality.stats,
      geometryMB: geometryBytes / 1048576, estimatedTextureMB: textureBytes / 1048576,
      calls: game.renderer.info.render.calls, triangles: game.renderer.info.render.triangles,
      renderer: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), chunks: game.chunks.stats });
  }
  requestAnimationFrame(tick);
})"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('city', choices=['davis', 'paris', 'hill'], default='davis', nargs='?')
    parser.add_argument('--url', default='http://localhost:8080')
    parser.add_argument('--channel', default=None)
    parser.add_argument('--night', action='store_true')
    parser.add_argument('--min-fps', type=float, default=0)
    parser.add_argument('--seconds', type=float, default=20)
    parser.add_argument('--native', action='store_true')
    args = parser.parse_args()
    at = {'davis': '', 'paris': '&at=48.85745,2.36154', 'hill': '&at=37.792,-122.414'}[args.city]
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel=args.channel, args=['--ignore-gpu-blocklist'])
        page = browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=2)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(args.url + '/?test' + at)
        page.wait_for_function('window.game?.ready', timeout=360000)
        page.evaluate("game.atmo.setWeatherMode('clear');game.setView(0,.12,7)")
        page.evaluate('(mode)=>game.atmo.setTimeMode(mode)', 'night' if args.night else 'day')
        if args.native:
            page.evaluate("game.quality.setMode('native')")
        # Allow shader compilation, pedestrian spawning and automatic resolution to settle.
        page.wait_for_timeout(25000)
        result = page.evaluate(MEASURE, args.seconds * 1000)
        print(json.dumps({'city': args.city, 'night': args.night, **result}, indent=2), flush=True)
        Path('screenshots').mkdir(exist_ok=True)
        page.screenshot(path=f'screenshots/performance-{args.city}-{"night" if args.night else "day"}.png')
        print('Errors:', errors, flush=True)
        browser.close()
    if errors or result['fps'] < args.min_fps:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
