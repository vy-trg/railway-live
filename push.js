// Push notifications for Start journey (docs/start-journey.md): when the phone is locked or the
// page is in the background, the page can't keep checking, so the server watches the journey and
// sends the moments that matter as Web Push notifications. Free (VAPID keys, no paid service).
//
// Kept in memory: a journey lasts an hour or two, and a restart (a deploy) only means the page
// sends it again the next time it's open. One journey per subscription.

// The moments to tell someone about, from where each ride is now.
// rides: [{ tripId, mode, line, headsign, fromName, fromPlatform, toName, fromSeq, toSeq, depart }]
// progress: Map(tripId -> stops from buildTripProgress: [{ sequence, state, etaSec }]) (missing = unknown)
// Returns [{ key, text }]; the caller sends each key once.
export function journeyMoments(rides, progress, walkMinsBefore = []) {
  const out = [];
  rides.forEach((r, i) => {
    const stops = progress.get(r.tripId);
    if (!stops) return;
    const board = stops.find((s) => s.sequence === r.fromSeq);
    const off = stops.find((s) => s.sequence === r.toSeq);
    const boarded = board?.state === 'passed';
    const arrived = off?.state === 'passed';
    const leavesIn = board ? Math.round(board.etaSec / 60) : null;
    if (!boarded && leavesIn !== null && leavesIn <= 2 && leavesIn >= -1) {
      out.push({
        key: `board-${r.tripId}`,
        text: `Your ${r.line} to ${r.headsign} leaves ${r.fromName}${r.fromPlatform ? ` from platform ${r.fromPlatform}` : ''} in ${leavesIn <= 0 ? 'under a minute' : `${leavesIn} min${leavesIn === 1 ? '' : 's'}`}.`,
      });
    }
    const nextIdx = stops.findIndex((s) => s.state === 'next');
    const offIdx = stops.findIndex((s) => s.sequence === r.toSeq);
    const left = nextIdx === -1 || offIdx === -1 ? null : offIdx - nextIdx + 1;
    const soon = r.mode === 'bus' ? 2 : 1;
    if (boarded && !arrived && left !== null && left >= 1 && left <= soon) {
      out.push({
        key: `off-${r.tripId}-${left}`,
        text: r.mode === 'bus'
          ? `${left === 1 ? 'Next stop' : '2 stops to go'}: get off at ${r.toName}. Press the bell${left === 1 ? ' now' : ' after the next stop'}.`
          : `Next stop: get off at ${r.toName}. Get ready.`,
      });
    }
    // Will the next ride still be made? (this one's arrival + the walk vs the next departure)
    const next = rides[i + 1];
    const nextBoard = next && progress.get(next.tripId)?.find((s) => s.sequence === next.fromSeq);
    if (next && off && nextBoard && !arrived && nextBoard.etaSec - (off.etaSec + (walkMinsBefore[i + 1] ?? 0) * 60) < 0) {
      out.push({ key: `miss-${next.tripId}`, text: `You may miss the ${next.line} at ${next.depart}: the one you're on is running late. Open Railway Live to find another way.` });
    }
  });
  return out;
}

// Over: the last ride has arrived (or it's well past its time)
export function journeyOver(rides, progress) {
  const last = rides[rides.length - 1];
  const off = progress.get(last.tripId)?.find((s) => s.sequence === last.toSeq);
  return off ? off.state === 'passed' : false;
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
