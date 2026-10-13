import * as THREE from 'three';
import { MultiBuilder, col, shade, hash01, orientedBox, pick } from './util.js';
import { onBoundary } from './clip.js';
import { colorFromTag } from './world.js';

const HOUSE = new Set(['house', 'detached', 'semidetached_house', 'houses', 'residential', 'bungalow',
  'terrace', 'static_caravan', 'cabin', 'farm']);
const SHED = new Set(['garage', 'garages', 'shed', 'hut', 'storage_tank', 'service', 'kiosk', 'toilets']);
const CIVIC = new Set(['university', 'school', 'college', 'civic', 'public', 'government', 'townhall', 'office',
  'hospital', 'library', 'train_station', 'transportation', 'fire_station', 'kindergarten', 'sports_hall']);
const SHOP = new Set(['commercial', 'retail', 'supermarket', 'restaurant']);
const WAREHOUSE = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'hangar']);
const WORSHIP = new Set(['church', 'chapel', 'cathedral', 'temple', 'synagogue', 'mosque', 'religious']);
const SHOP_POI = new Set(['food', 'shop', 'money', 'service', 'lodging']);
const CIVIC_ZONES = new Set(['school', 'university', 'college', 'kindergarten', 'hospital', 'library']);

// Wall materials per style, with weights: varied like a real US town.
const WALLS = {
  house: [['siding', 5], ['stucco', 4], ['brick', 1]],
  shopfront: [['brick', 4], ['stucco', 3], ['brick_light', 2], ['concrete', 1]],
  civic: [['concrete', 4], ['brick', 3], ['stucco', 2], ['brick_light', 1]],
  apartments: [['stucco', 5], ['brick', 2], ['siding', 2], ['concrete', 1]],
  warehouse: [['metal', 6], ['concrete', 4]],
  church: [['stucco', 6], ['brick', 4]],
  shed: [['siding', 6], ['metal', 4]],
  canopy: [['concrete', 1]],
};
// Paint colors for stucco and siding (multiplied with the texture).
const PAINT = {
  stucco: ['#f4eee2', '#efe3c8', '#f3dcc0', '#e9d5b7', '#dfe6dc', '#e8e1d4', '#f1d7c4', '#d9c3a5', '#f6f2ea'],
  siding: ['#ffffff', '#dfe9f1', '#e5ecdc', '#f6eacb', '#e3e0da', '#d6dde3', '#f2e2d9', '#cfd8cf'],
};
const ROOF_TINT = {
  shingles: ['#ffffff', '#d9d4cf', '#c9b8a6', '#b9c1cb', '#e8dccc'],
  clay_tiles: ['#ffffff', '#f2dccc', '#e6c7b5'],
  gravel: ['#b5b2ab', '#a9aaa6', '#c2bdb2'],
};
// Average linear color of each roof texture, to tint it to a measured roof color.
const ROOF_AVG = { shingles: [0.0314, 0.0303, 0.0363], clay_tiles: [0.1822, 0.0612, 0.0283], gravel: [0.2565, 0.1974, 0.1376] };
const DOOR = ['#8c3b2f', '#2f4f6f', '#3f6b4a', '#f4f1ea', '#7a5236', '#1f2a33'];
const AWNING = ['#c0392b', '#2e7d5b', '#1f4e79', '#d68910', '#6c3483', '#117a65'];
const TRIM = col('#f7f5ef');
const GLASS = col('#5f7d92');
const GLASS_SHOP = col('#86a5b6');
const PLINTH = col('#8d8a84');

function weighted(list, r) {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let x = r * total;
  for (const [k, w] of list) { if ((x -= w) < 0) return k; }
  return list[list.length - 1][0];
}

