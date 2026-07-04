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
        // Read the pipeline's file from the assets bundle (public/data/wards.json).
        const fileReq = new Request(new URL('/data/wards.json', request.url));
        const fileRes = await env.ASSETS.fetch(fileReq);
        if (!fileRes.ok) {
          return new Response(JSON.stringify({ error: 'wards.json not found (expected at public/data/wards.json)' }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
          });
        }
        const raw = await fileRes.json();
        const wards = Array.isArray(raw.wards) ? raw.wards : [];

        const scores = wards.map(w => {
          const s = w.scores || {};
          const safety = Number(s.safety) || 0;
          const green = Number(s.green_space) || 0;
          const narrative = Number(s.liveability) || 0; // proxy until live LLM scoring lands
          const composite = Math.round(0.4 * safety + 0.3 * green + 0.3 * narrative);
          return {
            ward: w.ward_name,
            borough: w.borough,
            safety,
            green,
            narrative,
            composite,
            justification: 'Narrative uses liveability as an interim proxy; live LLM scoring to follow.'
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
