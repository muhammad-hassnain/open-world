import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { clamp, damp, lerp } from './util.js';
import { contactMaterial } from './materials.js';

// Textured CC0 Innerscene / MakeHuman people. Optimized locally, including separate
// distant meshes sharing the same images. Keep the old man/woman profile IDs compatible.
export const LOOKS = {
  man: { label: 'Sam · casual', asset: 'sam', height: 1.78, nativeHeight: 1.78 },
  woman: { label: 'Maya · casual', asset: 'maya', height: 1.68, nativeHeight: 1.67 },
  harper: { label: 'Harper · tailored', asset: 'harper', height: 1.68, nativeHeight: 1.67 },
  jordan: { label: 'Jordan · tailored', asset: 'jordan', height: 1.83, nativeHeight: 1.84 },
};
const MODEL_VERSION = 1;  // bump when replacing these new asset filenames

// Riding a bicycle: extra bone rotations (radians, about each bone's local X) on top of the idle
// pose; the legs follow the pedals.
export const RIDE = { seatHeight: 0.94, lean: -0.42, pedalRadius: 0.16 };
const AY = new THREE.Vector3(0, 1, 0), _q = new THREE.Quaternion();
const AX = new THREE.Vector3(1, 0, 0);
const _ik = Array.from({ length: 9 }, () => new THREE.Vector3());
const _worldQ = new THREE.Quaternion(), _parentQ = new THREE.Quaternion();

function aimBone(bone, target) {
  // Work before the parent's scale: a wider pedestrian has a nonuniform model scale.
  const to = bone.parent.worldToLocal(_ik[5].copy(target)).sub(bone.position).normalize();
  const from = _ik[6].copy(AY).applyQuaternion(bone.quaternion);
  bone.quaternion.premultiply(_q.setFromUnitVectors(from, to));
  bone.updateWorldMatrix(false, true);
}

// Analytic two-bone reach. MakeHuman feet are separate root joints, so place the foot
// explicitly after aiming the thigh and calf. Hands already inherit from their forearms.
function reach(upper, lower, end, target, pole, independentFoot = false, lengths = null, space = null) {
  if (!upper || !lower || !end) return;
  const [a, b, c, axis, bend] = _ik;
  upper.getWorldPosition(a); lower.getWorldPosition(b); end.getWorldPosition(c);
  const goal = _ik[7].copy(target), guide = _ik[8].copy(pole);
  if (space) for (const v of [a, b, c, goal, guide]) space.worldToLocal(v);
  const l1 = lengths ? lengths[0] : a.distanceTo(b), l2 = lengths ? lengths[1] : b.distanceTo(c);
  const distance = clamp(a.distanceTo(goal), 0.01, l1 + l2 - 0.001);
  axis.subVectors(goal, a).normalize();
  // The foot and calf must end at the same reachable point, even for a long stride.
  c.copy(a).addScaledVector(axis, distance);
  bend.subVectors(guide, a).addScaledVector(axis, -bend.dot(axis)).normalize();
  const along = (l1 * l1 + distance * distance - l2 * l2) / (2 * distance);
  b.copy(a).addScaledVector(axis, along).addScaledVector(bend, Math.sqrt(Math.max(0, l1 * l1 - along * along)));
  if (space) { space.localToWorld(b); space.localToWorld(c); }
  aimBone(upper, b); aimBone(lower, c);
  if (independentFoot) end.position.copy(end.parent.worldToLocal(c));
}

const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

// These source clips contain two strides. Align their left-foot contacts before blending;
// independent action clocks otherwise mix a planted leg with the other clip's raised leg.
function contactOffset(clip) {
  const track = clip.tracks.find(t => t.name === 'foot_l.position');
  if (!track) return 0;
  const sample = track.createInterpolant(), period = clip.duration / 2;
  let forward = -Infinity, offset = 0;
  for (let i = 0; i < 120; i++) {
    const z = sample.evaluate(i / 120 * period)[2];
    if (z > forward) { forward = z; offset = i / 120; }
  }
  return offset;
}

