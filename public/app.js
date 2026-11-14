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
let statsDays = 1; // period on the Stats tab: today first
// "1 min", "4 mins"
const mins = (n) => `${n} min${n === 1 ? '' : 's'}`;
// Journey length: "45 mins", "1 hr", "1 hr 40 mins", "2 hrs 5 mins"
function duration(total) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return mins(m);
    const hours = `${h} hr${h === 1 ? '' : 's'}`;
    return m === 0 ? hours : `${hours} ${mins(m)}`;
}
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
    // Another tab: the trip that was open belongs to the tab you left
    if (name !== state.tab && state.selected) closeJourney();
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
    if (name !== 'plan') { planLayer.clearLayers(); setPlanFocus(false); }
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
// The map credits stay on the map (OpenStreetMap asks for that); the page footer only links the code.
// A plain "Leaflet" link instead of the flag keeps the line short enough for one line on a phone.
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

// Full screen map: a button under the zoom. iPhone Safari has no full screen for a part of a page,
// so the map box is pinned over the whole screen instead, and Esc or the button closes it.
const FullMap = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const btn = L.DomUtil.create('button', 'full-btn');
        btn.type = 'button';
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', 'Full screen map');
        btn.innerHTML = '<span aria-hidden="true">⤢</span>';
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', () => setFullMap(btn.getAttribute('aria-pressed') !== 'true'));
        return btn;
    },
});
const fullBtn = new FullMap().addTo(map).getContainer();
function setFullMap(on) {
    document.body.classList.toggle('map-full', on);
    fullBtn.setAttribute('aria-pressed', String(on));
    fullBtn.setAttribute('aria-label', on ? 'Close full screen map' : 'Full screen map');
    fullBtn.innerHTML = `<span aria-hidden="true">${on ? '×' : '⤢'}</span>`;
    // Leaflet has to measure the new size, after the browser has applied it
    requestAnimationFrame(() => map.invalidateSize());
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('map-full')) setFullMap(false);
});
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        + ' · <a href="https://translink.com.au/about-translink/open-data">TransLink</a> CC BY 4.0',
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
    // The open vehicle is drawn above its journey line instead (drawVehicleDot)
    if (selected) return { radius: 7, weight: 0, opacity: 0, fillOpacity: 0 };
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
// ms / linear: the open vehicle moves steadily over most of the 30 seconds until the next position
// (so it, and the map following it, keep moving instead of jumping every 30 seconds)
function glide(marker, to, onFrame, { ms = 1200, linear = false } = {}) {
    const from = marker.getLatLng();
    if (reduceMotion() || (from.lat === to[0] && from.lng === to[1])) { marker.setLatLng(to); onFrame?.(marker.getLatLng()); return; }
    cancelAnimationFrame(marker.glideFrame);
    const start = performance.now();
    const ease = linear ? (x) => x : (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
    const step = (now) => {
        const k = ease(Math.min(1, (now - start) / ms));
        marker.setLatLng([from.lat + (to[0] - from.lat) * k, from.lng + (to[1] - from.lng) * k]);
        onFrame?.(marker.getLatLng());
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
    let selectedSeen = false;
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
            else { existing.setIcon(shapeIcon(t)); existing.setOpacity(t.tripId === state.selected ? 0 : 1); }
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
            selectedSeen = true;
            drawVehicleDot(t);
        }
    }
    if (!selectedSeen) removeVehicleDot();
    showFollowBtn(selectedSeen);
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
            const text = `${stop.name} in about ${mins(Math.max(1, Math.round(stop.etaSec / 60)))}. Get ready to get off.`;
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

// How many pixels at the bottom of the map are covered (the trip sheet on a phone in full screen),
// so the vehicle is never centred behind it
function hiddenBottom() {
    const sheet = $('journey');
    if (sheet.hidden || window.innerWidth >= 1000) return 0;
    const m = map.getContainer().getBoundingClientRect();
    return Math.max(0, m.bottom - sheet.getBoundingClientRect().top);
}
// Go to a point, keeping it in the part of the map you can see
let mapFlying = false;
map.on('moveend', () => { mapFlying = false; });
function focusMap(latlng, zoom) {
    mapFlying = !reduceMotion();
    const z = Math.max(map.getZoom(), zoom);
    const shift = hiddenBottom() / 2;
    const target = shift ? map.unproject(map.project(latlng, z).add([0, shift]), z) : latlng;
    // flyTo zooms out and back in: the view travels in an arc rather than a straight slide
    if (reduceMotion()) map.setView(target, z);
    else map.flyTo(target, z, { duration: 0.6 });
}
function focusBounds(points, maxZoom) {
    mapFlying = !reduceMotion();
    const pad = hiddenBottom();
    map.flyToBounds(points, { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40 + pad], maxZoom, duration: reduceMotion() ? 0 : 0.8 });
}

// The map follows the vehicle you opened: it stays in the middle of what you can see (above the
// sheet on a phone) and the map slides along with it, frame by frame, as it glides to each new position.
// The "Following" button on the map turns that off and on; dragging the map yourself turns it off.
let followVehicle = false;
const FollowBtn = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
        const btn = L.DomUtil.create('button', 'follow-map-btn');
        btn.type = 'button';
        btn.hidden = true;
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', () => {
            setFollowVehicle(!followVehicle);
            if (followVehicle && vehicleDot) focusMap(vehicleDot.getLatLng(), map.getZoom());
        });
        return btn;
    },
});
const followBtn = new FollowBtn().addTo(map).getContainer();
function setFollowVehicle(on) {
    followVehicle = on;
    followBtn.setAttribute('aria-pressed', String(on));
    followBtn.innerHTML = `<span aria-hidden="true">◎</span> ${on ? 'Following' : 'Follow'}`;
    followBtn.setAttribute('aria-label', on ? 'Stop following this vehicle' : 'Follow this vehicle on the map');
}
// Shown only while the open trip's vehicle is on the map
function showFollowBtn(on) { followBtn.hidden = !on; }
map.on('dragstart', () => { if (followVehicle) setFollowVehicle(false); });
function keepInView(latlng) {
    if (!followVehicle || mapFlying) return; // not while the map is still flying to the vehicle
    const shift = hiddenBottom() / 2;
    const z = map.getZoom();
    const target = shift ? map.unproject(map.project(latlng, z).add([0, shift]), z) : latlng;
    map.setView(target, z, { animate: false });
}

async function selectTrain(tripId) {
    if (tripId !== state.selected) { removeVehicleDot(); journeyPath = null; }
    state.selected = tripId;
    setFollowVehicle(true);
    showAllStops = false;
    setSheet(false); // a phone starts with the short sheet, so the map is clear
    // On a phone the map is at the top of the page: bring it into view
    if (window.innerWidth < 1000 && !document.body.classList.contains('map-full')) window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
    // The map moves once the trip is loaded (drawJourney), when the sheet's size is known
    drawTrains();
    renderTrainList();
    await loadJourney();
}

// The selected journey drawn on top of everything else in its own layer, so it can't be mixed up with
// another line of the same colour: a dark outline, a white gap, then the line's colour, and the rest of
// the map fades back. The vehicle itself sits on top of its line (its own layer, above the journey),
// snapped onto the track when the GPS point is a little off it.
map.createPane('journey').style.zIndex = 450;
map.createPane('vehicle').style.zIndex = 460;
const journeyRenderer = L.svg({ pane: 'journey' });
const vehicleRenderer = L.svg({ pane: 'vehicle' });
const journeyLayer = L.layerGroup().addTo(map);
let journeyFitted = null; // trip id the map was last fitted to, so 30-second refreshes don't move the map
let journeyPath = null; // [[lat, lng]...] of the open trip, for snapping its vehicle onto the track
let vehicleDot = null;

function drawJourney(j) {
    journeyLayer.clearLayers();
    const pts = j.stops.filter((s) => s.lat !== null);
    if (pts.length < 2) return;
    let line = j.path && j.path.length > 1 ? j.path : pts.map((s) => [s.lat, s.lng]);
    // A track can be stored either way round: make it start at the first stop
    const d2 = (p, s) => (p[0] - s.lat) ** 2 + (p[1] - s.lng) ** 2;
    if (d2(line[line.length - 1], pts[0]) < d2(line[0], pts[0])) line = [...line].reverse();
    journeyPath = line;
    // Where the vehicle is now splits the line: the part already travelled is quiet, the part ahead is bold
    const live = lastTrains.find((t) => t.tripId === j.tripId);
    const cut = live ? nearestIndex(line, onTrack([live.lat, live.lng])) : 0;
    const style = { pane: 'journey', renderer: journeyRenderer, interactive: false, lineCap: 'round', lineJoin: 'round' };
    const done = line.slice(0, cut + 1);
    const ahead = line.slice(cut);
    if (done.length > 1) L.polyline(done, { ...style, color: j.color, weight: 4, opacity: 0.45 }).addTo(journeyLayer);
    if (ahead.length > 1) {
        L.polyline(ahead, { ...style, color: '#fff', weight: 10, opacity: 1, className: 'journey-halo' }).addTo(journeyLayer);
        L.polyline(ahead, { ...style, color: j.color, weight: 6, opacity: 1 }).addTo(journeyLayer);
    }
    for (const s of pts) {
        const passed = s.state === 'passed';
        // A station's position is the middle of the station, which can be off the track: put the dot on it
        L.circleMarker(onTrack([s.lat, s.lng], line, 400), {
            pane: 'journey', renderer: journeyRenderer,
            radius: s.state === 'next' ? 5 : 3.5, weight: 2, color: j.color, opacity: passed ? 0.5 : 1,
            fillColor: '#fff', fillOpacity: passed ? 0.6 : 1,
        }).bindTooltip(`${escapeHtml(s.name)} · ${escapeHtml(s.expected ?? s.scheduled)}`).addTo(journeyLayer);
    }
    map.getContainer().classList.add('has-journey');
    drawTrains();
    if (journeyFitted === j.tripId) return;
    journeyFitted = j.tripId;
    // A running vehicle: go to it. Otherwise show the whole journey.
    if (live) focusMap(onTrack([live.lat, live.lng]), 13);
    else focusBounds(line, 14);
}

