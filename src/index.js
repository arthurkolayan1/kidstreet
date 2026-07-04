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
      const J = 'Placeholder — live pipeline output lands this afternoon.';
      const scores = [
        { ward: 'Abbey Wood', safety: 61, green: 52, narrative: 56, composite: 57, justification: J },
        { ward: 'Blackheath Westcombe', safety: 84, green: 95, narrative: 90, composite: 89, justification: J },
        { ward: 'Charlton Hornfair', safety: 66, green: 68, narrative: 67, composite: 67, justification: J },
        { ward: 'Charlton Village and Riverside', safety: 73, green: 74, narrative: 75, composite: 74, justification: J },
        { ward: 'East Greenwich', safety: 70, green: 58, narrative: 74, composite: 68, justification: J },
        { ward: 'Eltham Page', safety: 68, green: 71, narrative: 69, composite: 69, justification: J },
        { ward: 'Eltham Park and Progress', safety: 75, green: 76, narrative: 72, composite: 74, justification: J },
        { ward: 'Eltham Town and Avery Hill', safety: 72, green: 78, narrative: 73, composite: 74, justification: J },
        { ward: 'Greenwich Creekside', safety: 71, green: 55, narrative: 76, composite: 68, justification: J },
        { ward: 'Greenwich Park', safety: 80, green: 98, narrative: 92, composite: 89, justification: J },
        { ward: 'Greenwich Peninsula', safety: 74, green: 45, narrative: 64, composite: 62, justification: J },
        { ward: 'Kidbrooke Park', safety: 70, green: 82, narrative: 71, composite: 74, justification: J },
        { ward: 'Kidbrooke Village and Sutcliffe', safety: 73, green: 79, narrative: 70, composite: 74, justification: J },
        { ward: 'Middle Park and Horn Park', safety: 64, green: 73, narrative: 65, composite: 67, justification: J },
        { ward: 'Mottingham, Coldharbour and New Eltham', safety: 67, green: 69, narrative: 66, composite: 67, justification: J },
        { ward: 'Plumstead and Glyndon', safety: 58, green: 54, narrative: 57, composite: 57, justification: J },
        { ward: 'Plumstead Common', safety: 60, green: 61, narrative: 59, composite: 60, justification: J },
        { ward: 'Shooters Hill', safety: 78, green: 86, narrative: 77, composite: 80, justification: J },
        { ward: 'Thamesmead Moorings', safety: 54, green: 48, narrative: 50, composite: 51, justification: J },
        { ward: 'West Thamesmead', safety: 56, green: 50, narrative: 52, composite: 53, justification: J },
        { ward: 'Woolwich Arsenal', safety: 55, green: 42, narrative: 62, composite: 53, justification: J },
        { ward: 'Woolwich Common', safety: 62, green: 57, narrative: 63, composite: 61, justification: J },
        { ward: 'Woolwich Dockyard', safety: 57, green: 46, narrative: 58, composite: 54, justification: J }
      ];
      return new Response(JSON.stringify(scores), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return env.ASSETS.fetch(request);
  }
};
