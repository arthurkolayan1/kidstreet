// Step 9: transport ACCESS re-score (fixes the station containment bug).
//
// The problem: step 4 assigns each station to exactly one ward by point-in-polygon,
// and step 8 scores wards on stations *inside their own polygon*. Stations serve
// catchments much larger than a ward, and central wards are small — so a ward like
// Marylebone (Westminster), ringed by Baker Street, Marylebone, Bond Street and
// Regent's Park stations that all sit metres over its boundary, scored station_count=0
// and transport=19. 289 of 704 wards had zero in-ward stations under that definition.
// That is a containment metric mislabelled as an access metric.
//
// The fix: score station access as
//     effective_stations = stations in the ward + 0.5 x stations in adjacent wards
// where "adjacent" = shares at least one boundary vertex (the ONS BSC boundaries are
// topologically consistent, so contiguous wards share vertices). Bus stops stay
// own-ward only — they are dense and local, so containment is a fair proxy for them.
// The rest of the scoring is unchanged from step 8: density per km^2, min-max
// normalised, clipped at the 95th percentile, +5 step-free bonus (now granted if a
// confirmed step-free station is in the ward OR an adjacent ward, since the station
// serving you is often across the boundary).
//
// London wards average ~2 km across, so an adjacent ward's station is typically well
// within pram-pushing distance. Half-weighting keeps "station on your doorstep"
// ahead of "station one ward over". A proper walking-isochrone model is the v2 fix;
// this one is honest about being a proximity proxy and removes the false zeros.
//
// Reads:  pipeline/out/01_wards_base.json   (geometry, for adjacency + area)
//         pipeline/out/04_transport_by_ward.json (station/bus counts per ward)
//         public/data/wards.json            (the served dataset, edited in place)
// Writes: public/data/wards.json            (scores.transport + dimensions.transport
//                                            updated; everything else preserved,
//                                            including the play_provision dimension
//                                            which step 8 does not know about)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonOut } from './lib/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVED = path.join(__dirname, '..', 'public', 'data', 'wards.json');

// --- Same area + normalisation helpers as step 8 (kept in sync deliberately) ---
function ringAreaKm2(ring, refLat) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const cosLat = Math.cos(toRad(refLat));
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng0, lat0] = ring[i];
    const [lng1, lat1] = ring[i + 1];
    const x0 = toRad(lng0) * cosLat * R, y0 = toRad(lat0) * R;
    const x1 = toRad(lng1) * cosLat * R, y1 = toRad(lat1) * R;
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area / 2);
}
function geometryAreaKm2(geometry, refLat) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') return ringAreaKm2(geometry.coordinates[0], refLat);
  if (geometry.type === 'MultiPolygon')
    return geometry.coordinates.reduce((sum, poly) => sum + ringAreaKm2(poly[0], refLat), 0);
  return null;
}
function percentile(sortedValues, p) {
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}
function minMaxScore(rawByCode, { invert = false, clipP = 0.95 } = {}) {
  const values = [...rawByCode.values()].filter((v) => v != null && isFinite(v));
  if (!values.length) return new Map();
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const cap = percentile(sorted, clipP);
  const scored = new Map();
  for (const [code, v] of rawByCode) {
    if (v == null || !isFinite(v)) { scored.set(code, null); continue; }
    const clipped = Math.min(v, cap);
    let normalized = cap === min ? 50 : ((clipped - min) / (cap - min)) * 100;
    if (invert) normalized = 100 - normalized;
    scored.set(code, Math.round(Math.max(0, Math.min(100, normalized))));
  }
  return scored;
}

// --- Adjacency from shared boundary vertices ---
function geometryVertexKeys(geometry) {
  const keys = [];
  if (!geometry) return keys;
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  for (const poly of polys)
    for (const ring of poly)
      for (const c of ring) keys.push(c[0].toFixed(6) + ',' + c[1].toFixed(6));
  return keys;
}

