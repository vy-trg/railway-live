import GtfsRealtimeBindings from "gtfs-realtime-bindings";

(async () => {
  try {
    const response = await fetch("https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Rail");
    if (!response.ok) {
      const error = new Error(`${response.url}: ${response.status} ${response.statusText}`);
      error.response = response;
      throw error;
    }
    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );

    // Keep only entities that have a position, then pick 3 fields from each
    const trains = feed.entity
      .filter((e) => e.vehicle && e.vehicle.position)
      .map((e) => ({
        tripId: e.vehicle.trip?.tripId,
        lat: e.vehicle.position.latitude.toFixed(5),
        lon: e.vehicle.position.longitude.toFixed(5),
      }));

    console.log(`Trains running now: ${trains.length}`);
    console.table(trains.slice(0, 10)); // first 10 trains
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
})();