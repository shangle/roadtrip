(() => {
  'use strict';

  const DISCOVERY_GIST_ID = '2d2eaaf5efd625d4d670877c48922751';
  const PLAYLIST_ID = 'PLO6qnlYSFTDc';
  const DEFAULT_CREW = ['Tim', 'Chris', 'Jessica', 'Nancy'];
  const DONUT_COLORS = ['#C8FF3D', '#9D7BFF', '#38BDF8', '#FB7185', '#FBBF24'];
  const LOCAL_STORAGE_KEY = 'roadtrip_hub_offline_state_v2';

  let apiBase = null;
  let eventSource = null;
  let currentUser = localStorage.getItem('roadtrip_who') || 'Tim';
  let gpsWatchId = null;
  let gpsEnabled = localStorage.getItem('roadtrip_gps_on') === '1';
  let lastGpsSentAt = 0;
  let lastGpsSentCoords = null;
  let localGeocodeCache = { at: 0, lat: null, lon: null };

  let appState = loadLocalState();

  // Map
  let map = null;
  let carMarker = null;
  let destMarker = null;
  let stopMarkersLayer = null;
  let routeLayer = null;
  let trailLayer = null;
  let hasCenteredMap = false;

  // YouTube Player
  let ytPlayer = null;
  let ytReady = false;
  let activeLoadedVideoId = null;

  function loadLocalState() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || 'null');
      if (saved) return saved;
    } catch {}
    return {
      crew: [...DEFAULT_CREW],
      trip: { title: 'The Ultimate Roadtrip', origin: null, destination: null, stops: [], route: null },
      location: {
        lat: null, lon: null, speedMph: 0, updatedAt: null, reportedBy: null,
        whereAreWe: 'Tap "Share Location" above to start',
        remainingMeters: null, remainingSec: null, progressPct: null, nextStop: null, stopEtas: {}, trail: [],
      },
      tripsplitter: { people: [...DEFAULT_CREW], transactions: [], deletedIds: [] },
      music: { playlistId: PLAYLIST_ID, playlistTitle: 'Dangerous.Business', playlistTracks: [], queue: [], nowPlayingVideoId: null },
      messages: [],
    };
  }

  function saveLocalState() {
    try { localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(appState)); } catch {}
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatDuration(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—';
    const mins = Math.max(0, Math.round(sec / 60));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function formatMiles(meters) {
    if (meters == null || !Number.isFinite(meters)) return '—';
    const mi = meters / 1609.344;
    return mi >= 10 ? `${Math.round(mi)} mi` : `${mi.toFixed(1)} mi`;
  }

  function formatEtaClock(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—';
    return new Date(Date.now() + sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatAgo(iso) {
    if (!iso) return 'Waiting for GPS update';
    const diff = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (diff < 15) return 'Updated just now';
    if (diff < 60) return `Updated ${diff}s ago`;
    if (diff < 3600) return `Updated ${Math.floor(diff / 60)}m ago`;
    return `Updated ${Math.floor(diff / 3600)}h ago`;
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // --- Navigation & Sheets ---
  function switchTab(tabName) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tabName}`));
    if (tabName === 'stops' && map) {
      setTimeout(() => map.invalidateSize(), 60);
    }
  }

  function openSheet(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  function closeAllSheets() {
    document.querySelectorAll('.sheet-backdrop').forEach((el) => el.classList.add('hidden'));
  }

  // --- API Discovery ---
  async function checkApiHealth(base) {
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(3500) });
      return res.ok;
    } catch { return false; }
  }

  async function discoverApiBase() {
    const params = new URLSearchParams(window.location.search);
    const override = params.get('api');
    if (override && /^https?:\/\//i.test(override) && (await checkApiHealth(override))) {
      return override.replace(/\/$/, '');
    }
    const host = window.location.hostname;
    if ((host === 'localhost' || host === '127.0.0.1' || host.endsWith('.trycloudflare.com')) && (await checkApiHealth(window.location.origin))) {
      return window.location.origin;
    }
    const cached = sessionStorage.getItem('roadtrip_api_base');
    if (cached && (await checkApiHealth(cached))) return cached;

    try {
      const gistRes = await fetch(`https://api.github.com/gists/${DISCOVERY_GIST_ID}?t=${Date.now()}`, { signal: AbortSignal.timeout(4500) });
      if (gistRes.ok) {
        const gist = await gistRes.json();
        const rawContent = gist.files?.['api-local.json']?.content;
        if (rawContent) {
          const parsed = JSON.parse(rawContent);
          if (parsed.apiUrl && (await checkApiHealth(parsed.apiUrl))) {
            const clean = parsed.apiUrl.replace(/\/$/, '');
            sessionStorage.setItem('roadtrip_api_base', clean);
            return clean;
          }
        }
      }
    } catch {}
    return null;
  }

  async function apiFetch(path, options = {}) {
    if (!apiBase) throw new Error('Offline');
    const res = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function setOnlineStatus(online) {
    document.getElementById('offline-dot').classList.toggle('hidden', online);
  }

  function connectSSE() {
    if (!apiBase) return;
    if (eventSource) { try { eventSource.close(); } catch {} }
    eventSource = new EventSource(`${apiBase}/api/events`);
    eventSource.addEventListener('open', () => setOnlineStatus(true));
    eventSource.addEventListener('state', (e) => {
      appState = JSON.parse(e.data);
      saveLocalState();
      renderAll();
      pushStateToTripSplitter();
    });
    eventSource.addEventListener('location', (e) => {
      appState.location = JSON.parse(e.data);
      saveLocalState();
      renderHero();
      renderStops();
      updateMap();
    });
    eventSource.addEventListener('tripsplitter', (e) => {
      appState.tripsplitter = JSON.parse(e.data);
      saveLocalState();
      renderMoneyOverview();
      updateBadges();
      pushStateToTripSplitter();
    });
    eventSource.addEventListener('music', (e) => {
      const prevNow = appState.music?.nowPlayingVideoId;
      appState.music = JSON.parse(e.data);
      saveLocalState();
      renderMusic();
      renderHomeVibe();
      updateBadges();
      if (appState.music.nowPlayingVideoId && appState.music.nowPlayingVideoId !== prevNow) {
        playVideoInEmbed(appState.music.nowPlayingVideoId);
      }
    });
    eventSource.addEventListener('messages', (e) => {
      appState.messages = JSON.parse(e.data);
      saveLocalState();
      renderMessages();
      renderHomeVibe();
      updateBadges();
    });
    eventSource.onerror = () => setOnlineStatus(false);
  }

  // --- Who Am I ---
  function renderWho() {
    const crew = appState.crew?.length ? appState.crew : DEFAULT_CREW;
    document.getElementById('who-label').textContent = currentUser;
    document.getElementById('who-avatar').textContent = currentUser.charAt(0).toUpperCase();

    const grid = document.getElementById('who-grid');
    grid.innerHTML = '';
    crew.forEach((person) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `crew-choice${person === currentUser ? ' active' : ''}`;
      btn.innerHTML = `<div class="avatar-circle" style="width:34px;height:34px;font-size:0.85rem;">${esc(person.charAt(0).toUpperCase())}</div><span>${esc(person)}</span>`;
      btn.addEventListener('click', () => {
        currentUser = person;
        localStorage.setItem('roadtrip_who', person);
        renderWho();
        renderMoneyOverview();
        renderMessages();
        closeAllSheets();
      });
      grid.appendChild(btn);
    });
  }

  // --- GPS Sharing ---
  function updateGpsButton() {
    const btn = document.getElementById('gps-toggle-btn');
    const label = document.getElementById('gps-btn-label');
    btn.classList.toggle('active', gpsEnabled);
    label.textContent = gpsEnabled ? 'Sharing GPS' : 'Share Location';
  }

  async function handleGpsPosition(pos) {
    const { latitude: lat, longitude: lon, speed, accuracy, heading } = pos.coords;
    const now = Date.now();
    const moved = lastGpsSentCoords ? haversineMeters(lastGpsSentCoords.lat, lastGpsSentCoords.lon, lat, lon) : Infinity;
    if (now - lastGpsSentAt < 10000 && moved < 250) return;
    lastGpsSentAt = now;
    lastGpsSentCoords = { lat, lon };

    if (apiBase) {
      try {
        const res = await apiFetch('/api/location', {
          method: 'POST',
          body: JSON.stringify({ lat, lon, speedMps: speed, accuracy, heading, who: currentUser }),
        });
        if (res.location) {
          appState.location = res.location;
          saveLocalState();
          renderHero();
          renderStops();
          updateMap();
        }
        return;
      } catch {}
    }

    // Standalone fallback
    appState.location.lat = lat;
    appState.location.lon = lon;
    appState.location.speedMph = Number.isFinite(speed) && speed >= 0 ? Math.round(speed * 2.23694) : 0;
    appState.location.reportedBy = currentUser;
    appState.location.updatedAt = new Date().toISOString();

    const movedGeo = localGeocodeCache.lat == null ? Infinity : haversineMeters(localGeocodeCache.lat, localGeocodeCache.lon, lat, lon);
    if (now - localGeocodeCache.at > 45000 || movedGeo > 1500) {
      localGeocodeCache = { at: now, lat, lon };
      try {
        const b = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`).then((r) => r.json());
        const rawCity = b.city || b.locality;
        const city = rawCity ? rawCity.replace(/^(Charter\s+)?Township\s+of\s+/i, '').replace(/^(City|Village|Town)\s+of\s+/i, '').trim() : null;
        const reg = b.principalSubdivisionCode ? b.principalSubdivisionCode.replace(/^US-/, '') : b.principalSubdivision;
        appState.location.whereAreWe = city ? `Near ${city}${reg ? ', ' + reg : ''}` : `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
      } catch {}
      if (appState.trip.destination) await computeOfflineEta(lat, lon);
    }
    saveLocalState();
    renderHero();
    updateMap();
  }

  async function computeOfflineEta(lat, lon) {
    try {
      const activeStops = (appState.trip.stops || []).filter((s) => !s.reached);
      const pts = [{ lat, lon }, ...activeStops, appState.trip.destination];
      const coordStr = pts.map((p) => `${p.lon},${p.lat}`).join(';');
      const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`).then((x) => x.json());
      const route = r.routes?.[0];
      if (route) {
        appState.location.remainingMeters = Math.round(route.distance);
        appState.location.remainingSec = Math.round(route.duration);
        appState.trip.route = { totalMeters: route.distance, totalSec: route.duration, geometry: route.geometry?.coordinates || [] };
      }
    } catch {}
  }

  function startGps() {
    if (!('geolocation' in navigator)) {
      alert('Location is not supported in this browser.');
      return;
    }
    gpsEnabled = true;
    localStorage.setItem('roadtrip_gps_on', '1');
    updateGpsButton();
    if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = navigator.geolocation.watchPosition(
      handleGpsPosition,
      (err) => {
        if (err.code === 1) {
          gpsEnabled = false;
          localStorage.setItem('roadtrip_gps_on', '0');
          updateGpsButton();
          alert('Please allow location access in your browser so everyone can see where we are.');
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  function stopGps() {
    gpsEnabled = false;
    localStorage.setItem('roadtrip_gps_on', '0');
    updateGpsButton();
    if (gpsWatchId != null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
  }

  // --- Place Search & Route ---
  async function searchPlaces(query, nearby = false) {
    if (!query.trim()) return [];
    const lat = appState.location?.lat;
    const lon = appState.location?.lon;
    if (apiBase) {
      try {
        const qs = new URLSearchParams({ q: query });
        if (lat != null && lon != null) { qs.set('lat', String(lat)); qs.set('lon', String(lon)); }
        if (nearby) qs.set('nearby', '1');
        const data = await apiFetch(`/api/geo/search?${qs.toString()}`);
        return data.results || [];
      } catch {}
    }
    let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6`;
    if (lat != null && lon != null) url += `&lat=${lat}&lon=${lon}`;
    const data = await fetch(url).then((r) => r.json());
    return (data.features || []).map((f) => {
      const p = f.properties || {};
      const parts = [p.name, p.city || p.town || p.village, p.state].filter(Boolean);
      const dedup = parts.filter((v, i) => parts.indexOf(v) === i);
      const rLat = f.geometry.coordinates[1];
      const rLon = f.geometry.coordinates[0];
      return {
        name: p.name || dedup[0] || query,
        label: dedup.join(', '),
        lat: rLat,
        lon: rLon,
        distanceMeters: lat != null ? Math.round(haversineMeters(lat, lon, rLat, rLon)) : null,
      };
    });
  }

  function renderPlaceSearchResults(containerId, results, actionLabel, onPick) {
    const box = document.getElementById(containerId);
    box.innerHTML = '';
    if (!results.length) {
      box.innerHTML = `<div style="padding:12px 14px;" class="muted">No places found nearby. Try another search.</div>`;
      box.classList.remove('hidden');
      return;
    }
    results.forEach((r) => {
      const distStr = r.distanceMeters != null ? ` • ${formatMiles(r.distanceMeters)} away` : '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-item';
      btn.innerHTML = `<div style="min-width:0;"><div style="font-weight:700;font-size:0.9rem;">${esc(r.name)}</div><div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.label)}${esc(distStr)}</div></div><span class="btn btn-sm btn-lime">${esc(actionLabel)}</span>`;
      btn.addEventListener('click', () => {
        box.classList.add('hidden');
        onPick(r);
      });
      box.appendChild(btn);
    });
    box.classList.remove('hidden');
  }

  async function sendRouteAction(payload) {
    if (apiBase) {
      try {
        const res = await apiFetch('/api/route', { method: 'POST', body: JSON.stringify(payload) });
        if (res.trip) appState.trip = res.trip;
        if (res.location) appState.location = res.location;
        saveLocalState();
        renderAll();
        return;
      } catch {}
    }
    if (payload.action === 'setDestination') appState.trip.destination = payload.place;
    if (payload.action === 'addStop') appState.trip.stops.push({ ...payload.place, id: String(Date.now()), addedBy: currentUser, reached: false });
    if (payload.action === 'removeStop') appState.trip.stops = appState.trip.stops.filter((s) => s.id !== payload.stopId);
    if (payload.action === 'toggleStop') appState.trip.stops = appState.trip.stops.map((s) => (s.id === payload.stopId ? { ...s, reached: !s.reached } : s));
    if (appState.location.lat != null && appState.trip.destination) await computeOfflineEta(appState.location.lat, appState.location.lon);
    saveLocalState();
    renderAll();
  }

  // --- Rendering ---
  function renderHero() {
    const loc = appState.location || {};
    const dest = appState.trip?.destination;
    document.getElementById('hero-dest-eyebrow').textContent = dest ? `TO ${String(dest.name).toUpperCase()}` : 'SET A DESTINATION';

    const timeEl = document.getElementById('hero-time-left');
    if (loc.remainingSec != null) {
      timeEl.innerHTML = `${esc(formatDuration(loc.remainingSec))}<span class="unit">left</span>`;
    } else {
      timeEl.innerHTML = `—`;
    }
    document.getElementById('hero-eta-badge').textContent = loc.remainingSec != null ? `Arriving ${formatEtaClock(loc.remainingSec)}` : 'No ETA yet';
    document.getElementById('hero-where').textContent = loc.whereAreWe || 'Tap "Share Location" above to start';
    document.getElementById('hero-updated').textContent = `${formatAgo(loc.updatedAt)}${loc.reportedBy ? ' • ' + loc.reportedBy : ''}`;
    document.getElementById('progress-fill').style.width = `${loc.progressPct ?? 0}%`;

    document.getElementById('m-miles-left').textContent = formatMiles(loc.remainingMeters);
    document.getElementById('m-speed').textContent = loc.lat != null ? `${loc.speedMph ?? 0} mph` : '—';
    document.getElementById('m-next-stop').textContent = loc.nextStop
      ? `${loc.nextStop.name} (${formatDuration(loc.nextStop.remainingSec)})`
      : (dest ? dest.name : 'None');
  }

  function renderMoneyOverview() {
    const ts = appState.tripsplitter || { people: DEFAULT_CREW, transactions: [] };
    const people = ts.people?.length ? ts.people : DEFAULT_CREW;
    const txs = ts.transactions || [];
    let total = 0;
    const stats = {};
    people.forEach((p) => { stats[p] = { paid: 0, sent: 0, received: 0 }; });

    txs.forEach((t) => {
      if (t.type === 'expense') {
        total += Number(t.amount || 0);
        if (stats[t.payer]) stats[t.payer].paid += Number(t.amount || 0);
      } else if (t.type === 'payment') {
        if (stats[t.payer]) stats[t.payer].sent += Number(t.amount || 0);
        if (stats[t.payee]) stats[t.payee].received += Number(t.amount || 0);
      }
    });

    document.getElementById('home-total-spent').textContent = `$${total.toFixed(2)}`;
    const share = people.length ? total / people.length : 0;
    const my = stats[currentUser] || { paid: 0, sent: 0, received: 0 };
    const net = (my.paid - share) + (my.sent - my.received);
    const badge = document.getElementById('home-my-balance');
    if (net >= 0.5) {
      badge.className = 'balance-badge pos';
      badge.textContent = `${currentUser} gets back $${net.toFixed(0)}`;
    } else if (net <= -0.5) {
      badge.className = 'balance-badge neg';
      badge.textContent = `${currentUser} owes $${Math.abs(net).toFixed(0)}`;
    } else {
      badge.className = 'balance-badge even';
      badge.textContent = `${currentUser} is all even`;
    }

    // Mini Donut
    const svg = document.getElementById('home-donut');
    const r = 38;
    const circ = 2 * Math.PI * r;
    if (total <= 0) {
      svg.innerHTML = `<circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="12" />`;
      return;
    }
    let offset = 0;
    let markup = `<circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="12" />`;
    people.forEach((p, idx) => {
      const paid = stats[p]?.paid || 0;
      if (paid <= 0) return;
      const dash = (paid / total) * circ;
      markup += `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${DONUT_COLORS[idx % DONUT_COLORS.length]}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${Math.max(2, dash - 2)} ${circ}" stroke-dashoffset="${-offset}" />`;
      offset += dash;
    });
    svg.innerHTML = markup;
  }

  function renderHomeVibe() {
    const queue = (appState.music?.queue || []).filter((q) => !q.played);
    if (queue.length > 0) {
      document.getElementById('home-music-title').textContent = `Up Next: ${queue[0].title}`;
      document.getElementById('home-music-sub').textContent = `Requested by ${queue[0].addedBy} • ${queue.length} in queue`;
    } else {
      const count = appState.music?.playlistTracks?.length || 0;
      document.getElementById('home-music-title').textContent = appState.music?.playlistTitle || 'Dangerous.Business Playlist';
      document.getElementById('home-music-sub').textContent = count ? `${count} songs on YouTube Music • Tap to open` : 'Tap to open in YouTube Music';
    }

    const box = document.getElementById('home-latest-msgs');
    const recent = (appState.messages || []).slice(-2);
    if (!recent.length) {
      box.innerHTML = `<div class="muted" style="text-align:center; padding:4px 0;">No car notes yet — tap Note above to say hi!</div>`;
      return;
    }
    box.innerHTML = recent.map((m) => `
      <div class="msg-bubble" style="margin-bottom:6px;">
        <div class="msg-top"><span class="msg-author">${esc(m.author)}</span><span>${m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</span></div>
        <div style="font-size:0.88rem;">${esc(m.text)}</div>
      </div>`).join('');
  }

  function renderStops() {
    const dest = appState.trip?.destination;
    const stops = appState.trip?.stops || [];
    const loc = appState.location || {};

    const gmaps = document.getElementById('gmaps-route-link');
    const waze = document.getElementById('waze-next-link');
    const activeStops = stops.filter((s) => !s.reached);

    if (dest) {
      const params = new URLSearchParams({ api: '1', destination: `${dest.lat},${dest.lon}`, travelmode: 'driving' });
      if (loc.lat != null) params.set('origin', `${loc.lat},${loc.lon}`);
      if (activeStops.length) params.set('waypoints', activeStops.map((s) => `${s.lat},${s.lon}`).join('|'));
      gmaps.href = `https://www.google.com/maps/dir/?${params.toString()}`;
      gmaps.classList.remove('hidden');

      const nextTarget = activeStops[0] || dest;
      waze.href = `https://waze.com/ul?ll=${nextTarget.lat},${nextTarget.lon}&navigate=yes`;
      waze.classList.remove('hidden');
    } else {
      gmaps.classList.add('hidden');
      waze.classList.add('hidden');
    }

    const list = document.getElementById('stops-list');
    list.innerHTML = '';

    if (!stops.length && !dest) {
      list.innerHTML = `<p class="muted" style="text-align:center; padding:8px 0;">Set a destination on Home or pick a quick pit stop above.</p>`;
      return;
    }

    stops.forEach((s, idx) => {
      const eta = loc.stopEtas?.[s.id];
      const etaStr = !s.reached && eta ? `${formatDuration(eta.remainingSec)} • ${formatMiles(eta.remainingMeters)}` : (s.reached ? 'Visited' : '');
      const row = document.createElement('div');
      row.className = `stop-row${s.reached ? ' reached' : ''}`;
      row.innerHTML = `
        <div style="min-width:0; flex:1;">
          <div class="stop-name" style="font-weight:700; font-size:0.9rem;">${idx + 1}. ${esc(s.name)}</div>
          <div class="muted">${esc(s.addedBy)}${etaStr ? ' • ' + esc(etaStr) : ''}</div>
        </div>
        <div style="display:flex; gap:5px; flex-shrink:0;">
          <button class="btn btn-sm toggle-stop-btn">${s.reached ? 'Undo' : 'Done'}</button>
          <button class="btn btn-sm del-stop-btn" style="color:var(--coral);">✕</button>
        </div>`;
      row.querySelector('.toggle-stop-btn').addEventListener('click', () => sendRouteAction({ action: 'toggleStop', stopId: s.id }));
      row.querySelector('.del-stop-btn').addEventListener('click', () => {
        if (confirm(`Remove stop "${s.name}"?`)) sendRouteAction({ action: 'removeStop', stopId: s.id });
      });
      list.appendChild(row);
    });

    if (dest) {
      const destRow = document.createElement('div');
      destRow.className = 'stop-row';
      destRow.style.borderColor = 'rgba(200,255,61,0.35)';
      destRow.innerHTML = `
        <div style="min-width:0; flex:1;">
          <div style="font-weight:800; font-size:0.92rem; color:var(--lime);">🏁 ${esc(dest.name)}</div>
          <div class="muted">${esc(dest.label || '')}${loc.remainingSec != null ? ' • ' + formatDuration(loc.remainingSec) + ' left' : ''}</div>
        </div>
        <button class="subtle-pill-btn edit-dest-inline" type="button">Edit</button>`;
      destRow.querySelector('.edit-dest-inline').addEventListener('click', () => openSheet('sheet-dest'));
      list.appendChild(destRow);
    }
  }

  function initMap() {
    if (map) return;
    map = L.map('map', { zoomControl: false }).setView([43.156, -85.710], 7);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(map);
    stopMarkersLayer = L.layerGroup().addTo(map);
    routeLayer = L.polyline([], { color: '#9D7BFF', weight: 4, opacity: 0.85 }).addTo(map);
    trailLayer = L.polyline([], { color: '#C8FF3D', weight: 4, opacity: 0.9, dashArray: '5 6' }).addTo(map);
  }

  function updateMap() {
    if (!map) return;
    const loc = appState.location || {};
    const dest = appState.trip?.destination;
    const stops = appState.trip?.stops || [];
    const geom = appState.trip?.route?.geometry || [];

    routeLayer.setLatLngs(geom.length ? geom.map(([lon, lat]) => [lat, lon]) : []);
    trailLayer.setLatLngs((loc.trail || []).map((p) => [p.lat, p.lon]));

    stopMarkersLayer.clearLayers();
    stops.forEach((s, i) => {
      L.circleMarker([s.lat, s.lon], {
        radius: 7,
        color: '#0A0B0F',
        fillColor: s.reached ? '#64748B' : '#FBBF24',
        fillOpacity: 1,
        weight: 2,
      }).bindPopup(`<b>Stop ${i + 1}: ${esc(s.name)}</b>`).addTo(stopMarkersLayer);
    });

    if (dest) {
      if (!destMarker) {
        destMarker = L.circleMarker([dest.lat, dest.lon], { radius: 8, color: '#0A0B0F', fillColor: '#FB7185', fillOpacity: 1, weight: 2 }).addTo(map);
      } else {
        destMarker.setLatLng([dest.lat, dest.lon]);
      }
      destMarker.bindPopup(`<b>${esc(dest.name)}</b>`);
    } else if (destMarker) {
      map.removeLayer(destMarker);
      destMarker = null;
    }

    if (loc.lat != null && loc.lon != null) {
      if (!carMarker) {
        carMarker = L.circleMarker([loc.lat, loc.lon], { radius: 9, color: '#0A0B0F', fillColor: '#C8FF3D', fillOpacity: 1, weight: 3 }).addTo(map);
      } else {
        carMarker.setLatLng([loc.lat, loc.lon]);
      }
      carMarker.bindPopup(`<b>Our Car</b><br>${esc(loc.whereAreWe || '')}`);
      if (!hasCenteredMap) {
        hasCenteredMap = true;
        map.setView([loc.lat, loc.lon], 9);
      }
    }
  }

  // --- TripSplitter Sync ---
  function pushStateToTripSplitter() {
    const iframe = document.getElementById('ts-iframe');
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({ type: 'tripsplitter:remote', state: appState.tripsplitter }, window.location.origin);
  }

  window.addEventListener('message', async (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'tripsplitter:ready') {
      pushStateToTripSplitter();
    } else if (event.data?.type === 'tripsplitter:changed') {
      const payload = {
        people: event.data.state?.people || DEFAULT_CREW,
        transactions: event.data.state?.transactions || [],
        deletedIds: event.data.deletedIds || [],
        forcePeopleReplace: !!event.data.forcePeopleReplace,
      };
      if (apiBase) {
        try {
          appState.tripsplitter = await apiFetch('/api/tripsplitter/sync', { method: 'POST', body: JSON.stringify(payload) });
          saveLocalState();
          renderMoneyOverview();
          updateBadges();
          return;
        } catch {}
      }
      appState.tripsplitter = { ...payload };
      saveLocalState();
      renderMoneyOverview();
      updateBadges();
    }
  });

  // --- YouTube Music & Queue ---
  window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player('yt-player-mount', {
      playerVars: { listType: 'playlist', list: PLAYLIST_ID, rel: 0 },
      events: {
        onReady: () => {
          ytReady = true;
          if (appState.music?.nowPlayingVideoId) playVideoInEmbed(appState.music.nowPlayingVideoId);
        },
        onStateChange: (ev) => {
          if (ev.data === YT.PlayerState.ENDED) playNextQueuedSong();
        },
      },
    });
  };

  function playVideoInEmbed(videoId, labelText) {
    if (!ytReady || !ytPlayer || activeLoadedVideoId === videoId) return;
    activeLoadedVideoId = videoId;
    ytPlayer.loadVideoById(videoId);
    document.getElementById('now-playing-label').textContent = labelText || 'Playing requested song';
  }

  function playOfficialPlaylist() {
    activeLoadedVideoId = null;
    if (ytReady && ytPlayer) ytPlayer.loadPlaylist({ listType: 'playlist', list: PLAYLIST_ID });
    document.getElementById('now-playing-label').textContent = `Playing ${appState.music?.playlistTitle || 'Dangerous.Business'} playlist`;
  }

  async function playNextQueuedSong() {
    const next = (appState.music?.queue || []).find((q) => !q.played);
    if (!next) return;
    await musicQueueAction({ action: 'play', queueId: next.id, videoId: next.videoId });
    playVideoInEmbed(next.videoId, `Playing: ${next.title}`);
  }

  async function musicQueueAction(payload) {
    if (apiBase) {
      try {
        appState.music = await apiFetch('/api/music/queue', { method: 'POST', body: JSON.stringify(payload) });
        saveLocalState();
        renderMusic();
        renderHomeVibe();
        updateBadges();
        return;
      } catch {}
    }
    if (payload.action === 'add' && payload.track) {
      appState.music.queue.push({ id: String(Date.now()), ...payload.track, addedBy: payload.addedBy || currentUser, note: payload.note || '', votes: [currentUser], played: false });
    } else if (payload.action === 'play') {
      appState.music.nowPlayingVideoId = payload.videoId;
      appState.music.queue.forEach((q) => { if (q.id === payload.queueId) q.played = true; });
    }
    saveLocalState();
    renderMusic();
    renderHomeVibe();
    updateBadges();
  }

  async function runMusicSearch(inputEl, noteVal, boxEl) {
    const q = inputEl.value.trim();
    if (!q) return;
    if (!apiBase) {
      boxEl.innerHTML = `<div style="padding:12px;" class="muted">Offline right now — tap <strong>+ Collaborate</strong> to add directly in YouTube Music.</div>`;
      boxEl.classList.remove('hidden');
      return;
    }
    const data = await apiFetch(`/api/music/search?q=${encodeURIComponent(q)}`);
    const results = data.results || [];
    boxEl.innerHTML = '';
    if (!results.length) {
      boxEl.innerHTML = `<div style="padding:12px;" class="muted">No songs found. Try another title or paste a YouTube link.</div>`;
      boxEl.classList.remove('hidden');
      return;
    }
    results.forEach((t) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-item';
      btn.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;min-width:0;">
          <img class="track-thumb" src="${esc(t.thumbnail)}" alt="">
          <div style="min-width:0;">
            <div class="track-title">${esc(t.title)}</div>
            <div class="track-meta">${esc(t.channel)}${t.duration ? ' • ' + esc(t.duration) : ''}</div>
          </div>
        </div>
        <span class="btn btn-sm btn-lime">+ Add</span>`;
      btn.addEventListener('click', async () => {
        inputEl.value = '';
        boxEl.classList.add('hidden');
        await musicQueueAction({ action: 'add', track: t, addedBy: currentUser, note: noteVal });
        closeAllSheets();
      });
      boxEl.appendChild(btn);
    });
    boxEl.classList.remove('hidden');
  }

  function renderMusic() {
    const qList = document.getElementById('music-queue-list');
    const queue = appState.music?.queue || [];
    qList.innerHTML = '';
    if (!queue.length) {
      qList.innerHTML = `<p class="muted" style="text-align:center; padding:6px 0;">No songs requested yet — search above to add one!</p>`;
    } else {
      const sorted = [...queue].sort((a, b) => Number(a.played) - Number(b.played) || (b.votes?.length || 0) - (a.votes?.length || 0));
      sorted.forEach((q) => {
        const voted = (q.votes || []).includes(currentUser);
        const row = document.createElement('div');
        row.className = 'track-row';
        if (q.played) row.style.opacity = '0.5';
        row.innerHTML = `
          <img class="track-thumb" src="${esc(q.thumbnail)}" alt="">
          <div class="track-info">
            <div class="track-title">${esc(q.title)}</div>
            <div class="track-meta">${esc(q.addedBy)}${q.note ? ' — "' + esc(q.note) + '"' : ''}</div>
          </div>
          <div style="display:flex; gap:5px; flex-shrink:0;">
            <button class="btn btn-sm btn-lime play-q-btn">Play</button>
            <button class="btn btn-sm vote-q-btn" style="${voted ? 'border-color:var(--lime);color:var(--lime);' : ''}">👍 ${(q.votes || []).length}</button>
          </div>`;
        row.querySelector('.play-q-btn').addEventListener('click', () => {
          musicQueueAction({ action: 'play', queueId: q.id, videoId: q.videoId });
          playVideoInEmbed(q.videoId, `Playing: ${q.title}`);
        });
        row.querySelector('.vote-q-btn').addEventListener('click', () => {
          musicQueueAction({ action: 'vote', queueId: q.id, who: currentUser });
        });
        qList.appendChild(row);
      });
    }

    const pList = document.getElementById('playlist-tracks-list');
    const tracks = appState.music?.playlistTracks || [];
    pList.innerHTML = tracks.length
      ? ''
      : `<p class="muted">Open YouTube Music above to play or edit the playlist.</p>`;
    tracks.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'track-row';
      row.innerHTML = `
        <img class="track-thumb" src="${esc(t.thumbnail)}" alt="">
        <div class="track-info">
          <div class="track-title">${i + 1}. ${esc(t.title)}</div>
          <div class="track-meta">${esc(t.channel)}${t.duration ? ' • ' + esc(t.duration) : ''}</div>
        </div>
        <button class="btn btn-sm play-pl-btn">Play</button>`;
      row.querySelector('.play-pl-btn').addEventListener('click', () => playVideoInEmbed(t.videoId, `Playing: ${t.title}`));
      pList.appendChild(row);
    });
  }

  // --- Messages ---
  async function postMessage(text) {
    if (!text.trim()) return;
    if (apiBase) {
      try {
        const res = await apiFetch('/api/messages', { method: 'POST', body: JSON.stringify({ author: currentUser, text: text.trim() }) });
        if (res.messages) appState.messages = res.messages;
        saveLocalState();
        renderMessages();
        renderHomeVibe();
        updateBadges();
        return;
      } catch {}
    }
    appState.messages.push({ id: String(Date.now()), author: currentUser, text: text.trim(), placeSnapshot: appState.location?.whereAreWe || null, createdAt: new Date().toISOString(), reactions: {} });
    saveLocalState();
    renderMessages();
    renderHomeVibe();
    updateBadges();
  }

  async function reactMessage(messageId, emoji) {
    if (!apiBase) return;
    try {
      const res = await apiFetch('/api/messages', { method: 'POST', body: JSON.stringify({ action: 'react', messageId, emoji, who: currentUser }) });
      if (res.messages) appState.messages = res.messages;
      renderMessages();
    } catch {}
  }

  function renderMessages() {
    const list = document.getElementById('msg-list');
    const msgs = appState.messages || [];
    list.innerHTML = '';
    if (!msgs.length) {
      list.innerHTML = `<p class="muted" style="text-align:center; padding:14px 0;">No messages yet — say hi to the car!</p>`;
      return;
    }
    msgs.forEach((m) => {
      const mine = m.author === currentUser;
      const bubble = document.createElement('div');
      bubble.className = `msg-bubble${mine ? ' mine' : ''}`;
      const timeStr = m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      bubble.innerHTML = `
        <div class="msg-top"><span class="msg-author">${esc(m.author)}</span><span>${esc(timeStr)}</span></div>
        <div style="font-size:0.9rem;">${esc(m.text)}</div>
        ${m.placeSnapshot ? `<div class="msg-loc">📍 ${esc(m.placeSnapshot)}</div>` : ''}
        <div class="react-row"></div>`;
      const row = bubble.querySelector('.react-row');
      ['🔥', '😂', '👍', '☕'].forEach((emoji) => {
        const users = m.reactions?.[emoji] || [];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `react-btn${users.includes(currentUser) ? ' active' : ''}`;
        btn.textContent = users.length ? `${emoji} ${users.length}` : emoji;
        btn.addEventListener('click', () => reactMessage(m.id, emoji));
        row.appendChild(btn);
      });
      list.appendChild(bubble);
    });
    list.scrollTop = list.scrollHeight;
  }

  function updateBadges() {
    const setBadge = (id, num) => {
      const el = document.getElementById(id);
      el.textContent = String(num);
      el.classList.toggle('hidden', num <= 0);
    };
    setBadge('badge-stops', (appState.trip?.stops || []).filter((s) => !s.reached).length);
    setBadge('badge-tx', (appState.tripsplitter?.transactions || []).length);
    const vibeCount = (appState.music?.queue || []).filter((q) => !q.played).length + (appState.messages || []).length;
    setBadge('badge-vibe', vibeCount);
  }

  function renderAll() {
    renderWho();
    renderHero();
    renderMoneyOverview();
    renderHomeVibe();
    renderStops();
    updateMap();
    renderMusic();
    renderMessages();
    updateBadges();
  }

  // --- Wire Events ---
  function bindEvents() {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.getElementById('home-goto-split').addEventListener('click', () => switchTab('split'));
    document.getElementById('home-goto-vibe').addEventListener('click', () => switchTab('vibe'));
    document.getElementById('who-picker-btn').addEventListener('click', () => openSheet('sheet-who'));
    document.getElementById('open-dest-sheet-btn').addEventListener('click', () => openSheet('sheet-dest'));

    // Quick Action Circles
    document.getElementById('qa-stop-btn').addEventListener('click', () => openSheet('sheet-stop'));
    document.getElementById('stops-search-open-btn').addEventListener('click', () => openSheet('sheet-stop'));
    document.getElementById('qa-cost-btn').addEventListener('click', () => {
      switchTab('split');
      const iframe = document.getElementById('ts-iframe');
      setTimeout(() => {
        iframe?.contentWindow?.postMessage({ type: 'tripsplitter:openModal', modal: 'expense' }, window.location.origin);
      }, 120);
    });
    document.getElementById('qa-song-btn').addEventListener('click', () => openSheet('sheet-song'));
    document.getElementById('qa-msg-btn').addEventListener('click', () => openSheet('sheet-msg'));

    // Close sheets
    document.querySelectorAll('.close-sheet-btn').forEach((b) => b.addEventListener('click', closeAllSheets));
    document.querySelectorAll('.sheet-backdrop').forEach((bd) => {
      bd.addEventListener('click', (e) => { if (e.target === bd) closeAllSheets(); });
    });

    document.getElementById('gps-toggle-btn').addEventListener('click', () => {
      if (gpsEnabled) stopGps(); else startGps();
    });

    // Destination Search Sheet
    const runDestSearch = async () => {
      const q = document.getElementById('sheet-dest-input').value;
      const results = await searchPlaces(q, false);
      renderPlaceSearchResults('sheet-dest-results', results, 'Set', (place) => {
        closeAllSheets();
        sendRouteAction({ action: 'setDestination', place });
      });
    };
    document.getElementById('sheet-dest-btn').addEventListener('click', runDestSearch);
    document.getElementById('sheet-dest-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runDestSearch(); } });

    // Stop Search Sheet + Stops Tab Quick Chips
    const runStopSearch = async (query, nearby, targetBoxId) => {
      const results = await searchPlaces(query, nearby);
      renderPlaceSearchResults(targetBoxId, results, 'Add', (place) => {
        document.getElementById('sheet-stop-input').value = '';
        closeAllSheets();
        sendRouteAction({ action: 'addStop', place, addedBy: currentUser });
      });
    };
    document.getElementById('sheet-stop-btn').addEventListener('click', () => runStopSearch(document.getElementById('sheet-stop-input').value, false, 'sheet-stop-results'));
    document.getElementById('sheet-stop-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runStopSearch(document.getElementById('sheet-stop-input').value, false, 'sheet-stop-results'); }
    });
    document.querySelectorAll('.sheet-pit-chip').forEach((c) => {
      c.addEventListener('click', () => runStopSearch(c.dataset.q, true, 'sheet-stop-results'));
    });
    document.querySelectorAll('.quick-stop-chip').forEach((c) => {
      c.addEventListener('click', () => runStopSearch(c.dataset.q, true, 'stops-tab-results'));
    });

    document.getElementById('center-map-btn').addEventListener('click', () => {
      if (map && appState.location?.lat != null) map.setView([appState.location.lat, appState.location.lon], 11);
    });

    // Music Searches (Tab + Sheet)
    document.getElementById('play-playlist-btn').addEventListener('click', playOfficialPlaylist);
    document.getElementById('music-search-btn').addEventListener('click', () => {
      runMusicSearch(document.getElementById('music-search-input'), '', document.getElementById('music-search-results'));
    });
    document.getElementById('music-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runMusicSearch(document.getElementById('music-search-input'), '', document.getElementById('music-search-results')); }
    });
    document.getElementById('sheet-song-btn').addEventListener('click', () => {
      runMusicSearch(document.getElementById('sheet-song-input'), document.getElementById('sheet-song-note').value.trim(), document.getElementById('sheet-song-results'));
    });
    document.getElementById('sheet-song-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runMusicSearch(document.getElementById('sheet-song-input'), document.getElementById('sheet-song-note').value.trim(), document.getElementById('sheet-song-results'));
      }
    });

    // Chat (Tab + Sheet)
    document.getElementById('msg-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('msg-input');
      const text = input.value; input.value = '';
      postMessage(text);
    });
    document.querySelectorAll('.quick-msg-chip').forEach((c) => c.addEventListener('click', () => postMessage(c.textContent)));
    document.getElementById('sheet-msg-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('sheet-msg-input');
      const text = input.value; input.value = '';
      closeAllSheets();
      postMessage(text);
    });
    document.querySelectorAll('.sheet-quick-msg').forEach((c) => {
      c.addEventListener('click', () => { closeAllSheets(); postMessage(c.textContent); });
    });
  }

  async function init() {
    initMap();
    bindEvents();
    updateGpsButton();
    renderAll();

    const ytScript = document.createElement('script');
    ytScript.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(ytScript);

    apiBase = await discoverApiBase();
    if (apiBase) {
      setOnlineStatus(true);
      try {
        appState = await apiFetch('/api/state');
        saveLocalState();
        renderAll();
        pushStateToTripSplitter();
      } catch {}
      connectSSE();
    } else {
      setOnlineStatus(false);
    }

    if (gpsEnabled) startGps();

    setInterval(() => {
      if (appState.location?.updatedAt) {
        document.getElementById('hero-updated').textContent = `${formatAgo(appState.location.updatedAt)}${appState.location.reportedBy ? ' • ' + appState.location.reportedBy : ''}`;
      }
    }, 10000);
  }

  init();
})();
