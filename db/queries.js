import { pool } from './pool.js';

// Is a service running on date d? calendar weekday + date range, then calendar_dates exceptions.
const RUNS_ON = (service, day) => `(
  (EXISTS (SELECT 1 FROM calendar c WHERE c.service_id = ${service}
             AND ${day} BETWEEN c.start_date AND c.end_date
             AND c.days[EXTRACT(ISODOW FROM ${day})::int])
   AND NOT EXISTS (SELECT 1 FROM calendar_dates x WHERE x.service_id = ${service} AND x.date = ${day} AND x.exception_type = 2))
  OR EXISTS (SELECT 1 FROM calendar_dates x WHERE x.service_id = ${service} AND x.date = ${day} AND x.exception_type = 1)
)`;

export async function getRoutes() {
  const { rows } = await pool.query('SELECT route_id, short_name, long_name, color, text_color, mode FROM routes ORDER BY route_id');
  return rows;
}

export async function getStopIds() {
  const { rows } = await pool.query('SELECT stop_id, station_id FROM stops');
  return rows;
}

export async function getStations() {
  const { rows } = await pool.query('SELECT station_id AS id, name, lat, lng, modes FROM stations ORDER BY name');
  return rows;
}

// Route, headsign and colour for many trips in ONE query (not one query per train)
export async function getTrips(tripIds) {
  if (tripIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT t.trip_id, t.headsign, r.route_id, r.long_name, r.short_name, r.color, r.text_color, r.mode
     FROM trips t JOIN routes r ON r.route_id = t.route_id
     WHERE t.trip_id = ANY($1)`,
    [tripIds]
  );
  return new Map(rows.map((r) => [r.trip_id, r]));
}

// Platform -> station name for many stops in one query
export async function getStopNames(stopIds) {
  if (stopIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT s.stop_id, COALESCE(st.name, s.name) AS name, s.platform
     FROM stops s LEFT JOIN stations st ON st.station_id = s.station_id
     WHERE s.stop_id = ANY($1)`,
    [stopIds]
  );
  return new Map(rows.map((r) => [r.stop_id, r]));
}

// Scheduled departures from every platform of a station between `fromSecs` and `toSecs`
// on `date` (Brisbane). Trips that started the day before and run past midnight
// (GTFS times like 24:30:00) are included too. The last stop of a trip is not a departure.
// stationId: one station, or a list of them (every bus stop near a train station)
export async function getDepartures(stationId, date, fromSecs, toSecs, limit = 12) {
  // Start from the station's stops, find the patterns that call there, then the trips of those
  // patterns whose start time puts them at this stop inside the window (index on pattern_id, start_secs)
  const { rows } = await pool.query(
    `WITH days AS (SELECT $2::date AS day, 0 AS shift UNION ALL SELECT $2::date - 1, 86400)
     SELECT t.trip_id, ps.stop_id, s.station_id, ps.stop_sequence, t.start_secs + ps.dep_offset - days.shift AS secs,
            s.platform, t.headsign, r.route_id, r.long_name, r.short_name, r.mode, r.color, r.text_color
     FROM stops s
     JOIN pattern_stops ps ON ps.stop_id = s.stop_id AND NOT ps.is_last
     CROSS JOIN days
     JOIN trips t ON t.pattern_id = ps.pattern_id
                 AND t.start_secs BETWEEN $3 + days.shift - ps.dep_offset AND $4 + days.shift - ps.dep_offset
     JOIN routes r ON r.route_id = t.route_id
     WHERE s.station_id = ANY($1::text[])
       AND ${RUNS_ON('t.service_id', 'days.day')}
     ORDER BY secs
     LIMIT $5`,
    [[].concat(stationId), date, fromSecs, toSecs, limit]
  );
  return rows;
}

// Every place each route goes to or through: its name, its destinations and every station or stop
// it calls at. Used to find routes by place ("Springfield") instead of by number.
export async function getRoutePlaces() {
  const { rows } = await pool.query(
    `SELECT t.route_id, string_agg(DISTINCT lower(COALESCE(sta.name, s.name)), '|') AS stops,
            string_agg(DISTINCT lower(t.headsign), '|') AS headsigns
     FROM trips t
     JOIN pattern_stops ps ON ps.pattern_id = t.pattern_id
     JOIN stops s ON s.stop_id = ps.stop_id
     LEFT JOIN stations sta ON sta.station_id = s.station_id
     GROUP BY t.route_id`
  );
  return rows;
}

