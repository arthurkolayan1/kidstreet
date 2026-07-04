export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/scores') {
      const scores = [
        {
          id: 'GRN-001',
          ward: 'Greenwich Park',
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [-0.0090, 51.4820],
              [0.0060, 51.4820],
              [0.0060, 51.4720],
              [-0.0090, 51.4720],
              [-0.0090, 51.4820]
            ]]
          },
          centroid: [51.4769, -0.0005],
          safety: 72,
          green: 85,
          narrative: 64,
          composite: 73,
          justification: 'Low recorded crime, excellent green access, council narrative broadly matches reality.'
        },
        {
          id: 'GRN-002',
          ward: 'Woolwich Riverside',
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [0.0560, 51.4950],
              [0.0740, 51.4950],
              [0.0740, 51.4850],
              [0.0560, 51.4850],
              [0.0560, 51.4950]
            ]]
          },
          centroid: [51.4900, 0.0648],
          safety: 55,
          green: 48,
          narrative: 60,
          composite: 55,
          justification: 'Higher crime density near town centre, limited green space within walking distance.'
        },
        {
          id: 'GRN-003',
          ward: 'Blackheath Westcombe',
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [0.0010, 51.4710],
              [0.0170, 51.4710],
              [0.0170, 51.4610],
              [0.0010, 51.4610],
              [0.0010, 51.4710]
            ]]
          },
          centroid: [51.4660, 0.0090],
          safety: 78,
          green: 80,
          narrative: 68,
          composite: 76,
          justification: 'Open heath access, low recorded crime, council claims mostly supported by data.'
        }
      ];
      return new Response(JSON.stringify(scores), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return env.ASSETS.fetch(request);
  }
};
