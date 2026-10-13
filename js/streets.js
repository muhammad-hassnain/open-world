import * as THREE from 'three';
import { MultiBuilder, col, resample, offsetPolyline, rng, pointInShape } from './util.js';
import { inRect } from './clip.js';
import { SIDEWALK_Y, MAJOR_ROADS, CAR_ONLY } from './world.js';
import { yellowCenterLines } from './limits.js';
import { deckY } from './bridges.js';

// Multipliers on the textures (values above 1 brighten).
const rgb = (r, g, b) => new THREE.Color(r, g, b);
const TINT = {
  ground: rgb(0.98, 1.38, 0.76), grass: rgb(0.95, 1.42, 0.74), wood: rgb(0.78, 1.0, 0.7), pitch: rgb(0.95, 1.45, 0.8),
  farm: rgb(1.45, 1.25, 0.8), sand: rgb(1.5, 1.35, 1.05), playground: rgb(1.45, 1.3, 1.0), track: rgb(1.5, 0.8, 0.6),
  parking: rgb(1, 1, 1), plaza: rgb(1, 1, 1), water: col('#4d8db0'),
  road: rgb(1, 1, 1), service: rgb(1.05, 1.05, 1.05), white: col('#f2f2ec'), yellow: col('#f2c94c'),
  sidewalk: rgb(1.18, 1.16, 1.12), curb: rgb(1.05, 1.04, 1.0), footway: rgb(1.0, 1.0, 1.0), cycleway: rgb(1, 1, 1),
  path: rgb(1.25, 1.15, 0.95), grate: col('#4e4a45'),
};
export const GROUND_COLOR = '#7f9a5a';
const AREA_MATERIAL = {
  grass: 'grass', wood: 'grass', pitch: 'grass', farm: 'grass', sand: 'pathGravel', playground: 'pathGravel', track: 'pathGravel',
  parking: 'lot', plaza: 'paving', water: 'water',
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

function groundRect(g, x, z, tx, tz, ht, hn, y, c) {
  const nx = -tz, nz = tx;
  g.quad(
    [x - tx * ht - nx * hn, y, z - tz * ht - nz * hn], [x + tx * ht - nx * hn, y, z + tz * ht - nz * hn],
    [x + tx * ht + nx * hn, y, z + tz * ht + nz * hn], [x - tx * ht + nx * hn, y, z - tz * ht + nz * hn], c, UP);
}

// Dashes along a polyline: on meters painted, off meters gap, counted from distance s0.
function dashes(pts, on, off, s0 = 0) {
  const out = [], period = on + off;
  let cur = null, s = s0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    for (let t = 0; t < len;) {
      const ph = (((s + t) % period) + period) % period, painted = ph < on;
      const step = Math.max(1e-3, Math.min(len - t, painted ? on - ph : period - ph));
      const u0 = t / len, u1 = Math.min(1, (t + step) / len);
      if (painted) {
        if (!cur) { cur = [[a[0] + (b[0] - a[0]) * u0, a[1] + (b[1] - a[1]) * u0]]; out.push(cur); }
        cur.push([a[0] + (b[0] - a[0]) * u1, a[1] + (b[1] - a[1]) * u1]);
      } else cur = null;
      t += step;
    }
    s += len;
  }
  return out.filter((d) => d.length > 1);
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

// Raised concrete sidewalk with curbs; textures follow the sidewalk's direction.
function slab(mb, chunk, pts, hw, y) {
  const g = mb.get('sidewalk');
  const L = offsetPolyline(pts, -hw), R = offsetPolyline(pts, hw);
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz) || 1;
    const l0 = L[i], l1 = L[i + 1], r0 = R[i], r1 = R[i + 1];
    g.uvAlong(dx / l, dz / l);
    g.quad([l0[0], y, l0[1]], [r0[0], y, r0[1]], [r1[0], y, r1[1]], [l1[0], y, l1[1]], TINT.sidewalk, UP);
    g.uvWall(dx / l, dz / l);
    g.quad([l0[0], 0, l0[1]], [l1[0], 0, l1[1]], [l1[0], y, l1[1]], [l0[0], y, l0[1]], TINT.curb, [l0[0] - pts[i][0], 0, l0[1] - pts[i][1]]);
    g.quad([r0[0], 0, r0[1]], [r1[0], 0, r1[1]], [r1[0], y, r1[1]], [r0[0], y, r0[1]], TINT.curb, [r0[0] - pts[i][0], 0, r0[1] - pts[i][1]]);
    chunk.addRaised(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], hw);
  }
  const n = pts.length - 1;
  const cap = (p, q, l, r) => {
    const dx = r[0] - l[0], dz = r[1] - l[1], len = Math.hypot(dx, dz) || 1;
    g.uvWall(dx / len, dz / len);
    g.quad([l[0], 0, l[1]], [r[0], 0, r[1]], [r[0], y, r[1]], [l[0], y, l[1]], TINT.curb, [p[0] - q[0], 0, p[1] - q[1]]);
  };
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

