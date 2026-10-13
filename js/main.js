import * as THREE from 'three';
import { fetchJSON } from './util.js';
import { World } from './world.js';
import { planBuildings, buildBuildings, buildingMaterial } from './buildings.js';
import { buildStreets, buildContextRoads, groundMaterial } from './streets.js';
import { buildTrees, buildFurniture, buildParkedCars } from './props.js';
import { Character } from './character.js';
import { Player } from './player.js';
import { Labels, CATS, escapeHtml } from './labels.js';
import { MiniMap } from './minimap.js';

const $ = (id) => document.getElementById(id);
const TEST = new URLSearchParams(location.search).has('test');
const MOUSE_SENS = 0.0024;

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('world').appendChild(renderer.domElement);

const HORIZON = new THREE.Color('#d8eaf5');
const scene = new THREE.Scene();
scene.background = HORIZON;
scene.fog = new THREE.Fog(HORIZON, 90, 430);
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 1500);

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(900, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: { top: { value: new THREE.Color('#5b9fe3') }, horizon: { value: HORIZON } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 top;
      uniform vec3 horizon;
      varying vec3 vP;
      void main() {
        float h = clamp(normalize(vP).y, 0.0, 1.0);
        gl_FragColor = vec4(mix(horizon, top, pow(h, 0.55)), 1.0);
        #include <colorspace_fragment>
      }`,
  }),
);
sky.renderOrder = -1;
scene.add(sky);

scene.add(new THREE.HemisphereLight('#e2efff', '#a3ad86', 1.6));
const sun = new THREE.DirectionalLight('#fff0d8', 2.5);
const SUN_DIR = new THREE.Vector3(-0.5, 0.78, 0.38).normalize();
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 400 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- load + build ----------
const DATASETS = ['buildings', 'roads', 'pois', 'areas', 'trees', 'props', 'context_buildings', 'context_roads'];
const REQUIRED = new Set(['buildings', 'roads']);
const OPTIONAL_EMPTY = {
  pois: { pois: [] }, areas: { areas: [], lines: [] }, trees: { trees: [] }, props: { props: [] },
  context_buildings: { buildings: [] }, context_roads: { roads: [] },
};

async function load() {
  const meta = await fetchJSON('/data/meta.json');
  let done = 0;
  const setProgress = (label) => {
    $('loading-text').textContent = label;
    $('loading-bar').style.width = `${Math.round((done / (DATASETS.length + 4)) * 100)}%`;
  };
  setProgress('Downloading map data…');
  const data = Object.fromEntries(await Promise.all(DATASETS.map(async (n) => {
    let d;
    try {
      d = await fetchJSON(`/data/${n}.json`);
    } catch (e) {
      if (REQUIRED.has(n)) throw e;
      console.warn(`[world] ${n} unavailable, continuing without it`, e);
      d = OPTIONAL_EMPTY[n];
    }
    done++; setProgress(`Downloaded ${n.replace('_', ' ')}`);
    return [n, d];
  })));
  const tick = async (label) => { done++; setProgress(label); await new Promise((r) => setTimeout(r, 0)); };

  const world = new World(meta, {
    buildings: data.buildings.buildings, roads: data.roads.roads, junctions: data.roads.junctions,
    pois: data.pois.pois, areas: data.areas.areas, lines: data.areas.lines,
    trees: data.trees.trees, props: data.props.props,
  });
  for (const p of world.pois) {
    const b = world.buildingAt(p.x, p.z);
    if (b) { p.building = b; b.pois.push(p); }
  }

  await tick('Raising buildings…');
  planBuildings(world, world.buildings);
  const bMat = buildingMaterial();
  scene.add(buildBuildings(world, world.buildings, bMat));
  const coreIds = new Set(world.buildings.map((b) => b.id));
  const ctxBuildings = data.context_buildings.buildings.filter((b) => !coreIds.has(b.id)).map((b, i) => world._building(b, i));
  planBuildings(world, ctxBuildings, { streets: false });
  const ctxMesh = buildBuildings(world, ctxBuildings, bMat, { lite: true });
  ctxMesh.castShadow = false;
  scene.add(ctxMesh);

  await tick('Paving streets…');
  const gMat = groundMaterial();
  const streets = buildStreets(world, gMat);
  scene.add(streets.mesh);
  scene.add(buildContextRoads(data.context_roads.roads, new Set(world.roads.map((r) => r.id)), gMat));

  await tick('Planting trees…');
  const props = new THREE.Group();
  scene.add(props);
  const trees = buildTrees(world, streets.spots, props);
  buildFurniture(world, streets.spots, props);
  const cars = buildParkedCars(world, streets.spots, props);

  await tick('Putting up signs…');
  const labels = new Labels(world, scene, camera, $('tags'));
  labels.build();
  const minimap = new MiniMap(world, labels, $('minimap'), $('fullmap'));

  console.log(`[world] buildings=${world.buildings.length} context=${ctxBuildings.length} roads=${world.roads.length} trees=${trees.length} cars=${cars.length} places=${labels.items.length} streetSigns=${labels.streetSigns.length}`);
  return { world, labels, minimap };
}

function findSpawn(world) {
  const j = world.junctions.find((jj) => {
    const n = new Set(jj.carArms.map((a) => a.road.n));
    return n.has('C Street') && n.has('3rd Street');
  });
  if (!j) return { x: 0, z: 0, yaw: 0 };
  const arm = j.carArms.find((a) => a.road.n === 'C Street');
  const pts = arm.road.p;
  const nb = [pts[arm.vi - 1], pts[arm.vi + 1]].filter(Boolean).sort((a, b) => a[1] - b[1])[0];
  const l = Math.hypot(nb[0] - j.x, nb[1] - j.z);
  const tx = (nb[0] - j.x) / l, tz = (nb[1] - j.z) / l;
  // West side of C Street (next to Central Park): step out from the curb to the first sidewalk.
  const at = (d) => ({ x: j.x + tx * 16 + tz * d, z: j.z + tz * 16 - tx * d });
  let spot = at(arm.road.hw + 2.15);
  for (let d = arm.road.hw + 0.5; d < arm.road.hw + 14; d += 0.5) {
    const p = at(d);
    if (world.groundAt(p.x, p.z) > 0) { spot = at(d + 0.6); break; }
  }
  return { ...spot, yaw: Math.atan2(-tx, -tz) };
}

// ---------- input ----------
const keys = new Set();
let mouseDX = 0, mouseDY = 0, zoomAcc = 0, jumpQueued = false;
let locked = false, dragLook = false, dragging = false, playing = TEST, mapOpen = false;

function setOverlay(show) { $('intro').classList.toggle('hidden', !show); }

function startPlaying() {
  const canvas = renderer.domElement;
  if (canvas.requestPointerLock && !dragLook) {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => { dragLook = true; playing = true; setOverlay(false); });
  } else {
    playing = true; setOverlay(false);
  }
}

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  if (locked) { playing = true; setOverlay(false); } else if (!mapOpen && !dragLook) { playing = false; setOverlay(true); }
});
document.addEventListener('pointerlockerror', () => { dragLook = true; playing = true; setOverlay(false); });
document.addEventListener('mousemove', (e) => {
  if (locked || (dragLook && dragging)) { mouseDX += e.movementX; mouseDY += e.movementY; }
});
renderer.domElement.addEventListener('mousedown', () => { if (dragLook) dragging = true; else if (playing && !locked) startPlaying(); });
window.addEventListener('mouseup', () => { dragging = false; });
window.addEventListener('wheel', (e) => { if (!mapOpen) zoomAcc += e.deltaY * 0.004; }, { passive: true });
window.addEventListener('blur', () => keys.clear());
$('play').addEventListener('click', startPlaying);

const actions = {};
window.addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (!e.repeat) {
    if (e.code === 'Space') jumpQueued = true;
    if (actions[e.code]) actions[e.code]();
  }
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

// ---------- HUD ----------
function setLabelButtons(mode) {
  for (const b of document.querySelectorAll('#labelmode button')) b.classList.toggle('on', b.dataset.mode === mode);
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

// ---------- boot ----------
(async () => {
  let ctx;
  try {
    ctx = await load();
  } catch (e) {
    console.error(e);
    $('loading-text').textContent = `Couldn't load the world: ${e.message}`;
    return;
  }
  const { world, labels, minimap } = ctx;
  const character = new Character();
  scene.add(character.root);
  const player = new Player(world, character, camera);
  const spawn = findSpawn(world);
  player.spawn(spawn.x, spawn.z, spawn.yaw);

  setLabelButtons(labels.mode);
  labels.onChange = setLabelButtons;
  for (const b of document.querySelectorAll('#labelmode button')) {
    b.addEventListener('click', () => labels.setMode(b.dataset.mode));
  }
  actions.KeyL = () => { labels.cycle(); flash(`Labels: ${labels.mode}`); };
  actions.KeyR = () => { player.spawn(spawn.x, spawn.z, spawn.yaw); flash('Back to C Street & 3rd'); };
  let toMap = null;
  const openMap = (open) => {
    mapOpen = open;
    $('mapview').classList.toggle('hidden', !open);
    if (open) {
      if (locked) document.exitPointerLock();
      toMap = minimap.drawFull(player.pos.x, player.pos.z, player.yaw);
    } else if (playing) startPlaying();
  };
  actions.KeyM = () => openMap(!mapOpen);
  $('mapclose').addEventListener('click', () => openMap(false));
  $('fullmap').addEventListener('click', (e) => {
    if (!toMap) return;
    const p = toMap(e.clientX, e.clientY);
    if (!world.inCore(p.x, p.z, 4) || world.buildingAt(p.x, p.z)) { flash('Pick an open spot inside the area'); return; }
    player.spawn(p.x, p.z, player.yaw);
    openMap(false);
  });

  let flashT = 0;
  function flash(text) { $('flash').textContent = text; $('flash').classList.add('show'); flashT = 1.6; }

  $('loading').classList.add('hidden');
  if (!TEST) setOverlay(true);

  let last = performance.now(), hudT = 0, miniT = 0, frames = 0, fpsT = 0;
  let cardId = null;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const k = (...c) => c.some((x) => keys.has(x));
    const active = playing && !mapOpen;
    const input = {
      fwd: active ? (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0) : 0,
      right: active ? (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0) : 0,
      run: k('ShiftLeft', 'ShiftRight'),
      jump: active && jumpQueued,
      lookX: mouseDX * MOUSE_SENS + (active ? ((k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0)) * 2.2 * dt : 0),
      lookY: mouseDY * MOUSE_SENS,
      zoom: zoomAcc,
    };
    mouseDX = 0; mouseDY = 0; zoomAcc = 0; jumpQueued = false;

    player.update(dt, input);
    const p = player.pos;
    sun.target.position.set(p.x, 0, p.z);
    sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 150);
    sky.position.copy(camera.position);
    labels.update(dt, p.x, p.z);

    hudT -= dt;
    if (hudT <= 0) {
      hudT = 0.25;
      const loc = world.locate(p.x, p.z);
      const street = loc.street ? `<b>${escapeHtml(loc.street)}</b>${loc.cross ? ` &amp; ${escapeHtml(loc.cross)}` : ''}` : '<b>Downtown Davis</b>';
      $('where').innerHTML = `${street}<span>${escapeHtml(loc.area || 'Downtown Davis')}</span>`;
      const near = labels.nearest(p.x, p.z, 9);
      if (near && near.id !== cardId) { $('card').innerHTML = renderCard(near); }
      cardId = near ? near.id : null;
      $('card').classList.toggle('show', !!near);
    }
    miniT -= dt;
    if (miniT <= 0) { miniT = 0.05; minimap.drawMini(p.x, p.z, player.camYaw, player.yaw); }
    if (flashT > 0) { flashT -= dt; if (flashT <= 0) $('flash').classList.remove('show'); }
    frames++; fpsT += dt;
    if (fpsT > 0.5) { $('fps').textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0; }

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Handle for automated checks / debugging in the console.
  window.game = {
    world, player, labels, camera, renderer,
    setView(camYaw, camPitch, camDist) { player.camYaw = camYaw; player.camPitch = camPitch; if (camDist) player.camDist = camDist; },
    teleport(x, z, yaw = player.yaw) { player.spawn(x, z, yaw); },
    press(code, down) { if (down) keys.add(code); else keys.delete(code); },
    openMap,
    ready: true,
  };
})();
