import * as THREE from 'three';
import { clamp, closestOnSeg, pointInShape, hash01, SpatialHash } from './util.js';

export const CATS = {
  food: { label: 'Food & drink', color: '#e67e22' },
  shop: { label: 'Shop', color: '#8e44ad' },
  money: { label: 'Bank', color: '#27ae60' },
  health: { label: 'Health', color: '#e74c3c' },
  education: { label: 'Education', color: '#2980b9' },
  worship: { label: 'Place of worship', color: '#7f8c8d' },
  culture: { label: 'Arts & culture', color: '#d35490' },
  civic: { label: 'Civic', color: '#34495e' },
  transport: { label: 'Transport', color: '#16a085' },
  lodging: { label: 'Lodging', color: '#c0392b' },
  leisure: { label: 'Park & leisure', color: '#3f9b4b' },
  office: { label: 'Office', color: '#5d6d7e' },
  service: { label: 'Service', color: '#a0522d' },
  building: { label: 'Building', color: '#6b7a8f' },
};

const MODES = ['tags', 'signs', 'off'];
const SIGN_STYLES = [
  null, // category color
  { bg: '#f5efe0', fg: '#2b2b2b' },
  { bg: '#1f2a36', fg: '#f2d16b' },
  { bg: '#7a1f1f', fg: '#fff8ee' },
  { bg: '#24543f', fg: '#f6f1e3' },
];
const yawZ = (nx, nz) => Math.atan2(nx, nz);   // maps local +Z to (nx, nz)
const yawX = (dx, dz) => Math.atan2(-dz, dx);  // maps local +X to (dx, dz)

function measure(text, font) {
  const ctx = measure.ctx || (measure.ctx = document.createElement('canvas').getContext('2d'));
  ctx.font = font;
  return ctx.measureText(text).width;
}

function signTexture(text, bg, fg, { sub = null, border = null, h = 128 } = {}) {
  const font = `600 ${Math.round(h * 0.42)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const subFont = `500 ${Math.round(h * 0.2)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const tw = Math.max(measure(text, font), sub ? measure(sub, subFont) : 0);
  const w = Math.ceil(Math.min(2048, tw + h * 0.6));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = h * 0.05;
    ctx.strokeRect(h * 0.06, h * 0.06, w - h * 0.12, h - h * 0.12);
  }
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxW = w - h * 0.4;
  ctx.font = font;
  if (sub) {
    ctx.fillText(text, w / 2, h * 0.42, maxW);
    ctx.font = subFont;
    ctx.globalAlpha = 0.8;
    ctx.fillText(sub, w / 2, h * 0.76, maxW);
  } else {
    ctx.fillText(text, w / 2, h * 0.53, maxW);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, aspect: w / h };
}

export class Labels {
  constructor(world, scene, camera, layer) {
    this.world = world;
    this.scene = scene;
    this.camera = camera;
    this.layer = layer;
    this.items = [];
    this.hash = new SpatialHash(30);
    this.streetSigns = [];
    this.streetHash = new SpatialHash(30);
    this.signs = new Map();
    this.tags = new Map();
    this.occluded = new Map();
    this.mode = 'tags';
    this._t = 0;
    this._occT = 0;
    this._v = new THREE.Vector3();
    this.signFrame = new THREE.MeshLambertMaterial({ color: '#3b3f45' });
    this.postMat = new THREE.MeshLambertMaterial({ color: '#5b5f66' });
    this.woodMat = new THREE.MeshLambertMaterial({ color: '#6b4f2a' });
    try { const m = localStorage.getItem('ow.labels'); if (MODES.includes(m)) this.mode = m; } catch { /* storage unavailable */ }
  }

  // ---------- placement ----------

