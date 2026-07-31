// Step 10: play provision dimension — OS Open Greenspace play and informal recreation
// area per child (site function in Play Space, Playing Field or Public Park Or Garden),
// benchmarked against the London Plan Policy S4 figure of 10 m² per child. The
// equipped-only subset (Play Space alone) is computed alongside as the lower bound.
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
//   - SELECT geom, function FROM greenspace_site WHERE function IN
//     ('Play Space', 'Playing Field', 'Public Park Or Garden') — the "play and
//     informal recreation" scope. Formal/restricted facilities (bowling greens,
//     tennis courts, golf, allotments) are excluded. Whole-site areas are an
//     upper-bound proxy for the playable fraction, so the equipped-only subset
//     (Play Space alone, OS's equipped-play typology) is computed alongside as the
//     declared lower bound. See PLAY_FUNCTIONS and EQUIPPED_ONLY below.
//   - Area: shoelace on the BNG polygon rings (outer minus holes), in m².
//   - Ward assignment: site CENTROID point-in-polygon against WD24 boundaries —
//     consistent with every other stage in this pipeline (crime, green, planning).
//     Boundary-straddling sites are therefore assigned wholly to one ward; at ward
//     scale this is a small, declared approximation (a clipped-intersection version
//     is the v2 upgrade).
//   - m2_per_child = ward play area / ward children 0-15;
//     ratio = m2_per_child / 10; score = min(100, round(ratio * 100)) — the exact
//     formula the served dataset already uses (verified against all 689 scored wards).
//   - Wards with no published ward-level child population (the 15 City of London
//     wards where ONS publishes none) => score null. The City's other wards are
//     scored, some with very small child counts.
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
  // The geometry column name varies between GeoPackage producers (geom, geometry,
  // shape, wkb_geometry...). Ask the file itself instead of assuming.
  const discoverSql =
    "SELECT column_name FROM gpkg_geometry_columns WHERE lower(table_name)='greenspace_site'";
  const pragmaSql = "PRAGMA table_info(greenspace_site)";

  const CANDIDATE_FUNCTIONS = [
    "Play Space",
    "Playing Field",
    "Other Sports Facility",
    "Public Park Or Garden",
    "Bowling Green",
    "Tennis Court",
  ];
  const inList = CANDIDATE_FUNCTIONS.map((f) => `'${f}'`).join(",");
  const buildSelect = (geomCol, funcCol) =>
    `SELECT hex("${geomCol}") AS g, "${funcCol}" AS f FROM greenspace_site WHERE "${funcCol}" IN (${inList})`;

  const pickFuncCol = (names) =>
    names.find((n) => /^function$/i.test(n)) ||
    names.find((n) => /function/i.test(n)) ||
    "function";

  // 1) node:sqlite (Node >= 22.5)
  try {
    const mod = await import("node:sqlite");
    const db = new mod.DatabaseSync(gpkgPath, { readOnly: true });
    let geomCol = null;
    try {
      const r = db.prepare(discoverSql).all();
      if (r.length) geomCol = r[0].column_name;
    } catch {}
    const cols = db.prepare(pragmaSql).all().map((c) => c.name);
    if (!geomCol) geomCol = cols.find((n) => /geom|shape/i.test(n));
    const funcCol = pickFuncCol(cols);
    if (!geomCol) throw new Error(`no geometry column found; columns: ${cols.join(", ")}`);
    console.log(`[gpkg] geometry column: ${geomCol}; function column: ${funcCol}`);
    const rows = db.prepare(buildSelect(geomCol, funcCol)).all();
    db.close();
    console.log(`[gpkg] read via node:sqlite: ${rows.length} candidate sites`);
    return rows.map((r) => ({ hex: r.g, func: r.f }));
  } catch (e) {
    console.log(`[gpkg] node:sqlite path failed (${e.message}), trying sqlite3 CLI`);
  }

  // 2) sqlite3 CLI (ships with macOS)
  const cli = (sql) =>
    execFileSync("sqlite3", ["-readonly", gpkgPath, sql], {
      maxBuffer: 1024 * 1024 * 512,
      encoding: "utf8",
    });
  let geomCol = null;
  try {
    const out = cli(discoverSql).trim();
    if (out) geomCol = out.split("\n")[0].trim();
  } catch {}
  const colNames = cli(pragmaSql)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.split("|")[1]);
  if (!geomCol) geomCol = colNames.find((n) => /geom|shape/i.test(n));
  const funcCol = pickFuncCol(colNames);
  if (!geomCol) throw new Error(`no geometry column found; columns: ${colNames.join(", ")}`);
  console.log(`[gpkg] geometry column: ${geomCol}; function column: ${funcCol}`);
  const rows = cli(buildSelect(geomCol, funcCol))
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const i = l.indexOf("|");
      return { hex: l.slice(0, i), func: l.slice(i + 1) };
    });
  console.log(`[gpkg] read via sqlite3 CLI: ${rows.length} candidate sites`);
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
function splitCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

