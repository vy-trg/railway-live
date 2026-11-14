import express from 'express';
import { isActive } from './feed.js';
import { getVehicles, getTripUpdates, getBusVehicles, getBusTripUpdates, getAlerts, nowSec } from './realtime.js';
import * as db from './db/queries.js';
import { buildLines } from './lines.js';
import { enrichTrains, nextStop, summarize, buildBoard, railAlerts, buildTripProgress } from './live.js';
import { brisbaneClock, parseLocalTime, formatClock, delayAtStop } from './schedule.js';
import { serviceDate, statsByLine, percent, ON_TIME_SEC, connectionByHour } from './delays.js';
import { plan, describeJourney, getNetwork } from './planner.js';
import { resolveLandmarks, matchLandmarks, LANDMARK_PREFIX, LANDMARKS } from './landmarks.js';
import { walkRoute, roadPath } from './walk.js';
import { formatSecs, busesAfterTrain, walkSecsFor, streetWalkSecs, NEAR_BUS_M } from './connection.js';
import { distanceM, EXTRA_CHANGE_SECS } from './raptor.js';
import helmet from 'helmet';
import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import { journeyMoments, journeyOver, cleanJourney, rideState } from './push.js';
import { rateLimit } from 'express-rate-limit';

const app = express();
const PORT = process.env.PORT || 3000;

// Render is a proxy in front of the app: trust one hop so rate limiting sees real IPs
app.set('trust proxy', 1);

// Security headers. The map loads Leaflet from unpkg and tiles from OpenStreetMap,
// so those two sources are allowed on top of helmet's defaults.
// OpenStreetMap blocks tile requests with no Referer, and helmet's default is
// "no-referrer", so send just our origin to other sites (the browser default).
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            'script-src': ["'self'", 'https://unpkg.com'],
            'img-src': ["'self'", 'data:', 'https://tile.openstreetmap.org'],
        },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// The page polls twice a minute, so 60 API requests a minute per visitor is plenty
app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
}));

// Serve the map page from the same origin as the API (no CORS needed)
app.use(express.static('public'));
// The Nunito font is installed from npm and served from here, so no outside font service is needed
app.use('/fonts/nunito', express.static('node_modules/@fontsource-variable/nunito/files', { maxAge: '30d' }));

// --- Timetable data that never changes while the app runs: load once, then keep in memory ---
let staticData = null;
async function getStatic() {
    if (!staticData) {
        const [routes, stations] = await Promise.all([db.getRoutes(), db.getStations()]);
        const lines = buildLines(routes);
        const busRoutes = new Set(routes.filter((r) => r.mode === 'bus').map((r) => r.route_id));
        const allStops = await db.getStopIds();
        staticData = {
            routes, stations, lines,
            routeIds: new Set(routes.map((r) => r.route_id)),
            stationIds: new Set(stations.map((s) => s.id)),
            stopIds: new Set(allStops.map((s) => s.stop_id)),
            busRoutes,
            // Trains, tram and ferries only: the station list, the alerts and the stats stay as they were
            mainStations: stations.filter((s) => s.modes.split(',').some((m) => m && m !== 'bus')),
            // The list shown before you type: every train, tram and ferry station plus the busway stations
            // and bus interchanges (Cultural Centre, Roma Street busway...). The 12,000 street stops come up as you type.
            listStations: stations.filter((s) => s.id.startsWith('place_') || s.modes.split(',').some((m) => m && m !== 'bus')),
            mainRouteIds: new Set(routes.filter((r) => r.mode !== 'bus').map((r) => r.route_id)),
            mainLines: lines.filter((l) => l.mode !== 'bus'),
        };
        staticData.landmarks = resolveLandmarks(new Map(stations.map((s) => [s.id, s])));
        staticData.mainStationIds = new Set(staticData.mainStations.map((s) => s.id));
        staticData.mainStopIds = new Set(allStops.filter((s) => staticData.mainStationIds.has(s.station_id)).map((s) => s.stop_id));
    }
    return staticData;
}

// Services on the map with route, next stop and delay. Shared by /api/trains and /api/summary.
// bus = false: trains, tram and ferries. bus = true: buses only (a separate, much bigger feed).
async function getLiveTrains(bus = false) {
    const [vehicles, updates, now, data] = await Promise.all([
        bus ? getBusVehicles() : getVehicles(),
        bus ? getBusTripUpdates() : getTripUpdates(),
        nowSec(),
        getStatic(),
    ]);
    const trips = await db.getTrips(vehicles.data.map((v) => v.tripId).filter(Boolean));
    // Names only for the stops we show (next stop, or where it is now), not every stop in the feed
    const stopIds = new Set();
    for (const v of vehicles.data) {
        if (v.stopId) stopIds.add(v.stopId);
        const next = nextStop(updates.data.get(v.tripId), now, data.stopIds);
        if (next) stopIds.add(next.stopId);
    }
    const stopNames = await db.getStopNames([...stopIds]);
    return {
        updatedAt: new Date(vehicles.updatedAt).toISOString(),
        feedTime: vehicles.feedTime,
        stale: vehicles.stale || updates.stale,
        trains: enrichTrains(vehicles.data, updates.data, trips, stopNames, now, data.stopIds),
    };
}

