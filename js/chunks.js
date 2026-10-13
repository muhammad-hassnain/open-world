// Streams the world around the player in chunks.
//
// Data arrives per z14 tile (one download covers 16 chunks). Each z16 chunk is clipped out
// of its tile, indexed for queries, and built at one of two detail levels:
//   full: buildings with facades, sidewalks, markings, trees, props, labels (near the player)
//   lite: walls and roofs, ground, areas and road surfaces (the horizon)

import * as THREE from 'three';
import { CHUNK_ZOOM, DATA_ZOOM, distToRect, fromMerc } from './geo.js';
import { fetchTile, toLocal } from './tiledata.js';
import { aerialCovers, fetchAerial, sampleRoofs } from './aerial.js';
import { clipRing, clipLine } from './clip.js';
import { ChunkIndex, classifyRoad, roadHalfWidth } from './world.js';
import { planBuildings, buildBuildings } from './buildings.js';
import { buildStreets } from './streets.js';
import { elevateRoads } from './bridges.js';
import { buildTrees, buildFurniture, buildParkedCars } from './props.js';
import { buildLights } from './traffic.js';
import { Budget, SpatialHash, resample, closestOnSeg, pointInShape } from './util.js';

export const FULL_R = 230;   // build full detail for chunks closer than this (meters)
export const LITE_R = 650;   // keep lite chunks out to here
const DOWN_R = 420;          // full chunks farther than this drop back to lite
const DROP_R = 900;          // unload chunks farther than this
const SHIFT = CHUNK_ZOOM - DATA_ZOOM;

export class ChunkManager {
  constructor({ frame, world, scene, labels, minimap, materials, terrain = null }) {
    Object.assign(this, { frame, world, scene, labels, minimap, materials, terrain });
    // Heights are measured from the walk-in point, so its terrain must load before anything is built.
    const o = frame.tileAt(0, 0, DATA_ZOOM);
    this.terrainReady = terrain ? terrain.ensure(o.x, o.y).then(() => terrain.setBaseAt(0, 0)) : Promise.resolve();
    this.tiles = new Map();
    this.chunks = new Map();
    this.player = { x: 0, z: 0 };
    this.pumping = null;
    this.disposed = false;
    this.stats = { tiles: 0, full: 0, lite: 0 };
  }

  update(x, z) {
    this.player = { x, z };
    if (!this.pumping) this.pumping = this._pump().finally(() => { this.pumping = null; });
  }

  // Load and build everything near (x, z); resolves when the area is ready to play.
  async warmup(x, z, onProgress) {
    this.player = { x, z };
    for (;;) {
      const want = this._wanted();
      const need = want.filter((w) => w.level === 'full');
      const done = need.filter((w) => this.chunks.get(w.key)?.state === 'full').length;
      const lite = want.filter((w) => w.level === 'lite');
      const liteDone = lite.filter((w) => ['lite', 'full'].includes(this.chunks.get(w.key)?.state)).length;
      if (onProgress) onProgress((done + liteDone) / Math.max(1, need.length + lite.length));
      if (done === need.length && liteDone === lite.length) return;
      this.update(x, z);
      await this.pumping;
      if (this.disposed) return;
    }
  }

  dispose() {
    this.disposed = true;
    for (const ch of this.chunks.values()) this._drop(ch);
    this.chunks.clear();
  }

  // ---------- planning ----------

  _wanted() {
    const { x, z } = this.player;
    const a = this.frame.tileAt(x - LITE_R, z - LITE_R, CHUNK_ZOOM), b = this.frame.tileAt(x + LITE_R, z + LITE_R, CHUNK_ZOOM);
    const out = [];
    for (let tx = a.x; tx <= b.x; tx++) {
      for (let ty = a.y; ty <= b.y; ty++) {
        const rect = this.frame.tileRect(CHUNK_ZOOM, tx, ty);
        const d = distToRect(x, z, rect);
        if (d > LITE_R) continue;
        out.push({ key: `${CHUNK_ZOOM}/${tx}/${ty}`, tx, ty, rect, d, level: d < FULL_R ? 'full' : 'lite' });
      }
    }
    return out.sort((p, q) => p.d - q.d);
  }

  async _pump() {
    while (!this.disposed) {
      const job = this._nextJob();
      if (!job) return;
      await job();
    }
  }

