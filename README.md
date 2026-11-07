# Railway Live 🚆
![CI](https://github.com/vy-trg/railway-live/actions/workflows/ci.yml/badge.svg)

Live trains, trams and ferries for South East Queensland: where every service is, how late it is, the next departures from any station, current track closures, and which services are most often late. An Express server joins TransLink's realtime feeds with the timetable in PostgreSQL and serves clean JSON to a Leaflet map.

📁 **[GitHub Repo](https://github.com/vy-trg/railway-live)**

🔗 **[Live Demo](https://railway-live.onrender.com/)**

<p align="center"><img src="docs/screenshot.png" alt="Railway Live on a Saturday evening: 45 trains, 12 trams and 8 ferries on the map, late services listed first" width="720"></p>

---

## The problem

I take the Springfield line to uni, then a bus to Griffith's Nathan campus. TransLink's app shows where my train is right now, but not how reliable each service usually is. A train that is regularly a few minutes late at a certain time decides whether I make the bus.

Railway Live shows every train, tram and ferry live, and records how late each service runs every 10 minutes. The Stats tab shows which lines, times of day and departures are most often late, so I can pick a train I can rely on instead of guessing. Success means: after two weeks of data, I know which morning Springfield train is the most reliable. Connecting the train to the bus is the next project (weeks 8–9).

---

## About

TransLink publishes where every train is, but in Protocol Buffers (a binary format), not JSON, and the feed only changes about every 30 seconds. If every browser fetched it directly, each visitor would hit TransLink separately and the browser would have to decode protobuf itself.

Railway Live puts a thin server in between: it fetches and decodes the feed **at most once every 30 seconds**, however many people have the map open, and hands the browser a small, clean JSON list.

**My role:** Solo project. I built the GTFS-RT ingestion and cache on the server, the `/api/trains` endpoint, and the Leaflet map with its status banner.

---

## Features

- **Trains, the G:link tram and Brisbane ferries:** one map and list for all three, with an All / Trains / Tram / Ferries switch. Trains are circles, trams squares, ferries diamonds, so the kind of service doesn't depend on colour alone. Buses are left out on purpose (thousands of vehicles: a project of its own).
- **Live map:** every train on track lines drawn in each route's TransLink colour (from GTFS `shapes.txt`, simplified with Douglas–Peucker), refreshed every 30 seconds. The dot shows how late it is: green on time, amber 2–5 min, red 5+.
- **Journey card:** pick a train to see every stop with scheduled and expected times; passed stops are crossed out and folded away, skipped stops are marked.
- **Next trains** from any station (Springfield Central by default): scheduled time, expected time when late, platform and status, including cancelled and skipped stops, and where each train is now ("At Richlands · 2 stops away · 6 min").
- **Plan ahead:** pick any time in the next 7 days to see the timetable for the 3 hours after it.
- **On-time history:** a GitHub Actions job records how late every train is every 10 minutes. The Stats tab shows, for today, 7 or 30 days: on-time share by line, by hour of day, day by day, and the departures that are most often late.
- **Remind me:** tap the bell next to a stop in the journey card and the page warns you about 2 minutes before the train gets there (banner, plus a notification if allowed). Works while the page is open; a background reminder would need a service worker.
- **Network numbers** worked out from the live feed: trains running, share on time, average delay of late trains, and the route that is furthest behind right now.
- **Rail alerts** from TransLink's Alerts feed (track closures, lift outages, timetable changes), with the lines they affect.
- **Filter by line** (e.g. Springfield shows every train to or from Springfield). The line and station are kept in the URL, so a view can be shared.
- **Feed status:** shows how fresh the data is, and keeps the last known data (marked as old) if TransLink is down.

---

## Tech Stack

| Area | Tools |
|---|---|
| Server | Node.js 22+, Express 5 |
| Data | TransLink GTFS (timetable) in PostgreSQL; GTFS-RT VehiclePositions, TripUpdates and Alerts decoded with `gtfs-realtime-bindings` |
| Frontend | HTML, CSS, vanilla JavaScript, Nunito (self-hosted) |
| Map | Leaflet 1.9, OpenStreetMap tiles |

---

## How it works

```
Browser  --every 30s-->  /api/trains, /api/summary, /api/departures  -->  30s cache of 3 realtime feeds  -->  TransLink GTFS-RT
                                         \--> PostgreSQL (rail timetable: routes, stations, trips, stop times)
```

- **One query per refresh, not one per train:** route names for all trains on the map come from a single `WHERE trip_id = ANY($1)` query.
- **Delays carry forward:** GTFS-RT gives a delay for some stops; a stop without its own value uses the last one before it, as the spec says.
- **Recording history without a server running:** Render's free plan sleeps, so recording happens in a scheduled GitHub Actions job (`scripts/record-delays.js`). Each trip keeps one row per day that is updated in place, and rows older than 35 days are removed, so the free database stays small.
- **Service days:** Brisbane is UTC+10 all year, and GTFS times can pass 24:00, so the board also checks trips that started the day before.

1. **Same origin:** Express serves `public/index.html` and the API from one server, so the browser needs no CORS setup.
2. **In-memory cache:** the decoded feed is kept in a variable with the time it was fetched. Requests within 30 seconds get the cached copy.
3. **Timeout:** a TransLink request that takes longer than 10 seconds is cancelled, so a slow feed can't hang the API.

### API

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/trains` | `{ updatedAt, stale, trains: [{ id, lat, lng, routeName, headsign, color, nextStop, delaySec, delayText, level }] }`. `stale: true` means the feed failed and these are the last known positions. `503` if no data is available yet. |
| `GET` | `/api/summary` | `{ running, byMode: { train, tram, ferry }, onTimePercent, avgLateMinutes, mostDelayed }` |
| `GET` | `/api/departures?station=place_spcsta` | Next 8 departures in the next 2 hours, with live delays. `400` for an unknown station |
| `GET` | `/api/departures?station=…&at=2026-11-09T18:30` | Timetable from that Brisbane time for 3 hours, up to 7 days ahead. `400` for a bad or out-of-range time |
| `GET` | `/api/stats?days=7` | On-time history for 1, 7 or 30 days: `{ since, trips, lines, byHour, byDay, worst }` (cached for 5 minutes) |
| `GET` | `/api/alerts` | Current rail alerts with the lines they affect |
| `GET` | `/api/trips/:tripId` | One train's stops with scheduled and expected times, and which are passed, next or skipped |
| `GET` | `/api/shapes` | Simplified track line per route, for the map (cached for an hour) |
| `GET` | `/api/lines`, `/api/stations` | Lines (name, colour, routes) and stations for the filter and the board |
| `GET` | `/api/health` | `{ ok: true }` |

---

## Run it locally

**Needs:** Node.js 22 or newer and a PostgreSQL database (Neon, or Docker below). No API key is required.

```bash
git clone https://github.com/vy-trg/railway-live.git
cd railway-live
npm install
```

Load the train, tram and ferry timetable (about 323,000 stop times, ~72 MB in Postgres, 20-30 seconds):

```bash
curl -o SEQ_GTFS.zip https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip
unzip SEQ_GTFS.zip -d data/gtfs
DATABASE_URL=postgresql://... npm run load-gtfs -- data/gtfs
```

Then start the app with the same `DATABASE_URL` in `.env`:

```bash
npm run dev
```

**No internet access to TransLink?** `FEED_FIXTURES=test/fixtures npm run dev` uses feeds saved on 6 Nov 2026 at 10:35pm instead of the live API.

Open http://localhost:3000. Trains only appear while Queensland Rail services are running.

**Try the error handling:** run `FEED_URL=http://localhost:9999 npm run dev` (an address with nothing on it). The API returns `503` and the map shows a red banner instead of breaking.

---

### Run with Docker

```bash
docker compose up --build
```

In a second terminal, load the timetable into the Docker database (port 5433 on your machine):

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/railway?sslmode=disable" npm run load-gtfs -- data/gtfs
```

Open http://localhost:3000. Stop with `Ctrl + C`, then `docker compose down` (add `-v` to delete the database).

The live demo on Render uses Render's Node runtime; CI builds the Docker image on every pull request to check the Dockerfile still works.

---

## Testing

```bash
npm test
```

Unit tests use Node's built-in test runner (`node:test`). They never call TransLink:

- `test/feed.test.js`: protobuf feeds built in code (positions, missing trips, invalid data)
- `test/realtime.test.js`: **real TransLink feeds saved in `test/fixtures/`**: trip updates, skipped stops, alerts and their active periods
- `test/schedule.test.js`: GTFS times past midnight, dates, how delays are worded and coloured
- `test/live.test.js`: lines, delays carrying forward, the departure board (late, cancelled, already left) and the summary numbers

---

## Project structure

```
server.js          Express server and API routes
realtime.js        The 3 realtime feeds, each cached for 30 seconds
feed.js            Decodes GTFS-RT VehiclePositions, TripUpdates and Alerts (unit tested)
live.js            Joins realtime data with the timetable (unit tested)
schedule.js        GTFS time and date helpers (unit tested)
lines.js           Groups TransLink routes into lines (unit tested)
db/schema.sql      Rail timetable tables
db/queries.js      Timetable queries (departures, trips, stops)
scripts/load-gtfs.js  Loads trains, the G:link and ferries from SEQ_GTFS.zip into Postgres
public/            Page, styles and map code
learning/          Practice files from building this (first feed script, first Leaflet map)
NOTES.md           Notes on the data source and what I learned
test/              Tests, and saved TransLink feeds in test/fixtures
Dockerfile         Builds the app image (Node 22, runs as a non-root user)
compose.yaml       Runs the app in Docker locally
```

---

## What I learned

- GTFS-RT is protobuf, not JSON; `FeedMessage.decode` turns the bytes into JavaScript objects.
- The difference between **VehiclePositions** (where each train is now) and **TripUpdates** (delays and arrival times).
- Caching on the server protects both the upstream API and response time, and a cache also gives you something to show when the upstream fails.
- Updating existing Leaflet markers instead of redrawing them avoids flicker and duplicate markers.

---

## Known limitations & next steps

- The timetable has to be reloaded when TransLink publishes a new one (`npm run load-gtfs`); next step is a weekly GitHub Actions job.
- "Most delayed" is right now only; logging delays every 15 minutes (`delay_log`) will show which lines are late most often.
- The cache lives in memory, so it is empty after the free Render server restarts or wakes from sleep; the first request after that waits for TransLink.
- Markers jump every 30 seconds rather than gliding between positions.

---

## Data & licence

Train data: [TransLink GTFS-RT](https://translink.com.au/about-translink/open-data), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Map tiles: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
