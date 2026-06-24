# KidStreet

Open-source geospatial scoring of London streets/areas for child safety, accessibility and "fun" — starting with Greenwich.

Strips out council PR framing by scoring against open data (TfL STATS19 road safety, green space proximity, council-document analysis via LLM) with a transparent, published methodology.

## Stack

- **Cloudflare Pages + Functions** — hosting and API (`/api/scores`)
- **AG Grid** — sortable data table view alongside the map
- **OpenRouter** — structured scoring of council/Ofsted documents
- **Leaflet** — heatmap/marker visualisation

## Status

v1 scope: Greenwich only, 3 metrics (safety, green access, council narrative), sample locations for LLM-derived scores. See `/public/index.html` for the current placeholder data — swap for live `/api/scores` once the data pipeline is built.

## Local dev

```
npx wrangler pages dev public
```

## Methodology

TBD — see project for current weighting and data sources once finalised. This is a model with a stated point of view, not a neutral ground truth; sources and weights are published precisely so people can disagree with the inputs.
