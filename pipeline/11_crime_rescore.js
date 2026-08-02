// Step 11: re-score safety in the SERVED dataset after a crime refresh, without a full re-merge.
//
// Why this exists: step 8 writes pipeline/out/wards_final.json, but the served file
// (public/data/wards.json) has since been patched in place by steps 9 (transport access)
// and the play stage, so re-running 8 would clobber those. This step does for safety what
// step 9 does for transport: it recomputes ONLY the safety fields from a fresh
// out/02_crime_by_ward.json and edits public/data/wards.json in place.
//
// Usage (a full crime refresh to the latest police.uk month):
//   rm -f pipeline/cache/crime_latest_month.txt pipeline/cache/crime_tile_*.json
//   node pipeline/02_crime.js          # fetches the latest month (slow, ~10 min, be polite)
//   node pipeline/11_crime_rescore.js  # patches scores.safety + dimensions.safety in the served file
//
// The scoring maths below is copied verbatim from 08_merge.js (equirectangular ward area,
// crimes per km^2, min-max normalised inverted, clipped at the 95th percentile) so a
// re-score is bit-identical to what a full merge would produce for safety. If you change
// the formula in 08, change it here too.
//
// Sanity check: run against an UNCHANGED out/02_crime_by_ward.json and it should report
// "0 wards changed".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonOut } from "./lib/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVED = path.join(__dirname, "..", "public", "data", "wards.json");

// --- copied verbatim from 08_merge.js ---
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
// --- end copied block ---

function main() {
  const crimeOut = readJsonOut("02_crime_by_ward.json");
  const base = readJsonOut("01_wards_base.json");
  const crime = new Map(crimeOut.wards.map((w) => [w.ward_code, w]));

  const crimeDensity = new Map();
  for (const w of base.wards) {
    const c = crime.get(w.ward_code);
    if (!c) {
      crimeDensity.set(w.ward_code, null);
      continue;
    }
    const refLat = w.centroid?.lat || 51.5;
    const area = geometryAreaKm2(w.geometry, refLat);
    crimeDensity.set(w.ward_code, area ? c.crimes_last_month / area : null);
  }
  const safetyScore = minMaxScore(crimeDensity, { invert: true });

  const served = JSON.parse(fs.readFileSync(SERVED, "utf8"));
  let changed = 0;
  for (const w of served.wards) {
    const score = safetyScore.get(w.ward_code) ?? null;
    const c = crime.get(w.ward_code);
    const before = JSON.stringify([
      w.scores.safety,
      w.dimensions.safety?.crimes_last_month,
      w.dimensions.safety?.period,
    ]);
    w.scores.safety = score;
    w.dimensions.safety = {
      score,
      crimes_last_month: c?.crimes_last_month ?? null,
      period: crimeOut.period,
      top_categories: c?.top_categories ?? [],
    };
    const after = JSON.stringify([
      w.scores.safety,
      w.dimensions.safety.crimes_last_month,
      w.dimensions.safety.period,
    ]);
    if (before !== after) changed++;
  }

  fs.writeFileSync(SERVED, JSON.stringify(served));
  console.log(
    `Safety re-scored for period ${crimeOut.period}: ${changed} of ${served.wards.length} wards changed -> ${SERVED}`,
  );
}

main();