export async function getRouteShapes() {
  const { rows } = await pool.query(
    'SELECT s.route_id, r.color, s.coords FROM route_shapes s JOIN routes r ON r.route_id = s.route_id'
  );
  return rows;
}

// Every stop of one trip in order, with station names and scheduled times (seconds after midnight)
export async function getTripStops(tripId) {
  const { rows } = await pool.query(
    `SELECT st.stop_sequence, st.stop_id, s.station_id, st.arrival_secs, st.departure_secs,
            COALESCE(sta.name, s.name) AS name, s.platform, sta.lat, sta.lng
     FROM stop_times st
     JOIN stops s ON s.stop_id = st.stop_id
     LEFT JOIN stations sta ON sta.station_id = s.station_id
     WHERE st.trip_id = $1
     ORDER BY st.stop_sequence`,
    [tripId]
  );
  return rows;
}

// Save how late these trips are now. Each trip has one row per day: the latest delay
// replaces the old one, and the worst delay is kept. Trips not in the rail timetable are skipped.
export async function recordDelays(serviceDate, items) {
  if (items.length === 0) return 0;
  const { rowCount } = await pool.query(
    `INSERT INTO trip_delays (service_date, trip_id, route_id, headsign, origin, start_secs, final_delay, max_delay, cancelled)
     SELECT $1::date, d.trip_id, t.route_id, t.headsign, COALESCE(sta.name, s.name), first.departure_secs, d.delay, d.delay, d.cancelled
     FROM unnest($2::text[], $3::int[], $4::bool[]) AS d(trip_id, delay, cancelled)
     JOIN trips t ON t.trip_id = d.trip_id
     JOIN LATERAL (SELECT ps.stop_id, t.start_secs AS departure_secs FROM pattern_stops ps
                   WHERE ps.pattern_id = t.pattern_id ORDER BY ps.stop_sequence LIMIT 1) first ON true
     JOIN stops s ON s.stop_id = first.stop_id
     LEFT JOIN stations sta ON sta.station_id = s.station_id
     ON CONFLICT (service_date, trip_id) DO UPDATE SET
       final_delay = EXCLUDED.final_delay,
       max_delay = GREATEST(trip_delays.max_delay, EXCLUDED.final_delay),
       cancelled = EXCLUDED.cancelled,
       samples = trip_delays.samples + 1,
       updated_at = now()`,
    [serviceDate, items.map((i) => i.tripId), items.map((i) => i.delay), items.map((i) => i.cancelled)]
  );
  return rowCount;
}

// Keep about a month of history so the free database stays small
export async function pruneDelays(keepDays) {
  const { rowCount } = await pool.query(
    'DELETE FROM trip_delays WHERE service_date < CURRENT_DATE - $1::int', [keepDays]);
  return rowCount;
}

// The four views on the Stats tab, for the `days` service days up to and including `toDate`
export async function getDelayStats(toDate, days, onTimeSec) {
  const range = 'service_date BETWEEN $1::date - ($2::int - 1) AND $1::date';
  const counts = `count(*)::int AS trips,
    count(*) FILTER (WHERE NOT cancelled AND final_delay < $3)::int AS on_time,
    count(*) FILTER (WHERE NOT cancelled AND final_delay >= $3)::int AS late,
    COALESCE(sum(final_delay) FILTER (WHERE NOT cancelled AND final_delay >= $3), 0)::int AS late_secs`;
  const args = [toDate, days, onTimeSec];
  const [byRoute, byHour, byDay, worst, since] = await Promise.all([
    pool.query(`SELECT route_id, ${counts} FROM trip_delays WHERE ${range} GROUP BY route_id`, args),
    pool.query(`SELECT (start_secs / 3600) % 24 AS hour, ${counts} FROM trip_delays WHERE ${range} GROUP BY 1 ORDER BY 1`, args),
    pool.query(`SELECT to_char(service_date, 'YYYY-MM-DD') AS date, ${counts} FROM trip_delays WHERE ${range} GROUP BY 1 ORDER BY 1`, args),
    // The same departure runs every weekday with a new trip id, so group by what a passenger sees
    pool.query(`SELECT route_id, origin, headsign, start_secs, count(*)::int AS runs,
                  round(avg(final_delay))::int AS avg_delay
                FROM trip_delays WHERE ${range} AND NOT cancelled
                GROUP BY route_id, origin, headsign, start_secs
                HAVING count(*) >= 2
                ORDER BY avg_delay DESC LIMIT 5`, [toDate, days]),
    pool.query(`SELECT to_char(min(service_date), 'YYYY-MM-DD') AS first FROM trip_delays`),
  ]);
  return { byRoute: byRoute.rows, byHour: byHour.rows, byDay: byDay.rows, worst: worst.rows, since: since.rows[0].first };
}

