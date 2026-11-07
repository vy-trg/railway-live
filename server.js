import express from 'express';
import { isActive } from './feed.js';
import { getVehicles, getTripUpdates, getAlerts, nowSec } from './realtime.js';
import * as db from './db/queries.js';
import { buildLines } from './lines.js';
import { enrichTrains, summarize, buildBoard, railAlerts, buildTripProgress } from './live.js';
import { brisbaneClock, parseLocalTime } from './schedule.js';
import helmet from 'helmet';
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
        staticData = {
            routes, stations, lines,
            routeIds: new Set(routes.map((r) => r.route_id)),
            stationIds: new Set(stations.map((s) => s.id)),
            stopIds: new Set(await db.getStopIds()),
        };
    }
    return staticData;
}

// Trains on the map with route, next stop and delay. Shared by /api/trains and /api/summary.
async function getLiveTrains() {
    const [vehicles, updates, now] = await Promise.all([getVehicles(), getTripUpdates(), nowSec()]);
    const trips = await db.getTrips(vehicles.data.map((v) => v.tripId).filter(Boolean));
    const stopIds = new Set();
    for (const v of vehicles.data) {
        if (v.stopId) stopIds.add(v.stopId);
        for (const s of updates.data.get(v.tripId)?.stops ?? []) stopIds.add(s.stopId);
    }
    const stopNames = await db.getStopNames([...stopIds].filter(Boolean));
    return {
        updatedAt: new Date(vehicles.updatedAt).toISOString(),
        feedTime: vehicles.feedTime,
        stale: vehicles.stale || updates.stale,
        trains: enrichTrains(vehicles.data, updates.data, trips, stopNames, now),
    };
}

// Wrap a handler so any error becomes one JSON response instead of a crash
const handle = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        console.error(`[api] ${req.path}:`, err.message);
        res.status(503).json({ error: 'Train data is unavailable right now' });
    }
};

app.get('/api/health', (req, res) => {
    res.json({ ok: true });
});

// Every train on the map. If the feed is down, the last known positions come back with stale: true.
app.get('/api/trains', handle(async (req, res) => {
    res.json(await getLiveTrains());
}));

// The numbers across the top of the page
app.get('/api/summary', handle(async (req, res) => {
    const live = await getLiveTrains();
    res.json({ updatedAt: live.updatedAt, feedTime: live.feedTime, stale: live.stale, ...summarize(live.trains) });
}));

// Lines for the filter: name, TransLink colour and the routes they cover
app.get('/api/lines', handle(async (req, res) => {
    const { lines } = await getStatic();
    res.json(lines.map((l) => ({ name: l.name, color: `#${l.color}`, routeIds: l.routeIds })));
}));

app.get('/api/stations', handle(async (req, res) => {
    const { stations } = await getStatic();
    res.json(stations.map((s) => ({ id: s.id, name: s.name.replace(/ station$/, '') })));
}));

// Next departures from one station for the next 2 hours: timetable + live delays
app.get('/api/departures', handle(async (req, res) => {
    const { stationIds } = await getStatic();
    const station = String(req.query.station ?? '');
    if (!stationIds.has(station)) {
        return res.status(400).json({ error: 'Unknown station' });
    }
    const [updates, vehicles, now] = await Promise.all([getTripUpdates(), getVehicles(), nowSec()]);

    // Planning ahead: ?at=2026-11-09T18:30 shows the timetable from then, up to a week away
    if (req.query.at !== undefined) {
        const at = parseLocalTime(String(req.query.at));
        if (!at) return res.status(400).json({ error: 'Pick a date and time' });
        if (at.epoch < now - 3600 || at.epoch > now + 7 * 86400) {
            return res.status(400).json({ error: 'Pick a time between now and 7 days ahead' });
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
    // Look back 30 minutes so late trains that haven't left yet still show
    const rows = await db.getDepartures(station, clock.date, clock.secs - 1800, clock.secs + 7200, 40);
    // Where each of those trains is right now (if it has started its trip)
    const tripIds = new Set(rows.map((r) => r.trip_id));
    const running = vehicles.data.filter((v) => tripIds.has(v.tripId));
    const names = await db.getStopNames(running.map((v) => v.stopId).filter(Boolean));
    const byTrip = new Map(running.map((v) => [v.tripId, {
        stopSequence: v.stopSequence,
        atStop: v.atStop,
        stopName: names.get(v.stopId)?.name?.replace(/ station$/, '') ?? 'the previous stop',
    }]));
    res.json({
        station,
        planned: false,
        stale: updates.stale,
        departures: buildBoard(rows, updates.data, clock.secs, byTrip).slice(0, 8),
    });
}));

// Coloured track lines for the map. The timetable doesn't change while the app runs,
// so browsers may keep this for an hour.
let shapesJson = null;
app.get('/api/shapes', handle(async (req, res) => {
    if (!shapesJson) {
        const rows = await db.getRouteShapes();
        shapesJson = JSON.stringify(rows.map((r) => ({ routeId: r.route_id, color: `#${r.color}`, coords: r.coords })));
    }
    res.set('Cache-Control', 'public, max-age=3600').type('json').send(shapesJson);
}));

// One train's journey: every stop with scheduled and expected times
app.get('/api/trips/:tripId', handle(async (req, res) => {
    const tripId = req.params.tripId;
    const [trips, stops] = await Promise.all([db.getTrips([tripId]), db.getTripStops(tripId)]);
    const trip = trips.get(tripId);
    if (!trip || stops.length === 0) {
        return res.status(404).json({ error: 'Trip not found' });
    }
    const [updates, now] = await Promise.all([getTripUpdates(), nowSec()]);
    // The service day started at midnight Brisbane time; a trip still running after midnight
    // belongs to yesterday's service day (its times are past 24:00).
    const clock = brisbaneClock(now);
    let dayStart = now - clock.secs;
    if (clock.secs < stops[0].departure_secs - 3600 * 4) dayStart -= 86400;
    res.json({
        tripId,
        routeName: trip.long_name,
        headsign: trip.headsign.replace(/ station$/, ''),
        color: `#${trip.color}`,
        textColor: `#${trip.text_color}`,
        now,
        stops: buildTripProgress(stops, updates.data.get(tripId), now, dayStart),
    });
}));

// Current rail alerts (track closures, lift outages, timetable changes)
app.get('/api/alerts', handle(async (req, res) => {
    const [alerts, now, data] = await Promise.all([getAlerts(), nowSec(), getStatic()]);
    res.json({ stale: alerts.stale, alerts: railAlerts(alerts.data, data, now, isActive) });
}));

app.listen(PORT, () => {
    console.log(`Railway Live running on http://localhost:${PORT}`);
});