  _nextJob() {
    const { x, z } = this.player;
    for (const ch of [...this.chunks.values()]) {
      if (distToRect(x, z, ch.rect) > DROP_R) { this._drop(ch); this.chunks.delete(ch.key); }
    }
    const want = this._wanted();
    for (const w of want) {
      if (!this.chunks.has(w.key)) this.chunks.set(w.key, { key: w.key, tx: w.tx, ty: w.ty, rect: w.rect, state: 'none', group: null, index: null });
    }
    // 1. Index everything wanted first, so builds can see neighboring chunks.
    for (const w of want) {
      const ch = this.chunks.get(w.key);
      if (ch.state === 'none') return () => this._index(ch);
    }
    // 2. Build nearest-first.
    for (const w of want) {
      const ch = this.chunks.get(w.key);
      if (w.level === 'full' && ch.state !== 'full') return () => this._build(ch, 'full');
      if (w.level === 'lite' && ch.state === 'indexed') return () => this._build(ch, 'lite');
    }
    // 3. Drop detail that is now far away.
    for (const ch of this.chunks.values()) {
      if (ch.state === 'full' && distToRect(x, z, ch.rect) > DOWN_R) return () => this._build(ch, 'lite');
    }
    return null;
  }

  // ---------- data ----------

  _tile(tx, ty) {
    const key = `${DATA_ZOOM}/${tx}/${ty}`;
    if (!this.tiles.has(key)) {
      const n = 2 ** DATA_ZOOM;
      const [lat, lon] = fromMerc((tx + 0.5) / n, (ty + 0.5) / n);
      const aerial = aerialCovers(lat, lon) ? fetchAerial(DATA_ZOOM, tx, ty) : Promise.resolve(null);
      const heights = this.terrain ? this.terrain.ensure(tx, ty) : null;
      this.tiles.set(key, Promise.all([fetchTile(DATA_ZOOM, tx, ty), aerial, heights])
        .then(([raw, img]) => {
          const d = prepareTile(toLocal(raw, this.frame.tileProjector(DATA_ZOOM, tx, ty, raw.extent || 4096)));
          elevateRoads(d, this.terrain ? (x, z) => this.terrain.at(x, z) : () => 0);
          if (img) sampleRoofs(img, d.buildings, this.frame.tileRect(DATA_ZOOM, tx, ty));
          return d;
        })
        .catch((e) => {
          console.warn(`[tiles] ${key} failed, showing empty ground`, e);
          return prepareTile({ source: 'vector', buildings: [], roads: [], pois: [], places: [], areas: [], zones: [], lines: [], trees: [], props: [] });
        }));
      this.stats.tiles = this.tiles.size;
    }
    return this.tiles.get(key);
  }

  async _index(ch) {
    await this.terrainReady;
    const tile = await this._tile(ch.tx >> SHIFT, ch.ty >> SHIFT);
    if (this.disposed || this.chunks.get(ch.key) !== ch) return;
    const ci = new ChunkIndex(ch.key, ch.rect, clipData(tile, ch.rect));
    for (const p of ci.pois) {
      for (const b of ci.buildingHash.near(p.x, p.z, 0)) {
        if (pointInShape(p.x, p.z, b.outer, b.holes)) { p.building = b; b.pois.push(p); break; }
      }
    }
    ch.index = ci;
    ch.state = 'indexed';
    this.world.add(ci);
    this.minimap.addChunk(ci);
  }

  // ---------- building ----------

  async _build(ch, level) {
    const ci = ch.index;
    const budget = new Budget(5);
    const full = level === 'full';
    const group = new THREE.Group();
    ci.resetDynamic();
    await planBuildings(this.world, ci.buildings, { streets: full, rect: ci.rect, budget });
    if (!this._alive(ch)) return;
    const buildingMeshes = await buildBuildings(ci.buildings, this.materials, { lite: !full, rect: ci.rect, budget });
    if (buildingMeshes.length) group.add(...buildingMeshes);  // add() with nothing logs an error
    const streets = await buildStreets(this.world, ci, this.materials, { lite: !full, budget });
    if (streets.meshes.length) group.add(...streets.meshes);
    if (full) {
      await buildTrees(this.world, ci, streets.spots, group, budget);
      buildFurniture(this.world, ci, streets.spots, group);
      buildParkedCars(this.world, ci, streets.spots, group);
    }
    const lights = full ? buildLights(this.world, ci, group) : null;
    if (!this._alive(ch)) { disposeGroup(group); return; }
    if (ch.group) { this.scene.remove(ch.group); disposeGroup(ch.group); }
    this.scene.add(group);
    ch.group = group;
    ch.lights = lights;
    ch.state = level;
    if (full) await this.labels.addChunk(ci, budget);
    else this.labels.removeChunk(ci.key);
    this.stats.full = [...this.chunks.values()].filter((c) => c.state === 'full').length;
    this.stats.lite = [...this.chunks.values()].filter((c) => c.state === 'lite').length;
  }

