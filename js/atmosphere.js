// Time of day and weather. The sun's position comes from the place and the real time (or a time
// the player picks); weather comes live from Open-Meteo (free, no key; CC BY 4.0) every 15
// minutes (or the player picks). Together they set the sky, fog, sun and ambient light, the
// reflections, rain or snow falling around the camera, wet or snowy streets, lightning, and at
// night lit windows, glowing street lamps that light the street near you and car headlights.
import * as THREE from 'three';
import { clamp, lerp } from './util.js';
import { setCarLights } from './vehicles.js';
import { setLampGlow } from './props.js';

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const REFRESH = 15 * 60 * 1000;
export const TIME_MODES = ['live', 'day', 'sunset', 'night'];
export const WEATHER_MODES = ['live', 'clear', 'rain', 'snow', 'fog'];
const LAMP_LIGHTS = 8;

// Weather presets: clouds 0-1, rain 0-1, snow 0-1, fog 0-1, storm.
const CLEAR = { clouds: 0.1, rain: 0, snow: 0, fog: 0, storm: false, label: 'Clear' };
const PRESETS = {
  clear: CLEAR,
  rain: { clouds: 0.95, rain: 0.75, snow: 0, fog: 0.2, storm: false, label: 'Rain' },
  snow: { clouds: 0.9, rain: 0, snow: 0.75, fog: 0.3, storm: false, label: 'Snow' },
  fog: { clouds: 0.8, rain: 0, snow: 0, fog: 1, storm: false, label: 'Fog' },
};

// WMO weather codes (Open-Meteo) -> look.
function fromCode(code, cloud) {
  const c = clamp((cloud ?? 50) / 100, 0, 1);
  const w = { clouds: c, rain: 0, snow: 0, fog: 0, storm: false, label: 'Clear' };
  if (code === 0) w.label = 'Clear';
  else if (code <= 2) w.label = 'Partly cloudy';
  else if (code === 3) { w.label = 'Overcast'; w.clouds = Math.max(c, 0.9); }
  else if (code === 45 || code === 48) { w.label = 'Fog'; w.fog = 1; w.clouds = Math.max(c, 0.8); }
  else if (code >= 51 && code <= 57) { w.label = 'Drizzle'; w.rain = 0.3; w.clouds = Math.max(c, 0.85); }
  else if (code >= 61 && code <= 67) { w.label = code === 61 ? 'Light rain' : code === 65 ? 'Heavy rain' : 'Rain'; w.rain = code === 61 ? 0.45 : code === 65 ? 1 : 0.7; w.clouds = Math.max(c, 0.9); }
  else if (code >= 71 && code <= 77) { w.label = code === 71 ? 'Light snow' : code === 75 ? 'Heavy snow' : 'Snow'; w.snow = code === 75 ? 1 : 0.65; w.clouds = Math.max(c, 0.9); }
  else if (code >= 80 && code <= 82) { w.label = 'Showers'; w.rain = code === 82 ? 1 : 0.6; w.clouds = Math.max(c, 0.85); }
  else if (code === 85 || code === 86) { w.label = 'Snow showers'; w.snow = 0.7; w.clouds = Math.max(c, 0.85); }
  else if (code >= 95) { w.label = 'Thunderstorm'; w.rain = 1; w.storm = true; w.clouds = 1; }
  return w;
}

// Sun elevation and azimuth (radians; azimuth from north, clockwise) at a time and place.
export function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = (date.getTime() - 946728000000) / 86400000;  // days since J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = (gmst * 15 + lon) * rad - ra;
  const la = lat * rad;
  const elev = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(la) - Math.tan(dec) * Math.cos(la)) + Math.PI;
  return { elev, az };
}

const C = (hex) => new THREE.Color(hex);
// Sky colors by sun elevation (degrees): [elevation, top, horizon].
const SKY = [
  [-18, C('#03060f'), C('#0a1020')],
  [-10, C('#0b1530'), C('#2a2c48')],
  [-4, C('#24376a'), C('#9a5a70')],
  [1, C('#3a5ea6'), C('#f09a68')],
  [8, C('#4a84cc'), C('#f4cfa8')],
  [25, C('#4f93db'), C('#dce8f2')],
];
function skyAt(elevDeg) {
  if (elevDeg <= SKY[0][0]) return [SKY[0][1].clone(), SKY[0][2].clone()];
  for (let i = 1; i < SKY.length; i++) {
    if (elevDeg <= SKY[i][0]) {
      const t = (elevDeg - SKY[i - 1][0]) / (SKY[i][0] - SKY[i - 1][0]);
      return [SKY[i - 1][1].clone().lerp(SKY[i][1], t), SKY[i - 1][2].clone().lerp(SKY[i][2], t)];
    }
  }
  return [SKY.at(-1)[1].clone(), SKY.at(-1)[2].clone()];
}

