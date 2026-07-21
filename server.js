"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Railway terminates TLS at a proxy; needed so req.ip is the client IP.
app.set("trust proxy", 1);

const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
  "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
  "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
  "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
  "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
  "Washington", "West Virginia", "Wisconsin", "Wyoming",
  "District of Columbia",
];

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC",
]);

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK =
  "places.id,places.displayName,places.location,places.addressComponents,nextPageToken";
const MAX_PAGES_PER_STATE = 3; // Google caps text search at 60 results (3 x 20)
const STATE_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // each uncached national search is ~51-150 billable calls

const DAILY_LIMIT = process.env.PLACES_DAILY_LIMIT !== undefined
  ? Number(process.env.PLACES_DAILY_LIMIT)
  : 3000;
const IP_SEARCH_LIMIT = 10; // uncached searches per IP per hour
const IP_WINDOW_MS = 60 * 60 * 1000;

// query (lowercased, trimmed) -> { expires, payload }
const cache = new Map();

// ---------------------------------------------------------------------------
// Cost protection
// ---------------------------------------------------------------------------

class BudgetExceededError extends Error {}

const budget = { day: "", used: 0 };

function budgetRemaining() {
  const day = new Date().toISOString().slice(0, 10); // resets at midnight UTC
  if (budget.day !== day) {
    budget.day = day;
    budget.used = 0;
  }
  return DAILY_LIMIT - budget.used;
}

// ip -> timestamps of uncached searches within the last hour
const ipSearches = new Map();

function ipAllowed(ip) {
  const now = Date.now();
  const recent = (ipSearches.get(ip) || []).filter((t) => now - t < IP_WINDOW_MS);
  if (recent.length >= IP_SEARCH_LIMIT) {
    ipSearches.set(ip, recent);
    return false;
  }
  recent.push(now);
  ipSearches.set(ip, recent);
  return true;
}

// ---------------------------------------------------------------------------
// Brand-name matching
// ---------------------------------------------------------------------------

