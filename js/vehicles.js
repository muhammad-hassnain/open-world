// Cars and bicycles: models, arcade driving and their place in the world.
// Cars are Kenney's "Car Kit" (CC0, assets/vehicles/), stretched to real-world proportions; the
// bicycle is built here. A Vehicle faces -Z at yaw 0, like the player; its root sits on the ground.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp, lerp } from './util.js';

export const CAR_TYPES = ['sedan', 'hatchback-sports', 'suv', 'suv-luxury', 'taxi', 'van'];
const BODY_SCALE = new THREE.Vector3(1.25, 1.15, 1.7);  // the kit's cars are short and wide
const WHEEL_SCALE = 1.15;

// Driving: speeds in m/s, rates in m/s², steering in radians, circles = collision footprint
// (offsets along the vehicle from its center, radius).
const SPECS = {
  car: { maxFwd: 25, maxRev: 6, accel: 7, brake: 16, coast: 2.5, hand: 12, wheelbase: 2.6, track: 1.6,
    steerLow: 0.6, steerHigh: 0.16, circles: [-1.5, 0, 1.5], r: 0.92, seat: null },
  bike: { maxFwd: 8, maxRev: 1.5, accel: 3.5, brake: 9, coast: 1.2, hand: 8, wheelbase: 1.1, track: 0.1,
    steerLow: 0.7, steerHigh: 0.25, circles: [-0.45, 0.45], r: 0.38, seat: 0.92 },
};
export const VEHICLE_SPECS = SPECS;

// How each car model drives: top speed (m/s), acceleration, steering (x the base), grip (how fast
// the steering responds), body roll in turns (x), camera distance.
export const CAR_MODELS = {
  sedan: { label: 'Sedan', maxFwd: 30, accel: 7, steer: 1, grip: 6, roll: 1, cam: 7.5 },
  'hatchback-sports': { label: 'Sports hatchback', maxFwd: 40, accel: 11, steer: 1.12, grip: 10, roll: 0.45, cam: 7 },
  suv: { label: 'SUV', maxFwd: 28, accel: 6, steer: 0.85, grip: 5, roll: 1.5, cam: 8.2 },
  'suv-luxury': { label: 'Luxury SUV', maxFwd: 35, accel: 8.5, steer: 0.92, grip: 6.5, roll: 1, cam: 8.2 },
  taxi: { label: 'Taxi', maxFwd: 31, accel: 7, steer: 1, grip: 6, roll: 1, cam: 7.5 },
  van: { label: 'Van', maxFwd: 23, accel: 4.5, steer: 0.75, grip: 4, roll: 1.9, cam: 9 },
};

// ---------- car models ----------

const loader = new GLTFLoader();
let carsPromise = null;
const cars = new Map();  // type -> { body: geometry, wheels: [{ name, geometry, position }], material }

// Load the car models once; resolves when all are ready (failed ones are skipped).
export function loadCars() {
  if (carsPromise) return carsPromise;
  carsPromise = Promise.all(CAR_TYPES.map((t) => loader.loadAsync(`assets/vehicles/${t}.glb`).then((g) => {
    const out = { wheels: [] };
    g.scene.updateMatrixWorld(true);
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.material.envMapIntensity = 0.7;
      o.material.userData.shared = true;
      out.material = o.material;
      const geo = o.geometry.clone();
      geo.userData.shared = true;
      if (o.name.startsWith('wheel')) {
        geo.scale(WHEEL_SCALE, WHEEL_SCALE, WHEEL_SCALE);
        const p = o.getWorldPosition(new THREE.Vector3()).multiply(BODY_SCALE);
        out.wheels.push({ name: o.name, geometry: geo, position: p });
      } else {
        geo.applyMatrix4(o.matrixWorld);
        geo.scale(BODY_SCALE.x, BODY_SCALE.y, BODY_SCALE.z);
        out.body = geo;
      }
    });
    if (out.body) cars.set(t, out);
  }).catch((e) => console.warn(`Car ${t} didn't load: ${e.message}`)))).then(() => cars);
  return carsPromise;
}

