// Run with node tools/check_ground.mjs; no browser or package manager required.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../js/surface.js', import.meta.url));
const { GroundSurface } = await import(`data:text/javascript;base64,${source.toString('base64')}`);
const mesh = (name, vertices, deckSurface = false, indices = null) => ({
  name, userData: { deckSurface }, geometry: {
    attributes: { position: { count: vertices.length / 3,
      getX: i => vertices[i * 3], getY: i => vertices[i * 3 + 1], getZ: i => vertices[i * 3 + 2] } },
    index: indices && { count: indices.length, getX: i => indices[i] },
  },
});
const plane = (name, base, gx = 0, gz = 0, deck = false) => mesh(name,
  [-16, -16, 16, -16, 16, 16, -16, 16].flatMap((v, i, a) =>
    i % 2 ? [] : [v, base + v * gx + a[i + 1] * gz, a[i + 1]]), deck, [0, 1, 2, 0, 2, 3]);
const close = (a, b) => assert(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
let yields = 0;
const surface = await GroundSurface.build([
  plane('ground', -0.1), plane('road', 0.028, 0.3, -0.1),
  plane('road', 8.028, 0.3, -0.1, true), plane('water', 100),
  mesh('sidewalk', [0, 0, 0, 0, 1, 0, 1, 1, 0]), // a vertical curb isn't a floor
], { tick: async () => { yields++; } });
assert(yields > 0, 'surface building yields to the main thread');
const normal = { set(x, y, z) { Object.assign(this, { x, y, z }); return this; },
  normalize() { const l = Math.hypot(this.x, this.y, this.z); this.x /= l; this.y /= l; this.z /= l; return this; } };
for (const [x, z] of [[0, 0], [-8, 8], [8, -8], [-16, -16], [16, 16], [7.999, -8.001]]) {
  const h = 0.028 + 0.3 * x - 0.1 * z;
  close(surface.heightAt(x, z, null, normal), h);
  close(normal.x / normal.y, -0.3); close(normal.z / normal.y, 0.1);
  close(surface.heightAt(x, z, h), h); // walking under a bridge
  close(surface.heightAt(x, z, h + 8), h + 8); // riding on its deck
}
assert.equal(surface.heightAt(17, 0), null, 'outside the chunk uses World fallback');
// Rebuilding replaces a chunk's surface; stale sidewalk heights must not survive.
const rebuilt = await GroundSurface.build([plane('ground', 0), plane('sidewalk', 0.15)]);
close(rebuilt.heightAt(0, 0), 0.15);
const replacement = await GroundSurface.build([plane('ground', 0), plane('road', 0.028)]);
close(replacement.heightAt(0, 0), 0.028);
console.log('Ground contacts: slopes, normals, chunk edges, bridges, curbs and rebuilds passed.');
