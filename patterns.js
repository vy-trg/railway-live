// Trip patterns: trips that stop at the same stops, with the same stop sequence numbers and
// the same gaps between stops, share one pattern. Each trip then only needs its start time.
// byTrip: Map trip_id -> [[stop_sequence, stop_id, arrival_secs, departure_secs], ...]
// Returns { patternStops: [[pattern_id, seq, stop_id, arr_offset, dep_offset, is_last]], tripPattern: Map trip_id -> [pattern_id, start_secs] }
export function buildPatterns(byTrip) {
    const ids = new Map();
    const patternStops = [];
    const tripPattern = new Map();
    for (const [tripId, list] of byTrip) {
        if (list.length === 0) continue;
        const stops = [...list].sort((x, y) => x[0] - y[0]);
        const start = stops[0][3];
        const key = stops.map(([seq, stop, arr, dep]) => `${seq}|${stop}|${arr - start}|${dep - start}`).join(',');
        let id = ids.get(key);
        if (id === undefined) {
            id = ids.size + 1;
            ids.set(key, id);
            stops.forEach(([seq, stop, arr, dep], i) => patternStops.push([id, seq, stop, arr - start, dep - start, i === stops.length - 1]));
        }
        tripPattern.set(tripId, [id, start]);
    }
    return { patternStops, tripPattern, patternCount: ids.size };
}
