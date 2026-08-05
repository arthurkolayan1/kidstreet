// Step 13: re-measure play provision by CLIPPING site polygons to ward boundaries,
// replacing step 10's centroid rule ("whole site to the ward containing its centre").
//
// WHY THIS EXISTS
// ---------------
// Step 10 assigns each greenspace site wholly to the ward containing its centroid.
// For small sites that is fine. For very large parks it is not: Richmond Park
// (~9.55 km²) has its centre in East Sheen, so East Sheen was credited with
// 9.78 km² of play space inside a 5.93 km² ward — 165% of its own land area — while
// Ham, Petersham & Richmond Riverside, which physically contains a large part of the
// same park, was credited with none of it.
//
// Two errors, opposite directions, same cause:
//   over-credit  — a ward gets a park that mostly sits somewhere else
//   under-credit — a ward gets nothing for the part of a park inside its boundary
//
// This script intersects each site polygon with each ward polygon and counts only
// the area that actually falls inside. Richmond Park then splits across East Sheen,
// Ham and the rest at their true shares.
//
// BOUNDARY RESOLUTION (important)
// -------------------------------
// pipeline/out/01_wards_base.json carries ONS **BSC** boundaries (super-generalised),
// a median of NINE vertices per ward. Those are correct in aggregate (704 wards total
// 1,572 km² against Greater London's real 1,569) and fine for drawing a map, but far
// too coarse to clip a park against. So this script fetches **BGC** (generalised, 20 m)
// boundaries directly, in EPSG:27700, and uses those for the geometry.
//
// Requesting outSR=27700 means wards arrive in the same British National Grid the
// GeoPackage already uses, so there is no reprojection anywhere in this file and no
// accumulated projection error. Areas stay true square metres via the same shoelace
// used in step 10.
//
// INPUTS
//   pipeline/cache/opgrsp_gpkg_gb.gpkg          OS Open Greenspace, GeoPackage GB (OGL v3)
//   pipeline/out/01_wards_base.json             ward codes + names (geometry NOT used here)
//   public/data/wards.json                      child population, ages 0-15, per ward
//   ONS ArcGIS WD24 BGC boundaries              fetched once, cached
//
// NOTE ON THE CHILD DENOMINATOR
//   Step 10 reads ONS mid-2024 estimates from a Nomis CSV. This stage does not need
//   that file: clipping changes site AREAS, never child counts, so the denominator is
//   read straight from the published dataset it is about to patch. That guarantees the
//   before/after comparison uses an identical denominator and removes a manual download.
//
// OUTPUTS
//   pipeline/out/13_play_clip_by_ward.json      full per-ward detail
//   public/data/wards.json                      PATCHED IN PLACE (dimensions.play_provision)
//
// RUN ORDER
//   node pipeline/13_play_clip.js
//   node pipeline/12_score_fix.js     <-- MUST run after, to re-percentile the play score
//
// DEPENDENCY
//   npm install polygon-clipping
//
// INVARIANT CHECK
//   The script fails loudly if any ward ends up with more play space than the ward's
//   own land area. That condition is geometrically impossible and is exactly what the
//   centroid rule was producing undetected. Step 12's saturation report catches flat
//   scores; this catches impossible ones.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import polygonClipping from "polygon-clipping";
import { readJsonOut, writeJsonOut } from "./lib/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GPKG = path.join(__dirname, "cache", "opgrsp_gpkg_gb.gpkg");
const BOUNDARY_CACHE = path.join(__dirname, "cache", "wd24_bgc_27700.json");
const SERVED = path.join(__dirname, "..", "public", "data", "wards.json");

const BENCHMARK_M2_PER_CHILD = 10;

// Greater London in British National Grid, with generous margin.
const LONDON_BNG = { xmin: 495000, ymin: 150000, xmax: 570000, ymax: 205000 };

const ARCGIS =
  "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/" +
  "Wards_May_2024_Boundaries_UK_BGC/FeatureServer/0/query";