  build() {
    const w = this.world;
    const covered = new Set();
    for (const p of w.pois) {
      if (p.c === 'place' || !w.inCore(p.x, p.z, -10)) continue;
      const item = { id: p.id, name: p.n, cat: CATS[p.c] ? p.c : 'service', kind: p.k, poi: p, building: p.building || null };
      this._place(item);
      if (item.building) covered.add(item.building);
      this.items.push(item);
    }
    for (const b of w.buildings) {
      if (!b.name || covered.has(b) || !w.inCore(b.cx, b.cz, -10)) continue;
      const cat = b.style === 'civic' ? (b.type === 'university' || b.type === 'school' ? 'education' : 'civic')
        : b.style === 'church' ? 'worship' : 'building';
      const item = { id: `b${b.id}`, name: b.name, cat, kind: (b.type === 'yes' ? 'Building' : b.type.charAt(0).toUpperCase() + b.type.slice(1).replace(/_/g, ' ')), building: b, poi: { x: b.cx, z: b.cz } };
      this._place(item);
      this.items.push(item);
    }
    this._spread();
    for (const it of this.items) this.hash.insert(it, it.x, it.z, it.x, it.z);
    this._buildStreetSigns();
  }

  _place(item) {
    const w = this.world;
    const p = item.poi;
    const b = item.building;
    item.width = clamp((measure(item.name, '600 54px system-ui') + 70) / 213, 1.3, 5.5);
    if (b && b.edges && b.edges.length) {
      let best = null, bestScore = -Infinity;
      for (const e of b.edges) {
        if (e.len < 1.5) continue;
        const q = closestOnSeg(p.x, p.z, e.ax, e.az, e.bx, e.bz);
        const score = (e.street ? 2 : 0) + e.facing - q.d / 12;
        if (score > bestScore) { bestScore = score; best = { e, t: q.t * e.len }; }
      }
      if (best) {
        const { e } = best;
        item.edge = e;
        item.t = clamp(best.t, Math.min(e.len / 2, item.width / 2 + 0.3), Math.max(e.len / 2, e.len - item.width / 2 - 0.3));
        item.width = Math.min(item.width, e.len - 0.4);
        item.nx = e.nx; item.nz = e.nz;
        if (b.style === 'shopfront' || b.style === 'civic') {
          item.signKind = 'wall';
          item.y = b.style === 'shopfront' ? Math.min(b.groundH - 0.6, b.h - 0.6) : Math.min(3.4, b.h - 0.7);
        } else {
          item.signKind = 'lawn';
          const yard = e.road ? e.roadDist - e.road.hw - 3.5 : 3;
          item.off = clamp(yard * 0.5, 1.0, 4);
        }
        this._applyEdgePos(item);
        return;
      }
    }
    // Free-standing: parks get a sign at their edge closest to a street.
    let x = p.x, z = p.z;
    const area = item.cat === 'leisure' ? w.areas.find((a) => a.n === item.name) : null;
    const rd = w.nearestRoad(x, z, 300);
    if (area && rd) {
      const dx = rd.x - x, dz = rd.z - z, L = Math.hypot(dx, dz) || 1;
      let lx = x, lz = z;
      for (let s = 0; s < L; s += 1) {
        const sx = x + dx / L * s, sz = z + dz / L * s;
        if (!pointInShape(sx, sz, area.o, area.i)) break;
        lx = sx; lz = sz;
      }
      x = lx - dx / L * 1.5; z = lz - dz / L * 1.5;
    }
    item.signKind = 'post';
    item.x = x; item.z = z;
    const face = w.nearestRoad(x, z, 120);
    const fx = face ? face.x - x : 0, fz = face ? face.z - z : 1, fl = Math.hypot(fx, fz) || 1;
    item.nx = fx / fl; item.nz = fz / fl;
    item.tagY = 2.6;
  }

  _applyEdgePos(item) {
    const e = item.edge;
    const ex = e.ax + e.dx * item.t, ez = e.az + e.dz * item.t;
    if (item.signKind === 'wall') {
      item.x = ex + e.nx * 0.08; item.z = ez + e.nz * 0.08;
      item.tagY = item.y + 0.9;
    } else {
      item.x = ex + e.nx * item.off; item.z = ez + e.nz * item.off;
      item.tagY = 2.3;
    }
  }

