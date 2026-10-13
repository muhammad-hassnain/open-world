import * as THREE from 'three';
import { GeoBuilder, col, resample, offsetPolyline, rng } from './util.js';
import { inRect } from './clip.js';
import { SIDEWALK_Y, MAJOR_ROADS, CAR_ONLY } from './world.js';

const C = {
  ground: '#a7c98a', grass: '#97cc79', wood: '#84b56a', pitch: '#8cc56c', track: '#c9805f',
  playground: '#e8d6a8', sand: '#ead9a6', farm: '#dccb8e', water: '#7cc4e4', parking: '#7d828a',
  plaza: '#ddd6c7', asphalt: '#5d6269', service: '#686d74', yellow: '#f2c94c', white: '#f4f4ef',
  walk: '#dcd8cf', walk2: '#d2cec4', curb: '#b8b3a9', footway: '#d8d3c8', cycleway: '#7b8088',
  path: '#cdbb93', grate: '#5b5650',
};
export const GROUND_COLOR = C.ground;
const Y = {
  farm: 0.004, grass: 0.008, wood: 0.008, water: 0.01, pitch: 0.012, track: 0.012, playground: 0.012,
  sand: 0.012, parking: 0.016, plaza: 0.02, service: 0.024, road: 0.028, path: 0.032, mark: 0.037, cross: 0.039,
};
const UP = [0, 1, 0];
const SERVICE_ONLY = new Set(['service']);

function ribbon(g, pts, hw, y, c) {
  if (pts.length < 2) return;
  const L = offsetPolyline(pts, -hw), R = offsetPolyline(pts, hw);
  for (let i = 0; i < pts.length - 1; i++) {
    g.quad([L[i][0], y, L[i][1]], [R[i][0], y, R[i][1]], [R[i + 1][0], y, R[i + 1][1]], [L[i + 1][0], y, L[i + 1][1]], c, UP);
  }
}

function disc(g, x, z, r, y, c, seg = 14) {
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
    g.tri(x, y, z, x + Math.cos(a0) * r, y, z + Math.sin(a0) * r, x + Math.cos(a1) * r, y, z + Math.sin(a1) * r, c, 0, 1, 0);
  }
}

function groundRect(g, x, z, tx, tz, ht, hn, y, c) {
  const nx = -tz, nz = tx;
  g.quad(
    [x - tx * ht - nx * hn, y, z - tz * ht - nz * hn], [x + tx * ht - nx * hn, y, z + tz * ht - nz * hn],
    [x + tx * ht + nx * hn, y, z + tz * ht + nz * hn], [x - tx * ht + nx * hn, y, z - tz * ht + nz * hn], c, UP);
}

function runs(samples, keep, minLen = 1) {
  const out = [];
  let cur = [];
  for (const s of samples) {
    if (keep(s)) cur.push(s);
    else { if (cur.length > 1) out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out.filter((r) => r[r.length - 1].s - r[0].s >= minLen);
}

function sidewalkSide(r, side) {
  const specific = side > 0 ? r.swr : r.swl;
  if (specific) return specific;
  if (r.swb) return r.swb;
  if (r.sw === 'left') return side < 0 ? 'yes' : 'no';
  if (r.sw === 'right') return side > 0 ? 'yes' : 'no';
  return r.sw || 'yes';
}

function slab(g, chunk, pts, hw, y) {
  const L = offsetPolyline(pts, -hw), R = offsetPolyline(pts, hw);
  const top = [col(C.walk), col(C.walk2)], curb = col(C.curb);
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    const c = top[Math.floor(s / 1.5) % 2];
    s += seg;
    const l0 = L[i], l1 = L[i + 1], r0 = R[i], r1 = R[i + 1];
    g.quad([l0[0], y, l0[1]], [r0[0], y, r0[1]], [r1[0], y, r1[1]], [l1[0], y, l1[1]], c, UP);
    g.quad([l0[0], 0, l0[1]], [l1[0], 0, l1[1]], [l1[0], y, l1[1]], [l0[0], y, l0[1]], curb, [l0[0] - pts[i][0], 0, l0[1] - pts[i][1]]);
    g.quad([r0[0], 0, r0[1]], [r1[0], 0, r1[1]], [r1[0], y, r1[1]], [r0[0], y, r0[1]], curb, [r0[0] - pts[i][0], 0, r0[1] - pts[i][1]]);
    chunk.addRaised(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], hw);
  }
  const n = pts.length - 1;
  const cap = (p, q, l, r) => g.quad([l[0], 0, l[1]], [r[0], 0, r[1]], [r[0], y, r[1]], [l[0], y, l[1]], curb, [p[0] - q[0], 0, p[1] - q[1]]);
  cap(pts[0], pts[1], L[0], R[0]);
  cap(pts[n], pts[n - 1], L[n], R[n]);
}

function markRoadCommercial(world, roads) {
  for (const r of roads) {
    let shop = 0, total = 0;
    for (const s of resample(r.p, 15)) {
      for (const b of world.buildingsNear(s.x, s.z, 28)) {
        if (!b.style || Math.hypot(b.cx - s.x, b.cz - s.z) > 30) continue;
        total++;
        if (b.style === 'shopfront' || b.style === 'civic') shop++;
      }
    }
    r.commercial = total > 0 && shop / total > 0.45;
  }
}

