# Journey planner (Plan tab)

## The problem

The Live tab's "Where to?" only shows vehicles running now that go straight to a place. It can't answer the real question: *from where I am, which train, bus, tram or ferry do I take, where do I change, and when do I get there?*

## How it works

```mermaid
flowchart LR
    PG[("Postgres<br/>pattern_stops, trips, calendar")] -- "once at start" --> Net["Network in memory<br/>12,800 stops · 8,700 patterns<br/>walks between stops ≤ 400 m"]
    PG -- "per date, cached" --> Trips["Trips running that day<br/>(+ yesterday's after midnight)"]
    Net --> R["raptor.js<br/>round k = at most k vehicles"]
    Trips --> R
    R --> D["planner.js describeJourney<br/>+ live delays<br/>+ Make it / Tight / Miss (connection.js)"]
    RT["TripUpdates<br/>(bus feed only if a journey uses a bus)"] --> D
    D --> API["GET /api/plan"] --> UI["Plan tab"]
```

**RAPTOR** (Delling, Pajor, Werneck, Microsoft Research, 2012) works in rounds. Round 1 finds every stop you can reach with one vehicle, round 2 with one change, and so on. Each round only looks at routes that stop somewhere that improved in the round before, so it's fast without building a graph of every stop time. The trip patterns that keep the database small (see README) are exactly RAPTOR's "routes": trips with the same stops and gaps, so trips of a pattern never overtake each other and the first trip you can catch is a binary search.

To give several options, the planner runs again leaving a minute after the first vehicle of the fastest option, until it has 5 different journeys.

## Measured (local, full SEQ timetable)

| | |
|---|---|
| Load network | ~0.6 s, once at start |
| Load one day's trips | ~0.1 s, then cached (3 days kept) |
| One plan (5 journeys) | 0.15–0.4 s |
| Memory | ~125 MB heap |

## Rules

| Rule | Value | Why |
|---|---|---|
| Change at the same stop | 1 min | Time to get off and on |
| Platforms of the same station | 2 min | Stairs, crossing the station |
| Walk between nearby stops | up to 400 m, 4.5 km/h, +20% for streets, at least 2 min | Straight lines are shorter than real paths |
| "Near me" and walking at the end | stops within 800 m | About 10 minutes' walk |
| Changes | up to 4 (5 vehicles) | More is rarely useful |
| Make it / Tight / Miss | `connection.js`: 3+ min spare / 0–3 / less | Same rule as the train + bus feature |

## Places by name

Typing "griffith" shows every Griffith campus first (Nathan, Mt Gravatt, Gold Coast, Logan, South Bank), like a map search. Also UQ St Lucia, QUT Gardens Point and Kelvin Grove, and both Brisbane Airport terminals. Each place is anchored on a real stop in `landmarks.js`, and the planner uses every stop within 800 m of it. It's a short hand-picked list, not an address search.

## Choosing a time

The browser's own date picker has no "Done" button and lets you pick a time that has already passed, which made the planner quietly use *now* instead. The Plan and Departures tabs now use their own picker: day, hour, minutes, am/pm, then **Done**. A time that has passed is refused with a message. Done runs the search straight away.

If nothing runs any more that day, the planner shows the first journeys the next morning and says so.

## What it doesn't do (on purpose, for now)

- **Addresses.** From and To are stations or stops; there is no address search, because that needs an outside geocoding service and an API key. "Near me" uses the phone's location instead, once, and doesn't save it.
- **Walks are estimates.** TransLink's open data has almost no walking links between stops, so walks are straight-line estimates. Real stairs, lifts and crossings can be slower.
- **Live delays don't change the route search.** Journeys are found on the timetable; live delays are then shown on each vehicle and used for Make it / Tight / Miss. Planning around live delays is the next step.
- **No fares, accessibility or "fewest walks" options** yet.
