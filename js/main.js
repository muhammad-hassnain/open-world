import * as THREE from 'three';
import { Frame } from './geo.js';
import { World } from './world.js';
import { makeMaterials } from './materials.js';
import { GROUND_COLOR } from './streets.js';
import { ChunkManager } from './chunks.js';
import { Character } from './character.js';
import { loadProfile, saveProfile, NAME_MAX } from './profile.js';
import { Multiplayer } from './multiplayer.js';
import { Player, RUN, SPRINT } from './player.js';
import { Labels, CATS, escapeHtml } from './labels.js';
import { MiniMap } from './minimap.js';
import { Terrain } from './terrain.js';
import { TouchControls } from './touch.js';
import { Vehicle, loadCars, CAR_TYPES, CAR_MODELS } from './vehicles.js';
import { Traffic, updateLights } from './traffic.js';
import { Police, Siren } from './police.js';
import { Atmosphere, TIME_MODES, WEATHER_MODES } from './atmosphere.js';
import { milesHere, speedLimit, MPH_PER_MS, KMH_PER_MS } from './limits.js';
import { FarView } from './farview.js';
import { takeParkedCar } from './props.js';
import { placePhotos } from './photos.js';
import { Globe, searchPlaces, placeName, WALK_ZOOM } from './globe.js';
import { Navigator } from './navigate.js';
import { RoadSigns } from './roadsigns.js';
import { Arcade } from './arcade.js';
import { SpeedCams } from './speedcams.js';
import { Races } from './races.js';

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
const touch = new TouchControls(renderer.domElement, {
  stick: $('stick'), knob: $('stick-knob'), jump: $('btn-jump'), boost: $('btn-boost'), sideButtons: document.querySelectorAll('#stick-side button'),
});
if (MOBILE) touch.enable();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 30000);  // far view: ~20 km

// Ground beyond the loaded chunks, so the horizon never shows a void.
const farGround = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 1 }));
farGround.position.y = -0.05;
scene.add(farGround);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const materials = makeMaterials(renderer);
// Sky, sun, fog, weather and night lighting (atmosphere.js).
const atmo = new Atmosphere({ renderer, scene, materials, mobile: MOBILE });
const minimap = new MiniMap($('minimap'));
const profile = loadProfile();
const character = new Character(profile.look);
const mp = new Multiplayer({ scene, camera, tags: $('tags'), onChange: showOnline });
mp.setProfile(profile.name, profile.look);
// Online unless the player chose to hide, or this place is where they really are (then they
// start hidden until they go online themselves). Tests stay offline unless given ?relay=.
const HIDE_KEY = 'openworld.hidden';
let atOwnLocation = false;
function wantOnline() {
  let hidden = false;
  try { hidden = localStorage.getItem(HIDE_KEY) === '1'; } catch { /* storage unavailable */ }
  return !hidden && !atOwnLocation && (!TEST || params.has('relay'));
}
function setVisible(on) {
  try { if (on) localStorage.removeItem(HIDE_KEY); else localStorage.setItem(HIDE_KEY, '1'); } catch { /* storage unavailable */ }
  if (on) atOwnLocation = false;
  mp.setOnline(on);
  flash(on ? 'Online: other players can see you' : 'Hidden: other players can\'t see you');
}
function showOnline(status, count) {
  const el = $('online'), short = touch.enabled;
  el.classList.toggle('on', status === 'online');
  el.querySelector('.label').textContent = {
    off: short ? 'Off' : 'Hidden',
    connecting: short ? '…' : 'Connecting…',
    offline: short ? '!' : 'Offline, retrying',
    online: short ? String(count) : `Online · ${count ? `${count} nearby` : 'nobody nearby'}`,
  }[status];
}
character.root.visible = false;
scene.add(character.root);

