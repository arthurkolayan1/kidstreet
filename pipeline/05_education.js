// Step 5: education dimension via Ofsted's official "State-funded schools inspections and
// outcomes" statistics CSV (gov.uk / Ofsted, most recent as at 31 Aug 2025) + postcodes.io.
//
// Bulk strategy:
//   1. Download the ~22k-row national CSV ONCE, filter locally to the 33 London LAs (~2.5k rows).
//   2. Batch-geocode postcodes via postcodes.io's bulk endpoint (100 postcodes/call) which
//      returns `admin_ward` (the WD24 ward name) directly — no per-school ward lookup needed,
//      and no need to reverse-geocode against ward polygons for this dimension.
//   3. Aggregate Ofsted "Overall effectiveness" (1=Outstanding..4=Inadequate, 9/blank=not graded)
//      per ward, falling back to "Quality of education" where overall effectiveness is absent.
//
// WHY THE FALLBACK (added 2026-08-19). From 1 September 2024 Ofsted stopped issuing an
// overall effectiveness judgement for state-funded schools. The "Most recent inspections"
// dataset records those schools as "Not judged", so a school inspected in, say, March 2025
// carries no overall grade even though it was inspected recently and graded on the four key
// judgements. Reading overall effectiveness alone therefore PUNISHES RECENCY: 330 of 2,559
// London school entries came back ungraded, across 262 wards, and in 11 wards no school had
// a grade at all so education could not be scored.
//
// The fix uses the "Quality of education" judgement, which is the closest analogue to the
// retired overall effectiveness grade and is present for graded inspections from September
// 2024 onward. This is Ofsted's own approach: their "state-funded schools inspections and
// outcomes as at 31 March 2026" main findings state that for schools inspected in 2024/25,
// which have no overall effectiveness grade, they use the quality of education grade.
//   https://www.gov.uk/government/statistics/state-funded-schools-inspections-and-outcomes-as-at-31-march-2026/main-findings-state-funded-schools-inspections-and-outcomes-as-at-31-march-2026
//
// Each school records `grade_basis`: "overall effectiveness" or "quality of education", so
// the substitution is visible in the published data rather than hidden in the average.
//
// KNOWN LIMIT, declare it: Ofsted's own methodology notes that quality of education was
// introduced with the 2019 framework and is not comparable with pre-2019 judgements, and
// the November 2025 report cards use a different scale again. When the first report-card
// file lands, this mapping needs a third case.
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
    // Overall effectiveness first; quality of education where it is absent (see header note).
    // Ofsted writes "Not judged" for post-Sept-2024 graded inspections, and 9/blank/NULL
    // elsewhere, so anything outside the 1-4 label map counts as absent.
    const overall = OFSTED_LABELS[String(r['Overall effectiveness'] ?? '').trim()] || null;
    const quality = OFSTED_LABELS[String(r['Quality of education'] ?? '').trim()] || null;
    const ofsted = overall || quality;
    if (!schoolsByWard.has(loc.ward_code)) schoolsByWard.set(loc.ward_code, []);
    schoolsByWard.get(loc.ward_code).push({
      name: r['School name'],
      phase: r['Ofsted phase'],
      ofsted,
      grade_basis: overall
        ? 'overall effectiveness'
        : quality
          ? 'quality of education'
          : null,
      inspection_date: r['Inspection start date'] || null
    });
  }
  console.log(`Schools unmatched to a ward: ${unmatched}`);

  // Report the substitution loudly: if this number ever collapses to 0 the column name has
  // changed and the fallback has silently stopped working.
  const allSchools = [...schoolsByWard.values()].flat();
  const viaQuality = allSchools.filter((s) => s.grade_basis === 'quality of education').length;
  const stillNull = allSchools.filter((s) => !s.ofsted).length;
  console.log(
    `Grades: ${allSchools.length} schools, ${allSchools.filter((s) => s.grade_basis === 'overall effectiveness').length} on overall effectiveness, ${viaQuality} on quality of education, ${stillNull} with neither.`,
  );
  if (viaQuality === 0) {
    console.warn(
      '  WARNING: no school fell back to quality of education. Check the "Quality of education" column name in the source CSV.',
    );
  }

  const result = wards.map((w) => {
    const schools = schoolsByWard.get(w.ward_code) || [];
    const graded = schools.filter((s) => s.ofsted);
    const goodOrBetter = graded.filter((s) => s.ofsted === 'Outstanding' || s.ofsted === 'Good');
    const pctGoodOrOutstanding = graded.length ? Math.round((goodOrBetter.length / graded.length) * 100) : null;
    return {
      ward_code: w.ward_code,
      ward_name: w.ward_name,
      school_count: schools.length,
      rated_school_count: graded.length,
      quality_of_education_fallback_count: graded.filter(
        (s) => s.grade_basis === 'quality of education',
      ).length,
      pct_good_or_outstanding: pctGoodOrOutstanding,
      schools: schools.slice(0, 10) // cap for payload size; still enough for the agent to cite by name
    };
  });

  writeJsonOut('05_education_by_ward.json', {
    generated_at: new Date().toISOString(),
    source: 'Ofsted "State-funded schools inspections and outcomes as at 31 August 2025" (gov.uk/Ofsted), postcode -> ward via postcodes.io admin_ward. Grade = Overall effectiveness, or Quality of education where Ofsted issued no overall effectiveness judgement (inspections from 1 September 2024); grade_basis records which was used, following Ofsted\'s own approach in their 31 March 2026 main findings.',
    wards: result
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
