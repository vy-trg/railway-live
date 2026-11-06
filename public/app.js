const REFRESH_MS = 30000;
const ALERTS_REFRESH_MS = 5 * 60000;
const DEFAULT_STATION = 'place_spcsta'; // Springfield Central: the station this app was built for

const $ = (id) => document.getElementById(id);

// Feed values go into HTML, so escape them first
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

async function getJson(url) {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);
    return data;
}

// ---------- URL state: ?line=Springfield&station=place_spcsta, so a view can be shared ----------
const params = new URLSearchParams(location.search);
const state = {
    line: params.get('line') || '',
    station: params.get('station') || DEFAULT_STATION,
};
function saveUrl() {
    const p = new URLSearchParams();
    if (state.line) p.set('line', state.line);
    if (state.station !== DEFAULT_STATION) p.set('station', state.station);
    history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
}

// ---------- Map ----------
const map = L.map('map').setView([-27.5, 152.98], 10);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        + ' · <a href="https://translink.com.au/about-translink/open-data">TransLink</a> (CC BY 4.0)',
}).addTo(map);

const LEVEL_COLOURS = { ontime: '--ontime', late: '--late', verylate: '--verylate', unknown: '--muted' };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// One marker per train id, so a refresh moves markers instead of duplicating them
const trainMarkers = new Map();
let lines = [];
let lastTrains = [];

function popupHtml(t) {
    return `<span class="popup-line" style="background:${escapeHtml(t.color)};color:${escapeHtml(t.textColor)}">${escapeHtml(t.routeName)}</span><br>`
        + (t.headsign ? `<b>To ${escapeHtml(t.headsign)}</b><br>` : '')
        + (t.nextStop ? `Next stop: ${escapeHtml(t.nextStop)}<br>` : '')
        // Always the number in words, so colour is never the only signal
        + `${escapeHtml(t.delayText)}`;
}

function routeVisible(train) {
    if (!state.line) return true;
    const line = lines.find((l) => l.name === state.line);
    return !line || line.routeIds.includes(train.routeId);
}

function drawTrains(trains) {
    const seen = new Set();
    for (const t of trains) {
        if (!routeVisible(t)) continue;
        seen.add(t.id);
        const style = {
            radius: 7, weight: 3,
            color: t.color, // ring: the line's own colour
            fillColor: cssVar(LEVEL_COLOURS[t.level] ?? '--muted'), // fill: how late it is
            fillOpacity: 0.95,
        };
        const marker = trainMarkers.get(t.id);
        if (marker) {
            marker.setLatLng([t.lat, t.lng]).setStyle(style).setPopupContent(popupHtml(t));
        } else {
            trainMarkers.set(t.id, L.circleMarker([t.lat, t.lng], style).addTo(map).bindPopup(popupHtml(t)));
        }
    }
    for (const [id, marker] of trainMarkers) {
        if (!seen.has(id)) {
            map.removeLayer(marker);
            trainMarkers.delete(id);
        }
    }
}

// ---------- Feed status pill ----------
let lastUpdated = null;
let feedState = 'connecting';
function renderFeedStatus() {
    const el = $('feed-status');
    el.className = `feed ${feedState}`;
    const text = el.querySelector('.feed-text');
    if (feedState === 'down') {
        text.textContent = 'Can’t reach the server · retrying';
        return;
    }
    if (!lastUpdated) return;
    const seconds = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000));
    const age = seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
    text.textContent = feedState === 'stale'
        ? `TransLink feed unavailable · showing data from ${age}`
        : `Live · TransLink · updated ${age}`;
}
setInterval(renderFeedStatus, 5000);

// ---------- Trains + numbers ----------
async function loadLive() {
    try {
        const [trains, summary] = await Promise.all([getJson('/api/trains'), getJson('/api/summary')]);
        lastTrains = trains.trains;
        drawTrains(lastTrains);
        lastUpdated = new Date(trains.updatedAt).getTime();
        feedState = trains.stale ? 'stale' : 'live';
        renderSummary(summary);
    } catch (err) {
        console.error('Failed to load trains:', err);
        feedState = 'down';
    }
    renderFeedStatus();
}

function renderSummary(s) {
    $('kpi-running').textContent = s.running;
    $('kpi-running-sub').textContent = `${s.withDelayInfo} with live times`;
    const onTime = $('kpi-ontime');
    onTime.textContent = s.onTimePercent === null ? '–' : `${s.onTimePercent}%`;
    onTime.className = s.onTimePercent === null ? '' : s.onTimePercent >= 90 ? 'good' : s.onTimePercent >= 75 ? 'warn' : 'bad';
    $('kpi-delay').textContent = s.avgLateMinutes ? `${s.avgLateMinutes} min` : '0 min';
    if (s.mostDelayed) {
        $('kpi-worst').textContent = s.mostDelayed.name;
        $('kpi-worst-sub').textContent = `about ${s.mostDelayed.minutes} min behind`;
    } else {
        $('kpi-worst').textContent = 'None';
        $('kpi-worst-sub').textContent = 'every line within a minute';
    }
}

