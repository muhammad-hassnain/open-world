// Overture Maps (https://overturemaps.org): fresher places (shops, restaurants, … with
// open/closed status, phones, websites) and extra building footprints (Microsoft, Esri, Google)
// merged into each z14 tile from either data source.
//
// Read straight from Overture's monthly PMTiles archives with HTTP range requests: a 127-byte
// header, a root directory, a leaf directory, then the tile (gzipped MVT). The newest release
// is found by listing the bucket; if anything fails the tile keeps its OpenStreetMap data only.

import { decodeTile, polygons } from './mvt.js';

const BUCKET = 'https://overturemaps-extras-us-west-2.s3.amazonaws.com';
const FALLBACK_RELEASE = '2026-09-23.1';
const THEMES = ['places', 'buildings'];
const TIMEOUT = 12000;

const MIN_CONF = 0.7;      // places below this are often stale or misplaced
const MATCH_M = 60;        // an OSM place and an Overture place with the same name within this are one place
const DEDUPE_M = 35;       // two Overture places with the same name within this are one place
const MIN_AREA_M2 = 12;    // smaller machine-traced footprints are mostly noise

// ---------- PMTiles ----------

let releaseP = null;
function release() {
  releaseP ??= fetch(`${BUCKET}/?list-type=2&prefix=tiles/`)
    .then((r) => (r.ok ? r.text() : ''))
    .then((xml) => {
      const have = new Map();
      for (const m of xml.matchAll(/<Key>tiles\/([^/<]+)\/(\w+)\.pmtiles<\/Key>/g)) {
        if (!have.has(m[1])) have.set(m[1], new Set());
        have.get(m[1]).add(m[2]);
      }
      const ok = [...have].filter(([, s]) => THEMES.every((t) => s.has(t))).map(([r]) => r);
      ok.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      return ok.pop() || FALLBACK_RELEASE;
    })
    .catch(() => FALLBACK_RELEASE);
  return releaseP;
}

async function gunzip(buf, compression) {
  if (compression === 1 || compression === 0) return buf;
  if (compression !== 2) throw new Error(`pmtiles: unsupported compression ${compression}`);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

// Hilbert-curve tile id of the PMTiles v3 spec.
function tileId(z, x, y) {
  let acc = 0;
  for (let t = 0; t < z; t++) acc += 4 ** t;
  let d = 0;
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      [x, y] = [y, x];
    }
  }
  return acc + d;
}

function parseDir(buf) {
  const b = new Uint8Array(buf);
  let p = 0;
  // Offsets exceed 32 bits (the archives are 20–200 GB): no bit operators here.
  const v = () => { let r = 0, m = 1, c; do { c = b[p++]; r += (c & 0x7f) * m; m *= 128; } while (c & 0x80); return r; };
  const n = v();
  const ids = new Array(n), runs = new Array(n), lens = new Array(n), offs = new Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) { last += v(); ids[i] = last; }
  for (let i = 0; i < n; i++) runs[i] = v();
  for (let i = 0; i < n; i++) lens[i] = v();
  for (let i = 0; i < n; i++) { const o = v(); offs[i] = o === 0 && i > 0 ? offs[i - 1] + lens[i - 1] : o - 1; }
  return { ids, runs, lens, offs };
}

class Archive {
  constructor(url) { this.url = url; this.headerP = null; this.dirs = new Map(); }

