// Tire tracks, smoke and light halos. Original effects; smoke artwork is Kenney CC0.
// Four bounded batches, independent of chunk meshes. No extra lights or render passes.
import * as THREE from 'three';
import { layered } from './materials.js';
import { headlightPoints } from './vehicles.js';
import { clamp, lerp } from './util.js';

const TRACK_LIFE = 28;
const LIGHT_RANGE = 160;
const WARM = new THREE.Color('#ffe2b3'), HEAD = new THREE.Color('#fff1dc');
const P = new THREE.Vector3();
const SPARK = new THREE.Color('#ffc269');

function attribute(geometry, name, count, size, instanced = false) {
  const Type = instanced ? THREE.InstancedBufferAttribute : THREE.BufferAttribute;
  const a = new Type(new Float32Array(count * size), size).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(name, a);
  return a;
}

function billboards(capacity, glow, texture = null) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, .5, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  for (const [name, size] of [['center', 3], ['size', 1], ['opacity', 1], ['angle', 1], ['tint', 3]]) attribute(g, name, capacity, size, true);
  g.instanceCount = 0;
  const m = new THREE.ShaderMaterial({
    transparent: true, depthTest: true, depthWrite: false, fog: true, toneMapped: !glow,
    blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), map: { value: texture } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      #include <fog_pars_vertex>
      attribute vec3 center;
      attribute float size, opacity, angle;
      attribute vec3 tint;
      varying vec2 vUv;
      varying vec4 vColor;
      void main() {
        vUv = uv;
        vColor = vec4(tint, opacity);
        vec4 mvPosition = viewMatrix * vec4(center, 1.0);
        float c = cos(angle), s = sin(angle);
        mvPosition.xy += mat2(c, s, -s, c) * position.xy * size;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      #include <fog_pars_fragment>
      uniform sampler2D map;
      varying vec2 vUv;
      varying vec4 vColor;
      void main() {
        #include <logdepthbuf_fragment>
        ${glow ? `float r = length(vUv - 0.5) * 2.0;
        float a = exp(-5.5 * r * r) * (1.0 - smoothstep(0.7, 1.0, r));` : 'float a = texture2D(map, vUv).a;'}
        gl_FragColor = vec4(vColor.rgb, a * vColor.a);
        if (gl_FragColor.a < 0.003) discard;
        ${glow ? `#ifdef USE_FOG
          gl_FragColor.a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
        #endif` : '#include <fog_fragment>'}
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = glow ? 4 : 3;
  mesh.userData.capacity = capacity;
  return mesh;
}

function putSprite(mesh, i, p, size, opacity, color, angle = 0) {
  const a = mesh.geometry.attributes;
  a.center.setXYZ(i, p.x, p.y, p.z);
  a.size.setX(i, size); a.opacity.setX(i, opacity); a.angle.setX(i, angle);
  a.tint.setXYZ(i, color.r, color.g, color.b);
}

function finishSprites(mesh, count) {
  mesh.geometry.instanceCount = count;
  mesh.visible = count > 0;
  if (count) for (const [key, a] of Object.entries(mesh.geometry.attributes)) if (key !== 'position' && key !== 'uv') a.needsUpdate = true;
}

function tracks(capacity) {
  const g = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['uv', 2], ['born', 1], ['strength', 1]]) attribute(g, name, capacity * 4, size);
  const indices = [];
  for (let i = 0; i < capacity; i++) { const n = i * 4; indices.push(n, n + 1, n + 2, n, n + 2, n + 3); }
  g.setIndex(indices); g.setDrawRange(0, 0);
  const m = layered(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, fog: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), time: { value: 0 } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      #include <fog_pars_vertex>
      attribute float born, strength;
      varying vec2 vUv;
      varying float vBorn, vStrength;
      void main() {
        vUv = uv; vBorn = born; vStrength = strength;
        vec3 transformed = position;
        #include <project_vertex>
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      #include <fog_pars_fragment>
      uniform float time;
      varying vec2 vUv;
      varying float vBorn, vStrength;
      void main() {
        #include <logdepthbuf_fragment>
        float fade = 1.0 - smoothstep(10.0, ${TRACK_LIFE}.0, time - vBorn);
        float edge = smoothstep(0.0, 0.12, vUv.x) * (1.0 - smoothstep(0.88, 1.0, vUv.x));
        float tread = 0.75 + 0.25 * smoothstep(0.15, 0.4, fract(vUv.x * 5.0));
        gl_FragColor = vec4(vec3(0.018), 0.58 * vStrength * fade * edge * tread);
        if (gl_FragColor.a < 0.003) discard;
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }), 6);
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}