export const carsLoaded = () => cars.size > 0;
export const carType = (seed) => [...cars.keys()][Math.floor(seed * cars.size) % cars.size];

// One merged geometry per car type for parked cars, rotated so the car points along +X.
const parked = new Map();
export function parkedCarMesh(type) {
  if (!parked.has(type)) {
    const c = cars.get(type);
    const parts = [c.body.clone(), ...c.wheels.map((w) => w.geometry.clone().translate(w.position.x, w.position.y, w.position.z))];
    const g = mergeGeometries(parts.map((p) => p.index ? p.toNonIndexed() : p), false);
    g.rotateY(Math.PI / 2);
    g.userData.shared = true;
    parked.set(type, { geometry: g, material: c.material });
  }
  return parked.get(type);
}

// ---------- bicycle model ----------

function tube(a, b, r, mat) {
  const d = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 8), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  m.castShadow = true;
  return m;
}

function bikeModel(color = '#ff7a45') {
  const frame = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: '#1d1f22', roughness: 0.85 });
  const metal = new THREE.MeshStandardMaterial({ color: '#b9bdc2', roughness: 0.35, metalness: 0.8 });
  const g = new THREE.Group();
  const R = 0.34, wb = SPECS.bike.wheelbase;
  const wheel = (z) => {
    const w = new THREE.Group();
    w.position.set(0, R, z);
    const tire = new THREE.Mesh(new THREE.TorusGeometry(R - 0.02, 0.028, 8, 28), dark);
    tire.rotation.y = Math.PI / 2;
    tire.castShadow = true;
    w.add(tire);
    for (let i = 0; i < 6; i++) {  // spokes
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.008, (R - 0.04) * 2, 0.008), metal);
      s.rotation.x = (i / 6) * Math.PI;
      w.add(s);
    }
    g.add(w);
    return w;
  };
  const back = wheel(wb / 2), front = wheel(-wb / 2);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const bb = V(0, 0.32, 0.02), seat = V(0, 0.86, 0.2), head = V(0, 0.88, -0.38);
  g.add(tube(bb, seat, 0.022, frame), tube(seat.clone().setY(0.8), head, 0.02, frame), tube(bb, head.clone().setY(0.78), 0.024, frame));
  g.add(tube(bb, V(0, R, wb / 2), 0.014, frame), tube(seat.clone().setY(0.8), V(0, R, wb / 2), 0.012, frame));
  // Steering: fork and handlebar turn together.
  const steer = new THREE.Group();
  steer.position.copy(head);
  steer.add(tube(V(0, 0.1, 0), V(0, R - head.y, -wb / 2 - head.z), 0.016, metal));
  steer.add(tube(V(-0.27, 0.16, 0.05), V(0.27, 0.16, 0.05), 0.014, dark), tube(V(0, 0, 0), V(0, 0.16, 0.05), 0.016, metal));
  g.add(steer);
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.26), dark);
  saddle.position.set(0, 0.9, 0.22);
  g.add(saddle);
  // Crank and pedals turn with the wheels.
  const crank = new THREE.Group();
  crank.position.copy(bb);
  for (const s of [-1, 1]) {
    const arm = tube(V(s * 0.06, 0, 0), V(s * 0.06, s * 0.16, 0), 0.012, metal);
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.07), dark);
    pedal.position.set(s * 0.11, s * 0.16, 0);
    crank.add(arm, pedal);
  }
  g.add(crank);
  return { group: g, wheels: [back, front], steer, crank, radius: R };
}

// ---------- vehicles ----------

