// Roof colors from aerial photos. In the United States, USGS/USDA orthoimagery (public domain,
// about 1 m per pixel) is sampled under each building footprint; other countries keep the
// generated roof colors for now.

const EXPORT = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export';
const SIZE = 1024;          // pixels per z14 tile (~1.5-2.4 m per pixel; enough for a roof average)
const TIMEOUT_MS = 10000;
const R = 6378137;

// Rough boxes for the conterminous US, Alaska and Hawaii (the imagery is blank elsewhere).
const COVERAGE = [
  [24.3, -125.0, 49.5, -66.8], [51.0, -170.0, 71.5, -129.9], [18.8, -160.5, 22.4, -154.7],
];

export function aerialCovers(lat, lon) {
  return COVERAGE.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);
}

// Fetch the imagery for z/x/y as raw RGBA pixels, or null if unavailable.
export async function fetchAerial(z, x, y) {
  const n = 2 ** z, C = 2 * Math.PI * R;
  const minX = (x / n) * C - C / 2, maxX = ((x + 1) / n) * C - C / 2;
  const maxY = C / 2 - (y / n) * C, minY = C / 2 - ((y + 1) / n) * C;
  const url = `${EXPORT}?bbox=${minX},${minY},${maxX},${maxY}&bboxSR=3857&imageSR=3857&size=${SIZE},${SIZE}&format=jpg&f=image`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const result = { w: bmp.width, h: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
    bmp.close();
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function inRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

// Sets b.rc = [r, g, b] (sRGB 0-255) on buildings whose roof is visible in the image.
// `rect` is the image's extent in local meters.
export function sampleRoofs(img, buildings, rect) {
  const sx = img.w / (rect.maxX - rect.minX), sz = img.h / (rect.maxZ - rect.minZ);
  let blank = 0, total = 0;
  for (const b of buildings) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of b.o) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    const step = Math.max(0.6, Math.min(maxX - minX, maxZ - minZ) / 10);
    const rs = [], gs = [], bs = [];
    let n = 0;
    for (let x = minX + step / 2; x < maxX; x += step) {
      for (let z = minZ + step / 2; z < maxZ; z += step) {
        if (!inRing(x, z, b.o)) continue;
        const px = Math.floor((x - rect.minX) * sx), pz = Math.floor((z - rect.minZ) * sz);
        if (px < 0 || pz < 0 || px >= img.w || pz >= img.h) continue;
        const i = (pz * img.w + px) * 4;
        const r = img.data[i], g = img.data[i + 1], bl = img.data[i + 2];
        n++; total++;
        if (r + g + bl < 12) { blank++; continue; }                 // no imagery here
        if (r + g + bl < 110) continue;                             // deep shadow
        if (g > r * 1.06 && g > bl * 1.04 && g - Math.min(r, bl) > 10) continue; // tree canopy
        rs.push(r); gs.push(g); bs.push(bl);
      }
    }
    if (n === 0 || rs.length < Math.max(3, n * 0.3)) continue;
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    b.rc = [med(rs), med(gs), med(bs)];
  }
  return total ? blank / total : 1;
}
