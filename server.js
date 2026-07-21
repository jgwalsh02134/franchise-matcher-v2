"use strict";

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

app.use(express.static(path.join(__dirname)));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`franchise-matcher-v2 listening on port ${PORT}`);
  console.log(
    process.env.GOOGLE_PLACES_API_KEY
      ? `Google Places proxy: enabled (daily request budget: ${DAILY_LIMIT})`
      : "Google Places proxy: disabled (GOOGLE_PLACES_API_KEY not set) — OSM-only mode"
  );
});
