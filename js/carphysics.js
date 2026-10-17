// Original SI-unit vehicle dynamics. General mechanisms studied in reVC's ProcessWheel,
// suspension and transmission: contact forces, combined adhesion, axle bias and spring damping.
// No re3/reVC code or handling data is included. This module has no rendering dependencies.
const G = 9.81, TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const approach = (x, t, d) => x + clamp(t - x, -d, d);
export const CAR_STEP = 1 / 120;

// Independently tuned road-car properties: kilograms, meters, friction coefficient, drive split
// (1 = front, 0 = rear, intermediate = all-wheel drive), static front weight and suspension sag.
export const CAR_HANDLING = {
  sedan:            { mass: 1450, front: 0.59, drive: 1,    mu: 0.96, cg: 0.53, sag: 0.12,  drag: 0.65 },
  'sedan-sports':   { mass: 1560, front: 0.51, drive: 0,    mu: 1.10, cg: 0.47, sag: 0.085, drag: 0.62 },
  'hatchback-sports': { mass: 1240, front: 0.62, drive: 1,   mu: 1.08, cg: 0.46, sag: 0.08,  drag: 0.61 },
  suv:             { mass: 2120, front: 0.55, drive: 0.5,  mu: 0.88, cg: 0.76, sag: 0.17,  drag: 0.94 },
  'suv-luxury':     { mass: 2320, front: 0.54, drive: 0.45, mu: 1.00, cg: 0.70, sag: 0.13,  drag: 0.88 },
  taxi:            { mass: 1660, front: 0.54, drive: 0,    mu: 0.92, cg: 0.57, sag: 0.14,  drag: 0.73 },
  van:             { mass: 2450, front: 0.57, drive: 0,    mu: 0.85, cg: 0.83, sag: 0.18,  drag: 1.17, abs: false },
  police:          { mass: 1770, front: 0.53, drive: 0,    mu: 1.04, cg: 0.52, sag: 0.105, drag: 0.72 },
  'police-suv':     { mass: 2280, front: 0.55, drive: 0.5,  mu: 1.01, cg: 0.70, sag: 0.13,  drag: 0.94 },
  interceptor:     { mass: 1610, front: 0.51, drive: 0.3,  mu: 1.16, cg: 0.44, sag: 0.075, drag: 0.60 },
};

export class CarPhysics {
  constructor(spec, type, radius = 0.345) {
    this.p = { abs: true, brakeBias: 0.66, damping: 0.65, ...CAR_HANDLING[type], ...spec };
    const p = this.p;
    this.radius = radius;
    this.inertia = p.mass * (p.wheelbase ** 2 + p.track ** 2) * 0.22;
    this.pitchInertia = p.mass * (p.wheelbase ** 2 + p.cg ** 2) * 0.26;
    this.rollInertia = p.mass * (p.track ** 2 + p.cg ** 2) * 0.25;
    this.ratios = [3.30, 2.12, 1.48, 1.10, 0.84];
    this.redline = 6500;
    this.finalDrive = this.redline * TAU / 60 * radius / (p.maxFwd * this.ratios[4]);
    this.peakTorque = p.mass * p.accel * 1.45 * radius / (this.ratios[0] * this.finalDrive * 0.9);
    this.wheels = [];
    for (const front of [true, false]) for (const side of [-1, 1]) {
      const weight = (front ? p.front : 1 - p.front) / 2;
      const rest = p.mass * G * weight, spring = rest / p.sag;
      this.wheels.push({ front, side, a: p.wheelbase * (front ? 1 - p.front : -p.front),
        b: side * p.track / 2, rest, spring, damper: 2 * p.damping * Math.sqrt(spring * p.mass * weight),
        load: rest, contact: true, ground: null, travel: 0, steer: 0, spin: 0, spinSpeed: 0, skid: 0 });
    }
    this.reset();
  }

