// Step 10: play provision dimension — OS Open Greenspace "Play Space" area per child,
// benchmarked against the London Plan Policy S4 figure of 10 m² per child.
//
// This stage makes the play dimension REPRODUCIBLE. The served dataset previously
// contained play_provision numbers with no generating code in this repo (step 9's
// comment: "the play_provision dimension which step 8 does not know about"). This
// stage derives the same fields from source, so anyone can re-run and check them.
//
// Benchmark framing (deliberate, see methodology): Policy S4's 10 m²/child is a
// requirement on NEW residential development, derived from child yield. Applying it
// to the existing ward child population is a benchmark use, not a compliance test —
// no existing ward is "in breach" of S4. We label it accordingly everywhere.
//
// Inputs (all documented, all open):
//   1. pipeline/cache/opgrsp_gpkg_gb.gpkg
//      OS Open Greenspace, GeoPackage GB (~57 MB), OGL v3. Download (no key needed):
//        https://api.os.uk/downloads/v1/products/OpenGreenspace/downloads?area=GB&format=GeoPackage&redirect
//      Unzip and place the .gpkg at the path above (filename inside the zip may vary;
//      rename to opgrsp_gpkg_gb.gpkg). CRS is EPSG:27700 (British National Grid) —
//      coordinates are metres, so polygon areas are m² natively, no reprojection
//      needed for AREA. Centroids are converted BNG→WGS84 for ward assignment only.
//   2. pipeline/cache/children_0_15_mid2024.csv
//      ONS mid-2024 ward-level population estimates via Nomis (released 7 Nov 2025).
//      Expected columns (header names matched case-insensitively, extra columns fine):
//        GEOGRAPHY_CODE  — WD24CD ward code (e.g. E05013806)
//        OBS_VALUE       — count for one single-year age group, OR a pre-summed 0-15
//        [AGE / C_AGE_NAME optional] — if an age column is present, rows are filtered
//        to ages 0..15 and summed per ward; if absent, one row per ward is assumed
//        to already be the 0-15 total.
//      How to produce it (browser, ~2 min): nomisweb.co.uk → Query data →
//      Population estimates - small area based → geography: 2024 wards (London),
//      age: individual ages 0 to 15, date: mid-2024 → download CSV.
//   3. pipeline/out/01_wards_base.json (committed) — WD24 ward geometry.
//
// Method:
//   - SELECT id, function, geom FROM greenspace_site WHERE function = 'Play Space'
//     ("Play Space" is OS's equipped-play typology; Playing Field etc. are NOT
//     included — that is a deliberate, declared scope choice: equipped play only.)
//   - Area: shoelace on the BNG polygon rings (outer minus holes), in m².
//   - Ward assignment: site CENTROID point-in-polygon against WD24 boundaries —
//     consistent with every other stage in this pipeline (crime, green, planning).
//     Boundary-straddling sites are therefore assigned wholly to one ward; at ward
//     scale this is a small, declared approximation (a clipped-intersection version
//     is the v2 upgrade).
//   - m2_per_child = ward play area / ward children 0-15;
//     ratio = m2_per_child / 10; score = min(100, round(ratio * 100)) — the exact
//     formula the served dataset already uses (verified against all 689 scored wards).
//   - Wards with no published child population (City of London) => score null.
//
// Output: pipeline/out/10_play_by_ward.json
// Also prints a reconciliation report against public/data/wards.json so a re-run
// can be compared against the currently-published numbers before deploying.
//
// Known limitations (declared, not hidden):
//   - OS Open Greenspace under-counts equipped play: school-grounds playgrounds and
//     some estate/housing-association playgrounds are absent. Figures are best read
//     as "publicly mapped, publicly accessible play space".
//   - Centroid assignment (above).
//   - BNG→WGS84 uses a single-Helmert transformation (~2-5 m accuracy) — irrelevant
//     at ward scale but stated for completeness.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJsonOut, writeJsonOut } from "./lib/http.js";
import { pointInGeometry } from "./lib/geo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GPKG = path.join(__dirname, "cache", "opgrsp_gpkg_gb.gpkg");
const CHILD_CSV = path.join(__dirname, "cache", "children_0_15_mid2024.csv");
const SERVED = path.join(__dirname, "..", "public", "data", "wards.json");

