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
| Safety | 30 | data.police.uk street-level crime, latest month + Census 2021 ward population | crimes per 1,000 residents, percentile-ranked across London wards, inverted (score = share of wards with more crime per resident); wards with no published population (City of London) keep the legacy area-density score, declared per ward |
| Education | 20 | Ofsted state-funded schools (Aug 2025), geocoded via postcodes.io | average Ofsted grade of rated schools, linear on the 4-point scale (Outstanding 100, Good 67, RI 33, Inadequate 0); unrated schools excluded; no rated school = null |
| Transport | 15 | TfL StopPoint + OSM (rail, bus) | access-based: in-ward stations + 0.5× adjacent-ward stations + bus stops at 1/20 station weight, percentile-ranked (no area division — it penalised wards that are large because of parkland), +5 step-free bonus |
| Green space | 12 | OSM Overpass: parks + nature reserves + playgrounds (gardens excluded as mostly private plots; playgrounds also feed the play dimension, see the declared-overlap note below) | raw feature count (playground_count + park_reserve_count), min-max clipped at p95 |
| Family fit | 10 | ONS Census 2021 via Nomis (household composition + age bands) | % households with dependent children, percentile-ranked; the 25–49 age share is displayed as context but not scored (summed on raw scales it swamped the children share and measured young-adult density, not families) |
| Play | 8 | OS Open Greenspace (Play Space + Playing Field + Public Park Or Garden) + ONS mid-2024 ward child population via Nomis | m² of play and informal recreation space per child 0–15, percentile-ranked; the London Plan Policy S4 figure of 10 m²/child remains the displayed benchmark and drives the play map lens, but no longer caps the score (81% of wards met it, so the capped score ranked almost nothing); equipped-only figure published as a lower bound |
| Planning | 5 | Planning London Datahub, approved child-relevant applications since 2023 | raw count |

Percentile scores read as "standing among all scored London wards": 0 = lowest in
London, 100 = highest, ties share a value. The July 2026 build scored several
dimensions with min-max or benchmark caps that saturated (education hit 100 on 92%
of wards, play on 81%), letting the composite be decided by a subset of dimensions;
`pipeline/12_score_fix.js` documents the diagnosis and applies the current scoring,
and ends with a saturation report that warns if any dimension goes flat again.

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
- Play counts whole-site areas of parks and playing fields as an upper-bound
  proxy for their playable fraction (no open dataset identifies playable space
  within a park); the equipped-only figure is published alongside as the lower
  bound. Formal/restricted facilities (bowling greens, tennis courts, golf) are
  excluded. Definition corrected and declared July 2026.
- Sites and features are assigned to wards by centroid point-in-polygon; a
  boundary-straddling site goes wholly to one ward.
- The 15 City of London wards have no published ward-level child population, so
  play (and the education/family gaps there) are `null`, openly, not estimated.
- Safety zeros in central/town-centre wards are real data (the most street crime
  per resident in London), not missing data — the UI says so wherever safety ≤ 2.
  Crimes involving visitors count against the resident population, so busy
  destination wards rank worse than quiet residential ones; that trade-off is
  declared rather than hidden.

## Pipeline

`pipeline/01…12_*.js`, plain Node, no build step, cached fetches in `pipeline/cache/`.
Order: `01` wards (ONS WD24 boundaries, joined by WD24CD code, never by name) →
`02` crime → `03` green → `04` transport → `05` education → `06` planning →
`07` family fit → **`10` play** → `08` merge (writes `out/wards_final.json`) →
copy to `public/data/wards.json` → `09` transport access re-score (edits the
public file in place; must run **after** the copy or transport reverts to the old
containment scoring) → `12` scoring fix (edits the public file in place; applies
the percentile/per-resident scoring described above and refreshes the family
display fields from `out/07_family_fit_by_ward.json`, so it must run last).
`11` re-scores safety in place after a crime refresh (`02` then `11`); after a
crime refresh, run `12` again so safety returns to per-resident percentiles.

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

