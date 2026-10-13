// Speed cameras and speed zones on real major roads. Placed on a latitude/longitude grid (one
// try per ~900 m cell, seeded by the cell) so each sits at the same real place on every visit;
// personal bests are kept in this browser by place. A camera records your speed as you pass;
// a zone times you between its start and end gates (average speed).

import * as THREE from 'three';
import { deckY } from './bridges.js';

const CELL = 0.008;              // degrees of latitude/longitude per cell (~900 m)
const CAM_CHANCE = 0.55, ZONE_CHANCE = 0.35;
const ZONE_LEN = 520;            // m
const NEAR = 1300;               // m: decide cells this close
const MAJOR = /^(motorway|trunk|primary|secondary)(_link)?$/;
const BEST = 'openworld.best.';

const hash = (a, b, salt) => {
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const loadBest = (id) => { try { return Number(localStorage.getItem(BEST + id)) || 0; } catch { return 0; } };
const saveBest = (id, v) => { try { localStorage.setItem(BEST + id, String(v)); } catch { /* storage unavailable */ } };

const MAT = {
  pole: new THREE.MeshStandardMaterial({ color: '#8d9298', metalness: 0.6, roughness: 0.45 }),
  box: new THREE.MeshStandardMaterial({ color: '#f2c94c', roughness: 0.5 }),
  lens: new THREE.MeshStandardMaterial({ color: '#111', emissive: '#ffffff', emissiveIntensity: 0, roughness: 0.2 }),
  zone: new THREE.MeshStandardMaterial({ color: '#2a7de8', emissive: '#2a7de8', emissiveIntensity: 0.25 }),
};
for (const m of Object.values(MAT)) m.userData.shared = true;

function bannerTexture(text) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 96;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1d4f9c'; ctx.fillRect(0, 0, 512, 96);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 6; ctx.strokeRect(6, 6, 500, 84);
  ctx.fillStyle = '#fff'; ctx.font = '800 52px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 50);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SpeedCams {
  // pop(title, big, sub): the big event message. award(points, label): speed points.
  constructor({ scene, world, pop, award }) {
    Object.assign(this, { scene, world, pop, award });
    this.cells = new Map();  // cell key -> [] of events placed there (or empty)
    this.items = [];         // { kind: 'cam' | 'zone', id, gates: [{ x, z, tx, tz, hw, prev }], group, ... }
    this.t = 0; this.decideT = 0;
    this.zone = null;        // the zone being timed: { item, t0 }
  }

  dispose() {
    for (const it of this.items) this._remove(it);
    this.items = [];
    this.cells.clear();
  }

  markers() {
    return this.items.map((it) => ({ x: it.gates[0].x, z: it.gates[0].z, cam: it.kind === 'cam', zone: it.kind === 'zone' }));
  }

  update(dt, player) {
    this.t += dt;
    const p = player.pos;
    this.decideT -= dt;
    if (this.decideT <= 0) { this.decideT = 1.5; this._decide(p.x, p.z); this._prune(p.x, p.z); }
    const v = player.vehicle;
    for (const it of this.items) {
      for (const [gi, g] of it.gates.entries()) {
        const along = (p.x - g.x) * g.tx + (p.z - g.z) * g.tz;
        const lat = Math.abs((p.x - g.x) * -g.tz + (p.z - g.z) * g.tx);
        const crossed = g.prev !== undefined && Math.sign(along) !== Math.sign(g.prev) && lat < g.hw + 2.5;
        g.prev = along;
        if (!crossed || !v || v.kind !== 'car') continue;
        if (it.kind === 'cam') this._camera(it, v);
        else this._zoneGate(it, gi);
      }
    }
    if (this.zone && this.t - this.zone.t0 > 90) this.zone = null;  // gave up
    MAT.lens.emissiveIntensity = Math.max(0, MAT.lens.emissiveIntensity - dt * 6);
  }

  _camera(it, v) {
    const ms = Math.abs(v.speed);
    if (ms < 4) return;
    const best = loadBest(it.id);
    const rec = ms > best;
    if (rec) saveBest(it.id, ms);
    MAT.lens.emissiveIntensity = 4;
    this.pop('SPEED CAMERA', ms, rec && best ? 'NEW BEST' : best ? { best } : 'FIRST RECORD');
    this.award(Math.round(ms * 12), 'SPEED CAMERA');
  }

  _zoneGate(it, gi) {
    if (gi === 0 && (!this.zone || this.zone.item !== it)) {
      this.zone = { item: it, t0: this.t };
      this.pop('SPEED ZONE', null, 'Timing… keep it fast');
      return;
    }
    if (gi === 1 && this.zone && this.zone.item === it) {
      const avg = it.len / Math.max(0.5, this.t - this.zone.t0);
      this.zone = null;
      const best = loadBest(it.id);
      if (avg > best) saveBest(it.id, avg);
      this.pop('SPEED ZONE AVERAGE', avg, avg > best && best ? 'NEW BEST' : best ? { best } : 'FIRST RECORD');
      this.award(Math.round(avg * 25), 'SPEED ZONE');
    }
  }

  // Place events in grid cells near (x, z) that haven't been decided yet.
  _decide(x, z) {
    const f = this.world.frame;
    const [lat, lon] = f.toLatLon(x, z);
    const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
    for (let i = ci - 2; i <= ci + 2; i++) {
      for (let j = cj - 2; j <= cj + 2; j++) {
        const key = `${i},${j}`;
        if (this.cells.has(key)) continue;
        const tlat = (i + 0.2 + hash(i, j, 1) * 0.6) * CELL, tlon = (j + 0.2 + hash(i, j, 2) * 0.6) * CELL;
        const [tx, tz] = f.toLocal(tlat, tlon);
        if (Math.hypot(tx - x, tz - z) > NEAR) continue;
        if (!this.world.near(tx, tz, 300).length) continue;  // not loaded yet
        const placed = [];
        this.cells.set(key, placed);
        const kind = hash(i, j, 3) < CAM_CHANCE ? 'cam' : hash(i, j, 4) < ZONE_CHANCE / (1 - CAM_CHANCE) ? 'zone' : null;
        if (!kind) continue;
        const rd = this.world.nearestRoad(tx, tz, 300, (r) => r.kind === 'car' && MAJOR.test(r.t));
        if (!rd) continue;
        const a = rd.road.p[rd.seg], b = rd.road.p[rd.seg + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const g0 = { x: rd.x, z: rd.z, tx: (b[0] - a[0]) / l, tz: (b[1] - a[1]) / l, hw: rd.road.hw, road: rd.road };
        const id = `${kind}:${key}`;
        if (kind === 'cam') placed.push(this._add({ kind, id, gates: [g0] }));
        else {
          const end = this._ahead(g0, ZONE_LEN);
          if (end) placed.push(this._add({ kind, id, gates: [g0, end], len: ZONE_LEN }));
        }
      }
    }
  }

  // Forget events far away (they come back the same when you return).
  _prune(x, z) {
    for (const it of [...this.items]) {
      const g = it.gates[0];
      if (Math.hypot(g.x - x, g.z - z) < 2600) continue;
      this._remove(it);
      this.items = this.items.filter((o) => o !== it);
      this.cells.delete(it.id.split(':')[1]);
    }
  }

  // ZONE_LEN along the roads from a gate (straightest way at junctions).
  _ahead(g, dist) {
    const w = this.world;
    let x = g.x, z = g.z, tx = g.tx, tz = g.tz, left = dist, last = null;
    for (let guard = 0; guard < 200 && left > 0; guard++) {
      const step = Math.min(20, left);
      const nx = x + tx * step, nz = z + tz * step;
      const rd = w.nearestRoad(nx, nz, 12, (r) => r.kind === 'car');
      if (!rd) return null;
      const a = rd.road.p[rd.seg], b = rd.road.p[rd.seg + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let dx = (b[0] - a[0]) / l, dz = (b[1] - a[1]) / l;
      if (dx * tx + dz * tz < 0) { dx = -dx; dz = -dz; }
      x = rd.x; z = rd.z; tx = dx; tz = dz; left -= step;
      last = { x, z, tx, tz, hw: rd.road.hw, road: rd.road };
    }
    return last;
  }

  _add(it) {
    const g = new THREE.Group();
    const textures = [];
    for (const [gi, gate] of it.gates.entries()) {
      const r = gate.road;
      const base = r.ez ? deckY(r, gate.x, gate.z) : this.world.elevation(gate.x, gate.z);
      const nx = -gate.tz, nz = gate.tx, off = gate.hw + 1.2;
      const px = gate.x + nx * off, pz = gate.z + nz * off;
      if (it.kind === 'cam') {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 5, 8), MAT.pole);
        pole.position.set(px, base + 2.5, pz);
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.8), MAT.box);
        box.position.set(px - nx * 0.4, base + 5, pz - nz * 0.4);
        box.rotation.y = Math.atan2(gate.tx, gate.tz);
        const lens = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.05), MAT.lens);
        lens.position.set(px - nx * 0.4 - gate.tx * 0.42, base + 5, pz - nz * 0.4 - gate.tz * 0.42);
        lens.rotation.y = box.rotation.y;
        g.add(pole, box, lens);
      } else {
        const tex = bannerTexture(gi === 0 ? 'SPEED ZONE' : 'ZONE END');
        textures.push(tex);
        const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 });
        for (const side of [-1, 1]) {
          const q = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.4, 0.16), MAT.zone);
          q.position.set(gate.x + nx * side * off, base + 1.7, gate.z + nz * side * off);
          g.add(q);
        }
        const banner = new THREE.Mesh(new THREE.BoxGeometry(off * 2, 0.6, 0.08), [MAT.zone, MAT.zone, MAT.zone, MAT.zone, face, face]);
        banner.position.set(gate.x, base + 3.4, gate.z);
        banner.rotation.y = Math.atan2(-gate.tx, -gate.tz);
        g.add(banner);
        it.faceMat = face;
      }
    }
    this.scene.add(g);
    it.group = g; it.textures = textures;
    this.items.push(it);
    return it;
  }

  _remove(it) {
    this.scene.remove(it.group);
    it.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const t of it.textures) t.dispose();
    if (it.faceMat) it.faceMat.dispose();
  }
}
