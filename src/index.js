export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/narrative" && request.method === "POST") {
      try {
        const body = await request.json();
        const text = (body.text || "").slice(0, 2000);
        if (!text.trim()) {
          return new Response(JSON.stringify({ error: "No text provided" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (!env.OPENROUTER_API_KEY) {
          return new Response(
            JSON.stringify({ error: "API key not configured" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const orRes = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + env.OPENROUTER_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "anthropic/claude-haiku-4.5",
              max_tokens: 200,
              messages: [
                {
                  role: "system",
                  content:
                    "You score council and official documents for how honestly they describe child-friendliness of an area. Score 0-100 where 100 means claims are specific, evidenced and credible, and 0 means pure unsubstantiated PR. Give a single-sentence justification of max 20 words.",
                },
                { role: "user", content: text },
              ],
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "narrative_score",
                  strict: true,
                  schema: {
                    type: "object",
                    properties: {
                      score: { type: "integer" },
                      justification: { type: "string" },
                    },
                    required: ["score", "justification"],
                    additionalProperties: false,
                  },
                },
              },
            }),
          },
        );
        if (!orRes.ok) {
          return new Response(
            JSON.stringify({ error: "Scoring service error " + orRes.status }),
            {
              status: 502,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const data = await orRes.json();
        const content =
          data.choices && data.choices[0] && data.choices[0].message
            ? data.choices[0].message.content
            : "";
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          return new Response(
            JSON.stringify({ error: "Could not parse model output" }),
            {
              status: 502,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify(parsed), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Request failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Both /api/scores and /api/wards read the same pipeline output file. Loaded once per
    // request and reused so we don't fetch the asset twice when a client hits /api/scores then
    // /api/wards in quick succession — not that it matters much at this size, but no reason to
    // do it twice in the same handler.
    async function loadWards() {
      const fileReq = new Request(new URL("/data/wards.json", request.url));
      const fileRes = await env.ASSETS.fetch(fileReq);
      if (!fileRes.ok) {
        throw new Error(
          "wards.json not found (expected at public/data/wards.json)",
        );
      }
      const raw = await fileRes.json();
      return Array.isArray(raw.wards) ? raw.wards : [];
    }

    // Published composite weights. Must stay in sync with the methodology strip in
    // public/index.html — if you change one, change the other in the same commit.
    // Play (8) was split out of the former Green weight (20 -> 12 + 8): both measure
    // physical space, but play provision is benchmarked against London Plan Policy S4
    // (10 sqm playable space per child) rather than generic access to green space.
    const WEIGHTS = {
      safety: 30,
      education: 20,
      transport: 15,
      green_space: 12,
      family_fit: 10,
      play: 8,
      planning: 5,
    };

    // A dimension with a null/absent score is excluded and the remaining weights are
    // renormalised, so missing data never silently counts as zero. (Currently this
    // applies to the 15 City of London wards, where ONS publishes no ward-level child
    // population, so play is null.)
    function compositeOf(s) {
      let num = 0;
      let den = 0;
      for (const [dim, weight] of Object.entries(WEIGHTS)) {
        const v = s[dim];
        if (typeof v === "number" && isFinite(v)) {
          num += weight * v;
          den += weight;
        }
      }
      return den > 0 ? Math.round(num / den) : 0;
    }

    // Same score bands the UI uses for its map/table colouring (see scoreColour() in
    // public/index.html) so the templated sentence below never contradicts the colour a ward
    // is painted. Keep these two in sync if the bands change.
    function scoreWord(v) {
      if (v >= 75) return "excellent";
      if (v >= 65) return "good";
      if (v >= 55) return "fair";
      if (v >= 45) return "below-average";
      return "poor";
    }

    // Builds a real, per-ward sentence from the pipeline's own facts (no LLM call, no generic
    // placeholder). Every phrase quotes the SAME per-dimension score shown in the detail-panel
    // bars (a phrase's adjective comes from that dimension's own score, never a blend), so the
    // sentence can never contradict the numbers beside it. Dimensions with no data are simply
    // omitted. Cites a named park/school when one is available so the sentence is concrete
    // rather than boilerplate.
    function templatedJustification(w) {
      const s = w.scores || {};
      const dims = w.dimensions || {};
      const park = dims.green_space?.notable_parks?.[0];
      const outstandingSchool = dims.education?.schools?.find(
        (x) => x.ofsted === "Outstanding",
      )?.name;
      const facilityCount = dims.planning?.upcoming_facility_count;
      const isNum = (v) => typeof v === "number" && isFinite(v);

      const parts = [];
      if (isNum(s.safety)) {
        parts.push(
          scoreWord(s.safety) +
            " safety" +
            (dims.safety?.crimes_last_month != null
              ? " (" + dims.safety.crimes_last_month + " crimes/mo)"
              : ""),
        );
      }
      if (isNum(s.green_space)) {
        parts.push(
          scoreWord(s.green_space) +
            " green space" +
            (park ? " near " + park : ""),
        );
      }
      if (isNum(s.education)) {
        parts.push(
          scoreWord(s.education) +
            " schools" +
            (outstandingSchool ? ", incl. " + outstandingSchool : ""),
        );
      }
      if (isNum(s.family_fit)) {
        const pctKids =
          dims.family_fit?.pct_households_with_dependent_children;
        parts.push(
          pctKids != null
            ? pctKids + "% of households have children"
            : scoreWord(s.family_fit) + " family presence",
        );
      }
      if (isNum(s.planning) && facilityCount) {
        parts.push(
          facilityCount +
            " child-facility approval" +
            (facilityCount === 1 ? "" : "s") +
            " since 2023",
        );
      }
      if (!parts.length) return "Insufficient data for a summary.";
      return parts.join("; ") + ".";
    }

    if (url.pathname === "/api/scores") {
      try {
        const wards = await loadWards();

        // Flat contract for the map/table/voice-agent code in public/index.html. All
        // pre-play fields ({ward, borough, safety, green, narrative, composite,
        // justification, lat, lng}) are kept so nothing downstream breaks; play fields
        // are additive:
        //   play           0-100, capped benchmark score (null where no child population)
        //   playM2PerChild raw sqm of playable space per child aged 0-15
        //   playRatio      playM2PerChild / 10 (London Plan Policy S4 benchmark);
        //                  < 1 is a deficit, >= 1 meets the benchmark
        //   playAreaM2 / playChildren  the two raw inputs, for full transparency
        // `narrative` remains the average of education, planning and family_fit (the
        // three "is this place investing in and suited to families" signals), kept for
        // the voice agent tools and the day-out lens. `composite` is now the published
        // seven-dimension weighted blend (see WEIGHTS above), null-aware.
        const scores = wards.map((w) => {
          const s = w.scores || {};
          const num = (v) =>
            typeof v === "number" && isFinite(v) ? v : null;
          const safety = num(s.safety);
          const green = num(s.green_space);
          const narrativeParts = [s.education, s.planning, s.family_fit].filter(
            (v) => v != null,
          );
          const narrative = narrativeParts.length
            ? Math.round(
                narrativeParts.reduce((a, b) => a + b, 0) /
                  narrativeParts.length,
              )
            : null;
          const play = w.dimensions?.play_provision || {};
          return {
            ward: w.ward_name,
            code: w.ward_code,
            borough: w.borough,
            lat: w.centroid?.lat ?? null,
            lng: w.centroid?.lng ?? null,
            safety,
            green,
            transport: s.transport ?? null,
            education: s.education ?? null,
            planning: s.planning ?? null,
            family: s.family_fit ?? null,
            play: s.play ?? null,
            playAreaM2: play.play_area_m2 ?? null,
            playChildren: play.children_0_15 ?? null,
            playM2PerChild: play.m2_per_child ?? null,
            playRatio: play.ratio_vs_benchmark ?? null,
            narrative,
            composite: compositeOf(s),
            justification: templatedJustification(w),
          };
        });

        return new Response(JSON.stringify(scores), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({
            error: "Failed to read or parse wards.json: " + e.message,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // Richer per-ward detail for the voice agent and detail panel: every dimension's raw facts
    // (named schools, stations, parks, planning applications, play provision) alongside its
    // score. Optional ?borough= filter. Optional /api/wards/<ward name> for a single ward.
    if (
      url.pathname === "/api/wards" ||
      url.pathname.startsWith("/api/wards/")
    ) {
      try {
        const wards = await loadWards();
        const wardParam = url.pathname.startsWith("/api/wards/")
          ? decodeURIComponent(url.pathname.slice("/api/wards/".length))
          : null;
        const boroughParam = url.searchParams.get("borough");

        const norm = (s) =>
          (s || "")
            .toLowerCase()
            .replace(/&/g, "and")
            .replace(/[,.']/g, "")
            .replace(/\s+/g, " ")
            .trim();

        let filtered = wards;
        if (wardParam) {
          filtered = filtered.filter(
            (w) => norm(w.ward_name) === norm(wardParam),
          );
          if (!filtered.length) {
            return new Response(
              JSON.stringify({ error: "Ward not found: " + wardParam }),
              {
                status: 404,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }
        if (boroughParam) {
          filtered = filtered.filter(
            (w) => norm(w.borough) === norm(boroughParam),
          );
        }

        const body = wardParam ? filtered[0] : filtered;
        return new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({
            error: "Failed to read or parse wards.json: " + e.message,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};
