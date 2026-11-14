# Start journey

The problem: a planned journey is a list to read once. On the way, people (especially those who don't use transport apps much) need one thing at a time: what to do now, and a nudge at the moment it matters.

## What it does

Open a planned journey and press **Start journey** (shown from 90 minutes before you leave until the journey is over). Then:

- **One instruction at a time**, big: "Walk about 2 mins to Ann Street Stop 7", "Get on the bus 433 to Kenmore (in 3 mins)", "Get off at Coonan St · 2 stops to go". The whole journey is listed underneath, done steps crossed off.
- **Worked out from where the vehicle is**, not your phone's GPS (`GET /api/trips/:id`, every 15 seconds): it works underground and with location off. TransLink's live data when there is some, the timetable when there isn't.
- **Moments that matter**, each once, with a sound, a buzz and the banner (and a notification if the page is in the background and you allowed them):
  - 2 minutes before your service leaves: "Your train to Caboolture leaves Springfield from platform 2 in 2 mins."
  - Train, tram, ferry: "Next stop: get off at Indooroopilly."
  - Bus: 2 stops before ("press the bell after the next stop") and 1 stop before ("press the bell now"). SEQ buses only stop if someone asks.
  - About to miss a change because the one you're on is late: "You may miss the bus 468 at 3:42 pm", with **Find another way** (plans again from where you'll get off).
- **Walking directions** for the walk you're on, in short sentences from the walking router (OpenStreetMap streets): "Head east on Station Rd for 80 m", "Turn left onto Coonan St".
- **The screen stays on** while a journey is running (Wake Lock, where the browser has it).
- **Survives a reload**: the journey is kept on this device until it's over or you press End journey.

## Limits

- Station exits aren't published by TransLink, so it doesn't say which exit or which way to walk out of a station.
- In the background (screen off, another app) a web page can't run reliably, so the server follows the journey and sends the alerts as Web Push notifications (`push.js`, `public/sw.js`). That needs: notifications allowed; on iPhone, Add to Home Screen first (iOS 16.4+); the VAPID keys set on the server. The page says plainly which of these is missing.
- The server keeps followed journeys in memory (an hour or two each): a deploy, or the free Render server sleeping after 15 minutes without visitors, stops push alerts until the page is opened again.
- A bus with no live data is followed by its timetable.
