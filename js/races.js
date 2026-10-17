// Races on real streets. Race starts sit at major roads on a latitude/longitude grid (the same
// place every visit), shown as orange beacons and on the minimap. Drive into one (slowly) to
// start: a sprint to a point about 3.5 km away, or a 2-lap circuit through two nearby points,
// routed over the real roads by OSRM. Checkpoints every 400 m, three AI rivals who follow the
// route (slowing for bends, with a little rubber band), a countdown, positions and a result.
// Best times are kept in this browser.

import * as THREE from 'three';
import { Vehicle } from './vehicles.js';
import { fetchRoute } from './navigate.js';
import { deckY } from './bridges.js';
import { clamp } from './util.js';

const CELL = 0.012;              // ~1.3 km
const START_CHANCE = 0.5;
const MAJOR = /^(trunk|primary|secondary|tertiary)$/;
const CP_EVERY = 400;
const RIVALS = [['sedan-sports', 0.97], ['hatchback-sports', 0.94], ['suv-luxury', 1.0]];  // type, skill
const PRIZE = [5000, 2500, 1200, 500];
const BEST = 'openworld.race.';
const ORD = ['1st', '2nd', '3rd', '4th'];

const hash = (a, b, salt) => {
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
export const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

const BEACON = new THREE.MeshBasicMaterial({ color: '#ff8a2a', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
const ARCH = new THREE.MeshStandardMaterial({ color: '#ff8a2a', emissive: '#ff7a1a', emissiveIntensity: 0.9 });
const ARCH_NEXT = new THREE.MeshStandardMaterial({ color: '#ffd84a', emissive: '#ffcf2a', emissiveIntensity: 1.4 });
for (const m of [BEACON, ARCH, ARCH_NEXT]) m.userData.shared = true;

// Polyline helpers: point and direction at arc length s; nearest arc length near index hint.
function at(R, s) {
  const { pts, cum } = R;
  s = clamp(s, 0, cum[cum.length - 1]);
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi], l = cum[hi] - cum[lo] || 1e-6, t = (s - cum[lo]) / l;
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx: (b[0] - a[0]) / l, tz: (b[1] - a[1]) / l };
}
function progress(R, x, z, hint) {
  const { pts, cum } = R;
  let best = Infinity, s = 0, i = hint;
  const lo = Math.max(0, hint - 8), hi = Math.min(pts.length - 1, hint + 80);
  for (let k = lo; k < hi; k++) {
    const a = pts[k], b = pts[k + 1], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9;
    const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / l2, 0, 1);
    const d = Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
    if (d < best) { best = d; s = cum[k] + (cum[k + 1] - cum[k]) * t; i = k; }
  }
  return { s, i, d: best };
}

export class Races {
  // pop(title, big, sub), award(points, label), flash(text); hud: { box } for the race panel.
  constructor({ scene, world, traffic, police, pop, award, flash, hud }) {
    Object.assign(this, { scene, world, traffic, police, pop, award, flash, hud });
    this.cells = new Map();
    this.starts = [];       // { id, x, z, kind, mesh }
    this.race = null;
    this.t = 0; this.decideT = 0;
    this.busy = false;
  }

