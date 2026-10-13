import * as THREE from 'three';

export async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Deterministic pseudo-random in [0,1) from a number.
export function hash01(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(arr, r) {
  return arr[Math.floor(r * arr.length) % arr.length];
}

// ---------- 2D polygon helpers (points are [x, z]) ----------

export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// Convention: outer rings are counter-clockwise seen from above (negative shoelace in x,z),
// holes are clockwise. With that, the outward wall normal of edge a->b is (-dz, dx).
export function orient(ring, outer) {
  const neg = signedArea(ring) < 0;
  if (neg !== outer) ring.reverse();
  return ring;
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

export function pointInShape(x, z, outer, holes) {
  if (!pointInRing(x, z, outer)) return false;
  if (holes) for (const h of holes) if (pointInRing(x, z, h)) return false;
  return true;
}

export function closestOnSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = clamp(t, 0, 1);
  const x = ax + dx * t, z = az + dz * t;
  return { x, z, t, d: Math.hypot(px - x, pz - z) };
}

export function closestOnPolyline(px, pz, pts) {
  let best = null;
  let along = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const c = closestOnSeg(px, pz, a[0], a[1], b[0], b[1]);
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!best || c.d < best.d) best = { ...c, seg: i, along: along + c.t * segLen };
    along += segLen;
  }
  return best;
}

export function bboxOf(pts) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, minZ, maxX, maxZ };
}

export function centroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cz += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const b = bboxOf(ring);
    return [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Minimum-area oriented bounding box. u is the long axis.
export function orientedBox(points) {
  const hull = convexHull(points);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    let ux = q[0] - p[0], uz = q[1] - p[1];
    const l = Math.hypot(ux, uz);
    if (l < 1e-6) continue;
    ux /= l; uz /= l;
    const vx = -uz, vz = ux;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const r of hull) {
      const a = r[0] * ux + r[1] * uz, b = r[0] * vx + r[1] * vz;
      if (a < minU) minU = a; if (a > maxU) maxU = a;
      if (b < minV) minV = b; if (b > maxV) maxV = b;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uz, vx, vz, minU, maxU, minV, maxV };
  }
  if (!best) return null;
  const cu = (best.minU + best.maxU) / 2, cv = (best.minV + best.maxV) / 2;
  let hu = (best.maxU - best.minU) / 2, hv = (best.maxV - best.minV) / 2;
  let { ux, uz, vx, vz } = best;
  if (hv > hu) { [hu, hv] = [hv, hu]; [ux, uz, vx, vz] = [vx, vz, -ux, -uz]; }
  return {
    cx: cu * best.ux + cv * best.vx, cz: cu * best.uz + cv * best.vz,
    ux, uz, vx, vz, hu, hv, area: best.area,
  };
}

// Resample a polyline every `step` meters. Returns [{x, z, tx, tz, s}] with unit tangent.
export function resample(pts, step) {
  const out = [];
  let s = 0, next = 0, tx = 1, tz = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    tx = dx / len; tz = dz / len;
    while (next <= s + len) {
      const d = next - s;
      out.push({ x: a[0] + tx * d, z: a[1] + tz * d, tx, tz, s: next });
      next += step;
    }
    s += len;
  }
  const last = pts[pts.length - 1];
  if (out.length && s - out[out.length - 1].s > 1e-3) out.push({ x: last[0], z: last[1], tx, tz, s });
  return out;
}

// Offset a polyline sideways (positive = right of travel, i.e. along (-tz, tx)).
export function offsetPolyline(pts, off) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let t1x = p[0] - a[0], t1z = p[1] - a[1];
    let t2x = b[0] - p[0], t2z = b[1] - p[1];
    const l1 = Math.hypot(t1x, t1z), l2 = Math.hypot(t2x, t2z);
    if (l1 > 1e-6) { t1x /= l1; t1z /= l1; } else { t1x = t2x / (l2 || 1); t1z = t2z / (l2 || 1); }
    if (l2 > 1e-6) { t2x /= l2; t2z /= l2; } else { t2x = t1x; t2z = t1z; }
    const n1x = -t1z, n1z = t1x, n2x = -t2z, n2z = t2x;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = n1x; mz = n1z; } else { mx /= ml; mz /= ml; }
    const scale = 1 / Math.max(0.35, mx * n1x + mz * n1z);
    out.push([p[0] + mx * off * scale, p[1] + mz * off * scale]);
  }
  return out;
}

