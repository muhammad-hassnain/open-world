// Police: patrol cars in traffic notice crimes they can see (speeding, red lights, crashing into
// cars, driving on sidewalks or parks), which starts a chase. The longer it lasts the higher the
// heat: more units, then police SUVs, then interceptors and roadblocks. You're busted if they
// keep you stopped for a few seconds. Each unit sees within a circle (shown on the minimap);
// outside every circle (or out of their line of sight) the cooldown runs, and each time it fills
// you lose a star, until you escape. Chasing units follow the streets (A* over the road graph) and drive straight at you once
// they see you. Everything here is local to this player.
import * as THREE from 'three';
import { Vehicle, carsLoaded } from './vehicles.js';
import { nodeKey, signalState } from './world.js';
import { clamp, angleDelta } from './util.js';
import { speedLimit, MPH_PER_MS, KMH_PER_MS } from './limits.js';

const SIGHT = 75;                       // m: a patrol notices crimes within this, if nothing blocks the view
const CHASE_SIGHT = 140;                // m: units in a chase keep seeing you within this
const HEAT_AT = [0, 0, 60, 150, 270, 420];   // seconds of chase for heat 1..5
const UNITS = [0, 2, 3, 4, 5, 6];
const BUST_TIME = 3.5, BUST_R = 9;
const cooldownFor = (heat) => 8 + heat * 2;  // seconds out of sight to drop one star
const SEEN_CLOSE = 35;
const UNIT_HP = 100;                    // ramming damage is about 3.5 per m/s of closing speed
const SPIKE_EVERY = 26;
const ACTIVE = (u) => u.mode === 'chase' || u.mode === 'block';  // not leaving or wrecked                 // s between spike strips at heat 3+                  // m: this close, they hear and see you around corners
const UNIT_TYPES = [null, ['police'], ['police'], ['police-suv', 'police'], ['interceptor', 'police-suv'], ['interceptor']];

export class Police {
  // hud: { box, stars, time, units, meter, label, banner } elements; onBusted() when caught.
  // onTakedown(unit), onSpiked(), onEscape(heat): for the arcade layer (arcade.js).
  constructor({ scene, world, traffic, hud, siren, onBusted, onCrime, onTakedown, onSpiked, onEscape }) {
    Object.assign(this, { scene, world, traffic, hud, onBusted, onCrime, onTakedown, onSpiked, onEscape });
    this.spikes = [];         // spike strips across roads: { x, z, tx, tz, hw, mesh, t }
    this.spikeT = SPIKE_EVERY / 2;
    this.units = [];          // { v: Vehicle, mode: 'chase' | 'block' | 'leave', path, pathT, stuckT, backT, t }
    this.heat = 0;
    this.wanted = false;
    this.chase = 0;           // seconds of chase (raised by new crimes)
    this.cool = 0;            // seconds out of sight
    this.bust = 0;            // seconds boxed in
    this.seen = null;         // last place police saw the player
    this.lastCrime = {};      // crime -> time, so one crime is reported once every few seconds
    this.blockT = 20;
    this.losT = 0;
    this.siren = siren;
    this._prevSig = null;
  }

  dispose() {
    for (const sp of this.spikes) this._removeSpikes(sp);
    this.spikes = [];
    for (const u of this.units) this._remove(u);
    this.units = [];
    this.siren.set(0);
  }

  update(dt, player) {
    const t = this.traffic.time;
    this.traffic.patrols = this.wanted ? 0 : 2;
    if (!player || !carsLoaded()) return;
    const crime = this._crimes(player, t);
    if (crime && this._witnessed(player)) this._report(crime, player);

    if (this.wanted) {
      if (this.cool === 0) this.chase += dt;  // heat only builds while they're on you
      const heat = HEAT_AT.reduce((h, s, i) => (i > 0 && this.chase >= s ? i : h), 1);
      if (heat > this.heat) { this.heat = heat; this._flash(`Heat ${heat}${heat >= 4 ? ': interceptors and roadblocks' : heat === 3 ? ': police SUVs' : ''}`); }
      this._keepUnits(player);
      this._sight(dt, player);
      this._busted(dt, player);
      this._roadblocks(dt, player);
      this._spikeStrips(dt, player);
    }
    this._damage(dt, player);
    this._checkSpikes(dt, player);
    for (const u of [...this.units]) this._drive(u, dt, player, t);
    this._siren(player);
    this._hud();
  }

