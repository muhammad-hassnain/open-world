import * as THREE from 'three';
import { clamp, damp, angleDelta } from './util.js';

const WALK = 2.2;
const RUN = 5.6;
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

  update(dt, input) {
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
    const target = input.run ? RUN : WALK;
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

  _updateCamera(dt) {
    const w = this.world;
    const look = this._look.set(this.pos.x, this.pos.y + HEAD, this.pos.z);
    const rx = Math.cos(this.camYaw), rz = -Math.sin(this.camYaw);
    const shoulder = 0.45 * clamp(this.camDist / 3.5, 0.3, 1);
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
    this.char.root.visible = d > 0.7;
  }
}
