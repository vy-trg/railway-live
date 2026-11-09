const REFRESH_MS = 30000;
const ALERTS_REFRESH_MS = 5 * 60000;
const DEFAULT_STATION = 'place_spcsta'; // Springfield Central: the station this app was built for

const $ = (id) => document.getElementById(id);

// ---------- Motion helpers ----------
// Everything here is skipped for people who turn on "reduce motion" on their device.
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Hide an element after its exit animation (exits are ~20% shorter than entrances)
function hideWithExit(el, ms = 160) {
    if (el.hidden) return;
    if (reduceMotion()) { el.hidden = true; return; }
    el.classList.add('leaving');
    setTimeout(() => { el.classList.remove('leaving'); el.hidden = true; }, ms);
}

// Rows appear 30 ms apart, but only the first time a list is filled,
// so the 30-second refresh doesn't make everything dance again
function staggerOnce(list) {
    if (list.dataset.staggered || reduceMotion()) return;
    list.dataset.staggered = '1';
    list.classList.add('stagger');
    setTimeout(() => list.classList.remove('stagger'), 900);
}

// Restart a short CSS animation (used for the "saved" pulse)
function pulse(el) {
    if (!el || reduceMotion()) return;
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
}

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
    place: params.get('place') || '', // free-text place, e.g. 'Springfield'
    mode: ['train', 'tram', 'ferry', 'bus'].includes(params.get('mode')) ? params.get('mode') : '', // '' = all
    station: params.get('station') || DEFAULT_STATION,
    tab: ['trains', 'plan', 'board', 'alerts', 'stats'].includes(params.get('tab')) ? params.get('tab') : 'trains',
    at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(params.get('at') ?? '') ? params.get('at') : '', // planned time, '' = now
    selected: null, // trip id of the train whose journey is open
};
let statsDays = 7; // period on the Stats tab
function saveUrl() {
    const p = new URLSearchParams();
    if (state.mode) p.set('mode', state.mode);
    if (state.line) p.set('line', state.line);
    if (state.place) p.set('place', state.place);
    if (state.station !== DEFAULT_STATION) p.set('station', state.station);
    if (state.tab !== 'trains') p.set('tab', state.tab);
    if (state.at) p.set('at', state.at);
    history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
}

// ---------- Tabs ----------
const TABS = ['trains', 'plan', 'board', 'alerts', 'stats'];
function showTab(name) {
    state.tab = name;
    for (const t of TABS) {
        $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
        $(`view-${t}`).hidden = t !== name;
    }
    // The highlight slides to the chosen tab (position 0 to 4)
    document.querySelector('.tabs').style.setProperty('--tab', TABS.indexOf(name));
    if (name === 'stats') loadStats();
    // The station pin belongs to the Departures tab
    if (name === 'board') showStationOnMap(stations.find((x) => x.id === state.station), false);
    else stationPin.clearLayers();
    // The planned journey's line belongs to the Plan tab
    if (name !== 'plan') planLayer.clearLayers();
    else if (planShown) drawPlan(planShown);
    saveUrl();
}
for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => showTab(t));

// ---------- Map ----------
// The map can't be dragged far from South East Queensland; at the edge it pulls back like a rubber band
const SEQ_BOUNDS = L.latLngBounds([-28.6, 151.6], [-25.9, 154.0]);
// preferCanvas: a thousand bus dots draw on one canvas instead of a thousand SVG elements
const map = L.map('map', { preferCanvas: true, zoomControl: false, maxBounds: SEQ_BOUNDS, maxBoundsViscosity: 0.6, minZoom: 8 })
    .setView([-27.5, 152.98], 10);
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

// Routes found for the typed place: going there (to) or calling there on the way (via)
let placeRoutes = null; // { to: Set, via: Set } or null

function placeMatch(train) {
    const q = state.place.toLowerCase();
    if ((train.headsign ?? '').toLowerCase().includes(q)) return 'to';
    if (placeRoutes?.to.has(train.routeId)) return 'to';
    if (placeRoutes?.via.has(train.routeId)) return 'via';
    return null;
}

function routeVisible(train) {
    if (state.mode && train.mode !== state.mode) return false;
    if (state.place) return placeMatch(train) !== null;
    if (!state.line) return true;
    const line = lines.find((l) => l.name === state.line);
    return !line || line.routeIds.includes(train.routeId);
}

function markerStyle(t) {
    const selected = t.tripId === state.selected;
    // Buses are smaller: there can be a thousand of them
    const bus = t.mode === 'bus';
    return {
        radius: selected ? 10 : bus ? 5 : 7,
        weight: selected ? 4 : bus ? 2 : 3,
        color: '#fffaf3', // white ring keeps every dot readable on top of the coloured tracks
        fillColor: cssVar(LEVEL_VARS[t.level] ?? '--muted'),
        fillOpacity: 1,
    };
}

// Trains glide to their new position over 1.2 s (ease-in-out) instead of jumping every 30 s
function glide(marker, to) {
    const from = marker.getLatLng();
    if (reduceMotion() || (from.lat === to[0] && from.lng === to[1])) { marker.setLatLng(to); return; }
    cancelAnimationFrame(marker.glideFrame);
    const start = performance.now();
    const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
    const step = (now) => {
        const k = ease(Math.min(1, (now - start) / 1200));
        marker.setLatLng([from.lat + (to[0] - from.lat) * k, from.lng + (to[1] - from.lng) * k]);
        if (k < 1) marker.glideFrame = requestAnimationFrame(step);
    };
    marker.glideFrame = requestAnimationFrame(step);
}

