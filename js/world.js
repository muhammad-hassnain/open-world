import * as THREE from 'three';
import {
  SpatialHash, bboxOf, orient, pointInShape, closestOnSeg, centroid, signedArea,
} from './util.js';
import { CHUNK_ZOOM } from './geo.js';

export const CAR_ROADS = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);
export const MAJOR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const PATHS = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'track', 'bridleway', 'corridor']);
export const CAR_ONLY = new Set(['car']);
const ROAD_KINDS = new Set(['car', 'service']);

const ROAD_WIDTH = {
  motorway: 15, trunk: 14, primary: 14, secondary: 13, tertiary: 12, residential: 10.5,
  unclassified: 8, living_street: 7, motorway_link: 7, trunk_link: 7, primary_link: 7,
  secondary_link: 7, tertiary_link: 7,
};
const SERVICE_WIDTH = { alley: 4.5, driveway: 3.5, parking_aisle: 6, 'drive-through': 3.5 };
const PATH_WIDTH = { footway: 2, path: 1.6, cycleway: 3, pedestrian: 4, steps: 2, track: 3, bridleway: 2, corridor: 2 };

export const SIDEWALK_Y = 0.15;

export function classifyRoad(r) {
  if (r.tu) return 'skip';
  if (r.ar) return r.t === 'pedestrian' || r.t === 'footway' ? 'plaza' : 'skip';
  if (CAR_ROADS.has(r.t)) return 'car';
  if (r.t === 'service') return 'service';
  if ((r.t === 'footway' || r.t === 'cycleway' || r.t === 'path') && r.fw === 'crossing') return 'crossing';
  if (r.t === 'footway' && r.fw === 'sidewalk') return 'sidewalk';
  if (PATHS.has(r.t)) return 'path';
  return 'skip';
}

export function roadHalfWidth(r, kind) {
  if (r.w && r.w > 1 && r.w < 40) return r.w / 2;
  if (kind === 'car') {
    const base = ROAD_WIDTH[r.t] || 9;
    if (!r.ln || r.ln < 2) return base / 2;
    // Mapped lanes: 3.6 m freeway lanes plus shoulders, 3.3 m elsewhere.
    const fast = FAST.has(r.t);
    return Math.max(base, r.ln * (fast ? 3.6 : 3.3) + (fast && r.ow ? 4 : 1)) / 2;
  }
  if (kind === 'service') return (SERVICE_WIDTH[r.sv] || 5) / 2;
  if (kind === 'sidewalk') return 1;
  return (PATH_WIDTH[r.t] || 2) / 2;
}

// ---------- lanes ----------

const FAST = new Set(['motorway', 'trunk']);
// Roads that merge and split without stop lines or traffic lights.
const FREEWAY = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);
// Lanes in the direction of travel on a one-way carriageway, and in total on a two-way road,
// when OSM doesn't say (vector tiles never do).
const ONEWAY_LANES = { motorway: 3, trunk: 2, primary: 2, secondary: 2 };
const TWOWAY_LANES = { motorway: 4, trunk: 4, primary: 4 };

// Where the lanes are across a car road: offsets are meters from the center line of the way,
// positive to the right of travel (offsetPolyline's sign).
//   fwd / back  lanes with / against the way's direction (back = 0 on one-way roads)
//   lw          lane width
//   start       offset of the left edge of the leftmost forward lane
//   turn        a shared center turn lane (odd lane counts on two-way roads)
//   edge        offsets of the outer edge lines (null where the lanes reach the curb)
export function laneLayout(r, hw) {
  const W = hw * 2, fast = FAST.has(r.t);
  if (r.ow) {
    let n = r.ln || ONEWAY_LANES[r.t] || (W >= 9 ? 2 : 1);
    const shoulders = fast ? 3 : r.t.endsWith('_link') ? 1.6 : 0.6;
    n = Math.max(1, Math.min(n, Math.floor((W - shoulders) / 2.8)));
    const lw = Math.min(fast ? 3.7 : 3.5, (W - shoulders) / n);
    const spare = W - n * lw, left = fast ? Math.min(1.2, spare * 0.35) : spare / 2;
    const start = -hw + left;
    return { fwd: n, back: 0, lw, start, turn: false, edge: spare > 0.5 ? [start, start + n * lw] : null };
  }
  let total = r.ln || TWOWAY_LANES[r.t] || 2;
  let turn = total >= 3 && total % 2 === 1;
  let side = Math.floor(total / 2);
  side = Math.max(1, Math.min(side, Math.floor((hw - (turn ? 1.6 : 0) - 0.3) / 2.8)));
  if (turn && hw - side * 2.8 < 1.6 + 0.3) turn = false;
  const lw = Math.min(3.5, (hw - (turn ? 1.7 : 0) - 0.3) / side);
  const c0 = turn ? Math.min(lw, 3.4) / 2 : 0;
  const outer = c0 + side * lw;
  return { fwd: side, back: side, lw, start: c0, turn, c0, edge: hw - outer > 0.8 ? [-outer, outer] : null };
}

