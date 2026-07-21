"use strict";

const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

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

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK =
  "places.id,places.displayName,places.location,places.addressComponents,nextPageToken";
const MAX_PAGES_PER_STATE = 3; // Google caps text search at 60 results (3 x 20)
const STATE_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // each uncached national search is ~51-150 billable calls

// query (lowercased, trimmed) -> { expires, payload }
const cache = new Map();

function addressPart(components, types) {
  if (!Array.isArray(components)) return undefined;
  for (const type of types) {
    const match = components.find((c) => Array.isArray(c.types) && c.types.includes(type));
    if (match) return match;
  }
  return undefined;
}

async function placesRequest(apiKey, body) {
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

async function searchState(apiKey, query, stateName) {
  const places = [];
  let pageToken;
  for (let page = 0; page < MAX_PAGES_PER_STATE; page++) {
    const body = {
      textQuery: `${query} in ${stateName}`,
      regionCode: "US",
      pageSize: 20,
    };
    if (pageToken) body.pageToken = pageToken;
    const data = await placesRequest(apiKey, body);
    if (Array.isArray(data.places)) places.push(...data.places);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return places;
}

async function nationwideSearch(apiKey, query) {
  const byId = new Map();
  const needle = query.toLowerCase();
  const states = [...US_STATES];

  async function worker() {
    while (states.length > 0) {
      const stateName = states.shift();
      let places;
      try {
        places = await searchState(apiKey, query, stateName);
      } catch {
        continue; // failed state is skipped, not fatal
      }
      for (const place of places) {
        if (!place || !place.id || byId.has(place.id)) continue;
        const name = place.displayName && place.displayName.text;
        if (!name || !name.toLowerCase().includes(needle)) continue; // lookalike filter
        if (!place.location) continue;
        const cityComp = addressPart(place.addressComponents, [
          "locality",
          "postal_town",
          "sublocality",
        ]);
        const stateComp = addressPart(place.addressComponents, [
          "administrative_area_level_1",
        ]);
        byId.set(place.id, {
          lat: place.location.latitude,
          lon: place.location.longitude,
          city: cityComp ? cityComp.longText || cityComp.shortText : undefined,
          state: stateComp ? stateComp.shortText : undefined,
          name,
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: STATE_CONCURRENCY }, () => worker())
  );
  return [...byId.values()];
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
    return res.json(cached.payload);
  }

  try {
    const locations = await nationwideSearch(apiKey, query);
    const payload = {
      available: true,
      source: "google_places",
      count: locations.length,
      locations,
    };
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, payload });
    res.json(payload);
  } catch {
    // degrade silently so the frontend falls back to OSM-only
    res.json({ available: false, locations: [], error: "places_failed" });
  }
});

app.use(express.static(path.join(__dirname)));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`franchise-matcher-v2 listening on port ${PORT}`);
  console.log(
    process.env.GOOGLE_PLACES_API_KEY
      ? "Google Places proxy: enabled"
      : "Google Places proxy: disabled (GOOGLE_PLACES_API_KEY not set) — OSM-only mode"
  );
});
