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
    // ground
    road: textured('asphalt', 7, { roughness: 0.95 }),
    lot: textured('asphalt_light', 7, { roughness: 0.95 }),
    sidewalk: textured('sidewalk', 4.5, { roughness: 0.9 }),
    paving: textured('paving', 3, { roughness: 0.9 }),
    grass: textured('grass', 4, { roughness: 1, normal: 0.6 }),
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
    paint: shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, envMapIntensity: 0.4 }), 1, { noShadow: true }),
    glass: shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.2, envMapIntensity: 1.4 })),
    water: shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.1, envMapIntensity: 1.2 })),
  };
}
