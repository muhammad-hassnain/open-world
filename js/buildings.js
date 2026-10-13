import * as THREE from 'three';
import { GeoBuilder, col, shade, hash01, orientedBox, pick } from './util.js';

const HOUSE = new Set(['house', 'detached', 'semidetached_house', 'houses', 'residential', 'bungalow',
  'terrace', 'static_caravan', 'cabin', 'farm']);
const SHED = new Set(['garage', 'garages', 'shed', 'hut', 'storage_tank', 'service', 'kiosk', 'toilets']);
const CIVIC = new Set(['university', 'school', 'college', 'civic', 'public', 'government', 'townhall', 'office',
  'hospital', 'library', 'train_station', 'transportation', 'fire_station', 'kindergarten', 'sports_hall']);
const SHOP = new Set(['commercial', 'retail', 'supermarket', 'restaurant']);
const WORSHIP = new Set(['church', 'chapel', 'cathedral', 'temple', 'synagogue', 'mosque', 'religious']);
const SHOP_POI = new Set(['food', 'shop', 'money', 'service', 'lodging']);

const PAL = {
  houseWall: ['#f1e7d3', '#d9e6ee', '#dbe5cf', '#f3e3b3', '#efd9cf', '#f6f4ef', '#e2ddd5', '#cfe0dc', '#ead8bd'],
  houseRoof: ['#5f646d', '#6f7a88', '#a85f48', '#7a6253', '#4f5560', '#8b6f5e'],
  shopWall: ['#c97c5d', '#e0c49a', '#efe2c8', '#d39a6a', '#bcd6c4', '#c9c7c2', '#e9cfa8', '#b56e5a', '#d8b4a0'],
  civicWall: ['#e2ddd2', '#d9c7a3', '#c98d72', '#cfd3d6', '#e6d9bf'],
  aptWall: ['#e8dcc6', '#d5dde3', '#e9d2bd', '#d8d0c4'],
  flatRoof: ['#9a9893', '#8e9196', '#a7a39b'],
  door: ['#8c3b2f', '#2f4f6f', '#3f6b4a', '#f4f1ea', '#7a5236'],
  awning: ['#c0392b', '#2e7d5b', '#1f4e79', '#d68910', '#6c3483', '#117a65'],
};
const TRIM = col('#fbfaf6');
const GLASS = col('#4f6d84');
const GLASS_SHOP = col('#6f95aa');
const PLINTH = col('#8d8a84');

export function styleOf(b) {
  const t = b.type;
  const shopPoi = b.pois.some((p) => SHOP_POI.has(p.c));
  if (t === 'roof' || t === 'carport') return 'canopy';
  if (WORSHIP.has(t) || b.amenity === 'place_of_worship') return 'church';
  if (SHED.has(t)) return 'shed';
  if (HOUSE.has(t)) return shopPoi && b.area > 200 ? 'shopfront' : 'house';
  if (t === 'apartments' || t === 'dormitory' || t === 'hotel') return 'apartments';
  if (SHOP.has(t)) return 'shopfront';
  if (CIVIC.has(t)) return 'civic';
  if (shopPoi) return 'shopfront';
  if (b.area < 50) return 'shed';
  if (b.area < 230) return 'house';
  return 'shopfront';
}

