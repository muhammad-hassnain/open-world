// The globe/map view: MapLibre GL (loaded as a global script) with OpenFreeMap's free style,
// plus place search and reverse geocoding via Nominatim.

const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
// Shapes and orders right-to-left scripts (Arabic, Urdu, Persian, Hebrew) in map labels.
const RTL_PLUGIN = 'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/dist/mapbox-gl-rtl-text.js';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
export const WALK_ZOOM = 15; // minimum map zoom for "Walk here"

export class Globe {
  constructor(container, { lat, lon, zoom = 1.6 }) {
    this.container = container;
    const gl = window.maplibregl;
    if (gl.getRTLTextPluginStatus() === 'unavailable') gl.setRTLTextPlugin(RTL_PLUGIN, true).catch((e) => console.warn('RTL text plugin failed', e));
    this.map = new window.maplibregl.Map({
      container,
      style: STYLE,
      center: [lon, lat],
      zoom,
      maxPitch: 70,
      attributionControl: { compact: true },
    });
    this.map.on('style.load', () => this.map.setProjection({ type: 'globe' }));
    // The free style references a few icons its sprite lacks; fill them with a blank image.
    this.map.on('styleimagemissing', (e) => {
      if (!this.map.hasImage(e.id)) this.map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    this.map.addControl(new window.maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    this.ready = new Promise((r) => this.map.once('load', r));
  }

  show() {
    this.container.classList.remove('hidden');
    this.map.resize();
  }

  hide() { this.container.classList.add('hidden'); }

  get view() {
    const c = this.map.getCenter();
    return { lat: c.lat, lon: c.lng, zoom: this.map.getZoom(), bearing: this.map.getBearing() };
  }

  jumpTo({ lat, lon, zoom, bearing = 0, pitch = 0 }) {
    this.map.jumpTo({ center: [lon, lat], zoom, bearing, pitch });
  }

  flyTo({ lat, lon, zoom, bearing = 0, pitch = 0, duration }) {
    this.map.flyTo({ center: [lon, lat], zoom, bearing, pitch, duration, essential: true });
  }

  fitBounds([south, north, west, east]) {
    this.map.fitBounds([[west, south], [east, north]], { padding: 60, maxZoom: 17, essential: true });
  }

  // Frame a search result on its point (for a city, its center). Bounding boxes can include
  // far-off parts, like San Francisco's Farallon Islands or France's overseas regions, so the
  // box is made symmetric around the point using the nearer edge on each axis, and neither axis
  // may span more than 3x the other.
  showPlace({ lat, lon, bbox: [s, n, w, e] }) {
    if (n - s < 0.01 && e - w < 0.01) return this.flyTo({ lat, lon, zoom: 17, duration: 3000 });
    const k = Math.cos(lat * Math.PI / 180);
    const a = Math.max(0.002, Math.min(lat - s, n - lat));      // half height, degrees of latitude
    const b = Math.max(0.002, Math.min(lon - w, e - lon) * k);  // half width, same units
    const dLat = Math.min(a, 3 * b), dLon = Math.min(b, 3 * a) / k;
    this.fitBounds([lat - dLat, lat + dLat, lon - dLon, lon + dLon]);
  }

  // The navigation route as a line of [lon, lat] (null removes it).
  setRoute(line) {
    const map = this.map;
    const data = { type: 'Feature', geometry: { type: 'LineString', coordinates: line || [] }, properties: {} };
    const apply = () => {
      if (map.getSource('route')) map.getSource('route').setData(data);
      else {
        map.addSource('route', { type: 'geojson', data });
        map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#3d8bfd', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 16, 9], 'line-opacity': 0.9 } });
      }
    };
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);
  }

  on(event, fn) { this.map.on(event, fn); }
}

export async function searchPlaces(q) {
  const url = `${NOMINATIM}/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
  return (await res.json()).map((r) => ({
    name: r.display_name, lat: +r.lat, lon: +r.lon, bbox: r.boundingbox.map(Number), type: r.type,
  }));
}

// "Neighbourhood, City" (or the closest available) for the HUD.
export async function placeName(lat, lon) {
  const url = `${NOMINATIM}/reverse?format=jsonv2&zoom=16&lat=${lat}&lon=${lon}`;
  const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) return null;
  const a = (await res.json()).address || {};
  const local = a.neighbourhood || a.quarter || a.suburb || a.city_district;
  const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.county;
  return [local, city].filter(Boolean).join(', ') || a.country || null;
}
