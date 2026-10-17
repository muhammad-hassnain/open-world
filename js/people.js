// One deterministic appearance/behavior factory for the pooled street population.
// Templates are data: adding an occupation doesn't require another Character subclass.
import { rng, pick } from './util.js';

export const PERSON_TYPES = Object.freeze([
  { id: 'stroller', looks: ['man', 'woman', 'harper'], pace: [0.85, 1.15], pause: [3, 8] },
  { id: 'commuter', looks: ['jordan', 'harper', 'man'], pace: [1.25, 1.65], pause: [1, 3] },
  { id: 'walker', looks: ['woman', 'man', 'jordan'], pace: [1.05, 1.4], pause: [2, 5] },
  { id: 'jogger', looks: ['woman', 'man'], pace: [2.1, 2.65], pause: [0.6, 1.5] },
]);
const PALETTES = ['#738995', '#a47e69', '#70816b', '#93919d', '#b5a686', '#6d778f'];

export function personSpec(seed) {
  const R = rng(seed >>> 0), type = PERSON_TYPES[seed % PERSON_TYPES.length];
  return {
    type: type.id, look: pick(type.looks, R()), seed,
    heightScale: 0.94 + R() * 0.12, buildScale: 0.92 + R() * 0.16,
    tint: pick(PALETTES, R()), phase: R() * 30,
    pace: type.pace[0] + R() * (type.pace[1] - type.pace[0]),
    pause: type.pause[0] + R() * (type.pause[1] - type.pause[0]),
  };
}
