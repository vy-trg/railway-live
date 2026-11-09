// Douglas–Peucker line simplification: keeps the points that matter for the shape of a line
// and drops the rest. A train line with 1,900 points becomes a few hundred and looks the same.
// points: [[lat, lng], ...], tolerance in degrees (0.0001 is about 11 metres).
export function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = distanceToSegment(points[i], points[start], points[end]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > tolerance) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function distanceToSegment([y, x], [y1, x1], [y2, x2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

// Metres between two [lat, lng] points (equirectangular: plenty for a few km)
function metres([lat1, lng1], [lat2, lng2]) {
  const x = ((lng2 - lng1) * Math.PI / 180) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  const y = ((lat2 - lat1) * Math.PI / 180);
  return Math.hypot(x, y) * 6371000;
}

// Closest point on segment a-b to p, and how far it is (metres). Flat maths is fine over a few km.
function toSegment(p, a, b) {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const ax = a[1] * k; const ay = a[0];
  const dx = b[1] * k - ax; const dy = b[0] - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[1] * k - ax) * dx + (p[0] - ay) * dy) / len));
  const q = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return { q, t, d: metres(p, q) };
}

// The part of a route's track that one ride uses, so the line follows the real road or rails
// instead of jumping straight from stop to stop.
// shape: the route's track [[lat, lng], ...] (in either direction). It is simplified, so long straight
// stretches have no points in the middle: stops are matched to the closest point on a segment.
// stops: the stops of the ride in order, from where you get on to where you get off.
// Each stop must be within maxSnapM of the track, in order along it; otherwise this track
// isn't the one the trip uses (a different variant) and the answer is null.
export function slicePath(shape, stops, maxSnapM = 120) {
  if (!shape || shape.length < 2 || stops.length < 2) return null;
  let best = null;
  for (const line of [shape, [...shape].reverse()]) {
    const hits = [];
    let seg = 0;
    let minT = 0;
    let total = 0;
    let ok = true;
    for (const stop of stops) {
      // First segment along the track (from the previous stop on) that comes close, then the closest nearby
      let i = seg;
      let hit = null;
      for (; i < line.length - 1; i += 1) {
        const h = toSegment(stop, line[i], line[i + 1]);
        if (i === seg && h.t < minT) continue; // not backwards on the same segment
        if (h.d <= maxSnapM) { hit = { ...h, i }; break; }
      }
      if (!hit) { ok = false; break; }
      while (hit.i + 1 < line.length - 1) {
        const next = toSegment(stop, line[hit.i + 1], line[hit.i + 2]);
        if (next.d >= hit.d) break;
        hit = { ...next, i: hit.i + 1 };
      }
      hits.push(hit);
      total += hit.d;
      seg = hit.i;
      minT = hit.t;
    }
    if (!ok) continue;
    const first = hits[0];
    const last = hits[hits.length - 1];
    const path = [stops[0], first.q, ...line.slice(first.i + 1, last.i + 1), last.q, stops[stops.length - 1]];
    // A track much longer than the stops themselves means it went somewhere the trip doesn't
    if (pathLength(path) > 2.5 * pathLength(stops) + 1000) continue;
    if (!best || total < best.total) best = { total, path };
  }
  return best ? best.path : null;
}

function pathLength(points) {
  let m = 0;
  for (let i = 1; i < points.length; i += 1) m += metres(points[i - 1], points[i]);
  return m;
}