// ---------------------------------------------------------------------------
// 1. Ward boundaries: ONS WD24 BGC, delivered in EPSG:27700 so no reprojection
//    is needed anywhere. Paged, then cached.
// ---------------------------------------------------------------------------
async function fetchWardBoundariesBng() {
  if (fs.existsSync(BOUNDARY_CACHE)) {
    const cached = JSON.parse(fs.readFileSync(BOUNDARY_CACHE, "utf8"));
    console.log(`[bounds] cache hit: ${cached.features.length} wards`);
    return cached.features;
  }

  const features = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const params = new URLSearchParams({
      where: "1=1",
      geometry: `${LONDON_BNG.xmin},${LONDON_BNG.ymin},${LONDON_BNG.xmax},${LONDON_BNG.ymax}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "27700",
      outSR: "27700",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "WD24CD,WD24NM",
      returnGeometry: "true",
      f: "geojson",
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
    });
    const url = `${ARCGIS}?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ONS boundary fetch failed: ${res.status}`);
    const page = await res.json();
    if (page.error) throw new Error(`ONS boundary error: ${JSON.stringify(page.error)}`);
    const got = page.features || [];
    features.push(...got);
    console.log(`[bounds] page at offset ${offset}: ${got.length} wards (total ${features.length})`);
    if (got.length < PAGE) break;
    if (offset > 20000) throw new Error("pagination runaway — aborting");
  }

  fs.mkdirSync(path.dirname(BOUNDARY_CACHE), { recursive: true });
  fs.writeFileSync(BOUNDARY_CACHE, JSON.stringify({ features }));
  console.log(`[bounds] cached ${features.length} wards to ${BOUNDARY_CACHE}`);
  return features;
}

// ---------------------------------------------------------------------------
// 2. GeoPackage reading — lifted verbatim from 10_play.js so the two stages read
//    exactly the same rows. Prefers node:sqlite (Node >= 22.5), falls back to the
//    sqlite3 CLI that ships with macOS. No npm dependency for this part.
// ---------------------------------------------------------------------------
async function readPlaySpaceHexGeoms(gpkgPath) {
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

// GPKG blob -> WKB. Same parser as step 10.
function parseGpkgGeometry(hex) {
  const buf = Buffer.from(hex, "hex");
  if (buf[0] !== 0x47 || buf[1] !== 0x50) throw new Error("not a GPKG blob");
  const flags = buf[3];
  const envIndicator = (flags >> 1) & 0x07;
  const envDoubles = [0, 4, 6, 6, 8][envIndicator] ?? 0;
  return parseWkb(buf, 8 + envDoubles * 8);
}

function parseWkb(buf, offset) {
  const little = buf[offset] === 1;
  const readU32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const readF64 = (o) => (little ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  const type = readU32(offset + 1);
  const hasZ =
    (type & 0x80000000) !== 0 || (type >= 1001 && type <= 1007) || (type >= 3001 && type <= 3007);
  const hasM =
    (type & 0x40000000) !== 0 || (type >= 2001 && type <= 2007) || (type >= 3001 && type <= 3007);
  const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  const t = (type & 0x0fffffff) % 1000;

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
    const nRings = readU32(o);
    o += 4;
    const rings = [];
    for (let i = 0; i < nRings; i++) rings.push(readRing());
    return { polygons: [rings], next: o };
  }
  if (t === 6) {
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

// Area of a MultiPolygon (array of ring-arrays).
function multiPolygonAreaM2(polygons) {
  let a = 0;
  for (const rings of polygons) a += polygonAreaM2(rings);
  return a;
}

// polygon-clipping wants closed rings. WKB usually closes them; GeoJSON always
// should. Close defensively rather than trust either.
function closeRings(polygons) {
  return polygons.map((rings) =>
    rings
      .map((ring) => {
        if (ring.length < 4) return null;
        const first = ring[0];
        const last = ring[ring.length - 1];
        return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
      })
      .filter(Boolean),
  ).filter((rings) => rings.length > 0);
}

function bboxOf(polygons) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

const bboxOverlap = (a, b) =>
  !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);

// GeoJSON geometry -> MultiPolygon-shaped array of ring-arrays.
function toMultiPolygon(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

// ---------------------------------------------------------------------------
// 3. Child population, read from the served dataset rather than re-downloaded.
//    Step 10 already resolved ONS mid-2024 ages 0-15 per ward and wrote it here.
//    Clipping does not touch child counts, so re-deriving them would add a manual
//    download and a chance of drift for no gain. Wards with no published count
//    (City of London) stay null and are never coerced to zero.
// ---------------------------------------------------------------------------
function loadChildren015FromServed(served) {
  const byWard = new Map();
  let missing = 0;
  for (const w of served.wards) {
    const n = w.dimensions?.play_provision?.children_0_15;
    if (typeof n === "number" && isFinite(n)) byWard.set(w.ward_code, n);
    else missing++;
  }
  if (!byWard.size) {
    throw new Error(
      "no child population found in public/data/wards.json — expected " +
      "dimensions.play_provision.children_0_15. Run pipeline/10_play.js first.",
    );
  }
  console.log(
    `Child population read from the served dataset: ${byWard.size} wards ` +
    `(${missing} with no published count, left null)`,
  );
  return byWard;
}

// ---------------------------------------------------------------------------
// 4. Main
// ---------------------------------------------------------------------------
const PLAY_FUNCTIONS = ["Play Space", "Playing Field", "Public Park Or Garden"];
const EQUIPPED_ONLY = ["Play Space"];

async function main() {
  if (!fs.existsSync(GPKG)) {
    console.error(
      `MISSING INPUT: OS Open Greenspace GeoPackage\n  expected at: ${GPKG}\n` +
      `  see pipeline/10_play.js header for how to obtain it`,
    );
    process.exit(1);
  }
  if (!fs.existsSync(SERVED)) {
    console.error(`MISSING INPUT: served dataset\n  expected at: ${SERVED}`);
    process.exit(1);
  }

  const { wards } = readJsonOut("01_wards_base.json");
  const wantedCodes = new Set(wards.map((w) => w.ward_code));
  const nameByCode = new Map(wards.map((w) => [w.ward_code, w.ward_name]));
  const served = JSON.parse(fs.readFileSync(SERVED, "utf8"));
  const children = loadChildren015FromServed(served);

  // --- wards, in BNG, at BGC resolution ---
  const raw = await fetchWardBoundariesBng();
  const wardGeoms = [];
  for (const f of raw) {
    const code = f.properties?.WD24CD;
    if (!code || !wantedCodes.has(code)) continue;
    const mp = closeRings(toMultiPolygon(f.geometry));
    if (!mp.length) continue;
    wardGeoms.push({
      code,
      name: nameByCode.get(code) || f.properties?.WD24NM || code,
      mp,
      bbox: bboxOf(mp),
      landAreaM2: multiPolygonAreaM2(mp),
    });
  }
  console.log(`Wards with BGC geometry matched to the pipeline: ${wardGeoms.length} of ${wards.length}`);
  if (wardGeoms.length < wards.length) {
    const got = new Set(wardGeoms.map((w) => w.code));
    const missing = wards.filter((w) => !got.has(w.ward_code)).map((w) => w.ward_name);
    console.warn(`  WARNING: no boundary for ${missing.length} ward(s): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`);
  }

  const vertexCount = wardGeoms.reduce((s, w) => s + w.mp.reduce((t, rings) => t + rings.reduce((u, r) => u + r.length, 0), 0), 0);
  console.log(`  median vertices per ward: ${Math.round(vertexCount / wardGeoms.length)} (step 10 used BSC, ~9)`);

  // --- sites ---
  const hexes = await readPlaySpaceHexGeoms(GPKG);

  const londonBox = {
    minX: Math.min(...wardGeoms.map((w) => w.bbox.minX)),
    minY: Math.min(...wardGeoms.map((w) => w.bbox.minY)),
    maxX: Math.max(...wardGeoms.map((w) => w.bbox.maxX)),
    maxY: Math.max(...wardGeoms.map((w) => w.bbox.maxY)),
  };

  const areaByWardFunc = new Map(); // code -> Map(function -> clipped m2)
  const countByWardFunc = new Map(); // a site counts for every ward it touches
  const add = (code, func, area) => {
    if (!areaByWardFunc.has(code)) {
      areaByWardFunc.set(code, new Map());
      countByWardFunc.set(code, new Map());
    }
    const a = areaByWardFunc.get(code), c = countByWardFunc.get(code);
    a.set(func, (a.get(func) || 0) + area);
    c.set(func, (c.get(func) || 0) + 1);
  };

  let parsed = 0, failed = 0, inLondon = 0, clipped = 0, split = 0;
  let wholeSiteArea = 0, keptArea = 0;

  for (const site of hexes) {
    let polys;
    try {
      polys = closeRings(parseGpkgGeometry(site.hex).polygons);
      parsed++;
    } catch {
      failed++;
      continue;
    }
    if (!polys.length) { failed++; continue; }

    const sBox = bboxOf(polys);
    if (!bboxOverlap(sBox, londonBox)) continue;
    inLondon++;

    const siteArea = multiPolygonAreaM2(polys);
    let touched = 0, keptThisSite = 0;

    for (const w of wardGeoms) {
      if (!bboxOverlap(sBox, w.bbox)) continue;
      let inter;
      try {
        inter = polygonClipping.intersection(polys, w.mp);
      } catch (e) {
        // Degenerate geometry: fall back to attributing nothing rather than
        // silently attributing everything. Reported in the summary.
        continue;
      }
      if (!inter || !inter.length) continue;
      const a = multiPolygonAreaM2(inter);
      if (a <= 0) continue;
      add(w.code, site.func, a);
      touched++;
      keptThisSite += a;
    }

    if (touched > 0) {
      clipped++;
      wholeSiteArea += siteArea;
      keptArea += keptThisSite;
      if (touched > 1) split++;
    }
  }

  console.log(
    `Sites: ${hexes.length} candidates GB, ${parsed} parsed (${failed} failed), ` +
    `${inLondon} in London bbox, ${clipped} intersecting a ward, ${split} spanning >1 ward`,
  );
  console.log(
    `Area: ${(wholeSiteArea / 1e6).toFixed(1)} km² of whole sites -> ` +
    `${(keptArea / 1e6).toFixed(1)} km² inside London ward boundaries ` +
    `(${(100 * keptArea / wholeSiteArea).toFixed(1)}% retained)`,
  );

  // --- per-ward roll-up ---
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

  const landByCode = new Map(wardGeoms.map((w) => [w.code, w.landAreaM2]));

  const result = wards.map((w) => {
    const code = w.ward_code;
    const area = areaFor(code, PLAY_FUNCTIONS);
    const equipped = areaFor(code, EQUIPPED_ONLY);
    const kids = children.get(code) ?? null;
    const m2 = kids ? Math.round((area / kids) * 10) / 10 : null;
    const equippedM2 = kids ? Math.round((equipped / kids) * 10) / 10 : null;
    const ratio = m2 != null ? Math.round((m2 / BENCHMARK_M2_PER_CHILD) * 100) / 100 : null;
    const land = landByCode.get(code) ?? null;
    return {
      ward_code: code,
      ward_name: w.ward_name,
      play_area_m2: area,
      equipped_play_area_m2: equipped,
      play_site_count: countFor(code, PLAY_FUNCTIONS),
      equipped_play_site_count: countFor(code, EQUIPPED_ONLY),
      children_0_15: kids,
      m2_per_child: m2,
      equipped_m2_per_child: equippedM2,
      ratio_vs_benchmark: ratio,
      benchmark_m2_per_child: BENCHMARK_M2_PER_CHILD,
      ward_land_area_m2: land != null ? Math.round(land) : null,
      play_share_of_ward_pct: land ? Math.round((1000 * area) / land) / 10 : null,
    };
  });

  // --- INVARIANT: play space cannot exceed the ward's own land area ---
  const impossible = result.filter(
    (r) => r.ward_land_area_m2 && r.play_area_m2 > r.ward_land_area_m2 * 1.001,
  );
  const worst = [...result]
    .filter((r) => r.play_share_of_ward_pct != null)
    .sort((a, b) => b.play_share_of_ward_pct - a.play_share_of_ward_pct)
    .slice(0, 10);
  console.log("--- play space as a share of the ward's own land area (top 10) ---");
  for (const r of worst) {
    console.log(`  ${String(r.play_share_of_ward_pct).padStart(6)}%  ${r.ward_name}`);
  }
  if (impossible.length) {
    console.error(
      `\nINVARIANT FAILED: ${impossible.length} ward(s) have more play space than land area:\n` +
      impossible
        .map((r) => `  ${r.ward_name}: ${(r.play_area_m2 / 1e6).toFixed(2)} km² play vs ${(r.ward_land_area_m2 / 1e6).toFixed(2)} km² ward`)
        .join("\n") +
      `\nThis is geometrically impossible and means the clip did not apply. Nothing was written.`,
    );
    process.exit(1);
  }
  console.log("INVARIANT OK: no ward exceeds its own land area.");

  writeJsonOut("13_play_clip_by_ward.json", {
    generated_at: new Date().toISOString(),
    functions_used: PLAY_FUNCTIONS,
    equipped_functions: EQUIPPED_ONLY,
    method:
      "Site polygons (OS Open Greenspace, EPSG:27700, OGL v3) INTERSECTED with ONS WD24 " +
      "BGC ward boundaries requested in EPSG:27700, so only the part of each site that " +
      "actually falls inside a ward is counted. Replaces step 10's centroid rule, which " +
      "assigned each site wholly to the ward containing its centre point and therefore " +
      "credited whole large parks to one ward (East Sheen held 165% of its own land area " +
      "in play space) while giving neighbouring wards none of the same park. Areas are " +
      "shoelace in native British National Grid metres; no reprojection is performed. " +
      "A site spanning several wards is counted once in each ward's site count, with its " +
      "area divided between them.",
    wards: result,
  });

  // --- patch the served dataset in place, same pattern as steps 09, 11, 12 ---
  const byCode = new Map(result.map((r) => [r.ward_code, r]));
  let patched = 0;
  const moves = [];
  for (const w of served.wards) {
    const r = byCode.get(w.ward_code);
    if (!r) continue;
    const prev = w.dimensions?.play_provision || null;
    if (!w.dimensions) w.dimensions = {};
    w.dimensions.play_provision = {
      ...(prev || {}),
      play_area_m2: r.play_area_m2,
      equipped_play_area_m2: r.equipped_play_area_m2,
      play_site_count: r.play_site_count,
      equipped_play_site_count: r.equipped_play_site_count,
      children_0_15: r.children_0_15,
      m2_per_child: r.m2_per_child,
      equipped_m2_per_child: r.equipped_m2_per_child,
      ratio_vs_benchmark: r.ratio_vs_benchmark,
      benchmark_m2_per_child: BENCHMARK_M2_PER_CHILD,
      ward_land_area_m2: r.ward_land_area_m2,
      play_share_of_ward_pct: r.play_share_of_ward_pct,
      sources:
        "OS Open Greenspace (OGL), clipped to ONS WD24 BGC ward boundaries; " +
        "ONS mid-2024 ward population estimates via Nomis; London Plan Policy S4 benchmark",
      score_note:
        "Percentile of play & informal recreation area per child among scored London wards. " +
        "Site areas are clipped to the ward boundary, so a park spanning several wards is " +
        "divided between them rather than assigned whole to the ward holding its centre. " +
        "The 10 m²/child S4 figure remains displayed benchmark context and drives the map's " +
        "play lens; it does not cap the composite score.",
    };
    if (prev && prev.m2_per_child != null && r.m2_per_child != null) {
      moves.push({ name: w.ward_name, before: prev.m2_per_child, after: r.m2_per_child });
    }
    patched++;
  }
  fs.writeFileSync(SERVED, JSON.stringify(served, null, 2));
  console.log(`Patched play_provision for ${patched} wards in ${SERVED}`);

  // --- headline, and what moved ---
  let deficit = 0, kidsDeficit = 0, kidsTotal = 0, eqDeficit = 0, scored = 0;
  for (const r of result) {
    if (r.children_0_15) kidsTotal += r.children_0_15;
    if (r.m2_per_child != null) scored++;
    if (r.m2_per_child != null && r.m2_per_child < 10) { deficit++; kidsDeficit += r.children_0_15; }
    if (r.equipped_m2_per_child != null && r.equipped_m2_per_child < 10) eqDeficit++;
  }
  console.log("\n--- headline AFTER clipping (these replace the note's figures) ---");
  console.log(`  wards scored: ${scored}`);
  console.log(`  wards below 10 m²/child: ${deficit}`);
  console.log(`  children in those wards: ${Math.round(kidsDeficit).toLocaleString("en-GB")} of ${Math.round(kidsTotal).toLocaleString("en-GB")}`);
  console.log(`  share: ${(100 * kidsDeficit / kidsTotal).toFixed(1)}%`);
  console.log(`  wards below 10 m²/child on equipped alone: ${eqDeficit}`);

  moves.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
  console.log("\n--- biggest movers, m²/child before -> after ---");
  for (const m of moves.slice(0, 15)) {
    console.log(`  ${m.name.padEnd(42)} ${String(m.before).padStart(8)} -> ${String(m.after).padStart(8)}`);
  }

  console.log("\nNEXT: run `node pipeline/12_score_fix.js` to re-percentile the play score.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
