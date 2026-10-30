# Railway Live 🚆

A real-time Brisbane train tracking web application built with Node.js, Express, and Leaflet.js, consuming TransLink's live GTFS-RT feed with smart 30-second caching and graceful error handling.

🔗 **[Live Demo](https://railway-live.onrender.com)** *(Replace with your Render link if available)* &nbsp;·&nbsp; 📁 **[GitHub Repo](https://github.com/vy-trg/railway-live)**

---

<p align="center">
  <img src="public/screenshot.png" alt="Railway Live Map Interface" width="720">
  <br>
  <sub>Live train positions across Brisbane network rendered with custom Leaflet markers and 30-second polling updates.</sub>
</p>

📺 **Demo video:** *(Add Loom or YouTube link here if available)*

---

## About

**Railway Live** addresses the challenge of visualizing live transit data reliably. TransLink provides real-time train positions via Protocol Buffers (GTFS-RT), but fetching live feeds directly from client devices risks rate-limiting and CORS issues. 

This project bridges that gap by implementing a lightweight Express backend that fetches, decodes, and caches vehicle positions every 30 seconds, providing a clean JSON API for an interactive Leaflet map interface.

**My role:** Independent Developer — designed the architecture, built the Node.js GTFS-RT ingestion backend, implemented the 30-second cache layer, built the responsive Leaflet frontend, and handled stale-data fallback UI states.

---

## Features

- **Live Train Tracking** — Real-time position markers for active rail vehicles across the SEQ (South East Queensland) network.
- **Auto-Refresh** — Polling mechanism that updates marker positions seamlessly every 30 seconds without page reloads.
- **Smart Server Caching** — Backend cache window (30s) ensuring 100 concurrent clients trigger at most 2 requests/minute to TransLink servers.
- **Resilient Fallback UI** — Status banner alerting users if the live feed is stale or unavailable, preserving the last known coordinates instead of breaking the UI.
- **Interactive Popups** — Click any train marker to inspect Train ID and Trip ID.
- **Responsive Layout** — Full-screen map view optimized for desktop and mobile browsers.

---

## Tech Stack

| Area | Tools |
|---|---|
| **Backend** | Node.js (v22+), Express |
| **Data Ingestion** | `gtfs-realtime-bindings` (Protocol Buffers decoder) |
| **Frontend** | Vanilla HTML5, CSS3, JavaScript (ES6 Modules) |
| **Mapping & UI** | Leaflet.js, OpenStreetMap tile layer |
| **Deployment** | Render (Web Service) |

---

## Architecture & Technical Decisions

The application follows a simple **Client–Server Architecture** serving static assets from the same origin to eliminate CORS complications:
[ Browser / Leaflet ] <--- (JSON via fetch every 30s) ---> [ Express API ] <--- (GTFS-RT Feed) ---> [ TransLink API ]
|
[ 30s In-Memory Cache ]

### Key Technical Decisions:
1. **Same-Origin Static Serving (`express.static`)**: Serving `index.html` directly through Express eliminates Cross-Origin Resource Sharing (CORS) preflight requests.
2. **In-Memory Cache Layer**: TransLink updates vehicle positions roughly every 30 seconds. Storing the decoded feed in an in-memory object (`trainCache`) avoids redundant network calls and guarantees fast API response times.
3. **Smooth Marker Movement (`setLatLng`)**: Existing markers are updated dynamically via `marker.setLatLng()` rather than re-creating map layers, avoiding screen flicker and preserving open popups.

---

## Getting Started

### Prerequisites
- **Node.js**: v22.0.0 or higher (required for native `fetch` and `gtfs-realtime-bindings` compatibility)
- **npm**: v10.0.0 or higher

### Installation

1. Clone the repository:
   ```bash
   git clone [https://github.com/vy-trg/railway-live.git](https://github.com/vy-trg/railway-live.git)
   cd railway-live