// Wrap a handler so any error becomes one JSON response instead of a crash
const handle = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        console.error(`[api] ${req.path}:`, err.message || err.code || err);
        res.status(503).json({ error: 'Train data is unavailable right now' });
    }
};

app.get('/api/health', (req, res) => {
    res.json({ ok: true });
});

// Every train on the map. If the feed is down, the last known positions come back with stale: true.
app.get('/api/trains', handle(async (req, res) => {
    res.json(await getLiveTrains(req.query.mode === 'bus'));
}));

// The numbers across the top of the page
// The numbers for the view you're on. ?mode=train|tram|ferry|bus: just that kind of service.
// No mode (All): how many of each are running, buses included (counted from the bus positions feed,
// which is small), and the on-time share of trains, trams and ferries.
app.get('/api/summary', handle(async (req, res) => {
    const mode = String(req.query.mode ?? '');
    if (mode && !['train', 'tram', 'ferry', 'bus'].includes(mode)) return res.status(400).json({ error: 'Unknown mode' });
    const live = await getLiveTrains(mode === 'bus');
    const trains = mode ? live.trains.filter((t) => t.mode === mode) : live.trains;
    const body = { updatedAt: live.updatedAt, feedTime: live.feedTime, stale: live.stale, mode, ...summarize(trains) };
    if (mode) {
        body.byMode = { [mode]: trains.length };
    } else {
        const buses = await getBusVehicles().catch(() => null);
        if (buses) body.byMode.bus = buses.data.length;
        body.onTimeOf = 'trains, trams and ferries';
    }
    res.json(body);
}));

// Lines for the filter: name, TransLink colour and the routes they cover
app.get('/api/lines', handle(async (req, res) => {
    const { lines } = await getStatic();
    res.json(lines.map((l) => ({ name: l.name, mode: l.mode, description: l.description, color: `#${l.color}`, routeIds: l.routeIds })));
}));

// Stations for the picker. Without ?q: train stations, tram stops and ferry terminals (about 250).
// With ?q=…: also search over 12,000 bus stops by name or stop number, best matches first, at most 20.
// Bus stops show their stop number (printed on the sign); busway stations (ids like place_grunbs) say busway
// "Cultural Centre station (bus)", "Boggo Road busway station", "Mains Rd at Nathan (stop 1234)"
const stationLabel = (s) => {
    if (s.modes !== 'bus') return s.name.replace(/ station$/, '');
    if (!s.id.startsWith('place_')) return `${s.name} (stop ${s.id})`;
    return /busway|bus station|interchange/i.test(s.name) ? s.name : `${s.name} (bus)`;
};
app.get('/api/stations', handle(async (req, res) => {
    const { stations, listStations, landmarks } = await getStatic();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    // ?places=1 (the Plan tab): campuses and airports come first, like a map search
    const places = req.query.places === '1' && q.length >= 2
        ? matchLandmarks(landmarks, q).map(({ id, name, modes, lat, lng }) => ({ id, name, modes, lat, lng }))
        : [];
    const out = (s) => ({ id: s.id, name: stationLabel(s), modes: s.modes, lat: s.lat, lng: s.lng });
    if (!q) return res.json(listStations.map(out));
    if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 letters' });
    const matches = stations
        .map((s) => {
            const name = s.name.toLowerCase();
            const rank = s.id === q ? 0 : name.startsWith(q) ? 1 : name.includes(` ${q}`) ? 2 : name.includes(q) ? 3 : -1;
            return { s, rank };
        })
        .filter((m) => m.rank >= 0)
        .sort((a, b) => a.rank - b.rank || (a.s.modes === 'bus') - (b.s.modes === 'bus') || a.s.name.localeCompare(b.s.name))
        .slice(0, 20);
    res.json([...places, ...matches.slice(0, 20 - places.length).map(({ s }) => out(s))]);
}));

// Train + bus: will I make the connection?
// GET /api/connection?trip=<train trip id>&via=sherwood|roma
// Works out when the train really reaches the change station (timetable + live delay), adds the walk,
// and checks the next buses on the route from there (with their own live delays): Make it / Tight / Miss,
// the bus to catch and the one after. Rules and tests: connection.js and docs/connections.md.
// Train + bus at any station (docs/connections.md).
// The bus stations within a short walk of a train station, with the walk for each. Kept per station.
const nearBusCache = new Map();
// With street walks. Each walk the router finds is kept (walk.js caches it); a stop it couldn't route
// to keeps the straight-line estimate and is tried again after 10 minutes, so one bad moment
// (the free router refusing a burst) doesn't stick.
const walkFailedAt = new Map();
async function nearBusWalks(stationId) {
    const { stations } = await getStatic();
    const here = stations.find((s) => s.id === stationId);
    const list = (await nearBusStations(stationId)).map((n) => ({ ...n }));
    // Two at a time: the free router refuses a burst of requests from one place
    const queue = list.filter((n) => !(Date.now() - (walkFailedAt.get(n.id) ?? 0) < 10 * 60 * 1000));
    await Promise.all([0, 1].map(async () => {
        for (let n = queue.shift(); n; n = queue.shift()) {
            try {
                // Along real streets; the router doesn't know stairs, so the 90 s off the platform stay
                const r = await walkRoute(here, n, { distanceM });
                if (r) { n.walkSecs = streetWalkSecs(r.secs); n.streets = true; } else walkFailedAt.set(n.id, Date.now());
            } catch (err) {
                walkFailedAt.set(n.id, Date.now());
                console.error('Walk to bus stop:', err.message);
            }
        }
    }));
    return list;
}
async function nearBusStations(stationId) {
    if (nearBusCache.has(stationId)) return nearBusCache.get(stationId);
    const { stations } = await getStatic();
    const here = stations.find((s) => s.id === stationId);
    const out = [];
    if (here && here.lat !== null) {
        for (const s of stations) {
            if (!s.modes.split(',').includes('bus') || s.lat === null) continue;
            const m = distanceM(here.lat, here.lng, s.lat, s.lng);
            if (m > NEAR_BUS_M) continue;
            out.push({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, walkSecs: walkSecsFor(m), streets: false });
        }
    }
    nearBusCache.set(stationId, out);
    return out;
}

