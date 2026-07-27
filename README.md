# KidStreet

Child-friendliness scores for all 704 London wards, built entirely from open data
with a published methodology. Live at [kidstreet.co.uk](https://kidstreet.co.uk).

Council PR and estate agent copy tell you what an area wants to look like.
KidStreet scores what the open data says it is actually like for a family —
independently, reproducibly, with every limitation stated rather than smoothed over.

## The seven dimensions

Composite = weighted blend, renormalised over the dimensions a ward actually has
(missing data is `null`, never a silent zero). Weights live in `src/index.js`
(`WEIGHTS`) and must stay in sync with the methodology strip in `public/index.html`.

| Dimension | Weight | Source | Method |
|---|---|---|---|
| Safety | 30 | data.police.uk street-level crime, latest month | crimes/km², inverted, min-max clipped at p95 |
| Education | 20 | Ofsted state-funded schools (Aug 2025), geocoded via postcodes.io | % Good/Outstanding, rescaled |
| Transport | 15 | TfL StopPoint + OSM (rail, bus) | access-based: in-ward stations + 0.5× adjacent-ward stations, ×3 vs bus stops, per km², +5 step-free bonus |
| Green space | 12 | OSM Overpass: parks + nature reserves (gardens excluded as mostly private; playgrounds excluded — see below) | raw feature count, min-max clipped at p95 |
| Family fit | 10 | ONS Census 2021 via Nomis (household composition + age bands) | % households with dependent children + % family-forming age |
| Play | 8 | OS Open Greenspace 'Play Space' polygons + ONS mid-2024 ward child population via Nomis | m² of equipped play per child 0–15, scored against the London Plan Policy S4 figure of 10 m²/child |
| Planning | 5 | Planning London Datahub, approved child-relevant applications since 2023 | raw count |

### Play: benchmark, not compliance

Policy S4's 10 m²/child is a requirement on **new residential development**, derived
from child yield. KidStreet applies it as a **benchmark** against the existing ward
child population because it is the only London-specific play figure with policy
standing. No existing ward is "in breach" of S4; wards are described as providing
more or less than the benchmark, never as non-compliant.

### Declared overlap: playgrounds count twice, on purpose

Playground sites feed both green space and play, measuring different things:
green space counts them as outdoor amenities a child can use (presence); play
scores their area per child against the S4 benchmark (adequacy). The two
dimension scores correlate at only r = 0.286 across 689 wards, so they are not
redundant. The net effect — equipped play weighing somewhat more than generic
parks in the composite — is intentional in a child-friendliness index.

### Declared limitations

- OS Open Greenspace under-counts equipped play (school-grounds and some estate
  playgrounds are absent). Figures are "publicly mapped, publicly accessible play".
- Sites and features are assigned to wards by centroid point-in-polygon; a
  boundary-straddling site goes wholly to one ward.
- The 15 City of London wards have no published ward-level child population, so
  play (and the education/family gaps there) are `null`, openly, not estimated.
- Safety zeros in central/town-centre wards are real data (highest crime density
  in London), not missing data — the UI says so wherever safety ≤ 2.

## Pipeline

`pipeline/01…10_*.js`, plain Node, no build step, cached fetches in `pipeline/cache/`.
Order: `01` wards (ONS WD24 boundaries, joined by WD24CD code, never by name) →
`02` crime → `03` green → `04` transport → `05` education → `06` planning →
`07` family fit → **`10` play** → `08` merge (writes `out/wards_final.json`) →
copy to `public/data/wards.json` → `09` transport access re-score (edits the
public file in place; must run **after** the copy or transport reverts to the old
containment scoring).

Step 10 needs two files in `pipeline/cache/` (both open, both documented in the
header of `pipeline/10_play.js`): the OS Open Greenspace GeoPackage and an ONS
mid-2024 children-0-15 CSV from Nomis.

## Serving

Cloudflare Worker (`src/index.js`) serving `public/` as static assets plus
`/api/scores` and `/api/wards`. Deploys automatically on push to `main`.

## Licences

data.police.uk, ONS, Ofsted, Planning London Datahub under OGL v3.
OS Open Greenspace © Crown copyright, OGL v3.
OpenStreetMap © OpenStreetMap contributors, ODbL.