function layout(b, style, r) {
  let lv = b.tagLevels ? Math.max(1, Math.round(b.tagLevels)) : null;
  switch (style) {
    case 'house':
      lv ??= r < 0.7 ? 1 : 2;
      return { levels: lv, groundH: 3.0, floorH: 3.0, h: b.tagH || lv * 3.0 + 0.4 };
    case 'shopfront':
      lv ??= r < 0.55 ? 1 : r < 0.9 ? 2 : 3;
      return { levels: lv, groundH: 4.6, floorH: 3.6, h: b.tagH || 4.6 + (lv - 1) * 3.6 + 0.6 };
    case 'apartments':
      lv ??= r < 0.5 ? 2 : 3;
      return { levels: lv, groundH: 3.1, floorH: 3.1, h: b.tagH || lv * 3.1 + 0.6 };
    case 'civic':
      lv ??= r < 0.4 ? 2 : r < 0.8 ? 3 : 4;
      return { levels: lv, groundH: 3.8, floorH: 3.8, h: b.tagH || lv * 3.8 + 0.6 };
    case 'church':
      return { levels: 1, groundH: 7, floorH: 7, h: b.tagH || 7.5 };
    case 'canopy':
      return { levels: 1, groundH: 4, floorH: 4, h: 4.2 };
    default:
      return { levels: 1, groundH: 2.8, floorH: 2.8, h: b.tagH || 2.8 };
  }
}

// Facade helper: rectangle on the wall between along-distances t0..t1 and heights y0..y1.
function facadeRect(g, e, t0, t1, y0, y1, off, c) {
  const ax = e.ax + e.dx * t0 + e.nx * off, az = e.az + e.dz * t0 + e.nz * off;
  const bx = e.ax + e.dx * t1 + e.nx * off, bz = e.az + e.dz * t1 + e.nz * off;
  g.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], c, [e.nx, 0, e.nz]);
}

function windowAt(g, e, t, w, y0, h, glass, frame = TRIM) {
  facadeRect(g, e, t - w / 2 - 0.09, t + w / 2 + 0.09, y0 - 0.09, y0 + h + 0.09, 0.025, frame);
  facadeRect(g, e, t - w / 2, t + w / 2, y0, y0 + h, 0.045, glass);
  // Sill
  facadeRect(g, e, t - w / 2 - 0.15, t + w / 2 + 0.15, y0 - 0.16, y0 - 0.09, 0.06, frame);
}

function bays(len, bayW) {
  const n = Math.max(1, Math.round(len / bayW));
  const w = len / n;
  return { n, w, centers: Array.from({ length: n }, (_, i) => (i + 0.5) * w) };
}

function band(g, e, y0, y1, out, c) {
  // Protruding horizontal band (cornice): front, top, bottom faces.
  facadeRect(g, e, -out, e.len + out, y0, y1, out, c);
  const p = (t, o, y) => [e.ax + e.dx * t + e.nx * o, y, e.az + e.dz * t + e.nz * o];
  g.quad(p(-out, 0, y1), p(e.len + out, 0, y1), p(e.len + out, out, y1), p(-out, out, y1), c, [0, 1, 0]);
  g.quad(p(-out, 0, y0), p(e.len + out, 0, y0), p(e.len + out, out, y0), p(-out, out, y0), shade(c, 0.8), [0, -1, 0]);
}

function hipRoof(g, box, baseY, overhang, pitch, roofCol, trimCol) {
  const { cx, cz, ux, uz, vx, vz } = box;
  const HL = box.hu + overhang, HS = box.hv + overhang;
  const rise = Math.min(4.5, Math.max(0.9, HS * pitch));
  const P = (su, sv, y) => [cx + ux * su + vx * sv, y, cz + uz * su + vz * sv];
  const A = P(-HL, -HS, baseY), B = P(HL, -HS, baseY), C = P(HL, HS, baseY), D = P(-HL, HS, baseY);
  const ridge = Math.max(0, HL - HS);
  const R1 = P(-ridge, 0, baseY + rise), R2 = P(ridge, 0, baseY + rise);
  const up = [0, 1, 0];
  g.quad(A, B, R2, R1, roofCol, up);
  g.quad(C, D, R1, R2, shade(roofCol, 0.92), up);
  g.tri(...B, ...C, ...R2, shade(roofCol, 0.85), 0, 1, 0);
  g.tri(...D, ...A, ...R1, shade(roofCol, 0.95), 0, 1, 0);
  // Soffit (underside of the overhang) and fascia boards.
  g.quad(A, B, C, D, trimCol, [0, -1, 0]);
  const F = 0.18;
  const sides = [[A, B], [B, C], [C, D], [D, A]];
  for (const [p, q] of sides) {
    const mx = (p[0] + q[0]) / 2 - cx, mz = (p[2] + q[2]) / 2 - cz;
    g.quad([p[0], baseY - F, p[2]], [q[0], baseY - F, q[2]], q, p, trimCol, [mx, 0, mz]);
  }
  return baseY + rise;
}

