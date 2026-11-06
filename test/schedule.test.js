import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGtfsTime, parseGtfsDate, describeDelay, delayLevel } from '../schedule.js';

test('GTFS times become seconds after midnight, including after midnight services', () => {
    assert.equal(parseGtfsTime('00:00:00'), 0);
    assert.equal(parseGtfsTime('22:24:00'), 80640);
    assert.equal(parseGtfsTime('25:10:30'), 90630);
    assert.throws(() => parseGtfsTime('7am'));
});

test('GTFS dates become ISO dates', () => {
    assert.equal(parseGtfsDate('20261106'), '2026-11-06');
    assert.throws(() => parseGtfsDate('6/11/2026'));
});

test('delays read like a departure board', () => {
    assert.equal(describeDelay(0), 'On time');
    assert.equal(describeDelay(29), 'On time');
    assert.equal(describeDelay(185), '3 min late');
    assert.equal(describeDelay(-70), '1 min early');
    assert.equal(describeDelay(null), 'No delay info yet');
});

test('delay levels: on time up to 1 min, late up to 5, then very late', () => {
    assert.equal(delayLevel(60), 'ontime');
    assert.equal(delayLevel(61), 'late');
    assert.equal(delayLevel(300), 'late');
    assert.equal(delayLevel(301), 'verylate');
    assert.equal(delayLevel(-120), 'ontime');
    assert.equal(delayLevel(null), 'unknown');
});

import { simplify } from '../geo.js';

test('simplify keeps the ends and the corners, drops points on a straight line', () => {
    const line = [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3], [2, 3]];
    assert.deepEqual(simplify(line, 0.01), [[0, 0], [0, 3], [2, 3]]);
    assert.deepEqual(simplify([[0, 0], [1, 1]], 0.01), [[0, 0], [1, 1]]);
});
