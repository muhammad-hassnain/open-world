import * as THREE from 'three';
import { Frame } from './geo.js';
import { World } from './world.js';
import { makeMaterials } from './materials.js';
import { GROUND_COLOR } from './streets.js';
import { ChunkManager } from './chunks.js';
import { Character } from './character.js';
import { Player, RUN, SPRINT } from './player.js';
import { Labels, CATS, escapeHtml } from './labels.js';
import { MiniMap } from './minimap.js';
import { Terrain } from './terrain.js';
import { TouchControls } from './touch.js';
import { placePhotos } from './photos.js';
import { Globe, searchPlaces, placeName, WALK_ZOOM } from './globe.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
const MOUSE_SENS = 0.0024;
const FOV = 62;
// Phones and tablets: lighter rendering (their GPUs and batteries are smaller).
const MOBILE = matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
// Default start: C Street by Central Park, downtown Davis, CA.
const START = { lat: 38.54428, lon: -121.7438, bearing: 0 };

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MOBILE ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
$('world').appendChild(renderer.domElement);
const touch = new TouchControls(renderer.domElement, { stick: $('stick'), knob: $('stick-knob'), jump: $('btn-jump') });
if (MOBILE) touch.enable();

const HORIZON = new THREE.Color('#dce8f2');
const scene = new THREE.Scene();
scene.background = HORIZON;
scene.fog = new THREE.Fog(HORIZON, 120, 620);
const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 2000);

// Gradient sky; tone-mapped like the rest of the scene so it matches the fog at the horizon.
function skyMaterial(top, horizon, ground) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: { top: { value: top }, horizon: { value: horizon }, ground: { value: ground } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 ground;
      varying vec3 vP;
      void main() {
        float h = normalize(vP).y;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, ground, pow(min(1.0, -h * 4.0), 0.6));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
const SKY_TOP = new THREE.Color('#4f93db');
const sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 32, 16), skyMaterial(SKY_TOP, HORIZON, HORIZON));
sky.renderOrder = -1;
scene.add(sky);

// Soft outdoor light for the PBR materials, baked from the same sky over a grassy ground.
{
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMaterial(SKY_TOP, HORIZON, new THREE.Color('#6d7a55'))));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  pmrem.dispose();
}

// Ground beyond the loaded chunks, so the horizon never shows a void.
const farGround = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 1 }));
farGround.position.y = -0.05;
scene.add(farGround);

