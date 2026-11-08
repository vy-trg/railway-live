// Records how late every running train, bus, tram and ferry is, into trip_delays.
// GitHub Actions runs this every 10 minutes (.github/workflows/record-delays.yml).
// Run it yourself: node --env-file=.env scripts/record-delays.js
import fs from 'node:fs';
import { getAllTripUpdates, nowSec } from '../realtime.js';
import { recordDelays, pruneDelays } from '../db/queries.js';
import { pool } from '../db/pool.js';
import { serviceDate, currentDelay } from '../delays.js';

const KEEP_DAYS = 35;

try {
    // Create trip_delays the first time. Only that table: the timetable tables belong to load-gtfs.js.
    const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
    await pool.query(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS trip_delays')));
    const [updates, now] = await Promise.all([getAllTripUpdates(), nowSec()]);
    const items = [];
    for (const tu of updates.data.values()) {
        const d = currentDelay(tu, now);
        if (d) items.push({ tripId: tu.tripId, ...d });
    }
    const date = serviceDate(now);
    const saved = await recordDelays(date, items);
    const removed = await pruneDelays(KEEP_DAYS);
    console.log(`[record] ${date}: ${items.length} trips in the feed, ${saved} saved, ${removed} old rows removed`);
} catch (err) {
    console.error('[record] failed:', err.message || err.code || err);
    process.exitCode = 1;
} finally {
    await pool.end();
}
