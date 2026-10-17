// Original synthesized game audio. One shared AudioContext, no downloads or audio assets.
import { clamp } from './util.js';

export class Soundscape {
  constructor(siren) {
    this.siren = siren;
    this.ctx = null;
    this.voices = new Set();
    this.listener = null;
    this.active = false;
    this.reset();
  }

  unlock() {
    this.siren.unlock();
    const c = this.siren.ctx;
    if (!c || this.ctx) return;
    this.ctx = c;
    const master = c.createGain(), compressor = c.createDynamicsCompressor();
    master.gain.value = 0;
    compressor.threshold.value = -18; compressor.ratio.value = 5;
    master.connect(compressor).connect(c.destination);
    this.master = master;
    const noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), data = noise.getChannelData(0);
    let smooth = 0;
    for (let i = 0; i < data.length; i++) {
      smooth = (smooth + (Math.random() * 2 - 1) * 0.12) / 1.12;
      data[i] = smooth * 2;
    }
    this.noise = noise;
    const loop = (type, frequency, q = 1) => {
      const source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
      source.buffer = noise; source.loop = true;
      filter.type = type; filter.frequency.value = frequency; filter.Q.value = q;
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(master); source.start();
      return { source, filter, gain };
    };
    this.rain = loop('lowpass', 3500);
    this.tires = loop('bandpass', 1500, 2);
    this.road = loop('lowpass', 280);
    this.engineFilter = c.createBiquadFilter(); this.engineFilter.type = 'lowpass';
    this.engineGain = c.createGain(); this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(master);
    this.engine = [1, 2.01].map((ratio) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sawtooth'; o.frequency.value = 35 * ratio;
      g.gain.value = ratio === 1 ? 0.65 : 0.2;
      o.connect(g).connect(this.engineFilter); o.start();
      return { o, ratio };
    });
  }

  reset() {
    this.step = 0; this.footfalls = null; this.gear = 1; this.owner = null; this.lastImpact = 0; this.hornAt = -1;
    for (const v of this.voices) v.stop();
    this.voices.clear();
    this.quiet();
  }

  quiet() {
    this.active = false;
    if (this.master) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.025);
  }

  get stats() {
    return { state: this.ctx?.state || 'locked', voices: this.voices.size, gear: this.gear,
      audible: !!(this.active && this.siren.on && this.ctx?.state === 'running') };
  }

  _pan(p) {
    if (!p || !this.listener) return { gain: 1, pan: 0 };
    const l = this.listener, dx = p.x - l.x, dz = p.z - l.z, d = Math.hypot(dx, dz);
    return { gain: clamp(1 - d / 65, 0, 1) ** 2,
      pan: clamp((dx * Math.cos(l.yaw) - dz * Math.sin(l.yaw)) / Math.max(4, d), -1, 1) };
  }

  _voice(duration, p) {
    if (!this.ctx || !this.active || !this.siren.on || this.voices.size >= 8) return null;
    const spatial = this._pan(p);
    if (spatial.gain < 0.01) return null;
    const c = this.ctx, gain = c.createGain(), pan = c.createStereoPanner();
    pan.pan.value = spatial.pan; gain.gain.value = 0;
    gain.connect(pan).connect(this.master);
    const v = { gain, start: c.currentTime, end: c.currentTime + duration, nodes: [],
      stop: () => {
        if (v.stopped) return;
        v.stopped = true;
        for (const n of v.nodes) { try { n.stop?.(); } catch { /* already stopped */ } n.disconnect(); }
        gain.disconnect(); pan.disconnect(); this.voices.delete(v);
      } };
    v.level = spatial.gain;
    this.voices.add(v);
    return v;
  }

  _noiseHit(level, frequency, duration, p) {
    const v = this._voice(duration, p);
    if (!v) return;
    const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter();
    s.buffer = this.noise; f.type = 'lowpass'; f.frequency.value = frequency;
    s.connect(f).connect(v.gain); v.nodes.push(s, f);
    v.gain.gain.setValueAtTime(level * v.level, v.start);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, v.end);
    s.start(v.start, Math.random()); s.stop(v.end);
    s.onended = () => v.stop();
  }

  horn(p = null) {
    if (!this.ctx || this.ctx.currentTime < this.hornAt) return;
    const v = this._voice(0.3, p);
    if (!v) return;
    this.hornAt = this.ctx.currentTime + 0.8; // also limits a whole traffic queue
    for (const hz of [220, 277]) {
      const o = this.ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = hz;
      o.connect(v.gain); v.nodes.push(o); o.start(v.start); o.stop(v.end);
    }
    v.gain.gain.linearRampToValueAtTime(0.11 * v.level, v.start + 0.025);
    v.gain.gain.setValueAtTime(0.11 * v.level, v.end - 0.06);
    v.gain.gain.linearRampToValueAtTime(0, v.end);
    v.nodes[0].onended = () => v.stop();
  }

  update(dt, { player, camera, world, weather, active }) {
    this.active = active && !document.hidden;
    this.listener = { x: camera.position.x, z: camera.position.z, yaw: player.camYaw + (player.lookBack ? Math.PI : 0) };
    const footfalls = player.char.footfalls;
    const stepped = this.footfalls !== null && footfalls > this.footfalls;
    this.footfalls = footfalls;  // consume contacts even while muted or inside a vehicle
    if (!this.ctx) return;
    const c = this.ctx, now = c.currentTime;
    this.master.gain.setTargetAtTime(this.active && this.siren.on ? 0.65 : 0, now, 0.04);
    if (!this.active) return;
    const v = player.vehicle, car = v?.kind === 'car', speed = Math.abs(v?.speed || 0);
    if (v !== this.owner) { this.owner = v; this.gear = 1; this.lastImpact = v?.impactSerial || 0; }
    this.gear = v?.gear || 1;
    const throttle = car ? v.engineLoad || 0 : 0;
    const rpm = v?.rpm || 850;
    for (const { o, ratio } of this.engine) o.frequency.setTargetAtTime(rpm / 30 * ratio, now, 0.08);
    this.engineFilter.frequency.setTargetAtTime(180 + throttle * 380 + speed * 5, now, 0.1);
    this.engineGain.gain.setTargetAtTime(car ? 0.055 + throttle * 0.04 : 0, now, 0.08);
    const squeal = car ? v.tireSlip || 0 : 0;
    this.tires.gain.gain.setTargetAtTime(squeal * 0.26 * (1 - weather.rain * 0.5), now, 0.06);
    this.road.gain.gain.setTargetAtTime(car ? Math.min(speed / 35, 1) * 0.1 : 0, now, 0.15);
    this.rain.gain.gain.setTargetAtTime(weather.rain * 0.2, now, 0.2);
    if (v && v.impactSerial !== this.lastImpact) {
      this.lastImpact = v.impactSerial;
      this._noiseHit(clamp(v.impact.speed / 30, 0.08, 0.5), 1000, 0.22);
    }
    if (!v && player.onGround && player.speed > 0.5) {
      this.step += dt * player.speed;
      if (player.char.mixer ? stepped : this.step > (player.speed > 3 ? 1.65 : 1.1)) {
        this.step = 0;
        const hard = world.onSidewalk(player.pos.x, player.pos.z) || world.onRoad(player.pos.x, player.pos.z);
        this._noiseHit(0.13, hard ? 1800 : 650, 0.08);
      }
    } else this.step = 0;
  }
}
