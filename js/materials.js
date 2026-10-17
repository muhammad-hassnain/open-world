// Shared materials. Textured ones use CC0 textures from assets/textures (see CREDITS.md);
// vertex colors tint them, so one stucco texture can be any paint color.
import * as THREE from 'three';

const loader = new THREE.TextureLoader();
const textures = new Map();

function texture(name, kind, anisotropy) {
  const key = `${name}:${kind}:${anisotropy}`;
  if (textures.has(key)) return textures.get(key);
  const t = loader.load(`assets/textures/${name}_${kind}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  if (kind === 'color') t.colorSpace = THREE.SRGBColorSpace;
  textures.set(key, t);
  return t;
}

// Ground layers (ground, grass, roads, sidewalks, paint) all lie on the terrain and are cut into
// different triangles, so on hills they can cross each other by a few centimeters. Each layer is
// pulled slightly toward the camera along the view ray (same pixel, smaller depth) so higher
// layers always win. Contact materials below must use the same view-space convention.
export function layered(m, layer) {
  if (!layer) return m;
  const rel = (layer * 0.0004).toFixed(5), abs = (layer * 0.02).toFixed(3);
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      {
        float viewDist = length(mvPosition.xyz);
        float bias = ${rel} + ${abs} / max(viewDist, 0.5);
        mvPosition.xyz *= max(0.0, 1.0 - bias);
        gl_Position = projectionMatrix * mvPosition;
      }`);
  };
  m.customProgramCacheKey = () => `ground-layer-${layer}`;
  return m;
}

// Streets need depth layering because their independently draped triangles can cross.
// People/cars must use that same depth frame, or asphalt draws over correctly grounded
// soles and tread. Match the highest street layer (markings), without moving geometry,
// changing shadows, or increasing the bias beyond the existing ground convention.
const contactMaterials = new WeakSet();
export function contactMaterial(m) {
  // Material.clone copies userData but not shader callbacks, so track instances.
  if (!contactMaterials.has(m)) { layered(m, 5); contactMaterials.add(m); }
  return m;
}

export function makeMaterials(renderer) {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const shared = (m, scale = 1, extra = {}) => { Object.assign(m.userData, { shared: true, scale }, extra); return m; };
  // scale: meters covered by one repeat of the texture.
  const textured = (name, scale, { roughness = 0.9, normal = 0.8 } = {}) => shared(new THREE.MeshStandardMaterial({
    map: texture(name, 'color', aniso),
    normalMap: texture(name, 'normal', aniso),
    normalScale: new THREE.Vector2(normal, normal),
    vertexColors: true, roughness, metalness: 0, envMapIntensity: 0.5,
  }), scale);

  const materials = {
    // ground layers, lowest first (see layered())
    ground: textured('grass', 4, { roughness: 1, normal: 0.6 }),
    grass: layered(textured('grass', 4, { roughness: 1, normal: 0.6 }), 1),
    pathGravel: layered(textured('gravel', 3, { roughness: 1 }), 2),
    lot: layered(textured('asphalt_light', 7, { roughness: 0.95 }), 2),
    paving: layered(textured('paving', 3, { roughness: 0.9 }), 2),
    road: layered(textured('asphalt', 7, { roughness: 0.95 }), 3),
    sidewalk: layered(textured('sidewalk', 4.5, { roughness: 0.9 }), 4),
    // flat roofs
    gravel: textured('gravel', 3, { roughness: 1 }),
    // walls
    stucco: textured('stucco', 2.5, { normal: 0.5 }),
    siding: textured('siding', 1.4, { normal: 1 }),
    brick: textured('brick', 1.2, { normal: 1 }),
    brick_light: textured('brick_light', 1.3, { normal: 1 }),
    concrete: textured('concrete', 3, { normal: 0.5 }),
    metal: textured('metal', 3, { roughness: 0.6, normal: 1 }),
    // roofs
    shingles: textured('shingles', 1.6, { normal: 1 }),
    clay_tiles: textured('clay_tiles', 1.4, { normal: 1 }),
    // untextured
    plain: shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, envMapIntensity: 0.5 })),
    paint: layered(shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, envMapIntensity: 0.4 }), 1, { noShadow: true }), 5),
    glass: shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.2, envMapIntensity: 1.4 })),
    water: layered(shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.1, envMapIntensity: 1.2 })), 1),
  };
  // Animate reflections with tiny normal ripples; the shoreline and collision surface stay put.
  const water = materials.water, layer = water.onBeforeCompile;
  water.userData.waveTime = { value: 0 };
  water.userData.waveStrength = { value: 0.045 };
  water.onBeforeCompile = (sh) => {
    layer(sh);
    sh.uniforms.waveTime = water.userData.waveTime;
    sh.uniforms.waveStrength = water.userData.waveStrength;
    sh.vertexShader = 'varying vec2 vWaterXZ;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = 'uniform float waveTime, waveStrength;\nvarying vec2 vWaterXZ;\n' + sh.fragmentShader;
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
      vec2 ripple = vec2(cos(vWaterXZ.x * 1.7 + vWaterXZ.y * 0.6 + waveTime * 1.2),
        sin(vWaterXZ.y * 2.1 - vWaterXZ.x * 0.4 - waveTime * 0.9));
      normal = normalize(normal + mat3(viewMatrix) * vec3(ripple.x, 0.0, ripple.y) * waveStrength);`);
  };
  water.customProgramCacheKey = () => 'ground-layer-1-water-ripples';
  return materials;
}