  _alive(ch) { return !this.disposed && this.chunks.get(ch.key) === ch; }

  _drop(ch) {
    if (ch.group) { this.scene.remove(ch.group); disposeGroup(ch.group); ch.group = null; }
    if (ch.index) {
      this.world.remove(ch.key);
      this.labels.removeChunk(ch.key);
      this.minimap.removeChunk(ch.key);
    }
  }
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.userData.shared) o.geometry.dispose();
    for (const m of [].concat(o.material)) if (!m.userData.shared) m.dispose();
    if (o.isInstancedMesh) o.dispose();
  });
}

// ---------- tile preparation (in local meters) ----------

function prepareTile(d) {
  for (const r of d.roads) r._k = classifyRoad(r);
  splitAtTJunctions(d.roads.filter((r) => r._k === 'car' || r._k === 'service'));
  fitRoadWidths(d);
  if (d.source === 'vector') d.roads = classifyFootways(d.roads);
  for (const r of d.roads) delete r._k;
  return d;
}

// Default road widths are generous; in old city centers the buildings stand closer than that.
// Measure the wall-to-wall width along each street and narrow the carriageway to leave
// about 2 m of sidewalk on each side.
function fitRoadWidths(d) {
  const hash = new SpatialHash(24);
  for (const b of d.buildings) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of b.o) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    hash.insert({ ring: b.o }, minX, minZ, maxX, maxZ);
  }
  const MAX = 20;
  const ray = (x, z, dx, dz) => {
    let best = MAX;
    for (const b of hash.query(Math.min(x, x + dx * MAX), Math.min(z, z + dz * MAX), Math.max(x, x + dx * MAX), Math.max(z, z + dz * MAX))) {
      const ring = b.ring;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const ex = c[0] - a[0], ez = c[1] - a[1];
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((a[0] - x) * ez - (a[1] - z) * ex) / den;
        const u = ((a[0] - x) * dz - (a[1] - z) * dx) / den;
        if (t > 0 && t < best && u >= 0 && u <= 1) best = t;
      }
    }
    return best;
  };
  for (const r of d.roads) {
    if (r._k !== 'car' || r.w) continue;
    const full = roadHalfWidth(r, 'car') * 2;
    const samples = resample(r.p, 8);
    const widths = [];
    for (const s of samples) {
      const l = ray(s.x, s.z, s.tz, -s.tx), rr = ray(s.x, s.z, -s.tz, s.tx);
      if (l < MAX && rr < MAX) widths.push(l + rr);
    }
    if (widths.length < Math.max(1, samples.length * 0.4)) continue;
    widths.sort((a, b) => a - b);
    const wall = widths[Math.floor(widths.length * 0.3)];
    const carriage = Math.max(4.5, Math.min(full, wall - 4));
    if (carriage < full - 0.5) r.w = Math.round(carriage * 10) / 10;
  }
}