  reset() {
    this.yawRate = this.vy = this.pitchRate = this.rollRate = 0;
    this.gear = 1; this.direction = 1; this.rpm = 850;
    this.shiftTime = this.shiftCooldown = this.reverseWait = 0;
    this.throttle = this.braking = this.landing = 0;
    this.weatherGrip = 1;
    for (const w of this.wheels) Object.assign(w, { ground: null, load: w.rest,
      contact: true, travel: 0, spin: 0, spinSpeed: 0, skid: 0, steer: 0 });
  }

  // Snap only on placement. Normal driving uses suspension forces, including loss of contact.
  settle(v, ground) {
    const p = this.p, f = (ground[0] + ground[1]) / 2, r = (ground[2] + ground[3]) / 2;
    v.y = f * p.front + r * (1 - p.front);
    v.pitch = Math.atan2(f - r, p.wheelbase);
    v.roll = Math.atan2((ground[1] + ground[3] - ground[0] - ground[2]) / 2, p.track);
    this.wheels.forEach((w, i) => { w.ground = ground[i]; });
  }

  steeringLimit(speed) {
    return this.p.steerLow / (1 + (Math.abs(speed) / 17) ** 1.4);
  }

  _engine(v, ctl, dt) {
    const p = this.p, pedal = clamp(ctl.throttle || 0, -1, 1), desired = Math.sign(pedal);
    this.shiftTime = Math.max(0, this.shiftTime - dt);
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    const opposing = desired && (desired !== this.direction || pedal * v.speed < -0.25);
    this.braking = Math.max(clamp(ctl.serviceBrake || 0, 0, 1), opposing ? Math.abs(pedal) : 0);
    if (opposing && Math.hypot(v.speed, v.slip) < 0.4) {
      this.reverseWait += dt;
      if (this.reverseWait > 0.28) { this.direction = desired; this.gear = desired < 0 ? -1 : 1; this.reverseWait = 0; }
    } else this.reverseWait = 0;
    this.throttle = approach(this.throttle, opposing ? 0 : Math.abs(pedal), dt * 5);
    const ratio = this.direction < 0
      ? this.redline * TAU / 60 * this.radius / (p.maxRev * this.finalDrive)
      : this.ratios[this.gear - 1];
    const driveSpin = this.wheels.reduce((n, w) => n + Math.abs(w.spinSpeed) * (w.front ? p.drive : 1 - p.drive) / 2, 0);
    const coupledRPM = (Math.abs(v.speed) + driveSpin) / this.radius * ratio * this.finalDrive * 60 / TAU;
    this.rpm = approach(this.rpm, clamp(coupledRPM, 850 + this.throttle * 650, this.redline + 150), dt * 10000);
    if (this.direction > 0 && !this.shiftCooldown) {
      let next = this.gear;
      if (coupledRPM > this.redline * 0.90 && next < 5) next++;
      else if (coupledRPM < this.redline * 0.34 && next > 1) next--;
      if (next !== this.gear) { this.gear = next; this.shiftTime = 0.18; this.shiftCooldown = 0.55; }
    }
    const curve = 0.65 + 0.35 * Math.sin(Math.PI * clamp((this.rpm - 800) / (this.redline - 800), 0, 1));
    const limiter = clamp((this.redline - coupledRPM) / 350, 0, 1);
    const clutch = this.shiftTime > 0 ? 0.12 : 1;
    const torque = this.peakTorque * curve * this.throttle * limiter * clutch * (v.boosting ? 1.65 : 1);
    const engineBrake = Math.abs(v.speed) > 0.2 ? this.peakTorque * 0.08 * (1 - this.throttle) * clutch : 0;
    return (torque * this.direction - engineBrake * Math.sign(v.speed)) * ratio * this.finalDrive * 0.9 / this.radius;
  }