// Trains are circles (as before). Trams are rounded squares and ferries diamonds, so the
// kind of service is clear without relying on colour alone.
const MODE_NOUN = { train: ['train', 'trains'], tram: ['tram', 'trams'], ferry: ['ferry', 'ferries'], bus: ['bus', 'buses'] };
const isCircle = (mode) => mode === 'train' || mode === 'bus';
function shapeIcon(t) {
    const selected = t.tripId === state.selected;
    const size = selected ? 20 : 15;
    return L.divIcon({
        className: '',
        html: `<span class="vehicle ${t.mode}${selected ? ' selected' : ''}" style="--fill:${cssVar(LEVEL_VARS[t.level] ?? '--muted')}"></span>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
    });
}

function drawTrains() {
    const seen = new Set();
    for (const t of lastTrains) {
        if (!routeVisible(t)) continue;
        seen.add(t.id);
        const tip = `${t.headsign ? `To ${t.headsign}` : t.routeName} · ${t.delayText}`;
        const marker = trainMarkers.get(t.id);
        if (marker && marker.mode !== t.mode) { map.removeLayer(marker); trainMarkers.delete(t.id); }
        const existing = trainMarkers.get(t.id);
        if (existing) {
            glide(existing, [t.lat, t.lng]);
            if (isCircle(t.mode)) existing.setStyle(markerStyle(t));
            else existing.setIcon(shapeIcon(t));
            existing.setTooltipContent(escapeHtml(tip));
        } else {
            const m = (isCircle(t.mode)
                ? L.circleMarker([t.lat, t.lng], markerStyle(t))
                : L.marker([t.lat, t.lng], { icon: shapeIcon(t), keyboard: false })).addTo(map)
                .bindTooltip(escapeHtml(tip), { direction: 'top', offset: [0, -8] });
            m.mode = t.mode;
            m.on('click', () => selectTrain(m.trainTripId));
            trainMarkers.set(t.id, m);
        }
        trainMarkers.get(t.id).trainTripId = t.tripId;
        if (t.tripId === state.selected) {
            const sel = trainMarkers.get(t.id);
            if (sel.bringToFront) sel.bringToFront(); else sel.setZIndexOffset(1000);
        }
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
    $('train-list').removeAttribute('aria-busy');
    const list = $('train-list');
    const trains = lastTrains.filter(routeVisible)
        // Searching a place: services going there first, then ones passing through.
        // Otherwise late trains first: that's what someone checking the network wants to know
        .sort((a, b) => (state.place ? (placeMatch(a) === 'to' ? 0 : 1) - (placeMatch(b) === 'to' ? 0 : 1) : 0)
            || (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) || (b.delaySec ?? 0) - (a.delaySec ?? 0));
    const noun = (n) => (state.mode ? MODE_NOUN[state.mode][n === 1 ? 0 : 1] : n === 1 ? 'service' : 'services');
    if (trains.length === 0) {
        list.innerHTML = state.place
            ? `<li class="empty">No ${noun(0)} going to or through “${escapeHtml(state.place)}” right now.${state.mode !== 'bus' ? ' Try Buses, or' : ''} <button type="button" class="link-btn" data-clear-line>show everything</button></li>`
            : state.line
            ? `<li class="empty">No ${escapeHtml(state.line)} services are running right now. <button type="button" class="link-btn" data-clear-line>Show all lines</button></li>`
            : `<li class="empty">No ${noun(0)} are running right now. Services usually start again around 5am.</li>`;
        $('filter-note').textContent = '';
        return;
    }
    const hidden = trains.length - listLimit;
    list.innerHTML = trains.slice(0, listLimit).map((t) => `
        <li><button class="train" type="button" data-trip="${escapeHtml(t.tripId)}" aria-pressed="${t.tripId === state.selected}" style="--c:${escapeHtml(t.color)}">
          <span class="bar"></span>
          <span class="to">To ${escapeHtml(t.headsign ?? 'unknown')}</span>
          ${state.place && placeMatch(t) === 'via' ? `<span class="via">via ${escapeHtml(state.place)}</span>` : ''}
          ${statusHtml(t.level, t.delayText)}
          <span class="meta">${t.mode !== 'train' ? `${t.mode === 'tram' ? 'G:link' : t.mode === 'ferry' ? 'Ferry' : `Bus ${escapeHtml(t.routeShort ?? '')}`} · ` : ''}${t.nextStop ? `Next: ${escapeHtml(t.nextStop)}` : escapeHtml(t.routeName)}</span>
        </button></li>`).join('')
        + (hidden > 0 ? `<li><button class="more-btn" type="button" data-more>Show ${hidden} more ${noun(hidden)}</button></li>` : '');
    staggerOnce(list);
    // Say what the filter did, e.g. "Showing 6 Springfield trains"
    const going = state.place ? trains.filter((t) => placeMatch(t) === 'to').length : 0;
    $('filter-note').textContent = state.place
        ? `${going} ${noun(going)} going to ${state.place}, ${trains.length - going} passing through${state.mode !== 'bus' ? ' · buses are under Buses' : ''}`
        : state.line?.startsWith('Bus ') ? `Showing ${trains.length} ${noun(trains.length)} on route ${state.line.slice(4)}`
        : state.line ? `Showing ${trains.length} ${state.line} ${noun(trains.length)}` : '';
}
$('train-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-clear-line]')) {
        applyLine('');
        return;
    }
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
        return;
    }
    const bell = e.target.closest('[data-remind]');
    if (bell) toggleReminder(state.selected, Number(bell.dataset.remind), bell.dataset.name);
});

// ---------- "Remind me" before a stop ----------
// One reminder at a time: a train and a stop. Checked on every 30-second refresh; when the
// train is expected at the stop within 2 minutes, the page shows a banner and, if allowed,
// a system notification. Kept in localStorage so a refresh doesn't lose it.
const REMIND_BEFORE_SEC = 120;
const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5-6.71V3.5a2 2 0 1 0-4 0v.79A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"/></svg>';
let reminder = null;
try { reminder = JSON.parse(localStorage.getItem('reminder')) || null; } catch { reminder = null; }

function saveReminder() {
    try {
        if (reminder) localStorage.setItem('reminder', JSON.stringify(reminder));
        else localStorage.removeItem('reminder');
    } catch { /* private mode: the reminder just won't survive a reload */ }
}
const isReminder = (tripId, seq) => Boolean(reminder && reminder.tripId === tripId && reminder.sequence === seq);
const remindable = (s) => s.state === 'upcoming' || (s.state === 'next' && s.etaSec > REMIND_BEFORE_SEC);

async function toggleReminder(tripId, sequence, name) {
    if (isReminder(tripId, sequence)) {
        reminder = null;
        showBanner('Reminder cancelled.');
    } else {
        reminder = { tripId, sequence, name, headsign: $('journey-title').textContent };
        showBanner(`We’ll remind you about 2 minutes before ${name}. Keep this page open.`);
        if ('Notification' in window && Notification.permission === 'default') {
            try { await Notification.requestPermission(); } catch { /* the banner still works */ }
        }
    }
    saveReminder();
    await loadJourney();
    pulse(document.querySelector('.bell[aria-pressed="true"]'));
}

async function checkReminder() {
    if (!reminder) return;
    try {
        const j = await getJson(`/api/trips/${encodeURIComponent(reminder.tripId)}`);
        const stop = j.stops.find((s) => s.sequence === reminder.sequence);
        if (!stop || stop.state === 'passed' || stop.state === 'skipped') {
            reminder = null; // the train has gone past it (or won't stop): nothing left to remind
        } else if (stop.etaSec <= REMIND_BEFORE_SEC) {
            const text = `${stop.name} in about ${Math.max(1, Math.round(stop.etaSec / 60))} min. Get ready to get off.`;
            showBanner(text, true);
            if ('Notification' in window && Notification.permission === 'granted') {
                try { new Notification('Railway Live', { body: text }); } catch { /* some phones only allow this from a service worker */ }
            }
            reminder = null;
        }
        saveReminder();
    } catch (err) {
        console.error('Reminder check failed:', err);
    }
}

let bannerTimer = null;
function showBanner(text, urgent = false) {
    const el = $('banner');
    el.textContent = text;
    el.className = `banner${urgent ? ' urgent' : ''}`;
    el.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => hideWithExit(el), urgent ? 30000 : 5000);
}

async function selectTrain(tripId) {
    state.selected = tripId;
    showAllStops = false;
    const train = lastTrains.find((t) => t.tripId === tripId);
    // flyTo zooms out and back in: the view travels in an arc rather than a straight slide
    if (train) {
        if (reduceMotion()) map.setView([train.lat, train.lng], Math.max(map.getZoom(), 12));
        else map.flyTo([train.lat, train.lng], Math.max(map.getZoom(), 12), { duration: 0.6 });
    }
    drawTrains();
    renderTrainList();
    await loadJourney();
}

// The selected journey's stops drawn on the map, so a departure you tap shows where it goes
const journeyLayer = L.layerGroup().addTo(map);
let journeyFitted = null; // trip id the map was last fitted to, so 30-second refreshes don't move the map

function drawJourney(j) {
    journeyLayer.clearLayers();
    const pts = j.stops.filter((s) => s.lat !== null);
    if (pts.length < 2) return;
    const line = pts.map((s) => [s.lat, s.lng]);
    L.polyline(line, { color: '#fffaf3', weight: 8, opacity: 0.95, interactive: false }).addTo(journeyLayer);
    L.polyline(line, { color: j.color, weight: 4, opacity: 1, interactive: false }).addTo(journeyLayer);
    for (const s of pts) {
        L.circleMarker([s.lat, s.lng], {
            radius: s.state === 'next' ? 6 : 4, weight: 2, color: j.color,
            fillColor: s.state === 'passed' ? j.color : '#fffaf3', fillOpacity: 1,
        }).bindTooltip(`${escapeHtml(s.name)} · ${escapeHtml(s.expected ?? s.scheduled)}`).addTo(journeyLayer);
    }
    if (journeyFitted === j.tripId) return;
    journeyFitted = j.tripId;
    // A running vehicle: go to it. Otherwise show the whole journey.
    const live = trainMarkers.size && lastTrains.find((t) => t.tripId === j.tripId);
    if (live) map.flyTo([live.lat, live.lng], Math.max(map.getZoom(), 13), { duration: reduceMotion() ? 0 : 0.6 });
    else map.flyToBounds(line, { padding: [40, 40], maxZoom: 14, duration: reduceMotion() ? 0 : 0.8 });
}

async function loadJourney() {
    if (!state.selected) return;
    const card = $('journey');
    try {
        const j = await getJson(`/api/trips/${encodeURIComponent(state.selected)}`);
        drawJourney(j);
        const pill = $('journey-line');
        pill.textContent = j.mode === 'bus' ? `Bus ${j.routeShort} · ${j.routeName}` : j.routeName;
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
              <span class="name">${escapeHtml(s.name)}${remindable(s) ? ` <button type="button" class="bell" data-remind="${s.sequence}" data-name="${escapeHtml(s.name)}" aria-pressed="${isReminder(j.tripId, s.sequence)}" aria-label="Remind me before ${escapeHtml(s.name)}" title="Remind me 2 minutes before">${BELL}</button>` : ''}</span>
              <span class="time">${s.expected ? `<s>${escapeHtml(s.scheduled)}</s>${escapeHtml(s.expected)}` : escapeHtml(s.scheduled)}</span>
              ${s.state === 'skipped' ? '<span class="sub">Not stopping</span>' : s.platform && s.state === 'next' ? `<span class="sub">Platform ${escapeHtml(s.platform)}</span>` : ''}
            </li>`).join('');
        if (card.hidden) staggerOnce(stops); // stops settle in one after another when the card opens
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
    journeyLayer.clearLayers();
    journeyFitted = null;
    hideWithExit($('journey'), 180);
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
        // Buses come from their own (much bigger) feed, only while the Buses view is on
        const mode = state.mode;
        const [trains, summary] = await Promise.all([getJson(mode === 'bus' ? '/api/trains?mode=bus' : '/api/trains'), getJson(mode ? `/api/summary?mode=${mode}` : '/api/summary')]);
        if (mode !== state.mode) return; // switched view while this was loading
        lastTrains = trains.trains;
        drawTrains();
        renderTrainList();
        lastUpdated = new Date(trains.updatedAt).getTime();
        feedState = trains.stale ? 'stale' : 'live';
        renderSummary(summary);
        if (state.selected) loadJourney();
        checkReminder();
    } catch (err) {
        console.error('Failed to load trains:', err);
        feedState = 'down';
    }
    renderFeedStatus();
}

