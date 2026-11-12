// Train + bus: will I make the connection?
// Pure functions only (no database, no network), so every rule in docs/connections.md is tested.
// Times are seconds after midnight of the service day, like GTFS (they can go past 24:00:00).

// The two places to change, from docs/connections.md. Walks are Vy's own estimates.
export const CHANGES = {
  sherwood: {
    name: 'Sherwood',
    stationId: 'place_shesta',
    route: '598',
    routeId: '598-4',
    fromStop: '5341',
    toStop: '10306',
    walkSecs: 3 * 60,
  },
  roma: {
    name: 'Roma Street',
    stationId: 'place_romsta',
    route: 'M1',
    routeId: 'M1-4',
    fromStop: '10792',
    toStop: '10819',
    walkSecs: 4 * 60,
  },
};

// Any station: the bus stops you can walk to from the platform, and how long the walk takes.
// Straight-line distance is stretched by a quarter for real paths and walked at 1.25 m/s (4.5 km/h),
// so one metre takes one second; plus 90 seconds to get off the platform. Rounded up to whole minutes.
export const NEAR_BUS_M = 450;
export function walkSecsFor(distanceM) {
  return Math.ceil((90 + distanceM) / 60) * 60;
}
// Vy timed these two herself (docs/connections.md); they beat the estimate
export const KNOWN_WALKS = { '5341': 3 * 60, place_rompl: 4 * 60 };

// Every bus leaving the stops near the station, each with its own walk, newest rules:
// buses: [{ tripId, departSecs, delaySecs, walkSecs, ... }]. A bus that calls at two nearby stops
// is kept once, at the stop you'd reach first in time to catch it. Sorted by when they leave.
export function busesAfterTrain(train, buses) {
  const arrive = train.arrivalSecs + (train.delaySecs || 0);
  const best = new Map();
  for (const b of buses) {
    const delay = b.delaySecs || 0;
    const leaves = b.departSecs + delay;
    const ready = arrive + b.walkSecs;
    const o = { ...b, delaySecs: delay, leavesSecs: leaves, readySecs: ready, spareSecs: leaves - ready, status: classify(ready, leaves) };
    const old = best.get(b.tripId);
    const better = !old || (old.status === 'miss' && o.status !== 'miss') || (old.status === o.status && o.walkSecs < old.walkSecs);
    if (better) best.set(b.tripId, o);
  }
  return [...best.values()].sort((a, b) => a.leavesSecs - b.leavesSecs || a.walkSecs - b.walkSecs);
}

// Make it: the bus leaves 3 minutes or more after you're ready.
export const TIGHT_SECS = 3 * 60;

// 'make' | 'tight' | 'miss' for one bus.
// Leaving exactly when you're ready counts as tight, not a miss.
export function classify(readySecs, busLeavesSecs) {
  const spare = busLeavesSecs - readySecs;
  if (spare < 0) return 'miss';
  if (spare < TIGHT_SECS) return 'tight';
  return 'make';
}

// When you're at the bus stop: scheduled arrival + the train's live delay + the walk.
// A train running early (negative delay) brings you there earlier too.
export function readyAt(trainArrivalSecs, trainDelaySecs, walkSecs) {
  return trainArrivalSecs + (trainDelaySecs || 0) + walkSecs;
}

// train: { arrivalSecs, delaySecs }
// buses: [{ tripId, departSecs, delaySecs?, arriveSecs? }] from the change stop, any order.
// Returns every bus with its live time and status, the one to catch, and how long you wait.
export function planConnection(train, walkSecs, buses) {
  const ready = readyAt(train.arrivalSecs, train.delaySecs, walkSecs);

  const options = buses
    .map((b) => {
      const delay = b.delaySecs || 0; // the bus's own live delay when there is one
      const leaves = b.departSecs + delay;
      return {
        tripId: b.tripId,
        scheduledSecs: b.departSecs,
        leavesSecs: leaves,
        delaySecs: delay,
        arrivesSecs: b.arriveSecs == null ? null : b.arriveSecs + delay,
        spareSecs: leaves - ready,
        status: classify(ready, leaves),
      };
    })
    .sort((a, b) => a.leavesSecs - b.leavesSecs);

  const catchIndex = options.findIndex((o) => o.status !== 'miss');
  const bus = catchIndex === -1 ? null : options[catchIndex];
  // The verdict is about the bus you were aiming for: the first one leaving after the train
  // was due (on time). If that one is missed because of the delay, say so and show the next.
  const planned = options.find((o) => o.leavesSecs >= readyAt(train.arrivalSecs, 0, walkSecs)) || null;

  return {
    readySecs: ready,
    planned,
    verdict: planned ? planned.status : bus ? bus.status : 'none',
    catch: bus,
    next: catchIndex === -1 ? null : options[catchIndex + 1] || null,
    waitSecs: bus ? bus.leavesSecs - ready : null,
    options,
  };
}

// 27000 -> "7:30 am", 90000 -> "1:00 am" (next day)
export function formatSecs(secs) {
  const day = 24 * 3600;
  const s = ((secs % day) + day) % day;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}
