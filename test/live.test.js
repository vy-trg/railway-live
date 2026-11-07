import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLines } from '../lines.js';
import { summarize, buildBoard, nextStop } from '../live.js';
import { delayAtStop, brisbaneClock, formatClock } from '../schedule.js';

const routes = [
    { route_id: 'BRSP-5', long_name: 'Brisbane City - Springfield', color: '6CC6E9' },
    { route_id: 'SPCA-5', long_name: 'Springfield - Caboolture', color: '27855A' },
    { route_id: 'IPSP-5', long_name: 'Ipswich - Springfield', color: '6CC6E9' },
    { route_id: 'BNBN-5', long_name: 'Beenleigh - Beenleigh', color: 'D53E45' },
];

test('a line covers every route that starts or ends there, coloured like most of them', () => {
    const lines = buildLines(routes);
    const springfield = lines.find((l) => l.name === 'Springfield');
    assert.deepEqual(springfield.routeIds, ['BRSP-5', 'SPCA-5', 'IPSP-5']);
    assert.equal(springfield.color, '6CC6E9');
    assert.ok(!lines.some((l) => l.name === 'Brisbane City'));
    assert.deepEqual(lines.find((l) => l.name === 'Beenleigh').routeIds, ['BNBN-5']); // no duplicates
});

const update = {
    tripId: 'T1',
    stops: [
        { stopId: 'A', sequence: 3, delay: 120, time: 1000, skipped: false },
        { stopId: 'B', sequence: 5, delay: 240, time: 2000, skipped: true },
    ],
};

test('a delay carries on to later stops until a new one is given', () => {
    assert.deepEqual(delayAtStop(update, 2), { delay: null, skipped: false });
    assert.deepEqual(delayAtStop(update, 4), { delay: 120, skipped: false });
    assert.deepEqual(delayAtStop(update, 5), { delay: 240, skipped: true });
    assert.deepEqual(delayAtStop(undefined, 5), { delay: null, skipped: false });
});

test('the next stop is the first one the train has not passed and does not skip', () => {
    assert.equal(nextStop(update, 900).stopId, 'A');
    assert.equal(nextStop(update, 1500), null); // B is skipped
});

test('the board shows late times, cancellations, and hides trains that have left', () => {
    const rows = [
        { trip_id: 'T1', stop_sequence: 4, secs: 36000, headsign: 'Springfield Central station', long_name: 'x', color: '6CC6E9', text_color: '1D1D1D', platform: '1' },
        { trip_id: 'T1', stop_sequence: 5, secs: 36600, headsign: 'Springfield Central station', long_name: 'x', color: '6CC6E9', text_color: '1D1D1D', platform: '1' },
        { trip_id: 'T2', stop_sequence: 1, secs: 30000, headsign: 'Roma Street station', long_name: 'y', color: '27855A', text_color: 'FFFFFF', platform: '2' },
    ];
    const board = buildBoard(rows, new Map([['T1', update]]), 35000);
    assert.equal(board.length, 2); // T2 left at 30000
    assert.equal(board[0].scheduled, '10:00 am');
    assert.equal(board[0].expected, '10:02 am');
    assert.equal(board[0].status, 'late');
    assert.equal(board[0].headsign, 'Springfield Central');
    assert.equal(board[1].status, 'cancelled'); // skipped at this stop
});

test('summary: on-time share, average lateness and the most delayed route', () => {
    const trains = [
        { routeName: 'A', color: '#1', delaySec: 0 },
        { routeName: 'A', color: '#1', delaySec: 30 },
        { routeName: 'B', color: '#2', delaySec: 300 },
        { routeName: 'C', color: '#3', delaySec: null },
    ];
    const s = summarize(trains);
    assert.equal(s.running, 4);
    assert.equal(s.withDelayInfo, 3);
    assert.equal(s.onTimePercent, 67);
    assert.equal(s.avgLateMinutes, 5);
    assert.deepEqual(s.mostDelayed, { name: 'B', color: '#2', minutes: 5 });
});

