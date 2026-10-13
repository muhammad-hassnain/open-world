// Loads map data for a z14 tile and converts it to the game's common format.
//
// Source 1 (everywhere): OpenFreeMap vector tiles (OpenMapTiles schema), fetched by the browser.
// Source 2 (selected tiles): detailed OpenStreetMap data pre-built by tools/build_detail.py
//                            into data/detail/<z>/<x>/<y>.json.
// Both produce the same structure in tile units (0..extent); toLocal() converts it to meters.
// Either is then enriched with Overture Maps places and buildings (overture.js).

import { decodeTile, polygons } from './mvt.js';
import { fetchOverture, mergeOverture, fetchOvertureRoads, mergeSigns } from './overture.js';

const TILEJSON = 'https://tiles.openfreemap.org/planet';

let tileTemplate = null;
function vectorTemplate() {
  tileTemplate ??= fetch(TILEJSON).then((r) => r.json()).then((j) => j.tiles[0]);
  return tileTemplate;
}

let detailIndex = null;
function detailTiles() {
  detailIndex ??= fetch('data/detail/index.json')
    .then((r) => (r.ok ? r.json() : { tiles: [] }))
    .catch(() => ({ tiles: [] }))
    .then((j) => new Set(j.tiles));
  return detailIndex;
}

export async function fetchTile(z, x, y) {
  const ov = fetchOverture(z, x, y);
  const d = await fetchBase(z, x, y);
  mergeOverture(d, await ov, z, y);
  // Guide signs from Overture's road data, only where there are major roads to sign.
  if (d.roads.some((r) => /^(motorway|trunk|primary)/.test(r.t))) mergeSigns(d, await fetchOvertureRoads(z, x, y), z, y);
  return d;
}

async function fetchBase(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if ((await detailTiles()).has(key)) {
    const res = await fetch(`data/detail/${key}.json`);
    if (res.ok) return { source: 'detail', ...(await res.json()) };
  }
  const url = (await vectorTemplate()).replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await fetch(url);
  if (res.status === 204 || res.status === 404) return { source: 'vector', ...emptyData() };
  if (!res.ok) throw new Error(`tile ${key}: HTTP ${res.status}`);
  return { source: 'vector', ...adaptVector(decodeTile(await res.arrayBuffer())) };
}

const emptyData = () => ({
  extent: 4096, buildings: [], roads: [], pois: [], places: [], areas: [], zones: [], lines: [], trees: [], props: [],
});

// Stable numeric id from a coordinate, for seeding per-object randomness.
const idFrom = (p, salt = 0) => (Math.imul(Math.round(p[0] * 16) + salt, 73856093) ^ Math.imul(Math.round(p[1] * 16), 19349663)) >>> 0;

// ---------- OpenMapTiles -> common format ----------

const ROAD_CLASS = {
  motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary',
  minor: 'residential', service: 'service', track: 'track', busway: 'service',
};
const PATH_SUBCLASS = new Set(['footway', 'cycleway', 'path', 'pedestrian', 'steps', 'bridleway']);

const POI_CATEGORY = {
  restaurant: 'food', fast_food: 'food', cafe: 'food', bar: 'food', beer: 'food', ice_cream: 'food', bakery: 'food',
  shop: 'shop', grocery: 'shop', alcohol_shop: 'shop', clothing_store: 'shop', music: 'shop', bicycle: 'shop',
  car: 'shop', laundry: 'service', florist: 'shop', furniture: 'shop', hardware: 'shop', jewelry: 'shop', mobile_phone: 'shop',
  bank: 'money', hospital: 'health', pharmacy: 'health', doctors: 'health', dentist: 'health', veterinary: 'health',
  school: 'education', college: 'education', library: 'education', kindergarten: 'education',
  place_of_worship: 'worship', cinema: 'culture', theatre: 'culture', art_gallery: 'culture', museum: 'culture',
  attraction: 'culture', castle: 'culture', monument: 'culture', town_hall: 'civic', post: 'civic', police: 'civic',
  fire_station: 'civic', railway: 'transport', fuel: 'transport', harbor: 'transport', ferry_terminal: 'transport',
  lodging: 'lodging', campsite: 'lodging', park: 'leisure', playground: 'leisure', stadium: 'leisure',
  swimming: 'leisure', golf: 'leisure', zoo: 'leisure', theme_park: 'leisure', sports: 'leisure', office: 'office',
};
const POI_SKIP = new Set(['bus', 'entrance', 'parking', 'bicycle_parking', 'toilets', 'drinking_water', 'atm',
  'information', 'aerialway', 'cemetery']);

