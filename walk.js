// Walking directions along real streets and paths, for the walks in a planned journey.
// Uses the free OSRM foot router run by FOSSGIS on OpenStreetMap data (routing.openstreetmap.de).
// Their rules: light use, say who you are, cache. So: one request per walk, cached, max 2 km,
// and if it fails the page keeps the straight dotted line and says the walk is an estimate.
const ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';
const MAX_WALK_M = 2000;
const cache = new Map(); // "lat,lng;lat,lng" rounded to ~10 m -> result
const CACHE_SIZE = 2000;

const round = (n) => Math.round(n * 10000) / 10000;
export const walkKey = (a, b) => `${round(a.lat)},${round(a.lng)};${round(b.lat)},${round(b.lng)}`;

// Pure: an OSRM response -> { points: [[lat, lng]...], metres, secs } or null
export function parseRoute(json) {
  const route = json?.code === 'Ok' ? json.routes?.[0] : null;
  const coords = route?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  return {
    points: coords.map(([lng, lat]) => [lat, lng]),
    metres: Math.round(route.distance),
    // OSRM's foot profile walks at about 5 km/h; use the same 4.5 km/h as the planner
    secs: Math.round(route.distance / (4.5 / 3.6)),
  };
}

export async function walkRoute(a, b, { fetchImpl = fetch, distanceM } = {}) {
  if (distanceM && distanceM(a.lat, a.lng, b.lat, b.lng) > MAX_WALK_M) return null;
  const key = walkKey(a, b);
  if (cache.has(key)) return cache.get(key);
  const url = `${ROUTER}/${round(a.lng)},${round(a.lat)};${round(b.lng)},${round(b.lat)}?overview=full&geometries=geojson`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'RailwayLive/1.0 (+https://github.com/vy-trg/railway-live)' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Walking router ${res.status}`);
  const result = parseRoute(await res.json());
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}
