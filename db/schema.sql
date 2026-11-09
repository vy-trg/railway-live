-- TransLink's SEQ GTFS schedule: trains, buses, the G:link tram and ferries.
-- Loaded by scripts/load-gtfs.js; safe to run more than once.

CREATE TABLE IF NOT EXISTS routes (
  route_id    TEXT PRIMARY KEY,
  short_name  TEXT NOT NULL,
  long_name   TEXT NOT NULL,
  color       TEXT NOT NULL,          -- hex without '#', e.g. 6CC6E9
  text_color  TEXT NOT NULL
);

-- train, bus, tram (G:link) or ferry. Added after the first version, so older databases get it here.
ALTER TABLE routes ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'train';

-- Stations (GTFS location_type = 1), e.g. place_spcsta = Springfield Central
CREATE TABLE IF NOT EXISTS stations (
  station_id  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL
);

-- Which kinds of service stop here, comma-separated and sorted. Lets the station list stay short
-- (trains, tram, ferries) while bus stops are found by searching.
ALTER TABLE stations ADD COLUMN IF NOT EXISTS modes TEXT NOT NULL DEFAULT '';  -- e.g. 'train' or 'bus,train'

-- Platforms (location_type = 0) belong to a station. A bus stop with no parent station is
-- its own station (same id), so departures work the same way for every kind of stop.
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

-- Trip patterns. Most trips of a route stop at the same stops with the same gaps between them,
-- and differ only in when they start. So instead of storing every stop time of every trip
-- (3.6 million rows for SEQ, too big for Neon's free 0.5 GB), each distinct pattern is stored
-- once and each trip stores which pattern it follows and when it starts (about 274,000 rows).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS pattern_id INT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS start_secs INT;   -- departure from its first stop
CREATE INDEX IF NOT EXISTS trips_pattern_start_idx ON trips (pattern_id, start_secs);
-- The exact track each trip follows (trip_shapes), so a planned journey is drawn on its real road or rails
ALTER TABLE trips ADD COLUMN IF NOT EXISTS shape_id TEXT;

CREATE TABLE IF NOT EXISTS pattern_stops (
  pattern_id    INT  NOT NULL,
  stop_sequence INT  NOT NULL,
  stop_id       TEXT NOT NULL REFERENCES stops(stop_id),
  arr_offset    INT  NOT NULL,          -- seconds after the trip's start
  dep_offset    INT  NOT NULL,
  is_last       BOOLEAN NOT NULL,       -- the last stop is not a departure
  PRIMARY KEY (pattern_id, stop_sequence)
);
CREATE INDEX IF NOT EXISTS pattern_stops_stop_idx ON pattern_stops (stop_id);

-- The old stop_times table is replaced by a view with the same columns,
-- so code that reads one trip's stop times doesn't change.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'stop_times' AND relkind = 'r') THEN
    DROP TABLE stop_times CASCADE;
  END IF;
END $$;
CREATE OR REPLACE VIEW stop_times AS
  SELECT t.trip_id, ps.stop_sequence, ps.stop_id,
         t.start_secs + ps.arr_offset AS arrival_secs,
         t.start_secs + ps.dep_offset AS departure_secs
  FROM trips t JOIN pattern_stops ps ON ps.pattern_id = t.pattern_id;

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

-- Every track shape of the timetable, simplified to about 10 m (a route can have several:
-- each direction and each variant). Used to draw one ride of a planned journey exactly.
CREATE TABLE IF NOT EXISTS trip_shapes (
  shape_id TEXT PRIMARY KEY,
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
