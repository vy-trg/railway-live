// Load TransLink's SEQ GTFS schedule (trains, buses, tram, ferries) into Postgres.
// Usage: DATABASE_URL=... node scripts/load-gtfs.js path/to/unzipped/SEQ_GTFS
//
// Routes with a route_type in ROUTE_TYPES are kept; trips and stops follow from those routes.
// Stop times are stored as trip patterns (see db/schema.sql).
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { pool } from '../db/pool.js';
import { parseGtfsTime, parseGtfsDate } from '../schedule.js';
import { simplify } from '../geo.js';
import { buildPatterns } from '../patterns.js';

// GTFS route_type -> our mode. These are every route_type in SEQ_GTFS, so nothing is left out.
const ROUTE_TYPES = new Map([['2', 'train'], ['3', 'bus'], ['0', 'tram'], ['4', 'ferry']]);
const BATCH = 2000;

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'routes.txt'))) {
  console.error('Usage: node scripts/load-gtfs.js <folder with routes.txt, trips.txt, ...>');
  process.exit(1);
}

// Read a GTFS file row by row as objects keyed by the header
async function* rows(file) {
  const parser = fs.createReadStream(path.join(dir, file)).pipe(parse({ columns: true, bom: true }));
  for await (const row of parser) yield row;
}

// Insert many rows at once: one INSERT per batch using UNNEST of column arrays
async function insertMany(client, table, columns, types, list) {
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const arrays = columns.map((_, c) => chunk.map((r) => r[c]));
    const params = types.map((t, c) => `$${c + 1}::${t}[]`).join(', ');
    await client.query(`INSERT INTO ${table} (${columns.join(', ')}) SELECT * FROM UNNEST(${params})`, arrays);
  }
  console.log(`  ${table}: ${list.length} rows`);
}