// Where you're going after the bus (optional, any station, stop or place you pick): the stations
// around it. A place like a campus covers 800 m (like the planner); a station or stop, 300 m
// (the other platforms and stops of the same interchange).
async function stationsAround(placeId) {
    const { stations } = await getStatic();
    const id = String(placeId ?? '');
    let centre = null;
    let radius = 300;
    if (id.startsWith(LANDMARK_PREFIX)) {
        const l = LANDMARKS.find((x) => LANDMARK_PREFIX + x.id === id);
        centre = l && stations.find((s) => s.id === l.anchor);
        radius = 800;
    } else centre = stations.find((s) => s.id === id);
    if (!centre || centre.lat === null) return null;
    const name = id.startsWith(LANDMARK_PREFIX) ? LANDMARKS.find((x) => LANDMARK_PREFIX + x.id === id).name : centre.name;
    return { name, ids: stations.filter((s) => s.lat !== null && distanceM(centre.lat, centre.lng, s.lat, s.lng) <= radius).map((s) => s.id) };
}

// Where on this train you could change to a bus: GET /api/connection/places?trip=…
app.get('/api/connection/places', handle(async (req, res) => {
    const stops = await db.getTripStops(String(req.query.trip ?? ''));
    if (stops.length === 0) return res.status(404).json({ error: 'No trip with that id' });
    const places = [];
    for (const s of stops.slice(1)) {
        const near = await nearBusStations(s.station_id);
        if (near.length) places.push({ station: s.station_id, name: s.name.replace(/ station$/, ''), sequence: s.stop_sequence });
    }
    res.json({ places });
}));

// "2026-11-13", 80100 -> "2026-11-13T22:15" (past midnight moves to the next day)
function planTime(date, secs) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCSeconds(Math.max(0, secs));
    return d.toISOString().slice(0, 16);
}