function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/['\u2019]/g, "") // "Mike's" -> "mikes", not "mike s"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// A name matches when every query token appears in it, and the name either
// starts with the first query token or contains the full query as a phrase.
// The extra-token cap rejects lookalikes that append several unrelated words
// (e.g. "starbucks" must not match "Starbucks Reserve Roastery Deli").
function matchesBrand(normalizedQuery, name) {
  const n = normalizeText(name);
  if (!normalizedQuery || !n) return false;

  const qTokens = normalizedQuery.split(" ");
  const nTokens = n.split(" ");
  const nameSet = new Set(nTokens);
  if (!qTokens.every((t) => nameSet.has(t))) return false;

  const startsWithFirst = nTokens[0] === qTokens[0];
  const containsPhrase = ` ${n} `.includes(` ${normalizedQuery} `);
  if (!startsWithFirst && !containsPhrase) return false;

  const querySet = new Set(qTokens);
  const extraTokens = nTokens.filter((t) => !querySet.has(t));
  return extraTokens.length <= 2;
}

// ---------------------------------------------------------------------------
// Google Places fan-out
// ---------------------------------------------------------------------------

function addressPart(components, types) {
  if (!Array.isArray(components)) return undefined;
  for (const type of types) {
    const match = components.find((c) => Array.isArray(c.types) && c.types.includes(type));
    if (match) return match;
  }
  return undefined;
}

async function placesRequest(apiKey, body, stats) {
  if (budgetRemaining() <= 0) throw new BudgetExceededError();
  budget.used++;
  stats.requests++;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Places API HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchState(apiKey, query, stateName, stats) {
  const places = [];
  let pageToken;
  for (let page = 0; page < MAX_PAGES_PER_STATE; page++) {
    const body = {
      textQuery: `${query} in ${stateName}`,
      regionCode: "US",
      pageSize: 20,
    };
    if (pageToken) body.pageToken = pageToken;
    const data = await placesRequest(apiKey, body, stats);
    if (Array.isArray(data.places)) places.push(...data.places);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return places;
}

async function nationwideSearch(apiKey, query) {
  const byId = new Map();
  const normalizedQuery = normalizeText(query);
  const states = [...US_STATES];
  const stats = { requests: 0, statesQueried: 0 };
  let budgetHit = false;

  async function worker() {
    while (states.length > 0 && !budgetHit) {
      const stateName = states.shift();
      let places;
      try {
        places = await searchState(apiKey, query, stateName, stats);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetHit = true;
          return;
        }
        continue; // failed state is skipped, not fatal
      }
      stats.statesQueried++;
      for (const place of places) {
        if (!place || !place.id || byId.has(place.id)) continue;
        const name = place.displayName && place.displayName.text;
        if (!name || !matchesBrand(normalizedQuery, name)) continue;
        if (!place.location) continue;
        const stateComp = addressPart(place.addressComponents, [
          "administrative_area_level_1",
        ]);
        const stateCode = stateComp && stateComp.shortText;
        if (!US_STATE_CODES.has(stateCode)) continue; // US-only filter
        const cityComp = addressPart(place.addressComponents, [
          "locality",
          "postal_town",
          "sublocality",
        ]);
        byId.set(place.id, {
          lat: place.location.latitude,
          lon: place.location.longitude,
          city: cityComp ? cityComp.longText || cityComp.shortText : undefined,
          state: stateCode,
          name,
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: STATE_CONCURRENCY }, () => worker())
  );
  if (budgetHit) throw new BudgetExceededError(); // don't cache a partial result
  if (stats.statesQueried === 0) {
    // every state failed (bad key, outage) — don't cache an empty success
    throw new Error("all states failed");
  }
  return { locations: [...byId.values()], stats };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function logSearch(query, cached, statesQueried, requests, kept) {
  console.log(
    `[places] query="${query}" cached=${cached} states=${statesQueried} requests=${requests} kept=${kept}`
  );
}

app.get("/api/places", async (req, res) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const query = String(req.query.query || "").trim();

  if (!apiKey || !query) {
    return res.json({ available: false, locations: [] });
  }

  const cacheKey = query.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    logSearch(query, true, 0, 0, cached.payload.locations.length);
    return res.json(cached.payload);
  }

  if (!ipAllowed(req.ip)) {
    return res.json({ available: false, locations: [], error: "rate_limited" });
  }
  if (budgetRemaining() <= 0) {
    return res.json({ available: false, locations: [], error: "budget_exceeded" });
  }

  try {
    const { locations, stats } = await nationwideSearch(apiKey, query);
    logSearch(query, false, stats.statesQueried, stats.requests, locations.length);
    const payload = {
      available: true,
      source: "google_places",
      count: locations.length,
      locations,
    };
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, payload });
    res.json(payload);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return res.json({ available: false, locations: [], error: "budget_exceeded" });
    }
    // degrade silently so the frontend falls back to OSM-only
    res.json({ available: false, locations: [], error: "places_failed" });
  }
});

// ---------------------------------------------------------------------------
// Publications store
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.DATA_DIR || ".";
const LIVE_PATH = path.join(DATA_DIR, "publications-live.json");
const BACKUP_PATH = path.join(DATA_DIR, "publications-live.backup.json");
const SEED_PATH = path.join(__dirname, "publications.json");
const GEOCODER_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

let publications = [];

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function makeId(name, city, state, taken) {
  const base = slugify(`${name} ${city} ${state}`) || "pub";
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

// Assign stable ids, keeping valid unique ids already present on the rows.
function withIds(rows) {
  const taken = new Set();
  return rows.map((r) => {
    let id = typeof r.id === "string" && r.id && !taken.has(r.id) ? r.id : null;
    if (id) taken.add(id);
    else id = makeId(r.name, r.city, r.state, taken);
    return {
      id,
      name: r.name,
      city: r.city,
      state: r.state,
      address: r.address || "",
      zip: r.zip || "",
      website: r.website || "",
      lat: r.lat != null ? r.lat : null,
      lon: r.lon != null ? r.lon : null,
    };
  });
}

function persistPublications() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = LIVE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(publications, null, 2));
  fs.renameSync(tmp, LIVE_PATH); // atomic replace
}

