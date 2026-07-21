/* Franchise Footprint Matcher — AdSell.ai internal tool */

// Endpoint health measured 2026-07-20: maps.mail.ru ~7s, overpass-api.de ~18s,
// kumi.systems and private.coffee hanging. Wave 1 races the two healthy
// mirrors in parallel; wave 2 tries the rest sequentially only if wave 1 fails.
const OVERPASS_WAVE1 = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const OVERPASS_WAVE2 = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const FETCH_TIMEOUT_MS = 60000; // abort a single endpoint after 60s so a hung mirror fails over

const COLORS = {
  navy: '#0B1437',
  indigo: '#4A6CF7',
  lavender: '#F2F4FF',
};

let PUBS = [];
let radiusMiles = 30;
let map = null;
let mapLayers = [];
let currentResult = null;

/* ---------- Utilities ---------- */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// website values may be bare domains or full URLs with a scheme
function webHref(w) {
  w = String(w || '');
  return /^https?:\/\//.test(w) ? w : 'https://' + w;
}
function webDisplay(w) {
  return String(w || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/* ---------- Overpass query ---------- */
const US_BBOX = '(24.5,-125.0,49.5,-66.9)';

// Primary query: brand-indexed match across the contiguous-US bbox. The brand
// tag is how OSM canonically identifies chains, so this is the reliable,
// index-backed path that completes quickly on the public Overpass server.
function buildBrandQuery(name) {
  const q = escapeRegex(name);
  return `[out:json][timeout:90];
nwr["brand"~"${q}",i]${US_BBOX};
out center tags;`;
}

// Supplemental query: name-based match, scoped to franchise-relevant amenity/
// shop values so it does not scan the whole amenity keyspace. This catches
// stores tagged with a name but no brand. It is best-effort: an unindexed name
// regex over the full US bbox can exceed the public server's runtime budget, so
// if it fails the brand results still stand.
function buildNameQuery(name) {
  const q = escapeRegex(name);
  return `[out:json][timeout:90];
(
  nwr["name"~"${q}",i]["amenity"~"^(cafe|fast_food|restaurant|bar|pub|ice_cream|fuel|bank|pharmacy)$"]${US_BBOX};
  nwr["name"~"${q}",i]["shop"~"^(convenience|supermarket|coffee|bakery|clothes|beauty|hairdresser)$"]${US_BBOX};
);
out center tags;`;
}

// Post a single Overpass query, trying each endpoint until one returns valid
// JSON. Throws if all endpoints fail. `opts.endpoints` and `opts.timeout`
// override defaults (used to keep the best-effort name query fast).
async function fetchOne(endpoint, body, timeout, ctrl) {
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status + (resp.status === 429 ? ' (rate limited)' : ''));
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (parseErr) {
      throw new Error('endpoint busy (non-JSON response)');
    }
    if (json.remark && /timed out|error/i.test(json.remark) && (!json.elements || !json.elements.length)) {
      throw new Error('server timeout: ' + json.remark);
    }
    return json.elements || [];
  } catch (e) {
    throw e.name === 'AbortError' ? new Error('endpoint timed out') : e;
  } finally {
    clearTimeout(timer);
  }
}

