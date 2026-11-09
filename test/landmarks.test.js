import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLandmarks, matchLandmarks, LANDMARKS } from '../landmarks.js';

const stations = new Map(LANDMARKS.map((l, i) => [l.anchor, { id: l.anchor, lat: -27 - i / 100, lng: 153 }]));
const all = resolveLandmarks(stations);

test('every landmark takes its position from its anchor stop', () => {
  assert.equal(all.length, LANDMARKS.length);
  assert.equal(all[0].lat, -27);
  assert.ok(all.every((l) => l.id.startsWith('landmark:')));
});

test('a landmark whose stop is missing from the data is left out', () => {
  const some = resolveLandmarks(new Map([['place_grunbs', { lat: -27.5, lng: 153 }]]));
  assert.deepEqual(some.map((l) => l.name), ['Griffith University – Nathan campus']);
});

test('"griffith" shows every Griffith campus, like a map search', () => {
  const names = matchLandmarks(all, 'griffith').map((l) => l.name);
  assert.equal(names.length, 5);
  assert.ok(names.includes('Griffith University – Gold Coast campus (Southport)'));
});

test('a campus name narrows it down', () => {
  assert.deepEqual(matchLandmarks(all, 'griffith nathan').map((l) => l.id), ['landmark:griffith-nathan']);
  assert.deepEqual(matchLandmarks(all, 'Gold Coast campus').map((l) => l.id), ['landmark:griffith-gold-coast']);
  assert.deepEqual(matchLandmarks(all, 'uq').map((l) => l.id), ['landmark:uq-st-lucia']);
});

test('the airport shows both terminals', () => {
  assert.equal(matchLandmarks(all, 'airport').length, 2);
});

test('nothing typed, nothing matched', () => {
  assert.deepEqual(matchLandmarks(all, '  '), []);
});
