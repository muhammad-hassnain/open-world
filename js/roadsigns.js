// Guide signs over and beside major roads, and route shields along freeways, from the sign
// data in each chunk (overture.js mergeSigns). Built only near the player: each panel is a
// canvas texture.
//
// Guide signs on freeways hang from a gantry across the carriageway, 5.4 m up; elsewhere they
// stand on two posts at the right. The panel for the way that turns off sits on the side it
// turns to, with an arrow; route shields carry their cardinal direction where that's signed.

import * as THREE from 'three';
import { deckY } from './bridges.js';

const BUILD_R = 520, DROP_R = 700;
const PX = 100;  // canvas pixels per meter
const FONT = '"Overpass", "Roboto Condensed", system-ui, sans-serif';

// Sign colors: most of the world uses green guide signs; European motorways use blue.
function panelColor(lat, lon, fast) {
  const europe = lat > 34 && lat < 72 && lon > -25 && lon < 45;
  return europe && fast ? '#1d4f9c' : '#0b6b3a';
}

// ---------- shields ----------

function shieldPath(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.moveTo(x, y + h * 0.1);
  ctx.quadraticCurveTo(x + w * 0.25, y + h * 0.16, x + w / 2, y);
  ctx.quadraticCurveTo(x + w * 0.75, y + h * 0.16, x + w, y + h * 0.1);
  ctx.bezierCurveTo(x + w, y + h * 0.65, x + w * 0.8, y + h * 0.85, x + w / 2, y + h);
  ctx.bezierCurveTo(x + w * 0.2, y + h * 0.85, x, y + h * 0.65, x, y + h * 0.1);
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function fitText(ctx, text, x, y, maxW, px, weight = 800) {
  let size = px;
  ctx.font = `${weight} ${size}px ${FONT}`;
  while (size > 8 && ctx.measureText(text).width > maxW) { size -= 2; ctx.font = `${weight} ${size}px ${FONT}`; }
  ctx.fillText(text, x, y);
}

// Width (px) of a shield of height h.
function shieldWidth(sh, h) {
  const digits = String(sh.ref).length;
  if (sh.net === 'I' || sh.net === 'US') return h * (digits >= 3 ? 1.2 : 1.0);
  if (/^[A-Z]{2}$/.test(sh.net) && sh.net !== 'US') return h * (digits >= 3 ? 1.25 : 1.0);
  return h * (0.55 + 0.32 * (String(sh.net).length + digits));
}

function drawShield(ctx, sh, x, y, h, europe) {
  const w = shieldWidth(sh, h);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const num = String(sh.ref);
  if (sh.net === 'I') {
    const biz = !!sh.mod;
    ctx.fillStyle = '#fff'; shieldPath(ctx, x, y, w, h); ctx.fill();
    ctx.save(); shieldPath(ctx, x + h * 0.05, y + h * 0.05, w - h * 0.1, h - h * 0.1); ctx.clip();
    ctx.fillStyle = biz ? '#1d7a3e' : '#1c4fa0'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = biz ? '#1d7a3e' : '#c8202f'; ctx.fillRect(x, y, w, h * 0.3);
    ctx.restore();
    ctx.fillStyle = '#fff';
    fitText(ctx, biz ? 'BUSINESS' : 'INTERSTATE', x + w / 2, y + h * 0.19, w * 0.7, h * 0.12);
    fitText(ctx, num, x + w / 2, y + h * 0.6, w * 0.8, h * 0.5);
  } else if (sh.net === 'US') {
    ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#fff'; shieldPath(ctx, x + h * 0.06, y + h * 0.06, w - h * 0.12, h - h * 0.12); ctx.fill();
    ctx.fillStyle = '#000'; fitText(ctx, num, x + w / 2, y + h * 0.5, w * 0.72, h * 0.5);
  } else if (sh.net === 'CA') {
    ctx.fillStyle = '#fff'; shieldPath(ctx, x, y, w, h); ctx.fill();
    ctx.fillStyle = '#1d7a3e'; shieldPath(ctx, x + h * 0.05, y + h * 0.05, w - h * 0.1, h - h * 0.1); ctx.fill();
    ctx.fillStyle = '#fff'; fitText(ctx, num, x + w / 2, y + h * 0.55, w * 0.72, h * 0.5);
  } else if (/^[A-Z]{2}$/.test(sh.net)) {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = h * 0.06;
    ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2 - h * 0.04, h / 2 - h * 0.04, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#000'; fitText(ctx, num, x + w / 2, y + h * 0.53, w * 0.72, h * 0.48);
  } else {
    // Europe and elsewhere: a plate. E-roads green, motorways blue, others white.
    const label = `${sh.net}${sh.net && /^[A-Z]$/.test(sh.net) ? '' : ' '}${num}`.trim();
    const e = sh.net === 'E', m = europe && (sh.net === 'A' || sh.net === 'M');
    ctx.fillStyle = e ? '#1d7a3e' : m ? '#1d4f9c' : '#fff';
    roundRect(ctx, x, y + h * 0.18, w, h * 0.64, h * 0.08); ctx.fill();
    ctx.strokeStyle = e || m ? '#fff' : '#000'; ctx.lineWidth = h * 0.04; ctx.stroke();
    ctx.fillStyle = e || m ? '#fff' : '#000';
    fitText(ctx, label, x + w / 2, y + h * 0.52, w * 0.86, h * 0.42);
  }
  return w;
}

function arrow(ctx, x, y, size, turn, down) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(down ? Math.PI : turn * Math.PI / 4);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(0, -size / 2); ctx.lineTo(size * 0.38, -size * 0.05); ctx.lineTo(size * 0.13, -size * 0.05);
  ctx.lineTo(size * 0.13, size / 2); ctx.lineTo(-size * 0.13, size / 2); ctx.lineTo(-size * 0.13, -size * 0.05);
  ctx.lineTo(-size * 0.38, -size * 0.05); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// A guide panel as a canvas: shields (with directions) on top, destinations, arrow.
function panelCanvas(p, color, { europe, overhead, route }) {
  const m = (v) => Math.round(v * PX);
  const SH = route ? m(1.0) : m(1.15), DIR = m(0.38), LINE = m(0.62), PAD = m(0.34), GAP = m(0.22);
  const meas = document.createElement('canvas').getContext('2d');
  const textW = (t, px) => { meas.font = `700 ${px}px ${FONT}`; return meas.measureText(t).width; };
  // Row widths.
  const shields = p.shields.map((sh) => ({ sh, w: shieldWidth(sh, SH) }));
  const toward = p.toward.map((sh) => ({ sh, w: shieldWidth(sh, SH * 0.7) }));
  const shieldRow = shields.reduce((s, q) => s + q.w + GAP, 0) + (toward.length ? textW('TO', LINE * 0.7) + GAP + toward.reduce((s, q) => s + q.w + GAP, 0) : 0);
  const textRow = Math.max(0, ...p.text.map((t) => textW(t, LINE)));
  const hasDir = shields.some((q) => q.sh.dir);
  const arrowW = overhead || p.turn ? m(1.0) : 0;
  const W = Math.max(m(route ? 1.2 : 3.2), Math.max(shieldRow, textRow + (p.turn && !overhead ? arrowW + GAP : 0)) + PAD * 2);
  const H = PAD * 2 + (shields.length || toward.length ? SH + (hasDir ? DIR + m(0.06) : 0) + GAP : 0)
    + p.text.length * LINE * 1.12 + (overhead && !route ? arrowW + GAP : 0);
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(W); cv.height = Math.ceil(H);
  const ctx = cv.getContext('2d');
  if (route) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
  else {
    ctx.fillStyle = color; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = m(0.05); roundRect(ctx, m(0.07), m(0.07), W - m(0.14), H - m(0.14), m(0.12)); ctx.stroke();
  }
  let y = PAD;
  if (shields.length || toward.length) {
    let x = (W - shieldRow + GAP) / 2;
    for (const q of shields) {
      if (q.sh.dir) {
        ctx.fillStyle = route ? '#000' : '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        fitText(ctx, q.sh.dir.toUpperCase(), x + q.w / 2, y, q.w * 1.3, DIR, 800);
      }
      drawShield(ctx, q.sh, x, y + (hasDir ? DIR + m(0.06) : 0), SH, europe);
      x += q.w + GAP;
    }
    if (toward.length) {
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.font = `800 ${LINE * 0.7}px ${FONT}`;
      const ty = y + (hasDir ? DIR + m(0.06) : 0) + SH / 2;
      ctx.fillText('TO', x, ty);
      x += textW('TO', LINE * 0.7) + GAP;
      for (const q of toward) { drawShield(ctx, q.sh, x, ty - SH * 0.35, SH * 0.7, europe); x += q.w + GAP; }
    }
    y += SH + (hasDir ? DIR + m(0.06) : 0) + GAP;
  }
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
  const side = p.turn && !overhead;
  for (const t of p.text) {
    ctx.textAlign = 'center';
    const cx = side ? (p.turn > 0 ? (W - arrowW - GAP) / 2 : (W + arrowW + GAP) / 2) : W / 2;
    fitText(ctx, t, cx, y, W - PAD * 2 - (side ? arrowW + GAP : 0), LINE, 700);
    y += LINE * 1.12;
  }
  if (side) arrow(ctx, p.turn > 0 ? W - PAD - arrowW / 2 : PAD + arrowW / 2, H / 2, arrowW, p.turn, false);
  else if (overhead && !route) {
    if (p.turn) arrow(ctx, p.turn > 0 ? W - PAD - arrowW / 2 : PAD + arrowW / 2, y + arrowW / 2, arrowW, p.turn, false);
    else arrow(ctx, W / 2, y + arrowW / 2, arrowW, 0, true);
  }
  return { cv, w: W / PX, h: H / PX };
}

// ---------- 3D ----------

export class RoadSigns {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.items = new Map();  // chunk key -> signs
    this.built = new Map();  // sign id -> { group, textures, materials }
    this.metal = new THREE.MeshStandardMaterial({ color: '#8d9298', metalness: 0.6, roughness: 0.45 });
    this.back = new THREE.MeshStandardMaterial({ color: '#7b8087', metalness: 0.5, roughness: 0.6 });
    this.metal.userData.shared = this.back.userData.shared = true;
    this._t = 0;
  }

  addChunk(ci) {
    if (!ci.signs || !ci.signs.length) return;
    this.items.set(ci.key, ci.signs.map((s, i) => ({ ...s, id: `${ci.key}#${i}` })));
  }

  removeChunk(key) {
    for (const s of this.items.get(key) || []) this._dispose(s.id);
    this.items.delete(key);
  }

  clear() { for (const key of [...this.items.keys()]) this.removeChunk(key); }

  update(dt, x, z) {
    this._t -= dt;
    if (this._t > 0) return;
    this._t = 0.5;
    for (const list of this.items.values()) {
      for (const s of list) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < BUILD_R && !this.built.has(s.id)) this._build(s);
        else if (d > DROP_R && this.built.has(s.id)) this._dispose(s.id);
      }
    }
  }

  _dispose(id) {
    const b = this.built.get(id);
    if (!b) return;
    this.scene.remove(b.group);
    b.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const t of b.textures) t.dispose();
    for (const m of b.materials) m.dispose();
    this.built.delete(id);
  }

  // The road the sign is for: nearest car road running the same way.
  _road(s) {
    let best = null;
    for (const c of this.world.near(s.x, s.z, 40)) {
      for (const seg of c.roadHash.near(s.x, s.z, 40)) {
        const r = seg.road;
        if (r.kind !== 'car') continue;
        const dx = seg.bx - seg.ax, dz = seg.bz - seg.az, l = Math.hypot(dx, dz) || 1;
        if (Math.abs((dx * s.dx + dz * s.dz) / l) < 0.8) continue;
        const t = Math.max(0, Math.min(1, ((s.x - seg.ax) * dx + (s.z - seg.az) * dz) / (l * l)));
        const px = seg.ax + dx * t, pz = seg.az + dz * t, d = Math.hypot(px - s.x, pz - s.z);
        if (d < 25 && (!best || d < best.d)) best = { r, d, x: px, z: pz };
      }
    }
    return best;
  }

  _build(s) {
    const world = this.world;
    const g = new THREE.Group();
    const textures = [], materials = [];
    const [lat, lon] = world.frame.toLatLon(s.x, s.z);
    const europe = lat > 34 && lat < 72 && lon > -25 && lon < 45;
    const color = panelColor(lat, lon, s.fast);
    const road = this._road(s);
    const cx = road ? road.x : s.x, cz = road ? road.z : s.z;
    const hw = road ? road.r.hw : 4;
    const base = road && road.r.ez ? deckY(road.r, cx, cz) : world.elevation(cx, cz);
    // Basis: u to the right of travel, facing back toward oncoming traffic.
    const ux = -s.dz, uz = s.dx;
    const route = s.k === 'route';
    const overhead = !route && (s.fast || (s.panels.length > 1 && hw >= 5));
    const panels = s.panels.map((p) => panelCanvas(p, color, { europe, overhead, route }));
    const face = (pc) => {
      const tex = new THREE.CanvasTexture(pc.cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      textures.push(tex);
      const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.12 });
      materials.push(m);
      return new THREE.Mesh(new THREE.BoxGeometry(pc.w, pc.h, 0.06), [this.back, this.back, this.back, this.back, m, this.back]);
    };
    const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    const yaw = Math.atan2(-s.dx, -s.dz);  // the panel's +z faces against travel

    if (overhead) {
      // Gantry across the carriageway; panels right-aligned, the turning one on its side.
      const span = hw + 1.6, top = 5.4 + Math.max(...panels.map((p) => p.h));
      for (const side of [-1, 1]) {
        const post = box(0.35, top + 0.4, 0.35, this.metal);
        post.position.set(ux * span * side, top / 2 + 0.2, uz * span * side);
        g.add(post);
      }
      const beam = box(span * 2 + 0.4, 0.45, 0.45, this.metal);
      beam.position.set(0, top + 0.1, 0);
      beam.rotation.y = Math.atan2(-uz, ux);  // its length along u
      g.add(beam);
      let right = hw - 0.3;
      for (let i = panels.length - 1; i >= 0; i--) {
        const pc = panels[i], m = face(pc);
        const off = right - pc.w / 2;
        m.position.set(ux * off - s.dx * 0.3, 5.4 + pc.h / 2 + (top - 5.4 - pc.h), uz * off - s.dz * 0.3);
        m.rotation.y = yaw;
        g.add(m);
        right -= pc.w + 0.3;
      }
    } else {
      // On posts at the right of the road.
      let x0 = hw + 1.4;
      const bottom = route ? 1.7 : 2.2;
      for (const pc of panels) {
        const m = face(pc), off = x0 + pc.w / 2;
        m.position.set(ux * off, bottom + pc.h / 2, uz * off);
        m.rotation.y = yaw;
        g.add(m);
        const posts = pc.w > 1.6 ? [-pc.w / 2 + 0.3, pc.w / 2 - 0.3] : [0];
        for (const p of posts) {
          const post = box(route ? 0.08 : 0.14, bottom + pc.h - 0.1, route ? 0.08 : 0.14, this.metal);
          post.position.set(ux * (off + p) + s.dx * 0.08, (bottom + pc.h - 0.1) / 2, uz * (off + p) + s.dz * 0.08);
          g.add(post);
        }
        x0 += pc.w + 0.25;
      }
    }
    g.position.set(cx, base, cz);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.scene.add(g);
    this.built.set(s.id, { group: g, textures, materials });
  }
}
