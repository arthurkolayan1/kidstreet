export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
