#!/usr/bin/env node
/**
 * 14_seo_pages.mjs — static, indexable pages for every London ward and borough.
 *
 * NOT a data step. This reads the FINAL public/data/wards.json and renders it as HTML,
 * so it must run after the last scoring step:
 *
 *   node pipeline/13_play_clip.js     # re-measures play by clipping polygons to wards
 *   node pipeline/12_score_fix.js     # re-percentiles; MUST run last of the data steps
 *   node pipeline/14_seo_pages.mjs    # <-- this file, renders the result as pages
 *
 * Re-run it after every data refresh, or the published pages will quote stale scores.
 *
 * Reads public/data/wards.json (the same file the map serves) and writes:
 *   public/areas/index.html                      London hub, links to 33 boroughs
 *   public/areas/<borough>/index.html            33 borough pages, links to every ward
 *   public/areas/<borough>/<ward>/index.html     704 ward pages
 *   public/sitemap.xml
 *   public/robots.txt
 *
 * Run from the repo root:  node pipeline/14_seo_pages.mjs
 * Safe to re-run: it overwrites its own output and touches nothing else.
 *
 * Composite weights MUST stay in sync with WEIGHTS in src/index.js.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "public", "data", "wards.json");
const OUT = path.join(ROOT, "public", "areas");
const SITE = "https://kidstreet.co.uk";

const WEIGHTS = {
  safety: 30,
  education: 20,
  transport: 15,
  green_space: 12,
  family_fit: 10,
  play: 8,
  planning: 5,
};

const DIM_LABEL = {
  safety: "Safety",
  education: "Schools",
  transport: "Transport",
  green_space: "Green space",
  family_fit: "Family presence",
  play: "Play space",
  planning: "Planned facilities",
};

// ---------------------------------------------------------------- helpers

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const dent = (s) => String(s ?? "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const composite = (s) => {
  let num = 0,
    den = 0;
  for (const [dim, w] of Object.entries(WEIGHTS)) {
    const v = s?.[dim];
    if (typeof v === "number" && isFinite(v)) {
      num += w * v;
      den += w;
    }
  }
  return den > 0 ? Math.round(num / den) : 0;
};

const artcl = (w) => (/^[aeiou]/i.test(w) ? "an " : "a ") + w;
const monthName = (p) => { if(!p || !/^\d{4}-\d{2}$/.test(p)) return p || "the latest month published"; const [y,m]=p.split("-"); return new Date(Date.UTC(+y,+m-1,1)).toLocaleDateString("en-GB",{month:"long",year:"numeric",timeZone:"UTC"}); };
const band = (v) =>
  v >= 75 ? "excellent" : v >= 65 ? "good" : v >= 50 ? "mixed" : v >= 35 ? "weak" : "poor";

// great-circle distance, km
const dist = (a, b) => {
  const R = 6371,
    r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r,
    dLng = (b.lng - a.lng) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const list = (arr) =>
  arr.length <= 1
    ? arr[0] || ""
    : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];

// ---------------------------------------------------------------- load

const raw = JSON.parse(fs.readFileSync(DATA, "utf8"));
const wards = Array.isArray(raw) ? raw : raw.wards || Object.values(raw)[0];

for (const w of wards) {
  w.composite = composite(w.scores);
  w.slug = slug(w.ward_name);
  w.boroughSlug = slug(w.borough);
  w.url = `/areas/${w.boroughSlug}/${w.slug}/`;
}
const ranked = [...wards].sort((a, b) => b.composite - a.composite);
ranked.forEach((w, i) => (w.rank = i + 1));
const N = wards.length;

const boroughs = {};
for (const w of wards) (boroughs[w.borough] ||= []).push(w);
const boroughList = Object.entries(boroughs)
  .map(([name, ws]) => ({
    name,
    slug: slug(name),
    wards: [...ws].sort((a, b) => b.composite - a.composite),
    mean: Math.round(ws.reduce((a, c) => a + c.composite, 0) / ws.length),
  }))
  .sort((a, b) => b.mean - a.mean);
boroughList.forEach((b, i) => (b.rank = i + 1));
const boroughRank = Object.fromEntries(boroughList.map((b) => [b.name, b]));

// neighbours: 6 nearest wards by centroid, any borough
for (const w of wards) {
  w.neighbours = wards
    .filter((o) => o !== w && o.centroid && w.centroid)
    .map((o) => ({ w: o, d: dist(w.centroid, o.centroid) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6)
    .map((x) => x.w);
}

// ---------------------------------------------------------------- shared chrome

const CSS = `:root{--ink:#16232e;--mut:#5b6b78;--line:#e2e8ed;--acc:#0b6ea8;--bg:#fbfcfd}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg)}
.wrap{max-width:760px;margin:0 auto;padding:24px 20px 72px}
a{color:var(--acc)}nav.bc{font-size:14px;color:var(--mut);margin-bottom:20px}nav.bc a{text-decoration:none}
h1{font-size:30px;line-height:1.2;margin:.2em 0 .1em}h2{font-size:21px;margin:2em 0 .5em}h3{font-size:17px;margin:1.6em 0 .4em}
.sub{color:var(--mut);margin:0 0 22px}
.hero{display:flex;align-items:baseline;gap:14px;border:1px solid var(--line);background:#fff;border-radius:10px;padding:16px 18px;margin:18px 0}
.big{font-size:40px;font-weight:700;line-height:1}
table{border-collapse:collapse;width:100%;font-size:15px;background:#fff}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}th{color:var(--mut);font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
ul.cols{columns:2;-webkit-columns:2;padding-left:18px}@media(max-width:560px){ul.cols{columns:1}}
.bar{display:inline-block;height:8px;border-radius:4px;background:var(--acc);vertical-align:middle}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);font-size:14px;color:var(--mut)}
.cta{display:inline-block;background:var(--acc);color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600}`;

function page({ title, desc, canonical, jsonld, body, breadcrumb }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}${canonical}">
<meta property="og:site_name" content="KidStreet">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg">
<style>${CSS}</style>
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join("\n")}
</head>
<body>
<div class="wrap">
<nav class="bc">${breadcrumb}</nav>
${body}
<footer>
<p>KidStreet scores all 704 London wards on seven dimensions from open data: safety 30%, schools 20%, transport 15%, green space 12%, family presence 10%, play space 8%, planned facilities 5%. Sources: Home Office street-level crime via police.uk, Ofsted, ONS Census 2021 and mid-2024 population estimates, OS Open Greenspace, OpenStreetMap, Planning London Datahub. <a href="/">Full methodology and interactive map</a>.</p>
<p>Scores describe open data about a place. They are not advice about where to live, and they cannot see the things that matter most on a street you actually walk down.</p>
</footer>
</div>
</body>
</html>`;
}

function scoreTable(w) {
  const rows = Object.keys(WEIGHTS)
    .map((k) => {
      const v = w.scores[k];
      const shown = typeof v === "number" ? v : "n/a";
      const width = typeof v === "number" ? Math.max(2, Math.round(v * 0.9)) : 0;
      return `<tr><th scope="row">${DIM_LABEL[k]}</th><td class="n">${shown}</td><td><span class="bar" style="width:${width}px"></span></td><td class="n">${WEIGHTS[k]}%</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th>Dimension</th><th class="n">Score</th><th></th><th class="n">Weight</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------------------------------------------------------------- ward prose

function wardProse(w) {
  const d = w.dimensions || {};
  const b = boroughRank[w.borough];
  const inBorough = b.wards.findIndex((x) => x === w) + 1;
  const p = [];

  const top = Object.entries(WEIGHTS)
    .map(([k]) => [k, w.scores[k]])
    .filter(([, v]) => typeof v === "number")
    .sort((a, c) => c[1] - a[1]);
  const best = top.slice(0, 2).map(([k]) => DIM_LABEL[k].toLowerCase());
  const worst = top.slice(-2).map(([k]) => DIM_LABEL[k].toLowerCase());

  p.push(
    `<p><strong>${esc(w.ward_name)}</strong> is a ward in the London Borough of ${esc(w.borough)}. It scores <strong>${w.composite} out of 100</strong> on KidStreet's composite measure of child-friendliness, which places it <strong>${ordinal(w.rank)} of ${N}</strong> London wards and ${ordinal(inBorough)} of ${b.wards.length} in ${esc(w.borough)}. That is ${artcl(band(w.composite))} result overall. Its strongest dimensions are ${list(best)}; its weakest are ${list(worst)}.</p>`,
  );

  // safety
  const s = d.safety || {};
  if (typeof s.crimes_per_1000 === "number") {
    const cats = (s.top_categories || [])
      .slice(0, 3)
      .map((c) => c.replace(/-/g, " "));
    p.push(
      `<h3>Safety</h3><p>Police recorded <strong>${s.crimes_last_month?.toLocaleString?.() ?? s.crimes_last_month} street crimes</strong> here in ${esc(monthName(s.period))}, against a resident population of ${s.population?.toLocaleString?.() ?? s.population}. That is <strong>${s.crimes_per_1000} crimes per 1,000 residents</strong>, which scores ${s.score} — meaning ${s.score}% of London wards recorded more crime per resident than this one.${cats.length ? ` The most common categories were ${list(cats)}.` : ""} Crime is counted where it happens, not where the offender or victim lives, so wards with big shopping streets, stations or nightlife carry visitor crime against a resident denominator.</p>`,
    );
  }

  // education
  const e = d.education || {};
  if (e.schools?.length) {
    const outstanding = e.schools.filter((x) => x.ofsted === "Outstanding");
    const good = e.schools.filter((x) => x.ofsted === "Good");
    const ri = e.schools.filter(
      (x) => x.ofsted && !["Outstanding", "Good"].includes(x.ofsted),
    );
    const mix = [];
    if (outstanding.length) mix.push(`${outstanding.length} rated Outstanding`);
    if (good.length) mix.push(`${good.length} rated Good`);
    if (ri.length) mix.push(`${ri.length} rated below Good`);
    p.push(
      `<h3>Schools</h3><p>There ${e.schools.length === 1 ? "is" : "are"} <strong>${e.schools.length} Ofsted-rated school${e.schools.length === 1 ? "" : "s"}</strong> inside the ward boundary: ${list(mix)}. The education score of ${e.score} is the average Ofsted grade, mapped Outstanding 100, Good 67, Requires improvement 33, Inadequate 0. Named schools in the ward:</p><ul class="cols">${e.schools
        .map(
          (x) =>
            `<li>${esc(x.name)} <span style="color:var(--mut)">— ${esc(x.phase || "")}${x.ofsted ? ", " + esc(x.ofsted) : ""}</span></li>`,
        )
        .join("")}</ul><p>Catchments do not follow ward boundaries. Treat this as what is physically nearby, not as an admissions forecast.</p>`,
    );
  } else {
    p.push(
      `<h3>Schools</h3><p>No Ofsted-rated school sits inside this ward's boundary, so the education dimension is not scored and its 20% weight is redistributed across the dimensions that are. Families here will be looking at schools in neighbouring wards.</p>`,
    );
  }

  // play + green
  const pl = d.play_provision || {};
  const g = d.green_space || {};
  if (typeof pl.m2_per_child === "number") {
    const ratio = pl.ratio_vs_benchmark;
    const verdict =
      ratio >= 3
        ? `comfortably above`
        : ratio >= 1
          ? `above`
          : `below`;
    p.push(
      `<h3>Play space</h3><p>The ward has <strong>${Math.round(pl.play_area_m2).toLocaleString()} m² of play and informal recreation space</strong> across ${pl.play_site_count} site${pl.play_site_count === 1 ? "" : "s"}, shared between ${pl.children_0_15?.toLocaleString?.() ?? pl.children_0_15} children aged 0-15. That works out at <strong>${pl.m2_per_child} m² per child</strong>, ${verdict} the 10 m² per child the London Plan asks of new development. We use that figure as a yardstick for existing wards, which is <a href="/guides/london-playground-gap/">past its drafted purpose</a>.${typeof pl.equipped_m2_per_child === "number" ? ` Counting only equipped playgrounds rather than all open space, the figure is ${pl.equipped_m2_per_child} m² per child.` : ""}</p>`,
    );
  }
  if (g.notable_parks?.length) {
    p.push(
      `<p>Green space scores ${g.score}, from ${g.park_reserve_count} park${g.park_reserve_count === 1 ? "" : "s"} and open space${g.park_reserve_count === 1 ? "" : "s"} and ${g.playground_count} mapped playground${g.playground_count === 1 ? "" : "s"} inside the boundary, including ${list(g.notable_parks.slice(0, 5).map(esc))}. Only space inside the ward counts, so a large park just over the boundary does not show up here even though a family would walk to it.</p>`,
    );
  }

  // transport
  const t = d.transport || {};
  if (t.station_count != null) {
    const st = (t.nearest_stations || []).map((x) => esc(x.name));
    p.push(
      `<h3>Transport</h3><p>Transport scores ${t.score}, based on ${t.station_count} station${t.station_count === 1 ? "" : "s"} inside the ward${t.stations_in_adjacent_wards ? `, ${t.stations_in_adjacent_wards} one ward over` : ""} and ${t.bus_stop_count} bus stops.${st.length ? ` Stations here: ${list(st)}.` : ""} ${t.step_free_in_or_adjacent ? "At least one station in or next to the ward is confirmed step-free, which matters more than most rankings admit when you are travelling with a buggy." : "No station in or adjacent to the ward is confirmed step-free in the open data, which is worth checking before committing if you will be travelling with a buggy."}</p>`,
    );
  }

  // family
  const f = d.family_fit || {};
  if (typeof f.pct_households_with_dependent_children === "number") {
    p.push(
      `<h3>Who lives here</h3><p><strong>${f.pct_households_with_dependent_children}% of households</strong> in the ward have dependent children, which scores ${f.score} against the rest of London. This is a measure of whether other families have already chosen the area, not of whether they were right to. ${f.pct_population_family_forming_age}% of residents are aged 25-49.</p>`,
    );
  }

  // planning
  const pn = d.planning || {};
  if (pn.upcoming_facility_count > 0) {
    const items = (pn.upcoming_facilities || []).slice(0, 4);
    p.push(
      `<h3>In the planning pipeline</h3><p>${pn.upcoming_facility_count} recent planning application${pn.upcoming_facility_count === 1 ? "" : "s"} in the ward touch${pn.upcoming_facility_count === 1 ? "es" : ""} child-related facilities. This dimension is a raw count and carries only 5% of the weight, so read it as a signal of direction rather than a score.</p><ul>${items
        .map(
          (x) =>
            `<li>${esc(dent(x.description).slice(0, 190))}${dent(x.description).length > 190 ? "…" : ""} <span style="color:var(--mut)">(${esc(x.status || x.decision || "")}${x.decision_date ? ", " + esc(x.decision_date) : ""})</span></li>`,
        )
        .join("")}</ul>`,
    );
  }

  return p.join("\n");
}

// ---------------------------------------------------------------- writers

let urls = [];
const write = (rel, html) => {
  const file = path.join(ROOT, "public", rel, "index.html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  urls.push("/" + rel + "/");
};

// ward pages
for (const w of ranked) {
  const b = boroughRank[w.borough];
  const inBorough = b.wards.findIndex((x) => x === w) + 1;
  const title = `${w.ward_name}, ${w.borough}: how child-friendly is it? | KidStreet`;
  const desc = `${w.ward_name} scores ${w.composite}/100 for child-friendliness, ${ordinal(w.rank)} of ${N} London wards. Crime, schools, play space, transport and green space, from open data.`;

  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `Is ${w.ward_name} a good area for families?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `${w.ward_name} scores ${w.composite} out of 100 on KidStreet's composite child-friendliness measure, ranking ${ordinal(w.rank)} of ${N} London wards and ${ordinal(inBorough)} of ${b.wards.length} in ${w.borough}. That is ${artcl(band(w.composite))} result.`,
        },
      },
      {
        "@type": "Question",
        name: `How safe is ${w.ward_name}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text:
            typeof w.dimensions?.safety?.crimes_per_1000 === "number"
              ? `Police recorded ${w.dimensions.safety.crimes_per_1000} street crimes per 1,000 residents in ${monthName(w.dimensions.safety.period)}, which is safer than ${w.scores.safety}% of London wards.`
              : `Ward-level crime per resident is not published for this ward.`,
        },
      },
      {
        "@type": "Question",
        name: `How many schools are in ${w.ward_name}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: w.dimensions?.education?.schools?.length
            ? `${w.dimensions.education.schools.length} Ofsted-rated schools sit inside the ward boundary: ${w.dimensions.education.schools.map((s) => s.name).join(", ")}.`
            : `No Ofsted-rated school sits inside this ward boundary.`,
        },
      },
    ],
  };

  const crumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "London", item: `${SITE}/areas/` },
      { "@type": "ListItem", position: 2, name: w.borough, item: `${SITE}/areas/${w.boroughSlug}/` },
      { "@type": "ListItem", position: 3, name: w.ward_name, item: `${SITE}${w.url}` },
    ],
  };

  const nearby = w.neighbours
    .map(
      (n) =>
        `<li><a href="${n.url}">${esc(n.ward_name)}</a> <span style="color:var(--mut)">${n.borough === w.borough ? "" : n.borough + ", "}${n.composite}/100</span></li>`,
    )
    .join("");

  const alsoBorough = b.wards
    .filter((x) => x !== w)
    .slice(0, 5)
    .map((n) => `<li><a href="${n.url}">${esc(n.ward_name)}</a> — ${n.composite}/100</li>`)
    .join("");

  const body = `
<h1>${esc(w.ward_name)}</h1>
<p class="sub">${esc(w.borough)} · ward code ${esc(w.ward_code)}</p>
<div class="hero"><span class="big">${w.composite}</span><span>out of 100 for child-friendliness<br><span style="color:var(--mut)">${ordinal(w.rank)} of ${N} London wards · ${ordinal(inBorough)} of ${b.wards.length} in ${esc(w.borough)}</span></span></div>
${wardProse(w)}
<h2>Score breakdown</h2>
${scoreTable(w)}
<p style="margin-top:24px"><a class="cta" href="/?ward=${encodeURIComponent(w.ward_name)}">See ${esc(w.ward_name)} on the map</a></p>
<h2>Nearby wards</h2>
<ul>${nearby}</ul>
<h2>Best-scoring wards in ${esc(w.borough)}</h2>
<ul>${alsoBorough}</ul>
<p><a href="/areas/${w.boroughSlug}/">All ${b.wards.length} wards in ${esc(w.borough)}</a> · <a href="/areas/">Every London borough ranked</a></p>`;

  write(`areas/${w.boroughSlug}/${w.slug}`, page({
    title,
    desc,
    canonical: w.url,
    jsonld: [crumbs, faq],
    breadcrumb: `<a href="/">KidStreet</a> › <a href="/areas/">London</a> › <a href="/areas/${w.boroughSlug}/">${esc(w.borough)}</a> › ${esc(w.ward_name)}`,
    body,
  }));
}

// borough pages
for (const b of boroughList) {
  const best = b.wards[0],
    worst = b.wards[b.wards.length - 1];
  const meanOf = (k) => {
    const v = b.wards.map((w) => w.scores[k]).filter((x) => typeof x === "number");
    return v.length ? Math.round(v.reduce((a, c) => a + c, 0) / v.length) : null;
  };
  const dims = Object.keys(WEIGHTS).map((k) => [k, meanOf(k)]).filter(([, v]) => v != null);
  const strong = [...dims].sort((a, c) => c[1] - a[1]).slice(0, 2).map(([k]) => DIM_LABEL[k].toLowerCase());
  const weak = [...dims].sort((a, c) => a[1] - c[1]).slice(0, 2).map(([k]) => DIM_LABEL[k].toLowerCase());
  const belowBench = b.wards.filter(
    (w) => typeof w.dimensions?.play_provision?.m2_per_child === "number" && w.dimensions.play_provision.m2_per_child < 10,
  ).length;

  const rows = b.wards
    .map(
      (w) =>
        `<tr><td><a href="${w.url}">${esc(w.ward_name)}</a></td><td class="n">${w.composite}</td><td class="n">${w.scores.safety ?? "–"}</td><td class="n">${w.scores.education ?? "–"}</td><td class="n">${w.scores.play ?? "–"}</td><td class="n">${w.rank}</td></tr>`,
    )
    .join("");

  const body = `
<h1>${esc(b.name)}: every ward ranked for families</h1>
<p class="sub">${b.wards.length} wards · ${ordinal(b.rank)} of ${boroughList.length} London boroughs</p>
<div class="hero"><span class="big">${b.mean}</span><span>average ward score out of 100<br><span style="color:var(--mut)">${ordinal(b.rank)} of ${boroughList.length} boroughs</span></span></div>
<p>${esc(b.name)} averages <strong>${b.mean} out of 100</strong> across its ${b.wards.length} wards, which ranks it <strong>${ordinal(b.rank)} of ${boroughList.length}</strong> London boroughs on KidStreet's composite child-friendliness measure. Its strongest dimensions on average are ${list(strong)}; its weakest are ${list(weak)}.</p>
<p>The spread inside the borough matters more than the average. <a href="${best.url}">${esc(best.ward_name)}</a> scores ${best.composite} and ranks ${ordinal(best.rank)} in London; <a href="${worst.url}">${esc(worst.ward_name)}</a> scores ${worst.composite} and ranks ${ordinal(worst.rank)}. A ${best.composite - worst.composite}-point gap inside one borough is the reason borough-level "best place for families" lists mislead: you do not live in a borough, you live on a street in a ward.</p>
<p>${belowBench} of ${b.wards.length} wards in ${esc(b.name)} provide less play space per child than the 10 m² the London Plan asks of new development, a figure we apply to existing wards as a yardstick and <a href="/guides/london-playground-gap/">are open about stretching</a>.</p>
<h2>All ${b.wards.length} wards in ${esc(b.name)}</h2>
<table><thead><tr><th>Ward</th><th class="n">Overall</th><th class="n">Safety</th><th class="n">Schools</th><th class="n">Play</th><th class="n">London rank</th></tr></thead><tbody>${rows}</tbody></table>
<p style="margin-top:24px"><a class="cta" href="/?borough=${encodeURIComponent(b.name)}">See ${esc(b.name)} on the map</a></p>
<h2>Compare with other boroughs</h2>
<ul class="cols">${boroughList
    .filter((x) => x !== b)
    .slice(0, 12)
    .map((x) => `<li><a href="/areas/${x.slug}/">${esc(x.name)}</a> — ${x.mean}</li>`)
    .join("")}</ul>
<p><a href="/areas/">All ${boroughList.length} boroughs ranked</a></p>`;

  write(`areas/${b.slug}`, page({
    title: `${b.name} for families: all ${b.wards.length} wards ranked (2026) | KidStreet`,
    desc: `${b.name} averages ${b.mean}/100 for child-friendliness, ${ordinal(b.rank)} of ${boroughList.length} London boroughs. Every ward ranked on crime, schools, play space and transport.`,
    canonical: `/areas/${b.slug}/`,
    jsonld: [
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "London", item: `${SITE}/areas/` },
          { "@type": "ListItem", position: 2, name: b.name, item: `${SITE}/areas/${b.slug}/` },
        ],
      },
    ],
    breadcrumb: `<a href="/">KidStreet</a> › <a href="/areas/">London</a> › ${esc(b.name)}`,
    body,
  }));
}

// London hub — the flagship article. Every figure below is computed from the
// data, so a re-run after a data refresh updates the prose as well as the tables.
// Nothing here goes stale silently.
{
  const INNER = [
    "Camden", "City of London", "Hackney", "Hammersmith and Fulham", "Haringey",
    "Islington", "Kensington and Chelsea", "Lambeth", "Lewisham", "Newham",
    "Southwark", "Tower Hamlets", "Wandsworth", "Westminster",
  ];
  const isInner = (w) => INNER.includes(w.borough);

  const top = ranked[0];
  const second = ranked[1];
  const comps = wards.map((w) => w.composite).sort((a, b) => a - b);
  const medianComp = comps[Math.floor(comps.length / 2)];

  const top50 = ranked.slice(0, 50);
  const innerTop50 = top50.filter(isInner);
  const outerTop50 = 50 - innerTop50.length;

  const d = top.dimensions || {};
  const topSchools = d.education?.schools || [];
  const topOutstanding = topSchools.filter((s) => s.ofsted === "Outstanding").length;
  const topParks = d.green_space?.notable_parks || [];
  const topStations = (d.transport?.nearest_stations || []).map((s) => s.name);

  // widest and narrowest within-borough spreads, for the "borough average is
  // the least useful number" section
  const spreads = boroughList
    .filter((b) => b.name !== "City of London") // micro-wards with null data, not a fair example
    .map((b) => ({
      b,
      best: b.wards[0],
      worst: b.wards[b.wards.length - 1],
      gap: b.wards[0].composite - b.wards[b.wards.length - 1].composite,
    }))
    .sort((x, y) => y.gap - x.gap);
  const widest = spreads[0];

  // the borough that ranks second from bottom, i.e. the surprising one
  const kc = boroughRank["Kensington and Chelsea"];
  const kcMean = (k) => {
    const v = kc.wards.map((w) => w.scores[k]).filter((x) => typeof x === "number");
    return v.length ? Math.round(v.reduce((a, c) => a + c, 0) / v.length) : null;
  };

  // Named comparisons for the "none of those numbers is a record" line, computed
  // so the sentence keeps naming real wards after a data refresh.
  const byPlay = wards
    .filter((w) => typeof w.dimensions?.play_provision?.m2_per_child === "number")
    .sort((a, b) => b.dimensions.play_provision.m2_per_child - a.dimensions.play_provision.m2_per_child)[0];
  const playRatio =
    byPlay && d.play_provision?.m2_per_child
      ? Math.round(byPlay.dimensions.play_provision.m2_per_child / d.play_provision.m2_per_child)
      : null;
  const pick = (key) =>
    ranked
      .slice(0, 30)
      .filter((w) => w !== top && typeof w.scores[key] === "number" && w.scores[key] > (top.scores[key] ?? -1))
      .sort((a, b) => b.scores[key] - a.scores[key])[0];
  const betterEdu = pick("education");
  const betterTra = pick("transport");
  const beats = [];
  if (byPlay && playRatio > 1)
    beats.push(`<a href="${byPlay.url}">${esc(byPlay.ward_name)}</a> has ${playRatio} times the play space per child`);
  if (betterEdu)
    beats.push(`<a href="${betterEdu.url}">${esc(betterEdu.ward_name)}</a> scores higher on schools`);
  if (betterTra)
    beats.push(`<a href="${betterTra.url}">${esc(betterTra.ward_name)}</a> scores higher on transport`);

  const top20rows = ranked
    .slice(0, 20)
    .map(
      (w) =>
        `<tr><td class="n">${w.rank}</td><td><a href="${w.url}">${esc(w.ward_name)}</a></td><td><a href="/areas/${w.boroughSlug}/">${esc(w.borough)}</a></td><td class="n">${w.composite}</td></tr>`,
    )
    .join("");

  const borRows = boroughList
    .map(
      (b) =>
        `<tr><td class="n">${b.rank}</td><td><a href="/areas/${b.slug}/">${esc(b.name)}</a></td><td class="n">${b.mean}</td><td class="n">${b.wards.length}</td><td><a href="${b.wards[0].url}">${esc(b.wards[0].ward_name)}</a> (${b.wards[0].composite})</td></tr>`,
    )
    .join("");

  const innerSentence = innerTop50.length
    ? innerTop50
        .map((w) => `<a href="${w.url}">${esc(w.ward_name)}</a> at ${ordinal(w.rank)}`)
        .join(", ")
    : "none";

  const body = `
<h1>The best areas in London for families, ranked from open data</h1>
<p class="sub">All ${N} London wards · 33 boroughs · seven dimensions · data as at ${monthName(d.safety?.period)}</p>

<p>Most "best places to live in London for families" lists are written by people who sell houses. They pick a dozen areas, describe the high street, mention a farmers' market, and rank them in an order that would be difficult to defend if anyone asked.</p>

<p>This one is built the other way round. We scored all ${N} of London's electoral wards on seven things you can actually measure: recorded crime per resident, the Ofsted grades of the schools inside the ward boundary, station and bus access, green space, play space per child against the figure the London Plan asks of new development, how many households nearby already have dependent children, and planning applications for child-related facilities. The weights are published, the sources are open government data, and the method is on the <a href="/">home page</a>. You can disagree with the weights. You cannot accuse the ranking of having a commission attached.</p>

<h2>The 20 most child-friendly wards in London</h2>
<table><thead><tr><th class="n">#</th><th>Ward</th><th>Borough</th><th class="n">Score</th></tr></thead><tbody>${top20rows}</tbody></table>

<p>If that list looks like it was assembled by someone who has never been to a gallery opening, that is the point. The data has no opinion about whether an area is interesting. It has an opinion about whether a seven-year-old can get to a decent school, cross a road, and find somewhere to run around.</p>

<h2>Number one is ${esc(top.ward_name)}</h2>

<p><a href="${top.url}">${esc(top.ward_name)}</a> in ${esc(top.borough)} scores <strong>${top.composite} out of 100</strong>, ${top.composite - second.composite === 0 ? "level with" : `${top.composite - second.composite} point${top.composite - second.composite === 1 ? "" : "s"} clear of`} second place and ${top.composite - medianComp} points above the median London ward, which scores ${medianComp}.</p>

<p>It gets there without being exceptional at any single thing. Police recorded ${d.safety?.crimes_last_month} street crimes there in ${monthName(d.safety?.period)} against a population of ${d.safety?.population?.toLocaleString()}, which is ${Number(d.safety?.crimes_per_1000).toFixed(1)} per 1,000 residents and safer than ${top.scores.safety}% of London wards. There ${topSchools.length === 1 ? "is" : "are"} ${topSchools.length} Ofsted-rated school${topSchools.length === 1 ? "" : "s"} inside the ward boundary${topOutstanding ? `, ${topOutstanding} of them Outstanding, including ${esc(topSchools.find((s) => s.ofsted === "Outstanding").name)}` : ""}. There are ${d.green_space?.park_reserve_count} parks and open spaces${topParks.length ? `, among them ${list(topParks.slice(0, 3).map(esc))}` : ""}, giving ${d.play_provision?.m2_per_child} m² of play and informal recreation space per child aged 0-15, against the 10 m² the London Plan asks of new development.${topStations.length ? ` ${esc(topStations[0])} station is in the ward` : ""}${d.transport?.bus_stop_count ? ` and ${d.transport.bus_stop_count} bus stops serve it` : ""}. ${d.family_fit?.pct_households_with_dependent_children}% of households have dependent children.</p>

<p>None of those numbers is a record. ${list(beats)}. ${esc(top.ward_name)} wins because it is the ward that is least bad at anything, and for a family that is usually what matters. You do not get to enjoy the park if you cannot get to the school.</p>

<h2>Outer London has won</h2>

<p>Of the top 50 wards in London, <strong>${outerTop50} are outer London</strong>. Inner London has ${wards.filter(isInner).length} of the ${N} wards and ${innerTop50.length} of the top fifty.</p>

<p>The exceptions are worth naming: ${innerSentence}. Each wins on a different anomaly, and between them they represent inner London's entire showing near the top of this table.</p>

<p>London's primary school population has fallen 6.25% from its 2017/18 peak of just over 700,000, against roughly 2% nationally, and the London Assembly has been asked to consider whether the decline leads to permanent school closures. Families have been leaving inner London for a decade. The ranking reflects that.</p>

<h2>Every borough, ranked</h2>
<p>Average ward score across all wards in the borough:</p>
<table><thead><tr><th class="n">#</th><th>Borough</th><th class="n">Mean</th><th class="n">Wards</th><th>Best ward</th></tr></thead><tbody>${borRows}</tbody></table>

<p>Kensington and Chelsea coming ${ordinal(kc.rank)} of ${boroughList.length} will annoy people. Here is the arithmetic behind it, because it is not a judgement on the borough. It scores ${kcMean("education")} on schools, which is above the London average. It loses on everything a child uses daily: ${kcMean("safety")} on safety, because the crime that happens in Knightsbridge is counted against the people who sleep in Knightsbridge; ${kcMean("green_space")} on green space, because the royal parks mostly sit outside the ward boundaries; and ${kcMean("family_fit")} on family presence, because families have largely gone.</p>

<h2>The borough average is the least useful number on this page</h2>

<p>Look at ${esc(widest.b.name)}. It contains <a href="${widest.best.url}">${esc(widest.best.ward_name)}</a>, which scores ${widest.best.composite} and ranks ${ordinal(widest.best.rank)} in London, and <a href="${widest.worst.url}">${esc(widest.worst.ward_name)}</a>, which scores ${widest.worst.composite} and ranks ${ordinal(widest.worst.rank)}. That is a ${widest.gap}-point spread inside one local authority.</p>

<p>It is not an outlier. ${spreads.slice(1, 4).map((s) => `${esc(s.b.name)} spans ${s.gap} points`).join(", ")}. The difference between the best and worst ward in a typical London borough is larger than the difference between the best and worst borough.</p>

<p>That is why borough-level "best places for families" lists are close to useless. You do not live in a borough. You live in a ward, and often on one side of it.</p>

<h2>What the score cannot see</h2>

<p>Everything that matters most, roughly.</p>

<p>Ofsted ratings age, and catchments do not follow ward boundaries. The school rated Outstanding today may not be when your child gets there, and living in the ward does not get you a place at it.</p>

<p>The green space and play measures count only what falls inside the boundary, so a park fifty metres over the line counts for nothing. Crime has the opposite problem: it is logged where it happens, so wards with big stations, shopping streets or nightlife carry visitor crime against a resident denominator and look worse than they feel. Both are honest and both are crude. Measuring what a family can walk to, rather than what sits inside a line on a map, is the first fix on the list.</p>

<p>Price is missing altogether. A good deal of the top twenty is expensive, and "best area" and "best area you can afford" are different questions.</p>

<p>And it cannot see the street. Whether the road outside is a rat run, whether the neighbours have children the same age, whether the walk to school crosses something horrible. Those decide more than any of this, and no dataset holds them.</p>

<p>Use the score to narrow ${N} wards down to a shortlist. Then go and visit them at school run time.</p>

<p>Related: <a href="/guides/safest-areas-in-london-for-families/">the safest areas in London, ranked ward by ward</a>, and <a href="/guides/london-playground-gap/">London's playground gap</a>.</p>

<p style="margin-top:28px"><a class="cta" href="/">Open the interactive map</a></p>`;

  write("areas", page({
    title: `The best areas in London for families: all ${N} wards ranked (2026) | KidStreet`,
    desc: `Every one of London's ${N} wards scored on crime, schools, play space, transport and green space. The most child-friendly ward in London is ${top.ward_name} in ${top.borough}, at ${top.composite} out of 100.`,
    canonical: "/areas/",
    jsonld: [
      {
        "@context": "https://schema.org",
        "@type": "Dataset",
        name: "KidStreet London ward child-friendliness scores",
        description:
          "Composite child-friendliness scores for all 704 London electoral wards across seven weighted dimensions, built from open government data.",
        url: `${SITE}/areas/`,
        license: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
        creator: { "@type": "Organization", name: "KidStreet" },
        spatialCoverage: { "@type": "Place", name: "Greater London" },
      },
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "What is the best area in London for families?",
            acceptedAnswer: {
              "@type": "Answer",
              text: `${top.ward_name} in ${top.borough} scores ${top.composite} out of 100, the highest of London's ${N} wards, on a composite of recorded crime per resident, Ofsted grades, transport access, green space, play space per child, family presence and planned facilities.`,
            },
          },
          {
            "@type": "Question",
            name: "Which London borough is best for families?",
            acceptedAnswer: {
              "@type": "Answer",
              text: `${boroughList[0].name} averages ${boroughList[0].mean} out of 100 across its wards, the highest in London. But the spread within boroughs is larger than the spread between them, so the ward matters more than the borough.`,
            },
          },
          {
            "@type": "Question",
            name: "Is inner or outer London better for families?",
            acceptedAnswer: {
              "@type": "Answer",
              text: `${outerTop50} of London's top 50 wards for child-friendliness are in outer London. Inner London holds ${wards.filter(isInner).length} of the ${N} wards but only ${innerTop50.length} of the top fifty.`,
            },
          },
        ],
      },
    ],
    breadcrumb: `<a href="/">KidStreet</a> › London`,
    body,
  }));
}

// Guide: safest areas, ward by ward. Highest-volume query cluster on the site,
// and the one nobody else answers below borough level. Every figure computed, so
// re-running after each monthly crime refresh republishes it current.
{
  const MIN_POP = 3000; // per-resident rates go silly below this
  const scored = wards.filter(
    (w) =>
      typeof w.dimensions?.safety?.crimes_per_1000 === "number" &&
      (w.dimensions.safety.population || 0) > MIN_POP,
  );
  const bySafe = [...scored].sort(
    (a, b) => a.dimensions.safety.crimes_per_1000 - b.dimensions.safety.crimes_per_1000,
  );
  const rates = bySafe.map((w) => w.dimensions.safety.crimes_per_1000);
  const medianRate = rates[Math.floor(rates.length / 2)];

  const safest = bySafe.slice(0, 25);
  const worst = bySafe.slice(-10).reverse();

  // wards that clear both bars: in the safest 25 and in London's overall top 50
  const both = safest.filter((w) => w.rank <= 50);

  const safeRows = safest
    .map(
      (w, i) =>
        `<tr><td class="n">${i + 1}</td><td><a href="${w.url}">${esc(w.ward_name)}</a></td><td><a href="/areas/${w.boroughSlug}/">${esc(w.borough)}</a></td><td class="n">${w.dimensions.safety.crimes_per_1000.toFixed(1)}</td><td class="n">${ordinal(w.rank)}</td></tr>`,
    )
    .join("");

  const worstRows = worst
    .map(
      (w) =>
        `<tr><td><a href="${w.url}">${esc(w.ward_name)}</a></td><td><a href="/areas/${w.boroughSlug}/">${esc(w.borough)}</a></td><td class="n">${w.dimensions.safety.crimes_per_1000.toFixed(1)}</td></tr>`,
    )
    .join("");

  const boroughRate = boroughList
    .map((b) => {
      const v = b.wards
        .map((w) => w.dimensions?.safety?.crimes_per_1000)
        .filter((x) => typeof x === "number");
      return { name: b.name, slug: b.slug, rate: v.length ? v.reduce((a, c) => a + c, 0) / v.length : null };
    })
    .filter((x) => x.rate != null)
    .sort((a, b) => a.rate - b.rate);
  const fmtBor = (arr) =>
    arr.map((b) => `<a href="/areas/${b.slug}/">${esc(b.name)}</a> ${b.rate.toFixed(1)}`).join(" · ");

  // a borough with a mediocre average that nonetheless holds a very safe ward
  const contrast = (() => {
    for (const w of safest) {
      const b = boroughRate.find((x) => x.name === w.borough);
      if (b && b.rate >= medianRate) return { ward: w, borough: b };
    }
    return null;
  })();

  const period = monthName(safest[0]?.dimensions?.safety?.period);

  const body = `
<h1>The safest areas in London for families, ward by ward</h1>
<p class="sub">${scored.length} wards · Home Office street-level crime, ${period} · per 1,000 residents</p>

<p>Search "safest areas in London" and you get thirty pages of borough rankings. Borough rankings are the wrong unit. A London borough contains twenty-odd wards, and the gap between the safest and the least safe ward inside a single borough is routinely larger than the gap between the safest and the least safe borough.</p>

<p>So here is the ward-level version, using Home Office street-level crime records for ${period} divided by ONS mid-2024 resident population, with wards under ${MIN_POP.toLocaleString()} residents excluded because the arithmetic gets silly at small denominators.</p>

<p>The median London ward records <strong>${medianRate.toFixed(1)} street crimes per 1,000 residents per month</strong>. That number is what makes the rest of these figures mean anything.</p>

<h2>The 25 safest wards in London</h2>
<table><thead><tr><th class="n">#</th><th>Ward</th><th>Borough</th><th class="n">Per 1,000</th><th class="n">Overall rank</th></tr></thead><tbody>${safeRows}</tbody></table>
<p>The safest ward in London records about ${Math.round((safest[0].dimensions.safety.crimes_per_1000 / medianRate) * 100)}% of the crime per resident of the median ward.</p>

<h2>Safest is not the same as best</h2>

<p>Look at the right-hand column. ${safest
    .filter((w) => w.rank > 300)
    .slice(0, 3)
    .map((w) => `<a href="${w.url}">${esc(w.ward_name)}</a> is ${ordinal(safest.indexOf(w) + 1)} safest and ${ordinal(w.rank)} overall`)
    .join(", ")}.</p>

<p>Very low crime on its own often means a quiet residential area with nothing in it. No station, no shops, not much green space, not many other children. Safe in the sense that nothing happens.</p>

<p>The wards worth shortlisting are the ones near the top of both columns. On this list that is ${list(
    both.map((w) => `<a href="${w.url}">${esc(w.ward_name)}</a> (${ordinal(safest.indexOf(w) + 1)} safest, ${ordinal(w.rank)} overall)`),
  )}. That is ${both.length} wards clearing both bars.</p>

<h2>The other end, and why it misleads</h2>
<table><thead><tr><th>Ward</th><th>Borough</th><th class="n">Per 1,000</th></tr></thead><tbody>${worstRows}</tbody></table>

<p>That list is largely shopping streets, mainline stations, nightlife strips and, in one case, an airport. They are not dangerous neighbourhoods. They are places where hundreds of thousands of people who live somewhere else spend the day, and where crime committed against those visitors is recorded against the few thousand people who happen to sleep there. The top figure of ${worst[0].dimensions.safety.crimes_per_1000.toFixed(1)} per 1,000 in <a href="${worst[0].url}">${esc(worst[0].ward_name)}</a> is arithmetic, not a warning.</p>

<p>This is the biggest flaw in every "safest areas in London" article that uses raw crime counts or per-resident rates without saying so, and we are saying so. If a ward contains a major station, a shopping street, a stadium or a nightlife strip, its per-resident rate overstates the risk to somebody living there. Comparing two quiet residential wards, the measure is sound.</p>

<h2>Boroughs, if you insist</h2>
<p>Mean street crime per 1,000 residents across all wards in the borough.</p>
<p><strong>Lowest ten:</strong> ${fmtBor(boroughRate.slice(0, 10))}</p>
<p><strong>Highest ten:</strong> ${fmtBor(boroughRate.slice(-10).reverse())}</p>

<p>Every borough in the highest group is central or inner, and every borough in the lowest group is outer. That is the visitor-crime effect again, plus a real difference in density.</p>

${
  contrast
    ? `<p>The borough average still conceals what you need. <a href="/areas/${contrast.borough.slug}/">${esc(contrast.borough.name)}</a> averages ${contrast.borough.rate.toFixed(1)}, worse than the London median of ${medianRate.toFixed(1)}, and contains <a href="${contrast.ward.url}">${esc(contrast.ward.ward_name)}</a> at ${contrast.ward.dimensions.safety.crimes_per_1000.toFixed(1)}, one of the safest wards in the city. The average tells you nothing about the ward.</p>`
    : ""
}

<h2>How to use this</h2>
<ol>
<li><strong>Find the ward, not the borough.</strong> Every London ward has <a href="/areas/">its own page here</a> with the crime figure, the three commonest offence categories and the resident population it is divided by.</li>
<li><strong>Check which categories dominate.</strong> A ward whose commonest recorded offences are shoplifting and vehicle crime is a different proposition to one where it is violence.</li>
<li><strong>Discount destination wards.</strong> If the ward has a mainline station, a high street or a nightlife strip, subtract a chunk mentally. The data cannot separate visitor crime from resident crime, so you have to.</li>
<li><strong>Do not stop at safety.</strong> It carries 30% of the overall score because families weight it most heavily, but a ward that is only safe is not a good place to grow up.</li>
</ol>

<p>One month of data is volatile at ward level. Treat a single figure as an indication rather than a verdict, and check back when the next month publishes.</p>

<p style="margin-top:28px"><a class="cta" href="/areas/">See all ${N} wards ranked for families</a></p>`;

  write("guides/safest-areas-in-london-for-families", page({
    title: `The safest areas in London, ranked by ward (${period} police data) | KidStreet`,
    desc: `Every London ward ranked by street crime per 1,000 residents, ${period} Home Office data. The safest is ${safest[0].ward_name} at ${safest[0].dimensions.safety.crimes_per_1000.toFixed(1)} per 1,000. The London median is ${medianRate.toFixed(1)}.`,
    canonical: "/guides/safest-areas-in-london-for-families/",
    jsonld: [
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "London", item: `${SITE}/areas/` },
          {
            "@type": "ListItem",
            position: 2,
            name: "Safest areas in London for families",
            item: `${SITE}/guides/safest-areas-in-london-for-families/`,
          },
        ],
      },
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "What is the safest area in London?",
            acceptedAnswer: {
              "@type": "Answer",
              text: `${safest[0].ward_name} in ${safest[0].borough} records ${safest[0].dimensions.safety.crimes_per_1000.toFixed(1)} street crimes per 1,000 residents, the lowest of any London ward with more than ${MIN_POP.toLocaleString()} residents. The London median is ${medianRate.toFixed(1)}.`,
            },
          },
          {
            "@type": "Question",
            name: "Why do central London areas have such high crime rates per resident?",
            acceptedAnswer: {
              "@type": "Answer",
              text: `Crime is recorded where it happens, not where the victim lives. Wards containing shopping streets, mainline stations and nightlife carry crime against visitors while being divided by a small resident population, so their per-resident rate overstates the risk to residents.`,
            },
          },
        ],
      },
    ],
    breadcrumb: `<a href="/">KidStreet</a> › <a href="/areas/">London</a> › Safest areas for families`,
    body,
  }));
}

// Guide: the play space gap. The link magnet. The story is the gap between the
// all-open-space measure and the equipped-playground measure, which no one else
// publishes at ward level. Also writes a CSV so journalists can check the work.
{
  const BENCH = 10;
  const scoredP = wards.filter(
    (w) => typeof w.dimensions?.play_provision?.m2_per_child === "number",
  );
  const kidsOf = (w) => w.dimensions.play_provision.children_0_15 || 0;
  const allKids = scoredP.reduce((a, c) => a + kidsOf(c), 0);

  const belowAll = scoredP.filter((w) => w.dimensions.play_provision.m2_per_child < BENCH);
  const kidsAll = belowAll.reduce((a, c) => a + kidsOf(c), 0);

  const hasEq = scoredP.filter(
    (w) => typeof w.dimensions.play_provision.equipped_m2_per_child === "number",
  );
  const belowEq = hasEq.filter(
    (w) => w.dimensions.play_provision.equipped_m2_per_child < BENCH,
  );
  const kidsEq = belowEq.reduce((a, c) => a + kidsOf(c), 0);

  const byBor = boroughList
    .map((b) => {
      const ws = b.wards.filter(
        (w) => typeof w.dimensions?.play_provision?.m2_per_child === "number",
      );
      if (!ws.length) return null;
      const bel = ws.filter((w) => w.dimensions.play_provision.m2_per_child < BENCH);
      const med = ws
        .map((w) => w.dimensions.play_provision.m2_per_child)
        .sort((a, c) => a - c)[Math.floor(ws.length / 2)];
      return {
        b,
        n: ws.length,
        bel: bel.length,
        pct: Math.round((100 * bel.length) / ws.length),
        kids: bel.reduce((a, c) => a + kidsOf(c), 0),
        med,
      };
    })
    .filter(Boolean)
    .sort((a, c) => c.pct - a.pct || c.kids - a.kids);

  const clean = byBor.filter((r) => r.pct === 0).map((r) => r.b);

  const borRows = byBor
    .map(
      (r) =>
        `<tr><td><a href="/areas/${r.b.slug}/">${esc(r.b.name)}</a></td><td class="n">${r.bel} of ${r.n}</td><td class="n">${r.pct}%</td><td class="n">${r.kids.toLocaleString()}</td><td class="n">${r.med.toFixed(1)}</td></tr>`,
    )
    .join("");

  const worstWards = scoredP
    .filter((w) => kidsOf(w) > 500)
    .sort(
      (a, c) => a.dimensions.play_provision.m2_per_child - c.dimensions.play_provision.m2_per_child,
    )
    .slice(0, 15);
  const worstRows = worstWards
    .map(
      (w) =>
        `<tr><td><a href="${w.url}">${esc(w.ward_name)}</a></td><td><a href="/areas/${w.boroughSlug}/">${esc(w.borough)}</a></td><td class="n">${w.dimensions.play_provision.m2_per_child.toFixed(1)}</td><td class="n">${kidsOf(w).toLocaleString()}</td></tr>`,
    )
    .join("");

  const body = `
<h1>London's playground gap: the play space standard is met by grass, not by playgrounds</h1>
<p class="sub">${scoredP.length} wards with play data · OS Open Greenspace clipped to ward boundaries · ONS mid-2024 child population</p>

<p>The London Plan asks for 10 m² of play and informal recreation space per child. Measured against every scrap of qualifying open space inside a ward boundary, most of London clears it: <strong>${belowAll.length} of ${scoredP.length} wards</strong> fall short, home to <strong>${kidsAll.toLocaleString()} children</strong> aged 0-15, about ${Math.round((100 * kidsAll) / allKids)}% of the total.</p>

<p>Count only equipped playgrounds, and the picture inverts. <strong>${belowEq.length} of ${hasEq.length} wards</strong> fall short, covering <strong>${kidsEq.toLocaleString()} children</strong>, or ${Math.round((100 * kidsEq) / allKids)}% of every child in London.</p>

<p>The standard is being met by open grass rather than by anything built for children to play on. That is the finding, and it is visible only because the measurement is done ward by ward and split by what the space actually is.</p>

<h2>How we are using the standard, and where that is a stretch</h2>

<p>Policy S4 B.2 sets 10 m² per child as what <em>new</em> development must provide, assessed through the GLA's Population Yield Calculator when a scheme comes forward. It was not drafted as an audit standard for existing neighbourhoods, and applying it to 704 existing wards goes past its purpose. We do it anyway, because it is the only quantified play-space figure London's own planning system commits to, and a yardstick everyone can check beats a yardstick we invented. We would rather use it openly and say what we are doing than quietly pick a number nobody can argue with.</p>

<p>Read every figure below as: this is what the Plan would require if the ward were being built today, against what the ward actually has.</p>

<h2>By borough</h2>
<table><thead><tr><th>Borough</th><th class="n">Wards short</th><th class="n">Share</th><th class="n">Children</th><th class="n">Median m²/child</th></tr></thead><tbody>${borRows}</tbody></table>

<p>${byBor[0].pct}% of wards in <a href="/areas/${byBor[0].b.slug}/">${esc(byBor[0].b.name)}</a> provide less than the Plan would require of new development, the highest share in London, followed by ${list(byBor.slice(1, 4).map((r) => `<a href="/areas/${r.b.slug}/">${esc(r.b.name)}</a> at ${r.pct}%`))}.${clean.length ? ` ${list(clean.map((b) => `<a href="/areas/${b.slug}/">${esc(b.name)}</a>`))} have no ward below the figure at all.` : ""}</p>

<h2>The fifteen tightest wards</h2>
<p>Wards with more than 500 children aged 0-15, ranked by play and informal recreation space per child:</p>
<table><thead><tr><th>Ward</th><th>Borough</th><th class="n">m² per child</th><th class="n">Children</th></tr></thead><tbody>${worstRows}</tbody></table>

<h2>What this measure does and does not do</h2>

<p>Space is counted only where it falls inside the ward boundary. Polygons are clipped rather than assigned whole to the ward containing their centre, so a large park splits across the wards it physically covers instead of being credited entirely to one. A park fifty metres over the boundary still counts for nothing, which understates provision for families who would simply walk to it. Measuring what a family can reach on foot, rather than what sits inside a line on a map, is the next version of this.</p>

<p>The equipped-playground figure counts sites tagged as playgrounds. Informal space children genuinely use, a quiet green, a wide verge, a school field open at weekends, is in the all-space figure and not the equipped one. The truth sits between the two, which is why both are published rather than one.</p>

<h2>Check the numbers</h2>
<p>Every ward's figures are on <a href="/areas/">its own page</a>, and the full table is downloadable: <a href="/data/play-space-by-ward.csv">play-space-by-ward.csv</a>. Sources are OS Open Greenspace under the Open Government Licence, clipped to ONS WD24 ward boundaries, with ONS mid-2024 ward child population estimates. If you find an error, it is worth telling us about.</p>

<p style="margin-top:28px"><a class="cta" href="/areas/">See all ${N} wards ranked for families</a></p>`;

  write("guides/london-playground-gap", page({
    title: `London's playground gap: ${belowEq.length} of ${hasEq.length} wards below the play space figure | KidStreet`,
    desc: `London meets its 10 m² per child play space figure on open grass. Counting equipped playgrounds only, ${belowEq.length} of ${hasEq.length} wards fall short, covering ${kidsEq.toLocaleString()} children. Ward-level data, downloadable.`,
    canonical: "/guides/london-playground-gap/",
    jsonld: [
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "London", item: `${SITE}/areas/` },
          {
            "@type": "ListItem",
            position: 2,
            name: "London's playground gap",
            item: `${SITE}/guides/london-playground-gap/`,
          },
        ],
      },
      {
        "@context": "https://schema.org",
        "@type": "Dataset",
        name: "London play space per child by ward",
        description: `Play and informal recreation space, and equipped playground space, per child aged 0-15 for ${scoredP.length} London wards, measured by clipping OS Open Greenspace polygons to ONS WD24 ward boundaries.`,
        url: `${SITE}/guides/london-playground-gap/`,
        distribution: [
          {
            "@type": "DataDownload",
            encodingFormat: "text/csv",
            contentUrl: `${SITE}/data/play-space-by-ward.csv`,
          },
        ],
        license: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
        creator: { "@type": "Organization", name: "KidStreet" },
        spatialCoverage: { "@type": "Place", name: "Greater London" },
      },
    ],
    breadcrumb: `<a href="/">KidStreet</a> › <a href="/areas/">London</a> › London's playground gap`,
    body,
  }));

  // CSV so anyone can check the work without scraping 704 pages
  const csvEsc = (v) =>
    /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const csv = [
    [
      "ward_name", "borough", "ward_code", "children_0_15", "play_area_m2",
      "m2_per_child", "equipped_play_area_m2", "equipped_m2_per_child",
      "play_site_count", "below_10_all_space", "below_10_equipped_only",
      "play_score", "overall_score", "london_rank",
    ].join(","),
    ...scoredP.map((w) => {
      const p = w.dimensions.play_provision;
      return [
        w.ward_name, w.borough, w.ward_code, p.children_0_15 ?? "",
        Math.round(p.play_area_m2 ?? 0), p.m2_per_child,
        Math.round(p.equipped_play_area_m2 ?? 0),
        p.equipped_m2_per_child ?? "", p.play_site_count ?? "",
        p.m2_per_child < BENCH ? "yes" : "no",
        typeof p.equipped_m2_per_child === "number"
          ? p.equipped_m2_per_child < BENCH ? "yes" : "no"
          : "",
        w.scores.play ?? "", w.composite, w.rank,
      ].map(csvEsc).join(",");
    }),
  ].join("\n");
  const csvPath = path.join(ROOT, "public", "data", "play-space-by-ward.csv");
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  fs.writeFileSync(csvPath, csv);
}

// sitemap + robots
const today = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE}/</loc><lastmod>${today}</lastmod><priority>1.0</priority></url>
${urls
  .map(
    (u) =>
      `<url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod><priority>${u.split("/").length > 4 ? "0.6" : "0.8"}</priority></url>`,
  )
  .join("\n")}
</urlset>`;
fs.writeFileSync(path.join(ROOT, "public", "sitemap.xml"), sitemap);
fs.writeFileSync(
  path.join(ROOT, "public", "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`,
);

console.log(
  `Wrote ${urls.length} pages (${ranked.length} wards, ${boroughList.length} boroughs, 1 hub), sitemap.xml and robots.txt.`,
);
