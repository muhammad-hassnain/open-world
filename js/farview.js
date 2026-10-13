// The far view: low-detail land and sea out to about 20 km, beyond the streamed chunks, so from a
// hill or a tower you can see the landscape (and the sunset over the sea). Elevation comes from
// the same Terrain Tiles at zoom 12 (about 30 m per pixel); the land is colored by height and
// slope. A ring mesh around the player (denser near) is rebuilt when they move far. Near the
// player it sinks under the detailed ground, and it is drawn slightly behind it, so streets win.
import * as THREE from 'three';
import { Terrain } from './terrain.js';
import { clamp } from './util.js';

const ZOOM = 12;
const OUTER = 20000;      // meters
const INNER = 420;
const RINGS = 72, SEGS = 220;
const REBUILD = 2500;     // rebuild after moving this far from the mesh center

const SAND = new THREE.Color('#b8ab86'), GREEN = new THREE.Color('#5f7f45'), DARK = new THREE.Color('#455f36');
const ROCK = new THREE.Color('#7f7a70'), SNOW = new THREE.Color('#eef2f5');

// Push vertices slightly away from the camera so the detailed ground wins where both exist.
function pushedBack(m) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      {
        float viewDist = length(mvPosition.xyz);
        mvPosition.xyz *= 1.0 + 0.004 + 1.5 / max(viewDist, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      }`);
  };
  m.customProgramCacheKey = () => 'far-view';
  return m;
}

export class FarView {
  constructor({ scene, frame, base }) {
    this.scene = scene;
    this.frame = frame;
    this.terrain = new Terrain(frame, { zoom: ZOOM });
    this.terrain.base = base;
    this.center = null;
    this.ready = false;
    this.land = null;
    this.sea = null;
    this.landMat = pushedBack(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.4 }));
    this.seaMat = pushedBack(new THREE.MeshStandardMaterial({ color: '#1d3a52', roughness: 0.12, metalness: 0.1, envMapIntensity: 1.3 }));
    this.busy = false;
  }

  dispose() {
    for (const m of [this.land, this.sea]) if (m) { this.scene.remove(m); m.geometry.dispose(); }
    this.landMat.dispose(); this.seaMat.dispose();
    this.disposed = true;
  }

  // Raw elevation relative to the walk-in point (NaN-safe: missing tiles count as the base).
  at(x, z) { return this.terrain.at(x, z); }

  // Every frame: rebuild around the player when they've moved far from the last center.
  update(p) {
    if (this.busy || this.disposed) return;
    if (this.center && Math.hypot(p.x - this.center.x, p.z - this.center.z) < REBUILD) return;
    this.busy = true;
    this._build(p.x, p.z).catch((e) => console.warn(`Far view: ${e.message}`)).finally(() => { this.busy = false; });
  }

  async _build(cx, cz) {
    const f = this.frame, n = 2 ** ZOOM;
    // Every zoom-12 tile within the outer radius.
    const tile = (x, z) => [Math.floor((f.mx0 + x / f.scale) * n), Math.floor((f.my0 + z / f.scale) * n)];
    const [x0, y0] = tile(cx - OUTER, cz - OUTER), [x1, y1] = tile(cx + OUTER, cz + OUTER);
    const loads = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) loads.push(this.terrain.ensureTile(x, y));
    await Promise.all(loads);
    if (this.disposed) return;

    const pos = new Float32Array(RINGS * SEGS * 3), col = new Float32Array(RINGS * SEGS * 3);
    let lowest = Infinity;
    const c = new THREE.Color();
    const seaLevel = this.terrain.seaLevel;
    for (let i = 0; i < RINGS; i++) {
      const r = INNER * (OUTER / INNER) ** (i / (RINGS - 1));
      for (let j = 0; j < SEGS; j++) {
        const a = (j / SEGS) * Math.PI * 2;
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        let y = this.at(x, z);
        const abs = y - seaLevel;  // meters above the sea
        // Slope from neighbors one sample apart (rings get coarser outward).
        const d = Math.max(30, r * 0.04);
        const slope = Math.hypot(this.at(x + d, z) - y, this.at(x, z + d) - y) / d;
        if (abs < 3) c.copy(SAND);
        else c.copy(GREEN).lerp(DARK, clamp((abs - 200) / 1200, 0, 1));
        if (slope > 0.55) c.lerp(ROCK, clamp((slope - 0.55) * 2, 0, 1));
        if (abs > 3200) c.lerp(SNOW, clamp((abs - 3200) / 600, 0, 1));
        // Sink under the detailed chunks near the player.
        y -= 14 * (1 - clamp((r - INNER) / 600, 0, 1));
        lowest = Math.min(lowest, y);
        const k = (i * SEGS + j) * 3;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
    }
    const idx = [];
    for (let i = 0; i < RINGS - 1; i++) {
      for (let j = 0; j < SEGS; j++) {
        const a = i * SEGS + j, b = i * SEGS + ((j + 1) % SEGS), cI = (i + 1) * SEGS + j, dI = (i + 1) * SEGS + ((j + 1) % SEGS);
        idx.push(a, b, cI, b, dI, cI);  // counter-clockwise from above
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    if (this.land) { this.scene.remove(this.land); this.land.geometry.dispose(); }
    this.land = new THREE.Mesh(geo, this.landMat);
    this.land.receiveShadow = false;
    this.scene.add(this.land);

    // Sea: a disc at sea level wherever the land dips below it.
    if (this.sea) { this.scene.remove(this.sea); this.sea.geometry.dispose(); this.sea = null; }
    if (lowest < seaLevel + 1) {
      const g = new THREE.RingGeometry(INNER * 0.9, OUTER, SEGS, 8).rotateX(-Math.PI / 2);
      g.translate(cx, seaLevel - 0.6, cz);
      this.sea = new THREE.Mesh(g, this.seaMat);
      this.scene.add(this.sea);
    }
    this.center = { x: cx, z: cz };
    this.ready = true;
  }

  // Lowest ground within ~1.5 km of (x, z) (for how high the player is above the surroundings).
  lowAround(x, z) {
    let low = this.at(x, z);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      for (const r of [600, 1500]) low = Math.min(low, this.at(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return Math.max(low, this.terrain.seaLevel);
  }
}
