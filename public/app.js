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
    mode: ['train', 'tram', 'ferry'].includes(params.get('mode')) ? params.get('mode') : '', // '' = all
    station: params.get('station') || DEFAULT_STATION,
    tab: ['trains', 'board', 'alerts', 'stats'].includes(params.get('tab')) ? params.get('tab') : 'trains',
    at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(params.get('at') ?? '') ? params.get('at') : '', // planned time, '' = now
    selected: null, // trip id of the train whose journey is open
};
let statsDays = 7; // period on the Stats tab
function saveUrl() {
    const p = new URLSearchParams();
    if (state.mode) p.set('mode', state.mode);
    if (state.line) p.set('line', state.line);
    if (state.station !== DEFAULT_STATION) p.set('station', state.station);
    if (state.tab !== 'trains') p.set('tab', state.tab);
    if (state.at) p.set('at', state.at);
    history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
}

// ---------- Tabs ----------
const TABS = ['trains', 'board', 'alerts', 'stats'];
function showTab(name) {
    state.tab = name;
    for (const t of TABS) {
        $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
        $(`view-${t}`).hidden = t !== name;
    }
    // The highlight slides to the chosen tab (position 0 to 3)
    document.querySelector('.tabs').style.setProperty('--tab', TABS.indexOf(name));
    if (name === 'stats') loadStats();
    saveUrl();
}
for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => showTab(t));

// ---------- Map ----------
// The map can't be dragged far from South East Queensland; at the edge it pulls back like a rubber band
const SEQ_BOUNDS = L.latLngBounds([-28.6, 151.6], [-25.9, 154.0]);
const map = L.map('map', { zoomControl: false, maxBounds: SEQ_BOUNDS, maxBoundsViscosity: 0.6, minZoom: 8 })
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

function routeVisible(train) {
    if (state.mode && train.mode !== state.mode) return false;
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
const MODE_NOUN = { train: ['train', 'trains'], tram: ['tram', 'trams'], ferry: ['ferry', 'ferries'] };
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
            if (t.mode === 'train') existing.setStyle(markerStyle(t));
            else existing.setIcon(shapeIcon(t));
            existing.setTooltipContent(escapeHtml(tip));
        } else {
            const m = (t.mode === 'train'
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
        // Late trains first: that's what someone checking the network wants to know
        .sort((a, b) => (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) || (b.delaySec ?? 0) - (a.delaySec ?? 0));
    const noun = (n) => (state.mode ? MODE_NOUN[state.mode][n === 1 ? 0 : 1] : n === 1 ? 'service' : 'services');
    if (trains.length === 0) {
        list.innerHTML = state.line
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
          ${statusHtml(t.level, t.delayText)}
          <span class="meta">${t.mode !== 'train' ? `${t.mode === 'tram' ? 'G:link' : 'Ferry'} · ` : ''}${t.nextStop ? `Next: ${escapeHtml(t.nextStop)}` : escapeHtml(t.routeName)}</span>
        </button></li>`).join('')
        + (hidden > 0 ? `<li><button class="more-btn" type="button" data-more>Show ${hidden} more ${noun(hidden)}</button></li>` : '');
    staggerOnce(list);
    // Say what the filter did, e.g. "Showing 6 Springfield trains"
    $('filter-note').textContent = state.line
        ? `Showing ${trains.length} ${state.line} ${noun(trains.length)}` : '';
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
        const [trains, summary] = await Promise.all([getJson('/api/trains'), getJson('/api/summary')]);
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
        .map(([mode, n]) => `<b>${n}</b> ${MODE_NOUN[mode][n === 1 ? 0 : 1]}`);
    $('kpi-running').innerHTML = parts.join(' · ') || '<b>0</b> services';
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
let stations = [];
async function loadStations() {
    stations = await getJson('/api/stations');
    if (!stations.some((s) => s.id === state.station)) state.station = DEFAULT_STATION;
    $('station-list').innerHTML = stations.map((s) => `<option value="${escapeHtml(s.name)}"></option>`).join('');
    $('station-input').value = stations.find((s) => s.id === state.station)?.name ?? '';
}

function pickStation(text) {
    const typed = text.trim().toLowerCase().replace(/ station$/, '');
    const match = stations.find((s) => s.name.toLowerCase() === typed)
        ?? (typed.length >= 3 ? stations.find((s) => s.name.toLowerCase().startsWith(typed)) : null);
    const error = $('station-error');
    if (!match) {
        // Say what to do, don't blame the typing
        error.textContent = `We couldn’t find a station called “${text.trim()}”. Pick one from the list as you type.`;
        error.hidden = false;
        return;
    }
    error.hidden = true;
    $('station-input').value = match.name;
    state.station = match.id;
    delete $('board').dataset.staggered; // a new station's list settles in again
    saveUrl();
    loadBoard();
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
            <li class="${d.status === 'cancelled' ? 'cancelled' : ''}">
              <span class="time">${d.expected ? `<small>${escapeHtml(d.scheduled)}</small>${escapeHtml(d.expected)}` : escapeHtml(d.scheduled)}</span>
              <span class="dest"><span class="to" style="--c:${escapeHtml(d.color)}" title="${escapeHtml(d.routeName)}">${escapeHtml(d.headsign)}</span>
                ${d.location ? `<span class="where">${escapeHtml(d.location)}${d.minutesAway > 0 ? ` · ${d.minutesAway} min` : ''}</span>` : ''}</span>
              <span class="right">${statusHtml(d.status, d.statusText)}${d.platform ? `<span class="plat">Platform ${escapeHtml(d.platform)}</span>` : ''}</span>
            </li>`).join('');
        staggerOnce(board);
    } catch (err) {
        board.innerHTML = `<li class="empty">Departures aren’t loading right now. We’ll try again in 30 seconds.</li>`;
        console.error('Failed to load departures:', err);
    }
}
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
document.querySelector('.seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-days]');
    if (!btn) return;
    statsDays = Number(btn.dataset.days);
    for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b === btn));
    loadStats();
});

// ---------- Kind of service: All / Trains / Tram / Ferries ----------
function applyMode(mode) {
    state.mode = mode;
    for (const b of document.querySelectorAll('#mode-seg button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    // A line from another kind of service would hide everything, so drop it
    const line = lines.find((l) => l.name === state.line);
    if (mode && line && line.mode !== mode) applyLine('');
    listLimit = LIST_STEP;
    saveUrl();
    drawTrains();
    renderTrainList();
    // The G:link is on the Gold Coast, far from Brisbane: zoom the map to what is now showing
    const shown = lastTrains.filter(routeVisible).map((t) => [t.lat, t.lng]);
    if (mode && shown.length) map.flyToBounds(shown, { padding: [40, 40], maxZoom: 13, duration: reduceMotion() ? 0 : 0.8 });
}
document.querySelector('#mode-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (btn) applyMode(btn.dataset.mode);
});
for (const b of document.querySelectorAll('#mode-seg button')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