// ---------- session state ----------
let mode = 'boot';             // 'globe' | 'loading' | 'street'
let session = 0;
let frame = null, world = null, chunks = null, labels = null, player = null, spawn = null, traffic = null, police = null, far = null;
let globe = null;
let roadSigns = null;
let arcade = null, speedCams = null, races = null;
const nav = new Navigator($('nav'));
nav.onChange = (line) => { if (globe) globe.setRoute(line); };

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
  if (roadSigns) roadSigns.clear();
  minimap.clear();
  clearVehicles();
  character.root.visible = false;

  frame = new Frame(lat, lon);
  atmo.setPlace(lat, lon);
  milesThere = milesHere(lat, lon);
  const terrain = new Terrain(frame);
  world = new World(frame, terrain);
  if (traffic) traffic.dispose();
  traffic = new Traffic({ scene, world });
  if (police) police.dispose();
  traffic.miles = milesThere;
  police = new Police({
    scene, world, traffic, siren, onBusted: busted,
    hud: { box: $('wanted'), stars: $('wanted').querySelector('.stars'), time: $('wanted-time'), units: $('wanted-units'),
      label: $('wanted-label'), meter: $('wanted').querySelector('.fill'), banner: $('banner'), flash },
  });
  police.miles = milesThere;
  arcade = new Arcade({ world, traffic, police, flash,
    hud: { box: $('arcade'), points: $('sp-total'), nitro: $('arcade').querySelector('.nitro i'), pops: $('sp-pops') } });
  police.onTakedown = (u) => arcade.takedown(u);
  police.onEscape = (heat) => arcade.escaped(heat);
  police.onSpiked = () => arcade.spiked();
  if (speedCams) speedCams.dispose();
  if (races) races.dispose();
  const award = (pts, label, nitro) => arcade.award(pts, label, nitro);
  speedCams = new SpeedCams({ scene, world, pop: eventPop, award });
  races = new Races({ scene, world, traffic, police, pop: eventPop, award, flash, hud: { box: $('race') } });
  mp.setWorld(frame, world);
  labels = new Labels(world, scene, camera, $('tags'));
  labels.onChange = setLabelButtons;
  setLabelButtons(labels.mode);
  roadSigns = new RoadSigns(scene, world);
  chunks = new ChunkManager({ frame, world, scene, labels, minimap, materials, terrain, signs: roadSigns });
  try {
    // Parked cars use the car models, so give them a moment to load first.
    await Promise.race([carsReady, new Promise((r) => setTimeout(r, 5000))]);
    await chunks.warmup(0, 0, (p) => { $('loading-bar').style.width = `${Math.round(p * 100)}%`; });
  } catch (e) {
    console.error(e);
    $('loading-text').textContent = `Couldn't build this place: ${e.message}`;
    return;
  }
  if (token !== session) return;
  if (far) far.dispose();
  far = new FarView({ scene, frame, base: terrain.base });
  spawn = findSpawn(world, bearing);
  player = new Player(world, character, camera);
  player.spawn(spawn.x, spawn.z, spawn.yaw);
  character.root.visible = true;
  nav.reframe(frame, spawn.x, spawn.z);
  placeName(lat, lon).then((n) => { if (token === session) world.placeName = n; }).catch(() => {});
  setMode('street');
  if (!profile.saved && !TEST) openProfile();
  else { startOrPause(); mp.setOnline(wantOnline()); }
  window.game.ready = true;
}