  // ---------- crimes ----------

  _crimes(player, t) {
    const v = player.vehicle;
    if (!v || v.kind !== 'car') { this._prevSig = null; v && (v.hitNow = 0); return null; }
    const w = this.world;
    let crime = null;
    // Crashing into a car (traffic, parked, police, any vehicle).
    if (v.hitNow > 3) {
      const near = (x, z) => Math.hypot(x - v.x, z - v.z) < 5.5;
      const hitCar = this.traffic.cars.some((c) => near(c.x, c.z)) || this.units.some((u) => near(u.v.x, u.v.z))
        || [...w.obstacles].some((o) => o.kind && o !== v && near(o.x, o.z)) || !!w.parkedCarNear(v.x, v.z, 1.5);
      if (hitCar) crime = 'Crashing into a car';
    }
    v.hitNow = 0;
    // Speeding: well over the limit of the road you're on (15 mph / 20 km/h).
    const rd = w.nearestRoad(v.x, v.z, 12);
    if (!crime && rd) {
      const lim = speedLimit(rd.road, this.miles), mine = Math.abs(v.speed) * (this.miles ? MPH_PER_MS : KMH_PER_MS);
      if (mine > lim.value + (this.miles ? 15 : 20)) crime = `Speeding (${Math.round(mine)} in a ${lim.value} ${lim.unit} zone)`;
    }
    // Running a red light: entering a junction with a light that's red for your direction.
    let inSig = null;
    for (const sig of w.signals.values()) {
      if (Math.abs(sig.x - v.x) < 30 && Math.abs(sig.z - v.z) < 30 && Math.hypot(sig.x - v.x, sig.z - v.z) < sig.radius + 1) { inSig = sig; break; }
    }
    if (!crime && inSig && inSig !== this._prevSig && Math.abs(v.speed) > 3) {
      const [fx, fz] = v.fwd, ax = -fx * Math.sign(v.speed), az = -fz * Math.sign(v.speed);
      const axis = Math.abs(ax * inSig.ref.ux + az * inSig.ref.uz) > 0.7 ? 0 : 1;
      if (signalState(inSig, axis, t) === 'red') crime = 'Running a red light';
    }
    this._prevSig = inSig;
    // Off the road: on a sidewalk or across a park.
    if (!crime && Math.abs(v.speed) > 4 && !w.onRoad(v.x, v.z, 0.4)) {
      const area = w.areaAt(v.x, v.z);
      if (w.onSidewalk(v.x, v.z) || (area && ['grass', 'wood', 'pitch', 'playground'].includes(area.k))) crime = 'Driving off the road';
    }
    if (!crime) return null;
    const key = crime.split(' (')[0];
    if (t - (this.lastCrime[key] ?? -99) < 4) return null;
    this.lastCrime[key] = t;
    return crime;
  }

  // Can any police car see the player (close enough, nothing in the way)?
  _witnessed(player) {
    const p = player.pos;
    for (const c of this.traffic.cars) if (c.type === 'police' && this._los(c.x, c.z, p.x, p.z, SIGHT)) return { car: c };
    for (const u of this.units) if (this._los(u.v.x, u.v.z, p.x, p.z, CHASE_SIGHT)) return { unit: u };
    return null;
  }

  _los(ax, az, bx, bz, range) {
    const d = Math.hypot(bx - ax, bz - az);
    if (d > range) return false;
    const n = Math.ceil(d / 6);
    for (let i = 1; i < n; i++) {
      const x = ax + ((bx - ax) * i) / n, z = az + ((bz - az) * i) / n;
      if (this.world.buildingAt(x, z)) return false;
    }
    return true;
  }

  _report(crime, player) {
    if (!this.wanted) {
      this.wanted = true; this.heat = 1; this.chase = 0; this.cool = 0; this.bust = 0;
      // The patrol that saw it joins the chase.
      const w = this._witnessed(player);
      if (w && w.car) this._addUnit(this.traffic.take(w.car), 'police');
    } else {
      this.chase += 8;
    }
    this.seen = { x: player.pos.x, z: player.pos.z };
    this.cool = 0;
    this._flash(`${crime}: the police saw you!`);
    if (this.onCrime) this.onCrime(crime);
  }

  // ---------- chase ----------