function loadPublications() {
  if (fs.existsSync(LIVE_PATH)) {
    publications = JSON.parse(fs.readFileSync(LIVE_PATH, "utf8"));

    // Migration: a live file written before the address/zip schema (no row has
    // an address field) is stale seed data. Re-seed from the current
    // publications.json, keeping any pubs that were added via the CRUD API,
    // with a backup of the old file.
    if (
      publications.length &&
      !publications.some((p) => p.address !== undefined)
    ) {
      const seed = withIds(JSON.parse(fs.readFileSync(SEED_PATH, "utf8")));
      const seedKeys = new Set(
        seed.map((p) => dupKey(p.name, p.city, p.state))
      );
      const userAdded = publications.filter(
        (p) => !seedKeys.has(dupKey(p.name, p.city, p.state))
      );
      fs.copyFileSync(LIVE_PATH, BACKUP_PATH);
      publications = withIds([...seed, ...userAdded]);
      persistPublications();
      console.log(
        `Migrated publications-live.json to address/zip schema ` +
          `(${seed.length} reseeded, ${userAdded.length} user-added kept, old file backed up)`
      );
      return;
    }

    if (publications.some((p) => !p.id)) {
      publications = withIds(publications);
      persistPublications();
    }
  } else {
    publications = withIds(JSON.parse(fs.readFileSync(SEED_PATH, "utf8")));
    persistPublications();
  }
}

// ---------------------------------------------------------------------------
// Publications API
// ---------------------------------------------------------------------------

const AUTH_USER = process.env.BASIC_AUTH_USER;
const AUTH_PASS = process.env.BASIC_AUTH_PASS;

function requireAuth(req, res, next) {
  if (!AUTH_USER || !AUTH_PASS) return next(); // gate disabled; warned at startup
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const i = decoded.indexOf(":");
    if (
      i > -1 &&
      decoded.slice(0, i) === AUTH_USER &&
      decoded.slice(i + 1) === AUTH_PASS
    ) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="publications"');
  res.status(401).json({ error: "unauthorized" });
}

function checkCoreField(value, key) {
  if (typeof value !== "string" || !value.trim()) {
    return `${key} is required and must be a non-empty string`;
  }
  return null;
}

function checkState(state) {
  if (!US_STATE_CODES.has(String(state).trim().toUpperCase())) {
    return "state must be a valid 2-letter US state code";
  }
  return null;
}

function checkOptionalFields(row) {
  for (const k of ["website", "address", "zip"]) {
    if (row[k] !== undefined && row[k] !== null && typeof row[k] !== "string") {
      return `${k} must be a string`;
    }
  }
  if (row.zip != null && String(row.zip).trim() !== "" && !/^\d{5}$/.test(String(row.zip).trim())) {
    return "zip must be a 5-digit string";
  }
  for (const k of ["lat", "lon"]) {
    if (row[k] !== undefined && row[k] !== null && !Number.isFinite(row[k])) {
      return `${k} must be a number or null`;
    }
  }
  return null;
}

function dupKey(name, city, state) {
  return [
    String(name).trim().toLowerCase(),
    String(city).trim().toLowerCase(),
    String(state).trim().toUpperCase(),
  ].join("|");
}

async function censusLookup(oneline) {
  const url =
    `${GEOCODER_URL}?address=${encodeURIComponent(oneline)}` +
    `&benchmark=Public_AR_Current&format=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const match =
      data &&
      data.result &&
      Array.isArray(data.result.addressMatches) &&
      data.result.addressMatches[0];
    if (!match || !match.coordinates) return null;
    return { lat: match.coordinates.y, lon: match.coordinates.x };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Street-address lookup when available (the Census geocoder needs a street
// address to match reliably), falling back to city + state.
async function geocodePub({ address, city, state, zip }) {
  if (address && address.trim()) {
    // the address field may already contain city/state/zip; the geocoder
    // tolerates repetition, so always append them for completeness
    const oneline = `${address.trim()}, ${city}, ${state}${zip ? " " + zip : ""}`;
    const hit = await censusLookup(oneline);
    if (hit) return hit;
  }
  return censusLookup(`${city}, ${state}`);
}

const GEOCODE_WARNING = "geocoding failed; saved with lat/lon null";

app.use("/api/publications", express.json({ limit: "10mb" }));

// The list GET is public: the matcher frontend reads it, and the same data is
// already served statically as publications.json. Everything else is gated.
app.get("/api/publications", (req, res) => {
  res.json(publications);
});

// Gate the manager page itself so the browser prompts for credentials on
// navigation and reuses them for the page's API calls.
app.get("/publications.html", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "publications.html"));
});

app.get("/api/publications/export", requireAuth, (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="publications-${date}.json"`
  );
  res.send(JSON.stringify(publications, null, 2));
});

