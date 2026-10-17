// Cars and bicycles: models, vehicle dynamics and their place in the world.
// Cars are Kenney's "Car Kit" (CC0, assets/vehicles/), stretched to real-world proportions; the
// bicycle is built here. A Vehicle faces -Z at yaw 0, like the player; its root sits on the ground.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp, lerp, angleDelta } from './util.js';
import { CarPhysics, CAR_STEP } from './carphysics.js';
import { contactMaterial } from './materials.js';

// Cars people drive (traffic, parked, yours) and every model file to load (adds police cars).
export const CAR_TYPES = ['sedan', 'hatchback-sports', 'sedan-sports', 'suv', 'suv-luxury', 'taxi', 'van'];
const MODEL_FILES = [...CAR_TYPES, 'police'];
const BODY_SCALE = new THREE.Vector3(1.5, 1.15, 2.0);  // road-car width and wheelbase in meters
const WHEEL_SCALE = 1.15;

// Driving: speeds in m/s, rates in m/s², steering in radians, circles = collision footprint
// (offsets along the vehicle from its center, radius).
const SPECS = {
  car: { maxFwd: 25, maxRev: 6, accel: 7, brake: 16, coast: 2.5, hand: 12, wheelbase: 2.6, track: 1.6,
    steerLow: 0.6, steerHigh: 0.16, circles: [-1.5, 0, 1.5], r: 0.92, seat: null },
  bike: { maxFwd: 8, maxRev: 1.5, accel: 2.2, brake: 9, coast: 1.2, hand: 8, wheelbase: 1.1, track: 0.1,
    steerLow: 0.7, steerHigh: 0.25, circles: [-0.45, 0.45], r: 0.38, seat: 0.92 },
};
export const VEHICLE_SPECS = SPECS;

// Car performance and presentation. Physical mass, drivetrain, tires and suspension live in
// carphysics.js; these speed/acceleration values also seed the gearing and engine torque.
export const CAR_MODELS = {
  sedan: { label: 'Sedan', maxFwd: 30, accel: 3.6, steer: 1, grip: 6, roll: 1, cam: 7.5 },
  'sedan-sports': { label: 'Sports sedan', maxFwd: 38, accel: 5.2, steer: 1.08, grip: 9, roll: 0.55, cam: 7 },
  'hatchback-sports': { label: 'Sports hatchback', maxFwd: 40, accel: 5.6, steer: 1.12, grip: 10, roll: 0.45, cam: 7 },
  suv: { label: 'SUV', maxFwd: 28, accel: 3.2, steer: 0.85, grip: 5, roll: 1.5, cam: 8.2 },
  'suv-luxury': { label: 'Luxury SUV', maxFwd: 35, accel: 4.3, steer: 0.92, grip: 6.5, roll: 1, cam: 8.2 },
  taxi: { label: 'Taxi', maxFwd: 31, accel: 3.6, steer: 1, grip: 6, roll: 1, cam: 7.5 },
  van: { label: 'Van', maxFwd: 23, accel: 2.6, steer: 0.75, grip: 4, roll: 1.9, cam: 9 },
  // Police (police.js): stronger at higher heat. model: which file; tint: darken the paint.
  police: { label: 'Police', maxFwd: 36, accel: 4.8, steer: 1.05, grip: 8, roll: 0.8, cam: 7.5, police: true },
  'police-suv': { label: 'Police SUV', model: 'suv', maxFwd: 37, accel: 4.8, steer: 0.95, grip: 7, roll: 1.1, cam: 8.2,
    police: true, tint: [0.3, 0.34, 0.5] },
  interceptor: { label: 'Interceptor', model: 'sedan-sports', maxFwd: 46, accel: 6.8, steer: 1.12, grip: 11, roll: 0.4, cam: 7,
    police: true, tint: [0.26, 0.26, 0.29] },
};

// ---------- car models ----------

const loader = new GLTFLoader();
let carsPromise = null;
const cars = new Map();  // type -> { body: geometry, wheels: [{ name, geometry, position }], material }

