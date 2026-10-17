import * as THREE from 'three';

// Weld only byte-identical vertices: UV seams, sharp normals and color boundaries
// stay intact. The builders emit triangle soup; an index lets the GPU reuse vertices
// and reduces both CPU arrays and GPU buffers without changing any surface position.
export async function indexGeometry(geometry, budget) {
  if (geometry.index || geometry.groups.length) return;
  const attributes = Object.values(geometry.attributes), count = geometry.attributes.position.count;
  if (count < 96 || attributes.some(a => a.isInterleavedBufferAttribute || a.count !== count)) return;
  const views = attributes.map(a => a.array instanceof Float32Array
    ? new Uint32Array(a.array.buffer, a.array.byteOffset, a.array.length) : a.array);
  let capacity = 1;
  while (capacity < count * 2) capacity *= 2;
  const table = new Uint32Array(capacity), source = new Uint32Array(count), indices = new Uint32Array(count);
  const mask = capacity - 1;
  let unique = 0;
  for (let i = 0; i < count; i++) {
    if (i % 2048 === 0 && budget) await budget.tick();
    let hash = 2166136261;
    for (let a = 0; a < attributes.length; a++) {
      const size = attributes[a].itemSize, values = views[a], offset = i * size;
      for (let k = 0; k < size; k++) hash = Math.imul(hash ^ values[offset + k], 16777619);
    }
    let slot = (hash ^ (hash >>> 16)) & mask;
    for (;;) {
      const entry = table[slot];
      if (!entry) {
        source[unique] = i; table[slot] = unique + 1; indices[i] = unique++; break;
      }
      const other = source[entry - 1];
      let same = true;
      for (let a = 0; a < attributes.length && same; a++) {
        const size = attributes[a].itemSize, values = views[a];
        for (let k = 0; k < size; k++) if (values[i * size + k] !== values[other * size + k]) { same = false; break; }
      }
      if (same) { indices[i] = entry - 1; break; }
      slot = (slot + 1) & mask;
    }
  }
  const stride = attributes.reduce((sum, a) => sum + a.itemSize * a.array.BYTES_PER_ELEMENT, 0);
  const Index = unique <= 65535 ? Uint16Array : Uint32Array;
  if (unique * stride + count * Index.BYTES_PER_ELEMENT >= count * stride) return;
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const size = attribute.itemSize, array = new attribute.array.constructor(unique * size);
    for (let i = 0; i < unique; i++) {
      if (i % 4096 === 0 && budget) await budget.tick();
      for (let k = 0; k < size; k++) array[i * size + k] = attribute.array[source[i] * size + k];
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(array, size, attribute.normalized));
  }
  geometry.setIndex(new THREE.BufferAttribute(new Index(indices), 1));
}