// Wave 1: race the healthy mirrors in parallel — first success wins and the
// loser is aborted. Wave 2: only if the whole first wave fails, try the slower
// mirrors one at a time.
async function postOverpass(queryText, opts) {
  opts = opts || {};
  const body = 'data=' + encodeURIComponent(queryText);
  const timeout = opts.timeout || FETCH_TIMEOUT_MS;
  const wave1 = opts.endpoints || OVERPASS_WAVE1;
  const ctrls = wave1.map(() => new AbortController());
  try {
    const winner = await Promise.any(
      wave1.map((ep, i) => fetchOne(ep, body, timeout, ctrls[i]))
    );
    ctrls.forEach((c) => c.abort());
    return winner;
  } catch (aggregate) {
    // whole first wave failed — try slower mirrors sequentially
    let lastErr =
      (aggregate.errors && aggregate.errors[0]) || new Error('endpoints failed');
    if (opts.endpoints) throw lastErr; // caller pinned endpoints; don't escalate
    for (const ep of OVERPASS_WAVE2) {
      try {
        return await fetchOne(ep, body, timeout, new AbortController());
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }
}

async function runOverpass(name) {
  // Brand match is required and reliable.
  const brandEls = await postOverpass(buildBrandQuery(name));
  // Name match is best-effort and only worth a rate-limit slot when the brand
  // query came back thin (small or badly tagged chains). Its failure never
  // delays or sinks a successful brand run.
  let nameEls = [];
  if (brandEls.length < 50) {
    try {
      nameEls = await postOverpass(buildNameQuery(name), { timeout: 30000 });
    } catch (e) {
      nameEls = [];
    }
  }
  return brandEls.concat(nameEls);
}

/* ---------- Google Places proxy ---------- */
// Server-side proxy (see server.js). Never errors: any network/parse failure
// degrades to {available:false} so the search falls back to OSM-only.
async function fetchPlaces(name) {
  try {
    const resp = await fetch('/api/places?query=' + encodeURIComponent(name));
    return await resp.json();
  } catch (e) {
    return { available: false, locations: [] };
  }
}

/* ---------- Parse + dedupe locations ---------- */
function parseLocations(elements) {
  const locs = [];
  for (const el of elements) {
    let lat, lon;
    if (el.type === 'node') {
      lat = el.lat;
      lon = el.lon;
    } else if (el.center) {
      lat = el.center.lat;
      lon = el.center.lon;
    }
    if (lat == null || lon == null) continue;
    const tags = el.tags || {};
    locs.push({
      lat,
      lon,
      city: tags['addr:city'] || null,
      state: tags['addr:state'] || null,
      name: tags.name || tags.brand || '',
    });
  }
  // dedupe within ~150m
  const out = [];
  for (const l of locs) {
    let dup = false;
    for (const k of out) {
      if (haversineMiles(l.lat, l.lon, k.lat, k.lon) < 0.093) {
        // 0.093 mi ~= 150m
        dup = true;
        // prefer the record that has city/state tags
        if (!k.city && l.city) k.city = l.city;
        if (!k.state && l.state) k.state = l.state;
        break;
      }
    }
    if (!dup) out.push(l);
  }
  return out;
}

/* ---------- Coverage + clustering ---------- */
function pubsInReach(loc) {
  const list = [];
  for (const p of PUBS) {
    const d = haversineMiles(loc.lat, loc.lon, p.lat, p.lon);
    if (d <= radiusMiles) list.push({ pub: p, dist: d });
  }
  return list;
}

// nearest publication for city/state fallback labeling and state derivation
function nearestPub(loc) {
  let best = null;
  let bd = Infinity;
  for (const p of PUBS) {
    const d = haversineMiles(loc.lat, loc.lon, p.lat, p.lon);
    if (d < bd) { bd = d; best = p; }
  }
  return { pub: best, dist: bd };
}

// cluster locations: within 15 mi of each other -> same market
function clusterMarkets(locs) {
  const n = locs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { parent[find(a)] = find(b); }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (haversineMiles(locs[i].lat, locs[i].lon, locs[j].lat, locs[j].lon) <= 15) {
        union(i, j);
      }
    }
  }
  const groups = {};
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (groups[r] = groups[r] || []).push(locs[i]);
  }
  return Object.values(groups);
}

function buildMarket(members) {
  // centroid
  let clat = 0, clon = 0;
  for (const m of members) { clat += m.lat; clon += m.lon; }
  clat /= members.length; clon /= members.length;

  // derive state: addr:state tag if present, else nearest pub state
  const stateVotes = {};
  for (const m of members) if (m.state) stateVotes[m.state] = (stateVotes[m.state] || 0) + 1;
  let state = Object.keys(stateVotes).sort((a, b) => stateVotes[b] - stateVotes[a])[0] || null;

  const nearest = nearestPub({ lat: clat, lon: clon });
  if (!state && nearest.pub) state = nearest.pub.state;

  // label by addr:city of largest cluster member (member count is 1 each; use first with city), else nearest pub city
  let city = null;
  const cityVotes = {};
  for (const m of members) if (m.city) cityVotes[m.city] = (cityVotes[m.city] || 0) + 1;
  city = Object.keys(cityVotes).sort((a, b) => cityVotes[b] - cityVotes[a])[0] || null;
  if (!city && nearest.pub) city = nearest.pub.city;
  if (!city) city = 'Unlabeled market';

  // publications within radius of ANY member in this market
  const pubMap = new Map();
  for (const m of members) {
    for (const { pub, dist } of pubsInReach(m)) {
      const key = pub.name + '|' + pub.website;
      if (!pubMap.has(key) || dist < pubMap.get(key).dist) {
        pubMap.set(key, { pub, dist });
      }
    }
  }
  const pubs = Array.from(pubMap.values()).sort((a, b) => a.dist - b.dist);

  return {
    label: city,
    state: state || '',
    lat: clat,
    lon: clon,
    locations: members,
    pubs,
    pubKeys: new Set(pubs.map((x) => x.pub.name + '|' + x.pub.website)),
  };
}