const manager = new THREE.LoadingManager();
// GLB query strings don't propagate to external images. Version those as well, so replacing
// a skin/clothing texture works on static hosts that cache assets for a day.
manager.setURLModifier(url => /assets\/characters\/.+\.(png|jpe?g)$/.test(url) ? `${url}?v=${MODEL_VERSION}` : url);
const loader = new GLTFLoader(manager);
const loaded = new Map(), sharedTextures = new Map();

function shareTextures(gltf, material) {
  for (const [slot, texture] of Object.entries(material)) {
    if (!texture?.isTexture) continue;
    const id = gltf.parser.associations.get(texture)?.textures;
    const source = gltf.parser.json.textures?.[id]?.source;
    const uri = gltf.parser.json.images?.[source]?.uri;
    if (!uri) continue;
    texture.updateMatrix();
    // Sampler, UV transform and color-space differences must never be merged.
    const key = JSON.stringify([uri, texture.colorSpace, texture.flipY, texture.channel,
      texture.wrapS, texture.wrapT, texture.minFilter, texture.magFilter, texture.matrix.elements]);
    if (sharedTextures.has(key)) material[slot] = sharedTextures.get(key);
    else sharedTextures.set(key, texture);
  }
}
function loadLook(name, low = false) {
  const key = name + (low ? '-lod' : '');
  if (!loaded.has(key)) {
    loaded.set(key, loader.loadAsync(`assets/characters/${LOOKS[name].asset}${low ? '-lod' : ''}.glb?v=${MODEL_VERSION}`).then((gltf) => {
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        // These rigs are in meters. A conservative whole-body bound covers every
        // gait, jump and rider pose without recomputing skinned vertices each frame.
        // Previously every mesh of every person drew even behind the camera.
        o.frustumCulled = true;
        o.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.5);
        o.receiveShadow = true;
        o.material.envMapIntensity = 0.45;
        // Hair and eyelashes use cutouts: depth writes avoid transparent sorting through faces.
        if (o.material.transparent) {
          o.material.transparent = false; o.material.alphaTest = 0.4;
          o.material.alphaToCoverage = true; o.material.depthWrite = true;
        }
        for (const k of ['map', 'normalMap', 'roughnessMap']) if (o.material[k]) o.material[k].anisotropy = 4;
        shareTextures(gltf, o.material);
      });
      return { scene: gltf.scene, animations: gltf.animations }; // release parser/binary caches
    }));
  }
  return loaded.get(key);
}

// A person in the world (the player, or later other players): the 3D model for a look, animated
// from how fast it moves. A simple figure stands in until the model has loaded, or if it can't.
// Faces -Z at yaw 0; root sits at the feet.
export class Character {
  constructor(look = 'man', appearance = {}) {
    this.appearance = appearance;
    this.low = !!appearance.low;
    this.elapsed = appearance.phase || 0;
    this.stridePhase = this.elapsed % 1;
    this.footfalls = 0;
    this.gaze = 0;
    this.gazeTarget = 0;
    this.ownedMaterials = [];
    this.root = new THREE.Group();
    this.body = new THREE.Group();     // leans forward when sprinting
    this.root.add(this.body);
    this.fallback = new SimpleFigure();
    this.root.add(this.fallback.root);
    this.model = null;
    this.mixer = null;
    this.look = null;
    this.w = { idle: 1, walk: 0, jog: 0, run: 0 };
    this.air = 0;
    this.seat = null;    // null | 'bike' | 'car'
    this.pedal = 0;
    this.pedalAngle = null;
    this._target = new THREE.Vector3(); this._pole = new THREE.Vector3();
    this._hip = new THREE.Vector3();
    this._shoulder = new THREE.Vector3(); this._elbow = new THREE.Vector3();
    this._rootQ = new THREE.Quaternion(); this._footQ = new THREE.Quaternion();
    this._normal = new THREE.Vector3(); this._slopeQ = new THREE.Quaternion();
    this._sole = new THREE.Vector3();
    this.setLook(look);
  }

  setLook(look) {
    if (!LOOKS[look]) look = 'man';
    if (look === this.look) return this.ready;
    this.look = look;
    const token = (this._token = (this._token || 0) + 1);
    this.ready = loadLook(look, this.low)
      .then((gltf) => { if (token === this._token) this._use(gltf, LOOKS[look]); })
      .catch((e) => console.warn(`Character ${look} didn't load: ${e.message}`));
    return this.ready;
  }

