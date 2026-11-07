import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceDate, currentDelay, percent, statsByLine } from '../delays.js';

// 2026-11-09 08:00 in Brisbane = 2026-11-08 22:00 UTC
const BNE_8AM = Date.UTC(2026, 10, 8, 22, 0) / 1000;

test('serviceDate is the Brisbane date, and late-night trains belong to the day before', () => {
    assert.equal(serviceDate(BNE_8AM), '2026-11-09');
    assert.equal(serviceDate(BNE_8AM - 7.5 * 3600), '2026-11-08'); // 12:30 am
    assert.equal(serviceDate(BNE_8AM - 4 * 3600), '2026-11-09'); // 4 am, first trains
});

const stop = (delay, time, skipped = false) => ({ stopId: 's', sequence: 1, skipped, delay, time });

test('currentDelay uses the next stop, or the last stop once the trip is over', () => {
    const tu = { cancelled: false, stops: [stop(30, BNE_8AM - 120), stop(240, BNE_8AM + 60), stop(300, BNE_8AM + 400)] };
    assert.deepEqual(currentDelay(tu, BNE_8AM), { delay: 240, cancelled: false });
    assert.deepEqual(currentDelay(tu, BNE_8AM + 3600), { delay: 300, cancelled: false });
});

test('currentDelay skips skipped stops and stops with no delay', () => {
    const tu = { cancelled: false, stops: [stop(null, BNE_8AM + 10), stop(500, BNE_8AM + 20, true), stop(90, BNE_8AM + 30)] };
    assert.deepEqual(currentDelay(tu, BNE_8AM), { delay: 90, cancelled: false });
    assert.equal(currentDelay({ cancelled: false, stops: [stop(null, BNE_8AM)] }, BNE_8AM), null);
});

test('currentDelay marks cancelled trips', () => {
    assert.deepEqual(currentDelay({ cancelled: true, stops: [] }, BNE_8AM), { delay: 0, cancelled: true });
});

test('percent rounds and handles nothing to count', () => {
    assert.equal(percent(2, 3), 67);
    assert.equal(percent(0, 0), null);
});

test('statsByLine adds up every route on a line and sorts best first', () => {
    const routeRows = [
        { route_id: 'SPCA', trips: 10, on_time: 5, late: 5, late_secs: 1500 },
        { route_id: 'BRSP', trips: 10, on_time: 9, late: 1, late_secs: 120 },
        { route_id: 'BRCL', trips: 4, on_time: 4, late: 0, late_secs: 0 },
    ];
    const lines = [
        { name: 'Springfield', color: '6CC6E9', routeIds: ['SPCA', 'BRSP'] },
        { name: 'Cleveland', color: '4778B2', routeIds: ['BRCL'] },
        { name: 'Doomben', color: '9B60A6', routeIds: ['BRDB'] },
    ];
    assert.deepEqual(statsByLine(routeRows, lines), [
        { name: 'Cleveland', color: '#4778B2', trips: 4, onTimePercent: 100, avgLateMinutes: 0 },
        { name: 'Springfield', color: '#6CC6E9', trips: 20, onTimePercent: 70, avgLateMinutes: 5 },
    ]);
});