  _keepUnits(player) {
    const want = UNITS[this.heat];
    const chasing = this.units.filter((u) => u.mode === 'chase');
    // Fewer stars: the farthest units give up.
    if (chasing.length > want) {
      const p = player.pos;
      chasing.sort((a, b) => Math.hypot(b.v.x - p.x, b.v.z - p.z) - Math.hypot(a.v.x - p.x, a.v.z - p.z));
      for (const u of chasing.slice(0, chasing.length - want)) u.mode = 'leave';
      return;
    }
    if (chasing.length >= want) return;
    // Out of sight, reinforcements come to where you were last seen, not to you.
    const at = this.cool > 0 && this.seen ? this.seen : player.pos;
    const spot = this._spawnSpot(at, player, 80, 170);
    if (!spot) return;
    const types = UNIT_TYPES[this.heat];
    this._addUnit(spot, types[chasing.length % types.length]);
  }

  _addUnit(pose, type, mode = 'chase') {
    const v = new Vehicle('car', type);
    v.rough = true;  // pushes past parked cars and street furniture
    this.scene.add(v.root);
    v.place(pose.x, pose.z, pose.yaw, this.world);
    this.world.obstacles.add(v);
    const u = { v, mode, path: null, pathT: 0, stuckT: 0, backT: 0, t: 0 };
    this.units.push(u);
    return u;
  }

  _remove(u) {
    this.world.obstacles.delete(u.v);
    this.scene.remove(u.v.root);
    u.v.dispose();
    this.units = this.units.filter((o) => o !== u);
  }

  // A point on a car road between min and max meters from `p`, out of the player's sight if possible.
  _spawnSpot(p, player, min, max) {
    const w = this.world, me = player.pos;
    for (let tries = 0; tries < 30; tries++) {
      const a = Math.random() * Math.PI * 2, d = min + Math.random() * (max - min);
      const rd = w.nearestRoad(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d, 40);
      if (!rd) continue;
      const dd = Math.hypot(rd.x - p.x, rd.z - p.z);
      if (dd < min * 0.8) continue;
      if (Math.hypot(rd.x - me.x, rd.z - me.z) < 60) continue;
      if (tries < 20 && this._los(rd.x, rd.z, me.x, me.z, 400)) continue;
      return { x: rd.x, z: rd.z, yaw: Math.atan2(-(p.x - rd.x), -(p.z - rd.z)) };
    }
    return null;
  }

  _sight(dt, player) {
    this.losT -= dt;
    if (this.losT > 0) return;
    this.losT = 0.2;
    const p = player.pos;
    const sees = this.units.some((u) => ACTIVE(u)
      && (Math.hypot(u.v.x - p.x, u.v.z - p.z) < SEEN_CLOSE || this._los(u.v.x, u.v.z, p.x, p.z, CHASE_SIGHT)));
    if (sees) { this.seen = { x: p.x, z: p.z }; this.cool = 0; return; }
    // Out of every unit's sight: the cooldown fills, and each time it does you lose a star.
    this.cool += 0.2;
    if (this.cool < cooldownFor(this.heat)) return;
    if (this.heat <= 1) { this._end('ESCAPED'); return; }
    this.heat--;
    this.chase = HEAT_AT[this.heat];
    this.cool = 0.01;  // keep cooling toward the next star
    this._flash(`Heat ${this.heat}: they're losing you`);
  }

  _busted(dt, player) {
    const v = player.vehicle, p = player.pos;
    const slow = !v || Math.abs(v.speed) < 2.5;
    const close = this.units.some((u) => ACTIVE(u) && Math.hypot(u.v.x - p.x, u.v.z - p.z) < BUST_R);
    if (slow && close) this.bust += dt;
    else this.bust = Math.max(0, this.bust - dt * 1.5);
    if (this.bust >= BUST_TIME) {
      this._end('BUSTED');
      if (this.onBusted) this.onBusted();
    }
  }

  // Lose n stars at once (a repair out of sight); at no stars left you've escaped.
  lose(n) {
    if (!this.wanted) return;
    if (this.heat - n <= 0) { this._end('ESCAPED'); return; }
    this.heat -= n;
    this.chase = HEAT_AT[this.heat];
    this.cool = 0.01;
    this._flash(`Heat ${this.heat}`);
  }

  _end(result) {
    if (result === 'ESCAPED' && this.onEscape) this.onEscape(this.heat);
    this.wanted = false; this.heat = 0; this.chase = 0; this.cool = 0; this.bust = 0;
    for (const u of this.units) u.mode = 'leave';
    this._banner(result);
  }

