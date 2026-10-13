import {
  SpatialHash, bboxOf, orient, pointInShape, closestOnSeg, closestOnPolyline, centroid, signedArea,
} from './util.js';

export const CAR_ROADS = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);
export const MAJOR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const PATHS = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'track', 'bridleway', 'corridor']);

const ROAD_WIDTH = {
  motorway: 15, trunk: 14, primary: 14, secondary: 13, tertiary: 12, residential: 10.5,
  unclassified: 8, living_street: 7, motorway_link: 7, trunk_link: 7, primary_link: 7,
  secondary_link: 7, tertiary_link: 7,
};
const SERVICE_WIDTH = { alley: 4.5, driveway: 3.5, parking_aisle: 6, 'drive-through': 3.5 };
const PATH_WIDTH = { footway: 2, path: 1.6, cycleway: 3, pedestrian: 4, steps: 2, track: 3, bridleway: 2, corridor: 2 };

export const SIDEWALK_Y = 0.15;

function classify(r) {
  if (r.tu) return 'skip';
  if (r.ar) return r.t === 'pedestrian' || r.t === 'footway' ? 'plaza' : 'skip';
  if (CAR_ROADS.has(r.t)) return 'car';
  if (r.t === 'service') return 'service';
  if ((r.t === 'footway' || r.t === 'cycleway' || r.t === 'path') && r.fw === 'crossing') return 'crossing';
  if (r.t === 'footway' && r.fw === 'sidewalk') return 'sidewalk';
  if (PATHS.has(r.t)) return 'path';
  return 'skip';
}

function widthOf(r, kind) {
  if (r.w && r.w > 1 && r.w < 40) return r.w;
  if (kind === 'car') {
    const base = ROAD_WIDTH[r.t] || 9;
    return r.ln && r.ln >= 3 ? Math.max(base, r.ln * 3.4 + 1) : base;
  }
  if (kind === 'service') return SERVICE_WIDTH[r.sv] || 5;
  if (kind === 'sidewalk') return 2;
  return PATH_WIDTH[r.t] || 2;
}

export class World {
  constructor(meta, d) {
    this.meta = meta;
    this.core = meta.core;

    // ---- roads ----
    this.roads = d.roads.map((r, idx) => {
      const kind = classify(r);
      return { ...r, idx, kind, hw: widthOf(r, kind) / 2, bbox: bboxOf(r.p) };
    });
    this.carRoads = this.roads.filter((r) => r.kind === 'car');
    this.pathSegs = new SpatialHash(12);       // footpaths, sidewalks, crossings
    for (const r of this.roads) {
      if (r.kind !== 'path' && r.kind !== 'sidewalk' && r.kind !== 'crossing') continue;
      for (let i = 0; i < r.p.length - 1; i++) {
        const a = r.p[i], b = r.p[i + 1];
        this.pathSegs.insert({ ax: a[0], az: a[1], bx: b[0], bz: b[1], hw: r.hw },
          Math.min(a[0], b[0]) - r.hw, Math.min(a[1], b[1]) - r.hw, Math.max(a[0], b[0]) + r.hw, Math.max(a[1], b[1]) + r.hw);
      }
    }
    this.roadHash = new SpatialHash(20);       // car + service segments
    for (const r of this.roads) {
      if (r.kind !== 'car' && r.kind !== 'service') continue;
      for (let i = 0; i < r.p.length - 1; i++) {
        const a = r.p[i], b = r.p[i + 1];
        const seg = { road: r, i, ax: a[0], az: a[1], bx: b[0], bz: b[1] };
        this.roadHash.insert(seg, Math.min(a[0], b[0]) - r.hw, Math.min(a[1], b[1]) - r.hw,
          Math.max(a[0], b[0]) + r.hw, Math.max(a[1], b[1]) + r.hw);
      }
    }

    // ---- junctions (where 2+ car/service ways share a node) ----
    this.junctions = d.junctions.map((j) => {
      const arms = j.r.map(([ri, vi]) => ({ road: this.roads[ri], vi })).filter((a) => a.road.kind === 'car' || a.road.kind === 'service');
      const carArms = arms.filter((a) => a.road.kind === 'car');
      const radius = Math.max(0, ...carArms.map((a) => a.road.hw));
      return { x: j.x, z: j.z, arms, carArms, radius };
    });
    this.junctionHash = new SpatialHash(30);
    for (const j of this.junctions) this.junctionHash.insert(j, j.x, j.z, j.x, j.z);

    // ---- buildings ----
    this.buildings = d.buildings.map((b, idx) => this._building(b, idx));
    this.buildingHash = new SpatialHash(16);
    for (const b of this.buildings) this.buildingHash.insert(b, b.bbox.minX, b.bbox.minZ, b.bbox.maxX, b.bbox.maxZ);

    // ---- areas ----
    this.areas = d.areas.map((a) => {
      orient(a.o, true);
      (a.i || []).forEach((h) => orient(h, false));
      return { ...a, bbox: bboxOf(a.o), size: Math.abs(signedArea(a.o)) };
    });
    this.lines = d.lines || [];

    this.pois = d.pois;
    this.trees = d.trees;
    this.props = d.props;

    // ---- colliders (filled in by builders) ----
    this.colliders = new SpatialHash(16);
    for (const b of this.buildings) if (b.solid) this._addPolyCollider(b.outer, b.holes, b.bbox, b);
    this.circles = new SpatialHash(8);

    // Raised surfaces (sidewalk slabs), filled by the street builder.
    this.raised = new SpatialHash(12);
  }