  // Keep wall signs on the same wall from overlapping.
  _spread() {
    const byEdge = new Map();
    for (const it of this.items) {
      if (it.signKind !== 'wall') continue;
      if (!byEdge.has(it.edge)) byEdge.set(it.edge, []);
      byEdge.get(it.edge).push(it);
    }
    for (const [e, list] of byEdge) {
      list.sort((a, b) => a.t - b.t);
      let row = 0, cursor = -Infinity;
      for (const it of list) {
        let t = Math.max(it.t, cursor + it.width / 2 + 0.25);
        if (t + it.width / 2 > e.len - 0.2) { row++; t = it.t; cursor = -Infinity; }
        it.t = t;
        it.y += row * 0.8;
        cursor = t + it.width / 2;
        this._applyEdgePos(it);
      }
    }
  }

  _buildStreetSigns() {
    const w = this.world;
    for (const j of w.junctions) {
      const named = [];
      for (const a of j.carArms) {
        if (!a.road.n || named.some((n) => n.name === a.road.n)) continue;
        const pts = a.road.p;
        const nb = pts[a.vi + 1] || pts[a.vi - 1];
        const dx = nb[0] - j.x, dz = nb[1] - j.z, l = Math.hypot(dx, dz) || 1;
        named.push({ name: a.road.n, dx: dx / l, dz: dz / l, hw: a.road.hw });
      }
      if (named.length < 2 || !w.inCore(j.x, j.z, 5)) continue;
      const [r1, r2] = named;
      const sin = Math.abs(r1.dx * r2.dz - r1.dz * r2.dx);
      if (sin < 0.4) continue;
      const a = (r2.hw + 0.9) / sin, b = (r1.hw + 0.9) / sin;
      const x = j.x + r1.dx * a + r2.dx * b, z = j.z + r1.dz * a + r2.dz * b;
      const s = { id: `j${Math.round(j.x)}_${Math.round(j.z)}`, x, z, roads: [r1, r2] };
      this.streetSigns.push(s);
      this.streetHash.insert(s, x, z, x, z);
    }
  }

  // ---------- mode ----------

  setMode(mode) {
    if (!MODES.includes(mode) || mode === this.mode) return;
    this.mode = mode;
    try { localStorage.setItem('ow.labels', mode); } catch { /* storage unavailable */ }
    if (mode !== 'signs') for (const id of [...this.signs.keys()]) this._disposeSign(id);
    if (mode !== 'tags') for (const el of this.tags.values()) el.style.display = 'none';
    this._t = 0;
    if (this.onChange) this.onChange(mode);
  }

  cycle() {
    this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
    return this.mode;
  }

  // ---------- 3D signs ----------