test('Brisbane clock is UTC+10 all year', () => {
    assert.deepEqual(brisbaneClock(1793968510), { date: '2026-11-06', secs: 81310 });
    assert.equal(formatClock(81310), '10:35 pm');
    assert.equal(formatClock(86400 + 600), '12:10 am');
});

import { buildTripProgress } from '../live.js';

test('journey panel marks passed, next and skipped stops', () => {
    const stops = [
        { stop_sequence: 1, departure_secs: 100, name: 'Springfield Central station', platform: '1' },
        { stop_sequence: 2, departure_secs: 200, name: 'Springfield station', platform: '2' },
        { stop_sequence: 3, departure_secs: 300, name: 'Richlands station', platform: '1' },
        { stop_sequence: 4, departure_secs: 400, name: 'Darra station', platform: '3' },
    ];
    const tu = { stops: [{ sequence: 2, delay: 120, skipped: false }, { sequence: 3, delay: 120, skipped: true }] };
    const progress = buildTripProgress(stops, tu, 250, 0);
    assert.deepEqual(progress.map((p) => p.state), ['passed', 'next', 'skipped', 'upcoming']);
    assert.equal(progress[0].name, 'Springfield Central');
    assert.equal(progress[1].expected, '12:05 am'); // 200 s + 2 min late
});

import { trainLocation } from '../live.js';

test('where the train is compared with your station', () => {
    assert.equal(trainLocation({ stopSequence: 5, atStop: true, stopName: 'Richlands' }, 7), 'At Richlands · 2 stops away');
    assert.equal(trainLocation({ stopSequence: 6, atStop: false, stopName: 'Darra' }, 7), 'Heading to Darra · 2 stops away');
    assert.equal(trainLocation({ stopSequence: 7, atStop: true, stopName: 'Darra' }, 7), 'At the platform');
    assert.equal(trainLocation({ stopSequence: 7, atStop: false, stopName: 'Darra' }, 7), 'Arriving');
    assert.equal(trainLocation({ stopSequence: 9, atStop: true, stopName: 'Oxley' }, 7), null); // already gone
    assert.equal(trainLocation(undefined, 7), null); // not started yet
});

test('journey stops say how many seconds until the train gets there', () => {
    const stops = [{ stop_sequence: 1, departure_secs: 600, name: 'A station', platform: '1' }];
    assert.equal(buildTripProgress(stops, { stops: [{ sequence: 1, delay: 60, skipped: false }] }, 300, 0)[0].etaSec, 360);
});

test('trams and ferries: each route is its own line, listed after the train lines', () => {
    const lines = buildLines([
        ...routes,
        { route_id: 'F11-18', short_name: 'F11', long_name: 'Apollo Road / Riverside', color: '61C5C9', mode: 'ferry' },
        { route_id: 'F1-18', short_name: 'F1', long_name: 'Northshore Hamilton / UQ St Lucia', color: '61C5C9', mode: 'ferry' },
        { route_id: 'L1-32', short_name: 'L1', long_name: 'Helensvale - Burleigh Heads', color: 'FFC425', mode: 'tram' },
    ]);
    assert.deepEqual(lines.slice(-3).map((l) => [l.name, l.mode, l.routeIds]), [
        ['G:link', 'tram', ['L1-32']],
        ['Ferry F1', 'ferry', ['F1-18']],
        ['Ferry F11', 'ferry', ['F11-18']], // F1 before F11: numbers sort as numbers
    ]);
    assert.ok(!lines.some((l) => l.name === 'Helensvale')); // tram ends don't become train lines
    assert.equal(lines[0].mode, 'train');
});

test('summary counts each kind of service', () => {
    const s = summarize([
        { routeName: 'A', mode: 'train', delaySec: 0 },
        { routeName: 'F1', mode: 'ferry', delaySec: 0 },
        { routeName: 'F1', mode: 'ferry', delaySec: null },
    ]);
    assert.deepEqual(s.byMode, { train: 1, tram: 0, ferry: 2 });
});