  // v carries position, yaw and longitudinal/lateral velocity. Samples have {height, grip, rolling}.
  // Caller supplies a fixed 120 Hz timestep and terrain/deck samples under all four wheels.
  step(v, ctl, dt, samples) {
    const p = this.p, u = v.speed, sideSpeed = v.slip;
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw), rx = -fz, rz = fx;
    const input = clamp(ctl.steer || 0, -1, 1);
    const target = Math.sign(input) * Math.abs(input) ** 1.35 * this.steeringLimit(u);
    v.steer = approach(v.steer, target, dt * (input ? 1.5 : 2.2) / (1 + Math.abs(u) / 35));
    const driveForce = this._engine(v, ctl, dt);
    const wet = clamp(ctl.wet || 0, 0, 1), snow = clamp(ctl.snow || 0, 0, 1);
    const weatherGrip = (1 - wet * 0.37) * (1 - snow * 0.73);
    this.weatherGrip = weatherGrip;
    let support = 0, pitchTorque = 0, rollTorque = 0, contacts = 0;
    this.landing = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], h = samples[i].height;
      const groundSpeed = w.ground === null ? 0 : clamp((h - w.ground) / dt, -8, 8);
      w.ground = h;
      w.travel = h - (v.y + Math.sin(v.pitch) * w.a + Math.sin(v.roll) * w.b);
      const compression = p.sag + w.travel;
      const relativeV = this.vy + this.pitchRate * w.a + this.rollRate * w.b - groundSpeed;
      const wasContact = w.contact;
      w.contact = compression > 0;
      w.load = w.contact ? clamp(w.spring * compression - w.damper * relativeV
        + w.spring * Math.max(0, w.travel - 0.14) * 3, 0, w.rest * 6) : 0;
      if (w.load > 1) contacts++;
      if (!wasContact && w.contact) this.landing = Math.max(this.landing, -relativeV);
      support += w.load; pitchTorque += w.load * w.a; rollTorque += w.load * w.b;
    }
    const frontH = (samples[0].height + samples[1].height) / 2;
    const rearH = (samples[2].height + samples[3].height) / 2;
    const grade = (frontH - rearH) / p.wheelbase;
    const bank = (samples[1].height + samples[3].height - samples[0].height - samples[2].height) / (2 * p.track);
    const contactFraction = clamp(support / (p.mass * G), 0, 1);
    const normalScale = 1 / Math.sqrt(1 + grade * grade + bank * bank);
    const gravityLong = -G * grade / (1 + grade * grade) * contactFraction;
    const gravitySide = -G * bank / (1 + bank * bank) * contactFraction;
    let longForce = 0, sideForce = 0, yawTorque = 0, skid = 0, holdingForce = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], surface = samples[i];
      // Ackermann: the inner front wheel follows a tighter circle than the outer wheel.
      w.steer = w.front && Math.abs(v.steer) > 1e-4
        ? Math.atan(p.wheelbase / (p.wheelbase / Math.tan(v.steer) - w.b)) : 0;
      const c = Math.cos(w.steer), s = Math.sin(w.steer);
      const pu = u + this.yawRate * w.b, pv = sideSpeed - this.yawRate * w.a;
      const wu = pu * c + pv * s, wv = pv * c - pu * s;
      const driveShare = (w.front ? p.drive : 1 - p.drive) / 2;
      const motor = driveForce * driveShare;
      const flat = v.flat ? (i === 0 ? 0.42 : 0.65) : 1;
      // Tire load sensitivity: doubling load gives slightly less than double the grip.
      const cap = p.mu * weatherGrip * surface.grip * flat * w.rest
        * (w.load / w.rest) ** 0.90 * normalScale;
      const invSideMass = 1 / p.mass + w.a * w.a / this.inertia;
      const invLongMass = 1 / p.mass + w.b * w.b / this.inertia;
      const sideStiff = cap * (w.front ? 8.6 : 9.4) / Math.max(Math.abs(wu), 2.5);
      let lateral = -sideStiff * wv / (1 + sideStiff * invSideMass * dt);
      const rolling = w.load * (surface.rolling + (v.flat ? (i === 0 ? 0.11 : 0.055) : 0));
      const brake = this.braking * p.mass * G * 1.2 * (w.front ? p.brakeBias : 1 - p.brakeBias) / 2;
      const hand = ctl.brake && !w.front;
      // ABS meters service braking near the longitudinal limit; the rear handbrake bypasses it.
      const service = p.abs ? Math.min(brake, cap * 0.94) : brake;
      const resistance = service + rolling + (hand ? p.mass * G * 0.7 : 0);
      holdingForce += Math.min(cap, resistance);
      const predictedU = wu + (gravityLong * c + gravitySide * s) * dt + motor * invLongMass * dt;
      const stopping = clamp(predictedU / Math.max(invLongMass * dt * 4, 1e-6), -resistance, resistance);
      let longitudinal = motor - stopping;
      const locked = (hand || (!p.abs && brake > cap)) && Math.abs(wu) > 0.6;
      const demand = Math.hypot(longitudinal, lateral);
      if (locked && cap > 0) {
        const speed = Math.hypot(wu, wv) || 1;
        longitudinal = -cap * 0.76 * wu / speed;
        lateral = -cap * 0.76 * wv / speed;
      } else if (demand > cap && demand > 0) {
        // Peak adhesion falls toward sliding friction after breakaway; no artificial recovery.
        const loss = 1 - 0.20 * clamp(demand / Math.max(cap, 1) - 1, 0, 1);
        const scale = cap * loss / demand;
        longitudinal *= scale; lateral *= scale;
      }
      const excess = Math.max(0, Math.abs(motor) - cap);
      w.spinSpeed = approach(w.spinSpeed, excess > 0 ? Math.sign(motor) * Math.min(18, excess / 220) : 0, dt * 35);
      const wheelSpeed = locked ? 0 : wu + w.spinSpeed;
      w.spin += wheelSpeed / this.radius * dt;
      w.skid = w.load > 1 ? clamp((locked ? Math.abs(wu) / 8 : 0)
        + Math.max(0, demand / Math.max(cap, 1) - 0.9) * Math.min(1, Math.abs(wv) / 1.5)
        + Math.abs(w.spinSpeed) / 5, 0, 1) : 0;
      skid = Math.max(skid, w.skid);
      const fl = longitudinal * c - lateral * s, fs = longitudinal * s + lateral * c;
      longForce += fl; sideForce += fs; yawTorque += -w.a * fs + w.b * fl;
    }
    // Tire forces act below the centre of mass: suspension responds with real load transfer.
    pitchTorque += longForce * p.cg;
    rollTorque += sideForce * p.cg;
    this.vy += (support / p.mass - G) * dt;
    this.pitchRate += pitchTorque / this.pitchInertia * dt;
    this.rollRate += rollTorque / this.rollInertia * dt;
    v.y += this.vy * dt;
    v.pitch += this.pitchRate * dt; v.roll += this.rollRate * dt;
    // The world's collision hull has no roof/side contacts. Bound tilt at that solver's limit.
    for (const [angle, rate] of [['pitch', 'pitchRate'], ['roll', 'rollRate']]) {
      if (Math.abs(v[angle]) > 0.8) { v[angle] = clamp(v[angle], -0.8, 0.8); this[rate] *= -0.1; }
    }
    const floor = Math.min(...samples.map(s => s.height)) - 0.22;
    if (v.y < floor) { v.y = floor; this.landing = Math.max(this.landing, -this.vy); this.vy = Math.max(0, this.vy); }
    const drag = 0.5 * 1.225 * p.drag * Math.hypot(u, sideSpeed);
    longForce += p.mass * gravityLong - drag * u;
    sideForce += p.mass * gravitySide - drag * sideSpeed;
    // Integrate world velocity before rotating the body frame: yaw alone cannot create energy.
    let vx = fx * u + rx * sideSpeed + (fx * longForce + rx * sideForce) / p.mass * dt;
    let vz = fz * u + rz * sideSpeed + (fz * longForce + rz * sideForce) / p.mass * dt;
    this.yawRate += yawTorque / this.inertia * dt;
    // Static friction can hold a braked car at rest on a hill. Without this zero-speed branch,
    // a velocity-based tire law needs a tiny continuing creep to generate the holding force.
    if ((ctl.brake || this.braking > 0) && this.throttle < 0.05 && Math.hypot(u, sideSpeed) < 0.06
      && Math.abs(this.yawRate) < 0.03 && contacts > 1
      && p.mass * Math.hypot(gravityLong, gravitySide) < holdingForce) {
      vx = vz = this.yawRate = 0;
    }
    v.yaw += this.yawRate * dt;
    v.speed = -Math.sin(v.yaw) * vx - Math.cos(v.yaw) * vz;
    v.slip = Math.cos(v.yaw) * vx - Math.sin(v.yaw) * vz;
    v.yawRate = this.yawRate;
    v.gear = this.gear; v.rpm = this.rpm; v.engineLoad = this.throttle * (this.shiftTime ? 0.15 : 1);
    v.tireSlip = skid; v.grounded = contacts > 0;
    v.accelLong = longForce / p.mass; v.accelSide = sideForce / p.mass;
    return { vx, vz };
  }

  // Planar rigid-body impulse at a hull contact. Glancing hits preserve tangential momentum.
  collide(v, x, z, nx, nz, other = null) {
    const velocity = (car, dx, dz) => ({
      x: -Math.sin(car.yaw) * car.speed + Math.cos(car.yaw) * car.slip + (car.physics?.yawRate || 0) * dz,
      z: -Math.cos(car.yaw) * car.speed - Math.sin(car.yaw) * car.slip - (car.physics?.yawRate || 0) * dx,
    });
    const ax = x - v.x, az = z - v.z, a = velocity(v, ax, az);
    const b = other?.physics && other.physicsActive ? velocity(other, x - other.x, z - other.z) : { x: 0, z: 0 };
    const arm = az * nx - ax * nz, otherArm = other ? (z - other.z) * nx - (x - other.x) * nz : 0;
    const moving = other?.physics && other.physicsActive;
    const inv = 1 / this.p.mass + arm * arm / this.inertia
      + (moving ? 1 / other.physics.p.mass + otherArm * otherArm / other.physics.inertia : 0);
    const closing = (a.x - b.x) * nx + (a.z - b.z) * nz;
    if (closing >= 0) return 0;
    const impulse = -(1 + 0.12) * closing / inv;
    const apply = (car, ix, iz, moment) => {
      const ph = car.physics;
      car.speed += (-Math.sin(car.yaw) * ix - Math.cos(car.yaw) * iz) / ph.p.mass;
      car.slip += (Math.cos(car.yaw) * ix - Math.sin(car.yaw) * iz) / ph.p.mass;
      ph.yawRate += moment / ph.inertia; car.yawRate = ph.yawRate;
    };
    apply(v, nx * impulse, nz * impulse, arm * impulse);
    if (moving) apply(other, -nx * impulse, -nz * impulse, -otherArm * impulse);
    const ta = velocity(v, ax, az), tb = moving ? velocity(other, x - other.x, z - other.z) : b;
    const tx = -nz, tz = nx, tangentArm = az * tx - ax * tz;
    const otherTangentArm = other ? (z - other.z) * tx - (x - other.x) * tz : 0;
    const tangentInv = 1 / this.p.mass + tangentArm ** 2 / this.inertia
      + (moving ? 1 / other.physics.p.mass + otherTangentArm ** 2 / other.physics.inertia : 0);
    const friction = clamp(-((ta.x - tb.x) * tx + (ta.z - tb.z) * tz) / tangentInv, -impulse * 0.18, impulse * 0.18);
    apply(v, tx * friction, tz * friction, tangentArm * friction);
    if (moving) apply(other, -tx * friction, -tz * friction, -otherTangentArm * friction);
    return -closing;
  }
}
