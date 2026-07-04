// Step 7: qualitative "family fit" dimension (e.g. "people my age with kids") via ONS Census
// 2021, delivered through the Nomis API.
//
// Bulk strategy: TWO Nomis CSV downloads covering ALL of England & Wales's ~6,876 "2022 wards"
// in 1-2 requests each (anonymous cell limit is 25,000 rows/request, so household composition
// needs 2 pages):
//   - NM_2023_1 (Census 2021 TS003, household composition): total households + all "with
//     dependent children" categories, per ward.
//   - NM_2018_1 (Census 2021 TS007B, age by broad bands): total population + 25-34/35-49 bands,
//     per ward, as a proxy for "family-forming age" (no single "median age" field is exposed at
//     ward level, so we use these two bands rather than fabricate a median).
//
// Join: Nomis uses "2022 wards" (WD22CD) geography; our base wards are "2024 wards" (WD24CD).
// The overwhelming majority of ward codes are unchanged between the two boundary sets, so we
// join primarily by ward CODE, with a normalized-name fallback for any 2022->2024 boundary
// changes, and report anything still unmatched rather than guessing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvToObjects } from './lib/csv.js';
import { readJsonOut, writeJsonOut } from './lib/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function cachedNomisCsv(key, url) {
  const file = path.join(__dirname, 'cache', `${key}.csv`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  console.log(`[fetch] ${key} <- ${url.slice(0, 140)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nomis fetch failed: ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(file, text);
  return text;
}

function normalize(str) {
  return (str || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

async function main() {
  // --- Household composition (Census 2021 TS003), all England & Wales wards, paginated ---
  const hhBase = 'https://www.nomisweb.co.uk/api/v01/dataset/NM_2023_1.data.csv?geography=2092957699TYPE153&c2021_hhcomp_15=0,5,8,10,13&measures=20100&select=geography_code,geography_name,c2021_hhcomp_15_name,obs_value';
  const hhPage1 = await cachedNomisCsv('nomis_hhcomp_p1', hhBase);
  const hhPage2 = await cachedNomisCsv('nomis_hhcomp_p2', hhBase + '&recordoffset=25000');
  const hhRows = [...csvToObjects(hhPage1), ...csvToObjects(hhPage2)];
  console.log(`Household composition rows: ${hhRows.length}`);

  const totalHouseholds = new Map(); // WD22CD -> total
  const childHouseholds = new Map(); // WD22CD -> sum of "with dependent children" categories
  const wardNameByCode22 = new Map();
  for (const r of hhRows) {
    const code = r.GEOGRAPHY_CODE;
    wardNameByCode22.set(code, r.GEOGRAPHY_NAME);
    const val = Number(r.OBS_VALUE) || 0;
    if (r.C2021_HHCOMP_15_NAME.startsWith('Total')) {
      totalHouseholds.set(code, val);
    } else if (r.C2021_HHCOMP_15_NAME.includes('dependent children')) {
      childHouseholds.set(code, (childHouseholds.get(code) || 0) + val);
    }
  }

  // --- Age bands (Census 2021 TS007B), all England & Wales wards, single request ---
  const ageUrl = 'https://www.nomisweb.co.uk/api/v01/dataset/NM_2018_1.data.csv?geography=2092957699TYPE153&c2021_age_12a=0,6,7&measures=20100&select=geography_code,geography_name,c2021_age_12a_name,obs_value';
  const ageCsv = await cachedNomisCsv('nomis_age_bands', ageUrl);
  const ageRows = csvToObjects(ageCsv);
  console.log(`Age band rows: ${ageRows.length}`);

  const totalPop = new Map();
  const familyAgePop = new Map(); // 25-34 + 35-49
  for (const r of ageRows) {
    const code = r.GEOGRAPHY_CODE;
    const val = Number(r.OBS_VALUE) || 0;
    if (r.C2021_AGE_12A_NAME === 'Total') totalPop.set(code, val);
    else familyAgePop.set(code, (familyAgePop.get(code) || 0) + val);
  }

  // --- Join to our WD24 base wards, primarily by code, falling back to normalized name ---
  const { wards } = readJsonOut('01_wards_base.json');
  const nameIndex = new Map();
  for (const [code22, name22] of wardNameByCode22) {
    nameIndex.set(normalize(name22), code22);
  }

  let matchedByCode = 0, matchedByName = 0, unmatched = 0;
  const unmatchedList = [];

  const result = wards.map((w) => {
    let code22 = totalHouseholds.has(w.ward_code) ? w.ward_code : null;
    if (code22) matchedByCode++;
    if (!code22) {
      const byName = nameIndex.get(normalize(w.ward_name));
      if (byName) { code22 = byName; matchedByName++; }
    }
    if (!code22) {
      unmatched++;
      unmatchedList.push(w.ward_name);
      return {
        ward_code: w.ward_code,
        ward_name: w.ward_name,
        pct_households_with_dependent_children: null,
        pct_population_family_forming_age: null,
        total_households: null,
        total_population: null
      };
    }
    const totalHh = totalHouseholds.get(code22) || 0;
    const childHh = childHouseholds.get(code22) || 0;
    const pop = totalPop.get(code22) || 0;
    const famAgePop = familyAgePop.get(code22) || 0;
    return {
      ward_code: w.ward_code,
      ward_name: w.ward_name,
      pct_households_with_dependent_children: totalHh ? Math.round((childHh / totalHh) * 1000) / 10 : null,
      pct_population_family_forming_age: pop ? Math.round((famAgePop / pop) * 1000) / 10 : null,
      total_households: totalHh || null,
      total_population: pop || null
    };
  });

  console.log(`Matched by ward code (WD22CD==WD24CD): ${matchedByCode}, by normalized name: ${matchedByName}, unmatched: ${unmatched}`);
  if (unmatchedList.length) console.log('Unmatched wards (likely 2022->2024 boundary changes):', unmatchedList.slice(0, 20));

  writeJsonOut('07_family_fit_by_ward.json', {
    generated_at: new Date().toISOString(),
    source: 'ONS Census 2021 via Nomis API: TS003 household composition (NM_2023_1) and TS007B age bands (NM_2018_1), both at "2022 wards" (WD22CD) geography. Joined to WD24 wards by ward code, with normalized-name fallback for boundary changes between 2022 and 2024; unmatched wards (new/renamed since 2022) are left null rather than estimated.',
    match_stats: { matchedByCode, matchedByName, unmatched },
    wards: result
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
