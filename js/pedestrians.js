// A small local population on verified, continuous sidewalks and footpaths. No network calls.
import * as THREE from 'three';
import { Character } from './character.js';
import { personSpec } from './people.js';
import { clamp, angleDelta, rng, damp } from './util.js';

export class Pedestrians {
  constructor(scene, mobile = false) {
    this.scene = scene;
    this.capacity = mobile ? 4 : 8;
    this.pool = [];
    this.R = rng(48291);
    this.mobile = mobile;
    this.frustum = new THREE.Frustum();
    this.viewProjection = new THREE.Matrix4();
    this.bounds = new THREE.Sphere(new THREE.Vector3(), 3.5);
    this.clear();
  }

  clear() {
    for (const p of this.pool) { p.active = false; p.char.root.visible = false; }
    this.spawnT = 0;
    this.scanT = 0;
    this.routes = [];
  }

  get stats() {
    const active = this.pool.filter(p => p.active);
    return { active: active.length, capacity: this.capacity, types: [...new Set(active.map(p => p.spec.type))],
      looks: [...new Set(active.map(p => p.char.look))] };
  }

  _safe(w, x, z, y = null, obstacles = true) {
    if (!w.near(x, z).length || w.onRoad(x, z, -0.2)) return false;
    if (!w.onSidewalk(x, z) && !w.nearPath(x, z, 0)) return false;
    const b = w.buildingAt(x, z);
    if (b?.solid || (obstacles && w.blocked(x, z, 0.3))) return false;
    return y === null || Math.abs(w.groundAt(x, z) - y) < 0.65;
  }

  _spawn(world, player) {
    const R = this.R, pos = player.pos;
    for (let attempt = 0; attempt < 12 && this.routes.length; attempt++) {
      const s = this.routes[Math.floor(R() * this.routes.length)];
      const dx = s.bx - s.ax, dz = s.bz - s.az, len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const ux = dx / len, uz = dz / len;
      // Generated sidewalks are split into tiny segments. Extend their tangent, then verify
      // the entire short route against the actual sidewalk instead of requiring one long edge.
      const nearest = clamp((pos.x - s.ax) * ux + (pos.z - s.az) * uz, 0, len);
      const center = len > 20 ? clamp(nearest + (R() - 0.5) * 130, 6, len - 6) : len / 2;
      const from = center - 6, to = center + 6;
      const side = (R() - 0.5) * Math.min(1, Math.max(0, s.hw * 2 - 1));
      const a = { x: s.ax + ux * from - uz * side, z: s.az + uz * from + ux * side };
      const b = { x: s.ax + ux * to - uz * side, z: s.az + uz * to + ux * side };
      const t = 0.15 + R() * 0.7, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const d = Math.hypot(x - pos.x, z - pos.z);
      if (d < 18 || d > 90) continue;
      const front = ((x - pos.x) * -Math.sin(player.camYaw) + (z - pos.z) * -Math.cos(player.camYaw)) / d;
      if (d < 42 && front > 0.4) continue;
      if (this.pool.some(p => p.active && Math.hypot(p.x - x, p.z - z) < 9)) continue;
      let safe = true, prev = null;
      const samples = Math.ceil((to - from) / 1.5);
      for (let i = 0; i <= samples; i++) {
        const q = i / samples, px = a.x + (b.x - a.x) * q, pz = a.z + (b.z - a.z) * q;
        if (!this._safe(world, px, pz, prev)) { safe = false; break; }
        prev = world.groundAt(px, pz);
      }
      if (!safe) continue;
      let p = this.pool.find(p => !p.active);
      if (!p) {
        if (this.pool.length >= this.capacity) return;
        const spec = personSpec(48292 + this.pool.length * 7919);
        // Give the small population a balanced set of silhouettes before repeating a base.
        spec.look = ['man', 'woman', 'harper', 'jordan'][this.pool.length % 4];
        const char = new Character(spec.look, { ...spec, low: true, shadows: false });
        this.scene.add(char.root);
        // Background people do not need their own shadow-map draws.
        char.ready.then(() => char.root.traverse(o => { if (o.isMesh) o.castShadow = false; }));
        p = { char, spec }; this.pool.push(p);
      }
      Object.assign(p, { active: true, a, b, x, z, y: world.groundAt(x, z), dir: R() < 0.5 ? 1 : -1,
        wait: R() * 2, speed: 0, walk: p.spec.pace, blocked: 0, animDT: 0, alarm: 0, onScreen: false,
        yaw: Math.atan2(-ux, -uz) });
      p.char.root.visible = true;
      p.char.root.position.set(x, p.y, z);
      return;
    }
  }

  _continue(p, world) {
    const end = p.dir > 0 ? p.b : p.a, start = p.dir > 0 ? p.a : p.b;
    const angle = Math.atan2(end.z - start.z, end.x - start.x);
    // Probe a short fan at the next corner; validate the entire route, including curbs and
    // buildings. This works with both tiny generated sidewalk edges and mapped footpaths.
    const side = this.R() < 0.5 ? 1 : -1;
    for (const turn of [0, side * Math.PI / 6, -side * Math.PI / 6, side * Math.PI / 3,
      -side * Math.PI / 3, side * Math.PI / 2, -side * Math.PI / 2]) {
      const ux = Math.cos(angle + turn), uz = Math.sin(angle + turn);
      let length = 0, y = p.y;
      for (let d = 1; d <= 14; d++) {
        const x = p.x + ux * d, z = p.z + uz * d;
        if (!this._safe(world, x, z, y)) break;
        y = world.groundAt(x, z); length = d;
      }
      if (length < 4) continue;
      p.a = { x: p.x, z: p.z }; p.b = { x: p.x + ux * length, z: p.z + uz * length }; p.dir = 1;
      return true;
    }
    p.dir *= -1;
    return false;
  }

