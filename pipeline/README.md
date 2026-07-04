# KidStreet data pipeline

Pulls real, verified, ward-level data for all 33 London boroughs across 6 dimensions (safety,
green space, transport, education, planning, family fit) and merges it into
`public/data/wards.json` (and a copy at `data/wards.json`), which `src/index.js` serves via
`/api/scores` (flat, map-compatible) and `/api/wards` (rich, per-ward detail for the agent).

See `../data/DATA_PLAN.md` for the original brief this implements.

## Design: bulk-fetch once, join locally

Every script fetches each source **once** for all of London (not once per ward), then joins to
wards locally with point-in-polygon / postcode-to-ward lookups. This is the key difference from
the first, abandoned approach of querying per-ward per-dimension (~4,000+ fragile calls). The
whole pipeline runs in under a minute and issues well under 200 network requests total.

All HTTP responses are cached to `pipeline/cache/` (gitignored) keyed by a stable name, so
re-running any script after the first successful run is instant and offline-safe. Delete a cache
file (or the whole directory) to force a re-fetch.

## Running

```
node pipeline/01_wards.js       # resolve all London wards -> code, borough, boundary, centroid
node pipeline/02_crime.js       # safety: data.police.uk, tiled poly queries
node pipeline/03_green_space.js # green space: OSM Overpass playgrounds/parks/gardens
node pipeline/04_transport.js   # transport: TfL StopPoint bulk modes + OSM rail/bus fallback
node pipeline/05_education.js   # education: Ofsted CSV + postcodes.io bulk geocoding
node pipeline/06_planning.js    # planning: Planning London Datahub, centroid point-in-polygon
node pipeline/07_family_fit.js  # family fit: ONS Census 2021 via Nomis
node pipeline/08_merge.js       # merge + normalize all 6 into wards_final.json
```

Then copy the result into place:

```
cp pipeline/out/wards_final.json public/data/wards.json
cp pipeline/out/wards_final.json data/wards.json
```

Scripts must run in order (each depends on `01_wards_base.json` from step 1; step 8 depends on
the output of steps 2-7).

## Coverage & honesty notes

- **Safety, green space, transport, planning**: matched for all 704 London wards.
- **Education**: 656/704 wards have at least one graded school directly in them (the rest are
  small residential wards with no school inside their boundary — a real gap, not a bug).
- **Family fit**: 679/704 matched; the 25 unmatched are all City of London wards, which had a
  ward boundary redraw between the Census 2021 ("2022 wards") geography and the current WD24
  boundaries used everywhere else in this pipeline.
- Every dimension score is a min-max normalization of a real, documented raw metric across
  matched London wards. Wards missing a metric get `score: null`, not an invented average — see
  `metadata.sources` in the output file for exactly what was measured and how.
- Transport and safety scores are normalized **per km² of ward area**, not raw counts, because
  ward areas vary by 50x+ across London and raw counts would just reward/punish big wards for
  their size. Green space is scored on **raw count** of playgrounds + parks/nature reserves
  instead (leisure=garden is excluded — in the London OSM data it's ~27k/35k features and mostly
  tiny/private plots, not places a kid can go play): having a lot of green space is a genuine,
  size-independent good, so a big park-filled ward like most of Richmond upon Thames should score
  well rather than being penalized for having a large denominator.