export function styleOf(b) {
  const t = b.type;
  const shopPoi = b.pois.some((p) => SHOP_POI.has(p.c));
  if (t === 'roof' || t === 'carport') return 'canopy';
  if (WORSHIP.has(t) || b.amenity === 'place_of_worship' || b.pois.some((p) => p.c === 'worship')) return 'church';
  if (SHED.has(t)) return 'shed';
  if (WAREHOUSE.has(t)) return 'warehouse';
  if (HOUSE.has(t)) return shopPoi && b.area > 200 ? 'shopfront' : 'house';
  if (t === 'apartments' || t === 'dormitory' || t === 'hotel') return 'apartments';
  if (SHOP.has(t)) return 'shopfront';
  if (CIVIC.has(t)) return 'civic';
  const lv = b.tagLevels || 0;
  if (shopPoi) return lv >= 4 ? 'apartments' : 'shopfront';
  if (b.pois.some((p) => p.c === 'education' || p.c === 'civic' || p.c === 'health')) return 'civic';
  if (b.area < 45) return 'shed';
  if (b.zone && CIVIC_ZONES.has(b.zone)) return 'civic';
  if (b.zone === 'industrial' || b.zone === 'railway') return b.area > 400 ? 'warehouse' : 'shed';
  if (b.zone === 'commercial' || b.zone === 'retail') return lv >= 4 ? 'apartments' : 'shopfront';
  if (lv >= 4) return 'apartments';
  if (b.area < 230) return 'house';
  if (b.zone === 'residential') return 'apartments';
  return b.area > 2500 ? 'warehouse' : 'shopfront';
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
    case 'warehouse':
      return { levels: 1, groundH: 7, floorH: 7, h: b.tagH || 7 + r * 3 };
    default:
      return { levels: 1, groundH: 2.8, floorH: 2.8, h: b.tagH || 2.8 };
  }
}

function facadeRect(g, e, t0, t1, y0, y1, off, c) {
  const ax = e.ax + e.dx * t0 + e.nx * off, az = e.az + e.dz * t0 + e.nz * off;
  const bx = e.ax + e.dx * t1 + e.nx * off, bz = e.az + e.dz * t1 + e.nz * off;
  g.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], c, [e.nx, 0, e.nz]);
}

function bays(len, bayW) {
  const n = Math.max(1, Math.round(len / bayW));
  const w = len / n;
  return { n, w, centers: Array.from({ length: n }, (_, i) => (i + 0.5) * w) };
}

// Roof faces get texture coordinates along the ridge (u) and down the slope (v).
function roofUV(g, ux, uz, vx, vz) {
  const s = g.scale;
  g.uvFn = (x, y, z) => [(x * ux + z * uz) / s, ((x * vx + z * vz) * 1.12) / s];
}

function pitchedRoof(mb, key, box, baseY, overhang, pitch, gable, roofCol, trimCol, wallKey, wallCol) {
  const { cx, cz, ux, uz, vx, vz } = box;
  const HL = box.hu + overhang, HS = box.hv + overhang;
  const rise = Math.min(4.5, Math.max(0.9, HS * pitch));
  const P = (su, sv, y) => [cx + ux * su + vx * sv, y, cz + uz * su + vz * sv];
  const A = P(-HL, -HS, baseY), B = P(HL, -HS, baseY), C = P(HL, HS, baseY), D = P(-HL, HS, baseY);
  const ridge = gable ? HL : Math.max(0, HL - HS);
  const R1 = P(-ridge, 0, baseY + rise), R2 = P(ridge, 0, baseY + rise);
  const g = mb.get(key);
  roofUV(g, ux, uz, vx, vz);
  g.quad(A, B, R2, R1, roofCol, [0, 1, 0]);
  g.quad(C, D, R1, R2, shade(roofCol, 0.93), [0, 1, 0]);
  if (!gable) {
    roofUV(g, vx, vz, ux, uz);
    g.tri(...B, ...C, ...R2, shade(roofCol, 0.86), 0, 1, 0);
    g.tri(...D, ...A, ...R1, shade(roofCol, 0.95), 0, 1, 0);
  } else {
    // Gable ends: triangles of wall above the end walls.
    const w = mb.get(wallKey);
    for (const su of [-box.hu, box.hu]) {
      const a = P(su, -box.hv, baseY), b = P(su, box.hv, baseY), top = P(su, 0, baseY + rise * (1 - 0 / HS));
      w.uvWall(vx, vz);
      w.tri(...a, ...b, ...top, wallCol, ux * Math.sign(su), 0, uz * Math.sign(su));
    }
  }
  const t = mb.get('plain');
  t.quad(A, B, C, D, trimCol, [0, -1, 0]);
  const F = 0.18;
  for (const [p, q] of [[A, B], [B, C], [C, D], [D, A]]) {
    const mx = (p[0] + q[0]) / 2 - cx, mz = (p[2] + q[2]) / 2 - cz;
    t.quad([p[0], baseY - F, p[2]], [q[0], baseY - F, q[2]], q, p, trimCol, [mx, 0, mz]);
  }
  return baseY + rise;
}