/* ---------- Greedy 8-market flight ---------- */
function greedyFlight(markets, k = 8) {
  const covered = new Set();
  const chosen = [];
  const pool = markets.filter((m) => m.pubs.length > 0);
  const remaining = [...pool];
  while (chosen.length < k && remaining.length) {
    let bestIdx = -1, bestGain = -1, bestTie = -1;
    for (let i = 0; i < remaining.length; i++) {
      const m = remaining[i];
      let gain = 0;
      for (const key of m.pubKeys) if (!covered.has(key)) gain++;
      // tie-break by number of locations
      if (gain > bestGain || (gain === bestGain && m.locations.length > bestTie)) {
        bestGain = gain; bestIdx = i; bestTie = m.locations.length;
      }
    }
    if (bestIdx < 0 || bestGain <= 0) break;
    const m = remaining.splice(bestIdx, 1)[0];
    for (const key of m.pubKeys) covered.add(key);
    chosen.push({ market: m, added: bestGain, runningTotal: covered.size });
  }
  return chosen;
}

/* ---------- Main search ---------- */
async function doSearch(name) {
  name = (name || '').trim();
  if (!name) return;
  document.getElementById('franchise-input').value = name;

  showStatus('loading', name);
  hide('results');
  setBtn(true);

  const [overpassRes, placesRes] = await Promise.allSettled([
    runOverpass(name),
    fetchPlaces(name),
  ]);

  const places =
    placesRes.status === 'fulfilled' ? placesRes.value : { available: false, locations: [] };
  const placesOk = !!(places && places.available && Array.isArray(places.locations));

  // Both sources down -> existing error state. Places-only is a valid result.
  if (overpassRes.status === 'rejected' && !placesOk) {
    showStatus('error', name, overpassRes.reason && overpassRes.reason.message);
    setBtn(false);
    return;
  }

  const locs =
    overpassRes.status === 'fulfilled' ? parseLocations(overpassRes.value) : [];

  if (placesOk) {
    for (const g of places.locations) {
      if (!g || g.lat == null || g.lon == null) continue;
      // skip Places results within 0.15 mi of an existing OSM location
      let dup = false;
      for (const k of locs) {
        if (haversineMiles(g.lat, g.lon, k.lat, k.lon) < 0.15) { dup = true; break; }
      }
      if (!dup) {
        locs.push({
          lat: g.lat,
          lon: g.lon,
          city: g.city || null,
          state: g.state || null,
          name: g.name || '',
        });
      }
    }
  }

  if (!locs.length) {
    showStatus('empty', name);
    setBtn(false);
    return;
  }

  const rawMarkets = clusterMarkets(locs).map(buildMarket);
  const markets = rawMarkets.sort((a, b) => b.pubs.length - a.pubs.length || b.locations.length - a.locations.length);
  const flight = greedyFlight(markets, 8);

  currentResult = { name, locs, markets, flight, usedPlaces: placesOk };
  renderResults(currentResult);
  dmReset(name); // new search: prefill company, collapse panel, clear results
  setBtn(false);
}

/* ---------- Status rendering ---------- */
function showStatus(kind, name, detail) {
  const el = document.getElementById('status');
  el.className = 'status';
  el.classList.remove('hidden');
  if (kind === 'loading') {
    el.classList.add('loading');
    el.innerHTML = `<div class="spinner"></div>
      <h3>Searching OpenStreetMap for "${esc(name)}"</h3>
      <p>Querying every US location. This typically takes 10 to 40 seconds.</p>
      <p class="sub">If the primary endpoint is busy, a fallback is tried automatically.</p>`;
  } else if (kind === 'error') {
    el.classList.add('error');
    el.innerHTML = `<h3>Search could not complete</h3>
      <p>The Overpass API did not respond. This can happen when the public servers are under load. Wait a moment and try again.</p>
      <p class="sub">Detail: ${esc(detail || 'network error')}</p>`;
  } else if (kind === 'empty') {
    el.innerHTML = `<h3>No locations found for "${esc(name)}"</h3>
      <p>OpenStreetMap returned no matching brand or named amenities. Check the spelling, or try a shorter form of the name.</p>`;
  }
}

