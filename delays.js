// Pure helpers for recording and summarising how late trains ran. No database here,
// so they're easy to test.
import { brisbaneClock } from './schedule.js';

// Under a minute late counts as on time, the same rule the live list uses
export const ON_TIME_SEC = 60;

// The Brisbane date a trip belongs to. Trains run until about 1 am, and those
// late-night trips belong to the day before, so the day changes over at 3 am.
export function serviceDate(epochSec) {
    return brisbaneClock(epochSec - 3 * 3600).date;
}

// How late a trip is right now: the delay at its next stop, or at its last stop
// once it has finished. Returns null when the feed has no delay for it at all.
export function currentDelay(tripUpdate, epochSec) {
    if (tripUpdate.cancelled) return { delay: 0, cancelled: true };
    const stops = tripUpdate.stops.filter((s) => !s.skipped && s.delay !== null);
    if (stops.length === 0) return null;
    const next = stops.find((s) => s.time !== null && s.time >= epochSec);
    return { delay: (next ?? stops.at(-1)).delay, cancelled: false };
}

// Percentage with no decimals; null when there's nothing to count
export function percent(part, whole) {
    return whole > 0 ? Math.round((part / whole) * 100) : null;
}

// Per-route counts -> per-line numbers. A route belongs to both lines at its ends
// (Springfield - Caboolture counts for Springfield and for Caboolture), as in the live filter.
export function statsByLine(routeRows, lines) {
    return lines
        .map((line) => {
            const ids = new Set(line.routeIds);
            const rows = routeRows.filter((r) => ids.has(r.route_id));
            const trips = rows.reduce((n, r) => n + r.trips, 0);
            const onTime = rows.reduce((n, r) => n + r.on_time, 0);
            const late = rows.reduce((n, r) => n + r.late, 0);
            const lateSecs = rows.reduce((n, r) => n + r.late_secs, 0);
            return {
                name: line.name,
                color: `#${line.color}`,
                trips,
                onTimePercent: percent(onTime, trips),
                avgLateMinutes: late > 0 ? Math.round(lateSecs / late / 60) : 0,
            };
        })
        .filter((l) => l.trips > 0)
        .sort((a, b) => b.onTimePercent - a.onTimePercent || a.name.localeCompare(b.name));
}