// Index of the track point closest to a position (for splitting the line where the vehicle is)
function nearestIndex(line, at) {
    let best = 0;
    let bestD = Infinity;
    line.forEach((p, i) => {
        const d = (p[0] - at[0]) ** 2 + (p[1] - at[1]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
    });
    return best;
}

// The closest point on the open trip's track, if the vehicle is within 150 m of it (GPS drifts;
// a vehicle further away than that is shown where it says it is)
function onTrack(latlng, path = journeyPath, maxM = 150) {
    if (!path) return latlng;
    const z = map.getZoom();
    const p = map.project(latlng, z);
    let best = null;
    for (let i = 1; i < path.length; i += 1) {
        const a = map.project(path[i - 1], z);
        const b = map.project(path[i], z);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = dx * dx + dy * dy;
        const k = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
        const q = L.point(a.x + k * dx, a.y + k * dy);
        const d = q.distanceTo(p);
        if (!best || d < best.d) best = { d, q };
    }
    if (!best) return latlng;
    const snapped = map.unproject(best.q, z);
    return map.distance(snapped, latlng) <= maxM ? [snapped.lat, snapped.lng] : latlng;
}

// The open vehicle, drawn above its journey line
function drawVehicleDot(t) {
    const style = { pane: 'vehicle', renderer: vehicleRenderer, radius: 8, weight: 3, color: '#fff', fillColor: cssVar(LEVEL_VARS[t.level] ?? '--muted'), fillOpacity: 1, interactive: false, className: 'vehicle-dot' };
    const at = onTrack([t.lat, t.lng]);
    if (!vehicleDot) {
        vehicleDot = L.circleMarker(at, style).addTo(map);
        vehicleDot.halo = L.circleMarker(at, { ...style, radius: 16, weight: 0, fillOpacity: 0.22, className: 'vehicle-pulse' }).addTo(map);
        vehicleDot.halo.bringToBack();
    } else {
        vehicleDot.setStyle(style);
        // A big jump (first update, or the vehicle moved a lot) goes quickly; normal moves take 25 s
        const far = map.distance(vehicleDot.getLatLng(), at) > 3000;
        glide(vehicleDot, at, (ll) => { vehicleDot?.halo.setLatLng(ll); keepInView(ll); }, far ? {} : { ms: 25000, linear: true });
    }
}
function removeVehicleDot() {
    if (!vehicleDot) return;
    cancelAnimationFrame(vehicleDot.glideFrame);
    map.removeLayer(vehicleDot.halo);
    map.removeLayer(vehicleDot);
    vehicleDot = null;
}

// ---------- Will I make my bus? (train + bus, docs/connections.md) ----------
// On any train: pick a station ahead where you'll get off, and see every bus leaving nearby after
// the train gets there, each marked Make it / Tight / Miss for the walk to its own stop.
// Tap a bus for its stops and live delay; "Follow this bus" keeps it at the top and re-checks it
// every 30 seconds (with the trip). From GET /api/connection/places and /api/connection.
const STATUS = { make: 'Make it', tight: 'Tight', miss: 'Miss' };
const connect = { trip: null, places: [], at: '', to: null, q: '', data: null, open: null, more: false, follow: null, allStops: false };
const FOLLOW_KEY = 'rl-follow-bus';
try { connect.follow = JSON.parse(localStorage.getItem(FOLLOW_KEY) || 'null'); } catch { connect.follow = null; }
const saveFollow = () => { try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(connect.follow)); } catch { /* private mode */ } };

async function updateConnect(j) {
    const box = $('connect');
    if (j.mode !== 'train') { box.hidden = true; return; }
    if (j.tripId !== connect.trip) {
        connect.trip = j.tripId;
        connect.places = [];
        connect.data = null;
        connect.open = null;
        connect.more = false;
        $('connect-out').innerHTML = '';
        $('connect-list').innerHTML = '';
        $('connect-more').hidden = true;
        try { connect.places = (await getJson(`/api/connection/places?trip=${encodeURIComponent(j.tripId)}`)).places; } catch { connect.places = []; }
        if (j.tripId !== connect.trip) return;
        // Following a bus for this train: open where you were. Otherwise you pick the station.
        connect.at = connect.follow?.train === j.tripId ? connect.follow.at : '';
    }
    // Only stations still ahead of the train
    const ahead = new Set(j.stops.filter((s) => s.state !== 'passed').map((s) => s.sequence));
    const places = connect.places.filter((p) => ahead.has(p.sequence));
    box.hidden = places.length === 0;
    if (box.hidden) return;
    const sel = $('connect-at');
    const opts = '<option value="">Pick a station…</option>' + places.map((p) => `<option value="${escapeHtml(p.station)}">${escapeHtml(p.name)}</option>`).join('');
    if (sel.dataset.trip !== j.tripId || sel.options.length !== places.length + 1) { sel.innerHTML = opts; sel.dataset.trip = j.tripId; }
    if (!places.some((p) => p.station === connect.at)) connect.at = '';
    sel.value = connect.at;
    $('connect-tools').hidden = !connect.at;
    if (connect.at) loadConnect();
}

async function loadConnect() {
    const tripId = connect.trip;
    const at = connect.at;
    try {
        const to = connect.to;
        const c = await getJson(`/api/connection?trip=${encodeURIComponent(tripId)}&at=${encodeURIComponent(at)}${to ? `&to=${encodeURIComponent(to.id)}` : ''}`);
        if (tripId !== connect.trip || at !== connect.at || to !== connect.to) return;
        connect.data = c;
        renderConnect();
    } catch (err) {
        $('connect-list').innerHTML = '';
        $('connect-more').hidden = true;
        $('connect-out').innerHTML = `<p class="field-error">${escapeHtml(err.message && !/^HTTP/.test(err.message) ? err.message : 'Can’t check the buses right now.')}</p>`;
    }
}

const minsText = (n) => `${n} min${n === 1 ? '' : 's'}`;
function busRow(b) {
    const late = b.delaySecs >= 60 ? Math.round(b.delaySecs / 60) : 0;
    const spare = b.status === 'miss' ? 'leaves before you get there' : b.spareMins < 1 ? 'just in time' : `${minsText(b.spareMins)} to spare`;
    const stand = `${escapeHtml(b.stop)}${b.platform ? `, platform ${escapeHtml(b.platform)}` : ''}`;
    return `<button type="button" class="bus-row" data-bus="${escapeHtml(b.tripId)}" aria-expanded="${connect.open === b.tripId}">
        <span class="when">${escapeHtml(b.leaves)}${late ? `<s>${escapeHtml(b.scheduled)}</s>` : ''}</span>
        <span class="what"><span class="route" style="background:${escapeHtml(b.color)};color:${escapeHtml(b.textColor)}">${escapeHtml(b.route)}</span><span>${escapeHtml(b.headsign)}</span></span>
        <span class="badge ${escapeHtml(b.status)}">${STATUS[b.status]}</span>
        <span class="where">${stand} · ${b.walkOnStreets ? '' : '~'}${minsText(b.walkMins)} walk · ${spare}${b.arrives ? ` · gets to ${escapeHtml(connect.data?.to ?? '')} ${escapeHtml(b.arrives)}` : ''}</span>
    </button>`;
}

function renderConnect() {
    const c = connect.data;
    if (!c) return;
    const trainLate = c.train.delaySecs !== null && c.train.delaySecs >= 60;
    const q = connect.q.trim().toLowerCase();
    let list = c.buses;
    if (q) list = list.filter((b) => b.route.toLowerCase() === q || b.route.toLowerCase().startsWith(q));
    // The bus you follow stays on top, even when a filter would hide it
    const followed = connect.follow?.train === connect.trip && connect.follow.at === connect.at
        ? c.buses.find((b) => b.tripId === connect.follow.bus) : null;
    if (followed) list = [followed, ...list.filter((b) => b !== followed)];
    const limit = connect.more ? list.length : 8;
    $('connect-out').innerHTML = `<p class="follow-note">Train at ${escapeHtml(c.station)} ${escapeHtml(c.train.arrives)}${trainLate ? ` (${Math.round(c.train.delaySecs / 60)} min late)` : ''}${c.train.platform ? `, platform ${escapeHtml(c.train.platform)}` : ''}. ${c.busLive ? 'Live bus delays where TransLink has them.' : 'Bus times are the timetable right now.'}</p>`
        + (connect.follow?.train === connect.trip && connect.follow.at === connect.at && !followed ? '<p class="field-error">The bus you followed has left or isn’t running.</p>' : '')
        + (followed?.status === 'miss' ? `<p class="field-error">The bus you follow now leaves before you get there.${(() => { const n = c.buses.find((b) => b.status !== 'miss' && b.route === followed.route); return n ? ` Next ${escapeHtml(n.route)}: ${escapeHtml(n.leaves)}.` : ''; })()}</p>` : '')
        + (list.length === 0 ? `<p class="muted">${c.to && !q ? `No bus from here goes to ${escapeHtml(c.to)} in the next 40 minutes. Try Plan this trip for routes with a change.` : 'No buses match.'}</p>` : '');
    $('connect-list').innerHTML = list.slice(0, limit).map((b) => `<li class="${b === followed ? 'followed' : ''}">${busRow(b)}${connect.open === b.tripId ? '<div class="bus-detail" data-detail><p class="muted">Loading stops…</p></div>' : ''}</li>`).join('');
    $('connect-more').hidden = list.length <= limit;
    if (connect.open && list.slice(0, limit).some((b) => b.tripId === connect.open)) loadBusDetail(c.buses.find((b) => b.tripId === connect.open));
}