// Every bus leaving near this station after the train gets there:
// GET /api/connection?trip=…&at=<station id>[&to=<station, stop or place id>]. Each with Make it / Tight /
// Miss for its own walk; with to=, only buses that go there, with when they get there.
app.get('/api/connection', handle(async (req, res) => {
    const tripId = String(req.query.trip ?? '');
    const stationId = String(req.query.at ?? '');
    const stops = await db.getTripStops(tripId);
    if (stops.length === 0) return res.status(404).json({ error: 'No trip with that id' });
    const at = stops.find((s) => s.station_id === stationId);
    if (!at) return res.status(400).json({ error: 'This train doesn’t stop there' });
    const near = await nearBusWalks(stationId);
    if (near.length === 0) return res.status(400).json({ error: `No bus stops within a short walk of ${at.name}` });

    const [main, bus, now, dest] = await Promise.all([getTripUpdates(), getBusTripUpdates().catch(() => null), nowSec(), req.query.to ? stationsAround(req.query.to) : null]);
    if (req.query.to && !dest) return res.status(400).json({ error: 'Can’t find where you’re going. Pick it from the list.' });
    const target = dest?.ids ?? [];
    const trainDelay = delayAtStop(main.data.get(tripId), at.stop_sequence).delay;
    const train = { arrivalSecs: at.arrival_secs, delaySecs: trainDelay ?? 0 };
    const arrive = train.arrivalSecs + train.delaySecs;

    // Buses from 5 minutes before the train gets in (a late bus may still be there) to 40 minutes after
    const { date } = brisbaneClock(now);
    const walk = new Map(near.map((n) => [n.id, n]));
    const rows = (await db.getDepartures(near.map((n) => n.id), date, arrive - 300, arrive + 2400, 200))
        .filter((r) => r.mode === 'bus');
    const list = busesAfterTrain(train, rows.map((r) => {
        const st = walk.get(r.station_id);
        return {
            tripId: r.trip_id,
            departSecs: r.secs,
            delaySecs: bus ? delayAtStop(bus.data.get(r.trip_id), r.stop_sequence).delay ?? 0 : 0,
            live: Boolean(bus?.data.get(r.trip_id)),
            walkSecs: st?.walkSecs ?? walkSecsFor(NEAR_BUS_M),
            streets: st ? st.streets : false,
            stopName: st?.name ?? '',
            platform: r.platform,
            sequence: r.stop_sequence,
            route: r.short_name,
            headsign: r.headsign,
            color: `#${r.color}`,
            textColor: `#${r.text_color}`,
        };
    }));
    // Buses you can catch, plus the last two you'd just miss (so a late train shows what it cost you)
    const ok = list.filter((b) => b.status !== 'miss');
    const firstOk = ok.length ? list.indexOf(ok[0]) : list.length;
    const missed = list.slice(0, firstOk).filter((b) => b.status === 'miss').slice(-2);
    const shown = [...missed, ...ok].slice(0, 40);

    // When each bus gets to where you're going (if you said), and only if it goes there
    const calls = await db.getCallsAt([...new Set(shown.map((b) => b.tripId))], [...target, ...near.map((n) => n.id)]);
    const targetSet = new Set(target);
    const arrivesAt = (b) => {
        const mine = calls.filter((c) => c.trip_id === b.tripId);
        const board = mine.find((c) => c.stop_sequence === b.sequence);
        const there = mine.filter((c) => targetSet.has(c.station_id) && c.stop_sequence > b.sequence)
            .sort((x, y) => x.arrival_secs - y.arrival_secs)[0];
        return board && there ? { secs: b.leavesSecs + (there.arrival_secs - board.departure_secs), sequence: there.stop_sequence } : null;
    };

    res.json({
        station: at.name.replace(/ station$/, ''),
        to: dest ? dest.name : null,
        train: {
            tripId,
            arrives: formatSecs(arrive),
            scheduled: formatSecs(train.arrivalSecs),
            delaySecs: trainDelay,
            platform: at.platform,
        },
        buses: shown.map((b) => ({ b, n: target.length ? arrivesAt(b) : null })).filter(({ n }) => !target.length || n !== null).map(({ b, n }) => {
            return {
                tripId: b.tripId,
                route: b.route,
                headsign: b.headsign,
                color: b.color,
                textColor: b.textColor,
                stop: b.stopName,
                platform: b.platform,
                walkMins: Math.round(b.walkSecs / 60),
                scheduled: formatSecs(b.departSecs),
                leaves: formatSecs(b.leavesSecs),
                delaySecs: b.delaySecs,
                live: b.live,
                spareMins: Math.round(b.spareSecs / 60),
                status: b.status,
                arrives: n === null ? null : formatSecs(n.secs),
                offSequence: n === null ? null : n.sequence,
                walkOnStreets: b.streets,
                // For "Plan this trip": leave the platform in time for this bus (Brisbane date and time)
                planAt: planTime(date, b.leavesSecs - b.walkSecs),
            };
        }),
        busLive: Boolean(bus),
    });
}));

// Walking directions along streets for one walk of a journey: ?from=-27.62,152.91&to=-27.63,152.92
// 204 when there's no street route (the page keeps its straight dotted line).
const latLng = (text) => {
    const [lat, lng] = String(text ?? '').split(',').map(Number);
    return lat < -25 && lat > -29 && lng > 151 && lng < 154 ? { lat, lng } : null;
};
app.get('/api/walk', handle(async (req, res) => {
    const from = latLng(req.query.from);
    const to = latLng(req.query.to);
    if (!from || !to) return res.status(400).json({ error: 'from and to must be lat,lng in South East Queensland' });
    try {
        const mode = ['bike', 'car'].includes(req.query.mode) ? req.query.mode : 'walk';
        const route = await walkRoute(from, to, { distanceM, mode });
        if (!route) return res.status(204).end();
        res.set('Cache-Control', 'public, max-age=86400').json(route);
    } catch (err) {
        console.error('Walking route failed:', err.message);
        res.status(204).end();
    }
}));

// Journey planner: from a station or stop (or a position, "near me") to another, leaving at a time.
// ?from=place_spcsta or ?fromLat=-27.6&fromLng=152.9, the same for to, and optional ?at=2026-11-10T07:30
const placeFrom = (q, prefix, stationIds, landmarks) => {
    const lat = Number(q[`${prefix}Lat`]);
    const lng = Number(q[`${prefix}Lng`]);
    if (q[`${prefix}Lat`] !== undefined) {
        // Roughly South East Queensland, so a typo can't send the planner across the world
        if (!(lat < -25 && lat > -29 && lng > 151 && lng < 154)) return null;
        return { lat, lng };
    }
    const id = String(q[prefix] ?? '');
    if (id.startsWith(LANDMARK_PREFIX)) {
        const l = landmarks.find((x) => x.id === id);
        return l ? { lat: l.lat, lng: l.lng, landmark: l.id } : null;
    }
    return stationIds.has(id) ? { stationId: id } : null;
};

