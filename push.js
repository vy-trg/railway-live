// Push notifications for Start journey (docs/start-journey.md): when the phone is locked or the
// page is in the background, the page can't keep checking, so the server watches the journey and
// sends the moments that matter as Web Push notifications. Free (VAPID keys, no paid service).
//
// Kept in memory: a journey lasts an hour or two, and a restart (a deploy) only means the page
// sends it again the next time it's open. One journey per subscription.

// Getting on and off, from where the vehicle REALLY is when we know it (its GPS position report:
// which stop it's heading to or stopped at), and from predicted times otherwise. Predictions can lag
// behind a bus that's running early; the position report doesn't, so "get off" never comes late.
// stops: buildTripProgress output; vehicle: { stopSequence, atStop } or null.
export function rideState(stops, vehicle, fromSeq, toSeq) {
  if (!stops) return null;
  const idx = (seq) => stops.findIndex((s) => s.sequence === seq);
  const board = stops[idx(fromSeq)];
  const off = stops[idx(toSeq)];
  const v = vehicle && vehicle.stopSequence !== null && vehicle.stopSequence !== undefined ? vehicle : null;
  let boarded, arrived, left, headingToBoard, headingToOff;
  if (v) {
    const at = idx(v.stopSequence);
    boarded = v.stopSequence > fromSeq;
    arrived = v.stopSequence > toSeq || (v.stopSequence === toSeq && v.atStop);
    // stops still to come up to and including yours: the one it's heading to counts, the one it's at doesn't
    left = at === -1 || idx(toSeq) === -1 ? null : idx(toSeq) - at + (v.atStop ? 0 : 1);
    headingToBoard = v.stopSequence === fromSeq && !v.atStop;
    headingToOff = v.stopSequence === toSeq && !v.atStop;
  } else {
    boarded = board?.state === 'passed';
    arrived = off?.state === 'passed';
    const nextIdx = stops.findIndex((s) => s.state === 'next');
    left = nextIdx === -1 || idx(toSeq) === -1 ? null : idx(toSeq) - nextIdx + 1;
    headingToBoard = false;
    headingToOff = false;
  }
  return {
    boarded, arrived, left, headingToBoard, headingToOff,
    boardEta: board?.etaSec ?? null,
    offEta: off?.etaSec ?? null,
    leavesIn: board ? Math.round(board.etaSec / 60) : null,
  };
}

// "Now": the vehicle is this close (seconds) to the stop by its predicted time. A minute and a half,
// so a bus a little early still gets the alert before it's there.
export const NOW_SECS = 90;

// The moments to tell someone about, from where each ride is now.
// rides: [{ tripId, mode, line, headsign, fromName, fromPlatform, toName, fromSeq, toSeq, depart }]
// progress: Map(tripId -> stops from buildTripProgress), vehicles: Map(tripId -> { stopSequence, atStop })
// Returns [{ key, text }]; the caller sends each key once.
export function journeyMoments(rides, progress, walkMinsBefore = [], vehicles = new Map()) {
  const out = [];
  rides.forEach((r, i) => {
    const stops = progress.get(r.tripId);
    const st = rideState(stops, vehicles.get(r.tripId), r.fromSeq, r.toSeq);
    if (!st) return;
    const { boarded, arrived, left, leavesIn } = st;
    if (!boarded && leavesIn !== null && leavesIn <= 2 && leavesIn >= -1) {
      out.push({
        key: `board-${r.tripId}`,
        text: `Your ${r.line} to ${r.headsign} leaves ${r.fromName}${r.fromPlatform ? ` from platform ${r.fromPlatform}` : ''} in ${leavesIn <= 0 ? 'under a minute' : `${leavesIn} min${leavesIn === 1 ? '' : 's'}`}.`,
      });
    }
    if (!boarded && (st.headingToBoard || (st.boardEta !== null && st.boardEta <= NOW_SECS && st.boardEta >= -60))) {
      out.push({ key: `board-now-${r.tripId}`, text: `Your ${r.line} to ${r.headsign} is about to arrive at ${r.fromName}. Get ready to get on.` });
    }
    // The next stop is yours: as soon as it leaves the stop before (position), or 90 s before (time)
    if (boarded && !arrived && (st.headingToOff || left === 1 || (st.offEta !== null && st.offEta <= NOW_SECS))) {
      out.push({ key: `off-now-${r.tripId}`, text: r.mode === 'bus' ? `Get off at the next stop: ${r.toName}. Press the bell now.` : `Get off at the next stop: ${r.toName}.` });
    }
    // Buses: one more, 2 stops before, to have time to get to the bell and the door
    if (r.mode === 'bus' && boarded && !arrived && left === 2) {
      out.push({ key: `off-2-${r.tripId}`, text: `2 stops to go: get off at ${r.toName}. Press the bell after the next stop.` });
    }
    // Will the next ride still be made? (this one's arrival + the walk vs the next departure)
    const next = rides[i + 1];
    const nextBoard = next && progress.get(next.tripId)?.find((s) => s.sequence === next.fromSeq);
    if (next && st.offEta !== null && nextBoard && !arrived && nextBoard.etaSec - (st.offEta + (walkMinsBefore[i + 1] ?? 0) * 60) < 0) {
      out.push({ key: `miss-${next.tripId}`, text: `You may miss the ${next.line} at ${next.depart}: the one you're on is running late. Open Railway Live to find another way.` });
    }
  });
  return out;
}

// Over: the last ride has arrived (or it's well past its time)
export function journeyOver(rides, progress, vehicles = new Map()) {
  const last = rides[rides.length - 1];
  const st = rideState(progress.get(last.tripId), vehicles.get(last.tripId), last.fromSeq, last.toSeq);
  return st ? st.arrived : false;
}

// What the page sends: checked, so nothing odd ends up in a notification or a lookup
export function cleanJourney(body) {
  const sub = body?.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return null;
  const rides = Array.isArray(body.rides) ? body.rides.slice(0, 6) : [];
  const str = (v, n = 80) => String(v ?? '').slice(0, n);
  const clean = rides.map((r) => ({
    tripId: str(r.tripId, 120),
    mode: ['train', 'bus', 'ferry', 'tram'].includes(r.mode) ? r.mode : 'train',
    line: str(r.line),
    headsign: str(r.headsign),
    fromName: str(r.fromName),
    fromPlatform: str(r.fromPlatform, 10),
    toName: str(r.toName),
    fromSeq: Number(r.fromSeq),
    toSeq: Number(r.toSeq),
    depart: str(r.depart, 12),
  })).filter((r) => r.tripId && Number.isInteger(r.fromSeq) && Number.isInteger(r.toSeq));
  if (clean.length === 0) return null;
  const walks = Array.isArray(body.walkMinsBefore) ? body.walkMinsBefore.slice(0, 7).map((n) => Math.max(0, Math.min(60, Number(n) || 0))) : [];
  return { subscription: { endpoint: sub.endpoint, keys: { p256dh: str(sub.keys.p256dh, 200), auth: str(sub.keys.auth, 100) } }, rides: clean, walkMinsBefore: walks };
}
