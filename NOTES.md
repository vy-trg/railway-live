# Notes

## Data source
- Vehicle positions: https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Rail
- Trip updates: https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Rail
- No API key needed. Licence: CC BY 4.0, must credit TransLink in README.

## What I learned
- The feed is protobuf, not JSON; FeedMessage.decode turns it into JS objects.
- VehiclePositions = where each train is now. TripUpdates = delays/arrival times.
- Feed updates about every 30 seconds, so polling faster gives nothing new.
- Plan: server fetches every 30s and caches the latest result; browser asks my server, not TransLink.