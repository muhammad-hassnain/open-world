// Bridges, overpasses and their ramps.
//
// Terrain is a bare-earth model: bridges aren't in it, so every road would follow the ground
// (and dip into rivers). Here each tile's roads get deck heights:
//   1. A bridge (OSM bridge=*) is anchored where it meets a road on the ground; between
//      anchors its height is interpolated along the bridge network (linear along a chain).
//   2. Where a bridge passes over another road it must clear it (6 m over roads, 3.2 m over
//      paths, over lower bridges by layer). Missing height is added and spread outward at a
//      5.5% grade, which also lifts the approach roads into ramps (embankments) when the
//      elevation model has no embankment (30 m data outside the US smooths them away).
// Elevated roads get `ez = 1` and a third coordinate (deck elevation) on every point;
// `br` tells bridge decks (girders, piers) from ramps (retaining walls).

import { classifyRoad } from './world.js';
import { SpatialHash } from './util.js';

const CLEAR_ROAD = 6.0, CLEAR_PATH = 3.2, CLEAR_BRIDGE = 6.2;
const GRADE = 0.055;
const MIN_LIFT = 0.25;     // ramps lower than this stay on the ground

const keyOf = (p) => `${Math.round(p[0] * 20)},${Math.round(p[1] * 20)}`;
const layerOf = (r) => (r.ly != null ? r.ly : r.br ? 1 : 0);

