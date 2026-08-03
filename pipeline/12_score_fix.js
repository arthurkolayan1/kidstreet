// Step 12: scoring fix — replaces the in-dimension scoring for five dimensions in the
// SERVED dataset (public/data/wards.json), in place, same pattern as steps 9 and 11.
//
// Why this exists (diagnosed 2026-08-03 against the served June-2026 build):
//   1. SATURATION. Education scored 100 for 91.6% of scored wards and play for 81.1%
//      (the S4 10 m²/child benchmark is met almost everywhere), so 28 of the 100
//      composite weight points were near-constant and the table was really decided by
//      the other five dimensions with their weights silently renormalised.
//   2. FAMILY FIT measured the wrong thing: raw = hh-with-children% + aged-25-49%
//      summed on raw scales, and the age term (range ~30-52) numerically swamped the
//      children term (~13-16), so the score rewarded new-build young-professional
//      density rather than families.
//   3. TRANSPORT per km² punished wards that are large BECAUSE of parkland (Ham:
//      44 bus stops, 5 adjacent stations, score 4 — Richmond Park inflated the
//      denominator), structurally anti-correlating transport with green space.
//   4. SAFETY per km² cut the same area coin the other way: empty parkland dilutes
//      crime density, flattering big wards and flattening dense ones.
//
// The fix, per dimension (weights are UNCHANGED — this is in-dimension scoring only):
//   play      = percentile of m²/child among scored wards (0 = least play space per
//               child in London, 100 = most). The S4 benchmark fields are kept for
//               display and the map's play lens is untouched.
//   family    = percentile of pct_households_with_dependent_children ONLY. The
//               25-49 age share stays on the card as context but no longer scores.
//   transport = percentile of station access WITHOUT the area division:
//               raw = stations in ward + 0.5 × stations one ward over + bus stops / 20
//               (a station counts 20× a bus stop; next-door stations count half),
//               +5 step-free bonus as before, capped at 100.
//   safety    = percentile of street crimes per 1,000 residents, inverted (score =
//               share of London wards with MORE crime per resident — so the score
//               itself reads as "safer than N% of London wards"). Population is
//               Census 2021 total_population from out/07_family_fit_by_ward.json.
//               Wards with no published population (mostly City of London) keep
//               their previous score, declared in dimensions.safety.method.
//   education = average Ofsted grade of the ward's rated schools, mapped linearly
//               (Outstanding 100, Good 66.7, Requires improvement 33.3, Inadequate 0)
//               and rounded. Not a percentile: the raw average is already meaningful
//               and a percentile of a lumpy discrete variable is unstable. Unrated
//               schools are excluded; wards with no rated school score null (the
//               Worker renormalises nulls out of the composite, as before).
//   green_space and planning are unchanged (both discriminate fine as-is).
//
// Percentile definition used everywhere here: score = round(100 × wards strictly
// below this ward / (scored wards − 1)). Ties share a score; best ward = 100,
// worst = 0. Plain-words version for the site: "where this ward stands among all
// London wards we could score".
//
// Also writes dimensions.safety.crimes_per_1000 + population_2021 so the Worker
// can caption safety comparatively ("fewer street crimes per resident than N% of
// London wards") instead of the old "mostly violent crime and anti-social
// behaviour", which was true of 538 of 704 wards and therefore said nothing.
//
// Ends with a saturation report: if any scored dimension has more than a third of
// wards on a single value, it prints a loud warning — the failure mode this whole
// step exists to prevent should never come back silently.
//
// Usage:
//   node pipeline/12_score_fix.js           # patches public/data/wards.json in place
//   node pipeline/12_score_fix.js --dry     # report only, no write
//
// Reads:  public/data/wards.json, pipeline/out/07_family_fit_by_ward.json
// Writes: public/data/wards.json (scores.* + dimensions.* noted above)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVED = path.join(__dirname, "..", "public", "data", "wards.json");
const FAMILY_OUT = path.join(__dirname, "out", "07_family_fit_by_ward.json");
const DRY = process.argv.includes("--dry");