// The bus's stops from where you get on: a line with a dot per stop, times lined up on the right.
// Long trips show the first 6 and the last; "Show all stops" opens the rest.
function stopList(stops, b) {
    const toName = connect.data?.to;
    const dest = (s) => b.offSequence !== null && s.sequence === b.offSequence;
    const row = (s, i) => `<li class="${i === 0 ? 'geton' : ''}${dest(s) ? ' dest' : ''}"><span class="n">${escapeHtml(s.name)}${i === 0 ? ' <em>get on</em>' : dest(s) && toName ? ' <em>get off</em>' : ''}</span><span class="t">${escapeHtml((s.expected ?? s.scheduled).replace(' ', '\u00a0'))}</span></li>`;
    // Folded: the first 6, where you get off, and the last stop; a "Show all" link stands in for each gap
    const keep = new Set([0, 1, 2, 3, 4, 5, stops.length - 1, stops.findIndex(dest)]);
    const folded = !connect.allStops && stops.length > 8;
    const gap = `<li class="gap"><button type="button" class="link-btn" data-allstops>Show all ${stops.length} stops</button></li>`;
    const shown = [];
    stops.forEach((s, i) => {
        if (!folded || keep.has(i)) shown.push(row(s, i));
        else if (keep.has(i - 1)) shown.push(gap);
    });
    return `<ol class="bus-stops" style="--c:${escapeHtml(b.color)}">${shown.join('')}</ol>`;
}

// One bus: its live delay, where it stands, every stop from here on with times, and Follow
async function loadBusDetail(b) {
    const box = $('connect-list').querySelector('[data-detail]');
    if (!box) return;
    try {
        const t = await getJson(`/api/trips/${encodeURIComponent(b.tripId)}`);
        if (connect.open !== b.tripId) return;
        const from = t.stops.findIndex((s) => s.name === b.stop || s.sequence === b.sequence);
        const stops = from === -1 ? t.stops : t.stops.slice(from);
        const live = b.live ? (b.delaySecs >= 60 ? `Running ${minsText(Math.round(b.delaySecs / 60))} late` : b.delaySecs <= -60 ? `Running ${minsText(Math.round(-b.delaySecs / 60))} early` : 'On time') : 'No live prediction for this bus yet: timetable time';
        const on = connect.follow?.bus === b.tripId && connect.follow.train === connect.trip;
        connect.lastStop = stops.length ? stops[stops.length - 1] : null;
        box.innerHTML = `<p><b>${escapeHtml(live)}.</b> Leaves ${escapeHtml(b.leaves)} from ${escapeHtml(b.stop)}${b.platform ? `, platform ${escapeHtml(b.platform)}` : ''}, ${minsText(b.walkMins)} walk from the train.</p>
            ${b.walkOnStreets ? '' : '<p class="follow-note">~ The walk is a straight-line estimate: no street route was found for it.</p>'}
            <div class="bus-actions">
                <button type="button" class="follow-btn" data-follow="${escapeHtml(b.tripId)}" aria-pressed="${on}">${on ? 'Following this bus' : 'Follow this bus'}</button>
                <button type="button" class="follow-btn" data-plan="${escapeHtml(b.tripId)}">Plan this trip</button>
            </div>
            ${on ? '<p class="follow-note">It stays at the top and is re-checked every 30 seconds while this train is open.</p>' : ''}
            ${stopList(stops, b)}`;
    } catch {
        box.innerHTML = '<p class="field-error">Can’t load this bus’s stops right now.</p>';
    }
}

// "Plan this trip": the Plan tab, from the station you change at, leaving in time for this bus,
// to where you said you're going (otherwise to where the bus ends). The planner walks along
// real streets and may find something better than this bus; that's the point of checking.
function planFromBus(b) {
    if (!b || !connect.data) return;
    const end = connect.lastStop;
    const to = connect.to ?? (end?.stationId ? { id: end.stationId, name: end.name } : null);
    if (!to) return;
    const from = { id: connect.at, name: connect.data.station };
    // The planner reads the boxes, so the names must be ones it can find
    for (const p of [from, to]) if (!stations.some((s) => s.id === p.id)) stations.push({ ...p, modes: p.id.startsWith('landmark:') ? 'place' : 'bus' });
    showTab('plan');
    $('plan-from').value = from.name;
    $('plan-to').value = to.name;
    plan.from = from;
    plan.to = to;
    $('plan-when').value = b.planAt;
    findJourneys();
    window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
}

$('connect-at').addEventListener('change', (e) => {
    connect.at = e.target.value;
    connect.open = null;
    connect.more = false;
    connect.data = null;
    $('connect-tools').hidden = !connect.at;
    $('connect-list').innerHTML = '';
    $('connect-more').hidden = true;
    $('connect-out').innerHTML = connect.at ? '<p class="muted">Checking buses…</p>' : '';
    if (connect.at) loadConnect();
});
// Going to: any station, stop or place (optional). Only buses that go there are shown, with when they get there.
stationSearchBox('connect-to', 'connect-to-list');
function setConnectTo(to) {
    connect.to = to;
    $('connect-to-clear').hidden = !to;
    $('connect-out').innerHTML = '<p class="muted">Checking buses…</p>';
    $('connect-list').innerHTML = '';
    if (connect.at) loadConnect();
}
$('connect-to').addEventListener('change', (e) => {
    // Leaving the box fires change again: nothing to do if it's the same place
    if (e.target.value.trim() === (connect.to?.name ?? '')) return;
    const f = findStation(e.target.value);
    if (!e.target.value.trim()) return setConnectTo(null);
    if (f.several) { $('connect-out').innerHTML = `<p class="field-error">More than one place matches: ${escapeHtml(f.several.join(', '))}. Pick one from the list.</p>`; return; }
    if (!f.match) { $('connect-out').innerHTML = '<p class="field-error">Can’t find that place. Start typing and pick it from the list.</p>'; return; }
    e.target.value = f.match.name;
    setConnectTo({ id: f.match.id, name: f.match.name });
});
$('connect-to-clear').addEventListener('click', () => { $('connect-to').value = ''; setConnectTo(null); });
$('connect-q').addEventListener('input', (e) => { connect.q = e.target.value; renderConnect(); });
$('connect-more').addEventListener('click', () => { connect.more = true; renderConnect(); });
$('connect-list').addEventListener('click', (e) => {
    const f = e.target.closest('[data-follow]');
    if (f) {
        const on = f.getAttribute('aria-pressed') === 'true';
        connect.follow = on ? null : { train: connect.trip, at: connect.at, bus: f.dataset.follow };
        saveFollow();
        renderConnect();
        return;
    }
    if (e.target.closest('[data-allstops]')) { connect.allStops = true; renderConnect(); return; }
    const planBtn = e.target.closest('[data-plan]');
    if (planBtn) { planFromBus(connect.data.buses.find((b) => b.tripId === planBtn.dataset.plan)); return; }
    const row = e.target.closest('[data-bus]');
    if (!row) return;
    connect.open = connect.open === row.dataset.bus ? null : row.dataset.bus;
    connect.allStops = false;
    renderConnect();
});

async function loadJourney() {
    if (!state.selected) return;
    const card = $('journey');
    try {
        const j = await getJson(`/api/trips/${encodeURIComponent(state.selected)}`);
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
        // Computer: the trip takes the list's place (the map stays clear)
        document.querySelector('.panel').classList.add('has-trip');
        if (!card.dataset.shown && window.innerWidth >= 1000) document.querySelector('.panel').scrollTop = 0;
        card.dataset.shown = '1';
        // Drawn after the sheet is on screen, so the map knows how much of it the sheet covers
        drawJourney(j);
        updateConnect(j);
    } catch (err) {
        console.error('Failed to load journey:', err);
        card.hidden = true;
    }
}

function closeJourney() {
    state.selected = null;
    setFollowVehicle(false);
    journeyPath = null;
    removeVehicleDot();
    map.getContainer().classList.remove('has-journey');
    journeyLayer.clearLayers();
    journeyFitted = null;
    hideWithExit($('journey'), 180);
    delete $('journey').dataset.shown;
    document.querySelector('.panel').classList.remove('has-trip');
    drawTrains();
    renderTrainList();
}
$('journey-close').addEventListener('click', closeJourney);
$('journey-back').addEventListener('click', () => {
    const tripId = state.selected;
    closeJourney();
    // Back on the list, at the row you picked
    requestAnimationFrame(() => document.querySelector(`[data-trip="${CSS.escape(tripId ?? '')}"]`)?.focus());
});

