#!/usr/bin/env python3
"""Check actual hand/foot coordination in the browser, with the local server running.

    python3 tools/check_gait.py [--url http://localhost:8080] [--channel chrome]
Uses tools/requirements.txt and Playwright's Chromium (or an installed Chrome channel).
"""
import argparse
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

CHECK = r"""async () => {
  const T = await import('three'), { Character, LOOKS } = await import('/js/character.js');
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const p = new T.Vector3();
  const corr = (a, b) => {
    const mean = v => v.reduce((s, x) => s + x, 0) / v.length, ma = mean(a), mb = mean(b);
    return a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) /
      Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * b.reduce((s, x) => s + (x - mb) ** 2, 0));
  };
  const world = { groundAt(x, z, y, normal) { normal?.set(-0.12, 1, 0.05).normalize(); return 0.12 * x - 0.05 * z; } };
  const results = [];
  for (const low of [false, true]) for (const look of Object.keys(LOOKS)) {
    const c = new Character(look, { low, heightScale: low ? 0.93 : 1, buildScale: low ? 1.12 : 1 });
    await c.ready; assert(c.model, `${look}: model failed to load`);
    c.root.position.set(3, world.groundAt(3, 5), 5); c.root.rotation.y = 0.7;
    const localZ = key => c.root.worldToLocal(c.bones[key].getWorldPosition(p)).z;
    let worst = 1, minimumSwing = Infinity, maxJointError = 0;
    const lengths = [c.bones.al, c.bones.fl, c.bones.ar, c.bones.fr].map(b => {
      const child = b === c.bones.al ? c.bones.fl : b === c.bones.fl ? c.bones.handL : b === c.bones.ar ? c.bones.fr : c.bones.handR;
      const a = c.model.worldToLocal(b.getWorldPosition(new T.Vector3()));
      return { b, child, length: a.distanceTo(c.model.worldToLocal(child.getWorldPosition(new T.Vector3()))) };
    });
    // Include slow walking, gait blends, running/sprinting, stopping and restarting.
    for (const speed of [0.8, 1.6, 2.2, 2.8, 3.8, 5.6, 9, 0, 1.6]) {
      for (let i = 0; i < 90; i++) c.update(1 / 60, speed, false, world);
      // Conservative render bounds must include animated vertices, including long strides.
      c.root.updateMatrixWorld(true);
      c.model.traverse(m => {
        if (!m.isSkinnedMesh) return;
        m.skeleton.update();
        for (let i = 0; i < m.geometry.attributes.position.count; i += 13) {
          m.getVertexPosition(i, p);
          assert(m.boundingSphere?.containsPoint(p), `${look}/${speed}: animated vertex culled`);
        }
      });
      if (!speed) continue;
      const leftHand = [], rightHand = [], leftFoot = [], rightFoot = [];
      for (let i = 0; i < 240; i++) {
        c.update(1 / 60, speed, false, world); c.root.updateWorldMatrix(true, true);
        leftHand.push(localZ('handL') - localZ('al')); rightHand.push(localZ('handR') - localZ('ar'));
        leftFoot.push(localZ('footL') - localZ('ul')); rightFoot.push(localZ('footR') - localZ('ur'));
        for (const { b, child, length } of lengths) {
          const a = c.model.worldToLocal(b.getWorldPosition(new T.Vector3()));
          const d = a.distanceTo(c.model.worldToLocal(child.getWorldPosition(p)));
          maxJointError = Math.max(maxJointError, Math.abs(d - length));
        }
      }
      const opposition = Math.min(corr(leftHand, rightFoot), corr(rightHand, leftFoot));
      const swing = Math.min(...[leftHand, rightHand].map(v => Math.max(...v) - Math.min(...v)));
      assert(opposition > 0.85, `${look}/${low}/${speed}: arms follow the wrong leg (${opposition})`);
      assert(swing > 0.08, `${look}/${low}/${speed}: arms are frozen (${swing})`);
      worst = Math.min(worst, opposition); minimumSwing = Math.min(minimumSwing, swing);
    }
    assert(maxJointError < 0.001, `${look}: disconnected arm joints (${maxJointError})`);
    // Jumping and riding use separate poses; returning must leave a valid rig.
    for (let i = 0; i < 60; i++) c.update(1 / 60, 5.6, true, world);
    c.setSeat('bike'); for (let i = 0; i < 60; i++) c.update(1 / 60, 4, false, world);
    c.setSeat(null); for (let i = 0; i < 90; i++) c.update(1 / 60, 1.6, false, world);
    assert([...Object.values(c.bones)].every(b => [...b.position.toArray(), ...b.quaternion.toArray()].every(Number.isFinite)), `${look}: invalid pose`);
    results.push({ look, low, oppositeLimbCorrelation: +worst.toFixed(3), minimumSwing: +minimumSwing.toFixed(3), maxJointError });
    c.dispose();
  }
  return results;
}"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://localhost:8080')
    parser.add_argument('--channel', default=None)
    args = parser.parse_args()
    errors = []
    index = (Path(__file__).resolve().parent.parent / 'index.html').read_text()
    importmap = re.search(r'<script type="importmap">.*?</script>', index, re.S).group()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel=args.channel)
        page = browser.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
        page.goto(args.url.rstrip('/') + '/assets/characters/CREDITS.md')
        page.set_content(f'<base href="{args.url.rstrip("/")}/">{importmap}')
        print(json.dumps(page.evaluate(CHECK), indent=2))
        browser.close()
    if errors:
        raise SystemExit('\n'.join(errors))
    print('Gait coordination passed for all avatars and pedestrian variants.')


if __name__ == '__main__':
    main()
