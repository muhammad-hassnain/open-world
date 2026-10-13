// Photos of named places from Wikimedia. Finds the Wikidata item near the place whose name (in
// any language) matches, then its main image (P18) and a few more from its Commons category
// (P373), each with author and license for the credit. Results are cached per place.
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const HEADERS = { 'Api-User-Agent': 'OpenWorld/1.0 (https://github.com/muhammad-hassnain/open-world)' };
const RADIUS = 300;   // meters around the place to look for its Wikidata item
const MAX = 8;        // photos per place
const WIDTH = 640;    // thumbnail width; the viewer swaps in 1280

const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const text = (html) => (html ? new DOMParser().parseFromString(html, 'text/html').body.textContent.trim() : '');

async function api(base, params) {
  const q = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
  const res = await fetch(`${base}?${q}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const cache = new Map();

// -> Promise<{ photos: [{ title, thumb, large, page, author, license, licenseUrl }], more }>,
// with photos empty when nothing matches.
export function placePhotos(name, lat, lon) {
  const key = `${name}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
  if (!cache.has(key)) cache.set(key, find(name, lat, lon).catch(() => ({ photos: [], more: null })));
  return cache.get(key);
}

async function find(name, lat, lon) {
  const none = { photos: [], more: null };
  const n = norm(name);
  if (n.length < 3) return none;

  // Candidates: items with an image near the place, ranked by text match.
  const words = name.replace(/["'\-!~*?:\\()[\]{}]/g, ' ').trim();
  const s = await api(WIKIDATA, {
    action: 'query', list: 'search', srlimit: 8,
    srsearch: `${words} nearcoord:${RADIUS}m,${lat.toFixed(5)},${lon.toFixed(5)} haswbstatement:P18`,
  });
  const ids = (s.query?.search || []).map((r) => r.title);
  if (!ids.length) return none;

  // Keep the first whose label or alias, in any language, is the place's name.
  const e = await api(WIKIDATA, { action: 'wbgetentities', ids: ids.join('|'), props: 'labels|aliases' });
  const names = (it) => [...Object.values(it.labels || {}), ...Object.values(it.aliases || {}).flat()];
  const id = ids.find((q) => e.entities?.[q] && names(e.entities[q]).some((l) => norm(l.value) === n));
  if (!id) return none;

  const c = await api(WIKIDATA, { action: 'wbgetentities', ids: id, props: 'claims' });
  const claims = c.entities?.[id]?.claims || {};
  const value = (p) => claims[p]?.[0]?.mainsnak?.datavalue?.value;
  const main = value('P18'), cat = value('P373');

  const info = { prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: WIDTH,
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl' };
  const reqs = [];
  if (main) reqs.push(api(COMMONS, { action: 'query', titles: `File:${main}`, ...info }));
  if (cat) reqs.push(api(COMMONS, { action: 'query', generator: 'categorymembers', gcmtitle: `Category:${cat}`,
    gcmtype: 'file', gcmlimit: 20, ...info }));
  const pages = (await Promise.all(reqs.map((r) => r.catch(() => null)))).flatMap((r) => r?.query?.pages || []);

  const photos = [], seen = new Set();
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii || seen.has(p.title) || !/^image\/(jpeg|png|webp)$/.test(ii.mime) || !ii.thumburl) continue;
    seen.add(p.title);
    const m = ii.extmetadata || {};
    photos.push({
      title: p.title.replace(/^File:/, '').replace(/\.\w+$/, ''),
      thumb: ii.thumburl,
      large: ii.thumburl.replace(`/${WIDTH}px-`, '/1280px-'),
      page: ii.descriptionurl,
      author: text(m.Artist?.value) || 'Unknown author',
      license: text(m.LicenseShortName?.value) || 'see file page',
      licenseUrl: m.LicenseUrl?.value || null,
    });
    if (photos.length >= MAX) break;
  }
  return { photos, more: cat ? `https://commons.wikimedia.org/wiki/Category:${encodeURIComponent(cat.replace(/ /g, '_'))}` : null };
}