app.get('/api/plan', handle(async (req, res) => {
    const { stationIds, landmarks } = await getStatic();
    const from = placeFrom(req.query, 'from', stationIds, landmarks);
    const to = placeFrom(req.query, 'to', stationIds, landmarks);
    if (!from) return res.status(400).json({ error: 'Pick where you are leaving from' });
    if (!to) return res.status(400).json({ error: 'Pick where you are going' });
    if ((from.stationId && from.stationId === to.stationId) || (from.landmark && from.landmark === to.landmark)) return res.status(400).json({ error: 'From and to are the same place' });

    const now = await nowSec();
    let date;
    let secs;
    let past = false;
    if (req.query.at !== undefined) {
        const at = parseLocalTime(String(req.query.at));
        if (!at) return res.status(400).json({ error: 'Pick a date and time' });
        if (at.epoch < now - 7 * 86400 || at.epoch > now + 7 * 86400) {
            return res.status(400).json({ error: 'Pick a time within 7 days of today.' });
        }
        past = at.epoch < now - 300;
        ({ date, secs } = at);
    } else {
        ({ date, secs } = brisbaneClock(now));
    }

    // ?moreTime=1: at least 5 spare minutes at every change
    // ?access=bike|car: how you get to the first stop (only when leaving from a position or place)
    const access = ['bike', 'car'].includes(req.query.access) ? req.query.access : 'walk';
    const options = { extraChangeSecs: req.query.moreTime === '1' ? EXTRA_CHANGE_SECS : 0, access };
    let result = await plan(from, to, date, secs, 5, options);
    // Nothing more tonight: show the first journeys tomorrow morning instead of nothing
    let nextDay = false;
    if (!result.error && result.journeys.length === 0) {
        const d = new Date(`${date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        date = d.toISOString().slice(0, 10);
        secs = 3 * 3600;
        result = await plan(from, to, date, secs, 5, options);
        nextDay = true;
    }
    if (result.error === 'from') return res.json({ journeys: [], note: access === 'walk' ? 'No stop within 800 m of where you are' : `No ${access === 'car' ? 'station' : 'stop'} within ${access === 'car' ? '10 km' : '3 km'} of where you are` });
    if (result.error === 'to') return res.json({ journeys: [], note: 'No stop within 800 m of where you are going' });

    const tripIds = [...new Set(result.journeys.flatMap((j) => j.legs.filter((l) => l.kind === 'ride').map((l) => l.tripId)))];
    const [trips, tripShapes] = await Promise.all([db.getTrips(tripIds), db.getTripShapes(tripIds).catch(() => new Map())]);
    // Live delays: trains, trams and ferries always; buses only when a journey uses one
    const hasBus = [...trips.values()].some((t) => t.mode === 'bus');
    const [main, bus] = await Promise.all([
        getTripUpdates().catch(() => null),
        hasBus ? getBusTripUpdates().catch(() => null) : null,
    ]);
    const updates = new Map([...(main?.data ?? []), ...(bus?.data ?? [])]);

    const journeys = result.journeys.map((j) => describeJourney(j, result.stops, result.patterns, trips, updates, result.shapes, tripShapes));
    // Bus rides the route track didn't fit: follow the roads through their stops instead of
    // straight lines. Trains, trams and ferries keep their stops (rails and water aren't roads).
    await Promise.all(journeys.flatMap((j) => j.legs)
        .filter((l) => l.kind === 'ride' && l.pathFrom === 'stops' && l.mode === 'bus')
        .map(async (l) => {
            const road = await roadPath(l.path).catch(() => null);
            if (road) { l.path = road; l.pathFrom = 'road'; }
        }));

    res.json({
        date,
        at: formatClock(secs),
        nextDay,
        past,
        planned: req.query.at !== undefined,
        stale: Boolean(main?.stale || bus?.stale),
        journeys,
        note: result.journeys.length === 0 ? 'No journey found, today or tomorrow morning. These two places may not be connected by public transport.' : null,
    });
}));

app.get('/api/departures', handle(async (req, res) => {
    const { stationIds } = await getStatic();
    const station = String(req.query.station ?? '');
    if (!stationIds.has(station)) {
        return res.status(400).json({ error: 'Unknown station' });
    }
    // Bus feeds are fetched only for stops that buses use
    const { stations } = await getStatic();
    const hasBus = stations.find((s) => s.id === station)?.modes.includes('bus');
    const [main, mainVehicles, bus, busVehicles, now] = await Promise.all([
        getTripUpdates(), getVehicles(),
        // If the bus feed is down, timetable departures still show (without live bus delays)
        hasBus ? getBusTripUpdates().catch(() => null) : null, hasBus ? getBusVehicles().catch(() => null) : null,
        nowSec(),
    ]);
    const updates = { stale: main.stale || Boolean(bus?.stale), data: bus ? new Map([...main.data, ...bus.data]) : main.data };
    const vehicles = { data: busVehicles ? [...mainVehicles.data, ...busVehicles.data] : mainVehicles.data };

    // Planning ahead: ?at=2026-11-09T18:30 shows the timetable from then, up to a week away
    if (req.query.at !== undefined) {
        const at = parseLocalTime(String(req.query.at));
        if (!at) return res.status(400).json({ error: 'Pick a date and time' });
        if (at.epoch < now - 7 * 86400 || at.epoch > now + 7 * 86400) {
            return res.status(400).json({ error: 'Pick a time within 7 days of today' });
        }
        const rows = await db.getDepartures(station, at.date, at.secs, at.secs + 3 * 3600, 12);
        return res.json({
            station,
            planned: true,
            at: String(req.query.at),
            stale: updates.stale,
            departures: buildBoard(rows, updates.data, at.secs),
        });
    }

    const clock = brisbaneClock(now);
    // The next 2 hours, plus anything from the last 30 minutes that the live feed says is running late
    // (it may not have left yet). Asked for separately: at a busy bus station, 40 buses that already
    // left in the last 30 minutes would otherwise fill the list and leave nothing to show.
    const [upcoming, recent] = await Promise.all([
        db.getDepartures(station, clock.date, clock.secs, clock.secs + 7200, 40),
        db.getDepartures(station, clock.date, clock.secs - 1800, clock.secs - 1, 400),
    ]);
    const rows = [...recent.filter((r) => updates.data.has(r.trip_id)), ...upcoming];
    // Where each of those trains is right now (if it has started its trip)
    const tripIds = new Set(rows.map((r) => r.trip_id));
    const running = vehicles.data.filter((v) => tripIds.has(v.tripId));
    const names = await db.getStopNames(running.map((v) => v.stopId).filter(Boolean));
    const byTrip = new Map(running.map((v) => [v.tripId, {
        stopSequence: v.stopSequence,
        atStop: v.atStop,
        stopName: names.get(v.stopId)?.name?.replace(/ (station|ferry terminal)$/, '') ?? 'the previous stop',
    }]));
    res.json({
        station,
        planned: false,
        stale: updates.stale,
        departures: buildBoard(rows, updates.data, clock.secs, byTrip).slice(0, 8),
    });
}));

// On-time history recorded by scripts/record-delays.js. It only changes every 10 minutes,
// so one copy per number of days is kept for 5 minutes.
const statsCache = new Map();
app.get('/api/stats', handle(async (req, res) => {
    const days = Number(req.query.days ?? 7);
    if (![1, 7, 30].includes(days)) return res.status(400).json({ error: 'days must be 1, 7 or 30' });
    const cached = statsCache.get(days);
    if (cached && Date.now() - cached.at < 5 * 60_000) return res.json(cached.body);

    const [{ mainLines: lines, routes }, now] = await Promise.all([getStatic(), nowSec()]);
    const raw = await db.getDelayStats(serviceDate(now), days, ON_TIME_SEC);
    const routeById = new Map(routes.map((r) => [r.route_id, r]));
    const shape = (r) => ({ trips: r.trips, onTimePercent: percent(r.on_time, r.trips) });
    const clean = (name) => name.replace(/ (station|ferry terminal)$/, '');
    const body = {
        days,
        since: raw.since,
        trips: raw.byDay.reduce((n, d) => n + d.trips, 0),
        lines: statsByLine(raw.byRoute, lines),
        // An hour with only a couple of trips (1 am, say) gives a misleading percentage
        byHour: raw.byHour.filter((h) => h.trips >= 5).map((h) => ({ hour: h.hour, ...shape(h) })),
        byDay: raw.byDay.map((d) => ({ date: d.date, ...shape(d) })),
        worst: raw.worst.map((w) => ({
            time: formatClock(w.start_secs),
            origin: clean(w.origin),
            headsign: clean(w.headsign),
            color: `#${routeById.get(w.route_id)?.color ?? '888888'}`,
            runs: w.runs,
            avgLateMinutes: Math.round(w.avg_delay / 60),
        })),
    };
    statsCache.set(days, { at: Date.now(), body });
    res.json(body);
}));

