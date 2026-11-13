import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, readyAt, planConnection, formatSecs, CHANGES } from '../connection.js';

const t = (h, m) => h * 3600 + m * 60; // 7:30 -> seconds after midnight

// ---------- Make it / Tight / Miss ----------

test('make it: the bus leaves 3 minutes or more after you are ready', () => {
  assert.equal(classify(t(7, 30), t(7, 33)), 'make');
  assert.equal(classify(t(7, 30), t(7, 45)), 'make');
});

test('tight: 0 to 3 minutes to spare', () => {
  assert.equal(classify(t(7, 30), t(7, 32)), 'tight');
  assert.equal(classify(t(7, 30), t(7, 30)), 'tight'); // leaving exactly as you get there
});

test('miss: the bus leaves before you are ready', () => {
  assert.equal(classify(t(7, 30), t(7, 29)), 'miss');
});

// ---------- When you reach the bus stop ----------

test('ready = scheduled arrival + train delay + walk', () => {
  assert.equal(readyAt(t(7, 20), 120, 180), t(7, 25));
});

test('an early train (negative delay) gets you there earlier', () => {
  assert.equal(readyAt(t(7, 20), -60, 180), t(7, 22));
});

test('no delay known counts as on time', () => {
  assert.equal(readyAt(t(7, 20), undefined, 180), t(7, 23));
});

// ---------- One trip ----------

const buses598 = [
  { tripId: 'b2', departSecs: t(7, 55), arriveSecs: t(8, 18) },
  { tripId: 'b1', departSecs: t(7, 25), arriveSecs: t(7, 48) },
];

test('on time at Sherwood: catch the 7:25 bus with 2 minutes spare (tight)', () => {
  const p = planConnection({ arrivalSecs: t(7, 20), delaySecs: 0 }, CHANGES.sherwood.walkSecs, buses598);
  assert.equal(p.readySecs, t(7, 23));
  assert.equal(p.catch.tripId, 'b1');
  assert.equal(p.verdict, 'tight');
  assert.equal(p.waitSecs, 120);
  assert.equal(p.next.tripId, 'b2');
});

test('train 4 minutes late: miss the 7:25, the next bus is 7:55', () => {
  const p = planConnection({ arrivalSecs: t(7, 20), delaySecs: 240 }, CHANGES.sherwood.walkSecs, buses598);
  assert.equal(p.verdict, 'miss');
  assert.equal(p.planned.tripId, 'b1');
  assert.equal(p.catch.tripId, 'b2');
  assert.equal(p.catch.status, 'make');
  assert.equal(p.waitSecs, t(7, 55) - t(7, 27));
});

test('the bus running late saves the connection', () => {
  const buses = [{ tripId: 'b1', departSecs: t(7, 25), delaySecs: 240 }];
  const p = planConnection({ arrivalSecs: t(7, 20), delaySecs: 240 }, 180, buses);
  assert.equal(p.catch.leavesSecs, t(7, 29));
  assert.equal(p.verdict, 'tight');
});

test('options come back sorted by when the bus really leaves', () => {
  const buses = [
    { tripId: 'a', departSecs: t(7, 25), delaySecs: 600 },
    { tripId: 'b', departSecs: t(7, 30) },
  ];
  const p = planConnection({ arrivalSecs: t(7, 0), delaySecs: 0 }, 180, buses);
  assert.deepEqual(p.options.map((o) => o.tripId), ['b', 'a']);
});

test('no more buses tonight: nothing to catch', () => {
  const p = planConnection({ arrivalSecs: t(23, 0), delaySecs: 0 }, 180, buses598);
  assert.equal(p.catch, null);
  assert.equal(p.verdict, 'none');
  assert.equal(p.waitSecs, null);
});

test('after midnight: GTFS times past 24:00 still compare correctly', () => {
  const buses = [{ tripId: 'late', departSecs: t(24, 10) }];
  const p = planConnection({ arrivalSecs: t(23, 58), delaySecs: 0 }, 240, buses);
  assert.equal(p.verdict, 'make');
  assert.equal(formatSecs(p.catch.leavesSecs), '12:10 am');
});

// ---------- Display ----------

test('formatSecs shows a 12-hour clock', () => {
  assert.equal(formatSecs(t(7, 5)), '7:05 am');
  assert.equal(formatSecs(t(12, 0)), '12:00 pm');
  assert.equal(formatSecs(t(0, 30)), '12:30 am');
  assert.equal(formatSecs(t(17, 45)), '5:45 pm');
});

// ---------- Any bus at any station ----------
import { walkSecsFor, busesAfterTrain } from '../connection.js';

test('walk to a nearby stop: 90 s off the platform plus about a second a metre, whole minutes', () => {
  assert.equal(walkSecsFor(0), 2 * 60);
  assert.equal(walkSecsFor(150), 4 * 60);
  assert.equal(walkSecsFor(400), 9 * 60);
});

test('every bus after the train, each judged with the walk to its own stop', () => {
  const train = { arrivalSecs: t(8, 0), delaySecs: 120 }; // really 8:02
  const list = busesAfterTrain(train, [
    { tripId: 'far', departSecs: t(8, 8), walkSecs: 7 * 60 }, // ready 8:09: miss
    { tripId: 'near', departSecs: t(8, 5), walkSecs: 2 * 60 }, // ready 8:04: tight
    { tripId: 'late', departSecs: t(8, 3), delaySecs: 300, walkSecs: 2 * 60 }, // leaves 8:08: make
  ]);
  assert.deepEqual(list.map((b) => [b.tripId, b.status]), [['near', 'tight'], ['late', 'make'], ['far', 'miss']]);
});

test('a bus calling at two nearby stops is shown once, at the stop where you can catch it', () => {
  const train = { arrivalSecs: t(8, 0), delaySecs: 0 };
  const list = busesAfterTrain(train, [
    { tripId: 'x', departSecs: t(8, 3), walkSecs: 4 * 60, stop: 'A' }, // miss at A
    { tripId: 'x', departSecs: t(8, 6), walkSecs: 3 * 60, stop: 'B' }, // tight at B
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].stop, 'B');
});