// A car or bike in the world. kind: 'car' | 'bike'; type: car model name (cars).
export class Vehicle {
  constructor(kind, type = 'sedan', { color } = {}) {
    this.kind = kind;
    this.type = kind === 'car' ? (cars.has(type) ? type : [...cars.keys()][0]) : 'bike';
    this.spec = SPECS[kind];
    if (kind === 'car') {
      const m = CAR_MODELS[this.type] || CAR_MODELS.sedan;
      this.spec = { ...SPECS.car, maxFwd: m.maxFwd, accel: m.accel, steerLow: SPECS.car.steerLow * m.steer,
        steerHigh: SPECS.car.steerHigh * m.steer, grip: m.grip, rollK: m.roll, cam: m.cam, label: m.label };
    } else {
      this.spec = { ...SPECS.bike, grip: 6, rollK: 0, cam: 4.5, label: 'Bike' };
    }
    this.root = new THREE.Group();
    this.tilt = new THREE.Group();  // pitch and roll from the ground
    this.root.add(this.tilt);
    this.x = 0; this.z = 0; this.y = 0; this.yaw = 0;
    this.speed = 0; this.steer = 0; this.pitch = 0; this.roll = 0; this.spin = 0;
    this.driver = null;
    if (kind === 'car') this._buildCar(); else this._buildBike(color);
  }

  get code() { return this.kind === 'car' ? `car:${this.type}` : 'bike'; }

  _buildCar() {
    const c = cars.get(this.type);
    const model = new THREE.Group();
    model.rotation.y = Math.PI;  // the kit's cars face +Z
    const body = new THREE.Mesh(c.body, c.material);
    body.castShadow = true;
    model.add(body);
    this.wheels = [];
    for (const w of c.wheels) {
      const pivot = new THREE.Group();
      pivot.position.copy(w.position);
      const mesh = new THREE.Mesh(w.geometry, c.material);
      mesh.castShadow = true;
      pivot.add(mesh);
      model.add(pivot);
      this.wheels.push({ pivot, mesh, front: w.name.includes('front') });
    }
    this.wheelR = 0.3 * WHEEL_SCALE;
    this.tilt.add(model);
  }

  _buildBike(color) {
    const b = bikeModel(color);
    this.bike = b;
    this.wheelR = b.radius;
    this.tilt.add(b.group);
  }

  place(x, z, yaw, world) {
    Object.assign(this, { x, z, yaw, speed: 0, steer: 0 });
    this._ground(world, 1, true);
    this._sync();
  }

  // Forward and right unit vectors on the ground.
  get fwd() { return [-Math.sin(this.yaw), -Math.cos(this.yaw)]; }
  get right() { return [Math.cos(this.yaw), -Math.sin(this.yaw)]; }

  // Arcade driving. ctl: throttle -1..1 (negative brakes, then reverses), steer -1..1 (right +),
  // brake: handbrake held.
  drive(dt, ctl, world) {
    const P = this.spec;
    const thr = clamp(ctl.throttle || 0, -1, 1);
    const target = thr > 0 ? thr * P.maxFwd : thr < 0 ? thr * P.maxRev : 0;
    const opposing = (thr > 0 && this.speed < -0.3) || (thr < 0 && this.speed > 0.3);
    const rate = opposing ? P.brake : thr !== 0 ? P.accel : P.coast;
    this.speed = approach(this.speed, opposing ? 0 : target, rate * dt);
    if (ctl.brake) this.speed = approach(this.speed, 0, P.hand * dt);

    // Steering gets gentler with speed; the handbrake tightens the turn.
    const t = clamp(Math.abs(this.speed) / P.maxFwd, 0, 1);
    this.steer = damp(this.steer, clamp(ctl.steer || 0, -1, 1) * lerp(P.steerLow, P.steerHigh, t), P.grip, dt);
    let yawRate = (-this.speed * Math.tan(this.steer)) / P.wheelbase;
    if (ctl.brake && Math.abs(this.speed) > 4) yawRate *= 1.6;
    this.yaw += yawRate * dt;
    this.yawRate = yawRate;

    const [fx, fz] = this.fwd;
    let x = this.x + fx * this.speed * dt, z = this.z + fz * this.speed * dt;
    // Collisions: push each footprint circle out of buildings and obstacles.
    let cx = 0, cz = 0, n = 0;
    for (const o of P.circles) {
      const px = x + fx * o, pz = z + fz * o;
      const [qx, qz] = world.resolveCircle(px, pz, P.r, this);
      if (Math.abs(qx - px) + Math.abs(qz - pz) > 1e-4) { cx += qx - px; cz += qz - pz; n++; }
    }
    if (n) {
      x += cx / n; z += cz / n;
      const l = Math.hypot(cx, cz) || 1;
      const head = (cx * fx + cz * fz) / l * Math.sign(this.speed || 1);  // -1: head-on
      this.speed *= head < -0.5 ? -0.2 : 0.96;
      this.hit = Math.max(this.hit || 0, Math.abs(this.speed));
    }
    this.x = x; this.z = z;
    // Body roll from cornering and pitch from braking/accelerating (visual only).
    if (this.kind === 'car') {
      const accel = (this.speed - (this._lastSpeed ?? this.speed)) / Math.max(dt, 1e-3);
      this._lastSpeed = this.speed;
      this.bodyRoll = damp(this.bodyRoll || 0, clamp(yawRate * this.speed * 0.012 * P.rollK, -0.1, 0.1), 5, dt);
      this.bodyPitch = damp(this.bodyPitch || 0, clamp(-accel * 0.006, -0.05, 0.05), 6, dt);
    }
    this._ground(world, dt);
    this.spin -= (this.speed * dt) / this.wheelR;
    this._sync();
  }