// Ground, areas, roads and (in full detail) markings, crosswalks, paths, sidewalks and parking stalls.
export async function buildStreets(world, chunk, materials, { lite = false, budget = null } = {}) {
  // Everything here lies on the ground, so it all follows the terrain. Flat chunks need little
  // subdivision; hilly ones are cut finer so roads and lawns bend with the slope.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const e = world.elevation(chunk.rect.minX + ((chunk.rect.maxX - chunk.rect.minX) * i) / 8, chunk.rect.minZ + ((chunk.rect.maxZ - chunk.rect.minZ) * j) / 8);
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
  }
  const range = hi - lo;
  const mb = new MultiBuilder(materials, {
    drape: (x, z) => world.elevation(x, z),
    maxEdge: (range < 0.6 ? 40 : range < 4 ? 12 : 5) * (lite ? 2 : 1),
    drapeByKey: world.terrain ? { water: (x, z) => world.terrain.water(x, z) } : {},
  });
  // Bridges and ramps: drawn by a second builder that lifts each vertex to the deck of the
  // road being drawn (deckRoad) instead of the terrain.
  let deckRoad = null;
  const deckMb = new MultiBuilder(materials, { drape: (x, z) => (deckRoad ? deckY(deckRoad, x, z) : 0), maxEdge: 6 });
  const on = (r) => { deckRoad = r; return deckMb; };
  const finish = (cast) => [...mb.meshes({ cast, receive: true }), ...deckMb.meshes({ cast: true, receive: true })];
  const spots = { trees: [], wells: [], lamps: [], cars: [] };
  const rect = chunk.rect;
  const tick = async () => { if (budget) await budget.tick(); };
  const nearIx = (x, z, extra) => world.near(x, z, 30).some((c) => c.junctionHash.near(x, z, 30)
    .some((j) => j.isIx && Math.hypot(j.x - x, j.z - z) < j.radius + extra));

  mb.get('ground').polygon([[rect.minX, rect.minZ], [rect.maxX, rect.minZ], [rect.maxX, rect.maxZ], [rect.minX, rect.maxZ]], [], 0, TINT.ground);
  for (const a of chunk.areas) {
    const key = AREA_MATERIAL[a.k];
    if (key) mb.get(key).polygon(a.o, a.i, Y[a.k], TINT[a.k] || TINT.grass);
  }
  for (const l of chunk.lines) ribbon(mb.get('water'), l.p, l.k === 'river' ? 6 : l.k === 'canal' ? 3 : 1.5, Y.water, TINT.water);

  for (const r of chunk.roads) {
    await tick();
    if (r.ez) deckStructure(on(r), r, world, lite);
    if (r.kind === 'car' || r.kind === 'service') {
      const y = r.kind === 'car' ? Y.road : Y.service;
      const g = (r.ez ? on(r) : mb).get(r.kind === 'car' ? 'road' : 'lot');
      const c = r.kind === 'car' ? TINT.road : TINT.service;
      ribbon(g, r.p, r.hw, y, c);
      for (const p of [r.p[0], r.p[r.p.length - 1]]) disc(g, p[0], p[1], r.hw, y, c);
    } else if (r.kind === 'plaza') {
      const ring = r.p.slice(0, -1);
      if (ring.length >= 3) mb.get('paving').polygon(ring, [], Y.plaza, TINT.plaza);
    } else if (r.ez) {
      ribbon(on(r).get('sidewalk').uvPlanar(), r.p, r.hw, Y.path, TINT.footway);  // foot and cycle bridges
    } else if (lite && r.kind === 'path' && r.t === 'cycleway') {
      ribbon(mb.get('road'), r.p, r.hw, Y.path, TINT.cycleway);
    }
  }
  if (lite) return { meshes: finish(false), spots };

  markRoadCommercial(world, chunk.carRoads);
  const paint = mb.get('paint');

  // Lane markings on major roads and ramps, in the local colors: center lines yellow or white,
  // white lane lines (dashed) and edge lines, yellow left edge on divided highways in the Americas.
  const yellow = yellowCenterLines(world.frame.lat, world.frame.lon);
  const center = yellow ? TINT.yellow : TINT.white;
  const DASH = yellow ? [3, 9] : [4.5, 7.5];
  for (const r of chunk.carRoads) {
    const link = r.t.endsWith('_link');
    if (!r.lanes || !(MAJOR_ROADS.has(r.t) || link)) continue;
    await tick();
    const L = r.lanes, fast = /^(motorway|trunk)/.test(r.t);
    const P = r.ez ? on(r).get('paint') : paint;
    for (const run of runs(resample(r.p, 1), (s) => !nearIx(s.x, s.z, 2.5), 2)) {
      const pts = run.map((s) => [s.x, s.z]), s0 = run[0].s;
      const line = (off, hw, c, dash) => {
        const p = offsetPolyline(pts, off);
        for (const d of dash ? dashes(p, dash[0], dash[1], s0) : [p]) ribbon(P, d, hw, Y.mark, c);
      };
      if (r.ow) {
        if (L.edge) {
          line(L.edge[0] + 0.08, 0.075, yellow && (fast || link) ? TINT.yellow : TINT.white);
          line(L.edge[1] - 0.08, 0.075, TINT.white);
        }
        for (let k = 1; k < L.fwd; k++) line(L.start + k * L.lw, 0.06, TINT.white, DASH);
        continue;
      }
      if (L.turn) {
        // Shared turn lane: solid outside, dashed inside, on both sides.
        for (const sgn of [-1, 1]) {
          line(sgn * (L.c0 - 0.12), 0.06, center, DASH);
          line(sgn * (L.c0 + 0.12), 0.06, center);
        }
      } else if (yellow || L.fwd > 1) {
        for (const off of [-0.13, 0.13]) line(off, 0.055, center);
      } else {
        line(0, 0.06, center, DASH);
      }
      for (let k = 1; k < L.fwd; k++) for (const sgn of [-1, 1]) line(sgn * (L.c0 + k * L.lw), 0.06, TINT.white, DASH);
      if (L.edge && (fast || r.t === 'primary' || r.t === 'secondary')) for (const off of L.edge) line(off - Math.sign(off) * 0.08, 0.075, TINT.white);
    }
  }

  for (const j of chunk.junctions) {
    if (!j.isIx || j.freeway) continue;
    for (const a of j.carArms) {
      const r = a.road;
      for (const dir of [-1, 1]) {
        if (r.ow && dir === 1) continue;
        const p = walkBack(r.p, a.vi, dir, j.radius + 4.2);
        if (!p) continue;
        const nx = -p.tz, nz = p.tx;
        const from = r.ow ? -r.hw + 0.4 : 0.2, to = r.hw - 0.4;
        const mid = (from + to) / 2, half = (to - from) / 2;
        groundRect(r.ez ? on(r).get('paint') : paint, p.x + nx * mid, p.z + nz * mid, p.tx, p.tz, 0.22, half, Y.mark, TINT.white);
      }
    }
  }

  for (const r of chunk.roads) {
    if (r.kind !== 'crossing' || r.ez || r.cm === 'no' || r.cr === 'unmarked' || r.cr === 'no') continue;
    await tick();
    for (const s of resample(r.p, 0.9)) {
      if (world.onRoad(s.x, s.z, -0.2, null, CAR_ONLY)) groundRect(paint, s.x, s.z, s.tx, s.tz, 0.22, 1.5, Y.cross, TINT.white);
    }
  }
  const nearCrossing = (x, z, d) => world.near(x, z, d).some((c) => c.pathSegs.near(x, z, d)
    .some((s) => s.road.kind === 'crossing' && Math.hypot((s.ax + s.bx) / 2 - x, (s.az + s.bz) / 2 - z) < d + Math.hypot(s.bx - s.ax, s.bz - s.az) / 2));

  for (const r of chunk.roads) {
    if (r.kind !== 'path' || r.ez) continue;
    await tick();
    const key = r.t === 'cycleway' ? 'road' : r.t === 'path' || r.t === 'track' ? 'pathGravel' : 'sidewalk';
    const c = r.t === 'cycleway' ? TINT.cycleway : key === 'pathGravel' ? TINT.path : TINT.footway;
    const g = mb.get(key);
    for (const run of runs(resample(r.p, 0.8), (s) => !world.onRoad(s.x, s.z, 0.3, null, CAR_ONLY), 1)) {
      const pts = run.map((s) => [s.x, s.z]);
      if (key === 'sidewalk') {
        const L = offsetPolyline(pts, -r.hw), R = offsetPolyline(pts, r.hw);
        for (let i = 0; i < pts.length - 1; i++) {
          const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz) || 1;
          g.uvAlong(dx / l, dz / l);
          g.quad([L[i][0], Y.path, L[i][1]], [R[i][0], Y.path, R[i][1]], [R[i + 1][0], Y.path, R[i + 1][1]], [L[i + 1][0], Y.path, L[i + 1][1]], c, UP);
        }
      } else {
        g.uvPlanar();
        ribbon(g, pts, r.hw, Y.path, c);
      }
    }
  }

  for (const r of chunk.roads) {
    if (r.kind !== 'sidewalk' || r.ez) continue;
    await tick();
    for (const run of runs(resample(r.p, 0.6), (s) => !world.onRoad(s.x, s.z, 0.1, null, CAR_ONLY), 1)) {
      slab(mb, chunk, run.map((s) => [s.x, s.z]), r.hw, SIDEWALK_Y);
    }
  }

  for (const r of chunk.carRoads) {
    if (r.ez) continue;  // no sidewalks, trees or parking on bridges and ramps
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
        slab(mb, chunk, run.map((s) => [s.x, s.z]), sw / 2, SIDEWALK_Y);
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
        if (R() > 0.18) continue;  // share of curb spots with a parked car
        const nx = -s.tz * side, nz = s.tx * side;
        const x = s.x + nx * (r.hw - 1.25), z = s.z + nz * (r.hw - 1.25);
        if (!inRect(x, z, rect, -4) || nearIx(x, z, 8) || nearCrossing(x, z, 4.5)) continue;
        if (world.onRoad(x, z, 2.0, null, SERVICE_ONLY)) continue;
        const forward = r.ow || side > 0 ? 1 : -1;
        spots.cars.push({ x, z, ux: s.tx * forward, uz: s.tz * forward, seed: R() });
      }
    }
  }

  parkingStalls(world, chunk, paint, spots);

  const clear = (p, rad) => inRect(p.x, p.z, rect, -1) && !world.onRoad(p.x, p.z, 0.5) && !nearIx(p.x, p.z, 3)
    && !world.buildingAt(p.x, p.z) && !world.buildingAt(p.x + rad, p.z) && !world.buildingAt(p.x - rad, p.z)
    && !world.buildingAt(p.x, p.z + rad) && !world.buildingAt(p.x, p.z - rad);
  const onWalkway = (p, d) => world.onSidewalk(p.x, p.z) || world.nearPath(p.x, p.z, d);
  const inLot = (p) => chunk.areas.some((a) => a.k === 'parking' && pointInShape(p.x, p.z, a.o, a.i));
  spots.trees = spots.trees.filter((p) => clear(p, 1.2) && !nearCrossing(p.x, p.z, 2.5) && !onWalkway(p, 0.6) && !inLot(p));
  spots.wells = spots.wells.filter((p) => clear(p, 0.8) && !nearCrossing(p.x, p.z, 2.5));
  spots.lamps = spots.lamps.filter((p) => clear(p, 0.4) && !nearCrossing(p.x, p.z, 1.5));
  for (const p of spots.wells) groundRect(mb.get('paint'), p.x, p.z, 1, 0, 0.6, 0.6, SIDEWALK_Y + 0.006, TINT.grate);

  return { meshes: finish(false), spots };
}

