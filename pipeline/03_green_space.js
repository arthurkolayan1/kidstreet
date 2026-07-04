// Step 3: green space dimension via OpenStreetMap Overpass, bulk strategy.
//
// One Overpass query for all of Greater London's playgrounds/parks/gardens/nature reserves
// (~20-30s, ~32k features) instead of one query per ward. Ways return a `center` point (from
// `out center`) which we use for point-in-polygon assignment to wards. Park/nature_reserve `way`s
// also carry a `name` tag we surface as "notable_parks" for the voice agent.
import { cachedCurlPostJson, readJsonOut, writeJsonOut } from "./lib/http.js";
import { pointInGeometry, bboxOfGeometry } from "./lib/geo.js";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

async function main() {
  const { wards } = readJsonOut("01_wards_base.json");

  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  for (const w of wards) {
    if (!w.geometry) continue;
    const [a, b, c, d] = bboxOfGeometry(w.geometry);
    minLng = Math.min(minLng, a);
    minLat = Math.min(minLat, b);
    maxLng = Math.max(maxLng, c);
    maxLat = Math.max(maxLat, d);
  }

  const query = `
[out:json][timeout:180];
(
  node["leisure"="playground"](${minLat},${minLng},${maxLat},${maxLng});
  way["leisure"="playground"](${minLat},${minLng},${maxLat},${maxLng});
  way["leisure"="park"](${minLat},${minLng},${maxLat},${maxLng});
  way["leisure"="garden"](${minLat},${minLng},${maxLat},${maxLng});
  way["leisure"="nature_reserve"](${minLat},${minLng},${maxLat},${maxLng});
);
out center;
`.trim();

  const data = cachedCurlPostJson("overpass_green_london", OVERPASS_URL, query);
  console.log(
    `Overpass returned ${data.elements.length} green-space features.`,
  );

  const playgrounds = [];
  // "Real" green space (park/nature_reserve) is tracked separately from `garden`, which in the
  // London OSM data is dominated by tiny/private residential plots (~27k of ~35k leisure
  // features returned here) rather than places a kid can actually go play. Gardens are kept in
  // the raw data for context but excluded from the score below so they don't drown out actual
  // parks and reserves.
  const parksOrReserves = [];
  const gardens = [];

  for (const el of data.elements) {
    const lat = el.type === "node" ? el.lat : el.center?.lat;
    const lng = el.type === "node" ? el.lon : el.center?.lon;
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const leisure = el.tags?.leisure;
    const name = el.tags?.name || null;
    if (leisure === "playground") {
      playgrounds.push({ lat, lng });
    } else if (leisure === "garden") {
      gardens.push({ lat, lng, name });
    } else {
      parksOrReserves.push({ lat, lng, name, type: leisure });
    }
  }
  console.log(
    `  playgrounds: ${playgrounds.length}, parks/reserves: ${parksOrReserves.length}, gardens (excluded from score): ${gardens.length}`,
  );

  const playgroundCountByWard = new Map();
  // Every park/nature_reserve feature counts, named or not — a single large park (e.g. Richmond
  // Park) is frequently split into many unnamed OSM sub-polygons, so counting only named features
  // massively undercounts big, genuinely green wards.
  const parkCountByWard = new Map();
  const parkNamesByWard = new Map(); // named ones only, kept for the "notable_parks" display list

  for (const p of playgrounds) {
    for (const w of wards) {
      if (!w.geometry) continue;
      if (pointInGeometry([p.lng, p.lat], w.geometry)) {
        playgroundCountByWard.set(
          w.ward_code,
          (playgroundCountByWard.get(w.ward_code) || 0) + 1,
        );
        break;
      }
    }
  }
  for (const p of parksOrReserves) {
    for (const w of wards) {
      if (!w.geometry) continue;
      if (pointInGeometry([p.lng, p.lat], w.geometry)) {
        parkCountByWard.set(
          w.ward_code,
          (parkCountByWard.get(w.ward_code) || 0) + 1,
        );
        if (p.name) {
          if (!parkNamesByWard.has(w.ward_code))
            parkNamesByWard.set(w.ward_code, []);
          parkNamesByWard.get(w.ward_code).push(p.name);
        }
        break;
      }
    }
  }

  const result = wards.map((w) => {
    const names = parkNamesByWard.get(w.ward_code) || [];
    const uniqueNames = [...new Set(names)].slice(0, 8);
    return {
      ward_code: w.ward_code,
      ward_name: w.ward_name,
      playground_count: playgroundCountByWard.get(w.ward_code) || 0,
      park_reserve_count: parkCountByWard.get(w.ward_code) || 0,
      notable_parks: uniqueNames,
    };
  });

  writeJsonOut("03_green_by_ward.json", {
    generated_at: new Date().toISOString(),
    source:
      "OpenStreetMap Overpass API (leisure=playground|park|nature_reserve; leisure=garden excluded from scoring as mostly private plots), single London-wide query, point-in-polygon join. © OpenStreetMap contributors, ODbL.",
    wards: result,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
