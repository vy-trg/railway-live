// TransLink rail routes are named by their two ends, e.g. "Brisbane City - Springfield" or
// "Springfield - Caboolture". A "line" here is one end that isn't Brisbane City, and it
// covers every route that starts or finishes there. Picking "Springfield" shows all trains
// running to or from Springfield, which is what a passenger means by "the Springfield line".
export function buildLines(routes) {
  const lines = new Map();
  for (const r of routes) {
    for (const end of new Set(r.long_name.split(' - ').map((s) => s.trim()))) {
      if (end === 'Brisbane City') continue;
      if (!lines.has(end)) lines.set(end, { name: end, routeIds: [], colors: new Map() });
      const line = lines.get(end);
      line.routeIds.push(r.route_id);
      line.colors.set(r.color, (line.colors.get(r.color) ?? 0) + 1);
    }
  }
  return [...lines.values()]
    .map((l) => ({
      name: l.name,
      routeIds: l.routeIds,
      // The colour most of its routes use on TransLink's network map
      color: [...l.colors.entries()].sort((a, b) => b[1] - a[1])[0][0],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