// Load the car models once; resolves when all are ready (failed ones are skipped).
export function loadCars() {
  if (carsPromise) return carsPromise;
  carsPromise = Promise.all(MODEL_FILES.map((t) => loader.loadAsync(`assets/vehicles/${t}.glb`).then((g) => {
    const out = { wheels: [] }, parts = [];
    g.scene.updateMatrixWorld(true);
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      contactMaterial(o.material);
      o.material.envMapIntensity = 0.7;
      o.material.userData.shared = true;
      out.material = o.material;
      const geo = o.geometry.clone();
      geo.userData.shared = true;
      if (o.name.startsWith('wheel')) {
        const roadWheel = /-(left|right)$/.test(o.name);
        geo.scale(roadWheel ? 0.65 : WHEEL_SCALE, WHEEL_SCALE, WHEEL_SCALE);
        const p = o.getWorldPosition(new THREE.Vector3()).multiply(BODY_SCALE);
        geo.computeBoundingBox();
        const center = geo.boundingBox.getCenter(new THREE.Vector3());
        geo.translate(-center.x, -center.y, -center.z); p.add(center);
        const vertices = geo.attributes.position;
        let radius = 0;
        for (let i = 0; i < vertices.count; i++) radius = Math.max(radius, Math.hypot(vertices.getY(i), vertices.getZ(i)));
        out.wheels.push({ name: o.name, geometry: geo, position: p, radius,
          halfWidth: (geo.boundingBox.max.x - geo.boundingBox.min.x) / 2 });
      } else {
        // Everything that isn't a wheel is body (some models add a grille or spoiler).
        geo.applyMatrix4(o.matrixWorld);
        geo.scale(BODY_SCALE.x, BODY_SCALE.y, BODY_SCALE.z);
        parts.push(geo.index ? geo.toNonIndexed() : geo);
      }
    });
    if (parts.length) {
      out.body = parts.length > 1 ? mergeGeometries(parts, false) : parts[0];
      out.body.userData.shared = true;
      out.body.computeBoundingBox();
      const halfWidth = (out.body.boundingBox.max.x - out.body.boundingBox.min.x) / 2;
      const vertices = out.body.attributes.position;
      for (const w of out.wheels) if (/-(left|right)$/.test(w.name)) {
        w.geometry.computeBoundingBox();
        const tireWidth = w.geometry.boundingBox.max.x - w.geometry.boundingBox.min.x;
        // Fit the tread to the lower wheel arch, not the wider mirrors/body accessories.
        let arch = 0;
        for (let i = 0; i < vertices.count; i++) {
          if (Math.abs(vertices.getZ(i) - w.position.z) < 0.65 && vertices.getY(i) > 0.05
            && vertices.getY(i) < w.position.y + 0.2) arch = Math.max(arch, Math.abs(vertices.getX(i)));
        }
        w.position.x = Math.sign(w.position.x) * ((arch || halfWidth * 0.8) - tireWidth * 0.3);
      }
      cars.set(t, out);
    }
  }).catch((e) => console.warn(`Car ${t} didn't load: ${e.message}`)))).then(() => cars);
  return carsPromise;
}

export const carsLoaded = () => cars.size > 0;
const civilian = () => CAR_TYPES.filter((t) => cars.has(t));
export const carType = (seed) => { const c = civilian(); return c[Math.floor(seed * c.length) % c.length]; };

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

const _contactP = new THREE.Vector3(), _contactN = new THREE.Vector3();
const _axle = new THREE.Vector3(), _suspension = new THREE.Vector3();
const _contactQ = new THREE.Quaternion(), _bankQ = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
// A tire is a finite-width cylinder. Its support distance against a banked plane is
// not simply its vertical radius (the lower tread edge matters while cornering).
function tireSupport(normal, axle, radius, halfWidth) {
  const dot = clamp(normal.dot(axle), -1, 1);
  return (radius * Math.sqrt(1 - dot * dot) + halfWidth * Math.abs(dot)) / Math.max(0.25, normal.y);
}

