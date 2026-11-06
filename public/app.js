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

// Dark or light text, whichever reads better on a given line colour
function textOn(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#1d1d1d' : '#ffffff';
}

async function getJson(url) {
    const response = await fetch(url);
    // Error responses (e.g. 429 from the rate limiter) may be plain text, not JSON
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || (response.status === 429 ? 'Too many requests, try again in a minute' : `Server error ${response.status}`));
    return data;
}

// ---------- URL state (?line=Springfield&station=...&tab=board) so a view can be shared ----------
const params = new URLSearchParams(location.search);
const state = {
    line: params.get('line') || '',
    station: params.get('station') || DEFAULT_STATION,
    tab: ['trains', 'board', 'alerts'].includes(params.get('tab')) ? params.get('tab') : 'trains',
    selected: null, // trip id of the train whose journey is open
};
function saveUrl() {
    const p = new URLSearchParams();
    if (state.line) p.set('line', state.line);
    if (state.station !== DEFAULT_STATION) p.set('station', state.station);
    if (state.tab !== 'trains') p.set('tab', state.tab);
    history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
}

// ---------- Tabs ----------
const TABS = ['trains', 'board', 'alerts'];
function showTab(name) {
    state.tab = name;
    for (const t of TABS) {
        $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
        $(`view-${t}`).hidden = t !== name;
    }
    saveUrl();
}
for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => showTab(t));

// ---------- Map ----------
const map = L.map('map', { zoomControl: false }).setView([-27.5, 152.98], 10);
L.control.zoom({ position: 'topleft' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        + ' · <a href="https://translink.com.au/about-translink/open-data">TransLink</a> (CC BY 4.0)',
}).addTo(map);

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const LEVEL_VARS = { ontime: '--ontime', late: '--late', verylate: '--verylate', unknown: '--muted' };

// Track lines in each route's TransLink colour, with a pale casing so they read on any tile
async function drawTracks() {
    try {
        const shapes = await getJson('/api/shapes');
        const casing = L.layerGroup().addTo(map);
        const lines = L.layerGroup().addTo(map);
        for (const s of shapes) {
            L.polyline(s.coords, { color: '#fffaf3', weight: 6, opacity: 0.9, interactive: false }).addTo(casing);
            L.polyline(s.coords, { color: s.color, weight: 3, opacity: 0.9, interactive: false }).addTo(lines);
        }
    } catch (err) {
        console.error('Failed to load track lines:', err);
    }
}

// One marker per train id, so a refresh moves markers instead of duplicating them
const trainMarkers = new Map();
let lines = [];
let lastTrains = [];

function routeVisible(train) {
    if (!state.line) return true;
    const line = lines.find((l) => l.name === state.line);
    return !line || line.routeIds.includes(train.routeId);
}

function markerStyle(t) {
    const selected = t.tripId === state.selected;
    return {
        radius: selected ? 10 : 7,
        weight: selected ? 4 : 3,
        color: '#fffaf3', // white ring keeps every dot readable on top of the coloured tracks
        fillColor: cssVar(LEVEL_VARS[t.level] ?? '--muted'),
        fillOpacity: 1,
    };
}

function drawTrains() {
    const seen = new Set();
    for (const t of lastTrains) {
        if (!routeVisible(t)) continue;
        seen.add(t.id);
        const tip = `${t.headsign ? `To ${t.headsign}` : t.routeName} · ${t.delayText}`;
        const marker = trainMarkers.get(t.id);
        if (marker) {
            marker.setLatLng([t.lat, t.lng]).setStyle(markerStyle(t)).setTooltipContent(escapeHtml(tip));
        } else {
            const m = L.circleMarker([t.lat, t.lng], markerStyle(t)).addTo(map)
                .bindTooltip(escapeHtml(tip), { direction: 'top', offset: [0, -8] });
            m.on('click', () => selectTrain(m.trainTripId));
            trainMarkers.set(t.id, m);
        }
        trainMarkers.get(t.id).trainTripId = t.tripId;
        if (t.tripId === state.selected) trainMarkers.get(t.id).bringToFront();
    }
    for (const [id, marker] of trainMarkers) {
        if (!seen.has(id)) {
            map.removeLayer(marker);
            trainMarkers.delete(id);
        }
    }
}

// Only problems get a coloured badge; "On time" is quiet text, so late trains stand out
function statusHtml(level, text) {
    return level === 'late' || level === 'verylate' || level === 'cancelled'
        ? `<span class="chip ${escapeHtml(level)}">${escapeHtml(text)}</span>`
        : `<span class="quiet">${escapeHtml(text)}</span>`;
}

