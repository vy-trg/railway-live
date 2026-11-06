import { test } from 'node:test';
import assert from 'node:assert/strict';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { parseFeed } from '../feed.js';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

// Build a real protobuf feed, the same format TransLink sends
function makeFeed(entity) {
    const message = FeedMessage.create({
        header: { gtfsRealtimeVersion: '2.0', timestamp: 1730000000 },
        entity,
    });
    return FeedMessage.encode(message).finish();
}

test('turns a vehicle into { id, tripId, routeId, stopId, lat, lng }', () => {
    const buffer = makeFeed([
        { id: 'v1', vehicle: { trip: { tripId: 'T1' }, position: { latitude: -27.466, longitude: 153.026 } } },
    ]);
    const trains = parseFeed(buffer);

    assert.equal(trains.length, 1);
    assert.deepEqual(Object.keys(trains[0]).sort(), ['id', 'lat', 'lng', 'routeId', 'stopId', 'tripId']);
    assert.equal(trains[0].id, 'v1');
    assert.equal(trains[0].tripId, 'T1');
    // Coordinates are 32-bit floats in protobuf, so compare with a small tolerance
    assert.ok(Math.abs(trains[0].lat - -27.466) < 1e-4);
    assert.ok(Math.abs(trains[0].lng - 153.026) < 1e-4);
});

test('skips entities that have no position', () => {
    const buffer = makeFeed([
        { id: 'no-pos', vehicle: { trip: { tripId: 'T2' } } },
        { id: 'alert-only' },
        { id: 'ok', vehicle: { position: { latitude: -27.5, longitude: 153.0 } } },
    ]);
    const trains = parseFeed(buffer);

    assert.deepEqual(trains.map((t) => t.id), ['ok']);
});

test('uses null when a vehicle has no trip', () => {
    const buffer = makeFeed([{ id: 'v3', vehicle: { position: { latitude: -27.5, longitude: 153.0 } } }]);
    assert.equal(parseFeed(buffer)[0].tripId, null);
});

test('returns an empty list for a feed with no trains', () => {
    assert.deepEqual(parseFeed(makeFeed([])), []);
});

test('throws on data that is not a valid feed', () => {
    assert.throws(() => parseFeed(Buffer.from([0xff, 0xff, 0xff, 0xff])));
});