// ---------- globe / map ----------
function openGlobe(kind) {
  if (locked) document.exitPointerLock();
  const g = getGlobe();
  setMode('globe');
  g.show();
  $('globe-back').classList.toggle('hidden', !player);
  $('drive-to').classList.toggle('hidden', !player);
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

// Navigate from where you are to the point in the middle of the map.
$('drive-to').addEventListener('click', () => {
  if (!player || !frame) return;
  const v = globe.view, dest = { lat: v.lat, lon: v.lon, name: '' };
  const p = player.vehicle || player.pos;
  nav.start(frame, p.x, p.z, dest);
  placeName(v.lat, v.lon).then((n) => { if (n) dest.name = n; }).catch(() => {});
  backToStreet();
});

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
  if (profileOpen()) { if (e.code === 'Escape' || e.code === 'Enter') closeProfile(); return; }
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

// ---------- name and character ----------
const profileOpen = () => !$('profile').classList.contains('hidden');
function setLookButtons() {
  for (const b of document.querySelectorAll('#profile-look button')) b.classList.toggle('on', b.dataset.look === profile.look);
}
function openProfile() {
  if (locked) document.exitPointerLock();
  keys.clear();
  touch.reset();
  playing = false;
  setOverlay(false);
  $('profile-name').value = profile.name;
  setLookButtons();
  $('profile').classList.remove('hidden');
  if (!touch.enabled) $('profile-name').focus();
}
function closeProfile() {
  profile.name = $('profile-name').value;
  saveProfile(profile);
  mp.setProfile(profile.name, profile.look);
  if (mode === 'street' && !mp.wanted) mp.setOnline(wantOnline());
  $('profile').classList.add('hidden');
  $('profile-name').blur();
  if (mode === 'street') startOrPause();
}
// Into the game: straight away on touch screens and in tests, else via the click-to-play panel.
// ---------- cars and bikes ----------
const carsReady = loadCars();
const vehicles = new Set();   // vehicles in this world: summoned ones and parked cars someone took
let myCar = null, myBike = null;

// Police (police.js): one siren for the whole session; sound needs a user gesture to start.
const siren = new Siren();
try { siren.on = localStorage.getItem('openworld.sound') !== 'off'; } catch { /* storage unavailable */ }
for (const ev of ['keydown', 'pointerdown', 'touchstart']) window.addEventListener(ev, () => siren.unlock(), { passive: true });

// Caught: out of the car, which is impounded.
function busted() {
  if (!player || !player.vehicle) { flash('Busted!'); return; }
  const v = player.exit();
  vehicles.delete(v); world.obstacles.delete(v); scene.remove(v.root); v.dispose();
  if (v === myCar) myCar = null;
  if (v === myBike) myBike = null;
  flash('Busted! Your car was impounded.');
}

function clearVehicles() {
  if (player && player.vehicle) player.exit();
  for (const v of vehicles) { scene.remove(v.root); v.dispose(); }
  vehicles.clear();
  myCar = myBike = null;
}

function addVehicle(v, x, z, yaw) {
  scene.add(v.root);
  vehicles.add(v);
  v.place(x, z, yaw, world);
  world.obstacles.add(v);
  // Keep the world tidy: at most 8, dropping the oldest one nobody is using.
  if (vehicles.size > 8) {
    const old = [...vehicles].find((o) => !o.driver && o !== myCar && o !== myBike);
    if (old) { vehicles.delete(old); world.obstacles.delete(old); scene.remove(old.root); old.dispose(); }
  }
  return v;
}

// Where a summoned car goes: the right-hand lane of the nearest street, pointing the way the
// camera faces; else just ahead of the player. A bike goes beside the player.
function vehicleSpot(kind) {
  const p = player.pos, fx = -Math.sin(player.camYaw), fz = -Math.cos(player.camYaw);
  const free = (x, z, r) => !world.buildingAt(x, z) && !world.blocked(x, z, r);
  if (kind === 'car') {
    const rd = world.nearestRoad(p.x, p.z, 40);
    if (rd) {
      const a = rd.road.p[rd.seg], b = rd.road.p[rd.seg + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let tx = (b[0] - a[0]) / l, tz = (b[1] - a[1]) / l;
      if (tx * fx + tz * fz < 0) { tx = -tx; tz = -tz; }
      const rx = -tz, rz = tx, lane = rd.road.ow ? 0 : rd.road.hw * 0.28;
      for (const along of [0, 6, -6, 12, -12, 20, -20]) {
        const x = rd.x + tx * along + rx * lane, z = rd.z + tz * along + rz * lane;
        if (free(x, z, 1.1)) return { x, z, yaw: Math.atan2(-tx, -tz) };
      }
    }
    for (const d of [5, 8, 3]) {
      const x = p.x + fx * d, z = p.z + fz * d;
      if (free(x, z, 1.1)) return { x, z, yaw: player.camYaw };
    }
    return null;
  }
  const rx = Math.cos(player.camYaw), rz = -Math.sin(player.camYaw);
  for (const [s, f] of [[1.2, 0.6], [-1.2, 0.6], [0, 1.6], [1.2, -1]]) {
    const x = p.x + rx * s + fx * f, z = p.z + rz * s + fz * f;
    if (free(x, z, 0.45)) return { x, z, yaw: player.camYaw };
  }
  return { x: p.x + rx * 1.2, z: p.z + rz * 1.2, yaw: player.camYaw };
}

function summon(kind) {
  if (!player || mode !== 'street') return;
  if (player.vehicle) { flash('Get out first (F)'); return; }
  if (kind === 'car' && !myCar && !carsReadyNow()) { flash('Cars are still loading…'); return; }
  const spot = vehicleSpot(kind);
  if (!spot) { flash('No room for a car here'); return; }
  let v = kind === 'car' ? myCar : myBike;
  // Your car already close by: swap it for the next model.
  if (v && kind === 'car' && Math.hypot(v.x - player.pos.x, v.z - player.pos.z) < 15) {
    const next = CAR_TYPES[(CAR_TYPES.indexOf(v.type) + 1) % CAR_TYPES.length];
    const swapped = new Vehicle('car', next);
    vehicles.delete(v); world.obstacles.delete(v); scene.remove(v.root); v.dispose();
    myCar = addVehicle(swapped, v.x, v.z, v.yaw);
    carFlash(swapped);
    return;
  }
  if (v) { world.obstacles.delete(v); v.place(spot.x, spot.z, spot.yaw, world); world.obstacles.add(v); }
  else {
    v = addVehicle(new Vehicle(kind, CAR_TYPES[0]), spot.x, spot.z, spot.yaw);
    if (kind === 'car') myCar = v; else myBike = v;
  }
  if (kind === 'car') carFlash(v);
  else flash(`Your bike is here: ${touch.enabled ? 'tap Get on' : 'press F to get on'}`);
}

function carFlash(v) {
  const m = CAR_MODELS[v.type];
  flash(`${m.label}, top speed ${Math.round(m.maxFwd * 3.6)} km/h · ${touch.enabled ? 'Car again for another model' : 'V again for another model'}`);
}
let carsLoadedFlag = false;
carsReady.then(() => { carsLoadedFlag = true; });
const carsReadyNow = () => carsLoadedFlag;

// The vehicle the player could get into right now: one of ours, or a parked car.
function vehicleInReach() {
  if (!player || player.vehicle) return null;
  const p = player.pos;
  let best = null, bd = 1.6;
  for (const v of vehicles) {
    if (v.driver) continue;
    const d = v.reach(p.x, p.z);
    if (d < bd) { bd = d; best = v; }
  }
  if (best) return { vehicle: best };
  const parked = carsReadyNow() ? world.parkedCarNear(p.x, p.z, 1.4) : null;
  if (parked) return { parked };
  const moving = traffic ? traffic.nearest(p.x, p.z, 1.4) : null;
  return moving ? { traffic: moving } : null;
}

function useVehicle() {
  if (!player || mode !== 'street') return;
  if (player.vehicle) { player.exit(); return; }
  const r = vehicleInReach();
  if (!r) { flash(touch.enabled ? 'Nothing to get into here: tap Car or Bike' : 'Nothing to get into here: V for a car, B for a bike'); return; }
  let v = r.vehicle;
  if (r.parked) {
    const c = r.parked;
    v = addVehicle(new Vehicle('car', c.type), c.x, c.z, Math.atan2(-c.ux, -c.uz));
    takeParkedCar(c);
  } else if (r.traffic) {
    const t = traffic.take(r.traffic);
    v = addVehicle(new Vehicle('car', t.type), t.x, t.z, t.yaw);
  }
  player.enter(v);
}

// Speed units: the place's own (mph in the US and UK) unless the player picked one.
let milesThere = false;
let unitsPick = null;
try { unitsPick = ['mph', 'kmh'].includes(localStorage.getItem('openworld.units')) ? localStorage.getItem('openworld.units') : null; } catch { /* storage unavailable */ }
const showMiles = () => (unitsPick ? unitsPick === 'mph' : milesThere);
function setUnits(u) {
  unitsPick = u;
  try { if (u) localStorage.setItem('openworld.units', u); else localStorage.removeItem('openworld.units'); } catch { /* storage unavailable */ }
  for (const b of document.querySelectorAll('#units-mode button')) b.classList.toggle('on', (b.dataset.v || null) === (u || null) || (!u && b.dataset.v === 'auto'));
  flash(`Speed in ${showMiles() ? 'mph' : 'km/h'}`);
}
for (const b of document.querySelectorAll('#units-mode button')) b.addEventListener('click', () => setUnits(b.dataset.v === 'auto' ? null : b.dataset.v));
for (const b of document.querySelectorAll('#units-mode button')) b.classList.toggle('on', (b.dataset.v === 'auto' && !unitsPick) || b.dataset.v === unitsPick);

// Big message for events: a title, an optional speed (m/s, shown in the player's units) and a line
// under it (text, or { best } m/s).
let popTimer = null;
function eventPop(title, ms, sub) {
  const miles = showMiles(), unit = miles ? 'mph' : 'km/h', k = miles ? MPH_PER_MS : KMH_PER_MS;
  const big = ms != null ? `<b>${Math.round(ms * k)}</b><small>${unit}</small>` : '';
  const line = sub && typeof sub === 'object' ? `best ${Math.round(sub.best * k)} ${unit}` : sub || '';
  const el = $('event-pop');
  el.innerHTML = `<div class="t">${escapeHtml(title)}</div>${big ? `<div class="v">${big}</div>` : ''}${line ? `<div class="s">${escapeHtml(line)}</div>` : ''}`;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(popTimer);
  popTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Bottom-of-screen hint: what F does here, or the speed and the road's limit while driving.
function updateDriveHint() {
  const el = $('drive-hint');
  let html = '';
  if (player && player.vehicle) {
    const v = player.vehicle, miles = showMiles();
    const speed = Math.round(Math.abs(v.speed) * (miles ? MPH_PER_MS : KMH_PER_MS));
    const rd = world.nearestRoad(v.x, v.z, 12, (r) => r.kind === 'car' || r.kind === 'service');
    let sign = '', over = false;
    if (rd && v.kind === 'car') {
      const lim = speedLimit(rd.road, milesThere);
      over = Math.abs(v.speed) > lim.ms * 1.08;
      sign = milesThere ? `<span class="limit us"><small>SPEED<br>LIMIT</small>${lim.value}</span>` : `<span class="limit eu">${lim.value}</span>`;
    }
    html = `${sign}${escapeHtml(v.spec.label)} &nbsp; <b class="${over ? 'over' : ''}">${speed}</b> ${miles ? 'mph' : 'km/h'}${touch.enabled ? '' : (v.kind === 'car' ? ' &nbsp; <kbd>Shift</kbd> nitrous' : '') + ' &nbsp; <kbd>F</kbd> get out &nbsp; <kbd>Space</kbd> brake'}`;
  } else if (player) {
    const r = vehicleInReach();
    if (r) {
      const bike = r.vehicle && r.vehicle.kind === 'bike';
      html = touch.enabled ? '' : `<kbd>F</kbd> ${bike ? 'get on the bike' : 'get in the car'}`;
    }
    $('btn-use').textContent = r && r.vehicle && r.vehicle.kind === 'bike' ? 'Get on' : 'Get in';
    $('btn-use').classList.toggle('hidden', !r);
  }
  if (player && player.vehicle) { $('btn-use').textContent = 'Get out'; $('btn-use').classList.remove('hidden'); }
  $('btn-jump').textContent = player && player.vehicle ? 'Brake' : 'Jump';
  document.body.classList.toggle('driving', !!(player && player.vehicle));
  el.innerHTML = html;
  el.classList.toggle('show', !!html);
}
$('btn-car').addEventListener('click', () => summon('car'));
$('btn-bike').addEventListener('click', () => summon('bike'));
$('btn-use').addEventListener('click', useVehicle);

function startOrPause() {
  if (TEST || touch.enabled) playing = true; else setOverlay(true);
}
$('profile-name').maxLength = NAME_MAX;
$('profile-name').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); closeProfile(); } });
for (const b of document.querySelectorAll('#profile-look button')) {
  b.addEventListener('click', () => { profile.look = b.dataset.look; character.setLook(profile.look); setLookButtons(); });
}
$('profile-done').addEventListener('click', closeProfile);
$('about-profile').addEventListener('click', () => { closeAbout(); openProfile(); });
$('about-btn').addEventListener('click', openAbout);
$('globe-about').addEventListener('click', openAbout);
$('intro-about').addEventListener('click', openAbout);
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
actions.KeyI = openAbout;
actions.KeyO = () => setVisible(!mp.wanted);
actions.KeyV = () => summon('car');
actions.KeyB = () => summon('bike');
actions.KeyF = useVehicle;
// Time and weather: live (the real ones there) or picked.
function setTimeMode(m) { atmo.setTimeMode(m); syncAtmoButtons(); flash(`Time: ${m === 'live' ? 'live (local time there)' : m}`); }
function setWeatherMode(m) { atmo.setWeatherMode(m); syncAtmoButtons(); flash(`Weather: ${m === 'live' ? 'live (real weather there)' : m}`); }
function syncAtmoButtons() {
  for (const b of document.querySelectorAll('#time-mode button')) b.classList.toggle('on', b.dataset.v === atmo.timeMode);
  for (const b of document.querySelectorAll('#weather-mode button')) b.classList.toggle('on', b.dataset.v === atmo.weatherMode);
}
for (const b of document.querySelectorAll('#time-mode button')) b.addEventListener('click', () => setTimeMode(b.dataset.v));
for (const b of document.querySelectorAll('#weather-mode button')) b.addEventListener('click', () => setWeatherMode(b.dataset.v));
syncAtmoButtons();
actions.KeyT = () => setTimeMode(TIME_MODES[(TIME_MODES.indexOf(atmo.timeMode) + 1) % TIME_MODES.length]);
actions.KeyY = () => setWeatherMode(WEATHER_MODES[(WEATHER_MODES.indexOf(atmo.weatherMode) + 1) % WEATHER_MODES.length]);

