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
    // placeholder). Cites a named park/school when one is available so the sentence is concrete
    // rather than boilerplate, and stays consistent with the numeric bars shown alongside it.
    function templatedJustification(w, safety, green, narrative) {
      const dims = w.dimensions || {};
      const park = dims.green_space?.notable_parks?.[0];
      const outstandingSchool = dims.education?.schools?.find(
        (s) => s.ofsted === "Outstanding",
      )?.name;
      const facilityCount = dims.planning?.upcoming_facility_count;

      const parts = [];
      parts.push(
        scoreWord(safety) +
          " safety" +
          (dims.safety?.crimes_last_month != null
            ? " (" + dims.safety.crimes_last_month + " crimes/mo)"
            : ""),
      );
      parts.push(
        scoreWord(green) + " green space" + (park ? " near " + park : ""),
      );
      parts.push(
        scoreWord(narrative) +
          " family fit" +
          (outstandingSchool
            ? ", incl. " + outstandingSchool
            : facilityCount
              ? ", " + facilityCount + " child-facility approvals since 2023"
              : ""),
      );
      return parts.join("; ") + ".";
    }

    if (url.pathname === "/api/scores") {
      try {
        const wards = await loadWards();

        // Flat contract kept unchanged for the existing map/table/voice-agent code in
        // public/index.html: {ward, borough, safety, green, narrative, composite, justification}.
        // `narrative` and `composite` are approximated from the richer pipeline dimensions until
        // the live OpenRouter narrative pass (see /api/narrative) is run per-ward:
        //   narrative proxy = average of education, planning and family_fit scores (the three
        //   "is this place investing in and suited to families" signals we have real data for).
        // `lat`/`lng` (ward centroid) are included so the frontend can filter/rank recommendations
        // by distance from a user-supplied location instead of only by score.
        const scores = wards.map((w) => {
          const s = w.scores || {};
          const safety = Number(s.safety) || 0;
          const green = Number(s.green_space) || 0;
          const narrativeParts = [s.education, s.planning, s.family_fit].filter(
            (v) => v != null,
          );
          const narrative = narrativeParts.length
            ? Math.round(
                narrativeParts.reduce((a, b) => a + b, 0) /
                  narrativeParts.length,
              )
            : 0;
          const composite = Math.round(
            0.4 * safety + 0.3 * green + 0.3 * narrative,
          );
          return {
            ward: w.ward_name,
            borough: w.borough,
            lat: w.centroid?.lat ?? null,
            lng: w.centroid?.lng ?? null,
            safety,
            green,
            narrative,
            composite,
            justification: templatedJustification(w, safety, green, narrative),
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
    // (named schools, stations, parks, planning applications) alongside its score. Optional
    // ?borough= filter. Optional /api/wards/<ward name> for a single ward.
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
