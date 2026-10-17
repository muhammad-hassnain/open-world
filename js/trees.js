// Shared, instanced botanical geometry. Original branch construction; CC0 photographic
// bark/foliage from Poly Haven (assets/nature/CREDITS.md). No per-tree objects or frame loops.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng } from './util.js';

const time = { value: 0 }, wind = { value: new THREE.Vector2(0.4, 0.2) };
const shared = o => { o.userData.shared = true; return o; };
const loader = new THREE.TextureLoader();
const TEXTURE_VERSION = 1; // bump when replacing any file in assets/nature/
const geometries = new Map();
let materials;

export function updateTrees(seconds, speed = 3, direction = 240) {
  time.value = seconds;
  const a = (direction + 180) * Math.PI / 180, strength = Math.min(1.6, Math.max(0.08, speed / 7));
  wind.value.set(Math.sin(a) * strength, -Math.cos(a) * strength);
}

function texture(file, color = false, repeat = false) {
  const t = shared(loader.load(`assets/nature/${file}?v=${TEXTURE_VERSION}`));
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// Identical deformation in the lit and shadow passes keeps moving cutout shadows attached.
function sway(material, leaf) {
  material.onBeforeCompile = shader => {
    shader.uniforms.treeTime = time; shader.uniforms.treeWind = wind;
    shader.vertexShader = `uniform float treeTime; uniform vec2 treeWind;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vec3 treeOrigin = vec3(0.0);
      vec2 localWind = treeWind;
      #ifdef USE_INSTANCING
        treeOrigin = instanceMatrix[3].xyz;
        localWind = vec2(dot(instanceMatrix[0].xz, treeWind), dot(instanceMatrix[2].xz, treeWind)) / length(instanceMatrix[0].xyz);
      #endif
      float phase = dot(treeOrigin.xz, vec2(0.17, 0.13));
      float bend = pow(max(position.y, 0.0) / 8.0, 2.0);
      transformed.xz += localWind * bend * (sin(treeTime * 1.3 + phase) * 0.14 + sin(treeTime * 0.61 + phase) * 0.08);
      ${leaf ? 'transformed.xz += localWind * sin(treeTime * 3.1 + position.x * 3.0 + position.z * 2.0 + phase) * 0.025 * min(position.y / 3.0, 1.0);' : ''}
    `);
  };
  material.customProgramCacheKey = () => `tree-sway-${leaf ? 'leaf' : 'wood'}-2`;
  return shared(material);
}

function getMaterials() {
  if (materials) return materials;
  const bark = sway(new THREE.MeshStandardMaterial({ map: texture('bark.jpg', true, true),
    normalMap: texture('bark-normal.jpg', false, true), normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 0.96, color: '#b2a18c', envMapIntensity: 0.45 }), false);
  const leaves = name => {
    const map = texture(`${name}.png`, true);
    const mat = sway(new THREE.MeshStandardMaterial({ map, alphaTest: 0.4, alphaToCoverage: true,
      side: THREE.DoubleSide, vertexColors: true, roughness: 0.88, envMapIntensity: 0.7 }), true);
    const depth = sway(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map,
      alphaTest: 0.4, side: THREE.DoubleSide }), true);
    return { mat, depth };
  };
  materials = { bark, woodDepth: sway(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), false),
    broadleaf: leaves('broadleaf'), needles: leaves('needles') };
  return materials;
}

function branch(a, b, radius, tip) {
  const delta = b.clone().sub(a), len = delta.length();
  const g = new THREE.CylinderGeometry(tip, radius, len, radius > 0.1 ? 9 : 5, 1, true);
  // Meter-scaled bark: circumferential repetition and vertical grain along each branch.
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(0.35, radius * 8), uv.getY(i) * len / 2);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
  g.translate(...a.clone().add(b).multiplyScalar(0.5).toArray());
  return g;
}

