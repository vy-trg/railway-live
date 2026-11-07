# Railway Live – Architecture

This document answers the planning questions from my 5 Oct design review (updated 8 Nov to match what is built), then shows the architecture, data flow and state diagrams.

## 0. Answers to the design questions

| Question | Answer |
|---|---|
| **Where is the app hosted?** | Render, free web service, auto-deployed from GitHub. See "Hosting options" below. |
| **How does data flow from TransLink to the page?** | Browser polls my Express server every 30 s → server serves from an in-memory cache, or fetches TransLink's GTFS-RT feed once, decodes the protobuf and returns small JSON. See diagrams 1 and 2. |
| **Built locally in Docker first?** | Yes, since week 2: `docker compose up` runs the app with its own Postgres. CI also builds the Docker image on every pull request. |
| **Access requirements for the live data?** | None technically: no API key or account. The data is licensed CC BY 4.0, so TransLink must be credited (in the README and map). Use is subject to TransLink's open data terms. |
| **Rate limits?** | I didn't find a published rate limit. I designed as if there were one: the server calls TransLink at most once per 30 s however many users are online, with a 10 s timeout and stale-data fallback. |
| **Polling or WebSockets?** | Polling every 30 s, plus an immediate refresh when the tab becomes visible. The feed itself only updates about every 30 s, so push would not make data fresher, and polling works through Render's free plan without long-lived connections. |
| **Backend server, and a database or something like SQLite?** | Node.js 22 + Express 5, with PostgreSQL on Neon. Postgres holds the train, tram and ferry timetable (about 320,000 stop times) and the delay history. SQLite was ruled out because Render's free disk is wiped on every deploy and restart. |

### Hosting options considered

| Option | Fit for this app | Decision |
|---|---|---|
| **Render (free)** | Runs a normal long-lived Node server, so the in-memory cache works. Free, no card. Sleeps after 15 min idle (30–60 s cold start). | ✅ Chosen |
| Vercel | Easy Node deploys, but runs as serverless functions: memory isn't kept between requests, so the cache would need an external store. | Not now |
| Cloudflare Workers + KV | Fast and free, but a different runtime (not plain Express) and KV is eventually consistent. Good option to learn later. | Not now |
| Heroku | Supports Docker, no free tier; GitHub Student Pack credit covers it. | Backup if Render's sleeping becomes a problem |
| Oracle / GCP / Azure credits | Full VMs or managed services, but more setup and a credit card. | Not needed at this size |

## 1. Architecture diagram

Components, libraries, servers and APIs, and how they connect.

```mermaid
flowchart LR
    subgraph Browser["Browser (desktop or phone)"]
        Page["public/index.html + app.js<br/>vanilla JS, fetch() every 30 s"]
        Leaf["Leaflet 1.9<br/>markers, track lines"]
    end

    Tiles["OpenStreetMap<br/>tile server"]

    subgraph Render["Render – free web service"]
        subgraph Node["Node.js 22 + Express 5 (server.js)"]
            API["REST API<br/>/api/trains, /api/departures,<br/>/api/trips/:id, /api/alerts, /api/stats …"]
            Cache["realtime.js<br/>30 s cache, shared in-flight fetch"]
            Dec["feed.js<br/>protobuf → JSON"]
            Join["live.js, schedule.js<br/>join realtime with the timetable"]
        end
    end

    subgraph TL["TransLink GTFS-RT (protobuf, no API key)"]
        VP["VehiclePositions<br/>Rail · Tram · Ferry"]
        TU["TripUpdates<br/>Rail · Tram · Ferry"]
        AL["Alerts"]
    end

    ZIP["SEQ_GTFS.zip<br/>timetable"]
    Load["scripts/load-gtfs.js<br/>run by hand when TransLink<br/>publishes a new timetable"]
    PG[("Neon PostgreSQL<br/>routes, trips, stop_times, …<br/>trip_delays")]

    subgraph GHA["GitHub Actions"]
        CI["CI on every PR<br/>tests · gitleaks · Docker build"]
        Rec["Record delays<br/>every 10 min"]
    end

    Page --> Leaf
    Leaf -- "map tiles" --> Tiles
    Page -- "JSON" --> API
    API --> Cache --> Dec
    Dec -- "HTTPS, 10 s timeout" --> VP & TU & AL
    API --> Join --> PG
    ZIP --> Load --> PG
    Rec -- "TripUpdates" --> TU
    Rec -- "upsert one row per trip per day" --> PG
```

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, vanilla JavaScript, Leaflet, OpenStreetMap tiles, self-hosted Nunito font |
| Server | Node.js 22, Express 5 (ES modules), helmet, express-rate-limit |
| Data | TransLink GTFS-RT (VehiclePositions, TripUpdates, Alerts) decoded with `gtfs-realtime-bindings`; GTFS static timetable |
| Database | PostgreSQL on Neon; `docker compose` Postgres locally |
| Jobs and CI | GitHub Actions: tests, gitleaks and a Docker build on every PR; the delay recorder every 10 minutes |
| Hosting | Render (free web service), auto-deployed from `main` |

