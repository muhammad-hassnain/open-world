// Run with node tools/check_carphysics.mjs. No package manager or browser is needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../js/carphysics.js', import.meta.url));
const { CarPhysics, CAR_STEP } = await import(`data:text/javascript;base64,${source.toString('base64')}`);
const spec = { wheelbase: 2.6, track: 1.6, maxFwd: 38, maxRev: 6, accel: 5.2, steerLow: 0.648 };

function car({ type = 'sedan-sports', speed = 0, grade = 0, grip = 1 } = {}) {
  const v = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed, slip: 0, steer: 0, physicsActive: true };
  v.physics = new CarPhysics(spec, type);
  const samples = () => v.physics.wheels.map(w => ({
    height: -(v.z - Math.cos(v.yaw) * w.a - Math.sin(v.yaw) * w.b) * grade,
    grip, rolling: grip === 1 ? 0.014 : 0.055,
  }));
  v.physics.settle(v, samples().map(s => s.height));
  return { v, samples, time: 0, accumulator: 0 };
}
function tick(c, control = {}, frame = CAR_STEP) {
  c.accumulator += frame;
  while (c.accumulator + 1e-9 >= CAR_STEP) {
    c.accumulator = Math.max(0, c.accumulator - CAR_STEP);
    const ctl = typeof control === 'function' ? control(c.time) : control;
    const velocity = c.v.physics.step(c.v, ctl, CAR_STEP, c.samples());
    c.v.x += velocity.vx * CAR_STEP; c.v.z += velocity.vz * CAR_STEP; c.time += CAR_STEP;
    for (const key of ['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'speed', 'slip', 'rpm']) assert(Number.isFinite(c.v[key]), key);
  }
}
function run(c, seconds, controls = {}, hz = 120) {
  for (let i = 0; i < Math.round(seconds * hz); i++) tick(c, controls, 1 / hz);
  return c.v;
}

const rest = run(car(), 10);
assert(Math.abs(rest.y) < 1e-6 && Math.abs(rest.speed) < 1e-6, 'stationary car must stay settled');
assert(Math.abs(rest.physics.wheels.reduce((n, w) => n + w.load, 0) - rest.physics.p.mass * 9.81) < 1, 'springs support weight');

const acceleration = run(car(), 12, { throttle: 1 });
assert(acceleration.speed > 27 && acceleration.speed < spec.maxFwd, 'plausible acceleration below rev limit');
assert(acceleration.gear >= 4 && acceleration.rpm > 2000, 'drivetrain must shift through gears');
assert(acceleration.physics.wheels[2].load > rest.physics.wheels[2].load, 'acceleration transfers load rearward');
const coast = run(car({ speed: 25 }), 5);
assert(coast.speed > 0 && coast.speed < 25, 'coasting dissipates energy without reversing');

function stop(wet = 0, snow = 0, grip = 1) {
  const c = car({ speed: 25, grip });
  while (c.v.speed > 0.2 && c.time < 25) tick(c, { throttle: -1, wet, snow });
  assert(c.time < 25, 'brakes must stop the car');
  return { distance: Math.hypot(c.v.x, c.v.z), time: c.time, c };
}
const dry = stop(), wet = stop(1), snow = stop(0, 1), dirt = stop(0, 0, 0.6);
assert(dry.distance > 25 && dry.distance < 50, 'dry stopping distance from 90 km/h');
assert(wet.distance > dry.distance * 1.25, 'rain must lengthen braking distance');
assert(snow.distance > wet.distance * 1.6 && dirt.distance > dry.distance * 1.2, 'snow and dirt reduce adhesion');
assert(dry.c.v.physics.wheels[0].load > rest.physics.wheels[0].load, 'braking transfers load forward');

const hill = run(car({ grade: 0.10 }), 2);
assert(hill.speed < -0.5, 'an unbraked car rolls downhill');
const parked = run(car({ grade: 0.10 }), 10, { brake: true });
assert(Math.abs(parked.z) < 0.01, 'static tire friction holds a parked car on a hill');
const uphill = run(car({ grade: 0.10 }), 4, { throttle: 1 });
const downhill = run(car({ grade: -0.10 }), 4, { throttle: 1 });
assert(downhill.speed > uphill.speed + 1, 'gravity changes hill acceleration');

const corner = run(car({ speed: 27 }), 2, { steer: 0.8 });
const handCase = car({ speed: 27 });
let handPeak = 0;
for (let i = 0; i < 240; i++) { tick(handCase, { steer: 0.8, brake: true }); handPeak = Math.max(handPeak, Math.abs(handCase.v.slip)); }
const hand = handCase.v;
assert(Math.abs(corner.yaw) > 0.1 && corner.yaw < 0, 'right steering turns right through tire forces');
assert(handPeak > 4.5, 'handbrake slip is not clamped to the former arcade limit');
assert(Math.abs(hand.yaw) > Math.abs(corner.yaw), 'locking the rear axle increases rotation');
const limits = run(car({ speed: 35 }), 0.8, { steer: 1 });
assert(Math.abs(limits.yawRate) < Math.abs(limits.speed * Math.tan(limits.steer) / spec.wheelbase), 'tires limit high-speed turning');

const air = car({ speed: 15 });
air.v.y = 4;
const before = air.v.speed;
run(air, 0.3, { steer: 1, throttle: 1, brake: true });
assert(!air.v.grounded && air.v.y < 4, 'airborne car falls under gravity');
assert(Math.abs(air.v.yaw) < 1e-6 && air.v.speed <= before, 'airborne tires cannot steer or accelerate the body');
run(air, 3, {});
assert(air.v.grounded && Math.abs(air.v.y) < 0.03, 'landing suspension settles');

const frames = [30, 60, 144].map(hz => run(car(), 8, t => ({ throttle: 1, steer: t > 4 ? 0.25 : 0 }), hz));
for (const v of frames.slice(1)) {
  assert(Math.hypot(v.x - frames[0].x, v.z - frames[0].z) < 1e-8, 'fixed physics is independent of display rate');
  assert(Math.abs(v.yaw - frames[0].yaw) < 1e-8, 'turning is independent of display rate');
}

const wall = car({ speed: 20 }).v;
wall.physics.collide(wall, 0, -2, 0, 1);
assert(wall.speed < 0 && wall.speed > -4 && Math.abs(wall.yawRate) < 1e-9, 'centred impact has modest restitution and no yaw');
const glance = car({ speed: 20 }).v;
glance.physics.collide(glance, 0.8, -1.5, -0.8, 0.6);
assert(Math.abs(glance.yawRate) > 0.1 && Math.hypot(glance.speed, glance.slip) < 20, 'off-centre collision rotates and loses energy');
const a = car({ speed: 15 }).v, b = car({ type: 'van' }).v;
b.z = -4;
const momentum = a.physics.p.mass * a.speed + b.physics.p.mass * b.speed;
a.physics.collide(a, 0, -2, 0, 1, b);
assert(Math.abs(a.physics.p.mass * a.speed + b.physics.p.mass * b.speed - momentum) < 1e-7, 'car collision conserves linear momentum');
assert(b.speed > 0 && b.speed < 15, 'struck heavy car receives an impulse');

console.log(JSON.stringify({ passed: true, brakingFrom90Kmh: {
  dryMeters: dry.distance, wetMeters: wet.distance, snowMeters: snow.distance, dirtMeters: dirt.distance,
}, accelerationAfter12sKmh: acceleration.speed * 3.6, peakHandbrakeSlip: handPeak, displayRates: [30, 60, 144] }, null, 2));
