import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFootpaths, buildPatternList, buildTripTable, placeToStops, describeJourney, PLATFORM_CHANGE_SECS } from '../planner.js';

// Roma Street station (two platforms), the busway about 150 m away, and Central about 750 m away
const stops = [
  { id: 'p1', stationId: 'place_romsta', name: 'Roma Street station', platform: '1', lat: -27.4655, lng: 153.0193 },
  { id: 'p2', stationId: 'place_romsta', name: 'Roma Street station', platform: '2', lat: -27.4655, lng: 153.0193 },
  { id: 'bw', stationId: 'place_rompl', name: 'Roma Street busway station', platform: null, lat: -27.4648, lng: 153.0206 },
  { id: 'ce', stationId: 'place_censta', name: 'Central station', platform: null, lat: -27.4662, lng: 153.0260 },
];

test('footpaths: platforms of one station are a platform change apart', () => {
  const fp = buildFootpaths(stops);
  assert.deepEqual(fp[0].find(([to]) => to === 1), [1, PLATFORM_CHANGE_SECS]);
});

test('footpaths: a nearby stop is a walk, a far one is not', () => {
  const fp = buildFootpaths(stops);
  const toBusway = fp[0].find(([to]) => to === 2);
  assert.ok(toBusway && toBusway[1] >= PLATFORM_CHANGE_SECS && toBusway[1] < 300);
  assert.equal(fp[0].find(([to]) => to === 3), undefined); // 750 m: too far to count as a change
});

test('patterns keep stops, stop sequences and offsets in order', () => {
  const index = new Map(stops.map((s, i) => [s.id, i]));
  const [p] = buildPatternList([
    { pattern_id: 7, stop_sequence: 1, stop_id: 'p1', arr_offset: 0, dep_offset: 0, is_last: false },
    { pattern_id: 7, stop_sequence: 2, stop_id: 'ce', arr_offset: 180, dep_offset: 200, is_last: true },
  ], index);
  assert.deepEqual(p, { id: 7, stops: [0, 3], seq: [1, 2], arr: [0, 180], dep: [0, 200], last: [false, true] });
});

test('trip table: sorted by start, yesterday\'s late trips (negative times) first', () => {
  const table = buildTripTable([
    { pattern_id: 7, start_secs: 3600, trip_id: 'b', route_id: 'R' },
    { pattern_id: 7, start_secs: -600, trip_id: 'late', route_id: 'R' },
    { pattern_id: 99, start_secs: 0, trip_id: 'unknown pattern', route_id: 'R' },
  ], new Map([[7, 0]]), 1);
  assert.deepEqual(table[0].starts, [-600, 3600]);
  assert.deepEqual(table[0].tripIds, ['late', 'b']);
});

test('placeToStops: a station starts from all its platforms with no walk', () => {
  const byStation = new Map([['place_romsta', [0, 1]]]);
  assert.deepEqual(placeToStops({ stationId: 'place_romsta' }, stops, byStation), [{ stop: 0, walk: 0 }, { stop: 1, walk: 0 }]);
});

test('placeToStops: near me finds stops within 800 m, with the walk', () => {
  const near = placeToStops({ lat: -27.4650, lng: 153.0200 }, stops, new Map());
  assert.ok(near.length >= 3);
  assert.ok(near.every((n) => n.walk > 0));
  assert.deepEqual(placeToStops({ lat: -27.6, lng: 152.9 }, stops, new Map()), []);
});

// ---------- What the page gets ----------

const patterns = [
  { stops: [0, 1], seq: [1, 9], arr: [0, 1800], dep: [0, 1800], last: [false, true] },
  { stops: [2, 3], seq: [1, 5], arr: [0, 900], dep: [0, 900], last: [false, true] },
];
const trips = new Map([
  ['T', { headsign: 'Roma Street station', short_name: 'SPBR', long_name: 'Springfield - Bowen Hills', mode: 'train', color: '0071CD', text_color: 'FFFFFF' }],
  ['M', { headsign: 'Eight Mile Plains', short_name: 'M1', long_name: 'Metro', mode: 'bus', color: '000000', text_color: 'FFFFFF' }],
]);
// Train 7:00 -> 7:30, walk 2 min, Metro 7:35 -> 7:50
const journey = {
  arriveSecs: 28200,
  legs: [
    { kind: 'ride', pattern: 0, tripId: 'T', fromStop: 0, toStop: 1, fromPos: 0, toPos: 1, departSecs: 25200, arriveSecs: 27000, stopCount: 1 },
    { kind: 'walk', fromStop: 1, toStop: 2, secs: 120 },
    { kind: 'ride', pattern: 1, tripId: 'M', fromStop: 2, toStop: 3, fromPos: 0, toPos: 1, departSecs: 27300, arriveSecs: 28200, stopCount: 1 },
  ],
};
const update = (delay) => ({ cancelled: false, stops: [{ sequence: 1, delay, skipped: false }] });

