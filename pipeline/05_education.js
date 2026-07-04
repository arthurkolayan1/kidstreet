// Step 5: education dimension via Ofsted's official "State-funded schools inspections and
// outcomes" statistics CSV (gov.uk / Ofsted, most recent as at 31 Aug 2025) + postcodes.io.
//
// Bulk strategy:
//   1. Download the ~22k-row national CSV ONCE, filter locally to the 33 London LAs (~2.5k rows).
//   2. Batch-geocode postcodes via postcodes.io's bulk endpoint (100 postcodes/call) which
//      returns `admin_ward` (the WD24 ward name) directly — no per-school ward lookup needed,
//      and no need to reverse-geocode against ward polygons for this dimension.
//   3. Aggregate Ofsted "Overall effectiveness" (1=Outstanding..4=Inadequate, 9/blank=not graded)
//      per ward.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvToObjects } from './lib/csv.js';
import { readJsonOut, writeJsonOut, cachedPostJson, sleep } from './lib/http.js';
import { LONDON_BOROUGHS } from './lib/boroughs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OFSTED_CSV_URL = 'https://assets.publishing.service.gov.uk/media/691ee0612a687551bd8153da/State-funded_schools_inspections_and_outcomes_as_at_31_August_2025.csv';

const OFSTED_LABELS = { '1': 'Outstanding', '2': 'Good', '3': 'Requires improvement', '4': 'Inadequate' };

async function downloadOfstedCsv() {
  const file = path.join(__dirname, 'cache', 'ofsted_raw.csv');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  console.log('[fetch] Ofsted national CSV (~17MB)...');
  const res = await fetch(OFSTED_CSV_URL);
  if (!res.ok) throw new Error(`Ofsted CSV download failed: ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(file, text);
  return text;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function batchGeocode(postcodes) {
  // postcodes.io bulk lookup, cached per-chunk so re-runs are instant.
  const chunks = chunk([...new Set(postcodes)], 100);
  const wardByPostcode = new Map();
  for (let i = 0; i < chunks.length; i++) {
    const key = `postcodesio_chunk_${i}_${chunks.length}`;
    const result = await cachedPostJson(
      key,
      'https://api.postcodes.io/postcodes',
      { postcodes: chunks[i] }
    );
    for (const r of result.result) {
      if (r.result) {
        wardByPostcode.set(r.query, { ward_name: r.result.admin_ward, ward_code: r.result.codes?.admin_ward });
      }
    }
    await sleep(150);
  }
  return wardByPostcode;
}

async function main() {
  const csvText = await downloadOfstedCsv();
  const rows = csvToObjects(csvText);
  console.log(`Ofsted CSV rows: ${rows.length}`);

  const londonSet = new Set(LONDON_BOROUGHS);
  const londonRows = rows.filter((r) => londonSet.has(r['Local authority']));
  console.log(`London rows: ${londonRows.length}`);

  const postcodes = londonRows.map((r) => r.Postcode).filter((p) => p && p !== 'NULL');
  console.log(`Geocoding ${new Set(postcodes).size} unique postcodes via postcodes.io bulk lookup...`);
  const wardByPostcode = await batchGeocode(postcodes);
  console.log(`Resolved ${wardByPostcode.size} postcodes to wards.`);

  const { wards } = readJsonOut('01_wards_base.json');
  const wardsByCode = new Map(wards.map((w) => [w.ward_code, w]));

  const schoolsByWard = new Map(); // ward_code -> [{name, phase, ofsted}]

  let unmatched = 0;
  for (const r of londonRows) {
    const loc = wardByPostcode.get(r.Postcode);
    if (!loc || !loc.ward_code || !wardsByCode.has(loc.ward_code)) { unmatched++; continue; }
    const effCode = r['Overall effectiveness'];
    const ofsted = OFSTED_LABELS[effCode] || null;
    if (!schoolsByWard.has(loc.ward_code)) schoolsByWard.set(loc.ward_code, []);
    schoolsByWard.get(loc.ward_code).push({
      name: r['School name'],
      phase: r['Ofsted phase'],
      ofsted
    });
  }
  console.log(`Schools unmatched to a ward: ${unmatched}`);

  const result = wards.map((w) => {
    const schools = schoolsByWard.get(w.ward_code) || [];
    const graded = schools.filter((s) => s.ofsted);
    const goodOrBetter = graded.filter((s) => s.ofsted === 'Outstanding' || s.ofsted === 'Good');
    const pctGoodOrOutstanding = graded.length ? Math.round((goodOrBetter.length / graded.length) * 100) : null;
    return {
      ward_code: w.ward_code,
      ward_name: w.ward_name,
      school_count: schools.length,
      pct_good_or_outstanding: pctGoodOrOutstanding,
      schools: schools.slice(0, 10) // cap for payload size; still enough for the agent to cite by name
    };
  });

  writeJsonOut('05_education_by_ward.json', {
    generated_at: new Date().toISOString(),
    source: 'Ofsted "State-funded schools inspections and outcomes as at 31 August 2025" (gov.uk/Ofsted), postcode -> ward via postcodes.io admin_ward.',
    wards: result
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