function renderSummary(s) {
    // "45 trains · 1 tram · 12 ferries running"; a kind with none running is left out
    const parts = Object.entries(s.byMode ?? { train: s.running })
        .filter(([, n]) => n > 0)
        .map(([mode, n]) => `<b>${n.toLocaleString('en-AU')}</b> ${MODE_NOUN[mode][n === 1 ? 0 : 1]}`);
    $('kpi-running').innerHTML = parts.join(' · ') || '<b>0</b> services';
    // On All, the on-time share is for trains, trams and ferries (bus delays come only with the Buses view)
    $('kpi-ontime-of').textContent = s.onTimeOf && s.byMode?.bus ? ` (${s.onTimeOf})` : '';
    const onTime = $('kpi-ontime');
    onTime.textContent = s.onTimePercent === null ? '–' : `${s.onTimePercent}%`;
    onTime.className = s.onTimePercent === null ? '' : s.onTimePercent >= 90 ? 'good' : s.onTimePercent >= 75 ? 'warn' : 'bad';
    $('kpi-delay').textContent = `${Math.round(s.avgLateMinutes)} min`;
    $('kpi-delay-wrap').hidden = !s.avgLateMinutes;
}

// ---------- Line filter ----------
async function loadLines() {
    lines = await getJson('/api/lines');
    // The label says where a bus, ferry or tram goes, so typing "Springfield" also finds Bus 526
    $('line-list').innerHTML = lines.map((l) => `<option value="${escapeHtml(l.name)}"${l.description ? ` label="${escapeHtml(l.description)}"` : ''}></option>`).join('');
    if (state.line && !lines.some((l) => l.name === state.line)) state.line = '';
    $('line-filter').value = state.line;
    $('line-clear').hidden = !state.line;
    if (state.place) applyPlace(state.place);
}