function edgesOf(ring, rect) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    out.push({
      i, ax: a[0], az: a[1], bx: b[0], bz: b[1], len, dx: dx / len, dz: dz / len, nx: -dz / len, nz: dx / len,
      seam: rect ? onBoundary(a, b, rect) : false, facing: 0, roadDist: Infinity, street: false,
    });
  }
  return out;
}

export async function planBuildings(world, list, { streets = true, rect = null, budget = null } = {}) {
  for (const b of list) {
    if (budget) await budget.tick();
    const r = hash01(b.id % 100000);
    b.style = styleOf(b);
    Object.assign(b, layout(b, b.style, r));
    b.height = b.h;
    b.top = b.h;
    b.edges = edgesOf(b.outer, rect);
    b.front = null;
    if (!streets) continue;
    for (const e of b.edges) {
      if (e.seam) continue;
      const mx = e.ax + e.dx * e.len / 2, mz = e.az + e.dz * e.len / 2;
      const rd = world.nearestRoad(mx, mz, 45);
      if (!rd) continue;
      const vx = rd.x - mx, vz = rd.z - mz, l = Math.hypot(vx, vz) || 1;
      e.facing = (vx * e.nx + vz * e.nz) / l;
      e.roadDist = rd.d;
      e.road = rd.road;
      e.street = e.facing > 0.45 && e.roadDist < 30 && e.len > 2;
    }
    for (const e of b.edges) if (e.street && (!b.front || e.len * e.facing > b.front.len * b.front.facing)) b.front = e;
    if (!b.front) for (const e of b.edges) if (!e.seam && (!b.front || e.len > b.front.len)) b.front = e;
  }
}

// Picks the look of one building: wall material and paint, roof type and material, trim.
function lookOf(b, r) {
  const style = b.style;
  let wallKey = weighted(WALLS[style] || WALLS.shed, r(1));
  let wall;
  const tagged = colorFromTag(b.colour);
  if (tagged) {
    if (wallKey !== 'brick' && wallKey !== 'brick_light') wallKey = 'stucco';
    wall = tagged;
  } else if (PAINT[wallKey]) {
    wall = col(pick(PAINT[wallKey], r(2)));
  } else {
    const v = 0.88 + r(2) * 0.17;
    wall = new THREE.Color(v, v * (0.98 + r(3) * 0.04), v * (0.96 + r(4) * 0.06));
  }
  const pitched = style === 'house' || style === 'church';
  let roofKey, roofCol;
  if (b.roofColor) {
    // Seen from the air: reddish roofs are clay tile; the texture is tinted to the photo's color.
    const c = b.roofColor;
    const reddish = c.r > c.g * 1.5 && c.r > c.b * 2.2;
    roofKey = pitched ? (reddish ? 'clay_tiles' : 'shingles') : 'gravel';
    const avg = ROOF_AVG[roofKey];
    roofCol = new THREE.Color(Math.min(12, (c.r * 0.85) / avg[0]), Math.min(12, (c.g * 0.85) / avg[1]), Math.min(12, (c.b * 0.85) / avg[2]));
  } else {
    roofKey = pitched ? (style === 'house' && r(5) < 0.3 ? 'clay_tiles' : 'shingles') : 'gravel';
    roofCol = col(pick(ROOF_TINT[roofKey], r(6)));
  }
  const trim = wallKey === 'brick' || wallKey === 'brick_light' ? col('#efe7d8') : style === 'house' ? TRIM : shade(wall, 0.82);
  return { wallKey, wall, roofKey, roofCol, trim, gable: style === 'church' || r(7) < 0.5 };
}