  _use(gltf, spec) {
    this._releaseModel();
    const s = spec.height / spec.nativeHeight * (this.appearance.heightScale || 1);
    const model = SkeletonUtils.clone(gltf.scene);
    model.scale.set(s * (this.appearance.buildScale || 1), s, s * (this.appearance.buildScale || 1));
    model.rotation.y = Math.PI;  // glTF models face +Z
    const tint = this.appearance.tint && new THREE.Color(this.appearance.tint);
    const materials = new Map();
    model.traverse(o => {
      if (!o.isMesh) return;
      contactMaterial(o.material);
      o.castShadow = this.appearance.shadows !== false;
      // Clone only tintable clothes; skin/eyes/hair and all texture images stay shared.
      if (tint && /original (top|bottom|tailored)|casualsuit|satin.*top|tailored trousers/.test(o.material.name)) {
        if (!materials.has(o.material)) {
          const m = o.material.clone();
          contactMaterial(m);
          if (m.map) m.color.copy(tint).lerp(new THREE.Color('white'), 0.35);
          else m.color.copy(tint).multiplyScalar(/bottom|trousers/.test(m.name) ? 0.28 : 0.7);
          materials.set(o.material, m); this.ownedMaterials.push(m);
        }
        o.material = materials.get(o.material);
      }
    });
    this.body.add(model);
    this.fallback.root.visible = false;
    this.model = model;
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    for (const [key, name] of [['idle', 'Idle'], ['walk', 'Walk'], ['jog', 'Jog'], ['run', 'Run']]) {
      const action = this.mixer.clipAction(gltf.animations.find((a) => a.name === name));
      action.play();
      action.time = this.elapsed % action.getClip().duration;
      action.setEffectiveWeight(this.w[key]);
      this.actions[key] = action;
    }
    const bone = (n) => model.getObjectByName(n);
    this.bones = { hips: bone('pelvis'), torso: bone('spine_02'), head: bone('head'),
      ul: bone('thigh_l'), ur: bone('thigh_r'), ll: bone('calf_l'), lr: bone('calf_r'),
      al: bone('upperarm_l'), ar: bone('upperarm_r'), fl: bone('lowerarm_l'), fr: bone('lowerarm_r'),
      footL: bone('foot_l'), footR: bone('foot_r'), handL: bone('hand_l'), handR: bone('hand_r') };
    // Measure the unanimated rig in character space, including each person's proportions.
    // Feet on this rig are siblings of the pelvis, not children of the calves.
    const bodyQ = this.body.quaternion.clone(), bodyP = this.body.position.clone();
    this.body.quaternion.identity(); this.body.position.set(0, 0, 0);
    this.root.updateWorldMatrix(true, true);
    const local = b => this.root.worldToLocal(b.getWorldPosition(new THREE.Vector3()));
    this.restHip = local(this.bones.hips);
    this.root.getWorldQuaternion(this._rootQ).invert();
    const B = this.bones;
    this.legs = [[B.ul, B.ll, B.footL], [B.ur, B.lr, B.footR]].map(([upper, lower, foot]) => {
      const hip = local(upper), knee = local(lower), ankle = local(foot);
      const lengths = [hip.distanceTo(knee), knee.distanceTo(ankle)];
      const rig = [upper, lower, foot].map(b => model.worldToLocal(b.getWorldPosition(new THREE.Vector3())));
      return { upper, lower, foot, hip, ankle, lengths, length: lengths[0] + lengths[1],
        ikLengths: [rig[0].distanceTo(rig[1]), rig[1].distanceTo(rig[2])],
        rotation: foot.getWorldQuaternion(new THREE.Quaternion()).premultiply(this._rootQ),
        target: new THREE.Vector3(), groundTarget: new THREE.Vector3(), groundRotation: new THREE.Quaternion(),
        shoeBox: new THREE.Box3(), pitch: 0 };
    });
    this.arms = [[B.al, B.fl], [B.ar, B.fr]].map(([upper, lower], i) => {
      const shoulder = local(upper), elbow = local(lower);
      return { upper, lower, length: shoulder.distanceTo(elbow), side: Math.sign(shoulder.x),
        leg: this.legs[i], oppositeLeg: this.legs[1 - i] };
    });
    // Measure the actual shoe soles once, so boots, heels and different body scales
    // share the contact solver without a guessed ankle-to-floor offset.
    // SkinnedMesh updates its inverse bind transform in updateMatrixWorld (the
    // similarly named updateWorldMatrix does not run that override).
    this.root.updateMatrixWorld(true);
    const inverseRoot = this.root.matrixWorld.clone().invert(), vertex = new THREE.Vector3();
    model.traverse(o => {
      if (!o.isSkinnedMesh || !/shoes/i.test(o.name + o.material.name)) return;
      o.skeleton.update();
      for (let i = 0; i < o.geometry.attributes.position.count; i++) {
        o.getVertexPosition(i, vertex).applyMatrix4(o.matrixWorld).applyMatrix4(inverseRoot);
        const leg = this.legs.find(l => l.ankle.x * vertex.x > 0);
        if (leg) leg.shoeBox.expandByPoint(vertex);
      }
    });
    for (const leg of this.legs) {
      const box = leg.shoeBox;
      if (box.isEmpty()) box.set(new THREE.Vector3(leg.ankle.x - 0.065, 0, -0.18), new THREE.Vector3(leg.ankle.x + 0.065, 0.1, 0.09));
      leg.sole = [];
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        leg.sole.push(leg.foot.worldToLocal(this.root.localToWorld(new THREE.Vector3(x, y, z))));
      }
    }
    this.gaitScale = (this.legs[0].length + this.legs[1].length) / (2 * 0.87);
    this.body.quaternion.copy(bodyQ); this.body.position.copy(bodyP);
    for (const k of ['walk', 'jog', 'run']) {
      this.actions[k].timeScale = 0;  // one shared contact phase, advanced in update()
      this.actions[k].contact = contactOffset(this.actions[k].getClip());
    }
    // Keep the last unmodified animation pose. Restoring bind rotations would fight the
    // mixer's cached constant tracks; saving position also handles independently rigged feet.
    this.pose = new Map(Object.values(this.bones).filter(Boolean).map(b =>
      [b, { q: b.quaternion.clone(), p: b.position.clone() }]));
    this.groundPose = new Map([B.hips, B.ul, B.ur, B.ll, B.lr, B.footL, B.footR].map(b =>
      [b, { q: b.quaternion.clone(), p: b.position.clone() }]));
  }

  _resetBones() {
    if (this.pose) for (const [b, v] of this.pose) { b.quaternion.copy(v.q); b.position.copy(v.p); }
  }

  _savePose() {
    for (const [b, v] of this.pose) { v.q.copy(b.quaternion); v.p.copy(b.position); }
  }

  // Sitting on a bike or in a car (null: on foot).
  setSeat(seat) {
    this.seat = seat;
    this.body.rotation.x = 0;
    this.body.position.y = 0;
    this.body.position.z = 0;
    this.pedalAngle = null;
    this.air = 0;
    this._resetBones();
  }

  // Background characters keep the lighter mesh; the player always uses the full mesh.
  setGaze(yaw = 0) { this.gazeTarget = clamp(yaw, -0.65, 0.65); }

  _releaseModel() {
    if (this.model) {
      this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model);
      const skeletons = new Set();
      this.model.traverse(o => { if (o.skeleton) skeletons.add(o.skeleton); });
      for (const s of skeletons) s.dispose();
      this.body.remove(this.model);
    }
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
  }

  dispose() {
    this._token++; this._releaseModel();
    const materials = new Set();
    this.fallback.root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); materials.add(o.material); } });
    for (const m of materials) m.dispose();
    this.root.removeFromParent();
  }

  // speed: horizontal m/s actually moved. A common stride phase keeps gait changes in step.
  update(dt, speed, airborne, world = null) {
    this.elapsed += dt;
    if (!this.mixer) { this.fallback.update(dt, speed, airborne); return; }
    if (this.seat) { this._sit(dt, speed); return; }
    const moving = clamp(speed / 0.45, 0, 1);
    const jogging = smooth((speed / this.gaitScale - 1.8) / 1.0);
    const running = smooth((speed / this.gaitScale - 3.2) / 1.3);
    const target = airborne ? { idle: 0.1, walk: 0, jog: 0, run: 0.9 } : {
      idle: 1 - moving, walk: moving * (1 - jogging),
      jog: moving * jogging * (1 - running), run: moving * jogging * running,
    };
    for (const k in target) {
      this.w[k] = damp(this.w[k], target[k], 10, dt);
      this.actions[k].setEffectiveWeight(this.w[k]);
    }
    const travel = 1 - this.w.idle;
    const fast = (this.w.jog + this.w.run) / Math.max(travel, 0.001);
    const sprint = smooth((speed / this.gaitScale - 4.5) / 4.5);
    const cadence = lerp(clamp(speed / (1.35 * this.gaitScale), 0, 1.2),
      lerp(1.3, 1.9, smooth((speed / this.gaitScale - 2.5) / 6.5)), fast);
    if (!airborne) {
      const next = this.stridePhase + cadence * dt;
      if (speed > 0.5) this.footfalls += Math.floor(next * 2) - Math.floor(this.stridePhase * 2);
      this.stridePhase = next % 1;
    }
    for (const k of ['walk', 'jog', 'run']) {
      const a = this.actions[k];
      a.time = ((this.stridePhase + a.contact) % 1) * a.getClip().duration / 2;
    }
    // The clips already lean the torso. Tilting the entire model also tips planted feet
    // through the ground, so keep the character's ground frame upright.
    this.body.rotation.x = 0;
    this.air = damp(this.air, airborne ? 1 : 0, 14, dt);
    this._resetBones();
    this.mixer.update(dt);
    this._savePose();
    this._stride(speed, cadence, travel, fast, sprint, this.air);
    if (world && !airborne) this._groundFeet(world);
    this.gaze = damp(this.gaze, this.gazeTarget, 5, dt);
    // A small independent glance while standing; no accumulated bone rotations.
    const glance = this.gaze + Math.sin(this.elapsed * 0.46) * 0.1 * (1 - moving);
    if (this.bones.head) this.bones.head.quaternion.multiply(_q.setFromAxisAngle(AY, glance));
  }

  // Population animation may run at 15/30 Hz, but contact follows movement every frame.
  fitGround(world) { if (this.model && !this.seat) this._groundFeet(world, false); }

  _groundFeet(world, save = true) {
    for (const [bone, pose] of this.groundPose) {
      if (save) { pose.p.copy(bone.position); pose.q.copy(bone.quaternion); }
      else { bone.position.copy(pose.p); bone.quaternion.copy(pose.q); }
    }
    this.root.updateWorldMatrix(true, true);
    const rootY = this.root.getWorldPosition(this._sole).y;
    let sum = 0, hipLimit = Infinity;
    for (const leg of this.legs) {
      const target = leg.groundTarget;
      leg.foot.getWorldPosition(target);
      const ground = world.groundAt(target.x, target.z, rootY, this._normal);
      // Follow the face beneath this foot; a curb's vertical face is never a support face.
      this._slopeQ.setFromUnitVectors(AY, this._normal);
      leg.foot.getWorldQuaternion(leg.groundRotation).premultiply(this._slopeQ);
      leg.foot.parent.getWorldQuaternion(_parentQ).invert();
      leg.foot.quaternion.copy(_parentQ.multiply(leg.groundRotation));
      leg.foot.updateWorldMatrix(false, true);
      let lift = ground - rootY + 0.012;
      for (const point of leg.sole) {
        this._sole.copy(point).applyMatrix4(leg.foot.matrixWorld);
        lift = Math.max(lift, world.groundAt(this._sole.x, this._sole.z, rootY) + 0.012 - this._sole.y);
      }
      target.y += lift; sum += lift;
      leg.upper.getWorldPosition(this._hip);
      const horizontal = (target.x - this._hip.x) ** 2 + (target.z - this._hip.z) ** 2;
      hipLimit = Math.min(hipLimit, target.y + Math.sqrt(Math.max(0, (leg.length * 0.995) ** 2 - horizontal)) - this._hip.y);
    }
    // Let the pelvis settle between different foot heights rather than stretching a leg.
    this.bones.hips.getWorldPosition(this._hip);
    this._hip.y += clamp(Math.min(sum / 2, hipLimit), -0.4, 0.4);
    this.bones.hips.position.copy(this.bones.hips.parent.worldToLocal(this._hip));
    this.root.updateWorldMatrix(true, true);
    for (const leg of this.legs) {
      this._pole.set(leg.hip.x, this.restHip.y - 0.35 * this.gaitScale, -this.gaitScale);
      this.root.localToWorld(this._pole);
      reach(leg.upper, leg.lower, leg.foot, leg.groundTarget, this._pole, true, leg.ikLengths, this.model);
      leg.foot.parent.getWorldQuaternion(_parentQ).invert();
      leg.foot.quaternion.copy(_parentQ.multiply(leg.groundRotation));
    }
  }

  _stride(speed, cadence, weight, fast, sprint, air) {
    if (weight < 0.001) return;
    this.root.updateWorldMatrix(true, true);
    this.root.getWorldQuaternion(this._rootQ);
    const size = this.gaitScale, length = this.legs[0].length;
    // Higher speed shortens ground contact and increases flight time, rather than
    // doubling the leg cadence. During contact the foot travels backward at speed m/s.
    const duty = Math.min(lerp(0.6, 0.38, fast), length * 0.96 * cadence / Math.max(speed, 0.01));
    const span = cadence > 0.001 ? speed * duty / cadence : 0;
    const toeOff = lerp(0.4, 0.65, fast), heelStrike = lerp(0.18, 0.04, fast);
    let hipY = this.restHip.y - 0.014 * size + fast * 0.022 * size;
    for (const [i, leg] of this.legs.entries()) {
      const phase = (this.stridePhase + i * 0.5) % 1, foot = leg.target;
      foot.x = leg.hip.x * lerp(0.82, 0.65, fast);
      let lift = 0;
      if (phase < duty) {
        const u = phase / duty;
        foot.z = span * (u - 0.46);
        leg.pitch = heelStrike * (1 - smooth(u / 0.22)) - toeOff * smooth((u - 0.68) / 0.32);
      } else {
        const u = (phase - duty) / (1 - duty), u2 = u * u, u3 = u2 * u;
        // Hermite recovery carries the foot backward into and out of the swing. Bound
        // the sprint tangent to keep recovery within reach; heel lift folds the knee.
        const tangent = Math.min(speed * (1 - duty) / Math.max(cadence, 0.01), length * 2.2);
        foot.z = span * (0.54 - smooth(u)) + tangent * (u - 3 * u2 + 2 * u3);
        lift = lerp(0.055, 0.29 + 0.1 * sprint, fast) * size * Math.pow(Math.sin(Math.PI * u), 1.4);
        leg.pitch = lerp(-toeOff, heelStrike, smooth(u));
      }
      foot.y = leg.ankle.y + lift + size * Math.max(0.065 * Math.sin(leg.pitch), -0.15 * Math.sin(leg.pitch));
      foot.z *= 1 - 0.4 * air; foot.y += size * (i ? 0.12 : 0.24) * air;
      leg.pitch *= 1 - 0.5 * air;
      // Lower the pelvis just enough for a soft, reachable contact. This also anticipates
      // landing as the swing foot approaches the ground, avoiding knee snaps.
      const dx = foot.x - leg.hip.x, dz = foot.z - leg.hip.z;
      const reachY = Math.sqrt(Math.max(0, (leg.length * 0.995) ** 2 - dx * dx - dz * dz));
      hipY = Math.min(hipY, foot.y + reachY - (leg.hip.y - this.restHip.y));
    }
    const B = this.bones;
    this.root.worldToLocal(B.hips.getWorldPosition(this._hip));
    this._hip.y = lerp(this._hip.y, hipY, weight);
    B.hips.position.copy(B.hips.parent.worldToLocal(this.root.localToWorld(this._hip)));
    this.root.updateWorldMatrix(true, true);
    for (const leg of this.legs) {
      this.root.worldToLocal(leg.foot.getWorldPosition(this._target));
      this._target.lerp(leg.target, weight);
      this._pole.set(leg.hip.x, hipY - 0.35 * size, -size);
      this.root.localToWorld(this._target); this.root.localToWorld(this._pole);
      reach(leg.upper, leg.lower, leg.foot, this._target, this._pole, true, leg.ikLengths, this.model);
      this._footQ.copy(this._rootQ).multiply(_q.setFromAxisAngle(AX, leg.pitch)).multiply(leg.rotation);
      leg.foot.getWorldQuaternion(_worldQ).slerp(this._footQ, weight);
      leg.foot.parent.getWorldQuaternion(_parentQ).invert();
      leg.foot.quaternion.copy(_parentQ.multiply(_worldQ));
    }
    this._swingArms(weight, fast, air);
  }

  _swingArms(weight, fast, air) {
    // The procedural stride replaces the clips' leg timing. Match shoulders to that
    // stride too: an advancing leg sends its own arm back and the opposite arm forward.
    // Keep the authored elbow bend, wrist pose and torso motion; fade into idle/jumps.
    for (const arm of this.arms) {
      this.root.worldToLocal(arm.upper.getWorldPosition(this._shoulder));
      this.root.worldToLocal(arm.lower.getWorldPosition(this._elbow));
      const leg = arm.leg;
      // Use the alternating part of the stride, excluding the common motion while
      // both feet are on the ground, so the arms continue to swing in opposition.
      const swing = (arm.oppositeLeg.target.z - leg.target.z) * 0.5;
      const pitch = Math.atan2(swing, leg.length * 0.75) * lerp(0.75, 1.05, fast);
      this._target.set(arm.side * 0.08, -Math.cos(pitch), Math.sin(pitch))
        .normalize().multiplyScalar(arm.length).add(this._shoulder);
      this._elbow.lerp(this._target, weight * (1 - air));
      aimBone(arm.upper, this.root.localToWorld(this._elbow));
    }
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
  this._savePose();
  if (this.seat !== 'bike') return;
  const B = this.bones, R = RIDE;
  this.pedal -= (speed * dt) / 0.34 * 0.55;
  const phase = this.pedalAngle ?? this.pedal;
  this.body.rotation.x = R.lean;
  this.body.position.set(0, 0, 0);
  this.root.updateWorldMatrix(true, true);
  B.hips.getWorldPosition(this._target); this.root.worldToLocal(this._target);
  this.body.position.set(0, R.seatHeight - this._target.y, 0.03 - this._target.z);
  this.root.updateWorldMatrix(true, true);
  // Targets use the bicycle's actual crank and grips, in the character root's coordinates.
  for (const side of [-1, 1]) {
    const left = side < 0;
    this._target.set(side * 0.11, 0.385 + side * Math.cos(phase) * R.pedalRadius,
      -0.16 + side * Math.sin(phase) * R.pedalRadius);
    this._pole.set(side * 0.17, 0.6, -0.7);
    this.root.localToWorld(this._target); this.root.localToWorld(this._pole);
    reach(left ? B.ul : B.ur, left ? B.ll : B.lr, left ? B.footL : B.footR, this._target, this._pole, true);
    this._target.set(side * 0.25, 1.04, -0.51);
    this._pole.set(side * 0.65, 1.15, -0.12);
    this.root.localToWorld(this._target); this.root.localToWorld(this._pole);
    reach(left ? B.al : B.ar, left ? B.fl : B.fr, left ? B.handL : B.handR, this._target, this._pole);
  }
};

// Stylized procedural person, used until (or if) the 3D model loads. Faces -Z at yaw 0; root sits at the feet.
class SimpleFigure {
  constructor({ shirt = '#ff7a45', pants = '#34495e', skin = '#e8b48f', hair = '#2d1e16', shoes = '#f4f4f2', pack = '#1f4e8c' } = {}) {
    const mat = (c) => contactMaterial(new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, envMapIntensity: 0.6 }));
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
