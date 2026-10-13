// The player's name and look, kept on this device.
import { LOOKS } from './character.js';

const KEY = 'openworld.profile';
export const NAME_MAX = 20;

// Printable, single-spaced, at most NAME_MAX characters.
export function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

// -> { name, look, saved } (saved: false until the player has chosen once).
export function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY));
    if (p && typeof p.name === 'string') return { name: cleanName(p.name), look: LOOKS[p.look] ? p.look : 'man', saved: true };
  } catch { /* storage unavailable or invalid */ }
  return { name: '', look: 'man', saved: false };
}

export function saveProfile(p) {
  p.name = cleanName(p.name) || `Walker ${Math.floor(100 + Math.random() * 900)}`;
  p.saved = true;
  try { localStorage.setItem(KEY, JSON.stringify({ name: p.name, look: p.look })); } catch { /* storage unavailable */ }
  return p;
}