function walkBack(pts, vi, dir, d) {
  let i = vi;
  for (;;) {
    const j = i + dir;
    if (j < 0 || j >= pts.length) return null;
    const seg = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
    if (seg >= d) {
      const f = d / seg;
      return {
        x: pts[i][0] + (pts[j][0] - pts[i][0]) * f, z: pts[i][1] + (pts[j][1] - pts[i][1]) * f,
        tx: (pts[i][0] - pts[j][0]) / seg, tz: (pts[i][1] - pts[j][1]) / seg,
      };
    }
    d -= seg; i = j;
  }
}

// Ground, areas, roads and (in full detail) markings, crosswalks, paths and sidewalks for one chunk.
export async function buildStreets(world, chunk, material, { lite = false, budget = null } = {}) {
  const g = new GeoBuilder();
  const spots = { trees: [], wells: [], lamps: [], cars: [] };
  const rect = chunk.rect;
  const tick = async () => { if (budget) await budget.tick(); };
  const nearIx = (x, z, extra) => world.near(x, z, 30).some((c) => c.junctionHash.near(x, z, 30)
    .some((j) => j.isIx && Math.hypot(j.x - x, j.z - z) < j.radius + extra));

  g.polygon([[rect.minX, rect.minZ], [rect.maxX, rect.minZ], [rect.maxX, rect.maxZ], [rect.minX, rect.maxZ]], [], 0, col(C.ground));
  for (const a of chunk.areas) {
    if (a.k in Y) g.polygon(a.o, a.i, Y[a.k], col(C[a.k]));
  }
  for (const l of chunk.lines) ribbon(g, l.p, l.k === 'river' ? 6 : l.k === 'canal' ? 3 : 1.5, Y.water, col(C.water));

  for (const r of chunk.roads) {
    await tick();
    if (r.kind === 'car' || r.kind === 'service') {
      const y = r.kind === 'car' ? Y.road : Y.service;
      const c = col(r.kind === 'car' ? C.asphalt : C.service);
      ribbon(g, r.p, r.hw, y, c);
      for (const p of [r.p[0], r.p[r.p.length - 1]]) disc(g, p[0], p[1], r.hw, y, c);
    } else if (r.kind === 'plaza') {
      const ring = r.p.slice(0, -1);
      if (ring.length >= 3) g.polygon(ring, [], Y.plaza, col(C.plaza));
    } else if (lite && r.kind === 'path' && r.t === 'cycleway') {
      ribbon(g, r.p, r.hw, Y.path, col(C.cycleway));
    }
  }
  if (lite) return { mesh: g.mesh(material, { cast: false, receive: true }), spots };

  markRoadCommercial(world, chunk.carRoads);

  // Center lines on two-way major roads, trimmed at intersections.
  const yellow = col(C.yellow), white = col(C.white);
  for (const r of chunk.carRoads) {
    if (r.ow || !MAJOR_ROADS.has(r.t)) continue;
    await tick();
    for (const run of runs(resample(r.p, 1), (s) => !nearIx(s.x, s.z, 2.5), 2)) {
      const pts = run.map((s) => [s.x, s.z]);
      for (const off of [-0.13, 0.13]) ribbon(g, offsetPolyline(pts, off), 0.055, Y.mark, yellow);
    }
  }

  // Stop lines on each approach to an intersection.
  for (const j of chunk.junctions) {
    if (!j.isIx) continue;
    for (const a of j.carArms) {
      const r = a.road;
      for (const dir of [-1, 1]) {
        if (r.ow && dir === 1) continue;
        const p = walkBack(r.p, a.vi, dir, j.radius + 4.2);
        if (!p) continue;
        const nx = -p.tz, nz = p.tx;
        const from = r.ow ? -r.hw + 0.4 : 0.2, to = r.hw - 0.4;
        const mid = (from + to) / 2, half = (to - from) / 2;
        groundRect(g, p.x + nx * mid, p.z + nz * mid, p.tx, p.tz, 0.22, half, Y.mark, white);
      }
    }
  }

  // Crosswalks: ladder stripes where a crossing path is over car asphalt.
  for (const r of chunk.roads) {
    if (r.kind !== 'crossing' || r.cm === 'no' || r.cr === 'unmarked' || r.cr === 'no') continue;
    await tick();
    for (const s of resample(r.p, 0.9)) {
      if (world.onRoad(s.x, s.z, -0.2, null, CAR_ONLY)) groundRect(g, s.x, s.z, s.tx, s.tz, 0.22, 1.5, Y.cross, white);
    }
  }
  const nearCrossing = (x, z, d) => world.near(x, z, d).some((c) => c.pathSegs.near(x, z, d)
    .some((s) => s.road.kind === 'crossing' && Math.hypot((s.ax + s.bx) / 2 - x, (s.az + s.bz) / 2 - z) < d + Math.hypot(s.bx - s.ax, s.bz - s.az) / 2));

  for (const r of chunk.roads) {
    if (r.kind !== 'path') continue;
    await tick();
    const c = col(r.t === 'cycleway' ? C.cycleway : r.t === 'path' || r.t === 'track' ? C.path : C.footway);
    for (const run of runs(resample(r.p, 0.8), (s) => !world.onRoad(s.x, s.z, 0.3, null, CAR_ONLY), 1)) {
      ribbon(g, run.map((s) => [s.x, s.z]), r.hw, Y.path, c);
    }
  }

  // Sidewalks: mapped ones, then generated along streets where none is mapped nearby.
  for (const r of chunk.roads) {
    if (r.kind !== 'sidewalk') continue;
    await tick();
    for (const run of runs(resample(r.p, 0.6), (s) => !world.onRoad(s.x, s.z, 0.1, null, CAR_ONLY), 1)) {
      slab(g, chunk, run.map((s) => [s.x, s.z]), r.hw, SIDEWALK_Y);
    }
  }

  const grate = col(C.grate);
  for (const r of chunk.carRoads) {
    await tick();
    const strip = r.commercial ? 0 : 1.3;
    const sw = r.commercial ? 3.4 : 1.7;
    const R = rng(r.id % 1000003);
    const motorway = r.t.startsWith('motorway') || r.t.startsWith('trunk');
    for (const side of [-1, 1]) {
      if (motorway || ['no', 'none', 'separate'].includes(sidewalkSide(r, side))) continue;
      if (!r.commercial) {
        let next = R() * 6;
        for (const s of resample(offsetPolyline(r.p, side * (r.hw + 0.7)), 1)) {
          if (s.s < next) continue;
          next = s.s + 10 + R() * 4;
          spots.trees.push({ x: s.x, z: s.z });
        }
      }
      const line = offsetPolyline(r.p, side * (r.hw + strip + sw / 2));
      const keep = (s) => inRect(s.x, s.z, rect) && !world.onRoad(s.x, s.z, 0.2, r, CAR_ONLY) && !world.nearSidewalk(s.x, s.z, 6.5);
      for (const run of runs(resample(line, 0.6), keep, 1.2)) {
        slab(g, chunk, run.map((s) => [s.x, s.z]), sw / 2, SIDEWALK_Y);
        let nextTree = R() * 6, nextLamp = 6 + (side > 0 ? 0 : 15) + R() * 4;
        for (const s of run) {
          const nx = -s.tz * side, nz = s.tx * side;
          if (r.commercial && s.s - run[0].s >= nextTree) {
            nextTree += 9;
            const d = -(sw / 2 - 0.9);
            spots.wells.push({ x: s.x + nx * d, z: s.z + nz * d });
          }
          if (s.s - run[0].s >= nextLamp) {
            nextLamp += r.commercial ? 22 : 30;
            const d = r.commercial ? -(sw / 2 - 0.4) : sw / 2 + 0.45;
            spots.lamps.push({ x: s.x + nx * d, z: s.z + nz * d });
          }
        }
      }
    }

    if (!['residential', 'tertiary', 'unclassified', 'living_street'].includes(r.t) || r.hw < 4.5) continue;
    for (const side of [-1, 1]) {
      for (const s of resample(r.p, 6.3)) {
        if (R() > 0.42) continue;
        const nx = -s.tz * side, nz = s.tx * side;
        const x = s.x + nx * (r.hw - 1.25), z = s.z + nz * (r.hw - 1.25);
        if (!inRect(x, z, rect, -4) || nearIx(x, z, 8) || nearCrossing(x, z, 4.5)) continue;
        if (world.onRoad(x, z, 2.0, null, SERVICE_ONLY)) continue;
        const forward = r.ow || side > 0 ? 1 : -1;
        spots.cars.push({ x, z, ux: s.tx * forward, uz: s.tz * forward, seed: R() });
      }
    }
  }

  const clear = (p, rad) => inRect(p.x, p.z, rect, -1) && !world.onRoad(p.x, p.z, 0.5) && !nearIx(p.x, p.z, 3)
    && !world.buildingAt(p.x, p.z) && !world.buildingAt(p.x + rad, p.z) && !world.buildingAt(p.x - rad, p.z)
    && !world.buildingAt(p.x, p.z + rad) && !world.buildingAt(p.x, p.z - rad);
  const onWalkway = (p, d) => world.groundAt(p.x, p.z) > 0 || world.nearPath(p.x, p.z, d);
  spots.trees = spots.trees.filter((p) => clear(p, 1.2) && !nearCrossing(p.x, p.z, 2.5) && !onWalkway(p, 0.6));
  spots.wells = spots.wells.filter((p) => clear(p, 0.8) && !nearCrossing(p.x, p.z, 2.5));
  spots.lamps = spots.lamps.filter((p) => clear(p, 0.4) && !nearCrossing(p.x, p.z, 1.5));
  for (const p of spots.wells) groundRect(g, p.x, p.z, 1, 0, 0.6, 0.6, SIDEWALK_Y + 0.006, grate);

  return { mesh: g.mesh(material, { cast: false, receive: true }), spots };
}

export function groundMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.userData.shared = true;
  return m;
}
