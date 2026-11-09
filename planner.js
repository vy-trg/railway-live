// Journey planner: loads the timetable into memory once, then answers "from A to B, leaving at …"
// with raptor.js. The network (stops, patterns, walks) is loaded once; each date's trips are
// loaded the first time someone plans on that date and kept for the next requests.
import * as db from './db/queries.js';
import { buildStopPatterns, planJourneys, distanceM, walkSecs } from './raptor.js';
import { classify } from './connection.js';
import { delayAtStop, describeDelay, delayLevel, formatClock } from './schedule.js';

export const MAX_WALK_M = 400; // walking between stops while changing
export const MAX_ACCESS_M = 800; // walking from "near me" (or to the destination) to a stop
export const PLATFORM_CHANGE_SECS = 120; // between platforms of the same station

// Pure: stops (with lat/lng and station) -> walking links between them.
// Same station: a platform change. Different stations close together: walk at 4.5 km/h.
export function buildFootpaths(stops, maxM = MAX_WALK_M) {
  const out = stops.map(() => []);
  // A grid of about 400 m cells, so each stop is only compared with stops in the cells around it
  const cell = (v) => Math.floor(v / 0.004);
  const grid = new Map();
  stops.forEach((s, i) => {
    const key = `${cell(s.lat)},${cell(s.lng)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  stops.forEach((a, i) => {
    const cy = cell(a.lat);
    const cx = cell(a.lng);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (const j of grid.get(`${cy + dy},${cx + dx}`) || []) {
          if (j === i) continue;
          const b = stops[j];
          if (a.stationId === b.stationId) {
            out[i].push([j, PLATFORM_CHANGE_SECS]);
            continue;
          }
          const m = distanceM(a.lat, a.lng, b.lat, b.lng);
          // at least as long as a platform change: stations are one point, real entrances are further apart
          if (m <= maxM) out[i].push([j, Math.max(PLATFORM_CHANGE_SECS, walkSecs(m))]);
        }
      }
    }
  });
  return out;
}

// Pure: rows of pattern_stops -> patterns indexed by pattern id
export function buildPatternList(rows, stopIndex) {
  const byId = new Map();
  for (const r of rows) {
    let p = byId.get(r.pattern_id);
    if (!p) {
      p = { id: r.pattern_id, stops: [], seq: [], arr: [], dep: [], last: [] };
      byId.set(r.pattern_id, p);
    }
    p.stops.push(stopIndex.get(r.stop_id));
    p.seq.push(r.stop_sequence);
    p.arr.push(r.arr_offset);
    p.dep.push(r.dep_offset);
    p.last.push(r.is_last);
  }
  return [...byId.values()];
}

// Pure: trips of one day -> per pattern, start times in order
export function buildTripTable(rows, patternIndex, patternCount) {
  const table = Array.from({ length: patternCount }, () => ({ starts: [], tripIds: [], routeIds: [] }));
  for (const r of rows) {
    const pi = patternIndex.get(r.pattern_id);
    if (pi === undefined) continue;
    table[pi].starts.push(r.start_secs);
    table[pi].tripIds.push(r.trip_id);
    table[pi].routeIds.push(r.route_id);
  }
  // Trips can come in any order across the two days; keep each pattern sorted by start
  for (const t of table) {
    if (t.starts.every((v, i) => i === 0 || t.starts[i - 1] <= v)) continue;
    const order = t.starts.map((_, i) => i).sort((a, b) => t.starts[a] - t.starts[b]);
    t.starts = order.map((i) => t.starts[i]);
    t.tripIds = order.map((i) => t.tripIds[i]);
    t.routeIds = order.map((i) => t.routeIds[i]);
  }
  return table;
}

let networkPromise = null;
const tripCache = new Map(); // date -> trip table (today and tomorrow are enough)

export function getNetwork() {
  if (!networkPromise) {
    networkPromise = (async () => {
      const [stopRows, patternRows] = await Promise.all([db.getPlannerStops(), db.getPatternStops()]);
      const stops = stopRows.map((r) => ({
        id: r.stop_id, stationId: r.station_id, name: r.name, platform: r.platform, lat: r.lat, lng: r.lng,
      }));
      const stopIndex = new Map(stops.map((s, i) => [s.id, i]));
      const patterns = buildPatternList(patternRows, stopIndex);
      const byStation = new Map();
      stops.forEach((s, i) => {
        if (!byStation.has(s.stationId)) byStation.set(s.stationId, []);
        byStation.get(s.stationId).push(i);
      });
      return {
        stops,
        stopIndex,
        byStation,
        patternIndex: new Map(patterns.map((p, i) => [p.id, i])),
        network: {
          stopCount: stops.length,
          patterns,
          stopPatterns: buildStopPatterns(patterns, stops.length),
          footpaths: buildFootpaths(stops),
        },
      };
    })().catch((err) => {
      networkPromise = null; // try again next time
      throw err;
    });
  }
  return networkPromise;
}

async function getTrips(date) {
  if (!tripCache.has(date)) {
    const { patternIndex, network } = await getNetwork();
    const promise = db.getTripsOn(date).then((rows) => buildTripTable(rows, patternIndex, network.patterns.length));
    promise.catch(() => tripCache.delete(date));
    tripCache.set(date, promise);
    // Keep at most 3 days in memory
    while (tripCache.size > 3) tripCache.delete(tripCache.keys().next().value);
  }
  return tripCache.get(date);
}

// Pure: where you are -> the stops you could start from, with the walk to each.
// place: { stationId } or { lat, lng }
export function placeToStops(place, stops, byStation, maxM = MAX_ACCESS_M) {
  if (place.stationId) {
    return (byStation.get(place.stationId) || []).map((i) => ({ stop: i, walk: 0 }));
  }
  const out = [];
  stops.forEach((s, i) => {
    const m = distanceM(place.lat, place.lng, s.lat, s.lng);
    if (m <= maxM) out.push({ stop: i, walk: walkSecs(m) });
  });
  return out;
}

// from/to: { stationId } or { lat, lng }; date "YYYY-MM-DD"; secs = seconds after midnight
export async function plan(from, to, date, secs, count = 5) {
  const net = await getNetwork();
  const trips = await getTrips(date);
  const origin = placeToStops(from, net.stops, net.byStation);
  const dest = placeToStops(to, net.stops, net.byStation);
  if (origin.length === 0) return { error: 'from', journeys: [] };
  if (dest.length === 0) return { error: 'to', journeys: [] };
  const sources = origin.map((o) => ({ stop: o.stop, secs: secs + o.walk }));
  const targets = new Map(dest.map((d) => [d.stop, d.walk]));
  const startWalk = new Map(origin.map((o) => [o.stop, o.walk]));
  const journeys = planJourneys(net.network, trips, sources, targets, { count });
  // Put the walk to the first stop back in, so the journey reads from where you are
  return {
    journeys: journeys.map((j) => {
      const first = j.legs[0];
      const walk = first ? startWalk.get(first.fromStop) ?? 0 : 0;
      const legs = walk > 0 ? [{ kind: 'walk', fromStop: null, toStop: first.fromStop, secs: walk }, ...j.legs] : j.legs;
      return { ...j, legs };
    }),
    stops: net.stops,
    patterns: net.network.patterns,
  };
}

// Pure: one journey from raptor -> what the page shows. Live delays are added to each ride,
// and every change says whether you'll make it (connection.js): Make it / Tight / Miss.
// trips: Map trip_id -> { headsign, short_name, long_name, mode, color, text_color }
// updates: Map trip_id -> trip update (may be empty)
export function describeJourney(journey, stops, patterns, trips, updates) {
  const stopOut = (i) => (i === null || i === undefined ? null : {
    name: stops[i].name, platform: stops[i].platform, lat: stops[i].lat, lng: stops[i].lng,
  });
  const legs = [];
  let readyAt = null; // when you can get on the next vehicle (live), for Make it / Tight / Miss
  let lastRideArrive = null;
  let sameStop = false; // changing at the same stop: a minute to get off and on, as in raptor.js
  for (const l of journey.legs) {
    if (l.kind === 'walk') {
      legs.push({ kind: 'walk', minutes: Math.max(1, Math.round(l.secs / 60)), from: stopOut(l.fromStop), to: stopOut(l.toStop) });
      if (readyAt !== null) readyAt += l.secs;
      sameStop = false;
      continue;
    }
    const p = patterns[l.pattern];
    const t = trips.get(l.tripId) || {};
    const tu = updates.get(l.tripId);
    const dep = delayAtStop(tu, p.seq[l.fromPos]);
    const arr = delayAtStop(tu, p.seq[l.toPos]);
    const cancelled = Boolean(tu?.cancelled) || dep.skipped || arr.skipped;
    const departLive = l.departSecs + (dep.delay ?? 0);
    const arriveLive = l.arriveSecs + (arr.delay ?? dep.delay ?? 0);
    const change = readyAt === null ? null : classify(readyAt + (sameStop ? 60 : 0), departLive);
    legs.push({
      kind: 'ride',
      tripId: l.tripId,
      mode: t.mode ?? 'train',
      routeShort: t.short_name ?? l.routeId,
      routeName: t.long_name ?? '',
      headsign: (t.headsign ?? '').replace(/ (station|ferry terminal)$/, ''),
      color: `#${t.color ?? '666666'}`,
      textColor: `#${t.text_color ?? 'FFFFFF'}`,
      from: stopOut(l.fromStop),
      to: stopOut(l.toStop),
      fromSeq: p.seq[l.fromPos],
      toSeq: p.seq[l.toPos],
      depart: formatClock(l.departSecs),
      arrive: formatClock(l.arriveSecs),
      departSecs: l.departSecs,
      arriveSecs: l.arriveSecs,
      departExpected: dep.delay !== null && Math.abs(dep.delay) >= 60 ? formatClock(departLive) : null,
      arriveExpected: (arr.delay ?? dep.delay) !== null && Math.abs(arr.delay ?? dep.delay) >= 60 ? formatClock(arriveLive) : null,
      delaySec: dep.delay,
      status: cancelled ? 'cancelled' : delayLevel(dep.delay),
      statusText: cancelled ? 'Cancelled' : dep.delay === null ? 'Scheduled' : describeDelay(dep.delay),
      stops: l.stopCount,
      change, // null for the first vehicle; 'make' | 'tight' | 'miss' after a change
    });
    readyAt = arriveLive;
    sameStop = true;
    lastRideArrive = arriveLive;
  }
  const rides = legs.filter((x) => x.kind === 'ride');
  const firstWalk = legs[0]?.kind === 'walk' ? legs[0].minutes * 60 : 0;
  const leaveSecs = rides.length ? rides[0].departSecs - firstWalk : null;
  const arriveExpectedSecs = lastRideArrive === null ? journey.arriveSecs : journey.arriveSecs + (lastRideArrive - rides[rides.length - 1].arriveSecs);
  return {
    leave: leaveSecs === null ? null : formatClock(leaveSecs),
    leaveSecs,
    arrive: formatClock(journey.arriveSecs),
    arriveSecs: journey.arriveSecs,
    arriveExpected: Math.abs(arriveExpectedSecs - journey.arriveSecs) >= 60 ? formatClock(arriveExpectedSecs) : null,
    minutes: leaveSecs === null ? 0 : Math.round((journey.arriveSecs - leaveSecs) / 60),
    changes: Math.max(0, rides.length - 1),
    risky: rides.some((r) => r.change === 'miss' || r.status === 'cancelled') ? 'miss' : rides.some((r) => r.change === 'tight') ? 'tight' : null,
    legs,
  };
}