function edgesOf(ring) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    out.push({ i, ax: a[0], az: a[1], bx: b[0], bz: b[1], len, dx: dx / len, dz: dz / len, nx: -dz / len, nz: dx / len });
  }
  return out;
}

// Prepare per-building style/height/edges. Needs POIs already assigned to buildings.
export function planBuildings(world, list, { streets = true } = {}) {
  for (const b of list) {
    const r = hash01(b.id % 100000);
    b.style = styleOf(b);
    Object.assign(b, layout(b, b.style, r));
    b.height = b.h;
    b.top = b.h;
    b.edges = edgesOf(b.outer);
    if (!streets) { b.front = null; continue; }
    for (const e of b.edges) {
      const mx = e.ax + e.dx * e.len / 2, mz = e.az + e.dz * e.len / 2;
      const rd = world.nearestRoad(mx, mz, 45);
      if (rd) {
        const vx = rd.x - mx, vz = rd.z - mz, l = Math.hypot(vx, vz) || 1;
        e.facing = (vx * e.nx + vz * e.nz) / l;
        e.roadDist = rd.d;
        e.road = rd.road;
      } else {
        e.facing = 0; e.roadDist = Infinity;
      }
      e.street = e.facing > 0.45 && e.roadDist < 30 && e.len > 2;
    }
    let front = null;
    for (const e of b.edges) if (e.street && (!front || e.len * e.facing > front.len * front.facing)) front = e;
    if (!front) for (const e of b.edges) if (!front || e.len > front.len) front = e;
    b.front = front;
  }
}

export function buildBuildings(world, buildings, material, { lite = false } = {}) {
  const g = new GeoBuilder();
  for (const b of buildings) {
    const r = (k) => hash01((b.id % 100000) * 7.13 + k);
    const style = b.style;
    const h = b.h;
    let wall, roof, trim;
    switch (style) {
      case 'house': wall = col(pick(PAL.houseWall, r(1))); roof = col(pick(PAL.houseRoof, r(2))); trim = TRIM; break;
      case 'shopfront': wall = col(pick(PAL.shopWall, r(1))); roof = col(pick(PAL.flatRoof, r(2))); trim = shade(wall, 0.78); break;
      case 'civic': wall = col(pick(PAL.civicWall, r(1))); roof = col(pick(PAL.flatRoof, r(2))); trim = shade(wall, 0.82); break;
      case 'apartments': wall = col(pick(PAL.aptWall, r(1))); roof = col(pick(PAL.flatRoof, r(2))); trim = TRIM; break;
      case 'church': wall = col('#f3f0e8'); roof = col('#5a5f68'); trim = TRIM; break;
      default: wall = col('#d9d4ca'); roof = col('#8e9196'); trim = col('#bdb8ae');
    }

    if (style === 'canopy') {
      g.polygon(b.outer, b.holes, h, roof, 1);
      g.polygon(b.outer, b.holes, h - 0.3, col('#cfcac0'), -1);
      for (const e of b.edges) facadeRect(g, e, 0, e.len, h - 0.3, h, 0, col('#cfcac0'));
      const postH = (h - 0.3) / 2;
      for (const p of b.outer) g.box(p[0], postH, p[1], 1, 0, 0.12, 0.12, postH, col('#8a8780'));
      continue;
    }

    // Walls (outer + courtyards).
    const rings = [b.edges, ...b.holes.map((hr) => edgesOf(hr))];
    for (const edges of rings) {
      for (const e of edges) {
        g.quad([e.ax, 0, e.az], [e.bx, 0, e.bz], [e.bx, h, e.bz], [e.ax, h, e.az], wall, [e.nx, 0, e.nz]);
      }
    }

    // Roof
    const box = orientedBox(b.outer);
    const rectish = box && b.area / Math.max(1, box.area) > 0.82 && box.hv > 1.5;
    if ((style === 'house' || style === 'church') && rectish) {
      b.top = hipRoof(g, box, h, style === 'house' ? 0.45 : 0.3, style === 'house' ? 0.48 : 0.95, roof, trim);
    } else {
      g.polygon(b.outer, b.holes, h, style === 'house' ? roof : roof, 1);
    }

    if (lite) continue;

    // Plinth strip
    if (style !== 'shed') for (const e of b.edges) facadeRect(g, e, 0, e.len, 0, 0.32, 0.012, PLINTH);

    // Cornice for flat-roofed styles
    if (style === 'shopfront' || style === 'civic' || style === 'apartments') {
      for (const e of b.edges) band(g, e, h - 0.42, h, 0.12, trim);
      if (style === 'shopfront') for (const e of b.edges) if (e.street) band(g, e, b.groundH - 0.12, b.groundH + 0.08, 0.08, trim);
    }

    facades(g, b, style, wall, trim, r);
  }
  return g.mesh(material, { cast: true, receive: true });
}