export class DrivingEffects {
  constructor(scene, mobile = false) {
    this.scene = scene;
    this.trackCapacity = mobile ? 384 : 1024;
    this.texture = new THREE.TextureLoader().load('assets/effects/smoke.png');
    this.smoke = billboards(mobile ? 64 : 160, false, this.texture);
    this.halos = billboards(mobile ? 48 : 96, true);
    this.sparks = billboards(mobile ? 24 : 64, true);
    this.tracks = tracks(this.trackCapacity);
    scene.add(this.tracks, this.smoke, this.halos, this.sparks);
    this.puffs = Array.from({ length: this.smoke.userData.capacity }, () => ({ life: 0, x: 0, y: 0, z: 0 }));
    this.bits = Array.from({ length: this.sparks.userData.capacity }, () => ({ life: 0 }));
    this.smokeColor = new THREE.Color();
    this.look = new THREE.Vector3();
    this.raysPerFrame = mobile ? 6 : 12;
    this.clear();
  }

  clear() {
    this.time = 0; this.nextTrack = 0; this.trackCount = 0; this.lastTrack = -TRACK_LIFE;
    this.nextPuff = 0; this.emission = 0; this.owner = null; this.lastWheels = [];
    this.nextBit = 0; this.impactOwner = null; this.lastImpact = 0;
    this.lamps = []; this.lampTimer = 0; this.visibility = new WeakMap();
    for (const p of this.puffs) p.life = 0;
    for (const p of this.bits) p.life = 0;
    this.tracks.geometry.setDrawRange(0, 0);
    this.tracks.visible = false;
    finishSprites(this.smoke, 0); finishSprites(this.halos, 0); finishSprites(this.sparks, 0);
  }

  dispose() {
    for (const mesh of [this.tracks, this.smoke, this.halos, this.sparks]) {
      this.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose();
    }
    this.texture.dispose();
  }

  get stats() {
    return { tracks: this.tracks.visible ? this.trackCount : 0, smoke: this.smoke.geometry.instanceCount,
      halos: this.halos.geometry.instanceCount, trackCapacity: this.trackCapacity, smokeCapacity: this.puffs.length,
      haloCapacity: this.halos.userData.capacity, sparks: this.sparks.geometry.instanceCount, sparkCapacity: this.bits.length };
  }

  update(dt, { world, player, camera, atmo, traffic }) {
    this.time += dt;
    this._tires(dt, world, player, atmo);
    this._impacts(dt, player, world);
    this.tracks.material.uniforms.time.value = this.time;
    this.tracks.visible = this.time - this.lastTrack < TRACK_LIFE;
    this._smoke(dt, camera, atmo);
    this._lights(dt, world, camera, atmo, traffic);
  }

  _surface(world, x, z, y) {
    if (!world.near(x, z).length) return null;
    const deck = world.deckAt(x, z, y);
    if (deck === null && (!world.onRoad(x, z) || world.onSidewalk(x, z))) return null;
    const h = world.groundAt(x, z, y);
    return Math.abs(h - y) < 0.7 ? h : null;
  }