  async range(o, l) {
    const res = await fetch(this.url, { headers: { Range: `bytes=${o}-${o + l - 1}` } });
    if (!res.ok) throw new Error(`pmtiles ${this.url}: HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  header() {
    this.headerP ??= this.range(0, 127).then((buf) => {
      const v = new DataView(buf);
      const q = (i) => Number(v.getBigUint64(8 + i * 8, true));
      if (new TextDecoder().decode(new Uint8Array(buf, 0, 7)) !== 'PMTiles' || v.getUint8(7) !== 3) throw new Error('pmtiles: not a v3 archive');
      return { rootOff: q(0), rootLen: q(1), leafOff: q(4), dataOff: q(6), dirComp: v.getUint8(97), tileComp: v.getUint8(98) };
    });
    return this.headerP;
  }

  dir(o, l, comp) {
    const key = `${o}:${l}`;
    if (!this.dirs.has(key)) {
      if (this.dirs.size > 64) this.dirs.delete(this.dirs.keys().next().value);
      const p = this.range(o, l).then((b) => gunzip(b, comp)).then(parseDir);
      p.catch(() => this.dirs.delete(key));
      this.dirs.set(key, p);
    }
    return this.dirs.get(key);
  }

  async tile(z, x, y) {
    const h = await this.header();
    const id = tileId(z, x, y);
    let o = h.rootOff, l = h.rootLen;
    for (let depth = 0; depth < 4; depth++) {
      const d = await this.dir(o, l, h.dirComp);
      let lo = 0, hi = d.ids.length - 1, i = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (d.ids[m] <= id) { i = m; lo = m + 1; } else hi = m - 1; }
      if (i < 0) return null;
      if (d.runs[i] > 0) {
        if (id >= d.ids[i] + d.runs[i]) return null;
        return gunzip(await this.range(h.dataOff + d.offs[i], d.lens[i]), h.tileComp);
      }
      o = h.leafOff + d.offs[i]; l = d.lens[i];
    }
    return null;
  }
}

const archives = new Map();
async function archive(theme) {
  const url = `${BUCKET}/tiles/${await release()}/${theme}.pmtiles`;
  if (!archives.has(url)) archives.set(url, new Archive(url));
  return archives.get(url);
}

let warned = false;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// Decoded Overture layers for a tile: { place, building } (either may be null).
export function fetchOverture(z, x, y) {
  const one = (theme, layer) => withTimeout(archive(theme).then((a) => a.tile(z, x, y)), TIMEOUT)
    .then((buf) => (buf ? decodeTile(buf)[layer] || null : null))
    .catch((e) => {
      if (!warned) { warned = true; console.warn('[overture] unavailable, using OpenStreetMap only:', e.message); }
      return null;
    });
  return Promise.all([one('places', 'place'), one('buildings', 'building')])
    .then(([place, building]) => ({ place, building }));
}

// ---------- merge into the common format ----------

const json = (s) => { if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return null; } };
const humanize = (s) => (s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Overture taxonomy (top of the hierarchy) -> game category. Missing = not shown as a place:
// mostly offices and home businesses without a storefront.
const TOP = {
  food_and_drink: 'food', shopping: 'shop', lodging: 'lodging', health_care: 'health', education: 'education',
  arts_and_entertainment: 'culture', cultural_and_historic: 'culture', sports_and_recreation: 'leisure',
  community_and_government: 'civic', lifestyle_services: 'service', travel_and_transportation: 'transport',
};
const SKIP = new Set(['parking', 'shipping_or_delivery_service', 'public_utility', 'b2b_service', 'housing_or_property_service', 'sport_team', 'sport_league']);

function category(h) {
  if (h.includes('place_of_worship') || h.includes('religious_organization')) return 'worship';
  if (h.includes('bank_or_credit_union')) return 'money';
  if (h.includes('post_office')) return 'civic';
  if (h.includes('printing_service') || h.includes('laundry_service')) return 'service';
  if (h.some((k) => SKIP.has(k))) return null;
  return TOP[h[0]] || null;
}

const STOP = /\b(the|inc|llc|ltd|co|corp|restaurant|cafe|café)\b/g;
function norm(s) {
  const n = (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ'’`]/g, '').replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  const short = n.replace(STOP, ' ').replace(/\s+/g, ' ').trim();
  return short || n.trim();
}
const sameName = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function ringCentroid(r) {
  let x = 0, z = 0;
  for (const p of r) { x += p[0]; z += p[1]; }
  return [x / r.length, z / r.length];
}
function inRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const inShape = (x, z, o, holes) => inRing(x, z, o) && !(holes || []).some((h) => inRing(x, z, h));