  // Height and tilt from the ground under the wheels (or the bike's lean in turns).
  _ground(world, dt, snap = false) {
    const P = this.spec, [fx, fz] = this.fwd, [rx, rz] = this.right;
    const h = (a, b) => world.groundAt(this.x + fx * a + rx * b, this.z + fz * a + rz * b);
    const hf = h(P.wheelbase / 2, 0), hb = h(-P.wheelbase / 2, 0);
    let y = (hf + hb) / 2, pitch = Math.atan2(hf - hb, P.wheelbase), roll;
    if (this.kind === 'car') {
      const hl = h(0, -P.track / 2), hr = h(0, P.track / 2);
      y = (hf + hb + hl + hr) / 4;
      roll = Math.atan2(hr - hl, P.track);
    } else {
      roll = clamp((this.yawRate || 0) * this.speed * 0.06, -0.45, 0.45);  // lean into the turn
    }
    if (snap) { this.y = y; this.pitch = pitch; this.roll = roll; return; }
    this.y = damp(this.y, y, 14, dt);
    this.pitch = damp(this.pitch, pitch, 10, dt);
    this.roll = damp(this.roll, roll, 6, dt);
  }

  _sync() {
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.y = this.yaw;
    this.tilt.rotation.set(this.pitch + (this.bodyPitch || 0), 0, this.roll + (this.bodyRoll || 0), 'XZY');
    if (this.kind === 'car') {
      for (const w of this.wheels) {
        w.mesh.rotation.x = -this.spin;
        w.pivot.rotation.y = w.front ? -this.steer : 0;
      }
    } else {
      const b = this.bike;
      for (const w of b.wheels) w.rotation.x = this.spin;
      b.steer.rotation.y = -this.steer;
      b.crank.rotation.x = this.spin * 0.55;
    }
  }

  // Set from a remote player's state (no physics).
  follow(x, z, y, yaw, speed, dt) {
    Object.assign(this, { x, z, yaw, speed });
    this.y = y;
    this.spin -= (speed * dt) / this.wheelR;
    this._sync();
  }

  // Where the rider's feet go (bike) or where the driver is (car).
  seatPosition() { return [this.x, this.y + (this.spec.seat ? 0 : 0), this.z]; }

  // Can the player at (x, z) get in? Distance to the vehicle's footprint.
  reach(x, z) {
    const [fx, fz] = this.fwd;
    let best = Infinity;
    for (const o of this.spec.circles) best = Math.min(best, Math.hypot(x - (this.x + fx * o), z - (this.z + fz * o)) - this.spec.r);
    return best;
  }

  // Footprint for other things to collide with (when parked).
  circles() {
    const [fx, fz] = this.fwd;
    return this.spec.circles.map((o) => ({ x: this.x + fx * o, z: this.z + fz * o, r: this.spec.r }));
  }

  dispose() {
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.geometry.userData.shared) o.geometry.dispose();
      if (!o.material.userData.shared) o.material.dispose();
    });
  }
}

function approach(v, target, step) {
  return v < target ? Math.min(target, v + step) : Math.max(target, v - step);
}