actions.KeyU = () => setUnits(showMiles() ? 'kmh' : 'mph');
actions.KeyN = () => {
  siren.on = !siren.on;
  try { localStorage.setItem('openworld.sound', siren.on ? 'on' : 'off'); } catch { /* storage unavailable */ }
  flash(siren.on ? 'Sound on' : 'Sound off');
};
$('online').addEventListener('click', () => setVisible(!mp.wanted));
showOnline(mp.status, 0);
actions.KeyG = () => openGlobe('globe');

// ---------- loop ----------
let last = performance.now(), hudT = 0, miniT = 0, frames = 0, fpsT = 0, hashT = 0, farT = 0, lightT = 0;
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
      brake: active && (k('Space') || tc.brake),
      boost: active && (k('ShiftLeft', 'ShiftRight') || tc.boost),
      lookX: mouseDX * MOUSE_SENS + tc.lookX + (active ? ((k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0)) * 2.2 * dt : 0),
      lookY: mouseDY * MOUSE_SENS + tc.lookY,
      zoom: zoomAcc + tc.zoom,
    };
    mouseDX = 0; mouseDY = 0; zoomAcc = 0; jumpQueued = false;

    // The crash cam slows the world down.
    const sdt = dt * (arcade ? arcade.timeScale : 1);
    player.update(sdt, input);
    const p = player.pos;
    // Widen the view when sprinting, and with speed and nitrous when driving.
    const dv = player.vehicle;
    const fov = dv
      ? FOV + 12 * Math.min(1, Math.max(0, (Math.abs(dv.speed) - 15) / 30)) + (dv.boosting ? 9 : 0)
      : FOV + 7 * Math.min(1, Math.max(0, (player.speed - RUN) / (SPRINT - RUN)));
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * (1 - Math.exp(-4 * dt));
      camera.updateProjectionMatrix();
    }
    // Driving: load ahead in the direction of travel.
    const v = player.vehicle;
    if (v) { const [fx, fz] = v.fwd; chunks.update(p.x + fx * v.speed * 3, p.z + fz * v.speed * 3); }
    else chunks.update(p.x, p.z);
    atmo.follow(p);
    atmo.sky.position.copy(camera.position);
    atmo.update(dt, { camera, world, player, traffic, time: now / 1000 });
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
      // High above the surroundings (a hill, a tower): the haze lifts so you can see far.
      if (far && far.ready) atmo.viewBoost = Math.min(1, Math.max(0, (camera.position.y - far.lowAround(p.x, p.z) - 40) / 260));
    }
    if (far) { far.update(p); farGround.visible = !far.ready; }
    farGround.position.x = p.x;
    farGround.position.z = p.z;
    labels.update(dt, p.x, p.z);
    roadSigns.update(dt, p.x, p.z);
    mp.update(dt, player);
    traffic.update(sdt, player);
    police.update(sdt, player);
    arcade.update(dt, player);
    speedCams.update(sdt, player);
    races.update(sdt, player);
    document.body.classList.toggle('racing', races.active);
    if (player.vehicle) traffic.bump(player.vehicle.x, player.vehicle.z, 0);
    lightT -= dt;
    if (lightT <= 0) {
      lightT = 0.2;
      for (const ch of chunks.chunks.values()) if (ch.lights && ch.state === 'full') updateLights(ch.lights, traffic.time);
    }

    hudT -= dt;
    if (hudT <= 0) {
      hudT = 0.25;
      const loc = world.locate(p.x, p.z);
      const street = loc.street ? `<b>${escapeHtml(loc.street)}</b>${loc.cross ? ` &amp; ${escapeHtml(loc.cross)}` : ''}` : '<b>Exploring</b>';
      $('where').innerHTML = `${street}${loc.area ? `<span>${escapeHtml(loc.area)}</span>` : ''}`;
      updateDriveHint();
      nav.update(0.25, p.x, p.z, milesThere);
      $('conditions').textContent = atmo.label;
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
    if (miniT <= 0) { miniT = 0.05; 
      // Zoom out when driving fast, and further in a chase to show the police's sight.
      const fast = player.vehicle ? Math.abs(player.vehicle.speed) : 0;
      const radius = police.wanted ? 280 : fast > 14 ? 90 + (Math.min(fast, 40) - 14) * 4 : 90;
      minimap.draw(p.x, p.z, player.camYaw, player.yaw, labels.items, mp.positions(), races.line ? { pts: races.line, color: '#ffb02a' } : nav.line,
        [...police.markers(), ...arcade.markers(), ...speedCams.markers(), ...races.markers()], races.active ? Math.max(radius, 200) : radius);
    }
    hashT -= dt;
    if (hashT <= 0 && !TEST) {
      hashT = 2;
      const [lat, lon] = frame.toLatLon(p.x, p.z);
      history.replaceState(null, '', `#${lat.toFixed(6)},${lon.toFixed(6)}`);
    }
    frames++; fpsT += dt;
    if (fpsT > 0.5) { $('fps').textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0; }
    arcade.applyCamera(camera);
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
  openGlobe, enterStreet, nav,
  get speedCams() { return speedCams; },
  get races() { return races; },
  get arcade() { return arcade; },
  get spawn() { return spawn; },
  vehicles,
  get traffic() { return traffic; },
  get police() { return police; },
  atmo,
  get far() { return far; },
  scene,
  get profile() { return profile; },
  mp,
  character,
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
    if (pos) { atOwnLocation = true; enterStreet(pos.lat, pos.lon); }
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