  // Heat 4+: block the street ahead of the player with police cars across it.
  _roadblocks(dt, player) {
    if (this.heat < 4) return;
    this.blockT -= dt;
    if (this.blockT > 0) return;
    this.blockT = 3;  // try again soon if it can't be placed now
    const v = player.vehicle;
    if (!v || Math.abs(v.speed) < 8) return;
    const spot = this._roadAhead(v, 170);
    if (!spot) return;
    this.blockT = this.heat >= 5 ? 30 : 42;
    const { x, z, tx, tz, hw } = spot;
    const across = Math.atan2(tz, -tx);  // yaw facing across the road
    const n = hw > 5 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const o = (i - (n - 1) / 2) * 2.4;
      this._addUnit({ x: x - tz * o, z: z + tx * o, yaw: across + (i % 2 ? Math.PI : 0) }, UNIT_TYPES[this.heat][0], 'block');
    }
    this._flash('Roadblock ahead!');
  }

  // Follow the player's road ahead `dist` meters (straightest way at junctions).
  _roadAhead(v, dist) {
    const w = this.world, rd = w.nearestRoad(v.x, v.z, 15);
    if (!rd) return null;
    let road = rd.road, k = rd.seg;
    const [fx, fz] = v.fwd;
    const a = road.p[k], b = road.p[k + 1];
    let dir = (b[0] - a[0]) * fx + (b[1] - a[1]) * fz >= 0 ? 1 : -1;
    if (dir < 0) k = k + 1;
    let x = rd.x, z = rd.z, left = dist;
    for (let guard = 0; guard < 200 && left > 0; guard++) {
      const n = k + dir;
      if (n < 0 || n >= road.p.length) {
        const list = w.nodes.get(nodeKey(road.p[k][0], road.p[k][1])) || [];
        const next = list.find((e) => e.road !== road);
        if (!next) return null;
        road = next.road; k = next.k;
        dir = k + 1 < road.p.length ? 1 : -1;
        continue;
      }
      const q = road.p[n], seg = Math.hypot(q[0] - x, q[1] - z);
      if (seg >= left) {
        const tx = (q[0] - x) / seg, tz = (q[1] - z) / seg;
        return { x: x + tx * left, z: z + tz * left, tx, tz, hw: road.hw };
      }
      left -= seg; x = q[0]; z = q[1]; k = n;
    }
    return null;
  }

  // ---------- unit driving ----------

  _drive(u, dt, player, t) {
    const v = u.v, p = player.pos;
    u.t += dt;
    if (u.mode === 'wreck') {
      if (u.t > 18 || Math.hypot(v.x - p.x, v.z - p.z) > 400) this._remove(u);
      return;
    }
    const far = Math.hypot(v.x - p.x, v.z - p.z);
    if (u.mode === 'leave' && (far > 160 || u.t > 40)) { this._remove(u); return; }
    if (u.mode === 'block') {
      if (far > 300 || u.t > 70) { this._remove(u); return; }
      v.drive(dt, { throttle: 0, steer: 0, brake: true }, this.world);
      v.flash(this.wanted, t);
      return;
    }
    if (far > 500) { this._remove(u); return; }
    // Not getting any closer for a while and out of sight: replace it (a fresh unit spawns elsewhere).
    if (u.mode === 'chase') {
      if (far < (u.bestD ?? Infinity) - 5) { u.bestD = far; u.idleT = 0; } else u.idleT = (u.idleT || 0) + dt;
      if (u.idleT > 6 && !this._los(v.x, v.z, p.x, p.z, 200)) { this._remove(u); return; }
    }
    let ctl;
    if (u.mode === 'leave') ctl = { throttle: 0.6, steer: 0, brake: false };
    else {
      // Close and in sight: go straight for the player (a little ahead of them); else follow the streets.
      const pv = player.vehicle;
      const lead = pv ? 0.6 : 0;
      const tx = p.x + (pv ? pv.fwd[0] * pv.speed * lead : 0), tz = p.z + (pv ? pv.fwd[1] * pv.speed * lead : 0);
      let target = { x: tx, z: tz }, direct = true;
      if (!(far < 90 && this._los(v.x, v.z, p.x, p.z, 90))) {
        const t2 = this._pathTarget(u, dt, this.seen || p);
        if (t2) { target = t2; direct = false; }
      }
      ctl = steerTo(v, target.x, target.z, far, direct);
      // Stuck against something (going either way): try the opposite way for a moment.
      if (Math.abs(v.speed) < 0.8 && Math.abs(ctl.throttle) > 0.4 && !(u.backT > 0)) u.stuckT += dt;
      else u.stuckT = Math.max(0, u.stuckT - dt);
      if (u.stuckT > 1) { u.backT = 1.1; u.stuckT = 0; u.backDir = -Math.sign(ctl.throttle) || -1; u.backSteer = -ctl.steer || 1; }
      if (u.backT > 0) { u.backT -= dt; ctl = { throttle: u.backDir, steer: u.backSteer, brake: false }; }
    }
    v.drive(dt, ctl, this.world);
    if (u.mode === 'chase') this.traffic.bump(v.x, v.z, 0);  // traffic it pushes through stops
    v.flash(u.mode === 'chase', t);
  }

  // Next waypoint on a road route to `goal` (A* over road vertices, refreshed every 1.5 s).
  _pathTarget(u, dt, goal) {
    u.pathT -= dt;
    if (u.pathT <= 0 || !u.path || !u.path.length) {
      u.pathT = 1.5;
      u.path = route(this.world, u.v, goal.x, goal.z);
    }
    if (!u.path || !u.path.length) return null;
    // Drop points up to the one nearest the car, then aim ~15 m further along the route.
    let best = 0, bd = Infinity;
    u.path.forEach((q, i) => { const d = Math.hypot(q[0] - u.v.x, q[1] - u.v.z); if (d < bd) { bd = d; best = i; } });
    u.path.splice(0, best);
    let acc = 0, q = u.path[0];
    for (let i = 1; i < u.path.length && acc < 15; i++) {
      acc += Math.hypot(u.path[i][0] - u.path[i - 1][0], u.path[i][1] - u.path[i - 1][1]);
      q = u.path[i];
    }
    return { x: q[0], z: q[1] };
  }

  // Police for the minimap: chase units and patrol cars with the radius they see within.
  markers() {
    const out = [];
    for (const u of this.units) if (u.mode === 'chase' || u.mode === 'block') out.push({ x: u.v.x, z: u.v.z, r: CHASE_SIGHT, chase: true });
    if (!this.wanted) for (const c of this.traffic.cars) if (c.type === 'police') out.push({ x: c.x, z: c.z, r: SIGHT, chase: false });
    return out;
  }

  // ---------- takedowns and spike strips ----------

  // Units lose health when rammed by the player or crashing at speed; at zero they're wrecked.
  _damage(dt, player) {
    const pv = player.vehicle;
    for (const u of this.units) {
      if (u.mode === 'wreck' || u.mode === 'leave') continue;
      const v = u.v;
      u.hp ??= UNIT_HP;
      u.hitCd = Math.max(0, (u.hitCd || 0) - dt);
      let dmg = 0;
      if (pv && pv.kind === 'car' && !u.hitCd) {
        const dx = v.x - pv.x, dz = v.z - pv.z, d = Math.hypot(dx, dz);
        if (d < 3.6) {
          // Closing speed along the line between the cars.
          const rvx = pv.fwd[0] * pv.speed - v.fwd[0] * v.speed, rvz = pv.fwd[1] * pv.speed - v.fwd[1] * v.speed;
          const closing = (rvx * dx + rvz * dz) / (d || 1);
          if (closing > 5) { dmg += closing * 3.5; u.hitCd = 0.6; }
        }
      }
      if (v.hitNow > 12) dmg += (v.hitNow - 12) * 4;  // crashed into something on its own
      v.hitNow = 0;
      if (!dmg) continue;
      u.hp -= dmg;
      if (u.hp <= 0) this._wreck(u);
    }
  }

  _wreck(u) {
    const v = u.v;
    u.mode = 'wreck'; u.t = 0;
    v.speed = 0;
    v.flash(false, 0);
    v.respray('#3a3a3c');
    v.tilt.rotation.set(0.08, 0, (Math.random() < 0.5 ? -1 : 1) * 0.35, 'XZY');
    v.root.rotation.y += (Math.random() - 0.5) * 0.9;
    if (this.onTakedown) this.onTakedown(u);
  }

  _spikeStrips(dt, player) {
    if (this.heat < 3) return;
    this.spikeT -= dt;
    if (this.spikeT > 0) return;
    this.spikeT = 3;
    const v = player.vehicle;
    if (!v || Math.abs(v.speed) < 10) return;
    const spot = this._roadAhead(v, 150 + Math.random() * 80);
    if (!spot) return;
    this.spikeT = SPIKE_EVERY - this.heat * 2;
    const { x, z, tx, tz, hw } = spot;
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, 0.05, 0.55), SPIKE_MAT.base);
    g.add(base);
    for (let i = -hw + 0.2; i < hw; i += 0.45) {
      const sp = new THREE.Mesh(SPIKE_GEO, SPIKE_MAT.spike);
      sp.position.set(i, 0.1, 0);
      g.add(sp);
    }
    const y = this.world.groundAt(x, z, this.world.elevation(x, z) + 8);
    g.position.set(x, y + 0.03, z);
    g.rotation.y = Math.atan2(tz, -tx) + Math.PI / 2;
    this.scene.add(g);
    this.spikes.push({ x, z, tx, tz, hw, mesh: g, t: 0 });
    this._flash('Spike strip ahead!');
  }

  _checkSpikes(dt, player) {
    const v = player.vehicle, p = player.pos;
    for (const sp of [...this.spikes]) {
      sp.t += dt;
      if (sp.t > 45 || Math.hypot(sp.x - p.x, sp.z - p.z) > 450) { this._removeSpikes(sp); continue; }
      if (!v || v.kind !== 'car' || v.flat) continue;
      const along = (v.x - sp.x) * sp.tx + (v.z - sp.z) * sp.tz, lat = (v.x - sp.x) * -sp.tz + (v.z - sp.z) * sp.tx;
      if (Math.abs(along) < 1.6 && Math.abs(lat) < sp.hw) {
        v.flat = true;
        if (this.onSpiked) this.onSpiked();
      }
    }
  }

  _removeSpikes(sp) {
    this.scene.remove(sp.mesh);
    sp.mesh.children[0].geometry.dispose();
    this.spikes = this.spikes.filter((o) => o !== sp);
  }

  // ---------- sound and HUD ----------

  _siren(player) {
    let near = Infinity;
    for (const u of this.units) if (u.mode === 'chase') near = Math.min(near, Math.hypot(u.v.x - player.pos.x, u.v.z - player.pos.z));
    this.siren.set(this.wanted ? clamp(1 - near / 180, 0, 1) : 0, this.heat >= 3);
  }

  _hud() {
    const h = this.hud;
    const show = this.wanted;
    h.box.classList.toggle('show', show);
    if (!show) return;
    h.stars.textContent = '★'.repeat(this.heat) + '☆'.repeat(5 - this.heat);
    const s = Math.floor(this.chase);
    h.time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    h.units.textContent = `${this.units.filter(ACTIVE).length} units`;
    if (this.bust > 0.05) {
      h.label.textContent = 'BUSTED'; h.meter.style.width = `${(this.bust / BUST_TIME) * 100}%`; h.box.dataset.meter = 'bust';
    } else if (this.cool > 0.05) {
      h.label.textContent = 'COOLDOWN'; h.meter.style.width = `${(this.cool / cooldownFor(this.heat)) * 100}%`; h.box.dataset.meter = 'cool';
    } else {
      h.label.textContent = 'PURSUIT'; h.meter.style.width = '0%'; h.box.dataset.meter = '';
    }
  }

  _flash(text) { if (this.hud.flash) this.hud.flash(text); }

  _banner(text) {
    const b = this.hud.banner;
    b.textContent = text;
    b.dataset.kind = text === 'BUSTED' ? 'bust' : 'escape';
    b.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => b.classList.remove('show'), 3000);
  }
}

