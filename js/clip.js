// Clip polygons and polylines to an axis-aligned rectangle {minX, maxX, minZ, maxZ}.
// Points are [x, z]. Points created on the boundary get the boundary coordinate exactly,
// so seams between neighboring chunks can be recognized with onBoundary().

export const inRect = (x, z, r, m = 0) => x >= r.minX - m && x <= r.maxX + m && z >= r.minZ - m && z <= r.maxZ + m;

function bounds(pts) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, minZ, maxX, maxZ };
}

function cut(a, b, axis, v) {
  const t = (v - a[axis]) / (b[axis] - a[axis]);
  const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  p[axis] = v;
  return p;
}

function clipAxis(pts, axis, v, keepGreater) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const cur = pts[i], prev = pts[(i + n - 1) % n];
    const cIn = keepGreater ? cur[axis] >= v : cur[axis] <= v;
    const pIn = keepGreater ? prev[axis] >= v : prev[axis] <= v;
    if (cIn) {
      if (!pIn) out.push(cut(prev, cur, axis, v));
      out.push(cur);
    } else if (pIn) {
      out.push(cut(prev, cur, axis, v));
    }
  }
  return out;
}

// Returns the clipped ring, or null if nothing remains. `clipped` reports whether it was cut.
export function clipRing(ring, r) {
  const b = bounds(ring);
  if (b.minX >= r.minX && b.maxX <= r.maxX && b.minZ >= r.minZ && b.maxZ <= r.maxZ) return { ring, clipped: false };
  if (b.maxX < r.minX || b.minX > r.maxX || b.maxZ < r.minZ || b.minZ > r.maxZ) return null;
  let p = ring;
  p = clipAxis(p, 0, r.minX, true); if (p.length < 3) return null;
  p = clipAxis(p, 0, r.maxX, false); if (p.length < 3) return null;
  p = clipAxis(p, 1, r.minZ, true); if (p.length < 3) return null;
  p = clipAxis(p, 1, r.maxZ, false); if (p.length < 3) return null;
  const out = [];
  for (const q of p) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - q[0]) > 1e-9 || Math.abs(last[1] - q[1]) > 1e-9) out.push(q);
  }
  if (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-9 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
  return out.length >= 3 ? { ring: out, clipped: true } : null;
}

// Liang-Barsky per segment; returns a list of polylines inside the rectangle.
export function clipLine(pts, r) {
  const b = bounds(pts);
  if (b.minX >= r.minX && b.maxX <= r.maxX && b.minZ >= r.minZ && b.maxZ <= r.maxZ) return [pts];
  if (b.maxX < r.minX || b.minX > r.maxX || b.maxZ < r.minZ || b.minZ > r.maxZ) return [];
  const out = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], c = pts[i + 1];
    const dx = c[0] - a[0], dz = c[1] - a[1];
    let t0 = 0, t1 = 1;
    let ok = true;
    for (const [p, q] of [[-dx, a[0] - r.minX], [dx, r.maxX - a[0]], [-dz, a[1] - r.minZ], [dz, r.maxZ - a[1]]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; }
      else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { cur = null; continue; }
    const snap = (p) => {
      if (Math.abs(p[0] - r.minX) < 1e-7) p[0] = r.minX; else if (Math.abs(p[0] - r.maxX) < 1e-7) p[0] = r.maxX;
      if (Math.abs(p[1] - r.minZ) < 1e-7) p[1] = r.minZ; else if (Math.abs(p[1] - r.maxZ) < 1e-7) p[1] = r.maxZ;
      return p;
    };
    const p0 = t0 === 0 ? a : snap([a[0] + dx * t0, a[1] + dz * t0]);
    const p1 = t1 === 1 ? c : snap([a[0] + dx * t1, a[1] + dz * t1]);
    if (cur && t0 === 0) cur.push(p1);
    else { cur = [p0, p1]; out.push(cur); }
    if (t1 !== 1) cur = null;
  }
  return out.filter((l) => l.length >= 2);
}

// True if segment a-b lies on one side of the rectangle (a seam created by clipping).
export function onBoundary(a, b, r, eps = 1e-6) {
  return (Math.abs(a[0] - r.minX) < eps && Math.abs(b[0] - r.minX) < eps)
    || (Math.abs(a[0] - r.maxX) < eps && Math.abs(b[0] - r.maxX) < eps)
    || (Math.abs(a[1] - r.minZ) < eps && Math.abs(b[1] - r.minZ) < eps)
    || (Math.abs(a[1] - r.maxZ) < eps && Math.abs(b[1] - r.maxZ) < eps);
}