// Coarse grid over tile units for "what is near this point".
class Grid {
  constructor(cell) { this.cell = cell; this.m = new Map(); }
  add(item, minX, minZ, maxX, maxZ) {
    const c = this.cell;
    for (let i = Math.floor(minX / c); i <= Math.floor(maxX / c); i++)
      for (let j = Math.floor(minZ / c); j <= Math.floor(maxZ / c); j++) {
        const k = `${i},${j}`;
        if (!this.m.has(k)) this.m.set(k, []);
        this.m.get(k).push(item);
      }
  }
  near(x, z, r) {
    const out = new Set(), c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++)
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++)
        for (const it of this.m.get(`${i},${j}`) || []) out.add(it);
    return out;
  }
}

const bboxOf = (r) => {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of r) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  return { minX, minZ, maxX, maxZ };
};

// Adds Overture data to a tile in the common format (tile units). z/y give the scale.
export function mergeOverture(d, ov, z, y) {
  if (!ov || (!ov.place && !ov.building)) return d;
  const n = 2 ** z;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
  const unitsPerM = d.extent / ((40075016.686 * Math.cos(lat)) / n);
  if (ov.building) mergeBuildings(d, ov.building, unitsPerM);
  if (ov.place) mergePlaces(d, ov.place, unitsPerM);
  return d;
}

function mergePlaces(d, layer, upm) {
  const s = d.extent / (layer.extent || 4096);
  const all = [];
  for (const f of layer.features) {
    if (f.type !== 1) continue;
    const p = f.props;
    const name = p['@name'] || json(p.names)?.primary;
    if (!name) continue;
    const [x, z] = f.geometry[0][0];
    all.push({ x: x * s, z: z * s, name, key: norm(name), p, conf: p.confidence || 0, status: p.operating_status || 'open' });
  }
  const grid = new Grid(MATCH_M * upm);
  for (const o of all) grid.add(o, o.x, o.z, o.x, o.z);

  // Match OSM places: fill in what OSM lacks, and drop those Overture only knows as closed.
  const matched = new Set();
  d.pois = d.pois.filter((poi) => {
    const key = norm(poi.n), r = MATCH_M * upm;
    const hits = [...grid.near(poi.x, poi.z, r)].filter((o) => Math.hypot(o.x - poi.x, o.z - poi.z) < r && sameName(o.key, key));
    if (!hits.length) return true;
    for (const o of hits) matched.add(o);
    const open = hits.filter((o) => o.status === 'open');
    if (!open.length && hits.some((o) => o.status === 'permanently_closed' && o.conf >= 0.5)) return false;
    enrich(poi, open.sort((a, b) => b.conf - a.conf)[0]);
    return true;
  });

  // New places, best first; skip a repeat of a name already added close by.
  const added = new Grid(DEDUPE_M * upm);
  const fresh = all.filter((o) => !matched.has(o) && o.status === 'open' && o.conf >= MIN_CONF).sort((a, b) => b.conf - a.conf);
  for (const o of fresh) {
    const h = json(o.p.taxonomy)?.hierarchy || (o.p.basic_category ? [o.p.basic_category] : []);
    const c = category(h);
    if (!c) continue;
    const r = DEDUPE_M * upm;
    if ([...added.near(o.x, o.z, r)].some((q) => sameName(q.key, o.key) && Math.hypot(q.x - o.x, q.z - o.z) < r)) continue;
    added.add(o, o.x, o.z, o.x, o.z);
    const tax = json(o.p.taxonomy);
    const poi = { id: `o${o.p.id || `${Math.round(o.x)}_${Math.round(o.z)}`}`, x: o.x, z: o.z, n: o.name, c, k: humanize(tax?.primary || o.p.basic_category) };
    enrich(poi, o);
    d.pois.push(poi);
  }
}

