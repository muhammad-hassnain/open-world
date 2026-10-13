// Geographic helpers: Web Mercator tiles and a local metric frame around an origin.
//
// The game works in meters relative to an origin point (the place you walked in):
// +x east, +z south, +y up. Positions are derived from Web Mercator, scaled by
// cos(origin latitude), which is accurate to ~1% within a few kilometers.

export const EARTH_CIRCUMFERENCE = 40075016.686;
export const DATA_ZOOM = 14;   // zoom of the source tiles (OpenFreeMap max)
export const CHUNK_ZOOM = 16;  // zoom of the build/stream chunks (~300-600 m wide)

const clampLat = (lat) => Math.max(-85.05112878, Math.min(85.05112878, lat));

// Normalized Web Mercator: x, y in [0, 1], y grows southward.
export function toMerc(lat, lon) {
  const s = Math.sin((clampLat(lat) * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

export function fromMerc(mx, my) {
  const lon = mx * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
  return [lat, lon];
}

export function tileOf(lat, lon, z) {
  const [mx, my] = toMerc(lat, lon);
  const n = 2 ** z;
  return { z, x: Math.floor(mx * n), y: Math.floor(my * n) };
}

export const tileKey = (z, x, y) => `${z}/${x}/${y}`;

export class Frame {
  constructor(lat, lon) {
    this.lat = lat;
    this.lon = lon;
    [this.mx0, this.my0] = toMerc(lat, lon);
    this.scale = EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180); // meters per merc unit
  }

  toLocal(lat, lon) {
    const [mx, my] = toMerc(lat, lon);
    return [(mx - this.mx0) * this.scale, (my - this.my0) * this.scale];
  }

  toLatLon(x, z) {
    return fromMerc(this.mx0 + x / this.scale, this.my0 + z / this.scale);
  }

  // Tile-local coordinates (0..extent) of tile z/x/y -> local meters.
  tileProjector(z, x, y, extent) {
    const n = 2 ** z;
    const k = this.scale / (n * extent);
    const ox = (x / n - this.mx0) * this.scale, oz = (y / n - this.my0) * this.scale;
    return (px, py) => [ox + px * k, oz + py * k];
  }

  tileRect(z, x, y) {
    const n = 2 ** z;
    return {
      minX: (x / n - this.mx0) * this.scale, maxX: ((x + 1) / n - this.mx0) * this.scale,
      minZ: (y / n - this.my0) * this.scale, maxZ: ((y + 1) / n - this.my0) * this.scale,
    };
  }

  tileAt(x, z, zoom) {
    const n = 2 ** zoom;
    return { z: zoom, x: Math.floor((this.mx0 + x / this.scale) * n), y: Math.floor((this.my0 + z / this.scale) * n) };
  }
}

export function distToRect(x, z, r) {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}