const BENCHMARK_M2_PER_CHILD = 10; // London Plan Policy S4, used as a benchmark (see header)

// ---------------------------------------------------------------------------
// GeoPackage reading: prefer node:sqlite (Node >= 22.5); fall back to the
// sqlite3 CLI (preinstalled on macOS). Either way, zero npm dependencies.
// ---------------------------------------------------------------------------
async function readPlaySpaceHexGeoms(gpkgPath) {
  const sql =
    "SELECT hex(geom) FROM greenspace_site WHERE function = 'Play Space';";
  // 1) node:sqlite (Node >= 22.5)
  try {
    const mod = await import("node:sqlite");
    const db = new mod.DatabaseSync(gpkgPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT hex(geom) AS g FROM greenspace_site WHERE function = 'Play Space'",
    ).all();
    db.close();
    console.log(`[gpkg] read via node:sqlite: ${rows.length} Play Space sites`);
    return rows.map((r) => r.g);
  } catch (e) {
    console.log(`[gpkg] node:sqlite unavailable (${e.message}), trying sqlite3 CLI`);
  }
  // 2) sqlite3 CLI (ships with macOS)
  const out = execFileSync("sqlite3", ["-readonly", gpkgPath, sql], {
    maxBuffer: 1024 * 1024 * 512,
    encoding: "utf8",
  });
  const rows = out.split("\n").filter((l) => l.trim().length > 0);
  console.log(`[gpkg] read via sqlite3 CLI: ${rows.length} Play Space sites`);
  return rows;
}

// ---------------------------------------------------------------------------
// GeoPackage geometry blob -> rings in BNG metres.
// Blob layout (GPKG spec): magic 'GP', version, flags, int32 srs_id,
// optional envelope (size from flags bits 1-3), then standard WKB.
// ---------------------------------------------------------------------------
function parseGpkgGeometry(hex) {
  const buf = Buffer.from(hex, "hex");
  if (buf[0] !== 0x47 || buf[1] !== 0x50) throw new Error("not a GPKG blob");
  const flags = buf[3];
  const envIndicator = (flags >> 1) & 0x07;
  const envDoubles = [0, 4, 6, 6, 8][envIndicator] ?? 0;
  const wkbStart = 8 + envDoubles * 8;
  return parseWkb(buf, wkbStart);
}