function facades(g, b, style, wall, trim, r) {
  const doorCol = col(pick(PAL.door, r(5)));
  for (const e of b.edges) {
    if (e.len < 1.6) continue;
    const isFront = e === b.front;

    if (style === 'house') {
      const bb = bays(e.len, 3.4);
      const doorBay = isFront ? Math.floor(bb.n / 2) : -1;
      for (let f = 0; f < b.levels; f++) {
        for (let i = 0; i < bb.n; i++) {
          if (bb.w < 1.6) continue;
          const t = bb.centers[i];
          if (f === 0 && i === doorBay) {
            facadeRect(g, e, t - 0.6, t + 0.6, 0, 2.25, 0.025, TRIM);
            facadeRect(g, e, t - 0.48, t + 0.48, 0.05, 2.15, 0.045, doorCol);
            continue;
          }
          windowAt(g, e, t, Math.min(1.1, bb.w - 0.7), f * b.floorH + 0.95, 1.2, GLASS);
        }
      }
    } else if (style === 'shopfront') {
      if (e.street) {
        const bb = bays(e.len, 3.2);
        const doorBay = isFront ? Math.floor(bb.n / 2) : -1;
        for (let i = 0; i < bb.n; i++) {
          const t = bb.centers[i], w = bb.w - 0.5;
          if (w < 0.8) continue;
          if (i === doorBay) {
            facadeRect(g, e, t - w / 2, t + w / 2, 0, 3.3, 0.03, trim);
            facadeRect(g, e, t - 0.6, t + 0.6, 0, 2.5, 0.05, col('#3a4e5e'));
            facadeRect(g, e, t - w / 2 + 0.1, t - 0.7, 0.45, 3.2, 0.05, GLASS_SHOP);
            facadeRect(g, e, t + 0.7, t + w / 2 - 0.1, 0.45, 3.2, 0.05, GLASS_SHOP);
          } else {
            facadeRect(g, e, t - w / 2, t + w / 2, 0.35, 3.3, 0.03, trim);
            facadeRect(g, e, t - w / 2 + 0.1, t + w / 2 - 0.1, 0.45, 3.2, 0.05, GLASS_SHOP);
          }
        }
        if (r(9 + e.i) < 0.55 && e.len > 2.5) awning(g, e, 0.2, e.len - 0.2, 3.55, col(pick(PAL.awning, r(11 + e.i))));
      } else {
        const bb = bays(e.len, 4.5);
        for (let i = 0; i < bb.n; i += 2) windowAt(g, e, bb.centers[i], 1.2, 1.2, 1.4, GLASS, trim);
      }
      const ub = bays(e.len, 3.0);
      for (let f = 1; f < b.levels; f++) {
        for (const t of ub.centers) if (ub.w > 1.5) windowAt(g, e, t, Math.min(1.3, ub.w - 0.8), b.groundH + (f - 1) * b.floorH + 0.9, 1.6, GLASS, trim);
      }
    } else if (style === 'civic' || style === 'apartments') {
      const civic = style === 'civic';
      const bb = bays(e.len, civic ? 2.6 : 3.2);
      const doorBay = isFront ? Math.floor(bb.n / 2) : -1;
      for (let f = 0; f < b.levels; f++) {
        for (let i = 0; i < bb.n; i++) {
          if (bb.w < 1.6) continue;
          const t = bb.centers[i];
          if (f === 0 && i === doorBay) {
            facadeRect(g, e, t - 1.1, t + 1.1, 0, 2.8, 0.03, trim);
            facadeRect(g, e, t - 0.95, t + 0.95, 0, 2.6, 0.05, col('#3a4e5e'));
            continue;
          }
          const w = civic ? bb.w - 0.5 : Math.min(1.3, bb.w - 0.8);
          windowAt(g, e, t, w, f * b.floorH + (civic ? 1.0 : 0.9), civic ? 1.8 : 1.4, GLASS, civic ? trim : TRIM);
        }
      }
    } else if (style === 'church') {
      const bb = bays(e.len, 3.6);
      const doorBay = isFront ? Math.floor(bb.n / 2) : -1;
      for (let i = 0; i < bb.n; i++) {
        if (bb.w < 1.8) continue;
        const t = bb.centers[i];
        if (i === doorBay) {
          facadeRect(g, e, t - 1.0, t + 1.0, 0, 3.2, 0.03, TRIM);
          facadeRect(g, e, t - 0.85, t + 0.85, 0, 3.0, 0.05, col('#7a5236'));
          continue;
        }
        windowAt(g, e, t, 0.9, 1.4, 3.6, col('#5e7fa0'));
      }
    } else if (style === 'shed' && isFront && b.type.startsWith('garage') && e.len > 3) {
      facadeRect(g, e, e.len / 2 - 1.3, e.len / 2 + 1.3, 0, 2.2, 0.04, col('#e4e1da'));
    }
  }
}

