// Step 8: merge all 6 dimension outputs into the final wards.json consumed by the site + agent.
//
// Scoring approach: every dimension gets a 0-100 score, higher = better, via min-max
// normalization of a real, documented raw metric across all matched London wards (no fabricated
// numbers — wards missing a metric get `score: null` and keep their raw fields visible so the
// gap is honest rather than papered over with an average).
//
// Density metrics (safety, transport) are normalized per km² of ward area rather than raw
// counts, because London ward areas vary by >50x (dense Zone 1 wards vs. large outer-London
// wards) and raw counts would just reward/punish big wards for their size. Green space is the
// deliberate exception: it's scored on raw count of playgrounds/parks/reserves, since "lots of
// green space" is a real, size-independent good for kids (see greenRaw below).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonOut, writeJsonOut } from "./lib/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Rough equirectangular ward area in km^2 — good enough for relative comparison within London's
// narrow latitude band (51.3-51.7N), not for cartographic precision.
function ringAreaKm2(ring, refLat) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const cosLat = Math.cos(toRad(refLat));
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng0, lat0] = ring[i];
    const [lng1, lat1] = ring[i + 1];
    const x0 = toRad(lng0) * cosLat * R,
      y0 = toRad(lat0) * R;
    const x1 = toRad(lng1) * cosLat * R,
      y1 = toRad(lat1) * R;
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area / 2);
}

function geometryAreaKm2(geometry, refLat) {
  if (!geometry) return null;
  if (geometry.type === "Polygon")
    return ringAreaKm2(geometry.coordinates[0], refLat);
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.reduce(
      (sum, poly) => sum + ringAreaKm2(poly[0], refLat),
      0,
    );
  }
  return null;
}