async function main() {
  const base = readJsonOut('01_wards_base.json');
  const transport = new Map(
    readJsonOut('04_transport_by_ward.json').wards.map((t) => [t.ward_code, t]),
  );
  const served = JSON.parse(fs.readFileSync(SERVED, 'utf8'));

  // Build vertex -> wards index, then ward -> adjacent wards.
  const vertexIndex = new Map();
  for (const w of base.wards) {
    for (const key of new Set(geometryVertexKeys(w.geometry))) {
      if (!vertexIndex.has(key)) vertexIndex.set(key, []);
      vertexIndex.get(key).push(w.ward_code);
    }
  }
  const adjacency = new Map(); // code -> Set of neighbouring codes
  for (const codes of vertexIndex.values()) {
    if (codes.length < 2) continue;
    for (const a of codes)
      for (const b of codes) {
        if (a === b) continue;
        if (!adjacency.has(a)) adjacency.set(a, new Set());
        adjacency.get(a).add(b);
      }
  }

  // Effective station access + density.
  const areaByCode = new Map();
  for (const w of base.wards) {
    const refLat = w.centroid?.lat || 51.5;
    areaByCode.set(w.ward_code, geometryAreaKm2(w.geometry, refLat));
  }

  const accessDensity = new Map();
  const accessDetail = new Map();
  for (const w of base.wards) {
    const own = transport.get(w.ward_code);
    if (!own) { accessDensity.set(w.ward_code, null); continue; }
    const neighbours = [...(adjacency.get(w.ward_code) || [])];
    let adjacentStations = 0;
    let adjacentStepFree = false;
    for (const n of neighbours) {
      const t = transport.get(n);
      if (!t) continue;
      adjacentStations += t.station_count;
      if (t.any_step_free_station) adjacentStepFree = true;
    }
    const effectiveStations = own.station_count + 0.5 * adjacentStations;
    const area = areaByCode.get(w.ward_code);
    accessDensity.set(
      w.ward_code,
      area ? (effectiveStations * 3 + own.bus_stop_count) / area : null,
    );
    accessDetail.set(w.ward_code, {
      stations_in_ward: own.station_count,
      stations_in_adjacent_wards: adjacentStations,
      step_free_in_or_adjacent: own.any_step_free_station || adjacentStepFree,
    });
  }

  const baseScore = minMaxScore(accessDensity);
  let changed = 0;
  for (const w of served.wards) {
    const score = baseScore.get(w.ward_code);
    const detail = accessDetail.get(w.ward_code);
    if (score == null || !detail) continue;
    const withBonus = Math.min(100, score + (detail.step_free_in_or_adjacent ? 5 : 0));
    if (w.scores.transport !== withBonus) changed++;
    w.scores.transport = withBonus;
    const dim = w.dimensions?.transport;
    if (dim) {
      dim.score = withBonus;
      dim.stations_in_adjacent_wards = detail.stations_in_adjacent_wards;
      dim.step_free_in_or_adjacent = detail.step_free_in_or_adjacent;
      dim.access_note =
        'Access-based: stations in this ward plus half-weight for stations in adjacent wards. Bus stops counted in-ward only.';
    }
  }

  if (served.metadata?.sources) {
    served.metadata.sources.transport =
      'TfL StopPoint/Mode (tube, dlr, overground, tram) + OSM Overpass (national rail, bus stops). Access scored as stations in the ward + 0.5x stations in adjacent wards (wards sharing a boundary), x3 weight vs bus stops, per km^2, min-max normalised clipped at p95, +5 bonus for a confirmed step-free station in or adjacent to the ward (TfL AccessViaLift). Adjacent-ward smoothing added because stations serve catchments larger than a single ward; in-ward-only counting gave central wards ringed by stations a false zero.';
  }

  fs.writeFileSync(SERVED, JSON.stringify(served));
  console.log(`Rescored transport for ${changed} wards -> ${SERVED}`);

  // Sanity prints
  const check = (name) => {
    const w = served.wards.find((x) => x.ward_name === name);
    if (w) console.log(`  ${name}: transport ${w.scores.transport}`);
  };
  ['Marylebone', "Regent's Park", 'West End', "Queen's Park", 'Havering-atte-Bower', 'Biggin Hill'].forEach(check);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