test('describeJourney: on time, the change is Make it (3 min spare)', () => {
  const d = describeJourney(journey, stops, patterns, trips, new Map());
  assert.equal(d.leave, '7:00 am');
  assert.equal(d.arrive, '7:50 am');
  assert.equal(d.minutes, 50);
  assert.equal(d.changes, 1);
  assert.equal(d.legs[2].change, 'make');
  assert.equal(d.legs[0].headsign, 'Roma Street');
  assert.equal(d.risky, null);
});

test('describeJourney: a 4-minute late train turns the change into a Miss', () => {
  const d = describeJourney(journey, stops, patterns, trips, new Map([['T', update(240)]]));
  assert.equal(d.legs[0].statusText, '4 mins late');
  assert.equal(d.legs[0].arriveExpected, '7:34 am');
  assert.equal(d.legs[2].change, 'miss');
  assert.equal(d.risky, 'miss');
  assert.equal(d.live, true);
  assert.equal(d.legs[0].live, true);
  assert.equal(d.legs[2].live, false);
});

test('describeJourney: arriving late is worked out from the last vehicle', () => {
  const d = describeJourney(journey, stops, patterns, trips, new Map([['M', update(120)]]));
  assert.equal(d.lateBySec, 120);
  assert.equal(d.arriveExpected, '7:52 am');
});

test('describeJourney: no live data at all says so', () => {
  const d = describeJourney(journey, stops, patterns, trips, new Map());
  assert.equal(d.live, false);
  assert.equal(d.lateBySec, 0);
});

test('describeJourney: a 2-minute late train makes it Tight', () => {
  const d = describeJourney(journey, stops, patterns, trips, new Map([['T', update(120)]]));
  assert.equal(d.legs[2].change, 'tight');
  assert.equal(d.risky, 'tight');
});

test('describeJourney: a cancelled vehicle is flagged', () => {
  const d = describeJourney(journey, stops, patterns, trips, new Map([['M', { cancelled: true, stops: [] }]]));
  assert.equal(d.legs[2].status, 'cancelled');
  assert.equal(d.risky, 'miss');
});

// ---------- Getting to the first stop: walk, bike or car ----------
import { ACCESS } from '../planner.js';

const spread = [
  { id: 'near', stationId: '1001', name: 'Bus stop 300 m', lat: -27.6000, lng: 152.9030, modes: 'bus' },
  { id: 'mid', stationId: 'place_x', name: 'Busway 2 km', lat: -27.6000, lng: 152.9200, modes: 'bus' },
  { id: 'far', stationId: 'place_y', name: 'Train station 6 km', lat: -27.6000, lng: 152.9610, modes: 'train' },
];
const me = { lat: -27.6000, lng: 152.9000 };

test('walk: only stops within 800 m', () => {
  assert.deepEqual(placeToStops(me, spread, new Map()).map((o) => o.stop), [0]);
});

test('bike or scooter: stops within 3 km, faster than walking, plus a minute to lock up', () => {
  const bike = placeToStops(me, spread, new Map(), 800, 'bike');
  assert.deepEqual(bike.map((o) => o.stop), [0, 1]);
  const walk = placeToStops(me, spread, new Map())[0].walk;
  assert.ok(bike[0].walk < walk);
  assert.ok(bike[0].walk >= ACCESS.bike.extraSecs);
});

test('car: stations within 10 km, never a kerbside bus stop, with 3 minutes to park', () => {
  const car = placeToStops(me, spread, new Map(), 800, 'car');
  assert.deepEqual(car.map((o) => o.stop), [1, 2]);
  assert.ok(car.every((o) => o.walk >= 180));
});

test('leaving from a station: how you get there doesn\'t matter', () => {
  const byStation = new Map([['place_y', [2]]]);
  assert.deepEqual(placeToStops({ stationId: 'place_y' }, spread, byStation, 800, 'car'), [{ stop: 2, walk: 0 }]);
});

// ---------- Tidy legs: nothing that reads as nonsense ----------
import { tidyLegs } from '../planner.js';

const st = [
  { stationId: 'A' }, { stationId: 'A' }, { stationId: 'B' }, { stationId: 'C' },
];
const ride = (from, to) => ({ kind: 'ride', fromStop: from, toStop: to });

test('two walks in a row become one walk', () => {
  const legs = tidyLegs([{ kind: 'walk', fromStop: null, toStop: 2, secs: 720 }, { kind: 'walk', fromStop: 2, toStop: 3, secs: 360 }, ride(3, 0)], st);
  assert.equal(legs.length, 2);
  assert.deepEqual([legs[0].toStop, legs[0].secs], [3, 1080]);
});

test('a few seconds of walking at the end (place on the stop itself) is dropped', () => {
  const legs = tidyLegs([ride(2, 3), { kind: 'walk', fromStop: 3, toStop: null, secs: 30 }], st);
  assert.equal(legs.length, 1);
});

test('a real walk at the end stays', () => {
  assert.equal(tidyLegs([ride(2, 3), { kind: 'walk', fromStop: 3, toStop: null, secs: 300 }], st).length, 2);
});

test('walking between platforms of one station is a platform change', () => {
  const legs = tidyLegs([ride(2, 0), { kind: 'walk', fromStop: 0, toStop: 1, secs: 120 }, ride(1, 3)], st);
  assert.equal(legs[1].platformChange, true);
});
