import * as THREE from 'three';
import { clamp, damp, lerp } from './util.js';

// Stylized procedural person. Faces -Z at yaw 0; root sits at the feet.
export class Character {
  constructor({ shirt = '#ff7a45', pants = '#34495e', skin = '#e8b48f', hair = '#2d1e16', shoes = '#f4f4f2', pack = '#1f4e8c' } = {}) {
    const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, envMapIntensity: 0.6 });
    const M = { shirt: mat(shirt), pants: mat(pants), skin: mat(skin), hair: mat(hair), shoes: mat(shoes), pack: mat(pack), eye: mat('#1d1d1f') };
    const part = (geom, m, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(geom, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      return mesh;
    };
    const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 10);

    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);

    this.hips = new THREE.Group();
    this.hips.position.y = 0.832; // puts the soles exactly at y = 0
    this.body.add(this.hips);

    const torso = part(capsule(0.19, 0.3), M.shirt, 0, 0.33, 0);
    torso.scale.set(1, 1, 0.72);
    this.hips.add(torso);
    const pelvis = part(capsule(0.165, 0.05), M.pants, 0, 0.03, 0);
    pelvis.scale.set(1.05, 1, 0.78);
    this.hips.add(pelvis);
    this.hips.add(part(new THREE.BoxGeometry(0.3, 0.38, 0.13), M.pack, 0, 0.36, 0.17));

    this.head = new THREE.Group();
    this.head.position.y = 0.7;
    this.hips.add(this.head);
    this.head.add(part(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 8), M.skin, 0, 0.0, 0));
    this.head.add(part(new THREE.SphereGeometry(0.15, 16, 12), M.skin, 0, 0.14, 0));
    const hairCap = part(new THREE.SphereGeometry(0.158, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), M.hair, 0, 0.15, 0.012);
    this.head.add(hairCap);
    for (const x of [-0.05, 0.05]) this.head.add(part(new THREE.SphereGeometry(0.018, 6, 4), M.eye, x, 0.15, -0.138));

    const limb = (parent, x, y, upperR, upperLen, lowerR, lowerLen, upperMat, lowerMat, endGeom, endMat, endPos) => {
      const joint = new THREE.Group();
      joint.position.set(x, y, 0);
      parent.add(joint);
      joint.add(part(capsule(upperR, upperLen), upperMat, 0, -upperLen / 2 - upperR * 0.5, 0));
      const mid = new THREE.Group();
      mid.position.y = -upperLen - upperR;
      joint.add(mid);
      mid.add(part(capsule(lowerR, lowerLen), lowerMat, 0, -lowerLen / 2 - lowerR * 0.5, 0));
      const end = part(endGeom, endMat, ...endPos);
      mid.add(end);
      return { joint, mid };
    };

    this.armL = limb(this.hips, -0.25, 0.56, 0.058, 0.2, 0.05, 0.19, M.shirt, M.skin, new THREE.SphereGeometry(0.055, 8, 6), M.skin, [0, -0.3, 0]);
    this.armR = limb(this.hips, 0.25, 0.56, 0.058, 0.2, 0.05, 0.19, M.shirt, M.skin, new THREE.SphereGeometry(0.055, 8, 6), M.skin, [0, -0.3, 0]);
    this.legL = limb(this.hips, -0.1, 0, 0.082, 0.3, 0.07, 0.3, M.pants, M.pants, new THREE.BoxGeometry(0.12, 0.08, 0.26), M.shoes, [0, -0.41, -0.04]);
    this.legR = limb(this.hips, 0.1, 0, 0.082, 0.3, 0.07, 0.3, M.pants, M.pants, new THREE.BoxGeometry(0.12, 0.08, 0.26), M.shoes, [0, -0.41, -0.04]);
    this.armL.joint.rotation.z = -0.08;
    this.armR.joint.rotation.z = 0.08;

    this.phase = 0;
    this.walk = 0;
    this.run = 0;
    this.air = 0;
    this.t = 0;
  }

  // speed: horizontal m/s actually moved; airborne: not on ground.
  update(dt, speed, airborne) {
    this.t += dt;
    this.walk = damp(this.walk, clamp(speed / 1.8, 0, 1), 10, dt);
    this.run = damp(this.run, clamp((speed - 2.6) / 2.6, 0, 1), 8, dt);
    this.air = damp(this.air, airborne ? 1 : 0, 14, dt);

    const stride = lerp(1.35, 2.4, this.run);
    this.phase += (speed * dt / stride) * Math.PI * 2;
    const p = this.phase;
    const legAmp = this.walk * lerp(0.48, 0.85, this.run);
    const kneeAmp = this.walk * lerp(0.65, 1.45, this.run);
    const armAmp = this.walk * lerp(0.4, 0.95, this.run);
    const elbow = lerp(0.18, 1.25, this.run) * this.walk + 0.12;

    const ground = 1 - this.air;
    const sL = Math.sin(p), cL = Math.cos(p);
    this.legL.joint.rotation.x = (sL * legAmp) * ground + 0.55 * this.air;
    this.legR.joint.rotation.x = (-sL * legAmp) * ground - 0.25 * this.air;
    this.legL.mid.rotation.x = -Math.max(0, cL) * kneeAmp * ground - 1.0 * this.air;
    this.legR.mid.rotation.x = -Math.max(0, -cL) * kneeAmp * ground - 0.45 * this.air;

    const breathe = Math.sin(this.t * 2.2) * 0.03 * (1 - this.walk);
    this.armL.joint.rotation.x = (-sL * armAmp + breathe) * ground - 0.5 * this.air;
    this.armR.joint.rotation.x = (sL * armAmp + breathe) * ground - 0.5 * this.air;
    this.armL.joint.rotation.z = -0.08 - 0.45 * this.air;
    this.armR.joint.rotation.z = 0.08 + 0.45 * this.air;
    this.armL.mid.rotation.x = elbow;
    this.armR.mid.rotation.x = elbow;

    const bob = lerp(0.025, 0.07, this.run) * this.walk;
    this.body.position.y = (Math.abs(Math.cos(p)) - 0.5) * 2 * bob * ground;
    this.body.rotation.x = -0.16 * this.run * ground;
    this.hips.rotation.y = Math.sin(p) * 0.08 * this.walk * ground;
    this.head.rotation.y = -this.hips.rotation.y;
  }
}
