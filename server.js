'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3855);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STATE_FILE = path.join(DATA_DIR, 'trip-state.json');

const PLAYLIST_ID = 'PLO6qnlYSFTDc';
const COLLAB_URL = 'https://music.youtube.com/playlist?list=PLO6qnlYSFTDc&jct=Bk_kBa-9hpvTi_P7SuT2Iw';
const DEFAULT_CREW = ['Tim', 'Chris', 'Jessica', 'Nancy'];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultState() {
  return {
    crew: [...DEFAULT_CREW],
    trip: {
      title: 'The Ultimate Roadtrip',
      origin: null,
      destination: null,
      stops: [],
      route: null,
    },
    location: {
      lat: null,
      lon: null,
      accuracy: null,
      speedMph: 0,
      heading: null,
      updatedAt: null,
      reportedBy: null,
      road: null,
      locality: null,
      region: null,
      betweenText: null,
      whereAreWe: 'Waiting for first car GPS ping...',
      remainingMeters: null,
      remainingSec: null,
      totalMeters: null,
      totalSec: null,
      progressPct: null,
      nextStop: null,
      stopEtas: {},
      trail: [],
    },
    tripsplitter: {
      people: [...DEFAULT_CREW],
      transactions: [],
      deletedIds: [],
      updatedAt: null,
    },
    music: {
      playlistId: PLAYLIST_ID,
      collabUrl: COLLAB_URL,
      playlistTitle: 'The Ultimate Roadtrip',
      playlistTracks: [],
      playlistSyncedAt: null,
      queue: [],
      nowPlayingVideoId: null,
    },
    messages: [],
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const base = defaultState();
      return {
        ...base,
        ...raw,
        trip: { ...base.trip, ...(raw.trip || {}) },
        location: { ...base.location, ...(raw.location || {}) },
        tripsplitter: { ...base.tripsplitter, ...(raw.tripsplitter || {}) },
        music: { ...base.music, ...(raw.music || {}) },
        messages: Array.isArray(raw.messages) ? raw.messages : [],
      };
    }
  } catch (err) {
    console.error('Failed to load state, starting fresh:', err.message);
  }
  return defaultState();
}

let state = loadState();
let saveTimer = null;
let lastGeocode = { lat: null, lon: null, at: 0 };
let lastRouteRecalcAt = 0;

function persistStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.error('Persist error:', err.message);
    }
  }, 200);
}

// --- SSE Clients ---
const sseClients = new Set();

function broadcast(eventName, payload) {
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': keepalive\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}, 20000);

function publicState() {
  // Strip dense route vertices from SSE/state summary except simplified geometry for map rendering
  const route = state.trip.route
    ? {
        totalMeters: state.trip.route.totalMeters,
        totalSec: state.trip.route.totalSec,
        corridorCities: state.trip.route.corridorCities,
        legs: state.trip.route.legs,
        geometry: state.trip.route.displayGeometry,
        computedAt: state.trip.route.computedAt,
      }
    : null;
  return {
    crew: state.crew,
    trip: {
      title: state.trip.title,
      origin: state.trip.origin,
      destination: state.trip.destination,
      stops: state.trip.stops,
      route,
    },
    location: state.location,
    tripsplitter: state.tripsplitter,
    music: state.music,
    messages: state.messages.slice(-80),
  };
}

// --- Geo Helpers ---
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

function projectToSegment(lat, lon, a, b) {
  const cosLat = Math.cos(((a.lat + b.lat) * Math.PI) / 360);
  const ax = a.lon * cosLat;
  const ay = a.lat;
  const bx = b.lon * cosLat;
  const by = b.lat;
  const px = lon * cosLat;
  const py = lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  }
  const projLat = a.lat + t * (b.lat - a.lat);
  const projLon = a.lon + t * (b.lon - a.lon);
  return {
    t,
    distFromPointM: haversineMeters(lat, lon, projLat, projLon),
    cumDistM: a.cumDistM + t * (b.cumDistM - a.cumDistM),
    cumSec: a.cumSec + t * (b.cumSec - a.cumSec),
  };
}

function snapToRoute(lat, lon, points) {
  if (!points || points.length < 2) return null;
  let best = null;
  for (let i = 0; i < points.length - 1; i++) {
    const p = projectToSegment(lat, lon, points[i], points[i + 1]);
    if (!best || p.distFromPointM < best.distFromPointM) {
      best = {
        ...p,
        legIndex: points[i].legIndex,
        road: points[i].road || points[i + 1].road || null,
      };
    }
  }
  return best;
}

