import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { clamp, damp, lerp } from './util.js';

// The looks players can choose. Models from Quaternius' "Ultimate Modular Men" and "Ultimate
// Modular Women" packs (CC0), packed by tools/pack_character.py. height: meters tall in game;
// walk / run: ground speed (m/s, at the model's own 1.8 m size) at which that cycle's feet don't slide.
// Browsers keep files under assets/ for a day: bump MODEL_VERSION whenever a model file changes.
const MODEL_VERSION = 2;
export const LOOKS = {
  man: { label: 'Man', file: `assets/characters/man.glb?v=${MODEL_VERSION}`, height: 1.78, walk: 1.6, run: 3.35 },
  woman: { label: 'Woman', file: `assets/characters/woman.glb?v=${MODEL_VERSION}`, height: 1.68, walk: 1.3, run: 2.7 },
};
const MODEL_HEIGHT = 1.8;

// Riding a bicycle: extra bone rotations (radians, about each bone's local X) on top of the idle
// pose; the legs follow the pedals.
export const RIDE = { hip: 0.38, thigh: 1.0, thighSwing: 0.3, knee: 1.6, kneeSwing: 0.4, torso: 0.18,
  arm: -0.95, elbow: -0.25, lift: -0.05 };
const AX = new THREE.Vector3(1, 0, 0), _q = new THREE.Quaternion();
const turn = (bone, a) => { if (bone) bone.quaternion.multiply(_q.setFromAxisAngle(AX, a)); };

const loader = new GLTFLoader();
const loaded = new Map();
function loadLook(name) {
  if (!loaded.has(name)) {
    loaded.set(name, loader.loadAsync(LOOKS[name].file).then((gltf) => {
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.frustumCulled = false;  // skinned bounds don't follow the animation
        o.material.envMapIntensity = 0.6;
      });
      return gltf;
    }));
  }
  return loaded.get(name);
}

// A person in the world (the player, or later other players): the 3D model for a look, animated
// from how fast it moves. A simple figure stands in until the model has loaded, or if it can't.
// Faces -Z at yaw 0; root sits at the feet.
export class Character {
  constructor(look = 'man') {
    this.root = new THREE.Group();
    this.body = new THREE.Group();     // leans forward when sprinting
    this.root.add(this.body);
    this.fallback = new SimpleFigure();
    this.root.add(this.fallback.root);
    this.model = null;
    this.mixer = null;
    this.look = null;
    this.w = { idle: 1, walk: 0, run: 0 };
    this.lean = 0;
    this.seat = null;    // null | 'bike' | 'car'
    this.pedal = 0;
    this.setLook(look);
  }

  setLook(look) {
    if (!LOOKS[look]) look = 'man';
    if (look === this.look) return this.ready;
    this.look = look;
    const token = (this._token = (this._token || 0) + 1);
    this.ready = loadLook(look)
      .then((gltf) => { if (token === this._token) this._use(gltf, LOOKS[look]); })
      .catch((e) => console.warn(`Character ${look} didn't load: ${e.message}`));
    return this.ready;
  }

  _use(gltf, spec) {
    if (this.model) { this.mixer.stopAllAction(); this.body.remove(this.model); }
    const s = spec.height / MODEL_HEIGHT;
    const model = SkeletonUtils.clone(gltf.scene);
    model.scale.setScalar(s);
    model.rotation.y = Math.PI;  // glTF models face +Z
    this.body.add(model);
    this.fallback.root.visible = false;
    this.model = model;
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    for (const [key, name] of [['idle', 'Idle'], ['walk', 'Walk'], ['run', 'Run']]) {
      const action = this.mixer.clipAction(gltf.animations.find((a) => a.name === name));
      action.play();
      action.setEffectiveWeight(this.w[key]);
      this.actions[key] = action;
    }
    this.speeds = { walk: spec.walk * s, run: spec.run * s };
    const bone = (n) => model.getObjectByName(n);
    this.bones = { hips: bone('Hips'), torso: bone('Torso'), ul: bone('UpperLegL'), ur: bone('UpperLegR'), ll: bone('LowerLegL'),
      lr: bone('LowerLegR'), al: bone('UpperArmL'), ar: bone('UpperArmR'), fl: bone('LowerArmL'), fr: bone('LowerArmR') };
    // Rest rotations: bones the clips don't move would otherwise keep (and pile up) the riding pose.
    this.rest = new Map(Object.values(this.bones).filter(Boolean).map((b) => [b, b.quaternion.clone()]));
  }

