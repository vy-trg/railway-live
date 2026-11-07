const MODE_ORDER = { train: 0, tram: 1, ferry: 2 };

// TransLink rail routes are named by their two ends, e.g. "Brisbane City - Springfield" or
// "Springfield - Caboolture". A "line" here is one end that isn't Brisbane City, and it
// covers every route that starts or finishes there. Picking "Springfield" shows all trains
// running to or from Springfield, which is what a passenger means by "the Springfield line".
export function buildLines(routes) {
  const lines = new Map();
  for (const r of routes) {
    // Trams and ferries: each route is its own line, e.g. "G:link" or "Ferry F1"
    if (r.mode === 'tram' || r.mode === 'ferry') {
      const name = r.mode === 'tram' ? 'G:link' : `Ferry ${r.short_name}`;
      lines.set(name, { name, mode: r.mode, routeIds: [r.route_id], colors: new Map([[r.color, 1]]) });
      continue;
    }
    for (const end of new Set(r.long_name.split(' - ').map((s) => s.trim()))) {
      if (end === 'Brisbane City') continue;
      if (!lines.has(end)) lines.set(end, { name: end, mode: 'train', routeIds: [], colors: new Map() });
      const line = lines.get(end);
      line.routeIds.push(r.route_id);
      line.colors.set(r.color, (line.colors.get(r.color) ?? 0) + 1);
    }
  }
  return [...lines.values()]
    .map((l) => ({
      name: l.name,
      mode: l.mode,
      routeIds: l.routeIds,
      // The colour most of its routes use on TransLink's network map
      color: [...l.colors.entries()].sort((a, b) => b[1] - a[1])[0][0],
    }))
    // Train lines first, then G:link, then ferries
    .sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode] || a.name.localeCompare(b.name, 'en', { numeric: true }));
}
