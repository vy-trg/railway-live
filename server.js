import express from 'express';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';

const app = express();
const PORT = process.env.PORT || 3000;

// TransLink GTFS-RT Vehicle Positions URL (no API key required)
const TRANSLINK_URL = process.env.FEED_URL
    || "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Rail";

const CACHE_DURATION = 30_000;   // TransLink refreshes about every 30 seconds
const FETCH_TIMEOUT = 10_000;    // give up on a slow feed after 10 seconds

// Latest decoded feed, kept in memory
const trainCache = { data: null, lastUpdated: 0 };

// If several browsers ask while a fetch is already running, they all wait
// for that one fetch instead of starting their own.
let inFlight = null;

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

// Fetch the feed, decode the protobuf and keep only the fields the map needs
async function fetchTrains() {
    const response = await fetch(TRANSLINK_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!response.ok) {
        throw new Error(`Feed responded ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    return feed.entity
        .filter((entity) => entity.vehicle && entity.vehicle.position)
        .map((entity) => ({
            id: entity.id,
            tripId: entity.vehicle.trip?.tripId ?? null,
            lat: entity.vehicle.position.latitude,
            lng: entity.vehicle.position.longitude,
        }));
}

// Return cached trains if they are fresh, otherwise fetch once and cache
async function getTrains() {
    const age = Date.now() - trainCache.lastUpdated;
    if (trainCache.data && age < CACHE_DURATION) {
        console.log(`[cache] hit (${Math.round(age / 1000)}s old)`);
        return { trains: trainCache.data, stale: false };
    }

    if (!inFlight) {
        console.log('[feed] fetching from TransLink');
        inFlight = fetchTrains().finally(() => { inFlight = null; });
    }
    const trains = await inFlight;
    trainCache.data = trains;
    trainCache.lastUpdated = Date.now();
    return { trains, stale: false };
}

app.get('/api/health', (req, res) => {
    res.json({ ok: true });
});

app.get('/api/trains', async (req, res) => {
    try {
        const { trains, stale } = await getTrains();
        res.json({ updatedAt: new Date(trainCache.lastUpdated).toISOString(), stale, trains });
    } catch (error) {
        console.error('[feed] error:', error.message);

        // Feed is down: keep the map working with the last known positions
        if (trainCache.data) {
            return res.json({
                updatedAt: new Date(trainCache.lastUpdated).toISOString(),
                stale: true,
                trains: trainCache.data,
            });
        }

        // Nothing cached yet, so there is nothing useful to show
        res.status(503).json({ error: 'Train feed is unavailable right now' });
    }
});

app.listen(PORT, () => {
    console.log(`Railway Live running on http://localhost:${PORT}`);
});
