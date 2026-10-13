// Speed limits by road class and the speed units to show. The US and the UK sign limits in mph,
// elsewhere in km/h; OpenStreetMap's maxspeed isn't in our data, so limits are typical values
// for the road class there.
import { aerialCovers } from './aerial.js';

const MPH = { motorway: 65, motorway_link: 45, trunk: 55, trunk_link: 40, primary: 45, primary_link: 35,
  secondary: 40, secondary_link: 30, tertiary: 35, tertiary_link: 25, residential: 25, unclassified: 25,
  living_street: 15, service: 15 };
const KMH = { motorway: 120, motorway_link: 80, trunk: 100, trunk_link: 60, primary: 60, primary_link: 50,
  secondary: 50, secondary_link: 40, tertiary: 50, tertiary_link: 40, residential: 30, unclassified: 40,
  living_street: 20, service: 20 };
export const MPH_PER_MS = 2.23694, KMH_PER_MS = 3.6;

const UK = [49.8, -8.7, 60.9, 1.8];
// Does this place sign speeds in mph?
export function milesHere(lat, lon) {
  return aerialCovers(lat, lon) || (lat >= UK[0] && lat <= UK[2] && lon >= UK[1] && lon <= UK[3]);
}

// The limit on a road: { value, unit: 'mph' | 'km/h', ms } (ms: meters per second).
export function speedLimit(road, miles) {
  const t = road && road.t;
  if (miles) { const v = MPH[t] || 25; return { value: v, unit: 'mph', ms: v / MPH_PER_MS }; }
  const v = KMH[t] || 40;
  return { value: v, unit: 'km/h', ms: v / KMH_PER_MS };
}

// Road markings: center lines separating opposite directions are yellow in the Americas,
// Norway, Finland, China, South Korea and Taiwan, white elsewhere. Borders are coarse.
const CHINA = [[73.5, 39.5], [80, 42.5], [80.5, 45], [83, 47.2], [87.5, 49.2], [90.5, 47.8], [96, 42.8], [105, 41.6],
  [111.5, 43.5], [119.5, 47.2], [116, 49.8], [120, 52.8], [126, 52.8], [131, 47.8], [134.7, 48.3], [131, 42.8],
  [124.3, 40], [121, 39], [122, 37.5], [119.5, 35], [122, 31], [121.5, 28], [117.5, 23.6], [111, 21.3], [108, 21.5],
  [106.5, 22.4], [103.5, 22.6], [101.8, 21.2], [100, 21.5], [98.5, 24.1], [97.5, 27.8], [92, 27.8], [88.5, 28],
  [85, 28.4], [81, 30.2], [78.8, 32.5], [79.5, 35.5], [75, 37.5]];
function inPoly(lon, lat, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function yellowCenterLines(lat, lon) {
  if (lon < -30) return true;
  const norwayBorder = lat < 63 ? 12.3 : lat < 69 ? 12.3 + ((lat - 63) * 7.7) / 6 : 31;
  if (lat >= 57.9 && lat <= 71.5 && lon >= 4 && lon < norwayBorder) return true;
  if (lat >= 59.7 && lat <= 70.1 && lon <= 31.6 && lon >= (lat > 65.5 ? 24.1 : lat > 63.5 ? 22.5 : 21)) return true;
  if (lat >= 33 && lat <= 38.6 && lon >= 124.5 && lon <= 130.95) return true;   // South Korea
  if (lat >= 21.8 && lat <= 25.4 && lon >= 119.9 && lon <= 122.1) return true;  // Taiwan
  return inPoly(lon, lat, CHINA);
}
