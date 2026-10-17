// Ground elevation from AWS Terrain Tiles (Terrarium encoding; free, no key, global).
// Sources include USGS 3DEP in the US (~3-10 m) and SRTM elsewhere (~30 m). Heights are
// returned in meters relative to the walk-in point, so the origin stays near y = 0.

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
export const TERRAIN_ZOOM = 15;
const SIZE = 256;

export class Terrain {
  // zoom: tile zoom (15 for the streets; far.js uses a coarser one for distant land).
  constructor(frame, { zoom = TERRAIN_ZOOM } = {}) {
    this.frame = frame;
    this.zoom = zoom;
    this.tiles = new Map();   // x * 65536 + y -> Float32Array(256*256) of raw meters, or null if missing
    this.pending = new Map();
    this.base = 0;
    this.n = 2 ** zoom;
  }

  // Load one tile at this terrain's zoom.
  ensureTile(x, y) { return this._load(x, y); }

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
          const res = await fetch(`${TILE_URL}/${this.zoom}/${x}/${y}.png`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          const { data, bpp } = await decodePNG(buf).catch(() => decodeWithCanvas(buf));
          const h = new Float32Array(SIZE * SIZE);
          for (let i = 0; i < h.length; i++) h[i] = data[i * bpp] * 256 + data[i * bpp + 1] + data[i * bpp + 2] / 256 - 32768;
          despike(h);
          this.tiles.set(key, h);
        } catch (e) {
          console.warn(`[terrain] ${x}/${y} unavailable, treating as flat`, e);
          this.tiles.set(key, null);
        }
      })().finally(() => this.pending.delete(key)));
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

  // Geometry retains its sampled heights; only nearby raw tiles need to stay in
  // memory. A one-tile margin keeps bilinear samples across retained edges intact.
  prune(x, z, radius) {
    const a = this.frame.tileAt(x - radius, z - radius, this.zoom);
    const b = this.frame.tileAt(x + radius, z + radius, this.zoom);
    for (const key of this.tiles.keys()) {
      const tx = Math.floor(key / 65536), ty = key % 65536;
      if (tx < a.x - 1 || tx > b.x + 1 || ty < a.y - 1 || ty > b.y + 1) this.tiles.delete(key);
    }
    this._lt = null;
  }

  // Water surfaces: never below sea level (the tiles include sea-floor depths).
  water(x, z) { return Math.max(this.raw(x, z), 0) - this.base; }

  get seaLevel() { return -this.base; }
}

// Elevation is packed into the color channels (red alone is worth 256 m per step), so the bytes
// must come through exactly. Browsers may color-manage images drawn to a canvas (seen on
// wide-gamut Mac screens), which turns single pixels into spikes hundreds of meters tall, so
// PNGs are decoded here. Handles 8-bit RGB/RGBA, non-interlaced: what Terrain Tiles serves.
async function decodePNG(buf) {
  const d = new DataView(buf), idat = [];
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  for (let p = 8; p + 8 <= buf.byteLength;) {
    const len = d.getUint32(p), t = d.getUint32(p + 4);
    if (t === 0x49484452) { w = d.getUint32(p + 8); h = d.getUint32(p + 12); depth = d.getUint8(p + 16); type = d.getUint8(p + 17); interlace = d.getUint8(p + 20); }
    else if (t === 0x49444154) idat.push(new Uint8Array(buf, p + 8, len));
    else if (t === 0x49454e44) break;
    p += 12 + len;
  }
  if (w !== SIZE || h !== SIZE || depth !== 8 || interlace || (type !== 2 && type !== 6)) throw new Error('unsupported PNG');
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, out = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[row + i - bpp] : 0, b = y ? out[row - stride + i] : 0, c = i >= bpp && y ? out[row - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[row + i] = v & 255;
    }
  }
  return { data: out, bpp };
}

async function decodeWithCanvas(buf) {
  const bmp = await createImageBitmap(new Blob([buf]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SIZE, SIZE) : Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return { data: ctx.getImageData(0, 0, SIZE, SIZE).data, bpp: 4 };
}

// Replace lone pixels far off from neighbors that agree with each other (bad data, not cliffs).
function despike(h) {
  const n = [0, 0, 0, 0];
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const i = y * SIZE + x;
      n[0] = h[i - 1]; n[1] = h[i + 1]; n[2] = h[i - SIZE]; n[3] = h[i + SIZE];
      n.sort((a, b) => a - b);
      const med = (n[1] + n[2]) / 2;
      if (Math.abs(h[i] - med) > 150 && n[3] - n[0] < 100) h[i] = med;
    }
  }
}
