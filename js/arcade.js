// Need for Speed style driving rewards: Speed Points (SP) for near misses, driving into oncoming
// traffic, handbrake drifts, top speed, police takedowns and escapes; nitrous that refills from
// them; gas stations that repair (spike strips), refill nitrous and respray the car, which also
// shakes off two stars when the police can't see you; and a slow-motion crash cam on takedowns.
// Points are kept in this browser.

const SP_KEY = 'openworld.sp';
const COMBO_S = 4;           // seconds to chain the next event into the combo
const STATION_COOLDOWN = 40;
const PAINTS = ['#e8402a', '#2a7de8', '#f2c22e', '#24b06a', '#f07a1e', '#9a4ee0', '#e83e8c', '#f4f4f4', '#2b2b2b', '#16c1c8'];

const fmt = (n) => Math.round(n).toLocaleString('en-US');

export class Arcade {
  // hud: { box, points, nitro, pops } elements. flash(text): the game's message line.
  constructor({ world, traffic, police, hud, flash }) {
    Object.assign(this, { world, traffic, police, hud, flash });
    this.total = 0;
    try { this.total = Number(localStorage.getItem(SP_KEY)) || 0; } catch { /* storage unavailable */ }
    this.combo = 0; this.comboT = 0;
    this.passed = new Map();   // traffic car -> side it was on (for near misses)
    this.stations = [];
    this.stationT = 0;
    this.used = new Map();     // station id -> time last used
    this.t = 0;
    this.cam = null;           // crash cam: { v, t, a }
    this.streak = {};          // continuous events (oncoming, drift, speed): their pop element
    this._saveT = 0;
  }

  // Time runs slower while the crash cam plays.
  get timeScale() { return this.cam ? 0.28 : 1; }

  award(points, label, nitro = 0.08) {
    if (this.comboT > 0) this.combo = Math.min(5, this.combo + 1); else this.combo = 1;
    this.comboT = COMBO_S;
    const pts = points * this.combo;
    this.total += pts;
    this._nitro(nitro);
    this._pop(`+${fmt(pts)} ${label}${this.combo > 1 ? ` ×${this.combo}` : ''}`);
  }

  // Continuous events (per second while they last) share one line that counts up.
  _streak(key, label, perSec, dt, on) {
    const s = this.streak[key];
    if (!on) {
      if (s && s.pts > 0) { s.el.classList.add('done'); setTimeout(() => s.el.remove(), 1200); }
      delete this.streak[key];
      return;
    }
    const add = perSec * dt;
    this.total += add;
    this._nitro(add / 1500);
    if (!s) {
      const el = document.createElement('div');
      el.className = 'pop live';
      this.hud.pops.prepend(el);
      this.streak[key] = { el, pts: add };
    } else s.pts += add;
    this.streak[key].el.textContent = `+${fmt(this.streak[key].pts)} ${label}`;
  }

  _pop(text) {
    const el = document.createElement('div');
    el.className = 'pop';
    el.textContent = text;
    this.hud.pops.prepend(el);
    setTimeout(() => el.remove(), 1800);
    while (this.hud.pops.children.length > 5) this.hud.pops.lastChild.remove();
  }

  _nitro(x) {
    const v = this.vehicle;
    if (v && v.kind === 'car') v.nitro = Math.min(1, (v.nitro || 0) + x);
  }

  // Police callbacks.
  takedown(u) {
    this.award(1500, 'TAKEDOWN', 0.4);
    this.cam = { v: u.v, t: 1.9, a: Math.random() * Math.PI * 2 };
  }
  escaped(heat) { this.award(1000 * Math.max(1, heat), 'ESCAPED', 0.5); }
  spiked() { this.flash('Tires blown! Get to a gas station to repair'); }