// Offset of the center of the outermost (slow) lane in the way's direction, or against it.
export function slowLane(road, dir = 1) {
  const L = road.lanes;
  if (!L) return road.ow ? 0 : road.hw * 0.28 * dir;
  if (road.ow) return L.start + (L.fwd - 0.5) * L.lw;
  return dir * (L.c0 + (L.fwd - 0.5) * L.lw);
}

const segBox = (a, b, pad) => [Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad];

// Everything known about one chunk: its data plus spatial indexes for queries.
export class ChunkIndex {
  constructor(key, rect, data) {
    this.key = key;
    this.rect = rect;
    this.source = data.source;

    this.roads = data.roads.map((r, idx) => {
      const kind = classifyRoad(r);
      const hw = roadHalfWidth(r, kind);
      return { ...r, idx, kind, hw, lanes: kind === 'car' ? laneLayout(r, hw) : null, bbox: bboxOf(r.p), chunk: key };
    });
    this.carRoads = this.roads.filter((r) => r.kind === 'car');
    this.roadHash = new SpatialHash(20);
    this.pathSegs = new SpatialHash(12);
    for (const r of this.roads) {
      const isRoad = r.kind === 'car' || r.kind === 'service';
      const isPath = r.kind === 'path' || r.kind === 'sidewalk' || r.kind === 'crossing';
      if (!isRoad && !isPath) continue;
      for (let i = 0; i < r.p.length - 1; i++) {
        const a = r.p[i], b = r.p[i + 1];
        const seg = { road: r, i, ax: a[0], az: a[1], bx: b[0], bz: b[1], hw: r.hw };
        (isRoad ? this.roadHash : this.pathSegs).insert(seg, ...segBox(a, b, r.hw));
      }
    }

    this.sidewalkSegs = new SpatialHash(12);
    for (const r of this.roads) {
      if (r.kind !== 'sidewalk') continue;
      for (let i = 0; i < r.p.length - 1; i++) {
        const a = r.p[i], b = r.p[i + 1];
        this.sidewalkSegs.insert({ ax: a[0], az: a[1], bx: b[0], bz: b[1] }, ...segBox(a, b, 0));
      }
    }

    this.junctions = computeJunctions(this.roads).map((j) => {
      const arms = j.r.map(([ri, vi]) => ({ road: this.roads[ri], vi }));
      const carArms = arms.filter((a) => a.road.kind === 'car');
      let degree = 0;
      for (const a of carArms) degree += a.vi > 0 && a.vi < a.road.p.length - 1 ? 2 : 1;
      return { x: j.x, z: j.z, arms, carArms, isIx: degree >= 3, freeway: carArms.length > 0 && carArms.every((a) => FREEWAY.has(a.road.t)), radius: Math.max(0, ...carArms.map((a) => a.road.hw)) };
    });
    this.junctionHash = new SpatialHash(30);
    for (const j of this.junctions) this.junctionHash.insert(j, j.x, j.z, j.x, j.z);

    this.zones = (data.zones || []).map((a) => ({ ...a, bbox: bboxOf(a.o) }));
    this.buildings = data.buildings.map((b) => this._building(b));
    this.buildingHash = new SpatialHash(16);
    this.colliders = new SpatialHash(16);
    for (const b of this.buildings) {
      this.buildingHash.insert(b, b.bbox.minX, b.bbox.minZ, b.bbox.maxX, b.bbox.maxZ);
      if (b.solid) this.colliders.insert({ outer: b.outer, holes: b.holes, bbox: b.bbox }, b.bbox.minX, b.bbox.minZ, b.bbox.maxX, b.bbox.maxZ);
    }

    this.areas = data.areas.map((a) => {
      orient(a.o, true);
      (a.i || []).forEach((h) => orient(h, false));
      return { ...a, bbox: bboxOf(a.o), size: Math.abs(signedArea(a.o)) };
    });
    this.lines = data.lines || [];
    this.pois = data.pois;
    this.places = data.places || [];
    this.trees = data.trees || [];
    this.props = data.props || [];
    this.signals = computeSignals(this.junctions, this.props, key);
    this.resetDynamic();
  }