// ---------- Journey planner ----------

// Every stop with where it is (platforms use their station's position) and its station's name
export async function getPlannerStops() {
  const { rows } = await pool.query(
    `SELECT s.stop_id, s.station_id, sta.name, s.platform, sta.lat, sta.lng, sta.modes
     FROM stops s JOIN stations sta ON sta.station_id = s.station_id
     ORDER BY s.stop_id`
  );
  return rows;
}

// Every trip pattern's stops in order
export async function getPatternStops() {
  const { rows } = await pool.query(
    `SELECT pattern_id, stop_sequence, stop_id, arr_offset, dep_offset, is_last
     FROM pattern_stops ORDER BY pattern_id, stop_sequence`
  );
  return rows;
}

// The services (timetable "days") that run on one date
async function servicesOn(date) {
  const { rows } = await pool.query(
    `SELECT c.service_id FROM calendar c
     WHERE $1::date BETWEEN c.start_date AND c.end_date AND c.days[EXTRACT(ISODOW FROM $1::date)::int]
       AND NOT EXISTS (SELECT 1 FROM calendar_dates x WHERE x.service_id = c.service_id AND x.date = $1::date AND x.exception_type = 2)
     UNION
     SELECT service_id FROM calendar_dates WHERE date = $1::date AND exception_type = 1`,
    [date]
  );
  return rows.map((r) => r.service_id);
}

// The trips that run on one date, plus yesterday's trips that are still running after midnight
// (their times are moved back a day, so 25:10 yesterday becomes 1:10 today).
export async function getTripsOn(date) {
  const yesterday = new Date(`${date}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const [today, before] = await Promise.all([servicesOn(date), servicesOn(yesterday.toISOString().slice(0, 10))]);
  const { rows } = await pool.query(
    `SELECT pattern_id, start_secs, trip_id, route_id FROM trips WHERE service_id = ANY($1)
     UNION ALL
     SELECT pattern_id, start_secs - 86400, trip_id, route_id FROM trips WHERE service_id = ANY($2) AND start_secs >= 64800
     ORDER BY 1, 2`,
    [today, before]
  );
  return rows;
}

// The exact track of each of these trips: trip_id -> [[lat, lng], ...] (trips without one are left out)
export async function getTripShapes(tripIds) {
  if (tripIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT t.trip_id, s.coords FROM trips t JOIN trip_shapes s ON s.shape_id = t.shape_id
     WHERE t.trip_id = ANY($1)`,
    [tripIds]
  );
  return new Map(rows.map((r) => [r.trip_id, r.coords]));
}

// The station a stop belongs to (bus stops at a busway station share it with the other platforms)
export async function getStationOfStop(stopId) {
  const { rows } = await pool.query('SELECT station_id FROM stops WHERE stop_id = $1', [stopId]);
  return rows[0]?.station_id ?? null;
}

// For buses you might catch: when each trip gets to one of these stations later on (e.g. Griffith
// Nathan). Times are the trip's own (seconds after its service day began), with the stop's sequence.
export async function getCallsAt(tripIds, stationIds) {
  if (tripIds.length === 0 || stationIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT st.trip_id, st.stop_sequence, st.arrival_secs, st.departure_secs, s.station_id
     FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id
     WHERE st.trip_id = ANY($1::text[]) AND s.station_id = ANY($2::text[])`,
    [tripIds, stationIds]
  );
  return rows;
}
