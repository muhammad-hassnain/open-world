// Traffic: cars driving the streets around the player, and traffic lights.
// Cars follow car roads through the World's road nodes (so they cross chunk borders), keep to the
// right-hand lane, choose a way at junctions, stop at red lights, keep their distance from
// whatever is ahead (other cars, the player) and are drawn instanced from the car models.
// Each player has their own traffic; it isn't shared over the network.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { nodeKey, signalState } from './world.js';
import { CAR_TYPES, carsLoaded, parkedCarMesh, parkedCarLights } from './vehicles.js';
import { clamp, damp, angleDelta, rng } from './util.js';

const COUNT = 20;              // cars around the player
const SPAWN_MIN = 40, SPAWN_MAX = 220, DESPAWN = 300;
const LOOK = 40;               // meters ahead checked for junctions
const ACCEL = 2.4, DECEL = 7;  // m/s²
const LENGTH = 4.6;            // car length for gaps
const SPEED = { motorway: 27, motorway_link: 15, trunk: 22, trunk_link: 13, primary: 15, primary_link: 11,
  secondary: 14, secondary_link: 10, tertiary: 12, tertiary_link: 9 };
const speedOf = (r) => SPEED[r.t] || 9;
const CIRCLES = [-1.5, 0, 1.5];

export class Traffic {
  constructor({ scene, world }) {
    this.scene = scene;
    this.world = world;
    this.cars = [];
    this.meshes = new Map();   // car type -> InstancedMesh
    this.time = 0;
    this.spawnT = 0;
    this.patrols = 2;          // police cars among the traffic (police.js turns this off in a chase)
    this.lightsOn = false;     // headlights at night (atmosphere.js)
    this.lightMeshes = new Map();  // car type -> [head, tail] InstancedMeshes
    this.R = rng(12345);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1);
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    world.obstacles.add(this);
  }

  // Footprint circles of every car, for collisions (World.resolveCircle); refreshed each frame.
  circles() { return this._circles || []; }

  dispose() {
    this.world.obstacles.delete(this);
    for (const m of this.meshes.values()) { this.scene.remove(m); m.dispose(); }
    this.meshes.clear();
    for (const pair of this.lightMeshes.values()) for (const m of pair) { this.scene.remove(m); m.dispose(); }
    this.lightMeshes.clear();
    this.cars = [];
  }

  // The traffic car whose footprint is within maxD of (x, z), or null.
  nearest(x, z, maxD) {
    let best = null, bd = maxD;
    for (const c of this.cars) {
      if (c.type === 'police') continue;  // patrol cars can't be taken
      for (const o of CIRCLES) {
        const d = Math.hypot(x - (c.x + c.fx * o), z - (c.z + c.fz * o)) - 0.92;
        if (d < bd) { bd = d; best = c; }
      }
    }
    return best;
  }

  // Take a car out of traffic (the player gets in): returns its type and pose.
  take(car) {
    this.cars = this.cars.filter((c) => c !== car);
    return { type: car.type, x: car.x, z: car.z, yaw: Math.atan2(-car.fx, -car.fz) };
  }

  update(dt, player) {
    this.time += dt;  // also drives the traffic lights
    if (!carsLoaded()) return;
    const p = player.pos;
    this.cars = this.cars.filter((c) => !c.road.dead && Math.hypot(c.x - p.x, c.z - p.z) < DESPAWN);
    this.spawnT -= dt;
    if (this.spawnT <= 0 && this.cars.length < COUNT) {
      this.spawnT = this.cars.length < COUNT / 2 ? 0.05 : 0.4;
      this._spawn(p, player);
    }
    for (const c of this.cars) this._drive(c, dt, player);
    this._circles = [];
    for (const c of this.cars) for (const o of CIRCLES) this._circles.push({ x: c.x + c.fx * o, z: c.z + c.fz * o, r: 0.92 });
    this._draw();
  }

  // ---------- spawning ----------

  _spawn(p, player) {
    const R = this.R, w = this.world;
    const chunks = w.near(p.x, p.z, SPAWN_MAX);
    if (!chunks.length) return;
    const camFx = -Math.sin(player.camYaw), camFz = -Math.cos(player.camYaw);
    for (let tries = 0; tries < 12; tries++) {
      const ch = chunks[Math.floor(R() * chunks.length)];
      if (!ch.carRoads.length) continue;
      const road = ch.carRoads[Math.floor(R() * ch.carRoads.length)];
      if (road.p.length < 2 || road.t === 'service') continue;
      const k = Math.floor(R() * (road.p.length - 1));
      const a = road.p[k], b = road.p[k + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 8) continue;
      const s = 2 + R() * (len - 4);
      const x = a[0] + ((b[0] - a[0]) * s) / len, z = a[1] + ((b[1] - a[1]) * s) / len;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      // Don't pop up in plain view close by.
      if (d < 120 && ((x - p.x) * camFx + (z - p.z) * camFz) / d > 0.5) continue;
      if (this.cars.some((c) => Math.hypot(c.x - x, c.z - z) < 25)) continue;
      const dir = road.ow ? 1 : R() < 0.5 ? 1 : -1;
      const patrols = this.cars.filter((c) => c.type === 'police').length;
      const type = patrols < this.patrols ? 'police' : CAR_TYPES[Math.floor(R() * CAR_TYPES.length)];
      const car = { type, road, k: dir > 0 ? k : k + 1, dir, s: dir > 0 ? s : len - s, speed: speedOf(road) * 0.8,
        x, z, fx: 0, fz: -1, y: 0, pitch: 0, lane: 0, stun: 0, cruise: speedOf(road) * (0.85 + R() * 0.25) };
      this._place(car, true);
      this.cars.push(car);
      return;
    }
  }

  // ---------- driving ----------

  // Segment the car is on: from p[k] toward p[k + dir].
  _seg(c) {
    const a = c.road.p[c.k], b = c.road.p[c.k + c.dir];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1e-6;
    return { a, b, tx: dx / len, tz: dz / len, len };
  }

  _place(c, snap) {
    const g = this._seg(c);
    const lane = c.road.ow ? 0 : c.road.hw * 0.28;
    const x = g.a[0] + g.tx * c.s - g.tz * lane, z = g.a[1] + g.tz * c.s + g.tx * lane;  // right of travel
    const w = this.world;
    if (snap) { c.x = x; c.z = z; c.fx = g.tx; c.fz = g.tz; }
    else {
      c.x = damp(c.x, x, 10, this._dt); c.z = damp(c.z, z, 10, this._dt);
      const yaw = Math.atan2(c.fx, c.fz), target = Math.atan2(g.tx, g.tz);
      const ny = yaw + angleDelta(yaw, target) * (1 - Math.exp(-8 * this._dt));
      c.fx = Math.sin(ny); c.fz = Math.cos(ny);
    }
    const hf = w.elevation(c.x + c.fx * 1.6, c.z + c.fz * 1.6), hb = w.elevation(c.x - c.fx * 1.6, c.z - c.fz * 1.6);
    c.y = (hf + hb) / 2;
    c.pitch = Math.atan2(hf - hb, 3.2);
  }

  // Is this node a junction (more than one road meets), and the node's entries.
  _junction(key) {
    const list = this.world.nodes.get(key);
    if (!list || list.length < 2) return null;
    const ids = new Set(list.map((e) => e.road.id));
    return ids.size >= 2 || list.length >= 3 ? list : null;
  }

  // Distance to the next junction ahead along the road (within LOOK m), and its node.
  _nextJunction(c) {
    const r = c.road;
    let d = this._seg(c).len - c.s, k = c.k + c.dir;
    while (d < LOOK) {
      const p = r.p[k];
      const key = nodeKey(p[0], p[1]);
      if (this._junction(key)) return { d, x: p[0], z: p[1] };
      const n = k + c.dir;
      if (n < 0 || n >= r.p.length) return null;  // road ends: continues in the next chunk, checked then
      d += Math.hypot(r.p[n][0] - p[0], r.p[n][1] - p[1]);
      k = n;
    }
    return null;
  }

  _drive(c, dt, player) {
    this._dt = dt;
    let target = c.cruise;
    if (c.stun > 0) { c.stun -= dt; target = 0; }

    // Junction ahead: slow down to yield, or stop at a red light.
    const j = this._nextJunction(c);
    if (j) {
      const sig = this.world.signalAt(j.x, j.z);
      if (sig) {
        const ax = -c.fx, az = -c.fz;  // the arm we arrive on points back toward us
        const axis = Math.abs(ax * sig.ref.ux + az * sig.ref.uz) > 0.7 ? 0 : 1;
        const state = signalState(sig, axis, this.time);
        const stopAt = j.d - (sig.radius + 3);
        if (state === 'red' || (state === 'yellow' && stopAt > 6)) {
          if (stopAt > -1) target = Math.min(target, Math.sqrt(2 * DECEL * 0.6 * Math.max(0, stopAt - 0.5)));
        }
      } else if (j.d < 14) {
        target = Math.min(target, 4.5);
      }
    }

    // Something ahead in our lane: keep the gap.
    const gap = this._gapAhead(c, player);
    if (gap < 30) target = Math.min(target, Math.max(0, (gap - 2.5) * 0.9));

    c.speed = c.speed < target ? Math.min(target, c.speed + ACCEL * dt) : Math.max(target, c.speed - DECEL * dt);
    c.s += c.speed * dt;
    // Past the end of the segment: next vertex, maybe a junction.
    for (let guard = 0; guard < 4 && c.s >= this._seg(c).len; guard++) {
      c.s -= this._seg(c).len;
      if (!this._advance(c)) { c.road = { dead: true }; return; }
    }
    this._place(c, false);
  }

  _advance(c) {
    const r = c.road, kb = c.k + c.dir;
    const pb = r.p[kb];
    const list = this.world.nodes.get(nodeKey(pb[0], pb[1])) || [];
    const inX = c.fx, inZ = c.fz;
    const options = [];
    for (const { road, k } of list) {
      if (road.dead || road.t === 'service') continue;
      for (const d of [1, -1]) {
        const n = k + d;
        if (n < 0 || n >= road.p.length) continue;
        if (road.ow && d < 0) continue;
        if (road === r && k === kb && d === -c.dir) continue;  // straight back
        const dx = road.p[n][0] - road.p[k][0], dz = road.p[n][1] - road.p[k][1], l = Math.hypot(dx, dz) || 1;
        const turn = Math.acos(clamp((dx * inX + dz * inZ) / l, -1, 1));
        if (turn > 2.6) continue;  // no U-turns here
        options.push({ road, k, d, turn });
      }
    }
    if (!options.length) {
      // Dead end (or the road leaves the loaded area): turn around if two-way.
      if (r.ow || kb + c.dir < 0 || kb + c.dir >= r.p.length) {
        if (r.ow) return false;
        c.k = kb; c.dir = -c.dir; c.speed = 0; return true;
      }
      c.k = kb; return true;
    }
    // Mostly straight on; sometimes turn.
    const weights = options.map((o) => (o.turn < 0.5 ? 3 : 1));
    let pick = this.R() * weights.reduce((a, b) => a + b, 0), o = options[0];
    for (let i = 0; i < options.length; i++) { pick -= weights[i]; if (pick <= 0) { o = options[i]; break; } }
    if (o.road !== r) c.cruise = speedOf(o.road) * (0.85 + this.R() * 0.25);
    c.road = o.road; c.k = o.k; c.dir = o.d;
    return true;
  }

  // Free distance ahead in our lane to the nearest car, player or parked vehicle.
  _gapAhead(c, player) {
    let best = Infinity;
    const test = (x, z, len) => {
      const rx = x - c.x, rz = z - c.z;
      const along = rx * c.fx + rz * c.fz, lat = Math.abs(rx * c.fz - rz * c.fx);
      if (along > 0 && along < 35 && lat < 1.9) best = Math.min(best, along - len);
    };
    for (const o of this.cars) if (o !== c) test(o.x, o.z, LENGTH);
    if (player) {
      const v = player.vehicle;
      if (v) test(v.x, v.z, v.kind === 'car' ? LENGTH : 2.5); else test(player.pos.x, player.pos.z, 2.6);
    }
    for (const ob of this.world.obstacles) if (ob !== this && ob.kind) test(ob.x, ob.z, ob.kind === 'car' ? LENGTH : 2.5);
    return best;
  }

  // A car hit by the player stops for a moment.
  bump(x, z, r) {
    for (const c of this.cars) if (Math.hypot(c.x - x, c.z - z) < r + 2.6) { c.stun = 3; c.speed = 0; }
  }

  // ---------- drawing ----------

  _draw() {
    const byType = new Map();
    for (const c of this.cars) {
      if (!byType.has(c.type)) byType.set(c.type, []);
      byType.get(c.type).push(c);
    }
    for (const type of new Set([...byType.keys(), ...this.meshes.keys()])) {
      const list = byType.get(type) || [];
      let mesh = this.meshes.get(type);
      if (!mesh && list.length) {
        const { geometry, material } = parkedCarMesh(type);
        mesh = new THREE.InstancedMesh(geometry, material, 48);
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        this.meshes.set(type, mesh);
      }
      if (!mesh) continue;
      const n = Math.min(list.length, 48);
      for (let i = 0; i < n; i++) {
        const c = list[i];
        // The parked-car geometry points along +X; yaw it onto (fx, fz) and pitch with the road.
        this._e.set(0, Math.atan2(-c.fz, c.fx), 0);
        this._q.setFromEuler(this._e).multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, c.pitch));
        this._m.compose(this._p.set(c.x, c.y, c.z), this._q, this._s);
        mesh.setMatrixAt(i, this._m);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      // Headlights and taillights follow the same matrices (shown at night).
      let lights = this.lightMeshes.get(type);
      if (!lights) {
        const L = parkedCarLights(type);
        lights = [new THREE.InstancedMesh(L.head, L.headMat, 48), new THREE.InstancedMesh(L.tail, L.tailMat, 48)];
        for (const m of lights) { m.frustumCulled = false; this.scene.add(m); }
        this.lightMeshes.set(type, lights);
      }
      for (const m of lights) {
        m.visible = this.lightsOn;
        if (!this.lightsOn) continue;
        for (let i = 0; i < n; i++) { mesh.getMatrixAt(i, this._m); m.setMatrixAt(i, this._m); }
        m.count = n;
        m.instanceMatrix.needsUpdate = true;
      }
    }
  }
}
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// ---------- traffic lights ----------