// A bus route's line is drawn only while you filter to it (469 bus routes would cover the map)
const busTrack = L.layerGroup().addTo(map);
async function drawBusTrack(line) {
    busTrack.clearLayers();
    if (!line || line.mode !== 'bus') return;
    try {
        for (const routeId of line.routeIds) {
            for (const s of await getJson(`/api/shapes?route=${encodeURIComponent(routeId)}`)) {
                L.polyline(s.coords, { color: '#fffaf3', weight: 6, opacity: 0.9, interactive: false }).addTo(busTrack);
                L.polyline(s.coords, { color: s.color, weight: 3, opacity: 0.9, interactive: false }).addTo(busTrack);
            }
        }
        if (busTrack.getLayers().length) map.flyToBounds(L.featureGroup(busTrack.getLayers()).getBounds(), { padding: [30, 30], duration: reduceMotion() ? 0 : 0.8 });
    } catch (err) {
        console.error('Failed to load the bus route:', err);
    }
}

function applyLine(name) {
    const text = name.trim();
    const match = lines.find((l) => l.name.toLowerCase() === text.toLowerCase());
    // Not a line name: treat it as a place ("Springfield", "Garden City")
    if (!match && text.length >= 2) { applyPlace(text); return; }
    state.place = '';
    placeRoutes = null;
    state.line = match ? match.name : '';
    $('line-filter').value = state.line;
    $('line-clear').hidden = !state.line;
    drawBusTrack(match);
    // Picking a bus line switches to the Buses view (and back to All for other lines)
    if (match && (match.mode === 'bus') !== (state.mode === 'bus')) { applyMode(match.mode === 'bus' ? 'bus' : ''); return; }
    saveUrl();
    drawTrains();
    renderTrainList();
}
async function applyPlace(text) {
    state.line = '';
    state.place = text;
    busTrack.clearLayers();
    $('line-filter').value = text;
    $('line-clear').hidden = false;
    try {
        const found = await getJson(`/api/places?q=${encodeURIComponent(text)}`);
        if (state.place !== text) return; // typed something else meanwhile
        placeRoutes = { to: new Set(found.to), via: new Set(found.via) };
    } catch (err) {
        placeRoutes = null; // still filters by destination name
        console.error('Place search failed:', err);
    }
    listLimit = LIST_STEP;
    saveUrl();
    drawTrains();
    renderTrainList();
}
$('line-filter').addEventListener('change', (e) => applyLine(e.target.value));
$('line-clear').addEventListener('click', () => applyLine(''));

// ---------- Next trains ----------
let stations = [];
async function loadStations() {
    stations = await getJson('/api/stations');
    // A bus stop from the link (?station=5341) isn't in the short list: look it up
    if (state.station && !stations.some((s) => s.id === state.station)) {
        const found = await getJson(`/api/stations?q=${encodeURIComponent(state.station)}`).catch(() => []);
        const exact = found.find((s) => s.id === state.station);
        if (exact) stations.push(exact);
    }
    if (!stations.some((s) => s.id === state.station)) state.station = DEFAULT_STATION;
    $('station-list').innerHTML = stations.map((s) => `<option value="${escapeHtml(s.name)}"></option>`).join('');
    $('station-input').value = stations.find((s) => s.id === state.station)?.name ?? '';
    if (state.tab === 'board') showStationOnMap(stations.find((s) => s.id === state.station), true);
}

// Bus stops (12,000 of them) aren't in the list up front: as you type, matching stops are fetched and added
let stationSearch = null;
$('station-input').addEventListener('input', (e) => {
    clearTimeout(stationSearch);
    const q = e.target.value.trim();
    if (q.length < 2) return;
    stationSearch = setTimeout(async () => {
        try {
            const found = await getJson(`/api/stations?q=${encodeURIComponent(q)}`);
            for (const s of found) if (!stations.some((x) => x.id === s.id)) stations.push(s);
            $('station-list').innerHTML = found.concat(stations.filter((s) => !found.includes(s)).slice(0, 300))
                .map((s) => `<option value="${escapeHtml(s.name)}"></option>`).join('');
        } catch (err) {
            console.error('Station search failed:', err);
        }
    }, 250);
});

// A pin for the station whose departures you're looking at
const stationPin = L.layerGroup().addTo(map);
function showStationOnMap(station, fly) {
    stationPin.clearLayers();
    if (!station || station.lat == null) return;
    L.circleMarker([station.lat, station.lng], { radius: 9, weight: 3, color: '#2f6b5a', fillColor: '#fffaf3', fillOpacity: 1 })
        .bindTooltip(escapeHtml(station.name), { permanent: true, direction: 'right', offset: [10, 0], className: 'station-label' })
        .addTo(stationPin);
    if (fly) map.flyTo([station.lat, station.lng], Math.max(map.getZoom(), 14), { duration: reduceMotion() ? 0 : 0.6 });
}

function pickStation(text) {
    const typed = text.trim().toLowerCase().replace(/ station$/, '');
    const match = stations.find((s) => s.name.toLowerCase() === typed)
        ?? (typed.length >= 3 ? stations.find((s) => s.name.toLowerCase().startsWith(typed)) : null);
    const error = $('station-error');
    if (!match) {
        // Say what to do, don't blame the typing
        error.textContent = `We couldn’t find a station or stop called “${text.trim()}”. Pick one from the list as you type, or type a stop number.`;
        error.hidden = false;
        return;
    }
    error.hidden = true;
    $('station-input').value = match.name;
    state.station = match.id;
    showStationOnMap(match, true);
    delete $('board').dataset.staggered; // a new station's list settles in again
    saveUrl();
    loadBoard();
}

