// Step 6: planning (next 5 years) dimension via the Planning London Datahub.
//
// Bulk strategy: ONE Elasticsearch query across all 33 boroughs (guest access, no key) for
// approved, child-relevant applications (schools, nurseries, playgrounds, health/community
// centres, new/expanded parks and open space) decided since 2023 -> up to 10,000 hits in a single
// request (~2-5s), instead of one query per borough or per ward.
//
// Precision note: a bare "park" keyword false-positives heavily on London street names that
// contain "Park" (e.g. "24 Lee Park", "268 Dacre Park"), which are just addresses, not park
// facilities. The query below requires park/green-space applications to also mention an
// open-space-development term (playground, play area, landscaping, planting, open space) so a
// simple address match alone doesn't qualify.
//
// Matching: primary match is point-in-polygon against each application's `centroid` (lat/lon),
// which every record has — this sidesteps the fact that the datahub's free-text `ward` field is
// inconsistent per-borough (most give a plain ward name, but some, e.g. Westminster and
// Hammersmith & Fulham, use internal ward codes like "BWW_22"). Applications with no usable
// centroid fall back to normalized borough+ward-name matching; anything still unmatched is
// counted and reported, not silently dropped.
import { readJsonOut, writeJsonOut, cachedPostJson } from "./lib/http.js";
import { pointInGeometry } from "./lib/geo.js";

const PLANNING_URL =
  "https://planningdata.london.gov.uk/api-guest/applications/_search";

// lpa_name values in the datahub don't always match our LAD24NM borough strings exactly.
const LPA_TO_BOROUGH = {
  Kingston: "Kingston upon Thames",
  "Hammersmith & Fulham": "Hammersmith and Fulham",
  "Kensington & Chelsea": "Kensington and Chelsea",
  "Barking & Dagenham": "Barking and Dagenham",
  Richmond: "Richmond upon Thames",
  LLDC: null, // London Legacy Development Corporation - spans multiple boroughs, not a borough itself
  OPDC: null, // Old Oak and Park Royal Development Corporation - ditto
};

