// Step 4: transport access dimension. Bulk strategy across two free, no-key sources:
//
//   - TfL StopPoint/Mode/{tube,dlr,overground,tram}: one call per mode returns EVERY stop
//     for that mode in London (not per-ward). `StopPoint/Mode/national-rail` and `/bus` are too
//     large for this endpoint (observed 400/504), so those two are covered via OSM instead.
//   - OSM Overpass: one London-wide query for `railway=station` (covers National Rail, and is
//     also a fallback/cross-check for the TfL modes) and `highway=bus_stop`.
//
// Step-free access: TfL's `additionalProperties` (category "Accessibility") has an `AccessViaLift`
// flag on ~1/3 of tube/rail stations (LRAD source data) — used as the step-free proxy since there's
// no cleaner single field. Buggy-critical, called out explicitly in the schema per the plan.
//
// Every station/stop is assigned to its ward via point-in-polygon locally: ~6 network calls total
// instead of one per ward.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonOut, writeJsonOut, cachedCurlPostJson } from './lib/http.js';
import { pointInGeometry } from './lib/geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');

async function cachedTflMode(mode) {
  const file = path.join(CACHE_DIR, `tfl_mode_${mode}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`[fetch] tfl mode=${mode}`);
  const res = await fetch(`https://api.tfl.gov.uk/StopPoint/Mode/${mode}`);
  if (!res.ok) {
    console.warn(`  [warn] TfL mode=${mode} failed with ${res.status}, skipping (covered by OSM fallback where applicable)`);
    return { stopPoints: [] };
  }
  const json = await res.json();
  fs.writeFileSync(file, JSON.stringify(json));
  return json;
}

function isStepFree(stopPoint) {
  const accessViaLift = stopPoint.additionalProperties?.find((p) => p.key === 'AccessViaLift');
  if (!accessViaLift) return null; // unknown
  return accessViaLift.value === 'Yes';
}

async function main() {
  const { wards } = readJsonOut('01_wards_base.json');

  // --- TfL: tube, dlr, overground, tram (bulk per-mode) ---
  const tflModes = ['tube', 'dlr', 'overground', 'tram'];
  const stations = []; // { name, lat, lng, modes: [], step_free }

  for (const mode of tflModes) {
    const data = await cachedTflMode(mode);
    const stationStops = (data.stopPoints || []).filter((s) =>
      ['NaptanMetroStation', 'NaptanRailStation'].includes(s.stopType)
    );
    for (const s of stationStops) {
      stations.push({
        name: s.commonName?.replace(/ (Underground|Rail|DLR) Station$/i, '') || s.commonName,
        lat: s.lat,
        lng: s.lon,
        modes: [mode],
        step_free: isStepFree(s)
      });
    }
    console.log(`  ${mode}: ${stationStops.length} stations`);
  }

  // --- OSM: national rail stations (bulk fallback/primary) + bus stops ---
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const { bboxOfGeometry } = await import('./lib/geo.js');
  for (const w of wards) {
    if (!w.geometry) continue;
    const [a, b, c, d] = bboxOfGeometry(w.geometry);
    minLng = Math.min(minLng, a); minLat = Math.min(minLat, b);
    maxLng = Math.max(maxLng, c); maxLat = Math.max(maxLat, d);
  }
  const query = `
[out:json][timeout:180];
(
  node["railway"="station"](${minLat},${minLng},${maxLat},${maxLng});
  node["highway"="bus_stop"](${minLat},${minLng},${maxLat},${maxLng});
);
out;
`.trim();
  const osmData = cachedCurlPostJson('overpass_transport_london', 'https://overpass-api.de/api/interpreter', query);
  console.log(`OSM transport elements: ${osmData.elements.length}`);

  const busStops = [];
  for (const el of osmData.elements) {
    if (el.tags?.railway === 'station') {
      // Only add if not already covered by a TfL station within ~150m (avoid double counting
      // the same physical station pulled from two sources).
      const dup = stations.some((s) => haversine(s.lat, s.lng, el.lat, el.lon) < 150);
      if (!dup) {
        stations.push({ name: el.tags.name || 'Unnamed station', lat: el.lat, lng: el.lon, modes: ['national-rail'], step_free: null });
      }
    } else if (el.tags?.highway === 'bus_stop') {
      busStops.push({ lat: el.lat, lng: el.lon });
    }
  }
  console.log(`Total unique stations: ${stations.length}, bus stops: ${busStops.length}`);

  // --- Local join: assign every station/bus stop to a ward ---
  const stationsByWard = new Map();
  const busCountByWard = new Map();

  for (const s of stations) {
    for (const w of wards) {
      if (!w.geometry) continue;
      if (pointInGeometry([s.lng, s.lat], w.geometry)) {
        if (!stationsByWard.has(w.ward_code)) stationsByWard.set(w.ward_code, []);
        stationsByWard.get(w.ward_code).push(s);
        break;
      }
    }
  }
  for (const b of busStops) {
    for (const w of wards) {
      if (!w.geometry) continue;
      if (pointInGeometry([b.lng, b.lat], w.geometry)) {
        busCountByWard.set(w.ward_code, (busCountByWard.get(w.ward_code) || 0) + 1);
        break;
      }
    }
  }

  const result = wards.map((w) => {
    const stns = stationsByWard.get(w.ward_code) || [];
    return {
      ward_code: w.ward_code,
      ward_name: w.ward_name,
      station_count: stns.length,
      nearest_stations: stns.slice(0, 6).map((s) => ({ name: s.name, modes: s.modes, step_free: s.step_free })),
      any_step_free_station: stns.some((s) => s.step_free === true),
      bus_stop_count: busCountByWard.get(w.ward_code) || 0
    };
  });

  writeJsonOut('04_transport_by_ward.json', {
    generated_at: new Date().toISOString(),
    source: 'TfL StopPoint/Mode (tube, dlr, overground, tram) + OSM Overpass (railway=station national rail fallback, highway=bus_stop). Step-free = TfL AccessViaLift flag where known.',
    wards: result
  });
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