// ---------- Plan: from A to B, with changes ----------
const planLayer = L.layerGroup().addTo(map);
let planShown = null; // the journey drawn on the map
const plan = { from: null, to: null, journeys: [] }; // from/to: { id, name } or { lat, lng, name }

// Typing in From or To searches stations and stops, like the Departures box
function stationSearchBox(inputId, listId) {
    let timer = null;
    $(inputId).addEventListener('input', (e) => {
        clearTimeout(timer);
        if (inputId === 'plan-from') $('plan-near').setAttribute('aria-pressed', 'false');
        const q = e.target.value.trim();
        if (q.length < 2) return;
        timer = setTimeout(async () => {
            try {
                const found = await getJson(`/api/stations?q=${encodeURIComponent(q)}`);
                for (const s of found) if (!stations.some((x) => x.id === s.id)) stations.push(s);
                $(listId).innerHTML = found.map((s) => `<option value="${escapeHtml(s.name)}"></option>`).join('');
            } catch (err) {
                console.error('Station search failed:', err);
            }
        }, 250);
    });
}
stationSearchBox('plan-from', 'plan-from-list');
stationSearchBox('plan-to', 'plan-to-list');

// The station or stop typed in a box. Names from the list match exactly; a short name like
// "Griffith University" matches when only one place has it. Several matches -> ask to pick.
function findStation(text) {
    const full = text.trim().toLowerCase();
    if (!full) return { match: null };
    const exact = stations.find((s) => s.name.toLowerCase() === full);
    if (exact) return { match: exact };
    const base = (name) => name.toLowerCase().replace(/ \(.*\)$/, '').replace(/ station$/, '');
    const typed = base(full);
    const same = stations.filter((s) => base(s.name) === typed);
    if (same.length === 1) return { match: same[0] };
    if (same.length > 1) return { match: null, several: same.map((s) => s.name) };
    const starts = typed.length >= 3 ? stations.filter((s) => base(s.name).startsWith(typed)) : [];
    if (starts.length === 1) return { match: starts[0] };
    return { match: null, several: starts.length > 1 ? starts.slice(0, 3).map((s) => s.name) : null };
}

$('plan-near').addEventListener('click', () => {
    const btn = $('plan-near');
    if (!navigator.geolocation) {
        planError('This browser can’t share your location. Type a station or stop instead.');
        return;
    }
    btn.textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            btn.textContent = 'Near me';
            btn.setAttribute('aria-pressed', 'true');
            plan.from = { lat: pos.coords.latitude, lng: pos.coords.longitude, name: 'Near me' };
            $('plan-from').value = 'Near me';
            $('plan-error').hidden = true;
        },
        () => {
            btn.textContent = 'Near me';
            planError('We couldn’t get your location. Allow location for this site, or type a station or stop.');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
});

$('plan-swap').addEventListener('click', () => {
    const from = $('plan-from').value;
    $('plan-from').value = $('plan-to').value;
    $('plan-to').value = from;
    [plan.from, plan.to] = [plan.to, plan.from];
    $('plan-near').setAttribute('aria-pressed', String(plan.from?.lat !== undefined));
});

function planError(text) {
    $('plan-error').textContent = text;
    $('plan-error').hidden = false;
}

function setupPlanWhen() {
    const input = $('plan-when');
    input.min = brisbaneNow();
    input.max = new Date(Date.now() + (10 + 7 * 24) * 3600 * 1000).toISOString().slice(0, 16);
    if (!input.value) input.value = brisbaneNow();
}
$('plan-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-when]');
    if (!btn) return;
    const v = btn.dataset.when;
    const nowLocal = Date.now() + 10 * 3600 * 1000;
    let target;
    if (v === 'tomorrow') target = `${new Date(nowLocal + 86400 * 1000).toISOString().slice(0, 10)}T07:00`;
    else target = new Date(nowLocal + Number(v) * 60000).toISOString().slice(0, 16);
    $('plan-when').value = target;
    if (plan.from && plan.to) findJourneys();
});

$('plan-form').addEventListener('submit', (e) => {
    e.preventDefault();
    findJourneys();
});

const placeQuery = (prefix, p) => (p.lat !== undefined
    ? `${prefix}Lat=${p.lat.toFixed(5)}&${prefix}Lng=${p.lng.toFixed(5)}`
    : `${prefix}=${encodeURIComponent(p.id)}`);

async function findJourneys() {
    $('plan-error').hidden = true;
    // Use what's typed now, unless From is "Near me"
    if (!(plan.from?.lat !== undefined && $('plan-from').value === 'Near me')) {
        const f = findStation($('plan-from').value);
        if (f.several) return planError(`More than one place matches From: ${f.several.join(', ')}. Pick one from the list.`);
        plan.from = f.match ? { id: f.match.id, name: f.match.name } : null;
    }
    const t = findStation($('plan-to').value);
    if (t.several) return planError(`More than one place matches To: ${t.several.join(', ')}. Pick one from the list.`);
    plan.to = t.match ? { id: t.match.id, name: t.match.name } : null;
    if (!plan.from) return planError('Pick where you’re leaving from: start typing and choose from the list, or press Near me.');
    if (!plan.to) return planError('Pick where you’re going: start typing and choose a station or stop from the list.');
    if (plan.from.id && plan.from.id === plan.to.id) return planError('From and To are the same place.');
    if (plan.from.id) $('plan-from').value = plan.from.name;
    $('plan-to').value = plan.to.name;

    const when = $('plan-when').value;
    const at = when && when > brisbaneNow() ? `&at=${encodeURIComponent(when)}` : '';
    const go = $('plan-go');
    const list = $('plan-results');
    go.disabled = true;
    go.textContent = 'Finding journeys…';
    list.setAttribute('aria-busy', 'true');
    try {
        const res = await getJson(`/api/plan?${placeQuery('from', plan.from)}&${placeQuery('to', plan.to)}${at}`);
        plan.journeys = res.journeys;
        $('plan-note').textContent = res.note ?? `${res.journeys.length} ${res.journeys.length === 1 ? 'journey' : 'journeys'} leaving from ${res.at}${res.planned ? ' (timetable; live delays show closer to the time)' : ', with live delays'}. Walks are estimates.`;
        renderJourneys();
        if (res.journeys.length) openPlanJourney(0);
        else planLayer.clearLayers();
    } catch (err) {
        $('plan-note').textContent = '';
        planError(err.message && !/^HTTP/.test(err.message) ? err.message : 'Journeys aren’t loading right now. Try again in a moment.');
        console.error('Plan failed:', err);
    } finally {
        go.disabled = false;
        go.textContent = 'Find journeys';
        list.removeAttribute('aria-busy');
    }
}