scene.add(new THREE.HemisphereLight('#e2efff', '#8e9a72', 0.7));
const sun = new THREE.DirectionalLight('#fff0d8', 3.0);
const SUN_DIR = new THREE.Vector3(-0.5, 0.78, 0.38).normalize();
sun.castShadow = true;
sun.shadow.mapSize.setScalar(MOBILE ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 400 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const materials = makeMaterials(renderer);
const minimap = new MiniMap($('minimap'));
const character = new Character();
character.root.visible = false;
scene.add(character.root);

// ---------- session state ----------
let mode = 'boot';             // 'globe' | 'loading' | 'street'
let session = 0;
let frame = null, world = null, chunks = null, labels = null, player = null, spawn = null;
let globe = null;

function setMode(m) {
  mode = m;
  document.body.dataset.mode = m;
  if (m !== 'street') { if (labels) labels.hideAll(); setOverlay(false); touch.reset(); closePhotos(); }
}

function getGlobe() {
  if (!globe) {
    globe = new Globe($('globe'), { lat: START.lat, lon: START.lon, zoom: 1.6 });
    globe.on('move', updateWalkButton);
  }
  return globe;
}

// Spawn on the street nearest to the chosen point: its sidewalk if there is one, else the
// street edge. Without a street nearby (parks, countryside) use the nearest open ground.
function findSpawn(w, bearingDeg) {
  const free = (x, z) => !w.buildingAt(x, z) && !w.blocked(x, z, 0.45);
  let spot = null;
  const rd = w.nearestRoad(0, 0, 250);
  if (rd) {
    const a = rd.road.p[rd.seg], b = rd.road.p[rd.seg + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / l, tz = (b[1] - a[1]) / l, nx = -tz, nz = tx;
    const near = -rd.x * nx - rd.z * nz >= 0 ? 1 : -1; // side of the street the point is on
    const at = (side, d, along) => ({ x: rd.x + nx * side * d + tx * along, z: rd.z + nz * side * d + tz * along });
    search: for (const along of [0, 3, -3, 6, -6, 10, -10]) {
      for (const side of [near, -near]) {
        for (let d = rd.road.hw - 0.5; d < rd.road.hw + 9; d += 0.4) {
          const p = at(side, d, along);
          if (w.onSidewalk(p.x, p.z) && free(p.x, p.z)) { spot = p; break search; }
        }
      }
    }
    // No sidewalk: stand near the edge of the street, as far from the center as there is room.
    for (let d = rd.road.hw - 1.2; !spot && d >= 0; d -= 0.4) {
      const p = at(near, d, 0);
      if (free(p.x, p.z)) spot = p;
    }
  }
  for (let r = 0; !spot && r <= 60; r += 0.75) {
    const n = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 0.75);
    for (let k = 0; k < n; k++) {
      const ang = (k / n) * Math.PI * 2, x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      if (free(x, z)) { spot = { x, z }; break; }
    }
  }
  spot ??= { x: 0, z: 0 };
  // Face along the street, in the direction closest to the map's bearing.
  let yaw = (-bearingDeg * Math.PI) / 180;
  const st = w.nearestRoad(spot.x, spot.z, 60);
  if (st) {
    const a = st.road.p[st.seg], b = st.road.p[st.seg + 1];
    const along = Math.atan2(-(b[0] - a[0]), -(b[1] - a[1]));
    const diff = (t) => Math.abs(Math.atan2(Math.sin(t - yaw), Math.cos(t - yaw)));
    yaw = diff(along) <= diff(along + Math.PI) ? along : along + Math.PI;
  }
  return { ...spot, yaw };
}

async function enterStreet(lat, lon, bearing = 0) {
  const token = ++session;
  setMode('loading');
  if (globe) globe.hide();
  $('loading-text').textContent = 'Building the neighborhood…';
  $('loading-bar').style.width = '0%';
  if (chunks) chunks.dispose();
  if (labels) labels.clear();
  minimap.clear();
  character.root.visible = false;

  frame = new Frame(lat, lon);
  const terrain = new Terrain(frame);
  world = new World(frame, terrain);
  labels = new Labels(world, scene, camera, $('tags'));
  labels.onChange = setLabelButtons;
  setLabelButtons(labels.mode);
  chunks = new ChunkManager({ frame, world, scene, labels, minimap, materials, terrain });
  try {
    await chunks.warmup(0, 0, (p) => { $('loading-bar').style.width = `${Math.round(p * 100)}%`; });
  } catch (e) {
    console.error(e);
    $('loading-text').textContent = `Couldn't build this place: ${e.message}`;
    return;
  }
  if (token !== session) return;
  spawn = findSpawn(world, bearing);
  player = new Player(world, character, camera);
  player.spawn(spawn.x, spawn.z, spawn.yaw);
  character.root.visible = true;
  placeName(lat, lon).then((n) => { if (token === session) world.placeName = n; }).catch(() => {});
  setMode('street');
  if (TEST || touch.enabled) playing = true; else setOverlay(true);
  window.game.ready = true;
}

// ---------- globe / map ----------
function openGlobe(kind) {
  if (locked) document.exitPointerLock();
  const g = getGlobe();
  setMode('globe');
  g.show();
  $('globe-back').classList.toggle('hidden', !player);
  if (player && frame) {
    const [lat, lon] = frame.toLatLon(player.pos.x, player.pos.z);
    const bearing = (-player.camYaw * 180) / Math.PI;
    if (kind === 'globe') {
      g.jumpTo({ lat, lon, zoom: 17, bearing, pitch: 55 });
      g.flyTo({ lat, lon, zoom: 2.2, bearing: 0, pitch: 0, duration: 3500 });
    } else {
      g.jumpTo({ lat, lon, zoom: 17.3, bearing, pitch: 0 });
    }
  }
  updateWalkButton();
}

function backToStreet() {
  if (!player) return;
  globe.hide();
  setMode('street');
  startPlaying();
}

function updateWalkButton() {
  if (!globe) return;
  const ok = globe.view.zoom >= WALK_ZOOM;
  $('walk').textContent = ok ? 'Walk here' : 'Zoom in to walk';
  $('walk').classList.toggle('dim', !ok);
}

$('walk').addEventListener('click', () => {
  const v = globe.view;
  if (v.zoom < WALK_ZOOM) { globe.flyTo({ ...v, zoom: 16.8, duration: 2000 }); return; }
  if (player && frame) {
    // Close by: just move within the current world.
    const [x, z] = frame.toLocal(v.lat, v.lon);
    if (Math.hypot(x - player.pos.x, z - player.pos.z) < 500 && world.near(x, z).length) {
      player.spawn(x, z, (-v.bearing * Math.PI) / 180);
      backToStreet();
      return;
    }
  }
  enterStreet(v.lat, v.lon, v.bearing);
});
$('globe-back').addEventListener('click', backToStreet);

$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-q').value.trim();
  if (!q) return;
  const list = $('results');
  list.innerHTML = '<div class="msg">Searching…</div>';
  try {
    const results = await searchPlaces(q);
    list.innerHTML = results.length ? '' : '<div class="msg">No places found</div>';
    for (const r of results) {
      const b = document.createElement('button');
      b.textContent = r.name;
      b.addEventListener('click', () => {
        list.innerHTML = '';
        globe.showPlace(r);
      });
      list.appendChild(b);
    }
  } catch (err) {
    list.innerHTML = `<div class="msg">${escapeHtml(err.message)}</div>`;
  }
});

