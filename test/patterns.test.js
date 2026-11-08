import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPatterns } from '../patterns.js';

const at = (h, m) => h * 3600 + m * 60;

test('trips with the same stops and gaps share one pattern, each keeps its own start time', () => {
    const byTrip = new Map([
        ['7am', [[1, 'A', at(7, 0), at(7, 0)], [2, 'B', at(7, 5), at(7, 6)], [3, 'C', at(7, 12), at(7, 12)]]],
        ['8am', [[1, 'A', at(8, 0), at(8, 0)], [2, 'B', at(8, 5), at(8, 6)], [3, 'C', at(8, 12), at(8, 12)]]],
    ]);
    const { patternStops, tripPattern, patternCount } = buildPatterns(byTrip);
    assert.equal(patternCount, 1);
    assert.deepEqual(tripPattern.get('7am'), [1, at(7, 0)]);
    assert.deepEqual(tripPattern.get('8am'), [1, at(8, 0)]);
    assert.deepEqual(patternStops, [
        [1, 1, 'A', 0, 0, false],
        [1, 2, 'B', 300, 360, false],
        [1, 3, 'C', 720, 720, true],
    ]);
});

test('a different gap or a skipped stop makes a new pattern', () => {
    const byTrip = new Map([
        ['normal', [[1, 'A', 0, 0], [2, 'B', 300, 300]]],
        ['slower', [[1, 'A', 0, 0], [2, 'B', 420, 420]]], // peak hour: 7 minutes instead of 5
        ['express', [[1, 'A', 0, 0], [3, 'C', 600, 600]]],
    ]);
    assert.equal(buildPatterns(byTrip).patternCount, 3);
});

test('stop times are put in stop_sequence order, and times past midnight work', () => {
    const byTrip = new Map([['late', [[2, 'B', at(24, 10), at(24, 10)], [1, 'A', at(23, 55), at(23, 55)]]]]);
    const { patternStops, tripPattern } = buildPatterns(byTrip);
    assert.deepEqual(tripPattern.get('late'), [1, at(23, 55)]);
    assert.deepEqual(patternStops.map((p) => [p[1], p[3], p[5]]), [[1, 0, false], [2, 900, true]]);
});
