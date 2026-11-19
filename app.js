(() => {
  'use strict';

  const DEFAULT_PLAYLIST_URL = 'https://music.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';
  const DONUT_COLORS = ['#C8FF3D', '#9D7BFF', '#56CCF2', '#FB7185', '#FBBF24', '#34D399'];
  const LAST_TRIP_STORAGE_KEY = 'db_last_trip_state_v4';
  const BACKUPS_LIST_KEY = 'db_backups_list_v1';
  const A2HS_DISMISS_KEY = 'roadtrip_a2hs_dismissed_v1';

  let appState = null;
  let activePassword = null;
  let pendingEncryptedPayload = null;
  let pendingAiPatchObj = null;
  let pendingMergeContext = null;
  let pendingRestoreEntry = null;
  let currentTheme = localStorage.getItem('db_theme') || 'dark';
  let currentUser = localStorage.getItem('roadtrip_who_v4') || 'Michael';
  let welcomeSelectedUser = null;
  let dirtyCount = 0;
  let lastDirtyReason = '';
  let deferredInstallPrompt = null;
  let suppressHashEvent = false;

  // Wizard State
  let wizStep = 1;
  let wizState = {
    title: '',
    crew: ['Michael', 'Dwight', 'Jim', 'Pam'],
    modules: { locations: true, expenses: true, playlist: true, notes: true },
    destination: null,
    playlistUrl: DEFAULT_PLAYLIST_URL,
    playlistTitle: 'Threat Level Midnight Mix',
    firstNote: '',
    security: 'standard',
    password: '',
  };

  // Leaflet Map
  let map = null;
  let carMarker = null;
  let destMarker = null;
  let stopMarkersLayer = null;
  let pinMarkersLayer = null;
  let routeLayer = null;
  let cachedRouteGeometry = [];
  let pendingPinCoords = null;

  // =========================================================
  // UTILITIES & FORMATTING (SHARED VIA DBScript)
  // =========================================================
  const {
    esc,
    haversineMeters,
    compassBearing,
    formatPinDistanceReadout,
    formatRichTimeDiff,
    synthesizeScriptForPreset,
    ensureMicroModuleScript,
    runDbScript: runDbScriptEngine,
    renderDbNodes,
  } = window.DBScript;

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
    if (!key) return 'avatar-0';
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return `avatar-${h % 6}`;
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
      id: 'demo_dunder_mifflin_party',
      updatedAt: Date.now(),
      title: 'Party at Dunder Mifflin',
      crew: ['Michael', 'Dwight', 'Jim', 'Pam'],
      modules: { locations: true, expenses: true, playlist: true, notes: true },
      encrypted: false,
      trip: {
        destination: {
          name: 'Dunder Mifflin Scranton',
          label: '1725 Slough Ave, Scranton, PA',
          lat: 41.40897,
          lon: -75.66241,
        },
        stops: [
          {
            id: 'stop_dm_1',
            name: "Alfredo's Pizza Cafe",
            label: 'Scranton, PA (The Good Pizza)',
            lat: 41.4125,
            lon: -75.6652,
            addedBy: 'Michael',
            reached: false,
          },
          {
            id: 'stop_dm_2',
            name: 'Schrute Farms',
            label: 'Honesdale, PA',
            lat: 41.5742,
            lon: -75.2557,
            addedBy: 'Dwight',
            reached: true,
          },
        ],
        deletedStopIds: [],
      },
      location: {
        lat: 41.3201,
        lon: -75.7512,
        speedMph: 62,
        updatedAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
        reportedBy: 'Dwight',
        whereAreWe: 'On I-81 N • Near Scranton, PA',
        remainingMeters: 18400,
        remainingSec: 1500,
        progressPct: 72,
        nextStop: { name: "Alfredo's Pizza Cafe", remainingSec: 900 },
      },
      expenses: {
        transactions: [
          { id: 1731450001000, type: 'expense', description: 'Party Planning Committee Supplies & Ice', amount: 142, payer: 'Michael', updatedAt: 1731450001000 },
          { id: 1731450002000, type: 'expense', description: "Alfredo's Pizza Cafe (NOT Pizza by Alfredo)", amount: 86.5, payer: 'Jim', updatedAt: 1731450002000 },
          { id: 1731450003000, type: 'payment', description: 'Repayment: Pam → Michael', amount: 40, payer: 'Pam', payee: 'Michael', updatedAt: 1731450003000 },
          { id: 1731450004000, type: 'expense', description: 'Beet Energy Drinks & Party Streamers', amount: 47.5, payer: 'Dwight', updatedAt: 1731450004000 },
        ],
        deletedIds: [],
      },
      music: {
        playlistTitle: 'Threat Level Midnight Mix',
        collabUrl: DEFAULT_PLAYLIST_URL,
      },
      messages: [
        {
          id: 'msg_demo_1',
          author: 'Michael',
          text: 'Conference room in 5 minutes! Door code for the Scranton Business Park gate is #1725.',
          createdAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
          whereAreWe: 'Near Scranton, PA',
        },
        {
          id: 'msg_demo_2',
          author: 'Dwight',
          text: 'FACT: Anyone who orders from Pizza by Alfredo instead of Alfredo’s Pizza Cafe will be billed separately.',
          createdAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
          whereAreWe: 'On I-81 N • Near Scranton, PA',
        },
      ],
      theme: currentTheme || 'dark',
      pins: [
        {
          id: 'pin_dm_parking',
          kind: 'parking',
          name: 'Scranton Business Park — Lot B, Spot 14',
          note: 'Parked behind Vance Refrigeration • Sebring convertible',
          lat: 41.4091,
          lon: -75.6628,
          addedBy: 'Michael',
          createdAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
        },
        {
          id: 'pin_dm_meetup',
          kind: 'meetup',
          name: 'Dunder Mifflin Conference Room Rally Point',
          note: 'Meet here at 5:30 PM sharp before heading to Poor Richard’s',
          lat: 41.40897,
          lon: -75.66241,
          addedBy: 'Dwight',
          createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        },
      ],
      deletedPinIds: [],
      microModules: [
        {
          id: 'mm_dm_codes',
          type: 'kv',
          title: 'Scranton Business Park & Wi-Fi',
          icon: '🔑',
          pairs: [
            { k: 'Gate Code', v: '#1725' },
            { k: 'Office Wi-Fi', v: 'DunderMifflin_5G (Pass: BearsBeets)' },
            { k: 'Conference Room', v: 'Reserved at 5:30 PM' },
          ],
        },
        {
          id: 'mm_dm_pack',
          type: 'checklist',
          title: 'Party Planning Committee Checklist',
          icon: '📦',
          items: [
            { text: 'Dundie Trophies (Engraved)', done: true },
            { text: "Order from Alfredo's Pizza Cafe", done: true },
            { text: 'Brown & Grey Balloons (IT IS YOUR PARTY.)', done: false },
          ],
        },
      ],
    };
  }

  function normalizeState(raw) {
    const base = {
      v: 3,
      id: raw?.id || 'trip_' + Date.now().toString(36),
      updatedAt: raw?.updatedAt || Date.now(),
      title: raw?.title || 'Party at Dunder Mifflin',
      theme: raw?.theme || currentTheme || 'dark',
      crew: Array.isArray(raw?.crew) && raw.crew.length ? raw.crew : ['Michael', 'Dwight', 'Jim', 'Pam'],
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
      pins: Array.isArray(raw?.pins) ? raw.pins : [],
      deletedPinIds: Array.isArray(raw?.deletedPinIds) ? raw.deletedPinIds : [],
      microModules: Array.isArray(raw?.microModules) ? raw.microModules : [],
      deletedMicroIds: Array.isArray(raw?.deletedMicroIds) ? raw.deletedMicroIds : [],
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

    // Merge pins (parking & meetup places)
    const delPins = new Set([...(a.deletedPinIds || []), ...(b.deletedPinIds || [])]);
    const pinMap = new Map();
    for (const p of [...(a.pins || []), ...(b.pins || [])]) {
      if (!p || !p.id || delPins.has(p.id)) continue;
      const prev = pinMap.get(p.id);
      const pTime = p.updatedAt || (p.createdAt ? Date.parse(p.createdAt) : 0) || 0;
      const prevTime = prev ? (prev.updatedAt || (prev.createdAt ? Date.parse(prev.createdAt) : 0) || 0) : -1;
      if (!prev || pTime >= prevTime) pinMap.set(p.id, p);
    }

    // Merge microModules
    const delMm = new Set([...(a.deletedMicroIds || []), ...(b.deletedMicroIds || [])]);
    const mmMap = new Map();
    for (const mm of [...(a.microModules || []), ...(b.microModules || [])]) {
      if (!mm || !mm.id || delMm.has(mm.id)) continue;
      const prev = mmMap.get(mm.id);
      if (!prev || (mm.updatedAt || 0) >= (prev.updatedAt || 0)) {
        mmMap.set(mm.id, mm);
      }
    }

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
      pins: [...pinMap.values()],
      deletedPinIds: [...delPins],
      microModules: [...mmMap.values()],
      deletedMicroIds: [...delMm],
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
  function applyTheme(themeName) {
    const valid = ['dark', 'light', 'unicorn', 'win98', 'brutalist'];
    currentTheme = valid.includes(themeName) ? themeName : 'dark';
    try { localStorage.setItem('db_theme', currentTheme); } catch {}
    if (currentTheme === 'dark') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', currentTheme);
    }
    document.querySelectorAll('.theme-chip[data-theme]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === currentTheme);
    });
  }

  function loadBackupsList() {
    try {
      const raw = JSON.parse(localStorage.getItem(BACKUPS_LIST_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }

  function summarizeStateShort(st) {
    const s = normalizeState(st);
    const expC = s.expenses.transactions.length;
    const expSum = sumExpenses(s).toFixed(0);
    const stopC = s.trip.stops.length;
    const noteC = s.messages.length;
    return `${expC} expense${expC === 1 ? '' : 's'} ($${expSum}) · ${stopC} stop${stopC === 1 ? '' : 's'} · ${noteC} note${noteC === 1 ? '' : 's'}`;
  }

  function saveBackupSnapshot(stateToBackup, reason = 'Auto Backup') {
    if (!stateToBackup) return;
    try {
      const s = normalizeState(stateToBackup);
      const list = loadBackupsList();
      const entry = {
        id: 'bk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        tripId: s.id,
        tripTitle: s.title || 'Trip',
        createdAt: new Date().toISOString(),
        reason,
        summary: summarizeStateShort(s),
        state: s,
      };
      list.unshift(entry);
      localStorage.setItem(BACKUPS_LIST_KEY, JSON.stringify(list.slice(0, 12)));
      localStorage.setItem(`db_backup_${s.id}`, JSON.stringify(s));
    } catch {}
  }

  function openRestoreBackupConfirmation(entry) {
    if (!entry || !entry.state) return;
    pendingRestoreEntry = entry;
    const box = document.getElementById('restore-confirm-details');
    const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'Earlier';
    const currSummary = appState ? summarizeStateShort(appState) : 'None';
    box.innerHTML = `
      <div class="merge-diff-row">
        <span class="muted">Backup Selected</span>
        <strong>${esc(entry.tripTitle)} (${esc(entry.reason)})</strong>
      </div>
      <div class="merge-diff-row">
        <span class="muted">Saved At</span>
        <span>${esc(when)}</span>
      </div>
      <div class="merge-diff-row">
        <span class="muted">Backup Contents</span>
        <strong style="color:var(--accent-ink);">${esc(entry.summary)}</strong>
      </div>
      <div class="merge-diff-row">
        <span class="muted">Current Active State</span>
        <span>${esc(currSummary)}</span>
      </div>`;
    document.getElementById('restore-confirm-modal').classList.remove('hidden');
  }

  function showLandingView() {
    closeAllSheets();
    document.getElementById('wizard-modal').classList.add('hidden');
    document.getElementById('unlock-modal').classList.add('hidden');
    document.getElementById('merge-modal')?.classList.add('hidden');
    document.getElementById('restore-confirm-modal')?.classList.add('hidden');
    document.getElementById('app-view').classList.add('hidden');
    document.getElementById('landing-view').classList.remove('hidden');

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
      pins: (s.pins || []).map((p) => ({ id: p.id, kind: p.kind, name: p.name, note: p.note, lat: p.lat, lon: p.lon })),
      microModules: s.microModules || [],
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

    // 1. Detailed Expense Diff
    const locTxMap = new Map(local.expenses.transactions.map((t) => [String(t.id), t]));
    const incTxMap = new Map(incoming.expenses.transactions.map((t) => [String(t.id), t]));
    const allTxIds = new Set([...locTxMap.keys(), ...incTxMap.keys()]);
    let expOnlyLocal = 0;
    let expOnlyInc = 0;
    let expModified = 0;
    const expRowsHtml = [];

    allTxIds.forEach((id) => {
      const l = locTxMap.get(id);
      const r = incTxMap.get(id);
      const item = r || l;
      const amtStr = `$${Number(item.amount || 0).toFixed(2)}`;
      const whoStr = item.type === 'payment' ? `${item.payer} → ${item.payee}` : `Paid by ${item.payer}`;
      if (l && !r) {
        expOnlyLocal++;
        expRowsHtml.push(`<div class="diff-item"><div><strong>${esc(l.description)}</strong><div class="muted">${esc(whoStr)} · ${amtStr}</div></div><span class="diff-tag local">Only on Your Device</span></div>`);
      } else if (!l && r) {
        expOnlyInc++;
        expRowsHtml.push(`<div class="diff-item"><div><strong>${esc(r.description)}</strong><div class="muted">${esc(whoStr)} · ${amtStr}</div></div><span class="diff-tag incoming">+ New in Link</span></div>`);
      } else if (l.amount !== r.amount || l.description !== r.description || l.payer !== r.payer || l.payee !== r.payee) {
        expModified++;
        expRowsHtml.push(`<div class="diff-item"><div><strong>${esc(r.description)}</strong><div class="muted">Device: $${Number(l.amount).toFixed(2)} → Link: $${Number(r.amount).toFixed(2)}</div></div><span class="diff-tag modified">Modified</span></div>`);
      } else {
        expRowsHtml.push(`<div class="diff-item"><div><strong>${esc(l.description)}</strong><div class="muted">${esc(whoStr)} · ${amtStr}</div></div><span class="diff-tag shared">In Both</span></div>`);
      }
    });

    const expHasDiff = expOnlyLocal > 0 || expOnlyInc > 0 || expModified > 0;
    const expSummaryParts = [];
    if (expOnlyInc > 0) expSummaryParts.push(`+${expOnlyInc} new in link`);
    if (expOnlyLocal > 0) expSummaryParts.push(`+${expOnlyLocal} on device`);
    if (expModified > 0) expSummaryParts.push(`${expModified} edited`);
    if (!expSummaryParts.length) expSummaryParts.push(`All ${allTxIds.size} match ($${sumExpenses(merged).toFixed(2)})`);
    else expSummaryParts.push(`→ $${sumExpenses(merged).toFixed(2)} total`);

    // 2. Detailed Pit Stops & Destination Diff
    const locStopMap = new Map(local.trip.stops.map((s) => [String(s.id), s]));
    const incStopMap = new Map(incoming.trip.stops.map((s) => [String(s.id), s]));
    const allStopIds = new Set([...locStopMap.keys(), ...incStopMap.keys()]);
    let stopDiffCount = 0;
    const stopRowsHtml = [];

    const lDest = local.trip.destination?.name || 'None';
    const rDest = incoming.trip.destination?.name || 'None';
    if (lDest !== rDest) {
      stopDiffCount++;
      stopRowsHtml.push(`<div class="diff-item"><div><strong>🏁 Final Destination</strong><div class="muted">Device: ${esc(lDest)} → Link: ${esc(rDest)}</div></div><span class="diff-tag modified">Changed</span></div>`);
    } else if (local.trip.destination) {
      stopRowsHtml.push(`<div class="diff-item"><div><strong>🏁 ${esc(lDest)}</strong><div class="muted">Final Destination</div></div><span class="diff-tag shared">In Both</span></div>`);
    }

    allStopIds.forEach((id) => {
      const l = locStopMap.get(id);
      const r = incStopMap.get(id);
      if (l && !r) {
        stopDiffCount++;
        stopRowsHtml.push(`<div class="diff-item"><div><strong>📍 ${esc(l.name)}</strong><div class="muted">Added by ${esc(l.addedBy || 'Crew')}</div></div><span class="diff-tag local">Only on Your Device</span></div>`);
      } else if (!l && r) {
        stopDiffCount++;
        stopRowsHtml.push(`<div class="diff-item"><div><strong>📍 ${esc(r.name)}</strong><div class="muted">Added by ${esc(r.addedBy || 'Crew')}</div></div><span class="diff-tag incoming">+ New in Link</span></div>`);
      } else if (Boolean(l.reached) !== Boolean(r.reached)) {
        stopDiffCount++;
        stopRowsHtml.push(`<div class="diff-item"><div><strong>📍 ${esc(r.name)}</strong><div class="muted">Status: ${r.reached ? 'Reached' : 'Upcoming'}</div></div><span class="diff-tag modified">Status Updated</span></div>`);
      } else {
        stopRowsHtml.push(`<div class="diff-item"><div><strong>📍 ${esc(l.name)}</strong><div class="muted">${l.reached ? 'Completed' : 'Upcoming stop'}</div></div><span class="diff-tag shared">In Both</span></div>`);
      }
    });

    // 3. Detailed Crew Notes Diff
    const locMsgMap = new Map(local.messages.map((m) => [String(m.id), m]));
    const incMsgMap = new Map(incoming.messages.map((m) => [String(m.id), m]));
    const allMsgIds = new Set([...locMsgMap.keys(), ...incMsgMap.keys()]);
    let msgDiffCount = 0;
    const msgRowsHtml = [];

    allMsgIds.forEach((id) => {
      const l = locMsgMap.get(id);
      const r = incMsgMap.get(id);
      const m = r || l;
      if (l && !r) {
        msgDiffCount++;
        msgRowsHtml.push(`<div class="diff-item"><div><strong>${esc(m.author)}:</strong> "${esc(m.text)}"</div><span class="diff-tag local">Only on Device</span></div>`);
      } else if (!l && r) {
        msgDiffCount++;
        msgRowsHtml.push(`<div class="diff-item"><div><strong>${esc(m.author)}:</strong> "${esc(m.text)}"</div><span class="diff-tag incoming">+ New in Link</span></div>`);
      } else {
        msgRowsHtml.push(`<div class="diff-item"><div><strong>${esc(m.author)}:</strong> "${esc(m.text)}"</div><span class="diff-tag shared">In Both</span></div>`);
      }
    });

    // 4. Micro-Modules, Pins & Crew Diff
    const locPinMap = new Map((local.pins || []).map((p) => [String(p.id), p]));
    const incPinMap = new Map((incoming.pins || []).map((p) => [String(p.id), p]));
    const allPinIds = new Set([...locPinMap.keys(), ...incPinMap.keys()]);
    allPinIds.forEach((id) => {
      const l = locPinMap.get(id);
      const r = incPinMap.get(id);
      const p = r || l;
      const badgeIco = p.kind === 'meetup' ? '🤝' : '🅿️';
      if (l && !r) {
        stopDiffCount++;
        stopRowsHtml.push(`<div class="diff-item"><div><strong>${badgeIco} ${esc(p.name)}</strong><div class="muted">${esc(p.note || 'Pin')}</div></div><span class="diff-tag local">Only on Device</span></div>`);
      } else if (!l && r) {
        stopDiffCount++;
        stopRowsHtml.push(`<div class="diff-item"><div><strong>${badgeIco} ${esc(p.name)}</strong><div class="muted">${esc(p.note || 'Pin')}</div></div><span class="diff-tag incoming">+ New in Link</span></div>`);
      } else if (l.name !== r.name || l.note !== r.note || l.kind !== r.kind || l.lat !== r.lat || l.lon !== r.lon) {
        stopDiffCount++;
        stopRowsHtml.push(`<div class="diff-item"><div><strong>${badgeIco} ${esc(p.name)}</strong><div class="muted">${esc(p.note || 'Pin updated')}</div></div><span class="diff-tag modified">Modified</span></div>`);
      } else {
        stopRowsHtml.push(`<div class="diff-item"><div><strong>${badgeIco} ${esc(p.name)}</strong><div class="muted">${esc(p.note || 'Pin')}</div></div><span class="diff-tag shared">In Both</span></div>`);
      }
    });

    const locMmMap = new Map((local.microModules || []).map((m) => [String(m.id), m]));
    const incMmMap = new Map((incoming.microModules || []).map((m) => [String(m.id), m]));
    const allMmIds = new Set([...locMmMap.keys(), ...incMmMap.keys()]);
    let mmDiffCount = 0;
    const mmRowsHtml = [];
    const mmSig = (m) => JSON.stringify({ title: m.title, code: m.code, data: m.data, items: m.items, pairs: m.pairs, options: m.options });
    allMmIds.forEach((id) => {
      const l = locMmMap.get(id);
      const r = incMmMap.get(id);
      const m = r || l;
      if (l && !r) {
        mmDiffCount++;
        mmRowsHtml.push(`<div class="diff-item"><div><strong>${esc(m.icon || '🧩')} ${esc(m.title)}</strong></div><span class="diff-tag local">Only on Device</span></div>`);
      } else if (!l && r) {
        mmDiffCount++;
        mmRowsHtml.push(`<div class="diff-item"><div><strong>${esc(m.icon || '🧩')} ${esc(m.title)}</strong></div><span class="diff-tag incoming">+ New in Link</span></div>`);
      } else if (mmSig(l) !== mmSig(r)) {
        mmDiffCount++;
        mmRowsHtml.push(`<div class="diff-item"><div><strong>${esc(m.icon || '🧩')} ${esc(m.title)}</strong></div><span class="diff-tag modified">Modified</span></div>`);
      } else {
        mmRowsHtml.push(`<div class="diff-item"><div><strong>${esc(m.icon || '🧩')} ${esc(m.title)}</strong></div><span class="diff-tag shared">In Both</span></div>`);
      }
    });

    const diffBox = document.getElementById('merge-diff-summary');
    diffBox.innerHTML = `
      <details class="diff-details" ${expHasDiff ? 'open' : ''}>
        <summary>
          <span>💳 Expenses (${merged.expenses.transactions.length})</span>
          <span class="diff-summary-right">${esc(expSummaryParts.join(' · '))} ▾</span>
        </summary>
        <div class="diff-items-list">
          ${expRowsHtml.length ? expRowsHtml.join('') : '<div class="muted">No expenses logged yet.</div>'}
        </div>
      </details>

      <details class="diff-details" ${stopDiffCount > 0 ? 'open' : ''}>
        <summary>
          <span>📍 Route &amp; Stops (${merged.trip.stops.length})</span>
          <span class="diff-summary-right">${stopDiffCount > 0 ? `${stopDiffCount} change${stopDiffCount > 1 ? 's' : ''}` : 'No changes'} ▾</span>
        </summary>
        <div class="diff-items-list">
          ${stopRowsHtml.length ? stopRowsHtml.join('') : '<div class="muted">No stops added yet.</div>'}
        </div>
      </details>

      <details class="diff-details" ${msgDiffCount > 0 ? 'open' : ''}>
        <summary>
          <span>💬 Crew Notes (${merged.messages.length})</span>
          <span class="diff-summary-right">${msgDiffCount > 0 ? `${msgDiffCount} difference${msgDiffCount > 1 ? 's' : ''}` : 'No changes'} ▾</span>
        </summary>
        <div class="diff-items-list">
          ${msgRowsHtml.length ? msgRowsHtml.join('') : '<div class="muted">No notes posted yet.</div>'}
        </div>
      </details>

      ${allMmIds.size > 0 ? `
      <details class="diff-details" ${mmDiffCount > 0 ? 'open' : ''}>
        <summary>
          <span>🧩 Micro-Modules (${merged.microModules.length})</span>
          <span class="diff-summary-right">${mmDiffCount > 0 ? `${mmDiffCount} new/updated` : 'In sync'} ▾</span>
        </summary>
        <div class="diff-items-list">${mmRowsHtml.join('')}</div>
      </details>` : ''}`;

    document.getElementById('landing-view').classList.add('hidden');
    document.getElementById('wizard-modal').classList.add('hidden');
    document.getElementById('unlock-modal').classList.add('hidden');
    document.getElementById('merge-modal').classList.remove('hidden');
  }

  function finalizeEnterApp(chosenState, passwordUsed = null, toastMessage = null) {
    appState = normalizeState(chosenState);
    if (appState.theme) applyTheme(appState.theme);
    if (passwordUsed) {
      activePassword = passwordUsed;
      appState.encrypted = true;
      try { sessionStorage.setItem(`db_pw_${appState.id}`, passwordUsed); } catch {}
    } else {
      activePassword = null;
    }

    if (!appState.crew.includes(currentUser)) {
      currentUser = appState.crew[0] || 'Michael';
    }

    dirtyCount = 0;
    lastDirtyReason = '';
    saveStateToLocal(appState);

    document.getElementById('landing-view').classList.add('hidden');
    document.getElementById('wizard-modal').classList.add('hidden');
    document.getElementById('unlock-modal').classList.add('hidden');
    document.getElementById('merge-modal')?.classList.add('hidden');
    document.getElementById('restore-confirm-modal')?.classList.add('hidden');
    document.getElementById('app-view').classList.remove('hidden');

    const welcomedForTrip = localStorage.getItem(`db_welcomed_${appState.id}`) === '1';
    const splash = document.getElementById('welcome-splash');
    if (!welcomedForTrip) {
      welcomeSelectedUser = localStorage.getItem('roadtrip_who_v4');
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

  // =========================================================
  // AI AGENT URL PARAMETER (&ai= AND #ai=) ENGINE
  // =========================================================
  function deterministicHashNum(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return 1731450000000 + (Math.abs(h) % 900000000);
  }

  function applyAiPatchToState(baseRaw, aiPatch) {
    const st = normalizeState(JSON.parse(JSON.stringify(baseRaw || {})));
    if (!aiPatch || typeof aiPatch !== 'object') return st;

    if (aiPatch.title) st.title = String(aiPatch.title).slice(0, 80);
    if (aiPatch.theme) st.theme = String(aiPatch.theme);

    if (Array.isArray(aiPatch.crew) && aiPatch.crew.length) {
      st.crew = [...new Set(aiPatch.crew.map((c) => String(c).trim()).filter(Boolean))];
    }
    if (Array.isArray(aiPatch.addCrew)) {
      aiPatch.addCrew.forEach((c) => {
        const clean = String(c || '').trim();
        if (clean && !st.crew.includes(clean)) st.crew.push(clean);
      });
    }

    if (aiPatch.setDestination && aiPatch.setDestination.name) {
      st.trip.destination = {
        name: String(aiPatch.setDestination.name),
        label: String(aiPatch.setDestination.label || aiPatch.setDestination.name),
        lat: Number(aiPatch.setDestination.lat || 41.40897),
        lon: Number(aiPatch.setDestination.lon || -75.66241),
      };
    }

    if (aiPatch.setLocation) {
      st.location = {
        ...st.location,
        whereAreWe: String(aiPatch.setLocation.whereAreWe || st.location.whereAreWe),
        lat: aiPatch.setLocation.lat != null ? Number(aiPatch.setLocation.lat) : st.location.lat,
        lon: aiPatch.setLocation.lon != null ? Number(aiPatch.setLocation.lon) : st.location.lon,
        speedMph: aiPatch.setLocation.speedMph != null ? Number(aiPatch.setLocation.speedMph) : st.location.speedMph,
        reportedBy: String(aiPatch.setLocation.reportedBy || 'AI Assistant'),
        updatedAt: new Date().toISOString(),
      };
    }

    if (Array.isArray(aiPatch.addStops)) {
      aiPatch.addStops.forEach((s) => {
        if (!s || !s.name) return;
        const id = s.id || 'stop_ai_' + deterministicHashNum(JSON.stringify(s));
        if (!st.trip.stops.some((x) => x.id === id)) {
          st.trip.stops.push({
            id,
            name: String(s.name),
            label: String(s.label || s.name),
            lat: Number(s.lat || 41.4125),
            lon: Number(s.lon || -75.6652),
            addedBy: String(s.addedBy || 'AI Assistant'),
            reached: Boolean(s.reached),
          });
        }
      });
    }

    if (Array.isArray(aiPatch.addExpenses)) {
      aiPatch.addExpenses.forEach((e) => {
        if (!e || !Number.isFinite(Number(e.amount))) return;
        const id = e.id || deterministicHashNum(`${e.description}_${e.amount}_${e.payer}_${e.payee || ''}`);
        if (!st.expenses.transactions.some((x) => x.id === id)) {
          const payer = String(e.payer || st.crew[0] || 'Michael');
          if (!st.crew.includes(payer)) st.crew.push(payer);
          st.expenses.transactions.push({
            id,
            type: e.type === 'payment' ? 'payment' : 'expense',
            description: String(e.description || 'AI Receipt Entry'),
            amount: Number(e.amount),
            payer,
            payee: e.type === 'payment' ? String(e.payee || st.crew[1] || 'Dwight') : undefined,
            updatedAt: Date.now(),
          });
        }
      });
    }

    if (Array.isArray(aiPatch.addNotes)) {
      aiPatch.addNotes.forEach((n) => {
        const text = typeof n === 'string' ? n : n?.text;
        if (!text) return;
        const id = n?.id || 'msg_ai_' + deterministicHashNum(text);
        if (!st.messages.some((x) => x.id === id)) {
          st.messages.push({
            id,
            author: String(n?.author || 'AI Assistant'),
            text: String(text),
            createdAt: new Date().toISOString(),
            whereAreWe: st.location?.whereAreWe || '',
          });
        }
      });
    }

    if (Array.isArray(aiPatch.addPins)) {
      aiPatch.addPins.forEach((p) => {
        if (!p || !p.name) return;
        const id = p.id || 'pin_ai_' + deterministicHashNum(JSON.stringify(p));
        if (!st.pins.some((x) => x.id === id)) {
          st.pins.push({
            id,
            kind: p.kind === 'meetup' ? 'meetup' : 'parking',
            name: String(p.name),
            note: String(p.note || ''),
            lat: Number(p.lat ?? st.location?.lat ?? 41.40897),
            lon: Number(p.lon ?? st.location?.lon ?? -75.66241),
            addedBy: String(p.addedBy || 'AI Assistant'),
            createdAt: new Date().toISOString(),
          });
        }
      });
    }

    const incomingMms = [
      ...(Array.isArray(aiPatch.addMicroModules) ? aiPatch.addMicroModules : []),
      ...(aiPatch.addMicroModule && typeof aiPatch.addMicroModule === 'object' ? [aiPatch.addMicroModule] : []),
    ];
    if (incomingMms.length) {
      incomingMms.forEach((mm) => {
        if (!mm || !mm.title) return;
        const id = mm.id || 'mm_ai_' + deterministicHashNum(mm.title + (mm.type || '') + (mm.code || ''));
        if (!st.microModules.some((x) => x.id === id)) {
          st.microModules.push({
            id,
            type: mm.type || (mm.code ? 'script' : 'kv'),
            title: String(mm.title),
            icon: String(mm.icon || '🧩'),
            items: Array.isArray(mm.items) ? mm.items : [],
            pairs: Array.isArray(mm.pairs) ? mm.pairs : [],
            options: Array.isArray(mm.options) ? mm.options : [],
            targetTime: mm.targetTime || null,
            code: mm.code ? String(mm.code) : undefined,
            data: mm.data && typeof mm.data === 'object' ? mm.data : undefined,
            updatedAt: Date.now(),
          });
        }
      });
    }

    st.updatedAt = Date.now();
    return st;
  }

  function parseAiJsonString(rawStr) {
    if (!rawStr) return null;
    try {
      return JSON.parse(decodeURIComponent(rawStr));
    } catch {
      try {
        return JSON.parse(rawStr);
      } catch {
        try {
          const bytes = base64UrlToBytes(rawStr);
          return JSON.parse(new TextDecoder().decode(bytes));
        } catch { return null; }
      }
    }
  }

  async function handleHashRoute() {
    if (suppressHashEvent) return;
    const rawHash = window.location.hash.replace(/^#/, '').trim();
    const urlSearchParams = new URLSearchParams(window.location.search);
    const queryAi = urlSearchParams.get('ai');

    if (!rawHash && !queryAi) {
      showLandingView();
      return;
    }

    // Extract optional &ai= suffix from hash
    let mainPart = rawHash;
    let aiRawParam = queryAi || null;
    const ampAiIdx = rawHash.indexOf('&ai=');
    if (ampAiIdx !== -1) {
      mainPart = rawHash.slice(0, ampAiIdx);
      aiRawParam = rawHash.slice(ampAiIdx + 4);
    }

    // Case 1: Pure #ai=<JSON> URL constructed from scratch by an AI Agent or Studio
    const targetActive = urlSearchParams.get('target') === 'active';
    if (mainPart.startsWith('ai=')) {
      const aiObj = parseAiJsonString(mainPart.slice(3));
      if (aiObj) {
        if (targetActive) {
          try {
            const saved = JSON.parse(localStorage.getItem(LAST_TRIP_STORAGE_KEY) || 'null');
            if (saved && saved.id) {
              if (!loadLocalByTripId(saved.id)) saveStateToLocal(saved);
              const patched = applyAiPatchToState(saved, aiObj);
              const cachedPw = sessionStorage.getItem(`db_pw_${saved.id}`) || null;
              window.history.replaceState(null, '', window.location.pathname + window.location.hash);
              enterAppWithState(patched, cachedPw, false);
              return;
            }
          } catch {}
        }
        const built = applyAiPatchToState({ id: aiObj.id || 'trip_ai_' + deterministicHashNum(JSON.stringify(aiObj)), title: aiObj.title || 'AI Coordinated Trip', crew: aiObj.crew || ['Michael', 'Dwight', 'Jim', 'Pam'] }, aiObj);
        localStorage.setItem(`db_welcomed_${built.id}`, '1');
        enterAppWithState(built, null, false);
        return;
      }
    }

    const aiPatchObj = parseAiJsonString(aiRawParam);

    // Case 2: Standard #s=<LZString> (with optional &ai=<JSON> patch)
    if (mainPart.startsWith('s=')) {
      try {
        const decoded = decodeStandardHash(mainPart.slice(2));
        if (decoded) {
          if (aiPatchObj) {
            if (!loadLocalByTripId(decoded.id)) saveStateToLocal(decoded);
            const patched = applyAiPatchToState(decoded, aiPatchObj);
            enterAppWithState(patched, null, false);
          } else {
            enterAppWithState(decoded, null, false);
          }
          return;
        }
      } catch {}
      showLandingView();
      return;
    }

    // Case 3: Encrypted #e=<AES-256> (with optional &ai=<JSON> patch)
    if (mainPart.startsWith('e=')) {
      const payload = mainPart.slice(2);
      pendingEncryptedPayload = payload;
      pendingAiPatchObj = aiPatchObj;

      try {
        const savedTrip = JSON.parse(localStorage.getItem(LAST_TRIP_STORAGE_KEY) || 'null');
        const cachedPw = savedTrip?.id ? sessionStorage.getItem(`db_pw_${savedTrip.id}`) : null;
        if (cachedPw) {
          const decrypted = await decryptHashToState(payload, cachedPw);
          if (aiPatchObj) {
            if (!loadLocalByTripId(decrypted.id)) saveStateToLocal(decrypted);
            const patched = applyAiPatchToState(decrypted, aiPatchObj);
            enterAppWithState(patched, cachedPw, false);
          } else {
            enterAppWithState(decrypted, cachedPw, false);
          }
          return;
        }
      } catch {}

      document.getElementById('landing-view').classList.add('hidden');
      document.getElementById('app-view').classList.add('hidden');
      document.getElementById('unlock-error').classList.add('hidden');
      document.getElementById('unlock-password-input').value = '';
      document.getElementById('unlock-modal').classList.remove('hidden');
      return;
    }

    showLandingView();
  }

  // =========================================================
  // NEW TRIP WIZARD (4 STEPS)
  // =========================================================
  function openNewTripWizard() {
    wizStep = 1;
    wizState = {
      title: '',
      crew: ['Michael', 'Dwight', 'Jim', 'Pam'],
      modules: { locations: true, expenses: true, playlist: true, notes: true },
      destination: null,
      playlistUrl: DEFAULT_PLAYLIST_URL,
      playlistTitle: 'Threat Level Midnight Mix',
      firstNote: '',
      security: 'standard',
      password: '',
    };
    document.getElementById('wiz-trip-title').value = '';
    document.getElementById('wiz-dest-input').value = '';
    document.getElementById('wiz-dest-selected').classList.add('hidden');
    document.getElementById('wiz-dest-results').classList.add('hidden');
    document.getElementById('wiz-playlist-url').value = DEFAULT_PLAYLIST_URL;
    document.getElementById('wiz-playlist-title').value = 'Threat Level Midnight Mix';
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
      crew: wizState.crew.length ? wizState.crew : ['Michael', 'Dwight'],
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
        appState.location.initialTotalMeters = Math.max(appState.location.initialTotalMeters || 0, Math.round(route.distance));
        if (appState.location.initialTotalMeters > 0) {
          appState.location.progressPct = route.distance < 150
            ? 100
            : Math.min(98, Math.max(5, Math.round((1 - route.distance / appState.location.initialTotalMeters) * 100)));
        }
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
      setTimeout(() => {
        map.invalidateSize();
        fitMapToTrip();
      }, 60);
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
        try { localStorage.setItem('roadtrip_who_v4', person); } catch {}
        renderWhoAndHeader();
        renderExpensesModule();
        renderMessages();
        renderMicroModules();
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

    // 30-Minute Stale GPS Signifier
    const ageMs = loc.updatedAt ? Date.now() - Date.parse(loc.updatedAt) : Infinity;
    const isStale30m = !Number.isFinite(ageMs) || ageMs >= 30 * 60 * 1000;
    const staleBanner = document.getElementById('gps-stale-banner');
    const gpsBtn = document.getElementById('gps-snap-btn');
    if (staleBanner) staleBanner.classList.toggle('hidden', !isStale30m);
    if (gpsBtn) {
      gpsBtn.classList.toggle('gps-stale-alert', isStale30m);
      gpsBtn.textContent = isStale30m ? '⚠️ Update GPS' : '📍 Update GPS';
    }

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
      const col = isPos ? 'var(--accent-ink)' : (isNeg ? 'var(--danger-text)' : 'var(--muted)');
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
              <strong style="color:var(--danger-text);">${esc(d.name)}</strong>
              <span class="muted" style="margin:0 6px;">pays</span>
              <strong style="color:var(--accent-ink);">${esc(c.name)}</strong>
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
            <button type="button" class="subtle-pill-btn del-tx-btn" style="padding:2px 8px; font-size:0.7rem; color:var(--danger-text);">Delete</button>
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
    const people = appState?.crew || ['Michael'];
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
      embedUrl: `https://www.youtube.com/embed/videoseries?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI&rel=0`,
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
  function populateStopsContainer(container, stops, dest, loc) {
    if (!container) return;
    container.innerHTML = '';

    if (!stops.length && !dest) {
      container.innerHTML = `<p class="muted" style="text-align:center; padding:8px 0;">No stops or destination yet — add a stop or set the destination below.</p>`;
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
          <button class="subtle-pill-btn remove-stop" type="button" title="Remove Stop">✕</button>
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
      container.appendChild(row);
    });

    if (dest) {
      const destRow = document.createElement('div');
      destRow.className = 'stop-row';
      destRow.style.borderColor = 'var(--badge-border)';
      destRow.innerHTML = `
        <div style="min-width:0;">
          <div style="font-weight:800; color:var(--accent-ink);">🏁 Final Dest: ${esc(dest.name)}</div>
          <div class="muted">${esc(dest.label || '')}${loc.remainingSec != null ? ' • ' + formatDuration(loc.remainingSec) + ' left' : ''}</div>
        </div>
        <button class="subtle-pill-btn remove-dest-inline" type="button" title="Clear Destination">Clear</button>`;
      destRow.querySelector('.remove-dest-inline').addEventListener('click', async () => {
        appState.trip.destination = null;
        appState.location.remainingMeters = null;
        appState.location.remainingSec = null;
        renderAll();
        await syncStateToUrl('Cleared final destination');
      });
      container.appendChild(destRow);
    }
  }

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

    populateStopsContainer(document.getElementById('stops-list'), stops, dest, loc);
    populateStopsContainer(document.getElementById('sheet-current-stops-list'), stops, dest, loc);
    renderPins();
  }

  function renderPins() {
    if (!appState) return;
    const pins = appState.pins || [];
    const loc = appState.location || {};

    ['home-pins-list', 'stops-pins-list'].forEach((boxId) => {
      const box = document.getElementById(boxId);
      if (!box) return;
      box.innerHTML = '';
      if (!pins.length) {
        box.innerHTML = `<div class="muted" style="text-align:center; padding:8px 0;">No parking or meetup pins dropped yet — tap <strong>+ Drop Pin</strong> to remember a parking spot or set a crew rally point!</div>`;
        return;
      }
      pins.forEach((p) => {
        const isMeetup = p.kind === 'meetup';
        const badgeLabel = isMeetup ? '🤝 MEETUP PLACE' : '🅿️ PARKING SPOT';
        const distInfo = loc.lat != null && p.lat != null ? formatPinDistanceReadout(loc.lat, loc.lon, p.lat, p.lon) : '';
        const gmapsWalk = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=walking`;
        const appleWalk = `https://maps.apple.com/?daddr=${p.lat},${p.lon}&dirflg=w`;

        const row = document.createElement('div');
        row.className = 'pin-card-row';
        row.innerHTML = `
          <div class="pin-card-top">
            <div style="min-width:0;">
              <span class="diff-tag ${isMeetup ? 'modified' : 'incoming'}" style="margin-bottom:4px;">${badgeLabel}</span>
              <div style="font-weight:800; font-size:0.98rem;">${esc(p.name)}</div>
              ${p.note ? `<div class="muted" style="margin-top:2px;">${esc(p.note)}</div>` : ''}
              <div class="muted" style="font-size:0.76rem; margin-top:4px;">
                Dropped by <strong>${esc(p.addedBy || 'Crew')}</strong>${distInfo ? ` • <strong style="color:var(--accent-ink);">${esc(distInfo)}</strong>` : ''}
              </div>
            </div>
            <button type="button" class="subtle-pill-btn del-pin-btn" title="Remove Pin">✕</button>
          </div>
          <div class="pin-nav-links">
            <a href="${esc(gmapsWalk)}" target="_blank" rel="noopener" class="btn btn-sm btn-lime">🚶 Walk There (Google Maps) ↗</a>
            <a href="${esc(appleWalk)}" target="_blank" rel="noopener" class="btn btn-sm">🍎 Apple Maps ↗</a>
          </div>`;

        row.querySelector('.del-pin-btn').addEventListener('click', async () => {
          appState.pins = appState.pins.filter((x) => x.id !== p.id);
          if (!appState.deletedPinIds.includes(p.id)) appState.deletedPinIds.push(p.id);
          renderPins();
          updateMap();
          await syncStateToUrl(`Removed pin "${p.name}"`);
        });
        box.appendChild(row);
      });
    });
  }

  function initMap() {
    if (map) return;
    const mapEl = document.getElementById('map');
    if (!mapEl) return;
    map = L.map('map', { zoomControl: false }).setView([41.40897, -75.66241], 10);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri',
    }).addTo(map);
    stopMarkersLayer = L.layerGroup().addTo(map);
    pinMarkersLayer = L.layerGroup().addTo(map);
    routeLayer = L.polyline([], { color: '#9D7BFF', weight: 4, opacity: 0.85 }).addTo(map);
  }

  function fitMapToTrip() {
    if (!map || !appState) return;
    const pts = [];
    const loc = appState.location;
    if (loc?.lat != null && loc?.lon != null) pts.push([Number(loc.lat), Number(loc.lon)]);
    const dest = appState.trip?.destination;
    if (dest?.lat != null && dest?.lon != null) pts.push([Number(dest.lat), Number(dest.lon)]);
    (appState.trip?.stops || []).forEach((s) => {
      if (s?.lat != null && s?.lon != null) pts.push([Number(s.lat), Number(s.lon)]);
    });
    (appState.pins || []).forEach((p) => {
      if (p?.lat != null && p?.lon != null) pts.push([Number(p.lat), Number(p.lon)]);
    });
    if (pts.length >= 2) {
      map.fitBounds(L.latLngBounds(pts), { padding: [34, 34], maxZoom: 14 });
    } else if (pts.length === 1) {
      map.setView(pts[0], 13);
    }
  }

  function updateMap() {
    if (!map || !appState) return;
    const loc = appState.location || {};
    const dest = appState.trip?.destination;
    const stops = appState.trip?.stops || [];
    const pins = appState.pins || [];

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

    if (pinMarkersLayer) {
      pinMarkersLayer.clearLayers();
      pins.forEach((p) => {
        if (p.lat == null || p.lon == null) return;
        const isMeetup = p.kind === 'meetup';
        L.circleMarker([p.lat, p.lon], {
          radius: 8,
          color: '#07080D',
          fillColor: isMeetup ? '#EC4899' : '#06B6D4',
          fillOpacity: 1,
          weight: 2.5,
        }).bindPopup(`<b>${isMeetup ? '🤝 Meetup' : '🅿️ Parking'}: ${esc(p.name)}</b>${p.note ? '<br>' + esc(p.note) : ''}`).addTo(pinMarkersLayer);
      });
    }

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

  function renderMicroModules() {
    if (!appState) return;
    const box = document.getElementById('home-micromodules-box');
    if (!box) return;
    box.innerHTML = '';

    const mms = appState.microModules || [];
    mms.forEach((mm) => {
      ensureMicroModuleScript(mm);
      const card = document.createElement('section');
      card.className = 'card';
      const icon = mm.icon || (mm.type === 'checklist' ? '📦' : mm.type === 'poll' ? '🍕' : mm.type === 'countdown' ? '⏳' : mm.type === 'turing' ? '🧮' : '🔑');

      const { vm, env } = runDbScriptEngine(mm, {
        user: currentUser,
        crew: appState?.crew || ['Michael', 'Dwight', 'Jim', 'Pam'],
        trip: {
          title: appState?.title || 'Trip',
          spent: sumExpenses(appState || {}),
          where: appState?.location?.whereAreWe || '',
          lat: appState?.location?.lat ?? 41.40897,
          lon: appState?.location?.lon ?? -75.66241,
          speed: appState?.location?.speedMph ?? 0,
        },
      });

      card.innerHTML = `
        <div class="card-head">
          <div class="card-title">${esc(icon)} ${esc(mm.title)}</div>
          <div style="display:flex; gap:6px;">
            <button type="button" class="subtle-pill-btn edit-mm-script-btn" style="font-size:0.72rem;" title="Inspect or Edit DB-Script Code">&lt;/&gt; Script</button>
            <button type="button" class="subtle-pill-btn del-mm-btn" style="font-size:0.72rem;">✕ Remove</button>
          </div>
        </div>
        <div class="mm-body-mount"></div>`;

      card.querySelector('.mm-body-mount').appendChild(
        renderDbNodes(vm.nodes, mm, env, vm, {
          onToast: showToast,
          getLocation: () => appState?.location,
          onChange: async (reason) => {
            renderMicroModules();
            await syncStateToUrl(reason);
          },
        })
      );

      card.querySelector('.edit-mm-script-btn')?.addEventListener('click', () => {
        openMicroModuleStudio(mm);
      });

      card.querySelector('.del-mm-btn')?.addEventListener('click', async () => {
        appState.microModules = appState.microModules.filter((x) => x.id !== mm.id);
        if (!appState.deletedMicroIds.includes(mm.id)) appState.deletedMicroIds.push(mm.id);
        renderMicroModules();
        renderModulesSettingsSheet();
        await syncStateToUrl(`Removed micro-module "${mm.title}"`);
      });

      box.appendChild(card);
    });
  }

  function openMicroModuleStudio(existingMm = null) {
    const editIdEl = document.getElementById('mm-edit-id');
    const typeEl = document.getElementById('mm-type');
    const iconEl = document.getElementById('mm-icon');
    const titleEl = document.getElementById('mm-title');
    const linesWrap = document.getElementById('mm-lines-wrap');
    const targetWrap = document.getElementById('mm-target-wrap');
    const targetTimeEl = document.getElementById('mm-target-time');
    const codeEl = document.getElementById('mm-script-code');
    const dataEl = document.getElementById('mm-script-data');
    const detailsEl = document.getElementById('mm-script-details');
    const headingEl = document.getElementById('mm-sheet-heading');

    if (existingMm) {
      ensureMicroModuleScript(existingMm);
      headingEl.textContent = `</> Edit "${existingMm.title}" Script`;
      editIdEl.value = existingMm.id;
      typeEl.value = existingMm.type || 'script';
      iconEl.value = existingMm.icon || '🧩';
      titleEl.value = existingMm.title || '';
      linesWrap.classList.add('hidden');
      targetWrap.classList.toggle('hidden', existingMm.type !== 'countdown');
      if (existingMm.data?.target) targetTimeEl.value = existingMm.data.target;
      codeEl.value = existingMm.code || '';
      dataEl.value = JSON.stringify(existingMm.data || {}, null, 2);
      if (detailsEl) detailsEl.open = true;
    } else {
      headingEl.textContent = '🧩 URL Micro-Module & DB-Script Studio';
      editIdEl.value = '';
      typeEl.value = 'countdown';
      iconEl.value = '⏳';
      titleEl.value = '';
      document.getElementById('mm-lines').value = '';
      const defTarget = '2026-12-25T11:11';
      targetTimeEl.value = defTarget;
      linesWrap.classList.add('hidden');
      targetWrap.classList.remove('hidden');
      const synth = synthesizeScriptForPreset('countdown', { target: defTarget });
      codeEl.value = synth.code;
      dataEl.value = JSON.stringify(synth.data, null, 2);
      if (detailsEl) detailsEl.open = false;
    }
    closeAllSheets();
    openSheet('sheet-micromodule');
  }

  function openPinSheet(defaultKind = 'parking') {
    const kindInput = document.getElementById('pin-kind-input');
    const parkBtn = document.getElementById('pin-kind-parking-btn');
    const meetBtn = document.getElementById('pin-kind-meetup-btn');
    const titleInp = document.getElementById('pin-title-input');
    const noteInp = document.getElementById('pin-note-input');
    const readout = document.getElementById('pin-coords-readout');

    const setKind = (k) => {
      kindInput.value = k;
      parkBtn.className = k === 'parking' ? 'btn btn-lime' : 'btn';
      meetBtn.className = k === 'meetup' ? 'btn btn-lime' : 'btn';
      titleInp.placeholder = k === 'meetup'
        ? 'e.g. Main Stage Clocktower, Hotel Lobby...'
        : 'e.g. Level 3 Blue Giraffe, Spot 42...';
    };
    setKind(defaultKind);

    titleInp.value = '';
    noteInp.value = '';
    document.getElementById('pin-search-input').value = '';
    document.getElementById('pin-search-results').classList.add('hidden');

    if (appState?.location?.lat != null) {
      pendingPinCoords = {
        lat: appState.location.lat,
        lon: appState.location.lon,
        label: appState.location.whereAreWe || `${appState.location.lat.toFixed(4)}, ${appState.location.lon.toFixed(4)}`,
      };
      readout.textContent = `📍 ${pendingPinCoords.label}`;
    } else {
      pendingPinCoords = { lat: 41.40897, lon: -75.66241, label: 'Scranton, PA (Tap Use My Exact GPS)' };
      readout.textContent = pendingPinCoords.label;
    }

    openSheet('sheet-pin');
  }

  function renderModulesSettingsSheet() {
    if (!appState) return;
    document.getElementById('settings-trip-title').value = appState.title || '';
    document.getElementById('settings-password-input').value = activePassword || '';
    document.getElementById('settings-enc-status').textContent = appState.encrypted
      ? '🔒 Currently encrypted with AES-256-GCM. Clear password and click Apply to switch to a standard link.'
      : '🔗 Currently using a standard unencrypted link. Enter a password and click Apply to encrypt.';

    document.querySelectorAll('.theme-chip[data-theme]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === currentTheme);
    });

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

    // Micro-modules list in settings
    const mmList = document.getElementById('settings-micromodules-list');
    if (mmList) {
      const mms = appState.microModules || [];
      mmList.innerHTML = '';
      if (!mms.length) {
        mmList.innerHTML = `<div class="muted" style="font-size:0.8rem;">No micro-modules yet. Tap "+ Quick Add" or "WYSIWYG Studio" above.</div>`;
      } else {
        mms.forEach((m) => {
          const row = document.createElement('div');
          row.className = 'backup-item';
          row.innerHTML = `
            <span style="font-weight:800; font-size:0.86rem; min-width:0; overflow:hidden; text-overflow:ellipsis;">${esc(m.icon || '🧩')} ${esc(m.title)}</span>
            <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
              <span class="muted">${esc(m.type)}</span>
              <button type="button" class="subtle-pill-btn edit-settings-mm-btn" style="padding:3px 9px; font-size:0.72rem;">Edit</button>
            </div>`;
          row.querySelector('.edit-settings-mm-btn').addEventListener('click', () => openMicroModuleStudio(m));
          mmList.appendChild(row);
        });
      }
    }

    // Multi-Backup History List
    const bkBox = document.getElementById('settings-backups-list');
    if (bkBox) {
      const backups = loadBackupsList();
      if (!backups.length) {
        bkBox.innerHTML = `<div class="muted" style="font-size:0.8rem; padding:6px 0;">No backups saved yet. Backups are created automatically before any Smart Merge, or tap "+ Save Snapshot" above.</div>`;
      } else {
        bkBox.innerHTML = '';
        backups.forEach((b) => {
          const when = b.createdAt ? new Date(b.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
          const row = document.createElement('div');
          row.className = 'backup-item';
          row.innerHTML = `
            <div style="min-width:0;">
              <div style="font-weight:800; font-size:0.86rem;">${esc(b.tripTitle)} <span class="muted">(${esc(b.reason)} · ${esc(when)})</span></div>
              <div class="muted" style="font-size:0.75rem;">${esc(b.summary)}</div>
            </div>
            <button type="button" class="btn btn-sm btn-purple restore-bk-btn">Restore</button>`;
          row.querySelector('.restore-bk-btn').addEventListener('click', () => {
            openRestoreBackupConfirmation(b);
          });
          bkBox.appendChild(row);
        });
      }
    }
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
    renderMicroModules();
    updateBadges();
    updateInstallUI();
    updateShareBarUI();
  }

  async function copyAiRecipePrompt() {
    await syncStateToUrl(null);
    const activeUrl = appState ? window.location.href : 'https://dangerous.business/#s=<YOUR_TRIP_LINK>';
    const crewList = appState?.crew?.join(', ') || 'Michael, Dwight, Jim, Pam';
    const promptText = [
      `You are helping our group update our Dangerous.Business trip link (spec at https://dangerous.business/llms.txt).`,
      `Crew members: ${crewList}.`,
      `Current Trip URL: ${activeUrl}`,
      ``,
      `Task: Read the attached receipt / update, construct a URL-encoded JSON patch using the &ai= parameter (e.g. {"addExpenses":[{"description":"Merchant","amount":0.00,"payer":"${currentUser}"}]} or addStops / addNotes / addMicroModules), append &ai=<encoded_json> to the Current Trip URL above, and reply with the clickable updated URL!`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(promptText);
      showToast('Copied AI Receipt Prompt + Trip Link!');
    } catch {
      showToast('Could not copy automatically');
    }
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
      saveBackupSnapshot(local, 'Before Smart Merge');
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
      saveBackupSnapshot(local, 'Before Link Replace');
      pendingMergeContext = null;
      finalizeEnterApp(incoming, passwordUsed, 'Loaded incoming link (backup saved)!');
    });

    // Restore Backup Confirmation Warning Modal
    document.getElementById('restore-cancel-btn')?.addEventListener('click', () => {
      pendingRestoreEntry = null;
      document.getElementById('restore-confirm-modal')?.classList.add('hidden');
    });
    document.getElementById('restore-proceed-btn')?.addEventListener('click', () => {
      if (!pendingRestoreEntry?.state) return;
      if (appState) saveBackupSnapshot(appState, 'Before Restore');
      const targetState = pendingRestoreEntry.state;
      pendingRestoreEntry = null;
      document.getElementById('restore-confirm-modal')?.classList.add('hidden');
      closeAllSheets();
      finalizeEnterApp(targetState, activePassword, 'Restored backup snapshot!');
    });

    document.getElementById('settings-save-backup-now-btn')?.addEventListener('click', () => {
      if (!appState) return;
      saveBackupSnapshot(appState, 'Manual Snapshot');
      renderModulesSettingsSheet();
      showToast('Saved backup snapshot!');
    });

    // Theme Picker (Home Page & Settings Sheet)
    document.querySelectorAll('.theme-chip[data-theme]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const th = btn.dataset.theme || 'dark';
        applyTheme(th);
        if (appState) {
          appState.theme = th;
          await syncStateToUrl(`Switched theme to ${th}`);
        }
      });
    });

    // AI Recipe Copy Buttons
    document.querySelectorAll('.copy-ai-recipe-btn').forEach((btn) => {
      btn.addEventListener('click', copyAiRecipePrompt);
    });

    // Micro-Module Studio & DB-Script Editor
    document.getElementById('open-micromodule-creator-btn')?.addEventListener('click', () => {
      openMicroModuleStudio(null);
    });

    const syncStudioScriptPreview = () => {
      const editId = document.getElementById('mm-edit-id').value;
      if (editId) return; // Don't overwrite custom edits when editing an existing module unless template changed
      const t = document.getElementById('mm-type').value;
      if (t === 'script') return;
      const rawLines = document.getElementById('mm-lines').value.split('\n').map((s) => s.trim()).filter(Boolean);
      const targetTime = document.getElementById('mm-target-time').value || '2026-12-25T11:11';
      const dataSeed = {};
      if (t === 'countdown') dataSeed.target = targetTime;
      if (t === 'checklist' && rawLines.length) dataSeed.items = rawLines.map((text) => ({ text, done: false }));
      if (t === 'kv' && rawLines.length) {
        dataSeed.pairs = rawLines.map((line) => {
          const idx = line.indexOf(':');
          return idx !== -1 ? { k: line.slice(0, idx).trim(), v: line.slice(idx + 1).trim() } : { k: line, v: '' };
        });
      }
      if (t === 'poll' && rawLines.length) dataSeed.options = rawLines.map((label) => ({ label, votes: [] }));
      const synth = synthesizeScriptForPreset(t, dataSeed);
      document.getElementById('mm-script-code').value = synth.code;
      document.getElementById('mm-script-data').value = JSON.stringify(synth.data, null, 2);
    };

    document.getElementById('mm-type')?.addEventListener('change', (e) => {
      const t = e.target.value;
      document.getElementById('mm-edit-id').value = '';
      const lbl = document.getElementById('mm-lines-label');
      const linesWrap = document.getElementById('mm-lines-wrap');
      const targetWrap = document.getElementById('mm-target-wrap');
      const ta = document.getElementById('mm-lines');
      const iconInp = document.getElementById('mm-icon');
      const detailsEl = document.getElementById('mm-script-details');

      const icons = { countdown: '⏳', kv: '🔑', checklist: '📦', poll: '🍕', pins: '🅿️', rounds: '🍻', turing: '🧮', script: '🧩' };
      if (iconInp) iconInp.value = icons[t] || '🧩';

      const usesLines = t === 'checklist' || t === 'kv' || t === 'poll';
      linesWrap.classList.toggle('hidden', !usesLines);
      targetWrap.classList.toggle('hidden', t !== 'countdown');
      if (detailsEl && (t === 'script' || t === 'turing')) detailsEl.open = true;

      if (t === 'kv') {
        lbl.textContent = 'Key : Value pairs (one per line)';
        ta.placeholder = 'Gate Code : #1725\nWi-Fi : DunderNet\nRoom : Suite 304';
      } else if (t === 'poll') {
        lbl.textContent = 'Poll Options (one per line)';
        ta.placeholder = "Alfredo's Pizza Cafe\nPoor Richard's Pub\nChili's";
      } else if (t === 'checklist') {
        lbl.textContent = 'Checklist Items (one per line)';
        ta.placeholder = 'Cooler & Ice\nDundie Trophies\nAux Cord';
      }
      syncStudioScriptPreview();
    });

    document.getElementById('mm-lines')?.addEventListener('input', syncStudioScriptPreview);
    document.getElementById('mm-target-time')?.addEventListener('input', syncStudioScriptPreview);

    document.getElementById('micromodule-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!appState) return;
      const editId = document.getElementById('mm-edit-id').value;
      const type = document.getElementById('mm-type').value;
      const icon = document.getElementById('mm-icon').value.trim() || '🧩';
      const title = document.getElementById('mm-title').value.trim();
      const targetTime = document.getElementById('mm-target-time').value;
      const code = document.getElementById('mm-script-code').value.trim();
      let parsedData = {};
      try {
        parsedData = JSON.parse(document.getElementById('mm-script-data').value || '{}');
      } catch {
        showToast('Invalid JSON in State Data');
        return;
      }
      if (!title) return;

      if (type === 'countdown' && targetTime) {
        parsedData.target = targetTime;
      }

      appState.microModules = appState.microModules || [];
      if (editId) {
        appState.microModules = appState.microModules.map((m) =>
          m.id === editId
            ? { ...m, type, icon, title, code, data: parsedData, targetTime: type === 'countdown' ? targetTime : m.targetTime, updatedAt: Date.now() }
            : m
        );
      } else {
        const mm = {
          id: 'mm_' + Date.now(),
          type,
          title,
          icon,
          code,
          data: parsedData,
          items: Array.isArray(parsedData.items) ? parsedData.items : [],
          pairs: Array.isArray(parsedData.pairs) ? parsedData.pairs : [],
          options: Array.isArray(parsedData.options) ? parsedData.options : [],
          targetTime: type === 'countdown' ? targetTime : null,
          updatedAt: Date.now(),
        };
        appState.microModules.push(mm);
      }

      closeAllSheets();
      renderMicroModules();
      await syncStateToUrl(`${editId ? 'Updated' : 'Added'} micro-module "${title}"`);
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
      document.getElementById('wiz-playlist-title').value = 'Threat Level Midnight Mix';
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
        if (pendingAiPatchObj) {
          if (!loadLocalByTripId(decrypted.id)) saveStateToLocal(decrypted);
          const patched = applyAiPatchToState(decrypted, pendingAiPatchObj);
          pendingAiPatchObj = null;
          enterAppWithState(patched, pw, false);
        } else {
          enterAppWithState(decrypted, pw, false);
        }
      } catch {
        document.getElementById('unlock-error').classList.remove('hidden');
      }
    });

    // Welcome Splash
    document.getElementById('welcome-go-btn')?.addEventListener('click', () => {
      if (!welcomeSelectedUser || !appState) return;
      currentUser = welcomeSelectedUser;
      localStorage.setItem('roadtrip_who_v4', currentUser);
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

    const addCrewMember = async () => {
      const inp = document.getElementById('who-add-input');
      const name = inp.value.trim();
      if (name && appState && !appState.crew.includes(name)) {
        appState.crew.push(name);
        inp.value = '';
        renderAll();
        await syncStateToUrl(`Added ${name} to crew`);
      }
    };
    document.getElementById('who-add-btn')?.addEventListener('click', addCrewMember);
    document.getElementById('who-add-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCrewMember(); }
    });

    // Quick Action Buttons & Drop Pin Sheet
    document.getElementById('qa-stop-btn')?.addEventListener('click', () => { renderStops(); openSheet('sheet-stop'); });
    document.getElementById('stops-search-open-btn')?.addEventListener('click', () => { renderStops(); openSheet('sheet-stop'); });
    document.getElementById('qa-cost-btn')?.addEventListener('click', () => openExpenseModal('expense', null));
    document.getElementById('split-add-expense-btn')?.addEventListener('click', () => openExpenseModal('expense', null));
    document.getElementById('split-add-payment-btn')?.addEventListener('click', () => openExpenseModal('payment', null));
    document.getElementById('qa-msg-btn')?.addEventListener('click', () => openSheet('sheet-msg'));
    document.getElementById('open-note-sheet-btn')?.addEventListener('click', () => openSheet('sheet-msg'));
    document.getElementById('open-dest-sheet-btn')?.addEventListener('click', () => { renderStops(); openSheet('sheet-stop'); });

    document.getElementById('qa-pin-btn')?.addEventListener('click', () => openPinSheet('parking'));
    document.getElementById('home-drop-pin-btn')?.addEventListener('click', () => openPinSheet('parking'));
    document.getElementById('stops-drop-pin-btn')?.addEventListener('click', () => openPinSheet('parking'));

    document.getElementById('pin-kind-parking-btn')?.addEventListener('click', () => {
      document.getElementById('pin-kind-input').value = 'parking';
      document.getElementById('pin-kind-parking-btn').className = 'btn btn-lime';
      document.getElementById('pin-kind-meetup-btn').className = 'btn';
      document.getElementById('pin-title-input').placeholder = 'e.g. Level 3 Blue Giraffe, Spot 42...';
    });
    document.getElementById('pin-kind-meetup-btn')?.addEventListener('click', () => {
      document.getElementById('pin-kind-input').value = 'meetup';
      document.getElementById('pin-kind-meetup-btn').className = 'btn btn-lime';
      document.getElementById('pin-kind-parking-btn').className = 'btn';
      document.getElementById('pin-title-input').placeholder = 'e.g. Main Stage Clocktower, Hotel Lobby...';
    });

    document.getElementById('pin-snap-gps-btn')?.addEventListener('click', () => {
      if (!('geolocation' in navigator)) {
        showToast('Geolocation not supported in this browser');
        return;
      }
      const btn = document.getElementById('pin-snap-gps-btn');
      btn.textContent = 'Locating...';
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = Number(pos.coords.latitude.toFixed(5));
          const lon = Number(pos.coords.longitude.toFixed(5));
          let label = `${lat}, ${lon}`;
          try {
            const b = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`).then((r) => r.json());
            if (b.locality || b.city) label = `${b.locality || b.city} (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
          } catch {}
          pendingPinCoords = { lat, lon, label };
          document.getElementById('pin-coords-readout').textContent = `📍 ${label}`;
          btn.textContent = '📍 Use My Exact GPS';
          showToast('Locked onto your exact GPS coordinates!');
        },
        () => {
          btn.textContent = '📍 Use My Exact GPS';
          showToast('Could not read GPS — using trip location');
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    const runPinPlaceSearch = async () => {
      const q = document.getElementById('pin-search-input').value;
      const results = await searchPlaces(q, true);
      renderPlaceSearchResults('pin-search-results', results, 'Use', (place) => {
        pendingPinCoords = { lat: place.lat, lon: place.lon, label: place.label || place.name };
        document.getElementById('pin-coords-readout').textContent = `📍 ${pendingPinCoords.label}`;
        const titleInp = document.getElementById('pin-title-input');
        if (!titleInp.value.trim()) titleInp.value = place.name;
      });
    };
    document.getElementById('pin-search-btn')?.addEventListener('click', runPinPlaceSearch);
    document.getElementById('pin-search-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runPinPlaceSearch(); }
    });

    document.getElementById('pin-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!appState) return;
      const kind = document.getElementById('pin-kind-input').value === 'meetup' ? 'meetup' : 'parking';
      const name = document.getElementById('pin-title-input').value.trim();
      const note = document.getElementById('pin-note-input').value.trim();
      if (!name) return;
      const coords = pendingPinCoords || { lat: appState.location?.lat ?? 41.40897, lon: appState.location?.lon ?? -75.66241 };
      appState.pins = appState.pins || [];
      appState.pins.push({
        id: 'pin_' + Date.now(),
        kind,
        name,
        note,
        lat: Number(coords.lat),
        lon: Number(coords.lon),
        addedBy: currentUser,
        createdAt: new Date().toISOString(),
      });
      closeAllSheets();
      renderPins();
      updateMap();
      await syncStateToUrl(`Dropped ${kind === 'meetup' ? 'meetup' : 'parking'} pin: ${name}`);
    });

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
      if (type === 'payment' && payer === payee) {
        showToast('Pick two different people for a payback');
        return;
      }

      if (editId) {
        appState.expenses.transactions = appState.expenses.transactions.map((t) =>
          String(t.id) === String(editId) ? { ...t, type, description, amount, payer, payee: type === 'payment' ? payee : undefined, updatedAt: Date.now() } : t
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
    document.getElementById('sheet-stop-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runStopSearch(e.target.value, false, 'sheet-stop-results');
      }
    });
    document.querySelectorAll('.sheet-pit-chip').forEach((c) => c.addEventListener('click', () => runStopSearch(c.dataset.q, true, 'sheet-stop-results')));
    document.querySelectorAll('.quick-stop-chip').forEach((c) => c.addEventListener('click', () => runStopSearch(c.dataset.q, true, 'stops-tab-results')));

    document.getElementById('center-map-btn')?.addEventListener('click', () => {
      fitMapToTrip();
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
        try { sessionStorage.removeItem(`db_pw_${appState.id}`); } catch {}
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
      c.addEventListener('click', () => {
        const txt = c.textContent.trim();
        if (txt.endsWith(':')) {
          const inp = document.getElementById('sheet-msg-input');
          if (inp) {
            inp.value = txt + ' ';
            inp.focus();
          }
        } else {
          closeAllSheets();
          addNote(txt);
        }
      });
    });

    // Install PWA
    document.getElementById('install-banner-btn')?.addEventListener('click', triggerInstall);
    document.getElementById('who-install-btn')?.addEventListener('click', () => { closeAllSheets(); triggerInstall(); });
    document.getElementById('install-banner-close')?.addEventListener('click', () => {
      try { localStorage.setItem(A2HS_DISMISS_KEY, String(Date.now())); } catch {}
      updateInstallUI();
    });
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; updateInstallUI(); });

    // Close sheets & modals on click or Escape
    document.querySelectorAll('.close-sheet-btn').forEach((b) => b.addEventListener('click', closeAllSheets));
    document.querySelectorAll('.sheet-backdrop').forEach((bd) => {
      bd.addEventListener('click', (e) => { if (e.target === bd) closeAllSheets(); });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeAllSheets();
      document.getElementById('wizard-modal')?.classList.add('hidden');
      document.getElementById('restore-confirm-modal')?.classList.add('hidden');
    });
  }

  function init() {
    applyTheme(currentTheme);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    bindEvents();
    handleHashRoute();
    setInterval(() => {
      if (appState) {
        if (appState.modules?.locations) renderHero();
        const mmBox = document.getElementById('home-micromodules-box');
        if (!mmBox || !mmBox.contains(document.activeElement)) {
          renderMicroModules();
        }
      }
    }, 30000);
  }

  init();
})();
