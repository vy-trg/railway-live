import GtfsRealtimeBindings from "gtfs-realtime-bindings";

(async () => {
  try {
    const response = await fetch("https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Rail", {
    });
    if (!response.ok) {
      const error = new Error(`${response.url}: ${response.status} ${response.statusText}`);
      error.response = response;
      throw error;
      process.exit(1);
    }
    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );
    feed.entity.forEach((entity) => {
      if (entity.vehicle) {
        console.log(entity.vehicle);
      }
    });
  }
  catch (error) {
    console.log(error);
    process.exit(1);
  }
})();