export async function buildBuildings(list, materials, { lite = false, rect = null, budget = null } = {}) {
  const mb = new MultiBuilder(materials);
  for (const b of list) {
    if (budget) await budget.tick();
    const r = (k) => hash01((b.id % 100000) * 7.13 + k);
    const look = lookOf(b, r);
    const h = b.h, y0 = b.minH || 0;

    if (b.style === 'canopy') {
      const g = mb.get('plain');
      g.polygon(b.outer, b.holes, h, col('#9a9893'), 1);
      g.polygon(b.outer, b.holes, h - 0.3, col('#cfcac0'), -1);
      for (const e of b.edges) if (!e.seam) facadeRect(g, e, 0, e.len, h - 0.3, h, 0, col('#cfcac0'));
      if (!lite) {
        const postH = (h - 0.3) / 2;
        for (const p of b.outer) g.box(p[0], postH, p[1], 1, 0, 0.12, 0.12, postH, col('#8a8780'));
      }
      continue;
    }

    const walls = mb.get(look.wallKey);
    const rings = [b.edges, ...b.holes.map((hr) => edgesOf(hr, rect))];
    for (const edges of rings) {
      for (const e of edges) {
        if (e.seam) continue;
        walls.uvWall(e.dx, e.dz);
        walls.quad([e.ax, y0, e.az], [e.bx, y0, e.bz], [e.bx, h, e.bz], [e.ax, h, e.az], look.wall, [e.nx, 0, e.nz]);
      }
    }
    if (y0 > 0) mb.get('plain').polygon(b.outer, b.holes, y0, shade(look.wall, 0.7), -1);

    const box = !b.clipped && orientedBox(b.outer);
    const rectish = box && b.area / Math.max(1, box.area) > 0.82 && box.hv > 1.5;
    if ((b.style === 'house' || b.style === 'church') && rectish) {
      b.top = pitchedRoof(mb, look.roofKey, box, h, b.style === 'house' ? 0.45 : 0.3, b.style === 'house' ? 0.5 : 0.95,
        look.gable, look.roofCol, look.trim, look.wallKey, look.wall);
    } else {
      const roofKey = b.style === 'house' ? look.roofKey : 'gravel';
      const g = mb.get(roofKey === 'gravel' ? 'gravel' : roofKey);
      g.uvPlanar();
      g.polygon(b.outer, b.holes, h, look.roofCol, 1);
    }

    if (lite || y0 > 0) continue;
    const plain = mb.get('plain');
    if (b.style !== 'shed' && b.style !== 'warehouse') for (const e of b.edges) if (!e.seam) facadeRect(plain, e, 0, e.len, 0, 0.32, 0.012, PLINTH);
    if (b.style === 'shopfront' || b.style === 'civic' || b.style === 'apartments') {
      for (const e of b.edges) if (!e.seam) band(plain, e, h - 0.42, h, 0.12, look.trim);
      if (b.style === 'shopfront') for (const e of b.edges) if (e.street) band(plain, e, b.groundH - 0.12, b.groundH + 0.08, 0.08, look.trim);
    }
    facades(mb, b, look, r);
  }
  return mb.meshes({ cast: !lite, receive: true });
}

function band(g, e, y0, y1, out, c) {
  facadeRect(g, e, -out, e.len + out, y0, y1, out, c);
  const p = (t, o, y) => [e.ax + e.dx * t + e.nx * o, y, e.az + e.dz * t + e.nz * o];
  g.quad(p(-out, 0, y1), p(e.len + out, 0, y1), p(e.len + out, out, y1), p(-out, out, y1), c, [0, 1, 0]);
  g.quad(p(-out, 0, y0), p(e.len + out, 0, y0), p(e.len + out, out, y0), p(-out, out, y0), shade(c, 0.8), [0, -1, 0]);
}

function windowAt(mb, e, t, w, y0, h, glass = GLASS, frame = TRIM, shutters = null) {
  const plain = mb.get('plain');
  facadeRect(plain, e, t - w / 2 - 0.09, t + w / 2 + 0.09, y0 - 0.09, y0 + h + 0.09, 0.025, frame);
  facadeRect(mb.get('glass'), e, t - w / 2, t + w / 2, y0, y0 + h, 0.045, glass);
  facadeRect(plain, e, t - w / 2 - 0.15, t + w / 2 + 0.15, y0 - 0.16, y0 - 0.09, 0.06, frame);
  if (shutters) {
    facadeRect(plain, e, t - w / 2 - 0.55, t - w / 2 - 0.12, y0, y0 + h, 0.04, shutters);
    facadeRect(plain, e, t + w / 2 + 0.12, t + w / 2 + 0.55, y0, y0 + h, 0.04, shutters);
  }
}

