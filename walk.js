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
    // Turn-by-turn in short sentences ("Turn left onto Station Rd"), for Start journey
    steps: walkSteps(route),
  };
}

// OSRM's steps as short sentences. The names come from OpenStreetMap; a step without a street
// name says what to do without one. Arriving is left out (the page says where you're going).
const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export function walkSteps(route) {
  const out = [];
  for (const leg of route?.legs ?? []) {
    for (const st of leg.steps ?? []) {
      const m = st.maneuver ?? {};
      const name = st.name ? ` ${m.type === 'depart' ? 'on' : 'onto'} ${st.name}` : '';
      const metres = Math.round((st.distance ?? 0) / 10) * 10;
      let text;
      if (m.type === 'arrive') continue;
      if (m.type === 'depart') text = `Head ${DIRS[Math.round(((m.bearing_after ?? 0) % 360) / 45) % 8]}${name}`;
      else if (m.modifier === 'straight' || m.type === 'continue' || m.type === 'new name') text = `Keep going${name}`;
      else if (m.modifier && /left|right/.test(m.modifier)) {
        const side = m.modifier.includes('left') ? 'left' : 'right';
        text = `${m.modifier.startsWith('slight') ? 'Bear' : m.modifier.startsWith('sharp') ? 'Turn sharp' : m.modifier === 'uturn' ? 'Turn around' : 'Turn'} ${side}${name}`;
      } else if (m.modifier === 'uturn') text = `Turn around${name}`;
      else text = `Keep going${name}`;
      // The same instruction twice in a row (OSRM splits a street into parts): one line
      if (out.length && out[out.length - 1].text === text) { out[out.length - 1].metres += metres; continue; }
      out.push({ text, metres });
    }
  }
  return out.map((s) => (s.metres >= 20 ? `${s.text} for ${s.metres} m` : s.text));
}

export async function walkRoute(a, b, { fetchImpl = fetch, distanceM, mode = 'walk' } = {}) {
  if (distanceM && distanceM(a.lat, a.lng, b.lat, b.lng) > MAX_M[mode]) return null;
  const key = `${mode}:${walkKey(a, b)}`;
  if (cache.has(key)) return cache.get(key);
  const url = `${ROUTERS[mode]}/${round(a.lng)},${round(a.lat)};${round(b.lng)},${round(b.lat)}?overview=full&geometries=geojson&steps=true`;
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

// A bus ride whose route track doesn't fit (a different variant): ask the car router for the road
// through its stops instead. At most 25 points (the router's limit is higher, but this is plenty
// to keep it on the right roads). Same cache and rules as walks.
export async function roadPath(points, { fetchImpl = fetch } = {}) {
  if (points.length < 2) return null;
  const step = Math.max(1, Math.ceil(points.length / 24));
  const via = points.filter((_, i) => i % step === 0);
  if (via[via.length - 1] !== points[points.length - 1]) via.push(points[points.length - 1]);
  const key = `road:${via.map(([lat, lng]) => `${round(lat)},${round(lng)}`).join(';')}`;
  if (cache.has(key)) return cache.get(key);
  const url = `${ROUTERS.car}/${via.map(([lat, lng]) => `${round(lng)},${round(lat)}`).join(';')}?overview=full&geometries=geojson`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'RailwayLive/1.0 (+https://github.com/vy-trg/railway-live)' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Road router ${res.status}`);
  const route = parseRoute(await res.json(), 'car');
  const result = route ? route.points : null;
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}
