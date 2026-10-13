import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, SpatialHash, pointInShape, pick } from './util.js';
import { inRect } from './clip.js';

// ---------- shared geometry helpers ----------

function paint(geom, hex) {
  const g = geom.index ? geom.toNonIndexed() : geom;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
const at = (g, x, y, z) => g.translate(x, y, z);
const box = (w, h, d, hex, x = 0, y = 0, z = 0) => at(paint(new THREE.BoxGeometry(w, h, d), hex), x, y, z);
const cyl = (rt, rb, h, seg, hex, x = 0, y = 0, z = 0) => at(paint(new THREE.CylinderGeometry(rt, rb, h, seg), hex), x, y, z);
const merge = (parts) => mergeGeometries(parts, false);
const shared = (o) => { o.userData.shared = true; return o; };

// Built once on first use and reused by every chunk (never disposed).
let ASSETS = null;
function assets() {
  if (ASSETS) return ASSETS;
  const vc = shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, envMapIntensity: 0.6 }));
  ASSETS = {
    vc,
    leaf: shared(new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9, envMapIntensity: 0.5 })),
    trunk: shared(new THREE.MeshStandardMaterial({ color: '#6e5038', roughness: 0.95 })),
    lampHead: shared(new THREE.MeshStandardMaterial({ color: '#fff3cf', emissive: '#ffe7a8', emissiveIntensity: 0.35, roughness: 0.4 })),
    geo: Object.fromEntries(Object.entries({
      ...treeGeometries(), lamp: lampGeometry(), lampHead: lampHeadGeometry(), bench: benchGeometry(),
      bikerack: bikeRackGeometry(), hydrant: hydrantGeometry(), bin: binGeometry(),
      carBody: carBodyGeometry(), carDetail: carDetailGeometry(),
    }).map(([k, g]) => [k, shared(g)])),
  };
  return ASSETS;
}

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function instanced(geom, material, items, { cast = true, colors = null } = {}) {
  const mesh = new THREE.InstancedMesh(geom, material, Math.max(1, items.length));
  mesh.count = items.length;
  items.forEach((it, i) => {
    tmpQ.setFromAxisAngle(Y_AXIS, it.rot || 0);
    tmpS.set(it.s ?? 1, it.s ?? 1, it.s ?? 1);
    tmpP.set(it.x, it.y || 0, it.z);
    tmpM.compose(tmpP, tmpQ, tmpS);
    mesh.setMatrixAt(i, tmpM);
    if (colors) mesh.setColorAt(i, colors[i]);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  return mesh;
}

// Rotation about Y that maps local +X to direction (dx, dz).
const yawX = (dx, dz) => Math.atan2(-dz, dx);

// ---------- trees ----------

const GREENS = ['#6fae4f', '#5f9e45', '#7cb85a', '#88bf5a', '#5a9a4a', '#9cc25a', '#6aa84f'];
const FALL = ['#d9a441', '#c8742e', '#e0b84a'];
const CONIFER = ['#3f7a45', '#4a8550', '#3b6f48'];

function treeGeometries() {
  const blob = (r, x, y, z, sy = 1) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.scale(1, sy, 1);
    g.deleteAttribute('uv');
    return at(g, x, y, z);
  };
  const cone = (r, h, y) => { const g = new THREE.ConeGeometry(r, h, 7); g.deleteAttribute('uv'); return at(g.toNonIndexed(), 0, y, 0); };
  return {
    round: merge([blob(2.2, 0, 4.2, 0, 0.85), blob(1.5, 1.3, 3.7, 0.5), blob(1.4, -1.1, 3.9, -0.6), blob(1.3, 0.2, 5.3, 0.3)]),
    tall: merge([blob(1.6, 0, 5.0, 0, 1.7), blob(1.2, 0.5, 6.8, 0.2, 1.3)]),
    conifer: merge([cone(2.0, 3.4, 3.0), cone(1.5, 2.8, 4.6), cone(0.9, 2.2, 6.0)]),
    trunk: at(new THREE.CylinderGeometry(0.13, 0.2, 3.4, 6), 0, 1.7, 0),
  };
}

export async function buildTrees(world, chunk, spots, group, budget) {
  const A = assets();
  const rect = chunk.rect;
  const accepted = [];
  const hash = new SpatialHash(8);
  const free = (x, z, d) => !hash.near(x, z, d).some((t) => Math.hypot(t.x - x, t.z - z) < d);
  const add = (t) => { accepted.push(t); hash.insert(t, t.x, t.z, t.x, t.z); };
  const R = rng((Math.round(rect.minX) * 31 + Math.round(rect.minZ)) >>> 0);

  for (const [x, z, leaf, h] of chunk.trees) {
    if (!free(x, z, 1.5)) continue;
    add({ x, z, kind: leaf === 2 ? 'conifer' : R() < 0.3 ? 'tall' : 'round', s: h ? Math.min(1.8, Math.max(0.6, h / 8)) : 0.85 + R() * 0.4 });
  }
  for (const p of spots.trees) if (free(p.x, p.z, 4.5)) add({ ...p, kind: R() < 0.25 ? 'tall' : 'round', s: 0.85 + R() * 0.35 });
  for (const p of spots.wells) if (free(p.x, p.z, 4)) add({ ...p, kind: 'tall', s: 0.75 + R() * 0.25 });

  const sports = chunk.areas.filter((a) => a.k === 'pitch' || a.k === 'playground' || a.k === 'track');
  for (const a of chunk.areas) {
    if (a.k !== 'grass' && a.k !== 'wood') continue;
    if (a.k === 'grass' && a.le !== 'park' && a.le !== 'garden' && !a.n) continue;
    const n = Math.min(160, Math.floor(a.size / (a.k === 'wood' ? 60 : 230)));
    for (let k = 0, tries = 0; k < n && tries < n * 8; tries++) {
      if (budget) await budget.tick();
      const x = a.bbox.minX + R() * (a.bbox.maxX - a.bbox.minX);
      const z = a.bbox.minZ + R() * (a.bbox.maxZ - a.bbox.minZ);
      if (!inRect(x, z, rect, -1) || !pointInShape(x, z, a.o, a.i)) continue;
      if (world.buildingAt(x, z) || world.onRoad(x, z, 2) || world.groundAt(x, z) > 0) continue;
      if (sports.some((p) => pointInShape(x, z, p.o, p.i))) continue;
      if (world.nearPath(x, z, 2.2) || !free(x, z, 5.5)) continue;
      add({ x, z, kind: R() < 0.15 ? 'conifer' : R() < 0.3 ? 'tall' : 'round', s: 0.9 + R() * 0.6 });
      k++;
    }
  }
  if (!accepted.length) return accepted;

  for (const t of accepted) {
    t.rot = R() * Math.PI * 2;
    chunk.addCircleCollider(t.x, t.z, 0.22 * t.s);
  }
  group.add(instanced(A.geo.trunk, A.trunk, accepted));
  for (const kind of ['round', 'tall', 'conifer']) {
    const items = accepted.filter((t) => t.kind === kind);
    if (!items.length) continue;
    const colors = items.map(() => new THREE.Color(kind === 'conifer' ? pick(CONIFER, R()) : R() < 0.12 ? pick(FALL, R()) : pick(GREENS, R())));
    group.add(instanced(A.geo[kind], A.leaf, items, { colors }));
  }
  return accepted;
}

// ---------- street furniture ----------

const METAL = '#9aa0a6';
const LAMP_GREEN = '#2e3a33';

function lampGeometry() {
  return merge([
    cyl(0.15, 0.17, 0.4, 8, LAMP_GREEN, 0, 0.2, 0),
    cyl(0.06, 0.08, 3.8, 6, LAMP_GREEN, 0, 2.2, 0),
    cyl(0.1, 0.06, 0.25, 8, LAMP_GREEN, 0, 4.15, 0),
    at(paint(new THREE.ConeGeometry(0.24, 0.22, 8), LAMP_GREEN), 0, 4.85, 0),
  ]);
}
function lampHeadGeometry() {
  return new THREE.SphereGeometry(0.2, 8, 6).scale(1, 1.25, 1).translate(0, 4.55, 0);
}
function benchGeometry() {
  const wood = '#a8733f', iron = '#3b3f44';
  return merge([
    box(1.7, 0.06, 0.42, wood, 0, 0.45, 0.02), box(1.7, 0.36, 0.05, wood, 0, 0.72, -0.2),
    box(0.06, 0.45, 0.42, iron, -0.75, 0.22, 0), box(0.06, 0.45, 0.42, iron, 0.75, 0.22, 0),
    box(0.06, 0.4, 0.05, iron, -0.75, 0.68, -0.22), box(0.06, 0.4, 0.05, iron, 0.75, 0.68, -0.22),
  ]);
}
function bikeRackGeometry() {
  const parts = [];
  for (const x of [-0.9, 0, 0.9]) {
    parts.push(box(0.05, 0.8, 0.05, METAL, x - 0.3, 0.4, 0), box(0.05, 0.8, 0.05, METAL, x + 0.3, 0.4, 0), box(0.65, 0.05, 0.05, METAL, x, 0.82, 0));
  }
  return merge(parts);
}
function hydrantGeometry() {
  const y = '#e0b52f';
  return merge([cyl(0.16, 0.18, 0.12, 8, y, 0, 0.06, 0), cyl(0.12, 0.13, 0.55, 8, y, 0, 0.4, 0),
    cyl(0.09, 0.12, 0.12, 8, y, 0, 0.73, 0), at(paint(new THREE.SphereGeometry(0.08, 8, 4), y), 0, 0.82, 0),
    box(0.36, 0.08, 0.08, y, 0, 0.5, 0)]);
}
function binGeometry() {
  return merge([cyl(0.26, 0.24, 0.9, 10, '#2f5a46', 0, 0.45, 0), cyl(0.28, 0.28, 0.06, 10, '#26493a', 0, 0.93, 0)]);
}

export function buildFurniture(world, chunk, spots, group) {
  const A = assets();
  const R = rng((Math.round(chunk.rect.minX) * 17 + Math.round(chunk.rect.minZ)) >>> 0);
  const mapped = chunk.props.filter((p) => p.k === 'lamp');
  const lamps = (mapped.length >= 6 ? mapped : spots.lamps).map((p) => ({ x: p.x, z: p.z, y: world.groundAt(p.x, p.z) }));
  for (const l of lamps) chunk.addCircleCollider(l.x, l.z, 0.15);
  if (lamps.length) {
    group.add(instanced(A.geo.lamp, A.vc, lamps));
    group.add(instanced(A.geo.lampHead, A.lampHead, lamps, { cast: false }));
  }

  const kinds = { bench: [], bikerack: [], hydrant: [], bin: [] };
  for (const p of chunk.props) {
    if (!kinds[p.k] || world.buildingAt(p.x, p.z)) continue;
    const rd = world.nearestRoad(p.x, p.z, 40, () => true);
    let rot = R() * Math.PI * 2;
    if (rd) {
      const a = rd.road.p[rd.seg], b = rd.road.p[rd.seg + 1];
      rot = yawX(b[0] - a[0], b[1] - a[1]);
      if (p.k === 'bench') rot = Math.atan2(rd.x - p.x, rd.z - p.z); // face the road
    }
    if (p.dir !== undefined && p.k === 'bench') rot = Math.PI - (p.dir * Math.PI) / 180;
    kinds[p.k].push({ x: p.x, z: p.z, rot, y: world.groundAt(p.x, p.z) });
  }
  for (const [k, items] of Object.entries(kinds)) {
    if (!items.length) continue;
    group.add(instanced(A.geo[k], A.vc, items));
    if (k !== 'bikerack') for (const it of items) chunk.addCircleCollider(it.x, it.z, k === 'bench' ? 0.5 : 0.25);
  }
}

// ---------- parked cars ----------

const CAR_COLORS = ['#f4f4f2', '#c9ccd1', '#2b2e33', '#b8322a', '#2f5d8c', '#6d7378', '#3f6b52', '#d9cfb8', '#8a1f2b', '#e0e3e6'];

function carBodyGeometry() {
  return merge([
    box(4.3, 0.62, 1.8, '#ffffff', 0, 0.62, 0), box(2.3, 0.08, 1.56, '#ffffff', -0.25, 1.6, 0),
    box(0.12, 0.5, 0.1, '#ffffff', 0.85, 1.32, 0.73), box(0.12, 0.5, 0.1, '#ffffff', 0.85, 1.32, -0.73),
    box(0.12, 0.5, 0.1, '#ffffff', -1.35, 1.32, 0.73), box(0.12, 0.5, 0.1, '#ffffff', -1.35, 1.32, -0.73),
  ]);
}
function carDetailGeometry() {
  const wheels = [];
  for (const x of [-1.4, 1.35]) for (const z of [-0.82, 0.82]) {
    const w = paint(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 10), '#1f2023');
    w.rotateX(Math.PI / 2);
    wheels.push(at(w, x, 0.34, z));
  }
  return merge([
    box(2.2, 0.48, 1.5, '#334452', -0.25, 1.33, 0),
    box(0.05, 0.14, 0.32, '#fff6d6', 2.16, 0.78, 0.6), box(0.05, 0.14, 0.32, '#fff6d6', 2.16, 0.78, -0.6),
    box(0.05, 0.14, 0.3, '#c0392b', -2.16, 0.8, 0.62), box(0.05, 0.14, 0.3, '#c0392b', -2.16, 0.8, -0.62),
    box(4.34, 0.16, 1.82, '#3a3d42', 0, 0.38, 0),
    ...wheels,
  ]);
}

export function buildParkedCars(world, chunk, spots, group) {
  const A = assets();
  const items = [];
  for (const c of spots.cars) {
    if (world.blocked(c.x, c.z, 1.0)) continue;
    items.push({ x: c.x, z: c.z, rot: yawX(c.ux, c.uz), seed: c.seed });
    chunk.addBoxCollider(c.x, c.z, c.ux, c.uz, 2.2, 0.95);
  }
  if (!items.length) return items;
  const colors = items.map((it) => new THREE.Color(pick(CAR_COLORS, it.seed)));
  group.add(instanced(A.geo.carBody, A.vc, items, { colors }));
  group.add(instanced(A.geo.carDetail, A.vc, items));
  return items;
}
