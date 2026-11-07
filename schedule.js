// Small helpers for GTFS times and dates. Pure functions, so they are unit-tested.

// "25:10:00" -> seconds after midnight of the service day (GTFS allows hours >= 24)
export function parseGtfsTime(text) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!m) throw new Error(`Bad GTFS time: ${text}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// "20261106" -> "2026-11-06"
export function parseGtfsDate(text) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(text ?? '');
  if (!m) throw new Error(`Bad GTFS date: ${text}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Delay in seconds -> what a passenger reads
export function describeDelay(seconds) {
  if (seconds === null || seconds === undefined) return 'No delay info yet';
  // Under a minute either way counts as on time, matching delayLevel and the colours
  if (Math.abs(seconds) < 60) return 'On time';
  const minutes = Math.round(Math.abs(seconds) / 60);
  return seconds > 0 ? `${minutes} min late` : `${minutes} min early`;
}

// Delay bucket used for colours: on time (<= 1 min), late (2-5), very late (> 5)
export function delayLevel(seconds) {
  if (seconds === null || seconds === undefined) return 'unknown';
  const minutes = seconds / 60;
  if (minutes <= 1) return 'ontime';
  if (minutes <= 5) return 'late';
  return 'verylate';
}

// Brisbane has no daylight saving: always UTC+10. Epoch seconds -> service date and seconds after midnight.
export function brisbaneClock(epochSec) {
  const local = epochSec + 10 * 3600;
  return {
    date: new Date(local * 1000).toISOString().slice(0, 10),
    secs: ((local % 86400) + 86400) % 86400,
  };
}

// Seconds after midnight -> "9:05 pm" style clock for the board
export function formatClock(secs) {
  const s = ((secs % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

// The realtime delay for one stop of a trip. GTFS-RT says a delay carries on to later stops
// until a new one is given, so use the update at this stop or the closest one before it.
export function delayAtStop(tripUpdate, stopSequence) {
  if (!tripUpdate) return { delay: null, skipped: false };
  let best = null;
  for (const s of tripUpdate.stops) {
    if (s.sequence === null || s.sequence > stopSequence) continue;
    if (!best || s.sequence > best.sequence) best = s;
  }
  if (!best) return { delay: null, skipped: false };
  return { delay: best.delay, skipped: best.sequence === stopSequence && best.skipped };
}

// "2026-11-09T18:30" (Brisbane time, from a date-time picker) -> { date, secs, epoch }, or null if it isn't a real time
export function parseLocalTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const utc = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(utc);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, secs: h * 3600 + mi * 60, epoch: utc / 1000 - 10 * 3600 };
}