// ---------- Line filter ----------
async function loadLines() {
    lines = await getJson('/api/lines');
    $('line-list').innerHTML = lines.map((l) => `<option value="${escapeHtml(l.name)}"></option>`).join('');
    if (state.line && !lines.some((l) => l.name === state.line)) state.line = '';
    $('line-filter').value = state.line;
    $('line-clear').hidden = !state.line;
}

function applyLine(name) {
    const match = lines.find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
    state.line = match ? match.name : '';
    $('line-filter').value = state.line;
    $('line-clear').hidden = !state.line;
    saveUrl();
    drawTrains(lastTrains);
}
$('line-filter').addEventListener('change', (e) => applyLine(e.target.value));
$('line-clear').addEventListener('click', () => applyLine(''));

// ---------- Departure board ----------
async function loadStations() {
    const stations = await getJson('/api/stations');
    if (!stations.some((s) => s.id === state.station)) state.station = DEFAULT_STATION;
    $('station-select').innerHTML = stations
        .map((s) => `<option value="${escapeHtml(s.id)}"${s.id === state.station ? ' selected' : ''}>${escapeHtml(s.name)}</option>`)
        .join('');
}

async function loadBoard() {
    const body = $('board-rows');
    try {
        const { departures } = await getJson(`/api/departures?station=${encodeURIComponent(state.station)}`);
        if (departures.length === 0) {
            body.innerHTML = '<tr><td colspan="4" class="muted">No trains in the next 2 hours.</td></tr>';
            return;
        }
        body.innerHTML = departures.map((d) => `
            <tr class="${d.status === 'cancelled' ? 'cancelled' : ''}">
              <td class="time">${d.expected ? `<s>${escapeHtml(d.scheduled)}</s>${escapeHtml(d.expected)}` : escapeHtml(d.scheduled)}</td>
              <td class="to"><b>${escapeHtml(d.headsign)}</b><span style="--c:${escapeHtml(d.color)}">${escapeHtml(d.routeName)}</span></td>
              <td class="plat">${escapeHtml(d.platform ?? '–')}</td>
              <td><span class="status ${escapeHtml(d.status)}">${escapeHtml(d.statusText)}</span></td>
            </tr>`).join('');
    } catch (err) {
        body.innerHTML = `<tr><td colspan="4" class="muted">Couldn’t load departures. ${escapeHtml(err.message)}</td></tr>`;
    }
}
$('station-select').addEventListener('change', (e) => {
    state.station = e.target.value;
    saveUrl();
    loadBoard();
});

// ---------- Alerts ----------
async function loadAlerts() {
    const list = $('alerts');
    try {
        const { alerts } = await getJson('/api/alerts');
        $('alerts-count').textContent = alerts.length ? `${alerts.length} active` : '';
        if (alerts.length === 0) {
            list.innerHTML = '<li class="muted">No rail alerts right now.</li>';
            return;
        }
        list.innerHTML = alerts.map((a) => {
            const shown = a.lines.slice(0, 4);
            const more = a.lines.length - shown.length;
            return `
            <li class="${a.severe ? 'severe' : ''}">
              <div class="head"><span class="effect">${escapeHtml(a.effect)}</span>
                ${a.url ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.header)}</a>` : `<b>${escapeHtml(a.header)}</b>`}</div>
              <p>${escapeHtml(a.description)}</p>
              ${shown.length ? `<div class="chips">${shown.map((l) => `<span class="chip" style="--c:${escapeHtml(l.color)}">${escapeHtml(l.name)}</span>`).join('')}${more > 0 ? `<span class="chip" style="--c:var(--line)">+${more} more</span>` : ''}</div>` : ''}
            </li>`;
        }).join('');
    } catch (err) {
        list.innerHTML = `<li class="muted">Couldn’t load alerts. ${escapeHtml(err.message)}</li>`;
    }
}

// ---------- Start ----------
async function start() {
    try {
        await Promise.all([loadLines(), loadStations()]);
    } catch (err) {
        console.error('Failed to load timetable data:', err);
    }
    loadLive();
    loadBoard();
    loadAlerts();
    setInterval(() => { loadLive(); loadBoard(); }, REFRESH_MS);
    setInterval(loadAlerts, ALERTS_REFRESH_MS);
}
start();

// Phones pause timers in background tabs, so refresh as soon as the page is visible again
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        loadLive();
        loadBoard();
    }
});