// ---------- input ----------
const keys = new Set();
let mouseDX = 0, mouseDY = 0, zoomAcc = 0, jumpQueued = false;
let locked = false, dragLook = false, dragging = false, playing = false;
let shiftUp = 0, sprintKey = false;  // press Shift again right after letting go (and hold) to sprint

function setOverlay(show) { $('intro').classList.toggle('hidden', !show); }

function startPlaying() {
  const canvas = renderer.domElement;
  if (canvas.requestPointerLock && !dragLook && !TEST) {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => { dragLook = true; playing = true; setOverlay(false); });
  } else {
    playing = true; setOverlay(false);
  }
}

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  if (locked) { playing = true; setOverlay(false); } else if (mode === 'street' && !dragLook) { playing = false; setOverlay(true); }
});
document.addEventListener('pointerlockerror', () => { dragLook = true; playing = true; setOverlay(false); });
document.addEventListener('mousemove', (e) => {
  if (locked || (dragLook && dragging)) { mouseDX += e.movementX; mouseDY += e.movementY; }
});
renderer.domElement.addEventListener('mousedown', () => { if (dragLook) dragging = true; else if (mode === 'street' && !locked) startPlaying(); });
window.addEventListener('mouseup', () => { dragging = false; });
renderer.domElement.addEventListener('wheel', (e) => { zoomAcc += e.deltaY * 0.004; }, { passive: true });
window.addEventListener('blur', () => { keys.clear(); sprintKey = false; });
$('play').addEventListener('click', startPlaying);
touch.onEnable = () => { if (mode === 'street') { playing = true; setOverlay(false); } };
$('to-globe').addEventListener('click', () => openGlobe('globe'));

