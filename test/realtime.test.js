// Tests against real TransLink feeds saved on 6 Nov 2026 at 10:35pm (test/fixtures)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFeed, parseTripUpdates, parseAlerts, isActive, feedTimestamp } from '../feed.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

test('vehicle positions from TransLink have trip, route and stop ids', () => {
    const trains = parseFeed(fixture('vehicle-positions.pb'));
    assert.ok(trains.length > 10);
    for (const t of trains) {
        assert.match(t.routeId, /-5$/); // rail route ids end in -5
        assert.ok(t.lat < -26 && t.lat > -28.5, 'in South East Queensland');
    }
});

test('trip updates give a delay in seconds for each upcoming stop', () => {
    const trips = parseTripUpdates(fixture('trip-updates.pb'));
    assert.equal(trips.length, 89);
    const trip = trips.find((t) => t.tripId === '39838740-QR 26_27-44668-DW43');
    assert.equal(trip.routeId, 'BRSH-5');
    assert.equal(trip.stops[0].stopId, '600366');
    assert.equal(trip.stops[0].delay, 97); // departure delay wins over arrival delay (67)
    assert.equal(trip.stops.at(-1).delay, 92); // last stop only has an arrival
});

test('skipped stops are marked', () => {
    const trips = parseTripUpdates(fixture('trip-updates.pb'));
    assert.ok(trips.some((t) => t.stops.some((s) => s.skipped)));
});

test('alerts have English text, affected routes and active periods', () => {
    const alerts = parseAlerts(fixture('alerts.pb'));
    assert.equal(alerts.length, 75);
    const a = alerts.find((x) => x.id === '500656');
    assert.equal(a.header, 'Evening track closures - Shorncliffe line');
    assert.equal(a.effect, 'REDUCED_SERVICE');
    assert.equal(a.cause, 'MAINTENANCE');
    assert.ok(a.routeIds.includes('BRSH-5'));
    assert.equal(a.url, 'https://translink.com.au/updates/500656');
});

test('isActive checks the alert periods', () => {
    const alert = { periods: [{ start: 100, end: 200 }] };
    assert.equal(isActive(alert, 150), true);
    assert.equal(isActive(alert, 200), false);
    assert.equal(isActive({ periods: [] }, 1), true);
    assert.equal(isActive({ periods: [{ start: 100, end: null }] }, 999), true);
});

test('feedTimestamp reads the feed header time', () => {
    assert.equal(feedTimestamp(fixture('trip-updates.pb')), 1793968510);
});
