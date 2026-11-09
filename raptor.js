// Journey planner: RAPTOR (Delling, Pajor, Werneck, "Round-Based Public Transit Routing", 2012).
// Round k finds the earliest arrival at every stop using at most k vehicles. Each round scans every
// route ("pattern": trips that stop at the same stops with the same gaps) that serves a stop improved
// in the round before, then lets you walk to nearby stops. No database or network here: unit tested.
//
// Times are seconds after midnight of the service day (they can be negative for yesterday's late trips,
// or past 86400 after midnight).

export const MIN_CHANGE_SECS = 60; // getting off one vehicle and onto another at the same stop
export const EXTRA_CHANGE_SECS = 5 * 60; // "Give me more time to change": spare time at every change

// network: {
//   stopCount,
//   patterns: [{ stops: [stopIdx], arr: [offset], dep: [offset], last: [bool], routeId }],
//   stopPatterns: [[[patternIdx, position], ...] per stop],
//   footpaths: [[[toStopIdx, secs], ...] per stop],
// }
// trips: [{ starts: [secs ascending], tripIds: [id] } per pattern] — only trips running that day
export function buildStopPatterns(patterns, stopCount) {
  const out = Array.from({ length: stopCount }, () => []);
  patterns.forEach((p, pi) => p.stops.forEach((s, pos) => out[s].push([pi, pos])));
  return out;
}

// First trip in `starts` that leaves position `pos` at or after `time` (binary search).
// Every trip of a pattern has the same offsets, so trips never overtake each other.
function firstTripFrom(starts, depOffset, time) {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] + depOffset >= time) hi = mid;
    else lo = mid + 1;
  }
  return lo < starts.length ? lo : -1;
}

// sources: [{ stop, secs }]  when you can be at each starting stop (already includes the walk to it)
// targets: Map(stopIdx -> secs of walking from that stop to where you're going)
// Returns the best journey for each number of vehicles (fewer changes vs earlier arrival).
// extraChangeSecs: spare time wanted at every change, on top of any walk (0 = catch the first one you can)
// startWalks: false when the sources already include the walk from where you are to every nearby stop,
// so a journey never starts "walk to stop A, then walk to stop B"
export function raptor(network, trips, sources, targets, maxRounds = 5, extraChangeSecs = 0, startWalks = true) {
  const n = network.stopCount;
  const INF = Infinity;
  const best = new Float64Array(n).fill(INF);
  const rounds = [new Float64Array(n).fill(INF)];
  const labels = [new Array(n).fill(null)];
  let marked = new Set();

  for (const { stop, secs } of sources) {
    if (secs < rounds[0][stop]) {
      rounds[0][stop] = secs;
      best[stop] = secs;
      labels[0][stop] = { kind: 'start' };
      marked.add(stop);
    }
  }
  if (startWalks) relaxFootpaths(network, rounds[0], labels[0], best, marked, 0);

  let bestTarget = INF;
  const results = [];

  for (let k = 1; k <= maxRounds && marked.size > 0; k += 1) {
    const prev = rounds[k - 1];
    const prevLabels = labels[k - 1];
    const cur = Float64Array.from(prev);
    const curLabels = prevLabels.slice();
    rounds.push(cur);
    labels.push(curLabels);

    // Routes to scan, each from the earliest marked stop on it
    const queue = new Map();
    for (const s of marked) {
      for (const [pi, pos] of network.stopPatterns[s]) {
        const q = queue.get(pi);
        if (q === undefined || pos < q) queue.set(pi, pos);
      }
    }
    marked = new Set();

    for (const [pi, startPos] of queue) {
      const p = network.patterns[pi];
      const t = trips[pi];
      if (!t || t.starts.length === 0) continue;
      let trip = -1;
      let boardPos = -1;
      let boardStop = -1;
      for (let i = startPos; i < p.stops.length; i += 1) {
        const s = p.stops[i];
        // Ride on: arriving here with the current trip
        if (trip !== -1) {
          const arr = t.starts[trip] + p.arr[i];
          if (arr < Math.min(best[s], bestTarget)) {
            cur[s] = arr;
            best[s] = arr;
            curLabels[s] = { kind: 'ride', round: k, pattern: pi, trip, from: boardPos, to: i, fromStop: boardStop };
            marked.add(s);
          }
        }
        // Get on (or onto an earlier trip) if we could be here in time from the round before
        if (!p.last[i] && prev[s] < INF) {
          // A change is getting here off a vehicle, or walking here after one (not the walk from the start)
          const l = prevLabels[s];
          const changing = l?.kind === 'ride' || (l?.kind === 'walk' && l.round > 0);
          const buffer = l?.kind === 'ride' ? Math.max(MIN_CHANGE_SECS, extraChangeSecs) : changing ? extraChangeSecs : 0;
          const ready = prev[s] + buffer;
          if (trip === -1 || ready <= t.starts[trip] + p.dep[i]) {
            const earlier = firstTripFrom(t.starts, p.dep[i], ready);
            if (earlier !== -1 && (trip === -1 || earlier < trip)) {
              trip = earlier;
              boardPos = i;
              boardStop = s;
            }
          }
        }
      }
    }

    relaxFootpaths(network, cur, curLabels, best, marked, k);

    // Best arrival at the destination using k vehicles
    let arrive = INF;
    let at = -1;
    for (const [s, walk] of targets) {
      if (cur[s] + walk < arrive) {
        arrive = cur[s] + walk;
        at = s;
      }
    }
    if (at !== -1 && arrive < bestTarget) {
      bestTarget = arrive;
      const legs = unwind(network, trips, labels, k, at, targets.get(at));
      results.push({ rides: legs.filter((l) => l.kind === 'ride').length, arriveSecs: arrive, legs });
    }
  }
  return results;
}

