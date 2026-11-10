# Train + bus: will I make the connection?

## The problem

I take the Springfield line, then a bus to Griffith's Nathan campus. If the train is a few minutes late, I miss the bus and wait for the next one. TransLink shows where each train and bus is, but not the question I actually have: *will I make this connection?*

This feature answers it for one trip: given a train (with its live delay), the change point, and the walk, which bus can I catch, and is it **Make it / Tight / Miss**? Later it suggests the most reliable train + bus for a time I need to be at Nathan, using the delay history Railway Live already records.

## Where to change (from the timetable, 8 Nov)

| Change at | Bus | From stop (distance from station) | To | Bus time | Runs |
|---|---|---|---|---|---|
| **Sherwood** | **598** Great Circle Line (anti-clockwise), `route_id 598-4` | Sherwood Rd near Hedges St, `5341` (~110 m) | Troughton Rd at QEII Hospital, `10306` (edge of Nathan campus) | ~23 min | about every 30 min, 6:00 am – 6:15 pm |
| **Roma Street** | **M1** Brisbane Metro, Eight Mile Plains – City, `route_id M1-4` | Roma Street busway, platform 2, `10792` (~40 m from the station entrance) | Griffith University station, platform 2, `10819` | ~19 min | every few minutes, 5 am – after midnight |

Station ids: Sherwood `place_shesta` (platforms `600309`–`600312`), Roma Street `place_romsta` (platforms `600028`–`600038`).

Nothing else on the Springfield line has a direct bus to Nathan within 500 m. Central station has many more routes, but trains reach Roma Street first, so Roma Street is the better change.

Note: 598 and M1 are both buses in the GTFS feed (`route_type 3`), so they come from `TripUpdates/Bus`, which is a much bigger feed than Rail. We keep only these two routes.

## Walking time to change

Straight-line distances from the timetable, plus stairs and crossings. **These are my own estimates from doing the walk; update after timing it.**

| Change | Walk | Estimate |
|---|---|---|
| Sherwood: platform → Sherwood Rd stop 5341 | ~110 m, stairs and a road crossing | 3 min |
| Roma Street: platform → busway platform 2 | ~150 m inside the station, stairs | 4 min |

## Architecture

```mermaid
flowchart LR
    subgraph TL["TransLink"]
        RT["TripUpdates/Rail"]
        BT["TripUpdates/Bus<br/>(keep 598 and M1 only)"]
        ZIP["SEQ_GTFS.zip<br/>bus routes 598-4, M1-4"]
    end
    subgraph Server["railway-live (Express)"]
        Load["load-gtfs.js<br/>+ the two bus routes"]
        Model["connection.js<br/>train arrival + delay + walk<br/>→ next buses → Make it / Tight / Miss"]
        API["GET /api/connection?trip=…&via=sherwood|roma"]
    end
    PG[("Neon Postgres<br/>timetable + trip_delays")]
    UI["Connection view<br/>(phone first)"]

    ZIP --> Load --> PG
    RT --> Model
    BT --> Model
    PG --> Model --> API --> UI
    PG -- "delay history" --> Reliability["Make-it rate by hour<br/>(end of week)"]
```

## Rules (to test)

- Arrival at the change = scheduled arrival + the train's current delay.
- Ready for the bus = arrival + walk.
- **Make it**: the bus leaves 3 minutes or more after you're ready. **Tight**: 0–3 minutes. **Miss**: it leaves before you're ready, and the next bus is shown instead.
- Bus departure uses the bus's own live delay when there is one.

## Plan

| Day | What |
|---|---|
| Mon 9 Nov | This page: problem, change points, route ids, walking estimates, diagram |
| Tue 10 Nov | ~~Load 598 and M1 timetables~~ Done early in PR #14: every SEQ bus is loaded (598: 292 trips, M1: 1,292 trips; whole database 64 MB with trip patterns). Brought Wednesday's `connection.js` forward instead |
| Wed 11 Nov | ~~`connection.js`~~ done on Tue (13 tests). Wednesday: `GET /api/connection?trip=…&via=sherwood\|roma` (Thursday's item, brought forward): train's live arrival + walk, then the 598 or M1 departures from the change stop with their live delays; returns Make it / Tight / Miss, the bus to catch and the one after |
| Thu 12 Nov | Live bus delays from TripUpdates/Bus (two routes only); `GET /api/connection` |
| Fri 13 Nov | Connection view on the phone |
| Sat 14 Nov | Make-it rate by hour from the recorded delays |
| Sun 15 Nov | "Be at Nathan by…" suggestion; README; demo |

## API

`GET /api/connection?trip=<train trip id>&via=sherwood|roma`

```json
{
  "via": "Sherwood", "route": "598",
  "train": { "arrives": "7:22 am", "scheduled": "7:22 am", "delaySecs": null, "platform": "2" },
  "walkMins": 3, "ready": "7:25 am",
  "verdict": "make",
  "catch": { "leaves": "8:22 am", "spareMins": 57, "status": "make", "live": false },
  "next": null, "waitMins": 57, "busLive": false
}
```

- `verdict` is about the bus you were aiming for (the first one after the train is due on time); `catch` is the one you'll actually get.
- `live: false` on a bus means TransLink has no prediction for it yet (it hasn't started its trip), so its time is the timetable.
- Limit: the train trip is assumed to run today (Brisbane date). A trip id from another day gives that day's times on today's date.