function facades(mb, b, look, r) {
  const plain = mb.get('plain');
  const glass = mb.get('glass');
  const doorCol = col(pick(DOOR, r(5)));
  const trim = look.trim;
  const shutters = b.style === 'house' && r(8) < 0.35 ? col(pick(DOOR, r(9))) : null;
  for (const e of b.edges) {
    if (e.len < 1.6 || e.seam) continue;
    const isFront = e === b.front;

    if (b.style === 'house') {
      const bb = bays(e.len, 3.4);
      const doorBay = isFront ? Math.floor(bb.n / 2) : -1;
      for (let f = 0; f < b.levels; f++) {
        for (let i = 0; i < bb.n; i++) {
          if (bb.w < 1.6) continue;
          const t = bb.centers[i];
          if (f === 0 && i === doorBay) {
            facadeRect(plain, e, t - 0.6, t + 0.6, 0, 2.25, 0.025, TRIM);
            facadeRect(plain, e, t - 0.48, t + 0.48, 0.05, 2.15, 0.045, doorCol);
            // Small porch roof over the door.
            const P = (tt, o, y) => [e.ax + e.dx * tt + e.nx * o, y, e.az + e.dz * tt + e.nz * o];
            plain.quad(P(t - 1, 0, 2.6), P(t + 1, 0, 2.6), P(t + 1, 1.2, 2.35), P(t - 1, 1.2, 2.35), shade(look.roofCol, 0.6), [e.nx, 1, e.nz]);
            plain.quad(P(t - 1, 0, 2.6), P(t + 1, 0, 2.6), P(t + 1, 1.2, 2.35), P(t - 1, 1.2, 2.35), TRIM, [-e.nx, -1, -e.nz]);
            continue;
          }
          windowAt(mb, e, t, Math.min(1.1, bb.w - 0.7), f * b.floorH + 0.95, 1.2, GLASS, TRIM, shutters);
        }
      }
    } else if (b.style === 'shopfront') {
      if (e.street) {
        const bb = bays(e.len, 3.2);
        const doorBay = isFront ? Math.floor(bb.n / 2) : -1;
        for (let i = 0; i < bb.n; i++) {
          const t = bb.centers[i], w = bb.w - 0.5;
          if (w < 0.8) continue;
          if (i === doorBay) {
            facadeRect(plain, e, t - w / 2, t + w / 2, 0, 3.3, 0.03, trim);
            facadeRect(glass, e, t - 0.6, t + 0.6, 0, 2.5, 0.05, col('#3a4e5e'));
            facadeRect(glass, e, t - w / 2 + 0.1, t - 0.7, 0.45, 3.2, 0.05, GLASS_SHOP);
            facadeRect(glass, e, t + 0.7, t + w / 2 - 0.1, 0.45, 3.2, 0.05, GLASS_SHOP);
          } else {
            facadeRect(plain, e, t - w / 2, t + w / 2, 0.35, 3.3, 0.03, trim);
            facadeRect(glass, e, t - w / 2 + 0.1, t + w / 2 - 0.1, 0.45, 3.2, 0.05, GLASS_SHOP);
          }
        }
        if (r(9 + e.i) < 0.55 && e.len > 2.5) awning(plain, e, 0.2, e.len - 0.2, 3.55, col(pick(AWNING, r(11 + e.i))));
      } else {
        const bb = bays(e.len, 4.5);
        for (let i = 0; i < bb.n; i += 2) windowAt(mb, e, bb.centers[i], 1.2, 1.2, 1.4, GLASS, trim);
      }
      const ub = bays(e.len, 3.0);
      for (let f = 1; f < b.levels; f++) {
        for (const t of ub.centers) if (ub.w > 1.5) windowAt(mb, e, t, Math.min(1.3, ub.w - 0.8), b.groundH + (f - 1) * b.floorH + 0.9, 1.6, GLASS, trim);
      }
    } else if ((b.style === 'civic' || b.style === 'apartments') && b.levels >= 8) {
      for (let f = 0; f < Math.min(b.levels, 120); f++) {
        facadeRect(glass, e, 0.3, e.len - 0.3, f * b.floorH + 0.9, f * b.floorH + 0.9 + b.floorH * 0.5, 0.04, GLASS);
      }
    } else if (b.style === 'civic' || b.style === 'apartments') {
      const civic = b.style === 'civic';
      const bb = bays(e.len, civic ? 2.6 : 3.2);
      const doorBay = isFront ? Math.floor(bb.n / 2) : -1;
      const balconies = !civic && b.levels >= 2 && r(10) < 0.4;
      for (let f = 0; f < b.levels; f++) {
        for (let i = 0; i < bb.n; i++) {
          if (bb.w < 1.6) continue;
          const t = bb.centers[i];
          if (f === 0 && i === doorBay) {
            facadeRect(plain, e, t - 1.1, t + 1.1, 0, 2.8, 0.03, trim);
            facadeRect(glass, e, t - 0.95, t + 0.95, 0, 2.6, 0.05, col('#3a4e5e'));
            continue;
          }
          const w = civic ? bb.w - 0.5 : Math.min(1.3, bb.w - 0.8);
          windowAt(mb, e, t, w, f * b.floorH + (civic ? 1.0 : 0.9), civic ? 1.8 : 1.4, GLASS, civic ? trim : TRIM);
          if (balconies && f > 0 && i % 2 === 0) balcony(plain, e, t, f * b.floorH, Math.min(2.4, bb.w * 1.4));
        }
      }
    } else if (b.style === 'church') {
      const bb = bays(e.len, 3.6);
      const doorBay = isFront ? Math.floor(bb.n / 2) : -1;
      for (let i = 0; i < bb.n; i++) {
        if (bb.w < 1.8) continue;
        const t = bb.centers[i];
        if (i === doorBay) {
          facadeRect(plain, e, t - 1.0, t + 1.0, 0, 3.2, 0.03, TRIM);
          facadeRect(plain, e, t - 0.85, t + 0.85, 0, 3.0, 0.05, col('#7a5236'));
          continue;
        }
        windowAt(mb, e, t, 0.9, 1.4, 3.6, col('#5e7fa0'));
      }
    } else if (b.style === 'warehouse') {
      const bb = bays(e.len, 6);
      for (let i = 0; i < bb.n; i++) {
        if (bb.w < 3) continue;
        facadeRect(glass, e, bb.centers[i] - bb.w / 2 + 0.6, bb.centers[i] + bb.w / 2 - 0.6, b.h - 2.2, b.h - 1.2, 0.04, GLASS);
      }
      if (isFront && e.len > 6) facadeRect(plain, e, e.len / 2 - 2, e.len / 2 + 2, 0, 4, 0.04, col('#9aa0a6'));
    } else if (b.style === 'shed' && isFront && e.len > 3) {
      facadeRect(plain, e, e.len / 2 - 1.3, e.len / 2 + 1.3, 0, 2.2, 0.04, col('#e4e1da'));
    }
  }
}