const client = await pool.connect();
try {
  await client.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await client.query('BEGIN');
  await client.query('TRUNCATE route_shapes, pattern_stops, trips, stops, stations, routes, calendar, calendar_dates CASCADE');

  const routes = [];
  for await (const r of rows('routes.txt')) {
    if (ROUTE_TYPES.has(r.route_type)) {
      routes.push([r.route_id, r.route_short_name, r.route_long_name, r.route_color || '888888', r.route_text_color || 'FFFFFF', ROUTE_TYPES.get(r.route_type)]);
    }
  }
  const routeIds = new Set(routes.map((r) => r[0]));

  const trips = [];
  const serviceIds = new Set();
  const shapeRoute = new Map(); // shape_id -> route_id
  for await (const t of rows('trips.txt')) {
    if (!routeIds.has(t.route_id)) continue;
    if (t.shape_id) shapeRoute.set(t.shape_id, t.route_id);
    trips.push([t.trip_id, t.route_id, t.service_id, t.trip_headsign, t.direction_id === '' ? null : Number(t.direction_id)]);
    serviceIds.add(t.service_id);
  }
  const tripIds = new Set(trips.map((t) => t[0]));

  // Stop times grouped by trip, kept compact: [stop_sequence, stop_id, arrival, departure]
  const byTrip = new Map();
  const usedStops = new Set();
  let stopTimeCount = 0;
  let skipped = 0;
  for await (const s of rows('stop_times.txt')) {
    if (!tripIds.has(s.trip_id)) continue;
    // Turnbacks and driver relief points: no one gets on or off there
    if (s.pickup_type === '1' && s.drop_off_type === '1') { skipped += 1; continue; }
    if (!byTrip.has(s.trip_id)) byTrip.set(s.trip_id, []);
    byTrip.get(s.trip_id).push([Number(s.stop_sequence), s.stop_id, parseGtfsTime(s.arrival_time), parseGtfsTime(s.departure_time)]);
    usedStops.add(s.stop_id);
    stopTimeCount += 1;
  }

  // Trip patterns: same stops, same sequence numbers and same gaps = same pattern (patterns.js)
  const { patternStops, tripPattern, patternCount } = buildPatterns(byTrip);
  byTrip.clear();
  // A trip whose every stop was a turnback has no pattern; it can't be boarded, so it isn't kept
  const boardable = trips.filter((t) => tripPattern.has(t[0]));
  for (const t of boardable) t.push(...tripPattern.get(t[0]));

  // Keep only the platforms and wharves these services use, and the stations those platforms belong to
  const allStops = new Map();
  for await (const s of rows('stops.txt')) allStops.set(s.stop_id, s);
  const stops = [];
  const stationIds = new Set();
  for (const id of usedStops) {
    const s = allStops.get(id);
    // Most bus stops have no parent station: they become their own station
    const station = s.parent_station || id;
    stationIds.add(station);
    stops.push([id, station, s.stop_name, s.platform_code || null]);
  }
  // Kinds of service at each station, from the patterns that stop there
  const routeMode = new Map(routes.map((r) => [r[0], r[5]]));
  const patternMode = new Map();
  for (const t of boardable) patternMode.set(t[5], routeMode.get(t[1]));
  const stationModes = new Map();
  for (const [patternId, , stopId] of patternStops) {
    const station = allStops.get(stopId).parent_station || stopId;
    if (!stationModes.has(station)) stationModes.set(station, new Set());
    stationModes.get(station).add(patternMode.get(patternId));
  }
  const stations = [...stationIds].map((id) => {
    const s = allStops.get(id);
    return [id, s.stop_name, Number(s.stop_lat), Number(s.stop_lon), [...(stationModes.get(id) ?? [])].sort().join(',')];
  });

  // Track shapes: for each route keep its longest shape (the full line), simplified to ~10 m
  const shapePoints = new Map();
  for await (const p of rows('shapes.txt')) {
    if (!shapeRoute.has(p.shape_id)) continue;
    if (!shapePoints.has(p.shape_id)) shapePoints.set(p.shape_id, []);
    shapePoints.get(p.shape_id).push([Number(p.shape_pt_sequence), Number(p.shape_pt_lat), Number(p.shape_pt_lon)]);
  }
  const longest = new Map();
  for (const [shapeId, pts] of shapePoints) {
    const routeId = shapeRoute.get(shapeId);
    if (!longest.has(routeId) || pts.length > longest.get(routeId).length) longest.set(routeId, pts);
  }
  const routeShapes = [...longest].map(([routeId, pts]) => {
    const line = pts.sort((a, b) => a[0] - b[0]).map(([, lat, lng]) => [lat, lng]);
    const coords = simplify(line, 0.0001).map(([lat, lng]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
    return [routeId, JSON.stringify(coords)];
  });

  const calendar = [];
  for await (const c of rows('calendar.txt')) {
    if (!serviceIds.has(c.service_id)) continue;
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => c[d] === '1');
    calendar.push([c.service_id, `{${days.join(',')}}`, parseGtfsDate(c.start_date), parseGtfsDate(c.end_date)]);
  }
  const calendarDates = [];
  for await (const c of rows('calendar_dates.txt')) {
    if (serviceIds.has(c.service_id)) calendarDates.push([c.service_id, parseGtfsDate(c.date), Number(c.exception_type)]);
  }

  const modes = {};
  for (const r of routes) modes[r[5]] = (modes[r[5]] ?? 0) + 1;
  console.log(`Loading the SEQ schedule (routes: ${Object.entries(modes).map(([m, n]) => `${n} ${m}`).join(', ')}):`);
  console.log(`  ${stopTimeCount} stop times -> ${patternCount} trip patterns, ${patternStops.length} pattern stops`);
  console.log(`  ${skipped} stop times skipped (no pick-up and no drop-off), ${trips.length - boardable.length} trips with no stop to board at`);
  await insertMany(client, 'routes', ['route_id', 'short_name', 'long_name', 'color', 'text_color', 'mode'], ['text', 'text', 'text', 'text', 'text', 'text'], routes);
  await insertMany(client, 'stations', ['station_id', 'name', 'lat', 'lng', 'modes'], ['text', 'text', 'float8', 'float8', 'text'], stations);
  await insertMany(client, 'stops', ['stop_id', 'station_id', 'name', 'platform'], ['text', 'text', 'text', 'text'], stops);
  await insertMany(client, 'trips', ['trip_id', 'route_id', 'service_id', 'headsign', 'direction_id', 'pattern_id', 'start_secs'], ['text', 'text', 'text', 'text', 'int2', 'int4', 'int4'], boardable);
  await insertMany(client, 'pattern_stops', ['pattern_id', 'stop_sequence', 'stop_id', 'arr_offset', 'dep_offset', 'is_last'], ['int4', 'int4', 'text', 'int4', 'int4', 'bool'], patternStops);
  // Postgres can't UNNEST an array of arrays into one boolean[] column, so calendar goes row by row (a few hundred rows)
  for (const c of calendar) {
    await client.query('INSERT INTO calendar (service_id, days, start_date, end_date) VALUES ($1, $2::boolean[], $3, $4)', c);
  }
  console.log(`  calendar: ${calendar.length} rows`);
  await insertMany(client, 'route_shapes', ['route_id', 'coords'], ['text', 'jsonb'], routeShapes);
  await insertMany(client, 'calendar_dates', ['service_id', 'date', 'exception_type'], ['text', 'date', 'int2'], calendarDates);

  await client.query('COMMIT');
  // Fresh statistics so the planner uses the new indexes (the departures query went from 900 ms to 30 ms)
  await client.query('ANALYZE');
  const { rows: size } = await client.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS size');
  console.log(`Done. Database size: ${size[0].size}`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Load failed, nothing was changed:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