// ---------- Train list ----------
const LEVEL_ORDER = { verylate: 0, late: 1, ontime: 2, unknown: 3 };
const LIST_STEP = 12;
let listLimit = LIST_STEP;
function renderTrainList() {
    const list = $('train-list');
    const trains = lastTrains.filter(routeVisible)
        // Late trains first: that's what someone checking the network wants to know
        .sort((a, b) => (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) || (b.delaySec ?? 0) - (a.delaySec ?? 0));
    if (trains.length === 0) {
        list.innerHTML = `<li class="muted">${state.line ? `No ${escapeHtml(state.line)} trains running right now.` : 'No trains running right now.'}</li>`;
        return;
    }
    const hidden = trains.length - listLimit;
    list.innerHTML = trains.slice(0, listLimit).map((t) => `
        <li><button class="train" type="button" data-trip="${escapeHtml(t.tripId)}" aria-pressed="${t.tripId === state.selected}" style="--c:${escapeHtml(t.color)}">
          <span class="bar"></span>
          <span class="to">To ${escapeHtml(t.headsign ?? 'unknown')}</span>
          ${statusHtml(t.level, t.delayText)}
          <span class="meta">${t.nextStop ? `Next: ${escapeHtml(t.nextStop)}` : escapeHtml(t.routeName)}</span>
        </button></li>`).join('')
        + (hidden > 0 ? `<li><button class="more-btn" type="button" data-more>Show ${hidden} more trains</button></li>` : '');
}
$('train-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) {
        listLimit = Infinity;
        renderTrainList();
        return;
    }
    const button = e.target.closest('[data-trip]');
    if (button) selectTrain(button.dataset.trip);
});

// ---------- Journey card ----------
let showAllStops = false;
$('journey-stops').addEventListener('click', (e) => {
    if (e.target.closest('[data-unfold]')) {
        showAllStops = true;
        loadJourney();
    }
});

async function selectTrain(tripId) {
    state.selected = tripId;
    showAllStops = false;
    const train = lastTrains.find((t) => t.tripId === tripId);
    if (train) map.flyTo([train.lat, train.lng], Math.max(map.getZoom(), 12), { duration: 0.6 });
    drawTrains();
    renderTrainList();
    await loadJourney();
}

async function loadJourney() {
    if (!state.selected) return;
    const card = $('journey');
    try {
        const j = await getJson(`/api/trips/${encodeURIComponent(state.selected)}`);
        const pill = $('journey-line');
        pill.textContent = j.routeName;
        pill.style.background = j.color;
        pill.style.color = j.textColor;
        $('journey-title').textContent = `To ${j.headsign}`;
        const next = j.stops.find((s) => s.state === 'next');
        $('journey-sub').textContent = next
            ? `Next stop ${next.name}${next.expected ? `, expected ${next.expected}` : ` at ${next.scheduled}`}`
            : 'Journey finished';
        const stops = $('journey-stops');
        stops.style.setProperty('--c', j.color);
        // Stops already passed are folded away except the last one, so the card stays short
        const passed = j.stops.filter((s) => s.state === 'passed').length;
        const folded = showAllStops ? 0 : Math.max(0, passed - 1);
        stops.innerHTML = (folded ? `<li class="fold"><button type="button" class="link-btn" data-unfold>${folded} earlier stop${folded === 1 ? '' : 's'}</button></li>` : '')
            + j.stops.slice(folded).map((s) => `
            <li class="${s.state}">
              <span class="name">${escapeHtml(s.name)}</span>
              <span class="time">${s.expected ? `<s>${escapeHtml(s.scheduled)}</s>${escapeHtml(s.expected)}` : escapeHtml(s.scheduled)}</span>
              ${s.state === 'skipped' ? '<span class="sub">Not stopping</span>' : s.platform && s.state === 'next' ? `<span class="sub">Platform ${escapeHtml(s.platform)}</span>` : ''}
            </li>`).join('');
        card.hidden = false;
        // Keep the next stop in view inside the card
        if (window.innerWidth < 1000 && !card.dataset.shown) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        card.dataset.shown = '1';
    } catch (err) {
        console.error('Failed to load journey:', err);
        card.hidden = true;
    }
}

