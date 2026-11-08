// The three TransLink realtime feeds (each read for trains, trams and ferries), cached for 30 seconds.
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

// sources: [{ url, file }]. Each source is fetched and parsed; the lists are joined.
// If one source fails (say the ferry feed) the others still show; only all failing is an error.
function makeFeed({ name, sources, parse, merge = (lists) => lists.flat(), cacheMs = CACHE_MS }) {
    const cache = { data: null, updatedAt: 0, feedTime: null };
    let inFlight = null;

    async function loadOne({ url, file }) {
        if (FIXTURES) {
            const p = `${FIXTURES}/${file}`;
            if (!fs.existsSync(p)) return null; // no saved copy for this mode
            const buffer = fs.readFileSync(p);
            return { list: parse(buffer), feedTime: feedTimestamp(buffer) };
        }
        const res = await checked(fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }));
        const buffer = Buffer.from(await res.arrayBuffer());
        return { list: parse(buffer), feedTime: feedTimestamp(buffer) };
    }

    async function load() {
        const results = await Promise.allSettled(sources.map(loadOne));
        const ok = results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
        for (const [i, r] of results.entries()) {
            if (r.status === 'rejected') console.error(`[feed] ${name} (${sources[i].file}) error:`, r.reason?.message);
        }
        if (ok.length === 0) throw results.find((r) => r.status === 'rejected')?.reason ?? new Error(`No ${name} data`);
        return { data: merge(ok.map((r) => r.list)), feedTime: Math.max(...ok.map((r) => r.feedTime ?? 0)) || null };
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

// Train files keep their old names; tram and ferry copies are optional in test/fixtures
const MODES = [['Rail', ''], ['Tram', '-tram'], ['Ferry', '-ferry']];
const sourcesFor = (feed, file, railOverride) => MODES.map(([mode, suffix]) => ({
    url: mode === 'Rail' && railOverride ? railOverride : `${BASE}/${feed}/${mode}`,
    file: `${file}${suffix}.pb`,
}));

export const getVehicles = makeFeed({
    name: 'vehicle positions',
    sources: sourcesFor('VehiclePositions', 'vehicle-positions', process.env.FEED_URL),
    parse: parseFeed,
});

export const getTripUpdates = makeFeed({
    name: 'trip updates',
    sources: sourcesFor('TripUpdates', 'trip-updates', process.env.TRIP_UPDATES_URL),
    parse: parseTripUpdates,
    merge: (lists) => new Map(lists.flat().map((t) => [t.tripId, t])),
});

// Buses: over a thousand at peak, and a much bigger feed. Kept separate so they are only fetched
// when someone asks for buses (the Buses view, a bus stop's departures, a bus journey).
export const getBusVehicles = makeFeed({
    name: 'bus positions',
    sources: [{ url: `${BASE}/VehiclePositions/Bus`, file: 'vehicle-positions-bus.pb' }],
    parse: parseFeed,
});

export const getBusTripUpdates = makeFeed({
    name: 'bus trip updates',
    sources: [{ url: `${BASE}/TripUpdates/Bus`, file: 'trip-updates-bus.pb' }],
    parse: parseTripUpdates,
    merge: (lists) => new Map(lists.flat().map((t) => [t.tripId, t])),
});

// Trip updates for every mode, for the delay recorder. If the bus feed fails, the rest is still recorded.
export async function getAllTripUpdates() {
    const empty = { stale: true, data: new Map() };
    const [main, bus] = await Promise.all([getTripUpdates(), getBusTripUpdates().catch(() => empty)]);
    return { stale: main.stale || bus.stale, data: new Map([...main.data, ...bus.data]) };
}

// Alerts change rarely, so 5 minutes is plenty
export const getAlerts = makeFeed({
    name: 'alerts',
    sources: [{ url: process.env.ALERTS_URL || `${BASE}/Alerts`, file: 'alerts.pb' }],
    parse: parseAlerts,
    cacheMs: 5 * 60_000,
});

// "Now" in epoch seconds. With saved fixtures, it's the time the feed was saved,
// so the departure board lines up with the trains in the files.
export async function nowSec() {
    if (!FIXTURES) return Math.floor(Date.now() / 1000);
    return (await getVehicles()).feedTime;
}