// Phone sheet: short (line, destination, next stop) or tall (every stop). Tap the handle or the
// title, or drag the handle up or down.
function setSheet(open) {
    const card = $('journey');
    card.dataset.expanded = String(open);
    $('journey-handle').setAttribute('aria-expanded', String(open));
    $('journey-handle').setAttribute('aria-label', open ? 'Show fewer stops' : 'Show all stops');
    if (!open) card.scrollTop = 0;
}
const sheetOpen = () => $('journey').dataset.expanded === 'true';
let dragged = false; // a drag already moved the sheet: the click that follows mustn't move it back
$('journey-handle').addEventListener('click', () => {
    if (dragged) { dragged = false; return; }
    setSheet(!sheetOpen());
});
$('journey-title').addEventListener('click', () => { if (window.innerWidth < 1000) setSheet(!sheetOpen()); });
let dragFrom = null;
$('journey-handle').addEventListener('pointerdown', (e) => { dragFrom = e.clientY; });
window.addEventListener('pointerup', (e) => {
    if (dragFrom === null) return;
    const moved = e.clientY - dragFrom;
    dragFrom = null;
    if (Math.abs(moved) > 30) dragged = true;
    if (moved < -30) setSheet(true);
    else if (moved > 30) setSheet(false);
});
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
    const age = seconds < 60 ? `${seconds}s ago` : `${mins(Math.round(seconds / 60))} ago`;
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
    $('kpi-delay').textContent = mins(Math.round(s.avgLateMinutes));
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
            // Stations and stops only: a campus or airport has no departures board of its own
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

async function pickStation(text) {
    const typed = text.trim().toLowerCase().replace(/ station$/, '');
    const local = () => stations.find((s) => s.name.toLowerCase() === typed)
        ?? (typed.length >= 3 ? stations.find((s) => s.name.toLowerCase().startsWith(typed)) : null);
    let match = local();
    // Enter pressed before the bus-stop search came back (or a stop number typed): ask the server now
    if (!match && typed.length >= 2) {
        clearTimeout(stationSearch);
        const found = await getJson(`/api/stations?q=${encodeURIComponent(text.trim())}`).catch(() => []);
        for (const s of found) if (!stations.some((x) => x.id === s.id)) stations.push(s);
        match = local() ?? found[0] ?? null;
    }
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

// ---------- Day and time picker with a Done button ----------
// The hidden input keeps "YYYY-MM-DDTHH:MM" in Brisbane time, or "" for now.
// Done checks the time hasn't passed, saves it, closes, and calls onDone.
const pad2 = (n) => String(n).padStart(2, '0');
function brisbaneDateAfter(days) {
    return new Date(Date.now() + 10 * 3600 * 1000 + days * 86400 * 1000).toISOString().slice(0, 10);
}
function describeAt(value) {
    if (!value) return 'Now';
    const [date, time] = value.split('T');
    const [h, m] = time.split(':').map(Number);
    const clock = `${h % 12 === 0 ? 12 : h % 12}:${pad2(m)} ${h < 12 ? 'am' : 'pm'}`;
    if (date === brisbaneDateAfter(0)) return `Today, ${clock}`;
    if (date === brisbaneDateAfter(1)) return `Tomorrow, ${clock}`;
    if (date === brisbaneDateAfter(-1)) return `Yesterday, ${clock}`;
    const d = new Date(`${date}T00:00:00Z`);
    return `${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}, ${clock}`;
}

const whenPickers = [];
function whenPicker(rootId, onDone) {
    const root = $(rootId);
    const btn = root.querySelector('.when-btn');
    const input = root.querySelector('input[type="hidden"]');
    const panel = root.querySelector('.when-panel');
    const day = root.querySelector('.w-day');
    const hour = root.querySelector('.w-hour');
    const min = root.querySelector('.w-min');
    const ampm = root.querySelector('.w-ampm');
    const err = root.querySelector('.w-err');
    hour.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    min.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i * 5}">${pad2(i * 5)}</option>`).join('');
    const setAmpm = (v) => ampm.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ampm === v)));
    ampm.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setAmpm(b.dataset.ampm); });

    const refresh = () => { root.querySelector('.when-text').textContent = describeAt(input.value); };
    const open = () => {
        // 3 days back (timetable only) to 7 days ahead
        day.innerHTML = Array.from({ length: 11 }, (_, k) => {
            const i = k - 3;
            const date = brisbaneDateAfter(i);
            const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : i === -1 ? 'Yesterday' : new Date(`${date}T00:00:00Z`).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
            return `<option value="${date}">${label}</option>`;
        }).join('');
        // Start from the chosen time, or now rounded up to the next 5 minutes
        let value = input.value;
        if (!value) {
            const t = Math.ceil((Date.now() + 10 * 3600 * 1000) / 300000) * 300000;
            value = new Date(t).toISOString().slice(0, 16);
        }
        const [date, time] = value.split('T');
        const [h, m] = time.split(':').map(Number);
        day.value = date;
        hour.value = String(h % 12 === 0 ? 12 : h % 12);
        min.value = String(Math.floor(m / 5) * 5);
        setAmpm(h < 12 ? 'am' : 'pm');
        err.hidden = true;
        panel.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        day.focus();
    };
    const close = () => {
        panel.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
    };
    btn.addEventListener('click', () => (panel.hidden ? open() : close()));
    root.querySelector('.w-cancel').addEventListener('click', () => { close(); btn.focus(); });
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { close(); btn.focus(); } });
    root.querySelector('.w-done').addEventListener('click', () => {
        const pm = ampm.querySelector('[aria-pressed="true"]').dataset.ampm === 'pm';
        const h12 = Number(hour.value) % 12;
        const value = `${day.value}T${pad2(h12 + (pm ? 12 : 0))}:${pad2(Number(min.value))}`;
        input.value = value;
        refresh();
        close();
        btn.focus();
        onDone(value);
    });
    const picker = { refresh, close };
    whenPickers.push(picker);
    refresh();
    return picker;
}
// "Today" and "Tomorrow" labels move on at midnight
setInterval(() => whenPickers.forEach((p) => p.refresh()), 60000);

// ---------- Plan: from A to B, with changes ----------
// The planned journey gets its own layer above everything, and the rest of the map fades,
// so its line can't be confused with the other lines of the same colour
map.createPane('plan').style.zIndex = 640; // under the labels (tooltips are 650)
const planRenderer = L.svg({ pane: 'plan' });
const planLayer = L.layerGroup().addTo(map);
const planStyle = { pane: 'plan', renderer: planRenderer, interactive: false };
function setPlanFocus(on) {
    map.getContainer().classList.toggle('is-planning', on);
}
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
                const found = await getJson(`/api/stations?q=${encodeURIComponent(q)}&places=1`);
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
    $('plan-error').hidden = true;
    if ($('plan-from').value.trim() && $('plan-to').value.trim()) findJourneys();
});

function planError(text) {
    $('plan-error').textContent = text;
    $('plan-error').hidden = false;
}

const planPicker = whenPicker('plan-pick', () => {
    if ($('plan-from').value.trim() && $('plan-to').value.trim()) findJourneys();
});
$('plan-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-when]');
    if (!btn) return;
    const v = btn.dataset.when;
    planPicker.close();
    if (v === '0') $('plan-when').value = '';
    else if (v === 'tomorrow') $('plan-when').value = `${brisbaneDateAfter(1)}T07:00`;
    else $('plan-when').value = new Date(Date.now() + 10 * 3600 * 1000 + Number(v) * 60000).toISOString().slice(0, 16);
    planPicker.refresh();
    if ($('plan-from').value.trim() && $('plan-to').value.trim()) findJourneys();
});

// How you get to the first stop (Near me or a place only); remembered on this device
const ACCESS_HINT = {
    walk: 'Walk: stops within 800 m.',
    bike: 'Bike or scooter: stops within 3 km, at 15 km/h, plus a minute to lock up. Changes and the end are on foot.',
    car: 'Car (park & ride or drop-off): stations within 10 km, at 30 km/h, plus 3 mins to park. No traffic, and check parking. Changes and the end are on foot.',
};
let access = 'walk';
function setAccess(value, replan) {
    access = ACCESS_HINT[value] ? value : 'walk';
    for (const b of $('access-seg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.access === access));
    $('access-hint').textContent = ACCESS_HINT[access] + (plan.from?.id && !plan.from.id.startsWith('landmark:') && access !== 'walk' ? ' Only changes anything when From is Near me or a place.' : '');
    try { localStorage.setItem('access', access); } catch { /* fine without */ }
    if (replan && $('plan-from').value.trim() && $('plan-to').value.trim()) findJourneys();
}
try { setAccess(localStorage.getItem('access') || 'walk', false); } catch { setAccess('walk', false); }
$('access-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-access]');
    if (b) setAccess(b.dataset.access, true);
});