function enrich(poi, o) {
  if (!o) return;
  const p = o.p;
  if (!poi.ad) { const a = json(p.addresses)?.[0]; if (a?.freeform) poi.ad = a.freeform.replace(/\s+/g, ' ').trim(); }
  if (!poi.ph) { const ph = json(p.phones)?.[0]; if (ph) poi.ph = ph; }
  if (!poi.w) { const w = json(p.websites)?.[0]; if (w) poi.w = w; }
}

function mergeBuildings(d, layer, upm) {
  const s = d.extent / (layer.extent || 4096);
  const grid = new Grid(64);
  for (const b of d.buildings) {
    b._bb = bboxOf(b.o);
    b._c = ringCentroid(b.o);
    grid.add(b, b._bb.minX, b._bb.minZ, b._bb.maxX, b._bb.maxZ);
  }
  const minArea = MIN_AREA_M2 * upm * upm;
  for (const f of layer.features) {
    if (f.type !== 3) continue;
    const p = f.props;
    if (p.is_underground) continue;
    const osm = typeof p.sources === 'string' && p.sources.includes('"OpenStreetMap"');
    for (const poly of polygons(f.geometry)) {
      const o = s === 1 ? poly.outer : poly.outer.map(([x, z]) => [x * s, z * s]);
      const holes = s === 1 ? poly.holes : poly.holes.map((h) => h.map(([x, z]) => [x * s, z * s]));
      const c = ringCentroid(o), bb = bboxOf(o);
      let hit = null;
      for (const b of grid.near(c[0], c[1], Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ) / 2)) {
        if (inShape(c[0], c[1], b.o, b.i) || inShape(b._c[0], b._c[1], o, holes)) { hit = b; break; }
      }
      if (hit) {
        // Same building: OpenFreeMap tiles have no building types; Overture carries OSM's.
        if (osm || hit.t === 'yes') {
          if (hit.t === 'yes' && p.class) hit.t = p.class;
          if (!hit.l && p.num_floors > 0) hit.l = p.num_floors;
          if (!hit.h && p.height > 2.5 && !(p.min_height > 0)) hit.h = p.height;
          if (!hit.c && p.facade_color) hit.c = String(p.facade_color).toLowerCase();
        }
        continue;
      }
      if (osm || Math.abs(ringArea(o)) < minArea) continue;
      // A footprint OSM doesn't have (machine-traced or from other open sources).
      const b = { id: (Math.imul(Math.round(c[0] * 16) + 7, 73856093) ^ Math.imul(Math.round(c[1] * 16), 19349663)) >>> 0, o, t: p.class || 'yes' };
      if (holes.length) b.i = holes;
      if (p.height > 2.5) { b.h = p.height; b.l = p.num_floors > 0 ? p.num_floors : Math.max(1, Math.round(p.height / 3.2)); }
      else if (p.num_floors > 0) b.l = p.num_floors;
      b._bb = bb; b._c = c;
      grid.add(b, bb.minX, bb.minZ, bb.maxX, bb.maxZ);
      d.buildings.push(b);
    }
  }
  for (const b of d.buildings) { delete b._bb; delete b._c; }
}

// ---------- road signs (transportation theme) ----------

// Decoded road layers for a tile: { segment, connector } or null.
export function fetchOvertureRoads(z, x, y) {
  return withTimeout(archive('transportation').then((a) => a.tile(z, x, y)), TIMEOUT)
    .then((buf) => { if (!buf) return null; const L = decodeTile(buf); return L.segment ? L : null; })
    .catch(() => null);
}