function closeJourney() {
    state.selected = null;
    $('journey').hidden = true;
    delete $('journey').dataset.shown;
    drawTrains();
    renderTrainList();
}
$('journey-close').addEventListener('click', closeJourney);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selected) closeJourney();
});

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
    text.textContent = feedState === 'stale' ? `Feed down · data from ${age}` : `Live · ${age}`;
}
setInterval(renderFeedStatus, 5000);

// ---------- Trains + numbers ----------
async function loadLive() {
    try {
        const [trains, summary] = await Promise.all([getJson('/api/trains'), getJson('/api/summary')]);
        lastTrains = trains.trains;
        drawTrains();
        renderTrainList();
        lastUpdated = new Date(trains.updatedAt).getTime();
        feedState = trains.stale ? 'stale' : 'live';
        renderSummary(summary);
        if (state.selected) loadJourney();
    } catch (err) {
        console.error('Failed to load trains:', err);
        feedState = 'down';
    }
    renderFeedStatus();
}

function renderSummary(s) {
    $('kpi-running').textContent = s.running;
    const onTime = $('kpi-ontime');
    onTime.textContent = s.onTimePercent === null ? '–' : `${s.onTimePercent}%`;
    onTime.className = s.onTimePercent === null ? '' : s.onTimePercent >= 90 ? 'good' : s.onTimePercent >= 75 ? 'warn' : 'bad';
    $('kpi-delay').textContent = `${Math.round(s.avgLateMinutes)} min`;
    $('kpi-delay-wrap').hidden = !s.avgLateMinutes;
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
    drawTrains();
    renderTrainList();
}
$('line-filter').addEventListener('change', (e) => applyLine(e.target.value));
$('line-clear').addEventListener('click', () => applyLine(''));

// ---------- Next trains ----------
async function loadStations() {
    const stations = await getJson('/api/stations');
    if (!stations.some((s) => s.id === state.station)) state.station = DEFAULT_STATION;
    $('station-select').innerHTML = stations
        .map((s) => `<option value="${escapeHtml(s.id)}"${s.id === state.station ? ' selected' : ''}>${escapeHtml(s.name)}</option>`)
        .join('');
}

async function loadBoard() {
    const board = $('board');
    try {
        const { departures } = await getJson(`/api/departures?station=${encodeURIComponent(state.station)}`);
        if (departures.length === 0) {
            board.innerHTML = '<li class="muted">No trains in the next 2 hours.</li>';
            return;
        }
        board.innerHTML = departures.map((d) => `
            <li class="${d.status === 'cancelled' ? 'cancelled' : ''}">
              <span class="time">${d.expected ? `<small>${escapeHtml(d.scheduled)}</small>${escapeHtml(d.expected)}` : escapeHtml(d.scheduled)}</span>
              <span class="to" style="--c:${escapeHtml(d.color)}" title="${escapeHtml(d.routeName)}">${escapeHtml(d.headsign)}</span>
              <span class="right">${statusHtml(d.status, d.statusText)}${d.platform ? `<span class="plat">Platform ${escapeHtml(d.platform)}</span>` : ''}</span>
            </li>`).join('');
    } catch (err) {
        board.innerHTML = `<li class="muted">Couldn’t load departures. ${escapeHtml(err.message)}</li>`;
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
        $('alerts-count').textContent = alerts.length || '';
        if (alerts.length === 0) {
            list.innerHTML = '<li class="muted">No rail alerts right now.</li>';
            return;
        }
        list.innerHTML = alerts.map((a) => {
            const shown = a.lines.slice(0, 3);
            const more = a.lines.length - shown.length;
            return `
            <li class="${a.severe ? 'severe' : ''}">
              <span class="effect">${escapeHtml(a.effect)}</span>
              ${a.url ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.header)}</a>` : `<b>${escapeHtml(a.header)}</b>`}
              <p>${escapeHtml(a.description)}</p>
              ${shown.length ? `<div class="alert-lines">${shown.map((l) => `<span style="--c:${escapeHtml(l.color)};--tc:${textOn(l.color)}">${escapeHtml(l.name)}</span>`).join('')}${more > 0 ? `<span style="--c:var(--sand-2);--tc:var(--muted)">+${more}</span>` : ''}</div>` : ''}
            </li>`;
        }).join('');
    } catch (err) {
        list.innerHTML = `<li class="muted">Couldn’t load alerts. ${escapeHtml(err.message)}</li>`;
    }
}

// ---------- Start ----------
async function start() {
    showTab(state.tab);
    drawTracks();
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