// More time to change: remembered on this device only, and re-plans straight away
try { $('plan-more-time').checked = localStorage.getItem('moreTime') === '1'; } catch { /* storage blocked: off */ }
$('plan-more-time').addEventListener('change', (e) => {
    try { localStorage.setItem('moreTime', e.target.checked ? '1' : '0'); } catch { /* fine without */ }
    if ($('plan-from').value.trim() && $('plan-to').value.trim()) findJourneys();
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
    const isNear = (p, id) => p?.lat !== undefined && $(id).value === 'Near me';
    if (!isNear(plan.from, 'plan-from')) {
        const f = findStation($('plan-from').value);
        if (f.several) return planError(`More than one place matches From: ${f.several.join(', ')}. Pick one from the list.`);
        plan.from = f.match ? { id: f.match.id, name: f.match.name } : null;
    }
    if (!isNear(plan.to, 'plan-to')) {
        const t = findStation($('plan-to').value);
        if (t.several) return planError(`More than one place matches To: ${t.several.join(', ')}. Pick one from the list.`);
        plan.to = t.match ? { id: t.match.id, name: t.match.name } : null;
    }
    if (plan.from?.lat !== undefined && plan.to?.lat !== undefined && plan.from.name === 'Near me' && plan.to.name === 'Near me') {
        return planError('From and To are both Near me. Pick a station or place for one of them.');
    }
    if (!plan.from) return planError('Pick where you’re leaving from: start typing and choose from the list, or press Near me.');
    if (!plan.to) return planError('Pick where you’re going: start typing and choose a station or stop from the list.');
    if (plan.from.id && plan.from.id === plan.to.id) return planError('From and To are the same place.');
    $('plan-from').value = plan.from.name;
    $('plan-to').value = plan.to.name;

    const when = $('plan-when').value;
    const at = (when ? `&at=${encodeURIComponent(when)}` : '') + ($('plan-more-time').checked ? '&moreTime=1' : '')
        + (access !== 'walk' ? `&access=${access}` : '');
    const go = $('plan-go');
    const list = $('plan-results');
    go.disabled = true;
    go.textContent = 'Finding journeys…';
    list.setAttribute('aria-busy', 'true');
    try {
        const res = await getJson(`/api/plan?${placeQuery('from', plan.from)}&${placeQuery('to', plan.to)}${at}`);
        plan.journeys = res.journeys;
        plan.date = res.date;
        const n = `${res.journeys.length} ${res.journeys.length === 1 ? 'journey' : 'journeys'}`;
        $('plan-note').textContent = res.note ?? (res.nextDay
            ? `Nothing more today. ${n} tomorrow morning (timetable). Walks are estimates.`
            : res.past ? `${n} leaving from ${res.at}. This time has passed, so these are timetable times with no live delays.`
                : res.planned ? `${n} leaving from ${res.at}. Timetable times: TransLink shares delays only shortly before and during a trip, so check again closer to the time.`
                    : `${n} leaving from ${res.at}. Delays are live where TransLink has them; trips that haven't started yet show timetable times. Walks are estimates.`);
        renderJourneys(res);
        if (res.journeys.length) openPlanJourney(0);
        else { planLayer.clearLayers(); setPlanFocus(false); planShown = null; }
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

const MOVE_VERB = { walk: 'Walk', bike: 'Ride', car: 'Drive' };
const CHANGE_TEXT = { make: 'Make it', tight: 'Tight change', miss: 'Likely to miss' };
const legName = (l) => (l.mode === 'train' ? l.routeName.replace(/ line$/i, '') || 'Train' : `${l.mode === 'bus' ? 'Bus' : l.mode === 'tram' ? 'Tram' : 'Ferry'} ${l.routeShort}`);
const placeName = (p, fallback) => escapeHtml((p?.name ?? fallback).replace(/ (station|ferry terminal)$/, ''));

const lateText = (sec) => `${mins(Math.round(Math.abs(sec) / 60))} ${sec > 0 ? 'late' : 'early'}`;

// Which journey to take right now: the earliest real arrival, skipping ones with a change
// you're likely to miss or a cancelled vehicle. Only when planning for now (live delays known).
function bestNow(journeys, live) {
    if (!live) return -1;
    let best = -1;
    journeys.forEach((j, i) => {
        if (j.risky === 'miss') return;
        if (best === -1 || j.arriveExpectedSecs < journeys[best].arriveExpectedSecs) best = i;
    });
    return best;
}

// One line under the times saying what live data says about this journey
function journeyStatus(j, isNow, best, i) {
    const rides = j.legs.filter((l) => l.kind === 'ride');
    const cancelled = rides.find((r) => r.status === 'cancelled');
    if (cancelled) return `<span class="trip-flag miss">${escapeHtml(legName(cancelled))} is cancelled</span>`;
    const missed = rides.find((r) => r.change === 'miss');
    if (missed) {
        const better = best !== -1 && best !== i ? plan.journeys[best] : null;
        return `<span class="trip-flag miss">Likely to miss the ${escapeHtml(legName(missed))}${better ? `: take the ${escapeHtml(better.leave)} instead (arrives ${escapeHtml(better.arriveExpected ?? better.arrive)})` : ''}</span>`;
    }
    const parts = [];
    if (j.lateBySec >= 60) parts.push(`<span class="trip-flag tight">Running ${lateText(j.lateBySec)}: arrives ${escapeHtml(j.arriveExpected)}</span>`);
    else if (j.live) parts.push('<span class="trip-flag ok">On time so far</span>');
    else if (isNow) parts.push('<span class="trip-flag none">No live data yet: timetable times</span>');
    if (rides.some((r) => r.change === 'tight')) parts.push('<span class="trip-flag tight">Tight change</span>');
    return parts.join('');
}

function renderJourneys(res) {
    const list = $('plan-results');
    const isNow = !res.planned && !res.nextDay;
    const best = bestNow(plan.journeys, isNow && plan.journeys.some((j) => j.live));
    list.innerHTML = plan.journeys.map((j, i) => {
        const rides = j.legs.filter((l) => l.kind === 'ride');
        const chain = rides.map((l) => {
            const late = l.delaySec !== null && l.delaySec >= 60 ? `<i>+${Math.round(l.delaySec / 60)}</i>` : '';
            return `<span class="badge" style="--c:${escapeHtml(l.color)};--t:${escapeHtml(l.textColor)}">${escapeHtml(l.mode === 'train' ? 'Train' : l.routeShort)}${late}</span>`;
        }).join('<span class="sep" aria-hidden="true">›</span>');
        const tag = i === best && plan.journeys.length > 1 ? '<span class="best-tag">Best right now</span>' : '';
        return `<li class="trip-card${i === best ? ' best' : ''}" data-i="${i}" aria-expanded="false">
          <button type="button" aria-label="${escapeHtml(`Leave ${j.leave}, arrive ${j.arriveExpected ?? j.arrive}, ${duration(j.minutes)}, ${j.changes} changes. Show details`)}">
            ${tag}
            <span class="trip-head"><span class="times">${escapeHtml(j.leave)} → ${j.arriveExpected ? `<s>${escapeHtml(j.arrive)}</s> ${escapeHtml(j.arriveExpected)}` : escapeHtml(j.arrive)}</span>
              <span class="meta">${duration(j.minutes)} · ${j.changes === 0 ? 'direct' : `${j.changes} change${j.changes > 1 ? 's' : ''}`}</span></span>
            <span class="trip-chain">${chain}</span>
            <span class="trip-status">${journeyStatus(j, isNow, best, i)}</span>
          </button>
          <ol class="legs" hidden></ol>
        </li>`;
    }).join('');
}

function legsHtml(j) {
    return j.legs.map((l, i) => {
        if (l.kind === 'walk') {
            if (l.platformChange) {
                // Train to train: "Change platforms". Bus to train (same station): "Walk to platform 1"
                const before = j.legs[i - 1];
                const after = j.legs[i + 1];
                const trains = before?.mode === 'train' && after?.mode === 'train';
                const where = l.to?.platform ? `platform ${escapeHtml(l.to.platform)}` : placeName(l.to);
                const text = trains ? `Change platforms${l.to?.platform ? ` to platform ${escapeHtml(l.to.platform)}` : ''}` : `Walk to ${where}`;
                return `<li class="leg walk" data-leg="${i}"><span class="t"></span><span class="d">${text} (about ${mins(l.minutes)})</span></li>`;
            }
            const to = l.to ? `to ${placeName(l.to)}` : `to ${placeName(plan.to, 'where you’re going')}`;
            const verb = MOVE_VERB[l.mode] ?? 'Walk';
            const extra = l.mode === 'car' ? ' (check parking)' : '';
            return `<li class="leg walk ${l.mode ?? 'walk'}" data-leg="${i}"><span class="t"></span><span class="d" data-to="${to}" data-verb="${verb}" data-extra="${extra}">${verb} about ${mins(l.minutes)} ${to}${extra}</span></li>`;
        }
        const change = l.change ? `<span class="change ${l.change}">${CHANGE_TEXT[l.change]}</span>` : '';
        const status = l.status === 'cancelled' || l.live ? statusHtml(l.status, l.statusText) : '<span class="muted">Timetable (no live data yet)</span>';
        // Three rows on the line's colour: get on (time, where), the ride, get off (time, where).
        // Both ends have their own time in the time column, so nobody has to find it inside a sentence.
        const offTime = l.arriveExpected && l.arriveDelaySec !== null
            ? `<s>${escapeHtml(l.arrive)}</s><small>${escapeHtml(l.arriveExpected)}</small>`
            : escapeHtml(l.arrive);
        return `<li class="leg ride" style="--c:${escapeHtml(l.color)}">
          <span class="t">${l.departExpected ? `<s>${escapeHtml(l.depart)}</s><small>${escapeHtml(l.departExpected)}</small>` : escapeHtml(l.depart)}</span>
          <span class="d end on"><em>Get on</em><b>${placeName(l.from)}</b>${l.from?.platform ? `<span>Platform ${escapeHtml(l.from.platform)}</span>` : ''}</span>
          <span class="t"></span>
          <span class="d mid">${change}<b>${escapeHtml(legName(l))} to ${escapeHtml(l.headsign)}</b>
            <span>${status} · ${l.stops} stop${l.stops === 1 ? '' : 's'}</span></span>
          <span class="t off-t">${offTime}</span>
          <span class="d end off"><em>Get off</em><b>${placeName(l.to)}</b>${l.arriveExpected && l.arriveDelaySec !== null ? `<span class="late-text">${lateText(l.arriveDelaySec)}</span>` : ''}</span>
        </li>`;
    }).join('');
}

function openPlanJourney(i) {
    for (const card of $('plan-results').children) {
        const open = Number(card.dataset.i) === i;
        card.setAttribute('aria-expanded', String(open));
        const legs = card.querySelector('.legs');
        legs.hidden = !open;
        if (open) legs.innerHTML = legsHtml(plan.journeys[i]) + startButton(plan.journeys[i], i);
    }
    drawPlan(plan.journeys[i]);
}

$('plan-results').addEventListener('click', (e) => {
    const go = e.target.closest('[data-start]');
    if (go) { startJourney(plan.journeys[Number(go.dataset.start)], plan.date); return; }
    const card = e.target.closest('.trip-card');
    if (!card || !e.target.closest('button')) return;
    openPlanJourney(Number(card.dataset.i));
});

// Walking path along real streets, from the server (which caches it). null -> keep the straight line.
const walkCache = new Map();
function streetWalk(a, b, mode = 'walk') {
    const key = `${mode}:${a.lat.toFixed(4)},${a.lng.toFixed(4)};${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
    if (!walkCache.has(key)) {
        walkCache.set(key, fetch(`/api/walk?from=${a.lat.toFixed(5)},${a.lng.toFixed(5)}&to=${b.lat.toFixed(5)},${b.lng.toFixed(5)}&mode=${mode}`)
            .then((r) => (r.status === 200 ? r.json() : null))
            .catch(() => null));
    }
    return walkCache.get(key);
}

// Each ride's real stops come from the trip; walks follow streets when the walking router answers
async function drawPlan(j) {
    planShown = j;
    planLayer.clearLayers();
    journeyLayer.clearLayers();
    const all = [];
    // [lat, lng] of names already on the map; "You" counts, so the first stop next to you isn't named on top of it
    const labelled = [plan.from, plan.to].filter((p) => p?.lat !== undefined && p.name === 'Near me').map((p) => [p.lat, p.lng]);
    j.legs.forEach((l, i) => {
        if (l.kind === 'walk') {
            const placeOf = (p) => (!p ? null : p.lat !== undefined ? p : stations.find((s) => s.id === p.id));
            const a = l.from ?? (i > 0 ? j.legs[i - 1].to : null) ?? placeOf(plan.from);
            const b = l.to ?? placeOf(plan.to);
            // A platform change inside one station has nothing to draw
            if (!l.platformChange && a?.lat != null && b?.lat != null) {
                // Straight line first (faint), then the real path along streets when it arrives
                const straight = L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { ...planStyle, color: '#3d4a43', weight: 3, opacity: 0.45, dashArray: '2 7', lineCap: 'round' }).addTo(planLayer);
                all.push([a.lat, a.lng], [b.lat, b.lng]);
                streetWalk(a, b, l.mode ?? 'walk').then((route) => {
                    if (!route || planShown !== j) return;
                    planLayer.removeLayer(straight);
                    L.polyline(route.points, { ...planStyle, color: '#ffffff', weight: 7, lineCap: 'round', lineJoin: 'round' }).addTo(planLayer);
                    // Walk: dots. Bike or scooter: dashes. Car: a solid grey line
                    const dash = { walk: '0.1 8', bike: '8 6', car: null }[l.mode ?? 'walk'];
                    L.polyline(route.points, { ...planStyle, color: '#3d4a43', weight: 4, dashArray: dash, lineCap: 'round', lineJoin: 'round' }).addTo(planLayer);
                    const row = document.querySelector(`.trip-card[aria-expanded="true"] .leg.walk[data-leg="${i}"] .d`);
                    if (row && route.metres >= 40) row.textContent = `${row.dataset.verb} ${mins(Math.max(1, Math.round(route.secs / 60)))} (${route.metres < 1000 ? `${route.metres} m` : `${(route.metres / 1000).toFixed(1)} km`}) ${row.dataset.to}${row.dataset.extra}`;
                });
            }
            return;
        }
        // The server sends each ride's path along its real track or road (see planner.js)
        const pts = l.path ?? [l.from, l.to].filter((s) => s?.lat != null).map((s) => [s.lat, s.lng]);
        if (pts.length < 2) return;
        // A white edge, then the route colour on top: clean against the faded map
        L.polyline(pts, { ...planStyle, className: 'plan-edge', color: '#ffffff', weight: 11, opacity: 1, lineJoin: 'round', lineCap: 'round' }).addTo(planLayer);
        L.polyline(pts, { ...planStyle, color: l.color, weight: 6, opacity: 1, lineJoin: 'round', lineCap: 'round' }).addTo(planLayer);
        // Only where you get on and off: stops in between are in the list and only add noise here
        for (const s of [l.from, l.to].filter((x) => x?.lat != null)) {
            // One label per place: a change between two stops close together gets one name, not two on top of each other
            const near = labelled.some(([la, ln]) => Math.abs(la - s.lat) < 0.003 && Math.abs(ln - s.lng) < 0.003);
            if (near) {
                L.circleMarker([s.lat, s.lng], { pane: 'plan', renderer: planRenderer, radius: 6, weight: 3, color: l.color, fillColor: '#ffffff', fillOpacity: 1 })
                    .bindTooltip(escapeHtml(s.name)).addTo(planLayer);
                continue;
            }
            labelled.push([s.lat, s.lng]);
            L.circleMarker([s.lat, s.lng], { pane: 'plan', renderer: planRenderer, radius: 6, weight: 3, color: l.color, fillColor: '#ffffff', fillOpacity: 1 })
                .bindTooltip(escapeHtml(s.name)).addTo(planLayer);
            L.tooltip({ permanent: true, direction: 'right', offset: [8, 0], className: 'plan-label', pane: 'tooltipPane' })
                .setLatLng([s.lat, s.lng]).setContent(escapeHtml(s.name.replace(/ (station|ferry terminal)$/, ''))).addTo(planLayer);
        }
        all.push(...pts);
    });
    setPlanFocus(true);
    for (const me of [plan.from, plan.to].filter((p) => p?.lat !== undefined && p.name === 'Near me')) {
        L.circleMarker([me.lat, me.lng], { pane: 'plan', renderer: planRenderer, radius: 7, weight: 3, color: '#2f6b5a', fillColor: '#2f6b5a', fillOpacity: 1 })
            .bindTooltip('You', { permanent: true, direction: 'right', offset: [8, 0], className: 'station-label' }).addTo(planLayer);
    }
    if (all.length) map.flyToBounds(all, { padding: [40, 40], maxZoom: 15, duration: reduceMotion() ? 0 : 0.8 });
}

// ---------- When: now, or a time up to 7 days ahead ----------
// Brisbane has no daylight saving, so its time is always UTC+10
function brisbaneNow() {
    return new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 16);
}
let boardPicker = null;
function setupWhen() {
    $('when-input').value = state.at || '';
    boardPicker = whenPicker('board-pick', (value) => setWhen(value));
}
function setWhen(value) {
    state.at = value || '';
    $('when-now').hidden = !state.at;
    $('when-input').value = state.at;
    boardPicker?.refresh();
    boardPicker?.close();
    saveUrl();
    loadBoard();
}
function describeWhen(at) {
    const d = new Date(`${at}:00Z`);
    const day = d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).toLowerCase();
    return at < brisbaneNow()
        ? `Timetable for ${day}, from ${time}. This time has passed, so there are no live delays.`
        : `Timetable for ${day}, from ${time}. Live delays show up closer to the time.`;
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
                ? '<li class="empty">Nothing leaves from here in the 3 hours after that time. Try an earlier time, or another station or stop (some stops are only where buses finish).</li>'
                : '<li class="empty">Nothing leaves from here in the next 2 hours. Services may have finished for the night, or buses only finish at this stop; try another station or stop, or plan ahead above.</li>';
            return;
        }
        board.innerHTML = departures.map((d) => `
            <li class="${d.status === 'cancelled' ? 'cancelled' : ''}${d.tripId === state.selected ? ' selected' : ''}" data-trip="${escapeHtml(d.tripId)}" tabindex="0" role="button" aria-label="${escapeHtml(`${d.scheduled} ${d.routeShort ?? ''} to ${d.headsign}: show stops`)}">
              <span class="time">${d.expected ? `<small>${escapeHtml(d.scheduled)}</small>${escapeHtml(d.expected)}` : escapeHtml(d.scheduled)}</span>
              <span class="dest"><span class="to" style="--c:${escapeHtml(d.color)}" title="${escapeHtml(d.routeName)}">${d.mode && d.mode !== 'train' ? `<b class="route-no">${escapeHtml(d.routeShort)}</b> ` : ''}${escapeHtml(d.headsign)}</span>
                ${d.location ? `<span class="where">${escapeHtml(d.location)}${d.minutesAway > 0 ? ` · ${mins(d.minutesAway)}` : ''}</span>` : ''}</span>
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
    setWhen(target);
});

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
          <p class="hint">Late ones on ${escapeHtml(s.lines.slice(-1)[0].name)}, the least reliable line, were about ${mins(s.lines.slice(-1)[0].avgLateMinutes)} late</p>

          <h3 class="stats-h">By time of day</h3>
          <p class="hint">When the trip was due to start</p>
          ${bars(s.byHour, (h) => hourLabel(h.hour))}

          <h3 class="stats-h">Making a connection</h3>
          <p class="hint">If you leave a few minutes between the train getting in and the bus (or train) you're catching, how often would the train have got you there in time? By the hour it was due to start.</p>
          <div class="conn-tools">
            <div class="seg" id="conn-spare" role="group" aria-label="Minutes you leave to change">
              ${[3, 5, 10].map((m) => `<button type="button" data-spare="${m}" aria-pressed="${m === connSpare}">${m} min</button>`).join('')}
            </div>
            <label class="visually-hidden" for="conn-line">Line</label>
            <select id="conn-line"><option value="">All train lines</option></select>
          </div>
          <div id="conn-stats" aria-live="polite"></div>

          ${s.byDay.length > 1 ? `<h3 class="stats-h">Day by day</h3>${bars(s.byDay, (d) => shortDate(d.date))}` : ''}

          <h3 class="stats-h">Often late</h3>
          ${s.worst.length ? `<ol class="worst">${s.worst.map((w) => `
            <li><span class="to" style="--c:${escapeHtml(w.color)}">${escapeHtml(w.time)} ${escapeHtml(w.origin)} to ${escapeHtml(w.headsign)}</span>
              <span class="quiet">about ${mins(w.avgLateMinutes)} late · ${w.runs} runs</span></li>`).join('')}</ol>`
            : '<p class="empty">Each departure needs at least 2 recorded runs before it shows here. Check back in a day or two.</p>'}`;
        loadConnStats();
    } catch (err) {
        box.innerHTML = '<p class="empty">The numbers aren’t loading right now. Try again in a minute.</p>';
        console.error('Failed to load stats:', err);
    }
}
// Making a connection: spare minutes (3, 5, 10) and a line; bars per hour of the day
let connSpare = 5;
let connLine = '';
async function loadConnStats() {
    const box = $('conn-stats');
    if (!box) return;
    const want = `${statsDays}|${connSpare}|${connLine}`;
    try {
        const c = await getJson(`/api/stats/connections?days=${statsDays}&spare=${connSpare}${connLine ? `&line=${encodeURIComponent(connLine)}` : ''}`);
        if (want !== `${statsDays}|${connSpare}|${connLine}`) return;
        const sel = $('conn-line');
        if (sel.options.length === 1) sel.insertAdjacentHTML('beforeend', c.lines.map((n) => `<option>${escapeHtml(n)}</option>`).join(''));
        sel.value = connLine;
        if (c.byHour.length === 0) {
            box.innerHTML = '<p class="empty">Not enough trips recorded for this yet. Try a longer period or all lines.</p>';
            return;
        }
        const best = c.byHour.reduce((a, b) => (b.madePercent > a.madePercent ? b : a));
        const worst = c.byHour.reduce((a, b) => (b.madePercent < a.madePercent ? b : a));
        box.innerHTML = `${bars(c.byHour.map((h) => ({ ...h, onTimePercent: h.madePercent })), (h) => hourLabel(h.hour))}
          <p class="conn-summary">With ${connSpare} minutes to change, ${escapeHtml(hourLabel(worst.hour))} trains were the least likely to get you there (${worst.madePercent}%), ${escapeHtml(hourLabel(best.hour))} the most (${best.madePercent}%). From ${c.trips.toLocaleString('en-AU')} trips; how late a train was at the end of its run stands in for how late it is where you change.</p>`;
    } catch {
        box.innerHTML = '<p class="empty">This isn’t loading right now. Try again in a minute.</p>';
    }
}
$('stats').addEventListener('click', (e) => {
    const b = e.target.closest('#conn-spare button[data-spare]');
    if (!b) return;
    connSpare = Number(b.dataset.spare);
    for (const x of document.querySelectorAll('#conn-spare button')) x.setAttribute('aria-pressed', String(x === b));
    loadConnStats();
});
$('stats').addEventListener('change', (e) => {
    if (e.target.id !== 'conn-line') return;
    connLine = e.target.value;
    loadConnStats();
});

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

// ---------- Start journey (docs/start-journey.md) ----------
// After you pick a planned journey: one instruction at a time ("Get on the train to Caboolture,
// platform 2", "3 stops to go", "Next stop: get off at Indooroopilly"), worked out from where the
// vehicle is (GET /api/trips/:id), not from your phone's GPS, so it works in tunnels too.
// While the page is open: a sound, a buzz and a notification at the moments that matter, and the
// screen stays on. The journey is remembered on this device, so a reload carries on.
const GO_KEY = 'rl-go';
const go = { j: null, date: null, trips: new Map(), done: new Set(), timer: null, wake: null, step: undefined, freshAlert: false };

// Brisbane is UTC+10 all year: a time on the journey's day as a real moment
const epochOf = (date, secs) => Date.parse(`${date}T00:00:00Z`) - 10 * 3600 * 1000 + secs * 1000;

function startButton(j, i) {
    const rides = j.legs.filter((l) => l.kind === 'ride');
    if (!rides.length || !plan.date) return '';
    const leave = epochOf(plan.date, j.leaveSecs ?? rides[0].departSecs);
    const end = epochOf(plan.date, rides[rides.length - 1].arriveSecs);
    // Only for a journey happening now: from 90 minutes before you leave until it's over
    if (Date.now() < leave - 90 * 60000 || Date.now() > end + 10 * 60000) {
        return '<p class="go-later">Start journey shows up from 90 minutes before you leave.</p>';
    }
    return `<button type="button" class="start-btn" data-start="${i}">Start journey</button>`;
}

function startJourney(j, date) {
    go.j = j;
    go.date = date;
    go.trips.clear();
    go.done.clear();
    go.step = undefined;
    $('go-alert').hidden = true;
    try { localStorage.setItem(GO_KEY, JSON.stringify({ j, date })); } catch { /* fine for this visit */ }
    // Asked here, when you press the button (browsers only allow asking after a tap)
    // (and the push subscription needs it: startPush waits for the answer)
    keepAwake(true);
    startPush(j);
    $('go').hidden = false;
    $('view-plan').scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
    tickJourney();
    clearInterval(go.timer);
    go.timer = setInterval(tickJourney, 15000);
}

function endJourney() {
    stopPush();
    clearInterval(go.timer);
    go.j = null;
    keepAwake(false);
    try { localStorage.removeItem(GO_KEY); } catch { /* nothing kept */ }
    $('go').hidden = true;
}
$('go-end').addEventListener('click', endJourney);

// The screen stays on while a journey is running (where the browser allows it)
async function keepAwake(on) {
    try {
        if (on && 'wakeLock' in navigator && !go.wake) go.wake = await navigator.wakeLock.request('screen');
        if (!on && go.wake) { await go.wake.release(); go.wake = null; }
    } catch { go.wake = null; }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && go.j) { go.wake = null; keepAwake(true); tickJourney(); }
});

// Where each ride is: its stops with passed / next / upcoming and seconds until each
async function rideProgress(l) {
    try {
        const t = await getJson(`/api/trips/${encodeURIComponent(l.tripId)}`);
        go.trips.set(l.tripId, t.stops);
        return t.stops;
    } catch {
        return go.trips.get(l.tripId) ?? null; // offline for a moment: the last we knew
    }
}

const NOUN = { train: 'train', bus: 'bus', ferry: 'ferry', tram: 'tram' };
const nounOf = (l) => NOUN[l.mode] ?? 'service';
const lineOf = (l) => (l.mode === 'train' ? `${l.routeName || 'train'}` : `${nounOf(l)} ${l.routeShort}`);

// Once per moment: a sound, a buzz, a notification (if allowed) and the banner
function alertOnce(key, text) {
    if (go.done.has(key)) return;
    go.done.add(key);
    go.freshAlert = true;
    const box = $('go-alert');
    box.textContent = text;
    box.hidden = false;
    try { navigator.vibrate?.([200, 100, 200]); } catch { /* no vibration */ }
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [784, 988].forEach((f, k) => {
            const o = ctx.createOscillator(); const g = ctx.createGain();
            o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, ctx.currentTime + k * 0.2);
            g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + k * 0.2 + 0.03);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + k * 0.2 + 0.45);
            o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + k * 0.2); o.stop(ctx.currentTime + k * 0.2 + 0.5);
        });
    } catch { /* no sound */ }
    // The server sends this one itself when push is on (see startPush); no second copy from here
    let pushing = false;
    try { pushing = Boolean(localStorage.getItem(PUSH_KEY)); } catch { /* not kept */ }
    if (!pushing && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        navigator.serviceWorker?.ready.then((r) => r.showNotification('Railway Live', { body: text, tag: 'rl-go', renotify: true }))
            .catch(() => { try { new Notification('Railway Live', { body: text }); } catch { /* not allowed */ } });
    }
}

// The steps of the journey and which one you're on, from the latest positions
async function tickJourney() {
    const j = go.j;
    if (!j) return;
    const rides = j.legs.filter((l) => l.kind === 'ride');
    const progress = await Promise.all(rides.map(rideProgress));
    if (go.j !== j) return;
    const steps = [];
    let current = -1;
    let warn = null;
    j.legs.forEach((l, i) => {
        if (l.kind === 'walk') {
            const to = l.to ?? j.legs[i + 1]?.from;
            const where = to ? `${to.name}${to.platform ? `, platform ${to.platform}` : ''}` : (plan.to?.name ?? 'where you’re going');
            steps.push({ kind: 'walk', leg: l, text: `${l.platformChange ? 'Change platforms' : 'Walk'} about ${mins(l.minutes)} to ${where}`, done: false });
            return;
        }
        const stops = progress[rides.indexOf(l)];
        const board = stops?.find((s) => s.sequence === l.fromSeq);
        const off = stops?.find((s) => s.sequence === l.toSeq);
        const boarded = board?.state === 'passed';
        const arrived = off?.state === 'passed';
        const nextIdx = stops ? stops.findIndex((s) => s.state === 'next') : -1;
        const offIdx = stops ? stops.findIndex((s) => s.sequence === l.toSeq) : -1;
        const left = nextIdx === -1 || offIdx === -1 ? null : offIdx - nextIdx + 1;
        const leavesIn = board ? Math.round(board.etaSec / 60) : null;
        steps.push({
            kind: 'board', leg: l, done: boarded,
            text: `Get on the ${lineOf(l)} to ${l.headsign}`,
            sub: `${l.from?.name ?? ''}${l.from?.platform ? `, platform ${l.from.platform}` : ''} · ${board?.expected ?? l.depart}${leavesIn !== null && leavesIn >= 0 && !boarded ? ` (in ${mins(leavesIn)})` : ''}`,
        });
        steps.push({
            kind: 'ride', leg: l, done: arrived, left, offEta: off?.etaSec ?? null,
            text: `Get off at ${l.to?.name ?? ''}`,
            sub: `${off?.expected ?? l.arrive}${boarded && !arrived && left !== null ? ` · ${left === 1 ? 'next stop' : `${left} stops to go`}` : ` · ${l.stops} stop${l.stops === 1 ? '' : 's'}`}`,
        });
        // The moments to tell you about
        if (!boarded && leavesIn !== null && leavesIn <= 2 && leavesIn >= -1) {
            alertOnce(`board-${l.tripId}`, `Your ${lineOf(l)} to ${l.headsign} leaves ${l.from?.name ?? ''}${l.from?.platform ? ` from platform ${l.from.platform}` : ''} in ${leavesIn <= 0 ? 'under a minute' : mins(leavesIn)}.`);
        }
        const soon = l.mode === 'bus' ? 2 : 1;
        if (boarded && !arrived && left !== null && left <= soon) {
            alertOnce(`off-${l.tripId}-${left}`, l.mode === 'bus'
                ? `${left === 1 ? 'Next stop' : '2 stops to go'}: get off at ${l.to?.name}. Press the bell${left === 1 ? ' now' : ' after the next stop'}.`
                : `Next stop: get off at ${l.to?.name}${l.mode === 'ferry' ? '' : ''}. Get ready.`);
        }
        // Will you still make the next ride? (this one's expected arrival + the walk vs the next departure)
        const k = j.legs.indexOf(l);
        const nextRide = rides[rides.indexOf(l) + 1];
        if (nextRide && off && !arrived) {
            const walkMins = j.legs.slice(k + 1, j.legs.indexOf(nextRide)).reduce((n, x) => n + (x.minutes ?? 0), 0);
            const nextStops = progress[rides.indexOf(nextRide)];
            const nextBoard = nextStops?.find((s) => s.sequence === nextRide.fromSeq);
            if (nextBoard) {
                const spare = nextBoard.etaSec - (off.etaSec + walkMins * 60);
                if (spare < 0) warn = { leg: nextRide, from: l.to, at: off };
            }
        }
    });
    // Each walk is done once the ride after it has started (or, for the last one, never by itself)
    steps.forEach((s, i) => {
        if (s.kind !== 'walk') return;
        s.done = steps.slice(i + 1).some((x) => x.done);
        // The walk at the end: done once you've had time to walk it after getting off
        const prev = steps[i - 1];
        if (i === steps.length - 1 && prev?.done && prev.offEta !== null && prev.offEta <= -s.leg.minutes * 60) s.done = true;
    });
    current = steps.findIndex((s) => !s.done);
    const lastRideDone = steps.filter((s) => s.kind === 'ride').every((s) => s.done);
    renderJourney(steps, current, lastRideDone, warn);
}

function renderJourney(steps, current, finished, warn) {
    const now = steps[current];
    // A message belongs to the step it was about: moving on clears it (a new one may replace it)
    if (go.step !== undefined && go.step !== current && !warn && !go.freshAlert) $('go-alert').hidden = true;
    go.step = current;
    go.freshAlert = false;
    const nowBox = $('go-now');
    if (!now) {
        nowBox.innerHTML = '<b>You’ve arrived.</b><span>Press End journey when you’re done.</span>';
    } else {
        nowBox.innerHTML = `<b>${escapeHtml(now.text)}</b>${now.sub ? `<span>${escapeHtml(now.sub)}</span>` : ''}<div class="go-walk" data-walk></div>`;
        if (now.kind === 'walk') showWalkSteps(now.leg, steps, current);
    }
    $('go-steps').innerHTML = steps.map((s, i) => `<li class="${s.done ? 'done' : i === current ? 'now' : ''}" style="--c:${escapeHtml(s.leg.color ?? '#8a8f87')}">
        <b>${escapeHtml(s.text)}</b>${s.sub ? `<span>${escapeHtml(s.sub)}</span>` : ''}</li>`).join('');
    $('go-foot').textContent = 'Steps follow where each vehicle is right now (TransLink live data, or the timetable when there’s none). Station exits aren’t published, so which way to walk out isn’t shown.';
    if (warn) {
        const text = `You may miss the ${lineOf(warn.leg)} at ${warn.leg.depart}: the one you’re on is running late.`;
        alertOnce(`miss-${warn.leg.tripId}`, text);
        $('go-alert').hidden = false;
        $('go-alert').innerHTML = `${escapeHtml(text)} <button type="button" class="link-btn" id="go-replan">Find another way</button>`;
        $('go-replan').onclick = () => replanFrom(warn.from);
    }
}

// Turn-by-turn for the walk you're on (OpenStreetMap streets via the walking router)
async function showWalkSteps(l, steps, i) {
    const box = $('go-now').querySelector('[data-walk]');
    const a = l.from ?? steps[i - 1]?.leg?.to ?? (plan.from?.lat !== undefined ? plan.from : null);
    const b = l.to ?? steps[i + 1]?.leg?.from ?? (plan.to?.lat !== undefined ? plan.to : null);
    if (!box || !a?.lat || !b?.lat) return;
    const r = await streetWalk(a, b, l.mode === 'bike' || l.mode === 'car' ? l.mode : 'walk');
    if (!r?.steps?.length || !box.isConnected) return;
    box.innerHTML = `<ol>${r.steps.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ol>`;
}

// Late and about to miss a change: plan again from where you'll get off
function replanFrom(stop) {
    if (!stop) return;
    endJourney();
    const f = findStation(stop.name);
    if (f.match) plan.from = { id: f.match.id, name: f.match.name };
    else if (stop.lat !== undefined) plan.from = { lat: stop.lat, lng: stop.lng, name: 'Near me' };
    $('plan-from').value = plan.from.name;
    $('plan-when').value = '';
    findJourneys();
}

// A journey started earlier on this device carries on after a reload (if it isn't over)
try {
    const saved = JSON.parse(localStorage.getItem(GO_KEY) || 'null');
    if (saved?.j) {
        const last = saved.j.legs.filter((l) => l.kind === 'ride').pop();
        if (last && Date.now() < epochOf(saved.date, last.arriveSecs) + 30 * 60000) {
            go.j = saved.j; go.date = saved.date;
            $('go').hidden = false;
            showTab('plan');
            tickJourney();
            go.timer = setInterval(tickJourney, 15000);
            keepAwake(true);
        } else localStorage.removeItem(GO_KEY);
    }
} catch { /* nothing kept */ }

// ---------- PWA + Web Push for Start journey ----------
// The service worker (sw.js) makes the site installable and shows the notifications the server
// sends while you're on a journey and the page isn't on screen (push.js on the server).
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
const PUSH_KEY = 'rl-push-id';
const b64ToBytes = (b64) => {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Why notifications won't come, in plain words (shown under the journey)
function pushNote(text) {
    const foot = $('go-foot');
    if (!foot) return;
    let note = document.getElementById('go-push');
    if (!note) { note = document.createElement('p'); note.id = 'go-push'; note.className = 'go-push'; foot.before(note); }
    note.textContent = text;
    note.hidden = !text;
}

async function startPush(j) {
    if (isIos && !installed) {
        return pushNote('To get these alerts with your iPhone locked: Share, then Add to Home Screen (iOS 16.4 or later), open Railway Live from there and start the journey again. Until then, keep this page open.');
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        return pushNote('This browser can’t show alerts with the screen locked. Keep this page open and you’ll still get them here.');
    }
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') {
        return pushNote('Notifications are off for this site, so alerts only show while this page is open. You can allow them in your browser’s site settings.');
    }
    try {
        const { key } = await getJson('/api/push/key');
        const reg = await navigator.serviceWorker.ready;
        const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
        const rides = j.legs.filter((l) => l.kind === 'ride');
        const walkMinsBefore = rides.map((r) => {
            const k = j.legs.indexOf(r);
            let n = 0;
            for (let x = k - 1; x >= 0 && j.legs[x].kind === 'walk'; x -= 1) n += j.legs[x].minutes ?? 0;
            return n;
        });
        const res = await fetch('/api/push/journey', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subscription: sub.toJSON(),
                walkMinsBefore,
                rides: rides.map((l) => ({
                    tripId: l.tripId, mode: l.mode, line: lineOf(l), headsign: l.headsign,
                    fromName: l.from?.name, fromPlatform: l.from?.platform ?? '', toName: l.to?.name,
                    fromSeq: l.fromSeq, toSeq: l.toSeq, depart: l.depart,
                })),
            }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const { id } = await res.json();
        try { localStorage.setItem(PUSH_KEY, id); } catch { /* fine */ }
        pushNote('Alerts will come even with your phone locked.');
    } catch {
        pushNote('Alerts with the screen locked aren’t available right now. Keep this page open and you’ll still get them here.');
    }
}

function stopPush() {
    let id = null;
    try { id = localStorage.getItem(PUSH_KEY); localStorage.removeItem(PUSH_KEY); } catch { /* fine */ }
    if (id) fetch(`/api/push/journey/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    pushNote('');
}
