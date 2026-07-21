# Franchise Footprint Matcher — AdSell.ai internal tool

Search any franchise operating in the US, map its locations against the AdSell.ai
publication list, get a suggested 8-market flight, and generate a branded two-page
pilot brief — all client-side, no backend.

## Run locally

Static site — any web server works:

```bash
python3 -m http.server 8742
# open http://localhost:8742
```

(Opening index.html via file:// won't work — fetch() needs http for publications.json.)

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Matcher UI (search, KPIs, Leaflet map, flight card, market/state tables) |
| `app.js` | All logic: Overpass queries, clustering, matching, greedy flight, brief payload |
| `styles.css` | Matcher styles (Hanken Grotesk, AdSell.ai brand tokens) |
| `brief.html` | Self-contained pilot-brief page (reads sessionStorage, print-to-PDF) |
| `publications.json` | 260 verified local/community publications with lat/lon (internal — do not publish counts outward) |
| `wordmark-blue.svg` | Official AdSell.ai wordmark (blue #4A6CF7) — never recreate with live type |
| `d3.min.js`, `topojson.min.js`, `us-data.js` | US map rendering for the brief page |
| `hanken-1..4.ttf` | Hanken Grotesk 400/700/800/900 for the brief's print output |

## How it works

1. **Search** — `app.js` queries Overpass (OpenStreetMap) for the brand:
   wave 1 races `maps.mail.ru` + `overpass-api.de` in parallel; wave 2 falls back to
   `kumi.systems` / `private.coffee` sequentially. 60s timeout per endpoint.
2. **Cluster** — locations within 15 mi are merged into one market (union-find).
3. **Match** — publications within the selected radius (default 30 mi) of any
   location in a market.
4. **Flight** — greedy maximum-coverage pick of 8 markets (each adds the most new
   publications).
5. **Brief** — "Generate pilot brief" stores a JSON payload in sessionStorage and
   opens `brief.html`, which renders the two-page Local Presence Pilot brief
   (D3 US map, market-match table, timeline, terms) with a print-to-PDF button.

## Data caveats

- Location data is OpenStreetMap — counts can run below a brand's official locator.
  For a named prospect, verify against their locator before sending anything out.
- `publications.json` is the cleaned master list (verified July 2026; mergers and
  dead entries removed). Keep count internal.

## Brand rules (outward-facing output)

- Company is always "AdSell.ai", never "AdSell".
- "Local and community publications" / "local media" — never "newspapers".
- "Powered by Vision Data" — publishers have relied on it since 1973.
- Never state a total publication count outward (per-prospect match counts are fine).
- Measurement is roadmap: counted responses (QR/promo/tracked numbers), never
  "real-time ROI" or exact attribution. No guaranteed performance.
- Type: Hanken Grotesk only. Indigo #4A6CF7 (≤25%), Deep Navy #0B1437 headlines,
  Soft Lavender #F2F4FF, flat color, no gradients.
- Contact: adsell.ai · info@adsell.ai · (838) 240-4104.

## Deploying to Railway

1. In Railway, create a new project and connect this GitHub repo
   (`jgwalsh02134/franchise-matcher-v2`).
2. In the service's **Variables** tab, set `GOOGLE_PLACES_API_KEY` to your
   Google Places API (New) key. The key stays server-side — the browser only
   ever calls `/api/places`.
3. Railway detects the Node app and runs `npm start` (no build step).

Local development:

```bash
npm install
GOOGLE_PLACES_API_KEY=xxx npm start
# open http://localhost:3000
```

The app also works without the key — `/api/places` reports
`available:false` and the frontend degrades to OSM-only mode.
