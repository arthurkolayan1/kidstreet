# KidStreet data pipeline

Pulls real, verified, ward-level data for all 33 London boroughs across seven dimensions
(safety, education, transport, green space, family fit, play, planning) and merges it into
`public/data/wards.json`, which `src/index.js` serves via `/api/scores` (flat,
map-compatible) and `/api/wards` (rich, per-ward detail).

See `../README.md` for the scoring method, weights and declared limitations, and
`../data/DATA_PLAN.md` for the original brief this implements.

## Design: bulk-fetch once, join locally

Every script fetches each source **once** for all of London, not once per ward, then joins to
wards locally with point-in-polygon and postcode-to-ward lookups. This is the key difference
from the first, abandoned approach of querying per ward per dimension (4,000+ fragile calls).
The whole pipeline runs in under a minute and issues well under 200 network requests.

All HTTP responses are cached to `pipeline/cache/` (gitignored) keyed by a stable name, so
re-running any script after the first successful run is instant and offline-safe. Delete a
cache file, or the whole directory, to force a re-fetch.

Wards are joined by ONS ward code (`WD24CD`) everywhere, never by name.

## Running

Build stages, in order. Each depends on `out/01_wards_base.json` from step 1; step 8 depends
on the output of steps 2 to 7 and 10.

```
node pipeline/01_wards.js       # all London wards -> code, borough, boundary, centroid
node pipeline/02_crime.js       # safety: data.police.uk, tiled poly queries
node pipeline/03_green_space.js # green space: OSM Overpass playgrounds/parks/nature reserves
node pipeline/04_transport.js   # transport: TfL StopPoint bulk modes + OSM rail/bus fallback
node pipeline/05_education.js   # education: Ofsted CSV + postcodes.io bulk geocoding
node pipeline/06_planning.js    # planning: Planning London Datahub, point-in-polygon
node pipeline/07_family_fit.js  # family fit: ONS Census 2021 via Nomis
node pipeline/10_play.js        # play: OS Open Greenspace area per child (centroid assignment)
node pipeline/08_merge.js       # merge + normalise all seven into out/wards_final.json
```

Then copy the result into place:

```
cp pipeline/out/wards_final.json public/data/wards.json
```

Three stages then edit the **served file in place**, in this order. Order matters and getting
it wrong silently reverts scoring rather than failing:

```
node pipeline/09_transport_access.js  # access-based transport re-score
node pipeline/13_play_clip.js         # re-measure play by clipping polygons to ward boundaries
node pipeline/12_score_fix.js         # percentile + per-resident scoring; MUST run last
```

- `09` must run **after** the copy, or transport reverts to the old in-ward-only containment
  scoring.
- `13` replaces step 10's centroid areas with clipped ones. It needs `npm install`
  (`polygon-clipping`) and the OS Open Greenspace GeoPackage in `cache/`.
- `12` must run **after** `13`, or the play score keeps percentiles computed from the
  unclipped areas. It ends with a saturation report that warns if any dimension has gone flat.

After a crime refresh (`02`), run `11_crime_rescore.js` to re-score safety in place, then run
`12` again so safety returns to per-resident percentiles.

## What changed in August 2026, and why

Two scoring rules in the original pipeline were wrong in ways that were invisible until
someone checked a specific ward. Both are now reversed. If you are reading old comments in the
build scripts, these are the two to distrust:

**Transport and safety are no longer divided by ward area.** The original reasoning was that
ward areas vary by more than 50x, so raw counts would reward big wards. In practice the
division punished wards that are large *because of parkland*: Richmond Park pushed Ham,
Petersham & Richmond Riverside to 4 out of 100 on transport despite 44 bus stops and five
stations one ward over. Transport is now an access measure (in-ward stations, half credit for
stations one ward over, bus stops at a twentieth of a station), percentile-ranked. Safety is
crimes per 1,000 **residents**, percentile-ranked and inverted.

**Play areas are clipped, not centroid-assigned.** Step 10 assigns each site wholly to the
ward containing its centre point. For small sites that is fine; for large parks it is not.
Step 13 intersects each site polygon with each ward polygon and counts only the area actually
inside. See `../README.md` for the East Sheen case and the invariant check that now catches it.

## Coverage

Out of 704 wards:

- **Safety, transport, green space, planning**: 704 matched.
- **Play**: 689 scored. The 15 nulls are all City of London wards, where ONS publishes no
  ward-level child population. Never estimated, never zero.
- **Family fit**: 679 matched. The 25 nulls are all City of London wards, which had a boundary
  redraw between the Census 2021 ("2022 wards") geography and the WD24 boundaries used
  everywhere else here.
- **Education**: 656 wards have at least one Ofsted-rated school inside their boundary. The
  rest are small residential wards with no school in them. That is a real gap, not a bug, and
  the composite renormalises around it rather than scoring them zero.

A ward missing a metric gets `score: null`, never an invented average. See `metadata.sources`
in the output file for exactly what was measured and how.
