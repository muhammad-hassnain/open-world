// Ground elevation from AWS Terrain Tiles (Terrarium encoding; free, no key, global).
// Sources include USGS 3DEP in the US (~3-10 m) and SRTM elsewhere (~30 m). Heights are
// returned in meters relative to the walk-in point, so the origin stays near y = 0.

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
export const TERRAIN_ZOOM = 15;
const SIZE = 256;

export class Terrain {
  constructor(frame) {
    this.frame = frame;
    this.tiles = new Map();   // x * 65536 + y (z15) -> Float32Array(256*256) of raw meters, or null if missing
    this.pending = new Map();
    this.base = 0;
    this.n = 2 ** TERRAIN_ZOOM;
  }

  // Load the four z15 tiles under a z14 data tile.
  ensure(tx14, ty14) {
    return Promise.all([0, 1].flatMap((dx) => [0, 1].map((dy) => this._load(tx14 * 2 + dx, ty14 * 2 + dy))));
  }

  _load(x, y) {
    const key = x * 65536 + y;
    if (this.tiles.has(key)) return Promise.resolve();
    if (!this.pending.has(key)) {
      this.pending.set(key, (async () => {
        try {
          const res = await fetch(`${TILE_URL}/${TERRAIN_ZOOM}/${x}/${y}.png`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
          const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SIZE, SIZE) : Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
          const ctx = cv.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(bmp, 0, 0);
          const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
          const h = new Float32Array(SIZE * SIZE);
          for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
          this.tiles.set(key, h);
        } catch (e) {
          console.warn(`[terrain] ${x}/${y} unavailable, treating as flat`, e);
          this.tiles.set(key, null);
        }
      })());
    }
    return this.pending.get(key);
  }

  // Raw elevation of global z15 pixel (i, j), or NaN if its tile isn't loaded.
  // Called for every ground vertex, so it avoids allocations and caches the last tile.
  _px(i, j) {
    const tx = i >> 8, ty = j >> 8;
    let t = this._lt;
    if (tx !== this._ltx || ty !== this._lty || !t) {
      t = this.tiles.get(tx * 65536 + ty);
      this._lt = t; this._ltx = tx; this._lty = ty;
    }
    return t ? t[((j & 255) << 8) | (i & 255)] : NaN;
  }

  // Raw elevation (meters above sea level) at local coordinates, bilinear between pixel centers.
  raw(x, z) {
    const f = this.frame, k = (this.n * SIZE) / f.scale;
    const gx = f.mx0 * this.n * SIZE - 0.5 + x * k;
    const gy = f.my0 * this.n * SIZE - 0.5 + z * k;
    const i = Math.floor(gx), j = Math.floor(gy), u = gx - i, v = gy - j;
    const a = this._px(i, j), b = this._px(i + 1, j), c = this._px(i, j + 1), d = this._px(i + 1, j + 1);
    if (a === a && b === b && c === c && d === d) return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    // Some neighbors not loaded: weight only the known ones.
    let sum = 0, wsum = 0;
    const add = (s, w) => { if (s === s) { sum += s * w; wsum += w; } };
    add(a, (1 - u) * (1 - v)); add(b, u * (1 - v)); add(c, (1 - u) * v); add(d, u * v);
    return wsum > 1e-6 ? sum / wsum : this.base;
  }

  setBaseAt(x, z) { this.base = this.raw(x, z); }

  // Height relative to the walk-in point.
  at(x, z) { return this.raw(x, z) - this.base; }

  // Water surfaces: never below sea level (the tiles include sea-floor depths).
  water(x, z) { return Math.max(this.raw(x, z), 0) - this.base; }

  get seaLevel() { return -this.base; }
}