  _resetBones() {
    if (this.rest) for (const [b, q] of this.rest) b.quaternion.copy(q);
  }

  // Sitting on a bike or in a car (null: on foot).
  setSeat(seat) {
    this.seat = seat;
    this.body.rotation.x = 0;
    this.body.position.y = 0;
    this._resetBones();
  }

  // speed: horizontal m/s actually moved; airborne: not on ground.
  update(dt, speed, airborne) {
    if (!this.mixer) { this.fallback.update(dt, speed, airborne); return; }
    if (this.seat) { this._sit(dt, speed); return; }
    // Blend idle -> walk -> run by speed; in the air, hold a stride.
    const walkT = clamp((speed - 0.15) / 0.5, 0, 1), runT = clamp((speed - 2.6) / 1.2, 0, 1);
    const target = airborne ? { idle: 0.2, walk: 0, run: 0.8 } : { idle: 1 - walkT, walk: walkT * (1 - runT), run: walkT * runT };
    for (const k in target) {
      this.w[k] = damp(this.w[k], target[k], 10, dt);
      this.actions[k].setEffectiveWeight(this.w[k]);
    }
    const a = this.actions;
    a.walk.timeScale = clamp(speed / this.speeds.walk, 0.6, 2);
    a.run.timeScale = airborne ? 0.1 : clamp(speed / this.speeds.run, 0.7, 2.3);
    this.lean = damp(this.lean, airborne ? 0 : clamp((speed - 6) / 3, 0, 1), 6, dt);
    this.body.rotation.x = -0.12 * this.lean;
    this.mixer.update(dt);
  }
}

// Seated: idle pose for the upper body; on a bike the legs pedal with the speed.
Character.prototype._sit = function (dt, speed) {
  for (const k in this.w) {
    this.w[k] = k === 'idle' ? 1 : 0;
    this.actions[k].setEffectiveWeight(this.w[k]);
  }
  this._resetBones();
  this.mixer.update(dt);
  if (this.seat !== 'bike') return;
  const B = this.bones, R = RIDE;
  this.pedal += (speed * dt) / 0.34 * 0.55;
  const s = Math.sin(this.pedal);
  this.body.position.y = R.lift;
  turn(B.hips, R.hip);
  turn(B.torso, R.torso);
  turn(B.ul, R.thigh + s * R.thighSwing); turn(B.ur, R.thigh - s * R.thighSwing);
  turn(B.ll, R.knee + s * R.kneeSwing); turn(B.lr, R.knee - s * R.kneeSwing);
  turn(B.al, R.arm); turn(B.ar, R.arm);
  turn(B.fl, R.elbow); turn(B.fr, R.elbow);
};

// Stylized procedural person, used until (or if) the 3D model loads. Faces -Z at yaw 0; root sits at the feet.
class SimpleFigure {
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
    this.sprint = 0;
    this.air = 0;
    this.t = 0;
  }

  // speed: horizontal m/s actually moved; airborne: not on ground.
  update(dt, speed, airborne) {
    this.t += dt;
    this.walk = damp(this.walk, clamp(speed / 1.8, 0, 1), 10, dt);
    this.run = damp(this.run, clamp((speed - 2.6) / 2.6, 0, 1), 8, dt);
    this.sprint = damp(this.sprint, clamp((speed - 6) / 2.6, 0, 1), 6, dt);
    this.air = damp(this.air, airborne ? 1 : 0, 14, dt);

    const stride = lerp(1.35, 2.4, this.run) + 1.5 * this.sprint;
    this.phase += (speed * dt / stride) * Math.PI * 2;
    const p = this.phase;
    const legAmp = this.walk * lerp(0.48, 0.85, this.run) * (1 + 0.25 * this.sprint);
    const kneeAmp = this.walk * lerp(0.65, 1.45, this.run) * (1 + 0.3 * this.sprint);
    const armAmp = this.walk * lerp(0.4, 0.95, this.run) * (1 + 0.3 * this.sprint);
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
    this.body.rotation.x = (-0.16 * this.run - 0.12 * this.sprint) * ground;
    this.hips.rotation.y = Math.sin(p) * 0.08 * this.walk * ground;
    this.head.rotation.y = -this.hips.rotation.y;
  }
}
