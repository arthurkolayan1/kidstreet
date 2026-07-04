# KidStreet — Ward Data Enrichment Plan

**For:** the data-pulling agent.
**Goal:** replace the hardcoded placeholder scores in `data/wards.json` with real, sourced, ward-level data across 6 family-relevant dimensions, structured so it serves **both the website (numeric scores)** and **the voice agent (named facts it can speak aloud)**.

---

## 0. Assumptions (confirm before starting)

- **Scope:** All 33 London Boroughs (all wards). Ward names must match ONS official lists exactly.
- **Data must be real and verifiable.** Every number traces to a source query recorded in `_provenance`. No invented figures. If a source can't be reached for a ward, set the field to `null` and note it — do **not** guess.
- **Deliverable:** an enriched `data/wards.json` (schema below) + a summary of any wards/fields that came back empty.
- **Caching caveat (from README):** AI web-fetch tools return stale results for this project. Verify every live API with `curl` or a browser, never a cached fetch.

---

## 1. Target schema (per ward)

Keep the existing numeric `scores` block untouched (the map + composite depend on it). Add a parallel `dimensions` block. Each dimension has a `score` (0-100, higher = better, for the site) plus **named raw facts** (for the agent).

```jsonc
{
  "ward_name": "...",
  "borough": "...",
  "ward_code": "...",
  "centroid": { "lat": ..., "lng": ... },
  "scores": { /* existing 10 numeric dims — leave as-is for now */ },
  "dimensions": {
    "planning": { "score": ..., "summary": "...", "upcoming_facilities": [...] },
    "green_space": { "score": ..., "summary": "...", "green_cover_pct": ..., "playground_count": ..., "notable_parks": [...] },
    "transport": { "score": ..., "summary": "...", "nearest_stations": [...], "station_count": ..., "bus_stop_count": ..., "cycle_hire": ... },
    "safety": { "score": ..., "summary": "...", "crimes_last_month": ..., "period": "...", "top_categories": [...] },
    "education": { "score": ..., "summary": "...", "pct_good_or_outstanding": ..., "schools": [...] },
    "family_fit": { "score": ..., "summary": "...", "pct_households_with_dependent_children": ..., "median_age": ..., "family_household_pct": ... }
  },
  "_provenance": { ... }
}
```

**Scoring rule:** every dimension `score` is an integer 0-100, higher = better. Normalise each raw metric across all London wards (min-max or sensible fixed bands) so scores are comparable. Document the normalisation you used in a top-level `"methodology"` object.

---

## 2. Step 0 — resolve each ward to a code + centroid

Before pulling dimension data you need, per ward: `WD24CD` code and a centroid `{lat,lng}` (for radius queries) and the boundary polygon (for police + OSM).

- Use the ONS Open Geography Portal for the full London ward list (May 2024).
- Compute centroid from each feature's geometry. Save polygons — you'll reuse them.

---

## 3. Dimension pull instructions

### 3.1 Safety  (source: data.police.uk)
- Query, per ward, using the boundary polygon: `GET https://data.police.uk/api/crimes-street/all-crime?date=YYYY-MM&poly=lat,lng:lat,lng:...`
- Score: crime **density** per 1000 residents, inverted and min-max normalised across all London wards → 0-100.

### 3.2 Green areas  (source: OSM Overpass + London Datastore)
- Overpass, count child-relevant green features inside each ward polygon.
- `green_cover_pct`: London Datastore "Access to Public Open Space and Nature" / green cover per ward.
- Score: blend green_cover_pct (60%) + playground density (40%), min-max normalised.

### 3.3 Transport access  (source: TfL Unified API)
- Per ward centroid: `GET https://api.tfl.gov.uk/StopPoint?lat=LAT&lon=LNG&stopTypes=NaptanMetroStation,NaptanRailStation,NaptanPublicBusCoachTram&radius=800&app_key=KEY`
- **Step-free (buggy-critical):** check accessibility via StopPoint `additionalProperties`.
- Score: weight step-free station proximity heavily, then station + bus density. Normalise across all London wards.

### 3.4 School ratings  (source: Get Information About Schools + Ofsted)
- Schools list: GIAS establishment CSV, filter by London boroughs.
- Ofsted rating per school: Ofsted "state-funded schools inspections and outcomes" dataset.
- Score: `pct_good_or_outstanding` primary, presence of any Outstanding school as a bonus. Normalise.

### 3.5 Planning (next 5 years)  (source: Planning London Datahub)
- Query Planning London Datahub for child-relevant use classes (schools, nurseries, playgrounds, health, community).
- Score: count + significance of approved child-relevant facilities, min-max normalised.

### 3.6 Qualitative (source: ONS Census 2021)
- ONS/Nomis ward-level Census 2021 tables (TS003/TS007).
- `summary`: one agent-speakable sentence.
- Score: proximity to a "family sweet spot" (high % households with children + working-age median age), normalised.

---

## 4. Wire-up (Compatibility Focus)

To remain compatible with existing infrastructure:
1. **`data/wards.json`:** Update to include the full London dataset.
2. **`src/index.js`:** Modify the `/api/scores` endpoint to dynamically filter the `wards.json` data based on the requested borough (or return all if no filter). This keeps the existing frontend logic (which expects the flat array) working perfectly while allowing future expansion.
3. **Agent:** The agent's `get_ward_scores` tool will now return the richer data, allowing it to speak about specific schools/parks/stations.

---

## 5. Definition of done

- [ ] All London wards have `ward_code` + `centroid`.
- [ ] Each of the 6 dimensions populated per ward, or explicitly `null` with a provenance note.
- [ ] Every `score` is an integer 0-100, higher = better, normalisation documented in `methodology`.
- [ ] `summary` strings present for every dimension (one sentence, <=20 words, no markdown — agent-speakable).
- [ ] Named lists populated where the source has them (schools, parks, stations, facilities).
- [ ] `_provenance` records the exact source + date for each dimension.
- [ ] A short report of any empty fields and why.