class Heap {
  constructor(cmp) { this.a = []; this.cmp = cmp; }
  get size() { return this.a.length; }
  push(v) {
    const a = this.a; a.push(v);
    for (let i = a.length - 1; i > 0;) { const p = (i - 1) >> 1; if (this.cmp(a[i], a[p]) >= 0) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

// Intersection of segments a-b and c-d: parameter along a-b, or -1.
function cross(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const qx = c[0] - a[0], qz = c[1] - a[1];
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999 ? t : -1;
}

// Deck elevation of an elevated road at (x, z): from the nearest point of its polyline.
export function deckY(r, x, z) {
  const p = r.p;
  let best = Infinity, y = p[0][2] || 0;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i], b = p[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
    const d = (a[0] + dx * t - x) ** 2 + (a[1] + dz * t - z) ** 2;
    if (d < best) { best = d; y = a[2] + (b[2] - a[2]) * t; }
  }
  return y;
}

// Gives the bridges in a tile (local meters) deck heights; elev(x, z) is the terrain.
export function elevateRoads(d, elev) {
  const roads = d.roads.filter((r) => {
    if (r.tu || r.p.length < 2) return false;
    const k = classifyRoad(r);
    return k === 'car' || k === 'service' || k === 'path' || k === 'sidewalk' || k === 'crossing';
  });
  const bridges = roads.filter((r) => r.br);
  if (!bridges.length) return;

  // Where bridges pass over other roads: insert a vertex there and remember what is below.
  const segs = new SpatialHash(32);
  for (const r of roads) {
    for (let i = 0; i < r.p.length - 1; i++) {
      const a = r.p[i], b = r.p[i + 1];
      segs.insert({ r, a, b }, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    }
  }
  const crossings = [];  // { r, p (the inserted point), under }
  for (const r of bridges) {
    const pts = [r.p[0]];
    for (let i = 0; i < r.p.length - 1; i++) {
      const a = r.p[i], b = r.p[i + 1];
      const hits = [];
      for (const s of segs.query(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]))) {
        if (s.r === r || layerOf(s.r) >= layerOf(r)) continue;
        const t = cross(a, b, s.a, s.b);
        if (t > 0) hits.push({ t, under: s.r });
      }
      hits.sort((x, y) => x.t - y.t);
      for (const h of hits) {
        const p = [a[0] + (b[0] - a[0]) * h.t, a[1] + (b[1] - a[1]) * h.t];
        pts.push(p);
        crossings.push({ r, p, under: h.under });
      }
      pts.push(b);
    }
    r.p = pts;
  }

  // Vertex graph over all roads (shared points join roads).
  const nodes = new Map();
  const node = (p) => {
    const k = keyOf(p);
    let n = nodes.get(k);
    if (!n) nodes.set(k, n = { x: p[0], z: p[1], g: elev(p[0], p[1]), adj: [], bridge: false, ground: false, base: 0, h: 0, req: -Infinity });
    return n;
  };
  for (const r of roads) {
    r._n = r.p.map(node);
    for (const n of r._n) { if (r.br) n.bridge = true; else n.ground = true; }
    for (let i = 0; i < r._n.length - 1; i++) {
      const a = r._n[i], b = r._n[i + 1], len = Math.hypot(b.x - a.x, b.z - a.z);
      if (a === b) continue;
      a.adj.push({ n: b, len, br: !!r.br });
      b.adj.push({ n: a, len, br: !!r.br });
    }
  }

  // Base heights: ground for ground nodes; bridge-only nodes interpolate between anchors,
  // weighting each anchor by 1 / distance along the bridges (exactly linear along a chain).
  const all = [...nodes.values()];
  for (const n of all) n.base = n.g;
  const bridgeOnly = all.filter((n) => n.bridge && !n.ground);
  const anchors = all.filter((n) => n.bridge && (n.ground || n.adj.filter((e) => e.br).length === 1));
  const sumW = new Map(), sumH = new Map();
  for (const a of anchors) {
    const dist = new Map([[a, 0]]);
    const heap = new Heap((x, y) => x[0] - y[0]);
    heap.push([0, a]);
    while (heap.size) {
      const [d0, u] = heap.pop();
      if (d0 > dist.get(u)) continue;
      if (u !== a && u.ground) continue;  // stop at the next anchor
      for (const e of u.adj) {
        if (!e.br) continue;
        const nd = d0 + e.len;
        if (nd < (dist.get(e.n) ?? Infinity)) { dist.set(e.n, nd); heap.push([nd, e.n]); }
      }
    }
    for (const [n, dd] of dist) {
      if (n.ground || n === a) continue;
      const w = 1 / Math.max(dd, 0.01);
      sumW.set(n, (sumW.get(n) || 0) + w);
      sumH.set(n, (sumH.get(n) || 0) + w * a.g);
    }
  }
  for (const n of bridgeOnly) {
    const w = sumW.get(n);
    n.base = Math.max(w ? sumH.get(n) / w : n.g, n.g + 0.5);
  }

  const solve = (extra) => {
    for (const n of all) { n.h = n.base; n.req = -Infinity; }
    for (const c of [...crossings, ...extra]) {
      const n = node(c.p);
      const ground = elev(c.p[0], c.p[1]);
      const need = c.over != null ? c.over + CLEAR_BRIDGE
        : ground + (classifyRoad(c.under) === 'car' || classifyRoad(c.under) === 'service' ? CLEAR_ROAD : CLEAR_PATH);
      n.req = Math.max(n.req, need);
    }
    // Spread required heights outward along every road at the maximum grade.
    const heap = new Heap((x, y) => y[0] - x[0]);
    for (const n of all) if (n.req > n.h) { n.h = n.req; heap.push([n.h, n]); }
    while (heap.size) {
      const [h, u] = heap.pop();
      if (h < u.h) continue;
      for (const e of u.adj) {
        const c = h - GRADE * e.len;
        if (c > e.n.h) { e.n.h = c; heap.push([c, e.n]); }
      }
    }
  };
  solve([]);
  // Second pass: bridges over lower bridges clear their decks.
  const extra = [];
  for (const c of crossings) {
    if (!c.under.br) continue;
    const u = c.under, pts = u._n;
    let best = Infinity, y = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((c.p[0] - a.x) * dx + (c.p[1] - a.z) * dz) / l2));
      const dd = Math.hypot(a.x + dx * t - c.p[0], a.z + dz * t - c.p[1]);
      if (dd < best) { best = dd; y = a.h + (b.h - a.h) * t; }
    }
    extra.push({ p: c.p, over: y });
  }
  if (extra.length) solve(extra);

  // Write heights; split ground roads so only their lifted part becomes a ramp.
  const out = [];
  for (const r of d.roads) {
    if (!r._n) { out.push(r); continue; }
    const ns = r._n;
    delete r._n;
    if (r.br) {
      r.ez = 1;
      r.p = r.p.map((p, i) => [p[0], p[1], ns[i].h]);
      out.push(r);
      continue;
    }
    const lift = ns.map((n) => n.h - n.g);
    if (!lift.some((l) => l > MIN_LIFT)) { out.push(r); continue; }
    // Runs of lifted vertices, each extended by one vertex where the ramp meets the ground.
    let i = 0;
    const flat = [];
    let flatStart = 0;
    while (i < ns.length) {
      if (lift[i] <= 0.02) { i++; continue; }
      const s = Math.max(0, i - 1);
      let e = i;
      while (e + 1 < ns.length && lift[e + 1] > 0.02) e++;
      e = Math.min(ns.length - 1, e + 1);
      if (s > flatStart) flat.push([flatStart, s]);
      out.push({ ...r, p: r.p.slice(s, e + 1).map((p, k) => [p[0], p[1], ns[s + k].h]), ez: 1 });
      flatStart = e;
      i = e + 1;
    }
    if (flatStart < ns.length - 1) flat.push([flatStart, ns.length - 1]);
    for (const [s, e] of flat) out.push({ ...r, p: r.p.slice(s, e + 1) });
  }
  d.roads = out;
}