function parseWkb(buf, offset) {
  const little = buf[offset] === 1;
  const readU32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const readF64 = (o) => (little ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  let type = readU32(offset + 1);
  const hasZ = (type & 0x80000000) !== 0 || (type >= 1001 && type <= 1007) || (type >= 3001 && type <= 3007);
  const hasM = (type & 0x40000000) !== 0 || (type >= 2001 && type <= 2007) || (type >= 3001 && type <= 3007);
  const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  const t = (type & 0x0fffffff) % 1000; // strips EWKB flags and ISO Z/M offsets

  let o = offset + 5;
  const readRing = () => {
    const n = readU32(o);
    o += 4;
    const ring = [];
    for (let i = 0; i < n; i++) {
      ring.push([readF64(o), readF64(o + 8)]);
      o += 8 * dims;
    }
    return ring;
  };

  if (t === 3) {
    // Polygon
    const nRings = readU32(o);
    o += 4;
    const rings = [];
    for (let i = 0; i < nRings; i++) rings.push(readRing());
    return { polygons: [rings], next: o };
  }
  if (t === 6) {
    // MultiPolygon: sequence of WKB Polygons
    const nPolys = readU32(o);
    o += 4;
    const polygons = [];
    for (let i = 0; i < nPolys; i++) {
      const sub = parseWkb(buf, o);
      polygons.push(sub.polygons[0]);
      o = sub.next;
    }
    return { polygons, next: o };
  }
  throw new Error(`unsupported WKB type ${type}`);
}

// Shoelace in projected metres (EPSG:27700). Outer ring minus holes.
function polygonAreaM2(rings) {
  const ringArea = (ring) => {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return Math.abs(a / 2);
  };
  if (!rings.length) return 0;
  let area = ringArea(rings[0]);
  for (let i = 1; i < rings.length; i++) area -= ringArea(rings[i]);
  return Math.max(0, area);
}

function polygonCentroidBng(rings) {
  // Area-weighted centroid of the outer ring (holes ignored — fine for assignment)
  const ring = rings[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    a += cross;
    cx += (ring[i][0] + ring[i + 1][0]) * cross;
    cy += (ring[i][1] + ring[i + 1][1]) * cross;
  }
  if (a === 0) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}

// ---------------------------------------------------------------------------
// EPSG:27700 (OSGB36 / British National Grid) -> WGS84 lat/lng.
// Inverse transverse Mercator on Airy 1830, then a single Helmert to WGS84.
// Accuracy ~2-5 m: irrelevant for assigning a site centroid to a ~2 km ward.
// ---------------------------------------------------------------------------
function bngToWgs84(E, N) {
  // Airy 1830
  const a = 6377563.396, b = 6356256.909;
  const F0 = 0.9996012717;
  const lat0 = (49 * Math.PI) / 180, lon0 = (-2 * Math.PI) / 180;
  const N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b), n2 = n * n, n3 = n * n * n;

  let lat = lat0, M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - lat0);
    const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
    const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (N - N0 - M >= 0.00001);

  const sinLat = Math.sin(lat), cosLat = Math.cos(lat), tanLat = Math.tan(lat);
  const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;

  const tan2 = tanLat * tanLat, tan4 = tan2 * tan2, tan6 = tan4 * tan2;
  const sec = 1 / cosLat;
  const nu3 = nu * nu * nu, nu5 = nu3 * nu * nu, nu7 = nu5 * nu * nu;
  const VII = tanLat / (2 * rho * nu);
  const VIII = (tanLat / (24 * rho * nu3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const IX = (tanLat / (720 * rho * nu5)) * (61 + 90 * tan2 + 45 * tan4);
  const X = sec / nu;
  const XI = (sec / (6 * nu3)) * (nu / rho + 2 * tan2);
  const XII = (sec / (120 * nu5)) * (5 + 28 * tan2 + 24 * tan4);
  const XIIA = (sec / (5040 * nu7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);

  const dE = E - E0, dE2 = dE * dE, dE3 = dE2 * dE, dE4 = dE2 * dE2, dE5 = dE3 * dE2, dE6 = dE4 * dE2, dE7 = dE5 * dE2;
  const latOsgb = lat - VII * dE2 + VIII * dE4 - IX * dE6;
  const lonOsgb = lon0 + X * dE - XI * dE3 + XII * dE5 - XIIA * dE7;

  // OSGB36 -> WGS84 Helmert
  return helmertOsgb36ToWgs84(latOsgb, lonOsgb, a, b);
}

function helmertOsgb36ToWgs84(lat, lon, aAiry, bAiry) {
  const e2Airy = 1 - (bAiry * bAiry) / (aAiry * aAiry);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const nu = aAiry / Math.sqrt(1 - e2Airy * sinLat * sinLat);
  const H = 0;
  let x = (nu + H) * cosLat * Math.cos(lon);
  let y = (nu + H) * cosLat * Math.sin(lon);
  let z = ((1 - e2Airy) * nu + H) * sinLat;

  // OSGB36 -> WGS84 (inverse of the published WGS84->OSGB36 set)
  const tx = 446.448, ty = -125.157, tz = 542.06;
  const s = -20.4894e-6 * -1; // ppm, sign flipped for inverse
  const asec = Math.PI / (180 * 3600);
  const rx = 0.1502 * asec, ry = 0.247 * asec, rz = 0.8421 * asec;
  const sc = 1 + s;
  const x2 = tx + sc * (x - rz * y + ry * z);
  const y2 = ty + sc * (rz * x + y - rx * z);
  const z2 = tz + sc * (-ry * x + rx * y + z);

  // Cartesian -> lat/lon on GRS80/WGS84
  const aW = 6378137.0, bW = 6356752.3142;
  const e2W = 1 - (bW * bW) / (aW * aW);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let latW = Math.atan2(z2, p * (1 - e2W));
  for (let i = 0; i < 8; i++) {
    const sinL = Math.sin(latW);
    const nuW = aW / Math.sqrt(1 - e2W * sinL * sinL);
    latW = Math.atan2(z2 + e2W * nuW * sinL, p);
  }
  const lonW = Math.atan2(y2, x2);
  return { lat: (latW * 180) / Math.PI, lng: (lonW * 180) / Math.PI };
}

// ---------------------------------------------------------------------------
// Child population CSV
// ---------------------------------------------------------------------------
function loadChildren015(csvPath) {
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const header = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, "").toUpperCase());
  const idx = (name) => header.findIndex((h) => h === name);
  const iCode = idx("GEOGRAPHY_CODE");
  const iVal = idx("OBS_VALUE");
  let iAge = header.findIndex((h) => h === "AGE" || h === "C_AGE_NAME" || h === "C_AGE");
  if (iCode === -1 || iVal === -1) {
    throw new Error(
      `children CSV must contain GEOGRAPHY_CODE and OBS_VALUE columns (found: ${header.join(", ")})`,
    );
  }
  const byWard = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const code = cols[iCode];
    if (!code || !code.startsWith("E05")) continue; // wards only
    const val = Number(cols[iVal]);
    if (!isFinite(val)) continue;
    if (iAge !== -1) {
      // filter rows to single ages 0..15 (labels like "Age 7", "7", "Aged 7 years")
      const ageRaw = (cols[iAge] || "").toLowerCase();
      const m = ageRaw.match(/\d+/);
      if (!m) {
        // skip totals/aggregates like "All ages" when an age column exists
        continue;
      }
      const age = Number(m[0]);
      if (age > 15) continue;
    }
    byWard.set(code, (byWard.get(code) || 0) + val);
  }
  return byWard;
}