app.post("/api/publications", requireAuth, async (req, res) => {
  const body = req.body || {};
  for (const k of ["name", "city", "state"]) {
    const err = checkCoreField(body[k], k);
    if (err) return res.status(400).json({ error: err });
  }
  const stateErr = checkState(body.state);
  if (stateErr) return res.status(400).json({ error: stateErr });
  const optErr = checkOptionalFields(body);
  if (optErr) return res.status(400).json({ error: optErr });

  const name = body.name.trim();
  const city = body.city.trim();
  const state = body.state.trim().toUpperCase();
  const address = String(body.address || "").trim();
  const zip = String(body.zip || "").trim();

  const key = dupKey(name, city, state);
  if (publications.some((p) => dupKey(p.name, p.city, p.state) === key)) {
    return res
      .status(400)
      .json({ error: "duplicate publication (same name, city, and state)" });
  }

  let lat = Number.isFinite(body.lat) ? body.lat : null;
  let lon = Number.isFinite(body.lon) ? body.lon : null;
  let warning;
  if (lat == null || lon == null) {
    const geo = await geocodePub({ address, city, state, zip });
    if (geo) {
      lat = geo.lat;
      lon = geo.lon;
    } else {
      lat = null;
      lon = null;
      warning = GEOCODE_WARNING;
    }
  }

  const taken = new Set(publications.map((p) => p.id));
  const pub = {
    id: makeId(name, city, state, taken),
    name,
    city,
    state,
    address,
    zip,
    website: String(body.website || "").trim(),
    lat,
    lon,
  };
  publications.push(pub);
  persistPublications();
  res.status(201).json(warning ? { ...pub, warning } : pub);
});

app.put("/api/publications/:id", requireAuth, async (req, res) => {
  const pub = publications.find((p) => p.id === req.params.id);
  if (!pub) return res.status(404).json({ error: "publication not found" });

  const body = req.body || {};
  for (const k of ["name", "city", "state"]) {
    if (body[k] !== undefined) {
      const err = checkCoreField(body[k], k);
      if (err) return res.status(400).json({ error: err });
    }
  }
  if (body.state !== undefined) {
    const err = checkState(body.state);
    if (err) return res.status(400).json({ error: err });
  }
  const optErr = checkOptionalFields(body);
  if (optErr) return res.status(400).json({ error: optErr });

  const name = body.name !== undefined ? body.name.trim() : pub.name;
  const city = body.city !== undefined ? body.city.trim() : pub.city;
  const state =
    body.state !== undefined ? body.state.trim().toUpperCase() : pub.state;
  const address =
    body.address !== undefined ? String(body.address).trim() : pub.address || "";
  const zip = body.zip !== undefined ? String(body.zip).trim() : pub.zip || "";

  const key = dupKey(name, city, state);
  if (
    publications.some((p) => p !== pub && dupKey(p.name, p.city, p.state) === key)
  ) {
    return res
      .status(400)
      .json({ error: "duplicate publication (same name, city, and state)" });
  }

  let lat = body.lat !== undefined ? body.lat : pub.lat;
  let lon = body.lon !== undefined ? body.lon : pub.lon;
  let warning;
  // Re-geocode when the location changed without explicit coordinates, or
  // when coordinates are still missing from an earlier failed geocode.
  const locationChanged =
    (body.city !== undefined ||
      body.state !== undefined ||
      body.address !== undefined) &&
    body.lat === undefined &&
    body.lon === undefined;
  if (locationChanged || lat == null || lon == null) {
    const geo = await geocodePub({ address, city, state, zip });
    if (geo) {
      lat = geo.lat;
      lon = geo.lon;
    } else {
      lat = null;
      lon = null;
      warning = GEOCODE_WARNING;
    }
  }

  pub.name = name;
  pub.city = city;
  pub.state = state;
  pub.address = address;
  pub.zip = zip;
  if (body.website !== undefined) pub.website = String(body.website).trim();
  pub.lat = lat;
  pub.lon = lon;
  persistPublications();
  res.json(warning ? { ...pub, warning } : pub);
});

