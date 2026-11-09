
// ---------- One ride's part of the track ----------
import test from 'node:test';
import assert from 'node:assert/strict';
import { slicePath } from '../geo.js';

// A road going east then north: 10 points about 110 m apart
const road = [
  [-27.5, 153.000], [-27.5, 153.001], [-27.5, 153.002], [-27.5, 153.003], [-27.5, 153.004],
  [-27.499, 153.004], [-27.498, 153.004], [-27.497, 153.004], [-27.496, 153.004], [-27.495, 153.004],
];

test('slicePath follows the road between the stops, with the turn', () => {
  const path = slicePath(road, [[-27.5, 153.001], [-27.4975, 153.004]]);
  assert.ok(path.some(([lat, lng]) => lat === -27.5 && lng === 153.004), 'keeps the corner');
  assert.deepEqual(path[0], [-27.5, 153.001]);
  assert.deepEqual(path[path.length - 1], [-27.4975, 153.004]);
});

test('slicePath works for the other direction of the same road', () => {
  const path = slicePath(road, [[-27.496, 153.004], [-27.5, 153.002]]);
  assert.ok(path.some(([lat, lng]) => lat === -27.5 && lng === 153.004));
  assert.ok(path.length >= 5);
});

test('slicePath: a stop far from the track means another variant: null, not a wrong line', () => {
  assert.equal(slicePath(road, [[-27.5, 153.001], [-27.51, 153.02]]), null);
});

test('slicePath: stops out of order along the track: null', () => {
  // middle stop is before the first one along the road, in both directions it doesn't fit
  assert.equal(slicePath(road, [[-27.5, 153.003], [-27.5, 153.0], [-27.496, 153.004]]), null);
});
