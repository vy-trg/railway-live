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