app.delete("/api/publications/:id", requireAuth, (req, res) => {
  const idx = publications.findIndex((p) => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "publication not found" });
  const [removed] = publications.splice(idx, 1);
  persistPublications();
  res.json({ ok: true, deleted: removed.id });
});

app.post("/api/publications/import", requireAuth, (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows)) {
    return res
      .status(400)
      .json({ error: "body must be a JSON array of publications" });
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return res.status(400).json({ error: `row ${i}: must be an object` });
    }
    for (const k of ["name", "city", "state"]) {
      const err = checkCoreField(row[k], k);
      if (err) return res.status(400).json({ error: `row ${i}: ${err}` });
    }
    const stateErr = checkState(row.state);
    if (stateErr) return res.status(400).json({ error: `row ${i}: ${stateErr}` });
    const optErr = checkOptionalFields(row);
    if (optErr) return res.status(400).json({ error: `row ${i}: ${optErr}` });
  }

  if (fs.existsSync(LIVE_PATH)) fs.copyFileSync(LIVE_PATH, BACKUP_PATH); // one-deep backup
  publications = withIds(
    rows.map((r) => ({
      id: r.id,
      name: r.name.trim(),
      city: r.city.trim(),
      state: r.state.trim().toUpperCase(),
      address: String(r.address || "").trim(),
      zip: String(r.zip || "").trim(),
      website: String(r.website || "").trim(),
      lat: Number.isFinite(r.lat) ? r.lat : null,
      lon: Number.isFinite(r.lon) ? r.lon : null,
    }))
  );
  persistPublications();
  res.json({ ok: true, count: publications.length });
});

// ---------------------------------------------------------------------------
// Apollo.io proxy
// ---------------------------------------------------------------------------

// note: /mixed_people/search is restricted; api_search is the public API path
const APOLLO_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/api_search";
const APOLLO_MATCH_URL = "https://api.apollo.io/api/v1/people/match";
const APOLLO_DEFAULT_TITLES = [
  "chief marketing officer",
  "vp marketing",
  "director of marketing",
  "director of franchise development",
];
const APOLLO_MIN_GAP_MS = 1500;
const APOLLO_RETRY_DELAY_MS = 30_000;

// search key -> { expires, payload }; enrich responses are never cached
const apolloCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ApolloRateLimitError extends Error {}

// Apollo 429s aggressively: serialize every outbound call through one queue
// with a minimum gap between requests.
let apolloChain = Promise.resolve();
let apolloLastRequestAt = 0;

function apolloEnqueue(task) {
  const run = apolloChain.then(task);
  apolloChain = run.catch(() => {}); // keep the chain alive after failures
  return run;
}