// Merged cars face +X. Fit all four real tire positions, including cross-slope, and
// lift the rigid instance only enough to clear every tire. Used by parking and traffic.
export function fitParkedCar(type, x, z, rot, world, y = null) {
  const wheels = cars.get(type)?.wheels.filter(w => /-(left|right)$/.test(w.name));
  if (!wheels?.length) return { y: world.groundAt(x, z, y) + 0.04, tilt: 0, bank: 0 };
  const fx = Math.cos(rot), fz = -Math.sin(rot), rx = -fz, rz = fx;
  const samples = wheels.map(w => ({ w, a: w.position.z, b: -w.position.x,
    h: world.groundAt(x + fx * w.position.z - rx * w.position.x, z + fz * w.position.z - rz * w.position.x, y) }));
  const avg = (list, key) => list.reduce((sum, s) => sum + s[key], 0) / list.length;
  const front = samples.filter(s => s.w.name.includes('front')), rear = samples.filter(s => !s.w.name.includes('front'));
  const left = samples.filter(s => s.b < 0), right = samples.filter(s => s.b > 0);
  const grade = (avg(front, 'h') - avg(rear, 'h')) / (avg(front, 'a') - avg(rear, 'a'));
  const cross = (avg(right, 'h') - avg(left, 'h')) / (avg(right, 'b') - avg(left, 'b'));
  const tilt = Math.atan(grade), bank = Math.atan(cross * Math.cos(tilt));
  let height = samples.reduce((sum, s) => sum + s.h - grade * s.a - cross * s.b, 0) / samples.length;
  _contactQ.setFromAxisAngle(Y_AXIS, rot)
    .multiply(_bankQ.setFromAxisAngle(Z_AXIS, tilt)).multiply(_bankQ.setFromAxisAngle(X_AXIS, -bank));
  _axle.copy(Z_AXIS).applyQuaternion(_contactQ);
  let lift = -Infinity;
  for (const { w } of samples) {
    _contactP.set(w.position.z, w.position.y, -w.position.x).applyQuaternion(_contactQ);
    _contactP.x += x; _contactP.y += height; _contactP.z += z;
    const h = world.groundAt(_contactP.x, _contactP.z, y, _contactN);
    lift = Math.max(lift, h + tireSupport(_contactN, _axle, w.radius, w.halfWidth) + 0.008 - _contactP.y);
  }
  height += lift;
  return { y: height, tilt, bank };
}

// ---------- car lights ----------

// Headlights and taillights, shared by every car; bright at night (setCarLights).
const HEAD = contactMaterial(new THREE.MeshBasicMaterial({ color: '#fff6e0', toneMapped: false }));
const TAIL = contactMaterial(new THREE.MeshBasicMaterial({ color: '#ff2a1a', toneMapped: false }));
HEAD.userData.shared = TAIL.userData.shared = true;
const HEAD_ON = new THREE.Color('#fff6e0').multiplyScalar(3), HEAD_OFF = new THREE.Color('#cfd3d6');
const TAIL_ON = new THREE.Color('#ff2a1a').multiplyScalar(2.2), TAIL_OFF = new THREE.Color('#7a1d16');
export function setCarLights(on) {
  HEAD.color.copy(on ? HEAD_ON : HEAD_OFF);
  TAIL.color.copy(on ? TAIL_ON : TAIL_OFF);
}
setCarLights(false);

// Light geometry for a car model (front +Z, as in the model files): { head, tail }.
const lightGeo = new Map();
function carLights(type) {
  if (!lightGeo.has(type)) {
    const b = cars.get(type).body;
    b.computeBoundingBox();
    const { min, max } = b.boundingBox, hw = (max.x - min.x) / 2, y = min.y + (max.y - min.y) * 0.42;
    const pair = (z, w, h) => mergeGeometries([-1, 1].map((s) => new THREE.BoxGeometry(w, h, 0.05).translate(s * hw * 0.68, y, z)));
    const g = { head: pair(max.z + 0.02, 0.32, 0.14), tail: pair(min.z - 0.02, 0.3, 0.12),
      points: [-1, 1].map((s) => new THREE.Vector3(s * hw * 0.68, y, max.z + 0.065)) };
    g.head.userData.shared = g.tail.userData.shared = true;
    lightGeo.set(type, g);
  }
  return lightGeo.get(type);
}

// Light centers in the model's +Z-forward frame (also used by instanced traffic).
export function headlightPoints(type) {
  const model = CAR_MODELS[type]?.model || type;
  return cars.has(model) ? carLights(model).points : [];
}