const POLE = '#30353a';
let LIGHT_ASSETS = null;
function lightAssets() {
  if (LIGHT_ASSETS) return LIGHT_ASSETS;
  const mat = new THREE.MeshStandardMaterial({ color: POLE, roughness: 0.6, metalness: 0.4 });
  mat.userData.shared = true;
  const pole = new THREE.CylinderGeometry(0.07, 0.09, 4.2, 8).translate(0, 2.1, 0);
  const head = new THREE.BoxGeometry(0.34, 1.0, 0.3).translate(0, 4.3, 0);
  const visor = new THREE.BoxGeometry(0.36, 0.04, 0.2).translate(0, 4.82, 0.18);
  const body = mergeGeometries([pole, head, visor]);
  body.userData.shared = true;
  const lamp = new THREE.SphereGeometry(0.11, 10, 8);
  lamp.userData.shared = true;
  const lampMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  lampMat.userData.shared = true;
  LIGHT_ASSETS = { body, mat, lamp, lampMat };
  return LIGHT_ASSETS;
}

const COLORS = {
  red: [new THREE.Color('#ff2a1a').multiplyScalar(2.2), new THREE.Color('#3a1210')],
  yellow: [new THREE.Color('#ffc21a').multiplyScalar(2.2), new THREE.Color('#3a2e10')],
  green: [new THREE.Color('#2aff6a').multiplyScalar(2.2), new THREE.Color('#103a1c')],
};
const LAMP_Y = { red: 4.6, yellow: 4.3, green: 4.0 };