  update(dt, world, player, traffic, camera = null) {
    const pos = player.pos;
    if (camera) {
      camera.updateMatrixWorld();
      this.frustum.setFromProjectionMatrix(this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    }
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 3;
      this.routes = [];
      for (const ch of world.near(pos.x, pos.z, 100)) {
        this.routes.push(...ch.raised.near(pos.x, pos.z, 100).filter(s => s.hw > 0.45));
        this.routes.push(...ch.pathSegs.near(pos.x, pos.z, 100).filter(s => !s.road.ez &&
          ['sidewalk', 'path'].includes(s.road.kind) && !['cycleway', 'steps'].includes(s.road.t)));
      }
    }
    this.spawnT -= dt;
    if (this.spawnT <= 0 && this.stats.active < this.capacity) { this.spawnT = 0.7; this._spawn(world, player); }
    for (const p of this.pool) {
      if (!p.active) continue;
      if (Math.hypot(p.x - pos.x, p.z - pos.z) > 125 || !this._safe(world, p.x, p.z, null, false)) {
        p.active = false; p.char.root.visible = false; continue;
      }
      const approaching = c => {
        if (!c || Math.abs(c.speed) < 3 || Math.abs(c.y - p.y) > 2) return false;
        const [fx, fz] = c.fwd || [c.fx, c.fz], dx = p.x - c.x, dz = p.z - c.z;
        const ahead = (dx * fx + dz * fz) * Math.sign(c.speed);
        return ahead > -1 && ahead < 8 && Math.abs(dx * fz - dz * fx) < 1.8;
      };
      const car = approaching(player.vehicle) ? player.vehicle : traffic.cars.find(approaching);
      const danger = !!car;
      p.alarm = Math.max(0, p.alarm - dt);
      if (danger) {
        const da = Math.hypot(p.a.x - car.x, p.a.z - car.z), db = Math.hypot(p.b.x - car.x, p.b.z - car.z);
        p.dir = db > da ? 1 : -1; p.wait = 0; p.alarm = 1.5;
      }
      p.wait = Math.max(0, p.wait - dt);
      const target = p.dir > 0 ? p.b : p.a;
      const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz);
      if (d < 0.35 && p.wait === 0) {
        const continues = this._continue(p, world);
        if (!p.alarm && (!continues || this.R() < 0.18)) p.wait = p.spec.pause;
      }
      const desired = d > 0.35 && p.wait === 0 ? (p.alarm ? 3.4 : p.walk) : 0;
      const speed = damp(p.speed, Math.min(desired, Math.sqrt(3 * d)), 5, dt);
      let ux = dx / (d || 1), uz = dz / (d || 1);
      // Anticipatory personal space: pass on the right when the sidewalk has room.
      for (const q of this.pool) if (q !== p && q.active) {
        const qx = q.x - p.x, qz = q.z - p.z, ahead = qx * ux + qz * uz;
        if (ahead > 0 && ahead < 2 && Math.abs(qx * uz - qz * ux) < 0.8) {
          const sideX = -uz * 0.6, sideZ = ux * 0.6;
          if (this._safe(world, p.x + ux + sideX, p.z + uz + sideZ, p.y)) {
            ux += sideX; uz += sideZ;
          }
        }
      }
      const norm = Math.hypot(ux, uz) || 1; ux /= norm; uz /= norm;
      const step = Math.min(d, speed * dt), x = p.x + ux * step, z = p.z + uz * step;
      const crowded = this.pool.some(q => q !== p && q.active && Math.hypot(q.x - x, q.z - z) < 0.7);
      const playerNear = !player.vehicle && Math.hypot(pos.x - x, pos.z - z) < 0.8;
      if (!crowded && !playerNear && this._safe(world, x, z, p.y)) {
        p.x = x; p.z = z; p.y = world.groundAt(x, z); p.blocked = 0;
        p.speed = speed;
      } else {
        p.speed = 0; p.blocked += dt;
        if (p.blocked > 1.5) { p.dir *= -1; p.wait = 0.5; p.blocked = 0; }
      }
      if (p.speed > 0.05) p.yaw += angleDelta(p.yaw, Math.atan2(-ux, -uz)) * (1 - Math.exp(-5 * dt));
      p.char.root.position.set(p.x, p.y, p.z); p.char.root.rotation.y = p.yaw;
      const distance = Math.hypot(pos.x - p.x, pos.z - p.z);
      const gaze = distance < 6 ? angleDelta(p.yaw, Math.atan2(p.x - pos.x, p.z - pos.z)) : 0;
      p.char.setGaze(Math.abs(gaze) < 1.3 ? gaze : 0);
      p.animDT += dt;
      this.bounds.center.set(p.x, p.y + 0.9, p.z);
      const onScreen = !camera || this.frustum.intersectsSphere(this.bounds);
      // Off-screen pedestrians keep moving/reacting, but need neither per-frame
      // foot IK nor frequent skin animation. Refresh immediately before reentry.
      const interval = onScreen ? (distance > 45 || this.mobile ? 1 / 15 : 1 / 30) : 0.2;
      if (p.animDT >= interval || (onScreen && !p.onScreen)) {
        p.char.update(p.animDT, p.speed, false, onScreen ? world : null); p.animDT = 0;
      } else if (onScreen) p.char.fitGround(world);
      p.onScreen = onScreen;
    }
  }
}
