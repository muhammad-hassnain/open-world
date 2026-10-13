// Shared materials. Textured ones use CC0 textures from assets/textures (see CREDITS.md);
// vertex colors tint them, so one stucco texture can be any paint color.
import * as THREE from 'three';

const loader = new THREE.TextureLoader();

function texture(name, kind, anisotropy) {
  const t = loader.load(`assets/textures/${name}_${kind}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  if (kind === 'color') t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Ground layers (ground, grass, roads, sidewalks, paint) all lie on the terrain and are cut into
// different triangles, so on hills they can cross each other by a few centimeters. Each layer is
// pulled slightly toward the camera along the view ray (same pixel, smaller depth) so higher
// layers always win. This works with the logarithmic depth buffer, unlike polygonOffset.
function layered(m, layer) {
  if (!layer) return m;
  const rel = (layer * 0.0004).toFixed(5), abs = (layer * 0.02).toFixed(3);
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      {
        float viewDist = length(mvPosition.xyz);
        mvPosition.xyz *= max(0.0, 1.0 - (${rel} + ${abs} / max(viewDist, 0.5)));
        gl_Position = projectionMatrix * mvPosition;
      }`);
  };
  m.customProgramCacheKey = () => `ground-layer-${layer}`;
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

  return {
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
}