function hideStatus() {
  document.getElementById('status').classList.add('hidden');
}
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function setBtn(loading) {
  const b = document.getElementById('go-btn');
  b.disabled = loading;
  b.textContent = loading ? 'Searching…' : 'Go';
}

/* ---------- Results rendering ---------- */
function renderResults(r) {
  hideStatus();
  show('results');
  const foot = document.getElementById('foot-src');
  if (foot) {
    foot.textContent = r.usedPlaces
      ? 'Location data from OpenStreetMap and Google Places.'
      : 'Location data from OpenStreetMap and may undercount newer stores.';
  }
  renderKPIs(r);
  renderMap(r);
  renderFlight(r);
  renderMarketTable(r);
  renderStateTable(r);
}

function renderKPIs(r) {
  const states = new Set();
  for (const m of r.markets) if (m.state) states.add(m.state);
  const marketsWithCoverage = r.markets.filter((m) => m.pubs.length > 0).length;
  const uniquePubs = new Set();
  for (const m of r.markets) for (const k of m.pubKeys) uniquePubs.add(k);

  const source = r.usedPlaces
    ? 'Source: OpenStreetMap + Google Places'
    : 'Source: OpenStreetMap';

  const row = document.getElementById('kpi-row');
  row.innerHTML = `
    <div class="kpi"><div class="num">${r.locs.length}</div><div class="lab">Locations found</div><div class="src">${source}</div></div>
    ${kpi(states.size, 'States')}
    ${kpi(marketsWithCoverage, 'Markets with coverage')}
    ${kpi(uniquePubs.size, 'Publications in reach')}`;
}
function kpi(num, lab) {
  return `<div class="kpi"><div class="num">${num}</div><div class="lab">${lab}</div></div>`;
}

