-- Rail-only copy of TransLink's GTFS schedule (route_type = 2).
-- Loaded by scripts/load-gtfs.js; safe to run more than once.

CREATE TABLE IF NOT EXISTS routes (
  route_id    TEXT PRIMARY KEY,
  short_name  TEXT NOT NULL,
  long_name   TEXT NOT NULL,
  color       TEXT NOT NULL,          -- hex without '#', e.g. 6CC6E9
  text_color  TEXT NOT NULL
);

-- Stations (GTFS location_type = 1), e.g. place_spcsta = Springfield Central
CREATE TABLE IF NOT EXISTS stations (
  station_id  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL
);

-- Platforms (location_type = 0) belong to a station
CREATE TABLE IF NOT EXISTS stops (
  stop_id     TEXT PRIMARY KEY,
  station_id  TEXT REFERENCES stations(station_id),
  name        TEXT NOT NULL,
  platform    TEXT
);

CREATE TABLE IF NOT EXISTS trips (
  trip_id      TEXT PRIMARY KEY,
  route_id     TEXT NOT NULL REFERENCES routes(route_id),
  service_id   TEXT NOT NULL,
  headsign     TEXT NOT NULL,
  direction_id SMALLINT
);

-- Times are seconds after midnight of the service day; GTFS allows > 24:00:00
CREATE TABLE IF NOT EXISTS stop_times (
  trip_id        TEXT NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  stop_sequence  INT  NOT NULL,
  stop_id        TEXT NOT NULL REFERENCES stops(stop_id),
  arrival_secs   INT  NOT NULL,
  departure_secs INT  NOT NULL,
  PRIMARY KEY (trip_id, stop_sequence)
);
CREATE INDEX IF NOT EXISTS stop_times_stop_dep_idx ON stop_times (stop_id, departure_secs);

CREATE TABLE IF NOT EXISTS calendar (
  service_id TEXT PRIMARY KEY,
  days       BOOLEAN[] NOT NULL,      -- [mon, tue, wed, thu, fri, sat, sun]
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_dates (
  service_id     TEXT NOT NULL,
  date           DATE NOT NULL,
  exception_type SMALLINT NOT NULL,   -- 1 = added, 2 = removed
  PRIMARY KEY (service_id, date)
);

-- One simplified track shape per route, for drawing coloured lines on the map
CREATE TABLE IF NOT EXISTS route_shapes (
  route_id TEXT PRIMARY KEY REFERENCES routes(route_id) ON DELETE CASCADE,
  coords   JSONB NOT NULL               -- [[lat, lng], ...]
);

-- How late each trip ran, recorded every 10 minutes by scripts/record-delays.js.
-- Route, headsign, first departure and origin are copied in, so the history keeps
-- working after the timetable is reloaded (load-gtfs empties the other tables, not this one).
CREATE TABLE IF NOT EXISTS trip_delays (
  service_date DATE    NOT NULL,      -- Brisbane date the trip belongs to
  trip_id      TEXT    NOT NULL,
  route_id     TEXT    NOT NULL,
  headsign     TEXT    NOT NULL,
  origin       TEXT    NOT NULL,      -- first station, e.g. Springfield Central
  start_secs   INTEGER NOT NULL,      -- scheduled first departure, seconds after midnight
  final_delay  INTEGER NOT NULL,      -- latest delay seen (seconds, negative = early)
  max_delay    INTEGER NOT NULL,      -- worst delay seen
  cancelled    BOOLEAN NOT NULL DEFAULT false,
  samples      INTEGER NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (service_date, trip_id)
);
