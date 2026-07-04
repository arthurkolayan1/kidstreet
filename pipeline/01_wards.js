// Step 1: resolve every London ward to {ward_code, ward_name, borough, geometry, centroid}.
//
// Bulk strategy (2 network calls total, not one per ward):
//   1. WD24_LAD24_UK_LU lookup table, filtered to the 33 London LAD names -> ward codes + borough.
//   2. Ward boundary polygons, fetched in chunks of ~100 codes via POST (avoids URL-length limits),
//      then centroid computed locally.
import { cachedPostJson, writeJsonOut } from './lib/http.js';
import { centroidOfGeometry } from './lib/geo.js';
import { LONDON_BOROUGHS } from './lib/boroughs.js';

const LOOKUP_URL = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/WD24_LAD24_UK_LU/FeatureServer/0/query';
const BOUNDARY_URL = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Wards_May_2024_Boundaries_UK_BSC/FeatureServer/0/query';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const boroughList = LONDON_BOROUGHS.map((b) => `'${b.replace(/'/g, "''")}'`).join(',');
  const lookupBody = new URLSearchParams({
    where: `LAD24NM IN (${boroughList})`,
    outFields: 'WD24CD,WD24NM,LAD24CD,LAD24NM',
    resultRecordCount: '2000',
    f: 'json'
  });
  const lookup = await cachedPostJson(
    'ward_lad_lookup',
    LOOKUP_URL,
    lookupBody.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const wardMeta = new Map();
  for (const f of lookup.features) {
    const a = f.attributes;
    wardMeta.set(a.WD24CD, { ward_code: a.WD24CD, ward_name: a.WD24NM, borough: a.LAD24NM });
  }
  console.log(`Resolved ${wardMeta.size} London wards across ${LONDON_BOROUGHS.length} boroughs.`);

  // Fetch boundary polygons in chunks so we get geometry -> centroid without one call per ward.
  const codes = [...wardMeta.keys()];
  const chunks = chunk(codes, 100);
  const geomByCode = new Map();

  for (let i = 0; i < chunks.length; i++) {
    const codeList = chunks[i].map((c) => `'${c}'`).join(',');
    const body = new URLSearchParams({
      where: `WD24CD IN (${codeList})`,
      outFields: 'WD24CD,WD24NM',
      outSR: '4326',
      f: 'geojson'
    });
    const geo = await cachedPostJson(
      `ward_boundaries_chunk_${i}`,
      BOUNDARY_URL,
      body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    for (const feature of geo.features || []) {
      geomByCode.set(feature.properties.WD24CD, feature.geometry);
    }
  }
  console.log(`Fetched boundary geometry for ${geomByCode.size}/${wardMeta.size} wards.`);

  const wards = [];
  for (const [code, meta] of wardMeta) {
    const geometry = geomByCode.get(code) || null;
    const centroid = geometry ? centroidOfGeometry(geometry) : null;
    wards.push({ ...meta, centroid, geometry });
    if (!geometry) console.warn(`  [warn] no geometry for ${meta.ward_name} (${code})`);
  }

  writeJsonOut('01_wards_base.json', { generated_at: new Date().toISOString(), count: wards.length, wards });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