const CHANGE_TEXT = { make: 'Make it', tight: 'Tight change', miss: 'Likely to miss' };
const legName = (l) => (l.mode === 'train' ? l.routeName.replace(/ line$/i, '') || 'Train' : `${l.mode === 'bus' ? 'Bus' : l.mode === 'tram' ? 'Tram' : 'Ferry'} ${l.routeShort}`);
const placeName = (p, fallback) => escapeHtml((p?.name ?? fallback).replace(/ (station|ferry terminal)$/, ''));

function renderJourneys() {
    const list = $('plan-results');
    list.innerHTML = plan.journeys.map((j, i) => {
        const rides = j.legs.filter((l) => l.kind === 'ride');
        const chain = rides.map((l) => `<span class="badge" style="--c:${escapeHtml(l.color)};--t:${escapeHtml(l.textColor)}">${escapeHtml(l.mode === 'train' ? 'Train' : l.routeShort)}</span>`).join('<span class="sep" aria-hidden="true">›</span>');
        const flag = j.risky ? `<span class="trip-flag ${j.risky}">${j.risky === 'miss' ? 'A change may be missed' : 'Tight change'}</span>` : '';
        return `<li class="trip-card" data-i="${i}" aria-expanded="false">
          <button type="button" aria-label="${escapeHtml(`Leave ${j.leave}, arrive ${j.arrive}, ${j.minutes} minutes, ${j.changes} changes. Show details`)}">
            <span class="trip-head"><span class="times">${escapeHtml(j.leave)} → ${escapeHtml(j.arrive)}${j.arriveExpected ? `<small>now ${escapeHtml(j.arriveExpected)}</small>` : ''}</span>
              <span class="meta">${j.minutes} min · ${j.changes === 0 ? 'direct' : `${j.changes} change${j.changes > 1 ? 's' : ''}`}</span></span>
            <span class="trip-chain">${chain}</span>${flag}
          </button>
          <ol class="legs" hidden></ol>
        </li>`;
    }).join('');
}

function legsHtml(j) {
    return j.legs.map((l) => {
        if (l.kind === 'walk') {
            return `<li class="leg walk"><span class="t"></span><span class="d">Walk about ${l.minutes} min${l.to ? ` to ${placeName(l.to)}` : ' to where you’re going'}</span></li>`;
        }
        const change = l.change ? `<span class="change ${l.change}">${CHANGE_TEXT[l.change]}</span>` : '';
        return `<li class="leg" style="--c:${escapeHtml(l.color)}">
          <span class="t">${escapeHtml(l.depart)}${l.departExpected ? `<small>now ${escapeHtml(l.departExpected)}</small>` : ''}</span>
          <span class="d">${change}<b>${escapeHtml(legName(l))} to ${escapeHtml(l.headsign)}</b>
            <span>From ${placeName(l.from)}${l.from?.platform ? `, platform ${escapeHtml(l.from.platform)}` : ''} · ${statusHtml(l.status, l.statusText)}</span>
            <span>${l.stops} stop${l.stops === 1 ? '' : 's'} · get off at ${placeName(l.to)}, ${escapeHtml(l.arriveExpected ?? l.arrive)}</span></span>
        </li>`;
    }).join('');
}

function openPlanJourney(i) {
    for (const card of $('plan-results').children) {
        const open = Number(card.dataset.i) === i;
        card.setAttribute('aria-expanded', String(open));
        const legs = card.querySelector('.legs');
        legs.hidden = !open;
        if (open) legs.innerHTML = legsHtml(plan.journeys[i]);
    }
    drawPlan(plan.journeys[i]);
}

$('plan-results').addEventListener('click', (e) => {
    const card = e.target.closest('.trip-card');
    if (!card || !e.target.closest('button')) return;
    openPlanJourney(Number(card.dataset.i));
});

// Each ride's real stops come from the trip; walks are straight dotted lines
async function drawPlan(j) {
    planShown = j;
    planLayer.clearLayers();
    journeyLayer.clearLayers();
    const all = [];
    const rides = await Promise.all(j.legs.map(async (l) => {
        if (l.kind !== 'ride') return null;
        try {
            const trip = await getJson(`/api/trips/${encodeURIComponent(l.tripId)}`);
            return trip.stops.filter((s) => s.sequence >= l.fromSeq && s.sequence <= l.toSeq && s.lat !== null);
        } catch {
            return [l.from, l.to].filter((s) => s?.lat != null);
        }
    }));
    if (planShown !== j) return; // another journey was picked meanwhile
    j.legs.forEach((l, i) => {
        if (l.kind === 'walk') {
            const a = l.from ?? (i > 0 ? j.legs[i - 1].to : null) ?? (plan.from?.lat !== undefined ? plan.from : null);
            const b = l.to ?? (plan.to ? stations.find((s) => s.id === plan.to.id) : null);
            if (a?.lat != null && b?.lat != null) {
                L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: '#6e7a72', weight: 3, dashArray: '2 6', interactive: false }).addTo(planLayer);
                all.push([a.lat, a.lng], [b.lat, b.lng]);
            }
            return;
        }
        const pts = rides[i].map((s) => [s.lat, s.lng]);
        if (pts.length < 2) return;
        L.polyline(pts, { color: '#fffaf3', weight: 8, opacity: 0.95, interactive: false }).addTo(planLayer);
        L.polyline(pts, { color: l.color, weight: 4, interactive: false }).addTo(planLayer);
        for (const [k, s] of rides[i].entries()) {
            const end = k === 0 || k === rides[i].length - 1;
            L.circleMarker([s.lat, s.lng], { radius: end ? 6 : 3, weight: 2, color: l.color, fillColor: '#fffaf3', fillOpacity: 1 })
                .bindTooltip(escapeHtml(s.name)).addTo(planLayer);
        }
        all.push(...pts);
    });
    if (plan.from?.lat !== undefined) {
        L.circleMarker([plan.from.lat, plan.from.lng], { radius: 7, weight: 3, color: '#2f6b5a', fillColor: '#2f6b5a', fillOpacity: 1 })
            .bindTooltip('You', { permanent: true, direction: 'right', offset: [8, 0], className: 'station-label' }).addTo(planLayer);
    }
    if (all.length) map.flyToBounds(all, { padding: [40, 40], maxZoom: 15, duration: reduceMotion() ? 0 : 0.8 });
}