// ---------------------------------------------------------------------------
async function main() {
  for (const [p, what, how] of [
    [GPKG, "OS Open Greenspace GeoPackage", "see download instructions in this file's header"],
    [CHILD_CSV, "ONS mid-2024 children 0-15 CSV", "see Nomis instructions in this file's header"],
  ]) {
    if (!fs.existsSync(p)) {
      console.error(`MISSING INPUT: ${what}\n  expected at: ${p}\n  ${how}`);
      process.exit(1);
    }
  }

  const { wards } = readJsonOut("01_wards_base.json");
  const children = loadChildren015(CHILD_CSV);
  console.log(`Child population loaded for ${children.size} wards`);

  const hexes = await readPlaySpaceHexGeoms(GPKG);

  // Pre-compute ward bounding boxes for a fast pre-filter (London only; the GPKG is GB-wide)
  const wardBoxes = wards
    .filter((w) => w.geometry)
    .map((w) => {
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      const scan = (coords) => {
        for (const c of coords) {
          if (typeof c[0] === "number") {
            minLng = Math.min(minLng, c[0]); maxLng = Math.max(maxLng, c[0]);
            minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
          } else scan(c);
        }
      };
      scan(w.geometry.coordinates);
      return { w, minLng, minLat, maxLng, maxLat };
    });
  const lonMin = Math.min(...wardBoxes.map((b) => b.minLng));
  const lonMax = Math.max(...wardBoxes.map((b) => b.maxLng));
  const latMin = Math.min(...wardBoxes.map((b) => b.minLat));
  const latMax = Math.max(...wardBoxes.map((b) => b.maxLat));

  const areaByWard = new Map();
  const siteCountByWard = new Map();
  let parsed = 0, inLondon = 0, assigned = 0, failed = 0;

  for (const hex of hexes) {
    let polys;
    try {
      polys = parseGpkgGeometry(hex).polygons;
      parsed++;
    } catch (e) {
      failed++;
      continue;
    }
    // total site area (m², BNG native) and centroid of the largest polygon
    let siteArea = 0, biggest = null, biggestArea = -1;
    for (const rings of polys) {
      const ar = polygonAreaM2(rings);
      siteArea += ar;
      if (ar > biggestArea) { biggestArea = ar; biggest = rings; }
    }
    if (!biggest) { failed++; continue; }
    const [E, N] = polygonCentroidBng(biggest);
    const { lat, lng } = bngToWgs84(E, N);
    // GB-wide file: skip everything outside London's bbox before the expensive PIP
    if (lng < lonMin || lng > lonMax || lat < latMin || lat > latMax) continue;
    inLondon++;
    for (const box of wardBoxes) {
      if (lng < box.minLng || lng > box.maxLng || lat < box.minLat || lat > box.maxLat) continue;
      if (pointInGeometry([lng, lat], box.w.geometry)) {
        const code = box.w.ward_code;
        areaByWard.set(code, (areaByWard.get(code) || 0) + siteArea);
        siteCountByWard.set(code, (siteCountByWard.get(code) || 0) + 1);
        assigned++;
        break;
      }
    }
  }
  console.log(
    `Sites: ${hexes.length} GB, ${parsed} parsed (${failed} failed), ${inLondon} in London bbox, ${assigned} assigned to wards`,
  );

  const result = wards.map((w) => {
    const area = Math.round(areaByWard.get(w.ward_code) || 0);
    const kids = children.get(w.ward_code) ?? null;
    const m2 = kids ? Math.round((area / kids) * 10) / 10 : null;
    const ratio = m2 != null ? Math.round((m2 / BENCHMARK_M2_PER_CHILD) * 100) / 100 : null;
    const score = ratio != null ? Math.min(100, Math.round(ratio * 100)) : null;
    return {
      ward_code: w.ward_code,
      ward_name: w.ward_name,
      play_area_m2: area,
      play_site_count: siteCountByWard.get(w.ward_code) || 0,
      children_0_15: kids,
      m2_per_child: m2,
      ratio_vs_benchmark: ratio,
      benchmark_m2_per_child: BENCHMARK_M2_PER_CHILD,
      score,
    };
  });

  writeJsonOut("10_play_by_ward.json", {
    generated_at: new Date().toISOString(),
    source:
      "OS Open Greenspace (GeoPackage GB, EPSG:27700, OGL v3), function='Play Space' site polygons; shoelace area in native BNG metres; site centroid point-in-polygon to ONS WD24 wards (consistent with all other stages); ONS mid-2024 ward population estimates via Nomis, ages 0-15 summed per WD24CD. London Plan Policy S4 10 m²/child applied as a BENCHMARK against existing population (S4 itself is a requirement on new development). Known under-count: school-grounds and some estate playgrounds are absent from OS Open Greenspace.",
    benchmark_note:
      "score = min(100, round((m2_per_child / 10) * 100)); wards with no published child population (City of London) are null, never zero.",
    wards: result,
  });

  // ---- Reconciliation vs currently served data --------------------------------
  if (fs.existsSync(SERVED)) {
    const served = JSON.parse(fs.readFileSync(SERVED, "utf8"));
    const servedBy = new Map(
      served.wards.map((w) => [w.ward_code, w.dimensions?.play_provision || null]),
    );
    let compared = 0, areaDiffs = [], kidDiffs = [], deficitNew = 0, deficitOld = 0, kidsInDeficitNew = 0;
    for (const r of result) {
      const s = servedBy.get(r.ward_code);
      if (r.m2_per_child != null && r.m2_per_child < 10) {
        deficitNew++;
        kidsInDeficitNew += r.children_0_15 || 0;
      }
      if (s && s.m2_per_child != null && s.m2_per_child < 10) deficitOld++;
      if (!s || s.play_area_m2 == null || r.play_area_m2 == null) continue;
      compared++;
      areaDiffs.push(Math.abs(r.play_area_m2 - s.play_area_m2));
      if (s.children_0_15 != null && r.children_0_15 != null)
        kidDiffs.push(Math.abs(r.children_0_15 - s.children_0_15));
    }
    const med = (a) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
    console.log("--- reconciliation vs public/data/wards.json ---");
    console.log(`wards compared: ${compared}`);
    console.log(`median |area diff|: ${med(areaDiffs)} m²; median |children diff|: ${med(kidDiffs)}`);
    console.log(`wards below 10 m²/child — this run: ${deficitNew} (was ${deficitOld})`);
    console.log(`children in below-benchmark wards — this run: ${Math.round(kidsInDeficitNew).toLocaleString("en-GB")}`);
    console.log("If diffs are large, investigate BEFORE publishing (function-type scope, CSV ages, boundary vintage).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
