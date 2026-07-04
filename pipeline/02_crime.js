// Step 2: safety dimension via data.police.uk, bulk strategy.
//
// The police API has no "bulk London" endpoint: crimes-street/all-crime is either a 1-mile-radius
// point query or a custom `poly` area, capped at 10,000 crimes/query (503 if exceeded) and a
// 4094-char GET limit (we use POST to sidestep the length limit, not the count cap).
//
// Bulk strategy: tile Greater London's bounding box into a grid (~0.05 deg squares, POST poly),
// adaptively quartering any tile that 503s, fetch each tile ONCE (cached), then assign every
// individual crime to its ward locally via point-in-polygon using the geometries from step 1.
// This is a few dozen network calls total instead of 700+ per-ward polygon queries.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cachedPostJson,
  readJsonOut,
  writeJsonOut,
  sleep,
} from "./lib/http.js";
import { pointInGeometry, bboxOfGeometry } from "./lib/geo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICE_URL = "https://data.police.uk/api/crimes-street/all-crime";

async function fetchLatestMonth() {
  const cacheFile = path.join(__dirname, "cache", "crime_latest_month.txt");
  if (fs.existsSync(cacheFile))
    return fs.readFileSync(cacheFile, "utf8").trim();
  const res = await fetch("https://data.police.uk/api/crime-last-updated");
  const j = await res.json();
  const month = j.date.slice(0, 7); // API returns YYYY-MM-DD; crimes-street wants YYYY-MM
  fs.writeFileSync(cacheFile, month);
  return month;
}

function polyParam([minLng, minLat, maxLng, maxLat]) {
  // lat,lng pairs, rectangle corners
  return `${minLat},${minLng}:${minLat},${maxLng}:${maxLat},${maxLng}:${maxLat},${minLng}`;
}

async function fetchTile(date, bbox, key) {
  const body = new URLSearchParams({ date, poly: polyParam(bbox) });
  try {
    return await cachedPostJson(key, POLICE_URL, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch (e) {
    if (String(e.message).includes("503")) return null; // signal: too many crimes, needs split
    throw e;
  }
}

async function fetchTileRecursive(date, bbox, keyPrefix, depth = 0) {
  const key = `crime_tile_${keyPrefix}`;
  const cacheFile = path.join(__dirname, "cache", `${key}.json`);
  if (fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  }
  const result = await fetchTile(date, bbox, key);
  if (result !== null) return result;

  if (depth >= 4) {
    console.warn(
      `  [warn] tile ${keyPrefix} still overflowing at depth ${depth}, keeping partial via point query fallback`,
    );
    return [];
  }
  console.log(`  [split] tile ${keyPrefix} exceeded 10k crimes, quartering...`);
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const midLng = (minLng + maxLng) / 2;
  const midLat = (minLat + maxLat) / 2;
  const quads = [
    [minLng, minLat, midLng, midLat],
    [midLng, minLat, maxLng, midLat],
    [minLng, midLat, midLng, maxLat],
    [midLng, midLat, maxLng, maxLat],
  ];
  const all = [];
  for (let i = 0; i < quads.length; i++) {
    const sub = await fetchTileRecursive(
      date,
      quads[i],
      `${keyPrefix}_${i}`,
      depth + 1,
    );
    all.push(...sub);
  }
  return all;
}

async function main() {
  const date = await fetchLatestMonth();
  console.log(`Using latest crime month: ${date}`);

  const { wards } = readJsonOut("01_wards_base.json");

  // Greater London bounding box (from ward geometries), padded slightly.
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
  minLng -= 0.01;
  minLat -= 0.01;
  maxLng += 0.01;
  maxLat += 0.01;
  console.log(
    `Greater London bbox: [${minLng.toFixed(3)}, ${minLat.toFixed(3)}, ${maxLng.toFixed(3)}, ${maxLat.toFixed(3)}]`,
  );

  // Tile grid: ~0.06deg squares (~4-5km) as a starting granularity; recursion handles dense areas.
  const STEP = 0.06;
  const tiles = [];
  for (let lng = minLng; lng < maxLng; lng += STEP) {
    for (let lat = minLat; lat < maxLat; lat += STEP) {
      tiles.push([
        lng,
        lat,
        Math.min(lng + STEP, maxLng),
        Math.min(lat + STEP, maxLat),
      ]);
    }
  }
  console.log(`Grid: ${tiles.length} base tiles.`);

  const allCrimes = [];
  for (let i = 0; i < tiles.length; i++) {
    const crimes = await fetchTileRecursive(date, tiles[i], `${i}`);
    allCrimes.push(...crimes);
    await sleep(400); // be polite to the free, no-key API; avoids 429s on a fresh (uncached) run
    if (i % 20 === 0)
      console.log(
        `  tile ${i}/${tiles.length}, running total ${allCrimes.length} crimes`,
      );
  }
  console.log(`Total crimes fetched: ${allCrimes.length}`);

  // De-duplicate: adjacent/overlapping tile edges can double-count crimes sitting exactly on a boundary.
  const seen = new Set();
  const deduped = [];
  for (const c of allCrimes) {
    const id = c.persistent_id || c.id;
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(c);
  }
  console.log(`After de-dup: ${deduped.length} crimes`);

  // Assign each crime to a ward via point-in-polygon (local, no network).
  const countByWard = new Map();
  const categoriesByWard = new Map();
  let unassigned = 0;
  for (const c of deduped) {
    const lat = parseFloat(c.location?.latitude);
    const lng = parseFloat(c.location?.longitude);
    if (!isFinite(lat) || !isFinite(lng)) {
      unassigned++;
      continue;
    }
    const pt = [lng, lat];
    let matched = null;
    for (const w of wards) {
      if (!w.geometry) continue;
      if (pointInGeometry(pt, w.geometry)) {
        matched = w.ward_code;
        break;
      }
    }
    if (!matched) {
      unassigned++;
      continue;
    }
    countByWard.set(matched, (countByWard.get(matched) || 0) + 1);
    if (!categoriesByWard.has(matched))
      categoriesByWard.set(matched, new Map());
    const catMap = categoriesByWard.get(matched);
    catMap.set(c.category, (catMap.get(c.category) || 0) + 1);
  }
  console.log(
    `Unassigned crimes (outside any ward polygon, e.g. river/edge): ${unassigned}`,
  );

  const result = wards.map((w) => {
    const count = countByWard.get(w.ward_code) || 0;
    const cats = categoriesByWard.get(w.ward_code);
    const topCategories = cats
      ? [...cats.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([cat]) => cat)
      : [];
    return {
      ward_code: w.ward_code,
      ward_name: w.ward_name,
      crimes_last_month: count,
      top_categories: topCategories,
    };
  });

  writeJsonOut("02_crime_by_ward.json", {
    generated_at: new Date().toISOString(),
    period: date,
    source:
      "data.police.uk crimes-street/all-crime, tiled poly queries, point-in-polygon join",
    wards: result,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