// "I 80 Business East", "US 50", "CA 99", "A 1", "E40" -> { net, ref, mod, dir }.
const REF_RE = /^([A-Za-z]+)[\s-]*(\d+[A-Za-z]?)(?:\s+(Business|Bus\.?|Alternate|Alt\.?|Spur|Loop|Truck|Bypass))?(?:\s+(North|South|East|West)(?:bound)?)?$/i;
export function parseRef(s) {
  const m = REF_RE.exec(String(s).trim());
  if (!m) return { net: '', ref: String(s).trim() };
  return { net: m[1].toUpperCase(), ref: m[2], mod: m[3] ? m[3].replace(/\.$/, '') : undefined, dir: m[4] ? m[4][0].toUpperCase() + m[4].slice(1).toLowerCase() : undefined };
}
// A route from Overture's `routes` ({ ref, network }) as a shield.
function routeShield(r) {
  if (!r.ref) return null;
  const net = r.network || '';
  const us = /^US:(I|US|[A-Z]{2})(?::|$)/.exec(net);
  if (us) return { net: us[1], ref: String(r.ref).split(/[ ;]/).pop(), mod: /Business/.test(net) ? 'Business' : undefined };
  return parseRef(r.ref);
}

// Points along a polyline (tile units): position and direction at arc length s.
function along(pts, s) {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-9) continue;
    if (acc + l >= s || i === pts.length - 2) {
      const t = Math.max(0, Math.min(1, (s - acc) / l));
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / l, dz: (b[1] - a[1]) / l };
    }
    acc += l;
  }
  return null;
}
const lengthOf = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
function project(pts, x, z) {
  let best = Infinity, at = 0, acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz, l = Math.sqrt(l2);
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
    const d = Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
    if (d < best) { best = d; at = acc + l * t; }
    acc += l;
  }
  return { d: best, at };
}

const FAST_CLASS = new Set(['motorway', 'trunk']);
const SIGN_CLASS = new Set(['motorway', 'trunk', 'primary', 'secondary']);

