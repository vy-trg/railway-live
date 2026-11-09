import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, walkRoute, walkKey } from '../walk.js';

const osrm = {
  code: 'Ok',
  routes: [{ distance: 450, geometry: { coordinates: [[152.91, -27.62], [152.912, -27.621], [152.915, -27.623]] } }],
};

test('parseRoute: points come back as [lat, lng] along the streets', () => {
  const r = parseRoute(osrm);
  assert.deepEqual(r.points[0], [-27.62, 152.91]);
  assert.equal(r.points.length, 3);
  assert.equal(r.metres, 450);
  assert.equal(r.secs, 360); // 450 m at 4.5 km/h
});

test('parseRoute: no route found -> null', () => {
  assert.equal(parseRoute({ code: 'NoRoute', routes: [] }), null);
  assert.equal(parseRoute(null), null);
});

test('walkRoute asks once, then answers from the cache', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => osrm }; };
  const a = { lat: -27.6201, lng: 152.9101 };
  const b = { lat: -27.6231, lng: 152.9151 };
  await walkRoute(a, b, { fetchImpl });
  const again = await walkRoute(a, b, { fetchImpl });
  assert.equal(calls, 1);
  assert.equal(again.metres, 450);
});

test('walkRoute: a long walk is not asked for', async () => {
  const fetchImpl = async () => { throw new Error('should not be called'); };
  const r = await walkRoute({ lat: -27.5, lng: 153 }, { lat: -27.6, lng: 153 }, { fetchImpl, distanceM: () => 11000 });
  assert.equal(r, null);
});

test('walkRoute: the router failing is an error the server turns into "use the straight line"', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(walkRoute({ lat: -27.1, lng: 153.1 }, { lat: -27.11, lng: 153.11 }, { fetchImpl }));
});

test('nearby points share a cache entry', () => {
  assert.equal(walkKey({ lat: -27.620001, lng: 152.91 }, { lat: -27.63, lng: 152.92 }), walkKey({ lat: -27.620004, lng: 152.91 }, { lat: -27.63, lng: 152.92 }));
});

test('bike and car routes use their own router and speed, cached apart from walks', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, json: async () => osrm }; };
  const a = { lat: -27.7001, lng: 152.8001 };
  const b = { lat: -27.7101, lng: 152.8101 };
  const bike = await walkRoute(a, b, { fetchImpl, mode: 'bike' });
  const car = await walkRoute(a, b, { fetchImpl, mode: 'car' });
  assert.ok(urls[0].includes('routed-bike') && urls[1].includes('routed-car'));
  assert.equal(bike.secs, Math.round(450 / (15 / 3.6)));
  assert.ok(car.secs < bike.secs);
});
