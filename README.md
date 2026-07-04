# KidStreet

Honest, open-data scores for how child-friendly Greenwich actually is. Council PR and estate agent copy obscure what areas are really like for families. KidStreet strips that away: three open data sources, a published methodology, and a composite score you can disagree with because the inputs are public.

**Live demo:** https://kidstreet.YOURSUBDOMAIN.workers.dev (replace with actual URL)
**Scope (v1):** Royal Borough of Greenwich, all 23 wards (May 2024 boundaries).

---

## How it works

```
ONS boundaries (fetched live by the browser)
        │
        ▼
public/index.html  ──── fetch ────►  /api/scores (Cloudflare Worker, src/index.js)
   Leaflet map                            │
   AG Grid table                          ▼
   3 question lenses              scores array (currently placeholder,
                                  replaced by pipeline output)
```

- **Backend:** Cloudflare Worker (`src/index.js`). One route, `/api/scores`, returns a JSON array of ward scores. Static assets served via the `[assets]` binding. This is a **Workers** deployment, not Pages. Do not add a `functions/` directory.
- **Frontend:** `public/index.html`. Leaflet map, AG Grid table, detail panel with score breakdown and LLM justification.
- **Boundaries:** fetched at runtime from the ONS Open Geography Portal (Wards May 2024, BSC super-generalised, WGS84 GeoJSON). The page tries `public/wards.geojson` first and falls back to the live ONS query, so a local snapshot can be committed as demo insurance.
- **Join:** boundaries and scores are matched by ward name, normalised (case, ampersands, commas). Unmatched wards are logged to the browser console.

## The three lenses

The UI answers three questions with the same data:

1. **Where do I move?** Published composite, best first. Safety 40, green 30, narrative 30.
2. **Where's a good day out?** Re-weighted on screen: green 60, safety 40. Narrative excluded. The re-weighting is disclosed in the UI because a transparency product cannot have a secret second formula.
3. **What should the council fix?** Same composite, worst first. Wards under 60 are flagged.

## Voice Agent (ElevenLabs)

KidStreet includes an interactive voice agent powered by ElevenLabs ConvAI. It allows users to ask questions about child-friendliness in Greenwich and receive personalized ward recommendations.

The agent has access to the following client-side tools:

- **`recommend_wards`**: Ranks wards based on user-specified priorities for safety, green space, and council narrative. It calculates a custom match score and highlights the top match on the map.
- **`get_ward_scores`**: Provides the agent with the current score data for all Greenwich wards, including safety, green access, narrative, composite scores, and justifications.
- **`show_ward`**: Allows the agent to programmatically select and highlight a specific ward on the map and detail panel.

The agent is integrated via the ElevenLabs conversational AI widget and can be triggered using the "Ask KidStreet" button in the UI.

## Scoring methodology

| Metric | Weight | Source | Status |
|---|---|---|---|
| Safety | 40% | data.police.uk street-level crime, density inverted to 0-100 | API verified live, no key |
| Green access | 30% | London Datastore green space data | Source selected, pipeline in progress |
| Council narrative | 30% | LLM score (0-100) of real council/Ofsted document excerpts via OpenRouter | Config proven |

Composite = 0.4 × safety + 0.3 × green + 0.3 × narrative, rounded, 0-100.

**Current data status: the scores in `src/index.js` are placeholders.** Safety and green figures are interim estimates, narrative is a stand-in, and every justification string says so. They exist so the UI renders while the real pipeline is built. Nothing on the map should be treated as a real claim until the pipeline output replaces them.

## Data contract (pipeline → frontend)

The pipeline's only deliverable is a JSON array of exactly this shape, one object per ward:

```json
{
  "ward": "Blackheath Westcombe",
  "safety": 84,
  "green": 95,
  "narrative": 90,
  "composite": 89,
  "justification": "One plain-English sentence, max 20 words."
}
```

Rules:

