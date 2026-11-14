import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journeyMoments, journeyOver, cleanJourney } from '../push.js';

const bus = { tripId: 'B', mode: 'bus', line: 'bus 468', headsign: 'Oxley', fromName: 'Station Rd', fromPlatform: '', toName: 'Indooroopilly Shopping Centre', fromSeq: 3, toSeq: 7, depart: '3:42 pm' };
const train = { tripId: 'T', mode: 'train', line: 'Springfield line', headsign: 'Caboolture', fromName: 'Springfield', fromPlatform: '2', toName: 'Indooroopilly', fromSeq: 1, toSeq: 9, depart: '3:12 pm' };
// stops 1..10; the vehicle is at index `at` (next), eta 90 s per stop from there
// (the next stop is 90 s away, so "arriving now" isn't due unless a test says so)
const stopsAt = (at, n = 10) => Array.from({ length: n }, (_, i) => ({ sequence: i + 1, state: i < at ? 'passed' : i === at ? 'next' : 'upcoming', etaSec: (i - at + 1) * 90 }));

test('2 minutes before it leaves: get on, with the platform', () => {
  const m = journeyMoments([train], new Map([['T', stopsAt(0).map((s) => ({ ...s, etaSec: s.etaSec + 10 }))]]));
  assert.deepEqual(m, [{ key: 'board-T', text: 'Your Springfield line to Caboolture leaves Springfield from platform 2 in 2 mins.' }]);
});

test('train: next stop; bus: 2 stops before and next stop, with the bell', () => {
  assert.equal(journeyMoments([train], new Map([['T', stopsAt(8)]]))[0].text, 'Next stop: get off at Indooroopilly. Get ready.');
  assert.deepEqual(journeyMoments([train], new Map([['T', stopsAt(7)]])), [], 'not 2 stops before for a train');
  assert.match(journeyMoments([bus], new Map([['B', stopsAt(5)]]))[0].text, /^2 stops to go.*after the next stop/);
  assert.match(journeyMoments([bus], new Map([['B', stopsAt(6)]]))[0].text, /^Next stop.*bell now/);
});

test('late enough to miss the change: a warning about the next ride', () => {
  const t = stopsAt(5); // train arrives at stop 9 in 4 stops = 360 s
  const b = stopsAt(0).map((s) => ({ ...s, etaSec: s.sequence === 3 ? 300 : s.etaSec + 1000 })); // bus leaves stop 3 in 300 s
  const m = journeyMoments([train, bus], new Map([['T', t], ['B', b]]), [0, 2]);
  assert.ok(m.some((x) => x.key === 'miss-B'));
});

test('over once the last ride has got to its stop', () => {
  assert.equal(journeyOver([train], new Map([['T', stopsAt(9)]])), true);
  assert.equal(journeyOver([train], new Map([['T', stopsAt(5)]])), false);
});

test('what the page sends is checked', () => {
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } };
  assert.equal(cleanJourney({ subscription: { endpoint: 'http://x', keys: sub.keys }, rides: [train] }), null, 'https only');
  assert.equal(cleanJourney({ subscription: sub, rides: [] }), null, 'no rides');
  const c = cleanJourney({ subscription: sub, rides: [{ ...train, mode: 'rocket', headsign: 'x'.repeat(500) }] });
  assert.equal(c.rides[0].mode, 'train');
  assert.equal(c.rides[0].headsign.length, 80);
});

test('arriving now: a second nudge to get on and to get off (on top of the earlier ones)', () => {
  const nearBoard = stopsAt(0).map((s) => ({ ...s, etaSec: s.sequence === 1 ? 20 : s.etaSec + 20 }));
  const keys = journeyMoments([train], new Map([['T', nearBoard]])).map((m) => m.key);
  assert.deepEqual(keys.sort(), ['board-T', 'board-now-T']);
  const nearOff = stopsAt(8).map((s) => ({ ...s, etaSec: s.sequence === 9 ? 25 : s.etaSec }));
  const off = journeyMoments([train], new Map([['T', nearOff]]));
  assert.ok(off.some((m) => m.key === 'off-now-T' && m.text === 'Get off now: Indooroopilly.'));
  assert.ok(off.some((m) => m.key === 'off-T-1'), 'the "next stop" one is still there');
});