  // Colliders and raised surfaces created when the chunk is built in full detail.
  resetDynamic() {
    this.dynColliders = new SpatialHash(16);
    this.circles = new SpatialHash(8);
    this.raised = new SpatialHash(12);
    this.parked = [];  // parked cars (props.js), which players can get into
    this.lamps = [];   // street lamps (props.js), lit at night
  }

  _building(b) {
    const outer = orient(b.o, true);
    const holes = (b.i || []).map((h) => orient(h, false));
    const bbox = bboxOf(outer);
    const c = centroid(outer);
    let zone = null;
    for (const z of this.zones) {
      if (c[0] < z.bbox.minX || c[0] > z.bbox.maxX || c[1] < z.bbox.minZ || c[1] > z.bbox.maxZ) continue;
      if (pointInShape(c[0], c[1], z.o, z.i)) { zone = z.k; break; }
    }
    return {
      id: b.id, type: b.t, name: b.n, amenity: b.a, tagH: b.h, tagLevels: b.l, minH: b.mh || 0,
      colour: b.c, clipped: !!b.clipped, zone,
      roofColor: b.rc ? new THREE.Color().setRGB(b.rc[0] / 255, b.rc[1] / 255, b.rc[2] / 255, THREE.SRGBColorSpace) : null,
      outer, holes, bbox, area: Math.abs(signedArea(outer)), cx: c[0], cz: c[1],
      solid: b.t !== 'roof' && b.t !== 'carport' && !(b.mh > 2.5),
      height: 6, pois: [],
    };
  }

  addBoxCollider(cx, cz, ux, uz, hu, hv) {
    const vx = -uz, vz = ux;
    const outer = orient([
      [cx - ux * hu - vx * hv, cz - uz * hu - vz * hv], [cx + ux * hu - vx * hv, cz + uz * hu - vz * hv],
      [cx + ux * hu + vx * hv, cz + uz * hu + vz * hv], [cx - ux * hu + vx * hv, cz - uz * hu + vz * hv],
    ], true);
    const bbox = bboxOf(outer);
    const collider = { outer, holes: [], bbox, off: false };
    this.dynColliders.insert(collider, bbox.minX, bbox.minZ, bbox.maxX, bbox.maxZ);
    return collider;  // set .off to remove it (a parked car someone drove away)
  }

  addCircleCollider(x, z, r) {
    this.circles.insert({ x, z, r }, x - r, z - r, x + r, z + r);
  }

  addRaised(ax, az, bx, bz, hw) {
    this.raised.insert({ ax, az, bx, bz, hw }, ...segBox([ax, az], [bx, bz], hw));
  }
}