// --- percentile scoring: share of scored wards strictly below, 0-100 ---
function percentileScores(rawByCode, { invert = false } = {}) {
  const entries = [...rawByCode.entries()].filter(
    ([, v]) => v != null && isFinite(v),
  );
  const values = entries.map(([, v]) => v).sort((a, b) => a - b);
  const n = values.length;
  const scored = new Map();
  for (const [code, v] of rawByCode) {
    if (v == null || !isFinite(v)) {
      scored.set(code, null);
      continue;
    }
    // count strictly below via binary search (lower bound)
    let lo = 0,
      hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    let pct = n > 1 ? (lo / (n - 1)) * 100 : 50;
    if (invert) pct = 100 - pct;
    scored.set(code, Math.round(Math.max(0, Math.min(100, pct))));
  }
  return scored;
}

// Ofsted grade points, linear on the 4-point scale.
const OFSTED_POINTS = {
  Outstanding: 100,
  Good: 200 / 3,
  "Requires improvement": 100 / 3,
  Inadequate: 0,
};

function main() {
  const served = JSON.parse(fs.readFileSync(SERVED, "utf8"));
  const wards = Array.isArray(served.wards) ? served.wards : served;
  const family = JSON.parse(fs.readFileSync(FAMILY_OUT, "utf8")).wards;
  const popByCode = new Map(
    family.map((f) => [f.ward_code, f.total_population ?? null]),
  );
  const famByCode = new Map(family.map((f) => [f.ward_code, f]));

  // Refresh the served family_fit DISPLAY fields from the (re-run) step-07 output
  // before scoring, so a corrected TS003 sum flows through to both the card captions
  // and the percentile below. Without this, a re-run of 07 would change the score but
  // leave stale percentages on the cards.
  for (const w of wards) {
    const f = famByCode.get(w.ward_code);
    if (!f || !w.dimensions.family_fit) continue;
    const d = w.dimensions.family_fit;
    d.pct_households_with_dependent_children =
      f.pct_households_with_dependent_children;
    d.pct_population_family_forming_age = f.pct_population_family_forming_age;
    if (f.pct_households_with_dependent_children != null)
      d.summary = `${f.pct_households_with_dependent_children}% of households here have dependent children.`;
  }

  // --- raw values ---
  const playRaw = new Map();
  const famRaw = new Map();
  const trRaw = new Map();
  const safRaw = new Map();
  for (const w of wards) {
    const code = w.ward_code;
    playRaw.set(code, w.dimensions.play_provision?.m2_per_child ?? null);
    famRaw.set(
      code,
      w.dimensions.family_fit?.pct_households_with_dependent_children ?? null,
    );
    const t = w.dimensions.transport;
    trRaw.set(
      code,
      t
        ? (t.station_count || 0) +
            0.5 * (t.stations_in_adjacent_wards || 0) +
            (t.bus_stop_count || 0) / 20
        : null,
    );
    const crimes = w.dimensions.safety?.crimes_last_month;
    const pop = popByCode.get(code);
    safRaw.set(
      code,
      crimes != null && pop != null && pop > 0 ? (crimes / pop) * 1000 : null,
    );
  }

  const playScore = percentileScores(playRaw);
  const famScore = percentileScores(famRaw);
  const trScore = percentileScores(trRaw);
  const safScore = percentileScores(safRaw, { invert: true });

  // --- apply ---
  const before = new Map(
    wards.map((w) => [w.ward_code, { ...w.scores }]),
  );
  let changed = 0;
  for (const w of wards) {
    const code = w.ward_code;
    const s = w.scores;
    const d = w.dimensions;

    // play
    const p = playScore.get(code);
    if (d.play_provision) {
      s.play = p;
      d.play_provision.score = p;
      d.play_provision.score_note =
        "Percentile of play & informal recreation area per child among scored London wards. The 10 m²/child S4 figure remains as displayed benchmark context and drives the map's play lens; it no longer caps the composite score.";
    }

    // family
    const f = famScore.get(code);
    if (d.family_fit) {
      s.family_fit = f;
      d.family_fit.score = f;
      d.family_fit.score_note =
        "Percentile of the share of households with dependent children among scored London wards. The 25-49 age share is shown as context but not scored (on raw scales it numerically swamped the children share and measured young-adult density, not families).";
    }

    // transport
    const tRaw = trRaw.get(code);
    let t = trScore.get(code);
    if (t != null && d.transport?.step_free_in_or_adjacent) {
      t = Math.min(100, t + 5);
    }
    if (d.transport) {
      s.transport = t;
      d.transport.score = t;
      d.transport.access_note =
        "Access-based: stations in the ward + half-weight for stations one ward over + bus stops at 1/20 the weight of a station, percentile-ranked across London wards (no division by ward area — that penalised wards that are large because of parkland), +5 for a confirmed step-free station in or adjacent.";
      d.transport.access_raw = tRaw == null ? null : Math.round(tRaw * 100) / 100;
    }

    // safety
    const pop = popByCode.get(code);
    const crimes = d.safety?.crimes_last_month;
    const sf = safScore.get(code);
    if (d.safety) {
      if (sf != null) {
        s.safety = sf;
        d.safety.score = sf;
        d.safety.population_2021 = pop;
        d.safety.crimes_per_1000 =
          Math.round(((crimes / pop) * 1000) * 10) / 10;
        d.safety.method =
          "Street crimes per 1,000 residents (Census 2021 population), percentile-ranked and inverted: the score is the share of London wards with more crime per resident.";
      } else {
        d.safety.population_2021 = null;
        d.safety.crimes_per_1000 = null;
        d.safety.method =
          "No published ward-level population (City of London); previous area-density score retained.";
      }
    }

    // education
    if (d.education) {
      const rated = (d.education.schools || []).filter(
        (sc) => OFSTED_POINTS[sc.ofsted] != null,
      );
      if (rated.length) {
        const avg =
          rated.reduce((sum, sc) => sum + OFSTED_POINTS[sc.ofsted], 0) /
          rated.length;
        const e = Math.round(avg);
        s.education = e;
        d.education.score = e;
      } else {
        s.education = null;
        d.education.score = null;
      }
      d.education.rated_school_count = rated.length;
      d.education.score_note =
        "Average Ofsted grade of rated schools in the ward, mapped linearly (Outstanding 100, Good 67, Requires improvement 33, Inadequate 0). Replaces % Good-or-Outstanding, which scored 100 for 92% of wards and therefore ranked nothing.";
    }

    const prev = before.get(code);
    if (
      ["play", "family_fit", "transport", "safety", "education"].some(
        (k) => prev[k] !== s[k],
      )
    )
      changed++;
  }

  // --- reports ---
  console.log(`Wards with at least one changed score: ${changed}/${wards.length}`);
  for (const name of [
    "Evelyn",
    "Ham, Petersham & Richmond Riverside",
    "Royal Albert",
    "Roehampton",
    "East Sheen",
  ]) {
    const w = wards.find((x) => x.ward_name === name);
    if (w)
      console.log(
        `  ${name}: safety ${w.scores.safety}, education ${w.scores.education}, transport ${w.scores.transport}, family ${w.scores.family_fit}, play ${w.scores.play}`,
      );
  }

  // saturation check — the reason this file exists
  console.log("\nSaturation check (max share of scored wards on one value):");
  const dims = [
    "safety",
    "green_space",
    "transport",
    "education",
    "planning",
    "family_fit",
    "play",
  ];
  for (const dim of dims) {
    const counts = new Map();
    let n = 0;
    for (const w of wards) {
      const v = w.scores[dim];
      if (v == null) continue;
      n++;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const [modeVal, modeCount] = [...counts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];
    const share = (100 * modeCount) / n;
    const flag = share > 33 ? "  <-- WARNING: dimension is going flat" : "";
    console.log(
      `  ${dim}: mode ${modeVal} on ${modeCount}/${n} wards (${share.toFixed(1)}%)${flag}`,
    );
  }

  if (DRY) {
    console.log("\n--dry: no write.");
    return;
  }
  fs.writeFileSync(SERVED, JSON.stringify(served));
  console.log(`\nPatched in place -> ${SERVED}`);
}

main();