// Poles and lamps for a chunk's traffic lights, one per arm, on the right as you arrive. Returns
// { meshes, heads } for updateLights().
export function buildLights(world, chunk, group) {
  const A = lightAssets();
  const heads = [];
  for (const sig of chunk.signals) {
    for (const arm of sig.arms) {
      const back = sig.radius + 2.2;
      // Arriving traffic drives along -arm; its right side is (arm.uz, -arm.ux).
      const x = sig.x + arm.ux * back + arm.uz * (arm.hw + 0.7);
      const z = sig.z + arm.uz * back - arm.ux * (arm.hw + 0.7);
      if (world.buildingAt(x, z)) continue;
      heads.push({ sig, axis: arm.axis, x, z, y: world.groundAt(x, z), yaw: Math.atan2(arm.ux, arm.uz), state: null });
    }
  }
  if (!heads.length) return null;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  const body = new THREE.InstancedMesh(A.body, A.mat, heads.length);
  heads.forEach((h, i) => {
    q.setFromAxisAngle(up, h.yaw);
    body.setMatrixAt(i, m.compose(new THREE.Vector3(h.x, h.y, h.z), q, s));
  });
  body.castShadow = true;
  group.add(body);
  const lamps = {};
  for (const color of ['red', 'yellow', 'green']) {
    const mesh = new THREE.InstancedMesh(A.lamp, A.lampMat, heads.length);
    heads.forEach((h, i) => {
      // Lamp on the face toward arriving traffic (+arm, which is +Z after the yaw).
      const lx = h.x + Math.sin(h.yaw) * 0.17, lz = h.z + Math.cos(h.yaw) * 0.17;
      mesh.setMatrixAt(i, m.compose(new THREE.Vector3(lx, h.y + LAMP_Y[color], lz), q.identity(), s));
      mesh.setColorAt(i, COLORS[color][1]);
    });
    group.add(mesh);
    lamps[color] = mesh;
  }
  // Collide with the poles.
  for (const h of heads) chunk.addCircleCollider(h.x, h.z, 0.15);
  return { heads, lamps };
}

// Switch lamps to the current light (cheap: only heads whose state changed).
export function updateLights(set, t) {
  let dirty = false;
  set.heads.forEach((h, i) => {
    const state = signalState(h.sig, h.axis, t);
    if (state === h.state) return;
    h.state = state;
    for (const color of ['red', 'yellow', 'green']) set.lamps[color].setColorAt(i, COLORS[color][state === color ? 0 : 1]);
    dirty = true;
  });
  if (dirty) for (const color of ['red', 'yellow', 'green']) set.lamps[color].instanceColor.needsUpdate = true;
}
