        const REFRESH_MS = 30000;
        const banner = document.getElementById('status-banner');

        // Map centred on Brisbane
        const map = L.map('map').setView([-27.47, 153.02], 11);

        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                + ' · Train data: <a href="https://translink.com.au/about-translink/open-data">TransLink</a> (CC BY 4.0)'
        }).addTo(map);

        // One marker per train id, so a refresh moves markers instead of duplicating them
        const trainMarkers = new Map();

        // Feed values go into popup HTML, so escape them first
        function escapeHtml(value) {
            return String(value ?? 'N/A').replace(/[&<>"']/g, (c) => (
                { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
            ));
        }

        function brisbaneTime(iso) {
            return new Date(iso).toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane' });
        }

        function showStatus(kind, text) {
            banner.className = kind;
            banner.textContent = text;
        }

        async function loadTrains() {
            try {
                const response = await fetch('/api/trains');
                const data = await response.json();

                if (!response.ok) {
                    // 503: server has no data at all yet; keep whatever is on the map
                    showStatus('error', `❌ ${data.error || 'Server error'}. Retrying in 30 seconds…`);
                    return;
                }

                const currentIds = new Set();

                data.trains.forEach((train) => {
                    currentIds.add(train.id);
                    const popup = `<b>Train:</b> ${escapeHtml(train.id)}<br><b>Trip:</b> ${escapeHtml(train.tripId)}`;

                    if (trainMarkers.has(train.id)) {
                        trainMarkers.get(train.id).setLatLng([train.lat, train.lng]).setPopupContent(popup);
                    } else {
                        const marker = L.circleMarker([train.lat, train.lng], {
                            radius: 6, color: '#2f5fd0', fillColor: '#6f95ff', fillOpacity: 0.8
                        }).addTo(map).bindPopup(popup);
                        trainMarkers.set(train.id, marker);
                    }
                });

                // Remove trains that are no longer in the feed
                trainMarkers.forEach((marker, id) => {
                    if (!currentIds.has(id)) {
                        map.removeLayer(marker);
                        trainMarkers.delete(id);
                    }
                });

                const count = `${data.trains.length} train${data.trains.length === 1 ? '' : 's'}`;
                if (data.stale) {
                    showStatus('stale', `⚠️ Feed unavailable. Showing ${count} from ${brisbaneTime(data.updatedAt)}`);
                } else if (data.trains.length === 0) {
                    showStatus('ok', `No trains running right now · Updated ${brisbaneTime(data.updatedAt)}`);
                } else {
                    showStatus('ok', `✅ ${count} running · Updated ${brisbaneTime(data.updatedAt)}`);
                }
            } catch (error) {
                console.error('Failed to load train positions:', error);
                showStatus('error', '❌ Can’t reach the server. Retrying in 30 seconds…');
            }
        }

        loadTrains();
        setInterval(loadTrains, REFRESH_MS);

        // Phones pause timers in background tabs, so refresh as soon as the page is visible again
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') loadTrains();
        });