async function apolloHttp(url, body, apiKey) {
  const wait = apolloLastRequestAt + APOLLO_MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  apolloLastRequestAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function apolloFetch(url, body, apiKey) {
  return apolloEnqueue(async () => {
    let res = await apolloHttp(url, body, apiKey);
    if (res.status === 429) {
      await sleep(APOLLO_RETRY_DELAY_MS); // wait out the rate limit, retry once
      res = await apolloHttp(url, body, apiKey);
      if (res.status === 429) throw new ApolloRateLimitError();
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(
        `[apollo] HTTP ${res.status} from ${url}: ${detail.slice(0, 300)}`
      );
      const err = new Error(`Apollo HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
}

function logApollo(endpoint, target, cached, status) {
  console.log(
    `[apollo] endpoint=${endpoint} target="${target}" cached=${cached} status=${status}`
  );
}

app.use("/api/apollo", express.json(), requireAuth, (req, res, next) => {
  if (!process.env.APOLLO_API_KEY) return res.json({ available: false });
  next();
});

app.post("/api/apollo/people-search", async (req, res) => {
  const body = req.body || {};
  const company = String(body.company || "").trim();
  const domain = String(body.domain || "").trim();
  if (!company && !domain) {
    return res.status(400).json({ error: "company or domain is required" });
  }
  const titles =
    Array.isArray(body.titles) && body.titles.length
      ? body.titles.map((t) => String(t))
      : APOLLO_DEFAULT_TITLES;

  const target = domain || company;
  const cacheKey =
    target.toLowerCase() +
    "|" +
    titles.map((t) => t.toLowerCase()).sort().join(",");
  const cached = apolloCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    logApollo("people-search", target, true, "ok");
    return res.json(cached.payload);
  }

  const apolloBody = { person_titles: titles, page: 1, per_page: 10 };
  if (domain) {
    apolloBody.q_organization_domains_list = [
      domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
    ];
  } else {
    // api_search has no organization-name filter; keyword search is the
    // closest match and the name filter is applied client-side below
    apolloBody.q_keywords = company;
  }

  try {
    const data = await apolloFetch(
      APOLLO_SEARCH_URL,
      apolloBody,
      process.env.APOLLO_API_KEY
    );
    // never pass through raw emails or phone numbers from search results
    let rawPeople = Array.isArray(data.people) ? data.people : [];
    if (!domain && company) {
      // keyword search is fuzzy — keep only people at the searched company
      const needle = company.toLowerCase();
      const filtered = rawPeople.filter((p) => {
        const org = (p.organization && p.organization.name) || "";
        return org.toLowerCase().includes(needle);
      });
      if (filtered.length) rawPeople = filtered;
    }
    const people = rawPeople.map((p) => ({
      id: p.id,
      name: p.name,
      title: p.title,
      company: (p.organization && p.organization.name) || company || domain,
      city: p.city,
      state: p.state,
      linkedin_url: p.linkedin_url,
      email_status: p.email_status,
    }));
    const payload = { available: true, count: people.length, people };
    apolloCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, payload });
    logApollo("people-search", target, false, "ok");
    res.json(payload);
  } catch (err) {
    if (err instanceof ApolloRateLimitError) {
      logApollo("people-search", target, false, "rate_limited");
      return res.json({ available: false, error: "rate_limited" });
    }
    logApollo("people-search", target, false, "error " + (err.status || ""));
    res.json({ available: false, error: "apollo_failed", status: err.status });
  }
});

// Consumes Apollo credits — only ever called from an explicit user action,
// never automatically.
app.post("/api/apollo/enrich", async (req, res) => {
  const id = String((req.body || {}).id || "").trim();
  if (!id) return res.status(400).json({ error: "id is required" });

  try {
    const data = await apolloFetch(
      APOLLO_MATCH_URL,
      { id, reveal_personal_emails: false },
      process.env.APOLLO_API_KEY
    );
    const p = data.person || {};
    logApollo("enrich", id, false, "ok");
    res.json({
      available: true,
      name: p.name,
      title: p.title,
      email: p.email,
      email_status: p.email_status,
      linkedin_url: p.linkedin_url,
    });
  } catch (err) {
    if (err instanceof ApolloRateLimitError) {
      logApollo("enrich", id, false, "rate_limited");
      return res.json({ available: false, error: "rate_limited" });
    }
    logApollo("enrich", id, false, "error");
    res.json({ available: false, error: "apollo_failed" });
  }
});

// The live data files must never be publicly served (relevant when DATA_DIR
// is the repo root, which express.static also serves).
app.use((req, res, next) => {
  if (req.path.startsWith("/publications-live")) return res.status(404).end();
  next();
});

app.use(express.static(path.join(__dirname)));

loadPublications();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`franchise-matcher-v2 listening on port ${PORT}`);
  console.log(
    process.env.GOOGLE_PLACES_API_KEY
      ? `Google Places proxy: enabled (daily request budget: ${DAILY_LIMIT})`
      : "Google Places proxy: disabled (GOOGLE_PLACES_API_KEY not set) — OSM-only mode"
  );
  console.log(`Publications: ${publications.length} loaded (${LIVE_PATH})`);
  console.log(
    process.env.APOLLO_API_KEY
      ? "Apollo proxy: enabled"
      : "Apollo proxy: disabled (APOLLO_API_KEY not set)"
  );
  if (!AUTH_USER || !AUTH_PASS) {
    console.warn(
      "WARNING: publications API is unprotected — set BASIC_AUTH_USER and BASIC_AUTH_PASS"
    );
  }
});