// Concrete under and beside an elevated road, in coordinates relative to its deck: bridges get
// a girder, railings and piers down to the ground; ramps get retaining walls down to the ground.
const CONCRETE = rgb(1.55, 1.53, 1.48);
function deckStructure(mb, r, world, lite) {
  const g = mb.get('concrete');
  const pts = resample(r.p, 4).map((s) => [s.x, s.z]);
  if (pts.length < 2) return;
  const W = r.hw + 0.35, RAIL = r.br ? 0.85 : 0.6, GIRDER = 1.1;
  const below = (x, z) => world.elevation(x, z) - deckY(r, x, z) - 0.4;  // ground, relative to the deck
  for (const side of [-1, 1]) {
    const outer = offsetPolyline(pts, side * W), inner = offsetPolyline(pts, side * r.hw);
    // Ramps stand on an earth embankment sloping down 1.6:1 beside the barrier.
    const foot = r.br ? null : outer.map((p, i) => {
      const h = Math.max(0, -below(p[0], p[1]));
      const tx = (pts[Math.min(i + 1, pts.length - 1)][0] - pts[Math.max(i - 1, 0)][0]), tz = (pts[Math.min(i + 1, pts.length - 1)][1] - pts[Math.max(i - 1, 0)][1]);
      const l = Math.hypot(tx, tz) || 1, nx = (-tz / l) * side, nz = (tx / l) * side;
      const fx = p[0] + nx * h * 1.6, fz = p[1] + nz * h * 1.6;
      return [fx, fz, below(fx, fz)];
    });
    for (let i = 0; i < pts.length - 1; i++) {
      const tx = pts[i + 1][0] - pts[i][0], tz = pts[i + 1][1] - pts[i][1], l = Math.hypot(tx, tz) || 1;
      const nx = (-tz / l) * side, nz = (tx / l) * side;  // outward
      const a = outer[i], b = outer[i + 1], c = inner[i], d = inner[i + 1];
      g.uvWall(tx / l, tz / l);
      if (r.br) g.quad([a[0], -GIRDER, a[1]], [b[0], -GIRDER, b[1]], [b[0], RAIL, b[1]], [a[0], RAIL, a[1]], CONCRETE, [nx, 0, nz]);
      else {
        g.quad([a[0], -0.05, a[1]], [b[0], -0.05, b[1]], [b[0], RAIL, b[1]], [a[0], RAIL, a[1]], CONCRETE, [nx, 0, nz]);
        const fa = foot[i], fb = foot[i + 1];
        mb.get('grass').uvPlanar().quad([a[0], -0.05, a[1]], [b[0], -0.05, b[1]], [fb[0], fb[2], fb[1]], [fa[0], fa[2], fa[1]], TINT.grass, [nx, 1, nz]);
      }
      if (lite) continue;
      g.quad([c[0], 0, c[1]], [d[0], 0, d[1]], [d[0], RAIL, d[1]], [c[0], RAIL, c[1]], CONCRETE, [-nx, 0, -nz]);
      g.uvPlanar();
      g.quad([c[0], RAIL, c[1]], [d[0], RAIL, d[1]], [b[0], RAIL, b[1]], [a[0], RAIL, a[1]], CONCRETE, UP);
    }
  }
  if (!r.br) return;
  // Underside of the girder.
  const L = offsetPolyline(pts, -W), R = offsetPolyline(pts, W);
  g.uvPlanar();
  for (let i = 0; i < pts.length - 1; i++) {
    g.quad([L[i][0], -GIRDER, L[i][1]], [R[i][0], -GIRDER, R[i][1]], [R[i + 1][0], -GIRDER, R[i + 1][1]], [L[i + 1][0], -GIRDER, L[i + 1][1]], CONCRETE, [0, -1, 0]);
  }
  if (lite) return;
  // Piers where the deck stands high enough above the ground, one or two across.
  const samples = resample(r.p, 26);
  const total = samples.length ? samples[samples.length - 1].s : 0;
  const offs = r.hw > 6 ? [-r.hw * 0.55, r.hw * 0.55] : [0];
  for (const s of samples) {
    if (s.s < 10 || s.s > total - 10) continue;
    for (const o of offs) {
      const x = s.x - s.tz * o, z = s.z + s.tx * o;
      const bottom = below(x, z) - 0.4;
      if (bottom > -GIRDER - 1.5) continue;
      pier(g, x, z, s.tx, s.tz, 0.6, 0.9, bottom, -GIRDER);
    }
  }
}