function cleanRoadLabel(raw) {
  if (!raw) return null;
  const s = String(raw).split(';')[0].trim();
  if (!s) return null;
  return s.replace(/^I\s+(\d+)/i, 'I-$1').replace(/^US\s+(\d+)/i, 'US-$1').replace(/^M\s+(\d+)/i, 'M-$1');
}

function cleanCityName(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/^(Charter\s+)?Township\s+of\s+/i, '')
    .replace(/^(City|Village|Town)\s+of\s+/i, '')
    .replace(/\s+(Charter\s+)?Township$/i, '')
    .trim() || null;
}

async function reverseGeocodeFast(lat, lon) {
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
      { signal: AbortSignal.timeout(3500) }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const city = cleanCityName(d.city || d.locality);
    const region = d.principalSubdivisionCode
      ? d.principalSubdivisionCode.replace(/^US-/, '')
      : d.principalSubdivision || null;
    return { city, region };
  } catch {
    return null;
  }
}

async function reverseGeocodeRoad(lat, lon) {
  try {
    const res = await fetch(
      `https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}`,
      { signal: AbortSignal.timeout(3500) }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const props = d.features?.[0]?.properties;
    if (!props) return null;
    return {
      road: cleanRoadLabel(props.street || props.name),
      city: props.city || props.town || props.village || props.county || null,
      region: props.state || null,
    };
  } catch {
    return null;
  }
}

async function computeRouteAndCorridor() {
  const effectiveOrigin =
    state.trip.origin ||
    (state.location.lat != null ? { name: 'Current Location', lat: state.location.lat, lon: state.location.lon } : null);
  const dest = state.trip.destination;

  if (!effectiveOrigin || !dest) {
    state.trip.route = null;
    updateLocationDerived();
    return;
  }

  const activeStops = state.trip.stops.filter((s) => !s.reached);
  const waypoints = [effectiveOrigin, ...activeStops, dest];
  const coordStr = waypoints.map((w) => `${w.lon},${w.lat}`).join(';');

  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&steps=true&geometries=geojson`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) throw new Error('No driving route found');

  const points = [];
  const legEndTargets = [];
  let cumDistM = 0;
  let cumSec = 0;

  route.legs.forEach((leg, legIndex) => {
    for (const step of leg.steps || []) {
      const coords = step.geometry?.coordinates || [];
      if (coords.length === 0) continue;
      const stepLabel = cleanRoadLabel(step.ref || step.name || (step.destinations ? step.destinations.split(':')[0] : ''));
      // Compute geometric length of step coords to apportion step.distance & step.duration smoothly
      const segLens = [];
      let geomTotal = 0;
      for (let i = 0; i < coords.length - 1; i++) {
        const len = haversineMeters(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
        segLens.push(len);
        geomTotal += len;
      }
      const stepStartDist = cumDistM;
      const stepStartSec = cumSec;
      let accGeom = 0;

      for (let i = 0; i < coords.length; i++) {
        if (i > 0) accGeom += segLens[i - 1];
        const frac = geomTotal > 0 ? accGeom / geomTotal : i / Math.max(1, coords.length - 1);
        const ptDist = stepStartDist + frac * (step.distance || 0);
        const ptSec = stepStartSec + frac * (step.duration || 0);
        const [lon, lat] = coords[i];
        // Avoid consecutive duplicate vertices
        const prev = points[points.length - 1];
        if (!prev || prev.lat !== lat || prev.lon !== lon) {
          points.push({ lat, lon, cumDistM: ptDist, cumSec: ptSec, legIndex, road: stepLabel });
        }
      }
      cumDistM = stepStartDist + (step.distance || 0);
      cumSec = stepStartSec + (step.duration || 0);
    }
    legEndTargets.push({
      legIndex,
      stopId: legIndex < activeStops.length ? activeStops[legIndex].id : 'destination',
      name: legIndex < activeStops.length ? activeStops[legIndex].name : dest.name,
      cumDistM,
      cumSec,
    });
  });

  // Downsample display geometry for crisp Leaflet rendering without huge payloads
  const rawGeom = route.geometry?.coordinates || [];
  const stride = Math.max(1, Math.floor(rawGeom.length / 350));
  const displayGeometry = rawGeom.filter((_, idx) => idx % stride === 0 || idx === rawGeom.length - 1);

  // Build ordered corridor cities along the route via parallel reverse geocode samples
  const totalMiles = cumDistM / 1609.344;
  const sampleCount = Math.min(12, Math.max(4, Math.ceil(totalMiles / 22)));
  const samplePromises = [];
  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.min(points.length - 1, Math.round((i / Math.max(1, sampleCount - 1)) * (points.length - 1)));
    const pt = points[idx];
    if (pt) {
      samplePromises.push(
        reverseGeocodeFast(pt.lat, pt.lon).then((geo) =>
          geo?.city ? { name: geo.city, region: geo.region, lat: pt.lat, lon: pt.lon, distM: pt.cumDistM } : null
        )
      );
    }
  }
  const sampled = (await Promise.allSettled(samplePromises))
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);

  const corridorCities = [];
  for (const c of sampled) {
    const last = corridorCities[corridorCities.length - 1];
    if (!last || last.name.toLowerCase() !== c.name.toLowerCase()) {
      corridorCities.push(c);
    }
  }

  state.trip.route = {
    totalMeters: cumDistM,
    totalSec: cumSec,
    points,
    legs: legEndTargets,
    corridorCities,
    displayGeometry,
    computedAt: new Date().toISOString(),
  };

  updateLocationDerived();
}

function buildWhereAreWeText({ road, locality, region, behindCity, aheadCity }) {
  const cleanLoc = locality ? (region ? `${locality}, ${region}` : locality) : null;
  if (behindCity && aheadCity && behindCity !== aheadCity) {
    const base = `Between ${behindCity} & ${aheadCity}`;
    const roadPrefix = road ? `On ${road} • ` : '';
    const nearSuffix =
      locality && locality !== behindCity && locality !== aheadCity ? ` (near ${locality})` : '';
    return `${roadPrefix}${base}${nearSuffix}`;
  }
  if (road && cleanLoc) return `On ${road} • Near ${cleanLoc}`;
  if (cleanLoc) return `Near ${cleanLoc}`;
  if (road) return `On ${road}`;
  return 'Tracking live GPS...';
}

function updateLocationDerived() {
  const loc = state.location;
  const route = state.trip.route;
  if (loc.lat == null || loc.lon == null) return;

  let snapped = null;
  if (route?.points?.length > 1) {
    const candidate = snapToRoute(loc.lat, loc.lon, route.points);
    if (candidate && candidate.distFromPointM < 25000) {
      snapped = candidate;
    }
  }

  let behindCity = null;
  let aheadCity = null;
  const stopEtas = {};
  let nextStop = null;

  if (snapped && route) {
    const remMeters = Math.max(0, route.totalMeters - snapped.cumDistM);
    const remSec = Math.max(0, route.totalSec - snapped.cumSec);
    loc.remainingMeters = Math.round(remMeters);
    loc.remainingSec = Math.round(remSec);
    loc.totalMeters = Math.round(route.totalMeters);
    loc.totalSec = Math.round(route.totalSec);
    loc.progressPct = route.totalMeters > 0 ? Math.min(100, Math.max(0, Math.round((snapped.cumDistM / route.totalMeters) * 100))) : 0;

    if (snapped.road) loc.road = snapped.road;

    for (const legTarget of route.legs || []) {
      const remM = Math.max(0, legTarget.cumDistM - snapped.cumDistM);
      const remS = Math.max(0, legTarget.cumSec - snapped.cumSec);
      stopEtas[legTarget.stopId] = { remainingMeters: Math.round(remM), remainingSec: Math.round(remS) };
      if (!nextStop && legTarget.stopId !== 'destination' && remM > 50) {
        nextStop = { id: legTarget.stopId, name: legTarget.name, remainingMeters: Math.round(remM), remainingSec: Math.round(remS) };
      }
    }

    const cities = route.corridorCities || [];
    for (const c of cities) {
      if (c.distM <= snapped.cumDistM - 3500) behindCity = c.name;
      else if (!aheadCity && c.distM >= snapped.cumDistM + 3500) aheadCity = c.name;
    }
    if (!aheadCity && state.trip.destination?.name) {
      const destCity = state.trip.destination.name.split(',')[0].trim();
      if (destCity && destCity !== behindCity) aheadCity = destCity;
    }
  } else {
    loc.remainingMeters = null;
    loc.remainingSec = null;
    loc.progressPct = null;
  }

  loc.stopEtas = stopEtas;
  loc.nextStop = nextStop;
  loc.betweenText = behindCity && aheadCity ? `Between ${behindCity} & ${aheadCity}` : null;
  loc.whereAreWe = buildWhereAreWeText({
    road: loc.road,
    locality: loc.locality,
    region: loc.region,
    behindCity,
    aheadCity,
  });
}

// --- YouTube Scraping Helpers (No API Key Required) ---
function extractYtInitialData(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/);
  if (!m) return null;
  return JSON.parse(m[1]);
}

function parseYouTubeVideoId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.replace('/', '').slice(0, 11);
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    const v = u.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
  } catch {
    return null;
  }
  return null;
}

async function fetchPlaylistTracks(force = false) {
  const ageMs = state.music.playlistSyncedAt ? Date.now() - Date.parse(state.music.playlistSyncedAt) : Infinity;
  if (!force && ageMs < 180000 && state.music.playlistTracks.length > 0) {
    return state.music.playlistTracks;
  }
  const res = await fetch(`https://www.youtube.com/playlist?list=${PLAYLIST_ID}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
  const html = await res.text();
  const data = extractYtInitialData(html);
  const title = data?.metadata?.playlistMetadataRenderer?.title || state.music.playlistTitle;
  const items =
    data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer
      ?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || [];

  const tracks = [];
  for (const item of items) {
    const v = item.playlistVideoRenderer;
    if (!v?.videoId) continue;
    tracks.push({
      videoId: v.videoId,
      title: v.title?.runs?.[0]?.text || 'Untitled Track',
      channel: v.shortBylineText?.runs?.[0]?.text || '',
      duration: v.lengthText?.simpleText || '',
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    });
  }
  state.music.playlistTitle = title;
  state.music.playlistTracks = tracks;
  state.music.playlistSyncedAt = new Date().toISOString();
  persistStateSoon();
  return tracks;
}

async function searchYouTubeTracks(query) {
  const directId = parseYouTubeVideoId(query);
  if (directId) {
    try {
      const oe = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${directId}&format=json`, {
        signal: AbortSignal.timeout(4000),
      }).then((r) => (r.ok ? r.json() : null));
      return [
        {
          videoId: directId,
          title: oe?.title || `YouTube Track (${directId})`,
          channel: oe?.author_name || 'YouTube Link',
          duration: '',
          thumbnail: `https://i.ytimg.com/vi/${directId}/mqdefault.jpg`,
        },
      ];
    } catch {
      return [
        {
          videoId: directId,
          title: `YouTube Track (${directId})`,
          channel: 'YouTube Link',
          duration: '',
          thumbnail: `https://i.ytimg.com/vi/${directId}/mqdefault.jpg`,
        },
      ];
    }
  }

  const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`YouTube search HTTP ${res.status}`);
  const html = await res.text();
  const data = extractYtInitialData(html);
  const contents =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]
      ?.itemSectionRenderer?.contents || [];

  const results = [];
  for (const entry of contents) {
    const v = entry.videoRenderer;
    if (!v?.videoId) continue;
    results.push({
      videoId: v.videoId,
      title: v.title?.runs?.[0]?.text || 'Untitled',
      channel: v.ownerText?.runs?.[0]?.text || '',
      duration: v.lengthText?.simpleText || '',
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    });
    if (results.length >= 8) break;
  }
  return results;
}