function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, ground: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color() }, glow: { value: new THREE.Color() },
      sunVisible: { value: 1 }, clouds: { value: 0 }, cloudLit: { value: new THREE.Color() }, cloudDark: { value: new THREE.Color() },
      time: { value: 0 }, stars: { value: 0 },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 ground;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      uniform vec3 glow;
      uniform float sunVisible;
      uniform float clouds;
      uniform vec3 cloudLit;
      uniform vec3 cloudDark;
      uniform float time;
      uniform float stars;
      varying vec3 vP;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
        return v;
      }
      void main() {
        vec3 d = normalize(vP);
        float h = d.y;
        float mu = dot(d, sunDir);
        vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.5)) : mix(horizon, ground, pow(min(1.0, -h * 4.0), 0.6));
        // Sunset: a warm band along the horizon, strongest toward the sun, purple higher up.
        float band = pow(1.0 - clamp(abs(h), 0.0, 1.0), 5.0);
        float toward = pow(mu * 0.5 + 0.5, 3.0);
        c += glow * band * (0.25 + toward * 1.4);
        c += glow * vec3(0.55, 0.25, 0.7) * pow(1.0 - clamp(h, 0.0, 1.0), 2.0) * 0.25 * (1.0 - toward);
        // Halo and disc.
        float s = max(mu, 0.0);
        c += sunColor * (pow(s, 10.0) * 0.25 + pow(s, 120.0) * 0.6) * sunVisible;
        float disc = smoothstep(0.99955, 0.99972, mu) * sunVisible * smoothstep(-0.02, 0.01, h);
        // Clouds on a dome, drifting; lit by the sun (orange-pink at sunset).
        float cover = 0.0;
        vec3 cloud = vec3(0.0);
        if (h > 0.0 && clouds > 0.01) {
          vec2 uv = d.xz / (h + 0.14) * 1.4 + vec2(time * 0.006, time * 0.003);
          float n = fbm(uv) + 0.45 * fbm(uv * 3.1 + 7.0) - 0.22;
          float edge = 1.0 - clouds;
          cover = smoothstep(edge - 0.08, edge + 0.22, n) * smoothstep(0.0, 0.18, h);
          float lit = clamp((n - edge) * 2.5, 0.0, 1.0);
          cloud = mix(cloudLit, cloudDark, lit * 0.8) + glow * pow(s, 3.0) * 0.9 * (1.0 - lit * 0.5);
        }
        c = mix(c, cloud, cover * 0.95);
        c = mix(c, sunColor * 8.0, disc * (1.0 - cover * 0.9));
        if (stars > 0.0 && h > 0.0) {
          vec3 cell = floor(d * 260.0);
          float r = hash(cell);
          c += vec3(step(0.9975, r) * stars * (0.6 + 0.4 * hash(cell + 3.1))) * (1.0 - cover);
        }
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// Rain (streaks) or snow (flakes) in a box that follows the camera, animated on the GPU.
function precipitation(kind, count) {
  const geo = new THREE.BufferGeometry();
  const seeds = new Float32Array(count * 3 * (kind === 'rain' ? 2 : 1));
  const ends = new Float32Array(count * (kind === 'rain' ? 2 : 1));
  for (let i = 0; i < count; i++) {
    const x = Math.random(), y = Math.random(), z = Math.random();
    if (kind === 'rain') {
      seeds.set([x, y, z, x, y, z], i * 6);
      ends.set([0, 1], i * 2);
    } else {
      seeds.set([x, y, z], i * 3);
      ends[i] = Math.random();
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  geo.setAttribute('end', new THREE.BufferAttribute(ends, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { time: { value: 0 }, center: { value: new THREE.Vector3() }, wind: { value: new THREE.Vector2() },
      amount: { value: 0 }, color: { value: new THREE.Color(kind === 'rain' ? '#aab8c6' : '#ffffff') } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float end;
      uniform float time;
      uniform vec3 center;
      uniform vec2 wind;
      uniform float amount;
      varying float vA;
      const vec3 BOX = vec3(36.0, 22.0, 36.0);
      void main() {
        ${kind === 'rain' ? 'float speed = 15.0;' : 'float speed = 1.4;'}
        vec3 p = position * BOX;
        p.y = mod(p.y - time * speed, BOX.y);
        p.xz += wind * (BOX.y - p.y) * ${kind === 'rain' ? '0.04' : '0.25'};
        ${kind === 'snow' ? 'p.x += sin(time * 0.9 + position.z * 40.0) * 0.6; p.z += cos(time * 0.7 + position.x * 40.0) * 0.6;' : ''}
        // Wrap around the camera so the box always surrounds it.
        p.xz = mod(p.xz - center.xz + BOX.xz * 0.5, BOX.xz) + center.xz - BOX.xz * 0.5;
        p.y += center.y - 6.0;
        ${kind === 'rain' ? 'p += end * vec3(-wind.x * 0.04, 0.55, -wind.y * 0.04);' : ''}
        vA = step(fract(position.x * 7.31 + position.z * 3.17), amount);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
        ${kind === 'snow' ? 'gl_PointSize = min(9.0, 26.0 / max(1.0, -mv.z) * (0.5 + end));' : ''}
      }`,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 color;
      varying float vA;
      void main() {
        #include <logdepthbuf_fragment>
        if (vA < 0.5) discard;
        ${kind === 'snow' ? 'vec2 c = gl_PointCoord - 0.5; if (dot(c, c) > 0.25) discard;' : ''}
        gl_FragColor = vec4(color, ${kind === 'rain' ? '0.42' : '0.9'});
      }`,
  });
  const obj = kind === 'rain' ? new THREE.LineSegments(geo, mat) : new THREE.Points(geo, mat);
  obj.frustumCulled = false;
  obj.renderOrder = 2;
  return obj;
}

export class Atmosphere {
  constructor({ renderer, scene, materials, mobile = false }) {
    Object.assign(this, { renderer, scene, materials, mobile });
    this.timeMode = 'live';
    this.weatherMode = 'live';
    try {
      this.timeMode = TIME_MODES.includes(localStorage.getItem('openworld.time')) ? localStorage.getItem('openworld.time') : 'live';
      this.weatherMode = WEATHER_MODES.includes(localStorage.getItem('openworld.weather')) ? localStorage.getItem('openworld.weather') : 'live';
    } catch { /* storage unavailable */ }
    this.place = null;          // { lat, lon }
    this.live = null;           // last live weather { ...look, temp, offset }
    this.weather = { ...CLEAR };
    this.shown = { ...CLEAR };  // eased toward this.weather
    this.sunDir = new THREE.Vector3(-0.5, 0.78, 0.38).normalize();
    this.elev = 45;
    this.night = 0;
    this.envT = 0;

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 32, 16), skyMaterial());
    this.sky.renderOrder = -1;
    scene.add(this.sky);
    scene.background = new THREE.Color();
    scene.fog = new THREE.Fog(new THREE.Color(), 120, 620);
    this.hemi = new THREE.HemisphereLight('#e2efff', '#8e9a72', 0.7);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff0d8', 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar(mobile ? 1024 : 2048);
    Object.assign(this.sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 400 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);

    // Night: a fixed set of lights moved to the nearest street lamps, and a headlight.
    this.lampLights = [];
    for (let i = 0; i < (mobile ? 4 : LAMP_LIGHTS); i++) {
      const l = new THREE.PointLight('#ffcf8a', 0, 30, 1.4);
      scene.add(l);
      this.lampLights.push(l);
    }
    this.lampT = 0;
    this.headlight = new THREE.SpotLight('#fff4dc', 0, 70, 0.55, 0.5, 1.2);
    scene.add(this.headlight, this.headlight.target);

    this.rain = precipitation('rain', mobile ? 1800 : 5000);
    this.snow = precipitation('snow', mobile ? 1500 : 4000);
    scene.add(this.rain, this.snow);
    this.flashT = 0; this.nextFlash = 6;

    this._env = { scene: new THREE.Scene(), mat: skyMaterial() };
    this._env.scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this._env.mat));
    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._prepareMaterials();
    this.apply(0, true);
  }

  // Remember surface settings and make windows light up at night.
  _prepareMaterials() {
    const M = this.materials;
    this.base = {};
    for (const k of ['road', 'sidewalk', 'lot', 'paving', 'ground', 'grass', 'pathGravel']) {
      if (M[k]) this.base[k] = { roughness: M[k].roughness, color: M[k].color.clone(), env: M[k].envMapIntensity };
    }
    const glass = M.glass;
    glass.emissive = new THREE.Color('#ffcf8f');
    glass.emissiveIntensity = 0;
    glass.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            vec3 cell = floor(vWPos / vec3(2.4, 3.2, 2.4));
            float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            totalEmissiveRadiance *= step(0.45, h) * (0.5 + fract(h * 7.0));
          }`);
    };
    glass.customProgramCacheKey = () => 'lit-windows';
    glass.needsUpdate = true;
  }

  // A new place: fetch its weather (and local time zone).
  setPlace(lat, lon) {
    this.place = { lat, lon };
    this.live = null;
    this._fetch();
  }

  async _fetch() {
    const at = this.place;
    if (!at) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._fetch(), REFRESH);
    try {
      const q = new URLSearchParams({ latitude: at.lat.toFixed(4), longitude: at.lon.toFixed(4), timezone: 'auto',
        current: 'temperature_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m' });
      const res = await fetch(`${WEATHER_URL}?${q}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      if (at !== this.place) return;
      const c = d.current || {};
      this.live = { ...fromCode(c.weather_code, c.cloud_cover), temp: c.temperature_2m, offset: d.utc_offset_seconds ?? null,
        windSpeed: c.wind_speed_10m || 0, windDir: c.wind_direction_10m || 0 };
    } catch (e) {
      console.warn(`Weather unavailable: ${e.message}`);
    }
  }

  setTimeMode(m) { this.timeMode = m; try { localStorage.setItem('openworld.time', m); } catch { /* storage unavailable */ } }
  setWeatherMode(m) { this.weatherMode = m; try { localStorage.setItem('openworld.weather', m); } catch { /* storage unavailable */ } }

  // "9:41 PM · 18°C · Light rain" for the HUD.
  get label() {
    const parts = [];
    if (this.timeMode === 'live' && this.place) {
      const off = this.live?.offset ?? Math.round(this.place.lon / 15) * 3600;
      const t = new Date(Date.now() + off * 1000);
      let h = t.getUTCHours(); const m = String(t.getUTCMinutes()).padStart(2, '0'), ap = h < 12 ? 'AM' : 'PM';
      h = h % 12 || 12;
      parts.push(`${h}:${m} ${ap}`);
    } else parts.push(this.timeMode[0].toUpperCase() + this.timeMode.slice(1));
    if (this.weatherMode === 'live' && this.live && this.live.temp != null) parts.push(`${Math.round(this.live.temp)}°C`);
    parts.push(this.weather.label);
    return parts.join(' · ');
  }

  // Sun position for the current time mode.
  _sun() {
    let elev, az;
    if (this.timeMode === 'day') { elev = 50; az = 150; }
    else if (this.timeMode === 'sunset') { elev = 3; az = 285; }
    else if (this.timeMode === 'night') { elev = -30; az = 0; }
    else if (this.place) {
      const s = sunPosition(new Date(), this.place.lat, this.place.lon);
      elev = (s.elev * 180) / Math.PI; az = (s.az * 180) / Math.PI;
    } else { elev = 45; az = 150; }
    return { elev, az };
  }

  // Every frame: ease weather, move the sun, update sky/fog/lights and effects.
  update(dt, { camera, world, player, traffic, time }) {
    this.weather = this.weatherMode === 'live' ? (this.live || CLEAR) : PRESETS[this.weatherMode];
    for (const k of ['clouds', 'rain', 'snow', 'fog']) this.shown[k] = lerp(this.shown[k], this.weather[k], 1 - Math.exp(-dt / 2));
    this.shown.label = this.weather.label;
    this.apply(dt);

    const p = camera.position;
    // Rain and snow around the camera.
    const wind = this.weatherMode === 'live' && this.live ? this.live.windSpeed / 3.6 : 3;
    const wdir = (((this.live?.windDir ?? 240) + 180) * Math.PI) / 180;  // blowing toward
    for (const [obj, amt] of [[this.rain, this.shown.rain], [this.snow, this.shown.snow]]) {
      obj.visible = amt > 0.02;
      const u = obj.material.uniforms;
      u.time.value = time; u.center.value.copy(p); u.amount.value = amt;
      u.wind.value.set(Math.sin(wdir) * wind, -Math.cos(wdir) * wind);
    }
    // Lightning in storms.
    if (this.weather.storm) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) { this.flashT = 0.35; this.nextFlash = 6 + Math.random() * 12; }
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      const on = this.flashT > 0.25 || (this.flashT > 0.05 && this.flashT < 0.12);
      this.hemi.intensity += on ? 3 : 0;
    }

    // Night lights: nearest street lamps and the player's headlights.
    const nightOn = this.night > 0.35;
    this.lampT -= dt;
    if (this.lampT <= 0 && world) {
      this.lampT = 0.3;
      const lamps = [];
      for (const ch of world.near(p.x, p.z, 70)) for (const l of ch.lamps || []) lamps.push(l);
      lamps.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
      this.lampLights.forEach((light, i) => {
        const l = lamps[i];
        light.intensity = l && nightOn ? 120 * this.night : 0;
        if (l) light.position.set(l.x, l.y + 4.4, l.z);
      });
    }
    const v = player && player.vehicle;
    if (v && v.kind === 'car' && nightOn) {
      const [fx, fz] = v.fwd;
      this.headlight.position.set(v.x + fx * 2.3, v.y + 0.8, v.z + fz * 2.3);
      this.headlight.target.position.set(v.x + fx * 22, v.y - 0.5, v.z + fz * 22);
      this.headlight.intensity = 90 * this.night;
    } else this.headlight.intensity = 0;
    setCarLights(nightOn);
    setLampGlow(this.night);
    if (traffic) traffic.lightsOn = nightOn;
  }

  // Sky, fog, sun, ambient light, reflections and surfaces for the current sun and weather.
  apply(dt, force = false) {
    const { elev, az } = this._sun();
    this.elev = elev;
    const W = this.shown;
    const r = Math.PI / 180;
    // +x east, +z south: azimuth from north, clockwise.
    this.sunDir.set(Math.sin(az * r) * Math.cos(elev * r), Math.sin(elev * r), -Math.cos(az * r) * Math.cos(elev * r)).normalize();
    this.night = clamp((2 - elev) / 10, 0, 1);  // 0 in daylight, 1 once the sun is 8° below the horizon

    let [top, horizon] = skyAt(elev);
    // Clouds and weather: greyer, flatter, darker skies.
    const grey = W.clouds * 0.75 + W.rain * 0.2 + W.fog * 0.4;
    const lum = (c) => 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
    const dim = 1 - W.rain * 0.35 - W.clouds * 0.15;
    for (const c of [top, horizon]) {
      const l = lum(c) * dim;
      c.lerp(new THREE.Color(l * 1.02, l * 1.04, l * 1.08), clamp(grey, 0, 0.95));
    }
    if (W.fog > 0.05) horizon.lerp(new THREE.Color(lum(horizon) * 1.1, lum(horizon) * 1.1, lum(horizon) * 1.12), W.fog * 0.6);
    const ground = horizon.clone().multiplyScalar(0.9);
    const u = this.sky.material.uniforms;
    u.top.value.copy(top); u.horizon.value.copy(horizon); u.ground.value.copy(ground);
    u.sunDir.value.copy(this.sunDir);
    // Sun color: white high up, gold, then orange-red at the horizon.
    const low = clamp(1 - elev / 18, 0, 1);
    u.sunColor.value.setRGB(1, lerp(0.95, 0.42, low), lerp(0.86, 0.18, low));
    u.sunVisible.value = clamp((elev + 1.5) / 2, 0, 1) * (1 - W.fog) * (1 - W.rain * 0.8);
    // Sunset glow: strongest with the sun just above or below the horizon.
    const glow = clamp(1 - Math.abs(elev - 1) / 11, 0, 1) * (1 - W.rain * 0.7 - W.fog * 0.6);
    u.glow.value.setRGB(1.0 * glow, 0.42 * glow, 0.2 * glow);
    // Clouds: their amount from the weather, a few even on clear days; lit by sun and sky.
    u.clouds.value = clamp(0.18 + W.clouds * 0.62, 0, 0.9);
    const daylight = clamp((elev + 6) / 20, 0.04, 1);
    u.cloudLit.value.copy(horizon).lerp(new THREE.Color(1, 1, 1), 0.65 * daylight).multiplyScalar(lerp(0.25, 1, daylight) * (1 - W.rain * 0.35));
    u.cloudDark.value.copy(u.cloudLit.value).multiplyScalar(0.62);
    u.time.value = performance.now() / 1000;
    u.stars.value = this.night * (1 - W.clouds);
    this.scene.background.copy(horizon);
    this.scene.fog.color.copy(horizon);
    const fogFar = lerp(620, 260, W.rain * 0.6 + W.snow * 0.5) * lerp(1, 0.15, W.fog);
    this.scene.fog.near = Math.min(120, fogFar * 0.25);
    this.scene.fog.far = fogFar;

    // Sun (or moon at night): direction, color, strength.
    const day = clamp(Math.sin(elev * r) * 3, 0, 1);
    const warm = clamp(1 - elev / 25, 0, 1);
    const cloudK = 1 - W.clouds * 0.7 - W.rain * 0.15 - W.fog * 0.2;
    if (elev > -2) {
      this.sun.color.setRGB(1, lerp(0.94, 0.62, warm), lerp(0.85, 0.42, warm));
      this.sun.intensity = 3.0 * day * cloudK;
    } else {
      this.sun.color.set('#9fb4ff');
      this.sun.intensity = 0.55 * (1 - W.clouds * 0.5);
    }
    this.moonDir = this.moonDir || new THREE.Vector3(0.3, 0.8, -0.5).normalize();
    this.lightDir = elev > -2 ? this.sunDir : this.moonDir;
    this.hemi.intensity = lerp(0.42, 0.7 + W.clouds * 0.25, clamp(day * 1.4, 0, 1));
    this.hemi.color.copy(top).lerp(new THREE.Color(this.night > 0.5 ? '#7d8fc0' : '#ffffff'), 0.6);
    this.renderer.toneMappingExposure = lerp(1.05, 1.6, this.night);

    // Surfaces: wet streets shine; snow whitens the ground.
    const M = this.materials;
    for (const [k, b] of Object.entries(this.base)) {
      const m = M[k];
      const paved = k !== 'ground' && k !== 'grass';
      m.roughness = paved ? lerp(b.roughness, 0.3, W.rain) : b.roughness;
      m.envMapIntensity = paved ? lerp(b.env, 1.2, W.rain) : b.env;
      m.color.copy(b.color).multiplyScalar(paved ? 1 - W.rain * 0.3 : 1);
      m.emissive = m.emissive || new THREE.Color();
      m.emissive.setScalar(W.snow * (paved ? 0.12 : 0.38) * (1 - this.night * 0.7));
    }
    M.glass.emissiveIntensity = this.night * 1.4;

    // Reflections follow the sky (rebaked when it changed enough, at most every 2 s).
    this.envT -= dt;
    const key = `${top.getHexString()}${horizon.getHexString()}`;
    if (force || (this.envT <= 0 && key !== this._envKey)) {
      this.envT = 2;
      this._envKey = key;
      const e = this._env.mat.uniforms;
      e.top.value.copy(top); e.horizon.value.copy(horizon); e.ground.value.copy(new THREE.Color('#6d7a55').multiplyScalar(lerp(1, 0.15, this.night)));
      e.sunDir.value.copy(this.sunDir); e.glow.value.copy(u.glow.value); e.sunColor.value.copy(u.sunColor.value);
      e.sunVisible.value = 0; e.clouds.value = 0; e.stars.value = 0;
      const old = this.scene.environment;
      this.scene.environment = this._pmrem.fromScene(this._env.scene, 0.02).texture;
      if (old) old.dispose();
    }
  }

  // The sun (or moon) light follows the player so shadows stay sharp around them.
  follow(p) {
    this.sun.target.position.set(p.x, p.y, p.z);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.lightDir || this.sunDir, 150);
    this.sky.position.set(p.x, p.y, p.z);
  }
}