// ---------- When: now, or a time up to 7 days ahead ----------
// Brisbane has no daylight saving, so its time is always UTC+10
function brisbaneNow() {
    return new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 16);
}
function setupWhen() {
    const input = $('when-input');
    const now = brisbaneNow();
    input.min = now;
    input.max = new Date(Date.now() + (10 + 7 * 24) * 3600 * 1000).toISOString().slice(0, 16);
    input.value = state.at || now;
}
function setWhen(value) {
    state.at = value && value > brisbaneNow() ? value : '';
    $('when-now').hidden = !state.at;
    if (!state.at) $('when-input').value = brisbaneNow();
    saveUrl();
    loadBoard();
}
function describeWhen(at) {
    const d = new Date(`${at}:00Z`);
    const day = d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).toLowerCase();
    return `Timetable for ${day}, from ${time}. Live delays show up closer to the time.`;
}

async function loadBoard() {
    const board = $('board');
    const at = state.at;
    $('when-note').textContent = at ? describeWhen(at) : '';
    try {
        const query = `station=${encodeURIComponent(state.station)}${at ? `&at=${encodeURIComponent(at)}` : ''}`;
        const { departures } = await getJson(`/api/departures?${query}`);
        if (at !== state.at) return; // the time changed while this was loading
        board.removeAttribute('aria-busy');
        if (departures.length === 0) {
            board.innerHTML = at
                ? '<li class="empty">No trains from here in the 3 hours after that time. Try an earlier time or another station.</li>'
                : '<li class="empty">No trains from here in the next 2 hours. Services may have finished for the night; try another station or plan ahead above.</li>';
            return;
        }
        board.innerHTML = departures.map((d) => `
            <li class="${d.status === 'cancelled' ? 'cancelled' : ''}${d.tripId === state.selected ? ' selected' : ''}" data-trip="${escapeHtml(d.tripId)}" tabindex="0" role="button" aria-label="${escapeHtml(`${d.scheduled} ${d.routeShort ?? ''} to ${d.headsign}: show stops`)}">
              <span class="time">${d.expected ? `<small>${escapeHtml(d.scheduled)}</small>${escapeHtml(d.expected)}` : escapeHtml(d.scheduled)}</span>
              <span class="dest"><span class="to" style="--c:${escapeHtml(d.color)}" title="${escapeHtml(d.routeName)}">${d.mode && d.mode !== 'train' ? `<b class="route-no">${escapeHtml(d.routeShort)}</b> ` : ''}${escapeHtml(d.headsign)}</span>
                ${d.location ? `<span class="where">${escapeHtml(d.location)}${d.minutesAway > 0 ? ` · ${d.minutesAway} min` : ''}</span>` : ''}</span>
              <span class="right">${statusHtml(d.status, d.statusText)}${d.platform ? `<span class="plat">Platform ${escapeHtml(d.platform)}</span>` : ''}</span>
            </li>`).join('');
        staggerOnce(board);
    } catch (err) {
        board.innerHTML = `<li class="empty">Departures aren’t loading right now. We’ll try again in 30 seconds.</li>`;
        console.error('Failed to load departures:', err);
    }
}
// Tap a departure (or its route number) to see every stop, on the card and on the map
function openDeparture(e) {
    const row = e.target.closest('li[data-trip]');
    if (!row || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    for (const li of $('board').querySelectorAll('li.selected')) li.classList.remove('selected');
    row.classList.add('selected');
    selectTrain(row.dataset.trip);
}
$('board').addEventListener('click', openDeparture);
$('board').addEventListener('keydown', openDeparture);

// Quick times: Now, +30 min, +1 hr, +3 hr, tomorrow 7 am (Brisbane time)
$('when-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-when]');
    if (!btn) return;
    const v = btn.dataset.when;
    if (v === '0') { setWhen(''); return; }
    let target;
    if (v === 'tomorrow') {
        const d = new Date(Date.now() + 10 * 3600 * 1000 + 86400 * 1000);
        target = `${d.toISOString().slice(0, 10)}T07:00`;
    } else {
        const base = state.at ? new Date(`${state.at}:00Z`).getTime() : Date.now() + 10 * 3600 * 1000;
        target = new Date(base + Number(v) * 60000).toISOString().slice(0, 16);
    }
    $('when-input').value = target;
    setWhen(target);
});

$('when-input').addEventListener('change', (e) => setWhen(e.target.value));
$('when-now').addEventListener('click', () => setWhen(''));
setupWhen();
$('when-now').hidden = !state.at;
$('station-input').addEventListener('change', (e) => pickStation(e.target.value));
$('station-input').addEventListener('focus', (e) => e.target.select());