// Guide signs before each signposted split (Overture `destinations`: the labels for going from
// a segment onto the next one) and route shields along freeways. Adds d.signs (tile units):
// { x, z, dx, dz (direction of travel), k: 'guide' | 'route', fast, panels: [{ shields, toward, text, turn }] }.
export function mergeSigns(d, L, z, y) {
  if (!L || !L.segment) return d;
  const s = d.extent / (L.segment.extent || 4096);
  const n = 2 ** z;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
  const upm = d.extent / ((40075016.686 * Math.cos(lat)) / n);
  const conns = new Map();
  for (const f of L.connector?.features || []) if (f.props.id && f.geometry[0]) conns.set(f.props.id, [f.geometry[0][0][0] * s, f.geometry[0][0][1] * s]);
  const segs = new Map();
  for (const f of L.segment.features) {
    if (f.type !== 2 || f.props.subtype === 'rail' || !f.props.id) continue;
    const parts = f.geometry.filter((p) => p.length > 1).map((p) => p.map(([px, pz]) => [px * s, pz * s]));
    if (!parts.length) continue;
    const pts = parts.reduce((a, b) => (lengthOf(b) > lengthOf(a) ? b : a));
    segs.set(f.props.id, { p: f.props, pts });
  }
  const signs = [];
  const groups = new Map();
  for (const [id, S] of segs) {
    const dests = S.p.destinations && json(S.p.destinations);
    if (!dests) continue;
    const cls = S.p.class, link = S.p.subclass === 'link';
    for (const e of dests) {
      const labels = e.labels || [];
      const shields = labels.filter((l) => l.type === 'route_ref').map((l) => parseRef(l.value));
      if (!(FAST_CLASS.has(cls) || (SIGN_CLASS.has(cls) && shields.length))) continue;
      const c = conns.get(e.from_connector_id);
      if (!c) continue;
      const fwd = e.when?.heading !== 'backward';
      const pts = fwd ? S.pts : S.pts.slice().reverse();
      const pr = project(pts, c[0], c[1]);
      if (pr.d > 20 * upm) continue;
      const back = (FAST_CLASS.has(cls) && !link ? 170 : 60) * upm;
      // Before the junction, but inside this tile (its neighbor doesn't know the junction).
      let sAt = Math.max(Math.min(pr.at - 10 * upm, 4 * upm), pr.at - back), at = along(pts, sAt);
      const inTile = (q) => q && q.x >= 0 && q.z >= 0 && q.x < d.extent && q.z < d.extent;
      while (at && !inTile(at) && sAt < pr.at - 5 * upm) { sAt += 10 * upm; at = along(pts, sAt); }
      if (!inTile(at)) continue;
      const there = along(pts, Math.max(0, pr.at - 1));
      if (!at || !there) continue;
      // Which way the destination leaves the junction, relative to the direction of travel.
      let turn = 0;
      const T = segs.get(e.to_segment_id);
      if (T) {
        const t0 = project(T.pts, c[0], c[1]), len = lengthOf(T.pts);
        const out = t0.at < len / 2 ? along(T.pts, Math.min(len, t0.at + 40 * upm)) : along(T.pts.slice().reverse(), Math.min(len, len - t0.at + 40 * upm));
        if (out) turn = Math.atan2(there.dx * (out.z - c[1]) - there.dz * (out.x - c[0]), there.dx * (out.x - c[0]) + there.dz * (out.z - c[1]));
      }
      const panel = {
        shields,
        toward: labels.filter((l) => l.type === 'toward_route_ref').map((l) => parseRef(l.value)),
        text: labels.filter((l) => l.type !== 'route_ref' && l.type !== 'toward_route_ref').map((l) => l.value).slice(0, 3),
        turn: Math.abs(turn) < 0.2 ? 0 : turn > 0 ? 1 : -1,  // +1 right (z south, x east: positive cross = right)
      };
      if (!panel.shields.length && !panel.text.length) continue;
      const key = `${e.from_connector_id}|${fwd}`;
      let g = groups.get(key);
      if (!g) {
        g = { x: at.x, z: at.z, dx: at.dx, dz: at.dz, k: 'guide', fast: FAST_CLASS.has(cls) && !link, panels: [] };
        groups.set(key, g);
        signs.push(g);
      }
      const sig = JSON.stringify([panel.shields, panel.text]);
      if (!g.panels.some((q) => JSON.stringify([q.shields, q.text]) === sig)) g.panels.push(panel);
    }
  }
  for (const g of signs) g.panels.sort((a, b) => a.turn - b.turn).splice(3);

  // Route shields along freeways, one per route and direction every 2 km or so.
  const seen = [];
  for (const [, S] of segs) {
    if (!FAST_CLASS.has(S.p.class) || S.p.subclass === 'link' || !S.p.routes) continue;
    const len = lengthOf(S.pts);
    if (len < 500 * upm) continue;
    const at = along(S.pts, 220 * upm);
    if (!at || at.x < 0 || at.z < 0 || at.x >= d.extent || at.z >= d.extent) continue;
    const shields = [];
    for (const r of json(S.p.routes) || []) {
      const sh = routeShield(r);
      if (!sh || shields.some((q) => q.net === sh.net && q.ref === sh.ref)) continue;
      // US routes are signed with a cardinal direction: even numbers run east-west.
      if (/^(I|US|[A-Z]{2})$/.test(sh.net) && /^US:/.test(r.network || '')) {
        const num = parseInt(sh.ref, 10);
        sh.dir = num % 2 === 0 ? (at.dx > 0 ? 'East' : 'West') : (at.dz > 0 ? 'South' : 'North');
      }
      shields.push(sh);
    }
    if (!shields.length) continue;
    const key = shields.map((q) => `${q.net}${q.ref}${q.dir || ''}`).join(',');
    if (seen.some((q) => q.key === key && Math.hypot(q.x - at.x, q.z - at.z) < 2000 * upm)) continue;
    seen.push({ key, x: at.x, z: at.z });
    signs.push({ x: at.x, z: at.z, dx: at.dx, dz: at.dz, k: 'route', fast: true, panels: [{ shields: shields.slice(0, 3), toward: [], text: [], turn: 0 }] });
  }
  d.signs = (d.signs || []).concat(signs);
  return d;
}