function renderMap(r) {
  if (!map) {
    map = L.map('map', { scrollWheelZoom: false }).setView([39.5, -98.35], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);
  }
  mapLayers.forEach((l) => map.removeLayer(l));
  mapLayers = [];

  const flightKeys = new Set(r.flight.map((f) => f.market.label + '|' + f.market.state));

  // publication dots (indigo)
  for (const p of PUBS) {
    const c = L.circleMarker([p.lat, p.lon], {
      radius: 4, color: COLORS.indigo, weight: 1, fillColor: COLORS.indigo, fillOpacity: 0.75,
    }).bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.city)}, ${esc(p.state)}`);
    c.addTo(map); mapLayers.push(c);
  }
  // franchise location dots (navy)
  for (const l of r.locs) {
    const c = L.circleMarker([l.lat, l.lon], {
      radius: 3, color: COLORS.navy, weight: 1, fillColor: COLORS.navy, fillOpacity: 0.85,
    });
    c.addTo(map); mapLayers.push(c);
  }
  // flight market rings
  for (const f of r.flight) {
    const m = f.market;
    const ring = L.circleMarker([m.lat, m.lon], {
      radius: 13, color: COLORS.indigo, weight: 2.5, fill: false,
    }).bindPopup(`<b>${esc(m.label)}, ${esc(m.state)}</b><br>${m.locations.length} locations · ${m.pubs.length} pubs in reach`);
    ring.addTo(map); mapLayers.push(ring);
  }

  // fit to franchise bounds
  if (r.locs.length) {
    const b = L.latLngBounds(r.locs.map((l) => [l.lat, l.lon]));
    map.fitBounds(b.pad(0.15));
  }
  setTimeout(() => map.invalidateSize(), 100);
}

function renderFlight(r) {
  const f = r.flight;
  const uniqueTotal = f.length ? f[f.length - 1].runningTotal : 0;
  document.getElementById('flight-total').innerHTML =
    `<b>${uniqueTotal}</b> unique publications across ${f.length} market${f.length === 1 ? '' : 's'}`;

  const list = document.getElementById('flight-list');
  if (!f.length) {
    list.innerHTML = `<div class="flight-item"><span></span><span class="no-pubs">No markets fall within radius of a publication. Try a wider radius.</span></div>`;
    document.getElementById('copy-string').textContent = '';
    return;
  }
  list.innerHTML = f.map((x, i) => {
    const m = x.market;
    return `<div class="flight-item">
      <span class="flight-rank">${i + 1}</span>
      <span class="flight-market">${esc(m.label)}, ${esc(m.state)}
        <span class="meta">· ${m.locations.length} location${m.locations.length === 1 ? '' : 's'}</span></span>
      <span class="flight-added"><b>+${x.added}</b> new pubs</span>
      <span class="flight-run">${x.runningTotal} total</span>
    </div>`;
  }).join('');

  const str = f.map((x) => `${x.market.label}, ${x.market.state}`).join('; ');
  document.getElementById('copy-string').textContent = str;
}

let sortState = { key: 'pubs', dir: -1 };
function renderMarketTable(r) {
  const tbody = document.getElementById('market-tbody');
  const rows = [...r.markets];
  const { key, dir } = sortState;
  rows.sort((a, b) => {
    let va, vb;
    if (key === 'label') { va = a.label.toLowerCase(); vb = b.label.toLowerCase(); }
    else if (key === 'state') { va = a.state; vb = b.state; }
    else if (key === 'locations') { va = a.locations.length; vb = b.locations.length; }
    else { va = a.pubs.length; vb = b.pubs.length; }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });

  tbody.innerHTML = rows.map((m, idx) => {
    const pubsHtml = m.pubs.length
      ? m.pubs.map((x) => `<div class="pub">
          <span><span class="pname">${esc(x.pub.name)}</span> <span class="pbase">${esc(x.pub.city)}, ${esc(x.pub.state)}</span></span>
          <span class="pdist">${x.dist.toFixed(1)} mi</span>
          <span class="pweb"><a href="${esc(webHref(x.pub.website))}" target="_blank" rel="noopener">${esc(webDisplay(x.pub.website))}</a></span>
        </div>`).join('')
      : `<div class="no-pubs">No publications within ${radiusMiles} miles.</div>`;
    return `<tr class="market-row" data-idx="${idx}">
        <td><span class="expander">+</span> <span class="market-label">${esc(m.label)}</span></td>
        <td>${esc(m.state)}</td>
        <td class="num-col">${m.locations.length}</td>
        <td class="num-col">${m.pubs.length}</td>
      </tr>
      <tr class="detail-row hidden" data-detail="${idx}"><td colspan="4"><div class="pub-list">${pubsHtml}</div></td></tr>`;
  }).join('');

  tbody.querySelectorAll('.market-row').forEach((row) => {
    row.addEventListener('click', () => {
      const idx = row.getAttribute('data-idx');
      const detail = tbody.querySelector(`[data-detail="${idx}"]`);
      const exp = row.querySelector('.expander');
      const hidden = detail.classList.toggle('hidden');
      exp.textContent = hidden ? '+' : '\u2013';
    });
  });

  updateSortArrows();
}

function updateSortArrows() {
  document.querySelectorAll('#market-table thead th[data-key]').forEach((th) => {
    const arrow = th.querySelector('.arrow');
    if (arrow) arrow.remove();
    if (th.getAttribute('data-key') === sortState.key) {
      const s = document.createElement('span');
      s.className = 'arrow';
      s.textContent = sortState.dir === 1 ? ' \u25B2' : ' \u25BC';
      th.appendChild(s);
    }
  });
}

function renderStateTable(r) {
  const tbody = document.getElementById('state-tbody');
  const locByState = {};
  for (const m of r.markets) {
    if (!m.state) continue;
    locByState[m.state] = (locByState[m.state] || 0) + m.locations.length;
  }
  const pubByState = {};
  for (const p of PUBS) pubByState[p.state] = (pubByState[p.state] || 0) + 1;

  const states = Object.keys(locByState).sort((a, b) => locByState[b] - locByState[a]);
  if (!states.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="no-pubs">No state data available.</td></tr>`;
    return;
  }
  tbody.innerHTML = states.map((s) => `<tr>
      <td class="market-label">${esc(s)}</td>
      <td class="num-col">${locByState[s]}</td>
      <td class="num-col">${pubByState[s] || 0}</td>
    </tr>`).join('');
}

/* ---------- Decision-makers (Apollo) ---------- */
const DM_TITLES = [
  'Chief Marketing Officer',
  'VP Marketing',
  'Director of Marketing',
  'Director of Franchise Development',
  'Chief Development Officer',
];