function normalize(str) {
  return (str || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['".,]/g, "")
    .replace(/\bward\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Classification is deliberately stricter than the search query for "park"/open-space cases,
// to avoid mislabeling street-address matches (see precision note above).
const FACILITY_KEYWORDS = [
  { re: /\bschool\b/i, type: "school" },
  { re: /\bnursery\b/i, type: "nursery" },
  { re: /playground|play area|play equipment|play space/i, type: "playground" },
  {
    re: /health centre|medical centre|health facility|gp surgery|healthcare/i,
    type: "health",
  },
  {
    re: /community centre|community hub|youth centre|children.?s centre/i,
    type: "community",
  },
  {
    re: /new park\b|public open space|new open space|nature reserve|play(ing)? field/i,
    type: "park",
  },
];

function classify(description) {
  for (const { re, type } of FACILITY_KEYWORDS) {
    if (re.test(description)) return type;
  }
  return "other";
}

async function main() {
  const query = {
    size: 10000,
    _source: [
      "lpa_name",
      "borough",
      "ward",
      "centroid",
      "description",
      "status",
      "decision",
      "decision_date",
      "application_type_full",
      "lpa_app_no",
    ],
    query: {
      bool: {
        filter: [
          {
            range: {
              decision_date: { gte: "01/01/2023", format: "dd/MM/yyyy" },
            },
          },
          { terms: { "decision.raw": ["Approved"] } },
        ],
        must: [
          {
            query_string: {
              // Deliberately excludes a bare "park" term (see precision note above) — the
              // Elasticsearch query_string doesn't support the same lookahead precision as the
              // classifier regexes, so we scope the query to phrases unlikely to be street names.
              query:
                'school OR nursery OR playground OR "play area" OR "play space" OR "play equipment" OR "playing field" OR "health centre" OR "medical centre" OR "community centre" OR "community hub" OR "youth centre" OR "children\'s centre" OR "new park" OR "public open space" OR "new open space" OR "nature reserve"',
              default_field: "description",
            },
          },
        ],
      },
    },
  };

  const data = await cachedPostJson(
    "planning_datahub_london_v2",
    PLANNING_URL,
    query,
  );
  const hits = data.hits.hits.map((h) => h._source);
  console.log(
    `Planning Datahub: ${hits.length} approved child-relevant applications since 2023.`,
  );

  const { wards } = readJsonOut("01_wards_base.json");
  const wardIndex = new Map();
  for (const w of wards) {
    const key = normalize(w.borough) + "|" + normalize(w.ward_name);
    wardIndex.set(key, w);
  }
  const wardsByBorough = new Map();
  for (const w of wards) {
    const b = normalize(w.borough);
    if (!wardsByBorough.has(b)) wardsByBorough.set(b, []);
    wardsByBorough.get(b).push(w);
  }

  const facilitiesByWard = new Map();
  let matchedByCentroid = 0,
    matchedByName = 0,
    unmatched = 0,
    filteredOut = 0;
  const unmatchedSamples = [];

  for (const app of hits) {
    const type = classify(app.description || "");
    if (type === "other") {
      filteredOut++;
      continue;
    } // matched the broad search but not our stricter classifier (e.g. a street-name false positive)

    const boroughRaw =
      LPA_TO_BOROUGH[app.lpa_name] !== undefined
        ? LPA_TO_BOROUGH[app.lpa_name]
        : app.lpa_name;
    if (!boroughRaw) {
      unmatched++;
      continue;
    } // LLDC/OPDC - not a standard London borough

    let matchedWard = null;
    const lat = parseFloat(app.centroid?.lat);
    const lng = parseFloat(app.centroid?.lon);
    if (isFinite(lat) && isFinite(lng)) {
      const candidates = wardsByBorough.get(normalize(boroughRaw)) || [];
      for (const w of candidates) {
        if (w.geometry && pointInGeometry([lng, lat], w.geometry)) {
          matchedWard = w;
          break;
        }
      }
      if (matchedWard) matchedByCentroid++;
    }
    if (!matchedWard) {
      const key = normalize(boroughRaw) + "|" + normalize(app.ward);
      matchedWard = wardIndex.get(key) || null;
      if (matchedWard) matchedByName++;
    }
    if (!matchedWard) {
      unmatched++;
      if (unmatchedSamples.length < 10)
        unmatchedSamples.push({ borough: app.lpa_name, ward: app.ward });
      continue;
    }

    if (!facilitiesByWard.has(matchedWard.ward_code))
      facilitiesByWard.set(matchedWard.ward_code, []);
    const [day, month, year] = (app.decision_date || "").split("/");
    facilitiesByWard.get(matchedWard.ward_code).push({
      description: (app.description || "").slice(0, 200),
      type,
      status: app.status,
      decision: app.decision,
      decision_date: year ? `${year}-${month}-${day}` : null,
      ref: app.lpa_app_no,
    });
  }
  console.log(
    `Classified as child-relevant: ${hits.length - filteredOut} (filtered out as false-positive/off-topic: ${filteredOut})`,
  );
  console.log(
    `Matched by centroid: ${matchedByCentroid}, by name fallback: ${matchedByName}, unmatched: ${unmatched}`,
  );
  if (unmatchedSamples.length)
    console.log(
      "Unmatched samples:",
      JSON.stringify(unmatchedSamples, null, 2),
    );

  const result = wards.map((w) => {
    const facilities = (facilitiesByWard.get(w.ward_code) || [])
      .sort((a, b) =>
        (b.decision_date || "").localeCompare(a.decision_date || ""),
      )
      .slice(0, 10);
    return {
      ward_code: w.ward_code,
      ward_name: w.ward_name,
      upcoming_facility_count: facilities.length,
      upcoming_facilities: facilities,
    };
  });

  writeJsonOut("06_planning_by_ward.json", {
    generated_at: new Date().toISOString(),
    source:
      "Planning London Datahub (planningdata.london.gov.uk/api-guest), approved applications since 2023 matching child-relevant keywords (school/nursery/playground/health/community/new open space). Joined primarily by point-in-polygon on each application's centroid; a small residual falls back to borough+ward-name matching or is unmatched (see match_stats). Applications matching the broad search but not the stricter facility classifier (e.g. street addresses containing the word 'Park') are excluded.",
    match_stats: {
      matchedByCentroid,
      matchedByName,
      unmatched,
      filteredOutAsOffTopic: filteredOut,
    },
    wards: result,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
