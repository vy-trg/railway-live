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
## Train + bus (week 3)
See docs/connections.md. From the timetable:
- Sherwood (place_shesta) → bus 598 (route 598-4) from Sherwood Rd near Hedges St (stop 5341, ~110 m) to Troughton Rd at QEII Hospital (10306), ~23 min, every ~30 min, 6 am – 6:15 pm.
- Roma Street (place_romsta) → M1 Metro (route M1-4) from Roma Street busway platform 2 (10792) to Griffith University station platform 2 (10819), ~19 min, every few minutes.
- No other Springfield line station has a direct bus to Nathan within 500 m.
