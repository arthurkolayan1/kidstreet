# KidStreet

Child-friendliness scores for all 704 London wards, built entirely from open data
with a published methodology. Live at [kidstreet.co.uk](https://kidstreet.co.uk).

Council PR and estate agent copy tell you what an area wants to look like.
KidStreet scores what the open data says it is actually like for a family:
independently, reproducibly, with every limitation stated rather than smoothed over.

## The seven dimensions

Composite = weighted blend, renormalised over the dimensions a ward actually has
(missing data is `null`, never a silent zero). Weights live in `src/index.js`
(`WEIGHTS`) and must stay in sync with the methodology strip in `public/index.html`.

| Dimension | Weight | Source | Method |
|---|---|---|---|
| Safety | 30 | data.police.uk street-level crime, latest month + ONS mid-2024 ward population estimates (Census 2021 fallback per ward, declared in `population_basis`) | crimes per 1,000 residents, percentile-ranked across London wards, inverted (score = share of wards with more crime per resident); wards with no published population (City of London) keep the legacy area-density score, declared per ward |
| Education | 20 | Ofsted state-funded schools (Aug 2025), geocoded via postcodes.io | average Ofsted grade of rated schools, linear on the 4-point scale (Outstanding 100, Good 67, RI 33, Inadequate 0); unrated schools excluded; no rated school = null |
| Transport | 15 | TfL StopPoint + OSM (rail, bus) | access-based: in-ward stations + 0.5x adjacent-ward stations + bus stops at 1/20 station weight, percentile-ranked (no area division, which penalised wards that are large because of parkland), +5 step-free bonus |
| Green space | 12 | OSM Overpass: parks + nature reserves + playgrounds (gardens excluded as mostly private plots; playgrounds also feed the play dimension, see the declared-overlap note below) | raw feature count (playground_count + park_reserve_count), min-max normalised and clipped at the 95th percentile |
| Family fit | 10 | ONS Census 2021 via Nomis (household composition + age bands) | % households with dependent children, percentile-ranked; the 25 to 49 age share is displayed as context but not scored (summed on raw scales it swamped the children share and measured young-adult density, not families) |
| Play | 8 | OS Open Greenspace (Play Space + Playing Field + Public Park Or Garden), clipped to ONS WD24 ward boundaries, + ONS mid-2024 ward child population via Nomis | m² of play and informal recreation space per child 0 to 15, percentile-ranked; the London Plan Policy S4 figure of 10 m²/child remains the displayed benchmark and drives the play map lens, but no longer caps the score (84% of wards clear it once parks count, so the capped score ranked almost nothing); equipped-only figure published as a lower bound |
| Planning | 5 | Planning London Datahub, approved child-relevant applications since 2023 | raw count, min-max normalised and clipped at the 95th percentile |

Percentile scores read as "standing among all scored London wards": 0 = lowest in
London, 100 = highest, ties share a value. Four dimensions are scored this way
(safety, transport, family fit, play). Education is an absolute 0 to 100 average
grade; green space and planning are normalised counts.

The July 2026 build scored several dimensions with min-max or benchmark caps that
saturated (education hit 100 on 92% of wards, play on 84%), letting the composite be
decided by a subset of dimensions. `pipeline/12_score_fix.js` documents the diagnosis
and applies the current scoring, and ends with a saturation report that warns if any
dimension goes flat again.

### Play: benchmark, not compliance

Policy S4's 10 m²/child is a requirement on **new residential development**, derived
from child yield. KidStreet applies it as a **benchmark** against the existing ward
child population because it is the only London-specific play figure with policy
standing. No existing ward is "in breach" of S4; wards are described as providing
more or less than the benchmark, never as non-compliant.

Current build: 112 of 689 scored wards provide less than 10 m² per child on the
whole-site measure, and 266,782 children aged 0 to 15 live in them (15.7% of
London's 1,698,384). On equipped playgrounds alone, 682 of 689 fall below.

### Play geometry: clipped, not centroid

Site polygons are **clipped to ward boundaries**, so only the part of a site inside a
ward counts towards that ward, and a park spanning several wards is divided between
them. Areas are computed by shoelace in the data's native British National Grid
(EPSG:27700), so they are true square metres with no reprojection. Sites are joined
to ONS WD24 boundaries by `WD24CD` code, never by name. A site falling in more than
one ward is counted once per ward, which is why the London site-record total (6,878
play sites, 3,586 of them equipped) exceeds the number of distinct sites.

Until August 2026 each site was assigned whole to the ward holding its centre point.
That credited East Sheen with 9.8 km² of play space inside a 6.0 km² ward, because
Richmond Park's centre falls there, while giving neighbouring wards none of the same
park. Step 10 now writes `ward_land_area_m2` and `play_share_of_ward_pct` alongside
the areas, and **fails the build** if any ward holds more play space than it has
land, so that class of error cannot ship again silently.

Note that clipping applies to the play dimension. Planning applications are still
located to a ward by their coordinates, which is correct for a point feature.

### Declared overlap: playgrounds count twice, on purpose

Playground sites feed both green space and play, measuring different things:
green space counts them as outdoor amenities a child can use (presence); play
scores their area per child against the S4 benchmark (adequacy). The two
dimension scores correlate at only r = 0.286 across 689 wards, so they are not
redundant. The net effect, equipped play weighing somewhat more than generic
parks in the composite, is intentional in a child-friendliness index.

### Weight sensitivity

The weights are a judgement and are arguable, so the effect of changing them is
published rather than assumed. Scoring every ward with equal weights instead of the
published ones gives Spearman rho = 0.76 against the published ranking. Perturbing
any single weight by plus or minus 50% keeps rho at or above 0.85. The ranking is
driven by the underlying dimension scores, not by the weighting.

### Declared limitations

- OS Open Greenspace under-counts equipped play (school grounds and some estate
  playgrounds are absent). Figures are "publicly mapped, publicly accessible play".
- Play counts whole-site areas of parks and playing fields as an upper-bound
  proxy for their playable fraction (no open dataset identifies playable space
  within a park); the equipped-only figure is published alongside as the lower
  bound. Formal and restricted facilities (bowling greens, tennis courts, golf) are
  excluded. Definition corrected July 2026; areas re-measured with boundary
  clipping August 2026.
- Every dimension is a container measure: a ward is scored on what lies inside it.
  A park just over the boundary counts for nothing however close it is. Transport is
  the exception, giving half credit to stations one ward over. Walking-distance
  access for play is the v2 upgrade.
- The 15 City of London wards have no published ward-level child population, so
  play (and the education and family gaps there) are `null`, openly, not estimated.
  Six further City wards have fewer than 50 resident children, so their m²/child
  figures are fragile in either direction; their ward panels say so.
- Safety zeros in central and town-centre wards are real data (the most street crime
  per resident in London), not missing data. The UI says so wherever safety is 2 or
  below. Crimes involving visitors count against the resident population, so busy
  destination wards rank worse than quiet residential ones; that trade-off is
  declared rather than hidden.
- Safety is a single month of police.uk street crime (June 2026 in this build).
  One month carries noise, and police.uk publishes about two months behind.
- The planning dimension sorts applications by keywords in their descriptions,
  which misfiles some of them.

## Pipeline

`pipeline/01...12_*.js`, plain Node, no build step, cached fetches in `pipeline/cache/`.
Order: `01` wards (ONS WD24 boundaries, joined by WD24CD code, never by name) then
`02` crime, `03` green, `04` transport, `05` education, `06` planning,
`07` family fit, **`10` play**, `08` merge (writes `out/wards_final.json`), then
copy to `public/data/wards.json`, then `09` transport access re-score (edits the
public file in place; must run **after** the copy or transport reverts to the old
containment scoring), then `12` scoring fix (edits the public file in place; applies
the percentile and per-resident scoring described above and refreshes the family
display fields from `out/07_family_fit_by_ward.json`, so it must run last).
`11` re-scores safety in place after a crime refresh (`02` then `11`); after a
crime refresh, run `12` again so safety returns to per-resident percentiles.

Step 10 needs two files in `pipeline/cache/` (both open, both documented in the
header of `pipeline/10_play.js`): the OS Open Greenspace GeoPackage and an ONS
mid-2024 children-0-15 CSV from Nomis.

## Serving

Cloudflare Worker (`src/index.js`) serving `public/` as static assets plus
`/api/scores` and `/api/wards`.

Deploy with `npx wrangler deploy` from the repo root. The Cloudflare Git
integration has proved unreliable (builds skipped, cancelled or stuck in
Initializing), so a push to `main` should not be assumed to have shipped. Check
the live `/api/wards/<name>` response after deploying. Note that the CDN can serve
a cached copy of `/` after a deploy; append a query string to verify the new build.

## Licences

data.police.uk, ONS, Ofsted, Planning London Datahub under OGL v3.
OS Open Greenspace © Crown copyright, OGL v3.
OpenStreetMap © OpenStreetMap contributors, ODbL.
