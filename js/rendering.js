import * as THREE from 'three';

// Keep the fixed light slots (no shader recompilation at dusk), but don't evaluate
// a physical BRDF for lamps that are off or fragments outside their light radius.
// Three r160 normally evaluates RE_Direct even when directLight.visible is false.
// Source: three.js/r160/src/renderers/shaders/ShaderChunk/lights_fragment_begin.glsl.js
export function optimizeLighting() {
  const key = 'lights_fragment_begin';
  if (THREE.ShaderChunk[key].includes('owLightDelta')) return;
  let chunk = THREE.ShaderChunk[key];
  for (const kind of ['point', 'spot']) {
    const name = `${kind}Light`;
    const pattern = new RegExp(`(${name} = ${kind}Lights\\[ i \\];)([\\s\\S]*?)(RE_Direct\\([^;]+;)`);
    chunk = chunk.replace(pattern, (_, assign, body, direct) => `${assign} {
      vec3 owLightDelta = ${name}.position - geometryPosition;
      if (any(greaterThan(${name}.color, vec3(0.0))) &&
          (${name}.distance <= 0.0 || dot(owLightDelta, owLightDelta) < ${name}.distance * ${name}.distance)) {
        ${body}
        if (directLight.visible) { ${direct} }
      }
    }
    `);
  }
  THREE.ShaderChunk[key] = chunk;
}

// Adjust only the 3D drawing buffer. DOM labels/HUD stay at native resolution;
// models, textures, shadows and the simulation keep their full settings.
export class RenderQuality {
  constructor(renderer, mobile = false) {
    this.renderer = renderer;
    this.mobile = mobile;
    this.mode = 'auto';
    try { if (localStorage.getItem('openworld.quality') === 'native') this.mode = 'native'; } catch { /* private mode */ }
    this.samples = []; this.fast = 0; this.slow = 0; this.cooldown = 2;
    this.stats = { fps: 0, pixelRatio: 1, targetFPS: 45, limited: false };
    this.resize(true);
  }

  resize(initial = false) {
    this.maxRatio = Math.min(devicePixelRatio || 1, this.mobile ? 1.5 : 2);
    this.minRatio = Math.min(1, this.maxRatio);
    const start = Math.max(this.minRatio, Math.min(this.maxRatio, 1.5, Math.sqrt(2400000 / (innerWidth * innerHeight))));
    this.setRatio(this.mode === 'native' ? this.maxRatio : initial ? start : Math.min(this.renderer.getPixelRatio(), this.maxRatio));
    this.samples.length = 0; this.cooldown = 2;
  }

  setMode(mode) {
    this.mode = mode === 'native' ? 'native' : 'auto';
    try { localStorage.setItem('openworld.quality', this.mode); } catch { /* private mode */ }
    this.fast = this.slow = 0;
    this.resize(true);
  }

  setRatio(ratio) {
    ratio = Math.max(this.minRatio, Math.min(this.maxRatio, ratio));
    if (Math.abs(this.renderer.getPixelRatio() - ratio) > 0.01) this.renderer.setPixelRatio(ratio);
    this.stats.pixelRatio = ratio;
  }

  update(seconds, active) {
    if (!active || seconds <= 0 || seconds > 0.25) { this.samples.length = 0; this.cooldown = 2; return; }
    if ((this.cooldown -= seconds) > 0) return;
    this.samples.push(seconds);
    const time = this.samples.reduce((sum, v) => sum + v, 0);
    if (time < 1) return;
    const fps = this.samples.length / time;
    this.stats.fps = fps;
    this.samples.length = 0;
    if (this.mode !== 'auto') return;
    const ratio = this.renderer.getPixelRatio();
    this.slow = fps < 43 ? this.slow + 1 : 0;
    // Recover detail when the next step's extra pixels should still leave a
    // margin above 40. This also works on 60 Hz displays, which cap measured FPS.
    const next = Math.min(this.maxRatio, ratio + 0.125);
    this.fast = fps * (ratio / next) ** 2 > 45 ? this.fast + 1 : 0;
    if (this.slow >= 2 && ratio > this.minRatio) {
      this.setRatio(ratio - 0.125); this.cooldown = 2; this.fast = this.slow = 0;
    } else if (this.fast >= 8 && ratio < this.maxRatio) {
      this.setRatio(ratio + 0.125); this.cooldown = 3; this.fast = this.slow = 0;
    }
    this.stats.limited = fps < 40 && ratio <= this.minRatio + 0.01;
  }
}