function computeJunctions(roads) {
  const map = new Map();
  roads.forEach((r, ri) => {
    if (r.kind !== 'car' && r.kind !== 'service') return;
    r.p.forEach((p, vi) => {
      const k = `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
      let arr = map.get(k);
      if (!arr) map.set(k, arr = []);
      arr.push([ri, vi]);
    });
  });
  const out = [];
  for (const uses of map.values()) {
    if (new Set(uses.map((u) => u[0])).size < 2) continue;
    const [ri, vi] = uses[0];
    out.push({ x: roads[ri].p[vi][0], z: roads[ri].p[vi][1], r: uses });
  }
  return out;
}

// Traffic lights: at junctions with a mapped signal (detail data), else where main roads cross.
// Each light controller alternates two axes: roads within ~45° of `ref` and the rest.
const ROAD_RANK = { motorway: 4, trunk: 4, primary: 4, secondary: 3, tertiary: 2 };
const SIGNAL_CYCLE = 36;  // seconds: axis 0 green 14, yellow 3, all red 1; then axis 1 the same
function computeSignals(junctions, props, chunk) {
  const mapped = props.filter((p) => p.k === 'signal');
  const out = [];
  for (const j of junctions) {
    if (!j.isIx || j.carArms.length < 2 || j.freeway) continue;
    const ranks = j.carArms.map((a) => ROAD_RANK[a.road.t] || 0);
    const lit = mapped.length
      ? mapped.some((p) => Math.hypot(p.x - j.x, p.z - j.z) < 18)
      : ranks.filter((r) => r >= 2).length >= 2 && Math.max(...ranks) >= 3;
    if (!lit) continue;
    const arms = [];
    for (const { road, vi } of j.carArms) {
      for (const n of [vi + 1, vi - 1]) {
        if (n < 0 || n >= road.p.length) continue;
        const dx = road.p[n][0] - j.x, dz = road.p[n][1] - j.z, l = Math.hypot(dx, dz) || 1;
        arms.push({ ux: dx / l, uz: dz / l, hw: road.hw });
      }
    }
    if (arms.length < 3) continue;
    const ref = arms[0];
    for (const a of arms) a.axis = Math.abs(a.ux * ref.ux + a.uz * ref.uz) > 0.7 ? 0 : 1;
    if (!arms.some((a) => a.axis === 1)) continue;
    const offset = Math.abs(Math.round(j.x * 7.1 + j.z * 3.7)) % SIGNAL_CYCLE;
    out.push({ x: j.x, z: j.z, ref, arms, radius: j.radius, offset, chunk });
  }
  return out;
}

// Light for one axis of a controller at time t (seconds): 'green' | 'yellow' | 'red'.
export function signalState(sig, axis, t) {
  const half = SIGNAL_CYCLE / 2, local = (((t + sig.offset) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  const own = axis === 0 ? local : (local + half) % SIGNAL_CYCLE;
  return own < 14 ? 'green' : own < 17 ? 'yellow' : 'red';
}

// Junction / signal lookups by position (rounded to half a meter / a meter).
export const nodeKey = (x, z) => `${Math.round(x * 2)}:${Math.round(z * 2)}`;
const signalKey = (x, z) => `${Math.round(x)}:${Math.round(z)}`;

// The streamed world: a set of chunk indexes, queried by position.
export class World {
  constructor(frame, terrain = null) {
    this.frame = frame;
    this.terrain = terrain;
    this.chunks = new Map();
    this.placeName = null;
    this.obstacles = new Set();  // things that move between chunks, e.g. parked vehicles: { circles() }
    this.nodes = new Map();      // nodeKey -> [{ road, k }]: car-road vertices, to follow roads across chunks
    this.signals = new Map();    // traffic light controllers by position
  }

  signalAt(x, z) { return this.signals.get(signalKey(x, z)) || null; }

  // Terrain height relative to the walk-in point (0 when flat or unknown).
  elevation(x, z) { return this.terrain ? this.terrain.at(x, z) : 0; }

  add(ci) {
    this.chunks.set(ci.key, ci);
    for (const r of ci.carRoads) {
      r.p.forEach((p, k) => {
        const id = nodeKey(p[0], p[1]);
        let list = this.nodes.get(id);
        if (!list) this.nodes.set(id, list = []);
        list.push({ road: r, k });
      });
    }
    for (const s of ci.signals) this.signals.set(signalKey(s.x, s.z), s);
  }

  remove(key) {
    const ci = this.chunks.get(key);
    this.chunks.delete(key);
    if (!ci) return;
    for (const r of ci.carRoads) {
      r.dead = true;
      for (const p of r.p) {
        const id = nodeKey(p[0], p[1]), list = this.nodes.get(id);
        if (!list) continue;
        const rest = list.filter((e) => e.road !== r);
        if (rest.length) this.nodes.set(id, rest); else this.nodes.delete(id);
      }
    }
    for (const s of ci.signals) {
      const k = signalKey(s.x, s.z);
      if (this.signals.get(k) === s) this.signals.delete(k);
    }
  }

  // Chunk indexes overlapping the box around (x, z) with radius r.
  near(x, z, r = 0) {
    const a = this.frame.tileAt(x - r, z - r, CHUNK_ZOOM), b = this.frame.tileAt(x + r, z + r, CHUNK_ZOOM);
    const out = [];
    for (let tx = a.x; tx <= b.x; tx++) for (let ty = a.y; ty <= b.y; ty++) {
      const c = this.chunks.get(`${CHUNK_ZOOM}/${tx}/${ty}`);
      if (c) out.push(c);
    }
    return out;
  }

  buildingAt(x, z) {
    for (const c of this.near(x, z)) {
      for (const b of c.buildingHash.near(x, z, 0)) {
        if (x < b.bbox.minX || x > b.bbox.maxX || z < b.bbox.minZ || z > b.bbox.maxZ) continue;
        if (pointInShape(x, z, b.outer, b.holes)) return b;
      }
    }
    return null;
  }

  buildingsNear(x, z, r) {
    return this.near(x, z, r).flatMap((c) => c.buildingHash.near(x, z, r));
  }

  heightAt(x, z) {
    const b = this.buildingAt(x, z);
    return b && b.solid ? b.top || b.height : 0;
  }

  // Height of the walkable surface: terrain, plus the curb height on sidewalks.
  groundAt(x, z) {
    const e = this.elevation(x, z);
    for (const c of this.near(x, z)) {
      for (const s of c.raised.near(x, z, 0)) {
        if (closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz).d <= s.hw) return e + SIDEWALK_Y;
      }
    }
    return e;
  }

  // True on a raised sidewalk.
  onSidewalk(x, z) {
    for (const c of this.near(x, z)) {
      for (const s of c.raised.near(x, z, 0)) {
        if (closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz).d <= s.hw) return true;
      }
    }
    return false;
  }

  nearestRoad(x, z, maxD = 40, filter = (r) => r.kind === 'car') {
    let best = null;
    for (const c of this.near(x, z, maxD)) {
      for (const s of c.roadHash.near(x, z, maxD)) {
        if (!filter(s.road)) continue;
        const q = closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz);
        if (q.d <= maxD && (!best || q.d < best.d)) best = { road: s.road, x: q.x, z: q.z, d: q.d, seg: s.i };
      }
    }
    return best;
  }

  onRoad(x, z, pad = 0, except = null, kinds = ROAD_KINDS) {
    for (const c of this.near(x, z, 20)) {
      for (const s of c.roadHash.near(x, z, Math.max(0, pad))) {
        const r = s.road;
        if (r === except || !kinds.has(r.kind)) continue;
        if (closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz).d < r.hw + pad) return true;
      }
    }
    return false;
  }

  nearPath(x, z, d) {
    for (const c of this.near(x, z, d + 3)) {
      for (const s of c.pathSegs.near(x, z, d + 3)) {
        if (closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz).d < s.hw + d) return true;
      }
    }
    return false;
  }

  nearSidewalk(x, z, d) {
    for (const c of this.near(x, z, d)) {
      for (const s of c.sidewalkSegs.near(x, z, d)) {
        if (closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz).d < d) return true;
      }
    }
    return false;
  }

  nearestJunction(x, z, maxD) {
    let best = null, bd = maxD;
    for (const c of this.near(x, z, maxD)) {
      for (const j of c.junctionHash.near(x, z, maxD)) {
        const d = Math.hypot(j.x - x, j.z - z);
        if (d < bd) { bd = d; best = j; }
      }
    }
    return best;
  }

  // Push a circle of radius r out of building/car polygons, round colliders and obstacles
  // (except `ignore`, e.g. the vehicle being driven). `rough`: only buildings and vehicles with a
  // driver count (police push through traffic, parked cars, trees and posts).
  resolveCircle(x, z, r, ignore = null, rough = false) {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const ob of this.obstacles) {
        if (ob === ignore || (rough && !ob.driver)) continue;
        for (const c of ob.circles()) {
          const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz), m = r + c.r;
          if (d < m) { const l = d || 1e-6; x = c.x + (dx / l) * m; z = c.z + (dz / l) * m; moved = true; }
        }
      }
      for (const ch of this.near(x, z, r + 0.5)) {
        for (const hash of rough ? [ch.colliders] : [ch.colliders, ch.dynColliders]) {
          for (const c of hash.near(x, z, r + 0.5)) {
            if (c.off) continue;
            const bb = c.bbox;
            if (x < bb.minX - r || x > bb.maxX + r || z < bb.minZ - r || z > bb.maxZ + r) continue;
            const inside = pointInShape(x, z, c.outer, c.holes);
            let best = null;
            for (const ring of [c.outer, ...c.holes]) {
              for (let i = 0; i < ring.length; i++) {
                const a = ring[i], b = ring[(i + 1) % ring.length];
                const q = closestOnSeg(x, z, a[0], a[1], b[0], b[1]);
                if (!best || q.d < best.d) best = q;
              }
            }
            if (!best) continue;
            if (inside) {
              const dx = best.x - x, dz = best.z - z, l = Math.hypot(dx, dz) || 1e-6;
              x = best.x + (dx / l) * r; z = best.z + (dz / l) * r; moved = true;
            } else if (best.d < r) {
              const dx = x - best.x, dz = z - best.z, l = best.d || 1e-6;
              x = best.x + (dx / l) * r; z = best.z + (dz / l) * r; moved = true;
            }
          }
        }
        if (!rough) for (const c of ch.circles.near(x, z, r + 0.5)) {
          const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz), m = r + c.r;
          if (d < m) {
            const l = d || 1e-6;
            x = c.x + (dx / l) * m; z = c.z + (dz / l) * m; moved = true;
          }
        }
      }
      if (!moved) break;
    }
    return [x, z];
  }

  // The mapped area (park, wood, parking lot…) containing (x, z), or null.
  areaAt(x, z) {
    for (const c of this.near(x, z)) {
      for (const a of c.areas) {
        if (x < a.bbox.minX || x > a.bbox.maxX || z < a.bbox.minZ || z > a.bbox.maxZ) continue;
        if (pointInShape(x, z, a.o, a.i)) return a;
      }
    }
    return null;
  }

  // The parked car closest to (x, z) within maxD meters of its side, or null.
  parkedCarNear(x, z, maxD) {
    let best = null, bd = maxD;
    for (const ch of this.near(x, z, maxD + 3)) {
      for (const c of ch.parked) {
        if (c.taken) continue;
        // Distance to the car's footprint (a 4.4 x 1.9 m box along (ux, uz)).
        const dx = x - c.x, dz = z - c.z;
        const along = Math.abs(dx * c.ux + dz * c.uz) - 2.2, across = Math.abs(-dx * c.uz + dz * c.ux) - 0.95;
        const d = Math.hypot(Math.max(along, 0), Math.max(across, 0));
        if (d < bd) { bd = d; best = c; }
      }
    }
    return best;
  }

  blocked(x, z, r) {
    const [nx, nz] = this.resolveCircle(x, z, r);
    return Math.hypot(nx - x, nz - z) > 0.01;
  }

  // Street, cross street and area name for the HUD.
  locate(x, z) {
    const near = this.nearestRoad(x, z, 30, (r) => r.kind === 'car' && r.n);
    let street = near ? near.road.n : null;
    let cross = null;
    const j = this.nearestJunction(x, z, 24);
    if (j) {
      const names = [...new Set(j.carArms.map((a) => a.road.n).filter(Boolean))];
      if (names.length >= 2) {
        street = street && names.includes(street) ? street : names[0];
        cross = names.find((n) => n !== street) || null;
      }
    }
    let area = null;
    for (const c of this.near(x, z)) {
      for (const a of c.areas) {
        if (!a.n || a.k === 'parking') continue;
        if (x < a.bbox.minX || x > a.bbox.maxX || z < a.bbox.minZ || z > a.bbox.maxZ) continue;
        if (pointInShape(x, z, a.o, a.i) && (!area || a.size < area.size)) area = a;
      }
    }
    let place = null, pd = 1500;
    for (const c of this.near(x, z, 1500)) {
      for (const p of c.places) {
        if (!['neighbourhood', 'suburb', 'quarter'].includes(p.k)) continue;
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < pd) { pd = d; place = p.n; }
      }
    }
    return { street, cross, area: area ? area.n : place || this.placeName };
  }
}

export function colorFromTag(c) {
  if (!c) return null;
  if (/^#[0-9a-f]{6}$/.test(c) || /^#[0-9a-f]{3}$/.test(c)) return new THREE.Color(c);
  if (c in THREE.Color.NAMES) return new THREE.Color(THREE.Color.NAMES[c]);
  return null;
}