const actions = {};
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (aboutOpen()) { if (e.code === 'Escape') closeAbout(); return; }
  if (mode === 'globe') {
    if (e.code === 'Escape' && player) backToStreet();
    if ((e.code === 'KeyM' || e.code === 'KeyG') && player && !e.repeat) backToStreet();
    return;
  }
  if (mode !== 'street') return;
  if (photoView) {
    if (e.code === 'Escape' || e.code === 'KeyP') closePhotos();
    else if (e.code === 'ArrowRight' || e.code === 'KeyD') showPhoto(photoView.i + 1);
    else if (e.code === 'ArrowLeft' || e.code === 'KeyA') showPhoto(photoView.i - 1);
    e.preventDefault();
    return;
  }
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (!e.repeat) {
    if (e.code === 'Space') jumpQueued = true;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') sprintKey = performance.now() - shiftUp < 300;
    if (actions[e.code]) actions[e.code]();
  }
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !keys.has('ShiftLeft') && !keys.has('ShiftRight')) {
    sprintKey = false;
    shiftUp = performance.now();
  }
});

// ---------- HUD ----------
function setLabelButtons(m) {
  for (const b of document.querySelectorAll('#labelmode button')) b.classList.toggle('on', b.dataset.mode === m);
}
for (const b of document.querySelectorAll('#labelmode button')) {
  b.addEventListener('click', () => labels && labels.setMode(b.dataset.mode));
}

function renderCard(it) {
  const cat = CATS[it.cat] || CATS.service;
  const p = it.poi || {};
  const rows = [];
  if (p.ad) rows.push(`<div class="row"><span>Address</span>${escapeHtml(p.ad)}</div>`);
  if (p.cu) rows.push(`<div class="row"><span>Cuisine</span>${escapeHtml(p.cu)}</div>`);
  if (p.oh) rows.push(`<div class="row"><span>Hours</span>${escapeHtml(p.oh)}</div>`);
  if (p.ph) rows.push(`<div class="row"><span>Phone</span>${escapeHtml(p.ph)}</div>`);
  if (p.w) rows.push(`<div class="row"><span>Web</span>${escapeHtml(p.w.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</div>`);
  return `<div class="cat" style="color:${cat.color}">${escapeHtml(it.kind || cat.label)}</div><div class="name">${escapeHtml(it.name)}</div>${rows.join('')}`;
}

// Photos of the place on the card (Wikimedia), shown on the card and in the photo viewer.
let cardPhotos = null, photoView = null;

function loadCardPhotos(it) {
  if (!it.name) return;
  const q = it.poi && Number.isFinite(it.poi.x) ? it.poi : it;
  const [lat, lon] = frame.toLatLon(q.x, q.z);
  placePhotos(it.name, lat, lon).then((r) => {
    if (cardId !== it.id || !r.photos.length) return;
    cardPhotos = { name: it.name, ...r };
    const ph = r.photos[0], n = r.photos.length;
    $('card').insertAdjacentHTML('beforeend', `<img class="photo" src="${escapeHtml(ph.thumb)}" alt="">`
      + `<div class="credit">Photo: ${escapeHtml(ph.author)} · ${escapeHtml(ph.license)} · Wikimedia Commons</div>`
      + `<div class="hint">${touch.enabled ? 'Tap' : '<kbd>P</kbd>'} to see ${n > 1 ? `${n} photos` : 'the photo'}</div>`);
    $('card').classList.add('has-photos');
  });
}

function openPhotos() {
  if (!cardPhotos) { flash('No photos of this place'); return; }
  if (locked) document.exitPointerLock();
  keys.clear();
  touch.reset();
  photoView = { ...cardPhotos, i: 0 };
  showPhoto(0);
  $('photos').classList.remove('hidden');
}