function dmReset(name) {
  document.getElementById('dm-company').value = name || '';
  document.getElementById('dm-domain').value = '';
  document.getElementById('dm-body').classList.add('hidden');
  document.getElementById('dm-expander').textContent = '+';
  document.getElementById('dm-status').classList.add('hidden');
  document.getElementById('dm-results').classList.add('hidden');
  document.getElementById('dm-tbody').innerHTML = '';
  document.querySelectorAll('#dm-titles .chip').forEach((c) => c.classList.add('active'));
}

function dmStatus(msg) {
  const el = document.getElementById('dm-status');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function dmSearch() {
  const btn = document.getElementById('dm-search');
  if (btn.disabled) return;
  const company = document.getElementById('dm-company').value.trim();
  const domain = document.getElementById('dm-domain').value.trim();
  const titles = [...document.querySelectorAll('#dm-titles .chip.active')]
    .map((c) => c.getAttribute('data-title'));
  if (!company && !domain) {
    dmStatus('Enter a company name or domain.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Searching\u2026';
  dmStatus(null);
  document.getElementById('dm-results').classList.add('hidden');

  let data;
  try {
    const resp = await fetch('/api/apollo/people-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company, domain, titles: titles.length ? titles : undefined }),
    });
    if (resp.status === 401) {
      dmStatus('Sign in required \u2014 open the Publications page to authenticate, then retry.');
      return;
    }
    data = await resp.json();
  } catch (e) {
    dmStatus('Contact search failed \u2014 network error. Try again.');
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search contacts';
  }

  if (!data || data.available === false) {
    if (data && data.error === 'rate_limited') {
      dmStatus('Apollo rate limit hit \u2014 wait a minute and retry.');
    } else if (data && data.error) {
      dmStatus('Contact search failed \u2014 try again in a moment.');
    } else {
      dmStatus('Apollo key not configured \u2014 add APOLLO_API_KEY in Railway.');
    }
    return;
  }
  if (!data.people || !data.people.length) {
    dmStatus('No matching contacts found \u2014 try removing title filters or adding the company domain.');
    return;
  }
  dmRenderPeople(data.people);
}

const LINKEDIN_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45z"/></svg>';

function dmRenderPeople(people) {
  const tbody = document.getElementById('dm-tbody');
  tbody.innerHTML = people.map((p) => {
    const loc = [p.city, p.state].filter(Boolean).join(', ') || '\u2014';
    const li = p.linkedin_url
      ? `<a class="dm-li" href="${esc(p.linkedin_url)}" target="_blank" rel="noopener" title="LinkedIn profile">${LINKEDIN_SVG}</a>`
      : '\u2014';
    const revealable = p.email_status === 'verified' || p.email_status === 'likely';
    const email = revealable
      ? `<button class="btn btn-ghost dm-reveal" data-id="${esc(p.id)}">Reveal (1 credit)</button>`
      : `<span class="dm-muted">${esc(p.email_status || 'unavailable')}</span>`;
    return `<tr>
      <td class="market-label">${esc(p.name || '')}</td>
      <td>${esc(p.title || '')}</td>
      <td>${esc(loc)}</td>
      <td>${li}</td>
      <td class="dm-email">${email}</td>
    </tr>`;
  }).join('');
  document.getElementById('dm-results').classList.remove('hidden');

  tbody.querySelectorAll('.dm-reveal').forEach((b) => {
    b.addEventListener('click', () => dmReveal(b));
  });
}

async function dmReveal(btn) {
  if (btn.disabled) return;
  if (!window.confirm('Reveal this email? This uses 1 Apollo credit.')) return;
  btn.disabled = true;
  btn.textContent = 'Revealing\u2026';
  const cell = btn.closest('td');
  try {
    const resp = await fetch('/api/apollo/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: btn.getAttribute('data-id') }),
    });
    const data = await resp.json();
    if (resp.ok && data && data.available && data.email) {
      cell.innerHTML = `<a href="mailto:${esc(data.email)}">${esc(data.email)}</a>`;
    } else {
      cell.innerHTML = '<span class="dm-muted">reveal failed</span>';
    }
  } catch (e) {
    cell.innerHTML = '<span class="dm-muted">reveal failed</span>';
  }
}

function dmInit() {
  const chips = document.getElementById('dm-titles');
  chips.innerHTML = DM_TITLES.map((t) =>
    `<button type="button" class="chip active" data-title="${esc(t)}">${esc(t)}</button>`
  ).join('');
  chips.querySelectorAll('.chip').forEach((c) => {
    c.addEventListener('click', () => c.classList.toggle('active'));
  });

  document.getElementById('dm-toggle').addEventListener('click', () => {
    const body = document.getElementById('dm-body');
    const hidden = body.classList.toggle('hidden');
    document.getElementById('dm-expander').textContent = hidden ? '+' : '\u2013';
  });
  document.getElementById('dm-search').addEventListener('click', dmSearch);
}

/* ---------- Copy button ---------- */
function copyFlight() {
  const str = document.getElementById('copy-string').textContent;
  if (!str) return;
  const btn = document.getElementById('copy-btn');
  const done = () => { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy market string'), 1600); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(str).then(done).catch(() => fallbackCopy(str, done));
  } else fallbackCopy(str, done);
}
/* ---------- Pilot brief generation ---------- */
function openBrief() {
  const r = currentResult;
  if (!r || !r.flight || !r.flight.length) return;
  const f = r.flight;

  // unique pubs across flight markets, each assigned to its nearest flight market
  const seen = new Map();
  for (const x of f) {
    for (const { pub, dist } of x.market.pubs) {
      const key = pub.name + '|' + pub.website;
      const cur = seen.get(key);
      if (!cur || dist < cur.dist) seen.set(key, { pub, dist, market: x.market });
    }
  }

  // rows grouped in flight order, nearest-first within each market
  const pubs = [];
  for (const x of f) {
    const rows = [...seen.values()]
      .filter((v) => v.market === x.market)
      .sort((a, b) => a.dist - b.dist);
    for (const v of rows) {
      pubs.push({
        name: esc(v.pub.name),
        city: esc(v.pub.city),
        state: esc(v.pub.state),
        website: esc(webDisplay(v.pub.website)),
        lat: v.pub.lat,
        lon: v.pub.lon,
        near: esc(x.market.label + ', ' + x.market.state),
        near_mi: Math.round(v.dist),
      });
    }
  }

  const payload = {
    name: esc(r.name),
    radius: radiusMiles,
    markets: f.map((x) => ({
      lon: x.market.lon,
      lat: x.market.lat,
      label: esc(x.market.label + ', ' + x.market.state),
    })),
    pubs,
  };
  try {
    sessionStorage.setItem('adsell_brief', JSON.stringify(payload));
  } catch (e) {
    return;
  }
  window.open('brief.html', '_blank');
}

function fallbackCopy(str, done) {
  const ta = document.createElement('textarea');
  ta.value = str; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) {}
  document.body.removeChild(ta);
}

