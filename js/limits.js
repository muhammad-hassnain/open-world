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
