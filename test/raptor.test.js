import test from 'node:test';
import assert from 'node:assert/strict';
import { raptor, planJourneys, buildStopPatterns, distanceM, walkSecs, MIN_CHANGE_SECS } from '../raptor.js';

const t = (h, m) => h * 3600 + m * 60;

// A small made-up network:
//
//   Train T:  A(0) -> B(1) -> C(2)            10 min between stops
//   Bus  X:   C(2) -> D(3)                    15 min
//   Bus  Y:   B(1) -> E(4)                    5 min, then walk E -> D (4 min)
//   Ferry F:  A(0) -> D(3)                    60 min, slow but direct
const patterns = [
  { routeId: 'T', stops: [0, 1, 2], arr: [0, 600, 1200], dep: [0, 600, 1200], last: [false, false, true] },
  { routeId: 'X', stops: [2, 3], arr: [0, 900], dep: [0, 900], last: [false, true] },
  { routeId: 'Y', stops: [1, 4], arr: [0, 300], dep: [0, 300], last: [false, true] },
  { routeId: 'F', stops: [0, 3], arr: [0, 3600], dep: [0, 3600], last: [false, true] },
];
const stopCount = 5;
const footpaths = Array.from({ length: stopCount }, () => []);
footpaths[4].push([3, 240]);
footpaths[3].push([4, 240]);
const network = { stopCount, patterns, stopPatterns: buildStopPatterns(patterns, stopCount), footpaths };

const trips = [
  { starts: [t(7, 0), t(7, 30)], tripIds: ['T700', 'T730'] },
  { starts: [t(7, 25), t(7, 55)], tripIds: ['X725', 'X755'] },
  { starts: [t(7, 5)], tripIds: ['Y705'] }, // leaves B before the 7:00 train gets there
  { starts: [t(7, 5)], tripIds: ['F705'] },
];

const rides = (j) => j.legs.filter((l) => l.kind === 'ride').map((l) => l.tripId);

test('direct: one vehicle when there is one', () => {
  const [j] = raptor(network, trips, [{ stop: 0, secs: t(6, 55) }], new Map([[2, 0]]));
  assert.deepEqual(rides(j), ['T700']);
  assert.equal(j.arriveSecs, t(7, 20));
});

test('a change: train then bus, catching the first bus that leaves after the train arrives', () => {
  const results = raptor(network, trips, [{ stop: 0, secs: t(6, 55) }], new Map([[3, 0]]));
  const best = results[results.length - 1];
  // T700 reaches C at 7:20; X725 leaves C at 7:25
  assert.deepEqual(rides(best), ['T700', 'X725']);
  assert.equal(best.arriveSecs, t(7, 40));
});

test('fewer changes are kept when they arrive later (ferry first, then the faster train + bus)', () => {
  const results = raptor(network, trips, [{ stop: 0, secs: t(6, 55) }], new Map([[3, 0]]));
  assert.deepEqual(results.map(rides), [['F705'], ['T700', 'X725']]);
});

test('walking between stops is part of a journey', () => {
  // Starting at B: bus Y to E at 7:10, then a 4-minute walk to D
  const results = raptor(network, trips, [{ stop: 1, secs: t(7, 0) }], new Map([[3, 0]]));
  const j = results[0];
  assert.deepEqual(rides(j), ['Y705']);
  assert.deepEqual(j.legs.map((l) => l.kind), ['ride', 'walk']);
  assert.equal(j.arriveSecs, t(7, 14));
});

test('a minute is allowed to change vehicles at the same stop', () => {
  // T700 reaches C at 7:20; a bus leaving at exactly 7:20 can't be caught, 7:21 can
  const tight = [...trips];
  tight[1] = { starts: [t(7, 20), t(7, 21)], tripIds: ['X720', 'X721'] };
  const results = raptor(network, tight, [{ stop: 0, secs: t(6, 55) }], new Map([[3, 0]]));
  assert.deepEqual(rides(results[results.length - 1]), ['T700', 'X721']);
  assert.equal(MIN_CHANGE_SECS, 60);
});

test('walking from the last stop to the destination is added at the end', () => {
  const [j] = raptor(network, trips, [{ stop: 0, secs: t(6, 55) }], new Map([[2, 180]]));
  assert.equal(j.arriveSecs, t(7, 23));
  assert.equal(j.legs[j.legs.length - 1].kind, 'walk');
});

test('nothing runs: no journey', () => {
  assert.deepEqual(raptor(network, trips, [{ stop: 0, secs: t(23, 0) }], new Map([[3, 0]])), []);
});

test('a stop you can only get off at is never boarded', () => {
  // C is the train's last stop, so starting at C you can't ride T anywhere
  const results = raptor(network, trips, [{ stop: 2, secs: t(7, 0) }], new Map([[0, 0]]));
  assert.deepEqual(results, []);
});

test('ride legs say when you get on and off', () => {
  const results = raptor(network, trips, [{ stop: 0, secs: t(6, 55) }], new Map([[3, 0]]));
  const [train, bus] = results[results.length - 1].legs;
  assert.equal(train.departSecs, t(7, 0));
  assert.equal(train.arriveSecs, t(7, 20));
  assert.equal(train.stopCount, 2);
  assert.equal(bus.departSecs, t(7, 25));
});

test('planJourneys gives later options too, without repeats', () => {
  const journeys = planJourneys(network, trips, [{ stop: 0, secs: t(6, 55) }], new Map([[3, 0]]), { count: 4 });
  const keys = journeys.map((j) => rides(j).join('>'));
  assert.ok(keys.includes('T700>X725'));
  assert.ok(keys.includes('T730>X755'));
  assert.equal(new Set(keys).size, keys.length);
  for (let i = 1; i < journeys.length; i += 1) assert.ok(journeys[i - 1].arriveSecs <= journeys[i].arriveSecs);
});

test('distance and walking time', () => {
  // Roma Street to Central is about 750 m in a straight line
  const m = distanceM(-27.4655, 153.0193, -27.4662, 153.0260);
  assert.ok(m > 600 && m < 800);
  assert.equal(walkSecs(125), 120); // 125 m * 1.2 / 1.25 m/s
  assert.equal(walkSecs(5), 30);
});