// Making a connection: if you leave N minutes between your train getting in and the next thing you
// catch, how often would the train have been on time enough, by hour of the day? All lines, or one.
// GET /api/stats/connections?days=7|30&spare=3|5|10[&line=<line name>]
const connCache = new Map();
app.get('/api/stats/connections', handle(async (req, res) => {
    const days = Number(req.query.days ?? 30);
    const spare = Number(req.query.spare ?? 5);
    if (![1, 7, 30].includes(days)) return res.status(400).json({ error: 'days must be 1, 7 or 30' });
    if (![3, 5, 10].includes(spare)) return res.status(400).json({ error: 'spare must be 3, 5 or 10 minutes' });
    const { mainLines } = await getStatic();
    const lineName = req.query.line ? String(req.query.line) : null;
    const line = lineName ? mainLines.find((l) => l.name === lineName) : null;
    if (lineName && !line) return res.status(400).json({ error: 'Unknown line' });
    const key = `${days}|${spare}|${lineName ?? ''}`;
    const cached = connCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return res.json(cached.body);
    const now = await nowSec();
    const rows = await db.getDelaysByHour(serviceDate(now), days, line ? line.routeIds : null);
    const body = {
        days,
        spare,
        line: line ? { name: line.name, color: `#${line.color}` } : null,
        lines: mainLines.filter((l) => l.mode === 'train').map((l) => l.name).sort(),
        trips: rows.length,
        byHour: connectionByHour(rows, spare * 60),
    };
    connCache.set(key, { at: Date.now(), body });
    res.json(body);
}));

