// Step 15: re-score education in the SERVED dataset after the Ofsted grade fallback,
// without a full re-merge.
//
// Why this exists: public/data/wards.json is patched in place by steps 9 (transport),
// 11 (safety) and 12 (scoring fix), so re-running step 8 would clobber them. This step
// does for education what 11 does for safety: it reads a fresh
// pipeline/out/05_education_by_ward.json and edits the served file in place.
//
// What changed in step 05 (2026-08-19): Ofsted stopped issuing an overall effectiveness
// judgement from 1 September 2024, so a school inspected recently carries no overall grade
// and was being dropped from the average. 330 of 2,559 London school entries were affected,
// across 262 wards, and 11 wards had no graded school at all, which rendered as "the
// education score of null" on the live pages. Step 05 now falls back to the "Quality of
// education" judgement, which is Ofsted's own approach in their 31 March 2026 main findings.
//
// Usage (after a fresh Ofsted pull):
//   rm -f pipeline/cache/ofsted_raw.csv
//   node pipeline/05_education.js        # re-reads the CSV, applies the fallback
//   node pipeline/15_education_rescore.js
//   node pipeline/14_seo_pages.mjs       # regenerate the 763 pages (Cloudflare also does this)
//
// Then commit public/data/wards.json.
//
//   node pipeline/15_education_rescore.js --dry    # report only, no write
//
// The scoring maths is copied verbatim from 12_score_fix.js so a re-score is identical to
// what a full run would produce. If you change the mapping in 12, change it here too.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonOut } from "./lib/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVED = path.join(__dirname, "..", "public", "data", "wards.json");
const DRY = process.argv.includes("--dry");

const OFSTED_POINTS = {
  Outstanding: 100,
  Good: 200 / 3,
  "Requires improvement": 100 / 3,
  Inadequate: 0,
};

function main() {
  const fresh = readJsonOut("05_education_by_ward.json");
  const byCode = new Map(fresh.wards.map((w) => [w.ward_code, w]));

  const served = JSON.parse(fs.readFileSync(SERVED, "utf8"));

  let changed = 0;
  let nowScored = 0;
  let stillNull = 0;
  let viaQuality = 0;
  let missingFromFresh = 0;

  for (const w of served.wards) {
    const src = byCode.get(w.ward_code);
    if (!src) {
      missingFromFresh++;
      continue;
    }
    const d = (w.dimensions = w.dimensions || {});
    const e = (d.education = d.education || {});
    const wasScore = e.score ?? null;

    const schools = src.schools || [];
    e.schools = schools;
    e.school_count = src.school_count;
    e.pct_good_or_outstanding = src.pct_good_or_outstanding;

    const rated = schools.filter((sc) => OFSTED_POINTS[sc.ofsted] != null);
    const fallback = rated.filter(
      (sc) => sc.grade_basis === "quality of education",
    ).length;
    viaQuality += fallback;

    if (rated.length) {
      const avg =
        rated.reduce((sum, sc) => sum + OFSTED_POINTS[sc.ofsted], 0) /
        rated.length;
      const score = Math.round(avg);
      w.scores.education = score;
      e.score = score;
    } else {
      w.scores.education = null;
      e.score = null;
      stillNull++;
    }

    e.rated_school_count = rated.length;
    e.quality_of_education_fallback_count = fallback;
    e.score_note =
      "Average Ofsted grade of the ward's graded schools, mapped linearly (Outstanding 100, Good 67, Requires improvement 33, Inadequate 0). Where Ofsted issued no overall effectiveness judgement (inspections from 1 September 2024), the quality of education judgement is used instead and grade_basis records which applied. Ofsted use the same substitution in their own statistics.";

    if (wasScore === null && e.score !== null) nowScored++;
    if (wasScore !== e.score) changed++;
  }

  console.log(`Wards updated: ${changed} of ${served.wards.length}`);
  console.log(`Wards that were unscored and now have a score: ${nowScored}`);
  console.log(`Wards still unscored for education: ${stillNull}`);
  console.log(`School entries graded via quality of education: ${viaQuality}`);
  if (missingFromFresh) {
    console.log(
      `Ward codes absent from 05 output (left untouched): ${missingFromFresh}`,
    );
  }

  if (viaQuality === 0) {
    console.warn(
      "\nWARNING: no school used the quality of education fallback. Either step 05 was not re-run, or the source column name has changed. Not writing would be safer than writing a silent regression, so check before committing.",
    );
  }

  // Saturation guard, same spirit as step 12: education is the lumpiest dimension and the
  // fallback adds more schools to the average, so watch that it does not go flat.
  const counts = new Map();
  let n = 0;
  for (const w of served.wards) {
    const v = w.scores.education;
    if (v == null) continue;
    n++;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const [modeVal, modeCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const share = (100 * modeCount) / n;
  console.log(
    `education: mode ${modeVal} on ${modeCount}/${n} wards (${share.toFixed(1)}%)${
      share > 33 ? "  <-- WARNING: dimension is going flat" : ""
    }`,
  );

  if (DRY) {
    console.log("\n--dry: no write.");
    return;
  }
  served.metadata = served.metadata || {};
  served.metadata.scored_at = new Date().toISOString().slice(0, 10);
  if (served.metadata.sources) {
    served.metadata.sources.education =
      'Ofsted "State-funded schools inspections and outcomes as at 31 August 2025", schools geocoded to wards via postcodes.io admin_ward. Average grade of the ward\'s graded schools mapped linearly (Outstanding 100, Good 67, Requires improvement 33, Inadequate 0) and rounded. Grade = Overall effectiveness, or Quality of education where Ofsted issued no overall effectiveness judgement (all graded inspections from 1 September 2024); dimensions.education.schools[].grade_basis records which applied. Ofsted apply the same substitution in their 31 March 2026 main findings. Deliberately not a percentile: the variable is lumpy and discrete. Quality of education dates from the 2019 framework and is not comparable with pre-2019 judgements; the November 2025 report cards use a different scale again and will need a further mapping.';
  }
  fs.writeFileSync(SERVED, JSON.stringify(served));
  console.log(`\nPatched in place -> ${SERVED}`);
}

main();