// Walking: from every stop improved this round to the stops nearby. A walk never follows a walk.
function relaxFootpaths(network, times, lbls, best, marked, round) {
  for (const s of [...marked]) {
    if (lbls[s]?.kind === 'walk') continue;
    for (const [to, secs] of network.footpaths[s] || []) {
      const arr = times[s] + secs;
      if (arr < times[to] && arr < best[to]) {
        times[to] = arr;
        best[to] = arr;
        lbls[to] = { kind: 'walk', fromStop: s, secs, round };
        marked.add(to);
      }
    }
  }
}

// Follow the labels back from the destination to the start, then turn them into legs.
function unwind(network, trips, labels, k, stop, egressSecs) {
  const legs = [];
  let round = k;
  let s = stop;
  while (round >= 0) {
    const l = labels[round][s];
    if (!l || l.kind === 'start') break;
    if (l.kind === 'walk') {
      legs.push({ kind: 'walk', fromStop: l.fromStop, toStop: s, secs: l.secs });
      s = l.fromStop;
      round = l.round; // the walk was part of that round
      continue;
    }
    const p = network.patterns[l.pattern];
    const start = trips[l.pattern].starts[l.trip];
    legs.push({
      kind: 'ride',
      pattern: l.pattern,
      routeId: trips[l.pattern].routeIds?.[l.trip] ?? p.routeId,
      tripId: trips[l.pattern].tripIds[l.trip],
      fromStop: l.fromStop,
      toStop: s,
      fromPos: l.from,
      toPos: l.to,
      departSecs: start + p.dep[l.from],
      arriveSecs: start + p.arr[l.to],
      stopCount: l.to - l.from,
    });
    s = l.fromStop;
    round = l.round - 1; // you got on with the time from the round before
  }
  legs.reverse();
  if (egressSecs > 0) legs.push({ kind: 'walk', fromStop: stop, toStop: null, secs: egressSecs });
  return legs;
}

// Several journeys to choose from: plan, then plan again leaving just after the first vehicle
// of the earliest option, until there are enough. Same trips twice are dropped.
export function planJourneys(network, trips, sources, targets, { count = 5, maxRounds = 5, extraChangeSecs = 0, startWalks = true } = {}) {
  const found = [];
  const seen = new Set();
  let shift = 0;
  for (let run = 0; run < count * 2 && found.length < count; run += 1) {
    const shifted = sources.map((s) => ({ stop: s.stop, secs: s.secs + shift }));
    const results = raptor(network, trips, shifted, targets, maxRounds, extraChangeSecs, startWalks);
    if (results.length === 0) break;
    for (const r of results) {
      const key = r.legs.filter((l) => l.kind === 'ride').map((l) => l.tripId).join('>');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      found.push(r);
    }
    // Next run: leave a minute after the first vehicle of the fastest option
    const firstRide = results[results.length - 1].legs.find((l) => l.kind === 'ride');
    if (!firstRide) break;
    const startAt = Math.min(...sources.map((s) => s.secs));
    const walkBefore = firstRide.departSecs - startAt;
    shift = Math.max(shift + 60, walkBefore + 60);
  }
  return found
    .sort((a, b) => a.arriveSecs - b.arriveSecs || a.rides - b.rides)
    .filter((j, i, all) => !all.slice(0, i).some((o) => o.arriveSecs <= j.arriveSecs && o.rides <= j.rides && departOf(o) >= departOf(j)))
    .slice(0, count);
}

const departOf = (j) => j.legs.find((l) => l.kind === 'ride')?.departSecs ?? -Infinity;

// Straight-line distance in metres
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Walking at 4.5 km/h, with 20% added because streets aren't straight lines
export const WALK_MPS = 4.5 / 3.6;
export const DETOUR = 1.2;
export const walkSecs = (metres) => Math.max(30, Math.round((metres * DETOUR) / WALK_MPS));
