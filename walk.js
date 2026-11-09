// Walking directions along real streets and paths, for the walks in a planned journey.
// Uses the free OSRM foot router run by FOSSGIS on OpenStreetMap data (routing.openstreetmap.de).
// Their rules: light use, say who you are, cache. So: one request per walk, cached, max 2 km,
// and if it fails the page keeps the straight dotted line and says the walk is an estimate.
const ROUTERS = {
  walk: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving',
  car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
};
const MAX_M = { walk: 2000, bike: 4000, car: 12000 };
// Same speeds as the planner (planner.js ACCESS), so the times match
const SPEED_MPS = { walk: 4.5 / 3.6, bike: 15 / 3.6, car: 30 / 3.6 };
const cache = new Map(); // "lat,lng;lat,lng" rounded to ~10 m -> result
const CACHE_SIZE = 2000;

const round = (n) => Math.round(n * 10000) / 10000;
export const walkKey = (a, b) => `${round(a.lat)},${round(a.lng)};${round(b.lat)},${round(b.lng)}`;

// Pure: an OSRM response -> { points: [[lat, lng]...], metres, secs } or null
export function parseRoute(json, mode = 'walk') {
  const route = json?.code === 'Ok' ? json.routes?.[0] : null;
  const coords = route?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  return {
    points: coords.map(([lng, lat]) => [lat, lng]),
    metres: Math.round(route.distance),
    // OSRM's own speeds differ a little; use the planner's so the page doesn't contradict itself
    secs: Math.round(route.distance / SPEED_MPS[mode]),
  };
}

export async function walkRoute(a, b, { fetchImpl = fetch, distanceM, mode = 'walk' } = {}) {
  if (distanceM && distanceM(a.lat, a.lng, b.lat, b.lng) > MAX_M[mode]) return null;
  const key = `${mode}:${walkKey(a, b)}`;
  if (cache.has(key)) return cache.get(key);
  const url = `${ROUTERS[mode]}/${round(a.lng)},${round(a.lat)};${round(b.lng)},${round(b.lat)}?overview=full&geometries=geojson`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'RailwayLive/1.0 (+https://github.com/vy-trg/railway-live)' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Walking router ${res.status}`);
  const result = parseRoute(await res.json(), mode);
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}