function awning(g, e, t0, t1, y, c) {
  const depth = 1.1, drop = 0.5;
  const P = (t, o, yy) => [e.ax + e.dx * t + e.nx * o, yy, e.az + e.dz * t + e.nz * o];
  const stripes = Math.max(1, Math.round((t1 - t0) / 0.6));
  const w = (t1 - t0) / stripes;
  const white = col('#f6f3ec');
  const outward = [e.nx, 1, e.nz];
  for (let i = 0; i < stripes; i++) {
    const a = t0 + i * w, b = a + w;
    const cc = i % 2 ? white : c;
    g.quad(P(a, 0.05, y), P(b, 0.05, y), P(b, depth, y - drop), P(a, depth, y - drop), cc, outward);
    g.quad(P(a, 0.05, y), P(b, 0.05, y), P(b, depth, y - drop), P(a, depth, y - drop), shade(cc, 0.75), [-e.nx, -1, -e.nz]);
    g.quad(P(a, depth, y - drop), P(b, depth, y - drop), P(b, depth, y - drop - 0.25), P(a, depth, y - drop - 0.25), cc, [e.nx, 0, e.nz]);
  }
  g.tri(...P(t0, 0.05, y), ...P(t0, depth, y - drop), ...P(t0, depth, y - drop - 0.25), shade(c, 0.85), -e.dx, 0, -e.dz);
  g.tri(...P(t1, 0.05, y), ...P(t1, depth, y - drop), ...P(t1, depth, y - drop - 0.25), shade(c, 0.85), e.dx, 0, e.dz);
}

export function buildingMaterial() {
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}