  dispose() {
    this._end(null);
    for (const s of this.starts) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); }
    this.starts = [];
    this.cells.clear();
  }

  get active() { return !!this.race; }
  get line() { return this.race ? this.race.R.pts : null; }

  markers() {
    const out = this.race ? [] : this.starts.map((s) => ({ x: s.x, z: s.z, race: true }));
    if (this.race) for (const r of this.race.rivals) out.push({ x: r.v.x, z: r.v.z, rival: true });
    return out;
  }

  update(dt, player) {
    this.t += dt;
    const p = player.pos;
    this.decideT -= dt;
    if (this.decideT <= 0) { this.decideT = 2; this._decide(p.x, p.z); }
    for (const s of this.starts) s.mesh.visible = !this.race;
    if (this.race) { this._run(dt, player); return; }
    const v = player.vehicle;
    if (!v || v.kind !== 'car' || this.busy || this.police.wanted) return;
    for (const s of this.starts) {
      if (Math.hypot(s.x - v.x, s.z - v.z) < 11 && Math.abs(v.speed) < 14) { this._start(s, player); break; }
    }
  }

  // ---------- starts ----------

  _decide(x, z) {
    const f = this.world.frame;
    const [lat, lon] = f.toLatLon(x, z);
    const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const key = `${i},${j}`;
        if (this.cells.has(key)) continue;
        const [tx, tz] = f.toLocal((i + 0.25 + hash(i, j, 7) * 0.5) * CELL, (j + 0.25 + hash(i, j, 8) * 0.5) * CELL);
        if (Math.hypot(tx - x, tz - z) > 1100 || !this.world.near(tx, tz, 200).length) continue;
        this.cells.set(key, true);
        if (hash(i, j, 9) > START_CHANCE) continue;
        const rd = this.world.nearestRoad(tx, tz, 300, (r) => r.kind === 'car' && MAJOR.test(r.t) && !r.ez);
        if (!rd) continue;
        const kind = hash(i, j, 10) < 0.55 ? 'sprint' : 'circuit';
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 70, 20, 1, true), BEACON);
        mesh.position.set(rd.x, this.world.elevation(rd.x, rd.z) + 35, rd.z);
        mesh.renderOrder = 5;
        this.scene.add(mesh);
        this.starts.push({ id: `${kind}:${key}`, i, j, x: rd.x, z: rd.z, kind, mesh });
      }
    }
    // Forget far starts.
    for (const s of [...this.starts]) {
      if (Math.hypot(s.x - x, s.z - z) < 3000) continue;
      this.scene.remove(s.mesh); s.mesh.geometry.dispose();
      this.starts = this.starts.filter((o) => o !== s);
      this.cells.delete(`${s.i},${s.j}`);
    }
  }

  // ---------- a race ----------

  async _start(s, player) {
    this.busy = true;
    this.flash(s.kind === 'sprint' ? 'Sprint race: finding the route…' : 'Circuit race: finding the route…');
    const f = this.world.frame;
    const from = f.toLatLon(s.x, s.z);
    const ang = hash(s.i, s.j, 11) * Math.PI * 2;
    const toLL = (d, a) => f.toLatLon(s.x + Math.cos(a) * d, s.z + Math.sin(a) * d);
    let route;
    try {
      route = s.kind === 'sprint'
        ? await fetchRoute(from, toLL(3500, ang))
        : await fetchRoute(from, toLL(750, ang), toLL(750, ang + 2.1), from);
    } catch (e) {
      this.flash('No race route here');
      setTimeout(() => { this.busy = false; }, 8000);
      return;
    }
    const v = player.vehicle;
    if (!v) { this.busy = false; return; }
    const pts = route.geometry.coordinates.map(([lon, lat]) => f.toLocal(lat, lon));
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const R = { pts, cum, len: cum[cum.length - 1] };
    if (R.len < 600) { this.flash('No race route here'); this.busy = false; return; }
    const laps = s.kind === 'circuit' ? 2 : 1, total = R.len * laps;
    const cps = [];
    for (let d = CP_EVERY; d < total - 50; d += CP_EVERY) cps.push(d);
    cps.push(total);

    // Grid: you on the start line, rivals beside and behind.
    const place = (veh, back, side) => {
      const q = at(R, 12 - back);
      veh.place(q.x - q.tz * side, q.z + q.tx * side, Math.atan2(-q.tx, -q.tz), this.world);
    };
    place(v, 0, 1.8);
    player.camYaw = v.yaw;  // look down the course
    const rivals = RIVALS.map(([type, skill], k) => {
      const rv = new Vehicle('car', type);
      rv.rough = true;
      this.scene.add(rv.root);
      place(rv, k === 0 ? 0 : 9 * (k > 1 ? 2 : 1), k === 0 ? -1.8 : k === 1 ? 1.8 : -1.8);
      this.world.obstacles.add(rv);
      return { v: rv, skill, i: 0, s: 0, lap: 0, done: null, stuck: 0 };
    });
    this.race = { s, R, laps, total, cps, cp: 0, rivals, t: -3.5, i: 0, prog: 0, off: 0, arches: new Map(), best: null };
    try { this.race.best = Number(localStorage.getItem(BEST + s.id)) || null; } catch { /* storage unavailable */ }
    this.busy = false;
  }

  _run(dt, player) {
    const race = this.race, R = race.R, v = player.vehicle;
    race.t += dt;
    if (!v) { this._end('RACE ABANDONED'); return; }
    // Countdown: everyone waits.
    if (race.t < 0) {
      v.stop();
      for (const r of race.rivals) r.v.stop();
      const n = Math.ceil(-race.t);
      if (n !== race.count) { race.count = n; this.pop(n > 3 ? 'GET READY' : String(Math.min(3, n)), null, `${race.s.kind === 'sprint' ? 'Sprint' : 'Circuit'} · ${(R.len / 1000).toFixed(1)} km${race.laps > 1 ? ` · ${race.laps} laps` : ''}`); }
      this._hud();
      this._arches();
      return;
    }
    if (!race.go) { race.go = true; this.pop('GO!', null, ''); }

    // Your progress (laps count when you pass the start again).
    const pr = progress(R, v.x, v.z, race.i);
    const lap = Math.floor(race.prog / R.len);
    let s = lap * R.len + pr.s;
    if (pr.s < 80 && race.prog % R.len > R.len - 120 && lap + 1 < race.laps) s = (lap + 1) * R.len + pr.s;
    if (s > race.prog - 30 && s < race.prog + 200) { race.prog = Math.max(race.prog, s); race.i = pr.i; }
    else if (pr.d < 30) race.i = pr.i;
    race.off = pr.d > 220 ? race.off + dt : 0;
    if (race.off > 8) { this._end('RACE ABANDONED: off the route'); return; }

    // Checkpoints.
    while (race.cp < race.cps.length && race.prog >= race.cps[race.cp] - 25) {
      race.cp++;
      if (race.cp < race.cps.length) this.award(150, 'CHECKPOINT', 0.05);
    }
    for (const r of race.rivals) this._ai(r, dt, race);
    if (race.cp >= race.cps.length) { this._finish(); return; }
    this._hud();
    this._arches();
  }

  _ai(r, dt, race) {
    const R = race.R, v = r.v;
    if (r.done !== null) { v.drive(dt, { throttle: 0, steer: 0, brake: true }, this.world); return; }
    const pr = progress(R, v.x, v.z, r.i);
    r.i = pr.i;
    const lap = Math.floor(r.s / R.len);
    let s = lap * R.len + pr.s;
    if (pr.s < 80 && r.s % R.len > R.len - 120) s = (lap + 1) * R.len + pr.s;
    if (s > r.s - 30 && s < r.s + 200) r.s = Math.max(r.s, s);
    if (r.s >= race.total - 5) { r.done = race.t; return; }
    const here = r.s % R.len;
    const speed = Math.abs(v.speed);
    const target = at(R, here + 9 + speed * 0.7);
    // Slow for bends: how much the route turns over the next stretch.
    const d1 = at(R, here + 8 + speed * 0.5), d2 = at(R, here + 35 + speed * 1.6);
    const bend = Math.acos(clamp(d1.tx * d2.tx + d1.tz * d2.tz, -1, 1));
    let vt = v.spec.maxFwd * r.skill * (1 - Math.min(0.72, bend * 0.75));
    vt = Math.max(vt, 8);
    // A little rubber band: hold back when far ahead, push when far behind.
    const gap = r.s - race.prog;
    if (gap > 120) vt *= 0.82;
    else if (gap < -90) { vt *= 1.12; v.nitro = 1; }
    const [fx, fz] = v.fwd, [rx, rz] = v.right;
    const dx = target.x - v.x, dz = target.z - v.z, dd = Math.hypot(dx, dz) || 1;
    const side = (dx * rx + dz * rz) / dd, ahead = (dx * fx + dz * fz) / dd;
    const path = v.steerToPoint(target.x, target.z);
    vt = Math.min(vt, path.cornerSpeed);
    const ctl = { steer: path.steer, throttle: speed < vt ? 1 : speed > vt + 2 ? -0.7 : 0.2, brake: false, boost: gap < -90 };
    if (ahead < 0) ctl.throttle = 0.5;
    // Stuck (after the start): back onto the route a little behind where it was.
    r.stuck = speed < 2 ? r.stuck + dt : 0;
    if (r.stuck > 2.5 || pr.d > 40) {
      const q = at(R, Math.max(0, here - 6));
      v.place(q.x, q.z, Math.atan2(-q.tx, -q.tz), this.world);
      v.speed = 6; r.stuck = 0;
    }
    v.drive(dt, ctl, this.world);
    this.traffic.bump(v.x, v.z, 0);
  }

  _finish() {
    const race = this.race;
    const time = race.t;
    const ahead = race.rivals.filter((r) => r.done !== null && r.done < time).length;
    const place = ahead + 1;
    const best = race.best;
    if (!best || time < best) try { localStorage.setItem(BEST + race.s.id, String(time)); } catch { /* storage unavailable */ }
    this.award(PRIZE[place - 1] || 300, `${ORD[place - 1]} PLACE`, 0.5);
    this.pop(`${ORD[place - 1]} PLACE`, null, `${fmtTime(time)}${best ? (time < best ? ' · NEW BEST' : ` · best ${fmtTime(best)}`) : ''}`);
    this._end(null);
  }

  _end(msg) {
    const race = this.race;
    if (!race) return;
    for (const r of race.rivals) { this.world.obstacles.delete(r.v); this.scene.remove(r.v.root); r.v.dispose(); }
    for (const m of race.arches.values()) { this.scene.remove(m); m.traverse((o) => o.geometry && o.geometry.dispose()); }
    this.race = null;
    this.hud.box.classList.remove('show');
    if (msg) this.flash(msg);
    this.busy = true;
    setTimeout(() => { this.busy = false; }, 6000);  // don't restart on the spot
  }

  // Arches over the next two checkpoints.
  _arches() {
    const race = this.race, want = new Set([race.cp, race.cp + 1].filter((k) => k < race.cps.length));
    for (const [k, m] of race.arches) {
      if (want.has(k)) continue;
      this.scene.remove(m); m.traverse((o) => o.geometry && o.geometry.dispose());
      race.arches.delete(k);
    }
    for (const k of want) {
      let m = race.arches.get(k);
      if (!m) {
        const sk = race.cps[k] % race.R.len;
        const q = at(race.R, sk === 0 && race.laps === 1 ? race.R.len : sk);  // a circuit finishes at the start
        const rd = this.world.nearestRoad(q.x, q.z, 20, (r) => r.kind === 'car');
        const hw = rd ? rd.road.hw + 1.2 : 6;
        const base = rd && rd.road.ez ? deckY(rd.road, q.x, q.z) : this.world.elevation(q.x, q.z);
        m = new THREE.Group();
        const nx = -q.tz, nz = q.tx;
        for (const side of [-1, 1]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5.5, 0.4), ARCH);
          post.position.set(q.x + nx * hw * side, base + 2.75, q.z + nz * hw * side);
          m.add(post);
        }
        const top = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 0.4, 0.7, 0.4), ARCH);
        top.position.set(q.x, base + 5.5, q.z);
        top.rotation.y = Math.atan2(-nz, nx);  // its length across the road
        m.add(top);
        this.scene.add(m);
        race.arches.set(k, m);
      }
      m.traverse((o) => { if (o.isMesh) o.material = k === race.cp ? ARCH_NEXT : ARCH; });
    }
  }

  _hud() {
    const race = this.race, box = this.hud.box;
    const all = [race.prog, ...race.rivals.map((r) => (r.done !== null ? race.total + 1e6 - r.done : r.s))];
    const pos = all.filter((x) => x > race.prog).length + 1;
    const lap = Math.min(race.laps, Math.floor(race.prog / race.R.len) + 1);
    box.innerHTML = `<b>${race.s.kind === 'sprint' ? 'SPRINT' : 'CIRCUIT'}</b><span class="pos">${ORD[pos - 1]}<small>/${race.rivals.length + 1}</small></span>`
      + `<span>${fmtTime(Math.max(0, race.t))}</span><span>CP ${Math.min(race.cp, race.cps.length)}/${race.cps.length}</span>`
      + (race.laps > 1 ? `<span>LAP ${lap}/${race.laps}</span>` : '')
      + (race.best ? `<span class="best">best ${fmtTime(race.best)}</span>` : '');
    box.classList.add('show');
  }
}
