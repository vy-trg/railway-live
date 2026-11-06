// Joins realtime data (where trains are, how late they are) with the timetable
// (route names, stations, scheduled times). Pure functions, so they are unit-tested.
import { delayAtStop, delayLevel, describeDelay, formatClock } from './schedule.js';

// The next stop a train hasn't left yet, with its delay
export function nextStop(tripUpdate, nowSec) {
    if (!tripUpdate) return null;
    return tripUpdate.stops.find((s) => !s.skipped && s.time !== null && s.time >= nowSec - 30) ?? null;
}

// One map marker per train: position + route + where it's heading + how late
export function enrichTrains(vehicles, tripUpdates, trips, stopNames, nowSec) {
    return vehicles.map((v) => {
        const trip = trips.get(v.tripId);
        const tu = tripUpdates.get(v.tripId);
        const next = nextStop(tu, nowSec);
        const delay = next?.delay ?? null;
        const stopId = next?.stopId ?? v.stopId;
        return {
            id: v.id,
            tripId: v.tripId,
            lat: v.lat,
            lng: v.lng,
            routeId: trip?.route_id ?? v.routeId,
            routeName: trip?.long_name ?? 'Unknown route',
            headsign: trip?.headsign?.replace(/ station$/, '') ?? null,
            color: trip ? `#${trip.color}` : '#888888',
            textColor: trip ? `#${trip.text_color}` : '#FFFFFF',
            nextStop: stopNames.get(stopId)?.name?.replace(/ station$/, '') ?? null,
            delaySec: delay,
            delayText: describeDelay(delay),
            level: delayLevel(delay),
        };
    });
}

// The numbers across the top: trains running, share on time, average delay of late trains,
// and the route that is furthest behind right now. Only trains with delay info count.
export function summarize(trains) {
    const known = trains.filter((t) => t.delaySec !== null);
    const late = known.filter((t) => t.delaySec > 60);
    const byRoute = new Map();
    for (const t of known) {
        const r = byRoute.get(t.routeName) ?? { name: t.routeName, color: t.color, total: 0, count: 0 };
        r.total += t.delaySec;
        r.count += 1;
        byRoute.set(t.routeName, r);
    }
    const worst = [...byRoute.values()].sort((a, b) => b.total / b.count - a.total / a.count)[0];
    return {
        running: trains.length,
        withDelayInfo: known.length,
        onTimePercent: known.length ? Math.round(((known.length - late.length) / known.length) * 100) : null,
        avgLateMinutes: late.length ? Math.round((late.reduce((s, t) => s + t.delaySec, 0) / late.length / 60) * 10) / 10 : 0,
        mostDelayed: worst && worst.total / worst.count > 60
            ? { name: worst.name, color: worst.color, minutes: Math.round(worst.total / worst.count / 60) }
            : null,
    };
}

// Scheduled departures + realtime = what the departure board shows
export function buildBoard(rows, tripUpdates, nowClockSecs) {
    return rows
        .map((r) => {
            const tu = tripUpdates.get(r.trip_id);
            const { delay, skipped } = delayAtStop(tu, r.stop_sequence);
            const cancelled = Boolean(tu?.cancelled) || skipped;
            const expected = delay === null ? r.secs : r.secs + delay;
            return {
                tripId: r.trip_id,
                scheduled: formatClock(r.secs),
                expected: delay === null || Math.abs(delay) < 60 ? null : formatClock(expected),
                expectedSecs: expected,
                delaySec: delay,
                status: cancelled ? 'cancelled' : delay === null ? 'scheduled' : delayLevel(delay),
                statusText: cancelled ? 'Cancelled' : delay === null ? 'Scheduled' : describeDelay(delay),
                headsign: r.headsign.replace(/ station$/, ''),
                routeName: r.long_name,
                color: `#${r.color}`,
                textColor: `#${r.text_color}`,
                platform: r.platform,
            };
        })
        .filter((d) => d.expectedSecs >= nowClockSecs - 60); // already gone (late trains stay until they leave)
}

const EFFECTS = {
    NO_SERVICE: 'No service', REDUCED_SERVICE: 'Reduced service', SIGNIFICANT_DELAYS: 'Delays',
    DETOUR: 'Detour', ADDITIONAL_SERVICE: 'Extra services', MODIFIED_SERVICE: 'Timetable change',
    STOP_MOVED: 'Stop moved', ACCESSIBILITY_ISSUE: 'Accessibility', OTHER_EFFECT: 'Notice', UNKNOWN_EFFECT: 'Notice',
};

// Rail alerts only (they name a rail route, platform or station), newest periods first
export function railAlerts(alerts, { routeIds, stopIds, stationIds, lines }, nowSec, isActive) {
    return alerts
        .filter((a) => isActive(a, nowSec))
        .filter((a) => a.routeIds.some((id) => routeIds.has(id)) || a.stopIds.some((id) => stopIds.has(id) || stationIds.has(id)))
        .map((a) => ({
            id: a.id,
            header: a.header,
            description: a.description,
            url: a.url,
            effect: EFFECTS[a.effect] ?? 'Notice',
            severe: ['NO_SERVICE', 'SIGNIFICANT_DELAYS', 'REDUCED_SERVICE'].includes(a.effect),
            lines: lines.filter((l) => l.routeIds.some((id) => a.routeIds.includes(id))).map((l) => ({ name: l.name, color: `#${l.color}` })),
        }))
        .sort((a, b) => Number(b.severe) - Number(a.severe));
}
