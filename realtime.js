// The three TransLink realtime feeds, each cached for 30 seconds.
// If several requests arrive while a fetch is running, they share that one fetch.
// If the feed fails, the last good copy is returned and marked stale.
import fs from 'node:fs';
import { parseFeed, parseTripUpdates, parseAlerts, feedTimestamp } from './feed.js';

const BASE = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ';
const CACHE_MS = 30_000;
const FETCH_TIMEOUT = 10_000;

// For local development without internet access to TransLink: FEED_FIXTURES=test/fixtures
// reads saved .pb files instead of calling the API (and "now" becomes the time they were saved).
const FIXTURES = process.env.FEED_FIXTURES;

function makeFeed({ name, url, file, parse, cacheMs = CACHE_MS }) {
    const cache = { data: null, updatedAt: 0, feedTime: null };
    let inFlight = null;

    async function load() {
        const buffer = FIXTURES
            ? fs.readFileSync(`${FIXTURES}/${file}`)
            : Buffer.from(await (await checked(fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }))).arrayBuffer());
        return { data: parse(buffer), feedTime: feedTimestamp(buffer) };
    }

    return async function get() {
        if (cache.data && Date.now() - cache.updatedAt < cacheMs) return { ...cache, stale: false };
        if (!inFlight) {
            console.log(`[feed] fetching ${name}`);
            inFlight = load().finally(() => { inFlight = null; });
        }
        try {
            const { data, feedTime } = await inFlight;
            Object.assign(cache, { data, feedTime, updatedAt: Date.now() });
            return { ...cache, stale: false };
        } catch (err) {
            console.error(`[feed] ${name} error:`, err.message);
            if (cache.data) return { ...cache, stale: true }; // keep showing the last good copy
            throw err;
        }
    };
}

async function checked(responsePromise) {
    const res = await responsePromise;
    if (!res.ok) throw new Error(`Feed responded ${res.status} ${res.statusText}`);
    return res;
}

export const getVehicles = makeFeed({
    name: 'vehicle positions',
    url: process.env.FEED_URL || `${BASE}/VehiclePositions/Rail`,
    file: 'vehicle-positions.pb',
    parse: parseFeed,
});

export const getTripUpdates = makeFeed({
    name: 'trip updates',
    url: process.env.TRIP_UPDATES_URL || `${BASE}/TripUpdates/Rail`,
    file: 'trip-updates.pb',
    parse: (buffer) => new Map(parseTripUpdates(buffer).map((t) => [t.tripId, t])),
});

// Alerts change rarely, so 5 minutes is plenty
export const getAlerts = makeFeed({
    name: 'alerts',
    url: process.env.ALERTS_URL || `${BASE}/Alerts`,
    file: 'alerts.pb',
    parse: parseAlerts,
    cacheMs: 5 * 60_000,
});

// "Now" in epoch seconds. With saved fixtures, it's the time the feed was saved,
// so the departure board lines up with the trains in the files.
export async function nowSec() {
    if (!FIXTURES) return Math.floor(Date.now() / 1000);
    return (await getVehicles()).feedTime;
}