// The same, rotated to point along +X like parkedCarMesh(), for instanced traffic.
const parkedLights = new Map();
export function parkedCarLights(type) {
  if (!parkedLights.has(type)) {
    const g = carLights(type);
    const r = { head: g.head.clone().rotateY(Math.PI / 2), tail: g.tail.clone().rotateY(Math.PI / 2), headMat: HEAD, tailMat: TAIL };
    r.head.userData.shared = r.tail.userData.shared = true;
    parkedLights.set(type, r);
  }
  return parkedLights.get(type);
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
    this.type = kind === 'car' ? (CAR_MODELS[type] && cars.has(CAR_MODELS[type].model || type) ? type : 'sedan') : 'bike';
    this.spec = SPECS[kind];
    if (kind === 'car') {
      const m = CAR_MODELS[this.type] || CAR_MODELS.sedan;
      this.spec = { ...SPECS.car, maxFwd: m.maxFwd, accel: m.accel, steerLow: SPECS.car.steerLow * m.steer,
        steerHigh: SPECS.car.steerHigh * m.steer, grip: m.grip, rollK: m.roll, cam: m.cam, label: m.label, police: !!m.police };
    } else {
      this.spec = { ...SPECS.bike, grip: 6, rollK: 0, cam: 4.5, label: 'Bike' };
    }
    this.root = new THREE.Group();
    this.tilt = new THREE.Group();  // pitch and roll from the ground
    this.root.add(this.tilt);
    this.x = 0; this.z = 0; this.y = 0; this.yaw = 0;
    this.speed = 0; this.steer = 0; this.pitch = 0; this.roll = 0; this.spin = 0;
    this.slip = 0; // lateral velocity in the car's frame; independent of its heading
    this.impactSerial = 0; this.impactCooldown = 0;
    this.nitro = 0.5; this.boosting = false; this.flat = false;
    this.driver = null;
    if (kind === 'car') this._buildCar(); else this._buildBike(color);
    if (kind === 'car') {
      this.physics = new CarPhysics(this.spec, this.type, this.wheelR);
      this._physicsTime = 0; this._surfaceTime = 0; this._contacts = [];
      this._samples = this.physics.wheels.map(() => ({ height: 0, grip: 1, rolling: 0.014 }));
      for (const w of this.wheels) w.contact = this.physics.wheels.find(p => p.front === w.front && p.side === -Math.sign(w.pivot.position.x));
      // The solver's origin is the centre of mass, not the mesh's geometric centre.
      // Align the model axles with the force/suspension sample positions.
      const front = this.wheels.find(w => w.front);
      const offset = front.pivot.position.z - front.contact.a;
      this.carModel.position.z = offset;
      this.spec.circles = this.spec.circles.map(a => a - offset);
    }
  }

  get code() { return this.kind === 'car' ? `car:${this.type}` : 'bike'; }
  get groundSpeed() { return Math.hypot(this.speed, this.slip); }

  // New paint (a tint on the model's palette texture); null restores the original.
  respray(color) {
    if (this.kind !== 'car' || !this.body) return;
    if (!this._paint) { this._paint = this.body.material.clone(); this._paint.userData = {}; }
    contactMaterial(this._paint);
    this._paint.color.set(color || '#ffffff');
    this.body.material = this._paint;
  }

  _buildCar() {
    const m = CAR_MODELS[this.type];
    const c = cars.get(m.model || this.type);
    let material = c.material;
    if (m.tint) {
      material = c.material.clone();
      material.userData = {};
      contactMaterial(material);
      material.color.setRGB(...m.tint);
    }
    const model = new THREE.Group();
    this.carModel = model;
    model.rotation.y = Math.PI;  // the kit's cars face +Z
    const body = new THREE.Mesh(c.body, material);
    body.castShadow = true;
    model.add(body);
    this.body = body;
    this._base = material;
    this.wheels = [];
    for (const w of c.wheels) {
      // The SUV's fifth wheel is a fixed spare, not a suspension/steering contact.
      if (!/-(left|right)$/.test(w.name)) {
        const spare = new THREE.Mesh(w.geometry, material);
        spare.position.copy(w.position); spare.castShadow = true; model.add(spare); continue;
      }
      const pivot = new THREE.Group();
      pivot.position.copy(w.position);
      const mesh = new THREE.Mesh(w.geometry, material);
      mesh.castShadow = true;
      pivot.add(mesh);
      model.add(pivot);
      this.wheels.push({ pivot, mesh, baseY: w.position.y, radius: w.radius, halfWidth: w.halfWidth,
        front: w.name.includes('front') });
    }
    this.wheelR = this.wheels.reduce((sum, w) => sum + w.radius, 0) / this.wheels.length;
    const axle = front => this.wheels.filter(w => w.front === front).reduce((n, w) => n + w.pivot.position.z, 0) / 2;
    const xs = this.wheels.map(w => w.pivot.position.x);
    c.body.computeBoundingBox();
    const bounds = c.body.boundingBox, radius = (bounds.max.x - bounds.min.x) * 0.48;
    this.spec = { ...this.spec, wheelbase: axle(true) - axle(false), track: Math.max(...xs) - Math.min(...xs),
      r: radius, circles: [bounds.min.z + radius, 0, bounds.max.z - radius] };
    const lg = carLights(m.model || this.type);
    model.add(new THREE.Mesh(lg.head, HEAD), new THREE.Mesh(lg.tail, TAIL));
    this.headlights = lg.points.map((p) => {
      const anchor = new THREE.Object3D();
      anchor.position.copy(p);
      model.add(anchor);
      return anchor;
    });
    this.tilt.add(model);
    if (m.police) this._lightBar(c);
  }

  // Red and blue lights on the roof; police.js flashes them during a chase.
  _lightBar(c) {
    c.body.computeBoundingBox();
    const top = c.body.boundingBox.max.y + 0.06;
    this.bar = [];
    for (const [x, color] of [[-0.28, '#ff2a2a'], [0.28, '#2a6bff']]) {
      const mat = contactMaterial(new THREE.MeshBasicMaterial({ color, toneMapped: false }));
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.22), mat);
      lamp.position.set(x, top, 0.15);
      this.tilt.add(lamp);
      this.bar.push({ lamp, mat, color: new THREE.Color(color) });
    }
  }

  // Flash the light bar (on: chasing) at time t.
  flash(on, t) {
    if (!this.bar) return;
    const phase = Math.floor(t * 6) % 2;
    this.bar.forEach((b, i) => b.mat.color.copy(b.color).multiplyScalar(on ? (phase === i ? 3 : 0.15) : 0.35));
  }

  _buildBike(color) {
    const b = bikeModel(color);
    b.group.traverse(o => { if (o.isMesh) contactMaterial(o.material); });
    this.bike = b;
    this.wheelR = b.radius;
    this.tilt.add(b.group);
  }

  place(x, z, yaw, world) {
    this._world = world;
    Object.assign(this, { x, z, yaw, speed: 0, steer: 0, slip: 0 });
    if (this.physics) {
      this.stop(); this._physicsTime = 0; this._surfaceTime = 0;
      this.physics.settle(this, this._sampleRoad(world, 0).map(s => s.height));
    } else this._ground(world, 1, true);
    this._sync();
  }

  stop() {
    this.speed = this.slip = this.steer = this.yawRate = 0;
    this.physicsActive = false;
    this.physics?.reset();
    this.boosting = false;
    this.bodyPitch = this.bodyRoll = 0;
  }

  // Forward and right unit vectors on the ground.
  get fwd() { return [-Math.sin(this.yaw), -Math.cos(this.yaw)]; }
  get right() { return [Math.cos(this.yaw), -Math.sin(this.yaw)]; }

  // AI requests a path curvature and brakes for its available grip, using the same tire solver.
  steerToPoint(x, z) {
    const [fx, fz] = this.fwd, [rx, rz] = this.right, dx = x - this.x, dz = z - this.z;
    const curvature = 2 * (dx * rx + dz * rz) / Math.max(16, dx * dx + dz * dz);
    const correction = Math.atan2(this.slip, Math.max(4, Math.abs(this.speed))) * 0.4;
    const wheel = Math.atan(this.spec.wheelbase * curvature) + correction;
    const fraction = clamp(wheel / this.physics.steeringLimit(this.speed), -1, 1);
    const grip = this._samples.reduce((n, s) => n + s.grip, 0) / 4;
    return { steer: Math.sign(fraction) * Math.abs(fraction) ** (1 / 1.35),
      cornerSpeed: Math.sqrt(this.physics.p.mu * grip * this.physics.weatherGrip * 9.81 * 0.65 / Math.max(0.002, Math.abs(curvature))),
      ahead: dx * fx + dz * fz };
  }

  // Controls: throttle -1..1 (S brakes before selecting reverse), steer -1..1,
  // brake = rear handbrake, serviceBrake = optional separate brake pedal, boost = nitrous.
  drive(dt, ctl, world) {
    this._world = world;
    if (this.kind === 'bike') { this._driveBike(dt, ctl, world); return; }
    this.physicsActive = true;
    const input = { ...ctl, wet: ctl.wet ?? world.drivingWeather?.wet ?? 0,
      snow: ctl.snow ?? world.drivingWeather?.snow ?? 0 };
    this._physicsTime += Math.min(dt, 0.1);
    while (this._physicsTime + 1e-9 >= CAR_STEP) {
      this._physicsTime = Math.max(0, this._physicsTime - CAR_STEP);
      this.impactCooldown = Math.max(0, this.impactCooldown - CAR_STEP);
      this.boosting = !!input.boost && input.throttle > 0 && this.nitro > 0 && this.speed > 2;
      if (this.boosting) this.nitro = Math.max(0, this.nitro - CAR_STEP / 3.5);
      const velocity = this.physics.step(this, input, CAR_STEP, this._sampleRoad(world, CAR_STEP));
      this._moveCar(CAR_STEP, velocity, world);
      if (this.physics.landing > 3) this._impact(this.x, this.z, this.physics.landing, 'landing');
    }
    this._sync();
  }

  _sampleRoad(world, dt) {
    const [fx, fz] = this.fwd, [rx, rz] = this.right;
    const deck = world.deckAt(this.x, this.z, this.y);
    this._surfaceTime -= dt;
    const refresh = this._surfaceTime <= 0;
    if (refresh) this._surfaceTime = 0.12;
    this.physics.wheels.forEach((w, i) => {
      const x = this.x + fx * w.a + rx * w.b, z = this.z + fz * w.a + rz * w.b;
      const sample = this._samples[i];
      let height = world.groundAt(x, z, this.y);
      if (deck !== null && height < deck - 1.5) height = deck;
      sample.height = height;
      if (refresh) {
        const paved = deck !== null || world.onRoad(x, z) || world.onSidewalk(x, z);
        const area = paved ? null : world.areaAt(x, z);
        const natural = !paved && (!area || ['grass', 'wood', 'farm', 'sand', 'water'].includes(area.k));
        sample.grip = natural ? (area?.k === 'sand' ? 0.48 : 0.60) : 1;
        sample.rolling = natural ? 0.055 : 0.014;
      }
    });
    return this._samples;
  }

  _moveCar(dt, velocity, world) {
    const ox = this.x, oz = this.z, distance = Math.hypot(velocity.vx, velocity.vz) * dt;
    const steps = Math.max(1, Math.ceil(distance / 0.4));
    for (let step = 0; step < steps; step++) {
      // Read the velocity again after an impulse; don't continue driving into the wall.
      const [fx, fz] = this.fwd, [rx, rz] = this.right;
      this.x += (fx * this.speed + rx * this.slip) * dt / steps;
      this.z += (fz * this.speed + rz * this.slip) * dt / steps;
      if (Math.abs(this.speed) > 6) {
        const nose = this.spec.circles[this.speed > 0 ? 2 : 0];
        if (world.smash(this.x + fx * nose, this.z + fz * nose, this.spec.r,
          fx * Math.sign(this.speed), fz * Math.sign(this.speed))) this.speed *= 0.85;
      }
      for (const offset of this.spec.circles) {
        const x = this.x + fx * offset, z = this.z + fz * offset;
        this._contacts.length = 0;
        const [qx, qz] = world.resolveCircle(x, z, this.rough ? this.spec.r * 0.8 : this.spec.r,
          this, this.rough, this._contacts);
        this.x += qx - x; this.z += qz - z;
        for (const hit of this._contacts) {
          const closing = this.physics.collide(this, hit.x, hit.z, hit.nx, hit.nz, hit.other);
          if (closing > 0) {
            this._impact(hit.x, hit.z, closing);
            this.hitNow = Math.max(this.hitNow || 0, closing);
            this.hit = Math.max(this.hit || 0, closing);
          }
        }
      }
    }
    if (world.offDeck(ox, oz, this.x, this.z, this.y, this.spec.track / 2)) {
      const t = world.deckDir(ox, oz, this.y);
      const dx = this.x - ox, dz = this.z - oz;
      if (t) {
        const along = dx * t[0] + dz * t[1];
        const nx = dx - t[0] * along, nz = dz - t[1] * along, length = Math.hypot(nx, nz);
        if (length > 1e-6) {
          const closing = this.physics.collide(this, this.x, this.z, -nx / length, -nz / length);
          this._impact(this.x, this.z, closing);
          this.hitNow = Math.max(this.hitNow || 0, closing);
        }
        const sx = ox + t[0] * along, sz = oz + t[1] * along;
        if (!world.offDeck(ox, oz, sx, sz, this.y, this.spec.track / 2)) { this.x = sx; this.z = sz; return; }
      }
      this.x = ox; this.z = oz;
    }
  }

  // Bicycles keep the lightweight kinematic model.
  _driveBike(dt, ctl, world) {
    const P = this.spec;
    const thr = clamp(ctl.throttle || 0, -1, 1);
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    this.boosting = false;
    const top = P.maxFwd;
    const target = thr > 0 ? thr * top : thr < 0 ? thr * P.maxRev : 0;
    const opposing = (thr > 0 && this.speed < -0.3) || (thr < 0 && this.speed > 0.3);
    // Acceleration fades toward top speed, as with a real engine.
    const pull = thr > 0 && this.speed > 0 ? Math.max(0, 1 - 0.65 * (this.speed / top) ** 2) : 1;
    const rate = opposing ? P.brake : thr !== 0 ? P.accel * pull : P.coast;
    this.speed = approach(this.speed, opposing ? 0 : target, rate * dt);
    if (ctl.brake) this.speed = approach(this.speed, 0, P.hand * dt);

    // Steering gets gentler with speed; the handbrake tightens the turn.
    const t = clamp(Math.abs(this.speed) / P.maxFwd, 0, 1);
    const wobble = this.flat && Math.abs(this.speed) > 3 ? Math.sin(performance.now() / 90) * 0.25 : 0;
    this.steer = damp(this.steer, clamp((ctl.steer || 0) + wobble, -1, 1) * lerp(P.steerLow, P.steerHigh, t), P.grip, dt);
    let yawRate = (-this.speed * Math.tan(this.steer)) / P.wheelbase;
    if (ctl.brake && Math.abs(this.speed) > 4) yawRate *= 1.6;
    this.yaw += yawRate * dt;
    this.yawRate = yawRate;

    const [fx, fz] = this.fwd;
    // Move in steps of at most 0.5 m so fast cars can't skip through thin walls. Collisions push
    // each footprint circle out of buildings and obstacles; at speed, traffic lights break.
    const move = this.speed * dt, steps = Math.max(1, Math.ceil(Math.abs(move) / 0.5));
    let x = this.x, z = this.z, cx = 0, cz = 0, n = 0;
    for (let st = 0; st < steps && !n; st++) {
      x += (fx * move) / steps; z += (fz * move) / steps;
      for (const o of P.circles) {
        const px = x + fx * o, pz = z + fz * o;
        const [qx, qz] = world.resolveCircle(px, pz, this.rough ? P.r * 0.8 : P.r, this, this.rough);
        if (Math.abs(qx - px) + Math.abs(qz - pz) > 1e-4) { cx += qx - px; cz += qz - pz; n++; }
      }
    }
    if (n) {
      this._impact(x, z, Math.abs(this.speed));
      this.hitNow = Math.max(this.hitNow || 0, Math.abs(this.speed));  // for police.js (crashes)
      x += cx / n; z += cz / n;
      const l = Math.hypot(cx, cz) || 1;
      const head = (cx * fx + cz * fz) / l * Math.sign(this.speed || 1);  // -1: head-on
      this.speed *= head < -0.5 ? -0.2 : 0.96;
      this.hit = Math.max(this.hit || 0, Math.abs(this.speed));
    }
    // Bridge railings: scrape along the edge of a deck instead of dropping off it.
    const inset = 0.4;
    if (world.offDeck(this.x, this.z, x, z, this.y, inset)) {
      this._impact(x, z, Math.abs(this.speed) * 0.6);
      const t = world.deckDir(this.x, this.z, this.y);
      const mx = x - this.x, mz = z - this.z;
      let ok = false;
      if (t) {
        const along = mx * t[0] + mz * t[1];
        const sx = this.x + t[0] * along, sz = this.z + t[1] * along;
        if (!world.offDeck(this.x, this.z, sx, sz, this.y, inset)) {
          x = sx; z = sz; ok = true;
          // Turn parallel to the railing, losing speed with the angle of the hit.
          const yawT = Math.atan2(-t[0] * Math.sign(along || 1), -t[1] * Math.sign(along || 1));
          const da = angleDelta(this.yaw, Math.sign(this.speed) >= 0 ? yawT : yawT + Math.PI);
          this.yaw += da * 0.5;
          this.speed *= 1 - Math.min(0.5, Math.abs(da));
        }
      }
      if (!ok) { x = this.x; z = this.z; this.speed *= -0.2; }
      this.hitNow = Math.max(this.hitNow || 0, Math.abs(this.speed) * 0.5);
      this.hit = Math.max(this.hit || 0, Math.abs(this.speed) * 0.5);
    }
    this.x = x; this.z = z;
    this._ground(world, dt);
    this.spin -= (this.speed * dt) / this.wheelR;
    this._sync();
  }

  _impact(x, z, speed, kind = 'collision') {
    if (speed < 3 || this.impactCooldown > 0) return;
    this.impactCooldown = 0.18;
    this.impact = { x, y: this.y + 0.4, z, speed, kind };
    this.impactSerial++;
  }

  // Height and tilt from the ground under the wheels (or the bike's lean in turns).
  _ground(world, dt, snap = false) {
    const P = this.spec, [fx, fz] = this.fwd, [rx, rz] = this.right;
    // On a deck, wheels over its edge (at the railing) count as on it.
    const deck = world.deckAt(this.x, this.z, this.y);
    const h = (a, b) => {
      const g = world.groundAt(this.x + fx * a + rx * b, this.z + fz * a + rz * b, this.y);
      return deck !== null && g < deck - 1.5 ? deck : g;
    };
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
        const contact = this.physicsActive && w.contact;
        w.mesh.rotation.x = contact ? contact.spin : -this.spin;
        w.pivot.rotation.y = contact ? -contact.steer : w.front ? -this.steer : 0;
        w.pivot.position.y = w.baseY + (contact ? clamp(contact.travel, -this.physics.p.sag, 0.20) : 0);
      }
      if (this._world) this._seatTires(this._world);
    } else {
      const b = this.bike;
      for (const w of b.wheels) w.rotation.x = this.spin;
      b.steer.rotation.y = -this.steer;
      b.crank.rotation.x = this.spin * 0.55;
    }
  }

  _seatTires(world) {
    // Solve along the tilted suspension axis, after steering and body pitch/roll.
    // Sampling here also removes the one-physics-step lag when climbing a slope.
    for (let pass = 0; pass < 2; pass++) {
      let bottomed = 0;
      this.root.updateWorldMatrix(true, true);
      for (const w of this.wheels) {
        w.pivot.position.y = w.baseY;
        w.pivot.updateWorldMatrix(true, true);
        w.pivot.getWorldPosition(_contactP);
        _axle.set(1, 0, 0).transformDirection(w.pivot.matrixWorld);
        _suspension.set(0, 1, 0).transformDirection(w.pivot.parent.matrixWorld);
        let h = world.groundAt(_contactP.x, _contactP.z, this.y, _contactN);
        const deck = world.deckAt(this.x, this.z, this.y);
        if (deck !== null && h < deck - 1.5) h = deck;
        const support = tireSupport(_contactN, _axle, w.radius, w.halfWidth);
        const travel = (h + support + 0.008 - _contactP.y) * _contactN.y / Math.max(0.25, _contactN.dot(_suspension));
        w.pivot.position.y = w.baseY + Math.max(-this.physics.p.sag, travel);
        bottomed = Math.max(bottomed, (travel - 0.20) * _suspension.y);
      }
      if (bottomed <= 0.001 || pass === 1) break;
      // A fully compressed suspension is a hard contact, not permission to sink the
      // chassis through the road. This constraint leaves airborne droop untouched.
      this.y += bottomed; this.root.position.y = this.y;
      this.physics.vy = Math.max(0, this.physics.vy);
    }
  }

  // Set from a remote player's state (no physics).
  follow(x, z, y, yaw, speed, dt, world = null) {
    Object.assign(this, { x, z, yaw, speed });
    this.physicsActive = false;
    this.y = y;
    if (world) {
      this._world = world;
      if (this.physics) this.physics.settle(this, this._sampleRoad(world, 0).map(s => s.height));
      else this._ground(world, dt, true);
    }
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
