export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/narrative' && request.method === 'POST') {
      try {
        const body = await request.json();
        const text = (body.text || '').slice(0, 2000);
        if (!text.trim()) {
          return new Response(JSON.stringify({ error: 'No text provided' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
          });
        }
        if (!env.OPENROUTER_API_KEY) {
          return new Response(JSON.stringify({ error: 'API key not configured' }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
          });
        }
        const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.OPENROUTER_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'anthropic/claude-haiku-4.5',
            max_tokens: 200,
            messages: [
              {
                role: 'system',
                content: 'You score council and official documents for how honestly they describe child-friendliness of an area. Score 0-100 where 100 means claims are specific, evidenced and credible, and 0 means pure unsubstantiated PR. Give a single-sentence justification of max 20 words.'
              },
              { role: 'user', content: text }
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'narrative_score',
                strict: true,
                schema: {
                  type: 'object',
                  properties: {
                    score: { type: 'integer' },
                    justification: { type: 'string' }
                  },
                  required: ['score', 'justification'],
                  additionalProperties: false
                }
              }
            }
          })
        });
        if (!orRes.ok) {
          return new Response(JSON.stringify({ error: 'Scoring service error ' + orRes.status }), {
            status: 502, headers: { 'Content-Type': 'application/json' }
          });
        }
        const data = await orRes.json();
        const content = data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content : '';
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Could not parse model output' }), {
            status: 502, headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify(parsed), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Request failed' }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname === '/api/scores') {
      try {
        const fileRes = await env.ASSETS.fetch(new Request(new URL('/data/wards.json', request.url)));
        if (!fileRes.ok) {
          return new Response(JSON.stringify({ error: 'wards.json not found at public/data/wards.json' }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
          });
        }
        const raw = await fileRes.json();
        const wards = Array.isArray(raw.wards) ? raw.wards : [];

        // Published weights. Nulls renormalise: missing data never counts as zero.
        const WEIGHTS = { safety: 0.30, green: 0.20, education: 0.20, transport: 0.15, family: 0.10, planning: 0.05 };

        const scores = wards.map(w => {
          const s = w.scores || {};
          const d = w.dimensions || {};
          const vals = {
            safety: s.safety, green: s.green_space, transport: s.transport,
            education: s.education, planning: s.planning, family: s.family_fit
          };

          let wsum = 0, total = 0;
          for (const k of Object.keys(WEIGHTS)) {
            if (vals[k] !== null && vals[k] !== undefined) {
              wsum += WEIGHTS[k];
              total += WEIGHTS[k] * vals[k];
            }
          }
          const composite = wsum > 0 ? Math.round(total / wsum) : null;

          // Justification built from real evidence in the file.
          const parts = [];
          if (d.safety && d.safety.crimes_last_month !== null && d.safety.crimes_last_month !== undefined) {
            parts.push(d.safety.crimes_last_month + ' crimes last month');
          }
          if (d.green_space) {
            const g = d.green_space;
            if (g.named_green_space_count) {
              let t = g.named_green_space_count + ' green spaces';
              if (g.playground_count) t += ', ' + g.playground_count + ' playgrounds';
              if (g.notable_parks && g.notable_parks.length) t += ' incl. ' + g.notable_parks[0];
              parts.push(t);
            }
          }
          if (d.education && d.education.pct_good_or_outstanding !== null && d.education.pct_good_or_outstanding !== undefined) {
            parts.push(Math.round(d.education.pct_good_or_outstanding) + '% of ' + d.education.school_count + ' schools Good/Outstanding');
          }
          if (d.planning && d.planning.upcoming_facility_count) {
            parts.push(d.planning.upcoming_facility_count + ' child facilities in planning');
          }
          const justification = parts.length
            ? parts.slice(0, 3).join('; ') + '.'
            : 'Sourced data; several metrics unavailable for this ward.';

          return {
            ward: w.ward_name,
            borough: w.borough,
            ward_code: w.ward_code || null,
            safety: vals.safety, green: vals.green, transport: vals.transport,
            education: vals.education, planning: vals.planning, family: vals.family,
            composite, justification
          };
        });

        return new Response(JSON.stringify(scores), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Failed to read or parse wards.json: ' + e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
