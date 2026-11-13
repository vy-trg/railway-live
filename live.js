// Joins realtime data (where trains are, how late they are) with the timetable
// (route names, stations, scheduled times). Pure functions, so they are unit-tested.
import { delayAtStop, delayLevel, describeDelay, formatClock, UNLIKELY_DELAY_SEC } from './schedule.js';

// The next stop a train hasn't left yet, with its delay
// `known` (optional): stop ids passengers use. The tram feed also lists turnbacks and
// driver relief points, which aren't in our timetable and shouldn't show as "Next".
export function nextStop(tripUpdate, nowSec, known) {
    if (!tripUpdate) return null;
    return tripUpdate.stops.find((s) => !s.skipped && s.time !== null && s.time >= nowSec - 30 && (!known || known.has(s.stopId))) ?? null;
}

// One map marker per train: position + route + where it's heading + how late
// knownStops (optional): every stop id passengers use. Defaults to the stops we have names for.
export function enrichTrains(vehicles, tripUpdates, trips, stopNames, nowSec, knownStops = stopNames) {
    return vehicles.map((v) => {
        const trip = trips.get(v.tripId);
        const tu = tripUpdates.get(v.tripId);
        const next = nextStop(tu, nowSec, knownStops);
        const delay = next?.delay ?? null;
        const stopId = next?.stopId ?? v.stopId;
        return {
            id: v.id,
            tripId: v.tripId,
            lat: v.lat,
            lng: v.lng,
            routeId: trip?.route_id ?? v.routeId,
            routeName: trip?.long_name ?? 'Unknown route',
            routeShort: trip?.short_name ?? null,
            mode: trip?.mode ?? 'train',
            headsign: trip?.headsign?.replace(/ (station|ferry terminal)$/, '') ?? null,
            color: trip ? `#${trip.color}` : '#888888',
            textColor: trip ? `#${trip.text_color}` : '#FFFFFF',
            nextStop: stopNames.get(stopId)?.name?.replace(/ (station|ferry terminal)$/, '') ?? null,
            delaySec: delay,
            delayText: describeDelay(delay),
            level: delayLevel(delay),
        };
    });
}

// The numbers across the top: trains running, share on time, average delay of late trains,
// and the route that is furthest behind right now. Only trains with delay info count,
// and delays over 2 hours (usually a data problem) are left out so one can't skew the average.
export function summarize(trains) {
    const known = trains.filter((t) => t.delaySec !== null && t.delaySec <= UNLIKELY_DELAY_SEC);
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
        byMode: Object.fromEntries(['train', 'tram', 'ferry', 'bus'].map((m) => [m, trains.filter((t) => t.mode === m).length]).filter(([m, n]) => m !== 'bus' || n > 0)),
        withDelayInfo: known.length,
        onTimePercent: known.length ? Math.round(((known.length - late.length) / known.length) * 100) : null,
        avgLateMinutes: late.length ? Math.round((late.reduce((s, t) => s + t.delaySec, 0) / late.length / 60) * 10) / 10 : 0,
        mostDelayed: worst && worst.total / worst.count > 60
            ? { name: worst.name, color: worst.color, minutes: Math.round(worst.total / worst.count / 60) }
            : null,
    };
}

// Scheduled departures + realtime = what the departure board shows
// Where a train is compared with the station you're waiting at, like "At Richlands · 2 stops away".
// Stops away counts the stops the train still has to reach, including yours.
// vehicle: { stopSequence, atStop, stopName } from the live feed (stopSequence = the stop it's at or heading to).
export function trainLocation(vehicle, stopSequence) {
    if (!vehicle || vehicle.stopSequence === null || vehicle.stopSequence === undefined) return null;
    const away = stopSequence - vehicle.stopSequence + (vehicle.atStop ? 0 : 1);
    if (away < 0) return null; // already past this station
    if (away === 0) return 'At the platform';
    if (away === 1 && !vehicle.atStop) return 'Arriving';
    const where = vehicle.atStop ? `At ${vehicle.stopName}` : `Heading to ${vehicle.stopName}`;
    return `${where} · ${away} stop${away === 1 ? '' : 's'} away`;
}

export function buildBoard(rows, tripUpdates, nowClockSecs, vehicles = new Map()) {
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
                headsign: r.headsign.replace(/ (station|ferry terminal)$/, ''),
                routeName: r.long_name,
                routeShort: r.short_name,
                mode: r.mode,
                color: `#${r.color}`,
                textColor: `#${r.text_color}`,
                platform: r.platform,
                location: cancelled ? null : trainLocation(vehicles.get(r.trip_id), r.stop_sequence),
                minutesAway: Math.max(0, Math.round((expected - nowClockSecs) / 60)),
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

// Every stop of one trip for the "journey" panel: passed stops, the next stop, and the rest,
// each with its scheduled time and (when known) the expected time.
// serviceStartEpoch = midnight (Brisbane) of the trip's service day, in epoch seconds.
export function buildTripProgress(stops, tripUpdate, nowSec, serviceStartEpoch) {
    let nextFound = false;
    return stops.map((s) => {
        const { delay, skipped } = delayAtStop(tripUpdate, s.stop_sequence);
        const scheduledEpoch = serviceStartEpoch + s.departure_secs;
        const expectedEpoch = scheduledEpoch + (delay ?? 0);
        let state = 'upcoming';
        if (skipped) state = 'skipped';
        else if (expectedEpoch < nowSec - 30) state = 'passed';
        else if (!nextFound) { state = 'next'; nextFound = true; }
        return {
            sequence: s.stop_sequence,
            stationId: s.station_id,
            name: s.name.replace(/ (station|ferry terminal)$/, ''),
            platform: s.platform,
            lat: s.lat ?? null,
            lng: s.lng ?? null,
            // Seconds until the train is expected here; the page uses it for "remind me" alerts
            etaSec: expectedEpoch - nowSec,
            scheduled: formatClock(s.departure_secs),
            expected: delay === null || Math.abs(delay) < 60 ? null : formatClock(s.departure_secs + delay),
            delaySec: delay,
            state,
        };
    });
}