function showPhoto(i) {
  const v = photoView, n = v.photos.length;
  v.i = (i + n) % n;
  const ph = v.photos[v.i];
  const img = $('ph-img');
  img.onerror = () => { img.onerror = null; img.src = ph.thumb; };  // originals smaller than 1280 px
  img.src = ph.large;
  $('ph-title').textContent = v.name;
  $('ph-count').textContent = n > 1 ? `${v.i + 1} / ${n}` : '';
  const link = (url, label) => (url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>` : escapeHtml(label));
  $('ph-credit').innerHTML = `${link(ph.page, ph.title)} · ${escapeHtml(ph.author)} · ${link(ph.licenseUrl, ph.license)} · Wikimedia Commons`
    + (v.more ? ` · ${link(v.more, 'More photos')}` : '');
  for (const b of [$('ph-prev'), $('ph-next')]) b.classList.toggle('hidden', n < 2);
}

function closePhotos() {
  if (!photoView) return;
  photoView = null;
  $('photos').classList.add('hidden');
  $('ph-img').removeAttribute('src');
}

$('card').addEventListener('click', openPhotos);

// ---------- about ----------
const aboutOpen = () => !$('about').classList.contains('hidden');
function openAbout() {
  if (locked) document.exitPointerLock();
  keys.clear();
  touch.reset();
  $('about').classList.remove('hidden');
}
function closeAbout() { $('about').classList.add('hidden'); }
$('about-btn').addEventListener('click', openAbout);
$('globe-about').addEventListener('click', openAbout);
$('about-close').addEventListener('click', closeAbout);
$('about').addEventListener('click', (e) => { if (e.target === $('about')) closeAbout(); });
$('ph-close').addEventListener('click', closePhotos);
$('ph-prev').addEventListener('click', () => showPhoto(photoView.i - 1));
$('ph-next').addEventListener('click', () => showPhoto(photoView.i + 1));

let flashT = 0;
function flash(text) { $('flash').textContent = text; $('flash').classList.add('show'); flashT = 1.6; }

actions.KeyL = () => { if (labels) { labels.cycle(); flash(`Labels: ${labels.mode}`); } };
actions.KeyR = () => { if (player && spawn) { player.spawn(spawn.x, spawn.z, spawn.yaw); flash('Back to where you started'); } };
actions.KeyM = () => openGlobe('map');
actions.KeyP = openPhotos;
actions.KeyG = () => openGlobe('globe');

// ---------- loop ----------
let last = performance.now(), hudT = 0, miniT = 0, frames = 0, fpsT = 0, hashT = 0, farT = 0;
let cardId = null;
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (flashT > 0) { flashT -= dt; if (flashT <= 0) $('flash').classList.remove('show'); }

  if (mode === 'street' && player) {
    const k = (...c) => c.some((x) => keys.has(x));
    const active = playing;
    const tc = touch.read();
    const shift = k('ShiftLeft', 'ShiftRight') ? (sprintKey ? 2 : 1) : 0;
    const input = {
      fwd: active ? (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0) + tc.fwd : 0,
      right: active ? (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0) + tc.right : 0,
      gait: Math.max(shift, tc.gait),
      jump: active && (jumpQueued || tc.jump),
      lookX: mouseDX * MOUSE_SENS + tc.lookX + (active ? ((k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0)) * 2.2 * dt : 0),
      lookY: mouseDY * MOUSE_SENS + tc.lookY,
      zoom: zoomAcc + tc.zoom,
    };
    mouseDX = 0; mouseDY = 0; zoomAcc = 0; jumpQueued = false;

    player.update(dt, input);
    const p = player.pos;
    // Widen the view a little when sprinting.
    const fov = FOV + 7 * Math.min(1, Math.max(0, (player.speed - RUN) / (SPRINT - RUN)));
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * (1 - Math.exp(-4 * dt));
      camera.updateProjectionMatrix();
    }
    chunks.update(p.x, p.z);
    sun.target.position.set(p.x, p.y, p.z);
    sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 150);
    sky.position.copy(camera.position);
    // Keep the background ground just below the lowest nearby terrain, so on a hilltop it doesn't
    // hover over the valley.
    farT -= dt;
    if (farT <= 0) {
      farT = 1;
      let low = world.elevation(p.x, p.z);
      for (const r of [150, 350, 650]) {
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          low = Math.min(low, world.elevation(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r));
        }
      }
      farGround.position.y = low - 1.5;
    }
    farGround.position.x = p.x;
    farGround.position.z = p.z;
    labels.update(dt, p.x, p.z);

    hudT -= dt;
    if (hudT <= 0) {
      hudT = 0.25;
      const loc = world.locate(p.x, p.z);
      const street = loc.street ? `<b>${escapeHtml(loc.street)}</b>${loc.cross ? ` &amp; ${escapeHtml(loc.cross)}` : ''}` : '<b>Exploring</b>';
      $('where').innerHTML = `${street}${loc.area ? `<span>${escapeHtml(loc.area)}</span>` : ''}`;
      const near = labels.nearest(p.x, p.z, 9);
      const changed = near && near.id !== cardId;
      if (changed) {
        $('card').innerHTML = renderCard(near);
        $('card').classList.remove('has-photos');
        cardPhotos = null;
      }
      cardId = near ? near.id : null;
      if (!near) cardPhotos = null;
      if (changed) loadCardPhotos(near);
      $('card').classList.toggle('show', !!near);
    }
    miniT -= dt;
    if (miniT <= 0) { miniT = 0.05; minimap.draw(p.x, p.z, player.camYaw, player.yaw, labels.items); }
    hashT -= dt;
    if (hashT <= 0 && !TEST) {
      hashT = 2;
      const [lat, lon] = frame.toLatLon(p.x, p.z);
      history.replaceState(null, '', `#${lat.toFixed(6)},${lon.toFixed(6)}`);
    }
    frames++; fpsT += dt;
    if (fpsT > 0.5) { $('fps').textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0; }
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Handle for automated checks and debugging in the console.
window.game = {
  get world() { return world; }, get player() { return player; }, get labels() { return labels; },
  get chunks() { return chunks; }, camera, renderer,
  setView(camYaw, camPitch, camDist) { player.camYaw = camYaw; player.camPitch = camPitch; if (camDist) player.camDist = camDist; },
  teleport(x, z, yaw = player.yaw) { player.spawn(x, z, yaw); },
  press(code, down) { if (down) keys.add(code); else keys.delete(code); },
  openMap(open) { if (open) openGlobe('map'); else backToStreet(); },
  openGlobe, enterStreet,
  get spawn() { return spawn; },
  get globe() { return globe; },
  ready: false,
};

// ---------- start ----------
function parseAt(s) {
  if (!s) return null;
  const [lat, lon, bearing] = s.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, bearing: Number.isFinite(bearing) ? bearing : 0 } : null;
}
const at = parseAt(params.get('at')) || parseAt(location.hash.slice(1));
if (params.has('globe')) {
  const g = getGlobe();
  setMode('globe');
  g.show();
  g.ready.then(() => { window.game.ready = true; });
} else if (at || TEST) {
  const s = at || START;
  enterStreet(s.lat, s.lon, s.bearing);
} else {
  // Start on the street where the player is, if they share their location; otherwise fly to
  // Davis. Don't jump anywhere if they've started exploring the globe while deciding.
  const g = getGlobe();
  setMode('globe');
  g.show();
  updateWalkButton();
  let wandered = false;
  g.on('movestart', (e) => { if (e.originalEvent) wandered = true; });
  $('search').addEventListener('submit', () => { wandered = true; });
  myLocation().then((pos) => {
    if (wandered || mode !== 'globe' || player) return;
    if (pos) enterStreet(pos.lat, pos.lon);
    else g.ready.then(() => g.flyTo({ lat: START.lat, lon: START.lon, zoom: 16.8, pitch: 45, duration: 6000 }));
  });
}

// The device's position, or null if it's refused, unavailable or not allowed (browsers only
// offer it on https and localhost).
function myLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation || !window.isSecureContext) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10 * 60 * 1000 });
  });
}