## 2. Data flow: one map refresh

```mermaid
sequenceDiagram
    participant B as Browser (app.js)
    participant S as Express (server.js)
    participant C as Realtime cache
    participant T as TransLink GTFS-RT
    participant D as Neon PostgreSQL

    loop every 30 s, and when the tab becomes visible again
        B->>S: GET /api/trains
        S->>C: getVehicles(), getTripUpdates()
        alt cache younger than 30 s
            C-->>S: cached feeds
        else cache expired
            Note over C: Requests arriving now wait<br/>for the same fetch
            C->>T: Rail, Tram and Ferry feeds in parallel
            T-->>C: protobuf (a failing mode is skipped,<br/>the others still show)
        end
        S->>D: trips and stop names for every vehicle<br/>(one query each with = ANY($1))
        D-->>S: route, headsign, colour, mode, stop names
        S->>S: next stop, delay, delay level per vehicle
        S-->>B: 200 {updatedAt, stale, trains}
        B->>B: glide markers to new positions,<br/>re-sort the list (late services first)
    end
```

## 3. Data flow: recording delays

```mermaid
sequenceDiagram
    participant G as GitHub Actions (cron */10)
    participant R as scripts/record-delays.js
    participant T as TransLink TripUpdates
    participant D as Neon PostgreSQL

    G->>R: node scripts/record-delays.js
    R->>D: schema.sql (IF NOT EXISTS, creates trip_delays once)
    R->>T: TripUpdates for Rail, Tram, Ferry
    T-->>R: every trip with predicted times
    R->>R: delay at each trip's next stop<br/>(last stop once it has finished)
    R->>D: INSERT … ON CONFLICT (service_date, trip_id)<br/>DO UPDATE latest delay, keep the worst
    R->>D: DELETE rows older than 35 days
    Note over D: /api/stats groups these rows by line,<br/>hour of day, day and departure
```

## 4. State diagram: the realtime cache

```mermaid
stateDiagram-v2
    [*] --> Empty: server starts
    Empty --> Fetching: first request
    Fetching --> Fresh: at least one mode OK
    Fetching --> Empty: every mode failed, no old data / 503
    Fresh --> Fresh: request within 30 s / cache hit
    Fresh --> Expired: 30 s pass
    Expired --> Fetching: next request
    Fetching --> Stale: every mode failed, old data kept
    Stale --> Fetching: next request retries
    Fresh --> [*]: Render sleeps after 15 min idle (cache lost)
```

## 5. Design decisions

| Decision | Why |
|---|---|
| Server in front of TransLink | The browser gets small JSON instead of protobuf, and TransLink is called at most once per 30 s per feed however many people have the map open |
| Timetable in Postgres, realtime in memory | The timetable is large and changes rarely; live positions change every 30 s and are only needed for now |
| One query per refresh with `= ANY($1)` | About 60 vehicles need route and stop names; one round trip to Neon instead of 60 |
| Each mode fetched separately | If the ferry feed fails, trains and trams still show |
| Delay recording in GitHub Actions, not in the server | Render's free plan sleeps when nobody is using it, so a timer inside the server would leave gaps |
| One row per trip per day, updated in place | Keeps the history small enough for Neon's free plan; the latest delay is what the trip finished with |
| Turnbacks and relief points left out | GTFS marks them as no pick-up and no drop-off; showing them as "Next" would confuse passengers |
| Serve stale data instead of failing | The map stays useful when TransLink is down, with a clear warning |
| Brisbane time is fixed UTC+10 | Queensland has no daylight saving; service days can run past 24:00 |