function treeGeometry(kind, variant, low) {
  const key = `${kind}-${variant}-${low}`;
  if (geometries.has(key)) return geometries.get(key);
  const R = rng(9413 + variant * 713 + (kind === 'tall' ? 37 : kind === 'conifer' ? 93 : 0));
  const pine = kind === 'conifer', tall = kind === 'tall';
  const height = pine ? 8.2 : tall ? 9 : 7.2, crownY = pine ? 4.5 : tall ? 5.8 : 4.9;
  const wood = [], leaves = [], center = new THREE.Vector3(0, crownY, 0);
  const stem = new THREE.Vector3((R() - 0.5) * 0.35, height * 0.85, (R() - 0.5) * 0.3);
  const crotch = new THREE.Vector3(stem.x * 0.3, pine ? 3 : 2.9, stem.z * 0.3);
  wood.push(branch(new THREE.Vector3(), crotch, 0.23, 0.14));
  wood.push(branch(crotch, stem, 0.14, 0.025));
  const forks = [];
  if (!pine) for (let i = 0; i < 5; i++) {
    const a = i * 2.39996, spread = tall ? 0.55 : 1.15;
    const p = new THREE.Vector3(Math.sin(a) * spread, 3.7 + R() * 0.8, Math.cos(a) * spread);
    const mid = crotch.clone().lerp(p, 0.5); mid.y -= 0.25;
    wood.push(branch(crotch, mid, 0.11, 0.075), branch(mid, p, 0.075, 0.045));
    forks.push(p);
  }
  // Flared roots tie the trunk into the ground without hovering cylinders.
  for (let i = 0; i < (low ? 0 : 5); i++) {
    const a = i * Math.PI * 0.4;
    wood.push(branch(new THREE.Vector3(Math.sin(a) * 0.44, 0.02, Math.cos(a) * 0.44),
      new THREE.Vector3(0, 0.55, 0), 0.08, 0.12));
  }
  const clusters = low ? 10 : pine ? 20 : 18;
  for (let i = 0; i < clusters; i++) {
    const angle = i * 2.39996 + R() * 0.4;
    const level = i / (clusters - 1), y = pine ? 1.9 + level * 5.8 : 3.1 + level * (height - 3.8);
    const radius = pine ? 2.4 * (1 - level) + 0.2 : (tall ? 1.15 : 2.5) * Math.sqrt(Math.max(0.08, 1 - Math.pow((y - crownY) / (height * 0.45), 2)));
    const end = new THREE.Vector3(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
    const start = pine ? new THREE.Vector3(stem.x * level, y + 0.25, stem.z * level) :
      forks.reduce((best, p) => p.distanceToSquared(end) < best.distanceToSquared(end) ? p : best, forks[0]);
    wood.push(branch(start, end, pine ? 0.055 : 0.045, 0.009));
    for (let j = 0; j < (low ? 3 : pine ? 14 : 6); j++) {
      const p = end.clone().multiplyScalar(pine ? 0.3 + R() * 0.85 : 0.65 + R() * 0.45);
      p.y = y + (R() - 0.4) * (pine ? 0.6 : 1.4);
      p.x += (R() - 0.5) * 1.2; p.z += (R() - 0.5) * 1.2;
      const size = (pine ? 1.3 + R() * 0.5 : 1.6 + R() * 0.65) * (low ? 1.4 : 1);
      const g = new THREE.PlaneGeometry(size * (pine ? 0.6 : 1), size, 1, low ? 1 : 2);
      // Slightly cupped twig cards; three-dimensional clusters preserve gaps to the sky.
      const pos = g.attributes.position;
      for (let k = 0; k < pos.count; k++) pos.setZ(k, Math.abs(pos.getY(k)) * 0.18);
      g.rotateX((R() - 0.5) * 2.0 + (pine ? 1.1 : 0.2));
      g.rotateY(angle + (R() - 0.5) * 3);
      g.translate(p.x, p.y, p.z);
      const normals = g.attributes.normal, colors = new Float32Array(pos.count * 3);
      const shade = 0.65 + R() * 0.3;
      for (let k = 0; k < pos.count; k++) {
        // Canopy normals avoid alternating black/white billboard planes in sunlight.
        const n = new THREE.Vector3(pos.getX(k), (pos.getY(k) - center.y) * 0.55 + 1.8, pos.getZ(k)).normalize();
        normals.setXYZ(k, n.x, n.y, n.z);
        colors.set([shade, shade, shade], k * 3);
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      leaves.push(g);
    }
  }
  const result = { wood: shared(mergeGeometries(wood)), leaves: shared(mergeGeometries(leaves)) };
  for (const g of [...wood, ...leaves]) g.dispose();
  for (const g of Object.values(result)) {
    g.computeBoundingSphere(); g.boundingSphere.radius += 0.7; // maximum shader sway
  }
  geometries.set(key, result);
  return result;
}

export function treeAssets(kind, variant = 0, low = false) {
  const m = getMaterials(), g = treeGeometry(kind, variant, low);
  return { ...g, bark: m.bark, woodDepth: m.woodDepth, ...(kind === 'conifer' ? m.needles : m.broadleaf) };
}

let nextDetail = 0;
const matrix = new THREE.Matrix4(), color = new THREE.Color();
export function updateTreeDetail(seconds, chunks, position, mobile = false) {
  if (seconds < nextDetail) return;
  nextDetail = seconds + 0.5;
  for (const ch of chunks.values()) for (const batch of ch.group?.userData.treeBatches || []) {
    let changed = !batch.initialized;
    for (const t of batch.items) {
      const radius = (mobile ? 40 : 65) + (t.near ? 10 : 0);
      const near = (t.x - position.x) ** 2 + (t.z - position.z) ** 2 < radius * radius;
      if (near !== t.near) { t.near = near; changed = true; }
    }
    if (!changed) continue; // no uploads or bounding-volume rebuilds for unchanged trees
    batch.initialized = true;
    let near = 0, far = 0;
    for (let i = 0; i < batch.items.length; i++) {
      const t = batch.items[i];
      const meshes = t.near ? batch.near : batch.far, index = t.near ? near++ : far++;
      matrix.fromArray(batch.matrices, i * 16); color.copy(batch.colors[i]);
      for (const mesh of meshes) mesh.setMatrixAt(index, matrix);
      meshes[1].setColorAt(index, color);
    }
    for (const [meshes, count] of [[batch.near, near], [batch.far, far]]) for (const mesh of meshes) {
      mesh.count = count; mesh.visible = count > 0; mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.boundingSphere = null; mesh.computeBoundingSphere(); mesh.boundingSphere.radius += 1;
    }
  }
}