// ---------- Spatial hash for 2D queries ----------

export class SpatialHash {
  constructor(cell = 16) {
    this.cell = cell;
    this.map = new Map();
    this.stamp = 1;
  }
  _key(i, j) { return (i + 32768) * 65536 + (j + 32768); }
  insert(item, minX, minZ, maxX, maxZ) {
    const c = this.cell;
    const i0 = Math.floor(minX / c), i1 = Math.floor(maxX / c);
    const j0 = Math.floor(minZ / c), j1 = Math.floor(maxZ / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this._key(i, j);
      let arr = this.map.get(k);
      if (!arr) this.map.set(k, arr = []);
      arr.push(item);
    }
  }
  query(minX, minZ, maxX, maxZ, out = []) {
    const c = this.cell;
    const s = ++this.stamp;
    const i0 = Math.floor(minX / c), i1 = Math.floor(maxX / c);
    const j0 = Math.floor(minZ / c), j1 = Math.floor(maxZ / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const arr = this.map.get(this._key(i, j));
      if (!arr) continue;
      for (const it of arr) {
        if (it._qs === s) continue;
        it._qs = s;
        out.push(it);
      }
    }
    return out;
  }
  near(x, z, r, out) { return this.query(x - r, z - r, x + r, z + r, out); }
}

// ---------- Geometry builder: flat-shaded, vertex-colored triangles ----------

export class GeoBuilder {
  constructor() { this.p = []; this.n = []; this.c = []; }

  get count() { return this.p.length / 3; }

  // Adds triangle; if (fx,fy,fz) is given, flips winding so the normal faces that direction.
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, col, fx, fy, fz) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-10) return;
    nx /= l; ny /= l; nz /= l;
    if (fx !== undefined && nx * fx + ny * fy + nz * fz < 0) {
      let t;
      t = bx; bx = cx; cx = t; t = by; by = cy; cy = t; t = bz; bz = cz; cz = t;
      nx = -nx; ny = -ny; nz = -nz;
    }
    this.p.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) { this.n.push(nx, ny, nz); this.c.push(col.r, col.g, col.b); }
  }

  // Quad a-b-c-d (each [x,y,z]); optional facing direction f = [fx,fy,fz].
  quad(a, b, c, d, col, f) {
    if (f) {
      this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col, f[0], f[1], f[2]);
      this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], col, f[0], f[1], f[2]);
    } else {
      this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col);
      this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], col);
    }
  }

  // Horizontal polygon (with optional holes) at height y, facing up (or down if dir = -1).
  polygon(outer, holes, y, col, dir = 1) {
    const contour = outer.map((p) => new THREE.Vector2(p[0], p[1]));
    const hs = (holes || []).map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, hs); } catch { return; }
    const all = contour.concat(...hs);
    for (const [i, j, k] of tris) {
      const a = all[i], b = all[j], c = all[k];
      this.tri(a.x, y, a.y, b.x, y, b.y, c.x, y, c.y, col, 0, dir, 0);
    }
  }

  // Axis-free box given 8 corners is overkill; this builds an oriented box from center/axes.
  box(cx, cy, cz, ux, uz, hu, hv, hy, col, skipBottom = true) {
    const vx = -uz, vz = ux;
    const P = (su, sv, sy) => [cx + ux * hu * su + vx * hv * sv, cy + hy * sy, cz + uz * hu * su + vz * hv * sv];
    const c = [cx, cy, cz];
    const face = (a, b, cc, d) => {
      const mx = (a[0] + cc[0]) / 2 - c[0], my = (a[1] + cc[1]) / 2 - c[1], mz = (a[2] + cc[2]) / 2 - c[2];
      this.quad(a, b, cc, d, col, [mx, my, mz]);
    };
    face(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1));
    if (!skipBottom) face(P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1));
    face(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1));
    face(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1));
    face(P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), P(-1, -1, 1));
    face(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1));
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }

  mesh(material, { cast = false, receive = true } = {}) {
    const m = new THREE.Mesh(this.build(), material);
    m.castShadow = cast;
    m.receiveShadow = receive;
    return m;
  }
}

const colorCache = new Map();
export function col(hex) {
  let c = colorCache.get(hex);
  if (!c) colorCache.set(hex, c = new THREE.Color(hex));
  return c;
}

export function shade(c, f) {
  return new THREE.Color(c.r * f, c.g * f, c.b * f);
}