  _tires(dt, world, player, atmo) {
    const v = player.vehicle;
    const car = v?.kind === 'car', speed = Math.abs(v?.speed || 0);
    const strength = car ? v.tireSlip || 0 : 0;
    const spray = car ? atmo.shown.rain * clamp((speed - 5) / 16, 0, 1) : 0;
    const offRoad = car && speed > 6 && !world.onRoad(v.x, v.z) && world.deckAt(v.x, v.z, v.y) === null && !world.onSidewalk(v.x, v.z);
    const area = offRoad ? world.areaAt(v.x, v.z) : null;
    const dust = offRoad && (!area || ['grass', 'wood', 'farm'].includes(area.k))
      ? clamp((speed - 6) / 18, 0, 0.6) * (1 - atmo.shown.rain) : 0;
    if (v !== this.owner || (!strength && !spray && !dust) || atmo.shown.snow > 0.3) {
      this.lastWheels = []; this.emission = 0; this.owner = v;
      if ((!strength && !spray && !dust) || atmo.shown.snow > 0.3) return;
    }
    if (!strength) this.lastWheels = [];
    v.root.updateMatrixWorld(true);
    const wheels = v.wheels;
    const [rx, rz] = v.right;
    this.emission += dt * (22 * strength * (1 - atmo.shown.rain * 0.9) + 18 * spray + 12 * dust);
    const emit = Math.floor(this.emission); this.emission -= emit;
    wheels.forEach((wheel, i) => {
      const tire = wheel.contact, tireStrength = tire?.skid || 0;
      if (!tire?.contact || tire.load < 1) { this.lastWheels[i] = null; return; }
      wheel.pivot.getWorldPosition(P);
      const contactY = P.y - v.wheelR;
      const y = dust ? world.groundAt(P.x, P.z, contactY) : this._surface(world, P.x, P.z, contactY);
      if (y === null) { this.lastWheels[i] = null; return; }
      if (Math.abs(y - contactY) > 0.4) { this.lastWheels[i] = null; return; }
      const p = { x: P.x, y, z: P.z, rx, rz };
      const last = this.lastWheels[i];
      const d = last ? Math.hypot(p.x - last.x, p.z - last.z) : 0;
      // Break trails on teleports, curbs or changing vehicles; subdivide for hills and ramps.
      if (tireStrength && !dust && last && d >= 0.25 && d < 4 && Math.abs(p.y - last.y) < 0.7) {
        const steps = Math.ceil(d / 0.5);
        let a = last;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps, b = { x: lerp(last.x, p.x, t), y: lerp(last.y, p.y, t), z: lerp(last.z, p.z, t), rx, rz };
          this._track(a, b, tireStrength, world); a = b;
        }
      }
      if (!last || d >= 0.25) this.lastWheels[i] = p;
      const count = Math.round(emit * Math.max(tireStrength, spray, dust) / Math.max(strength, spray, dust, 0.001));
      if (d < 4) for (let n = 0; n < count; n++) {
        const puff = this.puffs[this.nextPuff++ % this.puffs.length];
        Object.assign(puff, { x: p.x, y: y + 0.15, z: p.z, age: 0, life: spray > strength ? 0.45 + Math.random() * 0.3 : 1.4 + Math.random() * 0.6,
          vx: (Math.random() - 0.5) * 0.7, vz: (Math.random() - 0.5) * 0.7, size: 0.35 + Math.random() * 0.2,
          angle: Math.random() * Math.PI * 2, alpha: Math.max(tireStrength * 0.36, spray * 0.28, dust * 0.3), dust: !!dust });
      }
    });
  }

  _track(a, b, strength, world) {
    const corners = [[a, -1], [a, 1], [b, 1], [b, -1]].map(([p, s]) => {
      const x = p.x + p.rx * s * 0.13, z = p.z + p.rz * s * 0.13;
      const y = this._surface(world, x, z, p.y);
      return y === null ? null : [x, y + 0.04, z];
    });
    if (corners.some((p) => !p)) return;
    const aG = this.tracks.geometry.attributes, start = this.nextTrack * 4;
    for (let i = 0; i < 4; i++) {
      aG.position.setXYZ(start + i, ...corners[i]);
      aG.uv.setXY(start + i, i === 1 || i === 2 ? 1 : 0, i < 2 ? 0 : 1);
      aG.born.setX(start + i, this.time); aG.strength.setX(start + i, strength);
    }
    this.nextTrack = (this.nextTrack + 1) % this.trackCapacity;
    this.trackCount = Math.min(this.trackCount + 1, this.trackCapacity);
    this.lastTrack = this.time;
    this.tracks.geometry.setDrawRange(0, this.trackCount * 6);
    for (const a of Object.values(aG)) a.needsUpdate = true;
  }

  _smoke(dt, camera, atmo) {
    const wind = atmo.rain.material.uniforms.wind.value;
    const active = [];
    for (const p of this.puffs) {
      if (p.life <= 0) continue;
      p.age += dt;
      if (p.age >= p.life || Math.hypot(p.x - camera.position.x, p.z - camera.position.z) > 80) { p.life = 0; continue; }
      p.x += (p.vx + wind.x * 0.13) * dt; p.z += (p.vz + wind.y * 0.13) * dt; p.y += dt * 0.5;
      active.push(p);
    }
    active.sort((a, b) => camera.position.distanceToSquared(b) - camera.position.distanceToSquared(a));
    active.forEach((p, i) => {
      this.smokeColor.set(p.dust ? '#a48d69' : '#d3d7da').multiplyScalar(lerp(0.8, 0.12, atmo.night));
      const t = p.age / p.life;
      putSprite(this.smoke, i, p, p.size + p.age * 1.35, p.alpha * Math.min(1, p.age * 12) * (1 - t) ** 2, this.smokeColor, p.angle + p.age * 0.12);
    });
    finishSprites(this.smoke, active.length);
  }

  _impacts(dt, player, world) {
    const v = player.vehicle;
    if (v !== this.impactOwner) { this.impactOwner = v; this.lastImpact = v?.impactSerial || 0; }
    if (v?.kind === 'car' && v.impactSerial !== this.lastImpact) {
      this.lastImpact = v.impactSerial;
      const hit = v.impact;
      for (let i = 0; hit.kind !== 'landing' && i < Math.min(14, Math.ceil(hit.speed)); i++) {
        const p = this.bits[this.nextBit++ % this.bits.length], a = Math.random() * Math.PI * 2;
        Object.assign(p, { ...hit, life: 0.25 + Math.random() * 0.3, age: 0,
          vx: Math.cos(a) * 2.5, vz: Math.sin(a) * 2.5, vy: 1 + Math.random() * 2 });
      }
    }
    let count = 0;
    for (const p of this.bits) {
      if (p.life <= 0) continue;
      p.age += dt;
      if (p.age >= p.life) { p.life = 0; continue; }
      p.x += p.vx * dt; p.z += p.vz * dt; p.vy -= dt * 9; p.y += p.vy * dt;
      if (p.y < world.groundAt(p.x, p.z, p.y)) { p.life = 0; continue; }
      putSprite(this.sparks, count++, p, 0.16, (1 - p.age / p.life) * 1.3, SPARK);
    }
    finishSprites(this.sparks, count);
  }

  // Center visibility prevents a halo peeking around a wall whose light is hidden. Depth testing
  // additionally clips the sprite against scene geometry. Cache these short rays, like labels.
  _visible(key, p, world, camera, dt) {
    let v = this.visibility.get(key);
    if (!v) { v = { at: -1, alpha: 0, clear: false }; this.visibility.set(key, v); }
    if (this.time >= v.at && this.rayBudget > 0) {
      this.rayBudget--;
      v.at = this.time + 0.16 + Math.random() * 0.05;
      v.clear = true;
      const c = camera.position, n = Math.ceil(c.distanceTo(p) / 3);
      for (let i = 1; i < n; i++) {
        const t = i / n, x = lerp(c.x, p.x, t), y = lerp(c.y, p.y, t), z = lerp(c.z, p.z, t);
        const b = world.buildingAt(x, z);
        if (world.elevation(x, z) > y || (b?.solid && y > b.base && y < (b.top || b.base + b.height))) { v.clear = false; break; }
      }
    }
    v.alpha = lerp(v.alpha, v.clear ? 1 : 0, 1 - Math.exp(-dt * 18));
    return v.alpha;
  }

  _lights(dt, world, camera, atmo, traffic) {
    const cp = camera.position, night = clamp((atmo.night - 0.25) / 0.5, 0, 1);
    const capacity = this.halos.userData.capacity;
    this.rayBudget = this.raysPerFrame;
    camera.getWorldDirection(this.look);
    let count = 0;
    const add = (key, p, color, size, alpha) => {
      const d = cp.distanceTo(p);
      if (count >= capacity || alpha < 0.01 || d > LIGHT_RANGE || d < 0.3) return;
      if ((p.x - cp.x) * this.look.x + (p.y - cp.y) * this.look.y + (p.z - cp.z) * this.look.z < -size) return;
      const fade = this._visible(key, p, world, camera, dt) * clamp((LIGHT_RANGE - d) / 35, 0, 1);
      if (fade > 0.01) putSprite(this.halos, count++, p, size, alpha * fade, color);
    };
    // Vehicles in this set include the player's car, police, race rivals and abandoned cars.
    for (const v of world.obstacles) {
      if (v.kind !== 'car' || !v.root.visible || Math.hypot(v.x - cp.x, v.z - cp.z) > LIGHT_RANGE) continue;
      v.root.updateMatrixWorld(true);
      const [fx, fz] = v.fwd;
      const facing = clamp(((cp.x - v.x) * fx + (cp.z - v.z) * fz) / Math.max(1, Math.hypot(cp.x - v.x, cp.z - v.z)), 0, 1);
      if (night) for (const h of v.headlights) add(h, h.getWorldPosition(P), HEAD, 1.15, night * facing * 0.9);
      for (const b of v.bar || []) {
        const on = Math.max(b.mat.color.r, b.mat.color.g, b.mat.color.b) > 1;
        if (on) add(b.lamp, b.lamp.getWorldPosition(P), b.color, 1.8, 0.65 + night * 0.45);
      }
    }
    if (night) {
      for (const c of traffic.cars) {
        const d = Math.hypot(cp.x - c.x, cp.z - c.z);
        if (d > LIGHT_RANGE) continue;
        const facing = clamp(((cp.x - c.x) * c.fx + (cp.z - c.z) * c.fz) / Math.max(1, d), 0, 1);
        // The model is +Z-forward; its local X points left when mapped onto traffic's heading.
        const points = headlightPoints(c.type);
        if (!c.haloKeys) c.haloKeys = [{}, {}];
        points.forEach((p, i) => {
          const along = p.z * Math.cos(c.pitch) - p.y * Math.sin(c.pitch);
          P.set(c.x + c.fx * along + c.fz * p.x, c.y + p.y * Math.cos(c.pitch) + p.z * Math.sin(c.pitch), c.z + c.fz * along - c.fx * p.x);
          add(c.haloKeys[i], P, HEAD, 1.15, night * facing * 0.8);
        });
      }
      this.lampTimer -= dt;
      if (this.lampTimer <= 0) {
        this.lampTimer = 0.3;
        this.lamps = world.near(cp.x, cp.z, LIGHT_RANGE).flatMap((ch) => ch.lamps || []);
        this.lamps.sort((a, b) => Math.hypot(a.x - cp.x, a.z - cp.z) - Math.hypot(b.x - cp.x, b.z - cp.z));
      }
      for (const l of this.lamps) {
        if (count >= capacity) break;
        add(l, P.set(l.x, l.y + 4.55, l.z), WARM, 2.0, night * 0.8);
      }
    }
    finishSprites(this.halos, count);
  }
}
