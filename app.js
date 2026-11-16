(() => {
  'use strict';

  const DEFAULT_PLAYLIST_URL = 'https://music.youtube.com/playlist?list=PLO6qnlYSFTDc&jct=Bk_kBa-9hpvTi_P7SuT2Iw';
  const DONUT_COLORS = ['#C8FF3D', '#9D7BFF', '#56CCF2', '#FB7185', '#FBBF24', '#34D399'];
  const LAST_TRIP_STORAGE_KEY = 'db_last_trip_state_v3';
  const A2HS_DISMISS_KEY = 'roadtrip_a2hs_dismissed_v1';

  let appState = null;
  let activePassword = null;
  let pendingEncryptedPayload = null;
  let pendingMergeContext = null;
  let currentUser = localStorage.getItem('roadtrip_who') || 'Tim';
  let welcomeSelectedUser = null;
  let dirtyCount = 0;
  let lastDirtyReason = '';
  let deferredInstallPrompt = null;
  let suppressHashEvent = false;

  // Wizard State
  let wizStep = 1;
  let wizState = {
    title: '',
    crew: ['Tim', 'Chris', 'Jessica', 'Nancy'],
    modules: { locations: true, expenses: true, playlist: true, notes: true },
    destination: null,
    playlistUrl: DEFAULT_PLAYLIST_URL,
    playlistTitle: 'Dangerous.Business',
    firstNote: '',
    security: 'standard',
    password: '',
  };

  // Leaflet Map
  let map = null;
  let carMarker = null;
  let destMarker = null;
  let stopMarkersLayer = null;
  let routeLayer = null;
  let cachedRouteGeometry = [];

  // =========================================================
  // UTILITIES & FORMATTING
  // =========================================================
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 2800);
  }

  function avatarClassFor(name) {
    const key = String(name || '').trim().toLowerCase();
    if (key === 'tim') return 'avatar-tim';
    if (key === 'chris') return 'avatar-chris';
    if (key === 'jessica') return 'avatar-jessica';
    if (key === 'nancy') return 'avatar-nancy';
    return '';
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

  function formatAgo(isoOrMs) {
    if (!isoOrMs) return 'Tap "📍 Update GPS" to share where we are';
    const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
    if (!Number.isFinite(ts)) return 'Location saved in URL';
    const diff = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (diff < 20) return 'Updated just now';
    if (diff < 60) return `Updated ${diff}s ago`;
    if (diff < 3600) return `Updated ${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `Updated ${Math.floor(diff / 3600)}h ago`;
    return `Updated ${Math.floor(diff / 86400)}d ago`;
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // =========================================================
  // WEB CRYPTO AES-256-GCM + LZSTRING URL ENGINE
  // =========================================================
  function bytesToBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveAesKey(password, saltBytes) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptStateToHash(stateObj, password) {
    const json = JSON.stringify(stateObj);
    const compressed = LZString.compressToUint8Array(json);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(password, salt);
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed);
    const cipherBytes = new Uint8Array(cipherBuf);
    const combined = new Uint8Array(salt.length + iv.length + cipherBytes.length);
    combined.set(salt, 0);
    combined.set(iv, 16);
    combined.set(cipherBytes, 28);
    return 'e=' + bytesToBase64Url(combined);
  }

  async function decryptHashToState(b64Payload, password) {
    const combined = base64UrlToBytes(b64Payload);
    if (combined.length < 29) throw new Error('Invalid payload');
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const cipherBytes = combined.slice(28);
    const key = await deriveAesKey(password, salt);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBytes);
    const json = LZString.decompressFromUint8Array(new Uint8Array(plainBuf));
    if (!json) throw new Error('Decompress failed');
    return JSON.parse(json);
  }

  function encodeStandardHash(stateObj) {
    return 's=' + LZString.compressToEncodedURIComponent(JSON.stringify(stateObj));
  }

  function decodeStandardHash(encoded) {
    const json = LZString.decompressFromEncodedURIComponent(encoded);
    if (!json) return null;
    return JSON.parse(json);
  }

  // =========================================================
  // STATE CREATION, MERGING & PERSISTENCE
  // =========================================================
  function createDemoTripState() {
    return {
      v: 3,
      id: 'demo_moa_run',
      updatedAt: Date.now(),
      title: 'Mall of America Roadtrip',
      crew: ['Tim', 'Chris', 'Jessica', 'Nancy'],
      modules: { locations: true, expenses: true, playlist: true, notes: true },
      encrypted: false,
      trip: {
        destination: {
          name: 'Mall of America',
          label: 'Mall of America, Bloomington, MN',
          lat: 44.8550204,
          lon: -93.2421195,
        },
        stops: [],
        deletedStopIds: [],
      },
      location: {
        lat: 43.15638,
        lon: -85.710315,
        speedMph: 0,
        updatedAt: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
        reportedBy: 'Tim',
        whereAreWe: 'On West Averill Street • Near Sparta, MI',
        remainingMeters: 972043,
        remainingSec: 41100,
        progressPct: 12,
        nextStop: null,
      },
      expenses: {
        transactions: [
          { id: 1731450001000, type: 'expense', description: 'Hotel Rooms', amount: 246, payer: 'Tim', updatedAt: 1731450001000 },
          { id: 1731450002000, type: 'expense', description: 'Second Night Hotel', amount: 246, payer: 'Tim', updatedAt: 1731450002000 },
          { id: 1731450003000, type: 'payment', description: 'Repayment: Nancy → Tim', amount: 100, payer: 'Nancy', payee: 'Tim', updatedAt: 1731450003000 },
          { id: 1731450004000, type: 'expense', description: 'Gas & Road Snacks', amount: 38.32, payer: 'Tim', updatedAt: 1731450004000 },
        ],
        deletedIds: [],
      },
      music: {
        playlistTitle: 'Dangerous.Business',
        collabUrl: DEFAULT_PLAYLIST_URL,
      },
      messages: [
        {
          id: 'msg_demo_1',
          author: 'Tim',
          text: 'Playlist & expense tracker are live in this link—tap Share the Update anytime you add something!',
          createdAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
          whereAreWe: 'Near Sparta, MI',
        },
      ],
    };
  }

  function normalizeState(raw) {
    const base = {
      v: 3,
      id: raw?.id || 'trip_' + Date.now().toString(36),
      updatedAt: raw?.updatedAt || Date.now(),
      title: raw?.title || 'Crew Trip',
      crew: Array.isArray(raw?.crew) && raw.crew.length ? raw.crew : ['Tim', 'Chris', 'Jessica', 'Nancy'],
      modules: {
        locations: raw?.modules?.locations !== false,
        expenses: raw?.modules?.expenses !== false,
        playlist: raw?.modules?.playlist !== false,
        notes: raw?.modules?.notes !== false,
      },
      encrypted: Boolean(raw?.encrypted),
      trip: {
        destination: raw?.trip?.destination || null,
        stops: Array.isArray(raw?.trip?.stops) ? raw.trip.stops : [],
        deletedStopIds: Array.isArray(raw?.trip?.deletedStopIds) ? raw.trip.deletedStopIds : [],
      },
      location: {
        lat: raw?.location?.lat ?? null,
        lon: raw?.location?.lon ?? null,
        speedMph: raw?.location?.speedMph ?? 0,
        updatedAt: raw?.location?.updatedAt || null,
        reportedBy: raw?.location?.reportedBy || null,
        whereAreWe: raw?.location?.whereAreWe || 'Tap "📍 Update GPS" above to stamp location',
        remainingMeters: raw?.location?.remainingMeters ?? null,
        remainingSec: raw?.location?.remainingSec ?? null,
        progressPct: raw?.location?.progressPct ?? 0,
        nextStop: raw?.location?.nextStop || null,
      },
      expenses: {
        transactions: Array.isArray(raw?.expenses?.transactions)
          ? raw.expenses.transactions
          : (Array.isArray(raw?.tripsplitter?.transactions) ? raw.tripsplitter.transactions : []),
        deletedIds: Array.isArray(raw?.expenses?.deletedIds)
          ? raw.expenses.deletedIds
          : (Array.isArray(raw?.tripsplitter?.deletedIds) ? raw.tripsplitter.deletedIds : []),
      },
      music: {
        playlistTitle: raw?.music?.playlistTitle || 'Shared Playlist',
        collabUrl: raw?.music?.collabUrl || DEFAULT_PLAYLIST_URL,
      },
      messages: Array.isArray(raw?.messages) ? raw.messages : [],
    };
    return base;
  }

  function mergeTripStates(existing, incoming) {
    const a = normalizeState(existing);
    const b = normalizeState(incoming);
    if (a.id !== b.id) return b;

    const newer = (b.updatedAt || 0) >= (a.updatedAt || 0) ? b : a;
    const crewSet = new Set([...a.crew, ...b.crew]);

    // Merge deleted transaction IDs & transactions
    const delTx = new Set([...(a.expenses.deletedIds || []), ...(b.expenses.deletedIds || [])]);
    const txMap = new Map();
    for (const t of [...a.expenses.transactions, ...b.expenses.transactions]) {
      if (!t || delTx.has(t.id)) continue;
      const prev = txMap.get(t.id);
      if (!prev || (t.updatedAt || 0) >= (prev.updatedAt || 0)) {
        txMap.set(t.id, t);
      }
    }

    // Merge stops
    const delStops = new Set([...(a.trip.deletedStopIds || []), ...(b.trip.deletedStopIds || [])]);
    const stopMap = new Map();
    for (const s of [...a.trip.stops, ...b.trip.stops]) {
      if (!s || delStops.has(s.id)) continue;
      const prev = stopMap.get(s.id);
      stopMap.set(s.id, prev ? { ...prev, ...s, reached: Boolean(prev.reached || s.reached) } : s);
    }

    // Merge messages
    const msgMap = new Map();
    for (const m of [...a.messages, ...b.messages]) {
      if (m?.id) msgMap.set(m.id, m);
    }
    const mergedMsgs = [...msgMap.values()].sort((x, y) => Date.parse(x.createdAt || 0) - Date.parse(y.createdAt || 0));

    // Pick fresher GPS location
    const aLocTime = a.location?.updatedAt ? Date.parse(a.location.updatedAt) : 0;
    const bLocTime = b.location?.updatedAt ? Date.parse(b.location.updatedAt) : 0;
    const bestLocation = bLocTime >= aLocTime ? b.location : a.location;

    return {
      ...newer,
      updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
      crew: [...crewSet],
      trip: {
        destination: newer.trip.destination || a.trip.destination || b.trip.destination,
        stops: [...stopMap.values()],
        deletedStopIds: [...delStops],
      },
      location: bestLocation,
      expenses: {
        transactions: [...txMap.values()].sort((x, y) => Number(y.id) - Number(x.id)),
        deletedIds: [...delTx],
      },
      messages: mergedMsgs.slice(-50),
    };
  }

  function saveStateToLocal(state) {
    try {
      localStorage.setItem(`db_trip_${state.id}`, JSON.stringify(state));
      localStorage.setItem(LAST_TRIP_STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }

  function loadLocalByTripId(id) {
    try {
      const raw = localStorage.getItem(`db_trip_${id}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  async function syncStateToUrl(markAsDirtyReason = null) {
    if (!appState) return;
    appState.updatedAt = Date.now();
    saveStateToLocal(appState);

    let hashStr = '';
    if (appState.encrypted && activePassword) {
      hashStr = await encryptStateToHash(appState, activePassword);
    } else {
      appState.encrypted = false;
      hashStr = encodeStandardHash(appState);
    }

    suppressHashEvent = true;
    window.history.replaceState(null, '', '#' + hashStr);
    setTimeout(() => { suppressHashEvent = false; }, 50);

    if (markAsDirtyReason) {
      dirtyCount += 1;
      lastDirtyReason = markAsDirtyReason;
      updateShareBarUI();
      showToast(`Saved to URL • Tap "Share the Update"`);
    } else {
      updateShareBarUI();
    }
  }

  function updateShareBarUI() {
    const bar = document.getElementById('share-update-bar');
    const headline = document.getElementById('share-bar-headline');
    const sub = document.getElementById('share-bar-subtext');
    if (!bar || !headline || !sub) return;

    if (dirtyCount > 0) {
      bar.classList.add('dirty');
      headline.textContent = `${dirtyCount} New Update${dirtyCount > 1 ? 's' : ''} Ready to Share`;
      sub.textContent = lastDirtyReason || 'Tap "Share the Update" so your crew gets the new link';
    } else {
      bar.classList.remove('dirty');
      headline.textContent = appState?.encrypted ? '🔒 Encrypted URL Synced' : '🔗 Trip URL Ready';
      sub.textContent = 'Every module lives in the link. Share after making changes.';
    }
  }

  // =========================================================
  // VIEW ROUTING (LANDING vs UNLOCK vs APP)
  // =========================================================
  function showLandingView() {
    closeAllSheets();
    document.getElementById('wizard-modal').classList.add('hidden');
    document.getElementById('unlock-modal').classList.add('hidden');
    document.getElementById('merge-modal')?.classList.add('hidden');
    document.getElementById('app-view').classList.add('hidden');
    document.getElementById('landing-view').classList.remove('hidden');

    // Check if there is a saved trip on this device
    try {
      const saved = JSON.parse(localStorage.getItem(LAST_TRIP_STORAGE_KEY) || 'null');
      const banner = document.getElementById('resume-trip-banner');
      if (saved && saved.title) {
        document.getElementById('resume-trip-title').textContent = saved.title;
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
      }
    } catch {}
  }

  function canonicalSignature(raw) {
    const s = normalizeState(raw);
    return JSON.stringify({
      title: s.title,
      crew: s.crew,
      modules: s.modules,
      trip: s.trip,
      location: { whereAreWe: s.location.whereAreWe, lat: s.location.lat, lon: s.location.lon },
      expenses: {
        txs: (s.expenses.transactions || []).map((t) => ({ id: t.id, type: t.type, description: t.description, amount: t.amount, payer: t.payer, payee: t.payee })),
        del: s.expenses.deletedIds || [],
      },
      music: s.music,
      messages: (s.messages || []).map((m) => ({ id: m.id, text: m.text, author: m.author })),
    });
  }

  function sumExpenses(state) {
    return (state.expenses?.transactions || [])
      .filter((t) => t.type === 'expense')
      .reduce((acc, t) => acc + Number(t.amount || 0), 0);
  }

  function openMergeConfirmationModal(localRaw, incomingRaw, passwordUsed) {
    const local = normalizeState(localRaw);
    const incoming = normalizeState(incomingRaw);
    const merged = mergeTripStates(local, incoming);
    pendingMergeContext = { local, incoming, merged, passwordUsed };

    document.getElementById('merge-trip-name').textContent = merged.title || 'this trip';

    const locExpCount = local.expenses.transactions.length;
    const incExpCount = incoming.expenses.transactions.length;
    const mrgExpCount = merged.expenses.transactions.length;

    const locStopCount = local.trip.stops.length;
    const incStopCount = incoming.trip.stops.length;
    const mrgStopCount = merged.trip.stops.length;

    const locNoteCount = local.messages.length;
    const incNoteCount = incoming.messages.length;
    const mrgNoteCount = merged.messages.length;

    const diffBox = document.getElementById('merge-diff-summary');
    diffBox.innerHTML = `
      <div class="merge-diff-row">
        <span class="muted">💳 Expenses</span>
        <span>Device: <strong>${locExpCount} ($${sumExpenses(local).toFixed(0)})</strong> · Link: <strong>${incExpCount} ($${sumExpenses(incoming).toFixed(0)})</strong> → <strong style="color:var(--lime);">Merged: ${mrgExpCount}</strong></span>
      </div>
      <div class="merge-diff-row">
        <span class="muted">📍 Pit Stops</span>
        <span>Device: <strong>${locStopCount}</strong> · Link: <strong>${incStopCount}</strong> → <strong style="color:var(--lime);">Merged: ${mrgStopCount}</strong></span>
      </div>
      <div class="merge-diff-row">
        <span class="muted">💬 Crew Notes</span>
        <span>Device: <strong>${locNoteCount}</strong> · Link: <strong>${incNoteCount}</strong> → <strong style="color:var(--lime);">Merged: ${mrgNoteCount}</strong></span>
      </div>
      <div class="merge-diff-row">
        <span class="muted">👥 Crew</span>
        <span><strong>${esc(merged.crew.join(', '))}</strong></span>
      </div>`;

    document.getElementById('landing-view').classList.add('hidden');
    document.getElementById('wizard-modal').classList.add('hidden');
    document.getElementById('unlock-modal').classList.add('hidden');
    document.getElementById('merge-modal').classList.remove('hidden');
  }

  function finalizeEnterApp(chosenState, passwordUsed = null, toastMessage = null) {
    appState = normalizeState(chosenState);
    if (passwordUsed) {
      activePassword = passwordUsed;
      appState.encrypted = true;
      try { sessionStorage.setItem(`db_pw_${appState.id}`, passwordUsed); } catch {}
    } else {
      activePassword = null;
    }

    if (!appState.crew.includes(currentUser)) {
      currentUser = appState.crew[0] || 'Tim';
    }

    dirtyCount = 0;
    lastDirtyReason = '';
    saveStateToLocal(appState);

    document.getElementById('landing-view').classList.add('hidden');
    document.getElementById('wizard-modal').classList.add('hidden');
    document.getElementById('unlock-modal').classList.add('hidden');
    document.getElementById('merge-modal')?.classList.add('hidden');
    document.getElementById('app-view').classList.remove('hidden');

    const welcomedForTrip = localStorage.getItem(`db_welcomed_${appState.id}`) === '1';
    const splash = document.getElementById('welcome-splash');
    if (!welcomedForTrip) {
      welcomeSelectedUser = localStorage.getItem('roadtrip_who');
      if (!appState.crew.includes(welcomeSelectedUser)) welcomeSelectedUser = null;
      splash.classList.remove('hidden');
    } else {
      splash.classList.add('hidden');
    }

    initMap();
    renderAll();
    syncStateToUrl(null);
    if (toastMessage) showToast(toastMessage);

    if (appState.modules.locations && appState.location.lat != null && appState.trip.destination) {
      computeBrowserRouteEta(appState.location.lat, appState.location.lon);
    }
  }

  function enterAppWithState(incomingState, passwordUsed = null, skipMergePrompt = false) {
    const localExisting = loadLocalByTripId(incomingState.id);
    if (localExisting && !skipMergePrompt && canonicalSignature(localExisting) !== canonicalSignature(incomingState)) {
      openMergeConfirmationModal(localExisting, incomingState, passwordUsed);
      return;
    }
    finalizeEnterApp(incomingState, passwordUsed, null);
  }

  async function handleHashRoute() {
    if (suppressHashEvent) return;
    const rawHash = window.location.hash.replace(/^#/, '').trim();
    if (!rawHash || (!rawHash.startsWith('s=') && !rawHash.startsWith('e='))) {
      showLandingView();
      return;
    }

    if (rawHash.startsWith('s=')) {
      try {
        const decoded = decodeStandardHash(rawHash.slice(2));
        if (decoded) {
          enterAppWithState(decoded, null);
          return;
        }
      } catch {}
      showLandingView();
      return;
    }

    if (rawHash.startsWith('e=')) {
      const payload = rawHash.slice(2);
      pendingEncryptedPayload = payload;

      // Try cached password from sessionStorage if any
      try {
        const savedTrip = JSON.parse(localStorage.getItem(LAST_TRIP_STORAGE_KEY) || 'null');
        const cachedPw = savedTrip?.id ? sessionStorage.getItem(`db_pw_${savedTrip.id}`) : null;
        if (cachedPw) {
          const decrypted = await decryptHashToState(payload, cachedPw);
          enterAppWithState(decrypted, cachedPw);
          return;
        }
      } catch {}

      document.getElementById('landing-view').classList.add('hidden');
      document.getElementById('app-view').classList.add('hidden');
      document.getElementById('unlock-error').classList.add('hidden');
      document.getElementById('unlock-password-input').value = '';
      document.getElementById('unlock-modal').classList.remove('hidden');
    }
  }

  // =========================================================
  // NEW TRIP WIZARD (4 STEPS)
  // =========================================================
  function openNewTripWizard() {
    wizStep = 1;
    wizState = {
      title: '',
      crew: ['Tim', 'Chris', 'Jessica', 'Nancy'],
      modules: { locations: true, expenses: true, playlist: true, notes: true },
      destination: null,
      playlistUrl: DEFAULT_PLAYLIST_URL,
      playlistTitle: 'Dangerous.Business',
      firstNote: '',
      security: 'standard',
      password: '',
    };
    document.getElementById('wiz-trip-title').value = '';
    document.getElementById('wiz-dest-input').value = '';
    document.getElementById('wiz-dest-selected').classList.add('hidden');
    document.getElementById('wiz-dest-results').classList.add('hidden');
    document.getElementById('wiz-playlist-url').value = DEFAULT_PLAYLIST_URL;
    document.getElementById('wiz-playlist-title').value = 'Dangerous.Business';
    document.getElementById('wiz-first-note').value = '';
    document.getElementById('wiz-password-input').value = '';
    renderWizard();
    document.getElementById('wizard-modal').classList.remove('hidden');
  }

  function renderWizard() {
    const headings = [
      'Name Your Trip & Crew',
      'Select Trip Modules',
      'Setup Selected Modules',
      'Privacy & URL Encryption',
    ];
    document.getElementById('wiz-step-indicator').textContent = `STEP ${wizStep} OF 4`;
    document.getElementById('wiz-heading').textContent = headings[wizStep - 1];
    document.getElementById('wiz-progress-bar').style.width = `${wizStep * 25}%`;

    for (let i = 1; i <= 4; i++) {
      document.getElementById(`wiz-step-${i}`).classList.toggle('hidden', i !== wizStep);
    }

    document.getElementById('wiz-back-btn').classList.toggle('hidden', wizStep === 1);
    const nextBtn = document.getElementById('wiz-next-btn');
    if (wizStep === 1) nextBtn.textContent = 'Next: Choose Modules →';
    else if (wizStep === 2) nextBtn.textContent = 'Next: Configure →';
    else if (wizStep === 3) nextBtn.textContent = 'Next: Security →';
    else nextBtn.textContent = '🚀 Launch Trip App →';

    // Crew chips
    const chipBox = document.getElementById('wiz-crew-chips');
    chipBox.innerHTML = '';
    wizState.crew.forEach((p, idx) => {
      const chip = document.createElement('span');
      chip.className = 'crew-chip';
      chip.innerHTML = `<span>${esc(p)}</span><button type="button" aria-label="Remove ${esc(p)}">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        if (wizState.crew.length <= 1) {
          showToast('Keep at least 1 person in the crew');
          return;
        }
        wizState.crew.splice(idx, 1);
        renderWizard();
      });
      chipBox.appendChild(chip);
    });

    // Module toggles
    document.querySelectorAll('#wiz-step-2 .wiz-mod-toggle').forEach((btn) => {
      const m = btn.dataset.mod;
      btn.classList.toggle('active', Boolean(wizState.modules[m]));
    });

    // Step 3 visibility
    document.getElementById('wiz-cfg-locations').classList.toggle('hidden', !wizState.modules.locations);
    document.getElementById('wiz-cfg-playlist').classList.toggle('hidden', !wizState.modules.playlist);
    document.getElementById('wiz-cfg-notes').classList.toggle('hidden', !wizState.modules.notes);
    const anyStep3 = wizState.modules.locations || wizState.modules.playlist || wizState.modules.notes;
    document.getElementById('wiz-cfg-empty').classList.toggle('hidden', anyStep3);

    // Step 4 security
    document.getElementById('wiz-sec-standard').classList.toggle('active', wizState.security === 'standard');
    document.getElementById('wiz-sec-encrypted').classList.toggle('active', wizState.security === 'encrypted');
    document.getElementById('wiz-password-box').classList.toggle('hidden', wizState.security !== 'encrypted');
  }

  async function finishWizardAndLaunch() {
    const title = document.getElementById('wiz-trip-title').value.trim() || 'Dangerous.Business Trip';
    const plUrl = document.getElementById('wiz-playlist-url').value.trim() || DEFAULT_PLAYLIST_URL;
    const plTitle = document.getElementById('wiz-playlist-title').value.trim() || 'Shared Playlist';
    const noteText = document.getElementById('wiz-first-note').value.trim();
    const pw = document.getElementById('wiz-password-input').value;

    if (wizState.security === 'encrypted' && !pw) {
      showToast('Please enter a trip passcode or choose Instant Link');
      return;
    }

    const newTrip = normalizeState({
      id: 'trip_' + Date.now().toString(36),
      updatedAt: Date.now(),
      title,
      crew: wizState.crew.length ? wizState.crew : ['Tim', 'Chris'],
      modules: { ...wizState.modules },
      encrypted: wizState.security === 'encrypted',
      trip: {
        destination: wizState.destination,
        stops: [],
        deletedStopIds: [],
      },
      location: {
        lat: null,
        lon: null,
        speedMph: 0,
        updatedAt: null,
        reportedBy: null,
        whereAreWe: 'Tap "📍 Update GPS" above to stamp location',
        remainingMeters: null,
        remainingSec: null,
        progressPct: 0,
        nextStop: null,
      },
      expenses: { transactions: [], deletedIds: [] },
      music: { playlistTitle: plTitle, collabUrl: plUrl },
      messages: noteText
        ? [{ id: 'msg_' + Date.now(), author: wizState.crew[0], text: noteText, createdAt: new Date().toISOString(), whereAreWe: '' }]
        : [],
    });

    enterAppWithState(newTrip, wizState.security === 'encrypted' ? pw : null, true);
    await syncStateToUrl('New trip created — share link with the crew!');
  }

  // =========================================================
  // SHARE THE UPDATE DIALOG
  // =========================================================
  async function openShareDialog() {
    await syncStateToUrl(null);
    const url = window.location.href;
    document.getElementById('share-url-readonly').value = url;

    const badge = document.getElementById('share-sheet-enc-badge');
    const summary = document.getElementById('share-sheet-summary');
    if (appState?.encrypted) {
      badge.textContent = '🔒 AES-256-GCM Password Encrypted URL';
      summary.textContent = `This link contains the entire "${appState.title}" state encrypted with your trip password. Send it over Signal, iMessage, or WhatsApp.`;
    } else {
      badge.textContent = '🔗 Compressed Zero-Cloud URL';
      summary.textContent = `This link packs all "${appState?.title || 'Trip'}" updates directly inside the URL. Anyone in the crew who opens it gets your updates merged automatically.`;
    }

    openSheet('sheet-share');
  }

  function buildShareMessageText() {
    const parts = [`🔥 ${appState?.title || 'Dangerous.Business'} — Updated Trip Link`];
    if (lastDirtyReason) parts.push(`Latest update: ${lastDirtyReason}`);
    if (appState?.modules?.locations && appState?.location?.whereAreWe && !appState.location.whereAreWe.startsWith('Tap ')) {
      parts.push(`📍 ${appState.location.whereAreWe}`);
    }
    if (appState?.encrypted) {
      parts.push(`🔒 Locked with our trip passcode`);
    }
    return parts.join('\n');
  }

  async function triggerNativeShare() {
    await syncStateToUrl(null);
    const url = window.location.href;
    const text = buildShareMessageText();
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${appState?.title || 'Dangerous.Business'} Update`,
          text,
          url,
        });
        dirtyCount = 0;
        lastDirtyReason = '';
        updateShareBarUI();
        closeAllSheets();
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    // Fallback to clipboard copy if Web Share API isn't supported on desktop
    await copyShareUrl(false);
  }

  async function copyShareUrl(includeNote = false) {
    await syncStateToUrl(null);
    const url = window.location.href;
    const payload = includeNote ? `${buildShareMessageText()}\n${url}` : url;
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      const inp = document.getElementById('share-url-readonly');
      inp.value = payload;
      inp.select();
      document.execCommand('copy');
    }
    dirtyCount = 0;
    lastDirtyReason = '';
    updateShareBarUI();
    showToast(includeNote ? 'Copied note + link!' : 'Copied trip link to clipboard!');
  }

  // =========================================================
  // LOCATION, GEOCODING & BROWSER OSRM ETA
  // =========================================================
  async function stampMyGpsLocation() {
    if (!('geolocation' in navigator)) {
      showToast('Geolocation not supported in this browser');
      return;
    }
    const btn = document.getElementById('gps-snap-btn');
    if (btn) btn.textContent = 'Locating...';

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon, speed } = pos.coords;
        appState.location.lat = Number(lat.toFixed(5));
        appState.location.lon = Number(lon.toFixed(5));
        appState.location.speedMph = Number.isFinite(speed) && speed >= 0 ? Math.round(speed * 2.23694) : 0;
        appState.location.reportedBy = currentUser;
        appState.location.updatedAt = new Date().toISOString();

        try {
          const b = await fetch(
            `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
          ).then((r) => r.json());
          const rawCity = b.city || b.locality;
          const city = rawCity
            ? rawCity.replace(/^(Charter\s+)?Township\s+of\s+/i, '').replace(/^(City|Village|Town)\s+of\s+/i, '').trim()
            : null;
          const reg = b.principalSubdivisionCode ? b.principalSubdivisionCode.replace(/^US-/, '') : b.principalSubdivision;
          appState.location.whereAreWe = city ? `Near ${city}${reg ? ', ' + reg : ''}` : `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
        } catch {
          appState.location.whereAreWe = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
        }

        if (appState.trip.destination) {
          await computeBrowserRouteEta(lat, lon);
        }

        if (btn) btn.textContent = '📍 Update GPS';
        renderHero();
        renderStops();
        updateMap();
        await syncStateToUrl(`${currentUser} updated GPS (${appState.location.whereAreWe})`);
      },
      () => {
        if (btn) btn.textContent = '📍 Update GPS';
        showToast('Please allow location access in your browser');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
    );
  }

  async function computeBrowserRouteEta(lat, lon) {
    if (!appState?.trip?.destination) return;
    try {
      const activeStops = (appState.trip.stops || []).filter((s) => !s.reached);
      const pts = [{ lat, lon }, ...activeStops, appState.trip.destination];
      const coordStr = pts.map((p) => `${p.lon},${p.lat}`).join(';');
      const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`).then((x) => x.json());
      const route = r.routes?.[0];
      if (route) {
        appState.location.remainingMeters = Math.round(route.distance);
        appState.location.remainingSec = Math.round(route.duration);
        cachedRouteGeometry = route.geometry?.coordinates || [];
        if (activeStops.length > 0 && route.legs?.[0]) {
          appState.location.nextStop = {
            name: activeStops[0].name,
            remainingSec: Math.round(route.legs[0].duration),
          };
        } else {
          appState.location.nextStop = null;
        }
        renderHero();
        updateMap();
      }
    } catch {}
  }

  async function searchPlaces(query, nearby = false) {
    if (!query.trim()) return [];
    const lat = appState?.location?.lat;
    const lon = appState?.location?.lon;

    if (nearby && lat != null && lon != null) {
      try {
        const delta = 0.4;
        const viewbox = `${lon - delta},${lat + delta},${lon + delta},${lat - delta}`;
        const nomUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&viewbox=${viewbox}&bounded=1&limit=6`;
        const data = await fetch(nomUrl, { headers: { Accept: 'application/json' } }).then((r) => r.json());
        if (Array.isArray(data) && data.length) {
          return data
            .map((item) => {
              const rLat = Number(item.lat);
              const rLon = Number(item.lon);
              const primary = item.name || item.display_name.split(',')[0];
              const parts = item.display_name.split(',').map((s) => s.trim());
              return {
                name: primary,
                label: parts.slice(0, 3).join(', '),
                lat: rLat,
                lon: rLon,
                distanceMeters: Math.round(haversineMeters(lat, lon, rLat, rLon)),
              };
            })
            .sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
        }
      } catch {}
    }

    try {
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
          distanceMeters: lat != null && lon != null ? Math.round(haversineMeters(lat, lon, rLat, rLon)) : null,
        };
      });
    } catch { return []; }
  }

  function renderPlaceSearchResults(boxId, results, btnLabel, onSelect) {
    const box = document.getElementById(boxId);
    box.innerHTML = '';
    if (!results.length) {
      box.innerHTML = `<div style="padding:12px;" class="muted">No matching places found.</div>`;
      box.classList.remove('hidden');
      return;
    }
    results.forEach((r) => {
      const dist = r.distanceMeters != null ? ` • ${formatMiles(r.distanceMeters)}` : '';
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'search-item';
      item.innerHTML = `
        <div style="min-width:0;">
          <div style="font-weight:800; font-size:0.95rem;">${esc(r.name)}</div>
          <div class="muted" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(r.label)}${esc(dist)}</div>
        </div>
        <span class="btn btn-sm btn-lime">${esc(btnLabel)}</span>`;
      item.addEventListener('click', () => {
        box.classList.add('hidden');
        onSelect({ name: r.name, label: r.label, lat: r.lat, lon: r.lon });
      });
      box.appendChild(item);
    });
    box.classList.remove('hidden');
  }

  // =========================================================
  // RENDERING ALL MODULES
  // =========================================================
  function switchTab(tabName) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tabName}`));
    if (tabName === 'stops' && map) {
      setTimeout(() => map.invalidateSize(), 60);
    }
  }

  function openSheet(id) {
    document.getElementById(id)?.classList.remove('hidden');
  }

  function closeAllSheets() {
    document.querySelectorAll('.sheet-backdrop').forEach((el) => el.classList.add('hidden'));
  }

  function applyModuleVisibility() {
    if (!appState) return;
    const m = appState.modules;

    // Home Overview sections
    document.getElementById('home-locations-card').classList.toggle('hidden', !m.locations);
    document.getElementById('home-expenses-card').classList.toggle('hidden', !m.expenses);
    document.getElementById('home-playlist-card').classList.toggle('hidden', !m.playlist);
    document.getElementById('home-notes-card').classList.toggle('hidden', !m.notes);

    // Quick Action buttons on Home
    document.querySelectorAll('#home-quick-actions [data-requires]').forEach((el) => {
      const req = el.dataset.requires;
      el.classList.toggle('hidden', !m[req]);
    });

    // Bottom Navigation Tabs
    document.getElementById('nav-tab-stops').classList.toggle('hidden', !m.locations);
    document.getElementById('nav-tab-split').classList.toggle('hidden', !m.expenses);
    const showVibeTab = m.playlist || m.notes;
    document.getElementById('nav-tab-vibe').classList.toggle('hidden', !showVibeTab);

    const vibeLabel = document.getElementById('nav-vibe-label');
    if (m.playlist && m.notes) vibeLabel.textContent = 'Music & Notes';
    else if (m.playlist) vibeLabel.textContent = 'Playlist';
    else if (m.notes) vibeLabel.textContent = 'Notes';

    // Inside Vibe Tab
    document.getElementById('vibe-playlist-section').classList.toggle('hidden', !m.playlist);
    document.getElementById('vibe-notes-section').classList.toggle('hidden', !m.notes);
  }

  function renderWhoAndHeader() {
    if (!appState) return;
    const crew = appState.crew;
    document.getElementById('header-trip-name').textContent = appState.title || 'Trip';
    document.getElementById('header-lock-badge').classList.toggle('hidden', !appState.encrypted);
    document.getElementById('who-label').textContent = currentUser;

    const topAvatar = document.getElementById('who-avatar');
    topAvatar.textContent = currentUser.charAt(0).toUpperCase();
    topAvatar.className = `avatar-circle ${avatarClassFor(currentUser)}`;

    const grid = document.getElementById('who-grid');
    grid.innerHTML = '';
    crew.forEach((person) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `crew-choice${person === currentUser ? ' active' : ''}`;
      btn.innerHTML = `<div class="avatar-circle ${avatarClassFor(person)}" style="width:36px;height:36px;font-size:0.92rem;">${esc(person.charAt(0).toUpperCase())}</div><span>${esc(person)}</span>`;
      btn.addEventListener('click', () => {
        currentUser = person;
        localStorage.setItem('roadtrip_who', person);
        renderWhoAndHeader();
        renderExpensesModule();
        renderMessages();
        closeAllSheets();
      });
      grid.appendChild(btn);
    });
  }

  function renderWelcome() {
    if (!appState) return;
    const pill = document.getElementById('welcome-trip-pill');
    const heading = document.getElementById('welcome-trip-heading');
    pill.textContent = (appState.title || 'DANGEROUS.BUSINESS').toUpperCase();
    heading.textContent = appState.title || 'Welcome aboard!';

    const grid = document.getElementById('welcome-crew-grid');
    grid.innerHTML = '';
    appState.crew.forEach((person) => {
      const active = person === welcomeSelectedUser;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `welcome-crew-btn${active ? ' active' : ''}`;
      btn.innerHTML = `
        <div class="avatar-circle ${avatarClassFor(person)}">${esc(person.charAt(0).toUpperCase())}</div>
        <span>${esc(person)}</span>
        <span class="welcome-check" aria-hidden="true">✓</span>`;
      btn.addEventListener('click', () => {
        welcomeSelectedUser = person;
        renderWelcome();
      });
      grid.appendChild(btn);
    });

    const cta = document.getElementById('welcome-go-btn');
    if (welcomeSelectedUser) {
      cta.disabled = false;
      cta.innerHTML = `<span>Hop In as ${esc(welcomeSelectedUser)} →</span>`;
    } else {
      cta.disabled = true;
      cta.innerHTML = `<span>Tap your name above</span>`;
    }
  }

  function renderHero() {
    if (!appState) return;
    const loc = appState.location || {};
    const dest = appState.trip?.destination;
    document.getElementById('hero-dest-eyebrow').textContent = dest ? `TO ${String(dest.name).toUpperCase()}` : 'NO DESTINATION SET';

    const timeEl = document.getElementById('hero-time-left');
    if (loc.remainingSec != null) {
      timeEl.innerHTML = `${esc(formatDuration(loc.remainingSec))}<span class="unit">left</span>`;
    } else {
      timeEl.innerHTML = `—`;
    }
    document.getElementById('hero-eta-badge').textContent = loc.remainingSec != null ? `Arriving ${formatEtaClock(loc.remainingSec)}` : 'Set Dest for ETA';
    document.getElementById('hero-where').textContent = loc.whereAreWe || 'Tap "📍 Update GPS" above to stamp location';
    document.getElementById('hero-updated').textContent = `${formatAgo(loc.updatedAt)}${loc.reportedBy ? ' • ' + loc.reportedBy : ''}`;
    document.getElementById('progress-fill').style.width = `${loc.progressPct ?? 0}%`;

    document.getElementById('m-miles-left').textContent = formatMiles(loc.remainingMeters);
    document.getElementById('m-speed').textContent = loc.lat != null ? `${loc.speedMph ?? 0} mph` : '—';
    const activeStops = (appState.trip?.stops || []).filter((s) => !s.reached);
    document.getElementById('m-next-stop').textContent = activeStops[0]
      ? activeStops[0].name
      : (dest ? dest.name : 'None');
  }

  function drawDonutSvg(svgEl, people, stats, total) {
    if (!svgEl) return;
    const r = 38;
    const circ = 2 * Math.PI * r;
    if (total <= 0) {
      svgEl.innerHTML = `<circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="12" />`;
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
    svgEl.innerHTML = markup;
  }

  function renderExpensesModule() {
    if (!appState) return;
    const people = appState.crew;
    const txs = appState.expenses?.transactions || [];
    let total = 0;
    const stats = {};
    people.forEach((p) => { stats[p] = { paid: 0, sent: 0, received: 0 }; });

    txs.forEach((t) => {
      const amt = Number(t.amount || 0);
      if (t.type === 'expense') {
        total += amt;
        if (stats[t.payer]) stats[t.payer].paid += amt;
      } else if (t.type === 'payment') {
        if (stats[t.payer]) stats[t.payer].sent += amt;
        if (stats[t.payee]) stats[t.payee].received += amt;
      }
    });

    const share = people.length ? total / people.length : 0;
    document.getElementById('home-total-spent').textContent = `$${total.toFixed(2)}`;
    document.getElementById('split-total-display').textContent = `$${total.toFixed(2)}`;
    document.getElementById('split-per-person-display').textContent = `$${share.toFixed(2)}`;
    document.getElementById('split-tx-count').textContent = `${txs.length} item${txs.length === 1 ? '' : 's'}`;

    const my = stats[currentUser] || { paid: 0, sent: 0, received: 0 };
    const myNet = (my.paid - share) + (my.sent - my.received);
    const badge = document.getElementById('home-my-balance');
    if (myNet >= 0.5) {
      badge.className = 'balance-badge pos';
      badge.textContent = `${currentUser} gets back $${myNet.toFixed(0)}`;
    } else if (myNet <= -0.5) {
      badge.className = 'balance-badge neg';
      badge.textContent = `${currentUser} owes $${Math.abs(myNet).toFixed(0)}`;
    } else {
      badge.className = 'balance-badge even';
      badge.textContent = `${currentUser} is all even`;
    }

    drawDonutSvg(document.getElementById('home-donut'), people, stats, total);
    drawDonutSvg(document.getElementById('split-donut'), people, stats, total);

    // Balance Grid & Settlement Math
    const balances = [];
    const balGrid = document.getElementById('split-balance-grid');
    balGrid.innerHTML = '';
    people.forEach((name) => {
      const s = stats[name] || { paid: 0, sent: 0, received: 0 };
      const net = (s.paid - share) + (s.sent - s.received);
      balances.push({ name, amount: net });
      const isPos = net >= 0.01;
      const isNeg = net <= -0.01;
      const col = isPos ? 'var(--lime)' : (isNeg ? 'var(--coral)' : 'var(--muted)');
      const lbl = isPos ? 'GETS BACK' : (isNeg ? 'OWES' : 'EVEN');
      const cell = document.createElement('div');
      cell.className = 'split-bal-cell';
      cell.innerHTML = `
        <div style="font-weight:800; font-size:0.95rem;">${esc(name)}</div>
        <div style="font-size:0.68rem; font-weight:800; color:var(--muted); margin-top:2px;">${lbl}</div>
        <div style="font-weight:800; font-size:1.12rem; color:${col}; margin-top:2px;">$${Math.abs(net).toFixed(0)}</div>`;
      balGrid.appendChild(cell);
    });

    const settleBox = document.getElementById('split-settlement-list');
    settleBox.innerHTML = '';
    const debtors = balances.filter((b) => b.amount < -0.01).map((b) => ({ ...b })).sort((a, b) => a.amount - b.amount);
    const creditors = balances.filter((b) => b.amount > 0.01).map((b) => ({ ...b })).sort((a, b) => b.amount - a.amount);

    if (!debtors.length || !creditors.length) {
      settleBox.innerHTML = `<div class="muted" style="text-align:center; padding:8px 0;">Everyone is all squared up!</div>`;
    } else {
      let dIdx = 0;
      let cIdx = 0;
      while (dIdx < debtors.length && cIdx < creditors.length) {
        const d = debtors[dIdx];
        const c = creditors[cIdx];
        const amt = Math.min(Math.abs(d.amount), c.amount);
        if (amt > 0.01) {
          const row = document.createElement('div');
          row.className = 'settle-row';
          row.innerHTML = `
            <div>
              <strong style="color:var(--coral);">${esc(d.name)}</strong>
              <span class="muted" style="margin:0 6px;">pays</span>
              <strong style="color:var(--lime);">${esc(c.name)}</strong>
            </div>
            <strong style="font-size:1.1rem;">$${amt.toFixed(2)}</strong>`;
          settleBox.appendChild(row);
        }
        d.amount += amt;
        c.amount -= amt;
        if (Math.abs(d.amount) < 0.01) dIdx++;
        if (c.amount < 0.01) cIdx++;
      }
    }

    // Expense Log
    const txList = document.getElementById('split-tx-list');
    txList.innerHTML = '';
    if (!txs.length) {
      txList.innerHTML = `<div class="muted" style="text-align:center; padding:12px 0;">No expenses yet — tap "+ Add Expense" above!</div>`;
      return;
    }

    [...txs].sort((a, b) => Number(b.id) - Number(a.id)).forEach((t) => {
      const isExp = t.type === 'expense';
      const row = document.createElement('div');
      row.className = 'tx-row';
      row.innerHTML = `
        <div style="min-width:0; flex:1;">
          <div style="font-weight:800; font-size:1rem;">${esc(t.description)}</div>
          <div class="muted">
            ${isExp ? `Paid by <strong>${esc(t.payer)}</strong>` : `<strong>${esc(t.payer)}</strong> → <strong>${esc(t.payee)}</strong>`}
          </div>
        </div>
        <div style="text-align:right; flex-shrink:0;">
          <div style="font-weight:800; font-size:1.08rem;">$${Number(t.amount).toFixed(2)}</div>
          <div style="display:flex; gap:6px; justify-content:flex-end; margin-top:4px;">
            <button type="button" class="subtle-pill-btn edit-tx-btn" style="padding:2px 8px; font-size:0.7rem;">Edit</button>
            <button type="button" class="subtle-pill-btn del-tx-btn" style="padding:2px 8px; font-size:0.7rem; color:var(--coral);">Delete</button>
          </div>
        </div>`;
      row.querySelector('.edit-tx-btn').addEventListener('click', () => openExpenseModal(t.type, t));
      row.querySelector('.del-tx-btn').addEventListener('click', async () => {
        appState.expenses.transactions = appState.expenses.transactions.filter((x) => x.id !== t.id);
        if (!appState.expenses.deletedIds.includes(t.id)) appState.expenses.deletedIds.push(t.id);
        renderExpensesModule();
        updateBadges();
        await syncStateToUrl(`Deleted ${t.description}`);
      });
      txList.appendChild(row);
    });
  }

  function openExpenseModal(type = 'expense', existingTx = null) {
    const people = appState?.crew || ['Tim'];
    const payerSel = document.getElementById('tx-payer');
    const payeeSel = document.getElementById('tx-payee');
    payerSel.innerHTML = people.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    payeeSel.innerHTML = people.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');

    document.getElementById('tx-type').value = type;
    document.getElementById('tx-edit-id').value = existingTx ? String(existingTx.id) : '';
    document.getElementById('expense-sheet-title').textContent = existingTx
      ? 'Edit Entry'
      : (type === 'payment' ? 'Record Payback' : 'Add Expense');

    document.getElementById('tx-desc-wrap').classList.toggle('hidden', type === 'payment');
    document.getElementById('tx-payee-wrap').classList.toggle('hidden', type !== 'payment');
    document.getElementById('tx-payer-label').textContent = type === 'payment' ? 'Who paid?' : 'Paid by';

    if (existingTx) {
      document.getElementById('tx-desc').value = existingTx.description || '';
      document.getElementById('tx-amount').value = existingTx.amount || '';
      payerSel.value = existingTx.payer || currentUser;
      if (existingTx.payee) payeeSel.value = existingTx.payee;
    } else {
      document.getElementById('tx-desc').value = '';
      document.getElementById('tx-amount').value = '';
      payerSel.value = people.includes(currentUser) ? currentUser : people[0];
      payeeSel.value = people.find((p) => p !== payerSel.value) || people[0];
    }

    openSheet('sheet-expense');
  }

  // =========================================================
  // PLAYLIST EMBED ENGINE (YOUTUBE / SPOTIFY / APPLE MUSIC)
  // =========================================================
  function parsePlaylistEmbedInfo(rawUrl) {
    const url = String(rawUrl || '').trim() || DEFAULT_PLAYLIST_URL;
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();

      // Spotify Playlist / Album
      if (host.includes('spotify.com')) {
        const m = u.pathname.match(/\/(playlist|album|track)\/([a-zA-Z0-9]+)/);
        if (m) {
          return {
            service: 'Spotify',
            embedUrl: `https://open.spotify.com/embed/${m[1]}/${m[2]}?utm_source=generator&theme=0`,
            openUrl: url,
          };
        }
      }

      // Apple Music Playlist
      if (host.includes('music.apple.com')) {
        return {
          service: 'Apple Music',
          embedUrl: url.replace('https://music.apple.com/', 'https://embed.music.apple.com/'),
          openUrl: url,
        };
      }

      // YouTube / YouTube Music Playlist
      const listId = u.searchParams.get('list');
      if (listId) {
        return {
          service: 'YouTube Music',
          embedUrl: `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(listId)}&rel=0`,
          openUrl: url,
        };
      }

      const vId = u.searchParams.get('v') || (host === 'youtu.be' ? u.pathname.slice(1) : null);
      if (vId) {
        return {
          service: 'YouTube',
          embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(vId)}?rel=0`,
          openUrl: url,
        };
      }
    } catch {}

    return {
      service: 'Music Playlist',
      embedUrl: `https://www.youtube.com/embed/videoseries?list=PLO6qnlYSFTDc&rel=0`,
      openUrl: url,
    };
  }

  let lastRenderedEmbedUrl = null;
  function renderPlaylistModule() {
    if (!appState) return;
    const collabHref = appState.music?.collabUrl || DEFAULT_PLAYLIST_URL;
    const title = appState.music?.playlistTitle || 'Shared Playlist';
    const info = parsePlaylistEmbedInfo(collabHref);

    ['qa-song-btn', 'home-music-link', 'vibe-edit-playlist-link'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.href = info.openUrl;
    });

    document.getElementById('home-music-title').textContent = title;
    document.getElementById('home-music-sub').textContent = `Tap to open & edit in ${info.service}`;
    document.getElementById('vibe-playlist-heading').textContent = title;
    document.getElementById('vibe-edit-playlist-link').textContent = `+ Add or Edit Songs in ${info.service} ↗`;

    const wrap = document.getElementById('playlist-embed-wrap');
    if (wrap && lastRenderedEmbedUrl !== info.embedUrl) {
      lastRenderedEmbedUrl = info.embedUrl;
      wrap.innerHTML = `<iframe src="${esc(info.embedUrl)}" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy" title="${esc(title)}"></iframe>`;
    }
  }

  // =========================================================
  // STOPS, MAP & NOTES
  // =========================================================
  function renderStops() {
    if (!appState) return;
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
      list.innerHTML = `<p class="muted" style="text-align:center; padding:8px 0;">Set a destination or pick a quick pit stop above.</p>`;
      return;
    }

    stops.forEach((s, idx) => {
      const row = document.createElement('div');
      row.className = `stop-row${s.reached ? ' reached' : ''}`;
      row.innerHTML = `
        <div style="min-width:0;">
          <div class="stop-name" style="font-weight:800; font-size:0.96rem;">Stop ${idx + 1}: ${esc(s.name)}</div>
          <div class="muted">Added by ${esc(s.addedBy || 'Crew')}</div>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button class="subtle-pill-btn toggle-stop" type="button">${s.reached ? 'Undo' : '✓ Done'}</button>
          <button class="subtle-pill-btn remove-stop" type="button">✕</button>
        </div>`;
      row.querySelector('.toggle-stop').addEventListener('click', async () => {
        s.reached = !s.reached;
        renderHero();
        renderStops();
        updateMap();
        await syncStateToUrl(`Marked stop "${s.name}" ${s.reached ? 'done' : 'active'}`);
      });
      row.querySelector('.remove-stop').addEventListener('click', async () => {
        appState.trip.stops = appState.trip.stops.filter((x) => x.id !== s.id);
        if (!appState.trip.deletedStopIds.includes(s.id)) appState.trip.deletedStopIds.push(s.id);
        renderHero();
        renderStops();
        updateMap();
        updateBadges();
        await syncStateToUrl(`Removed stop "${s.name}"`);
      });
      list.appendChild(row);
    });

    if (dest) {
      const destRow = document.createElement('div');
      destRow.className = 'stop-row';
      destRow.style.borderColor = 'rgba(200, 255, 61, 0.35)';
      destRow.innerHTML = `
        <div style="min-width:0;">
          <div style="font-weight:800; color:var(--lime);">🏁 ${esc(dest.name)}</div>
          <div class="muted">${esc(dest.label || '')}${loc.remainingSec != null ? ' • ' + formatDuration(loc.remainingSec) + ' left' : ''}</div>
        </div>
        <button class="subtle-pill-btn edit-dest-inline" type="button">Edit</button>`;
      destRow.querySelector('.edit-dest-inline').addEventListener('click', () => openSheet('sheet-dest'));
      list.appendChild(destRow);
    }
  }

  function initMap() {
    if (map) return;
    const mapEl = document.getElementById('map');
    if (!mapEl) return;
    map = L.map('map', { zoomControl: false }).setView([43.156, -85.710], 6);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri',
    }).addTo(map);
    stopMarkersLayer = L.layerGroup().addTo(map);
    routeLayer = L.polyline([], { color: '#9D7BFF', weight: 4, opacity: 0.85 }).addTo(map);
  }

  function updateMap() {
    if (!map || !appState) return;
    const loc = appState.location || {};
    const dest = appState.trip?.destination;
    const stops = appState.trip?.stops || [];

    routeLayer.setLatLngs(cachedRouteGeometry.length ? cachedRouteGeometry.map(([lon, lat]) => [lat, lon]) : []);

    stopMarkersLayer.clearLayers();
    stops.forEach((s, i) => {
      L.circleMarker([s.lat, s.lon], {
        radius: 7,
        color: '#07080D',
        fillColor: s.reached ? '#64748B' : '#FBBF24',
        fillOpacity: 1,
        weight: 2,
      }).bindPopup(`<b>Stop ${i + 1}: ${esc(s.name)}</b>`).addTo(stopMarkersLayer);
    });

    if (dest) {
      if (!destMarker) {
        destMarker = L.circleMarker([dest.lat, dest.lon], { radius: 8, color: '#07080D', fillColor: '#FB7185', fillOpacity: 1, weight: 2 }).addTo(map);
      } else {
        destMarker.setLatLng([dest.lat, dest.lon]);
      }
    } else if (destMarker) {
      map.removeLayer(destMarker);
      destMarker = null;
    }

    if (loc.lat != null && loc.lon != null) {
      if (!carMarker) {
        carMarker = L.circleMarker([loc.lat, loc.lon], { radius: 9, color: '#07080D', fillColor: '#C8FF3D', fillOpacity: 1, weight: 3 }).addTo(map);
      } else {
        carMarker.setLatLng([loc.lat, loc.lon]);
      }
    }
  }

  function renderMessages() {
    if (!appState) return;
    const msgs = appState.messages || [];

    // Home preview
    const homeBox = document.getElementById('home-latest-msgs');
    const recent = msgs.slice(-2);
    if (!recent.length) {
      homeBox.innerHTML = `<div class="muted" style="text-align:center; padding:6px 0;">No crew notes yet — tap Post Note above to share codes or updates!</div>`;
    } else {
      homeBox.innerHTML = recent.map((m) => `
        <div class="msg-bubble" style="margin-bottom:6px;">
          <div class="msg-top"><span class="msg-author">${esc(m.author)}</span><span>${m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</span></div>
          <div style="font-size:0.94rem;">${esc(m.text)}</div>
        </div>`).join('');
    }

    // Full list
    const list = document.getElementById('msg-list');
    list.innerHTML = '';
    if (!msgs.length) {
      list.innerHTML = `<p class="muted" style="text-align:center; padding:12px 0;">No notes yet — post Airbnb codes, meetup times, or road updates below.</p>`;
      return;
    }
    msgs.forEach((m) => {
      const bubble = document.createElement('div');
      bubble.className = `msg-bubble${m.author === currentUser ? ' mine' : ''}`;
      const time = m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      bubble.innerHTML = `
        <div class="msg-top">
          <span class="msg-author">${esc(m.author)}</span>
          <span>${esc(time)}</span>
        </div>
        <div style="font-size:0.96rem;">${esc(m.text)}</div>
        ${m.whereAreWe && !m.whereAreWe.startsWith('Tap ') ? `<div class="msg-loc">📍 ${esc(m.whereAreWe)}</div>` : ''}`;
      list.appendChild(bubble);
    });
  }

  function renderModulesSettingsSheet() {
    if (!appState) return;
    document.getElementById('settings-trip-title').value = appState.title || '';
    document.getElementById('settings-password-input').value = activePassword || '';
    document.getElementById('settings-enc-status').textContent = appState.encrypted
      ? '🔒 Currently encrypted with AES-256-GCM. Clear password and click Apply to switch to a standard link.'
      : '🔗 Currently using a standard unencrypted link. Enter a password and click Apply to encrypt.';

    const hasBackup = Boolean(localStorage.getItem(`db_backup_${appState.id}`));
    document.getElementById('settings-restore-backup-btn')?.classList.toggle('hidden', !hasBackup);

    const defs = [
      { key: 'locations', ico: '📍', name: 'Trip Locations & Stops', desc: 'Live ETA, GPS readout, pit stops & map' },
      { key: 'expenses', ico: '💳', name: 'Trip Expense Splitter', desc: 'Split tabs, donut chart & settlements' },
      { key: 'playlist', ico: '🎵', name: 'Shared Music Playlist', desc: 'YouTube Music, Spotify, or Apple Music' },
      { key: 'notes', ico: '💬', name: 'Crew Notes & Board', desc: 'Pin codes, meetup spots & car notes' },
    ];
    const grid = document.getElementById('settings-module-grid');
    grid.innerHTML = '';
    defs.forEach((d) => {
      const on = Boolean(appState.modules[d.key]);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `wiz-mod-toggle${on ? ' active' : ''}`;
      btn.innerHTML = `
        <div class="wiz-mod-ico">${d.ico}</div>
        <div class="wiz-mod-body">
          <div class="wiz-mod-name">${esc(d.name)}</div>
          <div class="wiz-mod-desc">${esc(d.desc)}</div>
        </div>
        <div class="wiz-mod-check">✓</div>`;
      btn.addEventListener('click', async () => {
        appState.modules[d.key] = !appState.modules[d.key];
        renderModulesSettingsSheet();
        applyModuleVisibility();
        await syncStateToUrl(`${appState.modules[d.key] ? 'Enabled' : 'Hidden'} ${d.name}`);
      });
      grid.appendChild(btn);
    });
  }

  function updateBadges() {
    if (!appState) return;
    const setBadge = (id, num) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = String(num);
      el.classList.toggle('hidden', num <= 0);
    };
    setBadge('badge-stops', (appState.trip?.stops || []).filter((s) => !s.reached).length);
    setBadge('badge-tx', (appState.expenses?.transactions || []).length);
    setBadge('badge-vibe', (appState.messages || []).length);
  }

  // =========================================================
  // PWA ADD TO HOME SCREEN
  // =========================================================
  function isStandalone() {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches ||
      window.matchMedia?.('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true
    );
  }

  function isIosDevice() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function wasInstallDismissed() {
    try {
      const ts = Number(localStorage.getItem(A2HS_DISMISS_KEY) || 0);
      return ts > 0 && Date.now() - ts < 12 * 60 * 60 * 1000;
    } catch { return false; }
  }

  function updateInstallUI() {
    const standalone = isStandalone();
    const banner = document.getElementById('install-banner');
    const whoBtn = document.getElementById('who-install-btn');
    if (whoBtn) whoBtn.classList.toggle('hidden', standalone);
    if (!banner) return;
    banner.classList.toggle('hidden', standalone || wasInstallDismissed());
  }

  function openInstallGuideSheet() {
    const list = document.getElementById('install-steps-list');
    const ios = isIosDevice();
    list.innerHTML = ios
      ? `<div class="install-step"><div class="install-step-num">1</div><div><div style="font-weight:800;">Tap the Share button in Safari</div><div class="muted">Square with an up-arrow at the bottom of the screen</div></div></div>
         <div class="install-step"><div class="install-step-num">2</div><div><div style="font-weight:800;">Tap "Add to Home Screen"</div><div class="muted">Opens full-screen like a native app</div></div></div>`
      : `<div class="install-step"><div class="install-step-num">1</div><div><div style="font-weight:800;">Open your browser menu (⋮)</div><div class="muted">Top corner of Chrome, Edge, or Samsung Internet</div></div></div>
         <div class="install-step"><div class="install-step-num">2</div><div><div style="font-weight:800;">Tap "Add to Home screen" or "Install app"</div><div class="muted">Saves Dangerous.Business to your phone</div></div></div>`;
    openSheet('sheet-install');
  }

  async function triggerInstall() {
    if (deferredInstallPrompt) {
      try {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        updateInstallUI();
        return;
      } catch {}
    }
    openInstallGuideSheet();
  }

  function renderAll() {
    if (!appState) return;
    applyModuleVisibility();
    renderWhoAndHeader();
    renderWelcome();
    renderHero();
    renderExpensesModule();
    renderPlaylistModule();
    renderStops();
    updateMap();
    renderMessages();
    updateBadges();
    updateInstallUI();
    updateShareBarUI();
  }

  // =========================================================
  // EVENT BINDINGS
  // =========================================================
  function bindEvents() {
    window.addEventListener('hashchange', () => handleHashRoute());

    // Landing Page Buttons
    ['nav-start-btn', 'hero-start-btn', 'footer-start-btn'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', openNewTripWizard);
    });

    ['nav-demo-btn', 'hero-demo-btn', 'footer-demo-btn'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', async () => {
        const demo = createDemoTripState();
        localStorage.setItem(`db_welcomed_${demo.id}`, '1');
        enterAppWithState(demo, null, true);
        await syncStateToUrl(null);
        showToast('Loaded Live Demo Trip!');
      });
    });

    document.getElementById('resume-trip-btn')?.addEventListener('click', async () => {
      try {
        const saved = JSON.parse(localStorage.getItem(LAST_TRIP_STORAGE_KEY) || 'null');
        if (saved) {
          const cachedPw = sessionStorage.getItem(`db_pw_${saved.id}`) || null;
          enterAppWithState(saved, cachedPw, true);
          await syncStateToUrl(null);
        }
      } catch {}
    });

    // Smart Merge Confirmation Modal Buttons
    document.getElementById('merge-confirm-btn')?.addEventListener('click', () => {
      if (!pendingMergeContext) return;
      const { local, merged, passwordUsed } = pendingMergeContext;
      try { localStorage.setItem(`db_backup_${local.id}`, JSON.stringify(local)); } catch {}
      pendingMergeContext = null;
      finalizeEnterApp(merged, passwordUsed, 'Smart Merge complete (backup saved)!');
    });

    document.getElementById('merge-keep-local-btn')?.addEventListener('click', () => {
      if (!pendingMergeContext) return;
      const { local, passwordUsed } = pendingMergeContext;
      pendingMergeContext = null;
      finalizeEnterApp(local, passwordUsed, 'Kept your device version!');
    });

    document.getElementById('merge-use-incoming-btn')?.addEventListener('click', () => {
      if (!pendingMergeContext) return;
      const { local, incoming, passwordUsed } = pendingMergeContext;
      try { localStorage.setItem(`db_backup_${local.id}`, JSON.stringify(local)); } catch {}
      pendingMergeContext = null;
      finalizeEnterApp(incoming, passwordUsed, 'Loaded incoming link (backup saved)!');
    });

    document.getElementById('settings-restore-backup-btn')?.addEventListener('click', async () => {
      if (!appState) return;
      try {
        const raw = localStorage.getItem(`db_backup_${appState.id}`);
        if (raw) {
          const backup = JSON.parse(raw);
          closeAllSheets();
          finalizeEnterApp(backup, activePassword, 'Restored pre-merge backup!');
        }
      } catch {}
    });

    const goLanding = () => {
      suppressHashEvent = true;
      window.history.pushState(null, '', window.location.pathname);
      setTimeout(() => { suppressHashEvent = false; }, 50);
      showLandingView();
    };
    document.getElementById('top-landing-btn')?.addEventListener('click', goLanding);
    document.getElementById('unlock-back-home-btn')?.addEventListener('click', goLanding);

    // Wizard Controls
    document.getElementById('wiz-close-btn')?.addEventListener('click', () => {
      document.getElementById('wizard-modal').classList.add('hidden');
    });
    document.querySelectorAll('.wiz-title-preset').forEach((b) => {
      b.addEventListener('click', () => {
        document.getElementById('wiz-trip-title').value = b.dataset.title;
      });
    });

    const addWizPerson = () => {
      const inp = document.getElementById('wiz-person-input');
      const val = inp.value.trim();
      if (val && !wizState.crew.includes(val)) {
        wizState.crew.push(val);
        inp.value = '';
        renderWizard();
      }
    };
    document.getElementById('wiz-add-person-btn')?.addEventListener('click', addWizPerson);
    document.getElementById('wiz-person-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addWizPerson(); }
    });

    document.querySelectorAll('#wiz-step-2 .wiz-mod-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = btn.dataset.mod;
        wizState.modules[m] = !wizState.modules[m];
        if (!Object.values(wizState.modules).some(Boolean)) {
          wizState.modules[m] = true;
          showToast('Select at least 1 module');
        }
        renderWizard();
      });
    });

    const runWizDestSearch = async () => {
      const q = document.getElementById('wiz-dest-input').value;
      const results = await searchPlaces(q, false);
      renderPlaceSearchResults('wiz-dest-results', results, 'Select', (place) => {
        wizState.destination = place;
        const pill = document.getElementById('wiz-dest-selected');
        pill.textContent = `🏁 Destination: ${place.label || place.name}`;
        pill.classList.remove('hidden');
      });
    };
    document.getElementById('wiz-dest-search-btn')?.addEventListener('click', runWizDestSearch);
    document.getElementById('wiz-dest-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runWizDestSearch(); }
    });

    document.getElementById('wiz-sample-playlist-btn')?.addEventListener('click', () => {
      document.getElementById('wiz-playlist-url').value = DEFAULT_PLAYLIST_URL;
      document.getElementById('wiz-playlist-title').value = 'Dangerous.Business';
    });

    document.getElementById('wiz-sec-standard')?.addEventListener('click', () => {
      wizState.security = 'standard';
      renderWizard();
    });
    document.getElementById('wiz-sec-encrypted')?.addEventListener('click', () => {
      wizState.security = 'encrypted';
      renderWizard();
    });

    document.getElementById('wiz-back-btn')?.addEventListener('click', () => {
      if (wizStep > 1) { wizStep -= 1; renderWizard(); }
    });
    document.getElementById('wiz-next-btn')?.addEventListener('click', () => {
      if (wizStep < 4) { wizStep += 1; renderWizard(); }
      else finishWizardAndLaunch();
    });

    // Encrypted Unlock Modal
    document.getElementById('unlock-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('unlock-password-input').value;
      try {
        const decrypted = await decryptHashToState(pendingEncryptedPayload, pw);
        enterAppWithState(decrypted, pw);
      } catch {
        document.getElementById('unlock-error').classList.remove('hidden');
      }
    });

    // Welcome Splash
    document.getElementById('welcome-go-btn')?.addEventListener('click', () => {
      if (!welcomeSelectedUser || !appState) return;
      currentUser = welcomeSelectedUser;
      localStorage.setItem('roadtrip_who', currentUser);
      localStorage.setItem(`db_welcomed_${appState.id}`, '1');
      document.getElementById('welcome-splash').classList.add('hidden');
      renderAll();
    });
    document.getElementById('who-welcome-btn')?.addEventListener('click', () => {
      closeAllSheets();
      welcomeSelectedUser = currentUser;
      renderWelcome();
      document.getElementById('welcome-splash').classList.remove('hidden');
    });

    // Share the Update Triggers
    document.getElementById('primary-share-update-btn')?.addEventListener('click', openShareDialog);
    document.querySelectorAll('.share-trigger-btn').forEach((b) => b.addEventListener('click', openShareDialog));
    document.getElementById('native-share-dialog-btn')?.addEventListener('click', triggerNativeShare);
    document.getElementById('copy-url-btn')?.addEventListener('click', () => copyShareUrl(false));
    document.getElementById('copy-msg-url-btn')?.addEventListener('click', () => copyShareUrl(true));

    // App Navigation & Sheets
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    document.getElementById('home-goto-split')?.addEventListener('click', () => switchTab('split'));
    document.getElementById('home-goto-music')?.addEventListener('click', () => switchTab('vibe'));
    document.getElementById('home-goto-notes')?.addEventListener('click', () => switchTab('vibe'));

    document.getElementById('who-picker-btn')?.addEventListener('click', () => openSheet('sheet-who'));
    document.getElementById('split-edit-crew-btn')?.addEventListener('click', () => openSheet('sheet-who'));
    document.getElementById('open-modules-sheet-btn')?.addEventListener('click', () => {
      renderModulesSettingsSheet();
      openSheet('sheet-modules');
    });

    document.getElementById('who-add-btn')?.addEventListener('click', async () => {
      const inp = document.getElementById('who-add-input');
      const name = inp.value.trim();
      if (name && appState && !appState.crew.includes(name)) {
        appState.crew.push(name);
        inp.value = '';
        renderAll();
        await syncStateToUrl(`Added ${name} to crew`);
      }
    });

    // Quick Action Buttons
    document.getElementById('qa-stop-btn')?.addEventListener('click', () => openSheet('sheet-stop'));
    document.getElementById('stops-search-open-btn')?.addEventListener('click', () => openSheet('sheet-stop'));
    document.getElementById('qa-cost-btn')?.addEventListener('click', () => openExpenseModal('expense', null));
    document.getElementById('split-add-expense-btn')?.addEventListener('click', () => openExpenseModal('expense', null));
    document.getElementById('split-add-payment-btn')?.addEventListener('click', () => openExpenseModal('payment', null));
    document.getElementById('qa-msg-btn')?.addEventListener('click', () => openSheet('sheet-msg'));
    document.getElementById('open-note-sheet-btn')?.addEventListener('click', () => openSheet('sheet-msg'));
    document.getElementById('open-dest-sheet-btn')?.addEventListener('click', () => openSheet('sheet-dest'));

    // Expense Form Submit
    document.querySelectorAll('.tx-preset-chip').forEach((c) => {
      c.addEventListener('click', () => { document.getElementById('tx-desc').value = c.dataset.desc; });
    });

    document.getElementById('expense-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!appState) return;
      const type = document.getElementById('tx-type').value;
      const editId = document.getElementById('tx-edit-id').value;
      const amount = Number(document.getElementById('tx-amount').value);
      const payer = document.getElementById('tx-payer').value;
      const payee = document.getElementById('tx-payee').value;
      const rawDesc = document.getElementById('tx-desc').value.trim();
      const description = type === 'payment' ? `Repayment: ${payer} → ${payee}` : (rawDesc || 'Trip Expense');

      if (!Number.isFinite(amount) || amount <= 0) return;

      if (editId) {
        const numId = Number(editId);
        appState.expenses.transactions = appState.expenses.transactions.map((t) =>
          t.id === numId ? { ...t, type, description, amount, payer, payee: type === 'payment' ? payee : undefined, updatedAt: Date.now() } : t
        );
      } else {
        appState.expenses.transactions.push({
          id: Date.now(),
          type,
          description,
          amount,
          payer,
          payee: type === 'payment' ? payee : undefined,
          updatedAt: Date.now(),
        });
      }

      closeAllSheets();
      renderExpensesModule();
      updateBadges();
      await syncStateToUrl(`${payer}: ${description} ($${amount.toFixed(2)})`);
    });

    // GPS & Places
    document.getElementById('gps-snap-btn')?.addEventListener('click', stampMyGpsLocation);
    document.getElementById('stops-gps-btn')?.addEventListener('click', stampMyGpsLocation);

    const runDestSearch = async () => {
      const q = document.getElementById('sheet-dest-input').value;
      const results = await searchPlaces(q, false);
      renderPlaceSearchResults('sheet-dest-results', results, 'Set', async (place) => {
        closeAllSheets();
        appState.trip.destination = place;
        if (appState.location.lat != null) await computeBrowserRouteEta(appState.location.lat, appState.location.lon);
        renderAll();
        await syncStateToUrl(`Destination set to ${place.name}`);
      });
    };
    document.getElementById('sheet-dest-btn')?.addEventListener('click', runDestSearch);
    document.getElementById('sheet-dest-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runDestSearch(); }
    });

    const runStopSearch = async (query, nearby, boxId) => {
      const results = await searchPlaces(query, nearby);
      renderPlaceSearchResults(boxId, results, 'Add', async (place) => {
        document.getElementById('sheet-stop-input').value = '';
        closeAllSheets();
        appState.trip.stops.push({ ...place, id: 'stop_' + Date.now(), addedBy: currentUser, reached: false });
        if (appState.location.lat != null) await computeBrowserRouteEta(appState.location.lat, appState.location.lon);
        renderAll();
        await syncStateToUrl(`Added stop: ${place.name}`);
      });
    };
    document.getElementById('sheet-stop-btn')?.addEventListener('click', () => runStopSearch(document.getElementById('sheet-stop-input').value, false, 'sheet-stop-results'));
    document.querySelectorAll('.sheet-pit-chip').forEach((c) => c.addEventListener('click', () => runStopSearch(c.dataset.q, true, 'sheet-stop-results')));
    document.querySelectorAll('.quick-stop-chip').forEach((c) => c.addEventListener('click', () => runStopSearch(c.dataset.q, true, 'stops-tab-results')));

    document.getElementById('center-map-btn')?.addEventListener('click', () => {
      if (map && appState?.location?.lat != null) map.setView([appState.location.lat, appState.location.lon], 10);
    });

    // Playlist Editor Sheet
    document.getElementById('edit-playlist-url-btn')?.addEventListener('click', () => {
      document.getElementById('sheet-playlist-title').value = appState?.music?.playlistTitle || '';
      document.getElementById('sheet-playlist-url').value = appState?.music?.collabUrl || '';
      openSheet('sheet-playlist');
    });
    document.getElementById('sheet-playlist-save-btn')?.addEventListener('click', async () => {
      if (!appState) return;
      appState.music.playlistTitle = document.getElementById('sheet-playlist-title').value.trim() || 'Shared Playlist';
      appState.music.collabUrl = document.getElementById('sheet-playlist-url').value.trim() || DEFAULT_PLAYLIST_URL;
      closeAllSheets();
      renderPlaylistModule();
      await syncStateToUrl(`Updated playlist: ${appState.music.playlistTitle}`);
    });

    // Settings Sheet Actions
    document.getElementById('settings-save-title-btn')?.addEventListener('click', async () => {
      const val = document.getElementById('settings-trip-title').value.trim();
      if (val && appState) {
        appState.title = val;
        renderWhoAndHeader();
        await syncStateToUrl(`Renamed trip to "${val}"`);
      }
    });
    document.getElementById('settings-save-password-btn')?.addEventListener('click', async () => {
      if (!appState) return;
      const pw = document.getElementById('settings-password-input').value;
      if (pw) {
        activePassword = pw;
        appState.encrypted = true;
        try { sessionStorage.setItem(`db_pw_${appState.id}`, pw); } catch {}
        await syncStateToUrl('Enabled AES-256 URL password encryption');
      } else {
        activePassword = null;
        appState.encrypted = false;
        await syncStateToUrl('Switched to standard unencrypted URL');
      }
      renderWhoAndHeader();
      renderModulesSettingsSheet();
    });
    document.getElementById('settings-new-trip-btn')?.addEventListener('click', () => {
      closeAllSheets();
      openNewTripWizard();
    });
    document.getElementById('settings-go-landing-btn')?.addEventListener('click', () => {
      closeAllSheets();
      goLanding();
    });

    // Crew Notes
    const addNote = async (text) => {
      if (!text.trim() || !appState) return;
      appState.messages.push({
        id: 'msg_' + Date.now(),
        author: currentUser,
        text: text.trim(),
        createdAt: new Date().toISOString(),
        whereAreWe: appState.location?.whereAreWe || '',
      });
      renderMessages();
      updateBadges();
      await syncStateToUrl(`${currentUser}: "${text.trim().slice(0, 28)}"`);
    };
    document.getElementById('msg-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = document.getElementById('msg-input');
      const v = inp.value; inp.value = '';
      addNote(v);
    });
    document.querySelectorAll('.quick-msg-chip').forEach((c) => c.addEventListener('click', () => addNote(c.textContent)));
    document.getElementById('sheet-msg-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = document.getElementById('sheet-msg-input');
      const v = inp.value; inp.value = '';
      closeAllSheets();
      addNote(v);
    });
    document.querySelectorAll('.sheet-quick-msg').forEach((c) => {
      c.addEventListener('click', () => { closeAllSheets(); addNote(c.textContent); });
    });

    // Install PWA
    document.getElementById('install-banner-btn')?.addEventListener('click', triggerInstall);
    document.getElementById('who-install-btn')?.addEventListener('click', () => { closeAllSheets(); triggerInstall(); });
    document.getElementById('install-banner-close')?.addEventListener('click', () => {
      try { localStorage.setItem(A2HS_DISMISS_KEY, String(Date.now())); } catch {}
      updateInstallUI();
    });
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; updateInstallUI(); });

    // Close sheets
    document.querySelectorAll('.close-sheet-btn').forEach((b) => b.addEventListener('click', closeAllSheets));
    document.querySelectorAll('.sheet-backdrop').forEach((bd) => {
      bd.addEventListener('click', (e) => { if (e.target === bd) closeAllSheets(); });
    });
  }

  function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    bindEvents();
    handleHashRoute();
  }

  init();
})();
