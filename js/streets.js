import * as THREE from 'three';
import { GeoBuilder, col, resample, offsetPolyline, rng, SpatialHash, closestOnSeg } from './util.js';
import { SIDEWALK_Y, MAJOR_ROADS, CAR_ONLY } from './world.js';

const C = {
  ground: '#a7c98a', grass: '#97cc79', wood: '#84b56a', pitch: '#8cc56c', track: '#c9805f',
  playground: '#e8d6a8', sand: '#ead9a6', farm: '#dccb8e', water: '#7cc4e4', parking: '#7d828a',
  plaza: '#ddd6c7', asphalt: '#5d6269', service: '#686d74', yellow: '#f2c94c', white: '#f4f4ef',
  walk: '#dcd8cf', walk2: '#d2cec4', curb: '#b8b3a9', footway: '#d8d3c8', cycleway: '#7b8088',
  path: '#cdbb93', grate: '#5b5650',
};
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

// Rectangle on the ground centered at (x,z), half-sizes along t (ht) and across (hn).
function groundRect(g, x, z, tx, tz, ht, hn, y, c) {
  const nx = -tz, nz = tx;
  g.quad(
    [x - tx * ht - nx * hn, y, z - tz * ht - nz * hn], [x + tx * ht - nx * hn, y, z + tz * ht - nz * hn],
    [x + tx * ht + nx * hn, y, z + tz * ht + nz * hn], [x - tx * ht + nx * hn, y, z - tz * ht + nz * hn], c, UP);
}

// Split resampled points into runs where keep(p) is true.
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

// Raised slab with curbs along a run of samples.
function slab(g, world, pts, hw, y) {
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
    world.addRaised(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], hw);
  }
  const n = pts.length - 1;
  const cap = (p, q, l, r) => g.quad([l[0], 0, l[1]], [r[0], 0, r[1]], [r[0], y, r[1]], [l[0], y, l[1]], curb, [p[0] - q[0], 0, p[1] - q[1]]);
  cap(pts[0], pts[1], L[0], R[0]);
  cap(pts[n], pts[n - 1], L[n], R[n]);
}

function markRoadCommercial(world) {
  for (const r of world.carRoads) {
    let shop = 0, total = 0;
    for (const s of resample(r.p, 15)) {
      for (const b of world.buildingHash.near(s.x, s.z, 28)) {
        if (Math.hypot(b.cx - s.x, b.cz - s.z) > 30) continue;
        total++;
        if (b.style === 'shopfront' || b.style === 'civic') shop++;
      }
    }
    r.commercial = total > 0 && shop / total > 0.45;
  }
}

function isIntersection(j) {
  let degree = 0;
  for (const a of j.carArms) degree += a.vi > 0 && a.vi < a.road.p.length - 1 ? 2 : 1;
  return degree >= 3;
}

// Point at distance d from vertex vi walking toward vertex vi+dir.
function walkBack(pts, vi, dir, d) {
  let i = vi;
  while (true) {
    const j = i + dir;
    if (j < 0 || j >= pts.length) return null;
    const seg = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
    if (seg >= d) {
      const f = d / seg;
      const x = pts[i][0] + (pts[j][0] - pts[i][0]) * f, z = pts[i][1] + (pts[j][1] - pts[i][1]) * f;
      return { x, z, tx: (pts[i][0] - pts[j][0]) / seg, tz: (pts[i][1] - pts[j][1]) / seg };
    }
    d -= seg; i = j;
  }
}