// --- TripSplitter Concurrent Merge ---
function mergeTripSplitter(incoming) {
  const curr = state.tripsplitter;
  const peopleSet = new Set(curr.people.length ? curr.people : DEFAULT_CREW);
  if (Array.isArray(incoming.people)) {
    for (const p of incoming.people) {
      const clean = String(p || '').trim();
      if (clean) peopleSet.add(clean);
    }
  }
  // Support explicit people list override if provided with forcePeopleReplace
  const people = incoming.forcePeopleReplace && Array.isArray(incoming.people)
    ? incoming.people.map((p) => String(p).trim()).filter(Boolean)
    : Array.from(peopleSet);

  const deletedSet = new Set(curr.deletedIds || []);
  if (Array.isArray(incoming.deletedIds)) {
    for (const id of incoming.deletedIds) deletedSet.add(Number(id));
  }

  const txMap = new Map();
  for (const tx of curr.transactions || []) {
    if (!deletedSet.has(Number(tx.id))) txMap.set(Number(tx.id), tx);
  }
  for (const tx of incoming.transactions || []) {
    const id = Number(tx.id);
    if (!id || deletedSet.has(id)) continue;
    const prev = txMap.get(id);
    if (!prev || Number(tx.updatedAt || 0) >= Number(prev.updatedAt || 0)) {
      txMap.set(id, tx);
    }
  }

  state.tripsplitter = {
    people,
    transactions: Array.from(txMap.values()).sort((a, b) => Number(a.id) - Number(b.id)),
    deletedIds: Array.from(deletedSet).slice(-300),
    updatedAt: new Date().toISOString(),
  };
  persistStateSoon();
  return state.tripsplitter;
}