// Coloured track lines for the map. The timetable doesn't change while the app runs,
// so browsers may keep this for an hour.
let shapesCache = null;
// Routes that go to or through a place, e.g. /api/places?q=springfield -> { to: [...], via: [...] }
// "to": a destination (headsign) or the route's name matches; "via": one of its stops matches.
let routePlaces = null;
app.get('/api/places', handle(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 letters' });
    const { routes } = await getStatic();
    if (!routePlaces) {
        // Searchable as "Springfield", "526" or "bus 526"
        const names = new Map(routes.map((r) => [r.route_id, `${r.long_name}|${r.short_name}|${r.mode} ${r.short_name}`.toLowerCase()]));
        routePlaces = (await db.getRoutePlaces()).map((r) => ({ id: r.route_id, to: `${r.headsigns}|${names.get(r.route_id) ?? ''}`, via: r.stops }));
    }
    const to = routePlaces.filter((r) => r.to.includes(q)).map((r) => r.id);
    const toSet = new Set(to);
    const via = routePlaces.filter((r) => !toSet.has(r.id) && r.via.includes(q)).map((r) => r.id);
    res.set('Cache-Control', 'public, max-age=3600').json({ to, via });
}));

// Track lines for trains, tram and ferries (drawn all the time). Bus routes are drawn one at a
// time, when you filter to that bus: /api/shapes?route=598-4
app.get('/api/shapes', handle(async (req, res) => {
    const { busRoutes, routeIds } = await getStatic();
    if (!shapesCache) shapesCache = (await db.getRouteShapes()).map((r) => ({ routeId: r.route_id, color: `#${r.color}`, coords: r.coords }));
    res.set('Cache-Control', 'public, max-age=3600');
    if (req.query.route !== undefined) {
        const route = String(req.query.route);
        if (!routeIds.has(route)) return res.status(400).json({ error: 'Unknown route' });
        return res.json(shapesCache.filter((s) => s.routeId === route));
    }
    res.json(shapesCache.filter((s) => !busRoutes.has(s.routeId)));
}));

// Push notifications for Start journey (push.js). Only when the VAPID keys are set (.env / Render).
// A key pasted wrongly turns push off with a message; it never stops the rest of the app starting.
let pushReady = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushReady) {
    try {
        webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://github.com/vy-trg/stopwise', process.env.VAPID_PUBLIC_KEY.trim(), process.env.VAPID_PRIVATE_KEY.trim());
    } catch (err) {
        pushReady = false;
        console.error(`Push alerts are off: ${err.message} Check VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (see .env.example).`);
    }
}
const pushJourneys = new Map(); // id -> { subscription, rides, walkMinsBefore, sent: Set, until }
const MAX_PUSH_JOURNEYS = 500;

app.get('/api/push/key', (req, res) => {
    if (!pushReady) return res.status(404).json({ error: 'Push notifications aren’t set up on this server' });
    res.json({ key: process.env.VAPID_PUBLIC_KEY.trim() });
});
app.post('/api/push/journey', express.json({ limit: '8kb' }), (req, res) => {
    if (!pushReady) return res.status(404).json({ error: 'Push notifications aren’t set up on this server' });
    const j = cleanJourney(req.body);
    if (!j) return res.status(400).json({ error: 'Send a push subscription and the journey’s rides' });
    if (pushJourneys.size >= MAX_PUSH_JOURNEYS) return res.status(503).json({ error: 'Too many journeys being followed right now' });
    // One journey per phone: starting another replaces it
    for (const [id, old] of pushJourneys) if (old.subscription.endpoint === j.subscription.endpoint) pushJourneys.delete(id);
    const id = randomUUID();
    pushJourneys.set(id, { ...j, sent: new Set(), until: Date.now() + 4 * 3600 * 1000 });
    res.status(201).json({ id });
});
// "Send a test alert": the same path as a real one, so you can check notifications reach you
app.post('/api/push/journey/:id/test', async (req, res) => {
    const j = pushJourneys.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'This journey isn’t being followed (start it again)' });
    try {
        await webpush.sendNotification(j.subscription, JSON.stringify({ title: 'Stopwise', body: 'Test alert: this is how your journey alerts will look.', tag: 'rl-test' }), { TTL: 60, urgency: 'high' });
        res.status(204).end();
    } catch (err) {
        console.error('Test push failed:', err.statusCode ?? err.message);
        res.status(502).json({ error: 'The browser’s push service didn’t accept it' });
    }
});
app.delete('/api/push/journey/:id', (req, res) => {
    pushJourneys.delete(req.params.id);
    res.status(204).end();
});