// Header cell -> is this an age column covering only ages <= 15?
// Accepts "Age 7", "Aged 5-9", "Age 0 - 4", "Under 1", "Age 15". Rejects "All Ages",
// anything mentioning an age above 15, and non-age columns.
function ageColumnCovers0to15(header) {
  const h = header.toLowerCase();
  if (!/age|under/.test(h)) return false;
  if (/all/.test(h)) return false;
  if (/under\s*1\b/.test(h)) return true;
  const nums = (h.match(/\d+/g) || []).map(Number);
  if (!nums.length) return false;
  return Math.max(...nums) <= 15;
}

function loadChildren015(csvPath) {
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const first = splitCsvLine(lines[0]).map((h) => h.toUpperCase());

  // ---- Format A: flat Nomis API export (GEOGRAPHY_CODE / OBS_VALUE [/ AGE]) ----
  if (first.includes("GEOGRAPHY_CODE") && first.includes("OBS_VALUE")) {
    const iCode = first.indexOf("GEOGRAPHY_CODE");
    const iVal = first.indexOf("OBS_VALUE");
    let iAge = first.findIndex((h) => h === "AGE" || h === "C_AGE_NAME" || h === "C_AGE");
    const byWard = new Map();
    for (let i = 1; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i]);
      const code = cols[iCode];
      if (!code || !code.startsWith("E05")) continue;
      const val = Number(cols[iVal]);
      if (!isFinite(val)) continue;
      if (iAge !== -1) {
        const ageRaw = (cols[iAge] || "").toLowerCase();
        const m = ageRaw.match(/\d+/);
        if (!m) { if (!/under\s*1\b/.test(ageRaw)) continue; }
        else if (Number(m[0]) > 15) continue;
      }
      byWard.set(code, (byWard.get(code) || 0) + val);
    }
    console.log(`[children] flat API format: ${byWard.size} wards`);
    return byWard;
  }

  // ---- Format B: Nomis report layout (title lines, then a header row, then rows) ----
  // Find the header row: the first line followed by data rows, containing an
  // age-like column. Then locate the ward-code column by inspecting the data.
  let headerIdx = -1, header = null;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length >= 2 && cells.some((c) => ageColumnCovers0to15(c))) {
      headerIdx = i; header = cells; break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(
      "Could not find a header row with age columns. Expected either the flat Nomis API format (GEOGRAPHY_CODE/OBS_VALUE) or the Nomis report layout with 'Age ...' columns.",
    );
  }
  const dataRows = lines.slice(headerIdx + 1).map(splitCsvLine).filter((r) => r.length >= header.length - 1);

  // Ward-code column: any column whose data values look like E05... codes
  let codeCol = -1;
  const sample = dataRows.slice(0, 200);
  for (let c = 0; c < header.length; c++) {
    const hits = sample.filter((r) => /^E05\d+/.test(r[c] || "")).length;
    if (hits >= Math.max(1, Math.floor(sample.length * 0.3))) { codeCol = c; break; }
  }
  if (codeCol === -1) {
    throw new Error(
      "This Nomis export has no ward-code column (only ward names). Re-export with area codes: on Nomis go to Format/Layout and tick 'include area codes' (mnemonic), then download the CSV again. Name-based joins are not supported (duplicate ward names across England).",
    );
  }
  const ageCols = header.map((h, i) => (ageColumnCovers0to15(h) ? i : -1)).filter((i) => i !== -1);
  console.log(
    `[children] report layout: header at line ${headerIdx + 1}, code column ${codeCol + 1}, summing ${ageCols.length} age column(s): ${ageCols.map((i) => header[i]).join(" | ")}`,
  );
  const byWard = new Map();
  for (const r of dataRows) {
    const code = r[codeCol];
    if (!code || !code.startsWith("E05")) continue;
    let sum = 0, any = false;
    for (const c of ageCols) {
      const v = Number(String(r[c]).replace(/,/g, ""));
      if (isFinite(v)) { sum += v; any = true; }
    }
    if (any) byWard.set(code, (byWard.get(code) || 0) + sum);
  }
  console.log(`[children] report layout: ${byWard.size} wards with codes`);
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

  // per-ward, per-function area accumulation
  const areaByWardFunc = new Map(); // code -> Map(function -> m2)
  const countByWardFunc = new Map();
  let parsed = 0, inLondon = 0, assigned = 0, failed = 0;

  for (const site of hexes) {
    let polys;
    try {
      polys = parseGpkgGeometry(site.hex).polygons;
      parsed++;
    } catch (e) {
      failed++;
      continue;
    }
    let siteArea = 0, biggest = null, biggestArea = -1;
    for (const rings of polys) {
      const ar = polygonAreaM2(rings);
      siteArea += ar;
      if (ar > biggestArea) { biggestArea = ar; biggest = rings; }
    }
    if (!biggest) { failed++; continue; }
    const [E, N] = polygonCentroidBng(biggest);
    const { lat, lng } = bngToWgs84(E, N);
    if (lng < lonMin || lng > lonMax || lat < latMin || lat > latMax) continue;
    inLondon++;
    for (const box of wardBoxes) {
      if (lng < box.minLng || lng > box.maxLng || lat < box.minLat || lat > box.maxLat) continue;
      if (pointInGeometry([lng, lat], box.w.geometry)) {
        const code = box.w.ward_code;
        if (!areaByWardFunc.has(code)) { areaByWardFunc.set(code, new Map()); countByWardFunc.set(code, new Map()); }
        const m = areaByWardFunc.get(code), cm = countByWardFunc.get(code);
        m.set(site.func, (m.get(site.func) || 0) + siteArea);
        cm.set(site.func, (cm.get(site.func) || 0) + 1);
        assigned++;
        break;
      }
    }
  }
  console.log(
    `Sites: ${hexes.length} candidates GB, ${parsed} parsed (${failed} failed), ${inLondon} in London bbox, ${assigned} assigned`,
  );

  // LOCKED DEFINITION (decided July 2026, reverse-engineered and then policy-checked):
  // "play and informal recreation space" per the scope of London Plan Policy S4 and
  // the Shaping Neighbourhoods SPG = equipped play + playing fields + public parks.
  // Bowling greens, tennis courts, golf and other restricted/formal facilities are
  // excluded. Whole-site areas are an UPPER-BOUND proxy for the playable fraction
  // (no open dataset identifies playable space within parks); the equipped-only
  // figure is published alongside as the declared LOWER bound.
  const PLAY_FUNCTIONS = ["Play Space", "Playing Field", "Public Park Or Garden"];
  const EQUIPPED_ONLY = ["Play Space"];

  const areaFor = (code, combo) => {
    const m = areaByWardFunc.get(code);
    if (!m) return 0;
    let a = 0;
    for (const f of combo) a += m.get(f) || 0;
    return Math.round(a);
  };
  const countFor = (code, combo) => {
    const m = countByWardFunc.get(code);
    if (!m) return 0;
    let c = 0;
    for (const f of combo) c += m.get(f) || 0;
    return c;
  };

  const result = wards.map((w) => {
    const area = areaFor(w.ward_code, PLAY_FUNCTIONS);
    const equipped = areaFor(w.ward_code, EQUIPPED_ONLY);
    const kids = children.get(w.ward_code) ?? null;
    const m2 = kids ? Math.round((area / kids) * 10) / 10 : null;
    const equippedM2 = kids ? Math.round((equipped / kids) * 10) / 10 : null;
    const ratio = m2 != null ? Math.round((m2 / BENCHMARK_M2_PER_CHILD) * 100) / 100 : null;
    const score = ratio != null ? Math.min(100, Math.round(ratio * 100)) : null;
    return {
      ward_code: w.ward_code,
      ward_name: w.ward_name,
      play_area_m2: area,
      equipped_play_area_m2: equipped,
      play_site_count: countFor(w.ward_code, PLAY_FUNCTIONS),
      equipped_play_site_count: countFor(w.ward_code, EQUIPPED_ONLY),
      children_0_15: kids,
      m2_per_child: m2,
      equipped_m2_per_child: equippedM2,
      ratio_vs_benchmark: ratio,
      benchmark_m2_per_child: BENCHMARK_M2_PER_CHILD,
      score,
    };
  });

  writeJsonOut("10_play_by_ward.json", {
    generated_at: new Date().toISOString(),
    functions_used: PLAY_FUNCTIONS,
    equipped_functions: EQUIPPED_ONLY,
    source:
      "OS Open Greenspace (GeoPackage GB, EPSG:27700, OGL v3): play and informal recreation space = site polygons with function in [Play Space, Playing Field, Public Park Or Garden] (formal/restricted facilities such as bowling greens, tennis courts and golf excluded); whole-site areas are an upper-bound proxy for the playable fraction, so the equipped-only (Play Space) figure is published alongside as the lower bound. Shoelace area in native BNG metres; site centroid point-in-polygon to ONS WD24 wards; ONS mid-2024 ward population estimates via Nomis, ages 0-15 summed per ward code. London Plan Policy S4's 10 m2/child ('play and informal recreation') applied as a BENCHMARK against existing population, not a compliance test. Known under-count: school-grounds and some estate play provision absent from OS Open Greenspace.",
    benchmark_note:
      "score = min(100, round((m2_per_child / 10) * 100)); wards with no published child population (City of London) are null, never zero.",
    wards: result,
  });

  // headline + reconciliation
  let deficit = 0, kidsDeficit = 0, kidsTotal = 0, eqDeficit = 0, eqKids = 0;
  for (const r of result) {
    if (r.children_0_15) kidsTotal += r.children_0_15;
    if (r.m2_per_child != null && r.m2_per_child < 10) { deficit++; kidsDeficit += r.children_0_15; }
    if (r.equipped_m2_per_child != null && r.equipped_m2_per_child < 10) { eqDeficit++; eqKids += r.children_0_15; }
  }
  console.log("--- headline (play and informal recreation definition) ---");
  console.log(`wards below 10 m²/child: ${deficit}`);
  console.log(`children in below-benchmark wards: ${Math.round(kidsDeficit).toLocaleString("en-GB")} of ${Math.round(kidsTotal).toLocaleString("en-GB")}`);
  console.log("--- lower bound (equipped play only) ---");
  console.log(`wards below 10 m²/child on equipped provision alone: ${eqDeficit}`);
  console.log(`children in those wards: ${Math.round(eqKids).toLocaleString("en-GB")}`);

  if (fs.existsSync(SERVED)) {
    const served = JSON.parse(fs.readFileSync(SERVED, "utf8"));
    const servedBy = new Map(served.wards.map((w) => [w.ward_code, w.dimensions?.play_provision || null]));
    const diffs = [];
    for (const r of result) {
      const s = servedBy.get(r.ward_code);
      if (s && s.play_area_m2 != null) diffs.push(Math.abs(r.play_area_m2 - s.play_area_m2));
    }
    const med = diffs.sort((a, b) => a - b)[Math.floor(diffs.length / 2)];
    console.log(`--- vs currently published: median |area diff| = ${med} m² (definition correction applied) ---`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