// --- HTTP Helpers ---
function setCors(req, res) {
  const origin = req.headers.origin;
  if (
    origin &&
    /^https:\/\/([a-z0-9-]+\.)*(shangle\.me|dangerous\.business|trycloudflare\.com)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(
      origin
    )
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(reqPath, res) {
  const cleanRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const resolved = path.resolve(ROOT_DIR, cleanRel);
  if (!resolved.startsWith(ROOT_DIR) || resolved.includes(`${path.sep}data${path.sep}`) || cleanRel === 'server.js' || cleanRel === 'launcher.js') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(resolved).pipe(res);
}

// --- Request Router ---
const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = u.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, now: new Date().toISOString() });
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, publicState());
    }

    if (req.method === 'GET' && pathname === '/api/geo/search') {
      const q = (u.searchParams.get('q') || '').trim();
      const latNum = Number(u.searchParams.get('lat'));
      const lonNum = Number(u.searchParams.get('lon'));
      const hasCoords = u.searchParams.get('lat') != null && Number.isFinite(latNum) && Number.isFinite(lonNum);
      const isNearby = u.searchParams.get('nearby') === '1' && hasCoords;
      if (!q) return sendJson(res, 200, { results: [] });

      let results = [];
      if (isNearby) {
        const viewbox = `${lonNum - 0.4},${latNum + 0.4},${lonNum + 0.4},${latNum - 0.4}`;
        const nUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&viewbox=${viewbox}&bounded=1&limit=8`;
        const nRes = await fetch(nUrl, {
          headers: { 'User-Agent': 'RoadtripHub/1.0' },
          signal: AbortSignal.timeout(5500),
        });
        const nData = await nRes.json();
        results = (Array.isArray(nData) ? nData : []).map((item) => {
          const rLat = Number(item.lat);
          const rLon = Number(item.lon);
          const shortParts = String(item.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
          const name = item.name || shortParts[0] || q;
          const label = shortParts.slice(0, 3).join(', ');
          return {
            name,
            label,
            lat: rLat,
            lon: rLon,
            distanceMeters: Math.round(haversineMeters(latNum, lonNum, rLat, rLon)),
          };
        });
        results.sort((a, b) => (a.distanceMeters || 0) - (b.distanceMeters || 0));
      } else {
        let apiUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`;
        if (hasCoords) apiUrl += `&lat=${latNum}&lon=${lonNum}`;
        const pRes = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
        const pData = await pRes.json();
        results = (pData.features || []).map((f) => {
          const p = f.properties || {};
          const rLat = f.geometry.coordinates[1];
          const rLon = f.geometry.coordinates[0];
          const parts = [p.name, p.city || p.town || p.village, p.state].filter(Boolean);
          const dedupParts = parts.filter((v, i) => parts.indexOf(v) === i);
          return {
            name: p.name || dedupParts[0] || q,
            label: dedupParts.join(', '),
            lat: rLat,
            lon: rLon,
            distanceMeters: hasCoords ? Math.round(haversineMeters(latNum, lonNum, rLat, rLon)) : null,
          };
        });
      }
      return sendJson(res, 200, { results: results.slice(0, 6) });
    }

    if (req.method === 'POST' && pathname === '/api/location') {
      const body = await readJsonBody(req);
      const lat = Number(body.lat);
      const lon = Number(body.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return sendJson(res, 400, { error: 'Invalid coordinates' });
      }
      const speedMps = Number(body.speedMps);
      const speedMph = Number.isFinite(speedMps) && speedMps >= 0 ? Math.round(speedMps * 2.23694) : state.location.speedMph;

      state.location.lat = lat;
      state.location.lon = lon;
      state.location.accuracy = Number.isFinite(Number(body.accuracy)) ? Math.round(Number(body.accuracy)) : null;
      state.location.speedMph = speedMph;
      state.location.heading = Number.isFinite(Number(body.heading)) ? Number(body.heading) : null;
      state.location.reportedBy = body.who ? String(body.who).slice(0, 32) : state.location.reportedBy;
      state.location.updatedAt = new Date().toISOString();

      // Breadcrumb trail (append if moved >= 250m)
      const trail = state.location.trail || [];
      const lastPt = trail[trail.length - 1];
      if (!lastPt || haversineMeters(lastPt.lat, lastPt.lon, lat, lon) >= 250) {
        trail.push({ lat, lon, at: state.location.updatedAt });
        if (trail.length > 400) trail.shift();
        state.location.trail = trail;
      }

      // Throttled reverse geocode (every 45s or 1500m)
      const movedFromGeo =
        lastGeocode.lat == null ? Infinity : haversineMeters(lastGeocode.lat, lastGeocode.lon, lat, lon);
      if (Date.now() - lastGeocode.at > 45000 || movedFromGeo > 1500) {
        lastGeocode = { lat, lon, at: Date.now() };
        const [fast, roadInfo] = await Promise.all([reverseGeocodeFast(lat, lon), reverseGeocodeRoad(lat, lon)]);
        if (fast?.city) state.location.locality = fast.city;
        if (fast?.region) state.location.region = fast.region;
        if (roadInfo?.road) state.location.road = roadInfo.road;
        if (!state.location.locality && roadInfo?.city) state.location.locality = roadInfo.city;
      }

      // Auto-compute initial route once destination is set & origin wasn't set manually
      if (state.trip.destination && !state.trip.route && Date.now() - lastRouteRecalcAt > 10000) {
        lastRouteRecalcAt = Date.now();
        try {
          await computeRouteAndCorridor();
        } catch (err) {
          console.error('Auto route error:', err.message);
        }
      }

      updateLocationDerived();
      persistStateSoon();
      broadcast('location', state.location);
      return sendJson(res, 200, { ok: true, location: state.location });
    }

    if (req.method === 'POST' && pathname === '/api/route') {
      const body = await readJsonBody(req);
      const action = body.action;

      if (action === 'setDestination') {
        state.trip.destination = body.place
          ? { name: String(body.place.name || body.place.label), label: String(body.place.label || body.place.name), lat: Number(body.place.lat), lon: Number(body.place.lon) }
          : null;
      } else if (action === 'setOrigin') {
        state.trip.origin = body.place
          ? { name: String(body.place.name || body.place.label), label: String(body.place.label || body.place.name), lat: Number(body.place.lat), lon: Number(body.place.lon) }
          : null;
      } else if (action === 'addStop' && body.place) {
        state.trip.stops.push({
          id: crypto.randomUUID(),
          name: String(body.place.name || body.place.label),
          label: String(body.place.label || body.place.name),
          lat: Number(body.place.lat),
          lon: Number(body.place.lon),
          addedBy: String(body.addedBy || 'Crew').slice(0, 32),
          reached: false,
          addedAt: new Date().toISOString(),
        });
      } else if (action === 'removeStop') {
        state.trip.stops = state.trip.stops.filter((s) => s.id !== body.stopId);
      } else if (action === 'toggleStop') {
        state.trip.stops = state.trip.stops.map((s) =>
          s.id === body.stopId ? { ...s, reached: !s.reached } : s
        );
      } else if (action === 'moveStop') {
        const idx = state.trip.stops.findIndex((s) => s.id === body.stopId);
        const dir = Number(body.dir || 0);
        if (idx >= 0 && idx + dir >= 0 && idx + dir < state.trip.stops.length) {
          const [item] = state.trip.stops.splice(idx, 1);
          state.trip.stops.splice(idx + dir, 0, item);
        }
      } else if (action === 'recalculate') {
        // Explicit route refresh from live GPS
      } else if (action === 'clearRoute') {
        state.trip.origin = null;
        state.trip.destination = null;
        state.trip.stops = [];
        state.trip.route = null;
      }

      try {
        await computeRouteAndCorridor();
      } catch (err) {
        console.error('Route calc error:', err.message);
      }
      persistStateSoon();
      broadcast('state', publicState());
      return sendJson(res, 200, { ok: true, trip: publicState().trip, location: state.location });
    }

    if (req.method === 'GET' && pathname === '/api/tripsplitter') {
      return sendJson(res, 200, state.tripsplitter);
    }

    if (req.method === 'POST' && pathname === '/api/tripsplitter/sync') {
      const body = await readJsonBody(req);
      const merged = mergeTripSplitter(body);
      broadcast('tripsplitter', merged);
      return sendJson(res, 200, merged);
    }

    if (req.method === 'GET' && pathname === '/api/music/playlist') {
      const force = u.searchParams.get('force') === '1';
      const tracks = await fetchPlaylistTracks(force);
      return sendJson(res, 200, {
        playlistId: state.music.playlistId,
        playlistTitle: state.music.playlistTitle,
        collabUrl: state.music.collabUrl,
        tracks,
      });
    }

    if (req.method === 'GET' && pathname === '/api/music/search') {
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 200, { results: [] });
      const results = await searchYouTubeTracks(q);
      return sendJson(res, 200, { results });
    }

    if (req.method === 'POST' && pathname === '/api/music/queue') {
      const body = await readJsonBody(req);
      const action = body.action || 'add';
      if (action === 'add' && body.track?.videoId) {
        state.music.queue.push({
          id: crypto.randomUUID(),
          videoId: String(body.track.videoId).slice(0, 20),
          title: String(body.track.title || 'Untitled').slice(0, 140),
          channel: String(body.track.channel || '').slice(0, 80),
          duration: String(body.track.duration || '').slice(0, 16),
          thumbnail: `https://i.ytimg.com/vi/${String(body.track.videoId).slice(0, 20)}/mqdefault.jpg`,
          addedBy: String(body.addedBy || 'Crew').slice(0, 32),
          note: String(body.note || '').slice(0, 160),
          votes: [String(body.addedBy || 'Crew').slice(0, 32)],
          played: false,
          addedAt: new Date().toISOString(),
        });
      } else if (action === 'vote' && body.queueId) {
        const who = String(body.who || 'Crew').slice(0, 32);
        const item = state.music.queue.find((q) => q.id === body.queueId);
        if (item) {
          if (item.votes.includes(who)) item.votes = item.votes.filter((v) => v !== who);
          else item.votes.push(who);
        }
      } else if (action === 'play') {
        state.music.nowPlayingVideoId = body.videoId ? String(body.videoId).slice(0, 20) : null;
        if (body.queueId) {
          const item = state.music.queue.find((q) => q.id === body.queueId);
          if (item) item.played = true;
        }
      } else if (action === 'togglePlayed' && body.queueId) {
        const item = state.music.queue.find((q) => q.id === body.queueId);
        if (item) item.played = !item.played;
      } else if (action === 'remove' && body.queueId) {
        state.music.queue = state.music.queue.filter((q) => q.id !== body.queueId);
      }
      persistStateSoon();
      broadcast('music', state.music);
      return sendJson(res, 200, state.music);
    }

    if (req.method === 'POST' && pathname === '/api/messages') {
      const body = await readJsonBody(req);
      if (body.action === 'react' && body.messageId && body.emoji) {
        const msg = state.messages.find((m) => m.id === body.messageId);
        if (msg) {
          msg.reactions = msg.reactions || {};
          const who = String(body.who || 'Crew').slice(0, 32);
          const list = msg.reactions[body.emoji] || [];
          if (list.includes(who)) msg.reactions[body.emoji] = list.filter((w) => w !== who);
          else msg.reactions[body.emoji] = [...list, who];
          if (msg.reactions[body.emoji].length === 0) delete msg.reactions[body.emoji];
        }
      } else if (body.text && String(body.text).trim()) {
        state.messages.push({
          id: crypto.randomUUID(),
          author: String(body.author || 'Crew').slice(0, 32),
          text: String(body.text).trim().slice(0, 400),
          placeSnapshot: state.location.whereAreWe && !state.location.whereAreWe.startsWith('Waiting')
            ? state.location.whereAreWe
            : null,
          createdAt: new Date().toISOString(),
          reactions: {},
        });
        if (state.messages.length > 200) state.messages = state.messages.slice(-200);
      }
      persistStateSoon();
      broadcast('messages', state.messages.slice(-80));
      return sendJson(res, 200, { messages: state.messages.slice(-80) });
    }

    if (req.method === 'GET') {
      return serveStatic(pathname, res);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Request error:', err);
    sendJson(res, 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Roadtrip Hub API & server listening on http://${HOST}:${PORT}`);
  // Warm playlist cache in background
  fetchPlaylistTracks(false).catch((e) => console.warn('Initial playlist fetch skipped:', e.message));
});