const SPIKE_GEO = new THREE.ConeGeometry(0.05, 0.16, 4);
const SPIKE_MAT = {
  base: new THREE.MeshStandardMaterial({ color: '#2b2d30', roughness: 0.7 }),
  spike: new THREE.MeshStandardMaterial({ color: '#c9ccd0', metalness: 0.8, roughness: 0.3 }),
};

// Throttle/steer toward (tx, tz): steer by the side the target is on, ease off for sharp turns,
// reverse-turn when it's behind and close.
function steerTo(v, tx, tz, far, direct) {
  const [fx, fz] = v.fwd, [rx, rz] = v.right;
  const dx = tx - v.x, dz = tz - v.z, d = Math.hypot(dx, dz) || 1;
  const side = (dx * rx + dz * rz) / d, ahead = (dx * fx + dz * fz) / d;
  let steer = clamp(side * 2.2, -1, 1), throttle = ahead > 0.3 ? 1 : 0.45;
  if (ahead < -0.3) {
    if (direct && d < 25) { throttle = -1; steer = clamp(side * 2.2, -1, 1); }  // close behind: reverse into it
    // Behind: brake hard on full lock, then back up turning the other way (a three-point turn).
    else if (v.speed > 4) { throttle = -1; steer = Math.sign(side || 1); }
    else { throttle = -0.9; steer = -Math.sign(side || 1); }
  }
  if (Math.abs(side) > 0.55 && Math.abs(v.speed) > 13) throttle = -0.4;
  if (far < 12 && Math.abs(v.speed) > 8) throttle = 0.2;  // don't fly past
  return { throttle, steer, brake: false };
}