function percentile(sortedValues, p) {
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

// Min-max normalize a Map(ward_code -> raw value) to 0-100. `invert` flips direction (for metrics
// where lower-is-better, e.g. crime density). Returns Map(ward_code -> integer score | null).
//
// The top of the range is clipped to the 95th percentile (`clipP`), not the raw max. Density
// metrics (green space, transport, safety) are per km^2, and a handful of tiny wards (some City
// of London wards are under 0.1km^2) turn one or two real features into a freakish density value.
// Left uncapped, that single outlier becomes the ceiling for all ~700 wards and crushes every
// normal-sized ward — including ones with genuinely lots of green space, like most of Richmond
// upon Thames — toward zero. Clipping at p95 means "the best ~5% of wards all get full marks"
// instead of "one micro-ward sets the scale for London." Values above the clip still score 100,
// they're not discarded.
function minMaxScore(rawByCode, { invert = false, clipP = 0.95 } = {}) {
  const values = [...rawByCode.values()].filter(
    (v) => v != null && isFinite(v),
  );
  if (!values.length) return new Map();
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const cap = percentile(sorted, clipP);
  const scored = new Map();
  for (const [code, v] of rawByCode) {
    if (v == null || !isFinite(v)) {
      scored.set(code, null);
      continue;
    }
    const clipped = Math.min(v, cap);
    let normalized = cap === min ? 50 : ((clipped - min) / (cap - min)) * 100;
    if (invert) normalized = 100 - normalized;
    scored.set(code, Math.round(Math.max(0, Math.min(100, normalized))));
  }
  return scored;
}

function byCode(arr, field = "ward_code") {
  return new Map(arr.map((x) => [x[field], x]));
}

async function main() {
  const base = readJsonOut("01_wards_base.json");
  const crime = byCode(readJsonOut("02_crime_by_ward.json").wards);
  const green = byCode(readJsonOut("03_green_by_ward.json").wards);
  const transport = byCode(readJsonOut("04_transport_by_ward.json").wards);
  const education = byCode(readJsonOut("05_education_by_ward.json").wards);
  const planning = byCode(readJsonOut("06_planning_by_ward.json").wards);
  const familyFit = byCode(readJsonOut("07_family_fit_by_ward.json").wards);

  // Ward area (km^2), for density-based scores.
  const areaByCode = new Map();
  for (const w of base.wards) {
    const refLat = w.centroid?.lat || 51.5;
    areaByCode.set(w.ward_code, geometryAreaKm2(w.geometry, refLat));
  }

  // --- Raw metrics per dimension ---
  const crimeDensity = new Map(); // crimes per km^2 (population-normalization would need a
  // separate population-per-ward join for all 704 wards; area-density is the honest, fully-covered proxy used here)
  for (const [code, c] of crime) {
    const area = areaByCode.get(code);
    crimeDensity.set(code, area ? c.crimes_last_month / area : null);
  }

  // Raw count (playgrounds + parks/nature reserves), NOT divided by ward area. Green space is
  // scored on how much of it exists, not how densely it's packed in — a large ward that's mostly
  // one big park (Richmond Park, big outer-London wards) should score very highly, not get
  // punished for having a big denominator. This deliberately differs from the transport/safety
  // density metrics below, where "per km^2" is the right comparison.
  const greenRaw = new Map();
  for (const [code, g] of green) {
    greenRaw.set(code, g.playground_count + g.park_reserve_count);
  }

  const transportDensity = new Map(); // (stations*3 + bus stops) per km^2, weighted so rail/tube counts more than a single bus stop
  for (const [code, t] of transport) {
    const area = areaByCode.get(code);
    transportDensity.set(
      code,
      area ? (t.station_count * 3 + t.bus_stop_count) / area : null,
    );
  }

  const educationRaw = new Map();
  for (const [code, e] of education) {
    educationRaw.set(code, e.pct_good_or_outstanding); // already 0-100 or null if no graded school
  }

  const planningRaw = new Map();
  for (const [code, p] of planning) {
    planningRaw.set(code, p.upcoming_facility_count);
  }

  const familyRaw = new Map();
  for (const [code, f] of familyFit) {
    if (
      f.pct_households_with_dependent_children == null ||
      f.pct_population_family_forming_age == null
    ) {
      familyRaw.set(code, null);
    } else {
      familyRaw.set(
        code,
        f.pct_households_with_dependent_children +
          f.pct_population_family_forming_age,
      );
    }
  }

  // --- Normalize to 0-100 scores ---
  const safetyScore = minMaxScore(crimeDensity, { invert: true }); // lower crime density = higher score
  const greenScore = minMaxScore(greenRaw);
  const transportScore = minMaxScore(transportDensity);
  const educationScore = minMaxScore(educationRaw); // already a %, but re-scaled relative to London's own range for consistency with other dims
  const planningScore = minMaxScore(planningRaw);
  const familyScore = minMaxScore(familyRaw);

  // Step-free bonus folds into the transport score modestly (it's already reflected in
  // nearest_stations for the agent to cite; here we nudge wards with a confirmed step-free
  // station up, since it's the single most buggy-critical fact in this dimension).
  const finalTransportScore = new Map();
  for (const [code, score] of transportScore) {
    const t = transport.get(code);
    const bonus = t?.any_step_free_station ? 5 : 0;
    finalTransportScore.set(
      code,
      score == null ? null : Math.min(100, score + bonus),
    );
  }

  const wards = base.wards.map((w) => {
    const c = crime.get(w.ward_code);
    const g = green.get(w.ward_code);
    const t = transport.get(w.ward_code);
    const e = education.get(w.ward_code);
    const p = planning.get(w.ward_code);
    const f = familyFit.get(w.ward_code);

    return {
      ward_name: w.ward_name,
      borough: w.borough,
      ward_code: w.ward_code,
      centroid: w.centroid,
      scores: {
        safety: safetyScore.get(w.ward_code) ?? null,
        green_space: greenScore.get(w.ward_code) ?? null,
        transport: finalTransportScore.get(w.ward_code) ?? null,
        education: educationScore.get(w.ward_code) ?? null,
        planning: planningScore.get(w.ward_code) ?? null,
        family_fit: familyScore.get(w.ward_code) ?? null,
      },
      dimensions: {
        safety: {
          score: safetyScore.get(w.ward_code) ?? null,
          crimes_last_month: c?.crimes_last_month ?? null,
          period: readJsonOut("02_crime_by_ward.json").period,
          top_categories: c?.top_categories ?? [],
        },
        green_space: {
          score: greenScore.get(w.ward_code) ?? null,
          playground_count: g?.playground_count ?? null,
          park_reserve_count: g?.park_reserve_count ?? null,
          notable_parks: g?.notable_parks ?? [],
        },
        transport: {
          score: finalTransportScore.get(w.ward_code) ?? null,
          station_count: t?.station_count ?? null,
          bus_stop_count: t?.bus_stop_count ?? null,
          any_step_free_station: t?.any_step_free_station ?? false,
          nearest_stations: t?.nearest_stations ?? [],
        },
        education: {
          score: educationScore.get(w.ward_code) ?? null,
          school_count: e?.school_count ?? null,
          pct_good_or_outstanding: e?.pct_good_or_outstanding ?? null,
          schools: e?.schools ?? [],
        },
        planning: {
          score: planningScore.get(w.ward_code) ?? null,
          upcoming_facility_count: p?.upcoming_facility_count ?? null,
          upcoming_facilities: p?.upcoming_facilities ?? [],
        },
        family_fit: {
          score: familyScore.get(w.ward_code) ?? null,
          pct_households_with_dependent_children:
            f?.pct_households_with_dependent_children ?? null,
          pct_population_family_forming_age:
            f?.pct_population_family_forming_age ?? null,
          summary:
            f?.pct_households_with_dependent_children != null
              ? `${f.pct_households_with_dependent_children}% of households here have dependent children.`
              : null,
        },
      },
    };
  });

  const output = {
    metadata: {
      version: "1.0.0",
      scored_at: new Date().toISOString().slice(0, 10),
      boroughs: [...new Set(wards.map((w) => w.borough))].sort(),
      ward_count: wards.length,
      note: "Real, sourced data across all 33 London boroughs. Each dimension score is a min-max normalization of a documented raw metric, clipped to the 95th percentile so a handful of freak micro-ward outliers can't compress the whole scale (see dimensions[].*.score plus the raw fields alongside it). Wards missing a metric have score:null rather than an invented value.",
      sources: {
        safety:
          "data.police.uk crimes-street/all-crime, latest month, tiled poly queries, point-in-polygon joined to ward, normalized per km^2 (not population — see pipeline/06 note)",
        green_space:
          "OpenStreetMap Overpass (leisure=playground|park|nature_reserve; leisure=garden excluded as mostly private plots), London-wide query, raw count of features per ward (not area-normalized — lots of park/playground is a genuine size-independent good). (c) OpenStreetMap contributors, ODbL.",
        transport:
          "TfL StopPoint/Mode (tube, dlr, overground, tram) + OSM Overpass (national rail, bus stops), normalized per km^2, +5 bonus for a confirmed step-free station (TfL AccessViaLift)",
        education:
          'Ofsted "State-funded schools inspections and outcomes as at 31 August 2025", schools geocoded to wards via postcodes.io admin_ward',
        planning:
          "Planning London Datahub (planningdata.london.gov.uk/api-guest), approved child-relevant applications since 2023, joined by application centroid point-in-polygon",
        family_fit:
          "ONS Census 2021 via Nomis (household composition + age bands), joined at 2022-ward geography to 2024 wards",
      },
    },
    dimensions: [
      "safety",
      "green_space",
      "transport",
      "education",
      "planning",
      "family_fit",
    ],
    wards,
  };

  writeJsonOut("wards_final.json", output);

  const scoredCounts = Object.fromEntries(
    output.dimensions.map((d) => [
      d,
      wards.filter((w) => w.scores[d] != null).length,
    ]),
  );
  console.log(
    `Merged ${wards.length} wards. Scored coverage per dimension:`,
    scoredCounts,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
