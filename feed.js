import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

// Decode a GTFS-RT VehiclePositions feed and keep only what the map needs.
export function parseFeed(buffer) {
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
    return feed.entity
        .filter((entity) => entity.vehicle && entity.vehicle.position)
        .map((entity) => ({
            id: entity.id,
            tripId: entity.vehicle.trip?.tripId ?? null,
            latitude: entity.vehicle.position.latitude,
            lng: entity.vehicle.position.longitude,
        }));
}