// ---------- Alerts ----------
// "Read more" opens the full text; a line tag jumps to that line's trains
$('alerts').addEventListener('click', (e) => {
    const more = e.target.closest('.read-more');
    if (more) {
        const open = more.getAttribute('aria-expanded') !== 'true';
        more.setAttribute('aria-expanded', String(open));
        more.textContent = open ? 'Show less' : 'Read more';
        more.closest('li').classList.toggle('open', open);
        return;
    }
    const tag = e.target.closest('[data-line]');
    if (tag) {
        applyLine(tag.dataset.line);
        showTab('trains');
    }
});
async function loadAlerts() {
    const list = $('alerts');
    try {
        const { alerts } = await getJson('/api/alerts');
        list.removeAttribute('aria-busy');
        $('alerts-count').textContent = alerts.length || '';
        if (alerts.length === 0) {
            list.innerHTML = '<li class="empty">No rail alerts right now. Trains are running normally.</li>';
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
              ${a.description.length > 110 ? '<button type="button" class="link-btn read-more" aria-expanded="false">Read more</button>' : ''}
              ${shown.length ? `<div class="alert-lines">${shown.map((l) => `<button type="button" data-line="${escapeHtml(l.name)}" title="Show ${escapeHtml(l.name)} trains" style="--c:${escapeHtml(l.color)};--tc:${textOn(l.color)}">${escapeHtml(l.name)}</button>`).join('')}${more > 0 ? `<span style="--c:var(--sand-2);--tc:var(--muted)">+${more} more</span>` : ''}</div>` : ''}
            </li>`;
        }).join('');
        staggerOnce(list);
    } catch (err) {
        list.innerHTML = '<li class="empty">Alerts aren’t loading right now. We’ll try again in a few minutes.</li>';
        console.error('Failed to load alerts:', err);
    }
}

// ---------- Start ----------
async function start() {
    showTab(state.tab);
    setupPlanWhen();
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

// ---------- Stats: how often trains ran on time ----------
// Loaded when the tab opens; the numbers only change every 10 minutes.
const shortDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
const pctClass = (p) => (p >= 80 ? 'good' : p >= 60 ? 'warn' : 'bad');

// A row of simple bars: label, bar, number. No chart library needed for this.
function bars(rows, label) {
    return `<ul class="bars">${rows.map((r) => `
        <li><span class="bar-label">${escapeHtml(label(r))}</span>
          <span class="bar"><i class="${pctClass(r.onTimePercent)}" style="width:${r.onTimePercent}%"></i></span>
          <b>${r.onTimePercent}%</b></li>`).join('')}</ul>`;
}

async function loadStats() {
    const box = $('stats');
    const days = statsDays;
    try {
        const s = await getJson(`/api/stats?days=${days}`);
        if (days !== statsDays) return; // another period was picked while this loaded
        box.removeAttribute('aria-busy');
        if (s.trips === 0) {
            box.innerHTML = `<p class="empty">${s.since
                ? 'No trips recorded in this period yet. Try a longer one.'
                : 'We’ve only just started recording. Numbers show up after the first trains finish, and they get more useful every day.'}</p>`;
            return;
        }
        const total = s.byDay.reduce((n, d) => n + d.trips, 0);
        const onTime = Math.round(s.byDay.reduce((n, d) => n + d.trips * d.onTimePercent, 0) / total);
        box.innerHTML = `
          <p class="summary"><b class="${pctClass(onTime)}">${onTime}%</b> of ${total.toLocaleString('en-AU')} trips ran on time (less than a minute late).
            Recorded since ${escapeHtml(shortDate(s.since))}.</p>

          <h3 class="stats-h">By line</h3>
          <ul class="bars">${s.lines.map((l) => `
            <li><span class="bar-label"><i class="line-dot" style="--c:${escapeHtml(l.color)}"></i>${escapeHtml(l.name)}</span>
              <span class="bar"><i class="${pctClass(l.onTimePercent)}" style="width:${l.onTimePercent}%"></i></span>
              <b>${l.onTimePercent}%</b></li>`).join('')}</ul>
          <p class="hint">Late ones on ${escapeHtml(s.lines.slice(-1)[0].name)}, the least reliable line, were about ${s.lines.slice(-1)[0].avgLateMinutes} min late</p>

          <h3 class="stats-h">By time of day</h3>
          <p class="hint">When the trip was due to start</p>
          ${bars(s.byHour, (h) => hourLabel(h.hour))}

          ${s.byDay.length > 1 ? `<h3 class="stats-h">Day by day</h3>${bars(s.byDay, (d) => shortDate(d.date))}` : ''}

          <h3 class="stats-h">Often late</h3>
          ${s.worst.length ? `<ol class="worst">${s.worst.map((w) => `
            <li><span class="to" style="--c:${escapeHtml(w.color)}">${escapeHtml(w.time)} ${escapeHtml(w.origin)} to ${escapeHtml(w.headsign)}</span>
              <span class="quiet">about ${w.avgLateMinutes} min late · ${w.runs} runs</span></li>`).join('')}</ol>`
            : '<p class="empty">Each departure needs at least 2 recorded runs before it shows here. Check back in a day or two.</p>'}`;
    } catch (err) {
        box.innerHTML = '<p class="empty">The numbers aren’t loading right now. Try again in a minute.</p>';
        console.error('Failed to load stats:', err);
    }
}
$('stats-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-days]');
    if (!btn) return;
    statsDays = Number(btn.dataset.days);
    for (const b of document.querySelectorAll('#stats-seg button')) b.setAttribute('aria-pressed', String(b === btn));
    loadStats();
});

// ---------- Kind of service: All / Trains / Tram / Ferries ----------
function applyMode(mode) {
    const busChanged = (mode === 'bus') !== (state.mode === 'bus');
    state.mode = mode;
    for (const b of document.querySelectorAll('#mode-seg button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    // A line from another kind of service would hide everything, so drop it
    const line = lines.find((l) => l.name === state.line);
    // e.g. the Springfield train line, then Buses: keep looking for Springfield, as a place
    if (mode && line && line.mode !== mode) { state.line = ''; applyPlace(line.name); }
    if (mode !== 'bus') busTrack.clearLayers();
    listLimit = LIST_STEP;
    saveUrl();
    if (busChanged) {
        // Buses are a different feed: show the list loading, then fetch
        lastTrains = [];
        drawTrains();
        $('train-list').innerHTML = '<li class="skeleton-row"></li><li class="skeleton-row"></li><li class="skeleton-row"></li>';
        loadLive();
        return;
    }
    drawTrains();
    renderTrainList();
    // The numbers at the top follow the view: "44 trains running", "10 trams running"…
    getJson(mode ? `/api/summary?mode=${mode}` : '/api/summary').then((s) => { if (state.mode === mode) renderSummary(s); }).catch(() => {});
    // The G:link is on the Gold Coast, far from Brisbane: zoom the map to what is now showing
    const shown = lastTrains.filter(routeVisible).map((t) => [t.lat, t.lng]);
    if (mode && shown.length) map.flyToBounds(shown, { padding: [40, 40], maxZoom: 13, duration: reduceMotion() ? 0 : 0.8 });
}
document.querySelector('#mode-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (btn) applyMode(btn.dataset.mode);
});
for (const b of document.querySelectorAll('#mode-seg button')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