// Every 15 seconds: where each followed ride is, and anything to tell its person
// Where a vehicle really is (its last position report): the stop it's heading to or stopped at
async function vehicleOf(tripId, mode) {
    const feed = await (mode === 'bus' ? getBusVehicles() : getVehicles()).catch(() => null);
    const v = feed?.data.find((x) => x.tripId === tripId);
    return v ? { stopSequence: v.stopSequence, atStop: v.atStop } : null;
}
async function tripProgress(tripId) {
    const [trips, stops] = await Promise.all([db.getTrips([tripId]), db.getTripStops(tripId)]);
    const trip = trips.get(tripId);
    if (!trip || stops.length === 0) return null;
    const empty = { data: new Map() };
    const [updates, now, vehicle] = await Promise.all([trip.mode === 'bus' ? getBusTripUpdates().catch(() => empty) : getTripUpdates().catch(() => empty), nowSec(), vehicleOf(tripId, trip.mode)]);
    const clock = brisbaneClock(now);
    let dayStart = now - clock.secs;
    if (clock.secs < stops[0].departure_secs - 3600 * 4) dayStart -= 86400;
    return { stops: buildTripProgress(stops, updates.data.get(tripId), now, dayStart), vehicle };
}
async function watchPushJourneys() {
    const tripIds = [...new Set([...pushJourneys.values()].flatMap((j) => j.rides.map((r) => r.tripId)))];
    if (tripIds.length === 0) return;
    const progress = new Map();
    const vehicles = new Map();
    for (const id of tripIds) {
        const p = await tripProgress(id).catch(() => null);
        if (p) { progress.set(id, p.stops); if (p.vehicle) vehicles.set(id, p.vehicle); }
    }
    for (const [id, j] of pushJourneys) {
        if (Date.now() > j.until || journeyOver(j.rides, progress, vehicles)) { pushJourneys.delete(id); continue; }
        for (const m of journeyMoments(j.rides, progress, j.walkMinsBefore, vehicles)) {
            if (j.sent.has(m.key)) continue;
            j.sent.add(m.key);
            try {
                await webpush.sendNotification(j.subscription, JSON.stringify({ title: 'Stopwise', body: m.text, tag: m.key }), { TTL: 120, urgency: 'high' });
                console.log(`Push sent: ${m.key}`);
            } catch (err) {
                // 404 / 410: the phone unsubscribed or the browser dropped it; stop following
                if (err.statusCode === 404 || err.statusCode === 410) pushJourneys.delete(id);
                else console.error('Push failed:', err.statusCode ?? err.message);
            }
        }
    }
}
if (pushReady && process.env.NODE_ENV !== 'test') setInterval(() => watchPushJourneys().catch((e) => console.error('Push watch:', e.message)), 15000).unref();

// One train's journey: every stop with scheduled and expected times
app.get('/api/trips/:tripId', handle(async (req, res) => {
    const tripId = req.params.tripId;
    const [trips, stops, shapes] = await Promise.all([db.getTrips([tripId]), db.getTripStops(tripId), db.getTripShapes([tripId]).catch(() => new Map())]);
    const trip = trips.get(tripId);
    if (!trip || stops.length === 0) {
        return res.status(404).json({ error: 'Trip not found' });
    }
    const empty = { data: new Map() };
    const [updates, now, vehicle] = await Promise.all([trip.mode === 'bus' ? getBusTripUpdates().catch(() => empty) : getTripUpdates(), nowSec(), vehicleOf(tripId, trip.mode)]);
    // The service day started at midnight Brisbane time; a trip still running after midnight
    // belongs to yesterday's service day (its times are past 24:00).
    const clock = brisbaneClock(now);
    let dayStart = now - clock.secs;
    if (clock.secs < stops[0].departure_secs - 3600 * 4) dayStart -= 86400;
    const progress = buildTripProgress(stops, updates.data.get(tripId), now, dayStart);
    const fromSeq = Number(req.query.from);
    const toSeq = Number(req.query.to);
    const ride = Number.isInteger(fromSeq) && Number.isInteger(toSeq) ? rideState(progress, vehicle, fromSeq, toSeq) : undefined;
    res.json({
        tripId,
        routeName: trip.long_name,
        routeShort: trip.short_name,
        mode: trip.mode,
        headsign: trip.headsign.replace(/ (station|ferry terminal)$/, ''),
        color: `#${trip.color}`,
        textColor: `#${trip.text_color}`,
        now,
        stops: progress,
        ride,
        // Where the vehicle really is (position report), and, for Start journey (?from=&to= stop
        // sequences), whether you've got on, got off, and how many stops are left
        vehicle,
        // The track the trip really follows (rails, roads, river), when TransLink publishes it
        path: shapes.get(tripId) ?? null,
    });
}));

// Current rail alerts (track closures, lift outages, timetable changes)
app.get('/api/alerts', handle(async (req, res) => {
    const [alerts, now, data] = await Promise.all([getAlerts(), nowSec(), getStatic()]);
    // Trains, tram and ferries only for now; bus stop closures would bury them (there are dozens)
    const main = { routeIds: data.mainRouteIds, stopIds: data.mainStopIds, stationIds: data.mainStationIds, lines: data.mainLines };
    res.json({ stale: alerts.stale, alerts: railAlerts(alerts.data, main, now, isActive) });
}));

app.listen(PORT, () => {
    console.log(`Stopwise running on http://localhost:${PORT}`);
    // Load the journey planner's timetable now, so the first person to plan doesn't wait for it
    if (process.env.NODE_ENV !== 'test') getNetwork().catch((err) => console.error('Planner not loaded yet:', err.message));
});
