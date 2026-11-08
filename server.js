import express from 'express';
import { isActive } from './feed.js';
import { getVehicles, getTripUpdates, getBusVehicles, getBusTripUpdates, getAlerts, nowSec } from './realtime.js';
import * as db from './db/queries.js';
import { buildLines } from './lines.js';
import { enrichTrains, nextStop, summarize, buildBoard, railAlerts, buildTripProgress } from './live.js';
import { brisbaneClock, parseLocalTime, formatClock } from './schedule.js';
import { serviceDate, statsByLine, percent, ON_TIME_SEC } from './delays.js';
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
            mainRouteIds: new Set(routes.filter((r) => r.mode !== 'bus').map((r) => r.route_id)),
            mainLines: lines.filter((l) => l.mode !== 'bus'),
        };
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
app.get('/api/summary', handle(async (req, res) => {
    const live = await getLiveTrains();
    res.json({ updatedAt: live.updatedAt, feedTime: live.feedTime, stale: live.stale, ...summarize(live.trains) });
}));

// Lines for the filter: name, TransLink colour and the routes they cover
app.get('/api/lines', handle(async (req, res) => {
    const { lines } = await getStatic();
    res.json(lines.map((l) => ({ name: l.name, mode: l.mode, color: `#${l.color}`, routeIds: l.routeIds })));
}));

// Stations for the picker. Without ?q: train stations, tram stops and ferry terminals (about 250).
// With ?q=…: also search over 12,000 bus stops by name or stop number, best matches first, at most 20.
const stationLabel = (s) => (s.modes === 'bus' ? `${s.name} (stop ${s.id})` : s.name.replace(/ station$/, ''));
app.get('/api/stations', handle(async (req, res) => {
    const { stations, mainStations } = await getStatic();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (!q) return res.json(mainStations.map((s) => ({ id: s.id, name: stationLabel(s), modes: s.modes })));
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
    res.json(matches.map(({ s }) => ({ id: s.id, name: stationLabel(s), modes: s.modes })));
}));

// Next departures from one station for the next 2 hours: timetable + live delays
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

// Coloured track lines for the map. The timetable doesn't change while the app runs,
// so browsers may keep this for an hour.
let shapesCache = null;
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

// One train's journey: every stop with scheduled and expected times
app.get('/api/trips/:tripId', handle(async (req, res) => {
    const tripId = req.params.tripId;
    const [trips, stops] = await Promise.all([db.getTrips([tripId]), db.getTripStops(tripId)]);
    const trip = trips.get(tripId);
    if (!trip || stops.length === 0) {
        return res.status(404).json({ error: 'Trip not found' });
    }
    const empty = { data: new Map() };
    const [updates, now] = await Promise.all([trip.mode === 'bus' ? getBusTripUpdates().catch(() => empty) : getTripUpdates(), nowSec()]);
    // The service day started at midnight Brisbane time; a trip still running after midnight
    // belongs to yesterday's service day (its times are past 24:00).
    const clock = brisbaneClock(now);
    let dayStart = now - clock.secs;
    if (clock.secs < stops[0].departure_secs - 3600 * 4) dayStart -= 86400;
    res.json({
        tripId,
        routeName: trip.long_name,
        headsign: trip.headsign.replace(/ (station|ferry terminal)$/, ''),
        color: `#${trip.color}`,
        textColor: `#${trip.text_color}`,
        now,
        stops: buildTripProgress(stops, updates.data.get(tripId), now, dayStart),
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
    console.log(`Railway Live running on http://localhost:${PORT}`);
});