function balcony(g, e, t, y, w) {
  const P = (tt, o, yy) => [e.ax + e.dx * tt + e.nx * o, yy, e.az + e.dz * tt + e.nz * o];
  const c = col('#d9d6cf'), rail = col('#9aa0a6');
  const D = 0.6;
  g.quad(P(t - w / 2, 0, y), P(t + w / 2, 0, y), P(t + w / 2, D, y), P(t - w / 2, D, y), c, [0, 1, 0]);
  g.quad(P(t - w / 2, 0, y - 0.12), P(t + w / 2, 0, y - 0.12), P(t + w / 2, D, y - 0.12), P(t - w / 2, D, y - 0.12), shade(c, 0.85), [0, -1, 0]);
  g.quad(P(t - w / 2, D, y - 0.12), P(t + w / 2, D, y - 0.12), P(t + w / 2, D, y), P(t - w / 2, D, y), shade(c, 0.9), [e.nx, 0, e.nz]);
  // Railing: top rail plus a light balustrade panel.
  g.quad(P(t - w / 2, D, y + 0.9), P(t + w / 2, D, y + 0.9), P(t + w / 2, D, y + 0.96), P(t - w / 2, D, y + 0.96), rail, [e.nx, 0, e.nz]);
  for (let k = 0; k <= Math.round(w / 0.25); k++) {
    const tt = t - w / 2 + (k * w) / Math.round(w / 0.25);
    g.quad(P(tt - 0.015, D, y), P(tt + 0.015, D, y), P(tt + 0.015, D, y + 0.9), P(tt - 0.015, D, y + 0.9), rail, [e.nx, 0, e.nz]);
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
