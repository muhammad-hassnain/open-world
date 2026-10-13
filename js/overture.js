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