// Vector tiles sometimes drop the shared vertex where a side street meets a through street.
// Re-insert it so intersections can be found by matching coordinates.
function splitAtTJunctions(roads) {
  const hash = new SpatialHash(16);
  for (const r of roads) {
    for (let i = 0; i < r.p.length - 1; i++) {
      const a = r.p[i], b = r.p[i + 1];
      hash.insert({ r, i, ax: a[0], az: a[1], bx: b[0], bz: b[1] }, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    }
  }
  const inserts = new Map();
  for (const r of roads) {
    for (const end of [r.p[0], r.p[r.p.length - 1]]) {
      for (const s of hash.near(end[0], end[1], 0.6)) {
        if (s.r === r) continue;
        const q = closestOnSeg(end[0], end[1], s.ax, s.az, s.bx, s.bz);
        if (q.d > 0.6 || q.t < 1e-3 || q.t > 1 - 1e-3) continue;
        if (!inserts.has(s.r)) inserts.set(s.r, []);
        inserts.get(s.r).push({ i: s.i, t: q.t, p: [end[0], end[1]] });
      }
    }
  }
  for (const [r, list] of inserts) {
    list.sort((a, b) => b.i - a.i || b.t - a.t);
    for (const ins of list) r.p.splice(ins.i + 1, 0, ins.p);
  }
}

// Vector tiles don't say which footways are sidewalks or crossings; infer it from geometry.
// Footways running alongside a street become sidewalks, the bits crossing asphalt become crossings.
function classifyFootways(roads) {
  const cars = new SpatialHash(20);
  for (const r of roads) {
    if (r._k !== 'car') continue;
    const hw = roadHalfWidth(r, 'car');
    for (let i = 0; i < r.p.length - 1; i++) {
      const a = r.p[i], b = r.p[i + 1];
      cars.insert({ hw, ax: a[0], az: a[1], bx: b[0], bz: b[1] }, Math.min(a[0], b[0]) - hw, Math.min(a[1], b[1]) - hw, Math.max(a[0], b[0]) + hw, Math.max(a[1], b[1]) + hw);
    }
  }
  const out = [];
  for (const r of roads) {
    if (r._k !== 'path' || (r.t !== 'footway' && r.t !== 'path')) { out.push(r); continue; }
    const samples = resample(r.p, 2);
    const cls = samples.map((s) => {
      let best = null;
      for (const c of cars.near(s.x, s.z, 12)) {
        const q = closestOnSeg(s.x, s.z, c.ax, c.az, c.bx, c.bz);
        const l = Math.hypot(c.bx - c.ax, c.bz - c.az) || 1;
        const par = Math.abs((s.tx * (c.bx - c.ax) + s.tz * (c.bz - c.az)) / l);
        if (!best || q.d - c.hw < best.gap) best = { gap: q.d - c.hw, par };
      }
      if (!best) return 'p';
      // Alongside a street (even inside its assumed width, since real streets are often narrower): sidewalk.
      if (best.gap < 7 && best.par > 0.85) return 's';
      // Across the asphalt at a clear angle: crossing.
      if (best.gap < 0 && best.par < 0.6) return 'c';
      return 'p';
    });
    // Build runs of equal class; absorb runs shorter than 3 samples into the previous run.
    const runs = [];
    for (let i = 0; i < samples.length; i++) {
      const last = runs[runs.length - 1];
      if (last && last.c === cls[i]) last.pts.push(samples[i]);
      else runs.push({ c: cls[i], pts: last ? [last.pts[last.pts.length - 1], samples[i]] : [samples[i]] });
    }
    for (let i = runs.length - 1; i > 0; i--) {
      if (runs[i].pts.length < 3 && runs[i].c !== 'c') { runs[i - 1].pts.push(...runs[i].pts.slice(1)); runs.splice(i, 1); }
    }
    for (const run of runs) {
      if (run.pts.length < 2) continue;
      const piece = { ...r, p: run.pts.map((s) => [s.x, s.z]) };
      if (run.c === 's') piece.fw = 'sidewalk';
      else if (run.c === 'c') piece.fw = 'crossing';
      out.push(piece);
    }
  }
  return out;
}

// ---------- clip a tile's data to a chunk ----------

function clipPolys(list, rect) {
  const out = [];
  for (const a of list) {
    const o = clipRing(a.o, rect);
    if (!o) continue;
    const i = (a.i || []).map((h) => clipRing(h, rect)).filter(Boolean).map((h) => h.ring);
    out.push({ ...a, o: o.ring, i: i.length ? i : undefined, clipped: o.clipped });
  }
  return out;
}

function clipData(t, rect) {
  const inside = (x, z) => x >= rect.minX && x < rect.maxX && z >= rect.minZ && z < rect.maxZ;
  return {
    source: t.source,
    buildings: clipPolys(t.buildings, rect),
    areas: clipPolys(t.areas, rect),
    zones: clipPolys(t.zones || [], rect),
    roads: t.roads.flatMap((r) => clipLine(r.p, rect).map((p) => ({ ...r, p }))),
    lines: t.lines.flatMap((l) => clipLine(l.p, rect).map((p) => ({ ...l, p }))),
    pois: t.pois.filter((p) => inside(p.x, p.z)).map((p) => ({ ...p })),
    places: (t.places || []).filter((p) => inside(p.x, p.z)),
    trees: t.trees.filter((p) => inside(p[0], p[1])),
    props: t.props.filter((p) => inside(p.x, p.z)),
  };
}