- **All 23 Greenwich wards**, May 2024 names, spelled exactly as in `src/index.js` (the join is by name; "Mottingham, Coldharbour and New Eltham" keeps its comma).
- All scores are **integers 0-100**. Higher is always better, so crime density must be inverted before it becomes `safety`.
- **`composite` is computed in the pipeline** (40/30/30), not in the frontend. One place owns the maths.
- `justification` comes from the OpenRouter narrative call. One sentence, max 20 words, no markdown.
- **No geometry.** Boundaries are handled entirely by the frontend from ONS.

## Integration procedure

1. Pipeline produces the full 23-ward array.
2. Open `src/index.js` in the GitHub web editor.
3. Replace everything between `const scores = [` and the closing `];` with the new array.
4. Commit to `main`. Cloudflare auto-deploys in under a minute.
5. Hard refresh the live URL (Cmd+Shift+R). Check the browser console for an "Unmatched wards" warning, which means a name mismatch.

## Proven API configurations

**Police (safety metric):**
```
GET https://data.police.uk/api/crimes-street/all-crime?date=YYYY-MM&lat=LAT&lng=LNG
```
No key. Returns individual crime records; count them per ward and invert to a score. Also accepts `poly=lat,lng:lat,lng:...` for ward-boundary queries (keep the URL under 4094 characters or use POST).

**OpenRouter (narrative metric):**
- Model: `anthropic/claude-haiku-4.5`, `max_tokens: 200`
- System prompt: score 0-100 with a single-sentence justification, max 20 words
- `response_format` json_schema enforcing `score` (integer) and `justification` (string), both required, `additionalProperties: false`
- Reliably returns clean JSON, no markdown fences

**ONS ward boundaries (frontend only, already wired in):**
```
https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Wards_May_2024_Boundaries_UK_BSC/FeatureServer/0/query
  ?where=1=1
  &geometry=-0.04,51.40,0.16,51.52
  &geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects
  &outFields=WD24CD,WD24NM&outSR=4326&f=geojson
```

## Known constraints

- Cached fetches (including AI-assistant web fetch tools) return stale results for this project. Verify live API state with curl or a browser, never a cached fetch.
- The police API returns a 503 if a polygon contains more than 10,000 crimes, and a 400 for GET URLs over 4094 characters.
- Planning London Datahub integration is a stretch goal only. POST to `planningdata.london.gov.uk/api-guest` with the request-allow header, Elasticsearch 7.9 DSL, filter `lpa_name.raw: "Greenwich"`. Do not let it eat build time.

## Roadmap

- v1 (today): Greenwich, 3 metrics, 23 wards, live data
- Next: additional metric dimensions (education, affordability, mobility and others) as sourced, verifiable data
- Then: all 32 London boroughs. The architecture already supports it: the scores array grows, the boundary query widens, nothing else changes.

## Visual identity

- **Logo:** `public/assets/logo.png` (full lockup, white background) is used in the app header. `public/favicon.ico` and `public/assets/favicon_512.png` provide the browser tab icon and PWA/touch icon respectively, both linked from `<head>` in `public/index.html`.
- **Colour palette:**
  | Role | Colour | Hex |
  |---|---|---|
  | Primary / structure | Deep navy | `#1B3A5C` |
  | Accent / calls to action | Warm coral | `#E8634F` |
  | Secondary accent | Soft teal | `#4AABB3` |

  These are defined as CSS custom properties (`--ks-navy`, `--ks-coral`, `--ks-teal`) at the top of `public/index.html` and used for the header logo lockup, active lens button, primary buttons, ward outline strokes, and the methodology callout. The green-to-red map/score gradient (`scoreColour()`) is a semantic data scale, not a brand colour, and is intentionally left separate from the palette above.
- Any new UI should draw from this palette rather than introducing new colours, to keep the product visually consistent with the KidStreet brand.

## Licence and attribution

Open source. Ward boundaries: Office for National Statistics, Wards (May 2024) BSC. Contains OS data © Crown copyright and database right 2024. Crime data: data.police.uk (Open Government Licence).