export function buildStreets(world, material) {
  const g = new GeoBuilder();
  const spots = { trees: [], wells: [], lamps: [], cars: [] };
  const ctx = world.meta.context;
  const intersections = world.junctions.filter(isIntersection);
  const ixHash = new SpatialHash(30);
  for (const j of intersections) ixHash.insert(j, j.x, j.z, j.x, j.z);
  const nearIx = (x, z, extra) => ixHash.near(x, z, 30).some((j) => Math.hypot(j.x - x, j.z - z) < j.radius + extra);

  markRoadCommercial(world);

  // Ground
  const m = 300;
  g.polygon([[ctx.minX - m, ctx.minZ - m], [ctx.maxX + m, ctx.minZ - m], [ctx.maxX + m, ctx.maxZ + m], [ctx.minX - m, ctx.maxZ + m]], [], 0, col(C.ground));

  // Areas
  for (const a of world.areas) {
    if (!(a.k in Y)) continue;
    g.polygon(a.o, a.i, Y[a.k], col(C[a.k]));
  }
  for (const l of world.lines) ribbon(g, l.p, l.k === 'river' ? 6 : l.k === 'canal' ? 3 : 1.5, Y.water, col(C.water));

  // Roads
  for (const r of world.roads) {
    if (r.kind === 'car' || r.kind === 'service') {
      const y = r.kind === 'car' ? Y.road : Y.service;
      const c = col(r.kind === 'car' ? C.asphalt : C.service);
      ribbon(g, r.p, r.hw, y, c);
      for (const p of [r.p[0], r.p[r.p.length - 1]]) disc(g, p[0], p[1], r.hw, y, c);
    } else if (r.kind === 'plaza') {
      const ring = r.p.slice(0, -1);
      if (ring.length >= 3) g.polygon(ring, [], Y.plaza, col(C.plaza));
    }
  }

  // Center lines on two-way major roads, trimmed at intersections.
  const yellow = col(C.yellow), white = col(C.white);
  for (const r of world.carRoads) {
    if (r.ow || !MAJOR_ROADS.has(r.t)) continue;
    const samples = resample(r.p, 1);
    for (const run of runs(samples, (s) => !nearIx(s.x, s.z, 2.5), 2)) {
      for (const off of [-0.13, 0.13]) {
        const pts = run.map((s) => [s.x, s.z]);
        ribbon(g, offsetPolyline(pts, off), 0.055, Y.mark, yellow);
      }
    }
  }

  // Stop bars on each approach to an intersection.
  for (const j of intersections) {
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

  // Crosswalks from mapped crossing ways: ladder stripes where the crossing is over asphalt.
  const crossingHash = new SpatialHash(10);
  for (const r of world.roads) {
    if (r.kind !== 'crossing') continue;
    for (const s of resample(r.p, 2)) crossingHash.insert(s, s.x, s.z, s.x, s.z);
    if (r.cm === 'no' || r.cr === 'unmarked' || r.cr === 'no') continue;
    for (const s of resample(r.p, 0.9)) {
      if (!world.onRoad(s.x, s.z, -0.2, null, CAR_ONLY)) continue;
      groundRect(g, s.x, s.z, s.tx, s.tz, 0.22, 1.5, Y.cross, white);
    }
  }
  const nearCrossing = (x, z, d) => crossingHash.near(x, z, d).some((s) => Math.hypot(s.x - x, s.z - z) < d);

  // Footpaths, bike paths, steps (not painted over streets).
  for (const r of world.roads) {
    if (r.kind !== 'path') continue;
    const c = col(r.t === 'cycleway' ? C.cycleway : r.t === 'path' || r.t === 'track' ? C.path : C.footway);
    for (const run of runs(resample(r.p, 0.8), (s) => !world.onRoad(s.x, s.z, 0.3, null, CAR_ONLY), 1)) {
      ribbon(g, run.map((s) => [s.x, s.z]), r.hw, Y.path, c);
    }
  }

  // Sidewalks: mapped ones first, then generated along streets where none is mapped.
  const mappedHash = new SpatialHash(12);
  for (const r of world.roads) {
    if (r.kind !== 'sidewalk') continue;
    for (let i = 0; i < r.p.length - 1; i++) {
      const a = r.p[i], b = r.p[i + 1];
      mappedHash.insert({ ax: a[0], az: a[1], bx: b[0], bz: b[1] }, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    }
    for (const run of runs(resample(r.p, 0.6), (s) => !world.onRoad(s.x, s.z, 0.1, null, CAR_ONLY), 1)) {
      slab(g, world, run.map((s) => [s.x, s.z]), r.hw, SIDEWALK_Y);
    }
  }
  const nearMapped = (x, z, d) => mappedHash.near(x, z, d).some((s) => closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz).d < d);

  const grate = col(C.grate);
  for (const r of world.carRoads) {
    const strip = r.commercial ? 0 : 1.3;
    const sw = r.commercial ? 3.4 : 1.7;
    const R = rng(r.id % 1000003);
    for (const side of [-1, 1]) {
      if (['no', 'none', 'separate'].includes(sidewalkSide(r, side))) continue;
      // Street trees in the curb strip, whether or not the sidewalk is generated or mapped.
      if (!r.commercial) {
        let next = R() * 6;
        for (const s of resample(offsetPolyline(r.p, side * (r.hw + 0.7)), 1)) {
          if (s.s < next) continue;
          next = s.s + 10 + R() * 4;
          spots.trees.push({ x: s.x, z: s.z });
        }
      }
      const line = offsetPolyline(r.p, side * (r.hw + strip + sw / 2));
      // A mapped sidewalk within a few meters means OSM already has the real one.
      const keep = (s) => world.inCore(s.x, s.z, -40) && !world.onRoad(s.x, s.z, 0.2, r, CAR_ONLY) && !nearMapped(s.x, s.z, 6.5);
      for (const run of runs(resample(line, 0.6), keep, 1.2)) {
        slab(g, world, run.map((s) => [s.x, s.z]), sw / 2, SIDEWALK_Y);

        // Street furniture spots along this run.
        let nextTree = R() * 6, nextLamp = 6 + (side > 0 ? 0 : 15) + R() * 4;
        for (const s of run) {
          const nx = -s.tz * side, nz = s.tx * side; // points away from the road
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

    // Parked cars in the curb lane.
    if (!['residential', 'tertiary', 'unclassified', 'living_street'].includes(r.t) || r.hw < 4.5) continue;
    for (const side of [-1, 1]) {
      for (const s of resample(r.p, 6.3)) {
        if (R() > 0.42) continue;
        const nx = -s.tz * side, nz = s.tx * side;
        const x = s.x + nx * (r.hw - 1.25), z = s.z + nz * (r.hw - 1.25);
        if (!world.inCore(x, z, 4) || nearIx(x, z, 8) || nearCrossing(x, z, 4.5)) continue;
        if (world.onRoad(x, z, 2.0, null, SERVICE_ONLY)) continue;
        const forward = r.ow || side > 0 ? 1 : -1;
        spots.cars.push({ x, z, ux: s.tx * forward, uz: s.tz * forward, seed: R() });
      }
    }
  }

  // Validate furniture spots against buildings, roads and intersections.
  const clear = (p, rad) => world.inCore(p.x, p.z, 2) && !world.onRoad(p.x, p.z, 0.5) && !nearIx(p.x, p.z, 3)
    && !world.buildingAt(p.x, p.z) && !world.buildingAt(p.x + rad, p.z) && !world.buildingAt(p.x - rad, p.z)
    && !world.buildingAt(p.x, p.z + rad) && !world.buildingAt(p.x, p.z - rad);
  const onWalkway = (p, d) => world.groundAt(p.x, p.z) > 0 || world.pathSegs.near(p.x, p.z, d + 3)
    .some((s) => closestOnSeg(p.x, p.z, s.ax, s.az, s.bx, s.bz).d < s.hw + d);
  spots.trees = spots.trees.filter((p) => clear(p, 1.2) && !nearCrossing(p.x, p.z, 2.5) && !onWalkway(p, 0.6));
  spots.wells = spots.wells.filter((p) => clear(p, 0.8) && !nearCrossing(p.x, p.z, 2.5));
  spots.lamps = spots.lamps.filter((p) => clear(p, 0.4) && !nearCrossing(p.x, p.z, 1.5));
  for (const p of spots.wells) groundRect(g, p.x, p.z, 1, 0, 0.6, 0.6, SIDEWALK_Y + 0.006, grate);

  return { mesh: g.mesh(material, { cast: false, receive: true }), spots };
}

export function buildContextRoads(roads, skipIds, material) {
  const g = new GeoBuilder();
  const c = col(C.asphalt), cs = col(C.service);
  for (const r of roads) {
    if (skipIds.has(r.id) || r.tu) continue;
    const service = r.t === 'service';
    const hw = (service ? 5 : r.t === 'residential' ? 10.5 : MAJOR_ROADS.has(r.t) ? 13 : 8) / 2;
    ribbon(g, r.p, hw, service ? Y.service : Y.road, service ? cs : c);
  }
  return g.mesh(material, { cast: false, receive: true });
}

export function groundMaterial() {
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}