// Road route for vehicle v to (gx, gz): A* over car-road vertices of loaded chunks, starting
// preferably ahead of the vehicle (turning around costs extra). Returns points.
function route(world, v, gx, gz) {
  const x = v.x, z = v.z, [fx, fz] = v.fwd;
  const start = world.nearestRoad(x, z, 50), goal = world.nearestRoad(gx, gz, 50);
  if (!start || !goal) return null;
  const vkey = (p) => nodeKey(p[0], p[1]);
  const sp = start.road.p, gp = goal.road.p;
  const s0 = sp[start.seg], s1 = sp[start.seg + 1];
  const goalKeys = new Set([vkey(gp[goal.seg]), vkey(gp[goal.seg + 1])]);
  const open = new Heap(), g = new Map(), came = new Map(), pos = new Map();
  for (const p of [s0, s1]) {
    const k = vkey(p), behind = (p[0] - x) * fx + (p[1] - z) * fz < 0;
    g.set(k, Math.hypot(p[0] - x, p[1] - z) + (behind ? 60 : 0)); pos.set(k, p);
    open.push(k, g.get(k) + Math.hypot(p[0] - gx, p[1] - gz));
  }
  let found = null;
  for (let n = 0; n < 4000 && open.size; n++) {
    const k = open.pop();
    if (goalKeys.has(k)) { found = k; break; }
    const here = pos.get(k), gk = g.get(k);
    for (const { road, k: i } of world.nodes.get(k) || []) {
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= road.p.length) continue;
        const q = road.p[j], nk = vkey(q);
        const cost = gk + Math.hypot(q[0] - here[0], q[1] - here[1]);
        if (cost < (g.get(nk) ?? Infinity)) {
          g.set(nk, cost); came.set(nk, k); pos.set(nk, q);
          open.push(nk, cost + Math.hypot(q[0] - gx, q[1] - gz));
        }
      }
    }
  }
  if (!found) return null;
  const path = [[gx, gz]];
  for (let k = found; k; k = came.get(k)) path.unshift(pos.get(k));
  return path;
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(v, p) {
    const a = this.a; a.push([p, v]);
    for (let i = a.length - 1; i > 0;) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top[1];
  }
}

// A two-tone siren made in the browser (no sound files). Browsers allow sound only after a user
// gesture, so call unlock() from one. `on` mutes it.
export class Siren {
  constructor() { this.ctx = null; this.on = true; }
  unlock() {
    if (this.ctx) return;
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator(), lfo = ctx.createOscillator(), depth = ctx.createGain();
      const filter = ctx.createBiquadFilter(), gain = ctx.createGain();
      osc.type = 'sawtooth'; osc.frequency.value = 900;
      lfo.type = 'sine'; lfo.frequency.value = 0.35; depth.gain.value = 320;
      filter.type = 'lowpass'; filter.frequency.value = 2200;
      gain.gain.value = 0;
      lfo.connect(depth).connect(osc.frequency);
      osc.connect(filter).connect(gain).connect(ctx.destination);
      osc.start(); lfo.start();
      Object.assign(this, { ctx, lfo, gain });
    } catch { /* no audio */ }
  }
  set(level, yelp = false) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(this.on ? level * 0.07 : 0, now, 0.15);
    this.lfo.frequency.setTargetAtTime(yelp ? 3 : 0.35, now, 0.3);
  }
}
