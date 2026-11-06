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
  const { rows } = await pool.query('SELECT route_id, short_name, long_name, color, text_color FROM routes ORDER BY route_id');
  return rows;
}

export async function getStopIds() {
  const { rows } = await pool.query('SELECT stop_id FROM stops');
  return rows.map((r) => r.stop_id);
}

export async function getStations() {
  const { rows } = await pool.query('SELECT station_id AS id, name, lat, lng FROM stations ORDER BY name');
  return rows;
}

// Route, headsign and colour for many trips in ONE query (not one query per train)
export async function getTrips(tripIds) {
  if (tripIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT t.trip_id, t.headsign, r.route_id, r.long_name, r.color, r.text_color
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
export async function getDepartures(stationId, date, fromSecs, toSecs, limit = 12) {
  const { rows } = await pool.query(
    `WITH days AS (SELECT $2::date AS day, 0 AS shift UNION ALL SELECT $2::date - 1, 86400)
     SELECT st.trip_id, st.stop_id, st.stop_sequence, st.departure_secs - days.shift AS secs,
            s.platform, t.headsign, r.route_id, r.long_name, r.color, r.text_color
     FROM days
     JOIN stop_times st ON st.departure_secs BETWEEN $3 + days.shift AND $4 + days.shift
     JOIN stops s ON s.stop_id = st.stop_id AND s.station_id = $1
     JOIN trips t ON t.trip_id = st.trip_id
     JOIN routes r ON r.route_id = t.route_id
     WHERE ${RUNS_ON('t.service_id', 'days.day')}
       AND EXISTS (SELECT 1 FROM stop_times nxt WHERE nxt.trip_id = st.trip_id AND nxt.stop_sequence > st.stop_sequence)
     ORDER BY secs
     LIMIT $5`,
    [stationId, date, fromSecs, toSecs, limit]
  );
  return rows;
}
