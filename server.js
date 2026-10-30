import express from 'express';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

// 1. Initialize Express application first
const app = express();
const PORT = process.env.PORT || 3000;

// TransLink GTFS-RT Vehicle Positions URL (No API key required)
const TRANS_LINK_URL = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Rail";

// Cache variables to store train data and last fetch timestamp
let trainCache = {
    data: null,
    lastUpdated: 0
};
const CACHE_DURATION = 30000; // Cache duration set to 30 seconds (30,000 ms)

// 2. Serve static files from the 'public' folder (same origin, avoids CORS issues)
app.use(express.static('public'));

// Helper function to fetch and decode train data from TransLink feed
async function fetchTrains() {
    const response = await fetch(TRANS_LINK_URL);
    if (!response.ok) {
        throw new Error(`Failed to fetch feed: ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
    
    const trains = [];
    feed.entity.forEach((entity) => {
        if (entity.vehicle && entity.vehicle.position) {
            trains.push({
                id: entity.id,
                tripId: entity.vehicle.trip ? entity.vehicle.trip.tripId : null,
                lat: entity.vehicle.position.latitude,
                lng: entity.vehicle.position.longitude
            });
        }
    });
    
    return trains;
}

// API endpoint to get train positions with 30-second caching
app.get('/api/trains', async (req, res) => {
    const currentTime = Date.now();
    
    // Return cached data if it is still valid
    if (trainCache.data && (currentTime - trainCache.lastUpdated < CACHE_DURATION)) {
        return res.json({
            updatedAt: new Date(trainCache.lastUpdated).toISOString(),
            source: "cache",
            trains: trainCache.data
        });
    }

    try {
        // Fetch fresh data from TransLink feed
        const freshTrains = await fetchTrains();
        
        // Update cache
        trainCache.data = freshTrains;
        trainCache.lastUpdated = Date.now();

        res.json({
            updatedAt: new Date(trainCache.lastUpdated).toISOString(),
            source: "live",
            trains: freshTrains
        });
    } catch (error) {
        console.error("Error fetching train data:", error);
        
        // Fallback to stale cache if available when API fails
        if (trainCache.data) {
            return res.status(200).json({
                updatedAt: new Date(trainCache.lastUpdated).toISOString(),
                source: "stale-cache",
                trains: trainCache.data
            });
        }
        
        res.status(500).json({ error: "Failed to fetch train positions" });
    }
});

// 3. Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});