const ZONES = new Set(['residential', 'commercial', 'retail', 'industrial', 'school', 'university', 'college',
  'kindergarten', 'hospital', 'library', 'railway', 'military', 'garages', 'quarry']);

const humanize = (s) => (s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function adaptVector(L) {
  const d = emptyData();
  d.extent = (L.building || L.transportation || {}).extent || 4096;

  for (const f of L.building?.features || []) {
    if (f.props.hide_3d) continue;
    const h = f.props.render_height, minH = f.props.render_min_height || 0;
    for (const poly of polygons(f.geometry)) {
      const b = { id: idFrom(poly.outer[0]), o: poly.outer, t: 'yes' };
      if (poly.holes.length) b.i = poly.holes;
      // 5 m is the tile generator's default for buildings without height data.
      if (h && h !== 5) { b.h = h; b.l = Math.max(1, Math.round(h / 3.66)); }
      if (minH > 0) b.mh = minH;
      const c = f.props.colour;
      if (typeof c === 'string' && c) b.c = c.toLowerCase();
      d.buildings.push(b);
    }
  }

  for (const f of L.transportation?.features || []) {
    const p = f.props;
    let t = ROAD_CLASS[p.class];
    if (p.class === 'path') t = PATH_SUBCLASS.has(p.subclass) ? p.subclass : null;
    if (!t) continue;
    if (p.ramp && ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(t)) t = `${t}_link`;
    if (f.type === 3) {
      if (t === 'pedestrian' || t === 'footway') for (const poly of polygons(f.geometry)) d.areas.push({ k: 'plaza', o: poly.outer, i: poly.holes });
      continue;
    }
    for (const part of f.geometry) {
      if (part.length < 2) continue;
      const pts = p.oneway === -1 ? part.slice().reverse() : part;
      const r = { id: idFrom(pts[0], pts.length), t, p: pts };
      if (p.oneway) r.ow = 1;
      if (p.service) r.sv = p.service;
      if (p.brunnel === 'tunnel') r.tu = 1;
      if (p.brunnel === 'bridge') r.br = 1;
      if (p.layer) r.ly = p.layer;
      d.roads.push(r);
    }
  }
  nameRoads(d.roads, L.transportation_name?.features || []);

  for (const f of L.poi?.features || []) {
    const p = f.props;
    if (!p.name || POI_SKIP.has(p.class) || f.type !== 1) continue;
    if (p.class === 'railway' && p.subclass !== 'station' && p.subclass !== 'halt') continue;
    const [x, z] = f.geometry[0][0];
    const c = POI_CATEGORY[p.class] || (p.subclass && POI_CATEGORY[p.subclass]) || 'shop';
    d.pois.push({ id: `v${idFrom([x, z])}`, x, z, n: p.name, c, k: humanize(p.subclass || p.class) });
  }

  for (const f of L.place?.features || []) {
    if (!f.props.name || f.type !== 1) continue;
    const [x, z] = f.geometry[0][0];
    d.places.push({ x, z, n: f.props.name, k: f.props.class });
  }

  const area = (k, f, extra = {}) => {
    for (const poly of polygons(f.geometry)) d.areas.push({ k, o: poly.outer, i: poly.holes, ...extra });
  };
  for (const f of L.landcover?.features || []) {
    const { class: c, subclass: s } = f.props;
    if (c === 'grass' || c === 'wetland') area('grass', f, s === 'park' || s === 'garden' ? { le: s } : {});
    else if (c === 'wood') area('wood', f);
    else if (c === 'farmland') area('farm', f);
    else if (c === 'sand') area('sand', f);
  }
  for (const f of L.landuse?.features || []) {
    const c = f.props.class;
    if (c === 'pitch' || c === 'playground' || c === 'track') area(c, f);
    else if (c === 'cemetery') area('grass', f);
    else if (ZONES.has(c)) for (const poly of polygons(f.geometry)) d.zones.push({ k: c, o: poly.outer, i: poly.holes });
  }
  for (const f of L.water?.features || []) if (f.type === 3 && f.props.brunnel !== 'tunnel') area('water', f);
  for (const f of L.waterway?.features || []) {
    if (f.props.brunnel === 'tunnel') continue;
    for (const part of f.geometry) d.lines.push({ k: f.props.class, p: part });
  }
  return d;
}

// Road names live in a separate layer; give each road part the name of a parallel
// name line running along it.
function nameRoads(roads, nameFeatures) {
  const cell = 64, grid = new Map();
  const key = (i, j) => `${i},${j}`;
  for (const f of nameFeatures) {
    if (!f.props.name) continue;
    for (const part of f.geometry) {
      for (let i = 0; i < part.length - 1; i++) {
        const a = part[i], b = part[i + 1];
        const seg = { ax: a[0], az: a[1], bx: b[0], bz: b[1], name: f.props.name };
        for (let gx = Math.floor(Math.min(a[0], b[0]) / cell); gx <= Math.floor(Math.max(a[0], b[0]) / cell); gx++) {
          for (let gz = Math.floor(Math.min(a[1], b[1]) / cell); gz <= Math.floor(Math.max(a[1], b[1]) / cell); gz++) {
            const k = key(gx, gz);
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(seg);
          }
        }
      }
    }
  }
  for (const r of roads) {
    if (!['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service'].some((t) => r.t.startsWith(t)) && r.t !== 'pedestrian') continue;
    // Use the midpoint of the longest segment.
    let best = 0, bi = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const l = Math.hypot(r.p[i + 1][0] - r.p[i][0], r.p[i + 1][1] - r.p[i][1]);
      if (l > best) { best = l; bi = i; }
    }
    if (best < 1e-6) continue;
    const a = r.p[bi], b = r.p[bi + 1];
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, tx = (b[0] - a[0]) / best, tz = (b[1] - a[1]) / best;
    let found = null, fd = 8;
    for (const s of grid.get(key(Math.floor(mx / cell), Math.floor(mz / cell))) || []) {
      const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((mx - s.ax) * dx + (mz - s.az) * dz) / l2));
      const dist = Math.hypot(s.ax + dx * t - mx, s.az + dz * t - mz);
      const par = Math.abs((dx * tx + dz * tz) / Math.sqrt(l2));
      if (dist < fd && par > 0.7) { fd = dist; found = s.name; }
    }
    if (found) r.n = found;
  }
}

// ---------- tile units -> local meters ----------

export function toLocal(d, project) {
  const pt = (p) => project(p[0], p[1]);
  const ring = (r) => r.map(pt);
  const conv = (o) => { const [x, z] = project(o.x, o.z); return { ...o, x, z }; };
  return {
    source: d.source,
    buildings: d.buildings.map((b) => ({ ...b, o: ring(b.o), i: b.i ? b.i.map(ring) : undefined })),
    roads: d.roads.map((r) => ({ ...r, p: ring(r.p) })),
    pois: d.pois.map(conv),
    places: (d.places || []).map(conv),
    areas: d.areas.map((a) => ({ ...a, o: ring(a.o), i: a.i && a.i.length ? a.i.map(ring) : undefined })),
    zones: (d.zones || []).map((a) => ({ ...a, o: ring(a.o), i: a.i && a.i.length ? a.i.map(ring) : undefined })),
    lines: d.lines.map((l) => ({ ...l, p: ring(l.p) })),
    trees: d.trees.map((t) => { const [x, z] = project(t[0], t[1]); return [x, z, t[2], t[3]]; }),
    props: d.props.map(conv),
    signs: (d.signs || []).map(conv),
  };
}