function pier(g, x, z, tx, tz, ht, hn, y0, y1) {
  const nx = -tz, nz = tx;
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [x + tx * ht * a + nx * hn * b, z + tz * ht * a + nz * hn * b]);
  for (let i = 0; i < 4; i++) {
    const p = c[i], q = c[(i + 1) % 4];
    const ex = q[0] - p[0], ez = q[1] - p[1], l = Math.hypot(ex, ez) || 1;
    g.uvWall(ex / l, ez / l);
    const ox = (p[0] + q[0]) / 2 - x, oz = (p[1] + q[1]) / 2 - z;  // outward
    g.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], CONCRETE, [ox, 0, oz]);
  }
}

// Painted stalls on both sides of parking aisles inside mapped parking lots, plus cars in some.
function parkingStalls(world, chunk, paint, spots) {
  const lots = chunk.areas.filter((a) => a.k === 'parking');
  if (!lots.length) return;
  const inLot = (x, z) => lots.some((l) => x >= l.bbox.minX && x <= l.bbox.maxX && z >= l.bbox.minZ && z <= l.bbox.maxZ && pointInShape(x, z, l.o, l.i));
  const R = rng((Math.round(chunk.rect.minX) * 7 + Math.round(chunk.rect.minZ)) >>> 0);
  const STALL = 2.7, DEPTH = 5.2;
  for (const r of chunk.roads) {
    if (r.kind !== 'service' || r.sv !== 'parking_aisle') continue;
    const samples = resample(r.p, STALL);
    const total = samples.length ? samples[samples.length - 1].s : 0;
    for (const s of samples) {
      if (s.s < 2 || s.s > total - 2) continue;
      for (const side of [-1, 1]) {
        const nx = -s.tz * side, nz = s.tx * side;
        const near = r.hw + 0.15, mid = r.hw + DEPTH / 2;
        const mx = s.x + nx * mid, mz = s.z + nz * mid;
        if (!inLot(mx, mz) || !inLot(s.x + nx * (r.hw + DEPTH), s.z + nz * (r.hw + DEPTH))) continue;
        if (world.buildingAt(mx, mz) || world.onRoad(mx, mz, -0.3, r)) continue;
        groundRect(paint, s.x + nx * (near + DEPTH / 2), s.z + nz * (near + DEPTH / 2), nx, nz, DEPTH / 2, 0.06, Y.mark, TINT.white);
        // A car in the stall after this line, nose in.
        const cx = mx + s.tx * STALL / 2, cz = mz + s.tz * STALL / 2;
        if (R() < 0.3 && inLot(cx, cz) && !world.buildingAt(cx, cz)) spots.cars.push({ x: cx, z: cz, ux: nx, uz: nz, seed: R() });
      }
    }
  }
}
