import * as THREE from 'three';
import { clamp, damp, lerp, angleDelta } from './util.js';

export const WALK = 2.2;
export const RUN = 5.6;
export const SPRINT = 9;
const JUMP_V = 5.2;
const GRAVITY = 16;
const RADIUS = 0.32;
const HEAD = 1.55;

export class Player {
  constructor(world, character, camera) {
    this.world = world;
    this.char = character;
    this.camera = camera;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.camYaw = 0;
    this.camPitch = 0.16;
    this.camDist = 3.6;
    this.camActual = 3.6;
    this.onGround = true;
    this.speed = 0;
    this.vehicle = null;        // the car or bike being driven
    this._look = new THREE.Vector3();
    this._cam = new THREE.Vector3();
  }

  spawn(x, z, yaw) {
    const [sx, sz] = this.world.resolveCircle(x, z, RADIUS);
    this.pos.set(sx, this.world.groundAt(sx, sz), sz);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.camYaw = yaw;
    this.onGround = true;
  }

  // Get into a car or onto a bike. The rider sits on the bike; a driver is hidden in the car.
  enter(vehicle) {
    this.vehicle = vehicle;
    vehicle.driver = this;
    this.world.obstacles.delete(vehicle);
    this._walkCam = this.camDist;
    this.camDist = vehicle.kind === 'car' ? 7.5 : 4.5;
    this.camYaw = vehicle.yaw;
    const root = this.char.root;
    this._charParent = root.parent;
    if (vehicle.kind === 'bike') {
      vehicle.tilt.add(root);
      root.position.set(0, 0, 0.18);  // hips over the saddle
      root.rotation.set(0, 0, 0);
      this.char.setSeat('bike');
    } else {
      root.visible = false;
      this.char.setSeat('car');
    }
  }

  // Step out on the left; the vehicle stays where it is, as an obstacle.
  exit() {
    const v = this.vehicle;
    if (!v) return null;
    const [rx, rz] = v.right, side = v.kind === 'car' ? 1.5 : 0.8;
    const [x, z] = this.world.resolveCircle(v.x - rx * side, v.z - rz * side, RADIUS, v);
    v.speed = 0; v.steer = 0; v.driver = null;
    this.world.obstacles.add(v);
    this.vehicle = null;
    if (this._charParent) this._charParent.add(this.char.root);
    this.char.root.visible = true;
    this.char.setSeat(null);
    this.camDist = this._walkCam || 3.6;
    this.pos.set(x, this.world.groundAt(x, z), z);
    this.vel.set(0, 0, 0);
    this.yaw = v.yaw;
    this.onGround = true;
    return v;
  }

  update(dt, input) {
    if (this.vehicle) { this._drive(dt, input); return; }
    const w = this.world;

    // Camera orientation from mouse / keys.
    this.camYaw -= input.lookX;
    this.camPitch = clamp(this.camPitch + input.lookY, -0.45, 1.2);
    this.camDist = clamp(this.camDist + input.zoom, 1.4, 25);

    // Desired horizontal movement relative to the camera.
    const fx = -Math.sin(this.camYaw), fz = -Math.cos(this.camYaw);
    const rx = Math.cos(this.camYaw), rz = -Math.sin(this.camYaw);
    let wx = fx * input.fwd + rx * input.right, wz = fz * input.fwd + rz * input.right;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    // gait: 0 walk, 1 run, 2 sprint (fractions blend; the touch joystick uses them).
    const gait = clamp(input.gait || 0, 0, 2);
    const target = gait <= 1 ? lerp(WALK, RUN, gait) : lerp(RUN, SPRINT, gait - 1);
    const accel = this.onGround ? 11 : 2.5;
    this.vel.x = damp(this.vel.x, wx * target, accel, dt);
    this.vel.z = damp(this.vel.z, wz * target, accel, dt);
    if (wl > 0.1) this.yaw += angleDelta(this.yaw, Math.atan2(-wx, -wz)) * (1 - Math.exp(-12 * dt));

    // Horizontal move with collision.
    let nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    [nx, nz] = w.resolveCircle(nx, nz, RADIUS);
    this.speed = dt > 0 ? Math.hypot(nx - this.pos.x, nz - this.pos.z) / dt : 0;
    this.pos.x = nx; this.pos.z = nz;

    // Vertical: jump, gravity, step onto curbs.
    const ground = w.groundAt(nx, nz);
    if (input.jump && this.onGround) { this.vel.y = JUMP_V; this.onGround = false; }
    if (!this.onGround) {
      this.vel.y -= GRAVITY * dt;
      this.pos.y += this.vel.y * dt;
      if (this.pos.y <= ground && this.vel.y <= 0) { this.pos.y = ground; this.vel.y = 0; this.onGround = true; }
    } else {
      this.pos.y = damp(this.pos.y, ground, 22, dt);
    }

    this.char.root.position.copy(this.pos);
    this.char.root.rotation.y = this.yaw;
    this.char.update(dt, this.speed, !this.onGround);

    this._updateCamera(dt);
  }

  _drive(dt, input) {
    const v = this.vehicle;
    this.camYaw -= input.lookX;
    this.camPitch = clamp(this.camPitch + input.lookY, -0.3, 1.2);
    this.camDist = clamp(this.camDist + input.zoom, 2.5, 25);
    v.drive(dt, { throttle: input.fwd, steer: input.right, brake: input.brake }, this.world);
    // The camera swings back behind the vehicle while it moves, unless you're looking around.
    if (input.lookX) this._lookT = 1.5;
    else this._lookT = Math.max(0, (this._lookT || 0) - dt);
    if (Math.abs(v.speed) > 1 && !this._lookT) this.camYaw += angleDelta(this.camYaw, v.yaw) * (1 - Math.exp(-2.5 * dt));
    this.pos.set(v.x, v.y, v.z);
    this.yaw = v.yaw;
    this.speed = Math.abs(v.speed);
    this.char.update(dt, this.speed, false);
    this._updateCamera(dt);
  }

  _updateCamera(dt) {
    const w = this.world;
    const look = this._look.set(this.pos.x, this.pos.y + HEAD, this.pos.z);
    const rx = Math.cos(this.camYaw), rz = -Math.sin(this.camYaw);
    const shoulder = this.vehicle ? 0 : 0.45 * clamp(this.camDist / 3.5, 0.3, 1);
    look.x += rx * shoulder; look.z += rz * shoulder;

    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    const dx = Math.sin(this.camYaw) * cp, dy = sp, dz = Math.cos(this.camYaw) * cp;

    // Pull the camera in if a building is between the head and the camera.
    let dist = this.camDist;
    for (let t = 0.4; t <= this.camDist; t += 0.25) {
      const x = look.x + dx * t, y = look.y + dy * t, z = look.z + dz * t;
      if (w.heightAt(x, z) > y - 0.3) { dist = Math.max(0.5, t - 0.4); break; }
    }
    this.camActual = dist < this.camActual ? dist : damp(this.camActual, dist, 6, dt);
    const d = this.camActual;
    const cam = this._cam.set(look.x + dx * d, look.y + dy * d, look.z + dz * d);
    cam.y = Math.max(cam.y, w.groundAt(cam.x, cam.z) + 0.25);
    this.camera.position.copy(cam);
    this.camera.lookAt(look);
    this.char.root.visible = d > 0.7 && !(this.vehicle && this.vehicle.kind === 'car');
  }
}