  _makeSign(it) {
    const g = new THREE.Group();
    const textures = [];
    const cat = CATS[it.cat] || CATS.service;
    const style = SIGN_STYLES[Math.floor(hash01(it.name.length * 31 + it.name.charCodeAt(0)) * SIGN_STYLES.length)];
    if (it.signKind === 'wall') {
      const civic = it.building && it.building.style === 'civic';
      const bg = civic ? '#e8e2d4' : style ? style.bg : cat.color;
      const fg = civic ? '#33393f' : style ? style.fg : '#ffffff';
      const { tex } = signTexture(it.name, bg, fg);
      textures.push(tex);
      const face = new THREE.MeshLambertMaterial({ map: tex });
      const h = 0.6;
      const m = new THREE.Mesh(new THREE.BoxGeometry(it.width, h, 0.08), [this.signFrame, this.signFrame, this.signFrame, this.signFrame, face, this.signFrame]);
      m.position.set(it.x, it.y, it.z);
      m.rotation.y = yawZ(it.nx, it.nz);
      m.castShadow = true;
      g.add(m);
    } else {
      const park = it.cat === 'leisure';
      const { tex } = signTexture(it.name, park ? '#5b4423' : '#f7f4ec', park ? '#f3e7c4' : '#2d3238', { sub: park ? null : it.kind, border: park ? '#d8c690' : cat.color });
      textures.push(tex);
      const face = new THREE.MeshLambertMaterial({ map: tex });
      const wdt = Math.min(it.width, park ? 4 : 2.2), h = park ? 0.75 : 0.62;
      const y0 = park ? 0.9 : 0.5;
      const yGround = this.world.groundAt(it.x, it.z);
      const board = new THREE.Mesh(new THREE.BoxGeometry(wdt, h, 0.08), [this.signFrame, this.signFrame, this.signFrame, this.signFrame, face, face]);
      board.position.set(0, yGround + y0 + h / 2, 0);
      board.castShadow = true;
      g.add(board);
      for (const sx of [-wdt / 2 + 0.12, wdt / 2 - 0.12]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, y0 + h + 0.05, 0.08), park ? this.woodMat : this.postMat);
        post.position.set(sx, yGround + (y0 + h) / 2, -0.05);
        post.castShadow = true;
        g.add(post);
      }
      g.position.set(it.x, 0, it.z);
      g.rotation.y = yawZ(it.nx, it.nz);
    }
    this.scene.add(g);
    this.signs.set(it.id, { group: g, textures });
  }

  _makeStreetSign(s) {
    const g = new THREE.Group();
    const textures = [];
    const y0 = this.world.groundAt(s.x, s.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 3.2, 6), this.postMat);
    pole.position.set(0, y0 + 1.6, 0);
    pole.castShadow = true;
    g.add(pole);
    s.roads.forEach((r, i) => {
      const { tex } = signTexture(r.name, '#1e6b45', '#ffffff', { border: '#ffffff', h: 96 });
      textures.push(tex);
      const face = new THREE.MeshLambertMaterial({ map: tex });
      const edge = new THREE.MeshLambertMaterial({ color: '#1e6b45' });
      const blade = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.26, 0.025), [edge, edge, edge, edge, face, face]);
      blade.position.set(0, y0 + 3.0 - i * 0.3, 0);
      blade.rotation.y = yawX(r.dx, r.dz);
      blade.castShadow = true;
      g.add(blade);
    });
    g.position.set(s.x, 0, s.z);
    this.scene.add(g);
    this.signs.set(s.id, { group: g, textures });
  }

  _disposeSign(id) {
    const s = this.signs.get(id);
    if (!s) return;
    this.scene.remove(s.group);
    s.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      for (const m of [].concat(o.material)) if (m !== this.signFrame && m !== this.postMat && m !== this.woodMat) m.dispose();
    });
    for (const t of s.textures) t.dispose();
    this.signs.delete(id);
  }

  _updateSigns(px, pz) {
    const keep = new Set();
    for (const it of this.hash.near(px, pz, 120)) {
      if (Math.hypot(it.x - px, it.z - pz) > 120) continue;
      keep.add(it.id);
      if (!this.signs.has(it.id)) this._makeSign(it);
    }
    for (const s of this.streetHash.near(px, pz, 120)) {
      if (Math.hypot(s.x - px, s.z - pz) > 120) continue;
      keep.add(s.id);
      if (!this.signs.has(s.id)) this._makeStreetSign(s);
    }
    for (const id of [...this.signs.keys()]) if (!keep.has(id)) this._disposeSign(id);
  }

  // ---------- floating tags ----------

  _tagEl(key, html, cls) {
    let el = this.tags.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = `tag ${cls}`;
      el.innerHTML = html;
      el.style.display = 'none';
      this.layer.appendChild(el);
      el._w = 0;
      this.tags.set(key, el);
    }
    return el;
  }

  _occludedAt(ax, ay, az) {
    const c = this.camera.position;
    const dx = ax - c.x, dy = ay - c.y, dz = az - c.z;
    const L = Math.hypot(dx, dz);
    for (let s = 1; s < L - 1.5; s += 1.5) {
      const f = s / L;
      if (this.world.heightAt(c.x + dx * f, c.z + dz * f) > c.y + dy * f) return true;
    }
    return false;
  }

  _updateTags(px, pz, dt) {
    const W = window.innerWidth, H = window.innerHeight;
    const cands = [];
    for (const it of this.hash.near(px, pz, 90)) {
      const d = Math.hypot(it.x - px, it.z - pz);
      if (d < 90) cands.push({ key: it.id, it, d, x: it.x, y: it.tagY, z: it.z });
    }
    // Street names: one tag per street at its closest point.
    const seen = new Set();
    for (const r of this.world.carRoads) {
      if (!r.n || seen.has(r.n)) continue;
      if (px < r.bbox.minX - 45 || px > r.bbox.maxX + 45 || pz < r.bbox.minZ - 45 || pz > r.bbox.maxZ + 45) continue;
      let best = null;
      for (const rr of this.world.carRoads) {
        if (rr.n !== r.n) continue;
        for (let i = 0; i < rr.p.length - 1; i++) {
          const q = closestOnSeg(px, pz, rr.p[i][0], rr.p[i][1], rr.p[i + 1][0], rr.p[i + 1][1]);
          if (!best || q.d < best.d) best = q;
        }
      }
      seen.add(r.n);
      if (best && best.d < 45) cands.push({ key: `s:${r.n}`, street: r.n, d: best.d, x: best.x, y: 3.2, z: best.z });
    }
    cands.sort((a, b) => a.d - b.d);

    this._occT -= dt;
    const recheck = this._occT <= 0;
    if (recheck) this._occT = 0.2;

    const placed = [];
    const shown = new Set();
    for (const c of cands.slice(0, 40)) {
      if (recheck) this.occluded.set(c.key, !c.street && this._occludedAt(c.x, c.y, c.z));
      if (this.occluded.get(c.key)) continue;
      this._v.set(c.x, c.y, c.z).project(this.camera);
      if (this._v.z > 1 || this._v.z < -1) continue;
      const sx = (this._v.x * 0.5 + 0.5) * W, sy = (-this._v.y * 0.5 + 0.5) * H;
      if (sx < -100 || sx > W + 100 || sy < -50 || sy > H + 50) continue;
      const el = c.street
        ? this._tagEl(c.key, `<span class="st">${escapeHtml(c.street)}</span>`, 'street')
        : this._tagEl(c.key, `<span class="dot" style="background:${(CATS[c.it.cat] || CATS.service).color}"></span><b>${escapeHtml(c.it.name)}</b><small>${escapeHtml(c.it.kind || '')}</small>`, 'poi');
      if (!el._w) { el.style.display = 'flex'; el._w = el.offsetWidth; el._h = el.offsetHeight; }
      const rect = { x0: sx - el._w / 2, x1: sx + el._w / 2, y0: sy - el._h, y1: sy };
      if (placed.some((p) => rect.x0 < p.x1 && rect.x1 > p.x0 && rect.y0 < p.y1 && rect.y1 > p.y0)) continue;
      placed.push(rect);
      shown.add(c.key);
      const near = clamp(1 - (c.d - 25) / 65, 0, 1);
      el.style.display = 'flex';
      el.style.opacity = (0.35 + 0.65 * near).toFixed(2);
      el.style.transform = `translate(${(sx - el._w / 2).toFixed(1)}px, ${(sy - el._h).toFixed(1)}px) scale(${(0.8 + 0.2 * near).toFixed(2)})`;
      el.classList.toggle('close', c.d < 25);
    }
    for (const [key, el] of this.tags) if (!shown.has(key)) el.style.display = 'none';
  }

  // ---------- per frame ----------

  update(dt, px, pz) {
    if (this.mode === 'tags') this._updateTags(px, pz, dt);
    this._t -= dt;
    if (this._t <= 0) {
      this._t = 0.3;
      if (this.mode === 'signs') this._updateSigns(px, pz);
    }
  }

  // Closest place to the player, for the info card.
  nearest(px, pz, maxD = 9) {
    let best = null, bd = maxD;
    for (const it of this.hash.near(px, pz, maxD)) {
      const d = Math.hypot(it.x - px, it.z - pz);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
