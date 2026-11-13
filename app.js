(() => {
  'use strict';

  const DISCOVERY_GIST_ID = '2d2eaaf5efd625d4d670877c48922751';
  const PLAYLIST_ID = 'PLO6qnlYSFTDc';
  const DEFAULT_CREW = ['Tim', 'Chris', 'Jessica', 'Nancy'];
  const LOCAL_STORAGE_KEY = 'roadtrip_hub_offline_state_v1';

  let apiBase = null;
  let eventSource = null;
  let currentUser = localStorage.getItem('roadtrip_who') || 'Tim';
  let gpsWatchId = null;
  let gpsEnabled = localStorage.getItem('roadtrip_gps_on') === '1';
  let lastGpsSentAt = 0;
  let lastGpsSentCoords = null;
  let localGeocodeCache = { at: 0, lat: null, lon: null };

  let appState = loadLocalState();

  // Map state
  let map = null;
  let carMarker = null;
  let destMarker = null;
  let stopMarkersLayer = null;
  let routeLayer = null;
  let trailLayer = null;
  let hasCenteredMap = false;

  // YouTube Player state
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
        lat: null,
        lon: null,
        speedMph: 0,
        updatedAt: null,
        reportedBy: null,
        whereAreWe: 'Tap "Share GPS" to start tracking',
        remainingMeters: null,
        remainingSec: null,
        progressPct: null,
        nextStop: null,
        stopEtas: {},
        trail: [],
      },
      tripsplitter: { people: [...DEFAULT_CREW], transactions: [], deletedIds: [] },
      music: {
        playlistId: PLAYLIST_ID,
        playlistTitle: 'The Ultimate Roadtrip',
        playlistTracks: [],
        queue: [],
        nowPlayingVideoId: null,
      },
      messages: [],
    };
  }

  function saveLocalState() {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(appState));
    } catch {}
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
    const arrival = new Date(Date.now() + sec * 1000);
    return arrival.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatAgo(iso) {
    if (!iso) return 'No ping yet';
    const diff = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (diff < 15) return 'Just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // --- API Discovery & Connection ---
  async function checkApiHealth(base) {
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/api/health`, {
        signal: AbortSignal.timeout(3500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function discoverApiBase() {
    const params = new URLSearchParams(window.location.search);
    const override = params.get('api');
    if (override && /^https?:\/\//i.test(override)) {
      if (await checkApiHealth(override)) return override.replace(/\/$/, '');
    }

    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.trycloudflare.com')) {
      if (await checkApiHealth(window.location.origin)) return window.location.origin;
    }

    // Check cached discovered tunnel URL first
    const cached = sessionStorage.getItem('roadtrip_api_base');
    if (cached && (await checkApiHealth(cached))) return cached;

    // Fetch live tunnel URL from discovery Gist
    try {
      const gistRes = await fetch(`https://api.github.com/gists/${DISCOVERY_GIST_ID}?t=${Date.now()}`, {
        signal: AbortSignal.timeout(4500),
      });
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

  function setSyncPill(isLive, label) {
    const pill = document.getElementById('sync-status-pill');
    const txt = document.getElementById('sync-status-text');
    pill.classList.toggle('live', isLive);
    txt.textContent = label;
  }

  async function apiFetch(path, options = {}) {
    if (!apiBase) throw new Error('Offline mode');
    const res = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function connectSSE() {
    if (!apiBase) return;
    if (eventSource) {
      try { eventSource.close(); } catch {}
    }
    eventSource = new EventSource(`${apiBase}/api/events`);

    eventSource.addEventListener('open', () => {
      setSyncPill(true, 'Laptop Live Sync');
    });

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
      updateBadges();
      pushStateToTripSplitter();
    });

    eventSource.addEventListener('music', (e) => {
      const prevNow = appState.music?.nowPlayingVideoId;
      appState.music = JSON.parse(e.data);
      saveLocalState();
      renderMusic();
      if (appState.music.nowPlayingVideoId && appState.music.nowPlayingVideoId !== prevNow) {
        playVideoInEmbed(appState.music.nowPlayingVideoId);
      }
    });

    eventSource.addEventListener('messages', (e) => {
      appState.messages = JSON.parse(e.data);
      saveLocalState();
      renderMessages();
    });

    eventSource.onerror = () => {
      setSyncPill(false, 'Reconnecting...');
    };
  }

  // --- Crew Selection ---
  function renderCrewPills() {
    const crew = appState.crew?.length ? appState.crew : DEFAULT_CREW;
    const container = document.getElementById('crew-pills');
    container.innerHTML = '';
    for (const person of crew) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `crew-pill${person === currentUser ? ' active' : ''}`;
      btn.textContent = person;
      btn.addEventListener('click', () => {
        currentUser = person;
        localStorage.setItem('roadtrip_who', person);
        renderCrewPills();
        renderMessages();
      });
      container.appendChild(btn);
    }
  }

  // --- GPS Sharing ---
  function updateGpsButton() {
    const btn = document.getElementById('gps-toggle-btn');
    const label = document.getElementById('gps-btn-label');
    btn.classList.toggle('active', gpsEnabled);
    label.textContent = gpsEnabled ? '📡 Sharing GPS' : '📍 Share GPS';
  }

  async function handleGpsPosition(pos) {
    const { latitude: lat, longitude: lon, speed, accuracy, heading } = pos.coords;
    const now = Date.now();
    const moved = lastGpsSentCoords
      ? haversineMeters(lastGpsSentCoords.lat, lastGpsSentCoords.lon, lat, lon)
      : Infinity;

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

    // Standalone local fallback (when laptop is unreachable)
    appState.location.lat = lat;
    appState.location.lon = lon;
    appState.location.speedMph = Number.isFinite(speed) && speed >= 0 ? Math.round(speed * 2.23694) : 0;
    appState.location.reportedBy = currentUser;
    appState.location.updatedAt = new Date().toISOString();

    const movedGeo = localGeocodeCache.lat == null
      ? Infinity
      : haversineMeters(localGeocodeCache.lat, localGeocodeCache.lon, lat, lon);
    if (now - localGeocodeCache.at > 45000 || movedGeo > 1500) {
      localGeocodeCache = { at: now, lat, lon };
      try {
        const b = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
        ).then((r) => r.json());
        const rawCity = b.city || b.locality;
        const city = rawCity ? rawCity.replace(/^(Charter\s+)?Township\s+of\s+/i, '').replace(/^(City|Village|Town)\s+of\s+/i, '').trim() : null;
        const reg = b.principalSubdivisionCode ? b.principalSubdivisionCode.replace(/^US-/, '') : b.principalSubdivision;
        appState.location.whereAreWe = city ? `Near ${city}${reg ? ', ' + reg : ''}` : `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
      } catch {}
      if (appState.trip.destination) {
        await computeOfflineEta(lat, lon);
      }
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
      const r = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`
      ).then((x) => x.json());
      const route = r.routes?.[0];
      if (route) {
        appState.location.remainingMeters = Math.round(route.distance);
        appState.location.remainingSec = Math.round(route.duration);
        appState.trip.route = {
          totalMeters: route.distance,
          totalSec: route.duration,
          geometry: route.geometry?.coordinates || [],
        };
      }
    } catch {}
  }

  function startGps() {
    if (!('geolocation' in navigator)) {
      alert('Geolocation is not supported in this browser.');
      return;
    }
    gpsEnabled = true;
    localStorage.setItem('roadtrip_gps_on', '1');
    updateGpsButton();
    if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = navigator.geolocation.watchPosition(
      handleGpsPosition,
      (err) => {
        console.warn('GPS error:', err.message);
        if (err.code === 1) {
          gpsEnabled = false;
          localStorage.setItem('roadtrip_gps_on', '0');
          updateGpsButton();
          alert('Location permission was denied. Enable location access to share live car GPS.');
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  function stopGps() {
    gpsEnabled = false;
    localStorage.setItem('roadtrip_gps_on', '0');
    updateGpsButton();
    if (gpsWatchId != null) {
      navigator.geolocation.clearWatch(gpsWatchId);
      gpsWatchId = null;
    }
  }

  // --- Place Search & Route Actions ---
  async function searchPlaces(query) {
    if (!query.trim()) return [];
    const lat = appState.location?.lat;
    const lon = appState.location?.lon;
    if (apiBase) {
      try {
        const qs = new URLSearchParams({ q: query });
        if (lat != null && lon != null) {
          qs.set('lat', String(lat));
          qs.set('lon', String(lon));
        }
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
      return { name: p.name || dedup[0] || query, label: dedup.join(', '), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
    });
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
    // Offline fallback
    if (payload.action === 'setDestination') appState.trip.destination = payload.place;
    if (payload.action === 'addStop') {
      appState.trip.stops.push({ ...payload.place, id: String(Date.now()), addedBy: currentUser, reached: false });
    }
    if (payload.action === 'removeStop') {
      appState.trip.stops = appState.trip.stops.filter((s) => s.id !== payload.stopId);
    }
    if (payload.action === 'toggleStop') {
      appState.trip.stops = appState.trip.stops.map((s) => (s.id === payload.stopId ? { ...s, reached: !s.reached } : s));
    }
    if (appState.location.lat != null && appState.trip.destination) {
      await computeOfflineEta(appState.location.lat, appState.location.lon);
    }
    saveLocalState();
    renderAll();
  }

  function renderPlaceSearchResults(containerId, results, onPick) {
    const box = document.getElementById(containerId);
    box.innerHTML = '';
    if (!results.length) {
      box.classList.add('hidden');
      return;
    }
    results.forEach((r) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-item';
      btn.innerHTML = `<span><strong>${esc(r.name)}</strong><br><span class="muted">${esc(r.label)}</span></span><span class="btn btn-sm btn-primary">Select</span>`;
      btn.addEventListener('click', () => {
        box.classList.add('hidden');
        onPick(r);
      });
      box.appendChild(btn);
    });
    box.classList.remove('hidden');
  }

  // --- Rendering ---
  function renderHero() {
    const loc = appState.location || {};
    const dest = appState.trip?.destination;
    document.getElementById('hero-where').textContent = loc.whereAreWe || 'Tap "Share GPS" to start tracking';
    document.getElementById('hero-updated').textContent = loc.updatedAt
      ? `${formatAgo(loc.updatedAt)}${loc.reportedBy ? ' • ' + loc.reportedBy : ''}`
      : 'No GPS ping yet';

    const sub = dest
      ? `Heading to ${dest.label || dest.name}`
      : 'Set a destination in Route & Stops to unlock ETA & progress.';
    document.getElementById('hero-sub').textContent = sub;

    document.getElementById('m-time-left').textContent = formatDuration(loc.remainingSec);
    document.getElementById('m-eta').textContent = formatEtaClock(loc.remainingSec);
    document.getElementById('m-miles-left').textContent = formatMiles(loc.remainingMeters);
    document.getElementById('m-speed').textContent = loc.lat != null ? `${loc.speedMph ?? 0} mph` : '—';
    document.getElementById('progress-fill').style.width = `${loc.progressPct ?? 0}%`;

    const nextBanner = document.getElementById('next-stop-banner');
    if (loc.nextStop) {
      document.getElementById('next-stop-text').textContent = `Next stop: ${loc.nextStop.name}`;
      document.getElementById('next-stop-eta').textContent = `${formatDuration(loc.nextStop.remainingSec)} • ${formatMiles(loc.nextStop.remainingMeters)}`;
      nextBanner.classList.remove('hidden');
    } else {
      nextBanner.classList.add('hidden');
    }
  }

  function renderStops() {
    const dest = appState.trip?.destination;
    const stops = appState.trip?.stops || [];
    const loc = appState.location || {};

    document.getElementById('current-dest-label').textContent = dest ? `(${dest.label || dest.name})` : '(not set)';

    // Nav links
    const gmaps = document.getElementById('gmaps-route-link');
    const waze = document.getElementById('waze-next-link');
    const activeStops = stops.filter((s) => !s.reached);

    if (dest) {
      const params = new URLSearchParams({ api: '1', destination: `${dest.lat},${dest.lon}`, travelmode: 'driving' });
      if (loc.lat != null) params.set('origin', `${loc.lat},${loc.lon}`);
      if (activeStops.length) {
        params.set('waypoints', activeStops.map((s) => `${s.lat},${s.lon}`).join('|'));
      }
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
    if (!stops.length) {
      list.innerHTML = `<p class="muted" style="text-align:center; padding:8px 0;">No stops added yet. Anyone in the car can add one above!</p>`;
      return;
    }

    stops.forEach((s, idx) => {
      const eta = loc.stopEtas?.[s.id];
      const etaStr = !s.reached && eta ? `${formatDuration(eta.remainingSec)} • ${formatMiles(eta.remainingMeters)}` : s.reached ? 'Reached' : '';
      const row = document.createElement('div');
      row.className = `stop-item${s.reached ? ' reached' : ''}`;
      row.innerHTML = `
        <div style="min-width:0; flex:1;">
          <div class="stop-name" style="font-weight:700; font-size:0.92rem;">${idx + 1}. ${esc(s.name)}</div>
          <div class="muted">${esc(s.label)} • Added by ${esc(s.addedBy)}${etaStr ? ' • <strong>' + esc(etaStr) + '</strong>' : ''}</div>
        </div>
        <div style="display:flex; gap:4px; flex-shrink:0;">
          <button class="btn btn-sm toggle-stop-btn" title="Mark Reached">${s.reached ? '↩' : '✓'}</button>
          <button class="btn btn-sm up-stop-btn" title="Move Up">↑</button>
          <button class="btn btn-sm down-stop-btn" title="Move Down">↓</button>
          <button class="btn btn-sm del-stop-btn" title="Remove">✕</button>
        </div>
      `;
      row.querySelector('.toggle-stop-btn').addEventListener('click', () => sendRouteAction({ action: 'toggleStop', stopId: s.id }));
      row.querySelector('.up-stop-btn').addEventListener('click', () => sendRouteAction({ action: 'moveStop', stopId: s.id, dir: -1 }));
      row.querySelector('.down-stop-btn').addEventListener('click', () => sendRouteAction({ action: 'moveStop', stopId: s.id, dir: 1 }));
      row.querySelector('.del-stop-btn').addEventListener('click', () => sendRouteAction({ action: 'removeStop', stopId: s.id }));
      list.appendChild(row);
    });
  }

  function initMap() {
    if (map) return;
    map = L.map('map').setView([42.9634, -85.6681], 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    stopMarkersLayer = L.layerGroup().addTo(map);
    routeLayer = L.polyline([], { color: '#2563eb', weight: 5, opacity: 0.75 }).addTo(map);
    trailLayer = L.polyline([], { color: '#10b981', weight: 4, opacity: 0.85, dashArray: '6 6' }).addTo(map);
  }

  function updateMap() {
    if (!map) return;
    const loc = appState.location || {};
    const dest = appState.trip?.destination;
    const stops = appState.trip?.stops || [];
    const geom = appState.trip?.route?.geometry || [];

    if (geom.length) {
      routeLayer.setLatLngs(geom.map(([lon, lat]) => [lat, lon]));
    } else {
      routeLayer.setLatLngs([]);
    }

    const trail = loc.trail || [];
    trailLayer.setLatLngs(trail.map((p) => [p.lat, p.lon]));

    stopMarkersLayer.clearLayers();
    stops.forEach((s, i) => {
      L.circleMarker([s.lat, s.lon], {
        radius: 8,
        color: s.reached ? '#94a3b8' : '#f59e0b',
        fillColor: s.reached ? '#cbd5e1' : '#fbbf24',
        fillOpacity: 0.95,
        weight: 2,
      })
        .bindPopup(`<b>Stop ${i + 1}: ${esc(s.name)}</b><br>Added by ${esc(s.addedBy)}`)
        .addTo(stopMarkersLayer);
    });

    if (dest) {
      if (!destMarker) {
        destMarker = L.circleMarker([dest.lat, dest.lon], {
          radius: 9,
          color: '#dc2626',
          fillColor: '#ef4444',
          fillOpacity: 0.95,
          weight: 2,
        }).addTo(map);
      } else {
        destMarker.setLatLng([dest.lat, dest.lon]);
      }
      destMarker.bindPopup(`<b>Destination:</b> ${esc(dest.name)}`);
    } else if (destMarker) {
      map.removeLayer(destMarker);
      destMarker = null;
    }

    if (loc.lat != null && loc.lon != null) {
      if (!carMarker) {
        carMarker = L.circleMarker([loc.lat, loc.lon], {
          radius: 10,
          color: '#ffffff',
          fillColor: '#2563eb',
          fillOpacity: 1,
          weight: 3,
        }).addTo(map);
      } else {
        carMarker.setLatLng([loc.lat, loc.lon]);
      }
      carMarker.bindPopup(`<b>Our Car</b><br>${esc(loc.whereAreWe || '')}`);
      if (!hasCenteredMap) {
        hasCenteredMap = true;
        map.setView([loc.lat, loc.lon], 10);
      }
    }
  }

  // --- TripSplitter Same-Origin Bridge ---
  function pushStateToTripSplitter() {
    const iframe = document.getElementById('ts-iframe');
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      { type: 'tripsplitter:remote', state: appState.tripsplitter },
      window.location.origin
    );
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
          const merged = await apiFetch('/api/tripsplitter/sync', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          appState.tripsplitter = merged;
          saveLocalState();
          updateBadges();
        } catch {}
      } else {
        appState.tripsplitter = { ...payload };
        saveLocalState();
        updateBadges();
      }
    }
  });

  // --- YouTube Player & Music Queue ---
  window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player('yt-player-mount', {
      playerVars: {
        listType: 'playlist',
        list: PLAYLIST_ID,
        rel: 0,
      },
      events: {
        onReady: () => {
          ytReady = true;
          if (appState.music?.nowPlayingVideoId) {
            playVideoInEmbed(appState.music.nowPlayingVideoId);
          }
        },
        onStateChange: (ev) => {
          if (ev.data === YT.PlayerState.ENDED) {
            playNextQueuedSong();
          }
        },
      },
    });
  };

  function playVideoInEmbed(videoId, labelText) {
    if (!ytReady || !ytPlayer) return;
    if (activeLoadedVideoId === videoId) return;
    activeLoadedVideoId = videoId;
    ytPlayer.loadVideoById(videoId);
    document.getElementById('now-playing-label').textContent = labelText || `Playing requested track (${videoId})`;
  }

  function playOfficialPlaylist() {
    activeLoadedVideoId = null;
    if (ytReady && ytPlayer) {
      ytPlayer.loadPlaylist({ listType: 'playlist', list: PLAYLIST_ID });
    }
    document.getElementById('now-playing-label').textContent = 'Loaded: The Ultimate Roadtrip (YouTube Music Playlist)';
  }

  async function playNextQueuedSong() {
    const next = (appState.music?.queue || []).find((q) => !q.played);
    if (!next) return;
    await musicQueueAction({ action: 'play', queueId: next.id, videoId: next.videoId });
    playVideoInEmbed(next.videoId, `Playing next in queue: ${next.title}`);
  }

  async function musicQueueAction(payload) {
    if (apiBase) {
      try {
        appState.music = await apiFetch('/api/music/queue', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        saveLocalState();
        renderMusic();
        return;
      } catch {}
    }
    if (payload.action === 'add' && payload.track) {
      appState.music.queue.push({
        id: String(Date.now()),
        ...payload.track,
        addedBy: payload.addedBy || currentUser,
        note: payload.note || '',
        votes: [currentUser],
        played: false,
      });
    } else if (payload.action === 'play') {
      appState.music.nowPlayingVideoId = payload.videoId;
      appState.music.queue.forEach((q) => {
        if (q.id === payload.queueId) q.played = true;
      });
    }
    saveLocalState();
    renderMusic();
  }

  function renderMusic() {
    const qList = document.getElementById('music-queue-list');
    const queue = appState.music?.queue || [];
    qList.innerHTML = '';

    if (!queue.length) {
      qList.innerHTML = `<p class="muted" style="text-align:center; padding:8px 0;">Queue is empty — search a song above to add to the car DJ list!</p>`;
    } else {
      const sorted = [...queue].sort((a, b) => Number(a.played) - Number(b.played) || (b.votes?.length || 0) - (a.votes?.length || 0));
      sorted.forEach((q) => {
        const voted = (q.votes || []).includes(currentUser);
        const row = document.createElement('div');
        row.className = 'track-row';
        if (q.played) row.style.opacity = '0.55';
        row.innerHTML = `
          <img class="track-thumb" src="${esc(q.thumbnail)}" alt="">
          <div class="track-info">
            <div class="track-title">${esc(q.title)}</div>
            <div class="track-meta">${esc(q.channel)}${q.duration ? ' • ' + esc(q.duration) : ''} • By ${esc(q.addedBy)}${q.note ? ' — "' + esc(q.note) + '"' : ''}</div>
          </div>
          <div style="display:flex; gap:4px; flex-shrink:0; flex-wrap:wrap; justify-content:flex-end;">
            <button class="btn btn-sm btn-primary play-q-btn" title="Play Here">▶</button>
            <a class="btn btn-sm" href="https://music.youtube.com/watch?v=${encodeURIComponent(q.videoId)}" target="_blank" rel="noopener" title="Open in YouTube Music">YTM</a>
            <button class="btn btn-sm vote-q-btn" style="${voted ? 'background:#dbeafe;border-color:#93c5fd;' : ''}">👍 ${(q.votes || []).length}</button>
            <button class="btn btn-sm done-q-btn" title="Mark Played">${q.played ? '↩' : '✓'}</button>
          </div>
        `;
        row.querySelector('.play-q-btn').addEventListener('click', () => {
          musicQueueAction({ action: 'play', queueId: q.id, videoId: q.videoId });
          playVideoInEmbed(q.videoId, `Playing: ${q.title}`);
        });
        row.querySelector('.vote-q-btn').addEventListener('click', () => {
          musicQueueAction({ action: 'vote', queueId: q.id, who: currentUser });
        });
        row.querySelector('.done-q-btn').addEventListener('click', () => {
          musicQueueAction({ action: 'togglePlayed', queueId: q.id });
        });
        qList.appendChild(row);
      });
    }

    const pList = document.getElementById('playlist-tracks-list');
    const tracks = appState.music?.playlistTracks || [];
    pList.innerHTML = '';
    if (!tracks.length) {
      pList.innerHTML = `<p class="muted">Click "Sync Tracks" (with laptop server running) or open the playlist directly in YouTube Music.</p>`;
    } else {
      tracks.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'track-row';
        row.innerHTML = `
          <img class="track-thumb" src="${esc(t.thumbnail)}" alt="">
          <div class="track-info">
            <div class="track-title">${i + 1}. ${esc(t.title)}</div>
            <div class="track-meta">${esc(t.channel)}${t.duration ? ' • ' + esc(t.duration) : ''}</div>
          </div>
          <div style="display:flex; gap:4px;">
            <button class="btn btn-sm play-pl-btn">▶</button>
            <a class="btn btn-sm" href="https://music.youtube.com/watch?v=${encodeURIComponent(t.videoId)}&list=${PLAYLIST_ID}" target="_blank" rel="noopener">YTM</a>
          </div>
        `;
        row.querySelector('.play-pl-btn').addEventListener('click', () => {
          playVideoInEmbed(t.videoId, `Playing from playlist: ${t.title}`);
        });
        pList.appendChild(row);
      });
    }
  }

  // --- Messages ---
  async function postMessage(text) {
    if (!text.trim()) return;
    if (apiBase) {
      try {
        const res = await apiFetch('/api/messages', {
          method: 'POST',
          body: JSON.stringify({ author: currentUser, text: text.trim() }),
        });
        if (res.messages) appState.messages = res.messages;
        saveLocalState();
        renderMessages();
        return;
      } catch {}
    }
    appState.messages.push({
      id: String(Date.now()),
      author: currentUser,
      text: text.trim(),
      placeSnapshot: appState.location?.whereAreWe || null,
      createdAt: new Date().toISOString(),
      reactions: {},
    });
    saveLocalState();
    renderMessages();
  }

  async function reactMessage(messageId, emoji) {
    if (!apiBase) return;
    try {
      const res = await apiFetch('/api/messages', {
        method: 'POST',
        body: JSON.stringify({ action: 'react', messageId, emoji, who: currentUser }),
      });
      if (res.messages) appState.messages = res.messages;
      renderMessages();
    } catch {}
  }

  function renderMessages() {
    const list = document.getElementById('msg-list');
    const msgs = appState.messages || [];
    list.innerHTML = '';

    if (!msgs.length) {
      list.innerHTML = `<p class="muted" style="text-align:center; padding:16px 0;">No messages yet — say hi to the car!</p>`;
      return;
    }

    msgs.forEach((m) => {
      const mine = m.author === currentUser;
      const card = document.createElement('div');
      card.className = `msg-card${mine ? ' mine' : ''}`;
      const timeStr = m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      card.innerHTML = `
        <div class="msg-head">
          <span class="msg-author">${esc(m.author)}</span>
          <span>${esc(timeStr)}</span>
        </div>
        <div>${esc(m.text)}</div>
        ${m.placeSnapshot ? `<div class="msg-place">📍 ${esc(m.placeSnapshot)}</div>` : ''}
        <div class="react-row"></div>
      `;
      const reactRow = card.querySelector('.react-row');
      ['🔥', '😂', '👍', '☕'].forEach((emoji) => {
        const users = m.reactions?.[emoji] || [];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `react-btn${users.includes(currentUser) ? ' active' : ''}`;
        btn.textContent = users.length ? `${emoji} ${users.length}` : emoji;
        btn.addEventListener('click', () => reactMessage(m.id, emoji));
        reactRow.appendChild(btn);
      });
      list.appendChild(card);
    });
    list.scrollTop = list.scrollHeight;
  }

  function updateBadges() {
    document.getElementById('badge-stops').textContent = String((appState.trip?.stops || []).filter((s) => !s.reached).length);
    document.getElementById('badge-tx').textContent = String((appState.tripsplitter?.transactions || []).length);
    document.getElementById('badge-queue').textContent = String((appState.music?.queue || []).filter((q) => !q.played).length);
    document.getElementById('badge-msgs').textContent = String((appState.messages || []).length);
  }

  function renderAll() {
    renderCrewPills();
    renderHero();
    renderStops();
    updateMap();
    renderMusic();
    renderMessages();
    updateBadges();
  }

  // --- Wire UI Events ---
  function bindEvents() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${target}`));
        if (target === 'route' && map) {
          setTimeout(() => map.invalidateSize(), 60);
        }
      });
    });

    document.getElementById('gps-toggle-btn').addEventListener('click', () => {
      if (gpsEnabled) stopGps();
      else startGps();
    });

    const runDestSearch = async () => {
      const q = document.getElementById('dest-input').value;
      const results = await searchPlaces(q);
      renderPlaceSearchResults('dest-results', results, (place) => {
        document.getElementById('dest-input').value = place.label || place.name;
        sendRouteAction({ action: 'setDestination', place });
      });
    };
    document.getElementById('dest-search-btn').addEventListener('click', runDestSearch);
    document.getElementById('dest-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runDestSearch(); }
    });

    const runStopSearch = async (queryOverride) => {
      const q = queryOverride || document.getElementById('stop-input').value;
      const results = await searchPlaces(q);
      renderPlaceSearchResults('stop-results', results, (place) => {
        document.getElementById('stop-input').value = '';
        sendRouteAction({ action: 'addStop', place, addedBy: currentUser });
      });
    };
    document.getElementById('stop-search-btn').addEventListener('click', () => runStopSearch());
    document.getElementById('stop-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runStopSearch(); }
    });
    document.querySelectorAll('.quick-stop-chip').forEach((chip) => {
      chip.addEventListener('click', () => runStopSearch(chip.dataset.q));
    });

    document.getElementById('recalc-route-btn').addEventListener('click', () => sendRouteAction({ action: 'recalculate' }));
    document.getElementById('center-map-btn').addEventListener('click', () => {
      if (map && appState.location?.lat != null) {
        map.setView([appState.location.lat, appState.location.lon], 12);
      }
    });

    // Music
    document.getElementById('play-playlist-btn').addEventListener('click', playOfficialPlaylist);
    document.getElementById('refresh-playlist-btn').addEventListener('click', async () => {
      if (!apiBase) return;
      const res = await apiFetch('/api/music/playlist?force=1');
      appState.music.playlistTracks = res.tracks || [];
      renderMusic();
    });

    const runMusicSearch = async () => {
      const q = document.getElementById('music-search-input').value.trim();
      if (!q) return;
      const box = document.getElementById('music-search-results');
      if (!apiBase) {
        box.innerHTML = `<div style="padding:10px; font-size:0.85rem;">Laptop sync offline — use the <strong>+ Join YTM Collab</strong> button above to add directly to YouTube Music!</div>`;
        box.classList.remove('hidden');
        return;
      }
      const data = await apiFetch(`/api/music/search?q=${encodeURIComponent(q)}`);
      box.innerHTML = '';
      const results = data.results || [];
      if (!results.length) {
        box.classList.add('hidden');
        return;
      }
      results.forEach((t) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'search-item';
        btn.innerHTML = `
          <div style="display:flex; align-items:center; gap:10px; min-width:0;">
            <img class="track-thumb" src="${esc(t.thumbnail)}" alt="">
            <div style="min-width:0;">
              <div class="track-title">${esc(t.title)}</div>
              <div class="track-meta">${esc(t.channel)}${t.duration ? ' • ' + esc(t.duration) : ''}</div>
            </div>
          </div>
          <span class="btn btn-sm btn-emerald">+ Queue</span>
        `;
        btn.addEventListener('click', async () => {
          const note = document.getElementById('music-note-input').value.trim();
          document.getElementById('music-note-input').value = '';
          document.getElementById('music-search-input').value = '';
          box.classList.add('hidden');
          await musicQueueAction({ action: 'add', track: t, addedBy: currentUser, note });
        });
        box.appendChild(btn);
      });
      box.classList.remove('hidden');
    };
    document.getElementById('music-search-btn').addEventListener('click', runMusicSearch);
    document.getElementById('music-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runMusicSearch(); }
    });

    // Chat
    document.getElementById('msg-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('msg-input');
      const text = input.value;
      input.value = '';
      postMessage(text);
    });
    document.querySelectorAll('.quick-msg-chip').forEach((chip) => {
      chip.addEventListener('click', () => postMessage(chip.textContent));
    });
  }

  async function init() {
    initMap();
    bindEvents();
    updateGpsButton();
    renderAll();

    // Load YouTube IFrame API
    const ytScript = document.createElement('script');
    ytScript.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(ytScript);

    apiBase = await discoverApiBase();
    if (apiBase) {
      setSyncPill(true, 'Laptop Live Sync');
      try {
        appState = await apiFetch('/api/state');
        saveLocalState();
        renderAll();
        pushStateToTripSplitter();
      } catch {}
      connectSSE();
    } else {
      setSyncPill(false, 'Standalone Mode (Local)');
    }

    if (gpsEnabled) {
      startGps();
    }

    setInterval(() => {
      if (appState.location?.updatedAt) {
        document.getElementById('hero-updated').textContent = `${formatAgo(appState.location.updatedAt)}${appState.location.reportedBy ? ' • ' + appState.location.reportedBy : ''}`;
      }
    }, 10000);
  }

  init();
})();