  update(rawDt, player) {
    const dt = rawDt;
    this.t += dt;
    if (this.cam) { this.cam.t -= rawDt; if (this.cam.t <= 0) this.cam = null; }
    this.comboT = Math.max(0, this.comboT - dt);
    const v = player.vehicle && player.vehicle.kind === 'car' ? player.vehicle : null;
    this.vehicle = v;
    this.hud.box.classList.toggle('show', !!v);
    this._saveT -= dt;
    if (this._saveT <= 0) { this._saveT = 3; try { localStorage.setItem(SP_KEY, String(Math.round(this.total))); } catch { /* storage unavailable */ } }
    if (!v) { for (const k of Object.keys(this.streak)) this._streak(k, '', 0, 0, false); this._render(null); return; }

    v.nitro = Math.min(1, (v.nitro || 0) + dt * 0.012);  // trickles back slowly on its own
    const speed = Math.abs(v.speed), [fx, fz] = v.fwd;

    // Near misses: a car passes beside us (1-3 m) at speed without touching.
    for (const c of [...this.traffic.cars, ...this.police.units.map((u) => u.v)]) {
      const dx = c.x - v.x, dz = c.z - v.z;
      if (Math.abs(dx) > 14 || Math.abs(dz) > 14) { this.passed.delete(c); continue; }
      const along = dx * fx + dz * fz, lat = Math.abs(dx * -fz + dz * fx);
      const prev = this.passed.get(c);
      this.passed.set(c, along);
      if (prev !== undefined && prev > 0 && along <= 0 && lat > 1.1 && lat < 3.2 && speed > 12 && !(v.hit > 3)) {
        this.award(250, 'NEAR MISS', 0.1);
      }
    }
    if (v.hit) v.hit = Math.max(0, v.hit - dt * 20);

    // Oncoming: on the wrong side of a two-way road.
    let oncoming = false;
    if (speed > 15) {
      const rd = this.world.nearestRoad(v.x, v.z, 10);
      if (rd && !rd.road.ow) {
        const a = rd.road.p[rd.seg], b = rd.road.p[rd.seg + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const tx = (b[0] - a[0]) / l, tz = (b[1] - a[1]) / l;
        const side = (v.x - rd.x) * -tz + (v.z - rd.z) * tx;  // + right of the way's direction
        const dir = fx * tx + fz * tz;
        oncoming = (dir > 0.7 && side < -0.6) || (dir < -0.7 && side > 0.6);
      }
    }
    this._streak('oncoming', 'ONCOMING', 90, dt, oncoming);
    this._streak('drift', 'DRIFT', 140, dt, !!(player.input?.brake) && speed > 9 && Math.abs(v.yawRate || 0) > 0.45);
    this._streak('speed', 'TOP SPEED', 40, dt, speed > v.spec.maxFwd * 0.85);

    this._gasStations(dt, v);
    this._render(v);
  }

  // ---------- gas stations ----------

  _gasStations(dt, v) {
    this.stationT -= dt;
    if (this.stationT <= 0) {
      this.stationT = 1;
      this.stations = [];
      for (const c of this.world.near(v.x, v.z, 700)) {
        for (const p of c.pois) {
          if (!/\b(fuel|gas station|petrol|fueling|filling station)\b/i.test(`${p.k} ${p.n}`)) continue;
          this.stations.push({ id: p.id, x: p.x, z: p.z, n: p.n });
        }
      }
    }
    for (const s of this.stations) {
      if (Math.hypot(s.x - v.x, s.z - v.z) > 16 || Math.abs(v.speed) > 28) continue;
      if (this.t - (this.used.get(s.id) ?? -1e9) < STATION_COOLDOWN) continue;
      this.used.set(s.id, this.t);
      v.flat = false;
      v.nitro = 1;
      v.respray(PAINTS[Math.floor(Math.random() * PAINTS.length)]);
      let msg = 'Repaired, refueled, resprayed';
      // Out of their sight, a new color throws them off.
      if (this.police.wanted && this.police.cool > 0) { this.police.lose(2); msg += ': they lost you'; }
      this.award(500, 'PIT STOP', 0);
      this.flash(msg);
    }
  }

  // Gas stations for the minimap.
  markers() { return this.vehicle ? this.stations.map((s) => ({ x: s.x, z: s.z, gas: true })) : []; }

  // ---------- crash cam ----------

  // After the player camera: circle the wreck in slow motion.
  applyCamera(camera) {
    if (!this.cam) return;
    const v = this.cam.v, k = 1 - this.cam.t / 1.9;
    const a = this.cam.a + k * 1.4;
    camera.position.set(v.x + Math.cos(a) * 8, v.y + 2.2 + k * 1.5, v.z + Math.sin(a) * 8);
    camera.lookAt(v.x, v.y + 0.8, v.z);
  }

  // ---------- HUD ----------

  _render(v) {
    const h = this.hud;
    h.points.textContent = fmt(this.total);
    if (!v) return;
    h.nitro.style.width = `${Math.round((v.nitro || 0) * 100)}%`;
    h.box.classList.toggle('boost', !!v.boosting);
    h.box.classList.toggle('flat', !!v.flat);
  }
}
