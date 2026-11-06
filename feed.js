import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

function decode(buffer) {
    return FeedMessage.decode(new Uint8Array(buffer));
}

// protobuf longs (timestamps) arrive as Long objects; turn them into plain numbers
function num(value) {
    if (value === null || value === undefined) return null;
    return typeof value === 'number' ? value : Number(value);
}

// Seconds since 1970 when TransLink built this feed
export function feedTimestamp(buffer) {
    return num(decode(buffer).header.timestamp);
}

// Decode a GTFS-RT VehiclePositions feed and keep only what the map needs.
export function parseFeed(buffer) {
    const feed = decode(buffer);
    return feed.entity
        .filter((entity) => entity.vehicle && entity.vehicle.position)
        .map((entity) => ({
            id: entity.id,
            tripId: entity.vehicle.trip?.tripId ?? null,
            routeId: entity.vehicle.trip?.routeId || null,
            stopId: entity.vehicle.stopId || null,
            stopSequence: entity.vehicle.currentStopSequence ?? null,
            atStop: entity.vehicle.currentStatus === 1, // STOPPED_AT
            lat: entity.vehicle.position.latitude,
            lng: entity.vehicle.position.longitude,
        }));
}

const SKIPPED = GtfsRealtimeBindings.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;
const CANCELED = GtfsRealtimeBindings.transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;

// Decode a TripUpdates feed: for each trip, the predicted delay at each upcoming stop.
// Delays are in seconds (positive = late). A stop can be skipped and a trip cancelled.
export function parseTripUpdates(buffer) {
    return decode(buffer)
        .entity.filter((e) => e.tripUpdate?.trip?.tripId)
        .map((e) => {
            const tu = e.tripUpdate;
            return {
                tripId: tu.trip.tripId,
                routeId: tu.trip.routeId || null,
                cancelled: tu.trip.scheduleRelationship === CANCELED,
                stops: tu.stopTimeUpdate.map((s) => ({
                    stopId: s.stopId || null,
                    sequence: s.stopSequence ?? null,
                    skipped: s.scheduleRelationship === SKIPPED,
                    // Departure delay if there is one (the train leaving), otherwise arrival
                    delay: s.departure?.delay ?? s.arrival?.delay ?? null,
                    time: num(s.departure?.time) ?? num(s.arrival?.time),
                })),
            };
        });
}

// The English text of a TranslatedString
function text(translated) {
    const list = translated?.translation ?? [];
    return (list.find((t) => t.language?.startsWith('en')) ?? list[0])?.text ?? '';
}

const { Cause, Effect } = GtfsRealtimeBindings.transit_realtime.Alert;
const nameOf = (enumObject, value) => Object.keys(enumObject).find((k) => enumObject[k] === value) ?? null;

// Decode an Alerts feed. Each alert says which routes and stops it affects and when it applies.
export function parseAlerts(buffer) {
    return decode(buffer)
        .entity.filter((e) => e.alert)
        .map((e) => ({
            id: e.id,
            header: text(e.alert.headerText).trim(),
            description: text(e.alert.descriptionText).trim(),
            url: text(e.alert.url) || null,
            cause: nameOf(Cause, e.alert.cause),
            effect: nameOf(Effect, e.alert.effect),
            routeIds: e.alert.informedEntity.map((i) => i.routeId).filter(Boolean),
            stopIds: e.alert.informedEntity.map((i) => i.stopId).filter(Boolean),
            periods: e.alert.activePeriod.map((p) => ({ start: num(p.start), end: num(p.end) })),
        }));
}

// Is the alert in effect at `nowSec`? No periods means always.
export function isActive(alert, nowSec) {
    if (alert.periods.length === 0) return true;
    return alert.periods.some((p) => (!p.start || p.start <= nowSec) && (!p.end || nowSec < p.end));
}