  _building(b, idx) {
    const outer = orient(b.o, true);
    const holes = (b.i || []).map((h) => orient(h, false));
    const bbox = bboxOf(outer);
    const area = Math.abs(signedArea(outer));
    const c = centroid(outer);
    return {
      idx, id: b.id, type: b.t, name: b.n, amenity: b.a, tagH: b.h, tagLevels: b.l,
      outer, holes, bbox, area, cx: c[0], cz: c[1],
      solid: b.t !== 'roof' && b.t !== 'carport',
      height: 6, pois: [],
    };
  }

  _addPolyCollider(outer, holes, bbox, ref) {
    const item = { outer, holes, bbox, ref };
    this.colliders.insert(item, bbox.minX, bbox.minZ, bbox.maxX, bbox.maxZ);
  }

  addBoxCollider(cx, cz, ux, uz, hu, hv, height) {
    const vx = -uz, vz = ux;
    const outer = [
      [cx - ux * hu - vx * hv, cz - uz * hu - vz * hv],
      [cx + ux * hu - vx * hv, cz + uz * hu - vz * hv],
      [cx + ux * hu + vx * hv, cz + uz * hu + vz * hv],
      [cx - ux * hu + vx * hv, cz - uz * hu + vz * hv],
    ];
    orient(outer, true);
    this._addPolyCollider(outer, [], bboxOf(outer), { height, box: true });
  }

  addCircleCollider(x, z, r) {
    this.circles.insert({ x, z, r }, x - r, z - r, x + r, z + r);
  }

  addRaised(ax, az, bx, bz, hw) {
    this.raised.insert({ ax, az, bx, bz, hw }, Math.min(ax, bx) - hw, Math.min(az, bz) - hw,
      Math.max(ax, bx) + hw, Math.max(az, bz) + hw);
  }

  inCore(x, z, margin = 0) {
    const c = this.core;
    return x > c.minX + margin && x < c.maxX - margin && z > c.minZ + margin && z < c.maxZ - margin;
  }

  buildingAt(x, z) {
    for (const b of this.buildingHash.near(x, z, 0)) {
      if (x < b.bbox.minX || x > b.bbox.maxX || z < b.bbox.minZ || z > b.bbox.maxZ) continue;
      if (pointInShape(x, z, b.outer, b.holes)) return b;
    }
    return null;
  }

  heightAt(x, z) {
    const b = this.buildingAt(x, z);
    return b && b.solid ? b.height : 0;
  }

  groundAt(x, z) {
    for (const s of this.raised.near(x, z, 0)) {
      if (closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz).d <= s.hw) return SIDEWALK_Y;
    }
    return 0;
  }

  // Distance from point to the nearest car/service road surface centerline.
  nearestRoad(x, z, maxD = 40, filter = (r) => r.kind === 'car') {
    let best = null;
    for (const s of this.roadHash.near(x, z, maxD)) {
      if (!filter(s.road)) continue;
      const c = closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz);
      if (c.d <= maxD && (!best || c.d < best.d)) best = { road: s.road, x: c.x, z: c.z, d: c.d, seg: s.i };
    }
    return best;
  }

  // True if the point lies on the asphalt of a car/service road (other than `except`).
  onRoad(x, z, pad = 0, except = null, kinds = ROAD_KINDS) {
    for (const s of this.roadHash.near(x, z, 0)) {
      const r = s.road;
      if (r === except || !kinds.has(r.kind)) continue;
      if (closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz).d < r.hw + pad) return true;
    }
    return false;
  }

  nearestJunction(x, z, maxD) {
    let best = null, bd = maxD;
    for (const j of this.junctionHash.near(x, z, maxD)) {
      const d = Math.hypot(j.x - x, j.z - z);
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }

  nearJunction(x, z, extra) {
    for (const j of this.junctionHash.near(x, z, 30)) {
      if (j.carArms.length < 2 && j.arms.length < 3) continue;
      if (Math.hypot(j.x - x, j.z - z) < j.radius + extra) return true;
    }
    return false;
  }

  // Push a circle of radius r out of building/car polygons and round colliders.
  resolveCircle(x, z, r) {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const c of this.colliders.near(x, z, r + 0.5)) {
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
      for (const c of this.circles.near(x, z, r + 0.5)) {
        const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz), m = r + c.r;
        if (d < m) {
          const l = d || 1e-6;
          x = c.x + (dx / l) * m; z = c.z + (dz / l) * m; moved = true;
        }
      }
      if (!moved) break;
    }
    return [x, z];
  }

  blocked(x, z, r) {
    const [nx, nz] = this.resolveCircle(x, z, r);
    return Math.hypot(nx - x, nz - z) > 0.01;
  }

  // Name of the street the point is on/near, and a cross street if near an intersection.
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
    for (const a of this.areas) {
      if (!a.n || a.k === 'parking') continue;
      if (x < a.bbox.minX || x > a.bbox.maxX || z < a.bbox.minZ || z > a.bbox.maxZ) continue;
      if (pointInShape(x, z, a.o, a.i) && (!area || a.size < area.size)) area = a;
    }
    return { street, cross, area: area ? area.n : null };
  }

  streetPoint(road, x, z) {
    return closestOnPolyline(x, z, road.p);
  }
}

const ROAD_KINDS = new Set(['car', 'service']);
export const CAR_ONLY = new Set(['car']);
