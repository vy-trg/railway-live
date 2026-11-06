// Load the rail part of TransLink's GTFS schedule into Postgres.
// Usage: DATABASE_URL=... node scripts/load-gtfs.js path/to/unzipped/SEQ_GTFS
//
// Only routes with a route_type in ROUTE_TYPES are kept; trips, stop_times and stops
// follow from those routes, so adding buses later means changing one line.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { pool } from '../db/pool.js';
import { parseGtfsTime, parseGtfsDate } from '../schedule.js';

const ROUTE_TYPES = new Set(['2']); // 2 = rail
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
  await client.query('TRUNCATE stop_times, trips, stops, stations, routes, calendar, calendar_dates CASCADE');

  const routes = [];
  for await (const r of rows('routes.txt')) {
    if (ROUTE_TYPES.has(r.route_type)) {
      routes.push([r.route_id, r.route_short_name, r.route_long_name, r.route_color || '888888', r.route_text_color || 'FFFFFF']);
    }
  }
  const routeIds = new Set(routes.map((r) => r[0]));

  const trips = [];
  const serviceIds = new Set();
  for await (const t of rows('trips.txt')) {
    if (!routeIds.has(t.route_id)) continue;
    trips.push([t.trip_id, t.route_id, t.service_id, t.trip_headsign, t.direction_id === '' ? null : Number(t.direction_id)]);
    serviceIds.add(t.service_id);
  }
  const tripIds = new Set(trips.map((t) => t[0]));

  const stopTimes = [];
  const usedStops = new Set();
  for await (const s of rows('stop_times.txt')) {
    if (!tripIds.has(s.trip_id)) continue;
    stopTimes.push([s.trip_id, Number(s.stop_sequence), s.stop_id, parseGtfsTime(s.arrival_time), parseGtfsTime(s.departure_time)]);
    usedStops.add(s.stop_id);
  }

  // Keep only the platforms trains use, and the stations those platforms belong to
  const allStops = new Map();
  for await (const s of rows('stops.txt')) allStops.set(s.stop_id, s);
  const stops = [];
  const stationIds = new Set();
  for (const id of usedStops) {
    const s = allStops.get(id);
    if (s.parent_station) stationIds.add(s.parent_station);
    stops.push([id, s.parent_station || null, s.stop_name, s.platform_code || null]);
  }
  const stations = [...stationIds].map((id) => {
    const s = allStops.get(id);
    return [id, s.stop_name, Number(s.stop_lat), Number(s.stop_lon)];
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

  console.log('Loading rail schedule:');
  await insertMany(client, 'routes', ['route_id', 'short_name', 'long_name', 'color', 'text_color'], ['text', 'text', 'text', 'text', 'text'], routes);
  await insertMany(client, 'stations', ['station_id', 'name', 'lat', 'lng'], ['text', 'text', 'float8', 'float8'], stations);
  await insertMany(client, 'stops', ['stop_id', 'station_id', 'name', 'platform'], ['text', 'text', 'text', 'text'], stops);
  await insertMany(client, 'trips', ['trip_id', 'route_id', 'service_id', 'headsign', 'direction_id'], ['text', 'text', 'text', 'text', 'int2'], trips);
  await insertMany(client, 'stop_times', ['trip_id', 'stop_sequence', 'stop_id', 'arrival_secs', 'departure_secs'], ['text', 'int4', 'text', 'int4', 'int4'], stopTimes);
  // Postgres can't UNNEST an array of arrays into one boolean[] column, so calendar goes row by row (a few hundred rows)
  for (const c of calendar) {
    await client.query('INSERT INTO calendar (service_id, days, start_date, end_date) VALUES ($1, $2::boolean[], $3, $4)', c);
  }
  console.log(`  calendar: ${calendar.length} rows`);
  await insertMany(client, 'calendar_dates', ['service_id', 'date', 'exception_type'], ['text', 'date', 'int2'], calendarDates);

  await client.query('COMMIT');
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