/* ---------- Init ---------- */
async function init() {
  // Live publication list (managed via publications.html). Falls back to the
  // static seed file if the API is unavailable.
  try {
    const resp = await fetch('/api/publications');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    PUBS = await resp.json();
  } catch (e) {
    try {
      const resp = await fetch('publications.json');
      PUBS = await resp.json();
    } catch (e2) {
      PUBS = window.PUBLICATIONS || [];
    }
  }

  document.getElementById('go-btn').addEventListener('click', () => {
    doSearch(document.getElementById('franchise-input').value);
  });
  document.getElementById('franchise-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch(e.target.value);
  });
  document.querySelectorAll('.chip').forEach((c) => {
    c.addEventListener('click', () => doSearch(c.getAttribute('data-q')));
  });
  document.getElementById('copy-btn').addEventListener('click', copyFlight);
  document.getElementById('brief-btn').addEventListener('click', openBrief);
  dmInit();

  document.querySelectorAll('.radius-btns button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.radius-btns button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      radiusMiles = parseInt(b.getAttribute('data-r'), 10);
      // recompute if we have a result
      if (currentResult) {
        const rawMarkets = clusterMarkets(currentResult.locs).map(buildMarket);
        const markets = rawMarkets.sort((a, b) => b.pubs.length - a.pubs.length || b.locations.length - a.locations.length);
        const flight = greedyFlight(markets, 8);
        currentResult = { ...currentResult, markets, flight };
        renderResults(currentResult);
      }
    });
  });

  document.querySelectorAll('#market-table thead th[data-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-key');
      if (sortState.key === key) sortState.dir *= -1;
      else { sortState.key = key; sortState.dir = (key === 'label' || key === 'state') ? 1 : -1; }
      if (currentResult) renderMarketTable(currentResult);
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
